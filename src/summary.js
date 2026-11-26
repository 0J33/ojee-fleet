/**
 * What the console and the page read: the poller's snapshot made legible.
 *
 *   decorate()      every host gets its 2 h series, its ways in (ojee-remote),
 *                   a one-word state, and heat alerts that say how long
 *   buildSummary()  /api/summary — one overview row for the module, one per
 *                   host, four numbers each and a sparkline; alerts with keys
 *   ALERT_KINDS_MANIFEST  every alert kind, for the console's settings table
 *   applyPrefs()    thresholds the person set in the console -> limits
 */

import { LIMITS, tempState } from './normalize.js';

const HOUR = 3600_000;
const HEAT = new Set(['cpu-temp', 'cpu-temp-critical', 'gpu-temp']);

/* ── alert kinds ──────────────────────────────────────────────────────── */

/**
 * `channel` is the default: toast (+ inbox) only for what blocks — a machine
 * cooking, a server gone — and inbox for everything else. Thresholds name the
 * LIMITS key they set, so a change in the console lands on every host.
 */
export const ALERT_KINDS_MANIFEST = [
  { kind: 'fleet.cpu-temp-critical', label: 'CPU critically hot', description: 'A CPU held at or above the critical temperature', severity: 'err', channel: 'toast', blocking: true,
    thresholds: [{ key: 'cpuCritC', label: 'At or above', unit: '°C', default: LIMITS.cpuCritC }, { key: 'heatHoldMin', label: 'For', unit: 'min', default: LIMITS.heatHoldMs / 60_000 }] },
  { kind: 'fleet.cpu-temp', label: 'CPU running hot', description: 'A CPU held above its hot limit', severity: 'warn', channel: 'inbox',
    thresholds: [{ key: 'cpuTempC', label: 'At or above', unit: '°C', default: LIMITS.cpuTempC }, { key: 'heatHoldMin', label: 'For', unit: 'min', default: LIMITS.heatHoldMs / 60_000 }] },
  { kind: 'fleet.gpu-temp', label: 'GPU running hot', description: 'A GPU held above its hot limit', severity: 'warn', channel: 'inbox',
    thresholds: [{ key: 'gpuTempC', label: 'At or above', unit: '°C', default: LIMITS.gpuTempC }] },
  { kind: 'fleet.unreachable', label: 'Machine down', description: 'A machine that should be up stopped answering (a laptop that leaves is away, not down)', severity: 'err', channel: 'toast', blocking: true,
    thresholds: [{ key: 'graceMin', label: 'Silent for', unit: 'min', default: 3 }] },
  { kind: 'fleet.service-down', label: 'Service stopped', description: 'A container or unit is not running', severity: 'warn', channel: 'inbox' },
  { kind: 'fleet.unit-failed', label: 'Unit failed', description: 'A systemd unit stayed failed for 30 minutes', severity: 'warn', channel: 'inbox' },
  { kind: 'fleet.disk', label: 'Disk filling up', description: 'A filesystem passed its warning level', severity: 'warn', channel: 'inbox',
    thresholds: [{ key: 'diskPct', label: 'Full', unit: '%', default: LIMITS.diskPct }] },
  { kind: 'fleet.disk-critical', label: 'Disk nearly full', description: 'A filesystem is almost out of space', severity: 'err', channel: 'inbox',
    thresholds: [{ key: 'diskCritPct', label: 'Full', unit: '%', default: LIMITS.diskCritPct }] },
  { kind: 'fleet.memory', label: 'Memory pressure', description: 'Memory in use above the limit', severity: 'warn', channel: 'inbox',
    thresholds: [{ key: 'memPct', label: 'Used', unit: '%', default: LIMITS.memPct }] },
  { kind: 'fleet.swap', label: 'Swapping', description: 'Swap in real use', severity: 'warn', channel: 'inbox',
    thresholds: [{ key: 'swapPct', label: 'Used', unit: '%', default: LIMITS.swapPct }] },
  { kind: 'fleet.smart', label: 'Drive health', description: 'SMART reported a problem', severity: 'err', channel: 'inbox' },
  { kind: 'fleet.battery', label: 'Battery low', description: 'Battery low and not charging', severity: 'warn', channel: 'inbox',
    thresholds: [{ key: 'batteryPct', label: 'At or below', unit: '%', default: LIMITS.batteryPct }] },
  { kind: 'fleet.stale', label: 'Reading is old', description: 'A machine answers but its numbers stopped moving', severity: 'warn', channel: 'inbox' },
  { kind: 'fleet.cpu-throttle', label: 'CPU throttled', description: 'The CPU throttled since the last sample', severity: 'warn', channel: 'off' },
].map((k) => ({ ...k, threshold: k.thresholds?.[0] || null }));

/**
 * The same kinds in the console's documented `notifications` shape
 * (ojee-console README, Notifications): id, severity info|warn|critical,
 * channel, hold / clearMin, params, source 'alerts'.
 */
export const NOTIFICATION_KINDS = ALERT_KINDS_MANIFEST.map((k) => ({
  id: k.kind,
  label: k.label,
  description: k.description,
  severity: k.severity === 'err' ? 'critical' : k.severity,
  blocking: !!k.blocking,
  channel: k.channel,
  discord: false,
  hold: 2,
  clearMin: 5,
  params: (k.thresholds || []).map((t) => ({ key: t.key, label: t.label, type: 'number', unit: t.unit, default: t.default })),
  view: 'machines',
  source: 'alerts',
}));

/**
 * The console's per-kind settings -> LIMITS overrides. Accepts
 * `types[kind].thresholds[key]`, `types[kind].params[key]`, or a bare number
 * `types[kind].threshold` for a kind's first threshold.
 */
export function applyPrefs(types) {
  const out = {};
  for (const k of ALERT_KINDS_MANIFEST) {
    const t = types?.[k.kind] || types?.[k.kind.replace(/^fleet\./, '')];
    if (!t || !k.thresholds) continue;
    k.thresholds.forEach((th, i) => {
      let v = t.thresholds?.[th.key] ?? t.params?.[th.key];
      if (v == null && i === 0 && (typeof t.threshold === 'number' || typeof t.threshold === 'string')) v = t.threshold;
      if (v && typeof v === 'object') v = v.value;
      v = Number(v);
      if (!Number.isFinite(v)) return;
      if (th.key === 'heatHoldMin') out.heatHoldMs = v * 60_000;
      else if (th.key === 'graceMin') out.graceMs = v * 60_000;
      else out[th.key] = v;
    });
  }
  return out;
}

/* ── decorate ─────────────────────────────────────────────────────────── */

/** Two hours of minute points, as parallel arrays — compact enough for SSE. */
function series2h(store, id) {
  const pts = store ? store.series(id, 2 * HOUR) : [];
  return {
    t: pts.map((p) => p.t),
    cpu: pts.map((p) => p.cpu),
    temp: pts.map((p) => p.tempMax ?? p.temp),
    mem: pts.map((p) => p.mem),
    gpu: pts.map((p) => p.gpu),
  };
}

const heldMin = (store, id, c) => (store ? Math.round(store.heldAbove(id, 'temp', c) / 60_000) : 0);

function stateText(h, heat) {
  if (h.away) return h.remote?.os === 'windows' ? 'On Windows' : 'Away';
  if (!h.online) return h.pending ? 'Not answering' : 'Unreachable';
  if (h.status === 'err') return heat ? 'Running hot' : 'Needs attention';
  if (h.status === 'warn') return heat ? 'Running warm' : 'Degraded';
  if (h.status === 'unknown') return 'Checking';
  // Over the line but not for long enough to raise anything yet: say so,
  // rather than "Healthy" beside a red temperature.
  if (h.tempState === 'err') return 'Running hot';
  if (h.tempState === 'warn') return 'Running warm';
  return 'Healthy';
}

export function decorate(snap, { hosts = [], store = null, remote = null } = {}) {
  const byId = new Map(hosts.map((h) => [h.id, h]));
  const out = snap.hosts.map((h) => {
    const cfg = byId.get(h.id) || {};
    const limits = h.limits || LIMITS;
    const alerts = (h.alerts || []).map((a) => {
      if (!HEAT.has(a.kind)) return a;
      const line = a.kind === 'cpu-temp-critical' ? limits.cpuCritC : a.kind === 'gpu-temp' ? limits.gpuTempC : limits.cpuTempC;
      const min = a.kind === 'gpu-temp' ? 0 : heldMin(store, h.id, line);
      return min ? { ...a, heldMin: min, hint: `above ${line} °C for ${min} min` } : a;
    });
    const heat = alerts.some((a) => HEAT.has(a.kind));
    const r = remote?.forHost(cfg) || null;
    const d = {
      ...h,
      alerts,
      hostname: cfg.hostname || null,
      tag: cfg.tag || null,
      remote: r,
      series: series2h(store, h.id),
      tempState: tempState(h.cpu?.tempC, limits),
      gpuTempState: tempState(h.gpu?.tempC, limits),
    };
    d.stateText = stateText(d, heat);
    return d;
  });
  return {
    ...snap,
    hosts: out,
    alerts: out.flatMap((h) => (h.alerts || []).map((a) => ({ ...a, host: h.id, hostName: h.name }))),
  };
}

/* ── summary ──────────────────────────────────────────────────────────── */

const rnd = (v) => (Number.isFinite(v) ? Math.round(v) : null);
const gb = (b) => (Number.isFinite(b) ? b / 1024 ** 3 : null);
const fmtGb = (b) => { const g = gb(b); return g == null ? '—' : g >= 100 ? String(Math.round(g)) : g.toFixed(1); };
const sev = (s) => (s === 'err' || s === 'warn' || s === 'ok' ? s : null);

function hostState(h) {
  if (h.away) return null;            // grey: neither fine nor broken
  if (!h.online && h.pending) return 'warn';
  if (h.status === 'ok' && (h.tempState === 'err' || h.tempState === 'warn')) return 'warn';
  return sev(h.status === 'unknown' ? null : h.status);
}

/** The alert's stable identity: kind + host + subject, never a number. */
export function alertKey(a, hostId) {
  const subject = a.service || (a.key && /^disk:/.test(a.key) ? a.key.slice(5) : null);
  return ['fleet', a.kind, hostId, subject].filter(Boolean).join('.').replace(/\s+/g, '_');
}

function uptimeText(s) {
  if (!Number.isFinite(s) || s <= 0) return '—';
  const d = Math.floor(s / 86400); const hh = Math.floor((s % 86400) / 3600);
  return d ? `${d}d ${hh}h` : `${hh}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Both names: the console's (`status`, `points`, `cap`) and the first draft's. */
const metric = (m) => (m ? { ...m, status: m.state ?? null } : m);
const sparkOut = (sp, unit) => (sp ? { ...sp, points: sp.values, cap: sp.stat, status: sp.state ?? null, unit } : null);

function hostRow(h) {
  const temp = rnd(h.cpu?.tempC);
  const fullest = (h.disks || []).filter((x) => Number.isFinite(x.pct)).sort((a, b) => b.pct - a.pct)[0];
  const fourth = h.gpu && Number.isFinite(h.gpu.pct)
    ? { label: 'GPU', value: String(rnd(h.gpu.pct)), unit: Number.isFinite(h.gpu.tempC) ? `% · ${rnd(h.gpu.tempC)}°` : '%' }
    : fullest ? { label: 'Disk', value: String(rnd(fullest.pct)), unit: '%' }
      : { label: 'Uptime', value: uptimeText(h.uptime), unit: '' };
  const hot = Number.isFinite(h.cpu?.tempC);
  const vals = hot ? h.series.temp : h.series.cpu;
  const row = {
    id: h.id,
    name: h.name,
    icon: h.tag === 'Laptop' ? 'i-laptop' : h.tag === 'VPS' ? 'i-cloud' : 'i-server',
    tag: h.remote?.os === 'windows' && h.away ? 'Windows' : (h.tag || null),
    status: hostState(h),
    statusText: h.stateText,
    view: 'machines',
    metrics: [
      { label: 'CPU', value: h.online ? String(rnd(h.cpu?.pct) ?? '—') : '—', unit: '%' },
      { label: 'CPU temp', value: temp == null || !h.online ? '—' : String(temp), unit: temp == null ? '' : '°C', state: h.online ? h.tempState : null },
      { label: 'Memory', value: fmtGb(h.mem?.used), unit: h.mem?.total ? `/${Math.round(gb(h.mem.total))} GB` : '' },
      fourth,
    ],
    spark: {
      label: hot ? 'CPU °C · 2h' : 'CPU % · 2h',
      values: vals,
      stat: hot
        ? `max ${rnd(Math.max(...vals.filter(Number.isFinite))) ?? '—'}`
        : `avg ${rnd(vals.filter(Number.isFinite).reduce((a, b) => a + b, 0) / (vals.filter(Number.isFinite).length || 1))}`,
      state: hot ? h.tempState : null,
      threshold: hot ? h.limits?.cpuTempC ?? LIMITS.cpuTempC : null,
      min: hot ? null : 0,
      max: hot ? null : 100,
    },
  };
  return { ...row, metrics: row.metrics.map(metric), spark: sparkOut(row.spark, hot ? '°' : '%') };
}

export function buildSummary(s) {
  const hosts = s.hosts;
  const away = hosts.filter((h) => h.away);
  const down = hosts.filter((h) => !h.online && !h.pending && !h.away);
  const blipping = hosts.filter((h) => !h.online && h.pending);
  const degraded = hosts.filter((h) => h.online && h.status !== 'ok' && h.status !== 'unknown');
  const present = hosts.filter((h) => !h.away);
  // Muted services (stopped on purpose, e.g. odysseus-*) are not counted at all.
  const services = present.flatMap((h) => h.services || []).filter((x) => !(x.muted && !x.ok));
  const running = services.filter((x) => x.ok).length;
  const awayNote = away.length ? ` · ${away.map((h) => `${h.name} ${h.stateText === 'On Windows' ? 'on Windows' : 'away'}`).join(', ')}` : '';

  const headline = down.length
    ? `${down.length} of ${s.total} unreachable`
    : degraded.length
      ? `${s.total} hosts · ${degraded.map((h) => `${h.name} ${h.stateText.toLowerCase()}`).join(', ')}`
      : blipping.length
        ? `${s.total} hosts · ${blipping.map((h) => h.name).join(', ')} not answering`
        : `${s.online} of ${s.total} up${awayNote}`;

  // The module's own row: the hottest machine leads, because heat is the
  // thing on this page most likely to need you in the next ten minutes.
  const hottest = present.filter((h) => h.online && Number.isFinite(h.cpu?.tempC)).sort((a, b) => b.cpu.tempC - a.cpu.tempC)[0];
  const fullest = present.flatMap((h) => (h.disks || []).map((d) => ({ ...d, host: h.name })))
    .filter((d) => Number.isFinite(d.pct)).sort((a, b) => b.pct - a.pct)[0];
  const rows = hosts.map(hostRow);
  const hotRow = hottest ? rows.find((r) => r.id === hottest.id) : rows[0];

  const metrics = [
    { label: 'Up', value: String(s.online), unit: `/${s.total}`, state: down.length ? 'err' : null },
    { label: 'Hottest', value: hottest ? String(rnd(hottest.cpu.tempC)) : '—', unit: hottest ? `°C ${hottest.name}` : '', state: hottest?.tempState || null },
    { label: 'Services', value: String(running), unit: `/${services.length}`, state: running < services.length ? 'warn' : null },
    { label: 'Fullest disk', value: fullest ? String(rnd(fullest.pct)) : '—', unit: fullest ? `% ${fullest.host}` : '', state: fullest ? (fullest.pct >= LIMITS.diskCritPct ? 'err' : fullest.pct >= LIMITS.diskPct ? 'warn' : null) : null },
  ];

  const facts = [
    { k: 'Machines', v: `${s.online} up${down.length ? ` · ${down.map((h) => h.name).join(', ')} down` : ''}${awayNote}` },
    services.length ? { k: 'Services', v: running === services.length ? `all ${services.length} running` : `${services.length - running} stopped of ${services.length}` } : null,
    hottest ? { k: 'Hottest', v: `${hottest.name} ${rnd(hottest.cpu.tempC)} °C` } : null,
    s.alerts.length ? { k: 'Needs attention', v: `${s.alerts.length} alert${s.alerts.length === 1 ? '' : 's'}` } : null,
  ].filter(Boolean);

  // A critical heat alert says everything the warning would; one item, not two.
  const crit = new Set(s.alerts.filter((a) => a.kind === 'cpu-temp-critical').map((a) => a.host));
  const alerts = s.alerts
    .filter((a) => !(a.kind === 'cpu-temp' && crit.has(a.host)))
    .map((a) => ({
      // The console keys an item module:kind:key, so `key` is the subject:
      // the host, and the service or mount when there is one.
      key: alertKey(a, a.host).replace(`fleet.${a.kind}.`, ''),
      kind: `fleet.${a.kind}`,
      notify: `fleet.${a.kind}`,
      action: 'Open',
      text: a.hint && a.heldMin ? `${a.text} for ${a.heldMin} min` : a.text,
      detail: a.hint || null,
      severity: a.severity,
      blocking: !!a.blocking || (a.kind === 'unreachable'),
      host: a.host,
      view: 'machines',
    }));

  return {
    status: s.status === 'unknown' ? 'warn' : s.status,
    headline,
    facts,
    metrics: metrics.map(metric),
    spark: hotRow?.spark || null,
    rows,
    alerts,
  };
}
