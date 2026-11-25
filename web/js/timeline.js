/* VMC God-mode — Production Timeline.
 *
 * One horizontal lane per machine on a real TIME axis. Completed parts are
 * reconstructed from the `cyremtim` (cycle-remaining) signal — it counts down
 * within a part and jumps back up at each new cycle, so a part is a maximal
 * countdown run; its width on the axis is its real wall-clock duration. Each
 * segment is colored against the `tcycle` target (green on/under, amber close,
 * red overrun). The right edge is the LIVE in-progress part, polled at 1 Hz
 * from /api/overview and growing in real time.
 *
 * Range (Hour / Day / Week / Month) + scroll ◀ ▶ drive the [from,to] window,
 * served by /api/history_range (real rows the whole way back — not the recent
 * 5000-row cap). All real signals. No fake, no padded ranges.
 */

const RANGES = [
  { key: "hour", label: "Hour", ms: 3600e3 },
  { key: "day", label: "Day", ms: 86400e3 },
  { key: "week", label: "Week", ms: 7 * 86400e3 },
  { key: "month", label: "Month", ms: 30 * 86400e3 },
];
const RANGE_MS = Object.fromEntries(RANGES.map((r) => [r.key, r.ms]));

// per-machine identity tint (shared visual language with the 3D theatre)
const MPAL = [
  "#39d9f2", "#fb9e1a", "#8cd972", "#dc73f2", "#f5c740", "#739ef9",
];

const LS_RANGE = "vmc_tl_range";
const LS_FILTER = "vmc_tl_machines";   // selected machine ids (JSON array); absent = all
const LS_SNAP = "vmc_tl_snap_v1";      // device-persisted timeline snapshot (instant boot paint)
const SNAP_MAX_BYTES = 4_000_000;      // skip persisting snapshots bigger than ~4MB (quota safety)

// All wall-clock rendering is in Indian Standard Time (Asia/Kolkata, UTC+5:30) —
// the shop floor is in India, so every label/axis tick reads in local plant time.
// Epoch ms stay absolute; this only changes how they're displayed.
const IST_TZ = "Asia/Kolkata";
const IST_OFFSET = 330 * 60e3;         // +5:30 in ms (for snapping a day boundary)
// midnight (00:00 IST) of the calendar day that `ms` falls in, as absolute ms
function istDayStart(ms) {
  return Math.floor((ms + IST_OFFSET) / 86400e3) * 86400e3 - IST_OFFSET;
}

// Machine filter persistence. null = "all machines" (default); otherwise a Set
// of selected machine ids. Stored as a JSON array; absent key means all.
function loadSel() {
  try {
    const raw = localStorage.getItem(LS_FILTER);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length ? new Set(arr) : null;
  } catch (_) { return null; }
}
function saveSel(set) {
  if (!set || !set.size) localStorage.removeItem(LS_FILTER);
  else localStorage.setItem(LS_FILTER, JSON.stringify([...set]));
}

// ---- device-persisted snapshot: store the last good timeline on the device so
// a full page reload paints INSTANTLY from localStorage, then refreshes in the
// background. This is what makes a cold Cmd+R feel cached instead of a 5s load.
function loadSnapshot() {
  try {
    const raw = localStorage.getItem(LS_SNAP);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    // a snapshot older than 12h is stale enough that we'd rather show fresh data
    if (!snap || !snap.machines || (Date.now() - snap.savedAt) > 12 * 3600e3) return null;
    return snap;
  } catch (_) { return null; }
}
function saveSnapshot(snap) {
  try {
    const json = JSON.stringify(snap);
    if (json.length > SNAP_MAX_BYTES) return;   // too big for the device quota — skip
    localStorage.setItem(LS_SNAP, json);
  } catch (_) { /* quota / private mode — non-fatal, just no persistence */ }
}

// theme probe — canvas colors can't read CSS vars, so gate the few hand-picked
// tints on the active theme. Light mode needs darker text/lines to stay legible.
function isLight() {
  return document.documentElement.getAttribute("data-theme") === "light";
}

// Deviation bands vs a program's LEARNED baseline (median cycle time).
// A part is "normal" within ±NORMAL of its baseline, "mild" out to WIDE,
// else flagged. Both directions matter: slow (high) and short/aborted (low).
const NORMAL = 0.15;   // ±15% = normal spread
const WIDE = 0.30;     // ±15–30% = mild (amber); beyond = flagged (red/blue)

const pad2 = (n) => String(n).padStart(2, "0");
function clock(ms) {
  return new Date(ms).toLocaleTimeString("en-GB",
    { timeZone: IST_TZ, hour: "2-digit", minute: "2-digit", hour12: false });
}
function clockS(ms) {
  return new Date(ms).toLocaleTimeString("en-GB",
    { timeZone: IST_TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
function dur(ms) {
  const s = Math.round(ms / 1000), m = Math.floor(s / 60);
  if (m >= 60) { const h = Math.floor(m / 60); return `${h}h ${m % 60}m`; }
  return m > 0 ? `${m}m ${pad2(s % 60)}s` : `${s}s`;
}
function dayLabel(ms) {
  return new Date(ms).toLocaleDateString("en-US",
    { timeZone: IST_TZ, weekday: "short", month: "short", day: "numeric" });
}

export function mountTimeline(body, dataLayer) {
  const initRange = localStorage.getItem(LS_RANGE) || "hour";
  body.innerHTML = `
    <div class="tl-wrap">
      <div class="tl-controls">
        <div class="tl-ranges" data-f="ranges"></div>
        <div class="tl-nav">
          <button type="button" class="tl-btn" data-f="prev" title="Scroll back">◀</button>
          <button type="button" class="tl-btn" data-f="now" title="Jump to live">Now</button>
          <button type="button" class="tl-btn" data-f="next" title="Scroll forward">▶</button>
          <label class="tl-btn tl-datebtn" title="Jump to a date">
            <span class="tl-date-ico">📅</span>
            <input type="date" class="tl-date-input" data-f="datePick" />
          </label>
        </div>
        <div class="tl-window" data-f="winlabel">—</div>
        <span class="tl-loading" data-f="loading" hidden><i class="tl-spin"></i>loading older…</span>
        <div class="tl-filter" data-f="filterWrap">
          <button type="button" class="tl-btn tl-filter-btn" data-f="filterBtn" aria-haspopup="true" aria-expanded="false">
            <span data-f="filterLabel">All machines</span><span class="tl-filter-caret">▾</span>
          </button>
          <div class="tl-filter-menu" data-f="filterMenu" hidden></div>
        </div>
        <div class="tl-legend">
          <span><i class="tl-sw on"></i>normal</span>
          <span><i class="tl-sw near"></i>slow +15%</span>
          <span><i class="tl-sw over"></i>slow +30%</span>
          <span><i class="tl-sw low"></i>short</span>
          <span><i class="tl-sw live"></i>live</span>
        </div>
      </div>
      <div class="tl-grid" data-f="grid">
        <div class="tl-gutter"></div>
        <canvas class="tl-axis" data-f="axis"></canvas>
      </div>
      <p class="ds-note" data-f="note" role="status" aria-live="polite">Loading timeline…</p>
      <div class="tl-tip" data-f="tip" hidden></div>
    </div>`;

  const refs = {};
  body.querySelectorAll("[data-f]").forEach((n) => { refs[n.dataset.f] = n; });

  const ctx = {
    rangeKey: RANGE_MS[initRange] ? initRange : "hour",
    spanMs: RANGE_MS[RANGE_MS[initRange] ? initRange : "hour"], // continuous visible span (zoomable)
    anchor: Date.now() + RANGE_MS[RANGE_MS[initRange] ? initRange : "hour"] * 0.5, // NOW centered on load
    live: false,             // future-anchored so the now line sits mid-window
    machines: [],            // [{id, name}] (all reported by overview)
    sel: loadSel(),          // Set<id> of selected machines, or null = ALL
    wallOrder: null,       // wall presentation order (tv.js); null = payload order
    lanes: new Map(),        // id -> { label, canvas, dot, parts:[], tcycle:[], rects:[] }
    over: new Map(),         // id -> overview machine (live)
    events: new Map(),       // id -> [real estop/override events] (ascending ts)
    dataCache: new Map(),    // id -> {parts, groups, bands, truncated} — survives lane hide/show
    bulkCache: new Map(),    // windowKey -> {ts, byMachine, evKey} — memoized fetches
    pinned: null,            // pinned job card: { id, p } or null
    token: 0,
    liveTimer: null,
    raf: null,
    dragging: false,         // calendar-style drag-to-pan in progress
    panStartX: 0,
    panStartAnchor: 0,
    buf: { from: 0, to: 0, loaded: false }, // loaded data span (wider than view)
    cover: { from: 0, to: 0, has: false },  // contiguous span actually fetched & merged
  };

  // range buttons
  for (const r of RANGES) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "tl-rbtn"; b.dataset.r = r.key; b.textContent = r.label;
    b.addEventListener("click", () => setRange(r.key));
    refs.ranges.appendChild(b);
  }
  function syncRangeBtns() {
    // highlight the preset whose span matches the current zoom; if the user has
    // stretched to a custom span none stays lit.
    const match = RANGES.find((r) => Math.abs(r.ms - ctx.spanMs) < r.ms * 0.02);
    ctx.rangeKey = match ? match.key : ctx.rangeKey;
    refs.ranges.querySelectorAll(".tl-rbtn").forEach((b) =>
      b.classList.toggle("is-active", !!match && b.dataset.r === match.key));
  }

  // ---- machine filter (default = all) ----
  const isVisible = (id) => !ctx.sel || ctx.sel.has(id);

  function filterLabelText() {
    if (!ctx.sel || !ctx.sel.size) return "All machines";
    const n = ctx.machines.filter((m) => ctx.sel.has(m.id)).length;
    if (n === ctx.machines.length) return "All machines";
    if (n === 1) {
      const m = ctx.machines.find((x) => ctx.sel.has(x.id));
      return m ? m.name : "1 machine";
    }
    return `${n} machines`;
  }

  // (re)build the dropdown rows from the current machine list + selection
  function buildFilterMenu() {
    const allOn = !ctx.sel || ctx.sel.size === ctx.machines.length;
    const rows = ctx.machines.map(({ id, name }) => {
      const on = isVisible(id);
      return `<label class="tl-filter-opt"><input type="checkbox" data-mid="${escAttr(id)}" ${on ? "checked" : ""}><span>${escTip(name)}</span></label>`;
    }).join("");
    refs.filterMenu.innerHTML =
      `<label class="tl-filter-opt tl-filter-all"><input type="checkbox" data-mid="__all__" ${allOn ? "checked" : ""}><span>All machines</span></label>
       <div class="tl-filter-divider"></div>${rows}`;
    refs.filterMenu.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", onFilterChange);
    });
    refs.filterLabel.textContent = filterLabelText();
  }

  function onFilterChange(e) {
    const mid = e.target.dataset.mid;
    if (mid === "__all__") {
      ctx.sel = e.target.checked ? null : new Set();  // all on, or none
    } else {
      // start from the current effective set (all ids if sel is null)
      const set = ctx.sel ? new Set(ctx.sel) : new Set(ctx.machines.map((m) => m.id));
      if (e.target.checked) set.add(mid); else set.delete(mid);
      ctx.sel = set.size === ctx.machines.length ? null : set;
    }
    saveSel(ctx.sel);
    buildFilterMenu();         // refresh checkmarks + label
    applyFilter();             // add/remove lanes, relayout
  }

  // create lanes for visible machines, drop hidden ones, then relayout+repaint.
  // Re-enabling a machine restores its data from dataCache for an INSTANT paint,
  // then we always kick a fresh buffer load for the current window so a machine
  // whose cache is empty (or stale) actually fills in. The fresh load is cheap:
  // a recently-seen window is served from bulkCache with no network at all.
  function applyFilter() {
    let idx = 0;
    for (const { id, name } of ctx.machines) {
      if (isVisible(id)) {
        const lane = ensureLane(id, name, idx++);
        lane.nameEl.textContent = name;
        const cached = ctx.dataCache.get(id);
        if (cached && (!lane.parts || !lane.parts.length) && (!lane.bands || !lane.bands.length)) {
          lane.parts = cached.parts;
          lane.groups = cached.groups;
          lane.bands = cached.bands || [];
          lane.truncated = cached.truncated;
        }
      } else {
        removeLane(id);
      }
    }
    resize();
    repaint();
    // Always refresh the current window for the visible set. A cached non-empty
    // window is a bulkCache hit (instant, no network); an empty/missing one
    // triggers the real fetch — this is what fixes "select a machine, never
    // loads": an empty cached lane is no longer mistaken for "already loaded".
    ensureBuffer(true);
  }

  function toggleFilterMenu(open) {
    const show = open == null ? refs.filterMenu.hidden : open;
    refs.filterMenu.hidden = !show;
    refs.filterBtn.setAttribute("aria-expanded", String(show));
  }
  refs.filterBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleFilterMenu(); });
  // click outside closes the menu
  const onDocClick = (e) => {
    if (!refs.filterWrap.contains(e.target)) toggleFilterMenu(false);
  };
  document.addEventListener("click", onDocClick);

  function windowSpan() {
    const span = ctx.spanMs;
    const to = ctx.live ? Date.now() : ctx.anchor;
    return { from: to - span, to, span };
  }

  function setRange(key) {
    if (!RANGE_MS[key]) return;
    ctx.rangeKey = key;
    ctx.spanMs = RANGE_MS[key];  // preset jumps reset the continuous zoom
    localStorage.setItem(LS_RANGE, key);
    syncRangeBtns();
    if (ctx.pinned) unpin();    // pinned part may leave the view on a span change
    // re-center NOW in the new span (matches the on-load centered view)
    ctx.live = false;
    ctx.anchor = Date.now() + RANGE_MS[key] * 0.5;
    ctx.buf.loaded = false;     // new span → buffer no longer valid
    ctx.cover.has = false;      // new span → contiguous coverage restarts
    loadRange(true);
  }
  function scroll(dir) {
    const span = ctx.spanMs;
    const step = span * 0.5;
    const maxFuture = Date.now() + span * 0.5;   // allow half a span of empty future room
    const base = ctx.live ? Date.now() : ctx.anchor;
    let next = base + dir * step;
    if (next > maxFuture) next = maxFuture;       // cap how far into the future we scroll
    // live only when the right edge sits ~at now; past that we're future-anchored.
    if (Math.abs(next - Date.now()) < 1000) { ctx.live = true; }
    else { ctx.live = false; ctx.anchor = next; }
    paintWinLabel();
    repaint();
    ensureBuffer();
  }
  refs.prev.addEventListener("click", () => scroll(-1));
  refs.next.addEventListener("click", () => scroll(1));

  // ---- grab the top time ruler and drag to stretch/zoom ----
  // Drag right = stretch hours apart (zoom in / shorter span). Drag left =
  // squeeze (zoom out / longer span). Everything is computed from a FROZEN
  // snapshot taken at grab time so there's no compounding drift: we keep the
  // timestamp under the grab point pinned and only rescale the span.
  function attachAxisStretch(canvas) {
    let active = false, grabX = 0, grabFrac = 0.5, startSpan = 0, pivot = 0, moved = false;
    canvas.style.cursor = "ew-resize";
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      active = true; moved = false;
      grabX = e.clientX;
      const w = canvas.clientWidth || 1;
      grabFrac = Math.min(1, Math.max(0, e.offsetX / w));
      startSpan = ctx.spanMs;
      // freeze the timestamp under the cursor at grab time
      const to = ctx.live ? Date.now() : ctx.anchor;
      pivot = (to - startSpan) + grabFrac * startSpan;
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!active) return;
      const w = canvas.clientWidth || 1;
      const dx = e.clientX - grabX;
      if (Math.abs(dx) > 2) moved = true;
      // drag a full canvas width right => ~3x zoom in; left => ~3x out.
      const factor = Math.exp(-(dx / w) * 1.1);
      let next = Math.max(MIN_SPAN, Math.min(MAX_SPAN, startSpan * factor));
      // keep `pivot` under grabFrac of the new span
      let newTo = pivot + (1 - grabFrac) * next;
      const now = Date.now();
      const maxFuture = now + next * 0.5;
      if (newTo > maxFuture) newTo = maxFuture;
      ctx.spanMs = next;
      if (Math.abs(newTo - now) < 1000) { ctx.live = true; ctx.anchor = now; }
      else { ctx.live = false; ctx.anchor = newTo; }
      syncRangeBtns();
      paintWinLabel();
      repaint();
    });
    const end = (e) => {
      if (!active) return;
      active = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      if (moved) ensureBuffer(true);
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  }
  if (refs.axis) attachAxisStretch(refs.axis);
  refs.now.addEventListener("click", () => { ctx.live = true; paintWinLabel(); repaint(); ensureBuffer(); });

  // ---- jump to a specific calendar day (date picker) ----
  // Center the visible window on noon of the chosen IST day, keeping the
  // current zoom level. Future days clamp so the window never runs past now.
  function jumpToDate(yyyyMmDd) {
    if (!yyyyMmDd) return;
    const [y, mo, d] = yyyyMmDd.split("-").map(Number);
    if (!y || !mo || !d) return;
    // local midnight of that day in IST, then center on 12:00
    const dayStartUtc = Date.UTC(y, mo - 1, d) - IST_OFFSET;
    const center = dayStartUtc + 12 * 3600e3;
    let to = center + ctx.spanMs * 0.5;
    const now = Date.now();
    const maxFuture = now + ctx.spanMs * 0.5;
    if (to > maxFuture) to = maxFuture;
    if (ctx.pinned) unpin();
    if (Math.abs(to - now) < 1000) { ctx.live = true; ctx.anchor = now; }
    else { ctx.live = false; ctx.anchor = to; }
    ctx.buf.loaded = false;
    ctx.cover.has = false;
    paintWinLabel();
    repaint();
    loadRange(true);
  }
  if (refs.datePick) refs.datePick.addEventListener("change", (e) => jumpToDate(e.target.value));

  // ---- calendar-style pan: shift the window's right edge by a time delta ----
  // dtMs > 0 moves toward the future, < 0 toward the past. We clamp the future
  // to "now" and snap back into live mode when the window reaches the present.
  function panByMs(dtMs) {
    const span = ctx.spanMs;
    const base = ctx.live ? Date.now() : ctx.anchor;
    let next = base + dtMs;
    const now = Date.now();
    const maxFuture = now + span * 0.5;           // half-span of empty future room
    if (next > maxFuture) next = maxFuture;
    if (Math.abs(next - now) < 1000) { ctx.live = true; ctx.anchor = now; }
    else { ctx.live = false; ctx.anchor = next; }
    paintWinLabel();
    repaint();              // instant: paint against the already-loaded buffer
    ensureBuffer();         // only refetches if the view nears the buffer edge
  }
  // pan by a pixel delta on a lane canvas (px → ms via the active span)
  function panByPx(dxPx, canvasW) {
    const span = ctx.spanMs;
    if (!canvasW) return;
    panByMs(-(dxPx / canvasW) * span); // drag right → go back in time
  }

  // ---- continuous zoom / stretch (Ctrl|⌘ + wheel, or pinch) ----------------
  // Clamp the visible span between 5 minutes and 60 days. factor < 1 zooms in
  // (shorter span / more detail), > 1 zooms out. fracX is the cursor position
  // across the canvas (0..1) so the timestamp under the pointer stays put —
  // exactly how a map/calendar zoom feels.
  const MIN_SPAN = 5 * 60e3;          // 5 minutes
  const MAX_SPAN = 60 * 86400e3;      // 60 days
  function zoomBy(factor, fracX) {
    const oldSpan = ctx.spanMs;
    let next = oldSpan * factor;
    next = Math.max(MIN_SPAN, Math.min(MAX_SPAN, next));
    if (next === oldSpan) return;
    const f = (typeof fracX === "number" && fracX >= 0 && fracX <= 1) ? fracX : 0.5;
    // timestamp currently under the cursor (window right edge = to)
    const to = ctx.live ? Date.now() : ctx.anchor;
    const from = to - oldSpan;
    const pivot = from + f * oldSpan;
    // new right edge keeps `pivot` under the same fraction of the new span
    let newTo = pivot + (1 - f) * next;
    const now = Date.now();
    const maxFuture = now + next * 0.5;
    if (newTo > maxFuture) newTo = maxFuture;
    ctx.spanMs = next;
    if (Math.abs(newTo - now) < 1000) { ctx.live = true; ctx.anchor = now; }
    else { ctx.live = false; ctx.anchor = newTo; }
    syncRangeBtns();
    paintWinLabel();
    repaint();
    // debounced fresh buffer: a big zoom can outrun incremental prefetch, so
    // pull a wide buffer centered on the new view once the wheel settles.
    if (zoomBufTimer) clearTimeout(zoomBufTimer);
    zoomBufTimer = setTimeout(() => ensureBuffer(true), 180);
  }
  let zoomBufTimer = null;
  // If the visible window is comfortably inside the loaded buffer, do nothing
  // (seamless). Only when we approach an edge — or the buffer is empty / stale —
  // do we pull a fresh, wider buffer centered on the current view.
  // Prefetch gate: keep a full span of loaded runway on each side of the view.
  // When the visible window comes within one span of the contiguous coverage
  // edge, pull more (older or newer) and merge — so the user scrolling back
  // always lands on already-loaded data and never sees an empty band.
  let bufTimer = null;
  function ensureBuffer(force) {
    if (force) {                       // range switch / Now → start coverage over
      ctx.cover.has = false;
      if (bufTimer) clearTimeout(bufTimer);
      bufTimer = setTimeout(() => loadBuffer(true), 0);
      return;
    }
    const { from, to, span } = windowSpan();
    const c = ctx.cover;
    if (!c.has) { bufTimer = setTimeout(() => loadBuffer(false), 0); return; }
    const nowish = Date.now() - 5e3;
    // within one span of either coverage edge → fetch more (right edge only
    // matters when there's real future room, i.e. we're not already at ~now)
    const nearPast = (from - c.from) < span;
    const nearFuture = (c.to < nowish) && (c.to - to) < span;
    if (!nearPast && !nearFuture) return;          // comfortably inside coverage
    if (bufTimer) clearTimeout(bufTimer);
    bufTimer = setTimeout(() => loadBuffer(false), 120);
  }

  function paintWinLabel() {
    const { from, to } = windowSpan();
    const sameDay = new Date(from).toDateString() === new Date(to).toDateString();
    const left = sameDay ? clock(from) : `${dayLabel(from)} ${clock(from)}`;
    const right = ctx.live ? "now" : (sameDay ? clock(to) : `${dayLabel(to)} ${clock(to)}`);
    const head = sameDay ? `${dayLabel(from)} · ` : "";
    refs.winlabel.textContent = `${head}${left} → ${right}`;
    refs.winlabel.classList.toggle("is-live", ctx.live);
  }

  // ---- lane lifecycle (one row per machine in the grid) ----
  function ensureLane(id, name, idx) {
    let lane = ctx.lanes.get(id);
    if (lane) return lane;
    const tint = MPAL[idx % MPAL.length];
    const label = document.createElement("div");
    label.className = "tl-lane-label";
    label.innerHTML = `<i class="tl-dot"></i><span class="tl-name"></span>`;
    label.querySelector(".tl-name").textContent = name || id;
    const canvas = document.createElement("canvas");
    canvas.className = "tl-lane-canvas";
    refs.grid.appendChild(label);
    refs.grid.appendChild(canvas);
    lane = { label, canvas, dot: label.querySelector(".tl-dot"),
             nameEl: label.querySelector(".tl-name"),
             tint, parts: [], groups: [], bands: [], rects: [], grects: [] };
    ctx.lanes.set(id, lane);
    canvas.addEventListener("mousemove", (e) => onHover(e, id));
    canvas.addEventListener("mouseleave", () => { if (!ctx.dragging && !ctx.pinned) refs.tip.hidden = true; });
    canvas.addEventListener("click", (e) => { if (!ctx.didPan) onClick(e, id); });
    attachPan(canvas);
    return lane;
  }
  function removeLane(id) {
    const lane = ctx.lanes.get(id);
    if (!lane) return;
    lane.label.remove(); lane.canvas.remove();
    ctx.lanes.delete(id);
  }

  // ---- drag-to-pan + wheel-pan wiring (calendar-style time scrolling) ----
  // Grab any lane and slide left/right to move through time; release to settle.
  // Trackpad horizontal scroll (or Shift+wheel) pans without grabbing.
  function attachPan(canvas) {
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      ctx.dragging = true;
      ctx.didPan = false;                 // becomes true once the pointer travels
      ctx.panStartX = e.clientX;
      ctx.panLastX = e.clientX;
      refs.grid.classList.add("is-panning");
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!ctx.dragging) return;
      const dx = e.clientX - ctx.panLastX;
      ctx.panLastX = e.clientX;
      // only count as a pan (and suppress the click-pin) past a small threshold
      if (Math.abs(e.clientX - ctx.panStartX) > 4) {
        if (!ctx.didPan && !ctx.pinned) refs.tip.hidden = true; // first real drag hides hovercard
        ctx.didPan = true;
      }
      if (dx) panByPx(dx, canvas.clientWidth);
    });
    const end = (e) => {
      if (!ctx.dragging) return;
      ctx.dragging = false;
      refs.grid.classList.remove("is-panning");
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      ensureBuffer();   // settle: pull data if the release left us near an edge
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    // horizontal wheel / shift+wheel → pan; pick the dominant axis.
    // Ctrl|⌘ + wheel (or pinch-zoom, which browsers report as ctrl+wheel) → zoom,
    // anchored at the cursor.
    canvas.addEventListener("wheel", (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const w = canvas.clientWidth || 1;
        const fracX = e.offsetX / w;
        // wheel up / pinch out (deltaY < 0) → zoom in (shrink span)
        const factor = Math.exp(e.deltaY * 0.0015);
        zoomBy(factor, fracX);
        return;
      }
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX
        : (e.shiftKey ? e.deltaY : 0);
      if (!dx) return;                 // vertical wheel → let the grid scroll
      e.preventDefault();
      panByPx(-dx, canvas.clientWidth); // wheel right → forward in time
    }, { passive: false });
  }

  // ---- parts now arrive pre-segmented from /api/timeline_bulk ----
  // (the collector folds the 1 Hz cyremtim countdown into part segments and
  // joins the tcycle target server-side, so the browser never sees raw rows.)

  // Colour a part by how far it deviates from its program's LEARNED baseline
  // (median cycle time for that program, computed server-side from real cycles).
  //   normal  → within ±15%               (green)
  //   high    → +15–30% slower than usual  (amber)
  //   over    → >+30% slower than usual     (red)
  //   low     → >15% shorter than usual     (blue: ran fast / aborted)
  //   neutral → no baseline yet (too few cycles for this program)
  function partColor(p) {
    if (p.partial) return "partial";
    const dev = p.dev;                 // dur / baseline, from the server
    if (dev == null) return "neutral"; // honest: not enough data to judge
    if (dev > 1 + WIDE) return "over";
    if (dev > 1 + NORMAL) return "high";
    if (dev < 1 - NORMAL) return "low";
    return "normal";
  }

  // Bootstrap: refresh the machine list (overview) then pull a data buffer.
  // force=true always reloads the buffer (range switch / Now / first paint).
  async function loadRange(force) {
    const my = ++ctx.token;
    paintWinLabel(); syncRangeBtns();
    let ov;
    try { ov = await dataLayer.overview(); }
    catch (err) { 
      if (!ctx.machines.length) { 
        const isTimeout = err.name === 'AbortError' || (err.message && err.message.includes('aborted'));
        refs.note.textContent = isTimeout 
          ? "Loading timeline — collector is slow, please wait…" 
          : "Collector unreachable — cannot fetch machine list.";
        refs.note.hidden = false; 
      } 
      return; 
    }
    if (my !== ctx.token) return;
    const machines = (Array.isArray(ov.machines) ? ov.machines : [])
      .map((m) => ({ id: m.machine_id, name: m.machine_name || m.machine_id, m }));
    if (!machines.length) { if (!ctx.machines.length) { refs.note.textContent = "No machines reported."; refs.note.hidden = false; } return; }
    // Wall presentation order: the wall fleet order, not payload order. Applied
    // on every overview (which rebuilds this array) so it survives polls; the
    // dashboard path never sets wallOrder and keeps payload order.
    if (ctx.wallOrder) {
      const rank = {};
      ctx.wallOrder.forEach((id, i) => { if (!(id in rank)) rank[id] = i; });
      machines.sort((a, b) => {
        const ra = (a.id in rank) ? rank[a.id] : 1e9;
        const rb = (b.id in rank) ? rank[b.id] : 1e9;
        return ra - rb;
      });
    }
    ctx.machines = machines;
    ctx.over = new Map(machines.map((x) => [x.id, x.m]));
    // prune any saved selection down to machines that still exist
    if (ctx.sel) {
      const live = new Set(machines.map((m) => m.id));
      ctx.sel = new Set([...ctx.sel].filter((id) => live.has(id)));
      if (!ctx.sel.size || ctx.sel.size === machines.length) ctx.sel = null;
    }
    buildFilterMenu();
    // make sure a lane row exists for every VISIBLE machine before the buffer
    // arrives; drop lanes for machines hidden by the filter or gone from overview
    let vidx = 0;
    for (const { id, name } of machines) {
      if (isVisible(id)) ensureLane(id, name, vidx++).nameEl.textContent = name;
      else removeLane(id);
    }
    for (const id of [...ctx.lanes.keys()]) {
      if (!machines.some((x) => x.id === id)) removeLane(id);
    }
    await loadBuffer(force);
  }

  // Load a buffer WIDER than the visible window (3× the span, centered on the
  // view) so panning stays inside loaded data and feels seamless. We never wipe
  // lanes on a failed/empty fetch — the last good frame stays on screen.
  //
  // Caching: bulk responses are memoized in ctx.bulkCache keyed by the rounded
  // window. A window that ends in the past is IMMUTABLE (those cycles already
  // ran) → cached for the whole session, zero refetch. The live window (ends at
  // "now") is cached only briefly (LIVE_TTL) so the moving edge stays current.
  // Every fetched machine's data is also stashed in ctx.dataCache so a filter
  // hide→show never needs the network.
  const LIVE_TTL = 4000;             // ms a live-window fetch stays fresh
  const CACHE_BUCKET = 30e3;         // round window edges to 30s for cache hits
  function bulkKey(bFrom, bTo) {
    const r = (v) => Math.round(v / CACHE_BUCKET);
    return `${r(bFrom)}:${r(bTo)}`;
  }
  // merge freshly-fetched parts/groups/bands into a lane's existing arrays WITHOUT
  // wiping what's already there — this is what turns scrolling back into a
  // seamless "paged" experience: each fetch extends one contiguous dataset
  // instead of replacing the visible window. Identity: a part by (t0,job), a
  // group by groupId, a band by (t0,t1,status), so re-fetching an overlapping
  // span never duplicates.
  function mergeInto(lane, got) {
    const partKey = (p) => `${p.t0}|${p.job}`;
    const seen = new Map((lane.parts || []).map((p) => [partKey(p), p]));
    for (const p of got.parts || []) seen.set(partKey(p), p);
    lane.parts = [...seen.values()].sort((a, b) => a.t0 - b.t0);
    const gseen = new Map((lane.groups || []).map((g) => [g.groupId, g]));
    for (const g of got.groups || []) gseen.set(g.groupId, g);
    lane.groups = [...gseen.values()].sort((a, b) => a.t0 - b.t0);
    const bseen = new Map((lane.bands || []).map((b) => [`${b.t0}|${b.t1}|${b.status}`, b]));
    for (const b of got.bands || []) {
      if (b && Number.isFinite(b.t0) && Number.isFinite(b.t1)) bseen.set(`${b.t0}|${b.t1}|${b.status}`, b);
    }
    lane.bands = [...bseen.values()].sort((a, b) => a.t0 - b.t0);
    if (got.truncated) lane.truncated = true;
  }

  // apply a fetched bulk: merge=true extends the accumulated dataset (panning /
  // prefetch), merge=false replaces it (a fresh range/Now load starts over).
  function applyBulk(byMachine, evKey, merge) {
    ctx.machines.forEach(({ id }) => {
      const got = byMachine.get(id);
      if (!got) return;
      const lane = ctx.lanes.get(id);
      if (merge && lane) {
        mergeInto(lane, got);
        ctx.dataCache.set(id, { parts: lane.parts, groups: lane.groups, bands: lane.bands, truncated: lane.truncated });
      } else {
        ctx.dataCache.set(id, { parts: got.parts, groups: got.groups, bands: got.bands || [], truncated: got.truncated });
        if (lane) { lane.parts = got.parts; lane.groups = got.groups; lane.bands = got.bands || []; lane.truncated = got.truncated; }
      }
    });
    if (evKey) loadEvents(evKey.from, evKey.to);
  }

  // In-flight fetch keys (per rounded window) so concurrent pages don't dup the
  // same request. A "force" (range switch / Now) load uses ctx.token to cancel
  // stale REPLACE loads; merge (paging) loads are orthogonal — they only ADD
  // older/newer data, so they always complete and grow coverage monotonically.
  const inflight = new Set();
  async function loadBuffer(force) {
    // TV mode: clamp to current shift window only, resetting at 06/14/22 IST
    if (window.__VMC_TV__) {
      try {
        const ov = await dataLayer.overview();
        const first = (ov.machines || [])[0];
        const sh = first && first.shift_summary;
        if (sh && sh.from && sh.to) {
          const bFrom = sh.from;
          const bTo = sh.to;
          window.__vmcTvTimelineRefresh = () => loadBuffer(true);
          // replace cover with shift window
          ctx.cover = { from: bFrom, to: bTo, has: false };
          const bulk = await dataLayer.timelineBulk(bFrom, bTo);
          applyBulk(new Map(bulk.lanes.map((l) => [l.machine, l])), { from: bFrom, to: bTo }, false);
          ctx.buf = { from: bFrom, to: bTo, loaded: true };
          refs.note.hidden = true;
          resize(); repaint();
          return;
        }
      } catch (_) {}
    }
    const { from, to, span } = windowSpan();
    // Prefetch a generous runway: pad TWO spans on each side so a fast scroll
    // stays inside loaded data. Right edge clamps to ~now (no future data).
    const pad = span * 2;
    let bFrom = from - pad;
    let bTo = Math.min(to + pad, Date.now() + 60e3);

    // On a non-forced load we EXTEND the contiguous coverage: only fetch the
    // gap between what we already have and the new runway, then merge. This is
    // the paging behaviour — scrolling back keeps appending older data to one
    // growing dataset instead of swapping the window out from under you.
    const merge = !force && ctx.cover.has;
    if (merge) {
      // already fully covered with comfortable runway → nothing to do
      if (bFrom >= ctx.cover.from && bTo <= ctx.cover.to) return;
      // fetch only the missing side(s); pick the larger gap (usually the past)
      if (bFrom < ctx.cover.from && (ctx.cover.from - bFrom) >= (bTo - ctx.cover.to)) {
        bTo = ctx.cover.from;          // extend into the past
      } else if (bTo > ctx.cover.to) {
        bFrom = ctx.cover.to;          // extend into the future
      } else {
        bTo = ctx.cover.from;          // default: pull older
      }
    }

    const key = bulkKey(bFrom, bTo);
    if (inflight.has(key)) return;     // this exact span is already being fetched
    const my = force ? ++ctx.token : ctx.token;   // only force loads bump the token

    const isLiveWin = ctx.live || (Date.now() - to) < 60e3;
    const hit = ctx.bulkCache.get(key);
    const fresh = hit && (!isLiveWin || (Date.now() - hit.ts) < LIVE_TTL);
    if (fresh) {                           // cache hit → no network at all
      applyBulk(hit.byMachine, { from: bFrom, to: bTo }, merge);
      const grew = growCover(bFrom, bTo, merge);
      ctx.buf = { from: ctx.cover.from, to: ctx.cover.to, loaded: true };
      refs.note.hidden = true;
      resize(); repaint();
      if (grew) ensureBuffer();            // chase only if we made progress
      return;
    }
    inflight.add(key);
    // skeleton/progress for every bulk flight, live or past window (same chip)
    showLoading(true);
    try {
      const bulk = await dataLayer.timelineBulk(bFrom, bTo);
      // a REPLACE load that's been superseded by a newer force load is dropped;
      // MERGE loads are always applied (they only add disjoint data)
      if (!merge && my !== ctx.token) return;
      const byMachine = new Map(bulk.lanes.map((l) => [l.machine, l]));
      ctx.bulkCache.set(key, { ts: Date.now(), byMachine });
      if (ctx.bulkCache.size > 64) {
        const oldest = ctx.bulkCache.keys().next().value;
        ctx.bulkCache.delete(oldest);
      }
      applyBulk(byMachine, { from: bFrom, to: bTo }, merge);
      const grew = growCover(bFrom, bTo, merge);
      ctx.buf = { from: ctx.cover.from, to: ctx.cover.to, loaded: true };
      refs.note.hidden = true;
      persistSnapshot();   // device-store this fresh board for an instant cold reload
      ctx._grew = grew;
    } catch (err) {
      if (!ctx.buf.loaded) { 
        const isTimeout = err.name === 'AbortError' || (err.message && err.message.includes('aborted'));
        refs.note.textContent = isTimeout 
          ? "Timeline data loading slowly — please wait…" 
          : "Timeline data unavailable: " + (err.message || "unknown error");
        refs.note.hidden = false; 
      }
    } finally {
      inflight.delete(key);
      showLoading(false);
    }
    resize();
    repaint();
    if (ctx._grew) ensureBuffer();   // chase the runway only while we keep gaining coverage
  }

  // extend (merge) or reset (replace) the contiguous coverage window.
  // Returns true if coverage actually changed — callers use this to decide
  // whether chasing the runway with another fetch could make progress (and so
  // avoid an infinite fetch loop when the server has no more data that way).
  function growCover(f, t, merge) {
    if (merge && ctx.cover.has) {
      const nf = Math.min(ctx.cover.from, f);
      const nt = Math.max(ctx.cover.to, t);
      const grew = nf < ctx.cover.from || nt > ctx.cover.to;
      ctx.cover.from = nf; ctx.cover.to = nt;
      return grew;
    }
    ctx.cover = { from: f, to: t, has: true };
    return true;
  }

  let loadingCount = 0;
  function showLoading(on) {
    loadingCount = Math.max(0, loadingCount + (on ? 1 : -1));
    if (refs.loading) refs.loading.hidden = loadingCount === 0;
  }

  // ---- real incident events (estop / override dip) for the detail cards ----
  // One fetch per loaded buffer; grouped by machine, ascending ts. The cards
  // overlap these onto a program/job [t0,t1] window — all real /api/events rows,
  // nothing invented. A failed fetch just leaves the cards without an incident
  // section (they still show timing/quality).
  let evBusy = false;
  let evKey = "";          // last loaded events window — skip refetch for the same
  async function loadEvents(fromMs, toMs) {
    if (evBusy) return;
    const key = bulkKey(fromMs, toMs);
    const isLiveWin = (Date.now() - toMs) < 60e3;
    if (key === evKey && !isLiveWin) return;   // immutable past window already loaded
    evBusy = true;
    try {
      const evs = await dataLayer.events(fromMs, toMs);
      const byMachine = new Map();
      for (const e of evs) {
        if (!byMachine.has(e.machine)) byMachine.set(e.machine, []);
        byMachine.get(e.machine).push(e);
      }
      for (const arr of byMachine.values()) arr.sort((a, b) => a.ts - b.ts);
      ctx.events = byMachine;
      evKey = key;
      persistSnapshot();   // refresh the device snapshot now that events are in
    } catch (_) { /* leave prior events; cards degrade gracefully */ }
    finally { evBusy = false; }
  }

  // events for one machine whose ts falls inside [t0,t1] (ms)
  function eventsInWindow(machineId, t0, t1) {
    const arr = ctx.events && ctx.events.get(machineId);
    if (!arr) return [];
    return arr.filter((e) => e.ts >= t0 && e.ts <= t1);
  }


  let liveBusy = false;
  async function liveTick() {
    if (liveBusy) return;
    if (!refs.grid.offsetParent) return; // tab not visible
    liveBusy = true;
    try {
      const ov = await dataLayer.overview();
      ctx.over = new Map((ov.machines || []).map((m) => [m.machine_id, m]));
      paintWinLabel();
      repaint();
    } catch (err) { 
      // Live tick failure is non-fatal — keep last frame, but log for debugging
      console.warn('[timeline] live tick failed:', err);
    }
    finally { liveBusy = false; }
  }

  // ---- rendering ----
  // Lane height is dynamic: resize() grows it to fill the available viewport so
  // the board never leaves a wasted empty band below the last machine. This is
  // the floor (small screens / many machines fall back to scrolling at this H).
  const LANE_MIN = 104;
  ctx.laneH = LANE_MIN;
  function resize() {
    const w = refs.grid.querySelector(".tl-lane-canvas")?.clientWidth
      || refs.axis.clientWidth || 600;
    const dpr = window.devicePixelRatio || 1;

    // Grow lanes to fill the viewport so no empty band is wasted below the last
    // machine. Budget = space from the grid's top down to a small bottom margin,
    // minus the sticky axis row and the inter-row gaps; split across all lanes.
    const n = ctx.lanes.size || 1;
    const gridTop = refs.grid.getBoundingClientRect().top;
    const AXIS_ROW = 30, GRID_PAD = 26, ROW_GAP = 6, BOTTOM_MARGIN = 22;
    const budget = window.innerHeight - gridTop - GRID_PAD - AXIS_ROW
      - ROW_GAP * n - BOTTOM_MARGIN;
    ctx.laneH = Math.max(LANE_MIN, Math.floor(budget / n));

    const setup = (cv, h) => {
      cv.width = Math.max(1, Math.round(w * dpr));
      cv.height = Math.round(h * dpr);
      const g = cv.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      return g;
    };
    refs.axisG = setup(refs.axis, 26);
    refs.axisW = w;
    for (const lane of ctx.lanes.values()) {
      lane.g = setup(lane.canvas, ctx.laneH);
      lane.w = w;
      lane.canvas.style.height = ctx.laneH + "px";
      lane.label.style.height = ctx.laneH + "px";
    }
  }

  function tickStep(span) {
    // choose a human tick interval for the axis
    const H = 3600e3, D = 86400e3;
    if (span <= 2 * H) return { step: 15 * 60e3, fmt: clock };
    if (span <= 8 * H) return { step: H, fmt: clock };
    if (span <= 2 * D) return { step: 3 * H, fmt: clock };
    if (span <= 9 * D) return { step: D, fmt: (ms) => dayLabel(ms).replace(/,.*/, "") };
    return { step: 7 * D, fmt: (ms) => dayLabel(ms).replace(/,.*/, "") };
  }

  function paintAxis(from, to, span) {
    const g = refs.axisG, w = refs.axisW; if (!g) return;
    const light = isLight();
    g.clearRect(0, 0, w, 26);
    g.font = "11px ui-monospace, monospace";
    g.textBaseline = "middle";
    const { step, fmt } = tickStep(span);
    const x = (ts) => ((ts - from) / span) * w;
    let t = Math.ceil(from / step) * step;
    for (; t <= to; t += step) {
      const px = x(t);
      g.strokeStyle = light ? "rgba(71,85,105,0.38)" : "rgba(148,163,184,0.42)";
      g.beginPath(); g.moveTo(px, 0); g.lineTo(px, 26); g.stroke();
      g.fillStyle = light ? "rgba(51,65,85,0.95)" : "rgba(203,213,225,0.92)";
      g.fillText(fmt(t), px + 4, 13);
    }
    // day boundary marker on the axis — red tick + date label, lined up with the
    // full-height red divider painted across the lanes.
    for (let d = istDayStart(from); d <= to; d += 86400e3) {
      if (d < from) continue;
      const px = x(d);
      g.strokeStyle = "rgba(239,68,68,0.95)";
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(px, 0); g.lineTo(px, 26); g.stroke();
      g.lineWidth = 1;
      g.fillStyle = "rgba(239,68,68,0.95)";
      g.font = "600 11px ui-monospace, monospace";
      g.fillText(dayLabel(d).replace(/,.*/, ""), px + 5, 13);
      g.font = "11px ui-monospace, monospace";
    }
    // NOW marker on the axis — yellow tick, only when "now" falls inside the view.
    const nowMs = Date.now();
    if (nowMs >= from && nowMs <= to) {
      const px = x(nowMs);
      g.strokeStyle = "rgba(250,204,21,0.95)";
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(px, 0); g.lineTo(px, 26); g.stroke();
      g.lineWidth = 1;
      g.fillStyle = "rgba(250,204,21,0.95)";
      g.font = "600 11px ui-monospace, monospace";
      g.fillText("NOW", px + 5, 13);
      g.font = "11px ui-monospace, monospace";
    }
  }

  // a stable-ish color per program name (so the same program reads the same
  // across the day) — hashed hue, muted for a band background.
  function progHue(name) {
    if (!name) return 220;
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return h;
  }

  function paintLane(lane, from, to, span, id) {
    const g = lane.g, w = lane.w, H = ctx.laneH; if (!g) return;
    const light = isLight();
    g.clearRect(0, 0, w, H);
    const x = (ts) => ((ts - from) / span) * w;
    const bandTop = 6, bandH = 20;          // program-group band (top, fixed)
    const yTop = 34, hSeg = H - yTop - 8;   // part row grows to fill the lane
    lane.rects = [];
    lane.grects = [];

    // ---- machine-state bands (additive background coverage from timeline_bulk) ----
    // Painted FIRST so group bands + part segments draw over them. A lane with
    // bands but zero parts still paints its idle/stopped windows — that is the
    // fix. Missing/empty bands => this loop is a no-op (today's behavior).
    // Colors reuse the lane status palette at ~25% alpha (see godmode.css vars).
    const BAND_COL = {
      running: "#34d399", idle: "#38bdf8", paused: "#f59e0b",
      alarm: "#ef4444", offline: "#64748b", unknown: "#64748b",
    };
    const bands = lane.bands || [];
    if (bands.length) {
      g.save();
      g.globalAlpha = 0.25;
      for (const b of bands) {
        if (!b || !Number.isFinite(b.t0) || !Number.isFinite(b.t1)) continue;
        if (b.t1 < from || b.t0 > to) continue;
        const x0 = Math.max(0, x(b.t0)), x1 = Math.min(w, x(b.t1));
        const ww = Math.max(2, x1 - x0);
        g.fillStyle = BAND_COL[b.status] || BAND_COL.unknown;
        g.fillRect(x0, 0, ww, H);
      }
      g.restore();
    }

    // ---- program-group bands (one tinted strip per contiguous program run) ----
    g.font = "600 11px ui-monospace, monospace";
    g.textBaseline = "middle";
    for (const grp of (lane.groups || [])) {
      if (grp.t1 < from || grp.t0 > to) continue;
      const x0 = Math.max(0, x(grp.t0)), x1 = Math.min(w, x(grp.t1));
      const ww = Math.max(2, x1 - x0);
      const hue = progHue(grp.program);
      g.fillStyle = light ? `hsla(${hue}, 48%, 86%, 0.85)` : `hsla(${hue}, 55%, 55%, 0.16)`;
      roundRect(g, x0, bandTop, ww, bandH, 3); g.fill();
      g.strokeStyle = light ? `hsla(${hue}, 45%, 52%, 0.55)` : `hsla(${hue}, 60%, 62%, 0.5)`;
      g.lineWidth = 1; roundRect(g, x0 + 0.5, bandTop + 0.5, ww - 1, bandH - 1, 3); g.stroke();
      // label: program name + job count, if the band is wide enough
      const label = `${(grp.program || "—").replace(/\.nc$/i, "")} · ${grp.count} job${grp.count === 1 ? "" : "s"}`;
      if (ww > 60) {
        g.save();
        g.beginPath(); g.rect(x0 + 4, bandTop, ww - 8, bandH); g.clip();
        g.fillStyle = light ? `hsla(${hue}, 60%, 26%, 0.95)` : `hsla(${hue}, 70%, 82%, 0.95)`;
        g.fillText(label, x0 + 6, bandTop + bandH / 2 + 1);
        g.restore();
      }
      lane.grects.push({ x0, x1: x0 + ww, grp, y0: bandTop, y1: bandTop + bandH });
    }

    const COL = {
      normal: "#34d399", high: "#f59e0b", over: "#ef4444",
      low: "#38bdf8", neutral: "#64748b", partial: "#5b6b82",
    };
    for (const p of lane.parts) {
      if (p.t1 < from || p.t0 > to) continue;
      const x0 = Math.max(0, x(p.t0)), x1 = Math.min(w, x(p.t1));
      const ww = Math.max(2, x1 - x0);
      const kind = partColor(p);
      g.fillStyle = COL[kind];
      g.globalAlpha = p.partial ? 0.5 : 0.92;
      roundRect(g, x0, yTop, ww, hSeg, 3); g.fill();
      g.globalAlpha = 1;
      // job number centered when the segment is wide enough to read
      if (ww > 18 && p.job != null) {
        g.fillStyle = "rgba(8,12,20,0.82)";
        g.font = "600 13px ui-monospace, monospace";
        g.textAlign = "center";
        g.fillText(String(p.job), x0 + ww / 2, yTop + hSeg / 2 + 1);
        g.textAlign = "left";
      }
      lane.rects.push({ x0, x1: x0 + ww, p, no: p.job, kind });
    }

    // live edge: current in-progress part from overview (only when window holds "now")
    const m = ctx.over.get(id);
    if (m && to >= Date.now() - 2000) {
      const elapsed = Number(m.cycle && m.cycle.this_cycle);
      const active = String(m.execution).toUpperCase() === "ACTIVE";
      if (Number.isFinite(elapsed) && elapsed > 0) {
        const now = Date.now();
        const t0 = now - elapsed * 1000;
        const x0 = Math.max(0, x(t0)), x1 = Math.min(w, x(now));
        const ww = Math.max(2, x1 - x0);
        g.save();
        g.fillStyle = active ? lane.tint : "#64748b";
        g.globalAlpha = active ? (0.55 + 0.35 * Math.abs(Math.sin(now / 600))) : 0.4;
        roundRect(g, x0, yTop, ww, hSeg, 3); g.fill();
        g.globalAlpha = 1;
        // leading tick
        g.strokeStyle = active ? lane.tint : "#94a3b8";
        g.lineWidth = 2;
        g.beginPath(); g.moveTo(x1, yTop - 2); g.lineTo(x1, yTop + hSeg + 2); g.stroke();
        g.restore();
        lane.rects.push({ x0, x1: x0 + ww, live: true, m, no: "live" });
      }
    }

    // gridlines OVERLAID on top of the bars (drawn last) so the time ticks stay
    // visible even where green segments would otherwise paint right over them.
    // A subtle dark line under a light one gives contrast on both bars and gaps.
    const { step } = tickStep(span);
    let gt = Math.ceil(from / step) * step;
    for (; gt <= to; gt += step) {
      const px = Math.round(x(gt)) + 0.5;
      g.lineWidth = 1;
      g.strokeStyle = "rgba(8,12,20,0.30)";          // dark base for contrast on bars
      g.beginPath(); g.moveTo(px, yTop - 2); g.lineTo(px, H); g.stroke();
      g.strokeStyle = light ? "rgba(30,41,59,0.45)" : "rgba(226,232,240,0.45)";
      g.setLineDash([3, 4]);
      g.beginPath(); g.moveTo(px, yTop - 2); g.lineTo(px, H); g.stroke();
      g.setLineDash([]);
    }

    // DAY BOUNDARY — a solid red line at every 00:00 IST, full lane height, no
    // gaps (so each calendar day reads as a hard divider on the board).
    for (let d = istDayStart(from); d <= to; d += 86400e3) {
      if (d < from) continue;
      const px = Math.round(x(d)) + 0.5;
      g.strokeStyle = "rgba(239,68,68,0.95)";
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();
    }

    // NOW marker — a solid yellow line at the present moment, full lane height,
    // only when "now" is inside the visible window (so scrolling forward shows
    // empty future space to the right of it).
    const nowMs = Date.now();
    if (nowMs >= from && nowMs <= to) {
      const px = Math.round(x(nowMs)) + 0.5;
      g.strokeStyle = "rgba(250,204,21,0.95)";
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();
    }
    // lane status dot — one indicator only: machine online vs offline
    const mo = ctx.over.get(id);
    if (mo) {
      const st = String(mo.status || "").toLowerCase();
      const offline = mo.online === false || st === "offline" || st === "unavailable";
      lane.dot.className = `tl-dot st-${offline ? "offline" : "online"}`;
    }
  }

  function repaint() {
    const { from, to, span } = windowSpan();
    paintAxis(from, to, span);
    for (const [id, lane] of ctx.lanes) paintLane(lane, from, to, span, id);
  }

  // ---- rich detail cards (program-group + single-job) ----
  // All numbers below come from real part t0/t1/dur/dev + real /api/events.

  const escTip = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // a sparkline of per-job durations; bars colored by deviation band (same hues
  // as the lane segments). Pure inline HTML — no extra canvas to tear down.
  function sparkBars(parts) {
    const done = parts.filter((p) => !p.partial && p.dur > 0);
    if (!done.length) return "";
    const max = Math.max(...done.map((p) => p.dur));
    const cls = (p) => {
      if (p.dev == null) return "n";
      if (p.dev > 1 + WIDE) return "over";
      if (p.dev > 1 + NORMAL) return "high";
      if (p.dev < 1 - NORMAL) return "low";
      return "ok";
    };
    const bars = done.slice(-48).map((p) =>
      `<i class="sb-${cls(p)}" style="height:${Math.max(6, Math.round((p.dur / max) * 100))}%"></i>`
    ).join("");
    return `<div class="tl-spark">${bars}</div>`;
  }

  // run-time split bar: cutting (sum of part durations) vs idle (the gaps).
  function splitBar(cuttingMs, idleMs) {
    const tot = cuttingMs + idleMs;
    if (tot <= 0) return "";
    const cutPct = Math.max(2, Math.round((cuttingMs / tot) * 100));
    return `<div class="tl-split"><span class="cut" style="flex:${cutPct}"></span><span class="idle" style="flex:${100 - cutPct}"></span></div>
      <div class="tl-split-legend"><span class="cut">cutting ${dur(cuttingMs)}</span><span class="idle">idle ${dur(idleMs)}</span></div>`;
  }

  // render the real incidents (estop/override) inside a [t0,t1] window
  function incidentsHtml(id, t0, t1, { compact = false } = {}) {
    const evs = eventsInWindow(id, t0, t1);
    if (!evs.length) return `<div class="tl-card-sec"><div class="tl-sec-h">what happened</div><div class="tl-clean">✓ clean — no e-stops or override dips</div></div>`;
    const estops = evs.filter((e) => e.rule === "estop").length;
    const ovr = evs.filter((e) => e.rule === "override").length;
    const summary = [estops ? `${estops} e-stop${estops > 1 ? "s" : ""}` : "", ovr ? `${ovr} override dip${ovr > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");
    const rows = (compact ? evs : evs.slice(0, 6)).map((e) => {
      const sev = e.rule === "estop" ? "ev-crit" : "ev-warn";
      return `<div class="tl-ev ${sev}"><span class="tl-ev-dot"></span><span class="tl-ev-t">${clockS(e.ts)}</span><span class="tl-ev-m">${escTip(e.msg || e.rule)}</span></div>`;
    }).join("");
    const more = !compact && evs.length > 6 ? `<div class="tl-tip-dim">+${evs.length - 6} more</div>` : "";
    return `<div class="tl-card-sec"><div class="tl-sec-h">what happened · ${summary}</div>${rows}${more}</div>`;
  }

  function buildGroupCard(lane, id, grp) {
    const parts = (lane.parts || []).filter((p) => p.groupId === grp.groupId);
    const done = parts.filter((p) => !p.partial);
    const durs = done.map((p) => p.dur).filter((d) => d > 0);
    const cuttingMs = parts.reduce((a, p) => a + (p.dur || 0), 0);
    const wallMs = grp.t1 - grp.t0;
    const idleMs = Math.max(0, wallMs - cuttingMs);
    const avg = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : null;
    const base = grp.baseline;
    const judged = done.filter((p) => p.dev != null);
    const inNorm = judged.filter((p) => Math.abs(p.dev - 1) <= NORMAL).length;
    const slow = judged.filter((p) => p.dev > 1 + NORMAL).length;
    const short = judged.filter((p) => p.dev < 1 - NORMAL).length;
    const qPct = judged.length ? Math.round((inNorm / judged.length) * 100) : null;
    const qCls = qPct == null ? "" : qPct >= 90 ? "q-good" : qPct >= 70 ? "q-mid" : "q-bad";

    // Composite program score (top-right badge). Honest, from real signals:
    //   utilization = cutting time / wall-clock run time (how much of the run
    //                 was actually cutting vs idle gaps)
    //   quality     = jobs within ±15% of learned baseline / judged jobs
    //   incidents   = small penalty per real event (estop hits harder)
    // score = util × quality × incidentFactor, clamped 0–100. All inputs shown
    // below the badge so the number is never a black box.
    const utilPct = wallMs > 0 ? Math.round((cuttingMs / wallMs) * 100) : null;
    const evs = eventsInWindow(id, grp.t0, grp.t1);
    const estops = evs.filter((e) => e.rule === "estop").length;
    const ovrDips = evs.filter((e) => e.rule === "override").length;
    let score = null, scoreCls = "";
    if (utilPct != null && qPct != null) {
      const incidentFactor = Math.max(0.6, 1 - (estops * 0.08 + ovrDips * 0.01));
      score = Math.round(Math.min(100, (utilPct / 100) * (qPct / 100) * incidentFactor * 100));
      scoreCls = score >= 85 ? "sc-good" : score >= 65 ? "sc-mid" : "sc-bad";
    }
    const scoreBadge = score != null
      ? `<div class="tl-score ${scoreCls}" title="utilization ${utilPct}% × cycle-quality ${qPct}%${estops || ovrDips ? ` − incidents` : ""}"><span class="tl-score-n">${score}</span><span class="tl-score-u">score</span></div>`
      : "";
    return `
      <div class="tl-card-head">
        ${scoreBadge}
        <b>${escTip((grp.program || "—").replace(/\.nc$/i, ""))}</b>
        <div class="tl-tip-row">program group · ${grp.count} job${grp.count === 1 ? "" : "s"}</div>
      </div>
      ${score != null ? `<div class="tl-card-sec tl-score-break">
        <div class="tl-kv"><span>utilization</span><span class="${utilPct >= 80 ? "q-good" : utilPct >= 55 ? "q-mid" : "q-bad"}">${utilPct}%</span></div>
        <div class="tl-kv"><span>cycle quality</span><span class="${qCls}">${qPct}%</span></div>
        ${estops || ovrDips ? `<div class="tl-kv"><span>incidents</span><span class="q-mid">${estops ? estops + " e-stop · " : ""}${ovrDips} dip${ovrDips === 1 ? "" : "s"}</span></div>` : `<div class="tl-kv"><span>incidents</span><span class="q-good">none</span></div>`}
      </div>` : ""}
      <div class="tl-card-sec">
        <div class="tl-kv"><span>started</span><span>${clockS(grp.t0)}</span></div>
        <div class="tl-kv"><span>ended</span><span>${clockS(grp.t1)}</span></div>
        <div class="tl-kv"><span>run time</span><span>${dur(wallMs)}</span></div>
      </div>
      <div class="tl-card-sec">
        <div class="tl-sec-h">run-time split</div>
        ${splitBar(cuttingMs, idleMs)}
      </div>
      <div class="tl-card-sec">
        <div class="tl-sec-h">per-job duration</div>
        ${sparkBars(parts) || '<div class="tl-tip-dim">no completed jobs yet</div>'}
        ${avg ? `<div class="tl-kv"><span>avg / job</span><span>${dur(avg)}</span></div>` : ""}
        ${base ? `<div class="tl-kv"><span>usual / job</span><span>${dur(base * 1000)} <span class="tl-tip-dim">n=${grp.baselineN}</span></span></div>` : `<div class="tl-tip-dim">no baseline yet (need ≥5 cycles)</div>`}
      </div>
      ${judged.length ? `<div class="tl-card-sec"><div class="tl-sec-h">cycle-time quality</div>
        <div class="tl-q ${qCls}"><b>${inNorm}/${judged.length}</b> normal${qPct != null ? ` · ${qPct}%` : ""}</div>
        <div class="tl-tip-dim">${slow ? `${slow} slow` : ""}${slow && short ? " · " : ""}${short ? `${short} short` : ""}${!slow && !short ? "all within ±15% of usual" : ""}</div></div>` : ""}
      ${incidentsHtml(id, grp.t0, grp.t1)}`;
  }

  function buildJobCard(lane, id, p, pinned) {
    const grp = (lane.groups || []).find((gg) => gg.groupId === p.groupId);
    const prog = (p.program || "—").replace(/\.nc$/i, "");
    let verdict = "";
    if (p.dev != null && !p.partial) {
      const pct = Math.round((p.dev - 1) * 100);
      const secs = Math.round(p.dur / 1000 - p.baseline);
      if (p.dev > 1 + WIDE) verdict = `<div class="tl-q q-bad"><b>+${pct}%</b> slower than usual (${secs > 0 ? "+" : ""}${secs}s)</div>`;
      else if (p.dev > 1 + NORMAL) verdict = `<div class="tl-q q-mid"><b>+${pct}%</b> mildly slow</div>`;
      else if (p.dev < 1 - NORMAL) verdict = `<div class="tl-q q-mid"><b>${pct}%</b> shorter than usual</div>`;
      else verdict = `<div class="tl-q q-good"><b>normal</b> (${pct >= 0 ? "+" : ""}${pct}%)</div>`;
    }
    return `
      <div class="tl-card-head">
        <b>${escTip(prog)} · job ${p.job ?? "—"}${grp ? " / " + grp.count : ""}${p.partial ? " (partial)" : ""}</b>
        <div class="tl-tip-row">part in program group${pinned ? " · pinned" : ""}</div>
      </div>
      <div class="tl-card-sec">
        <div class="tl-kv"><span>started</span><span>${clockS(p.t0)}</span></div>
        <div class="tl-kv"><span>ended</span><span>${clockS(p.t1)}</span></div>
        <div class="tl-kv"><span>duration</span><span>${dur(p.dur)}</span></div>
        ${p.baseline ? `<div class="tl-kv"><span>usual</span><span>${dur(p.baseline * 1000)} <span class="tl-tip-dim">n=${p.baselineN}</span></span></div>` : (p.partial ? "" : `<div class="tl-tip-dim">no baseline yet</div>`)}
      </div>
      ${verdict ? `<div class="tl-card-sec"><div class="tl-sec-h">cycle-time quality</div>${verdict}</div>` : ""}
      ${incidentsHtml(id, p.t0, p.t1, { compact: true })}`;
  }

  // position the tip card near the cursor, never spilling off the viewport AND
  // never covering the sticky top nav. Horizontal: prefer right of the cursor,
  // flip left if it would overflow. Vertical: center on the cursor, but clamp
  // the top to just below the nav bar (so the popup sits BEHIND/below the nav,
  // never over it) and the bottom to the viewport.
  function placeTip(clientX, clientY) {
    const wrap = body.querySelector(".tl-wrap");
    const wrapRect = wrap.getBoundingClientRect();
    const card = refs.tip.getBoundingClientRect();
    const cardW = card.width || 300;
    const cardH = card.height || 240;
    const GAP = 14, MARGIN = 10;
    const vw = window.innerWidth, vh = window.innerHeight;

    // top boundary = bottom of the sticky nav bar (+ small gap), so the card
    // can never overlap the navigation.
    const nav = document.querySelector(".godnav");
    const topBound = (nav ? nav.getBoundingClientRect().bottom : 0) + 6;

    // horizontal: right of cursor, flip left on overflow, clamp
    let vx = clientX + GAP;
    if (vx + cardW > vw - MARGIN) vx = clientX - cardW - GAP;
    if (vx < MARGIN) vx = MARGIN;

    // vertical: center on cursor, then clamp between the nav bottom and viewport
    let vy = clientY - cardH / 2;
    const maxY = vh - cardH - MARGIN;
    if (vy > maxY) vy = maxY;
    if (vy < topBound) vy = topBound;

    refs.tip.style.left = `${vx - wrapRect.left}px`;
    refs.tip.style.top = `${vy - wrapRect.top}px`;
  }

  function onHover(e, id) {
    if (ctx.dragging) return;          // panning: no hovercard
    if (ctx.pinned) return;            // a job card is pinned — don't fight it
    const lane = ctx.lanes.get(id); if (!lane) return;
    const rect = lane.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let html = null;

    // top strip → program-group detail
    if (my <= 28 && lane.grects) {
      const gh = lane.grects.find((r) => mx >= r.x0 && mx <= r.x1 && my >= r.y0 - 4 && my <= r.y1 + 4);
      if (gh) html = buildGroupCard(lane, id, gh.grp);
    }

    // part row → job preview (hover) — click pins it (see attachPan/onClick)
    if (!html) {
      const hit = (lane.rects || []).find((r) => mx >= r.x0 && mx <= r.x1);
      if (!hit) { refs.tip.hidden = true; return; }
      if (hit.live) {
        const c = hit.m.cycle || {};
        const last = Number(c.last_cycle);
        const prog = hit.m.active_program ? String(hit.m.active_program).replace(/\.nc$/i, "") : "—";
        html = `<div class="tl-card-head"><b>Live part — in progress</b><div class="tl-tip-row">${escTip(prog)}</div></div>
          <div class="tl-card-sec">
            <div class="tl-kv"><span>started</span><span>${clockS(Date.now() - Number(c.this_cycle) * 1000)}</span></div>
            <div class="tl-kv"><span>elapsed</span><span>${dur(Number(c.this_cycle) * 1000)}</span></div>
            ${Number.isFinite(c.remaining_cycle_time) ? `<div class="tl-kv"><span>remaining</span><span>${dur(Number(c.remaining_cycle_time) * 1000)}</span></div>` : ""}
            ${Number.isFinite(last) && last > 0 ? `<div class="tl-kv"><span>last cycle</span><span>${dur(last * 1000)}</span></div>` : ""}
          </div>`;
      } else {
        html = buildJobCard(lane, id, hit.p, false);
      }
    }

    refs.tip.className = "tl-tip tl-card";
    refs.tip.innerHTML = html;
    refs.tip.hidden = false;
    placeTip(e.clientX, e.clientY);
  }

  // click → pin the card under the cursor (program band OR job). Click empty
  // track or the × closes it. Pinned cards stay put so you can read / mouse to
  // them — the fix for "cannot pin" + cards hiding off the bottom of the page.
  function onClick(e, id) {
    if (ctx.dragging) return;
    const lane = ctx.lanes.get(id); if (!lane) return;
    const rect = lane.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;

    // program-band click → pin the group card
    if (my <= 28 && lane.grects) {
      const gh = lane.grects.find((r) => mx >= r.x0 && mx <= r.x1 && my >= r.y0 - 4 && my <= r.y1 + 4);
      if (gh) {
        ctx.pinned = { id, kind: "group", grp: gh.grp };
        renderPinned(buildGroupCard(lane, id, gh.grp), e);
        return;
      }
    }
    // part-row click → pin the job card
    const hit = (lane.rects || []).find((r) => mx >= r.x0 && mx <= r.x1 && !r.live);
    if (!hit) { unpin(); return; }
    ctx.pinned = { id, kind: "job", p: hit.p };
    renderPinned(buildJobCard(lane, id, hit.p, true), e);
  }
  // shared pinned-card render: adds the × close button + wires it
  function renderPinned(innerHtml, e) {
    refs.tip.className = "tl-tip tl-card is-pinned";
    refs.tip.innerHTML = `<button class="tl-card-x" data-f="cardX" title="close">×</button>` + innerHtml;
    refs.tip.hidden = false;
    placeTip(e.clientX, e.clientY);
    const x = refs.tip.querySelector('[data-f="cardX"]');
    if (x) x.addEventListener("click", (ev) => { ev.stopPropagation(); unpin(); });
  }
  function unpin() {
    if (!ctx.pinned) return;
    ctx.pinned = null;
    refs.tip.hidden = true;
    refs.tip.className = "tl-tip tl-card";
  }

  // resize handling + animation for the live pulse
  const onResize = () => { resize(); repaint(); };
  window.addEventListener("resize", onResize);
  // The only thing moving between data ticks is the live-edge pulse, so a full
  // 60 fps repaint of every lane is wasteful. Throttle the pulse repaint to
  // ~8 fps — visually smooth for a breathing highlight, ~7x less canvas work.
  const PULSE_MS = 120;
  let lastPulse = 0;
  function animate(now) {
    ctx.raf = requestAnimationFrame(animate);
    if (!refs.grid.offsetParent || !ctx.live) return;
    if (now - lastPulse < PULSE_MS) return;
    lastPulse = now;
    repaint();
  }

  // Paint the device-persisted snapshot immediately (no network). Builds the
  // machine lanes + their parts/groups from localStorage and seeds the in-memory
  // caches, so a cold reload shows the last board in <50ms instead of a 5s wait.
  // loadRange() then runs and silently replaces this with fresh data.
  function hydrateFromSnapshot() {
    const snap = loadSnapshot();
    if (!snap) return;
    try {
      ctx.machines = snap.machines.map((m) => ({ id: m.id, name: m.name }));
      // restore window anchor only if it was a non-live (frozen) view
      let vidx = 0;
      for (const m of snap.machines) {
        const data = snap.data && snap.data[m.id];
        // pre-bands snapshots have no `bands` — default to [] (today's behavior)
        if (data) {
          if (!Array.isArray(data.bands)) data.bands = [];
          ctx.dataCache.set(m.id, data);
        }
        if (isVisible(m.id)) {
          const lane = ensureLane(m.id, m.name, vidx++);
          lane.nameEl.textContent = m.name;
          if (data) { lane.parts = data.parts || []; lane.groups = data.groups || []; lane.bands = data.bands || []; lane.truncated = data.truncated; }
        }
      }
      if (snap.events) {
        const evMap = new Map();
        for (const [mid, arr] of Object.entries(snap.events)) evMap.set(mid, arr);
        ctx.events = evMap;
      }
      if (snap.cover && snap.cover.from && snap.cover.to) {
        ctx.cover = { from: snap.cover.from, to: snap.cover.to, has: true };
        ctx.buf = { from: snap.cover.from, to: snap.cover.to, loaded: true };
      }
      buildFilterMenu();
      paintWinLabel();
      syncRangeBtns();
      resize();
      repaint();
      refs.note.hidden = true;
    } catch (_) { /* corrupt snapshot — ignore, loadRange will populate */ }
  }

  // Persist the current board to the device. Called after every fresh bulk fetch
  // so the next cold reload has something instant to paint. We store only the
  // visible-window-relevant fields (compact) and cap total size in saveSnapshot.
  function persistSnapshot() {
    try {
      const data = {};
      for (const { id } of ctx.machines) {
        const d = ctx.dataCache.get(id);
        if (d) data[id] = { parts: d.parts, groups: d.groups, bands: d.bands || [], truncated: d.truncated };
      }
      const events = {};
      if (ctx.events) for (const [mid, arr] of ctx.events) events[mid] = arr;
      saveSnapshot({
        savedAt: Date.now(),
        rangeKey: ctx.rangeKey,
        cover: ctx.cover.has ? { from: ctx.cover.from, to: ctx.cover.to } : null,
        machines: ctx.machines.map((m) => ({ id: m.id, name: m.name })),
        data, events,
      });
    } catch (_) { /* non-fatal */ }
  }

  // boot — hydrate from the device snapshot FIRST so a cold reload paints the
  // last-known board instantly, then loadRange refreshes it from the network.
  hydrateFromSnapshot();
  loadRange(true).then(() => { resize(); repaint(); });
  ctx.liveTimer = setInterval(liveTick, 1000);
  ctx.raf = requestAnimationFrame(animate);

  // repaint canvases when the global theme toggles (canvas can't read CSS vars)
  const onTheme = () => { if (refs.grid && refs.grid.offsetParent) repaint(); };
  window.addEventListener("vmc-theme", onTheme);

  // ---- wall-board bridge (tv.js) ----
  // The wall timeline step is a presentation, not the operator's timeline: it
  // pins Hour + live and follows the wall fleet. Everything here is ephemeral
  // ctx state — NOTHING writes localStorage — so the wall cannot clobber the
  // dashboard's own range/filter on a shared origin. tv.js calls present() on
  // every timeline step and release() when leaving it, which re-seeds from
  // storage and repaints.
  function setRangeSilent(key) {
    if (!RANGE_MS[key]) return;
    ctx.rangeKey = key;
    ctx.spanMs = RANGE_MS[key];
    syncRangeBtns();
    if (ctx.pinned) unpin();
    ctx.live = false;
    ctx.anchor = Date.now() + RANGE_MS[key] * 0.5;
    ctx.buf.loaded = false;
    ctx.cover.has = false;
    loadRange(true);
  }
  window.__VMC_TIMELINE__ = {
    present(visibleIds) {
      setRangeSilent("hour");
      ctx.live = true; paintWinLabel(); repaint(); ensureBuffer();
      if (Array.isArray(visibleIds)) {
        ctx.wallOrder = visibleIds.slice();
        const all = ctx.machines.map((m) => m.id);
        const coversAll = all.length > 0 && visibleIds.length === all.length &&
          all.every((id) => visibleIds.indexOf(id) !== -1);
        ctx.sel = coversAll ? null : new Set(visibleIds);
        buildFilterMenu();
        applyFilter();
      }
    },
    release() {
      ctx.wallOrder = null;
      ctx.sel = loadSel();
      const r = localStorage.getItem(LS_RANGE);
      if (r && RANGE_MS[r]) setRangeSilent(r);
      buildFilterMenu();
      applyFilter();
    },
  };

  return {
    // router calls refresh() every 15s while active. We refresh the machine
    // list + buffer, but never while the user is mid-drag, and ensureBuffer
    // keeps the fetch seamless (only reloads if stale or near an edge).
    refresh() {
      if (!refs.grid.offsetParent || ctx.dragging) return;
      loadRange(ctx.live);   // when live, keep the right edge fresh; else seamless
    },
    destroy() {
      if (ctx.liveTimer) clearInterval(ctx.liveTimer);
      if (ctx.raf) cancelAnimationFrame(ctx.raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("vmc-theme", onTheme);
      document.removeEventListener("click", onDocClick);
    },
  };
}

function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
