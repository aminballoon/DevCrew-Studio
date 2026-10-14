import { randomUUID } from 'node:crypto';
import { runCommand, parseTestCounts } from '../guard/verify';
import { prepareWorkspace } from '../guard/workspace';
import { singlePrompt } from './prompts';
import { agentTurn, closeSessions, getBus, getConfig } from './runtime';

export interface SingleRunOptions {
  requirement: string;
  source?: string;
  profile: string;
  /** Arm A+: the same process as the pipeline, in one agent, with the same external fix loop. */
  process: boolean;
  /** Role guide texts for a control arm that gets the team's know-how in one agent. */
  guides?: string;
  label?: string;
  runId?: string;
  /** The one agent does the whole task in one turn, so it needs the task's time limit, not the per-turn one. */
  turnTimeoutMs?: number;
}

/**
 * Baseline arms: one agent session holds the whole job and its context.
 * Uses the same ACP harness and events as the pipeline, so tokens and time are measured the same way.
 */
export async function runSingle(opts: SingleRunOptions): Promise<{ runId: string; status: string; workspace: string }> {
  const runId = opts.runId ?? `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 6)}`;
  const bus = getBus();
  const ws = prepareWorkspace(opts.source, runId);
  bus.emit(runId, { type: 'run_started', requirement: opts.requirement, workspace: ws.path, mode: 'single', profile: opts.profile, label: opts.label });
  const to = [opts.process ? 'Verify' : 'End of run'];
  const ctx = { runId, profile: opts.profile, workspace: ws.path, role: 'single' as const, io: { from: ['You: the task'], reads: [], to }, turnTimeoutMs: opts.turnTimeoutMs };
  try {
    bus.emit(runId, { type: 'node_started', node: 'single', attempt: 1 });
    await agentTurn(ctx, singlePrompt(opts.requirement, opts.process, opts.guides));
    bus.emit(runId, { type: 'node_finished', node: 'single' });

    if (opts.process) {
      // Same external judge and attempt budget as the pipeline, but on the agent's own tests
      const max = getConfig().maxFixAttempts;
      for (let attempt = 1; ; attempt++) {
        bus.emit(runId, { type: 'node_started', node: 'verify', attempt });
        const run = await runCommand('node --test', ws.path);
        const tests = parseTestCounts(run.output);
        const passed = run.code === 0 && tests.total > 0 && tests.fail === 0;
        const reasons = passed ? [] : [tests.total === 0 ? 'No tests ran' : `${tests.fail} of ${tests.total} tests failed`];
        bus.emit(runId, { type: 'verify_result', module: 'all', attempt, passed, tests, reasons, output: run.output.slice(-6000), commands: ['node --test'] });
        bus.emit(runId, { type: 'node_finished', node: 'verify' });
        if (passed || attempt >= max) { break; }
        bus.emit(runId, { type: 'node_started', node: 'single', attempt: attempt + 1 });
        await agentTurn({ ...ctx, io: { from: ['Verify: why the tests failed'], reads: [], to }, continues: true }, `The test suite does not pass:\n${reasons.join('\n')}\n\n\`\`\`\n${run.output.slice(-4000)}\n\`\`\`\nFix the implementation. Do not weaken or skip tests.`);
        bus.emit(runId, { type: 'node_finished', node: 'single' });
      }
    }
    bus.emit(runId, { type: 'run_finished', status: 'completed' });
    return { runId, status: 'completed', workspace: ws.path };
  } catch (e) {
    bus.emit(runId, { type: 'log', level: 'error', message: (e as Error).stack ?? String(e) });
    bus.emit(runId, { type: 'run_finished', status: 'failed', error: (e as Error).message });
    return { runId, status: 'failed', workspace: ws.path };
  } finally {
    closeSessions(runId);
  }
}
