import type { Role } from '../core/events';
import type { VerifyResult } from '../guard/verify';
import { SYSTEM_DIAGRAM, type AgentStep } from '../pipeline/schema';
import { filesFor, type Plan, type PlanModule } from './plan';
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
  "architecture": {
    "files": [
      {
        "path": "src/cart.ts",
        "kind": "contract | source | test | config | doc",
        "modules": ["module ids this file belongs to; empty if shared by all"],
        "purpose": "One or two plain sentences: what this file is responsible for",
        "exports": ["Names other files use: classes, functions, types, endpoints"],
        "dependsOn": ["paths of other planned files this one imports or implements"]
      }
    ]
  }
}`;

export function plannerPrompt(requirement: string, feedback: string | null, earlier: string[] = []): string {
  return `${header('planner')}
You are the Planner (Product Owner + Architect) of a software team. You do not write application code or tests.

Requirement from the customer:
"""
${requirement}
"""

${earlierReports(earlier)}
First look at the existing files in this workspace. If code already exists, write .devcrew/adr/0000-existing-architecture.md describing it before designing anything new.

Write these files (and only files under .devcrew/ and contracts/):
1. .devcrew/PRD.md — goal, scope, out of scope, user stories, and numbered Acceptance Criteria (AC-1, AC-2, ...) that are concrete and testable.
2. contracts/ — machine-checkable contracts the code must satisfy: exported function signatures as a .d.ts file, an OpenAPI file for HTTP APIs, or SQL migrations for databases. Use whichever fit.
3. .devcrew/plan.json — exactly this shape:
${PLAN_SCHEMA}
   Split the work into small modules that can be built and tested one at a time, in dependency order. Tests for module X will live in tests/X/.
   Use the project's own language and test tool. DevCrew reads the results of node:test, jest, vitest, pytest, cargo test, ctest, GoogleTest, Unity, go test -v, any TAP output, and firmware "HIL:PASS/HIL:FAIL/HIL:DONE" lines; the test command must print one of them. Test cases are counted in tests/ by language: test()/it() in JS/TS, def test_ in Python, TEST()/RUN_TEST()/void test_ in C/C++, #[test] in Rust, func Test in *_test.go.
   The architecture must list EVERY file the run will create or change (contracts, source, tests, config), each with a clear purpose a non-programmer can follow. The approver reviews it as a diagram before any code is written, and files outside it will be flagged.
${feedback ? `\nThe approver sent this feedback on your previous plan. Address all of it:\n"""\n${feedback}\n"""\n` : ''}
End with a short summary of the plan.`;
}

export function qaPrompt(plan: Plan, earlier: string[] = []): string {
  return `${header('qa')}
You are the QA engineer. Read .devcrew/PRD.md and contracts/. The developer has not written any code yet.
${earlierReports(earlier)}
Write automated tests that check every Acceptance Criterion against the contracts, for these modules:
${plan.modules.map(m => `- ${m.id}: ${m.title}`).join('\n')}

Planned test files (create exactly these):
${plan.architecture.filter(f => f.kind === 'test').map(f => `- ${f.path}: ${f.purpose}`).join('\n') || '- (none listed; use tests/<module>/main.test.ts)'}

Rules:
- Put the tests of module X in tests/X/ (for example tests/${plan.modules[0]?.id ?? 'module'}/main.test.ts). Only write files under tests/.
- Import the code under test from the paths the contracts define, even though they do not exist yet.
- Cover edge cases and error paths, not only the happy path. Name each test after the AC it checks.
- Do not use skip, todo or only.
- The suite will be run with: ${plan.testCommand}

After you finish, these files are locked: the developer cannot change them.
End with a list of the test files and which ACs each covers.`;
}

export function devPrompt(plan: Plan, module: PlanModule, attempt: number, last: VerifyResult | null, feedback: string | null, earlier: string[] = []): string {
  const failure = attempt > 1 && last
    ? `\nYour previous attempt did not pass verification:\n${last.reasons.map(r => `- ${r}`).join('\n')}\n\nTest output (tail):\n\`\`\`\n${last.output.slice(-4000)}\n\`\`\`\nFix the code. The tests are correct by definition here; do not try to change them.\n`
    : '';
  return `${header('dev', module.id, attempt)}
You are the Developer. Implement module "${module.id}": ${module.title}
${module.description}

Read .devcrew/PRD.md, contracts/ and the tests in tests/${module.id}/ first.
${earlierReports(earlier)}
Planned files for this module (stick to this architecture; mention any file you had to add and why):
${filesFor(plan, module.id, ['source', 'config']).map(f => `- ${f.path}: ${f.purpose}${f.exports.length ? ` Exports: ${f.exports.join(', ')}.` : ''}${f.dependsOn.length ? ` Uses: ${f.dependsOn.join(', ')}.` : ''}`).join('\n') || '- (none listed)'}
Rules:
- tests/, contracts/ and .devcrew/ are read-only for you. Changes there are reverted automatically.
- Make the tests pass by implementing the behaviour, never by special-casing test inputs.
- You may run the tests yourself: ${plan.moduleTestCommand?.replace('{module}', module.id) ?? plan.testCommand}
- If the spec or contracts are contradictory or impossible to implement, stop and reply with a line starting with "SPEC_ISSUE:" explaining why.
${failure}${feedback ? `\nThe approver asked for these changes:\n"""\n${feedback}\n"""\n` : ''}
End with a short summary of what you changed.`;
}

export function reviewerPrompt(baseCommit: string): string {
  return `${header('reviewer')}
You are the code reviewer. The tests already pass; your job is what tests cannot see.

Review the changes with \`git diff ${baseCommit}\` against .devcrew/PRD.md, contracts/ and any ADRs in .devcrew/adr/.
Look for: design problems, duplication, unclear names, missing error handling, security issues, and acceptance criteria that are tested only weakly.

Write your review to .devcrew/review.md (the only file you may write). Its first line must be exactly
"VERDICT: approve" or "VERDICT: changes", followed by findings ordered by severity, each with file:line.`;
}

export function singlePrompt(requirement: string, process: boolean): string {
  if (!process) {
    return `${header('single')}
${requirement}

Implement this in the current workspace, including automated tests in tests/ runnable with \`node --test\`. Run the tests and make sure they pass before you finish.`;
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
5. Review your own diff and fix design problems, then write .devcrew/review.md.`;
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
}): string {
  if (step.instructions === 'builtin:reviewer') {
    return reviewerPrompt(opts.baseCommit).replace(header('reviewer'), header(step.id, '-', opts.round));
  }
  const reads = step.reads.map(r => (r === 'git diff' ? `- every change so far: \`git diff ${opts.baseCommit}\`` : `- ${r}`)).join('\n');
  const diagram = step.mayWrite.some(p => p === SYSTEM_DIAGRAM || (p.endsWith('/') && SYSTEM_DIAGRAM.startsWith(p)))
    ? `\nIf you draw or change the system architecture diagram, write it to ${SYSTEM_DIAGRAM} in exactly this shape (the approver sees it drawn as a diagram):\n${SYSTEM_FORMAT}\n`
    : '';
  return `${header(step.id, '-', opts.round)}
You are the ${step.name} of an engineering team. ${step.purpose}

Requirement from the customer:
"""
${opts.requirement}
"""

Read first:
${reads || '- the files in this workspace'}

${step.instructions}

You may only write: ${step.mayWrite.join(', ')}. Changes anywhere else are reverted automatically.
${diagram}${step.verdict ? `Write your result to ${step.verdict.file}. Its first line must be exactly "VERDICT: approve" or "VERDICT: changes", followed by your findings ordered by severity, each with file:line.${step.verdict.onChanges === 'dev' ? ' "changes" sends the code back to the developer with your findings, so use it only for problems that must be fixed.' : ''}` : ''}
${opts.feedback ? `\nThis is round ${opts.round}. Since your last review the developer changed the code to address:\n"""\n${opts.feedback}\n"""\nCheck whether your findings are fixed.\n` : ''}${opts.gateFeedback ? `\nThe approver reviewed the work so far and sent it back with these notes. Address everything that concerns your role, updating your files in place:\n"""\n${opts.gateFeedback}\n"""\n` : ''}
End with a short summary.`;
}
