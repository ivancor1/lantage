# Interior Matching — Which Specific Home Is This?

Research date: **2026-07-30**. Companion to `MASTER_PLAN.md` §8 (MLS interior index — blocked).

Scope: a user uploads an interior frame (typically pulled from a publicly posted video) and wants the
specific property. Building our own embedding index over MLS listing photos is out of scope and
already ruled out — NAR IDX Policy 7.58 plus *VHT v. Zillow* (9th Cir. 2019, affirmed 2023, $1,927,200).
Nothing below proposes indexing listing photos or scraping Zillow/Redfin/Realtor.

---

## 0. The one thing that decides everything

**Reverse image search finds other copies of *your image*. It does not find other photos of *your room*.**

This distinction kills most of the intuitive product ideas, so it goes first.

| | What it actually does | Will it match a video frame to a listing photo of the same room? |
|---|---|---|
| TinEye | Exact matches "including those that have been cropped, edited, or resized." Explicitly *not* similar images | **No** |
| Google Cloud Vision Web Detection | `fullMatchingImages` (identical/near-identical), `partialMatchingImages` (crops of the same image), `visuallySimilarImages` (aesthetic resemblance) | **No** — `visuallySimilarImages` returns "looks like a beige living room", not "is this living room" |
| Google Lens (consumer UI) | Strongest general visual matching; good on commercial/mapped interiors | Occasionally, for hotels/restaurants with heavy Google Maps photo coverage. Essentially never for a private home |
| Yandex Images (consumer UI) | Best-in-class same-*place* retrieval | Sometimes, for well-photographed places. Still no for a private interior |

So: **if the query frame was itself published somewhere, reverse image search will find it, cheaply and
legally.** If the query frame is an original shot by the subject — which is the realistic case for a
video posted to social media — reverse image search returns nothing, forever, no matter how much you
spend on it. Anyone who ships reverse-image-search-as-interior-matching without saying this out loud
has built a feature that silently never hits.

**Second decisive fact.** Private US home interiors are photographed publicly in exactly one place at
scale: the listing. That is the corpus we are barred from indexing. Hotels, short-term rentals and
commercial interiors are the findable subset; owner-occupied homes are not, unless recently listed.
Any honest product must be scoped to *ranked leads plus human verification*, not identification.

Worth noting competitively: **Raven (formerly GeoSpy, `withraven.ai`) does not claim interiors.**
Its four published modules are Geoestimation, Street Targeting, CAR-ID v2.0 and AI/Deepfake
Detection — all outdoor or vehicle. Nobody credible in this space claims interior identification.

---

## 1. Reverse image search — the primary legitimate route

### 1.1 Options compared

| Service | API? | Price (verified) | Interior/listing coverage | Resale posture |
|---|---|---|---|---|
| **TinEye API** | Yes, mature, official client libs | Bundles: 5,000/$200 ($0.04), 10,000/$300 ($0.03), 50,000/$1,000 ($0.02), 1,000,000/$10,000 ($0.01). 2-year validity, auto-replenish at 75% usage | Crawls the open web. Listing photos on public broker/portal pages are in scope. Index "billions" (third-party sources claim 70–79B — **unverified**) | Sold explicitly as the paid tier "for professional, commercial or high-volume users"; free tier is non-commercial only. `MASTER_PLAN.md` already treats it as the one whole-image API licensed for commercial resale — **confirm in the signed API agreement; I could not retrieve the API terms text** (their legal pages are JS-rendered and 403/404 to fetch) |
| **Google Cloud Vision — Web Detection** | Yes | First 1,000/mo free; 1,001–5,000,000 at **$3.50 per 1,000**; >5M contact sales. ~3.5× TinEye's mid-tier | Google's web index — the best coverage available through any API. Returns page URLs, which is what an investigator actually wants | Standard GCP terms; no Maps-style display/caching restriction. Cleanest large-vendor option |
| **Google Lens** | **No official API. None in 2026.** Google's own support position is that Cloud Vision is the answer | — | Best consumer results by a wide margin | Only reachable via scrapers (SerpApi, SearchApi, Apify, ScrapingBee) — see §1.3 |
| **Bing Visual Search** | **Retired 2025-08-11**, all instances decommissioned, no new signups | — | — | Dead |
| **Yandex** | An official Search API exists via Yandex AI Studio with an `ImageSearch` method, but the docs are CAPTCHA-walled and it appears to be *text-query → images*, **not** image → matches. **Treat "official Yandex reverse image API" as unconfirmed** | — | Widely and correctly regarded as the strongest engine for same-place/same-scene retrieval | Russian vendor. Sanctions/export-control review, plus evidentiary-provenance problems for a law-enforcement customer. Do not put it in a server-side paid pipeline |
| **Lenso.ai** | Yes — `lenso.ai/en/page/api`, GitHub examples. Categories include **places**, duplicates, similar/related, faces (gated, separate agreement) | Developer tier = 5,000 API calls/mo; per-tier prices not published | AI-trained category search; "places" is directly on-point | Built by the PimEyes team — reputational adjacency risk for a surveillance-adjacent product. Worth a paid trial as a benchmark, not as a dependency |

### 1.2 Practical accuracy expectations

- **Exact copy** of a published image: TinEye and Vision Web Detection both near-certain.
- **Cropped or re-encoded frame of a published image**: TinEye is designed for this and is the best of
  the APIs at it; Vision surfaces it under `partialMatchingImages`. Expect degradation with heavy crop
  (below roughly a third of the original frame), re-encode + rescale + overlaid text (typical of a
  social repost chain), or a screen-recapture. **Estimate: 40–75% recovery on a moderately mangled
  repost, near-zero once the crop no longer shares a large contiguous region.**
- **Different photo of the same room**: ~0% on every API. See §0.

### 1.3 The SerpApi / Google Lens legal situation (changed this month)

Google sued SerpApi in N.D. Cal. (Judge Yvonne Gonzalez Rogers) over circumventing SearchGuard to
scrape and resell search results. **On 2026-07-20 the court dismissed Google's DMCA §1201 claims.**
Reasoning: anti-scraping technology only qualifies as an access control if it controls access to
*copyrighted* material *with the copyright owner's authority*; uncopyrightable URLs, snippets and facts
don't qualify. Claims over non-copyrighted results were dismissed **without** leave to amend; claims
tied to copyrighted components (e.g. licensed Knowledge Panel images) were dismissed **with** 21 days
to amend. No DMCA claim survived intact at the motion-to-dismiss stage.

- dataflirt.com/blog/google-vs-serpapi-scraping-case/
- lexsummary.com/google-v-serpapi-dmca-search-scraping-access-control/

**Read:** less catastrophic than it looked in December, but do not build on it. Contract, CFAA-style and
ordinary copyright theories are untouched, the case is live with an amendment pending, and the
*surviving* piece is specifically the copyrighted-image subset — which is exactly what a Lens scraper
returns. Also, SerpApi's own terms bar resale, which `MASTER_PLAN.md` already flagged.

### 1.4 What to actually ship: the handoff panel

The legally cleanest and fastest way to give an analyst the strength of Lens and Yandex without
touching either's terms is to **not call them at all**. Host the crop at a short-lived signed URL and
render deep links the analyst clicks:

```
Yandex   https://yandex.com/images/search?rpt=imageview&url=<encoded>
Lens     https://lens.google.com/uploadbyurl?url=<encoded>
TinEye   https://tineye.com/search?url=<encoded>
Lenso    (per their API/UI docs)
```

*(These URL forms are in common OSINT use; I could not retrieve official vendor documentation for the
parameter formats — **verify each by hand before shipping**.)*

We redistribute nothing, cache nothing, resell no one's results. The analyst's own browser session does
the search. Log the handoff to the audit trail so the lead's provenance survives discovery. Days of
work, effectively zero legal surface, and it captures the one engine (Yandex) that is genuinely best
at this and that we cannot use any other way. Pair it with a server-side TinEye call so there is an
automated result too.

---

## 2. Listing-archive services and vendor-held photo indexes

The pivot everyone reaches for: let the vendor hold the index and query it, so the rights problem is
theirs. **I found no vendor that sells this to third parties. It exists only as an MLS's own
consumer-display feature.**

| Vendor | Photo-similarity lookup? | Findings |
|---|---|---|
| **Restb.ai — "Visual Similarities"** | **Yes, but over the customer's own database.** Accepts an arbitrary uploaded photo ("from Google, Instagram or even their own phone"), scores it against ~1,000 visual markers, returns visually similar listings. Powers image search for MLSs | Pricing custom — fixed monthly fee + per-call overage. Third-party estimate **$0.02–$0.10 per image** (askdoss.com, **unverified**). They will not hand us a cross-market national interior index, and if they did the rights problem would not vanish — it would sit with each MLS. `restb.ai/solutions/visual-similarities/` |
| **Cotality / CoreLogic — OneHome AI Image Search** | **Yes.** Upload photos of parts of a house, AI matches them to listings, blended with location/price/size. Live "in participating markets". Backed by Restb.ai per CVR MLS support docs | The single most important data point in this section: **the capability is licensable — but only to an MLS, inside its own agent-invite-only consumer portal.** That is IDX *display*, which is exactly the envelope Policy 7.58 permits and we sit outside of. No third-party API |
| **ATTOM / Slipstream (Home Junction)** | No evidence of any | Real-estate + geospatial web services and JS UI components. No photo-similarity product surfaced, no evidence photos ship at all |
| **Bridge Interactive (Zillow Group)** | No | MLS-member/broker-gated, multi-week approval, new registrations shut and key endpoints deprecated. No image search |
| **HouseCanary** | No | Valuation, property detail, rental estimate, forecast and risk APIs over 100M+ properties. No image product |
| **Repliers** | No image search | Feed access (~$199/mo/MLS per `MASTER_PLAN.md`). Access was never the blocker; the right to index is |
| **Jitty (UK) — "Search by Photo"** | **Yes, consumer.** "Works like a reverse image search, but built for homes", millions of UK property images, matches materials/layout/light | Proof the product is buildable and that someone shipped it. UK only, no API, and **they publish nothing about photo rights** — i.e. they are running exactly the exposure we declined. Not a model to copy, especially with *CoStar v. Zillow* amended March 2026 |

**Verdict on §2: dead end as a purchasable capability.** Nobody will sell us photo-similarity over a
national listing corpus, because nobody holding those photos has the derivative rights to sell.
Worth exactly one phone call: ask Restb.ai whether they would run a *scoped* similarity query as a
service under their own MLS agreements with an indemnity. Expect no. If they say yes, get it in
writing with the indemnity, because that is the only version of this that is safe.

---

## 3. Non-photographic identification from interior cues

### 3.1 What the state of the art actually is

**TraffickCam / Hotels-50K is the definitive prior art for this exact task** and the numbers are the
most useful thing in this document.

Hotels-50K (Stylianou et al., AAAI 2019 — `arxiv.org/abs/1901.11397`,
`github.com/GWUvision/Hotels-50K`): 1,027,871 images, 50,000 hotels, 92 chains, of which 55,061 images
are crowd-sourced from the TraffickCam app across 13,900 hotels; test set 17,954 images from 5,000
hotels. Purpose-built to identify *which specific room* an image was taken in. Now operated by
**Marinus Analytics**, queryable by law enforcement.

Reported baseline **hotel instance** retrieval:

| Condition | Top-1 | Top-10 | Top-100 |
|---|---|---|---|
| Unoccluded | **8.1%** | 17.6% | 34.8% |
| Medium occlusion (person-shaped masks — the realistic case) | **5.9%** | 14.1% | 29.9% |

Chain (not instance) recognition, unoccluded: top-1 42.5%, top-3 56.4%, top-5 62.8%.

Modern numbers, for balance: the **Hotel-ID FGVC9 2022** Kaggle competition (97,553 images, 7,769
hotels, 82 entries) topped out at **MAP@5 = 0.74**. But *Revisiting Hotels-50K and Hotel-ID*
(Feizi et al., ICML 2022 workshop — `arxiv.org/abs/2207.10200`) shows why that number flatters: in the
original splits every test class is seen in training. They rebuild the splits so branches and then
whole chains are genuinely unseen (D_SS → D_SU → D_UU), and AUC drops monotonically across all six
metric-learning losses tested — *and the ranking of the best models changes between settings*.
Performance on seen classes does not predict performance on the real task.

**Take-away for us:** with a million-image purpose-built index and a decade of funded research aimed at
this precise problem, top-1 is single digits and top-100 is a third. Design for top-K + human
verification. Never promise identification.

**Europol "Stop Child Abuse — Trace an Object"** (launched 2017) is the other tell. Faced with the same
problem — identify an interior from background objects — the best-resourced agency in Europe
**crowdsources it to the public**: publish cropped objects, take tips, route to national police.
Reported results: 26 children identified and rescued, 5 offenders prosecuted. That is what the ceiling
looks like when automation isn't available.

### 3.2 A worked case that did succeed

**Molfar Institute, December 2023** — identified a Russian propagandist's exact apartment:
**1 Krasnokazarmennaya Square, Moscow, 5th floor, 55.758551 / 37.686705**, from a video of a cat sitting
at a window. Method: frame-by-frame extraction of landmarks visible *through the window*, then Yandex
+ Google Street View + geospy.ai. The building turned out to be operated by Russia's MoD.
`molfar.institute/en/a-cat-an-elevator-and-a-bottle-of-water-how-subtle-clues-in-videos-or-photos-reveal-exact-locations/`

Note what carried it: **the window**, not the interior. Every interior cue was corroboration. This is
the strongest argument for prioritising §5.

Same source, on interior cues generally: elevator cab design / button style / signage fonts / safety
plaques identify manufacturer and region; reflections in windows and mirrors expose layouts, neighbouring
buildings and signage; electrical outlets narrow country hard (14 plug types worldwide — Type G = UK and
former colonies, Type H = Israel only; the IEC database is the reference).

### 3.3 What Bellingcat actually has — and doesn't

**There is no Bellingcat interior-geolocation guide.** Their published toolkit is outdoor:
OpenStreetMap search tool (2023), ShadowFinder (Aug 2024, shadow → candidate locations), Google Earth
verification (2014).

Their LLM geolocation tests are the honest ceiling on a VLM-only approach. June 2025: 20 models across
OpenAI, Google, Anthropic, Mistral and xAI, on 25 unpublished travel photos from every continent,
prompt "Where was this photo taken?", scored 0–10 against Google Lens. Only OpenAI's o3/o4-mini beat
Lens, narrowly; Gemini underperformed Google's own reverse image search; Claude and Pixtral lagged.
"Deep research" modes often did *worse* than standard. Verdict: "LLMs are no silver bullet."
**The article contains no indoor examples at all.** A follow-up (Aug 2025) found GPT-5 a clear
downgrade on the task.

- `bellingcat.com/resources/how-tos/2025/06/06/have-llms-finally-mastered-geolocation/`
- `bellingcat.com/resources/2025/08/14/llms-vs-geolocation-gpt-5-performs-worse-than-other-ai-models/`

**NYT "Day of Rage"** (Jan 6 Capitol, 2021) matched interior video to building layout over six months.
What made it possible: one known building, a published floorplan, and thousands of overlapping videos.
Not analogous to one frame from one unknown home — but a good demo narrative.

### 3.4 Automatable now / partly / not

| Cue | Automatable? | How |
|---|---|---|
| Electrical outlet & switch type | **Yes** | Detector + lookup → country/region. Cheap, high-confidence filter |
| Appliance model plates, mail, packages, screens, documents | **Yes** | Crop + OCR + brand/model lookup. Highest-value single automation in this section |
| Window compass bearing + time-of-day/date band | **Yes** | Sun azimuth → shadow direction, elevation → length. SunCalc, shadowcalculator.com, Bellingcat ShadowFinder, ShadowTrace. See §5 |
| Reflections in mirrors/glass | **Yes** | Detect + rectify + re-run the *geolocation* pipeline on the reflected content. Reflections are the highest-yield interior cue precisely because they smuggle in an exterior |
| Floor / camera height | **Yes** | Depression angle to a ground feature at known distance; ~3.0–3.5 m per floor is the standard literature assumption. §5 |
| TV / broadcast content on screen | **Partly** | Frame → OCR/logo → match against timestamped broadcast archives. Gives chronolocation and country. Needs an archive licence |
| Floorplan matching | **Verification only** | Real research exists — PALMS+ (`arxiv.org/html/2511.09724`), FP-Loc 2.0, plan-to-image registration via synthetic panoramas (ScienceDirect S0926580525007034), NadirFloorNet (CVPRW 2025). **All assume you already hold the candidate floorplan.** Excellent for confirming "is this that unit"; useless for searching "which unit is this" |
| Fixture / furniture / builder-model identification | **No** | This is Europol's crowdsourcing problem. Do not promise it |

**GeoEvident** (`geoevident.com`, operated by **Custody Lens Limited**, Warsaw) is a direct competitor
that *does* claim interior identification: hotel and apartment candidates from layouts, furnishings and
distinctive details, "often in under a minute", ranked candidates with confidence scores, forensic
documentation, no GPS/EXIF needed, enterprise-only pricing. **No published accuracy.** Buy a seat and
benchmark it before believing any of it — it is the cheapest way to find out whether the interior claim
is achievable at all.

---

## 4. Airbnb / short-term rental

STR listings are the densest public corpus of interior photography that exists. The rights are just as
closed as MLS, and the data vendors sell numbers instead of pixels.

| Source | Status |
|---|---|
| **Airbnb API** | Partner-only — PMSs and channel managers. No public signup. API ToS grants a "limited, worldwide, royalty-free, **revocable, non-transferable, non-sublicensable**, non-assignable and non-exclusive licence." Non-sublicensable alone ends the idea |
| **Airbnb site ToS** | Expressly prohibits scraping, bots and crawlers, and calls out `/s/*` (search), `/rooms/*` (listing detail) and `/calendar/*` by name. Photos are host copyright. Hard anti-bot defences |
| **Vrbo / Expedia** | Same partner-API shape |
| **AirDNA** | 10M+ Airbnb/Vrbo listings, 120k markets, enterprise API, Bearer auth. Fields are occupancy, ADR, RevPAR, revenue, Rentalizer/Smart Rates, comp sets. **No evidence of listing photos or image URLs** |
| **Lighthouse (formerly Transparent)** | Review count/score/description and analytics. **No photos evidenced** |
| **Key Data** | PMS-sourced real-time performance data for managers. **No photos evidenced** |
| **AirROI, Mashvisor, AllTheRooms** | Same pattern — metrics, not imagery |
| **Inside Airbnb** | Dataset is **CC BY 4.0**. I verified by download (Albany, 2026-06-16) that `listings.csv.gz` contains **`picture_url`**, plus `listing_url`, `host_picture_url`, `host_thumbnail_url` |

**Inside Airbnb is an attractive trap.** Four reasons not to touch it:

1. **One cover photo per listing** — the hero shot, usually exterior or a staged wide. Not the interiors
   you need to match against.
2. **The CC licence covers the CSV, not the photos.** The photos sit on Airbnb's CDN and belong to the
   hosts. Inside Airbnb cannot grant rights it never held — the identical defect that sinks the
   "ATTOM/Repliers will license us the photos" theory in `MASTER_PLAN.md` §8.
3. **Collected by scraping in breach of Airbnb's ToS.** Indexing it inherits that provenance, in
   writing, on a public download page. Worse discovery posture than MLS, not better.
4. CDN URLs rotate and expire.

**Verdict on §4: dead end.** The one legitimate STR play is that hotels and STRs are the *findable*
subset for reverse image search and for TraffickCam-style queries — because their interiors are
published by design and, for hotels, an existing law-enforcement index already covers them. Route
hotel/STR-looking frames to Marinus Analytics/TraffickCam via the customer's own agency access rather
than trying to rebuild it.

---

## 5. Window-view geolocation — the differentiated capability

If any exterior is visible, the problem collapses into the geolocation problem we already solve, and
we already hold the assets. This is the highest-leverage section in the document.

**Precedent:** the Molfar case (§3.2) resolved to a floor of a specific Moscow building from a window
view behind a cat.

### 5.1 Three exploitable signals from a partial window view

**Skyline / silhouette matching.** Established literature:
- Camera pose from images by skyline matching against 3D city models — `ieeexplore.ieee.org/document/6738749`
- "Geolocalization using Skylines from Omni-Images" — `researchgate.net/publication/224135381`
- Camera orientation by aligning an observed skyline to a DEM-synthesised skyline — Stanford EE367
  Winter 2026 project, `web.stanford.edu/class/ee367/Winter2026/posters/poster_twarog.pdf`

For terrain, silhouette matching against generated panoramas (udeuschle-style, PeakFinder-style) is
standard OSINT practice and works from a surprisingly small slice of ridgeline.

**Reverse viewshed — "which windows could see this?"** This is the part nobody ships.
- `jancaha.github.io/cpp-viewshed-library/` — C++ library explicitly supporting **inverse viewshed**
  and visibility indices
- QGIS `ViewshedAnalysis` plugin
- The Esri community consensus is that automatically *finding* observer points is not a standard GIS
  operation — i.e. this is an open gap, not a solved commodity

We already ingest **Overture Maps building footprints with real `height` / `num_floors`, some
lidar-derived** (`HARVEST.md`). That is precisely the input an inverse viewshed needs. Given a
metro plus an identified building silhouette in the window, we can enumerate the candidate
(building, façade, floor) triples whose sightline reproduces the observed geometry. **As far as I
found, no product does this.** It is the one capability in this document that is both defensible and
unoccupied.

**Sun geometry through the window.** Azimuth sets shadow direction, elevation sets length. A sunlit
patch on an interior floor or wall, with a known window position, yields the window's compass bearing
plus a date/time band. Tooling: `suncalc.org`, `shadowcalculator.com`, Bellingcat **ShadowFinder**
(open source), ShadowTrace (multi-photo intersection → probability maps). These are **filters**, not
identifications — but a bearing plus a floor estimate plus a metro cuts the candidate set by orders of
magnitude before any expensive matching runs.

**Floor / camera height.** Depression angle to a ground feature at known distance gives camera height;
divide by ~3.0–3.5 m per storey. Forensic-grade tooling exists and has court history (PhotoModeler,
Amped FIVE), which matters for an investigative product.

### 5.2 Recommended pipeline

```
frame → window/glazing detection → segment exterior region (and any mirror/glass reflections)
      → skyline + building-silhouette extraction
      → sun geometry  → window bearing + date/time band
      → depression angle → camera height → floor estimate
      → inverse viewshed over Overture 3D buildings, filtered by bearing + floor
      → ranked (building, façade, floor) candidates → existing GEO pipeline for verification
```

Every stage reuses infrastructure we already have. Nothing here touches anyone's copyrighted photos.

---

## 6. Customer-supplied corpus — the only route with a real hit rate

The strongest business framing and the only one where the target is *guaranteed to be in the index*.
Customer owns the imagery (insurer claim photos, agency case files) and grants processing rights in the
MSA. Zero copyright exposure, zero data-licensing line item. This is `MASTER_PLAN.md` §8(c) / CLAIM.

### 6.1 Model choice

**DINOv2 is the consensus backbone for indoor retrieval.** The specific configuration to copy:

**AnyLoc** (`arxiv.org/abs/2308.00688`, RA-L; `github.com/AnyLoc/AnyLoc`, `anyloc.github.io`) —
DINOv2 **layer 31, "value" facet**, VLAD aggregation. Native descriptor 49,152-d, **reducible to 512-d
by PCA-whitening "with minimal performance loss"** — which lands exactly on our existing
`halfvec(512)` pgvector schema.

Indoor Recall@1:

| Dataset | AnyLoc-VLAD-DINOv2 | MixVPR | NetVLAD | CosPlace |
|---|---|---|---|---|
| Baidu Mall (689 ref / 2,292 query, heavy perceptual aliasing) | **75.2%** | 64.4% | 53.1% | 41.6% |
| Gardens Point (day/night, indoor–outdoor) | **95.5%** | 91.5% | 58.5% | 74.0% |
| 17 Places (clutter, lighting variation) | **65.0%** | 63.8% | 61.6% | 61.1% |

Highest recall on **all** indoor datasets; +5% over MixVPR and +20% over CosPlace on average.

**MegaLoc** (`arxiv.org/abs/2502.17237`, CVPRW 2025; `github.com/gmberton/MegaLoc`) — one retrieval
model, SOTA on most VPR datasets "**including indoor and outdoor ones**", plus SOTA visual localization
on LaMAR. **This is the current best single off-the-shelf checkpoint. Start here, ablate against
AnyLoc.**

Also active on indoor benchmarks, all DINOv2-based: **SALAD** (optimal-transport aggregation),
**SciceVPR** (2025), **DD-DPFE** (2025), **DINO-Mix**.

CLIP is not the right tool here. Indoor discrimination lives in fine-grained texture — bedsheet
patterns, grout lines, trim profiles — which is what DINOv2's self-supervised features capture and what
CLIP's language-aligned features throw away.

### 6.2 Realistic accuracy for same-room-different-angle

- **Baidu Mall / 17 Places *are* the same-place-different-viewpoint task.** So with the place in the
  index and a modest corpus, expect **R@1 ≈ 65–75%**, R@5 materially higher.
- **Hotels-50K is the warning about scale.** At 50,000 places and occluded queries, top-1 collapses to
  5.9%. Corpus size and occlusion dominate everything else.
- **Design consequence:** scope the corpus (one carrier, one region, one case file — never national),
  return top-K not top-1, and add a **geometric verification** stage over the top-K (LoFTR /
  SuperGlue-class local feature matching) to kill false positives before an analyst sees them.

### 6.3 Buy vs build for the near-duplicate case

For true near-duplicates — the recycled-claim-photo pattern — **TinEye MatchEngine** is a hosted
private index and is cheaper than building:

| Plan | Images | Searches/mo | Price |
|---|---|---|---|
| Starter | 5,000 | 1,000 | **$200/mo** |
| Basic | 50,000 | 30,000 | **$500/mo** |
| Corporate | 500,000 | 150,000 | **$1,500/mo** |
| Enterprise | up to 500M | up to 50M | Custom |

Month-to-month, no annual commitment, cloud **and on-premise**. Finds "duplicate, modified and even
derivative images in your reference image collection."
`help.tineye.com/article/211-matchengine-pricing`

**On-premise matters** — an insurer's SIU corpus may not be allowed to leave their environment, and it
sidesteps the CJIS-adjacent data-residency questions in `MASTER_PLAN.md` §7.

**Competitive reality on the insurance side.** Duplicate-claim-image detection is already a product
category: **Verisk Digital Media Forensics**, **Vaarhaft** (AI fingerprinting + SafeCam, explicitly
marketed for duplicate-claim-image fraud), **CheckReality**, **ProofSnap** (C2PA/SynthID/EXIF, local
processing). Byte-level and fingerprint-level duplicate detection is commoditized. **Our differentiator
must be same-scene retrieval across different angles and lighting** — the DINOv2/MegaLoc capability —
not dupes. Lead with "the same roof photographed from a different angle in a different claim two years
apart", which none of the fingerprint vendors can do.

---

## 7. Honest verdict

### Ranked by shippability

| # | Route | Ship in days? | Legal exposure | Hit rate on a realistic input | Verdict |
|---|---|---|---|---|---|
| 1 | **Handoff panel** — crop → signed URL → deep-link out to Yandex / Lens / TinEye / Lenso, log the handoff | **Yes, 2–3 days** | **~Zero.** We index nothing, cache nothing, resell nobody's results | Low as automation, but it puts the best engine on Earth (Yandex) in the analyst's hands and it is honest about being a human step | **Ship first.** Cheapest credibility in the product |
| 2 | **TinEye API** on the frame, server-side | **Yes, 1–2 days** | Low — licensed commercial tier. *Confirm resale in the signed agreement* | **Low.** Only hits if the frame itself was published. But $0.01–0.04/search and it costs nothing to always try | **Ship.** Already the choice in `MASTER_PLAN.md` §6 |
| 3 | **Window-view extraction → existing GEO pipeline** | Extraction days; inverse viewshed **2–4 weeks** | **Zero** | **Highest of any public-data route** when a window is visible. Molfar resolved a floor of a specific building this way | **Ship, and make it the headline.** Only unoccupied capability here |
| 4 | **VLM interior-cue fingerprint** — outlets, model plates, mail, OCR, sun geometry, style/region → structured filters + human search | **Yes, ~1 week** | Zero | Never identifies alone; always produces usable narrowing. Bellingcat's measured verdict caps the claim | **Ship as an evidence panel, never as an answer.** Presents as investigator-grade rather than magic |
| 5 | **Customer corpus index** — MegaLoc/AnyLoc DINOv2 → 512-d → pgvector, + geometric verification on top-K | 2–4 weeks | **Zero** (customer grants rights in MSA) | **R@1 ≈ 65–75% on a scoped corpus** — by far the best number in this document, because the target is guaranteed to be indexed | **This is the product.** Everything above is the free-tier teaser |
| 6 | Buy **MatchEngine** for the near-dup slice | Days | Zero | Near-certain on true dupes | Buy at $500/mo before building. Note dupes are commoditized |
| 7 | Benchmark **GeoEvident** as a competitor/oracle | Days (procurement) | Zero | Unknown — no published accuracy | Worth the seat purely to learn whether interior ID is achievable |

### Dead ends — say these out loud

1. **Our own listing-photo index.** Settled: IDX 7.58 + *VHT v. Zillow*, $1.93M. `MASTER_PLAN.md` §8.
2. **Reverse image search to match a *different photo* of the same room.** The single most likely way to
   ship something that silently never returns a hit. TinEye is explicit that it finds exact matches
   including cropped/edited/resized, *not* similar images. Google's `visuallySimilarImages` is aesthetic
   resemblance. Do not let this into a demo script or a sales deck.
3. **Buying a national photo-similarity lookup from a real-estate vendor.** Doesn't exist for third
   parties. Restb.ai searches the *customer's* database; Cotality's OneHome AI Image Search is an
   MLS-owned consumer-display feature. Nobody holding the photos has the derivative rights to sell.
4. **Inside Airbnb as a photo corpus.** One hero photo per listing, CC licence that cannot cover the
   photos, scraped in breach of Airbnb's ToS, expiring CDN URLs. Same *VHT*-shaped exposure with a
   documented worse provenance.
5. **Scraping Airbnb / Vrbo.** Express ToS prohibition naming the exact endpoints, non-sublicensable
   partner API, host-owned copyright, hard anti-bot.
6. **STR data vendors as an image source.** AirDNA, Lighthouse, Key Data, AirROI, Mashvisor sell
   metrics. Confirm with each, but expect no photos.
7. **Bing Visual Search.** Retired 2025-08-11.
8. **Google Lens via scrapers, as core infrastructure.** No official API in 2026. Google's suit against
   SerpApi lost its DMCA claims on 2026-07-20 but is live with an amendment pending on exactly the
   copyrighted-image subset, and SerpApi's own terms bar resale.
9. **An official Yandex reverse-image API.** Unconfirmed to exist; the AI Studio `ImageSearch` method
   looks like text→images. Plus sanctions review and evidentiary provenance. Use Yandex only via §7.1
   handoff.
10. **LLM-only interior identification as a marketing claim.** Bellingcat: 20 models, 25 photos, only
    o3/o4-mini beat Google Lens and only narrowly; "no silver bullet"; zero indoor examples tested.
11. **Fixture and furniture model identification at scale.** Europol crowdsources this to the public.
    Do not claim automation.

### The line to hold in the deck

> For a private home, we return **ranked leads with the evidence for each**, and the strongest lead
> almost always comes from what's visible through a window — not from matching the furniture. For
> hotels and short-term rentals, published interiors make reverse image search and existing
> law-enforcement indexes viable. For a customer's own corpus, we do genuine same-scene retrieval at
> roughly 65–75% top-1 on a scoped index.

That is defensible, it survives a technical customer, and every number in it is sourced.

---

## 8. Unverified / open items

Flagging these so nobody treats them as settled:

- **TinEye API terms of use — could not retrieve.** Legal pages are JS-rendered; direct fetches 403/404.
  `MASTER_PLAN.md` asserts TinEye is the one reverse-image API licensed for commercial resale.
  **Get the resale and sublicensing clauses in the signed agreement before the claim goes in a deck.**
- **TinEye API bundle prices.** The $200/$300/$1,000/$10,000 ladder traces to a TinEye blog post dated
  2015-08-03; `help.tineye.com/article/169` still lists the same four bundle sizes and third-party
  sources still quote $200/5,000, so pricing looks unchanged. Confirm at purchase.
- **TinEye index size.** TinEye's own site says "billions". The 70–79 billion figures are third-party.
- **Yandex AI Studio `ImageSearch`** — docs CAPTCHA-walled. Whether any official image→matches endpoint
  exists is unresolved.
- **Restb.ai and Lenso.ai pricing** — not published. The $0.02–$0.10/image Restb.ai figure is a
  third-party estimate.
- **Reverse-image deep-link URL parameter formats** — in common OSINT use, but I found no official vendor
  documentation. Verify each by hand.
- **Recovery-rate estimates for cropped/re-encoded frames (40–75%)** — my estimate, not measured. Cheap
  to measure properly: 200 known listing photos, apply a crop/rescale/re-encode ladder, run TinEye and
  Vision Web Detection, plot recovery vs distortion. **Do this before quoting a hit rate to anyone.**
- **AirDNA / Lighthouse / Key Data photo fields** — absence of evidence, not evidence of absence.
  One email each settles it.

---

## Sources

Reverse image search
- https://services.tineye.com/TinEyeAPI · https://blog.tineye.com/new-image-search-pricing/ · https://help.tineye.com/article/169-purchasing-search-bundles
- https://help.tineye.com/article/211-matchengine-pricing · https://services.tineye.com/MatchEngine
- https://cloud.google.com/vision/pricing · https://docs.cloud.google.com/vision/docs/detecting-web
- https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement
- https://lenso.ai/en/page/api · https://github.com/lenso-ai/reverse-image-search-api
- https://aistudio.yandex.ru/docs/en/search-api/concepts/image-search *(CAPTCHA-walled)*
- https://dataflirt.com/blog/google-vs-serpapi-scraping-case/ · https://lexsummary.com/google-v-serpapi-dmca-search-scraping-access-control/
- https://networkedcurator.doingdh.org/day-2/tineye-tutorial/

Real-estate vendors
- https://restb.ai/solutions/visual-similarities/ · https://restb.ai/company/faq/
- https://www.bridgeinteractive.com/developers/bridge-api/ · https://repliers.com/repliers-vs-bridge-interactive/
- https://slipstream.homejunction.com · https://api.developer.attomdata.com
- https://jitty.com/post/reverse-image-search

Interior identification prior art
- https://arxiv.org/abs/1901.11397 · https://github.com/GWUvision/Hotels-50K · https://www2.seas.gwu.edu/~pless/papers/Hotels50k.pdf
- https://arxiv.org/abs/2207.10200 · https://github.com/aarashfeizi/revisited-hotels
- https://www.kaggle.com/competitions/hotel-id-to-combat-human-trafficking-2022-fgvc9 · https://clist.by/standings/hotel-id-to-combat-human-trafficking-2022-fgvc9-public-safety-image-data-38475102/
- https://www.europol.europa.eu/stopchildabuse
- https://www.molfar.institute/en/a-cat-an-elevator-and-a-bottle-of-water-how-subtle-clues-in-videos-or-photos-reveal-exact-locations/
- https://www.bellingcat.com/resources/how-tos/2025/06/06/have-llms-finally-mastered-geolocation/
- https://www.bellingcat.com/resources/2025/08/14/llms-vs-geolocation-gpt-5-performs-worse-than-other-ai-models/
- https://www.bellingcat.com/resources/2024/08/22/shadow-geolocate-geolocation-locate-image-tool-open-source-bellingcat-measure/
- https://www.nytimes.com/2021/06/30/us/jan-6-capitol-attack-takeaways.html
- https://geoevident.com/ · https://withraven.ai/

STR
- https://www.airbnb.com/terms/api_terms · https://apidocs.airdna.co · https://insideairbnb.com/get-the-data/
- Verified by download: `https://data.insideairbnb.com/united-states/ny/albany/2026-06-16/data/listings.csv.gz` contains `picture_url`

Window view / geolocation
- https://ieeexplore.ieee.org/document/6738749 · https://www.researchgate.net/publication/224135381
- https://web.stanford.edu/class/ee367/Winter2026/posters/poster_twarog.pdf
- https://jancaha.github.io/cpp-viewshed-library/ · https://plugins.qgis.org/plugins/ViewshedAnalysis/
- https://www.suncalc.org · https://shadowcalculator.com

Indoor place recognition
- https://arxiv.org/abs/2308.00688 · https://github.com/AnyLoc/AnyLoc · https://anyloc.github.io
- https://arxiv.org/abs/2502.17237 · https://github.com/gmberton/MegaLoc
- https://arxiv.org/html/2511.09724 (PALMS+) · https://fplocextension.github.io (FP-Loc 2.0)

Insurance photo fraud
- https://www.verisk.com/resources/campaigns/digital-media-forensics/ · https://www.vaarhaft.com/blog/duplicate-claim-image-fraud-prevention
