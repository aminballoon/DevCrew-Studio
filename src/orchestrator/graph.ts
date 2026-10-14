import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Annotation, END, interrupt, START, StateGraph } from '@langchain/langgraph';

import { runDir } from '../core/config';
import { usageByRole, type GateId } from '../core/events';
import { entryNode, loadPipeline, SYSTEM_DIAGRAM, type AgentStep, type GateStep, type PipelineDef, type Step } from '../pipeline/schema';
import { captureBaseline, countDeclaredTests, verify, type TestBaseline, type VerifyResult } from '../guard/verify';
import { commitAll, diffSince, prepareWorkspace, type Workspace } from '../guard/workspace';
import { readPlan, readText, type Plan } from './plan';
import { agentStepPrompt, devPrompt, plannerPrompt, qaDisputePrompt, qaPrompt } from './prompts';
import { requirementClauses } from './requirement';
import { collectReports, reportPaths } from './reports';
import { readSystem } from './system';
import { agentTurn, closeSessions, getBus, getConfig, isCancelled, type TurnContext } from './runtime';

export interface GateAnswer { decision: 'approve' | 'revise' | 'retry' | 'replan' | 'abort'; feedback?: string }

/** What a node decided, for routing: a gate answer, or a reviewer's verdict. */
type Decision = GateAnswer['decision'] | 'changes' | 'continue';

export type RunStatus = 'running' | 'approved' | 'aborted' | 'failed';

const last = <T>(fallback: () => T) => Annotation<T>({ reducer: (_a, b) => b, default: fallback });

export const PipelineState = Annotation.Root({
  // Input
  runId: last<string>(() => ''),
  requirement: last<string>(() => ''),
  /** Project to work on: a git repo gets a worktree, anything else is copied. Empty = new project. */
  source: last<string>(() => ''),
  profile: last<string>(() => ''),
  /** Benchmark mode: gates approve themselves. */
  autoApprove: last<boolean>(() => false),
  label: last<string>(() => ''),
  /** Things to tell you when the run starts, e.g. an agent that may lack a capability. */
  warnings: last<string[]>(() => []),
  // Progress
  workspace: last<Workspace | null>(() => null),
  plan: last<Plan | null>(() => null),
  /** Input for the next planner or dev turn (approver feedback or a reported spec issue). */
  feedback: last<string | null>(() => null),
  baseline: last<TestBaseline | null>(() => null),
  moduleIndex: last<number>(() => 0),
  attempt: last<number>(() => 0),
  lastVerify: last<VerifyResult | null>(() => null),
  allModulesDone: last<boolean>(() => false),
  specIssue: last<string | null>(() => null),
  /** The end of Dev's last reply, so QA hears Dev's side when checking a hidden test. */
  lastDevReport: last<string | null>(() => null),
  /** How many times Dev has disputed QA's tests, per module; past the limit a dispute goes to the Planner. */
  disputes: last<Record<string, number>>(() => ({})),
  /** Times the run went back to the Planner because the build could not go on. */
  replans: last<number>(() => 0),
  /** Report text of each step with a verdict, by step id. */
  reviews: last<Record<string, string>>(() => ({})),
  /** How many times each step has sent the work back to Dev. */
  rounds: last<Record<string, number>>(() => ({})),
  /**
   * The agent step a gate sent back with your feedback (in `feedback`). Every role re-run on the
   * way back to that gate sees the feedback; the Planner or the next gate clears it.
   */
  revisedTo: last<string | null>(() => null),
  decision: last<Decision | null>(() => null),
  status: last<RunStatus>(() => 'running'),
  /** Why the run failed, for runs that end through the graph rather than by an exception. */
  error: last<string | null>(() => null),
});

type S = typeof PipelineState.State;
type U = typeof PipelineState.Update;

/** Emits node_started/node_finished around a node, so the dashboard can draw progress. */
function node(name: string, fn: (s: S) => Promise<U>, detail?: (s: S) => { module?: string; attempt?: number }) {
  return async (s: S): Promise<U> => {
    if (isCancelled(s.runId)) { throw new Error('Run cancelled'); }
    getBus().emit(s.runId, { type: 'node_started', node: name, ...detail?.(s) });
    const update = await fn(s);
    if (isCancelled(s.runId)) { throw new Error('Run cancelled'); }
    getBus().emit(s.runId, { type: 'node_finished', node: name });
    return update;
  };
}

const ctx = (s: S, role: TurnContext['role'], io: TurnContext['io'], key?: string): TurnContext =>
  ({ runId: s.runId, profile: s.profile || getConfig().defaultProfile, workspace: s.workspace!.path, role, key, io });

/** How a step is named when another step hands work to it. */
function stepName(step: Step | undefined): string {
  if (!step) { return 'End of run'; }
  switch (step.type) {
    case 'planner': return 'Planner';
    case 'qa': return 'QA';
    case 'build': return 'Dev';
    case 'gate': return `${step.title} (you)`;
    case 'agent': return step.name;
  }
}

const PLAN_FILES = ['.devcrew/PRD.md', '.devcrew/plan.json', 'contracts/'];

/** Pause for the approver. Gate nodes re-run from the top on resume, so nothing before this may have side effects. */
function gate(s: S, gateId: GateId, payload: Record<string, unknown>): GateAnswer {
  const answer: GateAnswer = s.autoApprove ? { decision: 'approve' } : interrupt({ gate: gateId, ...payload });
  getBus().emit(s.runId, { type: 'gate_resolved', gate: gateId, decision: answer.decision, feedback: answer.feedback });
  return answer;
}

// --- Nodes ---

/** The role guide text a built-in step carries in this run, if any. */
// --- Blind QA: acceptance tests live outside the workspace except while QA writes them or Verify runs them ---

const isBlind = (def: PipelineDef) => def.steps.some(x => x.type === 'qa' && x.blind === true);
const ACCEPTANCE = 'acceptance';
const acceptanceStore = (s: S) => join(runDir(s.runId), ACCEPTANCE);

/** Takes acceptance/ out of the workspace, so Dev cannot read it. */
function hideAcceptance(s: S): void {
  const inWorkspace = join(s.workspace!.path, ACCEPTANCE);
  if (!existsSync(inWorkspace)) { return; }
  rmSync(acceptanceStore(s), { recursive: true, force: true });
  cpSync(inWorkspace, acceptanceStore(s), { recursive: true });
  rmSync(inWorkspace, { recursive: true, force: true });
}

/** Puts acceptance/ back, for QA to fix a test, for Verify to judge, or for the final commit. */
function showAcceptance(s: S): void {
  if (!existsSync(acceptanceStore(s))) { return; }
  const inWorkspace = join(s.workspace!.path, ACCEPTANCE);
  rmSync(inWorkspace, { recursive: true, force: true });
  cpSync(acceptanceStore(s), inWorkspace, { recursive: true });
}

/** The same command run against acceptance/ instead of tests/; null when the command does not name tests/. */
const acceptanceCommand = (command: string) => (command.includes('tests/') ? command.replaceAll('tests/', `${ACCEPTANCE}/`) : null);

const guideOf = (def: PipelineDef, type: 'planner' | 'qa' | 'build') => {
  const step = def.steps.find(x => x.type === type);
  return step && 'guideText' in step ? step.guideText : undefined;
};

const planner = (def: PipelineDef) => node('planner', async s => {
  const io = {
    from: ['You: the task', ...(s.specIssue ? ['Dev: a spec problem'] : s.feedback ? ['You: feedback from a gate'] : [])],
    reads: [],
    to: [stepName(def.steps[def.steps.findIndex(x => x.type === 'planner') + 1]), 'then QA and Dev'],
  };
  const earlier = reportPaths(def, def.steps.findIndex(x => x.type === 'planner'));
  const clauses = requirementClauses(s.requirement);
  await agentTurn(ctx(s, 'planner', { ...io, reads: earlier }), plannerPrompt(s.requirement, s.feedback, earlier, clauses, guideOf(def, 'planner')));
  // Two chances to fix a malformed or incomplete plan before failing the run
  for (let fix = 0; ; fix++) {
    try {
      return { plan: readPlan(s.workspace!.path, clauses), feedback: null, revisedTo: null, replans: s.plan && !s.revisedTo ? s.replans + 1 : s.replans };
    } catch (e) {
      if (fix === 2) { throw e; }
      await agentTurn({ ...ctx(s, 'planner', { ...io, from: ['System: the plan file was invalid'] }), continues: true }, `Your plan is unusable: ${(e as Error).message}. Fix .devcrew/PRD.md and .devcrew/plan.json.`);
    }
  }
});

const qa = (def: PipelineDef) => node('qa', async s => {
  closeSessions(s.runId, 'dev');
  const earlier = reportPaths(def, def.steps.findIndex(x => x.type === 'qa'));
  const io = { from: ['You: the requirement', 'Planner: spec, contracts and module list'], reads: [...PLAN_FILES, ...earlier], to: ['Dev (build against them)', 'Verify (judge with them)'] };
  const blind = isBlind(def);
  const turn = await agentTurn(ctx(s, 'qa', io), qaPrompt(s.plan!, earlier, s.requirement, requirementClauses(s.requirement), guideOf(def, 'qa'), { blind }));
  // QA reports broken tools instead of fixing them; surface each one where a person will see it
  for (const m of turn.text.matchAll(/^HARNESS_ISSUE:\s*(.+)$/gm)) {
    getBus().emit(s.runId, { type: 'log', level: 'warn', message: `QA found a problem outside the tests: ${m[1]}` });
  }
  if (countDeclaredTests(s.workspace!.path) === 0) {
    await agentTurn({ ...ctx(s, 'qa', { ...io, from: ['System: no tests were found'] }), continues: true }, 'No test cases were found under tests/. Write the tests now.');
  }
  if (blind) {
    if (countDeclaredTests(s.workspace!.path, `${ACCEPTANCE}/`) === 0) {
      await agentTurn({ ...ctx(s, 'qa', { ...io, from: ['System: no acceptance tests were found'] }), continues: true }, `No test cases were found under ${ACCEPTANCE}/. Write the acceptance tests now.`);
    }
    hideAcceptance(s);
  }
  const baseline = captureBaseline(s.workspace!.path);
  if (baseline.declared === 0) { throw new Error('QA wrote no tests'); }
  return { baseline, moduleIndex: 0, attempt: 0, allModulesDone: false, lastVerify: null, disputes: {} };
});

/** At most this many test disputes per module go to QA; more mean the plan itself is unclear. */
export const MAX_DISPUTES = 2;

/**
 * At most this many trips back to the Planner from the build. A conflict that survives them is
 * in the requirement or its fixed tests, and only a human can settle it, so the run stops there.
 */
export const MAX_REPLANS = 2;

const stuck = node('stuck', async s => {
  throw new Error(`Stopped after ${s.replans} replans: the requirement or its tests need a human decision. Last problem: ${(s.feedback ?? s.specIssue ?? 'unknown').slice(0, 500)}`);
});

/**
 * Dev says a test cannot be passed. QA checks it against the requirement and fixes it if it is
 * wrong, so one bad test costs one QA turn instead of a new plan, new tests and every module again.
 */
const qaDispute = (def: PipelineDef) => node('qa', async s => {
  const module = s.plan!.modules[s.moduleIndex];
  const io = { from: ['Dev: a test it says cannot be passed'], reads: [...PLAN_FILES, `tests/${module.id}/`], to: ['Dev (tries again)'] };
  const blind = isBlind(def);
  if (blind) { showAcceptance(s); }
  const turn = await agentTurn(ctx(s, 'qa', io), qaDisputePrompt(module, s.specIssue ?? '', s.lastVerify, s.requirement, requirementClauses(s.requirement)));
  if (blind) { hideAcceptance(s); }
  const disputes = { ...s.disputes, [module.id]: (s.disputes[module.id] ?? 0) + 1 };
  const planIssue = turn.text.match(/^PLAN_ISSUE:\s*(.+)$/m)?.[1];
  if (planIssue) {
    return { disputes, feedback: `QA and the developer found a problem in the plan for module "${module.id}": ${planIssue}` };
  }
  const answer = turn.text.match(/^QA_ANSWER:\s*(.+)$/m)?.[1] ?? turn.text.trim().split('\n').slice(-3).join(' ');
  // QA may have changed tests: they are the new locked version
  const baseline = captureBaseline(s.workspace!.path);
  getBus().emit(s.runId, { type: 'log', level: 'info', message: `QA answered a test dispute in ${module.id}: ${answer.slice(0, 300)}` });
  return {
    disputes, baseline, specIssue: null,
    feedback: `You reported: ${s.specIssue}\nQA checked the tests and answered: ${answer}\nThe tests in tests/ are now final for this module. Make them pass.`,
  };
}, s => ({ module: s.plan!.modules[s.moduleIndex].id }));

const dev = (def: PipelineDef) => node('dev', async s => {
  const module = s.plan!.modules[s.moduleIndex];
  const earlier = reportPaths(def, def.steps.findIndex(x => x.type === 'build'));
  const attempt = s.attempt + 1;
  const io = {
    from: [
      'Planner: spec and contracts',
      `QA: tests for ${module.id}`,
      ...(attempt > 1 && s.lastVerify ? ['Verify: why the last attempt failed'] : []),
      ...(s.feedback ? ['Feedback: changes asked by a reviewer or by you'] : []),
    ],
    reads: ['.devcrew/PRD.md', 'contracts/', `tests/${module.id}/`, ...earlier],
    to: ['Verify'],
  };
  const turn = await agentTurn(ctx(s, 'dev', io, module.id), devPrompt(s.plan!, module, attempt, s.lastVerify, s.feedback, earlier, s.requirement, requirementClauses(s.requirement), guideOf(def, 'build'), { blind: isBlind(def) }));
  const issue = turn.text.match(/^SPEC_ISSUE:\s*(.+)$/m)?.[1] ?? null;
  return {
    attempt,
    feedback: issue ? `The developer reported a spec issue in module "${module.id}": ${issue}` : null,
    specIssue: issue,
    lastDevReport: turn.text.trim().slice(-1500),
  };
}, s => ({ module: s.plan!.modules[s.moduleIndex].id, attempt: s.attempt + 1 }));

const verifyNode = (def: PipelineDef) => node('verify', async s => {
  const plan = s.plan!;
  const ws = s.workspace!.path;
  const module = plan.modules[s.moduleIndex];
  const isLast = s.moduleIndex === plan.modules.length - 1;
  const moduleTests = countDeclaredTests(ws, `tests/${module.id}/`);

  // A module is judged by its own tests; the last one also by the whole suite (regressions)
  const runs: VerifyResult[] = [];
  const commands: string[] = [];
  if (plan.moduleTestCommand && moduleTests > 0) {
    commands.push(plan.moduleTestCommand.replaceAll('{module}', module.id));
    runs.push(await verify({ workspace: ws, testCommand: commands[0], baseline: s.baseline!, expectedTests: moduleTests, testFormats: plan.testFormats }));
  }
  // Blind QA: the hidden acceptance tests judge the module too, and only exist in the workspace meanwhile
  let acceptanceModuleRun = false;
  if (isBlind(def)) {
    showAcceptance(s);
    try {
      const moduleCommand = plan.moduleTestCommand && acceptanceCommand(plan.moduleTestCommand.replaceAll('{module}', module.id));
      const moduleAcceptance = countDeclaredTests(ws, `${ACCEPTANCE}/${module.id}/`);
      if (moduleCommand && moduleAcceptance > 0) {
        commands.push(moduleCommand);
        runs.push(await verify({ workspace: ws, testCommand: moduleCommand, baseline: s.baseline!, expectedTests: moduleAcceptance, testFormats: plan.testFormats }));
        acceptanceModuleRun = true;
      }
      // The last module is also judged by every module's acceptance tests (regressions)
      const allCommand = acceptanceCommand(plan.testCommand);
      if (isLast && allCommand) {
        commands.push(allCommand);
        runs.push(await verify({ workspace: ws, testCommand: allCommand, baseline: s.baseline!, expectedTests: countDeclaredTests(ws, `${ACCEPTANCE}/`), testFormats: plan.testFormats }));
      } else if (isLast && plan.moduleTestCommand) {
        for (const other of plan.modules.filter(m => m.id !== module.id)) {
          const command = acceptanceCommand(plan.moduleTestCommand.replaceAll('{module}', other.id));
          const expected = countDeclaredTests(ws, `${ACCEPTANCE}/${other.id}/`);
          if (!command || expected === 0) { continue; }
          commands.push(command);
          runs.push(await verify({ workspace: ws, testCommand: command, baseline: s.baseline!, expectedTests: expected, testFormats: plan.testFormats }));
        }
      } else if (!allCommand && !plan.moduleTestCommand) {
        getBus().emit(s.runId, { type: 'log', level: 'warn', message: `Neither test command names tests/, so the acceptance tests cannot be run: ${plan.testCommand}` });
      }
    } finally {
      hideAcceptance(s);
    }
  }
  if (isLast || runs.length === 0) {
    commands.push(plan.testCommand, ...(isLast ? plan.checks ?? [] : []).map(c => c.command));
    runs.push(await verify({ workspace: ws, testCommand: plan.testCommand, baseline: s.baseline!, checks: isLast ? plan.checks : [], testFormats: plan.testFormats }));
  }
  // Without per-module tests, earlier modules cannot pass alone: only judge at the end
  const deferred = runs.length === 1 && !isLast && !(plan.moduleTestCommand && moduleTests > 0) && !acceptanceModuleRun;
  const result: VerifyResult = {
    passed: deferred || runs.every(r => r.passed),
    tests: runs[runs.length - 1].tests,
    reasons: deferred ? [] : runs.flatMap(r => r.reasons),
    output: runs.map(r => r.output).join('\n\n'),
  };
  getBus().emit(s.runId, { type: 'verify_result', module: module.id, attempt: s.attempt, passed: result.passed, tests: result.tests, reasons: result.reasons, output: result.output.slice(-6000), commands });
  if (result.passed && !isLast) {
    return { lastVerify: result, moduleIndex: s.moduleIndex + 1, attempt: 0, feedback: null };
  }
  // Blind QA: Dev cannot see a hidden test to argue with it. When the same tests fail twice in a
  // row, QA checks them against the requirement before Dev tries again.
  if (!result.passed && isBlind(def) && s.lastVerify && !s.lastVerify.passed && (s.disputes[module.id] ?? 0) < MAX_DISPUTES) {
    const now = failingTests(result.output);
    const before = failingTests(s.lastVerify.output);
    if (now.length && now.length === before.length && now.every(t => before.includes(t))) {
      return {
        lastVerify: result, allModulesDone: false, feedback: null,
        specIssue: `The same hidden test${now.length > 1 ? 's' : ''} failed on two attempts in a row, and the developer cannot see ${now.length > 1 ? 'them' : 'it'}: ${now.join('; ')}. The developer's last report:\n${s.lastDevReport ?? '(none)'}`,
      };
    }
  }
  return { lastVerify: result, allModulesDone: result.passed && isLast, feedback: null };
}, s => ({ module: s.plan!.modules[s.moduleIndex].id, attempt: s.attempt }));

/** Names of failing tests in node --test style output (✖ name (time)). */
function failingTests(output: string): string[] {
  const names = new Set<string>();
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*✖ (.+) \([\d.]+m?s\)$/);
    if (m && m[1] !== 'failing tests:') { names.add(m[1]); }
  }
  return [...names];
}

const escalate = async (s: S): Promise<U> => {
  const module = s.plan!.modules[s.moduleIndex];
  // Unattended (benchmark) runs have nobody to escalate to: out of attempts means failed
  if (s.autoApprove) {
    getBus().emit(s.runId, { type: 'gate_resolved', gate: 'escalation', decision: 'abort', feedback: 'Out of fix attempts (unattended run)' });
    const why = s.lastVerify?.reasons.join('; ') || 'tests still failing';
    return { decision: 'abort', status: 'failed', error: `Module "${module.id}" still failing after ${s.attempt} attempts: ${why}` };
  }
  const answer = gate(s, 'escalation', {
    kind: 'escalation',
    title: `Module "${module.id}" still failing after ${s.attempt} attempts`,
    module: module.id,
    attempts: s.attempt,
    reasons: s.lastVerify?.reasons ?? [],
    output: s.lastVerify?.output.slice(-4000) ?? '',
  });
  if (answer.decision === 'retry') { return { decision: 'retry', attempt: 0, feedback: answer.feedback ?? null }; }
  if (answer.decision === 'replan') { return { decision: 'replan', feedback: answer.feedback ?? `Module "${module.id}" could not be made to pass: ${s.lastVerify?.reasons.join('; ')}` }; }
  return { decision: 'abort', status: 'aborted' };
};

/** A role defined in the pipeline file, with its own scope, agent and optional verdict. */
const agentNode = (step: AgentStep, nextStep: Step | undefined) => node(step.id, async s => {
  const sentBack = s.rounds[step.id] ?? 0;
  const sendsBack = step.verdict?.onChanges === 'dev';
  const io = {
    from: step.reads.map(r => (r === 'git diff' ? 'Dev: all code changes' : PLAN_FILES.includes(r) ? `Planner: ${r}` : r)),
    reads: step.reads.filter(r => r !== 'git diff'),
    to: [...(sendsBack ? ['Dev, if something must be fixed'] : []), stepName(nextStep)],
  };
  const gateFeedback = s.revisedTo ? s.feedback : null;
  if (gateFeedback) { io.from.unshift('You: feedback from a gate'); }
  const turn = { ...ctx(s, step.id, io), scope: { write: step.mayWrite, deny: [] }, agentName: step.agent };
  await agentTurn(turn, agentStepPrompt(step, {
    requirement: s.requirement,
    baseCommit: s.workspace!.baseCommit,
    round: sentBack + 1,
    feedback: sentBack ? s.reviews[step.id] ?? null : null,
    gateFeedback,
    clauses: requirementClauses(s.requirement),
  }));
  // One chance to fix a diagram the dashboard cannot draw
  const diagramProblems = step.mayWrite.some(p => p === SYSTEM_DIAGRAM || (p.endsWith('/') && SYSTEM_DIAGRAM.startsWith(p))) ? readSystem(s.workspace!.path).errors : [];
  if (diagramProblems.length) {
    await agentTurn({ ...turn, io: { ...io, from: ['System: the diagram file was invalid'] }, continues: true }, `${SYSTEM_DIAGRAM} cannot be drawn:\n${diagramProblems.map(e => `- ${e}`).join('\n')}\nFix the file.`);
  }
  if (!step.verdict) { return { decision: 'continue' }; }

  const text = readText(s.workspace!.path, step.verdict.file);
  if (!text) { getBus().emit(s.runId, { type: 'log', level: 'warn', message: `${step.name} did not write ${step.verdict.file}; treating it as no findings.` }); }
  const verdict = text?.match(/^VERDICT:\s*(approve|changes)\b/m)?.[1] ?? 'approve';
  const reviews = text ? { ...s.reviews, [step.id]: text } : s.reviews;
  if (verdict === 'changes' && sendsBack && sentBack < (step.verdict.maxRounds ?? 1)) {
    return {
      reviews,
      rounds: { ...s.rounds, [step.id]: sentBack + 1 },
      decision: 'changes',
      feedback: `The ${step.name} found problems that must be fixed (see ${step.verdict.file}):\n${text}`,
      attempt: 0,
      allModulesDone: false,
      revisedTo: null,
    };
  }
  return { reviews, decision: 'continue' };
});

/** A pause for you: review the plan (spec and architecture) or the code (diff, tests, reviews). */
const gateNode = (def: PipelineDef, step: GateStep) => async (s: S): Promise<U> => {
  const isLast = def.steps[def.steps.length - 1].id === step.id;
  // Every report written by the agent steps before this gate
  const reports = collectReports(s.workspace!.path, def, def.steps.findIndex(x => x.id === step.id));
  let payload: Record<string, unknown>;
  if (step.review === 'plan') {
    payload = {
      prd: readText(s.workspace!.path, '.devcrew/PRD.md'),
      plan: s.plan,
      clauses: requirementClauses(s.requirement),
      contracts: diffSince(s.workspace!).files.filter(f => f.path.startsWith('contracts/')).map(f => f.path),
      specIssue: s.specIssue,
      reports,
    };
  } else if (step.review === 'design') {
    const { system, errors } = readSystem(s.workspace!.path);
    payload = {
      system,
      systemErrors: errors,
      reports,
      files: diffSince(s.workspace!).files,
      usage: usageByRole(getBus().read(s.runId)),
      branch: s.workspace!.branch,
    };
  } else {
    const diff = diffSince(s.workspace!);
    const reviews = def.steps.flatMap(x => (x.type === 'agent' && s.reviews[x.id] ? [{ step: x.id, name: x.name, text: s.reviews[x.id] }] : []));
    payload = {
      // Reports from roles without a verdict (research, rigs...); verdicts are in `reviews`
      reports: reports.filter(r => !s.reviews[r.step]),
      files: diff.files,
      patch: diff.patch.slice(0, 60_000),
      tests: s.lastVerify?.tests,
      reviews,
      review: reviews[0]?.text ?? null,
      usage: usageByRole(getBus().read(s.runId)),
      branch: s.workspace!.branch,
    };
  }
  const answer = gate(s, step.id, { kind: step.review, title: step.title, ...payload });
  if (answer.decision === 'approve') {
    if (isLast) {
      // The acceptance tests stay with the code, for whoever changes it next
      if (isBlind(def)) { showAcceptance(s); }
      commitAll(s.workspace!, `DevCrew run ${s.runId}: ${s.requirement.split('\n')[0].slice(0, 60)}`);
      return { decision: 'approve', status: 'approved' };
    }
    return { decision: 'approve', feedback: answer.feedback ?? null, specIssue: null, revisedTo: null };
  }
  if (answer.decision === 'revise') {
    const target = def.steps.find(x => x.id === step.reviseTo)!;
    if (target.type === 'build') {
      // Back to the last module's developer with your notes
      return { decision: 'revise', feedback: answer.feedback ?? 'Address the review findings.', attempt: 0, allModulesDone: false, specIssue: null };
    }
    return { decision: 'revise', feedback: answer.feedback ?? null, specIssue: null, revisedTo: target.type === 'agent' ? target.id : null };
  }
  return { decision: 'abort', status: 'aborted' };
};

const setup = (def: PipelineDef) => async (s: S): Promise<U> => {
  if (s.workspace) { return {}; }
  const runId = s.runId || randomUUID().slice(0, 8);
  const profile = s.profile || getConfig().defaultProfile;
  const workspace = prepareWorkspace(s.source || undefined, runId);
  getBus().emit(runId, { type: 'run_started', requirement: s.requirement, workspace: workspace.path, mode: 'pipeline', profile, label: s.label || undefined, pipeline: def });
  for (const message of s.warnings) { getBus().emit(runId, { type: 'log', level: 'warn', message }); }
  return { runId, profile, workspace };
};

const finish = async (s: S): Promise<U> => {
  closeSessions(s.runId);
  getBus().emit(s.runId, { type: 'run_finished', status: s.status === 'running' ? 'completed' : s.status, ...(s.status === 'failed' ? { error: s.error ?? 'unknown' } : {}) });
  return {};
};

// --- Graph ---

/**
 * Build the graph for a pipeline definition. Node names are the step ids, plus
 * dev / verify / escalate for the build step, so the standard pipeline keeps the
 * node names runs have always used.
 */
export function buildGraph(def: PipelineDef = loadPipeline('standard')) {
  const steps = def.steps;
  const at = (id: string) => steps.findIndex(x => x.id === id);
  const next = (id: string) => steps[at(id) + 1];
  const nextNode = (id: string) => (next(id) ? entryNode(next(id)!) : 'finish');
  const build = steps.find(x => x.type === 'build');
  const maxAttempts = (build?.type === 'build' && build.maxAttempts) || getConfig().maxFixAttempts;

  // Node names come from the file, so the graph is assembled without static typing
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: any = new StateGraph(PipelineState);
  g.addNode('setup', setup(def)).addNode('finish', finish).addEdge(START, 'setup').addEdge('setup', entryNode(steps[0])).addEdge('finish', END);

  for (const step of steps) {
    switch (step.type) {
      case 'planner':
        g.addNode('planner', planner(def)).addEdge('planner', nextNode('planner'));
        break;
      case 'qa':
        g.addNode('qa', qa(def)).addEdge('qa', nextNode('qa'));
        break;
      case 'build': {
        const after = nextNode('build');
        const hasQa = steps.some(x => x.type === 'qa');
        const replan = (s: S) => (s.replans >= MAX_REPLANS ? 'stuck' : 'planner');
        g.addNode('dev', dev(def)).addNode('stuck', stuck).addNode('verify', verifyNode(def)).addNode('escalate', escalate)
          .addConditionalEdges('dev', (s: S) => {
            if (!s.specIssue) { return 'verify'; }
            const module = s.plan!.modules[s.moduleIndex].id;
            return hasQa && (s.disputes[module] ?? 0) < MAX_DISPUTES ? 'dispute' : replan(s);
          }, ['verify', 'planner', 'stuck', ...(hasQa ? ['dispute'] : [])]);
        if (hasQa) {
          g.addNode('dispute', qaDispute(def))
            .addConditionalEdges('dispute', (s: S) => (s.specIssue ? replan(s) : 'dev'), ['dev', 'planner', 'stuck']);
        }
        g
          .addConditionalEdges('verify', (s: S) => {
            if (s.allModulesDone) { return after; }
            if (s.lastVerify?.passed) { return 'dev'; }
            if (hasQa && s.specIssue) { return 'dispute'; }
            return s.attempt >= maxAttempts ? 'escalate' : 'dev';
          }, [...new Set([after, 'dev', 'escalate', ...(hasQa ? ['dispute'] : [])])])
          .addConditionalEdges('escalate', (s: S) => (s.decision === 'retry' ? 'dev' : s.decision === 'replan' ? replan(s) : 'finish'), ['dev', 'planner', 'stuck', 'finish']);
        break;
      }
      case 'gate': {
        const after = nextNode(step.id);
        const back = entryNode(steps.find(x => x.id === step.reviseTo)!);
        g.addNode(step.id, gateNode(def, step))
          .addConditionalEdges(step.id, (s: S) => (s.decision === 'approve' ? after : s.decision === 'revise' ? back : 'finish'), [...new Set([after, back, 'finish'])]);
        break;
      }
      case 'agent': {
        const after = nextNode(step.id);
        // Only steps after build can send work back to Dev (the validator enforces it)
        const canSendBack = step.verdict?.onChanges === 'dev' && build;
        g.addNode(step.id, agentNode(step, next(step.id)))
          .addConditionalEdges(step.id, (s: S) => (canSendBack && s.decision === 'changes' ? 'dev' : after), canSendBack ? [...new Set([after, 'dev'])] : [after]);
        break;
      }
    }
  }
  return g as StateGraph<typeof PipelineState.spec>;
}

/** Entry point for LangGraph Studio (`npm run studio`); Studio supplies its own checkpointer. */
export const graph = buildGraph().compile();
