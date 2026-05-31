#!/usr/bin/env python3
"""Zero-decision-change proof harness for the capability engine (Slice 1+).

Compares the CURRENT classifier template against the PRE-capability-engine
baseline blob over the full real-agent command corpus, and proves the
capability scaffolding changed NO classifier decision.

Hostile to false success (HOOK-CAPABILITY-ENGINE-001 acceptance):
  - AC mode (--require-corpus --expected-count N) exits NONZERO unless it ran
    exactly N rows with changed=0 AND errors=0. A missing/short corpus is a
    distinct SKIP result that can NEVER be reported as a pass.
  - Self-validates the baseline: the baseline blob must NOT contain the
    capability markers and the current template MUST. A wrong SHA / branch
    context fails here instead of silently producing a clean zero-diff against
    the wrong artifacts.

Default (local) mode may skip when the corpus is absent (dev ergonomics);
only AC mode is admissible as acceptance evidence.

The 4,882-command corpus lives in the surgery-ward repo (real operational
data, intentionally not committed here):
  <surgery-ward>/tmp/hook-review/commands_extracted.txt   (tag<TAB>cmd per line)
Regenerate via surgery-ward/tmp/hook-review/stress_extract.py if absent.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# Markers that distinguish a post-capability-engine template from the baseline.
CAPABILITY_MARKERS = ("CommandFact", "CAWS_CLASSIFY_FACTS_DUMP", "MAX_RECURSION_DEPTH")

REPO_REL_TEMPLATE = "packages/caws-cli/templates/hook-packs/claude-code/classify_command.py"
DEFAULT_BASELINE_SHA = "205800c"  # pre-capability-engine blob (Slice 0 parent)
DEFAULT_CORPUS = (
    Path.home()
    / "Desktop/Projects/surgery-ward/tmp/hook-review/commands_extracted.txt"
)


def classify(hook_path: str, cmd: str, repo_root: str) -> str | None:
    """Run one command through a classifier; return decision or None on error."""
    try:
        r = subprocess.run(
            ["python3", hook_path, "--repo-root", repo_root,
             "--home", "/tmp/fake-home", "--cwd", repo_root],
            input=cmd, capture_output=True, text=True, timeout=15,
        )
        if r.returncode != 0:
            return None
        return json.loads(r.stdout).get("decision")
    except (subprocess.SubprocessError, ValueError):
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description="capability-engine zero-change proof")
    ap.add_argument("--repo-root", default=None)
    ap.add_argument("--baseline-sha", default=DEFAULT_BASELINE_SHA)
    ap.add_argument("--corpus", default=str(DEFAULT_CORPUS))
    ap.add_argument("--out", default="stress_changed.tsv")
    ap.add_argument("--require-corpus", action="store_true",
                    help="AC mode: fail (nonzero) if the corpus is absent/short")
    ap.add_argument("--expected-count", type=int, default=None,
                    help="AC mode: require exactly this many corpus rows")
    args = ap.parse_args()

    repo_root = args.repo_root or subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True
    ).stdout.strip()
    current = os.path.join(repo_root, REPO_REL_TEMPLATE)

    def emit(summary: dict, exit_code: int) -> int:
        print(json.dumps(summary, indent=2))
        return exit_code

    # --- self-validate baseline + current (footgun #5) -----------------------
    try:
        baseline_src = subprocess.run(
            ["git", "show", f"{args.baseline_sha}:{REPO_REL_TEMPLATE}"],
            cwd=repo_root, capture_output=True, text=True, check=True,
        ).stdout
    except subprocess.CalledProcessError:
        return emit({"result": "FAIL", "reason": f"cannot read baseline blob {args.baseline_sha}"}, 1)
    current_src = Path(current).read_text(encoding="utf-8")
    baseline_markers_absent = not any(m in baseline_src for m in CAPABILITY_MARKERS)
    current_markers_present = all(m in current_src for m in CAPABILITY_MARKERS)
    if not (baseline_markers_absent and current_markers_present):
        return emit({
            "result": "FAIL", "reason": "baseline/current marker self-validation failed",
            "baseline_sha": args.baseline_sha,
            "baseline_markers_absent": baseline_markers_absent,
            "current_markers_present": current_markers_present,
        }, 1)

    # --- corpus presence -----------------------------------------------------
    corpus = Path(args.corpus)
    if not corpus.is_file():
        summary = {
            "result": "SKIP", "reason": "corpus absent",
            "corpus": str(corpus),
            "hint": "generate via surgery-ward/tmp/hook-review/stress_extract.py",
        }
        # AC mode: absent corpus is a hard failure, never a silent pass.
        return emit(summary, 1 if args.require_corpus else 0)

    lines = [ln for ln in corpus.read_text(encoding="utf-8").splitlines() if ln.strip()]
    if args.expected_count is not None and len(lines) != args.expected_count:
        return emit({
            "result": "SKIP" if not args.require_corpus else "FAIL",
            "reason": f"corpus row count {len(lines)} != expected {args.expected_count}",
            "corpus": str(corpus),
        }, 1 if args.require_corpus else 0)

    # --- materialize baseline to a tempfile + compare ------------------------
    changed, errors = [], 0
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as tf:
        tf.write(baseline_src)
        baseline_path = tf.name
    try:
        for ln in lines:
            tag, _, cmd = ln.partition("\t")
            if not cmd:
                cmd, tag = tag, "untagged"
            d_pre = classify(baseline_path, cmd, repo_root)
            d_post = classify(current, cmd, repo_root)
            if d_pre is None or d_post is None:
                errors += 1
                continue
            if d_pre != d_post:
                changed.append((tag, d_pre, d_post, cmd))
    finally:
        os.unlink(baseline_path)

    with open(args.out, "w", encoding="utf-8") as f:
        f.write("tag\tpre\tpost\tcmd\n")
        for tag, pre, post, cmd in changed:
            f.write(f"{tag}\t{pre}\t{post}\t{cmd}\n")

    ok = (len(changed) == 0 and errors == 0)
    summary = {
        "result": "PASS" if ok else "FAIL",
        "total": len(lines),
        "changed": len(changed),
        "errors": errors,
        "baseline_sha": args.baseline_sha,
        "baseline_markers_absent": baseline_markers_absent,
        "current_markers_present": current_markers_present,
        "out": args.out,
    }
    return emit(summary, 0 if ok else 1)


if __name__ == "__main__":
    sys.exit(main())
