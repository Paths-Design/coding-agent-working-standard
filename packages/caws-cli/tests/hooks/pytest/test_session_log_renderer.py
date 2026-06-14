"""Behavioral tests for session_log_renderer.py (A6, failure-lineage E10:
session transcripts).

CAWS-TEST-HOOKS-PYTHON-001. The renderer turns a Claude transcript JSONL into
lean session artifacts. These tests pin its pure helpers (deterministic
transforms) and prove the malformed-input path does NOT crash (a malformed
transcript line is skipped, not fatal) — the E10 "session transcripts must
render without wedging the session" property.

The module is imported via conftest's sys.path insertion of the shipped
templates/hook-packs/shared dir.
"""

import json
import sys
import tempfile
from pathlib import Path

_SHARED = Path(__file__).resolve().parents[3] / "templates" / "hook-packs" / "shared"
sys.path.insert(0, str(_SHARED))
import session_log_renderer as slr  # noqa: E402


class TestPureTransforms:
    def test_rel_path_strips_cwd_prefix(self):
        assert slr.rel_path("/repo/src/x.ts", "/repo") == "src/x.ts"

    def test_rel_path_leaves_unrelated_path_unchanged(self):
        assert slr.rel_path("/other/y.ts", "/repo") == "/other/y.ts"

    def test_rel_path_handles_none(self):
        assert slr.rel_path(None, "/repo") == ""

    def test_truncate_under_limit_unchanged(self):
        assert slr.truncate("short", 10) == "short"

    def test_truncate_over_limit_adds_ellipsis(self):
        assert slr.truncate("abcdefghij", 5) == "abcde..."

    def test_truncate_none_is_empty(self):
        assert slr.truncate(None, 5) == ""

    def test_compact_ws_collapses_whitespace(self):
        assert slr.compact_ws("a   b\n\tc") == "a b c"

    def test_compact_ws_truncates_long(self):
        out = slr.compact_ws("x" * 200, limit=10)
        assert out == "x" * 10 + "..."

    def test_parse_timestamp_passthrough_string(self):
        assert slr.parse_timestamp("2026-06-14T00:00:00Z") == "2026-06-14T00:00:00Z"

    def test_parse_timestamp_none(self):
        assert slr.parse_timestamp(None) is None

    def test_parse_timestamp_epoch_number_to_iso(self):
        # A numeric (truthy) epoch is converted to an ISO-ish UTC string,
        # deterministically. 86400 == 1970-01-02T00:00:00Z.
        assert slr.parse_timestamp(86400) == "1970-01-02T00:00:00Z"

    def test_parse_timestamp_falsy_zero_is_treated_as_absent(self):
        # PINNED ACTUAL BEHAVIOR (not idealized): the `if not ts` guard treats
        # epoch 0 (a falsy value) as "no timestamp" -> None. Epoch 0 (1970) does
        # not occur in real transcripts; this is a benign display-renderer edge,
        # not a safety/governance defect. Pinning it so a future change is a
        # conscious decision, not a silent regression.
        assert slr.parse_timestamp(0) is None

    def test_seconds_between_known_timestamps(self):
        a = "2026-06-14T00:00:00Z"
        b = "2026-06-14T00:00:30Z"
        assert slr.seconds_between(a, b) == 30.0

    def test_seconds_between_unparseable_is_none(self):
        assert slr.seconds_between("garbage", "also-garbage") is None

    def test_append_unique_dedupes(self):
        items = []
        slr.append_unique(items, "a")
        slr.append_unique(items, "a")
        slr.append_unique(items, "b")
        assert items == ["a", "b"]

    def test_append_unique_ignores_empty(self):
        items = []
        slr.append_unique(items, "")
        assert items == []


class TestContentExtraction:
    def test_extract_text_from_string_content(self):
        assert slr.extract_text_from_content_blocks("plain") == "plain"

    def test_extract_text_from_block_list(self):
        blocks = [{"type": "text", "text": "first"}, {"type": "text", "text": "second"}]
        out = slr.extract_text_from_content_blocks(blocks)
        assert "first" in out and "second" in out

    def test_extract_text_ignores_non_dict_items(self):
        # Non-dict items in the content list are skipped, not fatal.
        out = slr.extract_text_from_content_blocks(["bare-string-ignored", {"type": "text", "text": "kept"}])
        assert out == "kept"

    def test_decode_structured_text_payload_plain_passthrough(self):
        assert slr.decode_structured_text_payload("hello") == "hello"

    def test_decode_structured_text_payload_json_array(self):
        raw = json.dumps([{"text": "alpha"}, {"text": "beta"}])
        out = slr.decode_structured_text_payload(raw)
        assert "alpha" in out and "beta" in out

    def test_decode_structured_text_payload_malformed_json_returns_raw(self):
        # A string that looks like JSON but isn't returns the raw input (no crash).
        assert slr.decode_structured_text_payload("[not json") == "[not json"


class TestMalformedTranscriptNoCrash:
    """E10: a malformed transcript must render without wedging the session."""

    def test_malformed_lines_are_skipped_not_fatal(self):
        tmp = Path(tempfile.mkdtemp(prefix="caws-slr-")) / "transcript.jsonl"
        tmp.write_text(
            "\n".join([
                json.dumps({"type": "user", "message": {"content": "hi"}, "timestamp": "2026-06-14T00:00:00Z"}),
                "this is not valid json at all",          # malformed interior line
                "",                                          # blank line
                json.dumps({"type": "user", "message": {"content": "bye"}, "timestamp": "2026-06-14T00:01:00Z"}),
            ]) + "\n",
            encoding="utf-8",
        )
        # Must NOT raise; the malformed line is skipped.
        events = slr.parse_transcript_events(str(tmp))
        texts = [e.get("text") for e in events if e.get("ev") == "user_text"]
        assert "hi" in texts and "bye" in texts  # both good lines survived
        assert "this is not valid json at all" not in texts  # the bad line was dropped

    def test_empty_transcript_yields_no_events(self):
        tmp = Path(tempfile.mkdtemp(prefix="caws-slr-")) / "empty.jsonl"
        tmp.write_text("", encoding="utf-8")
        assert slr.parse_transcript_events(str(tmp)) == []

    def test_new_turn_has_the_expected_empty_shape(self):
        turn = slr.new_turn("question", "2026-06-14T00:00:00Z")
        assert turn["user"] == "question"
        # All the per-turn collections start empty.
        for key in ("timeline", "edited_files", "read_files", "searches", "commands"):
            assert turn[key] == []
