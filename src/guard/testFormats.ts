import type { TestCounts } from '../core/events';

/**
 * Reading test results from the output of many test tools, and counting the tests a test
 * file declares, so Verify can judge projects that are not Node (Python, C/C++, embedded,
 * Rust, Go) and hardware-in-the-loop runs.
 */
export const TEST_FORMATS = ['node', 'jest', 'vitest', 'pytest', 'cargo', 'ctest', 'gtest', 'unity', 'go', 'hil', 'tap'] as const;
export type TestFormat = (typeof TEST_FORMATS)[number];

type Parser = (output: string) => TestCounts | null;

const counts = (pass: number, fail: number, skipped: number, total = pass + fail + skipped): TestCounts => ({ total, pass, fail, skipped });
const num = (s: string | undefined) => Number(s ?? 0) || 0;
/** "3 passed, 1 failed" → { passed: 3, failed: 1 } */
const tally = (text: string) => {
  const out: Record<string, number> = {};
  for (const m of text.matchAll(/(\d+)\s+([a-z]+)/gi)) { out[m[2].toLowerCase()] = (out[m[2].toLowerCase()] ?? 0) + Number(m[1]); }
  return out;
};
const lastMatch = (output: string, re: RegExp) => [...output.matchAll(re)].at(-1);
const sumMatches = (output: string, re: RegExp, pick: (m: RegExpMatchArray) => TestCounts): TestCounts | null => {
  const all = [...output.matchAll(re)].map(pick);
  return all.length ? all.reduce((a, b) => counts(a.pass + b.pass, a.fail + b.fail, a.skipped + b.skipped, a.total + b.total)) : null;
};

const PARSERS: Record<TestFormat, Parser> = {
  // node:test, spec ("ℹ pass 3") or TAP ("# pass 3") reporter
  node: output => {
    if (!/^[#ℹ]\s*tests\s+\d+/m.test(output)) { return null; }
    const read = (name: string) => num(lastMatch(output, new RegExp(`^[#ℹ]\\s*${name}\\s+(\\d+)`, 'gm'))?.[1]);
    return { total: read('tests'), pass: read('pass'), fail: read('fail'), skipped: read('skipped') + read('todo') };
  },
  // Tests:       1 failed, 1 skipped, 2 passed, 4 total
  jest: output => {
    const m = lastMatch(output, /^Tests:\s+(.+)$/gm);
    if (!m) { return null; }
    const t = tally(m[1]);
    return counts(t.passed ?? 0, t.failed ?? 0, (t.skipped ?? 0) + (t.todo ?? 0), t.total);
  },
  //       Tests  1 failed | 2 passed | 1 skipped (4)
  vitest: output => {
    const m = lastMatch(output, /^\s*Tests\s{2,}(.+?)\s*\((\d+)\)\s*$/gm);
    if (!m) { return null; }
    const t = tally(m[1]);
    return counts(t.passed ?? 0, t.failed ?? 0, (t.skipped ?? 0) + (t.todo ?? 0), Number(m[2]));
  },
  // ==== 1 failed, 3 passed, 1 skipped in 0.01s ====   or, with -q:   1 failed, 3 passed in 0.01s
  pytest: output => {
    const m = lastMatch(output, /^=*\s*((?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?)(?:, )?)+) in [\d.]+s\b.*$/gm)
      ?? lastMatch(output, /^=*\s*(no tests ran) in [\d.]+s/gm);
    if (!m) { return null; }
    const t = tally(m[1]);
    return counts((t.passed ?? 0) + (t.xfailed ?? 0) + (t.xpassed ?? 0), (t.failed ?? 0) + (t.error ?? 0) + (t.errors ?? 0), t.skipped ?? 0);
  },
  // test result: ok. 3 passed; 0 failed; 1 ignored; ...   (one line per test binary)
  cargo: output => sumMatches(output, /^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored;/gm,
    m => counts(num(m[1]), num(m[2]), num(m[3]))),
  // 75% tests passed, 1 tests failed out of 4   (skipped tests are counted as passed in the percentage)
  ctest: output => {
    const m = lastMatch(output, /(\d+)% tests passed, (\d+) tests? failed out of (\d+)/g);
    if (!m) { return null; }
    const total = num(m[3]), fail = num(m[2]);
    const skipped = (output.match(/^\s*\d+ - .+ \((?:Skipped|Not Run|Disabled)\)\s*$/gm) ?? []).length;
    return counts(Math.max(0, total - fail - skipped), fail, skipped, total);
  },
  // [==========] 5 tests from 2 test suites ran.   [  PASSED  ] 4 tests.   [  FAILED  ] 1 test, listed below:
  gtest: output => {
    const ran = [...output.matchAll(/^\[=+\] (\d+) tests? from .* ran\./gm)];
    if (!ran.length) { return null; }
    const sum = (re: RegExp) => [...output.matchAll(re)].reduce((n, m) => n + num(m[1]), 0);
    const total = ran.reduce((n, m) => n + num(m[1]), 0);
    return counts(sum(/^\[\s+PASSED\s+\] (\d+) tests?/gm), sum(/^\[\s+FAILED\s+\] (\d+) tests?, listed below/gm), sum(/^\[\s+SKIPPED\s+\] (\d+) tests?/gm), total);
  },
  // 4 Tests 1 Failures 1 Ignored   (one line per test executable)
  unity: output => sumMatches(output, /^(\d+) Tests (\d+) Failures (\d+) Ignored/gm,
    m => counts(num(m[1]) - num(m[2]) - num(m[3]), num(m[2]), num(m[3]), num(m[1]))),
  // go test -v: top-level "--- PASS: TestX" lines (subtests are indented and not counted)
  go: output => {
    const n = (word: string) => (output.match(new RegExp(`^--- ${word}: `, 'gm')) ?? []).length;
    return n('PASS') + n('FAIL') + n('SKIP') ? counts(n('PASS'), n('FAIL'), n('SKIP')) : null;
  },
  // Firmware in test mode: "HIL:PASS name", "HIL:FAIL name reason", then "HIL:DONE".
  // A run that never prints HIL:DONE (crash, hang, reset) counts as one more failure.
  hil: output => {
    const n = (word: string) => (output.match(new RegExp(`HIL:${word}\\b`, 'g')) ?? []).length;
    if (!n('PASS') && !n('FAIL') && !n('SKIP') && !n('DONE')) { return null; }
    const unfinished = n('DONE') ? 0 : 1;
    return counts(n('PASS'), n('FAIL') + unfinished, n('SKIP'));
  },
  // Any TAP producer: "1..4", "ok 1 - x", "not ok 2 - y", "ok 3 # SKIP"
  tap: output => {
    if (!/^1\.\.\d+/m.test(output)) { return null; }
    const lines = output.match(/^(?:not )?ok\b.*$/gm) ?? [];
    const skipped = lines.filter(l => /#\s*(?:SKIP|TODO)/i.test(l)).length;
    const fail = lines.filter(l => l.startsWith('not ok') && !/#\s*(?:SKIP|TODO)/i.test(l)).length;
    return counts(lines.length - fail - skipped, fail, skipped);
  },
};

/**
 * Test counts from a test command's output. With formats, every listed format is read and
 * the counts are added (for a command that runs several tools). Without, the first format
 * found in the output is used, most specific first. `format` is null when nothing was found.
 */
export function parseTestOutput(output: string, formats?: string[]): { tests: TestCounts; format: string | null } {
  const empty = counts(0, 0, 0);
  if (formats?.length) {
    const found = formats.flatMap(f => {
      const r = PARSERS[f as TestFormat]?.(output);
      return r ? [{ f, r }] : [];
    });
    if (!found.length) { return { tests: empty, format: null }; }
    const tests = found.reduce((a, { r }) => counts(a.pass + r.pass, a.fail + r.fail, a.skipped + r.skipped, a.total + r.total), empty);
    return { tests, format: found.map(x => x.f).join('+') };
  }
  for (const f of TEST_FORMATS) {
    const r = PARSERS[f](output);
    if (r) { return { tests: r, format: f }; }
  }
  return { tests: empty, format: null };
}

// --- Declared tests, counted in the files without running them ---

const DECLARED: { ext: RegExp; count: (src: string) => number }[] = [
  { ext: /\.(?:[cm]?[jt]sx?)$/, count: src => (src.match(/^\s*(?:test|it)(?:\.only)?\s*\(/gm) ?? []).length },
  { ext: /\.py$/, count: src => (src.match(/^\s*(?:async\s+)?def\s+test\w*\s*\(/gm) ?? []).length },
  {
    ext: /\.(?:c|cc|cpp|cxx|h|hpp)$/,
    count: src => {
      // GoogleTest cases, or Unity: RUN_TEST calls in a hand-written runner, else test_ functions
      const gtest = (src.match(/^\s*TEST(?:_F|_P)?\s*\(/gm) ?? []).length;
      const runs = (src.match(/\bRUN_TEST\s*\(/g) ?? []).length;
      const unity = runs || (src.match(/^\s*void\s+test_?\w*\s*\(\s*(?:void)?\s*\)\s*\{?/gm) ?? []).length;
      return gtest + unity;
    },
  },
  { ext: /\.rs$/, count: src => (src.match(/#\[(?:tokio::)?test\]/g) ?? []).length },
  { ext: /_test\.go$/, count: src => (src.match(/^func\s+Test\w*\s*\(/gm) ?? []).length },
];

/** Test cases one test file declares; 0 for files that are not tests (fixtures, helpers). */
export function declaredIn(path: string, source: string): number {
  return DECLARED.find(d => d.ext.test(path))?.count(source) ?? 0;
}
