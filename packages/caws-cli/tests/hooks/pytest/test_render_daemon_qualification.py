"""Discriminate source reload from cached code using actual execution artifacts."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[5]
spec = importlib.util.spec_from_file_location(
    'source_freshness', REPO / 'scripts/hook-experiments/source_freshness.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class RenderDaemonQualification(unittest.TestCase):
    def setUp(self):
        retained = os.environ.get('CAWS_EXPERIMENT_ARTIFACTS')
        if retained:
            Path(retained).mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix='source-control-', dir=retained))
        if not retained:
            self.addCleanup(shutil.rmtree, self.root)
        self.logs = self.root / 'warm'
        self.logs.mkdir()
        self.source = self.root / 'session_log_renderer.py'
        self.source.write_text('from pathlib import Path\n'
            'def render_session(*, log_dir):\n'
            '    (Path(log_dir) / "turn-001.json").write_text(\'{"user":"control"}\')\n')
        probe.instrument(self.source)

    def load(self):
        namespace = {}
        exec(compile(self.source.read_bytes(), str(self.source), 'exec'), namespace)
        return namespace['render_session']

    def check(self, reload):
        renderer = self.load()
        renderer(log_dir=str(self.logs))
        def request(label):
            (self.load() if reload else renderer)(log_dir=str(self.logs))
            return 'ok 2 1 rendered\n'  # Identical transport response in both cases.
        return probe.qualify_source_change(self.source, self.logs, self.root,
                                          {'log_dir':str(self.logs)}, request)

    def test_fresh_code_execution_is_not_a_counterexample_despite_ok_response(self):
        report = self.check(reload=True)
        self.assertFalse(report['counterexample'])
        self.assertEqual(report['warm_execution']['version'], 'source-b')
        self.assertTrue(report['mtime_preserved'] and report['size_preserved'])
        self.assertNotEqual(report['original_sha256'], report['changed_sha256'])

    def test_cached_code_is_a_counterexample_with_the_same_ok_response(self):
        report = self.check(reload=False)
        self.assertTrue(report['counterexample'])
        self.assertEqual(report['warm_execution']['version'], 'source-a')
        self.assertEqual(report['fresh_execution']['version'], 'source-b')

    def test_missing_cold_instrumentation_cannot_yield_a_verdict(self):
        with self.assertRaisesRegex(RuntimeError, 'missing or malformed'):
            probe.qualify_source_change(self.source, self.logs, self.root,
                                        {'log_dir':str(self.logs)}, lambda _: 'ok 1')
        self.assertFalse((self.root / 'source-freshness.json').exists())

    def test_missing_warm_instrumentation_cannot_look_like_fresh_execution(self):
        self.load()(log_dir=str(self.logs))
        def request(label):
            (self.logs / probe.MARKER).unlink()
            return 'ok 2 1 rendered\n'
        with self.assertRaisesRegex(RuntimeError, 'missing or malformed'):
            probe.qualify_source_change(self.source, self.logs, self.root,
                                        {'log_dir':str(self.logs)}, request)
        self.assertFalse((self.root / 'source-freshness.json').exists())


if __name__ == '__main__':
    unittest.main()
