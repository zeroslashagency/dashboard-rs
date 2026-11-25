/* VMC TV Wall Board — configuration layer.
 *
 * Three sources, each overriding the one before it:
 *
 *   1. DEFAULTS below            — what a fresh board does with no setup at all.
 *   2. URL query params          — ?rot=15&m=VMC-02,VMC-05&tz=Asia/Bangkok
 *   3. localStorage              — what the walk-up panel saved on this display.
 *
 * Why this order. Layer 1 is the only one that survives a browser-profile wipe,
 * so it has to be a sane board on its own. Layer 2 is origin-independent, which
 * means an admin can preview the exact wall config from a laptop by pasting a
 * URL -- localStorage cannot do that, because it is keyed per-origin AND
 * per-profile, so a setting saved at localhost:9995 is invisible at
 * <lan-ip>:9995. Layer 3 wins because it is the operator standing at the board,
 * and the operator standing at the board should win.
 *
 * This ships as a plain <script> that declares a global rather than a JSON file
 * fetched at runtime. Two reasons: it matches the precedent /config.js already
 * sets in this app (router.rs:16), and it needs no connect-src entry, so it
 * keeps working if the CSP in index.html is ever tightened.
 *
 * Deployment note: this file is part of web/, which router.rs reads from disk on
 * every request with Cache-Control: no-store. Editing it on the box takes effect
 * on the next reload -- no rebuild, no service restart. But note that
 * vmc-platform.iss:52 copies build\app\* with `ignoreversion recursesubdirs`,
 * so an upgrade WILL overwrite this file. A site that tunes it should keep a
 * copy outside {app}.
 */
(function () {
  "use strict";

  var DEFAULTS = {
    // ---- rotation ----------------------------------------------------------
    // Dwell per step, in ms. Uniform 20s across the rotation; each playlist
    // step can still override this, which is only the fallback.
    interval: 15000,

    // The rotation itself. Each step is a view plus an optional dwell.
    // `cards` paginates the fleet when perPage > 0; `timeline` is the godmode
    // timeline lane view, pinned to Hour + live with the wall fleet while the
    // step shows (tv.js drives timeline.js via window.__VMC_TIMELINE__).
    // Dwell is uniform (20s) across the rotation by operator decision.
    // Views are mounted by clicking their godmode tab,
    // which is the only mount path in -- godmode.js keeps activate() private.
    playlist: [
      { view: "cards", dwell: 20000 },
      { view: "timeline", dwell: 20000 },
    ],

    // ---- fleet -------------------------------------------------------------
    // Explicit machine order. Ids not listed here render after the listed ones,
    // in whatever order the collector sent them, so adding a seventh machine to
    // the fleet never makes it silently invisible.
    machines: [],

    // Machines never to show. Kept separate from `machines` so that reordering
    // and excluding are independent decisions.
    exclude: [],

    // Cards shown per page, 0 = all of them on one page. At 1080p only one row
    // of cards fits the viewport, so six-at-once is not actually available
    // there -- 3 is the honest default. At 4K, 0 (all) is legible.
    perPage: 3,

    // Skip machines whose feed is dead rather than showing a card full of
    // confident zeros. A dead feed still gets a one-line strip naming it, so
    // "broken" never silently becomes "absent".
    skipDead: false,

    // ---- clock -------------------------------------------------------------
    showClock: true,

    // IANA zone for the wall clock. Display only -- this does NOT move shift
    // boundaries, which are computed server-side in C++ at a fixed +05:30
    // (api_server.cpp, store.cpp) and arrive already labelled.
    tz: "Asia/Bangkok",

    // Shown next to the time. Without it, 19:42 beside a shift that started at
    // "22:00" reads as a bug rather than as two different timezones.
    tzLabel: "BKK",

    // Second clock, in the zone the shifts actually follow. Off by default;
    // turn it on where operators reason in both zones.
    showShiftClock: false,
    shiftTz: "Asia/Kolkata",
    shiftTzLabel: "IST",

    // ---- presentation ------------------------------------------------------
    // Whole-board scale. `zoom` scales layout boxes, hard px values AND canvas
    // backing stores together, which a root font-size bump cannot do: this app
    // has fluid clamp() type in cards.css, hard px in godmode.css, and canvas
    // text drawn at 11px in timeline.js. Those three need one lever, not three.
    // 0 = auto: derived from viewport width so a 4K panel does not render the
    // board physically smaller than the same 1080p panel did.
    zoom: 0,

    // Hide the footer and trim the header to a wall-appropriate strip.
    chrome: false,
  };

  function readParams() {
    var out = {};
    var q;
    try {
      q = new URLSearchParams(window.location.search);
    } catch (_) {
      return out;
    }

    function num(key, into) {
      var v = q.get(key);
      if (v === null || v === "") return;
      var n = Number(v);
      if (isFinite(n)) out[into] = n;
    }
    function bool(key, into) {
      var v = q.get(key);
      if (v === null) return;
      // Accept 0/1, true/false, yes/no -- a wall URL gets hand-edited.
      out[into] = !(v === "0" || v === "false" || v === "no" || v === "");
    }
    function list(key, into) {
      var v = q.get(key);
      if (v === null || v === "") return;
      out[into] = v
        .split(",")
        .map(function (s) { return s.trim().toUpperCase(); })
        .filter(Boolean);
    }

    // ?rot=15 is friendlier to type on a shortcut than ?rot=15000, so accept
    // seconds and normalise. Anything under 1000 is read as seconds.
    var rot = q.get("rot");
    if (rot !== null && rot !== "") {
      var r = Number(rot);
      if (isFinite(r) && r > 0) out.interval = r < 1000 ? r * 1000 : r;
      else if (r === 0) out.interval = 0;
    }

    num("perPage", "perPage");
    num("zoom", "zoom");
    bool("clock", "showClock");
    bool("chrome", "chrome");
    bool("skipDead", "skipDead");
    bool("bothClocks", "showShiftClock");
    list("m", "machines");
    list("exclude", "exclude");

    var tz = q.get("tz");
    if (tz) {
      // An unknown IANA zone makes Intl throw RangeError, which would take the
      // whole board down on a typo. Validate before accepting it.
      if (isValidZone(tz)) {
        out.tz = tz;
        // Derive a label from the city so ?tz=Asia/Bangkok alone is enough.
        var label = q.get("tzLabel");
        out.tzLabel = label || zoneAbbrev(tz);
      } else if (window.console) {
        console.warn("[tv-config] ignoring unknown timeZone: " + tz);
      }
    } else if (q.get("tzLabel")) {
      out.tzLabel = q.get("tzLabel");
    }

    // A whole playlist in a URL, e.g. ?views=cards:20,timeline:30
    var views = q.get("views");
    if (views) {
      var steps = views
        .split(",")
        .map(function (spec) {
          var bits = spec.split(":");
          var view = (bits[0] || "").trim();
          if (!view) return null;
          var d = Number(bits[1]);
          var step = { view: view };
          if (isFinite(d) && d > 0) step.dwell = d < 1000 ? d * 1000 : d;
          return step;
        })
        .filter(Boolean);
      if (steps.length) out.playlist = steps;
    }

    return out;
  }

  function isValidZone(tz) {
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: tz });
      return true;
    } catch (_) {
      return false;
    }
  }

  function zoneAbbrev(tz) {
    var city = String(tz).split("/").pop() || tz;
    return city.replace(/_/g, " ").slice(0, 3).toUpperCase();
  }

  var GLOBAL_KEY = "vmc_tv_global_cfg";
  var DEVICE_KEY = "vmc_tv_cfg";

  function readSaved(scope) {
    try {
      var raw = localStorage.getItem(scope === "global" ? GLOBAL_KEY : DEVICE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      // Corrupt or unreadable storage must not take the wall board down.
      return {};
    }
  }

  function merge() {
    var out = {};
    for (var i = 0; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) {
          out[k] = src[k];
        }
      }
    }
    return out;
  }

  var cfg = {};

  function resolveCfg() {
    var next = merge(DEFAULTS, readParams(), readSaved("global"), readSaved("device"));
    for (var key in cfg) {
      if (Object.prototype.hasOwnProperty.call(cfg, key)) delete cfg[key];
    }
    for (var name in next) {
      if (Object.prototype.hasOwnProperty.call(next, name)) cfg[name] = next[name];
    }
    return cfg;
  }

  resolveCfg();

  // Re-validate after the localStorage layer: a zone saved by an older build,
  // or hand-edited storage, can still be junk.
  if (!isValidZone(cfg.tz)) cfg.tz = DEFAULTS.tz;
  if (!isValidZone(cfg.shiftTz)) cfg.shiftTz = DEFAULTS.shiftTz;
  if (!Array.isArray(cfg.machines)) cfg.machines = [];
  if (!Array.isArray(cfg.exclude)) cfg.exclude = [];
  if (!Array.isArray(cfg.playlist) || !cfg.playlist.length) {
    cfg.playlist = DEFAULTS.playlist;
  }
  if (!isFinite(cfg.perPage) || cfg.perPage < 0) cfg.perPage = DEFAULTS.perPage;

  cfg.machines = cfg.machines.map(function (s) { return String(s).toUpperCase(); });
  cfg.exclude = cfg.exclude.map(function (s) { return String(s).toUpperCase(); });

  window.__VMC_TV_CFG__ = cfg;
  window.__VMC_TV_CFG_DEFAULTS__ = DEFAULTS;

  // Persist a patch in the selected scope. Device overrides win at render.
  window.__VMC_TV_CFG_SAVE__ = function (patch, scope) {
    try {
      var key = scope === "global" ? GLOBAL_KEY : DEVICE_KEY;
      var next = merge(readSaved(scope === "global" ? "global" : "device"), patch);
      localStorage.setItem(key, JSON.stringify(next));
      resolveCfg();
      return true;
    } catch (_) {
      return false;
    }
  };

  window.__VMC_TV_CFG_SCOPE__ = function (scope) {
    return readSaved(scope === "global" ? "global" : "device");
  };

  window.__VMC_TV_CFG_RESET__ = function (scope) {
    try {
      localStorage.removeItem(scope === "global" ? GLOBAL_KEY : DEVICE_KEY);
      if (scope !== "global") {
        // The pre-Slice key from the original tv.js, removed so a stale 10s dwell
        // cannot outlive a reset.
        localStorage.removeItem("vmc_tv_interval");
      }
      return true;
    } catch (_) {
      return false;
    }
  };
})();
