# CAWS-MANAGED-HOOK
# hook_pack: codex
# hook_pack_version: 1
# caws_min_major: 11
# edit_stance: YOURS TO EDIT. Maintain this adapter in the Codex harness,
#   preserve project customizations and verify native rollout behavior. The
#   managed marker identifies the baseline; do not weaken guards to bypass them.
"""Installed Codex transcript seam; shared normalization, visible content only."""
import json
from pathlib import Path
import sys
# The seam is also callable directly by diagnostics, outside the renderer.
# These paths are adjacent to this selected adapter, never inferred from cwd.
_root = Path(__file__).resolve().parents[3]
for _lib in (_root / "lib", _root / "shared/lib"):
    if (_lib / "harness_codex.py").is_file():
        sys.path.insert(0, str(_lib))
        break
from harness_codex import normalize_codex_row

def parse_transcript_events(transcript_path):
    events, state = [], {}
    with open(transcript_path, encoding="utf-8") as source:
        for line in source:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if not isinstance(row, dict):
                continue
            normalized = normalize_codex_row(row, state)
            for event in normalized:
                if event.get("ev") == "tool_use":
                    event["source_harness"] = "codex"
            events.extend(normalized)
    return events
