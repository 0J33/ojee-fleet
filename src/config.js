/**
 * What machines this deployment watches.
 *
 * The file says which hosts exist and how to reach them; the environment
 * supplies the credentials. That split is the same one ojee-console makes,
 * and for the same reason: a private deployment repo can commit the config
 * without committing a single secret.
 *
 *     HOST_<ID>_ORIGIN    override the origin (docker names, moved boxes)
 *     HOST_<ID>_TOKEN     the bearer this host's API wants
 *
 * `kind` picks the adapter. A host is defined by what it already exposes —
 * none of these machines runs an agent written for this module, because
 * requiring one would mean the fleet view only ever sees machines I have
 * already got around to installing something on.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.FLEET_CONFIG
  || path.join(HERE, '..', 'config', 'fleet.json');

const ENV_KEY = (id) => id.toUpperCase().replace(/-/g, '_');

function readFile(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`${p} is not valid JSON: ${e.message}`);
  }
}

export function loadConfig() {
  const raw = readFile(CONFIG_PATH)
    || readFile(path.join(HERE, '..', 'config', 'fleet.example.json'))
    || { hosts: [] };

  const hosts = (raw.hosts || [])
    .filter((h) => h.enabled !== false)
    .map((h) => {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(h.id || '')) {
        throw new Error(`host id ${JSON.stringify(h.id)} is invalid — lowercase letters, digits and dashes`);
      }
      const key = ENV_KEY(h.id);
      // A comma list in the environment overrides the file, so a noisy rule
      // can be silenced on a running deployment without editing config.
      const envMute = process.env[`HOST_${key}_MUTE`];
      return {
        ...h,
        origin: process.env[`HOST_${key}_ORIGIN`] || h.origin,
        token: process.env[`HOST_${key}_TOKEN`] || h.token || '',
        mute: envMute != null
          ? envMute.split(',').map((x) => x.trim()).filter(Boolean)
          : (h.mute || []),
        // How long this host may be unreachable before anyone is told. A
        // laptop that sleeps, a box on Wi-Fi, a tunnel that re-dials: these
        // go away for a minute and come back, and a monitor that announces
        // every one of them is a monitor you mute.
        graceMs: Number(process.env[`HOST_${key}_GRACE_MS`] ?? h.graceMs ?? NaN),
      };
    });

  const defaultGrace = Number(process.env.FLEET_DOWN_GRACE_MS || raw.downGraceMs || 300_000);
  for (const h of hosts) {
    if (!Number.isFinite(h.graceMs)) h.graceMs = defaultGrace;
  }

  return {
    hosts,
    downGraceMs: defaultGrace,
    // Polling every 10s across three machines is nothing, and it is the
    // difference between a page that is current and one that is a minute old.
    intervalMs: Number(process.env.FLEET_POLL_MS || raw.intervalMs || 10_000),
    historyLength: Number(process.env.FLEET_HISTORY || raw.historyLength || 90),
    notify: {
      // A Discord webhook, when one is configured. Kept out of the config
      // file: it is a credential, and anyone holding it can post as me.
      webhook: process.env.DISCORD_WEBHOOK || '',
      // Don't say the same thing twice within this window.
      cooldownMs: Number(process.env.FLEET_NOTIFY_COOLDOWN_MS || 30 * 60 * 1000),
    },
  };
}

export { CONFIG_PATH };
