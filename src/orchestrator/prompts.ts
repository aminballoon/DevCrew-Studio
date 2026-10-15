import type { Role } from '../core/events';
import type { VerifyResult } from '../guard/verify';
import { SYSTEM_DIAGRAM, type AgentStep } from '../pipeline/schema';
import { filesFor, type Plan, type PlanModule } from './plan';
import { clauseList, type Clause } from './requirement';
import { SYSTEM_FORMAT } from './system';
import { TEST_FORMATS } from '../guard/testFormats';

/** First line of every prompt. Real agents ignore it; the scripted fake agent routes on it. */
const header = (role: Role, module = '-', attempt = 1) => `[devcrew role=${role} module=${module} attempt=${attempt}]`;

/** Reports written by roles that ran earlier in the pipeline, for the next role to read. */
const earlierReports = (paths: string[]) => (paths.length
  ? `\nEarlier roles in this run wrote reports and notes here; read them first and build on them:\n${paths.map(p => `- ${p}`).join('\n')}\n`
  : '');

const PLAN_SCHEMA = `{
  "modules": [
    { "id": "kebab-case-id", "title": "Short title", "description": "What to build, which files, which acceptance criteria it covers" }
  ],
  "testCommand": "command that runs the whole test suite, e.g. node --test",
  "moduleTestCommand": "same command with {module} where the module id goes, e.g. node --test \\"tests/{module}/**/*.test.*\\"",
  "checks": [ { "name": "typecheck", "command": "npx tsc --noEmit" } ],
  "testFormats": ["optional: what the test command prints, from ${TEST_FORMATS.join(', ')}; list several only when one command runs several tools"],
  "coverage": { "R-1": ["AC-1"], "R-2": ["AC-2", "AC-3"] },
  "architecture": {
    "files": [
      {
        "path": "src/cart.ts",
        "kind": "contract | source | test | config | doc",
        "modules": ["module ids this file belongs to; empty if shared by all"],
        "purpose": "One plain sentence: what this file is responsible for",
        "exports": ["Names other files use: classes, functions, types, endpoints"],
        "dependsOn": ["paths of other planned files this one imports or implements"]
      }
    ]
  }
}`;

/**
 * Files an earlier role wrote, pasted into the prompt. The agent would read them anyway, and every
 * tool call re-reads the whole conversation: on L-02 QA and Dev spent 4-7 calls each just reading.
 */
export function filesBlock(files: [string, string][]): string {
  return files.length
    ? `\nTheir current content, so you do not need to read them again:\n${files.map(([path, text]) => `=== ${path} ===\n${text.trimEnd()}`).join('\n\n')}\n=== end of files ===\n`
    : '';
}

/** A role guide on top of a built-in role's instructions: the specialist's techniques and tools. */
const roleGuide = (text?: string) => (text ? `\nYour role guide. Follow it; it is how this team expects your role to work:\n"""\n${text}\n"""\n` : '');

/** The customer's own words, for roles after the Planner: they win over any restatement. */
function sourceOfTruth(requirement: string, clauses: Clause[]): string {
  return `The customer's requirement, split into numbered clauses. It is the source of truth: where .devcrew/PRD.md says less or something different, follow the requirement.
"""
${clauses.length ? clauseList(clauses) : requirement}
"""
`;
}

export function plannerPrompt(requirement: string, feedback: string | null, earlier: string[] = [], clauses: Clause[] = [], guide?: string): string {
  return `${header('planner')}
You are the Planner (Product Owner + Architect) of a software team. You do not write application code or tests.

Requirement from the customer:
"""
${requirement}
"""

${earlierReports(earlier)}
First look at the existing files in this workspace. Only if it already has source code (more than a README), write .devcrew/adr/0000-existing-architecture.md describing it before designing anything new.

Write these files (and only files under .devcrew/ and contracts/):
1. .devcrew/PRD.md — goal, out of scope, and numbered Acceptance Criteria (AC-1, AC-2, ...) that are concrete and testable. Keep it short: one criterion per rule the requirement states, in the requirement's own words where possible; no user stories, no restating of the requirement, nothing the requirement does not ask for. Every word you write is read again by QA, the developer and the reviewers.
2. contracts/ — machine-checkable contracts the code must satisfy: exported function signatures as a .d.ts file, an OpenAPI file for HTTP APIs, or SQL migrations for databases. Use whichever fit.
3. .devcrew/plan.json — exactly this shape:
${PLAN_SCHEMA}
   Use as few modules as the work needs, in dependency order. Every module costs a separate build-and-test cycle, so one module is right for most requirements; split only parts that are large and can be tested on their own, and never more than 4. Tests for module X will live in tests/X/; choose test file names and commands the project's test tool really finds there (PlatformIO, for example, only collects suite folders named test_*, so use tests/X/test_X/ with test_dir = tests and the filter X/*).
   Contracts are read-only for the developer. In C or C++, do not put a class whose private members the developer must add in a contract header: use free functions, an abstract interface, or a class holding only a pointer to an implementation struct the developer defines in src/.
   Use the project's own language and test tool. DevCrew reads the results of node:test, jest, vitest, pytest, cargo test, ctest, GoogleTest, Unity, go test -v, any TAP output, and firmware "HIL:PASS/HIL:FAIL/HIL:DONE" lines; the test command must print one of them. Test cases are counted in tests/ by language: test()/it() in JS/TS, def test_ in Python, TEST()/RUN_TEST()/void test_ in C/C++, #[test] in Rust, func Test in *_test.go.
   The architecture must list EVERY file the run will create or change (contracts, source, tests, config), each with a clear purpose a non-programmer can follow. The approver reviews it as a diagram before any code is written, and files outside it will be flagged.
${clauses.length ? `   "coverage" maps EVERY requirement clause below to the acceptance criteria that cover it. Each clause must be covered in full, word for word: if a clause says two things (for example "is trimmed and must be 1 to 100 characters"), the criteria must say both. A plan with an uncovered clause is sent back to you.
${clauseList(clauses).split('\n').map(l => `   ${l}`).join('\n')}
` : ''}${roleGuide(guide)}${feedback ? `\nThe approver sent this feedback on your previous plan. Address all of it:\n"""\n${feedback}\n"""\n` : ''}
DevCrew checks plan.json (shape, coverage, architecture) as soon as you finish and sends any problem back to you, so do not write scripts or run commands to check it yourself.
End with a short summary of the plan.`;
}

export function qaPrompt(plan: Plan, earlier: string[] = [], requirement = '', clauses: Clause[] = [], guide?: string, opts: { blind?: boolean; files?: [string, string][] } = {}): string {
  return `${header('qa')}
You are the QA engineer. Work from .devcrew/PRD.md and contracts/. The developer has not written any code yet.
${filesBlock(opts.files ?? [])}${earlierReports(earlier)}
${requirement ? `${sourceOfTruth(requirement, clauses)}${plan.coverage ? `The Planner mapped the clauses to acceptance criteria in .devcrew/plan.json ("coverage").\n` : ''}
Write automated tests that check every requirement clause and every Acceptance Criterion against the contracts, for these modules:` : 'Write automated tests that check every Acceptance Criterion against the contracts, for these modules:'}
${plan.modules.map(m => `- ${m.id}: ${m.title}`).join('\n')}

Planned test files (create exactly these):
${plan.architecture.filter(f => f.kind === 'test').map(f => `- ${f.path}: ${f.purpose}`).join('\n') || '- (none listed; use tests/<module>/main.test.ts)'}

Rules:
- Put the tests of module X in tests/X/ (for example tests/${plan.modules[0]?.id ?? 'module'}/main.test.ts). Only write files under tests/.
- Import the code under test from the paths the contracts define, even though they do not exist yet.
- Cover edge cases and error paths, not only the happy path. Name each test after the AC it checks${requirement ? ' and the requirement clause (R-n)' : ''}.
- Do not use skip, todo or only.
- The suite will be run with: ${plan.testCommand}
- Keep the suite lean: it is run on every attempt and maintained by every later change. Aim for about one test per acceptance criterion, and add boundary, hostile-input or concurrency cases only where a clause states a limit, an error or a security property. Prefer one test with several related assertions over many tiny tests, and reuse the helpers already in tests/.
- When tests/ already has tests, they cover what the project does today. Write tests only for what this change adds or changes, and update the existing tests this change makes wrong. Do not rewrite or duplicate the others.
- Every test must agree with the requirement and with every other test.
${QA_SCOPE}

${opts.blind ? `${BLIND_QA}\n` : ''}${roleGuide(guide)}
After you finish, these files are locked: the developer cannot change them.
End with a list of the test files and which ACs ${requirement ? 'and requirement clauses ' : ''}each covers.`;
}

/**
 * What QA's turn is for, and what it is not. Without this, QA turns took 15-33 min of a 60-min
 * HW-01 run: on-board suites run against an empty firmware, reference models with mutants,
 * and debugging of tools outside tests/.
 */
const QA_SCOPE = `Your job is writing the tests, not running the project. Keep your turn short:
- Check your work with a quick run only: run the host-side tests once against the empty implementation, where they should fail to compile, fail to import or fail their assertions, and read the failures to check each test fails for the reason you intend. One run, a few minutes at most.
- Do not run tests that need hardware, a board, a network service or a long wait, and do not flash or upload anything. Check those test files only for syntax (for example python -m py_compile). The Verify step runs them after the developer has built the code.
- Do not write a reference implementation, mutants or a model of the code to test your tests, and do not write notes or memory files outside tests/.
- If a tool, script or setting outside tests/ is broken or missing, do not investigate or fix it. Write the tests as if it worked, and add a line starting with "HARNESS_ISSUE:" to your final answer naming the file and the problem. Leave the line out when nothing is broken.`;

// --- Fast pipeline: one Builder, and a blind QA working at the same time ---

/** Where the Builder says how to run its own tests, and QA how to run the hidden ones. */
export const BUILDER_TESTS = '.devcrew/test.json';
export const ACCEPTANCE_RUN = '.devcrew/acceptance.json';

const runFile = (path: string, what: string) => `${path} with how to run ${what} from the project root, exactly this shape:
   { "testCommand": "the command", "testFormats": ["optional: what it prints, from ${TEST_FORMATS.join(', ')}"] }
   It must print results in one of those formats.`;

const ARCHITECTURE_SCHEMA = `{
  "modules": [
    { "id": "kebab-case", "path": "src/folder/ (or one file)", "purpose": "one plain sentence", "mayUse": ["ids of modules it may import"], "interface": "optional: the only file other modules may import, e.g. src/folder/index.ts" }
  ],
  "decisions": [ { "id": "ADR-1", "title": "...", "decision": "...", "why": "..." } ]
}`;

/** The Architect designs the project's lasting architecture; Verify enforces it on every later run. */
export function architectPrompt(requirement: string, clauses: Clause[], feedback: string | null): string {
  return `${header('architect')}
You are the software architect. Design the architecture this project will keep: every later change is built inside it and checked against it automatically, by people and agents who never talked to you.
${sourceOfTruth(requirement, clauses)}
First look at the existing files. If code exists, describe the architecture it already has and change only what this requirement needs.

Write these files, and nothing else (no application code, no tests):
1. .devcrew/architecture.json, exactly this shape:
${ARCHITECTURE_SCHEMA}
   Verify rejects any import from one module into another that "mayUse" does not allow, or that goes past a module's "interface". Keep it small: usually 3 to 7 modules, each using only what it needs, no cycles. Give an "interface" to every module other modules use.
2. contracts/: the public interface of each module with an interface, in the project's language (a .d.ts file, Python Protocols or stubs, a header), using exactly the names, signatures, errors and formats the requirement gives. The Builder implements them and cannot change them.
3. .devcrew/ARCHITECTURE.md, one page for the next developer: what each module does, how a request flows through them, each decision and its reason, and where the next likely changes go ("a new kind of X is a new file in Y"). If the requirement mentions later releases, design so they fit without restructuring, but do not build them.
In C or C++, do not put a class whose private members the Builder must add in a contract header: use free functions, an abstract interface, or a pointer to an implementation struct defined in src/.
${feedback ? `\nA change to the design is asked for. Change it as little as the request needs, keep the earlier decisions unless the request overturns them, and add a decision (ADR) saying what changed and why:\n"""\n${feedback}\n"""\n` : ''}
End with a short summary of the design.`;
}

export function builderPrompt(requirement: string, clauses: Clause[], guide?: string, architecture: [string, string][] = []): string {
  return `${header('dev', 'main', 1)}
You are the Builder. You alone plan and write the code for this requirement, with your own tests.
${sourceOfTruth(requirement, clauses)}
A QA engineer is writing acceptance tests from the same requirement right now, without seeing your code. Your work is judged by those hidden tests and by yours. Use exactly the names, paths, signatures, errors and formats the requirement gives, because the hidden tests will.

${architecture.length ? `The project's architecture is fixed. Put each piece of code in the module that owns it, import other modules only as "mayUse" allows and only through their "interface", and implement contracts/ exactly; you cannot change contracts/ or the architecture files. Verify rejects imports that break the rules. If the requirement truly cannot be built inside this architecture, stop and reply with a line starting with "ARCH_CHANGE:" saying what must change and why; a person decides.${filesBlock(architecture)}\n` : ''}Do this:
1. Look at the existing files, then implement everything the requirement asks, in the project's own language and conventions.
2. Write tests in tests/ for the behaviour the requirement describes, with the project's own test tool, and run them until they pass. Keep them lean.
3. Write ${runFile(BUILDER_TESTS, 'your tests')}
${roleGuide(guide)}
Do not write anything under acceptance/. If the requirement contradicts itself, follow the most specific clause and say which one in your summary.
End with a short summary of what you built.`;
}

export function fastQaPrompt(requirement: string, clauses: Clause[], guide?: string, contracts: [string, string][] = []): string {
  return `${header('qa')}
You are the QA engineer. A Builder is writing the code for this requirement right now; you write the acceptance tests that will judge it. The Builder never sees them, only the names and failure messages of the ones that fail.
${sourceOfTruth(requirement, clauses)}${contracts.length ? `The Builder implements these contracts exactly; test through them.${filesBlock(contracts)}` : ''}
Do this:
1. Look at the existing files to learn the language, the test tool and any code there already.
2. Write acceptance tests under acceptance/ (for example acceptance/main.test.ts) that check every clause, using exactly the names, paths and signatures the requirement gives. Import the code from where the requirement or the existing project says it lives. Where the requirement leaves a name open, test only behaviour you can reach through the names it does give.
3. Name each test after the clause and the behaviour (R-n: what must happen), and give assertions clear messages: a failing name and message is all the Builder will see.
4. Write ${runFile(ACCEPTANCE_RUN, 'every test under acceptance/ (and nothing else)')}
   When acceptance/ already has tests, they check what the project does today: keep them, update the ones this change makes wrong, and add tests for what it adds. The command runs them all, so a change that breaks earlier behaviour fails.

Rules:
- Only write under acceptance/ and ${ACCEPTANCE_RUN}. There is no code yet: check your tests only for syntax, do not wait for an implementation.
- Keep the suite lean: about one test per clause, more only where a clause states a limit, an error or a security property.
- Every test must agree with the requirement and with every other test.
${roleGuide(guide)}
End with the list of test files and the clauses each covers.`;
}

export function builderFixPrompt(attempt: number, last: VerifyResult | null, feedback: string | null): string {
  return `${header('dev', 'main', attempt)}
${!last || last.passed ? '' : `Your work did not pass verification:
${last.reasons.map(r => `- ${r}`).join('\n')}

Test output (tail; hidden acceptance tests show only their names and failure messages):
\`\`\`
${last.output.slice(-4000)}
\`\`\`
Fix the code so it does what the requirement says. You cannot see the hidden tests and must not look for them. If you are sure a hidden test contradicts the requirement, reply with a line starting with "SPEC_ISSUE:" naming the test and the clause; QA will check it.
`}${feedback ? `\n${feedback}\n` : ''}
Keep ${BUILDER_TESTS} up to date. End with a short summary of what you changed.`;
}

/** Blind QA: the real tests are written for the judge, not for the developer. */
const BLIND_QA = `Blind QA: the developer will not see most of your tests.
- Write the acceptance tests, the real check of every clause and criterion, under acceptance/<module>/ (for example acceptance/X/main.test.ts), mirroring the planned test files. They are taken away before the developer starts and only run when the work is judged. The developer then sees only the names and failure messages of failing tests, so name each test after the behaviour it checks (AC-n, R-n and what must happen), and give assertions clear messages.
- Under tests/<module>/ write only a small contract test (one to three tests): the module's exports exist and one basic call works. It shows the developer the shape of the API, not the rules.
- Acceptance tests run with the test command, with tests/ replaced by acceptance/. Import code and shared helpers with paths that work from acceptance/<module>/.`;

export function devPrompt(plan: Plan, module: PlanModule, attempt: number, last: VerifyResult | null, feedback: string | null, earlier: string[] = [], requirement = '', clauses: Clause[] = [], guide?: string, opts: { blind?: boolean; files?: [string, string][] } = {}): string {
  const failure = attempt > 1 && last && !last.passed
    ? `\nYour previous attempt did not pass verification:\n${last.reasons.map(r => `- ${r}`).join('\n')}\n\nTest output (tail):\n\`\`\`\n${last.output.slice(-4000)}\n\`\`\`\nFix the code. The tests are correct by definition here; do not try to change them.\n`
    : '';
  return `${header('dev', module.id, attempt)}
You are the Developer. Implement module "${module.id}": ${module.title}
${module.description}

Work from .devcrew/PRD.md, contracts/ and the tests in tests/${module.id}/.${filesBlock(opts.files ?? [])}${opts.blind ? '\nMost of QA\'s tests are kept from you and run when your work is judged. Build what the requirement clauses and the PRD say, not only what tests/ shows. When a hidden test fails you see its name and failure message: fix the behaviour it names. You cannot read hidden tests and must not look for them. If you are sure a hidden test is wrong, start a line with "SPEC_ISSUE:" naming the test and why; QA will check it.' : ''}
${earlierReports(earlier)}${requirement ? `\n${sourceOfTruth(requirement, clauses)}Passing the tests is necessary but not enough: the code must also do everything the clauses for this module say.\n` : ''}
Planned files for this module (stick to this architecture; mention any file you had to add and why):
${filesFor(plan, module.id, ['source', 'config']).map(f => `- ${f.path}: ${f.purpose}${f.exports.length ? ` Exports: ${f.exports.join(', ')}.` : ''}${f.dependsOn.length ? ` Uses: ${f.dependsOn.join(', ')}.` : ''}`).join('\n') || '- (none listed)'}
Rules:
- tests/, contracts/ and .devcrew/ are read-only for you. Changes there are reverted automatically.
- Make the tests pass by implementing the behaviour, never by special-casing test inputs.
- You may run the tests yourself: ${plan.moduleTestCommand?.replace('{module}', module.id) ?? plan.testCommand}
- If a test contradicts the requirement or another test, or the spec or contracts are impossible to implement, stop and reply with a line starting with "SPEC_ISSUE:" naming the test (file and line) or the part of the spec, and why. A wrong test goes back to QA to check; a wrong spec goes back to the Planner.
${roleGuide(guide)}${failure}${feedback ? `\nRead this before you start:\n"""\n${feedback}\n"""\n` : ''}
End with a short summary of what you changed.`;
}

/** Any reviewer that can send work back: a gap against the requirement is never optional. */
export const REQUIREMENT_RULE = 'Check every requirement clause against the code. Code that does not do what a clause says is a must-fix finding whatever its severity: answer "VERDICT: changes" for it and name the clause (R-n).';

export function reviewerPrompt(baseCommit: string, requirement = '', clauses: Clause[] = [], diff?: string): string {
  return `${header('reviewer')}
You are the code reviewer. The tests already pass; your job is what tests cannot see.
${requirement ? `\n${sourceOfTruth(requirement, clauses)}${REQUIREMENT_RULE}\n` : ''}
Review the changes${diff ? ' (the full diff is below; read other files only where you need more context)' : ` with \`git diff ${baseCommit}\``} against .devcrew/PRD.md, contracts/ and any ADRs in .devcrew/adr/, where they exist.${diff ? `\n\`\`\`diff\n${diff}\n\`\`\`` : ''}
Look for: design problems, duplication, unclear names, missing error handling, security issues, and acceptance criteria that are tested only weakly.

Write your review to .devcrew/review.md (the only file you may write). Its first line must be exactly
"VERDICT: approve" or "VERDICT: changes", followed by findings ordered by severity, each with file:line.`;
}

/** Role guides handed to a single agent, so a control arm gets the same know-how as the team. */
const singleGuides = (guides?: string) => (guides ? `\nYou do every role's job yourself. These guides describe how each part of the job should be done; follow all of them:\n"""\n${guides}\n"""\n` : '');

export function singlePrompt(requirement: string, process: boolean, guides?: string): string {
  if (!process) {
    return `${header('single')}
${requirement}
${singleGuides(guides)}
Implement this in the current workspace, including automated tests in tests/ that run with the project's own test tool (the one the requirement or the existing project uses). Run the tests and make sure they pass before you finish.`;
  }
  return `${header('single')}
Requirement:
"""
${requirement}
"""

Work in this order, writing each artifact to a file before moving on:
1. .devcrew/PRD.md with numbered, testable Acceptance Criteria.
2. contracts/ with the exported signatures (a .d.ts file) or API contract.
3. tests/ covering every acceptance criterion and edge case, runnable with \`node --test\`. Write them before any implementation.
4. The implementation, until all tests pass. Do not weaken or skip tests.
5. Review your own diff and fix design problems, then write .devcrew/review.md.
${singleGuides(guides)}`;
}

/** Instructions for a role defined in a pipeline file. */
export function agentStepPrompt(step: AgentStep, opts: {
  requirement: string;
  baseCommit: string;
  round: number;
  /** The developer's changes since this step last sent the work back. */
  feedback: string | null;
  /** Your notes when a gate sent the work back to this step. */
  gateFeedback?: string | null;
  clauses?: Clause[];
  /** The changes so far, pasted for a step that reads "git diff" (none when too big to paste). */
  diff?: string;
}): string {
  if (step.instructions === 'builtin:architect') {
    return architectPrompt(opts.requirement, opts.clauses ?? [], opts.gateFeedback ?? null).replace(header('architect'), header(step.id, '-', opts.round));
  }
  if (step.instructions === 'builtin:reviewer') {
    return reviewerPrompt(opts.baseCommit, opts.requirement, opts.clauses, opts.diff).replace(header('reviewer'), header(step.id, '-', opts.round));
  }
  const reads = step.reads.map(r => (r === 'git diff' ? `- every change so far: \`git diff ${opts.baseCommit}\`` : `- ${r}`)).join('\n');
  const diagram = step.mayWrite.some(p => p === SYSTEM_DIAGRAM || (p.endsWith('/') && SYSTEM_DIAGRAM.startsWith(p)))
    ? `\nIf you draw or change the system architecture diagram, write it to ${SYSTEM_DIAGRAM} in exactly this shape (the approver sees it drawn as a diagram):\n${SYSTEM_FORMAT}\n`
    : '';
  return `${header(step.id, '-', opts.round)}
You are the ${step.name} of an engineering team. ${step.purpose}

Requirement from the customer${opts.clauses?.length ? ', split into numbered clauses' : ''}:
"""
${opts.clauses?.length ? clauseList(opts.clauses) : opts.requirement}
"""

Read first:
${reads || '- the files in this workspace'}

${step.instructions}

You may only write: ${step.mayWrite.join(', ')}. Changes anywhere else are reverted automatically.
${diagram}${step.verdict ? `Write your result to ${step.verdict.file}. Its first line must be exactly "VERDICT: approve" or "VERDICT: changes", followed by your findings ordered by severity, each with file:line.${step.verdict.onChanges === 'dev' ? ` "changes" sends the code back to the developer with your findings, so use it only for problems that must be fixed. ${REQUIREMENT_RULE}` : ''}` : ''}
${opts.feedback ? `\nThis is round ${opts.round}. Since your last review the developer changed the code to address:\n"""\n${opts.feedback}\n"""\nCheck whether your findings are fixed.\n` : ''}${opts.gateFeedback ? `\nThe approver reviewed the work so far and sent it back with these notes. Address everything that concerns your role, updating your files in place:\n"""\n${opts.gateFeedback}\n"""\n` : ''}
End with a short summary.`;
}

/** QA checks a test the developer says cannot be passed, instead of re-planning the whole run. */
export function qaDisputePrompt(module: PlanModule, issue: string, last: VerifyResult | null, requirement: string, clauses: Clause[]): string {
  return `${header('qa', module.id)}
You are the QA engineer. The developer of module "${module.id}" says your tests cannot be passed:
"""
${issue}
"""
${last ? `\nLast test run (tail):\n\`\`\`\n${last.output.slice(-3000)}\n\`\`\`\n` : ''}
${sourceOfTruth(requirement, clauses)}
Check the disputed tests against the requirement clauses and against each other.
- If a test is wrong, fix it (only files under tests/ or acceptance/) so it checks what the clauses say. Keep the change small; do not rewrite other tests.
- If the tests are right, change nothing and explain in one or two sentences why, so the developer can make them pass.
- If the requirement or the plan itself is contradictory, reply with a line starting with "PLAN_ISSUE:" explaining it; the Planner will revise the plan.
End with one line starting with "QA_ANSWER:" that tells the developer what you decided.`;
}
