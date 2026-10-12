// Scripted run of bench task M-01-expenses for the fake agent: a medium project with
// three parts and nine files, to show the Planner's architecture review.
//
// The Planner's first design has no single entry point. If you ask for changes at
// Gate 1, its second design adds src/index.ts. Dev always builds src/index.ts, so if you
// approve the first design, the dashboard flags it as a file outside the approved design.
// Dev's first try at the ledger forgets to credit the payer and is sent back once.

const PRD = String.raw`# PRD — Shared expense splitter

## Goal
A small library that records who paid for what on a trip and works out who should pay whom.

## User stories
- As a traveller I can record an expense and who it was for.
- As a traveller I can see how much each person is owed or owes.
- As a traveller I get a short list of payments that settles everything.

## Acceptance Criteria
- AC-1 splitEvenly splits an amount into shares that differ by at most one cent and add up exactly.
- AC-2 Leftover cents go to the first shares.
- AC-3 Negative or fractional amounts, or fewer than one person, throw RangeError.
- AC-4 Recording an expense credits the payer and debits each person their share.
- AC-5 Balances always add up to zero.
- AC-6 An expense with nobody to split among throws.
- AC-7 settle returns transfers that clear every balance, biggest debtor to biggest creditor first, ties by name.
- AC-8 Balances that do not add up to zero cannot be settled.

## Out of scope
Currencies, rounding rules other than cents, storage.
`;

const CONTRACT = String.raw`export interface Expense { paidBy: string; amountCents: number; splitAmong: string[] }
export interface Transfer { from: string; to: string; amountCents: number }

export declare function splitEvenly(amountCents: number, people: number): number[];

export declare class Ledger {
  addExpense(expense: Expense): void;
  balances(): Record<string, number>;
}

export declare function settle(balances: Record<string, number>): Transfer[];
`;

const modules = [
  { id: 'money', title: 'Splitting money', description: 'src/money.ts: splitEvenly. AC-1 to AC-3.' },
  { id: 'ledger', title: 'Recording expenses', description: 'src/ledger.ts: Ledger with addExpense and balances. AC-4 to AC-6.' },
  { id: 'settle', title: 'Settling up', description: 'src/settle.ts: settle, plus the single entry point. AC-7 and AC-8.' },
];

const filesV1 = [
  { path: 'contracts/splitter.d.ts', kind: 'contract', modules: [], purpose: 'The agreed shape of the library: what an expense and a transfer look like, and the three things it can do.', exports: ['Expense', 'Transfer', 'splitEvenly', 'Ledger', 'settle'], dependsOn: [] },
  { path: 'src/money.ts', kind: 'source', modules: ['money'], purpose: 'Splits an amount of money fairly between people, down to the cent.', exports: ['splitEvenly'], dependsOn: ['contracts/splitter.d.ts'] },
  { path: 'src/ledger.ts', kind: 'source', modules: ['ledger'], purpose: 'Keeps track of who paid and who owes, and reports each person’s balance.', exports: ['Ledger', 'Expense'], dependsOn: ['contracts/splitter.d.ts', 'src/money.ts'] },
  { path: 'src/settle.ts', kind: 'source', modules: ['settle'], purpose: 'Turns balances into the shortest sensible list of payments.', exports: ['settle', 'Transfer'], dependsOn: ['contracts/splitter.d.ts'] },
  { path: 'tests/money/money.test.ts', kind: 'test', modules: ['money'], purpose: 'Checks fair splitting, leftover cents and bad input (AC-1 to AC-3).', exports: [], dependsOn: ['src/money.ts'] },
  { path: 'tests/ledger/ledger.test.ts', kind: 'test', modules: ['ledger'], purpose: 'Checks payer credit, shares, zero-sum balances and empty splits (AC-4 to AC-6).', exports: [], dependsOn: ['src/ledger.ts'] },
  { path: 'tests/settle/settle.test.ts', kind: 'test', modules: ['settle'], purpose: 'Checks payment order, tie-breaking and unbalanced input (AC-7, AC-8).', exports: [], dependsOn: ['src/settle.ts'] },
  { path: 'package.json', kind: 'config', modules: [], purpose: 'Marks the project as ES modules so Node runs the TypeScript files directly.', exports: [], dependsOn: [] },
];

const filesV2 = [
  ...filesV1.slice(0, 4),
  { path: 'src/index.ts', kind: 'source', modules: ['settle'], purpose: 'The single front door: everything a user of the library needs, from one place.', exports: ['splitEvenly', 'Ledger', 'settle'], dependsOn: ['src/money.ts', 'src/ledger.ts', 'src/settle.ts'] },
  ...filesV1.slice(4),
];

const plan = files => JSON.stringify({
  modules,
  testCommand: 'node --test',
  moduleTestCommand: 'node --test "tests/{module}/**/*.test.ts"',
  checks: [],
  architecture: { files },
}, null, 2);

const PACKAGE = JSON.stringify({ name: 'expense-splitter', private: true, type: 'module' }, null, 2) + '\n';

const MONEY = String.raw`export function splitEvenly(amountCents: number, people: number): number[] {
  if (!Number.isInteger(amountCents) || amountCents < 0) throw new RangeError('amount must be whole cents, 0 or more');
  if (!Number.isInteger(people) || people < 1) throw new RangeError('need at least one person');
  const base = Math.floor(amountCents / people);
  const leftover = amountCents - base * people;
  return Array.from({ length: people }, (_, i) => base + (i < leftover ? 1 : 0));
}
`;

const LEDGER_BUGGY = String.raw`import { splitEvenly } from './money.ts';

export interface Expense { paidBy: string; amountCents: number; splitAmong: string[] }

export class Ledger {
  #balances = new Map<string, number>();

  addExpense(expense: Expense): void {
    if (!expense.splitAmong.length) throw new Error('an expense must be split among at least one person');
    const shares = splitEvenly(expense.amountCents, expense.splitAmong.length);
    expense.splitAmong.forEach((person, i) => this.#add(person, -shares[i]));
  }

  balances(): Record<string, number> {
    return Object.fromEntries(this.#balances);
  }

  #add(person: string, cents: number): void {
    this.#balances.set(person, (this.#balances.get(person) ?? 0) + cents);
  }
}
`;

const LEDGER = LEDGER_BUGGY.replace(
  '    expense.splitAmong.forEach',
  '    this.#add(expense.paidBy, expense.amountCents);\n    expense.splitAmong.forEach',
);

const SETTLE = String.raw`export interface Transfer { from: string; to: string; amountCents: number }

const byAmountThenName = (a: { who: string; cents: number }, b: { who: string; cents: number }) =>
  b.cents - a.cents || a.who.localeCompare(b.who);

export function settle(balances: Record<string, number>): Transfer[] {
  const entries = Object.entries(balances);
  if (entries.reduce((sum, [, cents]) => sum + cents, 0) !== 0) throw new Error('balances must add up to zero');
  const debtors = entries.filter(([, c]) => c < 0).map(([who, c]) => ({ who, cents: -c })).sort(byAmountThenName);
  const creditors = entries.filter(([, c]) => c > 0).map(([who, c]) => ({ who, cents: c })).sort(byAmountThenName);
  const transfers: Transfer[] = [];
  let d = 0;
  let c = 0;
  while (d < debtors.length && c < creditors.length) {
    const amountCents = Math.min(debtors[d].cents, creditors[c].cents);
    transfers.push({ from: debtors[d].who, to: creditors[c].who, amountCents });
    debtors[d].cents -= amountCents;
    creditors[c].cents -= amountCents;
    if (debtors[d].cents === 0) d++;
    if (creditors[c].cents === 0) c++;
  }
  return transfers;
}
`;

const INDEX = String.raw`export { splitEvenly } from './money.ts';
export { Ledger } from './ledger.ts';
export { settle } from './settle.ts';
`;

const MONEY_TESTS = String.raw`import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitEvenly } from '../../src/money.ts';

test('AC-1 shares add up exactly and differ by at most a cent', () => {
  const shares = splitEvenly(1001, 4);
  assert.equal(shares.reduce((a, b) => a + b, 0), 1001);
  assert.ok(Math.max(...shares) - Math.min(...shares) <= 1);
});

test('AC-2 leftover cents go to the first shares', () => {
  assert.deepEqual(splitEvenly(10, 3), [4, 3, 3]);
});

test('AC-3 rejects bad input', () => {
  assert.throws(() => splitEvenly(-5, 2), RangeError);
  assert.throws(() => splitEvenly(1.5, 2), RangeError);
  assert.throws(() => splitEvenly(10, 0), RangeError);
});
`;

const LEDGER_TESTS = String.raw`import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../../src/ledger.ts';

test('AC-4 the payer is credited and everyone pays their share', () => {
  const l = new Ledger();
  l.addExpense({ paidBy: 'ann', amountCents: 300, splitAmong: ['ann', 'bob', 'cat'] });
  assert.deepEqual(l.balances(), { ann: 200, bob: -100, cat: -100 });
});

test('AC-5 balances add up to zero', () => {
  const l = new Ledger();
  l.addExpense({ paidBy: 'ann', amountCents: 1000, splitAmong: ['ann', 'bob', 'cat'] });
  l.addExpense({ paidBy: 'cat', amountCents: 250, splitAmong: ['ann', 'bob'] });
  assert.equal(Object.values(l.balances()).reduce((a, b) => a + b, 0), 0);
});

test('AC-6 an expense needs someone to split among', () => {
  assert.throws(() => new Ledger().addExpense({ paidBy: 'ann', amountCents: 100, splitAmong: [] }), Error);
});
`;

const SETTLE_TESTS = String.raw`import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle } from '../../src/settle.ts';

test('AC-7 biggest debtor pays biggest creditor first', () => {
  assert.deepEqual(settle({ ann: 500, bob: -100, cat: -400 }), [
    { from: 'cat', to: 'ann', amountCents: 400 },
    { from: 'bob', to: 'ann', amountCents: 100 },
  ]);
});

test('AC-7 ties are broken by name', () => {
  assert.deepEqual(settle({ bob: -100, ann: -100, cat: 200 }), [
    { from: 'ann', to: 'cat', amountCents: 100 },
    { from: 'bob', to: 'cat', amountCents: 100 },
  ]);
});

test('AC-8 unbalanced input is refused', () => {
  assert.throws(() => settle({ ann: 10 }), Error);
});
`;

const REVIEW = String.raw`VERDICT: approve

1. (minor) src/settle.ts:14 — the loop mutates the sorted copies; fine, but a comment would help the next reader.
2. (minor) src/ledger.ts:5 — Expense is declared both here and in the contract; import the contract type instead to keep one source of truth.
3. (info) No validation of person names (empty strings are accepted); out of scope per the PRD.
`;

export default {
  delayMs: 400,
  turns: {
    planner: [
      {
        thinking: 'Reading the requirement…\n\n',
        files: { '.devcrew/PRD.md': PRD, 'contracts/splitter.d.ts': CONTRACT, '.devcrew/plan.json': plan(filesV1) },
        message: 'Planned 3 parts and 8 files.',
        tokens: { input: 22000, output: 4200 },
      },
      {
        thinking: 'Updating the design from your feedback…\n\n',
        files: { '.devcrew/plan.json': plan(filesV2) },
        message: 'Added src/index.ts as the single entry point. 9 files now.',
        tokens: { input: 26000, output: 1800, cached: 20000 },
      },
    ],
    qa: [{
      thinking: 'Writing checks for each part before any code exists…\n\n',
      files: { 'tests/money/money.test.ts': MONEY_TESTS, 'tests/ledger/ledger.test.ts': LEDGER_TESTS, 'tests/settle/settle.test.ts': SETTLE_TESTS },
      message: 'Three test files, one per part, covering AC-1 to AC-8.',
      tokens: { input: 24000, output: 3900 },
    }],
    'dev:money': [{
      files: { 'package.json': PACKAGE, 'src/money.ts': MONEY },
      commands: ['node --test "tests/money/**/*.test.ts"'],
      message: 'splitEvenly done.',
      tokens: { input: 21000, output: 1600 },
    }],
    'dev:ledger': [
      {
        files: { 'src/ledger.ts': LEDGER_BUGGY },
        commands: ['node --test "tests/ledger/**/*.test.ts"'],
        message: 'Ledger done.',
        tokens: { input: 25000, output: 2100 },
      },
      {
        thinking: 'The payer is never credited. Fixing…\n\n',
        files: { 'src/ledger.ts': LEDGER },
        message: 'The payer now gets credited with the full amount.',
        tokens: { input: 28000, output: 900, cached: 21000 },
      },
    ],
    'dev:settle': [{
      files: { 'src/settle.ts': SETTLE, 'src/index.ts': INDEX },
      commands: ['node --test "tests/settle/**/*.test.ts"'],
      message: 'settle done, and src/index.ts exposes the whole library.',
      tokens: { input: 26000, output: 2600 },
    }],
    reviewer: [{
      files: { '.devcrew/review.md': REVIEW },
      commands: ['git diff'],
      message: 'VERDICT: approve, 3 minor notes.',
      tokens: { input: 23000, output: 1400 },
    }],
    single: [{
      thinking: 'Building everything in one go…\n\n',
      files: {
        'package.json': PACKAGE, 'src/money.ts': MONEY, 'src/ledger.ts': LEDGER, 'src/settle.ts': SETTLE, 'src/index.ts': INDEX,
        'tests/money.test.ts': MONEY_TESTS.replaceAll('../../src', '../src'),
      },
      commands: ['node --test'],
      message: 'Library and tests written.',
      tokens: { input: 61000, output: 9800 },
    }],
  },
};
