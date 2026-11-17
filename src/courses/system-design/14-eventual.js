import { code, pill, slider, bindSlider, stats } from '../../ui.js';
import { newCart, cartAdd, cartRemove, cartItems, cloneCart, mergeCarts, quorum } from '../../engines-sd.js';

const strategies = {
  lww: ['Last write wins', 'Keep whichever whole cart was saved most recently.'],
  union: ['Merge: union of items', 'Keep every item either copy has. Simple, and the original Dynamo cart behaved roughly like this.'],
  orset: ['Merge: track adds and removes', 'Keep every add, and every remove, with an id each. An item is in the cart if some add of it has not been removed. This is an OR-Set, a kind of CRDT.'],
};

export default {
  id: 'sd-eventual',
  part: 'Part 3: Distributed trade-offs',
  title: 'Eventual Consistency',
  hook: 'Let replicas disagree for a while, and make sure they converge on the right answer',
  incident: 'A customer removed a hat from their cart on a laptop, added shoes on their phone, and checked out. The hat was in the order. The shoes were not.',
  buildsOn: 'The previous lesson made carts availability-first: both regions accept writes during a partition. Now the copies must be brought back together, and "back together" needs a definition.',
  problem: `
    <p><strong>Eventual consistency</strong> promises that if writes stop, all replicas will eventually hold the same value. It says nothing about which value, or how long "eventually" is. Two things decide whether that promise is useful:</p>
    <ul>
      <li><strong>How conflicts merge.</strong> When two replicas accepted different writes to the same data, something has to combine them. The simplest rule, keep the newest, silently throws the other write away.</li>
      <li><strong>How stale reads can be.</strong> With several replicas, how many must you write to and read from before a read is guaranteed to see the latest write?</li>
    </ul>`,
  realWorld: `
    <p>DNS (lesson 1) is eventually consistent: a change spreads as caches expire, and nobody expects every resolver to switch at the same instant. Social media like counts are too: two people may see 1,203 and 1,205 for a few seconds, and nobody is harmed.</p>
    <p>Amazon's 2007 Dynamo paper is candid about the shopping cart. It merged divergent carts by keeping everything from both, so an "add to cart" was never lost, but it noted that deleted items could reappear. Collaborative editors such as Figma and many note-taking apps use <strong>CRDTs</strong> (conflict-free replicated data types): data structures designed so that merging any two copies, in any order, gives the same correct result.</p>`,
  approach: `
    <h3>Merging conflicts</h3>
    <ul>
      <li><strong>Last write wins (LWW)</strong>: attach a timestamp and keep the newest. Simple, and wrong whenever both writes mattered. Clocks on different machines also disagree, so "newest" is approximate.</li>
      <li><strong>Application merge</strong>: keep both versions (siblings) and let code that understands the data combine them, such as a union of cart items.</li>
      <li><strong>CRDTs</strong>: structures that merge correctly by construction. A grow-only counter, a set that records both adds and removes, a text sequence. Redis Enterprise, Riak and libraries such as Automerge and Yjs provide them.</li>
    </ul>
    <h3>Quorums: how stale can a read be?</h3>
    <p>With <strong>N</strong> replicas, write to <strong>W</strong> of them and read from <strong>R</strong>. If <strong>R + W &gt; N</strong>, every read set overlaps every write set, so at least one replica in any read has the latest write. Cassandra exposes this directly as a consistency level per query:</p>
    ${code(`
N = 3, W = 2, R = 2   ->  2 + 2 > 3: reads see the latest write; survives 1 node down
N = 3, W = 1, R = 1   ->  fastest, but a read can miss the latest write`)}
    <p>Lower W and R mean lower latency and more tolerance of slow nodes; higher means fresher reads. Like CAP, this is chosen per query, not once.</p>
    <h3>Guarantees users notice</h3>
    <p>Even with eventual consistency underneath, keep the session guarantees from lesson 10: a user should see their own writes, and should never see data go backwards when they refresh.</p>`,
  sim: {
    title: 'Two devices, one cart',
    intro: 'The cart starts with a hat. While the regions are partitioned, the phone adds shoes on one replica, and a minute later the laptop removes the hat and adds socks on the other. Pick a merge strategy and reconnect them.',
    mount(root, ctx) {
      root.innerHTML = `
        <div class="controls">
          <label class="field" for="ec-strat"><span>Merge strategy</span><select id="ec-strat">${Object.entries(strategies).map(([k, [n]]) => `<option value="${k}">${n}</option>`).join('')}</select></label>
          <button class="btn" id="ec-merge">Reconnect and merge</button>
        </div>
        <p class="sim-note" id="ec-desc"></p>
        <div class="regions" id="ec-carts"></div>
        <p class="sim-note" id="ec-result" role="status"></p>
        <h4>Quorum reads and writes</h4>
        ${slider('ec-n', 'Replicas (N):', 1, 7, 3)}
        ${slider('ec-w', 'Write to (W):', 1, 7, 2)}
        ${slider('ec-r', 'Read from (R):', 1, 7, 2)}
        <div class="nodes" id="ec-nodes" aria-hidden="true"></div>
        <div class="stats" id="ec-q"></div>`;
      const $ = (id) => root.querySelector(id);
      const base = newCart(); cartAdd(base, 'hat', 't1', 1);
      const phone = cloneCart(base), laptop = cloneCart(base);
      cartAdd(phone, 'shoes', 't2', 2);
      cartRemove(laptop, 'hat', 3); cartAdd(laptop, 'socks', 't3', 3);
      const list = (c) => cartItems(c).map((i) => `<span class="kv">${i}</span>`).join('') || '<span class="empty">empty</span>';
      const draw = (merged) => {
        const s = $('#ec-strat').value;
        $('#ec-desc').textContent = strategies[s][1];
        $('#ec-carts').innerHTML = `<div class="region"><span class="region-name">Replica 1 (phone)</span><div class="lsm-row">${list(phone)}</div><small>added shoes at 10:02</small></div>
          <div class="link">${merged ? '→ merged →' : '✕ partitioned'}</div>
          <div class="region"><span class="region-name">Replica 2 (laptop)</span><div class="lsm-row">${list(laptop)}</div><small>removed hat, added socks at 10:03</small></div>
          ${merged ? `<div class="region merged"><span class="region-name">After merge</span><div class="lsm-row">${list(merged)}</div></div>` : ''}`;
        if (!merged) { $('#ec-result').innerHTML = ''; return; }
        const items = cartItems(merged), want = ['shoes', 'socks'];
        const lost = want.filter((i) => !items.includes(i)), back = items.filter((i) => !want.includes(i));
        $('#ec-result').innerHTML = !lost.length && !back.length ? `${pill('Correct', 'ok')} Both devices' changes survived: shoes and socks, no hat.`
          : `${pill('Wrong', 'bad')} ${lost.length ? `Lost: ${lost.join(', ')}. ` : ''}${back.length ? `Came back after being removed: ${back.join(', ')}.` : ''}`;
      };
      $('#ec-strat').onchange = () => { ctx.tried(); draw(); };
      $('#ec-merge').onclick = () => { ctx.tried(); draw(mergeCarts(phone, laptop, $('#ec-strat').value)); };
      draw();
      let n, w, r;
      const q = (v, user) => {
        if (user) ctx.tried();
        if (!n || !w || !r) return;
        const N = n(), W = Math.min(w(), N), R = Math.min(r(), N);
        const res = quorum(N, R, W);
        $('#ec-nodes').innerHTML = Array.from({ length: N }, (_, i) => `<span class="qnode ${i < W ? 'w' : ''} ${i >= N - R ? 'r' : ''}">${i < W ? 'W' : ''}${i >= N - R ? 'R' : ''}</span>`).join('');
        stats($('#ec-q'), [
          ['R + W > N?', `${R} + ${W} ${res.overlap ? '>' : '≤'} ${N}`, res.overlap ? 'ok' : 'bad'],
          ['Every read sees the latest write', res.overlap ? 'yes, the sets overlap' : 'no, a read can miss it', res.overlap ? 'ok' : 'bad'],
          ['Writes still work with', res.writeTolerates + ' node' + (res.writeTolerates === 1 ? '' : 's') + ' down'],
          ['Reads still work with', res.readTolerates + ' node' + (res.readTolerates === 1 ? '' : 's') + ' down'],
        ]);
      };
      n = bindSlider(root, 'ec-n', String, q); w = bindSlider(root, 'ec-w', String, q); r = bindSlider(root, 'ec-r', String, q);
      q();
    },
  },
  tradeoffs: [
    ['Every replica accepts reads and writes locally, so the system stays fast and available everywhere.', 'Reads can be stale, and users can see different answers at the same moment.'],
    ['CRDTs and application merges keep both sides\' changes instead of discarding one.', 'Merges must be designed per data type. Some data, such as a stock count with a floor of zero, has no merge that is always correct.'],
    ['Quorums let you choose freshness against latency per query.', 'R + W > N still is not full consistency under every failure, and tuning per query adds complexity.'],
  ],
  avoid: `<p>Do not use eventual consistency for invariants that must never be broken: a balance that must not go negative, a unique username, the last unit of stock. Those need a single authority or consensus (next lesson). And avoid last-write-wins for any data where two concurrent writes can both be meaningful.</p>`,
  shoplite: 'Carts are stored as an add/remove set (a CRDT) replicated across regions, with quorum reads and writes (N = 3, R = 2, W = 2) within each region.',
  takeaways: [
    'Eventual consistency guarantees convergence, not correctness. The merge rule decides correctness.',
    'Last write wins quietly discards concurrent writes. CRDTs merge them by design.',
    'With N replicas, R + W > N means every read overlaps the latest write.',
  ],
  quiz: [
    { q: 'Two replicas accepted different edits to the same cart. With last-write-wins, what happens?',
      options: ['Both edits are kept', 'The edit with the later timestamp is kept and the other is silently lost', 'The cart is emptied'], answer: 1,
      why: 'LWW picks a winner. Any change only in the loser disappears without an error.' },
    { q: 'N = 5 replicas. Which settings guarantee a read sees the latest acknowledged write?',
      options: ['W = 2, R = 2', 'W = 3, R = 3', 'W = 1, R = 4'], answer: 1,
      why: '3 + 3 = 6 > 5, so any read set shares at least one replica with any write set. 2 + 2 and 1 + 4 do not exceed 5.' },
    { q: 'Which data does not suit eventual consistency?',
      options: ['A like counter on a review', 'Usernames, which must be unique', 'A list of recently viewed products'], answer: 1,
      why: 'Two regions could each accept the same username during a partition, and no merge can make both owners happy.' },
  ],
};
