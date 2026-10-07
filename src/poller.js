/**
 * The poller.
 *
 * Every host is probed on a timer in the background and the result is cached.
 * Requests read the cache. This is the whole reason the page is usable: one
 * machine in another country, behind a tunnel, occasionally takes six seconds
 * to answer, and a fleet view that probes on request is a fleet view that is
 * as slow as its slowest member every single time you look at it.
 *
 * Two properties that took thinking about:
 *
 *   - A failed probe does NOT erase the last good reading. It marks the host
 *     offline and keeps what we last knew, so the page can say "unreachable,
 *     last seen 40s ago at 12% CPU" instead of going blank. Blank looks like
 *     a bug; stale-with-a-timestamp looks like what it is.
 *
 *   - Probes for different hosts never queue behind each other. They are
 *     started together and settled together, so the slowest host costs one
 *     timeout, not one timeout per host.
 */

import { EventEmitter } from 'node:events';
import { HYSTERESIS, alertKey, applyMutes, deriveAlerts, worst } from './normalize.js';

import * as tegAdapter from './adapters/teg.js';
import * as agentAdapter from './adapters/agent.js';
import * as loqAdapter from './adapters/loq.js';
import * as localAdapter from './adapters/local.js';

const ADAPTERS = {
  teg: tegAdapter,
  agent: agentAdapter,
  loq: loqAdapter,
  local: localAdapter,
};

export class Poller extends EventEmitter {
  constructor({
    hosts, intervalMs = 10_000, historyLength = 90, now = Date.now, sustain = HYSTERESIS,
  }) {
    super();
    this.hosts = hosts;
    // How long, and over how many polls, an alert has to hold before it
    // counts. See `confirm()` below and HYSTERESIS in normalize.js.
    this.sustain = { ...HYSTERESIS, ...(sustain || {}) };
    this.intervalMs = intervalMs;
    this.historyLength = historyLength;
    this.now = now;
    this.timer = null;
    this.busy = false;

    /** id -> normalized host state (always present, possibly offline) */
    this.state = new Map();
    /** id -> ring of {t, cpu, mem, gpu} for the sparklines */
    this.history = new Map();
    /** id -> last time this host was reachable */
    this.lastSeen = new Map();
    /** id -> Map(alert key -> {since, checks, confirmed}) */
    this.alertClock = new Map();
    /** id -> the open incident, {severity, since}, if one was announced */
    this.incidents = new Map();

    for (const h of hosts) {
      this.state.set(h.id, {
        id: h.id, name: h.name || h.id, role: h.role || '', kind: h.kind,
        online: false, error: 'not probed yet', at: null,
        cpu: null, mem: null, swap: null, gpu: null, net: null, battery: null,
        disks: [], services: [], alerts: [], status: 'unknown',
      });
      this.history.set(h.id, []);
    }
  }

  start() {
    if (this.timer) return this;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    // A tick that overlaps the previous one doubles the load on every host
    // for no extra freshness; the interval is a floor, not a guarantee.
    if (this.busy) return;
    this.busy = true;
    try {
      await Promise.all(this.hosts.map((h) => this.probeOne(h)));
      this.emit('update', this.snapshot());
    } finally {
      this.busy = false;
    }
  }

  async probeOne(host) {
    const adapter = ADAPTERS[host.kind];
    const prev = this.state.get(host.id);
    let next;
    if (!adapter) {
      next = {
        ...prev, online: false,
        error: `no adapter for kind ${JSON.stringify(host.kind)}`,
        at: this.now(),
      };
    } else {
      try {
        next = await adapter.probe(host);
      } catch (e) {
        next = { ...prev, online: false, error: e.message || String(e), at: this.now() };
      }
    }

    // How many polls in a row each service has been down, and since when.
    // The alert itself is gated by the same hysteresis as every other one
    // (`confirm()` below); these two fields are what the page shows while it
    // is being waited out.
    //
    // A service whose state the host could not determine (`ok: null` — its
    // check timed out, say) is not a service that is down. It keeps whatever
    // it was last seen as: "we did not find out" must neither raise an alert
    // nor reset the clock of one that is already counting.
    if (Array.isArray(next.services) && next.services.length) {
      const before = new Map((prev?.services || []).map((x) => [x.id, x]));
      next.services = next.services.map((svc) => {
        const was = before.get(svc.id);
        const ok = svc.ok == null ? (was?.ok ?? true) : svc.ok;
        if (ok !== false) return { ...svc, ok, downFor: 0, downSince: null };
        return {
          ...svc,
          ok,
          unknown: svc.ok == null || undefined,
          downFor: (was?.downFor || 0) + 1,
          downSince: was?.downSince || this.now(),
        };
      });
    }

    // Always present, whichever way the probe went: the API and the UI should
    // not have to ask whether a field exists before reading it.
    next.graceMs = Number.isFinite(host.graceMs) ? host.graceMs : 0;

    if (next.online) {
      this.lastSeen.set(host.id, this.now());
      next.downSince = null;
      next.failures = 0;
      next.pending = false;
    } else {
      // Keep the last good picture alongside the failure.
      const downSince = prev?.downSince || this.now();
      const graceMs = Number.isFinite(host.graceMs) ? host.graceMs : 0;
      next = {
        ...next,
        cpu: next.cpu ?? prev?.cpu ?? null,
        mem: next.mem ?? prev?.mem ?? null,
        gpu: next.gpu ?? prev?.gpu ?? null,
        disks: next.disks?.length ? next.disks : (prev?.disks || []),
        services: next.services?.length ? next.services : (prev?.services || []),
        stale: true,
        downSince,
        failures: (prev?.failures || 0) + 1,
        // Inside the grace window this is a blip, not an outage: it is shown
        // on the page — you can see the machine is not answering and for how
        // long — but it raises nothing, changes no status, and therefore
        // cannot reach Discord or a phone.
        pending: this.now() - downSince < graceMs,
        graceMs,
      };
    }

    next.lastSeen = this.lastSeen.get(host.id) || null;

    // Counters are only meaningful as differences. A host that reports a
    // cumulative throttle count is throttling if the count moved since the
    // last sample, and is not if it did not, however large the total.
    const prevThrottle = prev?.cpu?.throttled;
    const nowThrottle = next.cpu?.throttled;
    if (Number.isFinite(prevThrottle) && Number.isFinite(nowThrottle) && nowThrottle > prevThrottle) {
      next.cpu = { ...next.cpu, throttlingNow: true, throttledDelta: nowThrottle - prevThrottle };
      next.alerts = [...(next.alerts || []), {
        kind: 'cpu-throttle',
        severity: 'warn',
        text: `${next.name} CPU is throttling`,
        hint: `${nowThrottle - prevThrottle} events since the last sample`,
      }];
    }

    // Muting happens before the roll-up, not at render time: an alert this
    // host was told not to raise must not colour it red, must not flip its
    // status, and therefore must not reach Discord or a phone either.
    const raised = applyMutes(
      [...(next.alerts || []), ...deriveAlerts(next)],
      host.mute,
    );
    // Hysteresis, also before the roll-up and for the same reason: an alert
    // that has not held long enough must not move the status, because a
    // status change is what pings.
    const { confirmed, pending } = this.confirm(host, raised);
    next.alerts = confirmed;
    next.pendingAlerts = pending;
    next.muted = host.mute || [];
    next.status = next.online ? worst(next.alerts) : 'err';

    // A host inside its grace window keeps the status it had. Flipping to
    // warn would be a transition, and a transition is exactly the thing that
    // pings — so "do not alert for brief disconnects" has to mean the status
    // does not move either, not merely that the alert is filtered later.
    if (!next.online && next.pending) {
      next.alerts = next.alerts.filter((a) => a.kind !== 'unreachable');
      next.status = prev?.status && prev.status !== 'unknown' ? prev.status : 'ok';
    }

    // A roaming machine that does not answer is AWAY: a state of its own,
    // neither the green of "fine" nor the red of "come and look". Every alert
    // goes with it, not just `unreachable` — the only readings left are the
    // last ones it sent before it left, and a disk alert computed from a
    // number that is hours old describes a machine that is not there.
    next.away = !next.online && host.roaming === true;
    if (next.away) {
      next.pending = false;
      next.alerts = [];
      next.pendingAlerts = [];
      next.status = 'away';
    }

    const before = prev?.status;
    this.state.set(host.id, next);
    this.pushHistory(host.id, next);
    this.announce(host, next, before);
    return next;
  }

  /**
   * Split raised alerts into the ones that have held long enough to count and
   * the ones still being waited out.
   *
   * An alert counts once it has been raised on `checks` consecutive polls AND
   * the first of those was at least `ms` ago. Both, because either alone is
   * wrong: three polls can be three seconds apart when ticks bunch up, and
   * ninety seconds can be one slow poll. An alert that stops being raised is
   * forgotten at once — recovery is immediate, so the page never shows a
   * problem that is over.
   *
   * `unreachable` is exempt: a host that stops answering has its own, longer
   * grace window (`graceMs`), which has already been applied by now.
   */
  confirm(host, raised) {
    const ms = Number.isFinite(host.sustainMs) ? host.sustainMs : this.sustain.ms;
    const checks = Number.isFinite(host.sustainChecks) ? host.sustainChecks : this.sustain.checks;
    const before = this.alertClock.get(host.id) || new Map();
    const after = new Map();
    const confirmed = [];
    const pending = [];
    const t = this.now();
    for (const a of raised) {
      const key = alertKey(a);
      if (after.has(key)) {                     // two alerts, one key: the first decides
        (after.get(key).confirmed ? confirmed : pending).push(a);
        continue;
      }
      const was = before.get(key);
      const clock = {
        since: was?.since ?? t,
        checks: (was?.checks || 0) + 1,
        confirmed: !!was?.confirmed,
      };
      if (!clock.confirmed) {
        clock.confirmed = a.kind === 'unreachable'
          || (clock.checks >= checks && t - clock.since >= ms);
      }
      after.set(key, clock);
      if (clock.confirmed) confirmed.push(a);
      else pending.push({ ...a, since: clock.since, checks: clock.checks, confirmsAt: clock.since + ms });
    }
    this.alertClock.set(host.id, after);
    return { confirmed, pending };
  }

  /**
   * Turn status changes into announcements — one per INCIDENT, not one per
   * change.
   *
   * An incident opens when a host goes from fine (or away, or not yet known)
   * to warn/err, and that is announced. While it is open, nothing else is,
   * with one exception: a warn incident that becomes err is announced once
   * more, because "degraded" and "in trouble" ask different things of you.
   * err -> warn -> err inside one incident is silent. When the host is back
   * to ok the incident closes, and only an incident that was announced gets a
   * "recovered". A host that leaves (away) closes its incident silently.
   */
  announce(host, next, before) {
    const to = next.status;
    const open = this.incidents.get(host.id);
    const bad = to === 'warn' || to === 'err';
    const emit = (phase, from) => this.emit('transition', { host: next, from, to, phase });

    if (to === 'away') {
      this.incidents.delete(host.id);
      return;
    }
    if (bad && !open) {
      this.incidents.set(host.id, { severity: to, since: this.now() });
      emit('open', before || 'unknown');
      return;
    }
    if (bad && open && to === 'err' && open.severity === 'warn') {
      open.severity = 'err';
      emit('escalate', 'warn');
      return;
    }
    if (to === 'ok' && open) {
      this.incidents.delete(host.id);
      emit('recover', open.severity);
    }
  }

  pushHistory(id, h) {
    const ring = this.history.get(id) || [];
    ring.push({
      t: h.at || this.now(),
      cpu: Number.isFinite(h.cpu?.pct) ? Math.round(h.cpu.pct) : null,
      mem: Number.isFinite(h.mem?.pct) ? Math.round(h.mem.pct) : null,
      gpu: Number.isFinite(h.gpu?.pct) ? Math.round(h.gpu.pct) : null,
      temp: Number.isFinite(h.cpu?.tempC) ? Math.round(h.cpu.tempC) : null,
    });
    while (ring.length > this.historyLength) ring.shift();
    this.history.set(id, ring);
  }

  get(id) { return this.state.get(id) || null; }

  snapshot() {
    const hosts = this.hosts.map((h) => this.state.get(h.id)).filter(Boolean);
    const alerts = hosts.flatMap((h) => (h.alerts || []).map((a) => ({ ...a, host: h.id, hostName: h.name })));
    return {
      at: this.now(),
      hosts,
      alerts,
      status: hosts.length ? worst(alerts.length ? alerts : [{ severity: 'ok' }]) : 'unknown',
      online: hosts.filter((h) => h.online).length,
      away: hosts.filter((h) => h.away).length,
      total: hosts.length,
    };
  }
}

export { ADAPTERS };
