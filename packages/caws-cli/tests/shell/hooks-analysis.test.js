const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clearTimeout, setTimeout } = require('node:timers');
const { spawn, spawnSync } = require('node:child_process');
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
  function runMutation(input, args = [], env = {}) {
    const child = spawnSync(
      process.execPath,
      [cli, 'hooks', 'mutation-view', '--json', '--project', root, '--cwd', own, ...args],
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
    expect(result.schema).toBe('caws.shell_mutation_view.v1');
    expect(Object.prototype.hasOwnProperty.call(result, 'execution')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result, 'singleLifecycle')).toBe(true);
    return { status: child.status, ...result };
  }
  function runChunked(verb, chunks) {
    return new Promise((resolve, reject) => {
      const args = verb === 'analyze' ? ['--worktree', own] : ['--project', root, '--cwd', own];
      const child = spawn(process.execPath, [cli, 'hooks', verb, '--json', ...args], {
        env: { ...process.env },
        shell: false,
        timeout: 15000,
      });
      let stdout = '',
        stderr = '',
        inputError,
        timer,
        next = 0;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.stdin.on('error', (error) => {
        inputError = error;
      });
      child.once('error', reject);
      child.once('close', (status) => {
        clearTimeout(timer);
        try {
          expect(stderr).toBe('');
          expect(inputError).toBeUndefined();
          resolve({ status, ...JSON.parse(stdout) });
        } catch (error) {
          reject(error);
        }
      });
      function writeNext() {
        if (next === chunks.length) {
          child.stdin.end();
          return;
        }
        child.stdin.write(chunks[next++]);
        timer = setTimeout(writeNext, next === 1 ? 1000 : 20);
      }
      writeNext();
    });
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
  test('missing Git is an infrastructure refusal, not an opaque source explanation', () => {
    const result = run({ cwd: own, command: 'git status' }, [], {
      PATH: path.join(root, 'missing-bin'),
    });
    expect(result.status).toBe(2);
    expect(result.reasons.map((item) => item.code)).toContain('git-discovery-failed');
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
  test('native cwd cannot be replaced with a harmless CLI fallback', () => {
    const result = run({ tool_name: 'Bash', cwd: foreign, tool_input: { command: 'git status' } }, [
      '--cwd',
      own,
    ]);
    expect(result.decision).toBe('deny');
    expect(result.reasons.map((issue) => issue.code)).toContain('foreign-git-target');
  });
  test('CLI shell cannot erase conflicting native shell metadata', () => {
    const request = {
      tool_name: 'exec_command',
      cwd: own,
      tool_input: { cmd: 'printf x', shell: '/bin/zsh', login: false },
    };
    expect(run(request, ['--shell', 'bash']).decision).toBe('unresolved');
    const result = runMutation(request, ['--shell', 'bash']);
    expect(result.status).toBe(2);
    expect(result.execution).toBeNull();
    expect(result.tokens).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toContain('conflicting-shell-fields');
  });
  test('literal mutation API retains its actual source and nullable coordinate mode', () => {
    const command = 'touch relative.txt';
    const known = runMutation({ command });
    expect(known.status).toBe(0);
    expect(known.execution).toEqual({ command, cwd: fs.realpathSync(own) });
    expect(known.tokens.find((token) => token.value === 'relative.txt').cwd).toBe(
      fs.realpathSync(own)
    );
    const unknown = runMutation({ command }, ['--cwd-unresolved']);
    expect(unknown.status).toBe(0);
    expect(unknown.execution).toEqual({ command, cwd: null });
    expect(unknown.tokens.find((token) => token.value === 'relative.txt').cwd).toBeNull();
    expect(unknown.singleLifecycle).toBeNull();
  });
  test('raw Bash protocol assumption preserves Unicode, quotes and inert substitution bytes', () => {
    const sentinel = path.join(root, 'mutation-executed');
    const command = "printf '%s' 'λ $(touch " + sentinel + ")'";
    const result = runMutation({ tool_name: 'Bash', cwd: own, tool_input: { command } });
    expect(result.status).toBe(0);
    expect(result.execution).toEqual({ command, cwd: fs.realpathSync(own) });
    expect(result.issues).toEqual([]);
    expect(result.tokens.map((token) => token.value)).toContain('λ $(touch ' + sentinel + ')');
    expect(fs.existsSync(sentinel)).toBe(false);
  });
  test.each(['exec_command', 'functions.exec_command', 'shell_command', 'functions.shell_command'])(
    'mutation native %s preserves dialect/startup uncertainty and source equality',
    (tool_name) => {
      const base = { tool_name, cwd: own };
      for (const [tool_input, code] of [
        [{ cmd: 'printf x' }, 'shell-dialect'],
        [{ cmd: 'printf x', shell: '/bin/zsh', login: false }, 'shell-dialect'],
        [{ cmd: 'printf x', shell: '/bin/bash' }, 'shell-startup'],
        [{ cmd: 'printf x', shell: '/bin/bash', login: true }, 'shell-startup'],
        [{ cmd: 'printf x', shell: '/bin/bash', login: 'false' }, 'invalid-input'],
      ]) {
        const result = runMutation({ ...base, tool_input });
        expect(result.status).toBe(2);
        expect(result.execution).toBeNull();
        expect(result.singleLifecycle).toBeNull();
        expect(result.tokens).toEqual([]);
        expect(result.issues.map((issue) => issue.code)).toContain(code);
      }
      const command = 'printf x';
      const result = runMutation({
        ...base,
        tool_input: {
          command,
          cmd: command,
          shell: '/bin/bash',
          login: false,
        },
      });
      expect(result.status).toBe(0);
      expect(result.execution).toEqual({ command, cwd: fs.realpathSync(own) });
      expect(result.issues).toEqual([]);
    }
  );
  test.each([
    { tool_name: 'Bash', tool_input: { command: 'printf safe', cmd: 'touch secret-target' } },
    { tool_name: 'Bash', tool_input: { command: 'printf safe', cmd: null } },
    { tool_name: 'Bash', command: 'printf safe', tool_input: { command: 'touch secret-target' } },
    {
      tool_name: 'exec_command',
      tool_input: { cmd: null, command: 'printf safe', shell: 'bash', login: false },
    },
    { tool_name: 'Bash', tool_input: { command: 17 } },
    { tool_name: 17, tool_input: { command: 'printf safe' } },
    { tool_name: 'Bash', tool_input: null },
  ])('malformed/conflicting envelope has no harmless surrogate projection: %j', (input) => {
    const result = runMutation({ ...input, cwd: own });
    expect(result.status).toBe(2);
    expect(result.execution).toBeNull();
    expect(result.singleLifecycle).toBeNull();
    expect(result.tokens).toEqual([]);
    expect(result.interpreters).toEqual([]);
    expect(result.gitMetadata).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('secret-target');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(2048);
  });
  test.each([
    { shell: null },
    { shell: 17 },
    { shell: '' },
    { shell: 'bash', login: true },
    { shell: 'bash', login: false, topShell: 'zsh' },
  ])('raw Bash cannot hide malformed or incompatible explicit metadata: %j', (metadata) => {
    const { topShell, ...toolMetadata } = metadata;
    const result = runMutation({
      tool_name: 'Bash',
      cwd: own,
      ...(topShell === undefined ? {} : { shell: topShell }),
      tool_input: { command: 'printf x', ...toolMetadata },
    });
    expect(result.status).toBe(2);
    expect(result.execution).toBeNull();
    expect(result.tokens).toEqual([]);
  });
  test('native workdir owns observations despite CLI cwd and unresolved-placeholder flags', () => {
    const command = 'touch relative.txt';
    const result = runMutation(
      {
        tool_name: 'exec_command',
        cwd: own,
        tool_input: {
          cmd: command,
          workdir: foreign,
          shell: 'bash',
          login: false,
        },
      },
      ['--cwd', own, '--cwd-unresolved']
    );
    expect(result.status).toBe(0);
    expect(result.execution).toEqual({ command, cwd: fs.realpathSync(foreign) });
    expect(result.tokens.find((token) => token.value === 'relative.txt').cwd).toBe(
      fs.realpathSync(foreign)
    );
  });
  test('unmodeled execution-context fields remain unresolved without banning ordinary metadata', () => {
    const request = {
      tool_name: 'exec_command',
      cwd: own,
      tool_input: {
        cmd: 'printf safe',
        workdir: own,
        shell: 'bash',
        login: false,
        description: 'ordinary metadata',
        timeout_ms: 1000,
      },
    };
    const ordinary = runMutation(request);
    expect(ordinary.status).toBe(0);
    expect(ordinary.issues).toEqual([]);
    for (const [field, value] of [
      ['cwd', own],
      ['env', {}],
      ['environment', null],
    ]) {
      const result = runMutation({
        ...request,
        tool_input: { ...request.tool_input, [field]: value },
      });
      expect(result.status).toBe(2);
      expect(result.execution).toBeNull();
      expect(result.tokens).toEqual([]);
      expect(result.issues.map((issue) => issue.code)).toContain('unsupported-execution-context');
    }
  });
  test('absolute native workdir is known without a base cwd', () => {
    const command = 'touch relative.txt';
    const result = runMutation({
      tool_name: 'exec_command',
      tool_input: {
        cmd: command,
        workdir: foreign,
        shell: 'bash',
        login: false,
      },
    });
    expect(result.status).toBe(0);
    expect(result.execution).toEqual({ command, cwd: fs.realpathSync(foreign) });
    expect(result.issues).toEqual([]);
  });
  test('relative native workdir uses original base instead of CLI fallback', () => {
    const command = 'touch relative.txt';
    const workdir = '.caws/worktrees/foreign';
    const result = runMutation({
      tool_name: 'exec_command',
      cwd: root,
      tool_input: {
        cmd: command,
        workdir,
        shell: 'bash',
        login: false,
      },
    });
    expect(result.status).toBe(0);
    expect(result.execution).toEqual({ command, cwd: fs.realpathSync(foreign) });
    expect(result.tokens.find((token) => token.value === 'relative.txt').cwd).toBe(
      fs.realpathSync(foreign)
    );
  });
  test('unknown native cwd retains real absolute operands without borrowing CLI cwd', () => {
    const target = path.join(foreign, 'absolute.txt');
    const command = "touch '" + target + "'";
    const result = runMutation({ tool_name: 'Bash', tool_input: { command } });
    expect(result.status).toBe(0);
    expect(result.execution).toEqual({ command, cwd: null });
    expect(result.tokens.find((token) => token.value === target).cwd).toBeNull();
    expect(result.singleLifecycle).toBeNull();
  });
  test.each([null, 17, '', 'relative', '/nonexistent-caws-native-cwd'])(
    'explicit malformed native cwd remains observable: %s',
    (cwd) => {
      const command = "touch '" + path.join(foreign, 'absolute.txt') + "'";
      const result = runMutation({ tool_name: 'Bash', cwd, tool_input: { command } });
      expect(result.execution).toEqual({ command, cwd: null });
      expect(result.issues.map((issue) => issue.code)).toContain('invalid-cwd');
      expect(result.tokens.map((token) => token.value)).toContain(
        path.join(foreign, 'absolute.txt')
      );
      expect(result.singleLifecycle).toBeNull();
    }
  );
  test('relative workdir without native base cannot borrow the project or CLI cwd', () => {
    const command = 'touch /tmp/absolute.txt';
    const result = runMutation({
      tool_name: 'exec_command',
      tool_input: {
        cmd: command,
        workdir: '.caws/worktrees/foreign',
        shell: 'bash',
        login: false,
      },
    });
    expect(result.execution).toEqual({ command, cwd: null });
    expect(result.issues.map((issue) => issue.code)).toContain('invalid-workdir');
    expect(result.singleLifecycle).toBeNull();
  });
  test.each(['analyze', 'mutation-view'])(
    '%s retains decoded source across delayed UTF-8 and escaped JSON chunks',
    async (verb) => {
      const command = "printf '%s' 'λ😀'";
      // Metadata and escaped source representations are not decoded source bytes.
      const wire = Buffer.from(
        JSON.stringify({ command, cwd: own, description: 'm'.repeat(70000) }).replace(
          '😀',
          '\\ud83d\\ude00'
        )
      );
      const split = wire.indexOf(Buffer.from('λ')) + 1;
      const result = await runChunked(verb, [
        wire.subarray(0, split),
        wire.subarray(split, split + 1),
        wire.subarray(split + 1),
      ]);
      expect(result.status).toBe(0);
      if (verb === 'mutation-view') {
        expect(result.issues).toEqual([]);
        expect(result.execution).toEqual({ command, cwd: fs.realpathSync(own) });
        expect(result.tokens.map((token) => token.value)).toContain('λ😀');
      } else {
        expect(result.decision).toBe('allow');
        expect(
          result.trace
            .filter((item) => item.kind === 'command')
            .map((item) => command.slice(item.start, item.end))
        ).toContain(command);
      }
    },
    20000
  );
  test.each([65536, 65537])(
    'chunked source admission measures decoded UTF-8 bytes: %s',
    async (bytes) => {
      const command = 'printf ' + 'x'.repeat(bytes - 7);
      expect(Buffer.byteLength(command, 'utf8')).toBe(bytes);
      const wire = Buffer.from(JSON.stringify({ command }));
      const result = await runChunked('mutation-view', [wire.subarray(0, 1), wire.subarray(1)]);
      if (bytes === 65536) {
        expect(result.status).toBe(0);
        expect(result.issues).toEqual([]);
        expect(result.execution).toEqual({ command, cwd: fs.realpathSync(own) });
      } else {
        expect(result.status).toBe(2);
        expect(result.execution).toBeNull();
        expect(result.singleLifecycle).toBeNull();
        expect(result.tokens).toEqual([]);
        expect(result.issues.map((issue) => issue.code)).toContain('source-budget');
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(2048);
      }
    },
    20000
  );
  test.each([
    ['NUL', 'printf x\0touch hidden'],
    ['oversized', 'printf ' + 'x'.repeat(65536)],
  ])('%s source returns a bounded empty failure', (_label, command) => {
    const result = runMutation({ command });
    expect(result.status).toBe(2);
    expect(result.execution).toBeNull();
    expect(result.singleLifecycle).toBeNull();
    expect(result.tokens).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toContain('source-budget');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(2048);
  });
  test.each([
    ['merge', 'caws worktree merge wt-x'],
    ['destroy', "caws worktree destroy 'wt-x' --abandon-unmerged --data"],
    ['merge', 'caws worktree merge --apply "wt-x" --message="merge topic" --no-close'],
    [
      'merge',
      "caws worktree merge wt-x --closure-notes 'A > B | literal; caws worktree destroy z $(touch inert)'",
    ],
    ['merge', "'caws' worktree merge wt-x --notes 'λ quoted data'"],
    ['merge', "caws worktree merge wt-x --message '-quoted note'"],
  ])('single literal lifecycle fact: %s / %s', (verb, command) => {
    const result = runMutation({ command });
    expect(result.status).toBe(0);
    expect(result.issues).toEqual([]);
    expect(result.execution).toEqual({ command, cwd: fs.realpathSync(own) });
    expect(result.singleLifecycle).toBe(verb);
  });
  test.each([
    "printf '%s' 'caws worktree merge wt'; touch relative.txt",
    'caws worktree merge wt; touch relative.txt',
    'caws worktree merge wt && git status',
    'caws worktree merge wt | cat',
    'caws worktree merge wt &',
    'caws worktree merge wt > output.txt',
    'CAWS_SESSION_ID=x caws worktree merge wt',
    'env CAWS_SESSION_ID=x caws worktree merge wt',
    'command caws worktree merge wt',
    'cd /tmp && caws worktree merge wt',
    '(caws worktree merge wt)',
    '! caws worktree merge wt',
    'time caws worktree merge wt',
    'caws worktree merge "$name"',
    'caws worktree merge "$(printf wt)"',
    'caws worktree merge ~+',
    'caws worktree merge wt*',
    'caws worktree merge wt{a,b}',
    "caws worktree merge 'unterminated",
    'caws worktree merge',
    'caws worktree merge --message only-an-option-value',
    'caws worktree merge wt --unknown',
    'caws worktree merge wt --message',
    "caws worktree merge ''",
  ])('non-standalone or nonliteral lifecycle has no rewrite fact: %s', (command) => {
    const result = runMutation({ command });
    expect(result.singleLifecycle).toBeNull();
  });
  test('unknown coordinate withholds even a literal lifecycle fact', () => {
    const command = 'caws worktree destroy wt-x';
    const result = runMutation({ tool_name: 'Bash', tool_input: { command } });
    expect(result.execution).toEqual({ command, cwd: null });
    expect(result.singleLifecycle).toBeNull();
  });
  test('lifecycle rewrite facts preserve the selected canonical project', () => {
    const nested = path.join(own, 'independent-repository');
    linkedRepository(nested, []);
    for (const directory of [root, own, path.join(own, 'subdirectory')]) {
      fs.mkdirSync(directory, { recursive: true });
      const command = 'caws worktree destroy same-name';
      const result = runMutation({ tool_name: 'Bash', cwd: directory, tool_input: { command } });
      expect(result.issues).toEqual([]);
      expect({ directory, lifecycle: result.singleLifecycle }).toEqual({
        directory,
        lifecycle: 'destroy',
      });
      expect(result.execution).toEqual({ command, cwd: fs.realpathSync(directory) });
    }
    const separate = path.join(root, 'separate-repository');
    linkedRepository(separate, []);
    for (const directory of [nested, separate]) {
      const command = 'caws worktree destroy same-name';
      const result = runMutation({ tool_name: 'Bash', cwd: directory, tool_input: { command } });
      expect(result.issues).toEqual([]);
      expect(result.execution).toEqual({ command, cwd: fs.realpathSync(directory) });
      expect(result.singleLifecycle).toBeNull();
    }
  });
  test('failed project discovery cannot supply a lifecycle rewrite fact', () => {
    const result = runMutation({ command: 'caws worktree merge same-name' }, [], {
      CAWS_GIT_BINARY: '/nonexistent-caws-discovery-git',
    });
    expect(result.status).toBe(0);
    expect(result.issues).toEqual([]);
    expect(result.singleLifecycle).toBeNull();
  });

  test('empty native source stays empty while absent source cannot gain a surrogate', () => {
    const result = runMutation({
      tool_name: 'exec_command',
      cwd: own,
      tool_input: {
        cmd: '',
        shell: 'bash',
        login: false,
      },
    });
    expect(result.status).toBe(0);
    expect(result.execution).toEqual({ command: '', cwd: fs.realpathSync(own) });
    expect(result.singleLifecycle).toBeNull();
    const absent = runMutation({
      tool_name: 'exec_command',
      cwd: own,
      tool_input: {
        shell: 'bash',
        login: false,
      },
    });
    expect(absent.status).toBe(2);
    expect(absent.execution).toBeNull();
    expect(absent.tokens).toEqual([]);
  });
  test.each([null, 17, '', '/nonexistent-caws-native-workdir'])(
    'explicit malformed workdir cannot gain a base-cwd surrogate: %s',
    (workdir) => {
      const target = path.join(foreign, 'absolute-workdir.txt');
      const command = "touch '" + target + "'";
      const result = runMutation({
        tool_name: 'exec_command',
        cwd: own,
        tool_input: {
          cmd: command,
          workdir,
          shell: 'bash',
          login: false,
        },
      });
      expect(result.execution).toEqual({ command, cwd: null });
      expect(result.issues.map((issue) => issue.code)).toContain('invalid-workdir');
      expect(result.tokens.map((token) => token.value)).toContain(target);
      expect(result.singleLifecycle).toBeNull();
    }
  );
  test('malformed supplied native base remains an issue even with an absolute workdir', () => {
    const command = 'caws worktree merge wt-x';
    const result = runMutation({
      tool_name: 'exec_command',
      cwd: null,
      tool_input: {
        cmd: command,
        workdir: foreign,
        shell: 'bash',
        login: false,
      },
    });
    expect(result.execution).toEqual({ command, cwd: null });
    expect(result.issues.map((issue) => issue.code)).toContain('invalid-cwd');
    expect(result.singleLifecycle).toBeNull();
  });

  test('execution coordinate echoes physical identity rather than path spelling', () => {
    const command = 'caws worktree merge wt-x';
    const result = runMutation({ tool_name: 'Bash', cwd: own + '/.', tool_input: { command } });
    expect(result.execution).toEqual({ command, cwd: fs.realpathSync(own) });
    expect(result.singleLifecycle).toBe('merge');
  });
});
