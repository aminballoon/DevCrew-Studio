import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { STUDIO_ROOT } from '../src/core/config';
import { validatePipeline, type PipelineDef } from '../src/pipeline/schema';

const read = (id: string) => JSON.parse(readFileSync(join(STUDIO_ROOT, 'pipelines', `${id}.json`), 'utf8')) as PipelineDef;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test('every shipped pipeline is valid', () => {
  for (const f of readdirSync(join(STUDIO_ROOT, 'pipelines')).filter(f => f.endsWith('.json'))) {
    assert.deepEqual(validatePipeline(read(f.replace('.json', ''))), [], f);
  }
});

test('you must review the plan first and the code last', () => {
  const noPlanGate = clone(read('standard'));
  noPlanGate.steps.splice(1, 1);
  assert.match(validatePipeline(noPlanGate).join('\n'), /right after the planner must be a gate/);

  const noCodeGate = clone(read('standard'));
  noCodeGate.steps.pop();
  assert.match(validatePipeline(noCodeGate).join('\n'), /last step must be a gate with "review": "code"/);
});

test('extra roles cannot touch locked files or write everywhere', () => {
  const def = clone(read('with-security'));
  const security = def.steps.find(s => s.id === 'security')!;
  if (security.type !== 'agent') throw new Error('expected agent');
  security.mayWrite = ['tests/', '*'];
  const errors = validatePipeline(def).join('\n');
  assert.match(errors, /may not write "tests\/"/);
  assert.match(errors, /cannot be everything/);
});

test('only steps after build may send work back to Dev, and loops are capped', () => {
  const def = clone(read('with-security'));
  const security = def.steps.splice(def.steps.findIndex(s => s.id === 'security'), 1)[0];
  def.steps.splice(2, 0, security); // before qa and build
  if (security.type !== 'agent') throw new Error('expected agent');
  security.verdict!.maxRounds = 9;
  const errors = validatePipeline(def).join('\n');
  assert.match(errors, /only steps after "build" can send work back to Dev/);
  assert.match(errors, /maxRounds" must be a whole number from 1 to 5/);
});

test('built-in steps appear exactly once, ids are unique and not reserved', () => {
  const def = clone(read('standard'));
  def.steps.push({ type: 'qa', id: 'qa' });
  def.steps.push({ ...def.steps[4], id: 'dev' } as PipelineDef['steps'][number]);
  const errors = validatePipeline(def).join('\n');
  assert.match(errors, /exactly one "qa" step/);
  assert.match(errors, /"dev" is reserved/);
});

test('roles before the planner only write notes under .devcrew/, and no gate comes before it', () => {
  const def = clone(read('standard'));
  def.steps.unshift(
    { type: 'agent', id: 'research', name: 'Researcher', purpose: 'Finds facts first.', instructions: 'Read the workspace and write what you find.', reads: [], mayWrite: ['src/'], produces: [] },
    { type: 'gate', id: 'gate_early', title: 'Too early', review: 'plan', reviseTo: 'research' },
  );
  const errors = validatePipeline(def).join('\n');
  assert.match(errors, /before the planner may only write under \.devcrew\//);
  assert.match(errors, /only agent steps may come before the planner/);

  def.steps.splice(1, 1);
  (def.steps[0] as { mayWrite: string[] }).mayWrite = ['.devcrew/research.md'];
  assert.deepEqual(validatePipeline(def), []);
});

test('a design pipeline has no code steps and ends with a design gate', () => {
  const agent: PipelineDef['steps'][number] = { type: 'agent', id: 'architect', name: 'Architect', purpose: 'Draws the system.', instructions: 'Draw the system architecture diagram.', reads: [], mayWrite: ['.devcrew/system.json'], produces: [] };
  const ok: PipelineDef = { id: 'design-test', name: 'Design', description: 'Design only.', kind: 'design', steps: [agent, { type: 'gate', id: 'gate_final', title: 'Approve the design', review: 'design', reviseTo: 'architect' }] };
  assert.deepEqual(validatePipeline(ok), []);

  const withCode = clone(ok);
  withCode.steps.unshift({ type: 'planner', id: 'planner' });
  assert.match(validatePipeline(withCode).join('\n'), /design pipeline has no "planner" step/);

  const wrongGate = clone(ok);
  (wrongGate.steps[1] as { review: string }).review = 'code';
  assert.match(validatePipeline(wrongGate).join('\n'), /last step must be a gate with "review": "design"/);

  const designInBuild = clone(read('standard'));
  (designInBuild.steps[1] as { review: string }).review = 'design';
  assert.match(validatePipeline(designInBuild).join('\n'), /"review" must be "plan" or "code"/);
});

test('every draft pipeline is valid', () => {
  const dir = join(STUDIO_ROOT, 'pipelines', 'drafts');
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.review.json'))) {
    assert.deepEqual(validatePipeline(JSON.parse(readFileSync(join(dir, f), 'utf8'))), [], f);
  }
});

test('a profile entry for a step overrides the agent the pipeline names', async () => {
  const { agentForTurn } = await import('../src/orchestrator/runtime');
  const cfg = {
    agents: { claude: { command: 'x' }, codex: { command: 'y' }, fake: { command: 'z' } },
    profiles: { mixed: { planner: 'claude', reviewer: 'claude', scout: 'codex' }, fake: { reviewer: 'fake' } },
    defaultProfile: 'mixed', maxFixAttempts: 5, turnTimeoutMinutes: 30,
  };
  assert.equal(agentForTurn(cfg, { profile: 'mixed', role: 'scout', agentName: 'claude' }).name, 'codex');
  assert.equal(agentForTurn(cfg, { profile: 'mixed', role: 'arch', agentName: 'codex' }).name, 'codex');
  assert.equal(agentForTurn(cfg, { profile: 'mixed', role: 'docs' }).name, 'claude');
  assert.equal(agentForTurn(cfg, { profile: 'fake', role: 'scout', agentName: 'codex' }).name, 'fake');
});

test('a role can follow a guide file; a missing guide is an error', async () => {
  const { withGuides } = await import('../src/pipeline/schema');
  const def = clone(read('standard'));
  def.steps.splice(5, 0, { type: 'agent', id: 'scout', name: 'Scout', purpose: 'Finds parts.', instructions: 'guide:hardware-scout', needs: ['web'], reads: [], mayWrite: ['.devcrew/hardware/'], produces: [] });
  assert.deepEqual(validatePipeline(def), []);
  const scout = withGuides(def).steps.find(s => s.id === 'scout');
  assert.ok(scout?.type === 'agent' && scout.instructions.startsWith('# Hardware scout'));

  (def.steps[5] as { instructions: string }).instructions = 'guide:no-such-guide';
  (def.steps[5] as { needs: string[] }).needs = ['telepathy'];
  const errors = validatePipeline(def).join('\n');
  assert.match(errors, /no role guide pipelines\/roles\/no-such-guide\.md/);
  assert.match(errors, /"needs" must be a list of web, shell/);
});

test('approving records the guides; editing one later blocks the pipeline until it is reviewed again', async () => {
  const { reviewDraft, listPipelines, loadPipeline, ROLES_DIR, DRAFTS_DIR, PIPELINES_DIR } = await import('../src/pipeline/schema');
  const { writeFileSync, unlinkSync, existsSync } = await import('node:fs');
  const id = 'guide-lock-test';
  const guide = join(ROLES_DIR, `${id}.md`);
  const def = clone(read('standard'));
  def.id = id;
  def.steps.splice(5, 0, { type: 'agent', id: 'helper', name: 'Helper', purpose: 'Helps.', instructions: `guide:${id}`, reads: [], mayWrite: ['.devcrew/helper.md'], produces: [] });
  try {
    writeFileSync(guide, '# Helper\n\nWrite a short note.\n');
    writeFileSync(join(DRAFTS_DIR, `${id}.json`), JSON.stringify(def));
    reviewDraft(id, 'approve');
    const approved = JSON.parse(readFileSync(join(PIPELINES_DIR, `${id}.json`), 'utf8')) as PipelineDef;
    assert.ok(approved.guideHashes?.[id]);
    assert.equal(loadPipeline(id).id, id);

    writeFileSync(guide, '# Helper\n\nWrite a long note and change some files.\n');
    assert.throws(() => loadPipeline(id), /changed since this pipeline was approved/);
    assert.match(listPipelines().find(p => p.id === id && !p.draft)!.errors.join('\n'), /changed since this pipeline was approved/);
  } finally {
    for (const f of [guide, join(PIPELINES_DIR, `${id}.json`), join(DRAFTS_DIR, `${id}.json`), join(DRAFTS_DIR, `${id}.review.json`)]) {
      if (existsSync(f)) unlinkSync(f);
    }
  }
});

test('a run is refused when a role needs something its agent cannot do', async () => {
  const { checkCapabilities } = await import('../src/orchestrator/runtime');
  const cfg = {
    agents: { claude: { command: 'x', provides: ['web', 'shell'] }, codex: { command: 'y', provides: ['shell'] }, other: { command: 'z' } },
    profiles: { codex: { reviewer: 'codex' }, mixed: { reviewer: 'codex', scout: 'claude' }, other: { reviewer: 'other' } },
    defaultProfile: 'codex', maxFixAttempts: 5, turnTimeoutMinutes: 30,
  };
  const def: PipelineDef = { id: 'x', name: 'x', description: 'x', kind: 'design', steps: [
    { type: 'agent', id: 'scout', name: 'Hardware scout', purpose: 'p', instructions: 'Search the web for parts.', needs: ['web'], reads: [], mayWrite: ['.devcrew/x.md'], produces: [] },
    { type: 'gate', id: 'g', title: 'g', review: 'design', reviseTo: 'scout' },
  ] };
  assert.match(checkCapabilities(cfg, 'codex', def).errors.join(), /Hardware scout needs web, but agent "codex"/);
  assert.deepEqual(checkCapabilities(cfg, 'mixed', def), { errors: [], warnings: [] });
  assert.match(checkCapabilities(cfg, 'other', def).warnings.join(), /does not say whether it can/);
  assert.deepEqual(checkCapabilities(cfg, 'fake', def).errors, []);
});
