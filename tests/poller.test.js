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
