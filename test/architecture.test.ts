import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkArchitecture, importsOf, readArchitecture } from '../src/guard/architecture';

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'devcrew-arch-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const CAFE = JSON.stringify({
  modules: [
    { id: 'api', path: 'src/api/', purpose: 'HTTP handlers', mayUse: ['pricing', 'money'] },
    { id: 'pricing', path: 'src/pricing/', purpose: 'Totals', mayUse: ['rules', 'money'], interface: 'src/pricing/index.ts' },
    { id: 'rules', path: 'src/rules/', purpose: 'One file per rule', mayUse: ['money'] },
    { id: 'money', path: 'src/money.ts', purpose: 'Satang and rounding', mayUse: [] },
  ],
  decisions: [{ id: 'ADR-1', title: 'Integer satang', decision: 'Money is integer satang', why: 'No float drift' }],
});

test('TypeScript: a module using one it may not, or reaching past an interface, is reported', () => {
  const ws = workspace({
    '.devcrew/architecture.json': CAFE,
    'src/money.ts': 'export const round = (n: number) => n;',
    'src/rules/tax.ts': "import { round } from '../money.js';\nimport { handler } from '../api/handler.ts';\nexport const tax = 1;",
    'src/pricing/index.ts': "export * from './total.ts';",
    'src/pricing/total.ts': "import { tax } from '../rules/tax';\nexport const total = tax;",
    'src/api/handler.ts': "import { total } from '../pricing/total.ts';\nimport { total as t2 } from '../pricing/index.ts';\nimport express from 'express';\nexport const handler = () => total + t2;",
    'tests/anything.test.ts': "import { tax } from '../src/rules/tax.ts';",
  });
  const result = checkArchitecture(ws)!;
  assert.deepEqual(result.problems.sort(), [
    'src/api/handler.ts imports src/pricing/total.ts: other modules must use "pricing" through src/pricing/index.ts',
    'src/rules/tax.ts imports src/api/handler.ts: module "rules" may not use "api" (it may use: money)',
  ]);
  assert.equal(result.checkedFiles, 5, 'tests are not checked');
});

test('Python: absolute, relative and "from package import module" imports are resolved', () => {
  const files = new Set(['app/rules/tax.py', 'app/api/views.py', 'app/money.py', 'app/rules/__init__.py']);
  assert.deepEqual(importsOf('app/rules/tax.py', 'from app.api.views import handle\nfrom ..money import round_half_up\nimport os', files).sort(), ['app/api/views.py', 'app/money.py']);
  assert.deepEqual(importsOf('app/api/views.py', 'from app import money\nfrom . import nothing', files), ['app/money.py']);
  const ws = workspace({
    '.devcrew/architecture.json': JSON.stringify({ modules: [
      { id: 'api', path: 'app/api/', purpose: 'Views', mayUse: ['rules'] },
      { id: 'rules', path: 'app/rules/', purpose: 'Rules', mayUse: [] },
    ], decisions: [] }),
    'app/rules/tax.py': 'from app.api.views import handle\n',
    'app/api/views.py': 'from app.rules.tax import tax\n',
  });
  assert.deepEqual(checkArchitecture(ws)!.problems, ['app/rules/tax.py imports app/api/views.py: module "rules" may not use "api" (it may use: no other module)']);
});

test('no architecture file means nothing to check; a broken one is explained', () => {
  assert.equal(checkArchitecture(workspace({ 'src/a.ts': '' })), null);
  const bad = workspace({ '.devcrew/architecture.json': JSON.stringify({ modules: [
    { id: 'a', path: 'src/a/', purpose: 'A', mayUse: ['b'] },
    { id: 'b', path: 'src/b/', purpose: 'B', mayUse: ['a', 'zzz'] },
  ] }) });
  assert.throws(() => readArchitecture(bad), /unknown module "zzz".*cycle: a → b → a|cycle/);
});
