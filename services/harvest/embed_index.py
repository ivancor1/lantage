#!/usr/bin/env python3
"""Batch-embed harvested Mapillary images via B1's inference service.

    python3 services/harvest/embed_index.py --metro pittsburgh --target sqlite
    python3 services/harvest/embed_index.py --metro pittsburgh --target postgres \
        --service https://<modal-app>.modal.run

Resumable (skips rows with embedded_at set), concurrency-limited, and it never
re-embeds a row it has already written.

WHY 512-d — EigenPlaces, not MegaLoc
------------------------------------
Locked in docs/MASTER_PLAN.md §3 as one of three expensive-to-reverse decisions:

  * pgvector's HNSW dimension ceiling is 2,000 for `vector` and 4,000 for `halfvec`.
    MegaLoc's 8,448-d descriptor cannot be HNSW-indexed in pgvector AT ALL, at any
    price — every query would degrade to a sequential scan over the whole metro.
    512-d sits comfortably inside either limit.
  * Storage: 2.0 GB vs 33.8 GB per million fp32 vectors — 16.5x smaller. As
    `halfvec` (see build_index.sql) 512-d costs ~1 KB/row, so a 320k-row
    Pittsburgh index is ~330 MB of vectors and fits Supabase XL with room to spare.
  * Latency: 0.13 s vs 2.80 s per image — ~21x faster, which is the difference
    between an 8-hour index build and a week-long one, and between a 170 ms and a
    2.9 s retrieval step inside a 10-second SLA.
  * It is not even a quality sacrifice at retrieval: in the arXiv 2507.17455
    ablation EigenPlaces-512 beat BoQ-16384. The small descriptor won.

MegaLoc's role is re-ranking the top 50 after retrieval, where 8,448-d costs 50
comparisons instead of 320,000. Do not put it in this table.

WHAT THIS SCRIPT DOES NOT DO
----------------------------
No OCR, no detection, no crop extraction, no cache of image pixels. Thumbnails are
fetched by the inference service, embedded, and discarded. The only artifact that
lands in the database is a float vector, which is not a reidentifiable image.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import httpx

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from harvest import METROS, DEFAULT_DATA_DIR, Metro, Store, emit  # noqa: E402
from mapillary_api import MapillaryClient, MapillaryError  # noqa: E402

# The retrieval model, per the contract's model enum in schemas.ts.
MODEL = "eigenplaces"
EXPECTED_DIM = 512

# ---------------------------------------------------------------------------
# B1's contract
# ---------------------------------------------------------------------------
# The per-image request/response shapes are PINNED by EmbedRequestSchema and
# EmbedResponseSchema in src/lib/contracts/schemas.ts:
#     request  { imageUrl | imageBase64, models: ['eigenplaces'] }
#     response { embeddings: { <model>: { vector, dim, model, version } }, tookMs }
#
# The *batch envelope* for POST /embed_batch is not in the contract file — B1 owns
# that endpoint. These two keys are the only assumption this script makes about it,
# and they are overridable without touching logic. If B1 ships different names, set
# the env vars; if /embed_batch is not up yet, run with --per-image, which uses only
# the verified single-image shape.
BATCH_ITEMS_KEY = os.environ.get("EMBED_BATCH_ITEMS_KEY", "items")
BATCH_RESULTS_KEY = os.environ.get("EMBED_BATCH_RESULTS_KEY", "results")

DEFAULT_SERVICE = os.environ.get("INFERENCE_SERVICE_URL", "http://localhost:8000")

#: pgvector column name candidates, most-preferred first. A2 owns the migration.
EMBEDDING_COLUMN_CANDIDATES = (
    "embedding",
    "embedding_512",
    "eigenplaces_512",
    "eigenplaces_embedding",
    "vec",
)

_EMBED_SCHEMA = """
CREATE TABLE IF NOT EXISTS embeddings (
  mapillary_id TEXT PRIMARY KEY,
  model        TEXT NOT NULL,
  version      TEXT NOT NULL,
  dim          INTEGER NOT NULL CHECK (dim = 512),
  vec          TEXT NOT NULL,          -- pgvector literal '[a,b,...]', ready to cast
  created_at   TEXT NOT NULL
);
"""


class DimensionViolation(RuntimeError):
    pass


def validate_vector(vector: Sequence[float], model_label: str) -> List[float]:
    """The gate that keeps an un-indexable descriptor out of the index column.

    A MegaLoc vector landing here would be silently un-HNSW-indexable in pgvector
    and would turn every retrieval into a sequential scan over the whole metro. Fail
    loudly instead.
    """
    if len(vector) != EXPECTED_DIM:
        raise DimensionViolation(
            "%s returned dim=%d, expected %d. pgvector's HNSW ceiling is 2000 dims for "
            "`vector` and 4000 for `halfvec`, and mapillary_images.embedding is "
            "halfvec(512) — refusing to store. See docs/MASTER_PLAN.md §3."
            % (model_label, len(vector), EXPECTED_DIM)
        )
    out = [float(v) for v in vector]
    if not all(math.isfinite(v) for v in out):
        raise DimensionViolation("%s returned a non-finite component" % model_label)
    norm = math.sqrt(sum(v * v for v in out))
    if norm == 0.0:
        raise DimensionViolation("%s returned a zero vector" % model_label)
    return out


def to_pgvector_literal(vector: Sequence[float]) -> str:
    """pgvector accepts '[1,2,3]'::vector — cheaper than binary protocol plumbing."""
    return "[" + ",".join("%.7g" % v for v in vector) + "]"


@dataclass
class EmbedStats:
    attempted: int = 0
    written: int = 0
    skipped_already: int = 0
    url_refreshed: int = 0
    failed: int = 0
    dim_violations: int = 0
    unnormalised_warned: int = 0
    service_calls: int = 0
    started: float = field(default_factory=time.monotonic)

    @property
    def elapsed(self) -> float:
        return max(1e-6, time.monotonic() - self.started)

    def snapshot(self, remaining: int) -> Dict[str, Any]:
        rate = self.written / self.elapsed
        return {
            "written": self.written,
            "attempted": self.attempted,
            "failed": self.failed,
            "url_refreshed": self.url_refreshed,
            "dim_violations": self.dim_violations,
            "images_per_sec": round(rate, 2),
            "remaining": remaining,
            "eta_s": round(remaining / rate) if rate > 0 else None,
            "elapsed_s": round(self.elapsed),
        }


# ---------------------------------------------------------------------------
# Write-back targets
# ---------------------------------------------------------------------------


class SqliteSink:
    """Local write-back. Lets the whole pipeline run before A2's table exists."""

    def __init__(self, store: Store) -> None:
        self.store = store
        store.db.executescript(_EMBED_SCHEMA)
        store.db.commit()

    def already_embedded(self) -> int:
        return int(
            self.store.db.execute(
                "SELECT COUNT(*) AS c FROM records WHERE embedded_at IS NOT NULL"
            ).fetchone()["c"]
        )

    def pending(self, limit: Optional[int]) -> List[sqlite3.Row]:
        sql = (
            "SELECT mapillary_id, thumb_url FROM records "
            "WHERE embedded_at IS NULL ORDER BY bucket_key"
        )
        if limit:
            sql += " LIMIT %d" % limit
        return list(self.store.db.execute(sql))

    def write(self, image_id: str, vector: Sequence[float], model: str, version: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        self.store.db.execute(
            "INSERT INTO embeddings(mapillary_id, model, version, dim, vec, created_at) "
            "VALUES(?,?,?,?,?,?) ON CONFLICT(mapillary_id) DO UPDATE SET "
            "model=excluded.model, version=excluded.version, dim=excluded.dim, "
            "vec=excluded.vec, created_at=excluded.created_at",
            (image_id, model, version, len(vector), to_pgvector_literal(vector), now),
        )
        self.store.db.execute(
            "UPDATE records SET embedded_at=?, embed_model=?, embed_dim=? WHERE mapillary_id=?",
            (now, "%s@%s" % (model, version), len(vector), image_id),
        )

    def refresh_url(self, image_id: str, url: str) -> None:
        self.store.db.execute(
            "UPDATE records SET thumb_url=? WHERE mapillary_id=?", (url, image_id)
        )

    def commit(self) -> None:
        self.store.db.commit()

    def close(self) -> None:
        self.store.db.commit()


class PostgresSink:
    """Write-back into A2's `mapillary_images`. Column names are introspected."""

    def __init__(
        self,
        dsn: str,
        table: str,
        id_col: str = "mapillary_id",
        metro: Optional[str] = None,
    ) -> None:
        try:
            import psycopg  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise SystemExit(
                "psycopg is required for --target postgres. "
                "pip install -r services/harvest/requirements.txt"
            ) from exc
        self.conn = psycopg.connect(dsn)
        self.table = table
        self.id_col = id_col
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT column_name, udt_name FROM information_schema.columns "
                "WHERE table_name = %s",
                (table,),
            )
            fetched = cur.fetchall()
        types = {r[0]: r[1] for r in fetched}
        cols = set(types)
        if not cols:
            raise SystemExit(
                "table %r does not exist yet (A2 owns supabase/migrations). Use "
                "--target sqlite until it does — the vectors carry over via "
                "`export-embeddings`." % table
            )
        if id_col not in cols:
            raise SystemExit("table %r has no %r column; columns: %s" % (table, id_col, sorted(cols)))
        self.vec_col = next((c for c in EMBEDDING_COLUMN_CANDIDATES if c in cols), None)
        if not self.vec_col:
            raise SystemExit(
                "no embedding column in %r (looked for %s). A2's migration must add a "
                "vector(512) or halfvec(512) column." % (table, list(EMBEDDING_COLUMN_CANDIDATES))
            )
        # Cast to the column's OWN type, not blindly to `vector`. A2 declares
        # `embedding halfvec(512)`, and pgvector does not provide an implicit
        # vector -> halfvec assignment cast, so `'[...]'::vector` into a halfvec
        # column errors at runtime. Read the declared type and match it.
        self.vec_type = "halfvec" if types.get(self.vec_col) == "halfvec" else "vector"

        # Scope to one metro when the column exists. Without this, embedding
        # "pittsburgh" would also pick up every unembedded row of metro #2 and both
        # would land under the wrong index_build.
        self.metro_col = "metro" if ("metro" in cols and metro) else None
        self.metro = metro
        self.thumb_col = "thumb_url" if "thumb_url" in cols else None
        emit(
            "pg_sink_ready",
            table=table,
            vector_column=self.vec_col,
            vector_type=self.vec_type,
            id_column=id_col,
            scoped_to_metro=self.metro if self.metro_col else None,
        )

    def _scope(self) -> Tuple[str, Tuple[Any, ...]]:
        if not self.metro_col:
            return "", ()
        return " AND %s = %%s" % self.metro_col, (self.metro,)

    def already_embedded(self) -> int:
        scope, params = self._scope()
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM %s WHERE %s IS NOT NULL%s"
                % (self.table, self.vec_col, scope),
                params,
            )
            return int(cur.fetchone()[0])

    def pending(self, limit: Optional[int]) -> List[Tuple[str, str]]:
        scope, params = self._scope()
        sql = "SELECT %s, thumb_url FROM %s WHERE %s IS NULL%s ORDER BY %s" % (
            self.id_col,
            self.table,
            self.vec_col,
            scope,
            self.id_col,
        )
        if limit:
            sql += " LIMIT %d" % limit
        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            return [(str(r[0]), r[1] or "") for r in cur.fetchall()]

    def write(self, image_id: str, vector: Sequence[float], model: str, version: str) -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE %s SET %s = %%s::%s(%d) WHERE %s = %%s"
                % (self.table, self.vec_col, self.vec_type, EXPECTED_DIM, self.id_col),
                (to_pgvector_literal(vector), image_id),
            )

    def refresh_url(self, image_id: str, url: str) -> None:
        if not self.thumb_col:
            return
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE %s SET %s = %%s WHERE %s = %%s" % (self.table, self.thumb_col, self.id_col),
                (url, image_id),
            )

    def commit(self) -> None:
        self.conn.commit()

    def close(self) -> None:
        self.conn.commit()
        self.conn.close()


# ---------------------------------------------------------------------------
# The embedder
# ---------------------------------------------------------------------------


class Embedder:
    def __init__(
        self,
        service_url: str,
        sink: Any,
        *,
        mly: Optional[MapillaryClient] = None,
        batch_size: int = 32,
        concurrency: int = 4,
        per_image: bool = False,
        timeout: float = 300.0,
        max_attempts: int = 4,
    ) -> None:
        self.service_url = service_url.rstrip("/")
        self.sink = sink
        self.mly = mly
        self.batch_size = batch_size
        self.per_image = per_image
        self.max_attempts = max_attempts
        self.concurrency = max(1, concurrency)
        self.sem = asyncio.Semaphore(self.concurrency)
        self.lock = asyncio.Lock()
        self.stats = EmbedStats()
        self.http = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout),
            limits=httpx.Limits(max_connections=concurrency * 2),
            headers={"Content-Type": "application/json"},
        )

    async def aclose(self) -> None:
        await self.http.aclose()

    # -- transport ----------------------------------------------------------

    async def _post(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        attempt = 0
        while True:
            attempt += 1
            try:
                resp = await self.http.post("%s%s" % (self.service_url, path), json=body)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                if attempt >= self.max_attempts:
                    raise RuntimeError("inference transport failure: %s" % exc) from exc
                await asyncio.sleep(min(30.0, 2.0 ** attempt))
                continue
            self.stats.service_calls += 1
            if resp.status_code == 200:
                return resp.json()
            # 429/5xx: the GPU service is warming or saturated. Modal cold starts are
            # exactly this shape, so retry generously rather than losing the batch.
            if resp.status_code in (408, 429, 500, 502, 503, 504) and attempt < self.max_attempts:
                retry_after = resp.headers.get("Retry-After")
                delay = float(retry_after) if (retry_after or "").isdigit() else min(30.0, 2.0 ** attempt)
                emit("inference_retry", status=resp.status_code, attempt=attempt, delay_s=delay)
                await asyncio.sleep(delay)
                continue
            raise RuntimeError(
                "inference %s %s: %s" % (resp.status_code, path, resp.text[:300])
            )

    def _extract(self, payload: Dict[str, Any]) -> Tuple[List[float], str, str]:
        """EmbedResponseSchema -> (vector, model, version)."""
        embeddings = payload.get("embeddings") or {}
        entry = embeddings.get(MODEL)
        if entry is None and len(embeddings) == 1:
            entry = next(iter(embeddings.values()))
        if not isinstance(entry, dict):
            raise RuntimeError(
                "response has no '%s' entry in `embeddings` (got keys %s)"
                % (MODEL, sorted(embeddings))
            )
        vector = entry.get("vector")
        if not isinstance(vector, (list, tuple)):
            raise RuntimeError("embeddings.%s.vector is not an array" % MODEL)
        model = str(entry.get("model") or MODEL)
        version = str(entry.get("version") or "unknown")
        return list(vector), model, version

    # -- URL refresh --------------------------------------------------------

    async def _refresh_thumb(self, image_id: str) -> Optional[str]:
        """Re-mint an expired thumbnail URL from the Entity API.

        `thumb_*_url` values are short-lived signed CDN URLs. A harvest that ran
        yesterday has stale URLs today, so a 403 at embed time is expected, not
        exceptional. The Entity API's 60,000/min ceiling makes re-minting cheap.
        """
        if self.mly is None:
            return None
        try:
            row = await self.mly.get_image(image_id, fields=("thumb_1024_url",))
        except MapillaryError as exc:
            emit("thumb_refresh_failed", mapillary_id=image_id, status=exc.status)
            return None
        url = row.get("thumb_1024_url")
        if not url:
            return None
        self.stats.url_refreshed += 1
        async with self.lock:
            self.sink.refresh_url(image_id, url)
        return str(url)

    # -- units of work ------------------------------------------------------

    async def _embed_one(self, image_id: str, url: str, allow_refresh: bool = True) -> bool:
        try:
            payload = await self._post(
                "/embed", {"imageUrl": url, "models": [MODEL]}
            )
        except RuntimeError as exc:
            if allow_refresh and self._looks_like_stale_url(str(exc)):
                fresh = await self._refresh_thumb(image_id)
                if fresh:
                    return await self._embed_one(image_id, fresh, allow_refresh=False)
            emit("embed_failed", mapillary_id=image_id, error=str(exc)[:200])
            self.stats.failed += 1
            return False
        return await self._store(image_id, payload)

    async def _embed_batch(self, items: List[Tuple[str, str]]) -> None:
        body = {
            BATCH_ITEMS_KEY: [{"imageUrl": url, "models": [MODEL]} for _, url in items]
        }
        try:
            payload = await self._post("/embed_batch", body)
        except RuntimeError as exc:
            # One bad URL in a batch of 32 should not lose the other 31, and a stale
            # signed URL is the most likely cause — fall back to per-image, which can
            # refresh individually.
            emit("batch_failed_falling_back", n=len(items), error=str(exc)[:200])
            for image_id, url in items:
                await self._embed_one(image_id, url)
            return

        results = payload.get(BATCH_RESULTS_KEY)
        if not isinstance(results, list) or len(results) != len(items):
            raise RuntimeError(
                "POST /embed_batch returned %r under key %r; expected a list of %d "
                "EmbedResponse objects. If B1's envelope differs, set "
                "EMBED_BATCH_ITEMS_KEY / EMBED_BATCH_RESULTS_KEY, or run --per-image."
                % (type(results).__name__, BATCH_RESULTS_KEY, len(items))
            )
        for (image_id, url), result in zip(items, results):
            if not isinstance(result, dict) or result.get("error"):
                fresh = await self._refresh_thumb(image_id)
                await self._embed_one(image_id, fresh or url, allow_refresh=False)
                continue
            await self._store(image_id, result)

    async def _store(self, image_id: str, payload: Dict[str, Any]) -> bool:
        try:
            vector, model, version = self._extract(payload)
            vector = validate_vector(vector, "%s@%s" % (model, version))
        except DimensionViolation as exc:
            self.stats.dim_violations += 1
            self.stats.failed += 1
            emit("dimension_violation", mapillary_id=image_id, error=str(exc), severity="error")
            return False
        except RuntimeError as exc:
            self.stats.failed += 1
            emit("embed_malformed_response", mapillary_id=image_id, error=str(exc)[:300])
            return False

        norm = math.sqrt(sum(v * v for v in vector))
        if abs(norm - 1.0) > 0.05 and self.stats.unnormalised_warned < 5:
            # cosine ops + halfvec assume L2-normalised descriptors; that assumption is
            # where the "<1% recall cost" figure in MASTER_PLAN §3 comes from.
            self.stats.unnormalised_warned += 1
            emit(
                "vector_not_l2_normalised",
                mapillary_id=image_id,
                norm=round(norm, 4),
                note="build_index.sql uses cosine ops on halfvec, which assumes ||v||=1",
            )

        async with self.lock:
            self.sink.write(image_id, vector, model, version)
        self.stats.written += 1
        return True

    @staticmethod
    def _looks_like_stale_url(message: str) -> bool:
        low = message.lower()
        return any(t in low for t in ("403", "expired", "forbidden", "url signature", "410", "404"))

    # -- driver -------------------------------------------------------------

    async def run(self, pending: Sequence[Tuple[str, str]], progress_every: int) -> None:
        total = len(pending)
        emit(
            "embed_start",
            pending=total,
            model=MODEL,
            dim=EXPECTED_DIM,
            batch_size=self.batch_size,
            mode="per_image" if self.per_image else "batch",
            service=self.service_url,
        )
        batches: List[List[Tuple[str, str]]] = []
        if self.per_image:
            batches = [[item] for item in pending]
        else:
            for i in range(0, total, self.batch_size):
                batches.append(list(pending[i : i + self.batch_size]))

        done = 0

        async def worker(batch: List[Tuple[str, str]]) -> None:
            nonlocal done
            async with self.sem:
                self.stats.attempted += len(batch)
                if len(batch) == 1:
                    await self._embed_one(*batch[0])
                else:
                    await self._embed_batch(batch)
                async with self.lock:
                    self.sink.commit()
            done += len(batch)
            if done % max(1, progress_every) < len(batch):
                emit("embed_progress", **self.stats.snapshot(total - done))

        # Bounded fan-out: one gather over 10,000 batches would materialise 10,000
        # coroutines and a matching number of sockets before the semaphore ever gets
        # to throttle anything. Walk the work in windows instead.
        window = max(1, self.concurrency * 3)
        for i in range(0, len(batches), window):
            await asyncio.gather(*(worker(b) for b in batches[i : i + window]))

        emit("embed_done", **self.stats.snapshot(0))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def cmd_export_embeddings(store: Store, out: Path) -> int:
    """SQLite embeddings -> NDJSON, for loading once A2's table exists."""
    out.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with out.open("w", encoding="utf-8") as fh:
        for row in store.db.execute(
            "SELECT mapillary_id, model, version, dim, vec FROM embeddings ORDER BY mapillary_id"
        ):
            fh.write(
                json.dumps(
                    {
                        "mapillaryId": row["mapillary_id"],
                        "model": row["model"],
                        "version": row["version"],
                        "dim": row["dim"],
                        "vector": row["vec"],  # already a pgvector literal
                    },
                    separators=(",", ":"),
                )
                + "\n"
            )
            n += 1
    emit("export_embeddings_done", path=str(out), rows=n)
    return n


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="embed_index",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--metro", default="pittsburgh")
    ap.add_argument("--db", help="harvest checkpoint (default data/harvest/<metro>.harvest.sqlite)")
    ap.add_argument("--service", default=DEFAULT_SERVICE, help="B1's inference base URL")
    ap.add_argument("--target", choices=("sqlite", "postgres"), default="sqlite")
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL", ""))
    ap.add_argument("--table", default="mapillary_images")
    ap.add_argument("--batch-size", type=int, default=32, dest="batch_size")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--limit", type=int, default=None, help="stop after N rows (for smoke tests)")
    ap.add_argument("--progress-every", type=int, default=500, dest="progress_every")
    ap.add_argument(
        "--per-image",
        action="store_true",
        dest="per_image",
        help="use POST /embed once per image (only the contract-verified shape)",
    )
    ap.add_argument(
        "--no-url-refresh",
        action="store_true",
        dest="no_url_refresh",
        help="do not re-mint expired thumb URLs from the Mapillary Entity API",
    )
    ap.add_argument("--export-embeddings", help="write SQLite embeddings to NDJSON and exit")
    return ap


async def _run(args: argparse.Namespace) -> int:
    metro: Metro = METROS.get(args.metro) or METROS["pittsburgh"]
    db = Path(args.db) if args.db else DEFAULT_DATA_DIR / ("%s.harvest.sqlite" % metro.slug)
    if not db.exists():
        raise SystemExit(
            "no harvest checkpoint at %s — run `harvest.py run --metro %s` first." % (db, metro.slug)
        )
    store = Store(db)

    if args.export_embeddings:
        store.db.executescript(_EMBED_SCHEMA)
        n = cmd_export_embeddings(store, Path(args.export_embeddings))
        store.close()
        sys.stdout.write("wrote %s embeddings\n" % f"{n:,}")
        return 0

    if args.target == "postgres":
        if not args.dsn:
            raise SystemExit("--dsn or DATABASE_URL is required for --target postgres")
        sink: Any = PostgresSink(args.dsn, args.table, metro=metro.slug)
    else:
        sink = SqliteSink(store)

    already = sink.already_embedded()
    raw_pending = sink.pending(args.limit)
    pending: List[Tuple[str, str]] = [
        (r[0], r[1]) if isinstance(r, tuple) else (r["mapillary_id"], r["thumb_url"])
        for r in raw_pending
    ]
    pending = [(i, u) for i, u in pending if u]
    emit("embed_plan", already_embedded=already, pending=len(pending), target=args.target)
    if not pending:
        sys.stdout.write("nothing to embed — %s rows already have vectors\n" % f"{already:,}")
        sink.close()
        store.close()
        return 0

    mly: Optional[MapillaryClient] = None
    token = os.environ.get("MAPILLARY_ACCESS_TOKEN", "").strip()
    if not args.no_url_refresh and token:
        mly = MapillaryClient(token)
    elif not args.no_url_refresh:
        emit(
            "url_refresh_unavailable",
            note="MAPILLARY_ACCESS_TOKEN unset; expired thumb URLs will fail instead of "
            "being re-minted. Harvest-then-embed same-day, or set the token.",
        )

    embedder = Embedder(
        args.service,
        sink,
        mly=mly,
        batch_size=args.batch_size,
        concurrency=args.concurrency,
        per_image=args.per_image,
    )
    try:
        await embedder.run(pending, args.progress_every)
    finally:
        await embedder.aclose()
        if mly is not None:
            await mly.aclose()
        sink.close()
        store.close()

    s = embedder.stats
    sys.stdout.write(
        "embedded %s / %s (failed %s, dim violations %s, URLs re-minted %s)\n"
        % (f"{s.written:,}", f"{len(pending):,}", f"{s.failed:,}", s.dim_violations, s.url_refreshed)
    )
    return 1 if s.dim_violations else 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    return asyncio.run(_run(build_parser().parse_args(argv)))


if __name__ == "__main__":
    sys.exit(main())
