/* VMC God-mode — Fresh Multi-Color Analytical Bento KPI Console.
 *
 * Unified single-page analytical bento built 100% from real MTConnect cycles,
 * rstat execution segments, and M30 part counts:
 *   1. 5-KPI Executive Summary Strip (OEE-lite, Availability, Performance, Utilization, Parts)
 *   2. Hero Stacked Bar Overview (Time Bins | By Hour | By Day) with spotlight & floating tooltip
 *   3. 3-Column Bento: Diagonal-Striped Machine Bars · Time Mix Stadium Ring & Trend Cadence · Active Programs
 *   4. Switchable Deep-Dive: Radial-Ring Fleet Scorecard Table | Day × Hour Throughput Heatmap
 */

import {
  fleetBundle, fleetKpis, byProgram, programPeriods, byDay, byHour,
  dayHourMatrix, kpiSeries, stackedSeries, timeMixSummary,
  fmtSec, dayLabel, weekdayName,
} from "./kpiCore.js";
import { initTooltips, tipAttr } from "./tooltip.js";

const LS_KPI_SNAP = "vmc_kpi_snap_v2";
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
const PROGRAM_PALETTE = ["#3b82f6", "#22c55e", "#f59e0b", "#f472b6", "#8b5cf6", "#06b6d4"];

const fmtPct = (v) => (v == null || !isFinite(v) ? "—" : `${v.toFixed(1).replace(/\.0$/, "")}%`);
const fmtPctInt = (v) => (v == null || !isFinite(v) ? "—" : `${Math.round(v)}%`);

function fmtHours(ms) {
  if (!ms || ms <= 0) return "0m";
  const hrs = ms / 3600000;
  if (hrs >= 10) return `${hrs.toFixed(0)}h`;
  if (hrs >= 1) return `${hrs.toFixed(1)}h`;
  return `${Math.max(1, Math.round(ms / 60000))}m`;
}

function deltaInfo(now, was, unit = "pts", invertGood = false) {
  if (now == null || was == null) return { text: "", cls: "is-flat" };
  const d = now - was;
  if (Math.abs(d) < 0.05) return { text: "0", cls: "is-flat" };
  const up = d > 0;
  const good = invertGood ? !up : up;
  const valStr = unit === "parts" ? String(Math.abs(Math.round(d))) : `${Math.abs(d).toFixed(1)} ${unit}`;
  return {
    text: `${up ? "▲" : "▼"} ${up ? "+" : "-"}${valStr}`,
    cls: good ? "is-up" : "is-down",
  };
}

function loadKpiSnap() {
  try {
    const raw = localStorage.getItem(LS_KPI_SNAP);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : {};
  } catch (_) { return {}; }
}

function saveKpiSnap(map) {
  try {
    const json = JSON.stringify(map);
    if (json.length > 2_000_000) return;
    localStorage.setItem(LS_KPI_SNAP, json);
  } catch (_) {}
}

export function mountKpi(body, dataLayer) {
  body.innerHTML = `
    <div class="kb-root" data-f="root"></div>
    <p class="ds-note" data-f="note" role="status" aria-live="polite" hidden></p>`;
  const refs = {};
  body.querySelectorAll("[data-f]").forEach((n) => { refs[n.dataset.f] = n; });
  initTooltips(body);

  const snapMap = loadKpiSnap();
  let token = 0;

  // Interactive UI state (zero-network instant updates)
  const ui = {
    chartMode: "bins",      // "bins" | "hour" | "day"
    selectedMachine: null,  // null | uppercase machine ID
    activeBarIdx: null,     // null -> defaults to peak column
    bottomTab: "audit",     // "audit" | "heatmap"
  };

  let lastData = null;      // { curB, prevB, win, span, colorMap }

  function assignColors(perMachine) {
    const map = new Map();
    const sortedIds = perMachine.map((p) => String(p.id).toUpperCase()).sort();
    sortedIds.forEach((id, i) => map.set(id, MACHINE_PALETTE[i % MACHINE_PALETTE.length]));
    return map;
  }

  function paintFromSnap(win) {
    const html = snapMap[win.key];
    if (html && !lastData) {
      refs.root.innerHTML = html;
      refs.note.hidden = true;
      return true;
    }
    return false;
  }

  function cacheRender(win) {
    if (!ui.selectedMachine && ui.chartMode === "bins" && ui.bottomTab === "audit") {
      snapMap[win.key] = refs.root.innerHTML;
      saveKpiSnap(snapMap);
    }
  }

  function paintBento() {
    if (!lastData) return;
    const { curB, prevB, win, colorMap } = lastData;

    const filterId = ui.selectedMachine;
    const curMachines = filterId
      ? curB.perMachine.filter((p) => String(p.id).toUpperCase() === filterId)
      : curB.perMachine;
    const prevMachines = filterId
      ? prevB.perMachine.filter((p) => String(p.id).toUpperCase() === filterId)
      : prevB.perMachine;
    const activeCycles = filterId
      ? curB.cycles.filter((c) => String(c.machine).toUpperCase() === filterId)
      : curB.cycles;

    const now = fleetKpis(curMachines);
    const was = fleetKpis(prevMachines);

    const stacked = stackedSeries(activeCycles, curB.perMachine, win, ui.chartMode);
    if (ui.activeBarIdx == null || ui.activeBarIdx >= stacked.cols.length) {
      ui.activeBarIdx = stacked.peakIdx;
    }

    const mix = timeMixSummary(curMachines);
    const progs = byProgram(activeCycles);
    const periods = programPeriods(activeCycles, win);
    const periodMap = new Map(periods.map((p) => [p.program, p]));
    const trendSer = kpiSeries(activeCycles, win, 24);
    const days = byDay(activeCycles);
    const hours = byHour(activeCycles);
    const mat = dayHourMatrix(activeCycles);

    const filterBanner = filterId ? (() => {
      const mObj = curB.perMachine.find((p) => String(p.id).toUpperCase() === filterId);
      const col = colorMap.get(filterId) || "#3b82f6";
      return `<div class="kb-filter-bar">
        <span class="kb-filter-left"><span class="kb-filter-swatch" style="background:${col}"></span>Focused on <strong>${escapeHtml(mObj ? mObj.name : filterId)}</strong> — all metrics &amp; charts filtered</span>
        <button type="button" class="kb-clear-btn" data-kb-clear="1">Show full fleet</button>
      </div>`;
    })() : "";

    refs.root.innerHTML = [
      filterBanner,
      renderSummaryStrip(now, was, win),
      renderHeroStacked(stacked, curB.perMachine, colorMap, ui),
      `<div class="kb-bento3">
        ${renderMachinePerfCard(curB.perMachine, prevB.perMachine, colorMap, ui)}
        ${renderTimeMixCard(mix, trendSer, hours, days, win)}
        ${renderProgramsCard(progs, periodMap, activeCycles.length)}
      </div>`,
      renderDeepDiveCard(curB.perMachine, prevB.perMachine, colorMap, mat, days, hours, activeCycles.length, win, ui),
    ].join("");

    wireInteractions(refs.root, stacked, colorMap);
  }

  function wireInteractions(root, stacked, colorMap) {
    // Clear single-machine filter
    const clearBtn = root.querySelector("[data-kb-clear]");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        ui.selectedMachine = null;
        ui.activeBarIdx = null;
        paintBento();
      });
    }

    // Stacked chart mode switch
    root.querySelectorAll("[data-kb-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.kbMode;
        if (mode === ui.chartMode) return;
        ui.chartMode = mode;
        ui.activeBarIdx = null;
        paintBento();
      });
    });

    // Machine cross-filter (legend chips, performance bars, audit table rows)
    root.querySelectorAll("[data-kb-machine]").forEach((el) => {
      el.addEventListener("click", () => {
        const id = String(el.dataset.kbMachine || "").toUpperCase();
        if (!id) return;
        ui.selectedMachine = ui.selectedMachine === id ? null : id;
        ui.activeBarIdx = null;
        paintBento();
      });
    });

    // Bottom panel switch (Fleet Scorecard Table vs Day x Hour Heatmap)
    root.querySelectorAll("[data-kb-bottom]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const next = btn.dataset.kbBottom;
        if (next === ui.bottomTab) return;
        ui.bottomTab = next;
        paintBento();
      });
    });

    // Spotlight bar hover/click + live tooltip repositioning without full DOM rebuild
    const cols = root.querySelectorAll("[data-kb-col]");
    const tipEl = root.querySelector("#kbStackTip");
    const stageEl = root.querySelector("#kbStackStage");

    function updateSpotlight(idx) {
      if (idx < 0 || idx >= stacked.cols.length) return;
      ui.activeBarIdx = idx;
      cols.forEach((c) => c.classList.toggle("is-spot", Number(c.dataset.kbCol) === idx));
      if (!tipEl || !stageEl) return;
      const colData = stacked.cols[idx];
      tipEl.innerHTML = buildTooltipHTML(colData, colorMap);
      positionTooltip(tipEl, stageEl, idx, stacked.cols.length);
    }

    cols.forEach((colEl) => {
      const idx = Number(colEl.dataset.kbCol);
      colEl.addEventListener("mouseenter", () => updateSpotlight(idx));
      colEl.addEventListener("click", () => updateSpotlight(idx));
    });

    if (tipEl && stageEl && stacked.cols.length) {
      positionTooltip(tipEl, stageEl, ui.activeBarIdx, stacked.cols.length);
    }
  }

  async function refresh() {
    if (document.hidden) return;
    const my = ++token;
    const current = () => my === token;

    const win0 = dataLayer.resolveWindow();
    const hadSnap = paintFromSnap(win0);
    if (!hadSnap && !lastData) {
      refs.root.innerHTML = `<div class="kb-skel"></div><div class="kb-skel" style="height:280px"></div>`;
    }

    let ov;
    try { ov = await dataLayer.overview(); }
    catch (err) {
      if (current() && !hadSnap && !lastData) {
        const isTimeout = err.name === "AbortError" || (err.message && err.message.includes("aborted"));
        note(refs, isTimeout ? "Computing fleet KPIs — collector is slow, please wait…" : "Collector unreachable — cannot fetch machine list.");
      }
      return;
    }
    if (!current()) return;

    const machines = Array.isArray(ov.machines) ? ov.machines : [];
    if (!machines.length) {
      if (current() && !hadSnap) note(refs, "No machines reported by the collector.");
      return;
    }
    refs.note.hidden = true;

    const win = dataLayer.resolveWindow();
    const span = win.to - win.from;
    const prevWin = { key: win.key, label: "prev", from: win.from - span, to: win.from };

    try {
      const [curB, prevB] = await Promise.all([
        fleetBundle(dataLayer, machines, win),
        fleetBundle(dataLayer, machines, prevWin),
      ]);
      if (!current()) return;

      const colorMap = assignColors(curB.perMachine);
      if (ui.selectedMachine && !colorMap.has(ui.selectedMachine)) {
        ui.selectedMachine = null;
      }
      lastData = { curB, prevB, win, span, colorMap };
      paintBento();
      cacheRender(win);
    } catch (err) {
      if (current() && !lastData) {
        const isTimeout = err.name === "AbortError" || (err.message && err.message.includes("aborted"));
        note(refs, isTimeout ? "Computing KPI data — endpoints are slow, still loading…" : "Failed to compute KPI data — " + (err.message || "unknown error"));
      }
    }
  }

  return { refresh };
}

function note(refs, msg) {
  refs.note.textContent = msg;
  refs.note.hidden = false;
}

/* =================================================== ZONE 1: 5-KPI SUMMARY */

function renderSummaryStrip(now, was, win) {
  const items = [
    {
      label: "Fleet OEE-lite",
      color: "#3b82f6",
      val: fmtPct(now.oee),
      delta: deltaInfo(now.oee, was.oee, "pts"),
      foot: was.oee != null ? `Prev ${fmtPct(was.oee)} · ${win.label}` : `Availability × Performance`,
      tip: "Overall Equipment Effectiveness (lite) = Availability × Performance from real rstat logs and M30 cycles.",
    },
    {
      label: "Availability",
      color: "#22c55e",
      val: fmtPct(now.avail),
      delta: deltaInfo(now.avail, was.avail, "pts"),
      foot: was.avail != null ? `Prev ${fmtPct(was.avail)} · attended share` : "Run vs attended time",
      tip: "Share of attended time machines were actively cutting (run ÷ run+pause+idle).",
    },
    {
      label: "Performance",
      color: "#f59e0b",
      val: fmtPct(now.perf),
      delta: deltaInfo(now.perf, was.perf, "pts"),
      foot: was.perf != null ? `Prev ${fmtPct(was.perf)} · vs p10 pace` : "Cycle speed vs p10 best",
      tip: "How close cycle times stay to each job's best-case (p10) pace.",
    },
    {
      label: "Utilization",
      color: "#8b5cf6",
      val: fmtPct(now.util),
      delta: deltaInfo(now.util, was.util, "pts"),
      foot: `${fmtHours(now.runMs)} cutting in ${win.label}`,
      tip: "Spindle cutting time as a share of the entire wall-clock window.",
    },
    {
      label: "Parts Produced",
      color: "#f472b6",
      val: String(now.parts || 0),
      delta: deltaInfo(now.parts, was.parts, "parts"),
      foot: `Prev ${was.parts || 0} parts · ${win.label}`,
      tip: "Completed M30 cycles across the selected fleet and time window.",
    },
  ];

  return `<section class="kb-card kb-strip">
    ${items.map((it) => `
      <div class="kb-kpi-cell" data-tip-title="${tipAttr(it.label)}" data-tip="${tipAttr(it.tip)}">
        <div class="kb-kpi-head">
          <span class="kb-kpi-tick" style="background:${it.color}"></span>
          <span>${it.label}</span>
        </div>
        <div class="kb-kpi-main">
          <span class="kb-kpi-val">${it.val}</span>
          ${it.delta.text ? `<span class="kb-delta ${it.delta.cls}">${it.delta.text}</span>` : ""}
        </div>
        <div class="kb-kpi-foot">${it.foot}</div>
      </div>`).join("")}
  </section>`;
}

/* ========================================== ZONE 2: HERO STACKED BAR CHART */

function renderHeroStacked(stacked, perMachine, colorMap, ui) {
  const modeBtns = [
    { id: "bins", label: "Time Bins" },
    { id: "hour", label: "By Hour" },
    { id: "day", label: "By Day" },
  ].map((m) => `<button type="button" class="kb-seg-btn ${ui.chartMode === m.id ? "is-active" : ""}" data-kb-mode="${m.id}">${m.label}</button>`).join("");

  const legend = perMachine.map((p) => {
    const id = String(p.id).toUpperCase();
    const col = colorMap.get(id) || "#3b82f6";
    const isSel = ui.selectedMachine === id;
    const isDim = ui.selectedMachine && !isSel;
    return `<button type="button" class="kb-leg-btn ${isSel ? "is-active" : ""} ${isDim ? "is-dim" : ""}" data-kb-machine="${escapeHtml(id)}" title="Click to focus on ${escapeHtml(p.name)}">
      <span class="kb-swatch" style="background:${col}"></span>
      <span>${escapeHtml(p.name)}</span>
    </button>`;
  }).join("");

  if (!stacked.cols.length || stacked.maxTotal === 0) {
    return `<section class="kb-card kb-hero">
      <div class="kb-card-head">
        <div class="kb-card-title-wrap">
          <h3 class="kb-card-title">Production &amp; Fleet Breakdown</h3>
          <span class="kb-card-sub">Stacked completed parts attributed by machine</span>
        </div>
        <div class="kb-seg">${modeBtns}</div>
      </div>
      <div class="kb-legend">${legend}</div>
      <div class="kb-empty">No completed parts in this window. Try expanding the time window above.</div>
    </section>`;
  }

  const maxY = niceCeil(stacked.maxTotal);
  const ticks = [maxY, Math.round(maxY * 0.75), Math.round(maxY * 0.5), Math.round(maxY * 0.25), 0];

  const barsHtml = stacked.cols.map((col, idx) => {
    const isSpot = idx === ui.activeBarIdx;
    const colPct = maxY > 0 ? (col.total / maxY) * 100 : 0;
    const pieces = col.byMachine.map((m, sIdx) => {
      const segPct = col.total > 0 ? (m.count / col.total) * 100 : 0;
      const color = colorMap.get(m.id) || "#3b82f6";
      return `<span class="kb-seg-piece ${sIdx === 0 ? "is-hatched" : ""}" style="height:${segPct.toFixed(2)}%;background:${color}"></span>`;
    }).join("");

    return `<div class="kb-col ${isSpot ? "is-spot" : ""}" data-kb-col="${idx}">
      <div class="kb-stack-track">
        ${col.total > 0 ? `<div class="kb-stack" style="height:${Math.max(4, colPct).toFixed(2)}%">${pieces}</div>` : ""}
      </div>
      <span class="kb-col-x">${escapeHtml(col.label)}</span>
    </div>`;
  }).join("");

  const spotCol = stacked.cols[ui.activeBarIdx] || stacked.cols[0];

  return `<section class="kb-card kb-hero">
    <div class="kb-card-head">
      <div class="kb-card-title-wrap">
        <h3 class="kb-card-title">Production &amp; Fleet Breakdown</h3>
        <span class="kb-card-sub">Hover any column to inspect per-machine output · click a machine to focus</span>
      </div>
      <div class="kb-seg">${modeBtns}</div>
    </div>
    <div class="kb-legend">${legend}</div>
    <div class="kb-chart-wrap">
      <div class="kb-yaxis">${ticks.map((t) => `<span>${t}</span>`).join("")}</div>
      <div class="kb-stage" id="kbStackStage">
        <div class="kb-gridlines"><span></span><span></span><span></span><span></span><span></span></div>
        <div class="kb-bars">${barsHtml}</div>
        <div class="kb-tooltip" id="kbStackTip">${buildTooltipHTML(spotCol, colorMap)}</div>
      </div>
    </div>
  </section>`;
}

function buildTooltipHTML(col, colorMap) {
  if (!col) return "";
  const rows = col.byMachine
    .slice()
    .sort((a, b) => b.count - a.count)
    .map((m) => {
      const color = colorMap.get(m.id) || "#3b82f6";
      return `<div class="kb-tip-row">
        <span class="kb-tip-tick" style="background:${color}"></span>
        <span class="kb-tip-name">${escapeHtml(m.name)}</span>
        <span class="kb-tip-val">${m.count}</span>
        <span class="kb-tip-cyc">${fmtSec(m.median)}</span>
      </div>`;
    }).join("");

  return `<div class="kb-tip-head">
      <span class="kb-tip-title">${escapeHtml(col.fullLabel)}</span>
      <span class="kb-tip-tot">${col.total} parts</span>
    </div>
    <div class="kb-tip-list">${rows || `<span class="kb-tip-name">No completions in slice</span>`}</div>`;
}

function positionTooltip(tipEl, stageEl, idx, totalCols) {
  if (!totalCols) return;
  const stageW = stageEl.clientWidth || 600;
  const tipW = tipEl.offsetWidth || 210;
  const colCenter = ((idx + 0.5) / totalCols) * stageW;
  let left = colCenter + 26;
  if (left + tipW > stageW - 8) {
    left = colCenter - tipW - 26;
  }
  left = Math.max(8, Math.min(stageW - tipW - 8, left));
  tipEl.style.left = `${Math.round(left)}px`;
}

/* ======================================= ZONE 3: 3-COLUMN ANALYTICAL BENTO */

function renderMachinePerfCard(curPerMachine, prevPerMachine, colorMap, ui) {
  const prevById = new Map(prevPerMachine.map((p) => [String(p.id).toUpperCase(), p.x ? p.x.oee : null]));
  const rows = curPerMachine.map((p) => {
    const id = String(p.id).toUpperCase();
    const oee = p.x ? p.x.oee : null;
    const prev = prevById.get(id);
    return {
      id,
      name: p.name,
      online: p.online,
      oee,
      parts: p.x ? p.x.parts : 0,
      delta: deltaInfo(oee, prev, "pts"),
      color: colorMap.get(id) || "#3b82f6",
    };
  }).sort((a, b) => (b.oee ?? -1) - (a.oee ?? -1));

  return `<section class="kb-card">
    <div class="kb-card-head">
      <div class="kb-card-title-wrap">
        <h3 class="kb-card-title">Machine Performance</h3>
        <span class="kb-card-sub">Ranked OEE-lite with period delta</span>
      </div>
    </div>
    <div class="kb-perf-list">
      ${rows.map((r) => {
        const isSel = ui.selectedMachine === r.id;
        const isDim = ui.selectedMachine && !isSel;
        const w = r.oee == null ? 0 : Math.max(3, Math.min(100, r.oee));
        return `<div class="kb-perf-row ${isSel ? "is-active" : ""} ${isDim ? "is-dim" : ""}" data-kb-machine="${escapeHtml(r.id)}" data-tip-title="${tipAttr(`${r.name} · ${fmtPct(r.oee)} OEE`)}" data-tip="${tipAttr(`${r.parts} parts completed. Click to focus all charts on ${r.name}.`)}">
          <div class="kb-perf-top">
            <span class="kb-perf-name">
              <span class="kb-swatch" style="background:${r.color}"></span>
              <span>${escapeHtml(r.name)}</span>
              <span class="kb-perf-state ${r.online ? "" : "is-off"}">${r.online ? `${r.parts} pcs` : "Offline"}</span>
            </span>
            <span class="kb-perf-nums">
              <span class="kb-perf-val">${fmtPctInt(r.oee)}</span>
              ${r.delta.text ? `<span class="kb-delta ${r.delta.cls}">${r.delta.text}</span>` : ""}
            </span>
          </div>
          <div class="kb-stripe-track">
            <div class="kb-stripe-fill" style="width:${w.toFixed(1)}%;background-color:${r.color}"></div>
          </div>
        </div>`;
      }).join("")}
    </div>
  </section>`;
}

function renderTimeMixCard(mix, trendSer, hours, days, win) {
  // Segmented rounded stadium pill-ring SVG (path perimeter ~ 328.5)
  // Stadium path: M 45 12 H 111 A 34 34 0 0 1 111 80 H 45 A 34 34 0 0 1 45 12 Z
  const perim = 2 * 66 + 2 * Math.PI * 34; // ~345.63
  const nonZero = mix.items.filter((it) => it.pct >= 0.6);
  const gap = nonZero.length > 1 ? 5 : 0;
  let offset = 0;

  const arcs = nonZero.map((it) => {
    const rawLen = (it.pct / 100) * perim;
    const segLen = Math.max(2, rawLen - gap);
    const dashArray = `${segLen.toFixed(2)} ${(perim - segLen).toFixed(2)}`;
    const dashOffset = (-offset).toFixed(2);
    offset += rawLen;
    return `<path d="M 45 12 H 111 A 34 34 0 0 1 111 80 H 45 A 34 34 0 0 1 45 12 Z"
      fill="none" stroke="${it.color}" stroke-width="14" stroke-linecap="butt"
      stroke-dasharray="${dashArray}" stroke-dashoffset="${dashOffset}" />`;
  }).join("");

  const runItem = mix.items[0];
  const runPct = runItem ? Math.round(runItem.pct) : 0;

  // Cadence micro-bars (24 window slices colored by intensity)
  const pts = trendSer.pts || [];
  const maxBin = Math.max(...pts.map((p) => p.parts), 1);
  const cadenceHtml = pts.map((p, i) => {
    const ratio = p.parts / maxBin;
    const h = p.parts > 0 ? Math.max(12, Math.round(ratio * 100)) : 8;
    const color = i < 8 ? "#22c55e" : i < 16 ? "#f59e0b" : "#3b82f6";
    const opacity = p.parts > 0 ? (0.45 + ratio * 0.55).toFixed(2) : "0.18";
    return `<span class="kb-cbar" style="height:${h}%;background:${color};opacity:${opacity}" data-tip-title="${tipAttr(new Date(p.t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }))}" data-tip="${tipAttr(`${p.parts} parts · median ${fmtSec(p.median)}`)}"></span>`;
  }).join("");

  const pSlope = trendSer.partsSlopePerH;
  const cSlope = trendSer.medSlopePerH;
  const pVerdict = pSlope == null ? "—" : pSlope > 0.05 ? "▲ Improving" : pSlope < -0.05 ? "▼ Slipping" : "→ Holding";
  const pCls = pSlope == null ? "is-flat" : pSlope > 0.05 ? "is-up" : pSlope < -0.05 ? "is-down" : "is-flat";
  const cVerdict = cSlope == null ? "—" : cSlope < -0.3 ? "▼ Faster" : cSlope > 0.3 ? "▲ Slower" : "→ Steady";
  const cCls = cSlope == null ? "is-flat" : cSlope < -0.3 ? "is-up" : cSlope > 0.3 ? "is-down" : "is-flat";
  const peakHour = hours.slice().sort((a, b) => b.parts - a.parts)[0];
  const peakStr = peakHour && peakHour.parts > 0 ? hourLabel(peakHour.hour) : "—";

  return `<section class="kb-card">
    <div class="kb-card-head">
      <div class="kb-card-title-wrap">
        <h3 class="kb-card-title">Fleet Time Mix</h3>
        <span class="kb-card-sub">Execution states &amp; throughput trend (${win.label})</span>
      </div>
    </div>
    <div class="kb-mix-wrap">
      <svg class="kb-stadium-svg" viewBox="0 0 156 92" aria-label="Fleet execution state mix">
        <path d="M 45 12 H 111 A 34 34 0 0 1 111 80 H 45 A 34 34 0 0 1 45 12 Z"
          fill="none" stroke="var(--kb-track)" stroke-width="14" />
        ${arcs}
        <text x="78" y="45" text-anchor="middle" class="kb-stadium-pct">${runPct}%</text>
        <text x="78" y="60" text-anchor="middle" class="kb-stadium-sub">Cutting</text>
      </svg>
      <div class="kb-mix-legend">
        ${mix.items.map((it) => `
          <div class="kb-mix-row">
            <span class="kb-swatch" style="background:${it.color}"></span>
            <span class="kb-mix-lbl">${it.label}</span>
            <span class="kb-mix-val">${Math.round(it.pct)}%</span>
            <span class="kb-mix-hrs">${fmtHours(it.ms)}</span>
          </div>`).join("")}
      </div>
    </div>
    <div class="kb-cadence-block">
      <div class="kb-cadence-head">
        <span>Throughput Cadence</span>
        <span class="kb-card-sub">${days.length} active day${days.length === 1 ? "" : "s"}</span>
      </div>
      <div class="kb-cadence-bars">${cadenceHtml}</div>
      <div class="kb-verdict-row">
        <div class="kb-verdict-item"><span class="kb-verdict-k">Output slope</span><span class="kb-verdict-v kb-delta ${pCls}">${pVerdict}</span></div>
        <div class="kb-verdict-item"><span class="kb-verdict-k">Cycle pace</span><span class="kb-verdict-v kb-delta ${cCls}">${cVerdict}</span></div>
        <div class="kb-verdict-item"><span class="kb-verdict-k">Peak hour</span><span class="kb-verdict-v">${peakStr}</span></div>
      </div>
    </div>
  </section>`;
}

function renderProgramsCard(progs, periodMap, totalParts) {
  const top = progs.slice(0, 6);
  const shareBar = top.length ? `<div class="kb-share-bar">
    ${top.map((p, i) => `<span class="kb-share-seg" style="width:${(p.share * 100).toFixed(2)}%;background:${PROGRAM_PALETTE[i % PROGRAM_PALETTE.length]}" data-tip-title="${tipAttr(p.program)}" data-tip="${tipAttr(`${p.n} parts · ${(p.share * 100).toFixed(1)}% of cutting time`)}"></span>`).join("")}
  </div>` : "";

  const rowsHtml = top.length ? top.map((p, i) => {
    const color = PROGRAM_PALETTE[i % PROGRAM_PALETTE.length];
    const per = periodMap.get(p.program);
    let driftHtml = `<span class="kb-delta is-flat">stable</span>`;
    if (per && Math.abs(per.deltaPct) >= 1.5) {
      const faster = per.deltaPct < 0;
      driftHtml = `<span class="kb-delta ${faster ? "is-up" : "is-down"}" data-tip-title="1st half vs 2nd half" data-tip="${tipAttr(`1st half ${fmtSec(per.firstMed)} → 2nd half ${fmtSec(per.secondMed)}`)}">${faster ? "▼" : "▲"} ${Math.abs(per.deltaPct).toFixed(1)}%</span>`;
    }
    const cvStr = p.cv != null ? `CV ${(p.cv * 100).toFixed(0)}%` : "CV —";
    return `<div class="kb-prog-row">
      <div class="kb-prog-top">
        <span class="kb-prog-name" title="${escapeHtml(p.program)}">
          <span class="kb-swatch" style="background:${color}"></span>
          <span>${escapeHtml(p.program)}</span>
        </span>
        <span class="kb-prog-parts">${p.n} pcs · ${(p.share * 100).toFixed(0)}%</span>
      </div>
      <div class="kb-prog-meta">
        <span>Med ${fmtSec(p.median)} · Best ${fmtSec(p.p10)} · ${cvStr}</span>
        ${driftHtml}
      </div>
    </div>`;
  }).join("") : `<div class="kb-empty">No program cycles completed in this window.</div>`;

  return `<section class="kb-card">
    <div class="kb-card-head">
      <div class="kb-card-title-wrap">
        <h3 class="kb-card-title">Active Programs &amp; Drift</h3>
        <span class="kb-card-sub">${progs.length} program${progs.length === 1 ? "" : "s"} · ${totalParts} parts</span>
      </div>
    </div>
    ${shareBar}
    <div class="kb-prog-list">${rowsHtml}</div>
  </section>`;
}

/* ======================================= ZONE 4: DEEP-DIVE TABLE & HEATMAP */

function renderDeepDiveCard(curPerMachine, prevPerMachine, colorMap, mat, days, hours, totalParts, win, ui) {
  const prevById = new Map(prevPerMachine.map((p) => [String(p.id).toUpperCase(), p.x ? p.x.oee : null]));
  const tabs = `
    <div class="kb-seg">
      <button type="button" class="kb-seg-btn ${ui.bottomTab === "audit" ? "is-active" : ""}" data-kb-bottom="audit">Fleet Scorecard</button>
      <button type="button" class="kb-seg-btn ${ui.bottomTab === "heatmap" ? "is-active" : ""}" data-kb-bottom="heatmap">Day × Hour Heatmap</button>
    </div>`;

  let bodyHtml = "";
  if (ui.bottomTab === "heatmap") {
    const bestDay = days.slice().sort((a, b) => b.parts - a.parts)[0];
    const peakHour = hours.slice().sort((a, b) => b.parts - a.parts)[0];
    if (!mat.days.length) {
      bodyHtml = `<div class="kb-empty">No completed cycles to plot by day and hour yet.</div>`;
    } else {
      bodyHtml = `
        <div class="kb-heat-callouts">
          <div class="kb-hc-item">
            <span class="kb-hc-k">Best day</span>
            <span class="kb-hc-v">${bestDay ? dayLabel(bestDay.day) : "—"}</span>
            <span class="kb-hc-sub">${bestDay ? `${bestDay.parts} parts · ${fmtSec(bestDay.median)} med` : ""}</span>
          </div>
          <div class="kb-hc-item">
            <span class="kb-hc-k">Peak hour</span>
            <span class="kb-hc-v">${peakHour && peakHour.parts ? hourLabel(peakHour.hour) : "—"}</span>
            <span class="kb-hc-sub">${peakHour ? `${peakHour.parts} parts across window` : ""}</span>
          </div>
          <div class="kb-hc-item">
            <span class="kb-hc-k">Active days</span>
            <span class="kb-hc-v">${days.length}</span>
            <span class="kb-hc-sub">${totalParts} completed cycles</span>
          </div>
        </div>
        <div class="kb-heat-grid">
          <div></div>
          ${Array.from({ length: 24 }, (_, h) => `<div class="kb-heat-hh">${h % 3 === 0 ? h : ""}</div>`).join("")}
          ${mat.days.map((d) => `
            <div class="kb-heat-day">${dayLabel(d).replace(/,.*/, "")}</div>
            ${mat.grid.get(d).map((v, h) => {
              const a = mat.max ? v / mat.max : 0;
              return `<div class="kb-heat-cell" style="background:${heatColor(a)}" data-tip-title="${tipAttr(`${dayLabel(d)} · ${hourLabel(h)}`)}" data-tip="${tipAttr(`${v} part${v === 1 ? "" : "s"} completed`)}"></div>`;
            }).join("")}`).join("")}
        </div>`;
    }
  } else {
    const ranked = curPerMachine.slice().sort((a, b) => ((b.x && b.x.oee) ?? -1) - ((a.x && a.x.oee) ?? -1));
    const rows = ranked.map((p) => {
      const id = String(p.id).toUpperCase();
      const x = p.x || {};
      const color = colorMap.get(id) || "#3b82f6";
      const prevOee = prevById.get(id);
      const d = deltaInfo(x.oee, prevOee, "pts");
      const isDim = ui.selectedMachine && ui.selectedMachine !== id;
      return `<tr class="${isDim ? "is-dim" : ""}" data-kb-machine="${escapeHtml(id)}">
        <td>
          <div class="kb-tbl-mc">
            <span class="kb-swatch" style="background:${color}"></span>
            <div>
              <span class="kb-tbl-mc-name">${escapeHtml(p.name)}</span>
              <span class="kb-tbl-mc-sub">${p.online ? "Online" : "Offline"} · ${fmtHours(x.buckets ? x.buckets.run : 0)} cutting</span>
            </div>
          </div>
        </td>
        <td>${radialRing(x.oee)}</td>
        <td>${miniBar(x.availability, "#22c55e")}</td>
        <td>${miniBar(x.performance, "#f59e0b")}</td>
        <td>${miniBar(x.utilization, "#8b5cf6")}</td>
        <td class="num"><strong>${x.parts || 0}</strong></td>
        <td class="num">${fmtSec(x.cstats ? x.cstats.median : null)}</td>
        <td class="num"><span class="kb-delta ${d.cls}">${d.text || "—"}</span></td>
      </tr>`;
    }).join("");

    bodyHtml = `<div class="kb-table-wrap">
      <table class="kb-table">
        <thead>
          <tr>
            <th>Machine</th>
            <th>OEE Score</th>
            <th>Availability</th>
            <th>Performance</th>
            <th>Utilization</th>
            <th class="num">Parts</th>
            <th class="num">Median Cycle</th>
            <th class="num">vs Prev ${escapeHtml(win.label)}</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="8" class="kb-empty">No machines reported.</td></tr>`}</tbody>
      </table>
    </div>`;
  }

  return `<section class="kb-card kb-deep">
    <div class="kb-card-head">
      <div class="kb-card-title-wrap">
        <h3 class="kb-card-title">${ui.bottomTab === "heatmap" ? "Day × Hour Throughput Matrix" : "Fleet Scorecard Breakdown"}</h3>
        <span class="kb-card-sub">${ui.bottomTab === "heatmap" ? "Real M30 completions bucketed by local day and hour" : "Click any row to isolate that machine across all charts"}</span>
      </div>
      ${tabs}
    </div>
    ${bodyHtml}
  </section>`;
}

function radialRing(val) {
  const pct = val == null ? 0 : Math.max(0, Math.min(100, val));
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

function miniBar(val, color) {
  const pct = val == null ? 0 : Math.max(0, Math.min(100, val));
  return `<div class="kb-mini-metric">
    <span class="kb-mini-track"><span class="kb-mini-fill" style="width:${pct.toFixed(1)}%;background:${color}"></span></span>
    <span class="kb-mini-val">${fmtPctInt(val)}</span>
  </div>`;
}

function niceCeil(n) {
  if (n <= 4) return 4;
  if (n <= 10) return Math.ceil(n / 2) * 2;
  const mag = Math.pow(10, Math.floor(Math.log10(n)));
  const norm = n / mag;
  const step = norm <= 1.2 ? 1.2 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return Math.ceil(n / (step * mag / 4)) * (step * mag / 4);
}

function hourLabel(h) {
  const ap = h < 12 ? "am" : "pm";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${ap}`;
}

function heatColor(a) {
  if (a <= 0) return "var(--kb-track)";
  if (a < 0.25) return "rgba(59, 130, 246, 0.28)";
  if (a < 0.5) return "rgba(59, 130, 246, 0.52)";
  if (a < 0.75) return "rgba(99, 102, 241, 0.78)";
  return "#3b82f6";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
