/* EvoDose gallery: five extra views. Classic script sharing app.js globals. */
"use strict";

function vizObjective(s) {
  return s.median_ttp + 0.5 * s.p10_ttp - 0.2 * s.pct_on_drug;
}
function longestHoliday(on) {
  let best = 0, cur = 0;
  for (const v of on) { cur = v === 0 ? cur + 1 : 0; best = Math.max(best, cur); }
  return best;
}

/* ---------------------------------------------------------- 1 · terrain - */
// Hand-projected 2D canvas (orthographic orbit around Y plus a downward tilt):
// identical on every browser and GPU, since a WebGL surface rendered blank
// on some software rasterizers.
const terrain3d = { st: null, visible: true, raf: null };
function buildTerrain() {
  const el = $("terrain");
  let cv = el.querySelector("canvas");
  if (!cv) {
    cv = document.createElement("canvas");
    cv.setAttribute("height", "240");
    el.appendChild(cv);
  }
  const st = { el, cv, data: null, rotY: 0.6, tilt: 0.5, zoom: 1,
               dragging: false, px: 0, py: 0 };
  el.addEventListener("pointerdown", (e) => {
    st.dragging = true; st.px = e.clientX; st.py = e.clientY;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (!st.dragging) return;
    st.rotY += (e.clientX - st.px) * 0.008;
    st.tilt = Math.max(0.12, Math.min(1.0, st.tilt + (e.clientY - st.py) * 0.008));
    st.px = e.clientX; st.py = e.clientY;
  });
  const stop = () => { st.dragging = false; };
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointercancel", stop);
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    st.zoom = Math.max(0.6, Math.min(2.2, st.zoom + e.deltaY * -0.001));
  }, { passive: false });
  terrain3d.st = st;
  return st;
}
function renderTerrain() {
  const P = PATIENTS[PID];
  if (!P) return;
  let st = terrain3d.st;
  if (!st) { st = buildTerrain(); if (!st) return; }
  st.data = {
    med: P.fit.median, b5: P.fit.pi5, b95: P.fit.pi95,
    n: P.fit.median.length,
    lo: Math.log10(Math.min(...P.fit.pi5) * 0.9),
    hi: Math.log10(Math.max(...P.fit.pi95) * 1.12),
    weeks: P.readings.weeks, psa: P.readings.psa, on: P.readings.on,
    wSplit: P.readings.weeks[P.n_fit],
  };
  drawTerrain();
}
function terrainFrame(st, W, H) {
  // fit the rotated content on every frame. No auto-spin: the terrain is
  // nearly flat, so continuous rotation would collapse it edge-on twice per
  // turn. The user orbits by dragging instead; framing follows any angle.
  // x-extent leaks into depth when rotated, so fit both axes from the angle.
  const rot = st.rotY;
  const cT = Math.cos(st.tilt), sT = Math.sin(st.tilt);
  const cA = Math.abs(Math.cos(rot)), sA = Math.abs(Math.sin(rot));
  const z1max = 3 * sA + 0.5 * cA;
  const y2max = 2.6 * cT + z1max * sT, y2min = -z1max * sT;
  const yspan = y2max - y2min, xspan = 2 * (3 * cA + 0.5 * sA);
  const s = Math.min(W / (xspan + 0.8), H / (yspan + 0.5)) * st.zoom;
  const cy = (H - yspan * s) / 2;
  return { rot, cT, sT, s, cy, y2max };
}
function terrainProject(st, fr, x, y, z, W, H) {
  // orbit around Y, then downward tilt; orthographic onto the canvas
  const cA = Math.cos(fr.rot), sA = Math.sin(fr.rot);
  const x1 = x * cA + z * sA, z1 = -x * sA + z * cA;
  const y2 = y * fr.cT - z1 * fr.sT;
  return [W / 2 + x1 * fr.s, fr.cy + (fr.y2max - y2) * fr.s];
}
function drawTerrain() {
  const st = terrain3d.st;
  if (!st || !st.data) return;
  const d = st.data;
  const [ctx, W, H] = fitCanvas(st.cv);
  ctx.clearRect(0, 0, W, H);
  const X = (t) => (t / (d.n - 1)) * 6 - 3;
  const Y = (v) => ((Math.log10(Math.max(v, 1e-6)) - d.lo) / (d.hi - d.lo)) * 2.6;
  const fr = terrainFrame(st, W, H);
  const P2 = (x, y, z) => terrainProject(st, fr, x, y, z, W, H);
  ctx.font = "11px system-ui";
  // ground grid + log-decade ticks on the y axis
  ctx.strokeStyle = "#262b29"; ctx.fillStyle = "#9aa39f"; ctx.textAlign = "right";
  for (let p = Math.ceil(d.lo); p <= d.hi; p++) {
    const a = P2(-3, Y(Math.pow(10, p)), 0), b = P2(3, Y(Math.pow(10, p)), 0);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    ctx.fillText("10" + sup(p), a[0] - 6, a[1] + 3);
  }
  // mountain body + uncertainty band as vertical strips: immune to
  // winding cancellation no matter how the view is rotated
  const colW = Math.max(1, (W / (d.n - 1)) * 1.2);
  for (let t = 0; t < d.n; t++) {
    const [x] = P2(X(t), 0, -0.02);
    const [, yBase] = P2(X(t), 0, -0.02);
    const [, y95] = P2(X(t), Y(d.b95[t]), -0.02);
    const [, y5] = P2(X(t), Y(d.b5[t]), 0.02);
    ctx.fillStyle = "rgba(52,211,189,0.12)";
    ctx.fillRect(x - colW / 2, y95, colW, yBase - y95);
    ctx.fillStyle = "rgba(52,211,189,0.32)";
    ctx.fillRect(x - colW / 2, Math.min(y95, y5), colW, Math.max(1, Math.abs(y5 - y95)));
  }
  // median ridge
  ctx.beginPath();
  for (let t = 0; t < d.n; t++) {
    const [x, y] = P2(X(t), Y(d.med[t]), 0.02);
    t ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.strokeStyle = "#34d3bd"; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1;
  // real readings as floating points (amber on drug, blue off)
  for (let i = 0; i < d.weeks.length; i++) {
    const [x, y] = P2(X(d.weeks[i]), Y(d.psa[i]), 0.04);
    ctx.beginPath(); ctx.arc(x, y, 3.2, 0, 7);
    if (d.on[i] === 1) { ctx.fillStyle = "#e8a33d"; ctx.fill(); }
    else {
      ctx.fillStyle = "#0a0a0a"; ctx.fill();
      ctx.strokeStyle = "#5b9cf5"; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1;
    }
  }
  // held-out split wall
  const w0 = P2(X(d.wSplit), 0, -0.5), w1 = P2(X(d.wSplit), 2.7, 0.5);
  ctx.strokeStyle = "#9aa39f"; ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(w0[0], w0[1]); ctx.lineTo(w1[0], w1[1]); ctx.stroke();
  ctx.setLineDash([]);
}
function terrainLoop() {
  terrain3d.raf = requestAnimationFrame(terrainLoop); // always reschedule first
  const st = terrain3d.st;
  if (!st || !st.data) return;
  if (terrain3d.visible && !document.hidden) {
    // static view: redraw only when the angle, zoom, or patient changed
    const key = st.rotY + "|" + st.tilt + "|" + st.zoom + "|" + PID;
    if (key !== st._drawn || st.dragging) {
      st._drawn = key;
      drawTerrain();
    }
  }
}

/* ------------------------------------------------------------ 2 · rivers - */
const RIVER_RULES = [
  ["continuous", "Drug always on", "#888888"],
  ["standard", "Usual break plan", "#5b9cf5"],
];
function renderRiver() {
  const P = PATIENTS[PID];
  if (!P) return;
  const c = $("river");
  const [ctx, W, H] = fitCanvas(c);
  ctx.clearRect(0, 0, W, H);
  let peak = 0;
  for (const [key] of RIVER_RULES) {
    const S = P.sim[key];
    for (let t = 0; t < S.psa.length; t++) peak = Math.max(peak, S.S[t] + S.R[t]);
  }
  const lanes = RIVER_RULES.length, laneH = H / lanes, padL = 118, padR = 46;
  ctx.font = "11px system-ui";
  RIVER_RULES.forEach(([key, label, color], li) => {
    const S = P.sim[key];
    const n = S.psa.length, top = li * laneH + 8, h = laneH - 22;
    const X = (t) => padL + (t / (n - 1)) * (W - padL - padR);
    const Y = (v) => top + h - (v / peak) * h;
    ctx.fillStyle = "rgba(232,163,61,0.13)";
    for (let t = 0; t < n; t++) {
      if (S.on[t] === 1) ctx.fillRect(X(t), top, Math.max(1, W / n), h);
    }
    const layer = (get, fill) => {
      ctx.beginPath();
      for (let t = 0; t < n; t++) { const x = X(t), y = Y(get(t)); t ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      for (let t = n - 1; t >= 0; t--) ctx.lineTo(X(t), top + h);
      ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    };
    layer((t) => S.S[t] + S.R[t], "#d64545");
    layer((t) => S.S[t], "#2e9e5b");
    if (S.progressed_week !== null) {
      ctx.strokeStyle = "#e05252"; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(X(S.progressed_week), top); ctx.lineTo(X(S.progressed_week), top + h); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = "#f2f2f2"; ctx.textAlign = "left";
    ctx.fillText(label, 4, top + 14);
    ctx.fillStyle = "#9aa39f";
    ctx.fillText(`control lost at week ${S.progressed_week === null ? "260+" : S.progressed_week}`, 4, top + 28);
    ctx.textAlign = "right";
    ctx.fillText(`${Math.round(S.on.reduce((a, b) => a + b, 0) / n * 100)}% on drug`, W - 4, top + 14);
  });
}

/* ------------------------------------------------------------- 3 · radar - */
function radarMetrics(P) {
  const rows = {};
  for (const [key] of RIVER_RULES) {
    const b = P.baselines[key === "continuous" ? "continuous" : "standard"];
    rows[key] = {
      med: b.median_ttp,
      p10: b.p10_ttp,
      free: 100 - b.pct_on_drug,
      holiday: longestHoliday(P.sim[key].on),
      eff: b.median_ttp / (1 + b.pct_on_drug),
    };
  }
  return rows;
}
const RADAR_AXES = [
  ["med", "Weeks in control (usual)"],
  ["p10", "Weeks in control (bad cases)"],
  ["free", "Drug-free %"],
  ["holiday", "Longest holiday"],
  ["eff", "Control per drug"],
];
function renderRadar() {
  const P = PATIENTS[PID];
  if (!P) return;
  const rows = radarMetrics(P);
  const c = $("radar");
  const [ctx, W, H] = fitCanvas(c);
  ctx.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2 + 6, R = Math.min(W, H) / 2 - 34;
  const norm = {};
  for (const [k] of RADAR_AXES) {
    const vs = RIVER_RULES.map(([key]) => rows[key][k]);
    const lo = Math.min(...vs), hi = Math.max(...vs);
    norm[k] = (v) => (hi <= lo ? 1 : 0.15 + 0.85 * ((v - lo) / (hi - lo)));
  }
  const pt = (ai, v) => {
    const a = -Math.PI / 2 + ai * (2 * Math.PI / RADAR_AXES.length);
    return [cx + Math.cos(a) * R * v, cy + Math.sin(a) * R * v];
  };
  ctx.font = "11px system-ui";
  for (const f of [0.33, 0.66, 1]) {
    ctx.beginPath();
    RADAR_AXES.forEach((_, ai) => { const [x, y] = pt(ai, f); ai ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath(); ctx.strokeStyle = "#262b29"; ctx.stroke();
  }
  RADAR_AXES.forEach(([k, label], ai) => {
    const [x, y] = pt(ai, 1);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y);
    ctx.strokeStyle = "#262b29"; ctx.stroke();
    ctx.fillStyle = "#9aa39f"; ctx.textAlign = "center";
    const lx = cx + (x - cx) * 1.22, ly = cy + (y - cy) * 1.22;
    ctx.fillText(label, Math.max(50, Math.min(W - 50, lx)), ly + 3);
  });
  const colors = { continuous: "#888888", standard: "#5b9cf5" };
  for (const [key] of RIVER_RULES) {
    ctx.beginPath();
    RADAR_AXES.forEach(([k], ai) => {
      const [x, y] = pt(ai, norm[k](rows[key][k]));
      ai ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = colors[key] + "2e"; ctx.fill();
    ctx.strokeStyle = colors[key]; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = colors[key];
    RADAR_AXES.forEach(([k], ai) => {
      const [x, y] = pt(ai, norm[k](rows[key][k]));
      ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
    });
  }
  ctx.textAlign = "left";
  let ly = 16;
  for (const [key, label] of RIVER_RULES) {
    ctx.fillStyle = colors[key];
    ctx.fillRect(8, ly - 9, 18, 4);
    ctx.fillStyle = "#f2f2f2";
    const r = rows[key];
    ctx.fillText(`${label}: usual ${r.med.toFixed(0)} wks in control / bad cases ${r.p10.toFixed(0)} wks / off drug ${r.free.toFixed(0)}% / longest break ${r.holiday} wks`, 30, ly);
    ly += 15;
  }
}

/* -------------------------------------------------------------- 4 · tree - */
function treeFamily(name) {
  if (name === "standard-baseline") return "start";
  if (name === "meta-llm") return "meta";
  return name.replace(/^local-/, "").replace(/\*$/, "");
}
function renderTree() {
  const P = PATIENTS[PID];
  if (!P) return;
  const log = P.agent.log;
  const svg = $("tree");
  const NS = "http://www.w3.org/2000/svg";
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const fams = [];
  log.forEach((e) => { const f = treeFamily(e.name); if (!fams.includes(f)) fams.push(f); });
  const W = 1000, laneH = 46, top = 26;
  const H = top + fams.length * laneH + 16;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("height", H * 0.42);
  const mk = (tag, attrs) => {
    const el = document.createElementNS(NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    svg.appendChild(el);
    return el;
  };
  const X = (i) => 120 + (i / Math.max(1, log.length - 1)) * (W - 150);
  const Y = (f) => top + fams.indexOf(f) * laneH + laneH / 2;
  fams.forEach((f) => {
    const t = mk("text", { x: 8, y: Y(f) + 4, "font-size": 13, fill: "#9aa39f" });
    t.textContent = f;
  });
  let running = -Infinity;
  const scored = log.map((e) => (e.scores ? vizObjective(e.scores) : null));
  const valid = scored.filter((v) => v !== null);
  const smin = Math.min(...valid), smax = Math.max(...valid);
  const bestPts = [];
  log.forEach((e, i) => {
    const sc = scored[i];
    if (sc !== null && sc > running) { running = sc; bestPts.push([X(i), Y(treeFamily(e.name))]); }
  });
  if (bestPts.length > 1) {
    mk("polyline", { points: bestPts.map((p) => p.join(",")).join(" "),
      fill: "none", stroke: "#e05252", "stroke-width": 2.5, opacity: 0.85 });
  }
  log.forEach((e, i) => {
    const sc = scored[i];
    const r = sc === null ? 4 : 4 + 9 * Math.max(0, Math.min(1, (sc - smin) / Math.max(1e-9, smax - smin)));
    const kept = e.verdict === "kept";
    const onPath = bestPts.some((p) => p[0] === X(i)) && sc !== null;
    const nd = mk("circle", { cx: X(i), cy: Y(treeFamily(e.name)), r: r.toFixed(1),
      fill: i === 0 ? "#e8e8e8" : kept ? "#35c163" : "#4a514e",
      stroke: onPath ? "#e8a33d" : "none", "stroke-width": 2.5 });
    const title = document.createElementNS(NS, "title");
    title.textContent = `iter ${e.iter} · ${e.name} · ${e.verdict} · ` +
      (e.scores ? `in control ${e.scores.median_ttp.toFixed(0)} weeks, on drug ${e.scores.pct_on_drug.toFixed(0)}%` : "not a working rule");
    nd.appendChild(title);
    nd.addEventListener("click", () => {
      $("treeCode").textContent = `# iter ${e.iter} · ${e.name} · ${e.verdict}\n` +
        `# ${e.reason}\n` + e.src;
    });
  });
}

/* ----------------------------------------------------------- 5 · barcodes - */
let barcodeOrder = null;
function renderBarcode() {
  const P = PATIENTS[PID];
  if (!P) return;
  const c = $("barcode");
  const [ctx, W, H] = fitCanvas(c);
  ctx.clearRect(0, 0, W, H);
  if (!barcodeOrder) {
    let s = 99;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    barcodeOrder = [...Array(120).keys()];
    for (let i = barcodeOrder.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [barcodeOrder[i], barcodeOrder[j]] = [barcodeOrder[j], barcodeOrder[i]];
    }
  }
  const rules = [["continuous", "Drug always on"], ["standard", "Usual break plan"]];
  const cols = rules.length, gap = 14, labelH = 20;
  const colW = (W - gap * (cols - 1)) / cols, cellW = colW / 120;
  rules.forEach(([key, label], ci) => {
    const S = P.sim[key], n = S.psa.length;
    const x0 = ci * (colW + gap), rowH = (H - labelH) / n;
    ctx.fillStyle = "#eeeeee"; ctx.textAlign = "left"; ctx.font = "11px system-ui";
    ctx.fillText(label, x0 + 2, 12);
    for (let w = 0; w < n; w++) {
      const frac = S.R[w] / (S.S[w] + S.R[w]);
      const k = Math.round(frac * 120), y = labelH + w * rowH;
      ctx.fillStyle = "#2e9e5b";
      ctx.fillRect(x0, y, colW, Math.max(1, rowH));
      ctx.fillStyle = "#d64545";
      for (let j = 0; j < k; j++) {
        ctx.fillRect(x0 + barcodeOrder[j] * cellW, y, Math.max(1, cellW), Math.max(1, rowH));
      }
    }
    if (S.progressed_week !== null) {
      const y = labelH + S.progressed_week * rowH;
      ctx.fillStyle = "#fff";
      ctx.fillRect(x0, y - 1, colW, 3);
      ctx.fillStyle = "#e05252"; ctx.textAlign = "right";
      ctx.fillText(`prog wk ${S.progressed_week}`, x0 + colW - 2, y - 4);
    }
  });
}

/* ------------------------------------------------------------------ driver - */
function renderViz() {
  if (!PATIENTS[PID]) return;
  renderTerrain();
  renderRiver();
  renderRadar();
  renderBarcode();
}
if ("IntersectionObserver" in window) {
  const vio = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.target.id === "terrain") terrain3d.visible = e.isIntersecting;
    }
  });
  vio.observe($("terrain"));
}
if (!terrain3d.raf) terrain3d.raf = requestAnimationFrame(terrainLoop);
