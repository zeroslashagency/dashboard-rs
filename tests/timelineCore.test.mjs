import test from "node:test";
import assert from "node:assert/strict";

import {
  IST_OFFSET_MS,
  computeCurrentIstShift,
  computeIstDayBoundaries,
  computeShiftBoundaries,
  computeMinimapBins,
  extractLaneGaps,
  partDeviationKind,
  summarizeFleetWindow,
  summarizeLaneWindow,
} from "../web/js/timelineCore.js";

test("computeCurrentIstShift returns exact 8h IST shift boundaries for S1, S2, and S3", () => {
  // 2026-11-26 10:15 IST -> Shift 1 (06:00-14:00 IST)
  const s1Ts = Date.UTC(2026, 10, 26, 10, 15, 0) - IST_OFFSET_MS;
  const s1 = computeCurrentIstShift(s1Ts);
  assert.equal(s1.shift, 1);
  assert.equal(s1.to - s1.from, 8 * 3600e3);

  // 2026-11-26 16:30 IST -> Shift 2 (14:00-22:00 IST)
  const s2Ts = Date.UTC(2026, 10, 26, 16, 30, 0) - IST_OFFSET_MS;
  const s2 = computeCurrentIstShift(s2Ts);
  assert.equal(s2.shift, 2);

  // 2026-11-26 02:15 IST -> Shift 3 starting previous day 22:00 IST
  const s3Ts = Date.UTC(2026, 10, 26, 2, 15, 0) - IST_OFFSET_MS;
  const s3 = computeCurrentIstShift(s3Ts);
  assert.equal(s3.shift, 3);
  assert.ok(s3.from < s3Ts && s3Ts < s3.to);
});

test("computeShiftBoundaries and computeIstDayBoundaries emit exact IST markers", () => {
  const day0 = Date.UTC(2026, 10, 26, 0, 0, 0) - IST_OFFSET_MS;
  const day1 = day0 + 24 * 3600e3;
  const shifts = computeShiftBoundaries(day0, day1);
  assert.deepEqual(shifts.map((s) => s.code), ["S1", "S2", "S3"]);
  const days = computeIstDayBoundaries(day0 - 1000, day1 + 1000);
  assert.equal(days.length, 2);
});

test("partDeviationKind classifies normal, slow, overrun, short, and partial accurately", () => {
  assert.equal(partDeviationKind({ dev: 1.04 }), "normal");
  assert.equal(partDeviationKind({ dev: 1.22 }), "high");
  assert.equal(partDeviationKind({ dev: 1.38 }), "over");
  assert.equal(partDeviationKind({ dev: 0.78 }), "low");
  assert.equal(partDeviationKind({ partial: true, dev: 1.5 }), "partial");
  assert.equal(partDeviationKind({ dev: null }), "neutral");
});

test("extractLaneGaps merges adjacent identical gaps, attaches events, and matches saved downtime logs", () => {
  const t0 = 1_700_000_000_000;
  const bands = [
    { t0, t1: t0 + 600e3, status: "running" },
    { t0: t0 + 600e3, t1: t0 + 900e3, status: "idle" },
    { t0: t0 + 905e3, t1: t0 + 1200e3, status: "idle" }, // within 10s -> merges
    { t0: t0 + 1200e3, t1: t0 + 1500e3, status: "alarm" },
  ];
  const downtimeLogs = [
    { id: "dt1", machineId: "VMC-02", reason: "Waiting for Material", startTs: t0 + 610e3, durationMin: 10 },
  ];
  const events = [
    { machine: "VMC-02", ts: t0 + 1250e3, sev: "CRITICAL", rule: "estop", msg: "E-Stop" },
  ];

  const gaps = extractLaneGaps("VMC-02", bands, [], t0, t0 + 1800e3, downtimeLogs, events);
  assert.equal(gaps.length, 2);
  assert.equal(gaps[0].status, "idle");
  assert.equal(gaps[0].durMs, 600e3);
  assert.equal(gaps[0].logged?.reason, "Waiting for Material");
  assert.equal(gaps[1].status, "alarm");
  assert.equal(gaps[1].events.length, 1);
  assert.equal(gaps[1].logged, null);
});

test("summarizeLaneWindow, summarizeFleetWindow, and computeMinimapBins aggregate cleanly", () => {
  const t0 = 1_700_000_000_000;
  const t1 = t0 + 3600e3;
  const lane1Bands = [
    { t0, t1: t0 + 2700e3, status: "running" },
    { t0: t0 + 2700e3, t1, status: "idle" },
  ];
  const lane1Parts = [
    { t0, t1: t0 + 1300e3, dur: 1300e3, dev: 1.0, partial: false },
    { t0: t0 + 1350e3, t1: t0 + 2700e3, dur: 1350e3, dev: 1.2, partial: false },
  ];

  const sum1 = summarizeLaneWindow(lane1Parts, lane1Bands, t0, t1);
  assert.equal(sum1.utilPct, 75);
  assert.equal(sum1.partCount, 2);
  assert.equal(sum1.slowCount, 1);

  const laneMap = new Map([["VMC-01", sum1]]);
  const ovMap = new Map([["VMC-01", { online: true, status: "running" }]]);
  const evMap = new Map([["VMC-01", [{ ts: t0 + 2800e3, rule: "feed_hold" }]]]);
  const fleet = summarizeFleetWindow(laneMap, ovMap, evMap, [], t0, t1);
  assert.equal(fleet.fleetUtilPct, 75);
  assert.equal(fleet.totalParts, 2);
  assert.equal(fleet.runningNow, 1);
  assert.equal(fleet.incidentCount, 1);

  const bins = computeMinimapBins([{ bands: lane1Bands }], t0, t1, 16);
  assert.equal(bins.length, 16);
  assert.ok(bins[0].runFrac > 0.9);
  assert.ok(bins[15].lossFrac > 0.9);
});
