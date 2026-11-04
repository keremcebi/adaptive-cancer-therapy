"""Focused tests for the Forecast Agent (src/forecast_agent.py).

Run: ./.venv/bin/python -m unittest discover -s tests -v
"""

import unittest

import numpy as np

from src.forecast_agent import predict_patient
from src.model import simulate, weekly_schedule

TRUE = {"r_s": 0.18, "r_r": 0.05, "kill": 0.55, "a": 0.8, "b": 0.9,
        "f": 0.01}
WEEKS = list(range(0, 200, 5))
ON = [1] * 12 + [0] * 14 + [1] * 14


def _readings():
    sched = weekly_schedule(WEEKS, ON, 200)
    psa = simulate(TRUE, sched, 40.0)
    return [float(psa[int(round(w))]) for w in WEEKS]


class TestForecastAgent(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = predict_patient(WEEKS, _readings(), ON, seed=3,
                                  n_rounds=12, ensemble_size=40)

    def test_keeps_200_style_ensemble_of_requested_size(self):
        self.assertEqual(len(self.out["ensemble"]), 40)
        self.assertEqual(
            len(self.out["median_full"]), self.out["n_weeks_history"])
        for p in self.out["ensemble"]:
            self.assertLess(p["r_r"], p["r_s"])

    def test_agent_actually_fits_the_learning_readings(self):
        # The best kept explanation must fit the synthetic truth well.
        self.assertLess(self.out["forecast_agent"]["best_fit_rmse"], 0.5)
        self.assertGreater(self.out["forecast_agent"]["n_kept"], 10)
        self.assertGreater(self.out["forecast_agent"]["n_proposals"], 50)

    def test_every_proposal_is_logged_with_a_verdict(self):
        log = self.out["agent_log"]
        self.assertEqual(len(log),
                         self.out["forecast_agent"]["n_proposals"])
        for e in log:
            self.assertIn(e["verdict"], ("kept", "rejected"))
            self.assertTrue(e["reason"])

    def test_band_brackets_the_median(self):
        med = np.array(self.out["median_full"])
        self.assertTrue(np.all(np.array(self.out["pi5_full"]) <= med))
        self.assertTrue(np.all(med <= np.array(self.out["pi95_full"])))


if __name__ == "__main__":
    unittest.main()
