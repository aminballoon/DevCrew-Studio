import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { filesFor, readPlan } from '../src/orchestrator/plan';
import { requirementClauses } from '../src/orchestrator/requirement';

function withPlan(plan: unknown): string {
  const ws = mkdtempSync(join(tmpdir(), 'devcrew-plan-'));
  mkdirSync(join(ws, '.devcrew'));
  writeFileSync(join(ws, '.devcrew/plan.json'), JSON.stringify(plan));
  return ws;
}

const modules = [{ id: 'core', title: 'Core', description: '' }, { id: 'extras', title: 'Extras', description: '' }];

test('a plan without an architecture is sent back to the planner', () => {
  assert.throws(() => readPlan(withPlan({ modules })), /no architecture\.files/);
});

test('every planned file needs a purpose', () => {
  const ws = withPlan({ modules, architecture: { files: [{ path: 'src/a.ts', kind: 'source' }] } });
  assert.throws(() => readPlan(ws), /without a purpose: src\/a\.ts/);
});

test('architecture files are normalised and can be picked per module', () => {
  const plan = readPlan(withPlan({
    modules,
    architecture: {
      files: [
        { path: './contracts/api.d.ts', kind: 'contract', purpose: 'Shape', modules: [] },
        { path: 'src/core.ts', kind: 'source', purpose: 'Core logic', module: 'core', dependsOn: ['./contracts/api.d.ts'] },
        { path: 'src/extras.ts', kind: 'source', purpose: 'Extras', modules: ['extras', 'unknown-module'] },
        { path: 'tests/core/core.test.ts', kind: 'weird', purpose: 'Checks core', modules: ['core'] },
      ],
    },
  }));
  assert.equal(plan.architecture[0].path, 'contracts/api.d.ts');
  assert.deepEqual(plan.architecture[1].dependsOn, ['contracts/api.d.ts']);
  assert.deepEqual(plan.architecture[2].modules, ['extras']);
  assert.equal(plan.architecture[3].kind, 'source', 'unknown kinds fall back to source');
  assert.deepEqual(filesFor(plan, 'core', ['source']).map(f => f.path), ['src/core.ts', 'tests/core/core.test.ts']);
  assert.deepEqual(filesFor(plan, 'extras', ['contract']).map(f => f.path), ['contracts/api.d.ts'], 'shared files count for every module');
});

test('every requirement clause must be covered by acceptance criteria that exist in the PRD', () => {
  const clauses = requirementClauses('- `title` is trimmed and must be 1 to 100 characters.\n- Overlap throws `ConflictError`.\n- Booking ids are unique strings.');
  const architecture = { files: [{ path: 'src/a.ts', kind: 'source', purpose: 'All of it' }] };
  const ws = withPlan({ modules, architecture });
  writeFileSync(join(ws, '.devcrew/PRD.md'), '- **AC-1**: title rules\n- **AC-2**: overlap\n');
  assert.throws(() => readPlan(ws, clauses), /no "coverage"/);
  writeFileSync(join(ws, '.devcrew/plan.json'), JSON.stringify({ modules, architecture, coverage: { 'R-1': ['AC-1'], 'R-2': ['AC-2', 'AC-9'] } }));
  assert.throws(() => readPlan(ws, clauses), /no acceptance criterion in PRD\.md: R-3; acceptance criteria not found in PRD\.md: AC-9/);
  writeFileSync(join(ws, '.devcrew/plan.json'), JSON.stringify({ modules, architecture, coverage: { 'R-1': ['AC-1'], 'R-2': ['AC-2'], 'R-3': ['AC-2'] } }));
  assert.deepEqual(readPlan(ws, clauses).coverage, { 'R-1': ['AC-1'], 'R-2': ['AC-2'], 'R-3': ['AC-2'] });
  // Without clauses (old callers) coverage is not required
  assert.equal(readPlan(withPlan({ modules, architecture })).coverage, undefined);
});
