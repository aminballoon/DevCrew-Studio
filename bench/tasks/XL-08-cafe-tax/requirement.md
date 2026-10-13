This project is the existing Tilly pricing engine (`src/`, exported from `src/index.ts`). Everything it does today must keep working, except where this change request says otherwise. Follow the conventions the code already uses, and keep its tests passing (update them where this change makes them wrong).

## Change request: tax rules per store

1. **Tax config.** The config takes an optional `tax: { mode, rates: { default, byCategory? } }`.
   - `mode` is `"inclusive"` (prices include tax) or `"exclusive"` (tax is added on top).
   - Rates are integer percentages from 0 to 30. `byCategory` maps a category to its own rate.
   - Without `tax`, the store is inclusive at 7%, as today.
   - A bad tax config is `INVALID_CONFIG`.
2. **Line tax.** A line's `taxRate` is its category's rate, or the default rate. Its `tax` is computed on `net`, rounded half up:
   - inclusive: `net × rate / (100 + rate)`;
   - exclusive: `net × rate / 100`.
3. **Totals.** Inclusive stores keep `total` as the sum of `net`. Exclusive stores have `total = sum of net + tax`. Cash rounding applies to that total.
4. **Tax summary.** The receipt gains `taxes`: one entry per rate used, `{ rate, taxable, tax }`, sorted by rate. `taxable` is the sum of `net` of the lines at that rate, and `tax` is the sum of their taxes.
