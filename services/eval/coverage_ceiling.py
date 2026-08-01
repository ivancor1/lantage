#!/usr/bin/env python3
"""How well could a PERFECT retriever do on this index? The coverage ceiling.

    services/inference/.venv/bin/python services/eval/coverage_ceiling.py \
        --db data/harvest/greenwich.sqlite --queries data/eval/greenwich_queries_20m.json

WHY THIS NUMBER DECIDES THE ROADMAP
-----------------------------------
recall@k conflates two completely different failures:

  (a) the right reference image IS in the corpus and the ranker did not surface it
  (b) the right reference image IS NOT IN THE CORPUS AT ALL

Only (a) is fixable by a better descriptor, a reranker, or geometric
verification. (b) is fixable only by harvesting more imagery, and no amount of
model work touches it.

This script separates them. For each query it computes the geodesic distance to
the *nearest reference row by position*, ignoring appearance entirely. If that
distance exceeds the recall threshold, the query is unanswerable: an oracle that
returned the single best possible row would still be scored wrong.

    ceiling@thr = fraction of queries with any reference row within thr metres

That is the hard upper bound on recall@k for every k, for every model, on this
corpus. Measured recall divided by the ceiling is the *ranker's* score, and it is
the only version of the number that says anything about our models.

It also reports how much of the remaining gap a perfect reranker over the top-k
shortlist could recover, which is the honest budget for reranking work.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from run_eval import Index, haversine_m  # noqa: E402

THRESHOLDS = (25.0, 50.0, 100.0)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db", required=True)
    p.add_argument("--queries", required=True)
    p.add_argument("--eval-json", help="run_eval.py output, to compare against measured recall")
    p.add_argument("--out")
    p.add_argument("--drop-panos", action="store_true")
    args = p.parse_args()

    index = Index(pathlib.Path(args.db), drop_panos=args.drop_panos)
    queries = json.loads(pathlib.Path(args.queries).read_text())["queries"]

    nearest = []
    for q in queries:
        d = haversine_m(index.lat, index.lon, q["lat"], q["lon"])
        nearest.append(float(d.min()))
    nearest_arr = np.array(nearest)

    out = {
        "db": args.db,
        "indexRows": len(index),
        "queries": len(queries),
        "nearestReferenceMeters": {
            "median": round(float(np.median(nearest_arr)), 1),
            "p25": round(float(np.percentile(nearest_arr, 25)), 1),
            "p75": round(float(np.percentile(nearest_arr, 75)), 1),
            "p90": round(float(np.percentile(nearest_arr, 90)), 1),
            "max": round(float(nearest_arr.max()), 1),
        },
        "ceiling": {},
    }
    for thr in THRESHOLDS:
        out["ceiling"][f"{int(thr)}m"] = round(float((nearest_arr <= thr).mean()), 4)

    print(f"\n{'='*70}\n  COVERAGE CEILING — {args.db}\n{'='*70}")
    print(f"  index rows : {len(index):,}    queries : {len(queries)}")
    n = out["nearestReferenceMeters"]
    print(
        f"  distance to nearest reference image (m): "
        f"median={n['median']}  p75={n['p75']}  p90={n['p90']}  max={n['max']}"
    )
    print()
    for thr in THRESHOLDS:
        c = out["ceiling"][f"{int(thr)}m"]
        print(f"  ceiling@{int(thr):>3}m : {c:.3f}   <- no retriever can beat this")

    if args.eval_json:
        ev = json.loads(pathlib.Path(args.eval_json).read_text())
        m = ev["metrics"]
        print(f"\n  {'':<12}{'measured':>10}{'ceiling':>10}{'ranker':>10}{'headroom':>10}")
        for thr in THRESHOLDS:
            c = out["ceiling"][f"{int(thr)}m"]
            r1 = m[f"recall@1_{int(thr)}m"]
            r20 = m[f"recall@20_{int(thr)}m"]
            eff = r1 / c if c else 0.0
            print(
                f"  R@1  @{int(thr):>3}m {r1:>10.3f}{c:>10.3f}{eff:>10.1%}"
                f"{c - r1:>10.3f}"
            )
            out.setdefault("comparison", {})[f"{int(thr)}m"] = {
                "recall@1": r1,
                "recall@20": r20,
                "ceiling": c,
                "rankerEfficiency": round(eff, 4),
                "headroomFromRankingAlone": round(r20 - r1, 4),
                "headroomRequiringMoreData": round(c - r20, 4),
                "unanswerableEvenWithPerfectData": round(1 - c, 4),
            }
        print()
        for thr in THRESHOLDS:
            cmp = out["comparison"][f"{int(thr)}m"]
            print(
                f"  @{int(thr):>3}m  reranking top-20 could add at most "
                f"{cmp['headroomFromRankingAlone']:+.3f}; "
                f"more imagery could add {cmp['headroomRequiringMoreData']:+.3f}; "
                f"{cmp['unanswerableEvenWithPerfectData']:.3f} is out of reach of this corpus."
            )

    if args.out:
        path = pathlib.Path(args.out)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(out, indent=2))
        print(f"\n  -> {path}")


if __name__ == "__main__":
    main()
