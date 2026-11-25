/* VMC God-mode — KPI analysis engine.
 *
 * Everything the KPI console reasons over, computed from REAL cycles + metrics.
 * Reuses computeMachine (metrics.js) so OEE/availability/parts agree with the
 * rest of the dashboard, and theilSen/stats (analyticsCore.js) for trends.
 *
 * Cycles are the unit of work: each is { end (ms), dur (ms), program }. From the
 * fleet's cycles over a window we slice KPIs by program, by day, and by hour —
 * the "different angles" view: same program across periods, best day, peak hour,
 * and whether we're improving.
 */

import { computeMachine } from "./metrics.js";
import { theilSen, stats } from "./analyticsCore.js";

/* Pull every machine's metric bundle for a window, tagging each cycle with its
 * machine so fleet-wide slicing keeps provenance. Returns { perMachine, cycles }. */
export async function fleetBundle(dataLayer, machines, win) {
  const perMachine = await Promise.all(
    machines.map(async (m) => {
      try {
        const x = await computeMachine(dataLayer, m.machine_id, win);
        return { id: m.machine_id, name: m.machine_name || m.machine_id, online: !!m.online, x };
      } catch (_) { return { id: m.machine_id, name: m.machine_name || m.machine_id, online: !!m.online, x: null }; }
    })
  );
  const cycles = [];
  for (const pm of perMachine) {
    if (!pm.x) continue;
    for (const c of pm.x.cycles) cycles.push({ ...c, machine: pm.id });
  }
  return { perMachine, cycles };
}

/* Fleet KPI aggregate from perMachine bundles (avg of machine OEE etc., sum parts). */
export function fleetKpis(perMachine) {
  const xs = perMachine.map((p) => p.x).filter(Boolean);
  const avg = (f) => { const v = xs.map(f).filter((n) => n != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const sum = (f) => xs.reduce((a, x) => a + (f(x) || 0), 0);
  return {
    oee: avg((x) => x.oee), avail: avg((x) => x.availability),
    perf: avg((x) => x.performance), util: avg((x) => x.utilization),
    parts: sum((x) => x.parts),
    runMs: sum((x) => x.buckets.run),
  };
}

/* ---------- by PROGRAM ----------
 * Group cycles by program name; per-program cycle-time stats + production share.
 * This is the "which job runs how" cut. */
export function byProgram(cycles) {
  const groups = new Map();
  for (const c of cycles) {
    const key = c.program || "(unknown)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const totalRun = cycles.reduce((a, c) => a + c.dur, 0) || 1;
  const out = [];
  for (const [program, cs] of groups) {
    const durs = cs.map((c) => c.dur);
    const st = stats(durs);
    const run = durs.reduce((a, b) => a + b, 0);
    // improvement: Theil-Sen slope of cycle dur over time within the window
    const slope = cs.length >= 5 ? theilSen(cs.map((c) => ({ x: c.end, y: c.dur }))) : null;
    const perH = slope != null ? (slope * 3600000) / 1000 : null; // s/hour
    out.push({
      program, n: cs.length, median: st.median, mean: st.mean, p10: st.p10, p90: st.p90,
      sd: st.sd, cv: st.mean ? st.sd / st.mean : null, run, share: run / totalRun,
      machines: [...new Set(cs.map((c) => c.machine))], slopePerH: perH, cycles: cs,
    });
  }
  out.sort((a, b) => b.run - a.run);
  return out;
}

/* Same program, two halves of the window — how it reacted. Returns
 * { firstHalf, secondHalf, deltaPct } for each program with enough cycles. */
export function programPeriods(cycles, win) {
  const mid = win.from + (win.to - win.from) / 2;
  const groups = new Map();
  for (const c of cycles) {
    const key = c.program || "(unknown)";
    if (!groups.has(key)) groups.set(key, { a: [], b: [] });
    (c.end < mid ? groups.get(key).a : groups.get(key).b).push(c.dur);
  }
  const out = [];
  for (const [program, g] of groups) {
    if (g.a.length < 2 || g.b.length < 2) continue;
    const ma = stats(g.a).median, mb = stats(g.b).median;
    if (ma == null || mb == null) continue;
    out.push({ program, firstMed: ma, secondMed: mb, na: g.a.length, nb: g.b.length, deltaPct: ((mb - ma) / ma) * 100 });
  }
  out.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
  return out;
}

/* ---------- by DAY (local) ---------- best day = most parts / tightest cycle. */
export function byDay(cycles) {
  const days = new Map();
  for (const c of cycles) {
    const k = dayKey(c.end);
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(c.dur);
  }
  const out = [...days.entries()].map(([day, durs]) => {
    const st = stats(durs);
    return { day, parts: durs.length, median: st.median, run: durs.reduce((a, b) => a + b, 0) };
  });
  out.sort((a, b) => (a.day < b.day ? -1 : 1)); // chronological
  return out;
}

/* ---------- by HOUR-of-day (0..23) ---------- peak hour = most parts. */
export function byHour(cycles) {
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, parts: 0, durs: [] }));
  for (const c of cycles) {
    const h = new Date(c.end).getHours();
    hours[h].parts++; hours[h].durs.push(c.dur);
  }
  return hours.map((o) => ({ hour: o.hour, parts: o.parts, median: o.durs.length ? stats(o.durs).median : null }));
}

/* day × hour throughput matrix for a heatmap. Returns { days[], grid: {day -> [24]} }. */
export function dayHourMatrix(cycles) {
  const grid = new Map();
  for (const c of cycles) {
    const d = dayKey(c.end), h = new Date(c.end).getHours();
    if (!grid.has(d)) grid.set(d, new Array(24).fill(0));
    grid.get(d)[h]++;
  }
  const days = [...grid.keys()].sort();
  let max = 0;
  for (const row of grid.values()) for (const v of row) if (v > max) max = v;
  return { days, grid, max };
}

/* ---------- KPI trend over the window ----------
 * Slice the window into N equal bins, compute parts + median cycle per bin, and a
 * Theil-Sen slope so we can say "improving / degrading". */
export function kpiSeries(cycles, win, bins = 8) {
  const span = (win.to - win.from) || 1;
  const step = span / bins;
  const series = Array.from({ length: bins }, (_, i) => ({
    t: win.from + step * (i + 0.5), parts: 0, durs: [],
  }));
  for (const c of cycles) {
    let i = Math.floor((c.end - win.from) / step);
    if (i < 0) i = 0; if (i >= bins) i = bins - 1;
    series[i].parts++; series[i].durs.push(c.dur);
  }
  const pts = series.map((s) => ({ t: s.t, parts: s.parts, median: s.durs.length ? stats(s.durs).median : null }));
  const partsSlope = theilSen(pts.filter((p) => p.parts != null).map((p) => ({ x: p.t, y: p.parts })));
  const medPts = pts.filter((p) => p.median != null).map((p) => ({ x: p.t, y: p.median }));
  const medSlope = medPts.length >= 3 ? theilSen(medPts) : null;
  return { pts, partsSlopePerH: partsSlope != null ? partsSlope * 3600000 : null, medSlopePerH: medSlope != null ? (medSlope * 3600000) / 1000 : null };
}

/* ---------- helpers ---------- */
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function fmtSec(ms) { return ms == null ? "—" : ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`; }
export function dayLabel(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
export function weekdayName(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: "long" });
}
