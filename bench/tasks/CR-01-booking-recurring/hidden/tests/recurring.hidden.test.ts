import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValidationError, ConflictError, NotFoundError, AuthError } from '../src/index.ts';
import { setup, slot, at } from './helpers.ts';

const series = (from: string, to: string, weeks: number, extra: Record<string, unknown> = {}) => ({ ...slot(from, to, extra), weeks });
const week = (n: number) => `2030-01-${String(2 + 7 * n).padStart(2, '0')}`;

test('books the same slot every week and shares a seriesId', () => {
  const { svc, org } = setup();
  const list = svc.bookRecurring('bob', org, series('09:00', '10:00', 3));
  assert.equal(list.length, 3);
  assert.deepEqual(list.map(b => b.start), [0, 1, 2].map(n => `${week(n)}T09:00:00.000Z`));
  assert.deepEqual(list.map(b => b.end), [0, 1, 2].map(n => `${week(n)}T10:00:00.000Z`));
  assert.equal(typeof list[0].seriesId, 'string');
  assert.ok(list.every(b => b.seriesId === list[0].seriesId && b.status === 'active' && b.userId === 'bob'));
  assert.equal(new Set(list.map(b => b.id)).size, 3);
  assert.equal(svc.listBookings('bob', org).length, 3);
});

test('occurrences shift by exactly 7 days in UTC, also with an offset', () => {
  const { svc, org } = setup();
  const list = svc.bookRecurring('ann', org, { roomId: 'r1', start: '2030-01-02T16:00:00+07:00', end: '2030-01-02T17:00:00+07:00', title: 'BKK', attendees: 2, weeks: 2 });
  assert.deepEqual(list.map(b => b.start), ['2030-01-02T09:00:00.000Z', '2030-01-09T09:00:00.000Z']);
});

test('single bookings have no seriesId property', () => {
  const { svc, org } = setup();
  const b = svc.book('bob', org, slot('09:00', '10:00'));
  assert.equal('seriesId' in b, false);
  assert.equal('seriesId' in svc.getBooking('bob', org, b.id), false);
});

test('weeks must be 2 to 12, and members may book at most 4 weeks', () => {
  const { svc, org } = setup();
  for (const weeks of [1, 13, 2.5, 0]) {
    assert.throws(() => svc.bookRecurring('ann', org, series('09:00', '10:00', weeks)), ValidationError, `weeks ${weeks}`);
  }
  assert.throws(() => svc.bookRecurring('bob', org, series('09:00', '10:00', 5)), ValidationError);
  assert.equal(svc.bookRecurring('bob', org, series('09:00', '10:00', 4)).length, 4);
  assert.equal(svc.bookRecurring('ann', org, series('11:00', '12:00', 12)).length, 12);
});

test('each occurrence follows the single-booking rules', () => {
  const { svc, org } = setup();
  assert.throws(() => svc.bookRecurring('vic', org, series('09:00', '10:00', 2)), AuthError);
  assert.throws(() => svc.bookRecurring('bob', org, series('09:10', '10:00', 2)), ValidationError);
  assert.throws(() => svc.bookRecurring('bob', org, series('09:00', '10:00', 2, { attendees: 11 })), ValidationError);
  assert.throws(() => svc.bookRecurring('bob', org, series('09:00', '10:00', 2, { roomId: 'nope' })), NotFoundError);
  assert.throws(() => svc.bookRecurring('eve', org, series('09:00', '10:00', 2)), AuthError);
});

test('all or nothing when one occurrence overlaps', () => {
  const { svc, org } = setup();
  const blocker = svc.book('ann', org, { ...slot('09:30', '10:30'), start: `${week(2)}T09:30:00Z`, end: `${week(2)}T10:30:00Z` });
  assert.throws(() => svc.bookRecurring('ann', org, series('09:00', '10:00', 4)), ConflictError);
  assert.deepEqual(svc.listBookings('ann', org).map(b => b.id), [blocker.id]);
  // the same series in another room is fine
  assert.equal(svc.bookRecurring('ann', org, series('09:00', '10:00', 4, { roomId: 'r2' })).length, 4);
});

test('a series counts once towards the member limit of 3', () => {
  const { svc, org } = setup();
  svc.bookRecurring('bob', org, series('09:00', '10:00', 4));
  svc.book('bob', org, slot('11:00', '12:00'));
  svc.bookRecurring('bob', org, series('13:00', '14:00', 2));
  assert.throws(() => svc.book('bob', org, slot('15:00', '16:00')), ConflictError);
  assert.throws(() => svc.bookRecurring('bob', org, series('15:00', '16:00', 2)), ConflictError);
});

test('a series stops counting once all its occurrences are cancelled', () => {
  const { svc, org } = setup();
  const s = svc.bookRecurring('bob', org, series('09:00', '10:00', 2));
  svc.book('bob', org, slot('11:00', '12:00'));
  svc.book('bob', org, slot('12:00', '13:00'));
  assert.throws(() => svc.book('bob', org, slot('13:00', '14:00')), ConflictError);
  svc.cancel('bob', org, s[0].id);
  assert.throws(() => svc.book('bob', org, slot('13:00', '14:00')), ConflictError); // one occurrence still active
  svc.cancel('bob', org, s[1].id);
  assert.ok(svc.book('bob', org, slot('13:00', '14:00')));
});

test('cancelSeries cancels every active occurrence, or those from a time on', () => {
  const { svc, org } = setup();
  const s = svc.bookRecurring('bob', org, series('09:00', '10:00', 4));
  svc.cancel('bob', org, s[1].id);
  const later = svc.cancelSeries('bob', org, s[0].seriesId, { from: `${week(2)}T09:00:00Z` });
  assert.deepEqual(later.map(b => b.id), [s[2].id, s[3].id]);
  assert.ok(later.every(b => b.status === 'cancelled'));
  assert.equal(svc.getBooking('bob', org, s[0].id).status, 'active');
  const rest = svc.cancelSeries('ann', org, s[0].seriesId);
  assert.deepEqual(rest.map(b => b.id), [s[0].id]);
  assert.deepEqual(svc.cancelSeries('bob', org, s[0].seriesId), []);
  assert.deepEqual(svc.listBookings('bob', org), []);
});

test('cancelSeries checks permissions and organisation', () => {
  const { svc, org } = setup();
  svc.addUser('ann', org, 'cat', 'member');
  const s = svc.bookRecurring('bob', org, series('09:00', '10:00', 2));
  assert.throws(() => svc.cancelSeries('cat', org, s[0].seriesId), AuthError);
  assert.throws(() => svc.cancelSeries('vic', org, s[0].seriesId), AuthError);
  assert.throws(() => svc.cancelSeries('bob', org, 'no-such-series'), NotFoundError);
  const other = svc.createOrg('Globex', 'gus');
  svc.addRoom('gus', other, { roomId: 'r1', name: 'Theirs', capacity: 5 });
  const theirs = svc.bookRecurring('gus', other, series('09:00', '10:00', 2));
  assert.throws(() => svc.cancelSeries('ann', org, theirs[0].seriesId), NotFoundError);
  assert.equal(svc.listBookings('gus', other).length, 2);
});

test('members may book at most 4 hours; admins keep 8', () => {
  const { svc, org } = setup();
  assert.throws(() => svc.book('bob', org, slot('08:00', '12:15')), ValidationError);
  assert.ok(svc.book('bob', org, slot('08:00', '12:00')));
  assert.throws(() => svc.bookRecurring('bob', org, series('13:00', '17:15', 2)), ValidationError);
  assert.ok(svc.book('ann', org, slot('13:00', '21:00')));
});

test('returned series bookings are copies', () => {
  const { svc, org } = setup();
  const s = svc.bookRecurring('bob', org, series('09:00', '10:00', 2));
  s[0].status = 'cancelled';
  s[0].seriesId = 'hijack';
  assert.equal(svc.getBooking('bob', org, s[0].id).status, 'active');
  assert.equal(svc.getBooking('bob', org, s[0].id).seriesId, s[1].seriesId);
});
