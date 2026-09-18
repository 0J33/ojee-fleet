/**
 * The machine this module is running on.
 *
 * Fleet runs on the HP box, so asking another service on the same host what
 * that host is doing is a round trip to learn something we can read directly.
 * This adapter reads `/proc`, `/sys` and the Docker socket instead — which is
 * also what lets the agent module stop being a monitoring tool and go back to
 * being about the thing it is actually for.
 *
 * Two container details that decide what is readable:
 *
 *   - `/proc/stat`, `/proc/meminfo`, `/proc/uptime` and `/proc/loadavg` inside
 *     a container already describe the HOST, not the container. No mount is
 *     needed for CPU, memory or uptime.
 *   - Filesystems come from our OWN mount table, because bind-mounting `/` is
 *     recursive and every host filesystem therefore appears in it as
 *     `/host/home` and so on. Reading the host's own `/proc/mounts` through
 *     the bind does NOT work: it is a symlink to `/proc/self/mounts`, which
 *     resolves in the reader's namespace and hands back the container's table.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { num, offlineHost, pct } from '../normalize.js';

const execFileP = promisify(execFile);

/** Where the host's filesystem is visible from in here. '' means "we are it". */
const HOST_ROOT = (process.env.HOST_ROOT ?? (fs.existsSync('/host/etc/os-release') ? '/host' : '')).replace(/\/$/, '');
const DOCKER_SOCK = process.env.DOCKER_SOCK || '/var/run/docker.sock';

/* CPU and network percentages are deltas, so the previous sample has to live
   somewhere. One host per process, so one slot is enough. */
let prev = { cpu: null, net: null, at: 0 };

const read = async (p) => fsp.readFile(p, 'utf8');
const readOr = async (p, fallback = null) => read(p).catch(() => fallback);

/* ── cpu ───────────────────────────────────────────────────────────────── */

function parseCpuLine(text) {
  const line = (text || '').split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const n = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (n[3] || 0) + (n[4] || 0);          // idle + iowait
  const total = n.reduce((a, b) => a + (b || 0), 0);
  return { idle, total };
}

/* ── memory ────────────────────────────────────────────────────────────── */

function parseMeminfo(text) {
  const kv = {};
  for (const line of (text || '').split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) kv[m[1]] = Number(m[2]) * 1024;
  }
  if (!kv.MemTotal) return { mem: null, swap: null };
  // MemAvailable is the kernel's own answer to "how much can a new process
  // have" — it accounts for reclaimable cache, which MemFree does not, and
  // getting this wrong is why so many dashboards claim a healthy box is at 95%.
  const available = kv.MemAvailable ?? (kv.MemFree + (kv.Buffers || 0) + (kv.Cached || 0));
  const used = kv.MemTotal - available;
  return {
    mem: { used, total: kv.MemTotal, pct: pct(used, kv.MemTotal) },
    swap: kv.SwapTotal
      ? { used: kv.SwapTotal - (kv.SwapFree || 0), total: kv.SwapTotal }
      : null,
  };
}

/* ── filesystems ───────────────────────────────────────────────────────── */

const SKIP_FS = new Set([
  'proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'securityfs', 'cgroup',
  'cgroup2', 'pstore', 'bpf', 'autofs', 'mqueue', 'hugetlbfs', 'debugfs',
  'tracefs', 'fusectl', 'configfs', 'ramfs', 'binfmt_misc', 'squashfs',
  'nsfs', 'overlay', 'efivarfs', 'rpc_pipefs',
]);

/**
 * The host's filesystems, read from THIS process's mount table.
 *
 * Not from `${HOST_ROOT}/proc/mounts`, which looks like the obvious source and
 * is not one: `/proc/mounts` is a symlink to `/proc/self/mounts`, so it
 * resolves in the reader's own mount namespace no matter whose procfs it is
 * bound from. Reading the host's /proc through a bind mount returns the
 * container's mount table.
 *
 * Bind-mounting `/` is recursive, though, so every real filesystem on the host
 * turns up in our OWN table as `/host/home`, `/host/boot/efi` and so on. That
 * is the list, and it needs no extra mount to get at. With HOST_ROOT unset —
 * running on the machine itself — the same code reads the same table with no
 * prefix to strip.
 */
async function filesystems() {
  const text = await readOr('/proc/mounts', '');
  const seen = new Map();
  for (const line of text.split('\n')) {
    const [device, mountRaw, fstype] = line.split(' ');
    if (!mountRaw || SKIP_FS.has(fstype)) continue;
    if (!device?.startsWith('/dev/') && !fstype?.startsWith('fuse')) continue;
    // Mount points are octal-escaped in /proc/mounts (a space is \040).
    const full = mountRaw.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
    // Inside a container only what is under HOST_ROOT describes the host; the
    // rest is the container's own plumbing and its bind-mounted config.
    if (HOST_ROOT && !(full === HOST_ROOT || full.startsWith(`${HOST_ROOT}/`))) continue;
    const mount = HOST_ROOT ? (full.slice(HOST_ROOT.length) || '/') : full;
    if (mount.startsWith('/snap') || mount.startsWith('/var/snap')) continue;
    if (mount.startsWith('/var/lib/docker') || mount.startsWith('/var/lib/containerd')) continue;
    // One device, many mount points: keep the shortest path, which is the one
    // a person would name. Same reasoning as the teg adapter.
    const key = device;
    if (!seen.has(key) || mount.length < seen.get(key).mount.length) {
      seen.set(key, { device, mount, full, fstype });
    }
  }

  const out = [];
  for (const entry of seen.values()) {
    try {
      const s = fs.statfsSync(entry.full);
      const total = s.blocks * s.bsize;
      if (!total) continue;
      const free = s.bavail * s.bsize;
      const used = total - free;
      out.push({
        label: entry.mount,
        mount: entry.mount,
        device: entry.device,
        fstype: entry.fstype,
        remote: entry.fstype?.startsWith('fuse'),
        used,
        total,
        pct: pct(used, total),
      });
    } catch { /* a mount we cannot stat is a mount we do not report */ }
  }
  return out.sort((a, b) => b.total - a.total);
}

/* ── temperature ───────────────────────────────────────────────────────── */

async function cpuTemp() {
  const base = `${HOST_ROOT}/sys/class/hwmon`;
  let dirs = [];
  try { dirs = await fsp.readdir(base); } catch { return null; }
  let best = null;
  for (const d of dirs) {
    const name = (await readOr(`${base}/${d}/name`, ''))?.trim();
    if (!name) continue;
    // coretemp/k10temp are the package sensors; acpitz is the case, which on
    // a laptop reads 20 degrees below the die and would hide a hot CPU.
    const rank = name === 'coretemp' || name === 'k10temp' ? 0
      : name.includes('cpu') ? 1 : name === 'acpitz' ? 3 : 2;
    let files = [];
    try { files = await fsp.readdir(`${base}/${d}`); } catch { continue; }
    for (const f of files.filter((x) => /^temp\d+_input$/.test(x))) {
      const raw = Number(await readOr(`${base}/${d}/${f}`, ''));
      if (!Number.isFinite(raw) || raw <= 0) continue;
      const c = raw > 1000 ? raw / 1000 : raw;
      if (c < 5 || c > 150) continue;
      if (!best || rank < best.rank || (rank === best.rank && c > best.c)) best = { rank, c };
    }
  }
  return best?.c ?? null;
}

/* ── gpu ───────────────────────────────────────────────────────────────── */

async function gpu() {
  try {
    const { stdout } = await execFileP('nvidia-smi', [
      '--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw',
      '--format=csv,noheader,nounits',
    ], { timeout: 4000 });
    const [name, util, temp, used, total, watts] = stdout.trim().split('\n')[0].split(',').map((x) => x.trim());
    if (!name) return null;
    return {
      model: name,
      pct: num(util),
      tempC: num(temp),
      vramUsed: Number.isFinite(Number(used)) ? Number(used) * 1024 * 1024 : null,
      vramTotal: Number.isFinite(Number(total)) ? Number(total) * 1024 * 1024 : null,
      watts: num(watts),
    };
  } catch {
    return null;                                  // no card, or no driver in here
  }
}

/* ── docker ────────────────────────────────────────────────────────────── */

/** A minimal Docker API call over the unix socket — no client library. */
function docker(pathname, { method = 'GET', timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCK, path: pathname, method, timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`docker ${res.statusCode}: ${body.slice(0, 200)}`));
        try { return resolve(body ? JSON.parse(body) : null); } catch { return resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('docker socket timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function containers() {
  try {
    const list = await docker('/v1.43/containers/json?all=1');
    return (list || []).map((c) => ({
      id: (c.Names?.[0] || c.Id || '').replace(/^\//, ''),
      name: (c.Names?.[0] || c.Id || '').replace(/^\//, ''),
      ok: c.State === 'running',
      detail: c.Status || null,
      kind: 'container',
      image: c.Image || null,
      // A container that exists and is stopped is a service that is down. An
      // exited one-shot job is not, so those are reported without judgement.
      critical: false,
    })).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/* ── network ───────────────────────────────────────────────────────────── */

function parseNetDev(text) {
  let rx = 0; let tx = 0;
  for (const line of (text || '').split('\n').slice(2)) {
    const [ifaceRaw, rest] = line.split(':');
    if (!rest) continue;
    const iface = ifaceRaw.trim();
    // Loopback would double every byte the host sends to itself, and docker
    // bridges would count container traffic twice.
    if (iface === 'lo' || /^(docker|br-|veth)/.test(iface)) continue;
    const n = rest.trim().split(/\s+/).map(Number);
    rx += n[0] || 0;
    tx += n[8] || 0;
  }
  return { rx, tx };
}

/* ── probe ─────────────────────────────────────────────────────────────── */

export async function probe(host) {
  try {
    const [stat, meminfo, uptimeRaw, loadRaw, netRaw, disks, tempC, g, svcs] = await Promise.all([
      readOr(`${HOST_ROOT}/proc/stat`, '') ?? readOr('/proc/stat', ''),
      readOr('/proc/meminfo', ''),
      readOr('/proc/uptime', ''),
      readOr('/proc/loadavg', ''),
      readOr('/proc/net/dev', ''),
      filesystems(),
      cpuTemp(),
      gpu(),
      containers(),
    ]);

    const now = Date.now();
    const cpuNow = parseCpuLine(stat);
    let cpuPct = null;
    if (cpuNow && prev.cpu) {
      const dTotal = cpuNow.total - prev.cpu.total;
      const dIdle = cpuNow.idle - prev.cpu.idle;
      if (dTotal > 0) cpuPct = Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100));
    }

    const netNow = parseNetDev(netRaw);
    let net = null;
    if (prev.net && now > prev.at) {
      const dt = (now - prev.at) / 1000;
      net = {
        rx: Math.max(0, (netNow.rx - prev.net.rx) / dt),
        tx: Math.max(0, (netNow.tx - prev.net.tx) / dt),
      };
    }
    prev = { cpu: cpuNow, net: netNow, at: now };

    const { mem, swap } = parseMeminfo(meminfo);
    const load = (loadRaw || '').trim().split(/\s+/).slice(0, 3).map(Number);
    const cores = (stat || '').split('\n').filter((l) => /^cpu\d+ /.test(l)).length || null;
    const model = ((await readOr('/proc/cpuinfo', '')) || '')
      .split('\n').find((l) => l.startsWith('model name'))?.split(':')[1]?.trim() || null;
    const osRelease = await readOr(`${HOST_ROOT}/etc/os-release`, '');
    const osName = osRelease?.split('\n').find((l) => l.startsWith('PRETTY_NAME='))
      ?.split('=')[1]?.replace(/"/g, '') || null;

    return {
      id: host.id,
      name: host.name || host.id,
      role: host.role || '',
      kind: host.kind,
      online: true,
      error: null,
      at: now,
      os: osName,
      uptime: num(Number((uptimeRaw || '').split(' ')[0])),
      cpu: {
        model,
        // The first sample after a start has no previous one to diff against,
        // so there is no percentage yet. Null, not zero: "we do not know" and
        // "the machine is idle" are different claims.
        pct: cpuPct,
        cores,
        tempC,
        load: load.length === 3 && load.every(Number.isFinite) ? load : null,
      },
      mem,
      swap,
      gpu: g,
      net,
      battery: null,
      disks,
      services: svcs,
      alerts: [],
      links: host.links || [],
      capabilities: { logs: false, services: true, actions: true, local: true },
    };
  } catch (e) {
    return offlineHost(host, e.message || String(e));
  }
}

/** Restart a container by name — the only action this adapter performs. */
export async function action(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name)) throw new Error('bad container name');
  await docker(`/v1.43/containers/${encodeURIComponent(name)}/restart`, { method: 'POST', timeout: 30_000 });
  return { ok: true, restarted: name };
}

export const describe = () => 'this machine (/proc, /sys, docker.sock)';
export { HOST_ROOT };
