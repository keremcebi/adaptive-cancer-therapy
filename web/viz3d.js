/* EvoDose 3D tumor views: twelve alternative ways to watch the same tumor
   progress. Classic script sharing app.js globals. One Three.js scene,
   rebuilt when the view, rule, or patient changes; animated by sim.week.
   The last six look through a microscope: the tumor as a cell field. */
"use strict";

const V3_VIEWS = [
  ["shell", "Resistant core"],
  ["voxel", "Voxel cube"],
  ["towers", "Timeline towers"],
  ["spiral", "Spiral column"],
  ["vessel", "Vessel"],
  ["network", "Contagion"],
  ["ember", "Darkfield"],
  ["ripple", "Fluorescence"],
  ["bloom", "H&E stain"],
  ["orbits", "Chemotaxis"],
  ["dandelion", "Z-stack"],
  ["shader", "Shader scope"],
];
/* v3field: a microscope cell field — scattered non-overlapping cells in a
   disc, each with a drift phase and an invasion threshold so resistance
   spreads outward from the center as the sim's resistant fraction rises. */
function v3field(n, R, seedNum, jit) {
  let s = seedNum;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const pts = [];
  let guard = 0;
  while (pts.length < n && guard++ < n * 80) {
    const x = (rnd() * 2 - 1) * R, z = (rnd() * 2 - 1) * R * 0.72;
    if (x * x + z * z > R * R) continue;
    if (pts.some((p) => (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < 0.09)) continue;
    pts.push({ x, z, y: (rnd() - 0.5) * 0.3, ph: rnd() * Math.PI * 2,
               sp: 0.5 + rnd() * 0.8, sz: 0.75 + rnd() * 0.5 });
  }
  pts.forEach((p) => {
    p.thr = 0.05 + 0.9 * (Math.sqrt(p.x * p.x + p.z * p.z) / R) + (rnd() - 0.5) * (jit || 0.2);
  });
  pts.sort((a, b) => a.thr - b.thr);
  return { pts, rnd };
}
const V3_RULES = ["continuous", "standard"];
const V3_CAPTIONS = {
  shell: "A red center grows inside a green shell. Green = drug can kill it. Red = drug cannot.",
  voxel: "One thousand tiny blocks of tissue. Red spreads out from the middle.",
  towers: "Bars for each five weeks: green at the bottom, red on top. The dark mark shows the week.",
  spiral: "Cells in a spiral tower. Red climbs up as it takes over.",
  vessel: "The cancer as liquid in a jar: green below, red floating on top.",
  network: "Cells joined to their neighbors. Red spreads out from the center.",
  ember: "Cells glowing on black, slowly drifting. Red cells flare bright.",
  ripple: "Green tags on cells the drug can kill. Red groups burn bright.",
  bloom: "Cells dyed pink and purple, like under a real microscope. Sick cell centers turn dark.",
  orbits: "Red cells pull toward the middle as they take over. Watch the whole group drift in.",
  dandelion: "Looking through the sample layer by layer. Only the layer in focus shines.",
  shader: "No solid shapes at all — the picture is drawn by math alone: cells, centers, drift, and the red front.",
};
const V3 = { st: null, visible: true, raf: null, view: "shell", rule: "standard", lastKey: "" };

function v3seeded(n) {
  let s = 1234567;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const order = [...Array(n).keys()];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return { rnd, order };
}
function buildV3() {
  const el = $("stage3d");
  if (typeof THREE === "undefined") {
    el.innerHTML = '<div class="dish-fallback">3D views need the local Three.js file.</div>';
    return null;
  }
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (e) {
    el.innerHTML = '<div class="dish-fallback">3D unavailable (WebGL disabled).</div>';
    return null;
  }
  if (!renderer.getContext()) {
    el.innerHTML = '<div class="dish-fallback">3D unavailable (WebGL disabled).</div>';
    return null;
  }
  const W = Math.max(50, el.clientWidth || 800), H = Math.max(50, el.clientHeight || 400);
  renderer.setSize(W, H);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, W / H, 0.1, 100);
  camera.position.set(0, 1.1, 6.2);
  camera.lookAt(0, 0.1, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xdfe4e0, 1.0));
  const dir = new THREE.DirectionalLight(0xffffff, 0.65);
  dir.position.set(3, 5, 4);
  scene.add(dir);
  const st = { el, renderer, scene, camera, content: null,
               rotY: 0.5, tilt: 0, zoom: 1, dragging: false, px: 0, py: 0,
               lastW: -1, peak: 1 };
  el.addEventListener("pointerdown", (e) => {
    st.dragging = true; st.px = e.clientX; st.py = e.clientY;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (!st.dragging) return;
    st.rotY += (e.clientX - st.px) * 0.009;
    st.tilt = Math.max(-0.9, Math.min(0.9, st.tilt + (e.clientY - st.py) * 0.009));
    st.px = e.clientX; st.py = e.clientY;
  });
  const stop = () => { st.dragging = false; };
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointercancel", stop);
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    camera.position.z = Math.max(3, Math.min(11, camera.position.z + e.deltaY * 0.005));
  }, { passive: false });
  const scope = document.createElement("div");
  scope.className = "micro";
  scope.innerHTML = '<div class="ret"></div><div class="mag">40× · 50 µm</div>';
  el.appendChild(scope);
  st.scopeEl = scope;
  V3.st = st;
  window.__v3 = "ok";
  return st;
}
function v3clear(st) {
  if (!st.view) return; // views accumulate if the old group is not removed
  st.scene.remove(st.view.group);
  st.view.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    if (o.isInstancedMesh) o.dispose();
  });
  st.view = null;
}
function v3fit() {
  const st = V3.st;
  if (!st) return;
  const w = Math.round(st.el.clientWidth);
  const h = Math.max(50, Math.round(st.el.clientHeight || 400));
  if (!(w >= 50)) return;
  st.renderer.setSize(w, h);
  st.camera.aspect = w / h;
  st.camera.updateProjectionMatrix();
}

function v3frac(S, w) {
  const d = S.S[w] + S.R[w];
  return d > 0 ? S.R[w] / d : 0;
}

/* ----------------------------------------------- builders (per view) ---- */
function v3shell(st, S) {
  const g = new THREE.Group();
  const R = 1.5;
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(R + 0.06, 28, 20),
    new THREE.MeshBasicMaterial({ color: 0xcfd6d2, wireframe: true, transparent: true, opacity: 0.3 }));
  g.add(shell);
  const outer = new THREE.Mesh(
    new THREE.SphereGeometry(R, 28, 20),
    new THREE.MeshStandardMaterial({ color: 0x2e9e5b, roughness: 0.6, metalness: 0.05,
      transparent: true, opacity: 0.32, depthWrite: false }));
  g.add(outer);
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(1, 24, 18),
    new THREE.MeshStandardMaterial({ color: 0xd64545, roughness: 0.55, metalness: 0.05 }));
  core.scale.setScalar(0.001);
  g.add(core);
  st.scene.add(g);
  return { group: g, update(w) {
    const f = S.R[w] / (S.S[w] + S.R[w]);
    core.scale.setScalar(Math.max(0.001, R * Math.cbrt(f)));
  } };
}
function v3voxel(st, S) {
  const N = 10, size = 0.24, gap = 0.015;
  const geo = new THREE.BoxGeometry(size, size, size);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.05 });
  const mesh = new THREE.InstancedMesh(geo, mat, N * N * N);
  const dummy = new THREE.Object3D();
  const green = new THREE.Color("#2e9e5b");
  const cells = [];
  for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) for (let z = 0; z < N; z++) {
    cells.push([x - (N - 1) / 2, y - (N - 1) / 2, z - (N - 1) / 2]);
  }
  // center-out order so resistance invades from the middle
  cells.sort((a, b) => (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) - (b[0] * b[0] + b[1] * b[1] + b[2] * b[2]));
  cells.forEach((p, k) => {
    dummy.position.set(p[0] * (size + gap), p[1] * (size + gap), p[2] * (size + gap));
    dummy.updateMatrix();
    mesh.setMatrixAt(k, dummy.matrix);
    mesh.setColorAt(k, green);
  });
  mesh.instanceColor.needsUpdate = true;
  const g = new THREE.Group();
  g.add(mesh);
  st.scene.add(g);
  return { group: g, update(w) {
    const red = new THREE.Color("#d64545"), gr = new THREE.Color("#2e9e5b");
    const k = Math.round(cells.length * (S.R[w] / (S.S[w] + S.R[w])));
    for (let i = 0; i < cells.length; i++) mesh.setColorAt(i, i < k ? red : gr);
    mesh.instanceColor.needsUpdate = true;
  } };
}
function v3towers(st, S) {
  const BINS = 52, per = Math.ceil(S.psa.length / BINS);
  const bins = [];
  for (let b = 0; b < BINS; b++) {
    let s = 0, r = 0, on = 0;
    for (let t = b * per; t < Math.min((b + 1) * per, S.psa.length); t++) {
      s += S.S[t]; r += S.R[t]; on += S.on[t];
    }
    bins.push({ s: s / per, r: r / per, on: on / per });
  }
  const peak = Math.max(...bins.map((b) => b.s + b.r)) || 1;
  const H = 2.6, bw = 0.16, step = 0.22, x0 = -((BINS - 1) * step) / 2;
  const g = new THREE.Group();
  const mkBar = (color) => {
    const m = new THREE.InstancedMesh(new THREE.BoxGeometry(bw, 1, bw),
      new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05 }), BINS);
    g.add(m);
    return m;
  };
  const gm = mkBar(0x2e9e5b), rm = mkBar(0xd64545);
  const dummy = new THREE.Object3D();
  bins.forEach((b, i) => {
    const hs = (b.s / peak) * H, hr = (b.r / peak) * H;
    dummy.position.set(x0 + i * step, hs / 2 - H / 2, 0);
    dummy.scale.set(1, Math.max(hs, 0.001), 1);
    dummy.updateMatrix(); gm.setMatrixAt(i, dummy.matrix);
    dummy.position.set(x0 + i * step, hs + hr / 2 - H / 2, 0);
    dummy.scale.set(1, Math.max(hr, 0.001), 1);
    dummy.updateMatrix(); rm.setMatrixAt(i, dummy.matrix);
  });
  gm.instanceMatrix.needsUpdate = true;
  rm.instanceMatrix.needsUpdate = true;
  const marker = new THREE.Mesh(new THREE.BoxGeometry(0.05, H + 0.2, 0.5),
    new THREE.MeshBasicMaterial({ color: 0x1c2420 }));
  g.add(marker);
  st.scene.add(g);
  return { group: g, update(w) {
    marker.position.x = x0 + Math.min(BINS - 1, Math.floor(w / per)) * step;
  } };
}
function v3spiral(st, S) {
  const { pts, order } = dishTemplateInit3D();
  const geo = new THREE.SphereGeometry(1, 10, 8);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.InstancedMesh(geo, mat, DISH_N);
  const dummy = new THREE.Object3D();
  const green = new THREE.Color("#2e9e5b");
  const H = 3.0;
  order.forEach((pi, k) => {
    const a = (k / DISH_N) * Math.PI * 10;
    const r = 0.9 * (1 - (k / DISH_N) * 0.35);
    dummy.position.set(Math.cos(a) * r, (k / DISH_N - 0.5) * H, Math.sin(a) * r);
    dummy.scale.setScalar(pts[pi][3] * 14);
    dummy.updateMatrix();
    mesh.setMatrixAt(k, dummy.matrix);
    mesh.setColorAt(k, green);
  });
  mesh.instanceColor.needsUpdate = true;
  const g = new THREE.Group();
  g.add(mesh);
  st.scene.add(g);
  return { group: g, spin: true, update(w, S) {
    const red = new THREE.Color("#d64545"), gr = new THREE.Color("#2e9e5b");
    const k = Math.round(DISH_N * (S.R[w] / (S.S[w] + S.R[w])));
    for (let i = 0; i < DISH_N; i++) mesh.setColorAt(i, i < k ? red : gr);
    mesh.instanceColor.needsUpdate = true;
  } };
}
function v3vessel(st, S) {
  const g = new THREE.Group();
  const R = 1.0, H = 3.0;
  const glass = new THREE.Mesh(
    new THREE.CylinderGeometry(R + 0.08, R + 0.08, H + 0.2, 28, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xcfd6d2, wireframe: true, transparent: true, opacity: 0.3,
      side: THREE.DoubleSide }));
  g.add(glass);
  const mkLiquid = (color) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 1, 28),
      new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.05,
        transparent: true, opacity: 0.92 }));
    g.add(m);
    return m;
  };
  const sMesh = mkLiquid(0x2e9e5b), rMesh = mkLiquid(0xd64545);
  st.scene.add(g);
  let peak = 0;
  for (let t = 0; t < S.psa.length; t++) peak = Math.max(peak, S.S[t] + S.R[t]);
  return { group: g, update(w) {
    const hs = Math.max((S.S[w] / peak) * H, 0.001);
    const hr = Math.max((S.R[w] / peak) * H, 0.001);
    sMesh.scale.y = hs; sMesh.position.y = -H / 2 + hs / 2;
    rMesh.scale.y = hr; rMesh.position.y = -H / 2 + hs + hr / 2;
  } };
}
function v3network(st, S) {
  let s = 777;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const N = 120, pts = [];
  while (pts.length < N) {
    const x = rnd() * 2 - 1, y = rnd() * 2 - 1, z = rnd() * 2 - 1;
    if (x * x + y * y + z * z < 0.9) pts.push([x * 1.4, y * 1.4, z * 1.4]);
  }
  const order = pts.map((_, i) => i).sort((a, b) =>
    (pts[a][0] ** 2 + pts[a][1] ** 2 + pts[a][2] ** 2) - (pts[b][0] ** 2 + pts[b][1] ** 2 + pts[b][2] ** 2));
  const g = new THREE.Group();
  const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.07, 10, 8),
    new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 }), N);
  const dummy = new THREE.Object3D();
  const green = new THREE.Color("#2e9e5b");
  order.forEach((pi, k) => {
    dummy.position.set(...pts[pi]);
    dummy.updateMatrix();
    mesh.setMatrixAt(k, dummy.matrix);
    mesh.setColorAt(k, green);
  });
  mesh.instanceColor.needsUpdate = true;
  g.add(mesh);
  const lp = [];
  order.forEach((pi, k) => {
    const dists = order.map((qj, m) => [m, (pts[pi][0] - pts[qj][0]) ** 2 +
      (pts[pi][1] - pts[qj][1]) ** 2 + (pts[pi][2] - pts[qj][2]) ** 2]);
    dists.sort((a, b) => a[1] - b[1]);
    for (let j = 1; j <= 2 && j < dists.length; j++) {
      const q = dists[j][0];
      if (q > k) { lp.push(...pts[pi], ...pts[order[q]]); }
    }
  });
  const lg = new THREE.BufferGeometry();
  lg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(lp), 3));
  g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xb9c2bd, transparent: true, opacity: 0.5 })));
  st.scene.add(g);
  return { group: g, spin: true, update(w) {
    const red = new THREE.Color("#d64545"), gr = new THREE.Color("#2e9e5b");
    const k = Math.round(N * (S.R[w] / (S.S[w] + S.R[w])));
    for (let i = 0; i < N; i++) mesh.setColorAt(i, i < k ? red : gr);
    mesh.instanceColor.needsUpdate = true;
  } };
}
function dishTemplateInit3D() {
  if (!dishTemplateInit3D.cache) {
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
    dishTemplateInit3D.cache = { pts, order };
  }
  return dishTemplateInit3D.cache;
}
/* ------------------------------- five new spread pieces -------- */
function v3ember(st, S) {
  // Darkfield microscopy: unstained cells glowing pale on black, drifting
  // with Brownian motion; resistant cells flare red from the center outward
  st.camera.position.set(0, 4.6, 2.8);
  st.camera.lookAt(0, 0, 0);
  const F = v3field(210, 2.6, 4242, 0.2);
  const N = F.pts.length;
  const g = new THREE.Group();
  const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.085, 12, 10),
    new THREE.MeshBasicMaterial({}), N);
  const healthy = new THREE.Color("#a8d9b8"), sick = new THREE.Color("#ff2a12");
  const dummy = new THREE.Object3D();
  F.pts.forEach((c, i) => {
    dummy.position.set(c.x, c.y, c.z);
    dummy.scale.setScalar(c.sz);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, healthy);
  });
  mesh.instanceColor.needsUpdate = true;
  g.add(mesh);
  st.scene.add(g);
  return { group: g, norotate: true, t: 0, prog: -1,
    update(w, S) {
      const fr = v3frac(S, w);
      if (Math.abs(fr - this.prog) < 0.001 && this.prog >= 0) return;
      this.prog = fr;
      F.pts.forEach((c, i) => mesh.setColorAt(i, c.thr < fr ? sick : healthy));
      mesh.instanceColor.needsUpdate = true;
    },
    tick(dt) {
      this.t += dt;
      F.pts.forEach((c, i) => {
        dummy.position.set(
          c.x + Math.sin(this.t * c.sp + c.ph) * 0.09,
          c.y + Math.cos(this.t * c.sp * 0.8 + c.ph) * 0.05,
          c.z + Math.cos(this.t * c.sp * 0.6 + c.ph * 1.7) * 0.09);
        dummy.scale.setScalar(c.sz);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    } };
}
function v3ripple(st, S) {
  // Fluorescence microscopy: green-tagged sensitive cells on black with an
  // additive glow halo; resistant clones burn red as they take over
  st.camera.position.set(0, 4.6, 2.8);
  st.camera.lookAt(0, 0, 0);
  const F = v3field(210, 2.6, 777, 0.24);
  const N = F.pts.length;
  const g = new THREE.Group();
  const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.075, 12, 10),
    new THREE.MeshBasicMaterial({}), N);
  const healthy = new THREE.Color("#1fae5f"), sick = new THREE.Color("#ff2010");
  const dummy = new THREE.Object3D();
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
  const hcol = [0.12, 0.68, 0.37], scol = [1.0, 0.13, 0.06];
  F.pts.forEach((c, i) => {
    dummy.position.set(c.x, c.y, c.z);
    dummy.scale.setScalar(c.sz);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, healthy);
    col.set(hcol, i * 3);
  });
  mesh.instanceColor.needsUpdate = true;
  const pg = new THREE.BufferGeometry();
  pg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  pg.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const halo = new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.22,
    vertexColors: true, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false }));
  halo.frustumCulled = false;
  g.add(mesh); g.add(halo);
  st.scene.add(g);
  return { group: g, norotate: true, t: 0, prog: -1,
    update(w, S) {
      const fr = v3frac(S, w);
      if (Math.abs(fr - this.prog) < 0.001 && this.prog >= 0) return;
      this.prog = fr;
      F.pts.forEach((c, i) => {
        const on = c.thr < fr;
        mesh.setColorAt(i, on ? sick : healthy);
        col.set(on ? scol : hcol, i * 3);
      });
      mesh.instanceColor.needsUpdate = true;
      pg.attributes.color.needsUpdate = true;
    },
    tick(dt) {
      this.t += dt;
      F.pts.forEach((c, i) => {
        const x = c.x + Math.sin(this.t * c.sp + c.ph) * 0.09;
        const y = c.y + Math.cos(this.t * c.sp * 0.8 + c.ph) * 0.05;
        const z = c.z + Math.cos(this.t * c.sp * 0.6 + c.ph * 1.7) * 0.09;
        dummy.position.set(x, y, z);
        dummy.scale.setScalar(c.sz);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      });
      mesh.instanceMatrix.needsUpdate = true;
      pg.attributes.position.needsUpdate = true;
    } };
}
function v3bloom(st, S) {
  // H&E stain under brightfield: pink cytoplasm with a purple nucleus in
  // every cell; infected nuclei turn dark and dense as resistance spreads
  st.camera.position.set(0, 4.6, 2.8);
  st.camera.lookAt(0, 0, 0);
  const F = v3field(170, 2.6, 9182, 0.2);
  const N = F.pts.length;
  const g = new THREE.Group();
  const mem = new THREE.InstancedMesh(new THREE.SphereGeometry(0.095, 12, 10),
    new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0,
      transparent: true, opacity: 0.72 }), N);
  const nuc = new THREE.InstancedMesh(new THREE.SphereGeometry(0.05, 10, 8),
    new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0 }), N);
  const memH = new THREE.Color("#c9828f"), memS = new THREE.Color("#d94f34");
  const nucH = new THREE.Color("#46348a"), nucS = new THREE.Color("#7a1030");
  const dummy = new THREE.Object3D();
  F.pts.forEach((c, i) => {
    dummy.position.set(c.x, c.y, c.z);
    dummy.scale.setScalar(c.sz);
    dummy.updateMatrix();
    mem.setMatrixAt(i, dummy.matrix);
    mem.setColorAt(i, memH);
    dummy.position.set(c.x, c.y + 0.035 * c.sz, c.z);
    dummy.scale.setScalar(c.sz);
    dummy.updateMatrix();
    nuc.setMatrixAt(i, dummy.matrix);
    nuc.setColorAt(i, nucH);
  });
  mem.instanceColor.needsUpdate = true;
  nuc.instanceColor.needsUpdate = true;
  g.add(mem); g.add(nuc);
  st.scene.add(g);
  return { group: g, norotate: true, t: 0, prog: -1,
    update(w, S) {
      const fr = v3frac(S, w);
      if (Math.abs(fr - this.prog) < 0.001 && this.prog >= 0) return;
      this.prog = fr;
      F.pts.forEach((c, i) => {
        const on = c.thr < fr;
        mem.setColorAt(i, on ? memS : memH);
        nuc.setColorAt(i, on ? nucS : nucH);
      });
      mem.instanceColor.needsUpdate = true;
      nuc.instanceColor.needsUpdate = true;
    },
    tick(dt) {
      this.t += dt;
      F.pts.forEach((c, i) => {
        const x = c.x + Math.sin(this.t * c.sp + c.ph) * 0.07;
        const z = c.z + Math.cos(this.t * c.sp * 0.6 + c.ph * 1.7) * 0.07;
        dummy.position.set(x, c.y, z);
        dummy.scale.setScalar(c.sz);
        dummy.updateMatrix();
        mem.setMatrixAt(i, dummy.matrix);
        dummy.position.set(x, c.y + 0.035 * c.sz, z);
        dummy.updateMatrix();
        nuc.setMatrixAt(i, dummy.matrix);
      });
      mem.instanceMatrix.needsUpdate = true;
      nuc.instanceMatrix.needsUpdate = true;
    } };
}
function v3orbits(st, S) {
  // Chemotaxis: resistant cells migrate toward the colony core as they take
  // over — the whole field visibly pulls inward while turning red
  st.camera.position.set(0, 4.6, 2.8);
  st.camera.lookAt(0, 0, 0);
  const F = v3field(200, 2.6, 5511, 0.24);
  const N = F.pts.length;
  const g = new THREE.Group();
  const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.085, 12, 10),
    new THREE.MeshBasicMaterial({}), N);
  const healthy = new THREE.Color("#2fae62"), sick = new THREE.Color("#ff2a12");
  const dummy = new THREE.Object3D();
  F.pts.forEach((c, i) => {
    dummy.position.set(c.x, c.y, c.z);
    dummy.scale.setScalar(c.sz);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, healthy);
    c.hx = (F.rnd() - 0.5) * 0.5;
    c.hz = (F.rnd() - 0.5) * 0.4;
  });
  mesh.instanceColor.needsUpdate = true;
  g.add(mesh);
  st.scene.add(g);
  return { group: g, norotate: true, t: 0, prog: 0,
    update(w, S) {
      const fr = v3frac(S, w);
      if (Math.abs(fr - this.prog) < 0.001 && this.prog >= 0) return;
      this.prog = fr;
      F.pts.forEach((c, i) => mesh.setColorAt(i, c.thr < fr ? sick : healthy));
      mesh.instanceColor.needsUpdate = true;
    },
    tick(dt) {
      this.t += dt;
      F.pts.forEach((c, i) => {
        const m = Math.max(0, Math.min(1, (this.prog - c.thr) * 3)) * 0.85;
        const drift = 1 - m;
        dummy.position.set(
          (c.x * drift + c.hx * m) + Math.sin(this.t * c.sp + c.ph) * 0.07 * drift,
          c.y,
          (c.z * drift + c.hz * m) + Math.cos(this.t * c.sp * 0.6 + c.ph) * 0.07 * drift);
        dummy.scale.setScalar(c.sz);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    } };
}
function v3dandelion(st, S) {
  // Z-stack: three cell layers at different depths; the focal plane sweeps
  // up and down — cells in focus shine in state color, the rest sink dim blue
  st.camera.position.set(0, 4.6, 2.8);
  st.camera.lookAt(0, 0, 0);
  const F = v3field(240, 2.6, 31415, 0.24);
  const N = F.pts.length;
  F.pts.forEach((c, i) => { c.y = (i % 3 - 1) * 0.38 + c.y * 0.3; });
  const g = new THREE.Group();
  const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.075, 12, 10),
    new THREE.MeshBasicMaterial({}), N);
  const gH = new THREE.Color("#1fae5f"), rH = new THREE.Color("#ff2010");
  const dim = new THREE.Color("#274b5c");
  const dummy = new THREE.Object3D();
  const tmp = new THREE.Color();
  F.pts.forEach((c, i) => {
    dummy.position.set(c.x, c.y, c.z);
    dummy.scale.setScalar(c.sz);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, dim);
  });
  mesh.instanceColor.needsUpdate = true;
  const ring = new THREE.Mesh(new THREE.CircleGeometry(2.0, 48),
    new THREE.MeshBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.07,
      depthWrite: false, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  g.add(ring);
  g.add(mesh);
  st.scene.add(g);
  return { group: g, norotate: true, t: 0, prog: -1,
    update(w, S) {
      const fr = v3frac(S, w);
      if (Math.abs(fr - this.prog) < 0.001 && this.prog >= 0) return;
      this.prog = fr;
    },
    tick(dt) {
      this.t += dt;
      const fz = 0.55 * Math.sin(this.t * 0.45);
      ring.position.y = fz;
      F.pts.forEach((c, i) => {
        const sharp = Math.max(0, 1 - Math.abs(c.y - fz) / 0.55);
        const on = c.thr < this.prog;
        tmp.copy(dim).lerp(on ? rH : gH, sharp * sharp);
        mesh.setColorAt(i, tmp);
        dummy.position.set(
          c.x + Math.sin(this.t * c.sp + c.ph) * 0.05,
          c.y,
          c.z + Math.cos(this.t * c.sp * 0.6 + c.ph) * 0.05);
        dummy.scale.setScalar(c.sz * (0.85 + 0.3 * sharp));
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceColor.needsUpdate = true;
      mesh.instanceMatrix.needsUpdate = true;
    } };
}
function v3shader(st, S) {
  // Shader scope: the whole smear is ONE fragment shader — no meshes.
  // A jittered grid of cells with membranes and nuclei drifts on Brownian
  // motion while the resistant front burns outward from the center.
  const uniforms = { uProgress: { value: 0 }, uTime: { value: 0 } };
  const mat = new THREE.ShaderMaterial({ uniforms,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec2 vUv;
      uniform float uProgress; uniform float uTime;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        vec2 aspect = vec2(1.617, 1.0);
        vec2 g = vec2(14.0, 9.0);
        vec2 cellBase = floor(vUv * g);
        vec2 f0 = fract(vUv * g) - 0.5;
        float body = 0.0, memb = 0.0, nuc = 0.0, inf = 0.0;
        for (int j = -1; j <= 1; j++) {
          for (int i = -1; i <= 1; i++) {
            vec2 nid = cellBase + vec2(float(i), float(j));
            float h1 = hash(nid + 0.13);
            float h2 = hash(nid + 4.7);
            float h3 = hash(nid + 9.1);
            float rad = 0.20 + 0.14 * h1;
            vec2 ctr = (vec2(h1, h2) - 0.5) * 0.70
                     + 0.10 * vec2(sin(uTime * (0.35 + 0.4 * h3) + h1 * 6.283),
                                    cos(uTime * (0.30 + 0.4 * h2) + h2 * 6.283));
            float d = length(f0 - vec2(float(i), float(j)) - ctr);
            float b = 1.0 - smoothstep(rad - 0.04, rad + 0.02, d);
            if (b > body) {
              body = b;
              memb = 1.0 - smoothstep(0.015, 0.05, abs(d - rad));
              nuc = 1.0 - smoothstep(rad * 0.30, rad * 0.44, d);
              vec2 wpos = (nid + 0.5) / g;
              float cdist = length((wpos - 0.5) * aspect);
              float edge = uProgress * 0.95 + (h3 - 0.5) * 0.18;
              inf = 1.0 - smoothstep(edge - 0.02, edge + 0.02, cdist);
            }
          }
        }
        vec3 healthyBody = vec3(0.45, 0.62, 0.52);
        vec3 sickBody = vec3(0.75, 0.12, 0.08);
        vec3 healthyNuc = vec3(0.30, 0.24, 0.55);
        vec3 sickNuc = vec3(0.55, 0.05, 0.12);
        vec3 healthyMem = vec3(0.65, 0.80, 0.68);
        vec3 sickMem = vec3(1.0, 0.30, 0.12);
        vec3 base = vec3(0.012, 0.016, 0.018) + vec3(0.03) * hash(vUv * 231.7);
        vec3 col = base;
        col = mix(col, mix(healthyBody, sickBody, inf), body * 0.9);
        col = mix(col, mix(healthyNuc, sickNuc, inf), nuc * 0.95);
        col += mix(healthyMem, sickMem, inf) * memb * 0.8;
        col *= 1.0 - smoothstep(0.40, 0.50, max(abs(vUv.x - 0.5), abs(vUv.y - 0.5)));
        col *= 1.0 - 0.55 * smoothstep(0.25, 0.62, length((vUv - 0.5) * aspect));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.PlaneGeometry(7.6, 4.7), mat));
  st.scene.add(g);
  return { group: g, norotate: true, prog: 0, target: 0,
    update(w, S) { this.target = v3frac(S, w); },
    tick(dt) {
      this.prog += (this.target - this.prog) * Math.min(1, dt * 2);
      uniforms.uTime.value += dt;
      uniforms.uProgress.value = this.prog;
    } };
}
const V3_BUILDERS = { shell: v3shell, voxel: v3voxel, towers: v3towers,
                      spiral: v3spiral, vessel: v3vessel, network: v3network,
                      ember: v3ember, ripple: v3ripple, bloom: v3bloom,
                      orbits: v3orbits, dandelion: v3dandelion, shader: v3shader };

/* ------------------------------------------------------------ driver ---- */
function renderV3Panel() {
  const P = PATIENTS[PID];
  if (!P) return;
  let st = V3.st;
  if (!st) { st = buildV3(); if (!st) return; }
  v3clear(st);
  st.camera.position.set(0, 1.1, 6.2);
  st.camera.lookAt(0, 0.1, 0);
  st.rotY = 0.5; st.tilt = 0;
  const SCOPE = { ember: "dark", ripple: "dark", bloom: "light",
                  orbits: "dark", dandelion: "dark", shader: "dark" };
  const bd = SCOPE[V3.view] || null;
  const dark = bd === "dark";
  st.renderer.setClearColor(dark ? 0x04060a : 0x000000, dark ? 1 : 0);
  st.el.classList.toggle("cinema", dark);
  st.scopeEl.className = "micro" + (bd ? " on micro-" + bd : "");
  st.view = V3_BUILDERS[V3.view](st, P.sim[V3.rule]);
  st.lastW = -1;
  st.rule = V3.rule;
  renderV3Buttons();
  $("v3caption").textContent = V3_CAPTIONS[V3.view];
  v3fit();
  updateV3(0);
}
function renderV3Buttons() {
  const box = $("v3views");
  box.innerHTML = "";
  V3_VIEWS.forEach(([id, label]) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (id === V3.view) b.style.fontWeight = "700";
    b.addEventListener("click", () => { V3.view = id; renderV3Panel(); });
    box.appendChild(b);
  });
  const sel = $("v3rule");
  sel.innerHTML = "";
  [["continuous", "Drug always on"], ["standard", "Usual break plan"]].forEach(([id, label]) => {
    const o = document.createElement("option");
    o.value = id; o.textContent = label;
    if (id === V3.rule) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = () => { V3.rule = sel.value; renderV3Panel(); };
}
function updateV3(dt) {
  const st = V3.st;
  if (!st || !st.view || !PATIENTS[PID]) return;
  const S = PATIENTS[PID].sim[V3.rule];
  const w = Math.min(Math.floor(sim.week), S.psa.length - 1);
  if (w !== st.lastW || dt === 0) {
    st.view.update(w, S);
    st.lastW = w;
  }
}
function v3loop(t) {
  V3.raf = requestAnimationFrame(v3loop); // always reschedule first
  const st = V3.st;
  if (!st || !st.view) return;
  if (V3.visible && !document.hidden) {
    const dt = st._lastT === undefined ? 0 : Math.min((t - st._lastT) / 1000, 0.25);
    st._lastT = t;
    if (!st.dragging) st.rotY += dt * (st.view.spin ? 0.35 : 0.12);
    if (!st.view.norotate) {
      st.scene.rotation.y = st.rotY;
      st.scene.rotation.x = st.tilt;
    }
    updateV3(dt);
    if (st.view.tick) st.view.tick(dt);
    st.renderer.render(st.scene, st.camera);
  }
}
if ("IntersectionObserver" in window) {
  new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.target.id === "stage3d") V3.visible = e.isIntersecting;
    }
  }).observe($("stage3d"));
}
if (!V3.raf) V3.raf = requestAnimationFrame(v3loop);
