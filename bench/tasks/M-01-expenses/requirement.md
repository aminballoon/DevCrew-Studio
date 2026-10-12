Build a small TypeScript library for splitting shared expenses between friends (like a trip or a shared flat).

- Money is always in integer cents.
- `splitEvenly(amountCents, people)` splits an amount into `people` shares that differ by at most one cent and add up exactly to the amount. Leftover cents go to the first shares. Invalid input (negative or fractional amount, fewer than 1 person) throws `RangeError`.
- A `Ledger` records expenses `{ paidBy, amountCents, splitAmong }`. `balances()` returns, per person, how much they are owed (positive) or owe (negative). Balances always add up to zero. An expense with nobody to split among throws `Error`.
- `settle(balances)` returns a short list of transfers `{ from, to, amountCents }` that brings every balance to zero: the biggest debtor pays the biggest creditor first, ties broken by name. Balances that do not add up to zero throw `Error`.
- Everything is available from one entry point: `src/index.ts`.

No dependencies. Tests run with `node --test` (Node runs `.ts` files directly; import with the `.ts` extension).
