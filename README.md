# Backend Foundations

An interactive course on twelve backend engineering concepts. You follow one API,
ShopLite, as it grows from a single slow query into a production system. Each lesson
starts from a problem the previous lesson left open.

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
- **Progress:** saved to `localStorage` on every change. The overview page offers a
  progress code to copy to another browser, and a reset.
- **Routing:** the URL hash (`#indexes`, `#capstone`), so lessons can be bookmarked.

```
index.html          page shell
styles.css          design tokens (light and dark) and all styling
server.js           tiny static server for local development
src/app.js          router, sidebar, lesson and quiz rendering
src/store.js        progress state: quiz answers, checklist, export/import
src/engines.js      pure simulation logic (token bucket, backoff, pool, ...)
src/ui.js           DOM helpers shared by the simulations
src/capstone.js     final page: request walkthrough and build checklist
src/lessons/        one module per lesson: content, simulation, quiz
test/               node:test suites
```

### Adding a lesson

Create a module in `src/lessons/` that exports an object with `id`, `title`, `hook`,
`incident`, `buildsOn`, `problem`, `realWorld`, `approach`, `sim { title, intro, mount }`,
`tradeoffs`, `avoid`, `shoplite`, `takeaways` and `quiz`, then add it to
`src/lessons/index.js`. `mount(root, ctx)` receives `ctx.tried()`, `ctx.every()` and
`ctx.after()`; timers created through `ctx` are cleared when the reader leaves the page.
