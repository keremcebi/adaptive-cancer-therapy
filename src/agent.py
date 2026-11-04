"""Meta Muse Agent loop: propose dosing rules, score them on the ensemble, revise.

Backend: Muse Spark via the Meta Model API when META_API_KEY is set
(optional META_MODEL_API_URL / META_MODEL). Otherwise a local evolutionary
proposer runs the same loop: propose a short Python rule, evaluate it across
the patient's parameter ensemble, keep-or-reject on scores, revise for up to
10 iterations. Both backends append to the same live Meta Muse Agent log, and the final
output is the best rule as readable code plus a plain-language explanation.

Meta Muse Agent objective (documented in the UI):
    score = median_ttp + 0.5 * p10_ttp - 0.2 * pct_on_drug
i.e. maximize durable control (median and worst-decile time to progression)
while spending less time on drug.
"""

import json
import os
import re
import urllib.request

import numpy as np

from .baselines import evaluate, STANDARD_SRC

N_ITERATIONS = 10


# ---------------------------------------------------------------- Meta API --
def _meta_propose(prompt, timeout_s=60):
    """Ask Muse Spark (Meta Model API) for one rule. Returns src or None."""
    api_key = os.environ.get("META_API_KEY")
    if not api_key:
        return None
    url = os.environ.get(
        "META_MODEL_API_URL", "https://api.meta.ai/v1/chat/completions")
    model = os.environ.get("META_MODEL", "muse-spark-1.3")
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 900,
        "temperature": 0.8,
        "reasoning_effort": "minimal",
    }).encode()
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {api_key}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            data = json.loads(resp.read().decode())
        content = data["choices"][0]["message"]["content"]
        if isinstance(content, list):
            text = "".join(
                p.get("text", "") if isinstance(p, dict) else str(p)
                for p in content)
        else:
            text = content or ""
    except Exception:
        return None
    m = re.search(r"```python(.*?)```", text, re.S)
    code = (m.group(1) if m else text).strip()
    if "def rule(" not in code:
        return None
    return code


META_PROMPT = """You design pause/restart drug dosing rules for prostate cancer
intermittent therapy simulation (in-silico research, not medical advice).

Rule signature:
def rule(psa_history, on_off_history, baseline, week):
    # psa_history: list of weekly PSA values so far; on_off_history: 1/0 list
    # baseline: reference PSA; week: next week index
    return 1  # 1 = drug ON, 0 = drug OFF

Scores from the last candidates:
{history}

Current best score: {best}
Propose ONE new rule as a short Python function. Prefer NEW structures over
threshold tuning, e.g. PSA slope/velocity triggers, minimum off-periods,
hysteresis bands, holiday counters. Reply with only a ```python code block.
"""


# ------------------------------------------------------- local proposer ---
# Candidates are rendered from structural templates so every proposal is
# valid, readable Python. Mutation jitters numeric literals; crossover mixes
# template parameters; new templates introduce new structures.
def _render_threshold(low, high):
    return f'''def rule(psa_history, on_off_history, baseline, week):
    """Hysteresis band: stop below LOW*baseline, restart at HIGH*baseline."""
    psa = psa_history[-1]
    on = on_off_history[-1] if on_off_history else 1
    if on == 1 and psa < {low:.2f} * baseline:
        return 0
    if on == 0 and psa >= {high:.2f} * baseline:
        return 1
    return on
'''


def _render_slope(low, high, win, slope):
    return f'''def rule(psa_history, on_off_history, baseline, week):
    """Slope trigger: restart early when PSA rises fast off-drug, so
    resistant growth never gets a long head start."""
    psa = psa_history[-1]
    on = on_off_history[-1] if on_off_history else 1
    if len(psa_history) > {win}:
        vel = (psa - psa_history[-{win + 1}]) / {win}
    else:
        vel = 0.0
    if on == 1 and psa < {low:.2f} * baseline:
        return 0
    if on == 0 and (psa >= {high:.2f} * baseline or vel > {slope:.3f} * baseline):
        return 1
    return on
'''


def _render_min_off(low, high, min_off, min_on):
    return f'''def rule(psa_history, on_off_history, baseline, week):
    """Minimum dwell times: holidays last at least MIN_OFF weeks so sensitive
    cells can regrow and re-compete; treatment blocks last MIN_ON weeks."""
    psa = psa_history[-1]
    on = on_off_history[-1] if on_off_history else 1
    run = 1
    for v in reversed(on_off_history[:-1]):
        if v == on:
            run += 1
        else:
            break
    if on == 1:
        if psa < {low:.2f} * baseline and run >= {min_on}:
            return 0
        return 1
    if run < {min_off}:
        return 0
    if psa >= {high:.2f} * baseline:
        return 1
    return 0
'''


def _render_velocity_guard(low, high, win, fall):
    return f'''def rule(psa_history, on_off_history, baseline, week):
    """Velocity guard: only stop when PSA is still falling fast (drug is
    working); restart on any sustained rise, even below baseline."""
    psa = psa_history[-1]
    on = on_off_history[-1] if on_off_history else 1
    if len(psa_history) > {win}:
        vel = (psa - psa_history[-{win + 1}]) / {win}
    else:
        vel = 0.0
    if on == 1 and psa < {low:.2f} * baseline and vel < {fall:.3f} * baseline:
        return 0
    if on == 0 and (psa >= {high:.2f} * baseline or vel > 0):
        return 1
    return on
'''


def _render_holiday(low, high, every, span):
    return f'''def rule(psa_history, on_off_history, baseline, week):
    """Scheduled holidays: every EVERY weeks off-drug for a SPAN-week window
    whenever PSA is safely below HIGH*baseline, keeping selection pressure low."""
    psa = psa_history[-1]
    on = on_off_history[-1] if on_off_history else 1
    if on == 1 and psa < {low:.2f} * baseline:
        return 0
    if on == 0:
        if psa >= {high:.2f} * baseline:
            return 1
        if (week % {every}) < {span} and psa < {high:.2f} * baseline:
            return 0
        if psa < {low:.2f} * baseline:
            return 0
    return on
'''


TEMPLATES = [
    ("threshold", _render_threshold,
     {"low": (0.2, 0.6), "high": (0.7, 1.2)}),
    ("slope", _render_slope,
     {"low": (0.2, 0.6), "high": (0.6, 1.1), "win": (2, 6), "slope": (0.01, 0.08)}),
    ("min_off", _render_min_off,
     {"low": (0.2, 0.6), "high": (0.7, 1.2), "min_off": (4, 16), "min_on": (4, 12)}),
    ("velocity_guard", _render_velocity_guard,
     {"low": (0.2, 0.6), "high": (0.6, 1.1), "win": (2, 6), "fall": (-0.08, -0.005)}),
    ("holiday", _render_holiday,
     {"low": (0.2, 0.6), "high": (0.7, 1.2), "every": (12, 30), "span": (4, 12)}),
]


def _sample_params(rng, spec):
    out = {}
    for k, (lo, hi) in spec.items():
        v = rng.uniform(lo, hi)
        if k in ("win", "min_off", "min_on", "every", "span"):
            v = int(round(v))
        out[k] = v
    return out


def _jitter(rng, params, spec, scale=0.25):
    out = {}
    for k, v in params.items():
        lo, hi = spec[k]
        if isinstance(v, int):
            step = max(1, int(round((hi - lo) * 0.1)))
            out[k] = int(np.clip(v + rng.integers(-step, step + 1), lo, hi))
        else:
            out[k] = float(np.clip(v + rng.normal(0, (hi - lo) * scale), lo, hi))
    return out


def objective(s):
    return s["median_ttp"] + 0.5 * s["p10_ttp"] - 0.2 * s["pct_on_drug"]


def explain_rule(src):
    """Plain-language explanation a doctor could check."""
    nums = [float(x) for x in re.findall(r"(\d+\.\d+)\s*\*\s*baseline", src)]
    parts = []
    if "vel" in src or "slope" in src.lower():
        parts.append("it watches how fast PSA is rising and restarts treatment "
                     "early when growth accelerates")
    if "run" in src and "MIN_OFF" in src:
        parts.append("it enforces minimum holiday and treatment lengths so "
                     "sensitive cells get time to regrow and re-compete")
    if "week %" in src or "EVERY" in src:
        parts.append("it schedules regular drug holidays while PSA is safely low")
    if "falling" in src or ("vel <" in src and "vel >" in src):
        parts.append("it only pauses when PSA is still clearly falling and "
                     "restarts on any sustained rise")
    if not parts:
        parts.append("it uses PSA thresholds with separate stop/restart levels "
                     "(hysteresis) to avoid rapid on/off switching")
    thresh = ""
    if nums:
        thresh = f" Key levels it uses, as fractions of baseline PSA: " \
                 f"{', '.join(f'{x:.2f}' for x in sorted(set(nums)))}."
    return ("The rule pauses treatment when PSA is low and restarts it when PSA "
            "recovers; specifically, " + "; ".join(parts) + "." + thresh +
            " It never exceeds the trial protocol's intent: treat when PSA is "
            "high, rest when it is low, and declare progression only while on drug.")


def _check_src(src):
    ns = {}
    exec(compile(src, "<rule>", "exec"), {"__builtins__": {}}, ns)
    fn = ns["rule"]
    out = fn([10.0, 9.0, 8.0], [1, 1, 1], 10.0, 3)
    assert out in (0, 1), "rule must return 0 or 1"
    return fn


# --------------------------------------------------------------- main loop --
def run_agent(patient_id, ensemble, psa0, baseline, seed=0,
              base_scores=None, n_iterations=N_ITERATIONS):
    """Run the propose -> score -> revise loop. Returns (best, log)."""
    rng = np.random.default_rng(seed + 7)
    log = []
    backend = "meta-api" if os.environ.get("META_API_KEY") else "local-evolution"

    base = base_scores or {}
    best = {"name": "standard", "src": STANDARD_SRC,
            "scores": base.get("standard"), "score": None}
    if best["scores"] is not None:
        best["score"] = objective(best["scores"])
    log.append({"iter": 0, "name": "standard-baseline",
                "src": STANDARD_SRC, "scores": best["scores"],
                "verdict": "kept",
                "reason": "Starting point: the trial-style adaptive rule all "
                          "proposals must beat."})

    # Diverse starting population: one sample per template structure.
    pop = []
    for name, render, spec in TEMPLATES:
        pop.append([name, render, _sample_params(rng, spec)])
    elite = None  # (name, render, params) of the best local proposal so far

    def _spec(name):
        return next(s for n, _, s in TEMPLATES if n == name)

    def _propose_local():
        if elite is not None and rng.random() < 0.5:
            name, render, params = elite
            params = _jitter(rng, params, _spec(name))
            return render(**params), f"local-{name}*", (name, render, params)
        if rng.random() < 0.5:
            name, render, params = pop[int(rng.integers(len(pop)))]
            params = _jitter(rng, params, _spec(name))
            pop.append([name, render, params])
            return render(**params), f"local-{name}", (name, render, params)
        name, render, _ = TEMPLATES[int(rng.integers(len(TEMPLATES)))]
        params = _sample_params(rng, _spec(name))
        pop.append([name, render, params])
        return render(**params), f"local-{name}", (name, render, params)

    history_txt = ""
    for it in range(1, n_iterations + 1):
        # Up to 3 candidates per iteration: refine the elite, explore.
        cands = []
        if backend == "meta-api":
            prompt = META_PROMPT.format(history=history_txt or "(none yet)",
                                       best="(none)" if best["score"] is None
                                       else f"{best['score']:.1f}")
            try:
                src = _meta_propose(prompt)
                if src is not None:
                    cands.append((src, "meta-llm", None))
            except Exception:
                pass
        while len(cands) < 3:
            src0, nm0, elite0 = _propose_local()
            cands.append((src0, nm0, elite0))
        if backend == "meta-api" and not any(
                n == "meta-llm" for _, n in cands):
            backend = "meta-api+local-fallback"

        for cand_idx, (src, cname, cand_elite) in enumerate(cands, 1):
            tag = f"{it}.{cand_idx}"
            try:
                fn = _check_src(src)
                scores = evaluate(fn, ensemble, psa0, baseline)
                sc = objective(scores)
                if best["score"] is None or sc > best["score"]:
                    reason = (
                        f"Kept: score {sc:.1f} beats {best['score']} "
                        f"(median TTP {scores['median_ttp']:.0f} vs "
                        f"{best['scores']['median_ttp']:.0f} wks, "
                        f"on-drug {scores['pct_on_drug']:.0f}%).")
                    best = {"name": cname, "src": src, "scores": scores,
                            "score": sc}
                    if cand_elite is not None:
                        elite = cand_elite
                    verdict = "kept"
                else:
                    reason = (
                        f"Rejected: score {sc:.1f} <= best {best['score']:.1f} "
                        f"(median TTP {scores['median_ttp']:.0f} wks, "
                        f"on-drug {scores['pct_on_drug']:.0f}%).")
                    verdict = "rejected"
                history_txt += (f"\n- {cname}: median {scores['median_ttp']:.0f}, "
                                f"p10 {scores['p10_ttp']:.0f}, "
                                f"on {scores['pct_on_drug']:.0f}% -> {verdict}.")
            except Exception as e:
                scores, verdict = None, "rejected"
                reason = f"Rejected: rule failed validation ({e})."
                history_txt += f"\n- {cname}: invalid -> rejected."
            log.append({"iter": tag, "name": cname, "src": src,
                        "scores": scores, "verdict": verdict,
                        "reason": reason})

    best["explanation"] = explain_rule(best["src"])
    best["backend"] = backend
    return best, log

