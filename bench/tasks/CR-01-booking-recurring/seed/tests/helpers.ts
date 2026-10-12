import { BookingService } from '../src/index.ts';

export const NOW = new Date('2030-01-01T00:00:00Z');

/** An org "acme" with admin ann, member bob, viewer vic, and rooms r1 (cap 10) and r2 (cap 4). */
export function setup() {
  const svc = new BookingService({ now: () => NOW });
  const org = svc.createOrg('Acme', 'ann');
  svc.addUser('ann', org, 'bob', 'member');
  svc.addUser('ann', org, 'vic', 'viewer');
  svc.addRoom('ann', org, { roomId: 'r1', name: 'Big room', capacity: 10 });
  svc.addRoom('ann', org, { roomId: 'r2', name: 'Small room', capacity: 4 });
  return { svc, org };
}

export const at = (hhmm: string, day = '2030-01-02') => `${day}T${hhmm}:00Z`;
export const slot = (from: string, to: string, extra: Record<string, unknown> = {}) =>
  ({ roomId: 'r1', start: at(from), end: at(to), title: 'Sync', attendees: 3, ...extra });
