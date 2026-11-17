import { code, ms, pill, stats } from '../../ui.js';
import { simulateLB } from '../../engines-sd.js';

const algos = { rr: 'Round robin', random: 'Random', least: 'Least connections' };
const states = { ok: 'Healthy', slow: 'Slow (5× longer per request)', down: 'Crashed' };

export default {
  id: 'sd-load-balancing',
  part: 'Part 1: Getting traffic in',
  title: 'Load Balancing',
  hook: 'Spread requests across servers, and stop sending them to broken ones',
  incident: 'One of six API servers had a failing disk and answered slowly. For two hours, one checkout in six took over 3 seconds.',
  buildsOn: 'ShopLite now runs a fleet of stateless API servers that grows and shrinks. Clients need one address to send requests to, and something has to decide which server gets each one.',
  problem: `
    <p>DNS could hand out all the server addresses, but clients cache them (lesson 1), so DNS cannot react when a server dies or is removed by the autoscaler. A <strong>load balancer</strong> sits in front of the fleet with one stable address, receives every request, and forwards it to a server it believes is healthy.</p>
    <p>The interesting part is <em>which</em> server. A simple rotation treats all servers as equal. They are not: one has a noisy neighbour, one is halfway through a garbage-collection pause, one has a failing disk. A balancer that ignores this sends a fixed share of traffic into the slow server, where it queues.</p>`,
  realWorld: `
    <p>Supermarkets learned this long ago. If each customer picks a till at random, someone ends up behind the person paying in coins while the next till is empty. A single queue feeding whichever till frees up first keeps everyone moving. That is the difference between round robin and least connections.</p>
    <p>Every large site runs layers of balancers. AWS offers both kinds: the Network Load Balancer works on TCP connections (layer 4) and the Application Load Balancer reads HTTP requests (layer 7). NGINX, HAProxy and Envoy are the common open-source choices. Google described Maglev, its own software balancer, in a 2016 paper: a fleet of ordinary machines that together act as one balancer, so the balancer itself has no single point of failure.</p>`,
  approach: `
    <p><strong>Layer 4 or layer 7.</strong> A layer 4 balancer forwards TCP connections without reading them: very fast, protocol-agnostic. A layer 7 balancer reads HTTP, so it can route <code>/api</code> and <code>/images</code> to different pools, retry idempotent requests, terminate TLS and add headers. Web APIs usually sit behind layer 7.</p>
    <p><strong>Algorithms.</strong></p>
    <ul>
      <li><strong>Round robin</strong>: each server in turn. Fine when servers and requests are uniform.</li>
      <li><strong>Weighted</strong>: bigger servers get a larger share.</li>
      <li><strong>Least connections</strong> (or least outstanding requests): send to the server with the fewest requests in flight. A slow server accumulates in-flight requests and automatically receives fewer new ones.</li>
      <li><strong>Power of two choices</strong>: pick two servers at random and use the less busy one. Nearly as good as least connections, and it needs no global view, which matters when there are many balancers.</li>
      <li><strong>Hashing</strong> on a user id or IP: the same client always reaches the same server. Useful for caches, harmful for even load (lesson 12 shows how to do it well).</li>
    </ul>
    <p><strong>Health checks.</strong> The balancer calls a cheap endpoint on every server every few seconds and removes servers that fail it a few times in a row. Passive checks also count real request failures. A good health endpoint checks that the process can serve, without failing because a shared dependency is down; otherwise one database blip removes every server at once.</p>
    ${code(`
upstream shoplite_api {
    least_conn;
    server 10.0.1.11:8080 max_fails=3 fail_timeout=10s;
    server 10.0.1.12:8080 max_fails=3 fail_timeout=10s;
    server 10.0.1.13:8080 max_fails=3 fail_timeout=10s;
}
server {
    listen 443 ssl;
    location /api/ { proxy_pass http://shoplite_api; proxy_next_upstream error timeout; }
}`, 'nginx')}
    <p><strong>Draining.</strong> When the autoscaler removes a server or you deploy, the balancer stops sending it new requests and lets in-flight ones finish before it shuts down. Without draining, every deploy fails a few requests.</p>`,
  sim: {
    title: 'Three servers, one of them unwell',
    intro: '400 requests arrive at 200 per second. Each healthy server handles about 100 per second. Make server C slow or crash it, and compare how each algorithm copes.',
    mount(root, ctx) {
      root.innerHTML = `
        <div class="controls">
          <label class="field" for="lb-algo"><span>Algorithm</span><select id="lb-algo">${Object.entries(algos).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <label class="field" for="lb-c"><span>Server C is</span><select id="lb-c">${Object.entries(states).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <label class="check" for="lb-hc"><input type="checkbox" id="lb-hc" checked> Health checks</label>
        </div>
        <div class="hbars" id="lb-bars"></div>
        <div class="stats" id="lb-stats"></div>
        <p class="sim-note" id="lb-note" role="status"></p>`;
      const $ = (id) => root.querySelector(id);
      const draw = (user) => {
        if (user) ctx.tried();
        const c = $('#lb-c').value, algo = $('#lb-algo').value;
        const servers = [{ name: 'A', ms: 10 }, { name: 'B', ms: 10 }, { name: 'C', ms: c === 'slow' ? 50 : 10, down: c === 'down' }];
        const r = simulateLB({ algo, servers, healthChecks: $('#lb-hc').checked });
        $('#lb-bars').innerHTML = r.perServer.map((s) => `<div class="hbar"><span class="hbar-name">Server ${s.name}</span>
          <span class="hbar-track"><i class="${s.failed ? 'bad' : 'accent'}" style="width:${(s.count / 400) * 100}%" title="Server ${s.name}: ${s.count} requests${s.failed ? `, ${s.failed} failed` : ''}"></i></span>
          <span class="hbar-val">${s.count}${s.out ? ' ' + pill('removed', 'warn') : ''}</span></div>`).join('');
        stats($('#lb-stats'), [
          ['Median latency', ms(r.p50)], ['p99 latency', ms(r.p99), r.p99 > 200 ? 'bad' : 'ok'], ['Failed requests', r.failed, r.failed ? 'bad' : 'ok'],
        ]);
        $('#lb-note').textContent =
          c === 'down' && !$('#lb-hc').checked && algo === 'least' ? 'A crashed server answers instantly with errors, so it always looks least busy and attracts nearly every request. Least connections needs health checks.'
          : c === 'down' && !$('#lb-hc').checked ? 'Without health checks the balancer keeps sending its share of traffic to a dead server.'
          : c === 'down' ? 'Three failures and the health check takes C out of rotation. The other two absorb its traffic.'
          : c === 'slow' && algo !== 'least' ? 'C still receives a third of the traffic but can only handle a fifth as much. Its queue grows for as long as the test runs, and the p99 shows it.'
          : c === 'slow' ? 'C builds up in-flight requests, so least connections sends it fewer. The slow server is barely felt.'
          : 'All servers are equal, so every algorithm does well.';
      };
      root.querySelectorAll('select, input').forEach((el) => (el.onchange = () => draw(true)));
      draw(false);
    },
  },
  tradeoffs: [
    ['One stable address for clients while servers come and go behind it.', 'The balancer is now on every request path. It must itself be redundant (a pair, a managed service, or a fleet), or it becomes the single point of failure.'],
    ['Health checks and least-connections routing hide slow and dead servers from users.', 'A health check that is too strict can remove every server during a shared dependency blip. One that is too lax leaves a broken server in rotation.'],
    ['Layer 7 balancers can route by path, terminate TLS and retry safely.', 'Each layer adds a little latency and its own configuration to get wrong. Retries at the balancer must respect idempotency (Course 1).'],
  ],
  avoid: `<p>A single server with a standby does not need an algorithm discussion; a managed balancer with defaults is fine. Avoid sticky sessions (hash or cookie affinity) as a way to keep server-side state: they make load uneven and break when a server leaves. Make the servers stateless instead (lesson 3).</p>`,
  shoplite: 'A managed layer 7 load balancer with least outstanding requests, a health check on /healthz every 5 s, and 30 s connection draining.',
  takeaways: [
    'A load balancer gives clients one address and spreads requests across healthy servers.',
    'Round robin assumes servers are equal. Least connections adapts when one is slow.',
    'Health checks and draining decide what happens when a server fails or leaves.',
  ],
  quiz: [
    { q: 'One of four servers becomes five times slower. With round robin, what happens to overall p99 latency?',
      options: ['Nothing, the other three compensate', 'It rises sharply, because a quarter of requests still queue on the slow server', 'It falls'], answer: 1,
      why: 'Round robin keeps sending a fixed share regardless of how the server is coping. Least connections would send it less.' },
    { q: 'Why can least connections make a crashed server worse when there are no health checks?',
      options: ['A crashed server fails fast, so it always has the fewest requests in flight and attracts traffic', 'Least connections does not work with HTTP', 'It sends traffic only to the newest server'], answer: 0,
      why: 'Instant errors look like spare capacity. Health checks or error-aware balancing must take it out.' },
    { q: 'Your /healthz endpoint returns an error whenever the database is unreachable. What risk does that create?',
      options: ['None, this is best practice', 'A short database outage marks every server unhealthy, and the balancer has nowhere to send traffic', 'The database receives too many health checks'], answer: 1,
      why: 'Health checks should report whether this server can work. A shared dependency failure is not fixed by removing every server.' },
  ],
};
