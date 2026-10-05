"""Optional utilities, real installed extension and Git pathspec queries."""
import json
import hashlib
from pathlib import Path
import subprocess
import unittest

from test_machine_hook_selection import MachineHookSelection as Installation


class InstalledHookUtilities(unittest.TestCase):
    setUp=Installation.setUp
    configure=Installation.configure

    def enable(self):
        self.surface='claude-code'
        settings=self.home/'surfaces/claude-code/settings.json'
        settings.parent.mkdir(parents=True,exist_ok=True)
        settings.write_text('{"version":1,"enabled":true}')
        self.config['extensions']={'pre_tool_use':[{'handler':'hook-utilities.sh','before':None}]}
        self.configure()
        self.policy=self.root/'consumer-policy.json'
        self.policy.write_text(json.dumps({'version':1,'rg_replace':True,'ignored_staging':True,
            'focused_tests':{'executables':['pytest'],'entry_point':'scripts/test'},
            'documents':{'roots':['docs/'],'required_frontmatter':['title','status']}}))
        self.env['CAWS_OPTIONAL_HOOK_POLICY']=str(self.policy)

    def invoke(self,label,command=None,tool_input=None):
        payload={'session_id':'utility-session-'+label,'cwd':str(self.repo),
                 'tool_name':'Bash' if command is not None else 'Write',
                 'tool_input':{'command':command} if command is not None else tool_input}
        argv=['python3',str(self.home/'bin/caws-hook'),self.surface,'pre_tool_use','--system']
        result=subprocess.run(argv,cwd=self.repo,env=self.env,capture_output=True,
                              input=json.dumps(payload).encode(),timeout=20)
        (self.root/(label+'.stdout')).write_bytes(result.stdout)
        (self.root/(label+'.stderr')).write_bytes(result.stderr)
        (self.root/(label+'.command.json')).write_text(json.dumps({'argv':argv,'payload':payload,
            'exit_code':result.returncode,'runtime_digest':self.runtime.name},indent=2))
        self.assertNotIn(b'Traceback',result.stderr)
        return result

    def test_replacement_notice_respects_option_values_and_command_positions(self):
        self.enable()
        for index,command in enumerate(['rg -rn needle file','env -u UNUSED /usr/bin/rg --replace=n needle file',
                                         'echo "$(rg -r n needle file)"']):
            result=self.invoke('replace-'+str(index),command)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertIn(b'Ripgrep replacement is active',result.stdout)
        for index,command in enumerate(['echo rg -rn needle file','rg -e "-rn" file',
                                         'rg -- -rn file','rg -g "*-rn" needle file']):
            result=self.invoke('literal-'+str(index),command)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertNotIn(b'Replacement is active',result.stdout)
            self.assertEqual(result.stdout,b'')
        self.env.pop('CAWS_OPTIONAL_HOOK_POLICY')
        self.assertEqual(self.invoke('disabled','rg -rn needle file').stdout,b'')

    def test_git_forced_staging_honors_cwd_whole_tree_and_nul_pathspecs(self):
        self.enable()
        (self.repo/'.gitignore').write_text('*.generated\n')
        (self.repo/'owned.py').write_text('repo-owned source\n')
        (self.repo/'private.generated').write_text('ignored fixture\n')
        sub=self.repo/'sub dir'
        sub.mkdir()
        (sub/'nested.generated').write_text('nested fixture\n')
        (sub/'paths.nul').write_bytes(b'nested.generated\0')
        setup=subprocess.run(['git','-C',str(self.repo),'add','--','owned.py','.gitignore'],
                             env=self.env,capture_output=True)
        self.assertEqual(setup.returncode,0,setup.stderr)
        index=self.repo/'.git/index'
        before=index.read_bytes() if index.exists() else None
        for number,command in enumerate(['git add -f private.generated','git add -f -A',
            'git -C "sub dir" add -f --pathspec-from-file=paths.nul --pathspec-file-nul',
            'cd "sub dir" && git add -f nested.generated',
            'git add -f private.generated; git add -f --pathspec-from-file=missing']):
            result=self.invoke('ignored-'+str(number),command)
            self.assertEqual(result.returncode,2,result.stderr)
            self.assertIn(b'Consumer ignored-staging policy',result.stdout)
        for number,command in enumerate(['git add .','git add -f owned.py','git add -fn private.generated',
                                         'echo git add -f private.generated', 'git add -fu private.generated',
                                         'git --literal-pathspecs add -f "*.generated"',
                                         'git -c core.quotePath=false status']):
            result=self.invoke('stage-preserved-'+str(number),command)
            self.assertEqual(result.returncode,0,result.stderr)
        for number,command in enumerate(['(cd "sub dir"); git add -f private.generated',
                                          'git add -f --pathspec-from-file=missing',
                                          'git add -fp private.generated']):
            result=self.invoke('stage-unresolved-'+str(number),command)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertIn(b'unresolved',result.stdout)
        after=index.read_bytes() if index.exists() else None
        sentinel=(self.repo/'private.generated').read_bytes()
        (self.root/'preservation.json').write_text(json.dumps({
            'index_before_sha256':hashlib.sha256(before).hexdigest(),
            'index_after_sha256':hashlib.sha256(after).hexdigest(),
            'sentinel_before_sha256':hashlib.sha256(b'ignored fixture\n').hexdigest(),
            'sentinel_after_sha256':hashlib.sha256(sentinel).hexdigest(),
            'captured_commands_executed':False},indent=2))
        self.assertEqual(after,before)
        self.assertEqual((self.repo/'private.generated').read_text(),'ignored fixture\n')

    def test_consumer_test_and_document_rules_are_advice_without_resource_authority(self):
        self.enable()
        result=self.invoke('focused-tests','python3 -m pytest tests/test_small.py')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn(b'scripts/test',result.stdout)
        self.assertIn(b'does not grant resource admission',result.stdout)
        result=self.invoke('document-missing',tool_input={'file_path':'docs/note.md','content':'# Heading'})
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn(b'title, status',result.stdout)
        large=self.invoke('document-large',tool_input={'file_path':'docs/large.md','content':'large '*25000})
        self.assertIn(b'title, status',large.stdout)
        complete=self.invoke('document-complete',tool_input={'file_path':'docs/note.md',
            'content':'---\ntitle: Note\nstatus: draft\n---\n# Heading'})
        self.assertEqual(complete.stdout,b'')


if __name__=='__main__':
    unittest.main()
