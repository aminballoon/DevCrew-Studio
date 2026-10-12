Build a TypeScript library for an internal money ledger (wallets inside one company). Everything is exported from one entry point: `src/index.ts`.

## Errors
Export five error classes, each extending `Error`: `ValidationError`, `NotFoundError`, `ConflictError`, `InsufficientFundsError` and `FrozenError`.

## Storage
The ledger keeps **all** of its state in a store passed to the constructor, so that a new `Ledger` on the same store sees the same accounts, balances, transactions and idempotency keys:

```ts
interface Store {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}
```

Values are strings (use JSON). The store may be slow and every call may take a different time. Only one `Ledger` uses a store at a time, but that `Ledger` may receive many calls at once (for example `Promise.all` of many transfers): the result must be the same as if the calls ran one after another, in some order. Export `MemoryStore`, a simple in-memory `Store`.

## Ledger
`new Ledger(store)`. All methods are `async`. Amounts are integers in minor units (satang, cents); valid amounts are positive safe integers, anything else throws `ValidationError`. No balance may ever go above `Number.MAX_SAFE_INTEGER` (`ValidationError`).

- `openAccount(accountId, { currency })`: currency is `THB` or `USD` (`ValidationError` otherwise). Account ids are 1 to 64 characters of `A-Z a-z 0-9 _ -` (`ValidationError` otherwise). An existing id throws `ConflictError`. New accounts have balance 0.
- `balance(accountId)` returns the balance (number). Unknown accounts throw `NotFoundError` in every method.
- `deposit(accountId, amount, idempotencyKey)`, `withdraw(accountId, amount, idempotencyKey)` and `transfer({ from, to, amount, idempotencyKey })` return a transaction `{ id, type, from, to, amount, currency }`. `type` is `deposit`, `withdraw`, `transfer` or `reversal`; `from` is `null` for deposits and `to` is `null` for withdrawals.
- A withdrawal or transfer that would make a balance negative throws `InsufficientFundsError` and changes nothing.
- A transfer between accounts of different currencies, or from an account to itself, throws `ValidationError`.
- **Idempotency keys** are unique across the whole ledger. Repeating a call with a key that was already used *with the same arguments* returns the original transaction and changes nothing. Using a used key with different arguments (or a different method) throws `ConflictError`. A call that failed does not use up its key.
- `freeze(accountId)` / `unfreeze(accountId)`: a frozen account can neither send nor receive money (deposits, withdrawals and transfers in or out throw `FrozenError`); its balance can still be read.
- `reverse(transactionId, idempotencyKey)` undoes a transfer by moving the same amount back (`type: 'reversal'`, `from` and `to` swapped). Only transfers can be reversed (`ValidationError` for others); a transfer can be reversed once (`ConflictError` the second time); an unknown transaction throws `NotFoundError`. The usual rules apply (enough funds, not frozen).
- `history(accountId)` returns the entries that touched the account, oldest first: `{ transactionId, type, amount, balanceAfter }` where `amount` is signed (positive in, negative out).

No dependencies. Tests run with `node --test` (Node runs `.ts` files directly; import with the `.ts` extension).
