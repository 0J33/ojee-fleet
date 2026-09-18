/**
 * Pings, when a machine changes its mind about being healthy.
 *
 * Two rules, both about not becoming noise:
 *
 *   - Only TRANSITIONS are sent. "disinteg went from ok to err" is news;
 *     "disinteg is still err" is not, and a monitor that repeats itself every
 *     ten seconds is a monitor whose messages get muted, which is strictly
 *     worse than one that never sent them.
 *
 *   - A recovery is sent too. A pager that only ever tells you about breakage
 *     leaves you refreshing a page to find out whether it is over.
 */

const COLORS = { ok: 0x00c980, warn: 0xffb020, err: 0xff4444, unknown: 0x8b8b9a };

export class Notifier {
  constructor({ webhook, cooldownMs = 30 * 60 * 1000, fetchImpl = fetch, now = Date.now } = {}) {
    this.webhook = webhook || '';
    this.cooldownMs = cooldownMs;
    this.fetch = fetchImpl;
    this.now = now;
    this.lastSent = new Map();          // tag -> timestamp
  }

  get enabled() { return !!this.webhook; }

  /** True when this tag has not been sent inside the cooldown window. */
  allow(tag) {
    const last = this.lastSent.get(tag) || 0;
    if (this.now() - last < this.cooldownMs) return false;
    this.lastSent.set(tag, this.now());
    return true;
  }

  async transition({ host, from, to }) {
    if (!this.enabled) return false;
    // Recovering from "we have not asked yet" is not an event.
    if (from === 'unknown' || !from) return false;
    const tag = `${host.id}:${to}`;
    if (!this.allow(tag)) return false;

    const worstAlert = (host.alerts || []).find((a) => a.severity === to);
    const title = to === 'ok'
      ? `${host.name} is healthy again`
      : `${host.name} is ${to === 'err' ? 'in trouble' : 'degraded'}`;
    const lines = (host.alerts || []).slice(0, 6)
      .map((a) => `• ${a.text}${a.hint ? ` — ${a.hint}` : ''}`);

    return this.send({
      title,
      description: lines.length ? lines.join('\n') : (worstAlert?.text || 'No details reported.'),
      color: COLORS[to] ?? COLORS.unknown,
      footer: `${host.role || host.kind} · was ${from}`,
    });
  }

  async send({ title, description, color, footer }) {
    try {
      const res = await this.fetch(this.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'fleet',
          embeds: [{
            title,
            description: description.slice(0, 3900),
            color,
            footer: footer ? { text: footer.slice(0, 2000) } : undefined,
            timestamp: new Date(this.now()).toISOString(),
          }],
        }),
      });
      return res.ok;
    } catch {
      // A webhook that is down must never take the module with it.
      return false;
    }
  }
}
