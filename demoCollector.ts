import express from "express";
import type { Request, Response } from "express";

const US_PER_MS = 1000;
const SHIFT_DURATION_MS = 8 * 3600 * 1000; // 8-hour shifts (06:00 / 14:00 / 22:00 IST)
const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const MAX_ITEMS_PER_QUERY = 25;
const MAX_WINDOW_MS = 14 * 24 * 3600 * 1000;
const MAX_SSE_CLIENTS = 32;

export interface MachineSeed {
  machine_id: string;
  machine_name: string;
  online: boolean;
  state: string;
  status: "running" | "idle" | "paused" | "alarm" | "offline";
  availability: string;
  controller_mode: string;
  execution: string;
  active_program: string;
  prev_programs: string[];
  spindle_target_rpm: number;
  spindle_speed: number | null;
  part_count: number | null;
  target_part_qty?: number;
  overrides: { feed: number | null; rapid: number | null; spindle: number | null };
  alarm_count: number;
  position: { x: number; y: number; z: number } | null;
  cycle_total_s: number | null;
  cycle_elapsed_s: number | null;
  clock_quality: "trusted" | "clock_unset" | "suspect";
  base_age_sec: number;
  observations: number;
  running_ratio: number; // baseline shift running share (0..1)
  shift_parts: number;
  ideal_ms: number;
  tool_id: string;
  diam_wear_mm: number;
  length_wear_mm: number;
  runtime_hours: number;
  spindle_hours: number;
  toggle_demo_idle?: boolean;
}

interface LiveMachine extends MachineSeed {
  spindle_current: number | null;
  part_count_current: number | null;
  cycle_elapsed_current: number | null;
  position_current: { x: number; y: number; z: number } | null;
  shift_running_ms: number;
  shift_stopped_ms: number;
  shift_parts_current: number;
  measured_rows: number;
  observations_current: number;
  last_seen_ms: number;
  machine_ts: number;
  tool_swap_ticks: number;
  phase_angle: number;
  idle_ticks: number;
  recent_parts: Array<{ ts_ms: number; count: number; program: string; dur_s: number }>;
}

const INITIAL_SEEDS: MachineSeed[] = [
  {
    machine_id: "VMC-01",
    machine_name: "VMC-01",
    online: true,
    state: "STREAMING",
    status: "running",
    availability: "AVAILABLE",
    controller_mode: "AUTOMATIC",
    execution: "ACTIVE",
    active_program: "BRK_210_ROUGH_OP1.NC",
    prev_programs: ["BRK_208_FACE_OP1.NC", "BRK_210_ROUGH_OP1.NC"],
    spindle_target_rpm: 6400,
    spindle_speed: 6402.4,
    part_count: 128,
    target_part_qty: 160,
    overrides: { feed: 100, rapid: 100, spindle: 100 },
    alarm_count: 0,
    position: { x: -245.12, y: -148.65, z: -214.3 },
    cycle_total_s: 1140,
    cycle_elapsed_s: 485,
    clock_quality: "trusted",
    base_age_sec: 0.85,
    observations: 318420,
    running_ratio: 0.81,
    shift_parts: 11,
    ideal_ms: 5_950_000,
    tool_id: "T04",
    diam_wear_mm: 0.018,
    length_wear_mm: 0.024,
    runtime_hours: 1420.5,
    spindle_hours: 985.2,
  },
  {
    machine_id: "VMC-02",
    machine_name: "VMC-02",
    online: true,
    state: "STREAMING",
    status: "idle",
    availability: "AVAILABLE",
    controller_mode: "AUTOMATIC",
    execution: "STOPPED",
    active_program: "MET_358_1OP.NC",
    prev_programs: ["MET_355_DRILL.NC", "MET_358_1OP.NC"],
    spindle_target_rpm: 5600,
    spindle_speed: 0,
    part_count: 44,
    target_part_qty: 60,
    overrides: { feed: 100, rapid: 100, spindle: 100 },
    alarm_count: 0,
    position: { x: -890.850494, y: -0.002109, z: -0.006443 },
    cycle_total_s: 1566,
    cycle_elapsed_s: 1566,
    clock_quality: "trusted",
    base_age_sec: 36.64,
    observations: 11481,
    running_ratio: 0.729,
    shift_parts: 7,
    ideal_ms: 5_866_000,
    tool_id: "T07",
    diam_wear_mm: 0.031,
    length_wear_mm: 0.039,
    runtime_hours: 1864.2,
    spindle_hours: 1290.8,
  },
  {
    machine_id: "VMC-03",
    machine_name: "VMC-03",
    online: true,
    state: "STREAMING",
    status: "idle",
    availability: "AVAILABLE",
    controller_mode: "AUTOMATIC",
    execution: "STOPPED",
    active_program: "LH013E2_M12ANDFINALOP.nc",
    prev_programs: ["LH013E1_1STOP.nc", "LH013E2_M12ANDFINALOP.nc"],
    spindle_target_rpm: 7200,
    spindle_speed: 0,
    part_count: 658,
    target_part_qty: 700,
    overrides: { feed: 100, rapid: 100, spindle: 100 },
    alarm_count: 0,
    position: { x: -491.087585, y: -0.001346, z: -0.014957 },
    cycle_total_s: 1297,
    cycle_elapsed_s: 1297,
    clock_quality: "clock_unset",
    base_age_sec: 6.88,
    observations: 12103,
    running_ratio: 0.764,
    shift_parts: 9,
    ideal_ms: 6_039_000,
    tool_id: "T12",
    diam_wear_mm: 0.044,
    length_wear_mm: 0.052,
    runtime_hours: 2310.7,
    spindle_hours: 1644.1,
  },
  {
    machine_id: "VMC-04",
    machine_name: "VMC-04",
    online: false,
    state: "BOOTSTRAP",
    status: "offline",
    availability: "",
    controller_mode: "UNAVAILABLE",
    execution: "UNAVAILABLE",
    active_program: "UNAVAILABLE",
    prev_programs: [],
    spindle_target_rpm: 0,
    spindle_speed: null,
    part_count: null,
    overrides: { feed: null, rapid: null, spindle: null },
    alarm_count: 0,
    position: null,
    cycle_total_s: null,
    cycle_elapsed_s: null,
    clock_quality: "trusted",
    base_age_sec: 6_044_100,
    observations: 0,
    running_ratio: 0,
    shift_parts: 0,
    ideal_ms: 420_000,
    tool_id: "T01",
    diam_wear_mm: 0.012,
    length_wear_mm: 0.015,
    runtime_hours: 940.0,
    spindle_hours: 612.4,
  },
  {
    machine_id: "VMC-05",
    machine_name: "VMC-05",
    online: true,
    state: "STREAMING",
    status: "idle",
    availability: "AVAILABLE",
    controller_mode: "AUTOMATIC",
    execution: "STOPPED",
    active_program: "LH108_1STOPV1.nc",
    prev_programs: ["LH107_BORE_OP2.nc", "LH108_1STOPV1.nc"],
    spindle_target_rpm: 6800,
    spindle_speed: 0,
    part_count: 10,
    target_part_qty: 24,
    overrides: { feed: 100, rapid: 100, spindle: 100 },
    alarm_count: 0,
    position: { x: -589.051683, y: -4.223784, z: -0.011001 },
    cycle_total_s: 1251,
    cycle_elapsed_s: 1251,
    clock_quality: "trusted",
    base_age_sec: 1.84,
    observations: 421797,
    running_ratio: 0.801,
    shift_parts: 10,
    ideal_ms: 6_390_000,
    tool_id: "T09",
    diam_wear_mm: 0.027,
    length_wear_mm: 0.033,
    runtime_hours: 1752.3,
    spindle_hours: 1188.6,
    toggle_demo_idle: true,
  },
  {
    machine_id: "VMC-06",
    machine_name: "VMC-06",
    online: true,
    state: "STREAMING",
    status: "running",
    availability: "AVAILABLE",
    controller_mode: "AUTOMATIC",
    execution: "ACTIVE",
    active_program: "LH141_M12ANDFINALOPV1.nc",
    prev_programs: ["LH141_ROUGH_OP1.nc", "LH141_M12ANDFINALOPV1.nc"],
    spindle_target_rpm: 7000,
    spindle_speed: 7000.05,
    part_count: 7,
    target_part_qty: 20,
    overrides: { feed: 100, rapid: 100, spindle: 100 },
    alarm_count: 0,
    position: { x: -122.487477, y: -336.402389, z: -326.689431 },
    cycle_total_s: 1771,
    cycle_elapsed_s: 292,
    clock_quality: "clock_unset",
    base_age_sec: 1.2,
    observations: 450473,
    running_ratio: 0.754,
    shift_parts: 7,
    ideal_ms: 6_503_000,
    tool_id: "T05",
    diam_wear_mm: 0.058,
    length_wear_mm: 0.064,
    runtime_hours: 2085.4,
    spindle_hours: 1492.0,
  },
  {
    machine_id: "VMC-07",
    machine_name: "VMC-07",
    online: true,
    state: "STREAMING",
    status: "running",
    availability: "AVAILABLE",
    controller_mode: "AUTOMATIC",
    execution: "ACTIVE",
    active_program: "LH_028_1ST_OP.NC",
    prev_programs: ["LH_027_FINAL.NC", "LH_028_1ST_OP.NC"],
    spindle_target_rpm: 8800,
    spindle_speed: 8801.76,
    part_count: 750,
    target_part_qty: 800,
    overrides: { feed: 100, rapid: 100, spindle: 100 },
    alarm_count: 0,
    position: { x: -90.362756, y: -92.428745, z: -331.129014 },
    cycle_total_s: 1286,
    cycle_elapsed_s: 320,
    clock_quality: "clock_unset",
    base_age_sec: 0.92,
    observations: 2306,
    running_ratio: 0.752,
    shift_parts: 8,
    ideal_ms: 4_960_000,
    tool_id: "T03",
    diam_wear_mm: 0.022,
    length_wear_mm: 0.029,
    runtime_hours: 1628.9,
    spindle_hours: 1120.3,
  },
  {
    machine_id: "VMC-08",
    machine_name: "VMC-08",
    online: true,
    state: "STREAMING",
    status: "running",
    availability: "AVAILABLE",
    controller_mode: "AUTOMATIC",
    execution: "ACTIVE",
    active_program: "HSG_402_FINISH_OP2.NC",
    prev_programs: ["HSG_402_SEMI_OP1.NC", "HSG_402_FINISH_OP2.NC"],
    spindle_target_rpm: 9500,
    spindle_speed: 9498.5,
    part_count: 215,
    target_part_qty: 250,
    overrides: { feed: 90, rapid: 100, spindle: 100 },
    alarm_count: 0,
    position: { x: -312.64, y: -218.42, z: -285.15 },
    cycle_total_s: 1420,
    cycle_elapsed_s: 810,
    clock_quality: "trusted",
    base_age_sec: 1.05,
    observations: 289610,
    running_ratio: 0.842,
    shift_parts: 12,
    ideal_ms: 6_180_000,
    tool_id: "T11",
    diam_wear_mm: 0.036,
    length_wear_mm: 0.041,
    runtime_hours: 1510.1,
    spindle_hours: 1084.7,
  },
];

function getIstShiftWindow(nowMs: number): {
  shift: "01" | "02" | "03";
  label: string;
  from: number;
  to: number;
  shiftEnd: number;
  futureMs: number;
} {
  const istMs = nowMs + IST_OFFSET_MS;
  const istDate = new Date(istMs);
  const h = istDate.getUTCHours();

  let shift: "01" | "02" | "03";
  let startHour: number;
  let dayOffset = 0;

  if (h >= 6 && h < 14) {
    shift = "01";
    startHour = 6;
  } else if (h >= 14 && h < 22) {
    shift = "02";
    startHour = 14;
  } else {
    shift = "03";
    startHour = 22;
    if (h < 6) dayOffset = -1;
  }

  const startIst = Date.UTC(
    istDate.getUTCFullYear(),
    istDate.getUTCMonth(),
    istDate.getUTCDate() + dayOffset,
    startHour,
    0,
    0,
    0,
  );
  const from = startIst - IST_OFFSET_MS;
  const shiftEnd = from + SHIFT_DURATION_MS;
  const to = Math.min(nowMs, shiftEnd);
  const futureMs = Math.max(0, shiftEnd - to);

  return { shift, label: `SHIFT ${shift}`, from, to, shiftEnd, futureMs };
}

function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function deterministicUnit(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function parseIntClamped(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof raw !== "string" && typeof raw !== "number") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function parseItemsParam(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 64)
    .slice(0, MAX_ITEMS_PER_QUERY);
}

function parseWindowUs(
  fromRaw: unknown,
  toRaw: unknown,
  nowMs: number,
): { fromMs: number; toMs: number } {
  const toUs = Number(toRaw);
  const fromUs = Number(fromRaw);
  const toMs = Number.isFinite(toUs) && toUs > 0 ? Math.min(nowMs + 60_000, toUs / US_PER_MS) : nowMs;
  const rawFromMs =
    Number.isFinite(fromUs) && fromUs > 0 ? fromUs / US_PER_MS : toMs - 8 * 3600 * 1000;
  const fromMs = Math.max(toMs - MAX_WINDOW_MS, Math.min(toMs - 1000, rawFromMs));
  return { fromMs, toMs };
}

class DemoCollector {
  private readonly machines: LiveMachine[];
  private readonly byId: Map<string, LiveMachine>;
  private readonly bootShiftFrom: number;
  private readonly sseClients = new Set<Response>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private sseTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const now = Date.now();
    const win = getIstShiftWindow(now);
    this.bootShiftFrom = win.from;
    const elapsedShiftMs = Math.max(60_000, now - win.from);

    this.machines = INITIAL_SEEDS.map((seed, idx) => {
      const runMs = seed.online
        ? Math.round(elapsedShiftMs * seed.running_ratio)
        : 0;
      const stopMs = Math.max(0, elapsedShiftMs - runMs);
      const lastSeen = seed.online
        ? now - Math.round(seed.base_age_sec * 1000)
        : now - Math.round(seed.base_age_sec * 1000);
      const machineTs =
        seed.clock_quality === "clock_unset"
          ? 3_000_000_000 + idx * 1_512_345_678
          : lastSeen - 240;

      // Seed recent part completions inside this shift for realistic card timings
      const recentParts: LiveMachine["recent_parts"] = [];
      if (seed.online && seed.part_count != null && seed.cycle_total_s) {
        const count = Math.min(seed.shift_parts, 8);
        const stepMs = Math.max(
          seed.cycle_total_s * 1000,
          Math.floor(elapsedShiftMs / Math.max(1, count + 1)),
        );
        for (let i = count; i >= 1; i--) {
          const ts = now - i * stepMs - (seed.cycle_elapsed_s ?? 0) * 1000;
          if (ts > win.from - 3600_000) {
            recentParts.push({
              ts_ms: Math.max(win.from, ts),
              count: Math.max(1, seed.part_count - (i - 1)),
              program: seed.active_program,
              dur_s: seed.cycle_total_s,
            });
          }
        }
      }

      return {
        ...seed,
        spindle_current: seed.spindle_speed,
        part_count_current: seed.part_count,
        cycle_elapsed_current: seed.cycle_elapsed_s,
        position_current: seed.position ? { ...seed.position } : null,
        shift_running_ms: runMs,
        shift_stopped_ms: stopMs,
        shift_parts_current: seed.shift_parts,
        measured_rows: seed.online ? Math.max(1200, Math.round(runMs / 1000)) : 0,
        observations_current: seed.observations,
        last_seen_ms: lastSeen,
        machine_ts: machineTs,
        tool_swap_ticks: 0,
        phase_angle: idx * 0.9,
        idle_ticks: 0,
        recent_parts: recentParts,
      };
    });

    this.byId = new Map(this.machines.map((m) => [m.machine_id, m]));
    this.startLoops();
  }

  private startLoops(): void {
    this.tickTimer = setInterval(() => this.tick(), 1000);
    this.tickTimer.unref();

    this.sseTimer = setInterval(() => {
      if (this.sseClients.size === 0) return;
      const payload = JSON.stringify(this.getOverview());
      for (const client of this.sseClients) {
        try {
          client.write(`data: ${payload}\n\n`);
        } catch {
          this.sseClients.delete(client);
        }
      }
    }, 2000);
    this.sseTimer.unref();
  }

  private tick(): void {
    const now = Date.now();
    const win = getIstShiftWindow(now);

    for (const m of this.machines) {
      if (!m.online) {
        m.shift_stopped_ms = Math.max(0, win.to - win.from);
        continue;
      }

      // Optional realistic live transition for VMC-05 (idle -> running -> idle)
      if (m.toggle_demo_idle) {
        m.idle_ticks += 1;
        if (m.status === "idle" && m.idle_ticks >= 18) {
          m.status = "running";
          m.execution = "ACTIVE";
          m.cycle_elapsed_current = 0;
          m.idle_ticks = 0;
        }
      }

      const isRunning = m.status === "running" && m.execution === "ACTIVE";
      if (isRunning) {
        m.shift_running_ms += 1000;
        m.measured_rows += 1;
        m.observations_current += 4;
        m.last_seen_ms = now - Math.round(m.base_age_sec * 1000);
        if (m.clock_quality === "trusted") {
          m.machine_ts = m.last_seen_ms - 180;
        } else {
          m.machine_ts += 1000;
        }

        // Smooth CNC milling toolpath coordinates + subtle spindle ripple
        m.phase_angle += 0.14;
        const t = m.phase_angle;
        const basePos = m.position ?? { x: -250, y: -150, z: -220 };
        if (m.tool_swap_ticks > 0) {
          m.tool_swap_ticks -= 1;
          m.spindle_current = 0;
          m.position_current = {
            x: basePos.x,
            y: basePos.y,
            z: -12.5,
          };
        } else {
          const ripple = Math.sin(t * 2.3) * 28 + Math.cos(t * 0.7) * 14;
          m.spindle_current = Math.max(0, Number((m.spindle_target_rpm + ripple).toFixed(2)));
          m.position_current = {
            x: Number((basePos.x + Math.cos(t) * 65 + Math.cos(t * 3) * 12).toFixed(4)),
            y: Number((basePos.y + Math.sin(t) * 52 + Math.sin(t * 2) * 10).toFixed(4)),
            z: Number((basePos.z + Math.sin(t * 0.35) * 18).toFixed(4)),
          };
        }

        // Advance cycle timer
        if (m.cycle_total_s != null && m.cycle_elapsed_current != null) {
          m.cycle_elapsed_current += 1;
          if (m.cycle_elapsed_current >= m.cycle_total_s) {
            m.cycle_elapsed_current = 0;
            m.tool_swap_ticks = 8;
            if (m.part_count_current != null) {
              m.part_count_current += 1;
              m.shift_parts_current += 1;
              m.recent_parts.push({
                ts_ms: now,
                count: m.part_count_current,
                program: m.active_program,
                dur_s: m.cycle_total_s,
              });
              if (m.recent_parts.length > 40) m.recent_parts.shift();
            }
          }
        }
      } else {
        m.shift_stopped_ms += 1000;
        m.spindle_current = 0;
        if (m.base_age_sec < 15) {
          m.last_seen_ms = now - Math.round(m.base_age_sec * 1000);
        }
      }

      // Clamp shift totals to current shift elapsed duration
      const elapsed = Math.max(1000, win.to - win.from);
      if (m.shift_running_ms + m.shift_stopped_ms > elapsed + 2000) {
        const ratio = m.shift_running_ms / Math.max(1, m.shift_running_ms + m.shift_stopped_ms);
        m.shift_running_ms = Math.round(elapsed * ratio);
        m.shift_stopped_ms = Math.max(0, elapsed - m.shift_running_ms);
      }
    }
  }

  private freshnessFor(ageSec: number | null): "fresh" | "lagging" | "stale" | "dead" {
    if (ageSec == null) return "dead";
    if (ageSec < 5) return "fresh";
    if (ageSec < 30) return "lagging";
    if (ageSec < 300) return "stale";
    return "dead";
  }

  public getOverview() {
    const now = Date.now();
    const win = getIstShiftWindow(now);
    const summary = {
      total: this.machines.length,
      running: 0,
      idle: 0,
      alarm: 0,
      offline: 0,
    };

    const machines = this.machines.map((m) => {
      if (!m.online) summary.offline += 1;
      else if (m.status === "alarm") summary.alarm += 1;
      else if (m.status === "running") summary.running += 1;
      else summary.idle += 1;

      const ageSec = m.online
        ? Number(Math.max(0.2, (now - m.last_seen_ms) / 1000).toFixed(5))
        : m.base_age_sec;
      const freshness = m.online ? this.freshnessFor(ageSec) : "dead";

      const isRunning = m.online && m.status === "running";
      const totalCyc = m.cycle_total_s;
      const lastCyc = m.cycle_elapsed_current;
      const remCyc =
        totalCyc != null && lastCyc != null
          ? isRunning
            ? Math.max(0, totalCyc - lastCyc)
            : 0
          : null;

      return {
        machine_id: m.machine_id,
        machine_name: m.machine_name,
        online: m.online,
        state: m.state,
        data_age_sec: ageSec,
        freshness,
        clock_quality: m.clock_quality,
        machine_ts: m.machine_ts,
        last_seen_ms: m.last_seen_ms,
        observations: m.observations_current,
        status: m.status,
        availability: m.availability,
        controller_mode: m.controller_mode,
        execution: m.execution,
        active_program: m.active_program,
        spindle_speed: m.spindle_current,
        part_count: m.part_count_current,
        part_count_total: m.part_count_current,
        target_part_qty: m.target_part_qty ?? null,
        overrides: { ...m.overrides },
        alarm_count: m.alarm_count,
        position: m.position_current ? { ...m.position_current } : null,
        cycle: {
          this_cycle: totalCyc,
          last_cycle: lastCyc,
          remaining_cycle_time: remCyc,
          cycle_progress_pct: null,
          overrun: false,
          estimated: false,
        },
        shift_summary: {
          machine_id: m.machine_id,
          shift: win.shift,
          label: win.label,
          window: {
            from: win.from,
            to: win.to,
          },
          shift_end: win.shiftEnd,
          shift_duration: SHIFT_DURATION_MS,
          future_ms: win.futureMs,
          ideal_ms: m.ideal_ms,
          running_ms: m.shift_running_ms,
          stopped_ms: m.shift_stopped_ms,
          measured_rows: m.measured_rows,
          truncated: false,
          parts: m.shift_parts_current,
          active_program: m.active_program,
        },
      };
    });

    return {
      updated_at: now,
      data_updated_at_ms: now - 420,
      summary,
      machines,
    };
  }

  public getShiftSummary(machineId: string, fromMs: number, toMs: number) {
    const m = this.byId.get(machineId);
    if (!m) return null;
    const span = Math.max(1000, Math.min(SHIFT_DURATION_MS, toMs - fromMs));
    const winInfo = getIstShiftWindow(fromMs + 1000);

    // If querying current shift window, return live values
    if (Math.abs(fromMs - this.bootShiftFrom) < 60_000) {
      return {
        machine_id: m.machine_id,
        shift: winInfo.shift,
        label: winInfo.label,
        window: { from: fromMs, to: toMs },
        shift_end: fromMs + SHIFT_DURATION_MS,
        shift_duration: SHIFT_DURATION_MS,
        future_ms: Math.max(0, fromMs + SHIFT_DURATION_MS - toMs),
        ideal_ms: m.ideal_ms,
        running_ms: m.shift_running_ms,
        stopped_ms: m.shift_stopped_ms,
        measured_rows: m.measured_rows,
        truncated: false,
        parts: m.shift_parts_current,
        active_program: m.active_program,
      };
    }

    // Deterministic historical shift summary so SHIFT 01 / 02 / 03 boxes stay stable
    if (!m.online) {
      return {
        machine_id: m.machine_id,
        shift: winInfo.shift,
        label: winInfo.label,
        window: { from: fromMs, to: toMs },
        shift_end: fromMs + SHIFT_DURATION_MS,
        shift_duration: SHIFT_DURATION_MS,
        future_ms: 0,
        ideal_ms: 0,
        running_ms: 0,
        stopped_ms: span,
        measured_rows: 0,
        truncated: false,
        parts: 0,
        active_program: "UNAVAILABLE",
      };
    }

    const jitter = (deterministicUnit(hashSeed(`${machineId}|${Math.round(fromMs / 3600_000)}`)) - 0.5) * 0.16;
    const ratio = Math.max(0.45, Math.min(0.94, m.running_ratio + jitter));
    const runMs = Math.round(span * ratio);
    const stopMs = Math.max(0, span - runMs);
    const cycleMs = (m.cycle_total_s ?? 1400) * 1000;
    const parts = Math.max(1, Math.floor(runMs / cycleMs));

    return {
      machine_id: m.machine_id,
      shift: winInfo.shift,
      label: winInfo.label,
      window: { from: fromMs, to: toMs },
      shift_end: fromMs + SHIFT_DURATION_MS,
      shift_duration: SHIFT_DURATION_MS,
      future_ms: 0,
      ideal_ms: Math.round(runMs * 0.52),
      running_ms: runMs,
      stopped_ms: stopMs,
      measured_rows: Math.round(span / 1000),
      truncated: false,
      parts,
      active_program: m.active_program,
    };
  }

  public getGapAudit() {
    return {
      no_silent_loss: true,
      silent_total: 0,
      unexplained_total: 0,
      machines: this.machines.map((m) => ({
        name: m.machine_id,
        no_silent_loss: true,
        silent: 0,
        unexplained: 0,
      })),
    };
  }

  public generateHistoryRows(
    m: LiveMachine,
    item: string,
    fromMs: number,
    toMs: number,
    maxRows: number,
  ): Array<{ ts: number; val: string; val_num: number | null; seq: number; item: string; carried?: boolean }> {
    const out: Array<{ ts: number; val: string; val_num: number | null; seq: number; item: string; carried?: boolean }> = [];
    if (!m.online && item !== "rstat" && item !== "aalarms" && item !== "estop") {
      return out;
    }

    const spanMs = Math.max(60_000, toMs - fromMs);
    const cycleMs = (m.cycle_total_s ?? 1400) * 1000;
    const seedBase = hashSeed(`${m.machine_id}|${item}`);
    let seq = (seedBase % 100_000) + 1;

    const pushRow = (tsMs: number, val: string, num: number | null = null, carried = false) => {
      out.push({
        ts: Math.round(tsMs * US_PER_MS),
        val,
        val_num: num,
        seq: seq++,
        item,
        ...(carried ? { carried: true } : {}),
      });
    };

    if (item === "rstat") {
      if (!m.online) {
        pushRow(fromMs, "UNAVAILABLE", null, true);
        return out;
      }
      const segCount = Math.min(maxRows, Math.max(6, Math.min(48, Math.floor(spanMs / (18 * 60_000)))));
      const step = spanMs / segCount;
      for (let i = 0; i < segCount; i++) {
        const t = fromMs + i * step;
        const r = deterministicUnit(seedBase + i * 7);
        let st = "ACTIVE";
        if (r > m.running_ratio + 0.08) st = "STOPPED";
        else if (r > m.running_ratio) st = "FEED_HOLD";
        pushRow(t, st, null, i === 0);
      }
      pushRow(toMs - 1000, m.execution, null);
      return out;
    }

    if (item === "m30c1" || item === "Part_Count" || item === "PartCount") {
      if (!m.online || m.part_count_current == null) return out;
      const totalPartsInSpan = Math.min(
        maxRows,
        Math.max(2, Math.min(40, Math.floor((spanMs * m.running_ratio) / cycleMs))),
      );
      const startCount = Math.max(0, m.part_count_current - totalPartsInSpan);
      const step = spanMs / Math.max(1, totalPartsInSpan + 1);
      pushRow(fromMs, String(startCount), startCount, true);
      for (let i = 1; i <= totalPartsInSpan; i++) {
        const jitter = (deterministicUnit(seedBase + i * 13) - 0.5) * step * 0.16;
        const t = Math.min(toMs - 1500, Math.max(fromMs + 1000, fromMs + i * step + jitter));
        const val = startCount + i;
        pushRow(t, String(val), val);
      }
      return out;
    }

    if (item === "ncprog" || item === "Program_Name_Running") {
      if (!m.online) return out;
      const prev = m.prev_programs[0] || m.active_program;
      pushRow(fromMs, prev, null, true);
      if (prev !== m.active_program) {
        pushRow(fromMs + spanMs * 0.35, m.active_program, null);
      }
      pushRow(toMs - 2000, m.active_program, null);
      return out;
    }

    if (item === "fdovrd" || item === "rovrd" || item === "ssovrd") {
      const currentVal =
        item === "fdovrd"
          ? m.overrides.feed
          : item === "rovrd"
            ? m.overrides.rapid
            : m.overrides.spindle;
      const base = currentVal ?? 100;
      const pts = Math.min(maxRows, 16);
      const step = spanMs / pts;
      for (let i = 0; i < pts; i++) {
        const t = fromMs + i * step;
        const dip =
          i === Math.floor(pts * 0.6) && m.machine_id === "VMC-08" && item === "fdovrd"
            ? 80
            : i === Math.floor(pts * 0.4) && item === "rovrd"
              ? 75
              : base;
        pushRow(t, String(dip), dip, i === 0);
      }
      pushRow(toMs - 1000, String(base), base);
      return out;
    }

    if (item === "estop") {
      pushRow(fromMs, "ARMED", null, true);
      return out;
    }

    if (item === "aalarms") {
      pushRow(fromMs, "NO ACTIVE ALARMS", null, true);
      if (m.machine_id === "VMC-02" && spanMs >= 3 * 3600_000) {
        const t = fromMs + spanMs * 0.42;
        pushRow(t, "AL-414 COOLANT PRESSURE LOW", null);
        pushRow(t + 4 * 60_000, "NO ACTIVE ALARMS", null);
      }
      return out;
    }

    if (item === "machineruntime" || item === "spindletime") {
      const baseSec =
        (item === "machineruntime" ? m.runtime_hours : m.spindle_hours) * 3600;
      const pts = 12;
      const step = spanMs / pts;
      for (let i = 0; i <= pts; i++) {
        const t = fromMs + i * step;
        const sec = Math.round(baseSec - ((pts - i) * step * m.running_ratio) / 1000);
        pushRow(t, String(sec), sec, i === 0);
      }
      return out;
    }

    if (item === "toolid") {
      const tools = [m.tool_id, "T02", "T06", m.tool_id];
      const step = spanMs / tools.length;
      tools.forEach((tid, idx) => {
        pushRow(fromMs + idx * step, tid, Number(tid.replace(/\D/g, "")) || idx + 1, idx === 0);
      });
      return out;
    }

    if (item === "diamwear" || item === "lengthwear") {
      const cur = item === "diamwear" ? m.diam_wear_mm : m.length_wear_mm;
      const pts = 14;
      const step = spanMs / pts;
      for (let i = 0; i <= pts; i++) {
        const val = Number(Math.max(0.002, cur * (0.55 + (0.45 * i) / pts)).toFixed(4));
        pushRow(fromMs + i * step, String(val), val, i === 0);
      }
      return out;
    }

    if (
      item === "x_axis_actual_position" ||
      item === "y_axis_actual_position" ||
      item === "z_axis_actual_position" ||
      item === "xyzact"
    ) {
      const base = m.position_current ?? m.position ?? { x: -200, y: -150, z: -200 };
      const pts = Math.min(maxRows, 120);
      const step = Math.min(spanMs / pts, 5000);
      const start = toMs - pts * step;
      for (let i = 0; i < pts; i++) {
        const a = i * 0.16;
        const x = Number((base.x + Math.cos(a) * 65 + Math.cos(a * 3) * 12).toFixed(3));
        const y = Number((base.y + Math.sin(a) * 52 + Math.sin(a * 2) * 10).toFixed(3));
        const z = Number((base.z + Math.sin(a * 0.35) * 18).toFixed(3));
        const t = start + i * step;
        if (item === "xyzact") {
          pushRow(t, `${x} ${y} ${z}`, null, i === 0);
        } else if (item === "x_axis_actual_position") {
          pushRow(t, String(x), x, i === 0);
        } else if (item === "y_axis_actual_position") {
          pushRow(t, String(y), y, i === 0);
        } else {
          pushRow(t, String(z), z, i === 0);
        }
      }
      return out;
    }

    if (item === "sspeed") {
      const pts = Math.min(maxRows, 90);
      const step = spanMs / pts;
      for (let i = 0; i < pts; i++) {
        const rpm =
          m.status === "running"
            ? Number((m.spindle_target_rpm + Math.sin(i * 0.5) * 35).toFixed(1))
            : 0;
        pushRow(fromMs + i * step, String(rpm), rpm, i === 0);
      }
      return out;
    }

    // Generic numeric fallback
    pushRow(fromMs, "0", 0, true);
    return out;
  }

  public getTimelineBulk(fromMs: number, toMs: number) {
    const spanMs = Math.max(60_000, toMs - fromMs);
    const lanes = this.machines.map((m) => {
      if (!m.online) {
        return {
          machine: m.machine_id,
          truncated: false,
          parts: [],
          groups: [],
          bands: [
            {
              t0: Math.round(fromMs * US_PER_MS),
              t1: Math.round(toMs * US_PER_MS),
              status: "offline",
            },
          ],
        };
      }

      const cycleS = m.cycle_total_s ?? 1400;
      const cycleMs = cycleS * 1000;
      const seed = hashSeed(`${m.machine_id}|timeline`);
      const parts: Array<{
        t0: number;
        t1: number;
        dur_ms: number;
        target_s: number;
        partial: boolean;
        program: string;
        job: string;
        group_id: number;
        baseline_s: number;
        baseline_n: number;
        dev: number;
      }> = [];
      const bands: Array<{ t0: number; t1: number; status: string }> = [];

      let cursor = fromMs;
      let idx = 0;
      while (cursor < toMs - 30_000 && parts.length < 48) {
        const r = deterministicUnit(seed + idx * 17);
        const durFactor = 0.94 + r * 0.14;
        const durMs = Math.round(cycleMs * durFactor);
        const end = Math.min(toMs, cursor + durMs);
        const partial = end >= toMs && end - cursor < durMs * 0.92;
        const prog =
          idx < 2 && m.prev_programs.length > 1
            ? m.prev_programs[0]
            : m.active_program;
        const groupId = prog === m.active_program ? 2 : 1;

        parts.push({
          t0: Math.round(cursor * US_PER_MS),
          t1: Math.round(end * US_PER_MS),
          dur_ms: Math.round(end - cursor),
          target_s: cycleS,
          partial,
          program: prog,
          job: prog.replace(/\.nc$/i, ""),
          group_id: groupId,
          baseline_s: cycleS,
          baseline_n: 12,
          dev: Number(((end - cursor) / 1000 / cycleS).toFixed(3)),
        });
        bands.push({
          t0: Math.round(cursor * US_PER_MS),
          t1: Math.round(end * US_PER_MS),
          status: "running",
        });

        const gapMs = Math.round(
          (1 - m.running_ratio) * cycleMs * (0.5 + deterministicUnit(seed + idx * 31)),
        );
        const nextCursor = Math.min(toMs, end + Math.max(45_000, gapMs));
        if (nextCursor > end) {
          bands.push({
            t0: Math.round(end * US_PER_MS),
            t1: Math.round(nextCursor * US_PER_MS),
            status: idx % 5 === 2 ? "paused" : "idle",
          });
        }
        cursor = nextCursor;
        idx += 1;
      }

      // Group parts by group_id
      const groupMap = new Map<
        number,
        { group_id: number; program: string; t0: number; t1: number; count: number; baseline_s: number; baseline_n: number }
      >();
      for (const p of parts) {
        const existing = groupMap.get(p.group_id);
        if (!existing) {
          groupMap.set(p.group_id, {
            group_id: p.group_id,
            program: p.program,
            t0: p.t0,
            t1: p.t1,
            count: 1,
            baseline_s: p.baseline_s,
            baseline_n: p.baseline_n,
          });
        } else {
          existing.t1 = Math.max(existing.t1, p.t1);
          existing.count += 1;
        }
      }

      if (bands.length === 0) {
        bands.push({
          t0: Math.round(fromMs * US_PER_MS),
          t1: Math.round(toMs * US_PER_MS),
          status: m.status,
        });
      }

      // Ensure tail reflects current live status for short windows
      if (spanMs <= 2 * 3600_000 && bands.length > 0) {
        bands[bands.length - 1].status = m.status;
      }

      return {
        machine: m.machine_id,
        truncated: false,
        parts,
        groups: [...groupMap.values()],
        bands,
      };
    });

    return {
      from: Math.round(fromMs * US_PER_MS),
      to: Math.round(toMs * US_PER_MS),
      lanes,
    };
  }

  public getSeries(machineId: string, item: string, fromMs: number, toMs: number, bucketsCount: number) {
    const m = this.byId.get(machineId);
    if (!m || !m.online) return { buckets: [] };
    const count = Math.max(10, Math.min(600, bucketsCount));
    const step = (toMs - fromMs) / count;
    const baseVal =
      item === "sspeed"
        ? m.spindle_target_rpm
        : item === "fdovrd"
          ? m.overrides.feed ?? 100
          : item === "rovrd"
            ? m.overrides.rapid ?? 100
            : item === "ssovrd"
              ? m.overrides.spindle ?? 100
              : 100;
    const spread = item === "sspeed" ? 45 : 4;
    const buckets = [];
    for (let i = 0; i < count; i++) {
      const tMs = fromMs + i * step;
      const avg = Number((baseVal + Math.sin(i * 0.35) * spread).toFixed(2));
      buckets.push({
        t: Math.round(tMs * US_PER_MS),
        min: Number((avg - spread * 0.6).toFixed(2)),
        max: Number((avg + spread * 0.6).toFixed(2)),
        avg,
        n: 12,
      });
    }
    return { buckets };
  }

  public getEvents(fromMs: number, toMs: number) {
    const span = Math.max(60_000, toMs - fromMs);
    const events = [
      {
        machine: "VMC-08",
        ts: Math.round(toMs - span * 0.08),
        sev: "WARNING",
        rule: "override",
        msg: "Feed override dialed to 90% during finish pass (HSG_402_FINISH_OP2.NC)",
      },
      {
        machine: "VMC-06",
        ts: Math.round(toMs - span * 0.16),
        sev: "INFO",
        rule: "program",
        msg: "Program loaded → LH141_M12ANDFINALOPV1.nc",
      },
      {
        machine: "VMC-02",
        ts: Math.round(toMs - span * 0.28),
        sev: "WARNING",
        rule: "feed_hold",
        msg: "Operator feed-hold during tool inspection (MET_358_1OP.NC)",
      },
      {
        machine: "VMC-07",
        ts: Math.round(toMs - span * 0.41),
        sev: "INFO",
        rule: "program",
        msg: "Program loaded → LH_028_1ST_OP.NC",
      },
      {
        machine: "VMC-01",
        ts: Math.round(toMs - span * 0.55),
        sev: "INFO",
        rule: "program",
        msg: "Program loaded → BRK_210_ROUGH_OP1.NC",
      },
      {
        machine: "VMC-04",
        ts: Math.round(toMs - span * 0.72),
        sev: "CRITICAL",
        rule: "offline",
        msg: "MTConnect agent unreachable — machine offline",
      },
    ].filter((e) => e.ts >= fromMs && e.ts <= toMs);

    return { events };
  }

  public createRouter(): express.Router {
    const router = express.Router();

    router.get("/health", (_req: Request, res: Response) => {
      res.json({
        ok: true,
        mode: "demo",
        machines: this.machines.length,
        updated_at: Date.now(),
      });
    });

    router.get("/machines", (_req: Request, res: Response) => {
      res.json({
        machines: this.machines.map((m) => ({
          machine_id: m.machine_id,
          machine_name: m.machine_name,
          online: m.online,
          status: m.status,
        })),
      });
    });

    router.get("/overview", (_req: Request, res: Response) => {
      res.json(this.getOverview());
    });

    router.get("/gap_audit", (_req: Request, res: Response) => {
      res.json(this.getGapAudit());
    });

    router.get("/shift_summary", (req: Request, res: Response) => {
      const machine = typeof req.query.machine === "string" ? req.query.machine : "";
      const now = Date.now();
      const win = getIstShiftWindow(now);
      const fromMs = parseIntClamped(req.query.from_ms, win.from, now - MAX_WINDOW_MS, now + SHIFT_DURATION_MS);
      const toMs = parseIntClamped(req.query.to_ms, win.to, fromMs + 1000, now + SHIFT_DURATION_MS);
      const summary = this.getShiftSummary(machine, fromMs, toMs);
      if (!summary) {
        res.status(404).json({ error: "Unknown machine" });
        return;
      }
      res.json(summary);
    });

    router.get("/history_bulk", (req: Request, res: Response) => {
      const items = parseItemsParam(req.query.items);
      const limit = parseIntClamped(req.query.limit, 200, 1, 2000);
      const now = Date.now();
      const fromMs = now - 8 * 3600 * 1000;
      const machines: Record<string, Record<string, unknown[]>> = {};
      for (const m of this.machines) {
        const per: Record<string, unknown[]> = {};
        for (const item of items) {
          per[item] = this.generateHistoryRows(m, item, fromMs, now, limit);
        }
        machines[m.machine_id] = per;
      }
      res.json({ machines });
    });

    router.get("/history_range_bulk", (req: Request, res: Response) => {
      const items = parseItemsParam(req.query.items);
      const max = parseIntClamped(req.query.max, 500, 1, 2000);
      const now = Date.now();
      const { fromMs, toMs } = parseWindowUs(req.query.from, req.query.to, now);
      const machines: Record<string, Record<string, unknown[]>> = {};
      for (const m of this.machines) {
        const per: Record<string, unknown[]> = {};
        for (const item of items) {
          per[item] = this.generateHistoryRows(m, item, fromMs, toMs, max);
        }
        machines[m.machine_id] = per;
      }
      res.json({ machines });
    });

    router.get("/history_range", (req: Request, res: Response) => {
      const machine = typeof req.query.machine === "string" ? req.query.machine : "";
      const item = typeof req.query.item === "string" ? req.query.item.slice(0, 64) : "";
      const max = parseIntClamped(req.query.max, 500, 1, 2000);
      const m = this.byId.get(machine);
      if (!m || !item) {
        res.json([]);
        return;
      }
      const { fromMs, toMs } = parseWindowUs(req.query.from, req.query.to, Date.now());
      res.json(this.generateHistoryRows(m, item, fromMs, toMs, max));
    });

    router.get("/history", (req: Request, res: Response) => {
      const machine = typeof req.query.machine === "string" ? req.query.machine : "";
      const item = typeof req.query.item === "string" ? req.query.item.slice(0, 64) : "";
      const limit = parseIntClamped(req.query.limit, 200, 1, 2000);
      const m = this.byId.get(machine);
      if (!m || !item) {
        res.json([]);
        return;
      }
      const now = Date.now();
      res.json(this.generateHistoryRows(m, item, now - 8 * 3600 * 1000, now, limit));
    });

    router.get("/timeline_bulk", (req: Request, res: Response) => {
      const { fromMs, toMs } = parseWindowUs(req.query.from, req.query.to, Date.now());
      res.json(this.getTimelineBulk(fromMs, toMs));
    });

    router.get("/parts", (req: Request, res: Response) => {
      const machine = typeof req.query.machine === "string" ? req.query.machine : "";
      const { fromMs, toMs } = parseWindowUs(req.query.from, req.query.to, Date.now());
      const bulk = this.getTimelineBulk(fromMs, toMs);
      const lane = bulk.lanes.find((l) => l.machine === machine);
      res.json({ parts: lane ? lane.parts : [] });
    });

    router.get("/series", (req: Request, res: Response) => {
      const machine = typeof req.query.machine === "string" ? req.query.machine : "";
      const item = typeof req.query.item === "string" ? req.query.item.slice(0, 64) : "";
      const buckets = parseIntClamped(req.query.buckets, 120, 10, 600);
      const { fromMs, toMs } = parseWindowUs(req.query.from, req.query.to, Date.now());
      res.json(this.getSeries(machine, item, fromMs, toMs, buckets));
    });

    router.get("/events", (req: Request, res: Response) => {
      const { fromMs, toMs } = parseWindowUs(req.query.from, req.query.to, Date.now());
      res.json(this.getEvents(fromMs, toMs));
    });

    router.get("/stream", (req: Request, res: Response) => {
      if (this.sseClients.size >= MAX_SSE_CLIENTS) {
        res.status(503).json({ error: "Too many stream subscribers" });
        return;
      }
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
      this.sseClients.add(res);

      // Push an initial snapshot immediately
      res.write(`data: ${JSON.stringify(this.getOverview())}\n\n`);

      req.on("close", () => {
        this.sseClients.delete(res);
      });
    });

    return router;
  }
}

export function createDemoCollectorRouter(): express.Router {
  const collector = new DemoCollector();
  return collector.createRouter();
}
