/* VMC God-mode — navigation router + view orchestration.
 *
 * Adds a tabbed nav bar between the topbar and the content. Tabs:
 *   Dashboard | KPI | Analytics | Timeline | Fleet Intelligence
 *
 * The Dashboard tab IS the existing mission-card grid (#machineGrid) — we only
 * show/hide it, never touch its render loop or markup. Every other tab mounts an
 * isolated module into its own view container, lazily on first activation, and
 * each view runs a refresh loop only while it is the active tab (so background
 * tabs cost nothing and never steal frame budget from the live cards).
 *
 * The alert engine is global and starts immediately regardless of active tab.
 */

import { dataLayer } from "./dataLayer.js";
import { mountAnalytical } from "./analytics.js";
import { mountKpi } from "./kpi.js";
import { mountFleetIntelligence } from "./fleetIntelligence.js";
import { mountTimeline } from "./timeline.js";
import { initAlerts } from "./alerts.js";

const REFRESH_MS = 15000;

/* Tab registry. `grid:true` reuses the existing card grid. `builder` mounts a
 * module; `window:true` shows the Shift/24h/7d selector for that view. */
const TABS = [
  { id: "dashboard", label: "Dashboard", grid: true },
  { id: "kpi", label: "KPI", builder: mountKpi, window: true, title: "KPI Overview", sub: "fleet OEE · stacked throughput · time mix · program drift" },
  { id: "analytics", label: "Analytics", builder: mountAnalytical, window: true, title: "Root-Cause Analytics", sub: "synchronized fleet timeline · downtime Pareto · override discipline · fault diagnostics" },
  { id: "timeline", label: "Timeline", builder: mountTimeline, window: false, title: "Production Timeline", sub: "" },
  { id: "fleet", label: "Fleet Intelligence", builder: mountFleetIntelligence, window: true, title: "Fleet Intelligence", sub: "production targets · program-split cycles · downtime causes · reliability & predictive maintenance" },
];

const LEGACY_TAB_MAP = { maintenance: "fleet", statistics: "fleet" };

const views = new Map(); // id -> { el, ctl, chrome, refreshTimer, mounted }
let activeId = null;

function start() {
  initAlerts();

  const main = document.querySelector("main");
  const grid = document.getElementById("machineGrid");
  const note = document.getElementById("emptyNote");

  // remove the old standalone sections if present (replaced by tabbed views)
  document.getElementById("ds-analytical")?.remove();
  document.getElementById("plan")?.remove();

  // nav bar
  const nav = document.createElement("nav");
  nav.className = "godnav";
  nav.innerHTML = `<div class="godnav-inner" data-f="inner"></div>`;
  main.parentNode.insertBefore(nav, main);
  const inner = nav.querySelector('[data-f="inner"]');

  // shared view host (everything except the dashboard grid renders here)
  const host = document.createElement("div");
  host.className = "godview-host";
  main.appendChild(host);

  for (const tab of TABS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "godnav-tab";
    btn.dataset.tab = tab.id;
    btn.textContent = tab.label;
    btn.addEventListener("click", () => activate(tab.id));
    inner.appendChild(btn);

    if (!tab.grid) {
      const el = document.createElement("section");
      el.className = "ds-section godview";
      el.dataset.section = tab.id;
      el.hidden = true;
      host.appendChild(el);
      views.set(tab.id, { el, tab, ctl: null, refreshTimer: null, mounted: false });
    } else {
      views.set(tab.id, { tab, grid, note, refreshTimer: null, mounted: true });
    }
  }

  // window selector change re-refreshes the active windowed view
  dataLayer.onWindowChange(() => {
    const v = views.get(activeId);
    if (v && v.ctl) v.ctl.refresh();
  });

  // restore last tab (seamlessly migrate legacy maintenance/statistics tabs -> fleet)
  const rawSaved = localStorage.getItem("vmc_tab") || "dashboard";
  const initial = LEGACY_TAB_MAP[rawSaved] || rawSaved;
  activate(TABS.some((t) => t.id === initial) ? initial : "dashboard");
}

function activate(id) {
  if (activeId === id) return;
  const prev = views.get(activeId);
  if (prev && prev.refreshTimer) { clearInterval(prev.refreshTimer); prev.refreshTimer = null; }
  // Tear down the view we're leaving so its loops/GPU contexts don't linger.
  // Views that own rAF loops or heavy canvas contexts (Timeline) expose
  // destroy(); after teardown they re-mount fresh on next activation.
  if (prev && prev.ctl && typeof prev.ctl.destroy === "function") {
    try { prev.ctl.destroy(); } catch (_) {}
    prev.ctl = null;
    prev.mounted = false;
  }

  activeId = id;
  localStorage.setItem("vmc_tab", id);
  // let the aurora background know the active tab so it can pause itself on
  // heavy canvas views (Timeline) instead of stacking canvas work.
  window.dispatchEvent(new CustomEvent("vmc-tab", { detail: { id } }));

  document.querySelectorAll(".godnav-tab").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === id));

  // toggle dashboard grid vs view host
  const grid = document.getElementById("machineGrid");
  const note = document.getElementById("emptyNote");
  const isDash = id === "dashboard";
  if (grid) grid.style.display = isDash ? "" : "none";
  if (note && !isDash) note.hidden = true;

  for (const [vid, v] of views) {
    if (v.el) v.el.hidden = vid !== id;
  }

  const v = views.get(id);
  if (!v || v.tab.grid) return;

  if (!v.mounted) {
    v.chrome = buildChrome(v.el, v.tab);
    v.ctl = v.tab.builder(v.chrome.body, dataLayer);
    v.mounted = true;
  }
  const tick = async () => {
    // a rapid tab switch can tear down this view (ctl nulled) between ticks —
    // bail if we're no longer the active, mounted view.
    if (activeId !== id || !v.ctl) return;
    await paintConfidence(v.chrome);
    if (activeId !== id || !v.ctl) return; // re-check after the await
    try { 
      await v.ctl.refresh(); 
    } catch (err) {
      // Tab refresh failed — surface the error instead of leaving a spinner forever
      console.error(`[godmode] ${id} tab refresh failed:`, err);
    }
  };
  tick();
  v.refreshTimer = setInterval(tick, REFRESH_MS);
}

function buildChrome(root, tab) {
  root.replaceChildren();   // clear any prior chrome so re-mount (after destroy) is clean
  const head = document.createElement("div");
  head.className = "ds-head";
  head.innerHTML = `
    <div class="ds-head-titles">
      <h2 class="ds-title">${tab.title}</h2>
      <span class="ds-sub">${tab.sub}</span>
    </div>
    <div class="ds-head-tools">
      <span class="ds-conf" data-f="conf" title="Data completeness from the gapless sequence audit">
        <span class="sp-pill-lbl" data-f="confLabel">—</span>
      </span>
      ${tab.window ? `<div class="ds-window" data-f="window"></div>` : ""}
    </div>`;
  root.appendChild(head);

  if (tab.window) {
    const wh = head.querySelector('[data-f="window"]');
    for (const w of dataLayer.WINDOW_DEFS) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "ds-window-btn"; b.dataset.win = w.key; b.textContent = w.label;
      b.addEventListener("click", () => dataLayer.setWindowKey(w.key));
      wh.appendChild(b);
    }
    const sync = () => wh.querySelectorAll(".ds-window-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.win === dataLayer.getWindowKey()));
    sync(); dataLayer.onWindowChange(sync);
  }

  const body = document.createElement("div");
  body.className = "ds-body";
  root.appendChild(body);
  return { head, body, conf: head.querySelector('[data-f="conf"]'), confLabel: head.querySelector('[data-f="confLabel"]') };
}

async function paintConfidence(chrome) {
  if (!chrome) return;
  try {
    const audit = await dataLayer.gapAudit();
    const c = dataLayer.confidenceFromAudit(audit);
    if (window.VMCStatusPill) {
      window.VMCStatusPill.updatePill(chrome.conf, c.level, c.label, `ds-conf conf-${c.level}`);
    } else {
      chrome.conf.className = `ds-conf conf-${c.level}`;
      if (chrome.confLabel) chrome.confLabel.textContent = c.label;
    }
    chrome.conf.title = `Data completeness — ${c.detail || c.label}`;
  } catch (err) {
    // Distinguish timeout from genuine unreachable
    const isTimeout = err.name === 'AbortError' || (err.message && err.message.includes('aborted'));
    const lbl = isTimeout ? "SLOW" : "OFFLINE";
    const kind = isTimeout ? "warn" : "offline";
    if (window.VMCStatusPill) {
      window.VMCStatusPill.updatePill(chrome.conf, kind, lbl, "ds-conf conf-warn");
    } else {
      chrome.conf.className = "ds-conf conf-warn";
      if (chrome.confLabel) chrome.confLabel.textContent = lbl;
    }
    chrome.conf.title = isTimeout 
      ? "Gap audit request timed out — collector is slow but reachable"
      : "Collector unreachable";
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
