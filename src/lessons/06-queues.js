import { code, log, ms, pill, slider, bindSlider, stats } from '../ui.js';

export default {
  id: 'queues',
  title: 'Message Queues',
  hook: 'Kafka and SQS for work that can happen later',
  incident: 'The email provider had a 20-minute outage. For those 20 minutes nobody could place an order.',
  buildsOn: 'Reads are cached. The write path is the slow one now: checkout does several things the customer does not need to wait for.',
  problem: `
    <p>After the order is saved, checkout sends a confirmation email (1.2 s), generates a PDF invoice (0.9 s) and notifies the warehouse (0.6 s). The customer watches a spinner for nearly 3 seconds. Worse, when the email provider is down, the whole request fails, even though the order itself was fine.</p>
    <p>The order must be saved now. The email only has to be sent soon. Treating both as one synchronous request ties the reliability of checkout to its least reliable dependency.</p>`,
  realWorld: `
    <p>A restaurant works this way. The waiter takes your order, puts a ticket on the rail and returns to the floor. The kitchen works through tickets at its own pace. A busy night makes the rail longer. It does not stop the waiter from taking orders.</p>
    <p>Kafka was built at LinkedIn to move activity events between systems without each one calling the others directly. Amazon's SQS exists for the same reason: an order service drops a message, and billing, shipping and email each pick it up when they are ready.</p>`,
  approach: `
    <p>Checkout saves the order, puts a small message on a <strong>queue</strong> and responds. Separate <strong>worker</strong> processes pull messages and do the slow work. A worker acknowledges a message only after finishing it. If the worker crashes, the message becomes visible again and another worker takes it.</p>
    ${code(`
// API: fast path
await db.transaction(async (tx) => {
  const order = await createOrder(tx, cart);
  await tx.insert('outbox', { type: 'order.placed', order_id: order.id });
});
return res.status(201).json(order);   // about 90 ms

// Worker: slow path, running elsewhere
queue.subscribe('order.placed', async (msg) => {
  await sendConfirmationEmail(msg.order_id);   // may fail and be retried
  msg.ack();                                   // only now is it removed
});`, 'js')}
    <p>Two consequences follow, and both connect to earlier lessons:</p>
    <ul>
      <li><strong>Messages can arrive more than once.</strong> If a worker sends the email and crashes before the ack, the message is delivered again. Workers must be idempotent (lesson 3), for example by recording "confirmation sent for order 1042".</li>
      <li><strong>Publish in the same transaction as the data.</strong> The snippet writes to an <em>outbox</em> table inside the order transaction (lesson 2), and a relay forwards rows to the queue. Otherwise a crash between "commit" and "publish" loses the message.</li>
    </ul>
    <p>Messages that keep failing go to a <strong>dead-letter queue</strong> after a few attempts so one bad message cannot block the rest.</p>`,
  sim: {
    title: 'Checkout with and without a queue',
    intro: 'Place some orders. Then take the email provider down and try again in both modes.',
    mount(root, ctx) {
      root.innerHTML = `
        <div class="controls">
          <label class="check" for="mq-on"><input type="checkbox" id="mq-on"> Use a queue</label>
          <label class="check" for="mq-down"><input type="checkbox" id="mq-down"> Email provider is down</label>
        </div>
        <div class="controls">
          <button class="btn" id="mq-one">Place order</button>
          <button class="btn ghost" id="mq-ten">Flash sale: 10 orders</button>
        </div>
        ${slider('mq-workers', 'Workers:', 1, 5, 1)}
        <div class="stats" id="mq-stats"></div>
        <div class="queue" id="mq-queue" aria-hidden="true"></div>
        <ul class="log" id="mq-log" aria-live="polite"></ul>`;
      const $ = (id) => root.querySelector(id);
      const workers = bindSlider(root, 'mq-workers', String, (v, user) => { if (user) ctx.tried(); });
      const queue = [];
      let nextId = 1041, placed = 0, failed = 0, emails = 0, dead = 0, busy = 0, lastMs = null;
      const draw = () => {
        stats($('#mq-stats'), [
          ['Orders accepted', placed, 'ok'], ['Orders failed', failed, failed ? 'bad' : ''],
          ['Last response time', lastMs == null ? 'n/a' : ms(lastMs)],
          ['Waiting in queue', queue.length], ['Emails sent', emails], ['Dead-lettered', dead, dead ? 'warn' : ''],
        ]);
        $('#mq-queue').innerHTML = queue.map((j) => `<span class="job${j.tries ? ' retry' : ''}">#${j.id}${j.tries ? ' ↻' + j.tries : ''}</span>`).join('') || '<span class="empty">queue is empty</span>';
      };
      function order() {
        const id = nextId++;
        const down = $('#mq-down').checked;
        if ($('#mq-on').checked) {
          placed++; lastMs = 90; queue.push({ id, tries: 0 });
          log($('#mq-log'), `${pill('201', 'ok')} order #${id} accepted in 90 ms, message queued`);
        } else if (down) {
          failed++; lastMs = 5000;
          log($('#mq-log'), `${pill('500', 'bad')} order #${id} failed after 5 s: email provider did not respond`);
        } else {
          placed++; emails++; lastMs = 2790;
          log($('#mq-log'), `${pill('201', 'ok')} order #${id} accepted in 2.8 s (order 90 ms + email 1.2 s + invoice 0.9 s + warehouse 0.6 s)`);
        }
        draw();
      }
      // Each tick, every free worker takes the next job.
      ctx.every(300, () => {
        while (busy < workers() && queue.length) {
          const job = queue.shift(); busy++;
          ctx.after(1200, () => {
            busy--;
            if ($('#mq-down').checked) {
              job.tries++;
              if (job.tries >= 3) { dead++; log($('#mq-log'), `${pill('DLQ', 'warn')} order #${job.id} email failed 3 times, moved to the dead-letter queue for a human to check`); }
              else { queue.push(job); log($('#mq-log'), `<b>Worker</b> email for #${job.id} failed, back on the queue (attempt ${job.tries})`); }
            } else { emails++; log($('#mq-log'), `<b>Worker</b> sent confirmation for #${job.id}`); }
            draw();
          });
        }
        draw();
      });
      $('#mq-one').onclick = () => { ctx.tried(); order(); };
      $('#mq-ten').onclick = () => { ctx.tried(); for (let i = 0; i < 10; i++) order(); };
      draw();
    },
  },
  tradeoffs: [
    ['The customer gets a response in milliseconds. Slow work happens after.', 'The work is no longer done when the response is sent. "Order placed" and "email sent" can be seconds or minutes apart.'],
    ['An outage in email, invoicing or the warehouse no longer breaks checkout. Messages wait and are processed on recovery.', 'Delivery is at-least-once. Every consumer has to tolerate duplicates.'],
    ['Spikes are absorbed as queue depth. You add workers to drain faster without touching the API.', 'Order of processing is not guaranteed by default, failures happen out of sight, and you must monitor queue depth and the dead-letter queue.'],
    ['Producers and consumers deploy and scale independently.', 'A broker is another system to run, and tracing one order now spans several processes (lesson 11).'],
  ],
  avoid: `<p>Do not queue work whose result the caller needs in the response. If the customer must know right now whether the payment succeeded, that call stays synchronous. A small app with one slow task can start with a jobs table in its own database and a worker loop. Bring in Kafka when you have many consumers or need to replay history. For simple background jobs, SQS or a Redis-backed queue is less to operate.</p>`,
  shoplite: 'An outbox table, an <code>order.placed</code> queue, and a worker for emails and invoices with a dead-letter queue.',
  takeaways: [
    'Do the minimum inside the request. Queue everything that only needs to happen soon.',
    'A queue turns a dependency outage into a delay.',
    'Assume every message can be delivered twice, and make consumers idempotent.',
  ],
  quiz: [
    { q: 'A worker sends the confirmation email, then crashes before acknowledging the message. What happens next?',
      options: ['The message is lost', 'The message is delivered again and the email may be sent twice', 'The queue pauses until the worker restarts'], answer: 1,
      why: 'Unacknowledged messages are redelivered. This is at-least-once delivery, and it is why workers need the idempotency technique from lesson 3.' },
    { q: 'Which task should stay synchronous in checkout?',
      options: ['Generating the PDF invoice', 'Authorizing the card so the customer knows whether payment succeeded', 'Notifying the analytics system'], answer: 1,
      why: 'The response depends on the result. Everything the customer does not need to see immediately can be queued.' },
    { q: 'Queue depth has been growing steadily for an hour. What does that tell you?',
      options: ['Messages are arriving faster than workers process them', 'The queue is working as designed and needs no action', 'The API is rejecting orders'], answer: 0,
      why: 'A queue absorbs a spike, but steady growth means you need more workers or faster ones. Depth is the metric to alert on.' },
  ],
};
