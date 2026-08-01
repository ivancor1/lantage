#!/usr/bin/env python3
"""Geometric verification: turn a retrieval hit into checkable evidence.

    services/inference/.venv/bin/python services/eval/geometric_rerank.py \
        --db data/harvest/greenwich_union.sqlite \
        --eval-json research/raven/current-system/raw/cmp_union.json \
        --out research/raven/current-system/raw/rerank_union.json

WHAT THIS STAGE IS FOR, AND IT IS NOT ONLY ACCURACY
---------------------------------------------------
A global descriptor answers "does this look like that". It cannot answer "is
this the same physical surface", and it produces no artifact a human can check.
AGENTS.md requires street precision to be *earned* by a `vpr-match` whose
`verifiable` string says how a person independently confirms it. A cosine of
0.71 is not that. **N inliers surviving RANSAC between the query and a named
Mapillary image is** — an analyst can open both images and look at the
correspondences.

So this stage does two jobs, in this order of importance:

  1. It supplies the evidence artifact that lets a result claim street
     precision at all.
  2. It reranks, recovering hits the descriptor put at rank 2-20.

Measured headroom for (2) on the union index is R@20 - R@1 = +0.107. That is the
entire budget; a reranker cannot invent candidates the shortlist never contained.

WHY SIFT AND NOT SUPERPOINT/SUPERGLUE
-------------------------------------
SuperPoint and SuperGlue are Magic Leap research licences: **non-commercial**.
Shipping them would be a licensing defect, not a technical one. OpenCV is
Apache-2.0 (it relicensed from 3-clause BSD at 4.5.0) and the SIFT patent expired
in March 2020, so SIFT is free to use commercially and is in the box already.
One caveat that the phrase "zero licence risk" would paper over: the
`opencv-python-headless` wheel bundles **LGPL FFmpeg**, which is fine for our use
but is a redistribution obligation to track if these wheels are ever shipped
inside a customer artifact. XFeat (Apache-2.0) and ALIKED+LightGlue are the
upgrade path when this stage earns its keep -- this file exists to find out
whether it does.

WHY THE FUNDAMENTAL MATRIX AND NOT A HOMOGRAPHY
-----------------------------------------------
A homography is only correct for a plane or a pure rotation. Two photographs of a
street from different positions see a 3-D scene under translation, so a
homography systematically under-counts inliers on exactly the buildings-plus-road
geometry we care about. The fundamental matrix is the right model for two views
of a rigid 3-D scene, and MAGSAC++ is used because it does not need a manually
tuned inlier threshold, which would otherwise become a hidden dial that tunes the
benchmark.
"""

from __future__ import annotations

import argparse
import io
import json
import pathlib
import statistics
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from run_eval import KS, THRESHOLDS, Index  # noqa: E402

# Long edge the images are matched at. SIFT cost is superlinear in pixel count and
# Mapillary thumbs are 1024 px; 640 keeps a full rerank inside a second or so per
# candidate pair without measurably costing inliers on facades.
MATCH_LONG_EDGE = 640
# Lowe's ratio. 0.75 is the paper's value; looser admits more false matches, which
# RANSAC then has to reject, and stricter starves low-texture facades.
RATIO = 0.75
# Below this, "verified" is not a claim worth making. Calibrated in §Results, not
# guessed: it is the point where precision among verified pairs stops improving.
MIN_INLIERS = 12


def fetch(url: str, timeout: float = 30.0) -> Optional[np.ndarray]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            buf = np.frombuffer(r.read(), dtype=np.uint8)
    except (urllib.error.URLError, OSError):
        return None
    img = cv2.imdecode(buf, cv2.IMREAD_GRAYSCALE)
    if img is None:
        return None
    h, w = img.shape[:2]
    s = MATCH_LONG_EDGE / max(h, w)
    if s < 1.0:
        img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    return img


class Verifier:
    def __init__(self) -> None:
        self.sift = cv2.SIFT_create(nfeatures=2048)
        self.matcher = cv2.BFMatcher(cv2.NORM_L2)

    def features(self, img: np.ndarray) -> Tuple[Any, Any]:
        return self.sift.detectAndCompute(img, None)

    def verify(self, kp1, des1, kp2, des2) -> Dict[str, Any]:
        """-> inlier count and the spread of those inliers across the frame.

        Inlier *spread* matters as much as count. Twenty inliers clustered on one
        repeated window mullion is a texture coincidence; twenty spread across the
        frame is the same building. Spread is reported so calibration can use it
        and so a reviewer can see which kind of match they were shown.
        """
        empty = {"inliers": 0, "matches": 0, "spread": 0.0}
        if des1 is None or des2 is None or len(des1) < 8 or len(des2) < 8:
            return empty
        pairs = self.matcher.knnMatch(des1, des2, k=2)
        good = [m for m, n in (p for p in pairs if len(p) == 2) if m.distance < RATIO * n.distance]
        if len(good) < 8:
            return {"inliers": 0, "matches": len(good), "spread": 0.0}

        src = np.float32([kp1[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
        dst = np.float32([kp2[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
        try:
            _, mask = cv2.findFundamentalMat(
                src, dst, cv2.USAC_MAGSAC, ransacReprojThreshold=3.0,
                confidence=0.999, maxIters=10_000,
            )
        except cv2.error:
            return {"inliers": 0, "matches": len(good), "spread": 0.0}
        if mask is None:
            return {"inliers": 0, "matches": len(good), "spread": 0.0}

        keep = mask.ravel().astype(bool)
        n = int(keep.sum())
        spread = 0.0
        if n >= 4:
            pts = src.reshape(-1, 2)[keep]
            # Normalised std of inlier positions: 0 = one clump, ~0.3 = frame-wide.
            spread = float(np.mean(np.std(pts, axis=0)) / MATCH_LONG_EDGE)
        return {"inliers": n, "matches": len(good), "spread": round(spread, 4)}


def rerank(args: argparse.Namespace) -> Dict[str, Any]:
    ev = json.loads(pathlib.Path(args.eval_json).read_text())
    per_query = ev["perQuery"]
    if args.limit:
        per_query = per_query[: args.limit]
    index = Index(pathlib.Path(args.db))
    by_id = {mid: i for i, mid in enumerate(index.ids)}
    verifier = Verifier()

    # Query thumbs are not in the eval json; re-read them from the query set.
    qdoc = json.loads(pathlib.Path(args.queries).read_text())
    qthumb = {q["mapillaryId"]: q["thumbUrl"] for q in qdoc["queries"]}

    topn = args.top_n
    out_rows: List[Dict[str, Any]] = []
    timings: List[float] = []

    for qi, r in enumerate(per_query):
        url = qthumb.get(r["queryId"])
        if not url:
            continue
        t0 = time.perf_counter()
        qimg = fetch(url)
        if qimg is None:
            continue
        kp1, des1 = verifier.features(qimg)

        cand_ids = r["hitIds"][:topn]
        cand_urls = [
            index.thumb[by_id[c]] if c in by_id else None for c in cand_ids
        ]
        with ThreadPoolExecutor(max_workers=8) as pool:
            imgs = list(pool.map(lambda u: fetch(u) if u else None, cand_urls))

        verdicts = []
        for img in imgs:
            if img is None:
                verdicts.append({"inliers": 0, "matches": 0, "spread": 0.0})
                continue
            kp2, des2 = verifier.features(img)
            verdicts.append(verifier.verify(kp1, des1, kp2, des2))
        timings.append((time.perf_counter() - t0) * 1000.0)

        order = sorted(
            range(len(cand_ids)),
            key=lambda i: (verdicts[i]["inliers"], r["hitSims"][i]),
            reverse=True,
        )
        out_rows.append(
            {
                "queryId": r["queryId"],
                "baselineErrors": r["errors"][:topn],
                "baselineSims": r["hitSims"][:topn],
                "verdicts": verdicts,
                "rerankOrder": order,
                "rerankedErrors": [r["errors"][i] for i in order],
                "topInliers": verdicts[order[0]]["inliers"] if order else 0,
                "topSpread": verdicts[order[0]]["spread"] if order else 0.0,
            }
        )
        if (qi + 1) % 10 == 0:
            print(f"[rerank] {qi+1}/{len(per_query)}", file=sys.stderr, end="\r")
    print(file=sys.stderr)

    # ---- metrics ----------------------------------------------------------
    m: Dict[str, Any] = {"n": len(out_rows), "topN": topn}
    for thr in THRESHOLDS:
        for k in KS:
            if k > topn:
                continue
            base = sum(1 for x in out_rows if any(e <= thr for e in x["baselineErrors"][:k]))
            new = sum(1 for x in out_rows if any(e <= thr for e in x["rerankedErrors"][:k]))
            m[f"baseline_recall@{k}_{int(thr)}m"] = round(base / len(out_rows), 4)
            m[f"reranked_recall@{k}_{int(thr)}m"] = round(new / len(out_rows), 4)

    # Verification as a GATE, not only a sorter: only answer when inliers clear a
    # bar. This is the number that decides whether we may claim street precision.
    gate = []
    for cut in (0, 4, 8, 12, 16, 24, 32, 48, 64):
        answered = [x for x in out_rows if x["topInliers"] >= cut]
        if not answered:
            gate.append({"minInliers": cut, "coverage": 0.0, "precision@1_25m": None, "n": 0})
            continue
        correct = sum(1 for x in answered if x["rerankedErrors"][0] <= 25.0)
        gate.append(
            {
                "minInliers": cut,
                "coverage": round(len(answered) / len(out_rows), 4),
                "precision@1_25m": round(correct / len(answered), 4),
                "n": len(answered),
            }
        )
    m["verification_gate"] = gate
    m["rerank_latency_ms"] = {
        "median": round(statistics.median(timings), 1) if timings else None,
        "p90": round(sorted(timings)[int(0.9 * (len(timings) - 1))], 1) if timings else None,
    }
    return {"config": {"db": args.db, "evalJson": args.eval_json, "topN": topn,
                       "minInliers": MIN_INLIERS, "matchLongEdge": MATCH_LONG_EDGE,
                       "detector": "SIFT(BSD) + MAGSAC++ fundamental matrix"},
            "metrics": m, "perQuery": out_rows}


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db", required=True)
    p.add_argument("--eval-json", required=True)
    p.add_argument("--queries", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--top-n", type=int, default=10)
    p.add_argument("--limit", type=int, default=0)
    args = p.parse_args()

    out = rerank(args)
    path = pathlib.Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=2))

    m = out["metrics"]
    print(f"\n{'='*68}\n  GEOMETRIC RERANK — {args.db}  (top-{m['topN']})\n{'='*68}")
    print(f"  queries: {m['n']}")
    for thr in (25.0, 50.0):
        print(f"  @{int(thr)} m")
        for k in KS:
            kb, kr = f"baseline_recall@{k}_{int(thr)}m", f"reranked_recall@{k}_{int(thr)}m"
            if kb in m:
                d = m[kr] - m[kb]
                print(f"     R@{k:<3} {m[kb]:.3f} -> {m[kr]:.3f}   ({d:+.3f})")
    print("\n  verification gate (min inliers -> coverage / precision@1 @25m):")
    for g in m["verification_gate"]:
        pr = "n/a" if g["precision@1_25m"] is None else f"{g['precision@1_25m']:.3f}"
        print(f"     >={g['minInliers']:>3} inliers : coverage {g['coverage']:.3f}  precision {pr}  (n={g['n']})")
    print(f"\n  rerank latency ms: {m['rerank_latency_ms']}")
    print(f"\n  -> {path}")


if __name__ == "__main__":
    main()
