export class ValidationError extends Error {}
export class AuthError extends Error {}
export class NotFoundError extends Error {}
export class ConflictError extends Error {}

type Role = 'admin' | 'member' | 'viewer';
const ROLES = new Set(['admin', 'member', 'viewer']);
export interface Booking { id: string; orgId: string; roomId: string; userId: string; start: string; end: string; title: string; attendees: number; status: 'active' | 'cancelled' }
interface Room { roomId: string; name: string; capacity: number }
interface Org { id: string; name: string; members: Map<string, Role>; rooms: Map<string, Room>; bookings: Map<string, Booking> }

const Q = 15 * 60_000;
function parseTime(s: unknown): number {
  if (typeof s !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(s)) { throw new ValidationError('time needs a time-zone'); }
  const t = Date.parse(s);
  if (Number.isNaN(t)) { throw new ValidationError('bad time'); }
  return t;
}
const iso = (t: number) => new Date(t).toISOString();

export class BookingService {
  private orgs = new Map<string, Org>();
  private seq = 0;
  private now: () => Date;
  constructor(options: { now?: () => Date } = {}) { this.now = options.now ?? (() => new Date()); }

  private org(actor: string, orgId: string, need?: Role[]): Org {
    const o = this.orgs.get(orgId);
    if (!o) { throw new NotFoundError('org'); }
    const role = o.members.get(actor);
    if (!role) { throw new AuthError('not a member'); }
    if (need && !need.includes(role)) { throw new AuthError('role'); }
    return o;
  }
  private room(o: Org, roomId: string): Room {
    const r = o.rooms.get(roomId);
    if (!r) { throw new NotFoundError('room'); }
    return r;
  }

  createOrg(name: string, adminUserId: string): string {
    if (typeof name !== 'string' || !name.trim()) { throw new ValidationError('name'); }
    const id = `org-${++this.seq}`;
    this.orgs.set(id, { id, name: name.trim(), members: new Map([[adminUserId, 'admin']]), rooms: new Map(), bookings: new Map() });
    return id;
  }
  addUser(actor: string, orgId: string, userId: string, role: Role): void {
    const o = this.org(actor, orgId, ['admin']);
    if (!ROLES.has(role)) { throw new ValidationError('role'); }
    if (o.members.has(userId)) { throw new ConflictError('member'); }
    o.members.set(userId, role);
  }
  addRoom(actor: string, orgId: string, room: Room): Room {
    const o = this.org(actor, orgId, ['admin']);
    if (!Number.isInteger(room.capacity) || room.capacity < 1 || room.capacity > 500) { throw new ValidationError('capacity'); }
    if (o.rooms.has(room.roomId)) { throw new ConflictError('room'); }
    o.rooms.set(room.roomId, { ...room });
    return { ...room };
  }
  book(actor: string, orgId: string, req: { roomId: string; start: string; end: string; title: string; attendees: number }): Booking {
    const o = this.org(actor, orgId, ['admin', 'member']);
    const room = this.room(o, req.roomId);
    const s = parseTime(req.start), e = parseTime(req.end);
    if (s % Q || e % Q) { throw new ValidationError('15 min'); }
    if (s >= e || e - s < Q || e - s > 8 * 3_600_000) { throw new ValidationError('duration'); }
    const now = this.now().getTime();
    if (s < now) { throw new ValidationError('past'); }
    const title = typeof req.title === 'string' ? req.title.trim() : '';
    if (title.length < 1 || title.length > 100) { throw new ValidationError('title'); }
    if (!Number.isInteger(req.attendees) || req.attendees < 1 || req.attendees > room.capacity) { throw new ValidationError('attendees'); }
    const active = [...o.bookings.values()].filter(b => b.status === 'active');
    if (active.some(b => b.roomId === req.roomId && Date.parse(b.start) < e && s < Date.parse(b.end))) { throw new ConflictError('overlap'); }
    if (o.members.get(actor) === 'member' && active.filter(b => b.userId === actor && Date.parse(b.end) > now).length >= 3) { throw new ConflictError('limit'); }
    const b: Booking = { id: `b-${String(++this.seq).padStart(6, '0')}`, orgId, roomId: req.roomId, userId: actor, start: iso(s), end: iso(e), title, attendees: req.attendees, status: 'active' };
    o.bookings.set(b.id, b);
    return { ...b };
  }
  private booking(o: Org, id: string): Booking {
    const b = o.bookings.get(id);
    if (!b) { throw new NotFoundError('booking'); }
    return b;
  }
  cancel(actor: string, orgId: string, bookingId: string): Booking {
    const o = this.org(actor, orgId);
    const b = this.booking(o, bookingId);
    if (b.userId !== actor && o.members.get(actor) !== 'admin') { throw new AuthError('not yours'); }
    if (b.status === 'cancelled') { throw new ConflictError('cancelled'); }
    b.status = 'cancelled';
    return { ...b };
  }
  getBooking(actor: string, orgId: string, bookingId: string): Booking {
    return { ...this.booking(this.org(actor, orgId), bookingId) };
  }
  listBookings(actor: string, orgId: string, filter: { roomId?: string; from?: string; to?: string } = {}): Booking[] {
    const o = this.org(actor, orgId);
    const from = filter.from ? parseTime(filter.from) : -Infinity, to = filter.to ? parseTime(filter.to) : Infinity;
    return [...o.bookings.values()]
      .filter(b => b.status === 'active' && (!filter.roomId || b.roomId === filter.roomId) && Date.parse(b.start) < to && from < Date.parse(b.end))
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(b => ({ ...b }));
  }
  freeSlots(actor: string, orgId: string, roomId: string, fromIso: string, toIso: string): { start: string; end: string }[] {
    const o = this.org(actor, orgId);
    this.room(o, roomId);
    const from = parseTime(fromIso), to = parseTime(toIso);
    const busy = this.listBookings(actor, orgId, { roomId, from: fromIso, to: toIso });
    const out: { start: string; end: string }[] = [];
    let cur = from;
    for (const b of busy) {
      const s = Date.parse(b.start), e = Date.parse(b.end);
      if (s > cur) { out.push({ start: iso(cur), end: iso(Math.min(s, to)) }); }
      cur = Math.max(cur, e);
    }
    if (cur < to) { out.push({ start: iso(cur), end: iso(to) }); }
    return out;
  }
}
