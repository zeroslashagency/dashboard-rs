/* VMC Fleet Intelligence — Shop-Floor Persistence Client.
 *
 * Syncs Shift Targets, Downtime Root-Cause Logs, and Verified Breakdown/Repair
 * Logs with the Express server (`/api/fleet/*`). Mirrors state to localStorage
 * as a resilient fallback if the frontend is served statically without write
 * routes.
 */

const LS_KEY = "vmc_fleet_intelligence_store_v1";

function emptyState() {
  return { targets: {}, downtimeLogs: [], repairLogs: [] };
}

function readLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return emptyState();
    const p = JSON.parse(raw);
    return {
      targets: p && typeof p.targets === "object" && p.targets ? p.targets : {},
      downtimeLogs: Array.isArray(p?.downtimeLogs) ? p.downtimeLogs : [],
      repairLogs: Array.isArray(p?.repairLogs) ? p.repairLogs : [],
    };
  } catch {
    return emptyState();
  }
}

function writeLocal(state) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {}
}

let cachedState = readLocal();
let serverAvailable = true;

function apiUrl(path) {
  const origin = typeof window !== "undefined" && window.location ? window.location.origin : "";
  return `${origin}/api/fleet${path}`;
}

async function req(path, opts = {}) {
  const resp = await fetch(apiUrl(path), {
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data.error || `HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return data;
}

export const fleetStore = {
  getCached() {
    return cachedState;
  },

  isServerBacked() {
    return serverAvailable;
  },

  async load() {
    try {
      const data = await req("/state", { method: "GET" });
      if (data && typeof data === "object") {
        cachedState = {
          targets: data.targets && typeof data.targets === "object" ? data.targets : {},
          downtimeLogs: Array.isArray(data.downtimeLogs) ? data.downtimeLogs : [],
          repairLogs: Array.isArray(data.repairLogs) ? data.repairLogs : [],
        };
        serverAvailable = true;
        writeLocal(cachedState);
      }
    } catch {
      serverAvailable = false;
      cachedState = readLocal();
    }
    return cachedState;
  },

  async saveTarget(machineId, payload) {
    const id = String(machineId || "").trim().toUpperCase();
    try {
      const res = await req(`/targets/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      if (res.state) cachedState = res.state;
      serverAvailable = true;
      writeLocal(cachedState);
      return cachedState;
    } catch (err) {
      if (err.status && err.status >= 400 && err.status < 500) throw err;
      // Offline / static-host fallback
      serverAvailable = false;
      cachedState = {
        ...cachedState,
        targets: {
          ...cachedState.targets,
          [id]: { machineId: id, ...payload, updatedAt: Date.now() },
        },
      };
      writeLocal(cachedState);
      return cachedState;
    }
  },

  async addDowntime(payload) {
    try {
      const res = await req("/downtime", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (res.state) cachedState = res.state;
      serverAvailable = true;
      writeLocal(cachedState);
      return cachedState;
    } catch (err) {
      if (err.status && err.status >= 400 && err.status < 500) throw err;
      serverAvailable = false;
      const entry = {
        id: `dt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        machineId: String(payload.machineId || "").toUpperCase(),
        reason: payload.reason,
        durationMin: Math.round(Number(payload.durationMin) || 0),
        startTs: payload.startTs || Date.now() - (Number(payload.durationMin) || 0) * 60000,
        operator: payload.operator || "",
        shiftLabel: payload.shiftLabel || "",
        note: payload.note || "",
        createdAt: Date.now(),
      };
      cachedState = { ...cachedState, downtimeLogs: [entry, ...cachedState.downtimeLogs] };
      writeLocal(cachedState);
      return cachedState;
    }
  },

  async deleteDowntime(id) {
    try {
      const res = await req(`/downtime/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.state) cachedState = res.state;
      serverAvailable = true;
      writeLocal(cachedState);
      return cachedState;
    } catch (err) {
      if (err.status && err.status >= 400 && err.status < 500) throw err;
      serverAvailable = false;
      cachedState = {
        ...cachedState,
        downtimeLogs: cachedState.downtimeLogs.filter((r) => r.id !== id),
      };
      writeLocal(cachedState);
      return cachedState;
    }
  },

  async addRepair(payload) {
    try {
      const res = await req("/repairs", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (res.state) cachedState = res.state;
      serverAvailable = true;
      writeLocal(cachedState);
      return cachedState;
    } catch (err) {
      if (err.status && err.status >= 400 && err.status < 500) throw err;
      serverAvailable = false;
      const now = Date.now();
      const entry = {
        id: `rp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        machineId: String(payload.machineId || "").toUpperCase(),
        faultTitle: payload.faultTitle,
        rootCause: payload.rootCause || "",
        actionTaken: payload.actionTaken || "",
        partsReplaced: payload.partsReplaced || "",
        downtimeMin: Math.round(Number(payload.downtimeMin) || 0),
        repairMin: Math.round(Number(payload.repairMin) || 0),
        technician: payload.technician || "",
        status: payload.status === "open" ? "open" : "resolved",
        startedAt: payload.startedAt || now - (Number(payload.downtimeMin) || 0) * 60000,
        resolvedAt: payload.status === "open" ? null : now,
        createdAt: now,
      };
      cachedState = { ...cachedState, repairLogs: [entry, ...cachedState.repairLogs] };
      writeLocal(cachedState);
      return cachedState;
    }
  },

  async updateRepair(id, patch) {
    try {
      const res = await req(`/repairs/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (res.state) cachedState = res.state;
      serverAvailable = true;
      writeLocal(cachedState);
      return cachedState;
    } catch (err) {
      if (err.status && err.status >= 400 && err.status < 500) throw err;
      serverAvailable = false;
      cachedState = {
        ...cachedState,
        repairLogs: cachedState.repairLogs.map((r) =>
          r.id === id
            ? {
                ...r,
                ...patch,
                resolvedAt: patch.status === "resolved" ? Date.now() : r.resolvedAt,
              }
            : r
        ),
      };
      writeLocal(cachedState);
      return cachedState;
    }
  },

  async deleteRepair(id) {
    try {
      const res = await req(`/repairs/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.state) cachedState = res.state;
      serverAvailable = true;
      writeLocal(cachedState);
      return cachedState;
    } catch (err) {
      if (err.status && err.status >= 400 && err.status < 500) throw err;
      serverAvailable = false;
      cachedState = {
        ...cachedState,
        repairLogs: cachedState.repairLogs.filter((r) => r.id !== id),
      };
      writeLocal(cachedState);
      return cachedState;
    }
  },
};
