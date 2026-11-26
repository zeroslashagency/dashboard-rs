/* VMC God-mode — Data Science / Analytical section.
 *
 * "What happened and why", computed entirely in the browser from the existing
 * /api/history + /api/overview + /api/gap_audit. No backend change. Every widget
 * derives from real polled samples over the selected window.
 *
 * Widgets (Phase 1 quick wins + cycle-driven):
 *   - Per-machine analytic row: OEE-lite, utilization, part-rate, cycle stats
 *   - Time-in-state stacked bar (run/pause/idle) from rstat segmentation
 *   - Status timeline canvas (color bands over the window)
 *   - Override-deviation + estop counters
 *
 * OEE-lite = Availability x Performance. Quality is shown as a labelled proxy
 * (interrupted-cycle driven) because no reject counter exists on the box — never
 * multiplied into the headline number, so we never fake the third leg.
 */

import { stats, bucketOfState } from "./analyticsCore.js";
import { computeMachine } from "./metrics.js";

const STATE_COLORS = {
  run: "#22c55e", pause: "#f59e0b", idle: "#64748b", other: "#475569",
};
const fmtPct = (v) => (v == null ? "—" : `${Math.round(v)}%`);
const fmtPct1 = (v) => (v == null ? "—" : `${v.toFixed(1)}%`);
const fmtDur = (ms) => {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
};
const fmtClock = (ms) => {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
};

export function mountAnalytical(body, dataLayer) {
  body.innerHTML = `
    <div class="ds-fleet-strip" data-f="fleet"></div>
    <div class="ds-grid" data-f="rows"></div>
    <p class="ds-note" data-f="note" role="status" aria-live="polite">Computing analytics from gapless history…</p>`;
  const refs = {
    fleet: body.querySelector('[data-f="fleet"]'),
    rows: body.querySelector('[data-f="rows"]'),
    note: body.querySelector('[data-f="note"]'),
  };
  const rowEls = new Map(); // machine -> { root, refs, canvas }
  let token = 0;

  async function refresh() {
    if (document.hidden) return;        // skip work while the tab is off-screen
    const my = ++token;
    let ov;
    try { ov = await dataLayer.overview(); }
    catch (err) { 
      const isTimeout = err.name === 'AbortError' || (err.message && err.message.includes('aborted'));
      refs.note.textContent = isTimeout 
        ? "Computing analytics — collector is slow, please wait…" 
        : "Collector unreachable — cannot fetch machine list.";
      refs.note.hidden = false; 
      return; 
    }
    if (my !== token) return;
    const machines = Array.isArray(ov.machines) ? ov.machines : [];
    if (!machines.length) { refs.note.textContent = "No machines reported."; refs.note.hidden = false; return; }
    
    const win = dataLayer.resolveWindow();
    let audit;
    try {
      audit = await dataLayer.gapAudit();
    } catch (err) {
      // Gap audit failure is non-fatal — show degraded confidence badges
      audit = null;
    }
    if (my !== token) return;

    const fleet = { oee: [], util: [], parts: 0, runMs: 0, downMs: 0 };
    let anySuccess = false;

    await Promise.all(machines.map(async (m) => {
      const id = m.machine_id;
      let metrics;
      try { 
        metrics = await computeMachine(dataLayer, id, win); 
        anySuccess = true;
      } catch (err) { 
        // Per-machine failure: render an error row instead of dropping it
        renderErrorRow(refs.rows, rowEls, id, m, err);
        return; 
      }
      if (!metrics) return;

      const conf = dataLayer.confidenceFromAudit(audit, id);
      renderRow(refs.rows, rowEls, id, m, metrics, win, conf);

      if (metrics.oee != null) fleet.oee.push(metrics.oee);
      if (metrics.utilization != null) fleet.util.push(metrics.utilization);
      fleet.parts += metrics.parts || 0;
      fleet.runMs += metrics.buckets.run || 0;
      fleet.downMs += (metrics.buckets.pause || 0) + (metrics.buckets.idle || 0);
    }));

    if (my !== token) return;
    
    // Only hide the note if at least one machine succeeded
    if (anySuccess) {
      refs.note.hidden = true;
    } else {
      refs.note.textContent = "Failed to compute analytics for any machine — endpoints too slow or unavailable.";
      refs.note.hidden = false;
    }
    
    // drop rows for machines no longer present
    for (const [id, el] of rowEls) {
      if (!machines.some((m) => m.machine_id === id)) { el.root.remove(); rowEls.delete(id); }
    }

    renderFleet(refs.fleet, fleet, win);
  }

  return { refresh };
}

/* ---------- per-machine error row (partial rendering) ---------- */
function renderErrorRow(host, rowEls, id, m, err) {
  let el = rowEls.get(id);
  if (!el) {
    const root = document.createElement("div");
    root.className = "ds-row ds-row-error";
    root.innerHTML = `
      <div class="ds-row-head">
        <span class="ds-row-name" data-f="name"></span>
        <span class="ds-row-conf conf-bad" data-f="conf" role="status">${window.VMCStatusPill ? window.VMCStatusPill.innerMarkup("error", "ERROR") : "ERROR"}</span>
      </div>
      <p class="ds-note" data-f="errMsg" role="alert" style="margin: 1rem 0;"></p>`;
    host.appendChild(root);
    const r = {};
    root.querySelectorAll("[data-f]").forEach((n) => { r[n.dataset.f] = n; });
    el = { root, refs: r, isError: true };
    rowEls.set(id, el);
  }
  const r = el.refs;
  r.name.textContent = m.machine_name || id;
  const isTimeout = err.name === 'AbortError' || (err.message && err.message.includes('aborted'));
  r.errMsg.textContent = isTimeout 
    ? "Endpoints timed out — data too slow to load" 
    : "Failed to load: " + (err.message || "unknown error");
  el.root.className = "ds-row ds-row-error";
}

/* ---------- per-machine row render ---------- */
function renderRow(host, rowEls, id, m, x, win, conf) {
  let el = rowEls.get(id);
  // If it was an error row before, drop it so the normal row is rebuilt below.
  // `el` is deliberately NOT re-fetched from rowEls afterwards: it is already
  // the entry we want, and setting it to null here is what makes the `if (!el)`
  // branch rebuild the row. A second `let el = rowEls.get(id)` used to sit here,
  // which is a redeclaration in the same scope -- a hard SyntaxError under ES
  // module parsing. It broke the ENTIRE godmode.js module graph at load time, so
  // the whole tab bar (KPI, Analytics, 3D, Timeline, Data Lab, Maintenance,
  // Statistics) silently failed to render and only the mission-card grid showed.
  if (el && el.isError) {
    el.root.remove();
    el = null;
    rowEls.delete(id);
  }
  if (!el) {
    const root = document.createElement("div");
    root.className = "ds-row";
    root.innerHTML = `
      <div class="ds-row-head">
        <span class="ds-row-name" data-f="name"></span>
        <span class="ds-row-conf" data-f="conf"></span>
      </div>
      <div class="ds-kpis">
        <div class="ds-kpi ds-kpi-oee"><span class="ds-kpi-v" data-f="oee"></span><span class="ds-kpi-k">OEE-lite</span></div>
        <div class="ds-kpi"><span class="ds-kpi-v" data-f="util"></span><span class="ds-kpi-k">Utilization</span></div>
        <div class="ds-kpi"><span class="ds-kpi-v" data-f="avail"></span><span class="ds-kpi-k">Availability</span></div>
        <div class="ds-kpi"><span class="ds-kpi-v" data-f="perf"></span><span class="ds-kpi-k">Performance</span></div>
        <div class="ds-kpi"><span class="ds-kpi-v" data-f="parts"></span><span class="ds-kpi-k">Parts</span></div>
        <div class="ds-kpi"><span class="ds-kpi-v" data-f="rate"></span><span class="ds-kpi-k">Parts/run-h</span></div>
        <div class="ds-kpi"><span class="ds-kpi-v" data-f="cyc"></span><span class="ds-kpi-k">Median cycle</span></div>
        <div class="ds-kpi ds-kpi-q"><span class="ds-kpi-v" data-f="qual"></span><span class="ds-kpi-k">Quality (proxy)</span></div>
      </div>
      <div class="ds-stack" data-f="stack"></div>
      <canvas class="ds-timeline" data-f="timeline"></canvas>
      <div class="ds-row-foot">
        <span data-f="ovr"></span>
        <span data-f="estop"></span>
      </div>`;
    host.appendChild(root);
    const r = {};
    root.querySelectorAll("[data-f]").forEach((n) => { r[n.dataset.f] = n; });
    el = { root, refs: r };
    rowEls.set(id, el);
  }
  const r = el.refs;
  r.name.textContent = m.machine_name || id;
  if (window.VMCStatusPill) {
    window.VMCStatusPill.updatePill(r.conf, conf.level, conf.label, `ds-row-conf conf-${conf.level}`);
  } else {
    r.conf.className = `ds-row-conf conf-${conf.level}`;
    r.conf.textContent = conf.label;
  }

  setKpi(r.oee, fmtPct(x.oee), oeeClass(x.oee));
  setKpi(r.util, fmtPct(x.utilization));
  setKpi(r.avail, fmtPct(x.availability));
  setKpi(r.perf, fmtPct(x.performance));
  setKpi(r.parts, String(x.parts));
  setKpi(r.rate, x.partRateRun == null ? "—" : x.partRateRun.toFixed(1));
  setKpi(r.cyc, fmtClock(x.cstats.median));
  setKpi(r.qual, fmtPct(x.qualityProxy));

  renderStack(r.stack, x.buckets);
  drawTimeline(r.timeline, x.segs, win);

  const ov = x.ovr;
  r.ovr.innerHTML = ovrText(ov);
  const sp = window.VMCStatusPill;
  r.estop.innerHTML = x.estopEvents.count > 0
    ? `<span class="ds-flag ds-flag-bad">${sp ? sp.innerMarkup("alarm", `E-STOP ×${x.estopEvents.count}`) : `E-STOP ×${x.estopEvents.count}`}</span>`
    : `<span class="ds-flag ds-flag-ok">${sp ? sp.innerMarkup("ok", "no e-stop") : "no e-stop"}</span>`;
}

function setKpi(node, text, cls) {
  node.textContent = text;
  if (cls !== undefined) node.className = `ds-kpi-v ${cls}`;
}
function oeeClass(v) {
  if (v == null) return "";
  if (v >= 70) return "v-good";
  if (v >= 45) return "v-warn";
  return "v-bad";
}
function ovrText(ov) {
  const seg = (k, v, off) => {
    const bad = v != null && Math.round(v) !== 100;
    return `<span class="ds-ovr ${bad ? "is-off" : ""}">${k} ${v == null ? "—" : Math.round(v) + "%"}` +
      `${off > 0.005 ? ` <em>${Math.round(off * 100)}% off</em>` : ""}</span>`;
  };
  return `OVR ${seg("F", ov.feed, ov.feedOff)} ${seg("R", ov.rapid, 0)} ${seg("S", ov.spindle, ov.spindleOff)}`;
}

/* stacked run/pause/idle bar */
function renderStack(host, b) {
  const total = (b.run + b.pause + b.idle + b.other) || 1;
  const seg = (key, ms) => ms <= 0 ? "" :
    `<span class="ds-stack-seg" style="width:${(ms / total) * 100}%;background:${STATE_COLORS[key]}" title="${key} ${fmtDur(ms)}"></span>`;
  host.innerHTML =
    seg("run", b.run) + seg("pause", b.pause) + seg("idle", b.idle) + seg("other", b.other) +
    `<span class="ds-stack-legend">▶ ${fmtDur(b.run)} · ⏸ ${fmtDur(b.pause)} · ⏹ ${fmtDur(b.idle)}</span>`;
}

/* ---------- status timeline canvas ----------
 * Horizontal color bands across the window: run=green, pause=amber, idle=grey.
 * Matches the house canvas style (no chart lib). Hover shows the exact state,
 * its clock span and duration under the cursor. */
const STATE_LABEL = {
  run: "Running (cutting)", pause: "Paused / feed-hold",
  idle: "Idle (no cycle)", other: "Other / unknown",
};
function drawTimeline(cv, segs, win) {
  const w = cv.clientWidth || 600, h = cv.clientHeight || 26;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  const span = (win.to - win.from) || 1;
  for (const s of segs) {
    const x0 = ((s.from - win.from) / span) * w;
    const x1 = ((s.to - win.from) / span) * w;
    ctx.fillStyle = STATE_COLORS[bucketOfState(s.state)] || STATE_COLORS.other;
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
  }
  // stash for the hover handler; bind once per canvas
  cv.__segs = segs; cv.__win = win;
  if (!cv.__hoverBound) {
    cv.__hoverBound = true;
    cv.style.cursor = "crosshair";
    cv.addEventListener("mousemove", (e) => onTimelineHover(e, cv));
    cv.addEventListener("mouseleave", () => tlTipHide());
  }
}

function onTimelineHover(e, cv) {
  const segs = cv.__segs, win = cv.__win;
  if (!segs || !win) return tlTipHide();
  const rect = cv.getBoundingClientRect();
  const frac = (e.clientX - rect.left) / (rect.width || 1);
  const t = win.from + frac * ((win.to - win.from) || 1);
  const s = segs.find((g) => t >= g.from && t <= g.to);
  if (!s) return tlTipHide();
  const k = bucketOfState(s.state);
  tlTipShow(e.clientX, e.clientY,
    `${STATE_LABEL[k] || s.state}`,
    `${fmtHM(s.from)} → ${fmtHM(s.to)} · ${fmtDur(s.dur)}`);
}

const fmtHM = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

let tlTipEl = null;
function tlTipShow(cx, cy, title, body) {
  if (!tlTipEl) {
    tlTipEl = document.createElement("div");
    tlTipEl.className = "ds-tl-tip";
    document.body.appendChild(tlTipEl);
  }
  tlTipEl.innerHTML = `<b></b><span></span>`;
  tlTipEl.querySelector("b").textContent = title;
  tlTipEl.querySelector("span").textContent = body;
  tlTipEl.style.display = "block";
  const pad = 14;
  let x = cx + pad, y = cy + pad;
  const w = tlTipEl.offsetWidth, vw = window.innerWidth;
  if (x + w > vw - 8) x = cx - w - pad;
  tlTipEl.style.left = `${Math.round(x)}px`;
  tlTipEl.style.top = `${Math.round(y)}px`;
}
function tlTipHide() { if (tlTipEl) tlTipEl.style.display = "none"; }

/* ---------- fleet strip ---------- */
function renderFleet(host, f, win) {
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const oee = avg(f.oee), util = avg(f.util);
  const upMs = f.runMs, downMs = f.downMs;
  const partsLabel = win.key === "today" ? "Parts today"
    : win.key === "shift" ? "Parts this shift"
    : `Parts this ${win.label.toLowerCase()}`;
  host.innerHTML = `
    <div class="ds-fleet-kpi"><span class="ds-fleet-v ${oeeClass(oee)}">${fmtPct(oee)}</span><span class="ds-fleet-k">Fleet OEE-lite</span></div>
    <div class="ds-fleet-kpi"><span class="ds-fleet-v">${fmtPct(util)}</span><span class="ds-fleet-k">Fleet utilization</span></div>
    <div class="ds-fleet-kpi"><span class="ds-fleet-v">${f.parts}</span><span class="ds-fleet-k">${partsLabel}</span></div>
    <div class="ds-fleet-kpi"><span class="ds-fleet-v">${fmtDur(upMs)}</span><span class="ds-fleet-k">Cutting time</span></div>
    <div class="ds-fleet-kpi"><span class="ds-fleet-v">${fmtDur(downMs)}</span><span class="ds-fleet-k">Idle + paused</span></div>`;
}
