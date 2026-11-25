/* VMC Sequence Monitor — isolated frontend.
 * Driven entirely by the sequence-method collector's GET /api/overview.
 * Front/back fully separate: configure API base via the ⚙ button (stored in localStorage).
 */

/* Collector runs on the SAME host that serves this dashboard, on port 8091.
 * Derive the base from the page's own hostname so it works whether the board is
 * opened locally (127.0.0.1) or over the LAN/Tailscale (e.g. 100.72.103.1). A
 * file:// open with no hostname falls back to 127.0.0.1. The ⚙ override still
 * wins via localStorage. */
const COLLECTOR_PORT = (typeof window !== "undefined" && window.__VMC_COLLECTOR_PORT__) || 9994;
const DEFAULT_API = (() => {
  const h = (typeof location !== "undefined" && location.hostname) ? location.hostname : "127.0.0.1";
  return `http://${h}:${COLLECTOR_PORT}`;
})();
const POLL_MS = 1000;
/* /api/overview does heavy per-request aggregation and can take 3-13s on a slow
 * link. The old abort (POLL_MS+1500 = 2500ms) fired before it could ever answer,
 * so the grid stayed permanently empty. Give it a real ceiling. */
const OVERVIEW_TIMEOUT_MS = 15000;
/* Last good overview payload, persisted so a cold reload / slow first fetch
 * paints the cards instantly instead of an empty board. */
const LS_DASH_SNAP = "vmc_dash_snap_v1";
function loadDashSnap() {
  try {
    const raw = localStorage.getItem(LS_DASH_SNAP);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return (o && Array.isArray(o.machines)) ? o : null;
  } catch (_) { return null; }
}
function saveDashSnap(data) {
  try { localStorage.setItem(LS_DASH_SNAP, JSON.stringify(data)); } catch (_) {}
}

/* Per-device dashboard prefs. The 9991/9995 servers are static-only (no
 * writable endpoint), so card + display choices live in localStorage.
 *
 * TWO SCOPES, one effective object:
 *   GLOBAL  (vmc_dash_global_v2)  — the base look every mode on THIS device
 *                                   inherits; exportable to copy to other TVs.
 *   DEVICE  (vmc_dash_device_v2)  — sparse overrides for the screen you are at;
 *                                   any key present here wins over global.
 * Effective = DEFAULTS <- GLOBAL <- DEVICE. The rest of the app reads the
 * resolved `dashPrefs` object exactly as before, so no read site changes.
 * A true cross-display global needs a writable endpoint (none exists by
 * design); export/import is how one profile spreads to other boards. */
const LS_DASH_PREFS = "vmc_dash_prefs_v1";      // legacy, read once for migration
const LS_DASH_GLOBAL = "vmc_dash_global_v2";
const LS_DASH_DEVICE = "vmc_dash_device_v2";
const DASH_PREFS_DEFAULTS = {
  toolpath: "off",
  shiftArt: true,
  compactTimings: true,
  rankedCounts: true,
  // Spindle row right side: false = RPM history graph, true = this machine's part count.
  spindleParts: false,
  previewSections: { summary: true, shifts: true },
  // Fullscreen wall paging. perPage 0 = all cards on one page (no rotation).
  // rotateMs 0 = hold the current page (no auto-switch). Only takes effect in
  // dashboard fullscreen; the standalone 9995 wall board runs its own engine.
  wallPerPage: 0,
  wallRotateMs: 0,
  // Preview Fullscreen — the presentation ("PPT") mode: cards only, an intro
  // screen, and slide transitions on a timer. Its own settings so it can differ
  // from the plain fullscreen wall above.
  previewPerPage: 3,
  previewRotateMs: 15000,
  previewTransition: "fade",     // fade | slide | none
  previewIntro: true,            // show the loading/intro screen on start
  previewTitle: "VMC SEQUENCE MONITOR",
  previewDots: true,             // deck-style page progress dots
  // Whole-board scale for fullscreen/preview. 0 = auto (by viewport width).
  boardZoom: 0,
};
const WALL_PER_PAGE_CHOICES = [0, 2, 3, 4, 6];
const WALL_ROTATE_CHOICES = [0, 10000, 15000, 20000, 30000, 60000];
const PREVIEW_PER_PAGE_CHOICES = [2, 3, 4, 6];
const PREVIEW_ROTATE_CHOICES = [0, 10000, 15000, 20000, 30000, 60000];
const PREVIEW_TRANSITION_CHOICES = ["fade", "slide", "none"];
const BOARD_ZOOM_CHOICES = [0, 1, 1.25, 1.5, 1.75, 2];
/* Which keys are booleans / enums / numbers, for validated sparse merges. */
const PREF_BOOL_KEYS = ["shiftArt", "compactTimings", "rankedCounts", "spindleParts", "previewIntro", "previewDots"];
function freshDashPrefs() {
  return JSON.parse(JSON.stringify(DASH_PREFS_DEFAULTS));
}
/* Validate an arbitrary object into a sparse patch of known prefs. Unknown or
 * malformed keys are dropped, so hand-edited or older storage can never inject
 * junk into the effective object. Returns only the keys actually present. */
function sanitizePrefPatch(o) {
  const p = {};
  if (!o || typeof o !== "object") return p;
  if (o.toolpath === "on" || o.toolpath === "off") p.toolpath = o.toolpath;
  for (const k of PREF_BOOL_KEYS) if (typeof o[k] === "boolean") p[k] = o[k];
  if (o.previewSections && typeof o.previewSections === "object") {
    const ps = {};
    for (const k of ["summary", "shifts"]) {
      if (typeof o.previewSections[k] === "boolean") ps[k] = o.previewSections[k];
    }
    if (Object.keys(ps).length) p.previewSections = ps;
  }
  if (WALL_PER_PAGE_CHOICES.indexOf(Number(o.wallPerPage)) !== -1) p.wallPerPage = Number(o.wallPerPage);
  if (WALL_ROTATE_CHOICES.indexOf(Number(o.wallRotateMs)) !== -1) p.wallRotateMs = Number(o.wallRotateMs);
  if (PREVIEW_PER_PAGE_CHOICES.indexOf(Number(o.previewPerPage)) !== -1) p.previewPerPage = Number(o.previewPerPage);
  if (PREVIEW_ROTATE_CHOICES.indexOf(Number(o.previewRotateMs)) !== -1) p.previewRotateMs = Number(o.previewRotateMs);
  if (PREVIEW_TRANSITION_CHOICES.indexOf(o.previewTransition) !== -1) p.previewTransition = o.previewTransition;
  if (typeof o.previewTitle === "string") p.previewTitle = o.previewTitle.slice(0, 60);
  if (BOARD_ZOOM_CHOICES.indexOf(Number(o.boardZoom)) !== -1) p.boardZoom = Number(o.boardZoom);
  return p;
}
function readScope(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    return sanitizePrefPatch(JSON.parse(raw));
  } catch (_) { return {}; }
}
/* Deep-ish merge: previewSections merges key-by-key; everything else replaces. */
function mergePrefs(base, patch) {
  const out = JSON.parse(JSON.stringify(base));
  for (const k in patch) {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
    if (k === "previewSections" && patch[k] && typeof patch[k] === "object") {
      out.previewSections = Object.assign({}, out.previewSections, patch[k]);
    } else {
      out[k] = patch[k];
    }
  }
  return out;
}
let dashGlobal = {};   // sparse patch over defaults
let dashDevice = {};   // sparse patch over global
let dashPrefs = freshDashPrefs();  // resolved effective object (what the app reads)
/* One-time migration: fold a legacy vmc_dash_prefs_v1 blob into GLOBAL so an
 * upgraded board keeps its look, then leave the old key in place (harmless). */
function migrateLegacyPrefs() {
  try {
    if (localStorage.getItem(LS_DASH_GLOBAL) || localStorage.getItem(LS_DASH_DEVICE)) return;
    const raw = localStorage.getItem(LS_DASH_PREFS);
    if (!raw) return;
    const patch = sanitizePrefPatch(JSON.parse(raw));
    if (Object.keys(patch).length) localStorage.setItem(LS_DASH_GLOBAL, JSON.stringify(patch));
  } catch (_) {}
}
function resolveDashPrefs() {
  dashGlobal = readScope(LS_DASH_GLOBAL);
  dashDevice = readScope(LS_DASH_DEVICE);
  dashPrefs = mergePrefs(mergePrefs(freshDashPrefs(), dashGlobal), dashDevice);
  return dashPrefs;
}
migrateLegacyPrefs();
resolveDashPrefs();
/* Scope the settings panel is currently editing. Device wins at render time
 * regardless; this only decides which layer a change writes to. */
let dashScope = "global";
function scopeStoreKey() { return dashScope === "device" ? LS_DASH_DEVICE : LS_DASH_GLOBAL; }
function scopePatch() { return dashScope === "device" ? dashDevice : dashGlobal; }
/* Write one key into the active scope, re-resolve, and persist. previewSections
 * sub-keys are addressed as "previewSections.summary". */
function setPrefForScope(scope, key, value) {
  const patch = Object.assign({}, scope === "device" ? dashDevice : dashGlobal);
  if (key.indexOf("previewSections.") === 0) {
    const sub = key.slice("previewSections.".length);
    patch.previewSections = Object.assign({}, patch.previewSections, { [sub]: value });
  } else {
    patch[key] = value;
  }
  try {
    localStorage.setItem(scope === "device" ? LS_DASH_DEVICE : LS_DASH_GLOBAL,
      JSON.stringify(sanitizePrefPatch(patch)));
  } catch (_) {}
  resolveDashPrefs();
}
function setPref(key, value) {
  setPrefForScope(dashScope, key, value);
}
/* Back-compat shim: older call sites do `dashPrefs.x = v; saveDashPrefs()`.
 * saveDashPrefs() now persists the whole resolved object as the active scope's
 * patch (validated), so those call sites keep working during the transition. */
function saveDashPrefs() {
  try { localStorage.setItem(scopeStoreKey(), JSON.stringify(sanitizePrefPatch(dashPrefs))); } catch (_) {}
  resolveDashPrefs();
}
/* Clear this display's overrides so it falls back to the global profile. */
function clearDeviceOverrides() {
  try { localStorage.removeItem(LS_DASH_DEVICE); } catch (_) {}
  resolveDashPrefs();
}
/* Card-level flags as DOM state so CSS follows without per-card writes. */
function applyPrefsToDom() {
  const h = document.documentElement;
  h.dataset.toolpath = dashPrefs.toolpath === "on" ? "on" : "off";
  h.dataset.shiftArt = dashPrefs.shiftArt ? "on" : "off";
  h.dataset.compactTimings = dashPrefs.compactTimings ? "on" : "off";
  h.dataset.rankedCounts = dashPrefs.rankedCounts ? "on" : "off";
  h.dataset.spindleParts = dashPrefs.spindleParts ? "on" : "off";
  h.dataset.summary = dashPrefs.previewSections.summary ? "on" : "off";
  h.dataset.shifts = dashPrefs.previewSections.shifts ? "on" : "off";
}
applyPrefsToDom();

window.__VMC_DASH_SETTINGS__ = {
  effective: () => dashPrefs,
  patch: (scope) => scope === "device" ? dashDevice : dashGlobal,
  set: (scope, key, value) => {
    setPrefForScope(scope === "device" ? "device" : "global", key, value);
    applyPrefsToDom();
    applyCardPrefs();
  },
  reset: (scope) => {
    try { localStorage.removeItem(scope === "device" ? LS_DASH_DEVICE : LS_DASH_GLOBAL); } catch (_) {}
    resolveDashPrefs();
    applyPrefsToDom();
    applyCardPrefs();
  },
  export: () => exportDashProfile(),
  import: (noteEl) => importDashProfile(noteEl),
};

const state = {
  apiBase: localStorage.getItem("vmc_api_base") || DEFAULT_API,
  timer: null,
  inFlight: false,
  failStreak: 0,
};
/* Static page nodes, looked up once at boot instead of every poll. */
const dom = {};
function cacheDom() {
  dom.grid = document.getElementById("machineGrid");
  dom.note = document.getElementById("emptyNote");
  dom.updatedAt = document.getElementById("updatedAt");
  dom.conn = document.getElementById("conn");
  dom.connText = document.getElementById("connText");
}

/* ---------- formatting helpers ---------- */
function fmtNum(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return Number(value).toFixed(digits);
}

function fmtInt(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return String(Math.round(Number(value)));
}

/* override percentage: "100%" when present, "—" when the field is missing
 * (so an absent override never renders as the ugly "—%"). */
function fmtPct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return `${Math.round(Number(value))}%`;
}

/* Toggle the off-nominal warning state on an override pill. 100% (or unknown) is
 * normal; anything else — 99, 50, 120 — is dialed off and gets the blinking
 * yellow treatment via the .ovr-warn class. */
function setOvrWarn(pill, value) {
  if (!pill) return;
  const n = Number(value);
  const warn = Number.isFinite(n) && Math.round(n) !== 100;
  if (pill.classList.contains("ovr-warn") !== warn) pill.classList.toggle("ovr-warn", warn);
}

/* seconds -> M:SS (or H:MM:SS). Returns "—" for missing values. */
function fmtClock(sec) {
  if (sec === null || sec === undefined || Number.isNaN(Number(sec))) return "—";
  let s = Math.max(0, Math.round(Number(sec)));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
/* seconds -> compact 06H 35M 42S with zero units dropped (04S, 06H 11S).
 * All-zero reads "—". Visible labels only; tooltips keep full HHMMSS. */
function fmtClockCompact(sec) {
  if (sec === null || sec === undefined || Number.isNaN(Number(sec))) return "—";
  const total = Math.max(0, Math.round(Number(sec)));
  if (total <= 0) return "—";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (h > 0) parts.push(`${String(h).padStart(2, "0")}H`);
  if (m > 0) parts.push(`${String(m).padStart(2, "0")}M`);
  parts.push(`${String(s).padStart(2, "0")}S`);
  return parts.join(" ");
}
/* seconds -> 02H 15M 33S always padded (for shift guard). */
function fmtClockHHMMSS(sec) {
  if (sec === null || sec === undefined || Number.isNaN(Number(sec))) return "—";
  let s = Math.max(0, Math.round(Number(sec)));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  return `${String(h).padStart(2, "0")}H ${String(m).padStart(2, "0")}M ${String(s).padStart(2, "0")}S`;
}
/* Visible shift durations honour the compact-timings pref; tooltips keep HHMMSS. */
function fmtShiftDur(sec) {
  return dashPrefs.compactTimings ? fmtClockCompact(sec) : fmtClockHHMMSS(sec);
}

/* Session chips: "01H 08M" — hours and minutes only. Seconds are deliberately
 * omitted (too long for the chip); minutes always shown, never dropped. */
function fmtSessHM(sec) {
  if (sec === null || sec === undefined || Number.isNaN(Number(sec))) return "—";
  const total = Math.max(0, Math.floor(Number(sec) / 60));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}H ${String(total % 60).padStart(2, "0")}M`;
}

/* ===== data freshness =====
 * The collector reports, per machine:
 *   data_age_sec  SECONDS (fractional) since it last stored a row, or null = never
 *   freshness     "fresh" (<5s) | "lagging" (5-30s) | "stale" (30s-5min) | "dead" (>5min/never)
 *   clock_quality "trusted" | "suspect" | "clock_unset"
 *   machine_ts    MILLISECONDS, the controller's OWN claimed time, or null
 *   last_seen_ms  MILLISECONDS, the collector's clock at last write, or null
 * Units are never mixed: only data_age_sec is seconds, everything *_ms is ms.
 * Thresholds live here so the badge and the "may the timers tick" gate can
 * never disagree. */
const FRESHNESS_LAG_SEC = 5;
const FRESHNESS_STALE_SEC = 30;
const FRESHNESS_DEAD_SEC = 300;

/* seconds -> coarse human duration ("15h 22m", "4m 09s", "45s").
 * A dead feed has to read as severe at a glance; "55320s" does not. */
function fmtAgeDuration(sec) {
  if (sec === null || sec === undefined || Number.isNaN(Number(sec))) return "—";
  const total = Math.max(0, Math.round(Number(sec)));
  if (total < 60) return `${total}s`;
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${String(h).padStart(2, "0")}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/* Stop counter: seconds -> human-friendly duration ("5m", "45m", "2h 15m", "1d 3h").
 * Deliberately coarse — on a wall board the minute is the actionable unit, and
 * a ticking seconds field reads as noise from ten metres away. */
function fmtIdleDuration(sec) {
  if (sec === null || sec === undefined || Number.isNaN(Number(sec))) return "—";
  const total = Math.max(0, Math.round(Number(sec)));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/* Read an epoch stamp that is SUPPOSED to be milliseconds, defensively.
 * The collector used to emit updated_at in SECONDS while this file fed it to
 * new Date(), which is a milliseconds API — so the footer clock rendered 1970
 * for months. The API now sends ms, but a stale collector binary in the field
 * would resurrect that bug, so: any positive value below 1e12 ms (Sep 2001)
 * cannot be a real epoch-ms stamp for this product and is treated as seconds.
 * NOTE: never route machine_ts through this. An unset controller RTC honestly
 * reports a tiny near-zero ms value, and scaling that would fabricate a date. */
function msFromEpochLoose(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (Number.isFinite(n)) {
    if (n <= 0) return null;
    // >= 1e12 is already a sane epoch-ms stamp (Sep 2001 onward): pass through.
    if (n >= 1e12) return n;
    // 1e9..1e12 is a plausible epoch-SECONDS stamp (Sep 2001 onward): rescale.
    if (n >= 1e9) return n * 1000;
    // Anything smaller is neither; scaling it would only fabricate a date.
    return null;
  }
  // The legacy Python collector (apps/collector) still sends updated_at as an
  // ISO-8601 string, which the old `new Date(...)` call handled — keep parsing it
  // so pointing this dashboard at the older backend does not blank the footer.
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/* Resolve a machine's data freshness into { tier, ageSec }.
 * Prefers the collector's own `freshness` verdict, then derives the tier from
 * data_age_sec, then falls back to last_seen_ms against the browser clock, so
 * an older collector degrades to a best effort instead of a blank badge.
 * Returns tier "unknown" when nothing at all was reported — never a guess of
 * "fresh", because guessing fresh is exactly the bug this replaces. */
function readFreshness(m) {
  const raw = m && typeof m.freshness === "string" ? m.freshness.toLowerCase() : "";
  // data_age_sec === null means "never heard from", and Number(null) is 0 — so a
  // bare Number() here would report a dead machine as 0.0s old and tier it as
  // FRESH, which is the exact lie this whole badge exists to kill. Reject
  // null/undefined explicitly before coercing, like fmtClock/fmtInt do.
  const ageMissing = !m || m.data_age_sec === null || m.data_age_sec === undefined;
  const ageRaw = ageMissing ? NaN : Number(m.data_age_sec);
  let ageSec = Number.isFinite(ageRaw) && ageRaw >= 0 ? ageRaw : null;
  if (ageSec == null && m && m.last_seen_ms !== null && m.last_seen_ms !== undefined) {
    // Last resort only: collector write clock vs this browser's clock (both ms).
    // Cross-box skew makes it approximate, so it never overrides data_age_sec.
    const seen = Number(m.last_seen_ms);
    if (Number.isFinite(seen) && seen > 0) ageSec = Math.max(0, (Date.now() - seen) / 1000);
  }
  // Never-heard-from wins over any tier guess: no age can be derived at all.
  const neverSeen = ageSec == null
    && m && m.data_age_sec === null
    && (m.last_seen_ms === null || m.last_seen_ms === undefined);
  let tier;
  if (neverSeen) {
    tier = "dead";
  } else if (raw === "fresh" || raw === "lagging" || raw === "stale" || raw === "dead") {
    tier = raw;
  } else if (ageSec != null) {
    tier = ageSec < FRESHNESS_LAG_SEC ? "fresh"
      : ageSec < FRESHNESS_STALE_SEC ? "lagging"
      : ageSec < FRESHNESS_DEAD_SEC ? "stale"
      : "dead";
  } else if (m && m.data_age_sec === null) {
    tier = "dead";                 // explicit null = never heard from this machine
  } else {
    tier = "unknown";              // field absent entirely = pre-contract collector
  }
  return { tier, ageSec };
}

/* Recompute cycle progress on the client.
 * Backend leaves cycle_progress_pct null, so derive it from elapsed vs remaining:
 *   total = elapsed + remaining  ->  pct = elapsed / total
 * When stopped/idle (remaining 0) there is no live cycle to show. */
/* Cycle progress, derived from the collector's real field semantics.
 * Verified by live double-poll on an ACTIVE machine:
 *   this_cycle           = TOTAL/target cycle time (static during a cycle)
 *   remaining_cycle_time = time left (counts DOWN)
 *   last_cycle           = time elapsed this cycle (counts UP); last+remaining≈this_cycle
 * So elapsed = total - remaining, and pct = elapsed / total.
 * The backend leaves cycle_progress_pct null, hence the client-side derivation. */
function computeCycle(m) {
  const c = m.cycle || {};
  const totalRaw = Number(c.this_cycle);
  const remainingRaw = Number(c.remaining_cycle_time);
  const lastRaw = Number(c.last_cycle);
  const exec = String(m.execution || "").toUpperCase();
  const isRunningExec = (typeof RUNNING_EXECUTION !== "undefined" && RUNNING_EXECUTION.has)
    ? RUNNING_EXECUTION.has(exec)
    : exec === "ACTIVE" || exec === "RUNNING" || exec === "EXECUTING";
  const active = isRunningExec || String(m.status || "").toLowerCase() === "running";
  const spindle = Number(m.spindle_speed);
  const hasSpindle = Number.isFinite(spindle) && spindle > 0;
  const hasTotalRaw = Number.isFinite(totalRaw) && totalRaw > 0;
  const hasRemainingRaw = Number.isFinite(remainingRaw);
  const hasLast = Number.isFinite(lastRaw);
  // No spec fallback — total must come from real backend fields (native cyremtim/tcycle or per-program learned baseline).
  let total = hasTotalRaw ? totalRaw : null;
  let remaining = hasRemainingRaw ? remainingRaw : null;
  if (total == null && active) {
    const baseline = Number(c.baseline_s);
    const hasBaseline = Number.isFinite(baseline) && baseline > 0;
    const est = !!c.estimated;
    if (hasBaseline) {
      const n = Number(c.sample_n);
      const confident = !est || (Number.isFinite(n) && n >= 2);
      if (confident) total = baseline;
      else if (est && hasLast) total = null;
    }
    if (total != null && remaining == null && hasLast) remaining = Math.max(0, total - lastRaw);
  } else if (total != null && remaining == null && hasLast) {
    remaining = Math.max(0, total - lastRaw);
  }
  const hasTotal = Number.isFinite(total) && total > 0;
  const hasRemaining = Number.isFinite(remaining);
  let live = false;
  const estFlag = !!c.estimated;
  const sampleN = Number(c.sample_n);
  const confidentEst = !estFlag || (Number.isFinite(sampleN) && sampleN >= 2);
  if (active && hasTotal && confidentEst) {
    if (hasRemaining && remaining >= 0 && hasSpindle) live = true;
    else if (hasRemaining && remaining > 0) live = true;
    else if (hasSpindle) live = true;
    else if (estFlag) live = true;
  }
  let elapsed = null;
  if (hasLast) elapsed = lastRaw;
  else if (hasTotal && hasRemaining) elapsed = Math.max(0, total - remaining);
  else if (live && hasTotal) elapsed = 0;
  let pct = null;
  if (live && hasTotal) {
    if (hasRemaining) pct = Math.max(0, Math.min(100, ((total - remaining) / total) * 100));
    else if (Number.isFinite(elapsed)) pct = Math.max(0, Math.min(100, (elapsed / total) * 100));
  }
  return {
    live,
    overrun: !!c.overrun,
    elapsed,
    remaining,
    total,
    pct,
    estimated: estFlag,
    sample_n: Number.isFinite(sampleN) ? sampleN : 0,
    program: c.program || c.est_program || "",
  };
}

const STATUS_LABEL = {
  running: "RUNNING",
  idle: "IDLE",
  paused: "PAUSED",
  setup_manual: "MANUAL",
  alarm: "ALARM",
  e_stop: "E-STOP",
  offline: "OFFLINE",
  unavailable: "UNAVAIL",
  unknown: "UNKNOWN",
};

/* Re-derive machine status from REAL controller signals — no spindle guessing.
 *
 * The :8091 collector's top-level `status` field only ever surfaces
 * running / idle / offline; it does NOT report a pause. The genuine pause
 * signal is the MTConnect EXECUTION state the machine itself emits:
 *   ACTIVE                 -> running  (cutting / cycle in progress)
 *   FEED_HOLD / INTERRUPTED-> paused   (operator feed-hold or cycle-stop)
 *   PROGRAM_STOPPED/OPTIONAL_STOP -> paused (M00/M01 program hold)
 *   STOPPED / READY        -> trust the collector's status (idle/offline)
 *
 * So PAUSED triggers on a real feed-hold, not on low spindle RPM, and a
 * machine the controller reports ACTIVE always shows PRODUCTION. */
const RUNNING_EXECUTION = new Set(["ACTIVE", "EXECUTING", "RUNNING"]);
const PAUSED_EXECUTION = new Set([
  "FEED_HOLD", "INTERRUPTED", "PROGRAM_STOPPED", "OPTIONAL_STOP", "HELD",
]);

function deriveStatus(m) {
  const raw = String(m.status || "unknown").toLowerCase();
  // A machine the collector cannot reach is offline, even when its last
  // reported execution was ACTIVE — stale execution must not paint it green.
  if (m.online === false) return "offline";
  const execution = String(m.execution || "").toUpperCase();
  // A real feed-hold / cycle-stop is the only thing that means PAUSED.
  if (PAUSED_EXECUTION.has(execution)) return "paused";
  // Controller actively cutting -> PRODUCTION, regardless of spindle RPM.
  if (RUNNING_EXECUTION.has(execution)) return "running";
  if (raw === "running") return "running";
  // Everything else (idle/offline/alarm/e_stop) as the collector reported it.
  return raw;
}

// Two-row mode block: controller mode on top, execution state below, each
// tinted by value. Controller mode = manual vs auto; execution = active /
// stopped / paused / ready. Modifier classes drive the colors (css/cards.css).
function setMode2(refs, controllerMode, execution) {
  const ctrl = String(controllerMode || "").toUpperCase();
  const exec = String(execution || "").toUpperCase();
  if (refs.mode2ctrl) {
    refs.mode2ctrl.textContent = ctrl || "\u2014";
    // manual / mdi = amber, automatic = neutral-blue, anything else = muted
    let cls = "is-muted";
    if (ctrl === "AUTOMATIC" || ctrl === "AUTO") cls = "is-auto";
    else if (ctrl === "MANUAL" || ctrl === "MDI" || ctrl === "MANUAL_DATA_INPUT") cls = "is-manual";
    refs.mode2ctrl.className = `mc-mode-line mc-mode-ctrl ${cls}`;
  }
  if (refs.mode2exec) {
    refs.mode2exec.textContent = exec || "\u2014";
    let cls = "is-muted";
    if (RUNNING_EXECUTION.has(exec)) cls = "is-active";
    else if (PAUSED_EXECUTION.has(exec)) cls = "is-paused";
    else if (exec === "STOPPED") cls = "is-stopped";
    else if (exec === "READY") cls = "is-ready";
    refs.mode2exec.className = `mc-mode-line mc-mode-exec ${cls}`;
  }
}

function modeLabel(status) {
  const s = String(status || "unknown").toLowerCase();
  if (s === "e_stop" || s === "alarm") return "ATTENTION";
  if (s === "offline" || s === "unavailable") return "OFFLINE";
  if (s === "running") return "PRODUCTION";
  if (s === "paused") return "PAUSED";
  return "STANDBY";
}

/* ---------- stopped-since tracking ----------
 * How long a machine has NOT been cutting, measured from the derived status —
 * NOT from data_age_sec. A machine parked in STANDBY for two hours keeps
 * streaming, so its data_age_sec stays ~1s; gating on it hides exactly the
 * stoppage the floor needs to see.
 *
 * alarm / e_stop are excluded on purpose: they already carry the red attention
 * treatment, and painting them amber would soften a fault into a warning. */
const STOPPED_STATUS = new Set(["idle", "paused", "offline", "unavailable"]);
/* Silent grace period before the counter and the amber alert appear. Short
 * tool changes and pallet swaps must not light up the board. */
const IDLE_ALERT_AFTER_SEC = 300;
/* Persisted so a TV page rotation or an operator refresh does not restart every
 * counter at zero — the elapsed time is the whole point of the badge. */
const LS_STOP_SINCE = "vmc.stopSince.v1";

function loadStopSince() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_STOP_SINCE) || "{}");
    if (!o || typeof o !== "object") return new Map();
    return new Map(Object.entries(o).filter(([, v]) => Number.isFinite(Number(v)) && Number(v) > 0)
      .map(([k, v]) => [k, Number(v)]));
  } catch (_) { return new Map(); }
}
const stopSinceStore = loadStopSince(); // machine_id -> epoch ms, rehydrated at load
function saveStopSince() {
  try { localStorage.setItem(LS_STOP_SINCE, JSON.stringify(Object.fromEntries(stopSinceStore))); } catch (_) {}
}

/* Seconds a machine has been stopped, 0 when running or when the stamp is bogus.
 * Clamped at 0 because a stored stamp from a machine whose clock ran ahead (or a
 * last_seen_ms from a controller with a bad RTC) would otherwise count backward. */
function stoppedElapsedSec(stopSince, nowMs) {
  if (!stopSince) return 0;
  return Math.max(0, Math.floor((nowMs - stopSince) / 1000));
}

/* First-poll stamp for a card. Priority: a stamp we already persisted (only
 * trustworthy if the machine is still stopped, hence the caller's guard), then
 * last_seen_ms for offline/unavailable machines — for those, "when we last heard
 * from it" genuinely IS when it stopped — then data_age_sec as the last resort.
 * This is the only place data_age_sec may stand in for stop time. */
function seedStopSince(m, status, nowMs) {
  const stored = stopSinceStore.get(m.machine_id);
  if (stored) return stored;
  if (status === "offline" || status === "unavailable") {
    const lastSeen = msFromEpochLoose(m.last_seen_ms);
    if (lastSeen) return lastSeen;
    const ageSec = Number(m.data_age_sec);
    if (Number.isFinite(ageSec) && ageSec > 0) return nowMs - ageSec * 1000;
  }
  return nowMs;
}

/* ---------- card render ----------
 * Cards are built ONCE and cached in cardEls. Each poll patches only the
 * fields that changed (text / bar width / theme class) in place — no innerHTML
 * rebuild, so there is no flash, no reflow, and hover/animation state survives. */
const cardEls = new Map(); // machine_id -> { root, refs }

/* Pause the GPU-heavy orbit for cards scrolled out of view. The paint loop
 * checks entry.onScreen; this observer keeps it current. rootMargin gives a
 * small buffer so a card starts animating just before it scrolls in. */
const rootToEntry = new WeakMap(); // card root element -> entry
const cardObserver = ("IntersectionObserver" in window)
  ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        const entry = rootToEntry.get(e.target);
        if (entry) entry.onScreen = e.isIntersecting;
      }
    }, { root: null, rootMargin: "120px", threshold: 0 })
  : null;

/* Write helpers: touch the DOM only when the value actually changed. */
function setText(el, value) {
  const v = value == null ? "" : String(value);
  if (el && el.textContent !== v) el.textContent = v;
}
function setClass(el, cls) {
  if (el && el.className !== cls) el.className = cls;
}
function setWidth(el, pct) {
  const v = `${pct}%`;
  if (el && el.style.width !== v) el.style.width = v;
}
function setAttr(el, name, value) {
  const v = value == null ? "" : String(value);
  if (el && el.getAttribute(name) !== v) el.setAttribute(name, v);
}

/* Build the static skeleton once; return root + a refs map of live fields. */
function buildCard(m) {
  const root = document.createElement("article");
  root.className = "machine-card theme-unknown";
  root.dataset.machine = m.machine_id;
  root.innerHTML = `
    <div class="machine-card-shell">
      <div class="machine-card-eyebrow">
        <div class="machine-card-mode" data-f="mode"></div>
        <div class="status-pill" data-f="status"></div>
      </div>
      <div class="machine-card-inner">
        <div class="card-panel card-panel--top">
        <div class="machine-card-header">
          <div class="machine-card-title" data-f="title"></div>
          <div class="machine-card-mode2" data-f="mode2">
            <span class="mc-mode-line mc-mode-ctrl" data-f="mode2ctrl"></span>
            <span class="mc-mode-line mc-mode-exec" data-f="mode2exec"></span>
          </div>
        </div>
        <div class="machine-card-body">
          <div class="machine-card-box machine-card-box-ovr">
            <div class="machine-card-box-label">OVERRIDES<span class="shift-clock-note" data-f="clockNote" data-clock="trusted"></span></div>
            <div class="ovr-pills">
              <div class="ovr-pill" data-f="ovrFPill"><span class="ovr-pill-warn">⚠</span><span class="ovr-pill-key">F</span><span class="ovr-pill-val" data-f="ovrF"></span></div>
              <div class="ovr-pill" data-f="ovrRPill"><span class="ovr-pill-warn">⚠</span><span class="ovr-pill-key">R</span><span class="ovr-pill-val" data-f="ovrR"></span></div>
              <div class="ovr-pill" data-f="ovrSPill"><span class="ovr-pill-warn">⚠</span><span class="ovr-pill-key">S</span><span class="ovr-pill-val" data-f="ovrS"></span></div>
            </div>
          </div>
          <div class="machine-card-box machine-card-box-parts">
            <canvas class="parts-water-canvas" data-f="partsWater"></canvas>
            <div class="machine-card-box-label">PARTS</div>
            <div class="machine-card-parts-row">
              <div class="machine-card-box-value" data-f="parts"></div>
            </div>
            <div class="machine-card-box-note" data-f="partsNote"></div>
          </div>
          <div class="machine-card-box machine-card-box-wide machine-card-box-spindle">
            <div class="machine-card-spindle-left">
              <div class="machine-card-box-label">SPINDLE RPM</div>
              <div class="machine-card-box-value" data-f="rpm"></div>
            </div>
            <div class="spindle-wave">
              <canvas class="spindle-wave-canvas" data-f="spindleWave"></canvas>
            </div>
            <div class="spindle-parts" data-f="spindleParts">
              <div class="machine-card-box-label">PARTS</div>
              <div class="spindle-parts-value" data-f="spindlePartsVal">—</div>
            </div>
          </div>
          <div class="prog-timeline" data-f="progTimeline">
            <ol class="prog-timeline-list" data-f="progTimelineList"></ol>
          </div>
        </div>
        <div class="toolpath" data-f="toolpath">
          <canvas class="toolpath-canvas" data-f="toolpathCanvas"></canvas>
          <div class="toolpath-tag" data-f="toolpathTag">TOOLPATH</div>
          <div class="toolpath-zoom">
            <button type="button" class="toolpath-zoom-btn" data-f="zoomIn" title="Zoom in">+</button>
            <button type="button" class="toolpath-zoom-btn" data-f="zoomOut" title="Zoom out">−</button>
          </div>
        </div>
        <div class="cycle-panel">
            <div class="machine-card-idle-time" data-f="idleTime" hidden>
              <span class="mc-idle-label">STOPPED</span>
              <span class="mc-idle-clock" data-f="idleClock"></span>
            </div>
            <div class="cycle-panel-head" data-f="cycHead">
              <span class="cycle-panel-label"><span class="seq-live-dot"></span><span data-f="cycLabel"></span></span>
              <strong class="cycle-panel-pct" data-f="cycBig"></strong>
            </div>
            <div class="cycle-panel-bar"><span data-f="bar" style="transition:none"></span></div>
            <div class="cycle-panel-meta">
              <span data-f="metaLeft"></span>
              <span data-f="metaRight"></span>
            </div>
          </div>
          </div>
          <div class="card-panel card-panel--bottom shift-vibe-on">
          <div class="shift-vibe" data-f="shiftVibe"></div>
          <div class="shift-panel" data-f="shiftPanel" hidden>
            <div class="shift-panel-head">
              <span class="shift-pill shift-pill--active" data-f="shiftLabel"></span>
              <span class="shift-panel-parts" data-f="shiftParts"></span>
            </div>
            <div class="shift-panel-meta">
              <span class="shift-panel-seg shift-panel-seg--on" data-f="shiftRunningWrap">SP ON <span class="sp-chip sp-chip--on" data-f="shiftRunning">—</span></span>
              <span class="shift-panel-seg shift-panel-seg--off" data-f="shiftStoppedWrap">SP OFF <span class="sp-chip sp-chip--off" data-f="shiftStopped">—</span></span>
            </div>
            <div class="shift-chute" data-f="shiftChute" title="Shift timeline — green spindle on, red spindle off (IST 06/14/22)">
              <span class="shift-chute-running" data-f="chuteRunning"></span>
              <span class="shift-chute-stopped" data-f="chuteStopped"></span>
            </div>
            <div class="shift-prev shift-art-on" data-f="shiftPrev" hidden>
              <span class="shift-prev-box" data-f="shiftBox1"><span class="shift-prev-art" data-f="shiftBox1Art"></span><span class="shift-prev-name" data-f="shiftBox1Name">SHIFT 01</span><span class="shift-prev-pct" data-f="shiftBox1Pct">—</span></span>
              <span class="shift-prev-box" data-f="shiftBox2"><span class="shift-prev-art" data-f="shiftBox2Art"></span><span class="shift-prev-name" data-f="shiftBox2Name">SHIFT 02</span><span class="shift-prev-pct" data-f="shiftBox2Pct">—</span></span>
              <span class="shift-prev-box shift-prev-box--current"><span class="shift-prev-art" data-f="shiftBoxCurArt"></span><span class="shift-prev-cur" data-f="shiftSessionBig">—</span></span>
              <span class="shift-session-label" data-f="shiftSessionLabel">SESSION · <span class="sess-chip sess-chip--on" data-f="sessOn">—</span> OF <span class="sess-chip sess-chip--tot" data-f="sessTot">—</span></span>
            </div>
            <div class="shift-session" data-f="shiftSession">
              <div class="shift-chute shift-chute--session" data-f="shiftSessionChute" title="Session spindle share: green ON, red OFF (IST)">
                <span class="shift-chute-running" data-f="sessionRunning"></span>
                <span class="shift-chute-stopped" data-f="sessionStopped"></span>
              </div>
            </div>
          </div>
          </div>
      </div>
    </div>`;
  const refs = {};
  root.querySelectorAll("[data-f]").forEach((el) => { refs[el.dataset.f] = el; });
  return { root, refs };
}

/* Patch a card's live fields from the latest machine payload. */
function updateCard(entry, m) {
  const { root, refs } = entry;
  entry.lastM = m;
  const status = deriveStatus(m); // corrected running/paused, matches mission backend
  const online = !!m.online;
  const statusText = STATUS_LABEL[status] || status.toUpperCase();
  const ovr = m.overrides || {};
  const partCount = m.part_count_total ?? m.part_count;
  const cycle = computeCycle(m);

  setClass(root, `machine-card theme-${status}`);
  if (entry.lastStatus !== status) { entry.accentRGB = null; entry.lastStatus = status; }

  setText(refs.mode, modeLabel(status));

  setText(refs.title, m.machine_name || m.machine_id);
  setText(refs.status, statusText);
  setClass(refs.status, `status-pill status-${status}`);
  // ACTIVE with 0 RPM cuts nothing: keep ACTIVE->running (chips agree) and
  // flag the spindle box instead — orthogonal warn, never a status fork.
  const noCut = status === "running" && Number(m.spindle_speed) === 0;
  const spindleBox = refs.rpm ? refs.rpm.closest(".machine-card-box-spindle") : null;
  if (spindleBox) {
    if (spindleBox.classList.contains("is-no-cut") !== noCut) spindleBox.classList.toggle("is-no-cut", noCut);
    if (noCut) setAttr(spindleBox, "title", "Controller ACTIVE but spindle 0 RPM — cutting nothing");
    else if (spindleBox.hasAttribute("title")) spindleBox.removeAttribute("title");
  }

  // Stopped-since stamp. Wall-clock epoch ms so it survives a refresh; the
  // visible counter and the amber alert are painted from it in paintIdle.
  const stopped = STOPPED_STATUS.has(status);
  if (stopped) {
    if (!entry.stopSince) entry.stopSince = seedStopSince(m, status, Date.now());
  } else {
    entry.stopSince = null;
  }
  // A rehydrated stamp is only meaningful while the machine is still stopped: a
  // machine found running on the first poll gets its stored stamp dropped here,
  // because one that outlived a production run would report a fictional stoppage.
  // Written only on an actual change — this runs once per second per machine.
  if ((stopSinceStore.get(m.machine_id) || null) !== entry.stopSince) {
    if (entry.stopSince) stopSinceStore.set(m.machine_id, entry.stopSince);
    else stopSinceStore.delete(m.machine_id);
    saveStopSince();
  }

  // Spindle is a live sensor reading (not a predictable counter), so we don't
  // invent values between polls — we tween the DISPLAY toward each polled truth
  // so the number rolls smoothly instead of snapping. paintSpindle owns refs.rpm.
  const targetRpm = Number(m.spindle_speed);
  entry.spindle = {
    target: Number.isFinite(targetRpm) ? targetRpm : null,
    online,
  };
  if (entry.spindleShown == null && entry.spindle.target != null) {
    entry.spindleShown = entry.spindle.target; // first sight: no roll, show truth
  }
  // Parts count "floating-water" rise: tween the DISPLAY up to each new truth
  // (easeOut) so a finished part glides in instead of snapping. paintParts owns
  // refs.parts. On a job reset (count drops) we snap — never count backward.
  const targetParts = Number(partCount);
  // Number(null) is 0: the spindle-row readout only trusts a real value.
  entry.partsKnown = partCount != null && partCount !== "" && Number.isFinite(targetParts);
  if (Number.isFinite(targetParts)) {
    if (entry.partsShown == null || targetParts < entry.partsShown) {
      entry.partsShown = targetParts;          // first sight or reset -> show truth
    }
    entry.partsTarget = targetParts;
    // Live part-finish stamp (1s poll cadence): a risen counter is a finished
    // part right now. Feeds the celebration flash, the number pop, and the
    // exact (non-approximate) row in the recent-parts strip.
    if (entry.lastStampedN == null || targetParts < entry.lastStampedN) {
      entry.lastStampedN = targetParts;        // first sight or reset -> new chain
      entry.liveParts = [];
      entry.partsDoneAt = 0;
    } else if (targetParts > entry.lastStampedN) {
      entry.lastStampedN = targetParts;
      entry.partsDoneAt = Date.now();
      (entry.liveParts || (entry.liveParts = [])).push({ n: targetParts, ts: Date.now(), approx: false });
      if (entry.liveParts.length > 12) entry.liveParts.splice(0, entry.liveParts.length - 12);
      bumpParts(refs.parts);
    }
  } else {
    entry.partsTarget = null;
    if (entry.partsShown == null) setText(refs.parts, "—");
    // No count in this payload: the spindle-row readout shows "—", never a
    // last-known or invented number.
    setText(refs.spindlePartsVal, "—");
  }
  // Single timing under the count: when the shown number was reached. The live
  // 1s poll stamps exact rises; history backfills the time from before this
  // page opened. No extra section — just this line.
  if (entry.lastPartHistAt == null) entry.lastPartHistAt = lastHistRiseAt(m.machine_id);
  const lastPartAt = entry.partsDoneAt || entry.lastPartHistAt || 0;
  const targetNote = m.target_part_qty ? `of ${fmtInt(m.target_part_qty)}` : "";
  const agoNote = lastPartAt ? fmtAgo(Date.now() - lastPartAt) : "";
  setText(refs.partsNote, targetNote && agoNote ? `${targetNote} · ${agoNote}` : (targetNote || agoNote));
  if (refs.partsNote) refs.partsNote.title = lastPartAt ? `Last part finished ${fmtWallClock(lastPartAt)}` : "";
  const partsBox = refs.parts ? refs.parts.closest(".machine-card-box-parts") : null;
  if (partsBox) partsBox.classList.toggle("is-ranked", !!dashPrefs.rankedCounts);
  setText(refs.ovrF, fmtPct(ovr.feed));
  setText(refs.ovrR, fmtPct(ovr.rapid));
  setText(refs.ovrS, fmtPct(ovr.spindle));
  // Any override that isn't at 100% is off-nominal: blink the pill yellow with a
  // warning glyph so the floor can spot a dialed-down feed/rapid/spindle at a glance.
  setOvrWarn(refs.ovrFPill, ovr.feed);
  setOvrWarn(refs.ovrRPill, ovr.rapid);
  setOvrWarn(refs.ovrSPill, ovr.spindle);

  setMode2(refs, m.controller_mode, m.execution);
  // Per-program part count, FRONTEND-ONLY. History is seeded once per machine;
  // after that this updates purely from the live overview poll (no repeated
  // history requests). Counts only the CURRENT contiguous sequence, so it can
  // never exceed the machine's own counter. The count feeds the jobs timeline
  // and the PARTS popover; the old header program rows are gone.
  updateProgParts(m.machine_id, m.active_program, partCount);

  // Store the cycle "truth" for the interpolator. The 60fps painter (paintCycle)
  // owns the live display fields (cycBig / bar / metaLeft / metaRight) and glides
  // them between polls, then snaps back to this truth the instant a poll lands.
  //
  // PROGRESSION GATE: execution/status can lie (a paused machine still reports
  // ACTIVE/running with spindle 0 and a FROZEN remaining_cycle_time). The only
  // honest signal that a cycle is really advancing is remaining actually moving
  // between polls. We track that here and only let the timer tick when it's real.
  const now = performance.now();
  const hist = entry.cycleHist || (entry.cycleHist = { lastRemaining: null, lastMoveAt: now });
  const remNow = cycle.remaining;
  if (remNow == null) {
    hist.lastRemaining = null;
  } else if (hist.lastRemaining == null || remNow !== hist.lastRemaining) {
    hist.lastRemaining = remNow;
    hist.lastMoveAt = now;
  }
  // Progressing only if remaining moved within the last ~2.5s (covers 2 polls).
  // BUT spindle 0 on a cutting cycle is an instant tell the machine is paused —
  // use it to catch a stalled cycle on the very first poll, before the stall
  // timer has had two polls to confirm. (feed override 0 would be similar.)
  const spindleZero = Number(m.spindle_speed) === 0;
  const stalled = (now - hist.lastMoveAt) > 2500 || spindleZero;
  // FRESHNESS GATE: extrapolating any timer forward is only honest while the
  // collector is actually feeding us. On a stale/dead feed the newest "truth" is
  // minutes or hours old, so ticking it would invent time that never happened.
  // "lagging" still ticks — it is a slow poll, not a frozen one.
  const fresh = readFreshness(m);
  const feedFrozen = fresh.tier === "stale" || fresh.tier === "dead";
  const progressing = cycle.live && !stalled && !feedFrozen;

  entry.cycleTruth = {
    online,
    live: cycle.live,
    progressing,
    total: cycle.total,
    remaining: cycle.remaining,
    elapsed: cycle.elapsed,
    pct: cycle.pct,
    t: now,
  };
  // Label: IST-safe. Estimated fallback is per-program learned baseline (Hurco has no native cyremtim), not a timezone.
  const est = !!(m.cycle && m.cycle.estimated) || !!cycle.estimated;
  const sampleN = Number((m.cycle && m.cycle.sample_n) ?? cycle.sample_n ?? 0);
  const prog = (m.cycle && (m.cycle.program || m.cycle.est_program)) || cycle.program || m.active_program || "";
  let estSuffix = "";
  if (est) {
    if (!cycle.live) estSuffix = " • LEARNING";
    else if (Number.isFinite(sampleN) && sampleN >= 2) estSuffix = ` • ESTIMATED • ${prog ? prog + " • " : ""}n=${sampleN}`;
    else estSuffix = " • LEARNING";
  }
  const tip = est ? `Mathematical estimate from last ${sampleN || "?"} real parts of ${prog || "this program"} (Hurco has no native remaining). IST wall clock.` : "";
  if (refs.cycHead) refs.cycHead.title = tip;
  if (!cycle.live && est && online) {
    setText(refs.cycLabel, "CYCLE LEARNING" + (prog ? ` • ${prog}` : "") + (sampleN ? ` • n=${sampleN}/5` : ""));
  } else {
    setText(refs.cycLabel, online
      ? (cycle.live
          ? (cycle.overrun ? "CYCLE OVERRUN" + estSuffix : (progressing ? ("CYCLE REMAINING" + estSuffix) : "CYCLE PAUSED" + estSuffix))
          : "NO ACTIVE CYCLE")
      : "OFFLINE");
  }
  setClass(refs.cycHead, `cycle-panel-head ${online && progressing ? "seq-live" : "seq-stall"}`);
  paintCycle(entry);
  updateShiftPanel(entry, m, progressing, fresh);
  updateToolpath(entry, m);
}

/* Shift window label in IST, e.g. "06:00-14:00". Prefers the payload's own
 * from/shiftEnd stamps; falls back to the fixed plant roster. */
function shiftWindowLabel(shift, fromMs, shiftEnd) {
  const hhmm = (ms) => {
    const t = Number(ms);
    if (!Number.isFinite(t) || t <= 0) return null;
    try {
      return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).format(new Date(t));
    } catch (_) { return null; }
  };
  const a = hhmm(fromMs);
  const b = hhmm(shiftEnd) || hhmm(Number(fromMs) + 28800000);
  if (a && b) return `${a}-${b}`;
  const roster = { "01": "06:00-14:00", "02": "14:00-22:00", "03": "22:00-06:00", "1": "06:00-14:00", "2": "14:00-22:00", "3": "22:00-06:00" };
  return roster[String(shift ?? "").trim()] || "";
}

/* Shift guard — single active shift only. Below cycle bar, not touching it. + chute timeline bar. */
function updateShiftPanel(entry, m, progressing, fresh) {
  const refs = entry.refs;
  const freshness = fresh || readFreshness(m);
  const sh = m.shift_summary || m.shiftSummary || m.shift_summary_data;
  if (!sh || (!sh.shift && !sh.label)) {
    if (refs.shiftPanel) refs.shiftPanel.hidden = true;
    entry.shiftTruth = null;
    return;
  }
  const fromMs = Number(sh.from_ms ?? sh.fromMs ?? sh.from ?? (sh.window && (sh.window.from ?? sh.window.from_ms)) ?? 0);
  const toMs = Number(sh.to_ms ?? sh.toMs ?? sh.to ?? (sh.window && (sh.window.to ?? sh.window.to_ms)) ?? 0);
  const shiftEnd = Number(sh.shift_end ?? sh.shiftEnd ?? sh.window?.end ?? 0);
  const shiftDuration = Number(sh.shift_duration ?? sh.shiftDuration ?? 8*3600*1000);
  const futureMsRaw = Number(sh.future_ms ?? sh.futureMs ?? 0);
  const idealMs = sh.ideal_ms ?? sh.idealMs ?? sh.ideal ?? null;
  const runningMs = Number(sh.running_ms ?? sh.runningMs ?? sh.running ?? 0);
  const stoppedMs = Number(sh.stopped_ms ?? sh.stoppedMs ?? sh.stopped ?? sh.stop_ms ?? 0);
  const parts = sh.parts ?? sh.part_count ?? sh.partCount ?? null;
  const shift = String(sh.shift ?? "").trim();
  const shiftWindow = shiftWindowLabel(shift, fromMs, shiftEnd);
  const baseLabel = sh.label || (shift ? `SHIFT ${shift.padStart(2, "0")}` : "SHIFT");
  const label = shiftWindow ? `${baseLabel} ${shiftWindow}` : baseLabel;
  const activeProgram = sh.active_program ?? sh.activeProgram ?? m.active_program ?? "";
  const machineId = m.machine_name || m.machine_id || "";
  if (refs.shiftPanel) refs.shiftPanel.hidden = false;
  const fmt = (ms) => ms == null || Number.isNaN(Number(ms)) ? "—" : fmtClockHHMMSS(Number(ms) / 1000);
  // from<=0 means "no window": Number(… ?? 0) yields a finite 0 that would
  // explode elapsed to ~55 years while the label mask hides it (roster
  // fallback). Track validity separately so paint refuses to interpolate.
  const fromOk = Number.isFinite(fromMs) && fromMs > 0;
  entry.shiftTruth = {
    from: fromOk ? fromMs : Date.now(),
    fromOk,
    to: Number.isFinite(toMs) ? toMs : Date.now(),
    shiftEnd: Number.isFinite(shiftEnd) && shiftEnd>0 ? shiftEnd : (Number.isFinite(fromMs) ? fromMs+28800000 : Date.now()+28800000),
    shiftDuration: Number.isFinite(shiftDuration) && shiftDuration>0 ? shiftDuration : 28800000,
    future: Number.isFinite(futureMsRaw) ? futureMsRaw : 0,
    ideal: idealMs == null || Number.isNaN(Number(idealMs)) ? null : Number(idealMs),
    running: Number.isFinite(runningMs) ? runningMs : 0,
    stopped: Number.isFinite(stoppedMs) ? stoppedMs : 0,
    // Honesty inputs for the session percentage below. measuredRows==0 means
    // the totals came from the anchor fallback alone; truncated means the
    // tail was cut. Either way a confident percentage would be a lie.
    measuredRows: Number.isFinite(Number(sh.measured_rows)) ? Number(sh.measured_rows) : 0,
    truncated: sh.truncated === true || sh.truncated === 1 || sh.truncated === "true",
    parts: parts,
    shift: shift,
    label: label,
    window: shiftWindow,
    activeProgram: activeProgram,
    machineId: machineId,
    t: performance.now(),
    progressing: !!progressing,
    freshness: freshness.tier,
  };
  setText(refs.shiftLabel, label);
  setText(refs.shiftPill, label);
  setText(refs.shiftParts, parts != null && Number.isFinite(Number(parts)) ? `${fmtInt(parts)} parts` : "— parts");
  // Data-quality note: three of
  // the real controllers ship with an unset RTC, so their own claimed clock is
  // fiction. We say so instead of rendering a fabricated timestamp.
  if (refs.clockNote) {
    const cq = typeof m.clock_quality === "string" ? m.clock_quality.toLowerCase() : "";
    if (cq === "clock_unset" || cq === "suspect") {
      const unset = cq === "clock_unset";
      setText(refs.clockNote, unset ? "M/C - UNSET" : "M/C - SUSPECT");
      setAttr(refs.clockNote, "data-clock", cq);
      // machine_ts is raw MILLISECONDS and may honestly be a 1970 value — show it
      // as reported, never rescale or hide it. But null means "not reported",
      // which is a different fact from a real 1970 stamp, and Number(null) is 0
      // (a finite 1970 date), so null must be rejected before coercing.
      const mtsRaw = m.machine_ts;
      const mts = (mtsRaw === null || mtsRaw === undefined) ? NaN : Number(mtsRaw);
      const claimed = Number.isFinite(mts) ? new Date(mts).toLocaleString() : "not reported";
      const note = unset
        ? `Controller RTC is not set — the machine's own claimed time (${claimed}) cannot be trusted. Freshness above is measured from the collector's clock instead.`
        : `Controller clock looks wrong — the machine's own claimed time (${claimed}) is suspect. Freshness above is measured from the collector's clock instead.`;
      setAttr(refs.clockNote, "title", note);
      setAttr(refs.clockNote, "aria-label", note);
      // Reserved slot: visibility keeps the line's height so the card never
      // reflows between note and no-note machines.
      refs.clockNote.style.visibility = "visible";
    } else {
      refs.clockNote.style.visibility = "hidden";
    }
  }
  // Same unmeasured gate as paintShift: never assert split time from zero evidence.
  const shiftMeasured = fromOk
    && Number.isFinite(Number(sh.measured_rows)) && Number(sh.measured_rows) > 0
    && !(sh.truncated === true || sh.truncated === 1 || sh.truncated === "true");
  if (!shiftMeasured) {
    setText(refs.shiftRunning, "—");
    setText(refs.shiftStopped, "—");
  } else {
  setText(refs.shiftRunning, runningMs < 1000 ? "—" : fmtShiftDur(runningMs / 1000));
  setText(refs.shiftStopped, stoppedMs < 1000 ? "—" : fmtShiftDur(stoppedMs / 1000));
  }
  // Which side may tick between polls: only the live one (see paintShift).
  const machineStatus = deriveStatus(m);
  entry.shiftOnActive = machineStatus === "running";
  // Highlight only the SP ON timer while the spindle is moving.
  const spindleRpm = Number(m.spindle_speed);
  const spindleMoving = machineStatus === "running" && Number.isFinite(spindleRpm) && spindleRpm > 0;
  if (refs.shiftRunning) {
    if (spindleMoving) setAttr(refs.shiftRunning, "data-spindle", "on");
    else if (refs.shiftRunning.hasAttribute("data-spindle")) refs.shiftRunning.removeAttribute("data-spindle");
  }
  if (refs.shiftPill) setText(refs.shiftPill, label);
  ensurePrevSessions(entry, machineId);
  paintShift(entry);
  paintProgTimeline(entry);
}
function paintShift(entry) {
  const truth = entry.shiftTruth; const refs = entry.refs;
  if (!truth || !refs.shiftPanel || refs.shiftPanel.hidden) return;
  // Each side advances ONLY while its own state is live, measured from the
  // backend counters — never derived from the wall clock. A poll can therefore
  // only move a number forward, so the timers count cleanly instead of
  // jumping backward mid-count. A stale/dead feed freezes BOTH sides: ticking
  // on would invent time we have no data for. Hold the last polled truth.
  const frozenFeed = truth.freshness === "stale" || truth.freshness === "dead";
  const dt = frozenFeed ? 0 : (performance.now() - truth.t);
  const wallElapsed = truth.fromOk ? Math.max(0, Date.now() - truth.from) : Infinity;
  // Clamp both directions: past the wall clock pins the bar at 100/0 with no
  // warning (backend restart, skewed from).
  const running = Math.min(truth.running + (entry.shiftOnActive ? dt : 0), wallElapsed);
  const stopped = Math.min(Math.max(0, truth.stopped + (!entry.shiftOnActive ? dt : 0)), wallElapsed);
  const fmt = (ms) => fmtClockHHMMSS(ms / 1000);
  // Unmeasured window: same gate as paintSession — never assert split time.
  const measured = truth.fromOk && truth.measuredRows > 0 && !truth.truncated;
  if (!measured) {
    setText(refs.shiftRunning, "—");
    setText(refs.shiftStopped, "—");
    if (refs.shiftStoppedWrap) refs.shiftStoppedWrap.className = "shift-panel-seg shift-panel-seg--off";
    if (refs.chuteRunning) setWidth(refs.chuteRunning, 0);
    if (refs.chuteStopped) setWidth(refs.chuteStopped, 0);
    if (refs.shiftChute) {
      const why = !truth.fromOk ? "no shift window" : truth.truncated ? "partial data" : "unmeasured";
      setAttr(refs.shiftChute, "title", `Shift timeline unmeasured — no confident data (${why}, IST ${truth.label}${truth.window ? ` ${truth.window}` : ""})`);
    }
  } else {
  // Reserved slots: both segments always render (em dash under 1s) so the
  // meta row never collapses. Zero units are dropped from the visible text.
  setText(refs.shiftRunning, running < 1000 ? "—" : fmtShiftDur(running / 1000));
  setText(refs.shiftStopped, stopped < 1000 ? "—" : fmtShiftDur(stopped / 1000));
  const total = running + stopped;
  const warn = total > 0 && (stopped / total) > 0.5;
  if (refs.shiftStoppedWrap) {
    const base = "shift-panel-seg shift-panel-seg--off";
    refs.shiftStoppedWrap.className = warn ? `${base} shift-panel-seg--warn` : base;
  }
  const runningPct = total > 0 ? Math.max(0, Math.min(100, (running / total) * 100)) : 0;
  const stoppedPct = total > 0 ? Math.max(0, 100 - runningPct) : 0;
  if (refs.chuteRunning) setWidth(refs.chuteRunning, runningPct.toFixed(2));
  if (refs.chuteStopped) setWidth(refs.chuteStopped, stoppedPct.toFixed(2));
  if (refs.shiftChute) {
    const tip = `IST ${truth.label}${truth.window ? ` ${truth.window}` : ""}: green spindle on ${fmt(running)} · red spindle off ${fmt(stopped)} · ${truth.activeProgram || ""}`;
    setAttr(refs.shiftChute, "title", tip);
  }
  }
  paintShiftBoxes(entry, running, stopped);
  paintSession(entry, running, stopped, fmt);
}

/* All three shifts of the day, fetched ONCE per window — never per poll. The
 * two completed windows cost one small request each per board-load (refetched
 * only when the current window rolls); the current shift is live from the
 * displayed pair, so its box ticks with the card. Failures render as em
 * dashes and retry no sooner than 5 minutes later. */
function ensurePrevSessions(entry, machineId) {
  const truth = entry.shiftTruth; const refs = entry.refs;
  if (!truth || !truth.fromOk || !machineId) return;
  const key = `${machineId}@${truth.from}`;
  const now = Date.now();
  if (entry.prev && entry.prev.key === key) return;
  if (entry.prevRetryAt && now < entry.prevRetryAt && entry.prev && entry.prev.key !== key) {
    // Window rolled while a retry was pending: fall through and refetch.
  } else if (entry.prevRetryAt && now < entry.prevRetryAt) {
    return;
  }
  const cur = String(truth.shift || "").padStart(2, "0");
  const prevNum = (s) => (s === "01" ? "03" : s === "02" ? "01" : "02");
  const p1 = prevNum(cur);
  const p2 = prevNum(p1);
  entry.prev = { key, cur, boxes: { [p1]: null, [p2]: null } };
  entry.prevRetryAt = now + 5 * 60 * 1000;
  const DUR = 8 * 3600 * 1000;
  const wins = [
    { shift: p1, from: truth.from - DUR, to: truth.from },
    { shift: p2, from: truth.from - 2 * DUR, to: truth.from - DUR },
  ];
  const base = (typeof state !== "undefined" && state.apiBase) ? state.apiBase : "";
  if (!base) return;
  wins.forEach((w) => {
    const url = `${base}/api/shift_summary?machine=${encodeURIComponent(machineId)}&from_ms=${w.from}&to_ms=${w.to}`;
    fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!entry.prev || entry.prev.key !== key || !j) return;
        const on = Number(j.running_ms);
        const off = Number(j.stopped_ms);
        const rows = Number(j.measured_rows);
        const trunc = j.truncated === true;
        if (Number.isFinite(on) && Number.isFinite(off) && on + off > 0 && rows > 0 && !trunc) {
          entry.prev.boxes[w.shift] = { pct: (on / (on + off)) * 100, on, off };
        } else {
          entry.prev.boxes[w.shift] = { pct: null, on, off };
        }
        paintShiftBoxes(entry, 0, 0);
      })
      .catch(() => { paintShiftBoxes(entry, 0, 0); });
  });
}

/* Experimental day-phase art for the shift row: each box carries a small
 * decorative sky for ITS shift (01 morning, 02 afternoon, 03 night) as a
 * background layer that can never move layout or text. One-flag removal:
 * drop the shift-art-on class in the template and the row is today's row. */
const SHIFT_PHASE = { "01": "morning", "02": "afternoon", "03": "night" };
const SHIFT_ART = {
  morning: `<svg viewBox="0 0 48 48" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><g class="art-rays" stroke="#fcd34d" stroke-width="3" stroke-linecap="round" opacity="0.9"><line x1="24" y1="6" x2="24" y2="11"/><line x1="12" y1="12" x2="15" y2="15.5"/><line x1="36" y1="12" x2="33" y2="15.5"/><line x1="6" y1="24" x2="11" y2="24"/><line x1="42" y1="24" x2="37" y2="24"/></g><circle cx="24" cy="30" r="9" fill="#fbbf24" opacity="0.95"/><rect x="9" y="30" width="30" height="3" rx="1.5" fill="#fbbf24" opacity="0.6"/></svg>`,
  afternoon: `<svg viewBox="0 0 48 48" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><circle cx="21" cy="19" r="13" fill="none" stroke="#fbbf24" stroke-width="2" opacity="0.5"/><circle cx="21" cy="19" r="9" fill="#fbbf24" opacity="0.95"/><g class="art-cloud" fill="#fef3c7" opacity="0.8"><ellipse cx="31" cy="33" rx="7" ry="4.5"/><ellipse cx="26" cy="31" rx="5" ry="3.5"/><ellipse cx="35.5" cy="31" rx="4.5" ry="3"/></g></svg>`,
  night: `<svg viewBox="0 0 48 48" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><g class="art-moon"><path transform="translate(4,6) scale(1.5)" d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" fill="#e9edf6" opacity="0.95"/></g><g fill="#fde68a"><circle class="art-star" cx="38" cy="12" r="2.4"/><circle class="art-star art-star--d2" cx="33" cy="36" r="2"/><circle class="art-star art-star--d3" cx="41" cy="25" r="1.8"/></g></svg>`,
};
function paintShiftArt(el, shift) {
  if (!el || !dashPrefs.shiftArt) return;
  const phase = SHIFT_PHASE[String(shift || "").padStart(2, "0")] || "night";
  if (el.dataset.phase === phase) return;
  el.dataset.phase = phase;
  el.classList.remove("is-visible");
  el.innerHTML = SHIFT_ART[phase];
  void el.offsetWidth;
  el.classList.add("is-visible");
}
/* Experimental whole-container vibe: the bottom panel carries the CURRENT
 * shift's sky (morning/afternoon/night) as an animated backdrop behind all
 * shift content. Same one-flag removal via shift-vibe-on in the template. */
const SHIFT_VIBE = {
  morning: `<svg viewBox="0 0 400 220" preserveAspectRatio="xMaxYMin slice" aria-hidden="true"><defs><linearGradient id="vMorning" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#f59e0b" stop-opacity="0"/><stop offset="0.55" stop-color="#f59e0b" stop-opacity="0.02"/><stop offset="1" stop-color="#fbbf24" stop-opacity="0.12"/></linearGradient></defs><rect width="400" height="220" fill="url(#vMorning)"/><g class="art-rays" stroke="#fcd34d" stroke-width="3" stroke-linecap="round" opacity="0.55"><line x1="378" y1="2" x2="378" y2="10"/><line x1="356" y1="12" x2="361" y2="18"/><line x1="394" y1="18" x2="399" y2="12"/></g><circle cx="378" cy="34" r="13" fill="#fbbf24" opacity="0.5"/><rect x="352" y="36" width="52" height="2.5" fill="#fbbf24" opacity="0.4"/></svg>`,
  afternoon: `<svg viewBox="0 0 400 220" preserveAspectRatio="xMaxYMin slice" aria-hidden="true"><defs><linearGradient id="vAfternoon" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#f59e0b" stop-opacity="0"/><stop offset="0.55" stop-color="#f59e0b" stop-opacity="0.02"/><stop offset="1" stop-color="#fcd34d" stop-opacity="0.12"/></linearGradient></defs><rect width="400" height="220" fill="url(#vAfternoon)"/><g class="art-rays" stroke="#fcd34d" stroke-width="2.5" stroke-linecap="round" opacity="0.5"><line x1="378" y1="7" x2="378" y2="13"/><line x1="378" y1="47" x2="378" y2="53"/><line x1="361" y1="30" x2="355" y2="30"/><line x1="395" y1="30" x2="401" y2="30"/><line x1="366" y1="18" x2="362" y2="14"/><line x1="390" y1="18" x2="394" y2="14"/><line x1="366" y1="42" x2="362" y2="46"/><line x1="390" y1="42" x2="394" y2="46"/></g><circle cx="378" cy="30" r="19" fill="none" stroke="#fcd34d" stroke-width="2" opacity="0.35"/><circle cx="378" cy="30" r="13" fill="#fcd34d" opacity="0.45"/></svg>`,
  night: `<svg viewBox="0 0 400 220" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs><linearGradient id="vNight" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6366f1" stop-opacity="0"/><stop offset="0.55" stop-color="#6366f1" stop-opacity="0.03"/><stop offset="1" stop-color="#a5b4fc" stop-opacity="0.12"/></linearGradient></defs><rect width="400" height="220" fill="url(#vNight)"/><g class="art-moon"><path transform="translate(332,22) scale(1.8)" d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" fill="#e9edf6" opacity="0.6"/></g><g fill="#fde68a"><circle class="art-star" cx="312" cy="30" r="2.6"/><circle class="art-star art-star--d2" cx="292" cy="60" r="2.2"/><circle class="art-star art-star--d3" cx="330" cy="70" r="2"/><circle class="art-star" cx="272" cy="34" r="1.8"/></g></svg>`,
};
function paintShiftVibe(el, shift) {
  if (!el || !dashPrefs.shiftArt) return;
  const phase = SHIFT_PHASE[String(shift || "").padStart(2, "0")] || "night";
  if (el.dataset.phase === phase) return;
  el.dataset.phase = phase;
  el.classList.remove("is-visible");
  el.innerHTML = SHIFT_VIBE[phase];
  void el.offsetWidth;
  el.classList.add("is-visible");
}
function paintShiftBoxes(entry) {
  const refs = entry.refs; const prev = entry.prev;
  const truth = entry.shiftTruth;
  if (!refs.shiftBox1) return;
  refs.shiftPrev.hidden = false;
  const els = [refs.shiftBox1, refs.shiftBox2];
  const pcts = [refs.shiftBox1Pct, refs.shiftBox2Pct];
  const names = [refs.shiftBox1Name, refs.shiftBox2Name];
  const arts = [refs.shiftBox1Art, refs.shiftBox2Art];
  // Previous two shifts only, chronological: e.g. current 01 paints 02, 03.
  // The current shift has no box; its share reads big inside the session block.
  const cur = (prev && prev.cur) || String((truth && truth.shift) || "").padStart(2, "0") || "01";
  const prevNum = (s) => (s === "01" ? "03" : s === "02" ? "01" : "02");
  const p1 = prevNum(cur);
  [prevNum(p1), p1].forEach((s, i) => {
    const el = els[i];
    const pctEl = pcts[i];
    if (!el) return;
    if (names[i]) setText(names[i], `SHIFT ${s}`);
    paintShiftArt(arts[i], s);
    el.classList.remove("shift-prev-box--active");
    const show = (text, title) => { if (pctEl) setText(pctEl, text); setAttr(el, "title", title); };
    const slot = prev && prev.boxes ? prev.boxes[s] : null;
    if (!slot) { show("—", `SHIFT ${s}: no data yet`); return; }
    if (slot.pct == null) { show("—", `SHIFT ${s}: unmeasured, no confident percentage`); return; }
    show(`${Math.round(slot.pct)}%`, `SHIFT ${s}: spindle ON ${fmtClockHHMMSS(slot.on / 1000)} of ${fmtClockHHMMSS((slot.on + slot.off) / 1000)}`);
  });
  paintShiftArt(refs.shiftBoxCurArt, cur);
  paintShiftVibe(refs.shiftVibe, cur);
}

/* Continuous session fill for the current-shift box: the percentage melts from
 * red (0) through amber (50) to green (100) with the fill deepening as it
 * climbs — no separate steps, every percent its own shade. Written only when
 * the rounded values change; CSS transitions smooth the rest. */
const SESS_STOPS = [[0, [248, 113, 113]], [50, [251, 191, 36]], [100, [74, 222, 128]]];
function setSessFill(entry, pct) {
  const box = entry.refs && entry.refs.shiftSessionBig
    ? entry.refs.shiftSessionBig.closest(".shift-prev-box--current") : null;
  if (!box) return;
  if (pct == null) {
    if (entry.sessFill == null) return;
    entry.sessFill = null;
    box.removeAttribute("data-sess");
    box.style.removeProperty("--sess-rgb");
    box.style.removeProperty("--sess-a");
    box.style.removeProperty("--sess-ink");
    return;
  }
  const p = Math.max(0, Math.min(100, pct));
  let a = SESS_STOPS[0], b = SESS_STOPS[SESS_STOPS.length - 1];
  for (let i = 0; i < SESS_STOPS.length - 1; i++) {
    if (p >= SESS_STOPS[i][0] && p <= SESS_STOPS[i + 1][0]) { a = SESS_STOPS[i]; b = SESS_STOPS[i + 1]; break; }
  }
  const t = b[0] === a[0] ? 0 : (p - a[0]) / (b[0] - a[0]);
  const rgb = [0, 1, 2].map((k) => Math.round(a[1][k] + (b[1][k] - a[1][k]) * t));
  const alpha = (0.28 + (p / 100) * 0.6).toFixed(3);
  const ink = p >= 78 ? "#04140b" : `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  const sig = `${rgb.join(",")}|${alpha}|${ink}`;
  if (entry.sessFill === sig) return;
  entry.sessFill = sig;
  box.setAttribute("data-sess", "");
  box.style.setProperty("--sess-rgb", rgb.join(", "));
  box.style.setProperty("--sess-a", alpha);
  box.style.setProperty("--sess-ink", ink);
}
/* Session spindle share, painted every frame from the DISPLAYED on/off pair,
 * so it can never disagree with the card: SESSION = ON / (ON + OFF). Shown
 * only with measured, untruncated input — otherwise an em dash. */
function paintSession(entry, running, stopped, fmt) {
  const refs = entry.refs; const truth = entry.shiftTruth;
  if (!refs.shiftSessionLabel) return;
  // The SESSION line lives inside the shift grid: keep the row visible — this
  // painter renders the honest "—" state itself when there is nothing to show.
  if (refs.shiftPrev) refs.shiftPrev.hidden = false;
  const ok = truth && truth.fromOk && truth.measuredRows > 0 && !truth.truncated;
  const total = running + stopped;
  const setBig = (t) => { if (refs.shiftSessionBig) setText(refs.shiftSessionBig, t); };
  if (ok && total > 0) {
    const pct = Math.round((running / total) * 100);
    setBig(`${pct}%`);
    setSessFill(entry, (running / total) * 100);
    setText(refs.sessOn, fmtSessHM(running / 1000));
    setText(refs.sessTot, fmtSessHM(total / 1000));
    setAttr(refs.shiftSessionLabel, "title", `Session spindle share since shift start (${truth.label}${truth.window ? ` ${truth.window}` : ""})`);
    if (refs.sessionRunning) setWidth(refs.sessionRunning, ((running / total) * 100).toFixed(2));
    if (refs.sessionStopped) setWidth(refs.sessionStopped, (Math.max(0, 100 - (running / total) * 100)).toFixed(2));
  } else {
    const why = !truth || !truth.fromOk ? "no shift window"
      : truth.truncated ? "partial data" : "unmeasured";
    setBig("—");
    setSessFill(entry, null);
    setText(refs.sessOn, "—");
    setText(refs.sessTot, "—");
    setAttr(refs.shiftSessionLabel, "title", `Session share withheld: ${why}`);
    if (refs.sessionRunning) setWidth(refs.sessionRunning, (0).toFixed(2));
    if (refs.sessionStopped) setWidth(refs.sessionStopped, (0).toFixed(2));
  }
}

/* 60fps interpolation for cycle data only.
 * remaining counts DOWN 1s/s, elapsed counts UP 1s/s — perfectly predictable.
 * Between real polls we advance them by wall-clock delta so the timer and bar
 * move continuously instead of stepping once per second.
 * VMC-04 Hurco case: backend may send estimated cycle (median baseline) or
 * frontend fallback when native cyremtim absent — bar must still tick via dt
 * exactly like VMC-05/06 (remaining -= dt, elapsed += dt). */
function paintCycle(entry) {
  const truth = entry.cycleTruth;
  const refs = entry.refs;
  if (!truth) return;

  // Only idle/offline or truly no cycle data hides the bar.
  // When RUNNING (live true) we always render the bar even if estimated/fallback.
  if (!truth.live) {
    // Derive a TOTAL for the LAST label when offline but we still have a stale total
    setText(refs.cycBig, "—");
    setWidth(refs.bar, 0);
    setText(refs.metaLeft, `ELAPSED ${truth.elapsed != null ? fmtClock(truth.elapsed) : "—"}`);
    setText(refs.metaRight, `LAST ${fmtClock(truth.total)}`);
    return;
  }
  if (truth.total == null) {
    // RUNNING but somehow total still null (no fallback found) — no bar to draw
    setText(refs.cycBig, "—");
    setWidth(refs.bar, 0);
    setText(refs.metaLeft, `ELAPSED ${truth.elapsed != null ? fmtClock(truth.elapsed) : "—"}`);
    setText(refs.metaRight, `LAST ${fmtClock(truth.total)}`);
    return;
  }

  // Frozen cycle (machine paused): show the polled truth exactly, do NOT tick.
  // Interpolating a stalled timer is precisely the "fake numbers" bug.
  if (!truth.progressing) {
    const pct = truth.pct == null ? 0 : truth.pct;
    setText(refs.cycBig, `${pct.toFixed(2)}%`);
    setWidth(refs.bar, pct.toFixed(1));
    setText(refs.metaLeft, `ELAPSED ${truth.elapsed != null ? fmtClock(truth.elapsed) : "—"}`);
    // remaining may be null when derived from elapsed; synthesize for display
    let remDisplay = truth.remaining;
    if (!Number.isFinite(remDisplay) && Number.isFinite(truth.total) && Number.isFinite(truth.elapsed)) {
      remDisplay = Math.max(0, truth.total - truth.elapsed);
    }
    setText(refs.metaRight, `${fmtClock(remDisplay)} LEFT`);
    return;
  }

  const dt = (performance.now() - truth.t) / 1000; // seconds since this truth landed
  // remaining may be null for estimated fallback derived from elapsed — synthesize base
  let baseRem = truth.remaining;
  if (!Number.isFinite(baseRem) && Number.isFinite(truth.total) && Number.isFinite(truth.elapsed)) {
    baseRem = Math.max(0, truth.total - truth.elapsed);
  }
  if (!Number.isFinite(baseRem)) baseRem = truth.total;
  const remaining = Math.max(0, baseRem - dt);
  const elapsed = Math.min(truth.total, (truth.elapsed ?? 0) + dt);
  const pct = Math.max(0, Math.min(100, ((truth.total - remaining) / truth.total) * 100));

  setText(refs.cycBig, `${pct.toFixed(2)}%`);
  setWidth(refs.bar, pct.toFixed(1)); // guarded: only writes when the rounded width changes
  setText(refs.metaLeft, `ELAPSED ${fmtClock(elapsed)}`);
  setText(refs.metaRight, `${fmtClock(remaining)} LEFT`);
}

/* Spindle RPM tween toward the latest polled value (no invented data).
 * Rolls the displayed number ~18%/frame toward truth, snaps when within 1 RPM. */
/* Spindle RPM glide toward the latest polled value (no invented data).
 * Deadband: anything under 1 RPM is controller noise, so OFF snaps to a
 * steady 0 and holds — the readout and the trace never twitch at zero.
 * Otherwise the display eases toward truth on wall-clock time, so numbers
 * roll smoothly instead of snapping. paintSpindle owns refs.rpm. */
function paintSpindle(entry, dt) {
  const sp = entry.spindle;
  const refs = entry.refs;
  if (!sp) return;
  if (sp.target == null) { setText(refs.rpm, "—"); return; }
  const target = Math.abs(sp.target) < 1 ? 0 : sp.target;
  if (entry.spindleShown == null) entry.spindleShown = target;
  if (target === 0) {
    entry.spindleShown = 0;
  } else {
    const k = 1 - Math.exp(-Math.max(0, dt || 0.016) * 10);
    const diff = target - entry.spindleShown;
    entry.spindleShown = Math.abs(diff) < 1 ? target : entry.spindleShown + diff * k;
  }

  setText(refs.rpm, fmtNum(entry.spindleShown, 0));
}

/* Stopped counter + amber alert, armed once the stoppage passes the grace period.
 * Uses Date.now(), not the rAF timestamp: a backgrounded tab stops getting frames
 * and a performance.now() delta would under-count the real elapsed time. The
 * rendered string only changes once a minute, so the DOM write is gated on it —
 * this runs at 60fps for every card. */
function paintIdle(entry) {
  const refs = entry.refs;
  const elapsedSec = stoppedElapsedSec(entry.stopSince, Date.now());
  const armed = !!entry.stopSince && elapsedSec >= IDLE_ALERT_AFTER_SEC;
  if (armed !== entry.idleArmed) {
    entry.idleArmed = armed;
    refs.idleTime.hidden = !armed;
    if (armed) entry.root.dataset.idleAlert = "1";
    else delete entry.root.dataset.idleAlert;
  }
  if (!armed) return;
  setText(refs.idleClock, fmtIdleDuration(elapsedSec));
}


/* Parts count-up tween. Glides the displayed integer toward the polled total
 * (easeOut ~12%/frame), snapping when within <0.5 so it lands on a clean int.
 * Reset (target below shown) is handled in updateCard, so here we only rise. */
function paintParts(entry) {
  const refs = entry.refs;
  const target = entry.partsTarget;
  if (target == null) return;
  if (entry.partsShown == null) entry.partsShown = target;
  const diff = target - entry.partsShown;
  if (Math.abs(diff) < 0.5) entry.partsShown = target;
  else entry.partsShown += diff * 0.12;
  setText(refs.parts, fmtInt(entry.partsShown));
  setText(refs.spindlePartsVal, entry.partsKnown ? fmtInt(entry.partsShown) : "—");
}

/* ---------- spindle RPM history trace ----------
 * A slow-scrolling time-series of the REAL spindle RPM over the last 10 seconds,
 * like a chart recorder / EKG strip — NOT an instant vibrating animation. Each
 * fixed tick we sample the live RPM into a ring buffer; the curve scrolls right
 * (newest) to left (oldest) at a steady pace so you can read the trend, not a
 * blur. A flat spindle draws a flat line; a ramp-up draws a rising slope.
 *
 * Honest to the data: every plotted point IS a polled RPM reading. Nothing is
 * synthesized — only the between-sample curve is smoothed for a clean line.
 *
 * 2D canvas, painted in the throttled rAF loop, skipped off-screen. */
const RPM_WINDOW_MS = 20000;    // seconds of history shown across the box width
const RPM_SAMPLE_MS = 200;      // one sample every 200ms -> 100 points over 20s
const RPM_TRACE_FULL = 9000;    // RPM mapped to the top of the trace box

function paintSpindleWave(entry, dt) {
  const cv = entry.refs.spindleWave;
  if (!cv) return;
  const ctx = entry.waveCtx || (entry.waveCtx = cv.getContext("2d"));
  if (!ctx) return;

  const w = cv.clientWidth || 1, h = cv.clientHeight || 1;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }

  // Smoothed display value, so controller noise at zero never jitters the trace.
  const rpm = Number.isFinite(entry.spindleShown) ? entry.spindleShown : 0;

  // ---- sample into a time-stamped ring buffer at a steady cadence ----
  const now = (entry.waveClock = (entry.waveClock || 0) + dt * 1000); // ms, monotonic
  let hist = entry.rpmHist;
  if (!hist) {
    hist = entry.rpmHist = [];
    // backfill the window flat at the current reading so the trace starts full,
    // not as a line crawling in from the right edge.
    for (let tms = now - RPM_WINDOW_MS; tms <= now; tms += RPM_SAMPLE_MS) {
      hist.push({ t: tms, v: rpm });
    }
    entry.rpmLastSample = now;
  }
  if (now - (entry.rpmLastSample || 0) >= RPM_SAMPLE_MS) {
    entry.rpmLastSample = now;
    hist.push({ t: now, v: rpm });
    // drop points older than the window (keep one extra for the left-edge join).
    const cutoff = now - RPM_WINDOW_MS - RPM_SAMPLE_MS;
    while (hist.length > 2 && hist[1].t < cutoff) hist.shift();
  }

  ctx.clearRect(0, 0, w, h);
  const pad = h * 0.16;                       // keep the trace off the very edges
  const top = pad, bot = h - pad;
  const yOf = (v) => bot - Math.max(0, Math.min(1, v / RPM_TRACE_FULL)) * (bot - top);
  const xOf = (tms) => w - ((now - tms) / RPM_WINDOW_MS) * w; // newest at right

  const rgb = entry.accentRGB || (entry.accentRGB = readAccent(entry.root));
  if (!rgb) return;                 // card not yet in DOM — retry next frame
  const [r, g, b] = rgb;

  // soft fill under the curve, then halo, then the crisp line — a clean trace.
  const pts = hist.map((s) => [xOf(s.t), yOf(s.v)]).filter((p) => p[0] >= -4);
  if (pts.length < 2) return;

  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    const [px, py] = pts[i - 1], [cx, cy] = pts[i];
    const mx = (px + cx) / 2;                 // midpoint smoothing -> gentle curve
    ctx.quadraticCurveTo(px, py, mx, (py + cy) / 2);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
  // close down to the baseline for the gradient fill.
  ctx.lineTo(last[0], bot);
  ctx.lineTo(pts[0][0], bot);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, top, 0, bot);
  grad.addColorStop(0, `rgba(${r},${g},${b},0.22)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0.0)`);
  ctx.fillStyle = grad;
  ctx.fill();

  // the line itself (halo + core).
  for (let pass = 0; pass < 2; pass++) {
    const halo = pass === 0;
    ctx.beginPath();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = halo ? 5 : 2.2;
    ctx.strokeStyle = halo ? `rgba(${r},${g},${b},0.16)` : `rgba(${r},${g},${b},0.95)`;
    ctx.globalCompositeOperation = halo ? "lighter" : "source-over";
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const [px, py] = pts[i - 1], [cx, cy] = pts[i];
      const mx = (px + cx) / 2;
      ctx.quadraticCurveTo(px, py, mx, (py + cy) / 2);
    }
    ctx.lineTo(last[0], last[1]);
    ctx.stroke();
  }

  // a dot riding the leading (newest) edge so the eye finds "now".
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = `rgba(${r},${g},${b},1)`;
  ctx.beginPath();
  ctx.arc(last[0], last[1], 3, 0, Math.PI * 2);
  ctx.fill();
}

/* ---------- parts "water-fill" progress ----------
 * The PARTS box fills like a tank with the CURRENT part's cycle progress: 50%
 * through the cycle = box half full, 90% = nearly full, draining smoothly when a
 * part finishes and the next begins. Two phase-shifted sine surfaces give the
 * sloshing meniscus; a soft accent gradient is the body, behind the number.
 * 2D canvas, painted in the throttled loop, paused off-screen — near-zero cost.
 *
 * Honest to the data: the level IS the polled cycle pct (entry.cycleTruth.pct,
 * already interpolated by paintCycle); only the ripple motion is synthesized. */
/* Rounded-rectangle track for the single runner light: path length plus the
 * point at a given distance, clockwise from the top edge. */
function rrTotal(w, h, rad, inset) {
  const sW = Math.max(0, w - inset * 2 - rad * 2);
  const sH = Math.max(0, h - inset * 2 - rad * 2);
  return 2 * sW + 2 * sH + 2 * Math.PI * rad;
}
function rrPointAt(w, h, rad, inset, s) {
  const x0 = inset, y0 = inset, W = w - inset * 2, H = h - inset * 2;
  const sW = Math.max(0, W - rad * 2), sH = Math.max(0, H - rad * 2);
  const arc = (Math.PI / 2) * rad;
  const total = 2 * sW + 2 * sH + 4 * arc;
  if (!(total > 0)) return [x0, y0];
  let d = ((s % total) + total) % total;
  if (d < sW) return [x0 + rad + d, y0];
  d -= sW;
  if (d < arc) {
    const a = -Math.PI / 2 + d / rad;
    return [x0 + W - rad + Math.cos(a) * rad, y0 + rad + Math.sin(a) * rad];
  }
  d -= arc;
  if (d < sH) return [x0 + W, y0 + rad + d];
  d -= sH;
  if (d < arc) {
    const a = d / rad;
    return [x0 + W - rad + Math.cos(a) * rad, y0 + H - rad + Math.sin(a) * rad];
  }
  d -= arc;
  if (d < sW) return [x0 + W - rad - d, y0 + H];
  d -= sW;
  if (d < arc) {
    const a = Math.PI / 2 + d / rad;
    return [x0 + rad + Math.cos(a) * rad, y0 + H - rad + Math.sin(a) * rad];
  }
  d -= arc;
  if (d < sH) return [x0, y0 + H - rad - d];
  d -= sH;
  const a = Math.PI + d / rad;
  return [x0 + rad + Math.cos(a) * rad, y0 + rad + Math.sin(a) * rad];
}
function roundRectPath(ctx, w, h, inset, rad) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(inset, inset, Math.max(1, w - inset * 2), Math.max(1, h - inset * 2), rad);
  } else ctx.rect(inset, inset, Math.max(1, w - inset * 2), Math.max(1, h - inset * 2));
}
function paintPartsWater(entry, dt) {
  const cv = entry.refs.partsWater;
  if (!cv) return;
  const ctx = entry.waterCtx || (entry.waterCtx = cv.getContext("2d"));
  if (!ctx) return;

  const w = cv.clientWidth || 1, h = cv.clientHeight || 1;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }

  // target fill 0..1 = current cycle progress (only while a cycle is live).
  const truth = entry.cycleTruth;
  const liveCycle = truth && truth.live && truth.progressing && truth.pct != null;
  const target = liveCycle ? Math.max(0, Math.min(1, truth.pct / 100)) : 0;
  if (entry.waterLevel == null) entry.waterLevel = target;
  entry.waterLevel += (target - entry.waterLevel) * 0.06;   // glide; drains on finish too
  const level = entry.waterLevel;

  if (!MOTION_REDUCED) entry.waterPhase = (entry.waterPhase || 0) + dt * 1.6;

  // Fill stages, all derived from the same real cycle level (plus a short
  // celebration latch set the poll a part actually finished, so the full-green
  // moment always shows even when the counter jumps straight from 98% to done).
  // Hysteresis on the way down so the glow can't flicker at the boundary.
  const nowMs = Date.now();
  const celeb = !!entry.partsDoneAt && (nowMs - entry.partsDoneAt) < 1500;
  let stage = "";
  if (level >= 0.99 || celeb) stage = "full";
  else if (level >= 0.90) stage = "hot";
  else if (entry.fillStage === "hot" && level >= 0.88) stage = "hot";
  else if (entry.fillStage === "full" && level >= 0.975) stage = "full";
  const partsBox = cv.closest ? cv.closest(".machine-card-box-parts") : null;
  if (partsBox && entry.fillStage !== stage) {
    entry.fillStage = stage;
    if (stage) partsBox.setAttribute("data-fill", stage);
    else partsBox.removeAttribute("data-fill");
  }

  ctx.clearRect(0, 0, w, h);
  if (level < 0.002) return;                                 // empty -> nothing to draw

  const accent = entry.accentRGB || (entry.accentRGB = readAccent(entry.root));
  if (!accent) return;              // card not yet in DOM — retry next frame
  const [r, g, b] = accent;
  const surfaceY = h * (1 - level);
  const ampA = Math.min(6, h * 0.045) * (0.4 + 0.6 * Math.min(1, level * 2));
  const ampB = ampA * 0.6;
  const step = Math.max(3, Math.floor(w / 48));

  // water body
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(0, surfaceY);
  for (let x = 0; x <= w; x += step) {
    const t = x / w;
    const y = surfaceY
      + Math.sin(t * Math.PI * 2 * 1.3 + entry.waterPhase) * ampA
      + Math.sin(t * Math.PI * 2 * 2.7 - entry.waterPhase * 1.4) * ampB;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, surfaceY, 0, h);
  grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.40)`);
  grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.16)`);
  ctx.fillStyle = grad;
  ctx.fill();

  // bright meniscus riding the surface
  ctx.beginPath();
  for (let x = 0; x <= w; x += step) {
    const t = x / w;
    const y = surfaceY
      + Math.sin(t * Math.PI * 2 * 1.3 + entry.waterPhase) * ampA
      + Math.sin(t * Math.PI * 2 * 2.7 - entry.waterPhase * 1.4) * ampB;
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.7)`;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.stroke();

  // Full stage: the whole box goes green under the number (text is flipped to
  // dark ink by CSS so it stays readable in both themes).
  if (stage === "full") {
    const full = ctx.createLinearGradient(0, 0, 0, h);
    full.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.92)`);
    full.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.78)`);
    ctx.fillStyle = full;
    roundRectPath(ctx, w, h, 0, 18);
    ctx.fill();
  }

  // Hot/full stage: ONE minimal line — a faint static hairline as the track
  // plus a single bright runner going around it. Under reduced-motion the
  // runner parks and only the hairline shows.
  if (stage === "hot" || stage === "full") {
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    roundRectPath(ctx, w, h, 3, 15);
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.35)`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (!MOTION_REDUCED) {
      const total = rrTotal(w, h, 15, 3);
      const head = (entry.waterPhase || 0) * 120;
      const len = total * 0.10;
      ctx.strokeStyle = "rgba(240, 255, 244, 0.95)";
      ctx.lineWidth = 2.5;
      ctx.shadowColor = `rgba(${r}, ${g}, ${b}, 0.9)`;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      const N = 16;
      for (let i = 0; i <= N; i++) {
        const pt = rrPointAt(w, h, 15, 3, head - (len * i) / N);
        if (i === 0) ctx.moveTo(pt[0], pt[1]);
        else ctx.lineTo(pt[0], pt[1]);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}

const MOTION_REDUCED = typeof matchMedia === "function"
  && matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Pop the PARTS number when a part finishes (transform-only: no layout move). */
function bumpParts(el) {
  if (!el || !el.classList) return;
  el.classList.remove("is-bump");
  void el.offsetWidth;
  el.classList.add("is-bump");
}

/* ms-epoch -> local HH:MM:SS wall clock. */
function fmtWallClock(ts) {
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return "—";
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* Counter history (jobs timeline counts + last-part timing). Haas reports
 * m30c1; the Hurco reports Part_Count/PartCount — first non-empty wins. */
function cntRowsFor(per) {
  const cands = [per.m30c1, per.Part_Count, per.PartCount];
  for (const c of cands) if (Array.isArray(c) && c.length) return c;
  return [];
}

/* Program-name history (jobs timeline rows). Haas reports ncprog; the Hurco
 * reports Program_Name_Running — first non-empty wins, skipping the blank and
 * UNAVAILABLE markers the Hurco emits between jobs. */
function progRowsFor(per) {
  const cands = [per.ncprog, per.Program_Name_Running];
  for (const c of cands) {
    if (!Array.isArray(c) || !c.length) continue;
    const rows = c.filter((r) => r && r.val && r.val !== '""' && r.val !== "UNAVAILABLE");
    if (rows.length) return rows;
  }
  return [];
}

/* ms age -> "45s ago" / "5m ago" / "2h ago" / "3d ago". Older than 30 days
 * (stale history or an unset controller clock) reads as a calendar date. */
function fmtAgo(ms) {
  if (!Number.isFinite(Number(ms)) || ms < 0) return "—";
  const s = Math.floor(Number(ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 90) return `${d}d ago`;
  // Older than 90 days: unset controller clock (1970-era), not real age
  return "—";
}

/* When the current counter segment's last part finished, from history (µs ts
 * normalized). A drop is an operator reset and restarts the answer. */
function lastHistRiseAt(machineId) {
  const hist = histCache.get(machineId);
  const rows = hist ? hist.cnt.slice().sort((a, b) => a.ts - b.ts) : [];
  let last = null, at = 0;
  for (const r of rows) {
    const v = r.val_num;
    if (v == null || Number.isNaN(v)) continue;
    if (last == null) { last = v; continue; }
    if (v > last) {
      const t = tsMs(r.ts);
      if (Number.isFinite(t)) at = t;
    } else if (v < last) at = 0;
    last = v;
  }
  return at;
}

/* Read the card's themed --machine-accent-rgb as an [r,g,b] triple, cached per
 * card (invalidated on theme change in updateCard). */
function readAccent(root) {
  // only read computed style when the card is in the DOM;
  // getComputedStyle returns empty custom props for disconnected elements.
  if (!root || !root.isConnected) return null;  // caller retries next frame (null is falsy)
  try {
    const v = getComputedStyle(root).getPropertyValue("--machine-accent-rgb").trim();
    const parts = v.split(",").map((n) => parseInt(n, 10));
    if (parts.length === 3 && parts.every(Number.isFinite)) return parts;
  } catch (_) {}
  return [22, 163, 74];
}

/* Single animation frame loop drives every card's cycle display.
 * Cycle/spindle numbers tween at full refresh (cheap text writes), but the
 * GPU/CPU-heavy painters — the 2D wave/water canvases and the 3D orbit — are
 * throttled to ~30fps and skipped entirely for cards scrolled out of view. One
 * bad canvas can't take down the loop: each card's paint is isolated in
 * try/catch. */
const ORBIT_INTERVAL_MS = 33; // ~30fps for the GPU-heavy toolpath render
const WAVE_INTERVAL_MS = 33;  // ~30fps for the 2D spindle-wave + parts-water canvases

let lastFrameTs = 0;
let lastWaveTs = 0;
function paintLoop(now) {
  let dt = lastFrameTs ? (now - lastFrameTs) / 1000 : 0.016;
  if (dt > 0.1) dt = 0.1;                 // clamp after a tab-background stall
  lastFrameTs = now;
  // throttle the heavy 2D canvases to ~30fps; feed them the real elapsed time
  // since the last wave paint so the animation speed is unchanged.
  const waveDue = !lastWaveTs || (now - lastWaveTs) >= WAVE_INTERVAL_MS;
  let waveDt = waveDue ? (lastWaveTs ? (now - lastWaveTs) / 1000 : dt) : 0;
  if (waveDt > 0.1) waveDt = 0.1;
  if (waveDue) lastWaveTs = now;
  for (const entry of cardEls.values()) {
    try {
      paintCycle(entry);
      paintShift(entry);
      paintIdle(entry);
      paintSpindle(entry, dt);
      paintParts(entry);
      if (waveDue && entry.onScreen !== false) { paintSpindleWave(entry, waveDt); paintPartsWater(entry, waveDt); }
      const due = !entry.lastOrbit || (now - entry.lastOrbit) >= ORBIT_INTERVAL_MS;
      if (due && entry.onScreen !== false) {
        paintToolpath(entry);
        entry.lastOrbit = now;
      }
    } catch (_) { /* isolate a failing card — never freeze the whole fleet */ }
  }
  requestAnimationFrame(paintLoop);
}

/* ---------- summary chips ----------
 * Built once, then only the count numbers are patched. */
const chipEls = new Map(); // key -> { count }
const CHIP_DEFS = [
  ["running", "Running"],
  ["idle", "Idle"],
  ["alarm", "Alarm"],
  ["offline", "Offline"],
];

function buildChips() {
  const host = document.getElementById("summaryChips");
  if (host.childElementCount) return;
  for (const [cls, label] of CHIP_DEFS) {
    const chip = document.createElement("span");
    chip.className = `chip ${cls}`;
    const count = document.createElement("span");
    count.className = "chip-count";
    chip.innerHTML = `<span class="chip-dot"></span>${label} `;
    chip.appendChild(count);
    host.appendChild(chip);
    chipEls.set(cls, { count });
  }
}

function updateChips(summary) {
  const s = summary || {};
  for (const [cls] of CHIP_DEFS) {
    const ref = chipEls.get(cls);
    if (ref) setText(ref.count, s[cls] ?? 0);
  }
}

/* Recompute the fleet summary from DERIVED statuses so the top chips agree with
 * the cards. PAUSED and SETUP/MANUAL fold into "idle" (matching the mission
 * dashboard); alarm/e_stop into "alarm"; offline/unavailable into "offline". */
function summarize(machines) {
  const s = { running: 0, idle: 0, alarm: 0, offline: 0, total: machines.length };
  for (const m of machines) {
    const st = deriveStatus(m);
    if (st === "running") s.running += 1;
    else if (st === "alarm" || st === "e_stop") s.alarm += 1;
    else if (st === "offline" || st === "unavailable") s.offline += 1;
    else s.idle += 1; // idle, paused, setup_manual, unknown
  }
  return s;
}

/* ---------- connection state ---------- */
function setConn(live, text) {
  dom.conn.className = "conn " + (live ? "live" : "down");
  dom.connText.textContent = text;
}

/* ---------- 3D toolpath renderer ----------
 * Real machine data only. Each poll the backend hands us position{x,y,z} (the
 * live cutting-tool tip, normalized from both controller flavours). We CACHE the
 * points client-side per machine and draw the path the tool has traced this
 * cycle — it grows 0->100% as the machine runs. On a new path (program change,
 * part_count bump, or a cycle roll-over) we CLEAR the cache and start fresh.
 *
 * PRODUCING GATE (proven against the DB): a machine can be "running" in
 * maintenance/test with the tool parked (e.g. O00000.nc => zero motion). We only
 * reveal the 3D once the cached path shows real travel (bbox span over a few mm);
 * idle/parked machines keep the slot hidden and the card does NOT collapse.
 *
 * Three.js loads as an ES module (see index.html) and is published on window.THREE.
 * If it hasn't arrived yet the whole feature no-ops gracefully. */

const MAX_TRAIL = 4000;          // cap cached points per machine (memory guard)
const PRODUCING_SPAN_MM = 4;     // bbox must exceed this on some axis to be "real"
const PRODUCING_MIN_PTS = 5;     // and have at least this many distinct samples

// Per-segment operation colours. We can't read feedrate on the DT machines
// (only Haas VF expose mfdrate, and those sit idle), so we classify each step
// GEOMETRICALLY from the cached XYZ: a Z-dominant move is a plunge/drill, an
// XY move is a cut, a big jump is a rapid reposition. Verified live on an
// active machine (drill/mill/rapid all separable from the path alone).
const OP_DRILL = { r: 0.98, g: 0.62, b: 0.07 };  // amber  — plunge / drilling
const OP_MILL  = { r: 0.13, g: 0.83, b: 0.93 };  // cyan   — cutting / milling
const OP_RAPID = { r: 0.42, g: 0.45, b: 0.55 };  // grey   — rapid / non-cut move
const OP_PAUSE = { r: 0.98, g: 0.62, b: 0.07 };  // orange — paused-state tracking
const RAPID_MM = 8;              // step longer than this = rapid traverse
const PLUNGE_RATIO = 0.6;        // Z share of motion above this = plunge/drill
const PLUNGE_MIN_MM = 0.2;       // ...and Z must actually move this much

let THREE_READY = !!window.THREE;
window.addEventListener("three-ready", () => { THREE_READY = true; });

/* Build a tiny self-contained 3D scene bound to one canvas. */
function makeScene(canvas) {
  const THREE = window.THREE;
  // Read layout size before creating the renderer — on first restore the card may
  // not be laid out yet (clientWidth=0). Clamp to 4 so the context isn't 1×1;
  // the paint loop's resize logic corrects it on the next frame when layout is real.
  const w = Math.max(canvas.clientWidth, 4);
  const h = Math.max(canvas.clientHeight, 4);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true,
                                             powerPreference: "low-power" });
  // These canvases are tiny (~150px tall). Forcing pixelRatio 1 (instead of 2 on
  // retina) cuts the rendered pixel count 4x with no visible quality loss.
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);

  // cyan toolpath with a per-vertex trail fade (older = dim, tip = bright).
  const geom = new THREE.BufferGeometry();
  const positions = new Float32Array(MAX_TRAIL * 3);
  const colors = new Float32Array(MAX_TRAIL * 3);
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geom.setDrawRange(0, 0);
  const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 });
  const line = new THREE.Line(geom, mat);
  scene.add(line);

  // glowing head at the current tip
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xeafdff })
  );
  scene.add(head);

  const sc = { THREE, renderer, scene, camera, line, geom, positions, colors, head, mat,
               group: line, theta: 0, canvas, lost: false };

  // A WebGL context can be dropped by the browser (too many contexts, GPU reset,
  // tab backgrounded). Without handling it the canvas goes black forever. We flag
  // the loss so the paint loop skips it, and on restore we let updateToolpath
  // rebuild the scene from scratch.
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); sc.lost = true; }, false);
  canvas.addEventListener("webglcontextrestored", () => { sc.lost = false; }, false);

  return sc;
}

/* Free a scene's GPU resources. Called when a card leaves the fleet so dead
 * WebGL contexts don't pile up (browsers cap live contexts ~16 and start
 * killing the oldest, which is what black cards look like). */
function disposeScene(sc) {
  if (!sc) return;
  try {
    sc.geom.dispose();
    sc.mat.dispose();
    sc.head.geometry.dispose();
    sc.head.material.dispose();
    sc.renderer.dispose();
    const ext = sc.renderer.getContext().getExtension("WEBGL_lose_context");
    if (ext) ext.loseContext();
  } catch (_) { /* already gone — fine */ }
}

/* ---------- toolpath cache persistence ----------
 * The point trail lives in JS memory, so a hard-refresh used to wipe it (you'd
 * see "17 pts" again from zero). We persist the CURRENT part's trail to
 * localStorage keyed by machine + part (program|partCount). On reload we restore
 * it instantly, so the path renders whole right away. When the part changes the
 * old key is dropped and we start fresh — exactly the "store this part, erase on
 * next part" behaviour. Trails are decimated on save to stay inside the quota.
 */
const TP_STORE_PREFIX = "vmc_tp_";
const TP_SAVE_EVERY_MS = 2000;       // throttle writes so we don't hammer storage
const TP_SAVE_MAX_PTS = 1500;        // decimate before persisting (quota guard)

function tpStoreKey(machineId) { return TP_STORE_PREFIX + machineId; }

function loadTrail(machineId, key) {
  try {
    const raw = localStorage.getItem(tpStoreKey(machineId));
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || o.key !== key || !Array.isArray(o.pts)) return null;  // stale part -> ignore
    return o.pts;
  } catch (_) { return null; }
}

function saveTrail(machineId, key, pts) {
  try {
    let out = pts;
    if (pts.length > TP_SAVE_MAX_PTS) {                 // even-stride decimation, keep the tip
      const stride = Math.ceil(pts.length / TP_SAVE_MAX_PTS);
      out = [];
      for (let i = 0; i < pts.length; i += stride) out.push(pts[i]);
      if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
    }
    localStorage.setItem(tpStoreKey(machineId), JSON.stringify({ key, pts: out }));
  } catch (_) { /* quota or disabled storage — non-fatal, memory cache still works */ }
}

function clearTrail(machineId) {
  try { localStorage.removeItem(tpStoreKey(machineId)); } catch (_) {}
}

/* Push the latest position into the cache; handle reset transitions. */
function updateToolpath(entry, m) {
  const refs = entry.refs;
  const slot = refs.toolpath;
  if (!slot) return;

  const pos = m.position;
  const status = deriveStatus(m);
  const online = !!m.online;
  const program = m.active_program || "";
  const partCount = m.part_count_total ?? m.part_count;
  const machineId = m.machine_id || m.machine_name || entry.id || "";

  // reset key: a new path begins when program OR part count changes.
  const key = `${program}|${partCount}`;
  const tp = entry.tp || (entry.tp = { pts: [], key: null, lastSeen: null, savedAt: 0 });
  if (tp.key !== key) {
    // Try to restore THIS part from storage FIRST (so a refresh mid-part comes
    // back whole). Only if storage holds a DIFFERENT part do we wipe it and
    // start from zero — that's the "next part erases the old one" behaviour.
    const restored = loadTrail(machineId, key);
    if (restored) {
      tp.pts = restored;
    } else {
      clearTrail(machineId);                           // stale/other part -> drop it
      tp.pts = [];
    }
    tp.key = key;
    tp.savedAt = 0;
    entry.tpShown = false;   // new program/part: re-earn the 3D, never inherit it
    entry.tpFrozen = false;
  }

  // cache the point (skip exact dupes so a parked tool doesn't pad the trail)
  if (online && pos && Number.isFinite(pos.x)) {
    const last = tp.pts[tp.pts.length - 1];
    if (!last || last.x !== pos.x || last.y !== pos.y || last.z !== pos.z) {
      tp.pts.push({ x: pos.x, y: pos.y, z: pos.z });
      if (tp.pts.length > MAX_TRAIL) tp.pts.shift();
      // throttled persist of the current part's trail
      const now = Date.now();
      if (now - tp.savedAt > TP_SAVE_EVERY_MS) {
        saveTrail(machineId, key, tp.pts);
        tp.savedAt = now;
      }
    }
  }

  // Per-device pref, default off: keep caching points (instant re-enable) but
  // never build a scene. The whole block hides — this is an explicit user
  // choice, not data flicker, so the reserved-slot rule does not apply here.
  if (dashPrefs.toolpath !== "on") {
    if (entry.scene) { disposeScene(entry.scene); entry.scene = null; }
    entry.tpFrozen = false;
    entry.tpDirty = false;
    slot.classList.remove("toolpath--frozen");
    slot.hidden = true;
    setText(refs.toolpathTag, "TOOLPATH OFF");
    return;
  }

  // Show the 3D for machines that are working — running OR paused. A "paused"
  // machine (spindle idling but execution ACTIVE) is often still repositioning
  // behind the scenes; we want to SEE that movement, not blank it out.
  //
  // Hysteresis kills the flicker: once a card has a real path, keep it shown as
  // long as it's online and the program hasn't changed. Without this, a spindle
  // hovering around the 100 RPM running/paused threshold flips state every poll
  // and the panel strobes.
  //
  // The slot itself is permanently reserved: a fault (offline, alarm, e-stop)
  // or a fresh path with no travel yet NEVER hides it, so the card cannot
  // collapse. Only the mode changes — live, frozen on the last frame, or
  // empty — and the tag always says which.
  const working = status === "running" || status === "paused";
  const hasRealPath = isProducing(tp.pts);
  const blocked = !online || status === "offline" || status === "alarm" || status === "e_stop";
  if (!blocked && working && hasRealPath) entry.tpShown = true;
  const live = THREE_READY && !blocked && (working || entry.tpShown) && (hasRealPath || entry.tpShown);
  const frozen = THREE_READY && !live && (hasRealPath || entry.tpShown) && tp.pts.length >= 2;

  if (slot.hidden) slot.hidden = false;
  slot.classList.toggle("toolpath--frozen", frozen);
  if ((live || frozen) && !entry.scene) {
    // lazily spin up the scene the first time there is something to show
    try { entry.scene = makeScene(refs.toolpathCanvas); }
    catch (e) { entry.scene = null; }
    if (entry.scene) bindZoom(entry);
  }
  if (live) {
    // colour mode: paused -> whole trail orange (tracking the repositioning tool);
    // running -> per-segment colours by operation type (drill / mill / rapid).
    entry.tpPaused = status === "paused";
    entry.tpFrozen = false;
    entry.tpDirty = true;                              // tell the raf loop to redraw
    setText(refs.toolpathTag,
      `${status === "paused" ? "TRACKING" : "TOOLPATH"} · ${tp.pts.length} pts`);
  } else if (frozen && entry.scene) {
    entry.tpFrozen = true;
    entry.tpDirty = true;                              // upload the final points once
    setText(refs.toolpathTag, `FROZEN · ${tp.pts.length} pts`);
  } else {
    entry.tpFrozen = false;
    setText(refs.toolpathTag, "TOOLPATH —");
  }
}

/* Real travel test — bounding-box span across cached points. */
function isProducing(pts) {
  if (pts.length < PRODUCING_MIN_PTS) return false;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  return (maxX - minX) > PRODUCING_SPAN_MM
      || (maxY - minY) > PRODUCING_SPAN_MM
      || (maxZ - minZ) > PRODUCING_SPAN_MM;
}

/* Wire the +/- zoom buttons for one card's scene. Zoom scales the orbit radius:
 * higher zoom = camera closer = bigger path. Clamped to a sane range. */
function bindZoom(entry) {
  const refs = entry.refs;
  if (entry.zoom == null) entry.zoom = 1;
  const step = (factor) => {
    entry.zoom = Math.max(0.4, Math.min(4, entry.zoom * factor));
  };
  if (refs.zoomIn) refs.zoomIn.addEventListener("click", (e) => { e.stopPropagation(); step(1.25); });
  if (refs.zoomOut) refs.zoomOut.addEventListener("click", (e) => { e.stopPropagation(); step(0.8); });
}

/* Redraw one card's scene: upload cached points centered+scaled to fit, slow orbit.
 * A frozen card renders one static frame (no orbit) and then holds it — the
 * canvas keeps the last picture instead of collapsing or blanking. */
function paintToolpath(entry) {
  if (dashPrefs.toolpath !== "on") return;
  if (!entry.scene || !entry.tp || entry.refs.toolpath.hidden) return;
  const sc = entry.scene;
  if (sc.lost) return;                                 // context dropped — skip until restored
  const pts = entry.tp.pts;
  if (pts.length < 2) {
    // Fresh program with no travel yet: blank the canvas instead of leaving
    // the previous part's frame behind, then hold the empty slot.
    if (entry.tpDirty) {
      sc.geom.setDrawRange(0, 0);
      sc.renderer.render(sc.scene, sc.camera);
      entry.tpDirty = false;
    }
    return;
  }

  // canvas sizing (cheap; only resizes the drawingbuffer when the box changed)
  const cv = sc.renderer.domElement;
  const w = cv.clientWidth || 1, h = cv.clientHeight || 1;
  if (cv.width !== w || cv.height !== h) {
    sc.renderer.setSize(w, h, false);
    sc.camera.aspect = w / h;
    sc.camera.updateProjectionMatrix();
  }

  // only re-upload geometry when new points landed
  if (entry.tpDirty) {
    let cx = 0, cy = 0, cz = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const p of pts) {
      cx += p.x; cy += p.y; cz += p.z;
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    const n = pts.length;
    cx /= n; cy /= n; cz /= n;
    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
    const s = 2.4 / span;                              // fit into a ~unit box
    // Per-vertex colour. Two modes:
    //  - paused  -> whole trail orange (we're just tracking where the tool moves)
    //  - running -> classify each segment by its motion and colour it:
    //               Z-dominant = drill (amber), XY = mill (cyan), big jump = rapid (grey)
    // Trail fade rides on top: brightness ramps old(dim) -> tip(bright).
    const paused = entry.tpPaused;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      sc.positions[i * 3]     = (p.x - cx) * s;
      sc.positions[i * 3 + 1] = (p.z - cz) * s;        // CNC Z (depth) -> screen up
      sc.positions[i * 3 + 2] = (p.y - cy) * s;
      let c;
      if (paused) {
        c = OP_PAUSE;
      } else {
        const q = pts[i > 0 ? i - 1 : 0];
        const dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > RAPID_MM) c = OP_RAPID;
        else if (Math.abs(dz) > PLUNGE_RATIO * d && Math.abs(dz) > PLUNGE_MIN_MM) c = OP_DRILL;
        else c = OP_MILL;
      }
      const f = 0.18 + 0.82 * (i / (n - 1 || 1));      // 0.18 (old) -> 1.0 (tip)
      sc.colors[i * 3]     = c.r * f;
      sc.colors[i * 3 + 1] = c.g * f;
      sc.colors[i * 3 + 2] = c.b * f;
    }
    sc.geom.attributes.position.needsUpdate = true;
    sc.geom.attributes.color.needsUpdate = true;
    sc.geom.setDrawRange(0, n);
    sc.line.frustumCulled = false;                     // camera always looks at origin; skip the per-update bounding-sphere cost
    const tip = pts[n - 1];
    sc.head.position.set((tip.x - cx) * s, (tip.z - cz) * s, (tip.y - cy) * s);
    // tip colour = the trail colour of the final vertex (already written above),
    // brightened toward white so the live tool head stands out.
    const hc = { r: sc.colors[(n - 1) * 3], g: sc.colors[(n - 1) * 3 + 1], b: sc.colors[(n - 1) * 3 + 2] };
    sc.head.material.color.setRGB(
      Math.min(1, hc.r + 0.5), Math.min(1, hc.g + 0.5), Math.min(1, hc.b + 0.5));
    entry.tpDirty = false;
  }

  // slow auto-orbit so the shape reads as 3D — skipped while frozen, so the
  // fault frame holds its angle instead of drifting behind the dimmed tag.
  const r = 4.2 / (entry.zoom || 1);
  sc.camera.position.set(Math.cos(sc.theta) * r, 2.1 / (entry.zoom || 1), Math.sin(sc.theta) * r);
  sc.camera.lookAt(0, 0, 0);
  sc.renderer.render(sc.scene, sc.camera);
  if (!entry.tpFrozen) sc.theta += 0.0065;
}

/* ---------- per-program part count (frontend-only) ----------
 * "How many parts has the CURRENT program made in its current run?"
 *
 * The collector stores everything; it doesn't derive this. We do it client-side
 * WITHOUT polling history on a loop — history is fetched EXACTLY ONCE per machine
 * (a one-time seed). After that the live /api/overview poll (which already carries
 * active_program + part_count_total every second) drives the number locally. No
 * repeated history requests.
 *
 * Sequence rule (not "all historical runs of the same name"): we count only the
 * CURRENT CONTIGUOUS sequence. The count restarts from scratch when either
 *   - the active program changes, or
 *   - the M30 counter resets (drops) — m30c1 is NOT a pure lifetime counter; an
 *     operator can zero it, which begins a new run.
 * So the badge is always consistent with the machine's own counter (never higher).
 *
 * Seed history fields:
 *   item=ncprog : program-active timeline (val = program name)
 *   item=m30c1  : the M30 part counter (val_num)
 *
 * Bounded by recorded history: parts finished before logging began aren't visible. */
/* Seed scan ceiling. Measured live: ncprog is sparse (11–31 rows) and m30c1 runs
 * ~130–305 rows per machine, so 2000 covers the full current contiguous run with
 * headroom while shrinking the server-side scan vs the old 5000. Not the real
 * bottleneck (that was boot concurrency, now gated) — just trimming waste. */
const PROG_HIST_LIMIT = 2000;
const progCache = new Map(); // machine_id -> { prog, count, lastCounter, startedAt, seeded }
const histCache = new Map(); // machine_id -> { prog: ncprog rows, cnt: m30c1 rows } for the jobs timeline
let histRefreshTimer = null;

// One-time seed: replay history for ONLY the current contiguous sequence.
// Returns { prog, count, lastCounter, startedAt, prevProg, prevCount } or null.
function seedFromHistory(progRows, cntRows) {
  const prog = progRows.slice().sort((a, b) => a.ts - b.ts);
  const cnt = cntRows.slice().sort((a, b) => a.ts - b.ts);
  if (!prog.length) return null;

  // current program = the last contiguous program in the timeline; its run
  // begins at the first sample of that final unbroken stretch.
  const timeline = [];
  for (const r of prog) {
    if (!r.val) continue;
    if (!timeline.length || timeline[timeline.length - 1].name !== r.val) {
      timeline.push({ ts: r.ts, name: r.val });
    }
  }
  if (!timeline.length) return null;
  const curProg = timeline[timeline.length - 1].name;
  const startTs = timeline[timeline.length - 1].ts; // start of current contiguous run
  // previous contiguous run (if any): the segment immediately before the current.
  const prevSeg = timeline.length >= 2 ? timeline[timeline.length - 2] : null;
  const prevStartTs = prevSeg ? prevSeg.ts : null;

  // Count the parts produced inside a single contiguous run [from, to). The M30
  // counter (m30c1) is not a pure lifetime value — an operator can zero it — so
  // we accumulate only positive rises and restart the segment on any reset.
  function countRun(from, to) {
    let count = 0;
    let last = null;
    for (const r of cnt) {
      const v = r.val_num;
      if (v == null || Number.isNaN(v)) continue;
      if (r.ts < from) { last = v; continue; }     // before this run: just track counter
      if (to != null && r.ts >= to) break;          // past this run
      if (last == null) { last = v; continue; }      // first sample inside the run: baseline
      if (v > last) count += v - last;               // normal rise
      else if (v < last) count = v;                   // reset -> new segment starts at v
      last = v;
    }
    return { count: Math.round(count), last };
  }

  const cur = countRun(startTs, null);
  const prev = prevSeg ? countRun(prevStartTs, startTs) : null;

  return {
    prog: curProg,
    count: cur.count,
    lastCounter: cur.last,
    startedAt: startTs,
    prevProg: prevSeg ? prevSeg.name : null,
    prevCount: prev ? prev.count : null,
  };
}

/* ---------- seed scheduler (thundering-herd guard) ----------
 * The part-count seed needs ncprog + m30c1 history for every machine. The old
 * way fired 2×N separate history calls and hammered the link on boot. Now a
 * SINGLE /api/history_bulk request (items=ncprog,m30c1, limit=PROG_HIST_LIMIT)
 * returns both items for ALL machines at once (mirrors the collector's
 * timeline_bulk). We still hold it until the first LIVE overview has painted,
 * so the one bulk call never competes with first paint.
 * The seed is non-critical — the live poll already maintains the count. */
let seedGateOpen = false;       // flips true after the first successful live poll
let seedStarted = false;        // the one bulk seed has been kicked

function openSeedGate() {
  if (seedGateOpen) return;
  seedGateOpen = true;
  bulkSeed();
}

// One bulk request seeds every machine's part-count history. Fire-and-forget.
function bulkSeed() {
  if (seedStarted || !seedGateOpen) return;
  seedStarted = true;
  const url = `${state.apiBase}/api/history_bulk?items=ncprog,m30c1,Part_Count,PartCount,Program_Name_Running&limit=${PROG_HIST_LIMIT}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), OVERVIEW_TIMEOUT_MS);
  fetch(url, { signal: ctrl.signal, cache: "no-store" })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then((data) => {
      clearTimeout(t);
      const machines = (data && data.machines) || {};
      for (const machineId of Object.keys(machines)) {
        const per = machines[machineId] || {};
        const progRows = progRowsFor(per);
        const cntRows = cntRowsFor(per);
        histCache.set(machineId, { prog: progRows, cnt: cntRows });
        const entry = cardEls.get(machineId);
        if (entry) { paintProgTimeline(entry); entry.lastPartHistAt = lastHistRiseAt(machineId); }
        const res = seedFromHistory(progRows, cntRows);
        const cur = progCache.get(machineId) || {};
        cur.seeded = true;
        if (res) {
          cur.prog = res.prog; cur.count = res.count;
          cur.lastCounter = res.lastCounter; cur.startedAt = res.startedAt;
          cur.prevProg = res.prevProg; cur.prevCount = res.prevCount;
        }
        progCache.set(machineId, cur);
      }
      scheduleHistRefresh();
    })
    .catch(() => {
      clearTimeout(t);
      // don't retry-storm; the live overview poll still maintains the count and
      // re-seeds a machine on its next program change. Allow a later retry.
      seedStarted = false;
    });
}

/* Slow re-fetch of the same bulk payload so the jobs timeline stays fresh
 * across a shift. One request for all machines; skips while the tab is hidden. */
const HIST_REFRESH_MS = 5 * 60 * 1000;
function scheduleHistRefresh() {
  if (histRefreshTimer) return;
  histRefreshTimer = setInterval(refreshProgHistory, HIST_REFRESH_MS);
}
function refreshProgHistory() {
  if (typeof document !== "undefined" && document.hidden) return;
  const url = `${state.apiBase}/api/history_bulk?items=ncprog,m30c1,Part_Count,PartCount,Program_Name_Running&limit=${PROG_HIST_LIMIT}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), OVERVIEW_TIMEOUT_MS);
  fetch(url, { signal: ctrl.signal, cache: "no-store" })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then((data) => {
      clearTimeout(t);
      const machines = (data && data.machines) || {};
      for (const machineId of Object.keys(machines)) {
        const per = machines[machineId] || {};
        histCache.set(machineId, {
          prog: progRowsFor(per),
          cnt: cntRowsFor(per),
        });
        const entry = cardEls.get(machineId);
        if (entry) { paintProgTimeline(entry); entry.lastPartHistAt = lastHistRiseAt(machineId); }
      }
    })
    .catch(() => { clearTimeout(t); });
}

// Per-poll update driven entirely by live overview data (no network). Maintains
// the current-sequence count from active_program + part_count_total.
function updateProgParts(machineId, activeProgram, counterRaw) {
  if (!machineId) return null;
  let c = progCache.get(machineId);
  if (!c) { c = {}; progCache.set(machineId, c); }
  if (!c.seeded) bulkSeed();  // ensure the one-shot bulk seed has been kicked (no-op once done/in-flight)

  const counter = Number(counterRaw);
  if (!activeProgram || !Number.isFinite(counter)) return c.prog ? c : null;

  if (c.prog !== activeProgram) {
    // program changed (or first sight after a failed seed): roll the segment we
    // were counting into "previous", then start a fresh sequence. We only carry
    // a real prior run forward — not the empty pre-seed state.
    if (c.prog && Number.isFinite(c.count)) {
      c.prevProg = c.prog;
      c.prevCount = c.count;
    }
    c.prog = activeProgram;
    c.count = 0;
    c.lastCounter = counter;
    c.startedAt = Date.now() * 1000; // µs, best-effort for a live switch
    return c;
  }
  if (c.lastCounter == null) { c.lastCounter = counter; return c; }
  if (counter > c.lastCounter) c.count = (c.count || 0) + (counter - c.lastCounter);
  else if (counter < c.lastCounter) c.count = counter; // live counter reset -> new segment
  c.lastCounter = counter;
  return c;
}

/* ---------- poll loop ----------
 * Self-scheduling: on success we poll again at the steady POLL_MS cadence; on
 * repeated failure we back off exponentially (POLL_MS → 2× → 4× …, capped) so a
 * dead/unreachable collector isn't hammered once a second forever. Any success
 * snaps the cadence straight back to POLL_MS. */
const POLL_BACKOFF_MAX_MS = 30000;
function scheduleNextPoll() {
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  if (document.hidden) return;                 // visibilitychange re-arms on return
  const delay = state.failStreak > 0
    ? Math.min(POLL_MS * Math.pow(2, state.failStreak), POLL_BACKOFF_MAX_MS)
    : POLL_MS;
  state.timer = setTimeout(poll, delay);
}

async function poll() {
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  if (state.inFlight) return;
  state.inFlight = true;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), OVERVIEW_TIMEOUT_MS);
    const resp = await fetch(`${state.apiBase}/api/overview`, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(t);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    render(data);
    saveDashSnap(data);
    state.failStreak = 0;
    setConn(true, "live");
    openSeedGate();                 // first real paint is up — now drain the history seeds
    // Broadcast the fresh payload so the alert engine reuses it instead of
    // running a second independent /api/overview poller against the same (heavy,
    // ~4s) endpoint. One poll feeds the whole page.
    try { window.dispatchEvent(new CustomEvent("vmc-overview", { detail: data })); } catch (_) {}
  } catch (err) {
    state.failStreak += 1;
    setConn(false, state.failStreak > 3 ? "disconnected" : "retrying…");
  } finally {
    state.inFlight = false;
    scheduleNextPoll();
  }
}

function render(data) {
  const grid = dom.grid;
  const note = dom.note;
  const machines = Array.isArray(data.machines) ? data.machines : [];

  buildChips();
  updateChips(summarize(machines));
  // Footer clock. Two different stamps, and they mean different things:
  //   data_updated_at_ms — freshest per-machine row time = DATA freshness
  //   updated_at         — when the API built this response
  // Prefer the data stamp; it is the one an operator actually cares about. Both
  // go through msFromEpochLoose, which rescues a seconds-emitting collector (the
  // original 1970 footer bug) without corrupting real millisecond values.
  const dataMs = msFromEpochLoose(data.data_updated_at_ms);
  const respMs = msFromEpochLoose(data.updated_at);
  if (dataMs != null) {
    setText(dom.updatedAt, `data ${new Date(dataMs).toLocaleTimeString()}`);
    setAttr(dom.updatedAt, "title", respMs != null
      ? `Newest stored machine data: ${new Date(dataMs).toLocaleString()} · API response built: ${new Date(respMs).toLocaleString()}`
      : `Newest stored machine data: ${new Date(dataMs).toLocaleString()}`);
  } else if (respMs != null) {
    setText(dom.updatedAt, `response ${new Date(respMs).toLocaleTimeString()}`);
    setAttr(dom.updatedAt, "title", `API response built: ${new Date(respMs).toLocaleString()} · no stored machine data yet`);
  } else {
    setText(dom.updatedAt, "—");
    setAttr(dom.updatedAt, "title", "No data timestamp reported");
  }

  if (!machines.length) {
    note.hidden = false;
  } else {
    note.hidden = true;
  }

  const seen = new Set();
  machines.forEach((m, i) => {
    seen.add(m.machine_id);
    let entry = cardEls.get(m.machine_id);
    if (!entry) {
      entry = buildCard(m);
      entry.onScreen = true;                           // assume visible until observer says otherwise
      cardEls.set(m.machine_id, entry);
      if (cardObserver) { rootToEntry.set(entry.root, entry); cardObserver.observe(entry.root); }
    }
    updateCard(entry, m);
    // keep DOM order matching payload order without reflowing unchanged nodes
    const atPos = grid.children[i];
    if (atPos !== entry.root) grid.insertBefore(entry.root, atPos || null);
  });

  // drop cards for machines no longer reported
  for (const [id, entry] of cardEls) {
    if (!seen.has(id)) {
      if (cardObserver) { cardObserver.unobserve(entry.root); rootToEntry.delete(entry.root); }
      disposeScene(entry.scene);                       // free GPU context, no leak
      entry.scene = null;
      entry.root.remove();
      cardEls.delete(id);
    }
  }

}

/* ---------- fullscreen: go to the dedicated wall page ----------
 * The wall is its OWN page, not an overlay stuffed into this one. `/tv` on this
 * same port serves the kiosk skin (kiosk.rs is_kiosk_path), where tv.js owns
 * paging, rotation, the wall settings panel and the exit control. Navigating
 * there instead of faking fullscreen in place is what keeps one board in one
 * place: a real URL you can bookmark, put in a shortcut, or type on the TV.
 *
 * Deliberately a navigation, not requestFullscreen(): the Fullscreen API needs
 * a user gesture, never survives a reload, and cannot give the TV a URL to boot
 * into. The wall page has its own "Full screen" button for the F11-style frame. */
const TV_WALL_PATH = "/tv";
function gotoWallBoard() {
  try { window.location.assign(window.location.origin + TV_WALL_PATH); }
  catch (_) { window.location.href = TV_WALL_PATH; }
}
function setupFullscreen() {
  const btn = document.getElementById("fsBtn");
  if (btn) {
    btn.title = "Open the wall board (/tv)";
    btn.addEventListener("click", gotoWallBoard);
  }
}

/* ---------- dashboard settings panel ----------
 * Display + card options + part counts. Per device (LS_DASH_PREFS); everything
 * applies to THIS page only — there is no cross-port preview and no writable
 * endpoint. Fixed overlay: opens from the topbar button and inside fullscreen;
 * Esc/backdrop closes. */
/* ---------- shared settings sections ----------
 * Canonical Display + Machine cards + Profile sections, rendered with IDENTICAL
 * structure and wording in the dashboard panel (buildDashCfg below) and the
 * wall panel (tv.js buildPanel). One definition so the two panels can never
 * drift apart again. `cls` carries the panel's own theme classes:
 * dashboard passes {sec:"dash-cfg-sec",title:"dash-cfg-sec-t",row:"dash-cfg-row"},
 * wall passes {sec:"tv-panel-section",title:"tv-panel-section-title",row:"tv-panel-row"}.
 * Values flow through the adapter: eff() = merged effective prefs,
 * patch() = active-scope patch, set(key,val), after(kind) = repaint follow-up,
 * doExport()/doImport() = profile copy. Dotted keys address previewSections. */
const DASH_SECTIONS_ZOOM_OPTS = '<option value="0">Auto</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="1.75">175%</option><option value="2">200%</option>';
function dashSectionsHTML(cls, only) {
  const want = (name) => !only || only.indexOf(name) !== -1;
  const S = (name, title, inner) =>
    `<div class="${cls.sec}" data-ss="${name}"><div class="${cls.title}">${title}</div>${inner}</div>`;
  let out = "";
  if (want("display")) out += S("display", "Display", `
      <label class="${cls.row}"><input type="checkbox" data-dc="summary" /><span>Summary section</span></label>
      <label class="${cls.row}"><input type="checkbox" data-dc="shifts" /><span>Shifts section</span></label>
      <div class="${cls.row}"><label>Board scale</label><select data-dc="zoom">${DASH_SECTIONS_ZOOM_OPTS}</select></div>`);
  if (want("cards")) out += S("cards", "Machine cards", `
      <div class="${cls.row}"><label>Toolpath</label><select data-dc="toolpath">
        <option value="off">Off</option><option value="on">On</option></select></div>
      <label class="${cls.row}"><input type="checkbox" data-dc="art" /><span>Shift art</span></label>
      <label class="${cls.row}"><input type="checkbox" data-dc="compact" /><span>Compact timings</span></label>
      <label class="${cls.row}"><input type="checkbox" data-dc="ranked" /><span>Ranked part counts (last 5 programs)</span></label>
      <label class="${cls.row}"><input type="checkbox" data-dc="spindleParts" /><span>Part count instead of RPM graph</span></label>`);
  if (want("profile")) out += S("profile", "Profile", `
      <div class="${cls.row}"><span class="${cls.hint}">Global settings copy to another display by export → import.</span></div>
      <div class="${cls.row} ${cls.btns}">
        <button type="button" class="${cls.btn}" data-dc="export">Export…</button>
        <button type="button" class="${cls.btn}" data-dc="import">Import…</button>
      </div>`);
  return out;
}
function wireDashSections(root, cls, a) {
  const q = (k) => root.querySelector(`[data-dc="${k}"]`);
  const els = {
    summary: q("summary"), shifts: q("shifts"), zoom: q("zoom"),
    toolpath: q("toolpath"), art: q("art"), compact: q("compact"), ranked: q("ranked"),
    spindleParts: q("spindleParts"),
  };
  const sync = () => {
    const eff = a.eff() || {};
    const patch = a.patch() || {};
    const effSub = eff.previewSections || {};
    const patchSub = patch.previewSections || {};
    const val = (k) => (Object.prototype.hasOwnProperty.call(patch, k) ? patch[k] : eff[k]);
    const sub = (k) => (Object.prototype.hasOwnProperty.call(patchSub, k) ? patchSub[k] : effSub[k]);
    if (els.summary) els.summary.checked = !!sub("summary");
    if (els.shifts) els.shifts.checked = !!sub("shifts");
    if (els.zoom) els.zoom.value = String(val("boardZoom") || 0);
    if (els.toolpath) els.toolpath.value = val("toolpath") === "on" ? "on" : "off";
    if (els.art) els.art.checked = !!val("shiftArt");
    if (els.compact) els.compact.checked = !!val("compactTimings");
    if (els.ranked) els.ranked.checked = !!val("rankedCounts");
    if (els.spindleParts) els.spindleParts.checked = !!val("spindleParts");
  };
  const on = (el, ev, fn) => { if (el) el.addEventListener(ev, fn); };
  on(els.summary, "change", () => { a.set("previewSections.summary", els.summary.checked); a.after("dom"); sync(); });
  on(els.shifts, "change", () => { a.set("previewSections.shifts", els.shifts.checked); a.after("dom"); sync(); });
  on(els.zoom, "change", () => { a.set("boardZoom", Number(els.zoom.value)); a.after("dom"); sync(); });
  on(els.toolpath, "change", () => { a.set("toolpath", els.toolpath.value === "on" ? "on" : "off"); a.after("card"); sync(); });
  on(els.art, "change", () => { a.set("shiftArt", els.art.checked); a.after("dom"); sync(); });
  on(els.compact, "change", () => { a.set("compactTimings", els.compact.checked); a.after("card"); sync(); });
  on(els.ranked, "change", () => { a.set("rankedCounts", els.ranked.checked); a.after("dom"); sync(); });
  on(els.spindleParts, "change", () => { a.set("spindleParts", els.spindleParts.checked); a.after("dom"); sync(); });
  on(q("export"), "click", () => a.doExport());
  on(q("import"), "click", () => a.doImport());
  sync();
  return { sync };
}
window.__VMC_DASH_SECTIONS__ = { html: dashSectionsHTML, wire: wireDashSections };
let dashCfgEls = null;
function buildDashCfg() {
  const backdrop = document.createElement("div");
  backdrop.className = "dash-cfg-backdrop";
  backdrop.hidden = true;
  const panel = document.createElement("section");
  panel.className = "dash-cfg-panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Display and card settings");
  const DCLS = { sec: "dash-cfg-sec", title: "dash-cfg-sec-t", row: "dash-cfg-row", hint: "dash-cfg-hint", btn: "dash-cfg-btn", btns: "dash-cfg-row-btns" };
  panel.innerHTML = `
    <div class="dash-cfg-head">
      <span class="dash-cfg-title">DISPLAY &amp; CARD SETTINGS</span>
      <button type="button" class="dash-cfg-x" data-c="close" title="Close">✕</button>
    </div>
    <div class="dash-cfg-tabs" role="tablist">
      <button type="button" class="dash-cfg-tab is-active" data-scope="global" role="tab">Global</button>
      <button type="button" class="dash-cfg-tab" data-scope="device" role="tab">This display</button>
    </div>
    <div class="dash-cfg-scopenote" data-c="scopenote"></div>
    <div class="dash-cfg-body">
    ${dashSectionsHTML(DCLS, ["display", "cards"])}
    <div class="dash-cfg-sec">
      <div class="dash-cfg-sec-t">Wall board</div>
      <div class="dash-cfg-hint">The wall is its own page at <code>/tv</code>. Slide time, paging, machines
        and timeline are managed on the wall — those values live on that display.</div>
      <button type="button" class="dash-cfg-btn dash-cfg-btn-wide" data-c="startPreview">⛶ Open wall board (/tv)</button>
    </div>
    <div class="dash-cfg-sec">
      <div class="dash-cfg-sec-t">Machines &amp; order</div>
      <div class="dash-cfg-hint">The wall fleet order and excludes live on the wall display.</div>
      <button type="button" class="dash-cfg-btn dash-cfg-btn-wide" data-c="openWall">Manage on the wall (/tv)</button>
    </div>
    <div class="dash-cfg-sec">
      <div class="dash-cfg-sec-t">Timeline step</div>
      <div class="dash-cfg-hint">Range pinned: Hour · Follows wall machines · Timing set on the wall.</div>
    </div>
    <div class="dash-cfg-sec">
      <div class="dash-cfg-sec-t">Collector</div>
      <div class="dash-cfg-row"><input type="text" data-c="api" spellcheck="false" /></div>
      <div class="dash-cfg-row dash-cfg-row-btns">
        <button type="button" class="dash-cfg-btn" data-c="apiApply">Apply</button>
      </div>
      <div class="dash-cfg-hint" data-c="apinote"></div>
    </div>
    ${dashSectionsHTML(DCLS, ["profile"])}
    </div>
    <div class="dash-cfg-foot">
      <button type="button" class="dash-cfg-btn dash-cfg-save" data-c="save">Done</button>
      <button type="button" class="dash-cfg-btn" data-c="reset" title="Restore defaults">Reset</button>
    </div>
    <div class="dash-cfg-note" data-c="note">Saved on this device.</div>`;
  document.body.appendChild(backdrop);
  document.body.appendChild(panel);
  const q = (s) => panel.querySelector(`[data-c="${s}"]`);
  const els = {
    backdrop, panel,
    scopenote: q("scopenote"), note: q("note"),
    tabs: [].slice.call(panel.querySelectorAll(".dash-cfg-tab")),
  };
  // Scope tabs decide which layer a change writes to. Device wins at render.
  els.tabs.forEach((tab) => tab.addEventListener("click", () => {
    dashScope = tab.dataset.scope === "device" ? "device" : "global";
    els.tabs.forEach((t) => t.classList.toggle("is-active", t === tab));
    syncDashCfgControls();
  }));
  // Card/display rows are the SHARED sections (same markup as the wall panel).
  const dashAdapter = {
    eff: () => dashPrefs,
    patch: () => scopePatch(),
    set: (key, value) => setPref(key, value),
    after: (kind) => {
      applyPrefsToDom();
      if (kind === "card") applyCardPrefs();
      for (const entry of cardEls.values()) {
        const box = entry.refs.parts ? entry.refs.parts.closest(".machine-card-box-parts") : null;
        if (box) box.classList.toggle("is-ranked", dashPrefs.rankedCounts);
      }
      updateScopeNote();
    },
    doExport: () => exportDashProfile(),
    doImport: () => importDashProfile(els.note),
  };
  const shared = wireDashSections(panel, DCLS, dashAdapter);
  els.shared = shared;
  const goWall = () => { closeDashCfg(); gotoWallBoard(); };
  q("startPreview").addEventListener("click", goWall);
  q("openWall").addEventListener("click", goWall);
  // Collector endpoint, inline. The old blocking prompt() is gone: walls have
  // no keyboard and a modal boot-stopper is unacceptable there.
  els.api = q("api"); els.apinote = q("apinote");
  els.api.value = state.apiBase;
  const apiNote = (msg) => { if (els.apinote) els.apinote.textContent = msg; };
  q("apiApply").addEventListener("click", () => {
    const next = (els.api.value || "").trim().replace(/\/+$/, "");
    if (!next) { apiNote("Enter a base URL, e.g. http://127.0.0.1:9994"); return; }
    state.apiBase = next;
    try { localStorage.setItem("vmc_api_base", next); } catch (_) {}
    const label = document.getElementById("apiLabel");
    if (label) label.textContent = next;
    apiNote("Saved. Polling " + next + ".");
    poll();
  });
  q("save").addEventListener("click", closeDashCfg);
  q("reset").addEventListener("click", () => {
    // Reset clears the ACTIVE scope only, so resetting "This display" falls back
    // to global rather than wiping the whole install.
    try { localStorage.removeItem(scopeStoreKey()); } catch (_) {}
    resolveDashPrefs();
    applyPrefsToDom(); syncDashCfgControls(); applyCardPrefs();
  });
  q("close").addEventListener("click", closeDashCfg);
  backdrop.addEventListener("click", closeDashCfg);
  return els;
}
function updateScopeNote() {
  const els = dashCfgEls;
  if (!els) return;
  const overrides = Object.keys(dashDevice).length;
  if (dashScope === "device") {
    els.scopenote.textContent = overrides
      ? `This display overrides ${overrides} setting${overrides === 1 ? "" : "s"} from Global.`
      : "This display follows Global. Change anything here to override it.";
  } else {
    els.scopenote.textContent = "The base look every mode inherits. Export to copy to other displays.";
  }
}
function syncDashCfgControls() {
  const els = dashCfgEls;
  if (!els) return;
  // Card/display rows are synced by the shared sections; the API field tracks
  // the live base (it can also change from the topbar gear).
  if (els.shared) els.shared.sync();
  if (els.api) els.api.value = state.apiBase;
  updateScopeNote();
}
/* Export the GLOBAL profile as a downloadable JSON file. Global is the shared
 * base, so exporting it (not the device overrides) is what copies a look. */
function exportDashProfile() {
  try {
    const blob = new Blob([JSON.stringify(sanitizePrefPatch(dashGlobal), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "vmc-wall-profile.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (_) {}
}
/* Import a profile file into GLOBAL, replacing it, then re-resolve + repaint. */
function importDashProfile(noteEl) {
  const note = (msg) => {
    const el = noteEl || (dashCfgEls && dashCfgEls.note);
    if (el) el.textContent = msg;
  };
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "application/json,.json";
  inp.addEventListener("change", () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const patch = sanitizePrefPatch(JSON.parse(String(reader.result)));
        localStorage.setItem(LS_DASH_GLOBAL, JSON.stringify(patch));
        resolveDashPrefs();
        applyPrefsToDom(); syncDashCfgControls(); applyCardPrefs();
        note("Profile imported into Global.");
      } catch (_) {
        note("Import failed — not a valid profile file.");
      }
    };
    reader.readAsText(file);
  });
  inp.click();
}
function openDashCfg() {
  dashCfgEls || (dashCfgEls = buildDashCfg());
  syncDashCfgControls();
  dashCfgEls.backdrop.hidden = false;
  dashCfgEls.panel.hidden = false;
}
function closeDashCfg() {
  if (!dashCfgEls) return;
  dashCfgEls.backdrop.hidden = true;
  dashCfgEls.panel.hidden = true;
}
/* Re-render live cards from the last poll payload after a pref change. */
function applyCardPrefs() {
  for (const entry of cardEls.values()) {
    if (!entry.lastM) continue;
    try { updateCard(entry, entry.lastM); } catch (_) {}
  }
}
function setupDashCfg() {
  const btn = document.getElementById("dashCfgBtn");
  if (!btn) return;
  btn.title = "Display and card settings";
  btn.addEventListener("click", () => {
    if (dashCfgEls && !dashCfgEls.panel.hidden) closeDashCfg();
    else openDashCfg();
  });
}

/* ---------- ranked PARTS popover ----------
 * Current program count big + last 5 programs by recency (phase 1: history
 * ncprog order; m30c1 segments supply counts where measurable). Fixed
 * overlay, so the card never reflows. Disabled when rankedCounts is off. */
let partsPopEls = null;
function countSegParts(cnt, from, to) {
  let count = 0, last = null, seen = false;
  for (const r of cnt) {
    const v = r.val_num;
    if (v == null || Number.isNaN(v)) continue;
    if (r.ts < from) { last = v; continue; }
    if (to != null && r.ts >= to) break;
    if (last == null) { last = v; continue; }
    if (v > last) { count += v - last; seen = true; }
    else if (v < last) { count = v; seen = true; }
    last = v;
  }
  return seen ? Math.round(count) : null;
}
/* Jobs timeline: current program plus earlier runs, painted only when the
 * underlying data changes (signature guard) so polls never churn the DOM. */
/* History timestamps are microseconds (the store convention — see the µs
 * startedAt in updateProgParts); wall-clock math needs ms. Magnitude-gated so
 * ms input passes through untouched. */
function tsMs(ts) {
  const v = Number(ts);
  if (!Number.isFinite(v)) return NaN;
  return v > 1e14 ? v / 1000 : v;
}
function progAge(ts) {
  if (!Number.isFinite(Number(ts))) return "—";
  const s = Math.max(0, Math.round((Date.now() - tsMs(ts)) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}M`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}H`;
  const d = Math.floor(h / 24);
  if (d < 90) {
    if (d < 7) return `${d}D`;
    return `${Math.floor(d / 7)}W`;
  }
  // Older than 90 days: unset controller clock (1970-era), not real age
  return "—";
}
function progTimelineRow(doc, cur, name, meta) {
  const li = doc.createElement("li");
  li.className = cur ? "prog-tl-row prog-tl-cur" : "prog-tl-row";
  const dot = doc.createElement("span");
  dot.className = "prog-tl-dot";
  dot.textContent = cur ? "" : "✓";
  const nm = doc.createElement("span");
  nm.className = "prog-tl-name";
  nm.textContent = name;
  nm.title = name;
  const mm = doc.createElement("span");
  mm.className = "prog-tl-meta";
  mm.textContent = meta;
  li.append(dot, nm, mm);
  return li;
}
function paintProgTimeline(entry) {
  const refs = entry.refs;
  const list = refs && refs.progTimelineList;
  if (!list) return;
  const m = entry.lastM || {};
  const machineId = m.machine_id || (entry.root && entry.root.dataset.machine) || "";
  const prog = m.active_program || "";
  const cached = progCache.get(machineId) || {};
  const liveCount = (cached.prog === prog && Number.isFinite(cached.count)) ? cached.count
    : (m.part_count_total ?? m.part_count);
  const hist = histCache.get(machineId);
  const rows = hist ? rankProgRuns(hist.prog, hist.cnt, prog).slice(0, 4) : [];
  const sig = `${prog}|${liveCount}|${rows.map((r) => `${r.name}:${r.count}`).join(",")}`;
  if (entry.tlSig === sig) return;
  entry.tlSig = sig;
  list.innerHTML = "";
  const doc = list.ownerDocument;
  // Five slots always: the box keeps one fixed height on every card, so a
  // machine with no earlier jobs never collapses its section out of line.
  const TOTAL_SLOTS = 5;
  let rendered = 0;
  if (!prog && !rows.length) {
    const li = doc.createElement("li");
    li.className = "prog-tl-row prog-tl-empty";
    li.textContent = "No jobs yet.";
    list.appendChild(li);
    rendered = 1;
  } else {
    if (prog) {
      list.appendChild(progTimelineRow(doc, true, prog,
        `${Number.isFinite(liveCount) ? fmtInt(liveCount) : "—"} · now`));
      rendered = 1;
    }
    for (const r of rows) {
      if (rendered >= TOTAL_SLOTS) break;
      list.appendChild(progTimelineRow(doc, false, r.name,
        `${r.count != null ? fmtInt(r.count) : "—"} · ${progAge(r.from)}`));
      rendered++;
    }
  }
  for (let i = rendered; i < TOTAL_SLOTS; i++) {
    const li = doc.createElement("li");
    li.className = "prog-tl-row prog-tl-pad";
    li.setAttribute("aria-hidden", "true");
    const dot = doc.createElement("span");
    dot.className = "prog-tl-dot";
    const nm = doc.createElement("span");
    nm.className = "prog-tl-name";
    nm.textContent = " ";
    const mm = doc.createElement("span");
    mm.className = "prog-tl-meta";
    mm.textContent = " ";
    li.append(dot, nm, mm);
    list.appendChild(li);
  }
}
function rankProgRuns(progRows, cntRows, currentProg) {
  const prog = progRows.slice().sort((a, b) => {
    const tsDiff = a.ts - b.ts;
    // Tiebreak twin rows: ts is microseconds, so 1e6 is a 1-second window.
    if (Math.abs(tsDiff) <= 1e6 && Number.isFinite(a.ingested_at) && Number.isFinite(b.ingested_at)) {
      return a.ingested_at - b.ingested_at;
    }
    return tsDiff;
  });
  const cnt = cntRows.slice().sort((a, b) => a.ts - b.ts);
  const timeline = [];
  for (const r of prog) {
    if (!r.val) continue;
    if (!timeline.length || timeline[timeline.length - 1].name !== r.val) timeline.push({ ts: r.ts, name: r.val });
  }
  const runs = [];
  for (let i = timeline.length - 1; i >= 0 && runs.length < 6; i--) {
    runs.push({ name: timeline[i].name, from: timeline[i].ts, to: i + 1 < timeline.length ? timeline[i + 1].ts : null });
  }
  const out = [];
  for (let i = 0; i < runs.length && out.length < 5; i++) {
    if (i === 0 && runs[i].name === currentProg) continue;
    out.push({ name: runs[i].name, from: runs[i].from, count: countSegParts(cnt, runs[i].from, runs[i].to) });
  }
  return out;
}
function buildPartsPop() {
  const backdrop = document.createElement("div");
  backdrop.className = "parts-pop-backdrop";
  backdrop.hidden = true;
  const pop = document.createElement("section");
  pop.className = "parts-pop";
  pop.hidden = true;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Ranked part counts");
  pop.innerHTML = `
    <div class="parts-pop-head">
      <span class="parts-pop-title"></span>
      <button type="button" class="parts-pop-x" title="Close">✕</button>
    </div>
    <div class="parts-pop-big"></div>
    <div class="parts-pop-sub">LAST 5 PROGRAMS · RECENCY RANKED</div>
    <div class="parts-pop-list"></div>
    <div class="parts-pop-foot">Phase 1: recency from history; lifetime counts follow.</div>`;
  document.body.appendChild(backdrop);
  document.body.appendChild(pop);
  const els = {
    backdrop, pop,
    title: pop.querySelector(".parts-pop-title"),
    big: pop.querySelector(".parts-pop-big"),
    list: pop.querySelector(".parts-pop-list"),
  };
  pop.querySelector(".parts-pop-x").addEventListener("click", closePartsPop);
  backdrop.addEventListener("click", closePartsPop);
  return els;
}
function renderPartsRows(els, rows) {
  els.list.innerHTML = "";
  if (!rows.length) {
    const d = document.createElement("div");
    d.className = "parts-pop-empty";
    d.textContent = "No earlier programs in history.";
    els.list.appendChild(d);
    return;
  }
  rows.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "parts-pop-row";
    const rank = document.createElement("span");
    rank.className = "parts-pop-rank";
    rank.textContent = String(i + 1);
    const name = document.createElement("span");
    name.className = "parts-pop-name";
    name.textContent = r.name;
    name.title = r.name;
    const count = document.createElement("span");
    count.className = "parts-pop-count";
    count.textContent = r.count == null ? "—" : fmtInt(r.count);
    row.appendChild(rank);
    row.appendChild(name);
    row.appendChild(count);
    els.list.appendChild(row);
  });
}
function openPartsPop(machineId) {
  if (!dashPrefs.rankedCounts || !machineId) return;
  const els = partsPopEls || (partsPopEls = buildPartsPop());
  const entry = cardEls.get(machineId);
  const m = (entry && entry.lastM) || {};
  const prog = m.active_program || "";
  const cached = progCache.get(machineId) || {};
  const curCount = (cached.prog === prog && Number.isFinite(cached.count)) ? cached.count : null;
  els.title.textContent = prog ? `PARTS · ${prog}` : "PARTS";
  els.big.textContent = curCount != null ? fmtInt(curCount) : "—";
  els.list.innerHTML = "";
  const loading = document.createElement("div");
  loading.className = "parts-pop-empty";
  loading.textContent = "Loading history…";
  els.list.appendChild(loading);
  els.backdrop.hidden = false;
  els.pop.hidden = false;
  const url = `${state.apiBase}/api/history_bulk?items=ncprog,m30c1,Part_Count,PartCount,Program_Name_Running&limit=${PROG_HIST_LIMIT}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), OVERVIEW_TIMEOUT_MS);
  fetch(url, { signal: ctrl.signal, cache: "no-store" })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then((data) => {
      clearTimeout(t);
      const per = (data && data.machines && data.machines[machineId]) || {};
      histCache.set(machineId, {
        prog: progRowsFor(per),
        cnt: cntRowsFor(per),
      });
      if (entry) paintProgTimeline(entry);
      const rows = rankProgRuns(
        progRowsFor(per),
        cntRowsFor(per), prog);
      if (!rows.length && cached.prevProg) rows.push({ name: cached.prevProg, count: cached.prevCount ?? null });
      renderPartsRows(els, rows);
    })
    .catch(() => {
      clearTimeout(t);
      const rows = cached.prevProg ? [{ name: cached.prevProg, count: cached.prevCount ?? null }] : [];
      renderPartsRows(els, rows);
    });
}
function closePartsPop() {
  if (!partsPopEls) return;
  partsPopEls.backdrop.hidden = true;
  partsPopEls.pop.hidden = true;
}
function setupPartsPop() {
  if (!dom.grid) return;
  dom.grid.addEventListener("click", (e) => {
    if (!dashPrefs.rankedCounts) return;
    const box = e.target && e.target.closest ? e.target.closest(".machine-card-box-parts") : null;
    if (!box || !dom.grid.contains(box)) return;
    const card = box.closest(".machine-card");
    if (card && card.dataset.machine) openPartsPop(card.dataset.machine);
  });
}
/* Esc closes popover first, then the settings panel. */
function setupDashOverlays() {
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (partsPopEls && !partsPopEls.pop.hidden) { closePartsPop(); return; }
    if (dashCfgEls && !dashCfgEls.panel.hidden) closeDashCfg();
  });
}

/* ---------- config ---------- */
function setupConfig() {
  document.getElementById("apiLabel").textContent = state.apiBase;
  // The gear opens settings (Collector section edits the endpoint inline).
  // The old blocking prompt() is gone on purpose: wall boards have no
  // keyboard, and a modal dialog stops the whole page.
  document.getElementById("cfgBtn").addEventListener("click", () => {
    openDashCfg();
  });
}

/* ---------- card dark/light toggle ----------
 * Flips html[data-theme] between "dark" and "light". Only the mission-card
 * inner panel reacts (see the [data-theme="dark"] .machine-card block in
 * cards.css); the board, nav and god-mode views are unaffected. Default = dark.
 * Cached canvas accents are re-read on the next paint, so no redraw call needed. */
function setupTheme() {
  const btn = document.getElementById("themeBtn");
  const apply = (mode) => {
    document.documentElement.setAttribute("data-theme", mode);
    if (btn) {
      btn.textContent = mode === "dark" ? "☾" : "☀";
      btn.title = mode === "dark"
        ? "Cards: dark — click for light"
        : "Cards: light — click for dark";
    }
    // drop cached card accents so canvases re-read panel-correct colors
    cardEls.forEach((entry) => { if (entry) entry.accentRGB = null; });
    // re-tint the dot-matrix for the new theme
    if (typeof window.__vmcAuroraRetint === "function") window.__vmcAuroraRetint();
    // notify canvas-drawn views (timeline, etc.) to repaint with theme colors
    window.dispatchEvent(new CustomEvent("vmc-theme", { detail: { mode } }));
  };
  apply(localStorage.getItem("vmc_theme") || "dark");
  if (btn) {
    btn.addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      localStorage.setItem("vmc_theme", next);
      apply(next);
    });
  }
}

/* ---------- boot ---------- */
function start() {
  cacheDom();
  setupTheme();
  setupConfig();
  setupFullscreen();
  setupDashCfg();
  setupPartsPop();
  setupDashOverlays();
  applyPrefsToDom();
  // Instant cold-start paint: show the last good board from the device snapshot
  // while the first (possibly slow 3-13s) /api/overview is still in flight.
  const snap = loadDashSnap();
  if (snap) {
    try {
      render(snap);
      setConn(false, "cached");
    } catch (_) {}
  }
  poll();                       // poll() self-schedules the next tick
  requestAnimationFrame(paintLoop);
  // The mission cards draw a real WebGL toolpath, so three.js IS needed here —
  // but defer the ~600KB pull until just after first paint (idle) so it never
  // blocks the cards/poll from showing. The 3D tab also triggers this loader.
  const pullThree = () => { if (typeof window.__vmcLoadThree === "function") window.__vmcLoadThree(); };
  if ("requestIdleCallback" in window) requestIdleCallback(pullThree, { timeout: 2000 });
  else setTimeout(pullThree, 800);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  } else if (!state.timer) {
    poll();                     // resume; poll() re-arms the scheduler
  }
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
