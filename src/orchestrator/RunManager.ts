import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

import { DATA_ROOT, runDir } from '../core/config';
import { gateDecisions, notifyGate } from '../core/notify';
import { usageByRole, type DevcrewEvent, type GateId } from '../core/events';
import { loadPipeline, validatePipeline, withGuides, type PipelineDef } from '../pipeline/schema';
import { buildGraph, type GateAnswer } from './graph';
import { checkCapabilities, closeSessions, getBus, getConfig } from './runtime';

export interface StartOptions {
  requirement: string;
  source?: string;
  profile?: string;
  autoApprove?: boolean;
  label?: string;
  /** Approved pipeline id from pipelines/ (default "standard"), or a definition (tests). */
  pipeline?: string | PipelineDef;
}

export interface RunSummary {
  runId: string;
  requirement: string;
  label?: string;
  profile: string;
  /** "stopped": the log says running, but no process is driving it any more (it can be resumed). */
  status: 'running' | 'stopped' | 'waiting' | 'approved' | 'aborted' | 'failed' | 'completed';
  waitingGate?: GateId;
  startedAt: number;
  endedAt?: number;
  currentNode?: string;
  totalTokens: number;
  costUsd: number;
}

/**
 * Starts pipeline runs, resumes them at gates, and keeps them durable: every step is
 * checkpointed in SQLite, so a run survives restarts and can wait days at a gate.
 */
export class RunManager {
  private readonly saver: SqliteSaver;
  private readonly graphs = new Map<string, ReturnType<ReturnType<typeof buildGraph>['compile']>>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly finished = new Map<string, (status: string) => void>();

  constructor() {
    mkdirSync(DATA_ROOT, { recursive: true });
    this.saver = SqliteSaver.fromConnString(join(DATA_ROOT, 'checkpoints.sqlite'));
  }

  /** One compiled graph per pipeline definition (by content, so edited files get a new graph). */
  private graphFor(def: PipelineDef) {
    const key = JSON.stringify(def);
    let g = this.graphs.get(key);
    if (!g) {
      g = buildGraph(def).compile({ checkpointer: this.saver });
      this.graphs.set(key, g);
    }
    return g;
  }

  private requirementOf(runId: string): string {
    const started = getBus().read(runId).find(e => e.type === 'run_started');
    return started?.type === 'run_started' ? started.requirement : '';
  }

  /**
   * The gate a run waits at, in plain text for a chat agent: what is asked, what was found,
   * and which answers it takes. Null when the run is not waiting.
   */
  waitingGateText(runId: string): string | null {
    const events = getBus().read(runId);
    const lastWait = events.findLastIndex(e => e.type === 'gate_waiting');
    if (lastWait < 0 || events.slice(lastWait).some(e => e.type === 'gate_resolved' || e.type === 'run_finished')) { return null; }
    const e = events[lastWait] as Extract<DevcrewEvent, { type: 'gate_waiting' }>;
    const p = e.payload;
    const lines = [`Run ${runId} waits at: ${String(p.title ?? e.gate)}`, `Requirement:\n${this.requirementOf(runId)}`];
    for (const [k, v] of Object.entries(p)) {
      if (['title', 'kind'].includes(k) || v == null || v === '') { continue; }
      const text = typeof v === 'string' ? v : JSON.stringify(v, null, 1);
      lines.push(`${k}:\n${text.length > 3000 ? `${text.slice(0, 3000)}\n... (shortened, see the dashboard)` : text}`);
    }
    lines.push(`Answers: ${gateDecisions(p).join(', ')}`);
    return lines.join('\n\n');
  }

  /** Answers the gate a run waits at takes (none when it is not waiting). */
  waitingDecisions(runId: string): string[] {
    const events = getBus().read(runId);
    const lastWait = events.findLastIndex(e => e.type === 'gate_waiting');
    if (lastWait < 0 || events.slice(lastWait).some(e => e.type === 'gate_resolved' || e.type === 'run_finished')) { return []; }
    return gateDecisions((events[lastWait] as Extract<DevcrewEvent, { type: 'gate_waiting' }>).payload);
  }

  /** The pipeline a run was started with; runs from before pipelines existed used the standard one. */
  private pipelineOf(runId: string): PipelineDef {
    const started = getBus().read(runId).find(e => e.type === 'run_started');
    return (started?.type === 'run_started' && started.pipeline) || loadPipeline('standard');
  }

  start(opts: StartOptions): string {
    // A run keeps the guide texts it started with, so editing a guide never changes a running pipeline
    const def = withGuides(typeof opts.pipeline === 'object' ? checked(opts.pipeline) : loadPipeline(opts.pipeline ?? 'standard'));
    const profile = opts.profile ?? getConfig().defaultProfile;
    const { errors, warnings } = checkCapabilities(getConfig(), profile, def);
    if (errors.length) { throw new Error(`This profile cannot run the "${def.id}" pipeline:\n- ${errors.join('\n- ')}`); }
    const runId = `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 6)}`;
    this.drive(runId, def, {
      runId,
      requirement: opts.requirement,
      source: opts.source ?? '',
      profile,
      warnings,
      autoApprove: opts.autoApprove ?? false,
      label: opts.label ?? '',
    });
    return runId;
  }

  async resolveGate(runId: string, answer: GateAnswer): Promise<void> {
    // gate_waiting is emitted just before the job settles; let it finish first
    await this.active.get(runId);
    const def = this.pipelineOf(runId);
    const state = await this.graphFor(def).getState(this.config(runId));
    const waiting = state.tasks.flatMap(t => t.interrupts)[0];
    if (!waiting) { throw new Error('Run is not waiting at a gate'); }
    const allowed = gateDecisions(waiting.value as Record<string, unknown>);
    if (!allowed.includes(answer.decision)) { throw new Error(`This gate takes ${allowed.join(', ')}, not "${answer.decision}"`); }
    this.drive(runId, def, new Command({ resume: answer }));
  }

  /**
   * Whether a run can continue from where it stopped, and from which step. A run that is
   * still being driven, here or by another process (a CLI in another terminal), cannot:
   * two processes on one run would overwrite each other's work.
   */
  async resumeInfo(runId: string): Promise<ResumeInfo> {
    if (!getBus().read(runId).some(e => e.type === 'run_started')) { return { resumable: false, reason: `No run ${runId}` }; }
    // A job that has just stopped at a gate or finished does no more work; let it settle
    const job = this.active.get(runId);
    if (job && ['gate_waiting', 'run_finished'].includes(getBus().read(runId).at(-1)?.type ?? '')) { await job; }
    const owner = liveOwner(runId);
    if (this.active.has(runId) || owner) {
      return { resumable: false, reason: owner && owner !== process.pid ? `Still running in another process (pid ${owner})` : 'Still running' };
    }
    const def = this.pipelineOf(runId);
    const state = await this.graphFor(def).getState(this.config(runId));
    if (state.tasks.some(t => t.interrupts.length)) { return { resumable: false, reason: 'Waiting at a gate: answer the gate instead' }; }
    if (!state.next.length) {
      return { resumable: false, reason: state.values && Object.keys(state.values).length ? 'The run has finished' : 'No saved progress for this run' };
    }
    return { resumable: true, next: state.next.map(n => stepLabel(def, n)) };
  }

  /**
   * Continue a run whose process stopped mid-way (closed terminal, crash, quota, killed on
   * purpose) from the last step it finished. The step that was interrupted runs again from its start.
   */
  async resume(runId: string): Promise<void> {
    const info = await this.resumeInfo(runId);
    if (!info.resumable) { throw new Error(info.reason); }
    getBus().emit(runId, { type: 'log', level: 'info', message: `Resumed at ${info.next!.join(', ')}.` });
    this.drive(runId, this.pipelineOf(runId), null);
  }

  /** Resolves with the final status (used by the benchmark runner). */
  waitFor(runId: string): Promise<string> {
    return new Promise(resolve => this.finished.set(runId, resolve));
  }

  list(): RunSummary[] {
    let ids: string[] = [];
    try { ids = readdirSync(join(DATA_ROOT, 'runs')); } catch { /* no runs yet */ }
    return ids.map(id => summarize(id, getBus().read(id))).filter((r): r is RunSummary => !!r)
      // "Running" with nobody driving it means its process stopped: it can be resumed
      .map(r => (r.status === 'running' && !this.active.has(r.runId) && !liveOwner(r.runId) ? { ...r, status: 'stopped' as const } : r))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  events(runId: string): DevcrewEvent[] {
    return getBus().read(runId);
  }

  private config(runId: string) {
    return { configurable: { thread_id: runId }, recursionLimit: 500 };
  }

  private drive(runId: string, def: PipelineDef, input: unknown): void {
    const bus = getBus();
    const graph = this.graphFor(def);
    const before = bus.read(runId).length;
    const job = (async () => {
      try {
        await graph.invoke(input as never, this.config(runId));
        const state = await graph.getState(this.config(runId));
        const waiting = state.tasks.flatMap(t => t.interrupts)[0];
        if (waiting) {
          const { gate, ...payload } = waiting.value as { gate: GateId } & Record<string, unknown>;
          // Before gate_waiting: the CLI exits on that event, and the question must reach your phone first
          for (const { level, message } of await notifyGate(getConfig(), runId, gate, payload, this.requirementOf(runId))) {
            bus.emit(runId, { type: 'log', level, message });
          }
          bus.emit(runId, { type: 'gate_waiting', gate, payload });
        } else {
          this.finished.get(runId)?.(state.values.status);
        }
      } catch (e) {
        // The graph's finish step did not run, so the agents of earlier steps are still alive
        closeSessions(runId);
        // Already ended from outside (a benchmark time limit cancels and records why): don't end it twice
        if (bus.read(runId).slice(before).some(x => x.type === 'run_finished')) { this.finished.get(runId)?.('failed'); return; }
        bus.emit(runId, { type: 'log', level: 'error', message: (e as Error).stack ?? String(e) });
        bus.emit(runId, { type: 'run_finished', status: 'failed', error: (e as Error).message });
        this.finished.get(runId)?.('failed');
      }
    })();
    this.active.set(runId, job);
    claimOwner(runId);
    void job.finally(() => { this.active.delete(runId); releaseOwner(runId); });
  }
}

/** Run overview derived purely from its event log. */
export function summarize(runId: string, events: DevcrewEvent[]): RunSummary | undefined {
  const started = events.find(e => e.type === 'run_started');
  if (!started || started.type !== 'run_started') { return undefined; }
  let status: RunSummary['status'] = 'running';
  let waitingGate: GateId | undefined;
  let currentNode: string | undefined;
  let endedAt: number | undefined;
  for (const e of events) {
    if (e.type === 'node_started') { currentNode = e.node; status = 'running'; waitingGate = undefined; }
    if (e.type === 'gate_waiting') { status = 'waiting'; waitingGate = e.gate; currentNode = `gate_${e.gate}`; }
    if (e.type === 'gate_resolved') { status = 'running'; waitingGate = undefined; }
    if (e.type === 'run_finished') { status = e.status; endedAt = e.ts; currentNode = undefined; }
  }
  const usage = Object.values(usageByRole(events));
  return {
    runId,
    requirement: started.requirement,
    label: started.label,
    profile: started.profile,
    status,
    waitingGate,
    startedAt: started.ts,
    endedAt,
    currentNode,
    totalTokens: usage.reduce((n, u) => n + u.totalTokens, 0),
    costUsd: usage.reduce((n, u) => n + u.costUsd, 0),
  };
}

export interface ResumeInfo { resumable: boolean; next?: string[]; reason?: string }

// --- Which process drives a run ---
// runs/<id>/owner.json holds the pid while a process drives the run, so a run started from the
// CLI is not resumed by the dashboard (or the other way round) while it is still going.

const ownerPath = (runId: string) => join(runDir(runId), 'owner.json');

function claimOwner(runId: string): void {
  mkdirSync(runDir(runId), { recursive: true });
  writeFileSync(ownerPath(runId), JSON.stringify({ pid: process.pid, since: Date.now() }));
}

function releaseOwner(runId: string): void {
  try {
    const { pid } = JSON.parse(readFileSync(ownerPath(runId), 'utf8'));
    if (pid === process.pid) { unlinkSync(ownerPath(runId)); }
  } catch { /* already gone */ }
}

/** The pid of a live process driving the run, if any. */
function liveOwner(runId: string): number | null {
  try {
    const { pid } = JSON.parse(readFileSync(ownerPath(runId), 'utf8')) as { pid: number };
    process.kill(pid, 0);
    return pid;
  } catch { return null; }
}

/** A graph node in words: the build step's nodes are Dev and Verify. */
function stepLabel(def: PipelineDef, node: string): string {
  const step = def.steps.find(s => s.id === node);
  if (step?.type === 'agent') { return step.name; }
  if (step?.type === 'gate') { return step.title; }
  return { planner: 'Planner', qa: 'QA', dev: 'Dev', verify: 'Verify', escalate: 'Escalation', finish: 'Finish' }[node] ?? node;
}

function checked(def: PipelineDef): PipelineDef {
  const errors = validatePipeline(def);
  if (errors.length) { throw new Error(`Pipeline "${def.id}" is invalid:\n- ${errors.join('\n- ')}`); }
  return def;
}
