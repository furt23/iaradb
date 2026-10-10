"""Structs, following Polars: the `struct` namespace of expressions
(`col("s").struct.field("a")`), `wh.struct(...)` to build one, the `Struct` and
`List` data types, and the JSON text helpers behind `str.json_decode` /
`struct.json_encode`.

Fields are SQL struct fields of the engine (DuckDB semantics): a null struct
reads null in every field.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any, Iterable, Mapping

if TYPE_CHECKING:
    from workhouse import Expr

_PLAIN_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _dtype(t: Any) -> str:
    if not isinstance(t, str):
        raise TypeError(f"a data type is a name such as 'int64' or wh.Struct(..), not {type(t).__name__}")
    return t


def List(inner: Any) -> str:  # noqa: N802
    """The type of lists of `inner`: ``wh.List("int64")``."""
    return f"list<{_dtype(inner)}>"


def Struct(fields: Mapping[str, Any] | Iterable[tuple[str, Any]]) -> str:  # noqa: N802
    """The type of structs: ``wh.Struct({"a": "int64", "b": wh.List("utf8")})``."""
    items = list(fields.items() if isinstance(fields, Mapping) else fields)
    if not items:
        raise ValueError("a struct type needs at least one field")
    parts = [f"{n if _PLAIN_NAME.match(n) else chr(34) + n + chr(34)}: {_dtype(t)}" for n, t in items]
    return f"struct<{', '.join(parts)}>"


def _field_args(pairs: Iterable[tuple[str, Any]]) -> list[Any]:
    """`name, value, name, value ...` as the engine's struct_pack takes them."""
    from workhouse import PyExpr

    out: list[Any] = []
    for name, value in pairs:
        out.append(PyExpr.lit(name))
        out.append(value._e)
    return out


def struct(*exprs: Any, **named: Any) -> Expr:
    """A struct of the given expressions: fields are named like the expressions
    (a column keeps its name, an aliased expression its alias) or by keyword.

        >>> wh.struct("a", "b")
        >>> wh.struct(total=wh.col("x") + wh.col("y"))
    """
    import workhouse as wh
    from workhouse import PyExpr

    pairs: list[tuple[str, Expr]] = []
    for item in wh._flatten(exprs):
        e = wh._col_or_expr(item)
        name = wh._named(e).output_name()
        pairs.append((name, e))
    pairs.extend((k, wh._expr(v)) for k, v in named.items())
    if not pairs:
        raise ValueError("struct() needs at least one expression")
    names = [n for n, _ in pairs]
    dup = next((n for i, n in enumerate(names) if n in names[:i]), None)
    if dup is not None:
        raise ValueError(f"struct() has the field name '{dup}' twice; alias one of the expressions")
    return wh.Expr(PyExpr.func("struct_pack", _field_args(pairs)))


def struct_literal(value: Mapping[str, Any]) -> Expr:
    """A dict as a struct literal (``{"a": 1}`` is ``struct(a=1)``)."""
    import workhouse as wh

    return struct(**{str(k): wh._expr(v) for k, v in value.items()})


class StructUnnest:
    """What ``col("s").struct.unnest()`` returns: select / with_columns expand
    it into one column per field (the fields come from the frame's schema)."""

    __slots__ = ("_x",)

    def __init__(self, x: Expr) -> None:
        self._x = x

    def expand(self, lf: Any) -> list[Expr]:
        fields = lf.struct_fields(self._x._e)
        if fields is None:
            raise TypeError("struct.unnest() needs a struct expression")
        return [self._x.struct.field(f).alias(f) for f in fields]


class StructNamespace:
    __slots__ = ("_x",)

    def __init__(self, x: Expr) -> None:
        self._x = x

    def field(self, name: str) -> Expr:
        """The field `name`; null where the struct is null."""
        return self._x._f("struct_extract", name)

    def rename_fields(self, names: Iterable[str]) -> Expr:
        """The same fields under new names, in order."""
        names = list(names)
        if not names:
            raise ValueError("rename_fields needs the new names")
        return self._x._f("struct_rename", *names)

    def with_fields(self, *exprs: Any, **named: Any) -> Expr:
        """The struct with extra fields (their values may refer to columns)."""
        import workhouse as wh

        pairs = [(wh._named(wh._col_or_expr(e)).output_name(), wh._col_or_expr(e)) for e in wh._flatten(exprs)]
        pairs.extend((k, wh._expr(v)) for k, v in named.items())
        args = [a for pair in pairs for a in (pair[0], pair[1])]
        return self._x._f("struct_insert", *args)

    def unnest(self) -> StructUnnest:
        """Expand into one column per field: ``df.select(col("s").struct.unnest())``."""
        return StructUnnest(self._x)

    def json_encode(self) -> Expr:
        """The struct as JSON text; a null struct is the text ``null`` (Polars)."""
        import workhouse as wh

        return wh.when(self._x.is_null()).then(wh.lit("null")).otherwise(self._x._f("to_json"))
