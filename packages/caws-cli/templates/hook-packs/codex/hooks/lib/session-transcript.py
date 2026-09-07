# CAWS-MANAGED-HOOK
# hook_pack: codex
# hook_pack_version: 1
# caws_min_major: 11
# edit_stance: YOURS TO EDIT. Maintain this adapter in the Codex harness,
#   preserve project customizations and verify native rollout behavior. The
#   managed marker identifies the baseline; do not weaken guards to bypass them.
"""Codex rollout adapter for CAWS's surface-neutral session renderer.

Response items are the durable conversation stream. event_msg mirrors are
deliberately ignored so one human message cannot become two CAWS turns.
Only visible messages and tool records are projected; reasoning items and
system/developer instructions are not session conversation content.
"""
import json
import re


def parse_transcript_events(transcript_path):
    events = []
    with open(transcript_path, encoding='utf-8') as source:
        for line in source:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if not isinstance(row, dict) or row.get('type') != 'response_item':
                continue
            item = row.get('payload')
            if not isinstance(item, dict):
                continue
            ts = row.get('timestamp')
            kind = item.get('type')
            if kind == 'message':
                role = item.get('role')
                if role not in ('user', 'assistant') or item.get('channel') == 'analysis':
                    continue
                content = item.get('content')
                if not isinstance(content, list):
                    continue
                text = '\n'.join(block['text'] for block in content if isinstance(block, dict)
                                 and block.get('type') in ('input_text', 'output_text', 'text')
                                 and isinstance(block.get('text'), str))
                if text:
                    events.append({'ev': 'user_text' if role == 'user' else 'assistant_text', 'text': text, 'ts': ts})
            elif kind in ('function_call', 'custom_tool_call'):
                name = item.get('name', '')
                raw = item.get('arguments', item.get('input', ''))
                try:
                    args = json.loads(raw) if isinstance(raw, str) else raw
                except ValueError:
                    args = {'input': raw}
                if not isinstance(args, dict):
                    args = {'input': args}
                if name in ('exec_command', 'functions.exec_command', 'shell_command'):
                    name = 'Bash'
                    args = {**args, 'command': args.get('cmd', args.get('command', ''))}
                events.append({'ev': 'tool_use', 'name': name, 'id': item.get('call_id', ''), 'input': args, 'ts': ts})
            elif kind in ('function_call_output', 'custom_tool_call_output'):
                output = item.get('output', '')
                if not isinstance(output, str):
                    output = json.dumps(output)
                status = re.search(r'Process exited with code (\d+)', output)
                events.append({'ev': 'tool_result', 'id': item.get('call_id', ''), 'content': output,
                               'is_error': bool(status and status[1] != '0'), 'ts': ts})
    return events
