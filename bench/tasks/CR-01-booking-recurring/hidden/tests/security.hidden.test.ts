import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthError, NotFoundError } from '../src/index.ts';
import { setup, slot, at } from './helpers.ts';

test('viewers can read but not book', () => {
  const { svc, org } = setup();
  assert.throws(() => svc.book('vic', org, slot('09:00', '10:00')), AuthError);
  assert.deepEqual(svc.listBookings('vic', org), []);
});

test('only admins add people and rooms', () => {
  const { svc, org } = setup();
  assert.throws(() => svc.addUser('bob', org, 'eve', 'admin'), AuthError);
  assert.throws(() => svc.addUser('vic', org, 'eve', 'member'), AuthError);
  assert.throws(() => svc.addRoom('bob', org, { roomId: 'x', name: 'X', capacity: 2 }), AuthError);
});

test('only the booker or an admin may cancel', () => {
  const { svc, org } = setup();
  svc.addUser('ann', org, 'cat', 'member');
  const b = svc.book('bob', org, slot('09:00', '10:00'));
  assert.throws(() => svc.cancel('cat', org, b.id), AuthError);
  assert.throws(() => svc.cancel('vic', org, b.id), AuthError);
  assert.equal(svc.cancel('ann', org, b.id).status, 'cancelled');
});

test('non-members get AuthError on every method', () => {
  const { svc, org } = setup();
  const b = svc.book('bob', org, slot('09:00', '10:00'));
  const calls = [
    () => svc.addUser('eve', org, 'x', 'member'),
    () => svc.addRoom('eve', org, { roomId: 'x', name: 'X', capacity: 2 }),
    () => svc.book('eve', org, slot('11:00', '12:00')),
    () => svc.cancel('eve', org, b.id),
    () => svc.getBooking('eve', org, b.id),
    () => svc.listBookings('eve', org),
    () => svc.freeSlots('eve', org, 'r1', at('08:00'), at('12:00')),
  ];
  for (const call of calls) { assert.throws(call, AuthError); }
});

test('an unknown organisation throws NotFoundError', () => {
  const { svc } = setup();
  assert.throws(() => svc.listBookings('ann', 'no-such-org'), NotFoundError);
  assert.throws(() => svc.addUser('ann', 'no-such-org', 'x', 'member'), NotFoundError);
});

test('an admin of one organisation has no rights in another', () => {
  const { svc, org } = setup();
  const other = svc.createOrg('Globex', 'gus');
  svc.addRoom('gus', other, { roomId: 'r1', name: 'Theirs', capacity: 5 });
  assert.throws(() => svc.addUser('ann', other, 'ann2', 'admin'), AuthError);
  assert.throws(() => svc.book('ann', other, slot('09:00', '10:00')), AuthError);
  assert.throws(() => svc.listBookings('gus', org), AuthError);
});

test('a user can be admin in one organisation and viewer in another', () => {
  const { svc, org } = setup();
  const other = svc.createOrg('Globex', 'gus');
  svc.addRoom('gus', other, { roomId: 'g1', name: 'G', capacity: 5 });
  svc.addUser('gus', other, 'ann', 'viewer');
  assert.throws(() => svc.book('ann', other, { ...slot('09:00', '10:00'), roomId: 'g1' }), AuthError);
  assert.ok(svc.book('ann', org, slot('09:00', '10:00')));
});

test('bookings of another organisation look like missing ones (no IDOR)', () => {
  const { svc, org } = setup();
  const other = svc.createOrg('Globex', 'gus');
  svc.addRoom('gus', other, { roomId: 'r1', name: 'Theirs', capacity: 5 });
  const theirs = svc.book('gus', other, slot('09:00', '10:00'));
  assert.throws(() => svc.getBooking('ann', org, theirs.id), NotFoundError);
  assert.throws(() => svc.cancel('ann', org, theirs.id), NotFoundError);
  assert.throws(() => svc.getBooking('ann', org, 'no-such-id'), NotFoundError);
  assert.equal(svc.getBooking('gus', other, theirs.id).status, 'active');
});

test('same room id in two organisations are different rooms', () => {
  const { svc, org } = setup();
  const other = svc.createOrg('Globex', 'gus');
  svc.addRoom('gus', other, { roomId: 'r1', name: 'Theirs', capacity: 5 });
  svc.book('gus', other, slot('09:00', '10:00'));
  assert.ok(svc.book('ann', org, slot('09:00', '10:00')));
  assert.equal(svc.listBookings('ann', org).length, 1);
  assert.equal(svc.listBookings('gus', other).length, 1);
});

test('returned objects are copies', () => {
  const { svc, org } = setup();
  const b = svc.book('bob', org, slot('09:00', '10:00'));
  b.status = 'cancelled'; b.start = at('01:00'); b.userId = 'vic';
  const fresh = svc.getBooking('bob', org, b.id);
  assert.equal(fresh.status, 'active');
  assert.equal(fresh.userId, 'bob');
  fresh.status = 'cancelled';
  assert.equal(svc.getBooking('bob', org, b.id).status, 'active');
  const list = svc.listBookings('bob', org);
  list[0].roomId = 'r2';
  list.pop();
  assert.equal(svc.listBookings('bob', org).length, 1);
  assert.equal(svc.listBookings('bob', org)[0].roomId, 'r1');
  const slots = svc.freeSlots('bob', org, 'r1', at('08:00'), at('09:00'));
  slots[0].end = at('12:00');
  assert.deepEqual(svc.freeSlots('bob', org, 'r1', at('08:00'), at('09:00')), [{ start: '2030-01-02T08:00:00.000Z', end: '2030-01-02T09:00:00.000Z' }]);
});
