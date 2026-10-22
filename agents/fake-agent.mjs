#!/usr/bin/env node
// Scripted ACP agent for demos and harness tests: no model, no quota.
// FAKE_SCRIPT points to a module whose default export maps a turn key to a list of turns:
//   "qa", "dev:main", "architect", "reviewer", "single", or any agent step id, each turn in order.
// Each turn writes files directly (as real agents do with their own tools), reports
// tool calls, a message and usage, so the dashboard and guards see realistic traffic.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';

const script = (await import(pathToFileURL(process.env.FAKE_SCRIPT))).default;
const delayMs = Number(process.env.FAKE_DELAY_MS ?? script.delayMs ?? 500);
const delay = ms => new Promise(r => setTimeout(r, ms));

class FakeAgent {
  constructor(conn) { this.conn = conn; this.cost = 0; }
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
    // Counted per run, not per process (DevCrew may give a role a fresh session mid-run) and not per
    // folder (QA's first turn works in the run's qa-workspace copy, its later ones in the workspace)
    const run = path.basename(this.cwd) === 'qa-workspace' ? path.basename(path.dirname(this.cwd)) : path.basename(this.cwd);
    // One file per role, since QA and the Builder take turns at the same time
    const countFileOf = k => path.join(os.tmpdir(), `devcrew-fake-calls-${createHash('sha1').update(`${run}:${k}`).digest('hex').slice(0, 12)}`);
    const countFile = countFileOf(key);
    let n = 0;
    try { n = Number(fs.readFileSync(countFile, 'utf8')) || 0; } catch { /* first turn of this role in this run */ }
    fs.writeFileSync(countFile, String(n + 1));
    const turns = script.turns[key] ?? [];
    const turn = turns[Math.min(n, turns.length - 1)];
    const send = update => this.conn.sessionUpdate({ sessionId, update });

    if (!turn) {
      await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `No scripted turn for ${key}.` } });
      return { stopReason: 'end_turn' };
    }
    // Turns that run at the same time (QA and the Builder) wait until the other has its prompt, so a
    // fast turn never ends before a slow process has even started (seen under a loaded test run)
    for (const deadline = Date.now() + 15_000; turn.awaits && !fs.existsSync(countFileOf(turn.awaits)) && Date.now() < deadline;) { await delay(20); }
    // Harness tests: a tool left running in the background, or the agent CLI dying mid-turn
    if (turn.background) { spawn('sh', ['-c', turn.background], { stdio: 'ignore' }); }
    if (turn.crash) { process.exit(1); }
    await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: turn.thinking ?? 'Reading the workspace…' } });
    await delay(delayMs);
    let i = 0;
    for (const [rel, content] of Object.entries(turn.files ?? {})) {
      const id = `t${n}-${i++}`;
      await send({ sessionUpdate: 'tool_call', toolCallId: id, title: `Write ${rel}`, kind: 'edit', status: 'in_progress' });
      await delay(delayMs / 2);
      const full = path.join(this.cwd, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
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
