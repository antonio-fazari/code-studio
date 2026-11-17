import { code, log, pill, slider, bindSlider, stats } from '../../ui.js';
import { TokenBucket } from '../../engines.js';

export default {
  id: 'rate-limiting',
  title: 'Rate Limiting',
  hook: 'Token bucket: protect your APIs',
  incident: 'A partner\'s price-comparison script called the search API 400 times a second. Checkout slowed down for every customer.',
  buildsOn: 'The pool, the cache and the queue help ShopLite handle legitimate load. None of them stops one client from taking far more than its share.',
  problem: `
    <p>A single integration with a bug (a loop with no delay) used every pool connection ShopLite had. It was not an attack. The partner was mortified. But the API had no notion of "too much from one caller", so one client's mistake became everyone's outage.</p>
    <p>The same gap lets someone try a million passwords against the login endpoint, or scrape the whole catalogue in an afternoon.</p>`,
  realWorld: `
    <p>GitHub's REST API allows an authenticated user 5,000 requests per hour and reports what remains in response headers on every call. Stripe has written about using token buckets to limit each customer's request rate. Banks limit how many PIN attempts you get. The mechanism varies, but the idea is the same: a fair-use limit per caller, enforced before the expensive work begins.</p>`,
  approach: `
    <p>The <strong>token bucket</strong> is the most widely used algorithm because it is simple and it allows short bursts.</p>
    <ul>
      <li>Each client has a bucket holding up to <em>capacity</em> tokens.</li>
      <li>Tokens are added at a steady <em>refill rate</em>, up to the capacity.</li>
      <li>Each request takes one token. If the bucket is empty, the request is rejected with <code>429 Too Many Requests</code>.</li>
    </ul>
    <p>Capacity sets the burst a client may send at once. Refill rate sets the average it can sustain. A page that fires 8 requests on load is fine. A loop that never stops is not.</p>
    ${code(`
function allow(bucket, now) {
  const elapsed = (now - bucket.last) / 1000;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerSec);
  bucket.last = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}`, 'js')}
    ${code(`
HTTP/1.1 429 Too Many Requests
Retry-After: 2
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 0`, 'http')}
    <p>With several app instances, the buckets live in Redis (the same one from lesson 5) so all instances share a count. Limits are keyed by API key or user where you know who is calling, and by IP address where you do not. Always tell the client when to come back with <code>Retry-After</code>.</p>`,
  sim: {
    title: 'A token bucket',
    intro: 'Each dot is a token. Send single requests, then send a burst. Change the capacity and refill rate and find settings that allow a page load of 8 requests but stop a runaway loop.',
    mount(root, ctx) {
      root.innerHTML = `
        ${slider('rl-cap', 'Capacity (burst size):', 1, 20, 10)}
        ${slider('rl-rate', 'Refill rate:', 1, 10, 2)}
        <div class="bucket" id="rl-bucket" aria-hidden="true"></div>
        <div class="controls">
          <button class="btn" id="rl-one">Send 1 request</button>
          <button class="btn ghost" id="rl-burst">Send a burst of 15</button>
        </div>
        <div class="stats" id="rl-stats"></div>
        <ul class="log" id="rl-log" aria-live="polite"></ul>`;
      const $ = (id) => root.querySelector(id);
      let bucket = new TokenBucket(10, 2, Date.now()), ok = 0, denied = 0;
      const rebuild = (v, user) => { if (user) ctx.tried(); if (cap && rate) { bucket = new TokenBucket(cap(), rate(), Date.now()); draw(); } };
      let cap, rate;
      cap = bindSlider(root, 'rl-cap', (v) => v + ' tokens', rebuild);
      rate = bindSlider(root, 'rl-rate', (v) => v + ' per second', rebuild);
      bucket = new TokenBucket(cap(), rate(), Date.now());
      function draw() {
        bucket.refill(Date.now());
        const full = Math.floor(bucket.tokens);
        $('#rl-bucket').innerHTML = Array.from({ length: bucket.capacity }, (_, i) => `<i class="${i < full ? 'on' : ''}"></i>`).join('');
        stats($('#rl-stats'), [['Tokens available', full + ' / ' + bucket.capacity], ['Allowed (200)', ok, 'ok'], ['Rejected (429)', denied, denied ? 'bad' : '']]);
      }
      function send() {
        const r = bucket.take(Date.now());
        if (r.ok) { ok++; log($('#rl-log'), `${pill('200', 'ok')} allowed, ${r.remaining} token${r.remaining === 1 ? '' : 's'} left`); }
        else { denied++; log($('#rl-log'), `${pill('429', 'bad')} rejected, Retry-After: ${(r.retryAfterMs / 1000).toFixed(1)} s`); }
      }
      $('#rl-one').onclick = () => { ctx.tried(); send(); draw(); };
      $('#rl-burst').onclick = () => { ctx.tried(); for (let i = 0; i < 15; i++) send(); draw(); };
      ctx.every(200, draw); draw();
    },
  },
  tradeoffs: [
    ['One noisy client can no longer degrade the service for the rest.', 'Legitimate users can be rejected: an office behind one IP address, or a customer running a valid bulk import.'],
    ['Brute-force and scraping become slow and expensive.', 'Limits need tuning per endpoint. Login needs a strict limit, search a looser one, and you will get the first guess wrong.'],
    ['Token buckets permit natural bursts while holding the long-run average.', 'Shared counters in Redis add a network hop to every request, and you must decide what happens when Redis is unreachable (usually: let requests through).'],
  ],
  avoid: `<p>Rate limiting does not replace capacity planning or authentication. It will not stop a distributed attack from thousands of addresses. That is a job for your CDN or cloud provider at the network edge. Do not apply one blanket limit to everything: internal services and your own workers usually need separate, higher limits or none.</p>`,
  shoplite: 'A token bucket per API key in Redis: 10-request burst, 2 per second sustained, and a much stricter bucket on login.',
  takeaways: [
    'Capacity controls the burst. Refill rate controls the sustained average.',
    'Reject early and cheaply with 429, and say when to retry.',
    'Key limits by identity when you have it, by IP when you do not.',
  ],
  quiz: [
    { q: 'A bucket has capacity 10 and refills 2 tokens per second. A client that has been idle sends 15 requests at once. How many succeed?',
      options: ['2', '10', '15'], answer: 1,
      why: 'The bucket was full, so the first 10 pass. The other 5 are rejected. The next token arrives half a second later.' },
    { q: 'The same client then keeps sending as fast as it can for a minute. Roughly what rate gets through?',
      options: ['10 per second', '2 per second', '0, it is blocked for the rest of the minute'], answer: 1,
      why: 'Once the burst is spent, throughput equals the refill rate. The client is slowed, not banned.' },
    { q: 'You run 4 app instances, each with its own in-memory bucket of 10 requests per second per client. What is the real limit?',
      options: ['10 per second', 'Up to 40 per second', '2.5 per second'], answer: 1,
      why: 'Each instance counts separately, so a client spread across all four gets four times the allowance. Shared state in Redis fixes that.' },
  ],
};
