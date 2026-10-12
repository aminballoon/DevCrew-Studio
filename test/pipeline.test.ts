import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate run data before any module reads DATA_ROOT
process.env.DEVCREW_DATA = mkdtempSync(join(tmpdir(), 'devcrew-data-'));
process.env.FAKE_DELAY_MS = '0';

const { RunManager } = await import('../src/orchestrator/RunManager');
const { getBus } = await import('../src/orchestrator/runtime');
const { STUDIO_ROOT } = await import('../src/core/config');
const { loadPipeline } = await import('../src/pipeline/schema');
type PipelineDef = import('../src/pipeline/schema').PipelineDef;

const TASK = join(STUDIO_ROOT, 'bench/tasks/S-01-cart');

test('scripted run goes through every stage, reverts the test tampering and loops once', { timeout: 60_000 }, async () => {
  const runs = new RunManager();
  const runId = runs.start({ requirement: readFileSync(join(TASK, 'requirement.md'), 'utf8'), source: join(TASK, 'seed'), profile: 'fake', autoApprove: true });
  const status = await runs.waitFor(runId);
  const events = getBus().read(runId);

  assert.equal(status, 'approved', JSON.stringify(events.filter(e => e.type === 'log')));
  const stages = events.filter(e => e.type === 'node_started').map(e => e.type === 'node_started' && `${e.node}${e.module ? ':' + e.module : ''}`);
  assert.deepEqual(stages, ['planner', 'qa', 'dev:cart-core', 'verify:cart-core', 'dev:cart-core', 'verify:cart-core', 'dev:discounts', 'verify:discounts', 'reviewer']);

  const guards = events.filter(e => e.type === 'guard_violation');
  assert.equal(guards.length, 1);
  assert.deepEqual(guards[0].type === 'guard_violation' && guards[0].files, ['tests/cart-core/cart.test.ts']);

  const verdicts = events.flatMap(e => (e.type === 'verify_result' ? [e.passed] : []));
  assert.deepEqual(verdicts, [false, true, true]);
  assert.ok(events.some(e => e.type === 'usage' && e.role === 'dev' && e.totalTokens > 0));

  // Every agent turn records what it was given and what it handed on
  const inputs = events.filter(e => e.type === 'agent_input');
  const outputs = events.filter(e => e.type === 'agent_output');
  assert.equal(inputs.length, outputs.length);
  const qaIn = inputs.find(e => e.type === 'agent_input' && e.role === 'qa');
  assert.ok(qaIn?.type === 'agent_input' && qaIn.reads.includes('.devcrew/PRD.md') && qaIn.prompt.includes('QA engineer'));
  const firstDevOut = outputs.find(e => e.type === 'agent_output' && e.role === 'dev');
  // The tampered test file was reverted, so only the code is handed on
  assert.deepEqual(firstDevOut?.type === 'agent_output' && firstDevOut.files.map(f => f.path), ['src/cart.ts']);
});

test('a run pauses at the spec gate and continues after approval', { timeout: 60_000 }, async () => {
  const runs = new RunManager();
  const runId = runs.start({ requirement: 'cart', source: join(TASK, 'seed'), profile: 'fake' });
  await new Promise<void>(resolve => getBus().subscribe(e => { if (e.runId === runId && e.type === 'gate_waiting') resolve(); }));
  const waiting = getBus().read(runId).find(e => e.type === 'gate_waiting');
  assert.equal(waiting?.type === 'gate_waiting' && waiting.gate, 'gate_spec');

  await runs.resolveGate(runId, { decision: 'abort' });
  assert.equal(await runs.waitFor(runId), 'aborted');
});

test('medium scenario: revising the plan produces a second architecture with an entry point', { timeout: 60_000 }, async () => {
  const runs = new RunManager();
  const task = join(STUDIO_ROOT, 'bench/tasks/M-01-expenses');
  const runId = runs.start({ requirement: readFileSync(join(task, 'requirement.md'), 'utf8'), source: join(task, 'seed'), profile: 'fake-expenses' });
  const waitGate = () => new Promise<void>(resolve => {
    const off = getBus().subscribe(e => { if (e.runId === runId && e.type === 'gate_waiting') { off(); resolve(); } });
  });
  await waitGate();
  const plans = () => getBus().read(runId).flatMap(e => e.type === 'agent_output' && e.role === 'planner'
    ? e.files.filter(f => f.path === '.devcrew/plan.json').map(f => JSON.parse(f.content!).architecture.files.map((x: { path: string }) => x.path))
    : []);
  assert.equal(plans().length, 1);
  assert.ok(!plans()[0].includes('src/index.ts'));

  const second = waitGate();
  await runs.resolveGate(runId, { decision: 'revise', feedback: 'Give the library one entry point.' });
  await second;
  assert.equal(plans().length, 2);
  assert.ok(plans()[1].includes('src/index.ts'));

  const merge = waitGate();
  await runs.resolveGate(runId, { decision: 'approve' });
  await merge;
  const verdicts = getBus().read(runId).flatMap(e => (e.type === 'verify_result' ? [`${e.module}:${e.passed}`] : []));
  assert.deepEqual(verdicts, ['money:true', 'ledger:false', 'ledger:true', 'settle:true']);
  const finished = runs.waitFor(runId);
  await runs.resolveGate(runId, { decision: 'approve' });
  assert.equal(await finished, 'approved');
});

test('trouble scenario: an unattended run that never passes ends as failed', { timeout: 60_000 }, async () => {
  const runs = new RunManager();
  const runId = runs.start({ requirement: 'cart', source: join(TASK, 'seed'), profile: 'fake-trouble', autoApprove: true });
  assert.equal(await runs.waitFor(runId), 'failed');
  const events = getBus().read(runId);
  const attempts = events.filter(e => e.type === 'verify_result');
  assert.equal(attempts.length, 5);
  assert.ok(attempts.every(e => e.type === 'verify_result' && !e.passed));
  assert.equal(events.filter(e => e.type === 'guard_violation').length, 5, 'the test edit is reverted on every attempt');
  const resolved = events.find(e => e.type === 'gate_resolved' && e.gate === 'escalation');
  assert.equal(resolved?.type === 'gate_resolved' && resolved.decision, 'abort');
});

test('a security step sends the code back to Dev once, then the run continues', { timeout: 60_000 }, async () => {
  const runs = new RunManager();
  const runId = runs.start({ requirement: 'cart', source: join(TASK, 'seed'), profile: 'fake', autoApprove: true, pipeline: 'with-security' });
  assert.equal(await runs.waitFor(runId), 'approved');
  const events = getBus().read(runId);
  const stages = events.flatMap(e => (e.type === 'node_started' ? [e.node] : []));
  const afterBuild = stages.slice(stages.indexOf('security'));
  assert.deepEqual(afterBuild, ['security', 'dev', 'verify', 'security', 'reviewer']);
  const started = events.find(e => e.type === 'run_started');
  assert.equal(started?.type === 'run_started' && started.pipeline?.id, 'with-security');
  // The security reviewer may only write its report
  const input = events.find(e => e.type === 'agent_input' && e.role === 'security');
  assert.ok(input?.type === 'agent_input' && input.prompt.includes('You may only write: .devcrew/security.md'));
});

test('the minimal pipeline has no reviewer', { timeout: 60_000 }, async () => {
  const runs = new RunManager();
  const runId = runs.start({ requirement: 'cart', source: join(TASK, 'seed'), profile: 'fake', autoApprove: true, pipeline: 'minimal' });
  assert.equal(await runs.waitFor(runId), 'approved');
  const stages = getBus().read(runId).flatMap(e => (e.type === 'node_started' ? [e.node] : []));
  assert.ok(!stages.includes('reviewer'));
  assert.equal(stages.at(-1), 'verify');
});

const waitForGate = (runId: string) => new Promise<Record<string, unknown> & { gate: string }>(resolve => {
  const off = getBus().subscribe(e => {
    if (e.runId === runId && e.type === 'gate_waiting') { off(); resolve({ ...e.payload, gate: e.gate } as Record<string, unknown> & { gate: string }); }
  });
});

test('a role before the planner hands its report to the Planner and to the plan gate', { timeout: 60_000 }, async () => {
  const standard = loadPipeline('standard');
  const def = {
    ...standard, id: 'pre-planner-test',
    steps: [{ type: 'agent' as const, id: 'codebase', name: 'Codebase analyst', purpose: 'Reviews the existing code.', instructions: 'Review the existing code and map the changes.', reads: [], mayWrite: ['.devcrew/codebase-review.md'], produces: [] }, ...standard.steps],
  };
  const runs = new RunManager();
  const runId = runs.start({ requirement: 'cart', source: join(TASK, 'seed'), profile: 'fake', pipeline: def });
  const payload = await waitForGate(runId);
  assert.equal(payload.gate, 'gate_spec');
  const reports = payload.reports as { step: string; files: { path: string; text: string }[] }[];
  assert.deepEqual(reports.map(r => r.step), ['codebase']);
  assert.match(reports[0].files[0].text, /Change map/);

  const events = getBus().read(runId);
  assert.deepEqual(events.flatMap(e => (e.type === 'node_started' ? [e.node] : [])), ['codebase', 'planner']);
  const plannerIn = events.find(e => e.type === 'agent_input' && e.role === 'planner');
  assert.ok(plannerIn?.type === 'agent_input' && plannerIn.prompt.includes('- .devcrew/codebase-review.md'));
  const analystIn = events.find(e => e.type === 'agent_input' && e.role === 'codebase');
  assert.ok(analystIn?.type === 'agent_input' && analystIn.prompt.includes('Requirement from the customer'));
  await runs.resolveGate(runId, { decision: 'abort' });
  assert.equal(await runs.waitFor(runId), 'aborted');
});

test('a design pipeline shows the system diagram, sends feedback back to the architect and commits no code', { timeout: 60_000 }, async () => {
  const role = (id: string, mayWrite: string[]) => ({ type: 'agent' as const, id, name: id, purpose: `The ${id}.`, instructions: `Do the work of the ${id} role.`, reads: [], mayWrite, produces: [] });
  const def: PipelineDef = {
    id: 'design-run-test', name: 'Design', description: 'Design only.', kind: 'design',
    steps: [
      role('architect', ['.devcrew/system.json', '.devcrew/SYSTEM.md']),
      { type: 'gate', id: 'gate_arch', title: 'Review the system architecture', review: 'design', reviseTo: 'architect' },
      role('scout', ['.devcrew/hardware/']),
      { ...role('arch', ['.devcrew/arch-review.md']), verdict: { file: '.devcrew/arch-review.md', onChanges: 'continue' } },
      { type: 'gate', id: 'gate_final', title: 'Approve the design', review: 'design', reviseTo: 'architect' },
    ],
  };
  const runs = new RunManager();
  const runId = runs.start({ requirement: 'A delivery robot', profile: 'fake', pipeline: def });

  const first = await waitForGate(runId);
  assert.equal(first.gate, 'gate_arch');
  const system = first.system as { blocks: { part?: string }[] };
  assert.equal(system.blocks.length, 7);
  assert.deepEqual(first.systemErrors, []);

  let next = waitForGate(runId);
  await runs.resolveGate(runId, { decision: 'approve' });
  const final = await next;
  assert.equal(final.gate, 'gate_final');
  assert.deepEqual((final.reports as { step: string }[]).map(r => r.step), ['architect', 'scout', 'arch']);

  // Asking for changes goes back to the architect with your notes, then through every later role again
  next = waitForGate(runId);
  await runs.resolveGate(runId, { decision: 'revise', feedback: 'Use the recommended parts.' });
  const again = await next;
  assert.equal(again.gate, 'gate_arch');
  assert.ok((again.system as { blocks: { part?: string }[] }).blocks.some(b => b.part === 'Jetson Orin Nano 8GB'));
  const architectIns = getBus().read(runId).filter(e => e.type === 'agent_input' && e.role === 'architect');
  assert.equal(architectIns.length, 2);
  assert.ok(architectIns[1].type === 'agent_input' && architectIns[1].prompt.includes('Use the recommended parts.'));
  assert.ok(architectIns[1].type === 'agent_input' && architectIns[1].prompt.includes('"blocks"'), 'roles that draw the diagram get its format');

  next = waitForGate(runId);
  await runs.resolveGate(runId, { decision: 'approve' });
  await next;
  const finished = runs.waitFor(runId);
  await runs.resolveGate(runId, { decision: 'approve' });
  assert.equal(await finished, 'approved');
  const stages = getBus().read(runId).flatMap(e => (e.type === 'node_started' ? [e.node] : []));
  assert.ok(!stages.some(s => ['planner', 'qa', 'dev', 'verify'].includes(s)));
});
