"""EvoDose pipeline: data -> fit/validate -> baselines -> Meta Muse Agent -> web/data JSON.

Usage:
    python3 src/run_pipeline.py [--data PATH] [--iters N] [--seed S]

Outputs (consumed by the single-page UI):
    web/data/patients.json   per-patient readings, fits, predictions, sims, logs
    web/data/summary.json    cross-patient table + validation totals
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.data_loader import load_patients
from src.model import fit_patient
from src.baselines import (
    rule_continuous, rule_standard, evaluate, simulate_states, HORIZON_WEEKS,
)
from src.agent import run_agent
from src.selection import analyze_selection, benefit_metrics, extract_features


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.environ.get(
        "EVODOSE_DATA", "data/bruchovsky_psa.csv"))
    ap.add_argument("--iters", type=int, default=10)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    if not os.path.exists(args.data):
        from src.make_data import main as mk
        mk(args.data)

    patients, dropped = load_patients(args.data)
    print(f"loaded {len(patients)} patients "
          f"(dropped {len(dropped)} with <5 readings on/off: {dropped})")

    out_patients = {}
    summary_rows = []
    selection_rows = []
    log_rmses, maes = [], []
    for i, pid in enumerate(sorted(patients)):
        d = patients[pid]
        print(f"[{pid}] fitting...", flush=True)
        fit = fit_patient(d["weeks"], d["psa"], d["on"], seed=args.seed + i)
        ens, psa0, base = fit["ensemble"], fit["psa0"], fit["baseline"]

        cont = evaluate(rule_continuous(), ens, psa0, base)
        std = evaluate(rule_standard(), ens, psa0, base)
        best, log = run_agent(pid, ens, psa0, base, seed=args.seed + i,
                              base_scores={"continuous": cont, "standard": std},
                              n_iterations=args.iters)

        from src.agent import _check_src
        map_p = fit["theta_map"]
        sim_std = simulate_states(rule_standard(), map_p, psa0, base)
        sim_best = simulate_states(_check_src(best["src"]), map_p, psa0, base)
        sim_cont = simulate_states(rule_continuous(), map_p, psa0, base)

        log_rmses.append(fit["log_rmse_holdout"])
        maes.append(fit["mae_holdout"])
        out_patients[pid] = {
            "readings": {"weeks": d["weeks"], "psa": d["psa"], "on": d["on"],
                         "dates": d["dates"]},
            "n_fit": fit["n_fit"],
            "forecast": fit.get("forecast_agent"),
            "baseline": base,
            "map_params": map_p,
            "fit": {"median": fit["median_full"], "pi5": fit["pi5_full"],
                    "pi95": fit["pi95_full"], "map": fit["map_full"],
                    "schedule_weeks": fit["schedule"]},
            "validation": {"log_rmse": fit["log_rmse_holdout"],
                           "mae": fit["mae_holdout"]},
            "baselines": {"continuous": {k: v for k, v in cont.items()
                                         if k != "ttps"},
                          "standard": {k: v for k, v in std.items()
                                       if k != "ttps"}},
            "agent": {"best": {
                "name": best["name"], "src": best["src"],
                "scores": {k: v for k, v in best["scores"].items()
                           if k != "ttps"},
                "score": best["score"], "explanation": best["explanation"],
                "backend": best["backend"]},
                "log": [{**e, "scores": (None if e["scores"] is None else
                         {k: v for k, v in e["scores"].items() if k != "ttps"})}
                        for e in log]},
            "sim": {"standard": sim_std, "agent": sim_best,
                    "continuous": sim_cont, "horizon": HORIZON_WEEKS},
        }
        selection_rows.append({
            "patient": pid, "cohort": os.path.basename(args.data),
            "features": extract_features(d["weeks"], d["psa"], d["on"],
                                         fit["n_fit"], base, map_p),
            "benefits": benefit_metrics(cont, std, best["scores"]),
        })
        summary_rows.append({
            "patient": pid, "baseline": round(base, 2),
            "val_log_rmse": round(fit["log_rmse_holdout"], 3),
            "val_mae": round(fit["mae_holdout"], 3),
            "cont_med": round(cont["median_ttp"], 1),
            "std_med": round(std["median_ttp"], 1),
            "std_p10": round(std["p10_ttp"], 1),
            "std_on": round(std["pct_on_drug"], 1),
            "agent_med": round(best["scores"]["median_ttp"], 1),
            "agent_p10": round(best["scores"]["p10_ttp"], 1),
            "agent_on": round(best["scores"]["pct_on_drug"], 1),
        })
        print(f"[{pid}] val log-RMSE={fit['log_rmse_holdout']:.3f} "
              f"std med={std['median_ttp']:.0f} Meta Muse Agent med="
              f"{best['scores']['median_ttp']:.0f} ({best['name']})")

    # EvoDose Select: who should pause? Held-out selection analysis over
    # this cohort (cross-cohort headline numbers come from run_selection.py).
    selection = analyze_selection(selection_rows, seed=args.seed)
    if selection.get("available"):
        for pid, info in selection["patients"].items():
            if pid in out_patients:
                out_patients[pid]["selection"] = info
        tier_by_patient = {pid: info["tier"]
                           for pid, info in selection["patients"].items()}
        for row in summary_rows:
            row["sel_tier"] = tier_by_patient.get(row["patient"], "")

    os.makedirs("web/data", exist_ok=True)
    with open("web/data/patients.json", "w") as f:
        json.dump(out_patients, f)
    with open("web/data/summary.json", "w") as f:
        json.dump({
            "n_patients": len(out_patients),
            "dropped": dropped,
            "overall": {
                "mean_log_rmse": float(sum(log_rmses) / len(log_rmses)),
                "mean_mae": float(sum(maes) / len(maes)),
            },
            "selection": selection,
            "rows": summary_rows,
        }, f, indent=1)
    print("wrote web/data/patients.json + summary.json")


if __name__ == "__main__":
    main()
