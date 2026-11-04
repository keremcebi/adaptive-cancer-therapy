"""EvoDose Select: who should pause?

The old EvoDose questions were "can a personalized rule beat the standard
rule for everyone?" (average answer: +0.3 weeks median TTP, ~1.5 points
less drug -- negligible) and "can greedier holidays save much more drug?"
(answer: no; later restarts collapse control in many simulated patients,
and the best no-loss greedy rule adds only ~2 points on a single fit).

The large effect in this system is pausing itself vs never stopping:
about half the drug exposure at no loss of time to progression (TTP) in
simulation. But that saving varies enormously by patient (roughly 10 to
99 of every 100 weeks off drug). This module asks the question that
variation supports:

    Which patients are predicted to save the most drug by pausing
    (personalized rule vs continuous treatment), without losing TTP?

Method (all in-silico, not medical advice):
- Features use only the fitting period (first 60% of each history) plus
  the fitted model parameters -- nothing from the held-out future.
- The benefit target is the simulated drug saving of the patient's best
  rule vs continuous treatment (percentage points of weeks on drug),
  with a hard guard: a patient whose best rule loses median TTP vs
  continuous treatment or vs the standard rule is never a pause
  candidate, whatever the model predicts.
- A ridge regression (numpy only) predicts the drug saving. Honest
  estimates come from patient-level held-out evaluation: out-of-fold
  predictions for every patient, plus repeated random half-splits where
  the top predicted quartile in the test half is compared with the test
  half as a whole. No patient is ever scored by a model that saw them.
"""

import math

import numpy as np

FEATURES = [
    ("log_baseline", "log baseline PSA"),
    ("log_f", "log initial resistant fraction (fitted)"),
    ("r_s", "sensitive-cell growth rate r_s (fitted)"),
    ("r_r", "resistant-cell growth rate r_r (fitted)"),
    ("kill", "drug kill rate on sensitive cells (fitted)"),
    ("a", "competition: resistant on sensitive, a (fitted)"),
    ("b", "competition: sensitive on resistant, b (fitted)"),
    ("rr_rs", "resistant/sensitive growth ratio r_r/r_s"),
    ("nadir_ratio", "deepest PSA in fit period / baseline"),
    ("off_slope", "off-drug log-PSA rebound slope in fit period"),
    ("on_frac_fit", "share of fit-period readings on drug"),
]

RIDGE_LAMBDA = 10.0
TOP_FRACTION = 0.25  # held-out evaluation selects the top predicted quartile
HIGH_SAVER_PTS = 70.0  # "high saver": >=70 of 100 weeks off drug vs continuous


def extract_features(weeks, psa, on, n_fit, baseline, map_params):
    """Early-history features. Only readings[:n_fit] are touched."""
    psa_fit = [float(v) for v in psa[:n_fit]]
    on_fit = [int(v) for v in on[:n_fit]]
    weeks_fit = [float(v) for v in weeks[:n_fit]]
    base = float(baseline) if baseline else max(psa_fit or [1.0])
    nadir_ratio = (min(psa_fit) / base) if psa_fit and base > 0 else 1.0
    off_idx = [i for i, v in enumerate(on_fit) if v == 0]
    off_slope = 0.0
    if len(off_idx) >= 2:
        i0, i1 = off_idx[0], off_idx[-1]
        dt = weeks_fit[i1] - weeks_fit[i0]
        if dt > 0:
            off_slope = (math.log(max(psa_fit[i1], 1e-6))
                         - math.log(max(psa_fit[i0], 1e-6))) / dt
    mp = map_params
    return {
        "log_baseline": math.log(max(base, 0.01)),
        "log_f": math.log(max(float(mp["f"]), 1e-9)),
        "r_s": float(mp["r_s"]),
        "r_r": float(mp["r_r"]),
        "kill": float(mp["kill"]),
        "a": float(mp["a"]),
        "b": float(mp["b"]),
        "rr_rs": float(mp["r_r"] / mp["r_s"]) if mp["r_s"] else 0.0,
        "nadir_ratio": float(nadir_ratio),
        "off_slope": float(off_slope),
        "on_frac_fit": float(np.mean(on_fit)) if on_fit else 1.0,
    }


def benefit_metrics(cont, std, agent):
    """Simulated benefit of the patient's best rule. See module docstring."""
    gain_med = float(agent["median_ttp"] - std["median_ttp"])
    gain_p10 = float(agent["p10_ttp"] - std["p10_ttp"])
    drug_save = float(std["pct_on_drug"] - agent["pct_on_drug"])
    return {
        "gain_med_vs_std": gain_med,
        "gain_p10_vs_std": gain_p10,
        "drug_save_vs_std": drug_save,
        "obj_gain_vs_std": gain_med + 0.5 * gain_p10 + 0.2 * drug_save,
        "ttp_change_vs_cont": float(agent["median_ttp"] - cont["median_ttp"]),
        "drug_save_vs_cont": float(100.0 - agent["pct_on_drug"]),
    }


def _design(rows, keys):
    return np.array([[r["features"][k] for k in keys] for r in rows],
                    dtype=float)


def _ridge_fit(X, y, lam=RIDGE_LAMBDA):
    mu, sd = X.mean(axis=0), X.std(axis=0)
    sd = np.where(sd < 1e-9, 1.0, sd)
    Xs = (X - mu) / sd
    w = np.linalg.solve(Xs.T @ Xs + lam * np.eye(X.shape[1]),
                        Xs.T @ (y - y.mean()))
    return {"mu": mu, "sd": sd, "y_mean": float(y.mean()), "w": w}


def _ridge_predict(model, X):
    return model["y_mean"] + ((X - model["mu"]) / model["sd"]) @ model["w"]


def _folds(n, n_splits, rng):
    idx = rng.permutation(n)
    return [idx[i::n_splits] for i in range(n_splits)]


def analyze_selection(rows, seed=0, n_repeats=100):
    """Held-out selection analysis over patient dicts.

    Each row: {"patient", "cohort", "features", "benefits"}.
    Returns a JSON-ready dict; per-patient tiers are keyed by patient id.
    """
    keys = [k for k, _ in FEATURES]
    n = len(rows)
    if n < 12:
        return {"available": False, "n_patients": n,
                "reason": "too few patients for held-out selection"}
    X = _design(rows, keys)
    y = np.array([r["benefits"]["drug_save_vs_cont"] for r in rows])
    rng = np.random.default_rng(seed)

    # --- out-of-fold predictions (5-fold, patient-level) -------------------
    oof = np.full(n, np.nan)
    for test in _folds(n, 5, rng):
        train = np.setdiff1d(np.arange(n), test)
        oof[test] = _ridge_predict(_ridge_fit(X[train], y[train]), X[test])

    # --- repeated half-split held-out evaluation ---------------------------
    held_keys = ("drug_save_vs_cont", "ttp_change_vs_cont",
                 "drug_save_vs_std", "gain_med_vs_std")
    held = {k: [] for k in held_keys}
    held.update({"all_" + k: [] for k in held_keys})
    held.update({"high_saver_selected": [], "high_saver_all": []})
    for _ in range(n_repeats):
        idx = rng.permutation(n)
        test, train = idx[: n // 2], idx[n // 2:]
        pred = _ridge_predict(_ridge_fit(X[train], y[train]), X[test])
        k = max(1, int(round(TOP_FRACTION * len(test))))
        sel = test[np.argsort(-pred)[:k]]
        for key in held_keys:
            held[key].append(float(np.mean(
                [rows[i]["benefits"][key] for i in sel])))
            held["all_" + key].append(float(np.mean(
                [rows[i]["benefits"][key] for i in test])))
        held["high_saver_selected"].append(float(np.mean(
            [rows[i]["benefits"]["drug_save_vs_cont"] >= HIGH_SAVER_PTS
             for i in sel])))
        held["high_saver_all"].append(float(np.mean(
            [rows[i]["benefits"]["drug_save_vs_cont"] >= HIGH_SAVER_PTS
             for i in test])))
    held_out = {}
    for key in held_keys:
        held_out[key] = {
            "selected_mean": float(np.mean(held[key])),
            "all_mean": float(np.mean(held["all_" + key])),
        }
    held_out["high_saver"] = {
        "threshold_pts": HIGH_SAVER_PTS,
        "selected_rate": float(np.mean(held["high_saver_selected"])),
        "all_rate": float(np.mean(held["high_saver_all"])),
    }

    # --- tiers from out-of-fold predictions --------------------------------
    lo, hi = np.nanpercentile(oof, [100.0 / 3, 200.0 / 3])
    patients = {}
    for i, r in enumerate(rows):
        b = r["benefits"]
        if b["ttp_change_vs_cont"] < 0 or b["gain_med_vs_std"] < 0:
            tier = "not-a-candidate"
            tier_label = "Not a pause candidate (loses TTP in simulation)"
        elif oof[i] >= hi:
            tier = "strong"
            tier_label = "High saver — strong pause candidate"
        elif oof[i] >= lo:
            tier = "moderate"
            tier_label = "Moderate saver — possible pause candidate"
        else:
            tier = "low"
            tier_label = "Low saver — pause saves little drug"
        patients[r["patient"]] = {
            "cohort": r.get("cohort", ""),
            "tier": tier,
            "tier_label": tier_label,
            "predicted_drug_save_vs_cont": float(oof[i]),
            "actual": {k: float(v) for k, v in b.items()},
        }

    # --- full-cohort model weights, for explanation ------------------------
    full = _ridge_fit(X, y)
    weights = sorted(
        ({"feature": k, "label": label, "weight": float(w)}
         for (k, label), w in zip(FEATURES, full["w"])),
        key=lambda d: -abs(d["weight"]))

    overall = {
        key: float(np.mean([r["benefits"][key] for r in rows]))
        for key in ("gain_med_vs_std", "gain_p10_vs_std", "drug_save_vs_std",
                    "obj_gain_vs_std", "ttp_change_vs_cont",
                    "drug_save_vs_cont")
    }
    overall["frac_gain_med_negative"] = float(np.mean(
        [r["benefits"]["gain_med_vs_std"] < 0 for r in rows]))
    tier_counts = {}
    for p in patients.values():
        tier_counts[p["tier"]] = tier_counts.get(p["tier"], 0) + 1

    return {
        "available": True,
        "n_patients": n,
        "target": "drug_save_vs_cont",
        "target_label": ("simulated drug saving of the personalized pause "
                         "rule vs continuous treatment (percentage points "
                         "of weeks off drug), with no median-TTP loss "
                         "vs continuous or vs the standard rule allowed"),
        "features": [{"key": k, "label": label} for k, label in FEATURES],
        "feature_weights": weights,
        "overall": overall,
        "held_out": held_out,
        "held_out_method": (
            f"{n_repeats} random half-splits; in each, a ridge model "
            f"trained on one half selects the top {int(TOP_FRACTION * 100)}% "
            "predicted patients in the other half; selected means are "
            "compared with the whole test half"),
        "tier_thresholds": {"low_below": float(lo), "strong_at_or_above": float(hi)},
        "tier_counts": tier_counts,
        "patients": patients,
    }
