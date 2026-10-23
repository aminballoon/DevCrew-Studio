import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate run data before any module reads DATA_ROOT
process.env.DEVCREW_NO_NOTIFY = '1';
process.env.DEVCREW_DATA = mkdtempSync(join(tmpdir(), 'devcrew-data-'));
process.env.FAKE_DELAY_MS = '0';

const { RunManager } = await import('../src/orchestrator/RunManager');
const { getBus } = await import('../src/orchestrator/runtime');
const { STUDIO_ROOT } = await import('../src/core/config');
const { loadPipeline } = await import('../src/pipeline/schema');
type PipelineDef = import('../src/pipeline/schema').PipelineDef;

const TASK = join(STUDIO_ROOT, 'bench/tasks/S-01-cart');
const REQUIREMENT = readFileSync(join(TASK, 'requirement.md'), 'utf8');

test('fast pipeline: QA and the Builder start together, the Builder fixes what the hidden tests catch', { timeout: 60_000 }, async () => {
  const runs = new RunManager();
  let workspace = '';
  const builderSaw: boolean[] = [];
  const unsubscribe = getBus().subscribe(e => {
    if (e.type === 'run_started') { workspace = e.workspace; }
    // Every time the Builder is given a turn, QA's tests must be out of its workspace
    if (e.type === 'agent_input' && e.role === 'dev' && workspace) { builderSaw.push(existsSync(join(workspace, 'acceptance'))); }
  });
  const runId = runs.start({ requirement: REQUIREMENT, source: join(TASK, 'seed'), profile: 'fake', autoApprove: true, pipeline: 'fast' });
  const status = await runs.waitFor(runId);
  unsubscribe();
  const events = getBus().read(runId);
  assert.equal(status, 'approved', JSON.stringify(events.filter(e => e.type === 'log' || e.type === 'run_finished')).slice(0, 2000));
  const stages = events.filter(e => e.type === 'node_started').map(e => e.type === 'node_started' && e.node);
  assert.deepEqual(stages, ['qa', 'dev', 'verify', 'dev', 'verify', 'reviewer']);
  // Both turns began before either finished
  const inputs = events.filter(e => e.type === 'agent_input').slice(0, 2).map(e => e.type === 'agent_input' && e.role).sort();
  assert.deepEqual(inputs, ['dev', 'qa']);
  const firstUsage = events.findIndex(e => e.type === 'usage');
  assert.ok(events.findIndex(e => e.type === 'agent_input' && e.role === 'dev') < firstUsage && events.findIndex(e => e.type === 'agent_input' && e.role === 'qa') < firstUsage);
  assert.deepEqual(builderSaw, [false, false], 'the Builder never has the hidden tests in its workspace');
  const verifies = events.flatMap(e => (e.type === 'verify_result' ? [e] : []));
  assert.deepEqual(verifies.map(v => v.passed), [false, true]);
  assert.ok(verifies[0].reasons.some(r => r.startsWith('Hidden tests:')), JSON.stringify(verifies[0].reasons));
  assert.deepEqual(verifies[1].commands, ['node --test "tests/**/*.test.ts"', 'node --test "acceptance/**/*.test.ts"']);
  // The approved commit keeps QA's tests with the code
  assert.ok(existsSync(join(workspace, 'acceptance/discounts/discounts.test.ts')));
  // QA's suite passed the system's checks, so QA had one turn; the Builder's fix names each failing
  // hidden test's clause in the customer's words and QA's reason, never the test itself
  assert.equal(events.filter(e => e.type === 'agent_input' && e.role === 'qa').length, 1);
  const fix = events.filter(e => e.type === 'agent_input' && e.role === 'dev')[1];
  const fixPrompt = fix?.type === 'agent_input' ? fix.prompt : '';
  assert.match(fixPrompt, /What each failing hidden test checks, and why:\n- "AC-6 SAVE10 rounds the discount down"\n {3}R-10: `applyDiscount\(code: string\)`: `SAVE10` takes 10% off[^\n]*\n {3}Why it matters \(QA\): SAVE10 takes 10% off and rounds the discount down/);
  assert.doesNotMatch(fixPrompt, /assert\.equal\(c\.total\(\), 1800\)/);
  // The Reviewer gets the code's diff without QA's hidden tests, which nobody may change
  const review = events.find(e => e.type === 'agent_input' && e.role === 'reviewer');
  const prompt = review?.type === 'agent_input' ? review.prompt : '';
  assert.match(prompt, /diff --git a\/src\/cart\.ts b\/src\/cart\.ts/);
  assert.match(prompt, /acceptance\/ holds QA's hidden acceptance tests \(left out of the diff\)/);
  assert.doesNotMatch(prompt, /diff --git a\/acceptance\//);
});

test('fast-arch: the Architect designs once, Verify enforces it, and the next run builds inside it', { timeout: 90_000 }, async () => {
  const runs = new RunManager();
  const requirement = REQUIREMENT;
  const first = runs.start({ requirement, source: join(TASK, 'seed'), profile: 'fake', autoApprove: true, pipeline: 'fast-arch' });
  assert.equal(await runs.waitFor(first), 'approved', JSON.stringify(getBus().read(first).filter(e => e.type === 'log' || e.type === 'run_finished')).slice(0, 2000));
  const events = getBus().read(first);
  const stages = events.flatMap(e => (e.type === 'node_started' ? [e.node] : []));
  assert.deepEqual(stages, ['architect', 'qa', 'dev', 'verify', 'dev', 'verify', 'reviewer']);
  const verifies = events.flatMap(e => (e.type === 'verify_result' ? [e] : []));
  assert.ok(verifies[0].reasons.includes('Architecture: src/util/carts.ts imports src/cart.ts: module "util" may not use "cart" (it may use: no other module)'), JSON.stringify(verifies[0].reasons));
  assert.equal(verifies[1].passed, true);
  // Builder and QA work from the Architect's design and contracts
  const builderPrompt = events.find(e => e.type === 'agent_input' && e.role === 'dev');
  assert.match(builderPrompt?.type === 'agent_input' ? builderPrompt.prompt : '', /The project's architecture is fixed[\s\S]*=== \.devcrew\/architecture\.json ===/);
  const qaPrompt = events.find(e => e.type === 'agent_input' && e.role === 'qa');
  assert.match(qaPrompt?.type === 'agent_input' ? qaPrompt.prompt : '', /=== contracts\/cart\.d\.ts ===/);

  // The next change starts from the committed project: it has an architecture, so no Architect
  const workspace = events.find(e => e.type === 'run_started');
  // Its committed acceptance/ holds the first change's hidden tests: they must stay hidden from the Builder
  let secondWorkspace = '';
  const builderSaw: boolean[] = [];
  const reviewerSaw: boolean[] = [];
  const unsubscribe = getBus().subscribe(e => {
    if (e.type === 'run_started') { secondWorkspace = e.workspace; }
    if (e.type === 'agent_input' && e.role === 'dev' && secondWorkspace) { builderSaw.push(existsSync(join(secondWorkspace, 'acceptance'))); }
    if (e.type === 'agent_input' && e.role === 'reviewer' && secondWorkspace) { reviewerSaw.push(existsSync(join(secondWorkspace, 'acceptance'))); }
  });
  const second = runs.start({ requirement, source: workspace?.type === 'run_started' ? workspace.workspace : '', profile: 'fake', autoApprove: true, pipeline: 'fast-arch' });
  assert.equal(await runs.waitFor(second), 'approved');
  unsubscribe();
  assert.ok(builderSaw.length && builderSaw.every(seen => !seen), `the Builder saw acceptance/: ${JSON.stringify(builderSaw)}`);
  // The reviewer reads the code as it will be committed: the earlier hidden tests in place, not deleted
  assert.deepEqual(reviewerSaw, [true]);
  const review = getBus().read(second).find(e => e.type === 'agent_input' && e.role === 'reviewer');
  const reviewPrompt = review?.type === 'agent_input' ? review.prompt : '';
  assert.match(reviewPrompt, /acceptance\/ holds QA's hidden acceptance tests/);
  assert.doesNotMatch(reviewPrompt, /deleted file mode[^\n]*\n[^\n]*\n[^\n]*acceptance\/|--- a\/acceptance\//);
  assert.equal(getBus().read(second).flatMap(e => (e.type === 'node_started' ? [e.node] : []))[0], 'qa');
});

test('fast-arch: a Builder that needs another design gets it from the Architect and carries on', { timeout: 60_000 }, async () => {
  const runs = new RunManager();
  const runId = runs.start({ requirement: REQUIREMENT, source: join(TASK, 'seed'), profile: 'fake-archchange', autoApprove: true, pipeline: 'fast-arch' });
  assert.equal(await runs.waitFor(runId), 'approved', JSON.stringify(getBus().read(runId).filter(e => e.type === 'log' || e.type === 'run_finished')).slice(0, 2000));
  const events = getBus().read(runId);
  assert.deepEqual(events.flatMap(e => (e.type === 'node_started' ? [e.node] : [])), ['architect', 'qa', 'dev', 'architect', 'dev', 'verify', 'reviewer']);
  const architectPrompts = events.flatMap(e => (e.type === 'agent_input' && e.role === 'architect' ? [e.prompt] : []));
  assert.match(architectPrompts[1], /A change to the design is asked for[\s\S]*let util use the cart/);
  const builderPrompts = events.flatMap(e => (e.type === 'agent_input' && e.role === 'dev' ? [e.prompt] : []));
  assert.match(builderPrompts[1], /The Architect changed the architecture for your request[\s\S]*ADR-2/);
  // The cart factory in util is legal under the new design
  assert.deepEqual(events.flatMap(e => (e.type === 'verify_result' ? [e.passed] : [])), [true]);
});

test('fast with an add-on: the research role runs first and the Builder and QA get its report; "single" runs one agent', { timeout: 60_000 }, async () => {
  const runs = new RunManager();
  const runId = runs.start({ requirement: REQUIREMENT, source: join(TASK, 'seed'), profile: 'fake', autoApprove: true, pipeline: 'fast', addons: ['codebase'] });
  assert.equal(await runs.waitFor(runId), 'approved', JSON.stringify(getBus().read(runId).filter(e => e.type === 'log' || e.type === 'run_finished')).slice(0, 2000));
  const events = getBus().read(runId);
  assert.deepEqual(events.flatMap(e => (e.type === 'node_started' ? [e.node] : [])).slice(0, 2), ['codebase', 'qa']);
  const started = events.find(e => e.type === 'run_started');
  assert.deepEqual(started?.type === 'run_started' && started.pipeline?.addons, ['codebase']);

  const single = runs.start({ requirement: REQUIREMENT, source: join(TASK, 'seed'), profile: 'fake', pipeline: 'single' });
  assert.equal(await runs.waitFor(single), 'completed');
  assert.equal(getBus().read(single).find(e => e.type === 'run_started')?.type === 'run_started' && (getBus().read(single).find(e => e.type === 'run_started') as { mode: string }).mode, 'single');
});

const waitForGate = (runId: string) => new Promise<Record<string, unknown> & { gate: string }>(resolve => {
  const off = getBus().subscribe(e => {
    if (e.runId === runId && e.type === 'gate_waiting') { off(); resolve({ ...e.payload, gate: e.gate } as Record<string, unknown> & { gate: string }); }
  });
});

test('a run waits at the code gate; resume refuses a waiting or finished run', { timeout: 60_000 }, async () => {
  const runs = new RunManager();
  const runId = runs.start({ requirement: REQUIREMENT, source: join(TASK, 'seed'), profile: 'fake', pipeline: 'fast' });
  const gate = await waitForGate(runId);
  assert.equal(gate.gate, 'gate_merge');
  assert.ok((gate.files as { path: string }[]).some(f => f.path === 'src/cart.ts'));
  await assert.rejects(runs.resume(runId), /waiting at a gate/i);
  const finished = runs.waitFor(runId);
  await runs.resolveGate(runId, { decision: 'abort' });
  assert.equal(await finished, 'aborted');
  await assert.rejects(runs.resume(runId), /has finished/);
});

test('a security add-on sends the code back to the Builder once, then the run goes on', { timeout: 60_000 }, async () => {
  const runs = new RunManager();
  const runId = runs.start({ requirement: REQUIREMENT, source: join(TASK, 'seed'), profile: 'fake', autoApprove: true, pipeline: 'fast', addons: ['security'] });
  assert.equal(await runs.waitFor(runId), 'approved', JSON.stringify(getBus().read(runId).filter(e => e.type === 'log' || e.type === 'run_finished')).slice(0, 2000));
  const events = getBus().read(runId);
  const stages = events.flatMap(e => (e.type === 'node_started' ? [e.node] : []));
  assert.deepEqual(stages.slice(stages.indexOf('security')), ['security', 'dev', 'verify', 'security', 'reviewer']);
  // The security reviewer may only write its report
  const input = events.find(e => e.type === 'agent_input' && e.role === 'security');
  assert.ok(input?.type === 'agent_input' && input.prompt.includes('You may only write: .devcrew/security.md'));
});

test('a hidden test that fails twice in a row goes back to QA, who fixes it', { timeout: 60_000 }, async () => {
  const runs = new RunManager();
  const runId = runs.start({ requirement: REQUIREMENT, source: join(TASK, 'seed'), profile: 'fake-wrongtest', autoApprove: true, pipeline: 'fast' });
  const status = await runs.waitFor(runId);
  const events = getBus().read(runId);
  assert.equal(status, 'approved', JSON.stringify(events.filter(e => e.type === 'log' || e.type === 'run_finished')).slice(0, 2000));
  const stages = events.flatMap(e => (e.type === 'node_started' ? [`${e.node}${e.module ? ':' + e.module : ''}`] : []));
  assert.deepEqual(stages, ['qa', 'dev:main', 'verify:main', 'dev:main', 'verify:main', 'qa:main', 'dev:main', 'verify:main', 'reviewer']);
  assert.deepEqual(events.flatMap(e => (e.type === 'verify_result' ? [e.passed] : [])), [false, false, true]);
  const dispute = events.filter(e => e.type === 'agent_input' && e.role === 'qa')[1];
  assert.ok(dispute?.type === 'agent_input' && dispute.prompt.includes('failed on two attempts in a row'));
  // QA's answer said "REQUIREMENT_ISSUE: none.", which is no conflict; a real one goes to a person
  const { requirementIssue } = await import('../src/orchestrator/graph');
  assert.equal(requirementIssue('REQUIREMENT_ISSUE: R-2 says 10% and R-5 says 15% for the same order'), 'R-2 says 10% and R-5 says 15% for the same order');
  for (const none of ['REQUIREMENT_ISSUE: none.', 'REQUIREMENT_ISSUE: None', 'REQUIREMENT_ISSUE: N/A', 'REQUIREMENT_ISSUE: no conflict', 'QA_ANSWER: fixed']) { assert.equal(requirementIssue(none), null, none); }
});

test('mutation check: a mistake the hidden tests miss goes to QA, whose new test catches a real bug the Builder then fixes', { timeout: 120_000 }, async () => {
  const runs = new RunManager();
  // Every mutant, so the sample cannot leave out the one this story is about
  const fast = loadPipeline('fast');
  const pipeline = { ...fast, steps: fast.steps.map(s => (s.type === 'build' ? { ...s, mutation: { maxMutants: 100 } } : s)) };
  let workspace = '';
  const unsubscribe = getBus().subscribe(e => { if (e.type === 'run_started') { workspace = e.workspace; } });
  const runId = runs.start({ requirement: REQUIREMENT, source: join(TASK, 'seed'), profile: 'fake-mutants', autoApprove: true, pipeline });
  const status = await runs.waitFor(runId);
  unsubscribe();
  const events = getBus().read(runId);
  assert.equal(status, 'approved', JSON.stringify(events.filter(e => e.type === 'log' || e.type === 'run_finished')).slice(0, 2000));
  const stages = events.flatMap(e => (e.type === 'node_started' ? [`${e.node}${e.module ? ':' + e.module : ''}`] : []));
  assert.deepEqual(stages, ['qa', 'dev:main', 'verify:main', 'dev:main', 'verify:main', 'mutation', 'qa:mutants', 'verify:main', 'dev:main', 'verify:main', 'mutation', 'reviewer']);
  assert.deepEqual(events.flatMap(e => (e.type === 'verify_result' ? [e.passed] : [])), [false, true, false, true]);

  const checks = events.flatMap(e => (e.type === 'mutation_result' ? [e] : []));
  assert.equal(checks.length, 2);
  const zero = 'unitPriceCents <= 0) throw';
  assert.ok(checks[0].survived.some(m => m.before.includes(zero) && m.after.includes('unitPriceCents < 0) throw')), JSON.stringify(checks[0].survived));
  assert.ok(checks[0].survived.some(m => m.after.includes('qty > line.qty')));
  assert.equal(checks[0].survived.length, 2);
  // QA's new tests catch both, on the fixed code
  assert.deepEqual([checks[1].tested, checks[1].survived.length, checks[1].score], [checks[0].tested, 0, 100]);

  const qaTurns = events.filter(e => e.type === 'agent_input' && e.role === 'qa');
  assert.match(qaTurns[1]?.type === 'agent_input' ? qaTurns[1].prompt : '', /src\/cart\.ts:8\n {3}- .*unitPriceCents <= 0\) throw[^\n]*\n {3}\+ .*unitPriceCents < 0\) throw/);
  // The Builder learns of it through the failing hidden test, as for any other; every mutated file was put back
  const fix = events.filter(e => e.type === 'agent_input' && e.role === 'dev')[2];
  assert.ok(fix?.type === 'agent_input' && fix.prompt.includes('✖ R-1 a price of 0 cents is allowed') && !fix.prompt.includes('unitPriceCents < 0'));
  assert.ok(readFileSync(join(workspace, 'src/cart.ts'), 'utf8').includes('unitPriceCents < 0) throw'));
  assert.ok(existsSync(join(workspace, 'acceptance/cart-core/boundaries.test.ts')));
});

test("QA's hidden tests are checked: a test of DevCrew's files and tests with no reason go back to QA once", { timeout: 60_000 }, async () => {
  const runs = new RunManager();
  const runId = runs.start({ requirement: REQUIREMENT, source: join(TASK, 'seed'), profile: 'fake-why', autoApprove: true, pipeline: 'fast' });
  const status = await runs.waitFor(runId);
  const events = getBus().read(runId);
  assert.equal(status, 'approved', JSON.stringify(events.filter(e => e.type === 'log' || e.type === 'run_finished')).slice(0, 2000));
  const qaTurns = events.flatMap(e => (e.type === 'agent_input' && e.role === 'qa' ? [e.prompt] : []));
  assert.equal(qaTurns.length, 2);
  assert.match(qaTurns[1], /acceptance\/cart-core\/extra\.test\.ts reads DevCrew's own files/);
  assert.match(qaTurns[1], /acceptance\/why\.json is missing/);
  assert.ok(events.some(e => e.type === 'log' && e.level === 'info' && e.message.startsWith("QA's hidden tests: 2 problem(s) sent back to QA")));
  assert.ok(!events.some(e => e.type === 'log' && e.level === 'warn'), 'the second turn fixed everything');
  // The fixed suite is the one that judged and was committed
  const workspace = events.find(e => e.type === 'run_started');
  const ws = workspace?.type === 'run_started' ? workspace.workspace : '';
  assert.match(readFileSync(join(ws, 'acceptance/cart-core/extra.test.ts'), 'utf8'), /R-6 removing exactly the quantity/);
  assert.equal(JSON.parse(readFileSync(join(ws, 'acceptance/why.json'), 'utf8')).length, 10);
});

test('"No dependencies" is checked by Verify: a declared package sends correct code back with the clause', { timeout: 60_000 }, async () => {
  const runs = new RunManager();
  const runId = runs.start({ requirement: REQUIREMENT, source: join(TASK, 'seed'), profile: 'fake-deps', autoApprove: true, pipeline: 'fast' });
  const status = await runs.waitFor(runId);
  const events = getBus().read(runId);
  assert.equal(status, 'approved', JSON.stringify(events.filter(e => e.type === 'log' || e.type === 'run_finished')).slice(0, 2000));
  const verifies = events.flatMap(e => (e.type === 'verify_result' ? [e] : []));
  assert.deepEqual(verifies.map(v => [v.passed, v.reasons]), [[false, ['No dependencies (R-14): package.json declares lodash (dependencies)']], [true, []]]);
  const prompts = events.flatMap(e => (e.type === 'agent_input' ? [[e.role, e.prompt] as const] : []));
  assert.match(prompts.filter(([r]) => r === 'dev')[1][1], /- No dependencies \(R-14\): package\.json declares lodash/);
  // QA is told not to test it; the hidden tests only judge behaviour
  assert.match(prompts.find(([r]) => r === 'qa')![1], /Do not write a test for R-14 \("No dependencies\."\): the system checks it/);
});

test('an unattended run that cannot go on ends as failed and says why', { timeout: 60_000 }, async () => {
  // The Builder asks for an architecture change, but the fast pipeline has no Architect: a person would decide
  const runs = new RunManager();
  const runId = runs.start({ requirement: REQUIREMENT, source: join(TASK, 'seed'), profile: 'fake-archchange', autoApprove: true, pipeline: 'fast' });
  assert.equal(await runs.waitFor(runId), 'failed');
  const events = getBus().read(runId);
  const resolved = events.find(e => e.type === 'gate_resolved' && e.gate === 'escalation');
  assert.equal(resolved?.type === 'gate_resolved' && resolved.decision, 'abort');
  const ends = events.filter(e => e.type === 'run_finished');
  assert.equal(ends.length, 1);
  assert.match(ends[0].type === 'run_finished' ? ends[0].error ?? '' : '', /does not fit the architecture: .*util/);
});

test('a run that fails mid-way still stops every agent and what it left running', { timeout: 60_000 }, async () => {
  const marker = `sleep 34${Math.floor(Math.random() * 900 + 100)}`;
  process.env.FAKE_MARKER = marker;
  const alive = () => { try { return execSync(`pgrep -f "${marker}"`).toString().trim().length > 0; } catch { return false; } };
  const runs = new RunManager();
  const runId = runs.start({ requirement: REQUIREMENT, source: join(TASK, 'seed'), profile: 'fake-crash', autoApprove: true, pipeline: 'fast' });
  assert.equal(await runs.waitFor(runId), 'failed');
  for (let i = 0; i < 50 && alive(); i++) { await new Promise(r => setTimeout(r, 100)); }
  assert.equal(alive(), false, "QA's background command was stopped");
});

test('a session past the token limit starts fresh for its next full prompt, and the run still works', { timeout: 60_000 }, async () => {
  const { getConfig } = await import('../src/orchestrator/runtime');
  const cfg = getConfig();
  cfg.freshSessionAboveTokens = 1;
  try {
    const runs = new RunManager();
    const runId = runs.start({ requirement: REQUIREMENT, source: join(TASK, 'seed'), profile: 'fake-wrongtest', autoApprove: true, pipeline: 'fast' });
    assert.equal(await runs.waitFor(runId), 'approved', JSON.stringify(getBus().read(runId).filter(e => e.type === 'log' || e.type === 'run_finished')).slice(0, 3000));
    const fresh = getBus().read(runId).flatMap(e => (e.type === 'log' && /starting a fresh session/.test(e.message) ? [e.message.split(':')[0]] : []));
    // The Builder's fix turns after its first; QA's dispute turn too, unless its session was already closed
    assert.equal(fresh.filter(r => r === 'dev').length, 2, JSON.stringify(fresh));
    assert.ok(fresh.every(r => r === 'dev' || r === 'qa'), JSON.stringify(fresh));
  } finally {
    delete cfg.freshSessionAboveTokens;
  }
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
  const runId = runs.start({ requirement: 'A delivery robot', profile: 'fake-design', pipeline: def });

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
  assert.ok(!stages.some(s => ['qa', 'dev', 'verify'].includes(s)));
});

test('a run whose process dies is shown as stopped and resumes to the end; a live one cannot be resumed twice', { timeout: 90_000 }, async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'start', '--requirement', join(TASK, 'requirement.md'), '--source', join(TASK, 'seed'), '--profile', 'fake', '--pipeline', 'fast', '--auto'], {
    cwd: STUDIO_ROOT, env: { ...process.env, FAKE_DELAY_MS: '400' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', d => { out += d; });
  const runId = await new Promise<string>((resolve, reject) => {
    const t = setInterval(() => { const m = out.match(/Run (\S+)/); if (m && /start\s+qa/.test(out)) { clearInterval(t); resolve(m[1]); } }, 100);
    setTimeout(() => { clearInterval(t); reject(new Error(`CLI run did not reach QA:\n${out}`)); }, 60_000);
  });

  const runs = new RunManager();
  const live = await runs.resumeInfo(runId);
  assert.equal(live.resumable, false);
  assert.match(live.reason!, /another process/);

  child.kill('SIGKILL');
  await new Promise(r => child.once('exit', r));
  assert.equal(runs.list().find(r => r.runId === runId)?.status, 'stopped');
  const info = await runs.resumeInfo(runId);
  assert.equal(info.resumable, true, info.reason);

  const done = runs.waitFor(runId);
  await runs.resume(runId);
  assert.equal(await done, 'approved');
  const stages = getBus().read(runId).flatMap(e => (e.type === 'node_started' ? [e.node] : []));
  assert.equal(stages.filter(s => s === 'reviewer').length, 1, 'finished steps are not repeated');
});
