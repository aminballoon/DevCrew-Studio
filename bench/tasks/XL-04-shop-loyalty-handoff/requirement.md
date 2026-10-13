This project is an existing online shop backend (`src/`, start with `README.md` and `src/app.ts`) with its tests in `tests/`. Everything it does today must keep working, except where this change request says otherwise. Keep `createApp` and everything else exported from `src/index.ts`. Follow the conventions the code already uses. Update the existing tests where this change makes them wrong, and keep them all passing.

## Change request: loyalty points

### 1. Earning points
When an order is paid, its customer earns 1 point for every whole dollar of goods: `floor((subtotalCents − discountCents) / 100)`. Tax and shipping do not count, and neither does how the order was paid (card, store credit or both). Unpaid orders earn nothing.

### 2. Taking points back
An order's points follow what the customer kept:
- When a paid order is cancelled, all of its points are taken back.
- When a return is approved, the order's points go down to `floor(remaining / 100)`. `remaining` is the order's goods after discount minus the goods of every approved return of the order, where the returned goods of a line are `round(line netCents × returned units / line qty)`, rounded half up. Requested and rejected returns change nothing.
- A customer's points balance never goes below zero. Points that cannot be taken back because they were already spent are not taken back.

### 3. Spending points
`POST /customers/me/points/redeem` with `{ points }` turns points into store credit: 100 points become $1 (100 cents) of store credit.
- `points` must be a whole multiple of 100, at least 100 (`400` otherwise).
- More points than the balance is `409`.
- The store credit appears in the credit entries with kind `points`.
- Only customers have points: for staff and admins this endpoint is `404`.

### 4. Reading points
`GET /customers/me/points` and `GET /customers/:id/points` answer with `{ balance, entries }`. They follow the same visibility rules as store credit: a customer sees their own, another customer's is `404`, and staff see all.

`entries` lists every change, oldest first, as `{ at, points, kind, ref }`:
- `earned` is positive, and `ref` is the order id.
- `reversed` is negative, and `ref` is the order id.
- `redeemed` is negative.

### 5. Audit
Every change to points publishes an event (`points.earned`, `points.reversed`, `points.redeemed`), so it appears in the audit log.
