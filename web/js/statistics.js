/* VMC God-mode — Statistics view.
 *
 * Deep statistical breakdowns per machine: cycle-time histogram + percentiles,
 * downtime Pareto by reason, reliability (MTBF/MTTR), and cycle-time drift
 * (Theil-Sen slope). All canvas/CSS — no chart lib. Real samples only.
 */

import { computeMachine } from "./metrics.js";
import { theilSen } from "./analyticsCore.js";

/* Escape HTML entities to prevent XSS when rendering untrusted strings */
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

const fmtClock = (ms) => {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const s = Math.round(ms / 1000), m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
};
const fmtDur = (ms) => {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : `${s}s`;
};
const REASON_COLORS = { ALARM: "#ef4444", "E-STOP": "#b91c1c", "FEED-HOLD": "#f59e0b", IDLE: "#64748b", OTHER: "#475569" };

export function mountStatistics(body, dataLayer) {
  body.innerHTML = `<div class="stat-grid" data-f="grid"></div>
    <p class="ds-note" data-f="note" role="status" aria-live="polite">Computing statistics…</p>`;
  const refs = {};
  body.querySelectorAll("[data-f]").forEach((n) => { refs[n.dataset.f] = n; });
  const cards = new Map();
  let token = 0;

  async function refresh() {
    if (document.hidden) return;        // skip work while the tab is off-screen
    const my = ++token;
    let ov;
    try { ov = await dataLayer.overview(); }
    catch (err) { 
      const isTimeout = err.name === 'AbortError' || (err.message && err.message.includes('aborted'));
      refs.note.textContent = isTimeout 
        ? "Computing statistics — collector is slow, please wait…" 
        : "Collector unreachable — cannot fetch machine list.";
      refs.note.hidden = false; 
      return; 
    }
    if (my !== token) return;
    const machines = Array.isArray(ov.machines) ? ov.machines : [];
    if (!machines.length) { refs.note.textContent = "No machines reported."; refs.note.hidden = false; return; }
    
    const win = dataLayer.resolveWindow();
    let anySuccess = false;

    await Promise.all(machines.map(async (m) => {
      const id = m.machine_id;
      let x; 
      try { 
        x = await computeMachine(dataLayer, id, win); 
        anySuccess = true;
      } catch (err) { 
        // Per-machine failure: render an error card
        renderErrorCard(refs.grid, cards, id, m, err);
        return; 
      }
      if (!x) return;
      renderCard(refs.grid, cards, id, m, x);
    }));
    if (my !== token) return;
    
    // Only hide the note if at least one machine succeeded
    if (anySuccess) {
      refs.note.hidden = true;
    } else {
      refs.note.textContent = "Failed to compute statistics for any machine — endpoints too slow or unavailable.";
      refs.note.hidden = false;
    }
    
    for (const [id, el] of cards) {
      if (!machines.some((m) => m.machine_id === id)) { el.root.remove(); cards.delete(id); }
    }
  }

  return { refresh };
}

function renderErrorCard(host, cards, id, m, err) {
  let el = cards.get(id);
  if (!el || !el.isError) {
    if (el) el.root.remove();
    const root = document.createElement("div");
    root.className = "stat-card stat-card-error";
    root.innerHTML = `
      <div class="stat-card-head">
        <span data-f="name"></span>
        <span class="stat-sub conf-bad" role="status">${window.VMCStatusPill ? window.VMCStatusPill.innerMarkup("error", "ERROR") : "ERROR"}</span>
      </div>
      <p class="ds-note" data-f="errMsg" role="alert" style="margin: 1rem;"></p>`;
    host.appendChild(root);
    const r = {};
    root.querySelectorAll("[data-f]").forEach((n) => { r[n.dataset.f] = n; });
    el = { root, refs: r, isError: true };
    cards.set(id, el);
  }
  const r = el.refs;
  r.name.textContent = m.machine_name || id;
  const isTimeout = err.name === 'AbortError' || (err.message && err.message.includes('aborted'));
  r.errMsg.textContent = isTimeout 
    ? "Endpoints timed out — data too slow" 
    : "Failed: " + (err.message || "unknown error");
}

function renderCard(host, cards, id, m, x) {
  let el = cards.get(id);
  // If it was an error card before, recreate it
  if (el && el.isError) {
    el.root.remove();
    el = null;
    cards.delete(id);
  }
  if (!el) {
    const root = document.createElement("div");
    root.className = "stat-card";
    root.innerHTML = `
      <div class="stat-card-head"><span data-f="name"></span><span class="stat-sub" data-f="sub"></span></div>
      <div class="stat-section">
        <div class="stat-label">CYCLE-TIME DISTRIBUTION</div>
        <canvas class="stat-hist" data-f="hist"></canvas>
        <div class="stat-pcts" data-f="pcts"></div>
      </div>
      <div class="stat-section">
        <div class="stat-label">DOWNTIME PARETO</div>
        <div class="stat-pareto" data-f="pareto"></div>
      </div>
      <div class="stat-section stat-reliability">
        <div><span class="stat-rel-v" data-f="mtbf"></span><span class="stat-rel-k">MTBF</span></div>
        <div><span class="stat-rel-v" data-f="mttr"></span><span class="stat-rel-k">MTTR</span></div>
        <div><span class="stat-rel-v" data-f="drift"></span><span class="stat-rel-k">Cycle drift /h</span></div>
      </div>`;
    host.appendChild(root);
    const r = {}; root.querySelectorAll("[data-f]").forEach((n) => { r[n.dataset.f] = n; });
    el = { root, refs: r }; cards.set(id, el);
  }
  const r = el.refs;
  r.name.textContent = m.machine_name || id;
  r.sub.textContent = `${x.parts} parts · median ${fmtClock(x.cstats.median)}`;

  drawHistogram(r.hist, x.cycles.map((c) => c.dur), x.cstats);
  r.pcts.innerHTML = ["p10", "median", "p90"].map((k) =>
    `<span><em>${k}</em> ${fmtClock(x.cstats[k === "median" ? "median" : k])}</span>`).join("");

  renderPareto(r.pareto, x.downtime);

  // reliability: failures = alarm + estop asserts; operating time = run bucket.
  const failures = x.alarmEvents.count + x.estopEvents.count;
  const opMs = x.buckets.run;
  const downMs = x.downtime.ALARM + x.downtime["E-STOP"];
  r.mtbf.textContent = failures > 0 ? fmtDur(opMs / failures) : (opMs > 0 ? "no fail" : "—");
  r.mttr.textContent = failures > 0 ? fmtDur(downMs / failures) : "—";

  // drift: Theil-Sen slope of cycle dur vs end-time, ms per hour.
  const pts = x.cycles.map((c) => ({ x: c.end, y: c.dur }));
  const slope = theilSen(pts);
  if (slope == null) { r.drift.textContent = "—"; r.drift.className = "stat-rel-v"; }
  else {
    const perH = slope * 3600000; // ms/hour
    const sign = perH > 50 ? "v-bad" : perH < -50 ? "v-good" : "";
    r.drift.textContent = `${perH >= 0 ? "+" : ""}${(perH / 1000).toFixed(1)}s`;
    r.drift.className = `stat-rel-v ${sign}`;
  }
}

/* histogram canvas with median/p10/p90 markers */
function drawHistogram(cv, durs, cstats) {
  const w = cv.clientWidth || 320, h = cv.clientHeight || 90;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext("2d"); if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  const xs = durs.filter((d) => Number.isFinite(d));
  if (xs.length < 2) { ctx.fillStyle = "#64748b"; ctx.font = "12px sans-serif"; ctx.fillText("not enough cycles", 8, h / 2); return; }
  const min = cstats.min, max = cstats.max, range = (max - min) || 1;
  const BINS = Math.min(24, Math.max(6, Math.round(Math.sqrt(xs.length))));
  const bins = new Array(BINS).fill(0);
  for (const d of xs) { const i = Math.min(BINS - 1, Math.floor(((d - min) / range) * BINS)); bins[i] += 1; }
  const peak = Math.max(...bins) || 1;
  const bw = w / BINS;
  for (let i = 0; i < BINS; i++) {
    const bh = (bins[i] / peak) * (h - 14);
    ctx.fillStyle = "rgba(56,189,248,0.55)";
    ctx.fillRect(i * bw + 1, h - bh - 12, bw - 2, bh);
  }
  // markers
  const xOf = (v) => ((v - min) / range) * w;
  const mark = (v, color) => { if (v == null) return; ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(xOf(v), 0); ctx.lineTo(xOf(v), h - 12); ctx.stroke(); };
  mark(cstats.p10, "#22c55e"); mark(cstats.median, "#e5e7eb"); mark(cstats.p90, "#f59e0b");
}

function renderPareto(host, reasons) {
  const entries = Object.entries(reasons).filter(([, ms]) => ms > 0).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((a, [, ms]) => a + ms, 0);
  if (!total) { host.innerHTML = `<div class="stat-empty">no downtime — all cutting</div>`; return; }
  host.innerHTML = entries.map(([reason, ms]) => `
    <div class="stat-pareto-row">
      <span class="stat-pareto-name">${escapeHtml(reason)}</span>
      <span class="stat-pareto-bar"><span style="width:${(ms / total) * 100}%;background:${REASON_COLORS[reason] || "#475569"}"></span></span>
      <span class="stat-pareto-val">${fmtDur(ms)} · ${Math.round((ms / total) * 100)}%</span>
    </div>`).join("");
}
