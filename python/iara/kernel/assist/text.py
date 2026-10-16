"""Positions in cell code: character offsets (what the editor uses) from
lines and columns (what Python and jedi report)."""

from __future__ import annotations


class Positions:
    def __init__(self, code: str) -> None:
        self.code = code
        self.lines = code.split("\n")
        self.starts = [0]
        for line in self.lines:
            self.starts.append(self.starts[-1] + len(line) + 1)

    def line_col(self, offset: int) -> tuple[int, int]:
        """1-based line and 0-based column of a character offset."""
        before = self.code[: max(0, min(offset, len(self.code)))]
        line = before.count("\n") + 1
        return line, len(before) - (before.rfind("\n") + 1)

    def offset(self, line: int, col: int) -> int:
        """Character offset of a 1-based line and 0-based character column."""
        line = max(1, min(line, len(self.lines)))
        return min(self.starts[line - 1] + max(0, col), len(self.code))

    def offset_bytes(self, line: int, col_bytes: int) -> int:
        """Like :meth:`offset` with the column in UTF-8 bytes (``ast`` nodes)."""
        line = max(1, min(line, len(self.lines)))
        text = self.lines[line - 1].encode("utf-8")[:col_bytes].decode("utf-8", errors="ignore")
        return self.offset(line, len(text))

    def line_end(self, line: int) -> int:
        line = max(1, min(line, len(self.lines)))
        return self.starts[line - 1] + len(self.lines[line - 1])
