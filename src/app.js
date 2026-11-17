import { courses } from './courses/index.js';
import { createStore } from './store.js';
import { h } from './ui.js';

let storage = null;
try { storage = window.localStorage; } catch { /* blocked: progress lasts for this visit only */ }
const store = createStore(storage);

const main = document.getElementById('main');
const nav = document.getElementById('nav');
const shell = document.querySelector('.shell');
let cleanups = [];

const lessonIndex = new Map();
for (const course of courses) course.lessons.forEach((lesson, i) => lessonIndex.set(lesson.id, { course, lesson, i }));
const courseById = (id) => courses.find((c) => c.id === id);

/* ---------- routing ---------- */

function resolve() {
  const id = location.hash.replace(/^#\/?/, '');
  if (lessonIndex.has(id)) return { type: 'lesson', ...lessonIndex.get(id) };
  const capstone = courses.find((c) => c.capstoneId === id);
  if (capstone) return { type: 'capstone', course: capstone };
  if (courseById(id)) return { type: 'course', course: courseById(id) };
  return { type: 'catalog' };
}

const routeId = (r) => (r.type === 'lesson' ? r.lesson.id : r.type === 'capstone' ? r.course.capstoneId : r.type === 'course' ? r.course.id : 'overview');

/** The course the reader is "in": the routed one, else the one they last studied. */
function activeCourse(r) {
  if (r.course) return r.course;
  return lessonIndex.get(store.state.last)?.course ?? courses[0];
}

/** Where to send a reader who wants to carry on with a course. */
function resumeTarget(course) {
  const last = course.lessons.find((l) => l.id === store.state.last);
  if (last && !store.isComplete(last)) return last;
  return course.lessons.find((l) => !store.isComplete(l)) ?? null;
}

/* ---------- sidebar ---------- */

function renderNav(r) {
  const current = routeId(r);
  const course = activeCourse(r);
  const done = store.completedCount(course.lessons);
  const total = course.lessons.length;
  let part = null;
  const items = course.lessons.map((l, i) => {
    const heading = l.part && l.part !== part ? `<li class="navpart">${(part = l.part)}</li>` : '';
    const here = current === l.id;
    return `${heading}<li><a href="#${l.id}" class="${here ? 'current' : ''}" ${here ? 'aria-current="page"' : ''}>
      <span class="num">${i + 1}</span><span class="label">${l.title}</span>${store.isComplete(l) ? '<span class="tick" title="Completed">✓<span class="sr"> completed</span></span>' : ''}</a></li>`;
  }).join('');
  const capHere = current === course.capstoneId;
  nav.innerHTML = `
    <a class="brand" href="#overview">Code Studio</a>
    <div class="coursetabs" role="list" aria-label="Courses">
      ${courses.map((c) => `<a role="listitem" href="#${c.id}" class="${c === course ? 'on' : ''}" ${c === course ? 'aria-current="true"' : ''}>${c.title}</a>`).join('')}
    </div>
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}" aria-label="${course.title} lessons completed">
      <div class="progress-bar"><i style="width:${(done / total) * 100}%"></i></div>
      <span>${done} of ${total} lessons complete</span>
    </div>
    <ul class="navlist">
      <li><a href="#${course.id}" class="${current === course.id ? 'current' : ''}"><span class="num">·</span><span class="label">Course overview</span></a></li>
      ${items}
      <li><a href="#${course.capstoneId}" class="${capHere ? 'current' : ''}" ${capHere ? 'aria-current="page"' : ''}><span class="num">★</span><span class="label">Capstone project</span></a></li>
    </ul>`;
  document.getElementById('menu-progress').textContent = `${done}/${total}`;
}

/* ---------- pages ---------- */

const howItWorks = `
  <section>
    <h2>How each lesson works</h2>
    <ul>
      <li><strong>The problem</strong> as it shows up in production, and a real-world example of the same idea.</li>
      <li><strong>The approach</strong>, with the code, SQL or configuration you would write.</li>
      <li><strong>Try it</strong>: a simulation you can break and fix.</li>
      <li><strong>Trade-offs</strong>: what you gain, what it costs, and when to leave it out.</li>
      <li><strong>A short quiz.</strong> A lesson is complete when all its answers are right.</li>
    </ul>
  </section>`;

function renderCatalog() {
  main.innerHTML = `
    <header class="lesson-head">
      <p class="eyebrow">${courses.length} interactive courses · ${courses.reduce((a, c) => a + c.lessons.length, 0)} lessons</p>
      <h1>Code Studio</h1>
      <p class="hook">Backend engineering and system design, taught through one online shop that grows from a single server to a global system.</p>
    </header>
    ${store.persisted ? '' : '<p class="callout">This browser is blocking saved data, so progress will last only until you close this page. Use the progress code below to keep it.</p>'}
    <section class="courses">
      ${courses.map((c, n) => {
        const done = store.completedCount(c.lessons), total = c.lessons.length;
        const next = resumeTarget(c);
        const started = c.lessons.some((l) => store.state.lessons[l.id]);
        return `<article class="coursecard">
          <p class="eyebrow">Course ${n + 1}${c.prerequisite ? ` · after ${courseById(c.prerequisite).title}` : ''}</p>
          <h2><a href="#${c.id}">${c.title}</a></h2>
          <p>${c.tagline}</p>
          <div class="progress"><div class="progress-bar"><i style="width:${(done / total) * 100}%"></i></div><span>${done} of ${total} lessons complete</span></div>
          <p class="controls">
            ${next ? `<a class="btn" href="#${next.id}">${started ? 'Continue' : 'Start'}: ${next.title}</a>` : `<a class="btn" href="#${c.capstoneId}">All done. Open the capstone</a>`}
            <a class="btn ghost" href="#${c.id}">See all ${total} lessons</a>
          </p>
        </article>`;
      }).join('')}
    </section>
    ${howItWorks}
    <section>
      <h2>Your progress</h2>
      <p>Progress for both courses saves automatically in this browser. To continue on another device or browser, copy your progress code there.</p>
      <label class="field wide" for="export-code"><span>Your progress code</span>
        <textarea id="export-code" readonly rows="3">${store.exportCode()}</textarea></label>
      <div class="controls"><button class="btn ghost" id="copy-code">Copy code</button><span class="sim-note" id="copy-status" role="status"></span></div>
      <label class="field wide" for="import-code"><span>Restore from a code</span>
        <textarea id="import-code" rows="3" placeholder="Paste a progress code"></textarea></label>
      <div class="controls"><button class="btn ghost" id="import-btn">Restore progress</button><span class="sim-note" id="import-status" role="status"></span></div>
      <div class="controls" id="reset-row"><button class="btn ghost danger" id="reset-btn">Reset all progress</button></div>
    </section>`;
  const $ = (id) => main.querySelector(id);
  $('#copy-code').onclick = async () => {
    const ta = $('#export-code');
    try { await navigator.clipboard.writeText(ta.value); $('#copy-status').textContent = 'Copied.'; }
    catch { ta.focus(); ta.select(); $('#copy-status').textContent = 'Code selected. Copy it with your keyboard or the share menu.'; }
  };
  $('#import-btn').onclick = () => {
    const value = $('#import-code').value;
    if (!value.trim()) { $('#import-status').textContent = 'Paste a code first.'; return; }
    if (store.importCode(value)) { route(); main.querySelector('#import-status').textContent = 'Progress restored.'; }
    else $('#import-status').textContent = 'That code could not be read. Copy the whole code and try again.';
  };
  $('#reset-btn').onclick = () => {
    $('#reset-row').innerHTML = `<span>Erase all quiz answers and checklist ticks in both courses?</span>
      <button class="btn danger" id="reset-yes">Erase progress</button><button class="btn ghost" id="reset-no">Keep it</button>`;
    $('#reset-yes').onclick = () => { store.reset(); route(); };
    $('#reset-no').onclick = route;
  };
}

function renderCourse(course) {
  const n = courses.indexOf(course);
  const next = resumeTarget(course);
  const started = course.lessons.some((l) => store.state.lessons[l.id]);
  const pre = course.prerequisite && courseById(course.prerequisite);
  let part = null;
  main.innerHTML = `
    <header class="lesson-head">
      <p class="eyebrow">Course ${n + 1} of ${courses.length} · ${course.lessons.length} lessons</p>
      <h1>${course.title}</h1>
      <p class="hook">${course.tagline}</p>
    </header>
    ${course.intro}
    ${pre && store.completedCount(pre.lessons) < pre.lessons.length ? `<p class="callout">This course assumes <a href="#${pre.id}">${pre.title}</a>. You have completed ${store.completedCount(pre.lessons)} of its ${pre.lessons.length} lessons. You can start here anyway; lessons that build on it link back to the right place.</p>` : ''}
    <p class="cta">${next ? `<a class="btn" href="#${next.id}">${started ? 'Continue' : 'Start'}: ${next.title}</a>` : `<a class="btn" href="#${course.capstoneId}">All lessons complete. Open the capstone</a>`}</p>
    <section>
      <h2>The lessons</h2>
      <ol class="toc">
        ${course.lessons.map((l) => {
          const heading = l.part && l.part !== part ? `<li class="tocpart">${(part = l.part)}</li>` : '';
          return `${heading}<li class="${store.isComplete(l) ? 'done' : ''}"><a href="#${l.id}"><b>${l.title}</b><span>${l.hook}</span></a>${store.isComplete(l) ? '<span class="tick">✓<span class="sr"> completed</span></span>' : ''}</li>`;
        }).join('')}
      </ol>
      <p>Then the <a href="#${course.capstoneId}">capstone</a>, which puts every lesson to work at once.</p>
    </section>`;
}

function renderQuiz(lesson) {
  const box = main.querySelector('#quiz');
  const saved = store.lesson(lesson.id).quiz;
  box.innerHTML = lesson.quiz.map((q, qi) => {
    const picked = saved[qi];
    const right = picked === q.answer;
    return `<fieldset class="question">
      <legend>${qi + 1}. ${q.q}</legend>
      <div class="options">
        ${q.options.map((o, oi) => `<button class="option ${picked === oi ? (right ? 'right' : 'wrong') : ''}" data-q="${qi}" data-o="${oi}" aria-pressed="${picked === oi}">${o}</button>`).join('')}
      </div>
      <p class="feedback" role="status">${picked == null ? '' : right ? `<span class="pill ok">Correct</span> ${q.why}` : '<span class="pill bad">Not quite</span> Look again at the approach and the simulation, then try another answer.'}</p>
    </fieldset>`;
  }).join('') + (store.isComplete(lesson) ? `<p class="complete"><span class="pill ok">Lesson complete</span> Saved to your progress.</p>` : '');
}

function renderLesson({ course, lesson, i }) {
  const prev = course.lessons[i - 1], next = course.lessons[i + 1];
  const revisit = lesson.revisits && lessonIndex.get(lesson.revisits.id);
  main.innerHTML = `
    <header class="lesson-head">
      <p class="eyebrow">${course.title} · Lesson ${i + 1} of ${course.lessons.length}${lesson.part ? ` · ${lesson.part}` : ''}</p>
      <h1>${lesson.title}</h1>
      <p class="hook">${lesson.hook}</p>
    </header>
    <aside class="incident"><span class="incident-tag">Incident ${course.id === 'foundations' ? 'INC' : 'SD'}-${String(i + 1).padStart(3, '0')}</span><p>${lesson.incident}</p></aside>
    ${revisit ? `<p class="callout revisit"><b>Revisiting <a href="#${revisit.lesson.id}">${revisit.course.title}, lesson ${revisit.i + 1}: ${revisit.lesson.title}</a>.</b> ${lesson.revisits.note}</p>` : ''}
    ${lesson.buildsOn ? `<p class="callout"><b>Where we are.</b> ${lesson.buildsOn}</p>` : ''}
    <section><h2>The problem</h2>${lesson.problem}</section>
    <section><h2>In the real world</h2>${lesson.realWorld}</section>
    <section><h2>The approach</h2>${lesson.approach}</section>
    <section>
      <h2>Try it: ${lesson.sim.title}</h2>
      <p>${lesson.sim.intro}</p>
      <div class="sim" id="sim"></div>
    </section>
    <section>
      <h2>Trade-offs</h2>
      <div class="tablewrap"><table class="tradeoffs"><thead><tr><th>What you gain</th><th>What it costs</th></tr></thead>
        <tbody>${lesson.tradeoffs.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</tbody></table></div>
      <h3>When to leave it out</h3>
      ${lesson.avoid}
    </section>
    <section>
      <h2>Key points</h2>
      <ul>${lesson.takeaways.map((t) => `<li>${t}</li>`).join('')}</ul>
      <p class="shoplite"><b>Added to ShopLite:</b> ${lesson.shoplite}</p>
    </section>
    <section>
      <h2>Check your understanding</h2>
      <p>Get all three right to complete the lesson. You can change an answer as often as you like.</p>
      <div id="quiz"></div>
    </section>
    <nav class="pager" aria-label="Lesson navigation">
      ${prev ? `<a class="btn ghost" href="#${prev.id}">← ${prev.title}</a>` : `<a class="btn ghost" href="#${course.id}">← Course overview</a>`}
      ${next ? `<a class="btn" href="#${next.id}">Next: ${next.title} →</a>` : `<a class="btn" href="#${course.capstoneId}">Next: Capstone project →</a>`}
    </nav>`;

  const ctx = {
    tried: () => store.markSim(lesson.id),
    every(msec, fn) { const id = setInterval(fn, msec); cleanups.push(() => clearInterval(id)); },
    after(msec, fn) { const id = setTimeout(fn, msec); cleanups.push(() => clearTimeout(id)); },
  };
  try { lesson.sim.mount(main.querySelector('#sim'), ctx); }
  catch (err) { console.error(err); main.querySelector('#sim').append(h('<p class="sim-note">This simulation failed to load. The rest of the lesson still works.</p>')); }

  renderQuiz(lesson);
  main.querySelector('#quiz').addEventListener('click', (e) => {
    const b = e.target.closest('.option'); if (!b) return;
    store.answer(lesson, +b.dataset.q, +b.dataset.o);
    renderQuiz(lesson); renderNav(resolve());
    main.querySelector(`.option[data-q="${b.dataset.q}"][data-o="${b.dataset.o}"]`)?.focus();
  });
  store.setLast(lesson.id);
}

function route() {
  cleanups.forEach((fn) => fn()); cleanups = [];
  const r = resolve();
  if (r.type === 'lesson') renderLesson(r);
  else if (r.type === 'capstone') r.course.renderCapstone(main, { lessons: r.course.lessons, store, course: r.course });
  else if (r.type === 'course') renderCourse(r.course);
  else renderCatalog();
  document.title = (r.type === 'lesson' ? r.lesson.title + ' · ' : r.type === 'capstone' ? 'Capstone · ' : '') + (r.course ? r.course.title : 'Code Studio');
  shell.classList.remove('nav-open');
  document.getElementById('menu-btn').setAttribute('aria-expanded', 'false');
  renderNav(r);
  window.scrollTo(0, 0);
  main.focus({ preventScroll: true });
}

document.getElementById('menu-btn').onclick = (e) => {
  const open = shell.classList.toggle('nav-open');
  e.currentTarget.setAttribute('aria-expanded', open);
};
window.addEventListener('hashchange', route);
route();
