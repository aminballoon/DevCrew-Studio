import { ROLE_SCOPES } from '../core/scope';

/**
 * What each box in the pipeline receives, produces and hands to whom. Roles never talk to each
 * other directly: each one writes files, and the orchestrator builds the next role's
 * instructions from those files.
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
  qa: {
    input: ['The task, from you', 'contracts/ and the reports of research roles, if any'],
    output: ['acceptance/: hidden tests for every clause, in its own copy of the project', '.devcrew/acceptance.json: how to run them'],
    handsTo: ['Verify, as the judge', 'Never the Builder: it only sees which tests fail'],
    mayWrite: scope('qa'),
  },
  dev: {
    input: ['The task, from you', 'The architecture and contracts, if the project has them', 'What failed in Verify, on retries', 'Feedback from a reviewer or from you'],
    output: ['The code and its own tests', '.devcrew/test.json: how to run them'],
    handsTo: ['Verify'],
    mayWrite: scope('dev'),
  },
  verify: {
    input: ["The Builder's tests", "QA's hidden tests", 'The architecture rules, if any'],
    output: ['Pass or fail, with the reasons and the test output'],
    handsTo: ['Builder (failed)', 'QA (the same hidden test failed twice)', 'Reviewer (passed)', 'Escalation (out of attempts)'],
  },
  dispute: {
    input: ['The hidden test the Builder says cannot be passed'],
    output: ['A fixed test, or why it is right'],
    handsTo: ['Builder', 'You, when the requirement contradicts itself'],
  },
  escalate: {
    input: ['The reasons and the test output', 'Or an architecture change the Builder asks for'],
    output: ['Your decision: retry with a hint, or cancel'],
    handsTo: ['Builder (retry)'],
  },
  reviewer: {
    input: ['The full diff of the run', 'contracts/ and any ADRs'],
    output: ['.devcrew/review.md: a verdict and findings by severity'],
    handsTo: ['The code gate (you)'],
    mayWrite: scope('reviewer'),
  },
  gate_merge: {
    input: ['The diff, test results, the reviews and the cost'],
    output: ['Approve (commit), feedback for the Builder, or reject'],
    handsTo: ['Commit (approved)', 'Builder (changes requested)'],
  },
  single: {
    input: ['The task, from you', 'The failing test output, on fix rounds (process mode only)'],
    output: ['Everything in one session: tests and code'],
    handsTo: ['Verify (process mode)', 'End of run (plain mode)'],
    mayWrite: scope('single'),
  },
};
