---
title: Resource & Memory Management
description: Configuring threads, memory thresholds, and disk spill behavior.
---

### How it works

Queries run on one global Rayon thread pool. A pipeline splits its source into morsels: a Parquet row group, a byte range of a CSV file, or a slice of an in-memory table. The workers take morsels in turn and push each one through the pipeline's operators. Remote reads run on a separate I/O runtime. `collect()` releases the Python GIL while the query runs, so other Python threads keep going.

Operators that hold data reserve their memory from one pool shared by the whole process: aggregation tables, join build sides, sort buffers and window buffers. When a reservation would go over the limit, the operator writes its state to disk as LZ4-compressed Arrow IPC files and reads it back in batches. Batches in flight are not counted. The limit is 75% of the machine's RAM by default. At the start of each query it is lowered to the memory that is free then, but never below half of the default. A limit set with `set_memory_limit()` stays fixed until it is changed.

---

### Thread Pool Sizing

Iara utilizes a global Rayon work-stealing thread pool. By default, it allocates one worker thread per logical CPU that the operating system reports.

```python
import iara

# Size the worker pool before running queries
iara.set_num_threads(8)

# Check active thread count
print(iara.num_threads())
```

The pool is created by the first query, or by the first `set_num_threads` call, and cannot be resized afterwards. A call made after a query has run fails:

```python
>>> iara.set_num_threads(2)   # after a query has run
IaraError: Execution error: thread pool already initialised: The global thread pool has already been initialized.
```

---

### Memory Management & Spilling

The engine manages operator memory through a centralized memory pool. Beyond the limit, operators spill intermediate state to temporary Arrow IPC files on disk.

```python
# Set memory limit to 4 gigabytes
iara.set_memory_limit("4GB")

# Inspect active memory usage
metrics = iara.memory_usage()
print(f"Used: {metrics['used']} bytes, Peak: {metrics['peak']} bytes, Spilled: {metrics['spilled']} bytes")
```

```python
>>> iara.set_memory_limit("4GB")
>>> iara.memory_usage()
{'limit': 4294967296, 'used': 0, 'peak': 0, 'spilled': 0}
```

`set_memory_limit(None)` removes the limit. `used` is the memory the operators hold now. `peak` starts again with each query that starts while no other query runs. `spilled` counts the bytes written to spill files since the process started.

#### Spill Directory
Spill files go to an `iara-spill` folder in the operating system temporary directory by default. `IARA_SPILL_DIR` sets the parent folder instead, and the files go to `<IARA_SPILL_DIR>/iara-spill/`. Each file is deleted when it is dropped, which also happens when a query is cancelled. Configure a custom path via the environment variable:
```bash
export IARA_SPILL_DIR="/fast-nvme/iara-spill"
```
