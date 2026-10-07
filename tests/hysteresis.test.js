/**
 * Hysteresis and incidents — the rules that decide whether a blip reaches a
 * phone — plus the storage and OS-name normalisation the host cards rely on.
 *
 * Time is injected: the 90-second window is crossed by moving a clock, not by
 * waiting for it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Poller, ADAPTERS } from '../src/poller.js';
import { Notifier } from '../src/notify.js';
import * as teg from '../src/adapters/teg.js';
import * as loq from '../src/adapters/loq.js';
import {
  HYSTERESIS, alertKey, joinStorage, parentDisk, parseOsRelease, pickOs,
} from '../src/normalize.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', name), 'utf8'));

let scripted = [];
let calls = 0;
ADAPTERS.blippy = {
  async probe(host) {
    const step = scripted[Math.min(calls, scripted.length - 1)];
    calls += 1;
    return { ...step, id: host.id, name: host.name || host.id, kind: 'blippy' };
  },
};

const HOST = { id: 'box', name: 'box', kind: 'blippy' };
const healthy = (over = {}) => ({
  online: true, error: null, at: Date.now(),
  cpu: { pct: 10, tempC: 40 }, mem: { used: 1, total: 10, pct: 10 },
  disks: [], services: [], alerts: [], ...over,
});
const svc = (ok, extra = {}) => healthy({ services: [{ id: 'mtg', name: 'mtg', ok, critical: true, ...extra }] });

/** A poller on a fake clock, stepped every 10 s like the real one. */
function rig(steps, opts = {}) {
  scripted = steps; calls = 0;
  const clock = { t: 10_000_000 };
  const p = new Poller({ hosts: [HOST], intervalMs: 10_000, historyLength: 50, now: () => clock.t, ...opts });
  const pings = [];
  p.on('transition', (x) => pings.push(`${x.phase}:${x.from}->${x.to}`));
  const step = async (n = 1, dt = 10_000) => {
    for (let i = 0; i < n; i += 1) { await p.probeOne(HOST); clock.t += dt; }
    return p.get('box');
  };
  return { p, pings, step, clock };
}

test('the default window is 3 polls spanning 90 s', () => {
  assert.deepEqual(HYSTERESIS, { ms: 90_000, checks: 3 });
});

test('a service that restarts is not an incident', async (t) => {
  await t.test('down for 60 s (six polls) and back: nothing is sent', async () => {
    const { pings, step } = rig([svc(true), svc(false), svc(false), svc(false), svc(false),
      svc(false), svc(false), svc(true)]);
    const mid = await step(4);
    assert.equal(mid.status, 'ok', 'still green while it is being waited out');
    assert.equal(mid.alerts.length, 0);
    assert.equal(mid.pendingAlerts.length, 1, 'but the page can see it');
    assert.equal(mid.pendingAlerts[0].kind, 'service-down');
    assert.ok(mid.services[0].downSince, 'and since when');
    const end = await step(4);
    assert.equal(end.status, 'ok');
    assert.equal(end.pendingAlerts.length, 0, 'recovery forgets it at once');
    assert.deepEqual(pings, []);
  });

  await t.test('down past 90 s is announced once, and recovery is immediate', async () => {
    const steps = [svc(true), ...Array(15).fill(svc(false)), svc(true)];
    const { pings, step } = rig(steps);
    await step(1);                                     // healthy
    let h = await step(9);                             // 0..80 s down
    assert.equal(h.status, 'ok', 'not yet at 80 s');
    h = await step(1);                                 // 90 s
    assert.equal(h.status, 'err', 'confirmed once the first miss is 90 s old');
    assert.equal(h.alerts[0].kind, 'service-down');
    h = await step(5);                                 // still down, still one alert
    h = await step(1);                                 // back
    assert.equal(h.status, 'ok', 'the first good poll clears it');
    assert.deepEqual(pings, ['open:ok->err', 'recover:err->ok']);
  });

  await t.test('flapping down/up/down never accumulates into an alert', async () => {
    const steps = [];
    for (let i = 0; i < 20; i += 1) steps.push(svc(i % 2 === 0));
    const { pings, step } = rig(steps);
    const h = await step(20);
    assert.equal(h.status, 'ok');
    assert.deepEqual(pings, []);
  });

  await t.test('three polls are not enough if they came in a burst', async () => {
    const { step } = rig([svc(true), svc(false), svc(false), svc(false)]);
    await step(1);
    const h = await step(3, 1_000);                    // 3 misses in 3 seconds
    assert.equal(h.status, 'ok');
  });

  await t.test('"could not check" keeps the last known state', async () => {
    // teg reports unit_state "unknown" when its own systemctl call timed out.
    const unknown = svc(null);
    const { step } = rig([svc(true), unknown, unknown, svc(true)]);
    let h = await step(3);
    assert.equal(h.services[0].ok, true, 'unknown after up is still up');
    assert.equal(h.pendingAlerts.length, 0);

    const r = rig([svc(true), ...Array(5).fill(svc(false)), unknown, ...Array(6).fill(svc(false))]);
    h = await r.step(13);
    assert.equal(h.status, 'err', 'an unknown in the middle does not restart the clock');
  });
});

test('other alerts get the same treatment', async (t) => {
  await t.test('a unit that fails and is restarted within the window is silent', async () => {
    const failed = healthy({ alerts: [{ kind: 'unit-failed', severity: 'err', text: 'terraria.service failed' }] });
    const { pings, step } = rig([healthy(), failed, failed, healthy()]);
    await step(4);
    assert.deepEqual(pings, []);
  });

  await t.test('memory wobbling around the line is one problem, keyed without its number', async () => {
    const mem = (pctv) => healthy({ mem: { used: pctv, total: 100, pct: pctv } });
    const { pings, step } = rig([healthy(), mem(94), mem(95), mem(96), mem(94), mem(95),
      mem(97), mem(95), mem(94), mem(96), mem(95), mem(94)]);
    const h = await step(12);
    assert.equal(h.status, 'warn');
    assert.deepEqual(pings, ['open:ok->warn'], 'one incident, not one per number');
  });

  await t.test('unreachable keeps its own grace window and is not double-delayed', async () => {
    const gone = { online: false, error: 'timed out', alerts: [] };
    scripted = [healthy(), gone]; calls = 0;
    const p = new Poller({ hosts: [{ ...HOST, graceMs: 0 }], intervalMs: 10_000 });
    await p.probeOne({ ...HOST, graceMs: 0 });
    await p.probeOne({ ...HOST, graceMs: 0 });
    assert.equal(p.get('box').status, 'err');
  });

  await t.test('per-host override', async () => {
    const { p } = rig([svc(false)]);
    await p.probeOne({ ...HOST, sustainMs: 0, sustainChecks: 1 });
    assert.equal(p.get('box').status, 'err');
  });
});

test('one announcement per incident', async (t) => {
  const NOW = { ms: 0, checks: 1 };
  const warnOnly = healthy({ mem: { used: 95, total: 100, pct: 95 } });
  const errToo = healthy({ mem: { used: 95, total: 100, pct: 95 }, disks: [{ label: '/', pct: 99 }] });

  await t.test('err -> warn -> err inside one incident is silent', async () => {
    const { pings, step } = rig([healthy(), errToo, warnOnly, errToo, warnOnly, healthy()], { sustain: NOW });
    await step(6);
    assert.deepEqual(pings, ['open:ok->err', 'recover:err->ok']);
  });

  await t.test('warn that becomes err is told once more, then nothing', async () => {
    const { pings, step } = rig([healthy(), warnOnly, errToo, warnOnly, errToo, healthy()], { sustain: NOW });
    await step(6);
    assert.deepEqual(pings, ['open:ok->warn', 'escalate:warn->err', 'recover:err->ok']);
  });

  await t.test('the notifier never says "recovered" about a break it did not report', async () => {
    const sent = [];
    const n = new Notifier({
      webhook: 'https://example.invalid/hook',
      cooldownMs: 60_000,
      fetchImpl: async (url, o) => { sent.push(JSON.parse(o.body).embeds[0].title); return { ok: true }; },
    });
    const host = { id: 'x', name: 'box', alerts: [{ severity: 'err', text: 'down' }] };
    // An incident that opened from "unknown" (fleet just started) was not sent…
    await n.transition({ host, from: 'unknown', to: 'err' });
    // …so its recovery is not either.
    await n.transition({ host: { ...host, alerts: [] }, from: 'err', to: 'ok' });
    assert.deepEqual(sent, []);
    // A second incident inside the cooldown is suppressed — and so is its recovery.
    await n.transition({ host, from: 'ok', to: 'err' });
    await n.transition({ host, from: 'err', to: 'ok' });
    await n.transition({ host, from: 'ok', to: 'err' });
    await n.transition({ host, from: 'err', to: 'ok' });
    assert.equal(sent.length, 2);
    assert.match(sent[0], /trouble/);
    assert.match(sent[1], /healthy again/);
  });
});

test('alert keys', () => {
  assert.equal(alertKey({ kind: 'memory', text: 'box memory at 94%' }),
    alertKey({ kind: 'memory', text: 'box memory at 96.5%' }));
  assert.notEqual(alertKey({ kind: 'unit-failed', text: 'a.service failed' }),
    alertKey({ kind: 'unit-failed', text: 'b.service failed' }));
  assert.equal(alertKey({ kind: 'x', key: 'mine', text: '1' }), 'mine');
});

test('os-release', async (t) => {
  await t.test('PRETTY_NAME, quoted', () => {
    assert.equal(parseOsRelease('NAME="Zorin OS"\nVERSION="18.1"\nPRETTY_NAME="Zorin OS 18.1"\n'), 'Zorin OS 18.1');
  });
  await t.test('bare and single-quoted values, comments, escapes', () => {
    assert.equal(parseOsRelease("# comment\nPRETTY_NAME='Ubuntu 24.04.1 LTS'"), 'Ubuntu 24.04.1 LTS');
    assert.equal(parseOsRelease('PRETTY_NAME=Debian'), 'Debian');
    assert.equal(parseOsRelease('PRETTY_NAME="My \\"Box\\" 1"'), 'My "Box" 1');
  });
  await t.test('NAME + VERSION when PRETTY_NAME is missing or just "Linux"', () => {
    assert.equal(parseOsRelease('NAME="Zorin OS"\nVERSION="17.2"'), 'Zorin OS 17.2');
    assert.equal(parseOsRelease('PRETTY_NAME="Linux"\nNAME=Arch\nVERSION_ID=rolling'), 'Arch rolling');
  });
  await t.test('nothing usable is null, not "Linux"', () => {
    assert.equal(parseOsRelease(''), null);
    assert.equal(parseOsRelease(null), null);
  });
  await t.test('a distribution name beats a kernel string', () => {
    assert.equal(pickOs('Ubuntu 24.04.1 LTS', 'Linux 7.0.0-31-generic'), 'Ubuntu 24.04.1 LTS');
    assert.equal(pickOs(null, 'Linux 7.0.0-31-generic', 'Zorin OS 18.1'), 'Zorin OS 18.1');
    assert.equal(pickOs(null, 'Linux 7.0.0-31-generic'), 'Linux 7.0.0-31-generic');
    assert.equal(pickOs(undefined, ''), null);
  });
});

test('storage', async (t) => {
  await t.test('partition -> disk', () => {
    assert.equal(parentDisk('/dev/sda3'), 'sda');
    assert.equal(parentDisk('/dev/nvme1n1p2'), 'nvme1n1');
    assert.equal(parentDisk('/dev/mmcblk0p1'), 'mmcblk0');
    assert.equal(parentDisk('/dev/sdb'), 'sdb');
  });

  await t.test('filesystems get their disk model; unmounted disks are kept', () => {
    const { disks, drives } = joinStorage(
      [{ mount: '/', device: '/dev/sda1' }, { mount: '/home', device: '/dev/sda3' }],
      [{ device: 'sda', model: 'ST2000DM001' }, { device: 'sdb', model: 'SK hynix SC311' }],
    );
    assert.deepEqual(disks.map((d) => d.model), ['ST2000DM001', 'ST2000DM001']);
    assert.deepEqual(drives.map((d) => [d.device, d.mounted]), [['sda', true], ['sdb', false]]);
  });

  await t.test('teg: Ubuntu, not the kernel; / and /home; the spare SSD as not mounted', async () => {
    const routes = {
      '/api/stats': fixture('teg-stats.json'),
      '/api/disks': fixture('teg-disks.json'),
      '/api/hardware': fixture('teg-hardware.json'),
    };
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const { pathname } = new URL(url);
      if (!(pathname in routes)) return { ok: false, status: 404, statusText: 'nf', json: async () => ({}) };
      return { ok: true, status: 200, statusText: 'OK', json: async () => routes[pathname] };
    };
    try {
      const h = await teg.probe({ id: 'disinteg', kind: 'teg', origin: 'https://example.invalid' });
      assert.equal(h.os, 'Ubuntu 24.04.1 LTS');
      assert.ok(h.disks.every((d) => d.model), 'every filesystem names its disk');
      const sdb = h.drives.find((d) => d.device === 'sdb');
      assert.equal(sdb.mounted, false);
      assert.match(sdb.model, /SK hynix/);
      assert.equal(h.drives.find((d) => d.device === 'sda').mounted, true);
    } finally { globalThis.fetch = real; }
  });

  await t.test('teg: a check that threw is unknown, not down', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const { pathname } = new URL(url);
      const body = {
        '/api/stats': fixture('teg-stats.json'),
        '/api/services': {
          a: { desc: 'a', active: false, unit_state: 'unknown' },
          b: { desc: 'b', active: false, unit_state: 'inactive' },
        },
      }[pathname];
      return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => ({}) };
    };
    try {
      const h = await teg.probe({ id: 'd', kind: 'teg', origin: 'https://example.invalid' });
      assert.equal(h.services.find((s) => s.id === 'a').ok, null);
      assert.equal(h.services.find((s) => s.id === 'b').ok, false);
    } finally { globalThis.fetch = real; }
  });

  await t.test('loq: mounts and os from a sampler that reports them', async () => {
    const state = {
      ...fixture('loq-state.json'),
      os: 'Zorin OS 18.1',
      mounts: [
        { mount: '/', device: '/dev/nvme0n1p2', disk: 'nvme0n1', fstype: 'ext4', total: 500, used: 400, free: 50 },
        { mount: '/media/ojee/SSD', device: '/dev/sda1', disk: 'sda', fstype: 'fuseblk', total: 480, used: 280, free: 200 },
      ],
    };
    const real = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => state });
    try {
      const h = await loq.probe({ id: 'loq', kind: 'loq', origin: 'http://example.invalid' });
      assert.equal(h.os, 'Zorin OS 18.1');
      assert.deepEqual(h.disks.map((d) => d.mount), ['/', '/media/ojee/SSD']);
      assert.equal(h.disks[0].pct, 80);
    } finally { globalThis.fetch = real; }
  });
});
