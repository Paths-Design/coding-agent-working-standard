"""Operand-role counterexamples. Commands remain arguments, never shell code."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SHARED = Path(__file__).resolve().parents[3] / 'templates/hook-packs/shared'


class BashMutationBoundary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='caws-operand-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()

    def scan(self, command, channel='caws_bash_mutation_candidates', cwd=None):
        result = subprocess.run(['/bin/bash', '-c',
            'set -u; source "$1"; source "$2"; "$3" "$4" "$5"', '-',
            str(SHARED / 'lib/heredoc.sh'), str(SHARED / 'lib/bash-mutation-targets.sh'),
            channel, command, str(self.base)], cwd=cwd or self.base,
            env={'PATH': os.environ['PATH']}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.splitlines() if result.stdout.strip() else []

    def test_arguments_named_like_verbs_do_not_become_mutations(self):
        for command in ('echo rm victim.txt', 'printf "%s" touch victim.txt',
                        'rg -n "rm" README.md', 'echo git restore victim.txt'):
            with self.subTest(command=command):
                self.assertEqual(self.scan(command), [])

    def test_executable_positions_remain_visible(self):
        for command in ('touch victim.txt', '/usr/bin/touch victim.txt',
                        'A=1 touch victim.txt', 'env -u A touch victim.txt',
                        'command -- touch victim.txt', 'echo label; touch victim.txt',
                        'if true; then touch victim.txt; fi'):
            with self.subTest(command=command):
                self.assertEqual(self.scan(command), ['victim.txt'])

    def test_quoted_paths_and_quoted_operators_are_not_split(self):
        self.assertEqual(self.scan('touch "a b.txt" "literal*name"'), ['a b.txt', 'literal*name'])
        self.assertEqual(self.scan('echo ">" "rm victim"'), [])
        self.assertEqual(self.scan('echo text > "a b.txt"'), ['a b.txt'])

    def test_redirections_do_not_end_argv_or_supply_option_values(self):
        cases = {
            'touch < input.txt target.txt': ['target.txt'],
            'touch first.txt > output.log second.txt': ['output.log', 'first.txt', 'second.txt'],
            'touch -r < input.txt reference.txt target.txt': ['target.txt'],
            'cp source.txt > output.log target.txt': ['output.log', 'target.txt'],
            'cp source.txt target.txt 2>> output.log': ['output.log', 'target.txt'],
            'cp 0< input.txt source.txt target.txt': ['target.txt'],
            'touch "2"> output.log': ['output.log', '2'],
            'touch \\2> output.log': ['output.log', '2'],
            'touch target.txt>&2': ['target.txt'],
            "sed -i -e < input.txt 's/a/b/' target.txt": ['target.txt'],
            'tee first.log > second.log third.log': ['second.log', 'first.log', 'third.log'],
            'git < input.txt restore target.txt': ['target.txt'],
            'cat < input.txt > output.log': ['output.log'],
            'echo "touch target.txt" > output.log': ['output.log'],
        }
        for command, targets in cases.items():
            with self.subTest(command=command):
                self.assertEqual(self.scan(command), targets)
        dynamic = self.scan('touch < input.txt "$TARGET"', 'caws_bash_dynamic_mutations')
        self.assertEqual(dynamic, ['$TARGET\tparameter\t\tnone\t' + str(self.base)])

    def test_absolute_wrappers_preserve_the_executable_position(self):
        for command in ('/usr/bin/env touch target.txt',
                        '/usr/bin/env -u NAME A=1 /usr/bin/touch target.txt',
                        'command /usr/bin/env touch target.txt'):
            with self.subTest(command=command):
                self.assertEqual(self.scan(command), ['target.txt'])
        self.assertEqual(self.scan('echo /usr/bin/env touch target.txt'), [])

    def test_multiple_nested_spans_keep_their_own_token_boundaries(self):
        command = 'echo "$(touch first.txt)$(touch \'second file.txt\')$(touch third.txt)"'
        self.assertEqual(self.scan(command), ['first.txt', 'second file.txt', 'third.txt'])

    def test_dynamic_and_unrepresentable_operands_have_separate_channels(self):
        self.assertEqual(self.scan('rm core/*.py'), [])
        records = self.scan('rm core/*.py', 'caws_bash_dynamic_mutations')
        self.assertEqual(records, ['core/*.py\tpathname\tcore/\tlexically_proven\t' + str(self.base)])
        self.assertEqual(self.scan("touch $'a\\nb'", 'caws_bash_unrepresentable_count'), ['1'])

    def test_heredoc_data_is_inert_but_its_redirection_is_visible(self):
        self.assertEqual(self.scan("cat > out.txt <<'EOF'\nrm victim.txt\nEOF"), ['out.txt'])
        self.assertEqual(self.scan('echo "$(touch nested.txt)"'), ['nested.txt'])

    def test_ambient_files_do_not_expand_pending_nested_spans(self):
        (self.base / 'ambient.py').write_text('unchanged')
        empty = self.base / 'empty'
        empty.mkdir()
        command = 'echo "$(true)$(touch *.py)$(touch end.txt)"'
        with_files = self.scan(command, 'caws_bash_dynamic_mutations')
        self.assertEqual(with_files, self.scan(command, 'caws_bash_dynamic_mutations', cwd=empty))
        self.assertEqual((self.base / 'ambient.py').read_text(), 'unchanged')

    def test_option_values_and_copy_sources_are_not_mutation_targets(self):
        cases = {
            'touch -r reference.txt -d yesterday target.txt': ['target.txt'],
            'truncate -s 4K target.txt': ['target.txt'],
            'cp foreign.txt owned.txt': ['owned.txt'],
            'cp -t owned foreign-a foreign-b': ['owned'],
            'mv foreign.txt owned.txt': ['foreign.txt', 'owned.txt'],
            'rm -- -filename': ['-filename'],
            "sed -i -e 's/a/b/' first.txt second.txt": ['first.txt', 'second.txt'],
            "sed -i '' 's/a/b/' first.txt second.txt": ['first.txt', 'second.txt'],
            "perl -pi -e 's/a/b/' first.txt second.txt": ['first.txt', 'second.txt'],
        }
        for command, targets in cases.items():
            with self.subTest(command=command):
                self.assertEqual(self.scan(command), targets)

    def test_nested_execution_comments_and_input_redirects(self):
        cases = {
            'echo `touch nested.txt`': ['nested.txt'],
            'echo "$(printf \')\'; touch nested.txt)"': ['nested.txt'],
            '(touch nested.txt)': ['nested.txt'],
            'echo label # touch prose.txt': [],
            'cat < touch': [],
            'touch one.txt < input.txt': ['one.txt'],
        }
        for command, targets in cases.items():
            with self.subTest(command=command):
                self.assertEqual(self.scan(command), targets)

    def test_changed_coordinates_and_dynamic_dd_do_not_become_literal_paths(self):
        self.assertEqual(self.scan('cd elsewhere; touch relative.txt'), [])
        self.assertEqual(self.scan('cd elsewhere; touch relative.txt',
                                   'caws_bash_unsupported_nesting'), ['changed_working_directory'])
        self.assertEqual(self.scan('cd elsewhere; wc -l relative.txt',
                                   'caws_bash_unsupported_nesting'), [])
        self.assertEqual(self.scan('dd if=source of="$DEST"'), [])
        self.assertTrue(self.scan('dd if=source of="$DEST"', 'caws_bash_dynamic_mutations'))
        self.assertEqual(self.scan('git -C elsewhere restore target.txt'), [])
        self.assertEqual(self.scan('git -C elsewhere restore target.txt',
                                   'caws_bash_unsupported_nesting'), ['changed_working_directory'])
        self.assertEqual(self.scan('git restore --source HEAD first.txt second.txt'),
                         ['first.txt', 'second.txt'])


if __name__ == '__main__':
    unittest.main()
