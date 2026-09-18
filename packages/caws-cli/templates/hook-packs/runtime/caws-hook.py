#!/usr/bin/env python3
"""Machine-level CAWS adapter entry point. No project authority is stored here."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import uuid

EVENTS = {
    'pre_tool_use': 'PreToolUse', 'post_tool_use': 'PostToolUse',
    'session_start': 'SessionStart', 'stop': 'Stop', 'pre_compact': 'PreCompact',
    # Session teardown, distinct from stop (which fires once per turn).
    'session_end': 'SessionEnd',
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


def settle_message_offers(manifest_path, env, cwd, adapter_handoff, blocked):
    """Settle exact offers after adapter stdout handoff; never claim visibility."""
    latest = {}
    try:
        for line in Path(manifest_path).read_text().splitlines():
            record = json.loads(line)
            if (isinstance(record, dict) and
                    isinstance(record.get('offer_id'), str) and
                    isinstance(record.get('recipient'), str) and
                    record.get('action') in {'selected', 'released'}):
                latest[record['offer_id']] = record
    except (OSError, ValueError, TypeError):
        return
    caws_bin = env.get('CAWS_BIN', 'caws')
    for record in latest.values():
        outcome = ('delivered' if adapter_handoff and not blocked and
                   record['action'] == 'selected' else 'released')
        try:
            settled = subprocess.run(
                [caws_bin, 'message', 'settle', record['offer_id'],
                 '--me', record['recipient'], '--outcome', outcome, '--json'],
                cwd=cwd, env=env, stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE, text=True, check=False)
            if settled.returncode:
                print('[caws machine adapter] message offer settlement deferred to expiry: ' +
                      settled.stderr.strip(), file=sys.stderr)
        except OSError as error:
            print('[caws machine adapter] message offer settlement deferred to expiry: ' +
                  str(error), file=sys.stderr)


REPO_HOOK_POLICY = '.caws/hooks/hook-policy.json'

# Handlers a REPO-tier policy may never disable or remap. Membership is earned
# by being load-bearing for the policy's own reviewability: protected-paths.sh
# is what keeps hook-policy.json agent-unwritable (a policy able to authorize
# its own amendment is not a policy), block-dangerous.sh closes the same
# circularity through the Bash channel (it can DESTROY the tree it must not
# EDIT), and agent-register.sh carries the drift advisory that reports a stale
# policy. scope-guard.sh is deliberately absent — it is the guard repos
# legitimately need to extend, and fencing it is what pushes them to fork.
#
# The floor binds the REPO tier only. Machine state keeps its unrestricted
# power: an operator changing their own machine is the sanctioned escape hatch
# and affects only that machine, whereas a committed team file reaches every
# clone and CI.
REPO_POLICY_FLOOR = ('protected-paths.sh', 'block-dangerous.sh', 'agent-register.sh')

HANDLER_NAME = r'[A-Za-z0-9_.-]+\.sh'
HANDLER_ENTRY = HANDLER_NAME + r'(?: [A-Za-z0-9_.:/-]+)*'


def _repo_surface(raw, where):
    """Validate one surface block. Raises on anything not plainly admissible."""
    if not isinstance(raw, dict) or not set(raw).issubset(
            {'disabled', 'extensions', 'handlers', 'libraries', 'forks'}):
        raise ValueError(f'{REPO_HOOK_POLICY}: {where} admits only disabled, extensions, '
                         'handlers, libraries and forks')
    parsed = {'disabled': {}, 'extensions': {}, 'handlers': {}, 'libraries': {}}
    for event, values in (raw.get('disabled') or {}).items():
        if event not in EVENTS or not isinstance(values, list) or any(
                not isinstance(v, str) or not re.fullmatch(HANDLER_NAME, v) for v in values):
            raise ValueError(f'{REPO_HOOK_POLICY}: {where}.disabled.{event} must be a list of handler names')
        for value in values:
            if value in REPO_POLICY_FLOOR:
                raise ValueError(f'{REPO_HOOK_POLICY}: {where}.disabled.{event} may not disable '
                                 f'{value}: it is on the repo-policy floor, the set of handlers that '
                                 'keep this policy reviewable and its staleness observable')
        parsed['disabled'][event] = list(values)
    for event, extensions in (raw.get('extensions') or {}).items():
        if event not in EVENTS or not isinstance(extensions, list):
            raise ValueError(f'{REPO_HOOK_POLICY}: {where}.extensions.{event} must be a list')
        entries = []
        for extension in extensions:
            if (not isinstance(extension, dict)
                    or not set(extension).issubset({'handler', 'before', 'reason'})
                    or not isinstance(extension.get('handler'), str)
                    or not re.fullmatch(HANDLER_ENTRY, extension['handler'])
                    or (extension.get('before') is not None
                        and (not isinstance(extension['before'], str)
                             or not re.fullmatch(HANDLER_NAME, extension['before'])))):
                raise ValueError(f'{REPO_HOOK_POLICY}: {where}.extensions.{event} has a malformed entry')
            # A reason is mandatory so "the guard plane was changed" is a
            # reviewable artifact rather than an undocumented diff.
            if not isinstance(extension.get('reason'), str) or len(extension['reason'].strip()) < 12:
                raise ValueError(f'{REPO_HOOK_POLICY}: {where}.extensions.{event} requires a reason '
                                 'of at least 12 characters')
            entries.append({'handler': extension['handler'], 'before': extension.get('before')})
        parsed['extensions'][event] = entries
    for key in ('handlers', 'libraries'):
        for name, relative in (raw.get(key) or {}).items():
            if not re.fullmatch(HANDLER_NAME, name) or not isinstance(relative, str) or not relative:
                raise ValueError(f'{REPO_HOOK_POLICY}: {where}.{key} has a malformed entry: {name}')
            # Replace-with-a-stub is observationally equivalent to disable, so
            # the floor gates BOTH keys; gating only `disabled` would leave the
            # bypass one key away.
            if key == 'handlers' and name in REPO_POLICY_FLOOR:
                raise ValueError(f'{REPO_HOOK_POLICY}: {where}.handlers may not replace {name}: '
                                 'it is on the repo-policy floor')
            # agent-surface.sh and runtime-paths.sh ARE the mechanism that
            # resolves an override, so overriding them is a bootstrap cycle.
            if key == 'libraries' and name in ('agent-surface.sh', 'runtime-paths.sh'):
                raise ValueError(f'{REPO_HOOK_POLICY}: {where}.libraries may not override {name} — '
                                 'it is the mechanism that resolves overrides')
            if relative.startswith('/') or '..' in relative.split('/') or re.search(r'[*?\[\]]', relative):
                raise ValueError(f'{REPO_HOOK_POLICY}: {where}.{key}.{name} must be a contained, '
                                 'repo-relative path without glob metacharacters')
            parsed[key][name] = relative
    return parsed


def repo_configuration(canonical, surface):
    """The committed repo tier: `.caws/hooks/hook-policy.json`, merged over `default`.

    Absent file is the identity, never an error — a repo that never opts in must
    resolve byte-identically to stock. Anything present but not plainly valid
    RAISES: validation is all-or-nothing, because a partial application leaves a
    repo believing a policy is in force while half of it was silently dropped.
    Discarding is always the stricter direction here (every repo-tier key is
    additive over a floor), so failing closed costs nothing in enforcement.
    """
    policy_file = confined(canonical, REPO_HOOK_POLICY)
    empty = {'disabled': {}, 'extensions': {}, 'handlers': {}, 'libraries': {}}
    if not policy_file.is_file():
        return empty
    try:
        document = json.loads(policy_file.read_bytes())
    except ValueError as error:
        raise ValueError(f'{REPO_HOOK_POLICY} is not valid JSON: {error}')
    if not isinstance(document, dict) or not set(document).issubset({'version', 'surfaces', 'guards'}):
        raise ValueError(f'{REPO_HOOK_POLICY} admits only version, surfaces and guards')
    if document.get('version') != 1:
        raise ValueError(f'{REPO_HOOK_POLICY} version must be 1')
    # `guards` is validated as a container but not consumed here. All three
    # top-level keys are admitted in v1 deliberately: runtime validators assert
    # exact key sets, so introducing `guards` later would hard-block every repo
    # pinned to an older runtime.
    if not isinstance(document.get('guards', {}), dict):
        raise ValueError(f'{REPO_HOOK_POLICY} guards must be an object')
    surfaces = document.get('surfaces') or {}
    if not isinstance(surfaces, dict):
        raise ValueError(f'{REPO_HOOK_POLICY} surfaces must be an object')
    # Validate EVERY declared surface, not just the one in play: a document is
    # accepted or rejected as a whole, so a repo cannot discover a malformed
    # block only once someone runs the harness it belongs to.
    parsed = {name: _repo_surface(block, f'surfaces.{name}') for name, block in surfaces.items()}
    base, named = parsed.get('default', empty), parsed.get(surface, empty)
    merged = {'disabled': {}, 'extensions': {}, 'handlers': {}, 'libraries': {}}
    for key in ('disabled', 'extensions'):
        for event in set(base[key]) | set(named[key]):
            merged[key][event] = list(base[key].get(event, [])) + list(named[key].get(event, []))
    for key in ('handlers', 'libraries'):
        merged[key] = {**base[key], **named[key]}
    return merged


def apply_tier(handlers, tier_config, event, tier, tiers):
    """Subtract `disabled` then splice `extensions`, recording each entry's tier."""
    disabled = tier_config['disabled'].get(event, [])
    handlers = [h for h in handlers if h.split(' ')[0] not in disabled]
    for extension in tier_config['extensions'].get(event, []):
        name = extension['handler'].split(' ')[0]
        if any(h.split(' ')[0] == name for h in handlers):
            # Fail closed rather than splice twice: a guard that runs twice
            # returns two verdicts for one call.
            raise ValueError(f'{tier} extension {name} is already in the chain for {event}')
        before = extension['before']
        index = next((i for i, h in enumerate(handlers) if h.split(' ')[0] == before),
                     None) if before else len(handlers)
        if index is None:
            raise ValueError(f'{tier} extension anchor is absent: {before}')
        handlers.insert(index, extension['handler'])
        tiers[extension['handler']] = tier
    return handlers


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
    for name, extensions in config['extensions'].items():
        if name not in EVENTS or not isinstance(extensions, list):
            raise ValueError('Malformed system extensions')
        for extension in extensions:
            if not isinstance(extension, dict) or set(extension) != {'handler', 'before'} or not isinstance(extension['handler'], str) or not re.fullmatch(r'[A-Za-z0-9_.-]+\.sh(?: [A-Za-z0-9_.:/-]+)*', extension['handler']) or (extension['before'] is not None and (not isinstance(extension['before'], str) or not re.fullmatch(r'[A-Za-z0-9_.-]+\.sh', extension['before']))):
                raise ValueError('Malformed system extension')
    # Tier order is the authority model, not a preference. The repo file is the
    # TEAM's decision — committed, present in every clone and in CI — so it
    # resolves first and forms the shared baseline. Machine state is THIS
    # OPERATOR's decision and resolves second. The asymmetry is deliberate: an
    # operator can locally silence a team extension, but a committed team file
    # cannot reach into an operator's local additions.
    repo = repo_configuration(canonical, surface)
    tiers = {}
    handlers = apply_tier(handlers, repo, event, 'repo-policy', tiers)
    handlers = apply_tier(handlers, config, event, 'machine-policy', tiers)
    overrides = {}
    # Machine overrides are applied last so they win on a shared basename,
    # matching the tier order above.
    for tier, table in (('repo-policy', repo['handlers']), ('machine-policy', config['handlers'])):
        for name, relative in table.items():
            if not re.fullmatch(r'[A-Za-z0-9_.-]+\.sh', name) or not isinstance(relative, str):
                raise ValueError('Malformed system handler override')
            target = confined(canonical, relative)
            if not target.is_file() or not os.access(target, os.X_OK):
                raise ValueError(f'Required extension missing or not executable: {target}')
            overrides[name] = str(target)
            tiers[name] = tier
    return runtime, handlers, {**repo['libraries'], **config['libraries']}, overrides, tiers


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


def describe_selection(identity, canonical, runtime, home, surface, event, hooks,
                       handlers, libraries, overrides, adapter, system, inspect_local=True,
                       tiers=None):
    """Describe the same resolved selection execution uses, without invoking it.

    Digests witness bytes at inspection time. They do not prove execution or
    recursively discover libraries sourced by arbitrary project shell code.
    """
    entries = []
    for entry in handlers:
        name, *arguments = entry.split(' ')
        target = Path(overrides[name]) if name in overrides else confined(hooks, name)
        selected_hash = digest(target.read_bytes())
        local = canonical / '.caws/hooks' / name
        local_repair = None
        if inspect_local and local.is_file() and local.resolve() != target.resolve():
            local_hash = digest(local.read_bytes())
            if local_hash != selected_hash:
                local_repair = {'path': str(local), 'sha256': local_hash}
        entries.append({'entry': entry, 'arguments': arguments,
                        'path': str(target), 'sha256': selected_hash,
                        'kind': 'project-override' if name in overrides else
                                ('stock' if hooks == runtime else 'project-policy'),
                        # WHICH TIER put this handler here. `kind` answers "what
                        # file is this"; `tier` answers "who decided it runs" —
                        # the question a reader of a chain actually has, and the
                        # one that distinguishes a committed team decision from
                        # an operator's local one. Keyed on the full entry for a
                        # spliced extension (which may carry arguments) and on
                        # the basename for an override.
                        'tier': (tiers or {}).get(entry) or (tiers or {}).get(name) or 'stock',
                        'unselected_local_difference': local_repair})
    library_dirs = [runtime / 'lib', runtime / 'surfaces' / surface / 'lib',
                    home / 'surfaces' / surface / 'lib']
    names = set(libraries)
    for directory in library_dirs:
        if directory.is_dir():
            names.update(p.name for p in directory.iterdir() if p.is_file())
    resolutions = {}
    for name in sorted(names):
        candidates = ([(confined(canonical, libraries[name]), 'project')] if name in libraries else []) + [
            (home / 'surfaces' / surface / 'lib' / name, 'user'),
            (runtime / 'surfaces' / surface / 'lib' / name, 'surface'),
            (runtime / 'lib' / name, 'shared')]
        for target, kind in candidates:
            if target.is_file():
                resolutions[name] = {'path': str(target), 'sha256': digest(target.read_bytes()), 'kind': kind}
                break
    return {'schema': 'caws.hook_selection.v1', 'runtime_digest': identity,
            'project': str(canonical), 'surface': surface, 'event': event,
            'configuration': 'system' if system else 'project-policy',
            'handlers': entries,
            'library_resolution': resolutions,
            'project_libraries': {name: {'path': str(confined(canonical, relative)),
                                        'sha256': digest(confined(canonical, relative).read_bytes())}
                                  for name, relative in libraries.items()},
            'transcript_adapter': ({'path': adapter, 'sha256': digest(Path(adapter).read_bytes())}
                                   if adapter else None),
            'limits': ['Selection is not execution.',
                       'Project scripts may source further dependencies.',
                       'Library resolution describes caws_source_lib lookups, not observed imports.',
                       'Reprieves and runtime disable lists can skip selected handlers.']}


def retain_execution_records(path, canonical, selection, invocation_id, raw, result):
    """Append occurrence-qualified handler observations to each resolved session.

    Single append writes avoid interleaving ordinary concurrent records. These
    operational artifacts confer no authority. Report I/O failure rather than
    disguising absent records as a successful capture.
    """
    try:
        selected = {row['path']: row for row in selection['handlers']}
        lines = Path(path).read_text().splitlines()
        if selected and not lines:
            raise ValueError('selected runner produced no execution records')
        for number, line in enumerate(lines):
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError('execution record must be an object')
            sid = row.get('session_id', '')
            if not isinstance(sid, str) or not re.fullmatch(r'[A-Za-z0-9_.@:-]+', sid) or sid in {'.', '..'}:
                raise ValueError('execution record has no safe resolved session identity')
            source = selected.get(row.get('path'))
            if source is None:
                raise ValueError('execution record names an unselected handler')
            row.update(schema='caws.hook_execution.v1', invocation_id=invocation_id,
                       handler_index=number, runtime_digest=selection['runtime_digest'],
                       surface=selection['surface'], source_sha256=source['sha256'],
                       source_digest_boundary='before_dispatch',
                       observation_boundary='handler_return', delivery='not_observed',
                       input_sha256=digest(raw),
                       adapter_exit_code=result.returncode if result is not None else None)
            target = confined(canonical, f'.caws/sessions/{sid}/hook-events.jsonl')
            target.parent.mkdir(parents=True, exist_ok=True)
            data = (json.dumps(row, separators=(',', ':')) + '\n').encode()
            fd = os.open(target, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            try:
                if os.write(fd, data) != len(data):
                    raise OSError('partial execution record append')
            finally:
                os.close(fd)
    except (OSError, ValueError, TypeError) as error:
        print('[caws execution record] incomplete: ' + str(error), file=sys.stderr)


def main():
    flags = sys.argv[3:]
    system_entry = '--system' in flags
    describe = '--describe' in flags
    if (len(sys.argv) < 3 or len(flags) != len(set(flags)) or
            set(flags) - {'--system', '--describe'} or
            sys.argv[1] not in SURFACES or sys.argv[2] not in EVENTS):
        raise ValueError('Usage: caws-hook <surface> <pre_tool_use|post_tool_use|session_start|stop|pre_compact|session_end> [--system] [--describe]')
    surface, event = sys.argv[1:3]
    def inactive(reason):
        if describe:
            print(json.dumps({'schema': 'caws.hook_selection.v1', 'status': 'inactive',
                              'surface': surface, 'event': event, 'reason': reason,
                              'handlers': []}, sort_keys=True))
        return 0
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
    raw = b'{}' if describe else sys.stdin.buffer.read()
    payload = json.loads(raw or b'{}')
    if not isinstance(payload, dict):
        raise ValueError('Hook input must be an object')
    candidate = payload.get('cwd') or os.environ.get('CAWS_PROJECT_DIR') or os.getcwd()
    try:
        root = Path(git(candidate, 'rev-parse', '--show-toplevel'))
    except (ValueError, OSError) as error:
        # Without a resolvable Git root there is no canonical project authority
        # to enforce, so the adapter must not block the surface it observes.
        # A directory with no .git/.caws ancestor is quietly inactive; one with
        # a broken .git or a CAWS ancestor fails open loudly so the operator
        # can see governance was not applied.
        probe = Path(candidate).absolute()
        if any((p / '.git').exists() or (p / '.caws').exists() for p in [probe, *probe.parents]):
            print(f'[caws machine adapter] project could not be resolved ({error}); '
                  f'continuing without CAWS governance in {probe}', file=sys.stderr)
        return inactive('outside a resolvable Git project')
    common = Path(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
    canonical = common.parent
    known_project = confined(home, 'state/projects/' + digest(str(canonical).encode()) + '.json').exists()
    if not (canonical / '.caws').exists():
        if known_project:
            raise ValueError('Adopted project governance is missing')
        return inactive('project governance is absent')
    # Native user and project hooks are additive. The explicit user transport
    # waits for the one-time project registration retirement; old cached local
    # adapter entries still execute their policy during the transition.
    if system_entry and legacy_native_registered(canonical, surface, event):
        return inactive('legacy native registration remains selected')
    # Session caches alone never opt a repository into governance. Legacy
    # governance remains on its existing harness integration until migration;
    # a user-level registration cannot reinterpret that authority schema.
    if system_entry and not known_project and (not (canonical / '.caws/policy.yaml').is_file() or not (canonical / '.caws/specs').is_dir() or (canonical / '.caws/working-spec.yaml').exists()):
        if event == 'session_start' and (canonical / '.caws/working-spec.yaml').exists():
            print('[caws system runtime] Legacy governance remains on its existing integration; migrate governance before system adoption.', file=sys.stderr)
        return inactive('project governance requires migration')
    system = system_configuration(home, canonical, runtime, surface, event)
    if system_entry and system is None:
        return inactive('system surface is disabled or project policy remains selected')
    if system is not None:
        if not confined(canonical, '.caws/policy.yaml').is_file() or not confined(canonical, '.caws/specs').is_dir() or (canonical / '.caws/working-spec.yaml').exists():
            raise ValueError('Project governance requires migration before system hooks can run')
        hooks, handlers, libraries, overrides, tiers = system
    else:
        hooks, handlers, libraries = project_configuration(canonical, surface, event)
        overrides = {}
        tiers = {}
        if hooks is None:
            return inactive('project policy has no handler chain for this event')
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
    selection = describe_selection(
        identity, canonical, runtime, home, surface, event, hooks, handlers,
        libraries, overrides, env['CAWS_SESSION_TRANSCRIPT_ADAPTER'], system is not None,
        inspect_local=describe, tiers=tiers)
    if describe:
        print(json.dumps(selection, indent=2, sort_keys=True))
        return 0
    settlement_file = tempfile.NamedTemporaryFile(
        prefix='caws-hook-offers-', suffix='.jsonl', delete=False)
    settlement_file.close()
    env['CAWS_HOOK_SETTLEMENT_FILE'] = settlement_file.name
    execution_file = tempfile.NamedTemporaryFile(prefix='caws-hook-execution-', suffix='.jsonl', delete=False)
    execution_file.close()
    env['CAWS_HOOK_EXECUTION_FILE'] = execution_file.name
    invocation_id = str(uuid.uuid4())
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    payload['hook_event_name'] = EVENTS[event]
    result = None
    adapter_handoff = False
    try:
        result = subprocess.run(['/bin/bash', str(runtime / 'dispatch.sh'), surface, event, str(hooks), *handlers],
                                cwd=root, env=env, input=json.dumps(payload).encode(),
                                stdout=subprocess.PIPE, check=False)
        if surface == 'codex':
            emit_codex_result(event, result, identity)
        else:
            sys.stdout.buffer.write(result.stdout)
        sys.stdout.buffer.flush()
        adapter_handoff = True
    finally:
        retain_execution_records(execution_file.name, canonical, selection, invocation_id, raw, result)
        if result is not None:
            settle_message_offers(
                settlement_file.name, env, root, adapter_handoff,
                result.returncode == 2)
        try:
            Path(settlement_file.name).unlink()
            Path(execution_file.name).unlink()
        except OSError:
            pass
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
