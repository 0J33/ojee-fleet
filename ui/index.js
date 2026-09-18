/* ============================================================
   ojee-fleet — module UI.

   Four views over one payload. The server already decided what is
   wrong and normalized three different APIs into one shape, so
   nothing here parses a host-specific field — which is the whole
   point of the split: adding a fourth machine is an adapter, not
   a change to this file.

   Live updates come over SSE with a polling fallback, because an
   SSE stream through two proxies is one misconfigured buffer away
   from silently delivering nothing, and a monitoring page that
   silently stops updating is worse than one that never claimed to.
   ============================================================ */

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
};

const fmtBytes = (n) => {
  if (!Number.isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};
const fmtRate = (n) => (Number.isFinite(n) ? `${fmtBytes(n)}/s` : '—');
const fmtPct = (n) => (Number.isFinite(n) ? `${Math.round(n)}%` : '—');
const fmtTemp = (n) => (Number.isFinite(n) ? `${Math.round(n)}°C` : '—');
const fmtUptime = (s) => {
  if (!Number.isFinite(s) || s <= 0) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
};
const ago = (t) => {
  if (!Number.isFinite(t)) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

/* ── state ───────────────────────────────────────────────────────────── */

let ctx = null;
let root = null;
let stream = null;
let pollTimer = null;

const state = {
  view: 'overview',
  data: null,
  error: null,
  selected: null,        // host id, for the Hosts view
  detail: null,          // full host + history
  logUnit: null,
  logText: '',
  logBusy: false,
  procs: null,
  procsFor: null,
  procQuery: '',
  busyAction: null,
  filter: '',
  live: false,
};

const api = async (path, opts = {}) => ctx.api(path.replace(/^\/api/, ''), opts);

/* ── small pieces ────────────────────────────────────────────────────── */

/* The design system's own dot, not one of ours. It already has ok/warn/err
   and the pulse on err; a second implementation next to it is how two things
   that mean the same thing end up looking different. */
const dot = (status) => el('span', {
  class: `dot dot--${status === 'err' ? 'err' : status === 'warn' ? 'warn' : 'ok'}`,
  title: status,
});

/**
 * A labelled meter.
 *
 * The fill is `.bar .fill`, which is what the design system styles — this
 * shipped as `.bar-fill`, matched nothing, and every bar on the page rendered
 * as an empty track. Severity is a modifier ON THE FILL for the same reason.
 */
const bar = (value, label, opts = {}) => {
  const p = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
  const tone = p == null ? '' : p >= (opts.crit ?? 90) ? ' fill--err' : p >= (opts.warn ?? 75) ? ' fill--warn' : '';
  return el('div', { class: 'fl-metric' },
    el('div', { class: 'fl-metric-top' },
      el('span', { class: 'label' }, label),
      el('span', { class: 'fl-metric-val tnum' }, opts.text || fmtPct(p))),
    el('div', { class: 'bar' },
      el('span', { class: `fill${tone}`, style: `width:${p == null ? 0 : p}%` })));
};

/**
 * A sparkline as an inline SVG polyline. Nulls break the line rather than
 * being drawn as zero — a gap is what a missing sample actually is, and a
 * dive to the floor is what a reader would otherwise see.
 */
const spark = (samples, key, { height = 28, max = 100, unit = '%' } = {}) => {
  const pts = samples.map((s, i) => [i, s[key]]);
  const w = Math.max(1, samples.length - 1);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'fl-spark');
  svg.setAttribute('viewBox', `0 0 ${w} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      line.setAttribute('points', run.map(([x, y]) => `${x},${(1 - Math.min(y, max) / max) * height}`).join(' '));
      svg.append(line);
    }
    run = [];
  };
  for (const [x, y] of pts) {
    if (Number.isFinite(y)) run.push([x, y]); else flush();
  }
  flush();
  if (!svg.childNodes.length) return el('div', { class: 'fl-spark fl-spark--empty' });

  // A graph you cannot interrogate is a shape, not a reading. The pointer
  // picks the nearest sample and says what it was and when — no library,
  // because it is one index lookup.
  const wrap = el('div', { class: 'fl-sparkwrap' });
  const cursor = el('span', { class: 'fl-spark-cursor' });
  const tip = el('span', { class: 'fl-spark-tip' });
  wrap.append(svg, cursor, tip);

  const show = (ev) => {
    const box = wrap.getBoundingClientRect();
    if (!box.width || samples.length < 2) return;
    const ratio = Math.max(0, Math.min(1, (ev.clientX - box.left) / box.width));
    const i = Math.round(ratio * (samples.length - 1));
    const sample = samples[i];
    const v = sample?.[key];
    cursor.style.left = `${(i / (samples.length - 1)) * 100}%`;
    const when = Number.isFinite(sample?.t)
      ? new Date(sample.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '';
    tip.textContent = `${Number.isFinite(v) ? `${Math.round(v)}${unit}` : 'no sample'}${when ? ` · ${when}` : ''}`;
    // Keep the label inside the box at both ends rather than letting it hang
    // off the panel.
    tip.style.left = `${Math.max(0, Math.min(100, (i / (samples.length - 1)) * 100))}%`;
    tip.dataset.side = ratio > 0.66 ? 'left' : ratio < 0.33 ? 'right' : 'centre';
    wrap.classList.add('is-hot');
  };
  wrap.addEventListener('pointermove', show);
  wrap.addEventListener('pointerdown', show);
  wrap.addEventListener('pointerleave', () => wrap.classList.remove('is-hot'));
  return wrap;
};

const alertRow = (a, onOpen) => el('button', {
  class: `fl-row fl-alert is-${a.severity}`,
  type: 'button',
  onclick: () => onOpen?.(a),
},
el('span', { class: `fl-dot is-${a.severity}` }),
el('span', { class: 'fl-alert-text' },
  a.hostName && !a.text.includes(a.hostName) ? `${a.hostName}: ${a.text}` : a.text),
a.hint ? el('span', { class: 'fl-alert-hint meta' }, a.hint) : null);

/* ── views ───────────────────────────────────────────────────────────── */

function hostCard(h) {
  const memPct = h.mem?.pct ?? null;
  const worstDisk = (h.disks || [])
    .filter((d) => Number.isFinite(d.pct))
    .sort((a, b) => b.pct - a.pct)[0] || null;

  return el('article', { class: `panel fl-card ${h.online ? '' : 'is-off'}` },
    el('header', { class: 'fl-card-head' },
      dot(h.status || (h.online ? 'ok' : 'err')),
      el('button', {
        class: 'fl-card-name',
        type: 'button',
        onclick: () => { state.selected = h.id; go('hosts'); },
      }, h.name),
      el('span', { class: 'fl-card-role meta' }, h.role || h.kind)),

    h.online
      ? el('div', { class: 'fl-card-body' },
        bar(h.cpu?.pct, 'CPU', { text: `${fmtPct(h.cpu?.pct)}${Number.isFinite(h.cpu?.tempC) ? ` · ${fmtTemp(h.cpu.tempC)}` : ''}` }),
        h.mem ? bar(memPct, 'Memory', { text: `${fmtPct(memPct)} · ${fmtBytes(h.mem.used)}` })
          : el('div', { class: 'fl-metric fl-metric--absent' },
            el('span', { class: 'label' }, 'Memory'),
            el('span', { class: 'meta' }, 'not reported')),
        worstDisk ? bar(worstDisk.pct, `Disk ${worstDisk.label}`,
          { text: `${fmtPct(worstDisk.pct)} · ${fmtBytes(worstDisk.total - worstDisk.used)} free` }) : null,
        h.gpu ? bar(h.gpu.pct, 'GPU', { text: `${fmtPct(h.gpu.pct)}${Number.isFinite(h.gpu.tempC) ? ` · ${fmtTemp(h.gpu.tempC)}` : ''}` }) : null)
      : el('div', { class: 'fl-card-off' },
        el('strong', {}, 'Unreachable'),
        el('span', { class: 'meta' }, h.error || ''),
        el('span', { class: 'meta' }, `last seen ${ago(h.lastSeen)}`)),

    el('footer', { class: 'fl-card-foot' },
      el('span', { class: 'meta' },
        h.online && Number.isFinite(h.uptime) ? `up ${fmtUptime(h.uptime)}`
          : h.online ? `sampled ${ago(h.at)}` : `last seen ${ago(h.lastSeen)}`),
      (h.alerts || []).length
        ? el('span', { class: `badge ${h.status === 'err' ? 'badge--err' : 'badge--warn'}` },
          `${h.alerts.length} alert${h.alerts.length > 1 ? 's' : ''}`)
        : el('span', { class: 'meta' }, 'nothing to report')));
}

function viewOverview(d) {
  const wrap = el('section', { class: 'stack-lg' });

  wrap.append(el('div', { class: 'fl-verdict' },
    dot(d.status),
    el('strong', {},
      d.online === d.total
        ? `All ${d.total} machines reachable`
        : `${d.total - d.online} of ${d.total} unreachable`),
    el('span', { class: 'meta' },
      d.alerts.length ? `${d.alerts.length} thing${d.alerts.length > 1 ? 's' : ''} to look at` : 'nothing to look at'),
    el('span', { class: 'fl-live meta' }, state.live ? 'live' : 'polling')));

  wrap.append(el('div', { class: 'fl-grid' }, d.hosts.map(hostCard)));

  if (d.alerts.length) {
    wrap.append(el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'What is wrong'),
      el('div', { class: 'fl-list' },
        d.alerts.map((a) => alertRow(a, () => { state.selected = a.host; go('hosts'); })))));
  }
  return wrap;
}

function viewHosts(d) {
  const current = d.hosts.find((h) => h.id === state.selected) || d.hosts[0];
  if (!current) return el('div', { class: 'empty' }, 'No hosts configured.');
  if (state.selected !== current.id) state.selected = current.id;

  const detail = state.detail?.id === current.id ? state.detail : null;
  const samples = detail?.history || [];

  const picker = el('div', { class: 'fl-picker' },
    d.hosts.map((h) => el('button', {
      class: `fl-pick ${h.id === current.id ? 'is-on' : ''}`,
      type: 'button',
      onclick: () => {
        state.selected = h.id; state.detail = null; state.logUnit = null;
        state.procs = null; state.procsFor = null; state.procQuery = '';
        loadDetail(); render();
      },
    }, dot(h.status || (h.online ? 'ok' : 'err')), h.name)));

  const facts = el('dl', { class: 'fl-facts' },
    [['Role', current.role || '—'],
      ['OS', current.os || '—'],
      ['Uptime', fmtUptime(current.uptime)],
      ['CPU', current.cpu?.model || '—'],
      ['Sampled', ago(current.at)],
      ['Source', current.kind]]
      .map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', { title: String(v) }, v))));

  const charts = el('section', { class: 'panel stack' },
    el('h3', { class: 'h3' }, 'Last 15 minutes'),
    el('div', { class: 'fl-charts' },
      [['cpu', 'CPU', current.cpu?.pct], ['mem', 'Memory', current.mem?.pct],
        ['gpu', 'GPU', current.gpu?.pct], ['temp', 'CPU temp', current.cpu?.tempC]]
        .map(([key, label, now]) => el('div', { class: 'fl-chart' },
          el('div', { class: 'fl-metric-top' },
            el('span', { class: 'label' }, label),
            el('span', { class: 'fl-metric-val tnum' },
              key === 'temp' ? fmtTemp(now) : fmtPct(now))),
          spark(samples, key, { max: 100, unit: key === 'temp' ? '°C' : '%' })))));

  const disks = el('section', { class: 'panel stack' },
    el('h3', { class: 'h3' }, (current.disks || []).length ? 'Filesystems' : 'Drives'),
    (current.disks || []).length
      ? el('div', { class: 'stack' }, current.disks.map((dk) => bar(dk.pct,
        `${dk.label}${dk.device ? ` · ${dk.device}` : ''}${dk.remote ? ' · network' : ''}`,
        { text: `${fmtBytes(dk.used)} of ${fmtBytes(dk.total)}` })))
      // Some hosts report the physical drives and no usage at all. Say what
      // they are rather than drawing usage bars that could only sit at zero.
      : (current.drives || []).length
        ? el('div', { class: 'fl-list' }, current.drives.map((dv) => el('div', { class: 'fl-row fl-drive' },
          el('span', { class: 'fl-drive-dev' }, dv.device),
          el('span', { class: 'fl-drive-model meta', title: dv.model || '' }, dv.model || 'unknown'),
          el('span', { class: 'fl-drive-size tnum' }, fmtBytes(dv.size)),
          Number.isFinite(dv.tempC) ? el('span', { class: 'meta tnum' }, fmtTemp(dv.tempC)) : null)))
        : el('p', { class: 'meta' }, 'This host does not report storage.'));

  const gpu = current.gpu ? el('section', { class: 'panel stack' },
    el('h3', { class: 'h3' }, 'GPU'),
    el('p', { class: 'meta' }, current.gpu.model || 'unknown'),
    bar(current.gpu.pct, 'Utilisation'),
    Number.isFinite(current.gpu.vramTotal)
      ? bar((current.gpu.vramUsed / current.gpu.vramTotal) * 100, 'VRAM',
        { text: `${fmtBytes(current.gpu.vramUsed)} of ${fmtBytes(current.gpu.vramTotal)}` })
      : null,
    el('dl', { class: 'fl-facts' },
      [['Temp', fmtTemp(current.gpu.tempC)],
        ['Power', Number.isFinite(current.gpu.watts) ? `${Math.round(current.gpu.watts)} W` : '—'],
        ['Clock', Number.isFinite(current.gpu.clockMhz) ? `${current.gpu.clockMhz} MHz` : '—']]
        .map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v))))) : null;

  // Hardware we know about but cannot measure. Same principle as drives: say
  // what is there rather than drawing a gauge that can only read zero.
  const gpuList = (!current.gpu && (current.gpus || []).length)
    ? el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Graphics'),
      el('div', { class: 'fl-list' }, current.gpus.map((g) => el('div', { class: 'fl-row fl-drive' },
        el('span', { class: 'fl-drive-dev' }, g.inUse ? 'in use' : 'idle'),
        el('span', { class: 'fl-drive-model meta', title: g.model }, g.model),
        el('span', { class: 'meta' }, g.driver || ''),
        Number.isFinite(g.clockMhz) ? el('span', { class: 'meta tnum' }, `${g.clockMhz} MHz`) : null))))
    : null;

  const extras = [];
  if (current.battery) {
    extras.push(el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Battery'),
      bar(current.battery.pct, current.battery.state || 'charge',
        { warn: 100, crit: 100, text: fmtPct(current.battery.pct) }),
      Number.isFinite(current.battery.health)
        ? el('p', { class: 'meta' }, `health ${fmtPct(current.battery.health)}`) : null));
  }
  if (current.net) {
    extras.push(el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Network'),
      el('dl', { class: 'fl-facts' },
        [['Down', fmtRate(current.net.rx)], ['Up', fmtRate(current.net.tx)]]
          .map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', { class: 'tnum' }, v))))));
  }

  const logs = current.capabilities?.logs ? viewLogs(current) : null;
  const procs = current.capabilities?.processes ? viewProcesses(current) : null;

  return el('section', { class: 'stack-lg' },
    picker,
    !current.online
      ? el('div', { class: 'alert alert--err' },
        `${current.name} is unreachable — ${current.error || 'no reason given'}. `
        + `Last seen ${ago(current.lastSeen)}.`)
      : null,
    el('section', { class: 'panel stack' }, el('h3', { class: 'h3' }, current.name), facts),
    charts,
    el('div', { class: 'fl-two' }, disks, gpu || gpuList || extras.shift() || el('div')),
    extras.length ? el('div', { class: 'fl-two' }, extras) : null,
    servicesPanel([current]),
    procs,
    logs);
}

function viewLogs(host) {
  const units = (host.services || []).map((s) => s.id).slice(0, 12);
  return el('section', { class: 'panel stack' },
    el('h3', { class: 'h3' }, 'Logs'),
    el('div', { class: 'fl-chips' },
      units.map((u) => el('button', {
        class: `btn btn--ghost btn--sm ${state.logUnit === u ? 'fl-on' : ''}`,
        type: 'button',
        onclick: () => loadLog(host.id, u),
      }, u))),
    state.logBusy
      ? el('div', { class: 'fl-log fl-log--loading' },
        el('span', { class: 'meta' }, `Reading ${state.logUnit}…`),
        [92, 74, 86, 61, 80].map((w) => el('span', { class: 'skeleton fl-log-skel', style: `width:${w}%` })))
      : el('pre', { class: 'fl-log' },
        state.logText || 'Pick a unit to read its journal.'));
}

function viewProcesses(host) {
  if (state.procsFor !== host.id && state.procs === null) loadProcs(host.id);
  const rows = state.procsFor === host.id ? (state.procs || []) : [];
  return el('section', { class: 'panel stack' },
    el('div', { class: 'fl-panel-head' },
      el('h3', { class: 'h3' }, 'Processes'),
      el('input', {
        class: 'input fl-proc-search',
        type: 'search',
        placeholder: 'Filter',
        value: state.procQuery,
        oninput: (e) => {
          state.procQuery = e.target.value;
          clearTimeout(viewProcesses.t);
          // Typing should not fire a request per keystroke at a machine that
          // has to walk /proc to answer it.
          viewProcesses.t = setTimeout(() => loadProcs(host.id), 250);
        },
      })),
    rows.length
      ? el('div', { class: 'fl-list fl-procs' },
        el('div', { class: 'fl-row fl-proc fl-proc--head' },
          el('span', {}, 'Process'), el('span', {}, 'User'),
          el('span', { class: 'tnum' }, 'CPU'), el('span', { class: 'tnum' }, 'Memory')),
        rows.map((pr) => el('div', { class: 'fl-row fl-proc' },
          el('span', { class: 'fl-proc-name', title: pr.cmdline || pr.name }, pr.name),
          el('span', { class: 'meta' }, pr.user || '—'),
          el('span', { class: 'tnum' }, `${(pr.cpuPct ?? 0).toFixed(1)}%`),
          el('span', { class: 'tnum' }, fmtBytes((pr.memKb || 0) * 1024)))))
      : el('p', { class: 'meta' }, state.procsFor === host.id ? 'Nothing matches that.' : 'Reading…'));
}

function servicesPanel(hosts) {
  const q = state.filter.trim().toLowerCase();
  const rows = hosts.flatMap((h) => (h.services || [])
    .filter((s) => !q || s.name.toLowerCase().includes(q) || h.name.toLowerCase().includes(q))
    .map((s) => ({ ...s, host: h })));

  if (!rows.length) {
    return el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Services'),
      el('p', { class: 'meta' }, q ? 'Nothing matches that.' : 'No services reported.'));
  }

  return el('section', { class: 'panel stack' },
    el('div', { class: 'fl-panel-head' },
      el('h3', { class: 'h3' }, 'Services'),
      el('span', { class: 'meta' },
        `${rows.filter((r) => r.ok).length} of ${rows.length} running`)),
    el('div', { class: 'fl-list' }, rows.map((s) => el('div', {
      class: `fl-row fl-svc ${s.ok ? '' : 'is-bad'}`,
    },
    dot(s.ok ? 'ok' : 'err'),
    el('span', { class: 'fl-svc-name' }, s.name),
    el('span', { class: 'fl-svc-host meta' }, s.host.name),
    el('span', { class: 'fl-svc-detail meta' },
      s.detail || (s.ok ? 'running' : 'stopped')),
    s.host.capabilities?.actions
      ? el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        disabled: state.busyAction === `${s.host.id}:${s.id}`,
        onclick: () => runAction(s.host.id, `restart-${s.id}`, s.name),
      }, state.busyAction === `${s.host.id}:${s.id}` ? '…' : 'Restart')
      : null))));
}

function viewServices(d) {
  return el('section', { class: 'stack-lg' },
    el('div', { class: 'fl-toolbar' },
      el('input', {
        class: 'input',
        type: 'search',
        placeholder: 'Filter services',
        value: state.filter,
        oninput: (e) => { state.filter = e.target.value; render(); },
      })),
    servicesPanel(d.hosts));
}

function viewAlerts(d) {
  if (!d.alerts.length) {
    return el('div', { class: 'empty' },
      el('p', {}, el('strong', {}, 'Nothing is wrong.')),
      el('p', { class: 'meta' }, `${d.total} machines, all reporting normally.`));
  }
  const byHost = new Map();
  for (const a of d.alerts) {
    if (!byHost.has(a.host)) byHost.set(a.host, []);
    byHost.get(a.host).push(a);
  }
  return el('section', { class: 'stack-lg' },
    [...byHost.entries()].map(([id, list]) => {
      const h = d.hosts.find((x) => x.id === id);
      return el('section', { class: 'panel stack' },
        el('div', { class: 'fl-panel-head' },
          el('h3', { class: 'h3' }, h?.name || id),
          el('button', {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            onclick: () => { state.selected = id; go('hosts'); },
          }, 'Open')),
        el('div', { class: 'fl-list' }, list.map((a) => alertRow(a))));
    }));
}

/* ── actions ─────────────────────────────────────────────────────────── */

async function runAction(hostId, action, label) {
  state.busyAction = `${hostId}:${action.replace(/^restart-/, '')}`;
  render();
  try {
    const res = await api(`/api/hosts/${hostId}/action`, {
      method: 'POST',
      body: JSON.stringify({ action }),
      headers: { 'content-type': 'application/json' },
    });
    ctx.toast?.(res?.error ? 'err' : 'ok',
      res?.error ? `Could not restart ${label}` : `Restarted ${label}`,
      res?.error || undefined);
  } catch (e) {
    ctx.toast?.('err', `Could not restart ${label}`, e.message);
  } finally {
    state.busyAction = null;
    await refresh();
  }
}

async function loadLog(hostId, unit) {
  state.logUnit = unit; state.logBusy = true; state.logText = '';
  render();
  try {
    const res = await api(`/api/hosts/${hostId}/logs/${encodeURIComponent(unit)}`);
    state.logText = res?.lines || res?.error || '(nothing logged)';
  } catch (e) {
    state.logText = e.message;
  } finally {
    state.logBusy = false;
    render();
  }
}

async function loadProcs(hostId) {
  try {
    const d = await api(`/api/hosts/${hostId}/processes?limit=30`
      + (state.procQuery ? `&q=${encodeURIComponent(state.procQuery)}` : ''));
    state.procs = d?.processes || [];
    state.procsFor = hostId;
  } catch { state.procs = []; state.procsFor = hostId; }
  render();
}

async function loadDetail() {
  if (!state.selected) return;
  try {
    state.detail = await api(`/api/hosts/${state.selected}`);
  } catch { state.detail = null; }
  render();
}

async function refresh() {
  try {
    state.data = await api('/api/hosts');
    state.error = null;
  } catch (e) {
    state.error = e.message;
  }
  if (state.view === 'hosts') await loadDetail();
  render();
}

function go(view) {
  state.view = view;
  ctx.setView?.(view);
  render();
  if (view === 'hosts') loadDetail();
}

/* ── live ────────────────────────────────────────────────────────────── */

function connect() {
  try {
    stream = new EventSource(`${ctx.base}/api/events`);
    stream.addEventListener('state', (e) => {
      state.data = JSON.parse(e.data);
      state.live = true;
      state.error = null;
      render();
    });
    stream.onerror = () => { state.live = false; render(); };
  } catch {
    state.live = false;
  }
  // The fallback runs regardless. An SSE stream that connects and then
  // delivers nothing — a proxy buffering it, a sleeping laptop — looks
  // identical to a healthy one from here, and polling every 15s costs a
  // rounding error next to being silently wrong.
  pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, 15_000);
}

/* ── render ──────────────────────────────────────────────────────────── */

function render() {
  if (!root) return;
  const d = state.data;
  root.replaceChildren();

  if (state.error && !d) {
    root.append(el('div', { class: 'alert alert--err' }, state.error));
    return;
  }
  if (!d) {
    root.append(el('div', { class: 'stack-lg' },
      el('span', { class: 'skeleton', style: 'height:64px;display:block' }),
      el('span', { class: 'skeleton', style: 'height:180px;display:block' })));
    return;
  }

  const body = state.view === 'hosts' ? viewHosts(d)
    : state.view === 'services' ? viewServices(d)
      : state.view === 'alerts' ? viewAlerts(d)
        : viewOverview(d);
  root.append(body);
}

/* ── module contract ─────────────────────────────────────────────────── */

export default {
  async mount(mountEl, context) {
    root = mountEl;
    ctx = context;
    state.view = context.view || 'overview';

    if (!document.getElementById('fl-css')) {
      const link = document.createElement('link');
      link.id = 'fl-css';
      link.rel = 'stylesheet';
      link.href = `${ctx.base}/ui/fleet.css`;
      document.head.appendChild(link);
    }

    render();
    await refresh();
    connect();
  },

  async setView(view) {
    state.view = view || 'overview';
    render();
    if (state.view === 'hosts') loadDetail();
  },

  async unmount() {
    if (stream) stream.close();
    if (pollTimer) clearInterval(pollTimer);
    stream = null; pollTimer = null; root = null; ctx = null;
    state.data = null; state.detail = null;
  },
};
