import { code, slider, bindSlider, stats } from '../../ui.js';
import { HashRing, hash32, modShard, movedShare } from '../../engines-sd.js';

const NAMES = ['A', 'B', 'C', 'D', 'E'];
const KEYS = Array.from({ length: 4000 }, (_, i) => 'product:' + i);
const SAMPLE = KEYS.slice(0, 90);
const vnodeSteps = [1, 3, 10, 50, 150];

export default {
  id: 'sd-consistent-hashing',
  part: 'Part 2: Data at scale',
  title: 'Consistent Hashing',
  hook: 'Add or remove a node and move only a small share of the keys',
  incident: 'ShopLite added a fifth Redis node to the cache cluster during the evening peak. The hit ratio fell from 94% to 18%, and the database fell over.',
  buildsOn: 'The cache cluster and the shards both decide where a key lives by hashing it. They both used <code>hash(key) % N</code>, where N is the number of nodes. That works until N changes.',
  problem: `
    <p><code>hash(key) % 4</code> spreads keys perfectly over 4 nodes. Make it <code>% 5</code> and the answer changes for about 80% of all keys, not the 20% that should move to the new node. For a cache, that means 80% of the cache is suddenly in the wrong place: a near-total cold start (lesson 5). For a sharded database, it means moving 80% of the data.</p>
    <p>Nodes change all the time: you add capacity, a node fails, a node is replaced. You need a way to assign keys so that a change in membership moves only the keys that have to move.</p>`,
  realWorld: `
    <p>Picture the delivery zones of five depots drawn as slices around a circular city. Opening a sixth depot takes a slice from its two neighbours. Addresses in every other zone keep their depot.</p>
    <p>Consistent hashing was published by Karger and colleagues at MIT in 1997, for spreading web caches across machines, and became the basis of Akamai's CDN. Amazon's Dynamo, Cassandra and many memcached client libraries place keys on a hash ring this way, and Google's Maglev load balancer uses a variant so that connections stay on the same backend when the backend set changes.</p>`,
  approach: `
    <p>Map both nodes and keys onto the same circle of hash values (0 to 2<sup>32</sup>−1, wrapping around). Each key belongs to the first node found going clockwise from the key's position.</p>
    <ul>
      <li><strong>Add a node:</strong> it takes over only the keys between it and the previous node. On average that is 1/N of the keys, all moving to the new node.</li>
      <li><strong>Remove a node:</strong> only its keys move, to the next node clockwise.</li>
    </ul>
    <p>With one point per node, the slices are uneven by chance: one node might own 40% of the ring. The fix is <strong>virtual nodes</strong>: place each physical node at many points (Cassandra used 256 per node by default for years). The many small slices average out, and when a node leaves, its load spreads across all the others instead of landing on one neighbour. Giving a bigger machine more virtual nodes also gives it a proportionally larger share.</p>
    ${code(`
ring = sorted([(hash(node + "#" + i), node) for node in nodes for i in range(VNODES)])

def owner(key):
    h = hash(key)
    i = bisect_left(ring, (h,))          # first point clockwise from the key
    return ring[i % len(ring)][1]        # wrap around past the top`, 'python')}
    <p>For sharded databases, the logical-shard approach from lesson 11 achieves the same goal differently: the hash maps to a fixed number of slots, and only the slot-to-server map changes. Redis Cluster does exactly this with 16,384 slots.</p>`,
  sim: {
    title: 'The hash ring',
    intro: 'Each tick on the ring is a virtual node, labelled with its node. Dots are keys, coloured by the node that owns them. Add and remove nodes and compare how many of 4,000 keys move with the ring and with % N.',
    mount(root, ctx) {
      root.innerHTML = `
        <div class="controls">
          <button class="btn" id="ch-add">Add a node</button>
          <button class="btn ghost" id="ch-remove">Remove a node</button>
        </div>
        ${slider('ch-v', 'Virtual nodes per node:', 0, 4, 0)}
        <div class="ringwrap"><div class="chartbox" id="ch-ring"></div><div class="tablewrap"><table id="ch-share"></table></div></div>
        <div class="stats" id="ch-stats"></div>
        <p class="sim-note" id="ch-note" role="status"></p>`;
      const $ = (id) => root.querySelector(id);
      let count = 4, lastMove = null, getV;
      const build = (n, v) => { const r = new HashRing(v); NAMES.slice(0, n).forEach((x) => r.add(x)); return r; };
      const draw = () => {
        const v = vnodeSteps[getV()], ring = build(count, v);
        const C = 150, R = 118, ang = (h) => (h / 2 ** 32) * Math.PI * 2 - Math.PI / 2;
        const pt = (h, r) => [C + r * Math.cos(ang(h)), C + r * Math.sin(ang(h))];
        const share = Object.fromEntries(NAMES.slice(0, count).map((n) => [n, 0]));
        KEYS.forEach((k) => share[ring.get(k)]++);
        const showLabels = v <= 3;
        $('#ch-ring').innerHTML = `<svg viewBox="0 0 300 300" class="svgchart ring" role="img" aria-label="Hash ring with ${count} nodes">
          <circle class="ring-line" cx="${C}" cy="${C}" r="${R}"/>
          ${ring.points.map((p) => { const [x1, y1] = pt(p.pos, R - 9), [x2, y2] = pt(p.pos, R + 9), [lx, ly] = pt(p.pos, R + 22);
            return `<line class="node-${NAMES.indexOf(p.node)} tick" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>${showLabels ? `<text class="label" x="${lx}" y="${ly + 4}" text-anchor="middle">${p.node}</text>` : ''}`; }).join('')}
          ${SAMPLE.map((k) => { const [x, y] = pt(hash32(k), R - 24); const o = ring.get(k); return `<circle class="key node-${NAMES.indexOf(o)}" cx="${x}" cy="${y}" r="3.2"><title>${k} → node ${o}</title></circle>`; }).join('')}
          <text class="axis" x="${C}" y="${C + 4}" text-anchor="middle">${count} nodes · ${v} point${v > 1 ? 's' : ''} each</text>
        </svg>`;
        $('#ch-share').innerHTML = `<thead><tr><th>Node</th><th>Share of keys</th></tr></thead><tbody>${Object.entries(share).map(([n, c]) => `<tr><td><i class="sw node-${NAMES.indexOf(n)}"></i> ${n}</td><td>${(c / 40).toFixed(1)}%</td></tr>`).join('')}</tbody>`;
        const shares = Object.values(share), spread = Math.max(...shares) / (KEYS.length / count);
        stats($('#ch-stats'), [
          ['Busiest node vs an even share', spread.toFixed(2) + '×', spread > 1.4 ? 'bad' : 'ok'],
          ['Keys moved, hash ring', lastMove ? (lastMove.ring * 100).toFixed(1) + '%' : 'n/a', lastMove ? 'ok' : ''],
          ['Keys moved, hash % N', lastMove ? (lastMove.mod * 100).toFixed(1) + '%' : 'n/a', lastMove ? 'bad' : ''],
        ]);
        $('#ch-note').textContent = lastMove ? `Going from ${lastMove.from} to ${lastMove.to} nodes, the ring moved ${(lastMove.ring * 100).toFixed(0)}% of keys; about ${Math.round(100 / Math.max(lastMove.from, lastMove.to))}% is the minimum possible. % N moved ${(lastMove.mod * 100).toFixed(0)}%.${v < 10 ? ' With few virtual nodes the slices are uneven; raise them to even out the load.' : ''}` : 'Add or remove a node to compare.';
        $('#ch-add').disabled = count >= NAMES.length; $('#ch-remove').disabled = count <= 2;
      };
      const change = (to) => {
        ctx.tried();
        const v = vnodeSteps[getV()], before = build(count, v), after = build(to, v);
        lastMove = { from: count, to, ring: movedShare(KEYS, (k) => before.get(k), (k) => after.get(k)), mod: movedShare(KEYS, (k) => modShard(k, count), (k) => modShard(k, to)) };
        count = to; draw();
      };
      $('#ch-add').onclick = () => change(count + 1);
      $('#ch-remove').onclick = () => change(count - 1);
      getV = bindSlider(root, 'ch-v', (i) => String(vnodeSteps[i]), (val, user) => { if (user) { ctx.tried(); lastMove = null; } if (getV) draw(); });
      draw();
    },
  },
  tradeoffs: [
    ['Adding or removing a node moves about 1/N of the keys instead of nearly all of them.', 'Lookups need the ring (a sorted list and a binary search) instead of one modulo, and every client must agree on the membership.'],
    ['Virtual nodes even out the load and spread a failed node\'s keys across all survivors.', 'More points mean a bigger ring to store and rebuild, and more ranges to track when moving data.'],
    ['Weights are easy: a bigger machine gets more virtual nodes.', 'Consistent hashing balances keys, not traffic. One very hot key still lands on one node.'],
  ],
  avoid: `<p>If the node set almost never changes, or you can afford a full reshuffle (a small cache you can warm quickly), plain modulo is simpler. If you already use a fixed number of logical shards or slots with a map, you have solved the same problem and do not need a ring. For hot keys, consistent hashing does not help; replicate those keys or cache them in each server's memory (lesson 5).</p>`,
  shoplite: 'The Redis cache cluster uses a hash ring with 150 virtual nodes per server, so adding a node during peak moves about a fifth of the cache instead of most of it.',
  takeaways: [
    'hash % N reassigns almost every key when N changes.',
    'On a hash ring, a new node takes only the keys between it and its neighbour: about 1/N.',
    'Virtual nodes even out the slices and spread a failed node\'s load.',
  ],
  quiz: [
    { q: 'A cache uses hash(key) % 10. You add an 11th node. Roughly what share of keys now map to a different node?',
      options: ['About 9%', 'About 50%', 'About 90%'], answer: 2,
      why: 'Only keys whose hash gives the same remainder mod 10 and mod 11 stay put, which is about 1 in 11.' },
    { q: 'On a hash ring with 10 nodes, you add an 11th. Which keys move?',
      options: ['All keys', 'About 1/11 of keys, all moving to the new node', 'Every key on the two neighbouring nodes'], answer: 1,
      why: 'Only the keys between the new node\'s points and their predecessors change owner, and they all go to the new node.' },
    { q: 'Why use 150 virtual nodes per server instead of 1?',
      options: ['To store more keys', 'To even out the share each server owns, and spread a failed server\'s keys over all the others', 'To make lookups faster'], answer: 1,
      why: 'One point per server gives random, uneven arcs. Many small arcs average out.' },
  ],
};
