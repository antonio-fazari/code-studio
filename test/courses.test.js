import test from 'node:test';
import assert from 'node:assert/strict';
import { courses } from '../src/courses/index.js';

const all = courses.flatMap((c) => c.lessons.map((l) => ({ course: c, lesson: l })));
const ids = new Set(all.map(({ lesson }) => lesson.id));

test('every lesson id and capstone id is unique across courses', () => {
  const routes = [...all.map(({ lesson }) => lesson.id), ...courses.map((c) => c.capstoneId), ...courses.map((c) => c.id), 'overview'];
  assert.equal(new Set(routes).size, routes.length);
  for (const id of routes) assert.match(id, /^[a-z0-9-]+$/, `${id} must be a plain hash name`);
});

test('every lesson has all sections and a working simulation entry point', () => {
  for (const { lesson: l } of all) {
    for (const key of ['title', 'hook']) assert.ok(typeof l[key] === 'string' && l[key].length > 0, `${l.id}.${key}`);
    for (const key of ['incident', 'problem', 'realWorld', 'approach', 'avoid', 'shoplite']) assert.ok(typeof l[key] === 'string' && l[key].length > 20, `${l.id}.${key}`);
    assert.equal(typeof l.sim.mount, 'function', `${l.id} sim`);
    assert.ok(l.tradeoffs.length >= 3 && l.tradeoffs.every((t) => t.length === 2), `${l.id} tradeoffs`);
    assert.equal(l.takeaways.length, 3, `${l.id} takeaways`);
  }
});

test('every quiz has three questions with a valid answer and an explanation', () => {
  for (const { lesson: l } of all) {
    assert.equal(l.quiz.length, 3, l.id);
    for (const q of l.quiz) {
      assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length, `${l.id}: ${q.q}`);
      assert.ok(q.why.length > 20, `${l.id}: explanation`);
    }
  }
});

test('System Design covers all 20 concepts, in parts, and its revisits point at real lessons', () => {
  const sd = courses.find((c) => c.id === 'system-design');
  assert.equal(sd.lessons.length, 20);
  assert.ok(sd.lessons.every((l) => l.part));
  const revisits = sd.lessons.filter((l) => l.revisits);
  assert.equal(revisits.length, 7);
  for (const l of revisits) assert.ok(ids.has(l.revisits.id), `${l.id} revisits ${l.revisits.id}`);
});
