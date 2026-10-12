import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Check } from '../guard/verify';

export interface PlanModule { id: string; title: string; description: string }

export type ArchFileKind = 'contract' | 'source' | 'test' | 'config' | 'doc';
const KINDS: ArchFileKind[] = ['contract', 'source', 'test', 'config', 'doc'];

/** One file of the planned architecture: what it is for and what it relies on. */
export interface ArchFile {
  path: string;
  kind: ArchFileKind;
  /** Plan modules this file belongs to (empty = shared by all). */
  modules: string[];
  purpose: string;
  /** Names other files can use: classes, functions, types, endpoints. */
  exports: string[];
  /** Workspace-relative paths of planned files this one uses. */
  dependsOn: string[];
}

export interface Plan {
  modules: PlanModule[];
  /** Every file the run is expected to create or change. */
  architecture: ArchFile[];
  testCommand: string;
  /** Test command for one module, with {module} standing for its id. */
  moduleTestCommand?: string;
  checks?: Check[];
}

export const PLAN_PATH = '.devcrew/plan.json';

/** The planner's plan.json, validated. Throws with a message the planner can act on. */
export function readPlan(workspace: string): Plan {
  const path = join(workspace, PLAN_PATH);
  if (!existsSync(path)) { throw new Error(`${PLAN_PATH} was not written`); }
  let raw: Partial<Plan>;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new Error(`${PLAN_PATH} is not valid JSON: ${(e as Error).message}`); }
  const modules = (raw.modules ?? []).filter(m => m && typeof m.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(m.id));
  if (!modules.length) { throw new Error(`${PLAN_PATH} has no modules with kebab-case ids`); }
  const architecture = readArchitecture((raw as { architecture?: unknown }).architecture, modules.map(m => m.id));
  return {
    modules: modules.map(m => ({ id: m.id, title: m.title ?? m.id, description: m.description ?? '' })),
    architecture,
    testCommand: raw.testCommand || 'node --test',
    moduleTestCommand: raw.moduleTestCommand?.includes('{module}') ? raw.moduleTestCommand : undefined,
    checks: (raw.checks ?? []).filter(c => c?.name && c?.command),
  };
}

function readArchitecture(raw: unknown, moduleIds: string[]): ArchFile[] {
  const list = (raw as { files?: unknown[] } | undefined)?.files;
  if (!Array.isArray(list) || !list.length) {
    throw new Error(`${PLAN_PATH} has no architecture.files: list every file to create with its path, kind, modules, purpose, exports and dependsOn`);
  }
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const files = list.flatMap(f => {
    const x = f as Partial<ArchFile> & { module?: string };
    if (typeof x?.path !== 'string' || !x.path.trim()) { return []; }
    return [{
      path: x.path.replace(/^\.\//, ''),
      kind: KINDS.includes(x.kind as ArchFileKind) ? x.kind as ArchFileKind : 'source',
      modules: strings(x.modules ?? (x.module ? [x.module] : [])).filter(m => moduleIds.includes(m)),
      purpose: typeof x.purpose === 'string' ? x.purpose : '',
      exports: strings(x.exports),
      dependsOn: strings(x.dependsOn).map(d => d.replace(/^\.\//, '')),
    }];
  });
  const missing = files.filter(f => !f.purpose.trim()).map(f => f.path);
  if (missing.length) { throw new Error(`${PLAN_PATH} architecture files without a purpose: ${missing.join(', ')}`); }
  return files;
}

/** Planned files for one module (shared files count for every module). */
export function filesFor(plan: Plan, moduleId: string, kinds: ArchFileKind[]): ArchFile[] {
  return plan.architecture.filter(f => kinds.includes(f.kind) && (!f.modules.length || f.modules.includes(moduleId)));
}

export function readText(workspace: string, rel: string, max = 20_000): string | null {
  const path = join(workspace, rel);
  return existsSync(path) ? readFileSync(path, 'utf8').slice(0, max) : null;
}
