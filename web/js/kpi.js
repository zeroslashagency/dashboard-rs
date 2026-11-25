/* VMC God-mode — KPI Scorecard console.
 *
 * Not one headline number but the KPI from every angle, all from real cycles:
 *
 *   Scorecard — fleet gauges (OEE / Availability / Performance / Utilization) with
 *               trend vs the previous equal window, per-machine OEE ladder, and a
 *               scrollable readout (best/worst machine, parts, run hours).
 *   Programs  — every job that ran: parts, median cycle, consistency, best-case
 *               cycle, production share, and SAME PROGRAM across the two halves of
 *               the window (how each job reacted — faster or slower).
 *   Timing    — day × hour throughput heatmap, BEST DAY and PEAK HOUR call-outs,
 *               hourly profile and daily bars.
 *   Trends    — are we improving? parts/cycle Theil-Sen slopes over the window,
 *               per-machine OEE ladder deltas, fleet verdict.
 *
 * Same architecture as the Maintenance console: lazy sub-views, a monotonic token
 * guard so the 15s router refresh can't strand a stale async render, hover
 * info-boxes, and a scrollable analytical readout. Read-only over dataLayer.
 */

import {
  fleetBundle, fleetKpis, byProgram, programPeriods, byDay, byHour,
  dayHourMatrix, kpiSeries, fmtSec, dayKey, dayLabel, weekdayName,
} from "./kpiCore.js";
import { initTooltips, tipAttr } from "./tooltip.js";

const SUBVIEWS = [
  { id: "scorecard", label: "Scorecard" },
  { id: "programs", label: "Programs" },
  { id: "timing", label: "Timing" },
  { id: "trends", label: "Trends" },
];
const SUB_KEY = "vmc_kpi_sub";
const LS_KPI_SNAP = "vmc_kpi_snap_v1";   // device-persisted last render per (sub,window)

const fmtPct = (v) => (v == null ? "—" : `${Math.round(v)}%`);
const oeeClass = (v) => (v == null ? "" : v >= 70 ? "tone-good" : v >= 45 ? "tone-warn" : "tone-bad");

// ---- device snapshot: persist the last good rendered HTML per (sub-view,window)
// so a cold reload or tab re-entry paints INSTANTLY, then refreshes silently.
function kpiSnapKey(sub, win) { return `${sub}|${win.key}`; }
function loadKpiSnap() {
  try {
    const raw = localStorage.getItem(LS_KPI_SNAP);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : {};
  } catch (_) { return {}; }
}
function saveKpiSnap(map) {
  try {
    const json = JSON.stringify(map);
    if (json.length > 2_500_000) return;   // device-quota safety
    localStorage.setItem(LS_KPI_SNAP, json);
  } catch (_) { /* private mode / quota — non-fatal */ }
}

export function mountKpi(body, dataLayer) {
  let sub = localStorage.getItem(SUB_KEY) || "scorecard";
  if (!SUBVIEWS.some((s) => s.id === sub)) sub = "scorecard";

  body.innerHTML = `
    <div class="mt-subnav" data-f="subnav"></div>
    <div class="mt-view" data-f="view"></div>
    <p class="ds-note" data-f="note" role="status" aria-live="polite" hidden></p>`;
  const refs = {};
  body.querySelectorAll("[data-f]").forEach((n) => { refs[n.dataset.f] = n; });
  initTooltips(body);

  for (const s of SUBVIEWS) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "mt-subnav-btn"; b.dataset.sub = s.id; b.textContent = s.label;
    b.addEventListener("click", () => { sub = s.id; localStorage.setItem(SUB_KEY, s.id); syncNav(); refresh(); });
    refs.subnav.appendChild(b);
  }
  function syncNav() {
    refs.subnav.querySelectorAll(".mt-subnav-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.sub === sub));
  }
  syncNav();

  // device-persisted last render, keyed by (sub,window) — paint instantly on
  // entry/reload, then recompute in the background and swap in fresh HTML.
  const snapMap = loadKpiSnap();
  let token = 0;

  // paint a cached HTML body for the active (sub,window) if we have one, so the
  // user never stares at "Computing…" on a tab switch or cold reload.
  function paintFromSnap(win) {
    const html = snapMap[kpiSnapKey(sub, win)];
    if (html) { refs.view.innerHTML = html; refs.note.hidden = true; return true; }
    return false;
  }
  // store the freshly rendered HTML for instant reuse next time
  function cacheRender(win) {
    snapMap[kpiSnapKey(sub, win)] = refs.view.innerHTML;
    saveKpiSnap(snapMap);
  }

  async function refresh() {
    if (document.hidden) return;        // skip work while the tab is off-screen
    const my = ++token;
    const current = () => my === token;

    // INSTANT: paint the last good render for this sub-view+window right away,
    // before any network. The fresh compute below silently replaces it.
    const win0 = dataLayer.resolveWindow();
    const hadSnap = paintFromSnap(win0);

    let ov;
    try { ov = await dataLayer.overview(); }
    catch (err) { 
      if (current() && !hadSnap) {
        const isTimeout = err.name === 'AbortError' || (err.message && err.message.includes('aborted'));
        note(refs, isTimeout 
          ? "Computing fleet KPIs — collector is slow, please wait…" 
          : "Collector unreachable — cannot fetch machine list.");
      }
      return; 
    }
    if (!current()) return;
    const machines = Array.isArray(ov.machines) ? ov.machines : [];
    if (!machines.length) { if (current() && !hadSnap) note(refs, "No machines reported."); return; }
    refs.note.hidden = true;

    const win = dataLayer.resolveWindow();
    const span = win.to - win.from;

    try {
      if (sub === "scorecard") await renderScorecard(refs.view, dataLayer, machines, win, span, current);
      else if (sub === "programs") await renderPrograms(refs.view, dataLayer, machines, win, current);
      else if (sub === "timing") await renderTiming(refs.view, dataLayer, machines, win, current);
      else if (sub === "trends") await renderTrends(refs.view, dataLayer, machines, win, span, current);
      if (current() && refs.view.children.length) cacheRender(win);
    } catch (err) {
      if (current()) {
        const isTimeout = err.name === 'AbortError' || (err.message && err.message.includes('aborted'));
        note(refs, isTimeout 
          ? "Computing KPI data — some endpoints are slow, still loading…" 
          : "Failed to compute KPI data — " + (err.message || "unknown error"));
      }
    }
  }

  return { refresh };
}

function note(refs, msg) { refs.note.textContent = msg; refs.note.hidden = false; }

/* ===================== SCORECARD ===================== */
async function renderScorecard(host, dataLayer, machines, win, span, current) {
  if (!host.children.length) host.innerHTML = `<p class="ds-note">Computing fleet KPIs…</p>`;
  const prevWin = { key: win.key, label: "prev", from: win.from - span, to: win.from };

  let curB, prevB;
  try {
    [curB, prevB] = await Promise.all([
      fleetBundle(dataLayer, machines, win),
      fleetBundle(dataLayer, machines, prevWin),
    ]);
  } catch (err) {
    if (!current()) return;
    const isTimeout = err.name === 'AbortError' || (err.message && err.message.includes('aborted'));
    host.innerHTML = `<p class="ds-note">${isTimeout 
      ? "Computing fleet KPIs — bulk endpoints are slow, still loading…" 
      : "Failed to load KPI data: " + (err.message || "unknown error")}</p>`;
    throw err; // re-throw so refresh() can catch it
  }
  if (!current()) return;
  const now = fleetKpis(curB.perMachine);
  const was = fleetKpis(prevB.perMachine);

  const gauges =
    gauge("OEE-lite", now.oee, was.oee, true,
      "Overall Equipment Effectiveness (lite) = Availability × Performance. The single headline of how productive the fleet is. Compared to the previous equal-length window.") +
    gauge("Availability", now.avail, was.avail, false,
      "Share of attended time the machines were actually cutting (run vs run+pause+idle), from the rstat execution log.") +
    gauge("Performance", now.perf, was.perf, false,
      "How close cycle times run to their best-case (p10) pace. 100% = every cycle as fast as the fleet's fastest typical cycle.") +
    gauge("Utilization", now.util, was.util, false,
      "Run time as a share of the FULL wall-clock window (not just attended) — raw spindle-on duty.") +
    `<div class="kpi-gauge kpi-parts" data-tip-title="Parts · ${tipAttr(win.label)}" data-tip="${tipAttr(`Completed cycles (M30 counter) across the fleet this window. Trend compares to the previous ${win.label}.`)}">
       <div class="kpi-parts-v ${now.parts >= was.parts ? "tone-good" : "tone-bad"}">${now.parts}</div>
       <div class="kpi-gauge-foot"><span class="kpi-gauge-label">Parts · ${win.label}</span>
       <span class="kpi-trend ${trend(now.parts, was.parts).cls}">${trend(now.parts, was.parts).arrow} ${Math.abs(now.parts - was.parts)}</span></div>
     </div>`;

  const ladderRows = curB.perMachine.map((p) => ({ name: p.name, id: p.id, oee: p.x ? p.x.oee : null, parts: p.x ? p.x.parts : 0, online: p.online }))
    .sort((a, b) => (b.oee || 0) - (a.oee || 0));

  host.innerHTML = `
    <div class="kpi-gauges">${gauges}</div>
    <div class="kpi-ladder">
      <div class="kpi-ladder-head" data-tip-title="OEE-lite by machine" data-tip="${tipAttr("Each machine's OEE for the window, ranked. The gap between top and bottom is where the fleet's easiest gains are.")}">OEE-lite by machine</div>
      ${ladderRows.map((r) => `
        <div class="kpi-ladder-row" data-tip-title="${tipAttr(`${r.name} — OEE ${fmtPct(r.oee)}`)}" data-tip="${tipAttr(`${r.parts} parts this window. ${r.online ? "Online." : "Offline."} OEE = availability × performance.`)}">
          <span class="kpi-ladder-name">${r.name}</span>
          <span class="kpi-ladder-bar"><span class="${oeeClass(r.oee)}" style="width:${r.oee == null ? 0 : Math.min(100, r.oee)}%"></span></span>
          <span class="kpi-ladder-val ${oeeClass(r.oee)}">${fmtPct(r.oee)}</span>
        </div>`).join("")}
    </div>
    ${scorecardReadout(curB, now, was, win)}`;
}

function scorecardReadout(bundle, now, was, win) {
  const scored = bundle.perMachine.filter((p) => p.x && p.x.oee != null).sort((a, b) => b.x.oee - a.x.oee);
  const best = scored[0], worst = scored[scored.length - 1];
  const dOee = was.oee != null && now.oee != null ? now.oee - was.oee : null;
  const runH = (now.runMs / 3600000);
  const stat = (val, lab, sub, tone = "") => `<div class="mt-ro-stat"><span class="mt-ro-val ${tone}">${val}</span><span class="mt-ro-lab">${lab}</span><span class="mt-ro-sub">${sub}</span></div>`;

  const rows = scored.map((p) => `<tr>
      <td>${p.name}</td>
      <td class="num">${fmtPct(p.x.oee)}</td>
      <td class="num">${fmtPct(p.x.availability)}</td>
      <td class="num">${fmtPct(p.x.performance)}</td>
      <td class="num">${p.x.parts}</td>
      <td class="num">${fmtSec(p.x.cstats.median)}</td>
    </tr>`).join("");

  return `
    <div class="mt-readout">
      <div class="mt-ro-head"><span class="mt-ro-kicker">FLEET SCORECARD · ${win.label}</span><h3>How the fleet performed</h3></div>
      <div class="mt-ro-stats">
        ${stat(fmtPct(now.oee), "Fleet OEE-lite", dOee == null ? "no prior window" : `${dOee >= 0 ? "▲" : "▼"} ${Math.abs(dOee).toFixed(1)} pts vs prev`, oeeClass(now.oee))}
        ${stat(now.parts, "Parts produced", `prev ${was.parts}`, now.parts >= was.parts ? "tone-good" : "tone-bad")}
        ${stat(runH.toFixed(1) + "h", "Run time", "spindle cutting", "")}
        ${best ? stat(best.name, "Best machine", `OEE ${fmtPct(best.x.oee)}`, "tone-good") : ""}
        ${worst && worst !== best ? stat(worst.name, "Needs focus", `OEE ${fmtPct(worst.x.oee)}`, "tone-bad") : ""}
      </div>
      <div class="mt-ro-table">
        <div class="mt-ro-cap">Per-machine breakdown — ranked by OEE</div>
        <table><thead><tr><th>Machine</th><th class="num">OEE</th><th class="num">Avail</th><th class="num">Perf</th><th class="num">Parts</th><th class="num">Median cyc</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6">no cycles in window</td></tr>`}</tbody></table>
      </div>
      <p class="mt-ro-note">OEE-lite = Availability × Performance (no quality term — the controllers don't emit a reject counter). Availability = run ÷ attended time. Performance = best-case cycle (p10) × parts ÷ run time. All from real rstat segments and M30 cycle counts over the ${win.label} window.</p>
    </div>`;
}

/* ===================== PROGRAMS ===================== */
async function renderPrograms(host, dataLayer, machines, win, current) {
  if (!host.children.length) host.innerHTML = `<p class="ds-note">Grouping cycles by program…</p>`;
  const { cycles } = await fleetBundle(dataLayer, machines, win);
  if (!current()) return;

  if (!cycles.length) {
    host.innerHTML = `<div class="mt-pred-empty">No completed cycles in this window, so there's nothing to break down by program yet. Widen the window to 7&nbsp;d.</div>`;
    return;
  }

  const progs = byProgram(cycles);
  const periods = programPeriods(cycles, win);
  const periodByProg = new Map(periods.map((p) => [p.program, p]));
  const totalParts = cycles.length;

  const head = `
    <div class="mt-pred-head">
      <div class="mt-pred-count is-ok"><span class="mt-pred-n">${progs.length}</span><span class="mt-pred-k">programs run · ${totalParts} parts</span></div>
      <span class="mt-pred-sub">cycle time, consistency &amp; how each job reacted across the window — best jobs first</span>
    </div>`;

  const cards = progs.map((p) => {
    const per = periodByProg.get(p.program);
    const cvTone = p.cv == null ? "" : p.cv < 0.1 ? "tone-good" : p.cv < 0.25 ? "tone-warn" : "tone-bad";
    const driftBadge = p.slopePerH == null ? "" :
      Math.abs(p.slopePerH) < 0.5 ? `<span class="kpi-prog-drift tone-good" data-tip-title="Stable" data-tip="Cycle time held steady across the window (Theil-Sen slope under 0.5 s/h).">● stable</span>` :
      p.slopePerH > 0 ? `<span class="kpi-prog-drift tone-bad" data-tip-title="Slowing down" data-tip="${tipAttr(`Median cycle is climbing ${p.slopePerH.toFixed(1)}s every hour — dulling tool, reduced override, or harder material. Robust Theil-Sen slope.`)}">▲ +${p.slopePerH.toFixed(1)}s/h</span>` :
      `<span class="kpi-prog-drift tone-good" data-tip-title="Speeding up" data-tip="${tipAttr(`Median cycle is dropping ${Math.abs(p.slopePerH).toFixed(1)}s/h — getting faster across the window.`)}">▼ ${p.slopePerH.toFixed(1)}s/h</span>`;

    const periodBlock = per ? (() => {
      const faster = per.deltaPct < 0;
      const tone = Math.abs(per.deltaPct) < 3 ? "tone-warn" : faster ? "tone-good" : "tone-bad";
      return `<div class="kpi-prog-period" data-tip-title="Same program, two halves of the window" data-tip="${tipAttr(`First half: median ${fmtSec(per.firstMed)} over ${per.na} parts. Second half: ${fmtSec(per.secondMed)} over ${per.nb} parts. ${faster ? "Got faster" : "Got slower"} by ${Math.abs(per.deltaPct).toFixed(1)}%.`)}">
        <span class="kpi-pp-half">1st ${fmtSec(per.firstMed)}</span>
        <span class="kpi-pp-arrow ${tone}">${faster ? "→ ▼" : "→ ▲"}</span>
        <span class="kpi-pp-half">2nd ${fmtSec(per.secondMed)}</span>
        <span class="kpi-pp-delta ${tone}">${per.deltaPct >= 0 ? "+" : ""}${per.deltaPct.toFixed(1)}%</span>
      </div>`;
    })() : `<div class="kpi-prog-period kpi-pp-na">not enough cycles to split the window</div>`;

    return `<div class="kpi-prog-card">
      <div class="kpi-prog-top">
        <span class="kpi-prog-name" data-tip-title="${tipAttr(`Program ${p.program}`)}" data-tip="${tipAttr(`${p.n} parts on ${p.machines.join(", ")}. ${(p.share * 100).toFixed(0)}% of the window's production by run time.`)}">${escapeHtml(p.program)}</span>
        ${driftBadge}
      </div>
      <div class="kpi-prog-stats">
        <div class="kpi-prog-stat" data-tip-title="Parts" data-tip="Completed cycles of this program in the window."><span class="kpi-ps-v">${p.n}</span><span class="kpi-ps-l">parts</span></div>
        <div class="kpi-prog-stat" data-tip-title="Median cycle" data-tip="Typical cycle time (50th percentile) — robust to outliers."><span class="kpi-ps-v">${fmtSec(p.median)}</span><span class="kpi-ps-l">median</span></div>
        <div class="kpi-prog-stat" data-tip-title="Best-case cycle" data-tip="10th-percentile cycle — what this job achieves when everything's right. The gap to median is recoverable time."><span class="kpi-ps-v">${fmtSec(p.p10)}</span><span class="kpi-ps-l">best</span></div>
        <div class="kpi-prog-stat" data-tip-title="Consistency (CV)" data-tip="${tipAttr(`Coefficient of variation = spread ÷ mean. ${p.cv == null ? "" : (p.cv * 100).toFixed(0) + "% — "}lower is more repeatable. Above 25% means cycles are scattering.`)}"><span class="kpi-ps-v ${cvTone}">${p.cv == null ? "—" : (p.cv * 100).toFixed(0) + "%"}</span><span class="kpi-ps-l">CV</span></div>
      </div>
      <div class="kpi-prog-share" data-tip-title="Production share" data-tip="${tipAttr(`This program is ${(p.share * 100).toFixed(1)}% of the window's total run time.`)}">
        <span class="kpi-prog-share-bar"><span style="width:${(p.share * 100).toFixed(1)}%"></span></span>
        <span class="kpi-prog-share-v">${(p.share * 100).toFixed(0)}%</span>
      </div>
      ${periodBlock}
    </div>`;
  }).join("");

  host.innerHTML = head + `<div class="kpi-prog-grid">${cards}</div>
    <p class="mt-ro-note">Each program's cycle stats come from real M30 completions tagged by the ncprog timeline. "Same program, two halves" splits the window at its midpoint and compares median cycle — the honest read on whether a job sped up or slowed down. Drift is a Theil-Sen slope (robust to a few odd cycles).</p>`;
}

/* ===================== TIMING ===================== */
async function renderTiming(host, dataLayer, machines, win, current) {
  if (!host.children.length) host.innerHTML = `<p class="ds-note">Building day × hour profile…</p>`;
  const { cycles } = await fleetBundle(dataLayer, machines, win);
  if (!current()) return;

  if (!cycles.length) {
    host.innerHTML = `<div class="mt-pred-empty">No cycles in this window to profile by day or hour.</div>`;
    return;
  }

  const days = byDay(cycles);
  const hours = byHour(cycles);
  const mat = dayHourMatrix(cycles);

  const bestDay = days.slice().sort((a, b) => b.parts - a.parts)[0];
  const peakHour = hours.slice().sort((a, b) => b.parts - a.parts)[0];
  const maxDayParts = Math.max(...days.map((d) => d.parts), 1);
  const maxHourParts = Math.max(...hours.map((h) => h.parts), 1);

  // call-outs
  const callouts = `
    <div class="kpi-callouts">
      <div class="kpi-callout tone-good" data-tip-title="Best day" data-tip="${tipAttr(`${bestDay ? weekdayName(bestDay.day) + ", " + dayLabel(bestDay.day) : "—"} produced the most parts (${bestDay ? bestDay.parts : 0}) with a median cycle of ${bestDay ? fmtSec(bestDay.median) : "—"}.`)}">
        <span class="kpi-callout-k">BEST DAY</span>
        <span class="kpi-callout-v">${bestDay ? dayLabel(bestDay.day) : "—"}</span>
        <span class="kpi-callout-sub">${bestDay ? bestDay.parts + " parts · " + fmtSec(bestDay.median) + " median" : ""}</span>
      </div>
      <div class="kpi-callout tone-good" data-tip-title="Peak hour" data-tip="${tipAttr(`Hour ${peakHour ? hourLabel(peakHour.hour) : "—"} of the day is when the fleet completes the most parts (${peakHour ? peakHour.parts : 0} across the window). Schedule the heaviest jobs here.`)}">
        <span class="kpi-callout-k">PEAK HOUR</span>
        <span class="kpi-callout-v">${peakHour ? hourLabel(peakHour.hour) : "—"}</span>
        <span class="kpi-callout-sub">${peakHour ? peakHour.parts + " parts total" : ""}</span>
      </div>
      <div class="kpi-callout" data-tip-title="Active days" data-tip="Number of distinct local days with at least one completed part in this window.">
        <span class="kpi-callout-k">ACTIVE DAYS</span>
        <span class="kpi-callout-v">${days.length}</span>
        <span class="kpi-callout-sub">${cycles.length} parts total</span>
      </div>
    </div>`;

  // heatmap
  const heatmap = mat.days.length ? `
    <div class="kpi-heat">
      <div class="kpi-heat-title">Throughput · day × hour</div>
      <div class="kpi-heat-grid">
        <div class="kpi-heat-corner"></div>
        ${Array.from({ length: 24 }, (_, h) => `<div class="kpi-heat-hh">${h % 3 === 0 ? h : ""}</div>`).join("")}
        ${mat.days.map((d) => `
          <div class="kpi-heat-day">${dayLabel(d).replace(/,.*/, "")}</div>
          ${mat.grid.get(d).map((v, h) => {
            const a = mat.max ? v / mat.max : 0;
            return `<div class="kpi-heat-cell" style="background:${heatColor(a)}" data-tip-title="${tipAttr(`${dayLabel(d)} · ${hourLabel(h)}`)}" data-tip="${tipAttr(`${v} part${v === 1 ? "" : "s"} completed.`)}"></div>`;
          }).join("")}`).join("")}
      </div>
      <div class="kpi-heat-legend"><span>less</span><span class="kpi-heat-scale"></span><span>more</span></div>
    </div>` : "";

  // hourly profile bars
  const hourBars = `
    <div class="kpi-tim-block">
      <div class="kpi-tim-title">Parts by hour of day</div>
      <div class="kpi-hour-bars">
        ${hours.map((h) => `<div class="kpi-hbar ${peakHour && h.hour === peakHour.hour ? "is-peak" : ""}" data-tip-title="${tipAttr(hourLabel(h.hour))}" data-tip="${tipAttr(`${h.parts} parts · median ${fmtSec(h.median)}`)}">
          <span class="kpi-hbar-fill" style="height:${Math.round((h.parts / maxHourParts) * 100)}%"></span>
          <span class="kpi-hbar-x">${h.hour % 6 === 0 ? h.hour : ""}</span>
        </div>`).join("")}
      </div>
    </div>`;

  // daily bars
  const dayBars = `
    <div class="kpi-tim-block">
      <div class="kpi-tim-title">Parts by day</div>
      <div class="kpi-day-bars">
        ${days.map((d) => `<div class="kpi-dbar ${bestDay && d.day === bestDay.day ? "is-best" : ""}" data-tip-title="${tipAttr(dayLabel(d.day))}" data-tip="${tipAttr(`${d.parts} parts · median ${fmtSec(d.median)}`)}">
          <span class="kpi-dbar-fill" style="width:${Math.round((d.parts / maxDayParts) * 100)}%"></span>
          <span class="kpi-dbar-lab">${dayLabel(d.day).replace(/,.*/, "")}</span>
          <span class="kpi-dbar-v">${d.parts}</span>
        </div>`).join("")}
      </div>
    </div>`;

  host.innerHTML = callouts + heatmap + `<div class="kpi-tim-row">${hourBars}${dayBars}</div>
    <p class="mt-ro-note">Every cell, bar and call-out counts real completed cycles (M30) by their completion time in local clock. Best day = most parts; peak hour = the hour-of-day that totals the most parts across the window — that's your scheduling sweet spot.</p>`;
}

/* ===================== TRENDS ===================== */
async function renderTrends(host, dataLayer, machines, win, span, current) {
  if (!host.children.length) host.innerHTML = `<p class="ds-note">Measuring improvement…</p>`;
  const prevWin = { key: win.key, label: "prev", from: win.from - span, to: win.from };
  const [curB, prevB] = await Promise.all([
    fleetBundle(dataLayer, machines, win),
    fleetBundle(dataLayer, machines, prevWin),
  ]);
  if (!current()) return;

  const now = fleetKpis(curB.perMachine);
  const was = fleetKpis(prevB.perMachine);
  const ser = kpiSeries(curB.cycles, win, 8);

  const partsVerdict = ser.partsSlopePerH == null ? null : ser.partsSlopePerH > 0.05 ? "up" : ser.partsSlopePerH < -0.05 ? "down" : "flat";
  const cycVerdict = ser.medSlopePerH == null ? null : ser.medSlopePerH < -0.3 ? "up" : ser.medSlopePerH > 0.3 ? "down" : "flat";

  const verdictCard = (title, verdict, detail, tip) => {
    const map = { up: ["tone-good", "▲ improving"], down: ["tone-bad", "▼ slipping"], flat: ["tone-warn", "→ holding"] };
    const [tone, lab] = map[verdict] || ["", "— no read"];
    return `<div class="kpi-verdict ${tone}" data-tip-title="${tipAttr(title)}" data-tip="${tipAttr(tip)}">
      <span class="kpi-verdict-lab">${lab}</span><span class="kpi-verdict-k">${title}</span><span class="kpi-verdict-sub">${detail}</span></div>`;
  };

  // per-machine OEE delta vs previous
  const prevById = new Map(prevB.perMachine.map((p) => [p.id, p.x ? p.x.oee : null]));
  const deltas = curB.perMachine.map((p) => {
    const cur = p.x ? p.x.oee : null, pre = prevById.get(p.id);
    return { name: p.name, cur, delta: cur != null && pre != null ? cur - pre : null };
  }).sort((a, b) => (b.delta ?? -999) - (a.delta ?? -999));

  const head = `
    <div class="mt-pred-head">
      <div class="mt-pred-count ${partsVerdict === "up" ? "is-ok" : "is-warn"}"><span class="mt-pred-n">${fmtPct(now.oee)}</span><span class="mt-pred-k">fleet OEE · ${win.label}</span></div>
      <span class="mt-pred-sub">are we improving? — Theil-Sen trends within the window and vs the previous ${win.label}</span>
    </div>`;

  const verdicts = `<div class="kpi-verdicts">
    ${verdictCard("Throughput trend", partsVerdict, ser.partsSlopePerH == null ? "no read" : `${ser.partsSlopePerH >= 0 ? "+" : ""}${ser.partsSlopePerH.toFixed(2)} parts/h slope`,
      "Slope of parts-per-bin across the window (8 bins). Rising = throughput building through the window.")}
    ${verdictCard("Cycle-time trend", cycVerdict, ser.medSlopePerH == null ? "no read" : `${ser.medSlopePerH >= 0 ? "+" : ""}${ser.medSlopePerH.toFixed(2)} s/h slope`,
      "Slope of median cycle time. Falling cycle time = improving (faster) — so down here is good.")}
    ${verdictCard("OEE vs prev", was.oee == null || now.oee == null ? null : (now.oee - was.oee > 1 ? "up" : now.oee - was.oee < -1 ? "down" : "flat"),
      was.oee == null ? "no prior window" : `${now.oee - was.oee >= 0 ? "+" : ""}${(now.oee - was.oee).toFixed(1)} pts`,
      "Fleet OEE this window minus the previous equal window.")}
  </div>`;

  const spark = kpiSparkline(ser.pts);

  const ladder = deltas.map((d) => {
    const tone = d.delta == null ? "" : d.delta > 1 ? "tone-good" : d.delta < -1 ? "tone-bad" : "tone-warn";
    const arrow = d.delta == null ? "—" : d.delta > 0 ? "▲" : d.delta < 0 ? "▼" : "→";
    return `<div class="kpi-delta-row" data-tip-title="${tipAttr(d.name)}" data-tip="${tipAttr(`OEE now ${fmtPct(d.cur)}${d.delta == null ? "" : `, ${d.delta >= 0 ? "+" : ""}${d.delta.toFixed(1)} pts vs previous ${win.label}`}.`)}">
      <span class="kpi-delta-name">${d.name}</span>
      <span class="kpi-delta-cur">${fmtPct(d.cur)}</span>
      <span class="kpi-delta-d ${tone}">${arrow} ${d.delta == null ? "" : Math.abs(d.delta).toFixed(1)}</span>
    </div>`;
  }).join("");

  host.innerHTML = head + verdicts + `
    <div class="kpi-trend-spark">
      <div class="kpi-tim-title">Parts per time bin — ${win.label} (oldest → newest)</div>
      ${spark}
    </div>
    <div class="kpi-delta-block">
      <div class="kpi-tim-title">Per-machine OEE change vs previous ${win.label}</div>
      ${ladder || `<div class="mt-pred-empty">No comparable previous window yet.</div>`}
    </div>
    <p class="mt-ro-note">Trends use Theil-Sen robust slopes so a couple of odd cycles don't swing the verdict. The window is split into 8 equal time bins; "improving" means more parts and/or shorter cycles as the window progresses. OEE deltas compare each machine to its own previous ${win.label}.</p>`;
}

/* ===================== shared bits ===================== */
function trend(now, was) {
  if (now == null || was == null) return { arrow: "", cls: "" };
  const d = now - was;
  if (Math.abs(d) < 0.5) return { arrow: "→", cls: "t-flat" };
  return d > 0 ? { arrow: "▲", cls: "t-up" } : { arrow: "▼", cls: "t-down" };
}

function gauge(label, val, was, primary, tip) {
  const t = trend(val, was);
  const pct = val == null ? 0 : Math.max(0, Math.min(100, val));
  const ring = `conic-gradient(currentColor ${pct * 3.6}deg, rgba(255,255,255,0.07) 0deg)`;
  return `
    <div class="kpi-gauge ${primary ? "is-primary" : ""} ${oeeClass(val)}" data-tip-title="${tipAttr(`${label} ${fmtPct(val)}`)}" data-tip="${tipAttr(tip || "")}">
      <div class="kpi-ring" style="background:${ring}"><span class="kpi-ring-v">${fmtPct(val)}</span></div>
      <div class="kpi-gauge-foot">
        <span class="kpi-gauge-label">${label}</span>
        <span class="kpi-trend ${t.cls}" title="change vs previous window, in percentage points">${t.arrow} ${was == null ? "" : `${Math.abs((val || 0) - was).toFixed(1)} pts`}</span>
      </div>
    </div>`;
}

function kpiSparkline(pts) {
  const vals = pts.map((p) => p.parts);
  const max = Math.max(...vals, 1);
  const w = 100, n = pts.length;
  return `<div class="kpi-spark-bars">
    ${pts.map((p) => `<div class="kpi-spark-bar" data-tip-title="${tipAttr(new Date(p.t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit" }))}" data-tip="${tipAttr(`${p.parts} parts · median ${fmtSec(p.median)}`)}">
      <span style="height:${Math.round((p.parts / max) * 100)}%"></span></div>`).join("")}
  </div>`;
}

function hourLabel(h) { const ap = h < 12 ? "am" : "pm"; const hr = h % 12 === 0 ? 12 : h % 12; return `${hr}${ap}`; }
function heatColor(a) {
  // 0 -> faint panel, 1 -> accent. perceptual-ish ramp on the accent hue.
  if (a <= 0) return "rgba(148,163,184,0.06)";
  return `rgba(56,189,248,${(0.12 + a * 0.85).toFixed(3)})`;
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
