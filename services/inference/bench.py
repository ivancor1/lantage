#!/usr/bin/env python3
"""
Measure the inference service against the MASTER_PLAN §3/§6 latency budget.

BENCH (§10) exists because nobody in this market has published a benchmark. The
same discipline applies internally: the §3 cascade table asserts ~120 ms for the
GeoCLIP prior, ~170 ms for EigenPlaces retrieval and ~2.8 s for a MegaLoc
re-rank. Those numbers came from the literature and from the plan's own arithmetic
— not from our hardware. This script replaces them with measurements.

It also measures the thing the §6 cost model is most sensitive to: the gap
between a cold container and a warm one. That gap is the entire justification for
`min_containers=1` ($0.02-0.05 vs ~$1.10 per 1,000 searches), and it should be
verified rather than assumed.

Deliberately stdlib-only, so it runs from a laptop with no venv.

Usage
-----
    export LANTAGE_INFERENCE_URL=https://<workspace>--lantage-inference-embedder-web.modal.run
    export LANTAGE_INFERENCE_SECRET=<same value as the Modal secret>

    # warm-path measurement against the deployed service
    python3 services/inference/bench.py

    # include a genuine cold start (see --help for the required deploy posture)
    python3 services/inference/bench.py --cold --idle-wait 360

Measuring a real cold start requires the container to actually be gone, so
deploy with the scale-to-zero posture first:

    LANTAGE_MIN_CONTAINERS=0 LANTAGE_SCALEDOWN_WINDOW=60 modal deploy services/inference/app.py
    python3 services/inference/bench.py --cold --idle-wait 120

Then redeploy warm (no env overrides) before running the warm suite, so you are
measuring the posture you actually ship.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import statistics
import struct
import sys
import time
import urllib.error
import urllib.request
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

BENCH_VERSION = 2

ALL_MODELS = ("geoclip", "eigenplaces", "dinov2", "megaloc")

# Budgets from docs/MASTER_PLAN.md. These are the claims under test.
#
# Note what each number covers. §3 stage [3] quotes ~170 ms for "region-pruned VPR
# retrieval", which includes the pgvector query that is NOT part of this service —
# so the model-only figure has to come in under it with room to spare. §3's
# comparison table separately quotes 0.13 s/image for EigenPlaces and 2.80 s for
# MegaLoc, which are the model-only numbers and the fairer target here.
BUDGET_MS: dict[str, Optional[float]] = {
    "geoclip": 120.0,      # §3 stage [1], "~120 ms warm L4"
    "eigenplaces": 130.0,  # §3 decision table, "0.13 s per image"
    "megaloc": 2800.0,     # §3 stage [4] / decision table, "2.80 s"
    "dinov2": None,        # no published budget; VEHICLE/CLAIM are not latency-critical
}
BUDGET_SOURCE = {
    "geoclip": "MASTER_PLAN §3 cascade stage [1]",
    "eigenplaces": "MASTER_PLAN §3 descriptor-dimension table (0.13 s/image)",
    "megaloc": "MASTER_PLAN §3 cascade stage [4] (2.80 s)",
    "dinov2": None,
}

AUTH_HEADER = "X-Lantage-Inference-Key"


# ---------------------------------------------------------------------------
# Deterministic synthetic test image (stdlib PNG writer)
# ---------------------------------------------------------------------------


def synthetic_png(width: int = 960, height: int = 720, seed: int = 20260729) -> bytes:
    """A deterministic, non-uniform PNG.

    Non-uniform matters: a flat colour image can hit degenerate fast paths and
    understate real latency. Deterministic matters because the report records the
    image's sha256, so two runs on different machines are comparable.
    """
    state = seed & 0xFFFFFFFF
    rows = bytearray()
    for y in range(height):
        rows.append(0)  # PNG filter type 0 per scanline
        for x in range(width):
            state = (1103515245 * state + 12345) & 0x7FFFFFFF
            noise = state >> 16 & 0xFF
            # Coarse structure plus fine noise: gradients, blocks, and grain.
            r = (x * 255 // width + noise // 4) & 0xFF
            g = (y * 255 // height + ((x // 32 + y // 32) % 2) * 60) & 0xFF
            b = (noise + (x * y // 97)) & 0xFF
            rows += bytes((r, g, b))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">2I5B", width, height, 8, 2, 0, 0, 0)  # 8-bit truecolour
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(rows), 6))
        + chunk(b"IEND", b"")
    )


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


class BenchError(RuntimeError):
    pass


def request(
    url: str, secret: str, path: str, payload: Optional[dict] = None, timeout: float = 300.0
) -> tuple[Any, float]:
    """Returns (parsed json, elapsed ms). Elapsed includes network round trip."""
    target = url.rstrip("/") + path
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        target,
        data=body,
        method="POST" if body is not None else "GET",
        headers={
            "Content-Type": "application/json",
            AUTH_HEADER: secret,
            "Accept": "application/json",
        },
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:600]
        raise BenchError(f"{path} -> HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise BenchError(f"{path} -> {exc.reason}") from exc
    elapsed = (time.perf_counter() - started) * 1000.0
    return json.loads(raw), elapsed


def summarise(samples: list[float]) -> dict[str, float]:
    ordered = sorted(samples)
    n = len(ordered)

    def pct(p: float) -> float:
        if n == 1:
            return ordered[0]
        idx = min(n - 1, max(0, round(p * (n - 1))))
        return ordered[idx]

    return {
        "n": n,
        "min": round(ordered[0], 2),
        "p50": round(statistics.median(ordered), 2),
        "p95": round(pct(0.95), 2),
        "max": round(ordered[-1], 2),
        "mean": round(statistics.fmean(ordered), 2),
        "stdev": round(statistics.stdev(ordered), 2) if n > 1 else 0.0,
    }


# ---------------------------------------------------------------------------
# Phases
# ---------------------------------------------------------------------------


def load_image(spec: Optional[str]) -> tuple[bytes, str]:
    if not spec:
        return synthetic_png(), "synthetic:deterministic-png-960x720"
    if spec.lower().startswith(("http://", "https://")):
        with urllib.request.urlopen(spec, timeout=60) as resp:
            return resp.read(), f"url:{spec}"
    path = Path(spec).expanduser()
    return path.read_bytes(), f"file:{path}"


def phase_warm(
    url: str, secret: str, b64: str, models: list[str], iters: int, warmup: int
) -> dict[str, Any]:
    """Per-model warm latency, one image at a time — the §3 per-stage claim."""
    out: dict[str, Any] = {}
    for model in models:
        payload = {"imageBase64": b64, "models": [model]}
        for _ in range(warmup):
            request(url, secret, "/embed", payload)

        client_ms: list[float] = []
        server_ms: list[float] = []
        dim: Optional[int] = None
        version: Optional[str] = None
        norm: Optional[float] = None
        prior_len: Optional[int] = None

        for _ in range(iters):
            body, elapsed = request(url, secret, "/embed", payload)
            client_ms.append(elapsed)
            server_ms.append(float(body["tookMs"]))
            entry = body["embeddings"][model]
            dim = entry["dim"]
            version = entry["version"]
            # Verify the L2-normalisation invariant the Postgres side depends on.
            norm = sum(v * v for v in entry["vector"]) ** 0.5
            if body.get("geoPrior") is not None:
                prior_len = len(body["geoPrior"])

        budget = BUDGET_MS.get(model)
        server = summarise(server_ms)
        out[model] = {
            "dim": dim,
            "version": version,
            "vectorLength": dim,
            "l2Norm": round(norm, 6) if norm is not None else None,
            "unitNorm": abs((norm or 0) - 1.0) < 1e-3,
            "geoPriorPoints": prior_len,
            "serverMs": server,
            "clientMs": summarise(client_ms),
            "networkOverheadMs": round(
                summarise(client_ms)["p50"] - server["p50"], 2
            ),
            "budgetMs": budget,
            "budgetSource": BUDGET_SOURCE.get(model),
            "withinBudget": None if budget is None else server["p95"] <= budget,
        }
    return out


def phase_batch(
    url: str, secret: str, b64: str, models: list[str], sizes: list[int]
) -> dict[str, Any]:
    """Amortised per-image cost as batch size grows.

    This is the number that decides whether B3's Mapillary harvest (§11, 320k
    vectors for Pittsburgh) is a few GPU-hours or a few GPU-days.
    """
    out: dict[str, Any] = {}
    for model in models:
        per_size: dict[str, Any] = {}
        for size in sizes:
            payload = {"images": [{"imageBase64": b64}] * size, "models": [model]}
            try:
                body, elapsed = request(url, secret, "/embed_batch", payload)
            except BenchError as exc:
                per_size[str(size)] = {"error": str(exc)}
                continue
            total = float(body["tookMs"])
            per_size[str(size)] = {
                "serverTotalMs": round(total, 2),
                "serverPerImageMs": round(total / size, 2),
                "clientTotalMs": round(elapsed, 2),
                "resultCount": len(body["results"]),
            }
        # Speedup of the largest batch vs batch-of-1, i.e. what batching buys.
        first, last = str(sizes[0]), str(sizes[-1])
        if "serverPerImageMs" in per_size.get(first, {}) and "serverPerImageMs" in per_size.get(
            last, {}
        ):
            out[model] = {
                "bySize": per_size,
                "batchingSpeedup": round(
                    per_size[first]["serverPerImageMs"] / per_size[last]["serverPerImageMs"], 2
                ),
            }
        else:
            out[model] = {"bySize": per_size}
    return out


def phase_cascade(url: str, secret: str, b64: str, iters: int) -> dict[str, Any]:
    """The realistic hot path: GeoCLIP + EigenPlaces in one call.

    §3 budgets stages [1] and [3] separately, but the orchestrator wants both
    descriptors for one frame. One request that returns both is strictly cheaper
    than two, because the image is fetched and decoded once.
    """
    payload = {"imageBase64": b64, "models": ["geoclip", "eigenplaces"]}
    try:
        request(url, secret, "/embed", payload)
    except BenchError as exc:
        return {"error": str(exc)}
    server_ms = []
    for _ in range(iters):
        body, _ = request(url, secret, "/embed", payload)
        server_ms.append(float(body["tookMs"]))
    combined_budget = (BUDGET_MS["geoclip"] or 0) + (BUDGET_MS["eigenplaces"] or 0)
    summary = summarise(server_ms)
    return {
        "models": ["geoclip", "eigenplaces"],
        "serverMs": summary,
        "sumOfIndividualBudgetsMs": combined_budget,
        "withinSumOfBudgets": summary["p95"] <= combined_budget,
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--url", default=os.environ.get("LANTAGE_INFERENCE_URL", ""))
    ap.add_argument("--secret", default=os.environ.get("LANTAGE_INFERENCE_SECRET", ""))
    ap.add_argument("--image", default=os.environ.get("LANTAGE_BENCH_IMAGE"),
                    help="local path or http(s) URL; default is a deterministic synthetic PNG")
    ap.add_argument("--models", default=",".join(ALL_MODELS))
    ap.add_argument("--iters", type=int, default=15)
    ap.add_argument("--warmup", type=int, default=3)
    ap.add_argument("--batch-sizes", default="1,4,8,16")
    ap.add_argument("--skip-batch", action="store_true")
    ap.add_argument("--cold", action="store_true",
                    help="measure the first request as a cold start (requires the container "
                         "to actually be gone — deploy with LANTAGE_MIN_CONTAINERS=0)")
    ap.add_argument("--idle-wait", type=int, default=0,
                    help="seconds to sleep before the cold measurement; must exceed "
                         "scaledown_window for the container to have been reclaimed")
    ap.add_argument("--out", default=str(Path(__file__).parent / "bench_report.json"))
    args = ap.parse_args()

    if not args.url:
        print("error: --url or LANTAGE_INFERENCE_URL is required", file=sys.stderr)
        return 2
    if not args.secret:
        print("error: --secret or LANTAGE_INFERENCE_SECRET is required", file=sys.stderr)
        return 2

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    unknown = [m for m in models if m not in ALL_MODELS]
    if unknown:
        print(f"error: unknown models {unknown}; valid: {list(ALL_MODELS)}", file=sys.stderr)
        return 2
    sizes = sorted({int(s) for s in args.batch_sizes.split(",") if s.strip()})

    raw, source = load_image(args.image)
    b64 = base64.b64encode(raw).decode()

    report: dict[str, Any] = {
        "benchVersion": BENCH_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "endpoint": args.url,
        "image": {
            "source": source,
            "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
        },
        "config": {"iters": args.iters, "warmup": args.warmup, "batchSizes": sizes},
        "errors": [],
    }

    # -- cold start, first (any other request would warm the container) --------
    if args.cold:
        if args.idle_wait:
            print(f"[cold] sleeping {args.idle_wait}s so the container is reclaimed...")
            time.sleep(args.idle_wait)
        payload = {"imageBase64": b64, "models": models}
        try:
            body, elapsed = request(args.url, args.secret, "/embed", payload)
            report["cold"] = {
                "models": models,
                "clientMs": round(elapsed, 2),
                "serverMs": round(float(body["tookMs"]), 2),
                # clientMs - serverMs on a cold request is dominated by container
                # boot + weight load. That delta IS the §6 cost argument: paying
                # it once per request is the ~$1.10/1k posture.
                "containerStartupMs": round(elapsed - float(body["tookMs"]), 2),
                "note": (
                    "Only a true cold start if the container was reclaimed first. "
                    "Deploy with LANTAGE_MIN_CONTAINERS=0 and use --idle-wait > "
                    "scaledown_window."
                ),
            }
            print(f"[cold] {elapsed:.0f}ms end-to-end "
                  f"({report['cold']['containerStartupMs']:.0f}ms startup)")
        except BenchError as exc:
            report["errors"].append(f"cold: {exc}")
            print(f"[cold] failed: {exc}", file=sys.stderr)

    # -- health ---------------------------------------------------------------
    try:
        health, health_ms = request(args.url, args.secret, "/health")
        report["health"] = health
        report["healthMs"] = round(health_ms, 2)
        print(f"[health] {health.get('status')} | gpu={health.get('gpu', {}).get('name')} "
              f"| posture={health.get('scaling', {}).get('warmPosture')} "
              f"| uptime={health.get('container', {}).get('uptimeSeconds')}s")
    except BenchError as exc:
        report["errors"].append(f"health: {exc}")
        print(f"[health] failed: {exc}", file=sys.stderr)
        # Health failing usually means bad URL or bad secret; nothing else will work.
        Path(args.out).write_text(json.dumps(report, indent=2) + "\n")
        return 1

    available = [m for m, v in report["health"].get("models", {}).items() if v.get("loaded")]
    skipped = [m for m in models if m not in available]
    if skipped:
        report["errors"].append(f"not loaded on this deployment, skipped: {skipped}")
        print(f"[warn] skipping models not loaded: {skipped}")
    models = [m for m in models if m in available]
    if not models:
        Path(args.out).write_text(json.dumps(report, indent=2) + "\n")
        print("error: no requested model is loaded", file=sys.stderr)
        return 1

    # -- warm per model -------------------------------------------------------
    print(f"[warm] {args.iters} iters x {len(models)} models...")
    try:
        report["warm"] = phase_warm(args.url, args.secret, b64, models, args.iters, args.warmup)
        for model, r in report["warm"].items():
            verdict = (
                "n/a" if r["withinBudget"] is None else ("PASS" if r["withinBudget"] else "OVER")
            )
            print(f"  {model:<12} p50={r['serverMs']['p50']:>8.1f}ms "
                  f"p95={r['serverMs']['p95']:>8.1f}ms "
                  f"budget={r['budgetMs']} [{verdict}] "
                  f"dim={r['dim']} unitNorm={r['unitNorm']}")
    except BenchError as exc:
        report["errors"].append(f"warm: {exc}")

    # -- realistic cascade call ----------------------------------------------
    if "geoclip" in models and "eigenplaces" in models:
        report["cascade"] = phase_cascade(args.url, args.secret, b64, args.iters)
        c = report["cascade"]
        if "serverMs" in c:
            print(f"[cascade] geoclip+eigenplaces p50={c['serverMs']['p50']:.1f}ms "
                  f"p95={c['serverMs']['p95']:.1f}ms "
                  f"vs sum-of-budgets {c['sumOfIndividualBudgetsMs']}ms")

    # -- batching -------------------------------------------------------------
    if not args.skip_batch:
        print(f"[batch] sizes {sizes}...")
        report["batch"] = phase_batch(args.url, args.secret, b64, models, sizes)
        for model, r in report["batch"].items():
            if "batchingSpeedup" in r:
                print(f"  {model:<12} per-image "
                      f"{r['bySize'][str(sizes[0])]['serverPerImageMs']:.1f}ms @{sizes[0]} -> "
                      f"{r['bySize'][str(sizes[-1])]['serverPerImageMs']:.1f}ms @{sizes[-1]} "
                      f"({r['batchingSpeedup']}x)")

    # -- verdict --------------------------------------------------------------
    over = [
        m for m, r in report.get("warm", {}).items() if r.get("withinBudget") is False
    ]
    unnormalised = [
        m for m, r in report.get("warm", {}).items() if r.get("unitNorm") is False
    ]
    report["verdict"] = {
        "modelsOverBudget": over,
        # A non-unit vector reaching pgvector silently corrupts cosine ranking,
        # so this is a hard failure, not a warning.
        "modelsNotUnitNorm": unnormalised,
        "budgetHonoured": not over,
        "normalisationHonoured": not unnormalised,
    }

    Path(args.out).write_text(json.dumps(report, indent=2) + "\n")
    print(f"\nreport -> {args.out}")
    if unnormalised:
        print(f"FAIL: embeddings not unit-norm: {unnormalised}", file=sys.stderr)
        return 1
    if over:
        print(f"WARN: over §6 budget: {over}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
