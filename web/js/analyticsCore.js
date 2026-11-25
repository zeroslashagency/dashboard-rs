/* VMC God-mode — shared analytics primitives.
 *
 * Pure functions over the dataLayer's windowed history rows. These are the
 * linchpins reused by both the Analytical and Plan sections, so they are written
 * once and correctly:
 *
 *   - segmentStates: turn a discrete-event series (rstat, estop, mode) into
 *     [{state,from,to,dur}] intervals clipped to a window. Gapless history makes
 *     this exact — each row is a real transition, dwell = next.ts - this.ts.
 *   - extractCycles: reconstruct per-part cycle times from the M30 counter
 *     (m30c1) deltas, the basis for part-rate, OEE-performance, ETA, drift.
 *   - timeWeightedAvg / stats / ewma: the small stats toolkit.
 *
 * Every value here derives from a REAL polled sample. Nothing is invented.
 */

/* ---------- discrete-state segmentation ----------
 * rows: ascending [{ts, val, num}]; the first row may be a carried anchor at
 * win.from. Returns intervals each carrying its dwell in ms, the last one
 * extended to win.to (the state is still in effect at "now"). */
export function segmentStates(rows, win) {
  const segs = [];
  if (!rows || !rows.length) return segs;
  for (let i = 0; i < rows.length; i++) {
    const from = Math.max(rows[i].ts, win.from);
    const to = i + 1 < rows.length ? rows[i + 1].ts : win.to;
    if (to <= from) continue;
    segs.push({ state: rows[i].val, from, to, dur: to - from });
  }
  return segs;
}

/* Sum dwell per distinct state value over a segment list -> { STATE: ms }. */
export function dwellByState(segs) {
  const out = {};
  for (const s of segs) out[s.state] = (out[s.state] || 0) + s.dur;
  return out;
}

/* ---------- cycle extraction ----------
 * counterRows: ascending m30c1 samples [{ts, num}]. Each increase of the M30
 * counter is a finished part; the cycle time is the wall-clock gap between
 * consecutive increments. A counter DROP is an operator reset — we break the
 * chain there (no negative cycles). Optionally tag each cycle with the active
 * program at its completion using a program timeline.
 *
 * Returns [{ end, dur, program }] where dur is the cycle time in ms. */
export function extractCycles(counterRows, programRows = null, win = null) {
  const cycles = [];
  if (!counterRows || counterRows.length < 2) return cycles;

  const progAt = programTimelineResolver(programRows);
  let prev = null;
  for (const r of counterRows) {
    const v = Number(r.num);
    if (!Number.isFinite(v)) continue;
    if (prev == null) { prev = { v, ts: r.ts }; continue; }
    if (v > prev.v) {
      const span = r.ts - prev.ts;
      const parts = v - prev.v;
      // If several parts landed between samples, split the span evenly so the
      // distribution isn't skewed by a coarse poll. Usually parts === 1.
      const per = span / parts;
      for (let k = 0; k < parts; k++) {
        const end = prev.ts + per * (k + 1);
        if (win && (end < win.from || end > win.to)) continue;
        if (per > 0 && per < 24 * 3600000) {
          cycles.push({ end, dur: per, program: progAt ? progAt(end) : null });
        }
      }
    }
    // on rise or reset, advance the baseline
    prev = { v, ts: r.ts };
  }
  return cycles;
}

/* Build a fn(ts) -> program-name from a program timeline (ncprog history). */
function programTimelineResolver(programRows) {
  if (!programRows || !programRows.length) return null;
  const tl = programRows
    .filter((r) => r.val)
    .map((r) => ({ ts: r.ts, name: r.val }))
    .sort((a, b) => a.ts - b.ts);
  if (!tl.length) return null;
  return (ts) => {
    let name = tl[0].name;
    for (const e of tl) { if (e.ts <= ts) name = e.name; else break; }
    return name;
  };
}

/* ---------- numeric-series segmentation ----------
 * For a numeric item (override, spindle): time-weighted average over a window,
 * using each sample's value until the next sample (step interpolation — these
 * are setpoints/readings held until changed). */
export function timeWeightedAvg(rows, win) {
  if (!rows || !rows.length) return null;
  let num = 0, den = 0;
  for (let i = 0; i < rows.length; i++) {
    const v = Number(rows[i].num);
    if (!Number.isFinite(v)) continue;
    const from = Math.max(rows[i].ts, win.from);
    const to = i + 1 < rows.length ? rows[i + 1].ts : win.to;
    const dur = to - from;
    if (dur <= 0) continue;
    num += v * dur;
    den += dur;
  }
  return den > 0 ? num / den : null;
}

/* Fraction of windowed time a numeric series spent off a nominal value. */
export function fractionOff(rows, win, nominal = 100) {
  if (!rows || !rows.length) return 0;
  let off = 0, total = 0;
  for (let i = 0; i < rows.length; i++) {
    const v = Number(rows[i].num);
    const from = Math.max(rows[i].ts, win.from);
    const to = i + 1 < rows.length ? rows[i + 1].ts : win.to;
    const dur = to - from;
    if (dur <= 0) continue;
    total += dur;
    if (Number.isFinite(v) && Math.round(v) !== nominal) off += dur;
  }
  return total > 0 ? off / total : 0;
}

/* ---------- edge detection ----------
 * Count rising edges where a series enters one of `activeVals` from outside it.
 * Used for estop asserts and alarm asserts. Returns {count, events:[{ts}]}. */
export function countEdges(rows, activeVals) {
  const active = new Set(activeVals.map((s) => String(s).toUpperCase()));
  return countEdgesBy(rows, (v) => active.has(String(v || "").toUpperCase()));
}

/* Same as countEdges but driven by a predicate, so the "active" definition can
 * match exactly how the same signal's downtime spans are computed elsewhere. */
export function countEdgesBy(rows, isActive) {
  let count = 0, wasActive = false;
  const events = [];
  for (const r of rows) {
    const on = !!isActive(r.val);
    if (on && !wasActive) { count += 1; events.push({ ts: r.ts }); }
    wasActive = on;
  }
  return { count, events };
}

/* The single source of truth for "is the e-stop engaged?": any state that is
 * present and not the armed/ready state. Used for BOTH the assert count and the
 * downtime attribution so MTBF/MTTR and downtime never disagree. */
export function isEstopActive(v) {
  const s = String(v || "").trim().toUpperCase();
  return !!s && s !== "ARMED";
}

/* ---------- small stats toolkit ---------- */
export function stats(values) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = xs.length;
  if (!n) return { n: 0, mean: null, median: null, p10: null, p90: null, min: null, max: null, sd: null };
  const q = (p) => {
    const idx = (n - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? xs[lo] : xs[lo] + (xs[hi] - xs[lo]) * (idx - lo);
  };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { n, mean, median: q(0.5), p10: q(0.1), p90: q(0.9), min: xs[0], max: xs[n - 1], sd };
}

/* Exponentially-weighted moving average — the smoothing for live cycle-rate. */
export function ewma(values, alpha = 0.3) {
  let acc = null;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    acc = acc == null ? v : alpha * v + (1 - alpha) * acc;
  }
  return acc;
}

/* Theil-Sen slope (robust trend) in units per ms — for cycle-time drift.
 * Returns slope or null; multiply by 3600000 for units/hour.
 *
 * Theil-Sen is O(n²) in the number of points (all pairwise slopes). On a 7-day
 * window a machine can have thousands of cycles, which would be millions of
 * pairs on the main thread every refresh. So when there are more than CAP
 * points we evenly DOWN-SAMPLE to CAP first: the median-of-slopes is robust to
 * uniform thinning, so the trend is unchanged while the cost stays bounded. */
const THEIL_SEN_CAP = 400;
export function theilSen(points) {
  let pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const n0 = pts.length;
  if (n0 < 3) return null;
  if (n0 > THEIL_SEN_CAP) {
    const step = n0 / THEIL_SEN_CAP;
    const sampled = [];
    for (let i = 0; i < THEIL_SEN_CAP; i++) sampled.push(pts[Math.floor(i * step)]);
    pts = sampled;
  }
  const n = pts.length;
  const slopes = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const dx = pts[j].x - pts[i].x;
      if (dx !== 0) slopes.push((pts[j].y - pts[i].y) / dx);
    }
  if (!slopes.length) return null;
  slopes.sort((a, b) => a - b);
  const m = slopes.length;
  return m % 2 ? slopes[(m - 1) / 2] : (slopes[m / 2 - 1] + slopes[m / 2]) / 2;
}

/* ---------- state vocab ----------
 * Map raw MTConnect execution (rstat) into the buckets the dashboard reasons in.
 * Mirrors deriveStatus in app.js so the new sections agree with the cards. */
export const RUN_STATES = new Set(["ACTIVE", "EXECUTING", "RUNNING"]);
export const PAUSE_STATES = new Set(["FEED_HOLD", "INTERRUPTED", "PROGRAM_STOPPED", "OPTIONAL_STOP", "HELD"]);
export const IDLE_STATES = new Set(["STOPPED", "READY", "PROGRAM_COMPLETED", "WAIT"]);

export function bucketOfState(raw) {
  const s = String(raw || "").toUpperCase();
  if (RUN_STATES.has(s)) return "run";
  if (PAUSE_STATES.has(s)) return "pause";
  if (IDLE_STATES.has(s)) return "idle";
  return "other";
}

/* Roll a dwell-by-rstat map up into run/pause/idle/other ms buckets. */
export function bucketDwell(dwell) {
  const out = { run: 0, pause: 0, idle: 0, other: 0 };
  for (const [state, ms] of Object.entries(dwell)) out[bucketOfState(state)] += ms;
  return out;
}
