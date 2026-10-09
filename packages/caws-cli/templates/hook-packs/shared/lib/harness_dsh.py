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

"""DeepSeek Harness (DSH) adapter: normalize DSH-native session rows.

DSH persists sessions as zstd-compressed JSONL of events shaped
{"type": "...", "seq": N, "time": <epoch-ms>, "data": {...}, "surfaceOp"?}.
This module owns the translation from those rows to canonical renderer events.

DSH is streaming-first: it also emits assistant/chunk / text-chunks /
reasoning-chunks / tool-call-chunks rows carrying partial content. Those are
sub-events of assistant/message and tool/call, so this adapter skips them — the
complete message/tool events are authoritative.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from harness_common import (
    HarnessModule,
    TranscriptRowAdapter,
    parse_timestamp,
)

# DSH rows this adapter owns. Everything else (chunks, agent/*, request/*,
# goal/change, todo/write, sandbox/*, permission/*, ...) is ignored — except
# the small set of session-governance rows listed alongside the conversation
# rows below, which normalize to `control` events (title, approval policy,
# permission preset, sandbox mode, subagent descriptor, spliced inbox
# messages): they answer WHEN/UNDER-WHAT-AUTHORITY a turn ran, and were
# dropped entirely before 2026-09-26.
DSH_EVENT_TYPES = frozenset({
    "turn/start",
    "user/message",
    "assistant/message",
    "tool/call",
    "tool/result",
    "step/start",
    "step/end",
    "session/title",
    "approval/policy",
    "permission/preset",
    "sandbox/mode",
    "subagent/descriptor",
    "agent/inbox/spliced",
})

# Subagent descriptors repeat once per spawned subagent turn; one control
# event per distinct label is the useful record, not one per repetition.
_DEDUPE_CONTROL_TYPES = {"subagent_descriptor"}


def _matches_dsh(row: dict[str, Any]) -> bool:
    return row.get("type") in DSH_EVENT_TYPES


def _ts_ms(obj: dict[str, Any]) -> str | None:
    # DSH records wall-clock time in epoch milliseconds; harness_common's
    # parse_timestamp interprets a numeric value as epoch SECONDS. Millisecond
    # precision is preserved (not truncated to the second): sub-second
    # ordering is the difference between "steering landed before/after this
    # tool call" on DSH sessions.
    raw = obj.get("time")
    if isinstance(raw, (int, float)):
        dt = datetime.utcfromtimestamp(raw / 1000.0)
        return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(dt.microsecond // 1000):03d}Z"
    return parse_timestamp(raw)


def _text_blocks(blocks: Any, want: set[str]) -> list[str]:
    if not isinstance(blocks, list):
        return []
    out: list[str] = []
    for b in blocks:
        if not isinstance(b, dict):
            continue
        if b.get("type") not in want:
            continue
        text = b.get("text")
        if isinstance(text, str) and text.strip():
            out.append(text)
    return out


def _normalize_control(kind: str, data: dict[str, Any], ts: str | None) -> dict[str, Any] | None:
    """Translate one DSH session-governance row into a control event."""
    if kind == "session/title":
        title = data.get("title")
        if isinstance(title, str) and title.strip():
            return {"ev": "control", "subtype": "session_title", "text": title, "ts": ts}
        return None
    if kind == "approval/policy":
        policy = data.get("policy")
        if isinstance(policy, str) and policy:
            event = {"ev": "control", "subtype": "approval_policy", "text": policy, "ts": ts}
            source = data.get("source")
            if isinstance(source, str) and source:
                event["source"] = source
            return event
        return None
    if kind == "permission/preset":
        preset = data.get("preset")
        if isinstance(preset, str) and preset:
            return {"ev": "control", "subtype": "permission_preset", "text": preset, "ts": ts}
        return None
    if kind == "sandbox/mode":
        mode = data.get("mode")
        if isinstance(mode, str) and mode:
            event = {"ev": "control", "subtype": "sandbox_mode", "text": mode, "ts": ts}
            source = data.get("source")
            if isinstance(source, str) and source:
                event["source"] = source
            return event
        return None
    if kind == "subagent/descriptor":
        label = data.get("label")
        if not isinstance(label, str) or not label.strip():
            return None
        event = {"ev": "control", "subtype": "subagent_descriptor", "text": label, "ts": ts}
        model = data.get("agentModel")
        if isinstance(model, str) and model:
            event["model"] = model
        return event
    if kind == "agent/inbox/spliced":
        # A message another agent spliced into this session's inbox — the
        # record of cross-agent steering. Bounded preview; the full text
        # stays in the DSH transcript.
        texts: list[str] = []
        inserted = data.get("inserted")
        if isinstance(inserted, list):
            for item in inserted:
                if not isinstance(item, dict):
                    continue
                for block in item.get("content") or []:
                    if isinstance(block, dict) and isinstance(block.get("text"), str):
                        if block["text"].strip():
                            texts.append(block["text"])
        if not texts:
            return None
        preview = "\n\n".join(texts)[:400]
        return {"ev": "control", "subtype": "agent_inbox_spliced", "text": preview, "ts": ts}
    return None


def normalize_dsh_row(obj: dict[str, Any], state: dict[str, Any]) -> list[dict[str, Any]]:
    ts = _ts_ms(obj)
    data = obj.get("data")
    if not isinstance(data, dict):
        return []
    kind = obj.get("type")

    kind = obj.get("type")

    governance = {"session/title", "approval/policy", "permission/preset", "sandbox/mode", "subagent/descriptor", "agent/inbox/spliced"}
    if kind in governance:
        event = _normalize_control(kind, data, ts)
        if event is None:
            return []
        if event.get("subtype") in _DEDUPE_CONTROL_TYPES:
            seen = state.setdefault("dsh_control_seen", set())
            key = (event["subtype"], event.get("text"))
            if key in seen:
                return []
            seen.add(key)
        return [event]

    if kind in {"step/start", "step/end"}:
        # Pair start/end per (turn, step) to emit one control item carrying
        # the wall duration — the "how long did each step take" record.
        key = (data.get("turn"), data.get("step"))
        if kind == "step/start":
            state.setdefault("dsh_step_start_ms", {})[key] = obj.get("time")
            return []
        started = state.setdefault("dsh_step_start_ms", {}).pop(key, None)
        step_event: dict[str, Any] = {"ev": "control", "subtype": "step", "ts": ts}
        if isinstance(data.get("step"), int):
            step_event["step"] = data["step"]
        if isinstance(data.get("turn"), int):
            step_event["turn"] = data["turn"]
        if isinstance(started, (int, float)) and isinstance(obj.get("time"), (int, float)):
            step_event["duration_ms"] = round(obj["time"] - started)
        return [step_event]

    if kind == "turn/start":
        return [{"ev": "turn_boundary", "turn_id": data.get("turn"), "ts": ts}]

    if kind == "user/message":
        source = data.get("source")
        if not isinstance(source, dict) or source.get("kind") != "user":
            # Injected instructions (agent-instructions / skill-catalog), goal
            # state, system-prompt and plugin context are instruction material,
            # not human turns.
            return []
        return [
            {"ev": "user_text", "text": text, "ts": ts}
            for text in _text_blocks(data.get("content"), {"text"})
        ]

    if kind == "assistant/message":
        message = data.get("message")
        if not isinstance(message, dict):
            return []
        message_events: list[dict[str, Any]] = []
        # Reasoning blocks on the COMPLETE message are the model's
        # deliberation (the *-chunks rows are redundant partials). Recovered
        # 2026-09-26; previously dropped by policy.
        for text in _text_blocks(message.get("content"), {"reasoning"}):
            message_events.append({"ev": "reasoning", "text": text, "ts": ts})
        # Visible text only; tool-call blocks are covered by tool/call events.
        message_events.extend(
            {"ev": "assistant_text", "text": text, "ts": ts}
            for text in _text_blocks(message.get("content"), {"text"})
        )
        # Usage + model: data.usage (camelCase) and message.source.model.
        # Normalized here so the renderer's rollup keys stay harness-agnostic.
        usage_raw = data.get("usage")
        usage = None
        if isinstance(usage_raw, dict):
            usage = {
                dst: usage_raw[src]
                for src, dst in (
                    ("inputTokens", "input_tokens"),
                    ("outputTokens", "output_tokens"),
                    ("cacheReadTokens", "cache_read_input_tokens"),
                    ("reasoningTokens", "reasoning_output_tokens"),
                )
                if isinstance(usage_raw.get(src), (int, float))
            }
            usage = usage or None
        source = message.get("source")
        model = source.get("model") if isinstance(source, dict) else None
        if usage or isinstance(model, str) and model:
            meta: dict[str, Any] = {"ev": "assistant_meta", "ts": ts}
            if usage:
                meta["usage"] = usage
            if isinstance(model, str) and model:
                meta["model"] = model
            message_events.append(meta)
        return message_events

    if kind == "tool/call":
        args = data.get("arguments")
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                args = {"raw": args}
        if not isinstance(args, dict):
            args = {}
        return [{
            "ev": "tool_use",
            "name": data.get("name", ""),
            "id": data.get("callId", ""),
            "input": args,
            "ts": ts,
        }]

    if kind == "tool/result":
        message = data.get("message")
        if not isinstance(message, dict):
            return []
        events: list[dict[str, Any]] = []
        for block in message.get("content", []):
            if not isinstance(block, dict) or block.get("type") != "tool-result":
                continue
            text = "\n\n".join(_text_blocks(block.get("content"), {"text"}))
            events.append({
                "ev": "tool_result",
                "id": block.get("toolCallId", ""),
                "content": text,
                "is_error": block.get("isError", False),
                "ts": ts,
            })
        return events

    return []


MODULE = HarnessModule(
    name="dsh",
    adapters=(
        TranscriptRowAdapter("dsh", _matches_dsh, normalize_dsh_row),
    ),
)
