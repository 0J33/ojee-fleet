/**
 * A host as ANOTHER fleet sees it: `GET {origin}/api/hosts/{mirror}`.
 *
 * For a second fleet that should show machines the first one already reads
 * (and for developing this one against live numbers without holding any
 * host's credentials). The reading is taken as-is; alerts are re-derived here
 * from its numbers, so this fleet's limits apply. Read only.
 */
import { offlineHost } from '../normalize.js';

export async function probe(host) {
  try {
    const res = await fetch(new URL(`/api/hosts/${encodeURIComponent(host.mirror || host.id)}`, host.origin), {
      headers: host.token ? { authorization: `Bearer ${host.token}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const r = await res.json();
    if (!r.online) return offlineHost(host, r.error || 'offline upstream');
    const {
      alerts, pendingAlerts, status, muted, limits, history, series, remote, stateText, tempState, gpuTempState,
      downSince, failures, pending, away, lastSeen, graceMs, ...reading
    } = r;
    return {
      ...reading,
      id: host.id,
      name: host.name || r.name,
      role: host.role || r.role || '',
      kind: host.kind,
      alerts: [],
      capabilities: { ...(r.capabilities || {}), actions: false },
    };
  } catch (e) {
    return offlineHost(host, e.name === 'TimeoutError' ? 'timed out' : e.message);
  }
}

export const describe = () => 'another fleet\'s reading of a host (read only)';
