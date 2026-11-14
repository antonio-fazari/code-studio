// The final page: how the twelve pieces fit into one request, and a build checklist.

const path = [
  ['Edge', 'The request arrives with an API key or session cookie.', []],
  ['Rate limiter', 'One token is taken from the caller\'s bucket in Redis. Empty bucket: 429 with Retry-After.', ['rate-limiting']],
  ['Auth', 'The session or JWT is verified, and the cart is checked to belong to this customer.', ['auth']],
  ['Idempotency check', 'The Idempotency-Key is looked up. If it was seen before, the saved response is returned and nothing else runs.', ['idempotency']],
  ['Database work', 'A pooled connection is borrowed. One short transaction reserves stock with a conditional UPDATE, inserts the order, the idempotency key and an outbox row. Every lookup uses an index.', ['pooling', 'transactions', 'indexes']],
  ['Payment provider', 'Called outside the transaction with a 2 s timeout, the same idempotency key, and up to three retries with backoff and jitter.', ['retries', 'idempotency']],
  ['Response', '201 Created in roughly 250 ms. The product cache entry for the item is deleted so stock displays refresh.', ['caching']],
  ['After the response', 'A worker takes the order.placed message, sends the email and invoice, and acknowledges. Failures go back on the queue, then to the dead-letter queue.', ['queues']],
];

const tasks = [
  ['t-indexes', 'indexes', 'Seed 1 million orders. Show with EXPLAIN ANALYZE that order lookup by customer uses an index.'],
  ['t-transactions', 'transactions', 'Fire 50 concurrent checkouts at a product with stock 10. Exactly 10 succeed and stock ends at 0.'],
  ['t-idempotency', 'idempotency', 'Send the same POST /orders twice with one Idempotency-Key. One order exists and both responses match.'],
  ['t-pooling', 'pooling', 'Use one shared pool. Under a load test, database connections stay at or below the pool size.'],
  ['t-caching', 'caching', 'Cache GET /products/:id in Redis with a TTL. Editing a product deletes its key.'],
  ['t-queues', 'queues', 'Send the confirmation email from a worker. Stopping the worker does not stop orders being accepted.'],
  ['t-rate-limiting', 'rate-limiting', 'Add a token bucket per API key. Request 11 in one second gets 429 and a Retry-After header.'],
  ['t-auth', 'auth', 'Add login. A customer who requests another customer\'s order gets 404 or 403, never the order.'],
  ['t-pagination', 'pagination', 'GET /orders returns a next_cursor. Page 10,000 responds as fast as page 1.'],
  ['t-retries', 'retries', 'Wrap the payment call with a timeout and jittered retries. A fake provider that fails twice still yields one charge.'],
  ['t-observability', 'observability', 'Every log line is JSON with a trace id. Expose request rate, error rate and p99 latency.'],
  ['t-docker', 'docker', 'docker compose up starts the API, worker, PostgreSQL and Redis on a clean machine.'],
];

export function renderCapstone(el, { lessons, store }) {
  const byId = Object.fromEntries(lessons.map((l, i) => [l.id, { ...l, n: i + 1 }]));
  const chip = (id) => `<a class="chip" href="#${id}">${byId[id].n}. ${byId[id].title}</a>`;
  const done = store.completedCount(lessons);
  el.innerHTML = `
    <header class="lesson-head">
      <p class="eyebrow">Capstone</p>
      <h1>Build one API using all of these</h1>
      <p class="hook">That is your project.</p>
    </header>
    <p>You have followed ShopLite from one slow query to a system that survives retries, traffic spikes and failing dependencies. The best way to keep what you learned is to build it yourself. This page shows how the pieces fit in a single request, then gives you a checklist with a test for each one.</p>
    ${done < lessons.length ? `<p class="callout">You have completed ${done} of ${lessons.length} lessons. You can read this page now, and it will make more sense once the rest are done.</p>` : ''}

    <section>
      <h2>One checkout request, end to end</h2>
      <p><code>POST /checkout</code> travels through every concept in the course. All of it runs from one container image, and each step emits logs, metrics and a trace span under one trace id.</p>
      <ol class="flow">
        ${path.map(([name, text, ids]) => `<li><div class="flow-name">${name}</div><div class="flow-body"><p>${text}</p>${ids.length ? `<div class="chips">${ids.map(chip).join('')}</div>` : ''}</div></li>`).join('')}
      </ol>
      <p>Around that path: ${chip('pagination')} serves the order history, ${chip('observability')} watches every step, and ${chip('docker')} packages the whole thing.</p>
    </section>

    <section>
      <h2>Build checklist</h2>
      <p>Pick any language and framework you like. PostgreSQL and Redis are enough infrastructure for all twelve items. Tick each one when its test passes. Your ticks are saved with your progress.</p>
      <ul class="tasks" id="tasks">
        ${tasks.map(([id, lesson, text]) => `
          <li><label class="check" for="${id}"><input type="checkbox" id="${id}" ${store.state.tasks[id] ? 'checked' : ''}>
            <span><b>${byId[lesson].title}.</b> ${text}</span></label></li>`).join('')}
      </ul>
      <p class="sim-note" id="tasks-count" role="status"></p>
    </section>

    <section>
      <h2>A sensible order to build in</h2>
      <ol>
        <li>Start with Docker Compose, PostgreSQL and a bare orders API, so everything after runs the same everywhere.</li>
        <li>Make the data layer correct: indexes, transactions, idempotency keys, a pool.</li>
        <li>Add structured logs and metrics early. You will want them for every later step.</li>
        <li>Then the parts that protect and speed up the API: auth, rate limiting, pagination, caching.</li>
        <li>Finish with the queue and worker, and the payment call with timeouts and retries.</li>
      </ol>
    </section>`;
  const count = () => {
    const n = tasks.filter(([id]) => store.state.tasks[id]).length;
    el.querySelector('#tasks-count').textContent = n === tasks.length ? 'All 12 done. You have built a production-shaped API.' : `${n} of ${tasks.length} done.`;
  };
  el.querySelector('#tasks').addEventListener('change', (e) => { if (e.target.matches('input')) { store.toggleTask(e.target.id); count(); } });
  count();
}
