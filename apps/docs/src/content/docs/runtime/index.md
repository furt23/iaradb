---
title: Resource & Memory Management
description: Configuring threads, memory thresholds, and disk spill behavior.
---

### Thread Pool Sizing

Workhouse utilizes a global Rayon work-stealing thread pool. By default, it allocates one worker thread per physical CPU core.

```python
import workhouse as wh

# Size the worker pool before running queries
wh.set_num_threads(8)

# Check active thread count
print(wh.num_threads())
```

---

### Memory Management & Spilling

The engine manages operator memory through a centralized memory pool. Beyond the limit, operators spill intermediate state to temporary Arrow IPC files on disk.

```python
# Set memory limit to 4 gigabytes
wh.set_memory_limit("4GB")

# Inspect active memory usage
metrics = wh.memory_usage()
print(f"Used: {metrics['used']} bytes, Peak: {metrics['peak']} bytes, Spilled: {metrics['spilled']} bytes")
```

#### Spill Directory
Spill files default to the operating system temporary directory. Configure a custom path via the environment variable:
```bash
export WORKHOUSE_SPILL_DIR="/fast-nvme/workhouse-spill"
```
