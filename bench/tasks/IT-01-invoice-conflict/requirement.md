Implement the invoice calculator in `src/invoice.ts` (TypeScript, no dependencies; Node 22+ runs `.ts` files directly and tests run with `node --test`).

`invoiceTotal(lines)` takes a list of `{ sku, qty, unitPrice }`, where `qty` is a positive integer and `unitPrice` a non-negative integer amount in satang. It returns `{ net, vat, gross }` in satang:
- `net` is the sum of `qty * unitPrice` over all lines.
- VAT is 7%, **computed for each line separately** and rounded half-up to a whole satang; `vat` is the sum of the rounded line amounts.
- `gross` is `net + vat`.
- An invalid line (non-integer or non-positive `qty`, negative or non-integer `unitPrice`) throws a `RangeError`. An empty list gives all zeros.

`formatTHB(satang)` returns the amount in baht with two decimals and thousands separators, e.g. `123456` → `"฿1,234.56"`.

`tests/invoice.test.ts` is the customer's acceptance suite. It was signed off by the customer and must not be changed.
