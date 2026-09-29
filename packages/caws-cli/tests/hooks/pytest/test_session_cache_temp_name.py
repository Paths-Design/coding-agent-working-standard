"""Contract tests for the session-cache atomic temp-name scheme.

Regression: the temp filename was built as '.' + name + '.<uuid>' with
name already starting with a dot, producing a '..'-prefixed path that
path sanitizers / sandbox proxies deny as traversal-looking (EPERM),
fail-opening every session-envelope capture.

Invariants under test:
- the temp name never begins with two dots and is unique per call
- an end-to-end capture writes a valid envelope and leaves no temp residue
- the installed project copy uses the same non-dot-dot scheme
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import types
import uuid
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[5]
TEMPLATE = REPO / "packages/caws-cli/templates/hook-packs/shared/lib/session-cache.sh"
INSTALLED = REPO / ".caws/hooks/lib/session-cache.sh"


def atomic_json_source(path: Path) -> str:
    body = path.read_text()
    start = body.index("def atomic_json")
    end = body.index("\ntry:\n", start)
    return body[start:end]


@pytest.mark.parametrize("hook", [TEMPLATE, INSTALLED])
def test_temp_name_is_not_dotdot_prefixed_and_is_unique(hook):
    """A1: computed temp name has no '..' prefix and is unique per call."""
    ns: dict[str, object] = {"uuid": uuid, "os": os, "json": json, "re": re,
                             "sys": sys}
    exec(atomic_json_source(hook), ns)  # noqa: S102 - trusted repo source
    atomic_json = ns["atomic_json"]
    with tempfile.TemporaryDirectory() as tmp:
        parent = os.open(tmp, os.O_RDONLY | os.O_DIRECTORY)
        try:
            atomic_json(parent, ".session-envelope.json", {"probe": True})
            assert (Path(tmp) / ".session-envelope.json").exists()
        finally:
            os.close(parent)
    # Uniqueness + prefix: exercise only the name computation by patching
    # uuid4 to return distinct fixed hexes and intercepting os.open.
    names: list[str] = []
    real_open = os.open
    hexes = iter(["a" * 32, "b" * 32])

    class FakeUuid:
        @staticmethod
        def uuid4():
            class U:
                hex = next(hexes)

            return U()

    scoped = {"uuid": FakeUuid, "os": types.SimpleNamespace(
        open=_OpenCapture(names, real_open).open,
        O_WRONLY=os.O_WRONLY, O_CREAT=os.O_CREAT, O_EXCL=os.O_EXCL,
        O_NOFOLLOW=os.O_NOFOLLOW)}
    exec(atomic_json_source(hook), scoped)  # noqa: S102
    for _ in range(2):
        try:
            scoped["atomic_json"](0, ".session-envelope.json", {})
        except (OSError, AttributeError):
            pass  # expected: the capture shim stops at the first os.open
    assert len(names) == 2
    assert names[0] != names[1], "temp names must be unique per call"
    for name in names:
        assert not name.startswith(".."), f"dot-dot temp name regenerated: {name}"


class _OpenCapture:
    """os.open stand-in that records the requested temp name."""

    def __init__(self, names, real_open):
        self.names, self.real_open = names, real_open

    def open(self, path, *args, **kwargs):
        self.names.append(path)
        raise OSError("stop after name capture")


@pytest.mark.parametrize("hook", [TEMPLATE, INSTALLED])
def test_end_to_end_capture_writes_envelope_without_temp_residue(hook):
    """A2/A3: full hook run leaves a valid envelope and no leftover temp file."""
    with tempfile.TemporaryDirectory() as repo:
        subprocess.run(["git", "init", "-q", repo], check=True)
        os.makedirs(Path(repo) / ".caws" / "sessions")
        env = dict(os.environ, HOOK_SESSION_ID="pytest-probe", HOOK_CWD=repo,
                   HOOK_EVENT_NAME="stop")
        driver = 'source "$1" && _caws_write_session_envelope pytest'
        result = subprocess.run(["bash", "-c", driver, "hook", str(hook)],
                                capture_output=True, text=True, env=env, cwd=repo)
        assert result.returncode == 0, result.stderr
        envelope = Path(repo) / ".caws/sessions/pytest-probe/.session-envelope.json"
        payload = json.loads(envelope.read_text())
        assert payload["session_id"] == "pytest-probe"
        assert payload["hook_event"] == "stop"
        residue = [p.name for p in envelope.parent.iterdir()
                   if p.name != ".session-envelope.json"]
        assert residue == [], f"temp residue left behind: {residue}"
