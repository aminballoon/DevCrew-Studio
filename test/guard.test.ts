import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isAllowed, ROLE_SCOPES } from '../src/core/scope';
import { revertOutOfScope, takeSnapshot } from '../src/guard/snapshot';
import { captureBaseline, countDeclaredTests, parseTestCounts, verify } from '../src/guard/verify';

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'devcrew-test-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

test('parses node:test counts from spec output, with or without colors', () => {
  const plain = 'ℹ tests 5\nℹ suites 0\nℹ pass 4\nℹ fail 1\nℹ skipped 0\nℹ todo 0\n';
  const colored = '\x1b[34mℹ tests 5\x1b[39m\n\x1b[34mℹ pass 4\x1b[39m\n\x1b[34mℹ fail 1\x1b[39m\n';
  assert.deepEqual(parseTestCounts(plain), { total: 5, pass: 4, fail: 1, skipped: 0 });
  assert.deepEqual(parseTestCounts(colored), { total: 5, pass: 4, fail: 1, skipped: 0 });
  assert.deepEqual(parseTestCounts('# tests 2\n# pass 2\n# fail 0\n# skipped 1\n'), { total: 2, pass: 2, fail: 0, skipped: 1 });
});

test('role scopes: dev cannot touch tests, contracts or .devcrew; qa only tests', () => {
  const ws = '/w';
  assert.equal(isAllowed(ROLE_SCOPES.dev, ws, '/w/src/a.ts'), true);
  assert.equal(isAllowed(ROLE_SCOPES.dev, ws, '/w/tests/a.test.ts'), false);
  assert.equal(isAllowed(ROLE_SCOPES.dev, ws, 'contracts/api.yaml'), false);
  assert.equal(isAllowed(ROLE_SCOPES.dev, ws, '/w/.devcrew/plan.json'), false);
  assert.equal(isAllowed(ROLE_SCOPES.dev, ws, '/elsewhere/x.ts'), false);
  assert.equal(isAllowed(ROLE_SCOPES.qa, ws, '/w/tests/x/a.test.ts'), true);
  assert.equal(isAllowed(ROLE_SCOPES.qa, ws, '/w/src/a.ts'), false);
  assert.equal(isAllowed(ROLE_SCOPES.reviewer, ws, '/w/.devcrew/review.md'), true);
  assert.equal(isAllowed(ROLE_SCOPES.reviewer, ws, '/w/.devcrew/PRD.md'), false);
});

test('reverts out-of-scope edits, creations and deletions, keeps the rest', () => {
  const ws = workspace({ 'tests/a.test.ts': 'original', 'tests/b.test.ts': 'keep me', 'src/x.ts': 'old' });
  const before = takeSnapshot(ws);
  writeFileSync(join(ws, 'tests/a.test.ts'), 'weakened');
  writeFileSync(join(ws, 'tests/new.test.ts'), 'sneaky');
  writeFileSync(join(ws, 'tests/b.test.ts'), '');
  writeFileSync(join(ws, 'src/x.ts'), 'new');

  const reverted = revertOutOfScope(ws, before, ROLE_SCOPES.dev);
  assert.deepEqual(reverted, ['tests/a.test.ts', 'tests/b.test.ts', 'tests/new.test.ts']);
  assert.equal(readFileSync(join(ws, 'tests/a.test.ts'), 'utf8'), 'original');
  assert.equal(readFileSync(join(ws, 'tests/b.test.ts'), 'utf8'), 'keep me');
  assert.equal(existsSync(join(ws, 'tests/new.test.ts')), false);
  assert.equal(readFileSync(join(ws, 'src/x.ts'), 'utf8'), 'new');
});

const SUM_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sum } from '../src/sum.ts';
test('adds', () => assert.equal(sum(1, 2), 3));
test('adds negatives', () => assert.equal(sum(-1, -2), -3));
`;

test('verify passes only when every declared test runs and passes', async () => {
  const ws = workspace({ 'tests/sum.test.ts': SUM_TEST, 'src/sum.ts': 'export const sum = (a: number, b: number) => a + b;\n' });
  assert.equal(countDeclaredTests(ws), 2);
  const baseline = captureBaseline(ws);
  const ok = await verify({ workspace: ws, testCommand: 'node --test', baseline });
  assert.equal(ok.passed, true, ok.reasons.join('; '));
  assert.deepEqual(ok.tests, { total: 2, pass: 2, fail: 0, skipped: 0 });

  writeFileSync(join(ws, 'src/sum.ts'), 'export const sum = (a: number, b: number) => a - b;\n');
  const bad = await verify({ workspace: ws, testCommand: 'node --test', baseline });
  assert.equal(bad.passed, false);
  assert.match(bad.reasons.join(), /tests failed/);
});

test('verify fails when locked tests were changed, even if everything passes', async () => {
  const ws = workspace({ 'tests/sum.test.ts': SUM_TEST, 'src/sum.ts': 'export const sum = (a: number, b: number) => a + b;\n' });
  const baseline = captureBaseline(ws);
  writeFileSync(join(ws, 'tests/sum.test.ts'), SUM_TEST.replace("test('adds negatives'", "test.skip('adds negatives'"));
  const r = await verify({ workspace: ws, testCommand: 'node --test', baseline });
  assert.equal(r.passed, false);
  assert.match(r.reasons.join(), /Locked files changed: tests\/sum.test.ts/);
});

test('verify ignores FORCE_COLOR in the environment', async () => {
  const ws = workspace({ 'tests/sum.test.ts': SUM_TEST, 'src/sum.ts': 'export const sum = (a: number, b: number) => a + b;\n' });
  const saved = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = '1';
  try {
    const r = await verify({ workspace: ws, testCommand: 'node --test', baseline: captureBaseline(ws) });
    assert.equal(r.passed, true, r.reasons.join('; '));
  } finally {
    if (saved === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = saved;
  }
});
