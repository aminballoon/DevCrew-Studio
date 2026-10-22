import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addedLines, applyMutant, isMutable, mutantsIn, restorePending, runMutationCheck, sampleMutants } from '../src/guard/mutation';

const changes = (m: { before: string; after: string }) => `${m.before} => ${m.after}`;

test('mutants change code, never comments, strings, imports, generics or message text', () => {
  const src = [
    "import { x } from './x.ts';",
    '// if (a >= b) return 1;',
    'const m = new Map<string, number>();',
    "const s = 'a >= b and 1 + 2';",
    "if (!ok) throw new Error('bad price ' + price);",
    'export const adult = (age: number) => age >= 18 && !banned(age); // age + 1',
    'const f = (x: number) => x > 0;',
  ].join('\n');
  const all = mutantsIn('src/a.ts', src).map(changes);
  assert.deepEqual(all, [
    "if (!ok) throw new Error('bad price ' + price); => if (ok) throw new Error('bad price ' + price);",
    'export const adult = (age: number) => age >= 18 && !banned(age); // age + 1 => export const adult = (age: number) => age > 18 && !banned(age); // age + 1',
    'export const adult = (age: number) => age >= 18 && !banned(age); // age + 1 => export const adult = (age: number) => age >= 18 || !banned(age); // age + 1',
    'export const adult = (age: number) => age >= 18 && !banned(age); // age + 1 => export const adult = (age: number) => age >= 18 && banned(age); // age + 1',
    'export const adult = (age: number) => age >= 18 && !banned(age); // age + 1 => export const adult = (age: number) => age >= 19 && !banned(age); // age + 1',
    'const f = (x: number) => x > 0; => const f = (x: number) => x >= 0;',
    'const f = (x: number) => x > 0; => const f = (x: number) => x > 1;',
  ]);
});

test('Python, C and Rust get their own operators', () => {
  assert.deepEqual(mutantsIn('app/p.py', 'if not ok and n > 2:  # n > 3\n    return True').map(changes), [
    'if not ok and n > 2:  # n > 3 => if not ok and n >= 2:  # n > 3',
    'if not ok and n > 2:  # n > 3 => if not ok or n > 2:  # n > 3',
    'if not ok and n > 2:  # n > 3 => if ok and n > 2:  # n > 3',
    'if not ok and n > 2:  # n > 3 => if not ok and n > 3:  # n > 3',
    'return True => return False',
  ]);
  assert.deepEqual(mutantsIn('src/a.c', '#include <stdio.h>\nint a = floor(x / 2);').map(m => m.after), ['int a = floor(x * 2);', 'int a = ceil(x / 2);', 'int a = floor(x / 3);']);
  // A macro's "!" is not a negation; a lifetime quote is not a string
  assert.deepEqual(mutantsIn('src/a.rs', "fn f<'a>(x: &'a str) { println!(\"{}\", x.len() - 1); }").map(m => m.after),
    ["fn f<'a>(x: &'a str) { println!(\"{}\", x.len() + 1); }", "fn f<'a>(x: &'a str) { println!(\"{}\", x.len() - 2); }"]);
});

test('only source files the Builder writes are mutated', () => {
  for (const p of ['src/cart.ts', 'app/models.py', 'lib/x.go', 'src/main.cpp']) { assert.ok(isMutable(p), p); }
  for (const p of ['tests/cart.test.ts', 'acceptance/a.test.ts', 'contracts/cart.d.ts', 'src/cart.test.ts', 'app/test_models.py', 'lib/x_test.go', 'README.md', '.devcrew/test.json', 'conftest.py']) {
    assert.ok(!isMutable(p), p);
  }
});

test('added lines are read from a diff, for new and changed files', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -3,3 +3,4 @@ x',
    ' keep',
    '-old',
    '+new1',
    '+new2',
    ' keep',
    'diff --git a/src/b.ts b/src/b.ts',
    '--- /dev/null',
    '+++ b/src/b.ts',
    '@@ -0,0 +1,2 @@',
    '+one',
    '+two',
    'diff --git a/gone.ts b/gone.ts',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
  ].join('\n');
  assert.deepEqual([...addedLines(patch)].map(([f, l]) => [f, [...l]]), [['src/a.ts', [4, 5]], ['src/b.ts', [1, 2]]]);
});

test('the sample is the same for the same code and covers different lines first', () => {
  const src = Array.from({ length: 20 }, (_, i) => `const v${i} = a >= ${i} && b < ${i};`).join('\n');
  const all = mutantsIn('src/a.ts', src);
  const one = sampleMutants(all, 20, src);
  assert.deepEqual(sampleMutants(all, 20, src), one);
  assert.equal(new Set(one.map(m => m.line)).size, 20, 'one mutant per line before a second on any line');
  assert.equal(applyMutant('a\nx >= 1\nb', { ...all[0], line: 2, column: 2, length: 2, replacement: '>' }), 'a\nx > 1\nb');
});

function project(code: string, tests: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'devcrew-mut-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'acceptance'));
  writeFileSync(join(dir, 'src/age.ts'), code);
  writeFileSync(join(dir, 'acceptance/age.test.ts'), tests);
  return dir;
}

const AGE = 'export const adult = (age: number): boolean => age >= 18;\n';
const run = (dir: string, extra: Partial<Parameters<typeof runMutationCheck>[0]> = {}) => runMutationCheck({
  workspace: dir, lines: new Map([['src/age.ts', new Set([1])]]), testCommand: 'node --test "acceptance/**/*.test.ts"',
  expectedTests: 1, maxMutants: 10, budgetMs: 60_000, journal: join(dir, 'journal.json'), ...extra,
});

test('a boundary the tests never try survives; one they try is caught; the file is put back', { timeout: 60_000 }, async () => {
  const weak = project(AGE, "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { adult } from '../src/age.ts';\ntest('R-1', () => { assert.equal(adult(30), true); assert.equal(adult(5), false); });\n");
  const r = await run(weak);
  assert.equal(r.tested, 2);
  assert.deepEqual(r.survived.map(m => m.after), ['export const adult = (age: number): boolean => age > 18;', 'export const adult = (age: number): boolean => age >= 19;']);
  assert.equal(readFileSync(join(weak, 'src/age.ts'), 'utf8'), AGE);
  assert.ok(!existsSync(join(weak, 'journal.json')));

  const strong = project(AGE, "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { adult } from '../src/age.ts';\ntest('R-1', () => { assert.equal(adult(18), true); assert.equal(adult(17), false); });\n");
  const s = await run(strong);
  assert.deepEqual([s.tested, s.killed, s.survived.length], [2, 2, 0]);
});

test('no check when the tests fail on the unchanged code, and a mutant left by a crash is put back first', { timeout: 60_000 }, async () => {
  const dir = project(AGE, "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('R-1', () => assert.fail('nope'));\n");
  writeFileSync(join(dir, 'journal.json'), JSON.stringify({ file: 'src/age.ts', original: AGE }));
  writeFileSync(join(dir, 'src/age.ts'), AGE.replace('>=', '>'));
  const r = await run(dir);
  assert.equal(r.skipped, 'The hidden tests do not pass on the unchanged code');
  assert.equal(readFileSync(join(dir, 'src/age.ts'), 'utf8'), AGE);
  restorePending(join(dir, 'journal.json'), dir);
});
