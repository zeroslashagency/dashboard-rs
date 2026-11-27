/* VMC Production Timeline — Pure Calculation & Gap Intelligence Engine.
 *
 * Zero DOM dependencies — directly unit-tested with `node --test` and shared
 * by the redesigned 8-machine Production Timeline view.
 */

export const IST_TZ = "Asia/Kolkata";
export const IST_OFFSET_MS = 330 * 60e3; // UTC+5:30

export const NORMAL_DEV = 0.15; // ±15% normal cycle spread
export const WIDE_DEV = 0.30;   // +15–30% mild slow; >+30% overrun

const pad2 = (n) => String(n).padStart(2, "0");

export function istDayStart(ms) {
  return Math.floor((ms + IST_OFFSET_MS) / 86400e3) * 86400e3 - IST_OFFSET_MS;
}

export function computeIstDayBoundaries(fromMs, toMs) {
  const out = [];
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return out;
  for (let d = istDayStart(fromMs); d <= toMs; d += 86400e3) {
    if (d >= fromMs && d <= toMs) out.push(d);
  }
  return out;
}

/**
 * Compute current IST 8-hour shift window (06–14, 14–22, 22–06).
 */
export function computeCurrentIstShift(nowMs = Date.now()) {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  const h = ist.getUTCHours();
  let shift = 1;
  let startHour = 6;
  let dayOffset = 0;
  if (h >= 6 && h < 14) {
    shift = 1;
    startHour = 6;
  } else if (h >= 14 && h < 22) {
    shift = 2;
    startHour = 14;
  } else {
    shift = 3;
    startHour = 22;
    if (h < 6) dayOffset = -1;
  }
  const startIst = Date.UTC(
    ist.getUTCFullYear(),
    ist.getUTCMonth(),
    ist.getUTCDate() + dayOffset,
    startHour,
    0,
    0,
    0,
  );
  const from = startIst - IST_OFFSET_MS;
  const to = from + 8 * 3600e3;
  return {
    shift,
    label: `Shift ${shift} (${pad2(startHour)}–${pad2((startHour + 8) % 24)})`,
    from,
    to,
  };
}

/**
 * Return IST shift handover markers (06:00 S1, 14:00 S2, 22:00 S3) inside [fromMs, toMs].
 */
export function computeShiftBoundaries(fromMs, toMs) {
  const out = [];
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return out;
  const startDay = istDayStart(fromMs) - 86400e3;
  const shifts = [
    { h: 6, code: "S1", label: "S1 06:00" },
    { h: 14, code: "S2", label: "S2 14:00" },
    { h: 22, code: "S3", label: "S3 22:00" },
  ];
  for (let d = startDay; d <= toMs + 86400e3; d += 86400e3) {
    for (const s of shifts) {
      const ts = d + s.h * 3600e3;
      if (ts >= fromMs && ts <= toMs) {
        out.push({ ts, code: s.code, label: s.label });
      }
    }
  }
  return out;
}

export function shiftLabelForTs(ts) {
  const ist = new Date(ts + IST_OFFSET_MS);
  const h = ist.getUTCHours();
  if (h >= 6 && h < 14) return "Shift 1 (06–14)";
  if (h >= 14 && h < 22) return "Shift 2 (14–22)";
  return "Shift 3 (22–06)";
}

export function partDeviationKind(p) {
  if (!p) return "neutral";
  if (p.partial) return "partial";
  const dev = p.dev;
  if (dev == null || !Number.isFinite(dev)) return "neutral";
  if (dev > 1 + WIDE_DEV) return "over";
  if (dev > 1 + NORMAL_DEV) return "high";
  if (dev < 1 - NORMAL_DEV) return "low";
  return "normal";
}

/**
 * Find a saved Fleet Intelligence downtime log overlapping a timeline gap.
 */
export function findLoggedDowntimeForGap(machineId, t0, t1, downtimeLogs) {
  if (!Array.isArray(downtimeLogs) || !downtimeLogs.length) return null;
  const mid = String(machineId || "").toUpperCase();
  const gapDur = Math.max(1, t1 - t0);
  const minOverlap = Math.min(30_000, gapDur * 0.25);
  for (const log of downtimeLogs) {
    if (!log || String(log.machineId || "").toUpperCase() !== mid) continue;
    const ls = Number(log.startTs);
    const durMin = Number(log.durationMin);
    if (!Number.isFinite(ls)) continue;
    const le = ls + Math.max(1, Number.isFinite(durMin) ? durMin : 1) * 60e3;
    const overlap = Math.min(le, t1) - Math.max(ls, t0);
    if (overlap >= minOverlap || Math.abs(ls - t0) <= 20_000) return log;
  }
  return null;
}

/**
 * Extract contiguous inspectable non-cutting gaps (`idle`, `paused`, `alarm`, `offline`)
 * from status bands + inter-part voids, attaching overlapping events and logged causes.
 */
export function extractLaneGaps(machineId, bands, parts, fromMs, toMs, downtimeLogs = [], events = []) {
  const nonCut = new Set(["idle", "paused", "alarm", "offline", "unknown"]);
  const rawGaps = [];

  for (const b of Array.isArray(bands) ? bands : []) {
    if (!b || !Number.isFinite(b.t0) || !Number.isFinite(b.t1)) continue;
    const st = String(b.status || "unknown").toLowerCase();
    if (!nonCut.has(st)) continue;
    const c0 = Math.max(fromMs, b.t0);
    const c1 = Math.min(toMs, b.t1);
    if (c1 - c0 < 5_000) continue;
    rawGaps.push({ t0: c0, t1: c1, status: st });
  }

  // Fallback: if bands are absent, derive idle gaps between completed parts
  if (!rawGaps.length && (!bands || !bands.length) && Array.isArray(parts) && parts.length >= 2) {
    const sorted = [...parts].sort((a, b) => a.t0 - b.t0);
    for (let i = 1; i < sorted.length; i++) {
      const g0 = Math.max(fromMs, sorted[i - 1].t1);
      const g1 = Math.min(toMs, sorted[i].t0);
      if (g1 - g0 >= 15_000) rawGaps.push({ t0: g0, t1: g1, status: "idle" });
    }
  }

  rawGaps.sort((a, b) => a.t0 - b.t0);

  // Merge adjacent gaps of the same status separated by < 10s
  const merged = [];
  for (const g of rawGaps) {
    const prev = merged[merged.length - 1];
    if (prev && prev.status === g.status && g.t0 - prev.t1 <= 10_000) {
      prev.t1 = Math.max(prev.t1, g.t1);
    } else {
      merged.push({ ...g });
    }
  }

  const mEvents = Array.isArray(events) ? events : [];
  return merged.map((g, idx) => {
    const durMs = Math.max(0, g.t1 - g.t0);
    const overlapEvents = mEvents.filter((e) => e && e.ts >= g.t0 - 15_000 && e.ts <= g.t1 + 15_000);
    const logged = findLoggedDowntimeForGap(machineId, g.t0, g.t1, downtimeLogs);
    return {
      id: `${machineId}_${Math.round(g.t0)}_${idx}`,
      machineId,
      t0: g.t0,
      t1: g.t1,
      durMs,
      status: g.status,
      events: overlapEvents,
      logged,
    };
  });
}

/**
 * Roll up one machine's visible window metrics (cutting %, parts, loss breakdown).
 */
export function summarizeLaneWindow(parts, bands, fromMs, toMs) {
  let cutMs = 0;
  let idleMs = 0;
  let holdMs = 0;
  let alarmMs = 0;
  let offlineMs = 0;

  const validBands = (Array.isArray(bands) ? bands : []).filter(
    (b) => b && Number.isFinite(b.t0) && Number.isFinite(b.t1) && b.t1 > fromMs && b.t0 < toMs,
  );

  if (validBands.length) {
    for (const b of validBands) {
      const c0 = Math.max(fromMs, b.t0);
      const c1 = Math.min(toMs, b.t1);
      const d = Math.max(0, c1 - c0);
      const st = String(b.status || "").toLowerCase();
      if (st === "running") cutMs += d;
      else if (st === "paused") holdMs += d;
      else if (st === "alarm") alarmMs += d;
      else if (st === "offline") offlineMs += d;
      else idleMs += d;
    }
  } else {
    for (const p of Array.isArray(parts) ? parts : []) {
      if (!p || p.t1 <= fromMs || p.t0 >= toMs) continue;
      cutMs += Math.max(0, Math.min(toMs, p.t1) - Math.max(fromMs, p.t0));
    }
    const span = Math.max(0, toMs - fromMs);
    idleMs = Math.max(0, span - cutMs);
  }

  const visParts = (Array.isArray(parts) ? parts : []).filter(
    (p) => p && !p.partial && p.t1 >= fromMs && p.t0 <= toMs,
  );
  let slowCount = 0;
  let shortCount = 0;
  for (const p of visParts) {
    const k = partDeviationKind(p);
    if (k === "high" || k === "over") slowCount += 1;
    else if (k === "low") shortCount += 1;
  }

  const totalMs = cutMs + idleMs + holdMs + alarmMs + offlineMs;
  const activeDenom = cutMs + idleMs + holdMs + alarmMs;
  const utilPct = activeDenom > 0 ? Math.round((cutMs / activeDenom) * 100) : (offlineMs > 0 ? 0 : null);

  return {
    cutMs,
    idleMs,
    holdMs,
    alarmMs,
    offlineMs,
    lossMs: idleMs + holdMs + alarmMs,
    totalMs,
    utilPct,
    partCount: visParts.length,
    slowCount,
    shortCount,
  };
}

/**
 * Aggregate fleet-wide KPI strip metrics across all visible lanes.
 */
export function summarizeFleetWindow(laneSummaries, overviewMap, eventsMap, downtimeLogs, fromMs, toMs) {
  let totalCutMs = 0;
  let totalIdleMs = 0;
  let totalHoldMs = 0;
  let totalAlarmMs = 0;
  let totalOfflineMs = 0;
  let totalParts = 0;
  let runningNow = 0;
  let onlineNow = 0;
  const totalMachines = laneSummaries.size;

  for (const [id, s] of laneSummaries) {
    totalCutMs += s.cutMs;
    totalIdleMs += s.idleMs;
    totalHoldMs += s.holdMs;
    totalAlarmMs += s.alarmMs;
    totalOfflineMs += s.offlineMs;
    totalParts += s.partCount;
    const ov = overviewMap && overviewMap.get ? overviewMap.get(id) : null;
    if (ov && ov.online !== false && String(ov.status || "").toLowerCase() !== "offline") {
      onlineNow += 1;
      if (String(ov.status || "").toLowerCase() === "running" || String(ov.execution || "").toUpperCase() === "ACTIVE") {
        runningNow += 1;
      }
    }
  }

  const denom = totalCutMs + totalIdleMs + totalHoldMs + totalAlarmMs;
  const fleetUtilPct = denom > 0 ? Math.round((totalCutMs / denom) * 100) : 0;

  let incidentCount = 0;
  if (eventsMap && eventsMap.values) {
    for (const arr of eventsMap.values()) {
      for (const e of arr) {
        if (e && e.ts >= fromMs && e.ts <= toMs && e.rule !== "program") {
          incidentCount += 1;
        }
      }
    }
  }

  let loggedInWindow = 0;
  for (const log of Array.isArray(downtimeLogs) ? downtimeLogs : []) {
    if (!log) continue;
    const ls = Number(log.startTs);
    const le = ls + Math.max(1, Number(log.durationMin) || 1) * 60e3;
    if (Number.isFinite(ls) && le >= fromMs && ls <= toMs) loggedInWindow += 1;
  }

  return {
    fleetUtilPct,
    totalParts,
    totalCutMs,
    totalLossMs: totalIdleMs + totalHoldMs + totalAlarmMs,
    totalIdleMs,
    totalHoldMs,
    totalAlarmMs,
    totalOfflineMs,
    runningNow,
    onlineNow,
    totalMachines,
    incidentCount,
    loggedInWindow,
  };
}

/**
 * Bin aggregate fleet running / loss / alarm density across [bufFrom, bufTo] for the minimap.
 */
export function computeMinimapBins(lanesData, bufFrom, bufTo, binCount = 96) {
  const n = Math.max(12, Math.min(240, Math.round(binCount)));
  const span = bufTo - bufFrom;
  if (!Number.isFinite(span) || span <= 0) return [];
  const step = span / n;
  const runAcc = new Float64Array(n);
  const lossAcc = new Float64Array(n);
  const alarmAcc = new Float64Array(n);
  const laneList = Array.isArray(lanesData) ? lanesData : [...lanesData.values()];
  const laneCount = Math.max(1, laneList.length);

  for (const lane of laneList) {
    const bands = lane && Array.isArray(lane.bands) ? lane.bands : [];
    for (const b of bands) {
      if (!b || !Number.isFinite(b.t0) || !Number.isFinite(b.t1)) continue;
      if (b.t1 <= bufFrom || b.t0 >= bufTo) continue;
      const i0 = Math.max(0, Math.floor((b.t0 - bufFrom) / step));
      const i1 = Math.min(n - 1, Math.floor((b.t1 - bufFrom) / step));
      const st = String(b.status || "").toLowerCase();
      for (let i = i0; i <= i1; i++) {
        const bt0 = bufFrom + i * step;
        const bt1 = bt0 + step;
        const ov = Math.max(0, Math.min(bt1, b.t1) - Math.max(bt0, b.t0));
        const frac = ov / step;
        if (st === "running") runAcc[i] += frac;
        else if (st === "alarm") alarmAcc[i] += frac;
        else if (st === "idle" || st === "paused") lossAcc[i] += frac;
      }
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      t0: bufFrom + i * step,
      t1: bufFrom + (i + 1) * step,
      runFrac: Math.min(1, runAcc[i] / laneCount),
      lossFrac: Math.min(1, lossAcc[i] / laneCount),
      alarmFrac: Math.min(1, alarmAcc[i] / laneCount),
    });
  }
  return out;
}

export function fmtClockIST(ms) {
  return new Date(ms).toLocaleTimeString("en-GB", {
    timeZone: IST_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function fmtClockSecIST(ms) {
  return new Date(ms).toLocaleTimeString("en-GB", {
    timeZone: IST_TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function fmtDayIST(ms) {
  return new Date(ms).toLocaleDateString("en-US", {
    timeZone: IST_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function fmtIsoDateIST(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function fmtDurCompact(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
  }
  if (m > 0) return `${m}m ${pad2(s % 60)}s`;
  return `${s}s`;
}
