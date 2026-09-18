/**
 * Adapter tests, against payloads captured from the real machines.
 *
 * Fixtures rather than mocks I wrote from the docs: every one of these files
 * came out of the actual API, so a field that is spelled differently from how
 * I remembered, or reported as a string where I assumed a number, fails here
 * rather than rendering as "—" in production and being blamed on the host.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as teg from '../src/adapters/teg.js';
import * as agent from '../src/adapters/agent.js';
import * as loq from '../src/adapters/loq.js';
import { deriveAlerts, LIMITS, pct, worst } from '../src/normalize.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', name), 'utf8'));

/** A fetch that answers from the fixture set and 404s anything unexpected. */
const fakeFetch = (routes) => async (url) => {
  const { pathname } = new URL(url);
  if (!(pathname in routes)) {
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
  }
  const body = routes[pathname];
  if (body instanceof Error) throw body;
  return { ok: true, status: 200, statusText: 'OK', json: async () => body };
};

const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
};

test('teg adapter — disinteg', async (t) => {
  const routes = {
    '/api/stats': fixture('teg-stats.json'),
    '/api/disks': fixture('teg-disks.json'),
    '/api/checks': fixture('teg-checks.json'),
    '/api/services': fixture('teg-services.json'),
  };
  const host = { id: 'disinteg', name: 'disinteg', kind: 'teg', origin: 'https://example.invalid', token: 'x' };
  const h = await withFetch(fakeFetch(routes), () => teg.probe(host));

  await t.test('reports the host as up with real numbers', () => {
    assert.equal(h.online, true);
    assert.equal(h.id, 'disinteg');
    assert.ok(Number.isFinite(h.cpu.pct), 'cpu percentage');
    assert.ok(h.cpu.pct >= 0 && h.cpu.pct <= 100);
    assert.ok(Number.isFinite(h.mem.total) && h.mem.total > 0, 'memory total');
    assert.ok(Number.isFinite(h.uptime) && h.uptime > 0, 'uptime');
  });

  await t.test('lists real filesystems, each with a usable percentage', () => {
    assert.ok(h.disks.length > 0, 'at least one filesystem');
    for (const d of h.disks) {
      assert.ok(d.label, 'every disk has a label');
      assert.ok(Number.isFinite(d.pct), `${d.label} has a percentage`);
      assert.ok(d.pct >= 0 && d.pct <= 100);
    }
  });

  await t.test('services come back as a list, not the wire format', () => {
    assert.ok(Array.isArray(h.services));
    assert.ok(h.services.length > 0);
    for (const s of h.services) {
      assert.equal(typeof s.ok, 'boolean');
      assert.ok(s.name);
    }
  });

  await t.test('a failed unit becomes an alert', () => {
    const failed = fixture('teg-checks.json').failed || [];
    const named = h.alerts.filter((a) => a.text.includes('failed'));
    assert.equal(named.length, failed.length);
  });
});

test('teg adapter — detail endpoints are optional', async () => {
  const routes = { '/api/stats': fixture('teg-stats.json') };   // disks/checks/services 404
  const host = { id: 'disinteg', kind: 'teg', origin: 'https://example.invalid' };
  const h = await withFetch(fakeFetch(routes), () => teg.probe(host));
  // The box is up. Losing disk detail must not report it as down.
  assert.equal(h.online, true);
  assert.deepEqual(h.services, []);
});

test('teg adapter — an unreachable host is offline, not an exception', async () => {
  const host = { id: 'disinteg', kind: 'teg', origin: 'https://example.invalid' };
  const h = await withFetch(async () => { throw new Error('ECONNREFUSED'); }, () => teg.probe(host));
  assert.equal(h.online, false);
  assert.match(h.error, /ECONNREFUSED/);
  assert.deepEqual(h.disks, []);
});

test('agent adapter — the HP box', async (t) => {
  const routes = {
    '/api/stats': fixture('agent-stats.json'),
    '/api/services': fixture('agent-services.json'),
  };
  const host = { id: 'hp', name: 'ojee-hp-zorin', kind: 'agent', origin: 'http://example.invalid' };
  const h = await withFetch(fakeFetch(routes), () => agent.probe(host));

  await t.test('normalizes the same way as the others', () => {
    assert.equal(h.online, true);
    assert.ok(Number.isFinite(h.cpu.pct));
    assert.ok(Number.isFinite(h.mem.pct));
    assert.ok(h.disks.length >= 1);
  });

  await t.test('containers are services, and a stopped one is down', () => {
    assert.ok(h.services.length > 0);
    assert.ok(h.services.every((s) => s.kind === 'container'));
    const raw = fixture('agent-services.json');
    const expectedDown = Object.values(raw).filter((s) => !s.active).length;
    assert.equal(h.services.filter((s) => !s.ok).length, expectedDown);
  });
});

test('loq adapter — the laptop', async (t) => {
  const routes = { '/api/state': fixture('loq-state.json') };
  const host = { id: 'loq', name: 'OJEE-LOQ-ZORIN', kind: 'loq', origin: 'http://example.invalid' };
  const h = await withFetch(fakeFetch(routes), () => loq.probe(host));

  await t.test('reports what it has', () => {
    assert.equal(h.online, true);
    assert.ok(Number.isFinite(h.cpu.pct));
    assert.ok(h.cpu.model, 'cpu model');
  });

  await t.test('reports RAM as absent rather than as zero', () => {
    // The sampler never collects memory. A bar pinned at 0% would be a
    // statement about a machine that is using memory perfectly normally.
    assert.equal(h.mem, null);
  });

  await t.test('uses the sampler\'s own timestamp, so a wedged sampler looks stale', () => {
    const raw = fixture('loq-state.json');
    if (Number.isFinite(raw.at)) assert.equal(h.at, raw.at * 1000);
  });
});

test('alert rules', async (t) => {
  const base = {
    id: 'x', name: 'box', online: true, at: Date.now(),
    cpu: null, mem: null, swap: null, gpu: null, disks: [], services: [], alerts: [],
  };

  await t.test('a healthy machine raises nothing', () => {
    assert.deepEqual(deriveAlerts({
      ...base,
      cpu: { pct: 12, tempC: 45 },
      mem: { used: 4, total: 16, pct: 25 },
      disks: [{ label: '/', used: 10, total: 100, pct: 10 }],
    }), []);
  });

  await t.test('a full disk is an error, a filling one is a warning', () => {
    const warn = deriveAlerts({ ...base, disks: [{ label: '/', pct: LIMITS.diskPct + 1 }] });
    assert.equal(warn[0].severity, 'warn');
    const err = deriveAlerts({ ...base, disks: [{ label: '/', pct: LIMITS.diskCritPct + 1 }] });
    assert.equal(err[0].severity, 'err');
  });

  await t.test('an unreachable host reports only that', () => {
    const out = deriveAlerts({ ...base, online: false, error: 'timed out', cpu: { pct: 99, tempC: 200 } });
    assert.equal(out.length, 1);
    assert.equal(out[0].severity, 'err');
  });

  await t.test('a missing number never invents an alert', () => {
    assert.deepEqual(deriveAlerts({
      ...base,
      cpu: { pct: null, tempC: null },
      mem: { used: null, total: null, pct: null },
      disks: [{ label: '/', used: null, total: null, pct: null }],
    }), []);
  });

  await t.test('worst() rolls a list up', () => {
    assert.equal(worst([{ severity: 'ok' }, { severity: 'warn' }]), 'warn');
    assert.equal(worst([{ severity: 'warn' }, { severity: 'err' }]), 'err');
    assert.equal(worst([]), 'ok');
  });

  await t.test('pct refuses to divide by zero', () => {
    assert.equal(pct(5, 0), null);
    assert.equal(pct(undefined, 100), null);
    assert.equal(pct(50, 100), 50);
  });
});
