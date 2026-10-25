"""Installed-bootstrap fixtures; native delivery is deliberately unclaimed."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import unittest

import test_machine_hook_selection as fixture


class HookExecutionDiagnostics(unittest.TestCase):
    setUp = fixture.MachineHookSelection.setUp
    configure = fixture.MachineHookSelection.configure

    def command(self):
        return ['python3', str(self.home / 'bin/caws-hook'), self.surface,
                getattr(self, 'event', 'pre_tool_use'), '--system']

    def payload(self, **values):
        return dict({'session_id': 'selection-session', 'cwd': str(self.repo),
                     'tool_name': 'Bash', 'tool_use_id': 'tool-1'}, **values)

    def invoke(self, label, payload=None):
        payload = self.payload() if payload is None else payload
        result = subprocess.run(self.command(), cwd=self.repo, env=self.env,
                                input=json.dumps(payload).encode(), capture_output=True)
        self.retain(label, result, payload)
        return result

    def retain(self, label, result, payload=None):
        (self.root / (label + '.stdout')).write_bytes(result.stdout)
        (self.root / (label + '.stderr')).write_bytes(result.stderr)
        (self.root / (label + '.command.json')).write_text(json.dumps(
            {'argv': self.command(), 'cwd': str(self.repo), 'exit_code': result.returncode,
             'input': payload}, indent=2))

    def journals(self):
        return sorted((self.repo / '.caws/sessions/selection-session/hook-invocations').glob('*.jsonl'))

    def rows(self, path):
        return [json.loads(line) for line in path.read_text().splitlines()]

    def add_handler(self, name, body):
        path = self.repo / '.caws/hooks' / name
        path.write_text('#!/bin/bash\n' + body)
        path.chmod(0o755)
        self.config['extensions']['pre_tool_use'].append({'handler': name, 'before': None})
        self.config['handlers'][name] = '.caws/hooks/' + name
        self.configure()

    def test_installed_entry_applies_real_ignored_staging_guard_in_command_directory(self):
        command_dir = self.repo / 'nested'
        command_dir.mkdir()
        (command_dir / '.gitignore').write_text('*.generated\n')
        (command_dir / 'private.generated').write_text('nested fixture\n')
        (self.repo / 'private.generated').write_text('root fixture\n')
        policy = self.root / 'utility-policy.json'
        policy.write_text(json.dumps({'version': 1, 'ignored_staging': True}))
        self.env['CAWS_OPTIONAL_HOOK_POLICY'] = str(policy)
        self.config['extensions']['pre_tool_use'].append(
            {'handler': 'hook-utilities.sh', 'before': 'marker.sh'})
        self.configure()
        command = {'command': 'git add -f private.generated'}
        legacy = self.invoke('legacy-session-directory', self.payload(tool_input=command))
        self.assertEqual(legacy.returncode, 0, legacy.stderr)
        marker_before = (self.repo / 'marker.log').read_bytes()
        raw = self.payload(execution_workdir=str(command_dir), tool_input=command)
        result = self.invoke('real-command-directory', raw)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn(b'Consumer ignored-staging policy: private.generated', result.stdout)
        self.assertEqual((self.repo / 'marker.log').read_bytes(), marker_before)
        self.assertFalse((self.repo / '.git/index').exists())
        command_rows = [self.rows(path)[0] for path in self.journals()
                        if self.rows(path)[0]['supplied_context']['execution_workdir_resolution']['status'] == 'resolved']
        self.assertEqual(len(command_rows), 1)
        self.assertEqual(command_rows[0]['dispatch_cwd'], str(command_dir))
        self.assertEqual(raw['cwd'], str(self.repo))
        self.assertEqual(raw['tool_use_id'], 'tool-1')

    def test_scratch_and_foreign_command_contexts_cannot_disable_session_governance(self):
        scratch, foreign = self.root / 'scratch', self.root / 'foreign'
        scratch.mkdir()
        foreign.mkdir()
        init = subprocess.run(['git', 'init', '-q', str(foreign)], env=self.env, capture_output=True)
        self.assertEqual(init.returncode, 0, init.stderr)
        target = self.repo / 'must-not-be-written'
        for label, directory in [('scratch', scratch), ('foreign', foreign)]:
            result = self.invoke(label + '-context', self.payload(execution_workdir=str(directory),
                tool_input={'command': 'printf unsafe > ' + str(target)}))
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn(b'execution directory', result.stderr)
        self.assertFalse((self.repo / 'marker.log').exists())
        self.assertFalse(target.exists())
        self.assertEqual(self.journals(), [])

    def test_installed_dispatch_keeps_session_identity_and_uses_physical_command_cwd(self):
        command_dir = self.repo / 'nested'
        command_dir.mkdir()
        self.marker.write_text('#!/bin/bash\nprintf "%s\\n" "$PWD" "$HOOK_CWD" '
                               '"$HOOK_SESSION_CWD" "$HOOK_SESSION_ID" "$HOOK_TOOL_USE_ID" '
                               '"$HOOK_COMMAND" > "$CAWS_PROJECT_DIR/marker.log"\n')
        raw = self.payload(execution_workdir=str(command_dir), turn_id='original-turn',
                           tool_input={'command': 'echo unchanged'})
        result = self.invoke('command-process-cwd', raw)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.repo / 'marker.log').read_text().splitlines(),
                         [str(command_dir), str(command_dir), str(self.repo),
                          'selection-session', 'tool-1', 'echo unchanged'])
        row = self.rows(self.journals()[0])[0]
        self.assertEqual(row['dispatch_cwd'], str(command_dir))
        self.assertEqual(row['supplied_context']['session_cwd'], str(self.repo))
        self.assertEqual(row['input_sha256'], hashlib.sha256(json.dumps(raw).encode()).hexdigest())

    def test_inherited_status_and_tool_alias_do_not_mint_host_execution_context(self):
        nested = self.repo / 'nested'
        nested.mkdir()
        self.env['HOOK_EXECUTION_WORKDIR_STATUS'] = 'resolved'
        self.env['HOOK_EXECUTION_WORKDIR'] = str(nested)
        self.env['HOOK_CWD'] = str(nested)
        self.marker.write_text('#!/bin/bash\nprintf "%s\\n" "$HOOK_EXECUTION_WORKDIR_STATUS" '
                               '"$HOOK_CWD" > "$CAWS_PROJECT_DIR/marker.log"\n')
        result = self.invoke('forged-status', self.payload(tool_input={
            'command': 'echo unchanged', 'workdir': str(nested)}))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.repo / 'marker.log').read_text().splitlines(),
                         ['unavailable', str(self.repo)])

    def test_present_invalid_execution_context_refuses_before_dispatch(self):
        file = self.root / 'file-context'
        file.write_text('not a directory')
        alias = self.root / 'symlink-context'
        alias.symlink_to(self.repo, target_is_directory=True)
        values = [None, '', 0, False, {}, [], 'relative', str(file), str(alias),
                  str(self.root / 'missing'), 'bad\0path', str(self.repo) + '/.']
        for event in ('pre_tool_use', 'post_tool_use'):
            self.event = event
            for index, value in enumerate(values):
                with self.subTest(event=event, value=value):
                    result = self.invoke(event + '-invalid-execution-' + str(index),
                                         self.payload(execution_workdir=value))
                    self.assertEqual(result.returncode, 2)
                    self.assertIn(b'execution_workdir', result.stderr)
        self.assertFalse((self.repo / 'marker.log').exists())
        self.assertEqual(self.journals(), [])

    def test_host_execution_context_requires_every_alias_to_agree(self):
        nested = self.repo / 'nested'
        nested.mkdir()
        for alias in ('workdir', 'cwd'):
            result = self.invoke('disagree-' + alias, self.payload(
                execution_workdir=str(nested), tool_input={alias: str(self.repo)}))
            self.assertEqual(result.returncode, 2)
            self.assertIn(b'disagrees with execution_workdir', result.stderr)
        self.assertFalse((self.repo / 'marker.log').exists())

    def test_normal_journal_binds_supplied_context_without_command_capture(self):
        payload = self.payload(tool_input={'command': 'SECRET_COMMAND_SENTINEL',
                                          'workdir': str(self.repo / 'explicit'),
                                          'actor_id': 'supplied-actor'})
        result = self.invoke('normal', payload)
        self.assertEqual(result.returncode, 0, result.stderr)
        paths = self.journals()
        self.assertEqual(len(paths), 1)
        rows = self.rows(paths[0])
        self.assertEqual([row['stage'] for row in rows],
                         ['invocation_started', 'dispatch_started', 'handler_started',
                          'handler_completed', 'dispatch_completed',
                          'adapter_stdout_handoff', 'adapter_finished'])
        start = rows[0]
        self.assertEqual(start['schema'], 'caws.hook_invocation.v1')
        self.assertEqual(start['supplied_context']['session_id'], 'selection-session')
        self.assertEqual(start['supplied_context']['session_cwd'], str(self.repo))
        self.assertEqual(start['supplied_context']['tool_use_id'], 'tool-1')
        self.assertEqual(start['supplied_context']['execution_workdir'],
                         {'workdir': str(self.repo / 'explicit')})
        self.assertEqual(start['supplied_context']['tool_input_fields'],
                         ['actor_id', 'command', 'workdir'])
        self.assertEqual(start['input_sha256'], hashlib.sha256(json.dumps(payload).encode()).hexdigest())
        self.assertNotIn('SECRET_COMMAND_SENTINEL', paths[0].read_text())
        completed = rows[3]
        self.assertEqual(completed['handler'], 'marker.sh')
        self.assertEqual(completed['exit_code'], 0)
        self.assertEqual(completed['source_sha256'], hashlib.sha256(self.marker.read_bytes()).hexdigest())
        self.assertEqual({row['invocation_id'] for row in rows}, {start['invocation_id']})
        self.assertTrue(all(row['delivery'] == 'not_observed' for row in rows))
        self.assertEqual(rows[-1]['exit_code'], 0)
        self.assertEqual(paths[0].stat().st_mode & 0o777, 0o600)

    def test_absent_execution_context_is_unavailable_not_session_cwd(self):
        result = self.invoke('no-execution-context')
        self.assertEqual(result.returncode, 0, result.stderr)
        context = self.rows(self.journals()[0])[0]['supplied_context']
        self.assertEqual(context['execution_workdir'], {'status': 'unavailable'})
        self.assertEqual(context['session_cwd'], str(self.repo))
        self.assertEqual(context['tool_input_fields'], [])

    def test_refusal_preserves_output_exit_and_short_circuit(self):
        self.marker.write_text('#!/bin/bash\nprintf \'{"decision":"block","reason":"fixture refusal"}\\n\'\nprintf "guard stderr\\n" >&2\nexit 2\n')
        self.add_handler('after.sh', 'touch "$CAWS_PROJECT_DIR/ran-after"\n')
        result = self.invoke('refused')
        self.assertEqual(result.returncode, 2)
        self.assertIn(b'fixture refusal', result.stdout)
        self.assertIn(b'guard stderr', result.stderr)
        self.assertFalse((self.repo / 'ran-after').exists())
        rows = self.rows(self.journals()[0])
        completed = [r for r in rows if r['stage'] == 'handler_completed']
        self.assertEqual([r['handler'] for r in completed], ['marker.sh'])
        self.assertEqual(completed[0]['exit_code'], 2)
        self.assertEqual(json.loads(completed[0]['stdout'])['reason'], 'fixture refusal')
        self.assertEqual(completed[0]['stderr'], 'guard stderr\n')
        self.assertEqual(rows[-1]['exit_code'], 2)

    def test_unwritable_journal_preserves_refusal(self):
        session = self.repo / '.caws/sessions/selection-session'
        session.mkdir(parents=True)
        (session / 'hook-invocations').write_text('not a directory')
        self.marker.write_text('#!/bin/bash\nprintf "refused despite storage failure\\n"\nexit 2\n')
        result = self.invoke('storage-failure')
        self.assertEqual(result.returncode, 2)
        self.assertIn(b'refused despite storage failure', result.stdout)
        self.assertIn(b'[caws invocation record] incomplete:', result.stderr)
        self.assertEqual((session / 'hook-invocations').read_text(), 'not a directory')

    def test_unsafe_supplied_session_never_chooses_a_diagnostic_path(self):
        self.marker.write_text('#!/bin/bash\nexit 2\n')
        for index, sid in enumerate(['../escape', '.', '..', '/absolute', 'x' * 129, {'bad': 'identity'}]):
            with self.subTest(sid=sid):
                result = self.invoke('unsafe-' + str(index), self.payload(session_id=sid))
                self.assertEqual(result.returncode, 2)
                self.assertIn(b'[caws invocation record] incomplete:', result.stderr)
        self.assertEqual(list(self.repo.rglob('hook-invocations')), [])
        self.assertFalse((self.repo / '.caws/escape').exists())

    def test_symlinked_journal_directory_is_not_followed(self):
        external = self.root / 'outside-journal'
        external.mkdir()
        session = self.repo / '.caws/sessions/selection-session'
        session.mkdir(parents=True)
        (session / 'hook-invocations').symlink_to(external, target_is_directory=True)
        self.marker.write_text('#!/bin/bash\nexit 2\n')
        result = self.invoke('symlink-refused')
        self.assertEqual(result.returncode, 2)
        self.assertIn(b'[caws invocation record] incomplete:', result.stderr)
        self.assertEqual(list(external.iterdir()), [])

    def test_post_runtime_filter_does_not_shift_source_identity(self):
        self.add_handler('after.sh', 'printf after\\n\n')
        self.event = 'post_tool_use'
        self.config['extensions']['post_tool_use'] = self.config['extensions'].pop('pre_tool_use')
        self.env['CAWS_DISABLED_HANDLERS'] = 'marker.sh'
        self.configure()
        result = self.invoke('post-filtered')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(b'selection mismatch', result.stderr)
        self.assertFalse((self.repo / 'marker.log').exists())
        completed = [r for r in self.rows(self.journals()[0]) if r['stage'] == 'handler_completed']
        self.assertEqual([r['handler'] for r in completed], ['after.sh'])
        self.assertEqual(completed[0]['source_sha256'], hashlib.sha256(
            (self.repo / '.caws/hooks/after.sh').read_bytes()).hexdigest())

    def test_malformed_tool_context_retains_type_not_arbitrary_values(self):
        result = self.invoke('malformed-context', self.payload(tool_input={
            'workdir': {'secret': 'NEVER_CAPTURE_THIS_VALUE'},
            'actor_id': ['NEVER_CAPTURE_THIS_VALUE'], 'command': 'NEVER_CAPTURE_THIS_VALUE'}))
        self.assertEqual(result.returncode, 0, result.stderr)
        path = self.journals()[0]
        context = self.rows(path)[0]['supplied_context']
        self.assertEqual(context['execution_workdir'],
                         {'workdir': {'status': 'unavailable', 'type': 'dict'}})
        self.assertNotIn('NEVER_CAPTURE_THIS_VALUE', path.read_text())

    def test_concurrent_invocations_keep_distinct_parseable_journals(self):
        def invoke(index):
            return self.invoke('concurrent-' + str(index),
                               self.payload(tool_use_id='tool-' + str(index)))
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(invoke, range(4)))
        self.assertEqual([r.returncode for r in results], [0] * 4,
                         [r.stderr for r in results])
        paths = self.journals()
        self.assertEqual(len(paths), 4)
        starts = []
        for path in paths:
            rows = self.rows(path)
            starts.append(rows[0])
            self.assertEqual(rows[0]['stage'], 'invocation_started')
            self.assertEqual(rows[-1]['stage'], 'adapter_finished')
            self.assertEqual({r['invocation_id'] for r in rows}, {rows[0]['invocation_id']})
            self.assertEqual(len([r for r in rows if r['stage'] == 'handler_completed']), 1)
        self.assertEqual(len({r['invocation_id'] for r in starts}), 4)
        self.assertEqual({r['supplied_context']['tool_use_id'] for r in starts},
                         {'tool-0', 'tool-1', 'tool-2', 'tool-3'})

    def test_external_sigterm_and_sigkill_leave_prior_completion_and_unmatched_start(self):
        self.marker.write_text('#!/bin/bash\nprintf "prior completed output\\n"\nprintf "prior stderr\\n" >&2\n')
        self.add_handler('hanging.sh',
                         'printf entered > "$CAWS_PROJECT_DIR/hanging-entered"\nsleep 60\n')
        for signum in (signal.SIGTERM, signal.SIGKILL):
            with self.subTest(signal=signum):
                entered = self.repo / 'hanging-entered'
                entered.unlink(missing_ok=True)
                before = set(self.journals())
                payload = self.payload()
                process = subprocess.Popen(self.command(), cwd=self.repo, env=self.env,
                                           stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                           stderr=subprocess.PIPE, start_new_session=True)
                process.stdin.write(json.dumps(payload).encode())
                process.stdin.close()
                process.stdin = None
                path = None
                try:
                    deadline = time.monotonic() + 20
                    while time.monotonic() < deadline:
                        added = set(self.journals()) - before
                        if added:
                            self.assertEqual(len(added), 1)
                            path = added.pop()
                            try:
                                rows = self.rows(path)
                            except ValueError:
                                time.sleep(0.02)
                                continue
                            ready = any(r['stage'] == 'handler_started' and
                                        r.get('handler') == 'hanging.sh' for r in rows)
                            if ready and entered.exists():
                                break
                        self.assertIsNone(process.poll(), 'fixture exited before hanging handler')
                        time.sleep(0.02)
                    else:
                        self.fail('hanging fixture did not start before deadline')
                    os.killpg(process.pid, signum)
                    stdout, stderr = process.communicate(timeout=10)
                    self.retain('killed-' + str(signum),
                                subprocess.CompletedProcess(self.command(), process.returncode,
                                                            stdout, stderr), payload)
                    self.assertEqual(process.returncode, -signum)
                    rows = self.rows(path)
                    completed = [r for r in rows if r['stage'] == 'handler_completed']
                    self.assertEqual([r['handler'] for r in completed], ['marker.sh'])
                    self.assertEqual(completed[0]['stdout'], 'prior completed output')
                    self.assertEqual(completed[0]['stderr'], 'prior stderr\n')
                    self.assertEqual(completed[0]['exit_code'], 0)
                    self.assertEqual([r['handler'] for r in rows if r['stage'] == 'handler_started'],
                                     ['marker.sh', 'hanging.sh'])
                    self.assertNotIn('dispatch_completed', [r['stage'] for r in rows])
                    self.assertNotIn('adapter_finished', [r['stage'] for r in rows])
                    self.assertEqual({r['invocation_id'] for r in rows}, {rows[0]['invocation_id']})
                finally:
                    if process.poll() is None:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.communicate(timeout=10)


if __name__ == '__main__':
    unittest.main()
