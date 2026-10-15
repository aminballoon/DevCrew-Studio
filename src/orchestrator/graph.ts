import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Annotation, END, interrupt, START, StateGraph } from '@langchain/langgraph';

import { runDir } from '../core/config';
import { ROLE_SCOPES } from '../core/scope';
import { usageByRole, type GateId } from '../core/events';
import { entryNode, loadPipeline, SYSTEM_DIAGRAM, type AgentStep, type GateStep, type PipelineDef, type Step } from '../pipeline/schema';
import { ARCHITECTURE_DOC, ARCHITECTURE_FILE, checkArchitecture, readArchitecture } from '../guard/architecture';
import { NOT_AUTHORED, takeSnapshot } from '../guard/snapshot';
import { captureBaseline, countDeclaredTests, verify, type TestBaseline, type VerifyResult } from '../guard/verify';
import { commitAll, diffSince, prepareWorkspace, type Workspace } from '../guard/workspace';
import { readTestRun, readText, type TestRun } from './testRun';
import { ACCEPTANCE_RUN, agentStepPrompt, filesBlock, BUILDER_TESTS, builderFixPrompt, builderPrompt, fastQaPrompt, qaDisputePrompt } from './prompts';
import { requirementClauses } from './requirement';
import { collectReports } from './reports';
import { readSystem } from './system';
import { agentTurn, closeSessions, getBus, getConfig, isCancelled, type TurnContext } from './runtime';

export interface GateAnswer { decision: 'approve' | 'revise' | 'retry' | 'abort'; feedback?: string }

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
  /** How to run the Builder's own tests, as it last wrote them. */
  builderRun: last<TestRun | null>(() => null),
  /** Input for the Builder's next turn, or for the step a gate sent back (feedback or a reported issue). */
  feedback: last<string | null>(() => null),
  baseline: last<TestBaseline | null>(() => null),
  attempt: last<number>(() => 0),
  lastVerify: last<VerifyResult | null>(() => null),
  allModulesDone: last<boolean>(() => false),
  specIssue: last<string | null>(() => null),
  /** The end of Dev's last reply, so QA hears Dev's side when checking a hidden test. */
  lastDevReport: last<string | null>(() => null),
  /** How many times QA has checked a hidden test the Builder disputed; past the limit a person decides. */
  disputes: last<number>(() => 0),
  /** Fast pipeline: how to run QA's hidden acceptance tests. */
  acceptanceRun: last<TestRun | null>(() => null),
  /** Fast pipeline: the Builder says the requirement does not fit the architecture; a person decides. */
  archChange: last<string | null>(() => null),
  /** How many times the Architect changed the design for the Builder in this run. */
  archChanges: last<number>(() => 0),
  /** Report text of each step with a verdict, by step id. */
  reviews: last<Record<string, string>>(() => ({})),
  /** How many times each step has sent the work back to Dev. */
  rounds: last<Record<string, number>>(() => ({})),
  /**
   * The agent step a gate sent back with your feedback (in `feedback`). Every role re-run on the
   * way back to that gate sees the feedback; the next gate clears it.
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
    case 'qa': return 'QA';
    case 'build': return 'Dev';
    case 'gate': return `${step.title} (you)`;
    case 'agent': return step.name;
  }
}

/** Pause for the approver. Gate nodes re-run from the top on resume, so nothing before this may have side effects. */
function gate(s: S, gateId: GateId, payload: Record<string, unknown>): GateAnswer {
  const answer: GateAnswer = s.autoApprove ? { decision: 'approve' } : interrupt({ gate: gateId, ...payload });
  getBus().emit(s.runId, { type: 'gate_resolved', gate: gateId, decision: answer.decision, feedback: answer.feedback });
  return answer;
}

// --- Nodes ---

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

const MAX_PASTED_CHARS = 80_000;
function pasteFiles(workspace: string, prefixes: string[]): [string, string][] {
  const files: [string, string][] = [];
  for (const [path, buf] of takeSnapshot(workspace)) {
    if (prefixes.some(p => path === p || (p.endsWith('/') && path.startsWith(p)))) { files.push([path, buf.toString('utf8')]); }
  }
  files.sort(([a], [b]) => prefixes.findIndex(p => a.startsWith(p)) - prefixes.findIndex(p => b.startsWith(p)) || a.localeCompare(b));
  return files.some(([, t]) => t.includes('\u0000')) || files.reduce((n, [, t]) => n + t.length, 0) > MAX_PASTED_CHARS ? [] : files;
}

/** The run's changes for a prompt, or nothing when they are too big to paste. */
function pastedDiff(ws: Workspace): string | undefined {
  const { patch } = diffSince(ws);
  return patch && patch.length <= MAX_PASTED_CHARS ? patch : undefined;
}

/** The role guide text a built-in step carries in this run, if any. */
const guideOf = (def: PipelineDef, type: 'qa' | 'build') => {
  const step = def.steps.find(x => x.type === type);
  return step && 'guideText' in step ? step.guideText : undefined;
};

/** At most this many hidden-test disputes go to QA; more mean a person should look. */
export const MAX_DISPUTES = 2;

/**
 * The Builder says a hidden test cannot be passed, or the same one failed twice. QA checks it
 * against the requirement and fixes it if it is wrong; a conflict in the requirement goes to you.
 */
const qaDispute = node('qa', async s => {
  const io = { from: ['Builder: a hidden test it says cannot be passed'], reads: [`${ACCEPTANCE}/`], to: ['Builder (tries again)'] };
  showAcceptance(s);
  // tests/ belongs to the Builder: QA only answers for its hidden tests
  const turn = await agentTurn({ ...ctx(s, 'qa', io), scope: { write: [`${ACCEPTANCE}/`], deny: [] } }, qaDisputePrompt(s.specIssue ?? '', s.lastVerify, s.requirement, requirementClauses(s.requirement)));
  hideAcceptance(s);
  const disputes = s.disputes + 1;
  const conflict = turn.text.match(/^REQUIREMENT_ISSUE:\s*(.+)$/m)?.[1];
  if (conflict) {
    return { disputes, feedback: `QA and the Builder found a conflict in the requirement: ${conflict}` };
  }
  const answer = turn.text.match(/^QA_ANSWER:\s*(.+)$/m)?.[1] ?? turn.text.trim().split('\n').slice(-3).join(' ');
  // QA may have changed tests: they are the new locked version
  const baseline = captureBaseline(s.workspace!.path);
  getBus().emit(s.runId, { type: 'log', level: 'info', message: `QA answered a test dispute: ${answer.slice(0, 300)}` });
  return {
    disputes, baseline, specIssue: null,
    feedback: `You reported: ${s.specIssue}\nQA checked the hidden tests and answered: ${answer}\nThey are now final. Make them pass.`,
  };
}, () => ({ module: MAIN.id }));

/**
 * Blind QA: Dev cannot see a hidden test to argue with it. When the same tests fail twice in a
 * row, QA checks them against the requirement before Dev tries again.
 */
function repeatedHiddenFailure(s: S, result: VerifyResult): string | null {
  if (result.passed || !s.lastVerify || s.lastVerify.passed || s.disputes >= MAX_DISPUTES) { return null; }
  const now = failingTests(result.output);
  const before = failingTests(s.lastVerify.output);
  if (!now.length || now.length !== before.length || !now.every(t => before.includes(t))) { return null; }
  return `The same hidden test${now.length > 1 ? 's' : ''} failed on two attempts in a row, and the developer cannot see ${now.length > 1 ? 'them' : 'it'}: ${now.join('; ')}. The developer's last report:\n${s.lastDevReport ?? '(none)'}`;
}

/** How each supported test tool names a failing test, so the same failure can be spotted twice. */
const FAILING_TEST = [
  /^\s*✖ (.+) \([\d.]+m?s\)$/, // node --test
  /^FAILED (\S+)/, // pytest -v / summary
  /^(\S+:\d+: \w+).*\[FAILED\]/, // Unity through pio test
  /^\S+:\d+:(\w+):FAIL/, // plain Unity
  /HIL:FAIL (\S+?):?(?:\s|$)/, // firmware on the board
  /^test (\S+) \.\.\. FAILED$/, // cargo test
  /^--- FAIL: (\S+)/, // go test -v
  /^not ok \d+ (?:- )?(.+)$/, // TAP
];

/** Names of failing tests in the output of any supported test tool. */
export function failingTests(output: string): string[] {
  const names = new Set<string>();
  for (const line of output.split('\n')) {
    for (const re of FAILING_TEST) {
      const m = line.match(re);
      if (m && m[1] !== 'failing tests:') { names.add(m[1].trim()); break; }
    }
  }
  return [...names];
}

// --- The build: the Builder and a blind QA start together; Verify judges with both test sets ---

const isFast = (def: PipelineDef) => def.kind === 'fast';

/** Why the architecture file cannot be enforced, or null when it is missing problems (or missing). */
function architectureProblem(ws: string): string | null {
  try { return readArchitecture(ws) ? null : `${ARCHITECTURE_FILE} was not written`; } catch (e) { return (e as Error).message; }
}

/** Verify's reasons for imports that break the project's architecture (none when it has no architecture). */
function architectureReasons(ws: string): string[] {
  try {
    const result = checkArchitecture(ws);
    if (!result) { return []; }
    const shown = result.problems.slice(0, 20).map(p => `Architecture: ${p}`);
    return result.problems.length > 20 ? [...shown, `Architecture: ${result.problems.length - 20} more imports break the rules`] : shown;
  } catch (e) {
    return [`Architecture: ${(e as Error).message}`];
  }
}

/** The architecture files, pasted for the Builder; none when the project has no architecture. */
const architectureFiles = (ws: string) => (existsSync(join(ws, ARCHITECTURE_FILE)) ? pasteFiles(ws, [ARCHITECTURE_FILE, ARCHITECTURE_DOC, 'contracts/']) : []);

/**
 * The Builder writes everything except QA's hidden tests, what the research roles left (a test rig
 * it could otherwise bend to pass) and, once there is one, the architecture it builds in.
 */
export const builderScope = (def: PipelineDef, ws: string) => ({
  write: ROLE_SCOPES.dev.write,
  // contracts/ stays the Builder's to extend: frozen, it fell behind the code in every later change (roadmap-self)
  deny: [...ROLE_SCOPES.dev.deny, ...researchPaths(def), ...(existsSync(join(ws, ARCHITECTURE_FILE)) ? [ARCHITECTURE_FILE, ARCHITECTURE_DOC] : [])],
});

/** A Builder's answer that says the requirement needs another architecture. */
const archChangeIn = (text: string) => text.match(/^ARCH_CHANGE:\s*(.+)$/m)?.[1] ?? null;

/** At most this many architecture changes per run go to the Architect; more mean a person should look. */
export const MAX_ARCH_CHANGES = 2;

/** The fast pipeline's Architect step, when it has one. */
const architectOf = (def: PipelineDef) => def.steps.find(x => x.type === 'agent' && x.instructions === 'builtin:architect')?.id ?? null;
/** Where the build starts: the Architect while the project has no architecture, otherwise QA and the Builder. */
const buildEntry = (def: PipelineDef) => {
  const architect = architectOf(def);
  return {
    to: (s: S) => (architect && !existsSync(join(s.workspace!.path, ARCHITECTURE_FILE)) ? architect : 'qa'),
    targets: architect ? [architect, 'qa'] : ['qa'],
  };
};
/** What the research roles before QA write (add-ons such as the codebase analyst or the HIL rig). */
const researchPaths = (def: PipelineDef) =>
  def.steps.slice(0, def.steps.findIndex(x => x.type === 'qa')).flatMap(x => (x.type === 'agent' && x.instructions !== 'builtin:architect' ? x.mayWrite : []));
/** Their reports, for the Builder and QA. */
const researchReports = (def: PipelineDef, ws: string) => pasteFiles(ws, researchPaths(def));

/** What a Builder's answer hands on: an architecture change goes to the Architect as its feedback. */
const builderAsks = (def: PipelineDef, s: S, text: string) => {
  const archChange = archChangeIn(text);
  return archChange && architectOf(def) && s.archChanges < MAX_ARCH_CHANGES
    ? { archChange, feedback: `The Builder needs this change to the architecture to build the requirement: ${archChange}`, revisedTo: architectOf(def) }
    : { archChange, revisedTo: null };
};
/** The one unit of work a build is judged as, in events and in QA's dispute prompt. */
const MAIN = { id: 'main', title: 'Build', description: 'Everything the requirement asks for.' };

/** Reads a test run file, giving the agent one follow-up turn to fix it. */
async function testRunOf(turn: TurnContext, rel: string): Promise<TestRun> {
  try { return readTestRun(turn.workspace, rel); } catch (e) {
    await agentTurn({ ...turn, continues: true }, `${(e as Error).message}. Write ${rel} as asked: { "testCommand": "...", "testFormats": [...] }.`);
    return readTestRun(turn.workspace, rel);
  }
}

/**
 * The Builder and QA work at the same time. QA works in its own copy of the project, so neither
 * turn's scope guard sees the other's files, and its tests never enter the Builder's workspace.
 */
const fastWork = (def: PipelineDef) => node('qa', async s => {
  const ws = s.workspace!.path;
  const clauses = requirementClauses(s.requirement);
  const copy = join(runDir(s.runId), 'qa-workspace');
  rmSync(copy, { recursive: true, force: true });
  cpSync(ws, copy, { recursive: true, filter: src => !NOT_AUTHORED.some(d => src.slice(ws.length).split(/[/\\]/).includes(d)) });
  // Hidden tests of earlier changes stay hidden: QA keeps them in its copy, the Builder never has them
  hideAcceptance(s);

  const architecture = architectureFiles(ws);
  const reports = researchReports(def, ws);
  const builder: TurnContext = { ...ctx(s, 'dev', { from: ['You: the requirement', ...(architecture.length ? ['Architect: the architecture'] : [])], reads: [], to: ['Verify'] }), scope: builderScope(def, ws) };
  const qa: TurnContext = { ...ctx(s, 'qa', { from: ['You: the requirement'], reads: [], to: ['Verify (judge with them)'] }), workspace: copy, scope: ROLE_SCOPES.qa };
  getBus().emit(s.runId, { type: 'node_started', node: 'dev', module: MAIN.id, attempt: 1 });
  const [built] = await Promise.all([
    agentTurn(builder, builderPrompt(s.requirement, clauses, guideOf(def, 'build'), architecture, reports)).then(async turn => ({ turn, run: await testRunOf(builder, BUILDER_TESTS) })),
    // QA writes against the same contracts the Builder implements
    agentTurn(qa, fastQaPrompt(s.requirement, clauses, guideOf(def, 'qa'), pasteFiles(ws, ['contracts/']), reports)).then(async () => {
      if (countDeclaredTests(copy, `${ACCEPTANCE}/`) === 0) {
        await agentTurn({ ...qa, continues: true }, `No test cases were found under ${ACCEPTANCE}/. Write the acceptance tests now.`);
      }
    }),
  ]);
  getBus().emit(s.runId, { type: 'node_finished', node: 'dev' });
  const acceptanceRun = await testRunOf(qa, ACCEPTANCE_RUN);
  // QA's tests go to the run's store, out of the Builder's reach; later QA turns work in the real workspace
  rmSync(acceptanceStore(s), { recursive: true, force: true });
  cpSync(join(copy, ACCEPTANCE), acceptanceStore(s), { recursive: true });
  closeSessions(s.runId, 'qa');
  if (countDeclaredTests(acceptanceStore(s), '') === 0) { throw new Error('QA wrote no acceptance tests'); }
  return {
    builderRun: built.run, acceptanceRun, baseline: captureBaseline(ws),
    attempt: 1, allModulesDone: false, lastVerify: null, disputes: 0,
    lastDevReport: built.turn.text.trim().slice(-1500), ...builderAsks(def, s, built.turn.text),
  };
});

/** The Builder fixes what Verify, QA or a reviewer sent back, in the session that wrote the code. */
const fastDev = (def: PipelineDef) => node('dev', async s => {
  const attempt = s.attempt + 1;
  const turn: TurnContext = {
    ...ctx(s, 'dev', { from: [...(s.lastVerify && !s.lastVerify.passed ? ['Verify: what failed'] : []), ...(s.feedback ? ['Feedback'] : [])], reads: [], to: ['Verify'] }),
    scope: builderScope(def, s.workspace!.path),
  };
  // Back from the Architect: the design changed as asked, and the Builder carries on inside it
  const changed = s.archChange
    ? `The Architect changed the architecture for your request ("${s.archChange}"). Carry on inside the new version:${filesBlock(architectureFiles(s.workspace!.path))}`
    : null;
  const result = await agentTurn(turn, builderFixPrompt(attempt, s.lastVerify, [changed, s.feedback].filter(Boolean).join('\n\n') || null));
  const issue = result.text.match(/^SPEC_ISSUE:\s*(.+)$/m)?.[1] ?? null;
  return {
    attempt, builderRun: await testRunOf(turn, BUILDER_TESTS), specIssue: issue, archChanges: s.archChanges + (changed ? 1 : 0),
    ...builderAsks(def, { ...s, archChanges: s.archChanges + (changed ? 1 : 0) }, result.text),
    feedback: issue ? `The Builder reported a problem with a hidden test: ${issue}` : null,
    lastDevReport: result.text.trim().slice(-1500),
  };
}, s => ({ module: MAIN.id, attempt: s.attempt + 1 }));

/** Judges with the Builder's tests and QA's hidden ones; the Builder's own tests are not locked. */
const fastVerify = node('verify', async s => {
  const ws = s.workspace!.path;
  const baseline = captureBaseline(ws);
  const commands = [s.builderRun!.testCommand, s.acceptanceRun!.testCommand];
  const own = await verify({ workspace: ws, testCommand: commands[0], baseline, expectedTests: countDeclaredTests(ws, 'tests/'), testFormats: s.builderRun!.testFormats });
  showAcceptance(s);
  let hidden: VerifyResult;
  try {
    hidden = await verify({ workspace: ws, testCommand: commands[1], baseline, expectedTests: countDeclaredTests(ws, `${ACCEPTANCE}/`), testFormats: s.acceptanceRun!.testFormats });
  } finally {
    hideAcceptance(s);
  }
  const architecture = architectureReasons(ws);
  const result: VerifyResult = {
    passed: own.passed && hidden.passed && !architecture.length,
    tests: hidden.tests,
    reasons: [...own.reasons.map(r => `Your tests: ${r}`), ...hidden.reasons.map(r => `Hidden tests: ${r}`), ...architecture],
    output: `--- your tests ---\n${own.output.slice(-3000)}\n\n--- hidden acceptance tests ---\n${hidden.output}`,
  };
  getBus().emit(s.runId, { type: 'verify_result', module: MAIN.id, attempt: s.attempt, passed: result.passed, tests: result.tests, reasons: result.reasons, output: result.output.slice(-6000), commands });
  return { lastVerify: result, allModulesDone: result.passed, feedback: null, specIssue: repeatedHiddenFailure(s, result) };
}, s => ({ module: MAIN.id, attempt: s.attempt }));

const escalate = async (s: S): Promise<U> => {
  // Unattended (benchmark) runs have nobody to escalate to: out of attempts means failed
  const archChange = s.archChange ? `The Builder says the requirement does not fit the architecture: ${s.archChange}` : null;
  if (s.autoApprove) {
    getBus().emit(s.runId, { type: 'gate_resolved', gate: 'escalation', decision: 'abort', feedback: 'Out of fix attempts (unattended run)' });
    const why = s.lastVerify?.reasons.join('; ') || 'tests still failing';
    return { decision: 'abort', status: 'failed', error: archChange ?? `Still failing after ${s.attempt} attempts: ${why}` };
  }
  const answer = gate(s, 'escalation', {
    kind: 'escalation',
    title: archChange ? 'The Builder asks for an architecture change' : `Still failing after ${s.attempt} attempts`,
    module: MAIN.id,
    attempts: s.attempt,
    reasons: archChange ? [archChange] : s.lastVerify?.reasons ?? [],
    output: s.lastVerify?.output.slice(-4000) ?? '',
  });
  if (answer.decision === 'retry') { return { decision: 'retry', attempt: 0, feedback: answer.feedback ?? null, archChange: null }; }
  return { decision: 'abort', status: 'aborted' };
};

/**
 * A step after a blind build reads the workspace with the hidden tests in place, as they will be
 * committed: hidden, an earlier run's acceptance/ looks deleted and a reviewer asks to restore it.
 */
const withHiddenTests = <T>(s: S, seesHidden: boolean, work: () => Promise<T>): Promise<T> => {
  if (!seesHidden) { return work(); }
  showAcceptance(s);
  return work().finally(() => hideAcceptance(s));
};

/** A role defined in the pipeline file, with its own scope, agent and optional verdict. */
const agentNode = (step: AgentStep, nextStep: Step | undefined, seesHidden: boolean) => node(step.id, s => withHiddenTests(s, seesHidden, () => agentStep(step, nextStep, s, seesHidden)));

async function agentStep(step: AgentStep, nextStep: Step | undefined, s: S, seesHidden: boolean): Promise<U> {
  const sentBack = s.rounds[step.id] ?? 0;
  const sendsBack = step.verdict?.onChanges === 'dev';
  const io = {
    from: step.reads.map(r => (r === 'git diff' ? 'Builder: all code changes' : r)),
    reads: step.reads.filter(r => r !== 'git diff'),
    to: [...(sendsBack ? ['Builder, if something must be fixed'] : []), stepName(nextStep)],
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
    hiddenTests: seesHidden && existsSync(acceptanceStore(s)),
    // A reviewer read the repo with ~30 tool calls to find what changed (952k tokens on L-03); give it the diff
    diff: step.reads.includes('git diff') ? pastedDiff(s.workspace!) : undefined,
  }));
  // One chance to fix a diagram the dashboard cannot draw
  const diagramProblems = step.mayWrite.some(p => p === SYSTEM_DIAGRAM || (p.endsWith('/') && SYSTEM_DIAGRAM.startsWith(p))) ? readSystem(s.workspace!.path).errors : [];
  if (diagramProblems.length) {
    await agentTurn({ ...turn, io: { ...io, from: ['System: the diagram file was invalid'] }, continues: true }, `${SYSTEM_DIAGRAM} cannot be drawn:\n${diagramProblems.map(e => `- ${e}`).join('\n')}\nFix the file.`);
  }
  // The Architect's design must be one Verify can enforce
  if (step.instructions === 'builtin:architect') {
    const problem = architectureProblem(s.workspace!.path);
    if (problem) {
      await agentTurn({ ...turn, io: { ...io, from: ['System: the architecture file was invalid'] }, continues: true }, `${problem}. Fix ${ARCHITECTURE_FILE}.`);
      const still = architectureProblem(s.workspace!.path);
      if (still) { throw new Error(still); }
    }
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
}

/** A pause for you: review the plan (spec and architecture) or the code (diff, tests, reviews). */
const gateNode = (def: PipelineDef, step: GateStep, seesHidden: boolean) => async (s: S): Promise<U> => {
  if (!seesHidden) { return gateStep(def, step, s); }
  // You see the diff as it will be committed; the Builder works without the hidden tests again after
  showAcceptance(s);
  let out: U | undefined;
  try {
    out = await gateStep(def, step, s);
    return out;
  } finally {
    if (out?.status !== 'approved') { hideAcceptance(s); }
  }
};

async function gateStep(def: PipelineDef, step: GateStep, s: S): Promise<U> {
  const isLast = def.steps[def.steps.length - 1].id === step.id;
  // Every report written by the agent steps before this gate
  const reports = collectReports(s.workspace!.path, def, def.steps.findIndex(x => x.id === step.id));
  let payload: Record<string, unknown>;
  if (step.review === 'architecture') {
    payload = {
      architecture: (() => { try { return readArchitecture(s.workspace!.path); } catch { return null; } })(),
      architectureError: architectureProblem(s.workspace!.path),
      doc: readText(s.workspace!.path, ARCHITECTURE_DOC, 60_000),
      contracts: pasteFiles(s.workspace!.path, ['contracts/']).map(([path, text]) => ({ path, text })),
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
      // Back to the Builder with your notes
      return { decision: 'revise', feedback: answer.feedback ?? 'Address the review findings.', attempt: 0, allModulesDone: false, specIssue: null };
    }
    return { decision: 'revise', feedback: answer.feedback ?? null, specIssue: null, revisedTo: target.type === 'agent' ? target.id : null };
  }
  return { decision: 'abort', status: 'aborted' };
}

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
export function buildGraph(def: PipelineDef = loadPipeline('fast')) {
  const steps = def.steps;
  const at = (id: string) => steps.findIndex(x => x.id === id);
  const next = (id: string) => steps[at(id) + 1];
  const nextNode = (id: string) => (next(id) ? entryNode(next(id)!) : 'finish');
  const build = steps.find(x => x.type === 'build');
  const afterBuild = (step: Step) => !!build && steps.indexOf(step) > steps.indexOf(build);
  const maxAttempts = (build?.type === 'build' && build.maxAttempts) || getConfig().maxFixAttempts;

  // Node names come from the file, so the graph is assembled without static typing
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: any = new StateGraph(PipelineState);
  g.addNode('setup', setup(def)).addNode('finish', finish).addEdge(START, 'setup').addEdge('finish', END);
  if (!isFast(def)) { g.addEdge('setup', entryNode(steps[0])); }

  if (isFast(def)) {
    // QA and the Builder start together (one node); Verify judges with both; failures go back to the Builder
    const after = nextNode('build');
    // The Architect (and your approval of its design) only runs while the project has no architecture
    const architect = architectOf(def);
    // Research roles run first; then the Architect, only while the project has no architecture
    const entry = buildEntry(def);
    const first = steps[0].type === 'agent' && steps[0].id !== architect ? steps[0].id : null;
    (first ? g.addEdge('setup', first) : g.addConditionalEdges('setup', entry.to, entry.targets))
      // A Builder that needs another architecture goes to the Architect (and your approval), or to you
      .addNode('qa', fastWork(def)).addConditionalEdges('qa', (s: S) => (s.archChange ? (s.revisedTo ?? 'escalate') : 'verify'), ['verify', 'escalate', ...(architect ? [architect] : [])])
      .addNode('dev', fastDev(def)).addNode('verify', fastVerify).addNode('dispute', qaDispute).addNode('escalate', escalate)
      .addConditionalEdges('dev', (s: S) => (s.archChange ? (s.revisedTo ?? 'escalate') : !s.specIssue ? 'verify' : s.disputes < MAX_DISPUTES ? 'dispute' : 'escalate'), ['verify', 'dispute', 'escalate', ...(architect ? [architect] : [])])
      .addConditionalEdges('verify', (s: S) => (s.allModulesDone ? after : s.specIssue ? 'dispute' : s.attempt >= maxAttempts ? 'escalate' : 'dev'), [...new Set([after, 'dev', 'dispute', 'escalate'])])
      // QA found a conflict in the requirement itself: a person decides
      .addConditionalEdges('dispute', (s: S) => (s.specIssue ? 'escalate' : 'dev'), ['dev', 'escalate'])
      .addConditionalEdges('escalate', (s: S) => (s.decision === 'retry' ? 'dev' : 'finish'), ['dev', 'finish']);
  }

  for (const step of steps) {
    if (isFast(def) && (step.type === 'qa' || step.type === 'build')) { continue; }
    switch (step.type) {
      case 'gate': {
        // An architecture approved mid-build (the Builder asked for it) goes back to the Builder, not to a fresh start
        const midBuild = isFast(def) && step.review === 'architecture';
        const after = nextNode(step.id);
        const back = entryNode(steps.find(x => x.id === step.reviseTo)!);
        g.addNode(step.id, gateNode(def, step, isBlind(def) && afterBuild(step)))
          .addConditionalEdges(step.id, (s: S) => (s.decision === 'approve' ? (midBuild && s.acceptanceRun ? 'dev' : after) : s.decision === 'revise' ? back : 'finish'),
            [...new Set([after, back, 'finish', ...(midBuild ? ['dev'] : [])])]);
        break;
      }
      case 'agent': {
        // The last research role hands over to the Architect or straight to QA and the Builder
        const architect = architectOf(def);
        if (isFast(def) && step.id !== architect && (next(step.id)?.id === architect || next(step.id)?.type === 'qa')) {
          const entry = buildEntry(def);
          g.addNode(step.id, agentNode(step, next(step.id), false)).addConditionalEdges(step.id, entry.to, entry.targets);
          break;
        }
        const after = nextNode(step.id);
        // Only steps after build can send work back to Dev (the validator enforces it)
        const canSendBack = step.verdict?.onChanges === 'dev' && build;
        g.addNode(step.id, agentNode(step, next(step.id), isBlind(def) && afterBuild(step)))
          .addConditionalEdges(step.id, (s: S) => (canSendBack && s.decision === 'changes' ? 'dev' : after), canSendBack ? [...new Set([after, 'dev'])] : [after]);
        break;
      }
    }
  }
  return g as StateGraph<typeof PipelineState.spec>;
}

/** Entry point for LangGraph Studio (`npm run studio`); Studio supplies its own checkpointer. */
export const graph = buildGraph().compile();
