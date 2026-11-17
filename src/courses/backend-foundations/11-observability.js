import { code, pill } from '../../ui.js';

const metrics = [
  ['api-gateway', '2,410', '0.1%', '38 ms', '2,460 ms', 'bad'],
  ['checkout-service', '310', '0.2%', '95 ms', '2,390 ms', 'bad'],
  ['payment-service', '305', '0.1%', '140 ms', '210 ms', ''],
  ['inventory-service', '330', '0.0%', '12 ms', '1,940 ms', 'bad'],
  ['catalog-service', '1,780', '0.0%', '4 ms', '31 ms', ''],
];
const logs = [
  ['14:02:11.204', 'INFO', 'api-gateway', 'POST /checkout 201 in 2412 ms', 'a41f9c'],
  ['14:02:11.190', 'INFO', 'checkout-service', 'order 88213 created', 'a41f9c'],
  ['14:02:11.050', 'INFO', 'payment-service', 'charge authorized in 162 ms', 'a41f9c'],
  ['14:02:10.880', 'WARN', 'inventory-service', 'slow query 1873 ms: SELECT … FROM reservations WHERE sku = $1 (seq scan, 4.1M rows)', 'a41f9c'],
  ['14:02:10.412', 'INFO', 'catalog-service', 'cache hit product:42', '77be02'],
  ['14:02:09.731', 'ERROR', 'email-worker', 'provider returned 503, message requeued (attempt 1)', 'c09d11'],
  ['14:02:08.990', 'INFO', 'api-gateway', 'GET /products/42 200 in 6 ms', '77be02'],
  ['14:02:08.801', 'INFO', 'api-gateway', 'POST /checkout 201 in 2380 ms', '5d20aa'],
  ['14:02:08.455', 'WARN', 'inventory-service', 'slow query 1902 ms: SELECT … FROM reservations WHERE sku = $1 (seq scan, 4.1M rows)', '5d20aa'],
];
// [service, operation, start ms, duration ms, depth]
const spans = [
  ['api-gateway', 'POST /checkout', 0, 2412, 0],
  ['api-gateway', 'auth + rate limit', 2, 6, 1],
  ['checkout-service', 'createOrder', 10, 2395, 1],
  ['inventory-service', 'reserveStock', 18, 1890, 2],
  ['postgres', 'SELECT reservations WHERE sku = ?', 24, 1873, 3],
  ['payment-service', 'authorizeCard', 1915, 165, 2],
  ['postgres', 'INSERT order + outbox', 2086, 9, 2],
  ['queue', 'publish order.placed', 2098, 3, 2],
];
const answers = [
  ['The payment provider is slow', false, 'Payment p99 is 210 ms and its span in the trace is 165 ms. It is healthy.'],
  ['The email worker is failing', false, 'It is logging errors, but it runs after the response, off the request path. It cannot slow checkout down. This is the queue from lesson 6 doing its job.'],
  ['inventory-service runs a query with no index on reservations.sku', true, 'The metrics narrowed it to inventory, the trace showed a 1.9 s database span, and the log line named the query and the sequential scan. One CREATE INDEX from lesson 1 fixes it.'],
  ['The API gateway is overloaded', false, 'The gateway\'s p99 is high only because it includes the time spent waiting for the services behind it. Its own work takes 6 ms in the trace.'],
];

export default {
  id: 'observability',
  title: 'Logs, Metrics, Traces',
  hook: 'Debug production without guessing',
  incident: 'Customers say checkout is slow. On your laptop it takes 80 ms. Nobody knows where the time goes.',
  buildsOn: 'ShopLite is now an API, a cache, a queue, workers and outside providers. A request crosses several of them, and the timeouts in lesson 10 can only be set well if you know what normal latency looks like.',
  problem: `
    <p>When the system was one process and one database, you could reproduce a bug locally and read the stack trace. Now a single checkout passes through a gateway, three services, a database, a cache and a queue. "It is slow" could be any of them, and it only happens under production data and production load.</p>
    <p>Without instrumentation, debugging means reading code and guessing. Teams in this position restart things until the problem goes away, and it comes back.</p>`,
  realWorld: `
    <p>A doctor uses three kinds of evidence. Vital signs say <em>that</em> something is wrong and since when. Your account of the day says <em>what happened</em>. A scan follows one thing through the body and shows <em>where</em> the blockage is.</p>
    <p>Google described tracing every request across thousands of services in its Dapper paper in 2010, which led to open tools such as Zipkin, Jaeger and today's OpenTelemetry standard. Prometheus and Grafana are the common open-source pair for metrics and dashboards.</p>`,
  approach: `
    <p>Each of the three signals answers a different question. You need all of them, and one id that links them.</p>
    <h3>Metrics: is something wrong?</h3>
    <p>Numbers aggregated over time: request rate, error rate, latency. They are cheap to store and they drive dashboards and alerts. Watch percentiles and not averages. An average of 120 ms can hide the 1 request in 100 that takes 2.4 s, and with enough traffic that is a lot of unhappy customers.</p>
    <h3>Logs: what exactly happened?</h3>
    <p>A record of individual events. Write them as structured JSON, not free text, so you can filter by field:</p>
    ${code(`
{"ts":"2026-03-04T14:02:10.880Z","level":"warn","service":"inventory-service",
 "trace_id":"a41f9c","msg":"slow query","duration_ms":1873,"table":"reservations"}`, 'json')}
    <h3>Traces: where did the time go?</h3>
    <p>The gateway assigns each request a <strong>trace id</strong> and passes it along in a header. Every service records <em>spans</em> (operation, start, duration) under that id. Put together, they form a waterfall of one request across the whole system.</p>
    ${code(`traceparent: 00-a41f9c0e8d2b4f6a9c1e3d5b7f902468-b7ad6b7169203331-01`, 'http')}
    <p>The working method is always the same: a <strong>metric</strong> alert tells you which service and when, a <strong>trace</strong> from that window shows which step is slow, and the <strong>logs</strong> for that trace id tell you why. Put the trace id in every log line and the three connect.</p>`,
  sim: {
    title: 'Find the slow step',
    intro: 'Checkout p99 jumped to 2.4 seconds at 14:00. You have the three tools. Start with metrics, follow a trace, read the logs, then name the cause.',
    mount(root, ctx) {
      const total = 2412;
      root.innerHTML = `
        <div class="tabs" role="tablist">
          <button class="tab" role="tab" data-tab="metrics" aria-selected="true">Metrics</button>
          <button class="tab" role="tab" data-tab="traces" aria-selected="false">Trace a41f9c</button>
          <button class="tab" role="tab" data-tab="logs" aria-selected="false">Logs</button>
        </div>
        <div data-pane="metrics" class="tablewrap">
          <table><thead><tr><th>Service</th><th>Requests/min</th><th>Errors</th><th>p50</th><th>p99</th></tr></thead><tbody>
          ${metrics.map(([s, r, e, p50, p99, cls]) => `<tr><td>${s}</td><td>${r}</td><td>${e}</td><td>${p50}</td><td class="${cls}">${p99}</td></tr>`).join('')}
          </tbody></table>
          <p class="sim-note">Medians look healthy everywhere. Three services have a bad p99, and two of them call the third.</p>
        </div>
        <div data-pane="traces" hidden>
          <div class="waterfall">
            ${spans.map(([svc, op, start, dur, depth]) => `
              <div class="span" title="${svc}: ${op}, ${dur} ms">
                <span class="span-name" style="padding-left:${depth * 12}px"><b>${svc}</b> ${op}</span>
                <span class="span-track"><i style="left:${(start / total) * 100}%;width:${Math.max(0.6, (dur / total) * 100)}%"></i></span>
                <span class="span-ms">${dur} ms</span>
              </div>`).join('')}
          </div>
          <p class="sim-note">One checkout request, 2,412 ms end to end. Bars are drawn to scale. Indented rows are calls made by the row above.</p>
        </div>
        <div data-pane="logs" hidden>
          <div class="controls">
            <label class="field" for="ob-filter"><span>Filter by trace id</span>
              <select id="ob-filter"><option value="">All requests</option><option>a41f9c</option><option>5d20aa</option><option>77be02</option><option>c09d11</option></select></label>
          </div>
          <ul class="log tall" id="ob-logs"></ul>
        </div>
        <h4>What is the root cause?</h4>
        <div class="options" id="ob-answers">${answers.map(([text], i) => `<button class="option" data-i="${i}">${text}</button>`).join('')}</div>
        <p class="sim-note" id="ob-result" role="status"></p>`;
      const $ = (sel) => root.querySelector(sel);
      root.querySelectorAll('.tab').forEach((tab) => tab.onclick = () => {
        ctx.tried();
        root.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', t === tab));
        root.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== tab.dataset.tab; });
      });
      const drawLogs = () => {
        const f = $('#ob-filter').value;
        $('#ob-logs').innerHTML = logs.filter((l) => !f || l[4] === f).map(([ts, level, svc, msg, trace]) =>
          `<li>${ts} ${pill(level, level === 'ERROR' ? 'bad' : level === 'WARN' ? 'warn' : 'ok')} <b>${svc}</b> ${msg} <span class="trace">trace=${trace}</span></li>`).join('');
      };
      $('#ob-filter').onchange = () => { ctx.tried(); drawLogs(); };
      drawLogs();
      $('#ob-answers').onclick = (e) => {
        const b = e.target.closest('.option'); if (!b) return;
        ctx.tried();
        const [, right, why] = answers[+b.dataset.i];
        root.querySelectorAll('#ob-answers .option').forEach((o) => o.classList.remove('right', 'wrong'));
        b.classList.add(right ? 'right' : 'wrong');
        $('#ob-result').innerHTML = pill(right ? 'Correct' : 'Not the cause', right ? 'ok' : 'bad') + ' ' + why;
      };
    },
  },
  tradeoffs: [
    ['<strong>Metrics</strong> are cheap, fast to query and ideal for alerts and trends.', 'They are aggregates. They show that p99 rose, never which request or why. Adding high-cardinality labels such as user id makes them very expensive.'],
    ['<strong>Logs</strong> carry full detail about a single event.', 'Volume and cost grow with traffic. Without structure and a trace id they are a haystack, and they can leak personal data if you log carelessly.'],
    ['<strong>Traces</strong> show cause and effect across services for one request.', 'Every service must pass the context along, or the trace breaks. Storing all traces is costly, so most teams sample, and the one you want may not have been kept.'],
  ],
  avoid: `<p>Do not log everything at full detail "in case". It costs money and buries the lines that matter. Never log passwords, tokens or card numbers. Do not alert on every metric: page a human for symptoms users feel (error rate, latency), and leave causes such as CPU for dashboards. A single small service can start with structured logs and four numbers: rate, errors, latency and saturation.</p>`,
  shoplite: 'Structured JSON logs with a trace id, rate/error/latency metrics per endpoint, and OpenTelemetry tracing across services and the queue.',
  takeaways: [
    'Metrics tell you that something is wrong, traces tell you where, logs tell you why.',
    'Watch percentiles. Averages hide the slow requests.',
    'One trace id, passed through every service and written on every log line, ties it all together.',
  ],
  quiz: [
    { q: 'An endpoint has an average latency of 110 ms and a p99 of 3 s. What does that mean?',
      options: ['Most requests take 3 s', 'About 1 request in 100 takes 3 s or longer, and the average hides it', 'The measurement is broken'], answer: 1,
      why: 'At 1,000 requests a minute, that is 10 slow requests every minute. Percentiles show the experience of the unlucky users.' },
    { q: 'You are paged for high checkout latency. Which signal do you open first to find which service is responsible?',
      options: ['Raw logs from every service', 'Metrics per service, then a trace from the affected window', 'The source code'], answer: 1,
      why: 'Metrics narrow the search to a service and a time. A trace then shows the slow step. Logs for that trace explain it.' },
    { q: 'What makes it possible to pull up every log line belonging to one customer\'s failed request across five services?',
      options: ['Synchronized clocks', 'A trace id generated at the edge and included in every log line', 'Logging at DEBUG level'], answer: 1,
      why: 'The shared id is the join key between services and between logs and traces.' },
  ],
};
