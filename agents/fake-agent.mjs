#!/usr/bin/env node
// Scripted ACP agent for demos and harness tests: no model, no quota.
// FAKE_SCRIPT points to a module whose default export maps a turn key to a list of turns:
//   "planner", "qa", "reviewer", "single", or "dev:<module>" (indexed by attempt).
// Each turn writes files directly (as real agents do with their own tools), reports
// tool calls, a message and usage, so the dashboard and guards see realistic traffic.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';

const script = (await import(pathToFileURL(process.env.FAKE_SCRIPT))).default;
const delayMs = Number(process.env.FAKE_DELAY_MS ?? script.delayMs ?? 500);
const delay = ms => new Promise(r => setTimeout(r, ms));

class FakeAgent {
  constructor(conn) { this.conn = conn; this.calls = new Map(); this.cost = 0; }
  async initialize() { return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }; }
  async newSession(params) { this.cwd = params.cwd; return { sessionId: 'fake-' + process.pid }; }
  async authenticate() { return {}; }
  async cancel() {}

  async prompt(params) {
    const sessionId = params.sessionId;
    const text = params.prompt.map(p => p.text ?? '').join('\n');
    const h = text.match(/\[devcrew role=(\S+) module=(\S+) attempt=(\d+)\]/);
    const role = h?.[1] ?? 'single';
    const key = role === 'dev' ? `dev:${h[2]}` : role;
    const n = this.calls.get(key) ?? 0;
    this.calls.set(key, n + 1);
    const turns = script.turns[key] ?? [];
    const index = role === 'dev' ? Number(h[3]) - 1 : n;
    const turn = turns[Math.min(index, turns.length - 1)];
    const send = update => this.conn.sessionUpdate({ sessionId, update });

    if (!turn) {
      await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `No scripted turn for ${key}.` } });
      return { stopReason: 'end_turn' };
    }
    await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: turn.thinking ?? 'Reading the workspace…\n\n' } });
    await delay(delayMs);
    let i = 0;
    for (const [rel, content] of Object.entries(turn.files ?? {})) {
      const id = `t${n}-${i++}`;
      await send({ sessionUpdate: 'tool_call', toolCallId: id, title: `Write ${rel}`, kind: 'edit', status: 'in_progress' });
      await delay(delayMs / 2);
      const full = path.join(this.cwd, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, rel === '.devcrew/plan.json' ? withCoverage(content, text, turn.files, this.cwd) : content);
      await send({ sessionUpdate: 'tool_call_update', toolCallId: id, title: `Write ${rel}`, status: 'completed' });
    }
    for (const title of turn.commands ?? []) {
      const id = `c${n}-${i++}`;
      await send({ sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'execute', status: 'in_progress' });
      await delay(delayMs);
      await send({ sessionUpdate: 'tool_call_update', toolCallId: id, title, status: 'completed' });
    }
    const tokens = turn.tokens ?? { input: 20000, output: 3000 };
    this.cost += (tokens.input * 3 + tokens.output * 15) / 1e6;
    await send({ sessionUpdate: 'usage_update', used: tokens.input + tokens.output, size: 200000, cost: { amount: this.cost, currency: 'USD' } });
    await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: turn.message ?? 'Done.' } });
    return {
      stopReason: 'end_turn',
      usage: { inputTokens: tokens.input, outputTokens: tokens.output, totalTokens: tokens.input + tokens.output, cachedReadTokens: tokens.cached ?? 0 },
    };
  }
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection(conn => new FakeAgent(conn), stream);

/** Scripted plans predate requirement coverage: map every clause the prompt lists to the PRD's first criterion. */
function withCoverage(content, prompt, files, cwd) {
  const plan = JSON.parse(content);
  const ids = [...new Set(prompt.match(/^\s*R-\d+(?=:)/gm)?.map(s => s.trim()) ?? [])];
  const prdPath = path.join(cwd, '.devcrew/PRD.md');
  const prd = files['.devcrew/PRD.md'] ?? (fs.existsSync(prdPath) ? fs.readFileSync(prdPath, 'utf8') : '');
  const ac = prd.match(/\bAC-\d+\b/)?.[0];
  if (!plan.coverage && ids.length && ac) { plan.coverage = Object.fromEntries(ids.map(id => [id, [ac]])); }
  return JSON.stringify(plan, null, 2);
}
