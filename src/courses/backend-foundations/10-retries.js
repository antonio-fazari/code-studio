import { code, fmt, slider, bindSlider } from '../../ui.js';
import { simulateRetries } from '../../engines.js';

const strategies = [
  ['fixed', 'Retry every 100 ms', 'Every client retries immediately and keeps going.'],
  ['exp', 'Exponential backoff', 'Waits double each time: 100, 200, 400, 800 ms…'],
  ['jitter', 'Exponential backoff with jitter', 'Each wait is a random time between 0 and the backoff value.'],
];

export default {
  id: 'retries',
  title: 'Timeouts & Retries',
  hook: 'With backoff and jitter',
  incident: 'The payment provider slowed down for 3 minutes. ShopLite was down for 40.',
  buildsOn: 'ShopLite now depends on a database, Redis, a queue and a payment provider. Any of them can be slow or briefly unavailable. Retrying is only safe because of the idempotency keys from lesson 3.',
  problem: `
    <p>Two things went wrong in that incident, in order.</p>
    <p><strong>No timeout.</strong> The payment call had none, so when the provider slowed down, each checkout request waited. Each waiting request held a server thread and a pool connection (lesson 4). Within a minute every connection was held by a request waiting on payments, and pages that had nothing to do with payments stopped loading.</p>
    <p><strong>Eager retries.</strong> When the provider recovered, every ShopLite instance and every customer's app retried at the same instant. The provider was hit with several times its normal traffic and fell over again. This is a <em>retry storm</em>. It kept the outage going long after the original fault was fixed.</p>`,
  realWorld: `
    <p>When a call drops, you and the other person both redial at once and both get the engaged tone. You try again at the same moment, with the same result. It works when one of you waits a little longer than the other.</p>
    <p>Engineers at AWS published the analysis that made "exponential backoff with jitter" standard practice, and the AWS SDKs apply it to every call by default. Ethernet has used randomized backoff after collisions since the 1970s for the same reason.</p>`,
  approach: `
    <p><strong>1. Put a timeout on every network call.</strong> Pick it from the dependency's normal latency. If the payment provider's 99th percentile is 800 ms, a 2 second timeout is generous. Without one, a slow dependency is worse than a dead one: a dead one fails fast.</p>
    <p><strong>2. Retry only what is safe and likely to help.</strong> Retry timeouts, connection errors, 503 and 429. Do not retry 400 or 422, because the request is wrong and will stay wrong. Only retry operations that are idempotent or carry an idempotency key.</p>
    <p><strong>3. Back off exponentially, add jitter, and stop.</strong></p>
    ${code(`
async function callWithRetry(fn, { attempts = 4, base = 100, cap = 4000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn({ timeoutMs: 2000 });
    } catch (err) {
      if (!isRetryable(err) || attempt === attempts - 1) throw err;
      const backoff = Math.min(cap, base * 2 ** attempt);   // 100, 200, 400...
      await sleep(Math.random() * backoff);                  // full jitter
    }
  }
}`, 'js')}
    <p>Backoff reduces the total load on a struggling service. Jitter spreads what remains so clients do not arrive in synchronized waves. A limit on attempts keeps a request from retrying forever while the user has long since given up.</p>
    <p>When a dependency keeps failing, a <strong>circuit breaker</strong> goes one step further: after several failures in a row it stops calling for a short period and fails immediately, which gives the dependency room to recover.</p>`,
  sim: {
    title: 'A three-second outage',
    intro: 'The payment provider goes down at 0 s and returns at 3 s. Every client was mid-request and starts retrying. Each chart shows requests hitting the provider per 100 ms. Hover a bar for its value.',
    mount(root, ctx) {
      root.innerHTML = `
        ${slider('rt-clients', 'Clients:', 50, 500, 200, 50)}
        <div class="controls"><button class="btn ghost" id="rt-rerun">Run again with new random jitter</button></div>
        <div id="rt-charts"></div>
        <details class="tableview"><summary>Show the numbers as a table</summary><div class="tablewrap" id="rt-table"></div></details>`;
      let seed = 1;
      const get = bindSlider(root, 'rt-clients', String, (v, user) => { if (user) ctx.tried(); draw(v); });
      function draw(clients) {
        const runs = strategies.map(([key]) => simulateRetries({ clients, strategy: key, seed }));
        const max = clients; // shared scale: one full wave of every client
        root.querySelector('#rt-charts').innerHTML = strategies.map(([, name, desc], i) => {
          const r = runs[i];
          return `<figure class="chart">
            <figcaption><b>${name}.</b> ${desc}</figcaption>
            <div class="plot">
              <span class="ymax">${clients}</span>
              <div class="bars">${r.buckets.map((v, b) => `<i style="height:${Math.min(100, (v / max) * 100)}%" title="${(b / 10).toFixed(1)} s: ${v} requests"></i>`).join('')}</div>
            </div>
            <div class="xaxis"><span>0 s</span><span class="down">provider down</span><span class="mark">3 s: back up</span><span>8 s</span></div>
            <p class="chart-sum">${fmt(r.total)} requests in total. Largest wave after the first half second: <b>${r.peakRetryWave}</b> in 100 ms.</p>
          </figure>`;
        }).join('');
        root.querySelector('#rt-table').innerHTML = `<table><thead><tr><th>Strategy</th><th>Total requests</th><th>Largest later wave</th><th>Peak at recovery</th></tr></thead><tbody>${
          strategies.map(([, name], i) => `<tr><td>${name}</td><td>${fmt(runs[i].total)}</td><td>${runs[i].peakRetryWave}</td><td>${runs[i].peakAtRecovery}</td></tr>`).join('')}</tbody></table>`;
      }
      root.querySelector('#rt-rerun').onclick = () => { ctx.tried(); seed++; draw(get()); };
    },
  },
  tradeoffs: [
    ['Timeouts keep a slow dependency from tying up your threads and connections.', 'Too short and you cancel requests that would have succeeded. Too long and you are back to the pile-up. The right value needs latency data (lesson 11).'],
    ['Retries hide brief faults from users. Most network blips last milliseconds.', 'Retries multiply load exactly when a service is weakest. Three layers that each retry 3 times turn one request into 27.'],
    ['Backoff and jitter let a recovering service come back gradually.', 'The user waits longer for an answer. For interactive requests, a quick honest error often beats a slow success.'],
  ],
  avoid: `<p>Do not retry non-idempotent operations that carry no idempotency key. Do not retry at every layer: choose one place, usually closest to the user, and let the others fail fast. Do not retry errors that say the request itself is invalid. In a queue worker, prefer returning the message to the queue with a delay over sleeping in a loop.</p>`,
  shoplite: 'A 2 s timeout on the payment call, up to 3 retries with full jitter, the same idempotency key on each attempt, and a circuit breaker.',
  takeaways: [
    'Every network call needs a timeout. A slow dependency without one takes your whole service with it.',
    'Retry only safe operations and only transient errors, a limited number of times.',
    'Exponential backoff reduces the load. Jitter spreads it out.',
  ],
  quiz: [
    { q: 'What problem does jitter solve that exponential backoff alone does not?',
      options: ['It reduces the total number of retries', 'It stops clients that failed together from retrying together', 'It makes each retry faster'], answer: 1,
      why: 'Plain backoff keeps everyone in step: all clients wait 100 ms, then 200 ms, and arrive as one wave. Randomizing the wait spreads them out.' },
    { q: 'Which response should a client not retry?',
      options: ['503 Service Unavailable', '422 Unprocessable Entity', 'A connection timeout'], answer: 1,
      why: '422 means the request is invalid. Sending it again gives the same answer and adds load.' },
    { q: 'The payment call has no timeout and the provider starts taking 60 seconds to respond. What fails first in ShopLite?',
      options: ['Only the checkout endpoint', 'Any endpoint that needs a thread or pool connection, as waiting requests hold them all', 'Nothing, requests just take longer'], answer: 1,
      why: 'Waiting requests hold shared resources. This is how one slow dependency spreads into a full outage.' },
  ],
};
