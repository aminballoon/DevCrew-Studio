// Scripted blind-QA run where QA's hidden test is wrong: Dev's correct code fails the same hidden
// test twice, so the test goes back to QA, who fixes it, and the run goes on.
import blind from './cart-blind.mjs';

const qa = blind.turns.qa[0];
const good = qa.files['acceptance/cart-core/cart.test.ts'];
const correct = blind.turns['dev:cart-core'][1];

export default {
  ...blind,
  turns: {
    ...blind.turns,
    qa: [
      { ...qa, files: { ...qa.files, 'acceptance/cart-core/cart.test.ts': good.replace('599', '349') } },
      {
        thinking: 'Checking the hidden test that keeps failing against AC-3…\n\n',
        files: { 'acceptance/cart-core/cart.test.ts': good },
        message: 'QA_ANSWER: The expected subtotal in the AC-3 test was wrong (349); it is 599 as AC-3 says. Fixed the test.',
      },
    ],
    'dev:cart-core': [correct],
  },
};
