import { code, ms, slider, bindSlider, stats } from '../ui.js';
import { simulatePool } from '../engines.js';

export default {
  id: 'pooling',
  title: 'Connection Pooling',
  hook: 'Do not open a database connection per request',
  incident: 'During a lunchtime sale the API returned errors for 9 minutes. Database log: "FATAL: sorry, too many clients already".',
  buildsOn: 'Queries are fast and checkout is correct. Now traffic is the problem: every one of those short transactions needs a connection to run on.',
  problem: `
    <p>ShopLite's first version opens a database connection at the start of each request and closes it at the end. That has two costs.</p>
    <ul>
      <li><strong>Setup time.</strong> A new connection needs a TCP handshake, usually a TLS handshake, then authentication. That is 20 to 30 ms before the first query, for a query that takes 5 ms.</li>
      <li><strong>A hard limit.</strong> PostgreSQL starts a whole operating-system process per connection and caps them (100 by default). Request number 101 gets an error.</li>
    </ul>`,
  realWorld: `
    <p>A supermarket does not hire a cashier when a customer arrives and dismiss them after one sale. It staffs a fixed number of tills, and customers queue briefly when all are busy.</p>
    <p>Every production stack does this. Java services use HikariCP, Python uses SQLAlchemy's pool, and Node's <code>pg</code> driver ships one. When many app servers share one PostgreSQL, teams put PgBouncer in front of it so thousands of client connections share a few dozen real ones.</p>`,
  approach: `
    <p>A <strong>pool</strong> opens a small number of connections once, at startup, and keeps them open. A request borrows one, runs its queries and returns it. If all are busy, the request waits in line for a short, bounded time.</p>
    ${code(`
// Created once when the app starts
const pool = new Pool({
  max: 20,                        // connections this app instance may hold
  connectionTimeoutMillis: 200,   // how long a request waits for a free one
  idleTimeoutMillis: 30000,       // close connections nobody has used
});

// Per request: borrow, query, return
const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);`, 'js')}
    <p>The sizing rule that surprises people: <strong>pool size × number of app instances must stay under the database's connection limit</strong>, with some left over for migrations and admin access. Bigger is not better. A database with 8 CPU cores cannot run 500 queries at once. It only switches between them, and everything slows down.</p>`,
  sim: {
    title: 'The lunchtime sale',
    intro: 'Send a burst of requests at a database that allows 100 connections. Each query takes 5 ms and opening a connection takes 25 ms.',
    mount(root, ctx) {
      root.innerHTML = `
        <div class="controls">
          <label class="check" for="po-on"><input type="checkbox" id="po-on"> Use a connection pool</label>
        </div>
        ${slider('po-req', 'Requests arriving at once:', 10, 600, 300, 10)}
        ${slider('po-size', 'Pool size per app instance:', 1, 60, 20)}
        ${slider('po-inst', 'App instances:', 1, 8, 1)}
        <div class="stats" id="po-stats"></div>
        <p class="sim-note" id="po-note" role="status"></p>`;
      const $ = (id) => root.querySelector(id);
      const get = {};
      const draw = (v, user) => {
        if (user) ctx.tried();
        if (!get.inst) return;
        const pooled = $('#po-on').checked;
        $('#po-size').disabled = $('#po-inst').disabled = !pooled;
        const r = simulatePool({ requests: get.req(), pooled, poolSize: get.size(), instances: get.inst() });
        stats($('#po-stats'), [
          ['Succeeded', r.ok, 'ok'], ['Failed', r.failed, r.failed ? 'bad' : ''],
          ['Average latency', ms(r.avgMs)], ['Slowest request', ms(r.maxMs)],
          ['Database connections in use', r.connections + ' / 100', r.connections >= 100 ? 'bad' : ''],
        ]);
        $('#po-note').textContent = !pooled
          ? (r.failed ? `${r.failed} requests were refused with "too many clients". The rest each paid 25 ms just to connect.` : 'Everything succeeded, but every request paid 25 ms to connect before its 5 ms query.')
          : r.refusedConnections ? `The instances want ${r.connections + r.refusedConnections} connections in total and the database allows 100. Instances started last cannot connect at all.`
          : r.failed ? `The pool is too small for this burst. ${r.failed} requests waited more than 200 ms for a free connection and gave up.`
          : `No connection setup cost. Requests share ${r.connections} connections and queue for a few milliseconds when all are busy.`;
      };
      get.req = bindSlider(root, 'po-req', String, draw);
      get.size = bindSlider(root, 'po-size', String, draw);
      get.inst = bindSlider(root, 'po-inst', String, draw);
      $('#po-on').onchange = () => draw(0, true);
      draw();
    },
  },
  tradeoffs: [
    ['No handshake per request. Latency drops by the full connection setup time.', 'Requests can now wait in a queue you did not have before. You must set a timeout and watch the wait time.'],
    ['The pool caps the load on the database. A traffic spike becomes a short queue, not a crash.', 'A pool that is too small wastes capacity, and one that is too large exhausts the database. The right size depends on instance count, which changes when you scale.'],
    ['Connections are reused, so the database spends its memory on queries and not on idle processes.', 'A connection that is borrowed and never returned (a leak) slowly empties the pool until every request hangs.'],
  ],
  avoid: `<p>A one-off script or a nightly batch job with a single connection needs no pool. Serverless functions are the awkward case: each instance holds its own pool of one, so a thousand instances mean a thousand connections. There you need an external pooler such as PgBouncer or your cloud provider's database proxy.</p>`,
  shoplite: 'One shared pool of 20 connections per instance, with a 200 ms wait timeout.',
  takeaways: [
    'Opening a connection is slow, and the database allows only a limited number of them.',
    'A pool reuses a fixed set of connections and turns overload into a short queue.',
    'Pool size × app instances must fit inside the database limit.',
  ],
  quiz: [
    { q: 'Your database allows 100 connections. You run 6 app instances. Which pool size per instance is safe?',
      options: ['50', '20', '15'], answer: 2,
      why: '6 × 15 = 90, leaving room for migrations and admin sessions. 6 × 20 = 120 already exceeds the limit.' },
    { q: 'Requests start failing with "timeout waiting for a connection" while the database CPU sits at 5%. The most likely cause is:',
      options: ['The database is overloaded', 'Connections are being borrowed and not returned', 'The indexes are missing'], answer: 1,
      why: 'An idle database with an empty pool points to a leak, or to a slow call made while holding a connection.' },
    { q: 'Why does a very large pool (say 500) usually make things slower?',
      options: ['The database can only run about as many queries at once as it has CPU cores, so the rest just contend', 'Pools above 100 are not supported by drivers', 'Each connection adds 25 ms to every query'], answer: 0,
      why: 'Past the point of real parallelism, more connections add context switching, memory use and lock contention.' },
  ],
};
