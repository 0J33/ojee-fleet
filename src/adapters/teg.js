/**
 * disinteg — the Flask dashboard API behind tegtech-api.ojee.net.
 *
 * Auth is a shared bearer that happens to equal the dashboard password; that
 * is the API's scheme, not ours, and wrapping it in something cleverer here
 * would only hide what is actually being sent.
 *
 * Three calls, in parallel, and a failure in the optional two does not make
 * the host unreachable: /api/stats is the host being up, /api/disks and
 * /api/checks are detail. A box whose SMART collector has stopped is still a
 * box that is up, and reporting it as down would be worse than reporting it
 * without disk health.
 */

import { fmtBytes, num, offlineHost, pct } from '../normalize.js';

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

  const [disks, checks, services, hardware, gpuInfo] = await Promise.all([
    get(host, '/api/disks', { optional: true }),
    get(host, '/api/checks', { optional: true }),
    get(host, '/api/services', { optional: true }),
    // Cached upstream for an hour — it is the make and model of the machine,
    // which does not change while it is running.
    get(host, '/api/hardware', { optional: true }),
    get(host, '/api/gpu', { optional: true }),
  ]);

  const alerts = [];
  // /api/disks answers {mounts, devices, health} — real filesystems only, and
  // whatever each machine has published about its own SMART. A health entry
  // that is null means the collector has not run there, which is not the same
  // as a disk that failed and must not be reported as one.
  // One filesystem, many mount points: this box has /dev/sda1 at /, /boot,
  // /etc, /root, /tmp, /usr and /var/tmp, all reporting the same 4.6%. Listing
  // them all is seven rows that say one thing, and it buries the one mount
  // that is actually filling up. Keep the shortest path per device — that is
  // the one a person would name.
  const mounts = Object.values(
    (disks?.mounts || []).reduce((acc, m) => {
      const key = m.device || m.mount;
      if (!acc[key] || m.mount.length < acc[key].mount.length) acc[key] = m;
      return acc;
    }, {}),
  ).sort((a, b) => (b.total || 0) - (a.total || 0));
  for (const [key, h] of Object.entries(disks?.health || {})) {
    if (!h) continue;
    const verdict = String(h.status || h.smart || '').toUpperCase();
    if (verdict && verdict !== 'PASSED' && verdict !== 'OK') {
      alerts.push({ kind: 'smart', severity: 'err', text: `${key}: SMART says ${h.status}`, hint: h.device || undefined });
    }
    if (Number(h.reallocated) > 0) {
      alerts.push({ kind: 'smart', severity: 'err', text: `${key} has ${h.reallocated} reallocated sectors` });
    }
    if (Number(h.fs_errors) > 0) {
      alerts.push({ kind: 'smart', severity: 'warn', text: `${key} filesystem has logged ${h.fs_errors} errors` });
    }
  }
  for (const f of checks?.failed || []) {
    alerts.push({
      kind: 'unit-failed',
      severity: 'err',
      text: `${f.unit} failed`,
      hint: [f.scope === 'user' ? 'user unit' : null, f.detail].filter(Boolean).join(' · ') || undefined,
    });
  }

  const gpu = Array.isArray(stats.gpu) ? stats.gpu[0] : stats.gpu;
  // This box reports which GPUs are FITTED — model, driver, clock — and no
  // utilisation for any of them, because nothing on it runs nvidia-smi. A
  // utilisation bar would therefore be a bar that is always at zero, which
  // says something false about a card that might be perfectly busy. List the
  // hardware instead, and keep the gauge for hosts that actually measure.
  const gpus = (gpuInfo?.adapters || []).map((a) => ({
    model: a.model || null,
    driver: a.driver || null,
    inUse: !!a.in_use,
    clockMhz: (gpuInfo.cards || []).find((c) => c.driver === a.driver)?.freq_mhz ?? null,
  })).filter((g) => g.model);

  return {
    id: host.id,
    name: host.name || stats.hostname || host.id,
    role: host.role || '',
    kind: host.kind,
    online: true,
    error: null,
    at: Date.now(),
    os: stats.os || hardware?.os || null,
    machine: hardware?.model || hardware?.board || null,
    uptime: num(stats.uptime),
    cpu: {
      model: stats.cpu?.model || hardware?.cpu?.model || hardware?.cpu_model || null,
      pct: num(stats.cpu?.avg ?? stats.cpu?.percent),
      cores: stats.cpu?.cores ?? null,
      tempC: num(stats.temps?.[0]?.current ?? stats.cpu?.temp),
      load: stats.cpu?.load || null,
    },
    mem: stats.memory ? {
      used: num(stats.memory.used), total: num(stats.memory.total),
      pct: num(stats.memory.percent) ?? pct(stats.memory.used, stats.memory.total),
    } : null,
    swap: stats.swap ? { used: num(stats.swap.used), total: num(stats.swap.total) } : null,
    gpu: gpu ? {
      model: gpu.name || gpu.model || null,
      pct: num(gpu.utilization ?? gpu.usage),
      tempC: num(gpu.temperature ?? gpu.tempC),
      vramUsed: num(gpu.memory_used ?? gpu.vramUsedMb),
      vramTotal: num(gpu.memory_total ?? gpu.vramTotalMb),
      watts: num(gpu.power ?? gpu.watts),
    } : null,
    gpus,
    net: stats.network ? {
      rx: num(stats.network.recv_per_s), tx: num(stats.network.sent_per_s),
    } : null,
    battery: null,
    disks: mounts.length ? mounts.map((d) => ({
      label: d.mount,
      mount: d.mount,
      device: d.device || null,
      fstype: d.fstype || null,
      remote: !!d.remote,
      used: num(d.used), total: num(d.total),
      pct: num(d.percent) ?? pct(d.used, d.total),
    })) : (stats.disk ? [{
      label: '/', mount: '/', used: num(stats.disk.used), total: num(stats.disk.total),
      pct: num(stats.disk.percent),
    }] : []),
    services: Object.entries(services || {}).map(([id, s]) => ({
      id,
      name: s.desc || id,
      ok: !!s.active,
      detail: s.unit_state && s.unit_state !== 'active' ? s.unit_state : null,
      memory: num(s.memory),
      critical: !!s.critical,
    })),
    alerts,
    links: host.links || [],
    capabilities: { logs: true, services: true, actions: true },
  };
}

export const describe = () => 'teg dashboard API (Flask)';
export { fmtBytes };
