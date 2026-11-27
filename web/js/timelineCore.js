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

export function fmtClockHero(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return { main: `${h}:${pad2(m)}`, sub: pad2(s), unit: "h:m" };
  return { main: `${m}:${pad2(s)}`, sub: "", unit: "m:s" };
}

export function partKeyOf(p) {
  if (!p) return "";
  return `${Math.round((p.t0 || 0) / 1000)}|${p.job ?? ""}`;
}

export function cleanProgName(raw) {
  const s = String(raw || "").trim();
  if (!s) return "Unknown NC";
  return s.replace(/\.nc$/i, "");
}

function quantileSorted(sorted, q) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Tactile badge metadata (tone, label, icon) for cycle, run, or gap status.
 */
export function healthBadgeForKind(kind) {
  switch (kind) {
    case "normal":
    case "success":
    case "logged":
      return {
        tone: "success",
        label: kind === "logged" ? "Logged" : "Nominal",
        icon: "check",
      };
    case "high":
    case "paused":
    case "pending":
      return {
        tone: "warning",
        label: kind === "paused" ? "Feed-Hold" : kind === "pending" ? "Unclassified" : "Slow +15%",
        icon: "alert",
      };
    case "over":
    case "alarm":
    case "failed":
      return {
        tone: "danger",
        label: kind === "alarm" ? "Alarm" : "Overrun",
        icon: "x",
      };
    case "live":
    case "active":
      return {
        tone: "info",
        label: "Live Cutting",
        icon: "arrow",
      };
    case "low":
      return {
        tone: "info",
        label: "Short Cycle",
        icon: "arrow",
      };
    case "partial":
      return {
        tone: "neutral",
        label: "Partial",
        icon: "clock",
      };
    case "offline":
      return {
        tone: "neutral",
        label: "Offline",
        icon: "clock",
      };
    case "idle":
    default:
      return {
        tone: "neutral",
        label: kind === "idle" ? "Idle Gap" : "Baseline",
        icon: "clock",
      };
  }
}

/**
 * Build a 24-tick LED-style segmented efficiency/utilization gauge model.
 */
export function computeSegmentedMeter(pct, tone = "success", count = 24) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const filled = Math.round((clamped / 100) * count);
  const segs = [];
  for (let i = 0; i < count; i++) {
    const active = i < filled;
    let segTone = "empty";
    if (active) {
      if (tone === "danger") segTone = i < Math.floor(count * 0.65) ? "amber" : "crimson";
      else if (tone === "warning") segTone = i < Math.floor(count * 0.72) ? "emerald" : "amber";
      else if (tone === "info") segTone = "cobalt";
      else segTone = "emerald";
    }
    segs.push({ active, tone: segTone });
  }
  return { pct: Math.round(clamped), filled, count, segs };
}

/**
 * Link any timeline click target (part, live, group, gap, pin) to its parent NC run
 * and default Single Job selection so operators can switch seamlessly between tabs.
 */
export function resolveNcContext(lane, hit, overview = null) {
  const parts = Array.isArray(lane?.parts) ? lane.parts : [];
  const groups = Array.isArray(lane?.groups) ? lane.groups : [];
  const bands = Array.isArray(lane?.bands) ? lane.bands : [];

  const findGroupForPart = (p) => {
    if (!p) return null;
    if (p.groupId != null) {
      const byId = groups.find((g) => g.groupId === p.groupId);
      if (byId) return byId;
    }
    const bySpan = groups.find((g) => p.t0 >= g.t0 - 5000 && p.t1 <= g.t1 + 5000 && g.program === p.program);
    if (bySpan) return bySpan;
    const sameProg = parts.filter((x) => x.program && x.program === p.program);
    if (sameProg.length) {
      return {
        groupId: p.groupId ?? `virt_${p.program}`,
        program: p.program,
        t0: Math.min(...sameProg.map((x) => x.t0)),
        t1: Math.max(...sameProg.map((x) => x.t1)),
        count: sameProg.length,
        baseline: p.baseline ?? null,
      };
    }
    return {
      groupId: p.groupId ?? `virt_single_${Math.round(p.t0 / 1000)}`,
      program: p.program || "Program",
      t0: p.t0,
      t1: p.t1,
      count: 1,
      baseline: p.baseline ?? null,
    };
  };

  const partsForGroup = (grp) => {
    if (!grp) return [];
    let matched = parts.filter((p) => p.groupId != null && p.groupId === grp.groupId);
    if (!matched.length) {
      matched = parts.filter(
        (p) =>
          p.t0 >= grp.t0 - 5000 &&
          p.t1 <= grp.t1 + 5000 &&
          (!grp.program || !p.program || p.program === grp.program),
      );
    }
    return matched.slice().sort((a, b) => a.t0 - b.t0);
  };

  const buildLiveMeta = (ov) => {
    if (!ov) return null;
    const c = ov.cycle || {};
    const elapsedSec = Number(c.this_cycle);
    const remSec = Number(c.remaining_cycle_time);
    const nowMs = Date.now();
    const durMs = Number.isFinite(elapsedSec) && elapsedSec > 0 ? elapsedSec * 1000 : 0;
    const remainingMs = Number.isFinite(remSec) && remSec >= 0 ? remSec * 1000 : null;
    const totalEstMs = remainingMs != null ? durMs + remainingMs : null;
    return {
      isLive: true,
      program: ov.active_program || "Active Program",
      t0: nowMs - durMs,
      t1: nowMs,
      durMs,
      remainingMs,
      totalEstMs,
      status: ov.status || "running",
      spindleRpm: Number.isFinite(ov.spindle_speed) ? Math.round(ov.spindle_speed) : null,
      feedOvrd: Number.isFinite(ov.overrides?.feed) ? Math.round(ov.overrides.feed) : null,
      spindleOvrd: Number.isFinite(ov.overrides?.spindle) ? Math.round(ov.overrides.spindle) : null,
      rapidOvrd: Number.isFinite(ov.overrides?.rapid) ? Math.round(ov.overrides.rapid) : null,
      partCount: ov.part_count ?? null,
      targetQty: ov.target_part_qty ?? null,
      toolId: ov.tool_id || null,
    };
  };

  if (hit.type === "part") {
    const selectedPart = hit.data;
    const group = findGroupForPart(selectedPart);
    const groupParts = partsForGroup(group);
    return {
      defaultTab: "job",
      group,
      groupParts: groupParts.length ? groupParts : [selectedPart],
      selectedPart,
      liveMeta: null,
      bands,
    };
  }

  if (hit.type === "live") {
    const ov = hit.data || overview;
    const liveMeta = buildLiveMeta(ov);
    const activeProg = liveMeta?.program;
    let group = null;
    for (let i = groups.length - 1; i >= 0; i--) {
      if (!activeProg || groups[i].program === activeProg) {
        group = groups[i];
        break;
      }
    }
    if (!group && liveMeta) {
      group = {
        groupId: `live_${activeProg || "run"}`,
        program: activeProg || "Active Program",
        t0: liveMeta.t0,
        t1: liveMeta.t1,
        count: 1,
        baseline: liveMeta.totalEstMs ? liveMeta.totalEstMs / 1000 : null,
      };
    }
    const groupParts = partsForGroup(group);
    return {
      defaultTab: "job",
      group,
      groupParts,
      selectedPart: null,
      liveMeta,
      bands,
    };
  }

  if (hit.type === "group") {
    const group = hit.data;
    const groupParts = partsForGroup(group);
    // Default Single Job selection when user clicks the Single Job tab: newest completed job (or last part)
    const completed = groupParts.filter((p) => !p.partial && p.dur > 0);
    const selectedPart = completed.length
      ? completed[completed.length - 1]
      : (groupParts[groupParts.length - 1] || null);
    return {
      defaultTab: "nc",
      group,
      groupParts,
      selectedPart,
      liveMeta: null,
      bands,
    };
  }

  if (hit.type === "gap") {
    const gap = hit.data;
    // Find overlapping or closest preceding NC group within 2 hours for optional Full NC context tab
    let group = groups.find((g) => g.t0 <= gap.t1 && g.t1 >= gap.t0) || null;
    if (!group) {
      let bestDist = 2 * 3600e3;
      for (const g of groups) {
        const dist = gap.t0 >= g.t1 ? gap.t0 - g.t1 : (g.t0 >= gap.t1 ? g.t0 - gap.t1 : 0);
        if (dist < bestDist) {
          bestDist = dist;
          group = g;
        }
      }
    }
    const groupParts = partsForGroup(group);
    const selectedPart = groupParts.length ? groupParts[groupParts.length - 1] : null;
    return {
      defaultTab: "gap",
      group,
      groupParts,
      selectedPart,
      liveMeta: null,
      bands,
    };
  }

  // Event pin
  const ev = hit.data;
  const group = ev ? (groups.find((g) => ev.ts >= g.t0 - 15e3 && ev.ts <= g.t1 + 15e3) || null) : null;
  const groupParts = partsForGroup(group);
  const selectedPart = ev ? (groupParts.find((p) => ev.ts >= p.t0 && ev.ts <= p.t1) || groupParts[groupParts.length - 1] || null) : null;
  return {
    defaultTab: "pin",
    group,
    groupParts,
    selectedPart,
    liveMeta: null,
    bands,
  };
}

/**
 * Compute Full NC program run analytics, mini-timeline strip geometry, quality split,
 * 24-segment cutting utilization meter, and clickable job list.
 */
export function buildFullNcReport({ group, groupParts = [], bands = [], events = [], liveMeta = null }) {
  if (!group && !groupParts.length && !liveMeta) return null;

  const sortedParts = groupParts.slice().sort((a, b) => a.t0 - b.t0);
  const t0Candidates = [];
  const t1Candidates = [];
  if (group && Number.isFinite(group.t0)) t0Candidates.push(group.t0);
  if (group && Number.isFinite(group.t1)) t1Candidates.push(group.t1);
  if (sortedParts.length) {
    t0Candidates.push(sortedParts[0].t0);
    t1Candidates.push(sortedParts[sortedParts.length - 1].t1);
  }
  if (liveMeta) {
    t0Candidates.push(liveMeta.t0);
    t1Candidates.push(liveMeta.t1);
  }
  const t0 = t0Candidates.length ? Math.min(...t0Candidates) : Date.now() - 60e3;
  const t1 = Math.max(t0 + 1000, t1Candidates.length ? Math.max(...t1Candidates) : Date.now());
  const wallMs = Math.max(1000, t1 - t0);

  const completed = sortedParts.filter((p) => !p.partial && Number.isFinite(p.dur) && p.dur > 0);
  const dursSorted = completed.map((p) => p.dur).sort((a, b) => a - b);
  const medianMs = quantileSorted(dursSorted, 0.5);
  const p10Ms = quantileSorted(dursSorted, 0.1);
  const p90Ms = quantileSorted(dursSorted, 0.9);
  const minMs = dursSorted.length ? dursSorted[0] : null;
  const maxMs = dursSorted.length ? dursSorted[dursSorted.length - 1] : null;
  const avgMs = dursSorted.length ? dursSorted.reduce((a, b) => a + b, 0) / dursSorted.length : null;
  const baselineMs = group?.baseline
    ? group.baseline * 1000
    : (completed.find((p) => p.baseline)?.baseline
      ? completed.find((p) => p.baseline).baseline * 1000
      : medianMs);

  let cutMs = sortedParts.reduce((a, p) => a + Math.max(0, p.dur || (p.t1 - p.t0) || 0), 0);
  if (liveMeta && liveMeta.durMs > 0) cutMs += liveMeta.durMs;
  cutMs = Math.min(wallMs, cutMs);
  const gapMs = Math.max(0, wallMs - cutMs);
  const utilPct = Math.max(0, Math.min(100, Math.round((cutMs / wallMs) * 100)));

  const qualityCounts = { normal: 0, high: 0, over: 0, low: 0, partial: 0, neutral: 0, live: liveMeta ? 1 : 0 };
  for (const p of sortedParts) {
    const k = partDeviationKind(p);
    qualityCounts[k] = (qualityCounts[k] || 0) + 1;
  }

  const incidents = (Array.isArray(events) ? events : [])
    .filter((e) => e && e.ts >= t0 - 10e3 && e.ts <= t1 + 10e3 && e.rule !== "program")
    .sort((a, b) => b.ts - a.ts);

  // Build proportional mini-strip blocks across [t0, t1]
  const miniStrip = [];
  let cursor = t0;
  for (let i = 0; i < sortedParts.length; i++) {
    const p = sortedParts[i];
    if (p.t0 > cursor + 15_000) {
      const gapBand = bands.find((b) => b && b.status !== "running" && b.t1 > cursor && b.t0 < p.t0);
      miniStrip.push({
        kind: "gap",
        id: `gap_${i}`,
        t0: cursor,
        t1: p.t0,
        durMs: p.t0 - cursor,
        leftPct: ((cursor - t0) / wallMs) * 100,
        widthPct: ((p.t0 - cursor) / wallMs) * 100,
        statusKind: gapBand ? String(gapBand.status || "idle").toLowerCase() : "idle",
      });
    }
    const stKind = partDeviationKind(p);
    miniStrip.push({
      kind: "part",
      id: partKeyOf(p),
      job: p.job,
      index: i + 1,
      t0: p.t0,
      t1: p.t1,
      durMs: p.dur || Math.max(0, p.t1 - p.t0),
      leftPct: Math.max(0, ((p.t0 - t0) / wallMs) * 100),
      widthPct: Math.max(0.8, ((Math.max(1000, p.t1 - p.t0)) / wallMs) * 100),
      statusKind: stKind,
      partRef: p,
    });
    cursor = Math.max(cursor, p.t1);
  }
  if (liveMeta) {
    if (liveMeta.t0 > cursor + 15_000) {
      miniStrip.push({
        kind: "gap",
        id: "gap_live",
        t0: cursor,
        t1: liveMeta.t0,
        durMs: liveMeta.t0 - cursor,
        leftPct: ((cursor - t0) / wallMs) * 100,
        widthPct: ((liveMeta.t0 - cursor) / wallMs) * 100,
        statusKind: "idle",
      });
    }
    miniStrip.push({
      kind: "live",
      id: "__LIVE__",
      job: "LIVE",
      index: sortedParts.length + 1,
      t0: liveMeta.t0,
      t1: liveMeta.t1,
      durMs: liveMeta.durMs,
      leftPct: Math.max(0, ((liveMeta.t0 - t0) / wallMs) * 100),
      widthPct: Math.max(2, ((Math.max(1000, liveMeta.t1 - liveMeta.t0)) / wallMs) * 100),
      statusKind: "live",
    });
  }

  // Clickable chronological job rows (newest first, matching precision tracker list)
  const jobRows = [];
  if (liveMeta) {
    jobRows.push({
      id: "__LIVE__",
      isLive: true,
      jobLabel: "Live Cycle",
      t0: liveMeta.t0,
      t1: liveMeta.t1,
      durMs: liveMeta.durMs,
      devPct: null,
      statusKind: "live",
      badge: healthBadgeForKind("live"),
    });
  }
  for (let i = sortedParts.length - 1; i >= 0; i--) {
    const p = sortedParts[i];
    const stKind = partDeviationKind(p);
    const devPct = p.dev != null && Number.isFinite(p.dev)
      ? Math.round((p.dev - 1) * 100)
      : (baselineMs && p.dur ? Math.round(((p.dur / baselineMs) - 1) * 100) : null);
    jobRows.push({
      id: partKeyOf(p),
      isLive: false,
      job: p.job,
      orderIndex: i + 1,
      jobLabel: p.job != null ? `Job #${p.job}` : `Cycle #${i + 1}`,
      t0: p.t0,
      t1: p.t1,
      durMs: p.dur || Math.max(0, p.t1 - p.t0),
      devPct,
      statusKind: stKind,
      badge: healthBadgeForKind(stKind),
      partRef: p,
    });
  }

  const badCount = qualityCounts.over + qualityCounts.high;
  const runTone = qualityCounts.over > 0 || incidents.some((e) => e.sev === "CRITICAL")
    ? "danger"
    : (badCount > 0 || utilPct < 65 ? "warning" : "success");
  const healthBadge = liveMeta && !sortedParts.length
    ? healthBadgeForKind("live")
    : (runTone === "danger"
      ? { tone: "danger", label: `${qualityCounts.over} Overrun${qualityCounts.over === 1 ? "" : "s"}`, icon: "x" }
      : runTone === "warning"
        ? { tone: "warning", label: `${utilPct}% Cutting`, icon: "alert" }
        : { tone: "success", label: `${utilPct}% Nominal`, icon: "check" });

  const meter = computeSegmentedMeter(utilPct, runTone, 24);

  let insight = "";
  if (!completed.length && liveMeta) {
    insight = `First cycle of ${cleanProgName(group?.program || liveMeta.program)} is currently cutting in progress.`;
  } else if (qualityCounts.over > 0) {
    insight = `${qualityCounts.over} overrun cycle${qualityCounts.over === 1 ? "" : "s"} (>+30%) and ${fmtDurCompact(gapMs)} of inter-cycle gaps detected in this NC run.`;
  } else if (qualityCounts.high > 0) {
    insight = `${qualityCounts.normal} of ${completed.length} completed cycles ran nominal; ${qualityCounts.high} cycle${qualityCounts.high === 1 ? "" : "s"} drifted +15% slower.`;
  } else if (incidents.length > 0) {
    insight = `Cycle times stayed nominal across ${completed.length} jobs, with ${incidents.length} controller event${incidents.length === 1 ? "" : "s"} recorded.`;
  } else {
    insight = `Clean NC batch — ${completed.length} completed cycle${completed.length === 1 ? "" : "s"} at ${utilPct}% cutting utilization.`;
  }

  return {
    programRaw: group?.program || liveMeta?.program || "Program",
    programName: cleanProgName(group?.program || liveMeta?.program),
    t0,
    t1,
    wallMs,
    cutMs,
    gapMs,
    utilPct,
    totalJobs: sortedParts.length + (liveMeta ? 1 : 0),
    completedCount: completed.length,
    partialCount: qualityCounts.partial,
    baselineMs,
    medianMs,
    p10Ms,
    p90Ms,
    minMs,
    maxMs,
    avgMs,
    qualityCounts,
    healthBadge,
    meter,
    miniStrip,
    jobRows,
    sortedParts,
    incidents,
    insight,
  };
}

/**
 * Compute Single Job diagnostic report: 24-segment pace meter, range bar needle,
 * 5-axis grounded radar vs NC baseline, pre-cycle gap, batch rank, and insight.
 */
export function buildSingleJobReport({ part = null, liveMeta = null, fullNc = null, events = [], overview = null }) {
  const isLive = !part && !!liveMeta;
  if (!part && !liveMeta) return null;

  const t0 = isLive ? liveMeta.t0 : part.t0;
  const t1 = isLive ? liveMeta.t1 : part.t1;
  const durMs = isLive ? liveMeta.durMs : (part.dur || Math.max(0, t1 - t0));
  const baselineMs = (part?.baseline ? part.baseline * 1000 : null)
    || fullNc?.baselineMs
    || (isLive ? liveMeta.totalEstMs : null);

  const statusKind = isLive ? "live" : partDeviationKind(part);
  const badge = healthBadgeForKind(statusKind);

  const devRatio = (!isLive && part.dev != null && Number.isFinite(part.dev))
    ? part.dev
    : (baselineMs && durMs > 0 && !isLive ? durMs / baselineMs : null);
  const devPct = devRatio != null ? Math.round((devRatio - 1) * 100) : null;

  // Efficiency % for 24-segment meter
  let efficiencyPct = 100;
  if (isLive) {
    efficiencyPct = liveMeta.totalEstMs && liveMeta.totalEstMs > 0
      ? Math.max(2, Math.min(100, Math.round((durMs / liveMeta.totalEstMs) * 100)))
      : 50;
  } else if (baselineMs && durMs > 0) {
    efficiencyPct = Math.max(15, Math.min(100, Math.round((baselineMs / durMs) * 100)));
  } else {
    efficiencyPct = 85;
  }

  const meterTone = isLive
    ? "info"
    : (statusKind === "over" ? "danger" : statusKind === "high" ? "warning" : statusKind === "low" ? "info" : "success");
  const meter = computeSegmentedMeter(efficiencyPct, meterTone, 24);

  // Duration Range Needle relative to NC batch min..max (or baseline band)
  const refBase = baselineMs || durMs || 60e3;
  const scaleMin = Math.min(fullNc?.minMs ?? refBase * 0.72, refBase * 0.72, durMs * 0.92);
  const scaleMax = Math.max(fullNc?.maxMs ?? refBase * 1.4, refBase * 1.4, durMs * 1.05);
  const scaleSpan = Math.max(1000, scaleMax - scaleMin);
  const rangeNeedle = {
    minMs: scaleMin,
    maxMs: scaleMax,
    baseMs: refBase,
    valMs: durMs,
    basePct: Math.max(4, Math.min(96, ((refBase - scaleMin) / scaleSpan) * 100)),
    needlePct: Math.max(2, Math.min(98, ((durMs - scaleMin) / scaleSpan) * 100)),
  };

  // Position & rank inside NC run
  const sortedParts = fullNc?.sortedParts || [];
  const key = isLive ? "__LIVE__" : partKeyOf(part);
  const chronoIdx = isLive
    ? sortedParts.length + 1
    : Math.max(1, sortedParts.findIndex((p) => partKeyOf(p) === key) + 1);
  const totalInRun = Math.max(chronoIdx, fullNc?.totalJobs || sortedParts.length || 1);

  const prevPart = !isLive && chronoIdx > 1
    ? sortedParts[chronoIdx - 2]
    : (isLive && sortedParts.length ? sortedParts[sortedParts.length - 1] : null);
  const preGapMs = prevPart ? Math.max(0, t0 - prevPart.t1) : null;

  const completed = sortedParts.filter((p) => !p.partial && p.dur > 0);
  const byFastest = completed.slice().sort((a, b) => a.dur - b.dur);
  const speedRank = !isLive ? (byFastest.findIndex((p) => partKeyOf(p) === key) + 1) : null;

  const incidents = (Array.isArray(events) ? events : [])
    .filter((e) => e && e.ts >= t0 - 5e3 && e.ts <= t1 + 5e3 && e.rule !== "program")
    .sort((a, b) => a.ts - b.ts);

  // 5-Axis Grounded Telemetry Radar (Job vs NC Baseline)
  const clampScore = (v) => Math.max(12, Math.min(100, Math.round(v)));
  const paceScore = isLive
    ? clampScore(overview?.overrides?.feed ?? 92)
    : clampScore(devRatio ? (1 / devRatio) * 95 : 88);

  const medMs = fullNc?.medianMs || baselineMs || durMs || 1;
  const stabErr = isLive ? 0.06 : Math.abs(durMs - medMs) / Math.max(1, medMs);
  const stabilityScore = clampScore((1 - Math.min(0.85, stabErr * 1.45)) * 100);

  const gapPenalty = preGapMs != null && baselineMs
    ? Math.min(45, (preGapMs / Math.max(60e3, baselineMs)) * 45)
    : 0;
  const evPenalty = incidents.reduce((acc, e) => acc + (e.sev === "CRITICAL" ? 32 : 16), 0);
  const continuityScore = clampScore(100 - evPenalty - gapPenalty);

  const feedVal = liveMeta?.feedOvrd ?? overview?.overrides?.feed ?? 100;
  const hasFeedEvent = incidents.some((e) => /feed|ovrd|hold/i.test(`${e.rule} ${e.msg}`));
  const feedScore = clampScore(hasFeedEvent ? Math.min(feedVal, 74) : feedVal);

  const consistencyScore = isLive
    ? 86
    : (speedRank && byFastest.length > 1
      ? clampScore(100 - ((speedRank - 1) / (byFastest.length - 1)) * 45)
      : (statusKind === "normal" ? 90 : statusKind === "high" ? 68 : statusKind === "over" ? 42 : 76));

  const radar = [
    { label: "Pace", job: paceScore, base: 92 },
    { label: "Stability", job: stabilityScore, base: 88 },
    { label: "Flow", job: continuityScore, base: 94 },
    { label: "Feed", job: feedScore, base: 95 },
    { label: "Repeat", job: consistencyScore, base: 86 },
  ];

  // Plain-English contextual insight
  let insight = "";
  if (isLive) {
    const remTxt = liveMeta.remainingMs != null ? ` · ~${fmtDurCompact(liveMeta.remainingMs)} remaining` : "";
    insight = `Active cycle cutting at ${liveMeta.spindleRpm != null ? `${liveMeta.spindleRpm} RPM` : "live speed"} (Feed ${feedVal}%)${remTxt}.`;
  } else if (statusKind === "over") {
    insight = `Ran ${devPct != null ? `+${devPct}%` : "significantly"} slower than NC baseline${incidents.length ? ` with ${incidents.length} controller event${incidents.length === 1 ? "" : "s"} overlapping` : ""}.`;
  } else if (statusKind === "high") {
    insight = `Drifted ${devPct != null ? `+${devPct}%` : "+15%"} above NC baseline — inspect feed override or chip-clear pause.`;
  } else if (statusKind === "low") {
    insight = `Finished ${devPct != null ? `${devPct}%` : "faster"} under NC baseline — verify no cycle abort or dry run.`;
  } else if (incidents.length > 0) {
    insight = `Finished within nominal band despite ${incidents.length} controller event${incidents.length === 1 ? "" : "s"} during cycle.`;
  } else {
    insight = `Clean nominal cycle${devPct != null ? ` (${devPct >= 0 ? "+" : ""}${devPct}% vs baseline)` : ""} with zero controller interruptions.`;
  }

  return {
    isLive,
    partKey: key,
    jobLabel: isLive ? "Live Cycle" : `Job #${part.job ?? chronoIdx}`,
    programRaw: isLive ? liveMeta.program : (part.program || fullNc?.programRaw || "Program"),
    programName: cleanProgName(isLive ? liveMeta.program : (part.program || fullNc?.programRaw)),
    t0,
    t1,
    durMs,
    remainingMs: isLive ? liveMeta.remainingMs : null,
    baselineMs,
    devPct,
    efficiencyPct,
    statusKind,
    badge,
    meter,
    rangeNeedle,
    chronoIdx,
    totalInRun,
    speedRank: speedRank && speedRank > 0 ? speedRank : null,
    completedInRun: byFastest.length,
    preGapMs,
    spindleRpm: isLive ? liveMeta.spindleRpm : (Number.isFinite(overview?.spindle_speed) ? Math.round(overview.spindle_speed) : null),
    feedOvrd: feedVal,
    toolId: liveMeta?.toolId || overview?.tool_id || null,
    radar,
    incidents,
    insight,
    prevPart: !isLive && chronoIdx > 1 ? sortedParts[chronoIdx - 2] : null,
    nextPart: !isLive && chronoIdx < sortedParts.length ? sortedParts[chronoIdx] : null,
  };
}

