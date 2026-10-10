"""SQL statements that write (``COPY``, ``CREATE TABLE ... AS``, ``INSERT``,
``DROP TABLE``) or change the session's schemas (``CREATE SCHEMA``, ``DROP
SCHEMA``, ``USE``) as a workspace sees them: the tables they create or drop
join or leave its catalog, and the schemas they declare or drop are recorded
in it."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

_LEADING = r"(?:\s|--[^\n]*(?:\n|$)|/\*.*?\*/)*"
_WRITE = re.compile(_LEADING + r"(copy|create|insert|drop|use)\b", re.IGNORECASE | re.DOTALL)
_SCHEMA = re.compile(_LEADING + r"(use\b|create\s+schema\b|drop\s+schema\b)", re.IGNORECASE | re.DOTALL)


def is_write(query: str) -> bool:
    """Whether ``query`` is a statement that writes or changes the session (it runs when issued)."""
    return _WRITE.match(query) is not None


def is_schema_statement(query: str) -> bool:
    """``USE``, ``CREATE SCHEMA`` or ``DROP SCHEMA``: they act on the session
    itself, so they run on the workspace's session and never on a fork."""
    return _SCHEMA.match(query) is not None


@dataclass(frozen=True)
class WriteResult:
    """What a statement did: the engine's one-row answer."""

    operation: str
    table: str | None
    path: str | None
    rows: int

    @staticmethod
    def of(frame: Any) -> WriteResult:
        row = frame.to_arrow().to_pylist()[0]
        return WriteResult(row["operation"], row["table"], row["path"], int(row["rows"]))
