"""Two-population competition model (Lotka-Volterra style) per patient.

Sensitive cells S, resistant cells R. Drug kills S only. PSA = S + R.

Weekly discrete dynamics:
    S' = S * exp(r_s * (1 - (S + a*R) / K) - kill * drug)
    R' = R * exp(r_r * (1 - (R + b*S) / K))
    drug in {0, 1}; K = 100 fixed; PSA units absorb the scale (c = 1).

Free parameters per patient: r_s, r_r, kill, a, b, f (initial resistant
fraction; S0 = psa0*(1-f), R0 = psa0*f). Prior constraint r_r < r_s
(resistance carries a fitness cost).

Fitting: least squares on log-PSA over the first 60% of readings
(differential evolution), then a Metropolis random-walk ensemble of 200
parameter sets (~posterior sample), which spreads especially over the
hidden f and the competition strengths a, b.
Validation: simulate the held-out 40% with the observed schedule and
report log-RMSE / MAE per patient and overall.
"""

import numpy as np
from scipy.optimize import differential_evolution

K_CAP = 100.0
N_ENSEMBLE = 200
FIT_FRAC = 0.6
# Bounds as (lo, hi) in transformed space:
  # t = [log r_s, log r_r, log kill, log a, log b, logit f]
T_BOUNDS = [
    (np.log(0.02), np.log(0.35)),   # r_s
    (np.log(0.005), np.log(0.20)),  # r_r
    (np.log(0.05), np.log(1.20)),   # kill
    (np.log(0.20), np.log(1.50)),   # a: R crowding effect on S
    (np.log(0.20), np.log(1.50)),   # b: S competition effect on R
    (-9.0, -2.44),                  # logit f in [~1e-4, 0.08]
]

PROP_SD = np.array([0.03, 0.03, 0.04, 0.06, 0.06, 0.12])


def _to_params(t):
    r_s, r_r, kill, a, b = (float(np.exp(x)) for x in t[:5])
    f = float(1.0 / (1.0 + np.exp(-t[5])))
    return {"r_s": r_s, "r_r": r_r, "kill": kill, "a": a, "b": b, "f": f}


def _to_t(p):
    return np.array([
        np.log(p["r_s"]), np.log(p["r_r"]), np.log(p["kill"]),
        np.log(p["a"]), np.log(p["b"]),
        np.log(p["f"] / (1.0 - p["f"])),
    ])


def simulate(p, schedule, psa0, ret_states=False):
    """Weekly simulation. schedule: array-like of 0/1. Returns PSA array."""
    s = psa0 * (1.0 - p["f"])
    r = psa0 * p["f"]
    n = len(schedule)
    psa = np.empty(n)
    ss = np.empty(n) if ret_states else None
    rr = np.empty(n) if ret_states else None
    for t in range(n):
        psa[t] = s + r
        if ret_states:
            ss[t], rr[t] = s, r
        d = schedule[t]
        s = s * np.exp(p["r_s"] * (1.0 - (s + p["a"] * r) / K_CAP) - p["kill"] * d)
        r = r * np.exp(p["r_r"] * (1.0 - (r + p["b"] * s) / K_CAP))
        s = min(max(s, 1e-9), 1e6)
        r = min(max(r, 1e-9), 1e6)
    if ret_states:
        return psa, ss, rr
    return psa


def weekly_schedule(weeks, on, n_weeks):
    """Step-function weekly drug schedule from readings (carry forward)."""
    sched = np.zeros(n_weeks, dtype=int)
    idx = np.clip(np.round(np.array(weeks)).astype(int), 0, n_weeks - 1)
    w = 0
    cur = int(on[0])
    order = np.argsort(idx)
    ptr = 0
    for w in range(n_weeks):
        while ptr < len(order) and idx[order[ptr]] <= w:
            cur = int(on[order[ptr]])
            ptr += 1
        sched[w] = cur
    return sched


def _sse(t, psa_fit, idx_fit, sched, psa0):
    p = _to_params(t)
    if p["r_r"] >= p["r_s"]:
        return 1e12
    pred = simulate(p, sched, psa0)
    resid = np.log(np.maximum(pred[idx_fit], 1e-9)) - np.log(np.maximum(psa_fit, 1e-9))
    return float(np.sum(resid ** 2))


def fit_patient(weeks, psa, on, seed=0, mcmc_steps=6000):
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

    # Multi-start global fit: keep the best of two seeded searches so a
    # degenerate high-resistant-fraction solution cannot win by luck.
    best_fun, t_map = np.inf, None
    for rs in (seed, seed + 999):
        de = differential_evolution(
            _sse, T_BOUNDS, args=(psa[:n_fit], idx_fit, sched, psa0),
            maxiter=30, popsize=15, seed=rs, tol=1e-7, polish=True,
        )
        if de.fun < best_fun:
            best_fun, t_map = de.fun, de.x
    p_map = _to_params(t_map)

    # --- Metropolis ensemble (random-walk, log-PSA Gaussian likelihood) ---
    rng = np.random.default_rng(seed + 1000)
    resid = np.log(simulate(p_map, sched, psa0)[idx_fit]) - np.log(psa[:n_fit])
    sig2 = max(float(np.mean(resid ** 2)), 1e-4)

    def log_post(t):
        p = _to_params(t)
        if p["r_r"] >= p["r_s"]:
            return -np.inf
        pred = simulate(p, sched, psa0)
        r = np.log(np.maximum(pred[idx_fit], 1e-9)) - np.log(np.maximum(psa[:n_fit], 1e-9))
        return -0.5 * np.sum(r ** 2) / sig2

    cur, cur_lp = t_map.copy(), log_post(t_map)
    samples = []
    accept = 0
    for step in range(mcmc_steps):
        prop = cur + rng.normal(0, PROP_SD)
        ok = all(T_BOUNDS[i][0] <= prop[i] <= T_BOUNDS[i][1] for i in range(6))
        if ok:
            lp = log_post(prop)
            if lp > -np.inf and (lp >= cur_lp or rng.random() < np.exp(lp - cur_lp)):
                cur, cur_lp = prop, lp
                accept += 1
        if step >= mcmc_steps - 2 * N_ENSEMBLE and step % 2 == 0:
            samples.append(cur.copy())
    ensemble = [_to_params(t) for t in samples[-N_ENSEMBLE:]]
    while len(ensemble) < N_ENSEMBLE:  # safety net
        ensemble.append(p_map)
    ensemble = ensemble[:N_ENSEMBLE]

    # --- Held-out prediction with observed schedule ---
    ens_psa = np.array([simulate(p, sched, psa0) for p in ensemble])
    med = np.median(ens_psa, axis=0)
    lo = np.percentile(ens_psa, 5, axis=0)
    hi = np.percentile(ens_psa, 95, axis=0)
    map_full = simulate(p_map, sched, psa0)

    hold_pred = med[idx_hold]
    hold_true = psa[n_fit:]
    log_rmse = float(np.sqrt(np.mean((np.log(hold_pred) - np.log(hold_true)) ** 2)))
    mae = float(np.mean(np.abs(hold_pred - hold_true)))

    return {
        "theta_map": p_map,
        "ensemble": ensemble,
        "n_weeks_history": n_weeks,
        "schedule": sched.tolist(),
        "baseline": baseline,
        "psa0": psa0,
        "n_fit": n_fit,
        "map_full": map_full.tolist(),
        "median_full": med.tolist(),
        "pi5_full": lo.tolist(),
        "pi95_full": hi.tolist(),
        "log_rmse_holdout": log_rmse,
        "mae_holdout": mae,
        "mcmc_accept": accept / mcmc_steps,
    }
