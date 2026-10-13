// Scripted run where the conflict cannot be settled by the agents: Dev always reports a spec
// issue and QA always says the plan is at fault. The run must stop and ask for a human,
// not replan forever.
import base from './cart.mjs';

export default {
  ...base,
  turns: {
    ...base.turns,
    qa: [
      base.turns.qa[0],
      { thinking: 'Checking the disputed test…\n\n', message: 'PLAN_ISSUE: the requirement contradicts the signed-off test; the plan cannot satisfy both.' },
    ],
    'dev:cart-core': [
      { thinking: 'Running the tests…\n\n', message: 'SPEC_ISSUE: tests/cart-core/cart.test.ts contradicts AC-3.' },
    ],
  },
};
