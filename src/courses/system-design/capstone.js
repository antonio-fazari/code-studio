// System Design capstone: an end-to-end walkthrough, a capacity estimator, and a design review checklist.
import { slider, bindSlider, stats } from '../../ui.js';
import { capacityEstimate } from '../../engines-sd.js';

const path = [
  ['DNS', 'Latency-based DNS sends a shopper in Frankfurt to the EU region.', ['sd-dns']],
  ['CDN edge', 'Images, scripts and styles come from an edge server in Frankfurt. The request for the cart goes on to the origin over a warm connection.', ['sd-cdn']],
  ['Load balancer', 'The regional balancer picks the API instance with the fewest requests in flight among those passing health checks.', ['sd-load-balancing']],
  ['API fleet', 'A stateless instance from an autoscaled group handles the request. The session lives in Redis.', ['sd-scaling', 'sd-rate-limiting']],
  ['Cache', 'Product data comes from the Redis cluster, spread over nodes on a hash ring.', ['sd-caching', 'sd-consistent-hashing']],
  ['Checkout saga', 'Checkout orchestrates Inventory, Payments and Shipping, each a service with its own database, with compensations if a step fails.', ['sd-microservices', 'sd-transactions']],
  ['Data', 'Orders are written to the customer\'s shard leader, replicated to followers, with failover decided by consensus. Stock for limited items is consistency-first; the cart is a CRDT.', ['sd-sql-nosql', 'sd-indexing', 'sd-sharding', 'sd-replication', 'sd-cap', 'sd-eventual', 'sd-consensus']],
  ['Events', 'order.created goes to a partitioned topic keyed by order id. Shipping, Email and Analytics consume it in their own groups, deduplicating by message id.', ['sd-queues', 'sd-idempotency']],
  ['Protection', 'Calls to recommendations and reviews sit behind circuit breakers with cached fallbacks.', ['sd-circuit-breakers']],
  ['Visibility', 'Every hop above is a span in one trace, and checkout success is measured against a 99.9% SLO.', ['sd-observability']],
];

const tasks = [
  ['sd-t-1', 'sd-dns', 'Records live with a managed DNS provider, the TTL is 300 s or less, and the migration runbook lowers it first.'],
  ['sd-t-2', 'sd-cdn', 'Static assets have hashed names and a one-year cache. Personal responses are marked private.'],
  ['sd-t-3', 'sd-scaling', 'API servers are stateless: killing any instance loses no session or data.'],
  ['sd-t-4', 'sd-load-balancing', 'The load balancer uses health checks and draining, and a deploy drops no requests.'],
  ['sd-t-5', 'sd-caching', 'The database survives a cold cache: tested by flushing it under load.'],
  ['sd-t-6', 'sd-rate-limiting', 'Rate limits are shared across instances and fail open when the counter store is down.'],
  ['sd-t-7', 'sd-sql-nosql', 'Each data store is chosen from written-down access patterns.'],
  ['sd-t-8', 'sd-indexing', 'Hot queries have covering or composite indexes; write-heavy data sits in a store built for writes.'],
  ['sd-t-9', 'sd-transactions', 'Every multi-service workflow is a saga with tested, idempotent compensations.'],
  ['sd-t-10', 'sd-replication', 'Reads that must be current go to the leader; replication lag is alerted on.'],
  ['sd-t-11', 'sd-sharding', 'The shard key keeps the main queries on one shard, with logical shards for rebalancing.'],
  ['sd-t-12', 'sd-consistent-hashing', 'Adding a cache node moves about 1/N of keys, verified in a test.'],
  ['sd-t-13', 'sd-cap', 'Each kind of data has a written partition behaviour: refuse, or accept and merge.'],
  ['sd-t-14', 'sd-eventual', 'Replicated data that accepts concurrent writes has a merge rule that loses nothing.'],
  ['sd-t-15', 'sd-consensus', 'Leader election and failover run through a consensus store, never a ping script.'],
  ['sd-t-16', 'sd-microservices', 'Services own their data, and no user action depends on a long synchronous chain.'],
  ['sd-t-17', 'sd-queues', 'Events that need order share a key; consumer lag is alerted on.'],
  ['sd-t-18', 'sd-idempotency', 'Replaying a whole topic into any consumer changes nothing.'],
  ['sd-t-19', 'sd-circuit-breakers', 'Each optional dependency has a breaker, a short timeout and a tested fallback.'],
  ['sd-t-20', 'sd-observability', 'Traces cross every service and queue, and alerts fire on SLO burn rate.'],
];

const presets = [
  ['ShopLite today', { dau: 2_000_000, req: 40, peak: 4, write: 0.05, bytes: 2000 }],
  ['A national news site', { dau: 10_000_000, req: 15, peak: 6, write: 0.001, bytes: 5000 }],
  ['A chat app', { dau: 50_000_000, req: 120, peak: 3, write: 0.4, bytes: 300 }],
];

const fmtNum = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' M' : n >= 1e3 ? (n / 1e3).toFixed(1) + ' k' : Math.round(n).toString());
const fmtBytes = (b) => (b >= 1e15 ? (b / 1e15).toFixed(1) + ' PB' : b >= 1e12 ? (b / 1e12).toFixed(1) + ' TB' : b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(0) + ' MB');

export function renderCapstone(el, { lessons, store }) {
  const byId = Object.fromEntries(lessons.map((l, i) => [l.id, { ...l, n: i + 1 }]));
  const chip = (id) => `<a class="chip" href="#${id}">${byId[id].n}. ${byId[id].title}</a>`;
  const done = store.completedCount(lessons);
  el.innerHTML = `
    <header class="lesson-head">
      <p class="eyebrow">System Design · Capstone</p>
      <h1>Design ShopLite for the world</h1>
      <p class="hook">Put all twenty concepts to work on one system, from a rough size estimate to a design review.</p>
    </header>
    <p>A system design, in an interview or in a real design document, follows the same steps: pin down the requirements, estimate the size, sketch the path of a request, then go deep on the parts most likely to fail and say what you are trading away. This page walks through those steps for ShopLite.</p>
    ${done < lessons.length ? `<p class="callout">You have completed ${done} of ${lessons.length} lessons. You can use this page now; it will make more sense once the rest are done.</p>` : ''}

    <section>
      <h2>1. Requirements</h2>
      <ul>
        <li><strong>Functional:</strong> browse and search products, keep a cart across devices, check out and pay, track orders, receive emails.</li>
        <li><strong>Non-functional:</strong> customers on three continents; product pages under 300 ms at p99 everywhere; checkout 99.9% successful within 500 ms; no overselling of limited items; no lost or duplicated orders or payments; survive the loss of a whole region.</li>
      </ul>
      <p>The non-functional list is where design decisions come from. Write it down before drawing anything.</p>
    </section>

    <section>
      <h2>2. Estimate the size</h2>
      <p>Back-of-the-envelope numbers decide whether you need one database or forty. Start from users and work down. Pick a preset or change the inputs.</p>
      <div class="controls" id="cap-presets">${presets.map(([n], i) => `<button class="btn ghost" data-p="${i}">${n}</button>`).join('')}</div>
      ${slider('ce-dau', 'Daily active users:', 4, 8, 6.3, 0.1)}
      ${slider('ce-req', 'Requests per user per day:', 1, 200, 40)}
      ${slider('ce-peak', 'Peak traffic vs the daily average:', 1, 10, 4)}
      ${slider('ce-write', 'Share of requests that write:', 0, 50, 5, 0.5)}
      ${slider('ce-bytes', 'Bytes stored per write:', 100, 10000, 2000, 100)}
      <div class="stats" id="ce-out"></div>
      <p class="sim-note">Assumes about 500 requests per second per API server with 30% headroom, and 3 copies of all data. Real numbers come from load tests; these tell you the order of magnitude.</p>
    </section>

    <section>
      <h2>3. One request, end to end</h2>
      <p>A shopper in Frankfurt opens their cart and checks out. Every step uses something from this course.</p>
      <ol class="flow">
        ${path.map(([name, text, ids]) => `<li><div class="flow-name">${name}</div><div class="flow-body"><p>${text}</p><div class="chips">${ids.map(chip).join('')}</div></div></li>`).join('')}
      </ol>
    </section>

    <section>
      <h2>4. Go deep where it can fail</h2>
      <p>For each component, ask: what happens when it is slow, when it is down, when the network to it splits, and when traffic doubles? Good answers name a mechanism from the course and its cost. For example: "If the EU region loses contact with the US, limited-stock items stop selling in the EU (consistency-first), and carts keep working and merge later (availability-first)."</p>
    </section>

    <section>
      <h2>5. Design review checklist</h2>
      <p>Use this against ShopLite, or against a system you work on. Tick each item when you can show it holds. Your ticks are saved with your progress.</p>
      <ul class="tasks" id="sd-tasks">
        ${tasks.map(([id, lesson, text]) => `<li><label class="check" for="${id}"><input type="checkbox" id="${id}" ${store.state.tasks[id] ? 'checked' : ''}><span><b>${byId[lesson].title}.</b> ${text}</span></label></li>`).join('')}
      </ul>
      <p class="sim-note" id="sd-tasks-count" role="status"></p>
    </section>`;

  const $ = (id) => el.querySelector(id);
  const get = {};
  const calc = () => {
    if (Object.keys(get).length < 5) return;
    const c = capacityEstimate({ dau: 10 ** get.dau(), reqPerUser: get.req(), peakFactor: get.peak(), writeShare: get.write() / 100, bytesPerWrite: get.bytes() });
    // Enough shards for 3 years of data at 2 TB per copy per shard, and for peak writes at 5,000 per second per shard.
    const shards = Math.max(1, Math.ceil(Math.max(c.storagePerYear / 2e12, (c.writeRps * get.peak()) / 5000)));
    stats($('#ce-out'), [
      ['Average requests per second', fmtNum(c.avgRps)],
      ['Peak requests per second', fmtNum(c.peakRps)],
      ['Writes per second (average)', fmtNum(c.writeRps)],
      ['New storage per year, 3 copies', fmtBytes(c.storagePerYear)],
      ['API servers at peak', c.servers],
      ['Database shards for 3 years', shards, shards > 1 ? 'warn' : 'ok'],
    ]);
  };
  get.dau = bindSlider(el, 'ce-dau', (v) => fmtNum(10 ** v), calc);
  get.req = bindSlider(el, 'ce-req', String, calc);
  get.peak = bindSlider(el, 'ce-peak', (v) => v + '×', calc);
  get.write = bindSlider(el, 'ce-write', (v) => v + '%', calc);
  get.bytes = bindSlider(el, 'ce-bytes', (v) => fmtNum(v) + ' B', calc);
  calc();
  $('#cap-presets').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const p = presets[+b.dataset.p][1];
    const set = (id, v) => { const i = $('#' + id); i.value = v; i.dispatchEvent(new Event('input')); };
    set('ce-dau', Math.log10(p.dau)); set('ce-req', p.req); set('ce-peak', p.peak); set('ce-write', p.write * 100); set('ce-bytes', p.bytes);
  };
  const count = () => {
    const n = tasks.filter(([id]) => store.state.tasks[id]).length;
    $('#sd-tasks-count').textContent = n === tasks.length ? 'All 20 hold. That is a system ready for the world.' : `${n} of ${tasks.length} done.`;
  };
  $('#sd-tasks').addEventListener('change', (e) => { if (e.target.matches('input')) { store.toggleTask(e.target.id); count(); } });
  count();
}
