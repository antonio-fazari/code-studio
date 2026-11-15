import { lessons } from './lessons/index.js';
import { createStore } from './store.js';
import { renderCapstone } from './capstone.js';
import { h } from './ui.js';

let storage = null;
try { storage = window.localStorage; } catch { /* blocked: progress lasts for this visit only */ }
const store = createStore(storage);

const main = document.getElementById('main');
const nav = document.getElementById('nav');
const shell = document.querySelector('.shell');
let cleanups = [];

/* ---------- sidebar ---------- */

function renderNav() {
  const route = currentRoute();
  const done = store.completedCount(lessons);
  const item = (href, label, state, num) =>
    `<li><a href="#${href}" class="${route === href ? 'current' : ''}" ${route === href ? 'aria-current="page"' : ''}>
      <span class="num">${num}</span><span class="label">${label}</span>${state ? `<span class="tick" title="Completed">✓<span class="sr"> completed</span></span>` : ''}</a></li>`;
  nav.innerHTML = `
    <a class="brand" href="#overview">Backend Foundations</a>
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${lessons.length}" aria-valuenow="${done}" aria-label="Lessons completed">
      <div class="progress-bar"><i style="width:${(done / lessons.length) * 100}%"></i></div>
      <span>${done} of ${lessons.length} lessons complete</span>
    </div>
    <ul class="navlist">
      ${item('overview', 'Course overview', false, '·')}
      ${lessons.map((l, i) => item(l.id, l.title, store.isComplete(l), i + 1)).join('')}
      ${item('capstone', 'Capstone project', false, '★')}
    </ul>`;
  document.getElementById('menu-progress').textContent = `${done}/${lessons.length}`;
}

/* ---------- pages ---------- */

function renderOverview() {
  const done = store.completedCount(lessons);
  const next = lessons.find((l) => !store.isComplete(l));
  const last = lessons.find((l) => l.id === store.state.last);
  const resume = done === lessons.length ? null : (last && !store.isComplete(last) ? last : next);
  main.innerHTML = `
    <header class="lesson-head">
      <p class="eyebrow">An interactive course in 12 lessons</p>
      <h1>Backend Foundations</h1>
      <p class="hook">Twelve ideas every backend engineer needs, learned by growing one API from a single slow query to a production system.</p>
    </header>
    <p>You will follow <strong>ShopLite</strong>, a small online shop. Each lesson opens with something going wrong in production, explains the concept that fixes it, and lets you try it in a simulation. The fix always exposes the next problem, so the lessons build on each other. Take them in order.</p>
    <p class="cta">
      ${resume ? `<a class="btn" href="#${resume.id}">${done || store.state.last ? 'Continue' : 'Start'}: ${resume.title}</a>` : `<a class="btn" href="#capstone">All lessons complete. Open the capstone</a>`}
    </p>
    ${store.persisted ? '' : '<p class="callout">This browser is blocking saved data, so progress will last only until you close this page. Use the progress code below to keep it.</p>'}

    <section>
      <h2>The lessons</h2>
      <ol class="toc">
        ${lessons.map((l) => `<li class="${store.isComplete(l) ? 'done' : ''}"><a href="#${l.id}"><b>${l.title}</b><span>${l.hook}</span></a>${store.isComplete(l) ? '<span class="tick">✓<span class="sr"> completed</span></span>' : ''}</li>`).join('')}
      </ol>
      <p>Then the <a href="#capstone">capstone</a>: build one API that uses all twelve.</p>
    </section>

    <section>
      <h2>How each lesson works</h2>
      <ul>
        <li><strong>The problem</strong> as it shows up in production, and a real-world example of the same idea.</li>
        <li><strong>The approach</strong>, with the code or SQL you would write.</li>
        <li><strong>Try it</strong>: a simulation you can break and fix.</li>
        <li><strong>Trade-offs</strong>: what you gain, what it costs, and when to leave it out.</li>
        <li><strong>A short quiz.</strong> A lesson is complete when all its answers are right.</li>
      </ul>
    </section>

    <section>
      <h2>Your progress</h2>
      <p>Progress saves automatically in this browser. To continue on another device or browser, copy your progress code there.</p>
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
    if (store.importCode(value)) { renderNav(); renderOverview(); main.querySelector('#import-status').textContent = 'Progress restored.'; }
    else $('#import-status').textContent = 'That code could not be read. Copy the whole code and try again.';
  };
  $('#reset-btn').onclick = () => {
    $('#reset-row').innerHTML = `<span>Erase all quiz answers and checklist ticks?</span>
      <button class="btn danger" id="reset-yes">Erase progress</button><button class="btn ghost" id="reset-no">Keep it</button>`;
    $('#reset-yes').onclick = () => { store.reset(); renderNav(); renderOverview(); };
    $('#reset-no').onclick = renderOverview;
  };
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

function renderLesson(lesson) {
  const i = lessons.indexOf(lesson);
  const prev = lessons[i - 1], next = lessons[i + 1];
  main.innerHTML = `
    <header class="lesson-head">
      <p class="eyebrow">Lesson ${i + 1} of ${lessons.length}</p>
      <h1>${lesson.title}</h1>
      <p class="hook">${lesson.hook}</p>
    </header>
    <aside class="incident"><span class="incident-tag">Incident INC-${String(i + 1).padStart(3, '0')}</span><p>${lesson.incident}</p></aside>
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
      ${prev ? `<a class="btn ghost" href="#${prev.id}">← ${prev.title}</a>` : `<a class="btn ghost" href="#overview">← Overview</a>`}
      ${next ? `<a class="btn" href="#${next.id}">Next: ${next.title} →</a>` : `<a class="btn" href="#capstone">Next: Capstone project →</a>`}
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
    renderQuiz(lesson); renderNav();
    main.querySelector(`.option[data-q="${b.dataset.q}"][data-o="${b.dataset.o}"]`)?.focus();
  });
  store.setLast(lesson.id);
}

/* ---------- routing ---------- */

function currentRoute() {
  const id = location.hash.replace(/^#\/?/, '');
  return id === 'capstone' || lessons.some((l) => l.id === id) ? id : 'overview';
}

function route() {
  cleanups.forEach((fn) => fn()); cleanups = [];
  const id = currentRoute();
  const lesson = lessons.find((l) => l.id === id);
  if (lesson) renderLesson(lesson);
  else if (id === 'capstone') renderCapstone(main, { lessons, store });
  else renderOverview();
  document.title = (lesson ? lesson.title + ' · ' : id === 'capstone' ? 'Capstone · ' : '') + 'Backend Foundations';
  shell.classList.remove('nav-open');
  document.getElementById('menu-btn').setAttribute('aria-expanded', 'false');
  renderNav();
  window.scrollTo(0, 0);
  main.focus({ preventScroll: true });
}

document.getElementById('menu-btn').onclick = (e) => {
  const open = shell.classList.toggle('nav-open');
  e.currentTarget.setAttribute('aria-expanded', open);
};
window.addEventListener('hashchange', route);
route();
