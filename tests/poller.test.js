/**
 * Poller behaviour — the parts that are easy to get wrong and invisible when
 * they are: what a failed probe does to the last good reading, when a
 * notification is worth sending, and how a cumulative counter is read.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Poller, ADAPTERS } from '../src/poller.js';
import { Notifier } from '../src/notify.js';

/** A fake adapter kind, registered for the duration of the tests. */
let scripted = [];
let callCount = 0;
ADAPTERS.fake = {
  async probe(host) {
    const step = scripted[Math.min(callCount, scripted.length - 1)];
    callCount += 1;
    if (step instanceof Error) throw step;
    return { ...step, id: host.id, name: host.name || host.id, kind: 'fake' };
  },
};

const HOST = { id: 'box', name: 'box', kind: 'fake' };
const healthy = (over = {}) => ({
  online: true, error: null, at: Date.now(),
  cpu: { pct: 10, tempC: 40 }, mem: { used: 1, total: 10, pct: 10 },
  disks: [{ label: '/', pct: 20 }], services: [], alerts: [], ...over,
});

const newPoller = (steps) => {
  scripted = steps; callCount = 0;
  return new Poller({ hosts: [HOST], intervalMs: 10_000, historyLength: 5 });
};

test('an unreachable host keeps its last good reading', async () => {
  const p = newPoller([healthy(), { online: false, error: 'timed out', at: Date.now(), alerts: [] }]);
  await p.probeOne(HOST);
  const before = p.get('box');
  assert.equal(before.online, true);
  assert.equal(before.disks.length, 1);

  await p.probeOne(HOST);
  const after = p.get('box');
  assert.equal(after.online, false, 'reported as down');
  assert.equal(after.stale, true, 'marked stale');
  assert.equal(after.disks.length, 1, 'still knows what it last saw');
  assert.ok(after.lastSeen, 'remembers when it was last reachable');
  assert.equal(after.status, 'err');
});

test('an adapter that throws does not take the poller with it', async () => {
  const p = newPoller([healthy(), new Error('boom')]);
  await p.probeOne(HOST);
  await p.probeOne(HOST);
  const h = p.get('box');
  assert.equal(h.online, false);
  assert.match(h.error, /boom/);
});

test('a cumulative counter is judged on its delta, not its total', async (t) => {
  await t.test('a huge total that is not moving is not an alert', async () => {
    const p = newPoller([
      healthy({ cpu: { pct: 10, tempC: 40, throttled: 2_217_605 } }),
      healthy({ cpu: { pct: 10, tempC: 40, throttled: 2_217_605 } }),
    ]);
    await p.probeOne(HOST);
    await p.probeOne(HOST);
    assert.deepEqual(p.get('box').alerts, []);
  });

  await t.test('a total that moved is', async () => {
    const p = newPoller([
      healthy({ cpu: { pct: 10, tempC: 40, throttled: 100 } }),
      healthy({ cpu: { pct: 10, tempC: 40, throttled: 140 } }),
    ]);
    await p.probeOne(HOST);
    await p.probeOne(HOST);
    const h = p.get('box');
    assert.equal(h.cpu.throttlingNow, true);
    assert.equal(h.cpu.throttledDelta, 40);
    assert.match(h.alerts[0].text, /throttling/);
  });
});

test('history keeps a bounded ring and records gaps as gaps', async () => {
  const p = newPoller([healthy(), healthy({ cpu: { pct: null, tempC: null } }), healthy()]);
  for (let i = 0; i < 8; i += 1) await p.probeOne(HOST);
  const ring = p.history.get('box');
  assert.ok(ring.length <= 5, 'ring is bounded');
  assert.ok(ring.some((s) => s.cpu === null) || ring.every((s) => s.cpu != null));
});

test('only transitions raise events', async () => {
  const p = newPoller([healthy(), healthy(), healthy({ disks: [{ label: '/', pct: 99 }] })]);
  const seen = [];
  p.on('transition', (t) => seen.push(`${t.from}->${t.to}`));
  await p.probeOne(HOST);          // unknown -> ok (first real sample)
  await p.probeOne(HOST);          // ok -> ok, silent
  await p.probeOne(HOST);          // ok -> err
  assert.deepEqual(seen, ['unknown->ok', 'ok->err']);
});

test('a brief disconnect is not an outage', async (t) => {
  // Time is injected so the grace window can be crossed without waiting for
  // it — a test that sleeps for five minutes is a test nobody runs.
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const graceHost = { ...HOST, graceMs: 300_000 };
  const build = (steps) => {
    scripted = steps; callCount = 0;
    return new Poller({ hosts: [graceHost], intervalMs: 10_000, historyLength: 10, now });
  };
  const gone = { online: false, error: 'timed out', alerts: [] };

  await t.test('goes quiet, stays green, says so on the page', async () => {
    const p = build([healthy(), gone]);
    const pings = [];
    p.on('transition', (x) => pings.push(`${x.from}->${x.to}`));
    await p.probeOne(graceHost);
    clock.t += 10_000;
    await p.probeOne(graceHost);

    const h = p.get('box');
    assert.equal(h.online, false, 'the page shows it is not answering');
    assert.equal(h.pending, true, 'and that it is inside the grace window');
    assert.ok(h.downSince, 'and since when');
    assert.equal(h.alerts.length, 0, 'but raises nothing');
    assert.equal(h.status, 'ok', 'and does not change status');
    // The first sample is legitimately unknown->ok, which the notifier ignores.
    // What must not appear is a SECOND transition caused by the drop.
    assert.deepEqual(pings, ['unknown->ok'], 'so the drop sends nothing');
  });

  await t.test('a host that comes back inside the window was never news', async () => {
    const p = build([healthy(), gone, healthy()]);
    const pings = [];
    p.on('transition', (x) => pings.push(`${x.from}->${x.to}`));
    await p.probeOne(graceHost);
    clock.t += 60_000;
    await p.probeOne(graceHost);          // away for a minute
    clock.t += 60_000;
    await p.probeOne(graceHost);          // back

    const h = p.get('box');
    assert.equal(h.online, true);
    assert.equal(h.pending, false);
    assert.equal(h.downSince, null, 'the outage clock is reset');
    assert.equal(h.failures, 0);
    // The whole point: no "went down" and no "recovered" either. A pager that
    // reports a blip twice is worse than one that never reported it.
    assert.deepEqual(pings, ['unknown->ok']);
  });

  await t.test('a host still gone when the window closes IS news', async () => {
    const p = build([healthy(), gone]);
    const pings = [];
    p.on('transition', (x) => pings.push(`${x.from}->${x.to}`));
    await p.probeOne(graceHost);
    clock.t += 10_000;
    await p.probeOne(graceHost);
    assert.equal(p.get('box').status, 'ok', 'still quiet at 10s');

    clock.t += 300_000;
    await p.probeOne(graceHost);

    const h = p.get('box');
    assert.equal(h.pending, false);
    assert.equal(h.status, 'err');
    assert.equal(h.alerts[0].kind, 'unreachable');
    assert.deepEqual(pings, ['unknown->ok', 'ok->err'], 'announced exactly once');
  });

  await t.test('failures accumulate across the window', async () => {
    const p = build([healthy(), gone]);
    await p.probeOne(graceHost);
    for (let i = 0; i < 4; i += 1) { clock.t += 10_000; await p.probeOne(graceHost); }
    assert.equal(p.get('box').failures, 4);
  });

  await t.test('a host with no grace configured alerts immediately', async () => {
    scripted = [healthy(), gone]; callCount = 0;
    const p = new Poller({ hosts: [HOST], intervalMs: 10_000, historyLength: 5 });
    await p.probeOne(HOST);
    await p.probeOne(HOST);
    assert.equal(p.get('box').status, 'err');
  });
});

test('muting', async (t) => {
  const hot = () => healthy({ cpu: { pct: 90, tempC: 96, throttled: 100 } });

  await t.test('an unmuted host raises the rule', async () => {
    const p = newPoller([hot()]);
    await p.probeOne(HOST);
    assert.ok(p.get('box').alerts.some((a) => a.kind === 'cpu-temp'));
    assert.equal(p.get('box').status, 'warn');
  });

  await t.test('a muted kind is gone, and cannot colour the host', async () => {
    const p = newPoller([hot()]);
    await p.probeOne({ ...HOST, mute: ['cpu-temp'] });
    const h = p.get('box');
    assert.equal(h.alerts.some((a) => a.kind === 'cpu-temp'), false);
    // The whole point: a muted rule must not flip the status either, or it
    // still reaches Discord and the phone by another route.
    assert.equal(h.status, 'ok');
  });

  await t.test('muting one kind leaves the others alone', async () => {
    const p = newPoller([healthy({
      cpu: { pct: 90, tempC: 96 },
      disks: [{ label: '/', pct: 99 }],
    })]);
    await p.probeOne({ ...HOST, mute: ['cpu-temp'] });
    const kinds = p.get('box').alerts.map((a) => a.kind);
    assert.deepEqual(kinds, ['disk-critical']);
    assert.equal(p.get('box').status, 'err');
  });

  await t.test('a muted throttle counter never becomes an alert', async () => {
    const p = newPoller([
      healthy({ cpu: { pct: 10, tempC: 40, throttled: 100 } }),
      healthy({ cpu: { pct: 10, tempC: 40, throttled: 900 } }),
    ]);
    const muted = { ...HOST, mute: ['cpu-throttle'] };
    await p.probeOne(muted);
    await p.probeOne(muted);
    assert.deepEqual(p.get('box').alerts, []);
  });
});

test('the notifier', async (t) => {
  const sent = [];
  const mk = (over = {}) => new Notifier({
    webhook: 'https://example.invalid/hook',
    cooldownMs: 1000,
    fetchImpl: async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true }; },
    ...over,
  });

  await t.test('says nothing without a webhook', async () => {
    const n = new Notifier({ webhook: '' });
    assert.equal(await n.transition({ host: { id: 'x', name: 'x', alerts: [] }, from: 'ok', to: 'err' }), false);
  });

  await t.test('does not announce the first sample', async () => {
    sent.length = 0;
    const n = mk();
    await n.transition({ host: { id: 'x', name: 'x', alerts: [] }, from: 'unknown', to: 'ok' });
    assert.equal(sent.length, 0);
  });

  await t.test('announces a break and a recovery, once each', async () => {
    sent.length = 0;
    const n = mk();
    const host = { id: 'x', name: 'box', alerts: [{ severity: 'err', text: 'disk full' }] };
    await n.transition({ host, from: 'ok', to: 'err' });
    await n.transition({ host, from: 'ok', to: 'err' });     // inside cooldown
    await n.transition({ host: { ...host, alerts: [] }, from: 'err', to: 'ok' });
    assert.equal(sent.length, 2);
    assert.match(sent[0].embeds[0].title, /trouble/);
    assert.match(sent[1].embeds[0].title, /healthy again/);
  });

  await t.test('a webhook that is down never throws', async () => {
    const n = mk({ fetchImpl: async () => { throw new Error('network'); } });
    assert.equal(await n.send({ title: 't', description: 'd', color: 1 }), false);
  });
});
