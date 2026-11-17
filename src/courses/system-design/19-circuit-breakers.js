import { code, log, pill, stats } from '../../ui.js';
import { CircuitBreaker } from '../../engines-sd.js';

const deps = { ok: 'Healthy (40 ms)', fail: 'Failing fast (errors in 5 ms)', hang: 'Hanging (no reply until the 2 s timeout)' };

export default {
  id: 'sd-circuit-breakers',
  part: 'Part 4: Services',
  title: 'Circuit Breakers',
  hook: 'Stop calling a dependency that is failing, so its failure does not become yours',
  incident: 'The recommendations service started hanging at 7:40 pm. By 7:44 the product page, the cart and checkout were all down, although none of them needed recommendations to work.',
  buildsOn: 'ShopLite\'s services call each other (lesson 16) with timeouts and retries (Course 1). Timeouts stop one call from waiting forever. They do not stop thousands of calls from each waiting two seconds.',
  problem: `
    <p>Every product page calls the recommendations service with a 2 second timeout. When recommendations hung, each page request waited the full 2 seconds before giving up. At 500 page views a second, that is 1,000 requests at a time stuck waiting, each holding a thread, a connection and memory. The API servers ran out of all three, and requests that had nothing to do with recommendations queued behind them.</p>
    <p>Retries made it worse: each failure was tried again, tripling the load on a service that was already down. This is a <strong>cascading failure</strong>: one unhealthy dependency takes down everything upstream of it.</p>`,
  realWorld: `
    <p>The name comes from the electrical breaker in your house. When a faulty appliance draws too much current, the breaker trips and cuts that circuit, so the wiring does not catch fire and the rest of the house keeps its power. You reset it once the fault is fixed.</p>
    <p>Michael Nygard popularised the pattern for software in his 2007 book <em>Release It!</em>. Netflix built it into Hystrix, open-sourced in 2012, after outages where one failing service cascaded through its API. Hystrix is now in maintenance mode; the same ideas live on in Resilience4j and in service meshes such as Envoy and Istio, which can eject failing backends without any application code.</p>`,
  approach: `
    <p>A circuit breaker wraps calls to one dependency and has three states:</p>
    <ul>
      <li><strong>Closed</strong>: calls pass through normally. The breaker counts failures (errors and timeouts).</li>
      <li><strong>Open</strong>: after too many failures (say 5 in a row, or 50% in the last 10 seconds), the breaker trips. Calls fail immediately without touching the network, and the caller uses a fallback.</li>
      <li><strong>Half-open</strong>: after a cool-down (say 5 seconds), one trial call is allowed through. Success closes the breaker; failure opens it again for another cool-down.</li>
    </ul>
    ${code(`
const recsBreaker = new CircuitBreaker(fetchRecommendations, {
  timeout: 300,                 // a recommendation slower than this is not worth waiting for
  errorThresholdPercentage: 50, // trip when half of recent calls fail
  resetTimeout: 5000,           // try again after 5 s
});
recsBreaker.fallback(() => bestsellersFromCache());   // degrade, do not fail

const recommendations = await recsBreaker.fire(cartId);`, 'js')}
    <p>The breaker is only half of the design. The other half is deciding what the page does without the dependency: a <strong>fallback</strong>. Recommendations can fall back to cached bestsellers, reviews can be hidden, a currency converter can use yesterday's rate. Only dependencies that are truly essential (payment at checkout) should fail the request.</p>
    <p>Related patterns:</p>
    <ul>
      <li><strong>Bulkheads</strong>: give each dependency its own small pool of threads or connections, so one slow dependency can exhaust only its own pool. The name comes from the watertight compartments in a ship's hull.</li>
      <li><strong>Short timeouts</strong> for optional calls. A recommendation that takes 2 seconds is worthless anyway.</li>
      <li><strong>Retry budgets</strong>: retry only while the breaker is closed, and cap retries to a small share of traffic.</li>
    </ul>`,
  sim: {
    title: 'The product page and its recommendations',
    intro: 'Product page requests arrive continuously. Each calls the recommendations service. Make the service fail or hang, and compare the page with and without a breaker. The breaker trips after 5 failures and tries again after 5 seconds.',
    mount(root, ctx) {
      root.innerHTML = `
        <div class="controls">
          <label class="field" for="cb-dep"><span>Recommendations service</span><select id="cb-dep">${Object.entries(deps).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <label class="check" for="cb-on"><input type="checkbox" id="cb-on" checked> Circuit breaker</label>
          <label class="check" for="cb-fb"><input type="checkbox" id="cb-fb" checked> Fall back to cached bestsellers</label>
          <button class="btn ghost" id="cb-reset">Reset counters</button>
        </div>
        <div class="breaker" id="cb-state" aria-live="polite"></div>
        <div class="stats" id="cb-stats"></div>
        <ul class="log" id="cb-log"></ul>`;
      const $ = (id) => root.querySelector(id);
      let b, s, lastState;
      const reset = () => { b = new CircuitBreaker({ threshold: 5, openMs: 5000 }); s = { pages: 0, full: 0, degraded: 0, errors: 0, waitMs: 0, calls: 0 }; lastState = 'closed'; $('#cb-log').innerHTML = ''; draw(); };
      const draw = () => {
        const on = $('#cb-on').checked, st = on ? b.state : 'none';
        $('#cb-state').innerHTML = on ? ['closed', 'open', 'half-open'].map((x) => `<span class="bstate ${x === st ? 'on ' + x : ''}">${x === 'closed' ? 'Closed: calls pass' : x === 'open' ? 'Open: fail fast' : 'Half-open: one trial'}</span>`).join('<span class="barrow">→</span>') : '<span class="bstate">No breaker: every request calls the service</span>';
        const avgWait = s.pages ? s.waitMs / s.pages : 0;
        stats($('#cb-stats'), [
          ['Pages served', s.pages], ['With recommendations', s.full, 'ok'], ['With bestsellers instead', s.degraded, s.degraded ? 'warn' : ''],
          ['Pages that failed', s.errors, s.errors ? 'bad' : 'ok'], ['Average wait on recommendations', Math.round(avgWait) + ' ms', avgWait > 500 ? 'bad' : ''],
          ['Calls reaching the failing service', s.calls],
        ]);
      };
      const tick = () => {
        const now = Date.now(), dep = $('#cb-dep').value, on = $('#cb-on').checked, fb = $('#cb-fb').checked;
        for (let i = 0; i < 3; i++) {
          s.pages++;
          const allowed = !on || b.canRequest(now);
          let ok = false, wait = 0;
          if (allowed) {
            if (dep !== 'ok') s.calls++;
            wait = dep === 'ok' ? 40 : dep === 'fail' ? 5 : 2000;
            ok = dep === 'ok';
            if (on) ok ? b.success() : b.failure(now);
          }
          s.waitMs += wait;
          if (ok) s.full++; else if (fb) s.degraded++; else s.errors++;
        }
        if (on && b.state !== lastState) {
          const msg = { open: `${pill('open', 'bad')} ${b.threshold} failures in a row. The breaker trips: calls now fail instantly${fb ? ' and pages show bestsellers' : ''}.`, 'half-open': `${pill('half-open', 'warn')} Cool-down over. One trial call is let through.`, closed: `${pill('closed', 'ok')} The trial call succeeded. Normal service resumes.` }[b.state];
          log($('#cb-log'), msg);
          lastState = b.state;
        }
        draw();
      };
      $('#cb-reset').onclick = () => { ctx.tried(); reset(); };
      root.querySelectorAll('select, input').forEach((el) => (el.onchange = () => { ctx.tried(); if (el.id === 'cb-on') reset(); draw(); }));
      reset();
      ctx.every(400, tick);
    },
  },
  tradeoffs: [
    ['A failing dependency costs microseconds per request instead of a full timeout, so threads and connections stay free.', 'While open, the breaker rejects calls that might have succeeded. Thresholds tuned too tight cause flapping.'],
    ['The failing service gets breathing room to recover instead of a retry storm.', 'Each instance has its own breaker and its own view, so instances may disagree for a while.'],
    ['Fallbacks keep the main journey working: the page loads, just with less on it.', 'Every fallback is a code path that is rarely exercised. Test it deliberately, or it will fail the one time it is needed.'],
  ],
  avoid: `<p>A breaker is pointless around a call with nothing else to do on failure and no shared resources at stake, such as a nightly batch job's single call. It is also no substitute for timeouts: a breaker counts failures, and without a timeout a hanging call never fails. Do not wrap the database your service cannot work without in a breaker that makes every request fail for 5 seconds; there, fail fast and alert instead.</p>`,
  shoplite: 'Breakers around every optional dependency (recommendations, reviews, promotions, currency rates) with cached fallbacks, 300 ms timeouts for optional calls, and separate connection pools per dependency.',
  takeaways: [
    'A timeout limits one call. A circuit breaker stops making calls that are going to fail.',
    'Closed counts failures, open fails fast, half-open tests whether the dependency has recovered.',
    'Decide the fallback for each dependency. A degraded page beats an error page.',
  ],
  quiz: [
    { q: 'Why can a hanging dependency do more damage than one that returns errors immediately?',
      options: ['Hanging calls use more bandwidth', 'Every call waits for the full timeout, tying up threads and connections until the caller runs out', 'Errors are cached, hangs are not'], answer: 1,
      why: 'Fast failures cost little. Slow ones accumulate until the calling service is stuck too.' },
    { q: 'What does a breaker do in the half-open state?',
      options: ['Lets half of all calls through', 'Lets a trial call through to see whether the dependency has recovered', 'Retries every failed call'], answer: 1,
      why: 'One successful probe closes it again. A failed probe opens it for another cool-down.' },
    { q: 'For which dependency is a cached fallback most appropriate?',
      options: ['Card authorisation at checkout', 'Product recommendations', 'Writing the order to the database'], answer: 1,
      why: 'A slightly stale or generic recommendation is fine. A fake payment approval or a missing order is not.' },
  ],
};
