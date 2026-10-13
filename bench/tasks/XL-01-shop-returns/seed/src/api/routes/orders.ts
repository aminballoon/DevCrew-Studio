import type { Services } from '../../app.ts';
import { NotFoundError } from '../../core/errors.ts';
import { paginate } from '../../core/pagination.ts';
import { created, ok } from '../http.ts';
import type { Router } from '../router.ts';
import { orderDto, paymentDto, shipmentDto } from '../serialize.ts';

export function orderRoutes(r: Router, s: Services): void {
  r.add('POST', '/orders', ({ actor, body }) => created(orderDto(s.orders.createDraft(actor, body ?? {}))));
  /** Newest first, paginated. Staff may filter by `status` and `customerId`. */
  r.add('GET', '/orders', ({ actor, query }) => {
    const page = paginate(s.orders.list(actor, { status: query.status, customerId: query.customerId }), query);
    return ok({ items: page.items.map(orderDto), nextCursor: page.nextCursor });
  });
  r.add('GET', '/orders/:id', ({ actor, params }) => ok(orderDto(s.orders.get(actor, params.id))));
  r.add('POST', '/orders/:id/lines', ({ actor, params, body }) => created(orderDto(s.orders.addLine(actor, params.id, body))));
  r.add('PATCH', '/orders/:id/lines/:lineId', ({ actor, params, body }) => ok(orderDto(s.orders.setLineQty(actor, params.id, params.lineId, body))));
  r.add('PUT', '/orders/:id/shipping-address', ({ actor, params, body }) => ok(orderDto(s.orders.setShippingAddress(actor, params.id, body))));
  r.add('PUT', '/orders/:id/coupon', ({ actor, params, body }) => ok(orderDto(s.orders.applyCoupon(actor, params.id, body))));
  r.add('POST', '/orders/:id/place', ({ actor, params }) => ok(orderDto(s.orders.place(actor, params.id))));
  r.add('POST', '/orders/:id/cancel', ({ actor, params, body }) => ok(orderDto(s.orders.cancel(actor, params.id, body ?? {}))));

  r.add('POST', '/orders/:id/payments', ({ actor, params, body }) => created(paymentDto(s.payments.pay(actor, params.id, body))));
  r.add('GET', '/orders/:id/payments', ({ actor, params }) => ok(s.payments.forOrder(actor, params.id).map(paymentDto)));
  r.add('POST', '/payments/:id/refunds', ({ actor, params, body }) => created(paymentDto(s.payments.refund(actor, params.id, body))));

  r.add('POST', '/orders/:id/shipments', ({ actor, params, body }) => created(shipmentDto(s.shipments.ship(actor, params.id, body))));
  r.add('GET', '/orders/:id/shipment', ({ actor, params }) => {
    s.orders.get(actor, params.id);
    const shipment = s.shipments.forOrder(params.id);
    if (!shipment) { throw new NotFoundError('shipment'); }
    return ok(shipmentDto(shipment));
  });
  r.add('POST', '/shipments/:id/deliver', ({ actor, params }) => ok(shipmentDto(s.shipments.markDelivered(actor, params.id))));
}
