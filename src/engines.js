// Pure simulation logic. No DOM here, so everything in this file is unit tested.

/** Small seeded random number generator so simulations are repeatable. */
export function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- Lesson 1: indexes ---------- */

/** Cost of finding one row by value: reading every row vs walking a B-tree. */
export function indexCost(rows, fanout = 200) {
  const depth = Math.max(1, Math.ceil(Math.log(rows) / Math.log(fanout)));
  const indexReads = depth + 1; // tree levels, plus one read for the row itself
  return { scanRows: rows, scanMs: rows / 2500, indexReads, indexMs: indexReads * 0.5 };
}

/** Positions probed by a binary search over a sorted array. */
export function binarySearchSteps(sorted, target) {
  const steps = [];
  let lo = 0, hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    steps.push(mid);
    if (sorted[mid] === target) break;
    if (sorted[mid] < target) lo = mid + 1; else hi = mid - 1;
  }
  return steps;
}

/* ---------- Lesson 3: idempotency ---------- */

/** A payment endpoint. With a key, a repeated request returns the stored result. */
export function handlePayment(state, { key, amount }) {
  if (key) {
    const prev = state.keys.get(key);
    if (prev) {
      if (prev.amount !== amount) return { status: 422, error: 'Idempotency key reused with a different request body' };
      return { ...prev.response, replayed: true };
    }
  }
  const charge = { id: 'ch_' + (state.charges.length + 1), amount };
  state.charges.push(charge);
  const response = { status: 201, charge: charge.id };
  if (key) state.keys.set(key, { amount, response });
  return response;
}

/* ---------- Lesson 4: connection pooling ---------- */

export function simulatePool({ requests, pooled, poolSize = 10, instances = 1, maxConn = 100, connectMs = 25, queryMs = 5, poolTimeoutMs = 200 }) {
  if (!pooled) {
    const ok = Math.min(requests, maxConn);
    return { ok, failed: requests - ok, avgMs: connectMs + queryMs, maxMs: connectMs + queryMs, connections: ok, refusedConnections: 0 };
  }
  const wanted = poolSize * instances;
  const usable = Math.min(wanted, maxConn);
  let ok = 0, failed = 0, total = 0, maxMs = 0;
  for (let i = 0; i < requests; i++) {
    const wait = Math.floor(i / usable) * queryMs;
    if (wait > poolTimeoutMs) { failed++; continue; }
    const latency = wait + queryMs;
    ok++; total += latency; maxMs = Math.max(maxMs, latency);
  }
  return { ok, failed, avgMs: ok ? total / ok : 0, maxMs, connections: usable, refusedConnections: wanted - usable };
}

/* ---------- Lesson 5: caching ---------- */

export class TTLCache {
  constructor() { this.map = new Map(); }
  set(key, value, ttlMs, now) { this.map.set(key, { value, expires: now + ttlMs }); }
  get(key, now) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (now >= hit.expires) { this.map.delete(key); return undefined; }
    return hit.value;
  }
  remainingMs(key, now) {
    const hit = this.map.get(key);
    return hit ? Math.max(0, hit.expires - now) : 0;
  }
  delete(key) { this.map.delete(key); }
}

/* ---------- Lesson 7: rate limiting ---------- */

export class TokenBucket {
  constructor(capacity, refillPerSec, now = 0) {
    this.capacity = capacity; this.rate = refillPerSec; this.tokens = capacity; this.last = now;
  }
  refill(now) {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
  }
  take(now) {
    this.refill(now);
    if (this.tokens >= 1) { this.tokens -= 1; return { ok: true, remaining: Math.floor(this.tokens) }; }
    return { ok: false, retryAfterMs: Math.ceil(((1 - this.tokens) / this.rate) * 1000) };
  }
}

/* ---------- Lesson 9: pagination ---------- */

export function paginationCost({ offset, limit, mode }) {
  const rowsRead = mode === 'offset' ? offset + limit : limit;
  return { rowsRead, ms: 1 + rowsRead / 500 };
}

/** Lists are newest first (highest id first). */
export const pageByOffset = (list, offset, size) => list.slice(offset, offset + size);
export const pageAfter = (list, cursorId, size) =>
  list.filter((row) => cursorId == null || row.id < cursorId).slice(0, size);

/* ---------- Lesson 10: timeouts and retries ---------- */

export function backoffDelay(attempt, { base = 100, cap = 4000, strategy }, rnd = Math.random) {
  if (strategy === 'fixed') return base;
  const exp = Math.min(cap, base * 2 ** attempt);
  return strategy === 'jitter' ? rnd() * exp : exp;
}

/** Every client fails at t=0 when the service goes down, then retries until it is back. */
export function simulateRetries({ clients, strategy, base = 100, cap = 4000, outageMs = 3000, horizonMs = 8000, bucketMs = 100, seed = 1 }) {
  const rnd = mulberry32(seed);
  const buckets = new Array(Math.ceil(horizonMs / bucketMs)).fill(0);
  let total = 0;
  for (let c = 0; c < clients; c++) {
    let t = 0, attempt = 0;
    while (t < horizonMs) {
      buckets[Math.floor(t / bucketMs)]++;
      total++;
      if (t >= outageMs) break; // service is back: this request succeeds
      t += Math.max(1, backoffDelay(attempt++, { base, cap, strategy }, rnd));
    }
  }
  const recoveryBucket = Math.floor(outageMs / bucketMs);
  return { buckets, total, peakRetryWave: Math.max(...buckets.slice(5)) /* largest 100 ms wave after the first half second */, peakAtRecovery: Math.max(...buckets.slice(recoveryBucket)) };
}
