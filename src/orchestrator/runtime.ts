import { AgentSession, type TurnResult } from '../acp/AgentSession';
import { eventLogPath, loadConfig, type DevcrewConfig } from '../core/config';
import { EventBus, type HandoffFile, type Role } from '../core/events';
import { ROLE_SCOPES, type Scope } from '../core/scope';
import type { PipelineDef } from '../pipeline/schema';
import { changedFiles, revertOutOfScope, takeSnapshot, type Snapshot } from '../guard/snapshot';

let bus: EventBus | undefined;
let config: DevcrewConfig | undefined;

export function getBus(): EventBus {
  return (bus ??= new EventBus(eventLogPath));
}

export function getConfig(): DevcrewConfig {
  return (config ??= loadConfig());
}

/** Live agent sessions per run. Not checkpointed: after a restart, sessions start fresh from the files. */
const sessions = new Map<string, AgentSession>();

export interface TurnContext {
  runId: string;
  profile: string;
  workspace: string;
  role: Role;
  /** Sessions with the same key keep their context (e.g. one dev session per module). */
  key?: string;
  /** Who this turn's input comes from, which files it should read, and who gets its output. */
  io?: { from: string[]; reads: string[]; to: string[] };
  /** For pipeline-defined roles: what it may write, and which agent runs it. */
  scope?: Scope;
  agentName?: string;
}

/** The agent for a role: the step's own choice, the profile's mapping, or the profile's reviewer. */
/**
 * Which agent plays a role: the profile's entry for that role (built-in roles, or a pipeline
 * step's id) wins, then the agent the pipeline step names, then the profile's reviewer.
 * So one profile can move every role to another vendor without editing pipelines.
 */
export function agentForTurn(cfg: DevcrewConfig, ctx: Pick<TurnContext, 'profile' | 'role' | 'agentName'>) {
  const roles = cfg.profiles[ctx.profile] ?? {};
  // Demo profiles script every role with their own fake agent, whatever a step asks for
  const name = ctx.profile.startsWith('fake') ? roles[ctx.role] ?? roles.reviewer
    : roles[ctx.role] ?? ctx.agentName ?? roles.reviewer;
  const spec = cfg.agents[name];
  if (!spec) { throw new Error(`No agent "${name}" in devcrew.config.json for role "${ctx.role}"`); }
  return { name, spec };
}

/**
 * Problems that would make a run fail later: a role needs something its agent does not
 * provide (web search, running commands). Agents that do not say what they provide pass,
 * with a warning. Demo profiles are scripted, so they always pass.
 */
export function checkCapabilities(cfg: DevcrewConfig, profile: string, def: PipelineDef): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  if (profile.startsWith('fake')) { return { errors, warnings }; }
  if (!cfg.profiles[profile]) { return { errors: [`Unknown profile "${profile}".`], warnings }; }
  for (const step of def.steps) {
    if (step.type !== 'agent' || !step.needs?.length) { continue; }
    let agent;
    try { agent = agentForTurn(cfg, { profile, role: step.id, agentName: step.agent }); } catch (e) { errors.push((e as Error).message); continue; }
    if (!agent.spec.provides) {
      warnings.push(`${step.name} needs ${step.needs.join(' and ')}; agent "${agent.name}" does not say whether it can.`);
      continue;
    }
    const missing = step.needs.filter(n => !agent.spec.provides!.includes(n));
    if (missing.length) {
      errors.push(`${step.name} needs ${missing.join(' and ')}, but agent "${agent.name}" (profile "${profile}") does not provide ${missing.length === 1 ? 'it' : 'them'}. Pick another profile, or give the "${step.id}" role another agent in the profile.`);
    }
  }
  return { errors, warnings };
}

const scopeOf = (ctx: TurnContext): Scope => ctx.scope ?? ROLE_SCOPES[ctx.role] ?? { write: [], deny: [] };

const MAX_HANDOFF_CHARS = 20_000;
/** Reports and designs under .devcrew/ are what you review, so the log keeps more of them. */
const MAX_REPORT_CHARS = 200_000;

/**
 * Run one agent turn under the role's scope, then undo anything it changed outside that scope.
 * Each role (and each dev module) gets its own session, so no agent carries another's context.
 */
export async function agentTurn(ctx: TurnContext, prompt: string): Promise<TurnResult & { reverted: string[] }> {
  const cfg = getConfig();
  const id = `${ctx.runId}:${ctx.role}:${ctx.key ?? ''}`;
  let session = sessions.get(id);
  if (!session) {
    const { name, spec } = agentForTurn(cfg, ctx);
    session = await AgentSession.start({
      runId: ctx.runId, role: ctx.role, agentName: name, spec, workspace: ctx.workspace,
      scope: scopeOf(ctx), bus: getBus(), turnTimeoutMs: cfg.turnTimeoutMinutes * 60_000,
    });
    sessions.set(id, session);
  }
  const before = takeSnapshot(ctx.workspace);
  getBus().emit(ctx.runId, { type: 'agent_input', role: ctx.role, agent: agentForTurn(cfg, ctx).name, from: ctx.io?.from ?? [], reads: ctx.io?.reads ?? [], prompt });
  try {
    const result = await session.prompt(prompt);
    const reverted = guard(ctx, before);
    getBus().emit(ctx.runId, { type: 'agent_output', role: ctx.role, to: ctx.io?.to ?? [], files: handoff(before, takeSnapshot(ctx.workspace)) });
    return { ...result, reverted };
  } catch (e) {
    guard(ctx, before);
    session.close();
    sessions.delete(id);
    throw e;
  }
}

/** What the turn left behind, with each file's content as it was handed to the next role. */
function handoff(before: Snapshot, after: Snapshot): HandoffFile[] {
  return changedFiles(before, after).map(path => {
    const buf = after.get(path);
    if (!buf) { return { path, change: 'deleted' as const, lines: 0 }; }
    const text = buf.toString('utf8');
    const binary = text.includes('\u0000');
    const max = path.startsWith('.devcrew/') ? MAX_REPORT_CHARS : MAX_HANDOFF_CHARS;
    return {
      path,
      change: before.has(path) ? 'modified' as const : 'added' as const,
      lines: binary ? 0 : text.split('\n').length,
      content: binary ? undefined : text.slice(0, max),
      truncated: !binary && text.length > max,
    };
  });
}

function guard(ctx: TurnContext, before: Snapshot): string[] {
  const reverted = revertOutOfScope(ctx.workspace, before, scopeOf(ctx));
  if (reverted.length) {
    getBus().emit(ctx.runId, { type: 'guard_violation', role: ctx.role, files: reverted, action: 'reverted' });
  }
  return reverted;
}

export function closeSessions(runId: string, role?: Role): void {
  for (const [id, s] of sessions) {
    if (id.startsWith(`${runId}:${role ? role + ':' : ''}`)) { s.close(); sessions.delete(id); }
  }
}
