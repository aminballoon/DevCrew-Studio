// Scripted fast run: QA writes hidden acceptance tests in its own copy while the Builder writes the
// cart and one test of its own. The first build has no discount codes, so the hidden discount tests
// fail; the Builder adds them from the failure messages alone, and the reviewer approves.
import base from './cart.mjs';

const qa = base.turns.qa[0];
const ownTest = String.raw`import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cart } from '../src/cart.ts';

test('a cart takes items and adds up the subtotal', () => {
  const c = new Cart();
  c.addItem('A', 100, 2);
  assert.equal(c.subtotal(), 200);
});
`;
const builderRun = JSON.stringify({ testCommand: 'node --test "tests/**/*.test.ts"', testFormats: ['node'] });

export default {
  ...base,
  turns: {
    ...base.turns,
    qa: [{
      thinking: 'Reading the requirement and the project…',
      files: {
        'acceptance/cart-core/cart.test.ts': qa.files['tests/cart-core/cart.test.ts'],
        'acceptance/discounts/discounts.test.ts': qa.files['tests/discounts/discounts.test.ts'],
        '.devcrew/acceptance.json': JSON.stringify({ testCommand: 'node --test "acceptance/**/*.test.ts"' }),
      },
      message: 'Acceptance tests for every clause in acceptance/cart-core and acceptance/discounts.',
    }],
    'dev:main': [
      {
        thinking: 'Reading the requirement and the project…',
        files: { 'src/cart.ts': base.turns['dev:cart-core'][1].files['src/cart.ts'], 'tests/cart.test.ts': ownTest, '.devcrew/test.json': builderRun },
        commands: ['node --test "tests/**/*.test.ts"'],
        message: 'Built the cart with its lines and subtotal; my test passes.',
      },
      {
        thinking: 'The hidden discount tests fail: applyDiscount is missing…',
        files: { 'src/cart.ts': base.turns['dev:discounts'][0].files['src/cart.ts'] },
        message: 'Added the SAVE10 and FLAT5 discount codes.',
      },
    ],
  },
};
