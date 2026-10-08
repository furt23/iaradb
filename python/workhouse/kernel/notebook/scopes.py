"""Python scope analysis on the AST: names a module binds and names it reads.

``symtable`` cannot be used: since Python 3.12 list/set/dict comprehensions
are inlined (PEP 709) and their loop variables show up as module bindings.
This visitor follows the language rules instead: function, lambda, class and
comprehension scopes; walrus targets binding in the enclosing function or
module; ``global`` declarations; class scopes not enclosing nested functions.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass, field


@dataclass
class Scope:
    kind: str  # module | function | class | comprehension
    bound: set[str] = field(default_factory=set)
    loads: set[str] = field(default_factory=set)
    globals: set[str] = field(default_factory=set)
    children: list[Scope] = field(default_factory=list)

    def free(self) -> set[str]:
        """Names read in this scope or nested ones that are not bound here."""
        local = self.bound - self.globals
        out = {n for n in self.loads if n not in local}
        for child in self.children:
            names = child.free()
            # class bodies do not enclose the functions defined inside them
            out |= names if self.kind == "class" else {n for n in names if n not in local}
        return out


class ScopeVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.module = Scope("module")
        self.stack = [self.module]

    @property
    def scope(self) -> Scope:
        return self.stack[-1]

    def _bind(self, name: str) -> None:
        self.scope.bound.add(name)
        if name in self.scope.globals:
            self.module.bound.add(name)

    def _enter(self, kind: str) -> Scope:
        s = Scope(kind)
        self.scope.children.append(s)
        self.stack.append(s)
        return s

    def _leave(self) -> None:
        self.stack.pop()

    # -- names ---------------------------------------------------------------
    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, ast.Store):
            self._bind(node.id)
        elif isinstance(node.ctx, ast.Load):
            self.scope.loads.add(node.id)

    def visit_NamedExpr(self, node: ast.NamedExpr) -> None:
        self.visit(node.value)
        target = next(s for s in reversed(self.stack) if s.kind != "comprehension")
        target.bound.add(node.target.id)

    def visit_Global(self, node: ast.Global) -> None:
        self.scope.globals.update(node.names)

    def visit_Nonlocal(self, node: ast.Nonlocal) -> None:
        self.scope.globals.update(node.names)  # not local; resolved outward

    def visit_Import(self, node: ast.Import) -> None:
        for a in node.names:
            self._bind(a.asname or a.name.split(".")[0])

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        for a in node.names:
            if a.name != "*":
                self._bind(a.asname or a.name)

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        if node.name:
            self._bind(node.name)
        self.generic_visit(node)

    def visit_MatchAs(self, node: ast.MatchAs) -> None:
        if node.name:
            self._bind(node.name)
        self.generic_visit(node)

    def visit_MatchStar(self, node: ast.MatchStar) -> None:
        if node.name:
            self._bind(node.name)

    def visit_MatchMapping(self, node: ast.MatchMapping) -> None:
        if node.rest:
            self._bind(node.rest)
        self.generic_visit(node)

    # -- scopes --------------------------------------------------------------
    def _arguments(self, args: ast.arguments) -> None:
        """Defaults and annotations are evaluated in the enclosing scope."""
        for d in [*args.defaults, *args.kw_defaults]:
            if d is not None:
                self.visit(d)
        for a in [*args.posonlyargs, *args.args, *args.kwonlyargs, args.vararg, args.kwarg]:
            if a is not None and a.annotation is not None:
                self.visit(a.annotation)

    @staticmethod
    def _params(args: ast.arguments) -> set[str]:
        return {a.arg for a in [*args.posonlyargs, *args.args, *args.kwonlyargs, args.vararg, args.kwarg] if a is not None}

    def _function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        for d in node.decorator_list:
            self.visit(d)
        self._arguments(node.args)
        if node.returns is not None:
            self.visit(node.returns)
        self._bind(node.name)
        self._enter("function").bound.update(self._params(node.args))
        for stmt in node.body:
            self.visit(stmt)
        self._leave()

    visit_FunctionDef = _function
    visit_AsyncFunctionDef = _function

    def visit_Lambda(self, node: ast.Lambda) -> None:
        self._arguments(node.args)
        self._enter("function").bound.update(self._params(node.args))
        self.visit(node.body)
        self._leave()

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        for n in [*node.decorator_list, *node.bases, *node.keywords]:
            self.visit(n)
        self._bind(node.name)
        self._enter("class")
        for stmt in node.body:
            self.visit(stmt)
        self._leave()

    def _comprehension(self, node: ast.ListComp | ast.SetComp | ast.GeneratorExp | ast.DictComp) -> None:
        gens = node.generators
        self.visit(gens[0].iter)  # the first iterable is evaluated outside
        self._enter("comprehension")
        for i, g in enumerate(gens):
            if i:
                self.visit(g.iter)
            self.visit(g.target)
            for cond in g.ifs:
                self.visit(cond)
        if isinstance(node, ast.DictComp):
            self.visit(node.key)
            self.visit(node.value)
        else:
            self.visit(node.elt)
        self._leave()

    visit_ListComp = _comprehension
    visit_SetComp = _comprehension
    visit_GeneratorExp = _comprehension
    visit_DictComp = _comprehension


def module_scope(tree: ast.Module) -> Scope:
    v = ScopeVisitor()
    for stmt in tree.body:
        v.visit(stmt)
    return v.module
