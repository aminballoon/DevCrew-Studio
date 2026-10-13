/**
 * Deterministic, prefixed ids: `ord_1`, `pay_3`, ...
 * One generator per app so tests get stable ids. Every entity kind has its own prefix
 * and its own counter.
 */
export const PREFIX = {
  user: 'usr',
  token: 'tok',
  product: 'prd',
  customer: 'cus',
  address: 'adr',
  warehouse: 'wh',
  movement: 'mov',
  coupon: 'cpn',
  order: 'ord',
  line: 'lin',
  payment: 'pay',
  refund: 'ref',
  shipment: 'shp',
  audit: 'aud',
  notification: 'ntf',
} as const;

export type EntityKind = keyof typeof PREFIX;

export class IdGenerator {
  private counters = new Map<string, number>();

  next(kind: EntityKind): string {
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    return `${PREFIX[kind]}_${n}`;
  }
}
