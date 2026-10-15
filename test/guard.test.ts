import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
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

test('role scopes: the Builder cannot touch the hidden tests; QA only writes them', () => {
  const ws = '/w';
  assert.equal(isAllowed(ROLE_SCOPES.dev, ws, '/w/src/a.ts'), true);
  assert.equal(isAllowed(ROLE_SCOPES.dev, ws, '/w/tests/a.test.ts'), true);
  assert.equal(isAllowed(ROLE_SCOPES.dev, ws, '/w/acceptance/a.test.ts'), false);
  assert.equal(isAllowed(ROLE_SCOPES.dev, ws, '.devcrew/acceptance.json'), false);
  assert.equal(isAllowed(ROLE_SCOPES.dev, ws, '/elsewhere/x.ts'), false);
  assert.equal(isAllowed(ROLE_SCOPES.qa, ws, '/w/acceptance/x/a.test.ts'), true);
  assert.equal(isAllowed(ROLE_SCOPES.qa, ws, '/w/src/a.ts'), false);
  assert.equal(isAllowed(ROLE_SCOPES.reviewer, ws, '/w/.devcrew/review.md'), true);
  assert.equal(isAllowed(ROLE_SCOPES.reviewer, ws, '/w/src/a.ts'), false);
});

test('reverts out-of-scope edits, creations and deletions, keeps the rest', () => {
  const ws = workspace({ 'acceptance/a.test.ts': 'original', 'acceptance/b.test.ts': 'keep me', 'src/x.ts': 'old' });
  const before = takeSnapshot(ws);
  writeFileSync(join(ws, 'acceptance/a.test.ts'), 'weakened');
  writeFileSync(join(ws, 'acceptance/new.test.ts'), 'sneaky');
  writeFileSync(join(ws, 'acceptance/b.test.ts'), '');
  writeFileSync(join(ws, 'src/x.ts'), 'new');

  const reverted = revertOutOfScope(ws, before, ROLE_SCOPES.dev);
  assert.deepEqual(reverted, ['acceptance/a.test.ts', 'acceptance/b.test.ts', 'acceptance/new.test.ts']);
  assert.equal(readFileSync(join(ws, 'acceptance/a.test.ts'), 'utf8'), 'original');
  assert.equal(readFileSync(join(ws, 'acceptance/b.test.ts'), 'utf8'), 'keep me');
  assert.equal(existsSync(join(ws, 'acceptance/new.test.ts')), false);
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

test('verify ignores build output the test command leaves in tests/, but not a deleted test', async () => {
  const ws = workspace({ 'tests/sum.test.ts': SUM_TEST, 'src/sum.ts': 'export const sum = (a: number, b: number) => a + b;\n' });
  const baseline = captureBaseline(ws);
  // A compiled test binary written next to its source, as a C Makefile does
  writeFileSync(join(ws, 'tests/sum.bin'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const r = await verify({ workspace: ws, testCommand: 'node --test', baseline });
  assert.equal(r.passed, true, r.reasons.join('; '));

  unlinkSync(join(ws, 'tests/sum.test.ts'));
  const gone = await verify({ workspace: ws, testCommand: 'node --test', baseline });
  assert.match(gone.reasons.join(), /Locked files changed: tests\/sum.test.ts/);
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

test('a project folder inside another git repository is copied, not checked out as a worktree', async () => {
  const { execFileSync } = await import('node:child_process');
  const { prepareWorkspace } = await import('../src/guard/workspace');
  const repo = mkdtempSync(join(tmpdir(), 'devcrew-parent-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  mkdirSync(join(repo, 'demo/seed'), { recursive: true });
  writeFileSync(join(repo, 'demo/seed/app.js'), 'export const x = 1;\n');
  writeFileSync(join(repo, 'parent-only.txt'), 'not part of the project\n');
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

  const inside = prepareWorkspace(join(repo, 'demo/seed'), `inside-${Date.now()}`);
  assert.equal(inside.kind, 'copy');
  assert.ok(existsSync(join(inside.path, 'app.js')));
  assert.ok(!existsSync(join(inside.path, 'parent-only.txt')));

  const top = prepareWorkspace(repo, `top-${Date.now()}`);
  assert.equal(top.kind, 'worktree');
  g('worktree', 'remove', '--force', top.path);
});

test('Cargo build output is left alone; a target/ folder in a non-Rust project is still guarded', () => {
  const rust = mkdtempSync(join(tmpdir(), 'devcrew-guard-rust-'));
  writeFileSync(join(rust, 'Cargo.toml'), '[package]\nname = "x"\n');
  const before = takeSnapshot(rust);
  mkdirSync(join(rust, 'target/release'), { recursive: true });
  writeFileSync(join(rust, 'target/release/x'), 'binary');
  mkdirSync(join(rust, 'src'));
  writeFileSync(join(rust, 'src/lib.rs'), 'pub fn a() {}');
  assert.deepEqual(revertOutOfScope(rust, before, ROLE_SCOPES.qa), ['src/lib.rs']);
  assert.ok(existsSync(join(rust, 'target/release/x')), 'build output kept');

  const node = mkdtempSync(join(tmpdir(), 'devcrew-guard-node-'));
  const before2 = takeSnapshot(node);
  mkdirSync(join(node, 'target'));
  writeFileSync(join(node, 'target/a.ts'), 'x');
  assert.deepEqual(revertOutOfScope(node, before2, ROLE_SCOPES.qa), ['target/a.ts']);
});

test('PlatformIO build output is neither guarded, copied nor committed', async () => {
  const { execFileSync } = await import('node:child_process');
  const { commitAll, diffSince, prepareWorkspace } = await import('../src/guard/workspace');
  const seed = workspace({ 'src/main.cpp': 'int main() {}\n', '.pio/build/board/a.o': 'obj', 'lib/node_modules/p/i.js': 'dep' });
  const ws = prepareWorkspace(seed, `pio-${Date.now()}`);
  const tracked = () => execFileSync('git', ['ls-files'], { cwd: ws.path, encoding: 'utf8' }).trim().split('\n');
  assert.ok(!existsSync(join(ws.path, '.pio')), 'not copied from the seed');
  assert.deepEqual(tracked(), ['src/main.cpp']);

  // QA runs pio test: the build tree it leaves must survive the guard and stay out of git
  const before = takeSnapshot(ws.path);
  mkdirSync(join(ws.path, '.pio/build/native'), { recursive: true });
  writeFileSync(join(ws.path, '.pio/build/native/program'), 'binary');
  writeFileSync(join(ws.path, 'x.cpp'), 'out of scope');
  assert.deepEqual(revertOutOfScope(ws.path, before, ROLE_SCOPES.qa), ['x.cpp']);
  assert.ok(existsSync(join(ws.path, '.pio/build/native/program')), 'build output kept');

  writeFileSync(join(ws.path, 'src/relay.cpp'), 'void r() {}\n');
  assert.deepEqual(diffSince(ws).files.map(f => f.path), ['src/relay.cpp']);
  commitAll(ws, 'build');
  assert.deepEqual(tracked(), ['src/main.cpp', 'src/relay.cpp']);
});

test('the Builder cannot change what research roles left, such as a HIL rig it could bend to pass', async () => {
  const { builderScope } = await import('../src/orchestrator/graph');
  const { composePipeline, loadPipeline } = await import('../src/pipeline/schema');
  const ws = workspace({ 'src/x.ts': '' });
  const scope = builderScope(composePipeline(loadPipeline('fast'), ['hardware']), ws);
  assert.equal(isAllowed(scope, ws, join(ws, '.devcrew/hil/run.sh')), false);
  assert.equal(isAllowed(scope, ws, join(ws, '.devcrew/hardware/board.md')), false);
  assert.equal(isAllowed(scope, ws, join(ws, 'acceptance/a.test.ts')), false);
  assert.equal(isAllowed(scope, ws, join(ws, 'src/main.c')), true);
  assert.equal(isAllowed(builderScope(loadPipeline('fast'), ws), ws, join(ws, '.devcrew/hil/run.sh')), true, 'without research roles .devcrew/ is the Builder\'s');
});
