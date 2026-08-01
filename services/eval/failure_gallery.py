#!/usr/bin/env python3
"""Render the failures as side-by-side images, so they can be looked at.

    services/inference/.venv/bin/python services/eval/failure_gallery.py \
        --eval-json research/raven/current-system/raw/cmp_union.json \
        --queries data/eval/greenwich_common3.json \
        --db data/harvest/greenwich_union.sqlite \
        --out research/raven/failure-gallery

A recall number tells you how often the system is wrong. It does not tell you
what *kind* of wrong, and the kinds are what the roadmap is made of. This writes
one panel per failure -- query on the left, the retrieved top-1 on the right,
with the error distance, cosine and inlier count burned in -- plus an index.md.

Failures are bucketed by a mechanical rule so the categories are reproducible
rather than impressionistic:

  near-miss      25-100 m. Right street or block, wrong exact position. Often the
                 reference simply is not close enough to satisfy 25 m.
  wrong-place    > 100 m with high cosine. The corpus contains something that
                 genuinely looks like the query. Repeated facades, generic
                 suburbia, foliage. The dangerous class.
  no-coverage    > 100 m AND the nearest reference by position is itself > 25 m
                 away. The right answer was never in the corpus; the ranker had
                 nothing to find.
"""

from __future__ import annotations

import argparse
import io
import json
import pathlib
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from run_eval import Index, haversine_m  # noqa: E402

PANEL_W = 512


def grab(url: Optional[str]) -> Optional[Image.Image]:
    if not url:
        return None
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return Image.open(io.BytesIO(r.read())).convert("RGB")
    except Exception:
        return None


def panel(q: Image.Image, h: Image.Image, caption: str) -> Image.Image:
    def fit(im: Image.Image) -> Image.Image:
        w, hh = im.size
        return im.resize((PANEL_W, max(1, int(hh * PANEL_W / w))), Image.LANCZOS)

    a, b = fit(q), fit(h)
    top = max(a.size[1], b.size[1])
    canvas = Image.new("RGB", (PANEL_W * 2 + 12, top + 58), (17, 17, 19))
    canvas.paste(a, (0, 0))
    canvas.paste(b, (PANEL_W + 12, 0))
    d = ImageDraw.Draw(canvas)
    d.text((6, top + 8), "QUERY (held-out)", fill=(150, 150, 155))
    d.text((PANEL_W + 18, top + 8), "RETRIEVED top-1", fill=(150, 150, 155))
    for i, line in enumerate(caption.split("\n")):
        d.text((6, top + 24 + i * 13), line, fill=(235, 235, 240))
    return canvas


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--eval-json", required=True)
    p.add_argument("--queries", required=True)
    p.add_argument("--db", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--rerank-json", help="adds inlier counts to captions")
    p.add_argument("--max-per-bucket", type=int, default=6)
    args = p.parse_args()

    ev = json.loads(pathlib.Path(args.eval_json).read_text())
    qdoc = json.loads(pathlib.Path(args.queries).read_text())
    qthumb = {q["mapillaryId"]: q["thumbUrl"] for q in qdoc["queries"]}
    index = Index(pathlib.Path(args.db))
    by_id = {m: i for i, m in enumerate(index.ids)}

    inliers: Dict[str, int] = {}
    if args.rerank_json:
        for r in json.loads(pathlib.Path(args.rerank_json).read_text())["perQuery"]:
            inliers[r["queryId"]] = r["verdicts"][0]["inliers"]

    buckets: Dict[str, List[Dict[str, Any]]] = {
        "near-miss": [], "wrong-place": [], "no-coverage": [], "success": []
    }
    for r in ev["perQuery"]:
        err = r["errors"][0]
        nearest = float(
            haversine_m(index.lat, index.lon, r["lat"], r["lon"]).min()
        )
        if err <= 25.0:
            b = "success"
        elif err <= 100.0:
            b = "near-miss"
        elif nearest > 25.0:
            b = "no-coverage"
        else:
            b = "wrong-place"
        buckets[b].append({**r, "nearestRefM": nearest, "bucket": b})

    outdir = pathlib.Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)
    lines = [
        "# Failure gallery — union index, held-out Greenwich queries",
        "",
        f"Source: `{args.eval_json}` · {len(ev['perQuery'])} queries · "
        f"index `{args.db}` ({len(index):,} rows)",
        "",
        "Left = held-out query. Right = what the system retrieved at rank 1.",
        "",
        "| Bucket | Count | Share | Meaning |",
        "|---|---|---|---|",
    ]
    meanings = {
        "success": "top-1 within 25 m",
        "near-miss": "25–100 m — right area, wrong spot",
        "wrong-place": ">100 m but a reference existed within 25 m — the ranker was fooled",
        "no-coverage": ">100 m and no reference within 25 m — the answer was never in the corpus",
    }
    n = len(ev["perQuery"])
    for b in ("success", "near-miss", "wrong-place", "no-coverage"):
        lines.append(
            f"| {b} | {len(buckets[b])} | {len(buckets[b])/n:.1%} | {meanings[b]} |"
        )
    lines.append("")

    for b in ("wrong-place", "no-coverage", "near-miss"):
        rows = sorted(buckets[b], key=lambda r: -r["topSim"])[: args.max_per_bucket]
        if not rows:
            continue
        lines += [f"## {b} ({len(buckets[b])} total, showing {len(rows)})", ""]
        with ThreadPoolExecutor(max_workers=8) as pool:
            qs = list(pool.map(lambda r: grab(qthumb.get(r["queryId"])), rows))
            hs = list(pool.map(
                lambda r: grab(index.thumb[by_id[r["hitIds"][0]]]
                               if r["hitIds"][0] in by_id else None), rows))
        for r, qi, hi in zip(rows, qs, hs):
            if qi is None or hi is None:
                continue
            cap = (
                f"error {r['errors'][0]:.0f} m   cosine {r['topSim']:.3f}"
                + (f"   inliers {inliers[r['queryId']]}" if r["queryId"] in inliers else "")
                + f"\nnearest reference by position: {r['nearestRefM']:.0f} m"
                f"\nquery {r['queryId']}  ->  hit {r['hitIds'][0]}"
            )
            name = f"{b}__{r['queryId']}.jpg"
            panel(qi, hi, cap).save(outdir / name, quality=88)
            lines += [
                f"### `{r['queryId']}` — {r['errors'][0]:.0f} m off",
                "",
                f"![{name}]({name})",
                "",
                f"cosine {r['topSim']:.3f} · nearest reference by position "
                f"{r['nearestRefM']:.0f} m"
                + (f" · {inliers[r['queryId']]} RANSAC inliers"
                   if r["queryId"] in inliers else ""),
                "",
                f"Mapillary: query <https://www.mapillary.com/app/?pKey={r['queryId']}> · "
                f"retrieved <https://www.mapillary.com/app/?pKey={r['hitIds'][0]}>",
                "",
            ]
    (outdir / "index.md").write_text("\n".join(lines))
    print(f"[done] {outdir}/index.md")
    for b, v in buckets.items():
        print(f"  {b:<14}{len(v):>4}  {len(v)/n:>6.1%}")


if __name__ == "__main__":
    main()
