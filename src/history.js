/**
 * Long history: one point per host per minute, kept for two days, on disk.
 *
 * The poller's own ring is fifteen minutes of 10-second samples, in memory —
 * right for "what is it doing now", useless for "was the laptop hot all
 * evening" and gone on every redeploy. This keeps a minute's average (and the
 * minute's peak temperature, because a 98 °C spike averaged into 80 is the
 * thing the chart must not hide) for 48 hours, and writes it to one JSON file
 * so a restart costs nothing.
 *
 * 3 hosts × 2880 minutes × ~90 bytes ≈ 800 KB. One atomic write a minute.
 */

import fs from 'node:fs';
import path from 'node:path';

const FIELDS = ['cpu', 'temp', 'mem', 'swap', 'gpu', 'gpuTemp', 'watts', 'load'];
const MINUTE = 60_000;

const round1 = (v) => Math.round(v * 10) / 10;

export class HistoryStore {
  /**
   * @param {object} o
   * @param {string|null} o.file   where to persist; null keeps it in memory
   * @param {number} o.keepMs      how far back to keep (default 48 h)
   */
  constructor({ file = null, keepMs = 48 * 3600_000, now = Date.now } = {}) {
    this.file = file;
    this.keepMs = keepMs;
    this.now = now;
    /** host id -> [{t, cpu, temp, tempMax, mem, ...}] one per minute, oldest first */
    this.points = new Map();
    /** host id -> the minute being accumulated: {t, n: {field: count}, sum: {field: total}, tempMax} */
    this.open = new Map();
    this.dirty = false;
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const cutoff = this.now() - this.keepMs;
      for (const [id, list] of Object.entries(raw.hosts || {})) {
        if (Array.isArray(list)) this.points.set(id, list.filter((p) => p && p.t >= cutoff));
      }
    } catch (e) {
      // A missing file is a first start; a corrupt one is not worth refusing
      // to start over — the chart starts empty and fills again.
      if (e.code !== 'ENOENT') console.warn(`[history] ${this.file}: ${e.message} — starting empty`);
    }
  }

  /** Feed one sample for a host (a normalized host state). */
  add(id, h, t = this.now()) {
    if (!h || h.online === false) return;
    const minute = Math.floor(t / MINUTE) * MINUTE;
    let cur = this.open.get(id);
    if (cur && cur.t !== minute) {
      this.close(id, cur);
      cur = null;
    }
    if (!cur) {
      cur = { t: minute, n: {}, sum: {}, tempMax: null };
      this.open.set(id, cur);
    }
    const v = {
      cpu: h.cpu?.pct,
      temp: h.cpu?.tempC,
      mem: Number.isFinite(h.mem?.pct) ? h.mem.pct : null,
      swap: h.swap && h.swap.total > 0 ? (h.swap.used / h.swap.total) * 100 : null,
      gpu: h.gpu?.pct,
      gpuTemp: h.gpu?.tempC,
      watts: h.cpu?.watts ?? null,
      load: Array.isArray(h.cpu?.load) ? h.cpu.load[0] : null,
    };
    for (const f of FIELDS) {
      if (!Number.isFinite(v[f])) continue;
      cur.sum[f] = (cur.sum[f] || 0) + v[f];
      cur.n[f] = (cur.n[f] || 0) + 1;
    }
    if (Number.isFinite(v.temp)) cur.tempMax = Math.max(cur.tempMax ?? -Infinity, v.temp);
  }

  close(id, cur) {
    const p = { t: cur.t };
    for (const f of FIELDS) p[f] = cur.n[f] ? round1(cur.sum[f] / cur.n[f]) : null;
    p.tempMax = Number.isFinite(cur.tempMax) ? round1(cur.tempMax) : null;
    const list = this.points.get(id) || [];
    list.push(p);
    const cutoff = this.now() - this.keepMs;
    while (list.length && list[0].t < cutoff) list.shift();
    this.points.set(id, list);
    this.dirty = true;
  }

  /**
   * Points for one host over the last `windowMs`, the open minute included,
   * so a chart is never a minute behind the card above it.
   */
  series(id, windowMs = 2 * 3600_000) {
    const from = this.now() - windowMs;
    const out = (this.points.get(id) || []).filter((p) => p.t >= from);
    const cur = this.open.get(id);
    if (cur) {
      const p = { t: cur.t };
      for (const f of FIELDS) p[f] = cur.n[f] ? round1(cur.sum[f] / cur.n[f]) : null;
      p.tempMax = Number.isFinite(cur.tempMax) ? round1(cur.tempMax) : null;
      out.push(p);
    }
    return out;
  }

  /** How long (ms) a field has stayed at or above a value, counting back from now. */
  heldAbove(id, field, value) {
    const list = this.series(id, this.keepMs);
    let since = null;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const v = field === 'temp' ? (list[i].tempMax ?? list[i].temp) : list[i][field];
      if (!Number.isFinite(v) || v < value) break;
      since = list[i].t;
    }
    return since == null ? 0 : this.now() - since;
  }

  save() {
    if (!this.file || !this.dirty) return;
    const body = JSON.stringify({ v: 1, savedAt: this.now(), hosts: Object.fromEntries(this.points) });
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (e) {
      console.warn(`[history] could not save ${this.file}: ${e.message}`);
    }
  }
}
