This project is the existing Tilly pricing engine (`src/`, exported from `src/index.ts`). Everything it does today must keep working, except where this change request says otherwise. Follow the conventions the code already uses, and keep its tests passing (update them where this change makes them wrong).

## Change request: more promotion types

Two new promotion types join `percentOff`. As before, a line gets the single promotion with the largest discount (on a tie, the smaller `id`). Every promotion `id` must be unique across all types. A bad promotion of any type is `INVALID_CONFIG`.

1. **`buyXgetY`:** `{ id, type: "buyXgetY", sku, buy, get }`, where `sku` must be in the catalog and `buy` and `get` are integers ≥ 1.
   - On a line of that sku, for every complete group of `buy + get` units, `get` units are free.
   - Discount: `floor(qty / (buy + get)) × get × unitPrice` (the unit price includes modifiers).
2. **`happyHour`:** `{ id, type: "happyHour", category, percent, from, to }`, where `from` and `to` are `HH:MM` and `from < to`.
   - It works like `percentOff`, but only when the order's `at` time of day is at or after `from` and before `to`.
   - An order without `at` gets no happy-hour discount.
