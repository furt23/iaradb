"""Iara kernel: executes notebooks for Iara Studio.

A kernel is a long-lived Python process driven over stdio with JSON lines
(see :mod:`iara.kernel.protocol`). It owns one workspace session and at
most one open notebook stored in marimo's ``.py`` format, and runs its cells
reactively: running a cell re-runs every cell that depends on it.

Run with ``python -m iara.kernel --workspace <dir>``.

Protocol 2: the Studio owns the workspace's files (notebooks,
``iara.toml``) and sends them to the kernel, which only computes, so a
kernel may run on another machine (over SSH) with the same files.
"""

PROTOCOL_VERSION = 2
