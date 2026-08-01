#!/usr/bin/env python3
"""Measure street-level retrieval against a harvest index. The baseline instrument.

    services/inference/.venv/bin/python services/eval/run_eval.py \
        --db data/harvest/greenwich.sqlite \
        --queries data/eval/greenwich_queries.json \
        --out research/raven/current-system/raw/baseline.json

WHAT IT MEASURES
----------------
Standard VPR protocol, the one Pitts30k / MSLS / Tokyo24-7 report:

    recall@k = fraction of queries for which AT LEAST ONE of the top-k retrieved
               reference images lies within `--threshold` metres of the query's
               ground-truth coordinate.

25 m is the community default and is what we report as headline. We also report
50 m and 100 m, because for an investigator "the right block" and "the right
building" are different products, and a single number hides which one we have.

It also reports the top-1 geodesic error distribution, which recall@k cannot
show: a system can have poor recall@1 and still be useful if its misses are 60 m
away, and can have decent recall@1 and be dangerous if its misses are 4 km away.

WHY IT REPLICATES THE PRODUCT'S SEARCH RATHER THAN CALLING IT
-------------------------------------------------------------
`searchLocalIndex` in src/lib/live/localIndex.ts is the shipping path: bbox prune,
then exact cosine, then sort. This file reimplements exactly that in numpy so the
science runs in seconds instead of minutes. `--parity-dump` writes the top-k for a
sample of queries in the same shape the TypeScript returns, so the two can be
diffed and the replication proven rather than assumed. Any divergence is a bug in
this file, and the TypeScript is the authority.

ABSTENTION
----------
`--abstain-threshold` sweeps a cosine-similarity cut and reports what an operator
would actually experience: coverage (fraction answered), and precision among the
answered. A retrieval system for evidence is allowed to say nothing; it is not
allowed to say something wrong confidently. The sweep is how we pick the cut.
"""

from __future__ import annotations

import argparse
import json
import math
import pathlib
import sqlite3
import statistics
import sys
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

EARTH_R = 6_371_000.0


def haversine_m(lat1: np.ndarray, lon1: np.ndarray, lat2: float, lon2: float) -> np.ndarray:
    p1 = np.radians(lat1)
    p2 = math.radians(lat2)
    dp = p2 - p1
    dl = np.radians(lon2 - lon1)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * math.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * EARTH_R * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


# ---------------------------------------------------------------------------
# Index
# ---------------------------------------------------------------------------


class Index:
    """The embedded reference rows, as numpy. Mirrors loadLocalIndex()."""

    def __init__(self, db_path: pathlib.Path, drop_panos: bool = False) -> None:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        rows = list(
            con.execute(
                """SELECT r.mapillary_id, r.lat, r.lon, r.compass_angle, r.is_pano,
                          r.sequence_id, r.captured_at, r.thumb_url, e.vec, e.dim
                     FROM records r JOIN embeddings e ON e.mapillary_id = r.mapillary_id
                    ORDER BY r.mapillary_id"""
            )
        )
        con.close()
        if drop_panos:
            rows = [r for r in rows if not r["is_pano"]]
        if not rows:
            raise SystemExit(f"{db_path} has no embedded rows (drop_panos={drop_panos}).")

        self.dim = int(rows[0]["dim"])
        self.ids = [str(r["mapillary_id"]) for r in rows]
        self.lat = np.array([float(r["lat"]) for r in rows], dtype=np.float64)
        self.lon = np.array([float(r["lon"]) for r in rows], dtype=np.float64)
        self.is_pano = np.array([bool(r["is_pano"]) for r in rows])
        self.seq = [r["sequence_id"] for r in rows]
        self.captured = [r["captured_at"] for r in rows]
        self.thumb = [r["thumb_url"] for r in rows]

        v = np.zeros((len(rows), self.dim), dtype=np.float32)
        for i, r in enumerate(rows):
            body = str(r["vec"]).strip().lstrip("[").rstrip("]")
            v[i] = np.fromstring(body, sep=",", dtype=np.float32)
        # Same repair loadLocalIndex() does: cosine assumes unit vectors, and an
        # unnormalised row is a silent wrong-ranking bug rather than an error.
        norms = np.linalg.norm(v, axis=1, keepdims=True)
        self.renormalised = int((np.abs(norms - 1.0) > 1e-3).sum())
        norms[norms == 0] = 1.0
        self.vec = v / norms

    def __len__(self) -> int:
        return len(self.ids)

    def search(
        self, q: np.ndarray, bbox: Optional[Tuple[float, float, float, float]], k: int
    ) -> Tuple[np.ndarray, np.ndarray, int]:
        """-> (indices, similarities, n_scored). Prune THEN score, as the product does."""
        if bbox is None:
            mask = np.ones(len(self), dtype=bool)
        else:
            west, south, east, north = bbox
            mask = (
                (self.lon >= west)
                & (self.lon <= east)
                & (self.lat >= south)
                & (self.lat <= north)
            )
        idx = np.nonzero(mask)[0]
        if idx.size == 0:
            return np.array([], dtype=int), np.array([]), 0
        sims = self.vec[idx] @ q
        order = np.argsort(-sims)[:k]
        return idx[order], sims[order], int(idx.size)


# ---------------------------------------------------------------------------
# Query embedding
# ---------------------------------------------------------------------------


def assert_is_our_embedder(embed_url: str) -> Dict[str, Any]:
    """Refuse to embed against whatever happens to answer on that port.

    A retrieval benchmark that silently embedded against the wrong service would
    report a number, not an error -- the exact failure mode this project exists to
    eliminate. Ports in the 8000s are contested (an Xcode-bundled Python was found
    holding 8000 on the development machine), and a foreign JSON responder would
    otherwise surface only as unexplained bad recall.

    So the identity of the service, the model name and the descriptor width are all
    checked before a single image is sent. A dimension mismatch is the dangerous
    one: cosine across two descriptor spaces returns plausible nonsense rather
    than raising.
    """
    import urllib.error
    import urllib.request

    url = f"{embed_url.rstrip('/')}/health"
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            health = json.loads(r.read())
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise SystemExit(
            f"no embedding service at {embed_url} ({e}). Start it:\n"
            "  TORCH_HOME=$PWD/.lantage-models/torch \\\n"
            "    services/inference/.venv/bin/python services/inference/local_server.py"
            " --port 8010"
        )

    if health.get("service") != "lantage-inference-local":
        raise SystemExit(
            f"{embed_url} answered /health, but it is not our embedding service "
            f"(service={health.get('service')!r}). Something else is holding that "
            "port; embedding against it would produce a plausible-looking wrong "
            "number rather than an error."
        )

    model = (health.get("models") or {}).get("eigenplaces") or {}
    dim = model.get("dim")
    if dim != 512:
        raise SystemExit(
            f"{embed_url} serves a {dim}-d eigenplaces descriptor; the indexes in "
            "this project are 512-d. Cosine across two descriptor spaces returns "
            "nonsense silently, so this is refused."
        )
    print(
        f"[embed] {health['service']} {model.get('version')} "
        f"dim={dim} device={health.get('device')}",
        file=sys.stderr,
    )
    return health


def embed_queries(
    queries: Sequence[Dict[str, Any]],
    embed_url: str,
    cache_path: Optional[pathlib.Path],
    batch: int = 16,
) -> Dict[str, List[float]]:
    """POST each thumb URL to the local /embed service. Cached on disk by image id.

    The cache matters because a Mapillary thumb URL is a short-lived signed link:
    re-running the eval an hour later would otherwise fail on expired URLs and
    look like a retrieval regression.
    """
    import urllib.error
    import urllib.request

    assert_is_our_embedder(embed_url)

    cache: Dict[str, List[float]] = {}
    if cache_path and cache_path.exists():
        cache = json.loads(cache_path.read_text())
        print(f"[embed] {len(cache):,} cached", file=sys.stderr)

    todo = [q for q in queries if q["mapillaryId"] not in cache]
    print(f"[embed] {len(todo):,} to embed via {embed_url}", file=sys.stderr)

    for i in range(0, len(todo), batch):
        chunk = todo[i : i + batch]
        payload = json.dumps(
            {"items": [{"imageUrl": q["thumbUrl"], "models": ["eigenplaces"]} for q in chunk]}
        ).encode()
        req = urllib.request.Request(
            f"{embed_url.rstrip('/')}/embed_batch",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                body = json.loads(resp.read())
        except urllib.error.URLError as e:
            raise SystemExit(
                f"embed service at {embed_url} unreachable ({e}). Start it:\n"
                "  TORCH_HOME=$PWD/.lantage-models/torch "
                "services/inference/.venv/bin/python services/inference/local_server.py"
            )

        results = body.get("results") or body.get("items") or []
        for q, r in zip(chunk, results):
            if not isinstance(r, dict) or r.get("error"):
                print(f"[embed] {q['mapillaryId']}: {r}", file=sys.stderr)
                continue
            emb = r.get("embeddings", {}).get("eigenplaces") or r.get("eigenplaces")
            if isinstance(emb, dict):
                emb = emb.get("vector") or emb.get("embedding")
            if emb:
                cache[q["mapillaryId"]] = list(map(float, emb))
        print(
            f"[embed] {min(i+batch, len(todo)):,}/{len(todo):,}", file=sys.stderr, end="\r"
        )
        if cache_path:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(json.dumps(cache))
    print(file=sys.stderr)
    return cache


# ---------------------------------------------------------------------------
# Eval
# ---------------------------------------------------------------------------

KS = (1, 5, 10, 20)
THRESHOLDS = (25.0, 50.0, 100.0)


def _epoch_ms(captured: Any) -> Optional[int]:
    """Mapillary hands back epoch-ms from search and ISO-8601 from the checkpoint."""
    if captured in (None, ""):
        return None
    s = str(captured)
    if s.isdigit():
        return int(s)
    try:
        from datetime import datetime

        return int(
            datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000
        )
    except ValueError:
        return None


def drop_reupload_duplicates(
    queries: List[Dict[str, Any]],
    index: "Index",
    *,
    max_ms: int = 1000,
    max_m: float = 3.0,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Remove queries that are the SAME PHOTOGRAPH as an index row.

    The held-out-sequence split is necessary but not sufficient. Mapillary
    contains the same drive uploaded more than once: identical pixels, identical
    capture timestamp to the millisecond, identical coordinates to nine decimal
    places -- but a fresh image id inside a fresh sequence id. Such a query
    passes every id and sequence check and then retrieves its own twin at cosine
    1.000 and 0.0 m error, silently inflating recall.

    Three of 176 queries in the first Greenwich set were exactly this. Capture
    time plus position is what identifies them, because it is the one pair a
    re-upload cannot change.
    """
    idx_stamps: Dict[int, List[int]] = {}
    for i, cap in enumerate(index.captured):
        ms = _epoch_ms(cap)
        if ms is not None:
            idx_stamps.setdefault(ms // max_ms, []).append(i)

    kept: List[Dict[str, Any]] = []
    dropped: List[Dict[str, Any]] = []
    for q in queries:
        ms = _epoch_ms(q.get("capturedAt"))
        twin = None
        if ms is not None:
            bucket = ms // max_ms
            for b in (bucket - 1, bucket, bucket + 1):
                for i in idx_stamps.get(b, ()):
                    if abs(_epoch_ms(index.captured[i]) - ms) > max_ms:
                        continue
                    d = float(
                        haversine_m(
                            np.array([index.lat[i]]), np.array([index.lon[i]]),
                            q["lat"], q["lon"],
                        )[0]
                    )
                    if d <= max_m:
                        twin = {"queryId": q["mapillaryId"], "indexId": index.ids[i],
                                "deltaMs": abs(_epoch_ms(index.captured[i]) - ms),
                                "deltaM": round(d, 3)}
                        break
                if twin:
                    break
        (dropped if twin else kept).append(twin or q)
    return kept, dropped


def evaluate(args: argparse.Namespace) -> Dict[str, Any]:
    qs_doc = json.loads(pathlib.Path(args.queries).read_text())
    queries = qs_doc["queries"]
    index = Index(pathlib.Path(args.db), drop_panos=args.drop_panos)
    print(
        f"[index] {len(index):,} embedded rows, dim={index.dim}, "
        f"{int(index.is_pano.sum()):,} panos, renormalised={index.renormalised}",
        file=sys.stderr,
    )

    queries, dupes = drop_reupload_duplicates(queries, index)
    if dupes:
        print(
            f"[leak] dropped {len(dupes)} re-upload duplicate(s): "
            f"{', '.join(d['queryId'] for d in dupes[:6])}"
            f"{' ...' if len(dupes) > 6 else ''}",
            file=sys.stderr,
        )

    emb = embed_queries(
        queries,
        args.embed_url,
        pathlib.Path(args.embed_cache) if args.embed_cache else None,
    )
    usable = [q for q in queries if q["mapillaryId"] in emb]
    print(f"[eval] {len(usable):,}/{len(queries):,} queries embedded", file=sys.stderr)

    bbox = tuple(qs_doc["index"]["bbox"]) if args.bbox_prune else None

    per_query: List[Dict[str, Any]] = []
    latencies: List[float] = []
    for q in usable:
        v = np.asarray(emb[q["mapillaryId"]], dtype=np.float32)
        n = float(np.linalg.norm(v))
        if n > 0:
            v = v / n
        t0 = time.perf_counter()
        idx, sims, scored = index.search(v, bbox, max(KS))
        latencies.append((time.perf_counter() - t0) * 1000.0)
        if idx.size == 0:
            continue
        d = haversine_m(index.lat[idx], index.lon[idx], q["lat"], q["lon"])
        per_query.append(
            {
                "queryId": q["mapillaryId"],
                "lat": q["lat"],
                "lon": q["lon"],
                "geomSource": q["geomSource"],
                "capturedAt": q.get("capturedAt"),
                "sequenceId": q.get("sequenceId"),
                "scored": scored,
                "topSim": float(sims[0]),
                "simGap": float(sims[0] - sims[1]) if sims.size > 1 else None,
                "errors": [float(x) for x in d],
                "hitIds": [index.ids[i] for i in idx],
                "hitIsPano": [bool(index.is_pano[i]) for i in idx],
                "hitSims": [float(s) for s in sims],
                "hitLatLon": [[float(index.lat[i]), float(index.lon[i])] for i in idx],
                "hitThumbs": [index.thumb[i] for i in idx],
            }
        )

    # ---- metrics -----------------------------------------------------------
    metrics: Dict[str, Any] = {"n": len(per_query)}
    for thr in THRESHOLDS:
        for k in KS:
            hits = sum(
                1 for r in per_query if any(e <= thr for e in r["errors"][:k])
            )
            metrics[f"recall@{k}_{int(thr)}m"] = (
                round(hits / len(per_query), 4) if per_query else 0.0
            )

    top1 = [r["errors"][0] for r in per_query]
    if top1:
        s = sorted(top1)
        metrics["top1_error_m"] = {
            "median": round(statistics.median(s), 1),
            "p25": round(s[int(0.25 * (len(s) - 1))], 1),
            "p75": round(s[int(0.75 * (len(s) - 1))], 1),
            "p90": round(s[int(0.90 * (len(s) - 1))], 1),
            "min": round(s[0], 1),
            "max": round(s[-1], 1),
        }
    metrics["search_latency_ms"] = {
        "median": round(statistics.median(latencies), 3) if latencies else None,
        "max": round(max(latencies), 3) if latencies else None,
    }

    # Pano contamination: how often a 360 pano occupies a top-1 slot. EigenPlaces
    # was trained on perspective crops, so a pano descriptor is not comparable and
    # every slot one takes is a slot a real candidate lost.
    if per_query:
        metrics["pano_top1_rate"] = round(
            sum(1 for r in per_query if r["hitIsPano"][0]) / len(per_query), 4
        )
        metrics["pano_top5_share"] = round(
            sum(sum(r["hitIsPano"][:5]) for r in per_query) / (5 * len(per_query)), 4
        )

    # ---- abstention sweep --------------------------------------------------
    sweep = []
    for cut in [round(x, 2) for x in np.arange(0.30, 0.96, 0.05)]:
        answered = [r for r in per_query if r["topSim"] >= cut]
        if not answered:
            sweep.append({"cut": cut, "coverage": 0.0, "precision@1_25m": None, "n": 0})
            continue
        correct = sum(1 for r in answered if r["errors"][0] <= 25.0)
        sweep.append(
            {
                "cut": cut,
                "coverage": round(len(answered) / len(per_query), 4),
                "precision@1_25m": round(correct / len(answered), 4),
                "n": len(answered),
            }
        )
    metrics["abstention_sweep"] = sweep

    return {
        "config": {
            "db": args.db,
            "queries": args.queries,
            "dropPanos": args.drop_panos,
            "bboxPrune": args.bbox_prune,
            "indexRows": len(index),
            "indexPanos": int(index.is_pano.sum()),
            "protocol": qs_doc.get("protocol"),
        },
        "metrics": metrics,
        "perQuery": per_query,
    }


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db", required=True)
    p.add_argument("--queries", required=True)
    p.add_argument("--out", required=True)
    # 8010, matching LANTAGE_LOCAL_EMBED_URL in .env.local, so the harness and the
    # app speak to one service. 8000 was the old default and is a bad one: it is a
    # popular port (an Xcode-bundled Python was found squatting on it on this
    # machine), and until the health check below existed, a foreign responder there
    # would have been embedded against silently.
    p.add_argument("--embed-url", default="http://127.0.0.1:8010")
    p.add_argument("--embed-cache", default="data/eval/embed_cache.json")
    p.add_argument(
        "--drop-panos",
        action="store_true",
        help="Exclude is_pano rows from the reference index.",
    )
    p.add_argument(
        "--no-bbox-prune",
        dest="bbox_prune",
        action="store_false",
        help="Score every row instead of pruning to the index bbox.",
    )
    p.set_defaults(bbox_prune=True)
    args = p.parse_args()

    out = evaluate(args)
    path = pathlib.Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=2))

    m = out["metrics"]
    print(f"\n{'='*64}\n  {args.db}  (drop_panos={args.drop_panos})\n{'='*64}")
    print(f"  queries evaluated : {m['n']}")
    print(f"  index rows        : {out['config']['indexRows']:,}")
    for thr in THRESHOLDS:
        line = "  ".join(f"R@{k}={m[f'recall@{k}_{int(thr)}m']:.3f}" for k in KS)
        print(f"  @{int(thr):>3} m : {line}")
    if "top1_error_m" in m:
        e = m["top1_error_m"]
        print(
            f"  top-1 error (m)   : median={e['median']}  p25={e['p25']} "
            f"p75={e['p75']}  p90={e['p90']}  max={e['max']}"
        )
    if "pano_top1_rate" in m:
        print(
            f"  pano in top-1     : {m['pano_top1_rate']:.1%}   "
            f"top-5 share {m['pano_top5_share']:.1%}"
        )
    print(f"  search latency ms : {m['search_latency_ms']}")
    print(f"\n  -> {path}")


if __name__ == "__main__":
    main()
