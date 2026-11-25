/* VMC TV Wall Board — rotation engine, fleet ordering, wall clock, walk-up panel.
 *
 * Only runs under html[data-tv] (kiosk mode, i.e. /tv or the TV_MODE landing
 * page). Reads its settings from window.__VMC_TV_CFG__ (see tv-config.js).
 *
 * WHAT REPLACED WHAT, AND WHY
 *
 * The previous version flipped between two hardcoded views on one global
 * interval, and had three defects worth naming because they shaped this rewrite:
 *
 *  1. The interval dropdown never worked. index.html emits option values
 *     5000/10000/15000/30000, and parseInterval() matched only 5/10/15/30 --
 *     so every choice except Off fell through to a hardcoded 10000. The select
 *     redisplayed the saved value on reload, which is exactly why it looked
 *     like it worked. parseSeconds() below accepts BOTH shapes, because a board
 *     that has been running with the old localStorage key must not silently
 *     change dwell the day it is upgraded.
 *
 *  2. getShiftFrom() fired an extra /api/overview on EVERY view flip -- as
 *     often as every 5s, forever -- against the heaviest endpoint in the stack
 *     (documented in the collector at 3-13s with a 15s timeout). It computed
 *     __VMC_TV_SHIFT_FROM__, __VMC_TV_VIEW__ and a vmc-tv-view CustomEvent that
 *     had zero consumers anywhere in the repo. All of it is gone. The shift
 *     window arrives in the /api/overview payload app.js already polls once a
 *     second and rebroadcasts as `vmc-overview`; we listen to that instead of
 *     opening a second request path.
 *
 *  3. Fleet pagination cannot be done by filtering the payload. app.js's render
 *     cleanup loop removes any machine absent from the rendered set and calls
 *     disposeScene() on it -- so filtering data.machines would tear down and
 *     rebuild every off-page machine's WebGL context on every 1s poll, straight
 *     into the ~16-context browser cap that app.js already documents as the
 *     cause of black cards. We page by toggling the `hidden` attribute on cards
 *     app.js owns, which also flips entry.onScreen false through its existing
 *     IntersectionObserver -- so paging is CHEAPER on the GPU than showing all
 *     six at once, not more expensive.
 *
 * DOM SAFETY. kiosk.rs injects a MutationObserver that re-applies
 * display:none to `.godnav, .topbar .cfg-btn` on every DOM mutation, forever,
 * and never disconnects. So: nothing this file creates may match those
 * selectors, and no new button may carry the cfg-btn class. Everything mounted
 * here goes in #tvControls (outside <header class="topbar">) or in its own
 * fixed containers, all of which the observer ignores.
 */
(function () {
  "use strict";

  var isTv = document.documentElement.hasAttribute("data-tv") || window.__VMC_TV__;
  if (!isTv) return;

  var cfg = window.__VMC_TV_CFG__ || {};
  var VIEW_ATTR = "data-tv-view";
  var LEGACY_LS_KEY = "vmc_tv_interval";

  // ---------------------------------------------------------------- utilities

  // Accepts 5, "5", 5000, "5000", "off", "0". The old markup and the old
  // dynamically-created fallback select disagreed on which shape they emitted,
  // so both have to work or upgrading the board silently changes its dwell.
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

  // ------------------------------------------------------------------- clock

  var clockEl = null;
  var clockTimer = null;
  // Offset between the collector's clock and this browser's, in ms. Applied so
  // the wall shows the time the DATA is stamped with rather than whatever the
  // display's own OS thinks. Nothing in installer/ sets or verifies the box
  // timezone or NTP sync (no tzutil, Set-TimeZone or w32tm anywhere), so
  // browser-local time on that machine is not something to trust.
  var serverSkewMs = 0;
  var sawServerTime = false;

  function makeFormatter(tz) {
    try {
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
    } catch (_) {
      return null;
    }
  }

  var fmtMain = null;
  var fmtShift = null;

  function buildClock() {
    if (!cfg.showClock) return;
    fmtMain = makeFormatter(cfg.tz);
    if (!fmtMain) return; // unknown zone: no clock beats a thrown board

    if (cfg.showShiftClock) fmtShift = makeFormatter(cfg.shiftTz);

    // Mounted into .topbar-right, in normal flow -- deliberately NOT a fixed
    // overlay. A fixed top-right pill would sit on top of .alert-toast-stack
    // (position:fixed; top:16px; right:16px in godmode.css) and, at the size a
    // wall clock needs, would cover the alarm channel on a board whose whole
    // job is surfacing alarms. It would also cover the timeline's own sticky
    // lane header (position:sticky; top:0), and the timeline is half the
    // rotation. Normal flow has neither problem.
    var host = document.querySelector(".topbar-right");
    if (!host) return;

    clockEl = document.createElement("div");
    clockEl.className = "tv-clock";
    clockEl.id = "tvClock";
    host.appendChild(clockEl);

    tickClock();
    // Tick at 1Hz. Cheap: two Intl format calls against a cached formatter.
    clockTimer = setInterval(tickClock, 1000);
  }

  function tickClock() {
    if (!clockEl || !fmtMain) return;
    var now = new Date(Date.now() + serverSkewMs);
    var main = fmtMain.format(now);

    var html =
      '<span class="tv-clock-time">' + main + "</span>" +
      '<span class="tv-clock-zone">' + (cfg.tzLabel || "") + "</span>";

    if (fmtShift) {
      html +=
        '<span class="tv-clock-sep"></span>' +
        '<span class="tv-clock-time tv-clock-time-alt">' + fmtShift.format(now) + "</span>" +
        '<span class="tv-clock-zone">' + (cfg.shiftTzLabel || "") + "</span>";
    }

    // The caption is not decoration. Shift boundaries are computed server-side
    // at a fixed +05:30 and arrive already labelled, so a Bangkok clock beside
    // "SHIFT 03 22:00" is 1.5h out by design. Without this line that reads as a
    // bug; with it, it reads as two timezones.
    if (!fmtShift && cfg.tz !== cfg.shiftTz) {
      html += '<span class="tv-clock-note">shifts: ' + (cfg.shiftTzLabel || "IST") + "</span>";
    }

    // Stale data marker: if the collector has stopped talking, freeze visibly
    // rather than keep counting confidently.
    clockEl.classList.toggle("is-unsynced", !sawServerTime);
    clockEl.innerHTML = html;
  }

  // ------------------------------------------------------------ fleet control

  // Every machine id the collector has reported this session, in payload order.
  var fleetOrder = [];
  // machine_id -> freshness tier ("fresh" | "lagging" | "stale" | "dead" | "unknown")
  var fleetFresh = Object.create(null);

  // Freshness decides whether a machine is hidden from the wall, so it has to be
  // read exactly the way the cards read it. app.js:164 readFreshness() is a
  // genuine global (app.js is a classic script, not a module) and it handles the
  // cases a naive `m.freshness` lookup gets wrong: data_age_sec === null means
  // "never heard from", and Number(null) is 0, which would tier a dead machine
  // as FRESH. Reusing it also means the panel's per-machine tier can never
  // disagree with the badge on the card. Fall back only if it is somehow absent.
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

  function orderedFleet() {
    var wanted = [];
    var seen = Object.create(null);

    // Configured order first, but only ids the collector actually reports --
    // a typo in the config must not create a phantom page.
    cfg.machines.forEach(function (id) {
      if (fleetOrder.indexOf(id) !== -1 && !seen[id]) {
        seen[id] = true;
        wanted.push(id);
      }
    });

    // Then everything else in payload order, so a machine added to the fleet
    // shows up on the wall without anyone editing the config.
    fleetOrder.forEach(function (id) {
      if (!seen[id]) {
        seen[id] = true;
        wanted.push(id);
      }
    });

    return wanted.filter(function (id) {
      if (cfg.exclude.indexOf(id) !== -1) return false;
      if (cfg.skipDead && fleetFresh[id] === "dead") return false;
      return true;
    });
  }

  // Machines the operator would otherwise think are gone. A dead feed silently
  // vanishing is worse than a dead feed shown as dead, so paging keeps a strip.
  function skippedFleet() {
    if (!cfg.skipDead) return [];
    return fleetOrder.filter(function (id) {
      return cfg.exclude.indexOf(id) === -1 && fleetFresh[id] === "dead";
    });
  }

  var cardPage = 0;

  // Summary section off (html[data-summary="off"], set by app.js from the
  // shared Display prefs) = compact wall: six cards per page as a fixed 3x2
  // grid, overriding Cards/page, because the shorter cards are what make six
  // fit on one screen.
  var COMPACT_PER_PAGE = 6;
  var COMPACT_COLS = 3;
  var layoutCompact = null;

  function isCompact() {
    return document.documentElement.getAttribute("data-summary") === "off";
  }

  function perPageFor(n) {
    if (isCompact()) return COMPACT_PER_PAGE;
    return cfg.perPage > 0 ? cfg.perPage : n;
  }

  function pageCount() {
    var n = orderedFleet().length;
    var per = perPageFor(n);
    if (!per) return 1;
    return Math.max(1, Math.ceil(n / per));
  }

  // Apply order + visibility to the cards app.js has rendered. Called after
  // every payload (app.js rebuilds/reorders on each 1s poll, so a one-shot
  // application would be undone within the second).
  function applyFleetLayout() {
    var grid = document.getElementById("machineGrid");
    if (!grid) return;

    var visible = orderedFleet();
    var per = perPageFor(visible.length);
    var pages = pageCount();
    if (cardPage >= pages) cardPage = 0;

    var start = per ? cardPage * per : 0;
    var onThisPage = per ? visible.slice(start, start + per) : visible;

    var cards = grid.querySelectorAll(".machine-card[data-machine]");
    Array.prototype.forEach.call(cards, function (card) {
      var id = (card.dataset.machine || "").toUpperCase();
      var idx = onThisPage.indexOf(id);
      if (idx === -1) {
        // `hidden` rather than removal from the payload: see the header note
        // about disposeScene() and the WebGL context cap.
        card.hidden = true;
        card.style.order = "";
      } else {
        card.hidden = false;
        // CSS order, not DOM order: app.js re-forces DOM order to payload order
        // via insertBefore on every poll, so moving nodes would fight it every
        // second. In a grid container, `order` decides visual position anyway.
        card.style.order = String(idx);
      }
    });

    // Tell the CSS how many columns this page needs, so 2 machines do not
    // render as two narrow cards in a 3-column track with a hole beside them.
    var compact = isCompact();
    layoutCompact = compact;
    document.documentElement.toggleAttribute("data-tv-compact", compact);
    if (compact) {
      // Always 3 tracks x 2 rows, even for a short last page, so a card keeps
      // one size no matter how many share the page.
      grid.style.setProperty("--tv-cols", String(COMPACT_COLS));
      grid.style.setProperty("--tv-rows", String(Math.ceil(COMPACT_PER_PAGE / COMPACT_COLS)));
    } else {
      // Keep the normal Summary layout readable on narrow screens when the
      // saved Cards/page value is larger than the viewport can support.
      var cols = Math.max(1, onThisPage.length);
      if (window.innerWidth && window.innerWidth <= 640) cols = Math.min(cols, 1);
      else if (window.innerWidth && window.innerWidth <= 980) cols = Math.min(cols, 3);
      grid.style.setProperty("--tv-cols", String(cols));
      grid.style.removeProperty("--tv-rows");
    }
    document.documentElement.setAttribute("data-tv-page", String(cardPage + 1));
    document.documentElement.setAttribute("data-tv-pages", String(pages));

    renderSkipStrip();
    renderPager(pages);
  }

  function renderSkipStrip() {
    var skipped = skippedFleet();
    var strip = document.getElementById("tvSkipStrip");
    if (!skipped.length) {
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
    if (pages <= 1) {
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

  // Expand the configured playlist into concrete steps. A `cards` step with
  // pagination becomes one step per page, so the rotation walks the whole fleet
  // instead of redisplaying page 1 forever.
  function buildSteps() {
    var steps = [];
    (cfg.playlist || []).forEach(function (spec) {
      var view = spec && spec.view;
      if (!view) return;
      var dwell = parseSeconds(spec.dwell);
      if (dwell === null) dwell = parseSeconds(cfg.interval) || 15000;

      if (view === "cards") {
        var pages = pageCount();
        for (var p = 0; p < pages; p++) {
          steps.push({ view: "cards", page: p, dwell: dwell });
        }
      } else {
        steps.push({ view: view, dwell: dwell });
      }
    });
    if (!steps.length) steps.push({ view: "cards", page: 0, dwell: 15000 });
    return steps;
  }

  var steps = [];
  var stepIdx = 0;
  var stepTimer = null;
  var paused = false;
  var view = "cards";
  var wasTimeline = false;

  function applyView(v) {
    view = v;
    document.documentElement.setAttribute(VIEW_ATTR, v);
    try { document.body.setAttribute(VIEW_ATTR, v); } catch (_) {}

    // godmode.js only mounts a section when its tab is activated, and its
    // activate() is module-private -- clicking the tab is the only mount path
    // in. Without this the CSS reveals an empty pane: visible, and inert.
    try {
      var targetTab = v === "cards" ? "dashboard" : v;
      var btn = document.querySelector('.godnav-tab[data-tab="' + targetTab + '"]');
      if (btn && !btn.classList.contains("is-active")) {
        btn.click();
      } else if (!btn) {
        // godmode.js is an ES module and may not have injected its nav yet on a
        // cold boot. Retry once rather than leaving the pane blank.
        setTimeout(function () {
          var late = document.querySelector('.godnav-tab[data-tab="' + targetTab + '"]');
          if (late && !late.classList.contains("is-active")) late.click();
          if (v === "timeline") presentTimeline();
        }, 400);
      }
    } catch (_) {}
  }

  function runStep(i) {
    if (!steps.length) return;
    stepIdx = ((i % steps.length) + steps.length) % steps.length;
    var step = steps[stepIdx];
    var isTimeline = step.view === "timeline";

    if (step.view === "cards") {
      cardPage = step.page || 0;
      applyView("cards");
      applyFleetLayout();
    } else {
      applyView(step.view);
    }
    // Release only on the transition AWAY from the timeline: release()
    // repaints + refetches, so calling it on every cards step would fetch a
    // hidden pane once per step for nothing.
    if (isTimeline) presentTimeline();
    else if (wasTimeline) releaseTimeline();
    wasTimeline = isTimeline;

    updateStatus();

    if (stepTimer) { clearTimeout(stepTimer); stepTimer = null; }
    if (paused || !step.dwell) return;

    // setTimeout per step, not one setInterval: dwell varies per step.
    stepTimer = setTimeout(function () { runStep(stepIdx + 1); }, step.dwell);
  }

  // Wall timeline presentation (timeline.js bridge). Pins Hour + live and
  // follows the wall fleet (order + exclude + hide-dead via orderedFleet) as
  // ephemeral state; release() on every non-timeline step re-seeds the pane
  // from storage so the dashboard's own timeline is never polluted.
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

  function rebuildAndRun(keepIndex) {
    steps = buildSteps();
    runStep(keepIndex ? stepIdx : 0);
  }

  function setPaused(next) {
    paused = next;
    document.documentElement.toggleAttribute("data-tv-paused", paused);
    if (paused) {
      if (stepTimer) { clearTimeout(stepTimer); stepTimer = null; }
    } else {
      runStep(stepIdx);
    }
    updateStatus();
  }

  // ------------------------------------------------------------ overview feed

  // app.js rebroadcasts each /api/overview response as `vmc-overview` once a
  // second. Listening to that costs nothing; opening our own request against
  // that endpoint (as the old getShiftFrom did, on every flip) cost a lot.
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

      // A machine appearing or disappearing changes the page count, so the
      // playlist has to be rebuilt -- otherwise the rotation keeps walking to a
      // page that no longer exists, and shows a blank board when it gets there.
      if (changed) {
        var before = steps.length;
        steps = buildSteps();
        if (steps.length !== before) stepIdx = Math.min(stepIdx, steps.length - 1);
      }
    }

    // Trust the collector's clock over the display's. Both fields are epoch ms.
    var stamp = Number(data.data_updated_at_ms || data.updated_at_ms || 0);
    if (isFinite(stamp) && stamp > 0) {
      serverSkewMs = stamp - Date.now();
      sawServerTime = true;
    }

    if (view === "cards") applyFleetLayout();
  }

  // ------------------------------------------------------------------- status

  function updateStatus() {
    var el = document.getElementById("tvStatus");
    if (!el) return;
    var step = steps[stepIdx];
    if (paused) {
      el.textContent = "PAUSED";
      return;
    }
    if (!step || !step.dwell) {
      el.textContent = "HOLD";
      return;
    }
    var label = step.view === "cards" ? "CARDS" : step.view.toUpperCase();
    var pages = pageCount();
    if (step.view === "cards" && pages > 1) {
      label += " " + (cardPage + 1) + "/" + pages;
    }
    el.textContent = label + " · " + fmtDwell(step.dwell);
  }

  // ------------------------------------------------------------------- panel

  // The walk-up settings panel. Mounted into #tvControls, which sits OUTSIDE
  // <header class="topbar"> -- so the kiosk MutationObserver never touches it.
  // Hidden by default; revealed by tap/click on the corner hotspot, by pressing
  // `s`, or by mouse movement, so it works on a touchscreen, with a keyboard,
  // and on a panel nobody can reach (where it simply never opens, and the
  // keyboard sequence below is the only control surface).
  var panelScope = "global";

  // Theme classes for the SHARED card/display/profile sections (same structure
  // and wording as the dashboard panel; wall theme classes).
  var TVCLS_SHARED = { sec: "tv-panel-section", title: "tv-panel-section-title", row: "tv-panel-row", hint: "tv-panel-note", btn: "tv-btn", btns: "" };

  function tvScopePatch() {
    return window.__VMC_TV_CFG_SCOPE__ ? window.__VMC_TV_CFG_SCOPE__(panelScope) : {};
  }

  function tvValue(key, fallback) {
    var patch = tvScopePatch();
    return Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] :
      (cfg[key] === undefined ? fallback : cfg[key]);
  }

  function saveTv(patch) {
    var ok = window.__VMC_TV_CFG_SAVE__ ? window.__VMC_TV_CFG_SAVE__(patch, panelScope) : false;
    var note = document.getElementById("tvSaveNote");
    if (note) {
      note.textContent = ok
        ? (panelScope === "global" ? "Saved in Global." : "Saved for this display.")
        : "NOT SAVED — browser storage unavailable";
      note.classList.toggle("is-bad", !ok);
    }
    return ok;
  }

  function dashSettings() {
    return window.__VMC_DASH_SETTINGS__ || null;
  }

  function buildPanel() {
    var wrap = document.getElementById("tvControls");
    if (!wrap) return;
    wrap.innerHTML = "";
    wrap.hidden = true;
    wrap.classList.add("tv-panel");

    // Card/display/profile rows are the SHARED sections (same markup as the
    // dashboard panel in app.js). app.js always loads on this page; without
    // it there is no dash bridge, so show a note instead of dead controls.
    var DS = window.__VMC_DASH_SECTIONS__ || null;
    var sharedTop = DS ? DS.html(TVCLS_SHARED, ["display", "cards"]) :
      '<div class="tv-panel-section"><div class="tv-panel-note">Card settings need app.js.</div></div>';
    var sharedProfile = DS ? DS.html(TVCLS_SHARED, ["profile"]) : "";

    var html = [
      '<div class="tv-panel-row tv-panel-head">',
      '<span class="tv-panel-title">TV BOARD SETTINGS</span>',
      '<span class="tv-panel-status" id="tvStatus"></span>',
      '<button type="button" class="tv-x" id="tvClose" title="Close settings">✕</button>',
      '</div>',
      '<div class="tv-scope-tabs" role="tablist">',
      '<button type="button" class="tv-scope-tab is-active" data-tv-scope="global" role="tab">Global</button>',
      '<button type="button" class="tv-scope-tab" data-tv-scope="device" role="tab">This display</button>',
      '</div>',
      '<div class="tv-panel-note tv-scope-note" id="tvScopeNote"></div>',
      sharedTop,
      '<div class="tv-panel-section">',
      '<div class="tv-panel-section-title">Wall board</div>',
      '<div class="tv-panel-row"><label for="tvDwell">Slide time</label><select id="tvDwell">',
      '<option value="5000">5s</option><option value="10000">10s</option><option value="15000">15s</option>',
      '<option value="20000">20s</option><option value="30000">30s</option><option value="60000">60s</option><option value="0">Off</option>',
      '</select><button type="button" class="tv-btn" id="tvPause">Pause</button></div>',
      '<div class="tv-panel-row"><label for="tvPerPage">Cards / page</label><select id="tvPerPage">',
      '<option value="0">All</option><option value="1">1</option><option value="2">2</option><option value="3">3</option>',
      '<option value="4">4</option><option value="6">6</option></select><button type="button" class="tv-btn" id="tvNext">Next ▸</button></div>',
      '<div class="tv-panel-row"><label for="tvZoom">Board scale</label><select id="tvZoom">',
      '<option value="0">Auto</option><option value="1">100%</option><option value="1.25">125%</option>',
      '<option value="1.5">150%</option><option value="1.75">175%</option><option value="2">200%</option>',
      '</select><button type="button" class="tv-btn" id="tvFull">Full screen</button></div>',
      '<label class="tv-panel-row"><input type="checkbox" id="tvSkipDead" /><span>Hide dead feeds</span></label>',
      '<label class="tv-panel-row"><input type="checkbox" id="tvBothClocks" /><span>Show shift clock</span></label>',
      '</div>',
      '<div class="tv-panel-section tv-panel-machines">',
      '<div class="tv-panel-section-title">Machines &amp; order</div><div class="tv-machine-list" id="tvMachineList"></div>',
      '</div>',
      '<div class="tv-panel-section">',
      '<div class="tv-panel-section-title">Timeline step</div>',
      '<div class="tv-panel-row tv-panel-static"><span>Range pinned: Hour · Dwell <span id="tvTlDwell">20</span>s · Follows wall machines</span></div>',
      '</div>',
      sharedProfile,
      '<div class="tv-panel-row tv-panel-foot">',
      '<button type="button" class="tv-btn tv-btn-wide" id="tvExit">Exit to dashboard</button>',
      '<button type="button" class="tv-btn" id="tvReset">Reset scope</button>',
      '</div><div class="tv-panel-note" id="tvSaveNote"></div>'
    ].join("");
    wrap.innerHTML = html;
    ["click", "change", "keydown", "pointerdown"].forEach(function (evt) {
      wrap.addEventListener(evt, function () { if (!wrap.hidden) armAutoHide(); });
    });
    wirePanel(wrap);
  }

  function wirePanel(wrap) {
    var controls = {
      dwell: wrap.querySelector("#tvDwell"), perPage: wrap.querySelector("#tvPerPage"),
      zoom: wrap.querySelector("#tvZoom"), skipDead: wrap.querySelector("#tvSkipDead"),
      bothClocks: wrap.querySelector("#tvBothClocks"), scopeNote: wrap.querySelector("#tvScopeNote"),
      tlDwell: wrap.querySelector("#tvTlDwell")
    };
    // Card/display/profile rows are the SHARED sections: same markup, sync and
    // wording as the dashboard panel. Writes go through the dash bridge into
    // the active scope (panelScope), exactly like the dashboard's scope tabs.
    var dash = dashSettings();
    var DS = window.__VMC_DASH_SECTIONS__ || null;
    var shared = null;
    if (DS && dash) {
      shared = DS.wire(wrap, TVCLS_SHARED, {
        eff: function () { return dash.effective(); },
        patch: function () { return dash.patch(panelScope); },
        set: function (key, value) { dash.set(panelScope, key, value); },
        after: function (kind) {
          try { applyPrefsToDom(); if (kind === "card") applyCardPrefs(); } catch (_) {}
          // Summary on/off changes page size (compact 3x2 vs Cards/page), so
          // the playlist's page steps must be rebuilt, not just re-laid out.
          // dash.set already repainted the DOM, so compare with the last layout.
          if (isCompact() !== layoutCompact) { cardPage = 0; rebuildAndRun(false); }
          sync();
        },
        doExport: function () { if (dash.export) dash.export(); },
        doImport: function () { if (dash.import) dash.import(document.getElementById("tvSaveNote")); },
      });
    }

    function sync() {
      var tlStep = null;
      (cfg.playlist || []).forEach(function (step) {
        if (!tlStep && step && step.view === "timeline") tlStep = step;
      });
      var tlMs = parseSeconds(tlStep ? tlStep.dwell : null);
      if (controls.tlDwell) controls.tlDwell.textContent = String(Math.round((tlMs || 20000) / 1000));
      var first = cfg.playlist && cfg.playlist[0] ? parseSeconds(cfg.playlist[0].dwell) : parseSeconds(cfg.interval);
      controls.dwell.value = String(tvValue("interval", first === null ? 15000 : first));      controls.perPage.value = String(tvValue("perPage", 0));
      // Compact (Summary off) pins 6 per page; the saved value is kept and
      // applies again once Summary is back on.
      controls.perPage.disabled = isCompact();
      controls.perPage.title = isCompact() ? "Summary section off: 6 cards per page (3 x 2)" : "";
      controls.zoom.value = String(tvValue("zoom", 0));
      controls.skipDead.checked = !!tvValue("skipDead", false);
      controls.bothClocks.checked = !!tvValue("showShiftClock", false);
      if (shared) shared.sync();
      Array.prototype.forEach.call(wrap.querySelectorAll("[data-tv-scope]"), function (tab) {
        tab.classList.toggle("is-active", tab.dataset.tvScope === panelScope);
      });
      controls.scopeNote.textContent = panelScope === "global"
        ? "Global settings are the base for every display."
        : "This display overrides Global settings where changed.";
      renderMachineList(); updateStatus();
    }

    Array.prototype.forEach.call(wrap.querySelectorAll("[data-tv-scope]"), function (tab) {
      tab.addEventListener("click", function () { panelScope = tab.dataset.tvScope === "device" ? "device" : "global"; sync(); });
    });
    controls.dwell.addEventListener("change", function () {
      var ms = parseSeconds(controls.dwell.value); if (ms === null) return;
      cfg.interval = ms; cfg.playlist = (cfg.playlist || []).map(function (step) { return { view: step.view, dwell: ms }; });
      saveTv({ interval: ms, playlist: cfg.playlist }); rebuildAndRun(true);
    });
    controls.perPage.addEventListener("change", function () {
      cfg.perPage = Number(controls.perPage.value) || 0; cardPage = 0; saveTv({ perPage: cfg.perPage }); rebuildAndRun(false);
    });
    controls.zoom.addEventListener("change", function () {
      cfg.zoom = Number(controls.zoom.value) || 0; saveTv({ zoom: cfg.zoom }); applyZoom();
    });
    controls.skipDead.addEventListener("change", function () {
      cfg.skipDead = !!controls.skipDead.checked; cardPage = 0; saveTv({ skipDead: cfg.skipDead }); rebuildAndRun(false);
    });
    controls.bothClocks.addEventListener("change", function () {
      cfg.showShiftClock = !!controls.bothClocks.checked; saveTv({ showShiftClock: cfg.showShiftClock });
      if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
      if (clockEl && clockEl.parentNode) clockEl.parentNode.removeChild(clockEl);
      clockEl = null; fmtShift = null; buildClock();
    });
    var pauseBtn = wrap.querySelector("#tvPause");
    pauseBtn.addEventListener("click", function () { setPaused(!paused); pauseBtn.textContent = paused ? "Resume" : "Pause"; });
    wrap.querySelector("#tvNext").addEventListener("click", function () { runStep(stepIdx + 1); });
    wrap.querySelector("#tvFull").addEventListener("click", function () {
      var el = document.documentElement;
      try { if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen(); else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen(); } catch (_) {}
    });
    wrap.querySelector("#tvExit").addEventListener("click", leaveWallSkin);
    wrap.querySelector("#tvReset").addEventListener("click", function () {
      if (window.__VMC_TV_CFG_RESET__) window.__VMC_TV_CFG_RESET__(panelScope);
      var dash = dashSettings(); if (dash) dash.reset(panelScope);
      location.reload();
    });
    wrap.querySelector("#tvClose").addEventListener("click", hidePanel);
    sync();
  }

  function renderMachineList() {
    var host = document.getElementById("tvMachineList");
    if (!host) return;

    var ordered = orderedFleet();
    var all = ordered.slice();
    // Excluded machines still need a row, or there is no way to bring one back.
    fleetOrder.forEach(function (id) {
      if (all.indexOf(id) === -1) all.push(id);
    });

    if (!all.length) {
      host.innerHTML = '<span class="tv-hint">waiting for the collector…</span>';
      return;
    }

    // Rows are ordered by the edit order, not the filtered order, so the arrows
    // stay meaningful for a machine that is currently hidden -- otherwise the
    // last visible row and the last row disagree about which ▼ to disable.
    var editOrder = currentOrderForEdit().filter(function (id) {
      return all.indexOf(id) !== -1;
    });

    host.innerHTML = editOrder.map(function (id, i) {
      var on = cfg.exclude.indexOf(id) === -1;
      var fresh = fleetFresh[id] || "";
      // Distinguish "you excluded this" from "skipDead hid it". Both end up off
      // the wall, but only the first is something the operator chose -- showing
      // a ticked checkbox next to a machine that is not on screen reads as a
      // bug, which is exactly what the skipped state needs to not look like.
      var autoHidden = !!cfg.skipDead && fresh === "dead" && on;
      return '<div class="tv-machine" data-id="' + id + '"' + (autoHidden ? ' data-auto-hidden="1"' : "") + ">" +
        '<button type="button" class="tv-mv" data-dir="-1" title="Move earlier"' + (i === 0 ? " disabled" : "") + ">▲</button>" +
        '<button type="button" class="tv-mv" data-dir="1" title="Move later"' + (i === editOrder.length - 1 ? " disabled" : "") + ">▼</button>" +
        '<label><input type="checkbox" class="tv-mchk"' + (on ? " checked" : "") + " /> " + id + "</label>" +
        '<span class="tv-mfresh" data-fresh="' + fresh + '">' + (fresh || "—") + "</span>" +
        (autoHidden ? '<span class="tv-mskip" title="Hidden by &quot;Hide dead feeds&quot;">SKIP</span>' : "") +
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

  function currentOrderForEdit() {
    // The explicit order, seeded from the live fleet the first time someone
    // reorders anything -- otherwise moving one machine would drop every other
    // machine to the end.
    var order = cfg.machines.slice();
    fleetOrder.forEach(function (id) {
      if (order.indexOf(id) === -1) order.push(id);
    });
    return order;
  }

  function moveMachine(id, dir) {
    var order = currentOrderForEdit();
    var i = order.indexOf(id);
    if (i === -1) return;
    var j = i + dir;
    if (j < 0 || j >= order.length) return;
    order.splice(j, 0, order.splice(i, 1)[0]);
    cfg.machines = order;
    if (window.__VMC_TV_CFG_SAVE__) window.__VMC_TV_CFG_SAVE__({ machines: order }, panelScope);
    applyFleetLayout();
    renderMachineList();
  }

  function toggleMachine(id, on) {
    var ex = cfg.exclude.slice();
    var i = ex.indexOf(id);
    if (on && i !== -1) ex.splice(i, 1);
    if (!on && i === -1) ex.push(id);
    cfg.exclude = ex;
    if (window.__VMC_TV_CFG_SAVE__) window.__VMC_TV_CFG_SAVE__({ exclude: ex }, panelScope);
    cardPage = 0;
    rebuildAndRun(false);
    renderMachineList();
  }

  // ---------------------------------------------------------------- exit path

  function leaveWallSkin() {
    // Exit means "leave the wall skin", not "close the browser": the window was
    // opened by the Windows shell URL association, so it has no opener and
    // window.close() is silently ignored.
    //
    // And it cannot be done by un-skinning this page. kiosk.rs's strip() hides
    // `.godnav, .topbar .cfg-btn` with no data-tv guard, and its
    // MutationObserver re-applies inline display:none on every mutation and is
    // never disconnected -- so removing data-tv would leave the nav and the
    // gear permanently hidden. It has to be a navigation.
    //
    // The double slash is deliberate. is_kiosk_path matches exact strings, and
    // router.rs trims leading slashes before resolving the file -- so
    // `//index.html` serves index.html WITHOUT the kiosk injection, on this
    // board's own port. That avoids guessing the dashboard's port, which is
    // declared in four independent places and gets remapped by the installer
    // wizard when 9991 is taken.
    var target = window.location.origin + "//index.html";
    try {
      window.location.href = target;
    } catch (_) {
      // Never a <form>: index.html's CSP sets form-action 'self'.
      window.location.assign(target);
    }
  }

  // ------------------------------------------------------------------- reveal

  var hideTimer = null;

  function showPanel() {
    var wrap = document.getElementById("tvControls");
    if (!wrap) return;
    wrap.hidden = false;
    document.documentElement.setAttribute("data-tv-panel", "1");
    renderMachineList();
    updateStatus();
    armAutoHide();
  }

  function hidePanel() {
    var wrap = document.getElementById("tvControls");
    if (!wrap) return;
    wrap.hidden = true;
    document.documentElement.removeAttribute("data-tv-panel");
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  function armAutoHide() {
    if (hideTimer) clearTimeout(hideTimer);
    // A panel left open on a wall board is chrome nobody asked for. But the
    // countdown restarts on every interaction (see wirePanel), or it closes
    // itself while someone is halfway through reordering the fleet.
    hideTimer = setTimeout(hidePanel, 45000);
  }

  function panelOpen() {
    var wrap = document.getElementById("tvControls");
    return wrap && !wrap.hidden;
  }

  function buildHotspot() {
    // A deliberately small, unlabelled corner target. On a touchscreen it is a
    // tap; with a mouse it is a click. It carries no text, so it reads as part
    // of the bezel from across the floor.
    var hs = document.createElement("button");
    hs.type = "button";
    hs.id = "tvHotspot";
    hs.className = "tv-hotspot";
    hs.setAttribute("aria-label", "TV board settings");
    hs.addEventListener("click", function () {
      if (panelOpen()) hidePanel(); else showPanel();
    });
    document.body.appendChild(hs);
  }

  // Always-visible Settings + Exit. The corner hotspot and the `s`/`x` keys are
  // invisible affordances: on a wall-mounted panel with no keyboard, and in the
  // timeline view where the card grid is not even on screen, there was no way
  // out and no way in that anyone could SEE. These two buttons are that way.
  //
  // Mounted on <body>, never inside <header class="topbar">: kiosk.rs runs a
  // MutationObserver that re-applies display:none to `.godnav, .topbar .cfg-btn`
  // on every mutation and never disconnects, so anything in the topbar (or
  // carrying cfg-btn) would be unkillably hidden. Same reason #tvControls lives
  // outside the header.
  function buildWallControls() {
    var bar = document.createElement("div");
    bar.id = "tvWallBar";
    bar.className = "tv-wallbar";

    var cfgBtn = document.createElement("button");
    cfgBtn.type = "button";
    cfgBtn.className = "tv-wallbtn";
    cfgBtn.id = "tvWallSettings";
    cfgBtn.textContent = "⚙ Settings";
    cfgBtn.title = "Wall board settings (s)";
    cfgBtn.addEventListener("click", function () {
      if (panelOpen()) hidePanel(); else showPanel();
    });

    var exitBtn = document.createElement("button");
    exitBtn.type = "button";
    exitBtn.className = "tv-wallbtn";
    exitBtn.id = "tvWallExit";
    exitBtn.textContent = "✕ Exit";
    exitBtn.title = "Leave the wall board and return to the dashboard (x)";
    exitBtn.addEventListener("click", function () {
      // Drop the browser fullscreen frame first, or the dashboard loads still
      // pinned fullscreen with no chrome and the operator looks stuck again.
      try { if (document.fullscreenElement) document.exitFullscreen(); } catch (_) {}
      leaveWallSkin();
    });

    bar.appendChild(cfgBtn);
    bar.appendChild(exitBtn);
    document.body.appendChild(bar);
  }

  function wireKeys() {
    document.addEventListener("keydown", function (ev) {
      // Ignore keystrokes aimed at the panel's own inputs.
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
        case " ":
          // Freeze on the current view so someone can actually read a card.
          ev.preventDefault();
          setPaused(!paused);
          break;
        case "ArrowRight":
          runStep(stepIdx + 1);
          break;
        case "ArrowLeft":
          runStep(stepIdx - 1);
          break;
        case "Escape":
          if (panelOpen()) hidePanel();
          else if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (_) {} }
          break;
        case "x":
        case "X":
          leaveWallSkin();
          break;
        default:
          break;
      }
    });
  }

  // -------------------------------------------------------------------- zoom

  function applyZoom() {
    var z = Number(cfg.zoom);
    if (!isFinite(z) || z <= 0) {
      // Auto. The board's type is fluid clamp() with rem ceilings, so on a
      // wider panel every size pins to its ceiling while the pixels get
      // smaller -- a 4K wall renders the board PHYSICALLY smaller than the same
      // 1080p panel did. Scaling by viewport width against a 1920 baseline
      // cancels that out, and leaves 1080p exactly as it is today.
      var w = window.innerWidth || 1920;
      z = w >= 3000 ? 1.8 : w >= 2400 ? 1.4 : 1;
    }
    // `zoom`, not a root font-size bump: this app has fluid clamp() type in
    // cards.css, hard px in godmode.css, and canvas text drawn at 11px in
    // timeline.js. A font-size change reaches only the first of those three,
    // which would leave the timeline half of the rotation visibly broken.
    // `zoom` scales layout boxes, hard px and canvas backing store alike.
    document.documentElement.style.zoom = z === 1 ? "" : String(z);
  }

  // -------------------------------------------------------------------- boot

  function migrateLegacy() {
    // The old key held a dwell that never actually applied (see header note 1).
    // Carry it across so a board someone set to 30s finally becomes 30s,
    // instead of silently staying at the hardcoded 10s.
    try {
      var old = localStorage.getItem(LEGACY_LS_KEY);
      if (!old) return;
      var ms = parseSeconds(old);
      localStorage.removeItem(LEGACY_LS_KEY);
      if (ms === null) return;
      var saved = JSON.parse(localStorage.getItem("vmc_tv_cfg") || "{}");
      if (saved && saved.interval !== undefined) return; // already migrated
      cfg.interval = ms;
      cfg.playlist = (cfg.playlist || []).map(function (s) {
        return { view: s.view, dwell: ms };
      });
      if (window.__VMC_TV_CFG_SAVE__) {
        window.__VMC_TV_CFG_SAVE__({ interval: ms, playlist: cfg.playlist });
      }
    } catch (_) {}
  }

  function boot() {
    document.documentElement.setAttribute("data-tv-ready", "1");
    if (!cfg.chrome) document.documentElement.setAttribute("data-tv-bare", "1");

    migrateLegacy();
    applyZoom();
    buildClock();
    buildPanel();
    buildHotspot();
    buildWallControls();
    wireKeys();

    window.addEventListener("vmc-overview", onOverview);
    window.addEventListener("resize", applyZoom);

    rebuildAndRun(false);

    // app.js re-renders the grid on every 1s poll and re-forces DOM order, so
    // reapply layout after each paint cycle even when no payload changed shape.
    setInterval(function () {
      if (view === "cards") applyFleetLayout();
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // Debug / test surface.
  window.__VMC_TV__ = true;
  window.__VMC_TV_API__ = {
    next: function () { runStep(stepIdx + 1); },
    prev: function () { runStep(stepIdx - 1); },
    pause: function () { setPaused(true); },
    resume: function () { setPaused(false); },
    steps: function () { return steps.slice(); },
    fleet: function () { return orderedFleet(); },
    cfg: function () { return cfg; },
    exit: leaveWallSkin,
    parseSeconds: parseSeconds,
  };
})();
