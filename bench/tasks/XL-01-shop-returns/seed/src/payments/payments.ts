import type { Actor } from '../auth/permissions.ts';
import { requireOwnedAccess, requirePermission } from '../auth/permissions.ts';
import type { Clock } from '../core/clock.ts';
import { PaymentError, StateError, ValidationError } from '../core/errors.ts';
import type { EventBus } from '../core/events.ts';
import type { IdGenerator } from '../core/ids.ts';
import type { Cents } from '../core/money.ts';
import { Table } from '../core/store.ts';
import { requireInt, requireObject, requireString } from '../core/validate.ts';
import type { OrderService, Refunder } from '../orders/orders.ts';
import type { FakeGateway } from './gateway.ts';

export interface Refund {
  id: string;
  amountCents: Cents;
  reason: string;
  actor: string;
  at: string;
  gatewayRef: string;
}

export interface Payment {
  id: string;
  orderId: string;
  amountCents: Cents;
  status: 'captured' | 'failed';
  failureReason: string | null;
  gatewayRef: string | null;
  refundedCents: Cents;
  refunds: Refund[];
  createdAt: string;
}

/** Order statuses in which money may be refunded from the order's payment. */
const REFUNDABLE_STATUSES = new Set(['paid', 'shipped', 'delivered']);

export class PaymentService implements Refunder {
  readonly table = new Table<Payment>('payment');
  private ids: IdGenerator;
  private bus: EventBus;
  private clock: Clock;
  private orders: OrderService;
  private gateway: FakeGateway;

  constructor(deps: { ids: IdGenerator; bus: EventBus; clock: Clock; orders: OrderService; gateway: FakeGateway }) {
    this.ids = deps.ids;
    this.bus = deps.bus;
    this.clock = deps.clock;
    this.orders = deps.orders;
    this.gateway = deps.gateway;
  }

  /** Charges the order total. A declined card records a failed payment and throws PaymentError. */
  pay(actor: Actor, orderId: string, input: unknown): Payment {
    const order = this.orders.get(actor, orderId);
    requireOwnedAccess(actor, 'payments:pay', order.ownerUserId, 'order');
    const cardToken = requireString(requireObject(input).cardToken, 'cardToken', { max: 64 });
    if (order.status !== 'placed' || !order.amounts) { throw new StateError(`order is ${order.status}, not placed`); }
    const amount = order.amounts.totalCents;
    const base = { orderId, amountCents: amount, refundedCents: 0, refunds: [], createdAt: this.clock.now().toISOString() };
    try {
      const { ref } = this.gateway.charge(amount, cardToken);
      const payment = this.table.insert({ ...base, id: this.ids.next('payment'), status: 'captured', failureReason: null, gatewayRef: ref });
      this.bus.publish({ type: 'payment.captured', actor: actor.id, entity: 'payment', entityId: payment.id, data: { orderId, amountCents: amount } });
      this.orders.markPaid(actor.id, orderId);
      return payment;
    } catch (err) {
      if (!(err instanceof PaymentError)) { throw err; }
      const failed = this.table.insert({ ...base, id: this.ids.next('payment'), status: 'failed', failureReason: err.message, gatewayRef: null });
      this.bus.publish({ type: 'payment.failed', actor: actor.id, entity: 'payment', entityId: failed.id, data: { orderId, reason: err.message } });
      throw err;
    }
  }

  /** Staff refund part or all of a captured payment, e.g. as a goodwill gesture. */
  refund(actor: Actor, paymentId: string, input: unknown): Payment {
    requirePermission(actor, 'payments:refund');
    const body = requireObject(input);
    const amount = requireInt(body.amountCents, 'amountCents', { min: 1 });
    const reason = requireString(body.reason, 'reason', { max: 500 });
    return this.issueRefund(actor.id, paymentId, amount, reason);
  }

  /** Implements Refunder for order cancellation. */
  refundRemaining(actorId: string, orderId: string, reason: string): number {
    const payment = this.capturedFor(orderId);
    if (!payment) { return 0; }
    const remaining = payment.amountCents - payment.refundedCents;
    if (remaining > 0) { this.issueRefund(actorId, payment.id, remaining, reason); }
    return remaining;
  }

  /**
   * The single place money goes back to a customer: calls the gateway, records the
   * refund on the payment and publishes `payment.refunded`.
   */
  issueRefund(actorId: string, paymentId: string, amount: Cents, reason: string): Payment {
    const payment = this.table.get(paymentId);
    if (payment.status !== 'captured') { throw new StateError('payment was not captured'); }
    const order = this.orders.table.get(payment.orderId);
    if (!REFUNDABLE_STATUSES.has(order.status)) {
      throw new StateError(`cannot refund an order that is ${order.status}`);
    }
    if (amount > payment.amountCents - payment.refundedCents) { throw new ValidationError('refund exceeds what is left on the payment', 'amountCents'); }
    const { ref } = this.gateway.refund(payment.gatewayRef!, amount);
    const refund: Refund = { id: this.ids.next('refund'), amountCents: amount, reason, actor: actorId, at: this.clock.now().toISOString(), gatewayRef: ref };
    const updated = this.table.update(paymentId, p => {
      p.refundedCents += amount;
      p.refunds.push(refund);
    });
    this.bus.publish({
      type: 'payment.refunded', actor: actorId, entity: 'payment', entityId: paymentId,
      data: { orderId: payment.orderId, refundId: refund.id, amountCents: amount, reason },
    });
    return updated;
  }

  /** The captured payment of an order, if any. */
  capturedFor(orderId: string): Payment | undefined {
    return this.table.list(p => p.orderId === orderId && p.status === 'captured')[0];
  }

  forOrder(actor: Actor, orderId: string): Payment[] {
    this.orders.get(actor, orderId);
    return this.table.list(p => p.orderId === orderId);
  }

  /** Every refund issued, across payments, oldest first. Used by reports. */
  allRefunds(): (Refund & { orderId: string; paymentId: string })[] {
    return this.table
      .list()
      .flatMap(p => p.refunds.map(r => ({ ...r, orderId: p.orderId, paymentId: p.id })))
      .sort((a, b) => a.at.localeCompare(b.at));
  }
}
