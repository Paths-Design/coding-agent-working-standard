#!/bin/bash
# Session Logger for Cursor IDE
#
# Dual-mode session logging:
#   1. Incremental: accumulates events from Cursor hook invocations during session
#   2. Workspace DB: on stop, reads Cursor's state.vscdb to enrich with metadata
#      (composer name, model, mode, prompts, generation history)
#   3. Global DB: on stop, reads cursorDiskKV bubbleId entries to reconstruct
#      full conversation including assistant responses, code blocks, file actions
#
# Generates:
#   session.txt        — lightweight index (header + turn list + exploration + audit)
#   turn-001.txt       — per-turn narrative (user + assistant exchange + tool calls)
#   turn-001.json      — per-turn structured data (tools + edits + results + responses)
#
# Cursor stores data across:
#   - globalStorage/state.vscdb → cursorDiskKV composerData:<id> (bubble headers)
#   - globalStorage/state.vscdb → cursorDiskKV bubbleId:<conv_id>:<bubble_id> (message content)
#   - workspaceStorage/*/state.vscdb → ItemTable composer.composerData (session metadata)
#   - workspaceStorage/*/state.vscdb → ItemTable aiService.prompts / aiService.generations
#   - ~/.cursor/ai-tracking/ai-code-tracking.db → conversation_summaries (tldr, overview)
#
# Output: ./tmp/<conversation-id>/
#
# Wired into: beforeSubmitPrompt, afterFileEdit, beforeShellExecution,
#             beforeReadFile, afterAgentResponse, afterAgentThought, stop
#
# @author @darianrosebrook

set -euo pipefail

INPUT=$(cat)

# --- Parse common fields ---
CONVERSATION_ID=$(echo "$INPUT" | jq -r '.conversation_id // "unknown"')
GENERATION_ID=$(echo "$INPUT" | jq -r '.generation_id // "none"')
HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "unknown"')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
CWD=$(pwd)

# --- Log directory ---
LOG_DIR="${CWD}/tmp/${CONVERSATION_ID}"
mkdir -p "$LOG_DIR"

EVENTS_FILE="$LOG_DIR/.events.jsonl"
META_FILE="$LOG_DIR/.meta.json"
SESSION_MD="$LOG_DIR/session.txt"

# ============================================================
# Helper: append an event to the accumulator
# ============================================================
append_event() {
  local event_json="$1"
  echo "$event_json" >> "$EVENTS_FILE"
}

# ============================================================
# Helper: resolve Cursor workspace state.vscdb path
# ============================================================
resolve_workspace_db() {
  local cursor_data=""

  if [ -d "$HOME/Library/Application Support/Cursor/User/workspaceStorage" ]; then
    cursor_data="$HOME/Library/Application Support/Cursor/User/workspaceStorage"
  elif [ -d "$HOME/.config/Cursor/User/workspaceStorage" ]; then
    cursor_data="$HOME/.config/Cursor/User/workspaceStorage"
  elif [ -d "${APPDATA:-}/Cursor/User/workspaceStorage" ] 2>/dev/null; then
    cursor_data="${APPDATA}/Cursor/User/workspaceStorage"
  fi

  if [ -z "$cursor_data" ]; then
    echo ""
    return
  fi

  for ws_dir in "$cursor_data"/*/; do
    local ws_json="${ws_dir}workspace.json"
    if [ -f "$ws_json" ]; then
      local folder
      folder=$(python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(d.get('folder', ''))
except: pass
" "$ws_json" 2>/dev/null)

      local expected="file://${CWD}"
      if [ "$folder" = "$expected" ]; then
        local db="${ws_dir}state.vscdb"
        if [ -f "$db" ]; then
          echo "$db"
          return
        fi
      fi
    fi
  done

  echo ""
}

# ============================================================
# Helper: resolve Cursor global state.vscdb path
# ============================================================
resolve_global_db() {
  local candidates=(
    "$HOME/Library/Application Support/Cursor/User/globalStorage/state.vscdb"
    "$HOME/.config/Cursor/User/globalStorage/state.vscdb"
  )
  for db in "${candidates[@]}"; do
    if [ -f "$db" ]; then
      echo "$db"
      return
    fi
  done
  echo ""
}

# ============================================================
# Helper: resolve Cursor ai-tracking database
# ============================================================
resolve_tracking_db() {
  local candidates=(
    "$HOME/.cursor/ai-tracking/ai-code-tracking.db"
    "$HOME/.config/Cursor/ai-tracking/ai-code-tracking.db"
  )
  for db in "${candidates[@]}"; do
    if [ -f "$db" ]; then
      echo "$db"
      return
    fi
  done
  echo ""
}

# ============================================================
# EVENT: beforeSubmitPrompt — capture user prompts (turn boundaries)
# ============================================================
handle_before_submit_prompt() {
  local prompt
  prompt=$(echo "$INPUT" | jq -r '.prompt // ""')

  if [ -z "$prompt" ] || [ "$prompt" = "null" ]; then
    return
  fi

  append_event "$(jq -cn \
    --arg ev "user_text" \
    --arg text "$prompt" \
    --arg ts "$TIMESTAMP" \
    --arg gen "$GENERATION_ID" \
    '{ev: $ev, text: $text, ts: $ts, generation_id: $gen}')"
}

# ============================================================
# EVENT: afterFileEdit — capture file edits
# ============================================================
handle_after_file_edit() {
  local file_path action_type
  file_path=$(echo "$INPUT" | jq -r '.file_path // ""')
  action_type=$(echo "$INPUT" | jq -r '.action // "edit"')

  file_path=$(echo "$file_path" | sed "s|${CWD}/||")

  append_event "$(jq -cn \
    --arg ev "file_edit" \
    --arg file "$file_path" \
    --arg action "$action_type" \
    --arg ts "$TIMESTAMP" \
    --arg gen "$GENERATION_ID" \
    '{ev: $ev, file: $file, action: $action, ts: $ts, generation_id: $gen}')"
}

# ============================================================
# EVENT: afterAgentResponse — capture assistant response text at turn end
# ============================================================
handle_after_agent_response() {
  local response
  response=$(echo "$INPUT" | jq -r '.response // ""')

  if [ -z "$response" ] || [ "$response" = "null" ]; then
    return
  fi

  append_event "$(jq -cn \
    --arg ev "agent_response" \
    --arg text "$response" \
    --arg ts "$TIMESTAMP" \
    --arg gen "$GENERATION_ID" \
    '{ev: $ev, text: $text, ts: $ts, generation_id: $gen}')"
}

# ============================================================
# EVENT: afterAgentThought — capture agent reasoning steps
# ============================================================
handle_after_agent_thought() {
  local thought
  thought=$(echo "$INPUT" | jq -r '.thought // ""')

  if [ -z "$thought" ] || [ "$thought" = "null" ]; then
    return
  fi

  append_event "$(jq -cn \
    --arg ev "agent_thought" \
    --arg text "$thought" \
    --arg ts "$TIMESTAMP" \
    --arg gen "$GENERATION_ID" \
    '{ev: $ev, text: $text, ts: $ts, generation_id: $gen}')"
}

# ============================================================
# EVENT: beforeShellExecution — capture shell commands
# ============================================================
handle_before_shell_execution() {
  local command
  command=$(echo "$INPUT" | jq -r '.command // ""')

  if [ -z "$command" ] || [ "$command" = "null" ]; then
    return
  fi

  append_event "$(jq -cn \
    --arg ev "shell_command" \
    --arg cmd "$command" \
    --arg ts "$TIMESTAMP" \
    --arg gen "$GENERATION_ID" \
    '{ev: $ev, command: $cmd, ts: $ts, generation_id: $gen}')"
}

# ============================================================
# EVENT: beforeReadFile — capture file reads
# ============================================================
handle_before_read_file() {
  local file_path
  file_path=$(echo "$INPUT" | jq -r '.file_path // ""')

  file_path=$(echo "$file_path" | sed "s|${CWD}/||")

  append_event "$(jq -cn \
    --arg ev "file_read" \
    --arg file "$file_path" \
    --arg ts "$TIMESTAMP" \
    --arg gen "$GENERATION_ID" \
    '{ev: $ev, file: $file, ts: $ts, generation_id: $gen}')"
}

# ============================================================
# EVENT: stop — generate session output
# ============================================================
handle_stop() {
  local branch head_sha dirty_count
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  head_sha=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
  dirty_count=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ' || echo "0")

  local started_at model
  if [ -f "$META_FILE" ]; then
    started_at=$(jq -r '.local_time // "unknown"' "$META_FILE")
    model=$(jq -r '.model // "cursor-agent"' "$META_FILE")
  else
    started_at="(unknown)"
    model="cursor-agent"
  fi

  local workspace_db tracking_db global_db
  workspace_db=$(resolve_workspace_db)
  tracking_db=$(resolve_tracking_db)
  global_db=$(resolve_global_db)

  if [ ! -f "$EVENTS_FILE" ] || [ ! -s "$EVENTS_FILE" ]; then
    cat > "$SESSION_MD" << MDEOF
# Session Log: $(basename "$CWD")

| Field | Value |
|-------|-------|
| Conversation ID | \`${CONVERSATION_ID}\` |
| Started | ${started_at} |
| Model | ${model} |
| Branch | \`${branch}\` @ \`${head_sha}\` |

---

_No events captured. Session log unavailable._
MDEOF
    return
  fi

  local pyscript
  pyscript=$(mktemp "${TMPDIR:-/tmp}/cursor-session-log-XXXX.py")
  trap "rm -f '$pyscript'" RETURN
  cat > "$pyscript" << 'PYEOF'
import json, sys, os, sqlite3, base64
from datetime import datetime

log_dir      = sys.argv[1]
cwd          = sys.argv[2]
conversation_id = sys.argv[3]
started_at   = sys.argv[4]
model        = sys.argv[5]
branch       = sys.argv[6]
head_sha     = sys.argv[7]
dirty_count  = sys.argv[8]
workspace_db = sys.argv[9]  if len(sys.argv) > 9  else ""
tracking_db  = sys.argv[10] if len(sys.argv) > 10 else ""
global_db    = sys.argv[11] if len(sys.argv) > 11 else ""

def rel(path):
    if path and path.startswith(cwd + "/"):
        return path[len(cwd) + 1:]
    return path or ""

def open_ro(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)

def decode_value(value):
    """Decode a DB value: JSON string, bytes, or base64-encoded JSON."""
    if value is None:
        return None
    if isinstance(value, bytes):
        try:
            return json.loads(value.decode("utf-8"))
        except Exception:
            pass
        try:
            return json.loads(base64.b64decode(value))
        except Exception:
            return None
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            pass
        try:
            return json.loads(base64.b64decode(value))
        except Exception:
            return None
    return value

# ---- Enrich from workspace state.vscdb (session metadata) ----
composer_meta = {}
if workspace_db and os.path.isfile(workspace_db):
    try:
        conn = open_ro(workspace_db)
        cur = conn.cursor()
        cur.execute("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
        row = cur.fetchone()
        if row:
            data = decode_value(row[0])
            if data:
                for c in data.get("allComposers", []):
                    if c.get("composerId") == conversation_id:
                        composer_meta = c
                        break
        conn.close()
    except Exception:
        pass

# ---- Enrich from ai-tracking DB (tldr, overview, model) ----
conversation_summary = {}
if tracking_db and os.path.isfile(tracking_db):
    try:
        conn = open_ro(tracking_db)
        cur = conn.cursor()
        cur.execute(
            "SELECT title, tldr, overview, model, mode FROM conversation_summaries WHERE conversationId = ?",
            (conversation_id,)
        )
        row = cur.fetchone()
        if row:
            conversation_summary = {
                "title": row[0], "tldr": row[1], "overview": row[2],
                "model": row[3], "mode": row[4],
            }
        conn.close()
    except Exception:
        pass

# ---- Pull full bubble conversation from global cursorDiskKV ----
# Structure:
#   composerData:<conv_id>  → { fullConversationHeadersOnly: [{bubbleId, type}, ...], ... }
#   bubbleId:<conv_id>:<bubble_id> → { type, text, codeBlocks, fileActions, timingInfo, ... }
#
# type == 1  → User message
# type != 1  → Assistant message
bubbles = []
if global_db and os.path.isfile(global_db):
    try:
        conn = open_ro(global_db)
        cur = conn.cursor()

        # Get ordered bubble headers
        cur.execute(
            "SELECT value FROM cursorDiskKV WHERE key = ?",
            (f"composerData:{conversation_id}",)
        )
        row = cur.fetchone()
        headers = []
        if row:
            data = decode_value(row[0])
            if data:
                headers = data.get("fullConversationHeadersOnly", [])

        # Fetch each bubble's content
        for header in headers:
            bubble_id = header.get("bubbleId", "")
            bubble_type = header.get("type")
            if not bubble_id:
                continue
            cur.execute(
                "SELECT value FROM cursorDiskKV WHERE key = ?",
                (f"bubbleId:{conversation_id}:{bubble_id}",)
            )
            brow = cur.fetchone()
            if not brow:
                continue
            bdata = decode_value(brow[0])
            if not bdata:
                continue

            role = "user" if bubble_type == 1 else "assistant"
            text = bdata.get("text", "")

            # Extract code blocks
            code_blocks = []
            for cb in bdata.get("codeBlocks", []):
                lang = cb.get("language", "")
                code = cb.get("code", "")
                if code:
                    code_blocks.append({"language": lang, "code": code})

            # Extract file actions
            file_actions = []
            for fa in bdata.get("fileActions", []):
                fa_type = fa.get("type", "")
                fa_path = fa.get("path", "")
                if fa_path:
                    file_actions.append({"type": fa_type, "path": fa_path})

            # Timing
            timing = bdata.get("timingInfo", {})
            ts_ms = timing.get("clientStartTime") or timing.get("clientEndTime")
            ts_str = ""
            if ts_ms and isinstance(ts_ms, (int, float)):
                ts_str = datetime.fromtimestamp(ts_ms / 1000).strftime("%Y-%m-%dT%H:%M:%SZ")

            bubbles.append({
                "bubble_id": bubble_id,
                "role": role,
                "text": text,
                "code_blocks": code_blocks,
                "file_actions": file_actions,
                "ts": ts_str,
            })

        conn.close()
    except Exception:
        pass

# Index bubbles by role sequence for turn correlation
user_bubbles    = [b for b in bubbles if b["role"] == "user"]
assistant_bubbles = [b for b in bubbles if b["role"] == "assistant"]

# ---- Override metadata from DB ----
conv_name = (
    composer_meta.get("name")
    or conversation_summary.get("title")
    or ""
)
conv_model = (
    conversation_summary.get("model")
    or model
)
conv_mode = (
    composer_meta.get("unifiedMode")
    or conversation_summary.get("mode")
    or ""
)
conv_created = composer_meta.get("createdAt")
if conv_created and isinstance(conv_created, (int, float)):
    started_at = datetime.fromtimestamp(conv_created / 1000).strftime("%Y-%m-%d %H:%M:%S")
context_pct   = composer_meta.get("contextUsagePercent")
lines_added   = composer_meta.get("totalLinesAdded", 0)
lines_removed = composer_meta.get("totalLinesRemoved", 0)
files_changed = composer_meta.get("filesChangedCount", 0)
conv_branch   = composer_meta.get("createdOnBranch", "")

# ---- Accumulate turns from .events.jsonl ----
turns = []

def new_turn(user_text, generation_id=None):
    return {
        "user": user_text,
        "generation_id": generation_id,
        "agent_response": "",
        "agent_thoughts": [],
        "edits": [],
        "reads": [],
        "commands": [],
        "events": [],
    }

current = new_turn(None)

for line in sys.stdin:
    try:
        entry = json.loads(line)
    except json.JSONDecodeError:
        continue

    ev = entry.get("ev")
    ts = entry.get("ts", "")

    if ev == "user_text":
        text = entry.get("text", "")
        if not text.strip():
            continue
        if current["user"] or current["events"]:
            turns.append(current)
        current = new_turn(text, entry.get("generation_id"))
        current["events"].append({"kind": "user_prompt", "text": text, "ts": ts})

    elif ev == "file_edit":
        f = rel(entry.get("file", ""))
        action = entry.get("action", "edit")
        if f and f not in current["edits"]:
            current["edits"].append(f)
        current["events"].append({"kind": "file_edit", "file": f, "action": action, "ts": ts})

    elif ev == "file_read":
        f = rel(entry.get("file", ""))
        if f and f not in current["reads"]:
            current["reads"].append(f)
        current["events"].append({"kind": "file_read", "file": f, "ts": ts})

    elif ev == "shell_command":
        cmd = entry.get("command", "")
        if cmd:
            current["commands"].append(cmd)
        current["events"].append({"kind": "shell_command", "command": cmd, "ts": ts})

    elif ev == "agent_response":
        text = entry.get("text", "")
        if text:
            current["agent_response"] = text
        current["events"].append({"kind": "agent_response", "text": text, "ts": ts})

    elif ev == "agent_thought":
        text = entry.get("text", "")
        if text:
            current.setdefault("agent_thoughts", []).append(text)
        current["events"].append({"kind": "agent_thought", "text": text, "ts": ts})

if current["user"] or current["events"]:
    turns.append(current)

# ---- Correlate bubble content into turns ----
# Match user bubbles to turns by text similarity, then pair with the
# following assistant bubble(s). Falls back gracefully if DB unavailable.
def bubble_for_turn(turn_idx):
    """Return (user_bubble, [assistant_bubbles]) for a turn index."""
    if turn_idx < len(user_bubbles):
        ub = user_bubbles[turn_idx]
        # Collect all assistant bubbles that follow this user bubble
        ub_pos = bubbles.index(ub)
        ab_list = []
        for b in bubbles[ub_pos + 1:]:
            if b["role"] == "assistant":
                ab_list.append(b)
            elif b["role"] == "user":
                break
        return ub, ab_list
    return None, []

# ---- Write per-turn files ----
turn_index = []

def group_by_ext(paths):
    groups = {}
    for p in paths:
        ext = os.path.splitext(p)[1] or "(no ext)"
        groups.setdefault(ext, []).append(p)
    return groups

for i, turn in enumerate(turns):
    num    = i + 1
    padded = f"{num:03d}"

    user_bubble, asst_bubbles = bubble_for_turn(i)

    # Prefer bubble text (richer) over hook-captured prompt when available
    user_text = (
        (user_bubble["text"] if user_bubble and user_bubble["text"] else None)
        or turn["user"]
        or ""
    )

    # Prefer hook-captured response (afterAgentResponse) — available mid-session.
    # Fall back to DB bubble extraction used at stop time.
    hook_response = turn.get("agent_response", "")
    asst_text = (
        hook_response
        or "\n\n".join(b["text"] for b in asst_bubbles if b["text"])
    )
    asst_code_blocks = [cb for b in asst_bubbles for cb in b["code_blocks"]]
    asst_file_actions = [fa for b in asst_bubbles for fa in b["file_actions"]]
    asst_thoughts = turn.get("agent_thoughts", [])

    # ---- turn-NNN.txt ----
    md_lines = [f"# Turn {num}", ""]

    # User block
    if user_text:
        md_lines.append("> **User**")
        md_lines.append(">")
        for line in user_text.splitlines():
            md_lines.append(f"> {line}" if line else ">")
        md_lines.append("")

    # Tool activity (from hook events)
    tool_lines = []
    for event in turn["events"]:
        kind = event["kind"]
        if kind == "user_prompt":
            pass
        elif kind == "file_edit":
            f = event.get("file", "")
            action = event.get("action", "edit")
            tool_lines.append(f"`{action.title()}` {f}")
        elif kind == "file_read":
            f = event.get("file", "")
            tool_lines.append(f"`Read` {f}")
        elif kind == "shell_command":
            cmd = event.get("command", "")
            if len(cmd) > 120:
                tool_lines.extend(["`Bash`", "```", cmd, "```"])
            else:
                tool_lines.append(f"`Bash` `{cmd}`")

    if tool_lines:
        md_lines.append("**Tool activity**")
        md_lines.append("")
        md_lines.extend(tool_lines)
        md_lines.append("")

    # Agent thoughts (reasoning steps, if captured)
    if asst_thoughts:
        md_lines.append("**Thoughts**")
        md_lines.append("")
        for thought in asst_thoughts:
            md_lines.append(f"_{thought}_")
            md_lines.append("")

    # Assistant response block
    if asst_text:
        md_lines.append("> **Assistant**")
        md_lines.append(">")
        for line in asst_text.splitlines():
            md_lines.append(f"> {line}" if line else ">")
        md_lines.append("")

    if asst_code_blocks:
        md_lines.append("**Code blocks**")
        md_lines.append("")
        for cb in asst_code_blocks:
            lang = cb.get("language", "")
            md_lines.append(f"```{lang}")
            md_lines.append(cb.get("code", ""))
            md_lines.append("```")
            md_lines.append("")

    if asst_file_actions:
        md_lines.append("**File actions**")
        md_lines.append("")
        for fa in asst_file_actions:
            md_lines.append(f"- `{fa['type']}` {fa['path']}")
        md_lines.append("")

    with open(os.path.join(log_dir, f"turn-{padded}.txt"), "w") as fh:
        fh.write("\n".join(md_lines))

    # ---- turn-NNN.json ----
    turn_json = {
        "turn": num,
        "user": user_text,
        "generation_id": turn["generation_id"],
        "assistant": {
            "text": asst_text,
            "thoughts": asst_thoughts,
            "code_blocks": asst_code_blocks,
            "file_actions": asst_file_actions,
            "source": "hook" if hook_response else "db",
        },
        "events": turn["events"],
        "files_edited": group_by_ext(turn["edits"]),
        "files_read": group_by_ext(turn["reads"]),
        "commands": turn["commands"],
    }

    with open(os.path.join(log_dir, f"turn-{padded}.json"), "w") as fh:
        json.dump(turn_json, fh, indent=2)

    user_preview = (user_text or "(no user message)")[:120]
    event_count  = len(turn["events"])
    turn_index.append({
        "num": num,
        "padded": padded,
        "user_preview": user_preview,
        "event_count": event_count,
        "edits": turn["edits"],
        "has_response": bool(asst_text),
    })

# ---- Write session.txt index ----
with open(os.path.join(log_dir, "session.txt"), "w") as fh:
    fh.write(f"# Session Log: {os.path.basename(cwd)}\n\n")
    fh.write("| Field | Value |\n")
    fh.write("|-------|-------|\n")
    fh.write(f"| Conversation ID | `{conversation_id}` |\n")
    if conv_name:
        fh.write(f"| Name | {conv_name} |\n")
    fh.write(f"| Started | {started_at} |\n")
    fh.write(f"| Model | {conv_model} |\n")
    if conv_mode:
        fh.write(f"| Mode | {conv_mode} |\n")
    fh.write(f"| Branch | `{conv_branch or branch}` @ `{head_sha}` |\n")
    fh.write(f"| Turns | {len(turn_index)} |\n")
    if files_changed:
        fh.write(f"| Files changed | {files_changed} |\n")
    if lines_added or lines_removed:
        fh.write(f"| Lines | +{lines_added} / -{lines_removed} |\n")
    if context_pct is not None:
        fh.write(f"| Context usage | {context_pct:.1f}% |\n")

    tldr = conversation_summary.get("tldr", "")
    if tldr:
        fh.write(f"\n> {tldr}\n")

    fh.write("\n---\n\n")
    fh.write("## Turns\n\n")

    for t in turn_index:
        edits_str = ", ".join(f"`{e}`" for e in t["edits"][:3])
        if len(t["edits"]) > 3:
            edits_str += f" +{len(t['edits'])-3} more"
        summary = f"{t['event_count']} events"
        if edits_str:
            summary += f" | {edits_str}"
        if t["has_response"]:
            summary += " | response captured"
        fh.write(f"- **[Turn {t['num']}](turn-{t['padded']}.txt)** — {t['user_preview']}\n")
        fh.write(f"  _{summary}_\n")

    fh.write("\n---\n\n")

    all_reads    = []
    all_edits    = []
    all_commands = []
    for turn in turns:
        all_reads.extend(turn["reads"])
        all_edits.extend(turn["edits"])
        all_commands.extend(turn["commands"])

    fh.write("## Exploration\n")
    fh.write("_Files read and commands executed (deduplicated)._\n\n")
    for r in sorted(set(all_reads)):
        fh.write(f"- READ `{r}`\n")
    fh.write("\n")

    fh.write("## Audit\n")
    fh.write("_Edits, commands, git activity._\n\n")
    for e in sorted(set(all_edits)):
        fh.write(f"- EDIT `{e}`\n")
    for cmd in all_commands:
        short = cmd[:120]
        meaningful = any(kw in short for kw in [
            "pytest", "cargo test", "ruff", "mypy", "npm test",
            "git log", "git diff", "git status", "git add", "git commit",
            "git merge", "caws ", "pip install", "make", "cargo build"
        ])
        if meaningful:
            fh.write(f"- BASH `{short}`\n")
    fh.write("\n")

    fh.write("## Session Snapshot\n\n")
    fh.write("| Field | Value |\n")
    fh.write("|-------|-------|\n")
    fh.write(f"| Branch | `{branch}` @ `{head_sha}` |\n")
    fh.write(f"| Dirty files | {dirty_count} |\n")
    fh.write(f"| Total turns | {len(turn_index)} |\n")
    fh.write(f"| Bubbles fetched | {len(bubbles)} |\n")

    overview = conversation_summary.get("overview", "")
    if overview:
        fh.write(f"\n## Overview\n\n{overview}\n")

PYEOF

  python3 "$pyscript" "$LOG_DIR" "$CWD" "$CONVERSATION_ID" "$started_at" "$model" \
    "$branch" "$head_sha" "$dirty_count" "$workspace_db" "$tracking_db" "$global_db" \
    < "$EVENTS_FILE"
}

# ============================================================
# Metadata capture (first invocation creates meta)
# ============================================================
ensure_meta() {
  if [ ! -f "$META_FILE" ]; then
    local full_time
    full_time=$(date +"%Y-%m-%d %H:%M:%S %Z")
    jq -cn \
      --arg cid "$CONVERSATION_ID" \
      --arg ts "$TIMESTAMP" \
      --arg lt "$full_time" \
      --arg model "cursor-agent" \
      --arg project "$(basename "$CWD")" \
      '{conversation_id: $cid, started_at: $ts, local_time: $lt, model: $model, project: $project}' \
      > "$META_FILE"
  fi
}

# ============================================================
# Agent registry heartbeat — register this agent with CAWS
# ============================================================
AGENTS_REGISTRY="${CWD}/.caws/agents.json"

heartbeat_agent() {
  [ "$CONVERSATION_ID" = "unknown" ] && return

  mkdir -p "$(dirname "$AGENTS_REGISTRY")"

  # Read existing registry or start fresh
  local registry
  if [ -f "$AGENTS_REGISTRY" ]; then
    registry=$(cat "$AGENTS_REGISTRY" 2>/dev/null || echo '{"version":1,"agents":{}}')
  else
    registry='{"version":1,"agents":{}}'
  fi

  # Prune stale entries (older than 30 minutes) and upsert this agent
  registry=$(echo "$registry" | python3 -c "
import json, sys
from datetime import datetime, timedelta, timezone

TTL = timedelta(minutes=30)
now = datetime.now(timezone.utc)
conv_id = '$CONVERSATION_ID'

data = json.load(sys.stdin)
agents = data.get('agents', {})

# Prune stale
pruned = {}
for sid, entry in agents.items():
    try:
        last = datetime.fromisoformat(entry['lastSeen'].replace('Z', '+00:00'))
        if now - last < TTL:
            pruned[sid] = entry
    except (KeyError, ValueError):
        pass

# Upsert current agent
existing = pruned.get(conv_id, {})
pruned[conv_id] = {
    'sessionId': conv_id,
    'platform': 'cursor',
    'model': existing.get('model'),
    'specId': existing.get('specId'),
    'ttl': 1800000,
    'firstSeen': existing.get('firstSeen', now.strftime('%Y-%m-%dT%H:%M:%SZ')),
    'lastSeen': now.strftime('%Y-%m-%dT%H:%M:%SZ'),
}

data['agents'] = pruned
json.dump(data, sys.stdout, indent=2)
" 2>/dev/null)

  [ -n "$registry" ] && echo "$registry" > "$AGENTS_REGISTRY"
}

remove_agent() {
  [ "$CONVERSATION_ID" = "unknown" ] && return
  [ ! -f "$AGENTS_REGISTRY" ] && return

  # Remove this agent from registry
  python3 -c "
import json, sys

conv_id = '$CONVERSATION_ID'
with open('$AGENTS_REGISTRY', 'r') as f:
    data = json.load(f)

agents = data.get('agents', {})
agents.pop(conv_id, None)
data['agents'] = agents

with open('$AGENTS_REGISTRY', 'w') as f:
    json.dump(data, f, indent=2)
" 2>/dev/null || true
}

# ============================================================
# DISPATCH
# ============================================================
ensure_meta

case "$HOOK_EVENT" in
  beforeSubmitPrompt)    handle_before_submit_prompt ;;
  afterFileEdit)         handle_after_file_edit ;;
  beforeShellExecution)  handle_before_shell_execution ;;
  beforeReadFile)        handle_before_read_file ;;
  afterAgentResponse)    handle_after_agent_response ;;
  afterAgentThought)     handle_after_agent_thought ;;
  stop)                  handle_stop; remove_agent ;;
  *)                     ;;
esac

# Heartbeat on every event (keeps TTL fresh while agent is active)
heartbeat_agent

# Always allow — this is observation only
echo '{"permission":"allow"}' 2>/dev/null || true
exit 0

