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
  assert.equal(declaredIn('tests/a/x.rs', '#[test]\nfn a() {}\n#[tokio::test]\nasync fn b() {}\n'), 2);
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
