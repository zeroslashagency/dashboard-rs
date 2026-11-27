/* VMC Fleet Intelligence — Dual-Reference Precision SVG Chart Primitives.
 *
 * Pure string-returning SVG builders inspired by both reference visual systems:
 *   Ref 1 (Soft Gradient Story Studio):
 *     - svgGradientHistogram : pastel-to-vivid indigo rounded bars + % caps + black highlight chip
 *     - svgConnectedStacks   : multi-segment rounded pill stacks joined by gradient flow ribbons
 *     - svgSquareScatter     : rounded-square gradient data tiles with centered counts
 *     - svgGapDonut          : thick gap-segmented donut with floating black value pill
 *   Ref 2 (Modular Precision KPI Widgets):
 *     - svgArcGauge          : 180° cobalt goal arc with white-ringed thumb dot
 *     - svgSparkBars         : dual-tone mint/emerald vertical rounded spark bars
 *     - svgHalfDonut         : segmented 180° multi-color half-donut
 *     - svgAreaLine          : sharp polygonal violet area line with peak highlight slice
 *     - svgHealthRadar       : 5-axis dual-polygon spider radar (Fleet Avg vs Selected VMC)
 *     - svgPairedBars        : paired indigo + emerald vertical rounded bars
 *     - svgMiniAreaSpark     : compact area sparkline for D/W/M health trends
 *
 * Every interactive primitive carries data-fi-tip-title / data-fi-tip-sub for
 * the single floating obsidian hover callout. All text is HTML-escaped.
 */

let uidCounter = 0;
function uid(prefix) {
  uidCounter += 1;
  return `fi_${prefix}_${uidCounter}`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function polar(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx, cy, r, startDeg, endDeg) {
  const s = polar(cx, cy, r, startDeg);
  const e = polar(cx, cy, r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

/* ==================== REF 2: 180° GOAL ARC GAUGE ==================== */
export function svgArcGauge({ pct = 0, centerValue = "0%", subLabel = "", color = "#2563eb", tipTitle = "", tipSub = "" }) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const w = 220;
  const h = 122;
  const cx = w / 2;
  const cy = 104;
  const r = 80;
  const gid = uid("arc");

  // Semi-circle spans -90deg (left) to +90deg (right) in our top-0 polar system
  const startDeg = -90;
  const endDeg = 90;
  const fillDeg = startDeg + (clamped / 100) * 180;
  const thumb = polar(cx, cy, r, fillDeg);

  const trackD = arcPath(cx, cy, r, startDeg, endDeg);
  const fillD = clamped > 0.5 ? arcPath(cx, cy, r, startDeg, Math.min(89.9, fillDeg)) : "";

  return `<svg class="fi-svg fi-arc-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(centerValue)} ${esc(subLabel)}">
    <defs>
      <linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="${color}" />
        <stop offset="100%" stop-color="#38bdf8" />
      </linearGradient>
    </defs>
    <path d="${trackD}" fill="none" class="fi-svg-track" stroke-width="14" stroke-linecap="round" />
    ${
      fillD
        ? `<path d="${fillD}" fill="none" stroke="url(#${gid})" stroke-width="14" stroke-linecap="round"
            class="fi-hit" data-fi-tip-title="${esc(tipTitle || centerValue)}" data-fi-tip-sub="${esc(tipSub || subLabel)}" />`
        : ""
    }
    <circle cx="${thumb.x.toFixed(1)}" cy="${thumb.y.toFixed(1)}" r="8" fill="${color}" stroke="var(--fi-card-bg)" stroke-width="3"
      class="fi-hit" data-fi-tip-title="${esc(tipTitle || centerValue)}" data-fi-tip-sub="${esc(tipSub || subLabel)}" />
    <text x="${cx}" y="${cy - 22}" text-anchor="middle" class="fi-arc-pct">${esc(centerValue)}</text>
    <text x="${cx}" y="${cy - 2}" text-anchor="middle" class="fi-arc-sub">${esc(subLabel)}</text>
  </svg>`;
}

/* ==================== REF 2: DUAL-TONE EMERALD SPARK BARS ==================== */
export function svgSparkBars(bars) {
  const w = 230;
  const h = 92;
  const list = Array.isArray(bars) ? bars : [];
  if (!list.length) {
    return `<div class="fi-chart-empty">No output slices yet</div>`;
  }
  const maxV = Math.max(1, ...list.map((b) => Number(b.value) || 0));
  const gap = 5;
  const bw = Math.max(6, (w - gap * (list.length - 1)) / list.length);

  const rects = list
    .map((b, i) => {
      const val = Number(b.value) || 0;
      const bh = Math.max(6, (val / maxV) * (h - 10));
      const x = i * (bw + gap);
      const y = h - bh;
      const isVivid = b.vivid || i % 2 === 1;
      const cls = isVivid ? "fi-spark-vivid" : "fi-spark-soft";
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="3.5"
        class="fi-hit ${cls}" data-fi-tip-title="${esc(b.tipTitle || `${val} parts`)}" data-fi-tip-sub="${esc(b.tipSub || b.label || "")}" />`;
    })
    .join("");

  return `<svg class="fi-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${rects}</svg>`;
}

/* ==================== REF 2: SEGMENTED 180° HALF-DONUT ==================== */
export function svgHalfDonut(segments) {
  const w = 220;
  const h = 104;
  const cx = w / 2;
  const cy = 96;
  const r = 72;
  const list = (segments || []).filter((s) => s.value > 0);
  const total = list.reduce((a, s) => a + s.value, 0);

  if (!total) {
    const emptyD = arcPath(cx, cy, r, -90, 90);
    return `<svg class="fi-svg" viewBox="0 0 ${w} ${h}">
      <path d="${emptyD}" fill="none" class="fi-svg-track" stroke-width="24" />
      <text x="${cx}" y="${cy - 14}" text-anchor="middle" class="fi-arc-sub">No loss</text>
    </svg>`;
  }

  const gapDeg = list.length > 1 ? 3 : 0;
  const usable = 180 - gapDeg * (list.length - 1);
  let cursor = -90;
  const paths = list
    .map((s) => {
      const span = Math.max(2, (s.value / total) * usable);
      const d = arcPath(cx, cy, r, cursor, Math.min(90, cursor + span));
      cursor += span + gapDeg;
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="24" class="fi-hit fi-donut-arc"
        data-fi-tip-title="${esc(s.tipTitle || s.label)}" data-fi-tip-sub="${esc(s.tipSub || "")}" />`;
    })
    .join("");

  return `<svg class="fi-svg" viewBox="0 0 ${w} ${h}">${paths}</svg>`;
}

/* ==================== REF 2: POLYGONAL LAVENDER AREA LINE ==================== */
export function svgAreaLine(points) {
  const w = 230;
  const h = 92;
  const list = Array.isArray(points) ? points : [];
  if (list.length < 2) {
    return `<div class="fi-chart-empty">Need 2+ cycles for trend</div>`;
  }
  const gid = uid("area");
  const vals = list.map((p) => Number(p.value) || 0);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const range = maxV - minV || 1;
  const padT = 12;
  const padB = 6;
  const plotH = h - padT - padB;

  const coords = list.map((p, i) => ({
    x: (i / (list.length - 1)) * w,
    y: padT + (1 - ((Number(p.value) || 0) - minV) / range) * plotH,
    raw: p,
  }));

  // Highlight the latest or peak slice just like Ref 2
  const hiIdx = Math.max(1, list.length - 2);
  const hi = coords[hiIdx];
  const prevX = coords[Math.max(0, hiIdx - 1)].x;
  const nextX = coords[Math.min(coords.length - 1, hiIdx + 1)].x;
  const bandX = (prevX + hi.x) / 2;
  const bandW = Math.max(12, (nextX - prevX) / 2);

  const linePts = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const areaPts = `0,${h} ${linePts} ${w},${h}`;

  const hitCols = coords
    .map((c, i) => {
      const sliceW = w / list.length;
      const sx = Math.max(0, c.x - sliceW / 2);
      return `<g class="fi-hit" data-fi-tip-title="${esc(c.raw.tipTitle || "")}" data-fi-tip-sub="${esc(c.raw.tipSub || "")}">
        <rect x="${sx.toFixed(1)}" y="0" width="${sliceW.toFixed(1)}" height="${h}" fill="transparent" />
        <circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${i === hiIdx ? 4.5 : 2.5}"
          fill="${i === hiIdx ? "#6d28d9" : "#8b5cf6"}" stroke="var(--fi-card-bg)" stroke-width="${i === hiIdx ? 2 : 0}" />
      </g>`;
    })
    .join("");

  return `<svg class="fi-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs>
      <linearGradient id="${gid}" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#7c3aed" stop-opacity="0.26" />
        <stop offset="100%" stop-color="#7c3aed" stop-opacity="0.02" />
      </linearGradient>
    </defs>
    <rect x="${bandX.toFixed(1)}" y="${hi.y.toFixed(1)}" width="${bandW.toFixed(1)}" height="${(h - hi.y).toFixed(1)}" fill="rgba(124,58,237,0.16)" />
    <line x1="${hi.x.toFixed(1)}" y1="4" x2="${hi.x.toFixed(1)}" y2="${h}" stroke="rgba(124,58,237,0.4)" stroke-dasharray="3 3" stroke-width="1" />
    <polygon points="${areaPts}" fill="url(#${gid})" />
    <polyline points="${linePts}" fill="none" stroke="#6d28d9" stroke-width="2" stroke-linejoin="round" />
    ${hitCols}
  </svg>`;
}

/* ==================== REF 2: 5-AXIS HEALTH SPIDER RADAR ==================== */
export function svgHealthRadar(axes, fleetVals, compareVals, compareLabel = "Selected") {
  const w = 310;
  const h = 236;
  const cx = w / 2;
  const cy = h / 2 + 6;
  const maxR = 76;
  const n = axes.length;

  const angleFor = (i) => (i * 360) / n;

  // Concentric pentagonal grid rings (25, 50, 75, 100)
  const rings = [0.25, 0.5, 0.75, 1]
    .map((frac) => {
      const pts = axes
        .map((_, i) => {
          const p = polar(cx, cy, maxR * frac, angleFor(i));
          return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
        })
        .join(" ");
      return `<polygon points="${pts}" fill="none" class="fi-radar-grid" stroke-width="1" />`;
    })
    .join("");

  // Spokes + axis labels
  const spokes = axes
    .map((ax, i) => {
      const deg = angleFor(i);
      const outer = polar(cx, cy, maxR, deg);
      const lbl = polar(cx, cy, maxR + 22, deg);
      const anchor = Math.abs(lbl.x - cx) < 12 ? "middle" : lbl.x > cx ? "start" : "end";
      return `
        <line x1="${cx}" y1="${cy}" x2="${outer.x.toFixed(1)}" y2="${outer.y.toFixed(1)}" class="fi-radar-grid" stroke-width="1" />
        <text x="${lbl.x.toFixed(1)}" y="${(lbl.y + 4).toFixed(1)}" text-anchor="${anchor}" class="fi-radar-lbl">${esc(ax.label)}</text>`;
    })
    .join("");

  const polyAndDots = (vals, fill, stroke, seriesName) => {
    const pts = vals.map((v, i) => {
      const frac = Math.max(0.08, Math.min(1, (Number(v) || 0) / 100));
      return { ...polar(cx, cy, maxR * frac, angleFor(i)), v: v == null ? null : Math.round(v), axis: axes[i].label };
    });
    const str = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const dots = pts
      .map(
        (p) =>
          `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.2" fill="${stroke}" stroke="var(--fi-card-bg)" stroke-width="1.5"
            class="fi-hit" data-fi-tip-title="${esc(`${seriesName} · ${p.axis}`)}" data-fi-tip-sub="${esc(p.v == null ? "No signal" : `Score ${p.v}/100`)}" />`
      )
      .join("");
    return `<polygon points="${str}" fill="${fill}" stroke="${stroke}" stroke-width="1.8" stroke-linejoin="round" />${dots}`;
  };

  return `<svg class="fi-svg fi-radar-svg" viewBox="0 0 ${w} ${h}">
    ${rings}
    ${spokes}
    ${polyAndDots(fleetVals, "rgba(34,197,94,0.18)", "#22c55e", "Fleet Avg")}
    ${compareVals ? polyAndDots(compareVals, "rgba(37,99,235,0.20)", "#2563eb", compareLabel) : ""}
  </svg>`;
}

/* ==================== REF 2: PAIRED VIOLET + EMERALD BARS ==================== */
export function svgPairedBars(groups) {
  const w = 340;
  const h = 216;
  const list = Array.isArray(groups) ? groups : [];
  if (!list.length) return `<div class="fi-chart-empty">No machine output yet</div>`;

  const pad = { top: 14, right: 10, bottom: 28, left: 34 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  const maxV = Math.max(4, ...list.flatMap((g) => [Number(g.a) || 0, Number(g.b) || 0]));
  const niceMax = Math.ceil(maxV / 5) * 5;

  // Gridlines + Y-axis labels
  const grids = [0, 0.33, 0.66, 1]
    .map((f) => {
      const y = pad.top + (1 - f) * plotH;
      const val = Math.round(niceMax * f);
      return `
        <line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${w - pad.right}" y2="${y.toFixed(1)}" class="fi-grid-line" stroke-width="1" />
        <text x="${pad.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="fi-axis-lbl">${val}</text>`;
    })
    .join("");

  const slotW = plotW / list.length;
  const barW = Math.max(5, Math.min(13, (slotW - 10) / 2));

  const barsHtml = list
    .map((g, i) => {
      const cx = pad.left + slotW * i + slotW / 2;
      const ha = ((Number(g.a) || 0) / niceMax) * plotH;
      const hb = ((Number(g.b) || 0) / niceMax) * plotH;
      const ya = pad.top + plotH - ha;
      const yb = pad.top + plotH - hb;
      const x1 = cx - barW - 1.5;
      const x2 = cx + 1.5;
      return `
        <g data-select-machine="${esc(g.machineId || "")}" style="cursor:pointer;">
          <rect x="${x1.toFixed(1)}" y="${ya.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(2, ha).toFixed(1)}" rx="3.5"
            fill="#7c3aed" class="fi-hit" data-fi-tip-title="${esc(`${g.label} · ${g.aLabel || "Actual"}`)}" data-fi-tip-sub="${esc(g.aTip || `${g.a} parts`)}" />
          <rect x="${x2.toFixed(1)}" y="${yb.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(2, hb).toFixed(1)}" rx="3.5"
            fill="#22c55e" class="fi-hit" data-fi-tip-title="${esc(`${g.label} · ${g.bLabel || "Target"}`)}" data-fi-tip-sub="${esc(g.bTip || `${g.b} parts`)}" />
          <text x="${cx.toFixed(1)}" y="${h - 8}" text-anchor="middle" class="fi-axis-lbl">${esc(g.shortLabel || g.label)}</text>
        </g>`;
    })
    .join("");

  return `<svg class="fi-svg" viewBox="0 0 ${w} ${h}">${grids}${barsHtml}</svg>`;
}

/* ==================== REF 1 TOP-LEFT: GRADIENT ROUNDED HISTOGRAM ==================== */
export function svgGradientHistogram(binned, fmtLabel) {
  const w = 520;
  const h = 224;
  const bins = binned?.bins || [];
  if (!bins.length) {
    return `<div class="fi-chart-empty" style="height:190px;">At least 2 completed M30 cycles are needed to plot a program distribution.</div>`;
  }

  const gidHi = uid("histHi");
  const gidLo = uid("histLo");
  const pad = { top: 30, right: 12, bottom: 38, left: 12 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  let peakIdx = 0;
  let peakCount = 0;
  bins.forEach((b, i) => {
    if (b.count > peakCount) {
      peakCount = b.count;
      peakIdx = i;
    }
  });
  const peak = Math.max(1, peakCount);

  const gap = 8;
  const bw = Math.max(16, (plotW - gap * (bins.length - 1)) / bins.length);
  const startX = pad.left + (plotW - (bw * bins.length + gap * (bins.length - 1))) / 2;

  const cols = bins
    .map((b, i) => {
      const bh = Math.max(8, (b.count / peak) * plotH);
      const x = startX + i * (bw + gap);
      const y = pad.top + plotH - bh;
      const isPeak = i === peakIdx && b.count > 0;
      const midLbl = fmtLabel((b.from + b.to) / 2);
      const rangeLbl = `${fmtLabel(b.from)} – ${fmtLabel(b.to)}`;
      const pctStr = b.pct > 0 ? `${b.pct.toFixed(b.pct >= 10 ? 0 : 1)}%` : "0%";
      const cx = x + bw / 2;
      const showLbl = bins.length <= 10 || i % 2 === 0 || isPeak;

      const xLbl = isPeak
        ? `<rect x="${(cx - 28).toFixed(1)}" y="${(h - 26).toFixed(1)}" width="56" height="20" rx="6" class="fi-dark-chip-rect" />
           <text x="${cx.toFixed(1)}" y="${(h - 12.5).toFixed(1)}" text-anchor="middle" class="fi-dark-chip-txt">${esc(midLbl)}</text>`
        : showLbl
          ? `<text x="${cx.toFixed(1)}" y="${(h - 12).toFixed(1)}" text-anchor="middle" class="fi-axis-lbl">${esc(midLbl)}</text>`
          : "";

      return `
        <g class="fi-hit" data-fi-tip-title="${esc(rangeLbl)}" data-fi-tip-sub="${esc(`${b.count} cycle${b.count === 1 ? "" : "s"} (${pctStr})`)}">
          <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="9"
            fill="url(#${isPeak ? gidHi : gidLo})" />
          ${showLbl ? `<text x="${cx.toFixed(1)}" y="${(y - 8).toFixed(1)}" text-anchor="middle" class="${isPeak ? "fi-bar-cap-hi" : "fi-bar-cap"}">${esc(pctStr)}</text>` : ""}
          ${xLbl}
        </g>`;
    })
    .join("");

  return `<svg class="fi-svg" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="${gidHi}" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#a78bfa" />
        <stop offset="100%" stop-color="#6d28d9" />
      </linearGradient>
      <linearGradient id="${gidLo}" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="var(--fi-bar-soft-top)" />
        <stop offset="100%" stop-color="var(--fi-bar-soft-bot)" />
      </linearGradient>
    </defs>
    ${cols}
  </svg>`;
}

/* ==================== REF 1 TOP-RIGHT: CONNECTED STACKED FLOW RIBBONS ==================== */
export function svgConnectedStacks(columns, seriesDefs) {
  const w = 520;
  const h = 224;
  const cols = Array.isArray(columns) ? columns : [];
  if (!cols.length || !seriesDefs.length) {
    return `<div class="fi-chart-empty" style="height:190px;">No shift program flow data in this window.</div>`;
  }

  const pad = { top: 34, right: 34, bottom: 38, left: 34 };
  const plotH = h - pad.top - pad.bottom;
  const maxTot = Math.max(1, ...cols.map((c) => c.total));
  const barW = 46;
  const colPositions = cols.map((_, i) =>
    cols.length === 1
      ? w / 2
      : pad.left + barW / 2 + (i / (cols.length - 1)) * (w - pad.left - pad.right - barW)
  );

  // Compute stacked segment vertical geometry per column (bottom-up)
  const colGeoms = cols.map((col, ci) => {
    const cx = colPositions[ci];
    const x = cx - barW / 2;
    let cursorY = pad.top + plotH;
    const segGap = 3;
    const activeSegs = seriesDefs
      .map((s) => ({ ...s, val: Number(col.values[s.key]) || 0 }))
      .filter((s) => s.val > 0);
    const totalGap = Math.max(0, activeSegs.length - 1) * segGap;
    const usableH = Math.max(12, (col.total / maxTot) * plotH);
    const segMap = new Map();

    for (const s of activeSegs) {
      const sh = Math.max(7, (s.val / Math.max(1, col.total)) * Math.max(10, usableH - totalGap));
      const y1 = cursorY - sh;
      const y2 = cursorY;
      segMap.set(s.key, { x, y1, y2, h: sh, val: s.val, color: s.color, label: s.label });
      cursorY = y1 - segGap;
    }
    const topY = activeSegs.length ? cursorY + segGap : pad.top + plotH;
    return { col, cx, x, topY, segMap };
  });

  // Smooth translucent flow ribbons connecting same series across adjacent columns
  const ribbons = [];
  for (let i = 0; i < colGeoms.length - 1; i++) {
    const a = colGeoms[i];
    const b = colGeoms[i + 1];
    for (const s of seriesDefs) {
      const sa = a.segMap.get(s.key);
      const sb = b.segMap.get(s.key);
      if (!sa || !sb) continue;
      const x1 = a.x + barW;
      const x2 = b.x;
      const mx = (x1 + x2) / 2;
      const d = [
        `M ${x1.toFixed(1)} ${sa.y1.toFixed(1)}`,
        `C ${mx.toFixed(1)} ${sa.y1.toFixed(1)}, ${mx.toFixed(1)} ${sb.y1.toFixed(1)}, ${x2.toFixed(1)} ${sb.y1.toFixed(1)}`,
        `L ${x2.toFixed(1)} ${sb.y2.toFixed(1)}`,
        `C ${mx.toFixed(1)} ${sb.y2.toFixed(1)}, ${mx.toFixed(1)} ${sa.y2.toFixed(1)}, ${x1.toFixed(1)} ${sa.y2.toFixed(1)}`,
        "Z",
      ].join(" ");
      ribbons.push(`<path d="${d}" fill="${s.color}" fill-opacity="0.16" />`);
    }
  }

  // Highlight column with max total
  let bestCol = 0;
  colGeoms.forEach((g, i) => {
    if (g.col.total >= colGeoms[bestCol].col.total) bestCol = i;
  });

  const stacksHtml = colGeoms
    .map((g, ci) => {
      const rects = [...g.segMap.values()]
        .map(
          (seg) => `<rect x="${seg.x.toFixed(1)}" y="${seg.y1.toFixed(1)}" width="${barW}" height="${seg.h.toFixed(1)}" rx="6"
            fill="${seg.color}" class="fi-hit"
            data-fi-tip-title="${esc(`${g.col.label} · ${seg.label}`)}" data-fi-tip-sub="${esc(`${seg.val} parts`)}" />`
        )
        .join("");

      const isBest = ci === bestCol && g.col.total > 0;
      const bottomBadge = isBest
        ? `<rect x="${(g.cx - 32).toFixed(1)}" y="${(h - 26).toFixed(1)}" width="64" height="20" rx="6" class="fi-dark-chip-rect" />
           <text x="${g.cx.toFixed(1)}" y="${(h - 12.5).toFixed(1)}" text-anchor="middle" class="fi-dark-chip-txt">${esc(`${g.col.total} pcs`)}</text>`
        : `<text x="${g.cx.toFixed(1)}" y="${(h - 12).toFixed(1)}" text-anchor="middle" class="fi-axis-lbl">${esc(`${g.col.total} pcs`)}</text>`;

      return `
        ${rects}
        <text x="${g.cx.toFixed(1)}" y="${Math.max(16, g.topY - 10).toFixed(1)}" text-anchor="middle" class="fi-bar-cap-hi">${esc(g.col.shortLabel || g.col.label)}</text>
        ${bottomBadge}`;
    })
    .join("");

  return `<svg class="fi-svg" viewBox="0 0 ${w} ${h}">${ribbons.join("")}${stacksHtml}</svg>`;
}

/* ==================== REF 1 BOTTOM-LEFT: ROUNDED-SQUARE SCATTER MATRIX ==================== */
export function svgSquareScatter(points) {
  const w = 520;
  const h = 216;
  const list = Array.isArray(points) ? points : [];
  if (!list.length) {
    return `<div class="fi-chart-empty" style="height:190px;">No NC programs with cycles to map yet.</div>`;
  }

  const pad = { top: 20, right: 30, bottom: 30, left: 44 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  const maxX = Math.max(5, ...list.map((p) => p.x)) * 1.15;
  const minY = Math.max(0, Math.min(60, ...list.map((p) => p.y)) - 5);
  const maxY = 100;
  const ySpan = Math.max(10, maxY - minY);

  // Horizontal dashed gridlines
  const yTicks = [0, 0.33, 0.66, 1].map((f) => {
    const val = Math.round(minY + f * ySpan);
    const y = pad.top + (1 - f) * plotH;
    return `
      <line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${w - pad.right}" y2="${y.toFixed(1)}" class="fi-grid-line" stroke-dasharray="4 4" stroke-width="1" />
      <text x="${pad.left - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="fi-axis-lbl">${val}%</text>`;
  });

  // X-axis ticks
  const xTicks = [0.2, 0.4, 0.6, 0.8, 1].map((f) => {
    const val = Math.round(maxX * f);
    const x = pad.left + f * plotW;
    return `<text x="${x.toFixed(1)}" y="${h - 8}" text-anchor="middle" class="fi-axis-lbl">${val}</text>`;
  });

  const maxSize = Math.max(1, ...list.map((p) => p.size || p.x || 1));
  const tiles = list
    .map((p, i) => {
      const cx = pad.left + Math.max(0.06, Math.min(0.94, p.x / maxX)) * plotW;
      const cy = pad.top + (1 - Math.max(0.06, Math.min(0.94, (p.y - minY) / ySpan))) * plotH;
      const side = 32 + Math.sqrt((p.size || p.x || 1) / maxSize) * 28;
      const gid = uid(`sq${i}`);
      const isDarkText = p.highlight;
      return `
        <defs>
          <linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="${p.c1}" />
            <stop offset="100%" stop-color="${p.c2}" />
          </linearGradient>
        </defs>
        <g class="fi-hit fi-scatter-tile" data-action="select-program" data-program="${esc(p.program || "")}"
           data-fi-tip-title="${esc(p.tipTitle || p.label)}" data-fi-tip-sub="${esc(p.tipSub || "")}">
          <rect x="${(cx - side / 2).toFixed(1)}" y="${(cy - side / 2).toFixed(1)}" width="${side.toFixed(1)}" height="${side.toFixed(1)}" rx="11"
            fill="url(#${gid})" />
          ${
            isDarkText
              ? `<rect x="${(cx - 19).toFixed(1)}" y="${(cy - 10).toFixed(1)}" width="38" height="20" rx="6" class="fi-dark-chip-rect" />
                 <text x="${cx.toFixed(1)}" y="${(cy + 4).toFixed(1)}" text-anchor="middle" class="fi-dark-chip-txt">${esc(p.countText)}</text>`
              : `<text x="${cx.toFixed(1)}" y="${(cy + 4.5).toFixed(1)}" text-anchor="middle" class="fi-tile-num">${esc(p.countText)}</text>`
          }
        </g>`;
    })
    .join("");

  return `<svg class="fi-svg" viewBox="0 0 ${w} ${h}">${yTicks.join("")}${xTicks.join("")}${tiles}</svg>`;
}

/* ==================== REF 1 BOTTOM-RIGHT: SEGMENTED GAP DONUT ==================== */
export function svgGapDonut(segments) {
  const size = 212;
  const cx = size / 2;
  const cy = size / 2;
  const r = 74;
  const list = (segments || []).filter((s) => s.value > 0);
  const total = list.reduce((a, s) => a + s.value, 0);

  if (!total) {
    return `<svg class="fi-svg fi-donut-svg" viewBox="0 0 ${size} ${size}">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" class="fi-svg-track" stroke-width="28" />
      <text x="${cx}" y="${cy + 4}" text-anchor="middle" class="fi-arc-sub">No data</text>
    </svg>`;
  }

  const gapDeg = list.length > 1 ? 6 : 0;
  const usable = 360 - gapDeg * list.length;
  let cursor = 12;

  const arcs = list.map((s, idx) => {
    const span = Math.max(8, (s.value / total) * usable);
    const start = cursor;
    const end = cursor + span;
    const mid = (start + end) / 2;
    cursor = end + gapDeg;

    const d = arcPath(cx, cy, r, start, Math.min(start + 358, end));
    const lblPt = polar(cx, cy, r, mid);
    const isTop = idx === 0;
    const badge = isTop
      ? `<rect x="${(lblPt.x - 20).toFixed(1)}" y="${(lblPt.y - 10).toFixed(1)}" width="40" height="20" rx="6" class="fi-dark-chip-rect" />
         <text x="${lblPt.x.toFixed(1)}" y="${(lblPt.y + 4).toFixed(1)}" text-anchor="middle" class="fi-dark-chip-txt">${esc(s.shortVal)}</text>`
      : span >= 26
        ? `<text x="${lblPt.x.toFixed(1)}" y="${(lblPt.y + 4).toFixed(1)}" text-anchor="middle" class="fi-donut-val">${esc(s.shortVal)}</text>`
        : "";

    return `
      <g class="fi-hit fi-donut-arc" data-fi-tip-title="${esc(s.tipTitle || s.label)}" data-fi-tip-sub="${esc(s.tipSub || "")}">
        <path d="${d}" fill="none" stroke="${s.color}" stroke-width="28" stroke-linecap="butt" />
        ${badge}
      </g>`;
  });

  return `<svg class="fi-svg fi-donut-svg" viewBox="0 0 ${size} ${size}">${arcs.join("")}</svg>`;
}

/* ==================== COMPACT AREA SPARKLINE (TRENDS) ==================== */
export function svgMiniAreaSpark(series) {
  if (!series || !series.length) {
    return `<div class="fi-muted" style="font-size:11.5px;padding-top:4px;">Daily snapshots build automatically</div>`;
  }
  const w = 220;
  const h = 42;
  const gid = uid("mini");
  const n = series.length;
  const xs = (i) => (n <= 1 ? w / 2 : (i / (n - 1)) * w);
  const ys = (v) => 6 + (1 - Math.max(0, Math.min(100, v)) / 100) * (h - 10);
  const pts = series.map((s, i) => `${xs(i).toFixed(1)},${ys(s.score).toFixed(1)}`).join(" ");
  const area = `0,${h} ${pts} ${w},${h}`;
  const dots = series
    .map(
      (s, i) => `<circle cx="${xs(i).toFixed(1)}" cy="${ys(s.score).toFixed(1)}" r="2.6" fill="#7c3aed"
        class="fi-hit" data-fi-tip-title="${esc(s.d)}" data-fi-tip-sub="${esc(`Health ${s.score}/100`)}" />`
    )
    .join("");
  return `<svg class="fi-svg" style="height:42px;" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs>
      <linearGradient id="${gid}" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#7c3aed" stop-opacity="0.24" />
        <stop offset="100%" stop-color="#7c3aed" stop-opacity="0.01" />
      </linearGradient>
    </defs>
    ${n > 1 ? `<polygon points="${area}" fill="url(#${gid})" /><polyline points="${pts}" fill="none" stroke="#7c3aed" stroke-width="1.8" />` : ""}
    ${dots}
  </svg>`;
}
