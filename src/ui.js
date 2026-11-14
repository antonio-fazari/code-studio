// Small DOM helpers shared by the app shell and the lesson simulations.

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** A code block. Comment lines (--, #, //) are dimmed. */
export function code(src, lang = '') {
  const body = esc(src.replace(/^\n+|\s+$/g, '')).replace(/(^|[ \t])((?:--|#|\/\/) .*)$/gm, '$1<span class="cm">$2</span>');
  return `<div class="codewrap"><pre class="code"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${body}</code></pre></div>`;
}

export const fmt = (n) => Math.round(n).toLocaleString('en-US');
export const ms = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + ' s' : (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ms');

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export const slider = (id, label, min, max, value, step = 1) =>
  `<label class="field" for="${id}"><span>${label} <output id="${id}-out"></output></span>
   <input type="range" id="${id}" min="${min}" max="${max}" value="${value}" step="${step}"></label>`;

/** Wire a range input to its <output>; calls onChange with the numeric value (also once at start). */
export function bindSlider(root, id, format, onChange) {
  const input = root.querySelector('#' + id), out = root.querySelector('#' + id + '-out');
  const run = (user) => { out.textContent = format(+input.value); onChange?.(+input.value, user); };
  input.addEventListener('input', () => run(true));
  run(false);
  return () => +input.value;
}

export function stats(el, items) {
  el.innerHTML = items.map(([label, value, cls = '']) =>
    `<div class="stat ${cls}"><span class="stat-label">${label}</span><span class="stat-value">${value}</span></div>`).join('');
}

/** Add a line to the top of a log list, keeping it short. */
export function log(el, html, cls = '') {
  el.prepend(h(`<li class="${cls}">${html}</li>`));
  while (el.children.length > 40) el.lastElementChild.remove();
}

export const pill = (text, cls) => `<span class="pill ${cls}">${text}</span>`;
