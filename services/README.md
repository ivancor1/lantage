# Lantage services

Out-of-process services that Next.js calls over HTTP. Everything here is Python;
nothing here imports from `src/`.

| Service | Path | What it is | Owner |
|---|---|---|---|
| **Inference** | `services/inference/` | Modal app, warm L4, GPU embeddings for GEO / STREET / VEHICLE / CLAIM | B1 — documented below |
| **Harvest** | `services/harvest/` | Mapillary bbox ingest for the metro street index (§11 B3) | B3 |

The harvest service calls this service's `/embed_batch` to embed what it ingests,
so the two share the `eigenplaces` version string and, critically, the same
`EIGENPLACES_INPUT_SIZE`. See "Reproducibility" below for why that coupling is
load-bearing.

---

## Inference service

`services/inference/app.py` exposes a FastAPI app on Modal serving four models
from one warm container. The HTTP contract is
`EmbedRequestSchema` / `EmbedResponseSchema` in `src/lib/contracts/schemas.ts` —
that file is the source of truth, and the camelCase field names in `app.py`
mirror it deliberately.

### Models

| Key | Model | Dim | Version string | Role in the cascade (§3) |
|---|---|---|---|---|
| `eigenplaces` | EigenPlaces ResNet-50 | **512** | `eigenplaces-r50-512@1.0` | **Stage [3] — primary retrieval descriptor** |
| `geoclip` | GeoCLIP (CLIP ViT-L/14 + GPS gallery) | 512 | `geoclip-vitl14-512@1.0` | Stage [1] — cheap coarse prior, plus `geoPrior` |
| `dinov2` | DINOv2 ViT-L/14 | 1024 | `dinov2-vitl14-1024@1.0` | VEHICLE (§4), CLAIM (§8) |
| `megaloc` | MegaLoc | 8448 | `megaloc-8448@1.0` | Stage [4] — **re-rank only** |

**Why MegaLoc is not the primary descriptor**, despite being the stronger model in
isolation (SOTA on Tokyo24/7, 97.1% R@1) — three constraints, per §3:

1. **pgvector's HNSW index has a hard 2,000-dimension limit.** At 8,448-d MegaLoc
   cannot be HNSW-indexed *at all*. This is not a tuning problem; it means MegaLoc
   physically cannot back the retrieval index.
2. **~2.80 s/image vs EigenPlaces' ~0.13 s** — 21×. One stage would eat most of the
   3–8 s end-to-end budget.
3. **33.8 GB vs 2.0 GB per 1M vectors** (fp32) — 16.5× the storage, which moves one
   metro off Supabase XL.

EigenPlaces-512 also beat BoQ-16384 in the VLM-guided-VPR ablation, so the small
descriptor winning is an established result rather than a concession. Use MegaLoc
on the top ~50 candidates only, and only once BENCH (D1) shows the re-rank buys
accuracy worth 2.8 s.

### Endpoints

All routes require the `X-Lantage-Inference-Key` header. Auth is attached to the
FastAPI app itself, not to individual routes, so a route added later cannot ship
unauthenticated. `/health` is included — a Modal web endpoint is a public HTTPS
URL, and this header is the only gate in front of the GPU budget.

| Route | Body | Notes |
|---|---|---|
| `POST /embed` | `EmbedRequestSchema` | Single image. Returns `EmbedResponseSchema`. |
| `POST /embed_batch` | `{images: [{imageUrl\|imageBase64}], models: [...]}` | Up to 64 images. Per-item `tookMs` is the amortised per-image cost; top-level `tookMs` is wall clock. |
| `GET /health` | — | Loaded models with dims/versions/licences, GPU name and VRAM, precision, container uptime, and the live scaling posture. |

**Every returned vector is L2-normalised.** DINOv2 emits an unnormalised CLS
token; the three VPR models already end in an L2Norm. Normalisation is applied
unconditionally because the Postgres side uses cosine distance and assumes unit
vectors — an unnormalised vector reaching the index is a silent wrong-ranking
bug, not an error. `bench.py` asserts unit norm and treats a violation as a hard
failure.

MegaLoc responses are large: 8,448 floats is roughly 170 KB of JSON per image.
Request it only for the candidates you are actually re-ranking.

---

## Deploying

Nothing here has been deployed yet. There is no Modal account configured on this
machine, so the steps below are unrun.

### 1. Install and authenticate

```bash
pip install modal
modal setup            # opens a browser, writes ~/.modal.toml
```

### 2. Create the shared secret

```bash
openssl rand -hex 32   # copy the output
modal secret create lantage-inference LANTAGE_INFERENCE_SECRET=<paste>
```

The secret name must match `LANTAGE_MODAL_SECRET` (default `lantage-inference`).
If the key is missing from the secret, the service starts but rejects every
request with `503` rather than falling open — check `/health` after any secret
change.

### 3. Verify the image builds and every model loads

```bash
modal run services/inference/app.py
```

Runs `selftest` in a throwaway container and prints, per model, the load time,
the actual output dimension, whether it matches `MODEL_REGISTRY`, and the L2 norm.
Do this before the first deploy — the first build downloads CLIP ViT-L/14,
DINOv2-L and MegaLoc and takes a while.

### 4. Deploy

```bash
# production posture: one container always warm
modal deploy services/inference/app.py

# development posture: scale to zero, ~20-50x worse per search (§6)
LANTAGE_MIN_CONTAINERS=0 modal deploy services/inference/app.py
```

`modal deploy` prints the web URL. Shape:

```
https://<workspace>--lantage-inference-embedder-web.modal.run
```

Put it in the app's env as `LANTAGE_INFERENCE_URL`, alongside
`LANTAGE_INFERENCE_SECRET` — server-side only, never `NEXT_PUBLIC_*`.

Use `modal serve services/inference/app.py` for a hot-reloading ephemeral
deployment while developing; it gets a `-dev` suffixed URL and does not disturb
production.

### 5. Benchmark

```bash
export LANTAGE_INFERENCE_URL=https://<workspace>--lantage-inference-embedder-web.modal.run
export LANTAGE_INFERENCE_SECRET=<same value as the Modal secret>

python3 services/inference/bench.py                       # warm suite
python3 services/inference/bench.py --cold --idle-wait 360 # include a cold start
```

Writes `services/inference/bench_report.json` with p50/p95 per model against the
§3 budgets, batching speedup, and the cold-vs-warm delta. Stdlib-only, so it runs
without a venv. Exits non-zero if any embedding is not unit-norm.

A real cold start requires the container to actually be gone, so measure it
against a scale-to-zero deploy:

```bash
LANTAGE_MIN_CONTAINERS=0 LANTAGE_SCALEDOWN_WINDOW=60 modal deploy services/inference/app.py
python3 services/inference/bench.py --cold --idle-wait 120
modal deploy services/inference/app.py   # back to warm before running the warm suite
```

See `services/inference/.env.example` for every knob, split into deploy-time and
runtime groups.

---

## Container reuse — the one thing to get right

MASTER_PLAN §6 puts a hard number on this: a warm L4 at $0.80/hr amortises to
**~$0.02–0.05 per 1,000 searches**, while scale-to-zero with one request per
container life costs **~$1.10 per 1,000** — a 20–50× penalty, because you pay the
model-load time on every request and then discard the loaded weights.

Four mechanisms, all in `app.py`:

- **`min_containers=1`** — the floor never returns to zero, so steady-state
  searches never pay a cold start. This is the $576/mo line in §6.
- **`scaledown_window=300`** — a burst that briefly exceeds the warm floor does
  not immediately discard the extra containers and re-pay their load cost.
- **`@modal.enter()`** — weights load once per container lifetime. *Nothing in the
  request path may call `from_pretrained` or `torch.hub.load`.* A model load
  inside a route handler reintroduces the full 20–50× penalty.
- **`@modal.concurrent(max_inputs=8, target_inputs=4)`** — one container
  interleaves several requests. Image fetch and JPEG decode are a real share of
  wall time and are pure I/O; overlapping them raises GPU utilisation without more
  containers. GPU compute is serialised behind a lock so peak VRAM stays bounded.

Two supporting details that matter as much:

- **Weights are baked into the image** at build time via `run_function`, not pulled
  from HuggingFace at container start. That makes the cold path deterministic
  instead of dependent on HF throughput, and it freezes the checkpoint so a
  redeploy cannot silently change the model behind a result already sitting in an
  Evidence Ledger.
- **`torch.hub` loads from the cached checkout** with `source="local"`. The GitHub
  path validates the repo over the network even when the checkout is cached, which
  would turn a GitHub blip into a failed search.

`/health` reports `scaling.warmPosture` so a monitor can alert if production is
accidentally running the expensive posture.

---

## Reproducibility, and why it looks like over-engineering

§0: Daubert asks for a known error rate, and *State v. Arteaga* means the
methodology behind any result is discoverable. Both require that a result be
reproducible years later and that the exact model behind it be identifiable.

- Every embedding carries a `version` string that B2 propagates into
  `ResultProvenance.models`.
- Inference runs in **fp32**. fp16 would be faster, but it makes bitwise
  reproduction depend on whichever GPU happened to serve the request.
- `/health` reports resolved versions, dims, precision and GPU, so a discovery
  request can be answered from the service itself.
- **Preprocessing is part of the model version.** `EIGENPLACES_INPUT_SIZE` is the
  live example: EigenPlaces' own test transform applies no resize (the network is
  fully convolutional with GeM pooling), so we picked 512 to match the paper's
  training crop. Query and index *must* use the same size or recall degrades with
  no error surfaced anywhere. If BENCH sweeps it and picks differently, bump
  `eigenplaces` to `@1.1` and rebuild the index — do not change it in place on a
  live corpus.

Bump the `@x.y` suffix in `MODEL_REGISTRY` for any change to weights *or*
preprocessing.

---

## Licensing — flag for counsel before commercial launch

**EigenPlaces, CosPlace and MegaLoc are MIT-licensed code *and* weights.** Verified
directly:

- EigenPlaces — MIT, © 2023 Berton, Trivigno, Masone, Caputo
- MegaLoc — MIT, © 2024 Berton, Masone
- DINOv2 — Apache-2.0, Meta AI
- GeoCLIP — MIT; its image tower is `openai/clip-vit-large-patch14`

**The open question is not the licence — it is the training data.** All three VPR
models were trained on Google-Street-View-derived corpora: GSV-Cities, SF-XL,
Pittsburgh (Pitts250k). Google's Maps Platform ToS prohibits caching, extraction,
derivative content and ML training, and every canonical VPR benchmark
(SF-XL, Pitts250k, Tokyo24/7, GSV-Cities, GWS15k) is GSV — which is why §3 treats
those datasets as **evaluation-only, forever**.

Our position, stated plainly:

- We **store no Google pixels.** The shipped index is Mapillary-derived only,
  whose terms §12 explicitly permit commercial construction of *datasets* and
  *algorithms*.
- The model authors license their weights permissively and we use them as
  published.
- But we are using weights whose training data we could not have collected
  ourselves.

That last point is a live question, not a settled one, and it will surface in
discovery before it surfaces anywhere else. **Get it blessed by counsel before
commercial launch** — MASTER_PLAN §3 and §12 item 8 both flag it, alongside the
Mapillary derived-index posture and the CJIS scoping memo.

**Mapillary-native alternatives, if counsel says no.** Both exist and neither
requires rearchitecting:

- **OSV-5M baseline** — 5.1M images, 225 countries, CC-BY-SA, Mapillary-derived,
  with a released baseline model. Already the §3 foundation for the corpus.
- **GeoSpot-base** — Apache-2.0.

Retrieval quality would drop, but the descriptor slot in the cascade is a clean
swap: change the loader, bump the version string, rebuild the index. Keeping the
model behind a version string is part of why that swap stays cheap.

Two other constraints that touch this service, from §7 and §1:

- **No ALPR, and never undo upstream blur.** Mapillary's terms require *technical
  safeguards* against reidentification or unblurring. This service never receives
  plate characters and runs no upscaling or restoration path.
- **No scraped face index.** Nothing here embeds faces.

---

## Verified vs. adapter

Every model entrypoint here was checked against upstream source rather than
written from memory:

| Thing | Status |
|---|---|
| `gmberton/eigenplaces` → `get_trained_model(backbone, fc_output_dim)` | **Verified** in `hubconf.py`. ResNet50 accepts `fc_output_dim ∈ {128, 256, 512, 2048}`, so 512 is a supported config. |
| `gmberton/MegaLoc` → `get_trained_model()` | **Verified** in `hubconf.py`. No args, 8448-d, L2-normalised. |
| `facebookresearch/dinov2` → `dinov2_vitl14` | **Verified** in `hubconf.py`. |
| `geoclip.GeoCLIP()` | **Verified** — `pip install geoclip`, `GeoCLIP(from_pretrained=True, queue_size=4096)`. |
| EigenPlaces preprocessing | **Verified** — `datasets/test_dataset.py` is ToTensor + ImageNet normalise, **no resize**. Fixed 512 is our choice for batching, documented above. |
| MegaLoc preprocessing | **Verified** — README specifies 322×322, ImageNet normalise. |
| GeoCLIP `geoPrior` | **Adapter.** `GeoCLIP.predict()` only accepts a filesystem path and re-encodes all ~100k gallery coordinates per call, so it is unusable in a batched service. `_prepare_geoclip_gallery()` caches the normalised gallery embeddings at container start and scores with a matmul, reading `gps_gallery` / `location_encoder` / `logit_scale` directly (verified against `geoclip/model/GeoCLIP.py`). If upstream renames any of those, it falls back to the public `forward(image, gps_gallery)` path rather than returning a wrong prior, and `/health` reports which path is live via `geoPriorMode`. |
| `geoclip` package version | **Not pinned** — see the TODO in `requirements.txt`. Close it after the first successful build. |
