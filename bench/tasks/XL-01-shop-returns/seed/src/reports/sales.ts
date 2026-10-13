import type { Actor } from '../auth/permissions.ts';
import { requirePermission } from '../auth/permissions.ts';
import { DAY_MS, utcDay } from '../core/clock.ts';
import { ValidationError } from '../core/errors.ts';
import type { Cents } from '../core/money.ts';
import type { Order } from '../orders/model.ts';
import type { OrderService } from '../orders/orders.ts';
import type { PaymentService } from '../payments/payments.ts';

export interface DayRow {
  day: string;
  /** Orders paid that day. */
  orders: number;
  grossCents: Cents;
  discountCents: Cents;
  taxCents: Cents;
  shippingCents: Cents;
  /** Money refunded that day, for any order and any reason. */
  refundsCents: Cents;
  /** gross − discount + tax + shipping − refunds */
  netCents: Cents;
}

export interface SalesReport {
  from: string;
  to: string;
  days: DayRow[];
  totals: Omit<DayRow, 'day'>;
  /** Units sold per sku in orders paid in the range that were not cancelled; most units first, then sku. */
  topProducts: { sku: string; units: number }[];
}

const MAX_DAYS = 92;
const DAY = /^\d{4}-\d\d-\d\d$/;

/**
 * Daily sales. Sales count on the day the order was paid (UTC); refunds count on the
 * day they were issued, so a day's net can be negative.
 */
export class SalesReports {
  private orders: OrderService;
  private payments: PaymentService;

  constructor(deps: { orders: OrderService; payments: PaymentService }) {
    this.orders = deps.orders;
    this.payments = deps.payments;
  }

  sales(actor: Actor, query: { from?: string; to?: string }): SalesReport {
    requirePermission(actor, 'reports:read');
    const { from, to, days } = range(query);
    const rows = new Map<string, DayRow>(days.map(day => [day, emptyRow(day)]));
    const paid = this.orders.table.list(o => o.paidAt !== null && rows.has(utcDay(o.paidAt)));
    for (const o of paid) {
      const row = rows.get(utcDay(o.paidAt!))!;
      const a = o.amounts!;
      row.orders += 1;
      row.grossCents += a.subtotalCents;
      row.discountCents += a.discountCents;
      row.taxCents += a.taxCents;
      row.shippingCents += a.shippingCents;
    }
    for (const r of this.payments.allRefunds()) {
      const row = rows.get(utcDay(r.at));
      if (row) { row.refundsCents += r.amountCents; }
    }
    for (const row of rows.values()) { row.netCents = net(row); }
    const list = [...rows.values()];
    const totals = list.reduce((t, r) => ({
      orders: t.orders + r.orders, grossCents: t.grossCents + r.grossCents, discountCents: t.discountCents + r.discountCents,
      taxCents: t.taxCents + r.taxCents, shippingCents: t.shippingCents + r.shippingCents, refundsCents: t.refundsCents + r.refundsCents, netCents: 0,
    }), { orders: 0, grossCents: 0, discountCents: 0, taxCents: 0, shippingCents: 0, refundsCents: 0, netCents: 0 });
    totals.netCents = net(totals);
    return { from, to, days: list, totals, topProducts: topProducts(paid.filter(o => o.status !== 'cancelled')) };
  }
}

function topProducts(orders: Order[]): { sku: string; units: number }[] {
  const units = new Map<string, number>();
  for (const o of orders) {
    for (const l of o.lines) { units.set(l.sku, (units.get(l.sku) ?? 0) + l.qty); }
  }
  return [...units.entries()]
    .map(([sku, n]) => ({ sku, units: n }))
    .filter(p => p.units > 0)
    .sort((a, b) => b.units - a.units || a.sku.localeCompare(b.sku))
    .slice(0, 10);
}

const net = (r: Omit<DayRow, 'day'>) => r.grossCents - r.discountCents + r.taxCents + r.shippingCents - r.refundsCents;

const emptyRow = (day: string): DayRow => ({ day, orders: 0, grossCents: 0, discountCents: 0, taxCents: 0, shippingCents: 0, refundsCents: 0, netCents: 0 });

function range(query: { from?: string; to?: string }): { from: string; to: string; days: string[] } {
  const { from, to } = query;
  if (!from || !DAY.test(from) || Number.isNaN(Date.parse(from))) { throw new ValidationError('from must be YYYY-MM-DD', 'from'); }
  if (!to || !DAY.test(to) || Number.isNaN(Date.parse(to))) { throw new ValidationError('to must be YYYY-MM-DD', 'to'); }
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (end < start) { throw new ValidationError('to is before from', 'to'); }
  const count = (end - start) / DAY_MS + 1;
  if (count > MAX_DAYS) { throw new ValidationError(`at most ${MAX_DAYS} days`, 'to'); }
  return { from, to, days: Array.from({ length: count }, (_, i) => utcDay(start + i * DAY_MS)) };
}
