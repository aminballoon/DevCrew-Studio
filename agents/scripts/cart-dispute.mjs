// Scripted run where QA writes one wrong test: Dev disputes it, QA fixes the test, Dev passes.
// Before test disputes, this sent the whole run back to the Planner.
import base from './cart.mjs';

const goodTests = base.turns.qa[0].files['tests/cart-core/cart.test.ts'];
const wrongTests = goodTests.replace('599', '349');
const fixed = base.turns['dev:cart-core'][1];

export default {
  ...base,
  turns: {
    ...base.turns,
    qa: [
      { ...base.turns.qa[0], files: { ...base.turns.qa[0].files, 'tests/cart-core/cart.test.ts': wrongTests } },
      {
        thinking: 'Checking the disputed test against AC-3…\n\n',
        files: { 'tests/cart-core/cart.test.ts': goodTests },
        message: 'The expected subtotal was wrong.\nQA_ANSWER: Fixed the expected subtotal in tests/cart-core/cart.test.ts (599, as AC-3 says).',
      },
    ],
    'dev:cart-core': [
      {
        // Like real agents: text, a tool call, then a new message with no newline in between
        thinking: 'Running the cart-core tests before writing code…',
        commands: ['node --test tests/cart-core'],
        message: 'SPEC_ISSUE: tests/cart-core/cart.test.ts expects a subtotal of 349, but AC-3 gives 599 for the same lines.',
      },
      fixed,
    ],
  },
};
