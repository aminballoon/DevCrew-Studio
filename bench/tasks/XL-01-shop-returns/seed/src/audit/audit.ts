import type { Actor } from '../auth/permissions.ts';
import { requirePermission } from '../auth/permissions.ts';
import type { DomainEvent, EventBus } from '../core/events.ts';
import type { IdGenerator } from '../core/ids.ts';
import { Table } from '../core/store.ts';

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  data: Record<string, unknown>;
}

/**
 * The audit trail: one entry for every domain event, written automatically by
 * subscribing to the bus. Services never write here directly; publishing an event is
 * how an action gets audited.
 */
export class AuditLog {
  readonly table = new Table<AuditEntry>('audit entry');
  private ids: IdGenerator;

  constructor(deps: { ids: IdGenerator; bus: EventBus }) {
    this.ids = deps.ids;
    deps.bus.subscribe('*', e => this.record(e));
  }

  private record(event: DomainEvent): void {
    this.table.insert({
      id: this.ids.next('audit'), at: event.at, actor: event.actor, action: event.type,
      entity: event.entity, entityId: event.entityId, data: event.data,
    });
  }

  /** Oldest first. Every filter is optional and exact. */
  query(actor: Actor, filter: { entity?: string; entityId?: string; action?: string; actor?: string } = {}): AuditEntry[] {
    requirePermission(actor, 'audit:read');
    return this.table
      .list(e => (!filter.entity || e.entity === filter.entity)
        && (!filter.entityId || e.entityId === filter.entityId)
        && (!filter.action || e.action === filter.action)
        && (!filter.actor || e.actor === filter.actor))
      .sort((a, b) => a.at.localeCompare(b.at) || Number(a.id.slice(4)) - Number(b.id.slice(4)));
  }
}
