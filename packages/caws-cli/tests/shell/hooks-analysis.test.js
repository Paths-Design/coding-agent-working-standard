const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = path.resolve(__dirname, '../../dist/index.js');
const linkedRepository = require('../fixtures/command-analysis/git-fixture.cjs');
describe('hooks analyze public CLI', () => {
  let root, own, foreign;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-analysis-cli-'));
    own = path.join(root, '.caws/worktrees/own');
    foreign = path.join(root, '.caws/worktrees/foreign');
    linkedRepository(root, [own, foreign]);
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  function run(input, args = [], env = {}) {
    const child = spawnSync(
      process.execPath,
      [cli, 'hooks', 'analyze', '--json', '--worktree', own, ...args],
      {
        input: typeof input === 'string' ? input : JSON.stringify(input),
        encoding: 'utf8',
        env: { ...process.env, ...env },
        shell: false,
        timeout: 15000,
      }
    );
    if (child.error) throw child.error;
    expect(child.stderr).toBe('');
    const result = JSON.parse(child.stdout);
    expect(result.schema).toBe('caws.hooks_analyze.v1');
    return { status: child.status, ...result };
  }
  test('native Bash value keeps quotes, Unicode and substitution text inert', () => {
    const command = "printf '%s' 'λ $(touch " + path.join(root, 'executed') + ")'";
    const result = run({ tool_name: 'Bash', cwd: own, tool_input: { command } });
    expect(result.status).toBe(0);
    expect(
      result.trace
        .filter((item) => item.kind === 'command')
        .map((item) => command.slice(item.start, item.end))
    ).toContain(command);
    expect(fs.existsSync(path.join(root, 'executed'))).toBe(false);
  });
  test('trusted pin overrides a foreign payload pin', () => {
    const result = run({ cwd: own, worktree: foreign, command: `git -C '${foreign}' status` });
    expect(result.status).toBe(1);
    expect(result.decision).toBe('deny');
  });
  test.each([undefined, null, 17, ''])('native cwd cannot fall back from %s', (cwd) => {
    const result = run({ tool_name: 'Bash', cwd, tool_input: { command: 'printf x' } });
    expect(result.decision).toBe('unresolved');
    expect(result.reasons[0].code).toBe('invalid-cwd');
  });
  test.each(['{', 'null', '[]', JSON.stringify({ cwd: own, command: 17 })])(
    'invalid input is unresolved: %s',
    (input) => {
      const result = run(input);
      expect(result.status).toBe(2);
      expect(result.decision).toBe('unresolved');
      expect(result.reasons.length).toBeGreaterThan(0);
    }
  );
  test.each(['exec_command', 'functions.exec_command', 'shell_command'])(
    'native %s requires a known dialect',
    (tool_name) => {
      const request = { tool_name, cwd: own, tool_input: { cmd: 'printf x' } };
      expect(run(request).decision).toBe('unresolved');
      expect(run({ ...request, tool_input: { cmd: 'printf x', shell: '/bin/zsh' } }).decision).toBe(
        'unresolved'
      );
      expect(
        run({ ...request, tool_input: { cmd: 'printf x', shell: '/bin/bash' } }).decision
      ).toBe('unresolved');
      expect(
        run({ ...request, tool_input: { cmd: 'printf x', shell: '/bin/bash', login: false } })
          .decision
      ).toBe('allow');
    }
  );
  test('native workdir determines actual execution cwd despite trusted base cwd', () => {
    const result = run(
      {
        tool_name: 'exec_command',
        cwd: own,
        tool_input: { cmd: 'git status', workdir: foreign, shell: '/bin/bash', login: false },
      },
      ['--cwd', own]
    );
    expect(result.decision).toBe('deny');
    expect(result.reasons.some((item) => item.code === 'foreign-git-target')).toBe(true);
  });
  test('conflicting native command fields cannot hide the executed source', () => {
    const result = run({
      tool_name: 'exec_command',
      cwd: own,
      tool_input: {
        cmd: `git -C '${foreign}' status`,
        command: 'printf x',
        shell: '/bin/bash',
        login: false,
      },
    });
    expect(result.decision).toBe('unresolved');
    expect(result.reasons[0].code).toBe('conflicting-command-fields');
  });
  test('inherited function shadowing a profiled tool refuses admission', () => {
    const result = run({ cwd: own, command: 'sed -n 1p file' }, [], {
      'BASH_FUNC_sed%%': '() { printf fake; }',
    });
    expect(result.decision).toBe('unresolved');
    expect(result.reasons.some((item) => item.code === 'inherited-environment')).toBe(true);
  });
});
