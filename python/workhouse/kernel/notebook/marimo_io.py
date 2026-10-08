"""Read and write notebooks in marimo's ``.py`` file format.

A marimo notebook is a Python module whose cells are functions decorated
with ``@app.cell``; parameters are the names a cell reads from other cells,
the returned tuple the names it defines::

    import marimo

    __generated_with = "0.16.0"
    app = marimo.App(width="medium")


    @app.cell
    def _(wh):
        ws = wh.workspace()
        return (ws,)


    if __name__ == "__main__":
        app.run()

Files stay valid marimo notebooks and plain runnable scripts, and diff well.
"""

from __future__ import annotations

import ast
import textwrap
from pathlib import Path

from workhouse.kernel.notebook.codegen import INDENT, detect_markdown, detect_sql, markdown_source, sql_source
from workhouse.kernel.notebook.graph import DependencyGraph
from workhouse.kernel.notebook.model import Cell, Notebook, new_cell_id

FOOTER = 'if __name__ == "__main__":\n    app.run()\n'

TEMPLATE_CELL = """import marimo as mo
import workhouse as wh

ws = wh.workspace()"""


def new_notebook(path: Path) -> Notebook:
    return Notebook(path=path, cells=[Cell(new_cell_id(), "python", TEMPLATE_CELL)], app_args='width="medium"')


# ---------------------------------------------------------------------------
# reading
# ---------------------------------------------------------------------------


def _decorator_config(fn: ast.FunctionDef, src: str) -> tuple[bool, dict]:
    """(is a cell, decorator keyword options)."""
    for d in fn.decorator_list:
        target = d.func if isinstance(d, ast.Call) else d
        if isinstance(target, ast.Attribute) and target.attr == "cell" and isinstance(target.value, ast.Name) and target.value.id == "app":
            config = {}
            if isinstance(d, ast.Call):
                for k in d.keywords:
                    try:
                        config[k.arg] = ast.literal_eval(k.value)
                    except ValueError:
                        config[k.arg] = ast.get_source_segment(src, k.value)
            return True, config
    return False, {}


def _header_end(fn: ast.FunctionDef, lines: list[str]) -> int:
    """0-based index of the line holding the ``:`` that ends the signature."""
    first_body = fn.body[0].lineno - 1
    for i in range(fn.lineno - 1, first_body + 1):
        code = lines[i].split("#", 1)[0].rstrip()
        if code.endswith(":"):
            return i
    return fn.lineno - 1


def _body_source(fn: ast.FunctionDef | ast.With, lines: list[str], header_end: int) -> str:
    body = fn.body
    end = fn.end_lineno or body[-1].end_lineno
    if isinstance(fn, ast.FunctionDef) and isinstance(body[-1], ast.Return):
        end = body[-1].lineno - 1
    text = "\n".join(lines[header_end + 1 : end])
    return textwrap.dedent(text).strip("\n")


def _cell_from_code(code: str, name: str, config: dict) -> Cell:
    sql = detect_sql(code)
    if sql is not None:
        query, output = sql
        return Cell(new_cell_id(), "sql", query, name=name, output=output, config=config)
    md = detect_markdown(code)
    if md is not None:
        return Cell(new_cell_id(), "markdown", md, name=name, config=config)
    return Cell(new_cell_id(), "python", code, name=name, config=config)


def _is_app_assign(node: ast.stmt) -> bool:
    return isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "app" for t in node.targets)


def _is_setup(node: ast.stmt) -> bool:
    return (
        isinstance(node, ast.With)
        and len(node.items) == 1
        and isinstance(node.items[0].context_expr, ast.Attribute)
        and node.items[0].context_expr.attr == "setup"
    )


def _is_boilerplate(node: ast.stmt) -> bool:
    if isinstance(node, ast.Import) and [a.name for a in node.names] == ["marimo"]:
        return True
    if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "__generated_with" for t in node.targets):
        return True
    return isinstance(node, ast.If) and "__name__" in ast.dump(node.test)


def parse(src: str, path: Path) -> Notebook:
    tree = ast.parse(src)
    lines = src.splitlines()
    nb = Notebook(path=path)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef):
            is_cell, config = _decorator_config(node, src)
            if is_cell:
                code = _body_source(node, lines, _header_end(node, lines))
                nb.cells.append(_cell_from_code(code, node.name, config))
                continue
        if _is_setup(node):
            code = _body_source(node, lines, node.lineno - 1)
            nb.cells.append(Cell(new_cell_id(), "python", code, name="setup", setup=True))
        elif _is_app_assign(node):
            call = node.value
            if isinstance(call, ast.Call):
                seg = ast.get_source_segment(src, call) or ""
                nb.app_args = seg[seg.index("(") + 1 : -1].strip()
        elif isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "__generated_with" for t in node.targets):
            if isinstance(node.value, ast.Constant):
                nb.generated_with = str(node.value.value)
        elif not _is_boilerplate(node):
            start = (node.decorator_list[0].lineno if getattr(node, "decorator_list", None) else node.lineno) - 1
            nb.extra.append("\n".join(lines[start : node.end_lineno]))
    return nb


def read(path: Path) -> Notebook:
    return parse(path.read_text(encoding="utf-8"), path)


# ---------------------------------------------------------------------------
# writing
# ---------------------------------------------------------------------------


def _decorator(config: dict) -> str:
    if not config:
        return "@app.cell"
    args = ", ".join(f"{k}={v!r}" for k, v in config.items())
    return f"@app.cell({args})"


def _signature(name: str, params: list[str]) -> str:
    one_line = f"def {name}({', '.join(params)}):"
    if len(one_line) <= 88:
        return one_line
    return f"def {name}(\n" + "".join(f"{INDENT}{p},\n" for p in params) + "):"


def _returns(defs: list[str]) -> str:
    if not defs:
        return "return"
    if len(defs) == 1:
        return f"return ({defs[0]},)"
    return "return " + ", ".join(defs)


def cell_code(cell: Cell, graph: DependencyGraph) -> str:
    """Python source of a cell's body (generated for SQL and markdown cells)."""
    if cell.kind == "sql":
        tables = [r for r in graph.deps[cell.id].refs if r != "ws"]
        return sql_source(cell.output, cell.code, tables)
    if cell.kind == "markdown":
        return markdown_source(cell.code)
    return cell.code


def _setup_names(nb: Notebook, graph: DependencyGraph) -> set[str]:
    return {n for c in nb.cells if c.setup for n in graph.analyses[c.id].defs}


def _render_cell(cell: Cell, graph: DependencyGraph, globals_: set[str]) -> str:
    code = cell_code(cell, graph)
    if cell.setup:
        return "with app.setup:\n" + textwrap.indent(code or "pass", INDENT)
    deps = graph.deps[cell.id]
    params = sorted(set(deps.refs) - globals_)
    if cell.kind == "sql":
        params = sorted(set(params) | ({"ws"} - globals_))
    elif cell.kind == "markdown":
        params = ["mo"] if "mo" not in globals_ else []
    defs = sorted(graph.analyses[cell.id].defs)
    body = textwrap.indent(code, INDENT, lambda line: bool(line.strip())) if code.strip() else ""
    parts = [_decorator(cell.config), _signature(cell.name or "_", params)]
    if body:
        parts.append(body)
    parts.append(INDENT + _returns(defs))
    return "\n".join(parts)


def serialize(nb: Notebook) -> str:
    graph = DependencyGraph(nb.cells)
    globals_ = _setup_names(nb, graph)
    header = f'import marimo\n\n__generated_with = "{nb.generated_with}"\napp = marimo.App({nb.app_args})\n'
    blocks = [header]
    setup = [c for c in nb.cells if c.setup]
    blocks += [_render_cell(c, graph, globals_) for c in setup]
    blocks += [_render_cell(c, graph, globals_) for c in nb.cells if not c.setup]
    blocks += nb.extra
    blocks.append(FOOTER)
    # two blank lines between top-level blocks, as marimo writes them
    return "\n\n".join(b.rstrip("\n") + "\n" for b in blocks)


def write(nb: Notebook) -> None:
    nb.path.parent.mkdir(parents=True, exist_ok=True)
    nb.path.write_text(serialize(nb), encoding="utf-8", newline="\n")
