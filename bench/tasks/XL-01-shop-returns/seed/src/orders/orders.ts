import type { Actor } from '../auth/permissions.ts';
import { can, requireOwnedAccess, requirePermission } from '../auth/permissions.ts';
import type { ProductService } from '../catalog/products.ts';
import type { Clock } from '../core/clock.ts';
import { ForbiddenError, NotFoundError, StateError, ValidationError } from '../core/errors.ts';
import type { EventBus } from '../core/events.ts';
import type { IdGenerator } from '../core/ids.ts';
import { Table } from '../core/store.ts';
import { optionalString, requireInt, requireObject, requireString } from '../core/validate.ts';
import type { CustomerService } from '../customers/customers.ts';
import type { StockService } from '../inventory/stock.ts';
import type { CouponService } from '../pricing/coupons.ts';
import { priceOrder } from '../pricing/pricing.ts';
import type { Order, OrderLine } from './model.ts';
import { MAX_LINES, MAX_QTY_PER_LINE } from './model.ts';
import { assertTransition } from './state.ts';
import type { OrderStatus } from './state.ts';

/** Implemented by PaymentService; wired in app.ts (the two services need each other). */
export interface Refunder {
  /** Refunds whatever is still refundable on the order's captured payment. Returns the amount refunded. */
  refundRemaining(actorId: string, orderId: string, reason: string): number;
}

const FIRST_ORDER_NUMBER = 1001;

export class OrderService {
  readonly table = new Table<Order>('order');
  private ids: IdGenerator;
  private bus: EventBus;
  private clock: Clock;
  private products: ProductService;
  private customers: CustomerService;
  private stock: StockService;
  private coupons: CouponService;
  private refunder: Refunder | null = null;

  constructor(deps: {
    ids: IdGenerator; bus: EventBus; clock: Clock;
    products: ProductService; customers: CustomerService; stock: StockService; coupons: CouponService;
  }) {
    this.ids = deps.ids;
    this.bus = deps.bus;
    this.clock = deps.clock;
    this.products = deps.products;
    this.customers = deps.customers;
    this.stock = deps.stock;
    this.coupons = deps.coupons;
  }

  attachRefunder(refunder: Refunder): void { this.refunder = refunder; }

  // ---- reading -------------------------------------------------------------------------

  get(actor: Actor, orderId: string): Order {
    const order = this.table.get(orderId);
    requireOwnedAccess(actor, 'orders:read', order.ownerUserId, 'order');
    return order;
  }

  /** Customers see their own orders; staff see all, optionally filtered. Newest first. */
  list(actor: Actor, query: { status?: string; customerId?: string } = {}): Order[] {
    const any = can(actor, 'orders:read:any');
    if (!any) { requirePermission(actor, 'orders:read:own'); }
    return this.table
      .list(o => (any || o.ownerUserId === actor.id)
        && (!query.status || o.status === query.status)
        && (!query.customerId || o.customerId === query.customerId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id, 'en', { numeric: true }));
  }

  // ---- drafting ------------------------------------------------------------------------

  /** Customers create orders for themselves; staff must say which customer. */
  createDraft(actor: Actor, input: unknown = {}): Order {
    const body = requireObject(input ?? {});
    let customerId: string;
    if (can(actor, 'orders:create:any')) {
      customerId = requireString(body.customerId, 'customerId');
    } else {
      requirePermission(actor, 'orders:create:own');
      customerId = this.customers.forUser(actor.id).id;
    }
    const customer = this.customers.table.find(customerId);
    if (!customer) { throw new NotFoundError('customer'); }
    const now = this.clock.now().toISOString();
    const order = this.table.insert({
      id: this.ids.next('order'),
      number: `SO-${FIRST_ORDER_NUMBER + this.table.size}`,
      customerId,
      ownerUserId: customer.userId,
      status: 'draft',
      lines: [],
      couponCode: null,
      shippingAddress: null,
      amounts: null,
      history: [{ status: 'draft', at: now, actor: actor.id }],
      createdBy: actor.id,
      createdAt: now,
      placedAt: null, paidAt: null, shippedAt: null, deliveredAt: null, cancelledAt: null, cancelReason: null,
    });
    this.bus.publish({ type: 'order.created', actor: actor.id, entity: 'order', entityId: order.id, data: { customerId } });
    return order;
  }

  /** Adds a product, or raises the quantity if the order already has a line for it. */
  addLine(actor: Actor, orderId: string, input: unknown): Order {
    const order = this.draft(actor, orderId);
    const body = requireObject(input);
    const productId = requireString(body.productId, 'productId');
    const qty = requireInt(body.qty, 'qty', { min: 1, max: MAX_QTY_PER_LINE });
    const product = this.products.table.find(productId);
    if (!product || !product.active) { throw new NotFoundError('product'); }
    const existing = order.lines.find(l => l.productId === productId);
    if (existing && existing.qty + qty > MAX_QTY_PER_LINE) { throw new ValidationError(`at most ${MAX_QTY_PER_LINE} of one product`, 'qty'); }
    if (!existing && order.lines.length >= MAX_LINES) { throw new ValidationError(`at most ${MAX_LINES} lines`, 'lines'); }
    const updated = this.table.update(orderId, o => {
      const line = o.lines.find(l => l.productId === productId);
      if (line) {
        line.qty += qty;
        line.unitPriceCents = product.priceCents;
      } else {
        o.lines.push({
          id: this.ids.next('line'), productId, sku: product.sku, name: product.name,
          unitPriceCents: product.priceCents, qty, taxCategory: product.taxCategory, amounts: null, fulfilment: [],
        });
      }
    });
    this.bus.publish({ type: 'order.line_added', actor: actor.id, entity: 'order', entityId: orderId, data: { productId, qty } });
    return updated;
  }

  setLineQty(actor: Actor, orderId: string, lineId: string, input: unknown): Order {
    const order = this.draft(actor, orderId);
    const qty = requireInt(requireObject(input).qty, 'qty', { min: 0, max: MAX_QTY_PER_LINE });
    if (!order.lines.some(l => l.id === lineId)) { throw new NotFoundError('line'); }
    const updated = this.table.update(orderId, o => {
      o.lines = qty === 0 ? o.lines.filter(l => l.id !== lineId) : o.lines.map(l => (l.id === lineId ? { ...l, qty } : l));
    });
    this.bus.publish({ type: 'order.line_changed', actor: actor.id, entity: 'order', entityId: orderId, data: { lineId, qty } });
    return updated;
  }

  setShippingAddress(actor: Actor, orderId: string, input: unknown): Order {
    const order = this.draft(actor, orderId);
    const addressId = requireString(requireObject(input).addressId, 'addressId');
    const address = this.customers.address(order.customerId, addressId);
    return this.table.update(orderId, o => { o.shippingAddress = address; });
  }

  /** Sets or clears (`code: null`) the coupon. Checked again when the order is placed. */
  applyCoupon(actor: Actor, orderId: string, input: unknown): Order {
    const order = this.draft(actor, orderId);
    const body = requireObject(input);
    if (body.code === null) { return this.table.update(orderId, o => { o.couponCode = null; }); }
    const code = requireString(body.code, 'code', { max: 32 }).toUpperCase();
    const subtotal = order.lines.reduce((n, l) => n + l.unitPriceCents * l.qty, 0);
    this.coupons.check(code, subtotal);
    return this.table.update(orderId, o => { o.couponCode = code; });
  }

  // ---- lifecycle -----------------------------------------------------------------------

  /**
   * Freezes prices from the catalog, applies the coupon, reserves stock and moves the
   * order to `placed`. Nothing changes if any step fails.
   */
  place(actor: Actor, orderId: string): Order {
    const order = this.draft(actor, orderId);
    if (order.lines.length === 0) { throw new ValidationError('order has no lines', 'lines'); }
    if (!order.shippingAddress) { throw new ValidationError('order has no shipping address', 'shippingAddress'); }
    const lines: OrderLine[] = order.lines.map(l => {
      const product = this.products.table.find(l.productId);
      if (!product || !product.active) { throw new ValidationError(`${l.sku} is no longer sold`, 'lines'); }
      return { ...l, unitPriceCents: product.priceCents, taxCategory: product.taxCategory, name: product.name };
    });
    const subtotal = lines.reduce((n, l) => n + l.unitPriceCents * l.qty, 0);
    const coupon = order.couponCode ? this.coupons.check(order.couponCode, subtotal) : null;
    const priced = priceOrder(lines, coupon);
    const allocations = this.stock.reserve(actor.id, orderId, lines.map(l => ({ lineId: l.id, sku: l.sku, qty: l.qty })));
    if (coupon) {
      try {
        this.coupons.redeem(actor.id, coupon.code, orderId, subtotal);
      } catch (err) {
        this.stock.release(actor.id, orderId);
        throw err;
      }
    }
    const now = this.clock.now().toISOString();
    const placed = this.table.update(orderId, o => {
      o.lines = lines.map((l, i) => ({
        ...l,
        amounts: priced.lines[i],
        fulfilment: allocations.filter(a => a.lineId === l.id).map(a => ({ warehouseId: a.warehouseId, qty: a.qty })),
      }));
      o.amounts = priced.totals;
      o.status = 'placed';
      o.placedAt = now;
      o.history.push({ status: 'placed', at: now, actor: actor.id });
    });
    this.bus.publish({
      type: 'order.placed', actor: actor.id, entity: 'order', entityId: orderId,
      data: { number: placed.number, totalCents: priced.totals.totalCents, couponCode: placed.couponCode },
    });
    return placed;
  }

  /**
   * Cancels an order that has not shipped. Releases its stock and coupon use, and refunds
   * the payment in full if it was paid. Customers may cancel their own orders.
   */
  cancel(actor: Actor, orderId: string, input: unknown = {}): Order {
    const order = this.table.get(orderId);
    requireOwnedAccess(actor, 'orders:read', order.ownerUserId, 'order');
    requireOwnedAccess(actor, 'orders:cancel', order.ownerUserId, 'order');
    const reason = optionalString(requireObject(input ?? {}).reason, 'reason', { max: 500 }) || 'cancelled';
    assertTransition(order.status, 'cancelled');
    if (order.status !== 'draft') {
      this.stock.release(actor.id, orderId);
      if (order.couponCode) { this.coupons.release(actor.id, order.couponCode, orderId); }
    }
    if (order.status === 'paid') {
      if (!this.refunder) { throw new StateError('payments are not available'); }
      this.refunder.refundRemaining(actor.id, orderId, `order cancelled: ${reason}`);
    }
    const cancelled = this.transition(actor.id, orderId, 'cancelled', o => {
      o.cancelledAt = this.clock.now().toISOString();
      o.cancelReason = reason;
    });
    this.bus.publish({ type: 'order.cancelled', actor: actor.id, entity: 'order', entityId: orderId, data: { reason, from: order.status } });
    return cancelled;
  }

  /** Called by PaymentService once the charge succeeded. */
  markPaid(actorId: string, orderId: string): Order {
    const order = this.transition(actorId, orderId, 'paid', o => { o.paidAt = this.clock.now().toISOString(); });
    this.bus.publish({ type: 'order.paid', actor: actorId, entity: 'order', entityId: orderId, data: { totalCents: order.amounts?.totalCents ?? 0 } });
    return order;
  }

  /** Called by ShipmentService. */
  markShipped(actorId: string, orderId: string, shipmentId: string): Order {
    const order = this.transition(actorId, orderId, 'shipped', o => { o.shippedAt = this.clock.now().toISOString(); });
    this.bus.publish({ type: 'order.shipped', actor: actorId, entity: 'order', entityId: orderId, data: { shipmentId } });
    return order;
  }

  /** Called by ShipmentService. */
  markDelivered(actorId: string, orderId: string): Order {
    const order = this.transition(actorId, orderId, 'delivered', o => { o.deliveredAt = this.clock.now().toISOString(); });
    this.bus.publish({ type: 'order.delivered', actor: actorId, entity: 'order', entityId: orderId, data: {} });
    return order;
  }

  private transition(actorId: string, orderId: string, to: OrderStatus, extra?: (o: Order) => void): Order {
    const order = this.table.get(orderId);
    assertTransition(order.status, to);
    return this.table.update(orderId, o => {
      o.status = to;
      o.history.push({ status: to, at: this.clock.now().toISOString(), actor: actorId });
      extra?.(o);
    });
  }

  /** The order, if the actor may edit it and it is still a draft. */
  private draft(actor: Actor, orderId: string): Order {
    const order = this.table.get(orderId);
    requireOwnedAccess(actor, 'orders:read', order.ownerUserId, 'order');
    if (!can(actor, 'orders:create:any') && !(can(actor, 'orders:create:own') && order.ownerUserId === actor.id)) {
      throw new ForbiddenError('missing permission orders:create');
    }
    if (order.status !== 'draft') { throw new StateError('only draft orders can be changed'); }
    return order;
  }
}
