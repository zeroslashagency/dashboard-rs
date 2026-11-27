/* VMC Fleet Intelligence — Pure Statistical & Domain Calculation Engine.
 *
 * Zero DOM dependencies — directly testable under `node --test` and shared
 * by the unified Fleet Intelligence UI. Reuses analyticsCore primitives so
 * cycle math, percentiles, and Theil-Sen drift agree everywhere.
 */

import { stats, theilSen } from "./analyticsCore.js";

export const DOWNTIME_REASONS = [
  "Setup",
  "Waiting for Material",
  "Operator Delay",
  "Inspection / Quality",
  "Tool Change",
  "Planned Maintenance",
  "Unplanned Breakdown",
  "Other",
];

export const SHIFT_DEFS = [
  { id: "shift1", label: "Shift 1 (06–14)", startH: 6, endH: 14 },
  { id: "shift2", label: "Shift 2 (14–22)", startH: 14, endH: 22 },
  { id: "shift3", label: "Shift 3 (22–06)", startH: 22, endH: 6 },
];

export function shiftOfTs(ts) {
  const h = new Date(ts).getHours();
  if (h >= 6 && h < 14) return SHIFT_DEFS[0];
  if (h >= 14 && h < 22) return SHIFT_DEFS[1];
  return SHIFT_DEFS[2];
}

export function normalizeProgramName(raw) {
  const s = String(raw || "").trim();
  if (!s || s.toUpperCase() === "UNAVAILABLE") return "UNSPECIFIED";
  return s;
}

/* Compute distribution + CV + Theil-Sen drift (s/hr) for an array of cycles. */
export function summarizeCycles(cycles) {
  const list = Array.isArray(cycles) ? cycles.filter((c) => Number.isFinite(c.dur) && c.dur > 0) : [];
  const durs = list.map((c) => c.dur);
  const st = stats(durs);
  const cv = st.mean && st.mean > 0 && st.sd != null ? (st.sd / st.mean) * 100 : null;
  let driftSecPerHr = null;
  if (list.length >= 3) {
    const slope = theilSen(list.map((c) => ({ x: c.end, y: c.dur })));
    if (slope != null) driftSecPerHr = (slope * 3600000) / 1000;
  }
  return {
    count: st.n,
    mean: st.mean,
    median: st.median,
    p10: st.p10,
    p90: st.p90,
    min: st.min,
    max: st.max,
    sd: st.sd,
    cv,
    driftSecPerHr,
    cycles: list,
  };
}

/* Split extracted M30 cycles by NC program name so heterogeneous parts are
 * never mixed into a single misleading median or drift slope. */
export function groupCyclesByProgram(cycles) {
  const map = new Map();
  for (const c of cycles || []) {
    if (!Number.isFinite(c.dur) || c.dur <= 0) continue;
    const prog = normalizeProgramName(c.program);
    if (!map.has(prog)) map.set(prog, []);
    map.get(prog).push(c);
  }
  const out = [];
  for (const [program, list] of map.entries()) {
    out.push({ program, ...summarizeCycles(list) });
  }
  out.sort((a, b) => b.count - a.count || a.program.localeCompare(b.program));
  return out;
}

/* Cross-machine NC program comparison matrix:
 * machineEntries = [{ id, cycles }]
 * Returns array of programs, each with combined stats and per-machine rows
 * ranked against the fastest median machine running that same program. */
export function buildProgramMatrix(machineEntries) {
  const byProg = new Map(); // prog -> { allCycles, byMachine: Map<id, cycles[]> }
  for (const entry of machineEntries || []) {
    const id = entry.id;
    for (const c of entry.cycles || []) {
      if (!Number.isFinite(c.dur) || c.dur <= 0) continue;
      const prog = normalizeProgramName(c.program);
      if (!byProg.has(prog)) byProg.set(prog, { allCycles: [], byMachine: new Map() });
      const rec = byProg.get(prog);
      rec.allCycles.push({ ...c, machineId: id });
      if (!rec.byMachine.has(id)) rec.byMachine.set(id, []);
      rec.byMachine.get(id).push({ ...c, machineId: id });
    }
  }

  const programs = [];
  for (const [program, rec] of byProg.entries()) {
    const overall = summarizeCycles(rec.allCycles);
    const machines = [];
    for (const [machineId, mCycles] of rec.byMachine.entries()) {
      machines.push({ machineId, ...summarizeCycles(mCycles) });
    }
    machines.sort((a, b) => (a.median ?? Infinity) - (b.median ?? Infinity));
    const fastestMed = machines.find((m) => Number.isFinite(m.median))?.median ?? null;
    for (const m of machines) {
      m.vsFastestPct =
        fastestMed && Number.isFinite(m.median) && fastestMed > 0
          ? ((m.median - fastestMed) / fastestMed) * 100
          : null;
    }
    programs.push({
      program,
      machineCount: machines.length,
      ...overall,
      machines,
    });
  }

  programs.sort((a, b) => b.count - a.count || a.program.localeCompare(b.program));
  return programs;
}

/* Group cycles by shift period (Shift 1 / Shift 2 / Shift 3). */
export function groupCyclesByShift(cycles) {
  const buckets = new Map(SHIFT_DEFS.map((s) => [s.id, []]));
  for (const c of cycles || []) {
    if (!Number.isFinite(c.end) || !Number.isFinite(c.dur) || c.dur <= 0) continue;
    const sh = shiftOfTs(c.end);
    buckets.get(sh.id).push(c);
  }
  return SHIFT_DEFS.map((sh) => ({
    ...sh,
    ...summarizeCycles(buckets.get(sh.id)),
  }));
}

/* Deterministic histogram binning for cycle durations. */
export function computeHistogramBins(durs, minVal = null, maxVal = null) {
  const xs = (durs || []).filter((d) => Number.isFinite(d) && d > 0);
  if (xs.length < 2) return { bins: [], min: xs[0] ?? null, max: xs[0] ?? null, peak: 0 };
  const min = minVal != null && Number.isFinite(minVal) ? minVal : Math.min(...xs);
  const max = maxVal != null && Number.isFinite(maxVal) ? maxVal : Math.max(...xs);
  const range = max - min || 1;
  const count = Math.min(20, Math.max(6, Math.round(Math.sqrt(xs.length) * 1.4)));
  const bins = Array.from({ length: count }, (_, i) => ({
    index: i,
    from: min + (i / count) * range,
    to: min + ((i + 1) / count) * range,
    count: 0,
    pct: 0,
  }));
  for (const d of xs) {
    const idx = Math.min(count - 1, Math.max(0, Math.floor(((d - min) / range) * count)));
    bins[idx].count += 1;
  }
  let peak = 0;
  for (const b of bins) {
    b.pct = (b.count / xs.length) * 100;
    if (b.count > peak) peak = b.count;
  }
  return { bins, min, max, peak, total: xs.length };
}

/* Reconcile controller-measured non-cutting time against operator-logged
 * downtime root causes in the active window. Never fabricates causes —
 * anything without a recorded log stays explicitly marked unattributed. */
export function summarizeDowntimeAccountability(machineId, rawDowntime, downtimeLogs, win) {
  const dt = rawDowntime || {};
  const controllerMs =
    (Number(dt.ALARM) || 0) +
    (Number(dt["E-STOP"]) || 0) +
    (Number(dt["FEED-HOLD"]) || 0) +
    (Number(dt.IDLE) || 0) +
    (Number(dt.OTHER) || 0);

  const matchingLogs = (downtimeLogs || []).filter((l) => {
    if (machineId && l.machineId !== machineId) return false;
    if (!win) return true;
    const t = Number(l.startTs || l.createdAt || 0);
    // Include logs whose start or end overlaps the selected time window
    const endT = t + (Number(l.durationMin) || 0) * 60000;
    return endT >= win.from && t <= win.to;
  });

  const byReason = new Map();
  let loggedMs = 0;
  for (const l of matchingLogs) {
    const ms = Math.max(0, (Number(l.durationMin) || 0) * 60000);
    loggedMs += ms;
    const prev = byReason.get(l.reason) || { reason: l.reason, ms: 0, count: 0 };
    prev.ms += ms;
    prev.count += 1;
    byReason.set(l.reason, prev);
  }

  // Controller alarms and E-Stops already carry explicit controller evidence
  const faultMs = (Number(dt.ALARM) || 0) + (Number(dt["E-STOP"]) || 0);
  const totalLossMs = Math.max(controllerMs, loggedMs);
  const accountedMs = Math.min(totalLossMs, loggedMs + faultMs);
  const unattributedMs = Math.max(0, totalLossMs - accountedMs);
  const accountedPct = totalLossMs > 0 ? Math.min(100, (accountedMs / totalLossMs) * 100) : 100;

  const breakdown = [...byReason.values()]
    .map((r) => ({ ...r, pct: totalLossMs > 0 ? (r.ms / totalLossMs) * 100 : 0 }))
    .sort((a, b) => b.ms - a.ms);

  // Build plain-English evidence chain:
  // e.g. "2h 25m lost → 1h waiting for material → 45m operator delay → 40m setup"
  const chainParts = [];
  for (const r of breakdown.slice(0, 3)) {
    chainParts.push(`${fmtDurShort(r.ms)} ${r.reason.toLowerCase()}`);
  }
  if (faultMs > 0 && chainParts.length < 3) {
    chainParts.push(`${fmtDurShort(faultMs)} controller alarm/e-stop`);
  }
  if (unattributedMs > 60000) {
    chainParts.push(`${fmtDurShort(unattributedMs)} unattributed`);
  }

  const narrative =
    totalLossMs <= 0
      ? "No non-cutting loss in this window"
      : chainParts.length
        ? `${fmtDurShort(totalLossMs)} lost → ${chainParts.join(" → ")}`
        : `${fmtDurShort(totalLossMs)} lost — no root causes logged yet`;

  return {
    totalLossMs,
    controllerMs,
    faultMs,
    loggedMs,
    accountedMs,
    unattributedMs,
    accountedPct,
    logCount: matchingLogs.length,
    breakdown,
    narrative,
  };
}

/* Honest separation of Reliability metrics:
 *   - Proxy MTBF / MTTR from controller alarm + E-STOP transitions
 *   - Verified MTBF / MTTR from logged maintenance breakdown/repair records */
export function computeReliabilityComparison(runMs, alarmEvents, estopEvents, rawDowntime, repairLogs, win) {
  const opMs = Math.max(0, Number(runMs) || 0);
  const alCount = Number(alarmEvents?.count) || 0;
  const esCount = Number(estopEvents?.count) || 0;
  const proxyFailures = alCount + esCount;
  const proxyDownMs = (Number(rawDowntime?.ALARM) || 0) + (Number(rawDowntime?.["E-STOP"]) || 0);

  const proxy = {
    label: "Alarm & E-Stop Proxy",
    failures: proxyFailures,
    alarms: alCount,
    estops: esCount,
    downMs: proxyDownMs,
    mtbfMs: proxyFailures > 0 ? opMs / proxyFailures : null,
    mttrMs: proxyFailures > 0 ? proxyDownMs / proxyFailures : null,
    noFailures: proxyFailures === 0 && opMs > 0,
  };

  const inWinRepairs = (repairLogs || []).filter((r) => {
    if (!win) return true;
    const t = Number(r.startedAt || r.createdAt || 0);
    return t >= win.from && t <= win.to;
  });

  const breakdowns = inWinRepairs.length;
  const resolved = inWinRepairs.filter((r) => r.status === "resolved");
  const openCount = breakdowns - resolved.length;
  const totalDowntimeMs = inWinRepairs.reduce((s, r) => s + Math.max(0, (Number(r.downtimeMin) || 0) * 60000), 0);
  const totalRepairMs = resolved.reduce((s, r) => s + Math.max(0, (Number(r.repairMin) || 0) * 60000), 0);

  const verified = {
    label: "Verified Maintenance Logs",
    breakdowns,
    resolvedCount: resolved.length,
    openCount,
    totalDowntimeMs,
    totalRepairMs,
    mtbfMs: breakdowns > 0 ? opMs / breakdowns : null,
    mttrMs: resolved.length > 0 ? totalRepairMs / resolved.length : null,
    noBreakdowns: breakdowns === 0,
  };

  return { proxy, verified };
}

/* Production monitoring: actual vs target parts, remaining qty, parts/hr, pace status. */
export function computeProductionProgress(metrics, target, win) {
  const parts = Number(metrics?.parts) || 0;
  const partRateRun = metrics?.partRateRun ?? null;
  const partRateWall = metrics?.partRateWall ?? null;
  const targetParts = Number(target?.shiftTargetParts) > 0 ? Number(target.shiftTargetParts) : null;
  const targetRate = Number(target?.targetPartsPerHour) > 0 ? Number(target.targetPartsPerHour) : null;

  const pctTarget = targetParts ? Math.min(100, (parts / targetParts) * 100) : null;
  const remainingParts = targetParts != null ? Math.max(0, targetParts - parts) : null;

  // Pace against elapsed fraction of an 8h shift (or active window)
  const spanMs = Math.max(1, (win?.to || 0) - (win?.from || 0));
  const expectedFraction = Math.min(1, spanMs / (8 * 3600000));
  let status = "no-target";
  if (targetParts != null) {
    if (parts >= targetParts) {
      status = "ahead";
    } else {
      const expectedByNow = targetParts * expectedFraction;
      if (parts >= expectedByNow * 0.95) status = "on-track";
      else status = "behind";
    }
  }

  let etaMs = null;
  if (remainingParts != null && remainingParts > 0 && partRateWall && partRateWall > 0) {
    etaMs = Date.now() + (remainingParts / partRateWall) * 3600000;
  }

  return {
    parts,
    targetParts,
    pctTarget,
    remainingParts,
    partRateRun,
    partRateWall,
    targetRate,
    etaMs,
    status,
    activeJob: target?.activeJob || "",
    operator: target?.operator || "",
    shiftLabel: target?.shiftLabel || "",
  };
}

export function fmtDurShort(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function fmtClockMMSS(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
