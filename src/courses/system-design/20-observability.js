import { code, pill, slider, bindSlider, stats } from '../../ui.js';
import { allowedDowntimeMin, budgetUsed } from '../../engines-sd.js';

/** The checkout trace: gateway → auth, then orders → db. Timings in ms. */
function trace({ index, cacheAuth }) {
  const auth = cacheAuth ? 2 : 22, db = index ? 6 : 56;
  const authStart = 8, authEnd = authStart + auth;
  const ordersStart = authEnd + 4, dbStart = ordersStart + 18, dbEnd = dbStart + db, ordersEnd = dbEnd + 8;
  const gatewayEnd = ordersEnd + 4;
  return [
    { name: 'gateway', start: 0, end: gatewayEnd, depth: 0, self: gatewayEnd - auth - (ordersEnd - ordersStart) },
    { name: 'auth', start: authStart, end: authEnd, depth: 1, self: auth },
    { name: 'orders', start: ordersStart, end: ordersEnd, depth: 1, self: ordersEnd - ordersStart - db },
    { name: 'db', start: dbStart, end: dbEnd, depth: 2, self: db, db: true },
  ];
}

export default {
  id: 'sd-observability',
  part: 'Part 4: Services',
  title: 'Observability at Scale',
  hook: 'Traces across services, SLOs, and an error budget that tells you when to stop shipping',
  incident: 'Every dashboard was green, and the average checkout took 120 ms. Meanwhile 1 checkout in 50 took over 4 seconds, and those were the customers with the biggest carts.',
  revisits: { id: 'observability', note: 'That lesson introduced logs, metrics and traces for one request through a few services. Here there are dozens of services and millions of requests, and the questions become which data to keep and when to act.' },
  buildsOn: 'ShopLite is now a global system: CDN, load balancers, autoscaled services, sharded and replicated data, queues and breakers. Every lesson in this course added a component that can be slow or failing. You need to see all of it, and to know which problems matter.',
  problem: `
    <p>At this scale, three new problems appear on top of Course 1's:</p>
    <ul>
      <li><strong>Averages lie, and so do healthy-looking components.</strong> Each service can look fine on its own while the path through five of them is slow for some users.</li>
      <li><strong>You cannot keep everything.</strong> Tracing every one of millions of requests a minute costs more than the system it watches. Whatever you sample, the interesting requests are rare.</li>
      <li><strong>Alerts need a definition of "bad enough".</strong> With hundreds of metrics, something is always red. Paging on every blip burns out the on-call engineer; paging on nothing loses customers.</li>
    </ul>`,
  realWorld: `
    <p>A hospital puts a barcode wristband on each patient. Every department scans it, so the patient's whole journey can be reconstructed afterwards: triage, X-ray, the two hours waiting for a bed. A distributed trace is that wristband for a request. The simulation below shows one: a gateway span that contains a call to auth, then a call to orders, which contains a database query.</p>
    <p>Google described tracing across its services in the 2010 Dapper paper, and its Site Reliability Engineering book (2016) introduced service level objectives and error budgets to the wider industry. OpenTelemetry, formed in 2019 by merging OpenTracing and OpenCensus, is now the standard way to emit traces, metrics and logs from any language to any backend.</p>`,
  approach: `
    <h3>Read a trace by self time and critical path</h3>
    <p>A span's total time includes its children. Its <strong>self time</strong> (total minus children) is the work it did itself. The <strong>critical path</strong> is the chain of spans that determined when the request finished; speeding up anything off it changes nothing. In the trace below, the database call is 56 of the 120 ms and sits on the critical path, so it is where to look first.</p>
    <h3>Sample traces sensibly</h3>
    <ul>
      <li><strong>Head sampling</strong> decides at the start (keep 1%). Cheap, but 99% of slow and failed requests are thrown away before anyone knows they were interesting.</li>
      <li><strong>Tail sampling</strong> decides at the end: keep every error, every request slower than the p99, and a small share of the rest. It costs a buffer in a collector, and it keeps the traces you will want.</li>
    </ul>
    <h3>SLIs, SLOs and error budgets</h3>
    <p>A <strong>service level indicator</strong> measures what users feel: the share of checkouts that succeed within 500 ms. A <strong>service level objective</strong> is the target for it: 99.9% over 30 days. The <strong>error budget</strong> is what is left: 0.1%, which is about 43 minutes of total outage a month, or more time at a partial error rate.</p>
    ${code(`
# SLO: 99.9% of checkout requests succeed in under 500 ms, over 30 days
- alert: CheckoutErrorBudgetFastBurn
  # Burning the monthly budget 14× faster than allowed, sustained for an hour:
  # at this rate the whole month's budget is gone in about 2 days.
  expr: |
    (1 - sum(rate(checkout_requests_good_total[1h])) / sum(rate(checkout_requests_total[1h])))
      > 14 * (1 - 0.999)
  for: 5m
  labels: { severity: page }`, 'yaml')}
    <p>The budget turns arguments into policy. While budget remains, ship features. When it is spent, pause risky releases and work on reliability. Alerts fire on the <strong>burn rate</strong>, how fast the budget is being used, rather than on every brief error spike.</p>
    <h3>Watch cardinality</h3>
    <p>Each unique combination of metric labels is a separate time series. A label such as <code>customer_id</code> turns one metric into millions and can overwhelm a metrics system. Put high-cardinality detail in traces and logs, which are built for it, and keep metric labels to small, bounded sets.</p>`,
  sim: {
    title: 'Read the trace, then spend the budget',
    intro: 'This is one checkout request as a trace. Hover a span for its timings. Apply each fix and see which one moves the total. Then set an SLO and see how much of the month an incident uses.',
    mount(root, ctx) {
      root.innerHTML = `
        <div class="controls">
          <label class="check" for="ob-index"><input type="checkbox" id="ob-index"> Add the missing index to the db query</label>
          <label class="check" for="ob-auth"><input type="checkbox" id="ob-auth"> Cache token checks in auth</label>
        </div>
        <div class="chartbox" id="ob-trace"></div>
        <div class="tablewrap"><table id="ob-self"></table></div>
        <h4>Error budget</h4>
        <div class="controls">
          <label class="field" for="ob-slo"><span>SLO for checkout</span><select id="ob-slo"><option value="0.99">99%</option><option value="0.999" selected>99.9%</option><option value="0.9999">99.99%</option></select></label>
        </div>
        ${slider('ob-rate', 'Incident: share of checkouts failing:', 1, 100, 20)}
        ${slider('ob-min', 'Incident: duration:', 1, 240, 30)}
        <div class="meter" id="ob-meter" aria-hidden="true"><i></i></div>
        <div class="stats" id="ob-stats"></div>
        <p class="sim-note" id="ob-note" role="status"></p>`;
      const $ = (id) => root.querySelector(id);
      const drawTrace = (user) => {
        if (user) ctx.tried();
        const spans = trace({ index: $('#ob-index').checked, cacheAuth: $('#ob-auth').checked });
        const total = spans[0].end, W = 600, pad = 80, H = spans.length * 32 + 34, max = 120;
        const x = (t) => pad + (t / max) * (W - pad - 70);
        $('#ob-trace').innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="svgchart" role="img" aria-label="Checkout trace waterfall, ${total} ms in total">
          ${[0, 40, 80, 120].map((t) => `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="4" y2="${H - 22}"/><text class="axis" x="${x(t)}" y="${H - 6}" text-anchor="middle">${t}${t === 120 ? ' ms' : ''}</text>`).join('')}
          ${spans.map((s, i) => `<g><title>${s.name}: ${s.start} to ${s.end} ms (${s.end - s.start} ms, ${s.self} ms self)</title>
            <text class="label" x="${8 + s.depth * 12}" y="${i * 32 + 22}">${s.name}</text>
            ${s.depth ? `<line class="connector" x1="${x(s.start)}" x2="${x(s.start)}" y1="${i * 32 - 4}" y2="${i * 32 + 10}"/>` : ''}
            <rect class="${s.db ? 'span-db' : 'span-svc'}" x="${x(s.start)}" y="${i * 32 + 9}" width="${Math.max(2, x(s.end) - x(s.start))}" height="18" rx="2"/>
            <text class="label" x="${x(s.end) + 6}" y="${i * 32 + 22}">${s.end - s.start} ms</text></g>`).join('')}
        </svg>`;
        const worst = spans.reduce((a, b) => (b.self > a.self ? b : a));
        $('#ob-self').innerHTML = `<thead><tr><th>Span</th><th>Total</th><th>Self time</th><th>Share of the request</th></tr></thead><tbody>${spans.map((s) => `<tr><td>${s.name}</td><td>${s.end - s.start} ms</td><td class="${s === worst ? 'bad' : ''}">${s.self} ms</td><td>${Math.round((s.self / total) * 100)}%</td></tr>`).join('')}</tbody>`;
      };
      let rate, mins;
      const drawBudget = (v, user) => {
        if (user) ctx.tried();
        if (!rate || !mins) return;
        const slo = +$('#ob-slo').value;
        const used = budgetUsed({ slo, requestsPerMonth: 50_000_000, errorRate: rate() / 100, minutes: mins() });
        $('#ob-meter').firstElementChild.style.width = Math.min(100, used * 100) + '%';
        $('#ob-meter').className = 'meter ' + (used >= 1 ? 'over' : used > 0.5 ? 'high' : '');
        stats($('#ob-stats'), [
          ['Full outage allowed per 30 days', allowedDowntimeMin(slo).toFixed(allowedDowntimeMin(slo) < 10 ? 1 : 0) + ' min'],
          ['Budget used by this incident', Math.round(used * 100) + '%', used >= 1 ? 'bad' : used > 0.5 ? 'warn' : 'ok'],
          ['Failed checkouts (50 M a month)', Math.round((50_000_000 / 43200) * mins() * (rate() / 100)).toLocaleString('en-US')],
        ]);
        $('#ob-note').textContent = used >= 1 ? 'The month\'s budget is spent. By the policy, risky releases pause until reliability work brings the numbers back.' : used > 0.5 ? 'More than half the month\'s budget is gone in one incident. Expect to slow releases down.' : 'Within budget. This is the room the SLO gives you to ship changes and take risks.';
      };
      $('#ob-index').onchange = $('#ob-auth').onchange = () => drawTrace(true);
      $('#ob-slo').onchange = () => drawBudget(0, true);
      rate = bindSlider(root, 'ob-rate', (v) => v + '%', drawBudget);
      mins = bindSlider(root, 'ob-min', (v) => v + ' min', drawBudget);
      drawTrace(false); drawBudget();
    },
  },
  tradeoffs: [
    ['Distributed traces show where time goes across every service for a single request.', 'Every service must propagate context, including through queues. One gap breaks the trace, and storage costs push you to sample.'],
    ['Tail sampling keeps the slow and failed requests that matter.', 'It needs collectors that buffer whole traces before deciding, which is more infrastructure to run.'],
    ['SLOs and error budgets give a shared, numeric answer to "is it reliable enough?" and "may we ship?"', 'Picking the right SLI is hard, and an SLO nobody enforces is just another dashboard.'],
  ],
  avoid: `<p>Do not set SLOs of 99.99% or higher by default. Each extra nine costs far more engineering, and users often cannot tell the difference through their own network. Do not page on causes (CPU, a single pod restart); page on SLO burn and leave causes to dashboards. And do not add high-cardinality labels to metrics.</p>`,
  shoplite: 'OpenTelemetry in every service and across the queues, tail sampling that keeps all errors and slow traces, a 99.9% SLO on checkout success under 500 ms, and burn-rate alerts that page.',
  takeaways: [
    'Read traces by self time and critical path to find the step worth fixing.',
    'Sample at the tail: keep the errors and slow requests, not a random 1%.',
    'An SLO defines "reliable enough". The error budget tells you when to stop shipping and fix things.',
  ],
  quiz: [
    { q: 'In the trace, gateway takes 120 ms, auth 22 ms, orders 82 ms and the db call inside orders 56 ms. Where is the biggest self time?',
      options: ['gateway', 'orders', 'db'], answer: 2,
      why: 'Gateway\'s own time is 120 − 22 − 82 = 16 ms, orders\' is 82 − 56 = 26 ms, and the db call is 56 ms of its own.' },
    { q: 'You keep 1% of traces, chosen at the start of each request. What is the problem?',
      options: ['Traces become less accurate', 'Most slow and failed requests are discarded before anyone knows they were interesting', 'It breaks context propagation'], answer: 1,
      why: 'Head sampling cannot know how the request will end. Tail sampling decides after.' },
    { q: 'Checkout has a 99.9% SLO over 30 days. Roughly how long a complete outage does the error budget allow?',
      options: ['About 4 minutes', 'About 43 minutes', 'About 7 hours'], answer: 1,
      why: '0.1% of 30 days is 43.2 minutes. 99.99% would allow about 4 minutes, and 99% about 7 hours.' },
  ],
};
