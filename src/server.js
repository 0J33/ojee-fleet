/**
 * ojee-fleet — every machine that is mine, on one page.
 *
 * Runs standalone or as an ojee-console module. It owns no auth: mounted, the
 * console has already decided who you are; standalone, it is tailnet-only and
 * single-purpose, which is the same bargain every other module makes.
 *
 * REMOTE machines are read through whatever they already expose — a Flask
 * dashboard here, a Python sampler on the laptop — rather than through an
 * agent of my own installed on each one. That alternative would mean the fleet
 * view could only ever show machines I had already got around to installing
 * something on, which is exactly backwards for a thing whose job is to tell me
 * about the machine I have been ignoring.
 *
 * The machine this module RUNS on is the exception, and reads itself: asking
 * another service on the same host what that host is doing is a round trip to
 * learn something already on disk, and it left monitoring tangled up in a
 * module that is about something else entirely.
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { ADAPTERS, Poller } from './poller.js';
import { Notifier } from './notify.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const config = loadConfig();
const app = express();
app.use(express.json({ limit: '64kb' }));
app.disable('x-powered-by');

const poller = new Poller({
  hosts: config.hosts,
  intervalMs: config.intervalMs,
  historyLength: config.historyLength,
}).start();

const notifier = new Notifier(config.notify);
poller.on('transition', (t) => { notifier.transition(t); });

/* ── the manifest ───────────────────────────────────────────────────────── */

const VIEWS = [
  { id: 'overview', label: 'Overview', icon: 'i-grid' },
  { id: 'hosts', label: 'Hosts', icon: 'i-server' },
  { id: 'services', label: 'Services', icon: 'i-gauge' },
  { id: 'alerts', label: 'Alerts', icon: 'i-warn' },
];

app.get('/module.json', (req, res) => {
  res.json({
    id: process.env.MODULE_ID || 'fleet',
    name: process.env.MODULE_NAME || 'Fleet',
    version: '1.0.0',
    // The shell draws this in the sidebar. Declaring it beats letting the
    // shell borrow the first view's icon, which made every module that opens
    // on an overview render the same square as every other one.
    icon: 'i-server',
    views: VIEWS,
    ui: '/ui/index.js',
    health: '/api/health',
    capabilities: ['summary', 'sse'],
  });
});

app.get('/api/health', (req, res) => {
  const s = poller.snapshot();
  // Healthy means THIS SERVICE is healthy. A host being down is information
  // the module is successfully reporting, not the module failing — marking
  // ourselves unhealthy for it would make the console hide the one page that
  // explains what is wrong.
  res.json({ ok: true, hosts: s.total, online: s.online, status: s.status });
});

/* ── the console's front page ───────────────────────────────────────────── */

app.get('/api/summary', (req, res) => {
  const s = poller.snapshot();
  const down = s.hosts.filter((h) => !h.online);
  const degraded = s.hosts.filter((h) => h.online && h.status !== 'ok');

  const headline = down.length
    ? `${down.length} of ${s.total} unreachable`
    : degraded.length
      ? `${s.total} hosts · ${degraded.length} need attention`
      : `${s.total} hosts · all healthy`;

  // Four facts, and each one has to be worth the space on a front page.
  //
  // This used to be one fact per host reading "4% cpu", which is the number
  // most likely to be interesting on a graph and least likely to be worth
  // knowing at a glance: it is 4% almost always, and when it is not, it is
  // usually fine anyway. What you actually want to know before opening
  // anything is whether everything is up, whether anything stopped, and
  // whether something is about to run out of disk.
  const services = s.hosts.flatMap((h) => h.services || []);
  const running = services.filter((x) => x.ok).length;
  const tightest = s.hosts
    .flatMap((h) => (h.disks || []).map((d) => ({ ...d, host: h.name })))
    .filter((d) => Number.isFinite(d.pct))
    .sort((a, b) => b.pct - a.pct)[0];
  // A host that answers but whose sample is old is a different failure from
  // one that does not answer at all, and the difference matters: the page is
  // showing you numbers that are no longer true.
  const stale = s.hosts.filter((h) => h.online && h.at && Date.now() - h.at > 120_000);

  // Facts are EXCEPTIONS, not statistics. A number that reads the same every
  // day teaches you to stop reading the card — "fullest disk: 56%" and
  // "longest up: 57d" were true, stable, and worth nothing at a glance. So a
  // measurement only earns a slot once it crosses into being worth acting on;
  // when nothing has, the card is short, which is itself the report.
  const facts = [
    {
      k: 'Machines',
      v: down.length ? `${s.online} up · ${down.map((h) => h.name).join(', ')} down` : `${s.total} up`,
    },
    services.length
      ? {
        k: 'Services',
        v: running === services.length
          ? `all ${services.length} running`
          : `${services.length - running} stopped of ${services.length}`,
      }
      : null,
    // Only once a disk is actually filling up.
    tightest && tightest.pct >= 80
      ? { k: 'Disk', v: `${tightest.host} ${tightest.label} · ${Math.round(tightest.pct)}% full` }
      : null,
    stale.length
      ? { k: 'Stale', v: `${stale.map((h) => h.name).join(', ')} not reporting` }
      : null,
    s.alerts.length
      ? { k: 'Needs attention', v: `${s.alerts.length} alert${s.alerts.length === 1 ? '' : 's'}` }
      : null,
  ].filter(Boolean).slice(0, 4);

  res.json({
    status: s.status === 'unknown' ? 'warn' : s.status,
    headline,
    facts,
    alerts: s.alerts.slice(0, 5).map((a) => ({
      text: a.text, severity: a.severity, view: 'alerts',
    })),
  });
});

/* ── hosts ──────────────────────────────────────────────────────────────── */

app.get('/api/hosts', (req, res) => res.json(poller.snapshot()));

app.get('/api/hosts/:id', (req, res) => {
  const h = poller.get(req.params.id);
  if (!h) return res.status(404).json({ error: 'no such host' });
  return res.json({ ...h, history: poller.history.get(req.params.id) || [] });
});

app.get('/api/hosts/:id/history', (req, res) => {
  if (!poller.get(req.params.id)) return res.status(404).json({ error: 'no such host' });
  return res.json({ samples: poller.history.get(req.params.id) || [] });
});

/** Logs, for hosts whose API has them. Proxied rather than re-implemented. */
app.get('/api/hosts/:id/logs/:unit', async (req, res) => {
  const host = config.hosts.find((h) => h.id === req.params.id);
  const state = poller.get(req.params.id);
  if (!host || !state) return res.status(404).json({ error: 'no such host' });
  if (!state.capabilities?.logs) {
    return res.status(501).json({ error: `${state.name} does not serve logs` });
  }
  const unit = String(req.params.unit);
  if (!/^[a-zA-Z0-9._@-]{1,64}$/.test(unit)) {
    return res.status(400).json({ error: 'bad unit name' });
  }
  try {
    const url = new URL(`/api/journal/${encodeURIComponent(unit)}`, host.origin);
    const upstream = await fetch(url, {
      headers: host.token ? { authorization: `Bearer ${host.token}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    const body = await upstream.json();
    return res.status(upstream.status).json(body);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
});

/**
 * Processes, for hosts whose API has them.
 *
 * This is what the laptop's own console module used to be for. Folding it in
 * here means one page per machine rather than a module for one of them and a
 * fleet view for the rest — and the machine does not stop being a machine
 * because it happens to be the one I am sitting at.
 */
app.get('/api/hosts/:id/processes', async (req, res) => {
  const host = config.hosts.find((h) => h.id === req.params.id);
  const state = poller.get(req.params.id);
  if (!host || !state) return res.status(404).json({ error: 'no such host' });
  if (!state.capabilities?.processes) {
    return res.status(501).json({ error: `${state.name} does not list processes` });
  }
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 40));
  const q = String(req.query.q || '').slice(0, 64);
  try {
    const url = new URL('/api/processes', host.origin);
    url.searchParams.set('limit', String(limit));
    if (q) url.searchParams.set('q', q);
    const upstream = await fetch(url, {
      headers: host.token ? { authorization: `Bearer ${host.token}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    return res.status(upstream.status).json(await upstream.json());
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
});

/**
 * Service actions. The allowlist lives on each host, not here: this forwards
 * a named action and lets the machine decide whether it is one it performs.
 * A fleet module that could run arbitrary commands on three boxes would be a
 * much more interesting thing to compromise than a fleet module that cannot.
 */
app.post('/api/hosts/:id/action', async (req, res) => {
  const host = config.hosts.find((h) => h.id === req.params.id);
  const state = poller.get(req.params.id);
  if (!host || !state) return res.status(404).json({ error: 'no such host' });
  if (!state.capabilities?.actions) {
    return res.status(501).json({ error: `${state.name} does not accept actions` });
  }
  const action = String(req.body?.action || '');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(action)) {
    return res.status(400).json({ error: 'bad action name' });
  }
  // An adapter that acts on the machine directly (the local one restarts a
  // container over the Docker socket) does it here; everything else is
  // forwarded to the host's own allowlist.
  const adapter = ADAPTERS[host.kind];
  if (typeof adapter?.action === 'function') {
    try {
      const out = await adapter.action(action.replace(/^restart-/, ''));
      poller.probeOne(host).catch(() => {});
      return res.json(out);
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  try {
    const upstream = await fetch(new URL('/api/action', host.origin), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(host.token ? { authorization: `Bearer ${host.token}` } : {}),
      },
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await upstream.json().catch(() => ({}));
    // Whatever just happened, the cached picture is now out of date.
    poller.probeOne(host).catch(() => {});
    return res.status(upstream.status).json(body);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
});

/* ── live updates ───────────────────────────────────────────────────────── */

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send('state', poller.snapshot());

  const onUpdate = (s) => send('state', s);
  const onTransition = ({ host, from, to }) => {
    send('notify', {
      title: to === 'ok' ? `${host.name} recovered` : `${host.name} is ${to}`,
      body: (host.alerts || [])[0]?.text || `was ${from}`,
      tag: `fleet:${host.id}:${to}`,
    });
  };
  poller.on('update', onUpdate);
  poller.on('transition', onTransition);

  // Proxies drop a stream that says nothing for long enough; a comment is not
  // an event, so this costs the client nothing to ignore.
  const beat = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(beat);
    poller.off('update', onUpdate);
    poller.off('transition', onTransition);
  });
});

/* ── static ─────────────────────────────────────────────────────────────── */

app.use('/ui', express.static(path.join(ROOT, 'ui'), {
  setHeaders: (res) => res.setHeader('cache-control', 'no-cache'),
}));
app.use(express.static(path.join(ROOT, 'public'), {
  setHeaders: (res) => res.setHeader('cache-control', 'no-cache'),
}));

const port = Number(process.env.PORT || 8400);
const bind = process.env.BIND || '0.0.0.0';

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, bind, () => {
    const names = config.hosts.map((h) => h.id).join(', ') || 'none configured';
    // eslint-disable-next-line no-console
    console.log(`fleet on ${bind}:${port} — watching ${names}`);
  });
}

export { app, poller, config };
