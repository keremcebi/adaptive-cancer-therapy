"""Data loading for EvoDose.

Expected CSV columns: patient_id, date, psa_ng_ml, on_treatment.
- Drops patients with fewer than 5 PSA readings on OR off treatment.
- Converts dates to weeks-since-first-reading per patient.
"""

import csv
from datetime import date

MIN_READINGS_EACH_ARM = 5


def load_patients(csv_path):
    per = {}
    with open(csv_path) as f:
        for row in csv.DictReader(f):
            pid = row["patient_id"]
            d = date.fromisoformat(row["date"])
            psa = float(row["psa_ng_ml"])
            on = int(row["on_treatment"])
            per.setdefault(pid, []).append((d, psa, on))
    patients, dropped = {}, {}
    for pid, recs in per.items():
        recs.sort(key=lambda r: r[0])
        n_on = sum(1 for _, _, on in recs if on == 1)
        n_off = sum(1 for _, _, on in recs if on == 0)
        if n_on < MIN_READINGS_EACH_ARM or n_off < MIN_READINGS_EACH_ARM:
            dropped[pid] = (n_on, n_off)
            continue
        d0 = recs[0][0]
        weeks = [(d - d0).days / 7.0 for d, _, _ in recs]
        patients[pid] = {
            "weeks": weeks,
            "psa": [psa for _, psa, _ in recs],
            "on": [on for _, _, on in recs],
            "dates": [d.isoformat() for d, _, _ in recs],
        }
    return patients, dropped
