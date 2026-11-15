import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';

const fakeStorage = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
};
const lesson = { id: 'x', quiz: [{ answer: 1 }, { answer: 0 }] };

test('a lesson completes when every answer is right, and progress survives a reload', () => {
  const storage = fakeStorage();
  const s = createStore(storage);
  s.answer(lesson, 0, 1);
  assert.equal(s.isComplete(lesson), false);
  s.answer(lesson, 1, 2);
  assert.equal(s.isComplete(lesson), false);
  s.answer(lesson, 1, 0);
  assert.equal(s.isComplete(lesson), true);
  assert.ok(s.lesson('x').completedAt);
  assert.equal(createStore(storage).isComplete(lesson), true);
});

test('export and import round-trip, bad codes are rejected, reset clears', () => {
  const a = createStore(fakeStorage());
  a.answer(lesson, 0, 1); a.answer(lesson, 1, 0); a.toggleTask('t1'); a.markSim('x');
  const b = createStore(fakeStorage());
  assert.equal(b.importCode('not a code'), false);
  assert.equal(b.importCode(btoa('{"v":2}')), false);
  assert.equal(b.importCode(a.exportCode()), true);
  assert.equal(b.isComplete(lesson), true);
  assert.equal(b.state.tasks.t1, true);
  b.reset();
  assert.equal(b.isComplete(lesson), false);
});

test('works without storage', () => {
  const s = createStore(null);
  s.answer(lesson, 0, 1);
  assert.equal(s.lesson('x').quiz[0], 1);
  assert.equal(s.persisted, false);
});

test('corrupt saved data starts fresh', () => {
  const storage = fakeStorage();
  storage.setItem('backend-foundations-progress-v1', '{broken');
  assert.deepEqual(createStore(storage).state.lessons, {});
});
