"""Dependency graph between cells, from their definitions and references.

An edge ``a -> b`` means cell ``b`` reads a name that cell ``a`` defines.

A name defined by one cell is read from it wherever the reader is (as in
marimo). A name several cells define (``df = ...`` then ``df = df.filter(...)``)
is read from the nearest of them above the reader, as in a script; reading
it above all of them is an error. The graph must be acyclic. Violations are
reported per cell instead of being raised.
"""

from __future__ import annotations

import heapq
from collections.abc import Iterable
from dataclasses import dataclass

from workhouse.kernel.notebook.analysis import ANY_WIDGET, Analysis, analyze
from workhouse.kernel.notebook.model import Cell


@dataclass(frozen=True)
class CellDeps:
    id: str
    analysis: Analysis
    #: names this cell reads that other cells define
    refs: tuple[str, ...]
    parents: frozenset[str]
    #: the cell each of ``refs`` is read from
    sources: dict[str, str]
    #: names read above every cell that defines them
    unresolved: tuple[str, ...] = ()


class DependencyGraph:
    def __init__(self, cells: list[Cell]) -> None:
        self.order = [c.id for c in cells]
        self._position = {cid: i for i, cid in enumerate(self.order)}
        #: the setup cell runs before every other cell (as marimo's does), whether or not they read its names
        self.setup = frozenset(c.id for c in cells if c.setup)
        self.analyses = {c.id: analyze(c) for c in cells}
        self.definers: dict[str, list[str]] = {}
        for cid in self.order:
            for name in self.analyses[cid].defs:
                self.definers.setdefault(name, []).append(cid)
        self._lower = {n.lower(): n for n in self.definers}
        self.deps = {cid: self._deps(cid) for cid in self.order}
        self.children: dict[str, set[str]] = {cid: set() for cid in self.order}
        for cid, d in self.deps.items():
            for p in d.parents:
                self.children[p].add(cid)
        self.errors = self._errors()

    def source(self, cid: str, name: str) -> str | None:
        """The cell ``cid`` reads ``name`` from (None: no other cell defines it,
        or it is redefined and no definition is above ``cid``)."""
        cells = self.definers.get(name, [])
        if len(cells) == 1:
            return None if cells[0] == cid else cells[0]
        above = [d for d in cells if self._position[d] < self._position[cid]]
        return above[-1] if above else None

    def _deps(self, cid: str) -> CellDeps:
        a = self.analyses[cid]
        names = set(a.refs)
        # SQL identifiers name tables case-insensitively
        names |= {self._lower[i.lower()] for i in a.sql_idents if i.lower() in self._lower}
        sources: dict[str, str] = {}
        unresolved = []
        for n in sorted(names):
            if not any(d != cid for d in self.definers.get(n, ())):
                continue
            src = self.source(cid, n)
            if src is None:
                unresolved.append(n)
            else:
                sources[n] = src
        return CellDeps(cid, a, tuple(sources), frozenset(sources.values()), sources, tuple(unresolved))

    def _errors(self) -> dict[str, str]:
        errors = {cid: a.error for cid, a in self.analyses.items() if a.error}
        for cid, d in self.deps.items():
            if d.unresolved:
                name = d.unresolved[0]
                errors.setdefault(cid, f"'{name}' is read before the cells that define it: move this cell below one of them")
        for cycle in self._cycles():
            for cid in cycle:
                errors.setdefault(cid, "cells form a dependency cycle")
        return errors

    def _cycles(self) -> list[set[str]]:
        """Strongly connected components with more than one cell (Tarjan)."""
        index: dict[str, int] = {}
        low: dict[str, int] = {}
        stack: list[str] = []
        on_stack: set[str] = set()
        out: list[set[str]] = []

        def visit(v: str) -> None:
            index[v] = low[v] = len(index)
            stack.append(v)
            on_stack.add(v)
            for w in self.children[v]:
                if w not in index:
                    visit(w)
                    low[v] = min(low[v], low[w])
                elif w in on_stack:
                    low[v] = min(low[v], index[w])
            if low[v] == index[v]:
                comp = set()
                while True:
                    w = stack.pop()
                    on_stack.discard(w)
                    comp.add(w)
                    if w == v:
                        break
                if len(comp) > 1:
                    out.append(comp)

        for v in self.order:
            if v not in index:
                visit(v)
        return out

    def widget_readers(self, name: str) -> list[str]:
        """Cells that read or define the widget ``name`` (in notebook order): they re-run when its value changes."""
        return [cid for cid in self.order if name in self.analyses[cid].widgets or ANY_WIDGET in self.analyses[cid].widgets]

    def descendants(self, cid: str) -> set[str]:
        seen: set[str] = set()
        todo = [cid]
        while todo:
            for c in self.children[todo.pop()]:
                if c not in seen:
                    seen.add(c)
                    todo.append(c)
        return seen

    def ancestors(self, cid: str) -> set[str]:
        seen: set[str] = set()
        todo = [cid]
        while todo:
            for p in self.deps[todo.pop()].parents:
                if p not in seen:
                    seen.add(p)
                    todo.append(p)
        return seen

    def topological(self, cells: Iterable[str]) -> list[str]:
        """``cells`` in dependency order, staying as close to notebook order as
        possible (the earliest ready cell always goes next). Cells inside
        cycles are left out."""
        wanted = set(cells)
        position = {cid: i for i, cid in enumerate(self.order)}
        waiting = {cid: len(self.deps[cid].parents & wanted) for cid in wanted}
        ready = [position[c] for c, n in waiting.items() if n == 0]
        heapq.heapify(ready)
        out: list[str] = []
        while ready:
            cid = self.order[heapq.heappop(ready)]
            out.append(cid)
            for child in self.children[cid]:
                if child in waiting:
                    waiting[child] -= 1
                    if waiting[child] == 0:
                        heapq.heappush(ready, position[child])
        return out
