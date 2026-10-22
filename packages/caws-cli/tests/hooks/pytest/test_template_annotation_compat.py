"""Hook-pack Python templates must import on the stock macOS python3 (3.9).

CAWS-SHARED-HOOK-PY39-ANNOTATIONS-01. Python 3.9 evaluates function signature
annotations and module/class-level variable annotations when the defining
statement runs, and an `X | Y` union between types raises TypeError there
(PEP 604 is 3.10+). CI runs a newer interpreter, so that crash never shows up
in CI; this test pins the rule syntactically on any interpreter: a template
that writes a `|` union in an evaluated annotation must defer annotations
with `from __future__ import annotations`.
"""

import ast
from pathlib import Path

# tests/hooks/pytest/<this file> -> packages/caws-cli
_CLI_PKG_ROOT = Path(__file__).resolve().parents[3]
_TEMPLATES = _CLI_PKG_ROOT / "templates" / "hook-packs"
_EXCLUDED_DIRS = {"__pycache__", "tmp", "node_modules"}


def _defers_annotations(tree: ast.Module) -> bool:
    return any(
        isinstance(node, ast.ImportFrom)
        and node.module == "__future__"
        and any(alias.name == "annotations" for alias in node.names)
        for node in tree.body
    )


def _evaluated_annotations(nodes, in_function):
    """Yield the annotations Python evaluates when their statement executes."""
    for node in nodes:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            args = node.args
            for arg in (*args.posonlyargs, *args.args, *args.kwonlyargs, args.vararg, args.kwarg):
                if arg is not None and arg.annotation is not None:
                    yield arg.annotation
            if node.returns is not None:
                yield node.returns
            yield from _evaluated_annotations(node.body, True)
        elif isinstance(node, ast.ClassDef):
            yield from _evaluated_annotations(node.body, False)
        else:
            # Local variable annotations inside a function body are never evaluated.
            if isinstance(node, ast.AnnAssign) and not in_function:
                yield node.annotation
            children = [
                child
                for child in ast.iter_child_nodes(node)
                if isinstance(child, (ast.stmt, ast.excepthandler))
            ]
            yield from _evaluated_annotations(children, in_function)


def undeferred_union_lines(source: str, filename: str = "<template>") -> list[int]:
    """Line numbers of evaluated `X | Y` annotations in a module that does not defer them."""
    tree = ast.parse(source, filename=filename)
    if _defers_annotations(tree):
        return []
    return sorted(
        annotation.lineno
        for annotation in _evaluated_annotations(tree.body, False)
        if any(
            isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr)
            for node in ast.walk(annotation)
        )
    )


def _template_modules() -> list[Path]:
    return sorted(
        path
        for path in _TEMPLATES.rglob("*.py")
        if not _EXCLUDED_DIRS.intersection(path.relative_to(_TEMPLATES).parts)
    )


def test_shipped_templates_import_on_python_3_9():
    modules = _template_modules()
    scanned = {path.relative_to(_TEMPLATES).as_posix() for path in modules}
    # The scan must reach the renderer's import chain, or an empty walk would pass.
    assert "shared/session_log_renderer.py" in scanned
    assert "shared/lib/harness_kimi.py" in scanned
    offenders = [
        f"{path.relative_to(_TEMPLATES).as_posix()}:{line}"
        for path in modules
        for line in undeferred_union_lines(path.read_text(encoding="utf-8"), str(path))
    ]
    assert offenders == []


def test_signature_union_without_future_import_is_flagged():
    assert undeferred_union_lines("def f(x: str | None) -> int:\n    return 1\n") == [1]
    assert undeferred_union_lines("def f() -> int | None:\n    return None\n") == [1]


def test_module_and_class_variable_unions_are_flagged():
    assert undeferred_union_lines("value: int | None = None\n") == [1]
    assert undeferred_union_lines("class C:\n    value: int | None = None\n") == [2]


def test_deferred_or_unevaluated_unions_are_accepted():
    assert (
        undeferred_union_lines(
            "from __future__ import annotations\ndef f(x: str | None) -> int | None:\n    return None\n"
        )
        == []
    )
    # A local variable annotation is never evaluated, so 3.9 accepts it.
    assert undeferred_union_lines("def f():\n    value: int | None = None\n    return value\n") == []
    # A quoted annotation is a string, not an evaluated union.
    assert undeferred_union_lines("def f(x: 'str | None'):\n    return x\n") == []
