import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BookingService, ValidationError, ConflictError, NotFoundError } from '../src/index.ts';
import { setup, slot, at, NOW } from './helpers.ts';

test('error classes extend Error', async () => {
  const m = await import('../src/index.ts');
  for (const name of ['ValidationError', 'AuthError', 'NotFoundError', 'ConflictError']) {
    assert.ok(new (m as any)[name]('x') instanceof Error, name);
  }
});

test('createOrg returns a string id and rejects a blank name', () => {
  const svc = new BookingService({ now: () => NOW });
  assert.equal(typeof svc.createOrg('Acme', 'ann'), 'string');
  assert.notEqual(svc.createOrg('A', 'x'), svc.createOrg('B', 'y'));
  assert.throws(() => svc.createOrg('   ', 'ann'), ValidationError);
});

test('a member books a room and gets the booking back in UTC', () => {
  const { svc, org } = setup();
  const b = svc.book('bob', org, slot('09:00', '10:00', { title: '  Planning  ' }));
  assert.equal(typeof b.id, 'string');
  assert.deepEqual({ ...b, id: 'x' }, {
    id: 'x', orgId: org, roomId: 'r1', userId: 'bob',
    start: '2030-01-02T09:00:00.000Z', end: '2030-01-02T10:00:00.000Z',
    title: 'Planning', attendees: 3, status: 'active',
  });
});

test('times with an offset are converted to UTC', () => {
  const { svc, org } = setup();
  const b = svc.book('bob', org, { roomId: 'r1', start: '2030-01-02T16:00:00+07:00', end: '2030-01-02T17:30:00+07:00', title: 'BKK', attendees: 2 });
  assert.equal(b.start, '2030-01-02T09:00:00.000Z');
  assert.equal(b.end, '2030-01-02T10:30:00.000Z');
});

test('booking ids are unique', () => {
  const { svc, org } = setup();
  const ids = new Set([
    svc.book('ann', org, slot('09:00', '10:00')).id,
    svc.book('ann', org, slot('10:00', '11:00')).id,
    svc.book('ann', org, slot('09:00', '10:00', { roomId: 'r2' })).id,
  ]);
  assert.equal(ids.size, 3);
});

test('getBooking returns the booking, including after it is cancelled', () => {
  const { svc, org } = setup();
  const b = svc.book('bob', org, slot('09:00', '10:00'));
  assert.deepEqual(svc.getBooking('vic', org, b.id), b);
  svc.cancel('bob', org, b.id);
  assert.equal(svc.getBooking('bob', org, b.id).status, 'cancelled');
});

test('listBookings is sorted by start then id, filters by room and window, and hides cancelled ones', () => {
  const { svc, org } = setup();
  const late = svc.book('ann', org, slot('13:00', '14:00'));
  const early = svc.book('ann', org, slot('08:00', '09:00', { roomId: 'r2' }));
  const mid = svc.book('ann', org, slot('10:00', '11:00'));
  const gone = svc.book('ann', org, slot('11:00', '12:00'));
  svc.cancel('ann', org, gone.id);
  assert.deepEqual(svc.listBookings('vic', org).map(b => b.id), [early.id, mid.id, late.id]);
  assert.deepEqual(svc.listBookings('vic', org, { roomId: 'r1' }).map(b => b.id), [mid.id, late.id]);
  // [from, to) overlap: 09:00–10:00 touches early's end and mid's start but overlaps neither
  assert.deepEqual(svc.listBookings('vic', org, { from: at('09:00'), to: at('10:00') }), []);
  assert.deepEqual(svc.listBookings('vic', org, { from: at('08:30'), to: at('10:30') }).map(b => b.id), [early.id, mid.id]);
});

test('same start time is ordered by id', () => {
  const { svc, org } = setup();
  const a = svc.book('ann', org, slot('09:00', '10:00'));
  const b = svc.book('ann', org, slot('09:00', '10:00', { roomId: 'r2' }));
  const expected = [a.id, b.id].sort();
  assert.deepEqual(svc.listBookings('ann', org).map(x => x.id), expected);
});

test('freeSlots returns merged gaps inside the window', () => {
  const { svc, org } = setup();
  svc.book('ann', org, slot('09:00', '10:00'));
  svc.book('ann', org, slot('10:00', '10:30'));
  const c = svc.book('ann', org, slot('12:00', '13:00'));
  svc.book('ann', org, slot('11:00', '12:00', { roomId: 'r2' }));
  assert.deepEqual(svc.freeSlots('vic', org, 'r1', at('08:00'), at('14:00')), [
    { start: '2030-01-02T08:00:00.000Z', end: '2030-01-02T09:00:00.000Z' },
    { start: '2030-01-02T10:30:00.000Z', end: '2030-01-02T12:00:00.000Z' },
    { start: '2030-01-02T13:00:00.000Z', end: '2030-01-02T14:00:00.000Z' },
  ]);
  svc.cancel('ann', org, c.id);
  assert.deepEqual(svc.freeSlots('vic', org, 'r1', at('09:30'), at('14:00')), [
    { start: '2030-01-02T10:30:00.000Z', end: '2030-01-02T14:00:00.000Z' },
  ]);
  assert.deepEqual(svc.freeSlots('vic', org, 'r1', at('09:00'), at('10:30')), []);
});

test('unknown room throws NotFoundError', () => {
  const { svc, org } = setup();
  assert.throws(() => svc.book('bob', org, slot('09:00', '10:00', { roomId: 'nope' })), NotFoundError);
  assert.throws(() => svc.freeSlots('bob', org, 'nope', at('09:00'), at('10:00')), NotFoundError);
});

test('duplicate room id and duplicate member throw ConflictError', () => {
  const { svc, org } = setup();
  assert.throws(() => svc.addRoom('ann', org, { roomId: 'r1', name: 'Again', capacity: 3 }), ConflictError);
  assert.throws(() => svc.addUser('ann', org, 'bob', 'viewer'), ConflictError);
});
