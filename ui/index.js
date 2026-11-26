/* ============================================================
   ojee-fleet — Machines.

   One page: a card per machine with the numbers that matter
   (CPU, temperature on the host's own scale, memory, disk, GPU),
   a two-hour line under each that survives a restart, the ways
   in (Screen / Shell / Files, from ojee-remote), and for the
   laptop that boots two systems, the switch between them. Below,
   services grouped by machine and folded away while healthy.

   Screen, Shell and Files open ojee-remote's own session pages
   in place: its gateway still does the streaming, ssh and sftp,
   so nothing about how those work changed — only where you find
   them.
   ============================================================ */

let ctx = null;
let root = null;
let ui = null;              // ojee-ui3.js helpers
let stopSession = null;     // teardown of an open Screen / Shell / Files
let remoteBase = null;      // where ojee-remote is mounted, if it is
let tickTimer = null;

const S = {
  data: null,
  error: null,
  live: false,
  confirm: null,            // host id with an armed "reboot to other OS"
  rebooting: {},            // host id -> { to, until }
  restarting: {},           // `${host}:${svc}` -> 'armed' | 'busy'
  open: {},                 // host id -> services expanded by hand
  win: '2h',                // chart window for every card: '2h' | '24h'
  long: {},                 // host id -> { at, points } for 24h
  focus: null,              // view to scroll to after the next render
  det: {},                  // host id -> details open
  procs: {},                // host id -> { q, rows, busy }
  logs: {},                 // host id -> { unit, text, busy }
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = 's') => `<svg class="i ${c}" aria-hidden="true"><use href="#${n}"/></svg>`;
const col = (s) => (s === 'err' ? 'var(--err)' : s === 'warn' ? 'var(--warn)' : s === 'ok' ? 'var(--ok)' : 'var(--fg-3)');
const fin = Number.isFinite;
const rnd = (v) => (fin(v) ? Math.round(v) : null);

const gb = (b) => b / 1024 ** 3;
function size(b, total) {
  // One unit for the pair, chosen by the total: "1.31/1.82 TB", "9.1/16 GB".
  if (!fin(b)) return { v: '—', u: '' };
  const ref = fin(total) ? total : b;
  const tb = ref >= 1024 ** 4;
  const k = tb ? 1024 ** 4 : 1024 ** 3;
  const f = (x) => { const v = x / k; return v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(tb ? 2 : 0) : v.toFixed(tb ? 2 : 1); };
  return { v: f(b), u: fin(total) ? `/${f(total)} ${tb ? 'TB' : 'GB'}` : (tb ? ' TB' : ' GB') };
}
const fmtUp = (s) => {
  if (!fin(s) || s <= 0) return null;
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
const ago = (t) => {
  if (!fin(t)) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const clock = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const mv = (v, u, s, cls = '') => `<div class="mv${cls ? ` ${cls}` : ''}"${s ? ` style="--c:${col(s)}"` : ''}>${esc(v)}${u ? `<span class="u">${esc(u)}</span>` : ''}</div>`;
const tag = (t, s) => `<span class="tag${s ? ` ${s}` : ''}">${esc(t)}</span>`;
const bar = (p, s) => {
  const v = Math.max(0, Math.min(100, Number(p) || 0));
  const c = s || (v >= 90 ? 'err' : v >= 80 ? 'warn' : null);
  return `<div class="bar"${c ? ` style="--c:${col(c)}"` : ''}><i style="width:${v}%"></i></div>`;
};
const pctState = (p) => (p >= 90 ? 'err' : p >= 80 ? 'warn' : null);

/* ── what a host looks like ───────────────────────────────────────────── */

const ICON = { Laptop: 'i-laptop', Server: 'i-server', VPS: 'i-cloud' };
const hostIcon = (h) => ICON[h.tag] || (h.battery ? 'i-laptop' : 'i-server');

function hostState(h) {
  if (h.away) return null;
  if (!h.online) return h.pending ? 'warn' : 'err';
  return h.status === 'err' ? 'err' : h.status === 'warn' ? 'warn' : h.status === 'ok' ? 'ok' : null;
}

/** The two hours of points to draw for a field, or the 24 h ones if picked. */
function points(h, field) {
  if (S.win === '24h' && S.long[h.id]) {
    return S.long[h.id].points.map((p) => (field === 'temp' ? (p.tempMax ?? p.temp) : p[field]));
  }
  return h.series?.[field] || [];
}

function sparkFor(h, field, opts) {
  const pts = points(h, field);
  return ui.spark(pts, { height: 28, ...opts });
}

function heatNote(h) {
  const a = (h.alerts || []).find((x) => x.kind === 'cpu-temp-critical') || (h.alerts || []).find((x) => x.kind === 'cpu-temp');
  if (a?.heldMin) return `Above ${a.kind === 'cpu-temp-critical' ? h.limits.cpuCritC : h.limits.cpuTempC} °C for ${a.heldMin} min`;
  const pend = (h.pendingAlerts || []).find((x) => x.kind === 'cpu-temp' || x.kind === 'cpu-temp-critical');
  if (pend) return `Over ${h.limits.cpuTempC} °C · alert if it holds`;
  return h.tempState === 'warn' ? 'Warm' : h.tempState === 'err' ? 'Hot' : 'Normal';
}

function primaryDisk(h) {
  const d = (h.disks || []).filter((x) => fin(x.total) && !x.remote);
  return d.find((x) => x.mount === '/') && d.length === 1 ? d[0]
    : d.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0] || null;
}

function cells(h) {
  const L = h.limits || {};
  const cpu = h.cpu || {};
  const cores = cpu.cores ? `${cpu.cores} ${h.tag === 'VPS' ? 'threads' : 'cores'}` : null;
  const load = Array.isArray(cpu.load) ? `load ${cpu.load[0].toFixed(2)}` : null;

  const mem = h.mem || {};
  const m = size(mem.used, mem.total);
  const swapUsed = h.swap?.used;
  const zram = h.zram;
  const memNote = [
    fin(swapUsed) && h.swap?.total ? (swapUsed < 64 * 1024 ** 2 ? 'Swap idle' : `Swap ${gb(swapUsed) >= 10 ? Math.round(gb(swapUsed)) : gb(swapUsed).toFixed(1)} GB`) : null,
    zram?.total ? `zram ${Math.round((zram.used / zram.total) * 100)}%` : null,
  ].filter(Boolean).join(' · ');

  const d = primaryDisk(h);
  const ds = d ? size(d.used, d.total) : null;
  const free = d && fin(d.free) ? (d.free >= 1024 ** 4 ? `${(d.free / 1024 ** 4).toFixed(2)} TB free` : `${Math.round(gb(d.free))} GB free`) : null;
  const diskNote = d ? [free, d.model ? d.model.replace(/\s+\d+\s?(GB|TB)$/i, '') : null].filter(Boolean).join(' · ') : '';
  const diskName = d && d.mount && d.mount !== '/' ? d.mount.split('/').filter(Boolean).pop() : null;
  const moreDisks = (h.disks || []).length > 1 ? ` · +${h.disks.length - 1}` : '';

  const g = h.gpu;
  const gName = g?.model ? g.model.replace(/^(NVIDIA |Intel\(R\) )/, '').replace(/ Laptop GPU$/, '').replace('GeForce ', '') : null;
  const gNote = g ? [fin(g.tempC) ? `${rnd(g.tempC)} °C` : null, fin(g.watts) ? `${rnd(g.watts)} W` : null,
    fin(g.vramUsed) && g.vramTotal ? `${(g.vramUsed / 1024 ** 3).toFixed(1)}/${Math.round(g.vramTotal / 1024 ** 3)} GB VRAM` : null].filter(Boolean).join(' · ') : '';

  const temp = cpu.tempC;
  return [
    { l: 'CPU', v: fin(cpu.pct) ? String(rnd(cpu.pct)) : '—', u: '%',
      viz: sparkFor(h, 'cpu', { min: 0, max: 100, label: 'CPU usage' }), note: [cores, load].filter(Boolean).join(' · ') },
    { l: 'CPU temp', v: fin(temp) ? String(rnd(temp)) : '—', u: fin(temp) ? '°C' : '', s: h.tempState,
      viz: fin(temp) || points(h, 'temp').some(fin)
        ? sparkFor(h, 'temp', { status: h.tempState, threshold: L.cpuTempC, label: 'CPU temperature' })
        : '<div class="hm-none">Not exposed by this host</div>',
      note: fin(temp) ? heatNote(h) : '' },
    { l: 'Memory', v: m.v, u: m.u, viz: fin(mem.pct) ? bar(mem.pct, pctState(mem.pct)) : '', note: memNote },
    { l: diskName ? `Disk · ${diskName}` : 'Disk', v: ds ? ds.v : '—', u: ds ? ds.u : '', viz: d ? bar(d.pct, d.pct >= (L.diskCritPct || 96) ? 'err' : d.pct >= (L.diskPct || 90) ? 'warn' : null) : '', note: d ? `${diskNote}${moreDisks}` : '' },
    { l: g ? `GPU · ${gName || 'GPU'}` : 'GPU', v: g && fin(g.pct) ? String(rnd(g.pct)) : '—', u: g && fin(g.pct) ? '%' : '',
      viz: g && fin(g.pct) ? bar(g.pct, h.gpuTempState === 'err' ? 'err' : null) : `<div class="hm-none">${g ? 'No utilisation reported' : 'None'}</div>`, note: gNote },
  ];
}

/* ── the ways in ──────────────────────────────────────────────────────── */

function ways(h) {
  const r = h.remote;
  if (!r || !remoteBase) return { screen: null, shell: null, boot: null };
  const live = r.devices.filter((d) => d.online || d.shellOnline);
  const screen = r.devices.find((d) => d.screen && d.online) || r.devices.find((d) => d.screen && d.id === r.current) || r.devices.find((d) => d.screen);
  const shell = r.devices.find((d) => d.shell && d.shellOnline) || r.devices.find((d) => d.shell);
  const boot = live.map((d) => d.boot).find(Boolean) || null;
  return { screen, shell, boot, os: r.os, locked: r.locked };
}

function actBtn(act, h, dev, label, icon, up) {
  if (!dev) return '';
  const off = !up;
  return `<button class="btn sm${off ? ' fl-off' : ''}" data-act="${act}" data-host="${esc(h.id)}" data-dev="${esc(dev.id)}"
    ${off ? 'aria-disabled="true"' : ''} title="${esc(off ? `${dev.name} is not answering` : `${label} · ${dev.name}`)}">${ic(icon)}${label}</button>`;
}

/* ── render ───────────────────────────────────────────────────────────── */

function hostCard(h, i) {
  const w = ways(h);
  const state = hostState(h);
  const osTag = w.os ? tag(w.os === 'windows' ? 'Windows' : 'Linux') : (h.tag ? tag(h.tag) : '');
  const stateTag = h.away
    ? tag(h.stateText)
    : tag(h.stateText, state === 'ok' ? 'ok' : state);
  const up = fmtUp(h.uptime);
  const sub = [
    `<span>${esc(h.role || '')}${h.os ? ` · ${esc(h.os)}` : ''}</span>`,
    h.online && up ? `<span class="m">up ${up}</span>` : '',
    !h.online && h.lastSeen ? `<span class="m">last seen ${ago(h.lastSeen)}</span>` : '',
    w.locked === true ? `<span class="fl-lock">${ic('i-lock')}Locked</span>` : w.locked === false ? `<span class="fl-lock">${ic('i-unlock')}Unlocked</span>` : '',
  ].filter(Boolean).join('');

  const rb = S.rebooting[h.id];
  const bootBtn = w.boot && !rb
    ? `<button class="btn sm" data-act="boot" data-host="${esc(h.id)}" aria-expanded="${S.confirm === h.id}">${ic('i-power')}${esc(w.boot.label)}</button>` : '';
  const acts = `<div class="btns fl-acts">
    ${actBtn('screen', h, w.screen, 'Screen', 'i-monitor', w.screen?.online)}
    ${actBtn('shell', h, w.shell, 'Shell', 'i-shell', w.shell?.shellOnline)}
    ${actBtn('files', h, w.shell, 'Files', 'i-folder', w.shell?.shellOnline)}
    ${bootBtn}</div>`;

  const otherOs = w.boot ? (/windows/i.test(w.boot.label) ? 'Windows' : 'Linux') : '';
  const confirm = S.confirm === h.id && w.boot ? `<div class="confirm fl-confirm" role="group" aria-label="Confirm reboot">
      <p><b>Reboot ${esc(h.name)} into ${otherOs}?</b> Sets a one-shot BootNext; the boot after that returns to ${otherOs === 'Windows' ? 'Linux' : 'Windows'} on its own.${h.top?.length ? ` Open now: ${esc(h.top.slice(0, 3).map((p) => p.name).join(', '))}.` : ''}</p>
      <div class="acts"><button class="btn sm" data-act="cancel">Cancel</button><button class="btn sm danger solid" data-act="boot-go" data-host="${esc(h.id)}">Reboot now</button></div></div>` : '';
  const rebootNote = rb ? `<div class="confirm fl-confirm fl-rb"><p><b>Rebooting into ${esc(rb.to)}.</b> <span class="m" data-count="${rb.until}">${Math.max(0, Math.ceil((rb.until - Date.now()) / 1000))} s</span> — this card follows it back.</p></div>` : '';

  const why = !h.online
    ? `<div class="fl-why">${h.away
      ? (w.os === 'windows' ? `Running Windows${w.screen?.online ? ' — Screen works' : ''}. These are the last Linux readings, from ${ago(h.lastSeen)}.` : `Away since ${ago(h.lastSeen)}. These are its last readings.`)
      : `${esc(h.error || 'Not answering')} · ${h.pending ? 'retrying' : `down since ${ago(h.downSince)}`}`}</div>`
    : '';

  const procs = (h.top?.length || h.fans?.length || fin(h.cpu?.watts) || h.battery) ? `<div class="fl-procs">
      ${h.top?.length ? `<span>Top by CPU</span>${h.top.slice(0, 3).map((p) => `<b>${esc(p.name)} <span class="m">${p.cpu >= 10 ? Math.round(p.cpu) : p.cpu}%</span></b>`).join('')}` : ''}
      <span class="m fl-hw">${[
        h.fans?.length ? `fans ${h.fans.map((f) => f.toLocaleString('en-US')).join(' · ')} rpm` : null,
        fin(h.cpu?.watts) ? `CPU ${rnd(h.cpu.watts)} W` : null,
        h.battery ? `battery ${h.battery.pct}%${h.battery.state ? ` ${h.battery.state}` : ''}` : null,
      ].filter(Boolean).join(' · ')}</span></div>` : '';

  return `<section class="panel clip fl-host${h.online ? '' : ' fl-stale'}" data-host="${esc(h.id)}" style="--i:${i}">
    <div class="fl-hh">
      <div class="fl-who"><span class="sic">${ic(hostIcon(h), '')}</span>
        <div><div class="sname fl-name">${esc(h.name)}${osTag}${stateTag}</div><div class="fl-sub">${sub}</div></div></div>
      ${acts}
    </div>
    ${confirm}${rebootNote}${why}
    <div class="hm fl-hm">${cells(h).map((c) => `<div><div class="ml">${esc(c.l)}</div>${mv(c.v, c.u, c.s)}${c.viz}${c.note ? `<div class="note">${esc(c.note)}</div>` : ''}</div>`).join('')}</div>
    <div class="fl-foot">${procs || '<span></span>'}<button class="btn sm ghost fl-dtog" data-act="det" data-host="${esc(h.id)}" aria-expanded="${!!S.det[h.id]}">Details${ic('i-chevdown', 's fl-chev')}</button></div>
    ${hostDetails(h)}
  </section>`;
}

const fmtB = (n) => {
  if (!fin(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let v = n; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};

/** Everything the card leaves out, for the host that asked: facts, every
    filesystem and spare drive, graphics, battery, network, alerts still
    being confirmed, processes and logs where the host serves them. */
function hostDetails(h) {
  if (!S.det[h.id]) return '';
  const kv = (k, v) => (v == null || v === '' ? '' : `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`);
  const facts = `<dl class="fl-kv">
    ${kv('CPU', esc(h.cpu?.model || '—'))}${kv('OS', esc(h.os || '—'))}${kv('Hostname', esc(h.hostname || ''))}
    ${kv('Sampled', esc(ago(h.at)))}${kv('Read by', esc(h.kind))}
    ${h.net ? kv('Network', `<span class="m">↓ ${fmtB(h.net.rx)}/s · ↑ ${fmtB(h.net.tx)}/s</span>`) : ''}
    ${h.battery ? kv('Battery', `<span class="m">${h.battery.pct}%</span> ${esc(h.battery.state || '')}${fin(h.battery.health) ? ` · health ${h.battery.health}%` : ''}${fin(h.battery.watts) ? ` · ${h.battery.watts} W` : ''}`) : ''}
    ${(h.links || []).length ? kv('Links', h.links.map((l) => `<a class="fl-link" href="${esc(l.href)}" target="_blank" rel="noopener">${esc(l.label)}${ic('i-external')}</a>`).join(' ')) : ''}
  </dl>`;
  const fs = (h.disks || []).map((d) => `<div class="fl-fs"><div class="fl-fs-top"><span class="m">${esc(d.label)}</span><span class="m">${fmtB(d.used)} / ${fmtB(d.total)}${fin(d.free) ? ` · ${fmtB(d.free)} free` : ''}</span></div>
      ${fin(d.pct) ? bar(d.pct, d.pct >= 96 ? 'err' : d.pct >= 90 ? 'warn' : null) : ''}
      <div class="fl-fs-meta">${esc([d.device, d.fstype, d.model, d.remote ? 'network' : null].filter(Boolean).join(' · '))}</div></div>`).join('');
  const spare = (h.drives || []).filter((d) => d.mounted === false || !(h.disks || []).length);
  const drives = spare.map((d) => `<div class="fl-fs-meta">${esc(d.device)} · ${esc([d.model, d.kind].filter(Boolean).join(' · '))} · ${fmtB(d.size)} · ${(h.disks || []).length ? 'not mounted' : ''}${fin(d.tempC) ? ` ${rnd(d.tempC)} °C` : ''}</div>`).join('');
  const gpus = !h.gpu && (h.gpus || []).length
    ? `<div class="fl-fs-meta">${h.gpus.map((g) => esc(`${g.model}${g.driver ? ` · ${g.driver}` : ''}${g.inUse ? ' · in use' : ''}`)).join('<br>')}</div>` : '';
  const pend = (h.pendingAlerts || []).length
    ? `<div class="fl-det-sec"><h3>Waiting to confirm</h3>${h.pendingAlerts.map((a) => `<div class="fl-fs-meta">${esc(a.text)} · confirms ${a.confirmsAt ? esc(new Date(a.confirmsAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })) : 'soon'}</div>`).join('')}</div>` : '';
  const muted = (h.muted || []).length ? `<div class="fl-fs-meta">Muted here: ${esc(h.muted.join(', '))}</div>` : '';

  let procs = '';
  if (h.capabilities?.processes) {
    const p = S.procs[h.id] || {};
    procs = `<div class="fl-det-sec"><div class="fl-det-h"><h3>Processes</h3><input class="input fl-q" type="search" placeholder="Filter" value="${esc(p.q || '')}" data-procq="${esc(h.id)}" aria-label="Filter processes"></div>
      ${p.rows ? `<div class="scroll"><table class="t"><thead><tr><th>Process</th><th>User</th><th class="num">CPU</th><th class="num">Memory</th></tr></thead><tbody>
        ${p.rows.map((r) => `<tr><td title="${esc(r.cmdline || r.name)}">${esc(r.name)}</td><td>${esc(r.user || '—')}</td><td class="num m">${(r.cpuPct ?? 0).toFixed(1)}%</td><td class="num m">${fmtB((r.memKb || 0) * 1024)}</td></tr>`).join('') || '<tr><td colspan="4">Nothing matches.</td></tr>'}
      </tbody></table></div>` : '<div class="fl-fs-meta">Reading…</div>'}</div>`;
  }
  let logs = '';
  if (h.capabilities?.logs) {
    const l = S.logs[h.id] || {};
    logs = `<div class="fl-det-sec"><h3>Logs</h3><div class="btns">${(h.services || []).slice(0, 16).map((x) => `<button class="chip" data-act="log" data-host="${esc(h.id)}" data-unit="${esc(x.id)}" aria-pressed="${l.unit === x.id}">${esc(x.id)}</button>`).join('')}</div>
      ${l.unit ? `<pre class="fl-log">${l.busy ? 'Reading…' : esc(l.text || '(empty)')}</pre>` : ''}</div>`;
  }
  return `<div class="fl-det">
    <div class="fl-det-grid"><div class="fl-det-sec"><h3>About</h3>${facts}${muted}</div>
      <div class="fl-det-sec"><h3>Storage</h3>${fs || '<div class="fl-fs-meta">This host does not report storage.</div>'}${drives}${gpus ? `<h3>Graphics</h3>${gpus}` : ''}</div></div>
    ${pend}${procs}${logs}</div>`;
}

function svcGroup(h) {
  const list = (h.services || []).slice().sort((a, b) => (a.ok === b.ok ? a.name.localeCompare(b.name) : a.ok ? 1 : -1));
  if (!list.length) return '';
  const down = list.filter((s) => s.ok === false);
  const open = S.open[h.id] ?? down.length > 0;
  const canRestart = h.capabilities?.actions && h.online;
  const rows = list.map((s) => {
    const key = `${h.id}:${s.id}`;
    const r = S.restarting[key];
    const mem = fin(s.memory) ? `${(s.memory / 1024 ** 2) >= 1024 ? (s.memory / 1024 ** 3).toFixed(1) + ' GB' : Math.round(s.memory / 1024 ** 2) + ' MB'}` : '';
    const detail = s.ok === false
      ? (s.downSince ? `stopped ${ago(s.downSince)}` : (s.detail || 'stopped'))
      : (s.detail || '');
    return `<div class="fl-svc${s.ok === false ? ' bad' : ''}">
      <span class="dot ${s.ok === false ? (s.unknown ? 'warn' : 'err') : 'ok'}"></span>
      <span class="fl-svc-n">${esc(s.name)}</span>
      <span class="fl-svc-d m">${esc(detail)}</span>
      <span class="fl-svc-m m">${esc(mem)}</span>
      ${canRestart ? `<button class="btn sm ghost fl-rs" data-act="restart" data-host="${esc(h.id)}" data-svc="${esc(s.id)}" ${r === 'busy' ? 'aria-busy="true"' : ''}>${r === 'armed' ? 'Confirm' : r === 'busy' ? 'Restarting…' : `${ic('i-restart')}<span>Restart</span>`}</button>` : '<span></span>'}
    </div>`;
  }).join('');
  return `<details class="panel clip fl-svcs" data-host="${esc(h.id)}" ${open ? 'open' : ''}>
    <summary><span class="dot ${down.length ? 'err' : h.away ? '' : 'ok'}"></span><b>${esc(h.name)}</b>
      <span class="m fl-count">${down.length ? `${down.length} stopped · ` : ''}${list.length - down.length}/${list.length} running</span>
      ${h.away ? '<span class="tag">last known</span>' : ''}${ic('i-chevdown', 's fl-chev')}</summary>
    <div class="fl-svc-list">${rows}</div>
  </details>`;
}

function alertsBlock(d) {
  const list = d.alerts || [];
  if (!list.length) return '';
  return `<section class="sec fl-alerts"><div class="sh"><h2>Needs attention</h2><span class="cnt${list.some((a) => a.severity === 'err') ? ' err' : ''}">${list.length}</span></div>
    <ul class="panel needs">${list.map((a) => `<li class="need"><span class="sev ${a.severity === 'err' ? 'err' : 'warn'}">${ic(a.kind.includes('temp') ? 'i-temp' : a.kind === 'unreachable' ? 'i-power' : a.kind.startsWith('disk') ? 'i-archive' : 'i-alert', '')}</span>
      <div class="b"><div class="t">${esc(a.heldMin ? `${a.text} for ${a.heldMin} min` : a.text)}${a.blocking ? tag('Blocking', 'err') : ''}</div>${a.hint ? `<div class="d">${esc(a.hint)}</div>` : ''}</div>
      <div class="mm m">${esc(a.hostName || a.host)}</div></li>`).join('')}</ul></section>`;
}

function render() {
  if (!root || stopSession) return;
  const d = S.data;
  if (!d) {
    root.innerHTML = `<div class="page fl"><div class="ph"><div><h1>Machines</h1><p>${S.error ? esc(S.error) : 'Reading every machine…'}</p></div></div>
      ${S.error ? `<div class="panel"><div class="empty">${ic('i-alert', '')}<b>Could not read the fleet</b><p>${esc(S.error)}</p><button class="btn sm" data-act="retry">Try again</button></div></div>` : '<div class="fl-hosts">' + '<div class="panel skeleton fl-sk"></div>'.repeat(3) + '</div>'}</div>`;
    return;
  }
  const hosts = d.hosts || [];
  const dual = hosts.find((h) => (h.remote?.devices || []).length > 1);
  const sub = `${hosts.length} host${hosts.length === 1 ? '' : 's'} · ${d.online} up${dual ? ` · ${esc(dual.name)} boots Linux or Windows` : ''}`;
  const services = hosts.filter((h) => !h.away).flatMap((h) => h.services || []);
  const stopped = services.filter((s) => s.ok === false).length;
  const scrollY = root.closest('.main')?.scrollTop;

  const typing = document.activeElement?.dataset?.procq;
  const caret = typing ? document.activeElement.selectionStart : null;
  const settled = S.rendered;
  S.rendered = true;
  root.innerHTML = `<div class="page fl${settled ? ' fl-settled' : ''}">
    <div class="ph"><div><h1>Machines</h1><p>${sub}</p></div>
      <div class="acts"><div class="seg sm" data-seg="fl-win" aria-label="Chart window"><span class="ind"></span>
        <button data-act="win" data-v="2h" aria-pressed="${S.win === '2h'}">2 h</button>
        <button data-act="win" data-v="24h" aria-pressed="${S.win === '24h'}">24 h</button></div>
        <span class="upd m"><span class="dot ${S.live ? 'ok live' : 'warn'}"></span> ${S.live ? 'Live' : 'Reconnecting'} · ${clock(d.at)}</span></div></div>
    ${alertsBlock(d)}
    <section class="sec" id="fl-hosts"><div class="fl-hosts">${hosts.map(hostCard).join('')}</div></section>
    <section class="sec" id="fl-services"><div class="sh"><h2>Services</h2><span class="note">${stopped ? `${stopped} stopped · ` : ''}${services.length - stopped} of ${services.length} running</span></div>
      <div class="fl-svc-groups">${hosts.map(svcGroup).join('')}</div></section>
  </div>`;
  ui.placeSegs?.(root);
  if (typing) {
    const q = root.querySelector(`[data-procq="${CSS.escape(typing)}"]`);
    if (q) { q.focus(); q.setSelectionRange(caret, caret); }
  }
  if (S.focus) {
    const target = S.focus === 'services' ? root.querySelector('#fl-services') : S.focus === 'alerts' ? root.querySelector('.fl-alerts') : null;
    S.focus = null;
    target?.scrollIntoView({ block: 'start' });
  } else if (fin(scrollY) && root.closest('.main')) {
    root.closest('.main').scrollTop = scrollY;
  }
}

/* ── actions ──────────────────────────────────────────────────────────── */

function remoteCtx() {
  const api = async (p, o = {}) => {
    const res = await fetch(`${remoteBase}/api${p.startsWith('/') ? p : `/${p}`}`, { headers: { 'content-type': 'application/json', ...(o.headers || {}) }, ...o });
    if (!res.ok) {
      let detail = res.statusText;
      try { const j = await res.json(); detail = j.detail || j.error || detail; } catch { /* not json */ }
      throw new Error(detail);
    }
    return res.status === 204 ? null : res.json();
  };
  const streams = [];
  const sse = (p, h = {}) => {
    const es = new EventSource(`${remoteBase}/api${p}`);
    for (const [n, fn] of Object.entries(h.events || {})) es.addEventListener(n, (e) => { try { fn(JSON.parse(e.data), e); } catch { fn(e.data, e); } });
    streams.push(es);
    return { stop: () => es.close() };
  };
  return { ctx: { ...ctx, base: remoteBase, api, sse, moduleId: 'remote' }, close: () => streams.forEach((s) => s.close()) };
}

function css(id, href) {
  if (document.getElementById(id)) return;
  const l = document.createElement('link');
  l.id = id; l.rel = 'stylesheet'; l.href = href;
  document.head.appendChild(l);
}

async function openWay(kind, deviceId) {
  const h = S.data.hosts.find((x) => (x.remote?.devices || []).some((d) => d.id === deviceId));
  const dev = h?.remote.devices.find((d) => d.id === deviceId);
  const file = kind === 'screen' ? 'session' : kind;
  try {
    const mod = await import(`${remoteBase}/ui/${file}.js`);
    css(`rm-${file}-css`, `${remoteBase}/ui/${file}.css`);
    const r = remoteCtx();
    const start = kind === 'screen' ? mod.startSession : kind === 'shell' ? mod.startShell : mod.startFiles;
    root.innerHTML = '';
    const stop = start({
      host: root, ctx: r.ctx, deviceId, deviceName: dev?.name || deviceId,
      onExit: () => { closeWay(); },
    });
    stopSession = () => { try { stop?.(); } finally { r.close(); } };
  } catch (e) {
    stopSession = null;
    ctx.toast('err', `Could not open ${kind}`, e.message);
    render();
  }
}

function closeWay() {
  const s = stopSession;
  stopSession = null;
  try { s?.(); } catch { /* already gone */ }
  render();
}

async function restart(hostId, svc) {
  const key = `${hostId}:${svc}`;
  if (S.restarting[key] !== 'armed') {
    // Two taps, three seconds apart at most: quiet, but not one stray tap.
    S.restarting[key] = 'armed';
    render();
    setTimeout(() => { if (S.restarting[key] === 'armed') { delete S.restarting[key]; render(); } }, 3000);
    return;
  }
  S.restarting[key] = 'busy';
  render();
  try {
    await ctx.api(`/hosts/${encodeURIComponent(hostId)}/action`, { method: 'POST', body: JSON.stringify({ action: `restart-${svc}` }) });
    ctx.toast('ok', `Restarted ${svc}`, '');
  } catch (e) {
    ctx.toast('err', `Could not restart ${svc}`, e.message);
  } finally {
    delete S.restarting[key];
    render();
  }
}

async function boot(hostId) {
  const h = S.data.hosts.find((x) => x.id === hostId);
  const w = ways(h);
  const to = /windows/i.test(w.boot?.label || '') ? 'windows' : 'linux';
  S.confirm = null;
  try {
    await ctx.api(`/hosts/${encodeURIComponent(hostId)}/boot`, { method: 'POST', body: JSON.stringify({ confirm: true, to }) });
    S.rebooting[hostId] = { to: to === 'windows' ? 'Windows' : 'Linux', until: Date.now() + 90_000 };
    setTimeout(() => { delete S.rebooting[hostId]; render(); }, 90_000);
  } catch (e) {
    ctx.toast('err', `Could not reboot ${h.name}`, e.message);
  }
  render();
}

async function loadProcs(hostId) {
  const p = S.procs[hostId] || (S.procs[hostId] = { q: '' });
  try {
    const r = await ctx.api(`/hosts/${encodeURIComponent(hostId)}/processes?limit=30${p.q ? `&q=${encodeURIComponent(p.q)}` : ''}`);
    p.rows = r.processes || r || [];
  } catch (e) { p.rows = []; ctx.toast('warn', 'Could not list processes', e.message); }
  render();
}

async function loadLog(hostId, unit) {
  S.logs[hostId] = { unit, busy: true };
  render();
  try {
    const r = await ctx.api(`/hosts/${encodeURIComponent(hostId)}/logs/${encodeURIComponent(unit)}`);
    S.logs[hostId] = { unit, text: Array.isArray(r.lines) ? r.lines.join('\n') : (r.lines || r.error || '(nothing logged)') };
  } catch (e) { S.logs[hostId] = { unit, text: e.message }; }
  render();
}

function onInput(e) {
  const q = e.target.closest?.('[data-procq]');
  if (!q) return;
  const id = q.dataset.procq;
  (S.procs[id] || (S.procs[id] = {})).q = q.value;
  clearTimeout(onInput.t);
  onInput.t = setTimeout(() => loadProcs(id), 300);
}

async function loadLong() {
  const ids = (S.data?.hosts || []).map((h) => h.id).filter((id) => !S.long[id] || Date.now() - S.long[id].at > 60_000);
  await Promise.all(ids.map(async (id) => {
    try {
      const r = await ctx.api(`/hosts/${encodeURIComponent(id)}/history?window=24h`);
      S.long[id] = { at: Date.now(), points: r.points || [] };
    } catch { /* that card keeps its 2 h line */ }
  }));
  render();
}

function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b || !root.contains(b)) return;
  const act = b.dataset.act;
  const host = b.dataset.host;
  if (b.getAttribute('aria-disabled') === 'true') {
    ctx.toast('warn', b.title || 'Not available', '');
    return;
  }
  if (act === 'retry') { refresh(); return; }
  if (act === 'screen' || act === 'shell' || act === 'files') { openWay(act, b.dataset.dev); return; }
  if (act === 'boot') { S.confirm = S.confirm === host ? null : host; render(); return; }
  if (act === 'cancel') { S.confirm = null; render(); return; }
  if (act === 'boot-go') { boot(host); return; }
  if (act === 'restart') { restart(host, b.dataset.svc); return; }
  if (act === 'det') {
    S.det[host] = !S.det[host];
    const h = S.data.hosts.find((x) => x.id === host);
    if (S.det[host] && h?.capabilities?.processes && !S.procs[host]?.rows) loadProcs(host);
    render();
    return;
  }
  if (act === 'log') { loadLog(host, b.dataset.unit); return; }
  if (act === 'win') {
    S.win = b.dataset.v;
    if (S.win === '24h') loadLong();
    else render();
  }
}

function onToggle(e) {
  const d = e.target.closest?.('details.fl-svcs');
  if (d) S.open[d.dataset.host] = d.open;
}

async function refresh() {
  try {
    S.data = await ctx.api('/hosts');
    S.error = null;
  } catch (e) {
    S.error = e.message;
  }
  render();
}

async function findRemote() {
  if (!ctx.base) return null;            // standalone: no console, no gateway beside us
  const base = ctx.base.replace(/[^/]+$/, 'remote');
  try {
    const r = await fetch(`${base}/module.json`, { signal: AbortSignal.timeout(4000) });
    return r.ok ? base : null;
  } catch { return null; }
}

async function loadUi() {
  for (const u of ['/ojee-ui3.js', `${ctx.base}/ojee-ui3.js`]) {
    try { return await import(u); } catch { /* next */ }
  }
  throw new Error('ojee-ui3.js not found');
}

export default {
  async mount(el, context) {
    root = el;
    ctx = context;
    css('fl-css', `${ctx.base}/ui/fleet.css`);
    ui = await loadUi();
    S.focus = ctx.view && ctx.view !== 'machines' ? ctx.view : null;
    root.addEventListener('click', onClick);
    root.addEventListener('toggle', onToggle, true);
    root.addEventListener('input', onInput);
    render();
    [remoteBase] = await Promise.all([findRemote(), refresh()]);
    render();
    ctx.sse('/events', {
      onOpen: () => { S.live = true; },
      onError: () => { S.live = false; render(); },
      events: { state: (s) => { S.data = s; S.live = true; S.error = null; render(); } },
    });
    // The reboot countdown is the only thing that moves between polls.
    tickTimer = setInterval(() => {
      root?.querySelectorAll('[data-count]').forEach((n) => { n.textContent = `${Math.max(0, Math.ceil((Number(n.dataset.count) - Date.now()) / 1000))} s`; });
    }, 1000);
  },

  async setView(view) {
    if (stopSession) closeWay();
    S.focus = view && view !== 'machines' ? view : null;
    render();
  },

  async unmount() {
    if (stopSession) { try { stopSession(); } catch { /* gone */ } }
    stopSession = null;
    clearInterval(tickTimer);
    root?.removeEventListener('click', onClick);
    root?.removeEventListener('toggle', onToggle, true);
    root = null;
    ctx = null;
  },
};
