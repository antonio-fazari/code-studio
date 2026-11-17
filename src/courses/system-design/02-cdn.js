import { code, ms, pill, slider, bindSlider, stats } from '../../ui.js';
import { cdnRequestMs } from '../../engines-sd.js';

// Rough round-trip times to an origin in Virginia, and to the nearest CDN edge.
const regions = [
  ['New York', 10, 6], ['São Paulo', 120, 12], ['London', 75, 8], ['Frankfurt', 90, 9],
  ['Mumbai', 190, 14], ['Singapore', 220, 10], ['Tokyo', 160, 9], ['Sydney', 200, 12],
];
const ROUNDS = 5; // a product page needs about five sequential rounds of requests (HTML, CSS, scripts, images)

export default {
  id: 'sd-cdn',
  part: 'Part 1: Getting traffic in',
  title: 'CDNs',
  hook: 'Serve content from near the user, not from your data centre',
  incident: 'Shoppers in Sydney say ShopLite feels broken. A product page takes over a second to show its images.',
  buildsOn: 'DNS now sends every customer to ShopLite\'s data centre in Virginia. For a customer in Sydney, that is a 15,000 km round trip for every image, script and stylesheet.',
  problem: `
    <p>No amount of server tuning beats the speed of light. A signal in fibre covers about 200 km per millisecond, so Sydney to Virginia and back costs around 200 ms before the server does any work. A page needs several rounds of requests (the HTML, then the CSS and scripts it references, then the images they reference), so the delays stack up.</p>
    <p>Meanwhile the servers in Virginia spend most of their bandwidth sending the same product photos and JavaScript bundles to everyone.</p>`,
  realWorld: `
    <p>Supermarkets do not ship every item from one central warehouse to every customer. They stock regional depots and local shops with the items people buy most, and only unusual orders travel from the centre.</p>
    <p>A <strong>content delivery network</strong> is that network of local shops. Akamai, founded in 1998, Cloudflare and Fastly run servers in hundreds of cities. Netflix built its own, called Open Connect: it places caching servers inside internet providers' networks, so most video never crosses the wider internet at all.</p>
    <p>The dependency cuts both ways. In June 2021 a single customer's configuration change triggered a bug at Fastly, and for most of an hour sites including Reddit, GOV.UK and The New York Times returned errors around the world.</p>`,
  approach: `
    <p>Point a hostname at the CDN (the <code>CNAME</code> from lesson 1), and set the CDN's <em>origin</em> to your servers. The CDN's DNS sends each user to a nearby <strong>edge</strong> server. On a miss, the edge fetches from your origin once, keeps a copy, and serves every later request for it locally.</p>
    <p>What the edge may keep, and for how long, is controlled by your HTTP headers:</p>
    ${code(`
# Build output with a content hash in the name: the file never changes, so cache it for a year
GET /assets/app.3f9c2a.js
Cache-Control: public, max-age=31536000, immutable

# Product images: cache for a day at the edge, an hour in the browser
GET /img/products/42-1200.webp
Cache-Control: public, max-age=3600, s-maxage=86400

# The HTML page and anything personal: do not store a shared copy
GET /account/orders
Cache-Control: private, no-store`, 'http')}
    <p>The trick that makes long caching safe is <strong>versioned file names</strong>. When <code>app.js</code> changes, the build names it <code>app.81d07e.js</code> and the HTML points to the new name. Nothing has to be purged, and old pages keep working with the old file. For content that must change in place, CDNs offer a purge API.</p>
    <p>Even uncacheable requests benefit. The edge ends the TLS connection close to the user and keeps warm, reused connections back to your origin, which removes several long round trips from every request.</p>`,
  sim: {
    title: 'Page load time around the world',
    intro: 'Origin servers are in Virginia. Each region shows the time for a product page without a CDN and with one. Change the cache hit ratio, then purge the cache and watch it refill.',
    mount(root, ctx) {
      root.innerHTML = `
        ${slider('cdn-hit', 'Edge cache hit ratio:', 0, 100, 90)}
        <div class="controls"><button class="btn ghost" id="cdn-purge">Purge the whole cache</button></div>
        <div class="legend"><span><i class="sw muted"></i>Origin only</span><span><i class="sw accent"></i>With CDN</span></div>
        <div class="hbars" id="cdn-bars"></div>
        <div class="stats" id="cdn-stats"></div>
        <p class="sim-note" id="cdn-note" role="status"></p>`;
      const $ = (id) => root.querySelector(id);
      const max = 220 * ROUNDS + 14 * ROUNDS;
      let get;
      const draw = (v, user) => {
        if (user) ctx.tried();
        const hit = get ? get() / 100 : 0.9;
        $('#cdn-bars').innerHTML = regions.map(([name, origin, edge]) => {
          const a = cdnRequestMs({ edgeRtt: edge, originRtt: origin, cdn: false, hitRatio: hit }) * ROUNDS;
          const b = cdnRequestMs({ edgeRtt: edge, originRtt: origin, cdn: true, hitRatio: hit }) * ROUNDS;
          return `<div class="hbar"><span class="hbar-name">${name}</span>
            <span class="hbar-track"><i class="muted" style="width:${(a / max) * 100}%" title="${name}, origin only: ${ms(a)}"></i><i class="accent" style="width:${(b / max) * 100}%" title="${name}, with CDN: ${ms(b)}"></i></span>
            <span class="hbar-val">${ms(a)} → <b>${ms(b)}</b></span></div>`;
        }).join('');
        stats($('#cdn-stats'), [
          ['Requests per second reaching the origin', Math.round(50000 * (1 - hit)).toLocaleString('en-US') + ' of 50,000', hit < 0.5 ? 'bad' : 'ok'],
          ['Sydney page load', ms(cdnRequestMs({ edgeRtt: 12, originRtt: 200, cdn: true, hitRatio: hit }) * ROUNDS)],
        ]);
        $('#cdn-note').textContent = hit < 0.3 ? 'A cold or badly configured cache is barely better than no CDN: every miss still travels to Virginia, plus the hop to the edge.' : 'Hits are served from a nearby city. Only misses pay for the trip to Virginia.';
      };
      get = bindSlider(root, 'cdn-hit', (v) => v + '%', draw);
      $('#cdn-purge').onclick = () => {
        ctx.tried();
        const input = $('#cdn-hit');
        input.value = 0; input.dispatchEvent(new Event('input'));
        let v = 0;
        const step = () => { v = Math.min(90, v + 6); input.value = v; input.dispatchEvent(new Event('input')); if (v < 90) ctx.after(250, step); };
        ctx.after(600, step);
      };
    },
  },
  tradeoffs: [
    ['Pages load several times faster far from your data centre, because most requests never leave the user\'s region.', 'Cached content can be stale. You need versioned file names, sensible TTLs and a purge process.'],
    ['Your origin handles a small fraction of the traffic and bandwidth bill.', 'A CDN outage or misconfiguration is now your outage, often for many sites at once.'],
    ['The CDN absorbs traffic spikes and most denial-of-service floods at its edge.', 'Caching the wrong thing is a security bug. A personalised page cached publicly shows one user\'s data to the next.'],
  ],
  avoid: `<p>An internal tool used from one office, or an API whose every response is personal and changes constantly, gains little. Never let a shared cache store responses that vary by user unless the cache key includes that user; when in doubt, send <code>Cache-Control: private</code>. For a small site, the CDN built into your hosting platform is enough.</p>`,
  shoplite: 'static.shoplite.example on a CDN with hashed asset names cached for a year, product images for a day, and HTML marked private.',
  takeaways: [
    'Distance costs time that no server can win back. A CDN moves content close to the user.',
    'Cache-Control headers decide what the edge may store and for how long.',
    'Versioned file names let you cache for a year and still deploy instantly.',
  ],
  quiz: [
    { q: 'You deploy a new JavaScript bundle but users keep getting the old one from the CDN for days. What is the standard fix?',
      options: ['Set max-age=0 on every asset', 'Put a content hash in the file name, so a new version is a new URL', 'Turn the CDN off during deploys'], answer: 1,
      why: 'A new URL is a guaranteed cache miss, while unchanged files keep their long cache life.' },
    { q: 'Which response must not be cached by a shared CDN edge?',
      options: ['/assets/logo.8c1d.svg', '/account/orders for the logged-in customer', '/img/products/42.webp'], answer: 1,
      why: 'It is personal. A shared cache would hand one customer\'s orders to the next person who asks for that URL.' },
    { q: 'Why can a CDN speed up a request it cannot cache?',
      options: ['It compresses the database', 'It terminates TLS near the user and reuses warm connections to the origin', 'It answers before the request is sent'], answer: 1,
      why: 'Connection setup takes several round trips. Doing those over a short distance saves most of their cost.' },
  ],
};
