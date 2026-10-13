import type { Actor } from '../auth/permissions.ts';
import { requirePermission } from '../auth/permissions.ts';
import type { Clock } from '../core/clock.ts';
import { ConflictError, NotFoundError, StateError, ValidationError } from '../core/errors.ts';
import type { EventBus } from '../core/events.ts';
import type { IdGenerator } from '../core/ids.ts';
import type { Cents } from '../core/money.ts';
import { Table } from '../core/store.ts';
import { requireCentsInput, requireInt, requireIsoTime, requireObject, requireOneOf, requireString } from '../core/validate.ts';

export interface Coupon {
  id: string;
  code: string;
  kind: 'percent' | 'fixed';
  /** Basis points for percent coupons (1500 = 15%), cents for fixed ones. */
  value: number;
  minSubtotalCents: Cents;
  maxUses: number | null;
  /** Order ids currently holding a use of this coupon. */
  redeemedBy: string[];
  expiresAt: string | null;
  active: boolean;
}

export class CouponService {
  readonly table = new Table<Coupon>('coupon');
  private ids: IdGenerator;
  private bus: EventBus;
  private clock: Clock;

  constructor(deps: { ids: IdGenerator; bus: EventBus; clock: Clock }) {
    this.ids = deps.ids;
    this.bus = deps.bus;
    this.clock = deps.clock;
  }

  create(actor: Actor, input: unknown): Coupon {
    requirePermission(actor, 'coupons:manage');
    const body = requireObject(input);
    const code = requireString(body.code, 'code', { max: 32 }).toUpperCase();
    if (this.byCode(code)) { throw new ConflictError(`coupon ${code} already exists`); }
    const kind = requireOneOf(body.kind, 'kind', ['percent', 'fixed'] as const);
    const value = kind === 'percent' ? requireInt(body.value, 'value', { min: 1, max: 10_000 }) : requireInt(body.value, 'value', { min: 1 });
    const coupon = this.table.insert({
      id: this.ids.next('coupon'),
      code,
      kind,
      value,
      minSubtotalCents: body.minSubtotalCents === undefined ? 0 : requireCentsInput(body.minSubtotalCents, 'minSubtotalCents'),
      maxUses: body.maxUses === undefined || body.maxUses === null ? null : requireInt(body.maxUses, 'maxUses', { min: 1 }),
      redeemedBy: [],
      expiresAt: body.expiresAt === undefined || body.expiresAt === null ? null : requireIsoTime(body.expiresAt, 'expiresAt'),
      active: true,
    });
    this.bus.publish({ type: 'coupon.created', actor: actor.id, entity: 'coupon', entityId: coupon.id, data: { code, kind, value } });
    return coupon;
  }

  byCode(code: string): Coupon | undefined {
    return this.table.list(c => c.code === code.toUpperCase())[0];
  }

  /** Checks a code can be used on an order with this subtotal right now. */
  check(code: string, subtotal: Cents): Coupon {
    const coupon = this.byCode(code);
    if (!coupon || !coupon.active) { throw new NotFoundError('coupon'); }
    if (coupon.expiresAt && Date.parse(coupon.expiresAt) <= this.clock.now().getTime()) { throw new ValidationError('coupon has expired', 'couponCode'); }
    if (subtotal < coupon.minSubtotalCents) { throw new ValidationError('order is below the coupon minimum', 'couponCode'); }
    if (coupon.maxUses !== null && coupon.redeemedBy.length >= coupon.maxUses) { throw new ConflictError('coupon has been used up'); }
    return coupon;
  }

  /** Takes one use for an order (when the order is placed). */
  redeem(actorId: string, code: string, orderId: string, subtotal: Cents): Coupon {
    const coupon = this.check(code, subtotal);
    if (coupon.redeemedBy.includes(orderId)) { throw new StateError('coupon already redeemed by this order'); }
    const updated = this.table.update(coupon.id, c => { c.redeemedBy.push(orderId); });
    this.bus.publish({ type: 'coupon.redeemed', actor: actorId, entity: 'coupon', entityId: coupon.id, data: { orderId } });
    return updated;
  }

  /** Gives the use back (order cancelled). No-op when the order holds no use. */
  release(actorId: string, code: string, orderId: string): void {
    const coupon = this.byCode(code);
    if (!coupon || !coupon.redeemedBy.includes(orderId)) { return; }
    this.table.update(coupon.id, c => { c.redeemedBy = c.redeemedBy.filter(id => id !== orderId); });
    this.bus.publish({ type: 'coupon.released', actor: actorId, entity: 'coupon', entityId: coupon.id, data: { orderId } });
  }

  get(actor: Actor, couponId: string): Coupon {
    requirePermission(actor, 'coupons:manage');
    return this.table.get(couponId);
  }
}
