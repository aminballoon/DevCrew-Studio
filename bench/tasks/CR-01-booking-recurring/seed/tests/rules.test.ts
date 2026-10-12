import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BookingService, ValidationError, ConflictError } from '../src/index.ts';
import { setup, slot, at } from './helpers.ts';

test('rejects times without a time-zone or that cannot be parsed', () => {
  const { svc, org } = setup();
  assert.throws(() => svc.book('bob', org, slot('09:00', '10:00', { start: '2030-01-02T09:00:00' })), ValidationError);
  assert.throws(() => svc.book('bob', org, slot('09:00', '10:00', { end: 'tomorrow' })), ValidationError);
});

test('times must be on 15-minute boundaries', () => {
  const { svc, org } = setup();
  assert.throws(() => svc.book('bob', org, slot('09:10', '10:00')), ValidationError);
  assert.throws(() => svc.book('bob', org, slot('09:00', '10:00', { end: '2030-01-02T10:00:30Z' })), ValidationError);
  assert.ok(svc.book('bob', org, slot('09:15', '09:45')));
});

test('duration is 15 minutes to 8 hours and start is before end', () => {
  const { svc, org } = setup();
  assert.throws(() => svc.book('ann', org, slot('10:00', '09:00')), ValidationError);
  assert.throws(() => svc.book('ann', org, slot('10:00', '10:00')), ValidationError);
  assert.throws(() => svc.book('ann', org, slot('08:00', '16:15')), ValidationError);
  assert.ok(svc.book('ann', org, slot('08:00', '16:00')));
  assert.ok(svc.book('ann', org, slot('16:00', '16:15')));
});

test('cannot book in the past', () => {
  const { svc, org } = setup();
  assert.throws(() => svc.book('ann', org, slot('09:00', '10:00', { start: '2029-12-31T23:45:00Z', end: '2030-01-01T00:30:00Z' })), ValidationError);
  assert.ok(svc.book('ann', org, slot('09:00', '10:00', { start: '2030-01-01T00:00:00Z', end: '2030-01-01T00:30:00Z' })));
});

test('title and attendees are validated', () => {
  const { svc, org } = setup();
  assert.throws(() => svc.book('bob', org, slot('09:00', '10:00', { title: '   ' })), ValidationError);
  assert.throws(() => svc.book('bob', org, slot('09:00', '10:00', { title: 'x'.repeat(101) })), ValidationError);
  assert.ok(svc.book('bob', org, slot('09:00', '10:00', { title: ` ${'y'.repeat(100)} ` })));
  assert.throws(() => svc.book('bob', org, slot('10:00', '11:00', { attendees: 0 })), ValidationError);
  assert.throws(() => svc.book('bob', org, slot('10:00', '11:00', { attendees: 2.5 })), ValidationError);
  assert.throws(() => svc.book('bob', org, slot('10:00', '11:00', { roomId: 'r2', attendees: 5 })), ValidationError);
  assert.ok(svc.book('bob', org, slot('10:00', '11:00', { roomId: 'r2', attendees: 4 })));
});

test('room capacity must be an integer from 1 to 500', () => {
  const { svc, org } = setup();
  for (const capacity of [0, 501, 1.5, -3]) {
    assert.throws(() => svc.addRoom('ann', org, { roomId: `c${capacity}`, name: 'C', capacity }), ValidationError);
  }
  assert.ok(svc.addRoom('ann', org, { roomId: 'max', name: 'Hall', capacity: 500 }) !== null);
});

test('unknown role throws ValidationError', () => {
  const { svc, org } = setup();
  assert.throws(() => svc.addUser('ann', org, 'zed', 'owner' as any), ValidationError);
});

test('overlapping bookings of the same room conflict; touching ones and other rooms do not', () => {
  const { svc, org } = setup();
  svc.book('ann', org, slot('09:00', '10:00'));
  assert.throws(() => svc.book('ann', org, slot('09:30', '10:30')), ConflictError);
  assert.throws(() => svc.book('ann', org, slot('08:00', '12:00')), ConflictError);
  assert.throws(() => svc.book('ann', org, slot('09:15', '09:45')), ConflictError);
  assert.ok(svc.book('ann', org, slot('10:00', '11:00')));
  assert.ok(svc.book('ann', org, slot('08:00', '09:00')));
  assert.ok(svc.book('ann', org, slot('09:00', '10:00', { roomId: 'r2' })));
});

test('overlap is detected across time-zone offsets', () => {
  const { svc, org } = setup();
  svc.book('ann', org, slot('09:00', '10:00'));
  assert.throws(() => svc.book('ann', org, { roomId: 'r1', start: '2030-01-02T16:30:00+07:00', end: '2030-01-02T17:30:00+07:00', title: 'BKK', attendees: 1 }), ConflictError);
});

test('cancelling frees the slot; cancelling twice conflicts', () => {
  const { svc, org } = setup();
  const b = svc.book('bob', org, slot('09:00', '10:00'));
  assert.equal(svc.cancel('bob', org, b.id).status, 'cancelled');
  assert.throws(() => svc.cancel('bob', org, b.id), ConflictError);
  assert.ok(svc.book('ann', org, slot('09:00', '10:00')));
});

test('a member may hold at most 3 upcoming active bookings; admins have no limit', () => {
  const { svc, org } = setup();
  const first = svc.book('bob', org, slot('09:00', '10:00'));
  svc.book('bob', org, slot('10:00', '11:00'));
  svc.book('bob', org, slot('11:00', '12:00'));
  assert.throws(() => svc.book('bob', org, slot('12:00', '13:00')), ConflictError);
  svc.cancel('bob', org, first.id);
  assert.ok(svc.book('bob', org, slot('12:00', '13:00')));
  for (const h of ['13', '14', '15', '16', '17']) {
    svc.book('ann', org, slot(`${h}:00`, `${h}:30`));
  }
});

test('bookings that have already ended do not count towards the limit', () => {
  let now = new Date('2030-01-01T00:00:00Z');
  const s2 = new BookingService({ now: () => now });
  const o = s2.createOrg('Moving', 'ann');
  s2.addUser('ann', o, 'bob', 'member');
  s2.addRoom('ann', o, { roomId: 'r1', name: 'R', capacity: 5 });
  s2.book('bob', o, slot('09:00', '10:00'));
  s2.book('bob', o, slot('10:00', '11:00'));
  s2.book('bob', o, slot('11:00', '12:00'));
  now = new Date('2030-01-02T10:00:00Z'); // the 09:00–10:00 booking has ended
  assert.ok(s2.book('bob', o, slot('12:00', '13:00')));
  assert.throws(() => s2.book('bob', o, slot('13:00', '14:00')), ConflictError);
});
