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
 * Clip machine state bands strictly to [t0, t1] and summarize Cutting, Feed-Hold,
 * Idle, and Fault (Alarm / E-Stop) durations, shares, and incident counts.
 */
export function clipStateBreakdown(bands = [], t0, t1, events = [], fallbackCutMs = null) {
  const spanMs = Math.max(0, t1 - t0);
  let cutMs = 0;
  let holdMs = 0;
  let idleMs = 0;
  let alarmMs = 0;
  let offMs = 0;
  let holdsCount = 0;
  let alarmBandCount = 0;

  for (const b of Array.isArray(bands) ? bands : []) {
    if (!b || b.t1 <= t0 || b.t0 >= t1) continue;
    const d = Math.min(b.t1, t1) - Math.max(b.t0, t0);
    if (d <= 0) continue;
    const st = String(b.status || "idle").toLowerCase();
    if (st === "running") cutMs += d;
    else if (st === "paused") {
      holdMs += d;
      holdsCount++;
    } else if (st === "alarm") {
      alarmMs += d;
      alarmBandCount++;
    } else if (st === "offline") offMs += d;
    else idleMs += d;
  }

  let activeMs = cutMs + holdMs + idleMs + alarmMs;
  if (activeMs <= 0 && fallbackCutMs != null && spanMs > 0) {
    cutMs = Math.max(0, Math.min(spanMs, fallbackCutMs));
    idleMs = Math.max(0, spanMs - cutMs);
    activeMs = cutMs + idleMs;
  }

  let estopsCount = 0;
  let alarmsEvCount = 0;
  let holdEvCount = 0;
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || e.ts < t0 - 5e3 || e.ts > t1 + 5e3 || e.rule === "program") continue;
    const txt = `${e.rule || ""} ${e.msg || ""}`.toLowerCase();
    if (/estop|e-stop|emergency/.test(txt)) estopsCount++;
    else if (/alarm|fault/.test(txt) || e.sev === "CRITICAL") alarmsEvCount++;
    else if (/hold|pause/.test(txt)) holdEvCount++;
  }

  const lossMs = holdMs + idleMs + alarmMs;
  const pct1 = (v) => (activeMs > 0 ? Math.round((v / activeMs) * 1000) / 10 : 0);
  const cutSharePct = pct1(cutMs);
  const nonCutSharePct = activeMs > 0 ? Math.max(0, Math.round((100 - cutSharePct) * 10) / 10) : 0;

  return {
    activeMs,
    cutMs,
    holdMs,
    idleMs,
    alarmMs,
    offMs,
    lossMs,
    cutSharePct,
    nonCutSharePct,
    holdSharePct: pct1(holdMs),
    idleSharePct: pct1(idleMs),
    alarmSharePct: pct1(alarmMs),
    holdsCount: Math.max(holdsCount, holdEvCount),
    estopsCount,
    alarmsCount: Math.max(alarmsEvCount, estopsCount === 0 ? alarmBandCount : 0),
    hasData: activeMs > 0,
  };
}

/**
 * Compute Full NC program run analytics, mini-timeline strip geometry, quality split,
 * clipped state breakdown, 24-segment cutting utilization meter, and clickable job list.
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

  // Build proportional real-timeline mini-strip blocks across [t0, t1]
  const miniStrip = [];
  const nonRunBands = (Array.isArray(bands) ? bands : [])
    .filter((b) => b && b.status !== "running" && b.t1 > t0 && b.t0 < t1)
    .slice()
    .sort((a, b) => a.t0 - b.t0);

  let gapSeq = 0;
  const pushGapSpan = (gStart, gEnd) => {
    if (gEnd <= gStart + 10_000) return;
    let emitted = false;
    for (const b of nonRunBands) {
      if (b.t1 <= gStart || b.t0 >= gEnd) continue;
      const s0 = Math.max(gStart, b.t0);
      const s1 = Math.min(gEnd, b.t1);
      if (s1 <= s0 + 5_000) continue;
      emitted = true;
      miniStrip.push({
        kind: "gap",
        id: `gap_${++gapSeq}`,
        t0: s0,
        t1: s1,
        durMs: s1 - s0,
        leftPct: Math.max(0, ((s0 - t0) / wallMs) * 100),
        widthPct: Math.max(0.6, ((s1 - s0) / wallMs) * 100),
        statusKind: String(b.status || "idle").toLowerCase(),
      });
    }
    if (!emitted) {
      miniStrip.push({
        kind: "gap",
        id: `gap_${++gapSeq}`,
        t0: gStart,
        t1: gEnd,
        durMs: gEnd - gStart,
        leftPct: Math.max(0, ((gStart - t0) / wallMs) * 100),
        widthPct: Math.max(0.6, ((gEnd - gStart) / wallMs) * 100),
        statusKind: "idle",
      });
    }
  };

  let cursor = t0;
  for (let i = 0; i < sortedParts.length; i++) {
    const p = sortedParts[i];
    pushGapSpan(cursor, p.t0);
    const stKind = partDeviationKind(p);
    const devPct = p.dev != null && Number.isFinite(p.dev)
      ? Math.round((p.dev - 1) * 100)
      : (baselineMs && p.dur ? Math.round(((p.dur / baselineMs) - 1) * 100) : null);
    const label = p.job != null
      ? (typeof p.job === "number" ? `#${p.job}` : String(p.job).slice(0, 6))
      : `#${i + 1}`;
    miniStrip.push({
      kind: "part",
      id: partKeyOf(p),
      job: p.job,
      label,
      devPct,
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
    pushGapSpan(cursor, liveMeta.t0);
    miniStrip.push({
      kind: "live",
      id: "__LIVE__",
      job: "LIVE",
      label: "LIVE",
      devPct: null,
      index: sortedParts.length + 1,
      t0: liveMeta.t0,
      t1: liveMeta.t1,
      durMs: liveMeta.durMs,
      leftPct: Math.max(0, ((liveMeta.t0 - t0) / wallMs) * 100),
      widthPct: Math.max(2, ((Math.max(1000, liveMeta.t1 - liveMeta.t0)) / wallMs) * 100),
      statusKind: "live",
    });
    cursor = Math.max(cursor, liveMeta.t1);
  }
  pushGapSpan(cursor, t1);

  const miniPins = incidents
    .filter((e) => e && e.ts >= t0 && e.ts <= t1)
    .slice(0, 14)
    .map((e) => ({
      ts: e.ts,
      leftPct: Math.max(1.5, Math.min(98.5, ((e.ts - t0) / wallMs) * 100)),
      sev: e.sev || "INFO",
      rule: e.rule || "event",
      msg: e.msg || e.rule || "Event",
    }));

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

  const stateBreakdown = clipStateBreakdown(bands, t0, t1, incidents, cutMs);

  return {
    programRaw: group?.program || liveMeta?.program || "Program",
    programName: cleanProgName(group?.program || liveMeta?.program),
    t0,
    t1,
    wallMs,
    cutMs,
    gapMs,
    utilPct,
    stateBreakdown,
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
    miniPins,
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
export function buildSingleJobReport({ part = null, liveMeta = null, fullNc = null, bands = [], events = [], overview = null }) {
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

  const stateBreakdown = clipStateBreakdown(bands, t0, t1, incidents, durMs);

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
    totalEstMs: isLive ? liveMeta.totalEstMs : null,
    baselineMs,
    devPct,
    efficiencyPct,
    statusKind,
    badge,
    meter,
    rangeNeedle,
    stateBreakdown,
    chronoIdx,
    totalInRun,
    speedRank: speedRank && speedRank > 0 ? speedRank : null,
    completedInRun: byFastest.length,
    preGapMs,
    spindleRpm: isLive ? liveMeta.spindleRpm : (Number.isFinite(overview?.spindle_speed) ? Math.round(overview.spindle_speed) : null),
    feedOvrd: feedVal,
    rapidOvrd: liveMeta?.rapidOvrd ?? (Number.isFinite(overview?.overrides?.rapid) ? Math.round(overview.overrides.rapid) : null),
    spindleOvrd: liveMeta?.spindleOvrd ?? (Number.isFinite(overview?.overrides?.spindle) ? Math.round(overview.overrides.spindle) : null),
    toolId: liveMeta?.toolId || overview?.tool_id || null,
    radar,
    incidents,
    insight,
    prevPart: !isLive && chronoIdx > 1 ? sortedParts[chronoIdx - 2] : null,
    nextPart: !isLive && chronoIdx < sortedParts.length ? sortedParts[chronoIdx] : null,
  };
}

const SHIFT_DEFS = [
  { shiftNum: 1, startHour: 6, code: "S1", name: "Shift 1", hoursLabel: "06–14" },
  { shiftNum: 2, startHour: 14, code: "S2", name: "Shift 2", hoursLabel: "14–22" },
  { shiftNum: 3, startHour: 22, code: "S3", name: "Shift 3", hoursLabel: "22–06" },
];

function makeShiftDescriptor(dayStartMs, def, winT0, winT1, nowMs) {
  const t0 = dayStartMs + def.startHour * 3600e3;
  const t1 = t0 + 8 * 3600e3;
  const span = Math.max(1, winT1 - winT0);
  const visT0 = Math.max(winT0, t0);
  const visT1 = Math.min(winT1, t1);
  const isFuture = t0 > nowMs;
  const isLive = nowMs >= t0 && nowMs < t1;
  const effEnd = isFuture ? t0 : Math.min(t1, nowMs);
  const elapsedMs = Math.max(0, effEnd - t0);
  return {
    id: `shift_${t0}`,
    shiftNum: def.shiftNum,
    code: def.code,
    name: def.name,
    hoursLabel: def.hoursLabel,
    dayLabel: fmtDayIST(t0),
    t0,
    t1,
    effEnd,
    elapsedMs,
    visT0,
    visT1,
    leftPct: Math.max(0, ((visT0 - winT0) / span) * 100),
    widthPct: Math.max(0, ((visT1 - visT0) / span) * 100),
    isLive,
    isFuture,
  };
}

/**
 * Enumerate every IST 8-hour shift (S1 06-14, S2 14-22, S3 22-06) overlapping [winT0, winT1].
 */
export function enumerateWindowShifts(winT0, winT1, nowMs = Date.now()) {
  const out = [];
  if (!Number.isFinite(winT0) || !Number.isFinite(winT1) || winT1 <= winT0) return out;
  const firstDay = istDayStart(winT0) - 86400e3;
  const lastDay = istDayStart(winT1) + 86400e3;
  for (let d = firstDay; d <= lastDay; d += 86400e3) {
    for (const def of SHIFT_DEFS) {
      const t0 = d + def.startHour * 3600e3;
      const t1 = t0 + 8 * 3600e3;
      if (t1 <= winT0 || t0 >= winT1) continue;
      const item = makeShiftDescriptor(d, def, winT0, winT1, nowMs);
      if (item.widthPct > 0.05) out.push(item);
    }
  }
  return out;
}

/**
 * Enumerate IST calendar days overlapping [winT0, winT1] for multi-day zoom ranges (7d / 30d).
 */
export function enumerateWindowDays(winT0, winT1, nowMs = Date.now()) {
  const out = [];
  if (!Number.isFinite(winT0) || !Number.isFinite(winT1) || winT1 <= winT0) return out;
  const span = Math.max(1, winT1 - winT0);
  const firstDay = istDayStart(winT0);
  const lastDay = istDayStart(winT1);
  for (let d = firstDay; d <= lastDay; d += 86400e3) {
    const t0 = d;
    const t1 = d + 86400e3;
    if (t1 <= winT0 || t0 >= winT1) continue;
    const visT0 = Math.max(winT0, t0);
    const visT1 = Math.min(winT1, t1);
    const isFuture = t0 > nowMs;
    const isLive = nowMs >= t0 && nowMs < t1;
    const effEnd = isFuture ? t0 : Math.min(t1, nowMs);
    out.push({
      id: `day_${t0}`,
      isDay: true,
      code: fmtDayIST(t0).replace(/,.*/, ""),
      name: fmtDayIST(t0),
      dayLabel: fmtDayIST(t0),
      hoursLabel: "00–24",
      t0,
      t1,
      effEnd,
      elapsedMs: Math.max(0, effEnd - t0),
      visT0,
      visT1,
      leftPct: Math.max(0, ((visT0 - winT0) / span) * 100),
      widthPct: Math.max(0, ((visT1 - visT0) / span) * 100),
      isLive,
      isFuture,
    });
  }
  return out;
}

/**
 * Step to the previous (-1) or next (+1) IST 8-hour shift relative to `shift`.
 */
export function getAdjacentShift(shift, delta, nowMs = Date.now()) {
  if (!shift || !Number.isFinite(shift.t0)) return null;
  const targetT0 = shift.t0 + delta * 8 * 3600e3;
  const targetT1 = targetT0 + 8 * 3600e3;
  if (delta > 0 && targetT0 > nowMs) return null;
  const ist = new Date(targetT0 + IST_OFFSET_MS);
  const h = ist.getUTCHours();
  const def = SHIFT_DEFS.find((d) => d.startHour === h) || SHIFT_DEFS[0];
  const dayStart = istDayStart(targetT0);
  return makeShiftDescriptor(dayStart, def, targetT0, targetT1, nowMs);
}

/**
 * Build a complete fleet-wide summary report for a single IST shift (or day) clipped strictly
 * to `[shift.t0, Math.min(shift.t1, nowMs)]` across all visible machines.
 */
export function buildShiftSummaryReport({
  shift,
  lanes = [],
  overviewMap = null,
  eventsMap = null,
  downtimeLogs = [],
  nowMs = Date.now(),
}) {
  if (!shift || !Number.isFinite(shift.t0) || !Number.isFinite(shift.t1)) return null;
  const laneList = Array.isArray(lanes) ? lanes : [...lanes.values()];
  const t0 = shift.t0;
  const t1 = shift.t1;
  const effEnd = Math.max(t0, Math.min(t1, nowMs));
  const elapsedMs = Math.max(0, effEnd - t0);
  const isLive = nowMs >= t0 && nowMs < t1;
  const isFuture = t0 > nowMs;

  let cutMs = 0;
  let idleMs = 0;
  let holdMs = 0;
  let alarmMs = 0;
  let offlineMs = 0;
  let totalParts = 0;
  let activeMachines = 0;
  let onlineMachines = 0;

  const qualityCounts = { normal: 0, high: 0, over: 0, low: 0, partial: 0, neutral: 0 };
  const allCompletedDurs = [];
  const progMap = new Map(); // cleanName -> { name, parts, cutMs, durs[], nominal, machines: Set }
  const machineRows = [];

  for (const lane of laneList) {
    if (!lane) continue;
    const sum = elapsedMs > 0
      ? summarizeLaneWindow(lane.parts, lane.bands, t0, effEnd)
      : { cutMs: 0, idleMs: 0, holdMs: 0, alarmMs: 0, offlineMs: 0, lossMs: 0, totalMs: 0, utilPct: null, partCount: 0, slowCount: 0, shortCount: 0 };

    cutMs += sum.cutMs;
    idleMs += sum.idleMs;
    holdMs += sum.holdMs;
    alarmMs += sum.alarmMs;
    offlineMs += sum.offlineMs;
    totalParts += sum.partCount;
    if (sum.cutMs > 0 || sum.partCount > 0) activeMachines += 1;
    if (sum.cutMs + sum.idleMs + sum.holdMs + sum.alarmMs > 0) onlineMachines += 1;

    const shiftParts = (Array.isArray(lane.parts) ? lane.parts : []).filter(
      (p) => p && p.t1 >= t0 && p.t0 <= effEnd,
    );
    const machineProgCounts = new Map();
    for (const p of shiftParts) {
      const k = partDeviationKind(p);
      qualityCounts[k] = (qualityCounts[k] || 0) + 1;
      const dur = Number.isFinite(p.dur) && p.dur > 0 ? p.dur : Math.max(0, p.t1 - p.t0);
      if (!p.partial && dur > 0) allCompletedDurs.push(dur);

      const pname = cleanProgName(p.program);
      machineProgCounts.set(pname, (machineProgCounts.get(pname) || 0) + 1);
      if (!p.partial) {
        let rec = progMap.get(pname);
        if (!rec) {
          rec = { name: pname, parts: 0, cutMs: 0, durs: [], nominal: 0, machines: new Set() };
          progMap.set(pname, rec);
        }
        rec.parts += 1;
        rec.cutMs += dur;
        if (dur > 0) rec.durs.push(dur);
        if (k === "normal" || k === "neutral") rec.nominal += 1;
        rec.machines.add(lane.id);
      }
    }

    let topProgram = "";
    let topProgN = 0;
    for (const [pn, cnt] of machineProgCounts) {
      if (cnt > topProgN) {
        topProgN = cnt;
        topProgram = pn;
      }
    }

    const mEvents = eventsMap && eventsMap.get ? (eventsMap.get(lane.id) || []) : [];
    const shiftIncidents = mEvents.filter((e) => e && e.ts >= t0 && e.ts <= effEnd && e.rule !== "program");
    const estopCount = shiftIncidents.filter((e) => e.rule === "estop").length;
    const alarmCount = shiftIncidents.filter((e) => e.rule !== "estop" && (e.sev === "CRITICAL" || e.rule === "alarm" || e.rule === "offline")).length;
    const holdEventCount = shiftIncidents.filter((e) => e.rule === "feed_hold" || e.rule === "override" || e.sev === "WARNING").length;

    // Count distinct paused bands in this shift as holds if no explicit hold events exist
    let holdBandsCount = 0;
    for (const b of Array.isArray(lane.bands) ? lane.bands : []) {
      if (b && b.status === "paused" && b.t1 > t0 && b.t0 < effEnd && (Math.min(effEnd, b.t1) - Math.max(t0, b.t0)) >= 5000) {
        holdBandsCount += 1;
      }
    }
    const machineHolds = Math.max(holdEventCount, holdBandsCount);

    const ov = overviewMap && overviewMap.get ? overviewMap.get(lane.id) : null;
    const liveStatus = ov
      ? (ov.online === false ? "offline" : String(ov.status || "idle").toLowerCase())
      : (sum.cutMs > 0 ? "running" : sum.offlineMs > 0 && sum.utilPct === 0 ? "offline" : "idle");
    const liveRpm = ov && ov.online !== false && Number.isFinite(Number(ov.spindle_speed))
      ? Math.round(Number(ov.spindle_speed))
      : null;
    const liveFeedOvr = ov && ov.online !== false && ov.overrides && Number.isFinite(Number(ov.overrides.feed))
      ? Math.round(Number(ov.overrides.feed))
      : null;
    const liveRapidOvr = ov && ov.online !== false && ov.overrides && Number.isFinite(Number(ov.overrides.rapid))
      ? Math.round(Number(ov.overrides.rapid))
      : null;
    const liveSpindleOvr = ov && ov.online !== false && ov.overrides && Number.isFinite(Number(ov.overrides.spindle))
      ? Math.round(Number(ov.overrides.spindle))
      : null;

    machineRows.push({
      id: lane.id,
      name: lane.name || lane.id,
      utilPct: sum.utilPct,
      cutMs: sum.cutMs,
      idleMs: sum.idleMs,
      holdMs: sum.holdMs,
      alarmMs: sum.alarmMs,
      offlineMs: sum.offlineMs,
      lossMs: sum.lossMs,
      partCount: sum.partCount,
      slowCount: sum.slowCount,
      shortCount: sum.shortCount,
      incidentCount: shiftIncidents.length,
      estopCount,
      alarmCount: alarmCount + estopCount,
      holdsCount: machineHolds,
      topProgram,
      liveStatus,
      rpm: liveRpm,
      feedOvr: liveFeedOvr,
      rapidOvr: liveRapidOvr,
      spindleOvr: liveSpindleOvr,
    });
  }

  // Sort machines by utilization descending, then parts descending, then name
  machineRows.sort((a, b) => {
    const ua = a.utilPct == null ? -1 : a.utilPct;
    const ub = b.utilPct == null ? -1 : b.utilPct;
    if (ub !== ua) return ub - ua;
    if (b.partCount !== a.partCount) return b.partCount - a.partCount;
    return String(a.name).localeCompare(String(b.name));
  });

  const activeDenom = cutMs + idleMs + holdMs + alarmMs;
  const totalTrackedMs = activeDenom + offlineMs;
  const hasData = totalTrackedMs > 0 || totalParts > 0;
  const utilPct = activeDenom > 0 ? Math.round((cutMs / activeDenom) * 100) : (offlineMs > 0 ? 0 : null);
  const lossMs = idleMs + holdMs + alarmMs;

  const round1 = (v) => Math.round(v * 10) / 10;
  const cutSharePct = activeDenom > 0 ? round1((cutMs / activeDenom) * 100) : 0;
  const nonCutSharePct = activeDenom > 0 ? round1((lossMs / activeDenom) * 100) : 0;
  const holdSharePct = activeDenom > 0 ? round1((holdMs / activeDenom) * 100) : 0;
  const idleSharePct = activeDenom > 0 ? round1((idleMs / activeDenom) * 100) : 0;
  const alarmSharePct = activeDenom > 0 ? round1((alarmMs / activeDenom) * 100) : 0;

  const holdsCount = machineRows.reduce((acc, m) => acc + (m.holdsCount || 0), 0);
  const estopsCount = machineRows.reduce((acc, m) => acc + (m.estopCount || 0), 0);
  const alarmsCount = machineRows.reduce((acc, m) => acc + Math.max(0, (m.alarmCount || 0) - (m.estopCount || 0)), 0);

  const runningRpms = machineRows.map((m) => m.rpm).filter((v) => v != null && v > 0);
  const avgRpm = runningRpms.length ? Math.round(runningRpms.reduce((a, b) => a + b, 0) / runningRpms.length) : null;
  const peakRpm = runningRpms.length ? Math.max(...runningRpms) : null;
  const avgOf = (vals) => (vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null);
  const avgFeedOvr = avgOf(machineRows.map((m) => m.feedOvr).filter((v) => v != null));
  const avgRapidOvr = avgOf(machineRows.map((m) => m.rapidOvr).filter((v) => v != null));
  const avgSpindleOvr = avgOf(machineRows.map((m) => m.spindleOvr).filter((v) => v != null));

  const mixDenom = Math.max(1, totalTrackedMs);
  const timeMix = {
    cutPct: totalTrackedMs > 0 ? (cutMs / mixDenom) * 100 : 0,
    idlePct: totalTrackedMs > 0 ? (idleMs / mixDenom) * 100 : 0,
    holdPct: totalTrackedMs > 0 ? (holdMs / mixDenom) * 100 : 0,
    alarmPct: totalTrackedMs > 0 ? (alarmMs / mixDenom) * 100 : 0,
    offlinePct: totalTrackedMs > 0 ? (offlineMs / mixDenom) * 100 : 0,
  };

  const completedCount = qualityCounts.normal + qualityCounts.high + qualityCounts.over + qualityCounts.low + qualityCounts.neutral;
  const nominalCount = qualityCounts.normal + qualityCounts.neutral;
  const nominalPct = completedCount > 0 ? Math.round((nominalCount / completedCount) * 100) : null;
  allCompletedDurs.sort((a, b) => a - b);
  const medianCycleMs = quantileSorted(allCompletedDurs, 0.5);
  const bestCycleMs = allCompletedDurs.length ? allCompletedDurs[0] : null;
  const maxCycleMs = allCompletedDurs.length ? allCompletedDurs[allCompletedDurs.length - 1] : null;

  const hrs = Math.max(0.05, elapsedMs / 3600e3);
  const partsPerHr = elapsedMs > 0 ? Number((totalParts / hrs).toFixed(1)) : 0;

  // Top NC programs in shift
  const programs = [...progMap.values()]
    .map((rec) => {
      rec.durs.sort((a, b) => a - b);
      return {
        name: rec.name,
        parts: rec.parts,
        cutMs: rec.cutMs,
        medianMs: quantileSorted(rec.durs, 0.5),
        nominalPct: rec.parts > 0 ? Math.round((rec.nominal / rec.parts) * 100) : 0,
        machinesCount: rec.machines.size,
      };
    })
    .sort((a, b) => (b.parts - a.parts) || (b.cutMs - a.cutMs));

  // Fleet-wide incidents & logged downtime overlapping this shift
  const incidents = [];
  if (eventsMap && eventsMap.entries) {
    const visibleIds = new Set(laneList.map((l) => l.id));
    for (const [mid, arr] of eventsMap.entries()) {
      if (visibleIds.size && !visibleIds.has(mid)) continue;
      for (const e of arr || []) {
        if (e && e.ts >= t0 && e.ts <= effEnd && e.rule !== "program") {
          incidents.push({ ...e, machine: e.machine || mid });
        }
      }
    }
  }
  incidents.sort((a, b) => b.ts - a.ts);

  const loggedDowntime = (Array.isArray(downtimeLogs) ? downtimeLogs : [])
    .filter((log) => {
      if (!log) return false;
      const ls = Number(log.startTs);
      const le = ls + Math.max(1, Number(log.durationMin) || 1) * 60e3;
      return Number.isFinite(ls) && le >= t0 && ls <= effEnd;
    })
    .sort((a, b) => Number(b.startTs) - Number(a.startTs));

  // Tone, tactile badge & 24-segment utilization meter
  const tone = !hasData || utilPct == null
    ? "neutral"
    : utilPct >= 75
      ? "success"
      : utilPct >= 50
        ? "warning"
        : "danger";

  const badge = isFuture
    ? { tone: "neutral", label: "Upcoming", icon: "clock" }
    : !hasData || utilPct == null
      ? { tone: "neutral", label: "No Signal", icon: "clock" }
      : isLive
        ? { tone: "info", label: `Live · ${utilPct}%`, icon: "arrow" }
        : tone === "success"
          ? { tone: "success", label: `${utilPct}% Optimal`, icon: "check" }
          : tone === "warning"
            ? { tone: "warning", label: `${utilPct}% Moderate`, icon: "alert" }
            : { tone: "danger", label: `${utilPct}% Low Util`, icon: "x" };

  const meter = computeSegmentedMeter(utilPct ?? 0, tone === "neutral" ? "info" : tone, 24);

  // Operational plain-English insight
  const topMachine = machineRows.find((m) => m.utilPct != null && m.utilPct > 0) || null;
  const lowMachine = [...machineRows].reverse().find((m) => m.utilPct != null && m.id !== topMachine?.id) || null;
  let insight = "";
  let insightTone = tone === "neutral" ? "info" : tone;

  if (isFuture) {
    insight = `${shift.name} (${shift.hoursLabel} IST) has not started yet.`;
  } else if (!hasData) {
    insight = `No telemetry recorded in this window yet — step or zoom to fetch shift history.`;
  } else {
    const lossBucket = alarmMs >= holdMs && alarmMs >= idleMs && alarmMs > 0
      ? `Alarm stops (${fmtDurCompact(alarmMs)})`
      : holdMs >= idleMs && holdMs > 0
        ? `Feed-Hold (${fmtDurCompact(holdMs)})`
        : `Idle gaps (${fmtDurCompact(idleMs)})`;

    if (alarmMs > 0 && incidents.some((e) => e.sev === "CRITICAL")) {
      insight = `${totalParts} parts cut at ${utilPct}% fleet utilization. Primary bottleneck: ${lossBucket} across ${incidents.length} incident${incidents.length === 1 ? "" : "s"}.`;
      insightTone = "danger";
    } else if (utilPct != null && utilPct >= 75) {
      insight = `Strong shift output — ${totalParts} parts at ${partsPerHr}/hr${topMachine ? `, led by ${topMachine.name} (${topMachine.utilPct}%)` : ""}.`;
      insightTone = "success";
    } else {
      const lagPart = lowMachine && lowMachine.utilPct != null ? ` · lowest: ${lowMachine.name} (${lowMachine.utilPct}%)` : "";
      insight = `${totalParts} parts cut (${utilPct ?? 0}% utilization). Largest non-cutting loss: ${lossBucket}${lagPart}.`;
      insightTone = utilPct != null && utilPct < 50 ? "danger" : "warning";
    }
  }

  return {
    shift,
    t0,
    t1,
    effEnd,
    elapsedMs,
    isLive,
    isFuture,
    hasData,
    utilPct,
    cutSharePct,
    nonCutSharePct,
    holdSharePct,
    idleSharePct,
    alarmSharePct,
    holdsCount,
    alarmsCount,
    estopsCount,
    avgRpm,
    peakRpm,
    avgFeedOvr,
    avgRapidOvr,
    avgSpindleOvr,
    tone,
    badge,
    meter,
    cutMs,
    idleMs,
    holdMs,
    alarmMs,
    offlineMs,
    lossMs,
    totalTrackedMs,
    timeMix,
    totalParts,
    partsPerHr,
    activeMachines,
    onlineMachines,
    totalMachines: laneList.length,
    qualityCounts,
    completedCount,
    nominalPct,
    medianCycleMs,
    bestCycleMs,
    maxCycleMs,
    machines: machineRows,
    programs,
    incidents,
    loggedDowntime,
    insight,
    insightTone,
  };
}


