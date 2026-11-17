import { code, pill, slider, bindSlider, stats, log } from '../../ui.js';
import { simulateCache } from '../../engines-sd.js';

const writeModes = {
  aside: ['Cache-aside', 'App writes to the database and deletes the cache key. The next read reloads it.'],
  through: ['Write-through', 'App writes to the cache, and the cache layer writes to the database before confirming.'],
  back: ['Write-back', 'App writes to the cache and gets an immediate OK. The cache writes to the database later, in batches.'],
};

export default {
  id: 'sd-caching',
  part: 'Part 1: Getting traffic in',
  title: 'Caching at Scale',
  hook: 'Layers, eviction, cold starts and write strategies',
  incident: 'The Redis node was restarted for a routine upgrade. For four minutes the database received 20 times its normal load and checkout timed out.',
  revisits: { id: 'caching', note: 'That lesson put one Redis in front of slow queries with cache-aside and TTLs. Here the cache is a cluster that the whole fleet depends on.' },
  buildsOn: 'Twenty API servers now share the cache. It absorbs most reads, which means the database is sized for the misses only. When the cache is cold, the database is suddenly undersized.',
  problem: `
    <p>At ShopLite's scale the cache has stopped being an optimisation and become load-bearing. A 95% hit ratio means the database sees 1 request in 20. Lose the cache and the database sees all 20, and nobody provisioned it for that. Three questions decide how a large cache behaves:</p>
    <ul>
      <li><strong>What stays when memory is full?</strong> The eviction policy and the shape of your traffic decide the hit ratio.</li>
      <li><strong>What happens when it is empty?</strong> After a restart, every request misses at once.</li>
      <li><strong>How do writes reach it?</strong> Each write strategy trades speed against the risk of stale or lost data.</li>
    </ul>`,
  realWorld: `
    <p>An office worker keeps today's papers on the desk, this month's in a drawer and older ones in the basement archive. When the desk is full, the paper untouched longest goes back in the drawer. That is least-recently-used (LRU) eviction, the default in most caches.</p>
    <p>Facebook's 2013 paper "Scaling Memcache at Facebook" describes caches serving billions of requests per second in front of MySQL. Two of its problems are ShopLite's. A popular key expiring caused a <em>thundering herd</em> of identical database queries, which they solved with <em>leases</em>: the first client to miss gets permission to refill the key and the others briefly wait. And a cold cluster could not be put into service directly; it was warmed by reading from a warm cluster first.</p>`,
  approach: `
    <p><strong>Layers.</strong> A request can be answered by the browser cache, the CDN (lesson 2), a small in-process cache on each API server, or the shared Redis cluster, before it reaches the database. Each layer is faster and smaller than the one behind it. In-process caches are fastest but each server has its own copy, so they suit small, rarely changing data such as feature flags and category lists.</p>
    <p><strong>Eviction and skew.</strong> Most traffic follows a power law: a few products get most of the views. That is why a cache holding 10% of the catalogue can serve 80% of requests. Measure the hit ratio; do not assume it.</p>
    <p><strong>Cold starts and stampedes.</strong></p>
    ${code(`
async function getProduct(id) {
  const hit = await redis.get('product:' + id);
  if (hit) return JSON.parse(hit);
  // Only one caller rebuilds a missing key; the rest wait briefly and read it.
  const gotLock = await redis.set('lock:product:' + id, '1', 'NX', 'PX', 2000);
  if (!gotLock) { await sleep(50); return getProduct(id); }
  const product = await db.loadProduct(id);
  const ttl = 3600 + Math.floor(Math.random() * 600);   // jitter so keys do not all expire together
  await redis.set('product:' + id, JSON.stringify(product), 'EX', ttl);
  return product;
}`, 'js')}
    <p>Restart cache nodes one at a time, warm a new node before giving it traffic, and size the database to survive at least one cache node being cold.</p>
    <p><strong>Write strategies.</strong> <em>Cache-aside</em> (Course 1) is the safe default. <em>Write-through</em> keeps the cache always fresh at the cost of slower writes. <em>Write-back</em> makes writes fast by delaying the database write, which means a crashed cache node loses data. Use it only for data you can afford to lose, such as view counters.</p>
    <p><strong>Spreading the cluster.</strong> A cache too big for one node is split across several by hashing the key. Lesson 12 shows how to do that without losing most of the cache whenever a node is added.</p>`,
  sim: {
    title: 'Hit ratio after a cold start',
    intro: 'The catalogue has 10,000 products. Each bar shows the hit ratio over 300 requests, starting from an empty cache. Change the cache size and how concentrated traffic is on popular products. Then try the write strategies below.',
    mount(root, ctx) {
      root.innerHTML = `
        ${slider('ca-size', 'Cache size:', 1, 50, 10)}
        ${slider('ca-skew', 'Traffic concentration:', 4, 14, 10)}
        <div class="chartbox" id="ca-chart"></div>
        <div class="stats" id="ca-stats"></div>
        <p class="sim-note" id="ca-note" role="status"></p>
        <h4>Write strategies</h4>
        <div class="controls">
          <label class="field" for="ca-mode"><span>Strategy</span><select id="ca-mode">${Object.entries(writeModes).map(([k, [n]]) => `<option value="${k}">${n}</option>`).join('')}</select></label>
          <button class="btn" id="ca-write">Change price to $89</button>
          <button class="btn ghost" id="ca-crash">Cache node crashes</button>
          <button class="btn ghost" id="ca-reset">Start over</button>
        </div>
        <p class="sim-note" id="ca-mode-desc"></p>
        <div class="stats" id="ca-state"></div>
        <ul class="log" id="ca-log" aria-live="polite"></ul>`;
      const $ = (id) => root.querySelector(id);
      let size, skew;
      const draw = (v, user) => {
        if (user) ctx.tried();
        if (!size || !skew) return;
        const r = simulateCache({ size: size() * 100, skew: skew() / 10 });
        const W = 600, H = 150, pad = 30, bw = (W - pad) / r.series.length - 3;
        $('#ca-chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="svgchart" role="img" aria-label="Hit ratio rising as the cache warms up">
          ${[0, 0.5, 1].map((t) => `<line class="grid" x1="${pad}" x2="${W}" y1="${H - 20 - t * (H - 30)}" y2="${H - 20 - t * (H - 30)}"/><text class="axis" x="${pad - 4}" y="${H - 17 - t * (H - 30)}" text-anchor="end">${t * 100}%</text>`).join('')}
          ${r.series.map((v, i) => `<rect class="bar-ok" x="${pad + 2 + i * (bw + 3)}" y="${H - 20 - v * (H - 30)}" width="${bw}" height="${v * (H - 30)}" rx="2"><title>Requests ${i * 300 + 1} to ${(i + 1) * 300}: ${Math.round(v * 100)}% hits</title></rect>`).join('')}
          <text class="axis" x="${pad}" y="${H - 4}">restart</text><text class="axis" x="${W}" y="${H - 4}" text-anchor="end">6,000 requests later</text></svg>`;
        const first = r.series[0], last = r.series.at(-1);
        stats($('#ca-stats'), [
          ['Hit ratio once warm', Math.round(last * 100) + '%', last > 0.8 ? 'ok' : last < 0.5 ? 'bad' : 'warn'],
          ['Database reads per 1,000 requests, just after restart', Math.round((1 - first) * 1000), 'bad'],
          ['Database reads per 1,000 requests, once warm', Math.round((1 - last) * 1000), 'ok'],
        ]);
        $('#ca-note').textContent = `Right after the restart the database takes ${((1 - first) / Math.max(0.01, 1 - last)).toFixed(1)}× its usual load. ${last > 0.8 ? 'A small cache works well because traffic is concentrated on a few products.' : 'Traffic is spread widely, so even a large cache misses often.'}`;
      };
      size = bindSlider(root, 'ca-size', (v) => `${v * 100} products (${v}% of the catalogue)`, draw);
      skew = bindSlider(root, 'ca-skew', (v) => (v < 7 ? 'spread out' : v < 11 ? 'typical' : 'very concentrated'), draw);

      let db, cache, pending;
      const reset = () => { db = 99; cache = 99; pending = null; $('#ca-log').innerHTML = ''; drawState(); };
      const drawState = () => {
        $('#ca-mode-desc').textContent = writeModes[$('#ca-mode').value][1];
        stats($('#ca-state'), [['Price in database', '$' + db], ['Price in cache', cache == null ? 'empty' : '$' + cache], ['Waiting to reach the database', pending == null ? 'nothing' : '$' + pending, pending != null ? 'warn' : '']]);
      };
      $('#ca-mode').onchange = () => { ctx.tried(); reset(); };
      $('#ca-reset').onclick = reset;
      $('#ca-write').onclick = () => {
        ctx.tried();
        const m = $('#ca-mode').value;
        if (m === 'aside') { db = 89; cache = null; log($('#ca-log'), 'Database updated (12 ms). Cache key deleted. Next read reloads $89.'); }
        else if (m === 'through') { cache = 89; db = 89; log($('#ca-log'), 'Cache and database both updated before the OK (14 ms). Readers see $89 at once.'); }
        else { cache = 89; pending = 89; log($('#ca-log'), 'Cache updated, OK returned in 1 ms. Database write queued for the next flush.'); ctx.after(4000, () => { if (pending != null) { db = pending; pending = null; log($('#ca-log'), 'Background flush wrote $89 to the database.'); drawState(); } }); }
        drawState();
      };
      $('#ca-crash').onclick = () => {
        ctx.tried();
        const lost = pending != null;
        cache = null; pending = null;
        log($('#ca-log'), lost ? `${pill('data lost', 'bad')} The cache died before flushing. The database still says $${db}. The price change is gone.` : `${pill('no loss', 'ok')} The cache is empty, so the next reads go to the database, which has every confirmed write.`, lost ? 'bad' : '');
        drawState();
      };
      reset();
    },
  },
  tradeoffs: [
    ['A warm cache lets a modest database serve huge read traffic.', 'The database is now sized for the hit ratio. A cold or failed cache can overload it, so restarts need care and warm-up.'],
    ['Write-through keeps the cache fresh without invalidation logic.', 'Every write pays for two systems, and data that is written but rarely read fills the cache.'],
    ['Write-back makes writes nearly free and batches database load.', 'Writes confirmed to the user can be lost when a cache node dies. Only acceptable for data you can afford to lose.'],
    ['In-process caches avoid a network hop entirely.', 'Each server has its own copy, so invalidation is hard and memory is multiplied by the fleet size.'],
  ],
  avoid: `<p>Do not add a distributed cache before you have a measured read problem and have fixed the queries behind it. Do not use write-back for orders, payments or anything a customer was told is saved. If your hit ratio is low because traffic is spread evenly, a bigger cache helps less than you expect; look at the access pattern first.</p>`,
  shoplite: 'A Redis cluster with LRU eviction, jittered TTLs, single-flight refills for hot keys, rolling restarts with warm-up, and cache-aside for all business data.',
  takeaways: [
    'At scale the cache carries load. Plan for it being cold or gone.',
    'Hit ratio depends on cache size and on how concentrated traffic is. Measure it.',
    'Cache-aside is the safe default. Write-back trades durability for speed.',
  ],
  quiz: [
    { q: 'Your cache hit ratio is 95%. A cache node restart drops it to 0% for a minute. How much more load does the database see?',
      options: ['About 5% more', 'About twice as much', 'About 20 times as much'], answer: 2,
      why: 'At 95% hits the database serves 1 request in 20. With no hits it serves all 20.' },
    { q: 'Why add random jitter to cache TTLs?',
      options: ['To make the cache harder to attack', 'So keys loaded at the same moment do not all expire at the same moment and stampede the database', 'Redis requires it'], answer: 1,
      why: 'Keys loaded together (after a restart or deploy) would otherwise expire together and miss together.' },
    { q: 'Which data is acceptable to store with write-back caching?',
      options: ['Order totals', 'Product view counters', 'Customer passwords'], answer: 1,
      why: 'Losing a few seconds of view counts after a crash is harmless. Losing an order is not.' },
  ],
};
