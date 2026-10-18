"""Turn a benchmark round's JSON results into the data file the landing site reads.

usage: python benchmarks/site_data.py <results_dir> [--out apps/site/src/data/benchmarks.json]

Reads tpch_sf10.json, tpch_sf100.json and clickbench.json (from bench_tpch.py /
bench_clickbench.py --json) and realistic_sf100.json (from realistic/run.py --out).
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re

NAMES = {
    "iara": "Iara",
    "duckdb": "DuckDB",
    "polars": "Polars",
    "datafusion": "DataFusion",
    "chdb": "chDB",
    "spark": "Spark",
    "daft": "Daft",
}
ORDER = list(NAMES)


def rounded_only(note: str) -> bool:
    """True when a wrong-result note only differs in decimals past the cent (e.g. 0.04 vs 0.0388:
    an engine that keeps the DECIMAL(15,2) scale through a division)."""
    m = re.match(r"wrong result: row \d+: (\(.*\)) != (\(.*\))$", note)
    if not m:
        return False
    try:
        a, b = ast.literal_eval(m.group(1)), ast.literal_eval(m.group(2))
    except (ValueError, SyntaxError):
        return False
    return len(a) == len(b) and all(
        x == y or (isinstance(x, (int, float)) and isinstance(y, (int, float)) and round(x, 2) == round(y, 2)) for x, y in zip(a, b)
    )


def suite(path: str, label) -> dict:
    r = json.load(open(path))
    engines = sorted(r["times"], key=ORDER.index)
    qs = sorted({int(q) for t in r["times"].values() for q in t})
    queries = []
    for q in qs:
        ms = {}
        notes = {}
        for e in engines:
            v = r["times"][e].get(str(q))
            ms[e] = None if v is None else round(1000 * v, 1)
            err = r.get("errors", {}).get(e, {}).get(str(q))
            if err and not rounded_only(err):
                notes[e] = err
        queries.append({"label": label(q), "ms": ms, "notes": notes})
    return {"meta": r["meta"], "engines": engines, "queries": queries}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("results")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "apps", "site", "src", "data", "benchmarks.json"))
    a = ap.parse_args()
    out: dict = {"names": NAMES, "suites": {}}
    for key, file, label in (
        ("tpch_sf10", "tpch_sf10.json", lambda q: f"Q{q}"),
        ("tpch_sf100", "tpch_sf100.json", lambda q: f"Q{q}"),
        ("clickbench", "clickbench.json", lambda q: f"Q{q}"),
    ):
        p = os.path.join(a.results, file)
        if os.path.exists(p):
            out["suites"][key] = suite(p, label)
    p = os.path.join(a.results, "realistic_sf100.json")
    if os.path.exists(p):
        r = json.load(open(p))
        out["realistic"] = [
            {
                "name": w,
                **{
                    e: None if "error" in v else {"s": round(v["seconds"], 2), "mb": round(v["peak_mb"])}
                    for e, v in by_engine.items()
                },
            }
            for w, by_engine in r.items()
        ]
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w") as f:
        json.dump(out, f, indent=1)
    print("wrote", a.out)


if __name__ == "__main__":
    main()
