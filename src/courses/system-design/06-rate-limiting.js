import { code, pill, slider, bindSlider, stats } from '../../ui.js';
import { FixedWindow, SlidingLog, SlidingCounter } from '../../engines-sd.js';

const LIMIT = 10, WINDOW = 1000, SPAN = 3000;
const patterns = {
  boundary: ['Burst at a window boundary', () => [...Array.from({ length: 10 }, (_, i) => 900 + i * 9), ...Array.from({ length: 10 }, (_, i) => 1005 + i * 9)]],
  steady: ['Steady 15 per second', () => Array.from({ length: 45 }, (_, i) => Math.round(i * (SPAN / 45)))],
  bursty: ['Bursts of 8 every half second', () => Array.from({ length: 6 }, (_, b) => Array.from({ length: 8 }, (_, i) => b * 500 + i * 6)).flat()],
};
const algos = [['Fixed window', FixedWindow, '2 numbers'], ['Sliding log', SlidingLog, `up to ${LIMIT} timestamps`], ['Sliding window counter', SlidingCounter, '3 numbers']];

/** The most requests allowed in any one-second span. */
const worstSecond = (ts) => ts.reduce((m, t) => Math.max(m, ts.filter((u) => u >= t && u < t + WINDOW).length), 0);

export default {
  id: 'sd-rate-limiting',
  part: 'Part 1: Getting traffic in',
  title: 'Rate Limiting at Scale',
  hook: 'Window algorithms, and enforcing one limit across many servers',
  incident: 'A partner\'s limit is 10 requests per second. Logs show they sent 20 in a fifth of a second and every one was accepted. Separately, another client got 6 times their limit by spreading across servers.',
  revisits: { id: 'rate-limiting', note: 'That lesson built a token bucket for one server. Here the limit has to hold across a fleet of servers behind a load balancer.' },
  buildsOn: 'The load balancer spreads each client\'s requests across twenty servers. Any limit that a server enforces on its own now allows twenty times as much.',
  problem: `
    <p>Two separate problems showed up together.</p>
    <p><strong>The algorithm leaks.</strong> ShopLite's limiter counts requests in fixed one-second windows: 00:00 to 00:01, 00:01 to 00:02. A client that sends 10 at the end of one window and 10 at the start of the next stays within each window's count, yet sends 20 in a fraction of a second.</p>
    <p><strong>The counters are local.</strong> Each API server keeps its own counts. With the load balancer spreading a client across six servers, each server sees a sixth of the traffic and approves all of it.</p>`,
  realWorld: `
    <p>A nightclub with a capacity of 200 cannot let each of its four doors admit 200 people. The doors share a clicker count, or the building ends up with 800 inside.</p>
    <p>Stripe has written about running several limiters at once: a per-user request rate limit, a limit on concurrent requests, and load shedders that drop low-priority traffic first when the whole fleet is under strain. Cloudflare has described using the sliding window counter shown below, because it is nearly as accurate as keeping every timestamp while storing only two counters per client, which matters across millions of clients.</p>`,
  approach: `
    <p><strong>Pick an algorithm that matches the promise.</strong></p>
    <ul>
      <li><strong>Fixed window</strong>: one counter per client per window. Cheapest, but allows up to twice the limit across a boundary.</li>
      <li><strong>Sliding log</strong>: keep a timestamp per request and count those in the last second. Exact, but memory grows with the limit.</li>
      <li><strong>Sliding window counter</strong>: keep this window's and last window's counts, and weight last window's by how much of it still overlaps. Close to exact, with constant memory.</li>
      <li><strong>Token bucket</strong> (Course 1): allows a controlled burst, then a steady rate.</li>
    </ul>
    <p><strong>Keep the count in one shared place.</strong> Store counters in Redis and update them atomically, so check-and-increment cannot race between servers:</p>
    ${code(`
-- Sliding window counter as a Redis Lua script (runs atomically)
local cur  = tonumber(redis.call('GET', KEYS[1]) or '0')   -- this window
local prev = tonumber(redis.call('GET', KEYS[2]) or '0')   -- previous window
local weight = 1 - tonumber(ARGV[2])                       -- share of the previous window still in view
if prev * weight + cur >= tonumber(ARGV[1]) then return 0 end
redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], 2000)
return 1`, 'lua')}
    <p>A shared counter adds a network round trip to every request and makes Redis critical. Two common compromises: give each of N servers a local budget of limit ÷ N (accurate only if the balancer spreads evenly), or have servers count locally and sync with Redis every few hundred milliseconds. And decide what happens if Redis is unreachable. Usually you let requests through, because a broken limiter should not become an outage.</p>
    <p><strong>Limit at the edge too.</strong> Crude per-IP limits at the CDN or API gateway (lesson 2) stop floods before they reach your servers. Precise per-customer limits belong in the application, where you know who is calling.</p>`,
  sim: {
    title: 'Three algorithms, one limit',
    intro: 'The limit is 10 requests per second. Pick a traffic pattern and compare what each algorithm lets through over 3 seconds. Filled dots were allowed, hollow ones rejected. Then spread the client across servers.',
    mount(root, ctx) {
      root.innerHTML = `
        <div class="controls">
          <label class="field" for="rl-pat"><span>Traffic pattern</span><select id="rl-pat">${Object.entries(patterns).map(([k, [n]]) => `<option value="${k}">${n}</option>`).join('')}</select></label>
        </div>
        <div class="chartbox" id="rl-chart"></div>
        <div class="tablewrap"><table id="rl-table"></table></div>
        <h4>Many servers</h4>
        ${slider('rl-servers', 'API servers behind the load balancer:', 1, 20, 6)}
        <label class="check" for="rl-shared"><input type="checkbox" id="rl-shared"> Counters kept in shared Redis</label>
        <div class="stats" id="rl-stats"></div>`;
      const $ = (id) => root.querySelector(id);
      const draw = () => {
        const ts = patterns[$('#rl-pat').value][1]();
        const W = 600, rowH = 34, pad = 150, H = algos.length * rowH + 26;
        const x = (t) => pad + (t / SPAN) * (W - pad - 10);
        const results = algos.map(([name, Cls]) => { const L = new Cls(LIMIT, WINDOW); return ts.map((t) => ({ t, ok: L.allow(t) })); });
        $('#rl-chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="svgchart" role="img" aria-label="Allowed and rejected requests over time for each algorithm">
          ${[0, 1000, 2000, 3000].map((t) => `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="4" y2="${H - 18}"/><text class="axis" x="${x(t)}" y="${H - 4}" text-anchor="middle">${t / 1000} s</text>`).join('')}
          ${results.map((rs, i) => `<text class="label" x="0" y="${i * rowH + 22}">${algos[i][0]}</text>
            ${rs.map((r) => `<circle class="${r.ok ? 'dot-ok' : 'dot-bad'}" cx="${x(r.t)}" cy="${i * rowH + 18 + ((r.t * 7) % 9) - 4}" r="4"><title>${r.t} ms: ${r.ok ? 'allowed' : 'rejected'}</title></circle>`).join('')}`).join('')}
        </svg>`;
        $('#rl-table').innerHTML = `<thead><tr><th>Algorithm</th><th>Allowed</th><th>Most in any 1 s span</th><th>Memory per client</th></tr></thead><tbody>${results.map((rs, i) => {
          const allowed = rs.filter((r) => r.ok).map((r) => r.t), worst = worstSecond(allowed);
          return `<tr><td>${algos[i][0]}</td><td>${allowed.length} of ${ts.length}</td><td class="${worst > LIMIT ? 'bad' : ''}">${worst}${worst > LIMIT ? ' (over the limit)' : ''}</td><td>${algos[i][2]}</td></tr>`;
        }).join('')}</tbody>`;
      };
      let servers;
      const drawServers = (v, user) => {
        if (user) ctx.tried();
        if (!servers) return;
        const n = servers(), shared = $('#rl-shared').checked;
        stats($('#rl-stats'), [
          ['Effective limit for one client', (shared ? LIMIT : LIMIT * n) + ' per second', !shared && n > 1 ? 'bad' : 'ok'],
          ['Extra latency per request', shared ? 'about 0.5 ms (one Redis call)' : 'none'],
          ['If Redis is down', shared ? 'fail open: requests allowed' : 'not affected'],
        ]);
      };
      $('#rl-pat').onchange = () => { ctx.tried(); draw(); };
      $('#rl-shared').onchange = () => drawServers(0, true);
      servers = bindSlider(root, 'rl-servers', String, drawServers);
      draw(); drawServers();
    },
  },
  tradeoffs: [
    ['A sliding window enforces the promised rate at every moment, not just per calendar second.', 'Slightly more state and arithmetic than a fixed window. The sliding log\'s memory grows with the limit.'],
    ['A shared counter makes the limit exact across the whole fleet.', 'Every request pays a network round trip, and the counter store becomes critical infrastructure with its own failure policy.'],
    ['Local budgets (limit ÷ servers) need no shared state at all.', 'They are only accurate if the load balancer spreads each client evenly, and they must be recomputed as the fleet scales.'],
  ],
  avoid: `<p>If your limits exist only to stop accidental floods, a fixed window or a token bucket per server with a generous limit is enough; the boundary burst rarely matters. Precise, shared limits earn their cost when limits are part of a paid plan or protect something fragile. Never let the limiter's own outage take the API down.</p>`,
  shoplite: 'Per-IP limits at the CDN edge, and per-API-key sliding window counters in Redis via a Lua script, failing open if Redis is unreachable.',
  takeaways: [
    'Fixed windows can allow twice the limit across a boundary. Sliding windows close that gap.',
    'Limits enforced separately on each server multiply by the number of servers.',
    'A shared counter in Redis is exact but adds latency and a dependency. Decide how it fails.',
  ],
  quiz: [
    { q: 'With a fixed window of 100 requests per minute, what is the most a client can send in any 60-second span?',
      options: ['100', 'Up to 200, across a window boundary', '50'], answer: 1,
      why: '100 at the end of one window and 100 at the start of the next are both within their own window\'s count.' },
    { q: 'A limit of 50 per second is enforced in each server\'s memory. There are 8 servers. What can a client really get?',
      options: ['50 per second', 'Up to 400 per second', '6 per second'], answer: 1,
      why: 'Each server approves up to 50 independently. Share the counter, or give each server a budget of about 50 ÷ 8.' },
    { q: 'Redis, which holds the rate-limit counters, becomes unreachable. What is the usual policy?',
      options: ['Reject all requests until it returns', 'Let requests through (fail open) and alert', 'Restart every API server'], answer: 1,
      why: 'The limiter protects the service. If it fails closed, it causes the outage it was meant to prevent.' },
  ],
};
