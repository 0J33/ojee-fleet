/**
 * Machines (2026-11 redesign): persisted history, heat held over time,
 * summary rows with stable alert keys, the ojee-remote link.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HistoryStore } from '../src/history.js';
import { buildSummary, decorate, applyPrefs, alertKey, ALERT_KINDS_MANIFEST } from '../src/summary.js';
import { RemoteLink } from '../src/remote.js';
import { Poller } from '../src/poller.js';
import { parseSwaps } from '../src/adapters/local.js';

const host = (over = {}) => ({
  id: 'loq', name: 'LOQ', online: true, status: 'ok', at: Date.now(),
  cpu: { pct: 50, tempC: 70 }, mem: { used: 8e9, total: 24e9, pct: 33 }, swap: { used: 0, total: 1e9 },
  gpu: null, disks: [], services: [], alerts: [], ...over,
});

test('history: a minute is averaged, its peak temperature kept, and it survives a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-hist-'));
  const file = path.join(dir, 'history.json');
  let t = Date.UTC(2026, 10, 26, 12, 0, 5);
  const s = new HistoryStore({ file, now: () => t });
  s.add('loq', host({ cpu: { pct: 10, tempC: 70 } }), t);
  s.add('loq', host({ cpu: { pct: 30, tempC: 98 } }), t + 10_000);
  t += 60_000;
  s.add('loq', host({ cpu: { pct: 20, tempC: 60 } }), t);   // closes the first minute
  s.save();
  const again = new HistoryStore({ file, now: () => t });
  const [p] = again.series('loq', 3600_000);
  assert.equal(p.cpu, 20);
  assert.equal(p.temp, 84);
  assert.equal(p.tempMax, 98);
});

test('history: heldAbove counts back only while the line is held', () => {
  let t = Date.UTC(2026, 10, 26, 12, 0, 0);
  const s = new HistoryStore({ now: () => t });
  const temps = [80, 96, 97, 96, 98, 99, 97];
  for (const c of temps) { s.add('loq', host({ cpu: { pct: 1, tempC: c } }), t); t += 60_000; }
  t -= 60_000;
  assert.equal(Math.round(s.heldAbove('loq', 'temp', 95) / 60_000), 5);
  assert.equal(s.heldAbove('loq', 'temp', 99.5), 0);
});

test('heat: a CPU at 96 °C raises nothing until held for the hold time, then warn AND critical', async () => {
  let t = 1_000_000;
  const p = new Poller({ hosts: [], now: () => t });
  const h = { id: 'loq', name: 'LOQ', kind: 'fake', limits: { heatHoldMs: 120_000 } };
  p.hosts = [h];
  p.state.set('loq', { id: 'loq', name: 'LOQ', status: 'unknown', alerts: [] });
  p.history.set('loq', []);
  const { ADAPTERS } = await import('../src/poller.js');
  ADAPTERS.fake = { probe: async () => host({ cpu: { pct: 90, tempC: 96 }, at: t }) };
  await p.probeOne(h); t += 60_000;
  await p.probeOne(h);
  assert.equal(p.get('loq').alerts.length, 0);
  t += 61_000;
  await p.probeOne(h);
  const kinds = p.get('loq').alerts.map((a) => a.kind).filter((k) => k !== 'stale').sort();
  assert.deepEqual(kinds, ['cpu-temp', 'cpu-temp-critical']);
  assert.equal(p.get('loq').status, 'err');
  delete ADAPTERS.fake;
});

test('summary: rows per host, four metrics each, no 3D model, one critical heat item with a stable key', () => {
  const s = {
    at: Date.now(), total: 2, online: 2, status: 'err',
    hosts: [
      host({ status: 'err', limits: { cpuTempC: 90, cpuCritC: 95, tempWarnC: 80, tempErrC: 90 },
        alerts: [
          { kind: 'cpu-temp', severity: 'warn', key: 'cpu-temp', text: 'LOQ CPU at 98 °C' },
          { kind: 'cpu-temp-critical', severity: 'err', blocking: true, key: 'cpu-temp-critical', text: 'LOQ CPU at 98 °C' },
        ],
        cpu: { pct: 70, tempC: 98 } }),
      host({ id: 'hp', name: 'HP', services: [{ id: 'caddy', name: 'caddy', ok: false }],
        alerts: [{ kind: 'service-down', severity: 'warn', service: 'caddy', text: 'caddy is not running on HP' }] }),
    ],
  };
  s.alerts = s.hosts.flatMap((h) => h.alerts.map((a) => ({ ...a, host: h.id })));
  const out = buildSummary(decorate(s));
  assert.equal(out.model, undefined);
  assert.equal(out.rows.length, 2);
  for (const r of out.rows) assert.equal(r.metrics.length, 4);
  assert.equal(out.metrics.length, 4);
  assert.equal(out.rows[0].metrics[1].state, 'err');
  assert.deepEqual(out.alerts.map((a) => a.key), ['fleet.cpu-temp-critical.loq', 'fleet.service-down.hp.caddy']);
  assert.equal(out.alerts[0].blocking, true);
  for (const a of out.alerts) assert.doesNotMatch(a.key, /\d/);
});

test('alert keys never carry numbers, and disks key by mount', () => {
  assert.equal(alertKey({ kind: 'disk', key: 'disk:/home' }, 'hp'), 'fleet.disk.hp./home');
  assert.equal(alertKey({ kind: 'memory', text: 'HP memory at 95%' }, 'hp'), 'fleet.memory.hp');
});

test('manifest: every kind declared once, with a default channel; console thresholds map onto limits', () => {
  const kinds = ALERT_KINDS_MANIFEST.map((k) => k.kind);
  assert.equal(new Set(kinds).size, kinds.length);
  for (const k of ALERT_KINDS_MANIFEST) assert.ok(['toast', 'inbox', 'off'].includes(k.channel));
  assert.deepEqual(
    applyPrefs({ 'fleet.cpu-temp': { thresholds: { cpuTempC: 92, heatHoldMin: 10 } }, 'fleet.unreachable': { threshold: 5 } }),
    { cpuTempC: 92, heatHoldMs: 600_000, graceMs: 300_000 },
  );
});

test('remote link: the dual-boot half that answers is the OS, its lock is read, boot goes through it', async () => {
  const calls = [];
  const devices = [
    { id: 'loq-linux', name: 'LOQ · Linux', os: 'linux', transport: 'agent', hasAgent: true, hasShell: true, online: true, shellOnline: true, boot: { to: 'loq-windows', label: 'Reboot to Windows' } },
    { id: 'loq-windows', name: 'LOQ · Windows', os: 'windows', transport: 'rdp', online: false },
  ];
  const fetchImpl = async (url, opts = {}) => {
    calls.push([opts.method || 'GET', url]);
    const body = url.endsWith('/api/devices') ? { devices } : url.endsWith('/lock') ? { locked: true } : { ok: true };
    return { ok: true, status: 200, json: async () => body };
  };
  const hosts = [{ id: 'loq', name: 'LOQ', remote: ['loq-linux', 'loq-windows'] }];
  const r = new RemoteLink({ origin: 'http://remote', hosts, fetchImpl });
  await r.tick();
  const f = r.forHost(hosts[0]);
  assert.equal(f.os, 'linux');
  assert.equal(f.locked, true);
  await r.boot(hosts[0], 'windows');
  assert.deepEqual(calls.at(-1), ['POST', 'http://remote/api/devices/loq-linux/boot']);
  await assert.rejects(r.boot(hosts[0], 'linux'), /can switch/);
});

test('zram is told apart from swap on disk', () => {
  const z = parseSwaps('Filename Type Size Used Priority\n/swapfile file 41943036 0 -1\n/dev/zram0 partition 16777212 340 5\n');
  assert.deepEqual(z, { used: 340 * 1024, total: 16777212 * 1024 });
});

test('muteServices takes a prefix: a compose project switched off on purpose', async () => {
  const { applyMutes } = await import('../src/normalize.js');
  const alerts = [{ kind: 'service-down', service: 'odysseus-ntfy-1' }, { kind: 'service-down', service: 'caddy' }];
  assert.deepEqual(applyMutes(alerts, [], ['odysseus-*']).map((a) => a.service), ['caddy']);
});
