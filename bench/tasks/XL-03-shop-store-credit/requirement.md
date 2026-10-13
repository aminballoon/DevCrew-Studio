This project is an existing online shop backend (`src/`, start with `README.md` and `src/app.ts`) with its tests in `tests/`. Everything it does today must keep working, except where this change request says otherwise. Keep `createApp` and everything else exported from `src/index.ts`. Follow the conventions the code already uses. Update the existing tests where this change makes them wrong, and keep them all passing.

## Change request: gift cards and store credit

Customers can hold store credit, top it up with gift cards, pay with it, and get refunds back into it.

### 1. Gift cards
- Staff and admins issue gift cards with `POST /gift-cards` and body `{ amountCents }`, an integer from 1 to 100000 (`400` otherwise). Customers get `403`.
- The answer is `201` with `{ id, code, amountCents }`. `code` is 16 random characters from `A-Z` and `0-9`.
- The code is a secret. It is returned only in this response, and must never appear in the audit log, in emails or in any other response.
- A customer redeems a gift card with `POST /customers/me/credit/redeem` and body `{ code }`. Codes are not case-sensitive.
  - An unknown code is `404`.
  - A code that has already been redeemed, by anyone, is `409`.
  - On success the gift card's amount is added to the customer's store credit, and the answer is the credit summary (section 2).
- Issuing and redeeming publish `gift_card.issued` and `gift_card.redeemed` events (entity `gift_card`).

### 2. Store credit
- `GET /customers/me/credit` and `GET /customers/:id/credit` answer with `{ balanceCents, entries }`. They follow the same visibility rules as the customer profile: a customer sees their own, another customer's is `404`, and staff see all.
- `entries` lists every change to the balance, oldest first, as `{ at, amountCents, kind, ref }`. `amountCents` is positive for credit added and negative for credit spent. `kind` and `ref` are:
  - `gift_card`: `ref` is the gift card's id, never its code;
  - `payment`: `ref` is the payment id;
  - `refund`: `ref` is the payment id.
- The balance can never go below zero.

### 3. Paying with store credit
- `POST /orders/:id/payments` accepts an optional `useCreditCents`: a non-negative integer, `0` by default.
  - More than the order total is `400`.
  - More than the customer's balance is `409`.
- The card is charged for the rest of the total. When credit covers the whole total, no `cardToken` is needed and the gateway is not called. Otherwise `cardToken` is required as before.
- The credit is only taken once the card charge has succeeded. A declined card, or a refused request, takes no credit and charges no card.
- Payments now include `creditCents` and `cardCents`. Their `amountCents` is the sum of the two, and a card-only payment has `creditCents: 0`.

### 4. Refunds
- This applies to every refund: order cancellations, staff refunds and approved returns.
- Each refund goes back to the card first, up to what the card paid minus what has already been refunded to the card. The rest goes back to the customer's store credit as a `refund` entry.
- Each item in a payment's `refunds` now includes `toCardCents` and `toCreditCents`. The gateway is only called for the card part, and not at all when that part is `0`. `refundedCents` counts both parts.
- A return request may include `refundTo`: `original` (the default) or `store_credit`; any other value is `400`. Returns show their `refundTo`. When a return with `store_credit` is approved, its whole refund goes to store credit and nothing goes to the card.
- When part of a refund goes to store credit, the customer also gets a `credit_added` email with subject `$12.34 added to your store credit` (the store credit part). This comes in addition to the usual refund email.
- Sales reports count refunds to store credit in `refundsCents`, like any other refund.
