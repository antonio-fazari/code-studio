import { code, ms, slider, bindSlider, stats } from '../../ui.js';
import { chainAvailability, monthlyDowntimeMin } from '../../engines-sd.js';

const HOP_MS = 12; // about 2 ms of network and serialisation plus 10 ms of work per service call

export default {
  id: 'sd-microservices',
  part: 'Part 4: Services',
  title: 'Microservices',
  hook: 'Split the system by team and business capability, and pay for every network hop',
  incident: 'Forty engineers share one codebase and one deploy pipeline. A typo in the reviews code blocked a checkout bug fix from shipping for a day.',
  buildsOn: 'ShopLite\'s data layer is now replicated, sharded and coordinated. The application is still one large program owned by everyone, which means nobody can change their part without waiting for everyone else.',
  problem: `
    <p>A monolith is not a technical failure. It is simple to run, easy to test, and calls between modules are function calls that never time out. The problems are organisational, and they grow with the team:</p>
    <ul>
      <li>Every change ships in the same release, so one broken module blocks every other team.</li>
      <li>The whole program scales as one unit, even when only search is busy.</li>
      <li>Boundaries erode. Any code can reach into any table, and over time everything depends on everything.</li>
    </ul>
    <p><strong>Microservices</strong> split the system into separately deployed services, each owned by one team and each owning its data. They fix those problems by turning function calls into network calls, and network calls are slower and can fail.</p>`,
  realWorld: `
    <p>A food court is a set of microservices: each kitchen has its own staff, menu, equipment and opening hours, and one kitchen running out of rice does not close the others. A single restaurant kitchen is a monolith: one team, shared equipment, easier coordination, and one fire closes everything.</p>
    <p>Around 2002, Amazon required every team to expose its data only through service interfaces, an instruction later made famous by Steve Yegge's widely shared memo. Netflix began moving off its monolith after a database corruption in 2008 stopped it shipping DVDs for three days. The pendulum also swings back: Segment wrote "Goodbye Microservices" in 2018 after merging over a hundred services into one, and in 2023 Amazon Prime Video reported cutting a monitoring system's infrastructure cost by 90% by moving it from distributed components into a single process.</p>`,
  approach: `
    <p><strong>Split by business capability, not by technical layer.</strong> "Catalogue", "Checkout", "Payments", "Shipping" can each change and deploy alone. "Database service" and "validation service" cannot; every feature would touch all of them.</p>
    <p><strong>Each service owns its data.</strong> No other service reads its tables. Others ask through its API or listen to its events. A shared database brings back all the coupling of the monolith with none of the simplicity.</p>
    <p><strong>Choose how services talk.</strong> Synchronous calls (HTTP, gRPC) when the caller needs the answer now. Events on a queue (lesson 17) when others only need to know something happened. Each synchronous dependency adds latency and a way to fail.</p>
    ${code(`
// Checkout calls only what it must, in parallel where it can,
// and treats nice-to-have data as optional.
const [cart, customer] = await Promise.all([
  carts.get(cartId, { timeout: 300 }),
  customers.get(customerId, { timeout: 300 }),
]);
const recommendations = await recs.forCart(cartId, { timeout: 150 }).catch(() => []);   // optional`, 'js')}
    <p><strong>Budget for the platform.</strong> Microservices need automated deploys, service discovery, an API gateway, distributed tracing (lesson 20), and protection against cascading failure (lesson 19). Without them, you have a distributed monolith: all of the network costs and none of the independence.</p>
    <p>A sensible path is the <strong>modular monolith</strong>: one deployable, but with strict module boundaries and no shared tables. Extract a module into a service when a team, a scaling need or a failure boundary justifies it.</p>`,
  sim: {
    title: 'The cost of a hop',
    intro: 'One page load calls several services in a chain. Each one is up 99.9% of the time and adds about 12 ms. See what happens to the page as the chain grows, and what parallel calls and optional dependencies buy back.',
    mount(root, ctx) {
      root.innerHTML = `
        ${slider('ms-hops', 'Services a page load depends on:', 1, 15, 6)}
        <div class="controls">
          <label class="field" for="ms-avail"><span>Each service\'s availability</span><select id="ms-avail"><option value="0.999">99.9%</option><option value="0.9995">99.95%</option><option value="0.9999">99.99%</option></select></label>
          <label class="check" for="ms-par"><input type="checkbox" id="ms-par"> Call independent services in parallel</label>
          <label class="check" for="ms-opt"><input type="checkbox" id="ms-opt"> Page still works without recommendations and reviews</label>
        </div>
        <div class="chain" id="ms-chain" aria-hidden="true"></div>
        <div class="stats" id="ms-stats"></div>
        <p class="sim-note" id="ms-note" role="status"></p>`;
      const $ = (id) => root.querySelector(id);
      const names = ['gateway', 'auth', 'cart', 'catalogue', 'pricing', 'stock', 'customers', 'recommendations', 'reviews', 'promotions', 'tax', 'shipping-quotes', 'loyalty', 'fraud-score', 'currency'];
      let hops;
      const draw = (v, user) => {
        if (user) ctx.tried();
        if (!hops) return;
        const n = hops(), a = +$('#ms-avail').value, par = $('#ms-par').checked, opt = $('#ms-opt').checked;
        const used = names.slice(0, n);
        const optional = opt ? used.filter((x) => x === 'recommendations' || x === 'reviews').length : 0;
        const critical = n - optional;
        const avail = chainAvailability(a, critical);
        const latency = par ? HOP_MS * Math.min(n, 2 + Math.ceil((n - 2) / 3)) : HOP_MS * n; // gateway and auth first, then the rest in a few parallel waves
        $('#ms-chain').innerHTML = used.map((x) => `<span class="svc ${opt && (x === 'recommendations' || x === 'reviews') ? 'optional' : ''}">${x}</span>`).join('');
        stats($('#ms-stats'), [
          ['Page availability', (avail * 100).toFixed(3) + '%', avail < 0.995 ? 'bad' : avail < 0.999 ? 'warn' : 'ok'],
          ['Page down per month', Math.round(monthlyDowntimeMin(avail)) + ' min'],
          ['Time spent in service calls', ms(latency)],
          ['Services that can break the page', critical],
        ]);
        $('#ms-note').textContent = `Availabilities multiply: ${critical} services at ${(a * 100).toFixed(2)}% each give ${(avail * 100).toFixed(2)}% for the page. ${!opt && n >= 9 ? 'Making non-essential calls optional removes them from that product.' : ''} ${!par && n > 3 ? 'Calls that do not depend on each other can run at the same time.' : ''}`;
      };
      hops = bindSlider(root, 'ms-hops', String, draw);
      root.querySelectorAll('select, input[type=checkbox]').forEach((el) => (el.onchange = () => draw(0, true)));
      draw();
    },
  },
  tradeoffs: [
    ['Teams deploy independently, many times a day, without coordinating releases.', 'A function call becomes a network call: slower, and able to fail, time out or be retried. Availability compounds across every hop.'],
    ['Each service scales and fails separately. A crash in reviews need not stop checkout.', 'Data is spread across services. Joins become API calls, and transactions become sagas (lesson 9).'],
    ['Clear ownership and boundaries that are hard to erode.', 'A large platform cost: deploy tooling, discovery, tracing, on-call for every service. Small teams spend their time running infrastructure.'],
  ],
  avoid: `<p>Start with a monolith, or a modular monolith, unless you have several teams that are already blocking each other. Never split services so that they share a database, or so that one user action needs a long synchronous chain of them. If two services always change together and always call each other, merge them.</p>`,
  shoplite: 'A modular monolith for the storefront, with Checkout, Payments, Inventory and Shipping extracted as services owned by four teams, each with its own database and events.',
  takeaways: [
    'Microservices solve team and deployment problems by adding network problems.',
    'Split by business capability. Each service owns its data.',
    'Availabilities multiply along a chain. Keep chains short, call in parallel, and make non-essential calls optional.',
  ],
  quiz: [
    { q: 'A page depends on 10 services in a chain, each 99.9% available. Roughly how available is the page?',
      options: ['99.9%', 'About 99.0%', 'About 90%'], answer: 1,
      why: '0.999 to the 10th power is about 0.990. That is around 7 hours of downtime a month instead of 43 minutes.' },
    { q: 'Two services read and write the same database tables. What have you built?',
      options: ['A good microservice design', 'A distributed monolith: they cannot change their data independently', 'A CQRS system'], answer: 1,
      why: 'A schema change in one breaks the other, so they must deploy together, which is what services were meant to avoid.' },
    { q: 'Which split is most likely to let a team ship alone?',
      options: ['A "database access" service used by every feature', 'A Payments service that owns payment data and logic', 'A "validation" service for all input'], answer: 1,
      why: 'A business capability can change end to end inside one service. Technical layers are touched by every feature.' },
  ],
};
