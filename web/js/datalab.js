/* VMC God-mode — Data Lab.
 *
 * A data-science workbench: Plotly.js loaded LAZILY (only when this tab is first
 * opened — it never touches the mission cards or the other tabs). Eight views,
 * every one wired to a REAL collector signal. A shared control bar drives them:
 * machine multi-select + the window selector from the chrome (Shift/24h/7d).
 *
 * What is deliberately NOT here, because the dataitem does not exist:
 *   - spindle-load / cutting-force maps (no `Sl`)
 *   - scrap / true-quality surfaces (no reject counter)
 * Anything we cannot measure is shown as "unavailable", never faked.
 *
 * Read-only against /api/history + /api/overview via dataLayer. No backend change.
 */

import { computeMachine } from "./metrics.js";
import { segmentStates, bucketOfState } from "./analyticsCore.js";

/* Escape HTML entities to prevent XSS when rendering untrusted strings */
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ---------- lazy Plotly loader ---------- */
const PLOTLY_SRC = "https://cdn.plot.ly/plotly-2.35.2.min.js";
let plotlyPromise = null;
function loadPlotly() {
  if (window.Plotly) return Promise.resolve(window.Plotly);
  if (plotlyPromise) return plotlyPromise;
  plotlyPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = PLOTLY_SRC;
    s.async = true;
    s.onload = () => (window.Plotly ? resolve(window.Plotly) : reject(new Error("Plotly missing")));
    s.onerror = () => reject(new Error("Plotly failed to load"));
    document.head.appendChild(s);
  });
  return plotlyPromise;
}

/* ---------- palette + theme ---------- */
const MACHINE_COLORS = ["#3fb6ff", "#ffb454", "#7ee787", "#ff7b9c", "#c08cff", "#5ad1c4", "#ffd166"];
const REASON_COLORS = { ALARM: "#ff5c5c", "E-STOP": "#ff2d2d", "FEED-HOLD": "#ffb454", IDLE: "#6b7785", OTHER: "#9aa6b2" };
const STATE_COLORS = { run: "#2ecc71", pause: "#ffb454", idle: "#56627a", other: "#3a4252" };

const FONT = "IBM Plex Sans, system-ui, sans-serif";
const PLOT_CONFIG = { displaylogo: false, responsive: true, displayModeBar: true,
  modeBarButtonsToRemove: ["lasso2d", "select2d", "toImage"] };

function baseLayout() {
  return {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: "#c9d4e0", family: FONT, size: 12 },
    margin: { l: 48, r: 16, t: 28, b: 40 },
    showlegend: true,
    // legend pinned to the far-right edge, vertical — frees the centre so the
    // plot body can fill the width instead of stranding empty space beside it.
    legend: { x: 1, xanchor: "right", y: 1, yanchor: "top", orientation: "v",
      bgcolor: "rgba(13,17,23,0.6)", bordercolor: "rgba(148,163,184,0.16)", borderwidth: 1,
      font: { size: 11 } },
    title: { font: { family: "Rajdhani, sans-serif", size: 15, color: "#e6edf5" }, x: 0.01, xanchor: "left" },
    // keep camera/zoom/legend state across the router's 15s react() refresh
    uirevision: "datalab",
  };
}
function axis2d(title) {
  return { title: { text: title }, gridcolor: "rgba(255,255,255,0.07)", zerolinecolor: "rgba(255,255,255,0.15)",
    color: "#8a97a8", linecolor: "rgba(255,255,255,0.15)" };
}
function axis3d(title) {
  return { title: { text: title }, gridcolor: "rgba(255,255,255,0.10)", zerolinecolor: "rgba(255,255,255,0.22)",
    color: "#8a97a8", backgroundcolor: "#10151c", showbackground: true };
}
/* 3D scene that FILLS its (wide) container. aspectmode "manual" with a wide
 * aspectratio stretches the cube to occupy the full panel width instead of
 * fitting to height and centring (which strands empty space on both sides).
 * Pass cube=true for the toolpath, where true XYZ proportions matter. */
function scene3d(x, y, z, cube = false) {
  const s = { xaxis: axis3d(x), yaxis: axis3d(y), zaxis: axis3d(z), bgcolor: "#0d1117",
    domain: { x: [0, 1], y: [0, 1] },
    camera: { eye: { x: 1.6, y: 1.6, z: 1.0 } } };
  if (cube) { s.aspectmode = "cube"; }
  else { s.aspectmode = "manual"; s.aspectratio = { x: 1.9, y: 1.25, z: 0.85 }; }
  return s;
}

/* ---------- small helpers ---------- */
const machColor = (i) => MACHINE_COLORS[i % MACHINE_COLORS.length];
const fmtDur = (ms) => {
  if (ms == null) return "—";
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(0)}s`;
  if (s < 5400) return `${(s / 60).toFixed(1)}m`;
  return `${(s / 3600).toFixed(1)}h`;
};
const csvNums = (v) => String(v ?? "").split(",").map((n) => Number(n.trim()));

/* ---------- readout stat helpers ---------- */
const mean = (xs) => { const a = xs.filter(Number.isFinite); return a.length ? a.reduce((p, c) => p + c, 0) / a.length : null; };
const sd = (xs) => { const a = xs.filter(Number.isFinite); if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((p, c) => p + (c - m) ** 2, 0) / (a.length - 1)); };
function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  const px = [], py = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) { px.push(xs[i]); py.push(ys[i]); }
  if (px.length < 3) return null;
  const mx = mean(px), my = mean(py);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < px.length; i++) { const a = px[i] - mx, b = py[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}
const pct = (v) => (v == null ? "—" : `${v.toFixed(0)}%`);
const sec = (v) => (v == null ? "—" : v < 90 ? `${v.toFixed(0)}s` : v < 5400 ? `${(v / 60).toFixed(1)}m` : `${(v / 3600).toFixed(2)}h`);
const num1 = (v) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(1));

/* last row at-or-before ts, rows ascending by ts (binary search). */
function valueAtOrBefore(rows, ts) {
  let lo = 0, hi = rows.length - 1, ans = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m].ts <= ts) { ans = rows[m]; lo = m + 1; } else hi = m - 1; }
  return ans;
}

/* split a window into ~n contiguous buckets {from,to,mid,label}. */
function bucketize(win, n = 24) {
  const span = Math.max(1, win.to - win.from);
  const step = span / n;
  const wide = span > 36 * 3600000; // >1.5 days -> show date, else clock
  const out = [];
  for (let i = 0; i < n; i++) {
    const from = win.from + i * step, to = from + step, mid = from + step / 2;
    const d = new Date(mid);
    const label = wide
      ? `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}h`
      : `${String(d.getHours()).padStart(2, "0")}:${String(Math.floor(d.getMinutes() / 10) * 10).padStart(2, "0")}`;
    out.push({ from, to, mid, label });
  }
  return out;
}

/* run-fraction per bucket from rstat segments (0..1, null if no coverage). */
function runFractionPerBucket(segs, buckets) {
  return buckets.map((b) => {
    let run = 0, tot = 0;
    for (const s of segs) {
      const lo = Math.max(s.from, b.from), hi = Math.min(s.to, b.to);
      if (hi > lo) { tot += hi - lo; if (bucketOfState(s.state) === "run") run += hi - lo; }
    }
    return tot > 0 ? run / tot : null;
  });
}

/* dominant state code per bucket: 2 run / 1 pause / 0 idle / -1 none. */
function dominantPerBucket(segs, buckets) {
  return buckets.map((b) => {
    const acc = { run: 0, pause: 0, idle: 0, other: 0 };
    for (const s of segs) {
      const lo = Math.max(s.from, b.from), hi = Math.min(s.to, b.to);
      if (hi > lo) acc[bucketOfState(s.state)] += hi - lo;
    }
    const tot = acc.run + acc.pause + acc.idle + acc.other;
    if (!tot) return { code: -1, acc, tot: 0 };
    let best = "other", bv = -1;
    for (const k of ["run", "pause", "idle", "other"]) if (acc[k] > bv) { bv = acc[k]; best = k; }
    return { code: { run: 2, pause: 1, idle: 0, other: -1 }[best], acc, tot };
  });
}

/* ---------- view registry ---------- */
const VIEWS = [
  { id: "toolpath", label: "Toolpath 4D", single: true, render: renderToolpath,
    hint: "Cutting path in X/Y/Z, colored by feed override — see where the machine eased off." },
  { id: "cycles", label: "Cycle Cluster", render: renderCycleCluster,
    hint: "Every finished cycle by time-of-day, duration and program — slow clusters jump out." },
  { id: "util", label: "Utilization Landscape", render: renderUtilSurface,
    hint: "Run-time fraction across machine × time as a surface — the fleet's good and dead hours." },
  { id: "ribbon", label: "State Ribbon", render: renderStateRibbon,
    hint: "Dominant state per machine per time slice — where downtime concentrates." },
  { id: "wear", label: "Tool-Wear Evolution", single: true, render: renderWear,
    hint: "Per-slot wear offsets over time — which tool is drifting toward its limit." },
  { id: "override", label: "Override Field", render: renderOverrideField,
    hint: "Feed × rapid × spindle overrides — operator habits and where they fight the program." },
  { id: "sunburst", label: "Downtime Sunburst", render: renderSunburst,
    hint: "Downtime broken down by reason then machine — click a wedge to drill in." },
  { id: "explorer", label: "Custom Explorer", render: renderExplorer,
    hint: "Pick any two or three signals for X/Y/Z and explore the raw relationship yourself." },
];

const EXPLORER_ITEMS = [
  { item: "fdovrd", label: "Feed override %" },
  { item: "rovrd", label: "Rapid override %" },
  { item: "ssovrd", label: "Spindle override %" },
  { item: "m30c1", label: "Parts counter" },
  { item: "machineruntime", label: "Machine runtime (s)" },
  { item: "spindletime", label: "Spindle time (s)" },
];

/* ============================================================= mount */
export function mountDataLab(body, dataLayer) {
  body.classList.add("datalab");
  body.innerHTML = `
    <div class="dl-controls">
      <div class="dl-machines" data-f="machines"><span class="dl-ctl-label">Machines</span></div>
      <div class="dl-views" data-f="views"></div>
    </div>
    <div class="dl-viewhint" data-f="hint"></div>
    <div class="dl-extra" data-f="extra" hidden></div>
    <div class="dl-stage">
      <div class="dl-plot" data-f="plot"></div>
      <div class="dl-note" data-f="note" hidden></div>
    </div>
    <div class="dl-readout" data-f="readout"></div>`;

  const refs = {
    machines: body.querySelector('[data-f="machines"]'),
    views: body.querySelector('[data-f="views"]'),
    hint: body.querySelector('[data-f="hint"]'),
    extra: body.querySelector('[data-f="extra"]'),
    plot: body.querySelector('[data-f="plot"]'),
    note: body.querySelector('[data-f="note"]'),
    readout: body.querySelector('[data-f="readout"]'),
  };

  const state = {
    machineIds: [],
    selected: new Set(),
    activeView: localStorage.getItem("vmc_dl_view") || "toolpath",
    Plotly: null,
    token: 0,
    explorer: { x: "fdovrd", y: "ssovrd", z: "rovrd" },
  };

  // view sub-nav
  for (const v of VIEWS) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "dl-view-btn"; b.dataset.view = v.id; b.textContent = v.label;
    b.addEventListener("click", () => {
      if (state.activeView === v.id) return;
      state.activeView = v.id;
      localStorage.setItem("vmc_dl_view", v.id);
      syncViewNav(); draw();
    });
    refs.views.appendChild(b);
  }
  function syncViewNav() {
    refs.views.querySelectorAll(".dl-view-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.view === state.activeView));
    const v = VIEWS.find((x) => x.id === state.activeView);
    refs.hint.textContent = v ? v.hint : "";
  }

  function showNote(msg) { refs.note.textContent = msg; refs.note.hidden = false; }
  function clearNote() { refs.note.hidden = true; }

  function buildMachineChips() {
    refs.machines.querySelectorAll(".dl-mach").forEach((n) => n.remove());
    for (let i = 0; i < state.machineIds.length; i++) {
      const id = state.machineIds[i];
      const b = document.createElement("button");
      b.type = "button"; b.className = "dl-mach"; b.dataset.id = id; b.textContent = id;
      b.style.setProperty("--mc", machColor(i));
      b.classList.toggle("is-on", state.selected.has(id));
      b.addEventListener("click", () => {
        if (state.selected.has(id)) { if (state.selected.size > 1) state.selected.delete(id); }
        else state.selected.add(id);
        b.classList.toggle("is-on", state.selected.has(id));
        draw();
      });
      refs.machines.appendChild(b);
    }
  }

  function selectedOrdered() {
    return state.machineIds.filter((id) => state.selected.has(id));
  }

  async function ensureMachines() {
    if (state.machineIds.length) return;
    try {
      const ov = await dataLayer.overview();
      const list = (ov.machines || []).map((m) => m.machine_id || m.id || m.machine || m.name).filter(Boolean);
      state.machineIds = list;
      if (!state.selected.size) list.forEach((id) => state.selected.add(id));
      buildMachineChips();
    } catch (_) { /* shown as note on draw */ }
  }

  async function draw() {
    if (document.hidden) return;   // router keeps the timer; skip work off-screen
    const my = ++state.token;
    syncViewNav();
    refs.extra.hidden = state.activeView !== "explorer";
    // Only show the blocking "loading" overlay when nothing is drawn yet (first
    // open or a view switch). On the router's 15s refresh the plot is already
    // there, so we refresh silently underneath — no flicker, no ghost overlay.
    const firstPaint = !refs.plot.dataView || refs.plot.dataView !== state.activeView;
    if (firstPaint) {
      // dropping a stale plot from a previous view so a no-data note isn't shown
      // on top of an unrelated chart
      if (refs.plot.dataView && state.Plotly) { try { state.Plotly.purge(refs.plot); } catch (_) {} }
      refs.plot.dataView = null;
      showNote("loading…");
    } else clearNote();
    try {
      if (!state.Plotly) state.Plotly = await loadPlotly();
      await ensureMachines();
      if (my !== state.token) return;
      const machines = selectedOrdered();
      if (!machines.length) { showNote("Select at least one machine."); return; }
      const view = VIEWS.find((v) => v.id === state.activeView);
      const ctx = {
        Plotly: state.Plotly, dataLayer, machines,
        machineIds: state.machineIds, win: dataLayer.resolveWindow(),
        plot: refs.plot, extra: refs.extra, state,
        idxOf: (id) => state.machineIds.indexOf(id),
        token: () => my === state.token,
      };
      const readout = await view.render(ctx, showNote, clearNote);
      if (my === state.token) { clearNote(); refs.plot.dataView = state.activeView; renderReadout(refs.readout, readout, view); }
    } catch (e) {
      if (my === state.token) showNote(`Could not render: ${e.message || e}`);
    }
  }

  syncViewNav();
  buildExplorerControls(refs.extra, state, draw);

  return {
    refresh: draw,
    // Release the Plotly WebGL/canvas context when leaving the tab so repeated
    // visits don't pile up GPU contexts (browsers cap ~16). The router calls this
    // on tab switch; the view re-mounts fresh on next activation.
    destroy() {
      state.token++;   // invalidate any in-flight draw
      if (state.Plotly && refs.plot) { try { state.Plotly.purge(refs.plot); } catch (_) {} }
      refs.plot.dataView = null;
    },
  };
}

/* ============================================================= views */

/* Render the analytical readout panel beneath a chart from a view's return:
 *   { title, stats:[{label,value,sub?,tone?}], tables:[{caption,head:[],rows:[[]]}], note? }
 * Everything shown here is computed from the same real samples the chart drew. */
function renderReadout(host, data, view) {
  if (!data) { host.innerHTML = ""; host.hidden = true; return; }
  host.hidden = false;
  const parts = [];
  parts.push(`<div class="dl-ro-head"><span class="dl-ro-kicker">Analysis</span><h3>${data.title || view.label}</h3></div>`);
  if (data.stats && data.stats.length) {
    parts.push(`<div class="dl-ro-stats">${data.stats.map((s) => `
      <div class="dl-ro-stat${s.tone ? " tone-" + s.tone : ""}">
        <span class="dl-ro-val">${s.value}</span>
        <span class="dl-ro-lbl">${s.label}</span>
        ${s.sub ? `<span class="dl-ro-sub">${s.sub}</span>` : ""}
      </div>`).join("")}</div>`);
  }
  for (const t of data.tables || []) {
    parts.push(`<div class="dl-ro-tablewrap">
      ${t.caption ? `<div class="dl-ro-caption">${escapeHtml(t.caption)}</div>` : ""}
      <table class="dl-ro-table">
        <thead><tr>${t.head.map((h, i) => `<th${i ? ' class="num"' : ""}>${escapeHtml(h)}</th>`).join("")}</tr></thead>
        <tbody>${t.rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ""}>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody>
      </table></div>`);
  }
  if (data.note) parts.push(`<p class="dl-ro-note">${data.note}</p>`);
  host.innerHTML = parts.join("");
}


/* 1 — Toolpath 4D: scatter3d line, color = feed override (4th dim). */
async function renderToolpath(ctx, showNote) {
  const id = ctx.machines[0];
  let rows = await ctx.dataLayer.historyWindow(id, "xyzact", ctx.win);
  const x = [], y = [], z = [], ts = [];
  for (const r of rows || []) {
    const p = csvNums(r.val);
    if (p.length >= 3 && p.slice(0, 3).every(Number.isFinite)) { x.push(p[0]); y.push(p[1]); z.push(p[2]); ts.push(r.ts); }
  }
  if (x.length < 2) {
    // per-axis fallback, joined on the X-axis sample clock
    const [xs, ys, zs] = await Promise.all([
      ctx.dataLayer.historyWindow(id, "x_axis_actual_position", ctx.win),
      ctx.dataLayer.historyWindow(id, "y_axis_actual_position", ctx.win),
      ctx.dataLayer.historyWindow(id, "z_axis_actual_position", ctx.win),
    ]);
    if (xs && xs.length > 1 && ys && ys.length && zs && zs.length) {
      for (const r of xs) {
        const yv = valueAtOrBefore(ys, r.ts), zv = valueAtOrBefore(zs, r.ts);
        if (yv && zv && [r.num, yv.num, zv.num].every(Number.isFinite)) { x.push(r.num); y.push(yv.num); z.push(zv.num); ts.push(r.ts); }
      }
    }
  }
  if (x.length < 2) { showNote(`${id}: no toolpath samples (xyzact / axis positions) in this window.`); return; }

  const fd = await ctx.dataLayer.historyWindow(id, "fdovrd", ctx.win);
  let color = ts.map((t) => { const f = valueAtOrBefore(fd || [], t); return f && Number.isFinite(f.num) ? f.num : null; });
  const haveFeed = color.some((c) => c != null);
  if (!haveFeed) color = ts.map((_, i) => i); // fall back to time progression

  const trace = {
    type: "scatter3d", mode: "lines",
    x, y, z,
    line: { width: 4, color, colorscale: haveFeed ? "Portland" : "Viridis",
      cmin: 0, colorbar: { title: { text: haveFeed ? "Feed %" : "time →" }, thickness: 12, len: 0.6 } },
    hovertemplate: "X %{x:.1f} Y %{y:.1f} Z %{z:.1f}<extra></extra>",
  };
  const layout = { ...baseLayout(), title: { text: `${id} — toolpath, ${x.length} points${haveFeed ? " (color = feed override %)" : ""}` },
    showlegend: false, scene: scene3d("X", "Y", "Z", true) };
  if (ctx.machines.length > 1) layout.title.text += "  ·  single-machine view, showing first selected";
  ctx.Plotly.react(ctx.plot, [trace], layout, PLOT_CONFIG);

  // readout: path extent + travel distance + feed-override profile
  let dist = 0;
  for (let i = 1; i < x.length; i++) dist += Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1], z[i] - z[i - 1]);
  const ext = (arr) => Math.max(...arr) - Math.min(...arr);
  const feedVals = haveFeed ? color.filter((c) => c != null) : [];
  const belowNom = feedVals.length ? (feedVals.filter((v) => v < 100).length / feedVals.length) * 100 : null;
  return {
    title: `${id} — toolpath geometry`,
    stats: [
      { label: "Points", value: x.length.toLocaleString() },
      { label: "Travel distance", value: `${(dist).toFixed(0)} mm` },
      { label: "X / Y / Z extent", value: `${ext(x).toFixed(0)} · ${ext(y).toFixed(0)} · ${ext(z).toFixed(0)}`, sub: "mm" },
      { label: "Mean feed override", value: haveFeed ? pct(mean(feedVals)) : "—", sub: haveFeed ? `${num1(belowNom)}% of path < 100%` : "no feed data", tone: belowNom > 25 ? "warn" : "" },
    ],
    note: haveFeed
      ? "Color encodes feed override along the path. Long stretches below 100% mark where the operator slowed the cut — candidate spots for program/feeds review."
      : "Feed override not sampled for this machine in the window; color shows time progression instead.",
  };
}

/* 2 — Cycle cluster: scatter3d, x=time-of-day(h), y=duration(s), z=program index. */
async function renderCycleCluster(ctx, showNote) {
  const programs = new Map(); // name -> index
  const traces = [];
  let total = 0;
  const perMachine = []; // {id, durs:[]}
  const perProgram = {}; // prog -> durs[]
  // compute all machines concurrently (memoized + parallel), process in order
  const mets = await Promise.all(
    ctx.machines.map((id) => computeMachine(ctx.dataLayer, id, ctx.win).catch(() => null))
  );
  if (!ctx.token()) return;
  for (let i = 0; i < ctx.machines.length; i++) {
    const id = ctx.machines[i];
    const m = mets[i];
    if (!m) { perMachine.push({ id, durs: [] }); continue; }
    const tx = [], ty = [], tz = [], txt = [];
    const durs = [];
    for (const c of m.cycles) {
      const d = new Date(c.end);
      const hod = d.getHours() + d.getMinutes() / 60;
      const prog = c.program || "—";
      if (!programs.has(prog)) programs.set(prog, programs.size);
      tx.push(hod); ty.push(c.dur / 1000); tz.push(programs.get(prog)); txt.push(prog);
      durs.push(c.dur / 1000);
      (perProgram[prog] = perProgram[prog] || []).push(c.dur / 1000);
    }
    perMachine.push({ id, durs });
    total += tx.length;
    traces.push({ type: "scatter3d", mode: "markers", name: id,
      x: tx, y: ty, z: tz, text: txt,
      marker: { size: 3.5, color: machColor(ctx.idxOf(id)), opacity: 0.8 },
      hovertemplate: `${id}<br>%{y:.0f}s · prog %{text}<br>%{x:.1f}h of day<extra></extra>` });
  }
  if (!total) { showNote("No completed cycles (M30 counter increments) in this window."); return; }
  const ticks = [...programs.entries()];
  const layout = { ...baseLayout(), title: { text: `Cycle clusters — ${total} parts` },
    scene: { ...scene3d("Hour of day", "Cycle time (s)", "Program"),
      zaxis: { ...axis3d("Program"), tickmode: "array", tickvals: ticks.map((t) => t[1]), ticktext: ticks.map((t) => t[0]) },
      xaxis: { ...axis3d("Hour of day"), range: [0, 24] } } };
  ctx.Plotly.react(ctx.plot, traces, layout, PLOT_CONFIG);

  // readout: cycle-time stats overall, per machine, and most variable programs
  const all = perMachine.flatMap((p) => p.durs);
  const mAll = mean(all), sdAll = sd(all);
  const cv = mAll ? (sdAll / mAll) * 100 : null;
  const machRows = perMachine.filter((p) => p.durs.length).map((p) => {
    const mm = mean(p.durs), ss = sd(p.durs);
    return [p.id, p.durs.length, sec(mm), sec(Math.min(...p.durs)), ss != null ? `±${sec(ss)}` : "—"];
  });
  const progRows = Object.entries(perProgram).map(([prog, d]) => {
    const mm = mean(d), ss = sd(d); return { prog, n: d.length, mm, cv: mm ? (ss / mm) * 100 : 0 };
  }).sort((a, b) => b.cv - a.cv).slice(0, 5)
    .map((r) => [r.prog, r.n, sec(r.mm), `${num1(r.cv)}%`]);
  return {
    title: "Cycle-time distribution",
    stats: [
      { label: "Parts (cycles)", value: total.toLocaleString() },
      { label: "Mean cycle", value: sec(mAll) },
      { label: "Fastest cycle", value: sec(Math.min(...all)) },
      { label: "Variability (CV)", value: `${num1(cv)}%`, sub: cv > 30 ? "high spread" : "consistent", tone: cv > 30 ? "warn" : "good" },
    ],
    tables: [
      { caption: "Per machine", head: ["Machine", "Cycles", "Mean", "Fastest", "Std dev"], rows: machRows },
      { caption: "Most variable programs (top 5 by coefficient of variation)", head: ["Program", "Cycles", "Mean", "CV"], rows: progRows },
    ],
    note: "CV = std dev / mean. A high CV on a program flags inconsistent cycle time — tool changes, manual intervention, or feed-hold mid-cycle. Fastest cycle is the practical floor used as the ideal-cycle baseline in OEE-performance.",
  };
}

/* 3 — Utilization landscape: surface z[machine][bucket] = run fraction %. */
async function renderUtilSurface(ctx, showNote) {
  const buckets = bucketize(ctx.win, 24);
  const zmat = [], ynames = [];
  // fetch every machine's rstat in parallel, then fold in machine order
  const rstats = await Promise.all(
    ctx.machines.map((id) => ctx.dataLayer.historyWindow(id, "rstat", ctx.win).catch(() => []))
  );
  if (!ctx.token()) return;
  ctx.machines.forEach((id, mi) => {
    const segs = segmentStates(rstats[mi], ctx.win);
    const frac = runFractionPerBucket(segs, buckets);
    zmat.push(frac.map((f) => (f == null ? null : f * 100)));
    ynames.push(id);
  });
  const hasData = zmat.some((row) => row.some((v) => v != null));
  if (!hasData) { showNote("No run-state coverage in this window."); return; }
  const trace = { type: "surface", x: buckets.map((b) => b.label), y: ynames, z: zmat,
    colorscale: [[0, "#5a1f2b"], [0.45, "#b07a2a"], [0.7, "#3c8f57"], [1, "#2ecc71"]],
    cmin: 0, cmax: 100, colorbar: { title: { text: "Run %" }, thickness: 12, len: 0.6 },
    connectgaps: false, contours: { z: { show: true, usecolormap: true, project: { z: true } } } };
  const layout = { ...baseLayout(), title: { text: "Utilization landscape — run-time fraction per slice" },
    showlegend: false, scene: { ...scene3d("Time", "Machine", "Run %"),
      zaxis: { ...axis3d("Run %"), range: [0, 100] } } };
  ctx.Plotly.react(ctx.plot, [trace], layout, PLOT_CONFIG);

  // readout: average utilization per machine + peak/dead slice
  const rows = ynames.map((id, mi) => {
    const vals = zmat[mi].filter((v) => v != null);
    const avg = mean(vals);
    let peakI = -1, deadI = -1, pv = -1, dv = 101;
    zmat[mi].forEach((v, i) => { if (v == null) return; if (v > pv) { pv = v; peakI = i; } if (v < dv) { dv = v; deadI = i; } });
    return { id, avg, peak: peakI >= 0 ? buckets[peakI].label : "—", pv, dead: deadI >= 0 ? buckets[deadI].label : "—", dv };
  });
  const fleetAvg = mean(rows.map((r) => r.avg).filter((v) => v != null));
  const best = rows.filter((r) => r.avg != null).sort((a, b) => b.avg - a.avg)[0];
  const worst = rows.filter((r) => r.avg != null).sort((a, b) => a.avg - b.avg)[0];
  return {
    title: "Utilization breakdown",
    stats: [
      { label: "Fleet utilization", value: pct(fleetAvg), sub: "run ÷ wall-clock", tone: fleetAvg < 50 ? "warn" : "good" },
      { label: "Best machine", value: best ? best.id : "—", sub: best ? pct(best.avg) : "" },
      { label: "Lowest machine", value: worst ? worst.id : "—", sub: worst ? pct(worst.avg) : "", tone: "warn" },
      { label: "Time slices", value: `${buckets.length}`, sub: ctx.win.label },
    ],
    tables: [{
      caption: "Per machine (peak and deadest slice of the window)",
      head: ["Machine", "Avg run %", "Peak slice", "Deadest slice"],
      rows: rows.map((r) => [r.id, pct(r.avg), `${r.peak} (${pct(r.pv)})`, `${r.dead} (${pct(r.dv)})`]),
    }],
    note: "Utilization is run-time as a fraction of wall-clock per slice (idle and pause both count against it). The deadest slice points at recurring downtime windows — shift changes, lunch, end-of-day spin-down.",
  };
}

/* 4 — State ribbon: heatmap, dominant state per machine per slice. */
async function renderStateRibbon(ctx, showNote) {
  const buckets = bucketize(ctx.win, 48);
  const zmat = [], ynames = [], textMat = [];
  const dwell = []; // {id, run, pause, idle, other}
  const rstats = await Promise.all(
    ctx.machines.map((id) => ctx.dataLayer.historyWindow(id, "rstat", ctx.win).catch(() => []))
  );
  if (!ctx.token()) return;
  ctx.machines.forEach((id, mi) => {
    const segs = segmentStates(rstats[mi], ctx.win);
    const acc = { run: 0, pause: 0, idle: 0, other: 0 };
    for (const s of segs) acc[bucketOfState(s.state)] += s.dur;
    dwell.push({ id, ...acc });
    const dom = dominantPerBucket(segs, buckets);
    zmat.push(dom.map((d) => d.code));
    textMat.push(dom.map((d) => {
      if (d.code === -1) return "no data";
      const lab = { 2: "RUN", 1: "PAUSE", 0: "IDLE" }[d.code];
      const pct = d.tot ? Math.round((d.acc[{ 2: "run", 1: "pause", 0: "idle" }[d.code]] / d.tot) * 100) : 0;
      return `${lab} ${pct}%`;
    }));
    ynames.push(id);
  });
  const hasData = zmat.some((r) => r.some((v) => v !== -1));
  if (!hasData) { showNote("No run-state coverage in this window."); return; }
  // discrete colorscale over codes -1..2 mapped to [0,1]
  const colorscale = [
    [0.00, "#1b2430"], [0.249, "#1b2430"],     // -1 none
    [0.25, STATE_COLORS.idle], [0.499, STATE_COLORS.idle],   // 0 idle
    [0.50, STATE_COLORS.pause], [0.749, STATE_COLORS.pause], // 1 pause
    [0.75, STATE_COLORS.run], [1.00, STATE_COLORS.run],      // 2 run
  ];
  const trace = { type: "heatmap", x: buckets.map((b) => b.label), y: ynames, z: zmat, text: textMat,
    zmin: -1, zmax: 2, colorscale, showscale: false, xgap: 1, ygap: 4,
    hovertemplate: "%{y} · %{x}<br>%{text}<extra></extra>" };
  const layout = { ...baseLayout(), title: { text: "State ribbon — dominant state per slice" },
    showlegend: false, xaxis: { ...axis2d("Time"), tickangle: -45 },
    yaxis: { ...axis2d(""), automargin: true }, margin: { l: 90, r: 16, t: 28, b: 70 } };
  ctx.Plotly.react(ctx.plot, [trace], layout, PLOT_CONFIG);

  // readout: time-in-state split per machine
  const rows = dwell.map((d) => {
    const tot = d.run + d.pause + d.idle + d.other || 1;
    return [d.id, pct((d.run / tot) * 100), pct((d.pause / tot) * 100), pct((d.idle / tot) * 100), fmtDur(d.run)];
  });
  const fleetRun = dwell.reduce((p, d) => p + d.run, 0);
  const fleetTot = dwell.reduce((p, d) => p + d.run + d.pause + d.idle + d.other, 0) || 1;
  const fleetPause = dwell.reduce((p, d) => p + d.pause, 0);
  const fleetIdle = dwell.reduce((p, d) => p + d.idle, 0);
  return {
    title: "Time-in-state split",
    stats: [
      { label: "Fleet running", value: pct((fleetRun / fleetTot) * 100), tone: "good" },
      { label: "Paused (feed-hold)", value: pct((fleetPause / fleetTot) * 100), tone: fleetPause > fleetIdle ? "warn" : "" },
      { label: "Idle", value: pct((fleetIdle / fleetTot) * 100), tone: "warn" },
      { label: "Slices", value: `${buckets.length}`, sub: ctx.win.label },
    ],
    tables: [{
      caption: "Per machine",
      head: ["Machine", "Run", "Pause", "Idle", "Run time"],
      rows,
    }],
    note: "Each cell is the dominant state in that slice. Pause = feed-hold / program-stop (operator present); idle = stopped / ready (machine waiting). A pause-heavy machine means in-cycle interruptions; an idle-heavy one means it's starved of work.",
  };
}

/* 5 — Tool-wear evolution: surface z[time][slot] = wear offset. */
async function renderWear(ctx, showNote) {
  const id = ctx.machines[0];
  const dia = await ctx.dataLayer.historyWindow(id, "diamwear", ctx.win);
  const len = await ctx.dataLayer.historyWindow(id, "lengthwear", ctx.win);
  const src = (dia && dia.length ? dia : len) || [];
  const label = dia && dia.length ? "Diameter wear" : "Length wear";
  if (src.length < 2) { showNote(`${id}: no tool-wear table (diamwear / lengthwear) in this window.`); return; }

  // each row = CSV of all slots at that ts; build z[time][slot]
  let maxSlots = 0;
  const parsed = src.map((r) => { const a = csvNums(r.val).map((v) => (Number.isFinite(v) ? v : null)); maxSlots = Math.max(maxSlots, a.length); return { ts: r.ts, a }; });
  if (maxSlots === 0) { showNote(`${id}: wear table empty in this window.`); return; }
  const z = parsed.map((p) => { const row = p.a.slice(); while (row.length < maxSlots) row.push(null); return row; });
  const yt = parsed.map((p) => { const d = new Date(p.ts); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; });
  const xt = Array.from({ length: maxSlots }, (_, i) => `T${i + 1}`);

  const trace = { type: "surface", x: xt, y: yt, z,
    colorscale: [[0, "#2a3340"], [0.5, "#ffd166"], [1, "#ff5c5c"]],
    colorbar: { title: { text: "mm" }, thickness: 12, len: 0.6 }, connectgaps: false };
  const layout = { ...baseLayout(), title: { text: `${id} — ${label} by tool slot over time` },
    showlegend: false, scene: scene3d("Tool slot", "Time", "Wear (mm)") };
  ctx.Plotly.react(ctx.plot, [trace], layout, PLOT_CONFIG);

  // readout: per-slot latest wear + drift over the window
  const first = z[0], last = z[z.length - 1];
  const WARN = 0.1, BAD = 0.25;
  const slotRows = [];
  let worst = { slot: null, abs: -1 };
  for (let s = 0; s < maxSlots; s++) {
    const cur = last[s], beg = first[s];
    if (!Number.isFinite(cur)) continue;
    const drift = Number.isFinite(beg) ? cur - beg : null;
    const abs = Math.abs(cur);
    if (abs > worst.abs) worst = { slot: s + 1, abs, cur };
    const flag = abs >= BAD ? "● limit" : abs >= WARN ? "● watch" : "ok";
    slotRows.push({ s: s + 1, cur, drift, abs, flag });
  }
  const flagged = slotRows.filter((r) => r.abs >= WARN).sort((a, b) => b.abs - a.abs);
  const rows = (flagged.length ? flagged : slotRows.slice().sort((a, b) => b.abs - a.abs).slice(0, 6))
    .map((r) => [`T${r.s}`, `${r.cur.toFixed(3)} mm`, r.drift == null ? "—" : `${r.drift >= 0 ? "+" : ""}${r.drift.toFixed(3)} mm`, r.flag]);
  return {
    title: `${id} — tool-wear status (${label.toLowerCase()})`,
    stats: [
      { label: "Tool slots tracked", value: `${slotRows.length}` },
      { label: "Worst slot", value: worst.slot ? `T${worst.slot}` : "—", sub: worst.slot ? `${worst.cur.toFixed(3)} mm` : "", tone: worst.abs >= BAD ? "bad" : worst.abs >= WARN ? "warn" : "good" },
      { label: "At/over limit", value: `${slotRows.filter((r) => r.abs >= BAD).length}`, sub: `≥ ${BAD} mm`, tone: slotRows.some((r) => r.abs >= BAD) ? "bad" : "" },
      { label: "On watch", value: `${slotRows.filter((r) => r.abs >= WARN && r.abs < BAD).length}`, sub: `≥ ${WARN} mm`, tone: "warn" },
    ],
    tables: [{
      caption: flagged.length ? "Flagged slots (wear offset ≥ 0.1 mm)" : "Highest-wear slots",
      head: ["Slot", "Current offset", "Drift in window", "Status"],
      rows,
    }],
    note: `Wear offset is the controller's compensation table per slot — its magnitude is a proxy for tool wear (no live spindle-load signal exists on these machines). Watch ≥ ${WARN} mm, limit ≥ ${BAD} mm. Drift is the change across this window; a fast-climbing slot is wearing in real time.`,
  };
}

/* 6 — Override field: scatter3d feed × rapid × spindle, one trace per machine. */
async function renderOverrideField(ctx, showNote) {
  const traces = [];
  let total = 0;
  const perMachine = []; // {id, feed:[], rapid:[], spindle:[]}
  // pull all machines' override triplets concurrently, then build traces in order
  const fetched = await Promise.all(ctx.machines.map((id) =>
    Promise.all([
      ctx.dataLayer.historyWindow(id, "fdovrd", ctx.win),
      ctx.dataLayer.historyWindow(id, "rovrd", ctx.win),
      ctx.dataLayer.historyWindow(id, "ssovrd", ctx.win),
    ]).then(([fd, rv, sv]) => ({ id, fd, rv, sv })).catch(() => ({ id, fd: [], rv: [], sv: [] }))
  ));
  if (!ctx.token()) return;
  for (const { id, fd, rv, sv } of fetched) {
    if (!fd || fd.length < 1) continue;
    const x = [], y = [], z = [], txt = [];
    for (const r of fd) {
      const rr = valueAtOrBefore(rv || [], r.ts), ss = valueAtOrBefore(sv || [], r.ts);
      const fx = Number(r.num), ry = rr ? Number(rr.num) : null, sz = ss ? Number(ss.num) : null;
      if (![fx, ry, sz].every(Number.isFinite)) continue;
      x.push(fx); y.push(ry); z.push(sz);
      txt.push(new Date(r.ts).toLocaleTimeString());
    }
    total += x.length;
    perMachine.push({ id, feed: x, rapid: y, spindle: z });
    traces.push({ type: "scatter3d", mode: "markers", name: id, x, y, z, text: txt,
      marker: { size: 3, color: machColor(ctx.idxOf(id)), opacity: 0.6 },
      hovertemplate: `${id}<br>feed %{x} · rapid %{y} · spindle %{z}<br>%{text}<extra></extra>` });
  }
  if (!total) { showNote("No override samples (fdovrd/rovrd/ssovrd) in this window."); return; }
  // nominal 100/100/100 reference marker
  traces.push({ type: "scatter3d", mode: "markers", name: "nominal 100", x: [100], y: [100], z: [100],
    marker: { size: 6, color: "#ffffff", symbol: "diamond", line: { width: 1 } }, hoverinfo: "name" });
  const layout = { ...baseLayout(), title: { text: `Override field — ${total} samples` },
    scene: scene3d("Feed %", "Rapid %", "Spindle %") };
  ctx.Plotly.react(ctx.plot, traces, layout, PLOT_CONFIG);

  // readout: mean overrides + % of samples off-nominal, per machine
  const offFrac = (arr) => (arr.length ? (arr.filter((v) => Math.round(v) !== 100).length / arr.length) * 100 : null);
  const rows = perMachine.map((p) => [p.id, pct(mean(p.feed)), pct(mean(p.spindle)), pct(mean(p.rapid)), `${num1(offFrac(p.feed))}%`]);
  const allFeed = perMachine.flatMap((p) => p.feed);
  const allSp = perMachine.flatMap((p) => p.spindle);
  const fleetOff = offFrac(allFeed);
  return {
    title: "Operator override behaviour",
    stats: [
      { label: "Mean feed override", value: pct(mean(allFeed)), tone: mean(allFeed) < 95 ? "warn" : "" },
      { label: "Mean spindle override", value: pct(mean(allSp)) },
      { label: "Feed off 100%", value: `${num1(fleetOff)}%`, sub: "of samples", tone: fleetOff > 30 ? "warn" : "good" },
      { label: "Samples", value: total.toLocaleString() },
    ],
    tables: [{
      caption: "Per machine (time-of-sample averages)",
      head: ["Machine", "Feed", "Spindle", "Rapid", "Feed off-100%"],
      rows,
    }],
    note: "Overrides are operator dials on top of the programmed feeds/speeds. Persistent feed below 100% means the program is being held back at the panel — either conservative programming or a real cutting problem worth a process review. The white diamond marks nominal 100/100/100.",
  };
}

/* 7 — Downtime sunburst: reason -> machine, ms. */
async function renderSunburst(ctx, showNote) {
  const ids = [], labels = [], parents = [], values = [], colors = [];
  const reasonTotals = {};
  const leaves = [];
  const mets = await Promise.all(
    ctx.machines.map((id) => computeMachine(ctx.dataLayer, id, ctx.win).catch(() => null))
  );
  if (!ctx.token()) return;
  ctx.machines.forEach((id, mi) => {
    const m = mets[mi];
    if (!m) return;
    for (const [reason, ms] of Object.entries(m.downtime || {})) {
      if (!ms || ms <= 0) continue;
      reasonTotals[reason] = (reasonTotals[reason] || 0) + ms;
      leaves.push({ reason, id, ms });
    }
  });
  const totalDown = Object.values(reasonTotals).reduce((a, b) => a + b, 0);
  if (!totalDown) { showNote("No downtime recorded in this window — fleet ran clean."); return; }
  for (const [reason, ms] of Object.entries(reasonTotals)) {
    ids.push(reason); labels.push(reason); parents.push(""); values.push(ms);
    colors.push(REASON_COLORS[reason] || "#888");
  }
  for (const lf of leaves) {
    ids.push(`${lf.reason}/${lf.id}`); labels.push(lf.id); parents.push(lf.reason); values.push(lf.ms);
    colors.push(REASON_COLORS[lf.reason] || "#888");
  }
  const trace = { type: "sunburst", ids, labels, parents, values, branchvalues: "total",
    marker: { colors, line: { color: "#0d1117", width: 1.5 } },
    hovertemplate: "%{label}<br>%{value:.0f} ms (%{percentRoot})<extra></extra>",
    insidetextorientation: "radial" };
  const layout = { ...baseLayout(), title: { text: `Downtime — ${fmtDur(totalDown)} total` },
    showlegend: false, margin: { l: 8, r: 8, t: 28, b: 8 } };
  ctx.Plotly.react(ctx.plot, [trace], layout, PLOT_CONFIG);

  // readout: reason breakdown + worst machine
  const reasonRows = Object.entries(reasonTotals).sort((a, b) => b[1] - a[1])
    .map(([r, ms]) => [r, fmtDur(ms), `${num1((ms / totalDown) * 100)}%`]);
  const byMachine = {};
  for (const lf of leaves) byMachine[lf.id] = (byMachine[lf.id] || 0) + lf.ms;
  const worstMach = Object.entries(byMachine).sort((a, b) => b[1] - a[1])[0];
  const topReason = reasonRows[0];
  return {
    title: "Downtime breakdown",
    stats: [
      { label: "Total downtime", value: fmtDur(totalDown), sub: ctx.win.label, tone: "warn" },
      { label: "Top reason", value: topReason ? topReason[0] : "—", sub: topReason ? topReason[2] : "", tone: "bad" },
      { label: "Worst machine", value: worstMach ? worstMach[0] : "—", sub: worstMach ? fmtDur(worstMach[1]) : "" },
      { label: "Reasons seen", value: `${reasonRows.length}` },
    ],
    tables: [{
      caption: "By reason (share of all downtime)",
      head: ["Reason", "Duration", "Share"],
      rows: reasonRows,
    }],
    note: "Downtime is non-running time attributed to a cause: E-STOP and ALARM windows take priority, then feed-hold (pause) and idle. Attack the biggest wedge first — it's the single largest lever on availability. Click a wedge in the chart to drill into machines.",
  };
}

/* 8 — Custom explorer: pick X/Y/(Z) items, join by nearest ts on first machine. */
function buildExplorerControls(extra, state, draw) {
  const mk = (key, label) => {
    const wrap = document.createElement("label");
    wrap.className = "dl-pick";
    wrap.innerHTML = `<span>${label}</span>`;
    const sel = document.createElement("select");
    const none = key === "z" ? `<option value="">— none (2D) —</option>` : "";
    sel.innerHTML = none + EXPLORER_ITEMS.map((it) => `<option value="${it.item}">${it.label}</option>`).join("");
    sel.value = state.explorer[key];
    sel.addEventListener("change", () => { state.explorer[key] = sel.value; draw(); });
    wrap.appendChild(sel);
    return wrap;
  };
  extra.appendChild(mk("x", "X axis"));
  extra.appendChild(mk("y", "Y axis"));
  extra.appendChild(mk("z", "Z axis"));
}

async function renderExplorer(ctx, showNote) {
  const { x: xi, y: yi, z: zi } = ctx.state.explorer;
  if (!xi || !yi) { showNote("Pick an X and a Y signal."); return; }
  const traces = [];
  let total = 0;
  const allX = [], allY = [], allZ = [];
  // fetch x/y/z for every machine concurrently (was serial x→y→z per machine)
  const fetched = await Promise.all(ctx.machines.map((id) =>
    Promise.all([
      ctx.dataLayer.historyWindow(id, xi, ctx.win),
      ctx.dataLayer.historyWindow(id, yi, ctx.win),
      zi ? ctx.dataLayer.historyWindow(id, zi, ctx.win) : Promise.resolve(null),
    ]).then(([xr, yr, zr]) => ({ id, xr, yr, zr })).catch(() => ({ id, xr: [], yr: [], zr: null }))
  ));
  if (!ctx.token()) return;
  for (const { id, xr, yr, zr } of fetched) {
    if (!xr || xr.length < 1 || !yr || yr.length < 1) continue;
    const X = [], Y = [], Z = [];
    for (const r of xr) {
      const yv = valueAtOrBefore(yr, r.ts);
      const zv = zi ? valueAtOrBefore(zr || [], r.ts) : null;
      const xn = Number(r.num), yn = yv ? Number(yv.num) : null, zn = zv ? Number(zv.num) : null;
      if (!Number.isFinite(xn) || !Number.isFinite(yn)) continue;
      if (zi && !Number.isFinite(zn)) continue;
      X.push(xn); Y.push(yn); if (zi) Z.push(zn);
    }
    total += X.length;
    allX.push(...X); allY.push(...Y); allZ.push(...Z);
    if (zi) traces.push({ type: "scatter3d", mode: "markers", name: id, x: X, y: Y, z: Z,
      marker: { size: 3, color: machColor(ctx.idxOf(id)), opacity: 0.6 } });
    else traces.push({ type: "scattergl", mode: "markers", name: id, x: X, y: Y,
      marker: { size: 5, color: machColor(ctx.idxOf(id)), opacity: 0.6 } });
  }
  if (!total) { showNote("No overlapping samples for those signals in this window."); return; }
  const lab = (k) => (EXPLORER_ITEMS.find((it) => it.item === k) || { label: k }).label;
  const layout = { ...baseLayout(), title: { text: `Explorer — ${lab(xi)} × ${lab(yi)}${zi ? ` × ${lab(zi)}` : ""}` } };
  if (zi) layout.scene = scene3d(lab(xi), lab(yi), lab(zi));
  else { layout.xaxis = axis2d(lab(xi)); layout.yaxis = axis2d(lab(yi)); }
  ctx.Plotly.react(ctx.plot, traces, layout, PLOT_CONFIG);

  // readout: correlation + per-axis distribution
  const rxy = pearson(allX, allY);
  const strength = (r) => { const a = Math.abs(r); return a >= 0.7 ? "strong" : a >= 0.4 ? "moderate" : a >= 0.2 ? "weak" : "negligible"; };
  const distRow = (name, arr) => [name, num1(mean(arr)), num1(Math.min(...arr)), num1(Math.max(...arr)), arr.length > 1 ? `±${num1(sd(arr))}` : "—"];
  const tables = [{
    caption: "Per-axis distribution",
    head: ["Signal", "Mean", "Min", "Max", "Std dev"],
    rows: [distRow(lab(xi), allX), distRow(lab(yi), allY), ...(zi ? [distRow(lab(zi), allZ)] : [])],
  }];
  const stats = [
    { label: "Joined samples", value: total.toLocaleString() },
    { label: `Correlation X·Y`, value: rxy == null ? "—" : rxy.toFixed(2), sub: rxy == null ? "" : strength(rxy), tone: rxy != null && Math.abs(rxy) >= 0.4 ? "good" : "" },
    { label: lab(xi), value: num1(mean(allX)), sub: "mean" },
    { label: lab(yi), value: num1(mean(allY)), sub: "mean" },
  ];
  return {
    title: "Signal relationship",
    stats, tables,
    note: "Pearson correlation r runs −1…+1: near 0 means the two signals move independently, near ±1 means they track. Samples are joined by carrying each signal's last value forward to the X-signal's sample clock (step-hold), so the relationship is exact at every X sample.",
  };
}
