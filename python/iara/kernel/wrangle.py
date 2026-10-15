"""The Data Wrangler's recipes, run in the kernel.

A recipe is a list of steps (``{"id", "enabled", "op": {"kind", ...}}``).
It compiles to one SQL query, the steps folded into as few SELECTs as SQL
allows (see ``Compiler``): that query
produces the preview, the column quality bars and the column profiles, and
it is also the exported code, so what the Studio shows is what the code
does. Profiles and counts run over the whole result, not a sample.

The source is a catalog table (``{"table": name}``) or a stored result
(``{"result_id": id}``, registered as ``source`` for the query).
"""

from __future__ import annotations

import re
from typing import Any

from iara.kernel.runtime.results import json_value

#: rows of the preview
PREVIEW_ROWS = 500
#: most frequent values in a column profile
TOP_VALUES = 10
#: most values a one-hot encoding turns into columns
MAX_ONE_HOT = 50
#: deepest a column's expression nests before a new stage starts (the SQL parser has a recursion limit)
MAX_NESTING = 12
#: most predicates in a stage's WHERE before a new stage starts
MAX_PREDICATES = 32

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


class Stage:
    """One SELECT over a relation: steps fold into it while SQL allows.

    Each output column keeps its expression over the relation's columns, so
    row-wise steps compose (``upper(trim("name"))``) and a filter on a changed
    column uses the changed value. It prints as ``SELECT * EXCLUDE/REPLACE/RENAME``
    plus any added columns, so only what the steps touch is spelled out.
    """

    def __init__(self, relation: str, columns: list[str]) -> None:
        self.relation = relation
        self.inputs = list(columns)
        #: [output name, expression, input column it comes from (None: added)]
        self.cols: list[list[Any]] = [[c, ident(c), c] for c in columns]
        self.where: list[str] = []
        self.distinct = False
        self.qualify: str | None = None

    def entry(self, name: str) -> list[Any]:
        for e in self.cols:
            if e[0] == name:
                return e
        raise ValueError(f"unknown column {name!r}")

    def expr(self, name: str) -> str:
        return self.entry(name)[1]

    def plain(self, name: str) -> bool:
        """The column is still its input column, untouched."""
        e = self.entry(name)
        return e[2] is not None and e[1] == ident(e[2])

    def set(self, name: str, expr: str) -> None:
        self.entry(name)[1] = expr

    def add(self, name: str, expr: str) -> None:
        self.cols = [e for e in self.cols if e[0] != name] + [[name, expr, None]]

    def changed(self) -> bool:
        same = [(e[0], e[1]) for e in self.cols] == [(c, ident(c)) for c in self.inputs]
        return bool(self.where or self.distinct or self.qualify) or not same

    def projection(self) -> str:
        if not self.cols:
            raise ValueError("no columns left")
        kept = {e[2] for e in self.cols if e[2] is not None}
        exclude = [ident(c) for c in self.inputs if c not in kept]
        replace = [f"{e[1]} AS {ident(e[2])}" for e in self.cols if e[2] is not None and e[1] != ident(e[2])]
        rename = [f"{ident(e[2])} AS {ident(e[0])}" for e in self.cols if e[2] is not None and e[0] != e[2]]
        added = [f"{e[1]} AS {ident(e[0])}" for e in self.cols if e[2] is None]
        items = []
        if kept:
            mods = [f"{k} ({', '.join(v)})" for k, v in (("EXCLUDE", exclude), ("REPLACE", replace), ("RENAME", rename)) if v]
            star = " ".join(["*", *mods])
            items.append(star if len(star) <= 80 else "*\n" + "\n".join(f"  {m}" for m in mods))
        items += added
        return ",\n  ".join(items)

    def sql(self) -> str:
        lines = [f"SELECT {'DISTINCT ' if self.distinct else ''}{self.projection()}", f"FROM {self.relation}"]
        if self.where:
            lines.append("WHERE " + "\n  AND ".join(self.where))
        if self.qualify:
            lines.append(f"QUALIFY {self.qualify}")
        return "\n".join(lines)


#: steps that change columns row by row (they fold into a stage after its filters)
_ROWWISE = {"rename_column", "cast", "text_case", "text_trim", "text_replace", "split_column", "math_round", "drop_columns", "one_hot_encode"}


class Compiler:
    """Folds steps into as few SELECTs as SQL allows. A new stage (a CTE)
    starts only where a step needs the previous rows as they are: a filter
    after a dedup, a column change after DISTINCT, a fill whose mean, median
    or mode must see the rows the earlier steps left."""

    #: what queries over the recipe's result call it
    prev = "wrangled"

    def __init__(self, ws: Any, relation: str, tables: dict[str, Any]) -> None:
        self.ws = ws
        self.tables = tables
        self.ctes: list[tuple[str, str]] = []
        self.order: tuple[str, bool] | None = None
        #: each step applied, with the columns it saw (for the Python export)
        self.applied: list[tuple[dict[str, Any], dict[str, str]]] = []
        columns = list(dict(self.ws.sql(f"SELECT * FROM {relation}", **tables).schema))
        self.stage = Stage(relation, columns)

    def _with(self, extra: list[tuple[str, str]]) -> str:
        ctes = self.ctes + extra
        if not ctes:
            return ""
        return "WITH\n" + ",\n".join(f"  {n} AS (\n{_indent(q, 4)}\n  )" for n, q in ctes) + "\n"

    def query(self, select: str | None = None) -> str:
        """A query over the recipe's result (named ``wrangled``); all of it by default."""
        return self._with([(self.prev, self.stage.sql())]) + (select or f"SELECT * FROM {self.prev}")

    def final(self) -> str:
        """The recipe as one query: the exported code."""
        sql = self._with([]) + self.stage.sql()
        if self.order:
            sql += f"\nORDER BY {ident(self.order[0])} {'DESC' if self.order[1] else 'ASC'} NULLS LAST"
        return sql

    def schema(self) -> dict[str, str]:
        return dict(self.ws.sql(self.query(), **self.tables).schema)

    def flush(self) -> Stage:
        """Start a new stage over the current one's rows (if it changed them)."""
        if self.stage.changed():
            columns = list(self.schema())
            name = f"stage_{len(self.ctes) + 1}"
            self.ctes.append((name, self.stage.sql()))
            self.stage = Stage(name, columns)
        return self.stage

    def column(self, schema: dict[str, str], name: str) -> str:
        if name not in schema:
            raise ValueError(f"unknown column {name!r}")
        return schema[name]

    def step(self, op: dict[str, Any]) -> None:
        schema = self.schema()
        values = self._step(op, schema)
        if op["kind"] != "sort":
            self.applied.append(({**op, "values": values} if values is not None else op, schema))

    def _step(self, op: dict[str, Any], schema: dict[str, str]) -> list[Any] | None:
        """Fold one step into the stage; a one-hot step returns the values it found."""
        kind = op["kind"]
        st = self.stage
        rowwise = kind in _ROWWISE or (kind == "fill_null" and op.get("strategy") == "constant")
        # DISTINCT dedups the projection: a later column change must see its rows;
        # WHERE runs before QUALIFY: a later filter must see the deduped rows
        if (rowwise and st.distinct) or (not rowwise and kind != "sort" and (st.distinct or st.qualify)):
            st = self.flush()
        # folding nests expressions and chains predicates: keep both within what the parser takes
        col = op.get("column") or op.get("from")
        if any(e[0] == col for e in st.cols) and _depth(st.expr(col)) >= MAX_NESTING:
            st = self.flush()
        elif kind in ("filter", "drop_nulls") and len(st.where) >= MAX_PREDICATES:
            st = self.flush()
        if kind == "sort":
            self.column(schema, op["column"])
            self.order = (op["column"], bool(op.get("descending")))
            return None
        if kind == "filter":
            t = self.column(schema, op["column"])
            # a filled column carries its statistic's subquery: filter the stage's result instead of repeating it
            if "SELECT" in st.expr(op["column"]):
                st = self.flush()
            c, o = st.expr(op["column"]), op["op"]
            txt = _as_text(c, t)
            if o == "is_null":
                pred = f"{c} IS NULL"
            elif o == "is_not_null":
                pred = f"{c} IS NOT NULL"
            elif o in _COMPARE:
                pred = f"{c} {_COMPARE[o]} {literal(op.get('value'), t)}"
            elif o == "between":
                pred = f"{c} BETWEEN {literal(op.get('value'), t)} AND {literal(op.get('value2'), t)}"
            elif o in ("contains", "not_contains"):
                pred = f"{'NOT ' if o == 'not_contains' else ''}contains({txt}, {text(op.get('value', ''))})"
            elif o == "starts_with":
                pred = f"starts_with({txt}, {text(op.get('value', ''))})"
            elif o == "ends_with":
                pred = f"ends_with({txt}, {text(op.get('value', ''))})"
            else:
                raise ValueError(f"unknown filter {o!r}")
            st.where.append(pred)
        elif kind == "drop_columns":
            for c in op["columns"]:
                self.column(schema, c)
            st.cols = [e for e in st.cols if e[0] not in op["columns"]]
            if self.order and self.order[0] in op["columns"]:
                self.order = None
        elif kind == "rename_column":
            self.column(schema, op["from"])
            st.entry(op["from"])[0] = op["to"]
            if self.order and self.order[0] == op["from"]:
                self.order = (op["to"], self.order[1])
        elif kind == "cast":
            self.column(schema, op["column"])
            st.set(op["column"], f"CAST({st.expr(op['column'])} AS {_CASTS[op['toType']]})")
        elif kind == "fill_null":
            self._fill(schema, op)
        elif kind == "drop_nulls":
            cols = op.get("columns") or list(schema)
            for c in cols:
                self.column(schema, c)
            st.where += [f"{st.expr(c)} IS NOT NULL" for c in cols]
        elif kind == "text_case":
            fn = {"upper": "upper", "lower": "lower", "title": "initcap"}[op["mode"]]
            self._text(schema, op["column"], lambda c: f"{fn}({c})")
        elif kind == "text_trim":
            self._text(schema, op["column"], lambda c: f"trim({c})")
        elif kind == "text_replace":
            pattern, replacement = text(op["pattern"]), text(op.get("replacement", ""))
            if op.get("isRegex"):
                self._text(schema, op["column"], lambda c: f"regexp_replace({c}, {pattern}, {replacement}, 'g')")
            else:
                self._text(schema, op["column"], lambda c: f"replace({c}, {pattern}, {replacement})")
        elif kind == "split_column":
            t = self.column(schema, op["column"])
            n = max(1, int(op.get("numParts") or 2))
            c = _as_text(st.expr(op["column"]), t)
            for i in range(1, n + 1):
                # a missing part is null (as the Python export's `list.get`), not ''
                st.add(f"{op['column']}_{i}", f"string_split({c}, {text(op['delimiter'])})[{i}]")
        elif kind == "deduplicate":
            subset = op.get("subset") or []
            for c in subset:
                self.column(schema, c)
            if subset:
                st.qualify = f"row_number() OVER (PARTITION BY {', '.join(st.expr(c) for c in subset)}) = 1"
            else:
                st.distinct = True
        elif kind == "one_hot_encode":
            return self._one_hot(schema, op["column"])
        elif kind == "math_round":
            t = self.column(schema, op["column"])
            if not is_numeric(t):
                raise ValueError(f"round needs a numeric column; {op['column']} is {t}")
            st.set(op["column"], f"round({st.expr(op['column'])}, {int(op['decimals'])})")
        else:
            raise ValueError(f"unknown step {kind!r}")
        return None

    def _fill(self, schema: dict[str, str], op: dict[str, Any]) -> None:
        col, t = op["column"], self.column(schema, op["column"])
        s, st = op["strategy"], self.stage
        if s == "constant":
            st.set(col, f"CAST(coalesce({st.expr(col)}, {literal(op.get('value'), t)}) AS {_sql_type(t)})")
            return
        if s not in ("mean", "median", "mode"):
            raise ValueError(f"unknown fill strategy {s!r}")
        if s != "mode" and not is_numeric(t):
            raise ValueError(f"{s} needs a numeric column; {col} is {t}")
        # the statistic reads the stage's input: it must hold the rows and the column the earlier steps left
        if st.where or not st.plain(col):
            st = self.flush()
        c, rel = st.expr(col), st.relation
        if s == "mode":
            value = f"(SELECT {c} FROM {rel} WHERE {c} IS NOT NULL GROUP BY {c} ORDER BY count(*) DESC, {c} LIMIT 1)"
        else:
            value = f"(SELECT {'avg' if s == 'mean' else 'median'}({c}) FROM {rel})"
        st.set(col, f"CAST(coalesce({c}, {value}) AS {_sql_type(t)})")

    def _one_hot(self, schema: dict[str, str], col: str) -> list[Any]:
        self.column(schema, col)
        got = self.ws.sql(
            self.query(f"SELECT DISTINCT {ident(col)} AS v FROM {self.prev} WHERE {ident(col)} IS NOT NULL ORDER BY 1 LIMIT {MAX_ONE_HOT + 1}"),
            **self.tables,
        ).collect().to_arrow()
        values = got.column("v").to_pylist()
        if len(values) > MAX_ONE_HOT:
            raise ValueError(f"{col} has more than {MAX_ONE_HOT} distinct values: too many for one-hot columns")
        # each flag repeats the column's expression: keep it a plain column
        st = self.stage if self.stage.plain(col) else self.flush()
        c = st.expr(col)
        for v in values:
            st.add(f"{col}_{v}", f"CASE WHEN {c} = {literal(v, schema[col])} THEN 1 ELSE 0 END")
        return values

    def _text(self, schema: dict[str, str], col: str, wrap: Any) -> None:
        if not is_text(self.column(schema, col)):
            raise ValueError(f"{col} is not a text column")
        self.stage.set(col, wrap(self.stage.expr(col)))


def _depth(expr: str) -> int:
    """How deep the parentheses of an expression nest (string literals aside)."""
    depth = deepest = 0
    quoted = False
    for ch in expr:
        if ch == "'":
            quoted = not quoted
        elif not quoted and ch == "(":
            depth += 1
            deepest = max(deepest, depth)
        elif not quoted and ch == ")":
            depth -= 1
    return deepest


def _as_text(expr: str, type_name: str) -> str:
    return expr if is_text(type_name) else f"CAST({expr} AS VARCHAR)"


def _indent(sql: str, n: int) -> str:
    return "\n".join(" " * n + line for line in sql.splitlines())


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
    """(the relation the recipe reads, extra tables, how the exported code names it)."""
    if "table" in source:
        return ident(source["table"]), {}, source["table"]
    table = results.full(source["result_id"])
    return "source", {"source": table}, "source"


def compile_recipe(ws: Any, results: Any, source: dict[str, Any], steps: list[dict[str, Any]]) -> tuple[Compiler, str]:
    relation, tables, name = _source(results, source)
    comp = Compiler(ws, relation, tables)
    for s in steps:
        if s.get("enabled", True):
            try:
                comp.step(s["op"])
            except Exception as e:  # noqa: BLE001
                raise ValueError(f"step '{s.get('label') or s['op'].get('kind')}': {e}") from e
    return comp, name


def code(comp: Compiler, name: str, from_result: bool) -> dict[str, str]:
    from iara.kernel.wrangle_python import python_code

    return {"sql": comp.final(), "python": python_code(comp.applied, name, from_result, comp.order)}


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
