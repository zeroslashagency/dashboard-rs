/* VMC God-mode — 3D Toolpath Theatre.
 *
 * A real-time, multi-machine toolpath viewer. Live only — everything is real:
 *
 *   - LIVE trail: the moment you open the tab, we BACKFILL the current cycle
 *     from the per-axis position history (x/y/z_axis_actual_position) so the
 *     path is never empty — you immediately see what the tool has already cut
 *     this cycle. Then we append the freshest /api/overview .position at 1 Hz
 *     (same rate as the dashboard cards) so the head tracks the tool in real
 *     time. A new part/program resets the trail, so you only ever see the
 *     CURRENT program's cycle — not stacked history. The axes are sampled on
 *     slightly different clocks, so the backfill aligns by TIMESTAMP (X&Y share
 *     stamps; Z is change-logged and nearest-matched).
 *   - MINI-SETUP toggles: enable any subset of machines to see all their paths
 *     at once, laid out side by side in real machine coordinates.
 *   - Controls: drag to orbit, wheel to zoom, shift/right-drag to pan, plus an
 *     auto-orbit toggle. Custom-built on pointer events — no extra dependency.
 *
 * Reuses the global window.THREE the card grid already loads. No backend change.
 */

const MAX_PTS = 6000;
const RAPID_MM = 8, PLUNGE_RATIO = 0.6, PLUNGE_MIN = 0.2;
const COL = { drill: [0.98, 0.62, 0.07], mill: [0.20, 0.84, 0.95], rapid: [0.46, 0.50, 0.60] };
const TARGET = 3.0;          // view radius each machine path is scaled to fit
const SLOT_GAP = TARGET * 1.45;
const MPAL = [               // per-machine identity tint (labels + dimmed paths)
  [0.22, 0.85, 0.95], [0.98, 0.62, 0.10], [0.55, 0.85, 0.45],
  [0.86, 0.45, 0.95], [0.96, 0.78, 0.25], [0.45, 0.65, 0.98],
];
const LS_EN = "vmc_td_enabled", LS_SEL = "vmc_td_selected", LS_AUTO = "vmc_td_auto";

const num = (r) => Number(r && (r.num != null ? r.num : r.val));

export function mountThreeD(body, dataLayer) {
  // Pull three.js now — lazily, on first 3D-tab open — instead of on page load.
  // The render loop already waits for window.THREE before building the scene.
  if (typeof window.__vmcLoadThree === "function") window.__vmcLoadThree();

  body.innerHTML = `
    <div class="td-wrap">
      <aside class="td-side">
        <div class="td-side-sec">
          <div class="td-side-h">Machines <span class="td-side-hint">tap name to focus · toggle to overlay</span></div>
          <div class="td-setup" data-f="setup"></div>
        </div>
        <div class="td-side-sec">
          <div class="td-side-h">View</div>
          <div class="td-vbtns">
            <button class="td-btn" data-f="auto" type="button">Auto-orbit</button>
            <button class="td-btn" data-f="reset" type="button">Reset view</button>
          </div>
          <div class="td-legend">
            <span><i style="background:#34d6f2"></i>cut</span>
            <span><i style="background:#fb9e1a"></i>plunge</span>
            <span><i style="background:#767f99"></i>rapid</span>
          </div>
        </div>
      </aside>
      <div class="td-stage" data-f="stage">
        <canvas class="td-canvas" data-f="canvas"></canvas>
        <div class="td-hud" data-f="hud" hidden></div>
        <div class="td-overlay" data-f="overlay">select a machine</div>
      </div>
    </div>
    <div class="td-readout" data-f="readout"></div>`;

  const refs = {};
  body.querySelectorAll("[data-f]").forEach((n) => { refs[n.dataset.f] = n; });

  // If the three.js CDN failed entirely (both primary + fallback, or timeout),
  // surface an error instead of the indefinite "engine still loading…" state.
  let threeFailed = !!window.__THREE_FAILED__;
  window.addEventListener("three-failed", () => {
    threeFailed = true;
    refs.overlay.hidden = false;
    refs.overlay.textContent = "3D engine failed to load (CDN unreachable).";
  }, { once: true });

  const ctx = {
    selected: localStorage.getItem(LS_SEL) || null,
    enabled: loadEnabled(),
    paths: new Map(),             // id -> [{x,y,z,t}]
    cycleKey: new Map(),          // id -> "program|partcount" (reset trigger)
    over: new Map(),              // id -> overview machine object (live readout)
    machineList: [],
    sc: null, dirty: true, raf: null, primed: false,
    cam: { theta: 0.9, phi: 0.5, radius: 6.5, target: { x: 0, y: 0, z: 0 }, goal: { x: 0, y: 0, z: 0 },
           auto: localStorage.getItem(LS_AUTO) !== "0", dragging: false },
    token: 0,
  };

  refs.auto.addEventListener("click", () => {
    ctx.cam.auto = !ctx.cam.auto;
    localStorage.setItem(LS_AUTO, ctx.cam.auto ? "1" : "0");
    syncViewBtns();
  });
  refs.reset.addEventListener("click", () => { resetView(ctx); });
  syncViewBtns();

  function syncViewBtns() {
    refs.auto.classList.toggle("is-active", ctx.cam.auto);
  }

  // repaint the HTML overlays immediately after a user interaction (the 3D
  // canvas redraws every frame on its own; the HUD/readout are event-driven).
  function repaint() { paintHud(refs, ctx); paintReadout(refs, ctx); }

  /* ---------- machine setup panel ---------- */
  function buildSetup() {
    refs.setup.innerHTML = "";
    ctx.machineList.forEach((id, i) => {
      const o = ctx.over.get(id) || {};
      const on = ctx.enabled.has(id) || id === ctx.selected;
      const tint = rgb(MPAL[i % MPAL.length]);
      const row = document.createElement("div");
      row.className = "td-m" + (id === ctx.selected ? " is-sel" : "");
      const st = (o.status || (o.online ? "idle" : "offline")).toLowerCase();
      row.innerHTML = `
        <button class="td-sw${on ? " on" : ""}" data-id="${id}" type="button" title="show this machine's path" style="--mc:${tint}"><span></span></button>
        <button class="td-m-main" data-sel="${id}" type="button">
          <span class="td-m-name">${id}</span>
          <span class="td-m-meta"><i class="td-dot st-${st}"></i>${st}${o.spindle_speed != null ? ` · ${Math.round(o.spindle_speed)} rpm` : ""}</span>
          <span class="td-m-prog">${o.active_program ? esc(o.active_program) : "—"}</span>
        </button>`;
      refs.setup.appendChild(row);
    });
    refs.setup.querySelectorAll(".td-sw").forEach((b) =>
      b.addEventListener("click", () => toggleMachine(b.dataset.id)));
    refs.setup.querySelectorAll(".td-m-main").forEach((b) =>
      b.addEventListener("click", () => select(b.dataset.sel)));
  }

  function toggleMachine(id) {
    if (ctx.enabled.has(id)) {
      ctx.enabled.delete(id);
      // if we just hid the focused machine, move focus to another visible one
      if (id === ctx.selected) {
        const next = ctx.machineList.find((x) => ctx.enabled.has(x)) || null;
        ctx.selected = next;
        if (next) { localStorage.setItem(LS_SEL, next); focusMachine(next); }
      }
    } else {
      ctx.enabled.add(id);
      ensurePath(id);
    }
    saveEnabled(ctx.enabled);
    ctx.dirty = true;
    buildSetup();
    repaint();
  }

  /* ---------- selection ---------- */
  async function select(id) {
    if (!id) return;
    ctx.selected = id;
    ctx.enabled.add(id);
    saveEnabled(ctx.enabled);
    localStorage.setItem(LS_SEL, id);
    buildSetup();
    focusMachine(id);                 // re-frame the camera onto this machine
    refs.overlay.hidden = false;
    refs.overlay.textContent = "loading toolpath…";
    await ensurePath(id, true);
    if ((ctx.paths.get(id) || []).length > 1) refs.overlay.hidden = true;
    else refs.overlay.textContent = "no retained position samples for this machine";
    ctx.dirty = true;
    focusMachine(id);                 // slot may have shifted after the path loaded
    repaint();
  }

  // Point the orbit camera at a machine's slot so zoom/rotate revolve around IT,
  // not the row's midpoint. step() reads the focused machine's slot every frame
  // (filled in by rebuild), so simply changing ctx.selected re-frames smoothly.
  function focusMachine(_id) { /* focus follows ctx.selected in step() */ }

  async function ensurePath(id, force = false) {
    if (!force && ctx.paths.has(id)) return;
    const my = ++ctx.token;
    try {
      // An OFFLINE machine has no live cycle and its newest samples may be hours
      // old, so a window-from-now is empty. Show its last retained path whole.
      const m = ctx.over.get(id);
      if (m && (m.online === false || (m.status || "").toLowerCase() === "offline")) {
        const all = await loadAxisPath(dataLayer, id);
        if (my !== ctx.token && force) return;
        ctx.paths.set(id, all.slice(-MAX_PTS));
        ctx.dirty = true;
        return;
      }
      // BACKFILL the CURRENT cycle the moment the page opens — so it is never
      // empty waiting for live points to dribble in. We pull the path the tool
      // has ALREADY cut this cycle (started `this_cycle` seconds ago), then the
      // 1 Hz poll keeps appending live. This is the current program's cycle, not
      // the oldest data — same clean single-cycle path the dashboard card shows.
      let pts = await loadAxisPath(dataLayer, id, cycleWindow(id));
      if (my !== ctx.token && force) return;     // a newer select() superseded us
      for (const span of [1800, 5400]) {         // widen if cycle just rolled over
        if (pts.length >= 30) break;
        pts = await loadAxisPath(dataLayer, id, { from: Date.now() - span * 1000, to: Date.now() + 5000 });
        if (my !== ctx.token && force) return;
      }
      ctx.paths.set(id, pts.slice(-MAX_PTS));
      ctx.dirty = true;
    } catch (_) {
      if (!ctx.paths.has(id)) ctx.paths.set(id, []);
    }
  }

  // Time window for the current cycle/part, mirroring the card's per-part reset.
  // Falls back to the last 20 min if the controller doesn't report cycle time.
  function cycleWindow(id) {
    const m = ctx.over.get(id);
    const cyc = m && m.cycle && Number(m.cycle.this_cycle);
    const span = Number.isFinite(cyc) && cyc > 0 ? Math.min(cyc + 30, 3 * 3600) : 1200;
    return { from: Date.now() - span * 1000, to: Date.now() + 5000 };
  }

  /* ---------- live poll (called by router every REFRESH_MS while active) ---------- */
  async function refresh() {
    await liveTick();
  }

  /* Fast 1 s poll: pull the overview and append each visible machine's freshest
   * controller position, exactly like the dashboard cards (which poll at 1 Hz).
   * The router's 15 s tick is far too slow for a "live" path — the tip would
   * jump only once every 15 s and look frozen. This runs on its own timer. */
  let liveBusy = false;
  async function liveTick() {
    if (liveBusy) return;
    if (!refs.stage.offsetParent) return;        // tab hidden — don't poll
    liveBusy = true;
    let ov;
    try { ov = await dataLayer.overview(); }
    catch (_) { liveBusy = false; return; }
    finally { /* keep flag until work below done */ }
    try {
      const machines = (ov.machines || []).map((m) => m.machine_id);
      for (const m of ov.machines || []) ctx.over.set(m.machine_id, m);

      if (machines.join() !== ctx.machineList.join()) {
        ctx.machineList = machines;
        buildSetup();
      }
      // first-time priming: auto-pick the first machine, or (re)load a machine
      // restored from localStorage so its path + program list actually populate.
      if (!ctx.primed && machines.length) {
        ctx.primed = true;
        const start = ctx.selected && machines.includes(ctx.selected) ? ctx.selected : machines[0];
        select(start);
      }
      // append the freshest controller position for every enabled machine
      {
        for (const id of allVisible(ctx)) {
          const m = ctx.over.get(id);
          const p = m && m.position;
          // require BOTH planar axes finite — a half-valid sample (x only) would
          // poison the geometry with NaN. Z may be absent on 2.5D machines.
          if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
          const z = Number.isFinite(p.z) ? p.z : null;
          // mirror the card: a new part/program resets the path so we only ever
          // show the CURRENT cutting cycle, not cycles stacked on top of each other.
          const key = `${m.active_program || ""}|${m.part_count_total ?? m.part_count ?? ""}`;
          if (ctx.cycleKey.get(id) !== key) {
            ctx.cycleKey.set(id, key);
            if (ctx.paths.has(id) && ctx.paths.get(id).length) { ctx.paths.set(id, []); ctx.dirty = true; }
          }
          const arr = ctx.paths.get(id) || (ctx.paths.set(id, []), ctx.paths.get(id));
          const last = arr[arr.length - 1];
          if (!last || last.x !== p.x || last.y !== p.y || last.z !== z) {
            arr.push({ x: p.x, y: p.y, z, t: Date.now(), noZ: z === null });
            if (arr.length > MAX_PTS) arr.shift();
            ctx.dirty = true;
          }
        }
      }
      // refresh the side-panel live meta + HUD/readout every ~3 s (cheap, but no
      // need at 1 Hz — the moving path is the live signal that matters)
      ctx.metaTick = (ctx.metaTick || 0) + 1;
      if (ctx.metaTick % 3 === 0) buildSetup();
      paintHud(refs, ctx);
      paintReadout(refs, ctx);
      if (!window.THREE && !ctx.sc) {
        refs.overlay.hidden = false;
        refs.overlay.textContent = threeFailed
          ? "3D engine failed to load (CDN unreachable)."
          : "3D engine still loading…";
      }
    } finally {
      liveBusy = false;
    }
  }
  ctx.liveTimer = setInterval(liveTick, 1000);
  liveTick();   // kick off immediately so the path starts loading the instant the tab opens

  /* ---------- render loop (smooth, independent of the data poll) ---------- */
  function loop() {
    ctx.raf = requestAnimationFrame(loop);
    if (!refs.stage.offsetParent) return;            // tab hidden — skip work
    if (!ctx.sc && window.THREE) ensureScene(refs.canvas, ctx);
    if (!ctx.sc) return;
    if (ctx.dirty) { rebuild(ctx); ctx.dirty = false; ctx.dirtyDrew = true; }
    step(ctx);
  }
  initControls(refs.canvas, ctx);
  loop();

  // Tear everything down when the tab is left: stop both loops and release the
  // WebGL context + every geometry/material/texture so visiting 3D repeatedly
  // can't pile up renderers (browsers cap live contexts ~16). The router calls
  // this via prev.ctl.destroy() on tab switch.
  function destroy() {
    if (ctx.raf) { cancelAnimationFrame(ctx.raf); ctx.raf = null; }
    if (ctx.liveTimer) { clearInterval(ctx.liveTimer); ctx.liveTimer = null; }
    disposeScene(ctx);
  }

  return { refresh, destroy };
}

/* ===================== data ===================== */

async function loadAxisPath(dataLayer, id, win) {
  const [xs, ys, zs] = await Promise.all([
    dataLayer.history(id, "x_axis_actual_position"),
    dataLayer.history(id, "y_axis_actual_position"),
    dataLayer.history(id, "z_axis_actual_position"),
  ]);
  if (!xs.length || !ys.length) {
    // some machines emit only the combined xyzact item
    return loadCombo(dataLayer, id, win);
  }
  const ymap = new Map(ys.map((r) => [r.ts, num(r)]));
  const haveZ = zs.length > 0;                 // does this machine emit a Z axis at all?
  const zt = zs.map((r) => r.ts), zv = zs.map((r) => num(r));
  const pts = [];
  for (const r of xs) {
    const t = r.ts;
    if (win && (t < win.from || t > win.to)) continue;
    const y = ymap.get(t);
    if (y === undefined) continue;
    const x = num(r);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    // Only plot a Z when the machine actually emits one. A machine with no Z
    // history is 2.5D from our side; flag z=null (drawn on the z=0 plane) rather
    // than fabricating a "0" that reads as a real depth. rebuild() treats a null
    // z as the plane and the readout can disclose "no Z".
    let z = null;
    if (haveZ) { const zc = nearest(zt, zv, t); if (Number.isFinite(zc)) z = zc; }
    pts.push({ x, y, z, t, noZ: !haveZ });
  }
  return pts;
}

async function loadCombo(dataLayer, id, win) {
  let rows = [];
  try { rows = await dataLayer.history(id, "xyzact"); } catch (_) { return []; }
  const pts = [];
  for (const r of rows) {
    if (win && (r.ts < win.from || r.ts > win.to)) continue;
    const a = String(r.val || "").split(",").map(parseFloat);
    if (a.length >= 3 && a.slice(0, 3).every(Number.isFinite))
      pts.push({ x: a[0], y: a[1], z: a[2], t: r.ts });
  }
  return pts;
}

function nearest(times, vals, t) {
  let lo = 0, hi = times.length - 1;
  if (t <= times[0]) return vals[0];
  if (t >= times[hi]) return vals[hi];
  while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] < t) lo = m + 1; else hi = m; }
  return Math.abs(times[lo] - t) <= Math.abs(times[lo - 1] - t) ? vals[lo] : vals[lo - 1];
}

/* ===================== scene ===================== */

function ensureScene(canvas, ctx) {
  if (ctx.sc || !window.THREE) return;
  const THREE = window.THREE;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  const root = new THREE.Group();
  scene.add(root);
  // faint ground grid for spatial reference
  const grid = new THREE.GridHelper(TARGET * 4, 16, 0x2b3a52, 0x1a2740);
  grid.material.transparent = true; grid.material.opacity = 0.4;
  scene.add(grid);
  ctx.sc = { THREE, renderer, scene, camera, root, grid, machines: new Map() };
}

/* Release the renderer + every per-machine geometry/material/texture. three.js
 * does not GC GPU resources for us, so each must be disposed explicitly. */
function disposeScene(ctx) {
  const sc = ctx.sc;
  if (!sc) return;
  for (const mo of sc.machines.values()) {
    mo.geom.dispose();
    mo.line.material.dispose();
    mo.head.geometry.dispose();
    mo.head.material.dispose();
    if (mo.label.material.map) mo.label.material.map.dispose();
    mo.label.material.dispose();
  }
  sc.machines.clear();
  if (sc.grid) { sc.grid.geometry.dispose(); sc.grid.material.dispose(); }
  try { sc.renderer.dispose(); sc.renderer.forceContextLoss(); } catch (_) {}
  ctx.sc = null;
  ctx.drewOnce = false;
}

function ensureMachineObj(ctx, id, idx) {
  const sc = ctx.sc, THREE = sc.THREE;
  let mo = sc.machines.get(id);
  if (mo) return mo;
  const geom = new THREE.BufferGeometry();
  const positions = new Float32Array(MAX_PTS * 3);
  const colors = new Float32Array(MAX_PTS * 3);
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geom.setDrawRange(0, 0);
  const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }));
  line.frustumCulled = false;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 16), new THREE.MeshBasicMaterial({ color: 0xeafdff }));
  const label = makeLabel(THREE, id, MPAL[idx % MPAL.length]);
  sc.root.add(line); sc.root.add(head); sc.root.add(label);
  mo = { geom, positions, colors, line, head, label, idx };
  sc.machines.set(id, mo);
  return mo;
}

function makeLabel(THREE, text, tint) {
  const c = document.createElement("canvas"); c.width = 256; c.height = 64;
  const g = c.getContext("2d");
  g.font = "bold 34px Rajdhani, sans-serif"; g.textBaseline = "middle";
  g.fillStyle = `rgb(${(tint[0] * 255) | 0},${(tint[1] * 255) | 0},${(tint[2] * 255) | 0})`;
  g.fillText(text, 8, 34);
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  spr.scale.set(1.6, 0.4, 1);
  return spr;
}

/* Recompute geometry for every visible machine, laid out side by side. */
function rebuild(ctx) {
  const visible = allVisible(ctx).filter((id) => (ctx.paths.get(id) || []).length > 1);
  // hide machine objects that are no longer visible
  for (const [id, mo] of ctx.sc.machines) {
    const show = visible.includes(id);
    mo.line.visible = show; mo.head.visible = show; mo.label.visible = show;
  }
  if (!visible.length) return;

  // shared scale = fit the widest single path into TARGET
  let maxSpan = 1;
  const meta = visible.map((id) => {
    const pts = ctx.paths.get(id);
    let cx = 0, cy = 0, cz = 0, nX = Infinity, nY = Infinity, nZ = Infinity, xX = -Infinity, xY = -Infinity, xZ = -Infinity;
    for (const p of pts) {
      const pz = p.z == null ? 0 : p.z;        // 2.5D machines: project onto z=0 plane
      cx += p.x; cy += p.y; cz += pz;
      nX = Math.min(nX, p.x); xX = Math.max(xX, p.x);
      nY = Math.min(nY, p.y); xY = Math.max(xY, p.y);
      nZ = Math.min(nZ, pz); xZ = Math.max(xZ, pz);
    }
    const n = pts.length; cx /= n; cy /= n; cz /= n;
    const span = Math.max(xX - nX, xY - nY, xZ - nZ, 1);
    maxSpan = Math.max(maxSpan, span);
    return { id, pts, cx, cy, cz };
  });
  const s = TARGET / maxSpan;
  const n = visible.length;
  ctx.slots = new Map();          // id -> {x,y,z} world-space center of each path

  meta.forEach((m, slot) => {
    const off = (slot - (n - 1) / 2) * SLOT_GAP;
    ctx.slots.set(m.id, { x: off, y: 0, z: 0 });   // path is centered in its slot
    const mo = ensureMachineObj(ctx, m.id, ctx.machineList.indexOf(m.id));
    const pts = m.pts, isSel = m.id === ctx.selected;
    const tint = MPAL[mo.idx % MPAL.length];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const pz = p.z == null ? 0 : p.z;
      mo.positions[i * 3] = (p.x - m.cx) * s + off;     // machine X -> view X (+ slot)
      mo.positions[i * 3 + 1] = (pz - m.cz) * s;         // machine Z (tool axis) -> view up
      mo.positions[i * 3 + 2] = (p.y - m.cy) * s;        // machine Y -> view depth
      const q = pts[i > 0 ? i - 1 : 0];
      const qz = q.z == null ? 0 : q.z;
      const dx = p.x - q.x, dy = p.y - q.y, dz = pz - qz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let c = d > RAPID_MM ? COL.rapid : (Math.abs(dz) > PLUNGE_RATIO * d && Math.abs(dz) > PLUNGE_MIN ? COL.drill : COL.mill);
      if (!isSel) c = tint;                              // overlay machines wear their identity tint
      const f = (isSel ? 0.25 : 0.18) + (isSel ? 0.75 : 0.42) * (i / (pts.length - 1 || 1));
      mo.colors[i * 3] = c[0] * f; mo.colors[i * 3 + 1] = c[1] * f; mo.colors[i * 3 + 2] = c[2] * f;
    }
    mo.geom.attributes.position.needsUpdate = true;
    mo.geom.attributes.color.needsUpdate = true;
    mo.geom.setDrawRange(0, pts.length);
    mo.line.material.opacity = isSel ? 0.97 : 0.5;
    const tip = pts[pts.length - 1];
    const tipz = tip.z == null ? 0 : tip.z;
    const hx = (tip.x - m.cx) * s + off, hy = (tipz - m.cz) * s, hz = (tip.y - m.cy) * s;
    mo.head.position.set(hx, hy, hz);
    mo.head.scale.setScalar(isSel ? 1 : 0.7);
    mo.head.material.color.setRGB(isSel ? 0.92 : tint[0], isSel ? 0.99 : tint[1], isSel ? 1 : tint[2]);
    mo.label.position.set(off, TARGET * 0.62, 0);
    mo.label.material.opacity = isSel ? 1 : 0.7;
  });
}

function step(ctx) {
  const sc = ctx.sc, cv = sc.renderer.domElement;
  const w = cv.clientWidth || 1, h = cv.clientHeight || 1;
  const resized = cv.width !== w || cv.height !== h;
  if (resized) {
    sc.renderer.setSize(w, h, false); sc.camera.aspect = w / h; sc.camera.updateProjectionMatrix();
  }
  const cam = ctx.cam;
  if (cam.auto && !cam.dragging) cam.theta += 0.003;
  cam.phi = Math.max(-1.45, Math.min(1.45, cam.phi));
  cam.radius = Math.max(2.2, Math.min(60, cam.radius));
  // ease the orbit center toward the focused machine's slot (smooth re-frame).
  // re-read the slot each frame so the focus follows it as overlays come/go.
  const goal = focusPoint(ctx);
  const dxe = goal.x - cam.target.x, dye = goal.y - cam.target.y, dze = goal.z - cam.target.z;
  const easing = Math.abs(dxe) + Math.abs(dye) + Math.abs(dze) > 1e-4;
  cam.target.x += dxe * 0.15;
  cam.target.y += dye * 0.15;
  cam.target.z += dze * 0.15;
  // Only spend a GPU draw when something actually changed this frame. With the
  // camera settled, auto-orbit off and no new geometry, the scene is static — so
  // we skip render() entirely instead of burning 60 fps on an unchanging image.
  const needRender = resized || ctx.dirtyDrew || cam.auto || cam.dragging || cam.userMoved || easing || !ctx.drewOnce;
  cam.userMoved = false;
  ctx.dirtyDrew = false;
  if (!needRender) return;
  const t = cam.target;
  sc.camera.position.set(
    t.x + cam.radius * Math.cos(cam.phi) * Math.sin(cam.theta),
    t.y + cam.radius * Math.sin(cam.phi),
    t.z + cam.radius * Math.cos(cam.phi) * Math.cos(cam.theta)
  );
  sc.camera.lookAt(t.x, t.y, t.z);
  sc.renderer.render(sc.scene, sc.camera);
  ctx.drewOnce = true;
}

/* ===================== controls ===================== */

function initControls(canvas, ctx) {
  const cam = ctx.cam;
  let lx = 0, ly = 0, pan = false;
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (e) => {
    cam.dragging = true; lx = e.clientX; ly = e.clientY;
    pan = e.shiftKey || e.button === 2 || e.button === 1;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!cam.dragging) return;
    const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
    cam.userMoved = true;
    if (pan) {
      const sc = ctx.sc; if (!sc) return;
      const THREE = sc.THREE;
      const right = new THREE.Vector3().setFromMatrixColumn(sc.camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(sc.camera.matrix, 1);
      const k = cam.radius * 0.0016;
      cam.target.x += (-dx * right.x + dy * up.x) * k;
      cam.target.y += (-dx * right.y + dy * up.y) * k;
      cam.target.z += (-dx * right.z + dy * up.z) * k;
    } else {
      cam.theta -= dx * 0.008;
      cam.phi += dy * 0.008;
    }
  });
  const end = (e) => { cam.dragging = false; try { canvas.releasePointerCapture(e.pointerId); } catch (_) {} };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    cam.radius *= e.deltaY > 0 ? 1.1 : 0.9;
    cam.userMoved = true;
  }, { passive: false });
}

function resetView(ctx) {
  ctx.cam.theta = 0.9; ctx.cam.phi = 0.5; ctx.cam.radius = 6.5;
  ctx.cam.userMoved = true;   // force a redraw even if the scene was settled
  // orbit center re-frames onto the focused machine automatically in step()
}

/* World-space center of the focused machine's slot (origin if none yet). */
function focusPoint(ctx) {
  const sl = ctx.slots && ctx.selected && ctx.slots.get(ctx.selected);
  return sl ? { x: sl.x, y: sl.y, z: sl.z } : { x: 0, y: 0, z: 0 };
}

/* ===================== HUD + readout ===================== */

function paintHud(refs, ctx) {
  const m = ctx.over.get(ctx.selected);
  if (!m) { refs.hud.hidden = true; return; }
  refs.hud.hidden = false;
  const p = m.position || {};
  const cy = m.cycle || {};
  refs.hud.innerHTML = `
    <div class="td-hud-top">
      <span class="td-hud-name">${ctx.selected}</span>
      <span class="td-hud-badge is-live">● LIVE</span>
    </div>
    <div class="td-hud-prog">${esc(m.active_program || "—")}</div>
    <div class="td-hud-grid">
      ${hudCell("status", (m.status || "—"))}
      ${hudCell("exec", (m.execution || "—"))}
      ${hudCell("spindle", m.spindle_speed != null ? Math.round(m.spindle_speed) + " rpm" : "—")}
      ${hudCell("parts", m.part_count != null ? m.part_count : "—")}
      ${hudCell("this cyc", cy.this_cycle != null ? fmtDur(cy.this_cycle) : "—")}
      ${hudCell("last cyc", cy.last_cycle != null ? fmtDur(cy.last_cycle) : "—")}
    </div>
    <div class="td-hud-pos">X ${fixed(p.x)} · Y ${fixed(p.y)} · Z ${fixed(p.z)} · ${(ctx.paths.get(ctx.selected) || []).length} pts</div>`;
}
function hudCell(k, v) { return `<div><span class="td-hud-k">${k}</span><span class="td-hud-v">${esc(String(v))}</span></div>`; }

function paintReadout(refs, ctx) {
  const visible = allVisible(ctx);
  const rows = visible.map((id) => {
    const pts = ctx.paths.get(id) || [];
    const o = ctx.over.get(id) || {};
    const mix = moveMix(pts);
    const span = pts.length > 1 ? (pts[pts.length - 1].t - pts[0].t) / 1000 : 0;
    const sel = id === ctx.selected;
    const noZ = pts.length > 0 && pts.every((p) => p.z == null);
    return `<tr class="${sel ? "is-sel" : ""}">
      <td class="td-ro-name">${id}${sel ? ' <span class="td-ro-focus">focus</span>' : ""}${noZ ? ' <span class="td-ro-flag" title="This machine does not emit a Z axis — path is shown on the Z=0 plane, not fabricated depth.">2.5D · no Z</span>' : ""}</td>
      <td>${esc(o.active_program || "—")}</td>
      <td>${(o.status || "—")}</td>
      <td class="td-ro-n">${pts.length}</td>
      <td class="td-ro-n">${span ? fmtDur(span) : "—"}</td>
      <td class="td-ro-n">${mix.cut}%</td>
      <td class="td-ro-n">${mix.rapid}%</td>
      <td class="td-ro-n">${o.part_count != null ? o.part_count : "—"}</td>
    </tr>`;
  }).join("");
  const src = "Live trail — each vertex is a real controller position from <code>/api/overview</code>, backfilled for the current cycle from <code>*_axis_actual_position</code> history then appended at 1 Hz.";
  refs.readout.innerHTML = `
    <div class="td-ro-h">Toolpath readout <span class="td-ro-sub">${visible.length} machine${visible.length === 1 ? "" : "s"} on stage</span></div>
    <table class="td-ro-table">
      <thead><tr><th>machine</th><th>program</th><th>state</th><th>pts</th><th>span</th><th>cut</th><th>rapid</th><th>parts</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="td-ro-note">${src} Color: <b style="color:#34d6f2">cut</b> feed moves, <b style="color:#fb9e1a">plunge</b> Z-dominant, <b style="color:#9aa3b8">rapid</b> jumps &gt;${RAPID_MM}mm. Overlay machines wear their own tint and sit in their real machine coordinates, laid out side by side.</p>`;
}

function moveMix(pts) {
  let cut = 0, rapid = 0, drill = 0, tot = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i], b = pts[i - 1];
    const az = a.z == null ? 0 : a.z, bz = b.z == null ? 0 : b.z;
    const dx = a.x - b.x, dy = a.y - b.y, dz = az - bz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    tot++;
    if (d > RAPID_MM) rapid++;
    else if (Math.abs(dz) > PLUNGE_RATIO * d && Math.abs(dz) > PLUNGE_MIN) drill++;
    else cut++;
  }
  const pct = (x) => tot ? Math.round((x / tot) * 100) : 0;
  return { cut: pct(cut + drill), rapid: pct(rapid) };
}

/* ===================== small utils ===================== */

function allVisible(ctx) {
  // visibility is driven purely by the enable toggles — including the focused
  // machine, so any machine (focused or not) can be switched off.
  return ctx.machineList.filter((id) => ctx.enabled.has(id));
}
function loadEnabled() {
  try { const a = JSON.parse(localStorage.getItem(LS_EN) || "[]"); return new Set(Array.isArray(a) ? a : []); }
  catch (_) { return new Set(); }
}
function saveEnabled(set) { try { localStorage.setItem(LS_EN, JSON.stringify([...set])); } catch (_) {} }
function rgb(c) { return `rgb(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0})`; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function fixed(v) { return Number.isFinite(v) ? v.toFixed(1) : "—"; }
function fmtDur(s) { s = Math.round(s); const m = Math.floor(s / 60); return m ? `${m}m ${s % 60}s` : `${s}s`; }
