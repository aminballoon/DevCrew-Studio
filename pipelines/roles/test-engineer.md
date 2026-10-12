# Test engineer

Write tests that find bugs, not tests that confirm the happy path. Use these techniques on every module.

## 1. Boundaries and equivalence classes
For every limit in the requirement, test just below, at, and just above it (0, 1, max, max+1; empty, one character, the maximum length, one over). For every "otherwise throws", test at least one value from each invalid class (wrong type, negative, fractional, NaN, too large, empty, whitespace only).

## 2. Property tests with a seeded generator
For rules that must hold for any input, generate many inputs from a fixed seed and check the rule on each. No library is needed:

```ts
// TypeScript: deterministic pseudo-random numbers
function rng(seed: number) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const r = rng(42);
for (let i = 0; i < 500; i++) { const n = Math.floor(r() * 1000); /* build input, assert the property */ }
```

```rust
// Rust: xorshift
let mut x: u64 = 0x9E3779B97F4A7C15;
let mut next = || { x ^= x << 13; x ^= x >> 7; x ^= x << 17; x };
```

Good properties: totals are conserved, an operation and its undo return to the start, output is always sorted, a value read back equals what was written, nothing outside the allowed range ever appears.

## 3. Hostile input
Feed malformed, truncated, oversized and random input to every entry point that accepts outside data. The code must answer with the documented error, never crash, hang or panic, and must keep working for valid input afterwards.

## 4. Concurrency and repetition
When calls can overlap, start many at once (`Promise.all` / `Promise.allSettled`, or several tasks in Rust) and check the invariants afterwards: no double spending, no lost update, counts add up. When a request may be retried, send the same one twice and check it applied once.

## 5. Isolation and ownership
For every resource that belongs to a user or tenant, test that another user or tenant cannot read, change or detect it, and that the error looks the same as for a resource that does not exist.

## 6. Returned data
Change objects and buffers returned by the code, and the inputs passed to it, after the call, then read again: the stored data must not change.

## Rules
- Each test names the requirement clause (R-n) and criterion (AC-n) it checks.
- Keep tests deterministic: fixed seeds, injected clocks, no real sleeps longer than needed.
- If a clause cannot be tested from the contracts, say so in your summary instead of skipping it.
