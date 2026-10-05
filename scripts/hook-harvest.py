#!/usr/bin/env python3
"""Inventory a consumer's hooks against CAWS's shared source pack, without executing hooks.

Write stdout to ignored scratch storage. The report contains paths, sizes, hashes,
and literal dispatcher declarations, never source or transcript payloads. It is
comparison evidence, not an authority decision or proof of runtime activation.
"""

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess


EXCLUDED_DIRS = {"node_modules", "__pycache__", ".pytest_cache", ".pristine", "state", "logs"}


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def normalize_stamp(data):
    return b"\n".join(
        b"# hook_pack_version: <stamp>" if re.fullmatch(rb"# hook_pack_version: \d+", line) else line
        for line in data.split(b"\n")
    )


def inventory(root):
    files, excluded = {}, []
    for current, dirs, names in os.walk(root, followlinks=False):
        current = Path(current)
        dirs.sort()
        for name in dirs[:]:
            path = current / name
            if name in EXCLUDED_DIRS or path.is_symlink():
                dirs.remove(name)
                excluded.append({"path": str(path.relative_to(root)), "reason": "dependency/cache/state or symlink subtree"})
        for name in sorted(names):
            path = current / name
            relative = str(path.relative_to(root))
            if path.is_symlink() or name == ".DS_Store" or path.suffix in {".pyc", ".log"}:
                excluded.append({"path": relative, "reason": "symlink or generated file"})
            elif path.is_file():
                files[relative] = path.read_bytes()
    return files, sorted(excluded, key=lambda row: row["path"])


def declarations(data):
    """Read literal multiline HANDLERS arrays. Never evaluate shell expressions."""
    declared, commented, unresolved = [], [], []
    inside = False
    for number, line in enumerate(data.decode(errors="replace").splitlines(), 1):
        if re.match(r"^\s*(?:_ALL_)?HANDLERS=\(\s*$", line):
            inside = True
            continue
        if not inside:
            continue
        if line.strip() == ")":
            inside = False
            continue
        value = line.strip()
        is_comment = value.startswith("#")
        if is_comment:
            value = value[1:].strip()
        try:
            tokens = shlex.split(value, comments=True)
        except ValueError:
            if not is_comment:
                unresolved.append(number)
            continue
        if not tokens:
            continue
        # A comment beginning with a handler name can be explanatory prose.
        # Recognize only one literal array element on a commented line.
        if is_comment and len(tokens) != 1:
            continue
        for entry in tokens:
            if re.fullmatch(r"[A-Za-z0-9_./-]+\.sh(?: [A-Za-z0-9_./-]+)*", entry):
                (commented if is_comment else declared).append({"entry": entry, "line": number})
            elif not is_comment:
                unresolved.append(number)
    return {"declared": declared, "commented": commented, "unresolved_lines": unresolved}


def category(path):
    if path.startswith("tests/"):
        return "test-or-fixture"
    if path in {"package.json", "package-lock.json"}:
        return "dependency-metadata"
    if path.startswith("adapter-surface-policies/"):
        return "project-surface-policy"
    return "hook-source-or-support"


def compare(left, right):
    rows = []
    for path in sorted(left.keys() | right.keys()):
        a, b = left.get(path), right.get(path)
        if a is None:
            status = "caws-only"
        elif b is None:
            status = "consumer-only"
        elif a == b:
            status = "identical"
        elif normalize_stamp(a) == normalize_stamp(b):
            status = "version-stamp-only"
        else:
            status = "different"
        rows.append({
            "path": path, "category": category(path), "status": status,
            "consumer_bytes": len(a) if a is not None else None,
            "caws_bytes": len(b) if b is not None else None,
            "consumer_sha256": sha256(a) if a is not None else None,
            "caws_sha256": sha256(b) if b is not None else None,
        })
    return rows


def snapshot(repo, hook_root):
    head = git(repo, "rev-parse", "HEAD").strip()
    status = git(repo, "status", "--porcelain", "--", str(hook_root))
    files, excluded = inventory(hook_root)
    # A second read detects changing input bytes even when HEAD stays fixed.
    again, excluded_again = inventory(hook_root)
    if (files != again or excluded != excluded_again
            or git(repo, "rev-parse", "HEAD").strip() != head
            or git(repo, "status", "--porcelain", "--", str(hook_root)) != status):
        raise RuntimeError(f"source changed during inventory: {hook_root}; retry when stable")
    metadata = {"root": str(repo), "hooks_root": str(hook_root), "head": head,
                "status": status, "excluded": excluded}
    return files, metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--consumer-root", type=Path, required=True)
    parser.add_argument("--caws-root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    consumer, caws = args.consumer_root.resolve(), args.caws_root.resolve()
    left_root = consumer / ".caws/hooks"
    right_root = caws / "packages/caws-cli/templates/hook-packs/shared"
    for root in (left_root, right_root):
        if not root.is_dir() or root.is_symlink():
            parser.error(f"hook source must be a real directory: {root}")
    left, left_meta = snapshot(consumer, left_root)
    right, right_meta = snapshot(caws, right_root)
    tracked = set(git(consumer, "ls-files", "-z", "--", ".caws/hooks").split("\0"))
    rows = compare(left, right)
    for row in rows:
        row["consumer_tracked"] = f".caws/hooks/{row['path']}" in tracked
    print(json.dumps({
        "schema": "caws.consumer_hook_harvest.v1",
        "limits": ["Byte differences do not establish missing capabilities or edit authorship.",
                   "Declarations do not establish effective native registration or execution.",
                   "No hooks executed and no payload text copied.",
                   "Excluded subtrees are not recursively inventoried.",
                   "Sequential stable reads are not a cross-repository atomic snapshot."],
        "consumer": left_meta, "caws": right_meta,
        "counts": dict(Counter(row["status"] for row in rows)), "files": rows,
        "dispatchers": {
            label: {path: declarations(data) for path, data in sorted(files.items())
                    if path.startswith("dispatch/") and path.endswith(".sh")}
            for label, files in (("consumer", left), ("caws", right))
        },
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
