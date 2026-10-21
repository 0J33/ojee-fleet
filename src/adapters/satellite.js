/**
 * A machine running the fleet satellite (src/satellite.js): the `local`
 * adapter's own reading, taken on that machine and fetched over the tailnet.
 * The laptop is read this way since its own sampler (ojee-loq) was retired.
 *
 * The reading arrives in fleet's normalized shape already; this only puts
 * the host's configured identity on it and says what it cannot do from here
 * (restart containers, read logs: it is read only on purpose).
 */

import { offlineHost } from '../normalize.js';

const TIMEOUT_MS = 8000;

export async function probe(host) {
  let r;
  try {
    const res = await fetch(new URL('/api/host', host.origin), {
      headers: host.token ? { authorization: `Bearer ${host.token}` } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    r = await res.json();
  } catch (e) {
    return offlineHost(host, e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timed out' : e.message);
  }
  if (!r || r.online === false) return offlineHost(host, r?.error || 'the satellite could not read the machine');
  return {
    ...r,
    id: host.id,
    name: host.name || r.name || host.id,
    role: host.role || '',
    kind: host.kind,
    links: host.links || [],
    capabilities: { logs: false, services: true, actions: false },
  };
}

export const describe = () => 'fleet satellite (the local reading, served from that machine)';
