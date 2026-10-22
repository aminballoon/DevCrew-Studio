import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { STUDIO_ROOT } from '../src/core/config';
import { composePipeline, guidesOf, loadPipeline, validatePipeline, withGuides, withMutation, type AgentStep, type PipelineDef } from '../src/pipeline/schema';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const fast = () => clone(loadPipeline('fast'));
const agent = (id: string, extra: Partial<AgentStep> = {}): AgentStep => ({ type: 'agent', id, name: id, purpose: `The ${id}.`, instructions: `Do the work of the ${id} role.`, reads: [], mayWrite: [`.devcrew/${id}.md`], produces: [], ...extra });
/** A step right after the build, where reviewers go. */
const afterBuild = (def: PipelineDef, step: PipelineDef['steps'][number]) => { def.steps.splice(def.steps.findIndex(s => s.type === 'build') + 1, 0, step); return def; };

test('every shipped pipeline and add-on is valid', () => {
  for (const f of readdirSync(join(STUDIO_ROOT, 'pipelines')).filter(f => f.endsWith('.json'))) {
    assert.deepEqual(validatePipeline(JSON.parse(readFileSync(join(STUDIO_ROOT, 'pipelines', f), 'utf8'))), [], f);
  }
  for (const base of ['fast', 'fast-arch']) {
    composePipeline(loadPipeline(base), ['codebase', 'hardware', 'security', 'docs']);
  }
});

test('a fast pipeline opens with a blind QA and the build, and ends with the code gate', () => {
  const def = fast();
  assert.deepEqual(validatePipeline(def), []);
  const seeing = { ...def, steps: def.steps.map(s => (s.type === 'qa' ? { ...s, blind: false } : s)) };
  assert.ok(validatePipeline(seeing).some(e => /must be blind/.test(e)));
  const swapped = { ...def, steps: [def.steps[1], def.steps[0], ...def.steps.slice(2)] };
  assert.ok(validatePipeline(swapped).some(e => /before "qa"/i.test(e)));
  const noCodeGate = { ...def, steps: def.steps.slice(0, -1) };
  assert.match(validatePipeline(noCodeGate).join('\n'), /last step must be a gate with "review": "code"/);
  assert.match(validatePipeline({ ...def, kind: undefined } as unknown as PipelineDef).join('\n'), /"kind" must be "fast"/);
  // An Architect may come right before QA, followed by the gate where you approve its design
  const arch = loadPipeline('fast-arch');
  assert.deepEqual(validatePipeline(arch), []);
  const noGate = { ...arch, steps: arch.steps.filter(s => s.id !== 'gate_arch') };
  assert.ok(validatePipeline(noGate).some(e => /architect step .* only a gate/.test(e)));
  const designWithArchitect: PipelineDef = { id: 'design', name: 'd', description: 'd', kind: 'design', steps: [{ ...arch.steps[0] }, { type: 'gate', id: 'gate_d', title: 'g', review: 'design', reviseTo: 'architect' }] };
  assert.ok(validatePipeline(designWithArchitect).some(e => /belongs in a fast pipeline/.test(e)));
});

test('extra roles cannot touch locked files or write everywhere', () => {
  const def = afterBuild(fast(), agent('security', { mayWrite: ['tests/', '*'] }));
  const errors = validatePipeline(def).join('\n');
  assert.match(errors, /may not write "tests\/"/);
  assert.match(errors, /cannot be everything/);
});

test('only steps after build may send work back to the Builder, and loops are capped', () => {
  const def = fast();
  def.steps.unshift(agent('security', { verdict: { file: '.devcrew/security.md', onChanges: 'dev', maxRounds: 9 } }));
  const errors = validatePipeline(def).join('\n');
  assert.match(errors, /only steps after "build" can send work back to the Builder/);
  assert.match(errors, /maxRounds" must be a whole number from 1 to 5/);
});

test('built-in steps appear exactly once, ids are unique and not reserved', () => {
  const def = fast();
  def.steps.push({ type: 'qa', id: 'qa' });
  afterBuild(def, agent('dev'));
  const errors = validatePipeline(def).join('\n');
  assert.match(errors, /exactly one "qa" and one "build" step/);
  assert.match(errors, /"dev" is reserved/);
});

test('a design pipeline has no code steps and ends with a design gate', () => {
  const ok: PipelineDef = { id: 'design-test', name: 'Design', description: 'Design only.', kind: 'design', steps: [agent('architect', { mayWrite: ['.devcrew/system.json'] }), { type: 'gate', id: 'gate_final', title: 'Approve the design', review: 'design', reviseTo: 'architect' }] };
  assert.deepEqual(validatePipeline(ok), []);

  const withCode = clone(ok);
  withCode.steps.unshift({ type: 'qa', id: 'qa', blind: true });
  assert.match(validatePipeline(withCode).join('\n'), /design pipeline has no "qa" step/);

  const wrongGate = clone(ok);
  (wrongGate.steps[1] as { review: string }).review = 'code';
  assert.match(validatePipeline(wrongGate).join('\n'), /last step must be a gate with "review": "design"/);

  const designInFast = fast();
  designInFast.steps.splice(-1, 0, { type: 'gate', id: 'gate_design', title: 'A design gate', review: 'design', reviseTo: 'build' });
  assert.match(validatePipeline(designInFast).join('\n'), /"review" must be "architecture" or "code"/);
});

test('a role can follow a guide file; a missing guide is an error', () => {
  const def = afterBuild(fast(), agent('scout', { instructions: 'guide:hardware-scout', needs: ['web'], mayWrite: ['.devcrew/hardware/'] }));
  assert.deepEqual(validatePipeline(def), []);
  const scout = withGuides(def).steps.find(s => s.id === 'scout');
  assert.ok(scout?.type === 'agent' && scout.instructions.startsWith('# Hardware scout'));

  const step = def.steps.find(s => s.id === 'scout') as AgentStep;
  step.instructions = 'guide:no-such-guide';
  (step as { needs: string[] }).needs = ['telepathy'];
  const errors = validatePipeline(def).join('\n');
  assert.match(errors, /no role guide pipelines\/roles\/no-such-guide\.md/);
  assert.match(errors, /"needs" must be a list of web, shell/);
});

test('approving records the guides; editing one later blocks the pipeline until it is reviewed again', async () => {
  const { reviewDraft, listPipelines, ROLES_DIR, DRAFTS_DIR, PIPELINES_DIR } = await import('../src/pipeline/schema');
  const { writeFileSync, unlinkSync, existsSync } = await import('node:fs');
  const id = 'guide-lock-test';
  const guide = join(ROLES_DIR, `${id}.md`);
  const def = afterBuild({ ...fast(), id }, agent('helper', { instructions: `guide:${id}` }));
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

test('built-in steps can add a role guide; a missing guide is a problem', () => {
  const base = fast();
  const withGuide = { ...base, id: 'guided', steps: base.steps.map(s => (s.type === 'qa' ? { ...s, guide: 'guide:test-engineer' } : s)) };
  assert.deepEqual(validatePipeline(withGuide), []);
  assert.deepEqual(guidesOf(withGuide), ['test-engineer']);
  const qa = withGuides(withGuide).steps.find(s => s.type === 'qa') as { guideText?: string };
  assert.match(qa.guideText ?? '', /^# Test engineer/);
  const missing = { ...withGuide, steps: withGuide.steps.map(s => (s.type === 'qa' ? { ...s, guide: 'guide:no-such-guide' } : s)) };
  assert.match(validatePipeline(missing).join(' '), /no role guide pipelines\/roles\/no-such-guide\.md/);
});

test('add-ons attach to a fast pipeline: research roles first, reviewers after the build, writers last', () => {
  const def = composePipeline(loadPipeline('fast-arch'), ['codebase', 'security', 'docs']);
  assert.deepEqual(def.steps.map(s => s.id), ['codebase', 'architect', 'gate_arch', 'qa', 'build', 'security', 'reviewer', 'docs', 'gate_merge']);
  assert.deepEqual(def.addons, ['codebase', 'security', 'docs']);
  assert.match(def.name, /\+ Codebase analyst \+ Security review \+ Usage docs$/);
  assert.throws(() => composePipeline(loadPipeline('system-integration'), ['docs']), /attach to fast pipelines/);
  assert.throws(() => composePipeline(loadPipeline('fast'), ['nope']), /No add-on "nope"/);
  // Before QA there is room for research only, never for a role that writes code
  const def2 = fast();
  def2.steps.unshift(agent('early', { mayWrite: ['src/'] }));
  assert.ok(validatePipeline(def2).some(e => /research roles/.test(e)));
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

test('the mutation check is a build step setting: turned on per run, checked like the rest', () => {
  const on = withMutation(fast());
  assert.deepEqual(on.steps.find(s => s.type === 'build'), { type: 'build', id: 'build', mutation: {} });
  assert.deepEqual(validatePipeline(on), []);
  const kept = fast();
  kept.steps = kept.steps.map(s => (s.type === 'build' ? { ...s, mutation: { maxMutants: 10 } } : s));
  assert.deepEqual(withMutation(kept).steps.find(s => s.type === 'build'), { type: 'build', id: 'build', mutation: { maxMutants: 10 } });
  const bad = fast();
  bad.steps = bad.steps.map(s => (s.type === 'build' ? { ...s, mutation: { maxMutants: 0, rounds: 9, budgetMinutes: 1.5 } } : s));
  assert.deepEqual(validatePipeline(bad).filter(e => e.includes('mutation')).length, 3);
  assert.throws(() => withMutation(clone(loadPipeline('system-integration'))), /needs a fast pipeline/);
  // Its graph nodes cannot be taken by a role
  assert.ok(validatePipeline(afterBuild(fast(), agent('mutation'))).some(e => /reserved/.test(e)));
});
