import { code, pill, stats } from '../../ui.js';
import { LSMTree } from '../../engines-sd.js';

const KEYS = 'abcdefghijklmnop'.split('');

export default {
  id: 'sd-indexing',
  part: 'Part 2: Data at scale',
  title: 'Indexing in Depth',
  hook: 'B-trees, LSM trees, and indexes that answer the query on their own',
  incident: 'ShopLite started recording every product view for recommendations: 30,000 rows a second. The events table fell behind within an hour, and its five indexes were why.',
  revisits: { id: 'indexes', note: 'That lesson showed why an index turns a 2 second scan into a 2 ms lookup. Here we look at how indexes are stored, and why that matters for write-heavy data.' },
  buildsOn: 'ShopLite now keeps orders in PostgreSQL and is adding a high-volume stream of view events. The same indexing habits that made reads fast are making these writes slow.',
  problem: `
    <p>Every index is a sorted structure that must be updated on every insert. PostgreSQL and MySQL store tables and indexes as <strong>B-trees</strong>: pages on disk, updated in place. Inserting one row into a table with five indexes means finding and rewriting a page in each of six trees, usually at random places on disk.</p>
    <p>For orders, which are written a few times a second and read constantly, that is a good deal. For view events, which arrive by the tens of thousands per second and are read in bulk later, it is the wrong structure.</p>`,
  realWorld: `
    <p>A B-tree is a printed phone book kept up to date by hand: to add a name you find the right page and squeeze it in. An <strong>LSM tree</strong> (log-structured merge tree) is a notepad: you jot each new name at the bottom instantly, and every so often you merge the notepad pages into a fresh, sorted booklet. Writing is trivial. Looking someone up means checking the notepad and then each booklet, newest first, until the merge tidies up.</p>
    <p>LSM trees power Cassandra, ScyllaDB, HBase, and RocksDB, which grew out of Google's LevelDB and is used heavily at Meta. Meta moved its main MySQL user database from InnoDB (B-tree) storage to MyRocks (RocksDB) and reported cutting storage roughly in half, because LSM files compress well and waste less space.</p>`,
  approach: `
    <h3>Pick the structure for the workload</h3>
    <div class="tablewrap"><table><thead><tr><th></th><th>B-tree</th><th>LSM tree</th></tr></thead><tbody>
      <tr><td>Write</td><td>Update a page in place (random I/O)</td><td>Append to memory, flush sorted files sequentially</td></tr>
      <tr><td>Read one key</td><td>One path down the tree</td><td>Memory, then each file newest first (bloom filters skip most)</td></tr>
      <tr><td>Background work</td><td>Little</td><td>Compaction rewrites data repeatedly</td></tr>
      <tr><td>Suits</td><td>Read-heavy, transactional data</td><td>Write-heavy logs, events, time series, messages</td></tr>
    </tbody></table></div>
    <p>A <strong>bloom filter</strong> is a small bit array per file that answers "definitely not here" or "maybe here". It lets a read skip files that cannot contain the key, which keeps LSM reads fast.</p>
    <h3>Make each index do more</h3>
    ${code(`
-- Composite: equality columns first, then the range or sort column
CREATE INDEX idx_orders_cust_created ON orders (customer_id, created_at DESC);

-- Covering: the index holds every column the query reads, so the table is never touched
CREATE INDEX idx_orders_cust_cover ON orders (customer_id, created_at DESC) INCLUDE (status, total);

-- Partial: index only the rows you query, here the few unshipped orders among millions
CREATE INDEX idx_orders_unshipped ON orders (created_at) WHERE status = 'paid';`, 'sql')}
    <h3>Indexes in a sharded database</h3>
    <p>Once data is split across machines (lesson 11), an index on a non-key column is either <strong>local</strong> (each shard indexes its own rows, so a lookup must ask every shard) or <strong>global</strong> (one index partitioned by the indexed value, which is fast to read but updated asynchronously, so briefly stale). DynamoDB's global secondary indexes work the second way.</p>`,
  sim: {
    title: 'Inside an LSM tree',
    intro: 'Writes go into memory (the memtable). At 4 rows it is flushed to disk as a sorted file. When 4 files pile up, they are compacted into one. Write some rows, then read a key with and without bloom filters.',
    mount(root, ctx) {
      root.innerHTML = `
        <div class="controls">
          <button class="btn" id="lsm-one">Write 1 row</button>
          <button class="btn ghost" id="lsm-many">Write 20 rows</button>
          <button class="btn ghost" id="lsm-reset">Start over</button>
        </div>
        <div class="lsm" id="lsm-view"></div>
        <div class="controls">
          <label class="field" for="lsm-key"><span>Read key</span><select id="lsm-key">${KEYS.map((k) => `<option>${k}</option>`).join('')}</select></label>
          <label class="check" for="lsm-bloom"><input type="checkbox" id="lsm-bloom"> Use bloom filters</label>
          <button class="btn" id="lsm-read">Read</button>
        </div>
        <p class="sim-note" id="lsm-result" role="status"></p>
        <div class="stats" id="lsm-stats"></div>`;
      const $ = (id) => root.querySelector(id);
      let tree, version, last = '';
      const reset = () => { tree = new LSMTree({ memtableLimit: 4, compactAt: 4 }); version = 0; last = ''; $('#lsm-result').textContent = ''; draw(); };
      const chip = ([k, v], hot) => `<span class="kv${hot === k ? ' hot' : ''}">${k}<small>v${v}</small></span>`;
      const draw = (hot) => {
        $('#lsm-view').innerHTML = `
          <div class="lsm-level"><span class="lsm-name">Memtable (memory)</span><div class="lsm-row">${[...tree.memtable].map((e) => chip(e, hot)).join('') || '<span class="empty">empty</span>'}</div></div>
          ${tree.tables.map((t, i) => `<div class="lsm-level"><span class="lsm-name">File ${tree.tables.length - i}${i === 0 ? ' (newest)' : ''}</span><div class="lsm-row">${[...t].map((e) => chip(e, hot)).join('')}</div></div>`).join('') || '<div class="lsm-level"><span class="lsm-name">Disk</span><div class="lsm-row"><span class="empty">no files yet</span></div></div>'}`;
        stats($('#lsm-stats'), [
          ['Rows written by the app', tree.puts],
          ['Rows written to disk', tree.diskWrites],
          ['Write amplification', tree.puts ? (tree.diskWrites / tree.puts).toFixed(2) + '×' : 'n/a', tree.diskWrites / Math.max(1, tree.puts) > 1.5 ? 'warn' : ''],
          ['Compactions', tree.compactions],
        ]);
      };
      const put = () => { const k = KEYS[Math.floor(Math.random() * KEYS.length)]; tree.put(k, ++version); last = k; };
      $('#lsm-one').onclick = () => { ctx.tried(); put(); draw(last); };
      $('#lsm-many').onclick = () => { ctx.tried(); for (let i = 0; i < 20; i++) put(); draw(); };
      $('#lsm-reset').onclick = reset;
      $('#lsm-read').onclick = () => {
        ctx.tried();
        const k = $('#lsm-key').value, r = tree.get(k, { bloom: $('#lsm-bloom').checked });
        draw(k);
        $('#lsm-result').innerHTML = r.value === undefined
          ? `${pill('not found', 'warn')} Checked ${r.checked} file${r.checked === 1 ? '' : 's'} to be sure "${k}" does not exist.${!$('#lsm-bloom').checked && r.checked ? ' A bloom filter would have ruled them all out without reading them.' : ''}`
          : `${pill('found', 'ok')} "${k}" = v${r.value}, after checking ${r.checked === 0 ? 'only memory' : r.checked + ' file' + (r.checked === 1 ? '' : 's')}. Newer files are checked first, so the latest version wins.`;
      };
      reset();
    },
  },
  tradeoffs: [
    ['<strong>B-tree:</strong> fast, predictable reads, and in-place updates with little background work.', 'Random writes to several trees per insert. Write-heavy tables with many indexes fall behind.'],
    ['<strong>LSM tree:</strong> very high write throughput and good compression.', 'Reads may check several files, and compaction rewrites data repeatedly in the background, using disk and CPU at times you do not choose.'],
    ['<strong>Covering and partial indexes</strong> make hot queries skip the table or index far fewer rows.', 'Each one is still an extra structure to maintain on every write, and a covering index duplicates column data.'],
  ],
  avoid: `<p>Do not switch storage engines for a table that is mostly read; a B-tree is the better structure for that. Before reaching for an LSM-based database, check simpler fixes for write-heavy tables: drop unused indexes, batch inserts, or partition the table by time so old partitions can be dropped instead of deleted row by row.</p>`,
  shoplite: 'Orders stay in PostgreSQL with a covering index for order history and a partial index for unshipped orders. View events go to an LSM-based store partitioned by day.',
  takeaways: [
    'B-trees update in place and favour reads. LSM trees append and merge, and favour writes.',
    'Bloom filters let LSM reads skip files that cannot hold the key.',
    'Composite, covering and partial indexes make one index answer more for less.',
  ],
  quiz: [
    { q: 'Which workload fits an LSM-based store best?',
      options: ['A customer table read on every request and updated rarely', '50,000 sensor readings per second, queried later by device and time', 'A small lookup table of countries'], answer: 1,
      why: 'Heavy, append-mostly writes are what LSM trees are built for.' },
    { q: 'What does a bloom filter tell an LSM read?',
      options: ['The exact position of the key', 'That a file definitely does not contain the key, or might', 'The newest version of the key'], answer: 1,
      why: 'It has no false negatives, only occasional false positives, so files it rules out can be skipped safely.' },
    { q: 'The query <code>SELECT status, total FROM orders WHERE customer_id = 42 ORDER BY created_at DESC LIMIT 20</code> runs constantly. Which index lets it skip the table entirely?',
      options: ['(created_at)', '(customer_id, created_at DESC) INCLUDE (status, total)', '(status)'], answer: 1,
      why: 'It filters on customer_id, is already sorted by created_at, and carries every column the query returns.' },
  ],
};
