"""Run realistic workloads, one process per (workload, engine), and report wall time and peak memory.

usage: python benchmarks/realistic/run.py [--engines iara,polars] [--timeout 600] [--rounds 2] [--cold CMD] [--out results.json] [workload ...]

Each round runs the engines in the opposite order of the previous one, and the
best time is kept, so neither engine pays alone for a cold OS file cache.
`--cold CMD` runs CMD (a shell command that empties the OS file cache, e.g.
`sync; echo 3 | sudo tee /proc/sys/vm/drop_caches`) before every run instead:
first reads from disk, for both engines.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def _anon_bytes() -> int:
    """Private (anonymous) resident memory of this process, Linux only."""
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith("RssAnon:"):
                return int(line.split()[1]) * 1024
    return 0


def child(workload: str, engine: str) -> None:
    sys.path.insert(0, HERE)
    import threading

    import psutil
    from workloads import ENGINES, WORKLOADS

    E = ENGINES[engine]()
    fn = WORKLOADS[workload](E)
    # peak private memory: sampled on Linux (memory-mapped input files are
    # resident but reclaimable, and not counted), the commit peak on Windows
    peak_private = [0]
    done = threading.Event()
    if sys.platform.startswith("linux"):

        def sample() -> None:
            while not done.wait(0.05):
                peak_private[0] = max(peak_private[0], _anon_bytes())

        threading.Thread(target=sample, daemon=True).start()
    t = time.perf_counter()
    rows = fn()
    dt = time.perf_counter() - t
    done.set()
    mi = psutil.Process().memory_info()
    if sys.platform.startswith("linux"):
        import resource

        peak_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
        private = max(peak_private[0], _anon_bytes())
    else:
        peak_rss = getattr(mi, "peak_wset", mi.rss)
        private = getattr(mi, "peak_pagefile", 0)
    print(json.dumps({"rows": rows, "seconds": dt, "peak_mb": private / 2**20, "rss_mb": peak_rss / 2**20}))


def run_one(w: str, e: str, timeout: int) -> dict:
    try:
        p = subprocess.run([sys.executable, __file__, "--child", w, e], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"error": f"timeout {timeout}s"}
    if p.returncode != 0:
        return {"error": (p.stderr.strip().splitlines() or ["?"])[-1][:300]}
    return json.loads(p.stdout.strip().splitlines()[-1])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("workloads", nargs="*")
    ap.add_argument("--engines", default="iara,polars")
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--cold")
    ap.add_argument("--out")
    ap.add_argument("--child", nargs=2)
    a = ap.parse_args()
    if a.child:
        child(*a.child)
        return
    sys.path.insert(0, HERE)
    from workloads import WORKLOADS

    names = a.workloads or list(WORKLOADS)
    results = {}
    engines = a.engines.split(",")
    for w in names:
        runs: dict[str, list[dict]] = {e: [] for e in engines}
        for rnd in range(a.rounds):
            for e in engines if rnd % 2 == 0 else engines[::-1]:
                if a.cold:
                    subprocess.run(a.cold, shell=True, check=True, capture_output=True)
                runs[e].append(run_one(w, e, a.timeout))
        results[w] = {}
        for e in engines:
            ok = [r for r in runs[e] if "error" not in r]
            r = min(ok, key=lambda r: r["seconds"]) if ok else runs[e][-1]
            results[w][e] = r
            if "error" in r:
                print(f"{w:26s} {e:7s} ERROR {r['error']}", flush=True)
            else:
                times = " ".join(f"{x['seconds']:.2f}" for x in ok)
                print(f"{w:26s} {e:7s} {r['seconds']:8.2f}s {r['peak_mb']:8.0f} MB private {r.get('rss_mb', 0):8.0f} MB rss rows={r['rows']}  [{times}]", flush=True)
    if a.out:
        with open(a.out, "w") as f:
            json.dump(results, f, indent=1)


if __name__ == "__main__":
    main()
