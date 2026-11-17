import { code, fmt, pill, slider, bindSlider, stats } from '../../ui.js';
import { simulateAutoscale } from '../../engines-sd.js';

// Requests per second in 5-minute steps across a 2-hour evening with a flash sale at step 12.
const traffic = [150, 160, 170, 180, 200, 220, 250, 300, 380, 450, 520, 600, 900, 1100, 1000, 800, 650, 550, 480, 420, 380, 330, 300, 280];
const modes = {
  big: { label: 'One large server (vertical)', run: () => simulateAutoscale({ traffic, autoscale: false, fixed: 1, perServer: 700 }), cost: 8 },
  fixed: { label: 'Fixed fleet of 4 small servers', run: () => simulateAutoscale({ traffic, autoscale: false, fixed: 4 }), cost: 1 },
  auto: { label: 'Autoscaling, 2 to 20 small servers', run: (o) => simulateAutoscale({ traffic, ...o }), cost: 1 },
};

function chart(rows) {
  const W = 600, H = 190, pad = 30, maxY = 1200;
  const x = (i) => pad + (i * (W - pad - 8)) / rows.length;
  const y = (v) => H - 20 - (v / maxY) * (H - 30);
  const bw = (W - pad - 8) / rows.length - 3;
  const ticks = [0, 400, 800, 1200];
  return `<svg viewBox="0 0 ${W} ${H}" class="svgchart" role="img" aria-label="Traffic against capacity over two hours">
    ${ticks.map((t) => `<line class="grid" x1="${pad}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${pad - 4}" y="${y(t) + 3}" text-anchor="end">${t}</text>`).join('')}
    ${rows.map((r, i) => {
      const served = Math.min(r.load, r.capacity);
      return `<g><title>${i * 5} min: ${r.load} req/s, capacity ${r.capacity}, ${r.servers} server${r.servers > 1 ? 's' : ''}${r.dropped ? `, ${r.dropped} dropped` : ''}</title>
        <rect class="bar-ok" x="${x(i)}" y="${y(served)}" width="${bw}" height="${y(0) - y(served)}" rx="2"/>
        ${r.dropped ? `<rect class="bar-bad" x="${x(i)}" y="${y(r.load)}" width="${bw}" height="${y(served) - y(r.load) - 1}" rx="2"/>` : ''}</g>`;
    }).join('')}
    <polyline class="capline" points="${rows.map((r, i) => `${x(i)},${y(Math.min(r.capacity, maxY))} ${x(i) + bw + 3},${y(Math.min(r.capacity, maxY))}`).join(' ')}"/>
    <text class="axis" x="${x(12)}" y="${H - 6}">sale starts</text><text class="axis" x="${pad}" y="${H - 6}">0 min</text><text class="axis" x="${W - 8}" y="${H - 6}" text-anchor="end">120 min</text>
  </svg>`;
}

export default {
  id: 'sd-scaling',
  part: 'Part 1: Getting traffic in',
  title: 'Horizontal Scaling',
  hook: 'Add more machines instead of a bigger one',
  incident: 'The flash sale started at 8 pm. By 8:05 the single API server was at 100% CPU, and a third of requests were timing out.',
  buildsOn: 'The CDN now serves images and scripts. Every request it cannot cache (checkout, search, the cart) still lands on one API server, and that server has a ceiling.',
  problem: `
    <p>The obvious move is a bigger server: more cores, more memory. That is <strong>vertical scaling</strong>, and it works until it does not. The largest machines cost far more per unit of capacity, there is a hard upper limit, an upgrade usually means downtime, and one machine is still one machine: when it fails, ShopLite is down.</p>
    <p>The alternative is <strong>horizontal scaling</strong>: run many ordinary servers side by side and add or remove them as traffic changes. It has one precondition, and ShopLite does not meet it yet. Each server keeps the logged-in user's session in its own memory, so a user's next request has to reach the same machine.</p>`,
  realWorld: `
    <p>A restaurant can hire one superhuman chef or open more stations in the kitchen. The superhuman chef is a single point of failure and very expensive to replace. More stations only work if any cook can pick up any order, which means the orders live on the ticket rail, not in one cook's head.</p>
    <p>The "Twelve-Factor App" guidelines, written at Heroku in 2011, made this a rule: application processes are stateless and share nothing, and anything that must persist lives in a backing service such as a database or Redis. Cloud autoscaling groups (on AWS, Google Cloud, Azure) then add and remove copies by load. Netflix went further with Scryer, a system that predicts traffic from history and starts servers before the evening peak instead of reacting to it.</p>`,
  approach: `
    <p><strong>1. Make the servers stateless.</strong> Move anything a later request needs out of the process: sessions into Redis or a signed cookie (Course 1, Auth), uploads into object storage, scheduled jobs onto the queue. Then any server can handle any request, and losing one loses nothing.</p>
    ${code(`
// Before: the session lives in this process's memory
app.use(session({ secret, store: new MemoryStore() }));

// After: every instance reads and writes the same shared store
app.use(session({ secret, store: new RedisStore({ client: redis }) }));`, 'js')}
    <p><strong>2. Scale on a signal.</strong> An autoscaler watches a metric, usually CPU or requests per server, and keeps it near a target such as 70%. The headroom matters: new servers take minutes to boot and warm up, and the existing ones must absorb the growth meanwhile.</p>
    <p><strong>3. Scale ahead of known events.</strong> If you announced a sale for 8 pm, schedule the capacity for 7:45. Reactive scaling is for the traffic you did not predict.</p>
    <p>Horizontal scaling moves the bottleneck rather than removing it. Twenty API servers all talk to one database, which is what Part 2 of this course is about. And something has to spread requests across the servers: that is the next lesson.</p>`,
  sim: {
    title: 'Survive the flash sale',
    intro: 'Each bar is five minutes of traffic. The green part was served and the red part was dropped. The line is capacity. Try each strategy, then change the boot time and the session setting.',
    mount(root, ctx) {
      root.innerHTML = `
        <div class="controls">
          <label class="field" for="hs-mode"><span>Strategy</span>
            <select id="hs-mode">${Object.entries(modes).map(([k, m]) => `<option value="${k}">${m.label}</option>`).join('')}</select></label>
        </div>
        <div class="controls" id="hs-auto">
          <label class="check" for="hs-sched"><input type="checkbox" id="hs-sched"> Schedule 12 servers from 15 minutes before the sale</label>
          <label class="check" for="hs-sticky"><input type="checkbox" id="hs-sticky" checked> Sessions are kept in each server's memory</label>
        </div>
        ${slider('hs-boot', 'Time for a new server to start serving:', 1, 4, 2)}
        <div class="chartbox" id="hs-chart"></div>
        <div class="stats" id="hs-stats"></div>
        <p class="sim-note" id="hs-note" role="status"></p>`;
      const $ = (id) => root.querySelector(id);
      let boot;
      const draw = (v, user) => {
        if (user) ctx.tried();
        if (!boot) return;
        const mode = $('#hs-mode').value, m = modes[mode];
        $('#hs-auto').hidden = $('#hs-boot').closest('.field').hidden = mode !== 'auto';
        const rows = m.run({ bootSteps: boot(), min: $('#hs-sched').checked ? (t) => (t >= 9 && t <= 15 ? 12 : 2) : 2 });
        const total = rows.reduce((a, r) => a + r.load, 0), dropped = rows.reduce((a, r) => a + r.dropped, 0);
        const cost = rows.reduce((a, r) => a + r.servers * m.cost, 0) / 12;
        const loggedOut = mode === 'auto' && $('#hs-sticky').checked ? rows.reduce((a, r) => a + (r.removed / r.servers) * r.load * 2 /* about two active shoppers per request per second */, 0) : 0;
        $('#hs-chart').innerHTML = chart(rows);
        stats($('#hs-stats'), [
          ['Requests dropped', (dropped / total * 100).toFixed(1) + '%', dropped ? 'bad' : 'ok'],
          ['Cost (small-server hours)', cost.toFixed(1)],
          ['Most servers at once', Math.max(...rows.map((r) => r.servers))],
          ['Shoppers logged out by scale-in', fmt(loggedOut), loggedOut ? 'bad' : ''],
        ]);
        $('#hs-note').textContent = mode === 'big' ? 'The large server costs as much as eight small ones all evening, still cannot handle the peak, and is a single point of failure.'
          : mode === 'fixed' ? 'Four servers are wasted for most of the evening and are not enough for the sale.'
          : loggedOut ? 'Capacity now follows demand, but removing servers after the sale threw away the sessions in their memory. Move sessions to a shared store.'
          : dropped ? 'Capacity follows demand, but new servers arrive after the spike has already hit. Start them before a sale you know about.'
          : 'Capacity follows demand, the sale is covered, and stateless servers can be removed without anyone noticing.';
      };
      boot = bindSlider(root, 'hs-boot', (v) => v * 5 + ' min', draw);
      for (const id of ['#hs-mode', '#hs-sched', '#hs-sticky']) $(id).onchange = () => draw(0, true);
      draw();
    },
  },
  tradeoffs: [
    ['No hard ceiling: add servers until something else (usually the database) becomes the limit.', 'The app must be stateless. Sessions, uploads, caches and scheduled jobs move to shared services.'],
    ['Losing a server loses a slice of capacity, not the whole service.', 'More machines to deploy, patch and observe, and a load balancer in front of them.'],
    ['Autoscaling pays for capacity only while you use it.', 'Scaling reacts after the load arrives. Boot time and warm-up decide how much traffic you drop in a sudden spike.'],
  ],
  avoid: `<p>Vertical scaling is simpler and often enough. Stack Overflow famously served one of the busiest sites on the internet from a small number of powerful servers for years. If one machine with a standby can carry your peak with room to spare, keep it. Scale horizontally when you need more than one machine can give, or when one machine failing is not acceptable.</p>`,
  shoplite: 'Stateless API servers with sessions in Redis, an autoscaling group of 2 to 20 instances targeting 70% CPU, and scheduled capacity before announced sales.',
  takeaways: [
    'Vertical scaling buys a bigger machine. Horizontal scaling adds more machines.',
    'Horizontal scaling requires stateless servers: any server must be able to handle any request.',
    'Autoscaling reacts with a delay, so keep headroom and scale ahead of events you know about.',
  ],
  quiz: [
    { q: 'After moving to 6 servers, users report being logged out at random. What is the likely cause?',
      options: ['The database is too slow', 'Sessions are stored in each server\'s memory, and requests reach different servers', 'The CDN is caching the login page'], answer: 1,
      why: 'A session that lives on one server does not exist on the other five. Put it in a shared store or a signed cookie.' },
    { q: 'Why does an autoscaler target around 70% CPU instead of 100%?',
      options: ['Servers run hotter than 70% are unreliable', 'The headroom absorbs growth during the minutes it takes new servers to start', 'Cloud providers charge more above 70%'], answer: 1,
      why: 'Scaling is not instant. The spare capacity on existing servers covers the gap.' },
    { q: 'ShopLite now runs 20 API servers. What is most likely to become the next bottleneck?',
      options: ['The CDN', 'DNS', 'The single database they all share'], answer: 2,
      why: 'Scaling the stateless tier pushes the load down to the stateful one. Part 2 of the course deals with that.' },
  ],
};
