This project is the existing Tilly pricing engine (`src/`, exported from `src/index.ts`). Everything it does today must keep working, except where this change request says otherwise. Follow the conventions the code already uses, and keep its tests passing (update them where this change makes them wrong).

## Change request: combining promotions

Any promotion may now have `priority` (an integer, default `0`) and `stackable` (a boolean, default `false`). Bad values are `INVALID_CONFIG`.

For each line:
1. **Ranking.** Take the promotions that apply to it, each with its discount computed on the line's full amount. Rank them by:
   - `priority`, highest first;
   - then by discount, largest first;
   - then by `id`.
   Promotions whose discount would be 0 are left out.
2. **First promotion.** The first-ranked promotion always applies.
   - If it is **not** stackable, it is the only one, exactly as today.
3. **Stacking.** If the first promotion is stackable, every other ranked promotion that is also stackable applies after it, in rank order.
   - Each one's discount is computed again on what is left of the amount after the earlier ones.
   - It is capped so the line never goes below 0.
4. **Receipt.** Each applied promotion is its own entry in `discounts`, in the order applied. The line's `discount` is their sum.

Without priorities or stackable promotions, prices do not change.
