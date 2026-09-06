#!/usr/bin/env python3
"""Machine-level CAWS adapter entry point. No project authority is stored here."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

EVENTS = {
    'pre_tool_use': 'PreToolUse', 'post_tool_use': 'PostToolUse',
    'session_start': 'SessionStart', 'stop': 'Stop', 'pre_compact': 'PreCompact',
}
SURFACES = {'codex', 'claude-code', 'kimi-code', 'qwen-code', 'zcode', 'opencode', 'dsh'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def confined(root, relative):
    parts = Path(relative).parts
    if not parts or Path(relative).is_absolute() or '..' in parts:
        raise ValueError(f'Path escapes root: {relative}')
    cursor = root
    if cursor.is_symlink():
        raise ValueError(f'Symlink root: {cursor}')
    for part in parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise ValueError(f'Symlink path: {cursor}')
    return cursor


def git(directory, *args):
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    result = subprocess.run(['git', '-C', str(directory), *args], env=env,
                            capture_output=True, text=True, check=False)
    if result.returncode:
        raise ValueError(f'Cannot resolve project: {result.stderr.strip()}')
    return result.stdout.strip()


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in SURFACES or sys.argv[2] not in EVENTS:
        raise ValueError('Usage: caws-hook <surface> <pre_tool_use|post_tool_use|session_start|stop|pre_compact>')
    surface, event = sys.argv[1:]
    home = Path(os.environ.get('CAWS_HOME', str(Path.home() / '.caws')))
    if not home.is_absolute():
        raise ValueError('CAWS_HOME must be absolute')
    pointer = json.loads(confined(home, 'state/adapter-runtime.json').read_bytes())
    identity = pointer.get('digest')
    if pointer.get('version') != 1 or not isinstance(identity, str) or not re.fullmatch('[a-f0-9]{64}', identity):
        raise ValueError('Malformed machine runtime pointer')
    runtime = confined(home, f'lib/runtimes/{identity}')
    manifest_bytes = confined(runtime, 'manifest.json').read_bytes()
    if digest(manifest_bytes) != identity:
        raise ValueError('Runtime manifest integrity failure')
    manifest = json.loads(manifest_bytes)
    if not isinstance(manifest, dict):
        raise ValueError('Malformed runtime manifest')
    for relative, expected in manifest.items():
        if digest(confined(runtime, relative).read_bytes()) != expected:
            raise ValueError(f'Runtime modified: {relative}')
    raw = sys.stdin.buffer.read()
    payload = json.loads(raw or b'{}')
    if not isinstance(payload, dict):
        raise ValueError('Hook input must be an object')
    candidate = os.environ.get('CAWS_PROJECT_DIR') or payload.get('cwd') or os.getcwd()
    try:
        root = Path(git(candidate, 'rev-parse', '--show-toplevel'))
    except ValueError:
        # A normal directory outside Git has no project hooks. A broken Git or
        # CAWS ancestor is an infrastructure failure, never a quiet admission.
        probe = Path(candidate).absolute()
        if any((p / '.git').exists() or (p / '.caws').exists() for p in [probe, *probe.parents]):
            raise
        return 0
    common = Path(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
    canonical = common.parent
    policy_file = confined(canonical, '.caws/hooks/adapter-policy.json')
    if not policy_file.exists():
        # Global harness hooks must be quiet outside governed projects. An
        # existing CAWS project without adoption must remain visible, not green.
        if not (canonical / '.caws').exists():
            return 0
        raise ValueError('Project requires adapter adoption: caws init adapters adopt --agent-surface ' + surface)
    policy = json.loads(policy_file.read_bytes())
    if not isinstance(policy, dict) or policy.get('version') != 1 or set(policy) != {'version', 'surfaces'}:
        raise ValueError('Malformed project adapter policy')
    if not isinstance(policy['surfaces'], dict):
        raise ValueError('Surfaces must be a map')
    config = policy['surfaces'].get(surface)
    if config is None:
        raise ValueError(f'Project requires adoption for {surface}')
    if not isinstance(config, dict) or set(config) != {'events', 'libraries'} or not isinstance(config['events'], dict):
        raise ValueError('Unknown adapter policy fields')
    entry = config['events'].get(event)
    if entry is None:
        return 0
    if set(entry) != {'hooks_dir', 'handlers'}:
        raise ValueError('Unknown event policy fields')
    hooks = confined(canonical, entry['hooks_dir'])
    handlers = entry['handlers']
    if not isinstance(handlers, list):
        raise ValueError('Handlers must be an ordered array')
    for handler in handlers:
        if not isinstance(handler, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+\.sh(?: [A-Za-z0-9_.:/-]+)*', handler):
            raise ValueError(f'Invalid handler entry: {handler}')
        target = confined(hooks, handler.split(' ')[0])
        if not target.is_file() or not os.access(target, os.X_OK):
            raise ValueError(f'Required project handler missing or not executable: {target}')
    libraries = config['libraries']
    if not isinstance(libraries, dict):
        raise ValueError('Libraries must be a path map')
    for name, relative in libraries.items():
        if not re.fullmatch(r'[A-Za-z0-9_.-]+', name) or not confined(canonical, relative).is_file():
            raise ValueError(f'Invalid project library: {name}')
    user_lib = confined(home, f'surfaces/{surface}/lib')
    if user_lib.exists():
        for library in user_lib.iterdir():
            if not confined(home, str(library.relative_to(home))).is_file():
                raise ValueError(f'Invalid user adapter library: {library}')
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    # Hook parsing must run for THIS payload, never trust inherited parsed data.
    for key in list(env):
        if key.startswith('HOOK_'):
            del env[key]
    env.update(CAWS_HOME=str(home), CAWS_PROJECT_DIR=str(root),
               CAWS_MACHINE_POLICY_ROOT=str(canonical),
               CAWS_MACHINE_LIBRARIES=json.dumps(libraries),
               CAWS_ADAPTER_RUNTIME_DIGEST=identity,
               CAWS_AGENT_SURFACE=surface)
    payload['hook_event_name'] = EVENTS[event]
    result = subprocess.run(['/bin/bash', str(runtime / 'dispatch.sh'), surface, event, str(hooks), *handlers],
                            cwd=root, env=env, input=json.dumps(payload).encode(),
                            stdout=subprocess.PIPE, check=False)
    sys.stdout.buffer.write(result.stdout)
    return result.returncode


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError, TypeError, AttributeError) as error:
        message = 'CAWS machine adapter: ' + str(error)
        print('[caws machine adapter] ' + message, file=sys.stderr)
        print(json.dumps({'decision': 'block', 'reason': message}))
        sys.exit(2)
