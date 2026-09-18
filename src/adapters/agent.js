/**
 * ojee-agent — the Node module on the HP box.
 *
 * It reports the host through systeminformation plus a few reads of /host,
 * and its services are docker containers rather than systemd units. Both
 * differences are the adapter's problem, not the UI's.
 *
 * Note `/api/stats` returns `home` separately when /home is its own
 * filesystem. That is the disk that actually fills up on that machine, so it
 * is listed as a disk in its own right rather than folded into root.
 */

import { num, offlineHost, pct } from '../normalize.js';

const TIMEOUT_MS = 6000;

async function get(host, pathname, { optional = false } = {}) {
  const url = new URL(pathname, host.origin).toString();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: host.token ? { authorization: `Bearer ${host.token}` } : {},
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } catch (e) {
    if (optional) return null;
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export async function probe(host) {
  let stats;
  try {
    stats = await get(host, '/api/stats');
  } catch (e) {
    return offlineHost(host, e.name === 'AbortError' ? 'timed out' : e.message);
  }
  const services = await get(host, '/api/services', { optional: true });

  const disks = [];
  if (stats.disk?.total) {
    disks.push({
      label: '/', mount: '/', used: num(stats.disk.used), total: num(stats.disk.total),
      pct: num(stats.disk.percent),
      io: { read: num(stats.disk.read_per_s), write: num(stats.disk.write_per_s) },
    });
  }
  if (stats.home?.total) {
    disks.push({
      label: '/home', mount: '/home', used: num(stats.home.used),
      total: num(stats.home.total), pct: num(stats.home.percent),
    });
  }

  const gpu = Array.isArray(stats.gpu) ? stats.gpu[0] : stats.gpu;

  return {
    id: host.id,
    name: host.name || stats.hostname || host.id,
    role: host.role || '',
    kind: host.kind,
    online: true,
    error: null,
    at: Date.now(),
    os: stats.os || null,
    uptime: num(stats.uptime),
    cpu: {
      model: stats.cpu?.model || null,
      pct: num(stats.cpu?.avg),
      cores: stats.cpu?.cores ?? null,
      tempC: num(stats.temps?.find((t) => /package|cpu/i.test(t.label || ''))?.current
        ?? stats.temps?.[0]?.current),
      load: stats.cpu?.load || null,
    },
    mem: stats.memory ? {
      used: num(stats.memory.used), total: num(stats.memory.total),
      pct: num(stats.memory.percent) ?? pct(stats.memory.used, stats.memory.total),
    } : null,
    swap: stats.swap?.total ? { used: num(stats.swap.used), total: num(stats.swap.total) } : null,
    gpu: gpu ? {
      model: gpu.model || gpu.name || null,
      pct: num(gpu.utilization ?? gpu.usage),
      tempC: num(gpu.temperature ?? gpu.temp),
      vramUsed: num(gpu.memoryUsed ?? gpu.memory_used),
      vramTotal: num(gpu.memoryTotal ?? gpu.memory_total),
      watts: num(gpu.powerDraw ?? gpu.power),
    } : null,
    net: stats.network ? {
      rx: num(stats.network.recv_per_s), tx: num(stats.network.sent_per_s),
    } : null,
    battery: null,
    disks,
    // Containers, not units. `ok` means running; a container that exists but
    // is stopped is a service that is down, which is exactly what we want to
    // see — it is not absent, it is not working.
    services: Object.entries(services || {}).map(([id, s]) => ({
      id,
      name: s.desc || id,
      ok: !!s.active,
      detail: s.status || null,
      kind: 'container',
      critical: !!s.critical,
    })),
    alerts: [],
    links: host.links || [],
    capabilities: { logs: false, services: true, actions: true },
  };
}

export const describe = () => 'ojee-agent (Node)';
