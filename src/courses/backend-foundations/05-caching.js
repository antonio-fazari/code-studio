import { code, log, pill, slider, bindSlider, stats } from '../../ui.js';
import { TTLCache } from '../../engines.js';

export default {
  id: 'caching',
  title: 'Caching & TTLs',
  hook: 'Redis in front of slow queries',
  incident: 'The product page takes 420 ms. It is opened 3,000 times a minute and the product changes about once a week.',
  buildsOn: 'The pool protects the database from too many connections. The next step is to stop sending it the same question thousands of times.',
  problem: `
    <p>The product page joins products, prices, stock and review averages. Even with indexes it takes 420 ms, and during a sale the same page is requested 50 times a second. The database computes an identical answer every time. Those repeated reads occupy pool connections that checkout needs.</p>`,
  realWorld: `
    <p>Your browser does this already. It keeps a copy of a site's logo so it is not downloaded again on every page. DNS is the oldest example on the internet: each record carries a TTL telling resolvers how long they may reuse an answer before asking again.</p>
    <p>At large scale, caching is most of the read path. Facebook has described running memcached in front of its databases to serve billions of reads per second, and a CDN is a cache placed close to the user.</p>`,
  approach: `
    <p>Put a fast key-value store, usually Redis, between the app and the database. The common pattern is <strong>cache-aside</strong>:</p>
    ${code(`
async function getProduct(id) {
  const cached = await redis.get('product:' + id);
  if (cached) return JSON.parse(cached);             // hit: about 1 ms

  const product = await db.loadProductPage(id);      // miss: 420 ms
  await redis.set('product:' + id, JSON.stringify(product), 'EX', 60);   // keep for 60 s
  return product;
}

async function updatePrice(id, price) {
  await db.updatePrice(id, price);
  await redis.del('product:' + id);                  // next read reloads it
}`, 'js')}
    <p>The <strong>TTL</strong> (time to live) is the number that matters. It is the longest you are willing to show an out-of-date answer. Deleting the key on every write shortens that window, but the TTL is still your safety net for the writes you forget, such as a manual fix run directly in the database.</p>
    <p>Decide per kind of data. A product description can be an hour old. A price should be seconds old at most. Stock at checkout should never come from a cache: read it from the database, inside the transaction from lesson 2.</p>`,
  sim: {
    title: 'Fresh versus fast',
    intro: 'Request the product a few times, then change its price as an admin and request it again. Adjust the TTL and see how long customers are shown the old price.',
    mount(root, ctx) {
      root.innerHTML = `
        <div class="controls">
          <button class="btn" id="ca-get">GET /products/42</button>
          <button class="btn ghost" id="ca-write">Admin: raise price by $5</button>
          <label class="check" for="ca-inv"><input type="checkbox" id="ca-inv"> Delete the cache key on write</label>
        </div>
        ${slider('ca-ttl', 'TTL:', 0, 30, 10)}
        <div class="stats" id="ca-stats"></div>
        <ul class="log" id="ca-log" aria-live="polite"></ul>`;
      const $ = (id) => root.querySelector(id);
      const cache = new TTLCache();
      let dbPrice = 80, hits = 0, misses = 0, stale = 0;
      const ttl = bindSlider(root, 'ca-ttl', (v) => (v ? v + ' s' : 'off (no caching)'), (v, user) => { if (user) ctx.tried(); });
      const draw = () => {
        const left = cache.remainingMs('p', Date.now());
        const total = hits + misses;
        stats($('#ca-stats'), [
          ['Price in database', '$' + dbPrice],
          ['Cached copy', left ? `$${cache.get('p', Date.now())} for ${Math.ceil(left / 1000)} s more` : 'empty'],
          ['Hit rate', total ? Math.round((hits / total) * 100) + '%' : 'n/a'],
          ['Database queries', misses],
          ['Stale responses served', stale, stale ? 'bad' : ''],
        ]);
      };
      ctx.every(250, draw); draw();
      $('#ca-get').onclick = () => {
        ctx.tried();
        const now = Date.now(), cached = cache.get('p', now);
        if (cached !== undefined) {
          hits++;
          const isStale = cached !== dbPrice;
          if (isStale) stale++;
          log($('#ca-log'), `${pill('HIT', 'ok')} 2 ms, returned $${cached}${isStale ? ` ${pill('stale', 'bad')} the real price is $${dbPrice}` : ''}`);
        } else {
          misses++;
          if (ttl()) cache.set('p', dbPrice, ttl() * 1000, now);
          log($('#ca-log'), `${pill('MISS', 'warn')} 420 ms, queried the database, returned $${dbPrice}${ttl() ? `, cached for ${ttl()} s` : ''}`);
        }
        draw();
      };
      $('#ca-write').onclick = () => {
        ctx.tried();
        dbPrice += 5;
        const inv = $('#ca-inv').checked;
        if (inv) cache.delete('p');
        log($('#ca-log'), `<b>Admin</b> price is now $${dbPrice} in the database${inv ? ', cache key deleted' : '. The cached copy was not touched'}`);
        draw();
      };
    },
  },
  tradeoffs: [
    ['Hot reads drop from hundreds of milliseconds to one or two, and the database is freed for writes.', 'Readers can see old data for up to one TTL. You have to decide how stale is acceptable for each kind of data.'],
    ['A long TTL gives a high hit rate and the least database load.', 'A long TTL also means the longest wait before a missed invalidation corrects itself.'],
    ['Deleting keys on write keeps data fresh without a short TTL.', 'Every code path that writes must remember to invalidate. The ones you miss become bugs that are hard to reproduce.'],
    ['The app survives read spikes that would flatten the database.', 'When a popular key expires, many requests miss at once and all hit the database (a stampede). Redis is also one more service to run and monitor.'],
  ],
  avoid: `<p>Do not cache data that must be correct at the moment of use: stock during checkout, account balances, permissions you have just revoked. Do not cache things that are rarely read twice, because every miss costs slightly more than no cache at all. And fix the slow query first (lesson 1). A cache in front of a missing index hides the problem until the first cold start.</p>`,
  shoplite: 'Product pages cached in Redis for 60 s and deleted when a product is edited.',
  takeaways: [
    'A cache trades freshness for speed. The TTL is how you set the exchange rate.',
    'Cache-aside: read the cache, fall back to the database, store the result with a TTL.',
    'Invalidate on write when you can, and keep a TTL as the safety net.',
  ],
  quiz: [
    { q: 'What does a TTL of 60 seconds promise?',
      options: ['Data is refreshed every 60 seconds', 'A cached answer is never more than about 60 seconds old', 'The cache is cleared for all keys every minute'], answer: 1,
      why: 'TTL bounds staleness per entry, counted from when that entry was stored.' },
    { q: 'Which value should ShopLite not serve from the cache?',
      options: ['Product description on the product page', 'Stock count when deciding whether a checkout can proceed', 'The list of categories in the menu'], answer: 1,
      why: 'A stale stock count at checkout recreates the oversell bug. Read it in the transaction.' },
    { q: 'A very popular key expires and 500 requests arrive in the same second. What happens with plain cache-aside?',
      options: ['One request reloads it and the rest wait', 'All 500 miss and query the database at once', 'Redis serves the expired value until it is replaced'], answer: 1,
      why: 'This is a cache stampede. Common fixes: a short lock so one request reloads, or slightly randomized TTLs so keys do not expire together.' },
  ],
};
