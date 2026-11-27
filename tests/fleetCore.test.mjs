import test from "node:test";
import assert from "node:assert/strict";

import {
  segmentStates,
  dwellByState,
  bucketDwell,
  extractCycles,
  stats,
  theilSen,
  countEdgesBy,
  isEstopActive,
} from "../web/js/analyticsCore.js";

import {
  groupCyclesByProgram,
  buildProgramMatrix,
  groupCyclesByShift,
  computeHistogramBins,
  summarizeDowntimeAccountability,
  computeReliabilityComparison,
  computeProductionProgress,
} from "../web/js/fleetCore.js";

const HOUR = 3600000;
const MIN = 60000;

test("extractCycles reconstructs part durations, handles counter resets, and tags NC programs", () => {
  const t0 = Date.UTC(2026, 4, 1, 6, 0, 0);
  const m30 = [
    { ts: t0, num: 10 },
    { ts: t0 + 20 * MIN, num: 11 }, // 20m cycle (Prog A)
    { ts: t0 + 42 * MIN, num: 12 }, // 22m cycle (Prog A)
    { ts: t0 + 45 * MIN, num: 0 },  // operator counter reset -> break chain
    { ts: t0 + 75 * MIN, num: 1 },  // 30m cycle (Prog B)
    { ts: t0 + 135 * MIN, num: 3 }, // 2 parts in 60m -> two 30m cycles (Prog B)
  ];
  const progs = [
    { ts: t0 - 5 * MIN, val: "OP1_ROUGH.NC" },
    { ts: t0 + 44 * MIN, val: "OP2_FINISH.NC" },
  ];
  const win = { from: t0, to: t0 + 3 * HOUR };
  const cycles = extractCycles(m30, progs, win);

  assert.equal(cycles.length, 5);
  assert.equal(cycles[0].program, "OP1_ROUGH.NC");
  assert.equal(cycles[0].dur, 20 * MIN);
  assert.equal(cycles[1].dur, 22 * MIN);
  assert.equal(cycles[2].program, "OP2_FINISH.NC");
  assert.equal(cycles[2].dur, 30 * MIN);
  assert.equal(cycles[3].dur, 30 * MIN);
  assert.equal(cycles[4].dur, 30 * MIN);
});

test("stats computes accurate median, p10, p90, mean, and standard deviation", () => {
  const s = stats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.equal(s.n, 10);
  assert.equal(s.mean, 55);
  assert.equal(s.median, 55);
  assert.equal(s.min, 10);
  assert.equal(s.max, 100);
  assert.ok(Math.abs(s.p10 - 19) < 0.01);
  assert.ok(Math.abs(s.p90 - 91) < 0.01);
  assert.ok(s.sd > 28 && s.sd < 29);
});

test("theilSen regression resists single extreme outlier while detecting true upward drift", () => {
  const t0 = 1_700_000_000_000;
  // +10s per hour true slope, with one giant 10-hour spike outlier
  const pts = [
    { x: t0 + 0 * HOUR, y: 100_000 },
    { x: t0 + 1 * HOUR, y: 110_000 },
    { x: t0 + 2 * HOUR, y: 9_999_999 }, // outlier
    { x: t0 + 3 * HOUR, y: 130_000 },
    { x: t0 + 4 * HOUR, y: 140_000 },
    { x: t0 + 5 * HOUR, y: 150_000 },
  ];
  const slope = theilSen(pts);
  const secPerHour = (slope * HOUR) / 1000;
  assert.ok(Math.abs(secPerHour - 10) < 0.5, `expected ~10s/hr, got ${secPerHour}`);
});

test("segmentStates and bucketDwell partition window cleanly and count E-Stop rising edges", () => {
  const t0 = 1_700_000_000_000;
  const win = { from: t0, to: t0 + 60 * MIN };
  const rows = [
    { ts: t0, val: "ACTIVE" },
    { ts: t0 + 30 * MIN, val: "FEED_HOLD" },
    { ts: t0 + 40 * MIN, val: "STOPPED" },
    { ts: t0 + 55 * MIN, val: "UNAVAILABLE" },
  ];
  const segs = segmentStates(rows, win);
  const buckets = bucketDwell(dwellByState(segs));
  assert.equal(buckets.run, 30 * MIN);
  assert.equal(buckets.pause, 10 * MIN);
  assert.equal(buckets.idle, 15 * MIN);
  assert.equal(buckets.other, 5 * MIN);

  const es = countEdgesBy(
    [
      { ts: t0, val: "ARMED" },
      { ts: t0 + 5 * MIN, val: "TRIGGERED" },
      { ts: t0 + 6 * MIN, val: "TRIGGERED" },
      { ts: t0 + 8 * MIN, val: "ARMED" },
      { ts: t0 + 20 * MIN, val: "TRIGGERED" },
    ],
    isEstopActive
  );
  assert.equal(es.count, 2);
});

test("groupCyclesByProgram and buildProgramMatrix compare identical NC programs across machines fairly", () => {
  const t0 = Date.UTC(2026, 4, 1, 8, 0, 0);
  const vmc01 = [
    { end: t0 + 1 * HOUR, dur: 20 * MIN, program: "PART_A.NC" },
    { end: t0 + 2 * HOUR, dur: 21 * MIN, program: "PART_A.NC" },
    { end: t0 + 3 * HOUR, dur: 22 * MIN, program: "PART_A.NC" },
  ];
  const vmc02 = [
    { end: t0 + 1 * HOUR, dur: 24 * MIN, program: "PART_A.NC" },
    { end: t0 + 2 * HOUR, dur: 25 * MIN, program: "PART_A.NC" },
    { end: t0 + 3 * HOUR, dur: 26 * MIN, program: "PART_A.NC" },
    { end: t0 + 4 * HOUR, dur: 40 * MIN, program: "PART_B.NC" },
  ];

  const grouped = groupCyclesByProgram([...vmc01, ...vmc02]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].program, "PART_A.NC");
  assert.equal(grouped[0].count, 6);

  const matrix = buildProgramMatrix([
    { id: "VMC-01", cycles: vmc01 },
    { id: "VMC-02", cycles: vmc02 },
  ]);
  const progA = matrix.find((p) => p.program === "PART_A.NC");
  assert.equal(progA.machineCount, 2);
  assert.equal(progA.machines[0].machineId, "VMC-01");
  assert.equal(progA.machines[0].vsFastestPct, 0);
  assert.equal(progA.machines[1].machineId, "VMC-02");
  // VMC-02 median 25m vs VMC-01 median 21m -> ~19.05% slower
  assert.ok(Math.abs(progA.machines[1].vsFastestPct - ((25 - 21) / 21) * 100) < 0.05);
});

test("groupCyclesByShift and computeHistogramBins bucket shifts and cycle distributions cleanly", () => {
  const mkLocal = (hour) => new Date(2026, 4, 1, hour, 30, 0).getTime();
  const cycles = [
    { end: mkLocal(8), dur: 1200_000 },
    { end: mkLocal(10), dur: 1260_000 },
    { end: mkLocal(16), dur: 1500_000 },
    { end: mkLocal(23), dur: 1400_000 },
  ];
  const shifts = groupCyclesByShift(cycles);
  assert.equal(shifts[0].count, 2); // Shift 1 (06-14)
  assert.equal(shifts[1].count, 1); // Shift 2 (14-22)
  assert.equal(shifts[2].count, 1); // Shift 3 (22-06)

  const hist = computeHistogramBins([100, 110, 120, 130, 140, 150, 160, 170]);
  assert.ok(hist.bins.length >= 6);
  const sum = hist.bins.reduce((a, b) => a + b.count, 0);
  assert.equal(sum, 8);
});

test("summarizeDowntimeAccountability builds plain-English loss chains from recorded logs without guessing", () => {
  const t0 = Date.UTC(2026, 4, 1, 6, 0, 0);
  const win = { from: t0, to: t0 + 8 * HOUR };
  const rawDowntime = { ALARM: 0, "E-STOP": 0, "FEED-HOLD": 0, IDLE: 145 * MIN, OTHER: 0 };
  const logs = [
    { machineId: "VMC-06", reason: "Waiting for Material", durationMin: 60, startTs: t0 + 1 * HOUR },
    { machineId: "VMC-06", reason: "Operator Delay", durationMin: 45, startTs: t0 + 3 * HOUR },
    { machineId: "VMC-06", reason: "Setup", durationMin: 40, startTs: t0 + 5 * HOUR },
  ];
  const acc = summarizeDowntimeAccountability("VMC-06", rawDowntime, logs, win);
  assert.equal(acc.accountedPct, 100);
  assert.equal(acc.unattributedMs, 0);
  assert.match(acc.narrative, /2h 25m lost → 1h waiting for material → 45m operator delay → 40m setup/);

  // Without logs, stays explicitly unattributed
  const unlogged = summarizeDowntimeAccountability("VMC-06", rawDowntime, [], win);
  assert.equal(unlogged.accountedPct, 0);
  assert.match(unlogged.narrative, /unattributed/i);
});

test("computeReliabilityComparison separates Alarm/E-Stop proxy from Verified repair MTBF/MTTR", () => {
  const t0 = Date.UTC(2026, 4, 1, 6, 0, 0);
  const win = { from: t0, to: t0 + 12 * HOUR };
  const runMs = 10 * HOUR;
  const repairs = [
    {
      machineId: "VMC-02",
      faultTitle: "Coolant pump seal leak",
      downtimeMin: 90,
      repairMin: 60,
      status: "resolved",
      startedAt: t0 + 2 * HOUR,
    },
    {
      machineId: "VMC-02",
      faultTitle: "ATC sensor",
      downtimeMin: 30,
      repairMin: 20,
      status: "resolved",
      startedAt: t0 + 6 * HOUR,
    },
  ];
  const rel = computeReliabilityComparison(
    runMs,
    { count: 4 },
    { count: 1 },
    { ALARM: 40 * MIN, "E-STOP": 10 * MIN },
    repairs,
    win
  );

  // Proxy: 5 alarm+estop asserts across 10h run -> 2h MTBF, 50m / 5 = 10m MTTR
  assert.equal(rel.proxy.failures, 5);
  assert.equal(rel.proxy.mtbfMs, 2 * HOUR);
  assert.equal(rel.proxy.mttrMs, 10 * MIN);

  // Verified: 2 logged breakdowns across 10h run -> 5h MTBF, (60+20)/2 = 40m MTTR
  assert.equal(rel.verified.breakdowns, 2);
  assert.equal(rel.verified.mtbfMs, 5 * HOUR);
  assert.equal(rel.verified.mttrMs, 40 * MIN);
});

test("computeProductionProgress computes target achievement, remaining parts, and pace status", () => {
  const t0 = Date.UTC(2026, 4, 1, 6, 0, 0);
  const win = { from: t0, to: t0 + 4 * HOUR }; // half of 8h shift
  const prog = computeProductionProgress(
    { parts: 20, partRateRun: 6, partRateWall: 5 },
    { shiftTargetParts: 32, targetPartsPerHour: 4, activeJob: "JOB-1", operator: "A. Rao" },
    win
  );
  assert.equal(prog.parts, 20);
  assert.equal(prog.targetParts, 32);
  assert.equal(prog.remainingParts, 12);
  assert.equal(prog.pctTarget, 62.5);
  assert.equal(prog.status, "on-track"); // 20 >= 16*0.95
  assert.ok(prog.etaMs > Date.now());
});
