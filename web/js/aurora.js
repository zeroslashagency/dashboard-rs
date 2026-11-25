/* VMC — Dot-matrix background (shimmering-dots "aurora" field).
 *
 * A full-viewport grid of dots lit by a flowing stacked-sine vector field, so
 * the whole surface drifts like an aurora rather than marching in lines. Ported
 * clean-room to vanilla Canvas 2D from the MIT-licensed shimmering-dots project
 * (github.com/m1ckc3s/shimmering-dots) — no React, no WebGL, no dependency.
 *
 * The seven knobs below are the project's field-pattern knob set, every one a
 * multiplier whose 1.00 default reproduces the stock aurora look:
 *   speed · brightness · dotSize · density · scale · vignette · opacity
 * Tune live from the console via window.__vmcDots.set({ scale: 1.4, ... }).
 *
 * Performance discipline (matches the rest of the app):
 *   - one fixed full-viewport canvas BEHIND all content (pointer-events:none);
 *   - capped frame-rate via a frame-time gate;
 *   - paused while the tab is hidden, and on the GPU-heavy god-mode tabs;
 *   - prefers-reduced-motion → one static frame, no loop.
 */
(function () {
  "use strict";

  // ---- the seven field knobs (multipliers; 1.00 = stock aurora) ----
  const PARAMS = {
    speed: 1.0,       // time multiplier
    brightness: 1.0,  // intensity gain on each lit dot
    dotSize: 1.0,     // dot radius factor
    density: 1.0,     // grid packing (higher = more, smaller-pitched dots)
    scale: 1.0,       // spatial frequency of the flow field
    vignette: 1.0,    // edge darkening strength
    opacity: 1.0,     // global dot opacity
  };

  const AURORA_GRID = 0.018; // base normalized pitch; pitch = grid / density
  const DOT_BASE_R = 1.6;    // base dot radius, scaled by dotSize
  const VIGNETTE_K = 0.9;    // aurora's vignette factor
  const MAX_CELLS = 6500;    // perf ceiling on dot count (pitch grows to respect it)
  const FPS_CAP = 45;
  const FRAME_MS = 1000 / FPS_CAP;
  const HEAVY_TABS = new Set(["threed", "timeline", "datalab"]);

  const TAU = Math.PI * 2;
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

  // dot tint: read from the --dot-rgb CSS var so the field follows the page
  // theme (white on the dark board, dark slate on the light wash). Mutable; the
  // theme toggle calls window.__vmcAuroraRetint() to re-read it.
  let TINT = [255, 255, 255];
  function readTint() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--dot-rgb").trim();
    const parts = raw.split(",").map((n) => parseInt(n, 10));
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) TINT = parts;
  }

  const canvas = document.createElement("canvas");
  canvas.id = "aurora-bg";
  canvas.setAttribute("aria-hidden", "true");
  const ctx = canvas.getContext("2d", { alpha: true });

  let cells = [];
  let W = 0, H = 0, dpr = 1;
  let raf = null;
  let lastFrame = 0;
  let paused = false;
  let simT = 0;                // accumulated animation time (seconds, pre-speed)
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function mount() {
    if (canvas.parentNode) return;
    (document.body || document.documentElement).appendChild(canvas);
    // readTint() deferred to the first rAF frame (see tintRead flag below) so
    // that getComputedStyle sees applied stylesheets. DOMContentLoaded fires
    // when HTML is parsed, not when external CSS is applied — reading custom
    // properties at mount() time returns '' on a cold cache.
    resize();
    if (reduced) { readTint(); renderAurora(0); return; }  // static path: styles applied by now
    start();
  }

  // Build the field grid. Each cell carries its pixel position plus the
  // normalized field coords (u,v), radial length, and squared center-distance
  // (vd) used for the vignette — exactly the shimmering-dots aurora layout.
  function buildCells() {
    cells = [];
    if (W <= 0 || H <= 0) return;

    // pitch shrinks with density; grow it back if the dot count would blow past
    // the perf ceiling, so density is honored on big screens without stutter.
    let pitch = AURORA_GRID / Math.max(0.01, PARAMS.density);
    const cx = W / 2, cy = H / 2;
    const estimate = (p) =>
      ((2 * Math.ceil((W / 2) / H / p) + 1) * (2 * Math.ceil(0.5 / p) + 1));
    while (estimate(pitch) > MAX_CELLS) pitch *= 1.08;

    const kxMax = Math.ceil((W / 2) / H / pitch) + 1;
    const kyMax = Math.ceil((H / 2) / H / pitch) + 1;
    for (let ky = -kyMax; ky <= kyMax; ky++) {
      for (let kx = -kxMax; kx <= kxMax; kx++) {
        const u = kx * pitch;
        const v = ky * pitch;
        const x = u * H + cx;
        const y = v * H + cy;
        if (x < -4 || x > W + 4 || y < -4 || y > H + 4) continue;
        cells.push({ x, y, u, v, len: Math.sqrt(u * u + v * v), vd: u * u + v * v });
      }
    }
  }

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildCells();
    if (reduced) renderAurora(0);
  }

  // One frame. `tRaw` is accumulated seconds; speed scales it here so the knob
  // stays a pure multiplier. Each dot is lit by four stacked sines of u, v,
  // (u+v) and len — the aurora flow — shaped by a soft vertical gradient,
  // multiplied by the vignette, gained by brightness, and drawn at `opacity`.
  function renderAurora(tRaw) {
    ctx.clearRect(0, 0, W, H);
    const t = tRaw * PARAMS.speed;
    const s = PARAMS.scale;
    const vK = VIGNETTE_K * PARAMS.vignette;
    const dotR = DOT_BASE_R * Math.max(0.05, PARAMS.dotSize);
    const gain = PARAMS.brightness;
    const op = PARAMS.opacity;
    const [tr, tg, tb] = TINT;

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const field = (
        Math.sin(c.u * 8 * s + t * 0.8) +
        Math.cos(c.v * 8 * s - t * 0.6) +
        Math.sin((c.u + c.v) * 6 * s + t * 0.5) +
        Math.cos(c.len * 10 * s - t * 0.9)
      ) * 0.25;

      const bright = Math.pow(clamp01(0.5 + 0.5 * field), 2.5);
      const vig = clamp01(1 - c.vd * vK);
      let intensity = bright * vig * gain;
      if (intensity < 0.01) continue;
      if (intensity > 1) intensity = 1;

      ctx.fillStyle = `rgba(${tr},${tg},${tb},${(intensity * op).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(c.x, c.y, dotR, 0, TAU);
      ctx.fill();
    }
  }

  let tintRead = false;
  function loop(now) {
    raf = requestAnimationFrame(loop);
    // First frame: stylesheets are guaranteed computed by the time rAF fires.
    // Reading --dot-rgb here avoids the cold-cache race where DOMContentLoaded
    // fires before the external CSS is applied.
    if (!tintRead) { readTint(); tintRead = true; }
    if (paused || document.hidden) { lastFrame = now; return; }
    if (now - lastFrame < FRAME_MS) return;
    const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0;
    lastFrame = now;
    simT += dt;
    renderAurora(simT);
  }

  function start() {
    if (raf != null || reduced) return;
    raf = requestAnimationFrame(loop);
  }

  // ---- wiring ----
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 150);
  });

  // Pause on the GPU-heavy god-mode tabs so the field never stacks behind
  // another live canvas. godmode.js dispatches "vmc-tab" with the active id.
  window.addEventListener("vmc-tab", (e) => {
    const id = e && e.detail && e.detail.id;
    paused = HEAVY_TABS.has(id);
    if (paused) ctx.clearRect(0, 0, W, H);
  });

  // Re-read the dot tint when the page theme flips (called from app.js).
  window.__vmcAuroraRetint = function () {
    readTint();
    if (W > 0 && H > 0) renderAurora(simT);
  };

  // Live knob tuning, mirroring the shimmering-dots slider panel. Example:
  //   window.__vmcDots.set({ scale: 1.4, density: 1.2 })
  // density rebuilds the grid; everything else is read per-frame.
  window.__vmcDots = {
    params: PARAMS,
    set(partial) {
      let rebuild = false;
      for (const k in partial) {
        if (k in PARAMS && typeof partial[k] === "number") {
          if (k === "density" && partial[k] !== PARAMS.density) rebuild = true;
          PARAMS[k] = partial[k];
        }
      }
      if (rebuild) buildCells();
      if (reduced || paused) renderAurora(simT);   // reflect immediately when not looping
      return { ...PARAMS };
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
