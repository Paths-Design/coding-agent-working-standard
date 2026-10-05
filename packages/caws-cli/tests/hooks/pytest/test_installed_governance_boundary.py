"""Installed guards against controlled authority; command strings are never executed."""
import hashlib
import json
from pathlib import Path
import subprocess
import unittest

from test_machine_hook_selection import MachineHookSelection as Installation


class InstalledGovernanceBoundary(unittest.TestCase):
    setUp = Installation.setUp
    configure = Installation.configure

    def seed(self, handler='bash-write-guard.sh'):
        self.surface = 'claude-code'
        settings = self.home / 'surfaces/claude-code/settings.json'
        settings.parent.mkdir(parents=True, exist_ok=True)
        settings.write_text('{"version":1,"enabled":true}')
        self.config['extensions'] = {}
        self.config['disabled']['pre_tool_use'].remove(handler)
        self.configure()
        self.registry = {}
        for name, owner, pattern in [('mine', 'agent-a', 'src/mine/'),
                                      ('foreign', 'agent-b', 'src/foreign/')]:
            lane = self.repo / '.caws/worktrees' / name
            lane.mkdir(parents=True)
            self.registry[name] = {'name': name, 'path': str(lane), 'spec_id': name,
                                  'owner': {'session_id': owner}, 'baseBranch': 'main'}
            (self.repo / '.caws/specs' / (name + '.yaml')).write_text(
                f'id: {name}\nlifecycle_state: active\nworktree: {name}\nscope:\n  in:\n    - {pattern}\n')
        self.registry_path = self.repo / '.caws/worktrees.json'
        self.registry_path.write_text(json.dumps(self.registry))
        self.foreign = self.repo / '.caws/worktrees/foreign/sentinel.txt'
        self.foreign.write_text('foreign bytes unchanged\n')

    def call(self, label, *, command=None, path=None, mode='default', session='agent-a', cwd=None):
        payload = {'session_id': session, 'cwd': str(cwd or self.repo),
                   'permission_mode': mode, 'tool_name': 'Bash' if command is not None else 'Write',
                   'tool_input': {'command': command} if command is not None else {'file_path': str(path)}}
        argv = ['python3', str(self.home / 'bin/caws-hook'), self.surface, 'pre_tool_use', '--system']
        result = subprocess.run(argv, cwd=cwd or self.repo, env=self.env,
                                input=json.dumps(payload).encode(), capture_output=True, timeout=30)
        for name, data in [('stdout', result.stdout), ('stderr', result.stderr),
                           ('input.json', json.dumps(payload, indent=2).encode())]:
            (self.root / (label + '.' + name)).write_bytes(data)
        receipt = {'argv': argv, 'exit_code': result.returncode, 'cwd': str(cwd or self.repo),
                   'sentinel_sha256': hashlib.sha256(self.foreign.read_bytes()).hexdigest(),
                   'sentinel': str(self.foreign), 'registry': str(self.registry_path),
                   'runtime_digest': self.runtime.name, 'boundary': 'hook return; no native tool executed'}
        (self.root / (label + '.command.json')).write_text(json.dumps(receipt, indent=2))
        return result

    def test_foreign_tenure_survives_absent_lease_and_source_reads_are_allowed(self):
        self.seed()
        before = self.foreign.read_bytes()
        for index, command in enumerate([
            f'touch "{self.foreign}"', f'echo "$(touch \'{self.foreign}\')"',
            f'caws message poll; touch "{self.foreign}"', f'mv "{self.foreign}" owned.txt',
        ]):
            result = self.call('foreign-' + str(index), command=command)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn(b'DIFFERENT session', result.stderr)
        for index, command in enumerate([
            f'echo touch "{self.foreign}"', f'cp "{self.foreign}" owned.txt',
            'touch .caws/worktrees/mine/owned.txt',
        ]):
            result = self.call('preserved-' + str(index), command=command)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.foreign.read_bytes(), before)
        self.assertFalse((self.repo / '.caws/leases').exists())

    def test_permission_mode_preserves_real_ask_and_blocks_auto_approval(self):
        self.seed()
        command = 'touch "$UNRESOLVED_TARGET"'
        interactive = self.call('interactive-ask', command=command)
        self.assertEqual(interactive.returncode, 0, interactive.stderr)
        self.assertIn(b'"ask"', interactive.stdout)
        automatic = self.call('automatic-block', command=command, mode='bypassPermissions')
        self.assertEqual(automatic.returncode, 2, automatic.stderr)
        self.assertIn(b'automatically satisfied', automatic.stderr)
        self.assertIn(b'ask_dynamic_unconfined', automatic.stderr)
        ordinary = self.call('automatic-benign', command='wc -l README.md', mode='bypassPermissions')
        self.assertEqual(ordinary.returncode, 0, ordinary.stderr)

    def test_wrappers_and_interleaved_redirections_keep_foreign_targets_visible(self):
        self.seed()
        before = self.foreign.read_bytes()
        cases = [f'touch "{self.foreign}"', f'/usr/bin/env touch "{self.foreign}"',
                 f'touch < /dev/null "{self.foreign}"',
                 f'touch > owned.log "{self.foreign}"',
                 f'cp source.txt > owned.log "{self.foreign}"']
        for index, command in enumerate(cases):
            with self.subTest(command=command):
                result = self.call('argv-foreign-' + str(index), command=command)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn(b'DIFFERENT session', result.stderr)
        for index, command in enumerate(['touch < /dev/null .caws/worktrees/mine/new.txt',
                                         f'cp "{self.foreign}" > owned.log owned.txt',
                                         f'echo /usr/bin/env touch "{self.foreign}"']):
            result = self.call('argv-preserved-' + str(index), command=command)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.foreign.read_bytes(), before)
        self.assertFalse((self.repo / 'owned.log').exists(), 'captured commands must remain inert')

    def test_logical_and_physical_project_roots_have_the_same_ownership(self):
        self.seed()
        alias = self.root / 'repo-alias'
        alias.symlink_to(self.repo, target_is_directory=True)
        for label, project in [('physical', self.repo), ('logical', alias)]:
            for target, expected in [('ordinary.txt', 0), (str(self.foreign), 2)]:
                payload = {'session_id':'agent-a', 'cwd':str(project), 'tool_name':'Bash',
                           'tool_input':{'command':'touch "' + target + '"'}}
                argv = ['/bin/bash', str(self.runtime / 'bash-write-guard.sh')]
                env = dict(self.env, CAWS_PROJECT_DIR=str(project), HOOK_CWD=str(project),
                           CAWS_AGENT_SURFACE='claude-code')
                result = subprocess.run(argv, cwd=project, env=env, capture_output=True,
                                        input=json.dumps(payload).encode(), timeout=30)
                receipt = {'argv':argv, 'input':payload, 'exit_code':result.returncode,
                           'project':str(project), 'resolved_project':str(project.resolve()),
                           'stdout':result.stdout.decode(), 'stderr':result.stderr.decode()}
                (self.root / (label + '-' + str(expected) + '.command.json')).write_text(
                    json.dumps(receipt, indent=2))
                self.assertEqual(result.returncode, expected, result.stderr)
                if expected == 2:
                    self.assertIn(b'DIFFERENT session', result.stderr)

    def test_write_payload_uncertainty_and_canonical_claim_from_owned_lane(self):
        self.seed('worktree-write-guard.sh')
        self.registry['foreign'].pop('owner')
        self.registry_path.write_text(json.dumps(self.registry))
        prompt = self.call('unknown-owner-ask', path=self.foreign)
        self.assertEqual(prompt.returncode, 0, prompt.stderr)
        self.assertIn(b'"ask"', prompt.stdout)
        blocked = self.call('unknown-owner-block', path=self.foreign, mode='bypassPermissions')
        self.assertEqual(blocked.returncode, 2, blocked.stderr)
        self.assertIn(b'ownership could not be confirmed', blocked.stderr)
        mine = self.repo / '.caws/worktrees/mine'
        foreign = self.call('canonical-foreign', path=self.repo / 'src/foreign/new.txt', cwd=mine)
        self.assertEqual(foreign.returncode, 2, foreign.stderr)
        self.assertIn(b'claimed:foreign:src/foreign/', foreign.stderr)
        own = self.call('canonical-own', path=self.repo / 'src/mine/new.txt', cwd=mine)
        self.assertEqual(own.returncode, 0, own.stderr)
        impostor = self.call('canonical-impostor', path=self.repo / 'src/mine/new.txt',
                             cwd=mine, session='agent-c')
        self.assertEqual(impostor.returncode, 2, impostor.stderr)
        self.assertIn(b'claimed:mine:src/mine/', impostor.stderr)

    def test_worktree_operations_use_command_positions_including_nested_commands(self):
        self.seed('worktree-guard.sh')
        for index, command in enumerate([
            'echo git sparse-checkout disable',
            'git log --format="git restore file.txt"',
            "cat <<'EOF'\ngit sparse-checkout disable\nEOF",
        ]):
            result = self.call('operation-prose-' + str(index), command=command)
            self.assertEqual(result.returncode, 0, result.stderr)
        for index, command in enumerate([
            'git sparse-checkout disable',
            'echo "$(git sparse-checkout disable)"',
            'env A=1 /usr/bin/git sparse-checkout disable',
        ]):
            result = self.call('operation-real-' + str(index), command=command)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn(b'agent-issued git sparse-checkout is refused', result.stderr)

    def test_cross_repo_paths_resolve_dot_segments_and_symlinks_before_allowlist(self):
        self.seed()
        sibling = self.root / 'sibling'
        sibling.mkdir()
        result = subprocess.run(['git', 'init', '-q', str(sibling)], capture_output=True, env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        (sibling / 'sentinel').write_text('sibling unchanged')
        (self.repo / 'link').symlink_to(sibling, target_is_directory=True)
        for index, command in enumerate([
            f'touch "{sibling}/sentinel"',
            f'touch "{self.repo}/../sibling/sentinel"',
            'touch link/sentinel',
        ]):
            verdict = self.call('cross-repo-' + str(index), command=command)
            self.assertEqual(verdict.returncode, 2, verdict.stderr)
            self.assertIn(b'DIFFERENT repository', verdict.stderr)
        self.assertEqual((sibling / 'sentinel').read_text(), 'sibling unchanged')


if __name__ == '__main__':
    unittest.main()
