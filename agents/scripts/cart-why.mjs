// Scripted fast run where QA's first hidden tests break the rules the system checks: one test reads
// DevCrew's own .devcrew/acceptance.json and no test has a reason. The system sends that back once,
// QA replaces the tooling test with one about the requirement and writes acceptance/why.json.
import base from './cart.mjs';

const qa = base.turns.qa[0];
const TOOLING = String.raw`import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('R-15 the suite runs with node --test, as .devcrew/acceptance.json says', () => {
  assert.match(JSON.parse(readFileSync('.devcrew/acceptance.json', 'utf8')).testCommand, /node --test/);
});
`;
const EXACT_REMOVE = String.raw`import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cart } from '../../src/cart.ts';

test('R-6 removing exactly the quantity removes the line', () => {
  const c = new Cart();
  c.addItem('A', 100, 2);
  c.removeItem('A', 2);
  assert.deepEqual(c.items(), []);
});
`;
const { 'acceptance/why.json': why, ...withoutWhy } = qa.files;

export default {
  ...base,
  turns: {
    ...base.turns,
    qa: [
      { ...qa, files: { ...withoutWhy, 'acceptance/cart-core/extra.test.ts': TOOLING } },
      {
        thinking: 'Replacing the test of DevCrew files and writing a reason for every test…',
        files: {
          'acceptance/cart-core/extra.test.ts': EXACT_REMOVE,
          'acceptance/why.json': JSON.stringify([...JSON.parse(why), { test: 'R-6 removing exactly the quantity removes the line', clause: 'R-6', why: 'Removing as many units as the line has must remove the whole line.' }], null, 2),
        },
        message: 'Replaced the .devcrew test with R-6 and gave every test its clause and reason.',
      },
    ],
  },
};
