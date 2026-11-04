"""Focused tests for EvoDose Select (src/selection.py).

Run: ./.venv/bin/python -m unittest discover -s tests -v
"""

import unittest

import numpy as np

from src.selection import analyze_selection, extract_features


def _patient(pid, kill, drug_save, gain_med=1.0, seed=0):
    rng = np.random.default_rng(seed)
    base_feats = {
        "log_baseline": 3.0, "log_f": -5.0, "r_s": 0.15, "r_r": 0.05,
        "kill": kill, "a": 0.8, "b": 0.8, "rr_rs": 0.3,
        "nadir_ratio": 0.01, "off_slope": 0.03, "on_frac_fit": 0.5,
    }
    # jitter every feature so the design matrix is not degenerate
    feats = {k: float(v + rng.normal(0, 0.01)) for k, v in base_feats.items()}
    return {
        "patient": pid, "cohort": "test", "features": feats,
        "benefits": {
            "gain_med_vs_std": gain_med, "gain_p10_vs_std": gain_med,
            "drug_save_vs_std": drug_save / 4.0,
            "obj_gain_vs_std": gain_med + 0.2 * drug_save,
            "ttp_change_vs_cont": gain_med, "drug_save_vs_cont": drug_save,
        },
    }


class TestExtractFeatures(unittest.TestCase):
    def test_uses_only_fit_period(self):
        weeks = list(range(0, 40, 4))
        psa = [100.0, 50.0, 10.0, 1.0, 0.5, 0.4, 0.3, 0.2, 0.1, 9999.0]
        on = [1, 1, 1, 0, 0, 0, 0, 1, 1, 1]
        mp = {"r_s": 0.2, "r_r": 0.05, "kill": 0.6, "a": 0.5, "b": 1.0,
              "f": 0.001}
        feats = extract_features(weeks, psa, on, n_fit=5, baseline=100.0,
                                 map_params=mp)
        # nadir over first 5 readings only: 0.5/100, not 0.1/100 or the spike
        self.assertAlmostEqual(feats["nadir_ratio"], 0.005)
        self.assertAlmostEqual(feats["kill"], 0.6)


class TestAnalyzeSelection(unittest.TestCase):
    def test_recovers_planted_signal_and_never_candidates_a_loser(self):
        rows = []
        for i in range(40):
            kill = 0.2 + 0.04 * (i % 20)
            save = 60.0 * kill  # planted: high kill -> high drug saving
            rows.append(_patient(f"P{i:02d}", kill, save, seed=i))
        # one patient whose best rule loses TTP: must never be a candidate
        rows.append(_patient("LOSER", 1.2, 70.0, gain_med=-5.0, seed=99))
        out = analyze_selection(rows, seed=3, n_repeats=20)
        self.assertTrue(out["available"])
        self.assertEqual(out["target"], "drug_save_vs_cont")
        self.assertEqual(out["patients"]["LOSER"]["tier"], "not-a-candidate")
        held = out["held_out"]["drug_save_vs_cont"]
        self.assertGreater(held["selected_mean"], held["all_mean"])
        self.assertEqual(sum(out["tier_counts"].values()), len(rows))

    def test_too_few_patients(self):
        out = analyze_selection([_patient("P0", 0.5, 1.0)], seed=0)
        self.assertFalse(out["available"])


if __name__ == "__main__":
    unittest.main()
