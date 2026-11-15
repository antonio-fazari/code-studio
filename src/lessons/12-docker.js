import { code, pill, stats } from '../ui.js';

// [instruction, seconds when rebuilt, what invalidates it: 'never' | 'deps' | 'src']
const files = {
  naive: {
    label: 'Copy everything, then install',
    layers: [
      ['FROM node:22-slim', 0, 'never'],
      ['WORKDIR /app', 0, 'never'],
      ['COPY . .', 2, 'src'],
      ['RUN npm ci', 95, 'src'],
      ['CMD ["node", "server.js"]', 0, 'src'],
    ],
  },
  ordered: {
    label: 'Copy the manifest, install, then copy the source',
    layers: [
      ['FROM node:22-slim', 0, 'never'],
      ['WORKDIR /app', 0, 'never'],
      ['COPY package.json package-lock.json ./', 1, 'deps'],
      ['RUN npm ci', 95, 'deps'],
      ['COPY . .', 2, 'src'],
      ['CMD ["node", "server.js"]', 0, 'src'],
    ],
  },
};

export default {
  id: 'docker',
  title: 'Docker',
  hook: 'Same app on your laptop and in production',
  incident: 'The release passed every test and crashed on start in production. The server had Node 18. The developer had Node 22.',
  buildsOn: 'ShopLite is now an API, a worker, PostgreSQL, Redis and a queue. Every piece has to be installed at the right version on every laptop, the test server and production.',
  problem: `
    <p>"It works on my machine" is a true statement and a useless one. The code is identical. What differs is everything around it: the runtime version, a system library, an environment variable someone set by hand two years ago.</p>
    <p>ShopLite has also grown to five moving parts. A new teammate needs a day and a wiki page to get them all running locally, and the wiki is out of date.</p>`,
  realWorld: `
    <p>Before the shipping container, cargo was loaded piece by piece, differently on every ship and at every port. The standard steel box changed that: whatever is inside, every crane, truck and ship handles it the same way.</p>
    <p>Software containers did the same for deployment. An image built on a laptop runs unchanged on any server. Almost every cloud platform now takes a container image as its unit of deployment, and Kubernetes exists to run them in large numbers.</p>`,
  approach: `
    <p>A <strong>Dockerfile</strong> is a recipe. Building it produces an <strong>image</strong>: your code plus the exact runtime and libraries it needs, frozen. Running the image gives you a <strong>container</strong>: an isolated process that sees only what is in the image.</p>
    ${code(`
# --- build stage: has compilers and dev dependencies ---
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- runtime stage: only what is needed to run ---
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
USER node
CMD ["node", "dist/server.js"]`, 'dockerfile')}
    <p>Three ideas explain most of what you will meet:</p>
    <ul>
      <li><strong>Layers and caching.</strong> Each instruction creates a layer. Docker reuses a layer if nothing it depends on changed, and rebuilds every layer after the first one that did. So put what changes least first: dependencies before source code.</li>
      <li><strong>Multi-stage builds.</strong> Build in one stage, copy only the results into a clean final stage. The shipped image is smaller and contains no compilers for an attacker to use.</li>
      <li><strong>Configuration from the environment.</strong> The same image runs in test and in production. Only environment variables differ (database URL, keys). Secrets are never baked into the image.</li>
    </ul>
    <p>For local development, <strong>Docker Compose</strong> describes the whole system in one file:</p>
    ${code(`
services:
  api:      { build: ., ports: ["3000:3000"], depends_on: [db, redis] }
  worker:   { build: ., command: node dist/worker.js, depends_on: [db, redis] }
  db:       { image: postgres:17, volumes: ["pgdata:/var/lib/postgresql/data"] }
  redis:    { image: redis:7 }
volumes:
  pgdata:`, 'yaml')}
    <p><code>docker compose up</code> replaces the wiki page.</p>`,
  sim: {
    title: 'Layer caching',
    intro: 'Choose how the Dockerfile is ordered, then change something and rebuild. Watch which layers are reused. A developer does the first kind of rebuild dozens of times a day.',
    mount(root, ctx) {
      root.innerHTML = `
        <div class="controls">
          <label class="field" for="dk-file"><span>Dockerfile order</span>
            <select id="dk-file">${Object.entries(files).map(([k, f]) => `<option value="${k}">${f.label}</option>`).join('')}</select></label>
          <label class="check" for="dk-multi"><input type="checkbox" id="dk-multi"> Multi-stage build</label>
        </div>
        <div class="controls">
          <button class="btn" id="dk-src">Edit a source file and rebuild</button>
          <button class="btn ghost" id="dk-deps">Add a dependency and rebuild</button>
        </div>
        <ol class="layers" id="dk-layers"></ol>
        <div class="stats" id="dk-stats"></div>
        <p class="sim-note" id="dk-note" role="status"></p>`;
      const $ = (id) => root.querySelector(id);
      let last = null;
      const draw = (change) => {
        const file = files[$('#dk-file').value];
        let busted = false, total = 0;
        $('#dk-layers').innerHTML = file.layers.map(([text, secs, dep]) => {
          if (change && (dep === change || (change === 'deps' && dep === 'src'))) busted = true;
          const rebuilt = change && busted;
          if (rebuilt) total += secs;
          return `<li class="${rebuilt ? 'rebuilt' : ''}"><code>${text}</code>${change ? pill(rebuilt ? `rebuilt ${secs} s` : 'cached', rebuilt ? 'warn' : 'ok') : ''}</li>`;
        }).join('');
        stats($('#dk-stats'), [
          ['Rebuild time', change ? total + ' s' : 'n/a', change ? (total > 30 ? 'bad' : 'ok') : ''],
          ['Final image size', $('#dk-multi').checked ? '190 MB' : '1.1 GB', $('#dk-multi').checked ? 'ok' : ''],
        ]);
        $('#dk-note').textContent = !change ? 'Nothing rebuilt yet.'
          : change === 'src' && total > 30 ? 'A one-line code change reinstalled every dependency. "COPY . ." comes before "npm ci", so any changed file invalidates the install layer and everything after it.'
          : change === 'src' ? 'Only the layers after the source copy were rebuilt. The dependency install was reused from cache.'
          : 'The manifest changed, so the install must run again in either layout. That is correct: this is the rare case.';
      };
      $('#dk-src').onclick = () => { ctx.tried(); last = 'src'; draw(last); };
      $('#dk-deps').onclick = () => { ctx.tried(); last = 'deps'; draw(last); };
      $('#dk-file').onchange = () => { ctx.tried(); last = null; draw(null); };
      $('#dk-multi').onchange = () => { ctx.tried(); draw(last); };
      draw(null);
    },
  },
  tradeoffs: [
    ['The image you tested is the image that runs in production, byte for byte.', 'A new layer of tooling to learn: images, registries, networking between containers, volumes.'],
    ['A new developer runs one command and has the whole stack.', 'On macOS and Windows, Docker runs inside a virtual machine. File access is slower and it uses a lot of memory.'],
    ['Deployments and rollbacks become "run this image tag", and scaling is "run more copies".', 'Containers are disposable. Anything written inside one is lost on restart unless it is on a volume, which makes databases in containers a careful decision in production.'],
    ['Isolation between apps on the same host, at far less cost than virtual machines.', 'Images need maintenance: base images have vulnerabilities and must be rebuilt and scanned regularly.'],
  ],
  avoid: `<p>A static site or a single function on a managed platform does not need a Dockerfile. For production databases, most teams use a managed service and keep containers for stateless apps, while still running Postgres in a container locally. Do not start with Kubernetes: one container on a managed runtime is enough for a long time.</p>`,
  shoplite: 'A multi-stage Dockerfile for the API and worker, and a Compose file that starts the API, worker, PostgreSQL and Redis together.',
  takeaways: [
    'An image freezes the code together with its runtime and libraries, so every environment runs the same thing.',
    'Order the Dockerfile from least to most frequently changed, so the cache does the work.',
    'One image, many environments. Configuration and secrets come from outside.',
  ],
  quiz: [
    { q: 'Why copy package.json and install dependencies before copying the rest of the source?',
      options: ['Docker requires it', 'So a code change does not invalidate the cached dependency layer', 'It makes the final image smaller'], answer: 1,
      why: 'Layers are rebuilt from the first changed one onward. Dependencies change rarely, so their layer should come before the source copy.' },
    { q: 'What is the main benefit of a multi-stage build?',
      options: ['Faster container start', 'The final image holds only runtime files, so it is smaller and has less to attack', 'It lets one container run several processes'], answer: 1,
      why: 'Compilers, dev dependencies and source stay in the build stage and are not shipped.' },
    { q: 'Where should the production database password come from?',
      options: ['An ENV line in the Dockerfile', 'An environment variable or secret injected when the container starts', 'A file committed next to the Dockerfile'], answer: 1,
      why: 'Anything in the image can be read by anyone who can pull it. Injecting at run time also lets one image serve every environment.' },
  ],
};
