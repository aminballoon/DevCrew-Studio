import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM_DIAGRAM, type AgentStep, type PipelineDef } from '../pipeline/schema';

/** What one agent step left in the workspace, for the next gate to show. */
export interface StepReport {
  step: string;
  name: string;
  files: { path: string; text: string }[];
}

const TEXT = /\.(md|txt|json|ya?ml|csv|sh|py|mjs|js|ts|cfg|ini|toml)$/i;
const MAX_FILES = 20;
const MAX_CHARS = 40_000;

/** Workspace-relative files under one mayWrite entry (a file, or a folder ending in /). */
function filesUnder(workspace: string, entry: string): string[] {
  const full = join(workspace, entry);
  if (!existsSync(full)) { return []; }
  if (!entry.endsWith('/')) { return statSync(full).isFile() ? [entry] : []; }
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(workspace, rel)).sort()) {
      const child = `${rel}${name}`;
      if (statSync(join(workspace, child)).isDirectory()) { walk(`${child}/`); } else { out.push(child); }
    }
  };
  walk(entry);
  return out;
}

/** Agent steps that come before position `before` in the pipeline. */
export const agentStepsBefore = (def: PipelineDef, before: number) =>
  def.steps.slice(0, before).filter((s): s is AgentStep => s.type === 'agent');

/** Paths earlier roles may have written, for prompts that should read them. */
export const reportPaths = (def: PipelineDef, before: number) =>
  agentStepsBefore(def, before).flatMap(s => s.mayWrite);

/** Text files written by the agent steps before a gate, grouped by step. The diagram is shown on its own. */
export function collectReports(workspace: string, def: PipelineDef, before: number): StepReport[] {
  return agentStepsBefore(def, before).flatMap(step => {
    const paths = [...new Set(step.mayWrite.flatMap(e => filesUnder(workspace, e)))]
      .filter(p => p !== SYSTEM_DIAGRAM && TEXT.test(p))
      .slice(0, MAX_FILES);
    const files = paths.map(path => ({ path, text: readFileSync(join(workspace, path), 'utf8').slice(0, MAX_CHARS) }));
    return files.length ? [{ step: step.id, name: step.name, files }] : [];
  });
}
