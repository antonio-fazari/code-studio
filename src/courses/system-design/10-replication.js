import { code, log, pill, slider, bindSlider, stats } from '../../ui.js';
import { ReplicaSet } from '../../engines-sd.js';

const routing = {
  any: 'Any replica, round robin',
  ryw: 'Leader for 10 s after your own write, then any replica',
  sync: 'Any replica, with synchronous replication',
};

export default {
  id: 'sd-replication',
  part: 'Part 2: Data at scale',
  title: 'Replication',
  hook: 'Copies of the data on several machines: for reads, for safety, and the lag between them',
  incident: 'A customer changed their delivery address, reloaded the page, and saw the old one. They changed it again. Support now has three tickets and two parcels at the wrong house.',
  buildsOn: 'The primary PostgreSQL server handles every read and write for twenty API servers. It is the busiest machine in the system and, if it dies, the only copy of ShopLite\'s orders.',
  problem: `
    <p><strong>Replication</strong> keeps copies of the database on several machines. One copy, the <em>leader</em> (or primary), accepts writes and streams every change to the <em>followers</em> (replicas). That gives you two things: followers can serve reads, multiplying read capacity, and a follower can take over if the leader dies.</p>
    <p>The catch is in "streams". By default replication is <strong>asynchronous</strong>: the leader confirms a write as soon as it is stored locally and sends it to followers afterwards. Followers are usually a few milliseconds behind, and under load, seconds or more. A read routed to a follower can return data older than a write the same user just made.</p>`,
  realWorld: `
    <p>A newspaper has one editorial office and many printing plants. Readers in every city get a copy quickly, but a correction made at 11 pm reaches the plants that already printed only in the next edition.</p>
    <p>Replication lag has caused real outages. In October 2018, GitHub lost network connectivity between its East Coast hub and primary data centre for 43 seconds. Its failover system promoted databases on the West Coast. Writes from those 43 seconds existed on one side but not the other, and reconciling them without losing data left GitHub degraded for just over 24 hours.</p>`,
  approach: `
    <p><strong>Use followers for reads that can be slightly stale</strong>: product pages, search, reports. Send everything else to the leader. Most frameworks let you route per query.</p>
    ${code(`
// Reads that may be a moment old go to a replica
const products = await replica.query('SELECT * FROM products WHERE category = $1', [cat]);

// Read-your-writes: after this user writes, read their data from the leader for a while
const recentlyWrote = Date.now() - (session.lastWriteAt ?? 0) < 10_000;
const db = recentlyWrote ? leader : replica;
const profile = await db.query('SELECT * FROM customers WHERE id = $1', [userId]);`, 'js')}
    <p><strong>Consistency guarantees to know by name:</strong></p>
    <ul>
      <li><strong>Read-your-writes</strong>: a user always sees their own changes. Route their reads to the leader for a short time after a write, or to a replica that has caught up past their write's position.</li>
      <li><strong>Monotonic reads</strong>: a user never sees time go backwards. Pin each user to one replica so a refresh does not land on a more-lagged one.</li>
    </ul>
    <p><strong>Synchronous replication</strong> waits for at least one follower to confirm before the leader acknowledges a write. Nothing acknowledged can be lost in a failover, at the price of slower writes and writes stalling if that follower is unavailable. PostgreSQL lets you choose per transaction; a common setup is one synchronous follower nearby and the rest asynchronous.</p>
    <p><strong>Failover</strong> promotes a follower when the leader dies. With asynchronous replication, writes the leader acknowledged but had not yet sent are lost. Measure replication lag and alert on it: it is how much data a failover would lose right now.</p>
    <p>Multi-leader and leaderless replication accept writes in several places at once. Lessons 13 and 14 cover why that is harder.</p>`,
  sim: {
    title: 'Change an address, then reload',
    intro: 'One leader and two followers. Change the address, then reload the profile page straight away. Each reload goes to the node the routing rule picks. Then try a failover with a write still in flight.',
    mount(root, ctx) {
      root.innerHTML = `
        ${slider('rp-lag', 'Replication lag:', 0, 5000, 2000, 250)}
        <div class="controls">
          <label class="field" for="rp-route"><span>Read routing</span><select id="rp-route">${Object.entries(routing).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        </div>
        <div class="controls">
          <button class="btn" id="rp-write">Change address</button>
          <button class="btn" id="rp-read">Reload profile</button>
          <button class="btn ghost danger" id="rp-fail">Leader fails now</button>
        </div>
        <div class="replicas" id="rp-nodes"></div>
        <div class="stats" id="rp-stats"></div>
        <ul class="log" id="rp-log" aria-live="polite"></ul>`;
      const $ = (id) => root.querySelector(id);
      const streets = ['14 Elm Street', '9 Harbour Road', '201 Kings Way', '3 Mill Lane', '77 Station Road'];
      let set, n, rr, lastWrite, stale, reads, lost, lag;
      const reset = () => {
        set = new ReplicaSet({ lagMs: lag ? lag() : 2000, sync: $('#rp-route').value === 'sync' });
        set.write('address', '5 Old Road', -1e9); set.tick(0);
        n = 0; rr = 0; lastWrite = -1e9; stale = 0; reads = 0; lost = 0;
        $('#rp-log').innerHTML = '';
        draw();
      };
      const draw = () => {
        const now = Date.now();
        set.tick(now);
        const leaderVal = set.nodes[0].data.address;
        $('#rp-nodes').innerHTML = set.nodes.map((nd) => `<div class="replica ${nd.name === 'leader' ? 'leader' : ''} ${nd.data.address !== leaderVal ? 'behind' : ''}">
          <b>${nd.name}</b><span>${nd.data.address ?? 'empty'}</span>${nd.data.address !== leaderVal ? pill('behind', 'warn') : ''}</div>`).join('');
        const pending = set.pending.length;
        stats($('#rp-stats'), [['Stale reads', `${stale} of ${reads}`, stale ? 'bad' : 'ok'], ['Writes not yet on every follower', pending, pending ? 'warn' : ''], ['Writes lost in failovers', lost, lost ? 'bad' : '']]);
      };
      $('#rp-write').onclick = () => {
        ctx.tried();
        const addr = streets[n++ % streets.length], now = Date.now();
        const { ackMs } = set.write('address', addr, now);
        lastWrite = now;
        log($('#rp-log'), `<b>Write</b> address = ${addr}. Leader acknowledged ${ackMs ? `after ${ackMs} ms, once followers confirmed` : 'immediately'}.`);
        draw();
      };
      $('#rp-read').onclick = () => {
        ctx.tried();
        const now = Date.now(), mode = $('#rp-route').value;
        const node = mode === 'ryw' && now - lastWrite < 10000 ? 0 : 1 + (rr++ % (set.nodes.length - 1 || 1));
        const idx = Math.min(node, set.nodes.length - 1);
        const got = set.read(idx, 'address', now), truth = set.nodes[0].data.address;
        reads++; if (got !== truth) stale++;
        log($('#rp-log'), `<b>Read</b> from ${set.nodes[idx].name}: ${got} ${got === truth ? pill('current', 'ok') : pill('stale: you just changed this', 'bad')}`, got === truth ? '' : 'bad');
        draw();
      };
      $('#rp-fail').onclick = () => {
        ctx.tried();
        const r = set.failover(Date.now());
        lost += r.lost;
        log($('#rp-log'), r.lost ? `${pill('data loss', 'bad')} follower-1 was promoted. It had not received ${r.lost} acknowledged write${r.lost > 1 ? 's' : ''}, which ${r.lost > 1 ? 'are' : 'is'} now gone. The customer was told it was saved.` : `${pill('clean failover', 'ok')} follower-1 was fully caught up, so it took over with no data lost.`, r.lost ? 'bad' : 'ok');
        if (set.nodes.length < 2) { set.nodes.push({ name: 'follower-new', data: { ...set.nodes[0].data } }); }
        draw();
      };
      lag = bindSlider(root, 'rp-lag', (v) => (v ? (v / 1000).toFixed(v % 1000 ? 2 : 0) + ' s' : 'none'), (v, user) => { if (user) { ctx.tried(); reset(); } });
      $('#rp-route').onchange = () => { ctx.tried(); reset(); };
      ctx.every(250, draw);
      reset();
    },
  },
  tradeoffs: [
    ['Followers multiply read capacity, and can sit in other regions close to users.', 'Reads from followers can be stale. Every query has to be classified as "may be stale" or "must be current".'],
    ['A follower can take over within seconds if the leader dies.', 'With asynchronous replication, acknowledged writes still in flight are lost in a failover.'],
    ['Synchronous replication guarantees no acknowledged write is lost.', 'Every write waits for a follower, and writes stall if that follower is slow or down.'],
  ],
  avoid: `<p>Do not add read replicas to fix slow queries; fix the queries (indexes, Course 1) first. Replicas do not scale writes at all: every follower applies every write. If writes are the bottleneck, you need sharding (next lesson). And never point code that writes then immediately reads at a replica without a read-your-writes rule.</p>`,
  shoplite: 'A PostgreSQL leader with one synchronous follower in the same region and two asynchronous read replicas, read-your-writes for 10 s after a customer\'s own changes, and an alert when lag passes 2 s.',
  takeaways: [
    'Replication copies every write from a leader to followers, for read capacity and for failover.',
    'Asynchronous followers lag. Route reads that must be current to the leader.',
    'Lag is also how much data a failover would lose right now.',
  ],
  quiz: [
    { q: 'A user saves a setting and the next page shows the old value. Replicas lag by about a second. What is the standard fix?',
      options: ['Add more replicas', 'Read-your-writes: read that user\'s data from the leader for a short time after they write', 'Increase the cache TTL'], answer: 1,
      why: 'More replicas do not reduce lag. Routing the writer\'s own reads to the leader does.' },
    { q: 'Writes have become the bottleneck on the leader. Will adding three read replicas help?',
      options: ['Yes, writes are spread over four machines', 'No, every replica must apply every write too', 'Only with synchronous replication'], answer: 1,
      why: 'Replication scales reads. Splitting writes requires sharding.' },
    { q: 'With asynchronous replication, what is lost when the leader dies and a follower is promoted?',
      options: ['Nothing', 'Writes the leader acknowledged that had not reached that follower yet', 'All writes since the last backup'], answer: 1,
      why: 'Asynchronous means the leader did not wait. Whatever was still in flight exists only on the dead machine.' },
  ],
};
