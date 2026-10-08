"""Code assistance for notebook cells: completions, call signatures and
diagnostics, computed in the kernel (where the cells' values live)."""

from workhouse.kernel.assist.completion import complete, signature
from workhouse.kernel.assist.lint import lint_python, lint_sql

__all__ = ["complete", "signature", "lint_python", "lint_sql"]
