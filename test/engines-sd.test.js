import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/engines-sd.js';

test('hash32 is stable and spreads keys evenly', () => {
  assert.equal(E.hash32('abc'), E.hash32('abc'));
  const counts = E.shardCounts(Array.from({ length: 8000 }, (_, i) => 'k' + i), 8, (k) => E.modShard(k, 8));
  for (const c of counts) assert.ok(c > 850 && c < 1150, `bucket ${c}`);
});

test('DNS: staleness falls with time, load falls with TTL', () => {
  assert.equal(E.dnsStaleShare(0, 3600), 1);
  assert.equal(E.dnsStaleShare(1800, 3600), 0.5);
  assert.equal(E.dnsStaleShare(7200, 3600), 0);
  assert.ok(E.dnsQueryLoad(100000, 60) > E.dnsQueryLoad(100000, 3600) * 50);
});

test('CDN: a hit is served from the edge, a miss pays the origin trip', () => {
  assert.equal(E.cdnRequestMs({ edgeRtt: 15, originRtt: 200, cdn: false, hitRatio: 0.9 }), 200);
  assert.equal(E.cdnRequestMs({ edgeRtt: 15, originRtt: 200, cdn: true, hitRatio: 1 }), 15);
  assert.equal(E.cdnRequestMs({ edgeRtt: 15, originRtt: 200, cdn: true, hitRatio: 0 }), 215);
});

test('autoscaling adds servers after a boot delay and drops traffic meanwhile', () => {
  const traffic = [100, 100, 900, 900, 900, 900, 100, 100];
  const rows = E.simulateAutoscale({ traffic, perServer: 100, min: 2, bootSteps: 2 });
  assert.ok(rows[2].dropped > 0);
  assert.equal(rows[5].dropped, 0);
  assert.ok(rows.some((r) => r.removed > 0));
  const fixed = E.simulateAutoscale({ traffic, autoscale: false, fixed: 4 });
  assert.ok(fixed.every((r) => r.servers === 4));
});

test('load balancing: round robin suffers from a slow server, least connections adapts', () => {
  const servers = [{ name: 'a', ms: 10 }, { name: 'b', ms: 10 }, { name: 'c', ms: 50 }];
  const rr = E.simulateLB({ algo: 'rr', servers });
  const lc = E.simulateLB({ algo: 'least', servers });
  assert.ok(lc.p99 < rr.p99 / 3, `${lc.p99} vs ${rr.p99}`);
  assert.ok(lc.perServer[2].count < rr.perServer[2].count);
});

test('load balancing: health checks take a dead server out', () => {
  const servers = [{ name: 'a', ms: 10 }, { name: 'b', ms: 10 }, { name: 'c', ms: 10, down: true }];
  assert.equal(E.simulateLB({ algo: 'rr', servers, healthChecks: true }).failed, 3);
  assert.ok(E.simulateLB({ algo: 'rr', servers, healthChecks: false }).failed > 100);
});

test('LRU evicts the least recently used item', () => {
  const c = new E.LRUCache(2);
  c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3);
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('a'), 1);
});

test('cache: bigger cache and more skew mean more hits; a cold cache starts at zero', () => {
  const small = E.simulateCache({ size: 100 }), big = E.simulateCache({ size: 2000 });
  assert.ok(big.hitRatio > small.hitRatio);
  assert.ok(E.simulateCache({ size: 500, skew: 1.2 }).hitRatio > E.simulateCache({ size: 500, skew: 0.6 }).hitRatio);
  assert.ok(big.series[0] < big.series.at(-1));
});

test('rate limits: a fixed window lets a boundary burst through twice', () => {
  const burst = [...Array.from({ length: 10 }, (_, i) => 900 + i * 10), ...Array.from({ length: 10 }, (_, i) => 1010 + i * 10)];
  const run = (L) => burst.filter((t) => L.allow(t)).length;
  assert.equal(run(new E.FixedWindow(10, 1000)), 20);
  assert.equal(run(new E.SlidingLog(10, 1000)), 10);
  assert.ok(run(new E.SlidingCounter(10, 1000)) <= 11);
});

test('LSM tree: flushes, compacts, and newer values win', () => {
  const t = new E.LSMTree({ memtableLimit: 2, compactAt: 3 });
  t.put('a', 1); t.put('b', 1); t.put('a', 2); t.put('c', 1);
  assert.equal(t.tables.length, 2);
  assert.equal(t.get('a').value, 2);
  t.put('d', 1); t.put('e', 1);
  assert.equal(t.tables.length, 1);
  assert.equal(t.compactions, 1);
  assert.equal(t.get('a').value, 2);
  assert.ok(t.diskWrites > t.puts);
});

test('LSM tree: bloom filters skip tables', () => {
  const t = new E.LSMTree({ memtableLimit: 1, compactAt: 99 });
  ['a', 'b', 'c', 'd'].forEach((k) => t.put(k, 1));
  assert.equal(t.get('a').checked, 4);
  assert.equal(t.get('a', { bloom: true }).checked, 1);
});

test('saga compensates completed steps in reverse', () => {
  const steps = [{ name: 'reserve', undo: 'release' }, { name: 'charge', undo: 'refund' }, { name: 'ship', undo: 'cancel' }];
  assert.deepEqual(E.runSaga(steps, 2).log.map((e) => e.step), ['reserve', 'charge', 'ship', 'refund', 'release']);
  assert.equal(E.runSaga(steps, -1).ok, true);
});

test('two-phase commit aborts on a no vote and blocks on coordinator crash', () => {
  assert.equal(E.run2PC(['a', 'b']).outcome, 'committed');
  assert.equal(E.run2PC(['a', 'b'], { voteNo: 1 }).outcome, 'aborted');
  assert.equal(E.run2PC(['a', 'b'], { coordinatorCrash: true }).outcome, 'blocked');
});

test('replication: followers lag, sync does not, failover loses unreplicated writes', () => {
  const r = new E.ReplicaSet({ lagMs: 1000 });
  r.write('addr', 'new', 0);
  assert.equal(r.read(1, 'addr', 500), undefined);
  assert.equal(r.read(1, 'addr', 1000), 'new');
  const s = new E.ReplicaSet({ lagMs: 1000, sync: true });
  assert.equal(s.write('addr', 'new', 0).ackMs, 1000);
  assert.equal(s.read(2, 'addr', 0), 'new');
  const f = new E.ReplicaSet({ lagMs: 1000 });
  f.write('a', 1, 0); f.write('b', 1, 900);
  assert.equal(f.failover(1200).lost, 1);
  assert.equal(f.read(0, 'b', 1200), undefined);
});

test('consistent hashing moves far fewer keys than mod N when a node joins', () => {
  const keys = Array.from({ length: 5000 }, (_, i) => 'user:' + i);
  const modMoved = E.movedShare(keys, (k) => E.modShard(k, 4), (k) => E.modShard(k, 5));
  const before = new E.HashRing(100), after = new E.HashRing(100);
  ['a', 'b', 'c', 'd'].forEach((n) => { before.add(n); after.add(n); });
  after.add('e');
  const ringMoved = E.movedShare(keys, (k) => before.get(k), (k) => after.get(k));
  assert.ok(modMoved > 0.7, `mod moved ${modMoved}`);
  assert.ok(ringMoved > 0.1 && ringMoved < 0.3, `ring moved ${ringMoved}`);
  assert.ok(keys.filter((k) => before.get(k) !== after.get(k)).every((k) => after.get(k) === 'e'));
});

test('CAP: CP refuses on the minority side, AP oversells', () => {
  const cp = new E.Cluster({ mode: 'CP' });
  cp.partitioned = true;
  assert.equal(cp.buy('eu-1', 'Lea').ok, false);
  assert.equal(cp.buy('us-1', 'Sam').ok, true);
  assert.equal(cp.heal().oversold, 0);
  const ap = new E.Cluster({ mode: 'AP' });
  ap.partitioned = true;
  assert.equal(ap.buy('eu-1', 'Lea').ok, true);
  assert.equal(ap.buy('us-1', 'Sam').ok, true);
  assert.equal(ap.heal().oversold, 1);
});

test('carts: LWW loses a change, union resurrects a removal, OR-set keeps both right', () => {
  const base = E.newCart(); E.cartAdd(base, 'hat', 't1', 1);
  const phone = E.cloneCart(base), laptop = E.cloneCart(base);
  E.cartAdd(phone, 'shoes', 't2', 2);
  E.cartRemove(laptop, 'hat', 3); E.cartAdd(laptop, 'socks', 't3', 3);
  assert.deepEqual(E.cartItems(E.mergeCarts(phone, laptop, 'lww')), ['socks']);
  assert.deepEqual(E.cartItems(E.mergeCarts(phone, laptop, 'union')), ['hat', 'shoes', 'socks']);
  assert.deepEqual(E.cartItems(E.mergeCarts(phone, laptop, 'orset')), ['shoes', 'socks']);
  assert.equal(E.quorum(3, 2, 2).overlap, true);
  assert.equal(E.quorum(3, 1, 1).overlap, false);
});

test('raft: a majority elects a leader, a minority cannot', () => {
  const ok = E.raftElection({ alive: [1, 2, 3, 4] });
  assert.ok(ok.leader !== null);
  assert.ok(ok.term > 1);
  assert.equal(E.raftElection({ alive: [1, 2] }).leader, null);
  assert.equal(E.canCommit(3, 5), true);
  assert.equal(E.canCommit(2, 5), false);
});

test('availability compounds across hops', () => {
  assert.ok(Math.abs(E.chainAvailability(0.999, 10) - 0.990) < 0.001);
  assert.ok(Math.abs(E.monthlyDowntimeMin(0.999) - 43.2) < 0.01);
});

test('partitions: keyed events stay in order, unkeyed ones do not, extra consumers idle', () => {
  assert.equal(E.simulateConsume({ keyed: true, consumers: 4 }).outOfOrder, 0);
  assert.ok(E.simulateConsume({ keyed: false, consumers: 4 }).outOfOrder > 0);
  assert.equal(E.simulateConsume({ partitions: 4, consumers: 6 }).idle, 2);
});

test('consumers: at-most-once loses, at-least-once duplicates, dedupe is exact', () => {
  assert.equal(E.runConsumer({ mode: 'at-most-once', crash: true }).points, 0);
  assert.equal(E.runConsumer({ mode: 'at-least-once', crash: true }).points, 200);
  assert.equal(E.runConsumer({ mode: 'dedupe', crash: true }).points, 100);
  for (const mode of ['at-most-once', 'at-least-once', 'dedupe']) assert.equal(E.runConsumer({ mode, crash: false }).points, 100);
});

test('circuit breaker opens, waits, half-opens, and closes or reopens', () => {
  const b = new E.CircuitBreaker({ threshold: 3, openMs: 1000 });
  for (let i = 0; i < 3; i++) b.failure(0);
  assert.equal(b.state, 'open');
  assert.equal(b.canRequest(500), false);
  assert.equal(b.canRequest(1000), true);
  assert.equal(b.state, 'half-open');
  b.failure(1000);
  assert.equal(b.state, 'open');
  b.canRequest(2000); b.success();
  assert.equal(b.state, 'closed');
});

test('error budgets and capacity estimates', () => {
  assert.ok(Math.abs(E.allowedDowntimeMin(0.999) - 43.2) < 0.01);
  assert.ok(Math.abs(E.budgetUsed({ slo: 0.999, requestsPerMonth: 43_200_000, errorRate: 1, minutes: 43.2 }) - 1) < 1e-9);
  const c = E.capacityEstimate({ dau: 1_000_000, reqPerUser: 50, peakFactor: 3, writeShare: 0.1, bytesPerWrite: 1000 });
  assert.ok(Math.abs(c.avgRps - 578.7) < 0.1);
  assert.ok(c.peakRps > 1700);
  assert.equal(c.servers, 5);
});
