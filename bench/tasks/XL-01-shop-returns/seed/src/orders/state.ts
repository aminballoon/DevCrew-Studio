import { StateError } from '../core/errors.ts';

export type OrderStatus = 'draft' | 'placed' | 'paid' | 'shipped' | 'delivered' | 'cancelled';

/** The only allowed status changes. Anything else is a StateError. */
export const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  draft: ['placed', 'cancelled'],
  placed: ['paid', 'cancelled'],
  paid: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) { throw new StateError(`order cannot go from ${from} to ${to}`); }
}
