import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestCounts } from '../core/events';
import { parseTestOutput } from './testFormats';
import { runCommand } from './verify';

/**
 * Mutation check: change the Builder's code in one small way at a time (a `>=` made `>`, a `+`
 * made `-`, a number off by one) and run QA's hidden tests again. A change the tests still pass is
 * a mistake they would not catch. LLM-written tests catch few faulty solutions (SWE-Mutation: 36%
 * at best), and the Builder never sees them, so nothing else tells QA where they are thin.
 *
 * The operators work on the text of the line, so one set covers every language Verify reads
 * (TS/JS, Python, C/C++, Rust, Go) without a mutation tool installed in the project.
 */

export interface Mutant {
  file: string;
  /** 1-based line number. */
  line: number;
  operator: string;
  /** The line before and after the change, trimmed. */
  before: string;
  after: string;
  /** Where the change goes in the line, and what replaces it. */
  column: number;
  length: number;
  replacement: string;
}

export interface MutationResult {
  /** Mutants that could be made in the changed lines. */
  candidates: number;
  /** Mutants run against the tests (a sample, at most maxMutants). */
  tested: number;
  killed: number;
  survived: Mutant[];
  /** Sampled but not run: the time budget ran out or the run was cancelled. */
  notRun: number;
  ms: number;
  /** Why no mutant was run, when none was. */
  skipped?: string;
}

type Lang = 'js' | 'py' | 'c' | 'rs' | 'go';
const LANGS: [RegExp, Lang][] = [[/\.[cm]?[jt]sx?$/, 'js'], [/\.py$/, 'py'], [/\.(?:c|cc|cpp|cxx|h|hpp)$/, 'c'], [/\.rs$/, 'rs'], [/\.go$/, 'go']];
const langOf = (path: string): Lang | null => LANGS.find(([re]) => re.test(path))?.[1] ?? null;

/** Code the Builder writes to be judged: not tests, contracts, generated declarations or DevCrew's files. */
export function isMutable(path: string): boolean {
  if (!langOf(path) || path.endsWith('.d.ts')) { return false; }
  if (/^(?:tests?|acceptance|contracts|\.devcrew|hidden-tests)\//.test(path)) { return false; }
  return !/(?:^|\/)(?:test_[^/]*\.py|[^/]*_test\.(?:py|go)|[^/]*\.(?:test|spec)\.[cm]?[jt]sx?|conftest\.py)$/.test(path);
}

interface Operator {
  name: string; langs?: Lang[]; re: RegExp; to: (m: string) => string | null;
  /** Leave this match alone (`code` is the line with strings blanked). */
  skip?: (code: string, at: number, match: string) => boolean;
}

/** `'unknown sku ' + sku` builds a message: changing it only garbles the text. */
const nextToString = (code: string, at: number, match: string) =>
  /["'`]\s*$/.test(code.slice(0, at)) || /^\s*["'`]/.test(code.slice(at + match.length));

const swap = (pairs: Record<string, string>) => (m: string) => pairs[m] ?? null;
/** Binary operators need spaces around them, so generics (`Map<K, V>`), arrows and unary minus are left alone. */
const OPERATORS: Operator[] = [
  { name: 'boundary', re: /(?<=\s)(?:<=|>=|<|>)(?=\s)/g, to: swap({ '<=': '<', '<': '<=', '>=': '>', '>': '>=' }) },
  { name: 'equality', re: /(?<=\s)(?:===|!==|==|!=)(?=\s)/g, to: swap({ '===': '!==', '!==': '===', '==': '!=', '!=': '==' }) },
  { name: 'arithmetic', re: /(?<=\s)[-+*/%](?=\s)/g, to: swap({ '+': '-', '-': '+', '*': '/', '/': '*', '%': '*' }), skip: nextToString },
  { name: 'logical', langs: ['js', 'c', 'rs', 'go'], re: /(?<=\s)(?:&&|\|\|)(?=\s)/g, to: swap({ '&&': '||', '||': '&&' }) },
  { name: 'logical', langs: ['py'], re: /\b(?:and|or)\b/g, to: swap({ and: 'or', or: 'and' }) },
  { name: 'boolean', langs: ['js', 'c', 'rs', 'go'], re: /\b(?:true|false)\b/g, to: swap({ true: 'false', false: 'true' }) },
  { name: 'boolean', langs: ['py'], re: /\b(?:True|False)\b/g, to: swap({ True: 'False', False: 'True' }) },
  { name: 'negation', langs: ['js', 'c', 'rs', 'go'], re: /(?<![!=<>\w)\]])!(?=[\w(])/g, to: () => '' },
  { name: 'negation', langs: ['py'], re: /\bnot\s+/g, to: () => '' },
  { name: 'rounding', re: /\b(?:floor|ceil)(?=\s*\()/g, to: swap({ floor: 'ceil', ceil: 'floor' }) },
  { name: 'rounding', re: /\b(?:min|max)(?=\s*\()/g, to: swap({ min: 'max', max: 'min' }) },
  { name: 'number', re: /(?<![\w.$])\d+(?![\w.])/g, to: m => String(Number(m) + 1) },
];

/** Lines no operator touches: comments, imports, and declarations with no behaviour. */
const SKIP_LINE = /^\s*(?:\/\/|\/\*|\*|#(?!\[)|import\b|export\s+(?:\*|\{[^}]*\}\s*from)|from\s+\S+\s+import\b|#include\b|use\s|package\s|mod\s|require\s*\()/;

/** The line with string contents and trailing comments blanked, so operators never match inside them. */
function codeOnly(line: string, lang: Lang): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') { out += '  '; i++; continue; }
      if (c === quote) { quote = null; out += c; } else { out += ' '; }
      continue;
    }
    if (c === '"' || c === '`' || (c === "'" && lang !== 'rs')) { quote = c; out += c; continue; }
    if ((lang === 'py' && c === '#') || (lang !== 'py' && c === '/' && line[i + 1] === '/')) { return out + ' '.repeat(line.length - i); }
    out += c;
  }
  return out;
}

/** Every mutant the operators can make in the given lines of a file. */
export function mutantsIn(file: string, source: string, lines?: Set<number>): Mutant[] {
  const lang = langOf(file);
  if (!lang) { return []; }
  const out: Mutant[] = [];
  source.split('\n').forEach((text, i) => {
    if ((lines && !lines.has(i + 1)) || SKIP_LINE.test(text) || text.length > 400) { return; }
    const code = codeOnly(text, lang);
    for (const op of OPERATORS) {
      if (op.langs && !op.langs.includes(lang)) { continue; }
      for (const m of code.matchAll(op.re)) {
        const replacement = op.to(m[0]);
        if (replacement === null || replacement === m[0] || op.skip?.(code, m.index!, m[0])) { continue; }
        const after = text.slice(0, m.index) + replacement + text.slice(m.index! + m[0].length);
        out.push({ file, line: i + 1, operator: op.name, before: text.trim(), after: after.trim(), column: m.index!, length: m[0].length, replacement });
      }
    }
  });
  return out;
}

/** Line numbers each file gained in a unified diff (`git diff -U0` or with context). */
export function addedLines(patch: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file: string | null = null;
  let line = 0;
  for (const text of patch.split('\n')) {
    if (text.startsWith('+++ ')) { file = text.startsWith('+++ b/') ? text.slice(6) : null; continue; }
    const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (!file || text.startsWith('---')) { continue; }
    if (text.startsWith('+')) { (out.get(file) ?? out.set(file, new Set()).get(file)!).add(line++); }
    else if (!text.startsWith('-') && !text.startsWith('\\')) { line++; }
  }
  return out;
}

/** A small seeded random generator, so the same code always gets the same sample. */
function seeded(seed: string): () => number {
  let h = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * At most `max` mutants, spread over lines first and then over operators: a sample that changes
 * thirty different lines says more about the tests than thirty changes to one formula.
 */
export function sampleMutants(all: Mutant[], max: number, seed: string): Mutant[] {
  const rand = seeded(seed);
  const shuffled = all.map(m => ({ m, k: rand() })).sort((a, b) => a.k - b.k).map(x => x.m);
  const seen = new Map<string, number>();
  const ranked = shuffled.map(m => {
    const key = `${m.file}:${m.line}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return { m, n };
  });
  return ranked.sort((a, b) => a.n - b.n).slice(0, max).map(x => x.m)
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
}

export function applyMutant(source: string, m: Mutant): string {
  const lines = source.split('\n');
  const text = lines[m.line - 1];
  lines[m.line - 1] = text.slice(0, m.column) + m.replacement + text.slice(m.column + m.length);
  return lines.join('\n');
}

/** Whether a test run says every test passed (fewer than expected running counts as a failure). */
const allPassed = (code: number, timedOut: boolean, tests: TestCounts, expected: number) =>
  code === 0 && !timedOut && tests.fail === 0 && tests.total >= expected && tests.total > 0;

/**
 * Where a mutated file's original text is kept while its mutant runs. A process killed mid-check
 * leaves the mutant in the workspace; the next check (or a resumed run) puts the original back.
 */
export function restorePending(journal: string, workspace: string): void {
  if (!existsSync(journal)) { return; }
  const { file, original } = JSON.parse(readFileSync(journal, 'utf8')) as { file: string; original: string };
  writeFileSync(join(workspace, file), original);
  rmSync(journal, { force: true });
}

/**
 * Runs each mutant against the test command, one at a time, restoring the file after each.
 * Stops when the time budget runs out or `cancelled` says so; the rest count as not run.
 */
export async function runMutationCheck(opts: {
  workspace: string;
  /** Changed lines by file (from addedLines); only mutable files are touched. */
  lines: Map<string, Set<number>>;
  testCommand: string;
  testFormats?: string[];
  expectedTests: number;
  maxMutants: number;
  budgetMs: number;
  journal: string;
  cancelled?: () => boolean;
}): Promise<MutationResult> {
  const started = Date.now();
  restorePending(opts.journal, opts.workspace);
  const sources = new Map<string, string>();
  const all: Mutant[] = [];
  for (const [file, lines] of opts.lines) {
    const path = join(opts.workspace, file);
    if (!isMutable(file) || !existsSync(path)) { continue; }
    const source = readFileSync(path, 'utf8');
    if (source.includes('\u0000')) { continue; }
    sources.set(file, source);
    all.push(...mutantsIn(file, source, lines));
  }
  const empty = (skipped: string): MutationResult => ({ candidates: all.length, tested: 0, killed: 0, survived: [], notRun: 0, ms: Date.now() - started, skipped });
  if (!all.length) { return empty('No changed source lines to mutate'); }

  // The unchanged code must pass, and how long that takes sets each mutant's time limit
  const t0 = Date.now();
  const base = await runCommand(opts.testCommand, opts.workspace, Math.max(60_000, opts.budgetMs));
  const baseMs = Date.now() - t0;
  if (!allPassed(base.code, base.timedOut, parseTestOutput(base.output, opts.testFormats).tests, opts.expectedTests)) {
    return empty('The hidden tests do not pass on the unchanged code');
  }
  const perMutantMs = Math.max(15_000, baseMs * 3 + 5_000);

  const sample = sampleMutants(all, opts.maxMutants, [...sources.values()].join('\u0000'));
  const survived: Mutant[] = [];
  let killed = 0, tested = 0;
  for (const m of sample) {
    if (opts.cancelled?.() || Date.now() - started + perMutantMs > opts.budgetMs) { break; }
    const original = sources.get(m.file)!;
    const path = join(opts.workspace, m.file);
    writeFileSync(opts.journal, JSON.stringify({ file: m.file, original }));
    writeFileSync(path, applyMutant(original, m));
    try {
      const r = await runCommand(opts.testCommand, opts.workspace, perMutantMs);
      if (allPassed(r.code, r.timedOut, parseTestOutput(r.output, opts.testFormats).tests, opts.expectedTests)) { survived.push(m); } else { killed++; }
      tested++;
    } finally {
      writeFileSync(path, original);
      rmSync(opts.journal, { force: true });
    }
  }
  return { candidates: all.length, tested, killed, survived, notRun: sample.length - tested, ms: Date.now() - started };
}

/** Share of run mutants the tests caught, 0-100; null when none ran. */
export const mutationScore = (r: Pick<MutationResult, 'tested' | 'killed'>) => (r.tested ? Math.round((100 * r.killed) / r.tested) : null);
