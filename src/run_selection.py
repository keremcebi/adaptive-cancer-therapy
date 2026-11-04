"""Build web/selection.json (EvoDose Select) from saved pipeline outputs.

Reads the per-patient patients.json + summary.json of each cohort that has
already been fitted, merges them, runs the held-out selection analysis in
src/selection.py, and writes the combined result for the UI.

Usage:
    ./.venv/bin/python src/run_selection.py \
        [web/data_bruchovsky_real web/data ...]
With no arguments it uses the Bruchovsky-real and Shaw (web/data) cohorts.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.selection import analyze_selection, benefit_metrics, extract_features

DEFAULT_COHORTS = [
    ("bruchovsky-real", "web/data_bruchovsky_real"),
    ("shaw", "web/data"),
    ("zhang", "web/data_zhang_real"),
]


def rows_from_cohort(name, folder):
    with open(os.path.join(folder, "patients.json")) as f:
        patients = json.load(f)
    with open(os.path.join(folder, "summary.json")) as f:
        summary = {r["patient"]: r for r in json.load(f)["rows"]}
    rows = []
    for pid, p in patients.items():
        if pid not in summary:
            continue
        r = p["readings"]
        cont = p["baselines"]["continuous"]
        std = p["baselines"]["standard"]
        agent = p["agent"]["best"]["scores"]
        rows.append({
            "patient": pid,
            "cohort": name,
            "features": extract_features(
                r["weeks"], r["psa"], r["on"], p["n_fit"], p["baseline"],
                p["map_params"]),
            "benefits": benefit_metrics(cont, std, agent),
        })
    return rows


def main():
    args = sys.argv[1:]
    cohorts = []
    if args:
        cohorts = [(os.path.basename(os.path.normpath(a)), a) for a in args]
    else:
        cohorts = DEFAULT_COHORTS
    rows, used = [], []
    for name, folder in cohorts:
        if os.path.exists(os.path.join(folder, "patients.json")):
            got = rows_from_cohort(name, folder)
            rows.extend(got)
            used.append({"cohort": name, "folder": folder, "n": len(got)})
            print(f"{name}: {len(got)} patients from {folder}")
    if not rows:
        raise SystemExit("no cohort patients.json found")
    result = analyze_selection(rows, seed=0, n_repeats=200)
    result["cohorts"] = used
    result["note"] = (
        "In-silico selection on fitted models only -- not medical advice. "
        "Benefit is the simulated drug saving of a personalized pause vs "
        "continuous treatment, with no TTP loss allowed. Zhang is a "
        "different disease setting and drug (mCRPC, abiraterone) and is "
        "reported as an external-style check, not pooled evidence of "
        "clinical benefit.")
    with open("web/selection.json", "w") as f:
        json.dump(result, f, indent=1)
    print(f"wrote web/selection.json ({result['n_patients']} patients)")
    if result["available"]:
        h = result["held_out"]
        for key, label in (("drug_save_vs_cont", "drug saving vs cont (pts)"),
                           ("ttp_change_vs_cont", "TTP change vs cont (wk)"),
                           ("drug_save_vs_std", "drug saving vs std (pts)"),
                           ("gain_med_vs_std", "median-TTP gain vs std (wk)")):
            print(f"held-out {label}: selected {h[key]['selected_mean']:.2f} "
                  f"vs all {h[key]['all_mean']:.2f}")
        hs = h["high_saver"]
        print(f"held-out high savers (>={hs['threshold_pts']:.0f} pts): "
              f"{hs['selected_rate'] * 100:.0f}% of selected vs "
              f"{hs['all_rate'] * 100:.0f}% of all")
        print("tiers:", result["tier_counts"])


if __name__ == "__main__":
    main()
