Build **Tilly**, the pricing engine for a chain of cafés, as a TypeScript library. Start from an empty project. No dependencies; Node 22+ runs `.ts` files directly (import with the `.ts` extension) and tests run with `node --test`.

This engine will be developed for years by several teams. **Read the roadmap at the end: none of it is built now, but the design must make those changes easy.**

## API
`src/index.ts` exports `createEngine(config)`, `formatMoney(amount, currency)` and the error class `PricingError` (with a string `code`).

All money is an integer number of minor units (satang for THB). Rounding is always half up.

### Config
`{ catalog, promotions }`:
- `catalog`: a list of `{ sku, name, category, price }`. `sku` is unique and `price` is a non-negative integer.
- `promotions`: a list of `{ id, type: "percentOff", category, percent }`. `id` is unique and `percent` is an integer from 1 to 100.

An invalid config makes `createEngine` throw `PricingError` with code `INVALID_CONFIG`.

### Pricing an order
`engine.price(order)` takes `{ lines: [{ sku, qty, modifiers? }], at? }` and returns a receipt.
- `qty` is an integer from 1 to 999 (`INVALID_QTY` otherwise).
- An unknown `sku` is `UNKNOWN_SKU`.
- `modifiers` is a list of `{ name, price }` (for example oat milk, `+1500`). Each modifier's price is added to the unit price. A bad modifier, or `lines` that is not a list, is `INVALID_ORDER`.
- `at` is the local order time, `YYYY-MM-DDTHH:MM[:SS]`.

Each order line becomes a receipt line `{ sku, name, qty, unitPrice, amount, discount, net, taxRate, tax }`, in the order given:
- `unitPrice` is the catalog price plus the modifiers.
- `amount` is `unitPrice × qty`.
- `net` is `amount − discount`.

**Promotions.** A `percentOff` promotion applies to lines whose item is in its category. Its discount is `amount × percent / 100`, rounded.
- A line gets at most one promotion: the one with the largest discount (on a tie, the smaller `id`).
- The receipt's `discounts` lists every applied promotion as `{ promotionId, sku, line, amount }`, where `line` is the line's index.

**Tax.** Prices include 7% VAT. Each line's `tax` is `net × 7 / 107`, rounded, and its `taxRate` is `7`.

The receipt also has:
- `currency` (`"THB"`);
- `subtotal` (sum of `amount`);
- `discountTotal` (sum of `discount`);
- `tax` (sum of the line taxes);
- `total` (sum of `net`).

### Formatting
`formatMoney(amount, "THB")` gives `฿1,234.50` for `123450`.

## Roadmap (do not build yet)
These are coming in the next releases, roughly in this order, and will be built by other developers on top of your code:
1. **Cash payments:** cash totals rounded to the smallest coin, and stores in other currencies (JPY with no minor unit, KWD with three digits).
2. **Tax rules per store:** prices with or without tax included, and different rates per category, with a tax summary on the receipt.
3. **More promotion types:** buy X get Y free, and happy-hour discounts that depend on the order time.
4. **Combining promotions:** priorities, and promotions that stack on top of each other.
