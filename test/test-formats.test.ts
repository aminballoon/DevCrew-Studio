import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { STUDIO_ROOT } from '../src/core/config';
import { declaredIn, parseTestOutput } from '../src/guard/testFormats';
import { captureBaseline, verify } from '../src/guard/verify';

const fixture = (name: string) => readFileSync(join(STUDIO_ROOT, 'test/fixtures/test-output', `${name}.txt`), 'utf8');

test('reads real output of pytest, ctest, Unity, jest and vitest', () => {
  const cases: [string, string, { total: number; pass: number; fail: number; skipped: number }][] = [
    ['pytest', 'pytest', { total: 5, pass: 3, fail: 1, skipped: 1 }],
    ['pytest-q', 'pytest', { total: 5, pass: 3, fail: 1, skipped: 1 }],
    ['ctest', 'ctest', { total: 4, pass: 2, fail: 1, skipped: 1 }],
    ['ctest-oof', 'ctest', { total: 4, pass: 2, fail: 1, skipped: 1 }],
    ['unity', 'unity', { total: 4, pass: 2, fail: 1, skipped: 1 }],
    ['jest', 'jest', { total: 4, pass: 2, fail: 1, skipped: 1 }],
    ['vitest', 'vitest', { total: 4, pass: 2, fail: 1, skipped: 1 }],
  ];
  for (const [file, format, expected] of cases) {
    assert.deepEqual(parseTestOutput(fixture(file)), { tests: expected, format }, file);
  }
});

test('reads GoogleTest, cargo, go -v, TAP and firmware HIL lines', () => {
  const gtest = `[==========] 5 tests from 2 test suites ran. (3 ms total)\n[  PASSED  ] 3 tests.\n[  SKIPPED ] 1 test, listed below:\n[  SKIPPED ] A.b\n[  FAILED  ] 1 test, listed below:\n[  FAILED  ] A.c\n`;
  assert.deepEqual(parseTestOutput(gtest), { tests: { total: 5, pass: 3, fail: 1, skipped: 1 }, format: 'gtest' });
  const cargo = `test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out\n\ntest result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out\n`;
  assert.deepEqual(parseTestOutput(cargo), { tests: { total: 6, pass: 4, fail: 1, skipped: 1 }, format: 'cargo' });
  const go = `=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestB\n    --- PASS: TestB/sub (0.00s)\n--- FAIL: TestB (0.00s)\n--- SKIP: TestC (0.00s)\nFAIL\n`;
  assert.deepEqual(parseTestOutput(go), { tests: { total: 3, pass: 1, fail: 1, skipped: 1 }, format: 'go' });
  const tap = `TAP version 13\n1..4\nok 1 - a\nnot ok 2 - b\nok 3 - c # SKIP no board\nok 4 - d\n`;
  assert.deepEqual(parseTestOutput(tap), { tests: { total: 4, pass: 2, fail: 1, skipped: 1 }, format: 'tap' });
  const hil = `[12:00:01] boot\nHIL:PASS led_blinks\nHIL:FAIL adc_reads expected 1650 got 0\nHIL:PASS uart_echo\nHIL:DONE\n`;
  assert.deepEqual(parseTestOutput(hil), { tests: { total: 3, pass: 2, fail: 1, skipped: 0 }, format: 'hil' });
  // Firmware that crashed before HIL:DONE counts as one more failure
  assert.deepEqual(parseTestOutput('HIL:PASS led_blinks\n').tests, { total: 2, pass: 1, fail: 1, skipped: 0 });
});

test('listed formats are added up; nothing recognised means no format', () => {
  const both = `${fixture('unity')}\nHIL:PASS a\nHIL:DONE\n`;
  assert.deepEqual(parseTestOutput(both, ['unity', 'hil']), { tests: { total: 5, pass: 3, fail: 1, skipped: 1 }, format: 'unity+hil' });
  assert.deepEqual(parseTestOutput('make: *** [all] Error 1\n'), { tests: { total: 0, pass: 0, fail: 0, skipped: 0 }, format: null });
});

test('counts declared tests in every supported language', () => {
  assert.equal(declaredIn('tests/a/x.test.ts', "test('a', () => {});\nit('b', () => {});\n"), 2);
  assert.equal(declaredIn('tests/a/test_x.py', 'def test_a():\n    pass\nclass TestK:\n    def test_m(self):\n        pass\nasync def test_b():\n    pass\ndef helper():\n    pass\n'), 3);
  const unityRunner = 'void test_a(void) {}\nvoid test_b(void) {}\nint main(void) { RUN_TEST(test_a); RUN_TEST(test_b); }\n';
  assert.equal(declaredIn('tests/fw/test_x.c', unityRunner), 2, 'a Unity runner is not counted twice');
  assert.equal(declaredIn('tests/fw/test_y.c', 'void test_a(void)\n{\n}\nvoid test_b(void) {\n}\n'), 2);
  assert.equal(declaredIn('tests/a/x_test.cpp', 'TEST(A, b) {}\nTEST_F(Fix, c) {}\n'), 2);
  assert.equal(declaredIn('tests/a/x.rs', '#[test]\nfn a() {}\n#[tokio::test]\nasync fn b() {}\n#[tokio::test(flavor = "multi_thread", worker_threads = 4)]\nasync fn c() {}\n'), 3);
  assert.equal(declaredIn('tests/a/x_test.go', 'func TestA(t *testing.T) {}\nfunc helper() {}\n'), 1);
  assert.equal(declaredIn('tests/a/data.json', '{"test": 1}'), 0);
});

test('Verify judges a non-Node project from a real command: TAP from a shell script, HIL lines from a fake board', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'devcrew-fmt-'));
  mkdirSync(join(ws, 'tests/fw'), { recursive: true });
  writeFileSync(join(ws, 'tests/fw/test_board.py'), 'def test_led():\n    pass\ndef test_uart():\n    pass\n');
  const baseline = captureBaseline(ws);
  assert.equal(baseline.declared, 2);

  const board = (lines: string) => `printf '${lines}'`;
  const ok = await verify({ workspace: ws, testCommand: board('boot\\nHIL:PASS led\\nHIL:PASS uart\\nHIL:DONE\\n'), baseline, testFormats: ['hil'] });
  assert.equal(ok.passed, true, ok.reasons.join('; '));
  assert.equal(ok.format, 'hil');

  const crashed = await verify({ workspace: ws, testCommand: board('HIL:PASS led\\n'), baseline, testFormats: ['hil'] });
  assert.equal(crashed.passed, false);
  assert.match(crashed.reasons.join(), /1 of 2 tests failed/);

  const tap = await verify({ workspace: ws, testCommand: board('1..2\\nok 1 - led\\nnot ok 2 - uart\\n'), baseline });
  assert.equal(tap.format, 'tap');
  assert.match(tap.reasons.join(), /1 of 2 tests failed/);

  const nothing = await verify({ workspace: ws, testCommand: 'echo build failed; exit 2', baseline });
  assert.match(nothing.reasons.join(), /No test results found in the output/);
});

test('reads the per-case lines of pio test as Unity results', () => {
  const pio = 'Testing...\ntests/core/test_a.cpp:20: test_one\t[PASSED]\ntests/core/test_a.cpp:21: test_two\t[FAILED]\ntests/core/test_a.cpp:22: test_three\t[IGNORED]\ntests/core/test_a.cpp:23: test_four\t[PASSED]\n=== 4 test cases: 1 failed, 1 ignored, 2 succeeded in 00:00:01.2 ===\n';
  assert.deepEqual(parseTestOutput(pio, ['unity', 'hil']), { tests: { total: 4, pass: 2, fail: 1, skipped: 1 }, format: 'unity' });
  assert.deepEqual(parseTestOutput(pio), { tests: { total: 4, pass: 2, fail: 1, skipped: 1 }, format: 'unity' });
});

test('failing test names are read from every tool, so blind QA spots the same failure twice', async () => {
  const { failingTests } = await import('../src/orchestrator/graph');
  assert.deepEqual(failingTests('✖ adds (1.2ms)\n✖ failing tests:\n'), ['adds']);
  assert.deepEqual(failingTests('FAILED tests/a/test_x.py::test_limit - AssertionError\n'), ['tests/a/test_x.py::test_limit']);
  assert.deepEqual(failingTests('tests/p/test_p/t.cpp:12: test_parse: Expected 1 Was 0\t[FAILED]\n'), ['tests/p/test_p/t.cpp:12: test_parse']);
  assert.deepEqual(failingTests('HIL:FAIL board/test_b.py::test_ack: expected ACK\nHIL:DONE\n'), ['board/test_b.py::test_ack']);
  assert.deepEqual(failingTests('test frames::crc ... FAILED\n--- FAIL: TestX (0.00s)\nnot ok 2 - rejects\n'), ['frames::crc', 'TestX', 'rejects']);
});

test('node TAP with suites counts the tests inside them, not the describe blocks', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: bookings',
    '    # Subtest: R-1: a booking is created',
    '    ok 1 - R-1: a booking is created',
    '    # Subtest: R-2: overlaps are refused',
    '    not ok 2 - R-2: overlaps are refused',
    '    1..2',
    'not ok 1 - bookings',
    '# Subtest: rooms',
    '    ok 1 - R-3: rooms are listed # SKIP',
    '    1..1',
    'ok 2 - rooms',
    '1..2',
    '# tests 3', '# suites 2', '# pass 1', '# fail 1', '# cancelled 0', '# skipped 1', '# todo 0',
  ].join('\n');
  assert.deepEqual(parseTestOutput(tap, ['tap']).tests, { total: 3, pass: 1, fail: 1, skipped: 1 });
  // Any other TAP producer is still counted line by line
  assert.deepEqual(parseTestOutput('1..3\nok 1 - a\nnot ok 2 - b\nok 3 - c # SKIP\n', ['tap']).tests, { total: 3, pass: 1, fail: 1, skipped: 1 });
});
