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


class TestMidTurnInterjectionCapture:
    """CAWS-SESSION-LOG-INTERJECTION-CAPTURE-001.

    A message sent while the assistant is still running never becomes a
    role:user transcript line -- the harness stores it as a queued_command
    attachment instead, delivered inline rather than opening a new turn.
    These tests pin that such an attachment is captured as an `interjection`
    event, attached to whichever turn is open when it arrives, and that
    machine-injected queued_command entries (background-task notifications)
    are NOT mistaken for human steering.
    """

    def _write(self, lines: list[dict]) -> str:
        tmp = Path(tempfile.mkdtemp(prefix="caws-slr-")) / "transcript.jsonl"
        tmp.write_text("\n".join(json.dumps(line) for line in lines) + "\n", encoding="utf-8")
        return str(tmp)

    def test_dict_shaped_human_queued_command_becomes_interjection_event(self):
        path = self._write([
            {
                "type": "attachment",
                "attachment": {
                    "type": "queued_command",
                    "prompt": "do this instead",
                    "commandMode": "prompt",
                    "origin": {"kind": "human"},
                },
                "timestamp": "2026-06-14T00:00:05Z",
            },
        ])
        events = slr.parse_transcript_events(path)
        assert events == [{"ev": "interjection", "text": "do this instead", "ts": "2026-06-14T00:00:05Z"}]

    def test_stringified_dict_attachment_is_parsed_via_regex_fallback(self):
        # Some raw transcript lines carry the attachment as a Python
        # repr-style string rather than nested JSON. The regex fallback must
        # still recover the prompt text.
        raw_attachment = (
            "{'type': 'queued_command', 'prompt': 'stop and reconsider', "
            "'commandMode': 'prompt', 'origin': {'kind': 'human'}}"
        )
        path = self._write([
            {"type": "attachment", "attachment": raw_attachment, "timestamp": "2026-06-14T00:00:05Z"},
        ])
        events = slr.parse_transcript_events(path)
        assert events == [{"ev": "interjection", "text": "stop and reconsider", "ts": "2026-06-14T00:00:05Z"}]

    def test_task_notification_queued_command_is_not_an_interjection(self):
        # Background-agent completion notifications are also delivered as
        # queued_command attachments, but they never carry an `origin` --
        # only genuine human-authored prompts do. Without this exclusion,
        # every task-notification would be misfiled as human steering.
        path = self._write([
            {
                "type": "attachment",
                "attachment": {
                    "type": "queued_command",
                    "prompt": "<task-notification>...</task-notification>",
                    "commandMode": "task-notification",
                },
                "timestamp": "2026-06-14T00:00:05Z",
            },
        ])
        assert slr.parse_transcript_events(path) == []

    def test_non_human_origin_is_not_an_interjection(self):
        path = self._write([
            {
                "type": "attachment",
                "attachment": {
                    "type": "queued_command",
                    "prompt": "some non-human origin",
                    "origin": {"kind": "agent"},
                },
                "timestamp": "2026-06-14T00:00:05Z",
            },
        ])
        assert slr.parse_transcript_events(path) == []

    def test_content_block_list_prompt_is_flattened_to_text(self):
        # A pasted image alongside text makes `prompt` a content-block list
        # (the same shape as message.content elsewhere), not a bare string.
        path = self._write([
            {
                "type": "attachment",
                "attachment": {
                    "type": "queued_command",
                    "prompt": [
                        {"type": "text", "text": "look at this"},
                        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "xx"}},
                    ],
                    "origin": {"kind": "human"},
                },
                "timestamp": "2026-06-14T00:00:05Z",
            },
        ])
        events = slr.parse_transcript_events(path)
        assert events == [{"ev": "interjection", "text": "look at this", "ts": "2026-06-14T00:00:05Z"}]

    def test_interjection_attaches_to_the_currently_open_turn(self):
        # The interjection arrives mid-flight -- between the user's opening
        # message and the assistant's next output -- so it must land on the
        # turn already in progress, not open a new turn of its own.
        events = [
            {"ev": "user_text", "text": "please fix the bug", "ts": "2026-06-14T00:00:00Z"},
            {"ev": "interjection", "text": "actually check the other file first", "ts": "2026-06-14T00:00:05Z"},
            {"ev": "assistant_text", "text": "Checking the other file now.", "ts": "2026-06-14T00:00:10Z"},
        ]
        turns, _session_events = slr.accumulate_turns(events, cwd="/repo")
        assert len(turns) == 1
        payload = slr.build_turn_payload(turns[0], number=1)
        assert payload["user"] == "please fix the bug"
        assert payload["interjections"] == [
            {"text": "actually check the other file first", "ts": "2026-06-14T00:00:05Z"}
        ]

    def test_turn_with_only_an_interjection_and_no_timeline_is_still_emitted(self):
        # A turn that gains an interjection but no assistant timeline before
        # the next user message must not be silently dropped.
        events = [
            {"ev": "user_text", "text": "first ask", "ts": "2026-06-14T00:00:00Z"},
            {"ev": "interjection", "text": "steering before any reply", "ts": "2026-06-14T00:00:01Z"},
            {"ev": "user_text", "text": "second ask", "ts": "2026-06-14T00:01:00Z"},
        ]
        turns, _session_events = slr.accumulate_turns(events, cwd="/repo")
        assert len(turns) == 2
        assert turns[0]["user"] == "first ask"
        assert turns[0]["interjections"] == [{"text": "steering before any reply", "ts": "2026-06-14T00:00:01Z"}]
        assert turns[1]["user"] == "second ask"

    def test_blank_prompt_is_not_recorded_as_an_interjection(self):
        path = self._write([
            {
                "type": "attachment",
                "attachment": {"type": "queued_command", "prompt": "   ", "origin": {"kind": "human"}},
                "timestamp": "2026-06-14T00:00:05Z",
            },
        ])
        assert slr.parse_transcript_events(path) == []
