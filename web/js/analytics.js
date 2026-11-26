/* VMC God-mode — Overall Streamgraph Flow & Tactile Pattern Analytics.
 *
 * Answers "what happened, when, and why" across the entire fleet and down to
 * every individual VMC from 100% real MTConnect history (rstat, m30c1, fdovrd,
 * rovrd, ssovrd, estop, aalarms) and /api/gap_audit:
 *
 *   Zone 1 — Asymmetric Hero Flow:
 *     - Left: Fleet Execution Flow Report (3 period-compared KPIs, symmetric
 *       multi-layer glowing streamgraph with checkpoints, clickable machine table)
 *     - Right Top: Crimson Downtime & Fault Loss symmetric flow card
 *     - Right Bottom: Violet-Amber Quality & Override Discipline flow card
 *   Zone 2 — 4 Tactile Patterned Diagnostic Widgets:
 *     - OEE-Lite Wave Progress Bar + Hatched Remaining Circle
 *     - Availability 50-Dot Pattern Matrix Hero
 *     - Downtime Mix Hatched-Ring Radial Sector Donut
 *     - Output & Cutting Cadence Diagonal-Stripe Area Chartline
 *   Zone 3 — Synchronized Fleet State Timeline with shared clock axis, vertical
 *     scrub hairline, and floating obsidian multi-machine state inspector
 *   Zone 4 — Inline Machine Root-Cause Drill-Down Panel (expanded on selection:
 *     Audited Downtime Pareto, F/R/S Override Discipline vs 100% tick, Forensics)
 *   Zone 5 — Clickable Per-Machine Diagnostic Cards with radial OEE score rings
 */

import { bucketOfState } from "./analyticsCore.js";
import { computeMachine } from "./metrics.js";
import { initTooltips, tipAttr } from "./tooltip.js";

const LS_AN_SNAP = "vmc_an_snap_v3";
const STREAM_BINS = 9;

const MACHINE_PALETTE = [
  "#3b82f6", // Cobalt
  "#f472b6", // Rose
  "#22c55e", // Emerald
  "#f59e0b", // Amber
  "#8b5cf6", // Violet
  "#06b6d4", // Cyan
  "#fb7185", // Coral
  "#84cc16", // Lime
];

const STATE_META = {
  cut:     { label: "Cutting",   color: "#22c55e" },
  hold:    { label: "Feed-Hold", color: "#f59e0b" },
  idle:    { label: "Idle",      color: "#3b82f6" },
  alarm:   { label: "Alarm",     color: "#f43f5e" },
  estop:   { label: "E-Stop",    color: "#f43f5e" },
  offline: { label: "Offline",   color: "#64748b" },
};

const DOWNTIME_META = {
  IDLE:        { label: "Idle / Wait",     color: "#3b82f6" },
  "FEED-HOLD": { label: "Feed-Hold",       color: "#f97316" },
  ALARM:       { label: "Alarm",           color: "#f43f5e" },
  "E-STOP":    { label: "E-Stop",          color: "#dc2626" },
  OTHER:       { label: "Other / Offline", color: "#64748b" },
};

const OVR_CHANNELS = {
  feed:    { key: "feed",    offKey: "feedOff",    short: "F", label: "Feed" },
  rapid:   { key: "rapid",   offKey: "rapidOff",   short: "R", label: "Rapid" },
  spindle: { key: "spindle", offKey: "spindleOff", short: "S", label: "Spindle" },
};

const fmtPct = (v) => (v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1).replace(/\.0$/, "")}%`);
const fmtPctInt = (v) => (v == null || !Number.isFinite(v) ? "—" : `${Math.round(v)}%`);

function fmtDur(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s === 0) return "0m";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function fmtCompactDur(ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "0m";
  const mins = Math.round(ms / 60000);
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  return `${Math.max(1, mins)}m`;
}

function fmtClock(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function fmtRpm(rpm) {
  if (rpm == null || !Number.isFinite(rpm) || rpm <= 0) return "—";
  return `${Math.round(rpm).toLocaleString()} RPM`;
}

function fmtRpmShort(rpm) {
  if (rpm == null || !Number.isFinite(rpm) || rpm <= 0) return "—";
  return Math.round(rpm).toLocaleString();
}

function fmtAxisTick(ts, spanMs) {
  const d = new Date(ts);
  if (spanMs > 36 * 3600000) {
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtInspectTime(ts, spanMs) {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (spanMs > 36 * 3600000) {
    return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} · ${hm}`;
  }
  return `${hm}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function pctDelta(cur, prev, invertGood = false) {
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev)) {
    return { text: "", cls: "is-flat" };
  }
  if (prev === 0) {
    if (cur === 0) return { text: "", cls: "is-flat" };
    return { text: "▲ new", cls: invertGood ? "is-down" : "is-up" };
  }
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  if (Math.abs(pct) < 0.2) return { text: "0%", cls: "is-flat" };
  const up = pct > 0;
  const good = invertGood ? !up : up;
  return {
    text: `${up ? "↑" : "↓"}${Math.abs(pct).toFixed(1).replace(/\.0$/, "")}%`,
    cls: good ? "is-up" : "is-down",
  };
}

function ptsDelta(cur, prev) {
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev)) {
    return { text: "", cls: "is-flat" };
  }
  const d = cur - prev;
  if (Math.abs(d) < 0.15) return { text: "0 pts", cls: "is-flat" };
  const up = d > 0;
  return {
    text: `${up ? "↑" : "↓"}${Math.abs(d).toFixed(1).replace(/\.0$/, "")}%`,
    cls: up ? "is-up" : "is-down",
  };
}

function loadSnap() {
  try {
    const raw = localStorage.getItem(LS_AN_SNAP);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : {};
  } catch (_) { return {}; }
}

function saveSnap(map) {
  try {
    const json = JSON.stringify(map);
    if (json.length > 1_600_000) return;
    localStorage.setItem(LS_AN_SNAP, json);
  } catch (_) {}
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* =================================================== TIMELINE CLASSIFICATION */

function classifySegments(segs, estopSpans = [], alarmSpans = []) {
  if (!Array.isArray(segs) || !segs.length) return [];
  const raw = [];
  for (const s of segs) {
    const b = bucketOfState(s.state);
    if (b === "run") {
      raw.push({ kind: "cut", from: s.from, to: s.to, dur: s.to - s.from });
      continue;
    }
    const cuts = [s.from, s.to];
    for (const [a, z] of estopSpans) {
      if (a > s.from && a < s.to) cuts.push(a);
      if (z > s.from && z < s.to) cuts.push(z);
    }
    for (const [a, z] of alarmSpans) {
      if (a > s.from && a < s.to) cuts.push(a);
      if (z > s.from && z < s.to) cuts.push(z);
    }
    cuts.sort((x, y) => x - y);
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i], z = cuts[i + 1];
      if (z - a <= 0) continue;
      const mid = (a + z) / 2;
      let kind;
      if (inSpans(mid, estopSpans)) kind = "estop";
      else if (inSpans(mid, alarmSpans)) kind = "alarm";
      else if (b === "pause") kind = "hold";
      else if (b === "idle") kind = "idle";
      else kind = "offline";
      raw.push({ kind, from: a, to: z, dur: z - a });
    }
  }
  const merged = [];
  for (const seg of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.kind === seg.kind && Math.abs(prev.to - seg.from) <= 1000) {
      prev.to = seg.to;
      prev.dur = prev.to - prev.from;
    } else {
      merged.push(seg);
    }
  }
  return merged;
}

function inSpans(t, spans) {
  for (const [a, z] of spans) if (t >= a && t <= z) return true;
  return false;
}

function stateAtTime(item, t) {
  if (item.error) return { kind: "offline", label: "Error", dur: null };
  const tl = item.tlSegs || [];
  if (!tl.length) {
    return { kind: "offline", label: item.online ? "No telemetry" : "Offline", dur: null };
  }
  let lo = 0, hi = tl.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = tl[mid];
    if (t < s.from) hi = mid - 1;
    else if (t > s.to) lo = mid + 1;
    else {
      const meta = STATE_META[s.kind] || STATE_META.offline;
      return { kind: s.kind, label: meta.label, dur: s.dur };
    }
  }
  return { kind: "offline", label: item.online ? "No signal" : "Offline", dur: null };
}

/* =================================================== STREAMGRAPH & ROLLUPS */

function sliceStepAvg(rows, from, to, fallback) {
  if (!Array.isArray(rows) || !rows.length || to <= from) {
    return fallback != null && Number.isFinite(fallback) ? fallback : null;
  }
  let curVal = null;
  let idx = 0;
  while (idx < rows.length && rows[idx].ts <= from) {
    const v = Number(rows[idx].num ?? rows[idx].val);
    if (Number.isFinite(v)) curVal = v;
    idx += 1;
  }
  let sum = 0;
  let dur = 0;
  let prevTs = from;
  while (idx < rows.length && rows[idx].ts < to) {
    const r = rows[idx];
    const dt = Math.max(0, r.ts - prevTs);
    if (curVal != null && dt > 0) {
      sum += curVal * dt;
      dur += dt;
    }
    const v = Number(r.num ?? r.val);
    if (Number.isFinite(v)) curVal = v;
    prevTs = r.ts;
    idx += 1;
  }
  const tail = Math.max(0, to - prevTs);
  if (curVal != null && tail > 0) {
    sum += curVal * tail;
    dur += tail;
  }
  if (dur > 0) return sum / dur;
  return fallback != null && Number.isFinite(fallback) ? fallback : null;
}

function summarizeSpindleSeries(series) {
  if (!Array.isArray(series) || !series.length) {
    return { avgRpm: null, peakRpm: null, minRpm: null, samples: 0 };
  }
  let sum = 0, cnt = 0, peak = 0, min = Infinity;
  for (const pt of series) {
    const a = Number(pt.avg ?? pt.num);
    const mx = Number(pt.max ?? a);
    if (Number.isFinite(a) && a > 0) {
      sum += a;
      cnt += 1;
      if (a < min) min = a;
    }
    if (Number.isFinite(mx) && mx > peak) peak = mx;
  }
  return {
    avgRpm: cnt > 0 ? sum / cnt : null,
    peakRpm: peak > 0 ? peak : null,
    minRpm: Number.isFinite(min) ? min : null,
    samples: cnt,
  };
}

function buildStreamBins(items, win, colorMap, count = STREAM_BINS) {
  const span = Math.max(1, win.to - win.from);
  const step = span / count;
  const bins = Array.from({ length: count }, (_, idx) => {
    const from = win.from + idx * step;
    const to = idx === count - 1 ? win.to : from + step;
    return {
      idx,
      from,
      to,
      mid: (from + to) / 2,
      label: fmtAxisTick(from, span),
      cutMs: 0,
      holdMs: 0,
      idleMs: 0,
      faultMs: 0,
      alarmMs: 0,
      estopMs: 0,
      offlineMs: 0,
      parts: 0,
      cycleDurs: [],
      holdsCount: 0,
      alarmsCount: 0,
      estopsCount: 0,
      rpmVals: [],
      peakRpm: 0,
      fdOvrs: [],
      rvOvrs: [],
      ssOvrs: [],
      mcMap: new Map(),
    };
  });

  const ensureMc = (b, it) => {
    const id = String(it.id).toUpperCase();
    let rec = b.mcMap.get(id);
    if (!rec) {
      rec = {
        id,
        name: it.name,
        color: (colorMap && colorMap.get(id)) || "#3b82f6",
        cutMs: 0,
        holdMs: 0,
        idleMs: 0,
        faultMs: 0,
        parts: 0,
        cycleDurs: [],
        rpmSum: 0,
        rpmCnt: 0,
        peakRpm: 0,
        fdOvr: null,
        rvOvr: null,
        ssOvr: null,
      };
      b.mcMap.set(id, rec);
    }
    return rec;
  };

  let totalWindowParts = 0;
  const allCycleDurs = [];

  for (const it of items) {
    const tl = it.tlSegs || [];
    for (const s of tl) {
      const i0 = Math.max(0, Math.floor((s.from - win.from) / step));
      const i1 = Math.min(count - 1, Math.floor((s.to - win.from) / step));
      for (let i = i0; i <= i1; i++) {
        const b = bins[i];
        const ov = Math.max(0, Math.min(s.to, b.to) - Math.max(s.from, b.from));
        if (ov <= 0) continue;
        const mc = ensureMc(b, it);
        if (s.kind === "cut") {
          b.cutMs += ov;
          mc.cutMs += ov;
        } else if (s.kind === "hold") {
          b.holdMs += ov;
          b.holdsCount += 1;
          mc.holdMs += ov;
        } else if (s.kind === "idle") {
          b.idleMs += ov;
          mc.idleMs += ov;
        } else if (s.kind === "alarm") {
          b.faultMs += ov;
          b.alarmMs += ov;
          b.alarmsCount += 1;
          mc.faultMs += ov;
        } else if (s.kind === "estop") {
          b.faultMs += ov;
          b.estopMs += ov;
          b.estopsCount += 1;
          mc.faultMs += ov;
        } else {
          b.offlineMs += ov;
        }
      }
    }

    const cycs = Array.isArray(it.cycleSamples) && it.cycleSamples.length
      ? it.cycleSamples
      : (it.cycleEnds || []).map((end) => ({ end, dur: null }));
    for (const c of cycs) {
      const ts = c.end;
      if (ts < win.from || ts > win.to) continue;
      const idx = Math.min(count - 1, Math.max(0, Math.floor((ts - win.from) / step)));
      const b = bins[idx];
      const mc = ensureMc(b, it);
      b.parts += 1;
      mc.parts += 1;
      totalWindowParts += 1;
      if (c.dur != null && Number.isFinite(c.dur) && c.dur > 0) {
        b.cycleDurs.push(c.dur);
        mc.cycleDurs.push(c.dur);
        allCycleDurs.push(c.dur);
      }
    }

    const spSeries = it.spindleSeries || [];
    for (const pt of spSeries) {
      if (pt.ts < win.from || pt.ts > win.to) continue;
      const idx = Math.min(count - 1, Math.max(0, Math.floor((pt.ts - win.from) / step)));
      const b = bins[idx];
      const avg = Number(pt.avg ?? pt.num);
      const mx = Number(pt.max ?? avg);
      if (Number.isFinite(avg) && avg > 0) {
        b.rpmVals.push(avg);
        const mc = ensureMc(b, it);
        mc.rpmSum += avg;
        mc.rpmCnt += 1;
        if (Number.isFinite(mx) && mx > mc.peakRpm) mc.peakRpm = mx;
      }
      if (Number.isFinite(mx) && mx > b.peakRpm) b.peakRpm = mx;
    }

    const ovS = (it.x && it.x.ovrSeries) || {};
    const ovAvg = (it.x && it.x.ovr) || {};
    for (const b of bins) {
      const mc = b.mcMap.get(String(it.id).toUpperCase());
      if (!mc && !it.online) continue;
      const fd = sliceStepAvg(ovS.fd, b.from, b.to, ovAvg.feed);
      const rv = sliceStepAvg(ovS.rv, b.from, b.to, ovAvg.rapid);
      const sv = sliceStepAvg(ovS.sv, b.from, b.to, ovAvg.spindle);
      if (fd != null) b.fdOvrs.push(fd);
      if (rv != null) b.rvOvrs.push(rv);
      if (sv != null) b.ssOvrs.push(sv);
      if (mc) {
        mc.fdOvr = fd;
        mc.rvOvr = rv;
        mc.ssOvr = sv;
      }
    }
  }

  const fleetAvgCycleMs = allCycleDurs.length
    ? allCycleDurs.reduce((s, v) => s + v, 0) / allCycleDurs.length
    : null;
  const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);

  for (const b of bins) {
    b.lossMs = b.holdMs + b.idleMs + b.faultMs;
    b.attendedMs = b.cutMs + b.lossMs;
    b.cutShare = b.attendedMs > 0 ? (b.cutMs / b.attendedMs) * 100 : 0;
    b.nonCutShare = b.attendedMs > 0 ? (b.lossMs / b.attendedMs) * 100 : 0;
    b.holdShare = b.attendedMs > 0 ? (b.holdMs / b.attendedMs) * 100 : 0;
    b.idleShare = b.attendedMs > 0 ? (b.idleMs / b.attendedMs) * 100 : 0;
    b.faultShare = b.attendedMs > 0 ? (b.faultMs / b.attendedMs) * 100 : 0;

    b.lossIdlePct = b.lossMs > 0 ? (b.idleMs / b.lossMs) * 100 : 0;
    b.lossHoldPct = b.lossMs > 0 ? (b.holdMs / b.lossMs) * 100 : 0;
    b.lossFaultPct = b.lossMs > 0 ? (b.faultMs / b.lossMs) * 100 : 0;

    const activeDen = b.cutMs + b.holdMs + b.faultMs;
    b.stabilityPct = activeDen > 0 ? (b.cutMs / activeDen) * 100 : (b.attendedMs > 0 ? 0 : null);

    b.avgCycleMs = mean(b.cycleDurs);
    b.minCycleMs = b.cycleDurs.length ? Math.min(...b.cycleDurs) : null;
    b.maxCycleMs = b.cycleDurs.length ? Math.max(...b.cycleDurs) : null;
    b.ratePerHr = b.cutMs > 0 && b.parts > 0 ? b.parts / (b.cutMs / 3600000) : null;
    b.partsSharePct = totalWindowParts > 0 ? (b.parts / totalWindowParts) * 100 : 0;

    const cycRef = b.avgCycleMs || fleetAvgCycleMs;
    b.estLostParts = cycRef && cycRef > 0 && b.lossMs > 0 ? Math.round(b.lossMs / cycRef) : null;

    b.avgRpm = mean(b.rpmVals);
    if (!b.peakRpm && b.avgRpm) b.peakRpm = b.avgRpm;
    b.fdOvr = mean(b.fdOvrs);
    b.rvOvr = mean(b.rvOvrs);
    b.ssOvr = mean(b.ssOvrs);

    b.machines = [...b.mcMap.values()]
      .map((mc) => {
        const lossMs = mc.holdMs + mc.idleMs + mc.faultMs;
        const att = mc.cutMs + lossMs;
        return {
          ...mc,
          lossMs,
          attendedMs: att,
          cutPct: att > 0 ? (mc.cutMs / att) * 100 : 0,
          avgCycleMs: mean(mc.cycleDurs),
          avgRpm: mc.rpmCnt > 0 ? mc.rpmSum / mc.rpmCnt : null,
        };
      })
      .filter((mc) => mc.attendedMs > 0 || mc.parts > 0)
      .sort((a, b2) => (b2.cutMs - a.cutMs) || (b2.parts - a.parts));
  }
  return bins;
}

function downtimePareto(items) {
  const keys = ["IDLE", "FEED-HOLD", "ALARM", "E-STOP", "OTHER"];
  const totals = new Map(keys.map((k) => [k, { key: k, ms: 0, byMc: [] }]));
  let grandTotal = 0;

  for (const it of items) {
    if (!it.x || !it.x.downtime) continue;
    for (const k of keys) {
      const ms = it.x.downtime[k] || 0;
      if (ms > 0) {
        const entry = totals.get(k);
        entry.ms += ms;
        entry.byMc.push({ id: it.id, name: it.name, ms });
        grandTotal += ms;
      }
    }
  }

  const rows = [...totals.values()]
    .filter((e) => e.ms > 0)
    .sort((a, b) => b.ms - a.ms)
    .map((e) => {
      e.byMc.sort((a, b) => b.ms - a.ms);
      const meta = DOWNTIME_META[e.key] || DOWNTIME_META.OTHER;
      return {
        key: e.key,
        label: meta.label,
        color: meta.color,
        ms: e.ms,
        share: grandTotal > 0 ? (e.ms / grandTotal) * 100 : 0,
        top: e.byMc[0] || null,
      };
    });

  return { totalMs: grandTotal, rows };
}

function summarizeScope(items) {
  let runMs = 0, lossMs = 0, attendedMs = 0, parts = 0, estops = 0, alarms = 0, faultMs = 0;
  const oeeVals = [], availVals = [], perfVals = [], utilVals = [], qVals = [];
  const rpmVals = [], cycMedVals = [];
  let peakRpm = 0;
  const ovrAcc = { feed: [], rapid: [], spindle: [], feedOff: [], rapidOff: [], spindleOff: [] };

  for (const it of items) {
    if (!it.x) continue;
    const x = it.x;
    const b = x.buckets || { run: 0, pause: 0, idle: 0, other: 0 };
    const dt = x.downtime || {};
    runMs += b.run || 0;
    const mcLoss = (dt.IDLE || 0) + (dt["FEED-HOLD"] || 0) + (dt.ALARM || 0) + (dt["E-STOP"] || 0) + (dt.OTHER || 0);
    lossMs += mcLoss > 0 ? mcLoss : ((b.pause || 0) + (b.idle || 0));
    attendedMs += (b.run || 0) + (b.pause || 0) + (b.idle || 0);
    parts += x.parts || 0;
    estops += (x.estopEvents && x.estopEvents.count) || 0;
    alarms += (x.alarmEvents && x.alarmEvents.count) || 0;
    faultMs += (dt["E-STOP"] || 0) + (dt.ALARM || 0);

    if (x.oee != null && Number.isFinite(x.oee)) oeeVals.push(x.oee);
    if (x.availability != null && Number.isFinite(x.availability)) availVals.push(x.availability);
    if (x.performance != null && Number.isFinite(x.performance)) perfVals.push(x.performance);
    if (x.utilization != null && Number.isFinite(x.utilization)) utilVals.push(x.utilization);
    if (x.qualityProxy != null && Number.isFinite(x.qualityProxy)) qVals.push(x.qualityProxy);
    if (x.cstats && x.cstats.median != null && Number.isFinite(x.cstats.median)) cycMedVals.push(x.cstats.median);

    if (it.spindle) {
      if (it.spindle.avgRpm != null && Number.isFinite(it.spindle.avgRpm)) rpmVals.push(it.spindle.avgRpm);
      if (it.spindle.peakRpm != null && it.spindle.peakRpm > peakRpm) peakRpm = it.spindle.peakRpm;
    }

    if (x.ovr) {
      for (const ch of ["feed", "rapid", "spindle"]) {
        if (x.ovr[ch] != null && Number.isFinite(x.ovr[ch])) ovrAcc[ch].push(x.ovr[ch]);
        const ok = OVR_CHANNELS[ch].offKey;
        if (x.ovr[ok] != null && Number.isFinite(x.ovr[ok])) ovrAcc[ok].push(x.ovr[ok]);
      }
    }
  }

  const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const attendedAvail = attendedMs > 0 ? (runMs / attendedMs) * 100 : avg(availVals);
  const partRateRun = runMs > 0 ? parts / (runMs / 3600000) : null;

  return {
    runMs,
    lossMs,
    attendedMs,
    parts,
    partRateRun,
    medianCycleMs: avg(cycMedVals),
    avgRpm: avg(rpmVals),
    peakRpm: peakRpm > 0 ? peakRpm : null,
    estops,
    alarms,
    faultMs,
    oee: avg(oeeVals),
    availability: attendedAvail,
    performance: avg(perfVals),
    utilization: avg(utilVals),
    qualityProxy: avg(qVals),
    ovr: {
      feed: avg(ovrAcc.feed),
      rapid: avg(ovrAcc.rapid),
      spindle: avg(ovrAcc.spindle),
      feedOff: avg(ovrAcc.feedOff) || 0,
      rapidOff: avg(ovrAcc.rapidOff) || 0,
      spindleOff: avg(ovrAcc.spindleOff) || 0,
    },
  };
}

/* =================================================== SVG GEOMETRY HELPERS */

/* Build a closed symmetric horizontal ribbon path around `cy` using crisp
 * horizontal-tangent monotone S-curves (never overshoots, matches Image 1). */
function symmetricRibbonPath(xs, halfHeights, cy) {
  const n = xs.length;
  if (n < 2) return "";
  const top = xs.map((x, i) => ({ x, y: cy - halfHeights[i] }));
  const bot = xs.map((x, i) => ({ x, y: cy + halfHeights[i] }));

  let d = `M ${top[0].x.toFixed(1)} ${top[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = top[i], p1 = top[i + 1];
    const cx = (p0.x + p1.x) / 2;
    d += ` C ${cx.toFixed(1)} ${p0.y.toFixed(1)}, ${cx.toFixed(1)} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  d += ` L ${bot[n - 1].x.toFixed(1)} ${bot[n - 1].y.toFixed(1)}`;
  for (let i = n - 1; i > 0; i--) {
    const p0 = bot[i], p1 = bot[i - 1];
    const cx = (p0.x + p1.x) / 2;
    d += ` C ${cx.toFixed(1)} ${p0.y.toFixed(1)}, ${cx.toFixed(1)} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return d + " Z";
}

function smoothLinePath(pts) {
  if (!pts.length) return "";
  if (pts.length === 1) return `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i], p1 = pts[i + 1];
    const cx = (p0.x + p1.x) / 2;
    d += ` C ${cx.toFixed(1)} ${p0.y.toFixed(1)}, ${cx.toFixed(1)} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return d;
}

function polarToXY(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function sectorPath(cx, cy, rInner, rOuter, startDeg, endDeg) {
  const span = Math.max(1, Math.min(359.6, endDeg - startDeg));
  const a1 = startDeg;
  const a2 = startDeg + span;
  const large = span > 180 ? 1 : 0;
  const pOut1 = polarToXY(cx, cy, rOuter, a1);
  const pOut2 = polarToXY(cx, cy, rOuter, a2);
  const pIn2 = polarToXY(cx, cy, rInner, a2);
  const pIn1 = polarToXY(cx, cy, rInner, a1);
  return [
    `M ${pOut1.x.toFixed(2)} ${pOut1.y.toFixed(2)}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${pOut2.x.toFixed(2)} ${pOut2.y.toFixed(2)}`,
    `L ${pIn2.x.toFixed(2)} ${pIn2.y.toFixed(2)}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${pIn1.x.toFixed(2)} ${pIn1.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

/* =========================================================== MOUNT ENTRY */

export function mountAnalytical(body, dataLayer) {
  body.innerHTML = `
    <div class="kb-root an-root" data-f="root"></div>
    <p class="ds-note" data-f="note" role="status" aria-live="polite" hidden></p>`;
  const refs = {
    root: body.querySelector('[data-f="root"]'),
    note: body.querySelector('[data-f="note"]'),
  };
  initTooltips(body);

  const snapMap = loadSnap();
  let token = 0;

  const ui = {
    selectedMachine: null, // null | uppercase machine ID
    ovrChannel: "feed",    // "feed" | "rapid" | "spindle"
    scrubFrac: null,
  };

  let lastData = null; // { items, prevItems, win, colorMap, fleetAudit }
  let resizeRaf = null;
  let sliceTipEl = null;

  function ensureSliceTip() {
    if (sliceTipEl && sliceTipEl.isConnected) return sliceTipEl;
    sliceTipEl = document.createElement("div");
    sliceTipEl.className = "an-slice-tip";
    sliceTipEl.setAttribute("role", "tooltip");
    document.body.appendChild(sliceTipEl);
    return sliceTipEl;
  }

  function hideSliceTip() {
    if (sliceTipEl) sliceTipEl.classList.remove("is-show");
    refs.root.querySelectorAll(".an-stream-hit-col.is-hover").forEach((c) => c.classList.remove("is-hover"));
  }

  const onWindowScroll = () => hideSliceTip();
  window.addEventListener("scroll", onWindowScroll, true);

  const resizeObs = typeof ResizeObserver !== "undefined"
    ? new ResizeObserver(() => {
        if (!lastData) return;
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => drawAllLaneCanvases(refs.root, lastData));
      })
    : null;
  if (resizeObs) resizeObs.observe(refs.root);

  function assignColors(items) {
    const map = new Map();
    const sortedIds = items.map((p) => String(p.id).toUpperCase()).sort();
    sortedIds.forEach((id, i) => map.set(id, MACHINE_PALETTE[i % MACHINE_PALETTE.length]));
    return map;
  }

  function paintFromSnap(win) {
    const snap = snapMap[win.key];
    if (snap && Array.isArray(snap.items) && !lastData) {
      const colorMap = assignColors(snap.items);
      lastData = {
        items: snap.items,
        prevItems: Array.isArray(snap.prevItems) ? snap.prevItems : [],
        win: snap.win || win,
        colorMap,
        fleetAudit: snap.fleetAudit || { level: "warn", label: "UNKNOWN" },
      };
      paintBento();
      refs.note.hidden = true;
      return true;
    }
    return false;
  }

  function cacheData(win, items, prevItems, fleetAudit) {
    const slimItem = (it) => ({
      id: it.id,
      name: it.name,
      online: it.online,
      conf: it.conf,
      error: it.error || null,
      tlSegs: it.tlSegs || [],
      cycleEnds: it.cycleEnds || [],
      cycleSamples: (it.cycleSamples || []).slice(-300),
      spindle: it.spindle || null,
      spindleSeries: (it.spindleSeries || []).slice(-48),
      x: it.x ? {
        buckets: it.x.buckets,
        availability: it.x.availability,
        utilization: it.x.utilization,
        performance: it.x.performance,
        oee: it.x.oee,
        parts: it.x.parts,
        partRateRun: it.x.partRateRun,
        cstats: it.x.cstats,
        ovr: it.x.ovr,
        estopEvents: { count: (it.x.estopEvents && it.x.estopEvents.count) || 0 },
        alarmEvents: { count: (it.x.alarmEvents && it.x.alarmEvents.count) || 0 },
        qualityProxy: it.x.qualityProxy,
        downtime: it.x.downtime,
        spanMs: it.x.spanMs,
      } : null,
    });
    snapMap[win.key] = {
      win,
      items: items.map(slimItem),
      prevItems: (prevItems || []).map((it) => ({
        id: it.id,
        x: it.x ? {
          buckets: it.x.buckets,
          availability: it.x.availability,
          performance: it.x.performance,
          utilization: it.x.utilization,
          oee: it.x.oee,
          parts: it.x.parts,
          qualityProxy: it.x.qualityProxy,
          downtime: it.x.downtime,
          ovr: it.x.ovr,
          estopEvents: { count: (it.x.estopEvents && it.x.estopEvents.count) || 0 },
          alarmEvents: { count: (it.x.alarmEvents && it.x.alarmEvents.count) || 0 },
        } : null,
      })),
      fleetAudit,
    };
    saveSnap(snapMap);
  }

  function paintBento() {
    if (!lastData) return;
    const { items, prevItems, win, colorMap, fleetAudit } = lastData;
    const filterId = ui.selectedMachine;
    const scopedItems = filterId
      ? items.filter((it) => String(it.id).toUpperCase() === filterId)
      : items;
    const scopedPrev = filterId
      ? (prevItems || []).filter((it) => String(it.id).toUpperCase() === filterId)
      : (prevItems || []);

    const cur = summarizeScope(scopedItems);
    const prev = scopedPrev.length ? summarizeScope(scopedPrev) : null;
    const bins = buildStreamBins(scopedItems, win, colorMap, STREAM_BINS);
    const pareto = downtimePareto(scopedItems);
    const focusedItem = filterId
      ? items.find((it) => String(it.id).toUpperCase() === filterId)
      : null;

    const filterBanner = filterId ? (() => {
      const col = colorMap.get(filterId) || "#3b82f6";
      return `<div class="kb-filter-bar">
        <span class="kb-filter-left"><span class="kb-filter-swatch" style="background:${col}"></span>Focused on <strong>${escapeHtml(focusedItem ? focusedItem.name : filterId)}</strong> — streamgraphs, pattern widgets &amp; root-cause drill-down isolated</span>
        <button type="button" class="kb-clear-btn" data-an-clear="1">Show full fleet</button>
      </div>`;
    })() : "";

    hideSliceTip();
    refs.root.innerHTML = [
      filterBanner,
      renderHeroFlowSection(cur, prev, bins, items, win, colorMap, fleetAudit, ui),
      renderPatternWidgetsRow(cur, pareto, bins, win, filterId),
      renderSynchronizedTimeline(items, win, colorMap, ui),
      focusedItem ? renderMachineDrillDown(focusedItem, pareto, colorMap, ui) : "",
      renderMachineCardsSection(items, colorMap, ui),
    ].join("");

    drawAllLaneCanvases(refs.root, lastData);
    wireInteractions(refs.root, items, win, colorMap, bins, cur, focusedItem);
  }

  function wireInteractions(root, items, win, colorMap, bins, cur, focusedItem) {
    const clearBtn = root.querySelector("[data-an-clear]");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        ui.selectedMachine = null;
        paintBento();
      });
    }

    root.querySelectorAll("[data-an-ovr-ch]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const ch = btn.dataset.anOvrCh;
        if (!ch || ch === ui.ovrChannel) return;
        ui.ovrChannel = ch;
        paintBento();
      });
    });

    root.querySelectorAll("[data-an-machine]").forEach((el) => {
      const toggle = (ev) => {
        if (ev && ev.type === "keydown" && ev.key !== "Enter" && ev.key !== " ") return;
        if (ev && ev.type === "keydown") ev.preventDefault();
        const id = String(el.dataset.anMachine || "").toUpperCase();
        if (!id) return;
        ui.selectedMachine = ui.selectedMachine === id ? null : id;
        paintBento();
      };
      el.addEventListener("click", toggle);
      if (el.getAttribute("role") === "button") {
        el.addEventListener("keydown", toggle);
      }
    });

    // Synchronized timeline scrubbing
    const stage = root.querySelector("#anTlStage");
    const overlay = root.querySelector("#anTlOverlay");
    const cursorEl = root.querySelector("#anTlCursor");
    const tipEl = root.querySelector("#anTlTip");

    if (stage && overlay && cursorEl && tipEl) {
      const lanes = root.querySelectorAll("[data-an-tl-track]");

      const updateScrub = (clientX, clientY, focusedId) => {
        const rect = overlay.getBoundingClientRect();
        if (!rect.width) return;
        const relX = Math.max(0, Math.min(rect.width, clientX - rect.left));
        const frac = relX / rect.width;
        ui.scrubFrac = frac;

        cursorEl.style.transform = `translate3d(${relX.toFixed(1)}px, 0, 0)`;
        cursorEl.classList.add("is-show");

        const spanMs = (win.to - win.from) || 1;
        const ts = win.from + frac * spanMs;
        tipEl.innerHTML = buildTimelineInspectorHTML(items, ts, spanMs, colorMap, focusedId);
        tipEl.classList.add("is-show");

        const stageRect = stage.getBoundingClientRect();
        const tipW = tipEl.offsetWidth || 236;
        const tipH = tipEl.offsetHeight || 160;
        const cursorStageX = (rect.left - stageRect.left) + relX;

        let tx = cursorStageX + 16;
        if (tx + tipW > stageRect.width - 8) tx = cursorStageX - tipW - 16;
        tx = Math.max(8, Math.min(stageRect.width - tipW - 8, tx));

        const pointerStageY = clientY - stageRect.top;
        let ty = Math.max(4, Math.min(stageRect.height - tipH - 6, pointerStageY - tipH * 0.35));
        if (!Number.isFinite(ty)) ty = 8;

        tipEl.style.transform = `translate3d(${Math.round(tx)}px, ${Math.round(ty)}px, 0)`;
      };

      const hideScrub = () => {
        ui.scrubFrac = null;
        cursorEl.classList.remove("is-show");
        tipEl.classList.remove("is-show");
      };

      lanes.forEach((track) => {
        const mcId = String(track.dataset.anTlTrack || "").toUpperCase();
        track.addEventListener("pointermove", (e) => updateScrub(e.clientX, e.clientY, mcId));
      });
      stage.addEventListener("pointerleave", hideScrub);
    }

    // Rich color-coded floating slice inspector for streamgraphs & cadence chartline
    const streamHosts = root.querySelectorAll("[data-an-stream-kind]");
    streamHosts.forEach((host) => {
      const kind = host.dataset.anStreamKind;
      const cols = host.querySelectorAll("[data-an-slice-idx]");
      const scopeLabel = focusedItem
        ? focusedItem.name
        : `Fleet · ${items.filter((it) => !it.error).length} VMCs`;

      const positionTip = (tip, colRect, clientY) => {
        const pad = 12;
        const gap = 14;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const tw = tip.offsetWidth || 320;
        const th = tip.offsetHeight || 280;

        let x = colRect.right + gap;
        if (x + tw > vw - pad) {
          x = colRect.left - tw - gap;
        }
        if (x < pad) {
          x = Math.max(pad, Math.min(vw - tw - pad, colRect.left + colRect.width / 2 - tw / 2));
        }

        let y = (clientY != null ? clientY : colRect.top + colRect.height / 2) - th * 0.42;
        y = Math.max(pad, Math.min(vh - th - pad, y));

        tip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
      };

      cols.forEach((col) => {
        const idx = Number(col.dataset.anSliceIdx);
        const bin = bins[idx];
        if (!bin) return;

        const show = (ev) => {
          cols.forEach((c) => c.classList.toggle("is-hover", c === col));
          const tip = ensureSliceTip();
          tip.innerHTML = buildSliceInspectorHTML(kind, bin, cur, win, scopeLabel, !!focusedItem);
          tip.classList.add("is-show");
          positionTip(tip, col.getBoundingClientRect(), ev ? ev.clientY : null);
        };

        col.addEventListener("pointerenter", show);
        col.addEventListener("pointermove", (ev) => {
          if (!sliceTipEl || !sliceTipEl.classList.contains("is-show")) {
            show(ev);
          } else {
            positionTip(sliceTipEl, col.getBoundingClientRect(), ev.clientY);
          }
        });
      });

      host.addEventListener("pointerleave", hideSliceTip);
    });
  }

  async function refresh() {
    if (document.hidden) return;
    const my = ++token;
    const current = () => my === token;

    const win0 = dataLayer.resolveWindow();
    const hadSnap = paintFromSnap(win0);
    if (!hadSnap && !lastData) {
      refs.root.innerHTML = `
        <div class="an-hero-grid">
          <div class="kb-skel" style="height:420px"></div>
          <div class="an-flow-side">
            <div class="kb-skel" style="height:202px"></div>
            <div class="kb-skel" style="height:202px"></div>
          </div>
        </div>
        <div class="an-pattern-grid">
          <div class="kb-skel" style="height:224px"></div>
          <div class="kb-skel" style="height:224px"></div>
          <div class="kb-skel" style="height:224px"></div>
          <div class="kb-skel" style="height:224px"></div>
        </div>`;
    }

    let ov;
    try { ov = await dataLayer.overview(); }
    catch (err) {
      if (current() && !hadSnap && !lastData) {
        const isTimeout = err.name === "AbortError" || (err.message && err.message.includes("aborted"));
        note(refs, isTimeout ? "Computing analytics — collector is slow, please wait…" : "Collector unreachable — cannot fetch machine list.");
      }
      return;
    }
    if (!current()) return;

    const machines = Array.isArray(ov.machines) ? ov.machines : [];
    if (!machines.length) {
      if (current() && !hadSnap) note(refs, "No machines reported by the collector.");
      return;
    }

    const win = dataLayer.resolveWindow();
    const span = win.to - win.from;
    const prevWin = { key: win.key, label: "prev", from: win.from - span, to: win.from };

    let audit = null;
    try { audit = await dataLayer.gapAudit(); } catch (_) { audit = null; }
    if (!current()) return;

    const fleetAudit = dataLayer.confidenceFromAudit(audit);
    let anySuccess = false;

    const [results, prevResults] = await Promise.all([
      Promise.all(machines.map(async (m) => {
        const id = String(m.machine_id);
        const name = m.machine_name || id;
        const online = !!m.online;
        const conf = dataLayer.confidenceFromAudit(audit, id);
        try {
          const [x, spSeries] = await Promise.all([
            computeMachine(dataLayer, id, win),
            online && typeof dataLayer.series === "function"
              ? dataLayer.series(id, "sspeed", win.from, win.to, { buckets: 36 }).catch(() => [])
              : Promise.resolve([]),
          ]);
          anySuccess = true;
          const tlSegs = x ? classifySegments(x.segs, x.estopSpans, x.alarmSpans) : [];
          const cycleSamples = x && Array.isArray(x.cycles)
            ? x.cycles.map((c) => ({ end: c.end, dur: c.dur, prog: c.prog }))
            : [];
          const cycleEnds = cycleSamples.map((c) => c.end);
          const spindle = summarizeSpindleSeries(spSeries);
          return { id, name, online, conf, x, tlSegs, cycleEnds, cycleSamples, spindle, spindleSeries: spSeries, error: null };
        } catch (err) {
          const isTimeout = err.name === "AbortError" || (err.message && err.message.includes("aborted"));
          const msg = isTimeout
            ? "Endpoint timed out — history took too long to load."
            : `Failed to load telemetry: ${err.message || "unknown error"}`;
          return { id, name, online, conf: { level: "bad", label: "ERROR", detail: msg }, x: null, tlSegs: [], cycleEnds: [], cycleSamples: [], spindle: null, spindleSeries: [], error: msg };
        }
      })),
      Promise.all(machines.map(async (m) => {
        const id = String(m.machine_id);
        try {
          const x = await computeMachine(dataLayer, id, prevWin);
          return { id, x };
        } catch (_) {
          return { id, x: null };
        }
      })),
    ]);

    if (!current()) return;

    if (anySuccess) {
      refs.note.hidden = true;
    } else {
      note(refs, "Failed to compute analytics for any machine — endpoints too slow or unavailable.");
    }

    results.sort((a, b) => {
      if (!!a.error !== !!b.error) return a.error ? 1 : -1;
      if (a.online !== b.online) return a.online ? -1 : 1;
      const av = (a.x && a.x.buckets ? a.x.buckets.run : -1);
      const bv = (b.x && b.x.buckets ? b.x.buckets.run : -1);
      if (bv !== av) return bv - av;
      return a.name.localeCompare(b.name);
    });

    const colorMap = assignColors(results);
    if (ui.selectedMachine && !colorMap.has(ui.selectedMachine)) {
      ui.selectedMachine = null;
    }

    lastData = { items: results, prevItems: prevResults, win, colorMap, fleetAudit };
    paintBento();
    if (anySuccess) cacheData(win, results, prevResults, fleetAudit);
  }

  function destroy() {
    window.removeEventListener("scroll", onWindowScroll, true);
    if (sliceTipEl && sliceTipEl.parentNode) {
      sliceTipEl.parentNode.removeChild(sliceTipEl);
      sliceTipEl = null;
    }
    if (resizeObs) resizeObs.disconnect();
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
  }

  return { refresh, destroy };
}

function note(refs, msg) {
  refs.note.textContent = msg;
  refs.note.hidden = false;
}

/* ======================================= ZONE 1: HERO FLOW STREAMGRAPHS */

function renderHeroFlowSection(cur, prev, bins, allItems, win, colorMap, fleetAudit, ui) {
  const cutDelta = prev ? pctDelta(cur.runMs, prev.runMs, false) : { text: "", cls: "is-flat" };
  const lossDelta = prev ? pctDelta(cur.lossMs, prev.lossMs, true) : { text: "", cls: "is-flat" };
  const partsDelta = prev ? pctDelta(cur.parts, prev.parts, false) : { text: "", cls: "is-flat" };
  const qDelta = prev ? ptsDelta(cur.qualityProxy, prev.qualityProxy) : { text: "", cls: "is-flat" };

  const auditLvl = fleetAudit ? fleetAudit.level : "warn";
  const auditGem = `<span class="an-audit-gem is-${auditLvl}" data-tip-title="Gapless Sequence Audit" data-tip="${tipAttr(fleetAudit ? `${fleetAudit.label} — ${fleetAudit.detail || ""}` : "Audit pending")}">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1.5 9.8 6.2 14.5 8 9.8 9.8 8 14.5 6.2 9.8 1.5 8 6.2 6.2Z"/></svg>
  </span>`;

  // Left Main Execution Flow Streamgraph SVG (620 x 196)
  const mainSvg = renderMainExecutionStreamSVG(bins, win);

  // Bottom machine breakdown rows inside Hero Card (Image 1 table style)
  const tableRows = allItems.slice(0, 6).map((it) => {
    const id = String(it.id).toUpperCase();
    const col = colorMap.get(id) || "#3b82f6";
    const isSel = ui.selectedMachine === id;
    const isDim = ui.selectedMachine && !isSel;
    const runMs = it.x && it.x.buckets ? it.x.buckets.run : 0;
    const dt = it.x && it.x.downtime ? it.x.downtime : {};
    const lossMs = (dt.IDLE || 0) + (dt["FEED-HOLD"] || 0) + (dt.ALARM || 0) + (dt["E-STOP"] || 0) + (dt.OTHER || 0);
    const parts = it.x ? (it.x.parts || 0) : 0;
    const oee = it.x ? it.x.oee : null;

    return `<tr class="${isSel ? "is-active" : ""} ${isDim ? "is-dim" : ""}" data-an-machine="${escapeHtml(id)}">
      <td>
        <span class="an-hero-mc-cell">
          <span class="kb-swatch" style="background:${col}"></span>
          <span>${escapeHtml(it.name)}</span>
        </span>
      </td>
      <td class="num">${it.error ? "Error" : fmtDur(runMs)}</td>
      <td class="num">${it.error ? "—" : fmtDur(lossMs)}</td>
      <td class="num">${it.error ? "—" : `${parts} pcs`}</td>
      <td class="num">${it.error ? "—" : fmtPctInt(oee)}</td>
    </tr>`;
  }).join("");

  // Top-right Crimson Loss Streamgraph
  const lossSvg = renderCrimsonLossStreamSVG(bins, win);
  // Bottom-right Violet-Amber Quality & Override Flow
  const qualSvg = renderVioletQualityStreamSVG(bins, cur, win);

  const qualHeadline = cur.qualityProxy != null
    ? fmtPct(cur.qualityProxy)
    : (cur.ovr.feed != null ? `F ${Math.round(cur.ovr.feed)}%` : "—");
  const qualSub = prev && prev.qualityProxy != null
    ? `Compared to ${fmtPct(prev.qualityProxy)} prev · F ${cur.ovr.feed != null ? `${Math.round(cur.ovr.feed)}%` : "—"}`
    : `Feed ${cur.ovr.feed != null ? `${Math.round(cur.ovr.feed)}%` : "—"} · Spindle ${cur.ovr.spindle != null ? `${Math.round(cur.ovr.spindle)}%` : "—"}`;

  const axisLabels = [0, 2, 4, 6, 8].map((idx) => {
    const b = bins[Math.min(bins.length - 1, idx)];
    return `<span>${escapeHtml(b ? b.label : "")}</span>`;
  }).join("");

  return `<section class="an-hero-grid">
    <article class="an-card an-flow-hero">
      <div class="an-card-top">
        <div>
          <h3 class="an-card-title">Fleet Execution Flow Report</h3>
          <span class="an-card-sub">Time-sliced cutting, feed-hold &amp; idle volume across ${escapeHtml(win.label)} · hover any slice to inspect</span>
        </div>
        ${auditGem}
      </div>

      <div class="an-hero-kpis">
        <div class="an-hkpi">
          <span class="an-hkpi-lbl">Cutting Time</span>
          <div class="an-hkpi-main">
            <span class="an-hkpi-val">${fmtDur(cur.runMs)}</span>
            ${cutDelta.text ? `<span class="kb-delta ${cutDelta.cls}">${cutDelta.text}</span>` : ""}
          </div>
          <span class="an-hkpi-comp">${prev ? `Compared to ${fmtDur(prev.runMs)} prev ${escapeHtml(win.label)}` : `${fmtPct(cur.availability)} attended share`}</span>
        </div>
        <div class="an-hkpi">
          <span class="an-hkpi-lbl">Non-Cutting Loss</span>
          <div class="an-hkpi-main">
            <span class="an-hkpi-val">${fmtDur(cur.lossMs)}</span>
            ${lossDelta.text ? `<span class="kb-delta ${lossDelta.cls}">${lossDelta.text}</span>` : ""}
          </div>
          <span class="an-hkpi-comp">${prev ? `Compared to ${fmtDur(prev.lossMs)} prev ${escapeHtml(win.label)}` : `${cur.alarms + cur.estops} fault events logged`}</span>
        </div>
        <div class="an-hkpi">
          <span class="an-hkpi-lbl">Parts Completed</span>
          <div class="an-hkpi-main">
            <span class="an-hkpi-val">${cur.parts}</span>
            ${partsDelta.text ? `<span class="kb-delta ${partsDelta.cls}">${partsDelta.text}</span>` : ""}
          </div>
          <span class="an-hkpi-comp">${prev ? `Compared to ${prev.parts} prev ${escapeHtml(win.label)}` : (cur.partRateRun != null ? `${cur.partRateRun.toFixed(1)} parts / run-h` : "M30 cycle completions")}</span>
        </div>
      </div>

      <div class="an-stream-stage">
        ${mainSvg}
        <div class="an-stream-legend">
          <div class="an-stream-legend-items">
            <span class="an-stream-leg"><span class="kb-swatch" style="background:#10b981"></span>Cutting core</span>
            <span class="an-stream-leg"><span class="kb-swatch" style="background:#3b82f6"></span>Active demand (Hold)</span>
            <span class="an-stream-leg"><span class="kb-swatch" style="background:#6366f1"></span>Idle envelope</span>
          </div>
          <span>Upper callout: Cutting · Lower: Loss</span>
        </div>
      </div>

      <table class="an-hero-table">
        <thead>
          <tr>
            <th>Machine</th>
            <th class="num">Cutting</th>
            <th class="num">Loss</th>
            <th class="num">Parts</th>
            <th class="num">OEE</th>
          </tr>
        </thead>
        <tbody>${tableRows || `<tr><td colspan="5" class="kb-empty">No machines reported.</td></tr>`}</tbody>
      </table>
    </article>

    <div class="an-flow-side">
      <article class="an-card an-side-card">
        <div class="an-card-top">
          <div class="an-side-head">
            <span class="an-hkpi-lbl">Downtime &amp; Fault Loss</span>
            <div class="an-side-val-row">
              <span class="an-side-val">${fmtDur(cur.lossMs)}</span>
              ${lossDelta.text ? `<span class="kb-delta ${lossDelta.cls}">${lossDelta.text}</span>` : ""}
            </div>
            <span class="an-hkpi-comp">${prev ? `Compared to ${fmtDur(prev.lossMs)} prev` : `${cur.estops} E-Stops · ${cur.alarms} Alarms`}</span>
          </div>
          <span class="an-audit-gem ${cur.estops + cur.alarms > 0 ? "is-bad" : "is-ok"}" data-tip-title="Fault Events" data-tip="${tipAttr(`${cur.estops} E-Stops · ${cur.alarms} Alarms · ${fmtDur(cur.faultMs)} fault downtime`)}">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1.5 9.8 6.2 14.5 8 9.8 9.8 8 14.5 6.2 9.8 1.5 8 6.2 6.2Z"/></svg>
          </span>
        </div>
        <div class="an-stream-stage">
          ${lossSvg}
          <div class="an-side-legend">
            <span class="an-stream-leg"><span class="kb-swatch" style="background:#f43f5e"></span>Fault / Critical</span>
            <span class="an-stream-leg"><span class="kb-swatch" style="background:#dc2626"></span>Feed-Hold</span>
            <span class="an-stream-leg"><span class="kb-swatch" style="background:#991b1b"></span>Idle</span>
          </div>
        </div>
      </article>

      <article class="an-card an-side-card">
        <div class="an-card-top">
          <div class="an-side-head">
            <span class="an-hkpi-lbl">Quality &amp; Override Flow</span>
            <div class="an-side-val-row">
              <span class="an-side-val">${qualHeadline}</span>
              ${qDelta.text ? `<span class="kb-delta ${qDelta.cls}">${qDelta.text}</span>` : ""}
            </div>
            <span class="an-hkpi-comp">${escapeHtml(qualSub)}</span>
          </div>
          <span class="an-audit-gem ${cur.ovr.feedOff > 0.05 ? "is-warn" : "is-ok"}" data-tip-title="Override Discipline" data-tip="${tipAttr(`Feed off-100%: ${Math.round((cur.ovr.feedOff || 0) * 100)}% · Rapid off-100%: ${Math.round((cur.ovr.rapidOff || 0) * 100)}% · Spindle off-100%: ${Math.round((cur.ovr.spindleOff || 0) * 100)}%`)}">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1.5 9.8 6.2 14.5 8 9.8 9.8 8 14.5 6.2 9.8 1.5 8 6.2 6.2Z"/></svg>
          </span>
        </div>
        <div class="an-stream-stage">
          ${qualSvg}
          <div class="an-side-legend">
            <span class="an-stream-leg"><span class="kb-swatch" style="background:#f59e0b"></span>Cut %</span>
            <span class="an-stream-leg"><span class="kb-swatch" style="background:#d946ef"></span>Clean cycles</span>
            <span class="an-stream-leg"><span class="kb-swatch" style="background:#7c3aed"></span>Stability</span>
          </div>
          <div class="an-side-axis">${axisLabels}</div>
        </div>
      </article>
    </div>
  </section>`;
}

function renderMainExecutionStreamSVG(bins, win) {
  const W = 620, H = 196, cy = H / 2;
  const maxAtt = Math.max(...bins.map((b) => b.attendedMs), 1);
  const xs = bins.map((_, i) => (i / (bins.length - 1)) * W);

  const taper = (i) => (i === 0 ? 0.52 : i === bins.length - 1 ? 0.96 : 1);
  const hOuter = bins.map((b, i) => Math.max(5, (b.attendedMs / maxAtt) * 56 * taper(i)));
  const hMid = bins.map((b, i) => Math.max(3.5, ((b.cutMs + b.holdMs + b.faultMs) / maxAtt) * 44 * taper(i)));
  const hCore = bins.map((b, i) => Math.max(2.2, (b.cutMs / maxAtt) * 32 * taper(i)));

  const pathOuter = symmetricRibbonPath(xs, hOuter, cy);
  const pathMid = symmetricRibbonPath(xs, hMid, cy);
  const pathCore = symmetricRibbonPath(xs, hCore, cy);

  const ckIdxs = [2, 5, 7];
  const checkpointsHtml = ckIdxs.map((idx) => {
    const b = bins[idx];
    if (!b) return "";
    const leftPct = ((idx / (bins.length - 1)) * 100).toFixed(2);
    return `
      <span class="an-stream-stem-line" style="left:${leftPct}%"></span>
      <span class="an-stream-pill is-top" style="left:${leftPct}%">${escapeHtml(fmtCompactDur(b.cutMs))}</span>
      <span class="an-stream-pill is-bot" style="left:${leftPct}%">${escapeHtml(fmtCompactDur(b.lossMs))}</span>`;
  }).join("");

  const hitCols = bins.map((b, i) => `<span class="an-stream-hit-col" data-an-slice-idx="${i}"></span>`).join("");

  return `<div class="an-stream-canvas" data-an-stream-kind="main">
    <svg class="an-stream-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Fleet Execution Flow Streamgraph">
      <defs>
        <linearGradient id="anGradOuter" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#312e81" stop-opacity="0.35" />
          <stop offset="45%" stop-color="#4f46e5" stop-opacity="0.62" />
          <stop offset="100%" stop-color="#6d28d9" stop-opacity="0.72" />
        </linearGradient>
        <linearGradient id="anGradMid" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#1d4ed8" stop-opacity="0.48" />
          <stop offset="50%" stop-color="#3b82f6" stop-opacity="0.82" />
          <stop offset="100%" stop-color="#2563eb" stop-opacity="0.86" />
        </linearGradient>
        <linearGradient id="anGradCore" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#06b6d4" stop-opacity="0.78" />
          <stop offset="52%" stop-color="#10b981" stop-opacity="0.96" />
          <stop offset="100%" stop-color="#34d399" stop-opacity="1" />
        </linearGradient>
        <filter id="anGlowMain" x="-10%" y="-30%" width="120%" height="160%">
          <feGaussianBlur stdDeviation="10" result="blur" />
        </filter>
      </defs>
      <path d="${pathOuter}" fill="url(#anGradOuter)" filter="url(#anGlowMain)" opacity="0.55" />
      <path d="${pathOuter}" fill="url(#anGradOuter)" />
      <path d="${pathMid}" fill="url(#anGradMid)" />
      <path d="${pathCore}" fill="url(#anGradCore)" />
    </svg>
    ${checkpointsHtml}
    <div class="an-stream-hits">${hitCols}</div>
  </div>`;
}

function renderCrimsonLossStreamSVG(bins, win) {
  const W = 340, H = 128, cy = H / 2;
  const maxLoss = Math.max(...bins.map((b) => b.lossMs), 1);
  const xs = bins.map((_, i) => (i / (bins.length - 1)) * W);
  const taper = (i) => (i === 0 ? 0.45 : i === bins.length - 1 ? 0.94 : 1);

  const hasFault = bins.some((b) => b.faultMs > 0);
  const hOuter = bins.map((b, i) => Math.max(4, (b.lossMs / maxLoss) * 44 * taper(i)));
  const hMid = bins.map((b, i) => Math.max(3, ((b.holdMs + b.faultMs + b.idleMs * 0.48) / maxLoss) * 32 * taper(i)));
  const hCore = bins.map((b, i) => {
    const coreVal = hasFault ? b.faultMs + b.holdMs * 0.35 : (b.holdMs + b.idleMs * 0.25);
    return Math.max(2, (coreVal / maxLoss) * 20 * taper(i));
  });

  const pOuter = symmetricRibbonPath(xs, hOuter, cy);
  const pMid = symmetricRibbonPath(xs, hMid, cy);
  const pCore = symmetricRibbonPath(xs, hCore, cy);

  const ckIdxs = [2, 5, 7];
  const checkpointsHtml = ckIdxs.map((idx) => {
    const b = bins[idx];
    if (!b) return "";
    const leftPct = ((idx / (bins.length - 1)) * 100).toFixed(2);
    return `
      <span class="an-stream-stem-line" style="left:${leftPct}%"></span>
      <span class="an-stream-pill is-mid" style="left:${leftPct}%">${escapeHtml(fmtCompactDur(b.lossMs))}</span>`;
  }).join("");

  const hitCols = bins.map((b, i) => `<span class="an-stream-hit-col" data-an-slice-idx="${i}"></span>`).join("");

  return `<div class="an-stream-canvas is-mini" data-an-stream-kind="loss">
    <svg class="an-stream-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Downtime and Fault Loss Flow">
      <defs>
        <linearGradient id="anGradRedOuter" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#450a0a" stop-opacity="0.4" />
          <stop offset="50%" stop-color="#991b1b" stop-opacity="0.72" />
          <stop offset="100%" stop-color="#b91c1c" stop-opacity="0.82" />
        </linearGradient>
        <linearGradient id="anGradRedMid" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#b91c1c" stop-opacity="0.58" />
          <stop offset="100%" stop-color="#dc2626" stop-opacity="0.92" />
        </linearGradient>
        <linearGradient id="anGradRedCore" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#ef4444" stop-opacity="0.85" />
          <stop offset="100%" stop-color="#f43f5e" stop-opacity="1" />
        </linearGradient>
        <filter id="anGlowRed" x="-10%" y="-30%" width="120%" height="160%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
      </defs>
      <path d="${pOuter}" fill="url(#anGradRedOuter)" filter="url(#anGlowRed)" opacity="0.6" />
      <path d="${pOuter}" fill="url(#anGradRedOuter)" />
      <path d="${pMid}" fill="url(#anGradRedMid)" />
      <path d="${pCore}" fill="url(#anGradRedCore)" />
    </svg>
    ${checkpointsHtml}
    <div class="an-stream-hits">${hitCols}</div>
  </div>`;
}

function renderVioletQualityStreamSVG(bins, cur, win) {
  const W = 340, H = 116, cy = H / 2;
  const xs = bins.map((_, i) => (i / (bins.length - 1)) * W);
  const baseQ = cur.qualityProxy != null ? cur.qualityProxy : (cur.availability ?? 75);

  const stabVals = bins.map((b) => (b.stabilityPct != null ? b.stabilityPct : baseQ));
  const taper = (i) => (i === 0 || i === bins.length - 1 ? 0.35 : (i === 1 || i === bins.length - 2 ? 0.68 : 1));

  const hOuter = bins.map((b, i) => {
    const activity = b.attendedMs > 0 ? 0.55 + (b.cutShare / 100) * 0.45 : 0.25;
    return Math.max(3.5, (stabVals[i] / 100) * 42 * activity * taper(i));
  });
  const hMid = hOuter.map((h) => Math.max(2.6, h * 0.68));
  const hCore = bins.map((b, i) => Math.max(1.8, (b.cutShare / 100) * 14 * taper(i)));

  const pOuter = symmetricRibbonPath(xs, hOuter, cy);
  const pMid = symmetricRibbonPath(xs, hMid, cy);
  const pCore = symmetricRibbonPath(xs, hCore, cy);

  const ckIdxs = [2, 4, 6];
  const checkpointsHtml = ckIdxs.map((idx) => {
    const b = bins[idx];
    if (!b) return "";
    const leftPct = ((idx / (bins.length - 1)) * 100).toFixed(2);
    const lbl = b.stabilityPct != null ? `${Math.round(b.stabilityPct)}%` : "—";
    return `
      <span class="an-stream-stem-line" style="left:${leftPct}%"></span>
      <span class="an-stream-pill is-mid" style="left:${leftPct}%">${escapeHtml(lbl)}</span>`;
  }).join("");

  const hitCols = bins.map((b, i) => `<span class="an-stream-hit-col" data-an-slice-idx="${i}"></span>`).join("");

  return `<div class="an-stream-canvas is-mini-q" data-an-stream-kind="quality">
    <svg class="an-stream-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Quality and Override Stability Flow">
      <defs>
        <linearGradient id="anGradVioOuter" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#4c1d95" stop-opacity="0.45" />
          <stop offset="50%" stop-color="#7c3aed" stop-opacity="0.78" />
          <stop offset="100%" stop-color="#9333ea" stop-opacity="0.68" />
        </linearGradient>
        <linearGradient id="anGradVioMid" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#a855f7" stop-opacity="0.6" />
          <stop offset="50%" stop-color="#d946ef" stop-opacity="0.88" />
          <stop offset="100%" stop-color="#c084fc" stop-opacity="0.75" />
        </linearGradient>
        <linearGradient id="anGradVioCore" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.92" />
          <stop offset="50%" stop-color="#fb7185" stop-opacity="0.96" />
          <stop offset="100%" stop-color="#fbbf24" stop-opacity="0.95" />
        </linearGradient>
        <filter id="anGlowVio" x="-10%" y="-30%" width="120%" height="160%">
          <feGaussianBlur stdDeviation="8" />
        </filter>
      </defs>
      <path d="${pOuter}" fill="url(#anGradVioOuter)" filter="url(#anGlowVio)" opacity="0.6" />
      <path d="${pOuter}" fill="url(#anGradVioOuter)" />
      <path d="${pMid}" fill="url(#anGradVioMid)" />
      <path d="${pCore}" fill="url(#anGradVioCore)" />
    </svg>
    ${checkpointsHtml}
    <div class="an-stream-hits">${hitCols}</div>
  </div>`;
}

/* Rich color-matched floating slice inspector card for all streamgraphs & cadence chart */
function buildSliceInspectorHTML(kind, b, cur, win, scopeLabel, isSingleMachine) {
  const spanMs = win.to - win.from;
  const timeRange = `${fmtAxisTick(b.from, spanMs)} → ${fmtAxisTick(b.to, spanMs)}`;

  const cutPct = b.cutShare || 0;
  const nonCutPct = b.nonCutShare || 0;

  let badgeLabel = "Execution Flow";
  let layers = [];

  if (kind === "loss") {
    badgeLabel = "Downtime & Fault Breakdown";
    layers = [
      {
        color: "#f43f5e",
        name: "Fault · Alarm & E-Stop",
        sub: `${b.estopsCount} E-Stop · ${b.alarmsCount} Alarm`,
        val: fmtDur(b.faultMs),
        pct: b.lossFaultPct,
        pctCtx: "% of loss",
      },
      {
        color: "#dc2626",
        name: "Feed-Hold / Pause",
        sub: `${b.holdsCount} hold${b.holdsCount === 1 ? "" : "s"}`,
        val: fmtDur(b.holdMs),
        pct: b.lossHoldPct,
        pctCtx: "% of loss",
      },
      {
        color: "#991b1b",
        name: "Idle / Wait Envelope",
        sub: "Spindle stopped",
        val: fmtDur(b.idleMs),
        pct: b.lossIdlePct,
        pctCtx: "% of loss",
      },
      {
        color: "#10b981",
        name: "Cutting (Reference)",
        sub: "Active machining",
        val: fmtDur(b.cutMs),
        pct: cutPct,
        pctCtx: "% of slice",
      },
    ];
  } else if (kind === "quality") {
    badgeLabel = "Quality & Override Flow";
    const fdR = b.fdOvr != null ? Math.round(b.fdOvr) : null;
    const ssR = b.ssOvr != null ? Math.round(b.ssOvr) : null;
    layers = [
      {
        color: "#f59e0b",
        name: "Cutting Share (Amber Core)",
        sub: fmtDur(b.cutMs),
        val: fmtPct(cutPct),
        pct: cutPct,
      },
      {
        color: "#d946ef",
        name: "Clean Cycle Stability (Pink Mid)",
        sub: `${b.holdsCount} interruption${b.holdsCount === 1 ? "" : "s"}`,
        val: b.stabilityPct != null ? fmtPct(b.stabilityPct) : "—",
        pct: b.stabilityPct != null ? b.stabilityPct : 0,
      },
      {
        color: "#7c3aed",
        name: "Override Discipline (Violet Outer)",
        sub: `Feed ${fdR == null ? "—" : `${fdR}%`} · Spindle ${ssR == null ? "—" : `${ssR}%`}`,
        val: fdR != null && ssR != null ? `${Math.round((fdR + ssR) / 2)}%` : "—",
        pct: fdR != null ? Math.min(100, fdR) : 0,
      },
    ];
  } else if (kind === "cadence") {
    badgeLabel = "Output & Cycle Cadence";
    layers = [
      {
        color: "#f97316",
        name: "Parts Completed (Orange Line)",
        sub: b.ratePerHr != null ? `${b.ratePerHr.toFixed(1)} pcs / run-h` : "M30 completions",
        val: `${b.parts} pcs`,
        pct: b.partsSharePct,
        pctCtx: "% of output",
      },
      {
        color: "#10b981",
        name: "Cutting Time",
        sub: "Active spindle",
        val: fmtDur(b.cutMs),
        pct: cutPct,
      },
      {
        color: "#6366f1",
        name: "Non-Cutting (Hold + Idle + Fault)",
        sub: `Hold ${fmtDur(b.holdMs)} · Idle ${fmtDur(b.idleMs)}`,
        val: fmtDur(b.lossMs),
        pct: nonCutPct,
      },
    ];
  } else {
    badgeLabel = "Execution Flow Layers";
    layers = [
      {
        color: "#10b981",
        name: "Cutting Core (Emerald)",
        sub: "Active cutting",
        val: fmtDur(b.cutMs),
        pct: cutPct,
      },
      {
        color: "#3b82f6",
        name: "Active Demand · Feed-Hold (Blue)",
        sub: `${b.holdsCount} hold${b.holdsCount === 1 ? "" : "s"}`,
        val: fmtDur(b.holdMs),
        pct: b.holdShare,
      },
      {
        color: "#6366f1",
        name: "Idle Envelope (Indigo)",
        sub: "Waiting / setup",
        val: fmtDur(b.idleMs),
        pct: b.idleShare,
      },
      ...(b.faultMs > 0 ? [{
        color: "#f43f5e",
        name: "Fault · Alarm / E-Stop (Red)",
        sub: `${b.estopsCount} E-Stop · ${b.alarmsCount} Alm`,
        val: fmtDur(b.faultMs),
        pct: b.faultShare,
      }] : []),
    ];
  }

  const layersHtml = layers.map((l) => {
    const pctNum = Number.isFinite(l.pct) ? Math.max(0, Math.min(100, l.pct)) : 0;
    return `<div class="an-sl-row">
      <div class="an-sl-row-top">
        <span class="an-sl-name">
          <span class="an-sl-swatch" style="background:${l.color}"></span>
          <span class="an-sl-lbl">${escapeHtml(l.name)}</span>
        </span>
        <span class="an-sl-nums">
          <span class="an-sl-val">${escapeHtml(l.val)}</span>
          <span class="an-sl-pct">${fmtPct(l.pct)}</span>
        </span>
      </div>
      <div class="an-sl-bar-row">
        <span class="an-sl-sub">${escapeHtml(l.sub || "")}</span>
        <span class="an-sl-track"><span class="an-sl-fill" style="width:${pctNum.toFixed(1)}%;background:${l.color}"></span></span>
      </div>
    </div>`;
  }).join("");

  const fmtOvrChip = (short, v) => {
    const r = v != null && Number.isFinite(v) ? Math.round(v) : null;
    const isOff = r != null && r !== 100;
    return `<span class="an-sl-ovr-item ${isOff ? "is-off" : ""}">${short} ${r == null ? "—" : `${r}%`}</span>`;
  };
  const anyOvrOff = [b.fdOvr, b.rvOvr, b.ssOvr].some((v) => v != null && Math.round(v) !== 100);

  const avgCycleStr = fmtClock(b.avgCycleMs);
  const cycSub = b.minCycleMs != null
    ? `Best ${fmtClock(b.minCycleMs)}${b.maxCycleMs && b.maxCycleMs !== b.minCycleMs ? ` · Max ${fmtClock(b.maxCycleMs)}` : ""}`
    : (cur.medianCycleMs ? `Window med ${fmtClock(cur.medianCycleMs)}` : "No M30 in slice");

  const partsSub = b.ratePerHr != null
    ? `${b.ratePerHr.toFixed(1)}/run-h · ${Math.round(b.partsSharePct)}% of total`
    : (b.estLostParts != null && kind === "loss"
      ? `≈ ${b.estLostParts} est. lost pcs`
      : `${Math.round(b.partsSharePct)}% of window`);

  const rpmVal = fmtRpm(b.avgRpm);
  const rpmSub = b.peakRpm && b.peakRpm > 0
    ? `Peak ${fmtRpmShort(b.peakRpm)} RPM`
    : (cur.avgRpm ? `Window avg ${fmtRpmShort(cur.avgRpm)}` : "Spindle idle / N/A");

  const mcSectionHtml = !isSingleMachine && b.machines && b.machines.length
    ? `<div class="an-sl-mcs">
        <div class="an-sl-mcs-head">
          <span>Active Machines in Slice</span>
          <span>Cut % · Parts · RPM</span>
        </div>
        ${b.machines.slice(0, 4).map((mc) => {
          const ovNote = mc.fdOvr != null && Math.round(mc.fdOvr) !== 100
            ? ` · <span class="an-sl-ovr-item is-off">F ${Math.round(mc.fdOvr)}%</span>`
            : "";
          return `<div class="an-sl-mc-row">
            <span class="an-sl-mc-id">
              <span class="an-sl-swatch" style="background:${mc.color}"></span>
              <span>${escapeHtml(mc.name)}</span>
            </span>
            <span class="an-sl-mc-stat">
              <strong>${Math.round(mc.cutPct)}%</strong> cut · ${mc.parts} pcs · ${mc.avgRpm ? `${fmtRpmShort(mc.avgRpm)} RPM` : "0 RPM"}${ovNote}
            </span>
          </div>`;
        }).join("")}
      </div>`
    : "";

  return `<div class="an-sl-head">
      <div class="an-sl-head-left">
        <span class="an-sl-time">${escapeHtml(timeRange)}</span>
        <span class="an-sl-scope">${escapeHtml(scopeLabel)} · ${escapeHtml(badgeLabel)}</span>
      </div>
      <span class="an-sl-ratio">
        <strong class="is-cut">${Math.round(cutPct)}%</strong> / <span class="is-loss">${Math.round(nonCutPct)}%</span>
      </span>
    </div>

    <div class="an-sl-split">
      <div class="an-sl-split-labels">
        <span>Cutting <strong>${fmtPct(cutPct)}</strong> (${fmtDur(b.cutMs)})</span>
        <span>Non-Cutting <strong>${fmtPct(nonCutPct)}</strong> (${fmtDur(b.lossMs)})</span>
      </div>
      <div class="an-sl-split-bar">
        <span class="an-sl-split-cut" style="width:${Math.max(0, Math.min(100, cutPct)).toFixed(1)}%"></span>
        <span class="an-sl-split-loss" style="width:${Math.max(0, Math.min(100, nonCutPct)).toFixed(1)}%"></span>
      </div>
    </div>

    <div class="an-sl-layers">${layersHtml}</div>

    <div class="an-sl-grid">
      <div class="an-sl-cell">
        <span class="an-sl-k">Part Count</span>
        <span class="an-sl-v">${b.parts} pcs</span>
        <span class="an-sl-m">${escapeHtml(partsSub)}</span>
      </div>
      <div class="an-sl-cell">
        <span class="an-sl-k">Cycle Time</span>
        <span class="an-sl-v">${avgCycleStr}</span>
        <span class="an-sl-m">${escapeHtml(cycSub)}</span>
      </div>
      <div class="an-sl-cell">
        <span class="an-sl-k">Spindle Speed</span>
        <span class="an-sl-v">${rpmVal}</span>
        <span class="an-sl-m">${escapeHtml(rpmSub)}</span>
      </div>
      <div class="an-sl-cell">
        <span class="an-sl-k">Overrides (100% base)</span>
        <span class="an-sl-v an-sl-ovrs">${fmtOvrChip("F", b.fdOvr)} ${fmtOvrChip("R", b.rvOvr)} ${fmtOvrChip("S", b.ssOvr)}</span>
        <span class="an-sl-m">${anyOvrOff ? "Off 100% nominal" : "All held at 100%"}</span>
      </div>
    </div>
    ${mcSectionHtml}`;
}

/* ==================================== ZONE 2: 4 TACTILE PATTERN WIDGETS */

function renderPatternWidgetsRow(cur, pareto, bins, win, filterId) {
  return `<section class="an-pattern-grid">
    ${renderWaveProgressWidget(cur, bins)}
    ${renderDotMatrixWidget(cur)}
    ${renderHatchedDonutWidget(pareto, filterId)}
    ${renderDiagonalChartlineWidget(bins, cur, win)}
  </section>`;
}

/* Widget 1: Organic Liquid Wave Progress Bar + Diagonal-Hatched Remaining Circle */
function renderWaveProgressWidget(cur, bins) {
  const hasOee = cur.oee != null;
  const pct = hasOee ? Math.max(0, Math.min(100, cur.oee)) : Math.max(0, Math.min(100, cur.utilization || 0));
  const title = hasOee ? "OEE-Lite Efficiency" : "Spindle Utilization";
  const sub = hasOee
    ? `Avail ${fmtPctInt(cur.availability)} × Perf ${fmtPctInt(cur.performance)}`
    : `Cutting vs total window time`;

  const maxCut = Math.max(...bins.map((b) => b.cutMs), 1);
  const silPts = bins.map((b, i) => ({
    x: (i / (bins.length - 1)) * 280,
    y: 120 - (b.cutMs / maxCut) * 58,
  }));
  const silPath = `${smoothLinePath(silPts)} L 280 140 L 0 140 Z`;

  const trackW = 212;
  const fillW = Math.max(12, (pct / 100) * trackW);
  const tipX = Math.min(trackW, fillW);
  const barGradA = pct >= 70 ? "#10b981" : pct >= 45 ? "#f97316" : "#f43f5e";
  const barGradB = pct >= 70 ? "#22d3ee" : pct >= 45 ? "#fb923c" : "#fb7185";

  return `<article class="an-card an-pcard" data-tip-title="${tipAttr(title)}" data-tip="${tipAttr(`${fmtPct(pct)} overall (${sub}). Solid wave shows achieved efficiency; hatched disc represents recoverable capacity.`)}">
    <svg class="an-pcard-bg-sil" viewBox="0 0 280 140" preserveAspectRatio="none" aria-hidden="true">
      <path d="${silPath}" fill="var(--an-sil-fill)" />
    </svg>
    <div class="an-pcard-head">
      <div>
        <h4 class="an-pcard-title">${title}</h4>
        <span class="an-pcard-sub">${sub}</span>
      </div>
      <span class="an-audit-gem ${pct >= 70 ? "is-ok" : pct >= 45 ? "is-warn" : "is-bad"}">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="22 10"/></svg>
      </span>
    </div>

    <div class="an-wave-block">
      <div class="an-wave-meta">
        <span>Progress bar</span>
        <span class="an-wave-pct">${fmtPctInt(pct)}</span>
      </div>
      <svg class="an-wave-svg" viewBox="0 0 264 46" role="img" aria-label="${title} ${Math.round(pct)}%">
        <defs>
          <clipPath id="anWaveClip">
            <rect x="0" y="14" width="${fillW.toFixed(1)}" height="24" rx="12" />
          </clipPath>
          <linearGradient id="anWaveGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="${barGradA}" />
            <stop offset="100%" stop-color="${barGradB}" />
          </linearGradient>
          <pattern id="anWaveHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--an-hatch-strong)" stroke-width="2" />
          </pattern>
        </defs>
        <rect x="0" y="14" width="${trackW}" height="24" rx="12" fill="var(--kb-track)" />
        <g clip-path="url(#anWaveClip)">
          <rect x="0" y="14" width="${trackW}" height="24" fill="url(#anWaveGrad)" />
          <path d="M 0 24 Q 26 16 52 24 T 104 24 T 156 24 T 212 24 L 212 40 L 0 40 Z" fill="rgba(255,255,255,0.22)" />
          <path d="M 0 28 Q 32 21 64 28 T 128 28 T 192 28 T 224 28 L 224 40 L 0 40 Z" fill="rgba(0,0,0,0.14)" />
        </g>
        <line x1="${(tipX + 6).toFixed(1)}" y1="11" x2="${(tipX + 6).toFixed(1)}" y2="41" stroke="var(--kb-bar-cap)" stroke-width="1.5" opacity="0.85" />
        <path d="M ${(tipX + 6).toFixed(1)} 2 L ${(tipX + 9.5).toFixed(1)} 7.2 A 3.5 3.5 0 1 1 ${(tipX + 2.5).toFixed(1)} 7.2 Z" fill="var(--kb-bar-cap)" />
        <circle cx="244" cy="26" r="15" fill="url(#anWaveHatch)" stroke="var(--kb-border-strong)" stroke-width="1" />
      </svg>
    </div>
  </article>`;
}

/* Widget 2: 50-Cell Dot Matrix Pattern Hero (Images 2 & 3 signature) */
function renderDotMatrixWidget(cur) {
  const avail = cur.availability != null ? Math.max(0, Math.min(100, cur.availability)) : 0;
  const cols = 10, rows = 5;
  const totalDots = cols * rows;
  const filled = Math.round((avail / 100) * totalDots);

  const r = 8.4;
  const stepX = 25.5;
  const stepY = 20.5;
  const padX = 13;
  const padY = 12;

  let dotsSvg = "";
  for (let row = 0; row < rows; row++) {
    const revRow = rows - 1 - row;
    for (let col = 0; col < cols; col++) {
      const idx = revRow * cols + col;
      const isFilled = idx < filled;
      const cx = padX + col * stepX;
      const cy = padY + row * stepY;
      dotsSvg += isFilled
        ? `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="url(#anDotFill)" />`
        : `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="url(#anDotHatch)" stroke="var(--an-hatch-stroke)" stroke-width="0.7" />`;
    }
  }

  return `<article class="an-card an-pcard" data-tip-title="Fleet Availability Matrix" data-tip="${tipAttr(`${fmtPct(avail)} attended cutting share (${filled}/${totalDots} cells filled · each circle = 2%). Solid = Cutting, Hatched = Idle/Hold/Fault.`)}">
    <div class="an-pcard-head">
      <div>
        <h4 class="an-pcard-title">Availability</h4>
        <span class="an-pcard-sub">50-cell pattern matrix</span>
      </div>
      <span class="an-pcard-big">${fmtPctInt(avail)}</span>
    </div>

    <svg class="an-dot-svg" viewBox="0 0 256 106" role="img" aria-label="Availability ${Math.round(avail)}%">
      <defs>
        <linearGradient id="anDotFill" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#c084fc" />
          <stop offset="100%" stop-color="#8b5cf6" />
        </linearGradient>
        <pattern id="anDotHatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="var(--an-hatch-strong)" stroke-width="1.6" />
        </pattern>
      </defs>
      ${dotsSvg}
    </svg>

    <div class="an-pcard-foot">
      <span>Cut ${fmtDur(cur.runMs)}</span>
      <span>Loss ${fmtDur(cur.lossMs)}</span>
    </div>
  </article>`;
}

/* Widget 3: Hatched-Ring Radial Sector Donut (Downtime Mix — Images 2 & 3 signature) */
function renderHatchedDonutWidget(pareto, filterId) {
  const cx = 75, cy = 75;
  const rows = pareto.rows;

  let wedgesSvg = "";
  if (!rows.length) {
    wedgesSvg = `<circle cx="${cx}" cy="${cy}" r="42" fill="none" stroke="#22c55e" stroke-width="12" opacity="0.85" />
      <text x="${cx}" y="${cy}" class="an-donut-lbl" style="fill:var(--text);font-size:13px">0m loss</text>`;
  } else {
    let angle = -18;
    wedgesSvg = rows.map((r, i) => {
      const span = Math.max(4, (r.share / 100) * 360);
      const start = angle;
      const end = angle + span;
      angle = end;
      const mid = (start + end) / 2;
      const outerR = i === 0 ? 68 : 62;
      const petal = sectorPath(cx, cy, 40, outerR, start + 1, end - 1);
      const core = sectorPath(cx, cy, 12, 46, start + 1, end - 1);
      const lblPos = polarToXY(cx, cy, 38, mid);
      const topNote = !filterId && r.top ? ` · Top: ${r.top.name} (${fmtDur(r.top.ms)})` : "";
      const tip = `${fmtDur(r.ms)} (${r.share.toFixed(1)}% of non-cutting loss)${topNote}`;
      const machineAttr = !filterId && r.top ? `data-an-machine="${escapeHtml(r.top.id)}"` : "";

      return `<g class="an-donut-wedge" ${machineAttr} data-tip-title="${tipAttr(r.label)}" data-tip="${tipAttr(tip)}">
        <path d="${petal}" fill="${r.color}" opacity="0.46" />
        <path d="${core}" fill="${r.color}" opacity="0.94" />
        ${r.share >= 10 ? `<text class="an-donut-lbl" x="${lblPos.x.toFixed(1)}" y="${lblPos.y.toFixed(1)}">${Math.round(r.share)}%</text>` : ""}
      </g>`;
    }).join("");
  }

  const footText = rows.length
    ? rows.slice(0, 3).map((r) => `${r.label.split(" ")[0]} ${Math.round(r.share)}%`).join(" · ")
    : "Zero audited downtime";

  return `<article class="an-card an-pcard">
    <div class="an-pcard-head">
      <div>
        <h4 class="an-pcard-title">Downtime Mix</h4>
        <span class="an-pcard-sub">${fmtDur(pareto.totalMs)} audited loss</span>
      </div>
    </div>

    <div class="an-donut-wrap">
      <svg class="an-donut-svg" viewBox="0 0 150 150" role="img" aria-label="Downtime Cause Breakdown">
        <defs>
          <pattern id="anRingHatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
            <line x1="0" y1="0" x2="0" y2="5" stroke="var(--an-hatch-strong)" stroke-width="1.7" />
          </pattern>
        </defs>
        <circle cx="${cx}" cy="${cy}" r="50" fill="none" stroke="url(#anRingHatch)" stroke-width="18" />
        <circle cx="${cx}" cy="${cy}" r="41" fill="var(--an-obsidian)" />
        ${wedgesSvg}
        <circle cx="${cx}" cy="${cy}" r="11" fill="var(--an-obsidian)" />
      </svg>
    </div>

    <div class="an-pcard-foot">
      <span>${escapeHtml(footText)}</span>
    </div>
  </article>`;
}

/* Widget 4: Diagonal-Stripe Area Chartline (Output & Cutting Cadence — Image 3 signature) */
function renderDiagonalChartlineWidget(bins, cur, win) {
  const hasParts = bins.some((b) => b.parts > 0);
  const vals = bins.map((b) => (hasParts ? b.parts : Math.round(b.cutMs / 60000)));
  const maxVal = Math.max(...vals, 1);

  const W = 260, H = 126;
  const padTop = 18, padBot = 10;
  const pts = vals.map((v, i) => ({
    x: (i / (vals.length - 1)) * W,
    y: H - padBot - (v / maxVal) * (H - padTop - padBot),
  }));

  let peakIdx = 0;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] >= vals[peakIdx]) peakIdx = i;
  }
  const peak = pts[peakIdx];
  const peakLeftPct = Math.max(4, Math.min(96, (peak.x / W) * 100));
  const peakTopPx = 6 + peak.y;
  const linePath = smoothLinePath(pts);
  const areaPath = `${linePath} L ${W} ${H} L 0 ${H} Z`;

  const hitCols = bins.map((b, i) => `<span class="an-stream-hit-col" data-an-slice-idx="${i}"></span>`).join("");

  const sub = hasParts
    ? `${cur.parts} pcs · ${cur.partRateRun != null ? `${cur.partRateRun.toFixed(1)}/run-h` : win.label}`
    : `${fmtDur(cur.runMs)} cutting across ${win.label}`;

  return `<article class="an-card an-pcard">
    <div class="an-pcard-head">
      <div>
        <h4 class="an-pcard-title">Output Cadence</h4>
        <span class="an-pcard-sub">${escapeHtml(sub)}</span>
      </div>
      <span class="an-audit-gem is-warn">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M2 11 6 7 9.5 9.5 14 4"/></svg>
      </span>
    </div>

    <div class="an-chartline-wrap" data-an-stream-kind="cadence">
      <svg class="an-chartline-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Output Cadence Chartline">
        <defs>
          <pattern id="anLineStripe" width="11" height="11" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
            <line x1="0" y1="0" x2="0" y2="11" stroke="var(--an-hatch-strong)" stroke-width="4.2" />
          </pattern>
        </defs>
        <path d="${areaPath}" fill="url(#anLineStripe)" />
        <path d="${linePath}" fill="none" stroke="#f97316" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
      </svg>
      <span class="an-peak-dot" style="left:${peakLeftPct.toFixed(1)}%;top:${peakTopPx.toFixed(1)}px" aria-hidden="true"></span>
      <div class="an-stream-hits">${hitCols}</div>
    </div>
  </article>`;
}

/* =================================== ZONE 3: SYNCHRONIZED FLEET TIMELINE */

function renderSynchronizedTimeline(items, win, colorMap, ui) {
  const spanMs = (win.to - win.from) || 1;
  const tickFracs = [0, 0.25, 0.5, 0.75, 1];
  const ticksHtml = tickFracs.map((f) => `<span>${escapeHtml(fmtAxisTick(win.from + f * spanMs, spanMs))}</span>`).join("");

  const legendItems = [
    { label: "Cutting",        color: STATE_META.cut.color },
    { label: "Feed-Hold",      color: STATE_META.hold.color },
    { label: "Idle",           color: STATE_META.idle.color },
    { label: "Alarm / E-Stop", color: STATE_META.alarm.color },
    { label: "Offline",        color: STATE_META.offline.color },
  ];

  const lanesHtml = items.map((it) => {
    const id = String(it.id).toUpperCase();
    const col = colorMap.get(id) || "#3b82f6";
    const isSel = ui.selectedMachine === id;
    const isDim = ui.selectedMachine && !isSel;
    const hasSegs = it.tlSegs && it.tlSegs.length > 0;
    const cutPct = it.x && it.x.utilization != null ? Math.round(it.x.utilization) : (it.online ? null : 0);
    const subTxt = it.error ? "Error" : it.online ? `${it.x ? it.x.parts : 0} pcs` : "Offline";

    return `<div class="an-tl-lane ${isSel ? "is-active" : ""} ${isDim ? "is-dim" : ""}" data-an-machine="${escapeHtml(id)}">
      <div class="an-tl-mc">
        <span class="kb-swatch" style="background:${col}"></span>
        <div class="an-tl-mc-info">
          <span class="an-tl-mc-name">${escapeHtml(it.name)}</span>
          <span class="an-tl-mc-state ${!it.online || it.error ? "is-off" : ""}">${escapeHtml(subTxt)}</span>
        </div>
      </div>
      <div class="an-tl-track ${!hasSegs ? "is-offline" : ""}" data-an-tl-track="${escapeHtml(id)}">
        <canvas class="an-tl-canvas" data-an-canvas="${escapeHtml(id)}"></canvas>
      </div>
      <span class="an-tl-pct ${cutPct == null || cutPct === 0 ? "is-muted" : ""}">${cutPct == null ? "—" : `${cutPct}%`}</span>
    </div>`;
  }).join("");

  return `<section class="an-card">
    <div class="kb-card-head">
      <div class="kb-card-title-wrap">
        <h3 class="kb-card-title">Synchronized Fleet State Timeline</h3>
        <span class="kb-card-sub">Scrub horizontally to inspect every machine at the exact same timestamp · click a lane to drill down</span>
      </div>
      <div class="an-tl-legend">
        ${legendItems.map((l) => `
          <span class="an-tl-leg-item">
            <span class="kb-swatch" style="background:${l.color}"></span>
            <span>${l.label}</span>
          </span>`).join("")}
      </div>
    </div>
    <div class="an-tl-stage" id="anTlStage">
      <div class="an-tl-lanes">
        ${lanesHtml || `<div class="kb-empty">No machines reported for this window.</div>`}
        <div class="an-tl-overlay" id="anTlOverlay">
          <div class="an-tl-grid"><span></span><span></span><span></span><span></span><span></span></div>
          <div class="an-tl-cursor" id="anTlCursor"></div>
        </div>
      </div>
      <div class="an-tl-axis">
        <span></span>
        <div class="an-tl-ticks">${ticksHtml}</div>
        <span></span>
      </div>
      <div class="an-tl-tip" id="anTlTip"></div>
    </div>
  </section>`;
}

function drawAllLaneCanvases(root, data) {
  if (!data || !data.items) return;
  const { items, win } = data;
  const byId = new Map(items.map((it) => [String(it.id).toUpperCase(), it]));
  const span = (win.to - win.from) || 1;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  root.querySelectorAll("[data-an-canvas]").forEach((cv) => {
    const id = String(cv.dataset.anCanvas || "").toUpperCase();
    const it = byId.get(id);
    if (!it) return;
    const rect = cv.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height || 24));
    const pxW = Math.round(cssW * dpr);
    const pxH = Math.round(cssH * dpr);
    if (cv.width !== pxW || cv.height !== pxH) {
      cv.width = pxW;
      cv.height = pxH;
    }
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const segs = it.tlSegs || [];
    if (!segs.length) return;

    for (const s of segs) {
      if (s.kind === "alarm" || s.kind === "estop") continue;
      const x0 = ((s.from - win.from) / span) * cssW;
      const x1 = ((s.to - win.from) / span) * cssW;
      ctx.fillStyle = (STATE_META[s.kind] || STATE_META.offline).color;
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), cssH);
    }
    for (const s of segs) {
      if (s.kind !== "alarm" && s.kind !== "estop") continue;
      const x0 = ((s.from - win.from) / span) * cssW;
      const x1 = ((s.to - win.from) / span) * cssW;
      ctx.fillStyle = STATE_META[s.kind].color;
      ctx.fillRect(x0, 0, Math.max(2, x1 - x0), cssH);
    }
  });
}

function buildTimelineInspectorHTML(items, ts, spanMs, colorMap, focusedId) {
  let cuttingCount = 0;
  const rows = items.map((it) => {
    const id = String(it.id).toUpperCase();
    const st = stateAtTime(it, ts);
    if (st.kind === "cut") cuttingCount += 1;
    const stCol = (STATE_META[st.kind] || STATE_META.offline).color;
    const isFocus = focusedId && focusedId === id;
    return `<div class="an-tl-tip-row ${isFocus ? "is-focus" : ""}">
      <span class="kb-tip-tick" style="background:${stCol}"></span>
      <span class="kb-tip-name">${escapeHtml(it.name)}</span>
      <span class="an-tl-tip-state">${escapeHtml(st.label)}</span>
      <span class="an-tl-tip-dur">${st.dur != null ? fmtDur(st.dur) : "—"}</span>
    </div>`;
  }).join("");

  return `<div class="kb-tip-head">
      <span class="kb-tip-title">${escapeHtml(fmtInspectTime(ts, spanMs))}</span>
      <span class="kb-tip-tot">${cuttingCount}/${items.length} cutting</span>
    </div>
    <div class="kb-tip-list">${rows}</div>`;
}

/* =============================== ZONE 4: FOCUSED MACHINE DRILL-DOWN PANEL */

function renderMachineDrillDown(item, pareto, colorMap, ui) {
  const x = item.x;
  if (!x) return "";

  const paretoHtml = pareto.rows.length
    ? pareto.rows.map((r) => `
      <div class="an-pareto-row">
        <div class="an-pareto-top">
          <span class="an-pareto-cause"><span class="kb-swatch" style="background:${r.color}"></span><span>${escapeHtml(r.label)}</span></span>
          <span class="an-pareto-nums"><span class="an-pareto-dur">${fmtDur(r.ms)}</span><span class="an-pareto-share">${Math.round(r.share)}%</span></span>
        </div>
        <div class="kb-stripe-track">
          <div class="kb-stripe-fill" style="width:${Math.max(3, Math.min(100, r.share)).toFixed(1)}%;background-color:${r.color}"></div>
        </div>
      </div>`).join("")
    : `<div class="kb-empty">Zero recorded downtime for ${escapeHtml(item.name)}.</div>`;

  const ov = x.ovr || {};
  const toggleBtns = ["feed", "rapid", "spindle"].map((k) => {
    const ch = OVR_CHANNELS[k];
    return `<button type="button" class="kb-seg-btn ${ui.ovrChannel === k ? "is-active" : ""}" data-an-ovr-ch="${k}">${ch.label}</button>`;
  }).join("");

  const ovrRowsHtml = ["feed", "rapid", "spindle"].map((k) => {
    const ch = OVR_CHANNELS[k];
    const val = ov[ch.key];
    const offPct = ov[ch.offKey] != null ? Math.round(ov[ch.offKey] * 100) : 0;
    const rounded = val != null && Number.isFinite(val) ? Math.round(val) : null;
    const isOff = rounded != null && (rounded !== 100 || offPct > 0);
    const barW = rounded == null ? 0 : Math.max(3, Math.min(100, (rounded / 125) * 100));
    const barColor = rounded == null ? "#64748b" : rounded < 100 ? "#f59e0b" : rounded > 100 ? "#8b5cf6" : offPct > 0 ? "#f59e0b" : "#22c55e";
    const isHi = ui.ovrChannel === k;

    return `<div class="an-ovr-row" style="${isHi ? "" : "opacity:0.72"}">
      <div class="an-ovr-top">
        <span class="an-ovr-name">${ch.label} Override</span>
        <span class="an-ovr-val ${isOff ? "is-off" : ""}">${rounded == null ? "—" : `${rounded}%`}</span>
      </div>
      <div class="an-ovr-track">
        <div class="an-ovr-fill" style="width:${barW.toFixed(1)}%;background-color:${barColor}"></div>
        <span class="an-ovr-ref" aria-hidden="true"></span>
      </div>
      <div class="an-ovr-meta">
        <span>${rounded == null ? "No samples" : offPct > 0 ? `${offPct}% of window off 100%` : "Held at 100% nominal"}</span>
        <span>100% ▏</span>
      </div>
    </div>`;
  }).join("");

  const cs = x.cstats || {};
  const es = (x.estopEvents && x.estopEvents.count) || 0;
  const al = (x.alarmEvents && x.alarmEvents.count) || 0;
  const auditLvl = item.conf ? item.conf.level : "warn";

  return `<section class="an-drill">
    <article class="an-card">
      <div class="kb-card-head">
        <div class="kb-card-title-wrap">
          <h3 class="kb-card-title">${escapeHtml(item.name)} · Downtime Pareto</h3>
          <span class="kb-card-sub">${fmtDur(pareto.totalMs)} audited non-cutting loss</span>
        </div>
      </div>
      <div class="an-pareto-list">${paretoHtml}</div>
    </article>

    <article class="an-card">
      <div class="kb-card-head">
        <div class="kb-card-title-wrap">
          <h3 class="kb-card-title">Override Discipline</h3>
          <span class="kb-card-sub">F / R / S vs 100% nominal marker</span>
        </div>
        <div class="kb-seg">${toggleBtns}</div>
      </div>
      <div class="an-ovr-list">${ovrRowsHtml}</div>
    </article>

    <article class="an-card">
      <div class="kb-card-head">
        <div class="kb-card-title-wrap">
          <h3 class="kb-card-title">Cycle &amp; Fault Forensics</h3>
          <span class="kb-card-sub">Audit: <span class="an-audit-txt is-${auditLvl}">${escapeHtml(item.conf ? item.conf.label : "Unknown")}</span>${item.conf && item.conf.detail ? ` · ${escapeHtml(item.conf.detail)}` : ""}</span>
        </div>
      </div>
      <div class="an-forensics-grid">
        <div class="an-fstat">
          <span class="an-fstat-k">p10 Best Cycle</span>
          <span class="an-fstat-v">${fmtClock(cs.p10)}</span>
        </div>
        <div class="an-fstat">
          <span class="an-fstat-k">Median Cycle</span>
          <span class="an-fstat-v">${fmtClock(cs.median)}</span>
        </div>
        <div class="an-fstat">
          <span class="an-fstat-k">p90 Slow Cycle</span>
          <span class="an-fstat-v">${fmtClock(cs.p90)}</span>
        </div>
        <div class="an-fstat">
          <span class="an-fstat-k">Parts / Run-Hour</span>
          <span class="an-fstat-v">${x.partRateRun != null ? x.partRateRun.toFixed(1) : "—"}</span>
        </div>
        <div class="an-fstat">
          <span class="an-fstat-k">Avg Spindle Speed</span>
          <span class="an-fstat-v">${fmtRpm(item.spindle ? item.spindle.avgRpm : null)}</span>
        </div>
        <div class="an-fstat">
          <span class="an-fstat-k">Peak Spindle Speed</span>
          <span class="an-fstat-v">${fmtRpm(item.spindle ? item.spindle.peakRpm : null)}</span>
        </div>
        <div class="an-fstat" style="border-bottom:0;padding-bottom:0">
          <span class="an-fstat-k">E-Stops · Alarms</span>
          <span class="an-fstat-v ${es + al > 0 ? "an-strip-sub-bad" : "an-strip-sub-ok"}">${es} · ${al}</span>
        </div>
        <div class="an-fstat" style="border-bottom:0;padding-bottom:0">
          <span class="an-fstat-k">Quality Proxy</span>
          <span class="an-fstat-v">${fmtPct(x.qualityProxy)}</span>
        </div>
      </div>
    </article>
  </section>`;
}

/* ============================== ZONE 5: CLICKABLE MACHINE DIAGNOSTIC CARDS */

function renderMachineCardsSection(items, colorMap, ui) {
  const cardsHtml = items.map((it) => {
    const id = String(it.id).toUpperCase();
    const col = colorMap.get(id) || "#3b82f6";

    if (it.error) {
      return `<article class="an-card an-mcard is-error">
        <div class="an-mcard-head">
          <div class="an-mcard-id">
            <span class="kb-swatch" style="background:${col}"></span>
            <div class="an-mcard-title-wrap">
              <span class="an-mcard-name">${escapeHtml(it.name)}</span>
              <span class="an-mcard-status"><span class="an-audit-txt is-bad">Telemetry Error</span></span>
            </div>
          </div>
          ${radialRing(null)}
        </div>
        <p class="an-mcard-err-msg" role="alert">${escapeHtml(it.error)}</p>
      </article>`;
    }

    const x = it.x || {};
    const isSel = ui.selectedMachine === id;
    const isDim = ui.selectedMachine && !isSel;
    const b = x.buckets || { run: 0, pause: 0, idle: 0, other: 0 };
    const dt = x.downtime || {};
    const faultMs = (dt["E-STOP"] || 0) + (dt.ALARM || 0);
    const holdMs = dt["FEED-HOLD"] != null ? dt["FEED-HOLD"] : (b.pause || 0);
    const idleMs = dt.IDLE != null ? dt.IDLE : (b.idle || 0);
    const otherMs = dt.OTHER != null ? dt.OTHER : (b.other || 0);
    const runMs = b.run || 0;
    const totalMs = (runMs + holdMs + idleMs + faultMs + otherMs) || 1;

    const mixSegs = [
      { key: "Cutting",   ms: runMs,   color: STATE_META.cut.color },
      { key: "Feed-Hold", ms: holdMs,  color: STATE_META.hold.color },
      { key: "Idle",      ms: idleMs,  color: STATE_META.idle.color },
      { key: "Fault",     ms: faultMs, color: STATE_META.alarm.color },
      { key: "Offline",   ms: otherMs, color: STATE_META.offline.color },
    ].filter((s) => s.ms > 0);

    const ov = x.ovr || {};
    const fmtOvr = (short, v) => {
      const r = v != null && Number.isFinite(v) ? Math.round(v) : null;
      const off = r != null && r !== 100;
      return `<span class="an-ovr-ch ${off ? "is-off" : ""}">${short} ${r == null ? "—" : `${r}%`}</span>`;
    };

    const es = (x.estopEvents && x.estopEvents.count) || 0;
    const al = (x.alarmEvents && x.alarmEvents.count) || 0;
    const faultStr = es > 0
      ? `<span class="an-strip-sub-bad">${es} E-Stop${es === 1 ? "" : "s"}${al > 0 ? ` · ${al} Alm` : ""}</span>`
      : al > 0
        ? `<span class="an-strip-sub-bad">${al} Alarm${al === 1 ? "" : "s"}</span>`
        : `<span class="an-strip-sub-ok">No faults</span>`;

    const auditLvl = it.conf ? it.conf.level : "warn";
    const auditLbl = it.conf && it.conf.level === "ok" ? "Gapless" : (it.conf ? it.conf.label : "Unknown");

    const nonCutMs = holdMs + idleMs + faultMs + otherMs;
    const cutPct = (runMs / totalMs) * 100;
    const nonCutPct = (nonCutMs / totalMs) * 100;
    const holdPct = (holdMs / totalMs) * 100;
    const idlePct = (idleMs / totalMs) * 100;
    const faultPct = (faultMs / totalMs) * 100;
    const avgRpm = it.spindle ? it.spindle.avgRpm : null;
    const peakRpm = it.spindle ? it.spindle.peakRpm : null;
    const bestCyc = x.cstats ? x.cstats.p10 : null;
    const medCyc = x.cstats ? x.cstats.median : null;

    return `<article class="an-card an-mcard ${isSel ? "is-active" : ""} ${isDim ? "is-dim" : ""}"
      role="button" tabindex="0" aria-pressed="${isSel ? "true" : "false"}"
      data-an-machine="${escapeHtml(id)}">
      <div class="an-mcard-head">
        <div class="an-mcard-id">
          <span class="kb-swatch" style="background:${col}"></span>
          <div class="an-mcard-title-wrap">
            <span class="an-mcard-name">${escapeHtml(it.name)}</span>
            <span class="an-mcard-status">
              <span class="${it.online ? "an-strip-sub-ok" : "an-strip-sub-bad"}">${it.online ? "Online" : "Offline"}</span>
              <span aria-hidden="true">·</span>
              <span class="an-audit-txt is-${auditLvl}">${escapeHtml(auditLbl)}</span>
            </span>
          </div>
        </div>
        ${radialRing(x.oee)}
      </div>

      <div class="an-mcard-metrics is-rich">
        <div class="an-mc-stat">
          <span class="an-mc-stat-k">Cutting</span>
          <span class="an-mc-stat-v is-cut">${fmtPctInt(cutPct)}</span>
          <span class="an-mc-stat-s">${fmtDur(runMs)}</span>
        </div>
        <div class="an-mc-stat">
          <span class="an-mc-stat-k">Non-Cutting</span>
          <span class="an-mc-stat-v is-loss">${fmtPctInt(nonCutPct)}</span>
          <span class="an-mc-stat-s">${fmtDur(nonCutMs)}</span>
        </div>
        <div class="an-mc-stat">
          <span class="an-mc-stat-k">Spindle RPM</span>
          <span class="an-mc-stat-v">${avgRpm ? fmtRpmShort(avgRpm) : "—"}</span>
          <span class="an-mc-stat-s">${peakRpm ? `Pk ${fmtRpmShort(peakRpm)}` : "No RPM"}</span>
        </div>
        <div class="an-mc-stat">
          <span class="an-mc-stat-k">Part Count</span>
          <span class="an-mc-stat-v">${x.parts || 0} pcs</span>
          <span class="an-mc-stat-s">${x.partRateRun != null ? `${x.partRateRun.toFixed(1)}/run-h` : "0/run-h"}</span>
        </div>
        <div class="an-mc-stat">
          <span class="an-mc-stat-k">Cycle Time</span>
          <span class="an-mc-stat-v">${fmtClock(medCyc)}</span>
          <span class="an-mc-stat-s">${bestCyc ? `Best ${fmtClock(bestCyc)}` : "Median"}</span>
        </div>
        <div class="an-mc-stat">
          <span class="an-mc-stat-k">Avail · Perf</span>
          <span class="an-mc-stat-v">${fmtPctInt(x.availability)} · ${fmtPctInt(x.performance)}</span>
          <span class="an-mc-stat-s">Util ${fmtPctInt(x.utilization)}</span>
        </div>
      </div>

      <div class="an-mcard-mix">
        <div class="an-mix-bar">
          ${mixSegs.map((s) => `
            <span class="an-mix-seg" style="width:${((s.ms / totalMs) * 100).toFixed(2)}%;background:${s.color}"
              data-tip-title="${tipAttr(`${it.name} · ${s.key}`)}"
              data-tip="${tipAttr(`${fmtDur(s.ms)} (${((s.ms / totalMs) * 100).toFixed(1)}%)`)}"></span>`).join("")}
        </div>
        <div class="an-mix-meta">
          <span class="an-mix-leg-inline">
            <span class="an-mix-dot" style="background:${STATE_META.cut.color}"></span>Cut ${Math.round(cutPct)}%
            <span class="an-mix-dot" style="background:${STATE_META.hold.color}"></span>Hold ${Math.round(holdPct)}%
            <span class="an-mix-dot" style="background:${STATE_META.idle.color}"></span>Idle ${Math.round(idlePct)}%
            ${faultMs > 0 ? `<span class="an-mix-dot" style="background:${STATE_META.alarm.color}"></span>Fault ${Math.round(faultPct)}%` : ""}
          </span>
        </div>
      </div>

      <div class="an-mcard-foot">
        <span class="an-mcard-ovr">
          ${fmtOvr("F", ov.feed)}
          ${fmtOvr("R", ov.rapid)}
          ${fmtOvr("S", ov.spindle)}
        </span>
        <span class="an-mcard-diag">
          ${faultStr}
          <span aria-hidden="true">·</span>
          <span>Q ${fmtPctInt(x.qualityProxy)}</span>
        </span>
      </div>
    </article>`;
  }).join("");

  return `<section>
    <div class="an-section-head">
      <h3 class="an-section-title">Machine Diagnostic Cards</h3>
      <span class="kb-card-sub">Click any machine card to isolate streamgraphs, pattern widgets &amp; open root-cause drill-down</span>
    </div>
    <div class="an-cards-grid">
      ${cardsHtml || `<div class="kb-card kb-empty">No machines reported by the collector.</div>`}
    </div>
  </section>`;
}

function radialRing(val) {
  const pct = val == null || !Number.isFinite(val) ? 0 : Math.max(0, Math.min(100, val));
  const r = 14.5;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  const stroke = val == null ? "#64748b" : val >= 70 ? "#22c55e" : val >= 45 ? "#f59e0b" : "#f43f5e";
  return `<svg class="kb-ring-svg" viewBox="0 0 36 36" aria-label="OEE ${fmtPctInt(val)}">
    <circle class="kb-ring-bg" cx="18" cy="18" r="${r}" />
    <circle class="kb-ring-fg" cx="18" cy="18" r="${r}" stroke="${stroke}"
      stroke-dasharray="${dash.toFixed(2)} ${circ.toFixed(2)}" />
    <text class="kb-ring-txt" x="18" y="18">${val == null ? "—" : Math.round(val)}</text>
  </svg>`;
}
