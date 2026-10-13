This project is the existing Tilly pricing engine (`src/`, exported from `src/index.ts`). Everything it does today must keep working, except where this change request says otherwise. Follow the conventions the code already uses, and keep its tests passing (update them where this change makes them wrong).

## Change request: currencies and cash payments

1. **Store currency.** The config takes an optional `currency`: `THB` (the default), `USD`, `JPY` or `KWD`. Any other value is `INVALID_CONFIG`. All prices and amounts are in that currency's minor units: 2 digits for THB and USD, none for JPY, and 3 for KWD. The receipt's `currency` is the store currency.
2. **Formatting.** `formatMoney(amount, currency)` supports all four currencies:
   - THB: `฿1,234.50`
   - USD: `$1,234.50`
   - JPY: `¥1,235`
   - KWD: `KWD 1.250`
   A negative amount starts with `-`, e.g. `-฿0.25`. An unknown currency throws `INVALID_CONFIG`.
3. **Payment method.** An order may say `payment: "card"` (the default) or `"cash"`. Anything else is `INVALID_ORDER`. The receipt gains `payment`, `payable` and `rounding`:
   - **card:** `payable` is `total` and `rounding` is `0`.
   - **cash:** `payable` is `total` rounded half up to the smallest coin: 25 minor units for THB, 5 for KWD, and 1 for USD and JPY. `rounding` is `payable − total`.
