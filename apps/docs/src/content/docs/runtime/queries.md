---
title: Query Tracking & Cancellation
description: Inspecting in-flight queries and cancelling executions.
---

### Query Observability

All running queries register an observable handle in a global process registry. You can inspect queries currently executing across threads:

```python
import workhouse

active_queries = workhouse.running_queries()
for q in active_queries:
    print(f"Query {q['id']}: running for {q['elapsed_ms']}ms, produced {q['rows_out']} rows")
```

---

### Cancelling Queries

You can abort a long-running or stalled query on demand using `workhouse.interrupt()` or `workhouse.cancel_query()`:

```python
# Interrupt by query ID
workhouse.interrupt("q_98ac12")
```

Execution pipelines verify cancellation tokens between batch iterations and terminate workers promptly without corrupting process memory.
