import type { Actor } from '../auth/permissions.ts';
import { requirePermission } from '../auth/permissions.ts';
import type { DomainEvent, EventBus } from '../core/events.ts';
import type { IdGenerator } from '../core/ids.ts';
import { formatCents } from '../core/money.ts';
import { Table } from '../core/store.ts';
import type { CustomerService } from '../customers/customers.ts';
import type { OrderService } from '../orders/orders.ts';

export interface Notification {
  id: string;
  to: string;
  template: string;
  subject: string;
  /** Values the email template fills in. */
  data: Record<string, unknown>;
  at: string;
  orderId: string | null;
}

/**
 * Emails to customers, queued in an outbox that a mailer drains. Each rule turns one
 * event type into one email; add a rule to send a new kind of email.
 */
interface Rule {
  event: string;
  template: string;
  subject: (data: Record<string, unknown>) => string;
  /** The order the email is about. */
  orderId: (event: DomainEvent) => string;
}

const RULES: Rule[] = [
  { event: 'order.placed', template: 'order_confirmation', subject: d => `Order ${d.orderNumber} confirmed`, orderId: e => e.entityId },
  { event: 'order.shipped', template: 'order_shipped', subject: d => `Order ${d.orderNumber} is on its way`, orderId: e => e.entityId },
  { event: 'order.cancelled', template: 'order_cancelled', subject: d => `Order ${d.orderNumber} cancelled`, orderId: e => e.entityId },
  { event: 'payment.refunded', template: 'refund_issued', subject: d => `Refund of ${formatCents(Number(d.amountCents))} for order ${d.orderNumber}`, orderId: e => String(e.data.orderId) },
];

export class Outbox {
  readonly table = new Table<Notification>('notification');
  private ids: IdGenerator;
  private orders: OrderService;
  private customers: CustomerService;

  constructor(deps: { ids: IdGenerator; bus: EventBus; orders: OrderService; customers: CustomerService }) {
    this.ids = deps.ids;
    this.orders = deps.orders;
    this.customers = deps.customers;
    for (const rule of RULES) {
      deps.bus.subscribe(rule.event, e => this.enqueue(rule, e));
    }
  }

  private enqueue(rule: Rule, event: DomainEvent): void {
    const order = this.orders.table.get(rule.orderId(event));
    const customer = this.customers.table.get(order.customerId);
    const data = { ...event.data, orderNumber: order.number, customerName: customer.name };
    this.table.insert({
      id: this.ids.next('notification'), to: customer.email, template: rule.template,
      subject: rule.subject(data), data, at: event.at, orderId: order.id,
    });
  }

  /** Oldest first. Staff only (admins read the outbox when customers say an email never came). */
  list(actor: Actor, filter: { to?: string; template?: string; orderId?: string } = {}): Notification[] {
    requirePermission(actor, 'audit:read');
    return this.table
      .list(n => (!filter.to || n.to === filter.to) && (!filter.template || n.template === filter.template) && (!filter.orderId || n.orderId === filter.orderId))
      .sort((a, b) => a.at.localeCompare(b.at) || Number(a.id.slice(4)) - Number(b.id.slice(4)));
  }
}
