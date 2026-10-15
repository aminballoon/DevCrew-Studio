// Arms that run someone else's workflow on its own: plain Claude Code, BMAD's unattended build,
// Claude Code agent teams. DevCrew only prepares the same workspace and prompt the single arm gets,
// then grades the result with the same hidden tests; no DevCrew role, guard or Verify takes part.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { runDir, STUDIO_ROOT } from '../../src/core/config';
import { prepareWorkspace } from '../../src/guard/workspace';
import { singlePrompt } from '../../src/orchestrator/prompts';
import { getBus } from '../../src/orchestrator/runtime';

export interface ExternalArm {
  id: string; mode: 'external'; profile: string;
  workflow: 'claude-cli' | 'bmad' | 'agent-teams';
  model: string;
}

const BMAD_VERSION = '6.12.4';
const TEAM_PROMPT = 'Work as an agent team: spawn 3 teammates with separate responsibilities (you choose them, and no two edit the same file), coordinate them through the shared task list, wait for all of them to finish, then check that the whole test suite passes before you finish.';

/** Price per million tokens of Claude Haiku 5.5, read off a `claude -p` result (input 0.1, output 0.5). */
const PRICE = { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01 };

/** Environment for the outside tool: the same proxy as the single arm, none of this host session's wiring. */
function toolEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787', ...extra };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'FORCE_COLOR', 'NODE_TEST_CONTEXT']) { delete env[k]; }
  return env;
}

/** Where Claude Code keeps the transcripts of sessions started in this folder. */
const transcriptsOf = (workspace: string) => join(homedir(), '.claude', 'projects', realpathSync(workspace).replace(/[^a-zA-Z0-9]/g, '-'));

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) { return []; }
  return readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? filesUnder(join(dir, d.name)) : d.name.endsWith('.jsonl') ? [join(dir, d.name)] : []));
}

/** Token use of every session the workflow started (lead, subagents, teammates), one entry per model call. */
function usageFromTranscripts(dir: string) {
  const files = filesUnder(dir);
  // The lead is the session with the most calls in the folder itself; other top-level sessions are teammates
  const top = files.filter(f => !f.slice(dir.length + 1).includes('/'));
  const seen = new Set<string>();
  const byRole: Record<string, { calls: number; input: number; output: number; read: number; write: number; cost: number; total: number }> = {};
  const models = new Set<string>();
  const callsIn = new Map<string, number>();
  const entries: { file: string; usage: Record<string, any>; model: string }[] = [];
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"usage"')) { continue; }
      let e: any;
      try { e = JSON.parse(line); } catch { continue; }
      const m = e.message;
      if (e.type !== 'assistant' || !m?.usage) { continue; }
      const key = `${m.id}:${e.requestId ?? ''}`;
      if (seen.has(key)) { continue; }
      seen.add(key);
      entries.push({ file, usage: m.usage, model: m.model });
      callsIn.set(file, (callsIn.get(file) ?? 0) + 1);
    }
  }
  const lead = top.sort((a, b) => (callsIn.get(b) ?? 0) - (callsIn.get(a) ?? 0))[0];
  for (const { file, usage: u, model } of entries) {
    if (model && model !== '<synthetic>') { models.add(model); }
    const role = file === lead ? 'lead' : top.includes(file) ? 'teammate' : 'subagent';
    const r = (byRole[role] ??= { calls: 0, input: 0, output: 0, read: 0, write: 0, cost: 0, total: 0 });
    const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const write = u.cache_creation_input_tokens ?? 0;
    r.calls++; r.input += u.input_tokens ?? 0; r.output += u.output_tokens ?? 0; r.read += u.cache_read_input_tokens ?? 0; r.write += write;
    r.total += (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + write;
    r.cost += ((u.input_tokens ?? 0) * PRICE.input + (u.output_tokens ?? 0) * PRICE.output + (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead + w1h * PRICE.cacheWrite1h + (write - w1h) * PRICE.cacheWrite5m) / 1e6;
  }
  return { byRole, models: [...models], sessions: files.length };
}

function settle(child: ReturnType<typeof spawn>, limitMs: number, log: string): Promise<{ code: number | null; timedOut: boolean; stdout: string }> {
  return new Promise(resolve => {
    let stdout = '';
    let timedOut = false;
    child.stdout?.on('data', d => { stdout += d; });
    child.stderr?.on('data', d => { writeFileSync(log, d, { flag: 'a' }); });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } }, limitMs);
    child.on('close', code => { clearTimeout(timer); resolve({ code, timedOut, stdout }); });
  });
}

export async function runExternal(arm: ExternalArm, opts: { requirement: string; seed: string; runId: string; label: string; timeLimitMs: number }): Promise<string> {
  const bus = getBus();
  const ws = prepareWorkspace(opts.seed, opts.runId);
  const dir = runDir(opts.runId);
  mkdirSync(dir, { recursive: true });
  bus.emit(opts.runId, { type: 'run_started', requirement: opts.requirement, workspace: ws.path, mode: 'single', profile: `external:${arm.workflow}`, label: opts.label });
  const started = Date.now();
  const log = join(dir, 'external.log');
  try {
    // A later round starts from the last one's code, which already has BMAD in it
    if (arm.workflow === 'bmad' && !existsSync(join(ws.path, '_bmad'))) {
      const install = spawnSync('npx', ['-y', `bmad-method@${BMAD_VERSION}`, 'install', '--directory', ws.path, '--modules', 'bmm', '--tools', 'claude-code', '--yes', '--user-name', 'Bench'], { cwd: ws.path, encoding: 'utf8', env: toolEnv({}) });
      writeFileSync(log, `--- bmad install (exit ${install.status})\n${install.stdout?.slice(-2000)}\n${install.stderr?.slice(-2000)}\n`, { flag: 'a' });
      if (install.status !== 0) { throw new Error(`BMAD install failed (exit ${install.status})`); }
    }
    // Every tool allowed without asking, as the single arm runs; the Stop hook tells the driver the lead stopped
    const marker = join(dir, 'lead-stopped');
    mkdirSync(join(ws.path, '.claude'), { recursive: true });
    writeFileSync(join(ws.path, '.claude', 'settings.local.json'), JSON.stringify({
      permissions: { defaultMode: 'acceptEdits', allow: ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Skill', 'Agent', 'Task'] },
      ...(arm.workflow === 'agent-teams' ? { hooks: { Stop: [{ hooks: [{ type: 'command', command: `date +%s >> ${JSON.stringify(marker)}` }] }] } } : {}),
    }, null, 2));

    const base = singlePrompt(opts.requirement, false);
    const common = ['--model', arm.model, '--setting-sources', 'project,local', '--strict-mcp-config'];
    const env = toolEnv({ CLAUDE_CODE_SUBAGENT_MODEL: arm.model, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', ...(arm.workflow === 'agent-teams' ? { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } : {}) });
    let outcome: string;
    if (arm.workflow === 'agent-teams') {
      // Teammates are only spawned in an interactive session, so this one runs in a terminal
      const child = spawn('python3', [join(STUDIO_ROOT, 'bench/runner/pty-drive.py'), '--marker', marker, '--watch', transcriptsOf(ws.path), '--deadline', String(Math.floor(opts.timeLimitMs / 1000) - 30), '--log', join(dir, 'terminal.log'), '--', 'claude', `${base}\n\n${TEAM_PROMPT}`, ...common], { cwd: ws.path, env, detached: true });
      const r = await settle(child, opts.timeLimitMs, log);
      outcome = r.timedOut ? 'deadline' : r.stdout.trim().split('\n').pop() ?? 'unknown';
    } else {
      const prompt = arm.workflow === 'bmad' ? `/bmad-build-auto ${base}` : base;
      // On flags, since a later round's workspace is a copy Claude Code has not trusted and it ignores the settings file there
      const allow = ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Edit,Write,Read,Glob,Grep,NotebookEdit,WebFetch,WebSearch,Skill,Agent,Task'];
      const child = spawn('claude', ['-p', prompt, ...common, ...allow, '--output-format', 'json'], { cwd: ws.path, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const r = await settle(child, opts.timeLimitMs, log);
      writeFileSync(join(dir, 'result.json'), r.stdout);
      let result: any = {};
      try { result = JSON.parse(r.stdout); } catch { /* reported below */ }
      outcome = r.timedOut ? 'deadline' : result.is_error === false ? 'finished' : `error: ${String(result.result ?? r.stdout).slice(0, 300)}`;
      if (result.total_cost_usd !== undefined) { writeFileSync(log, `claude reported $${result.total_cost_usd}\n`, { flag: 'a' }); }
    }

    const usage = usageFromTranscripts(transcriptsOf(ws.path));
    for (const [role, u] of Object.entries(usage.byRole)) {
      bus.emit(opts.runId, { type: 'usage', role, agent: `${arm.workflow}:${arm.model}`, inputTokens: u.input, outputTokens: u.output, cachedReadTokens: u.read, cachedWriteTokens: u.write, totalTokens: u.total, costUsd: u.cost, modelCalls: u.calls });
    }
    bus.emit(opts.runId, { type: 'log', level: usage.models.some(m => m !== arm.model) ? 'warn' : 'info', message: `${arm.workflow}: ${outcome}; ${usage.sessions} transcripts; models ${usage.models.join(', ') || 'none'}; ${Math.round((Date.now() - started) / 1000)}s` });
    const failed = outcome !== 'finished' && outcome !== 'exited';
    bus.emit(opts.runId, { type: 'run_finished', status: failed ? 'failed' : 'completed', ...(failed ? { error: outcome } : {}) });
    return failed ? 'failed' : 'completed';
  } catch (e) {
    bus.emit(opts.runId, { type: 'log', level: 'error', message: (e as Error).message });
    bus.emit(opts.runId, { type: 'run_finished', status: 'failed', error: (e as Error).message });
    return 'failed';
  }
}

/** Seconds since anything in the run's transcripts changed; for watching a run by hand. */
export const quietFor = (workspace: string) => Math.round((Date.now() - Math.max(0, ...filesUnder(transcriptsOf(workspace)).map(f => statSync(f).mtimeMs))) / 1000);
