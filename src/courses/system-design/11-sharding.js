import { code, fmt, pill, stats } from '../../ui.js';
import { hash32 } from '../../engines-sd.js';
import { mulberry32 } from '../../engines.js';

const N = 4;
const countries = [['US', 0.45], ['DE', 0.15], ['UK', 0.12], ['IN', 0.1], ['BR', 0.08], ['JP', 0.05], ['AU', 0.05]];
const countryShard = { US: 0, DE: 1, UK: 1, IN: 2, BR: 3, JP: 2, AU: 3 };

function makeOrders() {
  const rnd = mulberry32(7), orders = [];
  for (let i = 0; i < 4000; i++) {
    const customer = rnd() < 0.18 ? 'c-reseller' : 'c-' + Math.floor(rnd() * 600);
    let r = rnd(), country = 'US';
    for (const [c, p] of countries) { if ((r -= p) <= 0) { country = c; break; } }
    const month = Math.min(11, Math.floor(Math.sqrt(rnd()) * 12)); // more orders in recent months
    orders.push({ id: 'o-' + i, customer, country, month });
  }
  return orders;
}
const orders = makeOrders();
const keys = {
  customer: { label: 'customer_id (hashed)', shard: (o) => hash32(o.customer) % N, fanout: 1 },
  order: { label: 'order_id (hashed)', shard: (o) => hash32(o.id) % N, fanout: N },
  country: { label: 'country (lookup table)', shard: (o) => countryShard[o.country], fanout: 1 },
  month: { label: 'created_at (ranges of 3 months)', shard: (o) => Math.floor(o.month / 3), fanout: N },
};

export default {
  id: 'sd-sharding',
  part: 'Part 2: Data at scale',
  title: 'Sharding',
  hook: 'Split the data across machines, and choose the key carefully',
  incident: 'The orders table reached 4 TB. The leader\'s disk is 90% full, nightly vacuum no longer finishes overnight, and write latency has tripled.',
  buildsOn: 'Replicas took the read load off the leader. Every replica still holds a full copy of every order, and every write still goes through one machine.',
  problem: `
    <p>Replication copies the whole dataset to more machines. When the dataset or the write rate is too big for one machine, you need to <strong>split</strong> it instead: each machine (a <em>shard</em> or partition) holds a slice of the rows and handles the writes for that slice.</p>
    <p>Everything depends on the <strong>shard key</strong>, the column that decides which shard a row lives on. A good key spreads data and traffic evenly and keeps each common query on one shard. A bad key creates a hot shard that does most of the work, or forces every query to ask every shard and merge the answers.</p>`,
  realWorld: `
    <p>A library that outgrows its building might split by the author's surname: A to F in one building, G to M in the next. Then it discovers that a quarter of its authors start with S, and the S building is overflowing while another sits half empty.</p>
    <p>Instagram described its approach in 2012: thousands of <em>logical</em> shards mapped onto a much smaller number of PostgreSQL servers, with each new ID carrying its shard number inside it. Moving a logical shard to a new server then means copying it, not re-splitting the data. Notion did the same in 2021, splitting its main PostgreSQL database into 480 logical shards across 32 machines, keyed by workspace so each workspace's data stays together.</p>`,
  approach: `
    <p><strong>Choose the key from your main queries.</strong> ShopLite's hottest queries are "this customer's orders" and "this order". Sharding by <code>customer_id</code> puts all of a customer's orders on one shard, so both stay single-shard lookups.</p>
    <p><strong>Hash or range.</strong></p>
    <ul>
      <li><strong>Hash sharding</strong> runs the key through a hash function. Even spread, but range queries ("all orders from last week") must ask every shard.</li>
      <li><strong>Range sharding</strong> gives each shard a contiguous range of keys. Range queries are cheap, but a monotonically increasing key such as a timestamp sends every new write to the last shard.</li>
      <li><strong>Directory (lookup) sharding</strong> stores a key-to-shard map. Flexible (move one big tenant to its own shard), but the map is one more critical component.</li>
    </ul>
    ${code(`
// Many logical shards, few physical servers. Moving a logical shard is a copy and a map update.
const LOGICAL_SHARDS = 1024;
const shardMap = await config.get('shard-map');   // logical shard → database server

function dbFor(customerId) {
  const logical = hash32(customerId) % LOGICAL_SHARDS;
  return pools[shardMap[logical]];
}

const orders = await dbFor(customerId).query(
  'SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20', [customerId]);`, 'js')}
    <p><strong>What you give up.</strong> Joins and transactions across shards are no longer the database's job; keep data that is queried and changed together on the same shard. Unique constraints only hold within a shard, so IDs come from a scheme that is unique globally (UUIDs, or Snowflake-style IDs). Queries without the shard key fan out to every shard. And one giant customer can still make one shard hot, which is when a directory that can move that tenant earns its place.</p>
    <p>Notice the <code>% LOGICAL_SHARDS</code>. If you hash by the number of <em>physical</em> servers and later add one, almost every row changes shard. The next lesson is about that.</p>`,
  sim: {
    title: 'Pick a shard key',
    intro: '4,000 orders from 600 customers, including one reseller who places 18% of all orders. Choose a shard key and compare how rows, new writes and the "customer\'s order history" query land on 4 shards.',
    mount(root, ctx) {
      root.innerHTML = `
        <div class="controls"><label class="field" for="sh-key"><span>Shard key</span><select id="sh-key">${Object.entries(keys).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></label></div>
        <div class="legend"><span><i class="sw accent"></i>All rows stored</span><span><i class="sw warn"></i>Writes this month</span></div>
        <div class="hbars" id="sh-bars"></div>
        <div class="stats" id="sh-stats"></div>
        <p class="sim-note" id="sh-note" role="status"></p>`;
      const $ = (id) => root.querySelector(id);
      const draw = (user) => {
        if (user) ctx.tried();
        const k = keys[$('#sh-key').value];
        const rows = new Array(N).fill(0), writes = new Array(N).fill(0);
        for (const o of orders) { const s = k.shard(o); rows[s]++; if (o.month === 11) writes[s]++; }
        const totalW = writes.reduce((a, b) => a + b, 0);
        $('#sh-bars').innerHTML = rows.map((r, i) => `<div class="hbar two"><span class="hbar-name">Shard ${i + 1}</span>
          <span class="hbar-track"><i class="accent" style="width:${(r / 4000) * 100}%" title="Shard ${i + 1}: ${r} rows"></i><i class="warn" style="width:${(writes[i] / totalW) * 100}%" title="Shard ${i + 1}: ${writes[i]} of ${totalW} writes this month"></i></span>
          <span class="hbar-val">${Math.round((r / 4000) * 100)}% rows · ${Math.round((writes[i] / totalW) * 100)}% writes</span></div>`).join('');
        const busiest = Math.max(...rows) / (4000 / N), hotWrite = Math.max(...writes) / (totalW / N);
        stats($('#sh-stats'), [
          ['Biggest shard vs an even share', busiest.toFixed(2) + '×', busiest > 1.4 ? 'bad' : 'ok'],
          ['Busiest shard\'s share of new writes', hotWrite.toFixed(2) + '×', hotWrite > 1.4 ? 'bad' : 'ok'],
          ['Shards asked for a customer\'s order history', k.fanout, k.fanout > 1 ? 'warn' : 'ok'],
        ]);
        const key = $('#sh-key').value;
        $('#sh-note').textContent = key === 'customer' ? 'History queries hit one shard. The reseller\'s orders all land together, so one shard is heavier; a directory could give that customer a shard of their own.'
          : key === 'order' ? 'Perfectly even, but a customer\'s orders are scattered, so the most common query asks all 4 shards and merges the results.'
          : key === 'country' ? 'The US shard holds almost half the data. A key with a few, unevenly sized values makes hot shards.'
          : 'Storage looks fine, but every new order goes to the newest range. One shard takes all the writes while the others sit idle.';
      };
      $('#sh-key').onchange = () => draw(true);
      draw(false);
    },
  },
  tradeoffs: [
    ['Storage and write capacity grow with the number of shards. No single machine holds everything.', 'Cross-shard joins, transactions and unique constraints move into application code, or go away.'],
    ['Each shard is smaller, so backups, index builds and vacuum finish faster, and a shard failure affects only part of the users.', 'Queries without the shard key fan out to every shard. One slow shard slows them all.'],
    ['Logical shards over physical servers make rebalancing a copy, not a rewrite.', 'Resharding is still a major operation, and the shard map is critical infrastructure.'],
  ],
  avoid: `<p>Shard last. Before it, try bigger hardware, read replicas, archiving old rows, partitioning tables inside one database, and moving high-volume data (events, logs) to a store built for it. Sharding is hard to undo and touches every query. If you do it, a managed system that shards for you (Citus, Vitess, or a distributed SQL database such as CockroachDB or Spanner) is often cheaper than building the router yourself.</p>`,
  shoplite: 'Orders sharded by customer_id over 1,024 logical shards on 4 PostgreSQL clusters, with a directory entry that can move the largest resellers to their own shard.',
  takeaways: [
    'Sharding splits data across machines so storage and writes scale.',
    'The shard key decides everything: even spread, and the main queries on one shard.',
    'Avoid keys with few values or that increase over time, and avoid hashing by the physical server count.',
  ],
  quiz: [
    { q: 'Why is <code>created_at</code> usually a poor range shard key for orders?',
      options: ['Timestamps cannot be hashed', 'Every new order has the latest timestamp, so all writes go to the last shard', 'It makes range queries slower'], answer: 1,
      why: 'Monotonically increasing keys concentrate all new writes in one place.' },
    { q: 'Orders are sharded by order_id. What happens to "show this customer\'s last 20 orders"?',
      options: ['It reads one shard', 'It must ask every shard and merge the results', 'It cannot be answered'], answer: 1,
      why: 'Without the shard key in the query, the router does not know where to look.' },
    { q: 'What is the advantage of 1,024 logical shards over 4 physical servers, instead of 4 shards?',
      options: ['Queries need fewer joins', 'Adding a server means moving some whole logical shards, not re-hashing every row', 'It uses less disk'], answer: 1,
      why: 'The hash never changes. Only the small map from logical shard to server does.' },
  ],
};
