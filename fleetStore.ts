import express from "express";
import type { Request, Response, Router } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DOWNTIME_REASONS = [
  "Setup",
  "Waiting for Material",
  "Operator Delay",
  "Inspection / Quality",
  "Tool Change",
  "Planned Maintenance",
  "Unplanned Breakdown",
  "Other",
] as const;

export type DowntimeReason = (typeof DOWNTIME_REASONS)[number];

export interface ShiftTargetRecord {
  machineId: string;
  shiftTargetParts: number | null;
  targetPartsPerHour: number | null;
  activeJob: string;
  operator: string;
  shiftLabel: string;
  updatedAt: number;
}

export interface DowntimeLogRecord {
  id: string;
  machineId: string;
  reason: DowntimeReason;
  durationMin: number;
  startTs: number;
  operator: string;
  shiftLabel: string;
  note: string;
  createdAt: number;
}

export interface RepairLogRecord {
  id: string;
  machineId: string;
  faultTitle: string;
  rootCause: string;
  actionTaken: string;
  partsReplaced: string;
  downtimeMin: number;
  repairMin: number;
  technician: string;
  status: "open" | "resolved";
  startedAt: number;
  resolvedAt: number | null;
  createdAt: number;
}

export interface FleetStoreState {
  targets: Record<string, ShiftTargetRecord>;
  downtimeLogs: DowntimeLogRecord[];
  repairLogs: RepairLogRecord[];
}

const MACHINE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const RECORD_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const REASON_SET = new Set<string>(DOWNTIME_REASONS);
const MAX_LOGS = 500;

function emptyState(): FleetStoreState {
  return { targets: {}, downtimeLogs: [], repairLogs: [] };
}

function cleanStr(val: unknown, maxLen: number): string {
  if (typeof val !== "string") return "";
  return val.trim().replace(/\s+/g, " ").slice(0, maxLen);
}

function cleanNum(val: unknown, min: number, max: number): number | null {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function cleanTs(val: unknown, fallback: number): number {
  const n = Number(val);
  if (!Number.isFinite(n) || n < 946684800000 || n > 4102444800000) {
    return fallback;
  }
  return Math.round(n);
}

function isValidMachineId(id: unknown): id is string {
  return typeof id === "string" && MACHINE_ID_RE.test(id.trim());
}

export function createFleetStoreRouter(baseDir: string): Router {
  const router = express.Router();
  router.use(express.json({ limit: "64kb" }));

  // Confined fixed persistence path inside baseDir/.vmc-data/fleet-intelligence.json
  const resolvedBase = path.resolve(baseDir);
  const dataDir = path.resolve(resolvedBase, ".vmc-data");
  const storePath = path.resolve(dataDir, "fleet-intelligence.json");
  if (!storePath.startsWith(dataDir + path.sep)) {
    throw new Error("Invalid fleet store path");
  }

  let state: FleetStoreState = loadState(storePath);

  function persist(): void {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmpPath = path.resolve(dataDir, `fleet-intelligence.${process.pid}.tmp`);
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
      fs.renameSync(tmpPath, storePath);
    } catch (err) {
      console.error("[fleet-store] persist failed:", err);
    }
  }

  router.get("/state", (_req: Request, res: Response) => {
    res.json(state);
  });

  router.put("/targets/:machineId", (req: Request, res: Response) => {
    const rawId = req.params.machineId;
    if (!isValidMachineId(rawId)) {
      res.status(400).json({ error: "Invalid machineId" });
      return;
    }
    const machineId = rawId.trim().toUpperCase();
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;

    const shiftTargetParts = cleanNum(body.shiftTargetParts, 1, 100000);
    const targetPartsPerHour = cleanNum(body.targetPartsPerHour, 0.05, 5000);
    const activeJob = cleanStr(body.activeJob, 80);
    const operator = cleanStr(body.operator, 60);
    const shiftLabel = cleanStr(body.shiftLabel, 32);

    if (
      body.shiftTargetParts !== undefined &&
      body.shiftTargetParts !== null &&
      body.shiftTargetParts !== "" &&
      shiftTargetParts === null
    ) {
      res.status(400).json({ error: "shiftTargetParts must be between 1 and 100000" });
      return;
    }
    if (
      body.targetPartsPerHour !== undefined &&
      body.targetPartsPerHour !== null &&
      body.targetPartsPerHour !== "" &&
      targetPartsPerHour === null
    ) {
      res.status(400).json({ error: "targetPartsPerHour must be between 0.05 and 5000" });
      return;
    }

    const record: ShiftTargetRecord = {
      machineId,
      shiftTargetParts: shiftTargetParts !== null ? Math.round(shiftTargetParts) : null,
      targetPartsPerHour: targetPartsPerHour !== null ? Math.round(targetPartsPerHour * 100) / 100 : null,
      activeJob,
      operator,
      shiftLabel,
      updatedAt: Date.now(),
    };
    state.targets[machineId] = record;
    persist();
    res.json({ ok: true, target: record, state });
  });

  router.post("/downtime", (req: Request, res: Response) => {
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    if (!isValidMachineId(body.machineId)) {
      res.status(400).json({ error: "Valid machineId is required" });
      return;
    }
    const reason = cleanStr(body.reason, 48);
    if (!REASON_SET.has(reason)) {
      res.status(400).json({ error: "Invalid downtime reason category" });
      return;
    }
    const durationMin = cleanNum(body.durationMin, 1, 10080);
    if (durationMin === null) {
      res.status(400).json({ error: "durationMin must be between 1 and 10080 minutes" });
      return;
    }

    const now = Date.now();
    const record: DowntimeLogRecord = {
      id: `dt_${crypto.randomUUID().slice(0, 12)}`,
      machineId: body.machineId.trim().toUpperCase(),
      reason: reason as DowntimeReason,
      durationMin: Math.round(durationMin),
      startTs: cleanTs(body.startTs, now - Math.round(durationMin) * 60000),
      operator: cleanStr(body.operator, 60),
      shiftLabel: cleanStr(body.shiftLabel, 32),
      note: cleanStr(body.note, 400),
      createdAt: now,
    };

    state.downtimeLogs.unshift(record);
    if (state.downtimeLogs.length > MAX_LOGS) {
      state.downtimeLogs = state.downtimeLogs.slice(0, MAX_LOGS);
    }
    persist();
    res.status(201).json({ ok: true, entry: record, state });
  });

  router.delete("/downtime/:id", (req: Request, res: Response) => {
    const id = req.params.id;
    if (typeof id !== "string" || !RECORD_ID_RE.test(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const before = state.downtimeLogs.length;
    state.downtimeLogs = state.downtimeLogs.filter((r) => r.id !== id);
    if (state.downtimeLogs.length === before) {
      res.status(404).json({ error: "Downtime entry not found" });
      return;
    }
    persist();
    res.json({ ok: true, state });
  });

  router.post("/repairs", (req: Request, res: Response) => {
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    if (!isValidMachineId(body.machineId)) {
      res.status(400).json({ error: "Valid machineId is required" });
      return;
    }
    const faultTitle = cleanStr(body.faultTitle, 120);
    if (!faultTitle) {
      res.status(400).json({ error: "faultTitle is required" });
      return;
    }
    const downtimeMin = cleanNum(body.downtimeMin, 0, 43200);
    const repairMin = cleanNum(body.repairMin, 0, 43200);
    if (downtimeMin === null || repairMin === null) {
      res.status(400).json({ error: "downtimeMin and repairMin must be valid non-negative minutes" });
      return;
    }
    const status = body.status === "open" ? "open" : "resolved";
    const now = Date.now();
    const startedAt = cleanTs(body.startedAt, now - Math.round(downtimeMin) * 60000);
    const resolvedAt = status === "resolved" ? cleanTs(body.resolvedAt, now) : null;

    const record: RepairLogRecord = {
      id: `rp_${crypto.randomUUID().slice(0, 12)}`,
      machineId: body.machineId.trim().toUpperCase(),
      faultTitle,
      rootCause: cleanStr(body.rootCause, 160),
      actionTaken: cleanStr(body.actionTaken, 400),
      partsReplaced: cleanStr(body.partsReplaced, 160),
      downtimeMin: Math.round(downtimeMin),
      repairMin: Math.round(repairMin),
      technician: cleanStr(body.technician, 60),
      status,
      startedAt,
      resolvedAt,
      createdAt: now,
    };

    state.repairLogs.unshift(record);
    if (state.repairLogs.length > MAX_LOGS) {
      state.repairLogs = state.repairLogs.slice(0, MAX_LOGS);
    }
    persist();
    res.status(201).json({ ok: true, entry: record, state });
  });

  router.patch("/repairs/:id", (req: Request, res: Response) => {
    const id = req.params.id;
    if (typeof id !== "string" || !RECORD_ID_RE.test(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const rec = state.repairLogs.find((r) => r.id === id);
    if (!rec) {
      res.status(404).json({ error: "Repair entry not found" });
      return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    if (body.status === "open" || body.status === "resolved") {
      rec.status = body.status;
      rec.resolvedAt = body.status === "resolved" ? cleanTs(body.resolvedAt, Date.now()) : null;
    }
    if (body.actionTaken !== undefined) rec.actionTaken = cleanStr(body.actionTaken, 400);
    if (body.rootCause !== undefined) rec.rootCause = cleanStr(body.rootCause, 160);
    if (body.partsReplaced !== undefined) rec.partsReplaced = cleanStr(body.partsReplaced, 160);
    if (body.technician !== undefined) rec.technician = cleanStr(body.technician, 60);
    if (body.repairMin !== undefined) {
      const rm = cleanNum(body.repairMin, 0, 43200);
      if (rm !== null) rec.repairMin = Math.round(rm);
    }
    if (body.downtimeMin !== undefined) {
      const dm = cleanNum(body.downtimeMin, 0, 43200);
      if (dm !== null) rec.downtimeMin = Math.round(dm);
    }
    persist();
    res.json({ ok: true, entry: rec, state });
  });

  router.delete("/repairs/:id", (req: Request, res: Response) => {
    const id = req.params.id;
    if (typeof id !== "string" || !RECORD_ID_RE.test(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const before = state.repairLogs.length;
    state.repairLogs = state.repairLogs.filter((r) => r.id !== id);
    if (state.repairLogs.length === before) {
      res.status(404).json({ error: "Repair entry not found" });
      return;
    }
    persist();
    res.json({ ok: true, state });
  });

  return router;
}

function loadState(storePath: string): FleetStoreState {
  try {
    if (!fs.existsSync(storePath)) return emptyState();
    const raw = fs.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyState();
    return {
      targets: parsed.targets && typeof parsed.targets === "object" ? parsed.targets : {},
      downtimeLogs: Array.isArray(parsed.downtimeLogs) ? parsed.downtimeLogs.slice(0, MAX_LOGS) : [],
      repairLogs: Array.isArray(parsed.repairLogs) ? parsed.repairLogs.slice(0, MAX_LOGS) : [],
    };
  } catch {
    return emptyState();
  }
}
