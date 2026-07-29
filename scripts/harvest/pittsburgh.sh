#!/usr/bin/env bash
# End-to-end Pittsburgh harvest. The runbook in executable form — docs/HARVEST.md
# explains every step, expected counts, and how to recover.
#
#   MAPILLARY_ACCESS_TOKEN=MLY|... scripts/harvest/pittsburgh.sh precheck
#   MAPILLARY_ACCESS_TOKEN=MLY|... scripts/harvest/pittsburgh.sh all
#
# Every stage is resumable and idempotent. Re-running `all` after an interruption
# picks up where it stopped; it does not duplicate rows and does not re-embed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARVEST="$REPO_ROOT/services/harvest"
METRO="${METRO:-pittsburgh}"
OUT_DIR="$REPO_ROOT/data/harvest"
STAGE="${1:-all}"

PY="${PYTHON:-python3}"
mkdir -p "$OUT_DIR"

require_token() {
  if [[ -z "${MAPILLARY_ACCESS_TOKEN:-}" ]]; then
    echo "MAPILLARY_ACCESS_TOKEN is not set. See docs/HARVEST.md 'Getting a Mapillary token'." >&2
    exit 1
  fi
}

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

run_precheck() {
  require_token
  step "Coverage pre-check — measuring real Mapillary density before committing"
  # Exits non-zero on a NO-GO verdict, which is why `all` runs it first and stops.
  "$PY" "$HARVEST/harvest.py" precheck \
    --metro "$METRO" \
    --samples "${SAMPLES:-40}" \
    --json-out "$OUT_DIR/${METRO}.precheck.json"
}

run_harvest() {
  require_token
  step "Harvest — metadata only, resumable, ~15-25 min for Pittsburgh"
  "$PY" "$HARVEST/harvest.py" run \
    --metro "$METRO" \
    --concurrency "${CONCURRENCY:-8}" \
    ${MAX_RECORDS:+--max-records "$MAX_RECORDS"}
}

run_embed() {
  step "Embed — EigenPlaces-512 via B1's inference service. THE LONG STAGE."
  : "${INFERENCE_SERVICE_URL:?set INFERENCE_SERVICE_URL to the B1 Modal endpoint}"
  "$PY" "$HARVEST/embed_index.py" \
    --metro "$METRO" \
    --service "$INFERENCE_SERVICE_URL" \
    --target "${EMBED_TARGET:-sqlite}" \
    --batch-size "${BATCH_SIZE:-32}" \
    --concurrency "${EMBED_CONCURRENCY:-4}"
}

run_export() {
  step "Export — MapillaryRecordSchema NDJSON"
  "$PY" "$HARVEST/harvest.py" export --metro "$METRO" --out "$OUT_DIR/${METRO}.ndjson"
  "$PY" "$HARVEST/embed_index.py" --metro "$METRO" \
    --export-embeddings "$OUT_DIR/${METRO}.embeddings.ndjson"
}

run_load() {
  step "Load — upsert into Postgres (idempotent)"
  : "${DATABASE_URL:?set DATABASE_URL}"
  "$PY" "$HARVEST/harvest.py" load --metro "$METRO" --dsn "$DATABASE_URL"
}

run_index() {
  step "Index — HNSW build (maintenance_work_mem=8GB set inside the script)"
  : "${DATABASE_URL:?set DATABASE_URL}"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$HARVEST/build_index.sql"
}

run_stats() {
  step "Stats"
  "$PY" "$HARVEST/harvest.py" stats --metro "$METRO"
}

case "$STAGE" in
  precheck) run_precheck ;;
  harvest)  run_harvest; run_stats ;;
  embed)    run_embed ;;
  export)   run_export ;;
  load)     run_load ;;
  index)    run_index ;;
  stats)    run_stats ;;
  all)      run_precheck; run_harvest; run_stats; run_embed; run_load; run_index ;;
  *)        echo "usage: $0 {precheck|harvest|embed|export|load|index|stats|all}" >&2; exit 2 ;;
esac
