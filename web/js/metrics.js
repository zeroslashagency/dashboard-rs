/* VMC God-mode — shared per-machine metrics.
 *
 * One computation used by Analytics, KPI, and Statistics so the numbers agree
 * everywhere and the cycle/segment math exists in exactly one place. Pure
 * functions over the dataLayer's windowed history. Every value is derived from
 * real polled samples.
 */

import {
  segmentStates, dwellByState, bucketDwell, extractCycles, timeWeightedAvg,
  fractionOff, countEdges, countEdgesBy, isEstopActive, stats, bucketOfState,
} from "./analyticsCore.js";

/* Per-(machine,window) memo so the several views that each call computeMachine
 * in the same refresh tick (KPI scorecard+trends, maintenance health()+predict())
 * fold the windowed history ONCE instead of N times. Keyed by machine+window
 * bounds; short TTL matches the dataLayer history cache so it never goes stale
 * within a refresh but always re-folds on the next cycle. */
const mcCache = new Map(); // key -> { at, promise }
const MC_TTL_MS = 60000; // match dataLayer's 60s window quantum: the window key is stable for a full minute, so fold once/minute and let every 15s refresh in between reuse the memo (no refetch, no refold).
function mcKey(id, win) { return `${id}|${Math.round(win.from)}|${Math.round(win.to)}`; }

export function computeMachine(dataLayer, id, win) {
  const key = mcKey(id, win);
  const hit = mcCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < MC_TTL_MS) return hit.promise;
  const promise = computeMachineUncached(dataLayer, id, win).catch((e) => {
    mcCache.delete(key); // don't cache failures
    throw e;
  });
  mcCache.set(key, { at: now, promise });
  // opportunistic prune so the map can't grow unbounded across windows/machines
  if (mcCache.size > 64) {
    for (const [k, v] of mcCache) if (now - v.at >= MC_TTL_MS) mcCache.delete(k);
  }
  return promise;
}

/* The 8 windowed signals every machine's metric bundle needs. Pulled as ONE
 * bulk request shared across all machines (see below) instead of 8xN ranged
 * calls. */
const MC_ITEMS = ["rstat", "m30c1", "ncprog", "fdovrd", "rovrd", "ssovrd", "estop", "aalarms"];

/* Compute the full metric bundle for one machine over a window. Reads its
 * signals from the shared per-window bulk fetch: historyRangeBulkWindow is
 * SWR-cached + in-flight-coalesced per window, so when every machine's
 * computeMachine awaits it in the same refresh tick they collapse onto a SINGLE
 * /api/history_range_bulk request (all items, all machines) rather than 40
 * separate pulls. Falls back to per-item historyWindow only if a machine is
 * absent from the bulk payload. */
async function computeMachineUncached(dataLayer, id, win) {
  let rstat, m30, ncprog, fd, rv, sv, estop, aalarms;
  let bulk = null;
  if (typeof dataLayer.historyRangeBulkWindow === "function") {
    try { bulk = await dataLayer.historyRangeBulkWindow(MC_ITEMS, win); } catch (_) { bulk = null; }
  }
  const per = bulk && bulk.get ? bulk.get(id) : null;
  if (per) {
    [rstat, m30, ncprog, fd, rv, sv, estop, aalarms] =
      [per.rstat, per.m30c1, per.ncprog, per.fdovrd, per.rovrd, per.ssovrd, per.estop, per.aalarms]
        .map((r) => Array.isArray(r) ? r : []);
  } else {
    [rstat, m30, ncprog, fd, rv, sv, estop, aalarms] = await Promise.all(
      MC_ITEMS.map((it) => dataLayer.historyWindow(id, it, win)));
  }

  const segs = segmentStates(rstat, win);
  const dwell = dwellByState(segs);
  const buckets = bucketDwell(dwell);
  const spanMs = (win.to - win.from) || 1;

  const availDen = buckets.run + buckets.pause + buckets.idle || 1;
  const availability = (buckets.run / availDen) * 100;
  const utilization = (buckets.run / spanMs) * 100;

  const cycles = extractCycles(m30, ncprog, win);
  const cycleDurs = cycles.map((c) => c.dur);
  const cstats = stats(cycleDurs);
  const parts = cycles.length;
  const partRateRun = buckets.run > 0 ? parts / (buckets.run / 3600000) : null;
  const partRateWall = spanMs > 0 ? parts / (spanMs / 3600000) : null;

  let performance = null;
  if (cstats.p10 && buckets.run > 0 && parts > 0) {
    performance = Math.min(100, (cstats.p10 * parts) / buckets.run * 100);
  }
  const oee = (availability != null && performance != null)
    ? (availability / 100) * (performance / 100) * 100 : null;

  const ovr = {
    feed: timeWeightedAvg(fd, win), rapid: timeWeightedAvg(rv, win), spindle: timeWeightedAvg(sv, win),
    feedOff: fractionOff(fd, win), spindleOff: fractionOff(sv, win),
  };

  // e-stop asserts — uses the SAME predicate as the downtime attribution below
  // (isEstopActive) so the assert count and the downtime never disagree.
  const estopEvents = countEdgesBy(estop, isEstopActive);

  // alarm asserts: any transition from "no alarm" text to a real code.
  const alarmActive = (v) => {
    const s = String(v || "").trim().toUpperCase();
    return s && !["NO ACTIVE ALARMS", "NONE", "OK", ""].includes(s);
  };
  const alarmEvents = countEdges(
    aalarms.map((r) => ({ ...r, val: alarmActive(r.val) ? "ALARM" : "OK" })), ["ALARM"]
  );

  const pauseSegs = segs.filter((s) => bucketOfState(s.state) === "pause");
  const qualityProxy = parts > 0 ? Math.max(0, 100 - (pauseSegs.length / parts) * 100) : null;

  // downtime reasons: dwell of non-run states, bucketed by cause.
  const downtime = downtimeByReason(segs, aalarms, estop, win);

  return {
    buckets, availability, utilization, performance, oee,
    parts, partRateRun, partRateWall, cstats, cycles, ovr,
    estopEvents, alarmEvents, qualityProxy, segs, downtime, spanMs,
  };
}

/* Classify non-running dwell into reason buckets for the Pareto. A pause/idle
 * segment overlapping an active alarm is attributed to ALARM; an estop window
 * to E-STOP; otherwise FEED-HOLD (pause states) or IDLE (stopped/ready). */
function downtimeByReason(segs, aalarms, estop, win) {
  const reasons = { ALARM: 0, "E-STOP": 0, "FEED-HOLD": 0, IDLE: 0, OTHER: 0 };
  const alarmActive = (v) => {
    const s = String(v || "").trim().toUpperCase();
    return s && !["NO ACTIVE ALARMS", "NONE", "OK", ""].includes(s);
  };
  const alarmSpans = activeSpans(aalarms, alarmActive, win);
  const estopSpans = activeSpans(estop, isEstopActive, win);

  for (const s of segs) {
    const b = bucketOfState(s.state);
    if (b === "run") continue;
    if (overlaps(s, estopSpans)) reasons["E-STOP"] += s.dur;
    else if (overlaps(s, alarmSpans)) reasons.ALARM += s.dur;
    else if (b === "pause") reasons["FEED-HOLD"] += s.dur;
    else if (b === "idle") reasons.IDLE += s.dur;
    else reasons.OTHER += s.dur;
  }
  return reasons;
}

function activeSpans(rows, isActive, win) {
  const spans = [];
  let start = null;
  for (let i = 0; i < rows.length; i++) {
    const on = isActive(rows[i].val);
    const t = Math.max(rows[i].ts, win.from);
    if (on && start == null) start = t;
    if (!on && start != null) { spans.push([start, t]); start = null; }
  }
  if (start != null) spans.push([start, win.to]);
  return spans;
}

function overlaps(seg, spans) {
  for (const [a, b] of spans) if (seg.from < b && seg.to > a) return true;
  return false;
}
