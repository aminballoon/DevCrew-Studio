import type { AuditEntry } from '../audit/audit.ts';
import type { User } from '../auth/users.ts';
import type { Product } from '../catalog/products.ts';
import type { Customer } from '../customers/customers.ts';
import type { StockLevel, StockMovement } from '../inventory/stock.ts';
import type { Warehouse } from '../inventory/warehouses.ts';
import type { Notification } from '../notifications/outbox.ts';
import type { Order } from '../orders/model.ts';
import type { Payment } from '../payments/payments.ts';
import type { Coupon } from '../pricing/coupons.ts';
import type { Shipment } from '../shipping/shipments.ts';

/**
 * What the API returns for each entity. Internal fields (owner ids, gateway references,
 * who redeemed a coupon) never leave through here; add new fields deliberately.
 */

export const userDto = (u: User) => ({ id: u.id, email: u.email, name: u.name, role: u.role, active: u.active });

export const productDto = (p: Product) => ({
  id: p.id, sku: p.sku, name: p.name, description: p.description, priceCents: p.priceCents, taxCategory: p.taxCategory, active: p.active,
});

export const customerDto = (c: Customer) => ({ id: c.id, name: c.name, email: c.email, addresses: c.addresses, defaultAddressId: c.defaultAddressId });

export const warehouseDto = (w: Warehouse) => ({ id: w.id, code: w.code, name: w.name, priority: w.priority, active: w.active });

export const stockLevelDto = (l: StockLevel & { available: number }) => ({
  sku: l.sku, warehouseId: l.warehouseId, onHand: l.onHand, reserved: l.reserved, available: l.available,
});

export const movementDto = (m: StockMovement) => ({
  id: m.id, sku: m.sku, warehouseId: m.warehouseId, kind: m.kind, onHandDelta: m.onHandDelta, reservedDelta: m.reservedDelta, ref: m.ref, note: m.note, at: m.at,
});

export const couponDto = (c: Coupon) => ({
  id: c.id, code: c.code, kind: c.kind, value: c.value, minSubtotalCents: c.minSubtotalCents, maxUses: c.maxUses,
  uses: c.redeemedBy.length, expiresAt: c.expiresAt, active: c.active,
});

export const orderDto = (o: Order) => ({
  id: o.id,
  number: o.number,
  customerId: o.customerId,
  status: o.status,
  lines: o.lines.map(l => ({
    id: l.id, productId: l.productId, sku: l.sku, name: l.name, unitPriceCents: l.unitPriceCents, qty: l.qty,
    taxCategory: l.taxCategory, amounts: l.amounts, fulfilment: l.fulfilment,
  })),
  couponCode: o.couponCode,
  shippingAddress: o.shippingAddress,
  amounts: o.amounts,
  history: o.history,
  createdAt: o.createdAt,
  placedAt: o.placedAt,
  paidAt: o.paidAt,
  shippedAt: o.shippedAt,
  deliveredAt: o.deliveredAt,
  cancelledAt: o.cancelledAt,
  cancelReason: o.cancelReason,
});

export const paymentDto = (p: Payment) => ({
  id: p.id, orderId: p.orderId, amountCents: p.amountCents, status: p.status, failureReason: p.failureReason,
  refundedCents: p.refundedCents, refunds: p.refunds.map(r => ({ id: r.id, amountCents: r.amountCents, reason: r.reason, at: r.at })),
  createdAt: p.createdAt,
});

export const shipmentDto = (s: Shipment) => ({
  id: s.id, orderId: s.orderId, carrier: s.carrier, trackingNumber: s.trackingNumber, status: s.status,
  shippedAt: s.shippedAt, deliveredAt: s.deliveredAt,
  allocations: s.allocations.map(a => ({ lineId: a.lineId, sku: a.sku, warehouseId: a.warehouseId, qty: a.qty })),
});

export const auditDto = (e: AuditEntry) => ({ id: e.id, at: e.at, actor: e.actor, action: e.action, entity: e.entity, entityId: e.entityId, data: e.data });

export const notificationDto = (n: Notification) => ({ id: n.id, to: n.to, template: n.template, subject: n.subject, data: n.data, at: n.at, orderId: n.orderId });
