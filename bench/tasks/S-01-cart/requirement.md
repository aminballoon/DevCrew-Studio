Build a shopping cart module in TypeScript at `src/cart.ts` that exports a class `Cart`.

- `addItem(sku: string, unitPriceCents: number, qty = 1)`: adds a line, or increases the quantity of an existing SKU. Prices are integer cents (>= 0); quantities are positive integers. Invalid values throw `RangeError`. Adding an existing SKU with a different price throws `Error`.
- `removeItem(sku: string, qty?: number)`: removes `qty` units, or the whole line when `qty` is omitted or exceeds the quantity. An unknown SKU throws `Error`.
- `items()`: the lines as `{ sku, unitPriceCents, qty }`, in insertion order.
- `subtotal()`: sum of price × quantity, in cents.
- `applyDiscount(code: string)`: `SAVE10` takes 10% off the subtotal (the discount is rounded down to whole cents); `FLAT5` takes 500 cents off when the subtotal is at least 2000 cents and does nothing otherwise. Only one code applies at a time: the last one applied wins. Unknown codes throw `Error`.
- `total()`: subtotal minus the discount, never below 0.

No dependencies. Tests run with `node --test` (Node runs `.ts` files directly; import with the `.ts` extension).
