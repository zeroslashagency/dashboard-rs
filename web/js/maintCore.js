/* VMC God-mode — Maintenance engine.
 *
 * Everything the Maintenance console reasons over, computed from REAL collector
 * signals. Reuses metrics.js (cycle/segment/downtime math) and analyticsCore.js
 * (Theil-Sen, stats) so the numbers agree with KPI/Statistics. Nothing invented:
 * where a controller doesn't emit a signal, the leg reports "unavailable" rather
 * than a fabricated value.
 *
 * Four products:
 *   1. health(m,win)      -> composite 0-100 with per-leg breakdown
 *   2. predict(m,win)     -> ranked "before the event" watchlist:
 *        - tool-wear slope projection (Theil-Sen on the wear-offset tables ->
 *          hours until a slot crosses the replace limit)
 *        - service / spindle odometer countdowns (estimated — the controller
 *          emits a lifetime runtime odometer but no last-service reset marker,
 *          so these are flagged estimated:true and labelled "est.")
 *        - cycle-time degradation drift (Theil-Sen ms/hour)
 *        - alarm-rate trend (events per day over the window)
 *   3. rollup            -> daily/weekly/monthly health %, accumulated from real
 *        per-day snapshots persisted in localStorage. History on the box only
 *        spans ~38h, so weekly/monthly grow as real days are observed — every
 *        panel says how many real days back it actually has.
 *   4. timeline(m,win)   -> maintenance-relevant events auto-read from the logs
 *        (alarm asserts/clears, e-stop, feed-holds, tool changes, program
 *        changes), merged chronologically.
 */

import { computeMachine } from "./metrics.js";
import { theilSen, stats, segmentStates, bucketOfState } from "./analyticsCore.js";

export const WEAR_WARN = 0.1;    // mm dialed-in offset that flags a worn tool
export const WEAR_LIMIT = 0.25;  // mm offset at which we call for replacement
export const SERVICE_INTERVAL_H = 500;   // machine-runtime hours between service
export const SPINDLE_INTERVAL_H = 250;   // spindle-on hours between spindle service

const SNAP_KEY = "vmc_maint_daily";       // { machine: { "YYYY-MM-DD": snapshot } }
const SNAP_MAX_DAYS = 45;                  // keep ~6 weeks of daily snapshots

/* ---------- composite health ----------
 * Five legs, each 0-100 from a real signal. The score is the weighted mean of
 * the legs that have data; weights renormalize when a leg is unavailable, so a
 * machine that doesn't emit tool tables isn't punished for it.
 */
export const LEG_WEIGHTS = { availability: 0.30, reliability: 0.25, tool: 0.20, stability: 0.15, comms: 0.10 };

export async function health(dataLayer, m, win, audit) {
  const id = m.machine_id;
  let x = null;
  try { x = await computeMachine(dataLayer, id, win); } catch (_) { x = null; }
  const wear = await readWear(dataLayer, id);

  const legs = {};

  // availability — run share of attended time (run+pause+idle), from rstat.
  if (x && (x.buckets.run + x.buckets.pause + x.buckets.idle) > 0) {
    legs.availability = { value: clamp(x.availability), label: "Availability", detail: `${pct(x.availability)} of attended time cutting` };
  }

  // reliability — penalize alarm/e-stop asserts over the window.
  if (x) {
    const al = x.alarmEvents.count, es = x.estopEvents.count;
    const v = clamp(100 - al * 15 - es * 25);
    legs.reliability = { value: v, label: "Reliability", detail: faultText(al, es) };
  }

  // tool headroom — worst dialed-in wear offset vs the replace limit.
  if (wear.slots.length) {
    const worst = wear.slots[0].mag;
    const v = clamp((1 - worst / WEAR_LIMIT) * 100);
    legs.tool = { value: v, label: "Tool headroom", detail: worst >= WEAR_WARN ? `worst T${wear.slots[0].slot} at ${worst.toFixed(2)}mm` : "all tools nominal" };
  } else if (wear.observed) {
    legs.tool = { value: 100, label: "Tool headroom", detail: "all tools nominal" };
  }

  // cycle stability — tight, repeatable cycles = healthy. CV of cycle time.
  if (x && x.cstats.n >= 3 && x.cstats.mean) {
    const cv = x.cstats.sd / x.cstats.mean;
    legs.stability = { value: clamp(100 - cv * 100), label: "Cycle stability", detail: `CV ${(cv * 100).toFixed(0)}% over ${x.cstats.n} cycles` };
  }

  // comms — collector integrity for this machine from the gapless audit.
  const ca = commsLeg(audit, id);
  if (ca) legs.comms = ca;

  // weighted mean over available legs
  let num = 0, den = 0;
  for (const [k, leg] of Object.entries(legs)) { num += leg.value * LEG_WEIGHTS[k]; den += LEG_WEIGHTS[k]; }
  const score = den > 0 ? num / den : null;

  return { id, online: !!m.online, score, legs, metrics: x, wear };
}

function commsLeg(audit, id) {
  if (!audit) return null;
  const a = (audit.machines || []).find((r) => r.machine === id);
  if (!a) return null;
  const lag = Number(a.max_lag) || 0;
  if (!a.gapless) {
    // Derive the penalty from the REAL backlog + lag — never a flat literal.
    // Each behind-event costs 2 pts, each second of lag past 30s costs 1/3 pt.
    const behind = Number(a.behind_events) || 0;
    const v = clamp(100 - behind * 2 - Math.max(0, lag - 30) / 3);
    return { value: v, label: "Comms", detail: `${behind} behind · lag ${lag}` };
  }
  const v = clamp(100 - Math.max(0, lag - 30) / 3);
  return { value: v, label: "Comms", detail: `gapless · lag ${lag}` };
}

function faultText(al, es) {
  if (!al && !es) return "no alarms or e-stops";
  const p = [];
  if (es) p.push(`${es} e-stop${es > 1 ? "s" : ""}`);
  if (al) p.push(`${al} alarm assert${al > 1 ? "s" : ""}`);
  return p.join(" · ");
}

/* ---------- predictions ("before the event") ----------
 * Returns a flat list of dated risks for one machine, each with a severity and a
 * "when". The console merges these across the fleet and sorts by soonest. */
export async function predict(dataLayer, m, win) {
  const id = m.machine_id;
  const now = Date.now();
  const out = [];

  // 1) tool-wear slope projection
  const wp = await projectWear(dataLayer, id);
  for (const p of wp) out.push(p);

  // 2) service / spindle odometer countdowns (estimated — no reset marker emitted)
  const [rt, sp] = await Promise.all([
    dataLayer.history(id, "machineruntime"),
    dataLayer.history(id, "spindletime"),
  ]);
  let metrics = null;
  try { metrics = await computeMachine(dataLayer, id, win); } catch (_) {}
  const spanMs = (win.to - win.from) || 1;
  const dailyRunH = metrics ? (metrics.buckets.run / spanMs) * 24 : null;

  const svc = serviceCountdown(rt, SERVICE_INTERVAL_H, "service", dailyRunH, now);
  if (svc) out.push(svc);
  const spc = serviceCountdown(sp, SPINDLE_INTERVAL_H, "spindle service", dailyRunH, now);
  if (spc) out.push(spc);

  // 3) cycle-time degradation drift
  if (metrics && metrics.cycles.length >= 5) {
    const slope = theilSen(metrics.cycles.map((c) => ({ x: c.end, y: c.dur })));
    if (slope != null) {
      const perH = (slope * 3600000) / 1000; // seconds/hour
      if (perH > 1) {
        out.push({
          machine: id, kind: "drift", sev: perH > 5 ? "warn" : "info",
          title: "Cycle time degrading", value: `+${perH.toFixed(1)}s/h`,
          detail: `median ${fmtSec(metrics.cstats.median)} and climbing — check tool/feed`,
          etaMs: null,
        });
      }
    }
  }

  // 4) alarm-rate trend
  if (metrics) {
    const days = spanMs / 86400000;
    const rate = days > 0 ? (metrics.alarmEvents.count + metrics.estopEvents.count) / days : 0;
    if (rate >= 1) {
      out.push({
        machine: id, kind: "faultrate", sev: rate >= 4 ? "warn" : "info",
        title: "Elevated fault rate", value: `${rate.toFixed(1)}/day`,
        detail: faultText(metrics.alarmEvents.count, metrics.estopEvents.count),
        etaMs: null,
      });
    }
  }

  return out;
}

function serviceCountdown(rows, intervalH, label, dailyRunH, now) {
  const last = rows && rows.length ? Number(rows[rows.length - 1].num) : null;
  if (!Number.isFinite(last)) return null;       // odometer not emitted -> no countdown at all
  const runH = last / 3600;
  // HONEST LIMITATION: the controller emits a lifetime runtime odometer but NO
  // last-service reset marker (confirmed absent from /api/events and dataitems).
  // So "since service" is an ASSUMPTION (serviced at each interval multiple), not
  // a measurement. We surface it as an estimate and label it as such — never as
  // "measured". Replace this with a real reset event the day the controller emits one.
  const since = runH % intervalH;                // assumed origin — see note above
  const remainH = intervalH - since;
  const daysToDue = dailyRunH && dailyRunH > 0 ? remainH / dailyRunH : null;
  const pctUsed = (since / intervalH) * 100;
  const sev = pctUsed > 90 ? "warn" : pctUsed > 75 ? "soon" : "ok";
  if (sev === "ok") return null;                 // only surface when it's actually approaching
  return {
    machine: null, kind: "service", sev: sev === "warn" ? "warn" : "info",
    estimated: true,                             // flag so the UI can mark it "est."
    title: label === "service" ? "Machine service (est.)" : "Spindle service (est.)",
    value: `~${Math.round(remainH)}h left`,
    detail: `${Math.round(runH)}h lifetime runtime · assumes ${intervalH}h interval (no reset marker)${daysToDue != null ? ` · ~${daysToDue.toFixed(1)} days at current pace` : ""}`,
    etaMs: daysToDue != null ? now + daysToDue * 86400000 : null,
    pctUsed,
  };
}

/* ---------- tool-wear reading + projection ---------- */
async function readWear(dataLayer, id) {
  const [tids, dwear, lwear] = await Promise.all([
    dataLayer.history(id, "toolid"),
    dataLayer.history(id, "diamwear"),
    dataLayer.history(id, "lengthwear"),
  ]);
  const observed = dwear.length > 0 || lwear.length > 0 || tids.length > 0;
  const dLast = dwear.length ? csv(dwear[dwear.length - 1].val) : [];
  const lLast = lwear.length ? csv(lwear[lwear.length - 1].val) : [];
  const n = Math.max(dLast.length, lLast.length);
  const slots = [];
  for (let i = 0; i < n; i++) {
    const d = Number.isFinite(dLast[i]) ? dLast[i] : 0;
    const l = Number.isFinite(lLast[i]) ? lLast[i] : 0;
    const mag = Math.max(Math.abs(d), Math.abs(l));
    if (mag >= WEAR_WARN) slots.push({ slot: i + 1, diam: d, len: l, mag });
  }
  slots.sort((a, b) => b.mag - a.mag);
  return { observed, slots, dwear, lwear };
}

/* Theil-Sen slope of |wear| per slot -> hours until it reaches WEAR_LIMIT.
 * diamwear and lengthwear are independent CSV series; we project each column of
 * each and keep the soonest crossing per slot. */
async function projectWear(dataLayer, id) {
  const [dwear, lwear] = await Promise.all([
    dataLayer.history(id, "diamwear"),
    dataLayer.history(id, "lengthwear"),
  ]);
  const bySlot = new Map(); // slot -> soonest projection

  const scan = (rows, axis) => {
    if (!rows || rows.length < 4) return;
    const cols = new Map(); // colIndex -> [{x,y}]
    for (const r of rows) {
      const vals = csv(r.val);
      for (let j = 0; j < vals.length; j++) {
        if (!Number.isFinite(vals[j])) continue;
        if (!cols.has(j)) cols.set(j, []);
        cols.get(j).push({ x: r.ts, y: Math.abs(vals[j]) });
      }
    }
    for (const [j, pts] of cols) {
      if (pts.length < 4) continue;
      const cur = pts[pts.length - 1].y;
      if (cur >= WEAR_LIMIT) continue;            // already over the line — handled as current, not predicted
      const slope = theilSen(pts);                 // mm per ms
      if (slope == null || slope <= 0) continue;
      const msToLimit = (WEAR_LIMIT - cur) / slope;
      const hours = msToLimit / 3600000;
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 60) continue; // ignore >60-day-out noise
      const slot = j + 1;
      const cand = { slot, axis, cur, slope, hours };
      const prev = bySlot.get(slot);
      if (!prev || hours < prev.hours) bySlot.set(slot, cand);
    }
  };
  scan(dwear, "Ø");
  scan(lwear, "L");

  const now = Date.now();
  return [...bySlot.values()].map((c) => ({
    machine: id, kind: "tool", sev: c.hours < 24 ? "warn" : "info",
    title: `Tool T${c.slot} wearing out`,
    value: `${fmtHours(c.hours)} to limit`,
    detail: `${c.axis} offset ${c.cur.toFixed(2)}mm → ${WEAR_LIMIT}mm at ${(c.slope * 3600000 * 1000).toFixed(2)}µm/h`,
    etaMs: now + c.hours * 3600000,
  }));
}

/* ---------- daily / weekly / monthly rollup ----------
 * Persist one snapshot per machine per local day. Re-upsert today's snapshot on
 * every refresh; weekly/monthly are means over the real snapshots we actually
 * hold. Returns the windows plus how many real days each is based on. */
export function recordDaily(id, score, extra) {
  if (score == null) return;
  const all = loadSnaps();
  const day = todayKey();
  const byMachine = all[id] || (all[id] = {});
  byMachine[day] = { d: day, score: Math.round(score), ...extra, ts: Date.now() };
  // prune old
  const keys = Object.keys(byMachine).sort();
  while (keys.length > SNAP_MAX_DAYS) delete byMachine[keys.shift()];
  saveSnaps(all);
}

export function rollup(id) {
  const all = loadSnaps();
  const snaps = Object.values(all[id] || {}).sort((a, b) => (a.d < b.d ? 1 : -1)); // newest first
  const span = (n) => {
    const xs = snaps.slice(0, n).map((s) => s.score).filter((v) => Number.isFinite(v));
    if (!xs.length) return { avg: null, days: 0, want: n };
    return { avg: xs.reduce((a, b) => a + b, 0) / xs.length, days: xs.length, want: n };
  };
  return {
    today: snaps.length ? snaps[0].score : null,
    daily: span(1), weekly: span(7), monthly: span(30),
    series: snaps.slice(0, 30).reverse(), // oldest->newest for sparkline
  };
}

function loadSnaps() { try { return JSON.parse(localStorage.getItem(SNAP_KEY) || "{}"); } catch (_) { return {}; } }
function saveSnaps(o) { try { localStorage.setItem(SNAP_KEY, JSON.stringify(o)); } catch (_) {} }
function todayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ---------- maintenance timeline (auto-read from the logs) ----------
 * Pull the event-bearing items over the window and turn transitions into a
 * single chronological maintenance log. Every entry is a real recorded change. */
export async function timeline(dataLayer, id, win) {
  const [aalarms, estop, ncprog, toolid, rstat] = await Promise.all([
    dataLayer.historyWindow(id, "aalarms", win),
    dataLayer.historyWindow(id, "estop", win),
    dataLayer.historyWindow(id, "ncprog", win),
    dataLayer.historyWindow(id, "toolid", win),
    dataLayer.historyWindow(id, "rstat", win),
  ]);
  const ev = [];
  const push = (ts, kind, sev, text) => ev.push({ machine: id, ts, kind, sev, text });

  const alarmActive = (v) => {
    const s = String(v || "").trim().toUpperCase();
    return s && !["NO ACTIVE ALARMS", "NONE", "OK", ""].includes(s);
  };
  let wasAl = false;
  for (const r of aalarms) {
    const on = alarmActive(r.val);
    if (on && !wasAl) push(r.ts, "alarm", "crit", `Alarm asserted — ${String(r.val).slice(0, 60)}`);
    if (!on && wasAl) push(r.ts, "alarm", "ok", "Alarm cleared");
    wasAl = on;
  }

  let wasEs = false;
  for (const r of estop) {
    const on = String(r.val || "").toUpperCase() !== "ARMED" && String(r.val || "").trim() !== "";
    if (on && !wasEs) push(r.ts, "estop", "crit", "E-STOP asserted");
    if (!on && wasEs) push(r.ts, "estop", "ok", "E-STOP released");
    wasEs = on;
  }

  let prevProg = null;
  for (const r of ncprog) {
    if (r.val && r.val !== prevProg) { if (prevProg !== null) push(r.ts, "program", "info", `Program → ${r.val}`); prevProg = r.val; }
  }

  // feed-holds: pause segments from rstat
  const segs = segmentStates(rstat, win);
  for (const s of segs) {
    if (bucketOfState(s.state) === "pause" && s.dur > 30000) {
      push(s.from, "hold", "warn", `Paused (${s.state}) ${fmtDur(s.dur)}`);
    }
  }

  // tool-table churn: a change in the active tool carousel string
  let prevTool = null;
  for (const r of toolid) {
    if (r.val && r.val !== prevTool) { if (prevTool !== null) push(r.ts, "tool", "info", "Tool table changed"); prevTool = r.val; }
  }

  return ev.sort((a, b) => b.ts - a.ts);
}

/* ---------- small format/util helpers ---------- */
function clamp(v, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, v)); }
function pct(v) { return v == null ? "—" : `${Math.round(v)}%`; }
function csv(s) { return String(s == null ? "" : s).split(",").map((t) => parseFloat(t)); }
function fmtSec(ms) { return ms == null ? "—" : `${(ms / 1000).toFixed(0)}s`; }
function fmtHours(h) {
  if (h == null || !Number.isFinite(h)) return "—";
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}
function fmtDur(ms) {
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : `${s}s`;
}
export { fmtHours, fmtDur, fmtSec };
