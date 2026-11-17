import { log, pill, stats } from '../../ui.js';
import { Cluster } from '../../engines-sd.js';

export default {
  id: 'sd-cap',
  part: 'Part 3: Distributed trade-offs',
  title: 'CAP Theorem',
  hook: 'When the network splits, choose between answering and being right',
  incident: 'The link between ShopLite\'s US and EU regions dropped for 12 minutes. Both regions kept selling the last 40 units of a limited sneaker. 71 people bought them.',
  buildsOn: 'ShopLite now has replicas in a European region so EU customers read and write close to home (lessons 10 and 11). Replicas in different regions talk over long, shared network links, and those links fail.',
  problem: `
    <p>With replicas in two regions, a question that never arose on one machine becomes unavoidable. The network between them breaks. A customer in Europe wants to buy. The EU replica cannot reach the US replicas to check whether the last unit was already sold there. It has two options:</p>
    <ul>
      <li><strong>Refuse</strong> (or wait) until it can confirm. The data stays correct, but EU customers get errors.</li>
      <li><strong>Accept</strong> using what it knows. EU customers are served, but the two sides may now disagree, and you may have sold the same unit twice.</li>
    </ul>
    <p>No design avoids this choice. That is the CAP theorem.</p>`,
  realWorld: `
    <p>Two bank branches share one account and the phone line between them goes down. A customer asks the first branch for cash. The branch can refuse until the line is back, or pay out and risk the customer emptying the account at the other branch too. Old cash machines took the second option with a cap on the amount: available, with a bounded risk.</p>
    <p>Eric Brewer proposed the idea in 2000 and Seth Gilbert and Nancy Lynch proved it in 2002. Real systems state their choice. Google's Spanner and CockroachDB choose consistency: a minority side of a partition stops accepting writes. Amazon's Dynamo, built for the shopping cart, and Cassandra in its default settings choose availability: every side keeps accepting writes and they are reconciled later (next lesson).</p>`,
  approach: `
    <p>The three letters:</p>
    <ul>
      <li><strong>Consistency</strong>: every read sees the most recent write, as if there were one copy of the data. (This is a different "C" from ACID's.)</li>
      <li><strong>Availability</strong>: every request to a working node gets a non-error answer.</li>
      <li><strong>Partition tolerance</strong>: the system keeps operating when messages between nodes are lost.</li>
    </ul>
    <p>"Pick two of three" is a misleading summary. Across a network, partitions happen whether you like it or not, so P is not optional. The real statement is: <strong>during a partition, you must give up either consistency or availability.</strong> When there is no partition, you can have both.</p>
    <p>That is why the choice is made per kind of data, not once for the whole company:</p>
    <div class="tablewrap"><table><thead><tr><th>Data</th><th>During a partition</th><th>Why</th></tr></thead><tbody>
      <tr><td>Stock of a limited item, payments, account balance</td><td>Consistent (refuse on the minority side)</td><td>Overselling or double-spending is worse than an error page.</td></tr>
      <tr><td>Shopping cart, wish list, product reviews</td><td>Available (accept, reconcile later)</td><td>Losing a sale because the cart is read-only is worse than merging two versions of a cart.</td></tr>
      <tr><td>Product catalogue, prices shown on pages</td><td>Available, from a stale copy</td><td>Slightly old information is fine; the price is re-checked at checkout.</td></tr>
    </tbody></table></div>
    <p>An extension called <strong>PACELC</strong>, from Daniel Abadi, adds the everyday half: if there is a Partition, choose Availability or Consistency; Else, choose Latency or Consistency. Even with a healthy network, waiting for a far-away replica to confirm costs time on every request. That second trade-off is the one you pay all day.</p>`,
  sim: {
    title: 'Split the regions',
    intro: 'Three replicas share one product with 1 unit in stock: two in the US, one in the EU. Cut the link between regions, try to buy in both, then heal the link. Compare a consistency-first and an availability-first system.',
    mount(root, ctx) {
      root.innerHTML = `
        <div class="controls">
          <label class="field" for="cap-mode"><span>System chooses</span><select id="cap-mode"><option value="CP">Consistency (CP)</option><option value="AP">Availability (AP)</option></select></label>
          <button class="btn ghost" id="cap-reset">Start over</button>
        </div>
        <div class="regions" id="cap-regions"></div>
        <div class="controls">
          <button class="btn danger" id="cap-cut">Cut the US–EU link</button>
          <button class="btn" id="cap-us">Sam buys in the US</button>
          <button class="btn" id="cap-eu">Lea buys in the EU</button>
          <button class="btn ghost" id="cap-read">Check stock from the EU</button>
          <button class="btn ghost" id="cap-heal">Heal the link</button>
        </div>
        <div class="stats" id="cap-stats"></div>
        <ul class="log" id="cap-log" aria-live="polite"></ul>`;
      const $ = (id) => root.querySelector(id);
      let c, errors, sold;
      const reset = () => { c = new Cluster({ mode: $('#cap-mode').value, stock: 1 }); errors = 0; sold = 0; $('#cap-log').innerHTML = ''; draw(); };
      const draw = () => {
        const node = (id) => `<div class="replica"><b>${id}</b><span>stock ${c.nodes[id].stock}</span><small>${c.nodes[id].orders.join(', ') || 'no orders'}</small></div>`;
        $('#cap-regions').innerHTML = `<div class="region"><span class="region-name">US region</span>${node('us-1')}${node('us-2')}</div>
          <div class="link ${c.partitioned ? 'cut' : ''}" aria-label="${c.partitioned ? 'link cut' : 'link up'}">${c.partitioned ? '✕ partitioned' : '⟷ connected'}</div>
          <div class="region"><span class="region-name">EU region</span>${node('eu-1')}</div>`;
        const oversold = Math.max(0, sold - 1);
        stats($('#cap-stats'), [['Requests refused', errors, errors ? 'warn' : ''], ['Units sold', sold], ['Oversold', oversold, oversold ? 'bad' : 'ok']]);
        $('#cap-cut').disabled = c.partitioned; $('#cap-heal').disabled = !c.partitioned;
      };
      const buy = (from, who) => {
        ctx.tried();
        const r = c.buy(from, who);
        if (r.ok) { sold++; log($('#cap-log'), `${pill('order placed', 'ok')} ${who} bought the last unit on ${from}.`); }
        else { errors++; log($('#cap-log'), r.error === 'no quorum' ? `${pill('503', 'bad')} ${who}: "Service unavailable." ${from} can only reach 1 of 3 replicas, not a majority, so it will not decide alone.` : `${pill('sold out', 'warn')} ${who}: ${from} says it is sold out.`); }
        draw();
      };
      $('#cap-mode').onchange = () => { ctx.tried(); reset(); };
      $('#cap-reset').onclick = reset;
      $('#cap-cut').onclick = () => { ctx.tried(); c.partitioned = true; log($('#cap-log'), '<b>Network</b> the link between the US and the EU is down.', 'bad'); draw(); };
      $('#cap-us').onclick = () => buy('us-1', 'Sam');
      $('#cap-eu').onclick = () => buy('eu-1', 'Lea');
      $('#cap-read').onclick = () => {
        ctx.tried();
        const r = c.read('eu-1');
        if (!r.ok) errors++;
        log($('#cap-log'), r.ok ? `<b>Read</b> eu-1 says stock is ${r.stock}${c.partitioned && c.nodes['us-1'].stock !== r.stock ? ` ${pill('stale: the US side disagrees', 'warn')}` : ''}.` : `${pill('503', 'bad')} eu-1 refuses to answer without a majority.`);
        draw();
      };
      $('#cap-heal').onclick = () => {
        ctx.tried();
        const r = c.heal();
        log($('#cap-log'), r.oversold ? `${pill('conflict', 'bad')} Link restored. Both sides sold the same unit: ${r.orders.join(' and ')}. Someone gets an apology and a refund.` : `${pill('consistent', 'ok')} Link restored. The replicas agree: ${r.orders.length ? r.orders.join(', ') + ' bought it' : 'nothing sold'}.`);
        draw();
      };
      reset();
    },
  },
  tradeoffs: [
    ['<strong>Consistency first:</strong> every answer is correct. Nothing is oversold or double-spent.', 'Nodes that cannot reach a majority return errors during a partition, and every write pays for a round trip to a quorum, even when the network is healthy.'],
    ['<strong>Availability first:</strong> every region keeps serving through a partition, with low latency.', 'Replicas diverge. You need a way to merge conflicting writes, and some conflicts (two people bought one item) need a human or business process to resolve.'],
    ['Choosing per kind of data gets the right behaviour for each.', 'More than one consistency model in one product means more to explain, test and reason about.'],
  ],
  avoid: `<p>Do not invoke CAP for a single-region system on one database: there is no partition between replicas to reason about, and the database's transactions are what matter. And do not let "we are AP" become an excuse for not knowing what happens on conflict. Write down, for each kind of data, what a partition does to it.</p>`,
  shoplite: 'Stock and payments are consistency-first: a region that loses its quorum stops taking orders for limited items. Carts and wish lists are availability-first and merge on reconnection.',
  takeaways: [
    'Network partitions will happen. During one, a system must choose correct answers or available answers.',
    'Make that choice per kind of data, based on which failure costs the business more.',
    'Even without partitions, consistency across regions costs latency on every request (PACELC).',
  ],
  quiz: [
    { q: 'What does the CAP theorem actually force you to choose?',
      options: ['Any two of consistency, availability and partition tolerance, all the time', 'During a network partition, between consistency and availability', 'Between SQL and NoSQL'], answer: 1,
      why: 'Partitions are not optional in a distributed system. The choice only bites while one is happening.' },
    { q: 'For which data should ShopLite choose availability during a partition?',
      options: ['The last 40 units of a limited sneaker', 'A customer\'s shopping cart', 'A gift card balance'], answer: 1,
      why: 'Two versions of a cart can be merged. Two sales of one unit, or spending a balance twice, cannot be undone cleanly.' },
    { q: 'A consistency-first system has 3 replicas. A partition leaves 1 on one side and 2 on the other. Which side keeps accepting writes?',
      options: ['Both', 'The side with 2, because it is a majority', 'The side with 1, because it is smaller'], answer: 1,
      why: 'A majority is required so two sides can never both decide. Only one side can hold one.' },
  ],
};
