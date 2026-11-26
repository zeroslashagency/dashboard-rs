/* Interactive NC Program Card Pull-Out Folio (Style 1 — Pastel Card Unfold).
 * Self-contained controller invoked by app.js when an operator clicks any peeking NC card
 * in .pw-stack or the active NC job inside .pw-pocket. Uses compositor-only FLIP transforms,
 * physical slide-out-of-pocket motion, and real /api/history_range telemetry. */
(function () {
  "use strict";

  const US_PER_MS = 1000;
  const RUN_STATES = new Set(["ACTIVE", "EXECUTING", "RUNNING"]);
  const PAUSE_STATES = new Set(["FEED_HOLD", "INTERRUPTED", "PROGRAM_STOPPED", "OPTIONAL_STOP", "HELD"]);
  const IDLE_STATES = new Set(["STOPPED", "READY", "PROGRAM_COMPLETED", "WAIT"]);
  const NO_ALARM = new Set(["", "NO ACTIVE ALARMS", "NONE", "OK", "NORMAL", "UNAVAILABLE"]);

  const detailCache = new Map(); // key -> { at, data }
  const CACHE_DONE_MS = 60 * 1000;
  const CACHE_LIVE_MS = 8 * 1000;

  let els = null;
  let activeState = null; // { machineId, machineName, apiBase, slots, currentIdx, sourceEl, liveTimer, abortCtrl, lastFocus }
  let isAnimatingClose = false;

  const prefersReducedMotion = () =>
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function tsToMs(ts) {
    const v = Number(ts);
    if (!Number.isFinite(v) || v <= 0) return NaN;
    return v > 1e14 ? v / 1000 : v;
  }

  function fmtDur(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "—";
    const totalSec = Math.round(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return m > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${h}h`;
    return s > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${m}m`;
  }

  function fmtCycle(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "—";
    const totalSec = Math.round(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    if (m >= 60) {
      const h = Math.floor(m / 60);
      return `${h}h ${String(m % 60).padStart(2, "0")}m`;
    }
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }

  function fmtClock(ms) {
    if (!Number.isFinite(ms)) return "—";
    try {
      return new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      }).format(new Date(ms));
    } catch (_) {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
  }

  function fmtClockSec(ms) {
    if (!Number.isFinite(ms)) return "—";
    try {
      return new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date(ms));
    } catch (_) {
      return fmtClock(ms);
    }
  }

  function fmtDateTag(ms) {
    if (!Number.isFinite(ms)) return "";
    const d = new Date(ms);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return "";
    try {
      return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(d);
    } catch (_) {
      return `${d.getMonth() + 1}/${d.getDate()}`;
    }
  }

  /* Plant shift mapping (IST: S1 06:00-14:00 Morning, S2 14:00-22:00 Afternoon, S3 22:00-06:00 Night) */
  function shiftForTimestamp(ms, fallbackShift) {
    if (fallbackShift) return fallbackShift;
    if (!Number.isFinite(ms)) return "";
    let hour = new Date(ms).getHours();
    try {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        hour12: false,
      }).formatToParts(new Date(ms));
      const hPart = parts.find((p) => p.type === "hour");
      if (hPart) hour = Number(hPart.value) % 24;
    } catch (_) {}
    if (hour >= 6 && hour < 14) return "S1 Morning";
    if (hour >= 14 && hour < 22) return "S2 Afternoon";
    return "S3 Night";
  }

  function fmtInt(n) {
    return Number.isFinite(Number(n)) ? Math.round(Number(n)).toLocaleString() : "—";
  }

  /* ---------- Build shared Style 1 Pastel Card + Forest Stitched Pocket overlay ---------- */
  function ensureDom() {
    if (els) return els;
    const backdrop = document.createElement("div");
    backdrop.className = "nc-folio-backdrop";
    backdrop.hidden = true;

    const host = document.createElement("div");
    host.className = "nc-folio-host";
    host.hidden = true;

    const folio = document.createElement("section");
    folio.className = "nc-folio";
    folio.setAttribute("role", "dialog");
    folio.setAttribute("aria-modal", "true");
    folio.setAttribute("aria-labelledby", "ncFolioTitle");
    folio.innerHTML = `
      <div class="nc-folio-back-ears" aria-hidden="true"></div>

      <div class="nc-folio-card" data-f="card">
        <div class="nc-card-head">
          <div class="nc-card-prog" id="ncFolioTitle">
            <span class="nc-folio-live-dot" data-f="liveDot" hidden></span>
            <span class="nc-card-prog-text" data-f="progName">—</span>
          </div>
          <div class="nc-card-head-right">
            <span class="nc-card-sub" data-f="subLine">—</span>
            <button type="button" class="nc-folio-close" data-f="closeBtn" aria-label="Tuck card back into wallet" title="Close (Esc)">✕</button>
          </div>
        </div>

        <div class="nc-folio-times">
          <div class="nc-time-cell">
            <span class="nc-lbl">Start</span>
            <span class="nc-time-val" data-f="startTime">—</span>
            <span class="nc-time-date" data-f="startDate"></span>
          </div>
          <span class="nc-time-arrow" aria-hidden="true">
            <svg viewBox="0 0 22 14" fill="none">
              <path d="M1 7h19m0 0-5-5m5 5-5 5" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </span>
          <div class="nc-time-cell">
            <span class="nc-lbl">End</span>
            <span class="nc-time-val" data-f="endTime">—</span>
            <span class="nc-time-date" data-f="endDate"></span>
          </div>
          <div class="nc-time-cell nc-time-cell--dur">
            <span class="nc-lbl">Total Duration</span>
            <span class="nc-time-val" data-f="duration">—</span>
            <span class="nc-time-date" data-f="durNote"></span>
          </div>
        </div>

        <div class="nc-folio-metrics">
          <div class="nc-met">
            <span class="nc-met-val" data-f="partsVal">—</span>
            <span class="nc-met-lbl">Parts completed</span>
            <span class="nc-met-sub" data-f="partsSub"></span>
          </div>
          <div class="nc-met">
            <span class="nc-met-val" data-f="avgCycleVal">—</span>
            <span class="nc-met-lbl">Average cycle time</span>
            <span class="nc-met-sub" data-f="avgCycleSub"></span>
          </div>
          <div class="nc-met">
            <span class="nc-lbl">Run vs Stopped</span>
            <div class="nc-up-track" data-f="upTrack">
              <span class="nc-up-run" data-f="upRunBar" style="width:0%"></span>
              <span class="nc-up-stop" data-f="upStopBar" style="width:0%"></span>
            </div>
            <span class="nc-up-caption" data-f="upCaption">—</span>
          </div>
          <div class="nc-met">
            <span class="nc-met-val" data-f="alarmVal">0</span>
            <span class="nc-met-lbl" data-f="alarmLbl">Alarms</span>
          </div>
        </div>

        <div class="nc-alarm-list" data-f="alarmList" hidden></div>

        <div class="nc-folio-live" data-f="liveWrap" hidden>
          <div class="nc-live-head">
            <span class="nc-lbl" data-f="liveLabel">Active Cycle Progress</span>
            <span class="nc-live-pct" data-f="livePct">—</span>
          </div>
          <div class="cycle-panel-bar pw-bar" data-f="liveBarTrack" data-zero="1">
            <span class="pw-bar-dot" aria-hidden="true"></span>
            <span class="pw-bar-fill" data-f="liveBar" style="width:0%">
              <span class="pw-bar-flare" aria-hidden="true"></span>
            </span>
          </div>
          <div class="nc-live-meta">
            <span data-f="liveLeft">—</span>
            <span data-f="liveRight">—</span>
          </div>
        </div>

        <div class="nc-folio-cycles">
          <div class="nc-cyc-head">
            <span class="nc-cyc-title">Mini bar timeline</span>
            <span class="nc-cyc-readout" data-f="cycReadout">—</span>
          </div>
          <div class="nc-cyc-capsule" data-f="cycCapsule" role="list" aria-label="Completed part cycles"></div>
          <div class="nc-cyc-ticks" data-f="cycTicks" hidden></div>
        </div>
      </div>

      <div class="nc-folio-sleeve">
        <svg class="nc-sleeve-svg" viewBox="0 0 600 96" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="ncSleeveGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#254220" />
              <stop offset="55%" stop-color="#1b3317" />
              <stop offset="100%" stop-color="#132510" />
            </linearGradient>
          </defs>
          <path fill="url(#ncSleeveGrad)" d="M 18,4 L 198,4 C 228,4 242,24 276,24 L 324,24 C 358,24 372,4 402,4 L 582,4 Q 598,4 598,20 L 598,66 Q 598,94 568,94 L 32,94 Q 2,94 2,66 L 2,20 Q 2,4 18,4 Z" />
          <path class="nc-sleeve-stitch" d="M 20,10 L 196,10 C 224,10 238,30 276,30 L 324,30 C 362,30 376,10 404,10 L 580,10 Q 592,10 592,22 L 592,64 Q 592,88 566,88 L 34,88 Q 8,88 8,64 L 8,22 Q 8,10 20,10 Z" fill="none" vector-effect="non-scaling-stroke" />
          <path class="nc-sleeve-rim" d="M 18,4.5 L 198,4.5 C 228,4.5 242,24.5 276,24.5 L 324,24.5 C 358,24.5 372,4.5 402,4.5 L 582,4.5" fill="none" vector-effect="non-scaling-stroke" />
        </svg>
        <div class="nc-folio-slots" data-f="slotBar" role="tablist" aria-label="Switch NC program card"></div>
      </div>
    `;

    host.appendChild(folio);
    document.body.appendChild(backdrop);
    document.body.appendChild(host);

    const f = {};
    folio.querySelectorAll("[data-f]").forEach((el) => { f[el.dataset.f] = el; });
    els = { backdrop, host, folio, f };

    backdrop.addEventListener("click", () => close());
    f.closeBtn.addEventListener("click", () => close());
    document.addEventListener("keydown", onKeyDown);

    return els;
  }

  function onKeyDown(e) {
    if (!activeState || isAnimatingClose) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      stepSlot(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      stepSlot(1);
    }
  }

  /* ---------- Telemetry Extraction Helpers ---------- */
  function extractPartCycles(cntRows, fromMs, toMs) {
    if (!Array.isArray(cntRows) || !cntRows.length) return [];
    const sorted = cntRows
      .map((r) => ({ ts: tsToMs(r.ts), v: Number(r.val_num ?? r.num ?? r.val) }))
      .filter((r) => Number.isFinite(r.ts) && Number.isFinite(r.v))
      .sort((a, b) => a.ts - b.ts);

    const events = [];
    let lastV = null;
    let lastTs = Number.isFinite(fromMs) ? fromMs : null;
    let partIdx = 0;

    for (const r of sorted) {
      if (Number.isFinite(fromMs) && r.ts < fromMs) {
        lastV = r.v;
        continue;
      }
      if (Number.isFinite(toMs) && r.ts > toMs) break;
      if (lastV == null) {
        lastV = r.v;
        lastTs = r.ts;
        continue;
      }
      const delta = r.v > lastV ? Math.round(r.v - lastV) : (r.v < lastV ? Math.round(r.v) : 0);
      if (delta > 0) {
        const span = lastTs != null && r.ts > lastTs ? r.ts - lastTs : null;
        const perPart = span != null ? span / delta : null;
        for (let k = 0; k < Math.min(delta, 100); k++) {
          partIdx += 1;
          events.push({
            partNumber: partIdx,
            completedAt: r.ts,
            cycleMs: perPart != null && perPart >= 2000 && perPart <= 6 * 3600 * 1000 ? perPart : null,
          });
        }
        lastTs = r.ts;
      }
      lastV = r.v;
    }
    return events;
  }

  function computeRunStop(rstatRows, fromMs, toMs) {
    if (!Array.isArray(rstatRows) || !rstatRows.length || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
      return null;
    }
    const sorted = rstatRows
      .map((r) => ({ ts: tsToMs(r.ts), val: String(r.val || "").trim().toUpperCase() }))
      .filter((r) => Number.isFinite(r.ts))
      .sort((a, b) => a.ts - b.ts);
    if (!sorted.length) return null;

    let runMs = 0;
    let stopMs = 0;
    let curState = null;
    let curTs = fromMs;

    for (const r of sorted) {
      if (r.ts <= fromMs) {
        curState = r.val;
        continue;
      }
      if (r.ts >= toMs) break;
      if (curState != null) {
        const dt = Math.max(0, r.ts - curTs);
        if (RUN_STATES.has(curState)) runMs += dt;
        else if (PAUSE_STATES.has(curState) || IDLE_STATES.has(curState) || curState) stopMs += dt;
      }
      curState = r.val;
      curTs = r.ts;
    }
    if (curState != null && toMs > curTs) {
      const dt = Math.max(0, toMs - curTs);
      if (RUN_STATES.has(curState)) runMs += dt;
      else stopMs += dt;
    }
    const total = runMs + stopMs;
    if (total <= 0) return null;
    return {
      runMs,
      stopMs,
      uptimePct: (runMs / total) * 100,
    };
  }

  function computeAlarms(alarmRows, estopRows, fromMs, toMs) {
    const events = [];
    let alarmCount = 0;
    let estopCount = 0;

    if (Array.isArray(alarmRows)) {
      let prevActive = false;
      const sorted = alarmRows
        .map((r) => ({ ts: tsToMs(r.ts), val: String(r.val || "").trim() }))
        .filter((r) => Number.isFinite(r.ts))
        .sort((a, b) => a.ts - b.ts);
      for (const r of sorted) {
        const up = r.val.toUpperCase();
        const isAct = !NO_ALARM.has(up);
        if (r.ts < fromMs) { prevActive = isAct; continue; }
        if (Number.isFinite(toMs) && r.ts > toMs) break;
        if (isAct && !prevActive) {
          alarmCount += 1;
          events.push({ code: r.val, ts: r.ts, kind: "ALARM" });
        }
        prevActive = isAct;
      }
    }

    if (Array.isArray(estopRows)) {
      let prevEs = false;
      const sorted = estopRows
        .map((r) => ({ ts: tsToMs(r.ts), val: String(r.val || "").trim().toUpperCase() }))
        .filter((r) => Number.isFinite(r.ts))
        .sort((a, b) => a.ts - b.ts);
      for (const r of sorted) {
        const isAct = !!r.val && r.val !== "ARMED" && r.val !== "UNAVAILABLE";
        if (r.ts < fromMs) { prevEs = isAct; continue; }
        if (Number.isFinite(toMs) && r.ts > toMs) break;
        if (isAct && !prevEs) {
          estopCount += 1;
          events.push({ code: "E-STOP TRIGGERED", ts: r.ts, kind: "ESTOP" });
        }
        prevEs = isAct;
      }
    }

    events.sort((a, b) => b.ts - a.ts);
    return { alarmCount, estopCount, events: events.slice(0, 4) };
  }

  async function fetchRangeItem(apiBase, machineId, item, fromMs, toMs, signal) {
    const fromUs = Math.round(fromMs * US_PER_MS);
    const toUs = Math.round(toMs * US_PER_MS);
    const url =
      `${apiBase}/api/history_range?machine=${encodeURIComponent(machineId)}` +
      `&item=${encodeURIComponent(item)}&from=${fromUs}&to=${toUs}&max=16000&anchor=1`;
    const r = await fetch(url, { signal, cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  }

  /* ---------- Painting Sections ---------- */
  function paintHeaderAndTimes(slot) {
    const { folio, f } = ensureDom();
    const slotKey = slot.live ? "live" : String(slot.slotIdx ?? 2);
    folio.dataset.slot = slotKey;
    folio.dataset.live = slot.live ? "1" : "0";

    f.progName.textContent = slot.name || "Unknown Program";
    f.liveDot.hidden = !slot.live;

    const fromMs = tsToMs(slot.from);
    const toTimeMs = slot.live ? Date.now() : tsToMs(slot.to);
    const shiftStr = shiftForTimestamp(fromMs, slot.shiftLabel);
    const subParts = [activeState.machineName || activeState.machineId];
    if (shiftStr) subParts.push(shiftStr);
    f.subLine.textContent = subParts.filter(Boolean).join(" · ");

    f.startTime.textContent = Number.isFinite(fromMs) ? fmtClock(fromMs) : "—";
    f.startDate.textContent = Number.isFinite(fromMs) ? fmtDateTag(fromMs) : "";

    if (slot.live) {
      f.endTime.textContent = "LIVE";
      f.endTime.classList.add("nc-time-val--live");
      f.endDate.textContent = "Running now";
    } else {
      f.endTime.textContent = Number.isFinite(toTimeMs) ? fmtClock(toTimeMs) : "—";
      f.endTime.classList.remove("nc-time-val--live");
      f.endDate.textContent = Number.isFinite(toTimeMs) ? fmtDateTag(toTimeMs) : "";
    }

    const durMs = Number.isFinite(fromMs) && Number.isFinite(toTimeMs) && toTimeMs >= fromMs
      ? toTimeMs - fromMs
      : NaN;
    f.duration.textContent = Number.isFinite(durMs) ? fmtDur(durMs) : "—";
    f.durNote.textContent = "";

    const partsNum = slot.count != null && Number.isFinite(Number(slot.count)) ? Number(slot.count) : null;
    f.partsVal.textContent = partsNum != null ? `${fmtInt(partsNum)} pcs` : "—";
    if (partsNum != null && Number.isFinite(durMs) && durMs > 60000 && partsNum > 0) {
      const pph = (partsNum / (durMs / 3600000)).toFixed(1);
      f.partsSub.textContent = `${pph} pcs/hr`;
    } else {
      f.partsSub.textContent = "";
    }

    if (partsNum != null && partsNum > 0 && Number.isFinite(durMs) && durMs > 0) {
      f.avgCycleVal.textContent = fmtCycle(durMs / partsNum);
      f.avgCycleSub.textContent = "";
    } else {
      f.avgCycleVal.textContent = "—";
      f.avgCycleSub.textContent = "";
    }

    f.liveWrap.hidden = !slot.live;
    if (slot.live && slot.liveSnap) {
      paintLiveSnap(slot.liveSnap);
    }
  }

  function paintLiveSnap(snap) {
    if (!els || !snap) return;
    const { f } = els;
    f.liveLabel.textContent = snap.label || "Active Cycle Progress";
    f.livePct.textContent = snap.pctText || "—";
    const pct = Number.isFinite(snap.pct) ? Math.max(0, Math.min(100, snap.pct)) : 0;
    f.liveBar.style.width = `${pct.toFixed(1)}%`;
    f.liveBarTrack.dataset.zero = pct <= 0.5 ? "1" : "0";
    f.liveBarTrack.dataset.nearEnd = pct >= 89 ? "1" : "0";
    f.liveBarTrack.dataset.paused = snap.paused ? "1" : "0";
    f.liveLeft.textContent = snap.metaLeft || "";
    f.liveRight.textContent = snap.metaRight || "";
    if (snap.parts != null && Number.isFinite(Number(snap.parts))) {
      f.partsVal.textContent = `${fmtInt(snap.parts)} pcs`;
    }
  }

  function paintHydrationLoading(slot) {
    const { f } = ensureDom();
    f.upRunBar.style.width = "0%";
    f.upStopBar.style.width = "0%";
    f.upCaption.textContent = "Syncing history…";
    f.alarmVal.textContent = "…";
    f.alarmVal.classList.remove("has-alarm");
    f.alarmLbl.textContent = "Alarms";
    f.alarmList.hidden = true;

    if (slot.initialCycles && slot.initialCycles.length) {
      paintCycleTimeline(slot.initialCycles);
    } else {
      f.cycReadout.textContent = "Loading…";
      f.cycTicks.hidden = true;
      f.cycCapsule.innerHTML = "";
      for (let i = 0; i < 24; i++) {
        const sk = document.createElement("span");
        sk.className = "nc-cyc-bar";
        sk.style.pointerEvents = "none";
        const fill = document.createElement("span");
        fill.className = "nc-cyc-bar-fill nc-shimmer";
        fill.style.height = `${28 + ((i * 23) % 60)}%`;
        sk.appendChild(fill);
        f.cycCapsule.appendChild(sk);
      }
    }
  }

  function paintCycleTimeline(cycles) {
    const { f } = ensureDom();
    f.cycCapsule.innerHTML = "";
    f.cycTicks.innerHTML = "";
    if (!cycles || !cycles.length) {
      f.cycReadout.textContent = "No part ticks recorded";
      f.cycTicks.hidden = true;
      const empty = document.createElement("div");
      empty.className = "nc-cyc-empty";
      empty.textContent = "No individual part cycle ticks recorded in this NC window.";
      f.cycCapsule.appendChild(empty);
      return;
    }

    const validDurs = cycles.map((c) => c.cycleMs).filter((d) => Number.isFinite(d) && d > 0);
    const sortedDurs = validDurs.slice().sort((a, b) => a - b);
    const median = sortedDurs.length ? sortedDurs[Math.floor(sortedDurs.length / 2)] : null;
    const minDur = sortedDurs.length ? sortedDurs[0] : null;
    const maxDur = sortedDurs.length ? sortedDurs[sortedDurs.length - 1] : null;
    const meanDur = validDurs.length ? validDurs.reduce((a, b) => a + b, 0) / validDurs.length : null;

    if (meanDur != null) {
      f.avgCycleVal.textContent = fmtCycle(meanDur);
      f.avgCycleSub.textContent =
        minDur != null && maxDur != null && sortedDurs.length > 1
          ? `${fmtCycle(minDur)}–${fmtCycle(maxDur)}`
          : "";
    }

    const defaultSummary =
      minDur != null && maxDur != null && sortedDurs.length > 1
        ? `${cycles.length} cycles · fast ${fmtCycle(minDur)} · slow ${fmtCycle(maxDur)}`
        : `${cycles.length} part${cycles.length === 1 ? "" : "s"} completed`;
    f.cycReadout.textContent = defaultSummary;

    // Cap rendered bars to 44 for crisp Style 1 spacing while preserving peak spikes
    let display = cycles;
    if (cycles.length > 44) {
      const step = cycles.length / 44;
      display = [];
      for (let i = 0; i < 44; i++) {
        const start = Math.floor(i * step);
        const end = Math.max(start + 1, Math.floor((i + 1) * step));
        let pick = cycles[start];
        for (let j = start + 1; j < end && j < cycles.length; j++) {
          if ((cycles[j].cycleMs || 0) > (pick.cycleMs || 0)) pick = cycles[j];
        }
        display.push(pick);
      }
    }

    const scaleMax = Math.max(maxDur || 60000, (median || 60000) * 1.35);
    let activeBtn = null;

    const showItem = (item, btn) => {
      if (activeBtn && activeBtn !== btn) activeBtn.classList.remove("is-active");
      activeBtn = btn;
      if (btn) btn.classList.add("is-active");
      const durTxt = item.cycleMs != null ? ` · ${fmtCycle(item.cycleMs)}` : "";
      f.cycReadout.textContent = `Part #${item.partNumber} · ${fmtClockSec(item.completedAt)}${durTxt}`;
    };

    display.forEach((item) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nc-cyc-bar";
      btn.setAttribute("role", "listitem");
      const durTxt = item.cycleMs != null ? fmtCycle(item.cycleMs) : "completed";
      btn.setAttribute("aria-label", `Part ${item.partNumber}, ${fmtClockSec(item.completedAt)}, ${durTxt}`);

      const ratio = item.cycleMs != null ? Math.max(0.2, Math.min(1, item.cycleMs / scaleMax)) : 0.48;
      if (median && item.cycleMs != null) {
        if (item.cycleMs > median * 1.25) btn.classList.add("is-slow");
        else if (item.cycleMs <= median * 0.92) btn.classList.add("is-fast");
      }

      const fill = document.createElement("span");
      fill.className = "nc-cyc-bar-fill";
      fill.style.height = `${Math.round(ratio * 100)}%`;
      btn.appendChild(fill);

      btn.addEventListener("mouseenter", () => showItem(item, btn));
      btn.addEventListener("focus", () => showItem(item, btn));
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        showItem(item, btn);
      });
      f.cycCapsule.appendChild(btn);
    });

    // Clean evenly-spaced part number ticks underneath the bar strip (#1 ... #N)
    const tickCount = Math.min(7, display.length);
    if (tickCount >= 2) {
      const seen = new Set();
      for (let t = 0; t < tickCount; t++) {
        const idx = Math.round((t * (display.length - 1)) / (tickCount - 1));
        const num = display[idx].partNumber;
        if (seen.has(num)) continue;
        seen.add(num);
        const sp = document.createElement("span");
        sp.textContent = `#${num}`;
        f.cycTicks.appendChild(sp);
      }
      f.cycTicks.hidden = false;
    } else {
      const sp = document.createElement("span");
      sp.textContent = `#${display[0].partNumber}`;
      f.cycTicks.appendChild(sp);
      f.cycTicks.hidden = false;
    }

    f.cycCapsule.onmouseleave = () => {
      if (activeBtn) { activeBtn.classList.remove("is-active"); activeBtn = null; }
      f.cycReadout.textContent = defaultSummary;
    };
  }

  function paintHydratedDetail(detail, slot) {
    const { f } = ensureDom();

    if (detail.runStop) {
      const { runMs, stopMs, uptimePct } = detail.runStop;
      const runW = Math.max(0, Math.min(100, uptimePct));
      const stopW = Math.max(0, 100 - runW);

      f.upRunBar.style.width = `${runW.toFixed(1)}%`;
      f.upRunBar.dataset.full = stopW < 0.5 ? "1" : "0";
      f.upStopBar.style.width = `${stopW.toFixed(1)}%`;
      f.upStopBar.dataset.full = runW < 0.5 ? "1" : "0";

      f.upCaption.textContent = `${fmtDur(runMs)} / ${fmtDur(stopMs)} Stopped`;
      f.upCaption.title = `${uptimePct.toFixed(1)}% active run time`;
    } else {
      f.upRunBar.style.width = "0%";
      f.upStopBar.style.width = "0%";
      f.upCaption.textContent = "No state log";
    }

    const al = detail.alarms || { alarmCount: 0, estopCount: 0, events: [] };
    const totalInc = al.alarmCount + al.estopCount;
    f.alarmVal.textContent = String(totalInc);
    f.alarmVal.classList.toggle("has-alarm", totalInc > 0);
    f.alarmLbl.textContent = totalInc === 1 ? "Alarm" : "Alarms";

    if (al.events.length > 0) {
      f.alarmList.innerHTML = "";
      al.events.forEach((ev) => {
        const row = document.createElement("div");
        row.className = "nc-alarm-item";
        const code = document.createElement("span");
        code.className = "nc-alarm-code";
        code.textContent = `${ev.kind}: ${ev.code}`;
        code.title = ev.code;
        const ts = document.createElement("span");
        ts.className = "nc-alarm-ts";
        ts.textContent = fmtClockSec(ev.ts);
        row.append(code, ts);
        f.alarmList.appendChild(row);
      });
      f.alarmList.hidden = false;
    } else {
      f.alarmList.hidden = true;
    }

    if (detail.cycles && detail.cycles.length && slot.count == null) {
      f.partsVal.textContent = `${fmtInt(detail.cycles.length)} pcs`;
    }
    paintCycleTimeline(detail.cycles || []);
  }

  function paintHydrationError(slot) {
    const { f } = ensureDom();
    f.upCaption.textContent = "History unavailable";
    f.alarmVal.textContent = "—";
    if (!slot.initialCycles || !slot.initialCycles.length) {
      f.cycReadout.textContent = "Sync failed";
      f.cycTicks.hidden = true;
      f.cycCapsule.innerHTML = "";
      const wrap = document.createElement("div");
      wrap.className = "nc-cyc-empty";
      const txt = document.createElement("span");
      txt.textContent = "History fetch timed out.";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nc-retry-btn";
      btn.textContent = "Retry";
      btn.addEventListener("click", () => hydrateCurrent(true));
      wrap.append(txt, btn);
      f.cycCapsule.appendChild(wrap);
    }
  }

  /* ---------- Slot Switcher Bar inside the Stitched Forest Leather Pocket ---------- */
  function renderSlotBar() {
    if (!activeState) return;
    const { f } = ensureDom();
    f.slotBar.innerHTML = "";
    activeState.slots.forEach((slot, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `nc-slot-btn${idx === activeState.currentIdx ? " is-current" : ""}`;
      btn.dataset.slot = slot.live ? "live" : String(slot.slotIdx ?? idx);
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", idx === activeState.currentIdx ? "true" : "false");
      btn.title = slot.live ? `Live: ${slot.name}` : slot.name;

      const sw = document.createElement("span");
      sw.className = "nc-slot-swatch";
      sw.setAttribute("aria-hidden", "true");
      const txt = document.createElement("span");
      txt.textContent = slot.live ? "LIVE" : slot.name;
      btn.append(sw, txt);
      btn.addEventListener("click", () => selectSlot(idx));
      f.slotBar.appendChild(btn);
    });
  }

  /* ---------- On-Demand Ranged History Hydration ---------- */
  async function hydrateCurrent(force) {
    if (!activeState) return;
    const slot = activeState.slots[activeState.currentIdx];
    if (!slot) return;

    if (activeState.abortCtrl) {
      try { activeState.abortCtrl.abort(); } catch (_) {}
    }

    const fromMs = tsToMs(slot.from);
    const toTimeMs = slot.live ? Date.now() : tsToMs(slot.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toTimeMs) || toTimeMs <= fromMs) {
      paintHydratedDetail({ runStop: null, alarms: { alarmCount: 0, estopCount: 0, events: [] }, cycles: slot.initialCycles || [] }, slot);
      return;
    }

    const cacheKey = `${activeState.machineId}|${Math.round(fromMs / 1000)}|${slot.live ? "live" : Math.round(toTimeMs / 1000)}`;
    const ttl = slot.live ? CACHE_LIVE_MS : CACHE_DONE_MS;
    const cached = !force && detailCache.get(cacheKey);
    if (cached && Date.now() - cached.at < ttl) {
      paintHydratedDetail(cached.data, slot);
      return;
    }

    paintHydrationLoading(slot);
    const ctrl = new AbortController();
    activeState.abortCtrl = ctrl;
    const timer = setTimeout(() => ctrl.abort(), 14000);

    try {
      const base = activeState.apiBase || "";
      const mid = activeState.machineId;
      const [rstat, m30, aalarms, estop] = await Promise.all([
        fetchRangeItem(base, mid, "rstat", fromMs, toTimeMs, ctrl.signal).catch(() => []),
        fetchRangeItem(base, mid, "m30c1", fromMs, toTimeMs, ctrl.signal).catch(() => []),
        fetchRangeItem(base, mid, "aalarms", fromMs, toTimeMs, ctrl.signal).catch(() => []),
        fetchRangeItem(base, mid, "estop", fromMs, toTimeMs, ctrl.signal).catch(() => []),
      ]);
      clearTimeout(timer);
      if (ctrl.signal.aborted || !activeState) return;

      let cntRows = m30;
      if (!cntRows.length) {
        const alt = await fetchRangeItem(base, mid, "Part_Count", fromMs, toTimeMs, ctrl.signal).catch(() => []);
        cntRows = alt.length ? alt : await fetchRangeItem(base, mid, "PartCount", fromMs, toTimeMs, ctrl.signal).catch(() => []);
      }

      const rangedCycles = extractPartCycles(cntRows, fromMs, toTimeMs);
      const cycles = rangedCycles.length ? rangedCycles : (slot.initialCycles || []);
      const runStop = computeRunStop(rstat, fromMs, toTimeMs);
      const alarms = computeAlarms(aalarms, estop, fromMs, toTimeMs);
      const data = { runStop, alarms, cycles };

      detailCache.set(cacheKey, { at: Date.now(), data });
      if (detailCache.size > 60) {
        const oldestKey = detailCache.keys().next().value;
        detailCache.delete(oldestKey);
      }
      paintHydratedDetail(data, slot);
    } catch (_) {
      clearTimeout(timer);
      if (ctrl.signal.aborted || !activeState) return;
      paintHydrationError(slot);
    }
  }

  /* ---------- Wallet Slot Source Element Tracking ---------- */
  function setPulledSource(el, pulled) {
    if (!el) return;
    if (el.classList.contains("pw-card")) el.classList.toggle("pw-card--pulled", pulled);
    else if (el.classList.contains("pw-pocket")) el.classList.toggle("pw-pocket--pulled", pulled);
  }

  function resolveSourceEl(slot) {
    if (!activeState || !slot) return null;
    if (slot.sourceEl && document.body.contains(slot.sourceEl)) return slot.sourceEl;
    const card = document.querySelector(`.machine-card[data-machine="${CSS.escape(activeState.machineId)}"]`);
    if (!card) return null;
    if (slot.live) return card.querySelector(".pw-pocket");
    return card.querySelector(`.pw-card[data-slot="${slot.slotIdx}"]`);
  }

  /* ---------- FLIP Pull-Out & Slide-Out-Of-Pocket Choreography ---------- */
  function open(payload) {
    if (!payload || !payload.slots || !payload.slots.length) return;
    ensureDom();
    if (activeState && activeState.sourceEl) setPulledSource(activeState.sourceEl, false);
    if (activeState && activeState.liveTimer) clearInterval(activeState.liveTimer);
    if (activeState && activeState.abortCtrl) try { activeState.abortCtrl.abort(); } catch (_) {}

    isAnimatingClose = false;
    const startIdx = Math.max(0, Math.min(payload.slots.length - 1, payload.initialIdx ?? 0));
    const slot = payload.slots[startIdx];

    activeState = {
      machineId: payload.machineId,
      machineName: payload.machineName || payload.machineId,
      apiBase: payload.apiBase || "",
      slots: payload.slots,
      currentIdx: startIdx,
      sourceEl: payload.sourceEl || null,
      liveTimer: null,
      abortCtrl: null,
      lastFocus: document.activeElement,
    };

    const srcEl = resolveSourceEl(slot);
    activeState.sourceEl = srcEl;
    const srcRect = payload.originRect || (srcEl ? srcEl.getBoundingClientRect() : null);

    paintHeaderAndTimes(slot);
    renderSlotBar();

    const { backdrop, host, folio, f } = els;
    backdrop.hidden = false;
    host.hidden = false;
    folio.classList.remove("is-swapping");
    folio.style.transition = "none";
    folio.style.transform = "none";
    folio.style.opacity = "1";

    if (srcEl) setPulledSource(srcEl, true);

    if (srcRect && !prefersReducedMotion()) {
      // Start with the pastel card partially tucked inside the leather pocket, then pull it UP as it flies to center
      folio.classList.add("is-tucked");
      const targetRect = folio.getBoundingClientRect();
      const dx = (srcRect.left + srcRect.width / 2) - (targetRect.left + targetRect.width / 2);
      const dy = (srcRect.top + srcRect.height / 2) - (targetRect.top + targetRect.height / 2) - 10;
      const sx = Math.max(0.32, Math.min(0.95, srcRect.width / Math.max(1, targetRect.width)));
      const sy = Math.max(0.18, Math.min(0.85, srcRect.height / Math.max(1, targetRect.height)));

      folio.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`;
      folio.style.opacity = "0.28";
      void folio.offsetWidth;

      requestAnimationFrame(() => {
        backdrop.classList.add("is-open");
        folio.style.transition =
          "transform 0.36s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.24s cubic-bezier(0.16, 1, 0.3, 1)";
        folio.style.transform = "translate3d(0, 0, 0) scale(1, 1)";
        folio.style.opacity = "1";
        // Release card upward out of the stitched forest leather pocket
        setTimeout(() => {
          if (activeState && !isAnimatingClose) folio.classList.remove("is-tucked");
        }, 45);
      });
    } else {
      folio.classList.remove("is-tucked");
      requestAnimationFrame(() => backdrop.classList.add("is-open"));
    }

    if (f.closeBtn) f.closeBtn.focus({ preventScroll: true });
    hydrateCurrent(false);
    armLiveTicker();
  }

  function armLiveTicker() {
    if (!activeState) return;
    if (activeState.liveTimer) { clearInterval(activeState.liveTimer); activeState.liveTimer = null; }
    const slot = activeState.slots[activeState.currentIdx];
    if (!slot || !slot.live) return;
    activeState.liveTimer = setInterval(() => {
      if (!activeState) return;
      const cur = activeState.slots[activeState.currentIdx];
      if (!cur || !cur.live) return;
      const fromMs = tsToMs(cur.from);
      if (Number.isFinite(fromMs) && els) {
        els.f.duration.textContent = fmtDur(Date.now() - fromMs);
      }
    }, 1000);
  }

  function selectSlot(nextIdx) {
    if (!activeState || isAnimatingClose) return;
    if (nextIdx < 0 || nextIdx >= activeState.slots.length || nextIdx === activeState.currentIdx) return;

    if (activeState.sourceEl) setPulledSource(activeState.sourceEl, false);
    activeState.currentIdx = nextIdx;
    const nextSlot = activeState.slots[nextIdx];
    activeState.sourceEl = resolveSourceEl(nextSlot);
    if (activeState.sourceEl) setPulledSource(activeState.sourceEl, true);

    const { folio } = els;
    if (!prefersReducedMotion()) {
      // Slide current pastel card down into the pocket, swap data/color, then pull the new card UP out of the pocket!
      folio.classList.add("is-swapping");
      setTimeout(() => {
        if (!activeState) return;
        paintHeaderAndTimes(nextSlot);
        renderSlotBar();
        requestAnimationFrame(() => {
          folio.classList.remove("is-swapping");
        });
        hydrateCurrent(false);
        armLiveTicker();
      }, 150);
    } else {
      paintHeaderAndTimes(nextSlot);
      renderSlotBar();
      hydrateCurrent(false);
      armLiveTicker();
    }
  }

  function stepSlot(delta) {
    if (!activeState || activeState.slots.length < 2) return;
    const len = activeState.slots.length;
    const next = (activeState.currentIdx + delta + len) % len;
    selectSlot(next);
  }

  function close() {
    if (!activeState || isAnimatingClose || !els) return;
    isAnimatingClose = true;

    const st = activeState;
    if (st.liveTimer) clearInterval(st.liveTimer);
    if (st.abortCtrl) try { st.abortCtrl.abort(); } catch (_) {}

    const { backdrop, host, folio } = els;
    const slot = st.slots[st.currentIdx];
    const srcEl = resolveSourceEl(slot) || st.sourceEl;
    const srcRect = srcEl && document.body.contains(srcEl) ? srcEl.getBoundingClientRect() : null;

    const finish = () => {
      backdrop.hidden = true;
      host.hidden = true;
      backdrop.classList.remove("is-open");
      folio.classList.remove("is-tucked", "is-swapping");
      folio.style.transition = "";
      folio.style.transform = "";
      folio.style.opacity = "";
      if (srcEl) setPulledSource(srcEl, false);
      const retFocus = srcEl || st.lastFocus;
      activeState = null;
      isAnimatingClose = false;
      if (retFocus && typeof retFocus.focus === "function" && document.body.contains(retFocus)) {
        try { retFocus.focus({ preventScroll: true }); } catch (_) {}
      }
    };

    backdrop.classList.remove("is-open");

    if (srcRect && !prefersReducedMotion()) {
      folio.classList.add("is-tucked");
      const curRect = folio.getBoundingClientRect();
      const dx = (srcRect.left + srcRect.width / 2) - (curRect.left + curRect.width / 2);
      const dy = (srcRect.top + srcRect.height / 2) - (curRect.top + curRect.height / 2) - 6;
      const sx = Math.max(0.32, Math.min(0.95, srcRect.width / Math.max(1, curRect.width)));
      const sy = Math.max(0.18, Math.min(0.85, srcRect.height / Math.max(1, curRect.height)));

      folio.style.transition =
        "transform 0.28s cubic-bezier(0.32, 0, 0.67, 0), opacity 0.22s ease";
      folio.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`;
      folio.style.opacity = "0";
      setTimeout(finish, 290);
    } else {
      finish();
    }
  }

  function syncLive(machineId, liveSnap) {
    if (!activeState || activeState.machineId !== machineId) return;
    const slot = activeState.slots[activeState.currentIdx];
    if (!slot || !slot.live) return;
    slot.liveSnap = liveSnap;
    paintLiveSnap(liveSnap);
  }

  function isOpen() {
    return !!activeState && !isAnimatingClose;
  }

  function shiftShort(ts) {
    const label = shiftForTimestamp(tsToMs(ts));
    return label ? label.split(" ")[0] : "";
  }

  window.VMC_NC_FOLIO = {
    open,
    close,
    isOpen,
    syncLive,
    extractPartCycles,
    fmtClock,
    fmtDur,
    shiftShort,
  };
})();
