import { code, pill } from '../ui.js';

// Each step: [who, statement, effect on state, note]
const scripts = {
  none: {
    label: 'No transaction',
    steps: [
      ['A', 'SELECT stock FROM products WHERE id = 7', null, 'Ana sees stock = 1'],
      ['B', 'SELECT stock FROM products WHERE id = 7', null, 'Ben also sees stock = 1'],
      ['A', 'UPDATE products SET stock = 0 WHERE id = 7', (s) => { s.stock = 0; }, 'Ana takes the last pair'],
      ['A', 'INSERT INTO orders (customer, product) VALUES (\'ana\', 7)', (s) => { s.orders.push('Ana'); }, 'Order created'],
      ['B', 'UPDATE products SET stock = 0 WHERE id = 7', (s) => { s.stock = 0; }, 'Ben acts on a number that is no longer true'],
      ['B', 'INSERT INTO orders (customer, product) VALUES (\'ben\', 7)', (s) => { s.orders.push('Ben'); }, 'A second order for the same pair'],
    ],
    verdict: ['bad', 'Oversold. Two orders, one pair of shoes. Someone gets an apology email.'],
  },
  rc: {
    label: 'Transaction, default isolation (READ COMMITTED)',
    steps: [
      ['A', 'BEGIN; SELECT stock FROM products WHERE id = 7', null, 'Ana sees stock = 1'],
      ['B', 'BEGIN; SELECT stock FROM products WHERE id = 7', null, 'Ben sees stock = 1. A plain read takes no lock'],
      ['A', 'UPDATE products SET stock = 0 …; INSERT INTO orders …; COMMIT', (s) => { s.stock = 0; s.orders.push('Ana'); }, 'Ana commits'],
      ['B', 'UPDATE products SET stock = 0 …; INSERT INTO orders …; COMMIT', (s) => { s.stock = 0; s.orders.push('Ben'); }, 'Ben\'s decision was made before Ana committed'],
    ],
    verdict: ['bad', 'Still oversold. Wrapping the code in BEGIN and COMMIT made each checkout all-or-nothing, but it did not stop the two from interleaving.'],
  },
  lock: {
    label: 'Transaction with SELECT … FOR UPDATE',
    steps: [
      ['A', 'BEGIN; SELECT stock FROM products WHERE id = 7 FOR UPDATE', (s) => { s.lock = 'Ana'; }, 'Ana sees stock = 1 and locks the row'],
      ['B', 'BEGIN; SELECT stock FROM products WHERE id = 7 FOR UPDATE', (s) => { s.waiting = 'Ben'; }, 'Ben has to wait for the lock'],
      ['A', 'UPDATE products SET stock = 0 …; INSERT INTO orders …; COMMIT', (s) => { s.stock = 0; s.orders.push('Ana'); s.lock = null; }, 'Ana commits and the lock is released'],
      ['B', '(SELECT returns) stock = 0', (s) => { s.waiting = null; }, 'Ben now reads the committed value'],
      ['B', 'ROLLBACK', null, 'The app tells Ben the item is sold out'],
    ],
    verdict: ['ok', 'Correct. One order. Ben waited a few milliseconds and got an honest answer.'],
  },
  ser: {
    label: 'Transaction at SERIALIZABLE isolation',
    steps: [
      ['A', 'BEGIN ISOLATION LEVEL SERIALIZABLE; SELECT stock …', null, 'Ana sees stock = 1'],
      ['B', 'BEGIN ISOLATION LEVEL SERIALIZABLE; SELECT stock …', null, 'Ben sees stock = 1'],
      ['A', 'UPDATE …; INSERT INTO orders …; COMMIT', (s) => { s.stock = 0; s.orders.push('Ana'); }, 'Ana commits first'],
      ['B', 'UPDATE products SET stock = 0 WHERE id = 7', null, 'ERROR 40001: could not serialize access. The database aborts Ben\'s transaction'],
      ['B', '(app retries) BEGIN …; SELECT stock …', null, 'The retry sees stock = 0 and reports sold out'],
    ],
    verdict: ['ok', 'Correct. The database detected the conflict. The price is that your code must catch error 40001 and retry.'],
  },
};

export default {
  id: 'transactions',
  title: 'Transactions & Isolation',
  hook: 'Avoid double payments and overselling',
  incident: 'Two customers bought the last pair of shoes in the same second. Both were charged. One pair exists.',
  buildsOn: 'With indexes, ShopLite is fast. It is now fast enough that two requests regularly touch the same row at the same moment.',
  problem: `
    <p>Checkout does three things: check the stock, reduce it, and create the order. The code reads cleanly from top to bottom, so it is easy to assume it runs that way. It does not. The server handles many requests at once, and their steps interleave.</p>
    <p>Two separate things can go wrong:</p>
    <ul>
      <li><strong>Half-finished work.</strong> The server crashes after reducing stock but before creating the order. The shoes are gone and nobody bought them.</li>
      <li><strong>Interleaving.</strong> Two checkouts both read "1 in stock" before either writes. Both proceed.</li>
    </ul>`,
  realWorld: `
    <p>The classic case is a bank transfer: take 100 from one account, add 100 to another. If only the first half happens, money disappears. Banks, ticket sellers and airlines all rely on database transactions so that a seat or a balance is never counted twice.</p>
    <p>The interleaving problem has cost real money. In 2014 the Bitcoin exchange Flexcoin closed after an attacker sent many withdrawal requests at once. Each one passed the balance check before any of the others had been recorded.</p>`,
  approach: `
    <p>A <strong>transaction</strong> groups statements so they succeed or fail together. This is atomicity: after a crash, the database rolls back anything that was not committed.</p>
    <p><strong>Isolation</strong> is a separate setting. It decides how much concurrent transactions can see of each other. The default level in PostgreSQL, READ COMMITTED, only promises that you never read uncommitted data. It does not stop two transactions from reading the same value and both acting on it. For that you need one of these:</p>
    ${code(`
-- Option 1: lock the row you are about to change
BEGIN;
SELECT stock FROM products WHERE id = 7 FOR UPDATE;   -- others wait here
UPDATE products SET stock = stock - 1 WHERE id = 7;
INSERT INTO orders (customer_id, product_id) VALUES (42, 7);
COMMIT;

-- Option 2: make the check and the change one atomic statement
UPDATE products SET stock = stock - 1 WHERE id = 7 AND stock > 0;
-- 0 rows updated means it was sold out. No separate read to go stale.

-- Option 3: ask the database to detect conflicts, and retry when it does
BEGIN ISOLATION LEVEL SERIALIZABLE;`, 'sql')}
    <p>Option 2 is the one to reach for first. If the check and the write are a single statement, there is no gap for another request to slip into.</p>`,
  sim: {
    title: 'Two checkouts, one pair of shoes',
    intro: 'Ana and Ben check out at the same moment. Pick how the checkout code is written, then step through what the database sees.',
    mount(root, ctx) {
      root.innerHTML = `
        <div class="controls">
          <label class="field" for="tx-mode"><span>Checkout is written with</span>
            <select id="tx-mode">${Object.entries(scripts).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></label>
          <button class="btn" id="tx-step">Next step</button>
          <button class="btn ghost" id="tx-reset">Restart</button>
        </div>
        <div class="stats" id="tx-state"></div>
        <ol class="timeline" id="tx-log"></ol>
        <p class="sim-note" id="tx-verdict" role="status"></p>`;
      const $ = (id) => root.querySelector(id);
      let s, i;
      const draw = () => {
        $('#tx-state').innerHTML = `
          <div class="stat"><span class="stat-label">Stock in database</span><span class="stat-value">${s.stock}</span></div>
          <div class="stat ${s.orders.length > 1 ? 'bad' : ''}"><span class="stat-label">Orders created</span><span class="stat-value">${s.orders.length ? s.orders.join(', ') : 'none'}</span></div>
          <div class="stat"><span class="stat-label">Row lock</span><span class="stat-value">${s.lock ? 'held by ' + s.lock : 'free'}${s.waiting ? ', ' + s.waiting + ' waiting' : ''}</span></div>`;
      };
      const reset = () => { s = { stock: 1, orders: [], lock: null, waiting: null }; i = 0; $('#tx-log').innerHTML = ''; $('#tx-verdict').innerHTML = ''; $('#tx-step').disabled = false; draw(); };
      $('#tx-mode').onchange = () => { ctx.tried(); reset(); };
      $('#tx-reset').onclick = reset;
      $('#tx-step').onclick = () => {
        ctx.tried();
        const script = scripts[$('#tx-mode').value];
        const [who, sql, effect, note] = script.steps[i++];
        effect?.(s);
        $('#tx-log').insertAdjacentHTML('beforeend',
          `<li class="who-${who}"><span class="who">${who === 'A' ? 'Ana' : 'Ben'}</span><code>${sql}</code><span class="tl-note">${note}</span></li>`);
        draw();
        if (i >= script.steps.length) {
          $('#tx-step').disabled = true;
          $('#tx-verdict').innerHTML = pill(script.verdict[0] === 'ok' ? 'Correct' : 'Bug', script.verdict[0]) + ' ' + script.verdict[1];
        }
      };
      reset();
    },
  },
  tradeoffs: [
    ['All-or-nothing changes. A crash never leaves an order half written.', 'Locks are held until commit. A long transaction makes every other request for those rows wait.'],
    ['Row locks and atomic updates make check-then-act logic safe.', 'Two transactions that lock rows in a different order can deadlock. The database kills one and your code must retry it.'],
    ['SERIALIZABLE lets you write code as if requests ran one at a time.', 'It aborts conflicting transactions, so throughput drops under contention and every caller needs retry logic.'],
  ],
  avoid: `<p>Keep transactions short. Never hold one open while calling another service, sending an email or waiting on a user: the locks stay held for as long as that call takes. Do not reach for SERIALIZABLE everywhere. Use the default level, and add a row lock or an atomic conditional update at the specific places where two requests can race.</p>`,
  shoplite: 'Checkout runs in one transaction and reserves stock with <code>UPDATE … WHERE stock &gt; 0</code>.',
  takeaways: [
    'Atomicity protects you from crashes. Isolation protects you from other requests. They are different guarantees.',
    'A transaction at the default isolation level does not prevent two requests from reading the same value and both acting on it.',
    'Put the check and the change in one statement where you can. Lock the row where you cannot.',
  ],
  quiz: [
    { q: 'Checkout is wrapped in BEGIN … COMMIT at READ COMMITTED. Two requests read stock = 1 at the same time. What happens?',
      options: ['The database blocks the second read', 'Both can proceed and oversell', 'The second transaction is rolled back automatically'], answer: 1,
      why: 'Plain reads take no locks at READ COMMITTED. You need FOR UPDATE, an atomic conditional UPDATE, or SERIALIZABLE.' },
    { q: 'Why is <code>UPDATE products SET stock = stock - 1 WHERE id = 7 AND stock &gt; 0</code> safe without a prior SELECT?',
      options: ['Because UPDATE statements skip isolation', 'Because the check and the write happen as one atomic statement', 'Because it runs faster than a SELECT'], answer: 1,
      why: 'The row is locked for the duration of the statement, and the condition is evaluated against the current committed value.' },
    { q: 'Inside an open transaction that holds a row lock, the code calls a payment provider that takes 4 seconds. What is the main risk?',
      options: ['The lock is held for 4 seconds and other requests queue behind it', 'The payment is automatically rolled back if the transaction fails', 'Nothing, this is the recommended pattern'], answer: 0,
      why: 'Locks last until commit. External calls belong outside the transaction. A rollback cannot undo a charge at another company.' },
  ],
};
