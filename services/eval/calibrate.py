#!/usr/bin/env python3
"""Fit and honestly score a confidence model for street-level retrieval.

    services/inference/.venv/bin/python services/eval/calibrate.py \
        --rerank-json research/raven/current-system/raw/rerank_union_full.json \
        --out research/raven/current-system/raw/calibration.json

WHAT IS BEING CALIBRATED
------------------------
Not "how similar are these two images" -- that is the cosine, and it is not a
probability. The quantity an investigator needs is:

    P(the top-1 candidate is within 25 m of the truth | the evidence we have)

`confidence.ts` currently answers this with hand-written constants its own
comments describe as "provisional literature priors". They were never fitted to
anything. This file replaces guessing with measurement.

FEATURES, AND WHY THESE
-----------------------
From the measured separation between correct and wrong top-1 results:

    top-1 cosine        correct median 0.815   wrong 0.637   <- informative
    top-1 inliers       correct median 73      wrong 23      <- most informative
    cosine gap 1-2      correct median 0.072   wrong 0.026   <- informative
    inlier spread       correct median 0.169   wrong 0.164   <- USELESS, dropped

Inlier spread was included on the theory that inliers clustered on one repeated
architectural element indicate a texture coincidence. The data says it does not
separate at all, so it is dropped rather than retained for narrative tidiness.

The three surviving features are complementary: cosine says "this looks like
that", inliers say "this is the same physical surface", and the 1-2 gap says
"and nothing else in the corpus looks like it", which is the one that catches
repeated suburban facades.

WHY LEAVE-ONE-OUT AND NOT A TRAIN/TEST SPLIT
--------------------------------------------
n = 159. A 70/30 split leaves ~48 test points, on which a reliability curve is
noise. Leave-one-out cross-validation uses every point for testing exactly once
with a model that never saw it, which is the most data-efficient unbiased option
at this size. Every number this script reports is out-of-fold. The in-fold
numbers are also printed, purely so the gap between them is visible -- that gap
is the overfitting, and hiding it would defeat the point.

THE HONEST CAVEAT, STATED UP FRONT
----------------------------------
159 points fits 4 parameters. That is enough to demonstrate the method and to
rank the features; it is NOT enough to publish a per-band error rate a court
would rely on. Bands below carry Wilson intervals, and several are wide. The
number needed for a defensible published rate is in the roadmap, not here.
"""

from __future__ import annotations

import argparse
import json
import math
import pathlib
from typing import Any, Dict, List, Tuple

import numpy as np

THRESH_M = 25.0
FEATURES = ("top1_cosine", "log1p_inliers", "cos_gap_12")


def wilson(k: int, n: int, z: float = 1.96) -> Tuple[float, float]:
    """Binomial CI that behaves at the extremes, where normal approximation lies."""
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def build(rows: List[Dict[str, Any]]) -> Tuple[np.ndarray, np.ndarray]:
    X, y = [], []
    for r in rows:
        sims, verd = r["baselineSims"], r["verdicts"]
        gap = sims[0] - sims[1] if len(sims) > 1 else 0.0
        X.append([sims[0], math.log1p(verd[0]["inliers"]), gap])
        y.append(1.0 if r["baselineErrors"][0] <= THRESH_M else 0.0)
    return np.array(X, dtype=np.float64), np.array(y, dtype=np.float64)


def fit_logistic(X: np.ndarray, y: np.ndarray, l2: float = 1.0, iters: int = 4000) -> np.ndarray:
    """Plain L2-regularised logistic regression, Newton-free gradient descent.

    Written out rather than pulled from scikit-learn: the inference venv does not
    carry sklearn, and adding a dependency to fit three coefficients would be a
    worse trade than twenty lines of numpy.
    """
    Xb = np.hstack([np.ones((X.shape[0], 1)), X])
    mu, sd = Xb[:, 1:].mean(0), Xb[:, 1:].std(0)
    sd[sd == 0] = 1.0
    Xs = np.hstack([np.ones((X.shape[0], 1)), (Xb[:, 1:] - mu) / sd])
    w = np.zeros(Xs.shape[1])
    lr = 0.5
    for _ in range(iters):
        p = 1.0 / (1.0 + np.exp(-Xs @ w))
        g = Xs.T @ (p - y) / len(y)
        g[1:] += l2 * w[1:] / len(y)
        w -= lr * g
    # Fold standardisation back so the returned weights apply to raw features.
    raw = np.zeros_like(w)
    raw[1:] = w[1:] / sd
    raw[0] = w[0] - float(np.sum(w[1:] * mu / sd))
    return raw


def predict(w: np.ndarray, X: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-(w[0] + X @ w[1:])))


BANDS = (("low", 0.0, 0.35), ("moderate", 0.35, 0.65), ("high", 0.65, 0.85),
         ("very-high", 0.85, 1.01))


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--rerank-json", required=True)
    p.add_argument("--out")
    args = p.parse_args()

    doc = json.loads(pathlib.Path(args.rerank_json).read_text())
    rows = doc["perQuery"]
    X, y = build(rows)
    n = len(y)
    print(f"n = {n}   positives (top-1 within {int(THRESH_M)} m) = {int(y.sum())} "
          f"({y.mean():.1%})\n")

    # ---- leave-one-out, the only numbers that mean anything -----------------
    oof = np.zeros(n)
    for i in range(n):
        m = np.ones(n, dtype=bool)
        m[i] = False
        oof[i] = predict(fit_logistic(X[m], y[m]), X[i : i + 1])[0]
    w_full = fit_logistic(X, y)
    infold = predict(w_full, X)

    def brier(pred: np.ndarray) -> float:
        return float(np.mean((pred - y) ** 2))

    base = float(np.mean((y.mean() - y) ** 2))
    print(f"Brier score   in-fold {brier(infold):.4f}   "
          f"out-of-fold {brier(oof):.4f}   (predict-the-base-rate = {base:.4f})")
    print(f"  skill vs base rate, out-of-fold: {1 - brier(oof)/base:+.1%}\n")

    print("fitted weights (raw feature scale):")
    for name, wt in zip(("intercept",) + FEATURES, w_full):
        print(f"  {name:<18}{wt:+.4f}")

    # ---- single-feature ablation, out-of-fold ------------------------------
    print("\nablation (out-of-fold Brier, lower is better):")
    for drop in range(X.shape[1]):
        keep = [j for j in range(X.shape[1]) if j != drop]
        o = np.zeros(n)
        for i in range(n):
            m = np.ones(n, dtype=bool)
            m[i] = False
            o[i] = predict(fit_logistic(X[m][:, keep], y[m]), X[i : i + 1][:, keep])[0]
        print(f"  without {FEATURES[drop]:<18}{brier(o):.4f}  "
              f"({brier(o) - brier(oof):+.4f})")

    # ---- reliability, out-of-fold ------------------------------------------
    print(f"\nreliability, out-of-fold — {'band':<12}{'n':>5}{'predicted':>11}"
          f"{'actual':>9}{'95% CI':>18}")
    bands_out = []
    for label, lo, hi in BANDS:
        m = (oof >= lo) & (oof < hi)
        cnt = int(m.sum())
        if cnt == 0:
            print(f"  {label:<26}{0:>5}{'-':>11}{'-':>9}{'-':>18}")
            bands_out.append({"band": label, "n": 0})
            continue
        act = float(y[m].mean())
        ci = wilson(int(y[m].sum()), cnt)
        print(f"  {label:<26}{cnt:>5}{float(oof[m].mean()):>11.3f}{act:>9.3f}"
              f"{f'[{ci[0]:.2f}, {ci[1]:.2f}]':>18}")
        bands_out.append({
            "band": label, "n": cnt,
            "predictedMean": round(float(oof[m].mean()), 4),
            "actualRate": round(act, 4),
            "ci95": [round(ci[0], 4), round(ci[1], 4)],
        })

    # ---- selective prediction ----------------------------------------------
    print(f"\nabstention (answer only when P >= cut), out-of-fold:")
    print(f"  {'cut':>6}{'coverage':>11}{'precision':>11}{'95% CI':>18}")
    sweep = []
    for cut in (0.0, 0.3, 0.5, 0.6, 0.7, 0.8, 0.9):
        m = oof >= cut
        cnt = int(m.sum())
        if cnt == 0:
            continue
        acc = float(y[m].mean())
        ci = wilson(int(y[m].sum()), cnt)
        print(f"  {cut:>6.2f}{cnt/n:>11.3f}{acc:>11.3f}"
              f"{f'[{ci[0]:.2f}, {ci[1]:.2f}]':>18}")
        sweep.append({"cut": cut, "coverage": round(cnt / n, 4),
                      "precision": round(acc, 4), "n": cnt,
                      "ci95": [round(ci[0], 4), round(ci[1], 4)]})

    out = {
        "n": n, "threshMeters": THRESH_M, "features": list(FEATURES),
        "weightsRawScale": {k: round(float(v), 6)
                            for k, v in zip(("intercept",) + FEATURES, w_full)},
        "brier": {"inFold": round(brier(infold), 4),
                  "outOfFold": round(brier(oof), 4),
                  "baseRate": round(base, 4)},
        "reliabilityOutOfFold": bands_out,
        "abstentionOutOfFold": sweep,
        "caveat": (
            f"Fitted on n={n} queries from one 5.8 km^2 area, all of them Mapillary "
            "photographs. Sufficient to rank features and demonstrate the method; "
            "NOT sufficient to publish a per-band error rate. Bands carry Wilson "
            "intervals and several are wide."
        ),
    }
    if args.out:
        pathlib.Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        pathlib.Path(args.out).write_text(json.dumps(out, indent=2))
        print(f"\n-> {args.out}")


if __name__ == "__main__":
    main()
