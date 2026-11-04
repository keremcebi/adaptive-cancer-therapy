# EvoDose Select — who should pause?

**In-silico research tool — not medical advice.** EvoDose Select is an AI experiment on
prostate-cancer intermittent hormone therapy. Its first question was "can a personalized
pause/restart rule beat the standard rule for everyone?" On real data the average answer
is barely. So the project now asks the question the data can support:

> **Half the drug, same control — for whom? Which patients save the most drug by
> pausing, without losing time to progression, and which save so little that the
> monitoring burden is hard to justify?**

Nothing it outputs is a treatment recommendation.

## For the jury — try it in 2 minutes

**Live demo: [keremcebi.github.io/adaptive-cancer-therapy](https://keremcebi.github.io/adaptive-cancer-therapy/)**
— just open it; nothing to install. (If you prefer local: `cd web && python3 -m http.server 8000`,
then open http://localhost:8000. Do not double-click `index.html`; browsers block its data
files over `file://`. Re-running the Python pipeline below is *not* needed to use the deck —
all patient results ship precomputed.)

Click path:

1. **Move** with the ← → arrow keys (↑ ↓ also work), the dots at the top, or the ‹ › buttons.
   Nine slides: the problem, an animated year of treatment, why a break can work, how the
   agent makes its guess, the race, who saves most (two slides), what it would change,
   and the tool last. Or skip straight there with the **Try the tool** button (top-right).
2. **Slide 5 (the race):** press **Play** and watch *Drug always on* vs the *Usual plan* on the
   same cancer — green cells are the ones the drug can kill, red cells the ones it cannot.
   Try **Restart** and the **Speed** control.
3. **Slides 6–7 (who saves most):** the payoff — out of every 100 weeks, how much time off the
   drug a break buys, and the patients our model picks as the biggest savers.
4. **Slide 9 (try it, last slide):** upload your own patient's CSV
   (`patient_id, date, psa_ng_ml, on_treatment`; at least 5 readings on and 5 off the drug)
   and get a saver guess back in seconds. The fit runs entirely in the browser — nothing is
   sent anywhere. No file handy? Click **Use example patient**, or download the example CSV
   from that slide and upload it back. Every patient in the file is fitted and scored
   locally, but that alone makes no guess. Paste a Muse (Meta) API key into the
   masked field on that slide: Muse is the only source of the benefit guess — it
   reads the scored patients and returns a likelihood (0–100) per patient, best
   first, with a reason each (patients whose break loses control are excluded
   before Muse sees them). No key, or a failed call, means no guess is shown.
   The key is never stored and is only sent to Meta's API.
5. **Optional eye candy:** the living tumor as a custom shader at
   [illustrations.html](https://keremcebi.github.io/adaptive-cancer-therapy/illustrations.html)
   (toggle the drug front, drag the resistance slider).

## The honest headline numbers (105 real patients)

Two dead ends came first, and we report them because they motivate the design:

- *Beat the standard rule for everyone?* Personalized rules vs the standard rule
  (stop at 50% below baseline PSA, restart at baseline) gain **+0.4 weeks** median
  time to progression (TTP) and **1.6 points** less drug on average. Negligible.
- *Just take greedier holidays?* On single-fit probes, restarting later collapses
  control in many simulated patients, and the best no-loss greedy rule adds only
  ~2 points of saving. The standard rule is already near this model's frontier.

The large effect is pausing itself vs never stopping. Across the Bruchovsky
(72), Shaw (16 usable) and Zhang (17 usable) cohorts, a personalized pause vs
continuous treatment, simulated on each patient's 200-variant ensemble:

- **51.7 of every 100 weeks off drug** on average, at **+2.4 weeks** median TTP
  vs continuous. But the saving ranges from **8 to 99 weeks** — who you are
  matters more than the exact rule.
- EvoDose Select predicts that saving from fit-period features only (baseline
  PSA, fitted growth/kill/competition rates, resistant fraction, PSA nadir and
  rebound slope). Patient-level held-out evaluation (repeated half-splits; a
  patient is never scored by a model that saw them):
  - Top predicted quartile: **69.1 weeks off drug per 100** vs **51.7** for all
    held-out patients, still at **+0.8 weeks** TTP vs continuous.
  - **41%** of the selected quartile are "high savers" (≥70 weeks off), vs
    **18%** of all patients — a 2.3× enrichment.
  - Trained on Bruchovsky+Shaw only, the selector still ranks Zhang patients
    (correlation 0.63; top quartile 44.8 vs 34.8 weeks off) — an external-style
    check on a different drug and disease setting, not clinical evidence.
- Strongest predictors of saving: lower fitted initial resistant fraction,
  slower resistant growth, higher baseline PSA.
- Hard guard: a patient whose best rule loses median TTP vs continuous
  treatment or vs the standard rule is never labelled a pause candidate
  (1 of 105 patients).

We report this as a trial-enrichment and monitoring-prioritization hypothesis:
if pausing is offered or trialled, offer it first to predicted high savers, and
do not pretend the exact restart rule is where the value is.

Full per-patient tiers are in `web/selection.json`; the method is in
`src/selection.py`.

## How it works

1. **Loads** per-patient PSA histories with treatment on/off labels (patients with
   fewer than 5 readings on or off drug are dropped).
2. **Fits** a Lotka–Volterra competition model per patient — drug-sensitive cells (S)
   and resistant cells (R); the drug kills S only; PSA = S + R. Fit on the first 60%
   of each history, validated by predicting the held-out 40%. Uncertainty: an ensemble
   of 200 parameter sets (Metropolis sampling), widest on the hidden initial
   resistant fraction and the competition strengths.
3. **Baselines**: continuous treatment, and the standard adaptive rule (stop at 50%
   below baseline, restart at baseline).
4. **Rule search** (the engine, unchanged): a propose → score → revise loop (Muse Spark
   via the Meta Model API when `META_API_KEY` is set, otherwise a built-in evolutionary
   search) designs a personalized pause/restart rule per patient, scored across the
   200-variant ensemble (median TTP, worst-decile TTP, % time on drug; progression =
   PSA > 1.15× baseline while on drug).
5. **Selection** (the new main output): `src/selection.py` computes early-history
   features and simulated benefits per patient, fits the ridge selector for weeks
   off drug vs continuous treatment, and produces out-of-fold predictions, held-out
   enrichment estimates, and a tier per patient — *High saver / Moderate saver /
   Low saver / Not a candidate*.
6. **UI** (single page, 9 slides): a plain-language deck — the problem, an animated
   year of treatment, why a break can work, how the agent guesses, the two-plan
   race per selected patient, and the held-out "who saves most" result.

## Data

- `data/bruchovsky_psa.csv` — synthetic Bruchovsky-style surrogate (generated by
  `src/make_data.py`).
- `data/bruchovsky_real.csv` — real Bruchovsky Phase II extract: 72 patients,
  3,461 PSA readings. See `data/bruchovsky_real.SOURCES.txt`.
- `data/shaw_real.csv` — Shaw et al.: 18 patients, 665 readings (16 usable).
- `data/example_patient.csv` — one real Shaw patient (S0619, 42 readings) in the
  upload format; the same file the deck's try-it slide offers as a download
  (copy in `web/example_patient.csv`). Upload it there to see a guess end to end.
- `data/zhang_real.csv` — Zhang Moffitt adaptive-abiraterone cohort: 32 blocks,
  678 readings (17 usable; different disease setting and drug — used as an
  external-style ranking check). See `data/more_real_data.SOURCES.txt`.

## Quickstart (runs fully locally)

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt

# fit + rule search for one dataset, writes web/data/*.json
./.venv/bin/python src/run_pipeline.py --data data/bruchovsky_real.csv

# cross-cohort selection analysis from already-fitted results -> web/selection.json
./.venv/bin/python src/run_selection.py

# tests for the selection module
./.venv/bin/python -m unittest discover -s tests -v

# serve the app (from the repo root; serves the web/ folder)
cd web && python3 -m http.server 8000
```

Then open **http://localhost:8000** in a browser.

Note: `src/run_pipeline.py` always writes `web/data/`; the fitted cohorts bundled in
this repo live in `web/data/` (Shaw), `web/data_bruchovsky_real/` (Bruchovsky) and
`web/data_zhang_real/` (Zhang). `src/run_selection.py` merges saved cohorts without
re-fitting.

## Using Muse Spark (Meta Model API) for the rule search

```bash
export META_API_KEY="..."
# optional: export META_MODEL_API_URL="https://..." META_MODEL="muse-spark-1.3"
./.venv/bin/python src/run_pipeline.py --data data/bruchovsky_real.csv
```

Without the key, the pipeline runs the built-in local evolutionary proposer; the UI
labels which backend produced each patient's rule.

## Layout

- `src/make_data.py` — synthetic Bruchovsky-style surrogate generator
- `src/data_loader.py` — CSV loading + ≥5-readings-per-arm filter
- `src/model.py` — competition model (simulate, parameter bounds); fitting is delegated to the forecast agent
- `src/forecast_agent.py` — Forecast Agent: propose → score → keep/reject → revise loop that makes the prediction and its 200-member ensemble
- `src/baselines.py` — continuous + standard rules, ensemble scoring
- `src/agent.py` — propose → score → revise rule search (Meta API or local evolution)
- `src/selection.py` — EvoDose Select: features, benefits, ridge selector, held-out analysis
- `src/run_pipeline.py` — end-to-end run, writes `web/data/*.json`
- `src/run_selection.py` — cross-cohort selection from saved fits → `web/selection.json`
- `tests/test_selection.py` — focused tests for the selection module
- `web/` — single-page app (`index.html`, `styles.css`, `app.js`, `viz.js`
  gallery, `viz3d.js` 3D tumor views, `data/`, `data_bruchovsky_real/`,
  `data_zhang_real/`, `selection.json`, `vendor/three.min.js`; all local, no CDN)
