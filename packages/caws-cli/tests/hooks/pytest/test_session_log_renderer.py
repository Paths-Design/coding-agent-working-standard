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
import os
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


class TestQwenTranscript:
    """CAWS-SESSION-LOG-QWEN-001: Qwen Code transcripts are Gemini-shaped
    (message.parts with text/functionCall/functionResponse), stored under
    ~/.qwen/projects/<slug>/chats/. Row shapes verified live on 0.21.4."""

    def _write(self, rows):
        tmp = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
        for row in rows:
            tmp.write(json.dumps(row) + "\n")
        tmp.close()
        return tmp.name

    @staticmethod
    def _user(text, subtype=None, ts="2026-08-04T00:00:00Z"):
        row = {
            "type": "user",
            "provenance": "real_user",
            "sessionId": "s",
            "timestamp": ts,
            "message": {"role": "user", "parts": [{"text": text}]},
        }
        if subtype:
            row["subtype"] = subtype
        return row

    def test_user_assistant_and_tool_rows_normalize_to_canonical_events(self):
        path = self._write([
            self._user("run the tests"),
            {
                "type": "assistant",
                "timestamp": "2026-08-04T00:00:01Z",
                "message": {"role": "model", "parts": [
                    {"text": "thinking about it", "thought": True},
                    {"functionCall": {"id": "call_1", "name": "run_shell_command",
                                       "args": {"command": "pytest", "description": "tests"}}},
                ]},
            },
            {
                "type": "tool_result",
                "timestamp": "2026-08-04T00:00:02Z",
                "message": {"role": "user", "parts": [
                    {"functionResponse": {"id": "call_1", "name": "run_shell_command",
                                           "response": {"output": "12 passed"}}},
                ]},
                "toolCallResult": {"callId": "call_1", "status": "success"},
            },
        ])
        events = slr.parse_transcript_events(path)
        kinds = [e["ev"] for e in events]
        assert kinds == ["user_text", "assistant_text", "tool_use", "tool_result"]
        tool_use = events[2]
        # Runtime id normalizes to the canonical name the accumulation
        # branches key on.
        assert tool_use["name"] == "Bash"
        assert tool_use["input"] == {"command": "pytest", "description": "tests"}
        assert events[3]["content"] == "12 passed"
        assert events[3]["is_error"] is False

    def test_tool_result_failure_status_maps_to_is_error(self):
        path = self._write([
            {
                "type": "tool_result",
                "timestamp": "2026-08-04T00:00:02Z",
                "message": {"role": "user", "parts": [
                    {"functionResponse": {"id": "call_9", "name": "run_shell_command",
                                           "response": {"output": "boom"}}},
                ]},
                "toolCallResult": {"callId": "call_9", "status": "error"},
            },
        ])
        events = slr.parse_transcript_events(path)
        assert events[0]["is_error"] is True

    def test_system_telemetry_rows_are_dropped(self):
        path = self._write([
            {"type": "system", "subtype": "ui_telemetry", "systemPayload": {"x": 1},
             "timestamp": "2026-08-04T00:00:00Z"},
            self._user("real question"),
        ])
        events = slr.parse_transcript_events(path)
        assert events == [{"ev": "user_text", "text": "real question", "ts": "2026-08-04T00:00:00Z"}]

    def test_context_injection_wrapper_rows_do_not_open_phantom_turns(self):
        # Qwen delivers @-mention file content as separate user rows wrapped
        # in marker lines; they are context injection, not human turns.
        path = self._write([
            self._user("look at this file"),
            self._user(" --- Content from referenced files ---"),
            self._user("Content from /repo/src/x.py"),
            self._user("Showing lines 1-10 of 20 total lines."),
            self._user(" --- End of content ---"),
        ])
        events = slr.parse_transcript_events(path)
        assert events == [{"ev": "user_text", "text": "look at this file", "ts": "2026-08-04T00:00:00Z"}]

    def test_mid_turn_user_message_becomes_interjection(self):
        path = self._write([self._user("steer this", subtype="mid_turn_user_message")])
        events = slr.parse_transcript_events(path)
        assert events == [{"ev": "interjection", "text": "steer this", "ts": "2026-08-04T00:00:00Z"}]

    def test_qwen_bash_call_accumulates_into_commands(self):
        path = self._write([
            self._user("do it"),
            {
                "type": "assistant",
                "timestamp": "2026-08-04T00:00:01Z",
                "message": {"role": "model", "parts": [
                    {"functionCall": {"id": "call_2", "name": "run_shell_command",
                                       "args": {"command": "git status", "description": "check"}}},
                ]},
            },
        ])
        events = slr.parse_transcript_events(path)
        turns, _session_events = slr.accumulate_turns(events, cwd="/repo")
        assert len(turns) == 1
        assert turns[0]["commands"][0]["command"] == "git status"

    def test_qwen_write_edit_accumulate_into_edited_files(self):
        path = self._write([
            self._user("fix it"),
            {
                "type": "assistant",
                "timestamp": "2026-08-04T00:00:01Z",
                "message": {"role": "model", "parts": [
                    {"functionCall": {"id": "call_3", "name": "write_file",
                                       "args": {"file_path": "/repo/src/new.py", "content": "x"}}},
                    {"functionCall": {"id": "call_4", "name": "edit",
                                       "args": {"file_path": "/repo/src/old.py",
                                                "old_string": "a", "new_string": "b"}}},
                ]},
            },
        ])
        events = slr.parse_transcript_events(path)
        turns, _session_events = slr.accumulate_turns(events, cwd="/repo")
        assert turns[0]["edited_files"] == ["src/new.py", "src/old.py"]

    def test_claude_rows_still_parse_unchanged(self):
        # Regression guard for the additive-shape invariant: claude-shaped
        # rows (message.content, never message.parts) must not be claimed by
        # the qwen path.
        path = self._write([
            {"type": "user", "timestamp": "2026-06-14T00:00:00Z",
             "message": {"content": "claude question"}},
            {"type": "assistant", "timestamp": "2026-06-14T00:00:01Z",
             "message": {"content": [{"type": "tool_use", "name": "Bash", "id": "t1",
                                       "input": {"command": "ls"}}]}},
        ])
        events = slr.parse_transcript_events(path)
        assert [e["ev"] for e in events] == ["user_text", "tool_use"]
        assert events[1]["name"] == "Bash"


class TestKimiTranscript:
    """CAWS-SESSION-LOG-KIMI-001: Kimi Code durable transcripts are wire logs
    (~/.kimi-code/sessions/<slug>/session_<id>/agents/main/wire.jsonl) of
    {"type": "<dotted.type>", "time": <epoch ms>, ...} rows — turn.prompt user
    input and context.append_loop_event content.part/tool.call/tool.result
    loop events. Row shapes verified live against wire protocol 1.4
    (kimi-code 0.31.x, 2026-08-12)."""

    def _write(self, rows):
        tmp = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
        for row in rows:
            tmp.write(json.dumps(row) + "\n")
        tmp.close()
        return tmp.name

    @staticmethod
    def _loop(event, t=1785792371660):
        return {"type": "context.append_loop_event", "event": event, "time": t}

    def test_prompt_part_and_tool_rows_normalize_to_canonical_events(self):
        path = self._write([
            {"type": "turn.prompt", "time": 1785792371657,
             "input": [{"type": "text", "text": "run the tests"}],
             "origin": {"kind": "user"}},
            self._loop({"type": "content.part", "uuid": "u1", "turnId": "0", "step": 1,
                        "part": {"type": "think", "think": "reasoning about it"}}, 1785792371661),
            self._loop({"type": "content.part", "uuid": "u2", "turnId": "0", "step": 1,
                        "part": {"type": "text", "text": "Running them now."}}, 1785792371662),
            self._loop({"type": "tool.call", "toolCallId": "tool_1", "name": "Bash",
                        "args": {"command": "pytest", "description": "tests"}}, 1785792371663),
            self._loop({"type": "tool.result", "toolCallId": "tool_1",
                        "result": {"output": "12 passed"}}, 1785792371700),
        ])
        events = slr.parse_transcript_events(path)
        assert [e["ev"] for e in events] == [
            "user_text", "assistant_text", "assistant_text", "tool_use", "tool_result",
        ]
        assert events[0]["text"] == "run the tests"
        assert events[1]["text"] == "reasoning about it"
        assert events[3]["name"] == "Bash"
        assert events[3]["id"] == "tool_1"
        assert events[3]["input"] == {"command": "pytest", "description": "tests"}
        assert events[4]["content"] == "12 passed"
        assert events[4]["is_error"] is False

    def test_epoch_ms_time_converts_to_iso(self):
        path = self._write([
            {"type": "turn.prompt", "time": 1785792371657,
             "input": [{"type": "text", "text": "hi"}], "origin": {"kind": "user"}},
        ])
        events = slr.parse_transcript_events(path)
        # kimi `time` is epoch MILLISECONDS; a seconds interpretation would
        # overflow and fall back to the raw string. 1785792371657 ms ==
        # 2026-08-03T...Z (checked against the live wire log).
        assert events[0]["ts"].endswith("Z")
        assert events[0]["ts"].startswith("2026-")

    def test_file_tool_path_mirrors_to_file_path_and_accumulates(self):
        # kimi file tools carry the target in args.path; the accumulation
        # branches read file_path, so the adapter mirrors it at the boundary
        # (same normalization as the kimi-code parse-input.sh hook override).
        path = self._write([
            {"type": "turn.prompt", "time": 1785792371657,
             "input": [{"type": "text", "text": "fix it"}], "origin": {"kind": "user"}},
            self._loop({"type": "tool.call", "toolCallId": "tool_2", "name": "Write",
                        "args": {"path": "/repo/src/new.py", "content": "x"}}),
            self._loop({"type": "tool.call", "toolCallId": "tool_3", "name": "Edit",
                        "args": {"path": "/repo/src/old.py", "old_string": "a", "new_string": "b"}}),
        ])
        events = slr.parse_transcript_events(path)
        assert events[1]["input"]["file_path"] == "/repo/src/new.py"
        assert events[2]["input"]["file_path"] == "/repo/src/old.py"
        turns, _session_events = slr.accumulate_turns(events, cwd="/repo")
        assert turns[0]["edited_files"] == ["src/new.py", "src/old.py"]

    def test_tool_result_is_error_maps_from_isError(self):
        path = self._write([
            self._loop({"type": "tool.result", "toolCallId": "tool_9",
                        "result": {"output": "boom", "isError": True}}),
        ])
        events = slr.parse_transcript_events(path)
        assert events == [{"ev": "tool_result", "id": "tool_9", "content": "boom",
                           "is_error": True, "ts": events[0]["ts"]}]

    def test_append_message_duplicate_and_telemetry_rows_are_dropped(self):
        path = self._write([
            {"type": "metadata", "protocol_version": "1.4", "created_at": 1785792325896},
            {"type": "llm.request", "kind": "loop", "model": "k3-256k", "time": 1785792371663},
            {"type": "usage.record", "model": "kimi-code/k3-256k",
             "usage": {"output": 1450}, "time": 1785792598102},
            self._loop({"type": "step.begin", "uuid": "s1", "turnId": "0", "step": 1}),
            self._loop({"type": "step.end", "uuid": "s1", "turnId": "0", "step": 1,
                        "finishReason": "stop"}),
            {"type": "turn.prompt", "time": 1785792371657,
             "input": [{"type": "text", "text": "real question"}], "origin": {"kind": "user"}},
            # context.append_message echoes turn.prompt's user text; claiming
            # it would open the turn twice.
            {"type": "context.append_message", "time": 1785792371658,
             "message": {"role": "user",
                         "content": [{"type": "text", "text": "real question"}],
                         "origin": {"kind": "user"}}},
        ])
        events = slr.parse_transcript_events(path)
        assert [(e["ev"], e["text"]) for e in events] == [("user_text", "real question")]

    def test_kimi_bash_result_joins_into_commands(self):
        path = self._write([
            {"type": "turn.prompt", "time": 1785792371657,
             "input": [{"type": "text", "text": "do it"}], "origin": {"kind": "user"}},
            self._loop({"type": "tool.call", "toolCallId": "tool_4", "name": "Bash",
                        "args": {"command": "git status", "description": "check"}}, 1785792371663),
            self._loop({"type": "tool.result", "toolCallId": "tool_4",
                        "result": {"output": "On branch main"}}, 1785792371800),
        ])
        events = slr.parse_transcript_events(path)
        turns, _session_events = slr.accumulate_turns(events, cwd="/repo")
        assert len(turns) == 1
        assert turns[0]["commands"][0]["command"] == "git status"
        assert turns[0]["commands"][0]["output_preview"] == "On branch main"

    def test_claude_rows_are_not_claimed_by_the_kimi_path(self):
        # Regression guard for the additive-shape invariant: claude rows stamp
        # `timestamp` and never carry a numeric `time` key.
        path = self._write([
            {"type": "user", "timestamp": "2026-06-14T00:00:00Z",
             "message": {"content": "claude question"}},
        ])
        events = slr.parse_transcript_events(path)
        assert [e["ev"] for e in events] == ["user_text"]


# --- Steering + usage signals (SESSION-LOG-STEERING-USAGE-SIGNALS-001) -------

# One usage block, repeated verbatim on every row of a multi-block reply, as
# Claude Code actually writes it.
_USAGE = {
    "input_tokens": 12,
    "cache_read_input_tokens": 30000,
    "cache_creation_input_tokens": 700,
    "output_tokens": 491,
}


def _user_row(text, uuid_, parent=None, ts="2026-09-15T00:00:00Z"):
    return {"type": "user", "uuid": uuid_, "parentUuid": parent,
            "timestamp": ts, "message": {"content": text}}


def _assistant_rows(message_id, request_id, blocks, usage=_USAGE,
                    model="claude-opus-5", ts="2026-09-15T00:00:01Z"):
    """Claude Code writes ONE row per content block, each repeating message+usage."""
    rows = []
    for index, block in enumerate(blocks):
        message = {"id": message_id, "model": model, "content": [block]}
        if usage is not None:
            message["usage"] = usage
        rows.append({"type": "assistant", "uuid": f"{message_id}-{index}",
                     "parentUuid": None, "timestamp": ts,
                     "requestId": request_id, "message": message})
    return rows


def _reply(text="done"):
    return [{"type": "text", "text": text}]


def _render(rows):
    """Render rows end to end and return the turn payloads written to disk."""
    directory = Path(tempfile.mkdtemp(prefix="caws-slr-render-"))
    transcript = directory / "transcript.jsonl"
    transcript.write_text(
        "".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8"
    )
    slr._render_session_unlocked(
        log_dir=str(directory), cwd="/repo", session_id="sess-steering",
        started_at="2026-09-15 00:00:00 PDT", model="claude-opus-5",
        branch="main", head_sha="abc1234", dirty_count="0", start_sha="abc1234",
        transcript_path=str(transcript),
    )
    return [json.loads(path.read_text(encoding="utf-8"))
            for path in sorted(directory.glob("turn-*.json"))]


class TestTurnUsageAccounting:
    """A1: exactly one api_request per unique (message id, request id)."""

    def test_multi_block_reply_and_fork_copy_count_as_one_request(self):
        reply = _assistant_rows("msg_A", "req_A", [
            {"type": "thinking", "thinking": "..."},
            {"type": "text", "text": "here is the answer"},
            {"type": "tool_use", "id": "t1", "name": "Read", "input": {}},
        ])
        # A fork or resume copies the same rows verbatim; they must not be
        # counted a second time.
        turns = _render([_user_row("do the thing", "u1")] + reply + reply)
        assert len(turns) == 1
        assert turns[0]["usage"] == {
            "requests": 1,
            "input": 12,
            "cache_read": 30000,
            "cache_write": 700,
            "output": 491,
            "models": ["claude-opus-5"],
        }

    def test_fork_copy_in_a_later_turn_is_not_counted_again(self):
        reply = _assistant_rows("msg_A", "req_A", _reply("first answer"))
        turns = _render(
            [_user_row("first", "u1")] + reply
            + [_user_row("second", "u2")] + reply
        )
        assert len(turns) == 2
        assert turns[0]["usage"]["requests"] == 1
        # Second turn saw only the duplicate, so it records no usage at all
        # rather than a zero-filled block.
        assert "usage" not in turns[1]

    def test_distinct_requests_in_one_turn_sum(self):
        turns = _render(
            [_user_row("do the thing", "u1")]
            + _assistant_rows("msg_A", "req_A", _reply("step one"))
            + _assistant_rows("msg_B", "req_B", _reply("step two"))
        )
        assert turns[0]["usage"]["requests"] == 2
        assert turns[0]["usage"]["output"] == 982
        assert turns[0]["usage"]["input"] == 24

    def test_same_message_id_under_a_new_request_id_counts_twice(self):
        # The dedup key is the PAIR. A retry reuses the message id but is a
        # second billed request, so keying on message id alone would undercount.
        turns = _render(
            [_user_row("do the thing", "u1")]
            + _assistant_rows("msg_A", "req_A", _reply("attempt"))
            + _assistant_rows("msg_A", "req_RETRY", _reply("attempt"))
        )
        assert turns[0]["usage"]["requests"] == 2

    def test_models_are_listed_once_each_in_first_seen_order(self):
        turns = _render(
            [_user_row("do the thing", "u1")]
            + _assistant_rows("msg_A", "req_A", _reply("a"), model="claude-opus-5")
            + _assistant_rows("msg_B", "req_B", _reply("b"), model="claude-haiku-4-5")
            + _assistant_rows("msg_C", "req_C", _reply("c"), model="claude-opus-5")
        )
        assert turns[0]["usage"]["models"] == ["claude-opus-5", "claude-haiku-4-5"]

    def test_transcript_without_usage_renders_no_usage_block(self):
        # Invariant: absent, never zero-filled — a zero block would read as
        # "this turn was free" instead of "this harness records nothing".
        turns = _render(
            [_user_row("do the thing", "u1")]
            + _assistant_rows("msg_A", "req_A", _reply("answer"), usage=None)
        )
        assert len(turns) == 1
        assert "usage" not in turns[0]


class TestInterruptKind:
    """A2: the two interrupt shapes are distinct steering acts."""

    def test_tool_interrupt_and_generation_interrupt_are_distinguished(self):
        turns = _render(
            [_user_row("first prompt", "u1")]
            + _assistant_rows("msg_A", "req_A", _reply("about to run rm -rf"))
            + [_user_row("[Request interrupted by user for tool use]", "i1")]
            + [_user_row("second prompt", "u2")]
            + _assistant_rows("msg_B", "req_B", _reply("a long ramble"))
            + [_user_row("[Request interrupted by user]", "i2")]
        )
        assert [turn["ended_by"] for turn in turns] == [
            "user_interrupt_tool",
            "user_interrupt_generation",
        ]

    def test_legacy_collapsed_value_is_never_emitted(self):
        turns = _render(
            [_user_row("first prompt", "u1")]
            + _assistant_rows("msg_A", "req_A", _reply("working"))
            + [_user_row("[Request interrupted by user]", "i1")]
        )
        assert "user_interrupt" not in {turn["ended_by"] for turn in turns}

    def test_uninterrupted_turn_reports_no_ended_by(self):
        turns = _render(
            [_user_row("first prompt", "u1")]
            + _assistant_rows("msg_A", "req_A", _reply("finished cleanly"))
        )
        assert turns[0]["ended_by"] is None


class TestRewindDetection:
    """A3: a second turn-opening prompt on one parent means the user rewound."""

    def test_same_text_and_edited_text_rewinds_are_classified(self):
        turns = _render(
            [_user_row("analyze the module", "u1", parent="close-1")]
            + _assistant_rows("msg_A", "req_A", _reply("first attempt"))
            + [_user_row("analyze the module", "u2", parent="close-1")]
            + _assistant_rows("msg_B", "req_B", _reply("second attempt"))
            + [_user_row("summarize the module", "u3", parent="close-2")]
            + _assistant_rows("msg_C", "req_C", _reply("third attempt"))
            + [_user_row("summarize the module briefly", "u4", parent="close-2")]
            + _assistant_rows("msg_D", "req_D", _reply("fourth attempt"))
        )
        assert len(turns) == 4
        assert (turns[1]["rewound_from"], turns[1]["rewind_kind"]) == (1, "same_prompt")
        assert (turns[3]["rewound_from"], turns[3]["rewind_kind"]) == (3, "edited_prompt")
        # The abandoned branches report that their work no longer counts.
        assert [turn["status"] for turn in turns] == ["rewound", "ok", "rewound", "ok"]

    def test_a_third_attempt_points_at_the_attempt_it_replaced(self):
        turns = _render(
            [_user_row("try", "u1", parent="close-1")]
            + _assistant_rows("msg_A", "req_A", _reply("one"))
            + [_user_row("try again", "u2", parent="close-1")]
            + _assistant_rows("msg_B", "req_B", _reply("two"))
            + [_user_row("try once more", "u3", parent="close-1")]
            + _assistant_rows("msg_C", "req_C", _reply("three"))
        )
        assert turns[1]["rewound_from"] == 1
        assert turns[2]["rewound_from"] == 2
        assert [turn["status"] for turn in turns] == ["rewound", "rewound", "ok"]

    def test_rewound_outranks_the_outcome_status(self):
        # A turn whose last tool errored AND was then rewound past must report
        # "rewound": the error belongs to work the user discarded, so surfacing
        # it as the turn's status would put a dead branch's failure on the log.
        errored = _assistant_rows("msg_A", "req_A", [
            {"type": "text", "text": "trying"},
            {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "false"}},
        ])
        failure = {"type": "user", "uuid": "r1", "parentUuid": "msg_A-1",
                   "timestamp": "2026-09-15T00:00:02Z",
                   "message": {"content": [{"type": "tool_result", "tool_use_id": "t1",
                                            "content": "boom", "is_error": True}]}}
        turns = _render(
            [_user_row("run it", "u1", parent="close-1")] + errored + [failure]
            + [_user_row("run it differently", "u2", parent="close-1")]
            + _assistant_rows("msg_B", "req_B", _reply("worked"))
        )
        assert turns[0]["status"] == "rewound"
        assert turns[1]["rewound_from"] == 1

    def test_parallel_tool_fan_out_is_not_a_rewind(self):
        # A message issuing two tool calls fans out parentUuid exactly as a
        # rewind does, but tool rows never open a turn.
        fan_out = _assistant_rows("msg_A", "req_A", [
            {"type": "text", "text": "reading both"},
            {"type": "tool_use", "id": "t1", "name": "Read", "input": {}},
            {"type": "tool_use", "id": "t2", "name": "Read", "input": {}},
        ])
        results = [
            {"type": "user", "uuid": "r1", "parentUuid": "msg_A-2",
             "timestamp": "2026-09-15T00:00:02Z",
             "message": {"content": [{"type": "tool_result", "tool_use_id": "t1",
                                      "content": "file one"}]}},
            {"type": "user", "uuid": "r2", "parentUuid": "msg_A-2",
             "timestamp": "2026-09-15T00:00:02Z",
             "message": {"content": [{"type": "tool_result", "tool_use_id": "t2",
                                      "content": "file two"}]}},
        ]
        turns = _render([_user_row("read both files", "u1", parent="close-1")]
                        + fan_out + results)
        assert len(turns) == 1
        assert "rewound_from" not in turns[0]
        assert turns[0]["status"] != "rewound"

    def test_noise_row_sharing_a_parent_is_not_a_rewind(self):
        # Observed live: running a local command after a prompt re-parents a
        # <local-command-caveat> row onto the same turn-closing record.
        caveat = ("<local-command-caveat>Caveat: The messages below were "
                  "generated by the user while running local commands.")
        turns = _render(
            [_user_row("continue", "u1", parent="close-1")]
            + _assistant_rows("msg_A", "req_A", _reply("continuing"))
            + [_user_row(caveat, "u2", parent="close-1")]
        )
        assert len(turns) == 1
        assert "rewound_from" not in turns[0]

    def test_root_parented_prompts_are_not_rewinds_of_each_other(self):
        # parentUuid null is the transcript root, not lineage. A resumed
        # session can carry several, and treating null as a shared parent
        # would report every one of them as a rewind of the first.
        turns = _render(
            [_user_row("first", "u1", parent=None)]
            + _assistant_rows("msg_A", "req_A", _reply("one"))
            + [_user_row("second", "u2", parent=None)]
            + _assistant_rows("msg_B", "req_B", _reply("two"))
        )
        assert len(turns) == 2
        assert all("rewound_from" not in turn for turn in turns)
        assert all(turn["status"] == "ok" for turn in turns)

    def test_interrupt_row_does_not_claim_a_conversational_slot(self):
        # Interrupts carry a parentUuid too, but they are session events, not
        # prompts — a later prompt on that parent is a normal turn.
        turns = _render(
            [_user_row("do it", "u1", parent="close-1")]
            + _assistant_rows("msg_A", "req_A", _reply("working"))
            + [_user_row("[Request interrupted by user]", "i1", parent="close-1")]
            + [_user_row("try differently", "u2", parent="close-2")]
            + _assistant_rows("msg_B", "req_B", _reply("ok"))
        )
        assert all("rewound_from" not in turn for turn in turns)


class TestRenderedPayloadsSatisfyBothContracts:
    """The jest schema tests use handcrafted fixtures. These validate what the
    renderer ACTUALLY emits, so a fixture that drifts from real output cannot
    keep both contracts green while artifacts on disk violate them."""

    _KERNEL = (Path(__file__).resolve().parents[3] / "src" / "kernel"
               / "schemas" / "telemetry" / "turn-log.v2.json")
    _HOOK_PACK = _SHARED / "lib" / "session-log.schema.json"

    @staticmethod
    def _steering_payloads():
        interrupted = _assistant_rows("msg_A", "req_A", [
            {"type": "text", "text": "about to run it"},
            {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "rm -rf /"}},
        ])
        return _render(
            [_user_row("clean the build", "u1", parent="close-1")] + interrupted
            + [_user_row("[Request interrupted by user for tool use]", "i1")]
            + [_user_row("clean the build safely", "u2", parent="close-1")]
            + _assistant_rows("msg_B", "req_B", _reply("used the script instead"))
        )

    def test_rendered_turns_validate_against_the_kernel_producer_contract(self):
        import jsonschema

        schema = json.loads(self._KERNEL.read_text(encoding="utf-8"))
        payloads = self._steering_payloads()
        # Guard against a vacuous pass: the scenario must actually carry the
        # new signals, or this validates a payload that exercises nothing.
        assert payloads[0]["ended_by"] == "user_interrupt_tool"
        assert payloads[0]["status"] == "rewound"
        assert payloads[1]["rewound_from"] == 1
        assert payloads[1]["rewind_kind"] == "edited_prompt"
        assert payloads[0]["usage"]["requests"] == 1

        # Two violations in this contract predate this slice and are filed as
        # CAWS-DEFECT-TURN-LOG-V2-CONTRACT-REJECTS-REAL-OUTPUT-01: the schema
        # types turn_summary as a non-null string the renderer nulls, and its
        # turnContext omits the lineage key the renderer always writes. They
        # are excluded by exact path so they cannot mask a violation THIS
        # slice introduces; when that defect lands, the exclusion list empties
        # and this assertion tightens on its own.
        known_pre_existing = {("turn_summary",), ("context",)}
        validator = jsonschema.Draft202012Validator(schema)
        errors = []
        for payload in payloads:
            for error in validator.iter_errors(payload):
                path = tuple(error.absolute_path)
                if path in known_pre_existing:
                    continue
                errors.append((list(path), error.validator, error.message))
        assert errors == [], f"this slice's fields violate the producer contract: {errors}"

    def test_rendered_turns_validate_against_the_hook_pack_schema(self):
        import jsonschema

        schema = json.loads(self._HOOK_PACK.read_text(encoding="utf-8"))
        for payload in self._steering_payloads():
            jsonschema.validate(payload, schema)


class TestSessionEndSealing:
    """A4: SessionEnd seals .meta.json; it never renders.

    Drives the real session-log.sh, not a Python reimplementation of it —
    a handler that is only ever exercised by a mock proves nothing about the
    shell that actually runs at teardown.
    """

    @staticmethod
    def _session_dir(tmp_root, session_id="sess-end-test"):
        log_dir = Path(tmp_root) / ".caws" / "sessions" / session_id
        log_dir.mkdir(parents=True)
        return log_dir

    @staticmethod
    def _write_turn(log_dir, number, usage):
        payload = {"schema_version": 2, "turn": number, "ts_start": None,
                   "ts_end": None, "user": "x", "user_ts": None,
                   "turn_summary": None, "status": "ok", "timeline": []}
        if usage is not None:
            payload["usage"] = usage
        (log_dir / f"turn-{number:03d}.json").write_text(
            json.dumps(payload, indent=2), encoding="utf-8")

    @staticmethod
    def _run_session_end(root, session_id, reason):
        import subprocess

        payload = json.dumps({
            "session_id": session_id,
            "cwd": str(root),
            "hook_event_name": "SessionEnd",
            "reason": reason,
            "transcript_path": "",
        })
        env = dict(os.environ)
        env.pop("CAWS_TRANSCRIPT_DATABASE", None)
        return subprocess.run(
            ["bash", str(_SHARED / "session-log.sh")],
            input=payload, capture_output=True, text=True, env=env, cwd=str(root),
        )

    def test_seals_meta_with_reason_and_summed_usage_without_new_turns(self):
        root = Path(tempfile.mkdtemp(prefix="caws-session-end-"))
        log_dir = self._session_dir(root)
        meta = log_dir / ".meta.json"
        meta.write_text(json.dumps({
            "session_id": "sess-end-test", "started_at": "2026-09-15T00:00:00Z",
            "local_time": "2026-09-15 00:00:00 PDT", "model": "claude-opus-5",
            "source": "startup", "branch": "main", "head_sha": "abc1234",
            "dirty_files": "0", "project": "caws", "transcript_path": "",
        }), encoding="utf-8")
        self._write_turn(log_dir, 1, {"requests": 1, "input": 10, "cache_read": 100,
                                      "cache_write": 5, "output": 50,
                                      "models": ["claude-opus-5"]})
        self._write_turn(log_dir, 2, {"requests": 2, "input": 20, "cache_read": 200,
                                      "cache_write": 7, "output": 70,
                                      "models": ["claude-haiku-4-5", "claude-opus-5"]})
        before = sorted(p.name for p in log_dir.glob("turn-*.json"))

        result = self._run_session_end(root, "sess-end-test", "other")

        assert result.returncode == 0, result.stderr
        sealed = json.loads(meta.read_text(encoding="utf-8"))
        assert sealed["ended"]["reason"] == "other"
        assert sealed["ended"]["ts"].endswith("Z")
        assert sealed["usage"] == {
            "requests": 3, "input": 30, "cache_read": 300,
            "cache_write": 12, "output": 120,
            # First-seen order across turns, not sorted.
            "models": ["claude-opus-5", "claude-haiku-4-5"],
        }
        # Sealing must not render: the turn set is untouched.
        assert sorted(p.name for p in log_dir.glob("turn-*.json")) == before
        # Session-start fields survive the seal.
        assert sealed["model"] == "claude-opus-5"
        assert sealed["session_id"] == "sess-end-test"

    def test_records_the_harness_reason_verbatim(self):
        # Not mapped to a known-value enum: a harness that adds a new reason
        # must have it preserved rather than collapsed into "other".
        for reason in ("clear", "logout", "prompt_input_exit", "some_future_reason"):
            root = Path(tempfile.mkdtemp(prefix="caws-session-end-"))
            log_dir = self._session_dir(root)
            (log_dir / ".meta.json").write_text(
                json.dumps({"session_id": "sess-end-test"}), encoding="utf-8")
            result = self._run_session_end(root, "sess-end-test", reason)
            assert result.returncode == 0, result.stderr
            sealed = json.loads((log_dir / ".meta.json").read_text(encoding="utf-8"))
            assert sealed["ended"]["reason"] == reason

    def test_seals_without_a_usage_block_when_no_turn_recorded_usage(self):
        root = Path(tempfile.mkdtemp(prefix="caws-session-end-"))
        log_dir = self._session_dir(root)
        (log_dir / ".meta.json").write_text(
            json.dumps({"session_id": "sess-end-test"}), encoding="utf-8")
        self._write_turn(log_dir, 1, None)

        result = self._run_session_end(root, "sess-end-test", "other")

        assert result.returncode == 0, result.stderr
        sealed = json.loads((log_dir / ".meta.json").read_text(encoding="utf-8"))
        assert sealed["ended"]["reason"] == "other"
        assert "usage" not in sealed

    def test_never_renders_even_when_a_transcript_is_available(self):
        # Invariant 5, made falsifiable. With no transcript, a stray render is
        # a no-op and the "turn set unchanged" check above would pass anyway.
        # Here a REAL transcript is reachable and disagrees with what is on
        # disk: rendering it would rewrite turn-001 and delete turn-002. If
        # those survive byte-for-byte, session_end genuinely did not render.
        import subprocess

        root = Path(tempfile.mkdtemp(prefix="caws-session-end-"))
        log_dir = self._session_dir(root)
        (log_dir / ".meta.json").write_text(
            json.dumps({"session_id": "sess-end-test"}), encoding="utf-8")
        self._write_turn(log_dir, 1, None)
        self._write_turn(log_dir, 2, None)
        before = {p.name: p.read_text(encoding="utf-8")
                  for p in log_dir.glob("turn-*.json")}

        transcript = root / "transcript.jsonl"
        transcript.write_text(
            "".join(json.dumps(row) + "\n" for row in
                    [_user_row("only one real turn here", "u1")]
                    + _assistant_rows("msg_A", "req_A", _reply("rendered answer"))),
            encoding="utf-8")

        payload = json.dumps({
            "session_id": "sess-end-test", "cwd": str(root),
            "hook_event_name": "SessionEnd", "reason": "other",
            "transcript_path": str(transcript),
        })
        env = dict(os.environ)
        env.pop("CAWS_TRANSCRIPT_DATABASE", None)
        result = subprocess.run(
            ["bash", str(_SHARED / "session-log.sh")],
            input=payload, capture_output=True, text=True, env=env, cwd=str(root))

        assert result.returncode == 0, result.stderr
        after = {p.name: p.read_text(encoding="utf-8")
                 for p in log_dir.glob("turn-*.json")}
        assert after == before
        # Control: the same transcript through the Stop path DOES render, so
        # the assertion above is about session_end's behavior, not about the
        # transcript being unrenderable.
        stop_payload = json.loads(payload)
        stop_payload["hook_event_name"] = "Stop"
        subprocess.run(["bash", str(_SHARED / "session-log.sh")],
                       input=json.dumps(stop_payload), capture_output=True,
                       text=True, env=env, cwd=str(root))
        rendered = {p.name for p in log_dir.glob("turn-*.json")}
        assert rendered == {"turn-001.json"}

    def test_missing_meta_is_not_an_error(self):
        # A resumed session has no .meta.json. Teardown must not fail on it.
        root = Path(tempfile.mkdtemp(prefix="caws-session-end-"))
        self._session_dir(root)
        result = self._run_session_end(root, "sess-end-test", "other")
        assert result.returncode == 0, result.stderr

    def test_sealing_is_idempotent(self):
        # SessionEnd can fire more than once (resume then exit); a second seal
        # must overwrite the first, never append a second `ended` or double
        # the usage totals.
        root = Path(tempfile.mkdtemp(prefix="caws-session-end-"))
        log_dir = self._session_dir(root)
        (log_dir / ".meta.json").write_text(
            json.dumps({"session_id": "sess-end-test"}), encoding="utf-8")
        self._write_turn(log_dir, 1, {"requests": 1, "input": 10, "cache_read": 100,
                                      "cache_write": 5, "output": 50,
                                      "models": ["claude-opus-5"]})
        self._run_session_end(root, "sess-end-test", "clear")
        self._run_session_end(root, "sess-end-test", "logout")
        sealed = json.loads((log_dir / ".meta.json").read_text(encoding="utf-8"))
        assert sealed["ended"]["reason"] == "logout"
        assert sealed["usage"]["requests"] == 1
        assert sealed["usage"]["output"] == 50


class TestRealTranscriptUsageParity:
    """A6: rendered session usage matches an independent dedup over the file."""

    @staticmethod
    def _transcript():
        override = os.environ.get("CAWS_SESSION_LOG_PARITY_TRANSCRIPT")
        if override:
            return Path(override)
        root = Path.home() / ".claude" / "projects"
        if not root.is_dir():
            return None
        candidates = [p for p in root.glob("*/*.jsonl") if p.stat().st_size > 200_000]
        return max(candidates, key=lambda p: p.stat().st_size) if candidates else None

    @staticmethod
    def _oracle(path):
        """Count requests and tokens WITHOUT the renderer's adapter.

        Deliberately independent: it reads the raw JSONL and keys on
        (message.id, requestId) itself, so a defect shared with the adapter
        cannot make both sides agree.
        """
        seen = {}
        with path.open(encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(row, dict) or row.get("type") != "assistant":
                    continue
                message = row.get("message")
                if not isinstance(message, dict):
                    continue
                usage = message.get("usage")
                message_id = message.get("id")
                if not isinstance(usage, dict) or not isinstance(message_id, str):
                    continue
                request_id = row.get("requestId")
                key = (message_id, request_id if isinstance(request_id, str) else None)
                seen.setdefault(key, usage)
        totals = {"requests": len(seen), "input": 0, "cache_read": 0,
                  "cache_write": 0, "output": 0}
        source = {"input": "input_tokens", "cache_read": "cache_read_input_tokens",
                  "cache_write": "cache_creation_input_tokens", "output": "output_tokens"}
        for usage in seen.values():
            for target, field in source.items():
                value = usage.get(field)
                if isinstance(value, int) and not isinstance(value, bool):
                    totals[target] += value
        return totals

    def test_session_totals_match_an_independent_dedup_count(self):
        import pytest

        path = self._transcript()
        if path is None or not path.is_file():
            pytest.skip("no local Claude transcript available for parity")

        directory = Path(tempfile.mkdtemp(prefix="caws-slr-parity-"))
        slr._render_session_unlocked(
            log_dir=str(directory), cwd="/repo", session_id=path.stem,
            started_at="2026-09-15 00:00:00 PDT", model="claude-opus-5",
            branch="main", head_sha="abc1234", dirty_count="0", start_sha="abc1234",
            transcript_path=str(path),
        )
        payloads = [json.loads(p.read_text(encoding="utf-8"))
                    for p in sorted(directory.glob("turn-*.json"))]
        rendered = {"requests": 0, "input": 0, "cache_read": 0,
                    "cache_write": 0, "output": 0}
        for payload in payloads:
            usage = payload.get("usage")
            if not usage:
                continue
            for field in rendered:
                rendered[field] += usage[field]

        oracle = self._oracle(path)
        # Captured by pytest unless the test fails, where it is the diagnostic.
        print(f"parity source={path} turns={len(payloads)} "
              f"rendered={rendered} oracle={oracle} "
              f"rewinds={[(p['turn'], p['rewound_from'], p['rewind_kind']) for p in payloads if 'rewound_from' in p]} "
              f"interrupts={[(p['turn'], p['ended_by']) for p in payloads if p['ended_by']]}")
        assert oracle["requests"] > 0, f"{path} carries no usage to compare"
        assert rendered == oracle
