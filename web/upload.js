/* EvoDose — try your own patient, entirely in the browser.
   Mirrors src/model.py (same weekly S/R dynamics, bounds and fit score)
   with a quick seeded fit instead of the offline Forecast Agent run.
   Nothing is uploaded anywhere: the file is read on this device only.
*/
"use strict";

/* ---------------- model (mirrors src/model.py) ---------------- */
const UP_K = 100.0;
const UP_BOUNDS = [
  [Math.log(0.02), Math.log(0.35)],   // r_s
  [Math.log(0.005), Math.log(0.20)],  // r_r
  [Math.log(0.05), Math.log(1.20)],   // kill
  [Math.log(0.20), Math.log(1.50)],   // a
  [Math.log(0.20), Math.log(1.50)],   // b
  [-9.0, -2.44],                      // logit f
];
const UP_PROP_SD = [0.03, 0.03, 0.04, 0.06, 0.06, 0.12];

function upParams(t) {
  return {
    r_s: Math.exp(t[0]), r_r: Math.exp(t[1]), kill: Math.exp(t[2]),
    a: Math.exp(t[3]), b: Math.exp(t[4]),
    f: 1.0 / (1.0 + Math.exp(-t[5])),
  };
}
function upSimulate(p, schedule, psa0) {
  let s = psa0 * (1.0 - p.f), r = psa0 * p.f;
  const out = new Array(schedule.length);
  for (let t = 0; t < schedule.length; t++) {
    out[t] = s + r;
    const d = schedule[t];
    s = s * Math.exp(p.r_s * (1.0 - (s + p.a * r) / UP_K) - p.kill * d);
    r = r * Math.exp(p.r_r * (1.0 - (r + p.b * s) / UP_K));
    s = Math.min(Math.max(s, 1e-9), 1e6);
    r = Math.min(Math.max(r, 1e-9), 1e6);
  }
  return out;
}
function upWeeklySchedule(weeks, on, nWeeks) {
  const sched = new Array(nWeeks).fill(on[0]);
  const idx = weeks.map((w) => Math.min(nWeeks - 1, Math.max(0, Math.round(w))));
  const order = idx.map((v, i) => i).sort((x, y) => idx[x] - idx[y]);
  let cur = on[0], ptr = 0;
  for (let w = 0; w < nWeeks; w++) {
    while (ptr < order.length && idx[order[ptr]] <= w) { cur = on[order[ptr]]; ptr++; }
    sched[w] = cur;
  }
  return { sched, idx };
}
function upRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- CSV in (mirrors src/data_loader.py) ---------------- */
function upParseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error("That file looks empty. We need a header row plus readings.");
  const head = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const col = {};
  for (const name of ["patient_id", "date", "psa_ng_ml", "on_treatment"]) {
    col[name] = head.indexOf(name);
    if (col[name] < 0) throw new Error("Missing column: " + name + ". Columns must be patient_id, date, psa_ng_ml, on_treatment.");
  }
  const groups = new Map();
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    const pid = (c[col.patient_id] || "").trim();
    const d = new Date((c[col.date] || "").trim() + "T00:00:00");
    const psa = parseFloat(c[col.psa_ng_ml]);
    const on = parseInt(c[col.on_treatment], 10);
    if (!pid || isNaN(d.getTime()) || !(psa > 0) || (on !== 0 && on !== 1)) continue;
    if (!groups.has(pid)) groups.set(pid, []);
    groups.get(pid).push({ d, psa, on });
  }
  const patients = [];
  let dropped = 0;
  for (const [pid, recs] of groups) {
    recs.sort((x, y) => x.d - y.d);
    const nOn = recs.filter((r) => r.on === 1).length;
    const nOff = recs.length - nOn;
    if (nOn < 5 || nOff < 5) { dropped++; continue; }
    const d0 = recs[0].d;
    patients.push({
      pid,
      weeks: recs.map((r) => (r.d - d0) / 86400000 / 7.0),
      psa: recs.map((r) => r.psa),
      on: recs.map((r) => r.on),
    });
  }
  if (!patients.length) {
    throw new Error("No patient in that file has at least 5 readings on the drug and 5 off it. We need both to make a guess.");
  }
  return { patients, dropped };
}

/* ---------------- quick fit (seeded search + hill climb) ---------------- */
function upHillClimb(best, bestScore, sse, rounds) {
  let step = UP_BOUNDS.map(([lo, hi]) => (hi - lo) * 0.18);
  for (let round = 0; round < rounds; round++) {
    let improved = false;
    for (let j = 0; j < 6; j++) {
      for (const dir of [1, -1]) {
        const c = best.slice();
        c[j] = Math.min(UP_BOUNDS[j][1], Math.max(UP_BOUNDS[j][0], c[j] + dir * step[j]));
        const sc = sse(c);
        if (sc < bestScore) { best = c; bestScore = sc; improved = true; }
      }
    }
    if (!improved) step = step.map((s) => s * 0.55);
  }
  return [best, bestScore];
}

function upFitCore(data) {
  const n = data.psa.length;
  const nFit = Math.max(6, Math.round(n * 0.6));
  const nWeeks = Math.round(data.weeks[n - 1]) + 1;
  if (nWeeks > 3000) throw new Error("That history is very long. Please send a shorter one.");
  const { sched, idx } = upWeeklySchedule(data.weeks, data.on, nWeeks);
  const psa0 = data.psa[0];
  const sse = (tv) => {
    const p = upParams(tv);
    if (p.r_r >= p.r_s) return 1e12;
    const pred = upSimulate(p, sched, psa0);
    let s = 0;
    for (let i = 0; i < nFit; i++) {
      const d = Math.log(Math.max(pred[idx[i]], 1e-9)) - Math.log(data.psa[i]);
      s += d * d;
    }
    return s;
  };
  let seed = 1234567;
  for (let i = 0; i < n; i++) seed = (seed * 31 + Math.round(data.psa[i] * 100)) >>> 0;
  const rnd = upRng(seed);
  const randT = () => UP_BOUNDS.map(([lo, hi]) => lo + rnd() * (hi - lo));
  let best = randT(), bestScore = sse(best);
  for (let i = 0; i < 900; i++) {
    const c = randT(), sc = sse(c);
    if (sc < bestScore) { best = c; bestScore = sc; }
  }
  [best, bestScore] = upHillClimb(best, bestScore, sse, 260);
  return { best, bestScore, sse, rnd, idx, nFit, psa0, baseline: psa0 };
}

function upFinish(data, core) {
  const pBest = upParams(core.best);
  const nWeeks = Math.round(data.weeks[data.weeks.length - 1]) + 1;
  const { sched } = upWeeklySchedule(data.weeks, data.on, nWeeks);
  const pred = upSimulate(pBest, sched, core.psa0);
  let mae = 0, nTest = 0;
  for (let i = core.nFit; i < data.psa.length; i++) {
    mae += Math.abs(pred[core.idx[i]] - data.psa[i]); nTest++;
  }
  const members = [pBest];
  let guard = 0;
  while (members.length < 40 && guard++ < 400) {
    const tv = core.best.map((v, j) => Math.min(UP_BOUNDS[j][1],
      Math.max(UP_BOUNDS[j][0], v + (core.rnd() * 2 - 1) * UP_PROP_SD[j] * 3.5)));
    const p = upParams(tv);
    if (p.r_r < p.r_s) members.push(p);
  }
  return { members, pred, idx: core.idx, nFit: core.nFit,
           mae: nTest ? mae / nTest : 0, nTest, baseline: core.baseline };
}

function upFit(data) { return upFinish(data, upFitCore(data)); }

/* ---- Muse (Meta API): the ONLY source of the benefit guess ----
   Local code fits patients and computes scores, but it never guesses
   who benefits: that likelihood comes only from Muse, reading the
   scored table. No key (or a failed call) means no guess is shown.
   Patients whose break loses control never reach Muse: a hard
   safety guard excludes them first (mirrors src/selection.py). */
async function upMuseRank(key, eligible) {
  const lines = eligible.map((r) =>
    "- " + r.pid + ": weeks off drug per 100 = " + r.weeksOff.toFixed(0) +
    ", control vs never stopping = " + (r.gain >= 0 ? "+" : "") + r.gain.toFixed(0) +
    " weeks, fit miss on unseen readings = " + r.mae.toFixed(1) + " ng/mL, " +
    r.n + " readings");
  const prompt =
    "You rank prostate-cancer patients for a drug-break study (in-silico research, " +
    "not medical advice). A computer model has already scored every patient below: " +
    "how many weeks off the drug a usual break plan buys per 100 weeks, and whether " +
    "control is kept versus never stopping. You are the only judge of benefit: " +
    "for each patient give a likelihood from 0 to 100 that they benefit from a " +
    "break, best first. Answer with a JSON array only, no other text, one item " +
    'per patient: [{"patient_id": "id", "likelihood": 0, "reason": "one short plain reason"}]\n' +
    "Patients:\n" + lines.join("\n");
  // Model ids change between API generations; on a model_not_found we
  // walk the known Muse Spark ids instead of failing the guess.
  const MODELS = ["muse-spark-1.3", "muse-spark-1.1", "muse-spark"];
  let resp = null, lastErr = "";
  for (const model of MODELS) {
    try {
      resp = await fetch("https://api.meta.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1500, temperature: 0.4, reasoning_effort: "minimal",
        }),
      });
    } catch (e) {
      throw new Error("Network error reaching api.meta.ai (offline, or the browser blocked the call).");
    }
    if (resp.ok) break;
    let code = "", msg = "";
    try {
      const err = await resp.json();
      if (err && err.error) { code = err.error.code || ""; msg = err.error.message || ""; }
    } catch (e) { /* non-JSON error body */ }
    lastErr = "Meta API said " + resp.status + ". " + code + ": " + msg;
    if (!(resp.status === 404 && /model/.test(code))) throw new Error(lastErr);
    resp = null;
  }
  if (!resp) throw new Error(lastErr + " (tried models: " + MODELS.join(", ") + ")");
  const dataJ = await resp.json();
  const choice = (dataJ && dataJ.choices && dataJ.choices[0]) || {};
  const msg = choice.message || {};
  let text = "";
  if (typeof msg.content === "string") text = msg.content;
  else if (Array.isArray(msg.content)) {
    text = msg.content.map((part) =>
      typeof part === "string" ? part : (part && (part.text || part.content)) || "").join("");
  } else if (typeof choice.text === "string") text = choice.text;
  if (!text) {
    throw new Error("Muse returned an empty answer (finish reason: " +
      (choice.finish_reason || "unknown") + ").");
  }
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return null;
  let arr;
  try { arr = JSON.parse(m[0]); } catch (e) { return null; }
  if (!Array.isArray(arr)) return null;
  const byId = new Map(eligible.map((r) => [r.pid, r]));
  const order = [];
  for (const item of arr) {
    const r = byId.get(String(item.patient_id || "").trim());
    const lik = parseFloat(item.likelihood);
    if (r && !order.includes(r)) {
      r.likelihood = isFinite(lik) ? Math.max(0, Math.min(100, lik)) : null;
      r.reason = String(item.reason || "");
      order.push(r);
    }
  }
  return order.length ? order : null;
}

/* ----- rules + scoring (mirrors src/baselines.py; horizon 260) ----- */
function upEval(members, psa0, baseline, standard) {
  const H = 260;
  const ttps = [], onFracs = [];
  for (const p of members) {
    let s = psa0 * (1 - p.f), r = psa0 * p.f, drug = 1, ttp = H;
    const psaHist = [], onHist = [];
    for (let w = 0; w < H; w++) {
      const cur = s + r;
      psaHist.push(cur); onHist.push(drug);
      if (ttp === H && drug === 1 && cur > 1.15 * baseline) ttp = w;
      if (standard) {
        const lastP = psaHist[psaHist.length - 1], lastOn = onHist[onHist.length - 1];
        if (lastOn === 1 && lastP < 0.5 * baseline) drug = 0;
        else if (lastOn === 0 && lastP >= baseline) drug = 1;
        else drug = lastOn;
      } else drug = 1;
      s = s * Math.exp(p.r_s * (1 - (s + p.a * r) / UP_K) - p.kill * drug);
      r = r * Math.exp(p.r_r * (1 - (r + p.b * s) / UP_K));
      s = Math.min(Math.max(s, 1e-9), 1e6);
      r = Math.min(Math.max(r, 1e-9), 1e6);
    }
    ttps.push(ttp);
    onFracs.push(onHist.reduce((a, b) => a + b, 0) / H);
  }
  ttps.sort((a, b) => a - b);
  return {
    medianTtp: ttps[Math.floor(ttps.length / 2)],
    weeksOffPer100: (1 - onFracs.reduce((a, b) => a + b, 0) / onFracs.length) * 100,
  };
}

/* ---------------- UI ---------------- */
function upStat(k, v) { return "<div><dt>" + k + "</dt><dd>" + v + "</dd></div>"; }

function upDrawChart(data, fit) {
  const c = document.getElementById("upChart");
  if (!c) return;
  const ctx = c.getContext("2d");
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  const padL = 44, padR = 10, padT = 14, padB = 26;
  const wMax = Math.max(...data.weeks, 1);
  const vals = data.psa.concat(fit.pred.filter((_, i) => i % 4 === 0));
  const lo = Math.log10(Math.max(0.01, Math.min(...vals) * 0.7));
  const hi = Math.log10(Math.max(...vals) * 1.3);
  const X = (w) => padL + (w / wMax) * (W - padL - padR);
  const Y = (v) => padT + (1 - (Math.log10(Math.max(v, 0.01)) - lo) / (hi - lo)) * (H - padT - padB);
  ctx.strokeStyle = "#34d3bd"; ctx.lineWidth = 2; ctx.beginPath();
  fit.pred.forEach((v, w) => { const x = X(w), y = Y(v); w ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke(); ctx.lineWidth = 1;
  data.psa.forEach((v, i) => {
    ctx.fillStyle = data.on[i] ? "#e8a33d" : "#5b9cf5";
    ctx.beginPath(); ctx.arc(X(data.weeks[i]), Y(v), 3, 0, 7); ctx.fill();
  });
  ctx.fillStyle = "#9aa39f"; ctx.font = "11px system-ui"; ctx.textAlign = "left";
  ctx.fillText("blood test over time — dots are your readings (amber on drug, blue off), teal is our fit", padL, H - 8);
}

async function upGuess(text) {
  const out = document.getElementById("upOut");
  const status = document.getElementById("upStatus");
  try {
    const parsed = upParseCsv(text);
    const keyEl = document.getElementById("upKey");
    const key = keyEl ? keyEl.value.trim() : "";
    const MAXP = 12;
    const list = parsed.patients.slice(0, MAXP);
    const rows = [];
    for (let i = 0; i < list.length; i++) {
      const data = list[i];
      status.textContent = "Fitting patient " + (i + 1) + " of " + list.length +
        " (" + data.pid + ") in your browser…";
      await new Promise((r) => setTimeout(r, 20)); // let the status paint
      const fit = upFit(data);
      const cont = upEval(fit.members, fit.baseline, fit.baseline, false);
      const std = upEval(fit.members, fit.baseline, fit.baseline, true);
      const gain = std.medianTtp - cont.medianTtp;
      const tier = gain < 0 ? "Should not take a break"
        : std.weeksOffPer100 >= 70 ? "Big saver"
        : std.weeksOffPer100 >= 30 ? "Middle saver" : "Small saver";
      rows.push({ pid: data.pid, n: data.psa.length, weeksOff: std.weeksOffPer100,
                  gain, tier, mae: fit.mae, data, fit });
    }
    // Hard guard: a break that loses control is never proposed, Muse or not.
    const eligible = rows.filter((r) => r.gain >= 0)
      .sort((a, b) => b.weeksOff - a.weeksOff);
    const excluded = rows.filter((r) => r.gain < 0);
    if (!key) {
      out.innerHTML = "<p class=\"hint\">No guess yet. Paste your Muse API key above, " +
        "then upload the file (or use the example) again. Only Muse guesses how likely " +
        "each patient is to benefit — we never guess locally.</p>";
      status.textContent = "Waiting for a Muse API key. " + rows.length +
        " patient(s) fitted and scored, but no benefit guess was made.";
      return;
    }
    if (!eligible.length) {
      out.innerHTML = "<p class=\"hint\">No patient in that file should take a break: " +
        "every break lost control in our simulation, so Muse was not asked.</p>";
      status.textContent = "Done. No benefit guess: the safety guard excluded every patient.";
      if (rows[0]) upDrawChart(rows[0].data, rows[0].fit);
      return;
    }
    status.textContent = "Asking Muse how likely each patient is to benefit…";
    let order = null, museErr = "";
    try {
      order = await upMuseRank(key, eligible);
    } catch (e) { museErr = e.message || String(e); }
    if (!order) {
      out.innerHTML = "";
      status.textContent = "No guess was made. " +
        (museErr || "Muse gave no usable answer.") + " Check the key and try again.";
      return;
    }
    const guessed = new Set(order.map((r) => r.pid));
    const unguessed = eligible.filter((r) => !guessed.has(r.pid));
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const top = order[0];
    let html = "<dl class=\"stats\">" +
      upStat("Patients scored", String(rows.length)) +
      upStat("Who would benefit most (Muse)",
        top.pid + (top.likelihood != null ? " · likelihood " + top.likelihood.toFixed(0) + " of 100" : "")) +
      upStat("Their control vs never stopping", (top.gain >= 0 ? "+" : "") + top.gain.toFixed(0) + " wks") +
      "</dl>";
    html += "<table><tr><th>#</th><th>Patient</th><th>Weeks off, of 100 (simulated)</th>" +
      "<th>Control vs never stopping (simulated)</th><th>Muse likelihood</th><th>Why Muse ranks them here</th></tr>" +
      order.map((r, i) => "<tr><td>" + (i + 1) + "</td><td>" + esc(r.pid) + "</td><td>" +
        r.weeksOff.toFixed(0) + "</td><td>" + (r.gain >= 0 ? "+" : "") + r.gain.toFixed(0) +
        " wks</td><td>" + (r.likelihood != null ? r.likelihood.toFixed(0) + " / 100" : "—") +
        "</td><td>" + esc(r.reason || "—") + "</td></tr>").join("") +
      "</table>";
    if (unguessed.length) {
      html += "<p class=\"hint\">Muse gave no guess for: " +
        unguessed.map((r) => esc(r.pid)).join(", ") + ".</p>";
    }
    if (excluded.length) {
      html += "<p class=\"hint\">Not sent to Muse (break lost control): " +
        excluded.map((r) => esc(r.pid)).join(", ") + ".</p>";
    }
    out.innerHTML = html;
    status.textContent = "Done. Muse guessed the likelihoods below from the simulated " +
      "scores (local fits, about 40 model versions each). Not medical advice." +
      (parsed.dropped ? " " + parsed.dropped + " patient(s) skipped: not enough readings on or off the drug." : "") +
      (parsed.patients.length > MAXP ? " Only the first " + MAXP + " patients were scored." : "");
    upDrawChart(top.data, top.fit);
  } catch (e) {
    out.innerHTML = "";
    status.textContent = e.message;
  }
}

(function upWire() {
  const file = document.getElementById("upFile");
  const status = document.getElementById("upStatus");
  const send = document.getElementById("upSend");
  if (!file || !status || !send) return;
  let pendingText = null; // nothing runs until Send is pressed
  function arm(text, name) {
    pendingText = text;
    send.disabled = false;
    status.textContent = name + " ready — press Send to fit and (with a key) ask Muse.";
  }
  file.addEventListener("change", () => {
    const f = file.files && file.files[0];
    if (!f) return;
    file.value = ""; // so picking the same file again refires
    f.text().then((text) => arm(text, f.name));
  });
  const ex = document.getElementById("upExample");
  if (ex) ex.addEventListener("click", () => {
    status.textContent = "Loading the example patient…";
    fetch("example_patient.csv").then((r) => {
      if (!r.ok) throw new Error("Example file not found next to this page.");
      return r.text();
    }).then((text) => arm(text, "Example patient"))
      .catch((e) => { status.textContent = e.message; });
  });
  send.addEventListener("click", async () => {
    if (pendingText == null) return;
    send.disabled = true;
    try { await upGuess(pendingText); }
    finally { send.disabled = false; }
  });
})();

