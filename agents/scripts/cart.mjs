// Scripted run of bench task S-01-cart for the fake agent: no model, no quota.
// The story: QA writes hidden acceptance tests in its own copy while the Builder writes the cart
// and one test of its own. The first build has no discount codes, so the hidden discount tests
// fail; the Builder adds them from the failure messages alone, and the reviewer approves. In
// fast-arch an Architect first designs two modules, and the first build also breaks their rule.
// The add-on roles (security, codebase, board, hil, firmware) and the single agent have a turn too.

const CONTRACT = String.raw`export interface CartLine { sku: string; unitPriceCents: number; qty: number }

export declare class Cart {
  addItem(sku: string, unitPriceCents: number, qty?: number): void;
  removeItem(sku: string, qty?: number): void;
  items(): CartLine[];
  subtotal(): number;
  applyDiscount(code: string): void;
  total(): number;
}
`;

const CORE_TESTS = String.raw`import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cart } from '../../src/cart.ts';

test('AC-1 adds lines and tops up existing SKUs', () => {
  const c = new Cart();
  c.addItem('A', 100, 2);
  c.addItem('A', 100);
  c.addItem('B', 50);
  assert.deepEqual(c.items(), [{ sku: 'A', unitPriceCents: 100, qty: 3 }, { sku: 'B', unitPriceCents: 50, qty: 1 }]);
});

test('AC-2 rejects invalid price and quantity', () => {
  const c = new Cart();
  assert.throws(() => c.addItem('A', -1), RangeError);
  assert.throws(() => c.addItem('A', 100, 0), RangeError);
  assert.throws(() => c.addItem('A', 100, 1.5), RangeError);
});

test('AC-3 rejects a price change for an existing SKU', () => {
  const c = new Cart();
  c.addItem('A', 100);
  assert.throws(() => c.addItem('A', 200), Error);
});

test('AC-4 removes partially, fully and rejects unknown SKUs', () => {
  const c = new Cart();
  c.addItem('A', 100, 3);
  c.removeItem('A', 1);
  assert.equal(c.items()[0].qty, 2);
  c.removeItem('A', 10);
  assert.deepEqual(c.items(), []);
  assert.throws(() => c.removeItem('A'), Error);
});

test('AC-5 subtotal multiplies price by quantity', () => {
  const c = new Cart();
  c.addItem('A', 250, 2);
  c.addItem('B', 99);
  assert.equal(c.subtotal(), 599);
  assert.equal(c.total(), 599);
});
`;

const DISCOUNT_TESTS = String.raw`import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cart } from '../../src/cart.ts';

test('AC-6 SAVE10 rounds the discount down', () => {
  const c = new Cart();
  c.addItem('A', 1999);
  c.applyDiscount('SAVE10');
  assert.equal(c.total(), 1800);
});

test('AC-6 FLAT5 needs a subtotal of 2000', () => {
  const c = new Cart();
  c.addItem('A', 1999);
  c.applyDiscount('FLAT5');
  assert.equal(c.total(), 1999);
  c.addItem('B', 1);
  assert.equal(c.total(), 1500);
});

test('AC-7 last code wins and unknown codes throw', () => {
  const c = new Cart();
  c.addItem('A', 3000);
  c.applyDiscount('FLAT5');
  c.applyDiscount('SAVE10');
  assert.equal(c.total(), 2700);
  assert.throws(() => c.applyDiscount('NOPE'), Error);
});

test('AC-8 total never goes below zero', () => {
  const c = new Cart();
  c.applyDiscount('SAVE10');
  assert.equal(c.total(), 0);
});
`;

const CORE_BUGGY = String.raw`export interface CartLine { sku: string; unitPriceCents: number; qty: number }

export class Cart {
  #lines = new Map<string, CartLine>();

  addItem(sku: string, unitPriceCents: number, qty = 1): void {
    if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0) throw new RangeError('price must be integer cents >= 0');
    if (!Number.isInteger(qty) || qty < 1) throw new RangeError('qty must be a positive integer');
    const line = this.#lines.get(sku);
    if (line) line.qty += qty;
    else this.#lines.set(sku, { sku, unitPriceCents, qty });
  }

  removeItem(sku: string, qty?: number): void {
    const line = this.#lines.get(sku);
    if (!line) throw new Error('unknown sku ' + sku);
    if (qty === undefined || qty >= line.qty) this.#lines.delete(sku);
    else line.qty -= qty;
  }

  items(): CartLine[] {
    return [...this.#lines.values()].map(l => ({ ...l }));
  }

  subtotal(): number {
    let sum = 0;
    for (const l of this.#lines.values()) sum += l.unitPriceCents;
    return sum;
  }

  total(): number {
    return this.subtotal();
  }
}
`;

const CORE_FIXED = CORE_BUGGY
  .replace('if (line) line.qty += qty;', "if (line && line.unitPriceCents !== unitPriceCents) throw new Error('price changed for ' + sku);\n    if (line) line.qty += qty;")
  .replace('sum += l.unitPriceCents;', 'sum += l.unitPriceCents * l.qty;');

const FULL = CORE_FIXED
  .replace('  #lines = new Map<string, CartLine>();', "  #lines = new Map<string, CartLine>();\n  #code: 'SAVE10' | 'FLAT5' | null = null;")
  .replace(`  total(): number {
    return this.subtotal();
  }`, `  applyDiscount(code: string): void {
    if (code !== 'SAVE10' && code !== 'FLAT5') throw new Error('unknown discount code ' + code);
    this.#code = code;
  }

  total(): number {
    const sub = this.subtotal();
    let discount = 0;
    if (this.#code === 'SAVE10') discount = Math.floor(sub / 10);
    if (this.#code === 'FLAT5' && sub >= 2000) discount = 500;
    return Math.max(0, sub - discount);
  }`);

const REVIEW = String.raw`VERDICT: approve

1. (minor) src/cart.ts:30 — items() copies every line on each call; fine at this size, revisit if carts get large.
2. (minor) src/cart.ts:5 — discount codes are a string union; a table of rules would make adding codes a data change.
No security issues: no I/O, no external input beyond arguments.
`;


const CODEBASE_REVIEW = `VERDICT: approve

## Overview
A small shopping-cart library. No entry point yet; tests run with node --test.

## Change map
| AC | File | Change | Risk |
|---|---|---|---|
| AC-1..5 | new src/cart.ts | Cart class with lines and subtotal | low |
| AC-6..8 | src/cart.ts | applyDiscount | low |

## Risks
- No existing tests: nothing protects current behaviour.
`;

const BOARD = `# Board: NUCLEO-F446RE (demo)

- MCU: STM32F446RET6, LQFP64, 512 KB flash, 128 KB RAM (from-internet: st.com)
- Clock: HSE 8 MHz from ST-Link MCO, SYSCLK 180 MHz (from-file: .ioc)

| Pin | Signal | Peripheral | Notes |
|---|---|---|---|
| PA2 | USART2_TX | USART2 | ST-Link virtual COM port |
| PA3 | USART2_RX | USART2 | ST-Link virtual COM port |
| PA5 | LD2 | GPIO out | User LED |
| PC13 | B1 | GPIO in | User button, external pull-up |

Assumed: no external crystal fitted on X3.
`;

const RIG = `# Hardware-in-the-loop rig (demo)

How tests reach the real board, so the AI can flash it and read what it prints.

- Connection: local USB, ST-Link V2-1 on the board
- Flash: \`.devcrew/hil/flash.sh build/firmware.elf\` (openocd, verify after write)
- Serial: ST-Link virtual COM port at 115200 baud, captured for 5 s after reset
- Lock: one lock file per board serial number, so two runs never use the board at once
- Safety: no option bytes, no mass erase, no read-out protection changes

To confirm: the serial port name on your machine.
`;

const RIG_JSON = JSON.stringify({
  board: 'NUCLEO-F446RE',
  connection: { type: 'local' },
  programmer: { tool: 'openocd', interface: 'stlink', target: 'stm32f4x' },
  serial: { port: '/dev/tty.usbmodem*', baud: 115200 },
  lock: { name: 'nucleo-f446re', timeoutSeconds: 300 },
}, null, 2);

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

// fast-arch: the Architect's design. util/ may not use the cart, which the first build breaks.
const architecture = JSON.stringify({
  modules: [
    { id: 'cart', path: 'src/cart.ts', purpose: 'The cart: lines, subtotal and discount codes.', mayUse: ['util'] },
    { id: 'util', path: 'src/util/', purpose: 'Small helpers with no knowledge of the cart.', mayUse: [] },
  ],
  decisions: [{ id: 'ADR-1', title: 'Integer cents', decision: 'All money is integer cents.', why: 'No rounding drift.' }],
});
const architectureDoc = '# Architecture\n\nThe cart owns lines and discounts; util holds helpers that know nothing about carts.\nA new discount code is a new branch in applyDiscount.\n';
// A helper that reaches back into the cart: it compiles and the tests pass, but util may not use cart
const badHelper = "import { Cart } from '../cart.ts';\nexport const emptyCart = () => new Cart();\n";
const goodHelper = 'export const cents = (n: number) => Math.round(n);\n';

export default {
  delayMs: 450,
  turns: {
    qa: [{
      awaits: 'dev:main',
      thinking: 'Reading the requirement and the project…',
      files: {
        'acceptance/cart-core/cart.test.ts': CORE_TESTS,
        'acceptance/discounts/discounts.test.ts': DISCOUNT_TESTS,
        '.devcrew/acceptance.json': JSON.stringify({ testCommand: 'node --test "acceptance/**/*.test.ts"' }),
      },
      message: 'Acceptance tests for every clause in acceptance/cart-core and acceptance/discounts.',
    }],
    architect: [{
      thinking: 'Reading the requirement…',
      files: { '.devcrew/architecture.json': architecture, '.devcrew/ARCHITECTURE.md': architectureDoc, 'contracts/cart.d.ts': CONTRACT },
      message: 'Two modules: the cart, and helpers that may not use it.',
    }],
    'dev:main': [
      {
        awaits: 'qa',
        thinking: 'Reading the requirement and the project…',
        files: { 'src/cart.ts': CORE_FIXED, 'src/util/carts.ts': badHelper, 'tests/cart.test.ts': ownTest, '.devcrew/test.json': builderRun },
        commands: ['node --test "tests/**/*.test.ts"'],
        message: 'Built the cart with its lines and subtotal; my test passes.',
      },
      {
        thinking: 'The hidden discount tests fail: applyDiscount is missing…',
        files: { 'src/cart.ts': FULL, 'src/util/carts.ts': goodHelper },
        message: 'Added the SAVE10 and FLAT5 discount codes.',
      },
    ],
    reviewer: [{
      thinking: 'Reviewing git diff against the requirement and contracts…\n\n',
      files: { '.devcrew/review.md': REVIEW },
      commands: ['git diff'],
      message: 'VERDICT: approve, 2 minor findings.',
      tokens: { input: 19000, output: 1500 },
    }],
    security: [
      {
        thinking: 'Checking every change for misuse and data leaks…\n\n',
        files: { '.devcrew/security.md': 'VERDICT: changes\n\n1. (high) src/cart.ts:8 — addItem accepts any SKU string, including empty or 10 MB strings; limit SKUs to 1-64 printable characters.\n' },
        commands: ['git diff'],
        message: 'VERDICT: changes, 1 high finding.',
        tokens: { input: 17000, output: 900 },
      },
      {
        thinking: 'Re-checking after the fix…\n\n',
        files: { '.devcrew/security.md': 'VERDICT: approve\n\nThe SKU finding is addressed. No other issues found.\n' },
        message: 'VERDICT: approve.',
        tokens: { input: 18000, output: 400, cached: 15000 },
      },
    ],
    codebase: [{
      thinking: 'Reading the existing code before anything new is designed…\n\n',
      files: { '.devcrew/codebase-review.md': CODEBASE_REVIEW },
      commands: ['git log --oneline -20', 'ls -R src'],
      message: 'Wrote the codebase review and the change map.',
      tokens: { input: 24000, output: 2100 },
    }],
    board: [{
      thinking: 'Reading the .ioc file and looking up the board online…\n\n',
      files: { '.devcrew/hardware/board.md': BOARD },
      commands: ['WebSearch: NUCLEO-F446RE user manual pinout'],
      message: 'Hardware reference written; 1 assumption to confirm.',
      tokens: { input: 22000, output: 1900 },
    }],
    hil: [{
      thinking: 'Designing how the AI can flash the board and read its serial port…\n\n',
      files: { '.devcrew/hil/RIG.md': RIG, '.devcrew/hil/rig.json': RIG_JSON },
      commands: ['st-info --probe', 'ls /dev/tty.usbmodem*'],
      message: 'Rig designed: local ST-Link, serial on the ST-Link VCP, one lock per board.',
      tokens: { input: 21000, output: 2300 },
    }],
    firmware: [{
      thinking: 'Checking the firmware against the board…\n\n',
      files: { '.devcrew/firmware-review.md': 'VERDICT: approve\n\nNo hardware-related problems found.\n' },
      commands: ['git diff'],
      message: 'VERDICT: approve.',
      tokens: { input: 17000, output: 700 },
    }],
    single: [{
      thinking: 'Building the whole thing in one go…\n\n',
      files: { 'src/cart.ts': FULL, 'tests/cart.test.ts': CORE_TESTS.replaceAll('../../src', '../src') },
      commands: ['node --test'],
      message: 'Implemented the cart and tests.',
      tokens: { input: 52000, output: 7800 },
    }],
  },
};
