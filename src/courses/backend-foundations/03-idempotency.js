import { code, log, pill, stats } from '../../ui.js';
import { handlePayment } from '../../engines.js';

export default {
  id: 'idempotency',
  title: 'Idempotency Keys',
  hook: 'Retries without duplicate orders',
  incident: 'A customer on a train tapped Pay once. Their card statement shows two charges of $49.',
  buildsOn: 'Transactions made one checkout request safe. They cannot help when the same checkout arrives as two separate requests, because each request is a valid transaction on its own.',
  problem: `
    <p>The customer's phone sent the payment request. The server charged the card and committed. Then the train entered a tunnel and the response never arrived. The app saw a timeout and did the sensible thing: it tried again. The server received a second, perfectly valid request and charged the card again.</p>
    <p>The client cannot tell "the request never arrived" from "the request worked and the reply was lost". Both look like a timeout. It has to retry, so the server has to make retrying safe.</p>`,
  realWorld: `
    <p>Stripe's API accepts an <code>Idempotency-Key</code> header on every request that creates something. If you send the same key twice, the second call returns the saved result of the first and nothing is charged again. Stripe keeps keys for 24 hours. Most payment APIs, including PayPal and Adyen, work the same way.</p>
    <p>You have met the idea outside software. A paper cheque has a number so the bank will not cash it twice. Pressing a lift button five times calls one lift.</p>`,
  approach: `
    <p>An operation is <strong>idempotent</strong> if doing it twice has the same effect as doing it once. Reading is naturally idempotent, and so is "set stock to 5". "Charge $49" is not, so we make it so:</p>
    <ol>
      <li>The client generates a unique key (a UUID) once per user action and sends it with every attempt.</li>
      <li>The server stores the key, in the same transaction as the work, with a unique constraint on it.</li>
      <li>If the key already exists, the server returns the stored response and does nothing else.</li>
    </ol>
    ${code(`
POST /payments
Idempotency-Key: 7f3c2a9e-51b0-4c1d-9a6e-2d0f6a8b1c44
{ "order_id": 1042, "amount": 4900 }`, 'http')}
    ${code(`
BEGIN;
-- The unique constraint is the guard. Only one request can insert this key.
INSERT INTO idempotency_keys (key, request_hash) VALUES ($1, $2)
  ON CONFLICT (key) DO NOTHING;
-- 0 rows inserted: this is a retry. Return the stored response and stop.
-- 1 row inserted: do the work, then save the response next to the key.
UPDATE idempotency_keys SET response = $3 WHERE key = $1;
COMMIT;`, 'sql')}
    <p>The key must come from the client. Only the client knows that two requests are the same attempt and not two purchases. The server also compares the request body, so a reused key with different contents is rejected instead of silently returning the wrong result.</p>`,
  sim: {
    title: 'A lost response',
    intro: 'The network drops the server\'s first reply, so the app retries. Pay with and without an idempotency key and compare the card statement.',
    mount(root, ctx) {
      root.innerHTML = `
        <div class="controls">
          <label class="check" for="id-key"><input type="checkbox" id="id-key"> Send an Idempotency-Key</label>
          <button class="btn" id="id-pay">Pay $49</button>
          <button class="btn ghost" id="id-reuse" disabled>Reuse the last key for a $99 order</button>
        </div>
        <div class="stats" id="id-stats"></div>
        <ul class="log" id="id-log" aria-live="polite"></ul>`;
      const $ = (id) => root.querySelector(id);
      const state = { charges: [], keys: new Map() };
      let n = 0, lastKey = null, busy = false;
      const draw = () => stats($('#id-stats'), [
        ['Times the customer tapped Pay', n],
        ['Charges on their card', state.charges.length, state.charges.length > n ? 'bad' : (n ? 'ok' : '')],
        ['Total charged', '$' + state.charges.reduce((a, c) => a + c.amount, 0)],
      ]);
      draw();
      $('#id-pay').onclick = () => {
        if (busy) return;
        ctx.tried(); busy = true; n++;
        const key = $('#id-key').checked ? 'key-' + Math.random().toString(16).slice(2, 8) : null;
        const L = $('#id-log');
        const send = (attempt) => {
          log(L, `<b>App</b> POST /payments ${key ? `<code>Idempotency-Key: ${key}</code>` : '(no key)'} attempt ${attempt}`);
          ctx.after(450, () => {
            const r = handlePayment(state, { key, amount: 49 });
            log(L, `<b>Server</b> ${r.replayed ? 'key seen before, returning the saved response. No new charge.' : `charged card, created ${r.charge}`}`, r.replayed ? 'ok' : '');
            draw();
            ctx.after(450, () => {
              if (attempt === 1) { log(L, '<b>Network</b> response lost. The app times out and retries.', 'bad'); ctx.after(500, () => send(2)); }
              else { log(L, `<b>App</b> received 201. Shows "Payment complete". ${pill(state.charges.length > n ? 'double charge' : 'one charge', state.charges.length > n ? 'bad' : 'ok')}`); busy = false; if (key) { lastKey = key; $('#id-reuse').disabled = false; } }
            });
          });
        };
        send(1);
      };
      $('#id-reuse').onclick = () => {
        ctx.tried();
        const r = handlePayment(state, { key: lastKey, amount: 99 });
        log($('#id-log'), `<b>Server</b> ${r.status}: ${r.error}. A key belongs to one specific request.`, 'bad');
      };
    },
  },
  tradeoffs: [
    ['Clients can retry any failed request without fear. This is what makes automatic retries possible at all.', 'You store a record per request and need a policy for expiring them (24 hours is common).'],
    ['Duplicate requests return the original response, so the client cannot tell a retry from a first attempt.', 'Every write endpoint needs the check, and the key must be saved in the same transaction as the work or the guarantee has a hole.'],
    ['Works across crashes and restarts because the key lives in the database.', 'Two attempts arriving at the same instant need handling: one must wait or receive a 409 while the first is still in progress.'],
  ],
  avoid: `<p>You do not need keys for operations that are already idempotent: GET requests, deletes by id, or updates that set an absolute value. Add them wherever a repeat would create something or move money: orders, payments, emails, refunds.</p>`,
  shoplite: 'An <code>idempotency_keys</code> table with a unique constraint, checked inside the checkout transaction.',
  takeaways: [
    'A timeout does not tell the client whether the request succeeded, so clients must retry and servers must make it safe.',
    'The client generates the key once per user action. The server stores it with the result.',
    'Store the key in the same transaction as the work.',
  ],
  quiz: [
    { q: 'Who should generate the idempotency key?',
      options: ['The server, when the request arrives', 'The client, once per user action, reused on every retry', 'The database, as an auto-increment id'], answer: 1,
      why: 'Only the client knows two requests are the same attempt. A server-generated value would differ on each retry.' },
    { q: 'Which of these operations already is idempotent, with no key needed?',
      options: ['POST /orders', 'POST /accounts/7/withdraw {amount: 50}', 'PUT /products/7 {stock: 5}'], answer: 2,
      why: 'Setting stock to 5 twice leaves stock at 5. The other two create or subtract something every time they run.' },
    { q: 'The server saves the charge, then crashes before saving the idempotency key. The client retries. What happens?',
      options: ['The retry is detected and replayed', 'The retry charges again, because the key was never stored', 'The database refuses the retry'], answer: 1,
      why: 'This is why the key and the work must commit in the same transaction: either both exist or neither does.' },
  ],
};
