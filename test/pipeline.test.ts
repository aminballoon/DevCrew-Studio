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
  // The last module is judged by the whole suite only, not by its own tests a second time
  const lastCommands = events.findLast(e => e.type === 'verify_result');
  assert.deepEqual(lastCommands?.type === 'verify_result' && lastCommands.commands, ['node --test']);
  assert.ok(events.some(e => e.type === 'usage' && e.role === 'dev' && e.totalTokens > 0));

  // QA and Dev get the files they work from in the prompt; a retry does not repeat them
  const prompts = events.flatMap(e => (e.type === 'agent_input' ? [{ role: e.role, prompt: e.prompt }] : []));
  assert.match(prompts.find(p => p.role === 'qa')!.prompt, /=== \.devcrew\/PRD\.md ===[\s\S]*=== contracts\/cart\.d\.ts ===/);
  const devPrompts = prompts.filter(p => p.role === 'dev').map(p => p.prompt);
  assert.match(devPrompts[0], /=== tests\/cart-core\/cart\.test\.ts ===/);
  assert.doesNotMatch(devPrompts[1], /=== tests\/cart-core/);

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
  const ends = events.filter(e => e.type === 'run_finished');
  assert.equal(ends.length, 1);
  assert.match(ends[0].type === 'run_finished' ? ends[0].error ?? '' : '', /still failing after 5 attempts: /, 'a failed run says why');
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

test('resume refuses a run that waits at a gate or has finished', { timeout: 60_000 }, async () => {
  const runs = new RunManager();
  const runId = runs.start({ requirement: 'cart', source: join(TASK, 'seed'), profile: 'fake' });
  await waitForGate(runId);
  await assert.rejects(runs.resume(runId), /waiting at a gate/i);
  const finished = runs.waitFor(runId);
  await runs.resolveGate(runId, { decision: 'abort' });
  await finished;
  await assert.rejects(runs.resume(runId), /has finished/);
});

test('a run whose process dies is shown as stopped and resumes to the end; a live one cannot be resumed twice', { timeout: 90_000 }, async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'start', '--requirement', join(TASK, 'requirement.md'), '--source', join(TASK, 'seed'), '--profile', 'fake', '--auto'], {
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
  assert.equal(stages.filter(s => s === 'planner').length, 1, 'the planner is not repeated');
});

test('a run that fails mid-way still stops the agents of earlier steps and what they left running', { timeout: 60_000 }, async () => {
  const marker = `sleep 34${Math.floor(Math.random() * 900 + 100)}`;
  process.env.FAKE_MARKER = marker;
  const alive = () => { try { return execSync(`pgrep -f "${marker}"`).toString().trim().length > 0; } catch { return false; } };
  const runs = new RunManager();
  const runId = runs.start({ requirement: readFileSync(join(TASK, 'requirement.md'), 'utf8'), source: join(TASK, 'seed'), profile: 'fake-crash', autoApprove: true });
  assert.equal(await runs.waitFor(runId), 'failed');
  for (let i = 0; i < 50 && alive(); i++) { await new Promise(r => setTimeout(r, 100)); }
  assert.equal(alive(), false, "the Planner's background command was stopped");
});

test('a disputed test goes back to QA, not to a new plan', { timeout: 60_000 }, async () => {
  const runs = new RunManager();
  const runId = runs.start({ requirement: readFileSync(join(TASK, 'requirement.md'), 'utf8'), source: join(TASK, 'seed'), profile: 'fake-dispute', autoApprove: true });
  const status = await runs.waitFor(runId);
  const events = getBus().read(runId);
  assert.equal(status, 'approved', JSON.stringify(events.filter(e => e.type === 'log')));
  const stages = events.filter(e => e.type === 'node_started').map(e => e.type === 'node_started' && `${e.node}${e.module ? ':' + e.module : ''}`);
  assert.deepEqual(stages, ['planner', 'qa', 'dev:cart-core', 'qa:cart-core', 'dev:cart-core', 'verify:cart-core', 'dev:discounts', 'verify:discounts', 'reviewer']);
  // QA's corrected test is the locked version Verify judged with
  assert.deepEqual(events.flatMap(e => (e.type === 'verify_result' ? [e.passed] : [])), [true, true]);
});

test('a session past the token limit starts fresh for its next full prompt, and the run still works', { timeout: 60_000 }, async () => {
  const { getConfig } = await import('../src/orchestrator/runtime');
  const cfg = getConfig();
  cfg.freshSessionAboveTokens = 1;
  try {
    const runs = new RunManager();
    const runId = runs.start({ requirement: readFileSync(join(TASK, 'requirement.md'), 'utf8'), source: join(TASK, 'seed'), profile: 'fake-dispute', autoApprove: true });
    const status = await runs.waitFor(runId);
    assert.equal(status, 'approved', JSON.stringify(getBus().read(runId).filter(e => e.type === 'log' || e.type === 'run_finished')).slice(0, 3000));
    const fresh = getBus().read(runId).flatMap(e => (e.type === 'log' && /starting a fresh session/.test(e.message) ? [e.message.split(':')[0]] : []));
    // QA's dispute turn, and Dev's turns after its first (one Dev session across modules)
    assert.deepEqual(fresh, ['qa', 'dev', 'dev']);
  } finally {
    delete cfg.freshSessionAboveTokens;
  }
});

test('fast pipeline: QA and the Builder start together, the Builder fixes what the hidden tests catch', { timeout: 60_000 }, async () => {
  const runs = new RunManager();
  let workspace = '';
  const builderSaw: boolean[] = [];
  const unsubscribe = getBus().subscribe(e => {
    if (e.type === 'run_started') { workspace = e.workspace; }
    // Every time the Builder is given a turn, QA's tests must be out of its workspace
    if (e.type === 'agent_input' && e.role === 'dev' && workspace) { builderSaw.push(existsSync(join(workspace, 'acceptance'))); }
  });
  const runId = runs.start({ requirement: readFileSync(join(TASK, 'requirement.md'), 'utf8'), source: join(TASK, 'seed'), profile: 'fake-fast', autoApprove: true, pipeline: 'fast' });
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
});

test('fast-arch: the Architect designs once, Verify enforces it, and the next run builds inside it', { timeout: 90_000 }, async () => {
  const runs = new RunManager();
  const requirement = readFileSync(join(TASK, 'requirement.md'), 'utf8');
  const first = runs.start({ requirement, source: join(TASK, 'seed'), profile: 'fake-fast', autoApprove: true, pipeline: 'fast-arch' });
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
  const unsubscribe = getBus().subscribe(e => {
    if (e.type === 'run_started') { secondWorkspace = e.workspace; }
    if (e.type === 'agent_input' && e.role === 'dev' && secondWorkspace) { builderSaw.push(existsSync(join(secondWorkspace, 'acceptance'))); }
  });
  const second = runs.start({ requirement, source: workspace?.type === 'run_started' ? workspace.workspace : '', profile: 'fake-fast', autoApprove: true, pipeline: 'fast-arch' });
  assert.equal(await runs.waitFor(second), 'approved');
  unsubscribe();
  assert.ok(builderSaw.length && builderSaw.every(seen => !seen), `the Builder saw acceptance/: ${JSON.stringify(builderSaw)}`);
  assert.equal(getBus().read(second).flatMap(e => (e.type === 'node_started' ? [e.node] : []))[0], 'qa');
});

test('fast-arch: a Builder that needs another design gets it from the Architect and carries on', { timeout: 60_000 }, async () => {
  const runs = new RunManager();
  const runId = runs.start({ requirement: readFileSync(join(TASK, 'requirement.md'), 'utf8'), source: join(TASK, 'seed'), profile: 'fake-archchange', autoApprove: true, pipeline: 'fast-arch' });
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

test('blind QA keeps the acceptance tests away from Dev and judges with them', { timeout: 60_000 }, async () => {
  const minimal = loadPipeline('minimal');
  const def: PipelineDef = { ...minimal, id: 'blind-test', steps: minimal.steps.map(s => (s.type === 'qa' ? { ...s, blind: true } : s)) };
  const runs = new RunManager();
  const seen: boolean[] = [];
  let workspace = '';
  getBus().subscribe(e => {
    if (e.type === 'run_started') { workspace = e.workspace; }
    if (e.type === 'node_started' && e.node === 'dev' && workspace) { seen.push(existsSync(join(workspace, 'acceptance'))); }
  });
  const runId = runs.start({ requirement: readFileSync(join(TASK, 'requirement.md'), 'utf8'), source: join(TASK, 'seed'), profile: 'fake-blind', autoApprove: true, pipeline: def });
  const status = await runs.waitFor(runId);
  const events = getBus().read(runId);
  assert.equal(status, 'approved', JSON.stringify(events.filter(e => e.type === 'log')));
  assert.ok(seen.length >= 3 && seen.every(x => x === false), 'Dev never had acceptance/ in its workspace');
  // The contract test passed, a hidden acceptance test caught the bug, and its failure reached Dev
  const verifies = events.filter(e => e.type === 'verify_result');
  assert.deepEqual(verifies.map(v => v.type === 'verify_result' && v.passed), [false, true, true]);
  assert.ok(verifies[0].type === 'verify_result' && verifies[0].commands?.some(c => c.includes('acceptance/cart-core')));
  const secondDev = events.filter(e => e.type === 'agent_input' && e.role === 'dev')[1];
  assert.ok(secondDev?.type === 'agent_input' && secondDev.prompt.includes('AC-1'), 'Dev sees which hidden behaviour failed');
  assert.ok(secondDev?.type === 'agent_input' && secondDev.prompt.includes('kept from you'));
  // The tests stay with the code for whoever changes it next
  assert.ok(existsSync(join(workspace, 'acceptance/cart-core/cart.test.ts')));
});

test('blind QA: a hidden test that fails twice in a row goes back to QA to check', { timeout: 60_000 }, async () => {
  const minimal = loadPipeline('minimal');
  const def: PipelineDef = { ...minimal, id: 'blind-wrong-test', steps: minimal.steps.map(s => (s.type === 'qa' ? { ...s, blind: true } : s)) };
  const runs = new RunManager();
  const runId = runs.start({ requirement: readFileSync(join(TASK, 'requirement.md'), 'utf8'), source: join(TASK, 'seed'), profile: 'fake-blind-wrong', autoApprove: true, pipeline: def });
  const status = await runs.waitFor(runId);
  const events = getBus().read(runId);
  assert.equal(status, 'approved', JSON.stringify(events.filter(e => e.type === 'log')));
  const stages = events.filter(e => e.type === 'node_started').map(e => e.type === 'node_started' && `${e.node}${e.module ? ':' + e.module : ''}`);
  assert.deepEqual(stages.slice(0, 9), ['planner', 'qa', 'dev:cart-core', 'verify:cart-core', 'dev:cart-core', 'verify:cart-core', 'qa:cart-core', 'dev:cart-core', 'verify:cart-core']);
  const qaIn = events.filter(e => e.type === 'agent_input' && e.role === 'qa')[1];
  assert.ok(qaIn?.type === 'agent_input' && qaIn.prompt.includes('failed on two attempts in a row'));
});

test('a conflict the agents cannot settle stops after two replans', { timeout: 90_000 }, async () => {
  const runs = new RunManager();
  const runId = runs.start({ requirement: readFileSync(join(TASK, 'requirement.md'), 'utf8'), source: join(TASK, 'seed'), profile: 'fake-conflict', autoApprove: true });
  const status = await runs.waitFor(runId);
  const events = getBus().read(runId);
  assert.equal(status, 'failed');
  assert.equal(events.filter(e => e.type === 'node_started' && e.node === 'planner').length, 3);
  const end = events.findLast(e => e.type === 'run_finished');
  assert.match(end?.type === 'run_finished' ? end.error ?? '' : '', /Stopped after 2 replans: .*need a human/);
});
