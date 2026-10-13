import type { Actor } from '../auth/permissions.ts';
import { requirePermission } from '../auth/permissions.ts';
import type { Clock } from '../core/clock.ts';
import { StateError } from '../core/errors.ts';
import type { EventBus } from '../core/events.ts';
import type { IdGenerator } from '../core/ids.ts';
import { Table } from '../core/store.ts';
import { requireObject, requireOneOf, requireString } from '../core/validate.ts';
import type { Allocation, StockService } from '../inventory/stock.ts';
import type { OrderService } from '../orders/orders.ts';

export const CARRIERS = ['ups', 'fedex', 'dhl', 'post'] as const;
export type Carrier = (typeof CARRIERS)[number];

export interface Shipment {
  id: string;
  orderId: string;
  carrier: Carrier;
  trackingNumber: string;
  /** What left which warehouse. */
  allocations: Allocation[];
  status: 'in_transit' | 'delivered';
  shippedAt: string;
  deliveredAt: string | null;
}

/** One shipment per order: the whole order ships at once from its reserved warehouses. */
export class ShipmentService {
  readonly table = new Table<Shipment>('shipment');
  private ids: IdGenerator;
  private bus: EventBus;
  private clock: Clock;
  private orders: OrderService;
  private stock: StockService;

  constructor(deps: { ids: IdGenerator; bus: EventBus; clock: Clock; orders: OrderService; stock: StockService }) {
    this.ids = deps.ids;
    this.bus = deps.bus;
    this.clock = deps.clock;
    this.orders = deps.orders;
    this.stock = deps.stock;
  }

  ship(actor: Actor, orderId: string, input: unknown): Shipment {
    requirePermission(actor, 'shipments:manage');
    const body = requireObject(input);
    const carrier = requireOneOf(body.carrier, 'carrier', CARRIERS);
    const trackingNumber = requireString(body.trackingNumber, 'trackingNumber', { max: 64 });
    const order = this.orders.table.get(orderId);
    if (order.status !== 'paid') { throw new StateError(`order is ${order.status}, not paid`); }
    const allocations = this.stock.ship(actor.id, orderId);
    const shipment = this.table.insert({
      id: this.ids.next('shipment'), orderId, carrier, trackingNumber, allocations,
      status: 'in_transit', shippedAt: this.clock.now().toISOString(), deliveredAt: null,
    });
    this.bus.publish({ type: 'shipment.created', actor: actor.id, entity: 'shipment', entityId: shipment.id, data: { orderId, carrier, trackingNumber } });
    this.orders.markShipped(actor.id, orderId, shipment.id);
    return shipment;
  }

  /** The carrier reports delivery (staff record it). */
  markDelivered(actor: Actor, shipmentId: string): Shipment {
    requirePermission(actor, 'shipments:manage');
    const shipment = this.table.get(shipmentId);
    if (shipment.status !== 'in_transit') { throw new StateError('shipment already delivered'); }
    const updated = this.table.update(shipmentId, s => {
      s.status = 'delivered';
      s.deliveredAt = this.clock.now().toISOString();
    });
    this.bus.publish({ type: 'shipment.delivered', actor: actor.id, entity: 'shipment', entityId: shipmentId, data: { orderId: shipment.orderId } });
    this.orders.markDelivered(actor.id, shipment.orderId);
    return updated;
  }

  forOrder(orderId: string): Shipment | undefined {
    return this.table.list(s => s.orderId === orderId)[0];
  }
}
