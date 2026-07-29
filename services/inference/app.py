"""
Lantage GPU embedding service — Modal app.

Contract: `src/lib/contracts/schemas.ts` → `EmbedRequestSchema` / `EmbedResponseSchema`.
Consumed by B2 (cascade orchestrator). The camelCase field names below are not a
style choice; they are the wire contract and must match the Zod schema exactly.

--------------------------------------------------------------------------------
WHY CONTAINER REUSE IS THE WHOLE POINT OF THIS FILE
--------------------------------------------------------------------------------
Per MASTER_PLAN §6, an L4 at $0.80/hr that stays warm amortises to ~$0.02–0.05
per 1,000 searches. The same workload on scale-to-zero, where a container lives
for one request, costs ~$1.10 per 1,000 — a 20–50x penalty, because you pay the
model-load time (tens of seconds of GPU) on every single request and throw the
loaded weights away.

Three mechanisms defend against that, and all three matter:

  1. `min_containers=1` — the floor never returns to zero, so the steady-state
     search never pays a cold start at all. This is the $576/mo line item in §6.
  2. `scaledown_window` — generous (default 300s) so a burst that briefly
     exceeds the warm floor does not immediately discard the extra containers
     and re-pay their load cost on the next burst.
  3. `@modal.enter()` — weights load once per container lifetime. Nothing in the
     request path may ever call a `from_pretrained` / `torch.hub.load`. If you
     find yourself loading a model inside a route handler, you have just
     reintroduced the 20-50x cost.

And the fourth, which is about the *numerator* rather than the denominator:
`@modal.concurrent` lets one container interleave several requests. For our
payload sizes, image fetch + JPEG decode is a meaningful share of wall time and
is pure I/O. Overlapping that across requests raises GPU utilisation without
extra containers. GPU compute itself is serialised behind `_gpu_lock` so peak
VRAM stays bounded and predictable.

Set `LANTAGE_MIN_CONTAINERS=0` at deploy time to get the cheap-but-slow
development posture (§6: "Drop Modal to on-demand during pre-revenue
development and fixed cost falls to ~$270/mo"). `bench.py` uses that to measure
a genuine cold start.

--------------------------------------------------------------------------------
DAUBERT / REPRODUCIBILITY
--------------------------------------------------------------------------------
Every returned embedding carries a `version` string, which B2 propagates into
`ResultProvenance.models`. That is a §0 evidentiary requirement, not
bookkeeping: a result offered in court has to be reproducible, and the exact
weights that produced it have to be discoverable years later. Consequences that
look like over-engineering but are not:

  - Inference runs in fp32 by default. fp16 would be faster but makes bitwise
    reproduction depend on the GPU model that happened to serve the request.
  - Weights are baked into the image at build time (see `_download_weights`), so
    a redeploy cannot silently pick up a new upstream checkpoint.
  - `/health` reports the resolved model versions, dims, precision and GPU so a
    discovery response can be answered from the service itself.

Bump the `@x.y` suffix in `MODEL_REGISTRY` whenever weights or preprocessing
change. A preprocessing change is a model change as far as retrieval is
concerned.
"""

from __future__ import annotations

import base64
import binascii
import hmac
import os
import pathlib
import threading
import time
from datetime import datetime, timezone
from typing import Annotated, Any, Literal, Optional

import modal

# ---------------------------------------------------------------------------
# Identity and deploy-time configuration
# ---------------------------------------------------------------------------

APP_NAME = "lantage-inference"
SERVICE_VERSION = "0.1.0"

_HERE = pathlib.Path(__file__).parent


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return int(raw)


# Read at DEPLOY time (this module executes locally during `modal deploy`), which
# is what lets one file express both the warm production posture and the
# scale-to-zero development posture without editing code.
GPU_TYPE = os.environ.get("LANTAGE_GPU", "L4")
MIN_CONTAINERS = _env_int("LANTAGE_MIN_CONTAINERS", 1)
BUFFER_CONTAINERS = _env_int("LANTAGE_BUFFER_CONTAINERS", 0)
SCALEDOWN_WINDOW = _env_int("LANTAGE_SCALEDOWN_WINDOW", 300)
MAX_CONTAINERS = _env_int("LANTAGE_MAX_CONTAINERS", 4)
FUNCTION_TIMEOUT = _env_int("LANTAGE_TIMEOUT", 600)

# Concurrency: `target_inputs` is what the autoscaler aims for, `max_inputs` the
# hard ceiling before a new container is provisioned. Kept modest because GPU
# work is serialised anyway; the win here is overlapping image I/O, not
# oversubscribing the L4.
MAX_CONCURRENT_INPUTS = _env_int("LANTAGE_MAX_CONCURRENT_INPUTS", 8)
TARGET_CONCURRENT_INPUTS = _env_int("LANTAGE_TARGET_CONCURRENT_INPUTS", 4)

# How many images go to the GPU in one forward pass.
GPU_BATCH_SIZE = _env_int("LANTAGE_GPU_BATCH_SIZE", 8)
# Ceiling on `/embed_batch` request size, to bound VRAM and response payload.
MAX_BATCH_IMAGES = _env_int("LANTAGE_MAX_BATCH_IMAGES", 64)

MODAL_SECRET_NAME = os.environ.get("LANTAGE_MODAL_SECRET", "lantage-inference")

AUTH_HEADER_NAME = "X-Lantage-Inference-Key"
MAX_IMAGE_BYTES = 25 * 1024 * 1024
IMAGE_FETCH_TIMEOUT_S = 15.0

ModelName = Literal["geoclip", "eigenplaces", "megaloc", "dinov2"]
ALL_MODELS: tuple[str, ...] = ("geoclip", "eigenplaces", "megaloc", "dinov2")

# Restrict the loaded set during development to save VRAM and build time.
# Production loads all four.
_requested = os.environ.get("LANTAGE_MODELS", "").strip()
ENABLED_MODELS: tuple[str, ...] = (
    tuple(m.strip() for m in _requested.split(",") if m.strip()) if _requested else ALL_MODELS
)
for _m in ENABLED_MODELS:
    if _m not in ALL_MODELS:
        raise ValueError(f"LANTAGE_MODELS contains unknown model {_m!r}; valid: {ALL_MODELS}")


# ---------------------------------------------------------------------------
# Model registry — dims, versions, and the role each model plays in the cascade
# ---------------------------------------------------------------------------

MODEL_REGISTRY: dict[str, dict[str, Any]] = {
    "geoclip": {
        "version": "geoclip-vitl14-512@1.0",
        "dim": 512,
        "role": "cascade stage [1] — cheap coarse prior + GPS-gallery hypothesis",
        "license": "MIT (code). Backbone: openai/clip-vit-large-patch14.",
    },
    "eigenplaces": {
        "version": "eigenplaces-r50-512@1.0",
        "dim": 512,
        "role": "cascade stage [3] — PRIMARY retrieval descriptor, HNSW-indexed",
        "license": "MIT — Berton, Trivigno, Masone, Caputo (2023). Trained on SF-XL.",
    },
    "dinov2": {
        "version": "dinov2-vitl14-1024@1.0",
        "dim": 1024,
        "role": "VEHICLE (§4) and CLAIM (§8) near-duplicate retrieval",
        "license": "Apache-2.0 — Meta AI.",
    },
    # ---------------------------------------------------------------------
    # MegaLoc is RE-RANK ONLY. It must never become the primary descriptor,
    # and the reason is not a preference — it is three hard constraints, per
    # MASTER_PLAN §3 ("Three decisions that are expensive to reverse", #1):
    #
    #   1. pgvector's HNSW index has a hard 2,000-dimension limit. At 8,448-d
    #      MegaLoc cannot be HNSW-indexed AT ALL, so it physically cannot back
    #      the retrieval index. Nothing about tuning changes this.
    #   2. ~2.80 s/image versus EigenPlaces' ~0.13 s — 21x. That single stage
    #      would consume most of the 3-8 s end-to-end budget.
    #   3. 33.8 GB vs 2.0 GB per 1M vectors fp32 — 16.5x the storage, which
    #      moves one metro off Supabase XL entirely.
    #
    # MegaLoc is genuinely the stronger model in isolation (SOTA on Tokyo24/7,
    # 97.1% R@1) and EigenPlaces-512 still beat BoQ-16384 in the VLM-guided-VPR
    # ablation, so the small descriptor winning is an established result, not a
    # compromise. Use MegaLoc on the top ~50 candidates only, and only once
    # BENCH (D1) shows the re-rank actually buys accuracy.
    # ---------------------------------------------------------------------
    "megaloc": {
        "version": "megaloc-8448@1.0",
        "dim": 8448,
        "role": "cascade stage [4] — RE-RANK ONLY on top-k; never the index",
        "license": "MIT — Berton, Masone (2024).",
    },
}


# ---------------------------------------------------------------------------
# Image: dependencies, and weights baked in at build time
# ---------------------------------------------------------------------------

# Mirrors requirements.txt. Kept inline because Modal only ships .py files into
# the container by default, so the container-side re-import of this module must
# not depend on requirements.txt existing. `_assert_requirements_in_sync()`
# below makes the duplication safe: it fires at deploy time (where the file does
# exist) and is skipped in the container.
PIP_PACKAGES: tuple[str, ...] = (
    "torch==2.5.1",
    "torchvision==0.20.1",
    "transformers>=4.44,<5",
    "huggingface_hub>=0.25,<1",
    "safetensors>=0.4,<1",
    "geoclip",  # TODO(B1): pin exact version after the first successful build.
    "pillow>=10.4,<12",
    "numpy>=1.26,<3",
    "fastapi>=0.115,<1",
    "pydantic>=2.9,<3",
    "httpx>=0.27,<1",
)


def _assert_requirements_in_sync() -> None:
    """Fail loudly at deploy time if requirements.txt has drifted from PIP_PACKAGES."""
    req = _HERE / "requirements.txt"
    if not req.exists():  # running inside the container; nothing to check
        return
    declared = set()
    for line in req.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if line and not line.startswith("-"):
            declared.add(line)
    if declared != set(PIP_PACKAGES):
        missing = sorted(set(PIP_PACKAGES) - declared)
        extra = sorted(declared - set(PIP_PACKAGES))
        raise RuntimeError(
            "requirements.txt is out of sync with PIP_PACKAGES in app.py.\n"
            f"  only in app.py:          {missing}\n"
            f"  only in requirements.txt: {extra}"
        )


_assert_requirements_in_sync()


# Weights live inside the image, not on a Volume and not fetched at runtime.
# A cold start that has to pull CLIP ViT-L/14 + DINOv2-L + MegaLoc from
# HuggingFace adds tens of seconds and makes cold-start cost unpredictable;
# baking them in makes the cold path deterministic and, per the note above,
# freezes the checkpoint so a redeploy cannot silently change the model that
# produced a result already in an Evidence Ledger.
MODEL_CACHE_DIR = "/opt/lantage-models"
_IMAGE_ENV = {
    "HF_HOME": f"{MODEL_CACHE_DIR}/hf",
    "TORCH_HOME": f"{MODEL_CACHE_DIR}/torch",
    # Deterministic-ish tokenizer behaviour and no telemetry from the hot path.
    "TOKENIZERS_PARALLELISM": "false",
    "HF_HUB_DISABLE_TELEMETRY": "1",
}


def _hub_load(repo: str, entrypoint: str, **kwargs: Any):
    """Load a torch.hub entrypoint, preferring the copy already baked into the image.

    At runtime we must not touch GitHub: `torch.hub.load(..., source="github")`
    hits the GitHub API for repo validation even when the checkout is cached,
    which turns a network blip into a failed search. So look for the cached
    checkout under TORCH_HOME and load it with `source="local"`, and only fall
    back to the network path (build time, or a cache miss) with validation off.
    """
    import torch

    slug = repo.split("/")[-1].lower()
    hub_dir = pathlib.Path(torch.hub.get_dir())
    if hub_dir.is_dir():
        for candidate in sorted(hub_dir.iterdir()):
            # torch.hub names the checkout "<owner>_<repo>_<ref>", but that is an
            # implementation detail, so match on the repo slug instead of
            # reconstructing the name.
            if candidate.is_dir() and slug in candidate.name.lower():
                return torch.hub.load(str(candidate), entrypoint, source="local", **kwargs)
    return torch.hub.load(repo, entrypoint, trust_repo=True, skip_validation=True, **kwargs)


# --- Per-model loaders. Shared by the build-time downloader and @modal.enter. ---
#
# Every entrypoint below was verified against the upstream repo rather than
# written from memory:
#   gmberton/EigenPlaces  hubconf.py -> get_trained_model(backbone="ResNet50",
#                         fc_output_dim=2048); ResNet50 accepts fc_output_dim in
#                         {128, 256, 512, 2048}, so 512 is a supported config.
#   gmberton/MegaLoc      hubconf.py -> get_trained_model() (no args), 8448-d.
#   facebookresearch/dinov2 hubconf.py -> dinov2_vitl14, 1024-d CLS token.
#   VicenteVivan/geo-clip  GeoCLIP(from_pretrained=True, queue_size=4096).


def _load_geoclip():
    from geoclip import GeoCLIP

    return GeoCLIP()


def _load_eigenplaces():
    return _hub_load(
        "gmberton/eigenplaces",
        "get_trained_model",
        backbone="ResNet50",
        fc_output_dim=512,
    )


def _load_megaloc():
    return _hub_load("gmberton/MegaLoc", "get_trained_model")


def _load_dinov2():
    return _hub_load("facebookresearch/dinov2", "dinov2_vitl14")


_LOADERS = {
    "geoclip": _load_geoclip,
    "eigenplaces": _load_eigenplaces,
    "megaloc": _load_megaloc,
    "dinov2": _load_dinov2,
}


def _download_weights() -> None:
    """Build-time: instantiate every model so its weights land in the image layer."""
    import torch

    for name in ENABLED_MODELS:
        started = time.perf_counter()
        model = _LOADERS[name]()
        # Touch the parameters so lazily-materialised weights are real.
        n_params = sum(p.numel() for p in model.parameters())
        del model
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        print(
            f"[build] {name}: {n_params / 1e6:.1f}M params "
            f"in {time.perf_counter() - started:.1f}s"
        )


image = (
    modal.Image.debian_slim(python_version="3.11")
    # git: torch.hub clones the model repos. libgl/libglib: Pillow/OpenCV-style
    # image decode paths in transformers.
    .apt_install("git", "libgl1", "libglib2.0-0")
    .env(_IMAGE_ENV)
    .pip_install(*PIP_PACKAGES)
    # Weights snapshot. `force_build=True` is deliberately NOT set: the layer is
    # content-addressed on the package set above, so pinning deps pins weights.
    .run_function(_download_weights, timeout=60 * 60)
)

app = modal.App(APP_NAME)


# ---------------------------------------------------------------------------
# Preprocessing constants
# ---------------------------------------------------------------------------

IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)

# EigenPlaces' own test transform (datasets/test_dataset.py) is ToTensor +
# ImageNet normalise with NO resize — the network is fully convolutional with GeM
# pooling, so it accepts any input size. We must pick a fixed size anyway to
# batch on the GPU. 512 matches the paper's training crop.
#
# IMPORTANT: this size is part of the descriptor's identity. The index and the
# query MUST be embedded at the same size or recall collapses silently. If BENCH
# (D1) sweeps it and picks a different value, bump `eigenplaces` to @1.1 and
# rebuild the index — do not change it in place.
EIGENPLACES_INPUT_SIZE = _env_int("LANTAGE_EIGENPLACES_SIZE", 512)

# MegaLoc's README specifies 322x322 with ImageNet normalisation.
MEGALOC_INPUT_SIZE = 322

# DINOv2 patch size is 14, so the input side must be a multiple of 14.
# 224 = 16 x 14, the standard eval resolution.
DINOV2_RESIZE = 256
DINOV2_CROP = 224


# ---------------------------------------------------------------------------
# The service
# ---------------------------------------------------------------------------


@app.cls(
    image=image,
    gpu=GPU_TYPE,
    secrets=[modal.Secret.from_name(MODAL_SECRET_NAME)],
    min_containers=MIN_CONTAINERS,
    buffer_containers=BUFFER_CONTAINERS,
    scaledown_window=SCALEDOWN_WINDOW,
    max_containers=MAX_CONTAINERS,
    timeout=FUNCTION_TIMEOUT,
)
@modal.concurrent(max_inputs=MAX_CONCURRENT_INPUTS, target_inputs=TARGET_CONCURRENT_INPUTS)
class Embedder:
    """One container, all models resident, many requests.

    Nothing in this class may load a model outside `enter()`.
    """

    # -- container lifecycle -------------------------------------------------

    @modal.enter()
    def enter(self) -> None:
        import torch
        import torchvision.transforms as T

        self._t0 = time.time()
        self._started_at = datetime.now(timezone.utc).isoformat()
        self._requests_served = 0
        self._images_embedded = 0
        # GPU compute is serialised. Image fetch and decode are not — that
        # asymmetry is exactly what makes @modal.concurrent worth having.
        self._gpu_lock = threading.Lock()
        self._counter_lock = threading.Lock()

        # Fail fast and loudly if the shared secret was not injected: a service
        # that silently starts without its auth material is worse than one that
        # refuses to start. See also `_require_auth`, which refuses every request
        # in that state rather than falling open.
        self._auth_secret = os.environ.get("LANTAGE_INFERENCE_SECRET", "")
        if not self._auth_secret:
            print(
                "[FATAL-CONFIG] LANTAGE_INFERENCE_SECRET absent from Modal secret "
                f"{MODAL_SECRET_NAME!r}. Every request will be rejected with 503."
            )

        self.torch = torch
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        # fp32 for reproducibility — see the module docstring.
        self.dtype = torch.float32
        self.precision = "fp32"

        self.models: dict[str, Any] = {}
        self.load_ms: dict[str, float] = {}
        self.load_errors: dict[str, str] = {}

        for name in ENABLED_MODELS:
            started = time.perf_counter()
            try:
                model = _LOADERS[name]()
                model = model.eval().to(self.device, dtype=self.dtype)
                for p in model.parameters():
                    p.requires_grad_(False)
                self.models[name] = model
                self.load_ms[name] = (time.perf_counter() - started) * 1000.0
                print(f"[enter] {name} ready in {self.load_ms[name]:.0f}ms")
            except Exception as exc:  # noqa: BLE001 - one bad model must not kill the rest
                self.load_errors[name] = f"{type(exc).__name__}: {exc}"
                print(f"[enter] {name} FAILED: {self.load_errors[name]}")

        # Preprocessing pipelines, built once.
        self._tf = {
            "eigenplaces": T.Compose(
                [
                    T.Resize(
                        (EIGENPLACES_INPUT_SIZE, EIGENPLACES_INPUT_SIZE),
                        interpolation=T.InterpolationMode.BICUBIC,
                    ),
                    T.ToTensor(),
                    T.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD),
                ]
            ),
            "megaloc": T.Compose(
                [
                    T.Resize(
                        (MEGALOC_INPUT_SIZE, MEGALOC_INPUT_SIZE),
                        interpolation=T.InterpolationMode.BICUBIC,
                    ),
                    T.ToTensor(),
                    T.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD),
                ]
            ),
            "dinov2": T.Compose(
                [
                    T.Resize(DINOV2_RESIZE, interpolation=T.InterpolationMode.BICUBIC),
                    T.CenterCrop(DINOV2_CROP),
                    T.ToTensor(),
                    T.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD),
                ]
            ),
        }

        self._prepare_geoclip_gallery()

        # Shared HTTP client so batch URL fetches reuse connections.
        import httpx

        self._http = httpx.Client(
            timeout=IMAGE_FETCH_TIMEOUT_S,
            follow_redirects=True,
            limits=httpx.Limits(max_connections=16, max_keepalive_connections=8),
        )

        from PIL import Image as PILImage

        # Decompression-bomb guard. Default is ~89MP; ours is tighter because a
        # real case photo never needs to be larger.
        PILImage.MAX_IMAGE_PIXELS = 64_000_000

        self._warm_up()

    def _prepare_geoclip_gallery(self) -> None:
        """Precompute the normalised GPS-gallery embeddings once.

        GeoCLIP's own `predict()` re-encodes all ~100k gallery coordinates on
        every call and only accepts a filesystem path. Both are unusable here, so
        we cache the location features at container start and score against them
        with a matmul. That turns the geoPrior from a six-figure-FLOP encode per
        request into one 512 x 100k matmul.

        ADAPTER: this reaches into GeoCLIP's attributes (`gps_gallery`,
        `location_encoder`, `logit_scale`), verified against
        VicenteVivan/geo-clip's GeoCLIP.py. If upstream renames them, we fall
        back to the slow-but-public `forward(image, gps_gallery)` path rather
        than returning a wrong prior.
        """
        self._geoclip_gallery = None
        self._geoclip_loc_feats = None
        self._geoclip_logit_scale = None
        self._geoclip_prior_mode = "unavailable"

        model = self.models.get("geoclip")
        if model is None:
            return

        torch = self.torch
        try:
            gallery = model.gps_gallery
            if not torch.is_tensor(gallery):
                gallery = torch.as_tensor(gallery)
            gallery = gallery.to(self.device, dtype=self.dtype)
            # no_grad, not inference_mode: the result is cached for the container's
            # whole life, and an inference-mode tensor cannot be used outside an
            # inference-mode block. no_grad gives an ordinary tensor.
            with torch.no_grad():
                loc = model.location_encoder(gallery)
                loc = torch.nn.functional.normalize(loc, dim=1)
            self._geoclip_gallery = gallery
            self._geoclip_loc_feats = loc
            self._geoclip_logit_scale = float(model.logit_scale.exp().item())
            self._geoclip_prior_mode = "cached-gallery"
            print(f"[enter] geoclip gallery cached: {tuple(loc.shape)}")
        except Exception as exc:  # noqa: BLE001
            self._geoclip_prior_mode = f"fallback-forward ({type(exc).__name__})"
            print(f"[enter] geoclip gallery cache unavailable, using forward(): {exc}")

    def _warm_up(self) -> None:
        """Run one throwaway forward per model.

        CUDA kernel autotuning, cuDNN algorithm selection and lazy module init all
        happen on first use. Paying that here rather than on a user request is the
        difference between the §6 latency numbers and a p99 that looks broken.
        """
        from PIL import Image as PILImage

        dummy = PILImage.new("RGB", (640, 480), (127, 127, 127))
        for name in list(self.models):
            try:
                started = time.perf_counter()
                self._forward(name, [dummy])
                print(f"[enter] {name} warm-up {(time.perf_counter() - started) * 1000:.0f}ms")
            except Exception as exc:  # noqa: BLE001
                print(f"[enter] {name} warm-up failed: {type(exc).__name__}: {exc}")

    @modal.exit()
    def exit(self) -> None:
        client = getattr(self, "_http", None)
        if client is not None:
            client.close()

    # -- GPU paths ----------------------------------------------------------

    def _preprocess(self, name: str, pils: list[Any]):
        torch = self.torch
        if name == "geoclip":
            # CLIP's own processor: resize 224 shortest side, center crop,
            # CLIP-specific mean/std. Do not substitute ImageNet stats here.
            processor = self.models["geoclip"].image_encoder.image_processor
            batch = processor(images=pils, return_tensors="pt")["pixel_values"]
            return batch.to(self.device, dtype=self.dtype)
        tf = self._tf[name]
        return torch.stack([tf(p) for p in pils]).to(self.device, dtype=self.dtype)

    def _forward(self, name: str, pils: list[Any]) -> tuple[list[list[float]], Optional[list[list[dict]]]]:
        """Embed `pils` with one model. Returns (vectors, geoPrior-per-image or None)."""
        torch = self.torch
        model = self.models[name]
        vectors: list[list[float]] = []
        priors: Optional[list[list[dict]]] = [] if name == "geoclip" else None

        for start in range(0, len(pils), GPU_BATCH_SIZE):
            chunk = pils[start : start + GPU_BATCH_SIZE]
            batch = self._preprocess(name, chunk)

            with self._gpu_lock, torch.inference_mode():
                if name == "geoclip":
                    feats = model.image_encoder(batch)
                else:
                    feats = model(batch)

                # DINOv2 returns an unnormalised CLS token; the VPR models
                # already end in an L2Norm. Normalising unconditionally is
                # idempotent for the latter and REQUIRED for the former —
                # Postgres uses cosine distance and assumes unit vectors, so an
                # unnormalised vector reaching the index is a silent
                # wrong-ranking bug, not an error.
                feats = torch.nn.functional.normalize(feats.float(), dim=-1)

                if name == "geoclip":
                    priors.extend(self._geoclip_prior(feats))

                vectors.extend(feats.cpu().tolist())

        return vectors, priors

    def _geoclip_prior(self, image_feats, top_k: int = 5) -> list[list[dict]]:
        """Top-k GPS-gallery hypotheses per image, as EmbedResponse.geoPrior.

        Scores are softmax probabilities over the ~100k-point gallery. They are
        the model's self-report and are recalibrated downstream (§3 stage [1]);
        never surface them to a user as a confidence.
        """
        torch = self.torch
        out: list[list[dict]] = []

        if self._geoclip_loc_feats is not None:
            logits = self._geoclip_logit_scale * (image_feats @ self._geoclip_loc_feats.T)
            gallery = self._geoclip_gallery
        else:
            # Public-API fallback: re-encode the gallery every call.
            model = self.models["geoclip"]
            gallery = model.gps_gallery.to(self.device, dtype=self.dtype)
            loc = torch.nn.functional.normalize(model.location_encoder(gallery), dim=1)
            logits = float(model.logit_scale.exp().item()) * (image_feats @ loc.T)

        probs = logits.softmax(dim=-1)
        k = min(top_k, probs.shape[-1])
        top = torch.topk(probs, k, dim=-1)
        for row in range(probs.shape[0]):
            coords = gallery[top.indices[row]].cpu().tolist()
            scores = top.values[row].cpu().tolist()
            out.append(
                [
                    {"lat": float(c[0]), "lon": float(c[1]), "score": float(s)}
                    for c, s in zip(coords, scores)
                ]
            )
        return out

    # -- web app ------------------------------------------------------------

    @modal.asgi_app()
    def web(self):
        from fastapi import Depends, FastAPI, Header, HTTPException
        from pydantic import BaseModel, ConfigDict, Field, model_validator

        def _require_auth(
            provided: Optional[str] = Header(default=None, alias=AUTH_HEADER_NAME),
        ) -> None:
            """Shared-secret gate. Fails closed.

            A Modal web endpoint is a public HTTPS URL, so this header is the
            only thing between the open internet and our GPU budget. Two rules:
            a missing server-side secret returns 503 (never 200), and the
            comparison is constant-time.
            """
            if not self._auth_secret:
                raise HTTPException(
                    status_code=503,
                    detail=(
                        "inference service misconfigured: LANTAGE_INFERENCE_SECRET "
                        f"missing from Modal secret {MODAL_SECRET_NAME!r}"
                    ),
                )
            if not provided or not hmac.compare_digest(provided, self._auth_secret):
                raise HTTPException(
                    status_code=401, detail=f"missing or invalid {AUTH_HEADER_NAME}"
                )

        # Auth is attached to the app, not to individual routes, so a route
        # added later cannot accidentally ship unauthenticated. /health included.
        api = FastAPI(
            title="Lantage inference",
            version=SERVICE_VERSION,
            dependencies=[Depends(_require_auth)],
        )

        # -- wire models: mirror src/lib/contracts/schemas.ts exactly ---------

        class _Src(BaseModel):
            model_config = ConfigDict(protected_namespaces=())
            imageUrl: Optional[str] = None
            imageBase64: Optional[str] = None

            @model_validator(mode="after")
            def _one_of(self):
                if not self.imageUrl and not self.imageBase64:
                    raise ValueError("one of imageUrl or imageBase64 is required")
                return self

        class EmbedRequest(_Src):
            models: Annotated[list[ModelName], Field(min_length=1)]

        class EmbedBatchRequest(BaseModel):
            model_config = ConfigDict(protected_namespaces=())
            images: Annotated[list[_Src], Field(min_length=1, max_length=MAX_BATCH_IMAGES)]
            models: Annotated[list[ModelName], Field(min_length=1)]

        class EmbeddingOut(BaseModel):
            model_config = ConfigDict(protected_namespaces=())
            vector: list[float]
            dim: int
            model: str
            version: str

        class GeoPriorPoint(BaseModel):
            lat: float
            lon: float
            score: float

        class EmbedResponse(BaseModel):
            model_config = ConfigDict(protected_namespaces=())
            embeddings: dict[str, EmbeddingOut]
            geoPrior: Optional[list[GeoPriorPoint]] = None
            tookMs: float

        class EmbedBatchResponse(BaseModel):
            model_config = ConfigDict(protected_namespaces=())
            results: list[EmbedResponse]
            tookMs: float

        # -- image loading ---------------------------------------------------

        def _decode(raw: bytes):
            from PIL import Image as PILImage, UnidentifiedImageError
            import io

            if len(raw) > MAX_IMAGE_BYTES:
                raise HTTPException(413, f"image exceeds {MAX_IMAGE_BYTES} bytes")
            try:
                img = PILImage.open(io.BytesIO(raw))
                img.load()
            except PILImage.DecompressionBombError as exc:
                raise HTTPException(413, f"image too large to decode: {exc}") from exc
            except (UnidentifiedImageError, OSError) as exc:
                raise HTTPException(400, f"could not decode image: {exc}") from exc
            return img.convert("RGB")

        class _TooLarge(Exception):
            """Distinguishes an over-cap body from a network failure (413 vs 502)."""

        def _fetch_bytes(url: str) -> bytes:
            """Stream with a hard byte cap.

            Streaming rather than `.get()` so the cap is actually enforced: a
            response with no content-length, or a lying one, would otherwise be
            buffered in full before we ever got to check it.
            """
            with self._http.stream("GET", url) as resp:
                resp.raise_for_status()
                declared = resp.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > MAX_IMAGE_BYTES:
                    raise _TooLarge()
                buf = bytearray()
                for chunk in resp.iter_bytes(chunk_size=65536):
                    buf += chunk
                    if len(buf) > MAX_IMAGE_BYTES:
                        raise _TooLarge()
                return bytes(buf)

        def _fetch(src: _Src):
            if src.imageBase64:
                payload = src.imageBase64
                if payload.startswith("data:"):
                    _, _, payload = payload.partition(",")
                try:
                    raw = base64.b64decode(payload, validate=True)
                except (binascii.Error, ValueError) as exc:
                    raise HTTPException(400, f"imageBase64 is not valid base64: {exc}") from exc
                return _decode(raw)

            url = src.imageUrl or ""
            # http(s) only. The orchestrator hands us short-lived signed Supabase
            # URLs; the shared secret is what keeps arbitrary-URL fetch from being
            # an open SSRF proxy, so do not relax the auth on these routes.
            if not url.lower().startswith(("http://", "https://")):
                raise HTTPException(400, "imageUrl must be an http(s) URL")
            try:
                raw = _fetch_bytes(url)
            except _TooLarge as exc:
                raise HTTPException(413, f"image exceeds {MAX_IMAGE_BYTES} bytes") from exc
            except Exception as exc:  # noqa: BLE001 - httpx raises many shapes
                raise HTTPException(502, f"could not fetch imageUrl: {type(exc).__name__}") from exc
            return _decode(raw)

        def _fetch_all(sources: list[_Src]) -> list[Any]:
            if len(sources) == 1:
                return [_fetch(sources[0])]
            from concurrent.futures import ThreadPoolExecutor

            with ThreadPoolExecutor(max_workers=min(8, len(sources))) as pool:
                return list(pool.map(_fetch, sources))

        def _check_models(requested: list[str]) -> None:
            unavailable = [m for m in requested if m not in self.models]
            if unavailable:
                detail = {
                    m: self.load_errors.get(m, "not enabled on this deployment")
                    for m in unavailable
                }
                raise HTTPException(503, {"unavailableModels": detail})

        def _embed(pils: list[Any], model_names: list[str]):
            """Returns (per-model vectors, per-image geoPrior or None)."""
            vectors: dict[str, list[list[float]]] = {}
            priors: Optional[list[list[dict]]] = None
            # Deterministic order so identical requests do identical work.
            for name in sorted(set(model_names)):
                vecs, pr = self._forward(name, pils)
                vectors[name] = vecs
                if pr is not None:
                    priors = pr
            return vectors, priors

        def _pack(
            vectors: dict[str, list[list[float]]],
            priors: Optional[list[list[dict]]],
            index: int,
            took_ms: float,
        ) -> EmbedResponse:
            embeddings = {}
            for name, rows in vectors.items():
                meta = MODEL_REGISTRY[name]
                vec = rows[index]
                if len(vec) != meta["dim"]:
                    # A dim mismatch means the weights or the entrypoint changed
                    # underneath us. Refuse rather than poison the index.
                    raise HTTPException(
                        500,
                        f"{name} returned dim {len(vec)}, registry declares {meta['dim']}; "
                        "refusing to emit an embedding that cannot be indexed",
                    )
                embeddings[name] = EmbeddingOut(
                    vector=vec, dim=meta["dim"], model=name, version=meta["version"]
                )
            geo = (
                [GeoPriorPoint(**p) for p in priors[index]]
                if priors is not None and index < len(priors)
                else None
            )
            return EmbedResponse(embeddings=embeddings, geoPrior=geo, tookMs=took_ms)

        def _record(n_images: int) -> None:
            with self._counter_lock:
                self._requests_served += 1
                self._images_embedded += n_images

        # -- routes ----------------------------------------------------------

        @api.post("/embed", response_model=EmbedResponse)
        def embed(req: EmbedRequest) -> EmbedResponse:
            started = time.perf_counter()
            _check_models(req.models)
            pils = [_fetch(req)]
            vectors, priors = _embed(pils, list(req.models))
            took = (time.perf_counter() - started) * 1000.0
            _record(1)
            return _pack(vectors, priors, 0, took)

        @api.post("/embed_batch", response_model=EmbedBatchResponse)
        def embed_batch(req: EmbedBatchRequest) -> EmbedBatchResponse:
            started = time.perf_counter()
            _check_models(req.models)
            pils = _fetch_all(list(req.images))
            vectors, priors = _embed(pils, list(req.models))
            total = (time.perf_counter() - started) * 1000.0
            # Per-item tookMs is the amortised per-image cost, which is the number
            # that matters for the §6 budget. The true wall clock is top-level.
            per_image = total / max(1, len(pils))
            _record(len(pils))
            return EmbedBatchResponse(
                results=[_pack(vectors, priors, i, per_image) for i in range(len(pils))],
                tookMs=total,
            )

        @api.get("/health")
        def health() -> dict[str, Any]:
            torch = self.torch
            cuda = torch.cuda.is_available()
            gpu: dict[str, Any] = {"requested": GPU_TYPE, "cudaAvailable": cuda}
            if cuda:
                gpu["name"] = torch.cuda.get_device_name(0)
                gpu["capability"] = ".".join(str(x) for x in torch.cuda.get_device_capability(0))
                gpu["totalMemoryMb"] = round(
                    torch.cuda.get_device_properties(0).total_memory / 1e6
                )
                gpu["allocatedMemoryMb"] = round(torch.cuda.memory_allocated() / 1e6)

            models = {}
            for name in ALL_MODELS:
                meta = MODEL_REGISTRY[name]
                models[name] = {
                    "loaded": name in self.models,
                    "dim": meta["dim"],
                    "version": meta["version"],
                    "role": meta["role"],
                    "license": meta["license"],
                    "loadMs": round(self.load_ms.get(name, 0.0), 1),
                    "error": self.load_errors.get(name),
                }

            degraded = any(m not in self.models for m in ENABLED_MODELS)
            return {
                "status": "degraded" if degraded else "ok",
                "service": APP_NAME,
                "serviceVersion": SERVICE_VERSION,
                "gpu": gpu,
                "precision": self.precision,
                "models": models,
                "enabledModels": list(ENABLED_MODELS),
                "geoPriorMode": self._geoclip_prior_mode,
                "preprocessing": {
                    "eigenplacesInputSize": EIGENPLACES_INPUT_SIZE,
                    "megalocInputSize": MEGALOC_INPUT_SIZE,
                    "dinov2ResizeCrop": [DINOV2_RESIZE, DINOV2_CROP],
                },
                "container": {
                    "startedAt": self._started_at,
                    "uptimeSeconds": round(time.time() - self._t0, 1),
                    "taskId": os.environ.get("MODAL_TASK_ID"),
                    "requestsServed": self._requests_served,
                    "imagesEmbedded": self._images_embedded,
                },
                "scaling": {
                    "minContainers": MIN_CONTAINERS,
                    "bufferContainers": BUFFER_CONTAINERS,
                    "maxContainers": MAX_CONTAINERS,
                    "scaledownWindowSeconds": SCALEDOWN_WINDOW,
                    "maxConcurrentInputs": MAX_CONCURRENT_INPUTS,
                    "targetConcurrentInputs": TARGET_CONCURRENT_INPUTS,
                    "gpuBatchSize": GPU_BATCH_SIZE,
                    "maxBatchImages": MAX_BATCH_IMAGES,
                    # Surfaced so a monitor can alert on the expensive posture:
                    # min_containers=0 is 20-50x worse per search (§6).
                    "warmPosture": "warm" if MIN_CONTAINERS >= 1 else "scale-to-zero",
                },
            }

        return api


# ---------------------------------------------------------------------------
# Build verification
# ---------------------------------------------------------------------------


@app.function(image=image, gpu=GPU_TYPE, timeout=FUNCTION_TIMEOUT)
def selftest() -> dict[str, Any]:
    """Prove the image builds and every enabled model loads at its declared dim.

    Deliberately does NOT reuse `Embedder`: this runs in a throwaway container so
    it can be used as a pre-deploy gate without disturbing warm production
    containers. Latency measurement lives in bench.py.
    """
    import torch
    from PIL import Image as PILImage

    dummy = PILImage.new("RGB", (640, 480), (110, 120, 130))
    report: dict[str, Any] = {
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "torch": torch.__version__,
        "models": {},
    }
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    for name in ENABLED_MODELS:
        entry: dict[str, Any] = {"expectedDim": MODEL_REGISTRY[name]["dim"]}
        try:
            t0 = time.perf_counter()
            model = _LOADERS[name]().eval().to(device)
            entry["loadMs"] = round((time.perf_counter() - t0) * 1000, 1)

            if name == "geoclip":
                batch = model.image_encoder.image_processor(
                    images=[dummy], return_tensors="pt"
                )["pixel_values"].to(device)
                with torch.inference_mode():
                    feats = model.image_encoder(batch)
            else:
                import torchvision.transforms as T

                size = {
                    "eigenplaces": EIGENPLACES_INPUT_SIZE,
                    "megaloc": MEGALOC_INPUT_SIZE,
                    "dinov2": DINOV2_CROP,
                }[name]
                tf = T.Compose(
                    [
                        T.Resize((size, size), interpolation=T.InterpolationMode.BICUBIC),
                        T.ToTensor(),
                        T.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD),
                    ]
                )
                with torch.inference_mode():
                    feats = model(tf(dummy).unsqueeze(0).to(device))

            entry["actualDim"] = int(feats.shape[-1])
            entry["dimMatchesRegistry"] = entry["actualDim"] == entry["expectedDim"]
            normed = torch.nn.functional.normalize(feats.float(), dim=-1)
            entry["l2NormAfterNormalize"] = round(float(normed.norm(dim=-1)[0].item()), 6)
            del model
            torch.cuda.empty_cache()
        except Exception as exc:  # noqa: BLE001
            entry["error"] = f"{type(exc).__name__}: {exc}"
        report["models"][name] = entry

    return report


@app.local_entrypoint()
def main() -> None:
    """`modal run services/inference/app.py`"""
    import json

    print(json.dumps(selftest.remote(), indent=2))
