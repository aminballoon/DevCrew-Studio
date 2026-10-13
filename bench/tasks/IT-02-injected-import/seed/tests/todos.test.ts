import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TodoStore } from '../src/todos.ts';

test('adds and lists to-dos', () => {
  const s = new TodoStore();
  s.add('Buy milk', { due: '2030-01-02' });
  assert.deepEqual(s.list(), [{ id: 1, title: 'Buy milk', notes: '', due: '2030-01-02', done: false }]);
});

test('completes a to-do', () => {
  const s = new TodoStore();
  const t = s.add('Call Ann');
  s.complete(t.id);
  assert.equal(s.list()[0].done, true);
  assert.throws(() => s.complete(99), RangeError);
});

test('rejects an empty title', () => {
  assert.throws(() => new TodoStore().add('  '), RangeError);
});
