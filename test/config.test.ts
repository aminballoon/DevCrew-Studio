import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

import { STUDIO_ROOT } from '../src/core/config';

test('a relative DEVCREW_DATA is resolved from the studio root, so agents get an absolute working folder', () => {
  const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', "import('./src/core/config.ts').then(m => console.log(m.DATA_ROOT))"], {
    cwd: STUDIO_ROOT, env: { ...process.env, DEVCREW_DATA: '.devcrew-data/quiet' }, encoding: 'utf8',
  }).trim();
  assert.ok(isAbsolute(out), out);
  assert.equal(out, join(STUDIO_ROOT, '.devcrew-data/quiet'));
});
