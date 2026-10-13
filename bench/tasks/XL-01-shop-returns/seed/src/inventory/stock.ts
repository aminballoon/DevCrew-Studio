import type { Actor } from '../auth/permissions.ts';
import { requirePermission } from '../auth/permissions.ts';
import type { Clock } from '../core/clock.ts';
import { ConflictError, NotFoundError, StateError, ValidationError } from '../core/errors.ts';
import type { EventBus } from '../core/events.ts';
import type { IdGenerator } from '../core/ids.ts';
import { Table } from '../core/store.ts';
import { optionalString, requireInt, requireObject, requireOneOf, requireSku, requireString } from '../core/validate.ts';
import type { WarehouseService } from './warehouses.ts';

export interface StockLevel {
  id: string; // `${sku}@${warehouseId}`
  sku: string;
  warehouseId: string;
  onHand: number;
  reserved: number;
}

/**
 * Every change to a stock level is recorded as a movement, so the history explains the
 * current numbers: onHand = sum(onHandDelta), reserved = sum(reservedDelta).
 */
export type MovementKind = 'receive' | 'adjust' | 'reserve' | 'release' | 'ship';
export const ADJUST_REASONS = ['count', 'damage', 'loss', 'found'] as const;

export interface StockMovement {
  id: string;
  sku: string;
  warehouseId: string;
  kind: MovementKind;
  onHandDelta: number;
  reservedDelta: number;
  /** What caused it: an order id for reserve / release / ship, free text otherwise. */
  ref: string;
  note: string;
  actor: string;
  at: string;
}

/** Which warehouse holds (or shipped) how many units of an order line. */
export interface Allocation {
  lineId: string;
  sku: string;
  warehouseId: string;
  qty: number;
}

interface Reservation {
  id: string; // order id
  allocations: Allocation[];
  state: 'held' | 'released' | 'shipped';
}

export class StockService {
  readonly levels = new Table<StockLevel>('stock level');
  readonly movements = new Table<StockMovement>('stock movement');
  readonly reservations = new Table<Reservation>('reservation');
  private ids: IdGenerator;
  private bus: EventBus;
  private clock: Clock;
  private warehouses: WarehouseService;

  constructor(deps: { ids: IdGenerator; bus: EventBus; clock: Clock; warehouses: WarehouseService }) {
    this.ids = deps.ids;
    this.bus = deps.bus;
    this.clock = deps.clock;
    this.warehouses = deps.warehouses;
  }

  /** Goods arrive at a warehouse. */
  receive(actor: Actor, input: unknown): StockLevel {
    requirePermission(actor, 'inventory:adjust');
    const body = requireObject(input);
    const sku = requireSku(body.sku);
    const warehouseId = this.activeWarehouse(body.warehouseId);
    const qty = requireInt(body.qty, 'qty', { min: 1, max: 100_000 });
    const level = this.move(actor.id, { sku, warehouseId, kind: 'receive', onHandDelta: qty, reservedDelta: 0, ref: optionalString(body.ref, 'ref', { max: 100 }) ?? '', note: '' });
    this.bus.publish({ type: 'stock.received', actor: actor.id, entity: 'stock', entityId: level.id, data: { sku, warehouseId, qty } });
    return level;
  }

  /** Manual correction. `qty` may be negative but on hand never drops below what is reserved. */
  adjust(actor: Actor, input: unknown): StockLevel {
    requirePermission(actor, 'inventory:adjust');
    const body = requireObject(input);
    const sku = requireSku(body.sku);
    const warehouseId = this.activeWarehouse(body.warehouseId);
    const qty = requireInt(body.qty, 'qty', { min: -100_000, max: 100_000 });
    if (qty === 0) { throw new ValidationError('qty must not be 0', 'qty'); }
    const reason = requireOneOf(body.reason, 'reason', ADJUST_REASONS);
    const current = this.level(sku, warehouseId);
    if (current.onHand + qty < current.reserved) { throw new ConflictError('adjustment would leave less on hand than is reserved'); }
    const level = this.move(actor.id, { sku, warehouseId, kind: 'adjust', onHandDelta: qty, reservedDelta: 0, ref: reason, note: optionalString(body.note, 'note', { max: 500 }) ?? '' });
    this.bus.publish({ type: 'stock.adjusted', actor: actor.id, entity: 'stock', entityId: level.id, data: { sku, warehouseId, qty, reason } });
    return level;
  }

  /**
   * Reserves every line of an order, taking from warehouses in shipping order. All or
   * nothing: if any line cannot be fully reserved, nothing is reserved (ConflictError).
   */
  reserve(actorId: string, orderId: string, lines: { lineId: string; sku: string; qty: number }[]): Allocation[] {
    if (this.reservations.find(orderId)?.state === 'held') { throw new StateError('order already has a reservation'); }
    const warehouses = this.warehouses.inShippingOrder();
    const plan: Allocation[] = [];
    const taken = new Map<string, number>();
    for (const line of lines) {
      let remaining = line.qty;
      for (const w of warehouses) {
        if (remaining === 0) { break; }
        const level = this.level(line.sku, w.id);
        const key = level.id;
        const free = level.onHand - level.reserved - (taken.get(key) ?? 0);
        const take = Math.min(free, remaining);
        if (take > 0) {
          plan.push({ lineId: line.lineId, sku: line.sku, warehouseId: w.id, qty: take });
          taken.set(key, (taken.get(key) ?? 0) + take);
          remaining -= take;
        }
      }
      if (remaining > 0) { throw new ConflictError(`not enough stock for ${line.sku}`); }
    }
    for (const a of plan) {
      this.move(actorId, { sku: a.sku, warehouseId: a.warehouseId, kind: 'reserve', onHandDelta: 0, reservedDelta: a.qty, ref: orderId, note: a.lineId });
    }
    if (this.reservations.find(orderId)) {
      this.reservations.update(orderId, r => { r.allocations = plan; r.state = 'held'; });
    } else {
      this.reservations.insert({ id: orderId, allocations: plan, state: 'held' });
    }
    return plan;
  }

  /** Gives back a held reservation (order cancelled before shipping). */
  release(actorId: string, orderId: string): void {
    const r = this.reservations.get(orderId);
    if (r.state !== 'held') { throw new StateError(`reservation is ${r.state}`); }
    for (const a of r.allocations) {
      this.move(actorId, { sku: a.sku, warehouseId: a.warehouseId, kind: 'release', onHandDelta: 0, reservedDelta: -a.qty, ref: orderId, note: a.lineId });
    }
    this.reservations.update(orderId, x => { x.state = 'released'; });
  }

  /** The goods leave: on hand and reserved both go down. */
  ship(actorId: string, orderId: string): Allocation[] {
    const r = this.reservations.get(orderId);
    if (r.state !== 'held') { throw new StateError(`reservation is ${r.state}`); }
    for (const a of r.allocations) {
      this.move(actorId, { sku: a.sku, warehouseId: a.warehouseId, kind: 'ship', onHandDelta: -a.qty, reservedDelta: -a.qty, ref: orderId, note: a.lineId });
    }
    this.reservations.update(orderId, x => { x.state = 'shipped'; });
    return r.allocations;
  }

  /** Allocations of an order, in the order they were made (shipping order per line). */
  allocations(orderId: string): Allocation[] {
    return this.reservations.find(orderId)?.allocations ?? [];
  }

  level(sku: string, warehouseId: string): StockLevel {
    return this.levels.find(`${sku}@${warehouseId}`) ?? { id: `${sku}@${warehouseId}`, sku, warehouseId, onHand: 0, reserved: 0 };
  }

  /** Levels of one sku in every active warehouse, in shipping order. */
  levelsFor(actor: Actor, skuInput: string): (StockLevel & { available: number })[] {
    requirePermission(actor, 'inventory:read');
    const sku = requireSku(skuInput);
    return this.warehouses.inShippingOrder().map(w => {
      const l = this.level(sku, w.id);
      return { ...l, available: l.onHand - l.reserved };
    });
  }

  /** Available units of a sku across all active warehouses. */
  available(sku: string): number {
    return this.warehouses.inShippingOrder().reduce((n, w) => {
      const l = this.level(sku, w.id);
      return n + l.onHand - l.reserved;
    }, 0);
  }

  history(actor: Actor, skuInput: string): StockMovement[] {
    requirePermission(actor, 'inventory:read');
    const sku = requireSku(skuInput);
    return this.movements.list(m => m.sku === sku);
  }

  private activeWarehouse(value: unknown): string {
    const id = requireString(value, 'warehouseId');
    const w = this.warehouses.table.find(id);
    if (!w || !w.active) { throw new NotFoundError('warehouse'); }
    return id;
  }

  private move(actorId: string, m: Omit<StockMovement, 'id' | 'actor' | 'at'>): StockLevel {
    const id = `${m.sku}@${m.warehouseId}`;
    const before = this.level(m.sku, m.warehouseId);
    const after = { ...before, onHand: before.onHand + m.onHandDelta, reserved: before.reserved + m.reservedDelta };
    if (after.onHand < 0 || after.reserved < 0 || after.reserved > after.onHand) {
      throw new ConflictError(`stock of ${m.sku} cannot go negative`);
    }
    if (this.levels.find(id)) {
      this.levels.update(id, l => { l.onHand = after.onHand; l.reserved = after.reserved; });
    } else {
      this.levels.insert(after);
    }
    this.movements.insert({ ...m, id: this.ids.next('movement'), actor: actorId, at: this.clock.now().toISOString() });
    return this.level(m.sku, m.warehouseId);
  }
}
