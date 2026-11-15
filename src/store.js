// Progress store. Saves to the given storage (localStorage in the browser) on every change.

const KEY = 'backend-foundations-progress-v1';
const blank = () => ({ v: 1, lessons: {}, tasks: {}, last: null });

function valid(s) {
  return s && s.v === 1 && typeof s.lessons === 'object' && s.lessons !== null && typeof s.tasks === 'object' && s.tasks !== null;
}

export function createStore(storage) {
  let state = blank();
  try {
    const saved = JSON.parse(storage?.getItem(KEY) ?? 'null');
    if (valid(saved)) state = saved;
  } catch { /* unreadable or blocked storage: start fresh */ }

  const subs = [];
  let persisted = true;
  function save() {
    try { storage?.setItem(KEY, JSON.stringify(state)); persisted = !!storage; } catch { persisted = false; }
    subs.forEach((fn) => fn(state));
  }
  const entry = (id) => (state.lessons[id] ??= { quiz: {}, sim: false, completedAt: null });

  const api = {
    get state() { return state; },
    get persisted() { return persisted; },
    subscribe(fn) { subs.push(fn); },
    lesson: (id) => state.lessons[id] ?? { quiz: {}, sim: false, completedAt: null },
    isComplete: (lesson) => lesson.quiz.every((q, i) => state.lessons[lesson.id]?.quiz?.[i] === q.answer),
    completedCount: (lessons) => lessons.filter(api.isComplete).length,
    answer(lesson, index, choice) {
      const e = entry(lesson.id);
      e.quiz[index] = choice;
      if (!e.completedAt && api.isComplete(lesson)) e.completedAt = new Date().toISOString();
      save();
    },
    markSim(id) { if (!entry(id).sim) { entry(id).sim = true; save(); } },
    setLast(id) { if (state.last !== id) { state.last = id; save(); } },
    toggleTask(id) { state.tasks[id] = !state.tasks[id]; save(); },
    exportCode() { return btoa(unescape(encodeURIComponent(JSON.stringify(state)))); },
    importCode(code) {
      let parsed;
      try { parsed = JSON.parse(decodeURIComponent(escape(atob(String(code).trim())))); } catch { return false; }
      if (!valid(parsed)) return false;
      state = parsed; save(); return true;
    },
    reset() { state = blank(); save(); },
  };
  return api;
}
