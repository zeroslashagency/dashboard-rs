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

  const bands = [
    { t0, t1: t0 + 1000e3, status: "running" },
    { t0: t0 + 1000e3, t1: t0 + 1100e3, status: "idle" },
    { t0: t0 + 1100e3, t1: t0 + 2150e3, status: "running" },
    { t0: t0 + 2150e3, t1: t0 + 2400e3, status: "paused" },
    { t0: t0 + 2400e3, t1: t0 + 3600e3, status: "running" },
    { t0: t0 + 3600e3, t1: t0 + 3800e3, status: "paused" },
  ];

  const fullNc = buildFullNcReport({ group, groupParts: parts, bands, events });
  assert.equal(fullNc.programName, "HSG_402");
  assert.equal(fullNc.totalJobs, 3);
  assert.equal(fullNc.qualityCounts.normal, 2);
  assert.equal(fullNc.qualityCounts.over, 1);
  assert.equal(fullNc.meter.segs.length, 24);
  assert.equal(fullNc.jobRows.length, 3);
  assert.equal(fullNc.jobRows[0].job, 3); // newest first
  assert.ok(fullNc.miniStrip.some((b) => b.kind === "gap" && b.statusKind === "paused"));
  assert.ok(fullNc.miniStrip.some((b) => b.kind === "part" && b.label === "#3" && b.devPct === 40));
  assert.equal(fullNc.miniPins.length, 1);
  assert.equal(fullNc.incidents.length, 1);
  assert.equal(fullNc.stateBreakdown.hasData, true);
  assert.equal(fullNc.stateBreakdown.holdsCount, 2);
  assert.equal(fullNc.stateBreakdown.idleMs, 100e3);

  const singleOver = buildSingleJobReport({ part: parts[2], fullNc, bands, events, overview: { overrides: { feed: 90, rapid: 100, spindle: 100 }, tool_id: "T11" } });
  assert.equal(singleOver.statusKind, "over");
  assert.equal(singleOver.devPct, 40);
  assert.equal(singleOver.preGapMs, 250e3);
  assert.equal(singleOver.radar.length, 5);
  assert.equal(singleOver.badge.tone, "danger");
  assert.ok(singleOver.radar.find((a) => a.label === "Pace").job < 80);
  assert.equal(singleOver.stateBreakdown.holdMs, 200e3);
  assert.equal(singleOver.stateBreakdown.cutMs, 1200e3);
  assert.equal(singleOver.rapidOvrd, 100);

  const singleNom = buildSingleJobReport({ part: parts[0], fullNc, bands, events, overview: { overrides: { feed: 100 } } });
  assert.equal(singleNom.statusKind, "normal");
  assert.equal(singleNom.badge.tone, "success");
  assert.ok(singleNom.radar.find((a) => a.label === "Pace").job >= 90);
  assert.equal(singleNom.stateBreakdown.cutSharePct, 100);

  const meter = computeSegmentedMeter(50, "success", 24);
  assert.equal(meter.filled, 12);
  assert.equal(meter.segs.filter((s) => s.active).length, 12);
});

import {
  buildShiftSummaryReport,
  enumerateWindowDays,
  enumerateWindowShifts,
  getAdjacentShift,
} from "../web/js/timelineCore.js";

test("enumerateWindowShifts and getAdjacentShift emit exact IST shift columns across 4h and 24h windows", () => {
  // 2026-11-26 17:00 IST (inside Shift 2: 14:00-22:00)
  const nowMs = Date.UTC(2026, 10, 26, 17, 0, 0) - IST_OFFSET_MS;

  // 24h window ending at now + 8% right pad
  const span24 = 24 * 3600e3;
  const winT1 = nowMs + span24 * 0.08;
  const winT0 = winT1 - span24;
  const shifts24 = enumerateWindowShifts(winT0, winT1, nowMs);
  assert.ok(shifts24.length >= 3 && shifts24.length <= 4);
  const sumWidth = shifts24.reduce((acc, s) => acc + s.widthPct, 0);
  assert.ok(Math.abs(sumWidth - 100) < 0.5);
  const liveShift = shifts24.find((s) => s.isLive);
  assert.equal(liveShift?.code, "S2");

  // Stepping back from S2 gives S1 (06-14) same day
  const prev = getAdjacentShift(liveShift, -1, nowMs);
  assert.equal(prev?.code, "S1");
  assert.equal(prev.t1, liveShift.t0);

  // Stepping forward from live S2 is blocked (future)
  const nextFuture = getAdjacentShift(liveShift, 1, nowMs);
  assert.equal(nextFuture, null);

  // Stepping forward from S1 returns S2
  const backToS2 = getAdjacentShift(prev, 1, nowMs);
  assert.equal(backToS2?.code, "S2");

  // 7-day window day enumeration
  const days = enumerateWindowDays(nowMs - 6 * 86400e3, nowMs + 3600e3, nowMs);
  assert.ok(days.length >= 7);
});

test("buildShiftSummaryReport clips lanes, parts, programs, incidents, and downtime accurately to one IST shift", () => {
  const s1Start = Date.UTC(2026, 10, 26, 6, 0, 0) - IST_OFFSET_MS;
  const s1End = s1Start + 8 * 3600e3;
  const nowMs = s1End + 3600e3; // Shift 1 is complete
  const shift = enumerateWindowShifts(s1Start, s1End, nowMs)[0];

  const lanes = [
    {
      id: "VMC-01",
      name: "VMC-01",
      bands: [
        { t0: s1Start - 3600e3, t1: s1Start, status: "idle" }, // outside shift -> must not leak!
        { t0: s1Start, t1: s1Start + 6 * 3600e3, status: "running" },
        { t0: s1Start + 6 * 3600e3, t1: s1End, status: "idle" },
      ],
      parts: [
        { program: "BRKT_101.NC", job: 1, t0: s1Start + 60e3, t1: s1Start + 1860e3, dur: 1800e3, dev: 1.02, partial: false },
        { program: "BRKT_101.NC", job: 2, t0: s1Start + 2000e3, t1: s1Start + 3800e3, dur: 1800e3, dev: 1.0, partial: false },
        { program: "OUTSIDE.NC", job: 99, t0: s1End + 60e3, t1: s1End + 900e3, dur: 840e3, dev: 1.0, partial: false },
      ],
    },
    {
      id: "VMC-02",
      name: "VMC-02",
      bands: [
        { t0: s1Start, t1: s1Start + 4 * 3600e3, status: "running" },
        { t0: s1Start + 4 * 3600e3, t1: s1Start + 5 * 3600e3, status: "alarm" },
        { t0: s1Start + 5 * 3600e3, t1: s1End, status: "paused" },
      ],
      parts: [
        { program: "HSG_500.NC", job: 10, t0: s1Start + 300e3, t1: s1Start + 2100e3, dur: 1800e3, dev: 1.38, partial: false },
      ],
    },
  ];
  const eventsMap = new Map([
    ["VMC-02", [{ machine: "VMC-02", ts: s1Start + 4 * 3600e3 + 60e3, sev: "CRITICAL", rule: "estop", msg: "E-Stop pressed" }]],
  ]);
  const overviewMap = new Map([
    ["VMC-01", { spindle_speed: 8400, overrides: { feed: 100, rapid: 100, spindle: 100 } }],
    ["VMC-02", { spindle_speed: 6200, overrides: { feed: 88, rapid: 100, spindle: 100 } }],
  ]);
  const downtimeLogs = [
    { id: "d1", machineId: "VMC-02", reason: "Tool Breakage", startTs: s1Start + 4 * 3600e3, durationMin: 60 },
  ];

  const report = buildShiftSummaryReport({ shift, lanes, eventsMap, overviewMap, downtimeLogs, nowMs });
  // Total active time = 16h (8h * 2 machines); cutting = 6h + 4h = 10h -> 62.5% -> 63%
  assert.equal(report.utilPct, 63);
  assert.equal(report.cutSharePct, 62.5);
  assert.equal(report.nonCutSharePct, 37.5);
  assert.equal(report.totalParts, 3);
  assert.equal(report.bestCycleMs, 1800e3);
  assert.equal(report.maxCycleMs, 1800e3);
  assert.equal(report.holdsCount, 1);
  assert.equal(report.estopsCount, 1);
  assert.equal(report.avgRpm, 7300);
  assert.equal(report.peakRpm, 8400);
  assert.equal(report.avgFeedOvr, 94);
  assert.equal(report.machines.length, 2);
  assert.equal(report.machines[0].id, "VMC-01"); // 75% ranked above 50%
  assert.equal(report.machines[0].utilPct, 75);
  assert.equal(report.machines[1].utilPct, 50);
  assert.equal(report.programs.length, 2);
  assert.equal(report.programs[0].name, "BRKT_101");
  assert.equal(report.programs[0].parts, 2);
  assert.equal(report.incidents.length, 1);
  assert.equal(report.loggedDowntime.length, 1);
  assert.equal(report.qualityCounts.normal, 2);
  assert.equal(report.qualityCounts.over, 1);
  assert.equal(report.meter.segs.length, 24);
});


