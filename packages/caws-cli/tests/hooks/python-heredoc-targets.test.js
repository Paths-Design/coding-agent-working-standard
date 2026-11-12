const path = require('node:path');
const { spawnSync } = require('node:child_process');

const library = path.resolve(
  __dirname,
  '../../templates/hook-packs/shared/lib/bash-mutation-targets.sh'
);
const heredoc = path.resolve(__dirname, '../../templates/hook-packs/shared/lib/heredoc.sh');

// Commands are inert inputs to the recognizer. Never execute the Python body.
function inspect(command, api = 'caws_bash_mutation_candidates') {
  const result = spawnSync(
    '/bin/bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      'source "$1"; source "$2"; "$3" "$4"',
      '_',
      heredoc,
      library,
      api,
      command,
    ],
    {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, CAWS_BASH_ANALYSIS_REQUIRED: '0' },
    }
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return result.stdout.trim().split('\n').filter(Boolean);
}

const body = `from pathlib import Path
p = Path('/tmp/owned/test.cs')
p.write_text('''// The receiver's contact is fixture data.
Assert.That(load > 0f);
// rm /tmp/data-only.txt
''')`;
const command = (header = "python3 - <<'PY'", payload = body) => `${header}\n${payload}\nPY`;

test.each(["python3 - <<'PY'", 'python3 <<"PY"', "python <<'PY'", "python3.12 - <<'PY'"])(
  'Python data is not an outer-shell target: %s',
  (header) => {
    expect(inspect(command(header))).toEqual([]);
  }
);

test('the raw Python payload retains its actual literal write path', () => {
  expect(inspect(command(), 'caws_bash_interpreter_write_literals')).toEqual([
    '/tmp/owned/test.cs',
  ]);
});

test('Python comments and replacement data do not fabricate write paths', () => {
  const payload = body.replace('// The receiver', '// Preserve points/colliders. The receiver');
  expect(inspect(command(undefined, payload), 'caws_bash_interpreter_write_literals')).toEqual([
    '/tmp/owned/test.cs',
  ]);
});

test('interpreter writes after a literal Python program remain visible', () => {
  const suffix = `\npython3 -c "from pathlib import Path; Path('/tmp/suffix.txt').write_text('x')"`;
  expect(
    [...new Set(inspect(command() + suffix, 'caws_bash_interpreter_write_literals'))].sort()
  ).toEqual(['/tmp/owned/test.cs', '/tmp/suffix.txt']);
});

test('a real shell write after the terminator remains visible', () => {
  expect(inspect(command() + '\necho changed > /tmp/outer.txt')).toEqual(['/tmp/outer.txt']);
});

test.each([
  'python3 - <<PY',
  "python3 - <<-'PY'",
  "env python3 - <<'PY'",
  "python3 - <<'PY' > /tmp/output.txt",
  "python3 - <<'PY' <<'OTHER'",
  "alias python3=sh; python3 - <<'PY'",
])('ambiguous or expanding input retains conservative visibility: %s', (header) => {
  expect(inspect(command(header))).toContain('0f');
});

test('an unfinished quoted heredoc retains conservative visibility', () => {
  expect(inspect("python3 - <<'PY'\n" + body)).toContain('0f');
});

test('shell interpreter payloads keep their real write targets', () => {
  expect(inspect("bash <<'PY'\necho changed > /tmp/shell.txt\nPY")).toEqual(['/tmp/shell.txt']);
});

test('a shell prefix is retained rather than assuming Python lookup', () => {
  expect(inspect('echo changed > /tmp/before.txt\n' + command())).toContain('/tmp/before.txt');
});
