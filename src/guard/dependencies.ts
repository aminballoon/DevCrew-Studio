import { builtinModules } from 'node:module';
import { specifiersOf } from './architecture';
import { takeSnapshot } from './snapshot';

/**
 * A requirement that says "No dependencies", checked by the system instead of by a hidden test.
 * QA's tests for it scanned imports with hand-written regexes that read the string 'from' as an
 * import and failed correct code twice (L-01 R-49, bench why-1); this reads the declarations and
 * the import specifiers the architecture check already parses.
 *
 * Checked: package.json's dependencies, peerDependencies and optionalDependencies (devDependencies
 * are tools, not part of the library), requirements.txt and pyproject.toml's [project]
 * dependencies, and every package a JS/TS source file imports. Tests are not source: a test may
 * import a test helper. Python imports are not checked (telling a stdlib module from a package
 * needs the interpreter).
 */

const BUILTIN = new Set(builtinModules);
const JS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST = /(?:^|\/)(?:tests?|acceptance|hidden-tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** The package a bare specifier names ("lodash/fp" → "lodash", "@scope/pkg/x" → "@scope/pkg"); null for files and built-ins. */
export function packageOf(spec: string): string | null {
  if (/^[./#]/.test(spec) || (/^[a-z]+:/.test(spec) && !spec.startsWith('npm:'))) { return null; }
  const name = spec.replace(/^npm:/, '').split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');
  return BUILTIN.has(name) || BUILTIN.has(spec) ? null : name;
}

function declared(text: string, keys: string[]): string[] {
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    return keys.flatMap(k => (pkg[k] && typeof pkg[k] === 'object' ? Object.keys(pkg[k] as object).map(d => `${d} (${k})`) : []));
  } catch { return []; }
}

/** What breaks "no dependencies" in the workspace, one reason per finding; empty when nothing does. */
export function dependencyProblems(workspace: string): string[] {
  const problems: string[] = [];
  const files = takeSnapshot(workspace);
  const text = (p: string) => files.get(p)?.toString('utf8');

  const pkg = text('package.json');
  const deps = pkg ? declared(pkg, ['dependencies', 'peerDependencies', 'optionalDependencies']) : [];
  if (deps.length) { problems.push(`package.json declares ${deps.join(', ')}`); }
  const reqs = (text('requirements.txt') ?? '').split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
  if (reqs.length) { problems.push(`requirements.txt lists ${reqs.join(', ')}`); }
  const pyproject = text('pyproject.toml')?.match(/^\[project\][\s\S]*?^dependencies\s*=\s*\[([\s\S]*?)\]/m)?.[1];
  const pyDeps = pyproject?.match(/["'][^"']+["']/g) ?? [];
  if (pyDeps.length) { problems.push(`pyproject.toml lists ${pyDeps.join(', ')}`); }

  const imported = new Map<string, Set<string>>();
  for (const [path, buf] of files) {
    if (!JS.test(path) || TEST.test(path) || path.startsWith('.devcrew/') || path.endsWith('.d.ts')) { continue; }
    for (const name of specifiersOf(buf.toString('utf8')).map(packageOf)) {
      if (name) { imported.set(name, (imported.get(name) ?? new Set()).add(path)); }
    }
  }
  for (const [name, by] of imported) { problems.push(`${[...by].join(', ')} import${by.size > 1 ? '' : 's'} the package "${name}"`); }
  return problems;
}
