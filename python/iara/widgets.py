"""Notebook widgets: named inputs a notebook reads, like Databricks' ``dbutils.widgets``.

    >>> import iara as ia
    >>> iara.widgets.dropdown("region", "north", ["north", "south"])
    'north'
    >>> iara.widgets.get("region")
    'north'

Each call defines (or updates) the widget and returns its current value.
Values live in a registry: inside the Studio's kernel the notebook's own
registry (the Studio shows the widgets and sends the values the user picks,
which re-runs the cells that read them); anywhere else (a script, a job without
a kernel) the process-wide one, where a widget starts at the environment
variable ``IARA_PARAM_<NAME>`` (the name upper-cased) when it is set, else
at its default.

SQL cells bind ``:name`` placeholders to the widget values (``params()``).
"""

from __future__ import annotations

import datetime as dt
import math
import os
import re
import threading
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

__all__ = [
    "Definition",
    "Registry",
    "text",
    "number",
    "dropdown",
    "multiselect",
    "checkbox",
    "date",
    "get",
    "params",
    "remove",
    "remove_all",
    "install",
    "active",
    "ENV_PREFIX",
]

#: prefix of the environment variables that set widgets outside the Studio
ENV_PREFIX = "IARA_PARAM_"
KINDS = ("text", "number", "dropdown", "multiselect", "checkbox", "date")
_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_TRUE = {"true", "1", "yes", "y", "on"}
_FALSE = {"false", "0", "no", "n", "off", ""}
_MISSING: Any = object()


def check_name(name: object) -> str:
    if not isinstance(name, str) or not _NAME.fullmatch(name):
        raise ValueError(f"invalid widget name {name!r}: use letters, digits and underscores, not starting with a digit")
    return name


def env_name(name: str) -> str:
    return ENV_PREFIX + name.upper()


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


@dataclass(frozen=True)
class Definition:
    name: str
    kind: str
    default: Any
    label: str | None = None
    choices: tuple[Any, ...] | None = None
    min: float | None = None
    max: float | None = None
    step: float | None = None

    # -- values --------------------------------------------------------------
    def _choice(self, value: Any) -> Any:
        assert self.choices is not None
        for c in self.choices:
            if c == value or str(c) == str(value):
                return c
        raise ValueError(f"{value!r} is not one of the choices of widget {self.name!r}: {list(self.choices)}")

    def _integral(self) -> bool:
        """Whole numbers all the way (default and bounds), so the value is an ``int``."""
        bounds = [v for v in (self.default, self.min, self.max, self.step) if v is not None]
        return all(isinstance(v, int) and not isinstance(v, bool) for v in bounds)

    def coerce(self, value: Any) -> Any:
        """``value`` as this widget's type (``ValueError`` when it is none)."""
        k = self.kind
        if k == "text":
            return "" if value is None else str(value)
        if k == "number":
            if isinstance(value, bool) or value is None:
                raise ValueError(f"widget {self.name!r} is a number, not {value!r}")
            try:
                n = float(value.strip() if isinstance(value, str) else value)
            except (TypeError, ValueError):
                raise ValueError(f"widget {self.name!r} is a number, not {value!r}") from None
            if math.isnan(n) or math.isinf(n):
                raise ValueError(f"widget {self.name!r} is a number, not {value!r}")
            if self.min is not None:
                n = max(n, self.min)
            if self.max is not None:
                n = min(n, self.max)
            return int(n) if self._integral() and n.is_integer() else n
        if k == "dropdown":
            return self._choice(value)
        if k == "multiselect":
            if value is None:
                items: list[Any] = []
            elif isinstance(value, str):
                items = [p.strip() for p in value.split(",") if p.strip()]
            elif isinstance(value, (list, tuple, set, frozenset)):
                items = list(value)
            else:
                raise ValueError(f"widget {self.name!r} takes a list of choices, not {value!r}")
            picked = [self._choice(v) for v in items]
            return [c for c in self.choices or () if c in picked]
        if k == "checkbox":
            if isinstance(value, bool):
                return value
            if isinstance(value, (int, float)) and value in (0, 1):
                return bool(value)
            if isinstance(value, str) and value.strip().lower() in _TRUE | _FALSE:
                return value.strip().lower() in _TRUE
            raise ValueError(f"widget {self.name!r} is a checkbox, not {value!r}")
        if k == "date":
            if value is None or (isinstance(value, str) and not value.strip()):
                return None
            if isinstance(value, dt.datetime):
                return value.date()
            if isinstance(value, dt.date):
                return value
            try:
                return dt.date.fromisoformat(str(value).strip()[:10])
            except ValueError:
                raise ValueError(f"widget {self.name!r} is a date (YYYY-MM-DD), not {value!r}") from None
        raise ValueError(f"unknown widget kind {k!r}")

    # -- wire ----------------------------------------------------------------
    def to_json(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "kind": self.kind,
            "label": self.label or self.name,
            "default": jsonable(self.default),
            "choices": None if self.choices is None else [jsonable(c) for c in self.choices],
            "min": self.min,
            "max": self.max,
            "step": self.step,
        }


def jsonable(value: Any) -> Any:
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat()
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    return value


class Registry:
    """The widgets of one notebook session: definitions (per defining cell) and values."""

    def __init__(self, env: bool = False) -> None:
        #: standalone registries start widgets at their environment variable
        self.env = env
        self._lock = threading.RLock()
        #: definitions by the cell that made them (``None``: outside any cell)
        self._by_cell: dict[str | None, dict[str, Definition]] = {}
        self._values: dict[str, Any] = {}
        self._cell: str | None = None
        self._announced: Any = self.payload()

    # -- definitions -----------------------------------------------------------
    def definitions(self) -> list[Definition]:
        """One definition per name (the last cell to define it wins)."""
        with self._lock:
            merged: dict[str, Definition] = {}
            for defs in self._by_cell.values():
                merged.update(defs)
            return list(merged.values())

    def definition(self, name: str) -> Definition | None:
        with self._lock:
            found = None
            for defs in self._by_cell.values():
                found = defs.get(name, found)
            return found

    def define(self, d: Definition) -> Any:
        """Register ``d`` and return its current value (kept across re-definitions while it is valid)."""
        with self._lock:
            raw = self._values.get(d.name, _MISSING)
            if raw is _MISSING and self.env:
                raw = os.environ.get(env_name(d.name), _MISSING)
            value = d.default
            if raw is not _MISSING:
                try:
                    value = d.coerce(raw)
                except ValueError:
                    pass
            self._values[d.name] = value
            self._by_cell.setdefault(self._cell, {})[d.name] = d
            return value

    @contextmanager
    def cell(self, cell_id: str) -> Iterator[None]:
        """Definitions made while a cell runs belong to it; the ones it made
        last time and no longer makes disappear."""
        with self._lock:
            before = set(self._by_cell.get(cell_id, ()))
            self._by_cell[cell_id] = {}
            outer, self._cell = self._cell, cell_id
        try:
            yield
        finally:
            with self._lock:
                self._cell = outer
                self._drop(before - set(self._by_cell[cell_id]))

    def cell_ids(self) -> list[str]:
        """The cells that made definitions."""
        with self._lock:
            return [c for c in self._by_cell if c is not None]

    def forget_cell(self, cell_id: str) -> None:
        """The cell was deleted: its widgets go."""
        with self._lock:
            gone = set(self._by_cell.pop(cell_id, ()))
            self._drop(gone)

    def _drop(self, names: set[str]) -> None:
        for n in names:
            if not any(n in defs for defs in self._by_cell.values()):
                self._values.pop(n, None)

    def reset(self, values: Mapping[str, Any] | None = None) -> None:
        """A new notebook: no widgets; ``values`` wait for the widgets that will define them."""
        with self._lock:
            self._by_cell.clear()
            self._values = dict(values or {})
            self._announced = self.payload()

    def remove(self, name: str) -> None:
        with self._lock:
            for defs in self._by_cell.values():
                defs.pop(name, None)
            self._values.pop(name, None)

    def remove_all(self) -> None:
        with self._lock:
            self._by_cell.clear()
            self._values.clear()

    # -- values --------------------------------------------------------------
    def get(self, name: str) -> Any:
        check_name(name)
        with self._lock:
            d = self.definition(name)
            if d is not None:
                return self._values.get(name, d.default)
            if self.env and env_name(name) in os.environ:
                return os.environ[env_name(name)]
        raise ValueError(f"widget {name!r} is not defined: define it first, e.g. iara.widgets.text({name!r})")

    def set(self, name: str, value: Any) -> Any:
        """Set a defined widget (the value is coerced; ``ValueError`` when it is invalid)."""
        with self._lock:
            d = self.definition(check_name(name))
            if d is None:
                raise ValueError(f"widget {name!r} is not defined")
            self._values[name] = d.coerce(value)
            return self._values[name]

    def preset(self, values: Mapping[str, Any]) -> None:
        """Values for widgets (a job's parameters): applied now to the defined
        ones, kept for the others until they are defined. Invalid ones are ignored."""
        with self._lock:
            for name, value in values.items():
                if not isinstance(name, str) or not _NAME.fullmatch(name):
                    continue
                d = self.definition(name)
                if d is None:
                    self._values[name] = value
                    continue
                try:
                    self._values[name] = d.coerce(value)
                except ValueError:
                    pass

    def params(self, names: Sequence[str] | None = None) -> dict[str, Any]:
        """Current values by name (the defined widgets; or ``names``, when given and defined)."""
        with self._lock:
            defined = [d.name for d in self.definitions()]
            wanted = defined if names is None else [n for n in names if n in defined]
            return {n: self._values.get(n, self.definition(n).default) for n in wanted}  # type: ignore[union-attr]

    # -- the Studio ------------------------------------------------------------
    def payload(self) -> dict[str, Any]:
        """``{definitions, values}`` as sent in ``widgets.changed`` (values are JSON)."""
        with self._lock:
            defs = self.definitions()
            return {
                "definitions": [d.to_json() for d in defs],
                "values": {d.name: jsonable(self._values.get(d.name, d.default)) for d in defs},
            }

    def take_changes(self) -> dict[str, Any] | None:
        """The payload when it differs from the one last taken (else ``None``)."""
        with self._lock:
            now = self.payload()
            if now == self._announced:
                return None
            self._announced = now
            return now


_default = Registry(env=True)
_active: Registry = _default


def install(registry: Registry | None) -> None:
    """Make ``registry`` the one the module functions use (``None``: the process-wide one)."""
    global _active
    _active = registry or _default


def active() -> Registry:
    return _active


# ---------------------------------------------------------------------------
# the API
# ---------------------------------------------------------------------------


def text(name: str, default: str = "", label: str | None = None) -> str:
    """A text input; returns its value."""
    return _active.define(Definition(check_name(name), "text", str(default), label))


def number(
    name: str,
    default: float = 0,
    label: str | None = None,
    min: float | None = None,  # noqa: A002
    max: float | None = None,  # noqa: A002
    step: float | None = None,
) -> float:
    """A number input (optionally bounded); returns its value."""
    for v in (default, min, max, step):
        if v is not None and not _is_number(v):
            raise ValueError(f"widget {name!r}: {v!r} is not a number")
    if min is not None and max is not None and min > max:
        raise ValueError(f"widget {name!r}: min is above max")
    d = Definition(check_name(name), "number", default, label, None, min, max, step)
    return _active.define(Definition(d.name, d.kind, d.coerce(default), label, None, min, max, step))


def dropdown(name: str, default: Any, choices: Sequence[Any], label: str | None = None) -> Any:
    """A single choice among ``choices``; returns the picked one."""
    options = tuple(choices)
    if not options:
        raise ValueError(f"widget {name!r}: choices is empty")
    d = Definition(check_name(name), "dropdown", None, label, options)
    return _active.define(Definition(d.name, d.kind, d.coerce(default), label, options))


def multiselect(name: str, default: Sequence[Any], choices: Sequence[Any], label: str | None = None) -> list[Any]:
    """Several choices among ``choices``; returns the picked ones, in the order of ``choices``."""
    options = tuple(choices)
    if not options:
        raise ValueError(f"widget {name!r}: choices is empty")
    d = Definition(check_name(name), "multiselect", None, label, options)
    return _active.define(Definition(d.name, d.kind, d.coerce(list(default)), label, options))


def checkbox(name: str, default: bool = False, label: str | None = None) -> bool:
    """A yes / no input; returns its value."""
    d = Definition(check_name(name), "checkbox", None, label)
    return _active.define(Definition(d.name, d.kind, d.coerce(default), label))


def date(name: str, default: dt.date | str | None = None, label: str | None = None) -> dt.date | None:
    """A date input; returns a ``datetime.date`` (``None`` while none is picked)."""
    d = Definition(check_name(name), "date", None, label)
    return _active.define(Definition(d.name, d.kind, d.coerce(default), label))


def get(name: str) -> Any:
    """The current value of a widget."""
    return _active.get(name)


def params() -> dict[str, Any]:
    """The current values of every widget, by name (what SQL cells bind ``:name`` placeholders to)."""
    return _active.params()


def remove(name: str) -> None:
    _active.remove(check_name(name))


def remove_all() -> None:
    _active.remove_all()
