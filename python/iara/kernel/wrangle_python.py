"""The Data Wrangler's recipes as Python: a chain of frame methods.

The SQL export folds steps into few SELECTs (see ``wrangle.Compiler``); the
Python export keeps one method call per step, the way someone would write
it, and lets the engine optimize the lazy plan. Both give the same rows.
"""

from __future__ import annotations

import json
from typing import Any

from iara.kernel.wrangle import _COMPARE, _sql_type, ident, is_numeric, is_text, literal, pivot_sql, unpivot_sql

#: the API's names for the wrangler's cast targets
_DTYPES = {"int64": "Int64", "float64": "Float64", "utf8": "Utf8", "bool": "Boolean", "date": "Date32", "timestamp": "Timestamp"}
_OPS = {"=": "==", "<>": "!="}
_CASE = {"upper": "to_uppercase", "lower": "to_lowercase", "title": "to_titlecase"}
_INTS = ("Int8", "Int16", "Int32", "Int64", "UInt8", "UInt16", "UInt32", "UInt64")
#: the expression method of each aggregation
_AGGS = {"count": "count", "count_distinct": "n_unique", "sum": "sum", "avg": "mean", "min": "min", "max": "max", "median": "median"}


def _s(value: Any) -> str:
    return json.dumps(str(value), ensure_ascii=False)


def _col(name: str) -> str:
    return f"F.col({_s(name)})"


def _value(value: Any, type_name: str) -> str:
    """A Python literal for a value compared with (or put in) a column of ``type_name``."""
    if value is None or isinstance(value, bool):
        return str(value)
    if is_numeric(type_name):
        literal(value, type_name)  # the same check as the SQL
        number = float(value)
        return str(int(number)) if number.is_integer() and "." not in str(value) else repr(number)
    return _s(value)


def _text(name: str, type_name: str) -> str:
    return _col(name) if is_text(type_name) else f'{_col(name)}.cast("Utf8")'


def _back(type_name: str) -> str:
    """A cast back to an integer column's type (a mean or a float constant would widen it).

    The cast rounds, the same as SQL's CAST."""
    return f".cast({_s(type_name)})" if type_name in _INTS else ""


def _call(method: str, *args: str) -> str:
    one = f".{method}({', '.join(args)})"
    if len(one) <= 88 or len(args) < 2:
        return one
    return f".{method}(\n" + "".join(f"        {a},\n" for a in args) + "    )"


def _sql_step(query: str) -> str:
    """A step the frame API has no call for: SQL over the frame so far (`self`)."""
    # the last quote must not join the closing ones, nor a run of three end the string early
    body = query.replace("\\", "\\\\")
    if body.endswith('"'):
        body = body[:-1] + '\\"'
    body = body.replace('"""', '""\\"')
    return f'.sql("""{body}""")'


def python_step(op: dict[str, Any], schema: dict[str, str]) -> str:
    """One step as a method call on the frame (``.filter(...)``)."""
    kind = op["kind"]
    if kind == "filter":
        name, o = op["column"], op["op"]
        t, c = schema[name], _col(name)
        if o == "is_null":
            pred = f"{c}.is_null()"
        elif o == "is_not_null":
            pred = f"{c}.is_not_null()"
        elif o in _COMPARE:
            sym = _COMPARE[o]
            pred = f"{c} {_OPS.get(sym, sym)} {_value(op.get('value'), t)}"
        elif o == "between":
            pred = f"{c}.is_between({_value(op.get('value'), t)}, {_value(op.get('value2'), t)})"
        elif o in ("contains", "not_contains"):
            pred = f"{'~' if o == 'not_contains' else ''}{_text(name, t)}.str.contains({_s(op.get('value', ''))}, literal=True)"
        elif o in ("starts_with", "ends_with"):
            pred = f"{_text(name, t)}.str.{o}({_s(op.get('value', ''))})"
        else:
            raise ValueError(f"unknown filter {o!r}")
        return _call("filter", pred)
    if kind == "drop_columns":
        return _call("drop", *(_s(c) for c in op["columns"]))
    if kind == "rename_column":
        return f".rename({{{_s(op['from'])}: {_s(op['to'])}}})"
    if kind == "cast":
        return _call("with_columns", f"{_col(op['column'])}.cast({_s(_DTYPES[op['toType']])})")
    if kind == "fill_null":
        name, s = op["column"], op["strategy"]
        t, c = schema[name], _col(name)
        if s == "constant":
            v = _value(op.get("value"), t)
            # an integer constant keeps an integer column's type; a float one would widen it
            back = _back(t) if is_numeric(t) and not v.lstrip("-").isdigit() else ""
            return _call("with_columns", f"{c}.fill_null({v}){back}")
        if s in ("mean", "median"):
            return _call("with_columns", f"{c}.fill_null({c}.{s}().over()){_back(t)}")
        # no mode in the expression API: the step runs as SQL over the frame so far (`self`)
        q = ident(name)
        mode = f"(SELECT {q} FROM self WHERE {q} IS NOT NULL GROUP BY {q} ORDER BY count(*) DESC, {q} LIMIT 1)"
        return _sql_step(f"SELECT * REPLACE (CAST(coalesce({q}, {mode}) AS {_sql_type(t)}) AS {q}) FROM self")
    if kind == "drop_nulls":
        cols = op.get("columns") or []
        return ".drop_nulls()" if not cols else f".drop_nulls(subset=[{', '.join(_s(c) for c in cols)}])"
    if kind == "text_case":
        return _call("with_columns", f"{_col(op['column'])}.str.{_CASE[op['mode']]}()")
    if kind == "text_trim":
        return _call("with_columns", f"{_col(op['column'])}.str.strip_chars()")
    if kind == "text_replace":
        literal_flag = "" if op.get("isRegex") else ", literal=True"
        expr = f"{_col(op['column'])}.str.replace_all({_s(op['pattern'])}, {_s(op.get('replacement', ''))}{literal_flag})"
        return _call("with_columns", expr)
    if kind == "split_column":
        name = op["column"]
        n = max(1, int(op.get("numParts") or 2))
        parts = f"{_text(name, schema[name])}.str.split({_s(op['delimiter'])})"
        return _call("with_columns", *(f"{parts}.list.get({i}).alias({_s(f'{name}_{i + 1}')})" for i in range(n)))
    if kind == "deduplicate":
        subset = op.get("subset") or []
        return ".unique()" if not subset else f".unique(subset=[{', '.join(_s(c) for c in subset)}])"
    if kind == "one_hot_encode":
        name = op["column"]
        flags = [
            f"F.when({_col(name)} == {_value(v, schema[name])}).then(1).otherwise(0).alias({_s(f'{name}_{v}')})" for v in op["values"]
        ]
        return _call("with_columns", *flags) if flags else ""
    if kind == "math_round":
        return _call("with_columns", f"{_col(op['column'])}.round({int(op['decimals'])})")
    if kind == "group_by":
        aggs = [_agg(a) for a in op["aggs"]]
        group = f".group_by({', '.join(_s(k) for k in op['keys'])})" if op["keys"] else ""
        return group + _call("agg", *aggs)
    if kind == "join":
        on = op["on"]
        # the right frame carries only the keys (named as the left's, so the join keeps one) and the new columns
        keys = [_col(p["right"]) if p["right"] == p["left"] else f"{_col(p['right'])}.alias({_s(p['left'])})" for p in on]
        picks = [_col(c) if c == out else f"{_col(c)}.alias({_s(out)})" for c, out in zip(op["columns"], op["values"])]
        right = f"ws.table({_s(op['table'])}).select({', '.join(keys + picks)})"
        return _call("join", right, f"on=[{', '.join(_s(p['left']) for p in on)}]", f"how={_s(op['how'])}")
    if kind == "date_part":
        return _call("with_columns", f"{_col(op['column'])}.dt.{op['part']}().alias({_s(op['as'])})")
    if kind == "date_trunc":
        return _call("with_columns", f"{_col(op['column'])}.dt.truncate({_s(op['unit'])}).alias({_s(op['as'])})")
    if kind == "calculated":
        cell = f"({op['expression']}) AS {ident(op['name'])}"
        return _sql_step(f"SELECT * REPLACE ({cell}) FROM self" if op["name"] in schema else f"SELECT *, {cell} FROM self")
    if kind == "pivot":
        return _sql_step(pivot_sql("self", op, schema))
    if kind == "unpivot":
        return _sql_step(unpivot_sql("self", op, schema))
    raise ValueError(f"unknown step {kind!r}")


def _agg(a: dict[str, Any]) -> str:
    expr = "F.len()" if a.get("column") is None else f"{_col(a['column'])}.{_AGGS[a['fn']]}()"
    return f"{expr}.alias({_s(a['as'])})"


def python_code(steps: list[tuple[dict[str, Any], dict[str, str]]], name: str, from_result: bool, order: tuple[str, bool] | None) -> str:
    """The recipe as Python: the source, then one call per step, then the sort.

    It runs in a notebook (``ws`` is the setup cell's) and imports the
    expression functions as ``F`` when a step needs them."""
    source = "df.lazy()" if from_result else f"ws.table({_s(name)})"
    calls = [python_step(op, schema) for op, schema in steps]
    if order:
        calls.append(f".sort({_s(order[0])}{', descending=True' if order[1] else ''}, nulls_last=True)")
    calls = [c for c in calls if c]
    head = "# `df`: the result to wrangle\n" if from_result else ""
    if any("F." in c for c in calls):
        head += "from iara import functions as F\n\n"
    if not calls:
        return f"{head}wrangled = {source}"
    body = "".join(f"    {c}\n" for c in calls)
    return f"{head}wrangled = (\n    {source}\n{body})"

