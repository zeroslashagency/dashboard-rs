/* VMC Fleet Intelligence — Unified Maintenance & Statistics Workspace
 *
 * Dual-reference visual system (Ref 1 Soft Gradient Story Charts + Ref 2
 * Modular 4+4+3 KPI Widget Grid) with native Dark/Light mode support,
 * obsidian hover callouts, inline repair checkboxes, machine cross-filtering,
 * and server-backed Shop-Floor Log Drawer.
 */

import {
  health,
  predict,
  rollup,
  recordDaily,
  timeline,
  WEAR_WARN,
  WEAR_LIMIT,
  fmtHours,
} from "./maintCore.js";
import {
  DOWNTIME_REASONS,
  SHIFT_DEFS,
  shiftOfTs,
  normalizeProgramName,
  summarizeCycles,
  buildProgramMatrix,
  groupCyclesByShift,
  computeHistogramBins,
  summarizeDowntimeAccountability,
  computeReliabilityComparison,
  computeProductionProgress,
  fmtDurShort,
  fmtClockMMSS,
} from "./fleetCore.js";
import { fleetStore } from "./fleetStoreClient.js";
import {
  svgArcGauge,
  svgSparkBars,
  svgHalfDonut,
  svgAreaLine,
  svgHealthRadar,
  svgPairedBars,
  svgGradientHistogram,
  svgConnectedStacks,
  svgSquareScatter,
  svgGapDonut,
  svgMiniAreaSpark,
} from "./fleetCharts.js";

const SUBTABS = [
  { id: "overview", label: "Overview" },
  { id: "programs", label: "Programs & Cycles" },
  { id: "downtime", label: "Downtime & Reasons" },
  { id: "reliability", label: "Reliability & Repairs" },
  { id: "predictive", label: "Predictive & Log" },
];

const SUB_KEY = "vmc_fleet_sub";
const SEV_RANK = { warn: 2, soon: 1, info: 0, ok: 0 };

const CTRL_COLORS = {
  IDLE: "#60a5fa",
  "FEED-HOLD": "#f59e0b",
  ALARM: "#f43f5e",
  "E-STOP": "#dc2626",
  OTHER: "#c084fc",
};

const SERIES_PALETTE = [
  { solid: "#5b6cf9", c1: "#6366f1", c2: "#3b82f6" },
  { solid: "#9333ea", c1: "#a855f7", c2: "#7c3aed" },
  { solid: "#ec4899", c1: "#f472b6", c2: "#db2777" },
  { solid: "#ef4444", c1: "#f87171", c2: "#dc2626" },
  { solid: "#f59e0b", c1: "#fbbf24", c2: "#d97706" },
];

const DONUT_PALETTE = [
  "#e05245", // dominant coral-red (Ref 1)
  "#fde6c4", // warm cream-amber
  "#f3d5f0", // soft rose-lilac
  "#e4d9fa", // soft lavender
  "#dbe4fb", // soft periwinkle
];

const DONUT_PALETTE_DARK = [
  "#f43f5e",
  "#f59e0b",
  "#c084fc",
  "#818cf8",
  "#38bdf8",
];

const EVENT_CATS = [
  { id: "all", label: "All" },
  { id: "alarm", label: "Alarms" },
  { id: "estop", label: "E-Stops" },
  { id: "hold", label: "Holds" },
  { id: "program", label: "Programs" },
  { id: "tool", label: "Tools" },
  { id: "downtime", label: "Downtime Logs" },
  { id: "repair", label: "Repairs" },
];

const HEALTH_AXES = [
  { key: "availability", label: "Availability" },
  { key: "reliability", label: "Reliability" },
  { key: "tool", label: "Tool Headroom" },
  { key: "stability", label: "Stability" },
  { key: "comms", label: "Comms" },
];

export function mountFleetIntelligence(body, dataLayer) {
  let sub = localStorage.getItem(SUB_KEY) || "overview";
  if (!SUBTABS.some((s) => s.id === sub)) sub = "overview";

  let selectedMachine = null;
  let selectedProgram = "__AUTO__";
  let selectedShift = "all";
  let logCategory = "all";
  let logQuery = "";

  let lastData = null;
  let auxCache = null; // { key, risks, events }
  let token = 0;

  let drawerOpen = false;
  let drawerTab = "downtime";
  let drawerMachine = "";

  body.innerHTML = `
    <div class="fi-root" data-f="root">
      <div class="fi-trust-bar" data-f="trust"></div>
      <div class="fi-toolbar">
        <div class="fi-subtabs" role="tablist" data-f="subtabs"></div>
        <div class="fi-actions">
          <button type="button" class="fi-btn" data-action="open-drawer" data-tab="targets">Set Targets</button>
          <button type="button" class="fi-btn" data-action="open-drawer" data-tab="downtime">Log Downtime</button>
          <button type="button" class="fi-btn fi-btn-primary" data-action="open-drawer" data-tab="repairs">Log Repair</button>
        </div>
      </div>
      <div class="fi-filter-bar" data-f="filterBar" hidden></div>
      <div class="fi-stage" data-f="stage"></div>
      <p class="ds-note" data-f="note" role="status" aria-live="polite">Loading Fleet Intelligence…</p>
    </div>
    <div class="fi-tip" data-f="tip"></div>
    <div class="fi-drawer-backdrop" data-f="backdrop"></div>
    <aside class="fi-drawer" data-f="drawer" aria-hidden="true"></aside>
    <div class="fi-toast" data-f="toast" role="status" aria-live="polite"></div>`;

  const refs = {};
  body.querySelectorAll("[data-f]").forEach((el) => {
    refs[el.dataset.f] = el;
  });

  // Sub-tab buttons
  for (const t of SUBTABS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fi-subtab-btn";
    btn.role = "tab";
    btn.dataset.sub = t.id;
    btn.textContent = t.label;
    btn.addEventListener("click", () => {
      if (sub === t.id) return;
      sub = t.id;
      localStorage.setItem(SUB_KEY, sub);
      syncSubtabs();
      renderCurrent();
    });
    refs.subtabs.appendChild(btn);
  }

  function syncSubtabs() {
    refs.subtabs.querySelectorAll(".fi-subtab-btn").forEach((b) => {
      const on = b.dataset.sub === sub;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
  }
  syncSubtabs();

  // Toast feedback
  let toastTimer = null;
  function showToast(msg) {
    refs.toast.textContent = msg;
    refs.toast.classList.add("is-show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => refs.toast.classList.remove("is-show"), 2600);
  }

  // Delegated Floating Obsidian Hover Callout for all SVG & HTML widgets
  refs.root.addEventListener("pointermove", (ev) => {
    const hit = ev.target && ev.target.closest ? ev.target.closest("[data-fi-tip-title]") : null;
    if (!hit) {
      hideTip();
      return;
    }
    const title = hit.getAttribute("data-fi-tip-title") || "";
    const subTxt = hit.getAttribute("data-fi-tip-sub") || "";
    if (!title && !subTxt) {
      hideTip();
      return;
    }
    showTip(ev.clientX, ev.clientY, title, subTxt);
  });
  refs.root.addEventListener("pointerleave", hideTip);

  function showTip(x, y, title, subTxt) {
    refs.tip.innerHTML = `<b>${esc(title)}</b>${subTxt ? `<span class="fi-tip-sub">${esc(subTxt)}</span>` : ""}`;
    refs.tip.style.display = "block";
    const pad = 14;
    const tw = refs.tip.offsetWidth || 160;
    const th = refs.tip.offsetHeight || 48;
    const left = x + pad + tw > window.innerWidth - 8 ? Math.max(8, x - tw - pad) : x + pad;
    const top = y - th - 12 < 8 ? y + 18 : y - th - 12;
    refs.tip.style.left = `${left}px`;
    refs.tip.style.top = `${top}px`;
  }

  function hideTip() {
    refs.tip.style.display = "none";
  }

  // Drawer open/close
  function openDrawer(tab, machineId = "") {
    drawerTab = tab || "downtime";
    drawerMachine = machineId || selectedMachine || lastData?.machines?.[0]?.machine_id || "";
    drawerOpen = true;
    refs.backdrop.classList.add("is-open");
    refs.drawer.classList.add("is-open");
    refs.drawer.setAttribute("aria-hidden", "false");
    renderDrawer();
  }

  function closeDrawer() {
    drawerOpen = false;
    refs.backdrop.classList.remove("is-open");
    refs.drawer.classList.remove("is-open");
    refs.drawer.setAttribute("aria-hidden", "true");
  }

  refs.backdrop.addEventListener("click", closeDrawer);
  const onKeyDown = (e) => {
    if (e.key === "Escape" && drawerOpen) closeDrawer();
  };
  window.addEventListener("keydown", onKeyDown);

  // Re-render cleanly if user flips Dark/Light theme while on Fleet Intelligence
  const themeObserver = new MutationObserver(() => {
    if (lastData) renderCurrent();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // Delegated inline checkbox toggle (resolve/reopen repairs right on the widget)
  refs.root.addEventListener("change", async (e) => {
    const chk = e.target.closest("[data-action='toggle-repair']");
    if (!chk) return;
    const id = chk.dataset.id;
    const nextStatus = chk.checked ? "resolved" : "open";
    try {
      await fleetStore.updateRepair(id, {
        status: nextStatus,
        resolvedAt: nextStatus === "resolved" ? Date.now() : null,
      });
      if (lastData) lastData.store = fleetStore.getCached();
      auxCache = null;
      showToast(nextStatus === "resolved" ? "Repair marked resolved" : "Repair reopened");
      renderCurrent();
    } catch (err) {
      chk.checked = !chk.checked;
      showToast(err.message || "Could not update repair");
    }
  });

  // Delegated clicks & keyboard Enter/Space inside root
  async function handleActionEl(actEl) {
    const action = actEl.dataset.action;
    if (action === "open-drawer") {
      openDrawer(actEl.dataset.tab || "downtime", actEl.dataset.machine || "");
      return;
    }
    if (action === "clear-machine") {
      selectedMachine = null;
      renderCurrent();
      return;
    }
    if (action === "jump-sub") {
      const targetSub = actEl.dataset.sub;
      if (SUBTABS.some((s) => s.id === targetSub)) {
        sub = targetSub;
        localStorage.setItem(SUB_KEY, sub);
        syncSubtabs();
        renderCurrent();
      }
      return;
    }
    if (action === "select-program") {
      selectedProgram = actEl.dataset.program || "__AUTO__";
      sub = "programs";
      localStorage.setItem(SUB_KEY, sub);
      syncSubtabs();
      renderCurrent();
      return;
    }
    if (action === "delete-downtime") {
      const id = actEl.dataset.id;
      if (!id) return;
      try {
        await fleetStore.deleteDowntime(id);
        if (lastData) lastData.store = fleetStore.getCached();
        auxCache = null;
        showToast("Downtime entry removed");
        renderCurrent();
      } catch (err) {
        showToast(err.message || "Could not delete entry");
      }
      return;
    }
    if (action === "resolve-repair") {
      const id = actEl.dataset.id;
      if (!id) return;
      try {
        await fleetStore.updateRepair(id, { status: "resolved", resolvedAt: Date.now() });
        if (lastData) lastData.store = fleetStore.getCached();
        auxCache = null;
        showToast("Repair marked resolved");
        renderCurrent();
      } catch (err) {
        showToast(err.message || "Could not update repair");
      }
      return;
    }
    if (action === "delete-repair") {
      const id = actEl.dataset.id;
      if (!id) return;
      try {
        await fleetStore.deleteRepair(id);
        if (lastData) lastData.store = fleetStore.getCached();
        auxCache = null;
        showToast("Repair log removed");
        renderCurrent();
      } catch (err) {
        showToast(err.message || "Could not delete repair");
      }
    }
  }

  refs.root.addEventListener("click", (e) => {
    if (e.target.closest("input, select, textarea")) return;
    const actEl = e.target.closest("[data-action]");
    if (actEl && actEl.dataset.action !== "toggle-repair") {
      e.stopPropagation();
      handleActionEl(actEl);
      return;
    }
    const selMc = e.target.closest("[data-select-machine]");
    if (selMc) {
      const id = selMc.dataset.selectMachine;
      if (id) {
        selectedMachine = selectedMachine === id ? null : id;
        renderCurrent();
      }
    }
  });

  refs.root.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const selMc = e.target.closest("[data-select-machine]");
    if (selMc) {
      e.preventDefault();
      const id = selMc.dataset.selectMachine;
      if (id) {
        selectedMachine = selectedMachine === id ? null : id;
        renderCurrent();
      }
    }
  });

  /* ==================== MAIN REFRESH LOOP ==================== */
  async function refresh() {
    if (document.hidden) return;
    const my = ++token;
    const isCurrent = () => my === token;

    let ov = null;
    let audit = null;
    try {
      [ov, audit] = await Promise.all([
        dataLayer.overview(),
        dataLayer.gapAudit().catch(() => null),
        fleetStore.load(),
      ]);
    } catch (err) {
      if (!isCurrent()) return;
      const isTimeout = err.name === "AbortError" || (err.message && err.message.includes("aborted"));
      refs.note.textContent = isTimeout
        ? "Collector responding slowly — retrying Fleet Intelligence…"
        : "Collector unreachable — cannot load fleet telemetry.";
      refs.note.hidden = false;
      return;
    }
    if (!isCurrent()) return;

    const machines = Array.isArray(ov?.machines) ? ov.machines : [];
    if (!machines.length) {
      refs.note.textContent = "No machines reported by the collector.";
      refs.note.hidden = false;
      return;
    }

    const win = dataLayer.resolveWindow();
    const healths = await Promise.all(
      machines.map(async (m) => {
        try {
          return await health(dataLayer, m, win, audit);
        } catch (err) {
          return {
            id: m.machine_id,
            online: !!m.online,
            score: null,
            legs: {},
            metrics: null,
            wear: { observed: false, slots: [] },
            error: err.message || "fetch failed",
          };
        }
      })
    );
    if (!isCurrent()) return;

    for (const h of healths) {
      if (h.score != null) recordDaily(h.id, h.score, { online: h.online });
    }

    if (selectedMachine && !machines.some((m) => m.machine_id === selectedMachine)) {
      selectedMachine = null;
    }

    lastData = {
      machines,
      machineMap: new Map(machines.map((m) => [m.machine_id, m])),
      healths,
      win,
      audit,
      store: fleetStore.getCached(),
    };
    refs.note.hidden = true;
    renderCurrent();
  }

  async function ensureAuxData() {
    if (!lastData) return { risks: [], events: [] };
    const { machines, win } = lastData;
    const key = `${win.from}|${win.to}|${machines.map((m) => m.machine_id).join(",")}`;
    if (auxCache && auxCache.key === key) return auxCache;
    const [riskLists, eventLists] = await Promise.all([
      Promise.all(
        machines.map(async (m) => {
          try {
            const list = await predict(dataLayer, m, win);
            return list.map((p) => ({ ...p, machine: p.machine || m.machine_id }));
          } catch {
            return [];
          }
        })
      ),
      Promise.all(machines.map((m) => timeline(dataLayer, m.machine_id, win).catch(() => []))),
    ]);
    const risks = riskLists.flat().sort((a, b) => {
      const sv = (SEV_RANK[b.sev] || 0) - (SEV_RANK[a.sev] || 0);
      if (sv) return sv;
      return (a.etaMs ?? Infinity) - (b.etaMs ?? Infinity);
    });
    const events = eventLists.flat().sort((a, b) => b.ts - a.ts);
    auxCache = { key, risks, events };
    return auxCache;
  }

  function scopedHealths() {
    if (!lastData) return [];
    return selectedMachine ? lastData.healths.filter((h) => h.id === selectedMachine) : lastData.healths;
  }

  function isLightTheme() {
    return document.documentElement.getAttribute("data-theme") === "light";
  }

  function renderCurrent() {
    if (!lastData) return;
    hideTip();
    renderTrustBar();
    renderFilterBar();

    if (sub === "overview") return renderOverview();
    if (sub === "programs") return renderPrograms();
    if (sub === "downtime") return renderDowntime();
    if (sub === "reliability") return renderReliability();
    if (sub === "predictive") return renderPredictiveAndLog();
  }

  /* ==================== COLLECTOR TRUST STRIP ==================== */
  function renderTrustBar() {
    const { machines, healths, audit, win } = lastData;
    const isDemo = window.__VMC_DEMO_MODE__ === true;
    const producing = healths.filter((h) => (h.metrics?.parts || 0) > 0).length;
    const totalParts = healths.reduce((s, h) => s + (h.metrics?.parts || 0), 0);

    const flags = [];
    for (const h of healths) {
      const dt = h.metrics?.downtime;
      const tot = h.metrics
        ? h.metrics.buckets.run + h.metrics.buckets.pause + h.metrics.buckets.idle + h.metrics.buckets.other
        : 0;
      if (!h.online) flags.push(`${h.id} offline`);
      else if (dt && tot > 0 && dt.OTHER / tot > 0.6) flags.push(`${h.id} ${Math.round((dt.OTHER / tot) * 100)}% OTHER`);
    }

    const auditInfo = audit
      ? dataLayer.confidenceFromAudit(audit)
      : { label: "Audit unavailable", detail: "no gap audit" };

    refs.trust.innerHTML = `
      <div class="fi-trust-left">
        <span class="fi-trust-mode ${isDemo ? "is-demo" : "is-live"}">
          ${isDemo ? "Simulated Demo Collector (VMC_DEMO_MODE=1)" : "Live External Collector"}
        </span>
        <span class="fi-trust-sep">·</span>
        <span>${esc(auditInfo.label)} (${esc(auditInfo.detail || "gapless check")})</span>
        <span class="fi-trust-sep">·</span>
        <span>${producing}/${machines.length} producing (${totalParts} parts · ${esc(win.label)})</span>
        ${flags.length ? `<span class="fi-trust-sep">·</span><span class="fi-trust-alert">Attention: ${esc(flags.join(", "))}</span>` : ""}
      </div>
      <div>${fleetStore.isServerBacked() ? "Server-synced logs" : "Browser-local cache"}</div>`;
  }

  function renderFilterBar() {
    if (!selectedMachine) {
      refs.filterBar.hidden = true;
      return;
    }
    const m = lastData.machineMap.get(selectedMachine);
    refs.filterBar.hidden = false;
    refs.filterBar.innerHTML = `
      <span>Filtered to <strong>${esc(m?.machine_name || selectedMachine)}</strong> across all Fleet Intelligence widgets & sub-tabs.</span>
      <button type="button" class="fi-link-btn" data-action="clear-machine">Show entire fleet</button>`;
  }

  /* ==================== SUB-TAB 1: OVERVIEW (REF 2 4+4+3 MODULAR BENTO) ==================== */
  function renderOverview() {
    const hs = scopedHealths();
    const { store, win, machineMap, healths: allHealths } = lastData;

    // 1. Shift Target Arc Gauge ("Left to goal")
    let totalParts = 0;
    let totalTarget = 0;
    let totalPaceBenchmark = 0;
    for (const h of hs) {
      const m = machineMap.get(h.id);
      const p = computeProductionProgress(h.metrics, store.targets[h.id], win);
      totalParts += p.parts;
      if (p.targetParts) {
        totalTarget += p.targetParts;
      } else if (m?.target_part_qty > 0 && h.online) {
        totalPaceBenchmark += Math.max(p.parts, Math.round(m.target_part_qty / 5));
      } else if (h.online) {
        totalPaceBenchmark += Math.max(p.parts + 4, 24);
      }
    }
    const goalTarget = totalTarget > 0 ? totalTarget : Math.max(1, totalPaceBenchmark);
    const goalPct = Math.min(100, Math.round((totalParts / goalTarget) * 100));
    const leftToGoal = Math.max(0, goalTarget - totalParts);
    const isCustomTarget = totalTarget > 0;

    // 2. Output Spark Bars (bucket completed cycles across 8 equal time slices)
    const allCycles = hs
      .flatMap((h) => (h.metrics?.cycles || []).map((c) => ({ ...c, machineId: h.id })))
      .sort((a, b) => a.end - b.end);
    const sliceCount = 8;
    const span = Math.max(1, win.to - win.from);
    const sparkBars = Array.from({ length: sliceCount }, (_, i) => {
      const sFrom = win.from + (i / sliceCount) * span;
      const sTo = win.from + ((i + 1) / sliceCount) * span;
      const count = allCycles.filter((c) => c.end >= sFrom && c.end < (i === sliceCount - 1 ? sTo + 1 : sTo)).length;
      return {
        value: count,
        vivid: i % 2 === 1,
        tipTitle: `${count} part${count === 1 ? "" : "s"}`,
        tipSub: `${fmtTimeHM(sFrom)} – ${fmtTimeHM(sTo)}`,
      };
    });
    const wallRate = hs.reduce((s, h) => s + (h.metrics?.partRateWall || 0), 0);

    // 3. Live Faults & Alarms Feed
    const faultItems = [];
    for (const h of hs) {
      const alEvs = h.metrics?.alarmEvents?.events || [];
      const esEvs = h.metrics?.estopEvents?.events || [];
      for (const e of esEvs) faultItems.push({ ts: e.ts, machine: h.id, msg: "E-STOP triggered" });
      for (const e of alEvs) faultItems.push({ ts: e.ts, machine: h.id, msg: "Controller alarm" });
    }
    for (const r of store.repairLogs) {
      if (selectedMachine && r.machineId !== selectedMachine) continue;
      faultItems.push({ ts: r.startedAt || r.createdAt, machine: r.machineId, msg: r.faultTitle });
    }
    faultItems.sort((a, b) => b.ts - a.ts);
    const totalFaults = hs.reduce(
      (s, h) => s + (h.metrics?.alarmEvents?.count || 0) + (h.metrics?.estopEvents?.count || 0),
      0
    );

    const faultFeedHtml = faultItems.length
      ? faultItems
          .slice(0, 3)
          .map(
            (f) => `
              <div class="fi-feed-row">
                <span class="fi-feed-time">${fmtTimeHM(f.ts)} · ${esc(f.machine)}</span>
                <span class="fi-feed-msg" title="${esc(f.msg)}">${esc(f.msg)}</span>
              </div>`
          )
          .join("")
      : `<div class="fi-feed-row"><span class="fi-feed-time">Clean run</span><span class="fi-feed-msg fi-good">No alarms or e-stops</span></div>`;

    // 4. Downtime Split Half-Donut
    const dtTotals = { IDLE: 0, "FEED-HOLD": 0, ALARM: 0, "E-STOP": 0, OTHER: 0 };
    let totalRunMs = 0;
    for (const h of hs) {
      totalRunMs += h.metrics?.buckets?.run || 0;
      if (!h.metrics?.downtime) continue;
      for (const k of Object.keys(dtTotals)) dtTotals[k] += h.metrics.downtime[k] || 0;
    }
    const totalLossMs = Object.values(dtTotals).reduce((a, b) => a + b, 0);
    const halfSegs = Object.entries(dtTotals)
      .filter(([, ms]) => ms > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, ms]) => ({
        label: k,
        value: ms,
        color: CTRL_COLORS[k] || "#94a3b8",
        tipTitle: `${k} · ${fmtDurShort(ms)}`,
        tipSub: `${Math.round((ms / Math.max(1, totalLossMs)) * 100)}% of non-cutting loss`,
      }));

    // 5. Cycle Pace Area Line (8 slice medians)
    const areaPts = Array.from({ length: sliceCount }, (_, i) => {
      const sFrom = win.from + (i / sliceCount) * span;
      const sTo = win.from + ((i + 1) / sliceCount) * span;
      const slice = allCycles.filter((c) => c.end >= sFrom && c.end < (i === sliceCount - 1 ? sTo + 1 : sTo));
      const med = slice.length ? summarizeCycles(slice).median : null;
      return med != null
        ? {
            value: med / 60000,
            tipTitle: `${fmtClockMMSS(med)} median`,
            tipSub: `${slice.length} cycles · ${fmtTimeHM(sFrom)}–${fmtTimeHM(sTo)}`,
          }
        : null;
    }).filter(Boolean);
    const fleetCstats = summarizeCycles(allCycles);

    // 6. Cutting vs Non-Cutting VS Split
    const totalTimeMs = totalRunMs + totalLossMs;
    const cutPct = totalTimeMs > 0 ? Math.round((totalRunMs / totalTimeMs) * 100) : 0;
    const lostPct = totalTimeMs > 0 ? 100 - cutPct : 0;

    // 7. Actionable Today Checklist (Inline checkable repairs + tool replace alerts)
    const scopedRepairs = (selectedMachine
      ? store.repairLogs.filter((r) => r.machineId === selectedMachine)
      : store.repairLogs
    ).slice(0, 3);
    const wornAlerts = hs
      .flatMap((h) => (h.wear?.slots || []).map((s) => ({ machine: h.id, ...s })))
      .sort((a, b) => b.mag - a.mag)
      .slice(0, Math.max(0, 3 - scopedRepairs.length));

    const checkRowsHtml =
      scopedRepairs.length || wornAlerts.length
        ? [
            ...scopedRepairs.map(
              (r) => `
                <label class="fi-check-row ${r.status === "resolved" ? "is-done" : ""}">
                  <div>
                    <span class="fi-check-meta">${fmtTimeHM(r.startedAt || r.createdAt)} · ${esc(r.machineId)}</span>
                    <span class="fi-check-text">${esc(r.faultTitle)}</span>
                  </div>
                  <input type="checkbox" class="fi-checkbox" data-action="toggle-repair" data-id="${esc(r.id)}" ${r.status === "resolved" ? "checked" : ""} aria-label="Mark repair resolved" />
                </label>`
            ),
            ...wornAlerts.map(
              (t) => `
                <div class="fi-check-row">
                  <div>
                    <span class="fi-check-meta">${esc(t.machine)} · Tool T${t.slot} (${t.mag >= WEAR_LIMIT ? "Replace" : "Watch"})</span>
                    <span class="fi-check-text">Offset ${t.mag.toFixed(2)}mm / ${WEAR_LIMIT}mm limit</span>
                  </div>
                  <button type="button" class="fi-link-btn" style="padding:0;" data-action="open-drawer" data-tab="repairs" data-machine="${esc(t.machine)}">Log</button>
                </div>`
            ),
          ].join("")
        : `<div class="fi-check-row">
             <div>
               <span class="fi-check-meta">Shop floor clear</span>
               <span class="fi-check-text">No open repairs or overdue tools</span>
             </div>
             <button type="button" class="fi-link-btn" style="padding:0;" data-action="open-drawer" data-tab="repairs">+ Log</button>
           </div>`;

    // 8. Shift Productivity Capsule Bands
    const shifts = groupCyclesByShift(allCycles);
    const maxShiftCount = Math.max(1, ...shifts.map((s) => s.count));
    const bandColors = ["#7c3aed", "#2563eb", "#22c55e"];
    const bandOffsets = [0, 26, 48];
    const bandsHtml = shifts
      .map((sh, i) => {
        const wPct = Math.max(14, Math.min(72, Math.round((sh.count / maxShiftCount) * 62)));
        const leftPct = Math.min(100 - wPct, bandOffsets[i] || 0);
        return `
          <div class="fi-band-track fi-hit"
            data-fi-tip-title="${esc(`${sh.label} · ${sh.count} parts`)}"
            data-fi-tip-sub="${esc(sh.median ? `Median cycle ${fmtClockMMSS(sh.median)}` : "No cycles in this shift")}">
            <span class="fi-band-fill" style="left:${leftPct}%;width:${wPct}%;background:${bandColors[i]}"></span>
          </div>`;
      })
      .join("");

    // 9. 5-Axis Fleet Health Radar (Fleet Avg vs Selected or Weakest Machine)
    const fleetLegAvg = HEALTH_AXES.map((ax) => {
      const vals = allHealths.map((h) => h.legs[ax.key]?.value).filter((v) => Number.isFinite(v));
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    });
    const compareTarget = selectedMachine
      ? allHealths.find((h) => h.id === selectedMachine)
      : allHealths.filter((h) => h.score != null).sort((a, b) => a.score - b.score)[0];
    const compareVals = compareTarget
      ? HEALTH_AXES.map((ax) => compareTarget.legs[ax.key]?.value ?? 0)
      : null;
    const compareLabel = compareTarget ? compareTarget.id : "Selected";

    // 10. Machine Performance Leaderboard (clickable to cross-filter!)
    const rankedMachines = [...allHealths].sort(
      (a, b) => (b.metrics?.parts || 0) - (a.metrics?.parts || 0) || (b.score || 0) - (a.score || 0)
    );
    const lbRows = rankedMachines
      .map((h) => {
        const m = machineMap.get(h.id);
        const p = computeProductionProgress(h.metrics, store.targets[h.id], win);
        const prog = m?.active_program && m.active_program !== "UNAVAILABLE" ? m.active_program : h.online ? "Idle" : "Offline";
        const sc = h.score == null ? null : Math.round(h.score);
        const bg = sc == null ? "#64748b" : sc >= 80 ? "#22c55e" : sc >= 60 ? "#f59e0b" : "#f43f5e";
        const avail = h.metrics?.availability != null ? Math.round(h.metrics.availability) : null;
        const deltaTxt = p.pctTarget != null ? `${Math.round(p.pctTarget)}% tgt` : avail != null ? `${avail}% run` : "offline";
        const deltaTone = (p.pctTarget ?? avail ?? 0) >= 70 ? "fi-good" : (p.pctTarget ?? avail ?? 0) >= 40 ? "fi-warn" : "fi-bad";
        const isSel = selectedMachine === h.id;

        return `
          <div class="fi-lb-row ${isSel ? "is-selected" : ""}" role="button" tabindex="0" data-select-machine="${esc(h.id)}">
            <div class="fi-lb-badge" style="background:${bg}">${sc == null ? "—" : sc}</div>
            <div style="min-width:0;">
              <div class="fi-lb-name">${esc(h.id)}</div>
              <div class="fi-lb-prog" title="${esc(prog)}">${esc(prog)}</div>
            </div>
            <div class="fi-lb-delta ${deltaTone}">${deltaTxt}</div>
            <div class="fi-lb-val">${p.parts} <span class="fi-muted" style="font-size:12px;font-weight:500;">pcs</span></div>
          </div>`;
      })
      .join("");

    // 11. Paired Output vs Target Bar Chart
    const pairedGroups = allHealths.map((h) => {
      const p = computeProductionProgress(h.metrics, store.targets[h.id], win);
      const tgt = p.targetParts ?? Math.max(p.parts, 25);
      return {
        machineId: h.id,
        label: h.id,
        shortLabel: h.id.replace("VMC-", "M"),
        a: p.parts,
        b: tgt,
        aLabel: "Completed",
        bLabel: p.targetParts ? "Shift Target" : "Pace Ref",
        aTip: `${p.parts} parts (${p.partRateWall != null ? `${p.partRateWall.toFixed(1)}/hr` : "0/hr"})`,
        bTip: p.targetParts ? `${p.targetParts} target parts` : `${tgt} ref pace (click Set Targets)`,
      };
    });

    const todayLabel = new Date().toLocaleDateString([], { day: "numeric", month: "short" });

    refs.stage.innerHTML = `
      <!-- ROW 1: 4 COMPACT KPI WIDGETS (REF 2 TOP ROW) -->
      <div class="fi-grid-4">
        <div class="fi-card">
          <div class="fi-whead">
            <div>
              <h3 class="fi-wtitle">Left to goal</h3>
              <div class="fi-big-num">${leftToGoal} <span class="fi-muted" style="font-size:16px;font-weight:600;">pcs</span></div>
            </div>
            <button type="button" class="fi-link-btn" data-action="open-drawer" data-tab="targets">${isCustomTarget ? "Edit" : "Set"}</button>
          </div>
          ${svgArcGauge({
            pct: goalPct,
            centerValue: `${goalPct}%`,
            subLabel: `${totalParts} / ${goalTarget} ${isCustomTarget ? "target" : "pace ref"}`,
            color: "#2563eb",
            tipTitle: `${totalParts} / ${goalTarget} parts (${goalPct}%)`,
            tipSub: `${leftToGoal} remaining in ${win.label}`,
          })}
        </div>

        <div class="fi-card">
          <div class="fi-whead">
            <div>
              <h3 class="fi-wtitle">Parts output</h3>
              <div class="fi-big-num">${totalParts}</div>
            </div>
            <div class="fi-wmeta">
              <div class="fi-delta fi-good">${wallRate.toFixed(1)}/hr</div>
              <div>${esc(win.label)}</div>
            </div>
          </div>
          ${svgSparkBars(sparkBars)}
        </div>

        <div class="fi-card">
          <div class="fi-whead">
            <div>
              <h3 class="fi-wtitle">Fault events</h3>
              <div class="fi-big-num ${totalFaults > 0 ? "fi-bad" : ""}">${totalFaults}</div>
            </div>
            <div class="fi-wmeta">
              <button type="button" class="fi-link-btn" data-action="jump-sub" data-sub="predictive">View log</button>
              <div>Alarms & E-Stops</div>
            </div>
          </div>
          <div class="fi-feed-list">${faultFeedHtml}</div>
        </div>

        <div class="fi-card">
          <div class="fi-whead">
            <div>
              <h3 class="fi-wtitle">Non-cutting loss</h3>
              <div class="fi-big-num">${fmtDurShort(totalLossMs)}</div>
            </div>
            <div class="fi-wmeta">
              <button type="button" class="fi-link-btn" data-action="jump-sub" data-sub="downtime">Causes</button>
              <div>${esc(win.label)}</div>
            </div>
          </div>
          <div class="fi-legend">
            ${halfSegs
              .slice(0, 4)
              .map((s) => `<span class="fi-legend-item"><span class="fi-dot" style="background:${s.color}"></span>${esc(s.label)}</span>`)
              .join("")}
          </div>
          ${svgHalfDonut(halfSegs)}
        </div>
      </div>

      <!-- ROW 2: 4 OPERATIONAL INSIGHT WIDGETS (REF 2 MIDDLE ROW) -->
      <div class="fi-grid-4">
        <div class="fi-card">
          <div class="fi-whead">
            <div>
              <h3 class="fi-wtitle">Median cycle</h3>
              <div class="fi-big-num">${fmtClockMMSS(fleetCstats.median)}</div>
            </div>
            <div class="fi-wmeta">
              <div class="fi-delta ${fleetCstats.driftSecPerHr > 2 ? "fi-bad" : "fi-good"}">
                ${fleetCstats.driftSecPerHr != null ? `${fleetCstats.driftSecPerHr >= 0 ? "+" : ""}${fleetCstats.driftSecPerHr.toFixed(1)}s/h` : "Stable"}
              </div>
              <div>Theil-Sen drift</div>
            </div>
          </div>
          ${svgAreaLine(areaPts)}
        </div>

        <div class="fi-card">
          <div class="fi-whead">
            <div>
              <h3 class="fi-wtitle">Utilization split</h3>
              <div class="fi-big-num">${fmtDurShort(totalRunMs)}</div>
            </div>
            <div class="fi-wmeta">
              <div class="fi-delta ${cutPct >= 65 ? "fi-good" : "fi-warn"}">${cutPct}% run</div>
              <div>Active cutting</div>
            </div>
          </div>
          <div class="fi-vs-grid">
            <div class="fi-vs-col">
              <span class="fi-vs-lbl">Cutting</span>
              <span class="fi-vs-pct">${cutPct}%</span>
              <span class="fi-vs-sub">${fmtDurShort(totalRunMs)}</span>
            </div>
            <span class="fi-vs-mid">VS</span>
            <div class="fi-vs-col is-right">
              <span class="fi-vs-lbl">Non-cutting</span>
              <span class="fi-vs-pct">${lostPct}%</span>
              <span class="fi-vs-sub">${fmtDurShort(totalLossMs)}</span>
            </div>
          </div>
          <div class="fi-vs-bar">
            <span class="fi-vs-seg" style="width:${cutPct}%;background:#2563eb"></span>
            <span class="fi-vs-seg" style="width:${lostPct}%;background:#f59e0b"></span>
          </div>
        </div>

        <div class="fi-card">
          <div class="fi-whead">
            <div>
              <h3 class="fi-wtitle">Today · Actions</h3>
              <div class="fi-big-num">${esc(todayLabel)}</div>
            </div>
            <button type="button" class="fi-link-btn" data-action="jump-sub" data-sub="reliability">Show all</button>
          </div>
          <div class="fi-check-list">${checkRowsHtml}</div>
        </div>

        <div class="fi-card">
          <div class="fi-whead">
            <div>
              <h3 class="fi-wtitle">Shift productivity</h3>
              <div class="fi-big-num">${fmtDurShort(totalRunMs)}</div>
            </div>
            <div class="fi-wmeta">
              <div class="fi-delta fi-info">${allCycles.length} cycles</div>
              <div>3 shift bands</div>
            </div>
          </div>
          <div class="fi-bands">
            <div class="fi-band-head"><span>Shift 1</span><span>Shift 2</span><span>Shift 3</span></div>
            ${bandsHtml}
          </div>
          <div class="fi-legend">
            <span class="fi-legend-item"><span class="fi-dot" style="background:#7c3aed"></span>06–14</span>
            <span class="fi-legend-item"><span class="fi-dot" style="background:#2563eb"></span>14–22</span>
            <span class="fi-legend-item"><span class="fi-dot" style="background:#22c55e"></span>22–06</span>
          </div>
        </div>
      </div>

      <!-- ROW 3: 3 ANALYTICAL BENTO CARDS (REF 2 BOTTOM ROW) -->
      <div class="fi-grid-3">
        <div class="fi-card">
          <div class="fi-whead">
            <div>
              <h3 class="fi-wtitle">5-Axis Health Radar</h3>
              <p class="fi-wsub">Fleet average vs. ${esc(compareLabel)}${!selectedMachine && compareTarget ? " (weakest)" : ""}</p>
            </div>
            <div class="fi-legend">
              <span class="fi-legend-item"><span class="fi-dot" style="background:#22c55e"></span>Fleet</span>
              <span class="fi-legend-item"><span class="fi-dot" style="background:#2563eb"></span>${esc(compareLabel)}</span>
            </div>
          </div>
          ${svgHealthRadar(HEALTH_AXES, fleetLegAvg, compareVals, compareLabel)}
        </div>

        <div class="fi-card">
          <div class="fi-whead">
            <div>
              <h3 class="fi-wtitle">Fleet ranking</h3>
              <p class="fi-wsub">Click any machine to cross-filter every widget</p>
            </div>
            <span class="fi-wmeta">${allHealths.length} VMCs</span>
          </div>
          <div class="fi-lb-list">${lbRows}</div>
        </div>

        <div class="fi-card">
          <div class="fi-whead">
            <div>
              <h3 class="fi-wtitle">Output vs. target</h3>
              <p class="fi-wsub">Actual parts vs. shift target per machine</p>
            </div>
            <div class="fi-legend">
              <span class="fi-legend-item"><span class="fi-dot" style="background:#7c3aed"></span>Actual</span>
              <span class="fi-legend-item"><span class="fi-dot" style="background:#22c55e"></span>Target</span>
            </div>
          </div>
          ${svgPairedBars(pairedGroups)}
        </div>
      </div>`;
  }

  /* ==================== SUB-TAB 2: PROGRAMS & CYCLES (REF 1 2×2 STORY GRID) ==================== */
  function renderPrograms() {
    const hs = scopedHealths();
    const machineEntries = hs.map((h) => ({
      id: h.id,
      cycles: (h.metrics?.cycles || []).filter((c) => {
        if (selectedShift === "all") return true;
        return shiftOfTs(c.end).id === selectedShift;
      }),
    }));

    const matrix = buildProgramMatrix(machineEntries);
    const allCycles = machineEntries.flatMap((e) => e.cycles.map((c) => ({ ...c, machineId: e.id })));

    let activeProg = selectedProgram;
    if (activeProg === "__AUTO__" || (activeProg !== "__ALL__" && !matrix.some((p) => p.program === activeProg))) {
      activeProg = matrix.length ? matrix[0].program : "__ALL__";
    }

    const activeObj =
      activeProg === "__ALL__"
        ? { program: "All Programs Combined", ...summarizeCycles(allCycles), machines: [] }
        : matrix.find((p) => p.program === activeProg) || {
            program: activeProg,
            ...summarizeCycles([]),
            machines: [],
          };

    // 1. Gradient Histogram (Ref 1 Top-Left)
    const binned = computeHistogramBins(
      (activeObj.cycles || []).map((c) => c.dur),
      activeObj.min,
      activeObj.max
    );

    // 2. Connected Stacked Shift Flow (Ref 1 Top-Right)
    const topSeriesProgs = matrix.slice(0, 5);
    const seriesDefs = topSeriesProgs.map((p, i) => ({
      key: p.program,
      label: p.program,
      color: SERIES_PALETTE[i % SERIES_PALETTE.length].solid,
    }));
    const shiftColumns = SHIFT_DEFS.map((sh) => {
      const values = {};
      let total = 0;
      for (const c of allCycles) {
        if (shiftOfTs(c.end).id !== sh.id) continue;
        const pName = normalizeProgramName(c.program);
        if (seriesDefs.some((s) => s.key === pName)) {
          values[pName] = (values[pName] || 0) + 1;
          total += 1;
        }
      }
      return {
        label: sh.label,
        shortLabel: sh.label.split(" ")[0] + " " + sh.label.split(" ")[1],
        values,
        total,
      };
    });

    // 3. Rounded-Square Scatter Matrix: Consistency (100 - CV%) vs Parts Completed (Ref 1 Bottom-Left)
    const scatterPts = matrix.slice(0, 8).map((p, i) => {
      const pal = SERIES_PALETTE[i % SERIES_PALETTE.length];
      const consistency = p.cv != null ? Math.max(50, Math.min(99, 100 - p.cv)) : 85;
      return {
        program: p.program,
        label: p.program,
        x: p.count,
        y: consistency,
        size: p.count * (p.median || 600000),
        countText: String(p.count),
        c1: pal.c1,
        c2: pal.c2,
        highlight: i === 0,
        tipTitle: `${p.program} · ${p.count} parts`,
        tipSub: `Median ${fmtClockMMSS(p.median)} · Consistency ${consistency.toFixed(0)}% (CV ${p.cv != null ? p.cv.toFixed(1) : "—"}%)`,
      };
    });

    // 4. Program Share Segmented Gap Donut (Ref 1 Bottom-Right)
    const donutPalette = isLightTheme() ? DONUT_PALETTE : DONUT_PALETTE_DARK;
    const totalProgParts = matrix.reduce((s, p) => s + p.count, 0);
    const donutSegs = matrix.slice(0, 5).map((p, i) => ({
      label: p.program,
      value: p.count,
      shortVal: String(p.count),
      color: donutPalette[i % donutPalette.length],
      tipTitle: `${p.program}`,
      tipSub: `${p.count} parts (${Math.round((p.count / Math.max(1, totalProgParts)) * 100)}%) · median ${fmtClockMMSS(p.median)}`,
    }));

    const progOpts = [
      ...matrix.map(
        (p) =>
          `<option value="${esc(p.program)}" ${p.program === activeProg ? "selected" : ""}>${esc(p.program)} (${p.count} cycles · ${p.machineCount} VMC)</option>`
      ),
      `<option value="__ALL__" ${activeProg === "__ALL__" ? "selected" : ""}>All Programs Combined (${allCycles.length} cycles)</option>`,
    ].join("");

    const shiftOpts = [
      `<option value="all" ${selectedShift === "all" ? "selected" : ""}>All Shifts</option>`,
      ...SHIFT_DEFS.map(
        (s) => `<option value="${s.id}" ${selectedShift === s.id ? "selected" : ""}>${esc(s.label)}</option>`
      ),
    ].join("");

    const crossRows =
      activeProg !== "__ALL__" && activeObj.machines.length
        ? activeObj.machines
            .map((m) => {
              const vs =
                m.vsFastestPct == null
                  ? "—"
                  : m.vsFastestPct === 0
                    ? "Fastest baseline"
                    : `+${m.vsFastestPct.toFixed(1)}% slower`;
              const d = m.driftSecPerHr == null ? "—" : `${m.driftSecPerHr >= 0 ? "+" : ""}${m.driftSecPerHr.toFixed(1)}s/h`;
              return `
                <tr>
                  <td><strong>${esc(m.machineId)}</strong></td>
                  <td class="num">${m.count}</td>
                  <td class="num">${fmtClockMMSS(m.p10)}</td>
                  <td class="num"><strong>${fmtClockMMSS(m.median)}</strong></td>
                  <td class="num">${fmtClockMMSS(m.p90)}</td>
                  <td class="num">${m.cv != null ? `${m.cv.toFixed(1)}%` : "—"}</td>
                  <td class="num ${m.driftSecPerHr > 2 ? "fi-bad" : m.driftSecPerHr < -2 ? "fi-good" : ""}">${d}</td>
                  <td class="num ${m.vsFastestPct === 0 ? "fi-good" : m.vsFastestPct > 8 ? "fi-warn" : "fi-muted"}">${vs}</td>
                </tr>`;
            })
            .join("")
        : "";

    const allProgRows = matrix
      .map((p) => {
        const d = p.driftSecPerHr == null ? "—" : `${p.driftSecPerHr >= 0 ? "+" : ""}${p.driftSecPerHr.toFixed(1)}s/h`;
        return `
          <tr>
            <td><button type="button" class="fi-link-btn" style="padding:0;" data-action="select-program" data-program="${esc(p.program)}">${esc(p.program)}</button></td>
            <td class="num">${p.machineCount}</td>
            <td class="num">${p.count}</td>
            <td class="num">${fmtClockMMSS(p.p10)}</td>
            <td class="num"><strong>${fmtClockMMSS(p.median)}</strong></td>
            <td class="num">${fmtClockMMSS(p.p90)}</td>
            <td class="num">${p.cv != null ? `${p.cv.toFixed(1)}%` : "—"}</td>
            <td class="num ${p.driftSecPerHr > 2 ? "fi-bad" : p.driftSecPerHr < -2 ? "fi-good" : ""}">${d}</td>
          </tr>`;
      })
      .join("");

    refs.stage.innerHTML = `
      <div class="fi-controls-row">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
          <select class="fi-select" data-f="progSel" aria-label="Select NC program">${progOpts}</select>
          <select class="fi-select" style="min-width:155px;" data-f="shiftSel" aria-label="Filter by shift">${shiftOpts}</select>
        </div>
        <span class="fi-muted" style="font-size:12.5px;">Splitting statistics by NC program prevents mixing heterogeneous cycle times.</span>
      </div>

      ${
        activeProg === "__ALL__" && matrix.length > 1
          ? `<div class="fi-warning-note">Viewing combined cycles across ${matrix.length} NC programs. Pick a specific program above for an apples-to-apples median and Theil-Sen drift benchmark.</div>`
          : ""
      }

      <!-- REF 1: 2×2 SOFT-GRADIENT STORY CHARTS -->
      <div class="fi-grid-2">
        <div class="fi-card">
          <div class="fi-whead">
            <div>
              <h3 class="fi-wtitle">Cycle-time distribution · ${esc(activeObj.program)}</h3>
              <p class="fi-wsub">P10 ${fmtClockMMSS(activeObj.p10)} · Median ${fmtClockMMSS(activeObj.median)} · P90 ${fmtClockMMSS(activeObj.p90)}</p>
            </div>
            <span class="fi-wmeta">${activeObj.count} cycles</span>
          </div>
          <div class="fi-big-num" style="font-size:26px;">${fmtClockMMSS(activeObj.p10)} – ${fmtClockMMSS(activeObj.p90)}</div>
          ${svgGradientHistogram(binned, fmtClockMMSS)}
        </div>

        <div class="fi-card">
          <div class="fi-whead">
            <div>
              <h3 class="fi-wtitle">Program volume flow across shifts</h3>
              <p class="fi-wsub">How top NC programs carry across Shift 1, Shift 2, and Shift 3</p>
            </div>
            <span class="fi-wmeta">Parts / shift</span>
          </div>
          <div class="fi-legend">
            ${seriesDefs
              .map((s) => `<span class="fi-legend-item"><span class="fi-dot" style="background:${s.color}"></span>${esc(s.label)}</span>`)
              .join("")}
          </div>
          ${svgConnectedStacks(shiftColumns, seriesDefs)}
        </div>

        <div class="fi-card">
          <div class="fi-whead">
            <div>
              <h3 class="fi-wtitle">Program stability vs. output volume</h3>
              <p class="fi-wsub">Click any rounded tile to isolate that NC program</p>
            </div>
            <span class="fi-wmeta">↑ consistency → parts</span>
          </div>
          <div class="fi-legend">
            ${scatterPts
              .slice(0, 6)
              .map((p) => `<span class="fi-legend-item"><span class="fi-dot" style="background:${p.c2}"></span>${esc(p.label)}</span>`)
              .join("")}
          </div>
          ${svgSquareScatter(scatterPts)}
        </div>

        <div class="fi-card">
          <div class="fi-whead">
            <div>
              <h3 class="fi-wtitle">Production share by NC program</h3>
              <p class="fi-wsub">Top programs across ${esc(lastData.win.label)}</p>
            </div>
            <span class="fi-wmeta">${matrix.length} programs</span>
          </div>
          <div class="fi-donut-body">
            <div class="fi-donut-left">
              <div>
                <div class="fi-wsub">Total completed parts</div>
                <div class="fi-big-num">${totalProgParts}</div>
              </div>
              <div class="fi-legend-col">
                ${donutSegs
                  .map((s) => `<span class="fi-legend-item"><span class="fi-dot" style="background:${s.color}"></span>${esc(s.label)}</span>`)
                  .join("")}
              </div>
            </div>
            ${svgGapDonut(donutSegs)}
          </div>
        </div>
      </div>

      <!-- PROGRAM BENCHMARK TABLE -->
      <div class="fi-card">
        <div class="fi-whead">
          <div>
            <h3 class="fi-wtitle">${activeProg !== "__ALL__" ? `Cross-machine benchmark · ${esc(activeProg)}` : "All NC programs benchmark directory"}</h3>
            <p class="fi-wsub">${activeProg !== "__ALL__" ? "Machines executing the exact same NC program ranked against fastest median" : "Click any NC program name to inspect its dedicated distribution"}</p>
          </div>
          <div class="fi-stat-strip" style="border:none;padding:0;gap:18px;display:flex;">
            <div><span class="fi-stat-k">CV%</span><span class="fi-stat-v" style="font-size:18px;">${activeObj.cv != null ? `${activeObj.cv.toFixed(1)}%` : "—"}</span></div>
            <div><span class="fi-stat-k">Drift</span><span class="fi-stat-v ${activeObj.driftSecPerHr > 2 ? "fi-bad" : activeObj.driftSecPerHr < -2 ? "fi-good" : ""}" style="font-size:18px;">${activeObj.driftSecPerHr != null ? `${activeObj.driftSecPerHr >= 0 ? "+" : ""}${activeObj.driftSecPerHr.toFixed(1)}s/h` : "—"}</span></div>
          </div>
        </div>
        <div class="fi-table-wrap">
          ${
            activeProg !== "__ALL__" && crossRows
              ? `<table class="fi-table">
                  <thead><tr><th>Machine</th><th class="num">Parts</th><th class="num">P10</th><th class="num">Median</th><th class="num">P90</th><th class="num">CV%</th><th class="num">Drift</th><th class="num">Gap vs Best</th></tr></thead>
                  <tbody>${crossRows}</tbody>
                </table>`
              : `<table class="fi-table">
                  <thead><tr><th>NC Program</th><th class="num">VMCs</th><th class="num">Parts</th><th class="num">P10</th><th class="num">Median</th><th class="num">P90</th><th class="num">CV%</th><th class="num">Drift</th></tr></thead>
                  <tbody>${allProgRows || `<tr><td colspan="8" class="fi-muted">No completed M30 cycles in this window.</td></tr>`}</tbody>
                </table>`
          }
        </div>
      </div>`;

    const progSel = refs.stage.querySelector('[data-f="progSel"]');
    const shiftSel = refs.stage.querySelector('[data-f="shiftSel"]');
    if (progSel) {
      progSel.addEventListener("change", () => {
        selectedProgram = progSel.value;
        renderPrograms();
      });
    }
    if (shiftSel) {
      shiftSel.addEventListener("change", () => {
        selectedShift = shiftSel.value;
        renderPrograms();
      });
    }
  }

  /* ==================== SUB-TAB 3: DOWNTIME & REASONS ==================== */
  function renderDowntime() {
    const hs = scopedHealths();
    const { store, win } = lastData;

    const ctrlTotals = { IDLE: 0, "FEED-HOLD": 0, ALARM: 0, "E-STOP": 0, OTHER: 0 };
    for (const h of hs) {
      if (!h.metrics?.downtime) continue;
      for (const k of Object.keys(ctrlTotals)) ctrlTotals[k] += h.metrics.downtime[k] || 0;
    }
    const ctrlEntries = Object.entries(ctrlTotals)
      .filter(([, ms]) => ms > 0)
      .sort((a, b) => b[1] - a[1]);
    const ctrlSum = ctrlEntries.reduce((a, [, ms]) => a + ms, 0);

    const scopedLogs = selectedMachine
      ? store.downtimeLogs.filter((l) => l.machineId === selectedMachine)
      : store.downtimeLogs;
    const fleetAcc = summarizeDowntimeAccountability(selectedMachine, ctrlTotals, scopedLogs, win);

    // Ref 1 Segmented Gap Donut for Verified Root Causes vs Unattributed
    const donutPalette = isLightTheme() ? DONUT_PALETTE : DONUT_PALETTE_DARK;
    const causeSegs = fleetAcc.breakdown.map((r, i) => ({
      label: r.reason,
      value: r.ms,
      shortVal: fmtDurShort(r.ms),
      color: donutPalette[i % donutPalette.length],
      tipTitle: `${r.reason} · ${fmtDurShort(r.ms)}`,
      tipSub: `${r.count} log${r.count === 1 ? "" : "s"} · ${Math.round(r.pct)}% of total loss`,
    }));
    if (fleetAcc.unattributedMs > 60000) {
      causeSegs.push({
        label: "Unattributed",
        value: fleetAcc.unattributedMs,
        shortVal: fmtDurShort(fleetAcc.unattributedMs),
        color: isLightTheme() ? "#e2e8f0" : "#334155",
        tipTitle: `Unattributed · ${fmtDurShort(fleetAcc.unattributedMs)}`,
        tipSub: "Log real factory reasons to explain this time",
      });
    }

    const ctrlBars = ctrlSum
      ? ctrlEntries
          .map(([reason, ms]) => {
            const pct = (ms / ctrlSum) * 100;
            return `
              <div class="fi-pareto-row fi-hit" data-fi-tip-title="${esc(`${reason} · ${fmtDurShort(ms)}`)}" data-fi-tip-sub="${esc(`${Math.round(pct)}% of controller loss`)}">
                <span class="fi-pareto-name">${esc(reason)}</span>
                <div class="fi-bar-track"><span class="fi-bar-fill" style="width:${pct.toFixed(1)}%;background:${CTRL_COLORS[reason] || "#64748b"}"></span></div>
                <span class="fi-pareto-val">${fmtDurShort(ms)} · ${Math.round(pct)}%</span>
              </div>`;
          })
          .join("")
      : `<div class="fi-empty">Zero controller non-cutting loss recorded in this window.</div>`;

    const narrativesHtml = hs
      .map((h) => {
        const acc = summarizeDowntimeAccountability(h.id, h.metrics?.downtime, store.downtimeLogs, win);
        const pctTone = acc.accountedPct >= 75 ? "fi-good" : acc.accountedPct >= 40 ? "fi-warn" : "fi-muted";
        return `
          <div class="fi-narrative-row">
            <div style="min-width:0;flex:1;">
              <div style="font-weight:600;font-size:13.5px;">
                ${esc(h.id)}
                <span class="${pctTone}" style="font-size:12px;margin-left:8px;">${Math.round(acc.accountedPct)}% accounted</span>
              </div>
              <div class="fi-narrative-chain">${esc(acc.narrative)}</div>
            </div>
            <button type="button" class="fi-btn fi-btn-sm" data-action="open-drawer" data-tab="downtime" data-machine="${esc(h.id)}">+ Log reason</button>
          </div>`;
      })
      .join("");

    const ledgerRows = scopedLogs
      .map(
        (l) => `
          <tr>
            <td style="white-space:nowrap;">${fmtShortClock(l.startTs || l.createdAt)}</td>
            <td><strong>${esc(l.machineId)}</strong></td>
            <td>${esc(l.reason)}</td>
            <td class="num"><strong>${l.durationMin}m</strong></td>
            <td>${esc(l.operator || "—")}${l.shiftLabel ? ` · ${esc(l.shiftLabel)}` : ""}</td>
            <td class="fi-muted">${esc(l.note || "—")}</td>
            <td class="num"><button type="button" class="fi-link-btn is-danger" data-action="delete-downtime" data-id="${esc(l.id)}">Remove</button></td>
          </tr>`
      )
      .join("");

    refs.stage.innerHTML = `
      <div class="fi-grid-2">
        <div class="fi-card">
          <div class="fi-whead">
            <div>
              <h3 class="fi-wtitle">Verified root-cause share</h3>
              <p class="fi-wsub">Operator-logged downtime causes vs. unattributed time</p>
            </div>
            <button type="button" class="fi-btn fi-btn-sm fi-btn-primary" data-action="open-drawer" data-tab="downtime">Log Cause</button>
          </div>
          <div class="fi-donut-body">
            <div class="fi-donut-left">
              <div>
                <div class="fi-wsub">Total non-cutting loss</div>
                <div class="fi-big-num">${fmtDurShort(fleetAcc.totalLossMs)}</div>
                <div class="fi-delta ${fleetAcc.accountedPct >= 75 ? "fi-good" : "fi-warn"}" style="margin-top:4px;">${Math.round(fleetAcc.accountedPct)}% explained</div>
              </div>
              <div class="fi-legend-col">
                ${causeSegs
                  .slice(0, 5)
                  .map((s) => `<span class="fi-legend-item"><span class="fi-dot" style="background:${s.color}"></span>${esc(s.label)}</span>`)
                  .join("")}
              </div>
            </div>
            ${svgGapDonut(causeSegs)}
          </div>
        </div>

        <div class="fi-card">
          <div class="fi-whead">
            <div>
              <h3 class="fi-wtitle">Controller-recorded loss states</h3>
              <p class="fi-wsub">MTConnect execution & alarm dwell across ${esc(win.label)}</p>
            </div>
            <span class="fi-wmeta">${fmtDurShort(ctrlSum)}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:12px;margin-top:4px;">${ctrlBars}</div>
        </div>
      </div>

      <div class="fi-card">
        <div class="fi-whead">
          <div>
            <h3 class="fi-wtitle">Per-machine loss explanations</h3>
            <p class="fi-wsub">Turns raw IDLE time into real factory explanations backed strictly by logged evidence</p>
          </div>
        </div>
        <div>${narrativesHtml}</div>
      </div>

      <div class="fi-card">
        <div class="fi-whead">
          <div>
            <h3 class="fi-wtitle">Recorded downtime ledger</h3>
            <p class="fi-wsub">${scopedLogs.length} recorded entr${scopedLogs.length === 1 ? "y" : "ies"}</p>
          </div>
        </div>
        <div class="fi-table-wrap">
          ${
            scopedLogs.length
              ? `<table class="fi-table">
                  <thead><tr><th>Time</th><th>Machine</th><th>Reason</th><th class="num">Duration</th><th>Operator / Shift</th><th>Evidence Note</th><th class="num">Action</th></tr></thead>
                  <tbody>${ledgerRows}</tbody>
                </table>`
              : `<div class="fi-empty">
                   <span>No downtime causes recorded yet. Log Waiting for Material, Setup, or Operator Delay to build real loss accountability.</span>
                   <button type="button" class="fi-btn fi-btn-sm fi-btn-primary" data-action="open-drawer" data-tab="downtime">Log First Downtime Cause</button>
                 </div>`
          }
        </div>
      </div>`;
  }

  /* ==================== SUB-TAB 4: RELIABILITY & REPAIRS ==================== */
  function renderReliability() {
    const hs = scopedHealths();
    const { store, win, healths: allHealths } = lastData;

    const runMs = hs.reduce((s, h) => s + (h.metrics?.buckets?.run || 0), 0);
    const alCount = hs.reduce((s, h) => s + (h.metrics?.alarmEvents?.count || 0), 0);
    const esCount = hs.reduce((s, h) => s + (h.metrics?.estopEvents?.count || 0), 0);
    const dtSum = hs.reduce(
      (acc, h) => ({
        ALARM: acc.ALARM + (h.metrics?.downtime?.ALARM || 0),
        "E-STOP": acc["E-STOP"] + (h.metrics?.downtime?.["E-STOP"] || 0),
      }),
      { ALARM: 0, "E-STOP": 0 }
    );
    const scopedRepairs = selectedMachine
      ? store.repairLogs.filter((r) => r.machineId === selectedMachine)
      : store.repairLogs;

    const rel = computeReliabilityComparison(runMs, { count: alCount }, { count: esCount }, dtSum, scopedRepairs, win);

    const fleetLegAvg = HEALTH_AXES.map((ax) => {
      const vals = allHealths.map((h) => h.legs[ax.key]?.value).filter((v) => Number.isFinite(v));
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    });
    const compareTarget = selectedMachine
      ? allHealths.find((h) => h.id === selectedMachine)
      : allHealths.filter((h) => h.score != null).sort((a, b) => a.score - b.score)[0];
    const compareVals = compareTarget ? HEALTH_AXES.map((ax) => compareTarget.legs[ax.key]?.value ?? 0) : null;

    const weakLegs = [];
    for (const h of hs) {
      for (const [k, leg] of Object.entries(h.legs)) weakLegs.push({ id: h.id, k, ...leg });
    }
    weakLegs.sort((a, b) => a.value - b.value);

    const weakRows = weakLegs
      .slice(0, 8)
      .map((w) => {
        const tone = w.value >= 80 ? "fi-good" : w.value >= 60 ? "fi-warn" : "fi-bad";
        return `<tr><td><strong>${esc(w.id)}</strong></td><td>${esc(w.label)}</td><td class="num ${tone}"><strong>${Math.round(w.value)}</strong></td><td class="fi-muted">${esc(w.detail || "")}</td></tr>`;
      })
      .join("");

    const trendItems = hs
      .map((h) => {
        const r = rollup(h.id);
        return `
          <div class="fi-trend-item">
            <div style="display:flex;justify-content:space-between;align-items:baseline;">
              <strong style="font-family:var(--font-display);font-size:17px;">${esc(h.id)}</strong>
              <span class="fi-muted" style="font-size:11.5px;">D ${r.daily.avg == null ? "—" : Math.round(r.daily.avg)} · W ${r.weekly.avg == null ? "—" : Math.round(r.weekly.avg)} · M ${r.monthly.avg == null ? "—" : Math.round(r.monthly.avg)}</span>
            </div>
            ${svgMiniAreaSpark(r.series)}
          </div>`;
      })
      .join("");

    const repairRows = scopedRepairs
      .map(
        (r) => `
          <tr>
            <td><input type="checkbox" class="fi-checkbox" data-action="toggle-repair" data-id="${esc(r.id)}" ${r.status === "resolved" ? "checked" : ""} aria-label="Toggle repair resolved" /></td>
            <td style="white-space:nowrap;">${fmtShortClock(r.startedAt || r.createdAt)}</td>
            <td><strong>${esc(r.machineId)}</strong></td>
            <td>
              <div style="font-weight:600;${r.status === "resolved" ? "text-decoration:line-through;opacity:0.7;" : ""}">${esc(r.faultTitle)}</div>
              ${r.rootCause ? `<div class="fi-muted" style="font-size:12px;">Cause: ${esc(r.rootCause)}</div>` : ""}
              ${r.actionTaken ? `<div class="fi-muted" style="font-size:12px;">Action: ${esc(r.actionTaken)}</div>` : ""}
            </td>
            <td class="num">${r.downtimeMin}m / ${r.repairMin}m</td>
            <td>${esc(r.technician || "—")}</td>
            <td class="${r.status === "open" ? "fi-bad" : "fi-good"}" style="font-weight:600;">${r.status === "open" ? "Open" : "Resolved"}</td>
            <td class="num"><button type="button" class="fi-link-btn is-danger" data-action="delete-repair" data-id="${esc(r.id)}">Remove</button></td>
          </tr>`
      )
      .join("");

    const vCount = rel.verified.breakdowns;
    const pCount = rel.proxy.failures;
    const totEv = Math.max(1, vCount + pCount);
    const vShare = Math.round((vCount / totEv) * 100);
    const pShare = vCount + pCount > 0 ? 100 - vShare : 50;

    refs.stage.innerHTML = `
      <div class="fi-grid-2">
        <div class="fi-card">
          <div class="fi-whead">
            <div>
              <h3 class="fi-wtitle">Verified repairs VS controller fault proxy</h3>
              <p class="fi-wsub">Honest separation of true maintenance breakdowns vs. alarm/E-STOP assertions</p>
            </div>
            <button type="button" class="fi-btn fi-btn-sm fi-btn-primary" data-action="open-drawer" data-tab="repairs">Log Repair</button>
          </div>
          <div class="fi-vs-grid" style="margin-top:6px;">
            <div class="fi-vs-col">
              <span class="fi-vs-lbl">Verified MTBF / MTTR</span>
              <span class="fi-vs-pct fi-good">${rel.verified.mtbfMs ? fmtDurShort(rel.verified.mtbfMs) : "No logs"}</span>
              <span class="fi-vs-sub">MTTR ${rel.verified.mttrMs ? fmtDurShort(rel.verified.mttrMs) : "—"} · ${vCount} logged (${rel.verified.openCount} open)</span>
            </div>
            <span class="fi-vs-mid">VS</span>
            <div class="fi-vs-col is-right">
              <span class="fi-vs-lbl">Alarm/E-Stop Proxy</span>
              <span class="fi-vs-pct fi-warn">${rel.proxy.mtbfMs ? fmtDurShort(rel.proxy.mtbfMs) : rel.proxy.noFailures ? "No fail" : "—"}</span>
              <span class="fi-vs-sub">MTTR ${rel.proxy.mttrMs ? fmtDurShort(rel.proxy.mttrMs) : "—"} · ${pCount} asserts</span>
            </div>
          </div>
          <div class="fi-vs-bar" style="margin-top:8px;">
            <span class="fi-vs-seg" style="width:${vCount + pCount > 0 ? vShare : 50}%;background:#22c55e"></span>
            <span class="fi-vs-seg" style="width:${vCount + pCount > 0 ? pShare : 50}%;background:#f59e0b"></span>
          </div>
          <div class="fi-divider"></div>
          <div class="fi-table-wrap">
            <table class="fi-table">
              <thead><tr><th>Machine</th><th>Weakest Leg</th><th class="num">Score</th><th>Measured Signal</th></tr></thead>
              <tbody>${weakRows || `<tr><td colspan="4" class="fi-muted">No scored legs yet.</td></tr>`}</tbody>
            </table>
          </div>
        </div>

        <div class="fi-card">
          <div class="fi-whead">
            <div>
              <h3 class="fi-wtitle">5-Axis reliability & health radar</h3>
              <p class="fi-wsub">Availability 30% · Reliability 25% · Tool 20% · Stability 15% · Comms 10%</p>
            </div>
          </div>
          ${svgHealthRadar(HEALTH_AXES, fleetLegAvg, compareVals, compareTarget ? compareTarget.id : "Selected")}
        </div>
      </div>

      <div class="fi-card">
        <div class="fi-whead">
          <div>
            <h3 class="fi-wtitle">Verified breakdown & repair ledger</h3>
            <p class="fi-wsub">Tick the checkbox to mark an open breakdown resolved and update Verified MTTR</p>
          </div>
        </div>
        <div class="fi-table-wrap">
          ${
            scopedRepairs.length
              ? `<table class="fi-table">
                  <thead><tr><th>Done</th><th>Started</th><th>Machine</th><th>Fault & Action</th><th class="num">Down / Repair</th><th>Technician</th><th>Status</th><th class="num">Remove</th></tr></thead>
                  <tbody>${repairRows}</tbody>
                </table>`
              : `<div class="fi-empty">
                   <span>No verified repairs logged yet. Record actual breakdowns and repair minutes for trustworthy MTBF/MTTR.</span>
                   <button type="button" class="fi-btn fi-btn-sm fi-btn-primary" data-action="open-drawer" data-tab="repairs">Log First Repair</button>
                 </div>`
          }
        </div>
      </div>

      <div class="fi-card">
        <div class="fi-whead">
          <div>
            <h3 class="fi-wtitle">Daily · Weekly · Monthly health trends</h3>
            <p class="fi-wsub">Accumulated from real daily machine health snapshots</p>
          </div>
        </div>
        <div class="fi-trend-grid">${trendItems}</div>
      </div>`;
  }

  /* ==================== SUB-TAB 5: PREDICTIVE & EVENT LOG ==================== */
  async function renderPredictiveAndLog() {
    const myToken = token;
    refs.stage.innerHTML = `<div class="fi-card"><div class="fi-empty">Projecting tool-wear slopes, cycle drift & reading chronological logs…</div></div>`;
    const aux = await ensureAuxData();
    if (myToken !== token || sub !== "predictive") return;

    const hs = scopedHealths();
    const { store } = lastData;

    const scopedRisks = selectedMachine ? aux.risks.filter((r) => r.machine === selectedMachine) : aux.risks;
    const mergedEvents = [
      ...aux.events,
      ...store.downtimeLogs.map((l) => ({
        machine: l.machineId,
        ts: l.startTs || l.createdAt,
        kind: "downtime",
        sev: "warn",
        text: `Downtime logged: ${l.reason} (${l.durationMin}m)${l.note ? ` — ${l.note}` : ""}`,
      })),
      ...store.repairLogs.map((r) => ({
        machine: r.machineId,
        ts: r.startedAt || r.createdAt,
        kind: "repair",
        sev: r.status === "open" ? "crit" : "ok",
        text: `Repair [${r.status}]: ${r.faultTitle} (${r.downtimeMin}m down / ${r.repairMin}m repair)${r.technician ? ` · ${r.technician}` : ""}`,
      })),
    ]
      .filter((e) => (!selectedMachine ? true : e.machine === selectedMachine))
      .sort((a, b) => b.ts - a.ts);

    const riskRows = scopedRisks
      .map((p) => {
        const tone = p.sev === "warn" ? "fi-bad" : p.sev === "soon" ? "fi-warn" : "fi-info";
        return `
          <div class="fi-narrative-row">
            <div style="min-width:0;flex:1;">
              <div style="font-weight:600;font-size:13.5px;">${esc(p.machine)} · ${esc(p.title)}</div>
              <div class="fi-narrative-chain">${esc(p.detail || "")}</div>
            </div>
            <div style="text-align:right;white-space:nowrap;">
              <div class="${tone}" style="font-family:var(--font-display);font-size:17px;font-weight:700;">${esc(p.value)}</div>
              ${p.etaMs ? `<div class="fi-muted" style="font-size:11.5px;">${esc(etaLabel(p.etaMs))}</div>` : ""}
            </div>
          </div>`;
      })
      .join("");

    // Tool-wear semi-circle arc gauges
    const wearItems = hs
      .flatMap((h) => (h.wear?.slots || []).map((s) => ({ machine: h.id, ...s })))
      .sort((a, b) => b.mag - a.mag);

    const wearHtml = wearItems.length
      ? wearItems
          .slice(0, 8)
          .map((t) => {
            const pct = Math.min(100, Math.round((t.mag / WEAR_LIMIT) * 100));
            const over = t.mag >= WEAR_LIMIT;
            return `
              <div class="fi-wear-card">
                <div style="font-weight:700;font-size:13.5px;">${esc(t.machine)} · T${t.slot}</div>
                ${svgArcGauge({
                  pct,
                  centerValue: `${pct}%`,
                  subLabel: `${t.mag.toFixed(2)}mm / ${WEAR_LIMIT}mm`,
                  color: over ? "#dc2626" : "#f59e0b",
                  tipTitle: `${t.machine} · Tool T${t.slot}`,
                  tipSub: `Ø${sgn(t.diam)}mm · L${sgn(t.len)}mm (${over ? "Replace now" : "Watch"})`,
                })}
              </div>`;
          })
          .join("")
      : `<div class="fi-empty">All observed tool wear offsets are within the ${WEAR_WARN}mm nominal threshold.</div>`;

    const catBtns = EVENT_CATS.map((c) => {
      const n = c.id === "all" ? mergedEvents.length : mergedEvents.filter((e) => e.kind === c.id).length;
      return `<button type="button" class="fi-cat-btn ${logCategory === c.id ? "is-active" : ""}" data-log-cat="${c.id}">${c.label} (${n})</button>`;
    }).join("");

    refs.stage.innerHTML = `
      <div class="fi-grid-2">
        <div class="fi-card">
          <div class="fi-whead">
            <div>
              <h3 class="fi-wtitle">Predictive risk watchlist</h3>
              <p class="fi-wsub">Theil-Sen tool-wear ETAs, cycle drift, fault climbs & service estimates</p>
            </div>
            <span class="fi-wmeta">${scopedRisks.length} open</span>
          </div>
          ${
            scopedRisks.length
              ? `<div>${riskRows}</div>`
              : `<div class="fi-empty">No signals trending toward a fault in the current window. Switch to 7 d to catch slow wear or drift.</div>`
          }
        </div>

        <div class="fi-card">
          <div class="fi-whead">
            <div>
              <h3 class="fi-wtitle">Tool-wear gauge watch</h3>
              <p class="fi-wsub">Live controller diamwear / lengthwear offsets vs. ${WEAR_LIMIT}mm replace limit</p>
            </div>
          </div>
          <div class="fi-wear-grid">${wearHtml}</div>
        </div>
      </div>

      <div class="fi-card">
        <div class="fi-controls-row">
          <div>
            <h3 class="fi-wtitle">Unified chronological event feed</h3>
            <p class="fi-wsub">Controller alarms, E-Stops, holds, program/tool swaps, plus logged downtime & repairs</p>
          </div>
          <input type="search" class="fi-search-input" data-f="logSearch" placeholder="Search alarms, machines, programs…" value="${esc(logQuery)}" />
        </div>
        <div class="fi-log-filters" data-f="logCats">${catBtns}</div>
        <div class="fi-log-list" data-f="logList"></div>
      </div>`;

    const logListEl = refs.stage.querySelector('[data-f="logList"]');
    const searchEl = refs.stage.querySelector('[data-f="logSearch"]');
    const catsEl = refs.stage.querySelector('[data-f="logCats"]');

    function paintLogRows() {
      const q = logQuery.trim().toLowerCase();
      const filtered = mergedEvents.filter((e) => {
        if (logCategory !== "all" && e.kind !== logCategory) return false;
        if (q && !`${e.machine} ${e.kind} ${e.text}`.toLowerCase().includes(q)) return false;
        return true;
      });
      if (!filtered.length) {
        logListEl.innerHTML = `<div class="fi-empty">No events match the active filter.</div>`;
        return;
      }
      logListEl.innerHTML = filtered
        .slice(0, 200)
        .map((e) => {
          const tone = e.sev === "crit" ? "fi-bad" : e.sev === "warn" ? "fi-warn" : e.sev === "ok" ? "fi-good" : "fi-info";
          return `
            <div class="fi-log-row">
              <span class="fi-muted">${fmtShortClock(e.ts)}</span>
              <strong>${esc(e.machine)}</strong>
              <span class="fi-log-kind ${tone}" style="font-weight:600;">${esc(e.kind)}</span>
              <span>${esc(e.text)}</span>
            </div>`;
        })
        .join("");
    }

    paintLogRows();
    if (searchEl) {
      searchEl.addEventListener("input", () => {
        logQuery = searchEl.value;
        paintLogRows();
      });
    }
    if (catsEl) {
      catsEl.addEventListener("click", (ev) => {
        const b = ev.target.closest("[data-log-cat]");
        if (!b) return;
        logCategory = b.dataset.logCat;
        catsEl.querySelectorAll(".fi-cat-btn").forEach((el) => el.classList.toggle("is-active", el === b));
        paintLogRows();
      });
    }
  }

  /* ==================== SLIDE-OVER SHOP-FLOOR LOG DRAWER ==================== */
  function renderDrawer() {
    const machines = lastData?.machines || [];
    const store = lastData?.store || fleetStore.getCached();
    const activeMc = drawerMachine || machines[0]?.machine_id || "VMC-01";
    const curTarget = store.targets[activeMc] || {};

    const mcOpts = machines
      .map(
        (m) =>
          `<option value="${esc(m.machine_id)}" ${m.machine_id === activeMc ? "selected" : ""}>${esc(m.machine_name || m.machine_id)}</option>`
      )
      .join("");

    const shiftOpts = [
      `<option value="">Select shift (optional)</option>`,
      ...SHIFT_DEFS.map(
        (s) => `<option value="${esc(s.label)}" ${curTarget.shiftLabel === s.label ? "selected" : ""}>${esc(s.label)}</option>`
      ),
    ].join("");

    let formHtml = "";
    if (drawerTab === "targets") {
      formHtml = `
        <form data-f="drawerForm" novalidate style="display:flex;flex-direction:column;gap:14px;">
          <div class="fi-field"><label for="fiTgtMc">Machine</label><select id="fiTgtMc" name="machineId">${mcOpts}</select></div>
          <div class="fi-field-row">
            <div class="fi-field"><label for="fiTgtParts">Shift Part Target (pcs)</label><input id="fiTgtParts" name="shiftTargetParts" type="number" min="1" max="100000" placeholder="e.g. 32" value="${curTarget.shiftTargetParts ?? ""}" /></div>
            <div class="fi-field"><label for="fiTgtRate">Target Rate (parts/hr)</label><input id="fiTgtRate" name="targetPartsPerHour" type="number" step="0.1" min="0.1" max="5000" placeholder="e.g. 4.0" value="${curTarget.targetPartsPerHour ?? ""}" /></div>
          </div>
          <div class="fi-field"><label for="fiTgtJob">Active Job / Work Order</label><input id="fiTgtJob" name="activeJob" type="text" maxlength="80" placeholder="e.g. WO-4821 · Batch B" value="${esc(curTarget.activeJob || "")}" /></div>
          <div class="fi-field-row">
            <div class="fi-field"><label for="fiTgtOp">Operator</label><input id="fiTgtOp" name="operator" type="text" maxlength="60" placeholder="Operator name" value="${esc(curTarget.operator || "")}" /></div>
            <div class="fi-field"><label for="fiTgtShift">Shift</label><select id="fiTgtShift" name="shiftLabel">${shiftOpts}</select></div>
          </div>
          <div class="fi-form-err" data-f="formErr"></div>
          <div style="display:flex;justify-content:flex-end;gap:10px;">
            <button type="button" class="fi-btn" data-dact="close">Cancel</button>
            <button type="submit" class="fi-btn fi-btn-primary">Save Target</button>
          </div>
        </form>`;
    } else if (drawerTab === "downtime") {
      const reasonOpts = DOWNTIME_REASONS.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("");
      formHtml = `
        <form data-f="drawerForm" novalidate style="display:flex;flex-direction:column;gap:14px;">
          <div class="fi-field"><label for="fiDtMc">Machine</label><select id="fiDtMc" name="machineId">${mcOpts}</select></div>
          <div class="fi-field-row">
            <div class="fi-field"><label for="fiDtReason">Root-Cause Category</label><select id="fiDtReason" name="reason">${reasonOpts}</select></div>
            <div class="fi-field"><label for="fiDtDur">Lost Duration (min)</label><input id="fiDtDur" name="durationMin" type="number" min="1" max="10080" required value="30" /></div>
          </div>
          <div class="fi-field-row">
            <div class="fi-field"><label for="fiDtOp">Operator</label><input id="fiDtOp" name="operator" type="text" maxlength="60" placeholder="Operator name" /></div>
            <div class="fi-field"><label for="fiDtShift">Shift</label><select id="fiDtShift" name="shiftLabel">${shiftOpts}</select></div>
          </div>
          <div class="fi-field"><label for="fiDtNote">Evidence / Shop-Floor Note</label><textarea id="fiDtNote" name="note" maxlength="400" placeholder="e.g. Waiting for aluminum billet batch from stores"></textarea></div>
          <div class="fi-form-err" data-f="formErr"></div>
          <div style="display:flex;justify-content:flex-end;gap:10px;">
            <button type="button" class="fi-btn" data-dact="close">Cancel</button>
            <button type="submit" class="fi-btn fi-btn-primary">Save Downtime Log</button>
          </div>
        </form>`;
    } else {
      formHtml = `
        <form data-f="drawerForm" novalidate style="display:flex;flex-direction:column;gap:14px;">
          <div class="fi-field"><label for="fiRpMc">Machine</label><select id="fiRpMc" name="machineId">${mcOpts}</select></div>
          <div class="fi-field"><label for="fiRpFault">Breakdown / Fault Title</label><input id="fiRpFault" name="faultTitle" type="text" maxlength="120" required placeholder="e.g. ATC arm proximity sensor fault" /></div>
          <div class="fi-field-row">
            <div class="fi-field"><label for="fiRpDown">Total Downtime (min)</label><input id="fiRpDown" name="downtimeMin" type="number" min="0" max="43200" required value="45" /></div>
            <div class="fi-field"><label for="fiRpRep">Active Repair (min)</label><input id="fiRpRep" name="repairMin" type="number" min="0" max="43200" required value="30" /></div>
          </div>
          <div class="fi-field-row">
            <div class="fi-field"><label for="fiRpTech">Technician</label><input id="fiRpTech" name="technician" type="text" maxlength="60" placeholder="Technician name" /></div>
            <div class="fi-field"><label for="fiRpStatus">Status</label><select id="fiRpStatus" name="status"><option value="open">Open / In Progress</option><option value="resolved">Resolved</option></select></div>
          </div>
          <div class="fi-field"><label for="fiRpCause">Verified Root Cause</label><input id="fiRpCause" name="rootCause" type="text" maxlength="160" placeholder="e.g. Loose sensor bracket" /></div>
          <div class="fi-field"><label for="fiRpParts">Parts / Tools Replaced</label><input id="fiRpParts" name="partsReplaced" type="text" maxlength="160" placeholder="e.g. Omron M12 switch" /></div>
          <div class="fi-field"><label for="fiRpAction">Corrective Action</label><textarea id="fiRpAction" name="actionTaken" maxlength="400" placeholder="Steps taken to restore machine"></textarea></div>
          <div class="fi-form-err" data-f="formErr"></div>
          <div style="display:flex;justify-content:flex-end;gap:10px;">
            <button type="button" class="fi-btn" data-dact="close">Cancel</button>
            <button type="submit" class="fi-btn fi-btn-primary">Save Repair Log</button>
          </div>
        </form>`;
    }

    refs.drawer.innerHTML = `
      <div class="fi-drawer-head">
        <h3 class="fi-drawer-title">Shop-Floor Evidence & Targets</h3>
        <button type="button" class="fi-link-btn" data-dact="close" aria-label="Close drawer">Close ✕</button>
      </div>
      <div class="fi-drawer-tabs" role="tablist">
        <button type="button" class="fi-dtab ${drawerTab === "targets" ? "is-active" : ""}" data-dtab="targets">Shift Targets</button>
        <button type="button" class="fi-dtab ${drawerTab === "downtime" ? "is-active" : ""}" data-dtab="downtime">Downtime Cause</button>
        <button type="button" class="fi-dtab ${drawerTab === "repairs" ? "is-active" : ""}" data-dtab="repairs">Breakdown & Repair</button>
      </div>
      <div class="fi-drawer-body">${formHtml}</div>`;

    refs.drawer.querySelectorAll("[data-dact='close']").forEach((b) => b.addEventListener("click", closeDrawer));
    refs.drawer.querySelectorAll("[data-dtab]").forEach((b) =>
      b.addEventListener("click", () => {
        drawerTab = b.dataset.dtab;
        renderDrawer();
      })
    );

    if (drawerTab === "targets") {
      const sel = refs.drawer.querySelector("#fiTgtMc");
      if (sel) {
        sel.addEventListener("change", () => {
          drawerMachine = sel.value;
          renderDrawer();
        });
      }
    }

    const form = refs.drawer.querySelector('[data-f="drawerForm"]');
    const errEl = refs.drawer.querySelector('[data-f="formErr"]');
    if (form) {
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        errEl.textContent = "";
        const fd = new FormData(form);
        try {
          if (drawerTab === "targets") {
            const mc = String(fd.get("machineId") || "");
            const shiftTargetParts = fd.get("shiftTargetParts") ? Number(fd.get("shiftTargetParts")) : null;
            const targetPartsPerHour = fd.get("targetPartsPerHour") ? Number(fd.get("targetPartsPerHour")) : null;
            if (shiftTargetParts != null && (!Number.isFinite(shiftTargetParts) || shiftTargetParts < 1)) {
              errEl.textContent = "Enter a valid positive shift target.";
              return;
            }
            if (targetPartsPerHour != null && (!Number.isFinite(targetPartsPerHour) || targetPartsPerHour <= 0)) {
              errEl.textContent = "Enter a valid positive target rate.";
              return;
            }
            await fleetStore.saveTarget(mc, {
              shiftTargetParts,
              targetPartsPerHour,
              activeJob: String(fd.get("activeJob") || "").trim(),
              operator: String(fd.get("operator") || "").trim(),
              shiftLabel: String(fd.get("shiftLabel") || "").trim(),
            });
            showToast(`Saved shift target for ${mc}`);
          } else if (drawerTab === "downtime") {
            const mc = String(fd.get("machineId") || "");
            const reason = String(fd.get("reason") || "");
            const durationMin = Number(fd.get("durationMin"));
            if (!Number.isFinite(durationMin) || durationMin < 1) {
              errEl.textContent = "Duration must be at least 1 minute.";
              return;
            }
            await fleetStore.addDowntime({
              machineId: mc,
              reason,
              durationMin,
              startTs: Date.now() - durationMin * 60000,
              operator: String(fd.get("operator") || "").trim(),
              shiftLabel: String(fd.get("shiftLabel") || "").trim(),
              note: String(fd.get("note") || "").trim(),
            });
            showToast(`Logged ${durationMin}m ${reason} on ${mc}`);
          } else {
            const mc = String(fd.get("machineId") || "");
            const faultTitle = String(fd.get("faultTitle") || "").trim();
            const downtimeMin = Number(fd.get("downtimeMin"));
            const repairMin = Number(fd.get("repairMin"));
            if (!faultTitle) {
              errEl.textContent = "Breakdown fault title is required.";
              return;
            }
            if (!Number.isFinite(downtimeMin) || downtimeMin < 0 || !Number.isFinite(repairMin) || repairMin < 0) {
              errEl.textContent = "Downtime and repair minutes must be 0 or greater.";
              return;
            }
            await fleetStore.addRepair({
              machineId: mc,
              faultTitle,
              rootCause: String(fd.get("rootCause") || "").trim(),
              actionTaken: String(fd.get("actionTaken") || "").trim(),
              partsReplaced: String(fd.get("partsReplaced") || "").trim(),
              downtimeMin,
              repairMin,
              technician: String(fd.get("technician") || "").trim(),
              status: String(fd.get("status") || "open"),
              startedAt: Date.now() - downtimeMin * 60000,
            });
            showToast(`Logged repair on ${mc}`);
          }

          if (lastData) lastData.store = fleetStore.getCached();
          auxCache = null;
          closeDrawer();
          renderCurrent();
        } catch (err) {
          errEl.textContent = err.message || "Could not save entry.";
        }
      });
    }
  }

  function destroy() {
    window.removeEventListener("keydown", onKeyDown);
    themeObserver.disconnect();
    if (toastTimer) clearTimeout(toastTimer);
  }

  return { refresh, destroy };
}

/* ==================== FORMATTING HELPERS ==================== */
function sgn(v) {
  const n = Number(v) || 0;
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
}

function etaLabel(ms) {
  const d = ms - Date.now();
  if (d <= 0) return "overdue";
  const h = d / 3600000;
  if (h < 48) return `in ${fmtHours(h)}`;
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

function fmtShortClock(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtTimeHM(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
