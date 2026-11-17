import { code, fmt, ms, slider, bindSlider, stats } from '../../ui.js';
import { indexCost, binarySearchSteps } from '../../engines.js';

export default {
  id: 'indexes',
  title: 'Indexes',
  hook: 'Why one query takes 2 ms and another takes 2 s',
  incident: 'Support cannot open a customer\'s orders. The lookup takes 2.1 seconds and it gets slower every week.',
  buildsOn: null,
  problem: `
    <p>ShopLite starts as one table. Every order is a row in <code>orders</code>, and the support page runs one query:</p>
    ${code(`SELECT * FROM orders WHERE customer_email = 'ana@example.com';`, 'sql')}
    <p>With 1,000 orders this returned instantly. With 5 million it takes two seconds. Nothing in the code changed. The table grew, and the database has only one way to answer the question: read every row and check its email. That is a <strong>sequential scan</strong>, and its cost grows in step with the table.</p>`,
  realWorld: `
    <p>The index at the back of a textbook works the same way. To find every page that mentions "isolation" you do not read the whole book. You look the word up in an alphabetical list and jump to the pages it names.</p>
    <p>Every large product depends on this. When you open your order history on a shopping site, the database is not reading hundreds of millions of orders. It walks an index on the customer column and touches a handful of pages. PostgreSQL and MySQL both build a B-tree for every primary key automatically for this reason.</p>`,
  approach: `
    <p>An index is a second, sorted copy of one or more columns, with a pointer from each entry back to its row. Because it is sorted and shaped like a tree, the database can find a value in a few hops, the way you find a name in a phone book.</p>
    ${code(`
CREATE INDEX idx_orders_customer_email ON orders (customer_email);

-- Ask the database how it plans to run a query
EXPLAIN ANALYZE SELECT * FROM orders WHERE customer_email = 'ana@example.com';
-- Before:  Seq Scan on orders          (actual time=2104 ms, rows read: 5,000,000)
-- After:   Index Scan using idx_orders (actual time=1.9 ms,  rows read: 3)`, 'sql')}
    <p>Three habits matter more than any theory:</p>
    <ul>
      <li><strong>Index what you filter, join and sort on.</strong> Columns in <code>WHERE</code>, <code>JOIN</code> and <code>ORDER BY</code> are the candidates.</li>
      <li><strong>Column order matters in a composite index.</strong> An index on <code>(customer_id, created_at)</code> serves "this customer's orders, newest first". It does not help a query that filters only on <code>created_at</code>.</li>
      <li><strong>Read the plan.</strong> <code>EXPLAIN ANALYZE</code> tells you whether the index is used. Do not guess.</li>
    </ul>`,
  sim: {
    title: 'Scan versus index',
    intro: 'The strip below is a table sorted by email. Find one row both ways and count how many rows the database has to look at. Then change the table size.',
    mount(root, ctx) {
      const N = 64;
      root.innerHTML = `
        <div class="controls">
          <button class="btn" id="ix-scan">Find without an index</button>
          <button class="btn" id="ix-index">Find with an index</button>
        </div>
        <div class="cells" id="ix-cells" aria-hidden="true">${'<i></i>'.repeat(N)}</div>
        <p class="sim-note" id="ix-note" role="status">64 rows. The target row is outlined.</p>
        ${slider('ix-rows', 'Rows in the real table:', 3, 9, 6.7, 0.1)}
        <div class="stats" id="ix-stats"></div>`;
      const cells = [...root.querySelectorAll('#ix-cells i')];
      const note = root.querySelector('#ix-note');
      const sorted = cells.map((_, i) => i);
      let target = 41, run = 0;
      const reset = () => cells.forEach((c, i) => { c.className = i === target ? 'target' : ''; });
      reset();
      function play(steps, label) {
        ctx.tried();
        const mine = ++run;
        target = 8 + Math.floor(Math.random() * 54);
        steps = steps();
        reset();
        steps.forEach((idx, n) => ctx.after(n * (steps.length > 10 ? 45 : 380), () => {
          if (mine !== run) return;
          cells[idx].classList.add(idx === target ? 'found' : 'seen');
          note.textContent = `${label}: ${n + 1} row${n ? 's' : ''} examined${idx === target ? '. Found it.' : '…'}`;
        }));
      }
      root.querySelector('#ix-scan').onclick = () => play(() => sorted.slice(0, target + 1), 'Sequential scan');
      root.querySelector('#ix-index').onclick = () => play(() => binarySearchSteps(sorted, target), 'Index lookup');
      bindSlider(root, 'ix-rows', (v) => fmt(10 ** v), (v, user) => {
        if (user) ctx.tried();
        const c = indexCost(Math.round(10 ** v));
        stats(root.querySelector('#ix-stats'), [
          ['Scan: rows read', fmt(c.scanRows), 'bad'], ['Scan: time', ms(c.scanMs), 'bad'],
          ['Index: pages read', c.indexReads, 'ok'], ['Index: time', ms(c.indexMs), 'ok'],
        ]);
      });
    },
  },
  tradeoffs: [
    ['Reads that filter or sort on the indexed columns go from seconds to milliseconds.', 'Every <code>INSERT</code>, <code>UPDATE</code> and <code>DELETE</code> must also update each index. Five indexes means roughly six writes per row.'],
    ['Sorted results and uniqueness checks come almost free.', 'Indexes take disk and memory. On a busy table they can be larger than the data.'],
    ['The query does not change. You add the index and the planner picks it up.', 'The planner may ignore an index that matches too many rows, and unused indexes still cost you on every write.'],
  ],
  avoid: `<p>Skip the index on small tables (a scan of a few thousand rows is already fast), on columns with very few distinct values such as a boolean <code>is_active</code>, and on write-heavy tables you rarely read, such as raw event logs. Add indexes in response to a slow query you have measured, and drop the ones your database reports as unused.</p>`,
  shoplite: 'An index on <code>orders (customer_id, created_at)</code> and a unique index on <code>customers (email)</code>.',
  takeaways: [
    'Without an index, lookup cost grows with the table. With one, it barely grows at all.',
    'Indexes speed up reads and slow down writes. Each one has to earn its place.',
    'Use EXPLAIN ANALYZE to see what the database actually does.',
  ],
  quiz: [
    { q: 'A query filters on <code>WHERE status = \'shipped\' AND customer_id = 42</code>. 60% of all orders are shipped. Which single-column index helps most?',
      options: ['An index on status', 'An index on customer_id', 'Either one, they are equivalent'], answer: 1,
      why: 'customer_id narrows the search to a handful of rows. status still leaves 60% of the table, so the planner would probably scan anyway.' },
    { q: 'After adding six indexes to a table, what should you expect?',
      options: ['Faster reads and faster writes', 'Faster reads on those columns, slower writes', 'No change until the table is rebuilt'], answer: 1,
      why: 'Each write now maintains six extra sorted structures. This is the central trade-off of indexing.' },
    { q: 'You have an index on <code>(customer_id, created_at)</code>. Which query can it not serve efficiently?',
      options: ['WHERE customer_id = 42', 'WHERE customer_id = 42 ORDER BY created_at DESC', 'WHERE created_at > \'2026-01-01\''], answer: 2,
      why: 'A composite index is sorted by its first column first. Without customer_id the matching entries are scattered through the whole index.' },
  ],
};
