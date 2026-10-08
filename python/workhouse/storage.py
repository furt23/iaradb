"""Remote storage: reading and writing ``s3://`` URLs.

Paths given to ``scan_parquet``, ``read_csv``, ``write_parquet``, SQL
``read_parquet('s3://...')`` and workspace tables may be object store URLs.
Credentials come from the environment (``AWS_ACCESS_KEY_ID`` /
``AWS_SECRET_ACCESS_KEY`` / ``AWS_SESSION_TOKEN``, ``AWS_REGION``) or, on
EC2, from the instance profile. Other settings are *storage options*,
``{key: value}`` in object_store's vocabulary:

    >>> wh.scan_parquet("s3://bucket/lineitem/", storage_options={"region": "us-east-1"})
    >>> wh.set_storage_options("s3://bucket", {"region": "us-east-1"})   # default for a prefix

Common keys: ``region``, ``endpoint`` (S3-compatible services, e.g. MinIO),
``allow_http``, ``skip_signature`` (public buckets), ``access_key_id`` /
``secret_access_key`` / ``session_token``.
"""

from __future__ import annotations

from typing import Any, Mapping

from workhouse._workhouse import StorageError
from workhouse._workhouse import clear_object_stores as _clear
from workhouse._workhouse import list_files as _list_files
from workhouse._workhouse import set_storage_options as _set_options

__all__ = ["StorageError", "set_storage_options", "list_files", "clear_object_stores", "is_remote", "secret_keys"]

StorageOptions = Mapping[str, Any]

_SECRET_PARTS = ("secret", "token", "password", "key_id", "access_key", "sse_customer_key")


def is_remote(path: str) -> bool:
    """Whether ``path`` is a URL (``s3://...``) rather than a local path."""
    scheme, sep, _ = str(path).partition("://")
    return bool(sep) and len(scheme) >= 2 and scheme.replace("+", "").replace("-", "").isalnum()


def secret_keys(options: StorageOptions | None) -> list[str]:
    """Keys of ``options`` that hold credentials."""
    return [k for k in (options or {}) if any(p in k.lower() for p in _SECRET_PARTS)]


def normalize(options: StorageOptions | None) -> dict[str, Any] | None:
    """Validate a storage options mapping (string keys, scalar values)."""
    if options is None:
        return None
    if not isinstance(options, Mapping):
        raise TypeError(f"storage_options must be a mapping, got {type(options).__name__}")
    out: dict[str, Any] = {}
    for k, v in options.items():
        if not isinstance(k, str):
            raise TypeError(f"storage option names must be strings, got {k!r}")
        if v is not None and not isinstance(v, (str, int, float, bool)):
            raise TypeError(f"storage option {k!r} must be a string, number or bool")
        out[k] = v
    return out


def set_storage_options(prefix: str, options: StorageOptions | None = None) -> None:
    """Default options for every URL under ``prefix`` (``None`` removes them)."""
    _set_options(prefix, normalize(options))


def list_files(pattern: str, extension: str = "parquet", storage_options: StorageOptions | None = None) -> list[tuple[str, int]]:
    """``[(path_or_url, size), ...]`` for a path, directory, glob or URL."""
    return _list_files(str(pattern), extension, normalize(storage_options))


def clear_object_stores() -> None:
    """Drop connections to object stores (new credentials take effect)."""
    _clear()
