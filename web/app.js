/* EvoDose single-page app. All data is precomputed by src/run_pipeline.py. */
"use strict";

const $ = (id) => document.getElementById(id);

let PATIENTS = {}, SUMMARY = {}, SELECTION = null, PID = null;
let sim = null;

const visible = { fitChart: true, simCont: true, simStd: true };

function fitCanvas(c) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // Never trust a transient layout measurement: fall back to the element's
  // own width attribute so a mid-scroll/zoom read can't poison the canvas.
  let w = Math.round(c.clientWidth);
  if (!(w >= 50)) w = parseInt(c.getAttribute("width"), 10) || 600;
  const h = parseInt(c.getAttribute("height"), 10) || 300;
  // Only reallocate the backing store when the size actually changed:
  // reallocating every animation frame causes visible flicker and churn.
  if (c._bw !== w * dpr || c._bh !== h * dpr) {
    c.width = w * dpr; c.height = h * dpr;
    c._bw = w * dpr; c._bh = h * dpr;
  }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return [ctx, w, h];
}

/* ---------------------------------------------------------- fit chart --- */
function selectionFor(pid) {
  if (SELECTION && SELECTION.patients && SELECTION.patients[pid]) return SELECTION.patients[pid];
  const P = PATIENTS[pid];
  return (P && P.selection) || null;
}

function heldOutStats(P) {
  const { weeks, psa } = P.readings;
  const med = P.fit.median, b5 = P.fit.pi5, b95 = P.fit.pi95;
  let inside = 0, n = 0;
  for (let i = P.n_fit; i < weeks.length; i++) {
    const t = Math.max(0, Math.min(med.length - 1, Math.round(weeks[i])));
    n++;
    if (psa[i] >= b5[t] && psa[i] <= b95[t]) inside++;
  }
  return { inside, n };
}

function updateFitText() {
  const P = PATIENTS[PID];
  const { weeks } = P.readings;
  $("fitHint").textContent =
    `Patient ${PID}: ${weeks.length} blood-test readings. Left: the model learns from the ` +
    `first ${P.n_fit}. Right: it is tested on the rest — readings it never saw.`;
  const sel = selectionFor(PID);
  const hs = heldOutStats(P);
  const TIER = { strong: "Big saver — good break candidate", moderate: "Middle saver — maybe",
    low: "Small saver — break saves little", "not-a-candidate": "Should not take a break" };
  $("fitStats").innerHTML =
    stat("Starting blood test", P.baseline.toFixed(1) + " ng/mL") +
    stat("Test readings inside our range", hs.inside + " of " + hs.n) +
    stat("Typical miss on those tests", P.validation.mae.toFixed(1) + " ng/mL") +
    (sel ? stat("Should this patient take a break?", TIER[sel.tier] || sel.tier_label) +
           stat("Time off drug (our guess)", sel.predicted_drug_save_vs_cont.toFixed(0) + " of 100 wks") : "");
}

function renderFit() {
  const P = PATIENTS[PID];
  if (visible.fitChart === false) { updateFitText(); return; } // offscreen: skip canvas
  const { weeks, psa, on } = P.readings;
  const c = $("fitChart");
  const [ctx, W, H] = fitCanvas(c);
  ctx.clearRect(0, 0, W, H);
  const padL = 68, padR = 16, padT = 58, padB = 62;
  const plotB = H - padB;
  const wMax = Math.max(...weeks);
  const lo = Math.min(...psa, ...P.fit.pi5) * 0.85;
  const hi = Math.max(...psa, ...P.fit.pi95) * 1.25;
  const X = (w) => padL + (w / wMax) * (W - padL - padR);
  const Y = (v) => {
    const l0 = Math.log10(lo), l1 = Math.log10(hi);
    return padT + (1 - (Math.log10(Math.max(v, lo)) - l0) / (l1 - l0)) * (plotB - padT);
  };
  const med = P.fit.median, b5 = P.fit.pi5, b95 = P.fit.pi95;
  const sched = P.fit.schedule_weeks;
  const wSplit = weeks[P.n_fit];
  const splitX = X(wSplit);
  const medAt = (i) => med[Math.max(0, Math.min(med.length - 1, Math.round(weeks[i])))];

  // --- two zones: learning (muted) vs test (highlighted). The split is the
  // whole story of this slide, so it is drawn first and labelled in place.
  ctx.fillStyle = "rgba(244,244,242,0.025)";
  ctx.fillRect(padL, padT, Math.max(0, splitX - padL), plotB - padT);
  ctx.fillStyle = "rgba(52,211,189,0.055)";
  ctx.fillRect(splitX, padT, W - padR - splitX, plotB - padT);
  ctx.strokeStyle = "rgba(244,244,242,0.65)"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(splitX, padT); ctx.lineTo(splitX, plotB); ctx.stroke();
  ctx.setLineDash([]); ctx.lineWidth = 1;
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.font = "700 13px system-ui"; ctx.fillStyle = "#9aa39f";
  ctx.fillText("1 · LEARNING", padL + 10, padT - 32);
  ctx.font = "12px system-ui"; ctx.fillStyle = "#7d8581";
  ctx.fillText("model follows the first " + P.n_fit + " readings", padL + 10, padT - 14);
  ctx.font = "700 13px system-ui"; ctx.fillStyle = "#34d3bd";
  ctx.fillText("2 · TEST — the honest check", splitX + 12, padT - 32);
  ctx.font = "12px system-ui"; ctx.fillStyle = "#9fd8cf";
  ctx.fillText("guess made before seeing these readings", splitX + 12, padT - 14);

  // --- y axis: plain numbers, not 10^x. Log scale is kept (readings span
  // 0.02–63) but every label is a number a lay reader can compare.
  ctx.font = "12px system-ui"; ctx.textAlign = "right";
  ctx.strokeStyle = "rgba(168,176,173,0.13)"; ctx.fillStyle = "#9aa39f";
  for (const v of [0.1, 1, 10, 100]) {
    if (v < lo || v > hi) continue;
    const y = Y(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(String(v), padL - 8, y + 4);
  }
  ctx.save();
  ctx.translate(16, (padT + plotB) / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center"; ctx.fillStyle = "#9aa39f"; ctx.font = "12px system-ui";
  ctx.fillText("blood test (ng/mL) — each step ×10", 0, 0);
  ctx.restore();
  ctx.font = "12px system-ui"; ctx.fillStyle = "#9aa39f"; ctx.textAlign = "center";
  for (let w = 0; w <= wMax; w += 100) ctx.fillText(String(w), X(w), plotB + 18);
  ctx.textAlign = "right"; ctx.fillText("weeks →", W - padR, plotB + 36); ctx.textAlign = "center";

  // --- plausible range: faint while learning, strong only where it counts
  const bandPath = (from, to) => {
    ctx.beginPath();
    for (let t = from; t <= to; t++) { const x = X(Math.min(t, wMax)); const y = Y(Math.max(b95[t], 0.05)); t === from ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    for (let t = to; t >= from; t--) ctx.lineTo(X(Math.min(t, wMax)), Y(Math.max(b5[t], 0.05)));
    ctx.closePath();
  };
  const tSplit = Math.max(0, Math.min(sched.length - 1, Math.round(wSplit)));
  bandPath(0, tSplit); ctx.fillStyle = "rgba(52,211,189,0.05)"; ctx.fill();
  bandPath(tSplit, sched.length - 1); ctx.fillStyle = "rgba(52,211,189,0.16)"; ctx.fill();

  // --- model line: grey dashed while learning, bold teal as a forecast
  const linePath = (from, to) => {
    ctx.beginPath();
    for (let t = from; t <= to; t++) { const x = X(Math.min(t, wMax)); const y = Y(Math.max(med[t], 0.05)); t === from ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
  };
  linePath(0, tSplit);
  ctx.strokeStyle = "#8a938f"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
  linePath(tSplit, sched.length - 1);
  ctx.strokeStyle = "#34d3bd"; ctx.lineWidth = 3.5; ctx.lineJoin = "round"; ctx.stroke(); ctx.lineWidth = 1;

  // starting level reference
  ctx.setLineDash([5, 4]); ctx.strokeStyle = "rgba(244,244,242,0.35)";
  ctx.beginPath(); ctx.moveTo(padL, Y(P.baseline)); ctx.lineTo(W - padR, Y(P.baseline)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#c9cfcb"; ctx.textAlign = "left"; ctx.font = "11px system-ui";
  ctx.fillText("starting level (" + P.baseline.toFixed(0) + ")", padL + 8, Y(P.baseline) - 6);

  // direct label on the forecast, so no legend lookup is needed
  const tLab = Math.min(sched.length - 1, tSplit + Math.round((sched.length - tSplit) * 0.45));
  ctx.font = "700 12px system-ui"; ctx.fillStyle = "#34d3bd"; ctx.textAlign = "left";
  ctx.fillText("model guess →", X(Math.min(tLab, wMax)) - 20, Y(Math.max(med[tLab], 0.05)) - 12);
  ctx.font = "11px system-ui"; ctx.fillStyle = "#9fd8cf";
  ctx.fillText("shaded = plausible range", X(Math.min(tLab, wMax)) - 20, Y(Math.max(med[tLab], 0.05)) + 22);

  // --- readings: quiet while learning, large in the test zone, with a
  // connector to the guess so every miss is visible at a glance.
  for (let i = 0; i < weeks.length; i++) {
    if (i >= P.n_fit) continue;
    const x = X(weeks[i]), y = Y(psa[i]);
    ctx.beginPath(); ctx.arc(x, y, 3.2, 0, 7);
    if (on[i] === 1) { ctx.fillStyle = "rgba(232,163,61,0.5)"; ctx.fill(); }
    else { ctx.fillStyle = "#0a0a0a"; ctx.fill(); ctx.strokeStyle = "rgba(91,156,245,0.6)"; ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1; }
  }
  for (let i = P.n_fit; i < weeks.length; i++) {
    const x = X(weeks[i]), y = Y(psa[i]), gy = Y(Math.max(medAt(i), 0.05));
    const t = Math.max(0, Math.min(med.length - 1, Math.round(weeks[i])));
    const inside = psa[i] >= b5[t] && psa[i] <= b95[t];
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, gy);
    ctx.strokeStyle = inside ? "rgba(52,211,189,0.45)" : "rgba(224,82,82,0.65)";
    ctx.lineWidth = inside ? 1 : 1.8; ctx.stroke(); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, 7);
    if (on[i] === 1) ctx.fillStyle = "#e8a33d"; else ctx.fillStyle = "#0a0a0a";
    ctx.fill(); ctx.strokeStyle = on[i] === 1 ? "#ffd9a0" : "#5b9cf5"; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1;
    if (!inside) { // ring every reading the range missed
      ctx.beginPath(); ctx.arc(x, y, 9.5, 0, 7);
      ctx.strokeStyle = "rgba(224,82,82,0.9)"; ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1;
    }
  }

  // --- verdict callout: answer the slide's question inside the chart
  const hs = heldOutStats(P);
  const good = hs.n > 0 && hs.inside / hs.n >= 0.6;
  const bw = 316, bh = 74, bx = Math.min(splitX + 86, W - padR - bw), by = padT + 12;
  ctx.fillStyle = "rgba(6,10,9,0.88)";
  ctx.strokeStyle = good ? "rgba(53,193,99,0.7)" : "rgba(224,82,82,0.75)"; ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 8); else ctx.rect(bx, by, bw, bh);
  ctx.fill(); ctx.stroke(); ctx.lineWidth = 1;
  ctx.textAlign = "left";
  ctx.font = "700 13px system-ui"; ctx.fillStyle = good ? "#35c163" : "#ff7a7a";
  ctx.fillText(good ? "✓ It guessed well" : "✗ It missed often — be careful", bx + 12, by + 22);
  ctx.font = "12px system-ui"; ctx.fillStyle = "#e8ecea";
  ctx.fillText(hs.inside + " of " + hs.n + " test readings fall inside the shaded range.", bx + 12, by + 43);
  ctx.font = "11px system-ui"; ctx.fillStyle = "#9aa39f";
  ctx.fillText("Typical miss: " + P.validation.mae.toFixed(1) + " ng/mL · red ring = a miss", bx + 12, by + 62);

  // --- drug strip: taller, labelled, aligned with the same time axis
  const stripY = H - 22, stripH = 12;
  ctx.font = "11px system-ui"; ctx.fillStyle = "#9aa39f"; ctx.textAlign = "right";
  ctx.fillText("drug", padL - 8, stripY + 10);
  for (let i = 0; i < weeks.length; i++) {
    const x0 = X(weeks[i]);
    const x1 = X(i + 1 < weeks.length ? weeks[i + 1] : Math.min(weeks[i] + 4, wMax));
    ctx.fillStyle = on[i] === 1 ? "#e8a33d" : "#2c4a78";
    ctx.fillRect(x0, stripY, Math.max(1.5, x1 - x0), stripH);
  }
  ctx.textAlign = "left"; ctx.fillStyle = "#e8a33d";
  ctx.fillText("amber = on", padL, stripY - 4);
  ctx.fillStyle = "#7fa8e0";
  const offLabelX = Math.min(splitX + 12, W - padR - 70);
  ctx.fillText("blue = off", offLabelX, stripY - 4);
  updateFitText();
}

function sup(p) {
  const m = { "-": "⁻", 0: "⁰", 1: "¹", 2: "²", 3: "³" };
  return String(p).split("").map((ch) => m[ch] || ch).join("");
}
function stat(k, v) { return `<div><dt>${k}</dt><dd>${v}</dd></div>`; }

/* ------------------------------------------------------------ simulation - */
// 3D dishes (Three.js, vendored in web/vendor so the app stays fully local).
// One small scene per panel; cells are a single InstancedMesh in a ball, so
// circles can never stretch into dashes at any size or pixel density.
const DISH_N = 220, DISH_R = 1.15;
let dishTemplate = null; // seeded cell layout shared by all three panels
const dish3d = {}; // container id -> live scene state
function dishTemplateInit() {
  if (dishTemplate) return dishTemplate;
  let s = 42;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const pts = [];
  while (pts.length < DISH_N) {
    const x = rnd() * 2 - 1, y = rnd() * 2 - 1, z = rnd() * 2 - 1;
    if (x * x + y * y + z * z < 0.85) pts.push([x, y, z, 0.045 + rnd() * 0.035]);
  }
  const order = pts.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  dishTemplate = { pts, order };
  return dishTemplate;
}
function dishFail(el, why) {
  el.innerHTML = '<div class="dish-fallback">3D tumor view unavailable (' + why +
    "). Counters and scores above still update.</div>";
  window.__dish3d = "nogl";
}
function buildDish3D(id) {
  const el = $(id);
  if (typeof THREE === "undefined") { dishFail(el, "3D library did not load"); return null; }
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (e) { dishFail(el, "WebGL unavailable"); return null; }
  if (!renderer.getContext()) { dishFail(el, "WebGL unavailable"); return null; }
  const W = Math.max(50, el.clientWidth || 480), H = 260;
  renderer.setSize(W, H);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  el.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, W / H, 0.1, 100);
  camera.position.set(0, 0.35, 3.6);
  camera.lookAt(0, 0, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xdfe4e0, 0.95));
  const dir = new THREE.DirectionalLight(0xffffff, 0.75);
  dir.position.set(3, 4, 5);
  scene.add(dir);

  const group = new THREE.Group();
  group.rotation.x = -0.22;
  scene.add(group);
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(DISH_R + 0.12, 28, 20),
    new THREE.MeshBasicMaterial({ color: 0xcfd6d2, wireframe: true,
                                  transparent: true, opacity: 0.35 }));
  group.add(shell);

  const { pts, order } = dishTemplateInit();
  const geo = new THREE.SphereGeometry(1, 12, 10);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.InstancedMesh(geo, mat, DISH_N);
  const dummy = new THREE.Object3D();
  const green = new THREE.Color("#2e9e5b");
  order.forEach((pi, k) => {
    const [x, y, z, r] = pts[pi];
    dummy.position.set(x * DISH_R, y * DISH_R, z * DISH_R);
    dummy.scale.setScalar(r * DISH_R * 2.2);
    dummy.updateMatrix();
    mesh.setMatrixAt(k, dummy.matrix);
    mesh.setColorAt(k, green);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);

  const st = { el, renderer, scene, camera, mesh, order, nRes: -1,
               autoY: 0, userX: 0, userY: 0, dragging: false, px: 0, py: 0 };
  mesh.instanceColor.needsUpdate = true;
  el.addEventListener("pointerdown", (e) => {
    st.dragging = true; st.px = e.clientX; st.py = e.clientY;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (!st.dragging) return;
    st.userY += (e.clientX - st.px) * 0.012;
    st.userX = Math.max(-0.9, Math.min(0.9, st.userX + (e.clientY - st.py) * 0.012));
    st.px = e.clientX; st.py = e.clientY;
  });
  const stop = () => { st.dragging = false; };
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointercancel", stop);
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    camera.position.z = Math.max(2.2, Math.min(6, camera.position.z + e.deltaY * 0.003));
  }, { passive: false });
  dish3d[id] = st;
  window.__dish3d = "ok";
  return st;
}
const GREEN3D = "#2e9e5b", RED3D = "#d64545";
function paintDish3D(id, S, R) {
  let st = dish3d[id];
  if (!st) { st = buildDish3D(id); if (!st) return; }
  const nRes = Math.round(DISH_N * (R / (S + R)));
  if (st.nRes !== nRes) {
    const c = new THREE.Color();
    for (let k = 0; k < DISH_N; k++) {
      c.set(k < nRes ? RED3D : GREEN3D);
      st.mesh.setColorAt(k, c);
    }
    st.mesh.instanceColor.needsUpdate = true;
    st.nRes = nRes;
  }
  st.renderer.render(st.scene, st.camera);
}
function layoutDishes3D() {
  for (const id in dish3d) {
    const st = dish3d[id];
    const w = Math.round(st.el.clientWidth);
    if (!(w >= 50)) continue; // transient layout: keep the last good size
    st.renderer.setSize(w, 260);
    st.camera.aspect = w / 260;
    st.camera.updateProjectionMatrix();
  }
}
function spinDishes3D(dt) {
  for (const id in dish3d) {
    if (visible[id] === false) continue;
    const st = dish3d[id];
    st.autoY += dt * 0.25;
    st.mesh.parent.rotation.y = st.autoY + st.userY;
    st.mesh.parent.rotation.x = -0.22 + st.userX;
    st.renderer.render(st.scene, st.camera);
  }
}

function renderSimFrame() {
  const P = PATIENTS[PID];
  if (!P) return;
  layoutDishes3D();
  [["simCont", "continuous", "wkCont", "ctlCont", "drugCont"],
   ["simStd", "standard", "wkStd", "ctlStd", "drugStd"],
  ].forEach(
   ([id, key, wkId, ctlId, pillId]) => {
    if (visible[id] === false) return; // offscreen: skip, clock still advances
    const S = P.sim[key];
    const w = Math.min(Math.floor(sim.week), S.psa.length - 1);
    paintDish3D(id, S.S[w], S.R[w]);
    const prog = S.progressed_week;
    const controlled = prog === null ? w : Math.min(w, prog);
    $(wkId).textContent = w;
    $(ctlId).textContent = controlled;
    const pill = $(pillId);
    if (prog !== null && w >= prog) {
      pill.textContent = "progressed wk " + prog;
      pill.className = "pill prog";
    } else {
      pill.textContent = S.on[w] ? "drug ON" : "drug OFF";
      pill.className = "pill " + (S.on[w] ? "on" : "off");
    }
  });
}

let rafId = null, lastT = -1, lastPaint = 0, lastTickAt = 0;
function simError(msg) {
  let el = $("simError");
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? "block" : "none";
}
function tick(t) {
  rafId = null;
  try {
    if ($("playBtn").textContent !== "Pause" || !PATIENTS[PID]) return;
    lastTickAt = performance.now();
    if (lastT < 0) lastT = t;
    // Clamp delta so a hidden tab or a slow frame never jumps the sim forward.
    const dt = Math.min(Math.max((t - lastT) / 1000, 0), 0.25);
    lastT = t;
    const P = PATIENTS[PID];
    sim.week += parseFloat($("speed").value) * dt;
    if (sim.week >= P.sim.horizon - 1) {
      sim.week = P.sim.horizon - 1;
      lastPaint = 0; // force a final paint even under the throttle below
      renderSimFrame();
      setPlaying(false);
      return;
    }
    // Paint at most ~12 fps: counters stay live while the GPU gets 5x less work.
    if (t - lastPaint >= 80) {
      lastPaint = t;
      renderSimFrame();
    } else {
      spinDishes3D(dt); // smooth 3D rotation between paint ticks
    }
  } catch (err) {
    // Never die silently mid-run: report and stop instead of freezing blank.
    setPlaying(false);
    simError("Simulation stopped: " + (err && err.message ? err.message : err));
    return;
  }
  rafId = requestAnimationFrame(tick);
}
function setPlaying(play) {
  $("playBtn").textContent = play ? "Pause" : "Play";
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  lastT = -1;
  if (play) {
    simError("");
    lastTickAt = performance.now();
    rafId = requestAnimationFrame(tick);
  }
}

/* ----------------------------------------------------- Meta Muse Agent log - */
function scoreTxt(s) {
  if (!s) return "not a working rule";
  return `cancer in control ${s.median_ttp.toFixed(0)} weeks (usual case) · bad cases ${s.p10_ttp.toFixed(0)} weeks · on drug ${s.pct_on_drug.toFixed(0)}% of weeks`;
}

function simpleWords(text) {
  return String(text || "")
    .replace(/pauses treatment/g, "stops the drug")
    .replace(/restarts it/g, "starts the drug again")
    .replace(/restart/g, "start again")
    .replace(/baseline PSA/g, "starting blood test")
    .replace(/\bPSA\b/g, "blood test")
    .replace(/fractions of baseline/g, "parts of the starting level")
    .replace(/hysteresis/g, "different stop and start levels")
    .replace(/sensitive cells/g, "green cells")
    .replace(/resistant cells/g, "red cells")
    .replace(/progression/g, "loss of control")
    .replace(/the trial protocol's intent/g, "the usual plan's idea");
}

function renderAgent(reveal = -1) {
  if (!$("bestCode")) return; // smart-rule slide removed from the deck
  const P = PATIENTS[PID];
  const best = P.agent.best;
  $("bestCode").textContent = best.src;
  $("bestExpl").textContent = simpleWords(best.explanation);
  $("agentName").textContent = "· " + best.name + " · " + best.backend;
  $("agentTag").textContent =
    `cancer in control ${best.scores.median_ttp.toFixed(0)} weeks (usual case) · ` +
    `bad cases ${best.scores.p10_ttp.toFixed(0)} weeks · ` +
    `on drug ${best.scores.pct_on_drug.toFixed(0)}% of weeks`;

  const b = P.baselines, a = best.scores;
  const rows = [
    ["Weeks cancer stays in control (usual case)", b.continuous.median_ttp, b.standard.median_ttp, a.median_ttp, "max"],
    ["Weeks in control in bad cases", b.continuous.p10_ttp, b.standard.p10_ttp, a.p10_ttp, "max"],
    ["Time on drug (% of weeks)", b.continuous.pct_on_drug, b.standard.pct_on_drug, a.pct_on_drug, "min"],
  ];
  let html = "<tr><th></th><th>Drug always on</th><th>Usual plan</th><th>Computer plan</th></tr>";
  for (const [label, c, s, g, dir] of rows) {
    const vals = [c, s, g];
    const win = dir === "max" ? Math.max(...vals) : Math.min(...vals);
    html += `<tr><td>${label}</td>` + vals.map((v, i) =>
      `<td${v === win && i === 2 ? ' class="winnercell"' : ""}>${v.toFixed(i < 2 ? 0 : 1)}</td>`).join("") + "</tr>";
  }
  $("compareTable").innerHTML = html;

  const log = P.agent.log;
  $("agentLog").innerHTML = log.map((e, i) => {
    const cls = reveal >= 0 && i > reveal ? "pending" : e.verdict;
    return `<li class="${cls}">
      <div class="meta"><span class="tag">try ${e.iter}</span>
      <span class="${e.verdict === "kept" ? "kepttag" : "rejtag"}">${e.verdict === "kept" ? "KEPT — scored better" : "NOT KEPT"}</span></div>
      <div class="scores">${scoreTxt(e.scores)}</div>
      <details><summary>see this rule (code)</summary><pre>${escapeHtml(e.src)}</pre></details>
    </li>`;
  }).join("");
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

let replayTimer = null, replayToken = 0;
function replayLog() {
  if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
  const myToken = ++replayToken;
  const pid = PID;
  const n = PATIENTS[pid].agent.log.length;
  const el = $("agentLog");
  let i = -1;
  renderAgent(i);
  replayTimer = setInterval(() => {
    if (myToken !== replayToken || pid !== PID) {
      clearInterval(replayTimer); replayTimer = null; return;
    }
    i++;
    const top = el.scrollTop; // rebuilding the list must not yank the scroll
    renderAgent(i);
    el.scrollTop = top;
    if (i >= n - 1) { clearInterval(replayTimer); replayTimer = null; }
  }, 300);
}

/* --------------------------------------------------------------- summary -- */
function renderSummary() {
  const rows = SUMMARY.rows;
  let html = "<tr><th>Patient</th><th>Starting blood test</th><th>Model guess error</th>" +
    "<th>Drug always on: weeks in control</th>" +
    "<th>Break plan: weeks in control</th><th>Break plan: bad cases</th><th>Break plan: time on drug %</th></tr>";
  for (const r of rows) {
    const win = r.std_med >= r.cont_med ? ' class="winner"' : "";
    html += `<tr${win}><td>${r.patient}</td><td>${r.baseline}</td><td>${r.val_log_rmse}</td>` +
      `<td>${r.cont_med}</td>` +
      `<td>${r.std_med}</td><td>${r.std_p10}</td><td>${r.std_on}</td></tr>`;
  }
  $("summaryTable").innerHTML = html;
  $("overallLine").textContent =
    `On average, the model's guess missed by ${SUMMARY.overall.mean_mae.toFixed(1)} ng/mL on blood tests ` +
    `it had never seen, across ${SUMMARY.n_patients} patients. ` +
    `Bold rows: break plan keeps control at least as long as drug always on.`;
}

/* ------------------------------------------------------------- selection -- */
function renderSelection() {
  const S = (SELECTION && SELECTION.available) ? SELECTION : SUMMARY.selection;
  const intro = $("selectionIntro"), stats = $("selectionStats"),
        table = $("selectionTable"), method = $("selectionMethod");
  if (!intro) return;
  if (!S || !S.available) {
    intro.textContent = "Not enough patients here to do this test.";
    return;
  }
  const h = S.held_out, o = S.overall;
  intro.textContent =
    `Taking a break does not beat never stopping by keeping control longer. It wins by ` +
    `using less drug: across ${S.n_patients} patients, a break plan spends ` +
    `${o.drug_save_vs_cont.toFixed(0)} of every 100 weeks off the drug, and control is ` +
    `still ${o.ttp_change_vs_cont >= 0 ? "+" : ""}${o.ttp_change_vs_cont.toFixed(1)} weeks vs never stopping. ` +
    `But some patients save only a few weeks, and some save 99. We try to guess who saves most.`;
  stats.innerHTML =
    stat("Patients we picked: weeks off drug, out of 100", h.drug_save_vs_cont.selected_mean.toFixed(0) + " wks") +
    stat("All patients: weeks off drug, out of 100", h.drug_save_vs_cont.all_mean.toFixed(0) + " wks") +
    stat("Picked patients: control vs never stopping", (h.ttp_change_vs_cont.selected_mean >= 0 ? "+" : "") + h.ttp_change_vs_cont.selected_mean.toFixed(1) + " wks") +
    stat("Big savers (70+ wks off): picked vs all", `${(h.high_saver.selected_rate * 100).toFixed(0)}% vs ${(h.high_saver.all_rate * 100).toFixed(0)}%`) +
    stat("Big / middle / small savers", `${S.tier_counts.strong || 0} / ${S.tier_counts.moderate || 0} / ${S.tier_counts.low || 0}`);
  const top = Object.entries(S.patients)
    .sort((a, b) => b[1].predicted_drug_save_vs_cont - a[1].predicted_drug_save_vs_cont).slice(0, 10);
  const COHORT = { "bruchovsky-real": "Bruchovsky study", shaw: "Shaw study", zhang: "Zhang study" };
  const TIER = { strong: "Big saver", moderate: "Middle saver", low: "Small saver", "not-a-candidate": "Should not take a break" };
  table.innerHTML = "<tr><th>Patient</th><th>Study</th><th>Our guess</th>" +
    "<th>We guessed: weeks off, of 100</th><th>True: weeks off, of 100</th><th>Control vs never stopping (wks)</th></tr>" +
    top.map(([pid, p]) => `<tr><td>${pid}</td><td>${COHORT[p.cohort] || p.cohort || ""}</td>` +
      `<td class="tier-${p.tier}">${TIER[p.tier] || p.tier_label}</td>` +
      `<td>${p.predicted_drug_save_vs_cont.toFixed(0)}</td>` +
      `<td>${p.actual.drug_save_vs_cont.toFixed(0)}</td>` +
      `<td>${p.actual.ttp_change_vs_cont.toFixed(0)}</td></tr>`).join("");
  const DRIVER = { log_f: "few red cells at the start", r_r: "red cells grow slowly",
    log_baseline: "high starting blood test", kill: "drug kills green cells well",
    rr_rs: "red cells grow much slower than green", nadir_ratio: "blood test fell very low",
    off_slope: "blood test rises slowly on a break" };
  const drivers = (S.feature_weights || []).slice(0, 3)
    .map((w) => DRIVER[w.feature] || w.label).join(" · ");
  method.textContent =
    `How we know this is fair: when we guess a patient, the model has never seen that patient. ` +
    `We did this test many times with new groups each time. Big savers often have: ${drivers}. ` +
    `Taking even longer breaks does not help — in our model it made control much worse for many ` +
    `patients. This is an idea for who to test first in a real study. It is not a treatment plan.`;
}

/* ------------------------------------------------------------------ boot -- */
function selectPatient(pid) {
  PID = pid;
  replayToken++; // stop any in-flight log replay for the previous patient
  sim = { week: 0 };
  renderFit();
  renderAgent();
  if (typeof renderViz === "function") renderViz();
  if (typeof renderV3Panel === "function") renderV3Panel();
  setPlaying(true);
  renderSimFrame();
  if (typeof fitSlides === "function") fitSlides();
}

async function boot() {
  const [p, s] = await Promise.all([
    fetch("data/patients.json").then((r) => r.json()),
    fetch("data/summary.json").then((r) => r.json()),
  ]);
  PATIENTS = p; SUMMARY = s;
  try {
    const r = await fetch("selection.json");
    if (r.ok) SELECTION = await r.json();
  } catch (e) { SELECTION = null; }
  renderSelection();
  $("patient").innerHTML = Object.keys(PATIENTS).sort()
    .map((k) => `<option>${k}</option>`).join("");
  $("patient").addEventListener("change", (e) => { setPlaying(false); selectPatient(e.target.value); });
  $("playBtn").addEventListener("click", () => {
    if ($("playBtn").textContent === "Play") {
      // A finished run restarts from week 0 instead of sitting dead at the end.
      if (sim.week >= PATIENTS[PID].sim.horizon - 1) sim.week = 0;
      setPlaying(true);
    } else {
      setPlaying(false);
    }
  });
  $("restartBtn").addEventListener("click", () => { sim.week = 0; renderSimFrame(); });
  $("speed").addEventListener("change", () => { if ($("playBtn").textContent === "Pause") setPlaying(true); });
  if ($("replayBtn")) $("replayBtn").addEventListener("click", replayLog);
  window.addEventListener("resize", () => { renderFit(); renderSimFrame(); if (typeof fitSlides === "function") fitSlides(); });
  // Self-healing canvas size: if the backing store was measured before final
  // layout (late stylesheet, restored tab, zoom), any size change re-renders.
  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(() => { renderFit(); renderSimFrame(); });
    ["fitChart", "simCont", "simStd"].forEach((id) => ro.observe($(id)));
  }
  window.addEventListener("load", () => { renderFit(); renderSimFrame(); if (typeof fitSlides === "function") fitSlides(); });
  // Heartbeat: if the frame loop ever stalls while it should be playing
  // (killed callback, throttled tab), resume it instead of freezing.
  setInterval(() => {
    if ($("playBtn").textContent === "Pause" && PATIENTS[PID] &&
        lastTickAt > 0 && performance.now() - lastTickAt > 2500) {
      lastT = -1;
      lastTickAt = performance.now();
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(tick);
    }
  }, 1000);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { renderFit(); renderSimFrame(); if (typeof fitSlides === "function") fitSlides(); });
  }
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      let repaint = false;
      for (const e of entries) {
        const was = visible[e.target.id];
        visible[e.target.id] = e.isIntersecting;
        if (e.isIntersecting && was === false) repaint = true;
      }
      // A panel scrolled back into view repaints immediately, never stale.
      if (repaint) { renderFit(); renderSimFrame(); }
    });
    ["fitChart", "simCont", "simStd"].forEach((id) => io.observe($(id)));
  }
  renderSummary();
  selectPatient(Object.keys(PATIENTS).sort()[0]);
}

boot();
