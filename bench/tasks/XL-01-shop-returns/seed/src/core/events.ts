import type { Clock } from './clock.ts';

/**
 * In-process domain events. Services publish after a change has been fully applied;
 * subscribers (audit log, notifications, ...) react synchronously.
 *
 * Event types are `<entity>.<past-tense verb>`, e.g. `order.placed`, `payment.refunded`.
 * `entity` / `entityId` name the thing the event is about; `actor` is the user id that
 * caused it (`system` for automatic changes).
 */
export interface DomainEvent {
  type: string;
  at: string;
  actor: string;
  entity: string;
  entityId: string;
  data: Record<string, unknown>;
}

export type EventInput = Omit<DomainEvent, 'at'>;
type Handler = (event: DomainEvent) => void;

export class EventBus {
  private handlers: { pattern: string; handler: Handler }[] = [];
  private clock: Clock;
  readonly published: DomainEvent[] = [];

  constructor(clock: Clock) { this.clock = clock; }

  /** `pattern` is an exact type, `entity.*`, or `*`. */
  subscribe(pattern: string, handler: Handler): void {
    this.handlers.push({ pattern, handler });
  }

  publish(input: EventInput): DomainEvent {
    const event: DomainEvent = { ...input, at: this.clock.now().toISOString(), data: structuredClone(input.data) };
    this.published.push(event);
    for (const { pattern, handler } of this.handlers) {
      if (matches(pattern, event.type)) { handler(event); }
    }
    return event;
  }
}

function matches(pattern: string, type: string): boolean {
  if (pattern === '*') { return true; }
  if (pattern.endsWith('.*')) { return type.startsWith(pattern.slice(0, -1)); }
  return pattern === type;
}
