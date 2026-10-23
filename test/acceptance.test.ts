import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { STUDIO_ROOT } from '../src/core/config';
import { acceptanceProblems, declaredTestNames, exampleClauses, failureContext, isExample, requirementExamples } from '../src/orchestrator/acceptance';
import { requirementClauses } from '../src/orchestrator/requirement';

const task = (id: string) => requirementClauses(readFileSync(join(STUDIO_ROOT, 'bench/tasks', id, 'requirement.md'), 'utf8'));

test('an example is an exact output, not a name, formula, signature, status code or character class', () => {
  for (const yes of ['¥1,235', 'KWD 1.250', '-฿0.25', '"฿1,234.56"', 'Order SO-1001 is on its way', '$12.34 added to your store credit']) { assert.ok(isExample(yes), yes); }
  for (const no of ['SAVE10', '404', '0', 'addItem(sku: string, qty = 1)', 'net × 7 / 107', 'A-Z a-z 0-9 _ -', 'RELAY <n> 1', 'hil/serial.py --listen 10', 'Adafruit PCA9554', '89 50 4E 47']) { assert.ok(!isExample(no), no); }
});

test('the XL-07 currency examples, JPY included, are found with their clauses', () => {
  const clauses = task('XL-07-cafe-cash');
  assert.deepEqual(requirementExamples(clauses).map(e => e.text), ['฿1,234.50', '$1,234.50', '¥1,235', 'KWD 1.250', '-฿0.25']);
  assert.ok(exampleClauses(clauses).some(c => c.text === 'JPY: `¥1,235`'));
  assert.deepEqual(requirementExamples(task('S-01-cart')), []);
});

test('test names are read from JS/TS and Python files', () => {
  assert.deepEqual(declaredTestNames('a.test.ts', "test('R-1 adds', () => {});\n  it(\"R-2 \\\"quoted\\\" name\", async () => {});\ndescribe('x', () => {});"), ['R-1 adds', 'R-2 "quoted" name']);
  assert.deepEqual(declaredTestNames('test_a.py', 'def test_adds():\n    pass\nasync def test_b(x):\n'), ['test_adds', 'test_b']);
});

const clauses = requirementClauses('- `formatMoney(amount)` prints money.\n- JPY: `¥1,235`\n- Unknown currencies throw `INVALID_CONFIG`.');

function suite(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'devcrew-acc-'));
  for (const [p, t] of Object.entries(files)) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), t); }
  return dir;
}
const YEN_TEST = "test('R-2 yen has no decimals', () => assert.equal(formatMoney(1235, 'JPY'), '¥1,235'));\n";
const WHY = (extra: object[] = []) => JSON.stringify([{ test: 'R-2 yen has no decimals', clause: 'R-2', why: 'Yen has no minor unit, so amounts print with no decimals.' }, ...extra]);

test('a suite that asserts every example and explains every test passes the checks', () => {
  assert.deepEqual(acceptanceProblems(suite({ 'acceptance/a.test.ts': YEN_TEST, 'acceptance/why.json': WHY() }), clauses), []);
});

test('a missing example, a test of DevCrew files and missing or bad reasons are each reported', () => {
  const problems = acceptanceProblems(suite({
    'acceptance/a.test.ts': "test('R-2 yen', () => assert.match(formatMoney(1235, 'JPY'), /1,235$/));\ntest('R-9 runs', () => readFileSync('.devcrew/acceptance.json'));\n",
    'acceptance/why.json': JSON.stringify([{ test: 'R-2 yen', clause: 'R-7', why: 'short' }]),
  }), clauses);
  assert.equal(problems.length, 4, problems.join('\n'));
  assert.match(problems[0], /a\.test\.ts reads DevCrew's own files/);
  assert.match(problems[1], /not asserted anywhere[\s\S]*R-2: ¥1,235/);
  assert.match(problems[2], /no reason for: "R-9 runs"/);
  assert.match(problems[3], /R-1 to R-3[\s\S]*"R-2 yen"/);
  assert.deepEqual(acceptanceProblems(suite({ 'acceptance/a.test.ts': YEN_TEST }), clauses), ['acceptance/why.json is missing: for every test, which clause it checks and why.']);
});

test('the Builder is told the clause in the customer\'s words and QA\'s reason, never the test', () => {
  const reasons = JSON.parse(WHY([{ test: 'R-3 unknown currency', clause: 'R-1, R-3', why: 'Only the four store currencies exist; any other must be refused.' }]));
  const text = failureContext(['R-2 yen has no decimals', 'R-3 unknown currency', 'not explained'], reasons, clauses);
  assert.equal(text, [
    'What each failing hidden test checks, and why:',
    '- "R-2 yen has no decimals"',
    '   R-2: JPY: `¥1,235`',
    '   Why it matters (QA): Yen has no minor unit, so amounts print with no decimals.',
    '- "R-3 unknown currency"',
    '   R-1: `formatMoney(amount)` prints money.',
    '   R-3: Unknown currencies throw `INVALID_CONFIG`.',
    '   Why it matters (QA): Only the four store currencies exist; any other must be refused.',
    '',
  ].join('\n'));
  assert.equal(failureContext(['nothing known'], reasons, clauses), '');
});
