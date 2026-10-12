import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

import { DATA_ROOT } from '../core/config';
import { usageByRole, type DevcrewEvent, type GateId } from '../core/events';
import { loadPipeline, validatePipeline, withGuides, type PipelineDef } from '../pipeline/schema';
import { buildGraph, type GateAnswer } from './graph';
import { checkCapabilities, getBus, getConfig } from './runtime';

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
  status: 'running' | 'waiting' | 'approved' | 'aborted' | 'failed' | 'completed';
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
    if (!state.tasks.some(t => t.interrupts.length)) { throw new Error('Run is not waiting at a gate'); }
    this.drive(runId, def, new Command({ resume: answer }));
  }

  /**
   * Continue a run whose process stopped mid-way (closed terminal, crash, killed on purpose),
   * from the last step it finished. The step that was interrupted runs again from its start.
   */
  async resume(runId: string): Promise<void> {
    await this.active.get(runId);
    const def = this.pipelineOf(runId);
    const state = await this.graphFor(def).getState(this.config(runId));
    if (state.tasks.some(t => t.interrupts.length)) { throw new Error('Run is waiting at a gate: answer the gate instead'); }
    if (!state.next.length) { throw new Error(state.values && Object.keys(state.values).length ? 'Run has already finished' : `No saved progress for run ${runId}`); }
    getBus().emit(runId, { type: 'log', level: 'info', message: `Resumed at ${state.next.join(', ')}.` });
    this.drive(runId, def, null);
  }

  /** Resolves with the final status (used by the benchmark runner). */
  waitFor(runId: string): Promise<string> {
    return new Promise(resolve => this.finished.set(runId, resolve));
  }

  list(): RunSummary[] {
    let ids: string[] = [];
    try { ids = readdirSync(join(DATA_ROOT, 'runs')); } catch { /* no runs yet */ }
    return ids.map(id => summarize(id, getBus().read(id))).filter((r): r is RunSummary => !!r)
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
    const job = (async () => {
      try {
        await graph.invoke(input as never, this.config(runId));
        const state = await graph.getState(this.config(runId));
        const waiting = state.tasks.flatMap(t => t.interrupts)[0];
        if (waiting) {
          const { gate, ...payload } = waiting.value as { gate: GateId } & Record<string, unknown>;
          bus.emit(runId, { type: 'gate_waiting', gate, payload });
        } else {
          this.finished.get(runId)?.(state.values.status);
        }
      } catch (e) {
        bus.emit(runId, { type: 'log', level: 'error', message: (e as Error).stack ?? String(e) });
        bus.emit(runId, { type: 'run_finished', status: 'failed', error: (e as Error).message });
        this.finished.get(runId)?.('failed');
      }
    })();
    this.active.set(runId, job);
    void job.finally(() => this.active.delete(runId));
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

function checked(def: PipelineDef): PipelineDef {
  const errors = validatePipeline(def);
  if (errors.length) { throw new Error(`Pipeline "${def.id}" is invalid:\n- ${errors.join('\n- ')}`); }
  return def;
}
