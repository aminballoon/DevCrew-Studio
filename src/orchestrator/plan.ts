import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Check } from '../guard/verify';
import { TEST_FORMATS, type TestFormat } from '../guard/testFormats';
import type { Clause } from './requirement';

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
  /** Test output formats the test command prints (see guard/testFormats.ts); found automatically when absent. */
  testFormats?: string[];
  /** Requirement clause id (R-n) → the acceptance criteria (AC-n) that cover it. */
  coverage?: Record<string, string[]>;
}

export const PLAN_PATH = '.devcrew/plan.json';

/**
 * The planner's plan.json, validated. Throws with a message the planner can act on.
 * With the requirement's clauses, every clause must be covered by acceptance criteria that exist in PRD.md.
 */
export function readPlan(workspace: string, clauses?: Clause[]): Plan {
  const path = join(workspace, PLAN_PATH);
  if (!existsSync(path)) { throw new Error(`${PLAN_PATH} was not written`); }
  let raw: Partial<Plan>;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new Error(`${PLAN_PATH} is not valid JSON: ${(e as Error).message}`); }
  const modules = (raw.modules ?? []).filter(m => m && typeof m.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(m.id));
  if (!modules.length) { throw new Error(`${PLAN_PATH} has no modules with kebab-case ids`); }
  const architecture = readArchitecture((raw as { architecture?: unknown }).architecture, modules.map(m => m.id));
  const coverage = clauses?.length ? readCoverage(workspace, (raw as { coverage?: unknown }).coverage, clauses) : undefined;
  return {
    modules: modules.map(m => ({ id: m.id, title: m.title ?? m.id, description: m.description ?? '' })),
    architecture,
    testCommand: raw.testCommand || 'node --test',
    moduleTestCommand: raw.moduleTestCommand?.includes('{module}') ? raw.moduleTestCommand : undefined,
    checks: (raw.checks ?? []).filter(c => c?.name && c?.command),
    testFormats: Array.isArray(raw.testFormats) ? raw.testFormats.filter(f => TEST_FORMATS.includes(f as TestFormat)) : undefined,
    coverage,
  };
}

function readCoverage(workspace: string, raw: unknown, clauses: Clause[]): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${PLAN_PATH} has no "coverage": map every requirement clause (R-1 … R-${clauses.length}) to the acceptance criteria that cover it`);
  }
  const prd = readText(workspace, '.devcrew/PRD.md', 200_000) ?? '';
  const known = new Set(prd.match(/\bAC-\d+\b/g) ?? []);
  const coverage: Record<string, string[]> = {};
  const missing: string[] = [];
  const unknown = new Set<string>();
  for (const { id } of clauses) {
    const acs = (raw as Record<string, unknown>)[id];
    const list = Array.isArray(acs) ? acs.filter((a): a is string => typeof a === 'string') : [];
    list.filter(a => !known.has(a)).forEach(a => unknown.add(a));
    if (!list.some(a => known.has(a))) { missing.push(id); }
    coverage[id] = list;
  }
  const problems = [
    missing.length ? `requirement clauses with no acceptance criterion in PRD.md: ${missing.join(', ')}` : '',
    unknown.size ? `acceptance criteria not found in PRD.md: ${[...unknown].join(', ')}` : '',
  ].filter(Boolean);
  if (problems.length) {
    throw new Error(`${PLAN_PATH} "coverage" is incomplete: ${problems.join('; ')}. Add or widen acceptance criteria so each clause is covered word for word, then update coverage`);
  }
  return coverage;
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

/** How to run a set of tests, as the fast pipeline's Builder or QA wrote it. */
export interface TestRun { testCommand: string; testFormats?: string[] }

/** A test run file (.devcrew/test.json, .devcrew/acceptance.json), validated. Throws with a message the agent can act on. */
export function readTestRun(workspace: string, rel: string): TestRun {
  const text = readText(workspace, rel);
  if (text === null) { throw new Error(`${rel} was not written`); }
  let raw: { testCommand?: unknown; testFormats?: unknown };
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`${rel} is not valid JSON: ${(e as Error).message}`); }
  if (typeof raw.testCommand !== 'string' || !raw.testCommand.trim()) { throw new Error(`${rel} has no "testCommand"`); }
  const formats = Array.isArray(raw.testFormats) ? raw.testFormats.filter((f): f is TestFormat => TEST_FORMATS.includes(f as TestFormat)) : [];
  return { testCommand: raw.testCommand.trim(), ...(formats.length ? { testFormats: formats } : {}) };
}
