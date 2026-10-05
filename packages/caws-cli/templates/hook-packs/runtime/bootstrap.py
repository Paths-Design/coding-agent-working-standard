#!/usr/bin/env python3
"""Version-1 bootstrap. The active pointer selects an immutable runtime snapshot.

Keep this protocol fixed: verify the selected driver, then execute it with the
selected digest pinned in-process. Runtime behavior belongs in caws-hook.py.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import sys

# The only event where a bootstrap-scope failure may refuse. A refusal is
# legitimate only when the blocked party can answer it: withholding a write
# leaves the agent able to stop writing, while withholding the session's exit
# leaves it no move at all -- it cannot act and cannot leave, and no CAWS-side
# release exists. The driver draws the same line, but it cannot help here: by
# the time anything below fails, the driver has not been reached.
ENFORCING_EVENTS = {'pre_tool_use'}
EVENTS = {'pre_tool_use', 'post_tool_use', 'session_start', 'stop', 'pre_compact', 'session_end'}
SURFACES = {'codex', 'claude-code', 'kimi-code', 'qwen-code', 'zcode', 'opencode', 'dsh'}


class InvocationError(ValueError):
    """Malformed invocation is not a native lifecycle configuration failure."""


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


def main():
    # Validate before touching the pointer: the driver cannot classify bad
    # arguments when bootstrap resolution fails first. Keep this vocabulary
    # aligned with the driver (the installed-entry contract tests compare it).
    flags = sys.argv[3:]
    if (len(sys.argv) < 3 or len(flags) != len(set(flags)) or
            set(flags) - {'--system', '--describe'} or
            sys.argv[1] not in SURFACES or sys.argv[2] not in EVENTS):
        raise InvocationError('Usage: caws-hook <surface> <pre_tool_use|post_tool_use|session_start|stop|pre_compact|session_end> [--system] [--describe]')
    home = Path(os.environ.get('CAWS_HOME', str(Path.home() / '.caws')))
    if not home.is_absolute():
        raise ValueError('CAWS_HOME must be absolute')
    pointer = json.loads(confined(home, 'state/adapter-runtime.json').read_bytes())
    identity = pointer.get('digest')
    if pointer.get('version') != 1 or not isinstance(identity, str) or not re.fullmatch('[a-f0-9]{64}', identity):
        raise ValueError('Malformed machine runtime pointer')
    runtime = confined(home, f'lib/runtimes/{identity}')
    manifest_bytes = confined(runtime, 'manifest.json').read_bytes()
    if hashlib.sha256(manifest_bytes).hexdigest() != identity:
        raise ValueError('Runtime manifest integrity failure')
    manifest = json.loads(manifest_bytes)
    driver = confined(runtime, 'launcher.py')
    if not isinstance(manifest, dict) or hashlib.sha256(driver.read_bytes()).hexdigest() != manifest.get('launcher.py'):
        raise ValueError('Runtime driver integrity failure')
    # No environment override can supply this value. A concurrent pointer swap
    # cannot mix the selected driver with another snapshot's adapter libraries.
    runpy.run_path(str(driver), run_name='__main__',
                   init_globals={'_CAWS_RUNTIME_DIGEST': identity})


if __name__ == '__main__':
    try:
        main()
    except InvocationError as error:
        print('[caws machine adapter] ' + str(error), file=sys.stderr)
        sys.exit(2)
    except (ValueError, OSError, KeyError, TypeError, AttributeError) as error:
        message = 'CAWS machine adapter: ' + str(error)
        # Always loud on stderr. Degrading is not the same as going quiet, and
        # an operator who never hears about a broken pointer cannot repair it.
        print('[caws machine adapter] ' + message, file=sys.stderr)
        # Nothing here is a handler's verdict. Either the runtime could not be
        # resolved, or the driver failed before it could answer for itself --
        # a driver that DID answer exits through SystemExit, which this clause
        # does not catch. So there is no decision to preserve, only a
        # configuration fault to report.
        #
        # Read the event defensively: argv may itself be what went wrong.
        if (sys.argv[2] if len(sys.argv) > 2 else '') not in ENFORCING_EVENTS:
            sys.exit(0)
        print(json.dumps({'decision': 'block', 'reason': message}))
        sys.exit(2)
