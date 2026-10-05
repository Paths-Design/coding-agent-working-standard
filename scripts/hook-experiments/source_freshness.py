"""Behavioral source-freshness probe for a disposable renderer copy only."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

MARKER = '.qualification-source-execution.json'
OLD, NEW = 'source-a', 'source-b'
PROBE = '''

# Qualification instrumentation: this exists only in the disposable copy.
_qualification_original_render = render_session
def render_session(**kwargs):
    result = _qualification_original_render(**kwargs)
    import json as _json, os as _os
    from pathlib import Path as _Path
    (_Path(kwargs['log_dir']) / '.qualification-source-execution.json').write_text(
        _json.dumps({'version': 'source-a', 'pid': _os.getpid()}))
    return result
'''


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def instrument(source):
    source.write_text(source.read_text() + PROBE)


def marker(logs):
    path = logs / MARKER
    try:
        row = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        raise RuntimeError(f'missing or malformed execution marker: {path}') from error
    if not isinstance(row, dict) or row.get('version') not in (OLD, NEW) or not isinstance(row.get('pid'), int):
        raise RuntimeError(f'invalid execution marker: {path}')
    return row


def qualify_source_change(source, logs, root, render_kwargs, request):
    """Compare a warm caller with an independent fresh interpreter.

    request(label) must dispatch to the already-started candidate. A transport
    acknowledgment alone cannot decide whether changed code executed.
    """
    before = marker(logs)
    if before['version'] != OLD:
        raise RuntimeError('cold control did not execute the original probe')
    stat = source.stat()
    old_hash = digest(source)
    old_literal, new_literal = "'version': 'source-a'", "'version': 'source-b'"
    text = source.read_text()
    if text.count(old_literal) != 1:
        raise RuntimeError('source probe is not uniquely addressable')
    source.write_text(text.replace(old_literal, new_literal))
    os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    fresh = root / 'fresh-source-control'
    fresh.mkdir()
    kwargs = dict(render_kwargs, log_dir=str(fresh))
    argv = [sys.executable, '-c',
            'import importlib.util,json,sys; '
            'sys.path.insert(0,sys.argv[1]); '
            'spec=importlib.util.spec_from_file_location("source_control",sys.argv[2]); '
            'module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); '
            'module.render_session(**json.loads(sys.argv[3]))',
            str(source.parent), str(source), json.dumps(kwargs)]
    result = subprocess.run(argv, capture_output=True, timeout=30,
                            env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1'))
    (root / 'fresh-source.stdout').write_bytes(result.stdout)
    (root / 'fresh-source.stderr').write_bytes(result.stderr)
    (root / 'fresh-source.command.json').write_text(json.dumps({
        'argv':argv, 'exit_code':result.returncode}, indent=2))
    if result.returncode != 0:
        raise RuntimeError('fresh source control failed; inspect fresh-source.stderr')
    control = marker(fresh)
    if control['version'] != NEW or control['pid'] == before['pid']:
        raise RuntimeError('independent fresh control did not execute changed source')
    # The marker is written only after render_session returns. Also retain and
    # parse its product: a wrapper that never rendered a turn is insufficient.
    json.loads((fresh / 'turn-001.json').read_text())
    response = request('source-change-same-mtime')
    if not response.startswith('ok '):
        raise RuntimeError('warm source request failed; inspect its response')
    after = marker(logs)
    report = {
        'scenario':'source-change-same-mtime', 'response':response.strip(),
        'original_sha256':old_hash, 'changed_sha256':digest(source),
        'mtime_preserved':source.stat().st_mtime_ns == stat.st_mtime_ns,
        'size_preserved':source.stat().st_size == stat.st_size,
        'cold_execution':before, 'fresh_execution':control, 'warm_execution':after,
        'fresh_artifact':str(fresh / MARKER), 'warm_artifact':str(logs / MARKER),
        'fresh_command':str(root / 'fresh-source.command.json'),
        'counterexample':after['version'] != NEW,
        'boundary':'executed renderer marker; warm stale result includes skipped rendering',
    }
    (root / 'source-freshness.json').write_text(json.dumps(report, indent=2) + '\n')
    return report
