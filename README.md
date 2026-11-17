# Code Studio

Two interactive courses that follow one online shop, ShopLite, as it grows from a single
slow query into a global system. Each lesson starts from a production problem the
previous lesson left open.

## Course 1: Backend Foundations

| # | Lesson | The production problem it starts from |
|---|--------|----------------------------------------|
| 1 | Indexes | Order lookup takes 2 seconds |
| 2 | Transactions & Isolation | Two customers buy the last item |
| 3 | Idempotency Keys | A retried payment charges twice |
| 4 | Connection Pooling | A traffic spike exhausts database connections |
| 5 | Caching & TTLs | The same slow page is computed thousands of times |
| 6 | Message Queues | An email outage blocks checkout |
| 7 | Rate Limiting | One client floods the API |
| 8 | Auth | A departed employee still has access |
| 9 | Pagination | Deep pages crawl and repeat rows |
| 10 | Timeouts & Retries | A slow provider causes a retry storm |
| 11 | Logs, Metrics, Traces | Nobody knows where the time goes |
| 12 | Docker | It works on one machine only |
| ★ | Capstone | Build one API that uses all twelve |

## Course 2: System Design

| # | Lesson | The production problem it starts from |
|---|--------|----------------------------------------|
| | **Part 1: Getting traffic in** | |
| 1 | DNS | A data centre move takes days to reach everyone |
| 2 | CDNs | Pages are slow on the far side of the world |
| 3 | Horizontal Scaling | One server cannot carry a flash sale |
| 4 | Load Balancing | One slow server drags down a sixth of requests |
| 5 | Caching at Scale | A cache restart overloads the database |
| 6 | Rate Limiting at Scale | Window boundaries and per-server counters leak |
| | **Part 2: Data at scale** | |
| 7 | SQL vs NoSQL | A database chosen for one query cannot answer others |
| 8 | Indexing in Depth | A write-heavy table falls behind its indexes |
| 9 | ACID Across Services | A card is charged for an order that never ships |
| 10 | Replication | Customers see their old address after changing it |
| 11 | Sharding | The orders table outgrows one machine |
| 12 | Consistent Hashing | Adding a cache node invalidates most of the cache |
| | **Part 3: Distributed trade-offs** | |
| 13 | CAP Theorem | A network split oversells a limited item |
| 14 | Eventual Consistency | Merged carts lose and resurrect items |
| 15 | Consensus | Two database leaders at once |
| | **Part 4: Services** | |
| 16 | Microservices | One shared deploy pipeline blocks every team |
| 17 | Message Queues at Scale | Order events are processed out of order |
| 18 | Idempotency at Scale | Consumer restarts double the loyalty points |
| 19 | Circuit Breakers | A failing optional service takes down checkout |
| 20 | Observability at Scale | Averages look fine while some users wait seconds |
| ★ | Capstone | Requirements, capacity estimate, request walkthrough, design review |

Seven System Design lessons revisit a Backend Foundations topic at multi-machine scale and
link back to it.

Every lesson has the same parts: the problem, a real-world example, the approach with
code, an interactive simulation, trade-offs, when to leave it out, and a three-question
quiz. A lesson is complete when all three answers are right.

## Run it

```sh
npm start        # serves the app at http://localhost:5173
npm test         # unit tests for the simulation engines and the progress store
```

There are no dependencies and no build step. Any static file server works, and the
repository root can be published as-is (for example with GitHub Pages).

## Design

- **Language:** plain JavaScript (ES modules), HTML and CSS. No framework.
- **Progress:** saved to `localStorage` on every change, for both courses. The catalogue
  page offers a progress code to copy to another browser, and a reset.
- **Routing:** the URL hash (`#indexes`, `#sd-dns`, `#system-design`), so lessons can be
  bookmarked.

```
index.html                          page shell
styles.css                          design tokens (light and dark) and all styling
server.js                           tiny static server for local development
src/app.js                          router, course catalogue, sidebar, lesson and quiz rendering
src/store.js                        progress state: quiz answers, checklists, export/import
src/engines.js                      simulation logic for Backend Foundations
src/engines-sd.js                   simulation logic for System Design (hash ring, LRU, Raft, ...)
src/ui.js                           DOM helpers shared by the simulations
src/courses/index.js                course registry
src/courses/backend-foundations/    12 lessons and the capstone
src/courses/system-design/          20 lessons and the capstone
test/                               node:test suites, including a content check of every lesson
```

### Adding a lesson or a course

Lesson ids must be unique across all courses, because they are both the URL (`#sd-cap`)
and the progress key. A course is an entry in `src/courses/index.js` with its lessons and
a capstone. A lesson is a module that exports an object with `id`, `title`, `hook`,
`incident`, `buildsOn`, `problem`, `realWorld`, `approach`, `sim { title, intro, mount }`,
`tradeoffs`, `avoid`, `shoplite`, `takeaways` and `quiz` (plus optional `part` and
`revisits`), listed in its course's `index.js`. `npm test` checks every lesson's shape.

`mount(root, ctx)` receives `ctx.tried()`, `ctx.every()` and `ctx.after()`; timers created
through `ctx` are cleared when the reader leaves the page.
