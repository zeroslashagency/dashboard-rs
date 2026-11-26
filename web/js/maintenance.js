/* VMC God-mode — Maintenance console.
 *
 * A predictive-maintenance workbench, not just a service meter. Four sub-views,
 * every number from a real collector signal (see maintCore.js):
 *
 *   Overview   — per-machine health ring (composite 0-100) with its five legs,
 *                service/spindle odometers, tool-wear watch, fleet roll-up.
 *   Predictive — the "catch it before the event" board: a fleet watchlist of
 *                tool-wear projections, service countdowns, cycle-drift and
 *                fault-rate risks, ranked by soonest.
 *   Trends     — daily / weekly / monthly health %, accumulated from real daily
 *                snapshots (the box only keeps ~38h, so longer windows grow as
 *                real days are observed; each panel states how many it has).
 *   Timeline   — maintenance events auto-read from the logs (alarms, e-stops,
 *                feed-holds, tool/program changes), merged chronologically.
 *
 * Mounts into its own view container; refresh() is driven by the router while the
 * tab is active. No backend change — read-only over the shared dataLayer.
 */

import {
  health, predict, rollup, recordDaily, timeline,
  WEAR_WARN, WEAR_LIMIT, LEG_WEIGHTS, fmtHours,
} from "./maintCore.js";
import { initTooltips, tipAttr } from "./tooltip.js";

const SUBVIEWS = [
  { id: "overview", label: "Overview" },
  { id: "predictive", label: "Predictive" },
  { id: "trends", label: "Trends" },
  { id: "timeline", label: "Timeline" },
];
const SUB_KEY = "vmc_maint_sub";
const SEV_RANK = { warn: 2, soon: 1, info: 0, ok: 0 };

export function mountMaintenance(body, dataLayer) {
  let sub = localStorage.getItem(SUB_KEY) || "overview";
  if (!SUBVIEWS.some((s) => s.id === sub)) sub = "overview";

  body.innerHTML = `
    <div class="mt-subnav" data-f="subnav"></div>
    <div class="mt-view" data-f="view"></div>
    <p class="ds-note" data-f="note" hidden></p>`;
  const refs = {};
  body.querySelectorAll("[data-f]").forEach((n) => { refs[n.dataset.f] = n; });
  initTooltips(body); // delegated hover info-boxes — survives innerHTML re-renders

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

  let last = null; // cache of the last fleet computation for instant sub-view switches
  let token = 0;   // monotonic guard: the router refreshes every 15s and sub-views
                   // are async, so a stale render must never overwrite a newer one.

  async function refresh() {
    if (document.hidden) return;   // router keeps the timer; skip work while off-screen
    const my = ++token;
    const current = () => my === token;
    let ov, audit = null;
    try { ov = await dataLayer.overview(); }
    catch (_) { if (current()) note(refs, "Collector unreachable."); return; }
    try { audit = await dataLayer.gapAudit(); } catch (_) {}
    if (!current()) return;
    const machines = Array.isArray(ov.machines) ? ov.machines : [];
    if (!machines.length) { if (current()) note(refs, "No machines reported."); return; }
    refs.note.hidden = true;
    const win = dataLayer.resolveWindow();

    // Health for every machine drives Overview + Trends snapshots; predictions and
    // timeline are pulled per active view to keep background refreshes cheap.
    const healths = await Promise.all(machines.map((m) => health(dataLayer, m, win, audit)));
    if (!current()) return;
    for (const h of healths) {
      // persist today's real snapshot so weekly/monthly can accumulate.
      recordDaily(h.id, h.score, { online: h.online });
    }
    last = { machines, healths, win, audit };

    if (sub === "overview") return renderOverview(refs.view, last);
    if (sub === "trends") return renderTrends(refs.view, last);
    if (sub === "predictive") return renderPredictive(refs.view, dataLayer, last, current);
    if (sub === "timeline") return renderTimeline(refs.view, dataLayer, last, current);
  }

  return { refresh };
}

function note(refs, msg) { refs.note.textContent = msg; refs.note.hidden = false; }

/* ===================== OVERVIEW ===================== */
function renderOverview(host, last) {
  const { healths } = last;
  const scored = healths.filter((h) => h.score != null);
  const fleetAvg = scored.length ? scored.reduce((a, h) => a + h.score, 0) / scored.length : null;
  const worst = scored.slice().sort((a, b) => a.score - b.score)[0];

  host.innerHTML = `
    <div class="mt-fleet">
      <div class="mt-fleet-score">
        ${ring(fleetAvg, 64)}
        <div class="mt-fleet-meta">
          <span class="mt-fleet-k">FLEET HEALTH</span>
          <span class="mt-fleet-sub">${scored.length}/${healths.length} machines scored${worst ? ` · weakest ${worst.id} ${Math.round(worst.score)}` : ""}</span>
        </div>
      </div>
    </div>
    <div class="mt-grid" data-f="grid"></div>
    <div class="mt-readout" data-f="readout"></div>`;
  const grid = host.querySelector('[data-f="grid"]');

  for (const h of healths) grid.appendChild(overviewCard(h));

  // readout: fleet leg breakdown + ranked weak points
  renderOverviewReadout(host.querySelector('[data-f="readout"]'), healths);
}

function overviewCard(h) {
  const root = document.createElement("div");
  root.className = `mt-card ${h.online ? "" : "is-offline"}`;
  const tone = h.score == null ? "" : h.score >= 80 ? "tone-good" : h.score >= 60 ? "tone-warn" : "tone-bad";

  const legRows = ["availability", "reliability", "tool", "stability", "comms"].map((k) => {
    const leg = h.legs[k];
    if (!leg) return `<div class="mt-leg is-na" data-tip-title="${tipAttr(legLabel(k) + " — no signal")}" data-tip="${tipAttr(legNaTip(k))}"><span class="mt-leg-k">${legLabel(k)}</span><span class="mt-leg-v">n/a</span></div>`;
    const t = leg.value >= 80 ? "good" : leg.value >= 60 ? "warn" : "bad";
    return `<div class="mt-leg" data-tip-title="${tipAttr(`${h.id} · ${leg.label} ${Math.round(leg.value)}/100`)}" data-tip="${tipAttr(legTip(k, leg, h))}">
        <span class="mt-leg-k">${leg.label}</span>
        <span class="mt-leg-bar"><span class="t-${t}" style="width:${Math.round(leg.value)}%"></span></span>
        <span class="mt-leg-v">${Math.round(leg.value)}</span>
      </div>`;
  }).join("");

  const tools = h.wear.slots;
  const toolBlock = !h.wear.observed
    ? `<div class="mt-tool-na" data-tip-title="Tool-wear table not emitted" data-tip="This controller doesn't broadcast diamwear/lengthwear offset tables, so we can't watch tool wear here. The Tool-headroom health leg is skipped (not counted against the machine) rather than guessed.">tool-wear table not emitted</div>`
    : !tools.length
      ? `<div class="mt-tool-ok" data-tip-title="All tools nominal" data-tip="Every dialed-in wear offset is under ${WEAR_WARN}mm. No tool is being compensated enough to worry about — full tool headroom.">all tools within ${WEAR_WARN}mm</div>`
      : tools.slice(0, 6).map((t) => {
          const pctLimit = Math.round((t.mag / WEAR_LIMIT) * 100);
          const tag = t.mag >= WEAR_LIMIT ? "replace" : "watch";
          const tip = `${tipAttr(toolTip(h.id, t, pctLimit, tag))}`;
          return `
          <div class="mt-tool ${t.mag >= WEAR_LIMIT ? "is-bad" : "is-warn"}" data-tip-title="${tipAttr(`${h.id} · Tool T${t.slot} — ${tag.toUpperCase()}`)}" data-tip="${tip}">
            <span class="mt-tool-slot">T${t.slot}</span>
            <span class="mt-tool-wear">Ø${sgn(t.diam)} L${sgn(t.len)}</span>
            <span class="mt-tool-tag">${window.VMCStatusPill ? window.VMCStatusPill.innerMarkup(t.mag >= WEAR_LIMIT ? "bad" : "warn", tag) : tag}</span>
          </div>`;
        }).join("");

  root.innerHTML = `
    <div class="mt-card-head" data-tip-title="${tipAttr(`${h.id} composite health ${h.score == null ? "—" : Math.round(h.score)}/100`)}" data-tip="${tipAttr(healthTip(h))}">
      ${ring(h.score, 44)}
      <div class="mt-card-titles">
        <span class="mt-card-name ${tone}">${h.id}</span>
        <span class="mt-card-state">${h.online ? "online" : "offline"} · health ${h.score == null ? "—" : Math.round(h.score)}</span>
      </div>
    </div>
    <div class="mt-legs">${legRows}</div>
    <div class="mt-tools">
      <div class="mt-tools-k" data-tip-title="Tool-wear watch" data-tip="Active tools whose dialed-in wear offset has crossed ${WEAR_WARN}mm. Ø = diameter compensation, L = length compensation. 'watch' = past ${WEAR_WARN}mm, 'replace' = past the ${WEAR_LIMIT}mm limit. Read live from the controller's diamwear/lengthwear offset tables.">TOOL-WEAR WATCH</div>
      ${toolBlock}
    </div>`;
  return root;
}

function renderOverviewReadout(host, healths) {
  // fleet leg means
  const keys = ["availability", "reliability", "tool", "stability", "comms"];
  const means = keys.map((k) => {
    const xs = healths.map((h) => h.legs[k]).filter(Boolean).map((l) => l.value);
    return { k, label: legLabel(k), avg: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null, n: xs.length };
  });
  const statCards = means.map((m) => {
    const tone = m.avg == null ? "" : m.avg >= 80 ? "tone-good" : m.avg >= 60 ? "tone-warn" : "tone-bad";
    return `<div class="mt-ro-stat"><span class="mt-ro-val ${tone}">${m.avg == null ? "n/a" : Math.round(m.avg)}</span><span class="mt-ro-lab">${m.label}</span><span class="mt-ro-sub">${m.n}/${healths.length} machines</span></div>`;
  }).join("");

  // weakest-leg ranking across the fleet (where to look first)
  const weak = [];
  for (const h of healths) for (const [k, leg] of Object.entries(h.legs)) weak.push({ id: h.id, k, ...leg });
  weak.sort((a, b) => a.value - b.value);
  const rows = weak.slice(0, 8).map((w) =>
    `<tr><td>${w.id}</td><td>${w.label}</td><td class="num">${Math.round(w.value)}</td><td>${w.detail || ""}</td></tr>`).join("");

  host.innerHTML = `
    <div class="mt-ro-head"><span class="mt-ro-kicker">FLEET HEALTH BREAKDOWN</span><h3>Where the risk is</h3></div>
    <div class="mt-ro-stats">${statCards}</div>
    <div class="mt-ro-table">
      <div class="mt-ro-cap">Weakest health legs across the fleet — lowest first</div>
      <table><thead><tr><th>Machine</th><th>Leg</th><th class="num">Score</th><th>Detail</th></tr></thead><tbody>${rows || `<tr><td colspan="4">no scored legs yet</td></tr>`}</tbody></table>
    </div>
    <p class="mt-ro-note">Composite health = weighted mean of available legs (availability 30 · reliability 25 · tool 20 · stability 15 · comms 10), renormalized when a signal isn't emitted. Every leg is computed from real polled samples over the selected window.</p>`;
}

/* ===================== PREDICTIVE ===================== */
async function renderPredictive(host, dataLayer, last, current = () => true) {
  const { machines, win } = last;
  host.innerHTML = `<p class="ds-note">Projecting from real trend slopes…</p>`;

  const lists = await Promise.all(machines.map(async (m) => {
    try { return await predict(dataLayer, m, win); } catch (_) { return []; }
  }));
  if (!current()) return;
  const all = [];
  machines.forEach((m, i) => lists[i].forEach((p) => all.push({ ...p, machine: p.machine || m.machine_id })));

  // rank: severity desc, then soonest etaMs, then put dated ones ahead of undated
  all.sort((a, b) => {
    const sv = (SEV_RANK[b.sev] || 0) - (SEV_RANK[a.sev] || 0);
    if (sv) return sv;
    const ae = a.etaMs ?? Infinity, be = b.etaMs ?? Infinity;
    return ae - be;
  });

  const warn = all.filter((p) => p.sev === "warn").length;
  const head = `
    <div class="mt-pred-head">
      <div class="mt-pred-count ${warn ? "is-warn" : "is-ok"}">
        <span class="mt-pred-n">${all.length}</span>
        <span class="mt-pred-k">open risks${warn ? ` · ${warn} need attention` : ""}</span>
      </div>
      <span class="mt-pred-sub">tool-wear slopes, service countdowns, cycle drift &amp; fault-rate — ranked by urgency</span>
    </div>`;

  if (!all.length) {
    host.innerHTML = head + `<div class="mt-pred-empty">Nothing trending toward a fault in the current window. Every health leg is inside its tolerance — keep the window on 7&nbsp;d to catch slow drift.</div>`;
    return;
  }

  const rows = all.map((p) => {
    const icon = KIND_ICON[p.kind] || "•";
    const when = p.etaMs ? `<span class="mt-risk-when">${etaText(p.etaMs)}</span>` : "";
    return `<div class="mt-risk sev-${p.sev}" data-tip-title="${tipAttr(`${p.machine} · ${p.title}`)}" data-tip="${tipAttr(riskTip(p))}">
        <span class="mt-risk-icon">${icon}</span>
        <div class="mt-risk-body">
          <div class="mt-risk-top"><span class="mt-risk-machine">${p.machine}</span><span class="mt-risk-title">${p.title}</span></div>
          <div class="mt-risk-detail">${p.detail || ""}</div>
        </div>
        <div class="mt-risk-right"><span class="mt-risk-val">${p.value}</span>${when}</div>
      </div>`;
  }).join("");

  host.innerHTML = head + `<div class="mt-risk-list">${rows}</div>
    <p class="mt-ro-note">Projections use Theil-Sen (robust) slopes over real recorded samples. Tool-wear ETA = (limit ${WEAR_LIMIT}mm − current offset) ÷ wear rate. Service/spindle items read the live runtime odometer but are <em>estimates</em>: the controller emits no last-service reset marker, so they assume servicing at each interval multiple and are labelled "est."</p>`;
}

const KIND_ICON = { tool: "⛏", service: "⚙", spindle: "✸", drift: "📈", faultrate: "⚠" };

/* ===================== TRENDS ===================== */
function renderTrends(host, last) {
  const { healths } = last;
  host.innerHTML = `
    <div class="mt-trend-head"><span class="mt-ro-kicker">HEALTH OVER TIME</span><h3>Daily · Weekly · Monthly</h3>
      <span class="mt-pred-sub">accumulated from real daily snapshots — longer windows fill in as days are observed</span></div>
    <div class="mt-trend-grid" data-f="grid"></div>`;
  const grid = host.querySelector('[data-f="grid"]');

  for (const h of healths) {
    const r = rollup(h.id);
    const card = document.createElement("div");
    card.className = "mt-trend-card";
    card.innerHTML = `
      <div class="mt-trend-name">${h.id}</div>
      <div class="mt-trend-rows">
        ${trendRow("Daily", r.daily, "today")}
        ${trendRow("Weekly", r.weekly, "7-day avg")}
        ${trendRow("Monthly", r.monthly, "30-day avg")}
      </div>
      <div class="mt-spark">${sparkline(r.series)}</div>
      <div class="mt-trend-foot">${r.series.length} day${r.series.length === 1 ? "" : "s"} of real data</div>`;
    grid.appendChild(card);
  }
}

function trendRow(label, span, tail) {
  const v = span.avg;
  const tone = v == null ? "" : v >= 80 ? "tone-good" : v >= 60 ? "tone-warn" : "tone-bad";
  const partial = span.days < span.want ? `<span class="mt-trend-partial">${span.days}/${span.want}d</span>` : "";
  return `<div class="mt-trend-row">
      <span class="mt-trend-lab">${label}</span>
      <span class="mt-trend-bar"><span class="${tone}" style="width:${v == null ? 0 : Math.round(v)}%"></span></span>
      <span class="mt-trend-val ${tone}">${v == null ? "—" : Math.round(v)}</span>
      <span class="mt-trend-tail">${partial || tail}</span>
    </div>`;
}

function sparkline(series) {
  if (!series.length) return `<span class="mt-spark-empty">no history yet — snapshots build daily</span>`;
  const w = 220, h = 34, n = series.length;
  const xs = (i) => n <= 1 ? w / 2 : (i / (n - 1)) * w;
  const ys = (v) => h - (clamp(v) / 100) * h;
  const pts = series.map((s, i) => `${xs(i).toFixed(1)},${ys(s.score).toFixed(1)}`).join(" ");
  const dots = series.map((s, i) => `<circle cx="${xs(i).toFixed(1)}" cy="${ys(s.score).toFixed(1)}" r="1.6"/>`).join("");
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="mt-spark-svg">
      <polyline points="${pts}" fill="none" />${dots}</svg>`;
}

/* ===================== TIMELINE ===================== */
async function renderTimeline(host, dataLayer, last, current = () => true) {
  const { machines, win } = last;
  host.innerHTML = `<p class="ds-note">Reading the logs…</p>`;

  const lists = await Promise.all(machines.map((m) => timeline(dataLayer, m.machine_id, win).catch(() => [])));
  if (!current()) return;
  let events = [];
  for (const l of lists) events = events.concat(l);
  events.sort((a, b) => b.ts - a.ts);

  const counts = events.reduce((acc, e) => { acc[e.kind] = (acc[e.kind] || 0) + 1; return acc; }, {});
  const chip = (k, lab) => {
    const label = `${lab} ${counts[k] || 0}`;
    const inner = window.VMCStatusPill
      ? window.VMCStatusPill.innerMarkup(k, label)
      : `${KIND_ICON[k] || ""} ${label}`;
    return `<span class="mt-tl-chip kind-${k}">${inner}</span>`;
  };
  const head = `
    <div class="mt-tl-head">
      <span class="mt-ro-kicker">MAINTENANCE LOG · ${last.win.label}</span>
      <div class="mt-tl-chips">
        ${chip("alarm", "alarms")}${chip("estop", "e-stops")}${chip("hold", "holds")}${chip("tool", "tools")}${chip("program", "programs")}
      </div>
    </div>`;

  if (!events.length) {
    host.innerHTML = head + `<div class="mt-pred-empty">No maintenance-relevant events in this window — clean run.</div>`;
    return;
  }

  const rows = events.slice(0, 200).map((e) => `
    <div class="mt-tl-row sev-${e.sev} kind-${e.kind}">
      <span class="mt-tl-time">${clock(e.ts)}</span>
      <span class="mt-tl-machine">${e.machine}</span>
      <span class="mt-tl-icon">${KIND_ICON[e.kind] || "•"}</span>
      <span class="mt-tl-text">${escapeHtml(e.text)}</span>
    </div>`).join("");
  host.innerHTML = head + `<div class="mt-tl-list">${rows}</div>`;
}

/* ===================== explanation builders (hover info-boxes) ===================== */
/* Each returns plain-text prose: what the number is, how it's measured, and how it
 * impacts the machine/system. Rendered as textContent, so no escaping needed here. */

function toolTip(id, t, pctLimit, tag) {
  const worst = Math.abs(t.diam) >= Math.abs(t.len) ? `diameter Ø${t.diam.toFixed(2)}mm` : `length L${t.len.toFixed(2)}mm`;
  const lines = [
    `The control is compensating this tool by ${worst} for wear — that's ${pctLimit}% of the ${WEAR_LIMIT}mm replace limit.`,
    tag === "replace"
      ? `It has crossed the limit. Keep cutting and you risk out-of-tolerance parts and a sudden tool failure. Replace or re-set this tool.`
      : `Still inside tolerance but trending up. Parts stay good for now; plan a swap before it reaches ${WEAR_LIMIT}mm.`,
    `Impact: drives the Tool-headroom health leg for ${id}. The most-worn tool sets that leg, so this number is pulling ${id}'s overall health down.`,
  ];
  return lines.join("\n\n");
}

const LEG_TIP = {
  availability: "Share of attended time the machine was actually cutting (run vs run+pause+idle), from the rstat execution log. Low means the spindle is on the clock but not making chips — setup, waiting, or holds.",
  reliability: "Starts at 100 and is docked for faults over the window: −25 per e-stop, −15 per alarm assert. Each event is a real recorded transition in the log. Low means the machine keeps faulting and needs attention.",
  tool: "Headroom left before the worst tool hits the replace limit. 100 = all tools fresh; 0 = a tool is at the limit. Read from the live diamwear/lengthwear offset tables.",
  stability: "How repeatable the cycle time is — 100 minus the coefficient of variation across recent cycles. Low means cycles are scattering, which points at tool wear, feed overrides, or process drift.",
  comms: "Collector integrity for this machine from the zero-gap audit. Full score when gapless with low lag; drops as the machine falls behind. This guards that the other legs are built on complete data.",
};
function legTip(k, leg, h) {
  const base = LEG_TIP[k] || "";
  const now = `Now: ${leg.detail || ""}.`;
  const w = Math.round((LEG_WEIGHTS[k] || 0) * 100);
  const impact = `Weight: ${w}% of ${h.id}'s composite health.`;
  return [base, now, impact].filter(Boolean).join("\n\n");
}
function legNaTip(k) {
  const base = LEG_TIP[k] || "";
  return `${base}\n\nThis machine isn't emitting the signal for this leg, so it's left out and the remaining legs are re-weighted — the machine is not penalised for a missing sensor.`;
}

function healthTip(h) {
  if (h.score == null) return `No health score yet — this machine isn't returning enough signal to score. It will populate once the collector has data over the selected window.`;
  const ranked = Object.entries(h.legs).map(([k, l]) => `${l.label} ${Math.round(l.value)}`).join(" · ");
  const grade = h.score >= 80 ? "healthy" : h.score >= 60 ? "watch" : "needs attention";
  return [
    `Composite maintenance health, 0–100 (${grade}). Weighted mean of the legs that have data: availability 30% · reliability 25% · tool 20% · stability 15% · comms 10%, re-normalised when a signal is missing.`,
    `Legs now: ${ranked}.`,
    `Lower the score, sooner this machine needs a look. The weakest leg is where to start.`,
  ].join("\n\n");
}

const RISK_TIP = {
  tool: "Projected from a Theil-Sen (outlier-robust) slope on the tool's real wear-offset history. We extend that trend to the moment it crosses the replace limit. Catch it here and you swap the tool on a planned stop instead of scrapping a part mid-cut.",
  service: "Reads the live machine-runtime odometer against the service interval. ESTIMATE: the controller emits no last-service reset marker, so 'time since service' assumes servicing at each interval multiple. Surfaced only past 75% of the assumed interval. Treat as a planning hint, not a measured due-date.",
  spindle: "Reads live spindle-on hours against the spindle-service interval. Same caveat as service: estimated from the odometer with an assumed reset point, surfaced only as it approaches the assumed due.",
  drift: "Cycle time is trending upward (Theil-Sen slope over recent cycles). Rising cycle time usually means a dulling tool or a reduced feed override — a leading sign of a quality or tool problem before it faults.",
  faultrate: "Alarms + e-stops per day over the window. A climbing fault rate means the machine is interrupting itself repeatedly — worth investigating the root cause before it becomes downtime.",
};
function riskTip(p) {
  const base = RISK_TIP[p.kind] || "";
  const sev = p.sev === "warn" ? "Needs attention now." : p.sev === "soon" ? "Approaching — plan for it." : "Heads-up, not urgent yet.";
  const when = p.etaMs ? `Projected: ${etaText(p.etaMs)}.` : "";
  return [base, [sev, when].filter(Boolean).join(" ")].filter(Boolean).join("\n\n");
}

/* ===================== shared bits ===================== */
function ring(score, size) {
  const r = (size - 8) / 2, c = 2 * Math.PI * r, v = score == null ? 0 : clamp(score);
  const off = c * (1 - v / 100);
  const tone = score == null ? "#475569" : v >= 80 ? "#34d399" : v >= 60 ? "#fbbf24" : "#f87171";
  return `<svg class="mt-ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="mt-ring-track" stroke-width="6" fill="none"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="${tone}" stroke-width="6" fill="none"
        stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" stroke-linecap="round"
        transform="rotate(-90 ${size / 2} ${size / 2})"/>
      <text x="50%" y="52%" class="mt-ring-text" dominant-baseline="middle" text-anchor="middle" style="font-size:${size * 0.3}px">${score == null ? "—" : Math.round(score)}</text>
    </svg>`;
}

function legLabel(k) { return { availability: "Availability", reliability: "Reliability", tool: "Tool headroom", stability: "Cycle stability", comms: "Comms" }[k] || k; }
function sgn(v) { return `${v >= 0 ? "+" : ""}${v}`; }
function clamp(v) { return Math.max(0, Math.min(100, v)); }
function clock(ts) { return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function etaText(ms) {
  const d = ms - Date.now();
  if (d <= 0) return "overdue";
  const h = d / 3600000;
  if (h < 48) return `in ${fmtHours(h)}`;
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
