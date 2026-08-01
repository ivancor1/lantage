#!/usr/bin/env python3
"""Union two or more harvest checkpoints into one index. The clean coverage test.

    services/inference/.venv/bin/python services/eval/merge_index.py \
        --out data/harvest/greenwich_union.sqlite \
        data/harvest/greenwich.sqlite data/harvest/greenwich_dense.sqlite

WHY A UNION AND NOT JUST "HARVEST DENSER"
-----------------------------------------
The obvious experiment -- re-harvest the same bbox with finer buckets and compare
-- does not isolate coverage. Re-running the harvester changes the *sample*, not
just its size: different tile subdivision, a different `include_panos`, and a
different set of bucket winners. The Greenwich attempt produced 3,599 rows that
saw only 14,983 candidate images where the original 1,593-row run saw 19,504, so
the "denser" index was in part a *different* index, and it measured worse.

A union is monotone. Every row of every input survives, so the merged index is a
strict superset of each and its coverage ceiling cannot fall. Any change in
recall is then attributable to added references and added distractors, which is
the actual question.

Rows are keyed by `mapillary_id`, so the same image present in both inputs is
stored once. Embeddings must agree on model and dimension across inputs; mixing
descriptor spaces silently returns nonsense rather than an error, so it is
refused here.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sqlite3
import sys

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS records (
  bucket_key TEXT PRIMARY KEY, cell_key TEXT NOT NULL, sector TEXT NOT NULL,
  mapillary_id TEXT NOT NULL UNIQUE, lat REAL NOT NULL, lon REAL NOT NULL,
  compass_angle REAL, captured_at TEXT, thumb_url TEXT, sequence_id TEXT,
  is_pano INTEGER NOT NULL, blur_applied INTEGER NOT NULL, score REAL NOT NULL,
  geom_source TEXT, quality_score REAL, embedded_at TEXT, embed_model TEXT,
  embed_dim INTEGER
);
CREATE TABLE IF NOT EXISTS embeddings (
  mapillary_id TEXT PRIMARY KEY, model TEXT NOT NULL, version TEXT NOT NULL,
  dim INTEGER NOT NULL, vec TEXT NOT NULL, created_at TEXT
);
CREATE TABLE IF NOT EXISTS discards (reason TEXT PRIMARY KEY, n INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS records_cell ON records (cell_key);
"""


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("inputs", nargs="+")
    p.add_argument("--out", required=True)
    args = p.parse_args()

    out_path = pathlib.Path(args.out)
    if out_path.exists():
        out_path.unlink()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    dst = sqlite3.connect(out_path)
    dst.executescript(SCHEMA)

    seen_models: set[tuple[str, int]] = set()
    total_in = 0
    for src_path in args.inputs:
        src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True)
        src.row_factory = sqlite3.Row
        rows = list(
            src.execute(
                """SELECT r.*, e.model AS e_model, e.version AS e_version,
                          e.dim AS e_dim, e.vec AS e_vec, e.created_at AS e_created
                     FROM records r JOIN embeddings e ON e.mapillary_id = r.mapillary_id"""
            )
        )
        total_in += len(rows)
        added = 0
        for r in rows:
            seen_models.add((str(r["e_model"]), int(r["e_dim"])))
            # bucket_key is PRIMARY KEY in the source schema but collides across
            # inputs harvested with different cell sizes, so it is namespaced.
            bkey = f"{pathlib.Path(src_path).stem}:{r['bucket_key']}"
            try:
                dst.execute(
                    """INSERT INTO records(bucket_key, cell_key, sector, mapillary_id,
                         lat, lon, compass_angle, captured_at, thumb_url, sequence_id,
                         is_pano, blur_applied, score, geom_source, quality_score,
                         embedded_at, embed_model, embed_dim)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        bkey, r["cell_key"], r["sector"], r["mapillary_id"], r["lat"],
                        r["lon"], r["compass_angle"], r["captured_at"], r["thumb_url"],
                        r["sequence_id"], r["is_pano"], r["blur_applied"], r["score"],
                        r["geom_source"], r["quality_score"], r["embedded_at"],
                        r["embed_model"], r["embed_dim"],
                    ),
                )
                dst.execute(
                    "INSERT INTO embeddings(mapillary_id, model, version, dim, vec, created_at)"
                    " VALUES(?,?,?,?,?,?)",
                    (r["mapillary_id"], r["e_model"], r["e_version"], r["e_dim"],
                     r["e_vec"], r["e_created"]),
                )
                added += 1
            except sqlite3.IntegrityError:
                pass  # same mapillary_id already merged in from an earlier input
        print(f"[{src_path}] {len(rows):,} embedded rows -> +{added:,} new", file=sys.stderr)
        src.close()

    if len({(m, d) for m, d in seen_models}) > 1:
        raise SystemExit(
            f"refusing to merge mixed descriptor spaces: {sorted(seen_models)}. "
            "Cosine across two models is meaningless and would not error at query time."
        )

    dst.execute(
        "INSERT OR REPLACE INTO meta(key,value) VALUES('params',?)",
        (json.dumps({"metro": "union", "sources": args.inputs, "schema": 1}),),
    )
    dst.execute(
        "INSERT OR REPLACE INTO meta(key,value) VALUES('index_build',?)",
        (f"union({','.join(pathlib.Path(p).stem for p in args.inputs)})",),
    )
    dst.commit()
    n = dst.execute("SELECT COUNT(*) FROM records").fetchone()[0]
    print(
        f"\n[done] {total_in:,} input rows -> {n:,} unique -> {out_path}",
        file=sys.stderr,
    )
    dst.close()


if __name__ == "__main__":
    main()
