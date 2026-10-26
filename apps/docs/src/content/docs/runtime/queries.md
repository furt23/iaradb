---
title: Query Tracking & Cancellation
description: Inspecting in-flight queries and cancelling executions.
---

### How it works

Each query registers a handle in a process-wide registry while it runs. The handle holds a cancel flag and the counters of each pipeline: morsels done, rows in and out, elapsed time. Any thread can read the registry or set the flag. Workers check the flag between morsels and between batches, so a cancelled query stops at its next check. A batch is 8,192 rows by default, and a remote read checks the flag every 50 ms while it waits and drops its requests once cancelled. A query started inside another query on the same thread, such as a materialized CTE, is part of the outer query and is cancelled with it.

### Query Observability

All running queries register an observable handle in a global process registry. You can inspect queries currently executing across threads:

```python
import iara

active_queries = iara.running_queries()
for q in active_queries:
    done = sum(p["morsels_done"] for p in q["pipelines"])
    print(f"Query {q['id']}: running for {q['elapsed_ms']:.0f}ms, {done} morsels done")
```

Each entry is a dict with `id`, `elapsed_ms`, `cancelled`, `memory_peak`, `spilled_bytes`, `requests` (the storage requests of this query), `pipelines` and `pending`. Each pipeline has `source`, `operators`, `sink`, `morsels_total`, `morsels_done`, `rows_in`, `rows_out`, `elapsed_ms` and `finished`. `pending` lists the pipelines that are planned but not started. A query leaves the list when it ends.

---

### Cancelling Queries

You can abort a long-running or stalled query on demand using `iara.interrupt()` or `iara.cancel_query()`:

```python
# Cancel one query by its id (an integer, as in running_queries())
iara.cancel_query(active_queries[0]["id"])   # True if the query was running

# Cancel every running query; returns how many there were
iara.interrupt()
```

Execution pipelines verify cancellation tokens between batch iterations and terminate workers promptly without corrupting process memory.

A cancelled query raises `iara.QueryCancelled` (with the message `Query cancelled`) in the thread that was running it, and returns no result. Cancelling is a request: the query stops at its next check, and a remote read that is waiting stops within 50 ms. Spill files the query wrote are deleted as it unwinds.
