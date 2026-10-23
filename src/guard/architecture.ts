import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { takeSnapshot } from './snapshot';

/**
 * The project's architecture as rules a machine can check: which modules exist, which ones each
 * may import, and through which file. It lives in the repository and outlasts every run.
 *
 * Why rules and not prose: overview files barely change what agents do (arXiv 2602.11988,
 * 2607.27250), while concrete module and dependency specs raise conformance a lot, most for weaker
 * models (arXiv 2608.21747); and an LLM judge agrees poorly with static checks (r = 0.21), so the
 * rules are enforced by Verify, not by a reviewer's reading.
 */
export const ARCHITECTURE_FILE = '.devcrew/architecture.json';
/** The human-readable side: the decisions and their reasons, for people and agents. */
export const ARCHITECTURE_DOC = '.devcrew/ARCHITECTURE.md';

export interface ArchModule {
  id: string;
  /** Folder (ending in /) or single file the module owns, workspace-relative. */
  path: string;
  purpose: string;
  /** Modules this one may import. */
  mayUse: string[];
  /** The only file other modules may import, when set. */
  interface?: string;
}

export interface Architecture {
  modules: ArchModule[];
  decisions: { id: string; title: string; decision: string; why: string }[];
}

const ID = /^[a-z][a-z0-9-]*$/;

/** The architecture file, validated; null when the project has none. Throws with a message an agent can act on. */
export function readArchitecture(workspace: string): Architecture | null {
  const path = join(workspace, ARCHITECTURE_FILE);
  if (!existsSync(path)) { return null; }
  let raw: Partial<Architecture>;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new Error(`${ARCHITECTURE_FILE} is not valid JSON: ${(e as Error).message}`); }
  const problems: string[] = [];
  const modules = Array.isArray(raw.modules) ? raw.modules : [];
  if (!modules.length) { problems.push('"modules" must list at least one module'); }
  const ids = new Set(modules.map(m => m?.id));
  for (const m of modules) {
    if (typeof m?.id !== 'string' || !ID.test(m.id)) { problems.push(`module id ${JSON.stringify(m?.id)} must be kebab-case`); continue; }
    if (typeof m.path !== 'string' || !m.path || m.path.startsWith('/') || m.path.includes('..')) { problems.push(`module "${m.id}" needs a workspace-relative "path"`); }
    if (typeof m.purpose !== 'string' || !m.purpose.trim()) { problems.push(`module "${m.id}" needs a "purpose"`); }
    if (!Array.isArray(m.mayUse)) { problems.push(`module "${m.id}" needs "mayUse" (a list, empty when it uses no other module)`); }
    for (const u of m.mayUse ?? []) { if (!ids.has(u)) { problems.push(`module "${m.id}" may use unknown module "${u}"`); } }
    if (m.interface !== undefined && (typeof m.interface !== 'string' || !inModule(m, m.interface))) { problems.push(`module "${m.id}": "interface" must be a file inside its path`); }
  }
  if (ids.size !== modules.length) { problems.push('module ids must be unique'); }
  const cycle = findCycle(modules);
  if (cycle) { problems.push(`"mayUse" has a cycle: ${cycle.join(' → ')}`); }
  if (problems.length) { throw new Error(`${ARCHITECTURE_FILE}: ${problems.join('; ')}`); }
  return { modules, decisions: Array.isArray(raw.decisions) ? raw.decisions : [] };
}

const inModule = (m: ArchModule, file: string) => (m.path.endsWith('/') ? file.startsWith(m.path) : file === m.path);
/** The most specific module owning a file (a nested module wins over its parent folder). */
const owner = (a: Architecture, file: string) =>
  a.modules.filter(m => inModule(m, file)).sort((x, y) => y.path.length - x.path.length)[0];

function findCycle(modules: Partial<ArchModule>[]): string[] | null {
  const uses = new Map(modules.map(m => [m.id!, m.mayUse ?? []]));
  const state = new Map<string, 'open' | 'done'>();
  const walk = (id: string, path: string[]): string[] | null => {
    if (state.get(id) === 'open') { return [...path.slice(path.indexOf(id)), id]; }
    if (state.get(id) === 'done') { return null; }
    state.set(id, 'open');
    for (const next of uses.get(id) ?? []) {
      const found = walk(next, [...path, id]);
      if (found) { return found; }
    }
    state.set(id, 'done');
    return null;
  };
  for (const id of uses.keys()) {
    const found = walk(id, []);
    if (found) { return found; }
  }
  return null;
}

// --- Imports: TypeScript/JavaScript and Python; other languages are not checked yet ---

const JS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const JS_IMPORT = /(?:^|[^\w.])(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w.])import\s*['"]([^'"]+)['"]|(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;
const PY_IMPORT = /^\s*(?:from\s+(\.*[\w.]*)\s+import\s+([\w*, ()]+)|import\s+([\w., ]+))/gm;

/** Every module specifier a JS/TS file imports, as written ("./x.ts", "node:fs", "lodash"). */
export const specifiersOf = (source: string): string[] => [...source.matchAll(JS_IMPORT)].flatMap(m => (m[1] ?? m[2] ?? m[3] ? [m[1] ?? m[2] ?? m[3]] : []));

/** Workspace files a source file imports, resolved; imports of packages are left out. */
export function importsOf(file: string, source: string, files: Set<string>): string[] {
  const out = new Set<string>();
  const dir = dirname(file);
  if (JS.test(file)) {
    for (const m of source.matchAll(JS_IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec?.startsWith('.')) { continue; }
      const base = normalize(join(dir, spec)).split('\\').join('/');
      // TypeScript code imports "./x.js" for the file x.ts
      const stem = base.replace(/\.(js|mjs|cjs|jsx)$/, '');
      const candidates = [base, ...['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs'].flatMap(ext => [stem + ext, `${base}/index${ext}`])];
      const hit = candidates.find(c => files.has(c));
      if (hit) { out.add(hit); }
    }
  } else if (file.endsWith('.py')) {
    for (const m of source.matchAll(PY_IMPORT)) {
      const names = m[1] !== undefined ? [m[1]] : (m[3] ?? '').split(',').map(s => s.trim().split(/\s+/)[0]);
      for (const name of names) {
        const hit = resolvePython(name, m[1] !== undefined ? (m[2] ?? '') : '', dir, files);
        if (hit) { out.add(hit); }
      }
    }
  }
  return [...out];
}

function resolvePython(name: string, imported: string, dir: string, files: Set<string>): string | undefined {
  const dots = name.match(/^\.*/)![0].length;
  const rest = name.slice(dots).split('.').filter(Boolean);
  // Relative imports start in the file's package; absolute ones at the root or in src/
  const roots = dots ? [dir.split('/').slice(0, dots > 1 ? -(dots - 1) : undefined).join('/')] : ['', 'src'];
  for (const root of roots) {
    const base = [root, ...rest].filter(Boolean).join('/');
    // "from pkg import mod" may name a module file rather than a symbol
    const subs = imported.replace(/[()]/g, '').split(',').map(s => s.trim().split(/\s+/)[0]).filter(s => /^\w+$/.test(s));
    for (const candidate of [...subs.map(s => `${base}/${s}.py`), `${base}.py`, `${base}/__init__.py`]) {
      if (files.has(candidate)) { return candidate; }
    }
  }
  return undefined;
}

/**
 * Every import that breaks the architecture: a module using one it may not, or reaching past
 * another module's interface. Tests, acceptance tests and files outside every module are not checked.
 */
export function checkArchitecture(workspace: string): { problems: string[]; checkedFiles: number } | null {
  const arch = readArchitecture(workspace);
  if (!arch) { return null; }
  const snapshot = takeSnapshot(workspace);
  const files = new Set(snapshot.keys());
  const problems: string[] = [];
  let checkedFiles = 0;
  for (const [file, content] of snapshot) {
    const from = owner(arch, file);
    if (!from || /^(tests|acceptance|hidden-tests)\//.test(file) || !(JS.test(file) || file.endsWith('.py'))) { continue; }
    checkedFiles++;
    for (const target of importsOf(file, content.toString('utf8'), files)) {
      const to = owner(arch, target);
      if (!to || to.id === from.id) { continue; }
      if (!from.mayUse.includes(to.id)) {
        problems.push(`${file} imports ${target}: module "${from.id}" may not use "${to.id}" (it may use: ${from.mayUse.join(', ') || 'no other module'})`);
      } else if (to.interface && target !== to.interface) {
        problems.push(`${file} imports ${target}: other modules must use "${to.id}" through ${to.interface}`);
      }
    }
  }
  return { problems, checkedFiles };
}
