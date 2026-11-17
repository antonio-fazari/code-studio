import { code, pill, stats } from '../../ui.js';
import { runConsumer } from '../../engines-sd.js';

const modes = {
  'at-most-once': 'Commit the offset, then add the points',
  'at-least-once': 'Add the points, then commit the offset',
  dedupe: 'Add the points and record the message id in one transaction, then commit',
};
const text = {
  deliver: (a) => `Message "order 1042 paid: add 100 points" delivered${a > 1 ? ' again' : ''}.`,
  commit: () => 'Offset committed: the queue will not send this message again.',
  effect: () => 'Added 100 loyalty points.',
  'effect+record': () => 'In one transaction: added 100 points and stored message id msg-1 as processed.',
  skip: () => 'msg-1 is already in the processed table. Skipped, no points added.',
  crash: () => 'The consumer crashes here and restarts.',
};

export default {
  id: 'sd-idempotency',
  part: 'Part 4: Services',
  title: 'Idempotency at Scale',
  hook: 'Exactly-once delivery does not exist. Exactly-once effects do.',
  incident: 'After a deploy restarted every consumer, 3,100 customers received double loyalty points and 214 received the same order confirmation email twice.',
  revisits: { id: 'idempotency', note: 'That lesson made an API endpoint safe to retry with an idempotency key from the client. Here the retries come from the queue itself, and every consumer in every service has to be safe.' },
  buildsOn: 'Events flow through partitioned topics to many consumer groups. Each consumer reads a message, does something, then records its position (commits the offset). Something can fail between any two of those steps.',
  problem: `
    <p>A consumer does two things for every message: performs the effect (add points, send an email, update a row) and tells the queue it is done. They cannot happen at the same instant, so a crash between them leaves one done and the other not:</p>
    <ul>
      <li><strong>Commit first, then act</strong>: a crash after the commit loses the effect forever. That is <em>at-most-once</em>.</li>
      <li><strong>Act first, then commit</strong>: a crash before the commit means the message is delivered again and the effect happens twice. That is <em>at-least-once</em>.</li>
    </ul>
    <p>Restarts, deploys, rebalances and network blips all cause redelivery, so at scale duplicates are routine, not rare. No queue can promise exactly-once <em>delivery</em> to a consumer that has side effects outside it.</p>`,
  realWorld: `
    <p>A post office sends registered letters with a tracking number. If the courier is unsure whether a letter arrived, they deliver it again. The recipient's clerk checks the tracking number against a ledger and files the duplicate in the bin. Delivery is at least once; the effect is exactly once because the receiver remembers what it has handled.</p>
    <p>Kafka added an idempotent producer and transactions in 2017 (version 0.11), which give exactly-once results for pipelines that read from Kafka and write back to Kafka. As soon as a consumer touches anything outside, such as a database, an email provider or a payment API, the guarantee stops at the boundary, and the consumer has to deduplicate itself.</p>`,
  approach: `
    <p>The pattern is <strong>at-least-once delivery plus idempotent processing</strong>, often called <em>effectively once</em>.</p>
    <p><strong>1. Prefer naturally idempotent effects.</strong> "Set order 1042's status to paid" can run twice safely. "Add 100 points" cannot. Where you can, write the absolute result or upsert by a natural key.</p>
    <p><strong>2. Otherwise, record what you processed, atomically with the effect.</strong></p>
    ${code(`
BEGIN;
INSERT INTO processed_messages (consumer, message_id) VALUES ('loyalty', $1)
  ON CONFLICT DO NOTHING;                          -- 0 rows: already handled, stop here
UPDATE loyalty SET points = points + 100 WHERE customer_id = $2;
COMMIT;
-- only now commit the queue offset; a crash before this just replays a no-op`, 'sql')}
    <p>The record and the effect share one transaction, so they cannot disagree. This is the Course 1 idempotency key, with the message id as the key.</p>
    <p><strong>3. Make the producer side safe too.</strong> A producer that retries after a timeout may write the same event twice. Give every event a unique id at creation (the outbox row's id works), enable the broker's idempotent producer where it exists, and let consumers deduplicate on that id.</p>
    <p><strong>4. Pass keys across the boundary.</strong> For effects in other systems, send an idempotency key derived from the message id: the payment provider's <code>Idempotency-Key</code> header, or an email provider's message id. If the external system has no such feature, accept and document that duplicates are possible.</p>
    <p>Keep processed ids at least as long as messages can be redelivered (the topic's retention), then expire them.</p>`,
  sim: {
    title: 'Crash between two steps',
    intro: 'One message tells the loyalty service to add 100 points. Choose the order of the steps, decide whether the consumer crashes after the first step, and run it. The correct result is 100 points.',
    mount(root, ctx) {
      root.innerHTML = `
        <div class="controls">
          <label class="field" for="id-mode"><span>Consumer does</span><select id="id-mode">${Object.entries(modes).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <label class="check" for="id-crash"><input type="checkbox" id="id-crash" checked> Crash after the first step</label>
          <button class="btn" id="id-run">Run</button>
        </div>
        <ol class="timeline" id="id-log"></ol>
        <div class="stats" id="id-stats"></div>
        <p class="sim-note" id="id-verdict" role="status"></p>`;
      const $ = (id) => root.querySelector(id);
      $('#id-run').onclick = () => {
        ctx.tried();
        const mode = $('#id-mode').value, r = runConsumer({ mode, crash: $('#id-crash').checked });
        $('#id-log').innerHTML = ''; $('#id-stats').innerHTML = ''; $('#id-verdict').innerHTML = '';
        r.log.forEach(([step, attempt], i) => ctx.after(i * 320, () => $('#id-log').insertAdjacentHTML('beforeend',
          `<li class="who-${step === 'crash' ? 'B' : 'A'}"><span class="who">Attempt ${attempt}</span><span class="tl-note">${text[step](attempt)}</span></li>`)));
        ctx.after(r.log.length * 320, () => {
          stats($('#id-stats'), [['Points added', r.points, r.points === 100 ? 'ok' : 'bad'], ['Times the message was delivered', r.log.filter(([s]) => s === 'deliver').length]]);
          $('#id-verdict').innerHTML = r.points === 100 ? `${pill('Exactly-once effect', 'ok')} ${mode === 'dedupe' && $('#id-crash').checked ? 'The message arrived twice, but the processed-id record turned the second delivery into a no-op.' : 'No crash, so every approach works. The difference only shows when something fails.'}`
            : r.points === 0 ? `${pill('Lost', 'bad')} The offset was committed before the work was done, so the queue will never deliver it again. The customer never gets their points.`
            : `${pill('Duplicated', 'bad')} The points were added, the offset was not committed, so the message came back and the points were added again.`;
        });
      };
    },
  },
  tradeoffs: [
    ['At-least-once delivery with deduplication gives exactly-once effects, even across crashes and redelivery.', 'Every non-idempotent consumer needs a processed-ids table written in the same transaction as its effect.'],
    ['Naturally idempotent operations (set, upsert) need no extra storage.', 'Not every effect can be expressed that way. Counters, balances and emails cannot.'],
    ['Broker features (idempotent producers, transactions) remove duplicates inside the broker.', 'They stop at the broker\'s edge. Databases and external APIs still need their own keys.'],
  ],
  avoid: `<p>At-most-once is acceptable for data where a loss does not matter and a duplicate would: some metrics, or a "user is typing" signal. For everything that moves money, points, stock or sends a message to a person, use at-least-once with idempotent consumers. Do not try to get exactly-once by tuning timeouts; there is always a window.</p>`,
  shoplite: 'Every consumer that changes state records message ids in a processed_messages table in the same transaction, events carry the outbox row id, and calls to Stripe and the email provider pass that id as their idempotency key.',
  takeaways: [
    'A consumer cannot act and acknowledge at the same instant, so delivery is at-most-once or at-least-once.',
    'Choose at-least-once, and make processing idempotent: effectively once.',
    'Store the processed message id in the same transaction as the effect.',
  ],
  quiz: [
    { q: 'A consumer adds points, then commits its offset. It crashes between the two. What happens?',
      options: ['The points are lost', 'The message is redelivered and, without deduplication, the points are added twice', 'The queue rolls back the points'], answer: 1,
      why: 'Act-then-commit is at-least-once. Redelivery is guaranteed, so the effect must be safe to repeat.' },
    { q: 'Why must the processed-message record be written in the same transaction as the effect?',
      options: ['It is faster', 'Otherwise a crash can leave the effect without the record, or the record without the effect', 'The queue requires it'], answer: 1,
      why: 'Separate writes can disagree after a crash, which brings back either duplicates or losses.' },
    { q: 'Which consumer operation is already idempotent?',
      options: ['UPDATE orders SET status = \'shipped\' WHERE id = 1042', 'UPDATE loyalty SET points = points + 100', 'Send a confirmation email'], answer: 0,
      why: 'Setting an absolute value twice leaves the same result. The others change the world each time they run.' },
  ],
};
