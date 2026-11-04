"""Forecast Agent: an agent makes the PSA prediction.

Same propose -> score -> keep/reject -> revise loop as the dosing-rule
agent in src/agent.py, but the proposals are explanations of one patient:
a set of the model's 6 knobs (r_s, r_r, kill, a, b, and the hidden starting
resistant fraction f). Each proposal is simulated week by week and scored
ONLY on the learning readings (the first 60%) — the held-out readings are
never shown to the proposer or the scorer, so the check on the next slide
stays honest.

Backend: Muse Spark via the Meta Model API when META_API_KEY is set asks
for one parameter set as JSON. Otherwise a local proposer runs the same
loop (refine the best, vary kept explanations, cross two of them over,
or explore a fresh one). Both backends append to the same log.

The prediction is not one proposal: every explanation that fits the
learning readings well enough is kept, until 200 are collected. Running
all 200 forward gives the guess (the middle run) and the plausible range
(the 5-95% spread) — the spread is the agent's honesty about the hidden
red cells it cannot see.
"""

import json
import os
import re
import urllib.request

import numpy as np

from .model import (
    FIT_FRAC, N_ENSEMBLE, PROP_SD, T_BOUNDS,
    _to_params, _to_t, simulate, weekly_schedule,
)

# A kept explanation may be worse than the best by this much log-RMSE per
# reading and still count as plausible (about a 1.4x typical miss ratio).
POOL_TOL = 0.35

PARAM_RANGES = {
    "r_s": (0.02, 0.35), "r_r": (0.005, 0.20), "kill": (0.05, 1.20),
    "a": (0.20, 1.50), "b": (0.20, 1.50), "f": (0.00012, 0.08),
}


# ---------------------------------------------------------------- Meta API --
def _meta_propose_params(prompt, timeout_s=60):
    """Ask Muse Spark for one parameter set. Returns a t vector or None."""
    api_key = os.environ.get("META_API_KEY")
    if not api_key:
        return None
    url = os.environ.get(
        "META_MODEL_API_URL", "https://api.meta.ai/v1/chat/completions")
    model = os.environ.get("META_MODEL", "muse-spark-1.3")
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 600,
        "temperature": 0.8,
        "reasoning_effort": "minimal",
    }).encode()
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {api_key}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            data = json.loads(resp.read().decode())
        content = data["choices"][0]["message"]["content"]
        if isinstance(content, list):
            text = "".join(
                p.get("text", "") if isinstance(p, dict) else str(p)
                for p in content)
        else:
            text = content or ""
    except Exception:
        return None
    m = re.search(r"\{.*?\}", text, re.S)
    if not m:
        return None
    try:
        raw = json.loads(m.group(0))
        p = {k: float(np.clip(float(raw[k]), *PARAM_RANGES[k]))
             for k in PARAM_RANGES}
    except Exception:
        return None
    if p["r_r"] >= p["r_s"]:
        return None
    return _to_t(p)


META_PROMPT = """You explain one prostate-cancer patient's blood-test (PSA)
history with a two-population model (in-silico research, not medical advice).
Green cells die on the drug, red cells do not, they crowd each other, and
the blood test only shows green + red. Propose ONE new set of the 6 knobs
as JSON only, no other text:
{{"r_s": green growth, "r_r": red growth (must be below r_s),
"kill": drug kill on green, "a": red crowding green, "b": green crowding
red, "f": hidden red share at the start (0.00012 to 0.08)}}

Best explanation so far (fit error on the learning readings, lower is
better): {best}
Recent proposals:
{history}
Prefer a genuinely different explanation over tiny tweaks, especially a
different hidden red share f.
"""


# ------------------------------------------------------------- local agent --
def _random_t(rng):
    for _ in range(100):
        t = np.array([rng.uniform(lo, hi) for lo, hi in T_BOUNDS])
        p = _to_params(t)
        if p["r_r"] < p["r_s"]:
            return t
    return None


def predict_patient(weeks, psa, on, seed=0, n_rounds=80,
                    candidates_per_round=8, ensemble_size=N_ENSEMBLE):
    """Run the Forecast Agent. Returns the same dict as model.fit_patient,
    plus a 'forecast_agent' summary and the full proposal 'agent_log'."""
    weeks = np.array(weeks, dtype=float)
    psa = np.array(psa, dtype=float)
    n = len(psa)
    n_fit = max(6, int(round(n * FIT_FRAC)))
    n_weeks = int(round(weeks[-1])) + 1
    sched = weekly_schedule(weeks, on, n_weeks)
    idx = np.clip(np.round(weeks).astype(int), 0, n_weeks - 1)
    idx_fit, idx_hold = idx[:n_fit], idx[n_fit:]
    psa0 = float(psa[0])
    baseline = float(np.max(psa[:2]))
    rng = np.random.default_rng(seed + 4242)
    backend = "meta-api" if os.environ.get("META_API_KEY") else "local-agent"

    def fit_rmse(t):
        """Score on the learning readings ONLY. Held-out data is invisible."""
        if t is None:
            return np.inf
        if not all(T_BOUNDS[i][0] <= t[i] <= T_BOUNDS[i][1]
                   for i in range(6)):
            return np.inf
        p = _to_params(t)
        if p["r_r"] >= p["r_s"]:
            return np.inf
        pred = simulate(p, sched, psa0)
        resid = (np.log(np.maximum(pred[idx_fit], 1e-9))
                 - np.log(np.maximum(psa[:n_fit], 1e-9)))
        return float(np.sqrt(np.mean(resid ** 2)))

    log = []
    pool = []  # (rmse, t) of kept explanations
    best_t, best_rmse = None, np.inf
    history_txt = ""

    def consider(t, name, rnd):
        nonlocal best_t, best_rmse, history_txt
        rmse = fit_rmse(t)
        if not np.isfinite(rmse):
            log.append({"round": rnd, "name": name, "verdict": "rejected",
                        "fit_rmse": None,
                        "reason": "Rejected: outside the allowed ranges, "
                                  "or red cells growing as fast as green."})
            return
        is_best = rmse < best_rmse
        if is_best:
            best_t, best_rmse = t.copy(), rmse
        kept = rmse <= best_rmse + POOL_TOL
        if kept:
            pool.append((rmse, t.copy()))
        p = _to_params(t)
        log.append({
            "round": rnd, "name": name,
            "params": {k: round(float(v), 5) for k, v in p.items()},
            "fit_rmse": round(rmse, 4),
            "verdict": "kept" if kept else "rejected",
            "reason": (f"New best: fit error {rmse:.3f} on the learning "
                       f"readings." if is_best else
                       f"Kept as a plausible explanation: fit error "
                       f"{rmse:.3f} (best {best_rmse:.3f})." if kept else
                       f"Rejected: fit error {rmse:.3f} is too far above "
                       f"the best {best_rmse:.3f}."),
        })
        history_txt += (f"\n- {name}: fit error {rmse:.3f}, "
                        f"hidden red share {p['f']:.4f} -> "
                        f"{'kept' if kept else 'rejected'}.")

    def propose_local(rnd):
        r = rng.random()
        if best_t is not None and r < 0.45:
            return best_t + rng.normal(0, PROP_SD * 0.7), "agent-refine-best"
        if len(pool) >= 2 and r < 0.65:
            i, j = rng.integers(0, len(pool), 2)
            mid = 0.5 * (pool[i][1] + pool[j][1])
            return mid + rng.normal(0, PROP_SD * 0.5), "agent-crossover"
        if pool and r < 0.9:
            t = pool[int(rng.integers(len(pool)))][1]
            return t + rng.normal(0, PROP_SD * 1.2), "agent-vary-kept"
        return _random_t(rng), "agent-explore"

    # Opening move: a diverse first explanation so the loop has a best.
    consider(_random_t(rng), "agent-explore", 0)

    for rnd in range(1, n_rounds + 1):
        cands = []
        if backend == "meta-api":
            prompt = META_PROMPT.format(
                best="(none yet)" if best_t is None else
                f"{_to_params(best_t)} at fit error {best_rmse:.3f}",
                history=history_txt[-1500:] or "(none yet)")
            try:
                t_meta = _meta_propose_params(prompt)
                if t_meta is not None:
                    cands.append((t_meta, "meta-llm"))
            except Exception:
                pass
        while len(cands) < candidates_per_round:
            cands.append(propose_local(rnd))
        if backend == "meta-api" and not any(
                nm == "meta-llm" for _, nm in cands):
            backend = "meta-api+local-fallback"
        for t, name in cands:
            consider(t, name, rnd)

    # Top up the ensemble: keep proposing around kept explanations until
    # 200 plausible ones are collected (every top-up is logged too).
    attempts = 0
    good = sorted([e for e in pool if e[0] <= best_rmse + POOL_TOL],
                  key=lambda e: e[0])
    while len(good) < ensemble_size and attempts < ensemble_size * 12:
        attempts += 1
        t = pool[int(rng.integers(len(pool)))][1]
        consider(t + rng.normal(0, PROP_SD), "agent-vary-kept",
                 n_rounds + 1)
        good = sorted([e for e in pool if e[0] <= best_rmse + POOL_TOL],
                      key=lambda e: e[0])
    if len(good) > ensemble_size:
        # Best half outright, the rest spread across the kept range so the
        # ensemble keeps its diversity (above all in the hidden red share).
        half = ensemble_size // 2
        rest = good[half:]
        step = max(1, len(rest) // max(1, ensemble_size - half))
        good = good[:half] + rest[::step][:ensemble_size - half]
    ensemble = [_to_params(t) for _, t in good[:ensemble_size]]
    while len(ensemble) < ensemble_size:  # safety net, mirrors model.py
        ensemble.append(_to_params(best_t))
    p_map = _to_params(best_t)

    # --- Held-out prediction: only now are the test readings touched, ---
    # --- and only to grade the finished prediction, never to revise it. -
    ens_psa = np.array([simulate(p, sched, psa0) for p in ensemble])
    med = np.median(ens_psa, axis=0)
    lo = np.percentile(ens_psa, 5, axis=0)
    hi = np.percentile(ens_psa, 95, axis=0)
    hold_pred = med[idx_hold]
    hold_true = psa[n_fit:]
    log_rmse = float(np.sqrt(np.mean(
        (np.log(hold_pred) - np.log(hold_true)) ** 2)))
    mae = float(np.mean(np.abs(hold_pred - hold_true)))
    kept_n = sum(1 for e in log if e["verdict"] == "kept")

    return {
        "theta_map": p_map,
        "ensemble": ensemble,
        "n_weeks_history": n_weeks,
        "schedule": sched.tolist(),
        "baseline": baseline,
        "psa0": psa0,
        "n_fit": n_fit,
        "map_full": simulate(p_map, sched, psa0).tolist(),
        "median_full": med.tolist(),
        "pi5_full": lo.tolist(),
        "pi95_full": hi.tolist(),
        "log_rmse_holdout": log_rmse,
        "mae_holdout": mae,
        "forecast_agent": {
            "backend": backend,
            "n_proposals": len(log),
            "n_kept": kept_n,
            "best_fit_rmse": round(float(best_rmse), 4),
            "rounds": n_rounds,
        },
        "agent_log": log,
    }
