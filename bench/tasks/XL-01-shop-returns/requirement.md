This project is an existing online shop backend (`src/`; start with `README.md` and `src/app.ts`) with passing tests in `tests/`. Everything it does today must keep working, except where this change request says otherwise. Keep `createApp` and everything else exported from `src/index.ts`. Follow the conventions the code already uses (errors and HTTP statuses, ownership checks, events, money, stock movements, emails).

## Change request: returns

Customers can send back items from orders they have received and get their money back.

### 1. Requesting a return
`POST /orders/:id/returns` with body `{ lines: [{ lineId, qty, reason }], note? }` creates a return and answers `201` with it.
- The order's customer may request a return for their own order. Staff and admins may request one for any order. For a customer, someone else's order is `404`, as for every other order action.
- Only orders that are `delivered` or `partially_returned` (see section 4) can get a return. Any other status is `409`.
- Requests are accepted until exactly 30 days after the order was delivered (`deliveredAt` + 30 days, that instant included). Later requests are `409`.
- `lines` has at least one item. Each `lineId` must be a line of this order (`404` otherwise) and may appear only once in a request (`400` if repeated). `qty` is an integer of at least 1 (`400` otherwise). `reason` is one of `damaged`, `wrong_item`, `not_needed`, `other` (`400` otherwise). `note` is an optional string of up to 500 characters and is `""` when not given.
- Units cannot be returned twice: for each line, `qty` may not be more than the line's quantity minus the units of that line in the order's other returns that are `requested` or `approved` (`409`).
- A return looks like `{ id, orderId, status, lines: [{ lineId, sku, qty, reason }], note, refundCents, requestedAt, decidedAt, decidedBy }`. A new return has `status: "requested"`, `refundCents: null`, `decidedAt: null` and `decidedBy: null`. Return ids start with `ret_`. More fields may be added.

### 2. Reading returns
- `GET /returns/:id` answers with the return. Customers can only see returns of their own orders (`404` for any other).
- `GET /orders/:id/returns` lists the order's returns, oldest first. It follows the same visibility rules as the order.
- `GET /returns` is for staff and admins only (`403` for customers). It lists all returns oldest first, paginated like `GET /orders` (`{ items, nextCursor }`, with `limit` and `cursor`), with an optional `status` filter.

### 3. Deciding on a return
Only staff and admins may decide (`403` for customers). Only a `requested` return can be decided (`409` otherwise).
- `POST /returns/:id/reject` with `{ reason }` (required, at most 500 characters) answers `200`. The return gets `status: "rejected"`, `rejectionReason`, `decidedAt` and `decidedBy` (the deciding user's id). Units in a rejected return may be requested again in a new return.
- `POST /returns/:id/approve` with `{ lines: [{ lineId, condition }] }` answers `200`. `condition` is `resellable` or `damaged`, and must be given exactly once for every line of the return (`400` otherwise). The return gets `status: "approved"`, `decidedAt`, `decidedBy`, a `condition` on each of its lines, and `refundCents` (the amount refunded).
- Approving does all of the following, or nothing at all:
  - **Refund.** The money goes back on the order's captured payment, through the same refund path the shop already uses. That means it appears in the payment's `refunds` with reason `return <returnId>`, the payment gateway is called, and the customer gets the usual refund email. If the gateway fails, the API answers `402` and nothing changes: the return stays `requested` and the stock is untouched.
  - **Restock.** `resellable` units go back into stock (on hand goes up by their quantity) at the first warehouse in that line's `fulfilment`. This is recorded as a stock movement of kind `return` with `ref` set to the return id. `damaged` units are not restocked.
  - **Order status**, as described in section 4.

### Refund amount
- For each line of the return, the refund is what the customer paid for those units, counted from the line's `amounts.totalCents` (net of its discount share, plus tax). The refunds of one line across all its returns must add up exactly to the line's `totalCents` once all of its units are returned.
- So, for a line with quantity `Q` and total `T`, where `k` units are in earlier approved returns and this return has `n` units, this return refunds `round(T × (k + n) / Q) − round(T × k / Q)`. Rounding is half up.
- Shipping is refunded once. If this approval makes every unit of the order returned, and any line in any approved return of the order (this one included) has reason `damaged` or `wrong_item`, the order's `shippingCents` is added to this refund.
- A refund never exceeds what is left on the payment. For example, after an earlier goodwill refund the return refunds only what remains. `refundCents` is the amount actually refunded. When it is `0`, no payment refund is made.

### 4. Order status
- There are two new order statuses. `partially_returned` means some, but not all, units of the order are in approved returns. `returned` means all of them are.
- Approvals move an order from `delivered` to `partially_returned` and then to `returned`, or straight from `delivered` to `returned`. Each change is added to the order's `history` with the deciding user as actor.
- Orders in either status cannot be cancelled (`409`). Staff can still make refunds on them through `POST /payments/:id/refunds`.
- When an order becomes `returned` and it used a coupon, the coupon use is given back, as when an order is cancelled.

### 5. Events, audit and emails
- Publish `return.requested`, `return.approved` and `return.rejected` events with entity `return`, the return id, the acting user, and `orderId` in the data. They then show in the audit log, e.g. `GET /audit?entity=return`.
- Order status changes publish `order.partially_returned` and `order.returned`.
- The customer is emailed through the outbox:
  - template `return_received` when a return is requested, with subject `Return request for order SO-1001 received`;
  - `return_approved` when it is approved, with subject `Return for order SO-1001 approved: $12.34 refunded` (the return's `refundCents`);
  - `return_rejected` when it is rejected, with subject `Return for order SO-1001 rejected`.
- These come in addition to the existing refund email.

### 6. Reports
- In the sales report, return refunds count in `refundsCents` on the day the return was approved.
- `topProducts` subtracts the units in approved returns of the orders it counts. Products with no units left are not listed.
