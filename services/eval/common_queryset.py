#!/usr/bin/env python3
"""Emit the query set that is leakage-clean against EVERY index being compared.

    services/inference/.venv/bin/python services/eval/common_queryset.py \
        --queries data/eval/greenwich_queries_20m.json \
        --db data/harvest/greenwich.sqlite data/harvest/greenwich_dense.sqlite \
        --out data/eval/greenwich_common.json

WHY THIS EXISTS
---------------
`run_eval.py` drops queries that are re-upload duplicates of an index row. That
is correct per-index and *wrong* for comparing indexes: a denser index contains
more rows, so it detects more duplicates, so it evaluates on a smaller and
harder query set. The first Greenwich comparison read 0.546 (172 queries) against
0.487 (160 queries) and looked like a regression, when a chunk of the difference
was simply that the denser index had disqualified 12 more of its own easy
questions.

Scoring both on the intersection removes the confound: same questions, different
corpus, so the delta is attributable to the corpus.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from run_eval import Index, drop_reupload_duplicates  # noqa: E402


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--queries", required=True)
    p.add_argument("--db", nargs="+", required=True)
    p.add_argument("--out", required=True)
    args = p.parse_args()

    doc = json.loads(pathlib.Path(args.queries).read_text())
    queries = doc["queries"]
    print(f"[start] {len(queries)} queries", file=sys.stderr)

    removed_by: dict[str, list[str]] = {}
    for db in args.db:
        index = Index(pathlib.Path(db))
        queries, dropped = drop_reupload_duplicates(queries, index)
        removed_by[db] = [d["queryId"] for d in dropped]
        print(
            f"[{db}] {len(index):,} rows -> dropped {len(dropped)}, {len(queries)} remain",
            file=sys.stderr,
        )

    doc["queries"] = queries
    doc.setdefault("protocol", {})["commonSetAcross"] = args.db
    doc["protocol"]["removedAsReuploadDuplicates"] = removed_by
    doc["protocol"]["note"] = (
        doc["protocol"].get("note", "")
        + " Additionally filtered to the intersection that is duplicate-free "
        "against every index in commonSetAcross, so indexes are compared on "
        "identical questions."
    )
    path = pathlib.Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=2))
    print(f"\n[done] {len(queries)} common queries -> {path}", file=sys.stderr)


if __name__ == "__main__":
    main()
