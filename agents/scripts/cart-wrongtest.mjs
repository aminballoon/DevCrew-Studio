// Scripted fast run where one of QA's hidden tests is wrong: the Builder's correct code fails the
// same hidden test twice, so QA checks it against the requirement, fixes it, and the run goes on.
import base from './cart.mjs';

const qa = base.turns.qa[0];
const good = qa.files['acceptance/cart-core/cart.test.ts'];
const [first, complete] = base.turns['dev:main'];

export default {
  ...base,
  turns: {
    ...base.turns,
    qa: [
      { ...qa, files: { ...qa.files, 'acceptance/cart-core/cart.test.ts': good.replace('599', '349') } },
      {
        thinking: 'Checking the hidden test that keeps failing against the requirement…\n\n',
        files: { 'acceptance/cart-core/cart.test.ts': good },
        // Real QA agents sometimes write the conflict line with nothing in it; that is no conflict
        message: 'REQUIREMENT_ISSUE: none.\nQA_ANSWER: The expected subtotal in one test was wrong (349); the requirement gives 599. Fixed the test.',
      },
    ],
    // Complete and correct from the first turn; it can only fail the wrong hidden test
    'dev:main': [{ ...first, files: { ...first.files, 'src/cart.ts': complete.files['src/cart.ts'], 'src/util/carts.ts': complete.files['src/util/carts.ts'] } }, { message: 'The code follows the requirement; nothing to change.' }, { message: 'Nothing to change.' }],
  },
};
