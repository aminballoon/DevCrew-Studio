import type { TaxCategory } from '../catalog/tax.ts';
import { taxFor } from '../catalog/tax.ts';
import type { Cents } from '../core/money.ts';
import { allocate, percentOf, sum } from '../core/money.ts';
import type { Coupon } from './coupons.ts';

export const SHIPPING_FEE_CENTS: Cents = 500;
/** Orders whose goods total (after discount, before tax) reaches this ship free. */
export const FREE_SHIPPING_FROM_CENTS: Cents = 5000;

export interface PricedLineInput {
  unitPriceCents: Cents;
  qty: number;
  taxCategory: TaxCategory;
}

export interface LineAmounts {
  /** unitPrice × qty */
  grossCents: Cents;
  /** This line's share of the order discount. */
  discountCents: Cents;
  /** gross − discount */
  netCents: Cents;
  /** Tax on net, rounded once for the line. */
  taxCents: Cents;
  /** net + tax: what the customer paid for this line. */
  totalCents: Cents;
}

export interface OrderAmounts {
  subtotalCents: Cents;
  discountCents: Cents;
  taxCents: Cents;
  shippingCents: Cents;
  totalCents: Cents;
}

/** Coupon discount on a subtotal; never more than the subtotal. */
export function discountFor(coupon: Coupon | null, subtotal: Cents): Cents {
  if (!coupon) { return 0; }
  const d = coupon.kind === 'percent' ? percentOf(subtotal, coupon.value) : coupon.value;
  return Math.min(d, subtotal);
}

export function shippingFor(goodsNet: Cents, lineCount: number): Cents {
  if (lineCount === 0) { return 0; }
  return goodsNet >= FREE_SHIPPING_FROM_CENTS ? 0 : SHIPPING_FEE_CENTS;
}

/**
 * Prices an order. The discount is spread over lines by their gross amounts
 * (money.allocate), then tax is computed per line on the net. Shipping is not taxed.
 */
export function priceOrder(lines: PricedLineInput[], coupon: Coupon | null): { lines: LineAmounts[]; totals: OrderAmounts } {
  const gross = lines.map(l => l.unitPriceCents * l.qty);
  const subtotal = sum(gross);
  const discount = discountFor(coupon, subtotal);
  const shares = allocate(discount, gross);
  const priced = lines.map((l, i): LineAmounts => {
    const net = gross[i] - shares[i];
    const tax = taxFor(net, l.taxCategory);
    return { grossCents: gross[i], discountCents: shares[i], netCents: net, taxCents: tax, totalCents: net + tax };
  });
  const goodsNet = subtotal - discount;
  const tax = sum(priced.map(p => p.taxCents));
  const shipping = shippingFor(goodsNet, lines.length);
  return {
    lines: priced,
    totals: { subtotalCents: subtotal, discountCents: discount, taxCents: tax, shippingCents: shipping, totalCents: goodsNet + tax + shipping },
  };
}
