import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { takeSnapshot } from '../guard/snapshot';
import type { Clause } from './requirement';

/**
 * Checks of QA's hidden tests that need no AI: every exact example the requirement gives is in
 * them, every test says which clause it checks and why, and none tests DevCrew's own files.
 *
 * Why: the JPY example was the one bug the roadmap runs shipped, twice, and QA's tests about
 * `.devcrew/acceptance.json` cost a dispute each time (R-34 on L-02, R-50 on L-01). When a hidden
 * test fails, the Builder gets its clause and QA's reason, not only a name: 4 of 11 hidden failures
 * in 99 fast runs failed again right after the Builder's fix.
 */

/** Where QA says, per test, which clause it checks and why. Hidden with the tests. */
export const WHY_FILE = 'acceptance/why.json';

export interface Example { clause: string; text: string }
export interface TestReason { test: string; clause: string; why: string }

/**
 * An exact output the requirement shows: a money amount or decimal (`¥1,235`, `KWD 1.250`), or a
 * sentence with a number (`Order SO-1001 is on its way`). Names, formulas, signatures, status codes
 * and character classes are not examples.
 */
export function isExample(span: string): boolean {
  const v = span.replace(/^(["'])(.*)\1$/, '$2').trim();
  if (!/\d/.test(v) || /[(){}<>=×÷|\\/]|--|\b[A-Za-z]-[A-Za-z]\b|\d-\d\b/.test(v)) { return false; }
  if (/[฿$¥€£₩₹]/.test(v) || /\d,\d{3}/.test(v) || /\d\.\d/.test(v)) { return true; }
  const words = v.split(/\s+/);
  return words.length >= 3 && words.some(w => /[A-Za-z]{3,}/.test(w));
}

/** The exact examples in the requirement, with the clause each comes from. */
export function requirementExamples(clauses: Clause[]): Example[] {
  const seen = new Set<string>();
  return clauses.flatMap(c => [...c.text.matchAll(/`([^`\n]{1,120})`/g)]
    .map(m => m[1].replace(/^(["'])(.*)\1$/, '$2'))
    .filter(text => isExample(text) && !seen.has(text) && seen.add(text))
    .map(text => ({ clause: c.id, text })));
}

/** The clause that says the project has no dependencies; the system checks it, not QA. */
export const noDependenciesClause = (clauses: Clause[]): Clause | undefined =>
  clauses.find(c => /\bno (?:runtime |third[- ]party |external |npm )?dependenc(?:y|ies)\b/i.test(c.text));

/** The clause starts with "No dependencies", rather than mentioning it inside a wider rule. */
export const aboutDependencies = (c: Clause) => /^no (?:runtime |third[- ]party |external |npm )?dependenc/i.test(c.text.replace(/^[^A-Za-z]+/, ''));

/** The clauses that give exact examples, for the Builder's checklist. */
export const exampleClauses = (clauses: Clause[]) => {
  const ids = new Set(requirementExamples(clauses).map(e => e.clause));
  return clauses.filter(c => ids.has(c.id));
};

/** Test files under acceptance/, as text (not why.json). */
function testFiles(dir: string): [string, string][] {
  if (!existsSync(join(dir, 'acceptance'))) { return []; }
  return [...takeSnapshot(dir)].filter(([p]) => p.startsWith('acceptance/') && p !== WHY_FILE && !p.endsWith('.json')).map(([p, b]) => [p, b.toString('utf8')]);
}

/** Test names declared in JS/TS (`test('name'`, `it("name"`) and Python (`def test_name`) files. */
export function declaredTestNames(path: string, source: string): string[] {
  if (/\.[cm]?[jt]sx?$/.test(path)) {
    return [...source.matchAll(/^\s*(?:test|it)(?:\.only)?\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/gm)].map(m => m[2].replace(/\\(['"\\])/g, '$1'));
  }
  if (/\.py$/.test(path)) { return [...source.matchAll(/^\s*(?:async\s+)?def\s+(test\w*)\s*\(/gm)].map(m => m[1]); }
  return [];
}

/** QA's reasons, by test name; empty when the file is missing or unreadable. */
export function readReasons(dir: string): TestReason[] {
  try {
    const raw = JSON.parse(readFileSync(join(dir, WHY_FILE), 'utf8'));
    return Array.isArray(raw) ? raw.filter((r): r is TestReason => r && typeof r.test === 'string' && typeof r.clause === 'string' && typeof r.why === 'string') : [];
  } catch { return []; }
}

const clauseIds = (s: string) => [...s.matchAll(/\bR-(\d+)\b/g)].map(m => `R-${m[1]}`);

/** Every problem with QA's hidden tests in `dir`, in words QA can act on. Empty = fine. */
export function acceptanceProblems(dir: string, clauses: Clause[]): string[] {
  const problems: string[] = [];
  const files = testFiles(dir);
  const all = files.map(([, t]) => t).join('\n');

  for (const [path, text] of files) {
    if (/\.devcrew\b|acceptance\.json/.test(text)) {
      problems.push(`${path} reads DevCrew's own files (.devcrew/, acceptance.json). They are how DevCrew runs the tests, not what the customer asked for: test only behaviour the requirement describes.`);
    }
  }

  const missing = requirementExamples(clauses).filter(e => !all.includes(e.text));
  if (missing.length) {
    problems.push(`These exact examples from the requirement are not asserted anywhere. Assert each one verbatim:\n${missing.map(e => `  - ${e.clause}: ${e.text}`).join('\n')}`);
  }

  const ids = new Set(clauses.map(c => c.id));
  const names = files.flatMap(([p, t]) => declaredTestNames(p, t));
  if (!existsSync(join(dir, WHY_FILE))) {
    problems.push(`${WHY_FILE} is missing: for every test, which clause it checks and why.`);
    return problems;
  }
  const reasons = readReasons(dir);
  if (!reasons.length) { problems.push(`${WHY_FILE} must be a JSON list of { "test": "<exact test name>", "clause": "R-n", "why": "..." }.`); return problems; }
  const byName = new Map(reasons.map(r => [r.test, r]));
  const unexplained = names.filter(n => !byName.has(n));
  if (unexplained.length) { problems.push(`${WHY_FILE} has no reason for: ${unexplained.slice(0, 15).map(n => `"${n}"`).join(', ')}${unexplained.length > 15 ? ` and ${unexplained.length - 15} more` : ''}.`); }
  // Only a clause that is about dependencies ("No dependencies."): in IT-01 it is part of R-1, the whole feature
  const noDeps = noDependenciesClause(clauses);
  const systemChecked = noDeps && aboutDependencies(noDeps) ? reasons.filter(r => clauseIds(r.clause).length && clauseIds(r.clause).every(id => id === noDeps.id)) : [];
  if (systemChecked.length) {
    problems.push(`${noDeps!.id} ("${noDeps!.text}") is checked by the system from package.json and the imports, so remove the tests that check only it: ${systemChecked.map(r => `"${r.test}"`).join(', ')}.`);
  }
  const bad = reasons.filter(r => !clauseIds(r.clause).length || clauseIds(r.clause).some(id => !ids.has(id)) || r.why.trim().length < 20);
  if (bad.length) {
    problems.push(`In ${WHY_FILE}, each "clause" must name requirement clauses that exist (R-1 to R-${clauses.length}) and each "why" must say in a sentence what behaviour it protects. Fix: ${bad.slice(0, 10).map(r => `"${r.test}"`).join(', ')}.`);
  }
  return problems;
}

/**
 * What the Builder is told about each failing hidden test: the clause in the customer's words and
 * QA's reason. Never the test's code or inputs: the Builder fixes the behaviour, not the test.
 */
export function failureContext(failing: string[], reasons: TestReason[], clauses: Clause[]): string {
  const byId = new Map(clauses.map(c => [c.id, c.text]));
  const lines = failing.flatMap(name => {
    const r = reasons.find(x => x.test === name) ?? reasons.find(x => name.startsWith(x.test) || x.test.startsWith(name));
    if (!r) { return []; }
    const quoted = clauseIds(r.clause).map(id => `   ${id}: ${byId.get(id) ?? '(no such clause)'}`).join('\n');
    return [`- "${name}"\n${quoted}\n   Why it matters (QA): ${r.why.trim()}`];
  });
  return lines.length ? `What each failing hidden test checks, and why:\n${lines.join('\n')}\n` : '';
}
