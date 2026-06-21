"""Behavioral tests for worktree-claim-oracle.cjs verdicts.

CAWS-HOOKPACK-ORACLE-JSYAML-DEGRADE-001. The oracle decides worktree-payload and
canonical-claim ownership. js-yaml is required LAZILY and is only needed for the
cross-worktree canonical-claim check (reading another spec's scope.in); the
foreign-worktree-PAYLOAD block is yaml-free. When js-yaml is unresolvable, the
canonical-claim path must DEGRADE (emit `degraded_no_yaml`, which the guards map
to allow-with-advisory) rather than FAIL CLOSED (`error_fail_closed`, which the
guards mapped to ask-on-every-mutation — the friction this slice removes). The
foreign-payload block must stay hard regardless of js-yaml.

These tests drive the SHIPPED oracle as a subprocess. js-yaml absence is
simulated with a node `--require` blocker (a temp module that makes
`require('js-yaml')` throw MODULE_NOT_FOUND) — no repo file is modified.
"""

import json
import os
import subprocess
import tempfile
from pathlib import Path

import pytest

_PKG_ROOT = Path(__file__).resolve().parents[3]
_ORACLE = _PKG_ROOT / "templates" / "hook-packs" / "shared" / "lib" / "worktree-claim-oracle.cjs"

# A node preload module that intercepts require('js-yaml') and throws as if it
# were not installed, while leaving every other require intact.
_JSYAML_BLOCKER = """
const Module = require('module');
const _orig = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'js-yaml') {
    const e = new Error("Cannot find module 'js-yaml'");
    e.code = 'MODULE_NOT_FOUND';
    throw e;
  }
  return _orig.apply(this, arguments);
};
"""


@pytest.fixture
def repo():
    """A temp repo dir with a .caws/ and a controllable worktrees.json."""
    d = tempfile.mkdtemp(prefix="caws-oracle-")
    root = Path(d)
    (root / ".caws" / "specs").mkdir(parents=True)
    (root / ".caws" / "worktrees").mkdir(parents=True)
    yield root
    import shutil
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture
def blocker():
    """Path to a temp js-yaml require-blocker preload module."""
    fd, p = tempfile.mkstemp(suffix=".cjs", prefix="jsyaml-block-")
    with os.fdopen(fd, "w") as fh:
        fh.write(_JSYAML_BLOCKER)
    yield p
    os.unlink(p)


def _run_oracle(repo_root, rel_path, *, session_id="sess-self", block_jsyaml=None,
                current_branch=""):
    """Run the oracle and return its first-line verdict string."""
    env = dict(os.environ)
    env["CAWS_ORACLE_PROJECT_DIR"] = str(repo_root)
    env["CAWS_ORACLE_REL_PATH"] = rel_path
    env["CAWS_ORACLE_SESSION_ID"] = session_id
    env["CAWS_ORACLE_CURRENT_BRANCH"] = current_branch
    cmd = ["node"]
    if block_jsyaml:
        cmd += ["--require", block_jsyaml]
    cmd += [str(_ORACLE)]
    out = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=30)
    return out.stdout.strip().splitlines()[0] if out.stdout.strip() else ""


def _write_registry(repo_root, entries):
    (repo_root / ".caws" / "worktrees.json").write_text(json.dumps(entries))


def _write_spec(repo_root, spec_id, scope_in, worktree_name):
    (repo_root / ".caws" / "specs" / f"{spec_id}.yaml").write_text(
        f"id: {spec_id}\n"
        f"lifecycle_state: active\n"
        f"worktree: {worktree_name}\n"
        "scope:\n  in:\n" + "".join(f"    - {p}\n" for p in scope_in)
    )


def _make_worktree_dir(repo_root, name):
    (repo_root / ".caws" / "worktrees" / name).mkdir(parents=True, exist_ok=True)


# --- A2: canonical path, js-yaml absent -> DEGRADE (not fail-closed) ---

def test_canonical_path_no_jsyaml_degrades(repo, blocker):
    # An active worktree with a bound spec exists (so findClaimants must read
    # spec YAML). With js-yaml blocked, a canonical path that is NOT a worktree
    # payload must DEGRADE, not fail closed.
    _make_worktree_dir(repo, "wt-feat")
    _write_registry(repo, {
        "wt-feat": {"name": "wt-feat", "spec_id": "FEAT-001",
                    "path": str(repo / ".caws" / "worktrees" / "wt-feat"),
                    "owner": {"session_id": "other-sess"}, "baseBranch": "main"}
    })
    _write_spec(repo, "FEAT-001", ["packages/other/src"], "wt-feat")
    verdict = _run_oracle(repo, str(repo / "some" / "unrelated" / "file.js"),
                          block_jsyaml=blocker)
    assert verdict.startswith("degraded_no_yaml"), verdict
    assert "error_fail_closed" not in verdict, verdict


def test_canonical_path_no_jsyaml_degrades_even_when_path_would_be_claimed(repo, blocker):
    # The degrade is honest: even a path that WOULD match a spec's scope.in
    # degrades when yaml can't be read (the oracle cannot prove the claim). It
    # does NOT silently allow as 'pass' — it emits the distinct degraded verdict
    # so the skipped check is visible.
    _make_worktree_dir(repo, "wt-feat")
    _write_registry(repo, {
        "wt-feat": {"name": "wt-feat", "spec_id": "FEAT-001",
                    "path": str(repo / ".caws" / "worktrees" / "wt-feat"),
                    "owner": {"session_id": "other-sess"}, "baseBranch": "main"}
    })
    _write_spec(repo, "FEAT-001", ["packages/claimed/src"], "wt-feat")
    verdict = _run_oracle(repo, str(repo / "packages" / "claimed" / "src" / "x.js"),
                          block_jsyaml=blocker)
    assert verdict.startswith("degraded_no_yaml"), verdict


# --- A3: foreign worktree payload, js-yaml absent -> STILL hard-blocks ---

def test_foreign_payload_no_jsyaml_still_blocks(repo, blocker):
    # The isolation-critical block is yaml-free and must fire regardless.
    _make_worktree_dir(repo, "wt-other")
    _write_registry(repo, {
        "wt-other": {"name": "wt-other", "spec_id": "OTH-001",
                     "path": str(repo / ".caws" / "worktrees" / "wt-other"),
                     "owner": {"session_id": "foreign-sess"}, "baseBranch": "main"}
    })
    payload = str(repo / ".caws" / "worktrees" / "wt-other" / "file.js")
    verdict = _run_oracle(repo, payload, session_id="my-sess", block_jsyaml=blocker)
    assert verdict.startswith("block_foreign_worktree"), verdict


def test_own_payload_no_jsyaml_passes(repo, blocker):
    # Writing into your OWN worktree payload is pass:owner-self, yaml-free.
    _make_worktree_dir(repo, "wt-mine")
    _write_registry(repo, {
        "wt-mine": {"name": "wt-mine", "spec_id": "MINE-001",
                    "path": str(repo / ".caws" / "worktrees" / "wt-mine"),
                    "owner": {"session_id": "my-sess"}, "baseBranch": "main"}
    })
    payload = str(repo / ".caws" / "worktrees" / "wt-mine" / "file.js")
    verdict = _run_oracle(repo, payload, session_id="my-sess", block_jsyaml=blocker)
    assert verdict.startswith("pass"), verdict


# --- with js-yaml present, the canonical-claim check still works ---

def test_canonical_unclaimed_with_jsyaml_passes(repo):
    _make_worktree_dir(repo, "wt-feat")
    _write_registry(repo, {
        "wt-feat": {"name": "wt-feat", "spec_id": "FEAT-001",
                    "path": str(repo / ".caws" / "worktrees" / "wt-feat"),
                    "owner": {"session_id": "other-sess"}, "baseBranch": "main"}
    })
    _write_spec(repo, "FEAT-001", ["packages/other/src"], "wt-feat")
    verdict = _run_oracle(repo, str(repo / "some" / "unrelated" / "file.js"))
    assert verdict.startswith("pass"), verdict


def test_no_active_worktrees_passes(repo):
    # No registry / no active worktrees -> pass, never reaches the claim check.
    verdict = _run_oracle(repo, str(repo / "any" / "file.js"))
    assert verdict.startswith("pass"), verdict
