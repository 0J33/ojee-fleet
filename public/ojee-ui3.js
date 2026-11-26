/* ojee-ui v3 helpers — tiny, dependency-free, ES module.

   Inside the console it is served at /ojee-ui3.js, so a mounted module can
   `import { spark, placeSegs } from '/ojee-ui3.js'`. Standalone, vendor it
   next to ojee-ui3.css.

   Everything returns HTML strings (escape your own data with esc()) except
   placeSegs/bindSeg, which position the sliding indicator of `.seg` controls. */

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** <svg class="i"><use href="#i-name"/></svg>; name with or without the i- prefix. */
export const ic = (name, cls = '') => `<svg class="i${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#${name.startsWith('i-') ? name : `i-${name}`}"/></svg>`;

/** Status → CSS colour. ok | warn | err | anything else (neutral). */
export const col = (s) => (s === 'err' || s === 'critical' ? 'var(--err)' : s === 'warn' ? 'var(--warn)' : s === 'ok' ? 'var(--ok)' : s === 'acc' ? 'var(--acc)' : 'var(--fg-3)');

/** A metric value: 71<span class="u">%</span>, coloured by status when given. */
export const mv = (v, unit = '', status = null, cls = '') =>
  `<div class="mv${cls ? ` ${cls}` : ''}"${status && status !== 'n' ? ` style="--c:${col(status)}"` : ''}>${esc(v)}${unit ? `<span class="u">${esc(unit)}</span>` : ''}</div>`;

/** Label above a value. */
export const metric = (label, v, unit, status) => `<div class="metric"><div class="ml">${esc(label)}</div>${mv(v, unit, status)}</div>`;

export const tag = (t, status) => `<span class="tag${status ? ` ${status === 'critical' ? 'err' : status}` : ''}">${esc(t)}</span>`;

/** Status dot + text. */
export const st = (status, text, live = false) => `<span class="st"><span class="dot${live ? ' live' : ''}" style="--c:${col(status)}"></span><span>${esc(text)}</span></span>`;

/** A thin bar; colour follows the value unless given. */
export const bar = (pct, status) => {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const s = status || (p >= 90 ? 'err' : p >= 80 ? 'warn' : null);
  return `<div class="bar"${s ? ` style="--c:${col(s)}"` : ''}><i style="width:${p}%"></i></div>`;
};

/**
 * Sparkline. points: numbers (nulls are gaps). opts: { status, threshold, min, max, height, label }
 * Draws in a 120×32 box stretched to the container (non-scaling strokes).
 */
export function spark(points, { status = null, threshold = null, min = null, max = null, height = null, label = '' } = {}) {
  const a = (Array.isArray(points) ? points : []).map((v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v)));
  const vals = a.filter((v) => v !== null);
  const style = `--c:${status ? col(status) : 'var(--fg-2)'}${height ? `;height:${height}px` : ''}`;
  const aria = label ? ` role="img" aria-label="${esc(label)}"` : ' aria-hidden="true"';
  if (vals.length < 2) return `<div class="sp empty" style="${style}"${aria}></div>`;
  let lo = Math.min(...vals); let hi = Math.max(...vals);
  if (threshold != null) { lo = Math.min(lo, threshold); hi = Math.max(hi, threshold); }
  const span = hi - lo || Math.abs(hi) || 1;
  lo = min ?? lo - span * 0.15; hi = max ?? hi + span * 0.1;
  if (hi === lo) hi = lo + 1;
  const W = 120; const H = 32;
  const y = (v) => H - ((v - lo) / (hi - lo)) * H;
  const x = (i) => (a.length === 1 ? W : (i / (a.length - 1)) * W);
  let line = ''; let area = ''; let seg = [];
  const flush = () => {
    if (seg.length > 1) {
      const d = `M${seg.map(([i, v]) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join('L')}`;
      line += d;
      area += `${d}L${x(seg[seg.length - 1][0]).toFixed(2)},${H}L${x(seg[0][0]).toFixed(2)},${H}Z`;
    }
    seg = [];
  };
  a.forEach((v, i) => { if (v === null) flush(); else seg.push([i, v]); });
  flush();
  const last = a[a.length - 1];
  const t = threshold != null ? `<line class="t" x1="0" x2="${W}" y1="${y(threshold).toFixed(2)}" y2="${y(threshold).toFixed(2)}"/>` : '';
  const end = last != null ? `<span class="end" style="top:${Math.max(0, Math.min(100, (y(last) / H) * 100)).toFixed(1)}%"></span>` : '';
  return `<div class="sp" style="${style}"${aria}><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${t}<path class="a" d="${area}"/><path class="l" d="${line}"/></svg>${end}</div>`;
}

/* ── sheet ──────────────────────────────────────────────────────────── */
/**
 * A side sheet on desktop (≥1000px), a bottom sheet on phones — for a task
 * that needs more room than a row but should not leave the page (the AC's
 * full controls, a form). Focus-trapped, Escape and the scrim close it, and
 * on a phone it follows the finger down and dismisses on a flick.
 *
 *   const s = openSheet({ title, sub, body: html|Node, actions: [{ label, value, variant }], width: 480, onClose })
 *   s.body       the scrolling body element (render into it)
 *   s.close(v)   closes; `await s.done` resolves with v (or null)
 */
/**
 * While any sheet is open on a phone the page behind must not scroll: iOS
 * hands a scroll that starts on a short sheet (or one already at its top) to
 * whatever is underneath. Counted, so nested sheets release in order.
 */
/**
 * The app frame's height comes from the window, not from CSS viewport units:
 * in an iPhone home-screen web app, 100dvh / inset:0 can come out shorter than
 * the screen, leaving the bottom bar floating above an empty band. innerHeight
 * is what iOS actually gives the page. Kept current on every kind of resize.
 */
function syncAppHeight() {
  // iPhone home-screen app (iOS 18/26, viewport-fit=cover): the page is drawn
  // from the very top of the screen, under the status bar, but innerHeight
  // leaves the status bar out (measured: screen 926, innerHeight 879, safe-area
  // top 47). outerHeight is the real drawn height there. Elsewhere innerHeight.
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent);
  let h = Math.round(window.innerHeight);
  if (standalone && ios && window.outerHeight > h && window.outerHeight <= screen.height + 1) h = Math.round(window.outerHeight);
  if (h > 0) document.documentElement.style.setProperty('--app-h', `${h}px`);
}
if (typeof window !== 'undefined' && !window.__ojeeAppH) {
  window.__ojeeAppH = true;
  syncAppHeight();
  for (const ev of ['resize', 'orientationchange', 'pageshow']) window.addEventListener(ev, () => { syncAppHeight(); setTimeout(syncAppHeight, 250); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncAppHeight(); });
}

let locks = 0;
export function lockScroll(on) {
  locks = Math.max(0, locks + (on ? 1 : -1));
  document.documentElement.classList.toggle('sheet-lock', locks > 0);
}

/**
 * Drag a bottom sheet down to close it (phones only). The grab handle and the
 * header always drag; the body drags only when it is scrolled to the top and
 * the finger moves down, otherwise it scrolls normally. 1:1 tracking,
 * rubber-band upward, a flick or a third of the height closes it.
 * Touch events rather than pointer events: a pointer stream is cancelled the
 * moment the browser decides the gesture is a scroll.
 */
export function sheetGestures(el, { dismiss, handle = '[data-grab], .sheet-h, .ih', body = '.sheet-b, .ibody', wide = 700 } = {}) {
  let y0 = 0; let t0 = 0; let dy = 0; let mode = null; let sc = null;
  const active = () => !matchMedia(`(min-width: ${wide}px)`).matches;
  const apply = (d) => { el.style.transform = `translateY(${d < 0 ? -(Math.abs(d) * 60) / (60 + Math.abs(d)) : d}px)`; };
  el.addEventListener('touchstart', (e) => {
    if (!active() || e.touches.length !== 1) return;
    const t = e.target;
    if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
    y0 = e.touches[0].clientY; t0 = performance.now(); dy = 0; mode = null;
    if (t.closest(handle) && !t.closest('button, a')) mode = 'drag';
    else { sc = t.closest(body); mode = sc ? 'maybe' : 'drag'; }
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!mode) return;
    const d = e.touches[0].clientY - y0;
    if (mode === 'maybe') {
      if (Math.abs(d) < 4) return;
      if (d > 0 && sc.scrollTop <= 0) { mode = 'drag'; y0 = e.touches[0].clientY; t0 = performance.now(); }
      else { mode = null; return; }
    }
    if (mode === 'drag') {
      e.preventDefault();
      dy = e.touches[0].clientY - y0;
      el.style.transition = 'none';
      apply(dy);
    }
  }, { passive: false });
  const end = () => {
    if (mode !== 'drag') { mode = null; return; }
    mode = null;
    const v = dy / Math.max(1, performance.now() - t0);
    el.style.transition = '';
    el.style.transform = '';
    if (dy > el.offsetHeight * 0.3 || v > 0.11) dismiss();
  };
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', end);
}

export function openSheet({ title = '', sub = '', body = '', actions = [], width = 480, onClose = null, flush = false, root = null } = {}) {
  const host = root || document.getElementById('app') || document.body;
  const opener = document.activeElement;
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  const el = document.createElement('section');
  el.className = 'sheet';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.tabIndex = -1;
  el.style.setProperty('--sheet-w', `${width}px`);
  const tid = `sheet-${Math.random().toString(36).slice(2, 8)}`;
  el.setAttribute('aria-labelledby', tid);
  el.innerHTML = `<div class="grab" data-grab><i></i></div>
    <header class="sheet-h"><div style="min-width:0;margin-right:auto"><h2 id="${tid}"></h2>${sub ? '<div class="sub"></div>' : ''}</div><button class="ib" type="button" data-sheet-close aria-label="Close">${ic('x')}</button></header>
    <div class="sheet-b${flush ? ' flush' : ''}"></div>
    ${actions.length ? '<footer class="sheet-f"></footer>' : ''}`;
  el.querySelector('h2').textContent = title;
  if (sub) el.querySelector('.sub').textContent = sub;
  const b = el.querySelector('.sheet-b');
  if (typeof body === 'string') b.innerHTML = body; else if (body instanceof Node) b.append(body);
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  let closed = false;
  const close = (v = null) => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    el.classList.remove('on'); bg.classList.remove('on');
    lockScroll(false);
    setTimeout(() => { el.remove(); bg.remove(); }, 300);
    opener?.focus?.({ preventScroll: true });
    onClose?.(v);
    resolve(v);
  };
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn${a.variant === 'primary' ? ' pri' : a.variant === 'danger' ? ' danger solid' : a.variant === 'ghost' ? ' ghost' : ''}`;
    btn.textContent = a.label;
    btn.addEventListener('click', () => (a.onClick ? a.onClick({ close }) : close(a.value ?? a.label)));
    el.querySelector('.sheet-f').append(btn);
  }
  const focusables = () => [...el.querySelectorAll('button:not(:disabled), [href], input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null);
  const onKey = (e) => {
    if (e.key === 'Escape') {
      if (document.querySelector('.modal-backdrop')) return;
      e.preventDefault(); e.stopImmediatePropagation(); close(null); return;
    }
    if (e.key !== 'Tab') return;
    const f = focusables(); if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  };
  el.addEventListener('click', (e) => { if (e.target.closest('[data-sheet-close]')) close(null); });
  bg.addEventListener('click', () => close(null));
  document.addEventListener('keydown', onKey, true);
  // Drag to dismiss (phones): from the handle/header, or the body at its top.
  sheetGestures(el, { dismiss: () => close(null) });
  bg.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  lockScroll(true);
  host.append(bg, el);
  void el.offsetWidth;
  bg.classList.add('on'); el.classList.add('on');
  (focusables().find((x) => !x.matches('[data-sheet-close]')) || el).focus({ preventScroll: true });
  return { el, body: b, close, done };
}

/* ── segmented controls ─────────────────────────────────────────────── */
const segMemo = new WeakMap();
const segKey = new Map();

/** Position every .seg indicator under root. Call after each render; it
    remembers where each indicator was (by data-seg key) so a re-render slides
    from the old option rather than jumping. */
export function placeSegs(root = document) {
  root.querySelectorAll('.seg').forEach((seg) => {
    const ind = seg.querySelector(':scope > .ind');
    if (!ind) return;
    seg.classList.add('js');
    const on = seg.querySelector(':scope > [aria-pressed="true"], :scope > [aria-current="page"], :scope > [aria-selected="true"]');
    if (!on) { ind.style.opacity = '0'; return; }
    const x = on.offsetLeft; const w = on.offsetWidth;
    const k = seg.dataset.seg;
    const prev = segMemo.get(seg) || (k ? segKey.get(k) : null);
    if (prev && (prev.x !== x || prev.w !== w) && !segMemo.has(seg)) {
      ind.style.transition = 'none';
      ind.style.transform = `translateX(${prev.x}px)`; ind.style.width = `${prev.w}px`;
      void ind.offsetWidth;
      ind.style.transition = '';
    }
    ind.style.opacity = '1';
    ind.style.transform = `translateX(${x}px)`; ind.style.width = `${w}px`;
    const pos = { x, w };
    segMemo.set(seg, pos);
    if (k) segKey.set(k, pos);
  });
}

/** Make a .seg behave as a single choice: moves aria-pressed and the indicator, then calls onChange(value). */
export function bindSeg(seg, onChange) {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !seg.contains(b) || b.getAttribute('aria-pressed') === 'true') return;
    seg.querySelectorAll(':scope > button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    placeSegs(seg.parentElement || document);
    onChange?.(b.dataset.v ?? b.textContent.trim());
  });
}

/** Load icons3.svg into the page once (standalone pages; the console inlines it). */
export async function ensureSprite(url = 'icons3.svg') {
  if (document.getElementById('ui3-sprite')) return;
  const txt = await (await fetch(url)).text();
  const box = document.createElement('div');
  box.innerHTML = txt;
  const svg = box.querySelector('svg');
  if (svg) document.body.prepend(svg);
}

/** Relative time, short: "now", "4m", "2h", "3d". */
export function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60); if (m < 60) return `${m}m`;
  const h = Math.round(m / 60); if (h < 36) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export default { esc, ic, col, mv, metric, tag, st, bar, spark, placeSegs, bindSeg, ensureSprite, ago, openSheet, sheetGestures, lockScroll };
