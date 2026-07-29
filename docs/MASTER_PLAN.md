# Lantage — Master Plan

**v1.0 · 2026-07-29 · Ivan Cornejo**

An image-intelligence workbench for investigators. One frame in; where it was taken, what's in it, whether it's real, and an auditable chain of the reasoning that got there.

---

## Locked decisions (2026-07-29)

| Decision | Choice | Consequence |
|---|---|---|
| **Metro #1** | **Pittsburgh, PA** | ~1,600 km of city streets ⇒ **~320k vectors** at practical density — a quarter the size of the Tulsa estimate, so the first index is cheap and fast. Pittsburgh also has a **CCOPS ordinance**, which means we design against the strictest procurement regime from the start. And the terrain is a gift: 446 bridges, hillside row houses, public stairs, three rivers — highly discriminative for retrieval and it demos beautifully. **Verify Mapillary density before harvest**; if the city proper is thin, widen to Allegheny County. |
| **First buyer** | **Insurance SIU** | Reframes the product from surveillance to **claims verification**. VERIFY becomes co-equal with GEO rather than a side module. Unlocks a new capability that solves the MLS blocker — see §8. Demo corpus becomes property-damage photos, not mansion interiors. |
| **MATCH scope** | **v2, cross-frame re-ID only** | Out of v1 entirely. No face-SDK licence needed now (~€339–859 deferred). Never ingest mugshots ⇒ **permanently out of CJIS scope** ⇒ Supabase/Vercel stay viable. |
| **Engine path** | **Full cascade** | ~3 weeks. GeoCLIP prior → gated Gemini 3 Flash clue extraction → EigenPlaces-512 VPR against Mapillary submap → OCR/solar/ecoregion verifiers. ~$0.60 per 1,000 searches. |

---

## 0. The thesis, and why it's different from Raven

Every product in this category sells a **confident answer**. Raven markets "meter-level accuracy." GeoSpy marketed the same. Nobody publishes an error rate.

Here's what the published evidence actually says:

- On **GWS15k** — the only geolocation benchmark that samples countries by land area instead of by tourist-photo density — the best published street-level (1 km) accuracy is **0.7%**. The impressive "14–24% street-level" numbers you see everywhere come from IM2GPS3k and YFCC4k, which are Flickr photos of landmarks.
- Frontier vision models reach ~90% country and ~40% city on street-view imagery, but the ACL 2026 GeoRC study found they "couldn't provide reasoning for their guesses or were vague," and human experts identified "many suspicious or hallucinated attributes." **The model often recognizes the place and then fabricates the evidence.**
- The **Miami-Dade Sheriff's Office**, which actually piloted GeoSpy, stated on the record that testing "has not led to any significant investigative breakthroughs or arrests" and that output "should be treated as a clue."

So the incumbent is selling an unverifiable claim, to a buyer who already discounts it, in a market where **no one has published a benchmark.**

**Lantage's wedge is to be the one that shows its work.**

That isn't a compliance hedge. It's the product, for three concrete reasons:

1. **Daubert asks for a known error rate.** No competitor can supply one. Any AI-derived location or identification offered in court gets attacked on exactly this. A published, versioned error rate on a stated benchmark is a moat.
2. **Defense discovery will demand the methodology.** *State v. Arteaga* (N.J. App. Div. 2023) entitles defendants to discovery of how the system works. Build assuming every search is discoverable — because it will be.
3. **The buyer's actual job is corroboration.** They're going to verify the result by hand regardless. A result that hands them the *verifiable evidence* — the signage crop that was OCR'd, the matched panorama side-by-side, the solar-angle constraint — is worth more than a pin with a number on it.

**Design consequence:** the atomic unit of Lantage is not a coordinate. It's an **Evidence Ledger** entry — a ranked hypothesis with each supporting signal cited, individually checkable, and exportable into a case file.

---

## 1. The reframe on face search — read this before anything else

You asked for Sherlock: upload a face, search the internet, get candidate identities. I'm not building that, and I want to give you the commercial argument rather than a lecture.

**What the internet-wide scraped face index costs you:**

- Clearview built exactly this and is now **permanently barred nationwide from selling face-database access to any private entity**, barred from Illinois government customers until **May 11, 2027**, fined **€20M (Italy), €20M (Greece), €20M+€5.2M (France), €30.5M (Netherlands), £7.55M (UK)** — and paid a US class settlement valued at **~$51.75M** (23% of company equity).
- Illinois BIPA carries a **private right of action** at $1,000–$5,000 per person. **107+ new BIPA class actions were filed in 2025 alone.** The 2024 amendment killed per-scan stacking, but per-person × class size is still existential for a startup.
- The **EU AI Act Art. 5(1)(e)** makes "untargeted scraping of facial images from the internet or CCTV" a **prohibited AI practice** — not high-risk, prohibited — with penalties to €35M / 7% of turnover, enforceable since Aug 2, 2025. There is no law-enforcement exception.
- PimEyes geo-blocks Illinois entirely. That's what a company in this business has to do.

**And the part that actually kills the deal:** you cannot sell it. A PD's legal review will not clear a vendor-owned scraped biometric index. In a CCOPS city (~24 jurisdictions including Seattle, Boston, Cambridge, Oakland, SF, Nashville, Pittsburgh, Madison, Grand Rapids) acquiring it requires a **public council vote with a published Surveillance Impact Report**. Durham killed a $517k Peregrine contract in Feb 2026 over community resistance — and Peregrine doesn't even do face search. Yours would be the headline.

### What I'll build instead, which is genuinely useful

**MATCH — three capabilities, none requiring a scraped index:**

1. **Cross-frame re-identification within one case.** *"Is the person in these 40 CCTV stills the same person, and can you order them by time?"* This is the thing investigators actually need most, it operates entirely on evidence the agency already lawfully holds, and it has zero third-party consent problem. In-domain, same-day, same-clothing re-ID is where the models are genuinely strong (SOLIDER: 96.9% rank-1 on Market-1501).

2. **Closed-gallery 1:N** against a gallery the agency is legally authorized to search — its own case imagery, missing-persons sets, or booking photos. **Note the CJIS consequence:** mugshot galleries sourced from state ID bureaus or the FBI **are Criminal Justice Information**, which puts you in CJIS scope and off Supabase/Vercel entirely (neither has a CJIS program or Security Addendum path). Agency-generated case imagery has a defensible out-of-scope argument. This is the single biggest fork in your cost structure — §7.

3. **Non-biometric identity resolution.** Whole-image reverse search via **TinEye** (the one reverse-image API actually licensed for commercial resale — $0.01/search at volume), username enumeration across platforms (the real open-source Sherlock project, which checks public endpoints and touches no biometrics), and public-records lookups the agency already licenses.

### The honest capability ceiling, which is a feature

At CCTV resolution the numbers collapse and you need to say so in-product:

| Condition | Reality |
|---|---|
| TinyFace (avg 20×16 px faces) | best research models **72–75% rank-1** — 1 in 4 top hits wrong, in a *closed* set |
| IJB-S surveillance → surveillance | **36.7% rank-1.** Cross-CCTV matching is worse than a coin flip |
| Masked probes | algorithms at <1% FNMR unmasked fail **5–50%** of masked faces |
| Practical floor | recognition needs **~21 px inter-eye minimum, 40 px recommended**; ISO/IEC 39794-5 wants 90 px for enrollment |
| Super-resolution | IEEE 2025: upscaling **preserves visual detail but does not recover biometric information** — it makes images look matchable without making them matchable |

**So: the quality gate IS the product's integrity.** Run **OFIQ** (the BSI reference implementation of ISO/IEC 29794-5, liberally licensed for commercial use) on every probe, log the component scores, and below ~24–32 px inter-eye **refuse to return ranked candidates at all**. Show the refusal. A tool that says "this image is not matchable" is the one an investigator can trust when it does return something.

**Also excluded, deliberately: license-plate reading.** Private ALPR is flatly illegal in **New Hampshire and Maine**, restricted in Vermont/Arkansas/Utah/Minnesota, and California's operator statute is generating active class actions against private operators right now. Independently, Mapillary's terms — your only viable imagery source — contractually bar you from "re-identify[ing] or unblur[ring] any aspect of any Content, including any individual or license plate" **and require technical safeguards preventing it.** Your imagery corpus is pre-blurred on plates and you've agreed not to undo that.

A documented **"no ALPR, no scraped face index"** boundary reads as procurement maturity to an agency buyer. Put it in the sales deck.

---

## 2. Modules

| Module | What it does | Ship |
|---|---|---|
| **VERIFY** | AI-generation & manipulation detection, provenance-first | **v1 — lead module for SIU** |
| **GEO** | Single frame → ranked candidate regions with cited visual evidence | v1 |
| **STREET** | Region → street-level candidates via Mapillary retrieval + signage OCR/geocode | v1 |
| **CLAIM** | Corpus self-match: recycled/duplicate imagery across an org's own files | **v1 — see §8** |
| **VEHICLE** | Make / model / year / colour from partial or blurred vehicle crops. No plates. | v1 |
| **CASE** | Case file, Evidence Ledger, chain of custody, audit log, PDF export | v1 |
| **BENCH** | Public benchmark harness + published error rates | v1 — *this is the differentiator, not a chore* |
| **MATCH** | Cross-frame re-ID within one case's evidence | v2 |
| ~~Scraped face index~~ · ~~ALPR~~ · ~~MLS photo index~~ | | **never** |

### The SIU primary flow

For an insurance special-investigations unit the question isn't "where is this?" — it's **"does this photo support the claim as filed?"** Three checks, in order of how often they break a claim:

1. **Is it generated or manipulated?** → VERIFY. C2PA manifest, metadata, quantization-table fingerprint, calibrated statistical detector.
2. **Was it taken where the loss is claimed?** → GEO/STREET. Region estimate vs. the loss address on file. A mismatch is a lead; a match is corroboration.
3. **Has this image — or this damage — been submitted before?** → CLAIM. This is the highest-yield check and the cheapest to run.

Everything the tool asserts lands in the Evidence Ledger with its supporting crop, so an SIU investigator can attach it to a referral without re-doing the work.

---

## 3. GEO + STREET — the engine

The architecture that works is published: [arXiv 2507.17455](https://arxiv.org/html/2507.17455v2), *VLM-Guided Visual Place Recognition for Planet-Scale Geo-Localization*. Its core insight, which I'm adopting as the spine of Lantage:

> **The vision model's job is not to answer. It's to prune the search space.**

That paper's cascade (GPT-4v prior → regional submap → EigenPlaces retrieval) beat the prior best by **+10.3% city-level on IM2GPS3k** and **+4.1% street-level on IM2GPS**. Notably, EigenPlaces-512 beat BoQ-16384 in their ablation — the small descriptor won.

### The cascade

```
frame in
  │
  ├─ [0] EXIF/XMP extract + strip + preprocess                    ~300 ms
  │      (keep metadata in the ledger; never trust it — o3 correctly
  │       rejected falsified EXIF GPS, and so must we)
  │
  ├─ [1] Cheap embedding prior: GeoCLIP or OSV-5M baseline         ~120 ms  warm L4
  │      → coarse region + calibrated confidence
  │
  ├─ [2] Confidence-gated escalation (~25% of traffic):            2–4 s   $2.25/1k
  │      Gemini 3 Flash → STRUCTURED clue extraction only:
  │      signage text · driving side · plate style (style, not number)
  │      · utility pole / bollard / road-marking style · biome
  │      · architecture · vehicle fleet mix
  │      → refined region prior
  │      ⚠ Structured clues, never a freeform guess. The clue list is
  │        the auditable artifact; the coordinate is not.
  │
  ├─ [3] Region-pruned VPR retrieval                               ~170 ms
  │      EigenPlaces-512 against Mapillary submap
  │      (halfvec HNSW in pgvector, ≤2M vectors/metro)
  │
  ├─ [4] Optional re-rank of top-50 with MegaLoc-8448              ~2.8 s
  │
  ├─ [5] Verifiers — cheap, high precision, independently checkable:
  │      • signage OCR → geocode        ← highest street-level yield of anything
  │      • ShadowFinder solar constraint (Bellingcat, MIT) if timestamped
  │      • biome / ecoregion raster mask
  │
  └─ ranked candidate regions, each with its cited evidence
```

**Total 3–8 s. ~$0.60–0.70 per 1,000 searches.** Raven charges **$0.25 per search** — $250/1,000. That's a ~350× gross margin at their price point, which means we can price aggressively and still be very profitable.

### Three decisions that are expensive to reverse

**1. Descriptor dimension: 512-d. Not 8448-d.**

| | EigenPlaces-512 | MegaLoc-8448 |
|---|---|---|
| Storage, 1M vectors fp32 | **2.0 GB** | 33.8 GB |
| Latency per image | **0.13 s** | 2.80 s (21×) |
| pgvector HNSW indexable? | **Yes** | **No — pgvector's HNSW limit is 2,000 dims** |

MegaLoc is the better model in isolation (MIT, one-line `torch.hub` load, SOTA on Tokyo24/7 at 97.1% R@1). But it cannot be HNSW-indexed in pgvector at all, it's 16.5× the storage, and it eats 2.8 s of a 10-second budget. **Use EigenPlaces-512 (MIT) for retrieval and MegaLoc only to re-rank the top 50, if measurement justifies it.**

**2. The shipped index must be Mapillary-derived. Only.**

Every canonical VPR dataset — **SF-XL, Pitts250k, Tokyo24/7, GSV-Cities, GWS15k** — is Google Street View. Google's Maps Platform ToS prohibits caching, downloading, extracting, creating derivative content, and ML training, and Street View policies state plainly: *"Content pre-fetching, indexing, storing, or caching is generally prohibited, except for place IDs and panorama IDs."* Those datasets are **evaluation-only, forever.**

Mapillary is the opposite and it's remarkable. Terms §12:

> "You may use the Mapillary Services only for the following commercial purposes: (i) improvement, training, and development of products, services, maps, studies, platforms, websites, applications, software, algorithms, **datasets**, solutions, or technologies..."

That names *datasets* and *algorithms* explicitly. ~3B images, 190+ countries, **$0**, self-hosting contemplated with attribution. It is the only street-imagery source on earth whose licence affirmatively permits what we need to build.

Foundation: **OSV-5M** (5.1M images, 225 countries, CC-BY-SA, Mapillary-derived, with a released baseline model) plus targeted Mapillary API harvesting per committed metro.

Google Street View still has a role: **live render for human confirmation at $7/1k, persisting pano IDs only, never pixels.** Apple Look Around via MapKit JS is a free supplementary confirmation panel (250k views/day).

*Flag for counsel:* the best open VPR weights (MegaLoc, SALAD, CosPlace, EigenPlaces) were themselves **trained on GSV-derived data**. We store no Google pixels and the authors license permissively, but get this blessed before it surfaces in discovery. Mapillary-native alternatives exist: the OSV-5M baseline, and GeoSpot-base (Apache-2.0).

**3. Ship ranked regions with cited evidence. Never a bare pin.**

Because 0.7%. Every screenshot in your reference set that shows a single confident address is showing you the output of *retrieval against an indexed panorama* or *OCR of a visible address* — not inference. When we hit street level, it will be for one of those two reasons, and we will say which.

### Index sizing — real numbers

Anchor: SF-XL is 2.81M images from 232k locations over ~1,900 km of street ⇒ ~122 locations/km at ~8 m spacing, ~12 views each.

| Density | Images/km | Tulsa (~4,000 km) | Austin (~7,000 km) |
|---|---|---|---|
| Lean (20 m, 2 headings) | 100 | 400k | 700k |
| **Practical (20 m, 4 headings)** | **200** | **800k** | **1.4M** |
| SF-XL research grade | 1,460 | 5.8M | 10.2M |

At practical density and 512-d `halfvec`, one metro is **~0.8–1.4 GB of vectors.** That sits comfortably on **Supabase XL ($210/mo)**, which handles ~3M vectors with <10 ms p99.

**Two traps to avoid:**
- `maintenance_work_mem` defaults to **64 MB**. If the HNSW graph doesn't fit, Postgres silently falls back to a disk build that is **10–50× slower**. Set it to 8–16 GB before every index build.
- Use `halfvec` — **<1% recall cost** on normalized embeddings, half the RAM and index size.

**Migration trigger:** >20M vectors, p95 >100 ms, or build time >30 min. Target: **Qdrant self-hosted** (100M × 768-d in ~64 GB RAM with quantization, ~$600–900/mo) or **Turbopuffer** if QPS stays moderate (object-storage economics, ~$33/mo for 100 GB at rest). pgvector's practical single-node ceiling is ~50M vectors.

---

## 4. VEHICLE

**Do not train a fixed-class classifier on the open datasets.** Stanford Cars and CompCars are **explicitly non-commercial**, and every major open VMMR set stops between 2012 and 2020 — no Ioniq 5, no Lightning, no Rivian, nothing post-2020.

Instead:

```
detect (YOLO11 / RF-DETR) → crop → DINOv2 or CLIP embedding
  → nearest-neighbour against a reference gallery keyed to the NHTSA vPIC taxonomy
  → top-5 ranked candidates with similarity
```

- **Reference gallery:** Auto.dev at **$0.001/image** (free tier, 1k calls/mo) — refreshes with the market, so the staleness problem disappears.
- **Taxonomy:** NHTSA **vPIC** — free, no key, every US vehicle since 1981, full downloadable DB.
- **Report top-5, never top-1.** Fine-grained VMMR has high intra-class and low inter-class variance; top-1 on exact make/model/year is unreliable and the literature is consistent on this. The Raven screenshot showing "80% Silverado 1500, 4 of 10 results share this make" is doing the honest thing — copy that pattern.
- Shares the embedding infrastructure with GEO. Same DINOv2 backbone, same pgvector instance.

---

## 5. VERIFY — provenance first, statistics second

The market here is badly oversold and you need to not repeat its claims.

| Claim | Reality |
|---|---|
| Vendors advertise 98%+ | Best commercial on **Deepfake-Eval-2024** (in-the-wild media): **82%**. Open-source SOTA: 61–69% |
| Detectors generalize | On **Chameleon** (AI images that passed a human Turing test), nearly all detectors — including AIDE — classify most AI images as **real. Near chance.** |
| False positives are rare | A 2026 NewsGuard audit found 3 of 5 leading detectors misclassified authentic news photos; **the worst flagged 40% of real photos as AI.** Consumer detectors run 5–15% FPR on real photographs |

**Architecture — deterministic first, probabilistic last:**

1. **C2PA / Content Credentials manifest check.** High precision, cheap, deterministic. A valid manifest is strong evidence. Adoption is real (Leica, Sony, Nikon, Canon; OpenAI signs DALL·E/Sora output and joined the C2PA steering committee May 2026).
2. **Metadata forensics:** EXIF/XMP parse, JPEG quantization-table fingerprinting (genuinely informative for "re-saved by Photoshop / passed through platform X").
3. **Statistical detection** (Hive at ~$0.003/img is the best-tested commercial option) — **calibrated**, reported as bands.
4. **Splice/copy-move localization** (TruFor, avg F1 ≈ 0.70) as an *examiner tool with a human reading the map*, never an automated verdict.

**Hard product rules:**

- **Absence of C2PA means nothing** and must never be presented as evidence of fakery. Platforms strip manifests on upload ~100% of the time, so most real case imagery will have none.
- **Never assert "authentic."** Only "no indicators found."
- **Bands, not point percentages.** "Strong / moderate / weak indicators," each with its published calibrated FPR. That "Likely AI-generated — 92%" panel in the Raven screenshot is exactly what we don't ship — a fused magic number is a claim we can't support.
- **Show PPV at realistic base rates.** At 5–15% FPR and low prevalence of AI images in a caseload, *most positive flags are false positives.* Put that math in the UI.
- **Suppress or down-weight verdicts** on known false-positive classes: smartphone computational photography (HDR, night mode, AI denoise), AI upscaling, heavy retouching, screenshots, recompression.
- **ELA is junk.** Your instinct was right — it cannot distinguish edits from naturally high-frequency content. If it ships at all, it's an unlabeled visualization for trained examiners, never a verdict.

---

## 6. Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js App Router, Tailwind v4, Framer Motion, Lenis | Matches the measured flysoar.ai stack — see `DESIGN_SYSTEM.md` |
| Map | **MapLibre GL JS** (BSD-3) | **Not Mapbox GL v2+** — it bills per `Map` init. An analyst opening map views all day would burn hundreds of billable loads per session. Mapbox at 200k loads/mo ≈ **$750/mo**; MapLibre ≈ $0 |
| Tiles | Protomaps PMTiles (dark) on Cloudflare R2, self-hosted | Whole basemap = one file on object storage. **~$0–5/mo.** Stadia "Alidade Smooth Dark" at $20/mo is the shortcut for v1 |
| 3D buildings | **Overture Maps** (ODbL) + tippecanoe → PMTiles | Real `height`/`num_floors`, some from USGS 3DEP lidar. ODbL doesn't trigger share-alike on rendered maps |
| Geocoding | **Self-hosted Nominatim** (US extract) | ~$25–40/mo VPS, unlimited, storable. The public instance forbids grid/systematic queries — which is exactly our pattern |
| DB / auth / storage | Supabase Postgres + pgvector + RLS | **Non-CJI scope only** — see §7 |
| GPU inference | **Modal** (per-second billing) | Bursty sub-second workload. L4 at $0.80/hr. **Keep one warm** — scale-to-zero makes cost 20–50× worse ($0.05 → $1.10 per 1k) |
| VLM | Gemini 3 Flash (~$2.25/1k) | Confidence-gated only. **Never a reasoning-heavy model in the hot path** — o3/Opus-high routinely run 15–60 s and blow the SLA |
| Reverse image | **TinEye** ($0.01/search at volume) | The only whole-image API licensed for commercial resale. Skip SerpApi — its own terms bar resale. Bing Visual Search was retired Aug 2025 |

### Cost at v1, one metro

| Item | Monthly |
|---|---|
| Supabase XL (vectors + app DB) | $210 |
| Modal, 1 warm L4 | $576 |
| Nominatim VPS | $35 |
| Protomaps on R2 | $5 |
| Vercel | $20 |
| Mapillary imagery | **$0** |
| vPIC taxonomy | **$0** |
| **Fixed** | **~$850/mo** |
| Per-search marginal | **~$0.0007** |

Compare: naive Mapbox + Google Street View + MLS build runs **$1,000–1,500/mo** and carries copyright exposure. Drop Modal to on-demand during pre-revenue development and fixed cost falls to ~$270/mo.

---

## 7. Legal posture — the three lines and one big fork

**Three hard lines, in code and in the sales deck:**
1. No internet-scraped face index. Ever.
2. No license-plate recognition.
3. No MLS interior-photo index (§8).

**The CJIS fork — the single biggest architectural decision after descriptor dimension.**

CJIS Security Policy v6.0 requires, for any vendor touching Criminal Justice Information: a signed **CJIS Security Addendum** per agency, **fingerprint-based background checks** for every person with unescorted access to unencrypted CJI (administered separately by each state's CSA), FIPS-validated encryption, MFA, audit logging, incident response, US data residency. **Neither Supabase nor Vercel has a CJIS program or Addendum path.** CJI means AWS GovCloud or Azure Government, 6–18 months, and $15–75k+ in readiness assessment.

**So scope out of CJIS scope, deliberately:**

- Accept only agency-uploaded media not derived from FBI/state CJIS systems.
- **No integrations with NCIC, Nlets, or III.** Ever.
- Contractually prohibit uploading CHRI, rap sheets, NCIC printouts.
- **Booking-photo galleries from state ID bureaus or the FBI are CJI, full stop.** This is why MATCH's closed-gallery mode is v2 and gated — the moment you ingest mugshots you're in CJIS scope and off this entire stack.
- Get the scoping analysis **in writing, blessed by the state CSA, before contract.** The boundary is genuinely unsettled — no authoritative FBI ruling exists on whether an agency-taken crime-scene photo is CJI, and state CSAs read "case/incident history data" broadly. Price both paths.

**Ship the Detroit rules as non-negotiable defaults.** The Robert Williams settlement (June 2024, $300k + 4 years of federal oversight) is the national template, and 8+ states now have statutes to the same effect: no arrest on an AI match alone; **no photo lineup built from a match without independent linking evidence**; serious-crimes limitation; mandatory training on error rates and demographic differentials. Detroit's FR use fell ~91% afterward. Build these as enforced workflow, not policy PDF:

- Every result labeled `INVESTIGATIVE LEAD · VERIFY INDEPENDENTLY` as permanent UI furniture, not a dismissible toast.
- A forced corroboration step before a result can be marked Confirmed.
- Immutable audit log per search: who, when, what image, what result, what they did with it — built for defense discovery from day one.
- **Jurisdiction gating:** disable modules per-customer by city/state. ~24 CCOPS cities, 15 states with FR guardrails, warrant requirements in Montana and Utah, and city bans in SF/Oakland/Berkeley/Boston/Cambridge/Somerville/Portland/Minneapolis/Madison/Jackson and more. Verify per target city at sale time — the list churns constantly.

**The GeoSpy lesson, which is the most important operational rule here.** In January 2025, 404 Media found Discord members using GeoSpy's free public tier to geolocate and stalk specific women. Graylark pulled the free tool the day they were contacted for comment. That nearly ended the company.

**Therefore, from commit one:** no anonymous tier, ever. Identity verification at signup. PI licence validation against state registries. Per-search audit logging with retention. Rate limits. A documented abuse-response process. This is survival infrastructure, not paperwork.

**Demographic fairness:** NISTIR 8280 found 1:1 false-match rates elevated **10–100×** for West/East African and East Asian faces in many algorithms, with 1:N false positives highest for African-American women on mugshots. But the crucial nuance is that **the most accurate algorithms show undetectable 1:N demographic differentials** — equity correlates with accuracy. So the posture is "we use a top-tier NIST-evaluated algorithm and publish its per-demographic annex," not a generic disclaimer.

---

## 8. The MLS interior-match capability — blocked, and the pivot

Your screenshots show the marquee demo: an interior frame from a Tate video matched against Miami MLS listing photos to find the property. **That specific capability is legally blocked at any price**, through every channel examined:

1. **NAR IDX Policy 7.58:** *"MLS participants may not use IDX-provided listings for any purpose other than IDX display."* An embedding index is not display.
2. **VHT v. Zillow** (9th Cir. 2019, affirmed 2023): Zillow **won** on passively displaying MLS photos but **lost on building a searchable indexed arrangement of them** — the court rejected the search-engine analogy and rejected fair use. **$1,927,200.**
3. Copyright sits with **thousands of individual real-estate photographers**, sublicensed narrowly to the MLS for marketing that one property. No MLS, no ATTOM, no Repliers can grant derivative rights they never held.

Feeds are cheap and available (Repliers ~$199/mo/MLS, MLS Grid ~$425–475/mo all-in) — **access isn't the problem; the right to index is.** CoStar v. Zillow, amended March 2026, shows rights holders actively litigating this right now.

**Three ways to keep the capability:**

- **(a) Pointer architecture** — index only derived non-expressive features (embedding + listing ID + CDN URL), **never retain pixels**, hot-link the licensed CDN at display time within IDX rules with broker attribution. Mirrors the Street View pano-ID pattern. Better legal position, but get counsel to bless it *before* shipping.
- **(b) Own the demo corpus** — a few hundred licensed stock interiors with explicit derivative rights: a few hundred dollars, zero risk, demos identically.
- **(c) Reframe onto the customer's own corpus.** Same technology, same buyer, customer supplies the images. No data-licensing line item at all.

**Choosing insurance SIU makes (c) the whole answer — and it turns the blocked feature into the strongest one in the product.**

### CLAIM — corpus self-match

An insurer already owns millions of claim photos and has full rights to them. Point the retrieval engine at that corpus instead of at MLS, and the exact same embedding index answers a question SIU units care about far more than "which house is this":

- **Recycled damage.** The same roof, the same hail-dented hood, the same water-stained ceiling submitted across multiple claims, policies, or carriers. This is a known, high-frequency fraud pattern and it is *invisible* to manual review at scale — but it's a near-duplicate image retrieval problem, which is exactly what we're building.
- **Contractor rings.** Cluster by visual similarity and the same handful of properties or the same staged damage keeps reappearing across a single adjuster or contractor's submissions. That pattern is the referral.
- **Stock and scraped imagery.** A claim photo that matches a public listing photo, a stock library, or a Google result. TinEye at $0.01/search covers this, and it needs no index at all.
- **Cross-claim timeline conflict.** Same property, same damage, two different claimed loss dates.

Why this is the right first feature:

| | |
|---|---|
| **Legal exposure** | Zero. The customer owns the corpus and grants us processing rights in the MSA. |
| **Data-licensing cost** | $0. No MLS feed, no ATTOM, no broker relationship, no 6–8 week onboarding. |
| **Infrastructure** | Reuses the same DINOv2/pgvector stack as GEO and VEHICLE. Marginal build cost. |
| **Demo** | Trivially demonstrable on synthetic or licensed sample claim sets. |
| **Stickiness** | Their corpus lives in our index. That's switching cost that compounds monthly. |
| **ROI story** | Denominated in denied fraudulent claims, which SIU directors already measure and defend budget with. |

The MLS pointer architecture stays on the roadmap as (a), gated on counsel. But it's no longer on the critical path, and the capability it was meant to deliver now ships in v1 with none of the exposure.

---

## 9. Appendix — market reference data

*Ivan owns positioning, pricing, and sales execution. This section is reference data only — do not treat it as direction, and do not expand it.*

Real contract values, from public records:

| Vendor | Agency | Value |
|---|---|---|
| **GeoSpy** | Miami-Dade SO | **$85,500 quote** — 2 licences $10k + custom regional model $38k + 150k searches $37.5k |
| GeoSpy | list | **~$5,000/licence/yr** incl. 350 searches; **$0.25/search** bulk |
| Clearview | Minneapolis PD | $11,045 / 15 licences |
| Clearview | Dallas PD | ~$89k / 3 yr |
| Peregrine | Joliet IL / Antioch CA | $200k yr 1 / ~$127k/yr |
| Babel Street | single seat | $18,500/yr |
| Penlink | LAPD | ~$200k/yr |
| Fusus | Kennesaw GA / Chula Vista CA | $75k/yr / $135k/yr |

**Calibration:** a niche analytic tool lands **$5–15k/yr small agency, $30–90k large, $100k+ only with custom work.** Sub-$25k often clears on department purchasing authority without a council vote — which is exactly how GeoSpy and Clearview spread.

### Sequence — locked

**1. Insurance SIU — the wedge (chosen).** Highest willingness to pay, lowest legal exposure, no RFP, and AI-generated claim-photo fraud is a live 2026 boardroom problem. The pitch: *"was this claim photo generated, was it taken where the loss is claimed, and has it been submitted before?"* That's VERIFY + GEO + CLAIM as a **claims-verification** product, not a surveillance product. Raven itself added "Insurance/Fraud" to its eligible-buyer list — market validation from the incumbent. Target **$15–25k/yr pilots** sold to an SIU director, no procurement office involved.

*Pittsburgh alignment is real here.* Pennsylvania has an Insurance Fraud Prevention Authority that funds SIU work, Pittsburgh is a regional insurance employer base, and hail/wind/water property claims in Western PA are seasonal and high-volume. First calls: regional carriers and mutuals, then TPAs and independent adjusting firms — the latter have the least procurement friction of anyone in the chain.

**Positioning discipline:** in every SIU conversation this is a *fraud-analytics* product. Never lead with geolocation-of-people, never show the Tate-mansion demo, never use the word surveillance. The GEO engine is a claims-verification instrument here, and that framing is also what keeps the legal surface small.

**2. Verified-professional self-serve, $99–199/mo.** Licensed PIs, corporate security, independent adjusters, on a card. Hunchly proves the model at $169/yr with a large PI install base; Picarta charges $59.99/mo. Small dollars, but immediate revenue and real telemetry — and PIs are mostly ex-cops, so they generate LE referrals for later. **Licence verification mandatory** (every state publishes a PI licence lookup).

**3. Two PD pilots at $5–10k, sub-threshold — after SIU revenue exists.** Your existing local relationships, at GeoSpy's exact price point. Sell "investigative lead generation," never "evidence." Peregrine's playbook is the model: embedded inside tiny San Pablo PD, cold-called chiefs, broke out when the platform helped win a murder prosecution — now $2.5B. **Pittsburgh's CCOPS ordinance applies**, so a PD deal there means a published Surveillance Impact Report and a council hearing. Plan for it; don't be surprised by it.

**4. Free tier for verified SAR teams and anti-trafficking NGOs.** Case studies, goodwill, and the moral high ground — GeoSpy did this and it worked.

**Avoid for now:** skip tracers and bail recovery (highest misuse risk), state fusion centers and federal (12–18 month cycles, need a reseller like Carahsoft).

**Documentation the buyer will demand:** SOC 2 Type II or a completed security questionnaire, data-flow diagram, data-residency statement, agency-owns-its-data terms, breach-notification SLA, **Tech E&O + cyber liability $1–5M**, and for AI features increasingly bias/accuracy documentation. In a CCOPS city you'll co-author the Surveillance Impact Report.

---

## 10. BENCH — publish the error rate

This is a module, not an afterthought, because it's the moat.

- **Evaluate on GWS15k** (area-weighted, not landmark-biased) and report Acc@1km/25km/200km/750km/2500km. Also report IM2GPS3k for comparability, clearly labeled as landmark-biased.
- **Hold out a Mapillary-derived test set** from metros not in the index, so we measure generalization honestly.
- Version every model, threshold, and index build. Publish a dated results page.
- Borrow Bellingcat's methodology — their 500-test LLM geolocation studies are the only public methodology in this space.
- For VERIFY, calibrate on a realistic corpus and publish per-band FPR.

**Nobody in this market has published a benchmark.** Being first is worth more than two percentage points of accuracy — it's the answer to the Daubert question, the discovery request, and the procurement security review, all at once.

---

## 11. Build plan

### Status as of 2026-07-29

Phases 1–2 are built. `tsc` clean, `eslint` clean, 70/70 tests, `next build` green. ~18,800 lines.

| Agent | Status | Notes |
|---|---|---|
| A1 Shell | ✅ | Glass primitives, `ConfidenceRing`, MapLibre dark canvas + 3D extrusion, Switzer self-hosted, Pittsburgh fixture page |
| A2 Data | ✅ | 11 migrations, RLS on 15 tables, append-only enforced by triggers + grants, `halfvec` HNSW, region-pruned ANN function. **Not yet applied to any database** |
| A3 Governance | ✅ | Auth, verification, rate limits, audit, jurisdiction gating, corroboration enforcement, magic-link login. Cascade fully wired — `POST /api/search` now returns a typed 503 pointing at `.env.local` rather than a 500 |
| B1 Inference | ✅ | Modal app, 4 models, warm container. **Not deployed** — no Modal account yet |
| B2 Cascade | ✅ | Full orchestrator + verifiers + VERIFY module, 70 tests |
| B3 Harvest | ✅ | Mapillary v4 client + tiling + index build. **No harvest run** — no token yet |
| C1 VEHICLE · C2 (VERIFY shipped in B2) · C3 CASE | ⬜ | Phase 3 |
| D1 BENCH · D2 Demo | ⬜ | Phase 4 |

**Three findings from the build worth carrying forward:**

1. **Mapillary bbox search does not paginate.** Pagination is supported only in combination with `creator_username`, and `limit` caps at 2000. A tile returning exactly 2000 rows is *silently truncated* — no cursor, no error. Tiling a city naively produces an index quietly missing every dense downtown block while still returning plausible-looking neighbours. B3's harvester now treats `len(rows) == limit` as a subdivide signal and recurses. This would have been a very expensive bug to find later.
2. **A2's HNSW index is on the bare column**, and `search_geo_candidates()` orders by `embedding <=> query`. An expression index over a cast (`(embedding::halfvec(512))`) is a *different* index that query can never use — B3 caught this before shipping a `DROP INDEX` that would have silently replaced a working index with an unusable one. Index builds now `REINDEX` so they cannot drift from the catalog definition.
3. **`EIGENPLACES_INPUT_SIZE` is part of the descriptor's identity.** EigenPlaces applies no resize of its own, so the chosen input size is baked into what the vector means. Query and index must use the same value or recall degrades with no error surfacing anywhere. Changing it is a version bump plus a full index rebuild, never an in-place edit.

### Phase 0 — decisions (blocking, §12)

### Phase 1 — Foundation *(3 agents, parallel)*
- **A1 Shell:** Next.js + Tailwind v4 + `DESIGN_SYSTEM.md` tokens; glass primitives; MapLibre + Protomaps dark + Overture 3D extrusion; the progressive-blur header scrim.
- **A2 Data:** Supabase schema — cases, evidence, searches, results, ledger entries, audit log, users/orgs with RLS; immutable append-only audit table; pgvector with `halfvec`, `maintenance_work_mem` set correctly.
- **A3 Auth & governance:** org/role model, identity verification, PI licence validation, per-search audit middleware, jurisdiction gating config, rate limits.

### Phase 2 — GEO core *(3 agents)*
- **B1 Inference service:** Modal app, warm L4, GeoCLIP + EigenPlaces-512 + DINOv2 endpoints, batching, `/embed` and `/health`.
- **B2 Cascade orchestrator:** stages 0–5, confidence calibration, gated VLM escalation with **structured clue schema**, verifier chain (OCR→geocode, ShadowFinder, ecoregion mask).
- **B3 Mapillary harvest:** bbox-driven ingest for metro #1 at 200 img/km, GPS + compass heading retention, dedup, embed, index build; attribution component; **no-unblur technical safeguard** per Mapillary §12.

### Phase 3 — Modules *(3 agents)*
- **C1 VEHICLE:** detector → crop → embed → vPIC-keyed Auto.dev gallery → top-5.
- **C2 VERIFY:** C2PA → metadata/QT forensics → Hive → TruFor; calibrated bands; false-positive-class suppression.
- **C3 CASE + Ledger:** case file, evidence ledger, corroboration workflow, chain of custody, PDF export.

### Phase 4 — Proof *(2 agents)*
- **D1 BENCH:** GWS15k + held-out harness, versioned results page.
- **D2 Demo:** the Miami-style walkthrough on a licensed corpus, plus a rehearsed live geolocation.

Sequence Phase 1 → 2 → 3 → 4, but pipeline within each phase — B2 doesn't need B3 finished to develop against a stub index.

---

## 12. Decisions I need from you

The four blocking decisions are answered — see **Locked decisions** at the top.

**Accounts and keys needed to make what's built actually run** (nothing below is code work):

| # | Need | Unblocks |
|---|---|---|
| 1 | **Supabase project** — then `supabase link` + `db push` | Everything. A2's 11 migrations have never touched a database |
| 2 | **Mapillary API token** (free, instant) | B3's coverage pre-check, then the Pittsburgh harvest |
| 3 | **Modal account** (free tier is enough to start) | B1's inference service; ~$5–12 one-time to embed the Pittsburgh index |
| 4 | **Gemini API key** | Cascade stage 4. Degrades gracefully without it — the stage just skips |
| 5 | *(later)* Hive or similar detector key | VERIFY's statistical layer. Provenance + metadata layers work without it |

**Run the Mapillary coverage pre-check before committing to a harvest.** Community coverage is uneven and Pittsburgh city proper may be thin. It's ~40 requests, standalone, and exits non-zero on NO-GO. The staged fallback is city → inner ring → Allegheny County; note the full county at practical density is ~1.8M vectors, already near the ≤2M-per-metro ceiling.

**Still open, before launch:**

5. **Name.** "Lantage" is one letter from your own **Vantage** project — deliberate, or should these be clearly distinct? Also worth a trademark search; Raven/Graylark are in-market.
6. **Which police departments, and what have you actually told them?** Determines jurisdiction gating and whether CCOPS applies.
7. **Entity + insurance.** Is there an LLC? Any E&O or cyber liability? Municipal contracts will demand $1–5M.
8. **Counsel.** You need a privacy/IP lawyer to bless three things before launch: the Mapillary derived-index posture, the pointer architecture if we build (a), and the CJIS scoping memo. Budget a few thousand dollars.
9. **Rural coverage.** Mapillary is dense in metros, sparse in exurbs. If the target agency is rural, the street index is thin and the honest answer is region-level only.
