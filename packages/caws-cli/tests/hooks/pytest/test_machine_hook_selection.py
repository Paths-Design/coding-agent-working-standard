"""Exercise the installed bootstrap, retaining artifacts when requested.

CAWS_EXPERIMENT_ARTIFACTS names scratch storage outside the source checkout.
The executable under test is installed by the real CAWS runtime installer.
"""
import hashlib
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

PACKAGE = Path(__file__).resolve().parents[3]
TEMPLATES = Path(os.environ.get('CAWS_TEST_TEMPLATES_ROOT', str(PACKAGE / 'templates/hook-packs')))


class MachineHookSelection(unittest.TestCase):
    def setUp(self):
        retained = os.environ.get('CAWS_EXPERIMENT_ARTIFACTS')
        if retained:
            Path(retained).mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.mkdtemp(prefix='selection-', dir=retained)
        if not retained:
            self.addCleanup(__import__('shutil').rmtree, self.directory)
        # Git reports the physical canonical path (macOS /tmp is /private/tmp).
        # Project registration keys must name that root, just as migration does.
        self.root = Path(self.directory).resolve()
        self.home, self.repo = self.root / 'machine', self.root / 'repo'
        self.surface = 'codex'
        self.repo.mkdir()
        self.env = {'PATH': os.environ['PATH'], 'HOME': str(self.root / 'user'),
                    'CAWS_HOME': str(self.home), 'CAWS_PROJECT_DIR': str(self.repo),
                    'PYTHONDONTWRITEBYTECODE': '1'}
        init = subprocess.run(['git', 'init', '-q', '-b', 'main', str(self.repo)],
                              capture_output=True, env=self.env)
        self.assertEqual(init.returncode, 0, init.stderr)
        install = subprocess.run(['node', '-e',
            'const m=require(process.argv[1]); console.log(JSON.stringify(m.installMachineRuntime('
            '{home:process.argv[2],templatesRoot:process.argv[3]})));',
            str(PACKAGE / 'dist/init/machine-adapters'), str(self.home),
            str(TEMPLATES)], capture_output=True, env=self.env)
        (self.root / 'install.stdout').write_bytes(install.stdout)
        (self.root / 'install.stderr').write_bytes(install.stderr)
        self.assertEqual(install.returncode, 0, install.stderr)
        pointer = json.loads((self.home / 'state/adapter-runtime.json').read_text())
        self.runtime = self.home / 'lib/runtimes' / pointer['digest']
        defaults = json.loads((self.runtime / 'system-policy.json').read_text())['events']
        (self.repo / '.caws/specs').mkdir(parents=True)
        (self.repo / '.caws/policy.yaml').write_text('version: 1\n')
        hooks = self.repo / '.caws/hooks'
        hooks.mkdir()
        self.marker = hooks / 'marker.sh'
        self.marker.write_text('#!/bin/bash\nprintf "invoked\\n" >> "$CAWS_PROJECT_DIR/marker.log"\n')
        self.marker.chmod(0o755)
        self.config = {'disabled': {event: [h.split()[0] for h in handlers]
                                    for event, handlers in defaults.items()},
                       'extensions': {'pre_tool_use': [{'handler': 'marker.sh', 'before': None}]},
                       'handlers': {'marker.sh': '.caws/hooks/marker.sh'}, 'libraries': {}}
        settings = self.home / 'surfaces/codex/settings.json'
        settings.parent.mkdir(parents=True, exist_ok=True)
        settings.write_text(json.dumps({'version': 1, 'enabled': True}))
        self.project_file = self.home / 'state/projects' / (
            hashlib.sha256(str(self.repo).encode()).hexdigest() + '.json')
        self.configure()

    def configure(self):
        self.project_file.parent.mkdir(parents=True, exist_ok=True)
        self.project_file.write_text(json.dumps({'version': 1, 'root': str(self.repo),
                                                'surfaces': {self.surface: self.config}}))

    def invoke(self, label, *flags, session='selection-session'):
        command = ['python3', str(self.home / 'bin/caws-hook'), self.surface,
                   'pre_tool_use', '--system', *flags]
        result = subprocess.run(command, cwd=self.repo, env=self.env, capture_output=True,
                                input=json.dumps({'session_id': session, 'tool_name': 'Read'}).encode())
        (self.root / (label + '.stdout')).write_bytes(result.stdout)
        (self.root / (label + '.stderr')).write_bytes(result.stderr)
        (self.root / (label + '.command.json')).write_text(json.dumps(
            {'argv': command, 'exit_code': result.returncode, 'cwd': str(self.repo)}, indent=2))
        return result

    def test_session_end_is_a_dispatchable_event_with_its_own_handler_policy(self):
        # SESSION-LOG-STEERING-USAGE-SIGNALS-001 A4. session_end is a NEW
        # lifecycle event, so three things must line up or the handler is
        # unreachable: the launcher accepts the argument, the installed
        # runtime snapshot carries a dispatcher for it, and system-policy.json
        # names its default handlers. Asserting only the first would pass with
        # nothing wired behind it.
        policy = json.loads((self.runtime / 'system-policy.json').read_text())['events']
        self.assertIn('session_end', policy)
        self.assertIn('session-log.sh', policy['session_end'])
        # session_end seals; it must NOT inherit stop's rendering fan-out.
        self.assertNotIn('plan-transcript-finalize.sh', policy['session_end'])

        described = subprocess.run(
            ['python3', str(self.home / 'bin/caws-hook'), self.surface,
             'session_end', '--system', '--describe'],
            cwd=self.repo, env=self.env, capture_output=True,
            input=json.dumps({'session_id': 'selection-session',
                              'reason': 'other'}).encode())
        self.assertEqual(described.returncode, 0, described.stderr)
        selection = json.loads(described.stdout)
        self.assertEqual(selection['event'], 'session_end')

    def test_an_unknown_lifecycle_event_is_still_refused(self):
        # Guard against the widening above being a hole: the launcher accepts
        # exactly the declared events, not any string.
        result = subprocess.run(
            ['python3', str(self.home / 'bin/caws-hook'), self.surface,
             'session_ended', '--system', '--describe'],
            cwd=self.repo, env=self.env, capture_output=True, input=b'{}')
        self.assertNotEqual(result.returncode, 0)

    def test_description_is_read_only_and_matches_executed_override(self):
        before = {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        description = self.invoke('describe', '--describe')
        self.assertEqual(description.returncode, 0, description.stderr)
        selected = json.loads(description.stdout)
        self.assertEqual([(h['path'], h['kind']) for h in selected['handlers']],
                         [(str(self.marker), 'project-override')])
        self.assertEqual(selected['handlers'][0]['sha256'],
                         hashlib.sha256(self.marker.read_bytes()).hexdigest())
        self.assertEqual(selected['library_resolution']['run-handlers.sh']['path'],
                         str(self.runtime / 'surfaces/codex/lib/run-handlers.sh'))
        self.assertFalse((self.repo / 'marker.log').exists())
        for path, data in before.items():
            self.assertEqual((self.root / path).read_bytes(), data, path)
        self.assertEqual(set(before), {str(p.relative_to(self.root)) for p in self.root.rglob('*')
                                      if p.is_file() and not p.name.startswith('describe.')})
        executed = self.invoke('execute')
        self.assertEqual(executed.returncode, 0, executed.stderr)
        self.assertEqual((self.repo / 'marker.log').read_text(), 'invoked\n')
        records = (self.repo / '.caws/sessions/selection-session/hook-events.jsonl').read_text().splitlines()
        self.assertEqual(len(records), 1)
        record = json.loads(records[0])
        self.assertEqual({k: record[k] for k in ('handler', 'status', 'exit_code', 'session_id')},
                         {'handler': 'marker.sh', 'status': 'completed', 'exit_code': 0,
                          'session_id': 'selection-session'})
        self.assertEqual(record['source_sha256'], selected['handlers'][0]['sha256'])
        self.assertEqual(record['runtime_digest'], selected['runtime_digest'])

    def test_stock_selection_reports_unselected_local_difference(self):
        self.config['disabled']['pre_tool_use'].remove('cwd-guard.sh')
        local = self.repo / '.caws/hooks/cwd-guard.sh'
        local.write_text('#!/bin/bash\nexit 99\n')
        local.chmod(0o755)
        self.configure()
        result = self.invoke('unselected', '--describe')
        self.assertEqual(result.returncode, 0, result.stderr)
        selected = json.loads(result.stdout)['handlers'][0]
        self.assertEqual(selected['path'], str(self.runtime / 'cwd-guard.sh'))
        self.assertEqual(selected['kind'], 'stock')
        self.assertEqual(selected['unselected_local_difference'],
                         {'path': str(local), 'sha256': hashlib.sha256(local.read_bytes()).hexdigest()})
        executed = self.invoke('stock-execute')
        self.assertEqual(executed.returncode, 0, executed.stderr)
        self.assertEqual((self.repo / 'marker.log').read_text(), 'invoked\n')

    def test_surface_compatibility_helpers_preserve_defaults_without_bootstrap_flags(self):
        codex_parser = self.runtime / 'surfaces/codex/lib/parse-input.sh'
        env = dict(self.env, CAWS_SHARED_LIB_DIR=str(self.runtime / 'lib'))
        for label, flags, expected in [('default', {}, 'codex'),
                                       ('explicit', {'CAWS_PLATFORM_FLAG':'dsh'}, 'dsh')]:
            argv = ['/bin/bash', '-c',
                    'source "$1"; HOOK_SESSION_ID="$2"; HOOK_CWD="$3"; _write_durable_session_envelope',
                    '-', str(codex_parser), label, str(self.repo)]
            result = subprocess.run(argv, cwd=self.repo, env=dict(env, **flags), capture_output=True)
            artifact = self.repo / '.caws/sessions' / label / '.session-envelope.json'
            (self.root / (label + '-platform.command.json')).write_text(json.dumps({
                'argv':argv, 'exit_code':result.returncode, 'stderr':result.stderr.decode(),
                'artifact':str(artifact)}, indent=2))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(artifact.read_text())['platform'], expected)

    def test_kimi_compatibility_runner_promotes_errors_without_surface_flags(self):
        kimi_runner = self.runtime / 'surfaces/kimi-code/lib/run-handlers.sh'
        env = dict(self.env, CAWS_SHARED_LIB_DIR=str(self.runtime / 'lib'))
        handlers = self.root / 'exit-handlers'
        handlers.mkdir()
        for code in (0,1,2):
            handler = handlers / ('exit-' + str(code) + '.sh')
            handler.write_text('#!/bin/bash\nexit ' + str(code) + '\n')
            handler.chmod(0o755)
        for code in (0,1,2):
            argv = ['/bin/bash', '-c', 'source "$1"; run_handlers "$2"', '-',
                    str(kimi_runner), 'exit-' + str(code) + '.sh']
            result = subprocess.run(argv, cwd=self.repo,
                env=dict(env, HOOKS_DIR=str(handlers), HOOK_INPUT_JSON='{}'), capture_output=True)
            (self.root / ('kimi-exit-' + str(code) + '.command.json')).write_text(json.dumps({
                'argv':argv, 'exit_code':result.returncode, 'stderr':result.stderr.decode()}, indent=2))
            self.assertEqual(result.returncode, 0 if code == 0 else 2, result.stderr)

    def test_missing_anchor_is_a_visible_failure_before_execution(self):
        self.config['extensions']['pre_tool_use'][0]['before'] = 'absent.sh'
        self.configure()
        result = self.invoke('missing-anchor', '--describe')
        self.assertEqual(result.returncode, 2)
        self.assertIn('System extension anchor is absent: absent.sh', result.stderr.decode())
        self.assertFalse((self.repo / 'marker.log').exists())

    def test_block_record_retains_raw_result_and_sessions_do_not_share_records(self):
        self.marker.write_text('#!/bin/bash\necho \'{"decision":"block","reason":"foreign owner"}\'\nexit 2\n')
        result = self.invoke('blocked')
        self.assertEqual(result.returncode, 2)
        self.assertIn('foreign owner', result.stderr.decode())
        first = self.repo / '.caws/sessions/selection-session/hook-events.jsonl'
        before = first.read_bytes()
        record = json.loads(before)
        self.assertEqual((record['exit_code'], record['adapter_exit_code']), (2, 2))
        self.assertEqual(json.loads(record['stdout']), {'decision': 'block', 'reason': 'foreign owner'})
        self.env['CAWS_SESSION_ID'] = 'selection-session'
        second = self.invoke('successor-blocked', session='successor-session')
        self.assertEqual(second.returncode, 2)
        other = json.loads((self.repo / '.caws/sessions/successor-session/hook-events.jsonl').read_text())
        self.assertEqual(first.read_bytes(), before)
        self.assertEqual(other['session_id'], 'successor-session')
        self.assertNotEqual(other['invocation_id'], record['invocation_id'])

    def test_recording_failure_cannot_turn_a_refusal_into_admission(self):
        self.marker.write_text('#!/bin/bash\necho \'{"decision":"block","reason":"still blocked"}\'\nexit 2\n')
        outside = self.root / 'outside'
        outside.mkdir()
        sessions = self.repo / '.caws/sessions'
        sessions.mkdir()
        (sessions / 'selection-session').symlink_to(outside, target_is_directory=True)
        result = self.invoke('record-failure')
        self.assertEqual(result.returncode, 2)
        self.assertIn('still blocked', result.stderr.decode())
        self.assertIn('[caws execution record] incomplete: Symlink path:', result.stderr.decode())
        self.assertEqual(list(outside.iterdir()), [])

    def test_malformed_record_cannot_change_a_tool_decision(self):
        self.marker.write_text('#!/bin/bash\nprintf "[]\\n" >> "$CAWS_HOOK_EXECUTION_FILE"\nexit 0\n')
        result = self.invoke('malformed-record')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('execution record must be an object', result.stderr.decode())

    def test_concurrent_invocations_keep_complete_session_scoped_records(self):
        sessions = ('agent-a', 'agent-b', 'agent-a', 'agent-b')
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(self.invoke, 'concurrent-' + str(i), session=sid)
                       for i, sid in enumerate(sessions)]
            for future in futures:
                result = future.result()
                self.assertEqual(result.returncode, 0, result.stderr)
        invocation_ids = set()
        for sid in ('agent-a', 'agent-b'):
            directory = self.repo / '.caws/sessions' / sid
            envelope = json.loads((directory / '.session-envelope.json').read_text())
            self.assertEqual(envelope['session_id'], sid)
            rows = [json.loads(line) for line in (directory / 'hook-events.jsonl').read_text().splitlines()]
            self.assertEqual([r['session_id'] for r in rows], [sid, sid])
            self.assertEqual([r['exit_code'] for r in rows], [0, 0])
            invocation_ids.update(r['invocation_id'] for r in rows)
        self.assertEqual(len(invocation_ids), 4)

    def test_project_policy_uses_its_own_executable(self):
        (self.home / 'surfaces/codex/settings.json').write_text('{"version":1,"enabled":false}')
        (self.repo / '.caws/hooks/adapter-policy.json').write_text(json.dumps({
            'version': 1, 'surfaces': {'codex': {'libraries': {}, 'events': {
                'pre_tool_use': {'hooks_dir': '.caws/hooks', 'handlers': ['marker.sh']}}}}}))
        command = ['python3', str(self.home / 'bin/caws-hook'), 'codex', 'pre_tool_use', '--describe']
        result = subprocess.run(command, cwd=self.repo, env=self.env, capture_output=True)
        (self.root / 'project-policy.stdout').write_bytes(result.stdout)
        self.assertEqual(result.returncode, 0, result.stderr)
        row = json.loads(result.stdout)['handlers'][0]
        self.assertEqual((row['path'], row['kind']), (str(self.marker), 'project-policy'))
        self.assertFalse((self.repo / 'marker.log').exists())

    def test_disabled_system_selection_explains_why_it_will_not_run(self):
        (self.home / 'surfaces/codex/settings.json').write_text('{"version":1,"enabled":false}')
        result = self.invoke('disabled', '--describe')
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual((report['status'], report['handlers']), ('inactive', []))
        self.assertIn('disabled', report['reason'])
        self.assertFalse((self.repo / 'marker.log').exists())

    def test_all_surface_runners_preserve_refusals_and_record_raw_exit(self):
        for surface in ('codex', 'claude-code', 'kimi-code', 'qwen-code', 'dsh', 'opencode', 'zcode'):
            with self.subTest(surface=surface):
                self.surface = surface
                settings = self.home / 'surfaces' / surface / 'settings.json'
                settings.parent.mkdir(parents=True, exist_ok=True)
                settings.write_text('{"version":1,"enabled":true}')
                self.configure()
                self.marker.write_text('#!/bin/bash\necho \'{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"retained denial"}}\'\n')
                denied = self.invoke(surface + '-deny', session=surface + '-session')
                self.assertEqual(denied.returncode, 2, denied.stderr)
                self.marker.write_text('#!/bin/bash\necho "infrastructure failure" >&2\nexit 1\n')
                failed = self.invoke(surface + '-exit1', session=surface + '-session')
                self.assertEqual(failed.returncode, 2 if surface == 'kimi-code' else 1, failed.stderr)
                rows = [json.loads(line) for line in
                        (self.repo / '.caws/sessions' / (surface + '-session') / 'hook-events.jsonl').read_text().splitlines()]
                self.assertEqual([r['exit_code'] for r in rows], [0, 1])
                self.assertEqual([r['adapter_exit_code'] for r in rows], [2, failed.returncode])
                self.assertEqual([r['surface'] for r in rows], [surface, surface])

    def test_codex_legacy_diagnostic_aliases_survive_shared_delegation(self):
        self.marker.write_text('#!/bin/bash\nexit 1\n')
        self.env.update(CODEX_HOOK_DRY_RUN='1', CODEX_HOOK_TIMING='1')
        result = self.invoke('codex-diagnostic-alias')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('[DRY-RUN] marker.sh would have exited 1', result.stderr.decode())
        self.assertIn('[timing] marker.sh:', result.stderr.decode())
        record = json.loads((self.repo / '.caws/sessions/selection-session/hook-events.jsonl').read_text())
        self.assertEqual((record['exit_code'], record['adapter_exit_code']), (1, 0))


if __name__ == '__main__':
    unittest.main()
