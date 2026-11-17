import { code, slider, bindSlider, stats, pill } from '../../ui.js';
import { simulateConsume } from '../../engines-sd.js';

export default {
  id: 'sd-queues',
  part: 'Part 4: Services',
  title: 'Message Queues at Scale',
  hook: 'Partitions, keys and consumer groups: parallel processing that keeps order where it matters',
  incident: 'Shipping received "order 1042 shipped" before "order 1042 paid", rejected it as invalid, and the parcel sat in the warehouse for two days.',
  revisits: { id: 'queues', note: 'That lesson moved slow work off the request onto a single queue with a few workers. Here the queue carries every event between services, and it has to be split up to keep pace.' },
  buildsOn: 'ShopLite\'s services now talk through events: Checkout publishes order.created, Payments publishes order.paid, Shipping listens to both. A single queue with one consumer cannot keep up, so the team added more consumers.',
  problem: `
    <p>One queue with one consumer processes events in order, but only as fast as that one consumer. Add consumers and throughput rises, but now two events for the same order can be handled by different consumers at the same time. If the consumer with "paid" is slower than the one with "shipped", they finish in the wrong order.</p>
    <p>You want parallelism across orders, and strict order within each order. Logs such as Kafka, and services such as Amazon Kinesis or SQS FIFO with message groups, offer exactly this through <strong>partitions</strong> and <strong>keys</strong>.</p>`,
  realWorld: `
    <p>At a supermarket with many checkouts, each family's shopping goes through one lane, item after item, while other families use other lanes at the same time. The store gets parallelism across families and order within each family.</p>
    <p>Kafka was built at LinkedIn and open-sourced in 2011 to carry activity events between systems. LinkedIn has reported moving trillions of messages a day through it. It is now the usual backbone for event-driven systems, with Amazon Kinesis, Google Pub/Sub, Pulsar and Redpanda as alternatives.</p>`,
  approach: `
    <p>A <strong>topic</strong> such as <code>orders</code> is split into <strong>partitions</strong>. Each partition is an ordered, append-only log. Ordering is guaranteed only within a partition.</p>
    <ul>
      <li><strong>Keys decide partitions.</strong> The producer gives each event a key, and all events with the same key go to the same partition. Key by order id and every event for order 1042 stays in order.</li>
      <li><strong>Consumer groups share the work.</strong> Each partition is read by exactly one consumer in a group at a time. A group of 4 consumers on 8 partitions gets 2 partitions each. A 9th consumer on 8 partitions has nothing to do.</li>
      <li><strong>Several groups read independently.</strong> Shipping, Email and Analytics each have their own group and their own position (offset) in the same topic. This is publish-subscribe: one event, many readers.</li>
      <li><strong>Events are kept.</strong> Kafka retains messages for a configured time after they are read, so a new service can replay history and a buggy consumer can rewind.</li>
    </ul>
    ${code(`
// Producer: the key keeps one order's events together and in order
await producer.send({ topic: 'orders', messages: [
  { key: 'order-1042', value: JSON.stringify({ type: 'paid', orderId: 1042, amount: 8900 }) },
]});

// Consumer: every instance with this groupId shares the partitions
const consumer = kafka.consumer({ groupId: 'shipping' });
await consumer.subscribe({ topic: 'orders' });
await consumer.run({ eachMessage: async ({ partition, message }) => handle(JSON.parse(message.value)) });`, 'js')}
    <p><strong>Choosing partitions.</strong> The partition count caps how many consumers in a group can work at once, so size it for future peak throughput; adding partitions later changes which partition a key maps to (the lesson 12 problem). A key that is too coarse, such as country, creates a hot partition one consumer cannot keep up with.</p>
    <p><strong>Watch consumer lag</strong>, the gap between the newest event and each group's position. It is the queue depth from Course 1, per partition.</p>`,
  sim: {
    title: 'Partitions and a consumer group',
    intro: '16 orders each publish created, paid and shipped a few milliseconds apart. Consumer 1 shares a busy host and runs at half speed. Change the partitions, consumers and keying, and count orders whose events finish out of order.',
    mount(root, ctx) {
      root.innerHTML = `
        ${slider('mq-p', 'Partitions:', 1, 8, 4)}
        ${slider('mq-c', 'Consumers in the group:', 1, 8, 2)}
        <label class="check" for="mq-key"><input type="checkbox" id="mq-key"> Use the order id as the message key</label>
        <div class="parts" id="mq-parts"></div>
        <div class="stats" id="mq-stats"></div>
        <p class="sim-note" id="mq-note" role="status"></p>`;
      const $ = (id) => root.querySelector(id);
      let P, C;
      const draw = (v, user) => {
        if (user) ctx.tried();
        if (!P || !C) return;
        const keyed = $('#mq-key').checked;
        const r = simulateConsume({ partitions: P(), consumers: C(), keyed });
        const bad = new Set();
        const byOrder = {};
        r.processed.forEach((e) => (byOrder[e.order] ??= [])[e.seq] = e.done);
        Object.entries(byOrder).forEach(([o, d]) => { if (d[1] < d[0] || d[2] < d[1]) bad.add(+o); });
        $('#mq-parts').innerHTML = Array.from({ length: P() }, (_, p) => {
          const evs = r.processed.filter((e) => e.partition === p);
          return `<div class="part"><span class="part-name">Partition ${p} → consumer ${r.owner[p] + 1}</span><div class="lsm-row">${evs.map((e) => `<span class="kv ev-${e.seq} ${bad.has(e.order) ? 'bad' : ''}" title="Order ${e.order} ${e.type}">${e.order % 100}<small>${e.type}</small></span>`).join('')}</div></div>`;
        }).join('');
        stats($('#mq-stats'), [
          ['Orders processed out of order', `${r.outOfOrder} of 16`, r.outOfOrder ? 'bad' : 'ok'],
          ['Idle consumers', r.idle, r.idle ? 'warn' : ''],
          ['Consumers doing work', Math.min(C(), P())],
        ]);
        $('#mq-note').textContent = r.idle ? `There are more consumers than partitions, so ${r.idle} sit idle. Partitions cap a group's parallelism.`
          : !keyed && r.outOfOrder ? 'Without a key, one order\'s events are spread over partitions and handled by different consumers at different speeds. Highlighted orders finished out of order.'
          : keyed ? 'With the order id as key, each order\'s events share a partition and one consumer, so they always finish in order, while different orders run in parallel.'
          : 'With one consumer, everything is processed in sequence, so order holds, but there is no parallelism.';
      };
      P = bindSlider(root, 'mq-p', String, draw);
      C = bindSlider(root, 'mq-c', String, draw);
      $('#mq-key').onchange = () => draw(0, true);
      draw();
    },
  },
  tradeoffs: [
    ['Throughput scales with partitions and consumers, while each key keeps its order.', 'Ordering holds only within a partition. Anything that needs order across keys needs one partition, and so one consumer.'],
    ['Many independent consumer groups read the same events, and history can be replayed.', 'Retention costs storage, and consumers must cope with replays and redelivery (next lesson).'],
    ['Partition count sets parallelism up front, predictably.', 'Too few partitions cap growth; adding them later remaps keys. A hot key makes one partition, and its consumer, the bottleneck.'],
  ],
  avoid: `<p>A simple job queue (SQS, a Redis-backed queue, or a jobs table) is easier to run than Kafka when you have one consumer type, do not need replay and do not care about order. Do not key by a value with few possibilities or a heavy skew (country, a giant customer); you will get a hot partition. And do not rely on order you have not asked for with a key.</p>`,
  shoplite: 'An orders topic with 24 partitions keyed by order id. Shipping, Email and Analytics each read it with their own consumer group, with alerts on consumer lag.',
  takeaways: [
    'Partitions give parallelism. Keys keep related events in one partition, and so in order.',
    'Each partition is read by one consumer per group, so partitions cap a group\'s parallelism.',
    'Separate consumer groups each read every event: one topic, many subscribers.',
  ],
  quiz: [
    { q: 'A topic has 6 partitions. You run 10 consumers in the same group. How many do work?',
      options: ['10', '6', '1'], answer: 1,
      why: 'Each partition goes to one consumer in the group. The other 4 wait as standbys.' },
    { q: 'Shipping must see each order\'s events in order. What should the producer do?',
      options: ['Use one partition for the whole topic', 'Use the order id as the message key', 'Add more consumers'], answer: 1,
      why: 'Same key, same partition, same order. One partition would also work, but would give up all parallelism.' },
    { q: 'Email and Analytics both need every order event. How do they consume them?',
      options: ['In the same consumer group, splitting the partitions', 'In separate consumer groups, each reading every event', 'Each from its own copy of the topic'], answer: 1,
      why: 'Within a group, consumers split the work. Across groups, each gets everything.' },
  ],
};
