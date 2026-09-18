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
 * Every alert carries a `kind`. It is what makes an alert addressable — the
 * thing a host config can name to say "not on this machine". Without it the
 * only ways to silence a rule are to raise its threshold everywhere or to
 * special-case a hostname in the rules, and both are worse than a list.
 */
export const ALERT_KINDS = {
  unreachable: 'the host did not answer',
  stale: 'the host answered, but the reading is old',
  'cpu-temp': 'CPU temperature above the limit',
  'cpu-throttle': 'the CPU throttled since the last sample',
  'gpu-temp': 'GPU temperature above the limit',
  disk: 'a filesystem is filling up',
  'disk-critical': 'a filesystem is nearly full',
  memory: 'memory pressure',
  swap: 'swap in real use',
  battery: 'battery low and not charging',
  'service-down': 'a unit or container is not running',
  smart: 'SMART reported something',
  'unit-failed': 'a systemd unit is in the failed state',
};

/**
 * Derive alerts from a normalized host. Adapters may add their own (a service
 * the host itself calls failed, say); these are the ones that can be decided
 * from numbers alone, so they are decided in one place.
 */
export function deriveAlerts(h) {
  const out = [];
  const add = (kind, severity, text, hint) => out.push({ kind, severity, text, hint });

  if (!h.online) {
    add('unreachable', 'err', `${h.name} is unreachable`, h.error || undefined);
    return out;                                   // nothing else is knowable
  }

  if (h.at && Date.now() - h.at > LIMITS.staleMs) {
    add('stale', 'warn', `${h.name} has not reported for ${Math.round((Date.now() - h.at) / 60000)} min`);
  }

  const cpuTemp = h.cpu?.tempC;
  if (Number.isFinite(cpuTemp) && cpuTemp >= LIMITS.cpuTempC) {
    add('cpu-temp', 'warn', `${h.name} CPU at ${Math.round(cpuTemp)}°C`, 'sustained load or a fan problem');
  }
  const gpuTemp = h.gpu?.tempC;
  if (Number.isFinite(gpuTemp) && gpuTemp >= LIMITS.gpuTempC) {
    add('gpu-temp', 'warn', `${h.name} GPU at ${Math.round(gpuTemp)}°C`);
  }

  for (const d of h.disks || []) {
    const p = Number.isFinite(d.pct) ? d.pct : pct(d.used, d.total);
    if (!Number.isFinite(p)) continue;
    if (p >= LIMITS.diskCritPct) add('disk-critical', 'err', `${h.name} ${d.label} is ${Math.round(p)}% full`, 'almost out of space');
    else if (p >= LIMITS.diskPct) add('disk', 'warn', `${h.name} ${d.label} is ${Math.round(p)}% full`);
  }

  const memPct = h.mem ? (Number.isFinite(h.mem.pct) ? h.mem.pct : pct(h.mem.used, h.mem.total)) : UNKNOWN;
  if (Number.isFinite(memPct) && memPct >= LIMITS.memPct) {
    add('memory', 'warn', `${h.name} memory at ${Math.round(memPct)}%`);
  }
  const swapPct = h.swap ? pct(h.swap.used, h.swap.total) : UNKNOWN;
  if (Number.isFinite(swapPct) && swapPct >= LIMITS.swapPct) {
    add('swap', 'warn', `${h.name} is ${Math.round(swapPct)}% into swap`, 'something is over-committed');
  }

  const bat = h.battery;
  if (bat && Number.isFinite(bat.pct) && bat.pct <= LIMITS.batteryPct && bat.state !== 'charging') {
    add('battery', 'warn', `${h.name} battery at ${Math.round(bat.pct)}%`);
  }

  for (const s of h.services || []) {
    // `downFor` is filled in by the poller, which is the only thing that can
    // see two samples. An adapter that does not report it gets the old
    // behaviour: alert on the first miss.
    if (s.ok === false && (s.downFor ?? 2) >= 2) {
      add('service-down', s.critical ? 'err' : 'warn',
        `${s.name} is not running on ${h.name}`, s.detail || undefined);
    }
  }

  return out;
}

/**
 * Drop the alert kinds a host has asked not to be told about.
 *
 * A laptop compiling something runs hot and throttles; that is the hardware
 * doing its job, and an alert about it is a permanent one you learn to ignore
 * — which costs you the alerts that do matter. Muting is per host, because
 * 95°C means nothing on a laptop and means a failed fan on a server.
 *
 * Muted alerts are removed BEFORE status is rolled up, so a muted rule cannot
 * colour the host red, ping Discord, or raise a phone notification either.
 */
export function applyMutes(alerts, mute) {
  if (!mute?.length) return alerts;
  const set = new Set(mute);
  return alerts.filter((a) => !set.has(a.kind));
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
