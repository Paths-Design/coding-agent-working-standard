#!/usr/bin/env python3
"""Deliberately break selected invariants in disposable template copies.

This is a bounded sensitivity experiment, not an exhaustive mutation score.
Every mutant must have a green matched control; a setup failure is inconclusive.
Retain stdout, stderr, commands, source hashes, and installed scenario artifacts.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

REPO = Path(__file__).resolve().parents[2]
TEMPLATES = REPO / 'packages/caws-cli/templates/hook-packs'
TEST = REPO / 'packages/caws-cli/tests/hooks/pytest/test_machine_hook_selection.py'
CASES = [
    ('handler-attribution', 'shared/session_log_renderer.py',
     '"status": hook_handler_status(row, stdout),',
     '"status": "block" if row.get("adapter_exit_code") == 2 else row.get("status"),',
     'fidelity:test_mixed_handler_decisions_keep_per_handler_attribution'),
    ('codex-default', 'codex/hooks/lib/parse-input.sh',
     '_caws_write_session_envelope codex', '_caws_write_session_envelope claude-code',
     'test_surface_compatibility_helpers_preserve_defaults_without_bootstrap_flags'),
    ('renderer-lock', 'shared/session_log_renderer.py', 'fcntl.flock(lock, fcntl.LOCK_EX)',
     'pass  # sensitivity mutant: no writer serialization',
     'fidelity:test_concurrent_renderers_lock_before_reading_and_leave_one_current_generation'),
    ('source-digest', 'runtime/caws-hook.py', "source_sha256=source['sha256']",
     "source_sha256='0' * 64", 'test_description_is_read_only_and_matches_executed_override'),
    ('denial-priority', 'shared/lib/run-handlers.sh', "block|deny) printf '3\\n' ;;",
     "block) printf '3\\n' ;;", 'test_all_surface_runners_preserve_refusals_and_record_raw_exit'),
    ('cache-symlink', 'shared/lib/session-cache.sh', 'os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW',
     'os.O_RDONLY | os.O_DIRECTORY', 'test_recording_failure_cannot_turn_a_refusal_into_admission'),
]


def execute(directory, templates, test):
    directory.mkdir(parents=True)
    env = dict(os.environ, CAWS_TEST_TEMPLATES_ROOT=str(templates),
               CAWS_EXPERIMENT_ARTIFACTS=str(directory / 'artifacts'), PYTHONDONTWRITEBYTECODE='1')
    if test.startswith('fidelity:'):
        command=[sys.executable,str(TEST.with_name('test_installed_session_fidelity.py')),
                 'InstalledSessionFidelity.'+test.split(':',1)[1],'-v']
    else:
        command = [sys.executable, str(TEST), 'MachineHookSelection.' + test, '-v']
    try:
        result = subprocess.run(command, env=env, cwd=REPO, capture_output=True, timeout=180)
    except subprocess.TimeoutExpired as error:
        (directory / 'stdout').write_bytes(error.stdout or b'')
        (directory / 'stderr').write_bytes(error.stderr or b'')
        return {'argv': command, 'exit_code': None, 'inconclusive': 'timeout'}
    (directory / 'stdout').write_bytes(result.stdout)
    (directory / 'stderr').write_bytes(result.stderr)
    report = {'argv': command, 'exit_code': result.returncode, 'stderr_path': str(directory / 'stderr'),
              'artifacts': str(directory / 'artifacts')}
    (directory / 'command.json').write_text(json.dumps(report, indent=2) + '\n')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--case', choices=[case[0] for case in CASES], action='append')
    args = parser.parse_args()
    base = args.output.resolve()
    base.mkdir(parents=True, exist_ok=False)
    results = []
    for name, relative, original, mutation, test in CASES:
        if args.case and name not in args.case: continue
        control = execute(base / name / 'control', TEMPLATES, test)
        with tempfile.TemporaryDirectory(prefix='caws-hook-mutant-') as temporary:
            copied = Path(temporary) / 'templates'
            shutil.copytree(TEMPLATES, copied, ignore=shutil.ignore_patterns(
                'node_modules', '__pycache__', '.DS_Store', 'tmp', '.caws'))
            target = copied / relative
            source = target.read_text()
            if source.count(original) != 1:
                raise ValueError('mutation anchor is not unique: ' + name)
            altered = source.replace(original, mutation)
            target.write_text(altered)
            outcome = execute(base / name / 'mutant', copied, test)
        # Match the decision-bearing assertion; arbitrary setup assertions are inconclusive.
        stderr = (base / name / 'mutant/stderr').read_text()
        expected_assertion = {
            'handler-attribution': "self.assertEqual({name:item['status'] for name,item in contexts.items()},",
            'codex-default': "self.assertEqual(json.loads(artifact.read_text())['platform'], expected)",
            'renderer-lock': 'second renderer read inputs while first held the lock',
            'source-digest': "self.assertEqual(record['source_sha256'], selected['handlers'][0]['sha256'])",
            'denial-priority': 'self.assertEqual(denied.returncode, 2, denied.stderr)',
            'cache-symlink': 'self.assertEqual(list(outside.iterdir()), [])',
        }[name]
        killed = (control['exit_code'] == 0 and outcome['exit_code'] == 1
                  and 'AssertionError' in stderr and expected_assertion in stderr)
        results.append({'name': name, 'source': relative, 'test': test,
                        'original_sha256': hashlib.sha256(source.encode()).hexdigest(),
                        'mutant_sha256': hashlib.sha256(altered.encode()).hexdigest(),
                        'control': control, 'mutant': outcome, 'killed': killed})
        print(json.dumps(results[-1]), flush=True)
    summary = {'schema': 'caws.hook_sensitivity.v1', 'cases': results,
               'limits': ['Selected defects only; no exhaustive mutation-score claim.',
                          'Assertion sensitivity does not establish correctness of its oracle.']}
    (base / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    return 0 if all(row['killed'] for row in results) else 1


if __name__ == '__main__':
    sys.exit(main())
