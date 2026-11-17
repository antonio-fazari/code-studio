import { code, pill } from '../../ui.js';

const models = {
  sql: {
    label: 'Relational (PostgreSQL, MySQL)',
    shape: `customers   (id, name, email)
products    (id, name, category, price)
orders      (id, customer_id → customers, created_at, status)
order_items (order_id → orders, product_id → products, qty, unit_price)`,
  },
  doc: {
    label: 'Document (MongoDB, Firestore)',
    shape: `{ "_id": "order_1042",
  "customer": { "id": "c_42", "name": "Ana Silva" },
  "created_at": "2026-11-02T10:15:00Z",
  "items": [ { "product_id": "p_7", "name": "Trail Runner", "qty": 1, "unit_price": 89 } ],
  "status": "paid" }`,
  },
  kv: {
    label: 'Key-value / wide-column (DynamoDB, Cassandra)',
    shape: `PK            SK                  attributes
CUSTOMER#42   PROFILE             name, email
CUSTOMER#42   ORDER#2026-11-02#1042  status, total
ORDER#1042    ITEM#p_7            name, qty, unit_price`,
  },
};

// [operation, { sql: [grade, note], doc: [...], kv: [...] }]
const ops = [
  ['Show one order with its items and the customer\'s name', {
    sql: ['good', 'One query joining three tables, each step through an index.'],
    doc: ['good', 'One read of one document. Everything the page needs is inside it.'],
    kv: ['good', 'One query on the partition key ORDER#1042 returns the order and its items.'],
  }],
  ['Revenue per product category for last month', {
    sql: ['good', 'One GROUP BY. SQL was built for questions nobody planned for.'],
    doc: ['ok', 'An aggregation pipeline that reads every order of the month. Fine at modest size.'],
    kv: ['poor', 'No ad hoc queries. You would export the data to an analytics warehouse.'],
  }],
  ['Rename a product', {
    sql: ['good', 'Update one row. Every order joins to it and shows the new name.'],
    doc: ['ok', 'The name is copied into each order. Often that is what you want (an invoice should show what was bought), but a true rename means updating many documents.'],
    kv: ['ok', 'Same as documents: data is duplicated per access pattern, so changes fan out.'],
  }],
  ['Add a size chart to shoes only', {
    sql: ['ok', 'A migration, or a JSONB column for per-category attributes.'],
    doc: ['good', 'Add the field to shoe documents. Others are unaffected.'],
    kv: ['good', 'Add the attribute to the items that need it.'],
  }],
  ['Checkout: reduce stock and create the order together', {
    sql: ['good', 'An ordinary ACID transaction (Course 1).'],
    doc: ['ok', 'Atomic within one document. Multi-document transactions exist in MongoDB but cost more and are best kept rare.'],
    kv: ['ok', 'Limited transactions over a small number of items. Design so most writes touch one item.'],
  }],
  ['Serve 200,000 cart reads per second across three continents', {
    sql: ['poor', 'Needs read replicas, sharding and careful multi-region design (lessons 10 to 12). Possible, but you build it.'],
    doc: ['ok', 'Built-in sharding and replica sets. Multi-region writes need care.'],
    kv: ['good', 'Designed for this. Predictable single-digit-millisecond reads at any scale, with managed multi-region tables.'],
  }],
];

export default {
  id: 'sd-sql-nosql',
  part: 'Part 2: Data at scale',
  title: 'SQL vs NoSQL',
  hook: 'Choose the database by its access patterns, not by fashion',
  incident: 'The team moved the product catalogue to a document store to "scale". Month-end finance reports now take a day of scripting instead of one query.',
  buildsOn: 'The stateless tier now scales freely. All of it talks to one PostgreSQL database, and the next lessons are about the data layer. The first question is whether every kind of data belongs in the same kind of database.',
  problem: `
    <p>"SQL or NoSQL" is usually asked as a question of speed or scale. The more useful question is: <strong>what will you ask this data, and how often?</strong></p>
    <p>A relational database stores each fact once, in normalised tables, and lets you ask almost any question later with joins. Most NoSQL databases do the opposite. You decide your queries first, then store data already shaped for them, often duplicated, so each query is a single fast lookup. That makes them easy to spread across many machines and hard to ask anything new.</p>
    <p>ShopLite's catalogue team optimised for one access pattern (show a product page) and lost the many they had not listed.</p>`,
  realWorld: `
    <p>A library catalogue is relational: one record per book, cross-referenced by author, subject and shelf, so any question can be answered. A shop's ready-made gift boxes are documents: everything for one occasion packed together, instant to hand over, and awkward if you want "all the candles in every box".</p>
    <p>Amazon's 2007 Dynamo paper describes a key-value store built so that the shopping cart could always accept writes, even during failures. It became the model for DynamoDB and Cassandra. Discord moved its message history from MongoDB to Cassandra in 2017 when the data outgrew what one replica set could hold, because messages are read in one predictable way: by channel, newest first. Most large companies run both kinds, each for the data it suits.</p>`,
  approach: `
    <p>Write the access patterns down before choosing. For each one: what is the key, how often does it run, how much data does it touch, does it need to be strongly consistent?</p>
    <ul>
      <li><strong>Start relational</strong> for core business data (customers, orders, payments). You get transactions, constraints that protect the data, and the freedom to ask new questions. PostgreSQL also stores JSON well, which covers many "flexible schema" needs.</li>
      <li><strong>Use a key-value or wide-column store</strong> for data with a few known access patterns at very high volume: carts, sessions, activity feeds, messages, device telemetry.</li>
      <li><strong>Use a document store</strong> when records are naturally self-contained and vary in shape, and are mostly read whole.</li>
      <li><strong>Use a search engine or a warehouse</strong> for full-text search and analytics, fed from the primary database. Do not bend the main database into both.</li>
    </ul>
    ${code(`
-- Relational: the question can be new tomorrow
SELECT p.category, SUM(i.qty * i.unit_price) AS revenue
FROM order_items i JOIN orders o ON o.id = i.order_id JOIN products p ON p.id = i.product_id
WHERE o.created_at >= date_trunc('month', now()) - interval '1 month'
GROUP BY p.category;`, 'sql')}
    ${code(`
// Key-value: the question was designed in advance, and is one lookup
await dynamo.query({
  TableName: 'shoplite',
  KeyConditionExpression: 'PK = :c AND begins_with(SK, :o)',
  ExpressionAttributeValues: { ':c': 'CUSTOMER#42', ':o': 'ORDER#' },
  ScanIndexForward: false, Limit: 20,
});`, 'js')}
    <p>Using more than one database (polyglot persistence) is normal. Each extra one is another system to run, back up, secure and keep in sync, so add them for a clear reason.</p>`,
  sim: {
    title: 'Same shop, three data models',
    intro: 'Pick a model to see how ShopLite\'s orders would be stored, and how well it handles six real requests.',
    mount(root, ctx) {
      root.innerHTML = `
        <div class="controls">
          <label class="field" for="db-model"><span>Data model</span><select id="db-model">${Object.entries(models).map(([k, m]) => `<option value="${k}">${m.label}</option>`).join('')}</select></label>
        </div>
        <div id="db-shape"></div>
        <div class="tablewrap"><table id="db-ops"></table></div>
        <p class="sim-note" id="db-sum" role="status"></p>`;
      const $ = (id) => root.querySelector(id);
      const label = { good: ['Good fit', 'ok'], ok: ['Workable', 'warn'], poor: ['Poor fit', 'bad'] };
      const draw = (user) => {
        if (user) ctx.tried();
        const m = $('#db-model').value;
        $('#db-shape').innerHTML = code(models[m].shape);
        $('#db-ops').innerHTML = `<thead><tr><th>Request</th><th>Fit</th><th>Why</th></tr></thead><tbody>${ops.map(([op, g]) => `<tr><td>${op}</td><td>${pill(...label[g[m][0]])}</td><td>${g[m][1]}</td></tr>`).join('')}</tbody>`;
        const n = (grade) => ops.filter(([, g]) => g[m][0] === grade).length;
        $('#db-sum').textContent = `${n('good')} good fits, ${n('ok')} workable, ${n('poor')} poor. No model wins every row. Choose the one whose good rows are the requests you make most.`;
      };
      $('#db-model').onchange = () => draw(true);
      draw(false);
    },
  },
  tradeoffs: [
    ['<strong>Relational:</strong> transactions, constraints and ad hoc queries. Data is stored once, so it stays consistent.', 'Scaling writes past one machine needs sharding you design yourself, and the schema must be migrated as it changes.'],
    ['<strong>Key-value / wide-column:</strong> predictable performance at almost any scale, with partitioning and replication built in.', 'You must know your queries up front. New questions mean new tables or duplicated data, and joins happen in your code.'],
    ['<strong>Document:</strong> flexible, self-contained records that map naturally to objects in code.', 'Duplicated data drifts out of sync, and relationships across documents are awkward and less safe.'],
  ],
  avoid: `<p>Do not move to NoSQL for scale you do not have. A single well-indexed PostgreSQL server with replicas handles far more than most products ever need. Do not pick a document store to avoid writing a schema; the schema still exists, it just lives in your code with no database checking it. And do not split one transactional workflow (an order and its payment) across two different databases unless you are ready for lesson 9.</p>`,
  shoplite: 'Orders, customers and payments stay in PostgreSQL. Carts and sessions move to a key-value store. Product search goes to a search engine fed from PostgreSQL.',
  takeaways: [
    'Relational databases answer questions you have not thought of yet. Most NoSQL stores answer the ones you designed for, very fast.',
    'List the access patterns first, then choose.',
    'Using more than one database is normal, and each one has a running cost.',
  ],
  quiz: [
    { q: 'Finance needs new kinds of reports every quarter. Which store suits the order data best?',
      options: ['A key-value store keyed by order id', 'A relational database (or a warehouse fed from one)', 'An in-memory cache'], answer: 1,
      why: 'Ad hoc questions over related data are what SQL and joins are for.' },
    { q: 'Why do DynamoDB and Cassandra designs often store the same data more than once?',
      options: ['To make backups easier', 'Because each table is shaped for one access pattern, and they do not join', 'Because they lose data otherwise'], answer: 1,
      why: 'Without joins, each query needs its data already together under one key.' },
    { q: 'A team wants to move to a document store "because our schema keeps changing". What is the strongest counterpoint?',
      options: ['Document stores cannot store nested data', 'The schema does not go away; it moves into application code with nothing enforcing it', 'Document stores are always slower'], answer: 1,
      why: 'Old documents in the old shape stay around. PostgreSQL\'s JSONB columns often give the flexibility with fewer surprises.' },
  ],
};
