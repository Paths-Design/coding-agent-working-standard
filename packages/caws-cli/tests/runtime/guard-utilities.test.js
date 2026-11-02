const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  parseGuardUtilityPolicy,
  createGuardUtilityPorts,
  evaluateGuardUtilities,
  runGuardUtilities,
} = require('../../dist/runtime/guard-utilities');

const configuration = {
  version: 1,
  rg_replace: true,
  ignored_staging: true,
  focused_tests: { entry_point: 'scripts/test --focused', executables: ['pytest', 'jest'] },
  documents: { roots: ['docs/'], required_frontmatter: ['title', 'status'] },
};
const input = (command, cwd = '/project') => ({ tool: 'Bash', toolInput: { command }, cwd });
const makePorts = (overrides = {}) => ({
  gitContextKnown: true,
  realpath: (value) => path.resolve(value),
  git: jest.fn(() => ({ status: 0, stdout: Buffer.alloc(0) })),
  readPathspec: jest.fn(() => Buffer.alloc(0)),
  ...overrides,
});
const evaluate = (command, ports = makePorts()) =>
  evaluateGuardUtilities(configuration, input(command), ports);
const native = (command, ports = makePorts()) =>
  runGuardUtilities(JSON.stringify(configuration), input(command), ports);
const output = (result) => JSON.parse(Buffer.from(result.stdout).toString('utf8'));

describe('optional guard utilities', () => {
  test('absence is silent without attempting lexer, cwd or Git IO', () => {
    const ports = makePorts({
      realpath: () => {
        throw new Error('must not resolve');
      },
    });
    expect(runGuardUtilities(null, input("'unterminated"), ports)).toEqual({
      exitCode: 0,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    });
    expect(ports.git).not.toHaveBeenCalled();
  });

  test.each([
    'null',
    '[]',
    '{',
    '{"version":true}',
    '{"version":1,"unknown":true}',
    '{"version":1,"rg_replace":1}',
    '{"version":1,"ignored_staging":"yes"}',
    '{"version":1,"focused_tests":[]}',
    '{"version":1,"focused_tests":{"entry_point":5,"executables":[]}}',
    '{"version":1,"focused_tests":{"entry_point":"run","executables":[5]}}',
    '{"version":1,"documents":{"roots":"docs/"}}',
    '{"version":1,"documents":{"required_frontmatter":[5]}}',
  ])('malformed policy remains informational: %s', (text) => {
    const ports = makePorts();
    const result = runGuardUtilities(text, input('git add -f secret'), ports);
    expect(result.exitCode).toBe(0);
    expect(output(result).hookSpecificOutput.additionalContext).toMatch(
      /^Optional utility analysis incomplete:/
    );
    expect(ports.git).not.toHaveBeenCalled();
  });

  test('empty optional objects preserve quiet behavior', () => {
    expect(parseGuardUtilityPolicy('{"version":1,"focused_tests":{},"documents":{}}')).toEqual({
      version: 1,
      focused_tests: {},
      documents: {},
    });
    expect(runGuardUtilities('{"version":1}', input('echo safe'), makePorts()).stdout).toEqual(
      new Uint8Array()
    );
  });

  test.each([
    'rg -rn needle file',
    'env -u UNUSED /usr/bin/rg --replace=n needle file',
    'echo "$(rg -r n needle file)"',
    'echo `rg -r n needle file`',
    'rg -nr needle file',
    'command -- rg --replace n needle file',
  ])('detects actual ripgrep replacement: %s', (command) => {
    const result = native(command);
    expect(result.exitCode).toBe(0);
    expect(output(result).hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      additionalContext:
        'Ripgrep replacement is active: displayed matches are transformed. -r means --replace, not recursive.',
    });
  });

  test.each([
    'echo rg -rn needle file',
    'rg -e "-rn" file',
    'rg -- -rn file',
    'rg -g "*-rn" needle file',
    'rg -e-rn file',
    'rg -Ar needle file',
    "echo '$(rg -rn needle file)'",
    'echo safe > "rg -rn file"',
    '# rg -rn file\necho safe',
  ])('does not promote operands or literal text into replacement: %s', (command) => {
    expect(native(command).stdout).toEqual(new Uint8Array());
  });

  test('advice deduplicates at native output boundary and never claims resource admission', () => {
    const result = native('python3 -m pytest tests/a.py; pytest tests/b.py; jest tests/c.js');
    expect(output(result).hookSpecificOutput.additionalContext).toBe(
      'Consumer focused-test entry point: scripts/test --focused. This notice does not grant resource admission.'
    );
    expect(evaluate('echo python3 -m pytest').notices).toEqual([]);
  });

  test('blocking native response retains an observed violation across a later uncertain command', () => {
    const ports = makePorts({
      git: jest.fn(() => ({ status: 0, stdout: Buffer.from('secret.generated\0') })),
      readPathspec: () => {
        throw new Error('missing file');
      },
    });
    const result = native(
      'git add -f secret.generated; git add -f --pathspec-from-file=missing',
      ports
    );
    expect(result.exitCode).toBe(2);
    expect(output(result)).toEqual({
      decision: 'block',
      reason: 'Consumer ignored-staging policy: secret.generated',
    });
    expect(result.stderr).toEqual(new Uint8Array());
  });

  test('already observed cached ignored paths survive later query failure', () => {
    const ports = makePorts({
      git: jest
        .fn()
        .mockReturnValueOnce({ status: 0, stdout: Buffer.from('cached.generated\0') })
        .mockReturnValueOnce({ status: 1, stdout: Buffer.alloc(0) }),
    });
    const result = evaluate('git add -f -A', ports);
    expect(result.violations).toEqual(['Consumer ignored-staging policy: cached.generated']);
    expect(result.notices).toEqual([
      'Ignored-staging check unresolved: read-only Git ignored-path query failed.',
    ]);
  });

  test('Git option operands, literal pathspecs, update mode and delimiters reach fixed read-only queries', () => {
    const ports = makePorts();
    expect(
      evaluate('git -C "sub dir" --literal-pathspecs add -fu -- --odd.generated', ports)
    ).toEqual({ notices: [], violations: [] });
    expect(ports.git.mock.calls).toEqual([
      [
        [
          '--literal-pathspecs',
          '--no-optional-locks',
          '-c',
          'core.fsmonitor=false',
          '-C',
          '/project/sub dir',
          'ls-files',
          '--cached',
          '--ignored',
          '--exclude-standard',
          '-z',
          '--',
          '--odd.generated',
        ],
        '/project/sub dir',
      ],
    ]);
  });

  test.each([
    'git add .',
    'git add -fn secret.generated',
    'echo git add -f secret.generated',
    'git -c core.quotePath=false status',
    'git status',
  ])('ordinary, inert and dry-run controls issue no query: %s', (command) => {
    const ports = makePorts();
    expect(evaluate(command, ports)).toEqual({ notices: [], violations: [] });
    expect(ports.git).not.toHaveBeenCalled();
  });

  test.each([
    'git add -fp secret.generated',
    'git add -f "$TARGET"',
    'git add -f *.generated',
    'git -c core.worktree=/other add -f secret.generated',
    'git add -f --pathspec-from-file',
    'git add -f --pathspec-from-file=-',
    'git add -f --unknown secret.generated',
  ])(
    'unsupported/dynamic forced staging is unresolved rather than fabricated denial: %s',
    (command) => {
      const ports = makePorts();
      const result = evaluate(command, ports);
      expect(result.violations).toEqual([]);
      expect(result.notices).toEqual([expect.stringMatching(/^Ignored-staging check unresolved:/)]);
      expect(ports.git).not.toHaveBeenCalled();
    }
  );

  test.each([
    '(cd sub); git add -f secret.generated',
    'cd "$WHERE" && git add -f secret.generated',
    'if cd sub; then git add -f secret.generated; fi',
    'env -C /other git add -f secret.generated',
    'env --chdir=/other git add -f secret.generated',
    'GIT_DIR=/other git add -f secret.generated',
    'export GIT_WORK_TREE=/other; git add -f secret.generated',
    'GIT_DIR=/other; git add -f secret.generated',
    'pushd /other; git add -f secret.generated',
  ])('unproven coordinates cannot query the original index: %s', (command) => {
    const ports = makePorts();
    const result = evaluate(command, ports);
    expect(result.violations).toEqual([]);
    expect(result.notices).toContain('Ignored-staging check unresolved: shell cwd is dynamic.');
    expect(ports.git).not.toHaveBeenCalled();
  });

  test('inherited Git context cannot borrow the parent coordinate', () => {
    const ports = makePorts({ gitContextKnown: false });
    expect(evaluate('git add -f secret.generated', ports).notices).toEqual([
      'Ignored-staging check unresolved: shell cwd is dynamic.',
    ]);
    expect(ports.git).not.toHaveBeenCalled();
  });

  test('executable substitutions use their invocation cwd without leaking their cd into the parent', () => {
    const ports = makePorts({
      git: jest.fn(() => ({ status: 0, stdout: Buffer.from('secret.generated\0') })),
    });
    const result = evaluate(
      'echo "$(cd sub && git add -f secret.generated)"; git add -f secret.generated',
      ports
    );
    expect(result.violations).toEqual([
      'Consumer ignored-staging policy: secret.generated',
      'Consumer ignored-staging policy: secret.generated',
    ]);
    expect(ports.git.mock.calls.map((call) => call[1])).toEqual([
      '/project/sub',
      '/project/sub',
      '/project',
      '/project',
    ]);
    const moved = makePorts();
    evaluate('cd sub && echo "$(git add -f secret.generated)"', moved);
    expect(moved.git.mock.calls.map((call) => call[1])).toEqual(['/project/sub', '/project/sub']);
  });

  test('static cd and escaped dollar filenames preserve known coordinates', () => {
    const ports = makePorts();
    expect(
      evaluate('cd "sub dir" && git add -f "literal\\$name.generated" > capture', ports)
    ).toEqual({ notices: [], violations: [] });
    expect(ports.git.mock.calls[0][0].slice(-2)).toEqual(['--', 'literal$name.generated']);
    expect(ports.git.mock.calls[0][1]).toBe('/project/sub dir');
  });

  test('ANSI-C quoted static operands retain bytes and arithmetic executes only its nested substitutions', () => {
    const ports = makePorts({
      git: jest.fn(() => ({ status: 0, stdout: Buffer.from('line\nfile.generated\0') })),
    });
    expect(evaluate("git add -f $'line\\nfile.generated'", ports).violations).toEqual([
      'Consumer ignored-staging policy: line\nfile.generated',
    ]);
    expect(ports.git.mock.calls[0][0].slice(-1)).toEqual(['line\nfile.generated']);
    const utf8 = makePorts();
    evaluate("git add -f $'\\xc3\\xa9.generated'", utf8);
    expect(utf8.git.mock.calls[0][0].slice(-1)).toEqual(['é.generated']);
    const invalid = makePorts();
    const invalidResult = native("git add -f $'\\xff.generated'", invalid);
    expect(invalidResult.exitCode).toBe(0);
    expect(output(invalidResult).hookSpecificOutput.additionalContext).toMatch(
      /^Optional utility analysis incomplete:/
    );
    expect(invalid.git).not.toHaveBeenCalled();
    const nested = makePorts({
      git: () => ({ status: 0, stdout: Buffer.from('secret.generated\0') }),
    });
    expect(evaluate('echo "$((1 + $(git add -f secret.generated)))"', nested).violations).toEqual([
      'Consumer ignored-staging policy: secret.generated',
    ]);
    const inert = makePorts();
    expect(evaluate('echo "$((1 + 2))"', inert)).toEqual({ notices: [], violations: [] });
    expect(inert.git).not.toHaveBeenCalled();
  });

  test('NUL pathspec bytes retain newlines, while quoted line records and malformed UTF8 decline analysis', () => {
    const ports = makePorts({
      readPathspec: jest.fn(() => Buffer.from('a\nb.generated\0c.generated\0')),
    });
    evaluate('git add -f --pathspec-from-file=paths --pathspec-file-nul', ports);
    expect(ports.git.mock.calls[0][0].slice(-3)).toEqual(['--', 'a\nb.generated', 'c.generated']);
    expect(ports.readPathspec).toHaveBeenCalledWith('/project/paths');
    for (const bytes of [
      Buffer.from('"quoted.generated"\n'),
      Buffer.from('a\\b.generated\n'),
      Buffer.from([0xff]),
    ]) {
      const invalid = makePorts({ readPathspec: () => bytes });
      expect(evaluate('git add -f --pathspec-from-file=paths', invalid).notices).toEqual([
        expect.stringMatching(/^Ignored-staging check unresolved:/),
      ]);
      expect(invalid.git).not.toHaveBeenCalled();
    }
  });

  test('invalid Git path bytes are unresolved and cannot invent a replacement-character filename', () => {
    const ports = makePorts({ git: () => ({ status: 0, stdout: Buffer.from([0xff, 0]) }) });
    const result = evaluate('git add -f secret.generated', ports);
    expect(result.violations).toEqual([]);
    expect(result.notices).toEqual([expect.stringMatching(/^Ignored-staging check unresolved:/)]);
  });

  test('document metadata checks the frontmatter only and excludes outside absolute files', () => {
    const check = (file_path, content) =>
      evaluateGuardUtilities(
        configuration,
        { tool: 'Write', toolInput: { file_path, content }, cwd: '/project' },
        makePorts()
      );
    expect(check('docs/design.md', '# Body\ntitle: body only\nstatus: body only')).toEqual({
      notices: ['Consumer document metadata missing: title, status.'],
      violations: [],
    });
    expect(check('/project/docs/design.md', '---\ntitle: Design\n---\nstatus: body')).toEqual({
      notices: ['Consumer document metadata missing: status.'],
      violations: [],
    });
    expect(check('docs/design.md', '---\ntitle: Design\nstatus: draft\n---\nBody')).toEqual({
      notices: [],
      violations: [],
    });
    expect(check('/elsewhere/docs/design.md', '')).toEqual({ notices: [], violations: [] });
    expect(check('src/design.md', '')).toEqual({ notices: [], violations: [] });
  });

  test('frontmatter keys are literals, not regular expressions', () => {
    const policy = { version: 1, documents: { roots: ['docs/'], required_frontmatter: ['a.b'] } };
    const document = (content) =>
      evaluateGuardUtilities(
        policy,
        { tool: 'Write', toolInput: { file_path: 'docs/a.md', content }, cwd: '/project' },
        makePorts()
      );
    expect(document('---\naXb: wrong\n---').notices).toEqual([
      'Consumer document metadata missing: a.b.',
    ]);
    expect(document('---\na.b: correct\n---').notices).toEqual([]);
  });

  test('malformed shell explicitly declines optional analysis', () => {
    const ports = makePorts();
    const result = native("git add -f 'broken", ports);
    expect(result.exitCode).toBe(0);
    expect(output(result).hookSpecificOutput.additionalContext).toMatch(
      /^Optional utility analysis incomplete:/
    );
    expect(ports.git).not.toHaveBeenCalled();
  });

  test('heredoc file-sink text is inert, while Git stdin and interpreter commands retain protection', () => {
    const inert = makePorts();
    expect(evaluate("cat <<'EOF'\ngit add -f secret.generated\nEOF", inert)).toEqual({
      notices: [],
      violations: [],
    });
    expect(inert.git).not.toHaveBeenCalled();
    for (const command of [
      "git add -f secret.generated <<'EOF'\nunused input\nEOF",
      "bash <<'EOF'\ngit add -f secret.generated\nEOF",
      'tee /tmp/capture <<-EOF\n\tgit add -f other.generated\n\tEOF\ngit add -f secret.generated',
    ]) {
      const ports = makePorts({
        git: () => ({ status: 0, stdout: Buffer.from('secret.generated\0') }),
      });
      expect(evaluate(command, ports).violations).toEqual([
        'Consumer ignored-staging policy: secret.generated',
      ]);
    }
  });
});

describe('guard utility read-only native adapter', () => {
  let directory;
  let environment;
  let ports;
  const git = (...args) =>
    execFileSync('git', args, { cwd: directory, env: environment, encoding: 'utf8' });
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-guard-utilities-'));
    environment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => !key.startsWith('GIT_') && typeof value === 'string'
      )
    );
    git('init', '-q');
    fs.writeFileSync(path.join(directory, '.gitignore'), '*.generated\n');
    fs.writeFileSync(path.join(directory, 'owned.py'), 'owned\n');
    fs.writeFileSync(path.join(directory, 'private.generated'), 'private sentinel\n');
    fs.mkdirSync(path.join(directory, 'sub dir'));
    fs.writeFileSync(path.join(directory, 'sub dir/nested.generated'), 'nested sentinel\n');
    fs.writeFileSync(path.join(directory, 'sub dir/paths.nul'), 'nested.generated\0');
    git('add', 'owned.py', '.gitignore');
    ports = createGuardUtilityPorts(environment);
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  test.each([
    'git add -f private.generated',
    'git add -f -A',
    'git -C "sub dir" add -f --pathspec-from-file=paths.nul --pathspec-file-nul',
    'cd "sub dir" && git add -f nested.generated',
  ])('observes ignored staging without changing index or files: %s', (command) => {
    const before = fs.readFileSync(path.join(directory, '.git/index'));
    const result = runGuardUtilities(
      JSON.stringify(configuration),
      input(command, directory),
      ports
    );
    expect(result.exitCode).toBe(2);
    expect(output(result).decision).toBe('block');
    expect(output(result).reason).toMatch(/Consumer ignored-staging policy: .*generated/);
    expect(fs.readFileSync(path.join(directory, '.git/index'))).toEqual(before);
    expect(fs.readFileSync(path.join(directory, 'private.generated'), 'utf8')).toBe(
      'private sentinel\n'
    );
    expect(fs.readFileSync(path.join(directory, 'sub dir/nested.generated'), 'utf8')).toBe(
      'nested sentinel\n'
    );
  });

  test.each([
    'git add .',
    'git add -f owned.py',
    'git add -fn private.generated',
    'git add -fu private.generated',
    'git --literal-pathspecs add -f "*.generated"',
  ])('real Git negative control remains quiet: %s', (command) => {
    expect(
      runGuardUtilities(JSON.stringify(configuration), input(command, directory), ports).stdout
    ).toEqual(new Uint8Array());
  });

  test('pathspec reader rejects symlink, FIFO, oversized bytes, and enforces a finite deadline', () => {
    const normal = path.join(directory, 'normal');
    fs.writeFileSync(normal, 'a\0b\0');
    expect(Buffer.from(ports.readPathspec(normal))).toEqual(Buffer.from('a\0b\0'));
    fs.symlinkSync(normal, path.join(directory, 'link'));
    expect(() => ports.readPathspec(path.join(directory, 'link'))).toThrow();
    expect(() => ports.readPathspec(directory)).toThrow('not a regular file');
    fs.writeFileSync(path.join(directory, 'large'), Buffer.alloc(1024 * 1024 + 1));
    expect(() => ports.readPathspec(path.join(directory, 'large'))).toThrow(
      'exceeds utility budget'
    );
    execFileSync('mkfifo', [path.join(directory, 'fifo')]);
    expect(() => ports.readPathspec(path.join(directory, 'fifo'))).toThrow('not a regular file');
    expect(createGuardUtilityPorts(environment, Date.now() - 1).git(['status'], directory)).toEqual(
      { status: -1, stdout: new Uint8Array() }
    );
  });

  test('adapter snapshots explicit environment and flags inherited Git context without mutating globals', () => {
    const before = process.env.GIT_OPTIONAL_LOCKS;
    const external = { ...environment, GIT_CONFIG_COUNT: '1' };
    const unknown = createGuardUtilityPorts(external);
    external.GIT_CONFIG_COUNT = '';
    expect(unknown.gitContextKnown).toBe(false);
    expect(createGuardUtilityPorts({ ...environment, GIT_CONFIG_COUNT: '' }).gitContextKnown).toBe(
      true
    );
    expect(process.env.GIT_OPTIONAL_LOCKS).toBe(before);
  });
});
