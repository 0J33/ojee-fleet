/**
 * The link to ojee-remote — screen, shell and files for the same machines.
 *
 * Machines and Remote used to be two modules that named the same three
 * computers three different ways. Remote now has no page of its own: its
 * gateway keeps doing what only it can (H.264 streams, guacd, ssh, sftp), and
 * this file reads its device list so a host card here can say whether each
 * way in is up, whether the screen is locked, which OS a dual-boot machine is
 * running, and offer "Reboot to Windows".
 *
 * Which remote devices belong to which host is config, not guesswork:
 *
 *     { "id": "loq", ..., "remote": ["loq-linux", "loq-windows"] }
 *
 * The gateway is polled from the server, never from the browser, so every
 * open page reads the same answer and a dead gateway costs one timeout per
 * interval, not one per viewer.
 */

const TIMEOUT_MS = 6000;

export class RemoteLink {
  constructor({ origin, hosts, intervalMs = 15_000, lockEveryMs = 30_000, fetchImpl = fetch, now = Date.now }) {
    this.origin = origin ? String(origin).replace(/\/+$/, '') : '';
    this.hosts = hosts;
    this.intervalMs = intervalMs;
    this.lockEveryMs = lockEveryMs;
    this.fetch = fetchImpl;
    this.now = now;
    /** device id -> sanitized device as the gateway publishes it */
    this.devices = new Map();
    /** device id -> {locked, at} */
    this.locks = new Map();
    this.error = null;
    this.at = null;
    this.timer = null;
  }

  get enabled() { return !!this.origin; }

  start() {
    if (!this.enabled || this.timer) return this;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async call(path, opts = {}) {
    const res = await this.fetch(`${this.origin}${path}`, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
      signal: AbortSignal.timeout(opts.timeoutMs || TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(body.detail || body.error || `${res.status}`);
      e.status = res.status;
      throw e;
    }
    return body;
  }

  async tick() {
    try {
      const { devices = [] } = await this.call('/api/devices');
      this.devices = new Map(devices.map((d) => [d.id, d]));
      this.error = null;
      this.at = this.now();
    } catch (e) {
      // Keep the last list: a gateway restart must not make every machine
      // lose its Screen button for a poll.
      this.error = e.message;
      return;
    }
    // Lock state only for agent devices that answer: an RDP-only or offline
    // device has no agent to ask, and asking would cost a timeout each.
    const wanted = new Set(this.hosts.flatMap((h) => h.remote || []));
    await Promise.all([...this.devices.values()]
      .filter((d) => wanted.has(d.id) && d.hasAgent && d.online)
      .filter((d) => this.now() - (this.locks.get(d.id)?.at || 0) >= this.lockEveryMs)
      .map(async (d) => {
        try {
          const st = await this.call(`/api/devices/${encodeURIComponent(d.id)}/lock`);
          this.locks.set(d.id, { locked: typeof st.locked === 'boolean' ? st.locked : null, at: this.now() });
        } catch {
          this.locks.set(d.id, { locked: null, at: this.now() });
        }
      }));
  }

  /**
   * What a host card needs: its ways in, which one is running now (for a
   * dual boot), and whether that one's screen is locked.
   */
  forHost(host) {
    const ids = host.remote || [];
    if (!this.enabled || !ids.length) return null;
    const list = ids.map((id) => this.devices.get(id)).filter(Boolean).map((d) => ({
      id: d.id,
      name: d.name,
      os: d.os || guessOs(d),
      transport: d.transport,
      screen: d.transport !== 'ssh',
      shell: !!d.hasShell,
      online: d.online ?? null,
      shellOnline: d.shellOnline ?? null,
      latencyMs: d.latencyMs ?? null,
      boot: d.boot || null,
      locked: d.online ? (this.locks.get(d.id)?.locked ?? null) : null,
    }));
    // The running half of a dual boot is the one that answers.
    const live = list.find((d) => d.online || d.shellOnline) || null;
    return {
      devices: list,
      current: live?.id || null,
      os: live?.os || null,
      locked: live?.locked ?? null,
      error: this.error,
      checkedAt: this.at,
    };
  }

  /** Reboot a host into its other OS through the device that is running now. */
  async boot(host, to) {
    const r = this.forHost(host);
    if (!r) throw Object.assign(new Error('this host has no remote devices'), { status: 501 });
    const from = r.devices.find((d) => (d.online || d.shellOnline) && d.boot && (!to || d.boot.to === to || (this.devices.get(d.boot.to)?.os || guessOs({ id: d.boot.to, name: '' })) === to));
    if (!from) throw Object.assign(new Error(`nothing running on ${host.name || host.id} can switch to ${to || 'the other OS'}`), { status: 409 });
    return this.call(`/api/devices/${encodeURIComponent(from.id)}/boot`, {
      method: 'POST', body: JSON.stringify({ confirm: true }), timeoutMs: 25_000,
    });
  }
}

/** Older gateways do not publish `os`: the device id or name usually says. */
function guessOs(d) {
  const s = `${d.id} ${d.name}`.toLowerCase();
  if (/windows|win\b/.test(s)) return 'windows';
  if (/linux|zorin|ubuntu|debian/.test(s)) return 'linux';
  return null;
}
