import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { PipelineDef } from '../pipeline/schema';

/** Built-in roles are planner, qa, dev, reviewer and single; pipelines can add their own. */
export type Role = string;
/** A gate step's id, or "escalation". Runs made before pipelines used "spec" and "merge". */
export type GateId = string;

export interface TestCounts { total: number; pass: number; fail: number; skipped: number }

export interface UsageNumbers {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  totalTokens: number;
  /** API-equivalent cost reported by the agent, in USD. */
  costUsd: number;
}

/** A file a role produced, with its content at the moment it was handed off. */
export interface HandoffFile {
  path: string;
  change: 'added' | 'modified' | 'deleted';
  lines: number;
  content?: string;
  truncated?: boolean;
}

/** Everything the dashboard, the benchmark and the logs know about a run comes from these. */
export type DevcrewEventBody =
  | { type: 'run_started'; requirement: string; workspace: string; mode: 'pipeline' | 'single'; profile: string; label?: string; pipeline?: PipelineDef }
  | { type: 'node_started'; node: string; module?: string; attempt?: number }
  | { type: 'node_finished'; node: string; summary?: string }
  | { type: 'agent_input'; role: Role; agent: string; from: string[]; reads: string[]; prompt: string }
  | { type: 'agent_output'; role: Role; to: string[]; files: HandoffFile[] }
  | { type: 'agent_text'; role: Role; text: string }
  | { type: 'tool_call'; role: Role; toolCallId: string; title: string; kind?: string; status?: string }
  | ({ type: 'usage'; role: Role; agent: string; contextUsed?: number; contextSize?: number } & UsageNumbers)
  | { type: 'guard_violation'; role: Role; files: string[]; action: 'reverted' | 'rejected' }
  | { type: 'verify_result'; module: string; attempt: number; passed: boolean; tests: TestCounts; reasons: string[]; output: string; commands?: string[] }
  | { type: 'gate_waiting'; gate: GateId; payload: Record<string, unknown> }
  | { type: 'gate_resolved'; gate: GateId; decision: string; feedback?: string }
  | { type: 'run_finished'; status: 'approved' | 'aborted' | 'failed' | 'completed'; error?: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export type DevcrewEvent = DevcrewEventBody & { runId: string; ts: number; seq: number };

type Listener = (e: DevcrewEvent) => void;

/**
 * Append-only event log per run (JSONL on disk) with live subscribers.
 * The file is the source of truth: the dashboard replays it, then follows live events.
 */
export class EventBus {
  private listeners = new Set<Listener>();
  private seqs = new Map<string, number>();

  constructor(private readonly logPath: (runId: string) => string) {}

  emit(runId: string, body: DevcrewEventBody): DevcrewEvent {
    const seq = (this.seqs.get(runId) ?? this.lastSeq(runId)) + 1;
    this.seqs.set(runId, seq);
    const event = { ...body, runId, ts: Date.now(), seq } as DevcrewEvent;
    const path = this.logPath(runId);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(event) + '\n');
    for (const l of this.listeners) {
      try { l(event); } catch { /* a broken listener must not stop the run */ }
    }
    return event;
  }

  read(runId: string): DevcrewEvent[] {
    const path = this.logPath(runId);
    if (!existsSync(path)) { return []; }
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as DevcrewEvent);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private lastSeq(runId: string): number {
    const events = this.read(runId);
    return events.length ? events[events.length - 1].seq : 0;
  }
}

export function emptyUsage(): UsageNumbers {
  return { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 0, costUsd: 0 };
}

export function addUsage(a: UsageNumbers, b: UsageNumbers): UsageNumbers {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedReadTokens: a.cachedReadTokens + b.cachedReadTokens,
    cachedWriteTokens: a.cachedWriteTokens + b.cachedWriteTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

/** Usage per role summed over a run's events. */
export function usageByRole(events: DevcrewEvent[]): Record<Role, UsageNumbers> {
  const out: Record<Role, UsageNumbers> = {};
  for (const e of events) {
    if (e.type !== 'usage') { continue; }
    out[e.role] = addUsage(out[e.role] ?? emptyUsage(), e);
  }
  return out;
}
