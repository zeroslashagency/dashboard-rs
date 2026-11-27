/* VMC Single-Port In-Page Fullscreen & TV Wall Board Controller.
 *
 * Features:
 *   - Proportion-locked Auto-Fit layout engine: renders every machine card at
 *     its authentic natural dashboard width (430px) with aligned row heights,
 *     then uniformly scales the grid (`transform: scale()`) to fill any screen
 *     without stretching or distorting the card structure.
 *   - Minimalist auto-hiding floating dock (reveals on pointer move / touch / S)
 *     paired with a calm 4-tab popover (View, Fleet, Cards, Clock).
 *   - Zero-reload in-page enter/exit on single port 3000.
 */
(function () {
  "use strict";

  var cfg = window.__VMC_TV_CFG__ || {};
  var VIEW_ATTR = "data-tv-view";
  var LEGACY_LS_KEY = "vmc_tv_interval";

  var CARD_REF_W = 430;
  var GRID_GAP = 14;
  var STAGE_FILL = 0.985;
  var DOCK_IDLE_MS = 3500;

  var ROTATION_VIEWS = [
    { id: "cards", label: "Cards" },
    { id: "timeline", label: "Timeline" },
    { id: "kpi", label: "KPI" },
    { id: "analytics", label: "Analytics" },
    { id: "fleet", label: "Fleet" },
  ];

  var DWELL_PRESETS = [
    { ms: 0, label: "Off" },
    { ms: 10000, label: "10s" },
    { ms: 15000, label: "15s" },
    { ms: 20000, label: "20s" },
    { ms: 30000, label: "30s" },
    { ms: 60000, label: "60s" },
  ];

  var PRESET_ZONES = [
    { tz: "local", label: "Local browser", short: "LOC" },
    { tz: "Asia/Bangkok", label: "Asia / Bangkok (BKK)", short: "BKK" },
    { tz: "Asia/Kolkata", label: "Asia / Kolkata (IST)", short: "IST" },
    { tz: "UTC", label: "UTC", short: "UTC" },
    { tz: "America/Los_Angeles", label: "US Pacific (LAX)", short: "LAX" },
    { tz: "America/New_York", label: "US Eastern (NYC)", short: "NYC" },
    { tz: "Europe/Berlin", label: "Europe / Berlin (BER)", short: "BER" },
  ];

  // ------------------------------------------------------------------- state

  var active = false;
  var prevTabId = "dashboard";
  var domBuilt = false;
  var layoutTimer = null;
  var fitRaf = 0;

  var fleetOrder = [];
  var fleetFresh = Object.create(null);
  var serverSkewMs = 0;
  var sawServerTime = false;

  var clockEl = null;
  var clockTimer = null;
  var fmtMain = null;
  var fmtShift = null;

  var cardPage = 0;
  var COMPACT_PER_PAGE = 6;
  var layoutCompact = null;
  var lastMeasuredCardH = 660;
  var lastFit = { cols: 3, rows: 1, perPage: 3, scale: 1 };

  var steps = [];
  var stepIdx = 0;
  var stepTimer = null;
  var paused = false;
  var view = "cards";
  var wasTimeline = false;

  var panelScope = "global";
  var activeTab = "view";
  var panelSyncFn = null;

  var dockVisible = false;
  var dockHovered = false;
  var dockTimer = null;
  var lastPointerBump = 0;

  var TVCLS_SHARED = {
    sec: "tv-cards-sec",
    title: "tv-cards-sec-title",
    row: "tv-row",
    hint: "tv-note",
    btn: "tv-btn",
    btns: "",
  };

  // ---------------------------------------------------------------- utilities

  function parseSeconds(val) {
    if (val === null || val === undefined || val === "") return null;
    var s = String(val).trim().toLowerCase();
    if (s === "off" || s === "0") return 0;
    var n = Number(s);
    if (!isFinite(n) || n <= 0) return null;
    return n < 1000 ? n * 1000 : n;
  }

  function fmtDwell(ms) {
    if (!ms) return "Off";
    return Math.round(ms / 1000) + "s";
  }

  function tzShortFor(tz) {
    for (var i = 0; i < PRESET_ZONES.length; i++) {
      if (PRESET_ZONES[i].tz === tz) return PRESET_ZONES[i].short;
    }
    var util = window.__VMC_TV_CFG_UTIL__;
    if (util && util.zoneAbbrev) return util.zoneAbbrev(tz);
    return String(tz).split("/").pop().slice(0, 3).toUpperCase();
  }

  function readFresh(m) {
    try {
      if (typeof readFreshness === "function") {
        var r = readFreshness(m);
        if (r && r.tier) return String(r.tier).toLowerCase();
      }
    } catch (_) {}
    var raw = m && typeof m.freshness === "string" ? m.freshness.toLowerCase() : "";
    return raw || "unknown";
  }

  function dashSettings() {
    return window.__VMC_DASH_SETTINGS__ || null;
  }

  function isAutoFit() {
    return cfg.autoFit !== false;
  }

  function isCompact() {
    return document.documentElement.getAttribute("data-summary") === "off";
  }

  // ------------------------------------------------------------------- clock

  function makeFormatter(tz) {
    try {
      var opts = {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      };
      if (tz && tz !== "local") opts.timeZone = tz;
      return new Intl.DateTimeFormat("en-GB", opts);
    } catch (_) {
      return null;
    }
  }

  function destroyClock() {
    if (clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
    if (clockEl && clockEl.parentNode) {
      clockEl.parentNode.removeChild(clockEl);
    }
    clockEl = null;
    fmtMain = null;
    fmtShift = null;
  }

  function buildClock() {
    destroyClock();
    if (!active || !cfg.showClock) return;

    fmtMain = makeFormatter(cfg.tz);
    if (!fmtMain) return;
    if (cfg.showShiftClock) fmtShift = makeFormatter(cfg.shiftTz);

    var host = document.querySelector(".topbar-right");
    if (!host) return;

    clockEl = document.createElement("div");
    clockEl.className = "tv-clock";
    clockEl.id = "tvClock";
    host.appendChild(clockEl);

    tickClock();
    clockTimer = setInterval(tickClock, 1000);
  }

  function tickClock() {
    if (!clockEl || !fmtMain) return;
    var now = new Date(Date.now() + serverSkewMs);
    var main = fmtMain.format(now);
    var zoneLbl = cfg.tz === "local" ? "LOCAL" : (cfg.tzLabel || tzShortFor(cfg.tz));

    var html =
      '<span class="tv-clock-time">' + main + "</span>" +
      '<span class="tv-clock-zone">' + zoneLbl + "</span>";

    if (fmtShift) {
      html +=
        '<span class="tv-clock-sep"></span>' +
        '<span class="tv-clock-time tv-clock-time-alt">' + fmtShift.format(now) + "</span>" +
        '<span class="tv-clock-zone">' + (cfg.shiftTzLabel || "IST") + "</span>";
    }

    if (!fmtShift && cfg.tz !== cfg.shiftTz) {
      html += '<span class="tv-clock-note">shifts · ' + (cfg.shiftTzLabel || "IST") + "</span>";
    }

    clockEl.classList.toggle("is-unsynced", !sawServerTime);
    clockEl.innerHTML = html;
  }

  // ------------------------------------------------ proportion-locked autofit

  function stageSize() {
    var mainEl = document.querySelector("main");
    var w = (mainEl && mainEl.clientWidth) || (window.innerWidth - 24);
    var h = (mainEl && mainEl.clientHeight) || (window.innerHeight - 62);
    return {
      w: Math.max(320, w),
      h: Math.max(240, h),
    };
  }

  function measureNaturalCardHeight(grid) {
    if (!grid) return isCompact() ? 340 : 660;
    var cards = grid.querySelectorAll(".machine-card[data-machine]:not([hidden])");
    var maxH = 0;

    Array.prototype.forEach.call(cards, function (card) {
      var eye = card.querySelector(".machine-card-eyebrow");
      var inner = card.querySelector(".machine-card-inner");
      var h = 0;
      if (inner) {
        // Measure intrinsic content height without height:100% stretch feedback
        var eyeH = eye ? eye.offsetHeight : 30;
        var innerH = 0;
        for (var i = 0; i < inner.children.length; i++) {
          var ch = inner.children[i];
          if (ch.hidden) continue;
          var cs = window.getComputedStyle ? window.getComputedStyle(ch) : null;
          if (cs && cs.display === "none") continue;
          innerH += ch.offsetHeight;
        }
        // Account for inner gaps + shell padding (~26px)
        h = eyeH + innerH + 28;
      }
      if (!h) h = card.offsetHeight;
      if (h > maxH) maxH = h;
    });

    if (maxH > 180) {
      lastMeasuredCardH = maxH;
      return maxH;
    }
    return isCompact() ? Math.min(lastMeasuredCardH, 380) : Math.max(lastMeasuredCardH, 600);
  }

  function pickAutoFitGrid(fleetCount, availW, availH, estCardH) {
    if (fleetCount <= 0) return { cols: 1, rows: 1, perPage: 1 };

    // Compact mode (summary off): aim for crisp 6-card 3x2 or 2x3 portrait
    if (isCompact()) {
      var cCols = availW >= availH ? Math.min(3, fleetCount) : Math.min(2, fleetCount);
      var cRows = Math.min(availW >= availH ? 2 : 3, Math.ceil(fleetCount / cCols));
      return { cols: cCols, rows: cRows, perPage: Math.min(COMPACT_PER_PAGE, cCols * cRows) };
    }

    var best = null;
    var maxCols = Math.min(fleetCount, 6);
    var maxRows = Math.min(3, fleetCount);

    for (var rows = 1; rows <= maxRows; rows++) {
      for (var cols = 1; cols <= maxCols; cols++) {
        var cap = cols * rows;
        // Skip awkward over-allocated grids with more than 1 blank slot
        if (rows > 1 && cap > fleetCount + 1) continue;
        if (rows > 1 && cols * (rows - 1) >= fleetCount) continue;

        var candW = cols * CARD_REF_W + (cols - 1) * GRID_GAP;
        var candH = rows * estCardH + (rows - 1) * GRID_GAP;
        var scale = Math.min(availW / candW, availH / candH) * STAGE_FILL;

        // Avoid tiny illegible cards unless 1x1 fallback
        if (scale < 0.56 && !(cols === 1 && rows === 1)) continue;

        var areaFill = (candW * scale * candH * scale) / (availW * availH);
        var score = areaFill;

        // Prefer single-page fleet display when cards remain well-sized
        if (cap >= fleetCount && scale >= 0.84) score += 0.08;
        // Slightly prefer clean single-row bands when fill is close
        if (rows === 1) score += 0.025;
        // Penalize empty trailing holes on single-page multi-row grids
        if (cap > fleetCount) score -= 0.07 * (cap - fleetCount);
        // Avoid comically zoomed single card when multiple cards fit naturally
        if (scale > 1.75) score -= (scale - 1.75) * 0.28;

        if (!best || score > best.score) {
          best = { cols: cols, rows: rows, perPage: Math.min(fleetCount, cap), score: score };
        }
      }
    }

    return best || { cols: 1, rows: 1, perPage: 1 };
  }

  function pickCustomCols(count, availW, availH, estCardH) {
    if (count <= 1) return 1;
    if (isCompact()) return availW >= availH ? Math.min(3, count) : Math.min(2, count);

    var bestCols = count;
    var bestScore = -1;
    for (var cols = 1; cols <= count; cols++) {
      var rows = Math.ceil(count / cols);
      if (rows > 3) continue;
      var candW = cols * CARD_REF_W + (cols - 1) * GRID_GAP;
      var candH = rows * estCardH + (rows - 1) * GRID_GAP;
      var scale = Math.min(availW / candW, availH / candH) * STAGE_FILL;
      var areaFill = (candW * scale * candH * scale) / (availW * availH);
      var emptySlots = cols * rows - count;
      var score = areaFill - emptySlots * 0.05 + (rows === 1 ? 0.02 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestCols = cols;
      }
    }
    return bestCols;
  }

  function applyStageScale() {
    if (!active) return;
    var grid = document.getElementById("machineGrid");
    if (!grid || view !== "cards") return;

    var stage = stageSize();
    var natW = grid.offsetWidth;
    var natH = grid.offsetHeight;
    if (!natW || !natH) return;

    var manualZoom = !isAutoFit() ? Number(cfg.zoom) : 0;
    var scale;
    if (isFinite(manualZoom) && manualZoom > 0) {
      scale = manualZoom;
    } else {
      scale = Math.min(stage.w / natW, stage.h / natH) * STAGE_FILL;
      scale = Math.max(0.35, Math.min(2.2, scale));
    }

    grid.style.setProperty("--tv-card-w", CARD_REF_W + "px");
    grid.style.setProperty("--tv-scale", scale.toFixed(4));
    lastFit.scale = scale;

    updateDockIndicators();
    updateFitSummary();
  }

  function scheduleFitRefine() {
    if (fitRaf) cancelAnimationFrame(fitRaf);
    fitRaf = requestAnimationFrame(function () {
      fitRaf = 0;
      if (!active || view !== "cards") return;
      var grid = document.getElementById("machineGrid");
      var beforeH = lastMeasuredCardH;
      var measured = measureNaturalCardHeight(grid);
      if (Math.abs(measured - beforeH) > 28 && isAutoFit()) {
        applyFleetLayout(true);
      } else {
        applyStageScale();
      }
    });
  }

  // ------------------------------------------------------------ fleet control

  function orderedFleet() {
    var wanted = [];
    var seen = Object.create(null);

    (cfg.machines || []).forEach(function (id) {
      if (fleetOrder.indexOf(id) !== -1 && !seen[id]) {
        seen[id] = true;
        wanted.push(id);
      }
    });

    fleetOrder.forEach(function (id) {
      if (!seen[id]) {
        seen[id] = true;
        wanted.push(id);
      }
    });

    return wanted.filter(function (id) {
      if ((cfg.exclude || []).indexOf(id) !== -1) return false;
      if (cfg.skipDead && fleetFresh[id] === "dead") return false;
      return true;
    });
  }

  function skippedFleet() {
    if (!cfg.skipDead) return [];
    return fleetOrder.filter(function (id) {
      return (cfg.exclude || []).indexOf(id) === -1 && fleetFresh[id] === "dead";
    });
  }

  function perPageFor(n) {
    if (n <= 0) return 1;
    if (isAutoFit()) {
      var stage = stageSize();
      var grid = document.getElementById("machineGrid");
      var estH = measureNaturalCardHeight(grid);
      var fit = pickAutoFitGrid(n, stage.w, stage.h, estH);
      return fit.perPage;
    }
    if (isCompact()) return COMPACT_PER_PAGE;
    return cfg.perPage > 0 ? cfg.perPage : n;
  }

  function pageCount() {
    var n = orderedFleet().length;
    var per = perPageFor(n);
    if (!per) return 1;
    return Math.max(1, Math.ceil(n / per));
  }

  function applyFleetLayout(skipRefine) {
    if (!active) return;
    var grid = document.getElementById("machineGrid");
    if (!grid) return;

    var compact = isCompact();
    layoutCompact = compact;
    document.documentElement.toggleAttribute("data-tv-compact", compact);

    var visible = orderedFleet();
    var stage = stageSize();
    var estH = measureNaturalCardHeight(grid);

    var fitSpec;
    if (isAutoFit()) {
      fitSpec = pickAutoFitGrid(visible.length, stage.w, stage.h, estH);
    } else {
      var customPer = compact ? COMPACT_PER_PAGE : (cfg.perPage > 0 ? cfg.perPage : Math.max(1, visible.length));
      fitSpec = { perPage: customPer, cols: 1, rows: 1 };
    }

    var per = fitSpec.perPage || visible.length || 1;
    var pages = Math.max(1, Math.ceil(visible.length / per));
    if (cardPage >= pages) cardPage = 0;

    var start = cardPage * per;
    var onThisPage = visible.slice(start, start + per);

    var cards = grid.querySelectorAll(".machine-card[data-machine]");
    Array.prototype.forEach.call(cards, function (card) {
      var id = (card.dataset.machine || "").toUpperCase();
      var idx = onThisPage.indexOf(id);
      if (idx === -1) {
        card.hidden = true;
        card.style.order = "";
      } else {
        card.hidden = false;
        card.style.order = String(idx);
      }
    });

    var cols;
    if (isAutoFit()) {
      cols = Math.min(fitSpec.cols, Math.max(1, onThisPage.length));
    } else {
      cols = pickCustomCols(Math.max(1, onThisPage.length), stage.w, stage.h, estH);
    }
    var rows = Math.max(1, Math.ceil(Math.max(1, onThisPage.length) / cols));

    lastFit.cols = cols;
    lastFit.rows = rows;
    lastFit.perPage = per;

    grid.style.setProperty("--tv-cols", String(cols));
    grid.style.setProperty("--tv-rows", String(rows));
    grid.style.setProperty("--tv-card-w", CARD_REF_W + "px");

    document.documentElement.setAttribute("data-tv-page", String(cardPage + 1));
    document.documentElement.setAttribute("data-tv-pages", String(pages));

    applyStageScale();
    if (!skipRefine) scheduleFitRefine();

    renderSkipStrip();
    renderPager(pages);
  }

  function restoreFleetLayout() {
    var grid = document.getElementById("machineGrid");
    if (grid) {
      grid.style.removeProperty("--tv-cols");
      grid.style.removeProperty("--tv-rows");
      grid.style.removeProperty("--tv-card-w");
      grid.style.removeProperty("--tv-scale");
      var cards = grid.querySelectorAll(".machine-card[data-machine]");
      Array.prototype.forEach.call(cards, function (card) {
        card.hidden = false;
        card.style.order = "";
      });
    }
    var strip = document.getElementById("tvSkipStrip");
    if (strip) strip.hidden = true;
    var pager = document.getElementById("tvPager");
    if (pager) pager.hidden = true;
  }

  function renderSkipStrip() {
    var skipped = skippedFleet();
    var strip = document.getElementById("tvSkipStrip");
    if (!active || !skipped.length) {
      if (strip) strip.hidden = true;
      return;
    }
    if (!strip) {
      strip = document.createElement("div");
      strip.id = "tvSkipStrip";
      strip.className = "tv-skip-strip";
      document.body.appendChild(strip);
    }
    strip.hidden = false;
    strip.textContent = "NO DATA: " + skipped.join(", ");
  }

  function renderPager(pages) {
    var pager = document.getElementById("tvPager");
    if (!active || pages <= 1 || view !== "cards") {
      if (pager) pager.hidden = true;
      return;
    }
    if (!pager) {
      pager = document.createElement("div");
      pager.id = "tvPager";
      pager.className = "tv-pager";
      document.body.appendChild(pager);
    }
    pager.hidden = false;
    var dots = "";
    for (var i = 0; i < pages; i++) {
      dots += '<span class="tv-pager-dot' + (i === cardPage ? " is-on" : "") + '"></span>';
    }
    pager.innerHTML = dots;
  }

  // ------------------------------------------------------------------ playlist

  function normalizeViewId(id) {
    if (id === "maintenance" || id === "statistics") return "fleet";
    return id;
  }

  function isKnownView(id) {
    var norm = normalizeViewId(id);
    for (var i = 0; i < ROTATION_VIEWS.length; i++) {
      if (ROTATION_VIEWS[i].id === norm) return true;
    }
    return false;
  }

  function activePlaylistViews() {
    var list = [];
    (cfg.playlist || []).forEach(function (step) {
      var v = step && step.view ? normalizeViewId(step.view) : null;
      if (v && isKnownView(v) && list.indexOf(v) === -1) list.push(v);
    });
    return list.length ? list : ["cards"];
  }

  function buildSteps() {
    var out = [];
    var seenNonCard = Object.create(null);
    var fallbackDwell = parseSeconds(cfg.interval);
    if (fallbackDwell === null) fallbackDwell = 20000;

    (cfg.playlist || []).forEach(function (spec) {
      var v = spec && spec.view ? normalizeViewId(spec.view) : null;
      if (!v || !isKnownView(v)) return;
      var dwell = parseSeconds(spec.dwell);
      if (dwell === null) dwell = fallbackDwell;

      if (v === "cards") {
        var pages = pageCount();
        for (var p = 0; p < pages; p++) {
          out.push({ view: "cards", page: p, dwell: dwell });
        }
      } else if (!seenNonCard[v]) {
        seenNonCard[v] = true;
        out.push({ view: v, dwell: dwell });
      }
    });

    if (!out.length) out.push({ view: "cards", page: 0, dwell: fallbackDwell });
    return out;
  }

  function applyView(v) {
    view = v;
    document.documentElement.setAttribute(VIEW_ATTR, v);
    try { document.body.setAttribute(VIEW_ATTR, v); } catch (_) {}

    try {
      var targetTab = v === "cards" ? "dashboard" : v;
      var btn = document.querySelector('.godnav-tab[data-tab="' + targetTab + '"]');
      if (btn && !btn.classList.contains("is-active")) {
        btn.click();
      } else if (!btn) {
        setTimeout(function () {
          if (!active) return;
          var late = document.querySelector('.godnav-tab[data-tab="' + targetTab + '"]');
          if (late && !late.classList.contains("is-active")) late.click();
          if (v === "timeline") presentTimeline();
        }, 400);
      }
    } catch (_) {}
  }

  function presentTimeline() {
    var t = window.__VMC_TIMELINE__;
    if (t && t.present) {
      try { t.present(orderedFleet()); } catch (_) {}
    }
  }

  function releaseTimeline() {
    var t = window.__VMC_TIMELINE__;
    if (t && t.release) {
      try { t.release(); } catch (_) {}
    }
  }

  function runStep(i) {
    if (!active || !steps.length) return;
    stepIdx = ((i % steps.length) + steps.length) % steps.length;
    var step = steps[stepIdx];
    var isTimeline = step.view === "timeline";

    if (step.view === "cards") {
      cardPage = step.page || 0;
      applyView("cards");
      applyFleetLayout(false);
    } else {
      applyView(step.view);
      renderPager(0);
    }

    if (isTimeline) presentTimeline();
    else if (wasTimeline) releaseTimeline();
    wasTimeline = isTimeline;

    updateStatus();
    updateDockIndicators();

    if (stepTimer) { clearTimeout(stepTimer); stepTimer = null; }
    if (paused || !step.dwell || steps.length <= 1) return;

    stepTimer = setTimeout(function () { runStep(stepIdx + 1); }, step.dwell);
  }

  function rebuildAndRun(keepIndex) {
    steps = buildSteps();
    if (!active) return;
    runStep(keepIndex ? stepIdx : 0);
  }

  function setPaused(next) {
    paused = !!next;
    document.documentElement.toggleAttribute("data-tv-paused", paused);
    updateDockIndicators();
    if (paused) {
      if (stepTimer) { clearTimeout(stepTimer); stepTimer = null; }
    } else if (active) {
      runStep(stepIdx);
    }
    updateStatus();
  }

  // ------------------------------------------------------------ overview feed

  function onOverview(ev) {
    var data = ev && ev.detail;
    if (!data) return;

    if (Array.isArray(data.machines)) {
      var order = [];
      data.machines.forEach(function (m) {
        if (!m || !m.machine_id) return;
        var id = String(m.machine_id).toUpperCase();
        order.push(id);
        fleetFresh[id] = readFresh(m);
      });

      var changed = order.length !== fleetOrder.length ||
        order.some(function (id, i) { return fleetOrder[i] !== id; });
      fleetOrder = order;

      if (changed && active) {
        var before = steps.length;
        steps = buildSteps();
        if (steps.length !== before) stepIdx = Math.min(stepIdx, steps.length - 1);
      }
    }

    var stamp = Number(data.data_updated_at_ms || data.updated_at_ms || 0);
    if (isFinite(stamp) && stamp > 0) {
      serverSkewMs = stamp - Date.now();
      sawServerTime = true;
    }

    if (active && view === "cards") applyFleetLayout(true);
  }

  // ------------------------------------------------------------------- status

  function updateStatus() {
    var el = document.getElementById("tvStatus");
    if (!el) return;
    var step = steps[stepIdx];
    if (paused) {
      el.textContent = "Paused";
      return;
    }
    var viewObj = null;
    for (var i = 0; i < ROTATION_VIEWS.length; i++) {
      if (step && ROTATION_VIEWS[i].id === step.view) { viewObj = ROTATION_VIEWS[i]; break; }
    }
    var label = viewObj ? viewObj.label : "Cards";
    var pages = pageCount();
    if (step && step.view === "cards" && pages > 1) {
      label += " " + (cardPage + 1) + "/" + pages;
    }
    if (!step || !step.dwell || steps.length <= 1) {
      el.textContent = label + " · Hold";
      return;
    }
    el.textContent = label + " · " + fmtDwell(step.dwell);
  }

  function updateFitSummary() {
    var el = document.getElementById("tvFitSummary");
    if (!el) return;
    var pct = Math.round((lastFit.scale || 1) * 100);
    el.textContent = "Adapting to screen · " + lastFit.cols + "×" + lastFit.rows + " at " + pct + "%";
  }

  // --------------------------------------------------- auto-hiding float dock

  function updateDockIndicators() {
    var pauseBtn = document.getElementById("tvDockPause");
    if (pauseBtn) {
      pauseBtn.textContent = paused ? "▶" : "⏸";
      pauseBtn.title = paused ? "Resume rotation (Space)" : "Pause rotation (Space)";
      pauseBtn.classList.toggle("is-active", paused);
    }
    var autoBtn = document.getElementById("tvDockAuto");
    if (autoBtn) {
      var on = isAutoFit();
      autoBtn.classList.toggle("is-active", on);
      autoBtn.setAttribute("aria-pressed", on ? "true" : "false");
      autoBtn.textContent = on ? ("Auto · " + lastFit.cols + "×" + lastFit.rows) : "Auto";
    }
    var cfgBtn = document.getElementById("tvDockSettings");
    if (cfgBtn) {
      var open = panelOpen();
      cfgBtn.classList.toggle("is-active", open);
      cfgBtn.setAttribute("aria-expanded", open ? "true" : "false");
    }
    var fullBtn = document.getElementById("tvDockFull");
    if (fullBtn) {
      var isFs = !!document.fullscreenElement;
      fullBtn.classList.toggle("is-active", isFs);
      fullBtn.title = isFs ? "Exit browser full screen" : "Browser full screen";
    }
  }

  function scheduleDockHide() {
    if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; }
    if (!active || dockHovered || panelOpen()) return;
    dockTimer = setTimeout(function () {
      dockTimer = null;
      if (!active || dockHovered || panelOpen()) return;
      hideDock();
    }, DOCK_IDLE_MS);
  }

  function revealDock() {
    if (!active) return;
    dockVisible = true;
    document.documentElement.setAttribute("data-tv-dock", "1");
    scheduleDockHide();
  }

  function hideDock() {
    dockVisible = false;
    document.documentElement.removeAttribute("data-tv-dock");
    if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; }
  }

  function onPointerActivity() {
    if (!active) return;
    var now = Date.now();
    if (dockVisible && now - lastPointerBump < 400) return;
    lastPointerBump = now;
    revealDock();
  }

  function toggleAutoFitMode() {
    var next = !isAutoFit();
    cfg.autoFit = next;
    if (next) cfg.zoom = 0;
    saveTv(next ? { autoFit: true, zoom: 0 } : { autoFit: false });
    cardPage = 0;
    rebuildAndRun(false);
    if (panelSyncFn) panelSyncFn();
    updateDockIndicators();
  }

  function toggleBrowserFullscreen() {
    var el = document.documentElement;
    try {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else if (el.requestFullscreen) {
        var p = el.requestFullscreen();
        if (p && typeof p.catch === "function") p.catch(function () {});
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      }
    } catch (_) {}
  }

  function buildDock() {
    if (document.getElementById("tvDock")) return;
    var dock = document.createElement("div");
    dock.id = "tvDock";
    dock.className = "tv-dock";
    dock.setAttribute("role", "toolbar");
    dock.setAttribute("aria-label", "TV wall controls");

    dock.innerHTML = [
      '<button type="button" class="tv-dock-btn tv-dock-ico" id="tvDockPrev" title="Previous slide (←)">◀</button>',
      '<button type="button" class="tv-dock-btn tv-dock-ico" id="tvDockPause" title="Pause rotation (Space)">⏸</button>',
      '<button type="button" class="tv-dock-btn tv-dock-ico" id="tvDockNext" title="Next slide (→)">▶</button>',
      '<span class="tv-dock-sep" aria-hidden="true"></span>',
      '<button type="button" class="tv-dock-btn tv-dock-auto" id="tvDockAuto" title="Auto-adapt layout & scale to this screen (A)">Auto</button>',
      '<button type="button" class="tv-dock-btn" id="tvDockSettings" title="TV controls (S)">Controls</button>',
      '<span class="tv-dock-sep" aria-hidden="true"></span>',
      '<button type="button" class="tv-dock-btn tv-dock-ico" id="tvDockFull" title="Browser full screen">⛶</button>',
      '<button type="button" class="tv-dock-btn tv-dock-exit" id="tvDockExit" title="Exit TV mode (X)">✕ Exit</button>',
    ].join("");

    dock.addEventListener("pointerenter", function () {
      dockHovered = true;
      if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; }
    });
    dock.addEventListener("pointerleave", function () {
      dockHovered = false;
      scheduleDockHide();
    });

    dock.querySelector("#tvDockPrev").addEventListener("click", function () { runStep(stepIdx - 1); });
    dock.querySelector("#tvDockPause").addEventListener("click", function () { setPaused(!paused); });
    dock.querySelector("#tvDockNext").addEventListener("click", function () { runStep(stepIdx + 1); });
    dock.querySelector("#tvDockAuto").addEventListener("click", toggleAutoFitMode);
    dock.querySelector("#tvDockSettings").addEventListener("click", function () {
      if (panelOpen()) hidePanel(); else showPanel();
    });
    dock.querySelector("#tvDockFull").addEventListener("click", toggleBrowserFullscreen);
    dock.querySelector("#tvDockExit").addEventListener("click", exit);

    document.body.appendChild(dock);
  }

  // -------------------------------------------------- minimalist 4-tab popover

  function tvScopePatch() {
    return window.__VMC_TV_CFG_SCOPE__ ? window.__VMC_TV_CFG_SCOPE__(panelScope) : {};
  }

  function tvValue(key, fallback) {
    var patch = tvScopePatch();
    return Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] :
      (cfg[key] === undefined ? fallback : cfg[key]);
  }

  function setSaveNote(text, bad) {
    var note = document.getElementById("tvSaveNote");
    if (!note) return;
    note.textContent = text;
    note.classList.toggle("is-bad", !!bad);
  }

  function saveTv(patch) {
    var ok = window.__VMC_TV_CFG_SAVE__ ? window.__VMC_TV_CFG_SAVE__(patch, panelScope) : false;
    setSaveNote(
      ok
        ? (panelScope === "global" ? "Saved to Global" : "Saved for this display")
        : "Browser storage unavailable",
      !ok
    );
    return ok;
  }

  function buildPanel() {
    var wrap = document.getElementById("tvControls");
    if (!wrap) return;
    wrap.innerHTML = "";
    wrap.hidden = true;
    wrap.className = "tv-popover";

    var DS = window.__VMC_DASH_SECTIONS__ || null;
    var sharedCards = DS ? DS.html(TVCLS_SHARED, ["display", "cards"]) : "";

    var viewChipsHtml = ROTATION_VIEWS.map(function (v) {
      return '<button type="button" class="tv-chip" data-tv-view-toggle="' + v.id + '">' + v.label + "</button>";
    }).join("");

    var dwellChipsHtml = DWELL_PRESETS.map(function (d) {
      return '<button type="button" class="tv-seg-btn" data-tv-dwell="' + d.ms + '">' + d.label + "</button>";
    }).join("");

    var tzOptsHtml = PRESET_ZONES.map(function (z) {
      return '<option value="' + z.tz + '">' + z.label + "</option>";
    }).join("");

    wrap.innerHTML = [
      // Popover header with segmented 4-tab switcher
      '<div class="tv-pop-head">',
      '  <div class="tv-tabs" role="tablist">',
      '    <button type="button" class="tv-tab is-active" data-tv-tab="view" role="tab">View</button>',
      '    <button type="button" class="tv-tab" data-tv-tab="fleet" role="tab">Fleet</button>',
      '    <button type="button" class="tv-tab" data-tv-tab="cards" role="tab">Cards</button>',
      '    <button type="button" class="tv-tab" data-tv-tab="clock" role="tab">Clock</button>',
      "  </div>",
      '  <button type="button" class="tv-x" id="tvClose" title="Close (Esc)" aria-label="Close controls">✕</button>',
      "</div>",

      // Tab 1: View (Rotation + Adaptive Screen Fit)
      '<div class="tv-pane" data-tv-pane="view">',
      '  <div class="tv-group">',
      '    <div class="tv-group-head"><span>Screen fit</span><span class="tv-meta" id="tvStatus"></span></div>',
      '    <div class="tv-seg">',
      '      <button type="button" class="tv-seg-btn" data-tv-fit="auto">Auto</button>',
      '      <button type="button" class="tv-seg-btn" data-tv-fit="custom">Custom</button>',
      "    </div>",
      '    <div class="tv-fit-note" id="tvFitSummary"></div>',
      '    <div class="tv-custom-fit" id="tvCustomFit" hidden>',
      '      <div class="tv-row">',
      '        <label for="tvPerPage">Cards per page</label>',
      '        <select id="tvPerPage">',
      '          <option value="0">All</option><option value="1">1</option><option value="2">2</option>',
      '          <option value="3">3</option><option value="4">4</option><option value="6">6</option>',
      "        </select>",
      "      </div>",
      '      <div class="tv-row">',
      '        <label for="tvZoom">Scale</label>',
      '        <select id="tvZoom">',
      '          <option value="0">Fit</option><option value="1">100%</option><option value="1.25">125%</option>',
      '          <option value="1.5">150%</option><option value="1.75">175%</option><option value="2">200%</option>',
      "        </select>",
      "      </div>",
      '      <label class="tv-row"><input type="checkbox" id="tvCompactWall" /><span>Compact 3×2 wall</span></label>',
      "    </div>",
      "  </div>",
      '  <div class="tv-group">',
      '    <div class="tv-group-head"><span>Rotation timer</span></div>',
      '    <div class="tv-seg tv-seg-timer" id="tvDwellSeg">' + dwellChipsHtml + "</div>",
      "  </div>",
      '  <div class="tv-group">',
      '    <div class="tv-group-head"><span>Active views</span></div>',
      '    <div class="tv-chip-grid" id="tvViewGrid">' + viewChipsHtml + "</div>",
      "  </div>",
      "</div>",

      // Tab 2: Fleet (Machines)
      '<div class="tv-pane" data-tv-pane="fleet" hidden>',
      '  <label class="tv-row"><input type="checkbox" id="tvSkipDead" /><span>Hide dead feeds</span></label>',
      '  <div class="tv-machine-list" id="tvMachineList"></div>',
      "</div>",

      // Tab 3: Cards (Shared Canonical Card Toggles)
      '<div class="tv-pane tv-pane-cards" data-tv-pane="cards" hidden>',
      sharedCards,
      "</div>",

      // Tab 4: Clock (Clock, Timezone & Scope)
      '<div class="tv-pane" data-tv-pane="clock" hidden>',
      '  <label class="tv-row"><input type="checkbox" id="tvShowClock" /><span>Wall clock</span></label>',
      '  <div class="tv-row">',
      '    <label for="tvTz">Timezone</label>',
      '    <select id="tvTz">' + tzOptsHtml + "</select>",
      "  </div>",
      '  <label class="tv-row"><input type="checkbox" id="tvBothClocks" /><span>Shift clock</span></label>',
      '  <div class="tv-group tv-scope-group">',
      '    <div class="tv-group-head"><span>Save scope</span><button type="button" class="tv-link-btn" id="tvReset">Reset</button></div>',
      '    <div class="tv-seg" role="tablist">',
      '      <button type="button" class="tv-seg-btn is-active" data-tv-scope="global" role="tab">Global</button>',
      '      <button type="button" class="tv-seg-btn" data-tv-scope="device" role="tab">This display</button>',
      "    </div>",
      '    <div class="tv-note" id="tvSaveNote"></div>',
      "  </div>",
      "</div>",
    ].join("");

    wirePanel(wrap);
  }

  function wirePanel(wrap) {
    var controls = {
      perPage: wrap.querySelector("#tvPerPage"),
      zoom: wrap.querySelector("#tvZoom"),
      compactWall: wrap.querySelector("#tvCompactWall"),
      customFit: wrap.querySelector("#tvCustomFit"),
      fitSummary: wrap.querySelector("#tvFitSummary"),
      skipDead: wrap.querySelector("#tvSkipDead"),
      showClock: wrap.querySelector("#tvShowClock"),
      tz: wrap.querySelector("#tvTz"),
      bothClocks: wrap.querySelector("#tvBothClocks"),
      viewGrid: wrap.querySelector("#tvViewGrid"),
      dwellSeg: wrap.querySelector("#tvDwellSeg"),
    };

    var dash = dashSettings();
    var DS = window.__VMC_DASH_SECTIONS__ || null;
    var shared = null;
    if (DS && dash) {
      shared = DS.wire(wrap, TVCLS_SHARED, {
        eff: function () { return dash.effective(); },
        patch: function () { return dash.patch(panelScope); },
        set: function (key, value) { dash.set(panelScope, key, value); },
        after: function () {
          if (active) {
            if (isCompact() !== layoutCompact) {
              cardPage = 0;
              rebuildAndRun(false);
            } else if (view === "cards") {
              applyFleetLayout(false);
            }
          }
          sync();
        },
      });
    }

    function ensureTzOption(tzVal) {
      if (!controls.tz || !tzVal) return;
      var found = false;
      for (var i = 0; i < controls.tz.options.length; i++) {
        if (controls.tz.options[i].value === tzVal) { found = true; break; }
      }
      if (!found) {
        var opt = document.createElement("option");
        opt.value = tzVal;
        opt.textContent = tzVal + " (" + tzShortFor(tzVal) + ")";
        controls.tz.appendChild(opt);
      }
    }

    function applyTab(tabId) {
      activeTab = tabId || "view";
      Array.prototype.forEach.call(wrap.querySelectorAll("[data-tv-tab]"), function (btn) {
        var on = btn.dataset.tvTab === activeTab;
        btn.classList.toggle("is-active", on);
        btn.setAttribute("aria-selected", on ? "true" : "false");
      });
      Array.prototype.forEach.call(wrap.querySelectorAll("[data-tv-pane]"), function (pane) {
        pane.hidden = pane.dataset.tvPane !== activeTab;
      });
    }

    function sync() {
      applyTab(activeTab);

      var autoOn = isAutoFit();
      Array.prototype.forEach.call(wrap.querySelectorAll("[data-tv-fit]"), function (btn) {
        btn.classList.toggle("is-active", (btn.dataset.tvFit === "auto") === autoOn);
      });
      controls.customFit.hidden = autoOn;
      controls.fitSummary.hidden = !autoOn;
      updateFitSummary();

      var compact = isCompact();
      controls.compactWall.checked = compact;
      controls.perPage.value = String(tvValue("perPage", 3));
      controls.perPage.disabled = compact;
      controls.zoom.value = String(tvValue("zoom", 0));

      var first = cfg.playlist && cfg.playlist[0] ? parseSeconds(cfg.playlist[0].dwell) : parseSeconds(cfg.interval);
      var dwellMs = Number(tvValue("interval", first === null ? 20000 : first)) || 0;
      Array.prototype.forEach.call(controls.dwellSeg.querySelectorAll("[data-tv-dwell]"), function (btn) {
        btn.classList.toggle("is-active", Number(btn.dataset.tvDwell) === dwellMs);
      });

      var activeViews = activePlaylistViews();
      Array.prototype.forEach.call(controls.viewGrid.querySelectorAll("[data-tv-view-toggle]"), function (chip) {
        var on = activeViews.indexOf(chip.dataset.tvViewToggle) !== -1;
        chip.classList.toggle("is-active", on);
        chip.setAttribute("aria-pressed", on ? "true" : "false");
      });

      controls.skipDead.checked = !!tvValue("skipDead", false);

      var showClk = tvValue("showClock", true);
      controls.showClock.checked = showClk !== false;
      var curTz = tvValue("tz", "Asia/Bangkok") || "Asia/Bangkok";
      ensureTzOption(curTz);
      controls.tz.value = curTz;
      controls.tz.disabled = !controls.showClock.checked;
      controls.bothClocks.checked = !!tvValue("showShiftClock", false);
      controls.bothClocks.disabled = !controls.showClock.checked;

      if (shared) shared.sync();

      Array.prototype.forEach.call(wrap.querySelectorAll("[data-tv-scope]"), function (tab) {
        tab.classList.toggle("is-active", tab.dataset.tvScope === panelScope);
      });

      renderMachineList();
      updateStatus();
      updateDockIndicators();
    }

    panelSyncFn = sync;

    // Tab switching
    Array.prototype.forEach.call(wrap.querySelectorAll("[data-tv-tab]"), function (btn) {
      btn.addEventListener("click", function () {
        applyTab(btn.dataset.tvTab);
      });
    });

    // Fit mode (Auto vs Custom)
    Array.prototype.forEach.call(wrap.querySelectorAll("[data-tv-fit]"), function (btn) {
      btn.addEventListener("click", function () {
        var wantAuto = btn.dataset.tvFit === "auto";
        if (wantAuto === isAutoFit()) return;
        cfg.autoFit = wantAuto;
        if (wantAuto) cfg.zoom = 0;
        saveTv(wantAuto ? { autoFit: true, zoom: 0 } : { autoFit: false });
        cardPage = 0;
        rebuildAndRun(false);
        sync();
      });
    });

    // Timer segmented buttons
    controls.dwellSeg.addEventListener("click", function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest("[data-tv-dwell]") : null;
      if (!btn) return;
      var ms = Number(btn.dataset.tvDwell) || 0;
      cfg.interval = ms;
      cfg.playlist = activePlaylistViews().map(function (v) { return { view: v, dwell: ms }; });
      saveTv({ interval: ms, playlist: cfg.playlist });
      rebuildAndRun(true);
      sync();
    });

    // View chips
    controls.viewGrid.addEventListener("click", function (ev) {
      var chip = ev.target && ev.target.closest ? ev.target.closest("[data-tv-view-toggle]") : null;
      if (!chip) return;
      var targetView = chip.dataset.tvViewToggle;
      var current = activePlaylistViews();
      var idx = current.indexOf(targetView);
      if (idx !== -1) {
        if (current.length <= 1) return;
        current.splice(idx, 1);
      } else {
        current.push(targetView);
        current.sort(function (a, b) {
          var ia = ROTATION_VIEWS.findIndex(function (x) { return x.id === a; });
          var ib = ROTATION_VIEWS.findIndex(function (x) { return x.id === b; });
          return ia - ib;
        });
      }
      var dwell = parseSeconds(cfg.interval);
      if (dwell === null) dwell = 20000;
      cfg.playlist = current.map(function (v) { return { view: v, dwell: dwell }; });
      saveTv({ playlist: cfg.playlist });
      rebuildAndRun(false);
      sync();
    });

    // Custom layout controls
    controls.perPage.addEventListener("change", function () {
      cfg.perPage = Number(controls.perPage.value) || 0;
      cfg.autoFit = false;
      cardPage = 0;
      saveTv({ autoFit: false, perPage: cfg.perPage });
      rebuildAndRun(false);
      sync();
    });

    controls.zoom.addEventListener("change", function () {
      cfg.zoom = Number(controls.zoom.value) || 0;
      cfg.autoFit = false;
      saveTv({ autoFit: false, zoom: cfg.zoom });
      applyStageScale();
      sync();
    });

    controls.compactWall.addEventListener("change", function () {
      var d = dashSettings();
      if (d) d.set(panelScope, "previewSections.summary", !controls.compactWall.checked);
      cardPage = 0;
      rebuildAndRun(false);
      sync();
    });

    // Fleet
    controls.skipDead.addEventListener("change", function () {
      cfg.skipDead = !!controls.skipDead.checked;
      cardPage = 0;
      saveTv({ skipDead: cfg.skipDead });
      rebuildAndRun(false);
      sync();
    });

    // Clock & Scope
    controls.showClock.addEventListener("change", function () {
      cfg.showClock = !!controls.showClock.checked;
      saveTv({ showClock: cfg.showClock });
      buildClock();
      sync();
    });

    controls.tz.addEventListener("change", function () {
      var tzVal = controls.tz.value || "Asia/Bangkok";
      var label = tzVal === "local" ? "LOCAL" : tzShortFor(tzVal);
      cfg.tz = tzVal;
      cfg.tzLabel = label;
      saveTv({ tz: tzVal, tzLabel: label });
      buildClock();
      sync();
    });

    controls.bothClocks.addEventListener("change", function () {
      cfg.showShiftClock = !!controls.bothClocks.checked;
      saveTv({ showShiftClock: cfg.showShiftClock });
      buildClock();
    });

    Array.prototype.forEach.call(wrap.querySelectorAll("[data-tv-scope]"), function (tab) {
      tab.addEventListener("click", function () {
        panelScope = tab.dataset.tvScope === "device" ? "device" : "global";
        sync();
      });
    });

    wrap.querySelector("#tvReset").addEventListener("click", function () {
      if (window.__VMC_TV_CFG_RESET__) window.__VMC_TV_CFG_RESET__(panelScope);
      var d = dashSettings();
      if (d) d.reset(panelScope);
      cardPage = 0;
      buildClock();
      rebuildAndRun(false);
      sync();
      setSaveNote("Reset " + (panelScope === "global" ? "Global" : "This display"), false);
    });

    wrap.querySelector("#tvClose").addEventListener("click", hidePanel);
    sync();
  }

  // ------------------------------------------------------------- machine list

  function currentOrderForEdit() {
    var order = (cfg.machines || []).slice();
    fleetOrder.forEach(function (id) {
      if (order.indexOf(id) === -1) order.push(id);
    });
    return order;
  }

  function renderMachineList() {
    var host = document.getElementById("tvMachineList");
    if (!host) return;

    var all = orderedFleet().slice();
    fleetOrder.forEach(function (id) {
      if (all.indexOf(id) === -1) all.push(id);
    });

    if (!all.length) {
      host.innerHTML = '<span class="tv-note">Waiting for collector…</span>';
      return;
    }

    var editOrder = currentOrderForEdit().filter(function (id) {
      return all.indexOf(id) !== -1;
    });

    host.innerHTML = editOrder.map(function (id, i) {
      var on = (cfg.exclude || []).indexOf(id) === -1;
      var fresh = fleetFresh[id] || "";
      var autoHidden = !!cfg.skipDead && fresh === "dead" && on;
      return '<div class="tv-machine" data-id="' + id + '"' + (autoHidden ? ' data-auto-hidden="1"' : "") + ">" +
        '<label class="tv-mname"><input type="checkbox" class="tv-mchk"' + (on ? " checked" : "") + " /><span>" + id + "</span></label>" +
        '<span class="tv-mfresh" data-fresh="' + fresh + '">' + (autoHidden ? "skip" : (fresh || "—")) + "</span>" +
        '<div class="tv-morder">' +
        '  <button type="button" class="tv-mv" data-dir="-1" title="Move up"' + (i === 0 ? " disabled" : "") + ">▲</button>" +
        '  <button type="button" class="tv-mv" data-dir="1" title="Move down"' + (i === editOrder.length - 1 ? " disabled" : "") + ">▼</button>" +
        "</div>" +
        "</div>";
    }).join("");

    Array.prototype.forEach.call(host.querySelectorAll(".tv-mv"), function (btn) {
      btn.addEventListener("click", function () {
        var row = btn.closest(".tv-machine");
        if (!row) return;
        moveMachine(row.dataset.id, Number(btn.dataset.dir));
      });
    });

    Array.prototype.forEach.call(host.querySelectorAll(".tv-mchk"), function (box) {
      box.addEventListener("change", function () {
        var row = box.closest(".tv-machine");
        if (!row) return;
        toggleMachine(row.dataset.id, box.checked);
      });
    });
  }

  function moveMachine(id, dir) {
    var order = currentOrderForEdit();
    var i = order.indexOf(id);
    if (i === -1) return;
    var j = i + dir;
    if (j < 0 || j >= order.length) return;
    order.splice(j, 0, order.splice(i, 1)[0]);
    cfg.machines = order;
    saveTv({ machines: order });
    applyFleetLayout(false);
    renderMachineList();
  }

  function toggleMachine(id, on) {
    var ex = (cfg.exclude || []).slice();
    var i = ex.indexOf(id);
    if (on && i !== -1) ex.splice(i, 1);
    if (!on && i === -1) ex.push(id);
    cfg.exclude = ex;
    saveTv({ exclude: ex });
    cardPage = 0;
    rebuildAndRun(false);
    renderMachineList();
  }

  // ------------------------------------------------------------------- reveal

  function showPanel() {
    var wrap = document.getElementById("tvControls");
    if (!wrap) return;
    wrap.hidden = false;
    document.documentElement.setAttribute("data-tv-panel", "1");
    revealDock();
    if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; }
    if (panelSyncFn) panelSyncFn();
    updateDockIndicators();
  }

  function hidePanel() {
    var wrap = document.getElementById("tvControls");
    if (!wrap) return;
    wrap.hidden = true;
    document.documentElement.removeAttribute("data-tv-panel");
    updateDockIndicators();
    scheduleDockHide();
  }

  function panelOpen() {
    var wrap = document.getElementById("tvControls");
    return wrap && !wrap.hidden;
  }

  function onDocumentClick(ev) {
    if (!active || !panelOpen()) return;
    var wrap = document.getElementById("tvControls");
    var dock = document.getElementById("tvDock");
    if (wrap && wrap.contains(ev.target)) return;
    if (dock && dock.contains(ev.target)) return;
    hidePanel();
  }

  function onViewportChange() {
    if (!active) return;
    updateDockIndicators();
    if (view === "cards") {
      var prevPages = pageCount();
      applyFleetLayout(false);
      if (pageCount() !== prevPages) {
        steps = buildSteps();
        stepIdx = Math.min(stepIdx, Math.max(0, steps.length - 1));
      }
      updateStatus();
    }
  }

  function onKeyDown(ev) {
    if (!active) return;
    var t = ev.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) {
      if (ev.key === "Escape") hidePanel();
      return;
    }

    switch (ev.key) {
      case "s":
      case "S":
        if (panelOpen()) hidePanel(); else showPanel();
        break;
      case "a":
      case "A":
        revealDock();
        toggleAutoFitMode();
        break;
      case " ":
        ev.preventDefault();
        revealDock();
        setPaused(!paused);
        break;
      case "ArrowRight":
        revealDock();
        runStep(stepIdx + 1);
        break;
      case "ArrowLeft":
        revealDock();
        runStep(stepIdx - 1);
        break;
      case "Escape":
        if (panelOpen()) hidePanel();
        else exit();
        break;
      case "x":
      case "X":
        exit();
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------- enter / exit

  function migrateLegacy() {
    try {
      var old = localStorage.getItem(LEGACY_LS_KEY);
      if (!old) return;
      var ms = parseSeconds(old);
      localStorage.removeItem(LEGACY_LS_KEY);
      if (ms === null) return;
      var saved = JSON.parse(localStorage.getItem("vmc_tv_cfg") || "{}");
      if (saved && saved.interval !== undefined) return;
      cfg.interval = ms;
      cfg.playlist = (cfg.playlist || []).map(function (s) {
        return { view: s.view, dwell: ms };
      });
      if (window.__VMC_TV_CFG_SAVE__) {
        window.__VMC_TV_CFG_SAVE__({ interval: ms, playlist: cfg.playlist });
      }
    } catch (_) {}
  }

  function ensureDom() {
    if (domBuilt) return;
    domBuilt = true;
    migrateLegacy();
    buildPanel();
    buildDock();
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointermove", onPointerActivity, { passive: true });
    document.addEventListener("pointerdown", onPointerActivity, { passive: true });
    document.addEventListener("touchstart", onPointerActivity, { passive: true });
    document.addEventListener("click", onDocumentClick);
    document.addEventListener("fullscreenchange", onViewportChange);
    window.addEventListener("resize", onViewportChange);
  }

  function enter(opts) {
    opts = opts || {};
    if (active) {
      if (opts.fullscreen && !document.fullscreenElement) toggleBrowserFullscreen();
      return;
    }

    if (typeof window.__VMC_CLOSE_DASH_CFG__ === "function") {
      try { window.__VMC_CLOSE_DASH_CFG__(); } catch (_) {}
    }

    var activeTabEl = document.querySelector(".godnav-tab.is-active");
    prevTabId = (activeTabEl && activeTabEl.dataset && activeTabEl.dataset.tab) || "dashboard";

    ensureDom();
    active = true;
    window.__VMC_TV__ = true;

    // Never apply document-level CSS zoom in TV mode — stage scaling keeps
    // cards proportional and dock/popover crisp at native CSS pixels.
    document.documentElement.style.zoom = "";
    document.documentElement.setAttribute("data-tv", "1");
    document.documentElement.setAttribute("data-tv-ready", "1");
    if (!cfg.chrome) document.documentElement.setAttribute("data-tv-bare", "1");

    if (opts.fullscreen && !document.fullscreenElement) {
      toggleBrowserFullscreen();
    }

    buildClock();
    rebuildAndRun(false);
    revealDock();

    if (layoutTimer) clearInterval(layoutTimer);
    layoutTimer = setInterval(function () {
      if (active && view === "cards") applyStageScale();
    }, 1500);

    if (panelSyncFn) panelSyncFn();
    window.dispatchEvent(new CustomEvent("vmc-tv-mode", { detail: { active: true } }));
  }

  function exit() {
    if (!active) return;
    active = false;
    window.__VMC_TV__ = false;

    if (stepTimer) { clearTimeout(stepTimer); stepTimer = null; }
    if (layoutTimer) { clearInterval(layoutTimer); layoutTimer = null; }
    if (fitRaf) { cancelAnimationFrame(fitRaf); fitRaf = 0; }

    hidePanel();
    hideDock();
    destroyClock();

    if (wasTimeline) {
      releaseTimeline();
      wasTimeline = false;
    }
    paused = false;
    dockHovered = false;

    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        var p = document.exitFullscreen();
        if (p && typeof p.catch === "function") p.catch(function () {});
      }
    } catch (_) {}

    var h = document.documentElement;
    [
      "data-tv",
      "data-tv-ready",
      "data-tv-bare",
      "data-tv-view",
      "data-tv-compact",
      "data-tv-paused",
      "data-tv-panel",
      "data-tv-dock",
      "data-tv-page",
      "data-tv-pages",
    ].forEach(function (attr) { h.removeAttribute(attr); });
    try { document.body.removeAttribute(VIEW_ATTR); } catch (_) {}
    h.style.zoom = "";

    restoreFleetLayout();

    try {
      var restoreBtn = document.querySelector('.godnav-tab[data-tab="' + (prevTabId || "dashboard") + '"]');
      if (restoreBtn && !restoreBtn.classList.contains("is-active")) {
        restoreBtn.click();
      }
    } catch (_) {}

    try {
      if (window.location.pathname === "/tv" || window.location.pathname === "/tv/" || window.location.pathname === "/tv.html") {
        window.history.replaceState(null, "", "/");
      }
    } catch (_) {}

    window.dispatchEvent(new CustomEvent("vmc-tv-mode", { detail: { active: false } }));
  }

  function toggle(opts) {
    if (active) exit();
    else enter(opts);
  }

  window.addEventListener("vmc-overview", onOverview);

  function bootIfTvUrl() {
    var shouldBoot = Boolean(
      window.__VMC_TV_BOOT__ ||
      document.documentElement.hasAttribute("data-tv")
    );
    if (shouldBoot) enter({ fullscreen: false });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootIfTvUrl);
  } else {
    bootIfTvUrl();
  }

  window.__VMC_TV_API__ = {
    enter: enter,
    exit: exit,
    toggle: toggle,
    isActive: function () { return active; },
    next: function () { runStep(stepIdx + 1); },
    prev: function () { runStep(stepIdx - 1); },
    pause: function () { setPaused(true); },
    resume: function () { setPaused(false); },
    autoFit: toggleAutoFitMode,
    steps: function () { return steps.slice(); },
    fleet: orderedFleet,
    cfg: cfg,
    fit: function () { return { cols: lastFit.cols, rows: lastFit.rows, perPage: lastFit.perPage, scale: lastFit.scale }; },
    parseSeconds: parseSeconds,
  };
})();
