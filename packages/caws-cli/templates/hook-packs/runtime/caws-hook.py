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


def emit_codex_result(event, result, identity):
    """Codex exit-2 enforcement reads stderr, not the JSON on stdout.

    Keep the shared runner's exit/JSON contract, and supply the native blocking
    channel even for a bare exit 2. Stop also requires structured stdout; plain
    lifecycle CLI observations become system messages, never continuation votes.
    """
    text = result.stdout.decode('utf-8', errors='replace').strip()
    parsed = True
    try:
        output = json.loads(text) if text else None
    except ValueError:
        parsed = False
        output = None
        if event == 'stop' and result.returncode == 0 and text.startswith(('{', '[')):
            raise ValueError('Malformed Codex Stop JSON') from None
    if result.returncode == 2:
        reason = ''
        if isinstance(output, dict):
            specific = output.get('hookSpecificOutput')
            candidates = [output.get('reason'), output.get('stopReason')]
            if isinstance(specific, dict):
                candidates.insert(0, specific.get('permissionDecisionReason'))
            reason = next((value for value in candidates if isinstance(value, str) and value.strip()), '')
        reason = reason or text or f'CAWS {event} blocked with exit code 2'
        print(f'[caws machine adapter {identity}] {reason}', file=sys.stderr)
    if event == 'stop' and result.returncode == 0 and text:
        if not parsed:
            print(json.dumps({'systemMessage': text}))
            return
        if not isinstance(output, dict):
            raise ValueError('Malformed Codex Stop JSON: expected an object')
    sys.stdout.buffer.write(result.stdout)


def system_configuration(home, canonical, runtime, surface, event):
    """Machine settings contain extensions, never a frozen copy of stock policy."""
    settings = confined(home, f'surfaces/{surface}/settings.json')
    if not settings.exists():
        return None
    enabled = json.loads(settings.read_bytes())
    if not isinstance(enabled, dict) or not {'version', 'enabled'}.issubset(enabled) or not set(enabled).issubset({'version', 'enabled', 'native_config_target'}) or (type(enabled['version']) is not int or enabled['version'] != 1) or not isinstance(enabled['enabled'], bool) or ('native_config_target' in enabled and (not isinstance(enabled['native_config_target'], str) or not Path(enabled['native_config_target']).is_absolute())):
        raise ValueError('Malformed system surface settings')
    if not enabled['enabled']:
        return None
    key = digest(str(canonical).encode())
    project_file = confined(home, f'state/projects/{key}.json')
    config = {'disabled': {}, 'extensions': {}, 'handlers': {}, 'libraries': {}}
    if project_file.exists():
        project = json.loads(project_file.read_bytes())
        if not isinstance(project, dict) or set(project) != {'version', 'root', 'surfaces'} or (type(project['version']) is not int or project['version'] != 1) or project['root'] != str(canonical) or not isinstance(project['surfaces'], dict):
            raise ValueError('Malformed system project settings')
        if surface not in project['surfaces']:
            raise ValueError(f'System project requires migration for {surface}')
        config = project['surfaces'][surface]
    elif (canonical / '.caws/hooks').exists():
        if confined(canonical, '.caws/hooks/adapter-policy.json').is_file():
            return None  # Existing adapter-only entry stays in charge until migration.
        # Existing executable customizations must be classified once. Globally
        # installing CAWS never implicitly discards an existing guard chain.
        raise ValueError('Legacy project hooks require one-time system migration: caws init adapters migrate --agent-surface ' + surface)
    if not isinstance(config, dict) or set(config) != {'disabled', 'extensions', 'handlers', 'libraries'} or any(not isinstance(value, dict) for value in config.values()):
        raise ValueError('Malformed system project surface')
    defaults = json.loads(confined(runtime, 'system-policy.json').read_bytes())
    if defaults.get('version') != 1 or not isinstance(defaults.get('events'), dict):
        raise ValueError('Malformed system default policy')
    handlers = list(defaults['events'][event])
    for name, values in config['disabled'].items():
        if name not in EVENTS or not isinstance(values, list) or any(not isinstance(v, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+\.sh', v) for v in values):
            raise ValueError('Malformed disabled system handlers')
    disabled = config['disabled'].get(event, [])
    handlers = [h for h in handlers if h.split(' ')[0] not in disabled]
    for name, extensions in config['extensions'].items():
        if name not in EVENTS or not isinstance(extensions, list):
            raise ValueError('Malformed system extensions')
        for extension in extensions:
            if not isinstance(extension, dict) or set(extension) != {'handler', 'before'} or not isinstance(extension['handler'], str) or not re.fullmatch(r'[A-Za-z0-9_.-]+\.sh(?: [A-Za-z0-9_.:/-]+)*', extension['handler']) or (extension['before'] is not None and (not isinstance(extension['before'], str) or not re.fullmatch(r'[A-Za-z0-9_.-]+\.sh', extension['before']))):
                raise ValueError('Malformed system extension')
            if name != event:
                continue
            before = extension['before']
            index = next((i for i, h in enumerate(handlers) if h.split(' ')[0] == before), None) if before else len(handlers)
            if index is None:
                raise ValueError(f'System extension anchor is absent: {before}')
            handlers.insert(index, extension['handler'])
    overrides = {}
    for name, relative in config['handlers'].items():
        if not re.fullmatch(r'[A-Za-z0-9_.-]+\.sh', name) or not isinstance(relative, str):
            raise ValueError('Malformed system handler override')
        target = confined(canonical, relative)
        if not target.is_file() or not os.access(target, os.X_OK):
            raise ValueError(f'Required extension missing or not executable: {target}')
        overrides[name] = str(target)
    return runtime, handlers, config['libraries'], overrides


def legacy_native_registered(canonical, surface, event):
    vendor = {'codex': '.codex', 'claude-code': '.claude', 'qwen-code': '.qwen'}.get(surface)
    if vendor is None:
        return False
    file = confined(canonical, vendor + ('/hooks.json' if surface == 'codex' else '/settings.json'))
    if not file.exists():
        return False
    config = json.loads(file.read_bytes())
    groups = config.get('hooks', {}).get(EVENTS[event], [])
    if not isinstance(groups, list):
        raise ValueError('Malformed legacy native registration')
    pattern = r'(?:/bin/caws-hook|\.caws/hooks/[^\s]+\.sh|\.(?:codex|claude|qwen)/hooks/(?:(?:caws_dispatch|dispatch)/[^\s]+\.sh|session-log\.sh|caws-qwen-hook\.sh))'
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get('hooks'), list):
            raise ValueError('Malformed legacy native hook group')
        if group.get('enabled') is False:
            continue
        for hook in group['hooks']:
            if isinstance(hook, dict) and hook.get('enabled') is not False and isinstance(hook.get('command'), str) and re.search(pattern, hook['command']):
                return True
    return False


def main():
    system_entry = len(sys.argv) == 4 and sys.argv[3] == '--system'
    if (len(sys.argv) != 3 and not system_entry) or sys.argv[1] not in SURFACES or sys.argv[2] not in EVENTS:
        raise ValueError('Usage: caws-hook <surface> <pre_tool_use|post_tool_use|session_start|stop|pre_compact>')
    surface, event = sys.argv[1:3]
    home = Path(os.environ.get('CAWS_HOME', str(Path.home() / '.caws')))
    if not home.is_absolute():
        raise ValueError('CAWS_HOME must be absolute')
    # The stable bootstrap pins its selection in-process, not in an inherited
    # environment variable. Retain standalone invocation for the legacy layout.
    identity = globals().get('_CAWS_RUNTIME_DIGEST')
    if identity is None:
        pointer = json.loads(confined(home, 'state/adapter-runtime.json').read_bytes())
        if pointer.get('version') != 1:
            raise ValueError('Malformed machine runtime pointer')
        identity = pointer.get('digest')
    if not isinstance(identity, str) or not re.fullmatch('[a-f0-9]{64}', identity):
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
    candidate = payload.get('cwd') or os.environ.get('CAWS_PROJECT_DIR') or os.getcwd()
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
    known_project = confined(home, 'state/projects/' + digest(str(canonical).encode()) + '.json').exists()
    if not (canonical / '.caws').exists():
        if known_project:
            raise ValueError('Adopted project governance is missing')
        return 0
    # Native user and project hooks are additive. The explicit user transport
    # waits for the one-time project registration retirement; old cached local
    # adapter entries still execute their policy during the transition.
    if system_entry and legacy_native_registered(canonical, surface, event):
        return 0
    # Session caches alone never opt a repository into governance. Legacy
    # governance remains on its existing harness integration until migration;
    # a user-level registration cannot reinterpret that authority schema.
    if system_entry and not known_project and (not (canonical / '.caws/policy.yaml').is_file() or not (canonical / '.caws/specs').is_dir() or (canonical / '.caws/working-spec.yaml').exists()):
        if event == 'session_start' and (canonical / '.caws/working-spec.yaml').exists():
            print('[caws system runtime] Legacy governance remains on its existing integration; migrate governance before system adoption.', file=sys.stderr)
        return 0
    system = system_configuration(home, canonical, runtime, surface, event)
    if system_entry and system is None:
        return 0
    if system is not None:
        if not confined(canonical, '.caws/policy.yaml').is_file() or not confined(canonical, '.caws/specs').is_dir() or (canonical / '.caws/working-spec.yaml').exists():
            raise ValueError('Project governance requires migration before system hooks can run')
        hooks, handlers, libraries, overrides = system
    else:
        hooks, handlers, libraries = project_configuration(canonical, surface, event)
        overrides = {}
        if hooks is None:
            return 0
    if not isinstance(handlers, list):
        raise ValueError('Handlers must be an ordered array')
    for handler in handlers:
        if not isinstance(handler, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+\.sh(?: [A-Za-z0-9_.:/-]+)*', handler):
            raise ValueError(f'Invalid handler entry: {handler}')
        name = handler.split(' ')[0]
        target = Path(overrides[name]) if name in overrides else confined(hooks, name)
        if not target.is_file() or not os.access(target, os.X_OK):
            raise ValueError(f'Required handler missing or not executable: {target}')
    if not isinstance(libraries, dict):
        raise ValueError('Libraries must be a path map')
    for name, relative in libraries.items():
        if name in {'agent-surface.sh', 'runtime-paths.sh'}:
            raise ValueError(f'Bootstrap library cannot be overridden: {name}')
        if not re.fullmatch(r'[A-Za-z0-9_.-]+', name) or not isinstance(relative, str) or not confined(canonical, relative).is_file():
            raise ValueError(f'Invalid project library: {name}')
    user_lib = confined(home, f'surfaces/{surface}/lib')
    if user_lib.exists():
        for library in user_lib.iterdir():
            if not confined(home, str(library.relative_to(home))).is_file():
                raise ValueError(f'Invalid user adapter library: {library}')
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    for key in list(env):
        if key.startswith('HOOK_'):
            del env[key]
    env.update(CAWS_HOME=str(home), CAWS_PROJECT_DIR=str(root),
               CAWS_MACHINE_POLICY_ROOT=str(canonical),
               CAWS_MACHINE_LIBRARIES=json.dumps(libraries),
               CAWS_MACHINE_HANDLERS=json.dumps(overrides),
               CAWS_SYSTEM_RUNTIME='1' if system is not None else '0',
               CAWS_ADAPTER_RUNTIME_DIGEST=identity,
               CAWS_AGENT_SURFACE=surface)
    if system is not None:
        project_key = digest(str(canonical).encode())
        env['CAWS_MACHINE_LOG_DIR'] = str(confined(home, f'state/projects/{project_key}/logs/{surface}'))
    # Harness-owned transcript normalization follows the same explicit
    # project, user, shipped-adapter priority as shell adapter libraries.
    adapter_name = 'session-transcript.py'
    adapter_candidates = ([confined(canonical, libraries[adapter_name])] if adapter_name in libraries else []) + [
        confined(home, f'surfaces/{surface}/lib/{adapter_name}'),
        confined(runtime, f'surfaces/{surface}/lib/{adapter_name}'),
    ]
    env['CAWS_SESSION_TRANSCRIPT_ADAPTER'] = next((str(p) for p in adapter_candidates if p.is_file()), '')
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    payload['hook_event_name'] = EVENTS[event]
    result = subprocess.run(['/bin/bash', str(runtime / 'dispatch.sh'), surface, event, str(hooks), *handlers],
                            cwd=root, env=env, input=json.dumps(payload).encode(),
                            stdout=subprocess.PIPE, check=False)
    if surface == 'codex':
        emit_codex_result(event, result, identity)
    else:
        sys.stdout.buffer.write(result.stdout)
    return result.returncode


def project_configuration(canonical, surface, event):
    """Compatibility for the earlier project-policy adoption contract."""
    policy_file = confined(canonical, '.caws/hooks/adapter-policy.json')
    if not policy_file.exists():
        # Global harness hooks must be quiet outside governed projects. An
        # existing CAWS project without adoption must remain visible, not green.
        if not (canonical / '.caws').exists():
            return None, [], {}
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
        return None, [], {}
    if set(entry) != {'hooks_dir', 'handlers'}:
        raise ValueError('Unknown event policy fields')
    hooks = confined(canonical, entry['hooks_dir'])
    handlers = entry['handlers']
    return hooks, handlers, config['libraries']


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError, TypeError, AttributeError) as error:
        message = 'CAWS machine adapter: ' + str(error)
        print('[caws machine adapter] ' + message, file=sys.stderr)
        print(json.dumps({'decision': 'block', 'reason': message}))
        sys.exit(2)
