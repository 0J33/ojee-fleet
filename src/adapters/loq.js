/**
 * ojee-loq — the Python sampler on the laptop.
 *
 * The richest of the three and the most different: it reads /proc and RAPL
 * directly, so it reports CPU package watts, fan RPM, per-core load and a
 * battery — and no RAM at all, because its sampler never collected any. That
 * absence is reported as an absence. A memory bar sitting at 0% would be a
 * statement about a machine that is using memory perfectly normally.
 *
 * Controls (fan curves, TDP, power profile) stay where they are. This module
 * watches machines; the laptop's own module owns its knobs, and duplicating
 * them here would mean two places that can disagree about the current state.
 */

import { num, offlineHost, pct } from '../normalize.js';

const TIMEOUT_MS = 6000;
const MB = 1024 * 1024;

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
  let s;
  try {
    s = await get(host, '/api/state');
  } catch (e) {
    return offlineHost(host, e.name === 'AbortError' ? 'timed out' : e.message);
  }

  // `throttled` is a counter since boot, not a count for this sample — it sits
  // in the millions on a laptop that has been up for weeks and has throttled
  // exactly as much as any laptop does. Whether it is throttling NOW is a
  // question about the delta between two samples, which only the poller can
  // see, so it is reported raw here and judged there.
  const alerts = [];

  // The sampler lists PHYSICAL drives — make, model, capacity — not mounted
  // filesystems, and it collects no usage for them. They are reported as what
  // they are: hardware. Rendering them as filesystems would mean three usage
  // bars that could only ever sit at zero.
  const drives = (s.drives || []).map((d) => ({
    device: d.dev || d.device || null,
    model: d.model || null,
    size: num(d.size),
    tempC: num(d.tempC ?? d.temp),
  })).filter((d) => d.device);

  const bat = s.battery || null;

  return {
    id: host.id,
    name: host.name || s.name || host.id,
    role: host.role || '',
    kind: host.kind,
    online: true,
    error: null,
    // The sampler stamps its own sample; use it rather than "now" so a
    // wedged sampler shows as stale instead of eternally fresh.
    at: Number.isFinite(s.at) ? s.at * 1000 : Date.now(),
    os: host.os || null,
    uptime: num(s.uptime),
    cpu: {
      model: s.cpu?.model || null,
      pct: num(s.cpu?.usage),
      cores: Array.isArray(s.cpu?.cores) ? s.cpu.cores.length : null,
      coreLoad: Array.isArray(s.cpu?.cores) ? s.cpu.cores : null,
      tempC: num(s.cpu?.tempC),
      watts: num(s.cpu?.watts),
      tdp: num(s.cpu?.tdp),
      throttled: num(s.cpu?.throttled),
    },
    mem: null,                                   // not sampled — see the note above
    swap: null,
    gpu: s.gpu?.model ? {
      model: s.gpu.model,
      pct: num(s.gpu.usage),
      tempC: num(s.gpu.tempC),
      vramUsed: Number.isFinite(s.gpu.vramUsedMb) ? s.gpu.vramUsedMb * MB : null,
      vramTotal: Number.isFinite(s.gpu.vramTotalMb) ? s.gpu.vramTotalMb * MB : null,
      watts: num(s.gpu.watts),
      clockMhz: num(s.gpu.clockMhz),
    } : null,
    net: s.io ? { rx: num(s.io.netRxPerS), tx: num(s.io.netTxPerS) } : null,
    fans: s.fans || null,
    battery: bat ? {
      pct: num(bat.percent ?? bat.pct),
      state: bat.state || bat.status || null,
      watts: num(bat.watts),
      health: num(bat.healthPct ?? bat.health),
    } : null,
    disks: [],
    drives,
    services: [],
    alerts,
    links: host.links || [],
    capabilities: { logs: false, services: false, actions: false, processes: true },
  };
}

export const describe = () => 'ojee-loq agent (Python)';
