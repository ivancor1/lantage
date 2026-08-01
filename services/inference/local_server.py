#!/usr/bin/env python3
"""Local, CPU/MPS EigenPlaces embedding service — same wire contract as app.py.

    services/inference/.venv/bin/python services/inference/local_server.py

WHY THIS FILE EXISTS
--------------------
`app.py` is the production service and runs on a Modal L4. Nothing in the street
path works until *something* is answering `POST /embed`, and standing up a cloud
GPU account is a bigger commitment than "can I photograph a Greenwich street and
see whether it matches". This serves the identical contract on the laptop.

It is deliberately NOT a fork of app.py. The one thing that must be bit-for-bit
identical is the descriptor, so the three things that define the descriptor are
copied verbatim and commented as such:

  * the model:      torch.hub gmberton/EigenPlaces get_trained_model(ResNet50, 512)
  * the transform:  Resize((512, 512), BICUBIC) -> ToTensor -> ImageNet normalise
  * the postproc:   L2-normalise in fp32

Everything else (Modal scaling, GeoCLIP, MegaLoc, DINOv2, baked weights, the
shared-secret gate) is production infrastructure with no local analogue and is
absent on purpose.

WHY THE PREPROCESSING IS THE WHOLE BALLGAME
-------------------------------------------
EigenPlaces' own test transform does ToTensor + ImageNet normalise and NO resize
— the network is fully convolutional with GeM pooling, so it eats any input size
and quietly returns a *different* descriptor for each one. That means a resize
mismatch between index time and query time produces no error, no warning, and no
match; recall just collapses. `app.py` picked 512x512 bicubic (the paper's
training crop) and froze it as part of the descriptor's identity. So does this.
If you change `EIGENPLACES_INPUT_SIZE`, you have changed the model: bump
`MODEL_VERSION` and re-embed the whole index.

WHY THE VERSION STRING SAYS "local"
-----------------------------------
`eigenplaces-r50-512-local@1.0`, not `eigenplaces-r50-512@1.0`. The weights and
the transform match Modal's, but the arithmetic does not: this runs fp32 on CPU
or Apple MPS rather than fp32 on an L4, and the last few bits of a descriptor
depend on that. `ResultProvenance.models` is a reproducibility record, so a
result produced here has to be distinguishable from one produced on Modal
rather than silently claim to be the same thing.

THE BATCH ENVELOPE
------------------
`embed_index.py` posts `{"items": [ {imageUrl, models}, ... ]}` and app.py's
`/embed_batch` expects `{"images": [...], "models": [...]}`. Those disagree, and
the disagreement is why `embed_index.py --per-image` exists. This server accepts
BOTH so the harvest script runs unmodified in either mode. A per-item failure
comes back as `{"error": ...}` in the corresponding slot rather than failing the
whole batch, which is what lets the script re-mint one expired thumbnail URL
instead of losing the other 31 images in the window.

INSTALL (torch is a ~250 MB download; the whole venv lands around 1.1 GB)
------------------------------------------------------------------------
    python3 -m venv services/inference/.venv
    services/inference/.venv/bin/pip install -r services/inference/requirements-local.txt

The first run additionally pulls, from GitHub, the EigenPlaces checkout, its
CosPlace backbone-init checkout, and both checkpoints (~110 MB total, cached
under TORCH_HOME afterwards). After that the server starts offline.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import io
import json
import os
import pathlib
import socketserver
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Identity — mirrors the pieces of app.py's MODEL_REGISTRY that apply locally
# ---------------------------------------------------------------------------

SERVICE_NAME = "lantage-inference-local"
SERVICE_VERSION = "0.1.0"

MODEL_NAME = "eigenplaces"
MODEL_DIM = 512
MODEL_VERSION = "eigenplaces-r50-512-local@1.0"

# Verified against https://github.com/gmberton/EigenPlaces/blob/main/hubconf.py
# on 2026-07-31:
#   get_trained_model(backbone: str = "ResNet50", fc_output_dim: int = 2048)
#   AVAILABLE_TRAINED_MODELS["ResNet50"] == [128, 256, 512, 1024, 2048]
# so ResNet50 @ 512 is a published checkpoint, not an interpolation. The network
# (eigenplaces_model/eigenplaces_network.py) ends its aggregation in an L2Norm,
# so its output is already unit-norm; we normalise again anyway because
# idempotent beats assumed.
HUB_REPO = "gmberton/EigenPlaces"
HUB_ENTRYPOINT = "get_trained_model"
HUB_BACKBONE = "ResNet50"

# EigenPlaces' own `_get_backbone` does a NESTED, un-trusted
# `torch.hub.load("gmberton/cosplace", ...)` to initialise the ResNet before it
# overwrites everything with the EigenPlaces checkpoint. `trust_repo=True` on the
# outer call does not propagate to it, so on a fresh cache torch blocks on an
# interactive y/N prompt — which, in a background server process, is an EOFError
# during startup rather than anything that reads as a permissions question.
# Both repos are therefore pre-trusted before the load. See `_pretrust_hub_repos`.
HUB_TRUSTED = ("gmberton_EigenPlaces", "gmberton_cosplace")

# app.py: IMAGENET_MEAN / IMAGENET_STD / EIGENPLACES_INPUT_SIZE. Copied, not
# re-derived. See the module docstring for why a divergence here is invisible.
IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)
EIGENPLACES_INPUT_SIZE = int(os.environ.get("LANTAGE_EIGENPLACES_SIZE", "512"))

MAX_IMAGE_BYTES = 25 * 1024 * 1024
IMAGE_FETCH_TIMEOUT_S = 20.0
MAX_BATCH_IMAGES = 64
MAX_BODY_BYTES = 64 * 1024 * 1024  # a base64 25 MB image plus envelope

AUTH_HEADER_NAME = "X-Lantage-Inference-Key"

# Cache the hub checkout and both checkpoints inside the repo so a `rm -rf
# ~/.cache/torch` does not silently trigger a re-download mid-index-build.
_HERE = pathlib.Path(__file__).resolve().parent
DEFAULT_TORCH_HOME = _HERE.parent.parent / ".lantage-models" / "torch"


class ServiceError(Exception):
    """An HTTP-shaped failure. `status` is what the client sees."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


# ---------------------------------------------------------------------------
# The model
# ---------------------------------------------------------------------------


class LocalEigenPlaces:
    """One process, one resident model, many requests.

    Forward passes are serialised behind `_lock`. Two reasons: MPS is not a
    thread-safe target, and serialising keeps peak memory predictable on a
    laptop that is also running a dev server. Image fetch and JPEG decode happen
    outside the lock, which is where the concurrency actually pays.
    """

    def __init__(self, device_pref: Optional[str] = None) -> None:
        import torch
        import torchvision.transforms as T

        self.torch = torch
        self.device = torch.device(_resolve_device(device_pref, torch))
        # fp32, matching app.py. fp16 would be faster and would make the
        # descriptor depend on which accelerator happened to serve the request,
        # which is exactly the provenance problem the version string exists for.
        self.dtype = torch.float32
        self.precision = "fp32"

        self._lock = threading.Lock()
        self._counter_lock = threading.Lock()
        self.requests_served = 0
        self.images_embedded = 0
        self.started_at = datetime.now(timezone.utc).isoformat()
        self._t0 = time.time()

        _pretrust_hub_repos(torch)

        started = time.perf_counter()
        self.model = torch.hub.load(
            HUB_REPO,
            HUB_ENTRYPOINT,
            backbone=HUB_BACKBONE,
            fc_output_dim=MODEL_DIM,
            trust_repo=True,
            skip_validation=True,
        )
        self.model = self.model.eval().to(self.device, dtype=self.dtype)
        for p in self.model.parameters():
            p.requires_grad_(False)
        self.load_ms = (time.perf_counter() - started) * 1000.0

        # VERBATIM from app.py's `self._tf["eigenplaces"]`.
        self.transform = T.Compose(
            [
                T.Resize(
                    (EIGENPLACES_INPUT_SIZE, EIGENPLACES_INPUT_SIZE),
                    interpolation=T.InterpolationMode.BICUBIC,
                ),
                T.ToTensor(),
                T.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD),
            ]
        )

        from PIL import Image as PILImage

        # Decompression-bomb guard, tighter than Pillow's ~89 MP default for the
        # same reason as app.py: a real case photo is never that large.
        PILImage.MAX_IMAGE_PIXELS = 64_000_000

        self._warm_up()

    def _warm_up(self) -> None:
        """One throwaway forward so the first real request is not the slow one."""
        from PIL import Image as PILImage

        started = time.perf_counter()
        vec = self.embed([PILImage.new("RGB", (640, 480), (127, 127, 127))])[0]
        norm = sum(v * v for v in vec) ** 0.5
        print(
            "[warm-up] dim=%d  ||v||=%.6f  %.0fms"
            % (len(vec), norm, (time.perf_counter() - started) * 1000.0),
            flush=True,
        )
        if len(vec) != MODEL_DIM:
            raise SystemExit(
                "EigenPlaces returned dim %d, expected %d. mapillary_images.embedding "
                "is halfvec(512); refusing to serve a descriptor that cannot be "
                "indexed." % (len(vec), MODEL_DIM)
            )

    def embed(self, pils: List[Any], batch_size: int = 8) -> List[List[float]]:
        torch = self.torch
        out: List[List[float]] = []
        for start in range(0, len(pils), batch_size):
            chunk = pils[start : start + batch_size]
            batch = torch.stack([self.transform(p) for p in chunk]).to(
                self.device, dtype=self.dtype
            )
            with self._lock, torch.inference_mode():
                feats = self.model(batch)
                # Cosine similarity assumes unit vectors, and both pgvector's
                # cosine ops and localIndex.ts's brute-force scan take that on
                # faith. An unnormalised vector is a silent wrong-ranking bug,
                # never an error, so normalise unconditionally.
                feats = torch.nn.functional.normalize(feats.float(), dim=-1)
                out.extend(feats.cpu().tolist())
        return out

    def record(self, n_images: int) -> None:
        with self._counter_lock:
            self.requests_served += 1
            self.images_embedded += n_images


def _pretrust_hub_repos(torch: Any) -> None:
    """Add the two hub repos to torch's trusted list, non-interactively.

    `<TORCH_HOME>/hub/trusted_list` is one `owner_repo` per line — the same file
    and the same format `trust_repo=True` writes. Doing it up front is the only
    way to keep the nested CosPlace load from prompting, and it is narrower than
    the alternative (pre-loading the whole CosPlace model just for its side
    effect on that file). Only these two repos are named; nothing here trusts
    torch.hub generally.
    """
    hub_dir = pathlib.Path(torch.hub.get_dir())
    hub_dir.mkdir(parents=True, exist_ok=True)
    listing = hub_dir / "trusted_list"
    existing = set()
    if listing.exists():
        existing = {line.strip() for line in listing.read_text().splitlines() if line.strip()}
    missing = [r for r in HUB_TRUSTED if r not in existing]
    if missing:
        with listing.open("a", encoding="utf-8") as fh:
            for repo in missing:
                fh.write(repo + "\n")


def _resolve_device(pref: Optional[str], torch: Any) -> str:
    """MPS when it is actually usable, else CPU. `pref` forces one.

    Forcing matters for one reason: the index and the query must be embedded on
    the same device or the last bits of the descriptor differ. That is far below
    the retrieval threshold in practice, but it is also free to avoid.
    """
    if pref:
        return pref
    if torch.backends.mps.is_available() and torch.backends.mps.is_built():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


# ---------------------------------------------------------------------------
# Image loading
# ---------------------------------------------------------------------------


class ImageFetcher:
    def __init__(self) -> None:
        import httpx

        self.http = httpx.Client(
            timeout=IMAGE_FETCH_TIMEOUT_S,
            follow_redirects=True,
            limits=httpx.Limits(max_connections=16, max_keepalive_connections=8),
            headers={"User-Agent": "lantage-local-inference/%s" % SERVICE_VERSION},
        )

    def close(self) -> None:
        self.http.close()

    def load(self, src: Dict[str, Any]) -> Any:
        b64 = src.get("imageBase64")
        if b64:
            payload = str(b64)
            if payload.startswith("data:"):
                _, _, payload = payload.partition(",")
            try:
                raw = base64.b64decode(payload, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise ServiceError(400, "imageBase64 is not valid base64: %s" % exc) from exc
            return self._decode(raw)

        url = str(src.get("imageUrl") or "")
        if not url.lower().startswith(("http://", "https://")):
            raise ServiceError(400, "one of imageUrl (http/https) or imageBase64 is required")
        return self._decode(self._fetch(url))

    def _fetch(self, url: str) -> bytes:
        import httpx

        try:
            with self.http.stream("GET", url) as resp:
                if resp.status_code >= 400:
                    # 4xx is permanent for THIS url — an expired signed Mapillary
                    # CDN link is a 403 and is the common case at embed time. It
                    # is reported as 400 rather than 502 so `embed_index.py`
                    # stops retrying it with backoff and goes straight to
                    # re-minting the URL; its stale-URL detector greps the
                    # message for the upstream status, so keep the number in it.
                    status = 400 if resp.status_code < 500 else 502
                    raise ServiceError(
                        status,
                        "could not fetch imageUrl: upstream HTTP %d (an expired signed "
                        "thumbnail URL looks exactly like this)" % resp.status_code,
                    )
                declared = resp.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > MAX_IMAGE_BYTES:
                    raise ServiceError(413, "image exceeds %d bytes" % MAX_IMAGE_BYTES)
                buf = bytearray()
                for chunk in resp.iter_bytes(chunk_size=65536):
                    buf += chunk
                    if len(buf) > MAX_IMAGE_BYTES:
                        raise ServiceError(413, "image exceeds %d bytes" % MAX_IMAGE_BYTES)
                return bytes(buf)
        except ServiceError:
            raise
        except httpx.HTTPError as exc:
            raise ServiceError(502, "could not fetch imageUrl: %s" % type(exc).__name__) from exc

    @staticmethod
    def _decode(raw: bytes) -> Any:
        from PIL import Image as PILImage, UnidentifiedImageError

        if len(raw) > MAX_IMAGE_BYTES:
            raise ServiceError(413, "image exceeds %d bytes" % MAX_IMAGE_BYTES)
        try:
            img = PILImage.open(io.BytesIO(raw))
            img.load()
        except PILImage.DecompressionBombError as exc:
            raise ServiceError(413, "image too large to decode: %s" % exc) from exc
        except (UnidentifiedImageError, OSError, ValueError) as exc:
            raise ServiceError(400, "could not decode image: %s" % exc) from exc
        return img.convert("RGB")


# ---------------------------------------------------------------------------
# Request handling
# ---------------------------------------------------------------------------


def _check_models(requested: Any) -> None:
    """Only EigenPlaces is served here, and asking for another is a 503, not a lie.

    Returning a silently-substituted descriptor under someone else's model name
    would poison `ResultProvenance.models`.
    """
    if not isinstance(requested, list) or not requested:
        raise ServiceError(400, "`models` must be a non-empty array")
    unavailable = [m for m in requested if m != MODEL_NAME]
    if unavailable:
        raise ServiceError(
            503,
            "this local service serves %r only; not loaded: %s. Deploy "
            "services/inference/app.py to Modal for geoclip / megaloc / dinov2."
            % (MODEL_NAME, sorted(set(str(m) for m in unavailable))),
        )


def _embed_response(vector: List[float], took_ms: float) -> Dict[str, Any]:
    """EmbedResponseSchema, exactly. camelCase is the wire contract, not a style."""
    return {
        "embeddings": {
            MODEL_NAME: {
                "vector": vector,
                "dim": len(vector),
                "model": MODEL_NAME,
                "version": MODEL_VERSION,
            }
        },
        "tookMs": took_ms,
    }


def _batch_sources(body: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], List[Any]]:
    """Accept both batch envelopes. See the module docstring.

    app.py:         {"images": [{imageUrl|imageBase64}, ...], "models": [...]}
    embed_index.py: {"items":  [{imageUrl|imageBase64, models}, ...]}
    """
    if isinstance(body.get("items"), list):
        items = body["items"]
        if not items:
            raise ServiceError(400, "`items` must be a non-empty array")
        for item in items:
            if not isinstance(item, dict):
                raise ServiceError(400, "each entry of `items` must be an object")
            _check_models(item.get("models") or [MODEL_NAME])
        return items, items

    images = body.get("images")
    if not isinstance(images, list) or not images:
        raise ServiceError(400, "one of `items` or `images` must be a non-empty array")
    _check_models(body.get("models"))
    for item in images:
        if not isinstance(item, dict):
            raise ServiceError(400, "each entry of `images` must be an object")
    return images, images


class Handler(BaseHTTPRequestHandler):
    server_version = "%s/%s" % (SERVICE_NAME, SERVICE_VERSION)
    protocol_version = "HTTP/1.1"

    # Injected by `serve()`.
    embedder: LocalEigenPlaces
    fetcher: ImageFetcher
    auth_secret: str

    # -- plumbing -----------------------------------------------------------

    def log_message(self, fmt: str, *args: Any) -> None:
        if os.environ.get("LANTAGE_LOCAL_VERBOSE"):
            super().log_message(fmt, *args)

    def _send(self, status: int, payload: Dict[str, Any]) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _read_body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise ServiceError(400, "empty request body")
        if length > MAX_BODY_BYTES:
            raise ServiceError(413, "request body exceeds %d bytes" % MAX_BODY_BYTES)
        try:
            body = json.loads(self.rfile.read(length))
        except json.JSONDecodeError as exc:
            raise ServiceError(400, "body is not valid JSON: %s" % exc) from exc
        if not isinstance(body, dict):
            raise ServiceError(400, "body must be a JSON object")
        return body

    def _require_auth(self) -> None:
        """Opt-in. Unset secret means unauthenticated, which is correct here.

        The inverse of app.py, and deliberately: that service is a public HTTPS
        URL where a missing secret must fail closed, this one binds to loopback
        by default and `embed_index.py` sends no auth header at all. Setting
        LANTAGE_INFERENCE_SECRET turns the gate on for anyone who binds it wider.
        """
        if not self.auth_secret:
            return
        provided = self.headers.get(AUTH_HEADER_NAME) or ""
        bearer = self.headers.get("Authorization") or ""
        if bearer.lower().startswith("bearer "):
            provided = provided or bearer[7:]
        import hmac

        if not provided or not hmac.compare_digest(provided, self.auth_secret):
            raise ServiceError(401, "missing or invalid %s" % AUTH_HEADER_NAME)

    # -- routes -------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's naming
        try:
            self._require_auth()
            if self.path.split("?")[0] != "/health":
                raise ServiceError(404, "no such route: %s" % self.path)
            self._send(200, self._health())
        except ServiceError as exc:
            self._send(exc.status, {"detail": exc.detail})

    def do_POST(self) -> None:  # noqa: N802
        route = self.path.split("?")[0]
        try:
            self._require_auth()
            body = self._read_body()
            if route == "/embed":
                self._send(200, self._embed(body))
            elif route == "/embed_batch":
                self._send(200, self._embed_batch(body))
            else:
                raise ServiceError(404, "no such route: %s" % route)
        except ServiceError as exc:
            self._send(exc.status, {"detail": exc.detail})
        except Exception as exc:  # noqa: BLE001 - one bad request must not kill the server
            self._send(500, {"detail": "%s: %s" % (type(exc).__name__, exc)})

    def _embed(self, body: Dict[str, Any]) -> Dict[str, Any]:
        started = time.perf_counter()
        _check_models(body.get("models"))
        pil = self.fetcher.load(body)
        vector = self.embedder.embed([pil])[0]
        self.embedder.record(1)
        return _embed_response(vector, (time.perf_counter() - started) * 1000.0)

    def _embed_batch(self, body: Dict[str, Any]) -> Dict[str, Any]:
        started = time.perf_counter()
        sources, _ = _batch_sources(body)
        if len(sources) > MAX_BATCH_IMAGES:
            raise ServiceError(413, "batch exceeds %d images" % MAX_BATCH_IMAGES)

        # Fetch in parallel, embed together. One unreachable URL must not cost
        # the other 31 images their forward pass, so a failure is recorded in
        # its own slot and the survivors go to the model.
        from concurrent.futures import ThreadPoolExecutor

        def load(src: Dict[str, Any]) -> Any:
            try:
                return self.fetcher.load(src)
            except ServiceError as exc:
                return exc

        with ThreadPoolExecutor(max_workers=min(8, len(sources))) as pool:
            loaded = list(pool.map(load, sources))

        good = [(i, p) for i, p in enumerate(loaded) if not isinstance(p, ServiceError)]
        vectors = self.embedder.embed([p for _, p in good]) if good else []
        total = (time.perf_counter() - started) * 1000.0
        per_image = total / max(1, len(good))

        results: List[Dict[str, Any]] = [
            {"error": p.detail} if isinstance(p, ServiceError) else {} for p in loaded
        ]
        for (index, _), vector in zip(good, vectors):
            results[index] = _embed_response(vector, per_image)

        self.embedder.record(len(good))
        return {"results": results, "tookMs": total}

    def _health(self) -> Dict[str, Any]:
        e = self.embedder
        return {
            "status": "ok",
            "service": SERVICE_NAME,
            "serviceVersion": SERVICE_VERSION,
            "device": str(e.device),
            "precision": e.precision,
            "models": {
                MODEL_NAME: {
                    "loaded": True,
                    "dim": MODEL_DIM,
                    "version": MODEL_VERSION,
                    "role": "cascade stage [3] — PRIMARY retrieval descriptor",
                    "license": "MIT — Berton, Trivigno, Masone, Caputo (2023). Trained on SF-XL.",
                    "hub": "%s:%s(backbone=%s, fc_output_dim=%d)"
                    % (HUB_REPO, HUB_ENTRYPOINT, HUB_BACKBONE, MODEL_DIM),
                    "loadMs": round(e.load_ms, 1),
                }
            },
            "enabledModels": [MODEL_NAME],
            "preprocessing": {
                "eigenplacesInputSize": EIGENPLACES_INPUT_SIZE,
                "interpolation": "bicubic",
                "normalise": {"mean": list(IMAGENET_MEAN), "std": list(IMAGENET_STD)},
                "l2Normalised": True,
            },
            "container": {
                "startedAt": e.started_at,
                "uptimeSeconds": round(time.time() - e._t0, 1),
                "requestsServed": e.requests_served,
                "imagesEmbedded": e.images_embedded,
            },
        }


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # A dead client socket must not take a worker with it.
    allow_reuse_address = True
    request_queue_size = 64


def serve(host: str, port: int, device: Optional[str]) -> int:
    os.environ.setdefault("TORCH_HOME", str(DEFAULT_TORCH_HOME))
    pathlib.Path(os.environ["TORCH_HOME"]).mkdir(parents=True, exist_ok=True)

    print("[load] %s ..." % MODEL_VERSION, flush=True)
    embedder = LocalEigenPlaces(device)
    fetcher = ImageFetcher()

    handler = type(
        "BoundHandler",
        (Handler,),
        {
            "embedder": embedder,
            "fetcher": fetcher,
            "auth_secret": os.environ.get("LANTAGE_INFERENCE_SECRET", ""),
        },
    )

    try:
        httpd = Server((host, port), handler)
    except OSError as exc:
        # Port 8000 is a popular default and something else on this laptop may
        # already own it. Say so instead of leaving a stack trace, because the
        # fix is one flag.
        fetcher.close()
        raise SystemExit(
            "could not bind %s:%d (%s). Something else is listening — check with "
            "`lsof -nP -iTCP:%d -sTCP:LISTEN`. Start on another port with "
            "`--port 8010`, then point the client at it: "
            "`INFERENCE_SERVICE_URL=http://127.0.0.1:8010` for embed_index.py, "
            "`LANTAGE_LOCAL_EMBED_URL=http://127.0.0.1:8010` for the app."
            % (host, port, exc, port)
        ) from exc

    with httpd:
        print(
            "[ready] %s on http://%s:%d  device=%s  dim=%d  input=%dx%d  loadMs=%.0f"
            % (
                MODEL_VERSION,
                host,
                port,
                embedder.device,
                MODEL_DIM,
                EIGENPLACES_INPUT_SIZE,
                EIGENPLACES_INPUT_SIZE,
                embedder.load_ms,
            ),
            flush=True,
        )
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n[stop] shutting down", flush=True)
        finally:
            fetcher.close()
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="local_server", description=__doc__)
    ap.add_argument("--host", default=os.environ.get("LANTAGE_LOCAL_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("LANTAGE_LOCAL_PORT", "8000")))
    ap.add_argument(
        "--device",
        default=os.environ.get("LANTAGE_LOCAL_DEVICE") or None,
        choices=("cpu", "mps", "cuda"),
        help="default: mps if available, else cpu",
    )
    args = ap.parse_args(argv)
    return serve(args.host, args.port, args.device)


if __name__ == "__main__":
    sys.exit(main())
