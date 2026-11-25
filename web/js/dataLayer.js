/* VMC God-mode — shared data layer.
 *
 * The single gateway to the collector for the two new sections (Analytical +
 * Plan) and the alert engine. Everything here is READ-ONLY against the existing
 * endpoints — no backend change. It gives the new modules three things:
 *
 *   1. windowed history pulls (/api/history) with a short cache so three widgets
 *      asking for the same item in the same window hit the network once;
 *   2. a shared time WINDOW selector (shift / day / week) the UI can flip;
 *   3. a uniform CONFIDENCE badge derived from /api/gap_audit, so every metric
 *      can declare how complete the data behind it is.
 *
 * The mission-card app.js is never imported or touched. This module reads the
 * same `vmc_api_base` localStorage key app.js uses so both honour the ⚙ config.
 */

const API_BASE = () => {
  // Mirror app.js: default the collector base to THIS page's host on :8091 so a
  // LAN/Tailscale visitor doesn't hit their own 127.0.0.1. ⚙ override still wins.
  const h = (typeof location !== "undefined" && location.hostname) ? location.hostname : "127.0.0.1";
  const cp = (typeof window !== "undefined" && window.__VMC_COLLECTOR_PORT__) || 9994;
  return (localStorage.getItem("vmc_api_base") || `http://${h}:${cp}`).replace(/\/+$/, "");
};

/* history values arrive newest-first; ts is in MICROSECONDS. */
const US_PER_MS = 1000;
const MS = { min: 60000, hour: 3600000, day: 86400000 };

/* ---------- time windows ---------- */
/* A window is {key,label,from,to} in ms. "shift" snaps to the most recent shift
 * boundary (configurable; default three 8h shifts starting 06:00 local). */
const WINDOW_DEFS = [
  { key: "shift", label: "Shift" },
  { key: "today", label: "Today" },
  { key: "day", label: "24 h" },
  { key: "week", label: "7 d" },
];

let currentWindowKey = localStorage.getItem("vmc_ds_window") || "today";
const windowListeners = new Set();

function shiftStart(now = Date.now()) {
  // shifts at 06:00 / 14:00 / 22:00 local — walk back to the last boundary.
  const d = new Date(now);
  const h = d.getHours();
  const startHour = h >= 22 ? 22 : h >= 14 ? 14 : h >= 6 ? 6 : 22;
  const s = new Date(d);
  if (startHour === 22 && h < 6) s.setDate(s.getDate() - 1); // pre-dawn -> prev 22:00
  s.setHours(startHour, 0, 0, 0);
  return s.getTime();
}

// midnight (00:00 local) of the day containing `now` — the calendar-day anchor.
function dayStart(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* Quantize "now" to a 60s grid. The window's `to` bound otherwise advances every
 * single tick (Date.now()), which changes every cache/memo key and forces the
 * whole per-machine history fan-out to refetch on every 15s refresh — the burst
 * seen in the network log. Snapping `to` to a 60s step means the URLs are
 * identical for a full minute, so the dataLayer caches + metrics memo actually
 * hit and a refresh tick costs ~0 network until the minute rolls over. */
const NOW_QUANTUM_MS = 60000;
function quantNow(now = Date.now()) { return Math.floor(now / NOW_QUANTUM_MS) * NOW_QUANTUM_MS; }

function resolveWindow(key = currentWindowKey, now = quantNow()) {
  if (key === "shift") return { key, label: "Shift", from: shiftStart(now), to: now };
  if (key === "today") return { key, label: "Today", from: dayStart(now), to: now };
  if (key === "week") return { key, label: "7 d", from: now - 7 * MS.day, to: now };
  return { key: "day", label: "24 h", from: now - MS.day, to: now };
}

function getWindowKey() { return currentWindowKey; }
function setWindowKey(key) {
  if (!WINDOW_DEFS.some((w) => w.key === key) || key === currentWindowKey) return;
  currentWindowKey = key;
  localStorage.setItem("vmc_ds_window", key);
  for (const fn of windowListeners) { try { fn(resolveWindow()); } catch (_) {} }
}
function onWindowChange(fn) { windowListeners.add(fn); return () => windowListeners.delete(fn); }

/* ---------- request scheduler (global concurrency gate) ----------
 * Every read in this module routes through one scheduler so the whole app can
 * never open more than MAX_INFLIGHT connections to the collector at once. This
 * is what keeps a heavy tab (metrics fires 8 history calls × 5 machines = 40
 * requests) from saturating the SSH-tunnelled link and starving the small,
 * latency-critical calls (overview/health) that paint the live UI.
 *
 *   - MAX_INFLIGHT caps concurrency (the tunnel pools ~6 connections/host; we
 *     stay under it and leave headroom for the EventSource stream + app.js poll).
 *   - Two priority lanes: HIGH (overview, health, gap_audit — tiny + critical)
 *     always dispatch before LOW (bulk history/series/events) so a 40-call
 *     analytics fan-out can never queue in front of the grid's overview.
 *   - In-flight de-dup: identical concurrent URLs share ONE network request,
 *     so N widgets asking for the same item in the same tick hit the wire once.
 */
const MAX_INFLIGHT = 4;
const PRIO = { HIGH: 0, LOW: 1 };
const HIGH_PATHS = ["/api/overview", "/api/health", "/api/gap_audit", "/api/machines"];
let schedInflight = 0;
const schedQueue = [];                 // [{prio, run, resolve, reject}]
const schedDedup = new Map();          // url -> Promise (shared while in flight)

function schedPump() {
  // higher priority (lower number) first; FIFO within a lane (stable splice)
  while (schedInflight < MAX_INFLIGHT && schedQueue.length) {
    let bi = 0;
    for (let i = 1; i < schedQueue.length; i++) {
      if (schedQueue[i].prio < schedQueue[bi].prio) bi = i;
    }
    const job = schedQueue.splice(bi, 1)[0];
    schedInflight += 1;
    job.run().then(job.resolve, job.reject).finally(() => {
      schedInflight -= 1;
      schedPump();
    });
  }
}

// Schedule a thunk through the gate at the given priority.
function schedule(run, prio = PRIO.LOW) {
  return new Promise((resolve, reject) => {
    schedQueue.push({ prio, run, resolve, reject });
    schedPump();
  });
}

function prioForPath(path) {
  return HIGH_PATHS.some((p) => path.startsWith(p)) ? PRIO.HIGH : PRIO.LOW;
}

/* ---------- fetch helpers ---------- */
/* Endpoint-specific timeouts matched to measured reality. Bulk/aggregate endpoints
 * get generous budgets; cheap ones stay tight so genuine outages are detected quickly.
 * Measured latencies (45s curl, sequential):
 *   /api/overview            >45s (timed out)
 *   /api/history_range_bulk  43.2s
 *   /api/items (VMC-04)      44.1s
 *   /api/audit (VMC-04)      35.1s
 *   /api/losses (VMC-04)     25.2s
 *   /api/gap_audit (VMC-04)  19.0s
 *   /api/series              21.7s
 *   /api/history_bulk        17.9s
 *   /api/stats               12.1s
 *   /api/timeline_bulk       2.6s
 *   /api/parts               6-7s
 *   healthy: /api/health, /api/machines, /api/observations, /api/history, /api/history_range, /api/shift_summary
 */
const ENDPOINT_TIMEOUTS = {
  '/api/overview': 50000,           // 50s — slowest endpoint, critical for dashboard
  '/api/history_range_bulk': 50000, // 50s — bulk aggregate, used by KPI/Analytics/DataLab
  '/api/items': 50000,              // 50s — per-machine item fetch, can be very slow
  '/api/audit': 40000,              // 40s — audit endpoint
  '/api/losses': 30000,             // 30s — loss ledger
  '/api/gap_audit': 25000,          // 25s — gap audit for confidence badges
  '/api/series': 25000,             // 25s — down-sampled series
  '/api/history_bulk': 20000,       // 20s — bulk history (recent, limit-based)
  '/api/stats': 15000,              // 15s — statistics endpoint
  '/api/events': 15000,             // 15s — event log (was 12s, slightly increased)
  '/api/timeline_bulk': 30000,      // 30s — timeline bulk over wide windows can be slow; skeleton stays up meanwhile
  '/api/parts': 10000,              // 10s — parts endpoint (measured 6-7s)
  '/api/health': 3000,              // 3s — health check must be fast
  '/api/machines': 5000,            // 5s — machine list
  '/api/observations': 5000,        // 5s — observations
  '/api/history': 10000,            // 10s — single-machine history
  '/api/history_range': 15000,      // 15s — ranged history
  '/api/shift_summary': 5000,       // 5s — shift summary
  '/api/stream': 0,                 // SSE — no timeout
};

function timeoutForPath(path) {
  // Match the most specific prefix
  for (const [prefix, timeout] of Object.entries(ENDPOINT_TIMEOUTS)) {
    if (path.startsWith(prefix)) return timeout;
  }
  return 12000; // Default fallback for unknown endpoints (slightly increased from 9s)
}

/* Retry with exponential backoff for aggregate endpoints. Bounded to avoid hammering
 * an already-wedged collector (global mutex contention). Only retries transient
 * failures (timeouts, network errors); HTTP 4xx/5xx are terminal. */
const RETRY_PATHS = [
  '/api/overview',
  '/api/history_range_bulk',
  '/api/history_bulk',
  '/api/items',
  '/api/audit',
  '/api/gap_audit',
];
const MAX_RETRIES = 2;               // total attempts = 3 (initial + 2 retries)
const RETRY_BASE_MS = 1000;          // 1s base delay
const RETRY_MAX_MS = 5000;           // cap at 5s

function shouldRetry(path) {
  return RETRY_PATHS.some(p => path.startsWith(p));
}

async function fetchWithRetry(url, options, timeout, maxRetries) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = timeout > 0 ? setTimeout(() => ctrl.abort(), timeout) : null;
    try {
      const resp = await fetch(url, { ...options, signal: ctrl.signal, cache: "no-store" });
      if (timer) clearTimeout(timer);
      if (!resp.ok) {
        // HTTP errors are terminal — don't retry 404/500
        const err = new Error(`HTTP ${resp.status}`);
        err.status = resp.status;
        err.terminal = true;
        throw err;
      }
      return await resp.json();
    } catch (err) {
      if (timer) clearTimeout(timer);
      // Terminal errors (HTTP 4xx/5xx) don't retry
      if (err.terminal) throw err;
      lastError = err;
      // Out of retries?
      if (attempt >= maxRetries) throw err;
      // Exponential backoff with jitter
      const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, attempt));
      const jitter = Math.random() * backoff * 0.3; // ±30% jitter
      await new Promise(resolve => setTimeout(resolve, backoff + jitter));
    }
  }
  throw lastError;
}

async function getJSON(path, { timeout, dedup = true } = {}) {
  const url = `${API_BASE()}${path}`;
  const effectiveTimeout = timeout !== undefined ? timeout : timeoutForPath(path);
  
  // Share an identical in-flight request (e.g. several widgets pulling the same
  // item in the same refresh tick). Only safe for idempotent reads — all GETs.
  if (dedup && schedDedup.has(url)) return schedDedup.get(url);

  const run = async () => {
    const retries = shouldRetry(path) ? MAX_RETRIES : 0;
    return await fetchWithRetry(url, {}, effectiveTimeout, retries);
  };

  const p = schedule(run, prioForPath(path));
  if (dedup) {
    schedDedup.set(url, p);
    // NB: .catch(()=>{}) so this bookkeeping chain never surfaces as an unhandled
    // rejection when p rejects (e.g. a timeout abort). Real awaiters still get the
    // rejection from their own reference to p.
    p.finally(() => { if (schedDedup.get(url) === p) schedDedup.delete(url); }).catch(() => {});
  }
  return p;
}

/* ---------- history (recent, limit-based) — MICRO-BATCHED ----------
 * The backend's /api/history takes (machine,item,limit), newest-first, no
 * from/to. Maintenance pulls several items across all machines this way (5x3),
 * so — exactly like historyWindow — we batch every history() call fired in the
 * same tick into ONE /api/history_bulk request (all machines, the union of
 * items, shared limit) and hand each caller its slice. A short per-(machine,
 * item,limit) cache still serves repeats. */
const HIST_LIMIT = 5000;
const histBatch = new Map(); // limit -> { items:Set, waiters:[{machine,item,resolve,reject}], scheduled }

async function history(machine, item, { limit = HIST_LIMIT } = {}) {
  return new Promise((resolve, reject) => {
    let b = histBatch.get(limit);
    if (!b) { b = { items: new Set(), waiters: [], scheduled: false }; histBatch.set(limit, b); }
    b.items.add(item);
    b.waiters.push({ machine, item, resolve, reject });
    if (!b.scheduled) {
      b.scheduled = true;
      Promise.resolve().then(() => {
        histBatch.delete(limit);
        const items = [...b.items];
        historyBulk(items, { limit })
          .then((byMachine) => {
            for (const w of b.waiters) {
              const per = byMachine && byMachine.get ? byMachine.get(w.machine) : null;
              w.resolve((per && per[w.item]) || []);
            }
          })
          .catch((err) => { for (const w of b.waiters) w.reject(err); });
      });
    }
  });
}

/* History within a window. Returns rows whose ts is inside [from,to], PLUS the
 * single row immediately before `from` (carried in as the state at window start)
 * so interval/state math has a left anchor.
 *
 * Backed by the INDEXED /api/history_range (with anchor=1) instead of the
 * recent-5000-mixed-row history(): that old path silently truncated every
 * windowed view to the last few minutes for dense 1 Hz signals (sspeed flooded
 * the 5000-row budget). Now a Shift/Day/Week window returns the real full
 * window, riding the obs index. */
/* historyWindow — windowed history for ONE (machine,item), but MICRO-BATCHED.
 *
 * Every windowed view (Data Lab, Maintenance, metrics fallback, Plan) calls this
 * per (machine,item). Instead of each becoming its own /api/history_range, we
 * collect all calls fired in the same tick (a microtask drain) and issue ONE
 * /api/history_range_bulk per window covering every machine+item requested. So a
 * Data Lab sub-view that asks for fdovrd/rovrd/ssovrd across 5 machines (15
 * calls) collapses to a single request — with NO change to any caller. The
 * bulk result is per-(machine,item), so each caller's promise resolves with
 * exactly its slice. Backed by the same 60s-quantized window + SWR cache, so
 * repeats within a minute don't refetch at all. */
const hwBatch = new Map(); // winKey -> { win, items:Set, machines:Set, waiters:[{machine,item,resolve,reject}], scheduled }
function hwWinKey(win) { return `${Math.round(win.from)}|${Math.round(win.to)}`; }

async function historyWindow(machine, item, win = resolveWindow()) {
  return new Promise((resolve, reject) => {
    const key = hwWinKey(win);
    let b = hwBatch.get(key);
    if (!b) { b = { win, items: new Set(), machines: new Set(), waiters: [], scheduled: false }; hwBatch.set(key, b); }
    b.items.add(item);
    b.machines.add(machine);
    b.waiters.push({ machine, item, resolve, reject });
    if (!b.scheduled) {
      b.scheduled = true;
      // drain on the next microtask: every historyWindow call in this tick joins the batch.
      Promise.resolve().then(() => {
        hwBatch.delete(key);
        const items = [...b.items];
        historyRangeBulkWindow(items, b.win, { max: 100000 })
          .then((byMachine) => {
            for (const w of b.waiters) {
              const per = byMachine && byMachine.get ? byMachine.get(w.machine) : null;
              w.resolve((per && per[w.item]) || []);
            }
          })
          .catch((err) => { for (const w of b.waiters) w.reject(err); });
      });
    }
  });
}

/* ---------- bulk reads (all machines, many items, ONE request) ----------
 * Mirror /api/timeline_bulk: the collector loops machines server-side and
 * returns {machines:{name:{item:[rows...]}}}. Rows have the same fields as the
 * single-machine endpoints, so callers normalize identically. This collapses
 * the per-(machine,item) fan-out (dashboard seed 2xN, KPI/analytics up to 8xN)
 * into a single round-trip. */
function normRows(rows, item) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r.item === undefined || r.item === item)
    .map((r) => ({ ts: r.ts / US_PER_MS, val: r.val, num: r.val_num, seq: r.seq, carried: r.carried }))
    .sort((a, b) => a.ts - b.ts);
}

// Recent history (limit-based) for many items across all machines, one call.
// Returns Map<machine, {item -> normalized rows}>.
async function historyBulk(items, { limit = 2000 } = {}) {
  const raw = await getJSON(`/api/history_bulk?items=${encodeURIComponent(items.join(","))}&limit=${limit}`);
  const out = new Map();
  const machines = (raw && raw.machines) || {};
  for (const name of Object.keys(machines)) {
    const per = {};
    for (const it of items) per[it] = normRows(machines[name][it], it);
    out.set(name, per);
  }
  return out;
}

/* Windowed history for many items across all machines, one call — the bulk twin
 * of historyWindow/historyRange. SWR-cached (60s, matching the window quantum)
 * keyed by the exact URL so the 15s router refresh re-serves from cache and a
 * whole KPI/analytics refresh costs ~0 network until the minute rolls. Returns
 * Map<machine, {item -> rows}>. */
const hrbCache = new Map(); // url -> { at, data? , inflight? }
async function historyRangeBulkWindow(items, win = resolveWindow(), { max = 100000 } = {}) {
  const from = Math.round(win.from * US_PER_MS);
  const to = Math.round(win.to * US_PER_MS);
  const path = `/api/history_range_bulk?items=${encodeURIComponent(items.join(","))}` +
    `&from=${from}&to=${to}&max=${max}&anchor=1`;
  const now = Date.now();
  const hit = hrbCache.get(path);
  if (hit && now - hit.at < NOW_QUANTUM_MS) {
    if (hit.data) return hit.data;
    if (hit.inflight) return hit.inflight;
  }
  const inflight = getJSON(path).then((raw) => {
    const out = new Map();
    const machines = (raw && raw.machines) || {};
    for (const name of Object.keys(machines)) {
      const per = {};
      for (const it of items) per[it] = normRows(machines[name][it], it);
      out.set(name, per);
    }
    hrbCache.set(path, { at: Date.now(), data: out });
    return out;
  }).catch((e) => { hrbCache.delete(path); throw e; });
  hrbCache.set(path, { at: now, inflight });
  if (hrbCache.size > 32) { for (const [k, v] of hrbCache) if (v.data && now - v.at >= NOW_QUANTUM_MS) hrbCache.delete(k); }
  return inflight;
}

/* Ranged history for ONE (machine, item) over an arbitrary [fromMs, toMs]
 * window, via /api/history_range (added to the collector). Unlike history(),
 * this is NOT capped at the recent 5000-mixed-row scan — it rides the obs
 * (machine_id, dataitem_id, machine_ts) index, so hour/day/week/month views
 * get real rows the whole way back. Returns ascending ms-stamped rows
 * {ts, val, num, seq}.
 *
 * SWR-cached (15s) keyed by the exact URL. With `to` quantized to a 60s grid
 * (quantNow), the windowed views request identical URLs for a full minute, so
 * the 15s router refresh re-serves from this cache instead of re-hitting the
 * collector — this is what turns the every-15s 80-request burst into ~one fetch
 * per item per minute. */
const hrCache = new Map(); // url -> { at, rows? , inflight? }
const HR_TTL_MS = NOW_QUANTUM_MS; // 60s — match the window quantum so every refresh inside a quantized minute is a cache hit; one refetch per minute when the window rolls.
async function historyRange(machine, item, fromMs, toMs, { max = 40000, anchor = false } = {}) {
  const from = Math.round(fromMs * US_PER_MS);
  const to = Math.round(toMs * US_PER_MS);
  const path = `/api/history_range?machine=${encodeURIComponent(machine)}&item=${encodeURIComponent(item)}` +
    `&from=${from}&to=${to}&max=${max}${anchor ? "&anchor=1" : ""}`;
  const now = Date.now();
  const hit = hrCache.get(path);
  if (hit && now - hit.at < HR_TTL_MS) {
    if (hit.rows) return hit.rows;
    if (hit.inflight) return hit.inflight; // coalesce concurrent identical pulls onto one fetch
  }
  const inflight = getJSON(path).then((rows) => {
    const matched = (Array.isArray(rows) ? rows : []).filter((r) => r.item === undefined || r.item === item);
    const norm = matched
      .map((r) => ({ ts: r.ts / US_PER_MS, val: r.val, num: r.val_num, seq: r.seq, carried: r.carried }))
      .sort((a, b) => a.ts - b.ts);
    hrCache.set(path, { at: Date.now(), rows: norm });
    return norm;
  }).catch((e) => { hrCache.delete(path); throw e; });
  hrCache.set(path, { at: now, inflight });
  if (hrCache.size > 256) { for (const [k, v] of hrCache) if (v.rows && now - v.at >= HR_TTL_MS) hrCache.delete(k); }
  return inflight;
}

/* ---------- purpose-built, server-computed reads ----------
 * These move the heavy folding to the collector so the browser gets answers,
 * not raw 1 Hz rows. Each ships KBs instead of MBs and turns multi-second
 * (sometimes timing-out) loads into sub-second ones. */

// Completed PARTS for ALL machines over [fromMs,toMs] in ONE call. The
// collector segments cyremtim + joins the tcycle target server-side, so the
// Timeline draws lanes from ~hundreds of segments instead of ~500k rows.
// Returns { from, to, lanes:[{machine, parts:[{t0,t1,dur,target,partial}],
//   bands:[{t0,t1,status}]}] } with ts in ms. `bands` is additive machine-state
// coverage (running|idle|paused|alarm|offline, ts micros on the wire) so lanes
// with zero parts still paint their idle/stopped windows. Absent/empty bands
// simply mean "no coverage" — callers must treat it as today's behavior.
// Short SWR cache keyed by the (rounded) window.
const tlCache = new Map(); // key -> { at, data }
const TL_TTL_MS = 4000;
async function timelineBulk(fromMs, toMs) {
  const from = Math.round(fromMs * US_PER_MS);
  const to = Math.round(toMs * US_PER_MS);
  const key = `${Math.round(from / 1e6)}|${Math.round(to / 1e6)}`;
  const hit = tlCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TL_TTL_MS) return hit.data;
  const raw = await getJSON(`/api/timeline_bulk?from=${from}&to=${to}`);
  const lanes = (raw && Array.isArray(raw.lanes) ? raw.lanes : []).map((l) => ({
    machine: l.machine,
    truncated: !!l.truncated,
    parts: (l.parts || []).map((p) => ({
      t0: p.t0 / US_PER_MS, t1: p.t1 / US_PER_MS,
      dur: (p.dur_ms != null ? p.dur_ms : (p.t1 - p.t0) / 1000) * 1, // ms
      target: p.target_s, partial: !!p.partial,
      program: p.program || null, job: p.job || null, groupId: p.group_id,
      baseline: p.baseline_s != null ? p.baseline_s : null, // seconds (learned)
      baselineN: p.baseline_n || 0,
      dev: p.dev != null ? p.dev : null,                    // dur / baseline
    })),
    groups: (l.groups || []).map((g) => ({
      groupId: g.group_id, program: g.program || null,
      t0: g.t0 / US_PER_MS, t1: g.t1 / US_PER_MS, count: g.count,
      baseline: g.baseline_s != null ? g.baseline_s : null,
      baselineN: g.baseline_n || 0,
    })),
    // Additive status bands (machine-state coverage). Guarded: missing/empty/
    // malformed bands collapse to [] and callers render exactly as before.
    bands: (Array.isArray(l.bands) ? l.bands : []).filter((b) =>
      b && Number.isFinite(b.t0) && Number.isFinite(b.t1) && b.t1 > b.t0
    ).map((b) => ({
      t0: b.t0 / US_PER_MS, t1: b.t1 / US_PER_MS,
      status: (typeof b.status === "string" && b.status) ? b.status.toLowerCase() : "unknown",
    })),
  }));
  const data = { from: from / US_PER_MS, to: to / US_PER_MS, lanes };
  tlCache.set(key, { at: now, data });
  return data;
}

// Parts for a SINGLE machine (same shape as one lane above). Handy when a view
// only needs one machine without pulling the whole fleet.
async function parts(machine, fromMs, toMs) {
  const from = Math.round(fromMs * US_PER_MS);
  const to = Math.round(toMs * US_PER_MS);
  const raw = await getJSON(
    `/api/parts?machine=${encodeURIComponent(machine)}&from=${from}&to=${to}`);
  return (raw && Array.isArray(raw.parts) ? raw.parts : []).map((p) => ({
    t0: p.t0 / US_PER_MS, t1: p.t1 / US_PER_MS,
    dur: (p.dur_ms != null ? p.dur_ms : (p.t1 - p.t0) / 1000),
    target: p.target_s, partial: !!p.partial,
  }));
}

// Down-sampled trace for a dense signal. Returns ascending buckets
// [{ts, min, max, avg, n}] (ts in ms) — ~1-2k points regardless of range, with
// extremes preserved. Use for positions/overrides/spindle over wide windows
// instead of historyWindow (which pulls every raw sample).
async function series(machine, item, fromMs, toMs, { buckets = 1200 } = {}) {
  const from = Math.round(fromMs * US_PER_MS);
  const to = Math.round(toMs * US_PER_MS);
  const raw = await getJSON(
    `/api/series?machine=${encodeURIComponent(machine)}&item=${encodeURIComponent(item)}` +
    `&from=${from}&to=${to}&buckets=${buckets}`);
  return (raw && Array.isArray(raw.buckets) ? raw.buckets : []).map((b) => ({
    ts: b.t / US_PER_MS, min: b.min, max: b.max, avg: b.avg, num: b.avg, n: b.n,
  }));
}

/* Real alert events from the DB over [fromMs, toMs] — backfills the alert log
 * so it shows actual estop/alarm/override-dip history, not just what fired live
 * since the page opened. Returns {machine, ts(ms), sev, rule, msg} newest-first.
 * Backed by the read-only /api/events endpoint. */
async function events(fromMs, toMs) {
  const from = Math.round(fromMs * US_PER_MS);
  const to = Math.round(toMs * US_PER_MS);
  const raw = await getJSON(`/api/events?from=${from}&to=${to}`, { timeout: 12000 });
  return (raw && Array.isArray(raw.events) ? raw.events : [])
    .filter((e) => e && e.ts && e.sev)   // drop any {machine,error} rows
    .map((e) => ({ machine: e.machine, ts: e.ts, sev: e.sev, rule: e.rule, msg: e.msg }));
}

/* ---------- overview + live ---------- */
/* Tiny coalescing cache: several views (3D theatre, plan widgets) poll the
 * overview at ~1 Hz independently. A short TTL collapses concurrent/near-
 * simultaneous calls into a single network hit without making the data stale. */
let ovCache = { at: 0, data: null, inflight: null };
const OV_TTL_MS = 700;
async function overview() {
  const now = Date.now();
  if (ovCache.data && now - ovCache.at < OV_TTL_MS) return ovCache.data;
  if (ovCache.inflight) return ovCache.inflight;
  ovCache.inflight = getJSON("/api/overview")
    .then((d) => { ovCache = { at: Date.now(), data: d, inflight: null }; return d; })
    .catch((e) => { ovCache.inflight = null; throw e; });
  return ovCache.inflight;
}

/* ---------- gap-audit confidence ----------
 * Turn /api/gap_audit into a per-machine + fleet confidence badge. The collector
 * is gapless by design, so this is usually green — but we surface it as the trust
 * layer so every metric can declare it. Levels: ok | warn | bad. */
let gapCache = { at: 0, data: null };
const GAP_TTL_MS = 20000;

async function gapAudit() {
  const now = Date.now();
  if (gapCache.data && now - gapCache.at < GAP_TTL_MS) return gapCache.data;
  const data = await getJSON("/api/gap_audit");
  gapCache = { at: now, data };
  return data;
}

function confidenceFromAudit(audit, machine = null) {
  if (!audit) return { level: "warn", label: "UNKNOWN", detail: "no audit" };
  if (machine) {
    const m = (audit.machines || []).find((x) => x.name === machine);
    if (!m) return { level: "warn", label: "NO DATA", detail: "machine absent from audit" };
    const level = m.no_silent_loss ? "ok" : "bad";
    return {
      level,
      label: m.no_silent_loss ? "GAPLESS" : "GAPS",
      detail: `${m.silent || 0} silent · ${m.unexplained || 0} unexplained`,
    };
  }
  const fleetOk = audit.no_silent_loss;
  return {
    level: fleetOk ? "ok" : "bad",
    label: fleetOk ? "GAPLESS" : "GAPS",
    detail: `${audit.silent_total || 0} silent · ${audit.unexplained_total || 0} unexplained`,
  };
}

/* ---------- SSE live stream ----------
 * One shared EventSource for the new sections so we don't open five. Subscribers
 * get every parsed message; the stream auto-reconnects with backoff. The alert
 * engine and the live plan widgets ride this. */
const streamSubs = new Set();
let es = null;
let esBackoff = 1000;

function ensureStream() {
  if (es) return;
  try {
    es = new EventSource(`${API_BASE()}/api/stream`);
  } catch (_) { return; }
  es.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch (_) { return; }
    for (const fn of streamSubs) { try { fn(data); } catch (_) {} }
    esBackoff = 1000;
  };
  es.onerror = () => {
    if (es) { es.close(); es = null; }
    setTimeout(ensureStream, esBackoff);
    esBackoff = Math.min(esBackoff * 2, 30000);
  };
}

function onStream(fn) {
  streamSubs.add(fn);
  ensureStream();
  return () => streamSubs.delete(fn);
}

export const dataLayer = {
  API_BASE,
  WINDOW_DEFS,
  resolveWindow, getWindowKey, setWindowKey, onWindowChange, shiftStart,
  getJSON, history, historyWindow, historyRange, historyBulk, historyRangeBulkWindow, timelineBulk, parts, series, events, overview,
  gapAudit, confidenceFromAudit,
  onStream,
  MS,
};
