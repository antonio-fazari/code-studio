// Pure simulation logic for the System Design course. No DOM here; everything is unit tested.
import { mulberry32 } from './engines.js';

/** 32-bit string hash (FNV-1a with a final avalanche step so similar strings spread out). */
export function hash32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);

/* ---------- 1. DNS ---------- */

/** Share of resolvers still serving the old record, if caches were filled at uniformly random times. */
export const dnsStaleShare = (secondsSinceChange, ttl) => (ttl <= 0 ? 0 : Math.max(0, 1 - secondsSinceChange / ttl));
/** Queries per second reaching the authoritative nameserver from a population of resolvers. */
export const dnsQueryLoad = (resolvers, ttl) => resolvers / Math.max(1, ttl);

/* ---------- 2. CDN ---------- */

/** Expected time for one asset request. A miss at the edge pays the trip to the origin as well. */
export const cdnRequestMs = ({ edgeRtt, originRtt, cdn, hitRatio }) => (cdn ? edgeRtt + (1 - hitRatio) * originRtt : originRtt);

/* ---------- 3. Horizontal scaling ---------- */

export function simulateAutoscale({ traffic, perServer = 100, min = 2, max = 20, target = 0.7, bootSteps = 2, autoscale = true, fixed = 4 }) {
  const minAt = typeof min === 'function' ? min : () => min; // a function allows scheduled scaling
  let servers = autoscale ? minAt(0) : fixed;
  const pending = []; // [readyAtStep, count]
  return traffic.map((load, t) => {
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i][0] <= t) { servers += pending[i][1]; pending.splice(i, 1); }
    const capacity = servers * perServer;
    const row = { t, load, servers, capacity, dropped: Math.max(0, load - capacity), removed: 0 };
    if (autoscale) {
      const booting = pending.reduce((a, p) => a + p[1], 0);
      const want = Math.min(max, Math.max(minAt(t), Math.ceil(load / (perServer * target))));
      if (want > servers + booting) pending.push([t + bootSteps, want - servers - booting]);
      else if (want < servers && booting === 0) { row.removed = servers - want; servers = want; }
    }
    return row;
  });
}

/* ---------- 4. Load balancing ---------- */

/** Each server is one worker with a queue. servers: [{ name, ms, down }]. */
export function simulateLB({ algo, servers, requests = 400, gapMs = 5, seed = 1, healthChecks = true }) {
  const rnd = mulberry32(seed);
  const st = servers.map((s) => ({ ...s, freeAt: 0, done: [], count: 0, failed: 0, out: false }));
  const lat = [];
  let failed = 0, rr = 0;
  for (let i = 0; i < requests; i++) {
    const t = i * gapMs;
    const pool = st.filter((s) => !s.out);
    let s;
    if (algo === 'rr') s = pool[rr++ % pool.length];
    else if (algo === 'random') s = pool[Math.floor(rnd() * pool.length)];
    else {
      const load = (x) => x.done.filter((d) => d > t).length;
      s = pool.reduce((a, b) => (load(b) < load(a) ? b : a));
    }
    s.count++;
    if (s.down) {
      failed++; s.failed++;
      if (healthChecks && s.failed >= 3) s.out = true; // health check marks it unhealthy
      continue;
    }
    const start = Math.max(t, s.freeAt);
    s.freeAt = start + s.ms * (0.5 + rnd());
    s.done.push(s.freeAt);
    lat.push(s.freeAt - t);
  }
  lat.sort((a, b) => a - b);
  return { perServer: st.map(({ name, count, failed: f, out }) => ({ name, count, failed: f, out })), p50: pct(lat, 0.5), p99: pct(lat, 0.99), failed };
}

/* ---------- 5. Caching at scale ---------- */

export class LRUCache {
  constructor(capacity) { this.capacity = capacity; this.map = new Map(); }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k); this.map.set(k, v);
    return v;
  }
  set(k, v) {
    this.map.delete(k); this.map.set(k, v);
    if (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value);
  }
}

/** Returns a function that draws item indexes where item i has weight 1 / (i+1)^skew. */
export function zipfSampler(n, skew, rnd) {
  const w = Array.from({ length: n }, (_, i) => 1 / (i + 1) ** skew);
  const total = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  const cdf = w.map((x) => (acc += x / total));
  return () => {
    const r = rnd();
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < r) lo = m + 1; else hi = m; }
    return lo;
  };
}

export function simulateCache({ size, items = 10000, skew = 1, requests = 6000, seed = 1, bucket = 300 }) {
  const rnd = mulberry32(seed), next = zipfSampler(items, skew, rnd), cache = new LRUCache(size);
  let hits = 0, bucketHits = 0;
  const series = [];
  for (let i = 1; i <= requests; i++) {
    const k = next();
    if (cache.get(k) !== undefined) { hits++; bucketHits++; } else cache.set(k, true);
    if (i % bucket === 0) { series.push(bucketHits / bucket); bucketHits = 0; }
  }
  return { hitRatio: hits / requests, series };
}

/* ---------- 6. Rate limiting at scale ---------- */

export class FixedWindow {
  constructor(limit, windowMs) { this.limit = limit; this.windowMs = windowMs; this.w = null; this.count = 0; }
  allow(t) {
    const w = Math.floor(t / this.windowMs);
    if (w !== this.w) { this.w = w; this.count = 0; }
    if (this.count < this.limit) { this.count++; return true; }
    return false;
  }
}

export class SlidingLog {
  constructor(limit, windowMs) { this.limit = limit; this.windowMs = windowMs; this.log = []; }
  allow(t) {
    this.log = this.log.filter((x) => x > t - this.windowMs);
    if (this.log.length < this.limit) { this.log.push(t); return true; }
    return false;
  }
}

/** Two counters: the previous window, weighted by how much of it still overlaps, plus the current one. */
export class SlidingCounter {
  constructor(limit, windowMs) { this.limit = limit; this.windowMs = windowMs; this.w = null; this.count = 0; this.prev = 0; }
  allow(t) {
    const w = Math.floor(t / this.windowMs);
    if (w !== this.w) { this.prev = this.w !== null && w === this.w + 1 ? this.count : 0; this.w = w; this.count = 0; }
    const elapsed = (t - w * this.windowMs) / this.windowMs;
    if (this.prev * (1 - elapsed) + this.count < this.limit) { this.count++; return true; }
    return false;
  }
}

/* ---------- 8. Indexing in depth: LSM tree ---------- */

const byKey = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

export class LSMTree {
  constructor({ memtableLimit = 4, compactAt = 4 } = {}) {
    this.limit = memtableLimit; this.compactAt = compactAt;
    this.memtable = new Map(); this.tables = []; // newest table first
    this.puts = 0; this.diskWrites = 0; this.compactions = 0;
  }
  put(k, v) { this.puts++; this.memtable.set(k, v); if (this.memtable.size >= this.limit) this.flush(); }
  flush() {
    if (!this.memtable.size) return;
    const t = new Map([...this.memtable].sort(byKey));
    this.tables.unshift(t);
    this.diskWrites += t.size;
    this.memtable = new Map();
    if (this.tables.length >= this.compactAt) this.compact();
  }
  compact() {
    const merged = new Map();
    for (const t of [...this.tables].reverse()) for (const [k, v] of t) merged.set(k, v); // newer values win
    this.tables = [new Map([...merged].sort(byKey))];
    this.diskWrites += merged.size;
    this.compactions++;
  }
  /** bloom: skip tables that certainly lack the key (a perfect filter, for teaching). */
  get(k, { bloom = false } = {}) {
    if (this.memtable.has(k)) return { value: this.memtable.get(k), checked: 0 };
    let checked = 0;
    for (const t of this.tables) {
      if (bloom && !t.has(k)) continue;
      checked++;
      if (t.has(k)) return { value: t.get(k), checked };
    }
    return { value: undefined, checked };
  }
}

/* ---------- 9. Transactions across services ---------- */

/** steps: [{ name, undo }]. failAt: index of the step that fails, or -1. */
export function runSaga(steps, failAt) {
  const log = [], done = [];
  for (let i = 0; i < steps.length; i++) {
    if (i === failAt) {
      log.push({ type: 'fail', step: steps[i].name });
      for (const s of done.reverse()) log.push({ type: 'compensate', step: s.undo });
      return { ok: false, log };
    }
    log.push({ type: 'do', step: steps[i].name });
    done.push(steps[i]);
  }
  return { ok: true, log };
}

export function run2PC(participants, { voteNo = -1, coordinatorCrash = false } = {}) {
  const log = participants.map((p, i) => ({ type: i === voteNo ? 'vote-no' : 'vote-yes', step: p }));
  if (coordinatorCrash) {
    log.push({ type: 'crash' });
    participants.forEach((p, i) => { if (i !== voteNo) log.push({ type: 'blocked', step: p }); });
    return { outcome: 'blocked', log };
  }
  const commit = voteNo < 0;
  participants.forEach((p) => log.push({ type: commit ? 'commit' : 'abort', step: p }));
  return { outcome: commit ? 'committed' : 'aborted', log };
}

/* ---------- 10. Replication ---------- */

export class ReplicaSet {
  constructor({ followers = 2, lagMs = 1000, sync = false } = {}) {
    this.nodes = [{ name: 'leader', data: {} }, ...Array.from({ length: followers }, (_, i) => ({ name: 'follower-' + (i + 1), data: {} }))];
    this.lagMs = lagMs; this.sync = sync; this.pending = [];
  }
  write(key, value, t) {
    this.nodes[0].data[key] = value;
    for (const n of this.nodes.slice(1)) {
      if (this.sync) n.data[key] = value;
      else this.pending.push({ node: n, key, value, at: t + this.lagMs });
    }
    return { ackMs: this.sync ? this.lagMs : 0 };
  }
  tick(t) { this.pending = this.pending.filter((p) => (p.at <= t ? ((p.node.data[p.key] = p.value), false) : true)); }
  read(index, key, t) { this.tick(t); return this.nodes[index].data[key]; }
  /** The leader dies. Follower 1 is promoted; writes it had not received yet are lost. */
  failover(t) {
    this.tick(t);
    const promoted = this.nodes[1];
    const lost = this.pending.filter((p) => p.node === promoted).length;
    this.pending = [];
    this.nodes = [{ name: 'leader', data: { ...promoted.data } }, ...this.nodes.slice(2).map((n) => ({ name: n.name, data: { ...promoted.data } }))];
    return { lost };
  }
}

/* ---------- 11 and 12. Sharding and consistent hashing ---------- */

export const modShard = (key, n) => hash32(key) % n;

export function shardCounts(items, n, assign) {
  const counts = new Array(n).fill(0);
  for (const it of items) counts[assign(it)]++;
  return counts;
}

export class HashRing {
  constructor(vnodes = 1) { this.vnodes = vnodes; this.points = []; this.nodes = []; }
  add(node) {
    this.nodes.push(node);
    for (let i = 0; i < this.vnodes; i++) this.points.push({ pos: hash32(node + '#' + i), node });
    this.points.sort((a, b) => a.pos - b.pos);
  }
  remove(node) { this.nodes = this.nodes.filter((n) => n !== node); this.points = this.points.filter((p) => p.node !== node); }
  get(key) {
    if (!this.points.length) return null;
    const h = hash32(key);
    let lo = 0, hi = this.points.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.points[m].pos < h) lo = m + 1; else hi = m; }
    return this.points[lo % this.points.length].node; // first point clockwise, wrapping around
  }
}

export const movedShare = (keys, before, after) => keys.filter((k) => before(k) !== after(k)).length / keys.length;

/* ---------- 13. CAP ---------- */

/** Three replicas: two in the US, one in the EU. A partition cuts the EU off. */
export class Cluster {
  constructor({ mode = 'CP', stock = 1 } = {}) {
    this.mode = mode; this.initial = stock; this.partitioned = false;
    this.nodes = { 'us-1': { side: 'us' }, 'us-2': { side: 'us' }, 'eu-1': { side: 'eu' } };
    for (const n of Object.values(this.nodes)) Object.assign(n, { stock, orders: [] });
  }
  reachable(from) { return Object.keys(this.nodes).filter((n) => !this.partitioned || this.nodes[n].side === this.nodes[from].side); }
  hasQuorum(from) { return this.reachable(from).length * 2 > Object.keys(this.nodes).length; }
  read(from) {
    if (this.mode === 'CP' && !this.hasQuorum(from)) return { ok: false, error: 'no quorum' };
    return { ok: true, stock: this.nodes[from].stock };
  }
  buy(from, who) {
    if (this.mode === 'CP' && !this.hasQuorum(from)) return { ok: false, error: 'no quorum' };
    const node = this.nodes[from];
    if (node.stock < 1) return { ok: false, error: 'sold out' };
    for (const n of this.reachable(from)) { this.nodes[n].stock = node.stock - 1; this.nodes[n].orders = [...node.orders, who]; }
    return { ok: true };
  }
  heal() {
    this.partitioned = false;
    const orders = [...new Set(Object.values(this.nodes).flatMap((n) => n.orders))];
    for (const n of Object.values(this.nodes)) { n.orders = orders; n.stock = this.initial - orders.length; }
    return { orders, oversold: Math.max(0, orders.length - this.initial) };
  }
}

/* ---------- 14. Eventual consistency ---------- */

export const newCart = () => ({ adds: {}, removes: {}, ts: 0 });
export function cartAdd(c, item, tag, ts) { (c.adds[item] ??= []).push(tag); c.ts = ts; }
export function cartRemove(c, item, ts) { c.removes[item] = [...new Set([...(c.removes[item] || []), ...(c.adds[item] || [])])]; c.ts = ts; }
export const cartItems = (c) => Object.keys(c.adds).filter((i) => c.adds[i].some((t) => !(c.removes[i] || []).includes(t))).sort();
export const cloneCart = (c) => JSON.parse(JSON.stringify(c));

/** lww: newest whole cart wins. union: merge the adds and forget removals. orset: merge adds and removals. */
export function mergeCarts(a, b, strategy) {
  if (strategy === 'lww') return cloneCart(a.ts >= b.ts ? a : b);
  const m = newCart();
  m.ts = Math.max(a.ts, b.ts);
  const join = (field) => { for (const c of [a, b]) for (const [i, tags] of Object.entries(c[field])) m[field][i] = [...new Set([...(m[field][i] || []), ...tags])]; };
  join('adds');
  if (strategy === 'orset') join('removes');
  return m;
}

export const quorum = (n, r, w) => ({ overlap: r + w > n, writeTolerates: n - w, readTolerates: n - r });

/* ---------- 15. Consensus ---------- */

/** Simplified Raft leader election among the nodes that can still talk to each other. */
export function raftElection({ alive, total = 5, term = 1, seed = 1 }) {
  const rnd = mulberry32(seed);
  const majority = Math.floor(total / 2) + 1;
  const events = [];
  let t = 0;
  for (let round = 0; round < 4 && alive.length; round++) {
    const timeouts = alive.map((id) => ({ id, at: t + 150 + Math.floor(rnd() * 150) })).sort((a, b) => a.at - b.at);
    term++;
    const [first, second] = timeouts;
    if (second && second.at - first.at < 6) { // two candidates at once split the vote
      events.push({ t: first.at, type: 'split', nodes: [first.id, second.id], term });
      t = second.at + 20;
      continue;
    }
    events.push({ t: first.at, type: 'candidate', node: first.id, term });
    events.push({ t: first.at + 10, type: 'votes', node: first.id, votes: alive.length, needed: majority, term });
    if (alive.length >= majority) {
      events.push({ t: first.at + 12, type: 'leader', node: first.id, term });
      return { leader: first.id, term, events };
    }
    events.push({ t: first.at + 12, type: 'no-majority', node: first.id, term });
    t = first.at + 12;
  }
  return { leader: null, term, events };
}

export const canCommit = (acks, total) => acks >= Math.floor(total / 2) + 1;

/* ---------- 16. Microservices ---------- */

export const chainAvailability = (a, hops) => a ** hops;
export const monthlyDowntimeMin = (availability, days = 30) => (1 - availability) * days * 24 * 60;

/* ---------- 17. Message queues at scale ---------- */

export const assignPartitions = (partitions, consumers) => Array.from({ length: partitions }, (_, i) => (consumers ? i % consumers : -1));

/** Order events (created, paid, shipped) published to partitions and processed by a consumer group. */
export function simulateConsume({ orders = 16, partitions = 4, consumers = 2, keyed = true, seed = 1 }) {
  const rnd = mulberry32(seed);
  const types = ['created', 'paid', 'shipped'];
  // Each order's events are published a few ms apart, interleaved with other orders.
  const events = [];
  for (let o = 0; o < orders; o++) for (let seq = 0; seq < 3; seq++) events.push({ order: 1000 + o, type: types[seq], seq, at: o * 5 + seq * 7 });
  events.sort((a, b) => a.at - b.at || a.seq - b.seq);
  for (const e of events) e.partition = keyed ? hash32('order-' + e.order) % partitions : Math.floor(rnd() * partitions); // no key: any partition
  const owner = assignPartitions(partitions, consumers);
  const freeAt = new Array(consumers).fill(0);
  const processed = events.map((e) => {
    const c = owner[e.partition];
    const start = Math.max(e.at, freeAt[c]);
    freeAt[c] = start + (5 + rnd() * 30) * (c === 0 ? 2 : 1); // consumer 0 shares a busy host and runs at half speed
    return { ...e, consumer: c, done: freeAt[c] };
  });
  const byOrder = {};
  for (const e of processed) (byOrder[e.order] ??= [])[e.seq] = e.done;
  const outOfOrder = Object.values(byOrder).filter((d) => d[1] < d[0] || d[2] < d[1]).length;
  return { processed, outOfOrder, idle: Math.max(0, consumers - partitions), owner };
}

/* ---------- 18. Idempotency at scale ---------- */

/**
 * One message ("add 100 loyalty points"), redelivered if the offset was not committed.
 * mode: 'at-most-once' (commit, then act), 'at-least-once' (act, then commit),
 *       'dedupe' (act and record the message id in one transaction, then commit).
 */
export function runConsumer({ mode, crash }) {
  const db = { points: 0, seen: new Set() };
  const log = [];
  let committed = false;
  for (let attempt = 1; attempt <= 2 && !committed; attempt++) {
    log.push(['deliver', attempt]);
    const crashNow = crash && attempt === 1;
    if (mode === 'at-most-once') {
      committed = true; log.push(['commit', attempt]);
      if (crashNow) { log.push(['crash', attempt]); break; }
      db.points += 100; log.push(['effect', attempt]);
    } else {
      if (mode === 'dedupe' && db.seen.has('msg-1')) log.push(['skip', attempt]);
      else { db.points += 100; if (mode === 'dedupe') db.seen.add('msg-1'); log.push([mode === 'dedupe' ? 'effect+record' : 'effect', attempt]); }
      if (crashNow) { log.push(['crash', attempt]); continue; }
      committed = true; log.push(['commit', attempt]);
    }
  }
  return { points: db.points, log };
}

/* ---------- 19. Circuit breakers ---------- */

export class CircuitBreaker {
  constructor({ threshold = 5, openMs = 5000 } = {}) { this.threshold = threshold; this.openMs = openMs; this.state = 'closed'; this.failures = 0; this.openedAt = 0; }
  canRequest(now) {
    if (this.state === 'open' && now - this.openedAt >= this.openMs) this.state = 'half-open';
    return this.state !== 'open';
  }
  success() { this.failures = 0; this.state = 'closed'; }
  failure(now) {
    this.failures++;
    if (this.state === 'half-open' || this.failures >= this.threshold) { this.state = 'open'; this.openedAt = now; }
  }
}

/* ---------- 20. Observability at scale ---------- */

export const allowedDowntimeMin = (slo, days = 30) => (1 - slo) * days * 24 * 60;
/** Share of the month's error budget used by an incident. */
export function budgetUsed({ slo, requestsPerMonth, errorRate, minutes, days = 30 }) {
  const failed = (requestsPerMonth / (days * 24 * 60)) * minutes * errorRate;
  return failed / ((1 - slo) * requestsPerMonth);
}

/* ---------- Capstone ---------- */

export function capacityEstimate({ dau, reqPerUser, peakFactor, writeShare, bytesPerWrite, perServerRps = 500, replicas = 3, headroom = 1.3 }) {
  const avgRps = (dau * reqPerUser) / 86400;
  const peakRps = avgRps * peakFactor;
  const writeRps = avgRps * writeShare;
  const storagePerYear = writeRps * 86400 * 365 * bytesPerWrite * replicas;
  return { avgRps, peakRps, writeRps, storagePerYear, servers: Math.max(2, Math.ceil((peakRps / perServerRps) * headroom)) };
}
