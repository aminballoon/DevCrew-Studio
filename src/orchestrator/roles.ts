import { ROLE_SCOPES } from '../core/scope';

/**
 * What each box in the pipeline receives, produces and hands to whom.
 * Roles never talk to each other directly: each one writes files, and the
 * orchestrator builds the next role's instructions from those files.
 */
export interface RoleContract {
  input: string[];
  output: string[];
  handsTo: string[];
  /** Paths this role may change; everything else is reverted. */
  mayWrite?: string;
}

const scope = (role: keyof typeof ROLE_SCOPES) => {
  const s = ROLE_SCOPES[role];
  const write = s.write.includes('*') ? 'everything' : s.write.join(', ');
  return s.deny.length ? `${write} except ${s.deny.join(', ')}` : write;
};

export const ROLE_CONTRACTS: Record<string, RoleContract> = {
  planner: {
    input: ['The task, from you', 'Your feedback from Gate 1, if you asked for changes', 'A spec problem reported by Dev, if any'],
    output: ['.devcrew/PRD.md: the spec, with numbered acceptance criteria', '.devcrew/plan.json: modules in build order and the test command', 'contracts/: the exact interfaces the code must match'],
    handsTo: ['Gate 1 (you) to review', 'then QA and Dev, who build from these files'],
    mayWrite: scope('planner'),
  },
  gate_spec: {
    input: ['PRD.md, plan.json and contracts/ from the Planner'],
    output: ['Approve, or feedback for the Planner'],
    handsTo: ['QA (approved)', 'Planner (changes requested)'],
  },
  qa: {
    input: ['.devcrew/PRD.md and contracts/ from the Planner', 'The module list from plan.json'],
    output: ['tests/<module>/: tests for every acceptance criterion, locked once written'],
    handsTo: ['Dev, as the target to build against', 'Verify, as the judge'],
    mayWrite: scope('qa'),
  },
  dev: {
    input: ['PRD.md and contracts/ from the Planner', 'tests/<module>/ from QA', 'The failure report from Verify, on retries', 'Your feedback from Gate 2 or an escalation, if any'],
    output: ['Source code for one module'],
    handsTo: ['Verify'],
    mayWrite: scope('dev'),
  },
  verify: {
    input: ['The code from Dev', 'The locked tests from QA', 'The test command from plan.json'],
    output: ['Pass or fail, with the reasons and the test output'],
    handsTo: ['Dev (failed: fix it; passed: next module)', 'Reviewer (all modules pass)', 'Escalation (out of attempts)'],
  },
  escalate: {
    input: ['The failing module, the reasons and the test output'],
    output: ['Your decision: retry with a hint, re-plan, or cancel'],
    handsTo: ['Dev (retry)', 'Planner (re-plan)'],
  },
  reviewer: {
    input: ['The full diff of the run', 'PRD.md and contracts/ from the Planner'],
    output: ['.devcrew/review.md: a verdict and findings by severity'],
    handsTo: ['Gate 2 (you)'],
    mayWrite: scope('reviewer'),
  },
  gate_merge: {
    input: ['The diff, test results, the review and the cost'],
    output: ['Approve (commit), feedback for Dev, or reject'],
    handsTo: ['Commit (approved)', 'Dev (changes requested)'],
  },
  single: {
    input: ['The task, from you', 'The failing test output, on fix rounds (process mode only)'],
    output: ['Everything in one session: spec, tests and code'],
    handsTo: ['Verify (process mode)', 'End of run (plain mode)'],
    mayWrite: scope('single'),
  },
};
