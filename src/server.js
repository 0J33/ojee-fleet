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
import { HistoryStore } from './history.js';
import { RemoteLink } from './remote.js';
import { buildSummary, decorate, ALERT_KINDS_MANIFEST, applyPrefs } from './summary.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const config = loadConfig();
const app = express();
app.use(express.json({ limit: '64kb' }));
app.disable('x-powered-by');

// Two days of one-minute points per host, on disk: the cards' 2 h sparklines
// and the 24 h charts survive a redeploy.
const store = new HistoryStore({ file: path.join(config.dataDir, 'history.json') });
const saver = setInterval(() => store.save(), 60_000);
saver.unref?.();
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => { store.save(); process.exit(0); });
}

const poller = new Poller({
  hosts: config.hosts,
  intervalMs: config.intervalMs,
  historyLength: config.historyLength,
  sustain: config.sustain,
  store,
}).start();

const remote = new RemoteLink({ origin: config.remoteOrigin, hosts: config.hosts }).start();

/** The snapshot every reader gets: the poller's, plus history and remote. */
const view = () => decorate(poller.snapshot(), { hosts: config.hosts, store, remote });

const notifier = new Notifier(config.notify);

/* ── notifications ──────────────────────────────────────────────────────
   A transition worth telling (Notifier.event decides) goes out as a
   `notify` event on /api/events with id `fleet.host`. The console routes it
   — app, Discord, quiet hours — from Settings → Notifications. Only when no
   console has been listening for two minutes does this module post to its
   own Discord webhook, so an incident is never lost because the console is
   down; the console's settings (pushed to /api/notify/prefs) still apply. */

const NOTIFY_TYPES = [{
  id: 'fleet.host', label: 'A machine degraded, in trouble, or recovered',
  description: 'One message per incident, when a machine changes state and stays changed; a recovery only for a break that was announced.',
  severity: 'warn', defaultChannels: ['app', 'discord'], view: 'hosts', cooldownMin: 0,
}];
const recentNotify = [];
const routers = new Set();
let routerGoneAt = Date.now();
let notifyPrefs = null;
const streams = new Set();

poller.on('transition', (t) => {
  const ev = notifier.event(t);
  if (!ev) return;
  const n = {
    id: 'fleet.host', title: ev.title, body: ev.description,
    tag: `fleet:${t.host.id}:${t.to}`,
    severity: t.to === 'err' ? 'critical' : t.to === 'ok' ? 'info' : 'warn',
    view: 'hosts', at: Date.now(),
  };
  recentNotify.push(n);
  while (recentNotify.length > 50) recentNotify.shift();
  for (const res of streams) res.write(`event: notify\ndata: ${JSON.stringify(n)}\n\n`);
  const routed = routers.size > 0 || Date.now() - routerGoneAt < 120_000;
  const wanted = notifyPrefs?.types?.['fleet.host']?.discord !== false;
  if (!routed && wanted && notifier.enabled) notifier.send(ev).catch(() => {});
});

app.post('/api/notify/prefs', (req, res) => {
  if (!req.body || typeof req.body.types !== 'object') return res.status(400).json({ error: 'types is required' });
  notifyPrefs = { quiet: req.body.quiet || null, types: req.body.types };
  // Thresholds the person set in the console (Settings -> notifications)
  // replace the defaults on every host.
  poller.overrides = applyPrefs(req.body.types);
  res.json({ ok: true, limits: poller.overrides });
});

/* ── the manifest ───────────────────────────────────────────────────────── */

// One page. `hosts`, `services` and `alerts` stay valid deep links (old
// notifications and overview alerts point at them) and land on the same page,
// scrolled to that part.
const VIEWS = [
  { id: 'machines', label: 'Machines', icon: 'i-server' },
];

app.get('/module.json', (req, res) => {
  res.json({
    id: process.env.MODULE_ID || 'fleet',
    name: process.env.MODULE_NAME || 'Machines',
    version: '2.0.0',
    // The shell draws this in the sidebar. Declaring it beats letting the
    // shell borrow the first view's icon, which made every module that opens
    // on an overview render the same square as every other one.
    icon: 'i-server',
    views: VIEWS,
    ui: '/ui/index.js',
    health: '/api/health',
    capabilities: ['summary', 'sse', 'notify'],
    notifications: NOTIFY_TYPES,
    // Every alert this module can raise, for the console's one settings table
    // and its inbox. `kind` is what an alert's `kind` says; `key`s are
    // `<kind>.<host>[.<subject>]` and never carry a number.
    alertKinds: ALERT_KINDS_MANIFEST,
  });
});

app.get('/api/health', (req, res) => {
  const s = poller.snapshot();
  // Healthy means THIS SERVICE is healthy. A host being down is information
  // the module is successfully reporting, not the module failing — marking
  // ourselves unhealthy for it would make the console hide the one page that
  // explains what is wrong.
  res.json({
    ok: true,
    hosts: s.total,
    online: s.online,
    pending: s.hosts.filter((h) => h.pending).length,
    status: s.status,
  });
});

/* ── the console's front page ───────────────────────────────────────────── */

app.get('/api/summary', (req, res) => {
  res.json(buildSummary(view(), { hosts: config.hosts, store }));
});

/* ── hosts ──────────────────────────────────────────────────────────────── */

app.get('/api/hosts', (req, res) => res.json(view()));

app.get('/api/hosts/:id', (req, res) => {
  const h = view().hosts.find((x) => x.id === req.params.id);
  if (!h) return res.status(404).json({ error: 'no such host' });
  return res.json({ ...h, history: poller.history.get(req.params.id) || [] });
});

/**
 * History. `?window=15m` is the 10-second ring (in memory); anything longer
 * is the persisted minute history: 2h, 6h, 24h, 48h.
 */
const WINDOWS = { '2h': 2, '6h': 6, '24h': 24, '48h': 48 };
app.get('/api/hosts/:id/history', (req, res) => {
  if (!poller.get(req.params.id)) return res.status(404).json({ error: 'no such host' });
  const w = String(req.query.window || '15m');
  if (WINDOWS[w]) return res.json({ window: w, step: 60_000, points: store.series(req.params.id, WINDOWS[w] * 3600_000) });
  return res.json({ window: '15m', samples: poller.history.get(req.params.id) || [] });
});

/**
 * Reboot a dual-boot machine into its other OS — through ojee-remote, which
 * holds the ssh credential and the fixed command (a one-shot BootNext). Needs
 * `confirm: true` like every action that takes a machine away.
 */
app.post('/api/hosts/:id/boot', async (req, res) => {
  const host = config.hosts.find((h) => h.id === req.params.id);
  if (!host) return res.status(404).json({ error: 'no such host' });
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'send {"confirm": true}' });
  const to = req.body?.to ? String(req.body.to).toLowerCase() : null;
  if (to && !/^[a-z0-9-]{1,32}$/.test(to)) return res.status(400).json({ error: 'bad target' });
  try {
    const out = await remote.boot(host, to);
    console.log(`[boot] ${host.id} -> ${to || 'other'} (${req.get('x-console-user') || 'local'})`);
    remote.tick().catch(() => {});
    return res.json(out);
  } catch (e) {
    return res.status(e.status && e.status < 600 ? e.status : 502).json({ error: e.message });
  }
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
  send('state', view());

  const onUpdate = () => send('state', view());
  poller.on('update', onUpdate);
  // The console's own subscription (?router=1) catches up on what it missed.
  const router = req.query.router === '1';
  const since = Number(req.query.since);
  if (since > 0) for (const n of recentNotify) if (n.at > since && Date.now() - n.at < 30 * 60_000) send('notify', n);
  streams.add(res);
  if (router) routers.add(res);

  // Proxies drop a stream that says nothing for long enough; a comment is not
  // an event, so this costs the client nothing to ignore.
  const beat = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(beat);
    poller.off('update', onUpdate);
    streams.delete(res);
    if (routers.delete(res) && !routers.size) routerGoneAt = Date.now();
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
