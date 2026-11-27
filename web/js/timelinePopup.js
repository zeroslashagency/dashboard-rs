/* VMC Production Timeline — Unified Single-Surface Breakdown Popup Renderer.
 *
 * Renders all Timeline click popups in one clean, high-signal visual grammar
 * matching the Analytics breakdown and Shift Summary views across Light & Dark themes:
 *  - Shift Summary (fleet cutting vs non-cutting split, 4 state layers, 2x2 stats, active machines)
 *  - Single Job (minimal hairline tabs, compact mini NC strip, state breakdown bars, 2x2 stats, steppers)
 *  - Full NC (hairline tabs, compact mini NC strip, cutting split, cycle health rows, 2x2 stats, clickable job list)
 *  - Gap & Downtime Log (flat inline cause logger + existing cause summary + overlapping events)
 *  - Controller Event Pin (clean hairline telemetry readout)
 */

import { DOWNTIME_REASONS } from "./fleetCore.js";
import {
  buildFullNcReport,
  buildShiftSummaryReport,
  buildSingleJobReport,
  fmtClockIST,
  fmtClockSecIST,
  fmtDayIST,
  fmtDurCompact,
  getAdjacentShift,
  partKeyOf,
  shiftLabelForTs,
} from "./timelineCore.js";

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

function statusLabel(st) {
  const s = String(st || "").toLowerCase();
  if (s === "running") return "Cutting";
  if (s === "paused") return "Feed-Hold";
  if (s === "alarm") return "Alarm";
  if (s === "offline") return "Offline";
  return "Idle";
}

function fmtCompactClock(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${String(m).padStart(2, "0")}m`;
  }
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function fmtPctClean(v) {
  if (!Number.isFinite(v)) return "0%";
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? `${r}%` : `${r.toFixed(1)}%`;
}

function fmtRpmNum(v) {
  if (!Number.isFinite(v) || v <= 0) return "—";
  return Math.round(v).toLocaleString("en-US");
}

function fmtOvrSpan(short, v) {
  const isOff = v != null && v !== 100;
  return `<span class="tl2-sl-ovr${isOff ? " is-off" : ""}">${short} ${v == null ? "—" : `${v}%`}</span>`;
}

const MACHINE_PALETTE = [
  "#3b82f6",
  "#10b981",
  "#84cc16",
  "#f43f5e",
  "#ec4899",
  "#a855f7",
  "#f59e0b",
  "#06b6d4",
];

function machineSwatchColor(id) {
  const m = String(id || "").match(/(\d+)/);
  if (m) return MACHINE_PALETTE[(Math.max(1, Number(m[1])) - 1) % MACHINE_PALETTE.length];
  let h = 0;
  for (let i = 0; i < String(id || "").length; i++) h = (h * 31 + String(id).charCodeAt(i)) % MACHINE_PALETTE.length;
  return MACHINE_PALETTE[h];
}

function jobKindColor(kind) {
  switch (kind) {
    case "over": return "#f43f5e";
    case "high": return "#f59e0b";
    case "low": return "#38bdf8";
    case "live": return "#3b82f6";
    case "partial": return "#64748b";
    case "normal":
    case "neutral":
    default: return "#10b981";
  }
}

/* ==================== SHARED CLEAN BUILDING BLOCKS ==================== */

function renderPopupHeader({ title, isLive = false, scope, rightHtml, closeAttr = "data-pop-close" }) {
  return `
    <div class="tl2-sl-head">
      <div class="tl2-sl-head-left">
        <div class="tl2-sl-time-line">
          <span class="tl2-sl-time" title="${esc(title)}">${esc(title)}</span>
          ${isLive ? `<span class="tl2-sl-live">LIVE</span>` : ""}
        </div>
        <span class="tl2-sl-scope" title="${esc(scope)}">${esc(scope)}</span>
      </div>
      <div class="tl2-sl-head-right">
        ${rightHtml || ""}
        <button type="button" class="tl2-sl-close" ${closeAttr}="1" title="Close" aria-label="Close popup">×</button>
      </div>
    </div>
  `;
}

function renderHairlineTabs(tabs, activeTab) {
  if (!tabs || tabs.length < 2) return "";
  return `
    <div class="tl2-sl-tabs" role="tablist" aria-label="Inspector view">
      ${tabs
        .map(
          (t) => `<button type="button" role="tab" aria-selected="${t.id === activeTab}" class="tl2-sl-tab${t.id === activeTab ? " is-active" : ""}" data-pop-tab="${esc(t.id)}">${esc(t.label)}</button>`,
        )
        .join("")}
    </div>
  `;
}

function renderSplitBar({ leftLabel, leftPct, leftDur, rightLabel, rightPct, rightDur, rightTone = "loss" }) {
  const lp = Math.max(0, Math.min(100, Number.isFinite(leftPct) ? leftPct : 0));
  const rp = Math.max(0, Math.min(100, Number.isFinite(rightPct) ? rightPct : 0));
  const rightCls = rightTone === "rem" ? "tl2-sl-split-rem" : "tl2-sl-split-loss";
  return `
    <div class="tl2-sl-split">
      <div class="tl2-sl-split-labels">
        <span>${esc(leftLabel)} <strong>${esc(fmtPctClean(lp))}</strong>${leftDur ? ` (${esc(leftDur)})` : ""}</span>
        <span>${esc(rightLabel)} <strong>${esc(fmtPctClean(rp))}</strong>${rightDur ? ` (${esc(rightDur)})` : ""}</span>
      </div>
      <div class="tl2-sl-split-bar">
        <span class="tl2-sl-split-cut" style="width:${lp.toFixed(1)}%"></span>
        <span class="${rightCls}" style="width:${rp.toFixed(1)}%"></span>
      </div>
    </div>
  `;
}

function renderLayerRows(rows) {
  return `
    <div class="tl2-sl-layers">
      ${rows
        .map((l) => {
          const w = Math.max(0, Math.min(100, Number.isFinite(l.pct) ? l.pct : 0));
          return `
            <div class="tl2-sl-row">
              <div class="tl2-sl-row-top">
                <span class="tl2-sl-name">
                  <span class="tl2-sl-swatch" style="background:${l.color}"></span>
                  <span class="tl2-sl-lbl">${esc(l.name)}</span>
                </span>
                <span class="tl2-sl-nums">
                  <span class="tl2-sl-val">${esc(l.val)}</span>
                  <span class="tl2-sl-pct">${esc(fmtPctClean(l.pct))}</span>
                </span>
              </div>
              <div class="tl2-sl-bar-row">
                <span class="tl2-sl-sub">${esc(l.sub)}</span>
                <span class="tl2-sl-track"><span class="tl2-sl-fill" style="width:${w.toFixed(1)}%;background:${l.color}"></span></span>
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderCompactMiniStrip(fullNc, activePartKey) {
  if (!fullNc || !fullNc.miniStrip.length) return "";
  const blocks = fullNc.miniStrip
    .map((b) => {
      const left = `${b.leftPct.toFixed(2)}%`;
      const width = `${Math.max(1.0, b.widthPct).toFixed(2)}%`;
      if (b.kind === "gap") {
        const gapTitle = `${statusLabel(b.statusKind)} · ${fmtDurCompact(b.durMs)} (${fmtClockIST(b.t0)} → ${fmtClockIST(b.t1)})`;
        return `<span class="tl2-sl-ms-gap st-${esc(b.statusKind)}" style="left:${left};width:${width}" title="${esc(gapTitle)}"></span>`;
      }
      const selected = activePartKey && b.id === activePartKey;
      const devTxt = b.devPct != null ? ` (${b.devPct >= 0 ? "+" : ""}${b.devPct}%)` : "";
      const title = `${b.kind === "live" ? "Live Cycle" : `Job #${b.job ?? b.index}`} · ${fmtDurCompact(b.durMs)}${devTxt} · ${fmtClockIST(b.t0)} IST`;
      const lbl = b.label || (b.kind === "live" ? "LIVE" : `#${b.job ?? b.index}`);
      const minLblWidth = b.kind === "live" ? 9.5 : 6.2;
      const lblHtml = b.widthPct >= minLblWidth ? `<span class="tl2-sl-ms-lbl">${esc(lbl)}</span>` : "";
      return `<button type="button" class="tl2-sl-ms-blk k-${esc(b.statusKind)}${selected ? " is-sel" : ""}" style="left:${left};width:${width}" data-pop-part="${esc(b.id)}" title="${esc(title)}" aria-label="${esc(title)}">${lblHtml}</button>`;
    })
    .join("");

  const pinsHtml = (fullNc.miniPins || [])
    .map((p) => {
      const tone = p.rule === "estop" || p.rule === "offline" || p.sev === "CRITICAL"
        ? "is-crit"
        : (p.rule === "override" || p.rule === "feed_hold" || p.sev === "WARNING" ? "is-warn" : "is-info");
      const tip = `${p.msg} · ${fmtClockSecIST(p.ts)} IST`;
      return `<span class="tl2-sl-ms-ev ${tone}" style="left:${p.leftPct.toFixed(2)}%" title="${esc(tip)}" aria-hidden="true"></span>`;
    })
    .join("");

  const selBlk = activePartKey ? fullNc.miniStrip.find((b) => b.id === activePartKey) : null;
  const pinHtml = selBlk
    ? `<span class="tl2-sl-ms-pin" style="left:${Math.min(99, Math.max(1, selBlk.leftPct + selBlk.widthPct / 2)).toFixed(2)}%" aria-hidden="true"></span>`
    : "";

  return `
    <div class="tl2-sl-strip">
      <div class="tl2-sl-strip-head">
        <span class="tl2-sl-strip-title">${esc(fullNc.programName)} · ${fullNc.totalJobs}</span>
        <span class="tl2-sl-strip-meta">Click any job block</span>
      </div>
      <div class="tl2-sl-ms-track" role="group" aria-label="${esc(fullNc.programName)} mini timeline">
        ${blocks}
        ${pinsHtml}
        ${pinHtml}
      </div>
      <div class="tl2-sl-ms-axis">
        <span>${esc(fmtClockIST(fullNc.t0))}</span>
        <span>${esc(fmtDurCompact(fullNc.wallMs))} span</span>
        <span>${esc(fmtClockIST(fullNc.t1))} IST</span>
      </div>
    </div>
  `;
}

function renderCompactEvents(events, heading = "Controller Events") {
  if (!events || !events.length) return "";
  return `
    <div class="tl2-sl-evs">
      <div class="tl2-sl-mcs-head">
        <span>${esc(heading)}</span>
        <span>${events.length} event${events.length === 1 ? "" : "s"}</span>
      </div>
      <div class="tl2-sl-ev-list">
        ${events
          .slice(0, 5)
          .map((e) => {
            const col = e.sev === "CRITICAL" ? "#f43f5e" : e.sev === "WARNING" ? "#f59e0b" : "#3b82f6";
            return `
              <div class="tl2-sl-ev-row">
                <span class="tl2-sl-ev-left">
                  <span class="tl2-sl-swatch" style="background:${col}"></span>
                  <span class="tl2-sl-ev-msg" title="${esc(e.msg || e.rule)}">${esc(e.msg || e.rule)}</span>
                </span>
                <span class="tl2-sl-ev-ts">${esc(fmtClockSecIST(e.ts))}</span>
              </div>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

/* ==================== 1. SHIFT SUMMARY POPUP ==================== */

function renderShiftPopup({ refs, state, actions }) {
  const { hit, allLanes, overviewMap, eventsMap, downtimeLogs, shiftLoading } = state;
  const shift = hit.data;
  const nowMs = Date.now();
  const report = buildShiftSummaryReport({
    shift,
    lanes: allLanes || [],
    overviewMap,
    eventsMap,
    downtimeLogs: downtimeLogs || [],
    nowMs,
  });
  if (!report) return;

  const isDay = !!shift.isDay;
  const prevShift = !isDay ? getAdjacentShift(shift, -1, nowMs) : null;
  const nextShift = !isDay ? getAdjacentShift(shift, 1, nowMs) : null;

  const cutPct = report.cutSharePct;
  const nonCutPct = report.nonCutSharePct;
  const cutRound = Math.round(cutPct);
  const nonCutRound = report.hasData ? Math.max(0, 100 - cutRound) : 0;

  const timeRangeStr = isDay
    ? `${shift.name} · 00:00 → 24:00`
    : `${shift.name} · ${fmtClockIST(shift.t0)} → ${fmtClockIST(shift.t1)}`;
  const durMeta = report.isLive
    ? `${fmtDurCompact(report.elapsedMs)} elapsed`
    : report.isFuture
      ? "Scheduled"
      : `${isDay ? "24h" : "8h"} complete`;
  const scopeStr = `${shift.dayLabel} · ${report.activeMachines}/${report.totalMachines} VMCs · ${durMeta}`;

  const layersHtml = renderLayerRows([
    {
      color: "#10b981",
      name: "Cutting",
      sub: "Active machining",
      val: fmtDurCompact(report.cutMs),
      pct: cutPct,
    },
    {
      color: "#3b82f6",
      name: "Feed-Hold / Pause",
      sub: `${report.holdsCount} hold${report.holdsCount === 1 ? "" : "s"}`,
      val: fmtDurCompact(report.holdMs),
      pct: report.holdSharePct,
    },
    {
      color: "#6366f1",
      name: "Idle / Wait",
      sub: "Spindle stopped",
      val: fmtDurCompact(report.idleMs),
      pct: report.idleSharePct,
    },
    {
      color: "#f43f5e",
      name: "Fault · Alarm & E-Stop",
      sub: `${report.estopsCount} E-Stop · ${report.alarmsCount} Alarm`,
      val: fmtDurCompact(report.alarmMs),
      pct: report.alarmSharePct,
    },
  ]);

  const useLiveTelemetry = report.isLive && (report.avgRpm != null || report.avgFeedOvr != null);
  const cycSub = report.bestCycleMs != null
    ? `Best ${fmtCompactClock(report.bestCycleMs)}${report.maxCycleMs && report.maxCycleMs !== report.bestCycleMs ? ` · Max ${fmtCompactClock(report.maxCycleMs)}` : ""}`
    : "No completed cycles";
  const partsSub = `${report.partsPerHr}/hr${report.nominalPct != null ? ` · ${report.nominalPct}% nominal` : ""}`;

  let cell3Html = "";
  let cell4Html = "";
  if (useLiveTelemetry) {
    const anyOff = [report.avgFeedOvr, report.avgRapidOvr, report.avgSpindleOvr].some((v) => v != null && v !== 100);
    cell3Html = `
      <div class="tl2-sl-cell">
        <span class="tl2-sl-k">Spindle Speed</span>
        <span class="tl2-sl-v">${report.avgRpm != null ? `${esc(fmtRpmNum(report.avgRpm))} RPM` : "—"}</span>
        <span class="tl2-sl-m">${report.peakRpm != null ? `Peak ${esc(fmtRpmNum(report.peakRpm))} RPM` : "Spindle idle"}</span>
      </div>
    `;
    cell4Html = `
      <div class="tl2-sl-cell">
        <span class="tl2-sl-k">Overrides (100% base)</span>
        <span class="tl2-sl-v tl2-sl-ovrs">${fmtOvrSpan("F", report.avgFeedOvr)}${fmtOvrSpan("R", report.avgRapidOvr)}${fmtOvrSpan("S", report.avgSpindleOvr)}</span>
        <span class="tl2-sl-m">${anyOff ? "Off 100% nominal" : "All 100% nominal"}</span>
      </div>
    `;
  } else {
    const topProg = report.programs[0] || null;
    const slowAndOver = report.qualityCounts.high + report.qualityCounts.over;
    cell3Html = `
      <div class="tl2-sl-cell">
        <span class="tl2-sl-k">Top NC Program</span>
        <span class="tl2-sl-v tl2-sl-v-mono">${topProg ? esc(topProg.name) : "—"}</span>
        <span class="tl2-sl-m">${topProg ? `${topProg.parts} pcs · ${report.programs.length} program${report.programs.length === 1 ? "" : "s"}` : "No programs run"}</span>
      </div>
    `;
    cell4Html = `
      <div class="tl2-sl-cell">
        <span class="tl2-sl-k">Cycle Health</span>
        <span class="tl2-sl-v">${report.nominalPct != null ? `${report.nominalPct}% nominal` : "—"}</span>
        <span class="tl2-sl-m">${slowAndOver} slow/over · ${report.incidents.length} incident${report.incidents.length === 1 ? "" : "s"}</span>
      </div>
    `;
  }

  const activeList = report.machines.filter((m) => m.utilPct != null && (m.cutMs > 0 || m.partCount > 0));
  const showMachines = activeList.length ? activeList : report.machines;
  const mcHeaderRight = useLiveTelemetry ? "Cut % · Parts · RPM" : "Cut % · Parts · Loss";

  const mcRowsHtml = showMachines
    .map((m) => {
      const col = machineSwatchColor(m.id);
      const pctCls = m.utilPct == null ? "" : m.utilPct >= 75 ? "is-cut" : m.utilPct >= 50 ? "is-warn" : "is-bad";
      const pctTxt = m.utilPct != null ? `${m.utilPct}%` : "—";
      let tail = "";
      if (useLiveTelemetry) {
        const rpmTxt = m.rpm ? `${fmtRpmNum(m.rpm)} RPM` : "0 RPM";
        const ovrTxt = m.feedOvr != null && m.feedOvr !== 100
          ? ` · <span class="tl2-sl-ovr is-off">F ${m.feedOvr}%</span>`
          : "";
        tail = ` · ${esc(rpmTxt)}${ovrTxt}`;
      } else {
        tail = m.lossMs > 0 ? ` · ${esc(fmtDurCompact(m.lossMs))} loss` : "";
      }
      return `
        <button type="button" class="tl2-sl-mc-row" data-shift-machine="${esc(m.id)}" title="Click to toggle ${esc(m.name)} spindle & feed trace">
          <span class="tl2-sl-mc-id">
            <span class="tl2-sl-swatch" style="background:${col}"></span>
            <span>${esc(m.name)}</span>
          </span>
          <span class="tl2-sl-mc-stat">
            <strong class="${pctCls}">${esc(pctTxt)}</strong> cut · ${m.partCount} pcs${tail}
          </span>
        </button>
      `;
    })
    .join("");

  const syncHtml = shiftLoading ? `<div class="tl2-sl-sync">Syncing shift telemetry…</div>` : "";
  const ratioHtml = `
    <span class="tl2-sl-ratio">
      <strong class="is-cut">${report.hasData ? `${cutRound}%` : "—"}</strong> / <span class="is-loss">${report.hasData ? `${nonCutRound}%` : "—"}</span>
    </span>
  `;

  refs.drawerTitle.textContent = timeRangeStr;
  refs.drawerSub.textContent = scopeStr;

  refs.drawerBody.innerHTML = `
    <div class="tl2-sl-wrap">
      ${renderPopupHeader({ title: timeRangeStr, isLive: report.isLive, scope: scopeStr, rightHtml: ratioHtml, closeAttr: "data-shift-close" })}
      ${syncHtml}
      ${renderSplitBar({
        leftLabel: "Cutting",
        leftPct: cutPct,
        leftDur: fmtDurCompact(report.cutMs),
        rightLabel: "Non-Cutting",
        rightPct: nonCutPct,
        rightDur: fmtDurCompact(report.lossMs),
      })}
      ${layersHtml}
      <div class="tl2-sl-grid">
        <div class="tl2-sl-cell">
          <span class="tl2-sl-k">Part Count</span>
          <span class="tl2-sl-v">${report.totalParts} pcs</span>
          <span class="tl2-sl-m">${esc(partsSub)}</span>
        </div>
        <div class="tl2-sl-cell">
          <span class="tl2-sl-k">Cycle Time</span>
          <span class="tl2-sl-v">${esc(fmtCompactClock(report.medianCycleMs))}</span>
          <span class="tl2-sl-m">${esc(cycSub)}</span>
        </div>
        ${cell3Html}
        ${cell4Html}
      </div>
      <div class="tl2-sl-mcs">
        <div class="tl2-sl-mcs-head">
          <span>Active Machines in Shift</span>
          <span>${esc(mcHeaderRight)}</span>
        </div>
        <div class="tl2-sl-mcs-list">${mcRowsHtml}</div>
      </div>
      <div class="tl2-sl-foot">
        ${!isDay ? `
          <div class="tl2-sl-step">
            <button type="button" class="tl2-sl-foot-btn" data-shift-step="prev" ${prevShift ? "" : "disabled"}>‹ Prev</button>
            <span class="tl2-sl-step-code">${esc(shift.code)}</span>
            <button type="button" class="tl2-sl-foot-btn" data-shift-step="next" ${nextShift ? "" : "disabled"}>Next ›</button>
          </div>
        ` : `<span></span>`}
        <div class="tl2-sl-foot-right">
          ${!report.isLive ? `<button type="button" class="tl2-sl-foot-btn" data-shift-live="1">Live</button>` : ""}
          <button type="button" class="tl2-sl-foot-btn is-accent" data-shift-zoom="1">${isDay ? "Zoom Day →" : `Zoom ${esc(shift.name)} →`}</button>
        </div>
      </div>
    </div>
  `;

  const closeBtn = refs.drawerBody.querySelector("[data-shift-close]");
  if (closeBtn && actions.closeDrawer) closeBtn.addEventListener("click", () => actions.closeDrawer());

  refs.drawerBody.querySelectorAll("[data-shift-step]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dir = btn.getAttribute("data-shift-step");
      const target = dir === "prev" ? prevShift : nextShift;
      if (target && actions.selectShift) actions.selectShift(target);
    });
  });

  const zoomBtn = refs.drawerBody.querySelector("[data-shift-zoom]");
  if (zoomBtn && actions.zoomToShift) zoomBtn.addEventListener("click", () => actions.zoomToShift(shift));

  const liveBtn = refs.drawerBody.querySelector("[data-shift-live]");
  if (liveBtn && actions.jumpToLive) liveBtn.addEventListener("click", () => actions.jumpToLive());

  refs.drawerBody.querySelectorAll("[data-shift-machine]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mid = btn.getAttribute("data-shift-machine");
      if (mid && actions.focusMachineTrace) actions.focusMachineTrace(mid);
    });
  });
}

/* ==================== 2. SINGLE JOB / FULL NC / GAP / EVENT POPUPS ==================== */

export function renderTimelinePopup({ refs, state, actions }) {
  const { lane, hit, activeTab, ncCtx, overview, laneEvents, fleetStore } = state;
  if (hit && hit.type === "shift") {
    renderShiftPopup({ refs, state, actions });
    return;
  }

  const fullNc = ncCtx?.group || ncCtx?.liveMeta
    ? buildFullNcReport({
        group: ncCtx.group,
        groupParts: ncCtx.groupParts,
        bands: ncCtx.bands,
        events: laneEvents,
        liveMeta: ncCtx.liveMeta,
      })
    : null;

  const hasSingleJob = !!(ncCtx?.selectedPart || ncCtx?.liveMeta);
  const singleJob = hasSingleJob
    ? buildSingleJobReport({
        part: ncCtx.selectedPart,
        liveMeta: ncCtx.liveMeta,
        fullNc,
        bands: ncCtx?.bands || lane?.bands || [],
        events: laneEvents,
        overview,
      })
    : null;

  // Build Hairline Tabs
  const tabs = [];
  if (hit.type === "gap") {
    tabs.push({ id: "gap", label: "Gap & Log" });
    if (singleJob) tabs.push({ id: "job", label: "Single Job" });
    if (fullNc) tabs.push({ id: "nc", label: `Full NC (${fullNc.totalJobs})` });
  } else if (hit.type === "pin") {
    tabs.push({ id: "pin", label: "Event Pin" });
    if (singleJob) tabs.push({ id: "job", label: "Single Job" });
    if (fullNc) tabs.push({ id: "nc", label: `Full NC (${fullNc.totalJobs})` });
  } else {
    if (singleJob) tabs.push({ id: "job", label: singleJob.isLive ? "Live Job" : "Single Job" });
    if (fullNc) tabs.push({ id: "nc", label: `Full NC (${fullNc.totalJobs})` });
  }

  const effectiveTab = tabs.some((t) => t.id === activeTab) ? activeTab : (tabs[0]?.id || activeTab);

  let headerTitle = lane?.name || "Timeline";
  let headerLive = false;
  let headerScope = "";
  let headerRightHtml = "";
  let innerBodyHtml = "";
  let footerHtml = "";

  // -------------------- TAB A: SINGLE JOB --------------------
  if (effectiveTab === "job" && singleJob) {
    headerTitle = `${lane.name} · ${singleJob.jobLabel}`;
    headerLive = singleJob.isLive;
    headerScope = `${singleJob.programName} · ${fmtClockIST(singleJob.t0)} → ${singleJob.isLive ? "LIVE" : fmtClockIST(singleJob.t1)} IST · ${shiftLabelForTs(singleJob.t0)}`;

    const devStr = singleJob.devPct != null
      ? `${singleJob.devPct >= 0 ? "+" : ""}${singleJob.devPct}%`
      : null;

    if (singleJob.isLive) {
      headerRightHtml = `<span class="tl2-sl-ratio"><strong class="is-info">${singleJob.efficiencyPct}%</strong></span>`;
    } else if (singleJob.statusKind === "over") {
      headerRightHtml = `<span class="tl2-sl-ratio"><strong class="is-bad">${esc(devStr || "Overrun")}</strong></span>`;
    } else if (singleJob.statusKind === "high") {
      headerRightHtml = `<span class="tl2-sl-ratio"><strong class="is-warn">${esc(devStr || "Slow")}</strong></span>`;
    } else if (singleJob.statusKind === "low") {
      headerRightHtml = `<span class="tl2-sl-ratio"><strong class="is-info">${esc(devStr || "Short")}</strong></span>`;
    } else {
      headerRightHtml = `<span class="tl2-sl-ratio"><strong class="is-cut">${esc(devStr || "Nominal")}</strong></span>`;
    }

    const sb = singleJob.stateBreakdown;
    const splitHtml = singleJob.isLive && singleJob.totalEstMs
      ? renderSplitBar({
          leftLabel: "Elapsed",
          leftPct: singleJob.efficiencyPct,
          leftDur: fmtDurCompact(singleJob.durMs),
          rightLabel: "Remaining",
          rightPct: Math.max(0, 100 - singleJob.efficiencyPct),
          rightDur: singleJob.remainingMs != null ? fmtDurCompact(singleJob.remainingMs) : "",
          rightTone: "rem",
        })
      : renderSplitBar({
          leftLabel: "Cutting",
          leftPct: sb.cutSharePct,
          leftDur: fmtDurCompact(sb.cutMs),
          rightLabel: "Non-Cutting",
          rightPct: sb.nonCutSharePct,
          rightDur: fmtDurCompact(sb.lossMs),
        });

    const layersHtml = renderLayerRows([
      {
        color: "#10b981",
        name: "Cutting",
        sub: singleJob.isLive ? "Spindle active in cycle" : "Active machining in cycle",
        val: fmtDurCompact(sb.cutMs),
        pct: sb.cutSharePct,
      },
      {
        color: "#3b82f6",
        name: "Feed-Hold / Pause",
        sub: `${sb.holdsCount} hold${sb.holdsCount === 1 ? "" : "s"}`,
        val: fmtDurCompact(sb.holdMs),
        pct: sb.holdSharePct,
      },
      {
        color: "#6366f1",
        name: "Idle / Wait",
        sub: "Spindle stopped inside cycle",
        val: fmtDurCompact(sb.idleMs),
        pct: sb.idleSharePct,
      },
      {
        color: "#f43f5e",
        name: "Fault · Alarm & E-Stop",
        sub: `${sb.estopsCount} E-Stop · ${sb.alarmsCount} Alarm`,
        val: fmtDurCompact(sb.alarmMs),
        pct: sb.alarmSharePct,
      },
    ]);

    const baseSub = singleJob.baselineMs
      ? `${devStr ? `${devStr} vs base` : "Baseline match"}${singleJob.speedRank ? ` · #${singleJob.speedRank}/${singleJob.completedInRun}` : ""}`
      : `Job ${singleJob.chronoIdx} of ${singleJob.totalInRun}`;

    const preGapVal = singleJob.preGapMs != null ? fmtDurCompact(singleJob.preGapMs) : "First job";
    const preGapSub = singleJob.preGapMs != null
      ? `Before cycle · #${singleJob.chronoIdx}/${singleJob.totalInRun}`
      : `Start of ${singleJob.programName}`;

    let cell4Html = "";
    if (singleJob.isLive) {
      const anyOff = [singleJob.feedOvrd, singleJob.rapidOvrd, singleJob.spindleOvrd].some((v) => v != null && v !== 100);
      cell4Html = `
        <div class="tl2-sl-cell">
          <span class="tl2-sl-k">Overrides · ${singleJob.spindleRpm != null ? `${esc(fmtRpmNum(singleJob.spindleRpm))} RPM` : "Spindle"}</span>
          <span class="tl2-sl-v tl2-sl-ovrs">${fmtOvrSpan("F", singleJob.feedOvrd)}${fmtOvrSpan("R", singleJob.rapidOvrd)}${fmtOvrSpan("S", singleJob.spindleOvrd)}</span>
          <span class="tl2-sl-m">${anyOff ? "Off 100% nominal" : "All 100% nominal"}${singleJob.toolId ? ` · ${esc(singleJob.toolId)}` : ""}</span>
        </div>
      `;
    } else {
      const evCount = singleJob.incidents.length;
      const evVal = evCount > 0 ? `${evCount} event${evCount === 1 ? "" : "s"}` : "Clean cycle";
      const evSub = singleJob.toolId
        ? `Tool ${singleJob.toolId}${singleJob.feedOvrd != null ? ` · Feed ${singleJob.feedOvrd}%` : ""}`
        : (evCount > 0 ? "Overlapped during cut" : "Zero controller interruptions");
      cell4Html = `
        <div class="tl2-sl-cell">
          <span class="tl2-sl-k">Cycle Events</span>
          <span class="tl2-sl-v">${esc(evVal)}</span>
          <span class="tl2-sl-m">${esc(evSub)}</span>
        </div>
      `;
    }

    innerBodyHtml = `
      ${renderCompactMiniStrip(fullNc, singleJob.partKey)}
      ${splitHtml}
      ${layersHtml}
      <div class="tl2-sl-grid">
        <div class="tl2-sl-cell">
          <span class="tl2-sl-k">${singleJob.isLive ? "Elapsed Cycle" : "Cycle Time"}</span>
          <span class="tl2-sl-v">${esc(fmtCompactClock(singleJob.durMs))}</span>
          <span class="tl2-sl-m">${singleJob.isLive && singleJob.remainingMs != null ? `~${esc(fmtDurCompact(singleJob.remainingMs))} remaining` : `${esc(fmtClockSecIST(singleJob.t0))} → ${esc(fmtClockSecIST(singleJob.t1))}`}</span>
        </div>
        <div class="tl2-sl-cell">
          <span class="tl2-sl-k">NC Baseline</span>
          <span class="tl2-sl-v">${singleJob.baselineMs ? esc(fmtCompactClock(singleJob.baselineMs)) : "Pending"}</span>
          <span class="tl2-sl-m">${esc(baseSub)}</span>
        </div>
        <div class="tl2-sl-cell">
          <span class="tl2-sl-k">Pre-Cycle Gap</span>
          <span class="tl2-sl-v">${esc(preGapVal)}</span>
          <span class="tl2-sl-m">${esc(preGapSub)}</span>
        </div>
        ${cell4Html}
      </div>
      ${renderCompactEvents(singleJob.incidents, "Overlapping Events")}
    `;

    const hasSteppers = !singleJob.isLive && (singleJob.prevPart || singleJob.nextPart);
    footerHtml = `
      <div class="tl2-sl-foot">
        ${hasSteppers ? `
          <div class="tl2-sl-step">
            <button type="button" class="tl2-sl-foot-btn" data-pop-step="prev" ${singleJob.prevPart ? "" : "disabled"}>‹ Prev</button>
            <span class="tl2-sl-step-code">${singleJob.chronoIdx} / ${singleJob.totalInRun}</span>
            <button type="button" class="tl2-sl-foot-btn" data-pop-step="next" ${singleJob.nextPart ? "" : "disabled"}>Next ›</button>
          </div>
        ` : `<span class="tl2-sl-step-code">${singleJob.isLive ? "Live cycle" : `Job ${singleJob.chronoIdx} of ${singleJob.totalInRun}`}</span>`}
        <div class="tl2-sl-foot-right">
          ${fullNc ? `<button type="button" class="tl2-sl-foot-btn is-accent" data-pop-tab="nc">Full NC (${fullNc.totalJobs}) →</button>` : ""}
        </div>
      </div>
    `;
  }

  // -------------------- TAB B: FULL NC --------------------
  else if (effectiveTab === "nc" && fullNc) {
    headerTitle = `${lane.name} · ${fullNc.programName}`;
    headerLive = !!ncCtx?.liveMeta;
    headerScope = `${fullNc.totalJobs} job${fullNc.totalJobs === 1 ? "" : "s"} · ${fmtClockIST(fullNc.t0)} → ${fmtClockIST(fullNc.t1)} IST · ${fmtDayIST(fullNc.t0)}`;

    const sb = fullNc.stateBreakdown;
    const cutPct = sb.hasData ? sb.cutSharePct : fullNc.utilPct;
    const nonCutPct = sb.hasData ? sb.nonCutSharePct : Math.max(0, 100 - fullNc.utilPct);
    const cutRound = Math.round(cutPct);
    const nonCutRound = Math.max(0, 100 - cutRound);

    headerRightHtml = `
      <span class="tl2-sl-ratio">
        <strong class="is-cut">${cutRound}%</strong> / <span class="is-loss">${nonCutRound}%</span>
      </span>
    `;

    const compTotal = Math.max(1, fullNc.completedCount);
    const pctJob = (n) => Math.round((n / compTotal) * 1000) / 10;
    const nominalCount = fullNc.qualityCounts.normal + fullNc.qualityCounts.neutral;
    const slowCount = fullNc.qualityCounts.high;
    const overCount = fullNc.qualityCounts.over;

    const layersHtml = renderLayerRows([
      {
        color: "#10b981",
        name: "Nominal Cycles",
        sub: "Within NC baseline pace",
        val: `${nominalCount} pcs`,
        pct: fullNc.completedCount ? pctJob(nominalCount) : 0,
      },
      {
        color: "#f59e0b",
        name: "Slow +15%",
        sub: "Moderate cycle drift",
        val: `${slowCount} pcs`,
        pct: fullNc.completedCount ? pctJob(slowCount) : 0,
      },
      {
        color: "#f43f5e",
        name: "Overrun +30%",
        sub: "Severe cycle delay",
        val: `${overCount} pcs`,
        pct: fullNc.completedCount ? pctJob(overCount) : 0,
      },
      {
        color: "#6366f1",
        name: "Inter-Cycle Loss",
        sub: `${sb.holdsCount} hold${sb.holdsCount === 1 ? "" : "s"} · ${sb.estopsCount + sb.alarmsCount} fault${sb.estopsCount + sb.alarmsCount === 1 ? "" : "s"}`,
        val: fmtDurCompact(fullNc.gapMs),
        pct: nonCutPct,
      },
    ]);

    const activeKey = ncCtx?.selectedPart ? partKeyOf(ncCtx.selectedPart) : (ncCtx?.liveMeta ? "__LIVE__" : "");
    const jobRowsHtml = fullNc.jobRows.length
      ? fullNc.jobRows
          .map((row) => {
            const col = jobKindColor(row.statusKind);
            const devTxt = row.isLive
              ? "Live"
              : (row.devPct != null ? `${row.devPct >= 0 ? "+" : ""}${row.devPct}%` : "—");
            const devCls = row.statusKind === "over"
              ? "is-bad"
              : row.statusKind === "high"
                ? "is-warn"
                : (row.statusKind === "low" || row.statusKind === "live")
                  ? "is-info"
                  : "is-cut";
            const isSel = row.id === activeKey;
            return `
              <button type="button" class="tl2-sl-mc-row${isSel ? " is-active" : ""}" data-pop-part="${esc(row.id)}" title="Click to inspect ${esc(row.jobLabel)}">
                <span class="tl2-sl-mc-id">
                  <span class="tl2-sl-swatch" style="background:${col}"></span>
                  <span>${esc(row.jobLabel)}</span>
                  <span class="tl2-sl-job-clock">${esc(fmtClockIST(row.t0))}</span>
                </span>
                <span class="tl2-sl-mc-stat">
                  <strong class="${devCls}">${esc(devTxt)}</strong> · ${esc(fmtDurCompact(row.durMs))}
                </span>
              </button>
            `;
          })
          .join("")
      : `<div class="tl2-sl-empty">No completed jobs inside this NC window.</div>`;

    const cycRangeSub = fullNc.minMs != null
      ? `Best ${fmtCompactClock(fullNc.minMs)}${fullNc.p90Ms ? ` · P90 ${fmtCompactClock(fullNc.p90Ms)}` : ""}`
      : "No completed cycles";

    innerBodyHtml = `
      ${renderCompactMiniStrip(fullNc, activeKey)}
      ${renderSplitBar({
        leftLabel: "Cutting",
        leftPct: cutPct,
        leftDur: fmtDurCompact(fullNc.cutMs),
        rightLabel: "Non-Cutting",
        rightPct: nonCutPct,
        rightDur: fmtDurCompact(fullNc.gapMs),
      })}
      ${layersHtml}
      <div class="tl2-sl-grid">
        <div class="tl2-sl-cell">
          <span class="tl2-sl-k">Completed Jobs</span>
          <span class="tl2-sl-v">${fullNc.completedCount} / ${fullNc.totalJobs} pcs</span>
          <span class="tl2-sl-m">${nominalCount} nominal${fullNc.partialCount ? ` · ${fullNc.partialCount} partial` : ""}</span>
        </div>
        <div class="tl2-sl-cell">
          <span class="tl2-sl-k">Median Cycle</span>
          <span class="tl2-sl-v">${esc(fmtCompactClock(fullNc.medianMs))}</span>
          <span class="tl2-sl-m">${esc(cycRangeSub)}</span>
        </div>
        <div class="tl2-sl-cell">
          <span class="tl2-sl-k">NC Baseline</span>
          <span class="tl2-sl-v">${fullNc.baselineMs ? esc(fmtCompactClock(fullNc.baselineMs)) : "Pending"}</span>
          <span class="tl2-sl-m">${esc(fmtDurCompact(fullNc.wallMs))} total span</span>
        </div>
        <div class="tl2-sl-cell">
          <span class="tl2-sl-k">Run Incidents</span>
          <span class="tl2-sl-v">${fullNc.incidents.length} event${fullNc.incidents.length === 1 ? "" : "s"}</span>
          <span class="tl2-sl-m">${sb.holdsCount} holds · ${sb.estopsCount} E-Stop · ${sb.alarmsCount} Alm</span>
        </div>
      </div>
      <div class="tl2-sl-mcs">
        <div class="tl2-sl-mcs-head">
          <span>Jobs in NC Run</span>
          <span>Dev · Duration</span>
        </div>
        <div class="tl2-sl-mcs-list">${jobRowsHtml}</div>
      </div>
    `;

    footerHtml = `
      <div class="tl2-sl-foot">
        <span class="tl2-sl-step-code">${esc(fmtDurCompact(fullNc.cutMs))} cut / ${esc(fmtDurCompact(fullNc.wallMs))}</span>
        <div class="tl2-sl-foot-right">
          ${singleJob ? `<button type="button" class="tl2-sl-foot-btn is-accent" data-pop-tab="job">Single Job →</button>` : ""}
        </div>
      </div>
    `;
  }

  // -------------------- TAB C: GAP & DOWNTIME LOG --------------------
  else if (effectiveTab === "gap" && hit.type === "gap") {
    const gap = hit.data;
    const durMin = Math.max(1, Math.round(gap.durMs / 60e3));
    const shareOfHr = Math.min(100, Math.round((durMin / 60) * 100));
    const statusCol = gap.status === "alarm" ? "#f43f5e" : gap.status === "paused" ? "#3b82f6" : "#6366f1";
    const statusToneCls = gap.status === "alarm" ? "is-bad" : gap.status === "paused" ? "is-warn" : "is-loss";

    headerTitle = `${lane.name} · ${statusLabel(gap.status)} Gap`;
    headerScope = `${fmtDayIST(gap.t0)} · ${fmtClockIST(gap.t0)} → ${fmtClockIST(gap.t1)} IST · ${shiftLabelForTs(gap.t0)}`;
    headerRightHtml = `<span class="tl2-sl-ratio"><strong class="${statusToneCls}">${esc(fmtDurCompact(gap.durMs))}</strong></span>`;

    const reasonOpts = DOWNTIME_REASONS.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("");
    const loggedHtml = gap.logged
      ? `
        <div class="tl2-sl-logged">
          <div class="tl2-sl-mcs-head">
            <span>Logged Cause</span>
            <button type="button" class="tl2-sl-inline-btn" data-df="delGapLog">Remove</button>
          </div>
          <div class="tl2-sl-grid tl2-sl-grid-tight">
            <div class="tl2-sl-cell">
              <span class="tl2-sl-k">Reason</span>
              <span class="tl2-sl-v tl2-sl-v-sm">${esc(gap.logged.reason)}</span>
              ${gap.logged.note ? `<span class="tl2-sl-m">${esc(gap.logged.note)}</span>` : ""}
            </div>
            <div class="tl2-sl-cell">
              <span class="tl2-sl-k">Logged Duration</span>
              <span class="tl2-sl-v tl2-sl-v-sm">${gap.logged.durationMin} min</span>
              <span class="tl2-sl-m">${gap.logged.operator ? `By ${esc(gap.logged.operator)}` : "Fleet Intelligence log"}</span>
            </div>
          </div>
        </div>
      `
      : "";

    innerBodyHtml = `
      ${renderLayerRows([
        {
          color: statusCol,
          name: `${statusLabel(gap.status)} Downtime`,
          sub: gap.logged ? `Logged · ${gap.logged.reason}` : "Unclassified shop-floor loss",
          val: fmtDurCompact(gap.durMs),
          pct: shareOfHr,
        },
      ])}
      ${loggedHtml}
      <form class="tl2-sl-form" data-df="gapForm">
        <div class="tl2-sl-mcs-head">
          <span>${gap.logged ? "Log Additional Cause" : "Log Downtime Root Cause"}</span>
          <span>${esc(shiftLabelForTs(gap.t0))}</span>
        </div>
        <label class="tl2-sl-field">
          <span>Root Cause</span>
          <select class="tl2-sl-input" name="reason" required>${reasonOpts}</select>
        </label>
        <div class="tl2-sl-form-row">
          <label class="tl2-sl-field">
            <span>Duration (min)</span>
            <input class="tl2-sl-input" type="number" name="durationMin" min="1" max="1440" value="${durMin}" required />
          </label>
          <label class="tl2-sl-field">
            <span>Operator</span>
            <input class="tl2-sl-input" type="text" name="operator" maxlength="60" placeholder="Optional" />
          </label>
        </div>
        <label class="tl2-sl-field">
          <span>Shop-Floor Note</span>
          <input class="tl2-sl-input" type="text" name="note" maxlength="280" placeholder="Tool change, fixture setup, raw material wait…" />
        </label>
        <button type="submit" class="tl2-sl-submit">Save Downtime Cause</button>
      </form>
      ${renderCompactEvents(gap.events, "Overlapping Events")}
    `;

    footerHtml = `
      <div class="tl2-sl-foot">
        <span class="tl2-sl-step-code">${gap.logged ? "Logged" : "Unclassified"} · ${durMin} min</span>
        <div class="tl2-sl-foot-right">
          ${fullNc ? `<button type="button" class="tl2-sl-foot-btn is-accent" data-pop-tab="nc">Full NC →</button>` : ""}
        </div>
      </div>
    `;
  }

  // -------------------- TAB D: EVENT PIN --------------------
  else if (hit.type === "pin") {
    const ev = hit.data;
    const sev = String(ev.sev || "INFO").toUpperCase();
    const sevCls = sev === "CRITICAL" ? "is-bad" : sev === "WARNING" ? "is-warn" : "is-info";
    const sevCol = sev === "CRITICAL" ? "#f43f5e" : sev === "WARNING" ? "#f59e0b" : "#3b82f6";

    headerTitle = `${lane.name} · Controller Event`;
    headerScope = `${fmtDayIST(ev.ts)} · ${fmtClockSecIST(ev.ts)} IST · ${shiftLabelForTs(ev.ts)}`;
    headerRightHtml = `<span class="tl2-sl-ratio"><strong class="${sevCls}">${esc(sev)}</strong></span>`;

    innerBodyHtml = `
      <div class="tl2-sl-grid">
        <div class="tl2-sl-cell">
          <span class="tl2-sl-k">Rule</span>
          <span class="tl2-sl-v tl2-sl-v-mono">${esc(ev.rule || "event")}</span>
          <span class="tl2-sl-m">Controller trigger</span>
        </div>
        <div class="tl2-sl-cell">
          <span class="tl2-sl-k">Time (IST)</span>
          <span class="tl2-sl-v">${esc(fmtClockSecIST(ev.ts))}</span>
          <span class="tl2-sl-m">${esc(fmtDayIST(ev.ts))}</span>
        </div>
      </div>
      <div class="tl2-sl-evs">
        <div class="tl2-sl-mcs-head">
          <span>Controller Message</span>
          <span>${esc(lane.name)}</span>
        </div>
        <div class="tl2-sl-ev-msg-block">
          <span class="tl2-sl-swatch" style="background:${sevCol}"></span>
          <span>${esc(ev.msg || ev.rule || "Event recorded")}</span>
        </div>
      </div>
    `;

    footerHtml = `
      <div class="tl2-sl-foot">
        <span class="tl2-sl-step-code">${esc(shiftLabelForTs(ev.ts))}</span>
        <div class="tl2-sl-foot-right">
          ${fullNc ? `<button type="button" class="tl2-sl-foot-btn is-accent" data-pop-tab="nc">Full NC →</button>` : `<button type="button" class="tl2-sl-foot-btn" data-pop-close="1">Close</button>`}
        </div>
      </div>
    `;
  }

  refs.drawerTitle.textContent = headerTitle;
  refs.drawerSub.textContent = headerScope;

  refs.drawerBody.innerHTML = `
    <div class="tl2-sl-wrap">
      ${renderPopupHeader({ title: headerTitle, isLive: headerLive, scope: headerScope, rightHtml: headerRightHtml, closeAttr: "data-pop-close" })}
      ${renderHairlineTabs(tabs, effectiveTab)}
      <div class="tl2-sl-scroll">
        ${innerBodyHtml}
      </div>
      ${footerHtml}
    </div>
  `;

  // ---- Wire Interactive Handlers ----
  refs.drawerBody.querySelectorAll("[data-pop-close]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (actions.closeDrawer) actions.closeDrawer();
    });
  });

  refs.drawerBody.querySelectorAll("[data-pop-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextTab = btn.getAttribute("data-pop-tab");
      if (nextTab && actions.switchTab) actions.switchTab(nextTab);
    });
  });

  refs.drawerBody.querySelectorAll("[data-pop-part]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const partId = btn.getAttribute("data-pop-part");
      if (partId && actions.selectPartById) actions.selectPartById(partId);
    });
  });

  refs.drawerBody.querySelectorAll("[data-pop-step]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dir = btn.getAttribute("data-pop-step");
      if (dir === "prev" && singleJob?.prevPart && actions.selectPartRef) actions.selectPartRef(singleJob.prevPart);
      if (dir === "next" && singleJob?.nextPart && actions.selectPartRef) actions.selectPartRef(singleJob.nextPart);
    });
  });

  // Gap downtime logging handlers
  if (effectiveTab === "gap" && hit.type === "gap") {
    const gap = hit.data;
    const durMin = Math.max(1, Math.round(gap.durMs / 60e3));
    const shiftLbl = shiftLabelForTs(gap.t0);

    const delBtn = refs.drawerBody.querySelector('[data-df="delGapLog"]');
    if (delBtn && gap.logged) {
      delBtn.addEventListener("click", async () => {
        delBtn.disabled = true;
        delBtn.textContent = "Removing…";
        try {
          const st = await fleetStore.deleteDowntime(gap.logged.id);
          actions.onDowntimeMutated(st.downtimeLogs || []);
        } catch {
          delBtn.disabled = false;
          delBtn.textContent = "Remove";
        }
      });
    }

    const form = refs.drawerBody.querySelector('[data-df="gapForm"]');
    if (form) {
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const btn = form.querySelector("button[type=submit]");
        btn.disabled = true;
        btn.textContent = "Saving…";
        const fd = new FormData(form);
        try {
          const st = await fleetStore.addDowntime({
            machineId: lane.id,
            reason: String(fd.get("reason") || "Other"),
            durationMin: Math.max(1, Number(fd.get("durationMin")) || durMin),
            startTs: Math.round(gap.t0),
            shiftLabel: shiftLbl,
            operator: String(fd.get("operator") || "").trim(),
            note: String(fd.get("note") || "").trim(),
          });
          actions.onDowntimeMutated(st.downtimeLogs || []);
        } catch {
          btn.disabled = false;
          btn.textContent = "Save failed — retry";
        }
      });
    }
  }
}
