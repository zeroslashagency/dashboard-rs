/* VMC Production Timeline — High-Speed 8-Machine Studio Schedule.
 *
 * Dual-theme (Light & Dark) matching Fleet Intelligence, fitting all 8 VMC
 * lanes cleanly on one screen with:
 *   - Live right-aligned framing (92% real history + 8% live breathing edge)
 *   - Dirty-flagged ResizeObserver canvas rendering (zero mousemove redraws)
 *   - Synchronized vertical crosshair across all 8 lanes + floating ruler chip
 *   - Clickable idle/hold/alarm/offline gaps with direct Fleet Intelligence
 *     downtime cause logging (/api/fleet/downtime)
 *   - Click-to-expand inline Spindle Speed (RPM) & Feed Override (%) trace
 *   - Shift presets (1h | 4h | Shift | 24h | 7d | 30d) & IST shift handovers
 *   - Event pins (Alarm/E-Stop, Feed-Hold/Override, Program) on every lane
 *   - Explicit zoom controls (- / + / Fit) & interactive overview minimap
 */

import { fleetStore } from "./fleetStoreClient.js";
import { DOWNTIME_REASONS } from "./fleetCore.js";
import {
  IST_OFFSET_MS,
  NORMAL_DEV,
  WIDE_DEV,
  computeCurrentIstShift,
  computeIstDayBoundaries,
  computeShiftBoundaries,
  computeMinimapBins,
  extractLaneGaps,
  fmtClockIST,
  fmtClockSecIST,
  fmtDayIST,
  fmtDurCompact,
  fmtIsoDateIST,
  partDeviationKind,
  shiftLabelForTs,
  summarizeFleetWindow,
  summarizeLaneWindow,
} from "./timelineCore.js";

const PRESETS = [
  { key: "1h", label: "1h", ms: 3600e3 },
  { key: "4h", label: "4h", ms: 4 * 3600e3 },
  { key: "shift", label: "Shift", ms: 8 * 3600e3, isShift: true },
  { key: "24h", label: "24h", ms: 24 * 3600e3 },
  { key: "7d", label: "7d", ms: 7 * 86400e3 },
  { key: "30d", label: "30d", ms: 30 * 86400e3 },
];
const PRESET_MAP = Object.fromEntries(PRESETS.map((p) => [p.key, p]));
const LEGACY_RANGE_MAP = { hour: "1h", day: "24h", week: "7d", month: "30d" };

const MIN_SPAN = 10 * 60e3;       // 10 minutes
const MAX_SPAN = 45 * 86400e3;    // 45 days
const RIGHT_PAD_FRAC = 0.08;      // 92% real history + 8% live breathing edge

const LS_RANGE = "vmc_tl_range_v2";
const LS_FILTER = "vmc_tl_machines";
const LS_SNAP = "vmc_tl_snap_v2";
const SNAP_MAX_BYTES = 3_500_000;

const escHtml = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

function isLightTheme() {
  return document.documentElement.getAttribute("data-theme") === "light";
}

function loadSel() {
  try {
    const raw = localStorage.getItem(LS_FILTER);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length ? new Set(arr) : null;
  } catch {
    return null;
  }
}

function saveSel(set) {
  try {
    if (!set || !set.size) localStorage.removeItem(LS_FILTER);
    else localStorage.setItem(LS_FILTER, JSON.stringify([...set]));
  } catch {}
}

function loadSnapshot() {
  try {
    const raw = localStorage.getItem(LS_SNAP);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (!snap || !Array.isArray(snap.machines) || Date.now() - snap.savedAt > 12 * 3600e3) return null;
    return snap;
  } catch {
    return null;
  }
}

function saveSnapshot(snap) {
  try {
    const json = JSON.stringify(snap);
    if (json.length > SNAP_MAX_BYTES) return;
    localStorage.setItem(LS_SNAP, json);
  } catch {}
}

function statusLabel(st) {
  const s = String(st || "").toLowerCase();
  if (s === "running") return "Cutting";
  if (s === "paused") return "Feed-Hold";
  if (s === "alarm") return "Alarm";
  if (s === "offline") return "Offline";
  return "Idle";
}

function progHue(name) {
  if (!name) return 220;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

function roundRect(g, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

export function mountTimeline(body, dataLayer) {
  const savedRaw = localStorage.getItem(LS_RANGE) || localStorage.getItem("vmc_tl_range") || "4h";
  const initKey = PRESET_MAP[savedRaw] ? savedRaw : (LEGACY_RANGE_MAP[savedRaw] || "4h");
  const initPreset = PRESET_MAP[initKey] || PRESET_MAP["4h"];

  body.innerHTML = `
    <div class="tl2-root" data-f="root">
      <section class="tl2-kpi-strip" data-f="kpiStrip">
        <div class="tl2-kpi">
          <div class="tl2-kpi-main">
            <span class="tl2-kpi-k">Fleet Cutting Utilization</span>
            <span class="tl2-kpi-v" data-f="kpiUtil">—</span>
            <span class="tl2-kpi-sub" data-f="kpiUtilSub">Loading machines…</span>
          </div>
          <div class="tl2-kpi-bar"><span data-f="kpiUtilBar" style="width:0%"></span></div>
        </div>
        <div class="tl2-kpi">
          <div class="tl2-kpi-main">
            <span class="tl2-kpi-k">Parts in Window</span>
            <span class="tl2-kpi-v" data-f="kpiParts">—</span>
            <span class="tl2-kpi-sub" data-f="kpiPartsSub">—</span>
          </div>
        </div>
        <div class="tl2-kpi">
          <div class="tl2-kpi-main">
            <span class="tl2-kpi-k">Non-Cutting Loss</span>
            <span class="tl2-kpi-v" data-f="kpiLoss">—</span>
            <span class="tl2-kpi-sub" data-f="kpiLossSub">Idle · Feed-Hold · Alarm</span>
          </div>
        </div>
        <div class="tl2-kpi">
          <div class="tl2-kpi-main">
            <span class="tl2-kpi-k">Incidents &amp; Logged Gaps</span>
            <span class="tl2-kpi-v" data-f="kpiInc">—</span>
            <span class="tl2-kpi-sub" data-f="kpiIncSub">Click any gap to log cause</span>
          </div>
        </div>
      </section>

      <section class="tl2-board" data-f="board">
        <div class="tl2-toolbar">
          <div class="tl2-tb-left">
            <div class="tl2-seg" data-f="presets"></div>
            <button type="button" class="tl2-btn tl2-btn-icon" data-f="prev" title="Scroll back">◀</button>
            <button type="button" class="tl2-btn is-live" data-f="now" title="Jump to live edge">Now</button>
            <button type="button" class="tl2-btn tl2-btn-icon" data-f="next" title="Scroll forward">▶</button>
            <button type="button" class="tl2-btn tl2-btn-icon" data-f="zoomOut" title="Zoom out">−</button>
            <button type="button" class="tl2-btn tl2-btn-icon" data-f="zoomIn" title="Zoom in">+</button>
            <button type="button" class="tl2-btn" data-f="fitShift" title="Fit current IST shift">Fit Shift</button>
            <label class="tl2-btn tl2-datebtn" title="Jump to date">
              <span>Date</span>
              <input type="date" class="tl2-date-input" data-f="datePick" />
            </label>
          </div>
          <div class="tl2-tb-right">
            <span class="tl2-loading" data-f="loading" hidden><i class="tl2-spin"></i>syncing…</span>
            <span class="tl2-win-readout is-live" data-f="winLabel">—</span>
            <div class="tl2-filter" data-f="filterWrap">
              <button type="button" class="tl2-btn" data-f="filterBtn" aria-haspopup="true" aria-expanded="false">
                <span data-f="filterLabel">All machines</span><span>▾</span>
              </button>
              <div class="tl2-filter-menu" data-f="filterMenu" hidden></div>
            </div>
          </div>
        </div>

        <div class="tl2-legend-bar">
          <div class="tl2-legend-group">
            <span class="tl2-legend-item"><i class="tl2-sw tl2-sw-normal"></i>Normal cycle</span>
            <span class="tl2-legend-item"><i class="tl2-sw tl2-sw-high"></i>Slow +15%</span>
            <span class="tl2-legend-item"><i class="tl2-sw tl2-sw-over"></i>Over +30%</span>
            <span class="tl2-legend-item"><i class="tl2-sw tl2-sw-low"></i>Short</span>
            <span class="tl2-legend-item"><i class="tl2-sw tl2-sw-live"></i>Live</span>
          </div>
          <div class="tl2-legend-group">
            <span class="tl2-legend-item"><i class="tl2-sw tl2-sw-idle"></i>Idle gap</span>
            <span class="tl2-legend-item"><i class="tl2-sw tl2-sw-paused"></i>Feed-Hold</span>
            <span class="tl2-legend-item"><i class="tl2-sw tl2-sw-alarm"></i>Alarm / E-Stop</span>
            <span class="tl2-legend-item"><i class="tl2-sw tl2-sw-offline"></i>Offline</span>
            <span class="tl2-legend-item"><i class="tl2-pin-sw tl2-pin-crit"></i>Event pin</span>
          </div>
        </div>

        <div class="tl2-stage" data-f="stage">
          <div class="tl2-ruler-row">
            <div class="tl2-ruler-gutter">
              <span>Machine</span>
              <span>Cut %</span>
            </div>
            <div class="tl2-ruler-track" data-f="rulerTrack">
              <canvas class="tl2-axis" data-f="axis"></canvas>
              <div class="tl2-xhair-time" data-f="xhairTime" hidden>—</div>
            </div>
          </div>

          <div class="tl2-lanes-wrap" data-f="lanesWrap">
            <div class="tl2-xhair-line" data-f="xhairLine" hidden></div>
            <div data-f="lanesHost"></div>
          </div>

          <div class="tl2-minimap-row">
            <div class="tl2-minimap-gutter">
              <span>Fleet Overview</span>
              <span data-f="minimapSpan">—</span>
            </div>
            <div class="tl2-minimap-track" data-f="minimapTrack">
              <canvas class="tl2-minimap-canvas" data-f="minimapCanvas"></canvas>
              <div class="tl2-brush" data-f="brush" hidden></div>
            </div>
          </div>
        </div>

        <div class="tl2-status-note" data-f="note" role="status" aria-live="polite">Loading 8-machine production timeline…</div>
      </section>

      <div class="tl2-callout" data-f="callout" hidden></div>

      <div class="tl2-drawer-backdrop" data-f="drawerBackdrop" hidden>
        <aside class="tl2-drawer" data-f="drawer" role="dialog" aria-modal="true">
          <div class="tl2-drawer-head">
            <div>
              <h3 class="tl2-drawer-title" data-f="drawerTitle">Details</h3>
              <div class="tl2-drawer-sub" data-f="drawerSub"></div>
            </div>
            <button type="button" class="tl2-btn tl2-btn-icon" data-f="drawerClose" title="Close">×</button>
          </div>
          <div class="tl2-drawer-body" data-f="drawerBody"></div>
        </aside>
      </div>
    </div>
  `;

  const refs = {};
  body.querySelectorAll("[data-f]").forEach((el) => {
    refs[el.dataset.f] = el;
  });

  const ctx = {
    presetKey: initPreset.key,
    spanMs: initPreset.ms,
    live: true,                       // LIVE right-aligned by default — eliminates empty half!
    anchor: Date.now() + initPreset.ms * RIGHT_PAD_FRAC,
    machines: [],
    sel: loadSel(),
    wallOrder: null,
    lanes: new Map(),                 // id -> lane DOM + hit-test caches
    expanded: new Set(),              // expanded machine IDs for Spindle + Override trace
    seriesCache: new Map(),           // `${id}|${bucketKey}` -> { sspeed, fdovrd, at }
    over: new Map(),                  // id -> live overview record
    events: new Map(),                // id -> ascending events[]
    dataCache: new Map(),             // id -> { parts, groups, bands, truncated }
    bulkCache: new Map(),             // key -> { ts, byMachine }
    downtimeLogs: fleetStore.getCached().downtimeLogs || [],
    cover: { from: 0, to: 0, has: false },
    bufLoaded: false,
    token: 0,
    trackW: 900,
    laneH: 60,
    dragging: false,
    didPan: false,
    panStartX: 0,
    panLastX: 0,
    dirtyAxis: true,
    dirtyLanes: true,
    dirtyMinimap: true,
    dirtySummary: true,
    dirtyExpand: true,
    rafId: null,
    liveTimer: null,
    destroyed: false,
    drawerItem: null,
  };

  const inflight = new Set();
  let loadingCount = 0;
  let bufTimer = null;
  let zoomTimer = null;
  let evBusy = false;
  let evKey = "";
  let liveBusy = false;
  let offlinePatternDark = null;
  let offlinePatternLight = null;

  function markDirty(opts = {}) {
    if (opts.all || opts.axis) ctx.dirtyAxis = true;
    if (opts.all || opts.lanes) ctx.dirtyLanes = true;
    if (opts.all || opts.minimap) ctx.dirtyMinimap = true;
    if (opts.all || opts.summary) ctx.dirtySummary = true;
    if (opts.all || opts.expand) ctx.dirtyExpand = true;
    scheduleFrame();
  }

  function scheduleFrame() {
    if (ctx.destroyed || ctx.rafId != null) return;
    ctx.rafId = requestAnimationFrame(() => {
      ctx.rafId = null;
      if (ctx.destroyed) return;
      if (!refs.board || !refs.board.offsetParent) return;
      renderDirty();
    });
  }

  function showLoading(on) {
    loadingCount = Math.max(0, loadingCount + (on ? 1 : -1));
    if (refs.loading) refs.loading.hidden = loadingCount === 0;
  }

  function windowSpan() {
    const span = ctx.spanMs;
    const to = ctx.live ? Date.now() + span * RIGHT_PAD_FRAC : ctx.anchor;
    return { from: to - span, to, span };
  }

  function maxFutureAnchor(span) {
    return Date.now() + span * RIGHT_PAD_FRAC;
  }

  // ---- Presets ----
  for (const p of PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tl2-seg-btn";
    btn.dataset.p = p.key;
    btn.textContent = p.label;
    btn.addEventListener("click", () => applyPreset(p.key));
    refs.presets.appendChild(btn);
  }

  function syncPresetBtns() {
    const match = PRESETS.find((p) => !p.isShift && Math.abs(p.ms - ctx.spanMs) < p.ms * 0.025);
    const shiftMatch = ctx.presetKey === "shift" && Math.abs(ctx.spanMs - 8 * 3600e3) < 120e3;
    refs.presets.querySelectorAll(".tl2-seg-btn").forEach((b) => {
      const isAct = shiftMatch ? b.dataset.p === "shift" : (!!match && b.dataset.p === match.key);
      b.classList.toggle("is-active", isAct);
    });
    refs.now.classList.toggle("is-live", ctx.live);
  }

  function applyPreset(key, silent = false) {
    const p = PRESET_MAP[key];
    if (!p) return;
    ctx.presetKey = p.key;
    if (!silent) {
      try { localStorage.setItem(LS_RANGE, p.key); } catch {}
    }
    if (p.isShift) {
      const sh = computeCurrentIstShift(Date.now());
      ctx.spanMs = sh.to - sh.from;
      ctx.live = false;
      ctx.anchor = sh.to;
    } else {
      ctx.spanMs = p.ms;
      ctx.live = true;
      ctx.anchor = maxFutureAnchor(ctx.spanMs);
    }
    ctx.cover.has = false;
    syncPresetBtns();
    paintWinLabel();
    markDirty({ all: true });
    loadBuffer(true);
    refreshExpandedSeries();
  }

  function jumpToNow() {
    ctx.live = true;
    ctx.anchor = maxFutureAnchor(ctx.spanMs);
    syncPresetBtns();
    paintWinLabel();
    markDirty({ all: true });
    ensureBuffer(false);
    refreshExpandedSeries();
  }

  function panByMs(dtMs) {
    const span = ctx.spanMs;
    const base = ctx.live ? maxFutureAnchor(span) : ctx.anchor;
    const cap = maxFutureAnchor(span);
    let next = base + dtMs;
    if (next >= cap - 1500) {
      ctx.live = true;
      ctx.anchor = cap;
    } else {
      ctx.live = false;
      ctx.anchor = next;
    }
    syncPresetBtns();
    paintWinLabel();
    markDirty({ all: true });
    ensureBuffer(false);
  }

  function panByPx(dxPx) {
    if (!ctx.trackW) return;
    panByMs(-(dxPx / ctx.trackW) * ctx.spanMs);
  }

  function zoomBy(factor, fracX = 0.5) {
    const oldSpan = ctx.spanMs;
    const next = Math.max(MIN_SPAN, Math.min(MAX_SPAN, oldSpan * factor));
    if (Math.abs(next - oldSpan) < 100) return;
    const f = Math.max(0, Math.min(1, fracX));
    const { from } = windowSpan();
    const pivot = from + f * oldSpan;
    let newTo = pivot + (1 - f) * next;
    const cap = maxFutureAnchor(next);
    ctx.spanMs = next;
    ctx.presetKey = "";
    if (newTo >= cap - 1500) {
      ctx.live = true;
      ctx.anchor = cap;
    } else {
      ctx.live = false;
      ctx.anchor = newTo;
    }
    syncPresetBtns();
    paintWinLabel();
    markDirty({ all: true });
    if (zoomTimer) clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      ensureBuffer(true);
      refreshExpandedSeries();
    }, 180);
  }

  function jumpToDate(yyyyMmDd) {
    if (!yyyyMmDd) return;
    const [y, mo, d] = yyyyMmDd.split("-").map(Number);
    if (!y || !mo || !d) return;
    const dayStartUtc = Date.UTC(y, mo - 1, d) - IST_OFFSET_MS;
    const center = dayStartUtc + 12 * 3600e3;
    const cap = maxFutureAnchor(ctx.spanMs);
    const to = Math.min(cap, center + ctx.spanMs * 0.5);
    ctx.live = to >= cap - 1500;
    ctx.anchor = to;
    ctx.cover.has = false;
    syncPresetBtns();
    paintWinLabel();
    markDirty({ all: true });
    loadBuffer(true);
    refreshExpandedSeries();
  }

  refs.prev.addEventListener("click", () => panByMs(-ctx.spanMs * 0.45));
  refs.next.addEventListener("click", () => panByMs(ctx.spanMs * 0.45));
  refs.now.addEventListener("click", jumpToNow);
  refs.zoomIn.addEventListener("click", () => zoomBy(0.62, 0.8));
  refs.zoomOut.addEventListener("click", () => zoomBy(1.6, 0.8));
  refs.fitShift.addEventListener("click", () => applyPreset("shift"));
  refs.datePick.addEventListener("change", (e) => jumpToDate(e.target.value));

  // ---- Machine filter ----
  const isVisible = (id) => !ctx.sel || ctx.sel.has(id);

  function filterLabelText() {
    if (!ctx.sel || !ctx.sel.size) return "All machines";
    const vis = ctx.machines.filter((m) => ctx.sel.has(m.id));
    if (vis.length === ctx.machines.length) return "All machines";
    if (vis.length === 1) return vis[0].name;
    return `${vis.length} machines`;
  }

  function buildFilterMenu() {
    const allOn = !ctx.sel || ctx.sel.size === ctx.machines.length;
    const rows = ctx.machines.map(({ id, name }) => {
      const on = isVisible(id);
      return `<label class="tl2-filter-opt"><input type="checkbox" data-mid="${escHtml(id)}" ${on ? "checked" : ""}><span>${escHtml(name)}</span></label>`;
    }).join("");
    refs.filterMenu.innerHTML = `
      <label class="tl2-filter-opt"><input type="checkbox" data-mid="__all__" ${allOn ? "checked" : ""}><strong>All machines</strong></label>
      <div class="tl2-filter-divider"></div>
      ${rows}
    `;
    refs.filterMenu.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const mid = e.target.dataset.mid;
        if (mid === "__all__") {
          ctx.sel = e.target.checked ? null : new Set();
        } else {
          const set = ctx.sel ? new Set(ctx.sel) : new Set(ctx.machines.map((m) => m.id));
          if (e.target.checked) set.add(mid);
          else set.delete(mid);
          ctx.sel = set.size === ctx.machines.length ? null : set;
        }
        saveSel(ctx.sel);
        buildFilterMenu();
        syncVisibleLanes();
      });
    });
    refs.filterLabel.textContent = filterLabelText();
  }

  function toggleFilterMenu(open) {
    const show = open == null ? refs.filterMenu.hidden : open;
    refs.filterMenu.hidden = !show;
    refs.filterBtn.setAttribute("aria-expanded", String(show));
  }
  refs.filterBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFilterMenu();
  });
  const onDocClick = (e) => {
    if (!refs.filterWrap.contains(e.target)) toggleFilterMenu(false);
  };
  document.addEventListener("click", onDocClick);

  // ---- Axis drag-to-zoom ----
  {
    let active = false;
    let grabX = 0;
    let grabFrac = 0.5;
    let startSpan = 0;
    let pivot = 0;
    let moved = false;
    refs.axis.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      active = true;
      moved = false;
      grabX = e.clientX;
      const w = refs.axis.clientWidth || 1;
      grabFrac = Math.max(0, Math.min(1, e.offsetX / w));
      startSpan = ctx.spanMs;
      const { from } = windowSpan();
      pivot = from + grabFrac * startSpan;
      try { refs.axis.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });
    refs.axis.addEventListener("pointermove", (e) => {
      if (!active) return;
      const w = refs.axis.clientWidth || 1;
      const dx = e.clientX - grabX;
      if (Math.abs(dx) > 2) moved = true;
      const next = Math.max(MIN_SPAN, Math.min(MAX_SPAN, startSpan * Math.exp(-(dx / w) * 1.15)));
      let newTo = pivot + (1 - grabFrac) * next;
      const cap = maxFutureAnchor(next);
      ctx.spanMs = next;
      ctx.presetKey = "";
      if (newTo >= cap - 1500) {
        ctx.live = true;
        ctx.anchor = cap;
      } else {
        ctx.live = false;
        ctx.anchor = newTo;
      }
      syncPresetBtns();
      paintWinLabel();
      markDirty({ all: true });
    });
    const end = (e) => {
      if (!active) return;
      active = false;
      try { refs.axis.releasePointerCapture(e.pointerId); } catch {}
      if (moved) {
        ensureBuffer(true);
        refreshExpandedSeries();
      }
    };
    refs.axis.addEventListener("pointerup", end);
    refs.axis.addEventListener("pointercancel", end);
  }

  // ---- Window label ----
  function paintWinLabel() {
    const { from, to } = windowSpan();
    const effTo = ctx.live ? Date.now() : to;
    const sameDay = fmtDayIST(from) === fmtDayIST(effTo);
    const left = sameDay ? fmtClockIST(from) : `${fmtDayIST(from)} ${fmtClockIST(from)}`;
    const right = ctx.live ? "now" : (sameDay ? fmtClockIST(effTo) : `${fmtDayIST(effTo)} ${fmtClockIST(effTo)}`);
    const head = sameDay ? `${fmtDayIST(from)} · ` : "";
    refs.winLabel.textContent = `${head}${left} → ${right} IST`;
    refs.winLabel.classList.toggle("is-live", ctx.live);
    if (refs.datePick) refs.datePick.value = fmtIsoDateIST((from + effTo) / 2);
  }

  // ---- Synchronized 8-lane crosshair (zero canvas redraw!) ----
  function updateCrosshair(clientX) {
    const trackRect = refs.rulerTrack.getBoundingClientRect();
    if (!trackRect.width) return;
    const relX = clientX - trackRect.left;
    if (relX < 0 || relX > trackRect.width) {
      hideCrosshair();
      return;
    }
    const { from, span } = windowSpan();
    const ts = from + (relX / trackRect.width) * span;
    refs.xhairLine.style.transform = `translateX(${Math.round(relX)}px)`;
    refs.xhairLine.hidden = false;
    refs.xhairTime.textContent = fmtClockSecIST(ts);
    const clampedChipX = Math.max(40, Math.min(trackRect.width - 40, relX));
    refs.xhairTime.style.left = `${clampedChipX}px`;
    refs.xhairTime.hidden = false;
  }

  function hideCrosshair() {
    refs.xhairLine.hidden = true;
    refs.xhairTime.hidden = true;
    refs.callout.hidden = true;
  }

  // ---- Lane lifecycle (fits all 8 machines cleanly + inline expandable telemetry strip) ----
  function computeLaneHeight() {
    const n = Math.max(1, ctx.lanes.size || 8);
    const vh = window.innerHeight || 900;
    // Budget for 8 lanes + KPI strip + toolbar + legend + ruler + minimap on desktop
    const reserved = 305;
    const avail = Math.max(54 * n, vh - reserved);
    const ideal = Math.floor(avail / n);
    return Math.max(54, Math.min(72, ideal));
  }

  function ensureLane(id, name) {
    let lane = ctx.lanes.get(id);
    if (lane) {
      lane.name = name || id;
      lane.nameEl.textContent = lane.name;
      return lane;
    }

    const groupEl = document.createElement("div");
    groupEl.className = "tl2-lane-group";
    groupEl.dataset.mid = id;

    const rowEl = document.createElement("div");
    rowEl.className = "tl2-lane-row";

    const gutter = document.createElement("button");
    gutter.type = "button";
    gutter.className = "tl2-gutter";
    gutter.title = "Click to expand spindle speed & feed override trace";
    gutter.innerHTML = `
      <div class="tl2-g-left">
        <div class="tl2-mhead">
          <span class="tl2-mname"></span>
          <span class="tl2-mstate st-idle">—</span>
        </div>
        <div class="tl2-mmeta">—</div>
      </div>
      <div class="tl2-g-right">
        <span class="tl2-mutil">—</span>
        <span class="tl2-mchev">▾</span>
      </div>
    `;
    gutter.querySelector(".tl2-mname").textContent = name || id;

    const canvas = document.createElement("canvas");
    canvas.className = "tl2-lane-canvas";

    rowEl.appendChild(gutter);
    rowEl.appendChild(canvas);

    const expandRow = document.createElement("div");
    expandRow.className = "tl2-expand-row";
    expandRow.hidden = !ctx.expanded.has(id);
    expandRow.innerHTML = `
      <div class="tl2-expand-gutter">
        <div class="tl2-expand-title">Live Telemetry Trace</div>
        <div class="tl2-expand-kv"><span>Spindle</span><strong data-ef="rpm">—</strong></div>
        <div class="tl2-expand-kv"><span>Feed Ovr</span><strong data-ef="feed">—</strong></div>
        <div class="tl2-expand-kv"><span>Tool</span><strong data-ef="tool">—</strong></div>
        <div class="tl2-expand-legend">
          <span style="color:var(--tl2-cobalt)">━ RPM</span>
          <span style="color:var(--tl2-amber)">━ Feed %</span>
        </div>
      </div>
      <canvas class="tl2-expand-canvas"></canvas>
    `;

    groupEl.appendChild(rowEl);
    groupEl.appendChild(expandRow);
    refs.lanesHost.appendChild(groupEl);

    lane = {
      id,
      name: name || id,
      groupEl,
      rowEl,
      gutter,
      nameEl: gutter.querySelector(".tl2-mname"),
      stateEl: gutter.querySelector(".tl2-mstate"),
      metaEl: gutter.querySelector(".tl2-mmeta"),
      utilEl: gutter.querySelector(".tl2-mutil"),
      canvas,
      g: null,
      expandRow,
      expandCanvas: expandRow.querySelector(".tl2-expand-canvas"),
      expandG: null,
      efRpm: expandRow.querySelector('[data-ef="rpm"]'),
      efFeed: expandRow.querySelector('[data-ef="feed"]'),
      efTool: expandRow.querySelector('[data-ef="tool"]'),
      parts: [],
      groups: [],
      bands: [],
      truncated: false,
      hitParts: [],
      hitGroups: [],
      hitGaps: [],
      hitPins: [],
      summary: null,
    };

    gutter.addEventListener("click", () => toggleExpand(id));
    canvas.addEventListener("mousemove", (e) => {
      updateCrosshair(e.clientX);
      if (!ctx.dragging) onLaneHover(e, id);
    });
    canvas.addEventListener("mouseleave", () => {
      if (!ctx.dragging) hideCrosshair();
    });
    canvas.addEventListener("click", (e) => {
      if (!ctx.didPan) onLaneClick(e, id);
    });
    expandRow.querySelector(".tl2-expand-canvas").addEventListener("mousemove", (e) => {
      updateCrosshair(e.clientX);
    });
    expandRow.querySelector(".tl2-expand-canvas").addEventListener("mouseleave", hideCrosshair);
    attachPanAndZoom(canvas);

    ctx.lanes.set(id, lane);
    return lane;
  }

  function removeLane(id) {
    const lane = ctx.lanes.get(id);
    if (!lane) return;
    lane.groupEl.remove();
    ctx.lanes.delete(id);
  }

  function syncVisibleLanes() {
    for (const { id, name } of ctx.machines) {
      if (isVisible(id)) {
        const lane = ensureLane(id, name);
        const cached = ctx.dataCache.get(id);
        if (cached && !lane.parts.length && !lane.bands.length) {
          lane.parts = cached.parts || [];
          lane.groups = cached.groups || [];
          lane.bands = cached.bands || [];
          lane.truncated = !!cached.truncated;
        }
      } else {
        removeLane(id);
      }
    }
    for (const id of [...ctx.lanes.keys()]) {
      if (!ctx.machines.some((m) => m.id === id)) removeLane(id);
    }
    syncCanvasSizes();
    markDirty({ all: true });
    ensureBuffer(false);
  }

  function toggleExpand(id) {
    const lane = ctx.lanes.get(id);
    if (!lane) return;
    if (ctx.expanded.has(id)) {
      ctx.expanded.delete(id);
      lane.groupEl.classList.remove("is-expanded");
      lane.expandRow.hidden = true;
    } else {
      ctx.expanded.add(id);
      lane.groupEl.classList.add("is-expanded");
      lane.expandRow.hidden = false;
      syncCanvasSizes();
      loadMachineSeries(id);
    }
    markDirty({ expand: true });
  }

  // ---- Pan & Zoom on lane canvases ----
  function attachPanAndZoom(canvas) {
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      ctx.dragging = true;
      ctx.didPan = false;
      ctx.panStartX = e.clientX;
      ctx.panLastX = e.clientX;
      refs.board.classList.add("is-panning");
      refs.callout.hidden = true;
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!ctx.dragging) return;
      const dx = e.clientX - ctx.panLastX;
      ctx.panLastX = e.clientX;
      if (Math.abs(e.clientX - ctx.panStartX) > 4) ctx.didPan = true;
      if (dx) panByPx(dx);
    });
    const end = (e) => {
      if (!ctx.dragging) return;
      ctx.dragging = false;
      refs.board.classList.remove("is-panning");
      try { canvas.releasePointerCapture(e.pointerId); } catch {}
      if (ctx.didPan) {
        ensureBuffer(false);
        refreshExpandedSeries();
      }
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("wheel", (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const fracX = (e.offsetX || 0) / Math.max(1, canvas.clientWidth || 1);
        zoomBy(Math.exp(e.deltaY * 0.0016), fracX);
        return;
      }
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
      if (!dx) return;
      e.preventDefault();
      panByPx(-dx);
    }, { passive: false });
  }

  // ---- Canvas sizing via ResizeObserver (no layout thrashing!) ----
  function setupCanvas(cv, w, h) {
    const dpr = window.devicePixelRatio || 1;
    const tw = Math.max(1, Math.round(w * dpr));
    const th = Math.max(1, Math.round(h * dpr));
    if (cv.width !== tw || cv.height !== th) {
      cv.width = tw;
      cv.height = th;
    }
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return g;
  }

  function syncCanvasSizes() {
    const trackW = refs.rulerTrack ? refs.rulerTrack.clientWidth : 800;
    if (trackW > 40) ctx.trackW = trackW;
    ctx.laneH = computeLaneHeight();

    refs.axisG = setupCanvas(refs.axis, ctx.trackW, 30);
    refs.minimapG = setupCanvas(refs.minimapCanvas, ctx.trackW, 40);

    for (const lane of ctx.lanes.values()) {
      lane.canvas.style.height = `${ctx.laneH}px`;
      lane.rowEl.style.minHeight = `${ctx.laneH}px`;
      lane.g = setupCanvas(lane.canvas, ctx.trackW, ctx.laneH);
      if (ctx.expanded.has(lane.id)) {
        lane.expandG = setupCanvas(lane.expandCanvas, ctx.trackW, 116);
      }
    }
  }

  const ro = typeof ResizeObserver !== "undefined"
    ? new ResizeObserver(() => {
        if (ctx.destroyed) return;
        syncCanvasSizes();
        markDirty({ all: true });
      })
    : null;
  if (ro && refs.rulerTrack) ro.observe(refs.rulerTrack);

  // ---- Smart Buffer Fetching (tight 0.5x left runway instead of 5x over-fetch) ----
  const LIVE_TTL = 4000;
  const CACHE_BUCKET = 30e3;
  function bulkKey(f, t) {
    return `${Math.round(f / CACHE_BUCKET)}:${Math.round(t / CACHE_BUCKET)}`;
  }

  function mergeInto(lane, got) {
    const partKey = (p) => `${Math.round(p.t0 / 1000)}|${p.job}`;
    const pMap = new Map((lane.parts || []).map((p) => [partKey(p), p]));
    for (const p of got.parts || []) pMap.set(partKey(p), p);
    lane.parts = [...pMap.values()].sort((a, b) => a.t0 - b.t0);

    const gMap = new Map((lane.groups || []).map((g) => [g.groupId, g]));
    for (const g of got.groups || []) {
      const prev = gMap.get(g.groupId);
      if (prev) {
        gMap.set(g.groupId, {
          ...prev,
          t0: Math.min(prev.t0, g.t0),
          t1: Math.max(prev.t1, g.t1),
          count: Math.max(prev.count, g.count),
        });
      } else {
        gMap.set(g.groupId, g);
      }
    }
    lane.groups = [...gMap.values()].sort((a, b) => a.t0 - b.t0);

    const bMap = new Map((lane.bands || []).map((b) => [`${Math.round(b.t0 / 1000)}|${Math.round(b.t1 / 1000)}|${b.status}`, b]));
    for (const b of got.bands || []) {
      if (b && Number.isFinite(b.t0) && Number.isFinite(b.t1)) {
        bMap.set(`${Math.round(b.t0 / 1000)}|${Math.round(b.t1 / 1000)}|${b.status}`, b);
      }
    }
    lane.bands = [...bMap.values()].sort((a, b) => a.t0 - b.t0);
    if (got.truncated) lane.truncated = true;
  }

  function applyBulk(byMachine, evWin, merge) {
    for (const { id } of ctx.machines) {
      const got = byMachine.get(id);
      if (!got) continue;
      const lane = ctx.lanes.get(id);
      if (merge && lane) {
        mergeInto(lane, got);
        ctx.dataCache.set(id, { parts: lane.parts, groups: lane.groups, bands: lane.bands, truncated: lane.truncated });
      } else {
        const clean = { parts: got.parts || [], groups: got.groups || [], bands: got.bands || [], truncated: !!got.truncated };
        ctx.dataCache.set(id, clean);
        if (lane) {
          lane.parts = clean.parts;
          lane.groups = clean.groups;
          lane.bands = clean.bands;
          lane.truncated = clean.truncated;
        }
      }
    }
    if (evWin) loadEvents(evWin.from, evWin.to);
  }

  function growCover(f, t, merge) {
    if (merge && ctx.cover.has) {
      const nf = Math.min(ctx.cover.from, f);
      const nt = Math.max(ctx.cover.to, t);
      const grew = nf < ctx.cover.from || nt > ctx.cover.to;
      ctx.cover.from = nf;
      ctx.cover.to = nt;
      return grew;
    }
    ctx.cover = { from: f, to: t, has: true };
    return true;
  }

  function ensureBuffer(force) {
    if (force) {
      ctx.cover.has = false;
      if (bufTimer) clearTimeout(bufTimer);
      bufTimer = setTimeout(() => loadBuffer(true), 0);
      return;
    }
    const { from, to, span } = windowSpan();
    if (!ctx.cover.has) {
      if (bufTimer) clearTimeout(bufTimer);
      bufTimer = setTimeout(() => loadBuffer(false), 0);
      return;
    }
    const nowClamped = Date.now() - 8e3;
    const nearLeft = from - ctx.cover.from < span * 0.28;
    const nearRight = ctx.cover.to < nowClamped && ctx.cover.to - Math.min(to, nowClamped) < span * 0.25;
    if (!nearLeft && !nearRight) return;
    if (bufTimer) clearTimeout(bufTimer);
    bufTimer = setTimeout(() => loadBuffer(false), 110);
  }

  async function loadBuffer(force) {
    if (ctx.destroyed) return;
    // TV wall mode: pin to active IST shift
    if (window.__VMC_TV__) {
      try {
        const ov = await dataLayer.overview();
        const first = (ov.machines || [])[0];
        const sh = first && first.shift_summary;
        if (sh && sh.from && sh.to) {
          window.__vmcTvTimelineRefresh = () => loadBuffer(true);
          const bulk = await dataLayer.timelineBulk(sh.from, sh.to);
          applyBulk(new Map(bulk.lanes.map((l) => [l.machine, l])), { from: sh.from, to: sh.to }, false);
          ctx.cover = { from: sh.from, to: sh.to, has: true };
          ctx.bufLoaded = true;
          refs.note.hidden = true;
          markDirty({ all: true });
          return;
        }
      } catch {}
    }

    const { from, to, span } = windowSpan();
    const nowMs = Date.now();
    // Tight smart runway: 0.5x left + 0.25x right (clamped to now) -> 3x faster than old 5x fetch!
    let bFrom = from - span * 0.5;
    let bTo = Math.min(to + span * 0.25, nowMs + 15e3);

    const merge = !force && ctx.cover.has;
    if (merge) {
      if (bFrom >= ctx.cover.from && bTo <= ctx.cover.to) return;
      if (bFrom < ctx.cover.from && (ctx.cover.from - bFrom) >= (bTo - ctx.cover.to)) {
        bTo = ctx.cover.from;
      } else if (bTo > ctx.cover.to) {
        bFrom = ctx.cover.to;
      } else {
        bTo = ctx.cover.from;
      }
    }
    if (bTo <= bFrom + 5000) return;

    const key = bulkKey(bFrom, bTo);
    if (inflight.has(key)) return;
    const my = force ? ++ctx.token : ctx.token;

    const isLiveWin = ctx.live || nowMs - to < 60e3;
    const hit = ctx.bulkCache.get(key);
    if (hit && (!isLiveWin || nowMs - hit.ts < LIVE_TTL)) {
      applyBulk(hit.byMachine, { from: bFrom, to: bTo }, merge);
      growCover(bFrom, bTo, merge);
      ctx.bufLoaded = true;
      refs.note.hidden = true;
      markDirty({ all: true });
      return;
    }

    inflight.add(key);
    showLoading(true);
    try {
      const bulk = await dataLayer.timelineBulk(bFrom, bTo);
      if (ctx.destroyed) return;
      if (!merge && my !== ctx.token) return;
      const byMachine = new Map(bulk.lanes.map((l) => [l.machine, l]));
      ctx.bulkCache.set(key, { ts: Date.now(), byMachine });
      if (ctx.bulkCache.size > 48) {
        const oldest = ctx.bulkCache.keys().next().value;
        ctx.bulkCache.delete(oldest);
      }
      applyBulk(byMachine, { from: bFrom, to: bTo }, merge);
      growCover(bFrom, bTo, merge);
      ctx.bufLoaded = true;
      refs.note.hidden = true;
      persistSnapshot();
      markDirty({ all: true });
    } catch (err) {
      if (!ctx.bufLoaded) {
        const isTimeout = err && (err.name === "AbortError" || String(err.message || "").includes("aborted"));
        refs.note.textContent = isTimeout
          ? "Timeline syncing slowly — retrying automatically…"
          : `Timeline unavailable: ${(err && err.message) || "connection error"}`;
        refs.note.hidden = false;
      }
    } finally {
      inflight.delete(key);
      showLoading(false);
    }
  }

  async function loadEvents(fromMs, toMs) {
    if (evBusy || ctx.destroyed) return;
    const key = bulkKey(fromMs, toMs);
    const isLiveWin = Date.now() - toMs < 60e3;
    if (key === evKey && !isLiveWin) return;
    evBusy = true;
    try {
      const evs = await dataLayer.events(fromMs, toMs);
      if (ctx.destroyed) return;
      const byM = new Map();
      for (const e of evs) {
        if (!byM.has(e.machine)) byM.set(e.machine, []);
        byM.get(e.machine).push(e);
      }
      for (const arr of byM.values()) arr.sort((a, b) => a.ts - b.ts);
      ctx.events = byM;
      evKey = key;
      markDirty({ lanes: true, summary: true });
    } catch {}
    finally {
      evBusy = false;
    }
  }

  // ---- Expanded Spindle Speed + Feed Override Trace Loader ----
  async function loadMachineSeries(id) {
    const { from, to } = windowSpan();
    const effTo = Math.min(to, Date.now());
    const cacheKey = `${id}|${bulkKey(from, effTo)}`;
    const hit = ctx.seriesCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 20_000) {
      markDirty({ expand: true });
      return;
    }
    try {
      const [sspeed, fdovrd] = await Promise.all([
        dataLayer.series(id, "sspeed", from, effTo, { buckets: 180 }),
        dataLayer.series(id, "fdovrd", from, effTo, { buckets: 180 }),
      ]);
      if (ctx.destroyed) return;
      ctx.seriesCache.set(cacheKey, { at: Date.now(), from, to: effTo, sspeed, fdovrd });
      // Also store latest reference on lane for instant pan rendering
      const lane = ctx.lanes.get(id);
      if (lane) lane.series = { from, to: effTo, sspeed, fdovrd };
      markDirty({ expand: true });
    } catch {}
  }

  function refreshExpandedSeries() {
    for (const id of ctx.expanded) loadMachineSeries(id);
  }

  // ---- Bootstrap & Live 1Hz Tick ----
  async function loadOverviewAndBoot(forceBuffer) {
    const my = ++ctx.token;
    paintWinLabel();
    syncPresetBtns();
    try {
      const [ov, storeState] = await Promise.all([
        dataLayer.overview(),
        fleetStore.load().catch(() => fleetStore.getCached()),
      ]);
      if (ctx.destroyed || my !== ctx.token) return;
      ctx.downtimeLogs = Array.isArray(storeState?.downtimeLogs) ? storeState.downtimeLogs : [];
      const machines = (Array.isArray(ov.machines) ? ov.machines : []).map((m) => ({
        id: m.machine_id,
        name: m.machine_name || m.machine_id,
        m,
      }));
      if (!machines.length) {
        refs.note.textContent = "No machines reported by the collector.";
        refs.note.hidden = false;
        return;
      }
      if (ctx.wallOrder) {
        const rank = {};
        ctx.wallOrder.forEach((id, i) => { if (!(id in rank)) rank[id] = i; });
        machines.sort((a, b) => (rank[a.id] ?? 1e9) - (rank[b.id] ?? 1e9));
      }
      ctx.machines = machines;
      ctx.over = new Map(machines.map((x) => [x.id, x.m]));
      if (ctx.sel) {
        const liveIds = new Set(machines.map((m) => m.id));
        ctx.sel = new Set([...ctx.sel].filter((id) => liveIds.has(id)));
        if (!ctx.sel.size || ctx.sel.size === machines.length) ctx.sel = null;
      }
      buildFilterMenu();
      syncVisibleLanes();
      await loadBuffer(forceBuffer);
    } catch (err) {
      if (!ctx.machines.length) {
        refs.note.textContent = "Collector unreachable — retrying…";
        refs.note.hidden = false;
      }
    }
  }

  async function liveTick() {
    if (liveBusy || ctx.destroyed || ctx.dragging) return;
    if (!refs.board || !refs.board.offsetParent) return;
    liveBusy = true;
    try {
      const ov = await dataLayer.overview();
      if (ctx.destroyed) return;
      ctx.over = new Map((ov.machines || []).map((m) => [m.machine_id, m]));
      if (ctx.live) {
        paintWinLabel();
        markDirty({ axis: true, lanes: true, minimap: true, summary: true, expand: ctx.expanded.size > 0 });
      } else {
        // Even when viewing history, keep gutter live states updated
        markDirty({ summary: true });
      }
    } catch {}
    finally {
      liveBusy = false;
    }
  }

  // ---- Snapshot Hydration ----
  function hydrateFromSnapshot() {
    const snap = loadSnapshot();
    if (!snap) return;
    try {
      ctx.machines = snap.machines.map((m) => ({ id: m.id, name: m.name }));
      for (const m of snap.machines) {
        const d = snap.data && snap.data[m.id];
        if (d) ctx.dataCache.set(m.id, { parts: d.parts || [], groups: d.groups || [], bands: d.bands || [], truncated: !!d.truncated });
      }
      if (snap.events) {
        const evM = new Map();
        for (const [mid, arr] of Object.entries(snap.events)) evM.set(mid, arr);
        ctx.events = evM;
      }
      if (snap.cover && snap.cover.from && snap.cover.to) {
        ctx.cover = { from: snap.cover.from, to: snap.cover.to, has: true };
        ctx.bufLoaded = true;
      }
      buildFilterMenu();
      syncVisibleLanes();
      refs.note.hidden = true;
    } catch {}
  }

  function persistSnapshot() {
    try {
      const data = {};
      for (const { id } of ctx.machines) {
        const d = ctx.dataCache.get(id);
        if (d) data[id] = { parts: d.parts, groups: d.groups, bands: d.bands, truncated: d.truncated };
      }
      const events = {};
      for (const [mid, arr] of ctx.events) events[mid] = arr;
      saveSnapshot({
        savedAt: Date.now(),
        cover: ctx.cover.has ? { from: ctx.cover.from, to: ctx.cover.to } : null,
        machines: ctx.machines.map((m) => ({ id: m.id, name: m.name })),
        data,
        events,
      });
    } catch {}
  }

  // ==================== RENDERING ENGINE (DIRTY-FLAGGED) ====================

  function tickStep(span) {
    const M = 60e3;
    const H = 3600e3;
    const D = 86400e3;
    if (span <= 45 * M) return { step: 5 * M, fmt: fmtClockIST };
    if (span <= 2 * H) return { step: 15 * M, fmt: fmtClockIST };
    if (span <= 6 * H) return { step: 30 * M, fmt: fmtClockIST };
    if (span <= 14 * H) return { step: H, fmt: fmtClockIST };
    if (span <= 2 * D) return { step: 3 * H, fmt: fmtClockIST };
    if (span <= 9 * D) return { step: D, fmt: (ms) => fmtDayIST(ms).replace(/,.*/, "") };
    return { step: 7 * D, fmt: (ms) => fmtDayIST(ms).replace(/,.*/, "") };
  }

  function getOfflinePattern(g, light) {
    if (light && offlinePatternLight) return offlinePatternLight;
    if (!light && offlinePatternDark) return offlinePatternDark;
    const p = document.createElement("canvas");
    p.width = 10;
    p.height = 10;
    const pg = p.getContext("2d");
    pg.fillStyle = light ? "rgba(148,163,184,0.14)" : "rgba(100,116,139,0.16)";
    pg.fillRect(0, 0, 10, 10);
    pg.strokeStyle = light ? "rgba(100,116,139,0.28)" : "rgba(148,163,184,0.24)";
    pg.lineWidth = 1.5;
    pg.beginPath();
    pg.moveTo(-2, 10);
    pg.lineTo(10, -2);
    pg.moveTo(4, 12);
    pg.lineTo(12, 4);
    pg.stroke();
    const pat = g.createPattern(p, "repeat");
    if (light) offlinePatternLight = pat;
    else offlinePatternDark = pat;
    return pat;
  }

  function paintAxis(from, to, span) {
    const g = refs.axisG;
    const w = ctx.trackW;
    if (!g || !w) return;
    const light = isLightTheme();
    g.clearRect(0, 0, w, 30);
    const x = (ts) => ((ts - from) / span) * w;

    // Regular time ticks
    const { step, fmt } = tickStep(span);
    g.font = "11px ui-monospace, monospace";
    g.textBaseline = "middle";
    let t = Math.ceil(from / step) * step;
    let lastLabelX = -100;
    for (; t <= to; t += step) {
      const px = Math.round(x(t)) + 0.5;
      g.strokeStyle = light ? "rgba(15,23,42,0.14)" : "rgba(255,255,255,0.13)";
      g.beginPath();
      g.moveTo(px, 18);
      g.lineTo(px, 30);
      g.stroke();
      if (px - lastLabelX >= 52 && px < w - 34) {
        g.fillStyle = light ? "#475569" : "#94a3b8";
        g.fillText(fmt(t), px + 4, 12);
        lastLabelX = px;
      }
    }

    // IST Shift handover tags (S1 06:00, S2 14:00, S3 22:00) when span <= 3 days
    if (span <= 3 * 86400e3) {
      const shifts = computeShiftBoundaries(from, to);
      for (const s of shifts) {
        const px = Math.round(x(s.ts)) + 0.5;
        g.strokeStyle = light ? "rgba(109,40,217,0.45)" : "rgba(139,92,246,0.55)";
        g.beginPath();
        g.moveTo(px, 0);
        g.lineTo(px, 30);
        g.stroke();
        g.fillStyle = light ? "#6d28d9" : "#a78bfa";
        g.font = "700 10px ui-monospace, monospace";
        g.fillText(s.code, px + 4, 23);
      }
    }

    // Midnight IST day boundaries
    for (const d of computeIstDayBoundaries(from, to)) {
      const px = Math.round(x(d)) + 0.5;
      g.strokeStyle = light ? "#dc2626" : "#f43f5e";
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(px, 0);
      g.lineTo(px, 30);
      g.stroke();
      g.lineWidth = 1;
      g.fillStyle = light ? "#dc2626" : "#fb7185";
      g.font = "700 10.5px ui-monospace, monospace";
      g.fillText(fmtDayIST(d).replace(/,.*/, ""), px + 5, 11);
    }

    // NOW obsidian pill marker on ruler
    const nowMs = Date.now();
    if (nowMs >= from && nowMs <= to) {
      const px = Math.round(x(nowMs));
      g.strokeStyle = "#f59e0b";
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(px, 0);
      g.lineTo(px, 30);
      g.stroke();
      g.lineWidth = 1;
      const chipW = 36;
      const chipX = Math.max(2, Math.min(w - chipW - 2, px - chipW / 2));
      g.fillStyle = "#0a0d14";
      roundRect(g, chipX, 4, chipW, 18, 5);
      g.fill();
      g.fillStyle = "#fbbf24";
      g.font = "700 10px ui-monospace, monospace";
      g.textAlign = "center";
      g.fillText("NOW", chipX + chipW / 2, 14);
      g.textAlign = "left";
    }
  }

  function paintLane(lane, from, to, span, shifts, days) {
    const g = lane.g;
    const w = ctx.trackW;
    const H = ctx.laneH;
    if (!g || !w) return;

    const light = isLightTheme();
    g.clearRect(0, 0, w, H);
    const x = (ts) => ((ts - from) / span) * w;

    // Clean 2-strata track geometry:
    //   Top rail (y: 4..18)   -> program run strip + event pins
    //   Main track (y: 22..H-6) -> crisp state gaps + part cycle bars
    const railY = 4;
    const railH = 14;
    const barY = 22;
    const barH = Math.max(20, H - barY - 6);

    lane.hitParts = [];
    lane.hitGroups = [];
    lane.hitGaps = [];
    lane.hitPins = [];

    // Subtle track groove
    g.fillStyle = light ? "#f8fafc" : "rgba(255,255,255,0.025)";
    roundRect(g, 0, barY, w, barH, 6);
    g.fill();

    // Subtle vertical time gridlines
    const { step } = tickStep(span);
    let gt = Math.ceil(from / step) * step;
    g.strokeStyle = light ? "rgba(15,23,42,0.055)" : "rgba(255,255,255,0.055)";
    g.lineWidth = 1;
    for (; gt <= to; gt += step) {
      const px = Math.round(x(gt)) + 0.5;
      g.beginPath();
      g.moveTo(px, 0);
      g.lineTo(px, H);
      g.stroke();
    }

    // Shade future zone cleanly past NOW
    const nowMs = Date.now();
    if (nowMs < to) {
      const nx = Math.max(0, x(nowMs));
      g.fillStyle = light ? "rgba(15,23,42,0.025)" : "rgba(255,255,255,0.02)";
      g.fillRect(nx, 0, Math.max(0, w - nx), H);
    }

    // 1. Inspectable Non-Cutting Gaps inside the main bar track
    const mEvents = ctx.events.get(lane.id) || [];
    const gaps = extractLaneGaps(lane.id, lane.bands, lane.parts, from, Math.min(to, nowMs), ctx.downtimeLogs, mEvents);
    const GAP_FILL = light
      ? {
          idle: "rgba(148,163,184,0.22)",
          paused: "rgba(245,158,11,0.22)",
          alarm: "rgba(239,68,68,0.24)",
          unknown: "rgba(148,163,184,0.18)",
        }
      : {
          idle: "rgba(148,163,184,0.16)",
          paused: "rgba(245,158,11,0.24)",
          alarm: "rgba(244,63,94,0.26)",
          unknown: "rgba(148,163,184,0.14)",
        };
    const GAP_STROKE = {
      idle: light ? "rgba(100,116,139,0.28)" : "rgba(148,163,184,0.25)",
      paused: light ? "rgba(217,119,6,0.55)" : "rgba(245,158,11,0.55)",
      alarm: light ? "rgba(220,38,38,0.62)" : "rgba(244,63,94,0.68)",
      offline: light ? "rgba(100,116,139,0.35)" : "rgba(148,163,184,0.30)",
    };

    for (const gap of gaps) {
      const x0 = Math.max(0, x(gap.t0));
      const x1 = Math.min(w, x(gap.t1));
      const ww = Math.max(3, x1 - x0);
      if (gap.status === "offline") {
        g.fillStyle = getOfflinePattern(g, light);
      } else {
        g.fillStyle = GAP_FILL[gap.status] || GAP_FILL.idle;
      }
      roundRect(g, x0 + 0.5, barY + 1, Math.max(2, ww - 1), barH - 2, 4);
      g.fill();
      g.strokeStyle = GAP_STROKE[gap.status] || GAP_STROKE.idle;
      g.lineWidth = 1;
      g.stroke();

      // If downtime reason is logged, stamp a crisp cobalt accounted dot + label if wide enough
      if (gap.logged) {
        g.fillStyle = light ? "#2563eb" : "#60a5fa";
        g.beginPath();
        g.arc(x0 + Math.min(ww / 2, 7), barY + 7, 3, 0, Math.PI * 2);
        g.fill();
        if (ww > 66) {
          g.save();
          g.beginPath();
          g.rect(x0 + 12, barY, ww - 15, barH);
          g.clip();
          g.font = "600 10.5px var(--font-body), sans-serif";
          g.textBaseline = "middle";
          g.fillStyle = light ? "#1e3a8a" : "#bfdbfe";
          g.fillText(gap.logged.reason, x0 + 13, barY + barH / 2);
          g.restore();
        }
      } else if (gap.status === "offline" && ww > 54) {
        g.save();
        g.beginPath();
        g.rect(x0 + 4, barY, ww - 8, barH);
        g.clip();
        g.font = "600 10.5px ui-monospace, monospace";
        g.textBaseline = "middle";
        g.fillStyle = light ? "#475569" : "#94a3b8";
        g.fillText("OFFLINE", x0 + 8, barY + barH / 2);
        g.restore();
      }

      lane.hitGaps.push({ x0, x1: x0 + ww, y0: barY, y1: barY + barH, gap });
    }

    // 2. Top Program Group Strips (clean clipped pills on top rail)
    g.font = "600 10.5px ui-monospace, monospace";
    g.textBaseline = "middle";
    for (const grp of lane.groups || []) {
      if (grp.t1 < from || grp.t0 > to) continue;
      const x0 = Math.max(0, x(grp.t0));
      const x1 = Math.min(w, x(grp.t1));
      const ww = Math.max(3, x1 - x0);
      const hue = progHue(grp.program);
      g.fillStyle = light ? `hsla(${hue}, 58%, 92%, 0.95)` : `hsla(${hue}, 52%, 52%, 0.18)`;
      roundRect(g, x0, railY, ww, railH, 3);
      g.fill();
      g.strokeStyle = light ? `hsla(${hue}, 52%, 62%, 0.48)` : `hsla(${hue}, 62%, 64%, 0.42)`;
      g.lineWidth = 1;
      g.stroke();

      if (ww > 54) {
        const cleanName = String(grp.program || "—").replace(/\.nc$/i, "");
        const txt = `${cleanName} · ${grp.count}`;
        g.save();
        g.beginPath();
        g.rect(x0 + 3, railY, ww - 6, railH);
        g.clip();
        g.fillStyle = light ? `hsla(${hue}, 65%, 28%, 0.96)` : `hsla(${hue}, 78%, 84%, 0.95)`;
        g.fillText(txt, x0 + 5, railY + railH / 2 + 0.5);
        g.restore();
      }
      lane.hitGroups.push({ x0, x1: x0 + ww, y0: railY, y1: railY + railH, grp });
    }

    // 3. Part Cycle Bars (strictly clipped job numbers!)
    const BAR_COL = light
      ? {
          normal: "#16a34a",
          high: "#d97706",
          over: "#dc2626",
          low: "#0284c7",
          neutral: "#64748b",
          partial: "#94a3b8",
        }
      : {
          normal: "#22c55e",
          high: "#f59e0b",
          over: "#ef4444",
          low: "#38bdf8",
          neutral: "#64748b",
          partial: "#475569",
        };

    for (const p of lane.parts || []) {
      if (p.t1 < from || p.t0 > to) continue;
      const rawX0 = Math.max(0, x(p.t0));
      const rawX1 = Math.min(w, x(p.t1));
      const ww = Math.max(2.5, rawX1 - rawX0 - (rawX1 - rawX0 > 6 ? 1.5 : 0));
      const kind = partDeviationKind(p);
      g.fillStyle = BAR_COL[kind] || BAR_COL.normal;
      g.globalAlpha = p.partial ? 0.55 : 0.94;
      roundRect(g, rawX0, barY + 1, ww, barH - 2, 4);
      g.fill();
      g.globalAlpha = 1;

      // Clipped compact job number inside bar (never overflows!)
      if (ww >= 20 && p.job != null) {
        const jobStr = typeof p.job === "number" ? `#${p.job}` : String(p.job).slice(0, 8);
        g.save();
        g.beginPath();
        g.rect(rawX0 + 2, barY + 1, ww - 4, barH - 2);
        g.clip();
        g.fillStyle = "#ffffff";
        g.font = "700 11px ui-monospace, monospace";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(jobStr, rawX0 + ww / 2, barY + barH / 2 + 0.5);
        g.textAlign = "left";
        g.restore();
      }
      lane.hitParts.push({ x0: rawX0, x1: rawX0 + ww, y0: barY, y1: barY + barH, p, kind });
    }

    // 4. Live In-Progress Edge Bar (when NOW is inside visible window)
    const mo = ctx.over.get(lane.id);
    if (mo && nowMs >= from && nowMs <= to) {
      const elapsed = Number(mo.cycle && mo.cycle.this_cycle);
      const active = String(mo.execution || "").toUpperCase() === "ACTIVE" || String(mo.status || "").toLowerCase() === "running";
      if (mo.online !== false && Number.isFinite(elapsed) && elapsed > 0) {
        const t0 = nowMs - elapsed * 1000;
        const x0 = Math.max(0, x(t0));
        const x1 = Math.min(w, x(nowMs));
        const ww = Math.max(3, x1 - x0);
        g.save();
        g.fillStyle = active ? (light ? "#2563eb" : "#3b82f6") : "#64748b";
        g.globalAlpha = active ? 0.9 : 0.45;
        roundRect(g, x0, barY + 1, ww, barH - 2, 4);
        g.fill();
        g.globalAlpha = 1;
        if (ww >= 34 && active) {
          g.beginPath();
          g.rect(x0 + 2, barY + 1, ww - 4, barH - 2);
          g.clip();
          g.fillStyle = "#ffffff";
          g.font = "700 10.5px ui-monospace, monospace";
          g.textAlign = "center";
          g.textBaseline = "middle";
          g.fillText("LIVE", x0 + ww / 2, barY + barH / 2 + 0.5);
          g.textAlign = "left";
        }
        g.restore();
        lane.hitParts.push({ x0, x1: x0 + ww, y0: barY, y1: barY + barH, live: true, m: mo });
      }
    }

    // 5. Event Pins along the top rail (Alarm/E-Stop, Feed-Hold/Override, Program)
    for (const ev of mEvents) {
      if (!ev || ev.ts < from || ev.ts > to) continue;
      const px = x(ev.ts);
      const py = railY + railH / 2;
      const isCrit = ev.rule === "estop" || ev.rule === "offline" || ev.sev === "CRITICAL";
      const isWarn = ev.rule === "override" || ev.rule === "feed_hold" || ev.sev === "WARNING";
      const col = isCrit ? "#ef4444" : isWarn ? "#f59e0b" : "#3b82f6";

      g.save();
      g.translate(px, py);
      g.rotate(Math.PI / 4);
      g.fillStyle = col;
      g.fillRect(-4, -4, 8, 8);
      g.strokeStyle = light ? "#ffffff" : "#0f121a";
      g.lineWidth = 1.25;
      g.strokeRect(-4, -4, 8, 8);
      g.restore();

      lane.hitPins.push({ x0: px - 7, x1: px + 7, y0: railY - 3, y1: railY + railH + 3, ev });
    }

    // 6. Shift Handover vertical guides (dashed violet)
    if (shifts.length) {
      g.save();
      g.strokeStyle = light ? "rgba(109,40,217,0.34)" : "rgba(167,139,250,0.38)";
      g.setLineDash([3, 3]);
      g.lineWidth = 1;
      for (const s of shifts) {
        const px = Math.round(x(s.ts)) + 0.5;
        g.beginPath();
        g.moveTo(px, 0);
        g.lineTo(px, H);
        g.stroke();
      }
      g.restore();
    }

    // 7. Midnight Day Boundary (crimson)
    if (days.length) {
      g.strokeStyle = light ? "rgba(220,38,38,0.75)" : "rgba(244,63,94,0.82)";
      g.lineWidth = 1.5;
      for (const d of days) {
        const px = Math.round(x(d)) + 0.5;
        g.beginPath();
        g.moveTo(px, 0);
        g.lineTo(px, H);
        g.stroke();
      }
      g.lineWidth = 1;
    }

    // 8. NOW line (amber)
    if (nowMs >= from && nowMs <= to) {
      const px = Math.round(x(nowMs)) + 0.5;
      g.strokeStyle = "#f59e0b";
      g.lineWidth = 1.8;
      g.beginPath();
      g.moveTo(px, 0);
      g.lineTo(px, H);
      g.stroke();
      g.lineWidth = 1;
    }
  }

  function paintExpandedTrace(lane, from, to, span) {
    const g = lane.expandG;
    const w = ctx.trackW;
    const H = 116;
    if (!g || !w) return;
    const light = isLightTheme();
    g.clearRect(0, 0, w, H);
    const x = (ts) => ((ts - from) / span) * w;

    // Update live telemetry sidebar numbers from overview
    const mo = ctx.over.get(lane.id);
    if (mo) {
      const rpm = Number(mo.spindle_speed);
      const feed = mo.overrides && Number(mo.overrides.feed);
      lane.efRpm.textContent = mo.online === false ? "Offline" : (Number.isFinite(rpm) ? `${Math.round(rpm)} RPM` : "—");
      lane.efFeed.textContent = mo.online === false ? "—" : (Number.isFinite(feed) ? `${Math.round(feed)}%` : "—");
      lane.efTool.textContent = mo.tool_id || "—";
    }

    // Horizontal reference guides
    g.strokeStyle = light ? "rgba(15,23,42,0.07)" : "rgba(255,255,255,0.07)";
    g.lineWidth = 1;
    for (const frac of [0.25, 0.5, 0.75]) {
      const y = Math.round(H * frac) + 0.5;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }

    const sData = lane.series;
    if (!sData || ((!sData.sspeed || !sData.sspeed.length) && (!sData.fdovrd || !sData.fdovrd.length))) {
      g.fillStyle = light ? "#64748b" : "#94a3b8";
      g.font = "12px var(--font-body), sans-serif";
      g.fillText(mo && mo.online === false ? "Machine offline — no spindle or override telemetry in window" : "Loading spindle speed & feed override trace…", 14, H / 2 + 4);
      return;
    }

    const padTop = 14;
    const padBot = 12;
    const plotH = H - padTop - padBot;

    // Draw Spindle Speed (RPM) filled area curve
    const rpmPts = (sData.sspeed || []).filter((p) => p.ts >= from - span * 0.1 && p.ts <= to + span * 0.1);
    if (rpmPts.length >= 2) {
      const maxRpm = Math.max(1000, ...rpmPts.map((p) => p.avg || 0)) * 1.1;
      const yRpm = (v) => padTop + plotH - (Math.max(0, v) / maxRpm) * plotH;

      g.beginPath();
      rpmPts.forEach((pt, idx) => {
        const px = x(pt.ts);
        const py = yRpm(pt.avg || 0);
        if (idx === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      });
      const lastX = x(rpmPts[rpmPts.length - 1].ts);
      const firstX = x(rpmPts[0].ts);
      g.lineTo(lastX, padTop + plotH);
      g.lineTo(firstX, padTop + plotH);
      g.closePath();
      const grad = g.createLinearGradient(0, padTop, 0, padTop + plotH);
      grad.addColorStop(0, light ? "rgba(37,99,235,0.26)" : "rgba(59,130,246,0.34)");
      grad.addColorStop(1, light ? "rgba(37,99,235,0.02)" : "rgba(59,130,246,0.02)");
      g.fillStyle = grad;
      g.fill();

      g.beginPath();
      rpmPts.forEach((pt, idx) => {
        const px = x(pt.ts);
        const py = yRpm(pt.avg || 0);
        if (idx === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      });
      g.strokeStyle = light ? "#2563eb" : "#60a5fa";
      g.lineWidth = 1.6;
      g.stroke();

      g.fillStyle = light ? "#2563eb" : "#93c5fd";
      g.font = "600 10px ui-monospace, monospace";
      g.fillText(`Peak ${Math.round(maxRpm / 1.1)} RPM`, 8, 11);
    }

    // Draw Feed Override (%) stepped line with 100% dashed guide
    const feedPts = (sData.fdovrd || []).filter((p) => p.ts >= from - span * 0.1 && p.ts <= to + span * 0.1);
    if (feedPts.length >= 2) {
      const maxFeed = Math.max(120, ...feedPts.map((p) => p.avg || 0));
      const yFeed = (v) => padTop + plotH - (Math.max(0, v) / maxFeed) * plotH;

      // 100% nominal reference line
      const y100 = Math.round(yFeed(100)) + 0.5;
      g.save();
      g.strokeStyle = light ? "rgba(217,119,6,0.42)" : "rgba(245,158,11,0.42)";
      g.setLineDash([4, 4]);
      g.beginPath();
      g.moveTo(0, y100);
      g.lineTo(w, y100);
      g.stroke();
      g.restore();

      g.beginPath();
      feedPts.forEach((pt, idx) => {
        const px = x(pt.ts);
        const py = yFeed(pt.avg || 0);
        if (idx === 0) g.moveTo(px, py);
        else {
          g.lineTo(px, yFeed(feedPts[idx - 1].avg || 0));
          g.lineTo(px, py);
        }
      });
      g.strokeStyle = light ? "#d97706" : "#fbbf24";
      g.lineWidth = 1.5;
      g.stroke();

      g.fillStyle = light ? "#b45309" : "#fcd34d";
      g.font = "600 10px ui-monospace, monospace";
      g.textAlign = "right";
      g.fillText("100% Feed", w - 8, y100 - 4);
      g.textAlign = "left";
    }
  }

  function paintMinimap(from, to) {
    const g = refs.minimapG;
    const w = ctx.trackW;
    const H = 40;
    if (!g || !w) return;
    const light = isLightTheme();
    g.clearRect(0, 0, w, H);

    const bFrom = ctx.cover.has ? Math.min(ctx.cover.from, from) : from;
    const bTo = ctx.cover.has ? Math.max(ctx.cover.to, to) : to;
    const bSpan = Math.max(60e3, bTo - bFrom);

    refs.minimapSpan.textContent = fmtDurCompact(bSpan);
    const bins = computeMinimapBins(ctx.lanes, bFrom, bTo, Math.min(160, Math.max(48, Math.floor(w / 6))));
    const bw = w / Math.max(1, bins.length);
    for (let i = 0; i < bins.length; i++) {
      const b = bins[i];
      const bx = i * bw;
      const runH = Math.round(b.runFrac * (H - 10));
      const lossH = Math.round(b.lossFrac * (H - 10));
      const alarmH = Math.round(b.alarmFrac * (H - 10));
      let curY = H - 5;
      if (runH > 0) {
        g.fillStyle = light ? "rgba(22,163,74,0.55)" : "rgba(34,197,94,0.55)";
        g.fillRect(bx + 0.5, curY - runH, Math.max(1, bw - 1), runH);
        curY -= runH;
      }
      if (lossH > 0) {
        g.fillStyle = light ? "rgba(100,116,139,0.34)" : "rgba(148,163,184,0.30)";
        g.fillRect(bx + 0.5, curY - lossH, Math.max(1, bw - 1), lossH);
        curY -= lossH;
      }
      if (alarmH > 0) {
        g.fillStyle = light ? "rgba(220,38,38,0.72)" : "rgba(244,63,94,0.72)";
        g.fillRect(bx + 0.5, curY - alarmH, Math.max(1, bw - 1), alarmH);
      }
    }

    // Position viewport brush
    const leftPct = Math.max(0, Math.min(1, (from - bFrom) / bSpan));
    const rightPct = Math.max(leftPct + 0.02, Math.min(1, (to - bFrom) / bSpan));
    refs.brush.style.left = `${(leftPct * 100).toFixed(2)}%`;
    refs.brush.style.width = `${Math.max(2, (rightPct - leftPct) * 100).toFixed(2)}%`;
    refs.brush.hidden = false;
    ctx.minimapBounds = { bFrom, bTo, bSpan };
  }

  // ---- Minimap Click & Brush Drag ----
  {
    let dragMode = null;
    let startX = 0;
    let startAnchor = 0;
    refs.minimapTrack.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !ctx.minimapBounds) return;
      const rect = refs.minimapTrack.getBoundingClientRect();
      const { bFrom, bSpan } = ctx.minimapBounds;
      if (e.target === refs.brush) {
        dragMode = "brush";
        startX = e.clientX;
        startAnchor = ctx.live ? maxFutureAnchor(ctx.spanMs) : ctx.anchor;
      } else {
        // Click to center viewport on clicked timestamp
        const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
        const targetCenter = bFrom + frac * bSpan;
        const cap = maxFutureAnchor(ctx.spanMs);
        const nextTo = Math.min(cap, targetCenter + ctx.spanMs * 0.5);
        ctx.live = nextTo >= cap - 1500;
        ctx.anchor = nextTo;
        syncPresetBtns();
        paintWinLabel();
        markDirty({ all: true });
        dragMode = "brush";
        startX = e.clientX;
        startAnchor = nextTo;
      }
      try { refs.minimapTrack.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });
    refs.minimapTrack.addEventListener("pointermove", (e) => {
      if (!dragMode || !ctx.minimapBounds) return;
      const rect = refs.minimapTrack.getBoundingClientRect();
      const dx = e.clientX - startX;
      const dtMs = (dx / Math.max(1, rect.width)) * ctx.minimapBounds.bSpan;
      const cap = maxFutureAnchor(ctx.spanMs);
      const nextTo = Math.min(cap, startAnchor + dtMs);
      ctx.live = nextTo >= cap - 1500;
      ctx.anchor = nextTo;
      syncPresetBtns();
      paintWinLabel();
      markDirty({ all: true });
    });
    const end = (e) => {
      if (!dragMode) return;
      dragMode = null;
      try { refs.minimapTrack.releasePointerCapture(e.pointerId); } catch {}
      ensureBuffer(false);
      refreshExpandedSeries();
    };
    refs.minimapTrack.addEventListener("pointerup", end);
    refs.minimapTrack.addEventListener("pointercancel", end);
  }

  function updateSummariesAndGutters(from, to) {
    const effTo = Math.min(to, Date.now());
    const laneSums = new Map();

    for (const [id, lane] of ctx.lanes) {
      const s = summarizeLaneWindow(lane.parts, lane.bands, from, effTo);
      lane.summary = s;
      laneSums.set(id, s);

      const mo = ctx.over.get(id);
      const rawSt = mo
        ? (mo.online === false ? "offline" : String(mo.status || "idle").toLowerCase())
        : "idle";
      lane.stateEl.textContent = statusLabel(rawSt);
      lane.stateEl.className = `tl2-mstate st-${rawSt === "running" || rawSt === "paused" || rawSt === "alarm" || rawSt === "offline" ? rawSt : "idle"}`;

      const prog = mo && mo.active_program ? String(mo.active_program).replace(/\.nc$/i, "") : "";
      lane.metaEl.textContent = rawSt === "offline"
        ? "Offline · no signal"
        : `${s.partCount} part${s.partCount === 1 ? "" : "s"}${prog ? ` · ${prog}` : ""}`;
      lane.utilEl.textContent = s.utilPct != null ? `${s.utilPct}%` : "—";
    }

    const fleet = summarizeFleetWindow(laneSums, ctx.over, ctx.events, ctx.downtimeLogs, from, effTo);
    refs.kpiUtil.textContent = `${fleet.fleetUtilPct}%`;
    refs.kpiUtil.className = `tl2-kpi-v ${fleet.fleetUtilPct >= 75 ? "tl2-kpi-good" : fleet.fleetUtilPct >= 50 ? "tl2-kpi-warn" : "tl2-kpi-bad"}`;
    refs.kpiUtilBar.style.width = `${Math.max(0, Math.min(100, fleet.fleetUtilPct))}%`;
    refs.kpiUtilSub.textContent = `${fleet.runningNow}/${fleet.totalMachines} cutting · ${fleet.onlineNow} online`;

    refs.kpiParts.textContent = String(fleet.totalParts);
    const hrs = Math.max(0.1, (effTo - from) / 3600e3);
    refs.kpiPartsSub.textContent = `${(fleet.totalParts / hrs).toFixed(1)} parts/hr fleet pace`;

    refs.kpiLoss.textContent = fmtDurCompact(fleet.totalLossMs);
    refs.kpiLoss.className = `tl2-kpi-v ${fleet.totalAlarmMs > 0 ? "tl2-kpi-bad" : fleet.totalLossMs > 0 ? "tl2-kpi-warn" : "tl2-kpi-good"}`;
    refs.kpiLossSub.textContent = `Idle ${fmtDurCompact(fleet.totalIdleMs)} · Hold ${fmtDurCompact(fleet.totalHoldMs)} · Alarm ${fmtDurCompact(fleet.totalAlarmMs)}`;

    refs.kpiInc.textContent = String(fleet.incidentCount);
    refs.kpiInc.className = `tl2-kpi-v ${fleet.incidentCount > 0 ? "tl2-kpi-info" : ""}`;
    refs.kpiIncSub.textContent = `${fleet.loggedInWindow} gap cause${fleet.loggedInWindow === 1 ? "" : "s"} logged in window`;
  }

  function renderDirty() {
    const { from, to, span } = windowSpan();
    if (ctx.dirtyAxis) {
      paintAxis(from, to, span);
      ctx.dirtyAxis = false;
    }
    if (ctx.dirtyLanes) {
      const shifts = span <= 3 * 86400e3 ? computeShiftBoundaries(from, to) : [];
      const days = computeIstDayBoundaries(from, to);
      for (const lane of ctx.lanes.values()) {
        paintLane(lane, from, to, span, shifts, days);
      }
      ctx.dirtyLanes = false;
    }
    if (ctx.dirtyExpand) {
      for (const id of ctx.expanded) {
        const lane = ctx.lanes.get(id);
        if (lane) paintExpandedTrace(lane, from, to, span);
      }
      ctx.dirtyExpand = false;
    }
    if (ctx.dirtyMinimap) {
      paintMinimap(from, to);
      ctx.dirtyMinimap = false;
    }
    if (ctx.dirtySummary) {
      updateSummariesAndGutters(from, to);
      ctx.dirtySummary = false;
    }
  }

  // ==================== HIT-TESTING, OBSIDIAN CALLOUT & SLIDE-OVER DRAWER ====================

  function hitTestLane(lane, mx, my) {
    // Priority 1: Event Pins on top rail
    const pin = lane.hitPins.find((r) => mx >= r.x0 && mx <= r.x1 && my >= r.y0 && my <= r.y1);
    if (pin) return { type: "pin", data: pin.ev };
    // Priority 2: Program Group Strip on top rail
    const grp = lane.hitGroups.find((r) => mx >= r.x0 && mx <= r.x1 && my >= r.y0 && my <= r.y1);
    if (grp) return { type: "group", data: grp.grp };
    // Priority 3: Part / Live Cycle Bar
    const part = lane.hitParts.find((r) => mx >= r.x0 && mx <= r.x1 && my >= r.y0 && my <= r.y1);
    if (part) return { type: part.live ? "live" : "part", data: part.live ? part.m : part.p, kind: part.kind };
    // Priority 4: Non-Cutting State Gap
    const gap = lane.hitGaps.find((r) => mx >= r.x0 && mx <= r.x1 && my >= r.y0 && my <= r.y1);
    if (gap) return { type: "gap", data: gap.gap };
    return null;
  }

  function placeCallout(clientX, clientY) {
    const el = refs.callout;
    const r = el.getBoundingClientRect();
    const w = r.width || 270;
    const h = r.height || 140;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = clientX + 16;
    if (x + w > vw - 12) x = clientX - w - 16;
    x = Math.max(10, x);
    let y = clientY - h / 2;
    y = Math.max(56, Math.min(vh - h - 12, y));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  function onLaneHover(e, id) {
    if (ctx.drawerItem) return;
    const lane = ctx.lanes.get(id);
    if (!lane) return;
    const rect = lane.canvas.getBoundingClientRect();
    const hit = hitTestLane(lane, e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) {
      refs.callout.hidden = true;
      return;
    }

    let html = "";
    if (hit.type === "pin") {
      const ev = hit.data;
      const tagCol = ev.sev === "CRITICAL" ? "#fb7185" : ev.sev === "WARNING" ? "#fbbf24" : "#93c5fd";
      html = `
        <div class="tl2-co-head">
          <span class="tl2-co-title">${escHtml(lane.name)} · Event</span>
          <span class="tl2-co-tag" style="color:${tagCol}">${escHtml(ev.rule || ev.sev)}</span>
        </div>
        <div class="tl2-co-grid">
          <span class="tl2-co-k">Time</span><span class="tl2-co-v">${fmtClockSecIST(ev.ts)} IST</span>
          <span class="tl2-co-k">Detail</span><span class="tl2-co-v">${escHtml(ev.msg || ev.rule)}</span>
        </div>
      `;
    } else if (hit.type === "group") {
      const grp = hit.data;
      const parts = lane.parts.filter((p) => p.groupId === grp.groupId);
      const cutMs = parts.reduce((a, p) => a + (p.dur || 0), 0);
      const wallMs = Math.max(1, grp.t1 - grp.t0);
      const util = Math.min(100, Math.round((cutMs / wallMs) * 100));
      html = `
        <div class="tl2-co-head">
          <span class="tl2-co-title">${escHtml(String(grp.program || "—").replace(/\.nc$/i, ""))}</span>
          <span class="tl2-co-tag" style="color:#93c5fd">${grp.count} job${grp.count === 1 ? "" : "s"}</span>
        </div>
        <div class="tl2-co-grid">
          <span class="tl2-co-k">Window</span><span class="tl2-co-v">${fmtClockIST(grp.t0)} → ${fmtClockIST(grp.t1)}</span>
          <span class="tl2-co-k">Cutting Share</span><span class="tl2-co-v">${util}% (${fmtDurCompact(cutMs)})</span>
          <span class="tl2-co-k">Learned Baseline</span><span class="tl2-co-v">${grp.baseline ? fmtDurCompact(grp.baseline * 1000) : "Pending"}</span>
        </div>
        <div class="tl2-co-foot">Click for full program breakdown</div>
      `;
    } else if (hit.type === "live") {
      const m = hit.data;
      const c = m.cycle || {};
      html = `
        <div class="tl2-co-head">
          <span class="tl2-co-title">${escHtml(lane.name)} · Live Cycle</span>
          <span class="tl2-co-tag" style="color:#60a5fa">${statusLabel(m.status)}</span>
        </div>
        <div class="tl2-co-grid">
          <span class="tl2-co-k">Program</span><span class="tl2-co-v">${escHtml(String(m.active_program || "—").replace(/\.nc$/i, ""))}</span>
          <span class="tl2-co-k">Elapsed</span><span class="tl2-co-v">${fmtDurCompact(Number(c.this_cycle || 0) * 1000)}</span>
          ${Number.isFinite(c.remaining_cycle_time) ? `<span class="tl2-co-k">Remaining</span><span class="tl2-co-v">${fmtDurCompact(Number(c.remaining_cycle_time) * 1000)}</span>` : ""}
          <span class="tl2-co-k">Spindle</span><span class="tl2-co-v">${Number.isFinite(m.spindle_speed) ? `${Math.round(m.spindle_speed)} RPM` : "—"}</span>
        </div>
      `;
    } else if (hit.type === "part") {
      const p = hit.data;
      const pct = p.dev != null ? Math.round((p.dev - 1) * 100) : null;
      const tagCol = hit.kind === "over" ? "#fb7185" : hit.kind === "high" ? "#fbbf24" : hit.kind === "low" ? "#38bdf8" : "#4ade80";
      const tagTxt = pct != null ? `${pct >= 0 ? "+" : ""}${pct}% vs base` : "Normal";
      html = `
        <div class="tl2-co-head">
          <span class="tl2-co-title">${escHtml(lane.name)} · Job #${escHtml(p.job ?? "—")}</span>
          <span class="tl2-co-tag" style="color:${tagCol}">${tagTxt}</span>
        </div>
        <div class="tl2-co-grid">
          <span class="tl2-co-k">Program</span><span class="tl2-co-v">${escHtml(String(p.program || "—").replace(/\.nc$/i, ""))}</span>
          <span class="tl2-co-k">Time</span><span class="tl2-co-v">${fmtClockSecIST(p.t0)} → ${fmtClockSecIST(p.t1)}</span>
          <span class="tl2-co-k">Duration</span><span class="tl2-co-v">${fmtDurCompact(p.dur)}</span>
          ${p.baseline ? `<span class="tl2-co-k">Baseline</span><span class="tl2-co-v">${fmtDurCompact(p.baseline * 1000)}</span>` : ""}
        </div>
        <div class="tl2-co-foot">Click for cycle &amp; incident inspector</div>
      `;
    } else if (hit.type === "gap") {
      const gap = hit.data;
      const stCol = gap.status === "alarm" ? "#fb7185" : gap.status === "paused" ? "#fbbf24" : "#cbd5e1";
      html = `
        <div class="tl2-co-head">
          <span class="tl2-co-title">${escHtml(lane.name)} · ${statusLabel(gap.status)} Gap</span>
          <span class="tl2-co-tag" style="color:${stCol}">${fmtDurCompact(gap.durMs)}</span>
        </div>
        <div class="tl2-co-grid">
          <span class="tl2-co-k">Window</span><span class="tl2-co-v">${fmtClockSecIST(gap.t0)} → ${fmtClockSecIST(gap.t1)}</span>
          <span class="tl2-co-k">Recorded Cause</span><span class="tl2-co-v">${gap.logged ? escHtml(gap.logged.reason) : "Unclassified"}</span>
          ${gap.events.length ? `<span class="tl2-co-k">Events</span><span class="tl2-co-v">${gap.events.length} controller event${gap.events.length === 1 ? "" : "s"}</span>` : ""}
        </div>
        <div class="tl2-co-foot">${gap.logged ? "Click to review or update logged reason" : "Click to log downtime root cause"}</div>
      `;
    }

    refs.callout.innerHTML = html;
    refs.callout.hidden = false;
    placeCallout(e.clientX, e.clientY);
  }

  function placePopup(clientX, clientY) {
    const el = refs.drawer;
    const r = el.getBoundingClientRect();
    const w = r.width || 368;
    const h = r.height || 360;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const nav = document.querySelector(".godnav");
    const topBound = Math.max(12, (nav ? nav.getBoundingClientRect().bottom : 0) + 8);
    const GAP = 14;
    const MARGIN = 12;

    let x = clientX + GAP;
    if (x + w > vw - MARGIN) x = clientX - w - GAP;
    x = Math.max(MARGIN, Math.min(vw - w - MARGIN, x));

    let y = clientY - Math.min(h * 0.35, 140);
    if (y + h > vh - MARGIN) y = vh - h - MARGIN;
    if (y < topBound) y = topBound;

    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
  }

  function onLaneClick(e, id) {
    const lane = ctx.lanes.get(id);
    if (!lane) return;
    const rect = lane.canvas.getBoundingClientRect();
    const hit = hitTestLane(lane, e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    refs.callout.hidden = true;
    openDrawer(lane, hit, e.clientX, e.clientY);
  }

  function openDrawer(lane, hit, clientX = window.innerWidth / 2, clientY = 180) {
    ctx.drawerItem = { lane, hit };
    refs.drawerBackdrop.hidden = false;
    const finishPlace = () => placePopup(clientX, clientY);

    if (hit.type === "gap") {
      const gap = hit.data;
      const durMin = Math.max(1, Math.round(gap.durMs / 60e3));
      const shiftLbl = shiftLabelForTs(gap.t0);
      refs.drawerTitle.textContent = `${lane.name} · ${statusLabel(gap.status)} Gap`;
      refs.drawerSub.textContent = `${fmtDayIST(gap.t0)} · ${fmtClockSecIST(gap.t0)} → ${fmtClockSecIST(gap.t1)} IST`;

      const evRows = gap.events.length
        ? gap.events.map((ev) => `<div class="tl2-ev-row"><span class="tl2-ev-time">${fmtClockSecIST(ev.ts)}</span><span>${escHtml(ev.msg || ev.rule)}</span></div>`).join("")
        : `<div style="font-size:12px;color:var(--tl2-muted)">No controller alarm or override events overlapped this gap.</div>`;

      const existingHtml = gap.logged
        ? `<div class="tl2-dsec">
            <div class="tl2-dsec-h">Logged Shop-Floor Cause</div>
            <div class="tl2-dkv-grid">
              <div class="tl2-dkv"><span>Reason</span><strong>${escHtml(gap.logged.reason)}</strong></div>
              <div class="tl2-dkv"><span>Duration</span><strong>${gap.logged.durationMin} min</strong></div>
              ${gap.logged.operator ? `<div class="tl2-dkv"><span>Operator</span><strong>${escHtml(gap.logged.operator)}</strong></div>` : ""}
              ${gap.logged.note ? `<div class="tl2-dkv" style="grid-column:1/-1"><span>Note</span><strong>${escHtml(gap.logged.note)}</strong></div>` : ""}
            </div>
            <button type="button" class="tl2-btn" data-df="delGapLog" style="align-self:flex-start;margin-top:4px">Remove Logged Cause</button>
          </div>`
        : "";

      const reasonOpts = DOWNTIME_REASONS.map((r) => `<option value="${escHtml(r)}">${escHtml(r)}</option>`).join("");
      refs.drawerBody.innerHTML = `
        <div class="tl2-dsec">
          <div class="tl2-dsec-h">Gap Telemetry Summary</div>
          <div class="tl2-dkv-grid">
            <div class="tl2-dkv"><span>Controller State</span><strong>${statusLabel(gap.status)}</strong></div>
            <div class="tl2-dkv"><span>Duration</span><strong>${fmtDurCompact(gap.durMs)}</strong></div>
            <div class="tl2-dkv"><span>Shift</span><strong>${escHtml(shiftLbl)}</strong></div>
            <div class="tl2-dkv"><span>Accountability</span><strong>${gap.logged ? "Logged" : "Unclassified"}</strong></div>
          </div>
        </div>
        ${existingHtml}
        <div class="tl2-dsec">
          <div class="tl2-dsec-h">${gap.logged ? "Log Additional Cause" : "Log Downtime Root Cause"}</div>
          <form class="tl2-form" data-df="gapForm">
            <label class="tl2-field">
              <span>Root Cause Category</span>
              <select class="tl2-select" name="reason" required>${reasonOpts}</select>
            </label>
            <label class="tl2-field">
              <span>Duration (minutes)</span>
              <input class="tl2-input" type="number" name="durationMin" min="1" max="1440" value="${durMin}" required />
            </label>
            <label class="tl2-field">
              <span>Operator (optional)</span>
              <input class="tl2-input" type="text" name="operator" maxlength="60" placeholder="e.g. R. Sharma" />
            </label>
            <label class="tl2-field">
              <span>Shop-Floor Note (optional)</span>
              <textarea class="tl2-textarea" name="note" maxlength="280" placeholder="Fixture adjustment, tool insert change, waiting for raw stock…"></textarea>
            </label>
            <button type="submit" class="tl2-submit-btn">Save to Fleet Intelligence Log</button>
          </form>
        </div>
        <div class="tl2-dsec">
          <div class="tl2-dsec-h">Overlapping Controller Events</div>
          <div class="tl2-ev-list">${evRows}</div>
        </div>
      `;

      const delBtn = refs.drawerBody.querySelector('[data-df="delGapLog"]');
      if (delBtn && gap.logged) {
        delBtn.addEventListener("click", async () => {
          delBtn.disabled = true;
          try {
            const st = await fleetStore.deleteDowntime(gap.logged.id);
            ctx.downtimeLogs = st.downtimeLogs || [];
            markDirty({ lanes: true, summary: true });
            closeDrawer();
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
            ctx.downtimeLogs = st.downtimeLogs || [];
            markDirty({ lanes: true, summary: true });
            closeDrawer();
          } catch (err) {
            btn.disabled = false;
            btn.textContent = `Save failed — retry`;
          }
        });
      }
      finishPlace();
      return;
    }

    if (hit.type === "group") {
      const grp = hit.data;
      const parts = lane.parts.filter((p) => p.groupId === grp.groupId);
      const done = parts.filter((p) => !p.partial && p.dur > 0);
      const cutMs = parts.reduce((a, p) => a + (p.dur || 0), 0);
      const wallMs = Math.max(1, grp.t1 - grp.t0);
      const idleMs = Math.max(0, wallMs - cutMs);
      const util = Math.min(100, Math.round((cutMs / wallMs) * 100));
      const maxDur = Math.max(1, ...done.map((p) => p.dur));
      const spark = done.slice(-48).map((p) => {
        const k = partDeviationKind(p);
        return `<i class="k-${k}" style="height:${Math.max(10, Math.round((p.dur / maxDur) * 100))}%"></i>`;
      }).join("");
      const evs = (ctx.events.get(lane.id) || []).filter((e) => e.ts >= grp.t0 && e.ts <= grp.t1);

      refs.drawerTitle.textContent = String(grp.program || "Program Run").replace(/\.nc$/i, "");
      refs.drawerSub.textContent = `${lane.name} · ${grp.count} jobs · ${fmtClockIST(grp.t0)} → ${fmtClockIST(grp.t1)} IST`;
      refs.drawerBody.innerHTML = `
        <div class="tl2-dsec">
          <div class="tl2-dsec-h">Run Summary</div>
          <div class="tl2-dkv-grid">
            <div class="tl2-dkv"><span>Cutting Time</span><strong>${fmtDurCompact(cutMs)} (${util}%)</strong></div>
            <div class="tl2-dkv"><span>Inter-Cycle Gaps</span><strong>${fmtDurCompact(idleMs)}</strong></div>
            <div class="tl2-dkv"><span>Completed Jobs</span><strong>${done.length}</strong></div>
            <div class="tl2-dkv"><span>Learned Baseline</span><strong>${grp.baseline ? fmtDurCompact(grp.baseline * 1000) : "Pending"}</strong></div>
          </div>
        </div>
        <div class="tl2-dsec">
          <div class="tl2-dsec-h">Cycle Duration Profile (${done.length} cycles)</div>
          <div class="tl2-spark">${spark || '<span style="font-size:12px;color:var(--tl2-muted)">No completed cycles in run</span>'}</div>
        </div>
        <div class="tl2-dsec">
          <div class="tl2-dsec-h">Incidents During Run (${evs.length})</div>
          <div class="tl2-ev-list">
            ${evs.length
              ? evs.map((e) => `<div class="tl2-ev-row"><span class="tl2-ev-time">${fmtClockSecIST(e.ts)}</span><span>${escHtml(e.msg || e.rule)}</span></div>`).join("")
              : `<div style="font-size:12px;color:var(--tl2-emerald)">Clean run — no E-stops or override dips recorded.</div>`}
          </div>
        </div>
      `;
      finishPlace();
      return;
    }

    if (hit.type === "part") {
      const p = hit.data;
      const evs = (ctx.events.get(lane.id) || []).filter((e) => e.ts >= p.t0 && e.ts <= p.t1);
      const pct = p.dev != null ? Math.round((p.dev - 1) * 100) : null;
      refs.drawerTitle.textContent = `${lane.name} · Job #${p.job ?? "—"}`;
      refs.drawerSub.textContent = `${String(p.program || "—").replace(/\.nc$/i, "")} · ${fmtClockSecIST(p.t0)} → ${fmtClockSecIST(p.t1)} IST`;
      refs.drawerBody.innerHTML = `
        <div class="tl2-dsec">
          <div class="tl2-dsec-h">Cycle Metrics</div>
          <div class="tl2-dkv-grid">
            <div class="tl2-dkv"><span>Actual Duration</span><strong>${fmtDurCompact(p.dur)}</strong></div>
            <div class="tl2-dkv"><span>Baseline</span><strong>${p.baseline ? fmtDurCompact(p.baseline * 1000) : "—"}</strong></div>
            <div class="tl2-dkv"><span>Deviation</span><strong>${pct != null ? `${pct >= 0 ? "+" : ""}${pct}%` : "—"}</strong></div>
            <div class="tl2-dkv"><span>Band</span><strong>${hit.kind === "over" ? "Overrun (>+30%)" : hit.kind === "high" ? "Mild Slow (+15%)" : hit.kind === "low" ? "Short (-15%)" : "Nominal"}</strong></div>
          </div>
        </div>
        <div class="tl2-dsec">
          <div class="tl2-dsec-h">Overlapping Controller Events (${evs.length})</div>
          <div class="tl2-ev-list">
            ${evs.length
              ? evs.map((e) => `<div class="tl2-ev-row"><span class="tl2-ev-time">${fmtClockSecIST(e.ts)}</span><span>${escHtml(e.msg || e.rule)}</span></div>`).join("")
              : `<div style="font-size:12px;color:var(--tl2-emerald)">No interruptions during this cycle.</div>`}
          </div>
        </div>
      `;
      finishPlace();
      return;
    }

    if (hit.type === "pin") {
      const ev = hit.data;
      refs.drawerTitle.textContent = `${lane.name} · Controller Event`;
      refs.drawerSub.textContent = `${fmtDayIST(ev.ts)} · ${fmtClockSecIST(ev.ts)} IST`;
      refs.drawerBody.innerHTML = `
        <div class="tl2-dsec">
          <div class="tl2-dkv-grid">
            <div class="tl2-dkv"><span>Severity</span><strong>${escHtml(ev.sev || "INFO")}</strong></div>
            <div class="tl2-dkv"><span>Rule</span><strong>${escHtml(ev.rule || "event")}</strong></div>
            <div class="tl2-dkv" style="grid-column:1/-1"><span>Message</span><strong>${escHtml(ev.msg || ev.rule)}</strong></div>
          </div>
        </div>
      `;
      finishPlace();
    }
  }

  function closeDrawer() {
    ctx.drawerItem = null;
    refs.drawerBackdrop.hidden = true;
  }

  refs.drawerClose.addEventListener("click", closeDrawer);
  refs.drawerBackdrop.addEventListener("click", (e) => {
    if (e.target === refs.drawerBackdrop) closeDrawer();
  });
  const onKeyDown = (e) => {
    if (e.key === "Escape" && !refs.drawerBackdrop.hidden) closeDrawer();
  };
  document.addEventListener("keydown", onKeyDown);

  // ---- Theme Toggle Listener ----
  const onTheme = () => {
    if (!ctx.destroyed) markDirty({ all: true });
  };
  window.addEventListener("vmc-theme", onTheme);

  // ---- TV Wall-Board Bridge (preserved for tv.js rotation) ----
  window.__VMC_TIMELINE__ = {
    present(visibleIds) {
      applyPreset("1h", true);
      if (Array.isArray(visibleIds)) {
        ctx.wallOrder = visibleIds.slice();
        const all = ctx.machines.map((m) => m.id);
        const coversAll = all.length > 0 && visibleIds.length === all.length && all.every((id) => visibleIds.includes(id));
        ctx.sel = coversAll ? null : new Set(visibleIds);
        buildFilterMenu();
        syncVisibleLanes();
      }
    },
    release() {
      ctx.wallOrder = null;
      ctx.sel = loadSel();
      const saved = localStorage.getItem(LS_RANGE);
      if (saved && PRESET_MAP[saved]) applyPreset(saved, true);
      buildFilterMenu();
      syncVisibleLanes();
    },
  };

  // ---- Boot ----
  hydrateFromSnapshot();
  syncCanvasSizes();
  paintWinLabel();
  syncPresetBtns();
  loadOverviewAndBoot(true);
  ctx.liveTimer = setInterval(liveTick, 1000);

  return {
    refresh() {
      if (ctx.destroyed || ctx.dragging) return;
      if (!refs.board || !refs.board.offsetParent) return;
      fleetStore.load().then((st) => {
        if (!ctx.destroyed && st && Array.isArray(st.downtimeLogs)) {
          ctx.downtimeLogs = st.downtimeLogs;
          markDirty({ lanes: true, summary: true });
        }
      }).catch(() => {});
      loadBuffer(ctx.live);
    },
    destroy() {
      ctx.destroyed = true;
      if (ctx.liveTimer) clearInterval(ctx.liveTimer);
      if (ctx.rafId != null) cancelAnimationFrame(ctx.rafId);
      if (bufTimer) clearTimeout(bufTimer);
      if (zoomTimer) clearTimeout(zoomTimer);
      if (ro) ro.disconnect();
      window.removeEventListener("vmc-theme", onTheme);
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    },
  };
}
