"""Two-population competition model (Lotka-Volterra style) per patient.

Sensitive cells S, resistant cells R. Drug kills S only. PSA = S + R.

Weekly discrete dynamics:
    S' = S * exp(r_s * (1 - (S + a*R) / K) - kill * drug)
    R' = R * exp(r_r * (1 - (R + b*S) / K))
    drug in {0, 1}; K = 100 fixed; PSA units absorb the scale (c = 1).

Free parameters per patient: r_s, r_r, kill, a, b, f (initial resistant
fraction; S0 = psa0*(1-f), R0 = psa0*f). Prior constraint r_r < r_s
(resistance carries a fitness cost).

Fitting: the Forecast Agent (src/forecast_agent.py) runs a
propose -> score -> keep/reject -> revise loop over the 6 parameters,
scored on log-PSA over the first 60% of readings only. Kept proposals
form an ensemble of 200 parameter sets, which spreads especially over
the hidden f and the competition strengths a, b.
Validation: simulate the held-out 40% with the observed schedule and
report log-RMSE / MAE per patient and overall.
"""

import numpy as np

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


def fit_patient(weeks, psa, on, seed=0, **kwargs):
    """Backwards-compatible entry point: the Forecast Agent makes the
    prediction now (see src/forecast_agent.py). Extra kwargs are passed
    through to the agent (e.g. n_rounds for a quicker run)."""
    from .forecast_agent import predict_patient
    return predict_patient(weeks, psa, on, seed=seed, **kwargs)
