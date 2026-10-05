"""Negative controls for corpus execution custody, using synthetic commands only."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
RUNNER=Path(__file__).with_name('replay-terminal-corpus.py')
CLASSIFIER=ROOT/'packages/caws-cli/templates/hook-packs/shared/classify_command.py'


class ReplayBoundary(unittest.TestCase):
    def test_command_is_data_and_actual_write_attempt_is_refused(self):
        with tempfile.TemporaryDirectory(prefix='caws-replay-control-') as temporary:
            root=Path(temporary)
            sentinel=root/'must-not-exist'
            command='touch '+str(sentinel)
            item={'command':command,'command_sha256':hashlib.sha256(command.encode()).hexdigest(),'offset':0}
            env={'PATH':os.environ['PATH'],'HOME':str(root),'PYTHONDONTWRITEBYTECODE':'1'}
            def run(classifier):
                result=subprocess.run([sys.executable,str(RUNNER),'--worker','--classifier',str(classifier)],
                    input=(json.dumps(item)+'\n').encode(),capture_output=True,env=env,cwd=root,timeout=10)
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertFalse(sentinel.exists())
                return json.loads(result.stdout)
            self.assertEqual(run(CLASSIFIER)['status'],'classified')
            faulty=root/'faulty.py'
            faulty.write_text('def classify_command(*args,**kwargs):\n    open('+repr(str(sentinel))+',"w").write("bad")\n')
            refused=run(faulty)
            self.assertEqual(refused['status'],'execution_attempt_refused')
            self.assertEqual(refused['operation'],'file write')


if __name__=='__main__':
    unittest.main()
