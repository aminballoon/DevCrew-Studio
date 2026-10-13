import type { Actor } from '../auth/permissions.ts';
import { requirePermission } from '../auth/permissions.ts';
import { ConflictError } from '../core/errors.ts';
import type { EventBus } from '../core/events.ts';
import type { IdGenerator } from '../core/ids.ts';
import { Table } from '../core/store.ts';
import { requireInt, requireObject, requireString } from '../core/validate.ts';

export interface Warehouse {
  id: string;
  code: string;
  name: string;
  /** Lower ships first when stock is reserved for an order. */
  priority: number;
  active: boolean;
}

export class WarehouseService {
  readonly table = new Table<Warehouse>('warehouse');
  private ids: IdGenerator;
  private bus: EventBus;

  constructor(deps: { ids: IdGenerator; bus: EventBus }) {
    this.ids = deps.ids;
    this.bus = deps.bus;
  }

  create(actor: Actor, input: unknown): Warehouse {
    requirePermission(actor, 'warehouses:manage');
    const body = requireObject(input);
    const code = requireString(body.code, 'code', { max: 10 }).toUpperCase();
    if (this.table.list(w => w.code === code).length > 0) { throw new ConflictError(`warehouse ${code} already exists`); }
    const warehouse = this.table.insert({
      id: this.ids.next('warehouse'),
      code,
      name: requireString(body.name, 'name', { max: 100 }),
      priority: body.priority === undefined ? 100 : requireInt(body.priority, 'priority', { min: 0, max: 1000 }),
      active: true,
    });
    this.bus.publish({ type: 'warehouse.created', actor: actor.id, entity: 'warehouse', entityId: warehouse.id, data: { code } });
    return warehouse;
  }

  /** Active warehouses in shipping order: priority, then code. */
  inShippingOrder(): Warehouse[] {
    return this.table.list(w => w.active).sort((a, b) => a.priority - b.priority || a.code.localeCompare(b.code));
  }

  list(actor: Actor): Warehouse[] {
    requirePermission(actor, 'inventory:read');
    return this.inShippingOrder();
  }
}
