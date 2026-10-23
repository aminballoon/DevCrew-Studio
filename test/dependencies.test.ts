import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dependencyProblems, packageOf } from '../src/guard/dependencies';

test('a bare specifier names a package; files, built-ins and node: imports do not', () => {
  assert.deepEqual(['lodash', 'lodash/fp', '@scope/pkg/sub', 'npm:left-pad'].map(packageOf), ['lodash', 'lodash', '@scope/pkg', 'left-pad']);
  for (const none of ['./x.ts', '../y.js', '#internal', 'node:fs', 'fs', 'fs/promises', 'crypto', 'node:test']) { assert.equal(packageOf(none), null, none); }
});

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'devcrew-deps-'));
  for (const [p, t] of Object.entries(files)) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), t); }
  return dir;
}

test('declared runtime dependencies and packages imported by source files are reported; tools and tests are not', () => {
  const problems = dependencyProblems(workspace({
    'package.json': JSON.stringify({ dependencies: { lodash: '^4' }, devDependencies: { typescript: '^5' } }),
    'src/a.ts': "import { readFileSync } from 'node:fs';\nimport { join } from 'path';\nimport { b } from './b.ts';\nimport _ from 'lodash/fp';\nexport const word = 'from';\nconst said = \"import it from the shop\";\n",
    'src/b.ts': "export { z } from '@scope/zod/v4';\nconst lazy = () => import('chalk');\n",
    'tests/a.test.ts': "import { test } from 'node:test';\nimport sinon from 'sinon';\n",
    'acceptance/a.test.ts': "import fc from 'fast-check';\n",
    'requirements.txt': '# none\nrequests==2.32\n',
    'pyproject.toml': '[project]\nname = "x"\ndependencies = ["httpx>=0.27"]\n',
  }));
  assert.deepEqual(problems, [
    'package.json declares lodash (dependencies)',
    'requirements.txt lists requests==2.32',
    'pyproject.toml lists "httpx>=0.27"',
    'src/a.ts imports the package "lodash"',
    'src/b.ts imports the package "@scope/zod"',
    'src/b.ts imports the package "chalk"',
  ]);
});

test('a project with only relative and built-in imports and only dev tools has no problems', () => {
  assert.deepEqual(dependencyProblems(workspace({
    'package.json': JSON.stringify({ name: 'x', scripts: { test: 'node --test' }, devDependencies: { '@types/node': '^22' } }),
    'src/index.ts': "import { createHash } from 'node:crypto';\nexport * from './money/index.ts';\n",
    'src/money/index.ts': "export const from = (s: string) => s; // 'from' is just a word here\n",
  })), []);
});
