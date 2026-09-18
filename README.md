# ojee-fleet

Every machine that is mine, on one page — what each one is doing, what is wrong with it, and
which of its services stopped.

Runs standalone or as an [ojee-console](https://github.com/0J33/ojee-console) module.

---

## The idea it is built on

**Remote machines are read through whatever they already expose** — a Flask dashboard on one, a
Python sampler reading `/proc` on the laptop. Nothing new gets installed anywhere.

The obvious alternative — write one agent, install it everywhere — is worse in the way that
matters. A fleet view whose job is to tell you about the machine you have been ignoring can only
show machines you already got around to installing something on. That is exactly backwards.

**The machine this runs on is the exception, and reads itself.** Asking another service on the
same host what that host is doing is a round trip to learn something already on disk — and it left
monitoring living inside a module that is about something else entirely.

So a new machine is an **adapter**, about a hundred lines, and nothing else in the repo changes:

```
src/adapters/teg.js      disinteg   — Flask dashboard API, shared bearer
src/adapters/loq.js      loq        — ojee-loq, /proc + RAPL + nvidia-smi
src/adapters/local.js    hp         — this host: /proc, /sys, docker.sock
src/adapters/agent.js    (spare)    — ojee-agent, for a box that runs one
```

Each returns the same shape. `src/normalize.js` defines it, and holds the thresholds — the one
thing that must not exist in three places.

---

## What it reports

**Hosts** — CPU (with temperature), memory, swap, filesystems, GPU, network throughput, uptime,
battery where there is one, and a 15-minute sparkline of each.

**Services** — every unit and container across every machine in one list, filterable, with a
restart button where the host accepts one.

**Alerts** — derived from the numbers, in one place, with thresholds chosen so that each one is
something a person would actually do something about:

| | |
|---|---|
| CPU ≥ 88 °C, GPU ≥ 85 °C | sustained load or a fan problem |
| disk ≥ 90% / ≥ 96% | warn / error — below 10% free, ext4 starts fragmenting badly |
| memory ≥ 93%, swap ≥ 60% | something is over-committed |
| a unit or container is down | the host said so |
| no sample for 2 minutes | the reading on screen is not live |
| SMART not `PASSED`, reallocated sectors | the most important thing on the page |

**Logs** — the journal for a unit, on hosts whose API serves one.

### Muting

A rule that fires forever is a rule you learn to ignore, and ignoring one alert is a habit that
costs you the next one. So a host can name the kinds it should never raise:

```jsonc
{ "id": "loq", "kind": "loq", "mute": ["cpu-temp", "cpu-throttle"] }
```

`HOST_<ID>_MUTE` (a comma list) overrides it without editing config. The kinds are `ALERT_KINDS`
in `src/normalize.js`.

Muting is **per host**, because 95 °C means nothing on a laptop compiling something and means a
failed fan on a server. And it happens **before** the status roll-up, not at render time — a muted
rule cannot colour the host red, so it cannot reach Discord or the phone by another route either.

---

## Things that took getting right

**Memory uses `MemAvailable`, not `MemFree`.** The kernel's own answer to "how much can a new
process have" accounts for reclaimable page cache. `MemTotal - MemFree` does not, which is why so
many dashboards insist a perfectly healthy Linux box is at 95% memory.

**The first CPU sample has no percentage.** Utilisation is a delta between two readings of
`/proc/stat`, so the first one after a start reports `null` rather than 0 — "we do not know yet"
and "the machine is idle" are different claims.

**A missing number is reported as missing.** The laptop's sampler collects no RAM at all. A bar
pinned at 0% would be a statement about a machine that is using memory perfectly normally, so the
card says *not reported* instead. Same for GPUs that report a model and no utilisation, and drives
that report a capacity and no usage: those are listed as hardware, not drawn as gauges.

**A cumulative counter is judged on its delta.** The laptop reports throttle events since boot.
That number is in the millions on any laptop that has been up for weeks, so "it is above zero,
therefore it is throttling" is an alert that is permanently on. Whether it is throttling *now* is a
question about two samples, which only the poller can see — so the adapter reports the counter raw
and the poller decides.

**One filesystem, many mount points.** disinteg has `/dev/sda1` mounted at `/`, `/boot`, `/etc`,
`/root`, `/tmp`, `/usr` and `/var/tmp`, all reporting the same 4.6%. Seven rows that say one thing
bury the one mount that is actually filling up; the shortest path per device wins.

**An unreachable host keeps its last good reading.** The card says "unreachable, last seen 40s ago"
over what it last knew, rather than going blank. Blank looks like a bug. Stale with a timestamp
looks like what it is.

**Polling happens in the background, never on request.** A machine in another country behind a
tunnel occasionally takes six seconds to answer. A page that probes when you load it is as slow as
its slowest member, every single time.

**A host being down does not make the module unhealthy.** `/api/health` reports on *this service*.
Reporting ourselves degraded because a machine is down would make the console hide the one page
that explains what is wrong.

---

## Notifications

Point `DISCORD_WEBHOOK` at a webhook and state transitions are posted to it. Two rules, both about
not becoming noise:

- Only transitions. "disinteg went from ok to err" is news; "disinteg is still err" is not, and a
  monitor that repeats itself every ten seconds gets muted — strictly worse than one that never
  sent anything.
- Recoveries too. A pager that only tells you about breakage leaves you refreshing a page to find
  out whether it is over.

Mounted in the console, the same transitions also arrive as SSE `notify` events, which the phone
app turns into local notifications.

---

## Setup

```bash
npm install
cp config/fleet.example.json config/fleet.json   # which machines, and where
vim config/fleet.json
npm start                                        # http://localhost:8400
```

`config/fleet.json` says *which machines this deployment watches*. It holds no secrets, so a
private deployment repo can commit it. Credentials come from the environment:

| Variable | Meaning |
|---|---|
| `HOST_<ID>_TOKEN` | the bearer that host's API wants |
| `HOST_<ID>_ORIGIN` | override the origin (container names, a box that moved) |
| `HOST_<ID>_MUTE` | comma list of alert kinds this host should not raise |
| `HOST_ROOT` | where the host filesystem is visible (`/host` in a container) |
| `DOCKER_SOCK` | default `/var/run/docker.sock` — the `local` adapter's services |
| `DISCORD_WEBHOOK` | optional; transitions are posted here |
| `FLEET_POLL_MS` | default 10000 |
| `PORT` / `BIND` | default `0.0.0.0:8400` |

Mounted in a console, add it to `config/console.json` like any other module.

---

## API

| | |
|---|---|
| `GET /module.json` | the console's manifest |
| `GET /api/health` | is *this service* alive |
| `GET /api/summary` | status, headline, facts, alerts — the console's front page |
| `GET /api/hosts` | every host, normalized, plus the rolled-up alert list |
| `GET /api/hosts/:id` | one host, with its history ring |
| `GET /api/hosts/:id/logs/:unit` | journal, proxied, for hosts that serve one |
| `POST /api/hosts/:id/action` | `{action}` — forwarded to the host |
| `GET /api/events` | SSE: `state` on every poll, `notify` on a transition |

Actions are **allowlisted on each host, not here**. This module forwards a named action and lets
the machine decide whether it is one it performs. A fleet service that could run arbitrary commands
on every box would be a much more interesting thing to compromise than one that cannot.

---

## Tests

```bash
npm test
```

The adapter tests run against payloads captured from the real machines (`tests/fixtures/`), not
mocks written from the docs — so a field spelled differently from how I remembered, or a number
that arrives as a string, fails here rather than rendering as `—` in production and being blamed
on the host.

---

## Licence

MIT.
