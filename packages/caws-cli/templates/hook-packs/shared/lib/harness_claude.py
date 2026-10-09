# CAWS-MANAGED-HOOK
# hook_pack: shared
# hook_pack_version: 1
# caws_min_major: 11
# edit_stance: YOURS TO EDIT. This is a starting hook, not a locked one — shape it
#   to your repo: tune thresholds, add checks, remove what does not fit. Your edits
#   are preserved: caws init treats a changed hook as intended growth and will not
#   clobber it — it shows a diff and asks (--adopt keeps yours; --overwrite --force
#   takes the upstream template). The CAWS-MANAGED-HOOK marker above is only how caws
#   init finds hooks it can offer updates for; it is NOT a keep-out sign. CAWS owns the
#   failure-class invariant (the why/what a guard protects); you own the how. The one
#   edit to avoid: gutting a guard to dodge a block instead of fixing the cause. Grow
#   everything else freely.
"""Claude Code harness adapter: normalize Claude-native transcript rows.

Claude Code emits JSONL rows of shape {"type": "user"|"assistant"|"attachment",
"message": {...}, "timestamp": ...}. This module owns the translation from
that shape to canonical renderer events.

The same row shape is also what lib/opencode-transcript.py and
lib/zcode-transcript.py emit after reconstructing from their SQLite stores, so
this adapter is the workhorse for three surfaces (claude-code natively, plus
opencode and zcode via their reconstruct scripts). opencode-specific and
zcode-specific noise is owned by their respective modules; this module owns
only claude-code's own injected noise.

Behavior moved verbatim from session_log_renderer.py (v17 of the hook pack).
"""

from __future__ import annotations

import re
from typing import Any

from harness_common import (
    TranscriptRowAdapter,
    as_bool,
    parse_hook_stdout,
    parse_timestamp,
)

# tool_use input keys Claude Code has been observed to stringify ('true'/
# 'false' on Agent dispatches, measured 2026-09-26) even though the renderer
# and schema treat them as booleans. Coerced at this boundary so downstream
# artifacts stay schema-valid without weakening the schema.
STRINGIFIED_BOOL_INPUT_KEYS = ("run_in_background",)


def _row_lineage(obj: dict[str, Any]) -> dict[str, Any]:
    """Carry a row's identity and its parent's onto the canonical event.

    The renderer needs both to detect a rewind: a re-typed prompt re-parents
    onto the record that closed the earlier turn (observed: a
    `system/turn_duration` row), so two turn-opening prompts sharing a
    parent_uuid are the same conversational slot occupied twice.

    A null/absent parentUuid is NOT lineage — it is the transcript's root, and
    every resumed session can carry several of them. Emitting it would make
    every root-parented prompt collide with every other, so it is dropped here
    rather than filtered downstream.
    """
    lineage: dict[str, Any] = {}
    uuid_value = obj.get("uuid")
    parent_value = obj.get("parentUuid")
    if isinstance(uuid_value, str) and uuid_value:
        lineage["uuid"] = uuid_value
    if isinstance(parent_value, str) and parent_value:
        lineage["parent_uuid"] = parent_value
    return lineage

# User-role rows Claude Code injects that are not human turns: slash-command
# echoes, local-command wrappers, session-continuation banners, and hook-block
# echoes. Left unfiltered these open phantom turns (an empty turn-NNN.json)
# that persist into the session log. The renderer concatenates these with
# contributions from other harness modules to form the full noise filter.
NOISE_PREFIXES: tuple[str, ...] = (
    "<local-command",
    "<command-name",
    "<command-message",
    "<local-command-stdout",
    "<local-command-caveat",
    "This session is being continued",
    # Slash-command body + hook-block echoes. A hook-intercepted command
    # (/copy-turn, /replay-last, /reorient) is delivered as a user-role event
    # in three shapes — a <command-message>/<command-name> wrapper (covered
    # above), the skill body text, and the block reason echoed back as
    # "Operation stopped by hook:". None of these are agent work.
    #
    # The /copy-turn command body is matched by its sentinel first line
    # ("<!-- copy-turn:" — version-agnostic on purpose), not by its prose:
    # the prose prefix below it broke silently when the body was reworded
    # (2026-08-18, the v2 async-fallback rewrite). The prose prefix stays for
    # transcripts written before the sentinel existed.
    "<!-- copy-turn:",
    "This slash command's behavior is handled entirely by",
    "Operation stopped by hook:",
)


def extract_text_from_content_blocks(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""

    blocks = []
    for item in content:
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        if isinstance(text, str) and text.strip():
            blocks.append(text)
            continue
        if item.get("type") == "json":
            value = item.get("json")
            if value is not None:
                import json

                blocks.append(json.dumps(value, ensure_ascii=False))
    return "\n\n".join(blocks)


def extract_tool_result_content(entry: dict[str, Any]) -> str:
    tool_use_result = entry.get("tool_use_result")
    if isinstance(tool_use_result, dict):
        file_payload = tool_use_result.get("file")
        if isinstance(file_payload, dict):
            content = file_payload.get("content")
            if isinstance(content, str) and content.strip():
                return content
        text = tool_use_result.get("text")
        if isinstance(text, str) and text.strip():
            return text
    item_content = extract_text_from_content_blocks(entry.get("content"))
    if item_content.strip():
        return item_content
    return entry.get("content", "") or ""


# !-command shell activity. When the user runs `! <cmd>` in a session, the
# harness records TWO user-role rows: <bash-input>cmd</bash-input>, then
# <bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>. These are user
# actions, not prompts — filtered as turn-openers but CAPTURED as user_shell
# events (a `! git push` after the last turn is often the record of the work
# shipping; discarding it like <local-command-stdout> would erase it).
# The harness entity-escapes inside these tags (observed: `main -&gt; main`
# for `main -> main`), so captured text is html-unescaped. Accepted risk: a
# command whose real output contains a literal `&gt;` is over-unescaped.
_BASH_INPUT_RE = re.compile(r"<bash-input>(.*?)</bash-input>", re.DOTALL)
_BASH_STDOUT_RE = re.compile(r"<bash-stdout>(.*?)</bash-stdout>", re.DOTALL)
_BASH_STDERR_RE = re.compile(r"<bash-stderr>(.*?)</bash-stderr>", re.DOTALL)


def _shell_event(text: str, ts: str | None) -> dict[str, Any] | None:
    import html

    if text.startswith("<bash-input>"):
        match = _BASH_INPUT_RE.search(text)
        return {
            "ev": "user_shell",
            "command": html.unescape(match.group(1)) if match else text,
            "ts": ts,
        }
    if text.startswith("<bash-stdout>") or text.startswith("<bash-stderr>"):
        stdout = _BASH_STDOUT_RE.search(text)
        stderr = _BASH_STDERR_RE.search(text)
        return {
            "ev": "user_shell",
            "stdout": html.unescape(stdout.group(1)) if stdout else "",
            "stderr": html.unescape(stderr.group(1)) if stderr else "",
            "ts": ts,
        }
    return None


# Older harness versions delivered interjection prompts wrapped in
# <user>…</user>; the current shape is bare text. Normalize so consumers see
# one format (SESSION-LOG-REMOTE-DEBRIEF-001 A5).
_USER_WRAP_RE = re.compile(r"\A\s*<user>(.*)</user>\s*\Z", re.DOTALL)


def _normalize_interjection(text: str) -> str:
    match = _USER_WRAP_RE.match(text)
    return (match.group(1) if match else text).strip()


def _matches_claude(row: dict[str, Any]) -> bool:
    return row.get("type") in {"user", "assistant", "attachment", "ai-title", "cost-state", "queue-operation", "system"}


# system-row subtypes that carry governance/outcome signal. Everything else
# (stop_hook_summary with empty content, future subtypes) returns no events.
_CLAUDE_SYSTEM_SUBTYPES = {"turn_duration", "informational"}


def _claude_control_event(row: dict[str, Any], ts: str | None) -> dict[str, Any] | None:
    """Translate one Claude Code governance/lifecycle row to a control event.

    These rows are the only record of: per-turn wall duration, hook blocks
    from NON-CAWS vendor hooks ("UserPromptSubmit operation blocked by
    hook:"), session cost totals, AI-generated session titles, and the
    user's message-queue operations (steering cadence). All were dropped
    before 2026-09-26.
    """
    kind = row.get("type")
    if kind == "ai-title":
        title = row.get("aiTitle")
        if isinstance(title, str) and title.strip():
            return {"ev": "control", "subtype": "session_title", "text": title, "ts": ts}
        return None
    if kind == "cost-state":
        event: dict[str, Any] = {"ev": "control", "subtype": "cost_state", "ts": ts}
        if isinstance(row.get("totalCostUSD"), (int, float)):
            event["cost_usd"] = row["totalCostUSD"]
        for src_key, dst_key in (
            ("totalAPIDuration", "api_duration_ms"),
            ("totalToolDuration", "tool_duration_ms"),
            ("totalLinesAdded", "lines_added"),
            ("totalLinesRemoved", "lines_removed"),
        ):
            if isinstance(row.get(src_key), (int, float)):
                event[dst_key] = row[src_key]
        model_usage = row.get("modelUsage")
        if isinstance(model_usage, dict) and model_usage:
            event["models"] = sorted(k for k in model_usage if isinstance(k, str))
        return event
    if kind == "queue-operation":
        operation = row.get("operation")
        if isinstance(operation, str) and operation:
            return {"ev": "control", "subtype": "queue_operation", "text": operation, "ts": ts}
        return None
    if kind == "system":
        subtype = row.get("subtype")
        if subtype == "turn_duration":
            event = {"ev": "control", "subtype": "turn_duration", "ts": ts}
            if isinstance(row.get("durationMs"), (int, float)):
                event["duration_ms"] = row["durationMs"]
            if isinstance(row.get("messageCount"), (int, float)):
                event["message_count"] = int(row["messageCount"])
            return event
        if subtype == "informational":
            content = row.get("content")
            text = content if isinstance(content, str) else ""
            if not text.strip():
                return None
            event = {"ev": "control", "subtype": "system_notice", "text": text, "ts": ts}
            level = row.get("level")
            if isinstance(level, str) and level:
                event["level"] = level
            return event
        return None
    return None


def normalize_claude_row(obj: dict[str, Any], _state: dict[str, Any]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    ts = parse_timestamp(obj.get("timestamp"))
    kind = obj.get("type")
    if kind in {"ai-title", "cost-state", "queue-operation", "system"}:
        control = _claude_control_event(obj, ts)
        return [control] if control is not None else []
    if kind == "user":
        content = obj.get("message", {}).get("content")
        if isinstance(content, str):
            shell = _shell_event(content, ts)
            events.append(
                shell if shell else {"ev": "user_text", "text": content, "ts": ts, **_row_lineage(obj)}
            )
        elif isinstance(content, list):
            for item in content:
                if not isinstance(item, dict):
                    continue
                if item.get("type") == "tool_result":
                    events.append({
                        "ev": "tool_result",
                        "id": item.get("tool_use_id", ""),
                        "content": extract_tool_result_content(item),
                        "tool_use_result": item.get("tool_use_result"),
                        "is_error": item.get("is_error", False),
                        "ts": ts,
                    })
                elif item.get("type") == "text":
                    text = item.get("text", "")
                    shell = _shell_event(text, ts)
                    events.append(
                        shell if shell else {"ev": "user_text", "text": text, "ts": ts, **_row_lineage(obj)}
                    )
    elif kind == "assistant":
        message = obj.get("message", {})
        content = message.get("content", [])
        if isinstance(content, list):
            for item in content:
                if not isinstance(item, dict):
                    continue
                if item.get("type") == "text":
                    events.append({"ev": "assistant_text", "text": item.get("text", ""), "ts": ts})
                elif item.get("type") == "thinking":
                    # Extended-thinking blocks are the model's deliberation
                    # trace — the "why" a replay reader needs. Dropped here
                    # before 2026-09-26, so decision/summary heuristics ran on
                    # visible text only. Emitted as a distinct `reasoning`
                    # event (not assistant_text) so the renderer can mark
                    # provenance=thinking without string-sniffing.
                    thinking_text = item.get("thinking", "") or item.get("text", "") or ""
                    if isinstance(thinking_text, str) and thinking_text.strip():
                        events.append({"ev": "reasoning", "text": thinking_text, "ts": ts})
                elif item.get("type") == "tool_use":
                    tool_input = item.get("input", {}) if isinstance(item.get("input"), dict) else {}
                    if any(
                        key in tool_input and isinstance(tool_input.get(key), str)
                        for key in STRINGIFIED_BOOL_INPUT_KEYS
                    ):
                        tool_input = dict(tool_input)
                        for key in STRINGIFIED_BOOL_INPUT_KEYS:
                            if key in tool_input:
                                tool_input[key] = as_bool(tool_input[key])
                    events.append({
                        "ev": "tool_use",
                        "name": item.get("name", ""),
                        "id": item.get("id", ""),
                        "input": tool_input,
                        "ts": ts,
                    })
        # Per-message model/usage/stop_reason: the outcome and cost record for
        # this assistant step (66/66 assistant rows carry usage in a typical
        # Claude session; none of it reached the turn artifacts before
        # 2026-09-26). Slimmed to the fields the turn rollup consumes.
        if isinstance(message, dict):
            usage_raw = message.get("usage")
            usage = None
            if isinstance(usage_raw, dict):
                usage = {
                    key: usage_raw[key]
                    for key in (
                        "input_tokens",
                        "output_tokens",
                        "cache_read_input_tokens",
                        "cache_creation_input_tokens",
                    )
                    if isinstance(usage_raw.get(key), (int, float))
                }
                if not usage:
                    usage = None
            model = message.get("model")
            stop_reason = message.get("stop_reason")
            if usage or model or stop_reason:
                # message_id/request_id let the renderer dedup usage across the
                # rows of one multi-block reply (Claude Code repeats
                # message.usage verbatim on every row; naive per-row sums
                # roughly double every count).
                meta: dict[str, Any] = {"ev": "assistant_meta", "ts": ts}
                message_id = message.get("id") if isinstance(message, dict) else None
                request_id = obj.get("requestId")
                if isinstance(message_id, str) and message_id:
                    meta["message_id"] = message_id
                if isinstance(request_id, str) and request_id:
                    meta["request_id"] = request_id
                if usage:
                    meta["usage"] = usage
                if model:
                    meta["model"] = model
                if stop_reason:
                    meta["stop_reason"] = stop_reason
                events.append(meta)
    elif kind == "attachment":
        attachment = obj.get("attachment")
        if isinstance(attachment, str):
            if "'queued_command'" in attachment and "'human'" in attachment:
                match = re.search(r"'prompt':\s*'(.*?)',\s*'commandMode'", attachment, re.DOTALL)
                if match:
                    events.append({
                        "ev": "interjection",
                        "text": _normalize_interjection(match.group(1)),
                        "ts": ts,
                    })
        elif isinstance(attachment, dict) and attachment.get("type") == "queued_command":
            origin = attachment.get("origin")
            if isinstance(origin, dict) and origin.get("kind") == "human":
                raw_prompt = attachment.get("prompt", "")
                prompt = raw_prompt if isinstance(raw_prompt, str) else extract_text_from_content_blocks(raw_prompt)
                if prompt and prompt.strip():
                    events.append({
                        "ev": "interjection",
                        "text": _normalize_interjection(prompt),
                        "ts": ts,
                    })
        elif isinstance(attachment, dict) and attachment.get("type") == "hook_success":
            hook_context = parse_hook_stdout(attachment.get("stdout"))
            if hook_context is not None:
                hook_context.update({
                    "ev": "hook_context",
                    "hook_name": attachment.get("hookName"),
                    "hook_event": hook_context.get("hook_event") or attachment.get("hookEvent"),
                    "tool_use_id": attachment.get("toolUseID"),
                    "exit_code": attachment.get("exitCode"),
                    "duration_ms": attachment.get("durationMs"),
                    "ts": ts,
                })
                events.append(hook_context)
    return events


from harness_common import HarnessModule  # noqa: E402

MODULE = HarnessModule(
    name="claude",
    adapters=(
        TranscriptRowAdapter("claude", _matches_claude, normalize_claude_row),
    ),
    noise_prefixes=NOISE_PREFIXES,
)
