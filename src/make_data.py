"""Synthetic Bruchovsky-style Phase II intermittent hormone therapy dataset.

The task references a file at [PATH_TO_DATA] (Bruchovsky Phase II PSA data),
which was not provided as a concrete path. This module generates a synthetic
surrogate with the same shape the loader expects:

    patient_id, date, psa_ng_ml, on_treatment

so the full pipeline (fit -> validate -> baselines -> Meta Muse Agent -> UI) runs
end-to-end locally. To use the real trial data, replace
`data/bruchovsky_psa.csv` with a CSV using the same columns and re-run
`python3 src/run_pipeline.py`. See README for details.

The generator mimics the real trial design: patients start ON treatment,
stop when PSA falls 50% below baseline, restart at baseline (Bruchovsky
et al., intermittent androgen suppression). PSA dynamics come from the same
two-population competition model used for fitting (src/model.py), with
lognormal measurement noise and monthly readings.
"""

import os
import numpy as np

N_PATIENTS = 12
SEED = 7
START_DATE = np.datetime64("2001-03-01")
READING_EVERY_WEEKS = 4
HORIZON_WEEKS = 220
NOISE_SD_LOG = 0.08

# Diverse "true" tumor parameters per patient:
# (r_s, r_r, kill, a_competition, b_competition, f_resistant_0, baseline_psa)
# Rates are weekly. Monthly PSA readings resolve these on/off cycles;
# much faster cyclers would alias between readings. r_r < r_s always:
# resistance carries a fitness cost, so holidays let S re-compete.
PATIENT_TRUTHS = [
    (0.20, 0.060, 0.55, 0.9, 1.1, 0.002, 12.0),
    (0.16, 0.080, 0.45, 0.7, 0.9, 0.010, 22.0),
    (0.24, 0.050, 0.70, 1.1, 1.3, 0.001, 8.0),
    (0.14, 0.090, 0.40, 0.6, 0.7, 0.020, 30.0),
    (0.22, 0.070, 0.60, 1.0, 1.0, 0.005, 15.0),
    (0.18, 0.100, 0.50, 0.8, 0.6, 0.030, 25.0),
    (0.15, 0.040, 0.40, 1.0, 1.1, 0.006, 9.0),
    (0.15, 0.070, 0.42, 0.7, 1.0, 0.015, 18.0),
    (0.21, 0.110, 0.52, 0.9, 0.8, 0.008, 20.0),
    (0.17, 0.050, 0.48, 1.0, 1.2, 0.004, 10.0),
    (0.23, 0.090, 0.65, 0.8, 0.9, 0.012, 28.0),
    (0.19, 0.080, 0.58, 1.1, 1.1, 0.006, 14.0),
]

K_CAP = 100.0


def simulate_truth(p, schedule):
    r_s, r_r, kill, a, b, f0, psa0 = p
    s = psa0 * (1.0 - f0)
    r = psa0 * f0
    psa = []
    for d in schedule:
        psa.append(s + r)
        s = s * np.exp(r_s * (1.0 - (s + a * r) / K_CAP) - kill * d)
        r = r * np.exp(r_r * (1.0 - (r + b * s) / K_CAP))
    return np.array(psa)


def main(out_path="data/bruchovsky_psa.csv"):
    rng = np.random.default_rng(SEED)
    rows = ["patient_id,date,psa_ng_ml,on_treatment"]
    for i, p in enumerate(PATIENT_TRUTHS):
        pid = f"P{i + 1:02d}"
        _, _, _, _, _, _, psa0 = p
        baseline = psa0
        on_drug = True
        schedule = []
        # Build the intermittent schedule week by week, reacting to true PSA
        # (this mirrors the trial protocol that generated the real data).
        s = psa0 * (1.0 - p[5])
        r = psa0 * p[5]
        true_psa, sched = [], []
        for _ in range(HORIZON_WEEKS):
            cur = s + r
            true_psa.append(cur)
            sched.append(1 if on_drug else 0)
            if on_drug and cur < 0.5 * baseline:
                on_drug = False
            elif not on_drug and cur >= baseline:
                on_drug = True
            s = s * np.exp(p[0] * (1.0 - (s + p[3] * r) / K_CAP) - p[2] * sched[-1])
            r = r * np.exp(p[1] * (1.0 - (r + p[4] * s) / K_CAP))
        true_psa = np.array(true_psa)
        # Monthly readings with lognormal noise
        for w in range(0, HORIZON_WEEKS, READING_EVERY_WEEKS):
            noisy = float(true_psa[w] * np.exp(rng.normal(0, NOISE_SD_LOG)))
            noisy = max(noisy, 0.05)
            date = START_DATE + np.timedelta64(w * 7, "D")
            rows.append(f"{pid},{date},{noisy:.3f},{sched[w]}")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        f.write("\n".join(rows) + "\n")
    print(f"wrote {out_path} ({len(rows) - 1} readings)")


if __name__ == "__main__":
    main()
