/* VMC Production Timeline — Single Job & Full NC Precision Detail Popup Renderer.
 *
 * Pure DOM/SVG presentation for the anchored Timeline inspector popover:
 *  - Segmented tab switcher (Single Job | Full NC | Gap & Log | Event Pin)
 *  - Tactile icon status badges (Nominal, Slow, Overrun, Short, Live, Alarm, Logged)
 *  - 24-segment LED efficiency / utilization meter + baseline duration range needle
 *  - Interactive clickable Mini NC Timeline Strip with active job playhead highlight
 *  - Side-by-side Spec Comparison Matrix + 5-axis grounded SVG Radar Chart
 *  - Chronological clickable Full NC Job List & inline Fleet Intelligence downtime logger
 */

import { DOWNTIME_REASONS } from "./fleetCore.js";
import {
  buildFullNcReport,
  buildSingleJobReport,
  computeSegmentedMeter,
  fmtClockHero,
  fmtClockIST,
  fmtClockSecIST,
  fmtDayIST,
  fmtDurCompact,
  healthBadgeForKind,
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

function badgeIconSvg(icon) {
  switch (icon) {
    case "check":
      return `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.2 8.2 7.1 10.1 11 6.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case "alert":
      return `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.8v3.8M8 11.1h.01" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
    case "x":
      return `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.8 5.8 10.2 10.2M10.2 5.8 5.8 10.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    case "arrow":
      return `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6 10 10 6M6.8 6H10v3.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case "clock":
    default:
      return `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
}

function renderTactileBadge(badge, compact = false) {
  if (!badge) return "";
  return `<span class="tl2-badge tl2-badge-${esc(badge.tone)}${compact ? " is-sm" : ""}">${badgeIconSvg(badge.icon)}<span>${esc(badge.label)}</span></span>`;
}

function renderSegmentedMeter(meter, label, rightText) {
  const ticks = meter.segs
    .map((s) => `<i class="tl2-seg-tick is-${esc(s.tone)}"></i>`)
    .join("");
  return `
    <div class="tl2-pop-meter">
      <div class="tl2-pop-meter-top">
        <span class="tl2-pop-k">${esc(label)}</span>
        <span class="tl2-pop-meter-val">${esc(rightText)}</span>
      </div>
      <div class="tl2-seg-rail" role="img" aria-label="${esc(label)} ${meter.pct}%">${ticks}</div>
    </div>
  `;
}

function renderRangeBar(rangeNeedle) {
  if (!rangeNeedle) return "";
  return `
    <div class="tl2-range-wrap">
      <div class="tl2-range-track">
        <div class="tl2-range-base" style="left:${rangeNeedle.basePct.toFixed(1)}%" title="NC Baseline: ${esc(fmtDurCompact(rangeNeedle.baseMs))}"></div>
        <div class="tl2-range-needle" style="left:${rangeNeedle.needlePct.toFixed(1)}%" title="This Job: ${esc(fmtDurCompact(rangeNeedle.valMs))}"></div>
      </div>
      <div class="tl2-range-labels">
        <span>${esc(fmtDurCompact(rangeNeedle.minMs))}</span>
        <span>Base ${esc(fmtDurCompact(rangeNeedle.baseMs))}</span>
        <span>${esc(fmtDurCompact(rangeNeedle.maxMs))}</span>
      </div>
    </div>
  `;
}

function renderMiniStrip(fullNc, activePartKey) {
  if (!fullNc || !fullNc.miniStrip.length) return "";
  const blocks = fullNc.miniStrip
    .map((b) => {
      const left = `${b.leftPct.toFixed(2)}%`;
      const width = `${Math.max(1.2, b.widthPct).toFixed(2)}%`;
      if (b.kind === "gap") {
        return `<span class="tl2-mini-gap st-${esc(b.statusKind)}" style="left:${left};width:${width}" title="${esc(statusLabel(b.statusKind))} · ${esc(fmtDurCompact(b.durMs))}"></span>`;
      }
      const selected = activePartKey && b.id === activePartKey;
      const title = `${b.kind === "live" ? "Live Cycle" : `Job #${b.job ?? b.index}`} · ${fmtDurCompact(b.durMs)} (${fmtClockIST(b.t0)})`;
      return `<button type="button" class="tl2-mini-blk k-${esc(b.statusKind)}${selected ? " is-sel" : ""}" style="left:${left};width:${width}" data-pop-part="${esc(b.id)}" title="${esc(title)}" aria-label="${esc(title)}"></button>`;
    })
    .join("");

  // Optional active playhead pin centered on the selected block
  const selBlk = activePartKey ? fullNc.miniStrip.find((b) => b.id === activePartKey) : null;
  const pinHtml = selBlk
    ? `<span class="tl2-mini-pin" style="left:${Math.min(99, Math.max(1, selBlk.leftPct + selBlk.widthPct / 2)).toFixed(2)}%" aria-hidden="true"></span>`
    : "";

  return `
    <div class="tl2-pop-strip-sec">
      <div class="tl2-pop-strip-head">
        <span class="tl2-pop-k">NC Run Timeline · ${esc(fullNc.programName)}</span>
        <span class="tl2-pop-strip-meta">${fullNc.totalJobs} cycle${fullNc.totalJobs === 1 ? "" : "s"} · click any block</span>
      </div>
      <div class="tl2-mini-track">
        ${blocks}
        ${pinHtml}
      </div>
      <div class="tl2-mini-axis">
        <span>${esc(fmtClockIST(fullNc.t0))}</span>
        <span>${esc(fmtDurCompact(fullNc.wallMs))} span</span>
        <span>${esc(fmtClockIST(fullNc.t1))}</span>
      </div>
    </div>
  `;
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

function renderRadarSvg(axes, tone = "success") {
  if (!Array.isArray(axes) || axes.length < 3) return "";
  const cx = 110;
  const cy = 78;
  const maxR = 45;
  const n = axes.length;

  const pt = (idx, frac) => {
    const angle = -Math.PI / 2 + (idx * 2 * Math.PI) / n;
    return [cx + Math.cos(angle) * maxR * frac, cy + Math.sin(angle) * maxR * frac];
  };

  const rings = [0.33, 0.66, 1.0].map((f) => {
    const pts = axes.map((_, i) => pt(i, f).map((v) => v.toFixed(1)).join(",")).join(" ");
    return `<polygon class="tl2-rad-ring" points="${pts}" />`;
  }).join("");

  const spokes = axes.map((_, i) => {
    const [x, y] = pt(i, 1);
    return `<line class="tl2-rad-spoke" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" />`;
  }).join("");

  const basePts = axes.map((a, i) => pt(i, a.base / 100).map((v) => v.toFixed(1)).join(",")).join(" ");
  const jobPts = axes.map((a, i) => pt(i, a.job / 100).map((v) => v.toFixed(1)).join(",")).join(" ");

  const dots = axes.map((a, i) => {
    const [x, y] = pt(i, a.job / 100);
    return `<circle class="tl2-rad-dot is-${esc(tone)}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.7" />`;
  }).join("");

  const labels = axes.map((a, i) => {
    const [x, y] = pt(i, 1.28);
    const anchor = Math.abs(x - cx) < 6 ? "middle" : x > cx ? "start" : "end";
    const dy = y < cy - 30 ? -3 : y > cy + 30 ? 8 : 3;
    return `<text class="tl2-rad-lbl" x="${x.toFixed(1)}" y="${(y + dy).toFixed(1)}" text-anchor="${anchor}">${esc(a.label)}</text>`;
  }).join("");

  return `
    <svg class="tl2-radar-svg" viewBox="0 0 220 158" role="img" aria-label="Job vs NC baseline 5-axis radar chart">
      ${rings}
      ${spokes}
      <polygon class="tl2-rad-base" points="${basePts}" />
      <polygon class="tl2-rad-job is-${esc(tone)}" points="${jobPts}" />
      ${dots}
      ${labels}
    </svg>
  `;
}

function renderEventsList(events, emptyMsg) {
  if (!events || !events.length) {
    return `<div class="tl2-pop-clean">${esc(emptyMsg)}</div>`;
  }
  return `<div class="tl2-ev-list">${events
    .slice(0, 8)
    .map(
      (e) => `<div class="tl2-ev-row"><span class="tl2-ev-time">${esc(fmtClockSecIST(e.ts))}</span><span>${esc(e.msg || e.rule)}</span></div>`,
    )
    .join("")}</div>`;
}

function renderInsightStrip(text, tone = "info") {
  if (!text) return "";
  return `
    <div class="tl2-pop-insight is-${esc(tone)}">
      ${badgeIconSvg(tone === "danger" ? "x" : tone === "warning" ? "alert" : tone === "success" ? "check" : "alert")}
      <span>${esc(text)}</span>
    </div>
  `;
}

/**
 * Render the anchored Timeline Detail Popup into `refs` and bind all interactive handlers.
 */
export function renderTimelinePopup({ refs, state, actions }) {
  const { lane, hit, activeTab, ncCtx, overview, laneEvents, fleetStore } = state;
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
        events: laneEvents,
        overview,
      })
    : null;

  // Build Segmented Tab Switcher options based on click target (Single Job always precedes Full NC)
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

  // ---- Header Hero & Tactile Status Badge ----
  let titleText = lane.name;
  let badgeObj = null;
  let heroDurMs = null;
  let subLine = "";
  let showJobSteppers = false;

  if (effectiveTab === "job" && singleJob) {
    titleText = `${lane.name} · ${singleJob.jobLabel}`;
    badgeObj = singleJob.badge;
    heroDurMs = singleJob.durMs;
    subLine = `${singleJob.programName} · ${fmtClockSecIST(singleJob.t0)} → ${singleJob.isLive ? "LIVE" : fmtClockSecIST(singleJob.t1)} IST · ${shiftLabelForTs(singleJob.t0)}`;
    showJobSteppers = !singleJob.isLive && (singleJob.prevPart || singleJob.nextPart);
  } else if (effectiveTab === "nc" && fullNc) {
    titleText = `${lane.name} · ${fullNc.programName}`;
    badgeObj = fullNc.healthBadge;
    heroDurMs = fullNc.wallMs;
    subLine = `${fullNc.totalJobs} job${fullNc.totalJobs === 1 ? "" : "s"} · ${fmtClockIST(fullNc.t0)} → ${fmtClockIST(fullNc.t1)} IST · ${fmtDayIST(fullNc.t0)}`;
  } else if (effectiveTab === "gap" && hit.type === "gap") {
    const gap = hit.data;
    titleText = `${lane.name} · ${statusLabel(gap.status)} Gap`;
    badgeObj = gap.logged
      ? healthBadgeForKind("logged")
      : healthBadgeForKind(gap.status === "alarm" ? "alarm" : gap.status === "paused" ? "paused" : "pending");
    heroDurMs = gap.durMs;
    subLine = `${fmtDayIST(gap.t0)} · ${fmtClockSecIST(gap.t0)} → ${fmtClockSecIST(gap.t1)} IST · ${shiftLabelForTs(gap.t0)}`;
  } else if (hit.type === "pin") {
    const ev = hit.data;
    titleText = `${lane.name} · Controller Event`;
    badgeObj = healthBadgeForKind(ev.sev === "CRITICAL" ? "alarm" : ev.sev === "WARNING" ? "paused" : "live");
    subLine = `${fmtDayIST(ev.ts)} · ${fmtClockSecIST(ev.ts)} IST · ${esc(ev.rule || "event")}`;
  }

  refs.drawerTitle.innerHTML = `<span class="tl2-pop-title-txt">${esc(titleText)}</span>${renderTactileBadge(badgeObj, true)}`;
  refs.drawerSub.textContent = subLine;

  const hero = heroDurMs != null ? fmtClockHero(heroDurMs) : null;
  const heroHtml = hero
    ? `
      <div class="tl2-pop-hero">
        <div class="tl2-pop-hero-clock">
          <span class="tl2-pop-hero-main">${esc(hero.main)}</span>
          ${hero.sub ? `<span class="tl2-pop-hero-sub">${esc(hero.sub)}</span>` : ""}
          <span class="tl2-pop-hero-unit">${effectiveTab === "nc" ? "run span" : (singleJob?.isLive && effectiveTab === "job" ? "elapsed" : "cycle")}</span>
        </div>
        ${showJobSteppers ? `
          <div class="tl2-pop-steppers">
            <button type="button" class="tl2-pop-step" data-pop-step="prev" ${singleJob.prevPart ? "" : "disabled"} title="Previous job in NC run" aria-label="Previous job">‹</button>
            <span class="tl2-pop-step-pos">${singleJob.chronoIdx} / ${singleJob.totalInRun}</span>
            <button type="button" class="tl2-pop-step" data-pop-step="next" ${singleJob.nextPart ? "" : "disabled"} title="Next job in NC run" aria-label="Next job">›</button>
          </div>
        ` : (effectiveTab === "nc" && fullNc ? `
          <div class="tl2-pop-hero-pillstat">
            <span>Cutting</span>
            <strong>${esc(fmtDurCompact(fullNc.cutMs))}</strong>
          </div>
        ` : (effectiveTab === "job" && singleJob?.isLive && singleJob.remainingMs != null ? `
          <div class="tl2-pop-hero-pillstat">
            <span>Remaining</span>
            <strong>${esc(fmtDurCompact(singleJob.remainingMs))}</strong>
          </div>
        ` : ""))}
      </div>
    `
    : "";

  const tabBarHtml = tabs.length > 1
    ? `
      <div class="tl2-pop-tabs" role="tablist" aria-label="Inspector view">
        ${tabs
          .map(
            (t) => `<button type="button" role="tab" aria-selected="${t.id === effectiveTab}" class="tl2-pop-tab${t.id === effectiveTab ? " is-active" : ""}" data-pop-tab="${esc(t.id)}">${esc(t.label)}</button>`,
          )
          .join("")}
      </div>
    `
    : "";

  // ---- Body Content by Active Tab ----
  let bodyContent = "";

  if (effectiveTab === "job" && singleJob) {
    const devStr = singleJob.devPct != null
      ? `${singleJob.devPct >= 0 ? "+" : ""}${singleJob.devPct}%`
      : (singleJob.isLive ? "In progress" : "—");
    const devToneClass = singleJob.statusKind === "over"
      ? "v-danger"
      : singleJob.statusKind === "high"
        ? "v-warn"
        : singleJob.statusKind === "low"
          ? "v-info"
          : "v-good";

    const meterLabel = singleJob.isLive ? "Live Cycle Progress" : "Cycle Pace Efficiency";
    const meterRight = singleJob.isLive
      ? `${singleJob.meter.pct}% elapsed`
      : `${singleJob.meter.pct}% · ${devStr}`;

    bodyContent = `
      ${renderMiniStrip(fullNc, singleJob.partKey)}
      <div class="tl2-pop-card">
        ${renderSegmentedMeter(singleJob.meter, meterLabel, meterRight)}
        ${renderRangeBar(singleJob.rangeNeedle)}
      </div>
      <div class="tl2-pop-split">
        <div class="tl2-pop-card tl2-pop-specs">
          <div class="tl2-pop-k">Job vs NC Baseline</div>
          <div class="tl2-spec-row"><span>Actual</span><strong>${esc(fmtDurCompact(singleJob.durMs))}</strong></div>
          <div class="tl2-spec-row"><span>NC Base</span><strong>${singleJob.baselineMs ? esc(fmtDurCompact(singleJob.baselineMs)) : "Pending"}</strong></div>
          <div class="tl2-spec-row"><span>Deviation</span><strong class="${devToneClass}">${esc(devStr)}</strong></div>
          <div class="tl2-spec-row"><span>Batch Rank</span><strong>${singleJob.speedRank ? `#${singleJob.speedRank} / ${singleJob.completedInRun}` : `${singleJob.chronoIdx} / ${singleJob.totalInRun}`}</strong></div>
          <div class="tl2-spec-row"><span>Pre-Gap</span><strong>${singleJob.preGapMs != null ? esc(fmtDurCompact(singleJob.preGapMs)) : "First job"}</strong></div>
          <div class="tl2-spec-row"><span>Feed / Tool</span><strong>${singleJob.feedOvrd != null ? `${singleJob.feedOvrd}%` : "—"}${singleJob.toolId ? ` · ${esc(singleJob.toolId)}` : ""}</strong></div>
        </div>
        <div class="tl2-pop-card tl2-pop-radar-card">
          <div class="tl2-pop-k">Job vs Baseline</div>
          ${renderRadarSvg(singleJob.radar, singleJob.badge.tone)}
          <div class="tl2-rad-legend">
            <span><i class="tl2-rl-job is-${esc(singleJob.badge.tone)}"></i>This Job</span>
            <span><i class="tl2-rl-base"></i>NC Base</span>
          </div>
        </div>
      </div>
      ${renderInsightStrip(singleJob.insight, singleJob.badge.tone)}
      ${singleJob.incidents.length ? `
      <div class="tl2-pop-evsec">
        <div class="tl2-pop-k">Overlapping Controller Events (${singleJob.incidents.length})</div>
        ${renderEventsList(singleJob.incidents, "")}
      </div>` : ""}
    `;
  } else if (effectiveTab === "nc" && fullNc) {
    const qTotal = Math.max(1, fullNc.completedCount);
    const qRows = [
      { label: "Nominal", count: fullNc.qualityCounts.normal, cls: "emerald" },
      { label: "Slow +15%", count: fullNc.qualityCounts.high, cls: "amber" },
      { label: "Overrun", count: fullNc.qualityCounts.over, cls: "crimson" },
      { label: "Short", count: fullNc.qualityCounts.low, cls: "cobalt" },
    ];
    const qualityBarsHtml = qRows
      .map((r) => {
        const pct = Math.round((r.count / qTotal) * 100);
        return `
          <div class="tl2-q-row">
            <span class="tl2-q-lbl">${esc(r.label)}</span>
            <span class="tl2-q-num">${r.count}</span>
            <span class="tl2-q-bar"><i class="is-${r.cls}" style="width:${r.count > 0 ? Math.max(10, pct) : 0}%"></i></span>
          </div>
        `;
      })
      .join("");

    const activeKey = ncCtx?.selectedPart ? partKeyOf(ncCtx.selectedPart) : (ncCtx?.liveMeta ? "__LIVE__" : "");
    const jobListHtml = fullNc.jobRows.length
      ? fullNc.jobRows
          .map((row) => {
            const devTxt = row.isLive
              ? "Live"
              : (row.devPct != null ? `${row.devPct >= 0 ? "+" : ""}${row.devPct}%` : "—");
            const isSel = row.id === activeKey;
            return `
              <button type="button" class="tl2-job-row${isSel ? " is-active" : ""}" data-pop-part="${esc(row.id)}">
                <span class="tl2-job-dot k-${esc(row.statusKind)}" aria-hidden="true"></span>
                <span class="tl2-job-ts">${esc(fmtClockIST(row.t0))}</span>
                <span class="tl2-job-name">${esc(row.jobLabel)}</span>
                <span class="tl2-job-dev k-${esc(row.statusKind)}">${esc(devTxt)}</span>
                <span class="tl2-job-dur">${esc(fmtDurCompact(row.durMs))}</span>
              </button>
            `;
          })
          .join("")
      : `<div class="tl2-pop-clean">No completed jobs inside this NC window.</div>`;

    bodyContent = `
      ${renderMiniStrip(fullNc, activeKey)}
      <div class="tl2-pop-card">
        ${renderSegmentedMeter(fullNc.meter, "NC Cutting Utilization", `${fullNc.utilPct}% cutting`)}
      </div>
      <div class="tl2-pop-split">
        <div class="tl2-pop-card tl2-pop-specs">
          <div class="tl2-pop-k">Full NC Batch Specs</div>
          <div class="tl2-spec-row"><span>Cutting Time</span><strong class="v-good">${esc(fmtDurCompact(fullNc.cutMs))}</strong></div>
          <div class="tl2-spec-row"><span>Inter-Gaps</span><strong>${esc(fmtDurCompact(fullNc.gapMs))}</strong></div>
          <div class="tl2-spec-row"><span>Completed</span><strong>${fullNc.completedCount} / ${fullNc.totalJobs}</strong></div>
          <div class="tl2-spec-row"><span>NC Baseline</span><strong>${fullNc.baselineMs ? esc(fmtDurCompact(fullNc.baselineMs)) : "Pending"}</strong></div>
          <div class="tl2-spec-row"><span>Median / P90</span><strong>${esc(fmtCompactClock(fullNc.medianMs))} / ${esc(fmtCompactClock(fullNc.p90Ms))}</strong></div>
        </div>
        <div class="tl2-pop-card tl2-pop-specs">
          <div class="tl2-pop-k">Cycle Health Split</div>
          ${qualityBarsHtml}
        </div>
      </div>
      ${renderInsightStrip(fullNc.insight, fullNc.healthBadge.tone)}
      <div class="tl2-pop-evsec">
        <div class="tl2-pop-strip-head">
          <span class="tl2-pop-k">All Jobs in NC Run (${fullNc.jobRows.length})</span>
          <span class="tl2-pop-strip-meta">Click row for Single Job</span>
        </div>
        <div class="tl2-job-list">${jobListHtml}</div>
      </div>
      ${fullNc.incidents.length ? `
      <div class="tl2-pop-evsec">
        <div class="tl2-pop-k">Run Incidents (${fullNc.incidents.length})</div>
        ${renderEventsList(fullNc.incidents, "")}
      </div>` : ""}
    `;
  } else if (effectiveTab === "gap" && hit.type === "gap") {
    const gap = hit.data;
    const durMin = Math.max(1, Math.round(gap.durMs / 60e3));
    const shiftLbl = shiftLabelForTs(gap.t0);
    const gapTone = gap.status === "alarm" ? "danger" : gap.status === "paused" ? "warning" : "info";
    const gapMeter = computeSegmentedMeter(Math.min(100, Math.round((durMin / 60) * 100)), gapTone, 24);
    const reasonOpts = DOWNTIME_REASONS.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("");

    const existingHtml = gap.logged
      ? `<div class="tl2-pop-card">
          <div class="tl2-pop-strip-head">
            <span class="tl2-pop-k">Logged Shop-Floor Cause</span>
            ${renderTactileBadge(healthBadgeForKind("logged"), true)}
          </div>
          <div class="tl2-spec-row"><span>Reason</span><strong>${esc(gap.logged.reason)}</strong></div>
          <div class="tl2-spec-row"><span>Duration</span><strong>${gap.logged.durationMin} min</strong></div>
          ${gap.logged.operator ? `<div class="tl2-spec-row"><span>Operator</span><strong>${esc(gap.logged.operator)}</strong></div>` : ""}
          ${gap.logged.note ? `<div class="tl2-spec-row"><span>Note</span><strong>${esc(gap.logged.note)}</strong></div>` : ""}
          <button type="button" class="tl2-btn" data-df="delGapLog" style="align-self:flex-start;margin-top:6px">Remove Logged Cause</button>
        </div>`
      : "";

    bodyContent = `
      <div class="tl2-pop-card">
        ${renderSegmentedMeter(gapMeter, `${statusLabel(gap.status)} Loss Share (of 1h)`, `${durMin} min · ${gap.logged ? "Logged" : "Unclassified"}`)}
      </div>
      ${existingHtml}
      <div class="tl2-pop-card">
        <div class="tl2-pop-k">${gap.logged ? "Log Additional Cause" : "Log Downtime Root Cause"}</div>
        <form class="tl2-form" data-df="gapForm">
          <label class="tl2-field">
            <span>Root Cause Category</span>
            <select class="tl2-select" name="reason" required>${reasonOpts}</select>
          </label>
          <div class="tl2-pop-form-row">
            <label class="tl2-field">
              <span>Duration (min)</span>
              <input class="tl2-input" type="number" name="durationMin" min="1" max="1440" value="${durMin}" required />
            </label>
            <label class="tl2-field">
              <span>Operator (optional)</span>
              <input class="tl2-input" type="text" name="operator" maxlength="60" placeholder="e.g. R. Sharma" />
            </label>
          </div>
          <label class="tl2-field">
            <span>Shop-Floor Note (optional)</span>
            <textarea class="tl2-textarea" name="note" maxlength="280" placeholder="Fixture adjustment, tool insert change, waiting for raw stock…"></textarea>
          </label>
          <button type="submit" class="tl2-submit-btn">Save to Fleet Intelligence Log</button>
        </form>
      </div>
      <div class="tl2-pop-evsec">
        <div class="tl2-pop-k">Overlapping Controller Events (${gap.events.length})</div>
        ${renderEventsList(gap.events, "No controller alarm or override events overlapped this gap.")}
      </div>
    `;
  } else if (hit.type === "pin") {
    const ev = hit.data;
    bodyContent = `
      <div class="tl2-pop-card tl2-pop-specs">
        <div class="tl2-pop-k">Controller Event Details</div>
        <div class="tl2-spec-row"><span>Severity</span><strong>${esc(ev.sev || "INFO")}</strong></div>
        <div class="tl2-spec-row"><span>Rule</span><strong>${esc(ev.rule || "event")}</strong></div>
        <div class="tl2-spec-row"><span>Time (IST)</span><strong>${esc(fmtClockSecIST(ev.ts))}</strong></div>
        <div class="tl2-spec-row"><span>Message</span><strong>${esc(ev.msg || ev.rule)}</strong></div>
      </div>
    `;
  }

  refs.drawerBody.innerHTML = `${heroHtml}${tabBarHtml}${bodyContent}`;

  // ---- Wire Interactive Handlers ----
  refs.drawerBody.querySelectorAll("[data-pop-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextTab = btn.getAttribute("data-pop-tab");
      if (nextTab) actions.switchTab(nextTab);
    });
  });

  refs.drawerBody.querySelectorAll("[data-pop-part]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const partId = btn.getAttribute("data-pop-part");
      if (partId) actions.selectPartById(partId);
    });
  });

  refs.drawerBody.querySelectorAll("[data-pop-step]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dir = btn.getAttribute("data-pop-step");
      if (dir === "prev" && singleJob?.prevPart) actions.selectPartRef(singleJob.prevPart);
      if (dir === "next" && singleJob?.nextPart) actions.selectPartRef(singleJob.nextPart);
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
        try {
          const st = await fleetStore.deleteDowntime(gap.logged.id);
          actions.onDowntimeMutated(st.downtimeLogs || []);
        } catch {
          delBtn.disabled = false;
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
