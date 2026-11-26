/* VMC God-mode — unified alert engine.
 *
 * One engine spanning both sections. Three severities (INFO / WARNING / CRITICAL)
 * with per-rule cooldown so a single fault doesn't spam. Detection is dual-path:
 *
 *   - REAL-TIME rules evaluate each /api/overview poll (we poll here independently
 *     of app.js so the engine runs even before a section scrolls into view) for
 *     low-latency flags: estop, alarm assert, override dialed down during a cut,
 *     spindle-zero-during-cut, feed-hold.
 *   - Every alert is gap-integrity aware: if the fleet audit shows gaps, alerts
 *     are tagged low-confidence rather than suppressed — we never hide a CRITICAL
 *     on incomplete data, but we say the data was incomplete.
 *
 * Renders a dismissible toast stack + a persistent, filterable log panel. v1 is
 * entirely client-side; no backend change. Thresholds are constants here (the
 * planning-config blob can override them in a later phase).
 */

import { dataLayer } from "./dataLayer.js";

const GAP_REFRESH_MS = 15000;

/* Escape HTML entities to prevent XSS when rendering untrusted strings */
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}   // gapless-badge refresh (gap audit is 20s-cached); rules ride the dashboard poll
const COOLDOWN_MS = 60000;      // per (machine,rule) — don't re-fire within this
const LOG_MAX = 200;

const SEV = { INFO: 0, WARNING: 1, CRITICAL: 2 };
const SEV_NAME = ["INFO", "WARNING", "CRITICAL"];

const RUN_STATES = new Set(["ACTIVE", "EXECUTING", "RUNNING"]);
const PAUSE_STATES = new Set(["FEED_HOLD", "INTERRUPTED", "HELD"]);

/* ---------- rule set ----------
 * Each rule inspects one machine's current overview record + a small bit of
 * remembered prior state (held in `mem`), and returns an alert or null. */
const RULES = [
  // CRITICAL — estop asserted. Overview doesn't expose the raw estop dataitem,
  // but its derived `status` collapses a triggered estop to "e_stop", so we key
  // off that (verified against /api/overview: top-level keys are status,
  // availability, alarm_count — no raw estop).
  (m, mem) => {
    const est = String(m.status || "").toLowerCase() === "e_stop";
    if (est && !mem.estop) { mem.estop = true; return mk("CRITICAL", "estop", m, "E-STOP asserted"); }
    if (!est) mem.estop = false;
    return null;
  },
  // CRITICAL — alarm count rose
  (m, mem) => {
    const n = Number(m.alarm_count) || 0;
    const prev = mem.alarmCount || 0;
    mem.alarmCount = n;
    if (n > prev && n > 0) return mk("CRITICAL", "alarm", m, `${n} active alarm${n > 1 ? "s" : ""}`);
    return null;
  },
  // CRITICAL — spindle zero during an active cut (the honest "stalled cycle" tell)
  (m, mem) => {
    const exec = String(m.execution || "").toUpperCase();
    const sp = Number(m.spindle_speed);
    const cutting = RUN_STATES.has(exec);
    const zero = cutting && Number.isFinite(sp) && sp === 0;
    if (zero && !mem.spindleZero) { mem.spindleZero = true; return mk("CRITICAL", "spindle_zero", m, "spindle 0 RPM during ACTIVE cut"); }
    if (!zero) mem.spindleZero = false;
    return null;
  },
  // WARNING — feed-hold / interrupted (operator paused mid-cycle)
  (m, mem) => {
    const exec = String(m.execution || "").toUpperCase();
    const held = PAUSE_STATES.has(exec);
    if (held && !mem.held) { mem.held = true; return mk("WARNING", "feed_hold", m, `paused (${exec})`); }
    if (!held) mem.held = false;
    return null;
  },
  // WARNING — override dialed meaningfully low (<=50%) during a cut. Routine
  // 75% rapid is normal on these machines, so only real slow-downs alert.
  (m, mem) => {
    const exec = String(m.execution || "").toUpperCase();
    if (!RUN_STATES.has(exec)) { mem.ovrOff = false; return null; }
    const o = m.overrides || {};
    const low = [["feed", o.feed], ["rapid", o.rapid], ["spindle", o.spindle]]
      .filter(([, v]) => Number.isFinite(Number(v)) && Number(v) <= 50);
    if (low.length && !mem.ovrOff) {
      mem.ovrOff = true;
      return mk("WARNING", "override", m, `override low: ${low.map(([k, v]) => `${k[0].toUpperCase()}${Math.round(v)}%`).join(" ")} during cut`);
    }
    if (!low.length) mem.ovrOff = false;
    return null;
  },
  // INFO — program changed
  (m, mem) => {
    const p = m.active_program || "";
    if (mem.prog !== undefined && p && p !== mem.prog) { mem.prog = p; return mk("INFO", "program", m, `program → ${p}`); }
    mem.prog = p;
    return null;
  },
];

function mk(sev, rule, m, msg) {
  return { sev, rule, machine: m.machine_id, name: m.machine_name || m.machine_id, msg, ts: Date.now() };
}

/* ---------- engine state ---------- */
const mem = new Map();    // machine -> per-rule memory
const cooldown = new Map(); // `${machine}|${rule}` -> last fired ms
const log = [];           // recent alerts (newest first)
let lowConfidence = false;

function memFor(id) { let x = mem.get(id); if (!x) { x = {}; mem.set(id, x); } return x; }

function shouldFire(a) {
  const k = `${a.machine}|${a.rule}`;
  const last = cooldown.get(k) || 0;
  if (a.ts - last < COOLDOWN_MS) return false;
  cooldown.set(k, a.ts);
  return true;
}

/* ---------- UI ---------- */
let toastHost = null, panel = null, badge = null, listEl = null;
let filterSev = 0;

function ensureUI() {
  toastHost = document.getElementById("alertToasts");

  // floating bell + count badge -> opens the log panel
  badge = document.createElement("button");
  badge.type = "button";
  badge.className = "alert-bell";
  badge.innerHTML = `<span class="alert-bell-icon">⚲</span><span class="alert-bell-count" data-f="count">0</span>`;
  badge.addEventListener("click", () => panel.classList.toggle("is-open"));
  document.body.appendChild(badge);

  panel = document.createElement("aside");
  panel.className = "alert-panel";
  panel.innerHTML = `
    <div class="alert-panel-head">
      <strong>Alert log</strong>
      <span class="alert-conf" data-f="conf"></span>
      <button type="button" class="alert-panel-close" data-f="close">×</button>
    </div>
    <div class="alert-filters" data-f="filters">
      <button data-sev="0" class="is-active">All</button>
      <button data-sev="1">Warn+</button>
      <button data-sev="2">Critical</button>
    </div>
    <div class="alert-list" data-f="list"></div>`;
  document.body.appendChild(panel);
  listEl = panel.querySelector('[data-f="list"]');
  panel.querySelector('[data-f="close"]').addEventListener("click", () => panel.classList.remove("is-open"));
  panel.querySelectorAll('[data-f="filters"] button').forEach((b) => {
    b.addEventListener("click", () => {
      filterSev = Number(b.dataset.sev);
      panel.querySelectorAll('[data-f="filters"] button').forEach((x) => x.classList.toggle("is-active", x === b));
      renderList();
    });
  });
}

function fire(a) {
  a.lowConfidence = lowConfidence;
  log.unshift(a);
  if (log.length > LOG_MAX) log.pop();
  renderBadge();
  renderList();
  if (a.sev >= SEV.WARNING) toast(a);   // only warn/critical interrupt with a toast
}

function toast(a) {
  if (!toastHost) return;
  const t = document.createElement("div");
  const sevKey = SEV_NAME[a.sev].toLowerCase();
  t.className = `alert-toast sev-${sevKey}${a.lowConfidence ? " low-conf" : ""}`;
  const sevInner = window.VMCStatusPill
    ? window.VMCStatusPill.innerMarkup(sevKey, SEV_NAME[a.sev])
    : escapeHtml(SEV_NAME[a.sev]);
  t.innerHTML = `
    <span class="alert-toast-sev">${sevInner}</span>
    <span class="alert-toast-body"><strong>${escapeHtml(a.name)}</strong> ${escapeHtml(a.msg)}${a.lowConfidence ? ' <em>· low-confidence data</em>' : ""}</span>
    <button type="button" class="alert-toast-x">×</button>`;
  t.querySelector(".alert-toast-x").addEventListener("click", () => t.remove());
  toastHost.appendChild(t);
  setTimeout(() => { t.classList.add("is-out"); setTimeout(() => t.remove(), 400); }, a.sev === SEV.CRITICAL ? 12000 : 7000);
}

function renderBadge() {
  const crit = log.filter((a) => a.sev === SEV.CRITICAL && Date.now() - a.ts < 600000).length;
  const warn = log.filter((a) => a.sev === SEV.WARNING && Date.now() - a.ts < 600000).length;
  const count = badge.querySelector('[data-f="count"]');
  count.textContent = String(crit + warn);
  badge.className = `alert-bell ${crit ? "has-crit" : warn ? "has-warn" : ""}`;
}

function renderList() {
  if (!listEl) return;
  const rows = log.filter((a) => a.sev >= filterSev);
  if (!rows.length) { listEl.innerHTML = `<div class="alert-empty">No alerts.</div>`; return; }
  listEl.innerHTML = rows.map((a) => {
    const sevKey = SEV_NAME[a.sev].toLowerCase();
    const sevInner = window.VMCStatusPill
      ? window.VMCStatusPill.innerMarkup(sevKey, SEV_NAME[a.sev])
      : escapeHtml(SEV_NAME[a.sev]);
    return `
    <div class="alert-row sev-${sevKey}">
      <span class="alert-row-sev">${sevInner}</span>
      <span class="alert-row-body"><strong>${escapeHtml(a.name)}</strong> ${escapeHtml(a.msg)}${a.lowConfidence ? ' <em>· low-conf</em>' : ""}</span>
      <span class="alert-row-time">${new Date(a.ts).toLocaleTimeString()}</span>
    </div>`;
  }).join("");
}

/* ---------- poll loop ---------- */
/* Evaluate the alert rules against an overview payload. The payload comes from
 * the dashboard's existing poll (broadcast via the "vmc-overview" event) so we
 * don't run a second /api/overview poller against the same heavy endpoint. */
function evalOverview(ov) {
  if (document.hidden || !ov) return;
  for (const m of (ov.machines || [])) {
    const mm = memFor(m.machine_id);
    for (const rule of RULES) {
      let a;
      try { a = rule(m, mm); } catch (_) { a = null; }
      if (a && shouldFire(a)) fire(a);
    }
  }
  renderBadge();
}

/* Periodic confidence refresh only. Overview-driven rule checks are pushed from
 * the dashboard poll (see evalOverview); this just keeps the gapless badge fresh
 * off the cheap, 20s-cached gap audit. */
async function tick() {
  if (document.hidden) return;
  let audit;
  try { audit = await dataLayer.gapAudit(); lowConfidence = !(audit && audit.no_silent_loss); }
  catch (_) { lowConfidence = true; }
  const conf = panel && panel.querySelector('[data-f="conf"]');
  if (conf) {
    if (window.VMCStatusPill) {
      window.VMCStatusPill.updatePill(
        conf,
        lowConfidence ? "warn" : "ok",
        lowConfidence ? "data gaps" : "gapless",
        `alert-conf ${lowConfidence ? "is-bad" : "is-ok"}`
      );
    } else {
      conf.textContent = lowConfidence ? "⚠ data gaps" : "gapless";
      conf.className = `alert-conf ${lowConfidence ? "is-bad" : "is-ok"}`;
    }
  }
}

export function initAlerts() {
  if (toastHost) return; // already initialized
  ensureUI();
  renderList();
  // Defer the historical backfill: it pulls /api/events (up to 12s) + /api/overview,
  // which otherwise compete with the dashboard's first paint for the browser's
  // ~6 connections/host and slow the whole boot. The live alert tick still starts
  // immediately; the 24h history just trickles in once the page has settled.
  const startBackfill = () => backfill().finally(() => { tick(); });
  if ("requestIdleCallback" in window) requestIdleCallback(startBackfill, { timeout: 4000 });
  else setTimeout(startBackfill, 3000);
  // Rule checks ride the dashboard's overview poll (no second poller). The timer
  // now only refreshes the cheap gapless badge.
  window.addEventListener("vmc-overview", (e) => { try { evalOverview(e.detail); } catch (_) {} });
  setInterval(tick, GAP_REFRESH_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
}

/* Seed the log with REAL events from the DB (last 24h) so it isn't empty until
 * something fires live. These are historical — added straight to the log (no
 * toast), and their (machine,rule,ts) is remembered so the live tick won't
 * duplicate them. */
const SEV_FROM_NAME = { INFO: 0, WARNING: 1, CRITICAL: 2 };
async function backfill() {
  let evs;
  try { evs = await dataLayer.events(Date.now() - 24 * 3600000, Date.now()); }
  catch (_) { return; }
  if (!Array.isArray(evs) || !evs.length) { renderList(); return; }
  // oldest-first into the log so unshift leaves newest on top
  evs.sort((a, b) => a.ts - b.ts);
  for (const e of evs) {
    const sev = SEV_FROM_NAME[e.sev] ?? 0;
    const a = { sev, rule: e.rule, machine: e.machine, name: e.machine,
                msg: e.msg, ts: e.ts, historical: true };
    log.unshift(a);
    // prime cooldown so the same condition seen live within the window is quiet
    cooldown.set(`${e.machine}|${e.rule}`, e.ts);
  }
  if (log.length > LOG_MAX) log.length = LOG_MAX;
  renderBadge();
  renderList();
}
