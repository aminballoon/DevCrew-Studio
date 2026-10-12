// Scripted run of bench task S-01-cart for the fake agent.
// The story it tells: planner splits the work into two modules, QA writes tests first,
// the dev's first try at "cart-core" has a bug and also tries to edit a test (the guard
// reverts it), the second try passes, "discounts" passes first time, the reviewer approves.

const PRD = String.raw`# PRD — Shopping cart

## Goal
A dependency-free cart module that prices orders in integer cents and supports two discount codes.

## User stories
- As a shopper I can add, top up and remove items so my cart matches what I want.
- As a shopper I can apply a discount code and see the reduced total.

## Acceptance Criteria
- AC-1 addItem adds a line or increases the quantity of an existing SKU.
- AC-2 Prices are integer cents >= 0, quantities positive integers; otherwise RangeError.
- AC-3 Re-adding a SKU at a different price throws Error.
- AC-4 removeItem removes qty units, or the whole line when qty is omitted or too large; unknown SKU throws.
- AC-5 subtotal is the sum of price x qty.
- AC-6 SAVE10 = 10% off subtotal, discount rounded down; FLAT5 = 500 off when subtotal >= 2000.
- AC-7 Only the last applied code counts; unknown codes throw.
- AC-8 total never goes below 0.

## Out of scope
Currencies, tax, persistence.
`;

const PLAN = JSON.stringify({
  modules: [
    { id: 'cart-core', title: 'Cart lines and subtotal', description: 'src/cart.ts: addItem, removeItem, items, subtotal, total without discounts. AC-1..AC-5.' },
    { id: 'discounts', title: 'Discount codes', description: 'applyDiscount and discounted total in src/cart.ts. AC-6..AC-8.' },
  ],
  testCommand: 'node --test',
  moduleTestCommand: 'node --test "tests/{module}/**/*.test.ts"',
  checks: [],
  architecture: {
    files: [
      {
        path: 'contracts/cart.d.ts', kind: 'contract', modules: [],
        purpose: 'The agreed shape of the cart: which methods exist and what they take and return. Code and tests are both written against it.',
        exports: ['CartLine', 'Cart'], dependsOn: [],
      },
      {
        path: 'src/cart.ts', kind: 'source', modules: ['cart-core', 'discounts'],
        purpose: 'The cart itself: keeps the lines, prices them in cents, and applies one discount code at a time.',
        exports: ['Cart', 'CartLine'], dependsOn: ['contracts/cart.d.ts'],
      },
      {
        path: 'tests/cart-core/cart.test.ts', kind: 'test', modules: ['cart-core'],
        purpose: 'Checks adding, topping up and removing items, input validation and the subtotal (AC-1 to AC-5).',
        exports: [], dependsOn: ['src/cart.ts'],
      },
      {
        path: 'tests/discounts/discounts.test.ts', kind: 'test', modules: ['discounts'],
        purpose: 'Checks both discount codes, the 2000-cent threshold, rounding, and that the total never goes below zero (AC-6 to AC-8).',
        exports: [], dependsOn: ['src/cart.ts'],
      },
    ],
  },
}, null, 2);

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

const SYSTEM_V1 = JSON.stringify({
  title: 'Delivery robot (demo)',
  groups: [{ id: 'brain', name: 'High level' }, { id: 'base', name: 'Mobile base' }],
  blocks: [
    { id: 'battery', name: 'Battery pack', kind: 'power', group: 'base', part: '', description: '24 V pack for motors and electronics' },
    { id: 'lidar', name: '2D LiDAR', kind: 'sensor', group: 'brain', part: '', description: '360 degree scan for mapping and obstacles' },
    { id: 'camera', name: 'Depth camera', kind: 'sensor', group: 'brain', part: '', description: 'Detects people and doors' },
    { id: 'computer', name: 'Main computer', kind: 'compute', group: 'brain', part: '', description: 'Runs ROS 2 navigation' },
    { id: 'mcu', name: 'Motor controller', kind: 'controller', group: 'base', part: '', description: 'Closed-loop wheel speed control and e-stop' },
    { id: 'motors', name: 'Wheel motors', kind: 'actuator', group: 'base', part: '', description: 'Two hub motors with encoders' },
    { id: 'fleet', name: 'Fleet server', kind: 'external', description: 'Sends delivery jobs' },
  ],
  links: [
    { from: 'battery', to: 'computer', interface: '12 V DC-DC', kind: 'power' },
    { from: 'battery', to: 'motors', interface: '24 V', kind: 'power' },
    { from: 'lidar', to: 'computer', interface: 'Ethernet', kind: 'data', label: 'scans' },
    { from: 'camera', to: 'computer', interface: 'USB 3', kind: 'data', label: 'depth' },
    { from: 'computer', to: 'mcu', interface: 'UART 921600', kind: 'control', label: 'velocity' },
    { from: 'mcu', to: 'computer', interface: 'UART 921600', kind: 'data', label: 'odometry' },
    { from: 'mcu', to: 'motors', interface: 'PWM + encoders', kind: 'control' },
    { from: 'fleet', to: 'computer', interface: 'Wi-Fi MQTT', kind: 'data', label: 'jobs' },
  ],
}, null, 2);

// The second version has the parts the scout recommended
const SYSTEM_V2 = (() => {
  const sys = JSON.parse(SYSTEM_V1);
  const parts = { battery: '24 V 20 Ah LiFePO4', lidar: 'RPLIDAR S2', camera: 'Intel RealSense D435i', computer: 'Jetson Orin Nano 8GB', mcu: 'STM32G474 (B-G474E-DPOW1)', motors: '2x 200 W hub motor' };
  for (const b of sys.blocks) b.part = parts[b.id] ?? b.part;
  return JSON.stringify(sys, null, 2);
})();

const SYSTEM_MD = `# System architecture (demo)

The main computer plans paths from LiDAR and camera data and sends wheel speeds to a
motor controller, which closes the speed loop and owns the emergency stop.
`;

const OPTIONS = `# Hardware options (demo, checked 2026-10-12)

## Main computer
| Part | Key specs | Price | Lifecycle | Datasheet |
|---|---|---|---|---|
| **Jetson Orin Nano 8GB** (recommended) | 40 TOPS, 4x USB 3 | ~$249 | active | nvidia.com |
| Raspberry Pi 5 8GB | no GPU for vision | ~$80 | active | raspberrypi.com |

Recommended: Jetson, because the depth camera needs GPU inference; costs more and draws up to 15 W.
`;

const ARCH_REVIEW = `VERDICT: approve

1. (medium) battery → computer: no power budget for the 12 V rail; add peak current per load.
2. (medium) mcu: the e-stop path depends on UART; add a hardware e-stop input to the motor driver.
`;

export default {
  delayMs: 450,
  turns: {
    planner: [{
      thinking: 'Reading the requirement and the empty workspace…\n\n',
      files: { '.devcrew/PRD.md': PRD, 'contracts/cart.d.ts': CONTRACT, '.devcrew/plan.json': PLAN },
      message: 'Planned 2 modules: cart-core (AC-1..5) and discounts (AC-6..8).',
      tokens: { input: 18000, output: 2600 },
    }],
    qa: [{
      thinking: 'Writing tests from the acceptance criteria before any code exists…\n\n',
      files: { 'tests/cart-core/cart.test.ts': CORE_TESTS, 'tests/discounts/discounts.test.ts': DISCOUNT_TESTS },
      message: 'tests/cart-core covers AC-1..5, tests/discounts covers AC-6..8.',
      tokens: { input: 21000, output: 3400 },
    }],
    'dev:cart-core': [
      {
        thinking: 'Implementing cart lines…\n\n',
        // The first try forgets quantities, and also "fixes" a test it does not like
        files: { 'src/cart.ts': CORE_BUGGY, 'tests/cart-core/cart.test.ts': CORE_TESTS.replace('599', '349') },
        commands: ['node --test "tests/cart-core/**/*.test.ts"'],
        message: 'Implemented Cart core.',
        tokens: { input: 26000, output: 4100 },
      },
      {
        thinking: 'Verification says subtotal ignores quantity and price changes are accepted. Fixing…\n\n',
        files: { 'src/cart.ts': CORE_FIXED },
        commands: ['node --test "tests/cart-core/**/*.test.ts"'],
        message: 'Subtotal now multiplies by quantity; re-adding at another price throws.',
        tokens: { input: 31000, output: 2200, cached: 22000 },
      },
    ],
    'dev:discounts': [{
      thinking: 'Adding discount codes…\n\n',
      files: { 'src/cart.ts': FULL },
      commands: ['node --test "tests/discounts/**/*.test.ts"'],
      message: 'Added applyDiscount with SAVE10 and FLAT5.',
      tokens: { input: 24000, output: 2900 },
    }],
    reviewer: [{
      thinking: 'Reviewing git diff against the PRD and contracts…\n\n',
      files: { '.devcrew/review.md': REVIEW },
      commands: ['git diff'],
      message: 'VERDICT: approve, 2 minor findings.',
      tokens: { input: 19000, output: 1500 },
    }],
    // Used by the "with-security" pipeline: the first review sends the code back once
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
    // Demo turns for the roles of the existing-code, firmware-board and system-integration pipelines
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
    architect: [
      {
        thinking: 'Breaking the system into blocks and interfaces…\n\n',
        files: { '.devcrew/system.json': SYSTEM_V1, '.devcrew/SYSTEM.md': SYSTEM_MD },
        message: 'First system architecture: 7 blocks, 8 links.',
        tokens: { input: 16000, output: 2600 },
      },
      {
        thinking: 'Applying your feedback and the chosen parts…\n\n',
        files: { '.devcrew/system.json': SYSTEM_V2, '.devcrew/SYSTEM.md': SYSTEM_MD },
        message: 'Updated the architecture with the recommended parts.',
        tokens: { input: 23000, output: 2400, cached: 14000 },
      },
    ],
    scout: [{
      thinking: 'Searching for parts that fit each block…\n\n',
      files: { '.devcrew/hardware/options.md': OPTIONS },
      commands: ['WebSearch: Jetson Orin Nano price Thailand', 'WebSearch: STM32G474 motor control board'],
      message: 'Found 2-3 options per block.',
      tokens: { input: 34000, output: 3800 },
    }],
    arch: [{
      thinking: 'Checking interfaces, power and failure paths…\n\n',
      files: { '.devcrew/arch-review.md': ARCH_REVIEW },
      message: 'VERDICT: approve, 2 medium findings.',
      tokens: { input: 21000, output: 1600 },
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
