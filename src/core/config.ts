import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Role } from './events';
import type { NotifyConfig } from './notify';

export interface AgentSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** What this agent can do ("web", "shell"); roles that need more are refused before a run starts. */
  provides?: string[];
  /** Sent as the ACP session's _meta: vendor-specific options, e.g. which settings Claude loads. */
  sessionMeta?: Record<string, unknown>;
  /** One plain line shown next to the agent. */
  note?: string;
}

export interface DevcrewConfig {
  agents: Record<string, AgentSpec>;
  profiles: Record<string, Record<Role, string>>;
  defaultProfile: string;
  /** One line per profile, shown when starting a run. */
  profileNotes?: Record<string, string>;
  maxFixAttempts: number;
  turnTimeoutMinutes: number;
  /** A session holding more tokens than this starts fresh for its next full prompt (default 100,000). */
  freshSessionAboveTokens?: number;
  /** Chat agents (OpenClaw, Hermes) that bring gate questions to your phone. */
  notify?: NotifyConfig;
}

/** Repository root of DevCrew Studio itself (config, agents/, bench/). */
export const STUDIO_ROOT = resolve(import.meta.dirname, '../..');
/**
 * Run data: event logs, checkpoints and copied workspaces. Git-ignored. Always absolute: agents get
 * workspaces under it as their working folder, and a relative one put their files somewhere else.
 */
export const DATA_ROOT = resolve(STUDIO_ROOT, process.env.DEVCREW_DATA ?? '.devcrew-data');

export function loadConfig(path = join(STUDIO_ROOT, 'devcrew.config.json')): DevcrewConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as DevcrewConfig;
}

export const runDir = (runId: string) => join(DATA_ROOT, 'runs', runId);
export const eventLogPath = (runId: string) => join(runDir(runId), 'events.jsonl');
