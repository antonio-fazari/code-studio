import { code, fmt, ms, slider, bindSlider, stats } from '../../ui.js';
import { paginationCost, pageByOffset, pageAfter } from '../../engines.js';

export default {
  id: 'pagination',
  title: 'Pagination',
  hook: 'Cursor-based, not OFFSET 100000',
  incident: 'The admin export of all orders gets slower with every page, and the finance team found the same order twice in the file.',
  buildsOn: 'With auth in place, each user sees only their own orders. Some of them, and the admin export, have hundreds of thousands. No endpoint should return all of them at once.',
  problem: `
    <p>The first implementation is the obvious one:</p>
    ${code(`SELECT * FROM orders ORDER BY id DESC LIMIT 20 OFFSET 100000;`, 'sql')}
    <p>It has two faults.</p>
    <ul>
      <li><strong>It is slow at depth.</strong> The database cannot jump to row 100,000. It reads and throws away 100,000 rows to return 20. Page 1 is fast and page 5,000 is not.</li>
      <li><strong>It skips and repeats rows.</strong> If a new order arrives while someone is on page 1, everything shifts down by one. The last row of page 1 shows up again at the top of page 2.</li>
    </ul>`,
  realWorld: `
    <p>Scroll any social feed. The app does not ask for "page 7". It asks for "the 20 posts after the last one I showed". That keeps the feed stable while new posts arrive at the top.</p>
    <p>Public APIs do the same. Stripe lists take <code>starting_after=&lt;object id&gt;</code>. Slack and GitHub's GraphQL API return an opaque cursor with each page. Their tables are far too large for OFFSET.</p>`,
  approach: `
    <p><strong>Cursor</strong> (or keyset) pagination remembers the last row the client saw and asks for rows after it:</p>
    ${code(`
-- First page
SELECT * FROM orders ORDER BY id DESC LIMIT 20;

-- Next page: the client sends back the last id it received (here 98431)
SELECT * FROM orders WHERE id < 98431 ORDER BY id DESC LIMIT 20;`, 'sql')}
    <p>This is where lesson 1 pays off. <code>id</code> is indexed, so the database walks the index straight to 98431 and reads the next 20 entries. The cost is the same on page 1 and on page 50,000.</p>
    ${code(`
GET /orders?limit=20&after=eyJpZCI6OTg0MzF9

{
  "data": [ ... 20 orders ... ],
  "next_cursor": "eyJpZCI6OTg0MTF9",
  "has_more": true
}`, 'http')}
    <p>Three details to get right:</p>
    <ul>
      <li><strong>Sort by something unique.</strong> If you sort by <code>created_at</code>, add <code>id</code> as a tie-breaker and index both: <code>(created_at, id)</code>.</li>
      <li><strong>Make the cursor opaque.</strong> Encode it (base64 is enough) so clients treat it as a token and you stay free to change what is inside.</li>
      <li><strong>Cap the page size</strong> on the server, whatever the client asks for.</li>
    </ul>`,
  sim: {
    title: 'How deep can you page?',
    intro: 'The orders table has 1,000,000 rows. Move to deeper pages and compare how many rows each method reads. Then try the live list underneath.',
    mount(root, ctx) {
      const seed = () => Array.from({ length: 12 }, (_, i) => ({ id: 112 - i }));
      root.innerHTML = `
        ${slider('pg-page', 'Page number (20 per page):', 1, 50000, 1)}
        <div class="stats" id="pg-stats"></div>

        <h4>New orders arrive while you read</h4>
        <p class="sim-note">Both lists show orders newest first, 4 per page. Load page 1, let a new order arrive, then load the next page.</p>
        <div class="controls">
          <button class="btn" id="pg-next">Load next page</button>
          <button class="btn ghost" id="pg-new">A new order arrives</button>
          <button class="btn ghost" id="pg-reset">Start over</button>
        </div>
        <div class="twocol">
          <div><h5>OFFSET</h5><ul class="rows" id="pg-off"></ul></div>
          <div><h5>Cursor</h5><ul class="rows" id="pg-cur"></ul></div>
        </div>
        <p class="sim-note" id="pg-note" role="status"></p>`;
      const $ = (id) => root.querySelector(id);
      bindSlider(root, 'pg-page', fmt, (page, user) => {
        if (user) ctx.tried();
        const offset = (page - 1) * 20;
        const o = paginationCost({ offset, limit: 20, mode: 'offset' }), c = paginationCost({ offset, limit: 20, mode: 'cursor' });
        stats($('#pg-stats'), [
          ['OFFSET: rows read', fmt(o.rowsRead), page > 500 ? 'bad' : ''], ['OFFSET: time', ms(o.ms), page > 500 ? 'bad' : ''],
          ['Cursor: rows read', fmt(c.rowsRead), 'ok'], ['Cursor: time', ms(c.ms), 'ok'],
        ]);
      });
      let list, offset, cursor, shownOff, shownCur;
      const reset = () => { list = seed(); offset = 0; cursor = null; shownOff = []; shownCur = []; $('#pg-note').textContent = ''; draw(); };
      const draw = () => {
        const render = (rows) => rows.map((r, i) => `<li class="${rows.findIndex((x) => x.id === r.id) !== i ? 'dup' : ''}">Order #${r.id}${rows.findIndex((x) => x.id === r.id) !== i ? ' (shown twice)' : ''}</li>`).join('') || '<li class="empty">nothing loaded yet</li>';
        $('#pg-off').innerHTML = render(shownOff); $('#pg-cur').innerHTML = render(shownCur);
      };
      $('#pg-next').onclick = () => {
        ctx.tried();
        shownOff.push(...pageByOffset(list, offset, 4)); offset += 4;
        const page = pageAfter(list, cursor, 4); shownCur.push(...page); if (page.length) cursor = page.at(-1).id;
        draw();
        if (new Set(shownOff.map((r) => r.id)).size < shownOff.length) $('#pg-note').textContent = 'OFFSET repeated a row: the new order pushed everything down by one, so "skip 4" now lands one row early. The cursor asked for "orders older than the last one I saw" and was unaffected.';
      };
      $('#pg-new').onclick = () => { ctx.tried(); list.unshift({ id: list[0].id + 1 }); $('#pg-note').textContent = `Order #${list[0].id} was placed and is now first in the table.`; };
      $('#pg-reset').onclick = reset;
      reset();
    },
  },
  tradeoffs: [
    ['Constant cost per page at any depth, because each page is one index range read.', 'No jumping to an arbitrary page. Clients can only go next (and previous, if you build it).'],
    ['Stable results while rows are inserted or deleted. No duplicates, no gaps.', 'The sort order must be backed by an index and must end in a unique column. Sorting by arbitrary user-chosen columns gets complicated.'],
    ['Fits infinite scroll, exports and sync jobs naturally.', 'Showing "page 7 of 5,000" needs a total count, which is itself an expensive query on a large table.'],
  ],
  avoid: `<p>OFFSET is fine for small, bounded lists where users want numbered pages: an admin table with a few hundred rows, or search results where nobody goes past page 5. Many products use both: numbered pages over a capped result set for people, and cursors for APIs and exports.</p>`,
  shoplite: '<code>GET /orders?limit=&amp;after=</code> with an opaque cursor over <code>(created_at, id)</code> and a maximum page size of 100.',
  takeaways: [
    'OFFSET reads and discards every row it skips. Its cost grows with depth.',
    'A cursor says "after this row", which the index answers directly.',
    'Sort by a unique, indexed key, and cap the page size.',
  ],
  quiz: [
    { q: 'Why is <code>LIMIT 20 OFFSET 400000</code> slow even with an index on the sort column?',
      options: ['The index is ignored when OFFSET is present', 'The database still has to step over 400,000 entries to find where the page starts', 'LIMIT forces a full table lock'], answer: 1,
      why: 'An index finds a value quickly. It cannot find "the 400,000th entry" without counting past the ones before it.' },
    { q: 'You paginate by <code>created_at</code> only, and 30 orders share the same timestamp at a page boundary. What can go wrong with a cursor of <code>created_at &lt; X</code>?',
      options: ['Nothing', 'Orders sharing that timestamp that did not fit on the page are skipped', 'The query becomes a full scan'], answer: 1,
      why: 'The cursor must identify one exact row. Add id as a tie-breaker: (created_at, id) < (X, last_id).' },
    { q: 'A user is reading page 1 of a feed sorted newest first and three new items are posted. With OFFSET, what does page 2 contain?',
      options: ['Three items they already saw on page 1', 'Exactly the next 20 items', 'An error'], answer: 0,
      why: 'Everything moved down by three, so the offset now points three rows too early.' },
  ],
};
