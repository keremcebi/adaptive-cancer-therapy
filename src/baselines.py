"""Baselines, rule evaluation, and scores for EvoDose.

Rule interface (shared by baselines and Meta Muse Agent-proposed rules):
    rule(psa_history, on_off_history, baseline, week) -> 1 (drug ON) or 0 (OFF)
where histories are Python lists of everything observed *before* `week`.

Scores across the patient's parameter ensemble:
- median time to progression (weeks)
- worst-decile (p10) time to progression
- mean % of weeks on drug
Progression event: PSA > 1.15 * baseline while ON drug. Simulations that
never progress within the horizon score the horizon (right-censored).
"""

import numpy as np
from .model import simulate

HORIZON_WEEKS = 260  # 5 years
PROG_FACTOR = 1.15

CONTINUOUS_SRC = '''def rule(psa_history, on_off_history, baseline, week):
    """Continuous treatment: drug always ON."""
    return 1
'''

STANDARD_SRC = '''def rule(psa_history, on_off_history, baseline, week):
    """Standard adaptive rule (Bruchovsky-style): stop when PSA falls
    50% below baseline, restart when it returns to baseline."""
    psa = psa_history[-1]
    on = on_off_history[-1] if on_off_history else 1
    if on == 1 and psa < 0.5 * baseline:
        return 0
    if on == 0 and psa >= baseline:
        return 1
    return on
'''


def _exec_rule(src):
    ns = {}
    exec(compile(src, "<rule>", "exec"), {"__builtins__": {}}, ns)
    return ns["rule"]


def rule_continuous():
    return _exec_rule(CONTINUOUS_SRC)


def rule_standard():
    return _exec_rule(STANDARD_SRC)


def evaluate(rule_fn, ensemble, psa0, baseline, horizon=HORIZON_WEEKS):
    """Run rule on every ensemble member; member's rule sees its own history."""
    ttps, on_fracs = [], []
    for p in ensemble:
        s = psa0 * (1.0 - p["f"])
        r = psa0 * p["f"]
        psa_hist, on_hist = [], []
        drug = 1
        ttp = horizon
        progressed = False
        for w in range(horizon):
            cur = s + r
            psa_hist.append(cur)
            on_hist.append(drug)
            if not progressed and drug == 1 and cur > PROG_FACTOR * baseline:
                ttp = w
                progressed = True
            try:
                drug = 1 if rule_fn(list(psa_hist), list(on_hist), baseline, w + 1) else 0
            except Exception:
                drug = on_hist[-1]
            s = s * np.exp(p["r_s"] * (1.0 - (s + p["a"] * r) / 100.0) - p["kill"] * drug)
            r = r * np.exp(p["r_r"] * (1.0 - (r + p["b"] * s) / 100.0))
        ttps.append(ttp)
        on_fracs.append(float(np.mean(on_hist)))
    ttps = np.array(ttps, dtype=float)
    return {
        "median_ttp": float(np.median(ttps)),
        "p10_ttp": float(np.percentile(ttps, 10)),
        "mean_ttp": float(np.mean(ttps)),
        "pct_on_drug": float(np.mean(on_fracs) * 100.0),
        "ttps": ttps.tolist(),
    }


def simulate_states(rule_fn, p, psa0, baseline, horizon=HORIZON_WEEKS):
    """Single-parameter-set run recording S/R/PSA/drug for the UI animation."""
    s = psa0 * (1.0 - p["f"])
    r = psa0 * p["f"]
    out = {"S": [], "R": [], "psa": [], "on": [], "progressed_week": None}
    drug = 1
    psa_hist, on_hist = [], []
    for w in range(horizon):
        cur = s + r
        psa_hist.append(cur)
        on_hist.append(drug)
        out["S"].append(float(s))
        out["R"].append(float(r))
        out["psa"].append(float(cur))
        out["on"].append(drug)
        if out["progressed_week"] is None and drug == 1 and cur > PROG_FACTOR * baseline:
            out["progressed_week"] = w
        try:
            drug = 1 if rule_fn(list(psa_hist), list(on_hist), baseline, w + 1) else 0
        except Exception:
            pass
        s = s * np.exp(p["r_s"] * (1.0 - (s + p["a"] * r) / 100.0) - p["kill"] * drug)
        r = r * np.exp(p["r_r"] * (1.0 - (r + p["b"] * s) / 100.0))
    return out
