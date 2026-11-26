/* ============================================================================
 * VMC Status Pills — Style B (Frosted Pastel + Uniform Circled Icons)
 * Single shared inline-SVG icon & diff-checked pill updater consumed by both
 * app.js (machine cards, header chips, connection badge) and the ES-module
 * god-mode views (analytics, KPI, alerts, 3D HUD, maintenance, statistics).
 * ==========================================================================*/
(function (global) {
  "use strict";

  /* 8-dot graduated circular loader (exact Style B Running icon). */
  const ICON_RUNNING =
    '<svg class="sp-ico sp-ico--spin" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
      '<circle cx="10" cy="3.2" r="1.45" fill="currentColor" opacity="1"/>' +
      '<circle cx="14.8" cy="5.2" r="1.35" fill="currentColor" opacity="0.88"/>' +
      '<circle cx="16.8" cy="10" r="1.3" fill="currentColor" opacity="0.74"/>' +
      '<circle cx="14.8" cy="14.8" r="1.2" fill="currentColor" opacity="0.60"/>' +
      '<circle cx="10" cy="16.8" r="1.15" fill="currentColor" opacity="0.46"/>' +
      '<circle cx="5.2" cy="14.8" r="1.1" fill="currentColor" opacity="0.34"/>' +
      '<circle cx="3.2" cy="10" r="1.05" fill="currentColor" opacity="0.24"/>' +
      '<circle cx="5.2" cy="5.2" r="1.0" fill="currentColor" opacity="0.16"/>' +
    '</svg>';

  /* Encircled checkmark (Idle, OK, High, Gapless, No E-Stop). */
  const ICON_CHECK =
    '<svg class="sp-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">' +
      '<circle cx="10" cy="10" r="7.75" stroke="currentColor" stroke-width="1.75"/>' +
      '<path d="M6.7 10.2l2.2 2.25 4.45-4.7" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  /* Encircled exclamation (Paused, Setup/Manual, Warn, Hold, Replay). */
  const ICON_WARN =
    '<svg class="sp-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">' +
      '<circle cx="10" cy="10" r="7.75" stroke="currentColor" stroke-width="1.75"/>' +
      '<path d="M10 6.1v4.7" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>' +
      '<circle cx="10" cy="13.75" r="1.05" fill="currentColor"/>' +
    '</svg>';

  /* Encircled cross (Alarm, E-Stop, Critical, Bad, Error). Uses --sp-ico-fill
   * and --sp-ico-cutout so Dark Mode shows Style B's filled rose circle while
   * Light Mode keeps the crisp outlined rose ring. */
  const ICON_ALARM =
    '<svg class="sp-ico sp-ico--alarm" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">' +
      '<circle cx="10" cy="10" r="7.75" fill="var(--sp-ico-fill, transparent)" stroke="var(--sp-ico-ring, currentColor)" stroke-width="1.75"/>' +
      '<path d="M7.35 7.35l5.3 5.3M12.65 7.35l-5.3 5.3" stroke="var(--sp-ico-cutout, currentColor)" stroke-width="1.9" stroke-linecap="round"/>' +
    '</svg>';

  /* Static encircled cross (non-pulsing error/bad status badge). */
  const ICON_BAD_STATIC =
    '<svg class="sp-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">' +
      '<circle cx="10" cy="10" r="7.75" fill="var(--sp-ico-fill, transparent)" stroke="var(--sp-ico-ring, currentColor)" stroke-width="1.75"/>' +
      '<path d="M7.35 7.35l5.3 5.3M12.65 7.35l-5.3 5.3" stroke="var(--sp-ico-cutout, currentColor)" stroke-width="1.9" stroke-linecap="round"/>' +
    '</svg>';

  /* Encircled clock (Offline, Unavailable, Unknown, Expired). */
  const ICON_CLOCK =
    '<svg class="sp-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">' +
      '<circle cx="10" cy="10" r="7.75" stroke="currentColor" stroke-width="1.75"/>' +
      '<path d="M10 5.9V10l2.9 1.75" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  /* Broadcast signal waves (Live, Info). */
  const ICON_LIVE =
    '<svg class="sp-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">' +
      '<circle cx="10" cy="10" r="1.65" fill="currentColor"/>' +
      '<path d="M7.15 7.35a3.95 3.95 0 0 0 0 5.3M12.85 7.35a3.95 3.95 0 0 1 0 5.3" stroke="currentColor" stroke-width="1.65" stroke-linecap="round"/>' +
      '<path d="M4.65 5.15a7.1 7.1 0 0 0 0 9.7M15.35 5.15a7.1 7.1 0 0 1 0 9.7" stroke="currentColor" stroke-width="1.65" stroke-linecap="round"/>' +
    '</svg>';

  /* Encircled tool/gear indicator (Maintenance tool chip). */
  const ICON_TOOL =
    '<svg class="sp-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">' +
      '<circle cx="10" cy="10" r="7.75" stroke="currentColor" stroke-width="1.75"/>' +
      '<circle cx="10" cy="10" r="2.7" stroke="currentColor" stroke-width="1.65"/>' +
      '<path d="M10 5.4v1.5M10 13.1v1.5M5.4 10h1.5M13.1 10h1.5" stroke="currentColor" stroke-width="1.55" stroke-linecap="round"/>' +
    '</svg>';

  /* Encircled play arrow (Maintenance program chip). */
  const ICON_PROGRAM =
    '<svg class="sp-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">' +
      '<circle cx="10" cy="10" r="7.75" stroke="currentColor" stroke-width="1.75"/>' +
      '<path d="M8.5 7.1l4.6 2.9-4.6 2.9V7.1z" fill="currentColor"/>' +
    '</svg>';

  const KIND_MAP = {
    running: ICON_RUNNING,
    idle: ICON_CHECK,
    ok: ICON_CHECK,
    good: ICON_CHECK,
    connected: ICON_CHECK,
    paused: ICON_WARN,
    setup_manual: ICON_WARN,
    warn: ICON_WARN,
    warning: ICON_WARN,
    hold: ICON_WARN,
    replay: ICON_WARN,
    alarm: ICON_ALARM,
    e_stop: ICON_ALARM,
    estop: ICON_ALARM,
    critical: ICON_ALARM,
    bad: ICON_BAD_STATIC,
    error: ICON_BAD_STATIC,
    offline: ICON_CLOCK,
    unavailable: ICON_CLOCK,
    unknown: ICON_CLOCK,
    expired: ICON_CLOCK,
    down: ICON_CLOCK,
    live: ICON_LIVE,
    info: ICON_LIVE,
    tool: ICON_TOOL,
    program: ICON_PROGRAM,
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function iconSvg(kind) {
    const k = String(kind || "unknown").toLowerCase();
    return KIND_MAP[k] || ICON_CLOCK;
  }

  function innerMarkup(kind, label) {
    return (
      '<span class="sp-pill-ico" aria-hidden="true">' + iconSvg(kind) + "</span>" +
      '<span class="sp-pill-lbl">' + esc(label) + "</span>"
    );
  }

  /* Diff-checked DOM updater: safe to call at 1 Hz without resetting CSS
   * spinner/pulse animations when state and label are unchanged. */
  function updatePill(el, kind, label, className) {
    if (!el) return;
    const k = String(kind || "unknown").toLowerCase();
    const text = String(label == null ? "" : label);
    if (className && el.className !== className) {
      el.className = className;
    }
    const icoHost = el.firstElementChild && el.firstElementChild.classList.contains("sp-pill-ico")
      ? el.firstElementChild
      : null;
    const lblHost = icoHost ? icoHost.nextElementSibling : null;

    if (!icoHost || !lblHost) {
      el.innerHTML = innerMarkup(k, text);
      el.dataset.spKind = k;
      el.dataset.spLabel = text;
      return;
    }
    if (el.dataset.spKind !== k) {
      icoHost.innerHTML = iconSvg(k);
      el.dataset.spKind = k;
    }
    if (el.dataset.spLabel !== text) {
      lblHost.textContent = text;
      el.dataset.spLabel = text;
    }
  }

  global.VMCStatusPill = {
    iconSvg: iconSvg,
    innerMarkup: innerMarkup,
    updatePill: updatePill,
  };
})(typeof window !== "undefined" ? window : globalThis);
