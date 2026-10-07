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
 * How long a problem has to hold before it is one.
 *
 * Every alert except `unreachable` (which has its own grace window) has to be
 * raised on 3 consecutive polls spanning at least 90 seconds before it can
 * colour a host, and therefore before it can reach Discord or a phone.
 *
 * Why those numbers, from what disinteg actually does: its units restart with
 * RestartSec=5s, and a deploy or a crash is a stop, five seconds, then a start
 * that takes anything from one second (node) to half a minute (gunicorn
 * loading FastF1). That is two, sometimes three, 10-second polls of "down" for
 * something that fixed itself. 90 s clears the slowest of those with a
 * margin, while a service that is really dead is still reported within two
 * minutes. Recovery does not wait at all.
 *
 * FLEET_SUSTAIN_MS / FLEET_SUSTAIN_CHECKS, or per host `sustainMs` /
 * `sustainChecks` (HOST_<ID>_SUSTAIN_MS), override it.
 */
export const HYSTERESIS = { ms: 90_000, checks: 3 };

/**
 * What makes two alerts on consecutive polls "the same alert". Not the text:
 * "memory at 94%" and "memory at 95%" are one problem. An alert may carry its
 * own `key`; otherwise it is its kind plus its text with the numbers taken out.
 */
export const alertKey = (a) => a.key
  || `${a.kind}:${String(a.text || '').replace(/\d+(\.\d+)?/g, '#')}`;

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
    // One key for both levels: a disk going from 95% to 97% is the same
    // problem getting worse, not a new one that has to be waited out again.
    const key = `disk:${d.mount || d.label}`;
    const text = `${h.name} ${d.label} is ${Math.round(p)}% full`;
    if (p >= LIMITS.diskCritPct) out.push({ kind: 'disk-critical', severity: 'err', text, hint: 'almost out of space', key });
    else if (p >= LIMITS.diskPct) out.push({ kind: 'disk', severity: 'warn', text, key });
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
    // Raised on every poll the service is down; whether it has been down
    // long enough to COUNT is the poller's call (see HYSTERESIS), because
    // only the poller can see more than one sample.
    if (s.ok === false) {
      out.push({
        kind: 'service-down',
        severity: s.critical ? 'err' : 'warn',
        text: `${s.name} is not running on ${h.name}`,
        hint: s.detail || undefined,
        key: `service-down:${s.id || s.name}`,
      });
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

/**
 * /etc/os-release, properly: values may be double- or single-quoted or bare,
 * may contain escaped quotes, and comment lines are allowed. PRETTY_NAME is
 * what the distribution wants shown ("Zorin OS 18.1", "Ubuntu 24.04.1 LTS");
 * without it, NAME plus VERSION (or VERSION_ID). Null when neither exists —
 * never "Linux", which is true of every machine here and says nothing.
 */
export function parseOsRelease(text) {
  const kv = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    kv[m[1]] = v.replace(/\\(["'$`\\])/g, '$1');
  }
  const pretty = kv.PRETTY_NAME?.trim();
  if (pretty && pretty !== 'Linux') return pretty;
  const composed = [kv.NAME, kv.VERSION || kv.VERSION_ID].filter(Boolean).join(' ').trim();
  return composed || null;
}

/**
 * The best OS name among several candidates. A bare kernel string
 * ("Linux 7.0.0-31-generic", "Linux") is what platform.system() gives you and
 * is only used when nothing names the distribution.
 */
export function pickOs(...candidates) {
  const list = candidates.map((c) => (typeof c === 'string' ? c.trim() : '')).filter(Boolean);
  return list.find((c) => !/^linux\b/i.test(c)) || list[0] || null;
}

/** /dev/sda1 -> sda, /dev/nvme0n1p2 -> nvme0n1, /dev/mmcblk0p1 -> mmcblk0. */
export function parentDisk(dev) {
  const name = String(dev || '').replace(/^\/dev\//, '');
  if (!name) return null;
  const m = name.match(/^(nvme\d+n\d+|mmcblk\d+)(p\d+)?$/);
  if (m) return m[1];
  const sd = name.match(/^((?:s|v|xv|h)d[a-z]+)\d*$/);
  if (sd) return sd[1];
  return name;
}

/**
 * Join a host's mounted filesystems to its physical disks: each filesystem
 * gets the model of the disk it lives on, and each disk says whether anything
 * is mounted from it. A disk with nothing mounted is still listed — a spare
 * SSD or an enclosure that was plugged in but not mounted is exactly what you
 * would want to find on this page.
 */
export function joinStorage(disks, drives) {
  const byName = new Map((drives || []).map((d) => [d.device, d]));
  const used = new Set();
  const fs = (disks || []).map((d) => {
    const parent = d.disk || parentDisk(d.device);
    if (parent) used.add(parent);
    const drive = byName.get(parent);
    return { ...d, disk: parent || null, model: d.model || drive?.model || null };
  });
  const dr = (drives || []).map((d) => ({ ...d, mounted: used.has(d.device) }));
  return { disks: fs, drives: dr };
}
