#!/usr/bin/env python3
"""Re-score a saved geometric-rerank run offline. No re-matching.

    services/inference/.venv/bin/python services/eval/fuse_analysis.py \
        --rerank-json research/raven/current-system/raw/rerank_union.json

WHY
---
The first geometric rerank sorted purely by RANSAC inlier count and made
recall@1 WORSE (0.575 -> 0.450 @25 m) while producing an excellent confidence
signal (precision 0.842 among the 47.5% of queries with >= 64 inliers). Those two
facts together say the inlier count is a good *evidence* statistic and a bad
*ordering* statistic.

The plausible reason is that inlier count scales with how much texture a pair
happens to share, not with whether it is the same place. A texture-rich wrong
facade out-scores a correct match seen from a different angle. Cosine similarity,
whatever its faults, is at least calibrated to "same place" by training.

So the question is whether a fusion beats either alone. All the expensive work
(SIFT + MAGSAC over every query-candidate pair) is already saved per pair, so
every scoring rule below is re-evaluated offline in milliseconds -- which is also
the honest way to do it, because sweeping a weight against the same 40 queries
that chose it would be fitting the benchmark. The chosen rule is therefore
reported with its sweep, not as a single tuned number.
"""

from __future__ import annotations

import argparse
import json
import math
import pathlib
from typing import Any, Callable, Dict, List

THRESH = 25.0


def recall_at(rows: List[Dict[str, Any]], score: Callable[[Dict, int], float], k: int) -> float:
    hit = 0
    for r in rows:
        n = len(r["verdicts"])
        order = sorted(range(n), key=lambda i: score(r, i), reverse=True)
        if any(r["baselineErrors"][i] <= THRESH for i in order[:k]):
            hit += 1
    return hit / len(rows) if rows else 0.0


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--rerank-json", required=True)
    p.add_argument("--out")
    args = p.parse_args()

    doc = json.loads(pathlib.Path(args.rerank_json).read_text())
    rows = doc["perQuery"]
    print(f"queries: {len(rows)}   candidates/query: {len(rows[0]['verdicts'])}\n")

    rules: Dict[str, Callable[[Dict, int], float]] = {
        "cosine only (baseline)": lambda r, i: r["baselineSims"][i],
        "inliers only": lambda r, i: r["verdicts"][i]["inliers"],
        "inliers, cosine tiebreak": lambda r, i: (
            r["verdicts"][i]["inliers"] * 1000 + r["baselineSims"][i]
        ),
    }
    for lam in (0.02, 0.05, 0.10, 0.20, 0.40):
        rules[f"cosine + {lam:.2f}*log1p(inliers)"] = (
            lambda r, i, lam=lam: r["baselineSims"][i] + lam * math.log1p(
                r["verdicts"][i]["inliers"]
            )
        )
    # Gate-then-cosine: geometry only promotes a candidate past a hard bar,
    # otherwise ordering is left alone. Encodes "verification is a veto, not a
    # ranking function".
    for bar in (16, 32, 48, 64):
        rules[f"verified(>={bar}) first, then cosine"] = (
            lambda r, i, bar=bar: (
                1.0 if r["verdicts"][i]["inliers"] >= bar else 0.0
            ) * 10 + r["baselineSims"][i]
        )

    out: Dict[str, Any] = {"source": args.rerank_json, "n": len(rows), "rules": {}}
    print(f"{'rule':<38}{'R@1':>8}{'R@5':>8}{'R@10':>8}")
    print("-" * 62)
    for name, fn in rules.items():
        r1, r5, r10 = (recall_at(rows, fn, k) for k in (1, 5, 10))
        out["rules"][name] = {"recall@1": round(r1, 4), "recall@5": round(r5, 4),
                              "recall@10": round(r10, 4)}
        print(f"{name:<38}{r1:>8.3f}{r5:>8.3f}{r10:>8.3f}")

    # Which statistic best separates a correct top-1 from a wrong one? That is the
    # question calibration actually needs answered.
    print("\nseparation of correct vs wrong top-1 (cosine-ordered):")
    corr = [r for r in rows if r["baselineErrors"][0] <= THRESH]
    wrong = [r for r in rows if r["baselineErrors"][0] > THRESH]
    for label, get in (
        ("top-1 cosine", lambda r: r["baselineSims"][0]),
        ("top-1 inliers", lambda r: r["verdicts"][0]["inliers"]),
        ("top-1 spread", lambda r: r["verdicts"][0]["spread"]),
        ("cos gap 1-2", lambda r: r["baselineSims"][0] - r["baselineSims"][1]),
        ("max inliers in top-10", lambda r: max(v["inliers"] for v in r["verdicts"])),
    ):
        c = sorted(get(r) for r in corr)
        w = sorted(get(r) for r in wrong)
        med = lambda a: a[len(a) // 2] if a else float("nan")
        print(
            f"  {label:<22} correct median {med(c):>8.3f}   wrong median {med(w):>8.3f}"
        )
        out.setdefault("separation", {})[label] = {
            "correctMedian": round(float(med(c)), 4),
            "wrongMedian": round(float(med(w)), 4),
        }

    if args.out:
        pathlib.Path(args.out).write_text(json.dumps(out, indent=2))
        print(f"\n-> {args.out}")


if __name__ == "__main__":
    main()
