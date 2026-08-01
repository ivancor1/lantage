#!/usr/bin/env bash
# End-to-end Greenwich CT harvest. The runbook in executable form — docs/HARVEST.md
# §12 explains every step, expected counts, and how to recover.
#
#   scripts/harvest/greenwich.sh plan                     # no token needed, no network
#   MAPILLARY_ACCESS_TOKEN=MLY|... scripts/harvest/greenwich.sh precheck
#   MAPILLARY_ACCESS_TOKEN=MLY|... scripts/harvest/greenwich.sh all
#
# Metro #1 is Greenwich because the operator lives there. That is the whole argument:
# when the index disagrees with reality, settling it is a walk down the street, not a
# research project. Pittsburgh is still defined — `scripts/harvest/pittsburgh.sh`.
#
# METRO defaults to `greenwich-pilot`, the ~79k-image shoreline box that embeds in an
# afternoon. Widen with METRO=greenwich (or stamford, fairfield-lower); see
# `metros.py --ladder greenwich` for the staging table and the vector budget.
#
# Every stage is resumable and idempotent. Re-running `all` after an interruption picks
# up where it stopped; it does not duplicate rows and does not re-embed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARVEST="$REPO_ROOT/services/harvest"
METRO="${METRO:-greenwich-pilot}"
OUT_DIR="${HARVEST_OUT_DIR:-$REPO_ROOT/data/harvest}"
STAGE="${1:-all}"

PY="${PYTHON:-python3}"
mkdir -p "$OUT_DIR"

CKPT="${HARVEST_DB:-$OUT_DIR/${METRO}.harvest.sqlite}"
PRECHECK_JSON="$OUT_DIR/${METRO}.precheck.json"
MANIFEST_JSON="$OUT_DIR/${METRO}.coverage.json"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die()  { printf '\n\033[1;31m%s\033[0m\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Token gate
# ---------------------------------------------------------------------------
# Refuse early and name the exact place to get one. Mapillary has no anonymous access
# path at all — every request to graph.mapillary.com and tiles.mapillary.com must be
# authorized (verified against the API docs and by probing both hosts on 2026-07-31:
# graph returns OAuthException code 190, tiles return HTTP 403). There is no
# unauthenticated coverage endpoint to fall back on, so nothing below this line can
# run, or be faked, without a token.
require_token() {
  if [[ -z "${MAPILLARY_ACCESS_TOKEN:-}" ]]; then
    cat >&2 <<'EOF'

MAPILLARY_ACCESS_TOKEN is not set — nothing in this pipeline can run without it.

Mapillary exposes no unauthenticated endpoint. Not the Graph API, not the vector
tiles. There is no way to measure coverage first and get a token later.

Getting one is free and takes about a minute:

  1. Sign in at            https://www.mapillary.com
  2. Open                  https://www.mapillary.com/dashboard/developers
  3. Register an application. Read scopes only (read / read:images) — nothing here
     ever writes to Mapillary.
  4. Copy the CLIENT token. It looks like  MLY|<app_id>|<secret>
     That is an app token, not a user token: it is the right kind for a server-side
     batch job and it is what the per-app rate limits are measured against.
  5. export MAPILLARY_ACCESS_TOKEN='MLY|...'   (or put it in .env — gitignored)

No paid tier, no quota to buy, no approval queue. Imagery access costs $0.
See docs/HARVEST.md "Getting a Mapillary token".

EOF
    exit 1
  fi
  case "$MAPILLARY_ACCESS_TOKEN" in
    MLY\|*) ;;
    *) die "MAPILLARY_ACCESS_TOKEN does not start with 'MLY|'. That is the shape of a
Mapillary client token; if yours looks different you probably copied a client ID or a
user token. See docs/HARVEST.md 'Getting a Mapillary token'." ;;
  esac
}

# ---------------------------------------------------------------------------
# plan — projected counts. No token, no network, no dependencies.
# ---------------------------------------------------------------------------
run_plan() {
  "$PY" "$HARVEST/metros.py" --metro "$METRO"
  bold "Staging ladder — widen only after checking the vector budget (MASTER_PLAN §3)"
  "$PY" "$HARVEST/metros.py" --ladder greenwich
}

# The confirmation prompt shows real projected numbers, not a bare y/n, because the
# thing being consented to is a GPU bill and a multi-hour job. Skipped when stdin is
# not a TTY (CI) or CONFIRM=no.
confirm() {
  if [[ "${CONFIRM:-yes}" == "no" ]] || [[ ! -t 0 ]]; then
    echo "(confirmation skipped: CONFIRM=no or non-interactive)"
    return 0
  fi
  echo
  read -r -p "Proceed with the full harvest for '$METRO'? [y/N] " reply
  case "$reply" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) die "Aborted. Nothing was harvested; the checkpoint at $CKPT is untouched." ;;
  esac
}

# ---------------------------------------------------------------------------
# Stages
# ---------------------------------------------------------------------------

run_precheck() {
  require_token
  step "Coverage pre-check — measuring REAL Mapillary density before committing"
  echo "This is the only way to know whether contributors actually drove Greenwich."
  echo "~${SAMPLES:-60} requests, under a minute. Exits non-zero on NO-GO."
  # Greenwich's box is ~30% Long Island Sound, so more samples than Pittsburgh's 40:
  # water tiles are empty for a geographic reason and dilute coverage_fraction.
  # Drop any previous report first: if this run dies before writing one, interpreting
  # a stale file would describe a measurement that is not the one just taken.
  rm -f "$PRECHECK_JSON"
  local rc=0
  "$PY" "$HARVEST/harvest.py" precheck \
    --metro "$METRO" \
    --samples "${SAMPLES:-60}" \
    --json-out "$PRECHECK_JSON" || rc=$?

  # Always interpret, even on a NO-GO — especially on a NO-GO, since that is when the
  # scale mismatch below is most likely to be the reason.
  local ratio_rc=0
  read_precheck_in_context || ratio_rc=$?

  if [[ $rc -ne 0 ]]; then
    if [[ $ratio_rc -eq 0 && "${FORCE:-}" == "1" ]]; then
      bold "harvest.py returned NO-GO on an absolute threshold, but coverage relative to"
      bold "this box's own sizing target is acceptable and FORCE=1 was set. Continuing."
      bold "Record this override wherever you record BENCH caveats."
      return 0
    fi
    printf '\n\033[1;31m%s\033[0m\n' "Pre-check verdict is NO-GO (exit $rc). Nothing was harvested.
If the ratio above is >= 40%, the verdict is a scale mismatch, not a coverage problem:
re-run with FORCE=1 to proceed deliberately. If it is below 40%, widening the bbox buys
more thin area, not more coverage — read coverage_fraction and thinning_ratio in
$PRECHECK_JSON first." >&2
    exit "$rc"   # propagate harvest.py's own code so this still gates a wrapping script
  fi
  return 0
}

# The verdict thresholds in harvest.py are ABSOLUTE (100k GO / 50k NO-GO) and were
# written for a 1,600 km city. Greenwich's pilot box only supports 79k images at
# perfect coverage, so even a flawless pilot harvest cannot reach the 100k GO line and
# a merely-good one can trip the 50k NO-GO line. Read the RATIO to this box's own
# sizing target instead, and say so out loud rather than leaving the operator to
# either distrust a scary word or ignore a real warning.
# Exit 0 if the ratio is healthy enough to proceed, 3 if it genuinely is not.
read_precheck_in_context() {
  [[ -f "$PRECHECK_JSON" ]] || return 0
  "$PY" - "$PRECHECK_JSON" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
target = report.get("sizing_table_target") or 0
got = report.get("projected_indexable_images") or 0
cov = report.get("coverage_fraction")
ratio = (got / target) if target else 0.0
print("\n" + "=" * 74)
print("READ IN CONTEXT — the harvest.py verdict uses absolute thresholds")
print("=" * 74)
print("  sizing-table target for this box   %s" % f"{target:,}")
print("  projected indexable                %s  (%.0f%% of target)" % (f"{got:,}", ratio * 100))
if cov is not None:
    print("  tiles with imagery                 %.0f%%" % (cov * 100))
print()
healthy = ratio >= 0.40
if ratio >= 0.75:
    print("  -> HEALTHY. Mapillary coverage supports the sizing model here.")
elif healthy:
    print("  -> USABLE WITH HOLES. Expect misses in whole neighbourhoods, not just on")
    print("     hard images. Record which ones for BENCH before anyone queries this.")
else:
    print("  -> THIN. Under 40% of the model. Widening the box will not fix a coverage")
    print("     problem; it only buys area that is also thin. Check coverage_fraction")
    print("     and thinning_ratio in %s to tell which it is." % sys.argv[1])
print()
print("  Greenwich's box is roughly 30% Long Island Sound. Water tiles are empty for")
print("  a geographic reason, so coverage_fraction has a ceiling near 0.70 here even")
print("  with perfect contributor coverage. Do not read <50% as automatically bad.")
print("  harvest.py's 100k GO / 50k NO-GO lines and its 'widen to Allegheny County'")
print("  fallback are boilerplate sized for a 1,600 km city. This box supports")
print("  %s images at PERFECT coverage, so those absolute lines cannot mean here" % f"{target:,}")
print("  what they mean there. The ratio above is the number that transfers.")
print("=" * 74 + "\n")
sys.exit(0 if healthy else 3)
PY
}

run_harvest() {
  require_token
  step "Harvest — metadata only, resumable, checkpoint at $CKPT"
  "$PY" "$HARVEST/harvest.py" run \
    --metro "$METRO" \
    --db "$CKPT" \
    --concurrency "${CONCURRENCY:-8}" \
    ${MAX_RECORDS:+--max-records "$MAX_RECORDS"}
}

run_embed() {
  step "Embed — EigenPlaces-512 via B1's inference service. THE LONG STAGE."
  : "${INFERENCE_SERVICE_URL:?set INFERENCE_SERVICE_URL to the B1 Modal endpoint}"
  # thumb_*_url values are short-lived signed CDN URLs, so a 403 at embed time is
  # expected, not exceptional. embed_index.py re-mints them from the Entity API when
  # the token is present — keep it exported for this stage too.
  require_token
  "$PY" "$HARVEST/embed_index.py" \
    --metro "$METRO" \
    --db "$CKPT" \
    --service "$INFERENCE_SERVICE_URL" \
    --target "${EMBED_TARGET:-sqlite}" \
    --batch-size "${BATCH_SIZE:-32}" \
    --concurrency "${EMBED_CONCURRENCY:-4}"
}

run_export() {
  step "Export — MapillaryRecordSchema NDJSON"
  "$PY" "$HARVEST/harvest.py" export --metro "$METRO" --db "$CKPT" \
    --out "$OUT_DIR/${METRO}.ndjson"
  "$PY" "$HARVEST/embed_index.py" --metro "$METRO" --db "$CKPT" \
    --export-embeddings "$OUT_DIR/${METRO}.embeddings.ndjson"
}

run_load() {
  step "Load — upsert into Postgres (idempotent)"
  : "${DATABASE_URL:?set DATABASE_URL}"
  "$PY" "$HARVEST/harvest.py" load --metro "$METRO" --db "$CKPT" --dsn "$DATABASE_URL"
}

run_index() {
  step "Index — HNSW build (maintenance_work_mem=8GB set inside the script)"
  : "${DATABASE_URL:?set DATABASE_URL}"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$HARVEST/build_index.sql"
}

run_stats() {
  step "Stats"
  "$PY" "$HARVEST/harvest.py" stats --metro "$METRO" --db "$CKPT"
}

# ---------------------------------------------------------------------------
# manifest — the row that lets the API say "street precision available here"
# ---------------------------------------------------------------------------
# `mapillary_images` carries `metro` and `index_build` per row, so you can count rows
# for a metro. But a metro slug is not a geometry: nothing in that schema says where
# 'greenwich' *is*, so nothing can decide whether a given lat/lon falls inside it.
# Without this file the UI can only guess, and guessing is exactly what
# assertStreetPrecisionIsEarned() exists to prevent. Emitted from the checkpoint, so
# it needs no Postgres and no extra harvest pass.
run_manifest() {
  step "Coverage manifest — $MANIFEST_JSON"
  [[ -f "$CKPT" ]] || die "No checkpoint at $CKPT. Run the harvest first."
  "$PY" - "$CKPT" "$METRO" "$PRECHECK_JSON" "$MANIFEST_JSON" "$HARVEST" <<'PY'
import json, os, sqlite3, sys

ckpt, metro, precheck_path, out_path, harvest_dir = sys.argv[1:6]
sys.path.insert(0, harvest_dir)
from metros import METRO_SPECS, coverage_manifest_row  # noqa: E402

spec = METRO_SPECS[metro]
db = sqlite3.connect(ckpt)
db.row_factory = sqlite3.Row


def scalar(sql, default=None):
    try:
        row = db.execute(sql).fetchone()
    except sqlite3.Error:
        return default
    return default if row is None else row[0]


index_build = scalar("SELECT value FROM meta WHERE key = 'index_build'")
if not index_build:
    raise SystemExit(
        "checkpoint has no pinned index_build — the harvest never started. "
        "A coverage row without one cannot be joined to mapillary_images."
    )

pre = {}
if precheck_path and os.path.exists(precheck_path):
    with open(precheck_path) as fh:
        pre = json.load(fh)

row = coverage_manifest_row(
    spec,
    index_build=index_build,
    image_count=scalar("SELECT COUNT(*) FROM records", 0),
    embedded_count=scalar("SELECT COUNT(*) FROM records WHERE embedded_at IS NOT NULL", 0),
    distinct_cells=scalar("SELECT COUNT(DISTINCT cell_key) FROM records", None),
    coverage_fraction=pre.get("coverage_fraction"),
    median_capture_year=pre.get("median_capture_year"),
    precheck_path=precheck_path if pre else None,
)

with open(out_path, "w") as fh:
    json.dump(row, fh, indent=2, sort_keys=True)
    fh.write("\n")

print(json.dumps(row, indent=2, sort_keys=True))
if row["embedded_count"] < row["image_count"]:
    print(
        "\n!! %d of %d rows are not embedded. build_index.sql refuses below 95%%."
        % (row["image_count"] - row["embedded_count"], row["image_count"]),
        file=sys.stderr,
    )
if row["target_attainment"] is not None and row["target_attainment"] < 0.40:
    print(
        "\n!! target_attainment %.0f%% — this metro covers its bbox thinly. The API "
        "must NOT advertise street precision across the whole bbox on the strength of "
        "this row; gate per 0.005-deg block, see docs/HARVEST.md §8." % (row["target_attainment"] * 100),
        file=sys.stderr,
    )
PY
}

case "$STAGE" in
  plan)     run_plan ;;
  precheck) run_precheck ;;
  harvest)  run_harvest; run_stats ;;
  embed)    run_embed ;;
  export)   run_export ;;
  load)     run_load ;;
  index)    run_index ;;
  stats)    run_stats ;;
  manifest) run_manifest ;;
  all)
    run_plan
    run_precheck
    confirm
    run_harvest
    run_stats
    run_embed
    run_load
    run_index
    run_manifest
    step "Done. Verify coverage before trusting any street-level result — docs/HARVEST.md §12."
    ;;
  *) echo "usage: METRO=<slug> $0 {plan|precheck|harvest|embed|export|load|index|stats|manifest|all}" >&2
     echo "slugs: greenwich-pilot (default) | greenwich | stamford | fairfield-lower | fairfield" >&2
     exit 2 ;;
esac
