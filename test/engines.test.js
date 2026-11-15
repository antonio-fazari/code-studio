import test from 'node:test';
import assert from 'node:assert/strict';
import {
  indexCost, binarySearchSteps, handlePayment, simulatePool, TTLCache, TokenBucket,
  paginationCost, pageByOffset, pageAfter, backoffDelay, simulateRetries,
} from '../src/engines.js';

test('index lookup stays tiny while a scan grows with the table', () => {
  const c = indexCost(5_000_000);
  assert.equal(c.scanRows, 5_000_000);
  assert.equal(c.indexReads, 4);
  assert.ok(c.scanMs / c.indexMs > 500);
  assert.equal(indexCost(1).indexReads, 2);
});

test('binary search finds the target in at most log2(n)+1 probes', () => {
  const arr = Array.from({ length: 64 }, (_, i) => i * 3);
  for (const target of arr) {
    const steps = binarySearchSteps(arr, target);
    assert.ok(steps.length <= 7);
    assert.equal(arr[steps.at(-1)], target);
  }
});

test('payments: no key charges twice, a key replays, a changed body is rejected', () => {
  const a = { charges: [], keys: new Map() };
  handlePayment(a, { amount: 49 }); handlePayment(a, { amount: 49 });
  assert.equal(a.charges.length, 2);

  const b = { charges: [], keys: new Map() };
  const first = handlePayment(b, { key: 'k1', amount: 49 });
  const second = handlePayment(b, { key: 'k1', amount: 49 });
  assert.equal(b.charges.length, 1);
  assert.equal(second.charge, first.charge);
  assert.equal(second.replayed, true);
  assert.equal(handlePayment(b, { key: 'k1', amount: 99 }).status, 422);
});

test('pool: per-request connections hit the limit, a pool queues instead', () => {
  const raw = simulatePool({ requests: 300, pooled: false });
  assert.equal(raw.failed, 200);
  assert.equal(raw.avgMs, 30);
  const pooled = simulatePool({ requests: 300, pooled: true, poolSize: 20 });
  assert.equal(pooled.failed, 0);
  assert.equal(pooled.connections, 20);
  assert.ok(pooled.avgMs > 5);
  const tiny = simulatePool({ requests: 300, pooled: true, poolSize: 1 });
  assert.ok(tiny.failed > 0, 'a pool of one times out waiting requests');
  const over = simulatePool({ requests: 10, pooled: true, poolSize: 50, instances: 4 });
  assert.equal(over.refusedConnections, 100);
});

test('TTL cache expires entries', () => {
  const c = new TTLCache();
  c.set('p', 10, 1000, 0);
  assert.equal(c.get('p', 999), 10);
  assert.equal(c.remainingMs('p', 400), 600);
  assert.equal(c.get('p', 1000), undefined);
});

test('token bucket allows a burst, then refills at the set rate', () => {
  const b = new TokenBucket(5, 2, 0);
  for (let i = 0; i < 5; i++) assert.equal(b.take(0).ok, true);
  const denied = b.take(0);
  assert.equal(denied.ok, false);
  assert.equal(denied.retryAfterMs, 500);
  assert.equal(b.take(500).ok, true);
  b.refill(60_000);
  assert.equal(b.tokens, 5, 'never exceeds capacity');
});

test('pagination: offset cost grows with depth, cursor cost does not', () => {
  assert.equal(paginationCost({ offset: 100000, limit: 20, mode: 'offset' }).rowsRead, 100020);
  assert.equal(paginationCost({ offset: 100000, limit: 20, mode: 'cursor' }).rowsRead, 20);
});

test('pagination: a new row duplicates under offset but not under a cursor', () => {
  let list = [5, 4, 3, 2, 1].map((id) => ({ id }));
  const p1 = pageByOffset(list, 0, 2);
  list = [{ id: 6 }, ...list];
  assert.deepEqual(pageByOffset(list, 2, 2).map((r) => r.id), [4, 3]); // 4 shown twice
  assert.deepEqual(pageAfter(list, p1.at(-1).id, 2).map((r) => r.id), [3, 2]);
});

test('backoff strategies', () => {
  assert.equal(backoffDelay(3, { strategy: 'fixed' }), 100);
  assert.equal(backoffDelay(3, { strategy: 'exp' }), 800);
  assert.equal(backoffDelay(10, { strategy: 'exp' }), 4000);
  assert.equal(backoffDelay(3, { strategy: 'jitter' }, () => 0.5), 400);
});

test('retries: backoff cuts load, jitter breaks up the synchronized waves', () => {
  const run = (strategy) => simulateRetries({ clients: 200, strategy });
  const fixed = run('fixed'), exp = run('exp'), jitter = run('jitter');
  assert.ok(exp.total < fixed.total / 3);
  assert.equal(exp.peakRetryWave, 200, 'plain backoff keeps every client in step');
  assert.ok(jitter.peakRetryWave < 100);
});
