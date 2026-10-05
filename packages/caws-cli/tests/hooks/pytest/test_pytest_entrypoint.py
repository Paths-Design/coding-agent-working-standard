"""Qualify npm's pytest preflight from source without relying on existing dist.

The inner test command is narrowed to a real installed-hook scenario using the
current Python, so this regression does not reinstall pip or recursively run the
suite. npm lifecycle ordering and the entire production build remain real.
"""
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest

PACKAGE = Path(__file__).resolve().parents[3]


class PytestEntrypoint(unittest.TestCase):
    def test_source_only_entrypoint_builds_before_installed_runtime_scenario(self):
        # An ignored directory under the checkout retains normal dependency
        # resolution, without copying dist or inventing node_modules symlinks.
        scratch = PACKAGE.parents[1] / '.tmp'
        scratch.mkdir(exist_ok=True)
        root = Path(tempfile.mkdtemp(prefix='pytest-entrypoint-', dir=scratch))
        retained = os.environ.get('CAWS_EXPERIMENT_ARTIFACTS')
        if retained:
            Path(retained).mkdir(parents=True, exist_ok=True)
        evidence = Path(tempfile.mkdtemp(prefix='entrypoint-', dir=retained)) if retained else root / 'evidence'
        evidence.mkdir(exist_ok=True, parents=True)
        self.addCleanup(shutil.rmtree, root)
        copy = root / 'packages/caws-cli'
        copy.mkdir(parents=True)
        # Build owns documentation staging too. Mirror the source monorepo
        # layout so this tests a fresh checkout with all authored inputs.
        shutil.copytree(PACKAGE.parents[1] / 'docs', root / 'docs')
        for name in ('src', 'scripts', 'surfaces', 'templates'):
            shutil.copytree(PACKAGE / name, copy / name,
                            ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        shutil.copy2(PACKAGE / 'tsconfig.vnext.json', copy)
        test_name = 'tests/hooks/pytest/test_machine_hook_selection.py'
        (copy / test_name).parent.mkdir(parents=True)
        shutil.copy2(PACKAGE / test_name, copy / test_name)
        original = (PACKAGE / 'package.json').read_bytes()
        manifest = json.loads(original)
        manifest['scripts']['test:pytest'] = shlex.join([
            sys.executable, test_name,
            'MachineHookSelection.test_description_is_read_only_and_matches_executed_override', '-v'])
        (copy / 'package.json').write_text(json.dumps(manifest, indent=2))
        self.assertFalse((copy / 'dist').exists())
        argv = ['npm', 'run', 'test:pytest']
        result = subprocess.run(argv, cwd=copy, capture_output=True, timeout=180,
            env=dict(os.environ, CAWS_EXPERIMENT_ARTIFACTS=str(evidence), PYTHONDONTWRITEBYTECODE='1'))
        (evidence / 'npm.stdout').write_bytes(result.stdout)
        (evidence / 'npm.stderr').write_bytes(result.stderr)
        built = copy / 'dist/init/machine-adapters.js'
        (evidence / 'command.json').write_text(json.dumps({
            'argv':argv, 'cwd':str(copy), 'exit_code':result.returncode,
            'dist_absent_before':True, 'installer_exists_after':built.exists(),
            'installer_sha256':hashlib.sha256(built.read_bytes()).hexdigest() if built.exists() else None,
            'package_sha256':hashlib.sha256(original).hexdigest(),
            'inner_test_override':manifest['scripts']['test:pytest'],
            'not_verified':['pip installation', 'full CI environment'],
        }, indent=2))
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertTrue(built.exists())
        markers = list(evidence.glob('selection-*/repo/marker.log'))
        self.assertEqual(len(markers), 1)
        self.assertEqual(markers[0].read_text(), 'invoked\n')


if __name__ == '__main__':
    unittest.main()
