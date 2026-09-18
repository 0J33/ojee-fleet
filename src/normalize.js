/**
 * One shape for every machine, and the rules that decide what is wrong.
 *
 * Three hosts, three completely different APIs — a Flask dashboard, a Node
 * agent using systeminformation, and a Python sampler reading /proc directly.
 * Adapters translate; this file defines what they translate *into*, and holds
 * the one thing that must not live in three places: the thresholds.
 *
 * Every field is optional. A machine that cannot report its RAM reports no
 * RAM — it does not report zero, because a zero renders as a bar at 0% and
 * that is a lie about a working machine.
 */

export const UNKNOWN = null;

/** Percentage, guarding the two ways this normally goes wrong. */
export const pct = (used, total) => {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return UNKNOWN;
  return Math.max(0, Math.min(100, (used / total) * 100));
};

export const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : UNKNOWN);

/** The empty state of a host we have not reached yet or cannot reach. */
export function offlineHost(host, error) {
  return {
    id: host.id,
    name: host.name || host.id,
    role: host.role || '',
    kind: host.kind,
    online: false,
    error: error || 'unreachable',
    at: Date.now(),
    cpu: null, mem: null, swap: null, gpu: null, net: null, battery: null,
    disks: [], services: [], alerts: [],
    os: null, uptime: null,
  };
}

/* ── thresholds ────────────────────────────────────────────────────────────
   Deliberately few, and each one is a number someone would act on. A page
   that warns about everything is a page nobody reads. */
export const LIMITS = {
  cpuTempC: 88,          // sustained above this is throttling territory
  gpuTempC: 85,
  diskPct: 90,           // below 10% free is when ext4 starts fragmenting badly
  diskCritPct: 96,
  memPct: 93,
  swapPct: 60,           // swap in real use means something is over-committed
  batteryPct: 15,
  staleMs: 120_000,      // a sample this old is not a live reading
};

/**
 * Derive alerts from a normalized host. Adapters may add their own (a service
 * the host itself calls failed, say); these are the ones that can be decided
 * from numbers alone, so they are decided in one place.
 */
export function deriveAlerts(h) {
  const out = [];
  const add = (severity, text, hint) => out.push({ severity, text, hint });

  if (!h.online) {
    add('err', `${h.name} is unreachable`, h.error || undefined);
    return out;                                   // nothing else is knowable
  }

  if (h.at && Date.now() - h.at > LIMITS.staleMs) {
    add('warn', `${h.name} has not reported for ${Math.round((Date.now() - h.at) / 60000)} min`);
  }

  const cpuTemp = h.cpu?.tempC;
  if (Number.isFinite(cpuTemp) && cpuTemp >= LIMITS.cpuTempC) {
    add('warn', `${h.name} CPU at ${Math.round(cpuTemp)}°C`, 'sustained load or a fan problem');
  }
  const gpuTemp = h.gpu?.tempC;
  if (Number.isFinite(gpuTemp) && gpuTemp >= LIMITS.gpuTempC) {
    add('warn', `${h.name} GPU at ${Math.round(gpuTemp)}°C`);
  }

  for (const d of h.disks || []) {
    const p = Number.isFinite(d.pct) ? d.pct : pct(d.used, d.total);
    if (!Number.isFinite(p)) continue;
    if (p >= LIMITS.diskCritPct) add('err', `${h.name} ${d.label} is ${Math.round(p)}% full`, 'almost out of space');
    else if (p >= LIMITS.diskPct) add('warn', `${h.name} ${d.label} is ${Math.round(p)}% full`);
  }

  const memPct = h.mem ? (Number.isFinite(h.mem.pct) ? h.mem.pct : pct(h.mem.used, h.mem.total)) : UNKNOWN;
  if (Number.isFinite(memPct) && memPct >= LIMITS.memPct) {
    add('warn', `${h.name} memory at ${Math.round(memPct)}%`);
  }
  const swapPct = h.swap ? pct(h.swap.used, h.swap.total) : UNKNOWN;
  if (Number.isFinite(swapPct) && swapPct >= LIMITS.swapPct) {
    add('warn', `${h.name} is ${Math.round(swapPct)}% into swap`, 'something is over-committed');
  }

  const bat = h.battery;
  if (bat && Number.isFinite(bat.pct) && bat.pct <= LIMITS.batteryPct && bat.state !== 'charging') {
    add('warn', `${h.name} battery at ${Math.round(bat.pct)}%`);
  }

  for (const s of h.services || []) {
    if (s.ok === false) add(s.critical ? 'err' : 'warn', `${s.name} is not running on ${h.name}`, s.detail || undefined);
  }

  return out;
}

/** err beats warn beats ok — for rolling a list of things up into one word. */
export const worst = (list) => (list.some((a) => a.severity === 'err') ? 'err'
  : list.some((a) => a.severity === 'warn') ? 'warn' : 'ok');

export const fmtBytes = (n) => {
  if (!Number.isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};

export const fmtUptime = (s) => {
  if (!Number.isFinite(s) || s <= 0) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
};
