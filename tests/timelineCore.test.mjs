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

import {
  buildFullNcReport,
  buildSingleJobReport,
  computeSegmentedMeter,
  resolveNcContext,
} from "../web/js/timelineCore.js";

test("resolveNcContext links Single Job clicks and Full NC clicks seamlessly", () => {
  const t0 = 1_700_000_000_000;
  const parts = [
    { groupId: "g1", program: "LH_028_1ST_OP.NC", job: 101, t0, t1: t0 + 1200e3, dur: 1200e3, baseline: 1200, dev: 1.0, partial: false },
    { groupId: "g1", program: "LH_028_1ST_OP.NC", job: 102, t0: t0 + 1300e3, t1: t0 + 2980e3, dur: 1680e3, baseline: 1200, dev: 1.4, partial: false },
  ];
  const groups = [
    { groupId: "g1", program: "LH_028_1ST_OP.NC", t0, t1: t0 + 2980e3, count: 2, baseline: 1200 },
  ];
  const lane = { id: "VMC-03", parts, groups, bands: [] };

  const fromPart = resolveNcContext(lane, { type: "part", data: parts[1] });
  assert.equal(fromPart.defaultTab, "job");
  assert.equal(fromPart.group.groupId, "g1");
  assert.equal(fromPart.groupParts.length, 2);
  assert.equal(fromPart.selectedPart.job, 102);

  const fromGroup = resolveNcContext(lane, { type: "group", data: groups[0] });
  assert.equal(fromGroup.defaultTab, "nc");
  assert.equal(fromGroup.selectedPart.job, 102);
});

test("buildFullNcReport and buildSingleJobReport compute accurate meters, mini-strip, and 5-axis radar", () => {
  const t0 = 1_700_000_000_000;
  const parts = [
    { groupId: "g1", program: "HSG_402.NC", job: 1, t0, t1: t0 + 1000e3, dur: 1000e3, baseline: 1000, dev: 1.0, partial: false },
    { groupId: "g1", program: "HSG_402.NC", job: 2, t0: t0 + 1100e3, t1: t0 + 2150e3, dur: 1050e3, baseline: 1000, dev: 1.05, partial: false },
    { groupId: "g1", program: "HSG_402.NC", job: 3, t0: t0 + 2400e3, t1: t0 + 3800e3, dur: 1400e3, baseline: 1000, dev: 1.4, partial: false },
  ];
  const group = { groupId: "g1", program: "HSG_402.NC", t0, t1: t0 + 3800e3, count: 3, baseline: 1000 };
  const events = [
    { machine: "VMC-08", ts: t0 + 2900e3, sev: "WARNING", rule: "feed_hold", msg: "Feed hold dipped to 70%" },
  ];

  const fullNc = buildFullNcReport({ group, groupParts: parts, bands: [], events });
  assert.equal(fullNc.programName, "HSG_402");
  assert.equal(fullNc.totalJobs, 3);
  assert.equal(fullNc.qualityCounts.normal, 2);
  assert.equal(fullNc.qualityCounts.over, 1);
  assert.equal(fullNc.meter.segs.length, 24);
  assert.equal(fullNc.jobRows.length, 3);
  assert.equal(fullNc.jobRows[0].job, 3); // newest first
  assert.ok(fullNc.miniStrip.some((b) => b.kind === "gap"));
  assert.equal(fullNc.incidents.length, 1);

  const singleOver = buildSingleJobReport({ part: parts[2], fullNc, events, overview: { overrides: { feed: 90 }, tool_id: "T11" } });
  assert.equal(singleOver.statusKind, "over");
  assert.equal(singleOver.devPct, 40);
  assert.equal(singleOver.preGapMs, 250e3);
  assert.equal(singleOver.radar.length, 5);
  assert.equal(singleOver.badge.tone, "danger");
  assert.ok(singleOver.radar.find((a) => a.label === "Pace").job < 80);

  const singleNom = buildSingleJobReport({ part: parts[0], fullNc, events, overview: { overrides: { feed: 100 } } });
  assert.equal(singleNom.statusKind, "normal");
  assert.equal(singleNom.badge.tone, "success");
  assert.ok(singleNom.radar.find((a) => a.label === "Pace").job >= 90);

  const meter = computeSegmentedMeter(50, "success", 24);
  assert.equal(meter.filled, 12);
  assert.equal(meter.segs.filter((s) => s.active).length, 12);
});

