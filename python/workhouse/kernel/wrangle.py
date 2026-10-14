"""The Data Wrangler's recipes, run in the kernel.

A recipe is a list of steps (``{"id", "enabled", "op": {"kind", ...}}``).
It compiles to one SQL query, a chain of CTEs over the source: that query
produces the preview, the column quality bars and the column profiles, and
it is also the exported code, so what the Studio shows is what the code
does. Profiles and counts run over the whole result, not a sample.

The source is a catalog table (``{"table": name}``) or a stored result
(``{"result_id": id}``, registered as ``source`` for the query).
"""

from __future__ import annotations

import re
from typing import Any

from workhouse.kernel.runtime.results import json_value

#: rows of the preview
PREVIEW_ROWS = 500
#: most frequent values in a column profile
TOP_VALUES = 10
#: most values a one-hot encoding turns into columns
MAX_ONE_HOT = 50

_NUMERIC = re.compile(r"^(U?Int\d+|Float\d+|Decimal\d*\(.*\))$")
_CASTS = {"int64": "BIGINT", "float64": "DOUBLE", "utf8": "VARCHAR", "bool": "BOOLEAN", "date": "DATE", "timestamp": "TIMESTAMP"}
_COMPARE = {"equals": "=", "not_equals": "<>", "greater_than": ">", "greater_equal": ">=", "less_than": "<", "less_equal": "<="}


def ident(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def text(value: Any) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def is_numeric(type_name: str) -> bool:
    return bool(_NUMERIC.match(type_name))


def is_text(type_name: str) -> bool:
    return type_name in ("Utf8", "LargeUtf8", "Utf8View")


def literal(value: Any, type_name: str) -> str:
    """A literal for a value compared with a column of ``type_name``."""
    if value is None:
        return "NULL"
    if is_numeric(type_name):
        try:
            float(value)
        except (TypeError, ValueError) as e:
            raise ValueError(f"{value!r} is not a number") from e
        return str(value)
    return text(value)


class Compiler:
    """Turns steps into CTEs; needs the columns (and types) after each step."""

    def __init__(self, ws: Any, source_sql: str, tables: dict[str, Any]) -> None:
        self.ws = ws
        self.tables = tables
        self.ctes: list[str] = []
        self.prev = "source_rows"
        self.ctes.append(f"source_rows AS ({source_sql})")
        self.order: str | None = None

    def query(self, select: str | None = None) -> str:
        body = select or f"SELECT * FROM {self.prev}"
        return "WITH\n  " + ",\n  ".join(self.ctes) + "\n" + body

    def final(self) -> str:
        return self.query(f"SELECT * FROM {self.prev}" + (f"\nORDER BY {self.order}" if self.order else ""))

    def schema(self) -> dict[str, str]:
        return dict(self.ws.sql(self.query(), **self.tables).schema)

    def push(self, select: str) -> None:
        name = f"step_{len(self.ctes)}"
        self.ctes.append(f"{name} AS ({select})")
        self.prev = name

    def column(self, schema: dict[str, str], name: str) -> str:
        if name not in schema:
            raise ValueError(f"unknown column {name!r}")
        return schema[name]

    def step(self, op: dict[str, Any]) -> None:
        kind = op["kind"]
        schema = self.schema()
        p = self.prev
        if kind == "sort":
            self.column(schema, op["column"])
            self.order = f"{ident(op['column'])} {'DESC' if op.get('descending') else 'ASC'} NULLS LAST"
            return
        if kind == "filter":
            c, t = ident(op["column"]), self.column(schema, op["column"])
            o = op["op"]
            if o == "is_null":
                pred = f"{c} IS NULL"
            elif o == "is_not_null":
                pred = f"{c} IS NOT NULL"
            elif o in _COMPARE:
                pred = f"{c} {_COMPARE[o]} {literal(op.get('value'), t)}"
            elif o == "between":
                pred = f"{c} BETWEEN {literal(op.get('value'), t)} AND {literal(op.get('value2'), t)}"
            elif o in ("contains", "not_contains"):
                pred = f"{'NOT ' if o == 'not_contains' else ''}contains(CAST({c} AS VARCHAR), {text(op.get('value', ''))})"
            elif o == "starts_with":
                pred = f"starts_with(CAST({c} AS VARCHAR), {text(op.get('value', ''))})"
            elif o == "ends_with":
                pred = f"ends_with(CAST({c} AS VARCHAR), {text(op.get('value', ''))})"
            else:
                raise ValueError(f"unknown filter {o!r}")
            self.push(f"SELECT * FROM {p} WHERE {pred}")
        elif kind == "drop_columns":
            for c in op["columns"]:
                self.column(schema, c)
            self.push(f"SELECT * EXCLUDE ({', '.join(ident(c) for c in op['columns'])}) FROM {p}")
        elif kind == "rename_column":
            self.column(schema, op["from"])
            self.push(f"SELECT * RENAME ({ident(op['from'])} AS {ident(op['to'])}) FROM {p}")
        elif kind == "cast":
            self.column(schema, op["column"])
            to = _CASTS[op["toType"]]
            self.push(f"SELECT * REPLACE (CAST({ident(op['column'])} AS {to}) AS {ident(op['column'])}) FROM {p}")
        elif kind == "fill_null":
            c, t = ident(op["column"]), self.column(schema, op["column"])
            s = op["strategy"]
            if s == "constant":
                value = literal(op.get("value"), t)
            elif s in ("mean", "median"):
                if not is_numeric(t):
                    raise ValueError(f"{s} needs a numeric column; {op['column']} is {t}")
                value = f"(SELECT {'avg' if s == 'mean' else 'median'}({c}) FROM {p})"
            elif s == "mode":
                value = f"(SELECT {c} FROM {p} WHERE {c} IS NOT NULL GROUP BY {c} ORDER BY count(*) DESC, {c} LIMIT 1)"
            else:
                raise ValueError(f"unknown fill strategy {s!r}")
            self.push(f"SELECT * REPLACE (CAST(coalesce({c}, {value}) AS {_sql_type(t)}) AS {c}) FROM {p}")
        elif kind == "drop_nulls":
            cols = op.get("columns") or list(schema)
            for c in cols:
                self.column(schema, c)
            self.push(f"SELECT * FROM {p} WHERE " + " AND ".join(f"{ident(c)} IS NOT NULL" for c in cols))
        elif kind == "text_case":
            fn = {"upper": "upper", "lower": "lower", "title": "initcap"}[op["mode"]]
            self._text(schema, op["column"], f"{fn}({ident(op['column'])})")
        elif kind == "text_trim":
            self._text(schema, op["column"], f"trim({ident(op['column'])})")
        elif kind == "text_replace":
            c = ident(op["column"])
            if op.get("isRegex"):
                expr = f"regexp_replace({c}, {text(op['pattern'])}, {text(op.get('replacement', ''))}, 'g')"
            else:
                expr = f"replace({c}, {text(op['pattern'])}, {text(op.get('replacement', ''))})"
            self._text(schema, op["column"], expr)
        elif kind == "split_column":
            self.column(schema, op["column"])
            n = max(1, int(op.get("numParts") or 2))
            parts = ", ".join(
                f"split_part(CAST({ident(op['column'])} AS VARCHAR), {text(op['delimiter'])}, {i}) AS {ident(str(op['column']) + '_' + str(i))}"
                for i in range(1, n + 1)
            )
            self.push(f"SELECT *, {parts} FROM {p}")
        elif kind == "deduplicate":
            subset = op.get("subset") or []
            if not subset:
                self.push(f"SELECT DISTINCT * FROM {p}")
            else:
                for c in subset:
                    self.column(schema, c)
                keys = ", ".join(ident(c) for c in subset)
                self.push(f"SELECT * FROM {p} QUALIFY row_number() OVER (PARTITION BY {keys}) = 1")
        elif kind == "one_hot_encode":
            col = op["column"]
            self.column(schema, col)
            got = self.ws.sql(
                self.query(f"SELECT DISTINCT {ident(col)} AS v FROM {p} WHERE {ident(col)} IS NOT NULL ORDER BY 1 LIMIT {MAX_ONE_HOT + 1}"),
                **self.tables,
            ).collect().to_arrow()
            values = got.column("v").to_pylist()
            if len(values) > MAX_ONE_HOT:
                raise ValueError(f"{col} has more than {MAX_ONE_HOT} distinct values: too many for one-hot columns")
            flags = ", ".join(
                f"CASE WHEN {ident(col)} = {literal(v, schema[col])} THEN 1 ELSE 0 END AS {ident(str(col) + '_' + str(v))}" for v in values
            )
            self.push(f"SELECT *{', ' + flags if flags else ''} FROM {p}")
        elif kind == "math_round":
            c, t = ident(op["column"]), self.column(schema, op["column"])
            if not is_numeric(t):
                raise ValueError(f"round needs a numeric column; {op['column']} is {t}")
            self.push(f"SELECT * REPLACE (round({c}, {int(op['decimals'])}) AS {c}) FROM {p}")
        else:
            raise ValueError(f"unknown step {kind!r}")

    def _text(self, schema: dict[str, str], col: str, expr: str) -> None:
        if not is_text(self.column(schema, col)):
            raise ValueError(f"{col} is not a text column")
        self.push(f"SELECT * REPLACE ({expr} AS {ident(col)}) FROM {self.prev}")


def _sql_type(type_name: str) -> str:
    """A SQL type for an engine type name (for casts back to a column's type)."""
    simple = {"Int8": "TINYINT", "Int16": "SMALLINT", "Int32": "INTEGER", "Int64": "BIGINT", "UInt8": "UTINYINT",
              "UInt16": "USMALLINT", "UInt32": "UINTEGER", "UInt64": "UBIGINT", "Float32": "REAL", "Float64": "DOUBLE",
              "Utf8": "VARCHAR", "Utf8View": "VARCHAR", "LargeUtf8": "VARCHAR", "Boolean": "BOOLEAN", "Date32": "DATE"}
    if type_name in simple:
        return simple[type_name]
    m = re.match(r"^Decimal\d*\((\d+),\s*(-?\d+)\)$", type_name)
    if m:
        return f"DECIMAL({m.group(1)}, {m.group(2)})"
    if type_name.startswith("Timestamp"):
        return "TIMESTAMP"
    return "VARCHAR"


def _source(results: Any, source: dict[str, Any]) -> tuple[str, dict[str, Any], str]:
    """(SQL of the source rows, extra tables, how the exported code names it)."""
    if "table" in source:
        return f"SELECT * FROM {ident(source['table'])}", {}, source["table"]
    table = results.get(source["result_id"])
    return "SELECT * FROM source", {"source": table}, "source"


def compile_recipe(ws: Any, results: Any, source: dict[str, Any], steps: list[dict[str, Any]]) -> tuple[Compiler, str]:
    source_sql, tables, name = _source(results, source)
    comp = Compiler(ws, source_sql, tables)
    for s in steps:
        if s.get("enabled", True):
            try:
                comp.step(s["op"])
            except Exception as e:  # noqa: BLE001
                raise ValueError(f"step '{s.get('label') or s['op'].get('kind')}': {e}") from e
    return comp, name


def code(comp: Compiler, name: str, from_result: bool) -> dict[str, str]:
    sql = comp.final()
    if from_result:
        python = f'# `df`: the result to wrangle\nwrangled = ws.sql("""\n{sql}\n""", source=df)'
    else:
        python = f'wrangled = ws.sql("""\n{sql}\n""")'
    return {"sql": sql, "python": python}


def preview(ws: Any, results: Any, source: dict[str, Any], steps: list[dict[str, Any]]) -> dict[str, Any]:
    """The result of the recipe (first rows), its row count, per-column
    quality counts over all rows, and the code that produces it."""
    comp, name = compile_recipe(ws, results, source, steps)
    tables = comp.tables
    schema = comp.schema()
    rows = ws.sql(f"SELECT * FROM ({comp.final()}) LIMIT {PREVIEW_ROWS}", **tables).collect().to_arrow()
    counts = ["count(*) AS n"]
    for i, (col, t) in enumerate(schema.items()):
        counts.append(f"count({ident(col)}) AS v{i}")
        counts.append(f"sum(CASE WHEN {ident(col)} = '' THEN 1 ELSE 0 END) AS e{i}" if is_text(t) else f"0 AS e{i}")
    q = ws.sql(comp.query(f"SELECT {', '.join(counts)} FROM {comp.prev}"), **tables).collect().to_arrow().to_pylist()[0]
    total = int(q["n"])
    quality = [
        {"name": col, "type": t, "total": total, "nulls": total - int(q[f"v{i}"] or 0), "empty": int(q[f"e{i}"] or 0)}
        for i, (col, t) in enumerate(schema.items())
    ]
    return {
        "columns": [{"name": f.name, "type": str(f.type)} for f in rows.schema],
        "rows": [[json_value(v) for v in r.values()] for r in rows.to_pylist()],
        "num_rows": total,
        "quality": quality,
        **code(comp, name, "result_id" in source),
    }


def profile(ws: Any, results: Any, source: dict[str, Any], steps: list[dict[str, Any]], column: str) -> dict[str, Any]:
    """Statistics of one column of the recipe's result, over all rows."""
    comp, _ = compile_recipe(ws, results, source, steps)
    schema = comp.schema()
    t = comp.column(schema, column)
    c, p = ident(column), comp.prev
    stats = ["count(*) AS total", f"count({c}) AS valid", f"count(DISTINCT {c}) AS distinct_count"]
    if is_numeric(t):
        stats += [f"min({c}) AS min", f"max({c}) AS max", f"avg({c}) AS mean", f"median({c}) AS median", f"stddev({c}) AS std"]
    elif t != "Boolean" and not t.startswith("List") and not t.startswith("Struct"):
        stats += [f"min({c}) AS min", f"max({c}) AS max"]
    s = ws.sql(comp.query(f"SELECT {', '.join(stats)} FROM {p}"), **comp.tables).collect().to_arrow().to_pylist()[0]
    top = ws.sql(
        comp.query(f"SELECT CAST({c} AS VARCHAR) AS value, count(*) AS n FROM {p} WHERE {c} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT {TOP_VALUES}"),
        **comp.tables,
    ).collect().to_arrow().to_pylist()
    total = int(s["total"]) or 1
    return {
        "name": column,
        "type": t,
        "total": int(s["total"]),
        "nulls": int(s["total"]) - int(s["valid"]),
        "distinct": int(s["distinct_count"]),
        **{k: json_value(s.get(k)) for k in ("min", "max", "mean", "median", "std") if k in s},
        "top": [{"value": r["value"], "count": int(r["n"]), "share": int(r["n"]) / total} for r in top],
    }
