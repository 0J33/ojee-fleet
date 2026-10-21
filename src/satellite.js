/**
 * fleet satellite — the `local` adapter, run on another machine.
 *
 * Fleet reads the HP box it runs on directly (adapters/local.js: /proc, /sys,
 * nvidia-smi, the Docker socket). A machine that has no dashboard of its own
 * runs this instead: the very same reading, served over the tailnet, and the
 * fleet adapter `satellite` fetches it. So the laptop is measured exactly the
 * way the HP box is, by the same code, and there is no second sampler whose
 * numbers mean something slightly different.
 *
 *   SATELLITE_TOKEN   required; the bearer fleet sends (HOST_<ID>_TOKEN there)
 *   SATELLITE_BIND    address to listen on (default 127.0.0.1; the tailnet IP
 *                     on a real machine)
 *   SATELLITE_PORT    default 8303
 *
 *   GET /api/host     the reading, in fleet's normalized host shape
 *   GET /health       { ok: true }
 *
 * Read only. It answers nothing else: no actions, no restarts, no logs.
 */

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { probe, describe } from './adapters/local.js';

const TOKEN = process.env.SATELLITE_TOKEN || '';
const BIND = process.env.SATELLITE_BIND || '127.0.0.1';
const PORT = Number(process.env.SATELLITE_PORT || 8303);
/** Fleet polls every 10 s; two fleets, or a retry, share one reading. */
const FRESH_MS = 2000;

if (TOKEN.length < 16) {
  console.error('SATELLITE_TOKEN is not set (16+ characters). Refusing to serve this machine without one.');
  process.exit(1);
}

const digest = (s) => createHash('sha256').update(String(s)).digest();
const authorised = (req) => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return !!m && timingSafeEqual(digest(m[1]), digest(TOKEN));
};

let last = null;
let inflight = null;
async function reading() {
  if (last && Date.now() - last.at < FRESH_MS) return last.v;
  inflight ||= probe({ id: 'self', name: 'self', kind: 'satellite' })
    .then((v) => { last = { at: Date.now(), v }; return v; })
    .finally(() => { inflight = null; });
  return inflight;
}
// The CPU and network figures are differences between two samples: take one
// now, so the first request fleet makes already has a percentage.
reading().catch(() => {});

const send = (res, code, body) => {
  const b = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b), 'cache-control': 'no-store' });
  res.end(b);
};

http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (req.method !== 'GET') return send(res, 405, { error: 'read only' });
  if (!authorised(req)) return send(res, 401, { error: 'unauthorised' });
  if (p === '/health') return send(res, 200, { ok: true, reads: describe() });
  if (p === '/api/host') {
    try { return send(res, 200, await reading()); } catch (e) { return send(res, 500, { error: e.message }); }
  }
  return send(res, 404, { error: 'not found' });
}).listen(PORT, BIND, () => {
  console.log(`fleet satellite on ${BIND}:${PORT}: ${describe()}`);
});
