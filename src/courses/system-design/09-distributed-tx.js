import { code, pill, stats } from '../../ui.js';
import { runSaga, run2PC } from '../../engines-sd.js';

const steps = [
  { name: 'Inventory: reserve 1 pair of shoes', undo: 'Inventory: release the reservation', svc: 'inventory' },
  { name: 'Payments: charge $89', undo: 'Payments: refund $89', svc: 'payments' },
  { name: 'Shipping: book a courier', undo: 'Shipping: cancel the booking', svc: 'shipping' },
];
const failures = { none: 'Nothing fails', payment: 'The card is declined', shipping: 'Shipping rejects the address' };
const modes = { naive: 'Call each service in turn, no coordination', saga: 'Saga with compensating steps', tpc: 'Two-phase commit' };

export default {
  id: 'sd-transactions',
  part: 'Part 2: Data at scale',
  title: 'ACID Across Services',
  hook: 'Two-phase commit, sagas, and keeping data consistent without one database',
  incident: 'A customer\'s card was charged for an order that was never shipped. The shipping service rejected the address, and nothing told payments to refund.',
  revisits: { id: 'transactions', note: 'That lesson used BEGIN and COMMIT inside one database. Here the steps of one checkout live in three services with three databases, and no single transaction can span them.' },
  buildsOn: 'ShopLite\'s data now lives in more than one place: orders in PostgreSQL, carts in a key-value store, and teams are splitting inventory, payments and shipping into their own services, each with its own database.',
  problem: `
    <p>Inside one database, checkout was easy: one transaction, and either everything happened or nothing did. Now checkout is three calls to three services. Each call commits in its own database. If the third fails, the first two have already committed, and there is no ROLLBACK that reaches across.</p>
    <p>ACID's guarantees were properties of one database. Across services, you have to build the "all or nothing" yourself.</p>`,
  realWorld: `
    <p>Booking a holiday means a flight, a hotel and a car from three companies. No travel agent can lock all three systems at once. They book each in turn, and if the car is unavailable, they cancel the hotel and the flight. That sequence of steps, each with a matching cancellation, is called a <strong>saga</strong>, a term from a 1987 database paper by Garcia-Molina and Salem.</p>
    <p>The alternative, <strong>two-phase commit</strong>, is like a wedding ceremony: the officiant asks each party "do you?", and only when everyone has said yes is the marriage declared. It is exact, but everyone waits on the officiant. Uber built Cadence (whose authors later founded Temporal) to run long multi-step workflows like these reliably, with retries and compensations as code.</p>`,
  approach: `
    <h3>Two-phase commit (2PC)</h3>
    <p>A coordinator asks every participant to <em>prepare</em>: do the work, hold the locks, and promise to commit if asked. If all vote yes, it tells them to commit; if any votes no, all abort. The result is atomic. The cost: participants hold locks while waiting, and if the coordinator dies after the votes, prepared participants are stuck holding them until it returns. Many modern services and message brokers do not support 2PC at all.</p>
    <h3>Sagas</h3>
    <p>Run each step as its own local transaction. For every step, write a <strong>compensating action</strong> that semantically undoes it. If a step fails, run the compensations for the completed steps in reverse order.</p>
    ${code(`
const checkoutSaga = [
  { run: (o) => inventory.reserve(o.items),     undo: (o) => inventory.release(o.items) },
  { run: (o) => payments.charge(o.id, o.total), undo: (o) => payments.refund(o.id) },
  { run: (o) => shipping.book(o.id, o.address), undo: (o) => shipping.cancel(o.id) },
];

async function runSaga(saga, order) {
  const done = [];
  for (const step of saga) {
    try { await step.run(order); done.push(step); }
    catch (err) {
      for (const s of done.reverse()) await s.undo(order);   // each undo is retried until it succeeds
      throw err;
    }
  }
}`, 'js')}
    <p>Sagas give up isolation: between steps, other requests can see the half-finished state (stock reserved, card not yet charged). Design for it: use states such as <code>PENDING</code>, put the step most likely to fail early, and the step hardest to undo (shipping a parcel) last. Every step and every compensation must be idempotent (Course 1), because they will be retried.</p>
    <p>A saga can be <strong>orchestrated</strong> (one service drives the steps, as above, which is easy to follow) or <strong>choreographed</strong> (each service reacts to the previous one's event on a queue, which is loosely coupled but harder to trace). Either way, publish events with the outbox pattern from Course 1 so a crash cannot lose a step.</p>`,
  sim: {
    title: 'Checkout across three services',
    intro: 'Choose how checkout is coordinated and what goes wrong, then run it. The final state shows whether the three services still agree.',
    mount(root, ctx) {
      root.innerHTML = `
        <div class="controls">
          <label class="field" for="tx-mode"><span>Coordination</span><select id="tx-mode">${Object.entries(modes).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <label class="field" for="tx-fail"><span>What goes wrong</span><select id="tx-fail">${Object.entries(failures).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <label class="check" for="tx-crash" id="tx-crash-wrap"><input type="checkbox" id="tx-crash"> Coordinator crashes after collecting votes</label>
          <button class="btn" id="tx-run">Run checkout</button>
        </div>
        <ol class="timeline" id="tx-log"></ol>
        <div class="stats" id="tx-state"></div>
        <p class="sim-note" id="tx-verdict" role="status"></p>`;
      const $ = (id) => root.querySelector(id);
      const failAt = () => ({ none: -1, payment: 1, shipping: 2 })[$('#tx-fail').value];
      const sync = () => { $('#tx-crash-wrap').hidden = $('#tx-mode').value !== 'tpc'; };
      const show = (entries, state, verdict) => {
        $('#tx-log').innerHTML = '';
        entries.forEach(([who, text, cls], i) => ctx.after(i * 260, () => $('#tx-log').insertAdjacentHTML('beforeend', `<li class="who-${cls}"><span class="who">${who}</span><span class="tl-note">${text}</span></li>`)));
        ctx.after(entries.length * 260, () => {
          stats($('#tx-state'), state.map(([k, v, bad]) => [k, v, bad ? 'bad' : '']));
          $('#tx-verdict').innerHTML = verdict;
        });
      };
      $('#tx-run').onclick = () => {
        ctx.tried();
        const mode = $('#tx-mode').value, f = failAt();
        $('#tx-state').innerHTML = ''; $('#tx-verdict').innerHTML = '';
        if (mode === 'naive') {
          const done = f < 0 ? steps : steps.slice(0, f);
          const entries = done.map((s) => ['Checkout', s.name + '. Committed.', 'A']);
          if (f >= 0) entries.push(['Checkout', steps[f].name.split(':')[0] + ' failed. Checkout returns an error to the customer.', 'B']);
          const st = [['Stock reserved', done.length >= 1 ? 'yes' : 'no'], ['Card charged', done.length >= 2 ? 'yes' : 'no'], ['Courier booked', done.length >= 3 ? 'yes' : 'no']];
          const broken = f > 0;
          st.forEach((r) => (r[2] = broken && r[1] === 'yes'));
          return show(entries, st, broken ? `${pill('Inconsistent', 'bad')} The customer saw an error, yet earlier steps stayed committed. Nobody undoes them.` : `${pill('Consistent', 'ok')} ${f === 0 ? 'The first step failed, so nothing else ran.' : 'Everything succeeded, so there was nothing to undo.'}`);
        }
        if (mode === 'saga') {
          const r = runSaga(steps, f);
          const entries = r.log.map((e) => e.type === 'do' ? ['Saga', e.step + '. Committed.', 'A'] : e.type === 'fail' ? ['Saga', e.step.split(':')[0] + ' failed. Running compensations in reverse.', 'B'] : ['Saga', e.step + '.', 'B']);
          const ok = r.ok;
          return show(entries, [['Stock reserved', ok ? 'yes' : 'released'], ['Card charged', ok ? 'yes' : f > 1 ? 'refunded' : 'no'], ['Courier booked', ok ? 'yes' : 'no']],
            ok ? `${pill('Consistent', 'ok')} All three steps committed.` : `${pill('Consistent', 'ok')} Every completed step was undone. For a moment the stock was reserved${f > 1 ? ' and the card charged' : ''}, and other requests could see that.`);
        }
        const r = run2PC(steps.map((s) => s.svc), { voteNo: f, coordinatorCrash: $('#tx-crash').checked });
        const entries = [['Coordinator', 'PREPARE sent to inventory, payments and shipping.', 'A'], ...r.log.map((e) =>
          e.type === 'vote-yes' ? [e.step, 'Prepared: work done, locks held, votes YES.', 'B']
          : e.type === 'vote-no' ? [e.step, 'Cannot proceed, votes NO.', 'B']
          : e.type === 'crash' ? ['Coordinator', 'Crashes before sending the decision.', 'A']
          : e.type === 'blocked' ? [e.step, 'Still holding locks, waiting for a decision that is not coming.', 'B']
          : [e.step, e.type === 'commit' ? 'COMMIT.' : 'ABORT, locks released.', 'B'])];
        const st = r.outcome === 'blocked' ? [['Stock row', 'locked', true], ['Payment', 'locked', true], ['Other checkouts for this product', 'waiting', true]]
          : [['Stock reserved', r.outcome === 'committed' ? 'yes' : 'no'], ['Card charged', r.outcome === 'committed' ? 'yes' : 'no'], ['Courier booked', r.outcome === 'committed' ? 'yes' : 'no']];
        show(entries, st, r.outcome === 'blocked' ? `${pill('Blocked', 'bad')} Nothing is inconsistent, but nothing can move. Prepared participants cannot decide alone, so their locks stay held until the coordinator recovers.`
          : `${pill('Consistent', 'ok')} ${r.outcome === 'committed' ? 'Everyone voted yes, so everyone committed at once.' : 'One NO vote, so all three aborted. No compensation needed, and no half-finished state was ever visible.'}`);
      };
      $('#tx-mode').onchange = () => { ctx.tried(); sync(); };
      sync();
    },
  },
  tradeoffs: [
    ['<strong>Two-phase commit</strong> is truly atomic, and no half-finished state is ever visible.', 'Locks are held across network round trips, a coordinator crash blocks participants, and many services and brokers do not support it.'],
    ['<strong>Sagas</strong> work with any service that has an API, hold no cross-service locks, and scale well.', 'No isolation: intermediate states are visible. Every step needs a correct, idempotent compensation, and some actions (an email sent) cannot be undone.'],
    ['<strong>Orchestration</strong> keeps the whole workflow readable in one place.', 'The orchestrator is a central piece every flow depends on. <strong>Choreography</strong> avoids that but scatters the logic across services.'],
  ],
  avoid: `<p>The best distributed transaction is the one you do not need. If two pieces of data must change together every time, they probably belong in the same service and the same database. Split services along boundaries where eventual consistency between them is acceptable to the business (lesson 16).</p>`,
  shoplite: 'Checkout runs as an orchestrated saga: reserve stock, charge, book shipping, with idempotent compensations and events published through the outbox.',
  takeaways: [
    'A database transaction cannot span services. You build all-or-nothing yourself.',
    'Two-phase commit is atomic but blocking. Sagas are non-blocking but expose intermediate states.',
    'Order saga steps so the likeliest failure comes first and the hardest to undo comes last.',
  ],
  quiz: [
    { q: 'In a saga, the shipping step fails after the card was charged. What should happen?',
      options: ['Retry shipping forever', 'Run the compensations: refund the card, then release the stock', 'Roll back the database transaction'], answer: 1,
      why: 'Each earlier step committed in its own database. Only explicit compensations, in reverse order, undo them.' },
    { q: 'What is the main operational risk of two-phase commit?',
      options: ['It can commit only some participants', 'If the coordinator fails after prepare, participants keep their locks until it recovers', 'It needs a message queue'], answer: 1,
      why: 'A prepared participant has promised to obey the decision and cannot safely decide on its own.' },
    { q: 'Which step should a checkout saga perform last?',
      options: ['Reserving stock', 'Charging the card', 'Handing the parcel to the courier'], answer: 2,
      why: 'It is the hardest to undo. Steps that can fail cheaply, or be compensated cleanly, go first.' },
  ],
};
