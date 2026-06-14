"""pytest fixtures for the CAWS python-classifier tier.

CAWS-TEST-HOOKS-PYTHON-001. Makes the SHIPPED classifier source importable
(templates/hook-packs/shared/classify_command.py) and provides a `classify`
fixture that calls classify_command with isolated temp paths, so every test is
deterministic and independent of the developer's filesystem layout.
"""

import sys
import tempfile
import shutil
from pathlib import Path

import pytest

# tests/hooks/pytest/conftest.py -> packages/caws-cli
_CLI_PKG_ROOT = Path(__file__).resolve().parents[3]
_SHARED_HOOKS = _CLI_PKG_ROOT / "templates" / "hook-packs" / "shared"

# Import the real shipped classifier module (no copy, no shim).
sys.path.insert(0, str(_SHARED_HOOKS))
import classify_command as cc  # noqa: E402


@pytest.fixture
def classify():
    """Return a callable that classifies a command against a fresh temp repo.

    Usage:  decision, reason, source, enforcement = classify("git init")
    The repo_root/home/cwd are unique per call (temp dirs), so no test sees
    another's trusted-context tokens or filesystem state.
    """
    tmpdir = tempfile.mkdtemp(prefix="caws-pytest-")
    repo_root = Path(tmpdir) / "repo"
    home = Path(tmpdir) / "home"
    repo_root.mkdir(parents=True)
    home.mkdir(parents=True)

    def _classify(raw_command, caws_worktree=False, cwd=None):
        return cc.classify_command(
            raw_command,
            repo_root=repo_root,
            home=home,
            cwd=cwd or repo_root,
            caws_worktree=caws_worktree,
        )

    yield _classify
    shutil.rmtree(tmpdir, ignore_errors=True)


@pytest.fixture
def classify_module():
    """Direct access to the classifier module for testing pure helper functions."""
    return cc
