'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync, spawnSync } = require('node:child_process');
const SHARED = path.resolve(__dirname, '../../templates/hook-packs/shared');
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
let fx;

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

function fixture(basename = 'project', governed = true, lane = 'linked') {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'caws-guard-identity-'));
  const project = path.join(base, basename);
  fs.mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  git(
    project,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'fixture'
  );
  git(project, 'branch', 'target');
  const hooks = path.join(base, 'hooks');
  fs.cpSync(SHARED, hooks, { recursive: true });
  const cli = path.join(base, 'caws');
  fs.writeFileSync(
    cli,
    '#!/bin/bash\nexec ' +
      quote(process.execPath) +
      ' ' +
      quote(path.resolve(__dirname, '../../dist/index.js')) +
      ' "$@"\n',
    { mode: 0o755 }
  );
  const alias = path.join(base, 'ordinary-alias');
  fs.symlinkSync(project, alias, 'dir');
  fx = { base, project, hooks, cli, alias, marker: path.join(base, 'submitted-payload-ran') };
  expect(fs.realpathSync(project)).toBe(project);
  if (governed) {
    const linked = path.join(project, '.caws/worktrees', lane);
    git(project, 'worktree', 'add', '-q', '-b', 'worker', linked);
    const entry = {
      name: lane,
      path: linked,
      branch: 'worker',
      baseBranch: 'main',
      spec_id: 'FIXTURE',
    };
    fs.writeFileSync(path.join(project, '.caws/worktrees.json'), JSON.stringify({ linked: entry }));
    Object.assign(fx, { linked, entry });
  }
}

afterEach(() => {
  if (fx) fs.rmSync(fx.base, { recursive: true, force: true });
  fx = undefined;
});

function invoke(script, cwd, command = 'git clean -fd', extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('HOOK_') ||
      key.startsWith('_CAWS_') ||
      ['BASH_ENV', 'ENV', 'NODE_OPTIONS', 'NODE_PATH', 'CAWS_HOOKS_DIR'].includes(key)
    )
      delete env[key];
  }
  const input = JSON.stringify({
    session_id: 'identity-fixture',
    tool_name: 'Bash',
    cwd,
    tool_input: { command },
  });
  return spawnSync('/bin/bash', [path.join(fx.hooks, script)], {
    cwd,
    input,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...env,
      HOME: fx.base,
      CAWS_HOME: path.join(fx.base, '.caws'),
      CAWS_HOOKS_DIR: fx.hooks,
      CAWS_BIN: fx.cli,
      CAWS_PROJECT_DIR: cwd,
      CLAUDE_PROJECT_DIR: cwd,
      CAWS_AGENT_SURFACE: 'claude-code',
      CAWS_SESSION_ID: 'identity-fixture',
      CAWS_GUARD_NO_ASK: '1',
      CLAUDE_CODE_SESSION_ID: 'identity-fixture',
      HOOK_EVENT_NAME: script.startsWith('stop-') ? 'Stop' : 'PreToolUse',
      HOOK_TOOL_NAME: 'Bash',
      HOOK_COMMAND: command,
      HOOK_CWD: cwd,
      HOOK_INPUT_JSON: input,
      HOOK_SESSION_ID: 'identity-fixture',
      HOOK_PERMISSION_MODE: 'default',
      ...extra,
    },
  });
}

function check(result, status, reason) {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(fs.existsSync(fx.marker)).toBe(false);
  expect(result.status).toBe(status);
  if (reason !== undefined) expect(result.stderr).toContain(reason);
}

function payload(command) {
  return command + '; printf executed > ' + quote(fx.marker);
}

test.each(['project', 'project\n', "project'quoted", 'project[*?]'])(
  'exact canonical registry survives root %p and an ordinary alias',
  (basename) => {
    fixture(basename);
    for (const cwd of [fx.project, fx.alias]) {
      const result = invoke('worktree-guard.sh', cwd, payload('git switch target'));
      check(result, 2, 'BLOCKED: git switch (branch switch) from the canonical checkout');
      expect(result.stderr).toContain("(e.g. 'linked' in .caws/worktrees.json)");
      check(
        invoke('worktree-guard.sh', cwd, payload('git clean -fd')),
        2,
        'BLOCKED: git clean (untracked-file deletion) is not allowed while worktrees are active.'
      );
      const reminder = invoke('stop-worktree-check.sh', cwd);
      check(reminder, 0, 'REMINDER: 1 active worktree(s) remain: linked.');
      expect(reminder.stderr).not.toContain('No active worktrees');
    }
    expect(git(fx.project, 'branch', '--show-current')).toBe('main\n');
  }
);

test.each(['project', 'project\n', "project'[*]"])(
  'linked checkout reads canonical activity at %p without becoming canonical',
  (basename) => {
    fixture(basename);
    check(invoke('worktree-guard.sh', fx.linked, payload('git switch target')), 0);
    check(
      invoke('worktree-guard.sh', fx.linked, payload('git clean -fd')),
      2,
      'BLOCKED: git clean (untracked-file deletion) is not allowed while worktrees are active.'
    );
    check(
      invoke('stop-worktree-check.sh', fx.linked),
      0,
      'REMINDER: 1 active worktree(s) remain: linked.'
    );
    expect(git(fx.linked, 'branch', '--show-current')).toBe('worker\n');
  }
);

test.each(['map', 'array'])('legacy nested %s registry remains readable', (shape) => {
  fixture('project\n');
  const entries = shape === 'map' ? { linked: fx.entry } : [fx.entry];
  fs.writeFileSync(
    path.join(fx.project, '.caws/worktrees.json'),
    JSON.stringify({ worktrees: entries })
  );
  check(
    invoke('worktree-guard.sh', fx.project),
    2,
    'BLOCKED: git clean (untracked-file deletion) is not allowed while worktrees are active.'
  );
  check(
    invoke('stop-worktree-check.sh', fx.project),
    0,
    'REMINDER: 1 active worktree(s) remain: linked.'
  );
});

test('a flat lane named worktrees is an entry rather than a legacy envelope', () => {
  fixture('project\n', true, 'worktrees');
  const entry = { ...fx.entry, owner: { session_id: 'foreign' } };
  delete entry.name;
  fs.writeFileSync(
    path.join(fx.project, '.caws/worktrees.json'),
    JSON.stringify({ worktrees: entry })
  );
  check(
    invoke('worktree-guard.sh', fx.project, 'git switch target'),
    2,
    "(e.g. 'worktrees' in .caws/worktrees.json)"
  );
  check(
    invoke('worktree-guard.sh', fx.project),
    2,
    'BLOCKED: git clean (untracked-file deletion) is not allowed while worktrees are active.'
  );
  check(
    invoke('stop-worktree-check.sh', fx.project),
    0,
    'REMINDER: 1 active worktree(s) remain: worktrees.'
  );
  const oracle = spawnSync(
    process.execPath,
    [path.join(fx.hooks, 'lib/worktree-claim-oracle.cjs')],
    {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        CAWS_ORACLE_PROJECT_DIR: fx.project,
        CAWS_ORACLE_REL_PATH: path.join(fx.linked, 'payload.txt'),
        CAWS_ORACLE_SESSION_ID: 'identity-fixture',
      },
    }
  );
  expect(oracle.error).toBeUndefined();
  expect(oracle.signal).toBeNull();
  expect(oracle.status).toBe(0);
  expect(oracle.stdout.trim()).toBe('block_foreign_worktree:worktrees:foreign');
});

test('entryByName preserves a colliding flat lane and legacy map identity', () => {
  fixture('project\n', true, 'worktrees');
  const env = { ...process.env };
  delete env.BASH_ENV;
  delete env.ENV;
  const exported = spawnSync(
    '/bin/bash',
    [
      '-c',
      'source "$1"; printf \'%s\' "${CAWS_NODE_ENTRY_BY_NAME:?}"',
      'reader-fixture',
      path.join(fx.hooks, 'lib/caws-state.sh'),
    ],
    {
      encoding: 'utf8',
      timeout: 15000,
      env,
    }
  );
  expect(exported.error).toBeUndefined();
  expect(exported.signal).toBeNull();
  expect(exported.status).toBe(0);
  expect(exported.stderr).toBe('');
  expect(exported.stdout).toMatch(/^function entryByName\(/);
  const entry = { ...fx.entry };
  delete entry.name;
  const other = { branch: 'other', path: path.join(fx.project, 'other') };
  const lookup = (registry, target) =>
    vm.runInNewContext(
      exported.stdout + '; entryByName(registry, target)',
      { registry, target },
      { timeout: 1000 }
    );
  for (const registry of [
    { worktrees: entry, other },
    { worktrees: { worktrees: entry, other } },
  ]) {
    expect(lookup(registry, 'worktrees')).toBe(entry);
    expect(lookup(registry, 'other')).toBe(other);
    expect(lookup(registry, 'missing')).toBeNull();
  }
  expect(fs.existsSync(fx.marker)).toBe(false);
});

function copyPaths() {
  fixture();
  fs.writeFileSync(
    path.join(fx.project, '.caws/worktrees.json'),
    JSON.stringify({
      linked: { ...fx.entry, owner: { session_id: 'identity-fixture' } },
    })
  );
  const sourceDir = path.join(fx.linked, 'packages', 'evidence');
  fs.mkdirSync(sourceDir, { recursive: true });
  const sources = ['one.json', 'two.log'].map((name) => {
    const file = path.join(sourceDir, name);
    fs.writeFileSync(file, name);
    return file;
  });
  const archive = path.join(fx.base, 'artifacts');
  fs.mkdirSync(archive);
  return { sources, archive };
}

test('copy destination policy permits multiple worktree sources to an external artifact directory', () => {
  const { sources, archive } = copyPaths();
  const result = invoke(
    'worktree-guard.sh',
    fx.project,
    payload('cp -- ' + sources.map(quote).join(' ') + ' ' + quote(archive))
  );
  check(result, 0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
  expect(fs.readdirSync(archive)).toEqual([]);
  expect(sources.map((file) => fs.readFileSync(file, 'utf8'))).toEqual(['one.json', 'two.log']);
});

test('copy destination policy refuses an actual worktree to canonical copy', () => {
  const { sources } = copyPaths();
  const destination = path.join(fx.project, 'src', 'receipt.json');
  fs.mkdirSync(path.dirname(destination));
  fs.writeFileSync(destination, 'canonical unchanged');
  check(
    invoke(
      'worktree-guard.sh',
      fx.project,
      payload('cp -- ' + quote(sources[0]) + ' ' + quote(destination))
    ),
    2,
    'Copying files from a worktree to the main repo is forbidden.'
  );
  expect(fs.readFileSync(destination, 'utf8')).toBe('canonical unchanged');
});

test('copy destination policy follows a destination-directory child symlink', () => {
  const { sources, archive } = copyPaths();
  const canonical = path.join(fx.project, 'canonical.json');
  fs.writeFileSync(canonical, 'canonical unchanged');
  fs.symlinkSync(canonical, path.join(archive, 'one.json'));
  check(
    invoke(
      'worktree-guard.sh',
      fx.project,
      payload('cp -- ' + quote(sources[0]) + ' ' + quote(archive))
    ),
    2,
    'Copying files from a worktree to the main repo is forbidden.'
  );
  expect(fs.readFileSync(canonical, 'utf8')).toBe('canonical unchanged');
});

test.each(['-R', '--unmodeled-option'])(
  'copy destination policy holds unmodeled option %s without inventing a canonical target',
  (option) => {
    const { sources, archive } = copyPaths();
    const result = invoke(
      'worktree-guard.sh',
      fx.project,
      payload('cp ' + option + ' ' + quote(sources[0]) + ' ' + quote(archive))
    );
    check(result, 2, 'authority unavailable: copy-roles');
    expect(result.stderr).not.toContain('Copying files from a worktree to the main repo');
    expect(fs.readdirSync(archive)).toEqual([]);
  }
);

test('copy destination policy does not borrow the session directory for a missing execution coordinate', () => {
  const { sources, archive } = copyPaths();
  for (const [destination, status] of [
    [quote(archive), 0],
    ['relative-output', 2],
  ]) {
    const command = 'cp -- ' + quote(sources[0]) + ' ' + destination;
    const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
    check(
      invoke('worktree-guard.sh', fx.project, command, { HOOK_INPUT_JSON: input }),
      status,
      status === 2 ? 'authority unavailable: copy-roles' : undefined
    );
  }
  expect(fs.readdirSync(archive)).toEqual([]);
});

test('mandatory copy roles preserve foreign source reads and refuse move-source deletion', () => {
  const { sources, archive } = copyPaths();
  fs.writeFileSync(
    path.join(fx.project, '.caws/worktrees.json'),
    JSON.stringify({
      linked: { ...fx.entry, owner: { session_id: 'foreign' } },
    })
  );
  check(
    invoke(
      'bash-write-guard.sh',
      fx.project,
      payload('cp -- ' + quote(sources[0]) + ' ' + quote(archive))
    ),
    0
  );
  check(
    invoke(
      'bash-write-guard.sh',
      fx.project,
      payload('mv -- ' + quote(sources[0]) + ' ' + quote(archive))
    ),
    2,
    'DIFFERENT session'
  );
  expect(fs.readFileSync(sources[0], 'utf8')).toBe('one.json');
});

test('mandatory copy roles refuse a foreign destination hidden behind an external directory child', () => {
  const { sources, archive } = copyPaths();
  const destination = path.join(fx.linked, 'foreign-target.json');
  fs.writeFileSync(destination, 'foreign unchanged');
  fs.symlinkSync(destination, path.join(archive, 'one.json'));
  fs.writeFileSync(
    path.join(fx.project, '.caws/worktrees.json'),
    JSON.stringify({
      linked: { ...fx.entry, owner: { session_id: 'foreign' } },
    })
  );
  check(
    invoke(
      'bash-write-guard.sh',
      fx.project,
      payload('cp -- ' + quote(sources[0]) + ' ' + quote(archive))
    ),
    2,
    'DIFFERENT session'
  );
  expect(fs.readFileSync(destination, 'utf8')).toBe('foreign unchanged');
});

test('mandatory copy roles allow an owned move and preserve the unexecuted source', () => {
  const { sources, archive } = copyPaths();
  fs.writeFileSync(
    path.join(fx.project, '.caws/worktrees.json'),
    JSON.stringify({
      linked: { ...fx.entry, owner: { session_id: 'identity-fixture' } },
    })
  );
  check(
    invoke(
      'bash-write-guard.sh',
      fx.project,
      payload('mv -- ' + quote(sources[0]) + ' ' + quote(archive))
    ),
    0
  );
  expect(fs.readFileSync(sources[0], 'utf8')).toBe('one.json');
  expect(fs.readdirSync(archive)).toEqual([]);
});

test.each(['canonical', 'foreign'])(
  'mandatory copy roles hold an external destination hardlinked to %s payload',
  (relation) => {
    const { sources, archive } = copyPaths();
    const target = path.join(relation === 'foreign' ? fx.linked : fx.project, 'linked-target');
    fs.writeFileSync(target, 'linked payload unchanged');
    fs.linkSync(target, path.join(archive, 'one.json'));
    expect(fs.statSync(target).nlink).toBe(2);
    check(
      invoke(
        'bash-write-guard.sh',
        fx.project,
        'cp -- ' + quote(sources[0]) + ' ' + quote(archive)
      ),
      2,
      'hard-link'
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('linked payload unchanged');
  }
);

test('mandatory copy roles admit an ordinary existing single-link destination', () => {
  const { sources, archive } = copyPaths();
  const destination = path.join(archive, 'one.json');
  fs.writeFileSync(destination, 'ordinary unchanged');
  expect(fs.statSync(destination).nlink).toBe(1);
  check(
    invoke('bash-write-guard.sh', fx.project, 'cp -- ' + quote(sources[0]) + ' ' + quote(archive)),
    0
  );
  expect(fs.readFileSync(destination, 'utf8')).toBe('ordinary unchanged');
});

test('a hard-link hold requests a real human decision when that channel is available', () => {
  const { sources, archive } = copyPaths();
  fs.linkSync(sources[0], path.join(archive, 'one.json'));
  const result = invoke(
    'bash-write-guard.sh',
    fx.project,
    'cp -- ' + quote(sources[0]) + ' ' + quote(archive),
    { CAWS_GUARD_NO_ASK: '0' }
  );
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.hookSpecificOutput.permissionDecision).toBe('ask');
  expect(output.hookSpecificOutput.permissionDecisionReason).toContain('hard-link');
  expect(fs.readdirSync(archive)).toEqual(['one.json']);
});

test('copy-source hard links remain readable while move-source identity is held', () => {
  const { sources, archive } = copyPaths();
  fs.linkSync(sources[0], path.join(fx.base, 'source-hardlink'));
  fs.writeFileSync(
    path.join(fx.project, '.caws/worktrees.json'),
    JSON.stringify({
      linked: { ...fx.entry, owner: { session_id: 'identity-fixture' } },
    })
  );
  check(
    invoke('bash-write-guard.sh', fx.project, 'cp -- ' + quote(sources[0]) + ' ' + quote(archive)),
    0
  );
  check(
    invoke('bash-write-guard.sh', fx.project, 'mv -- ' + quote(sources[0]) + ' ' + quote(archive)),
    2,
    'hard-link'
  );
  expect(fs.readFileSync(sources[0], 'utf8')).toBe('one.json');
});

test('unavailable hard-link identity cannot grant an existing destination write', () => {
  const { sources, archive } = copyPaths();
  const destination = path.join(archive, 'one.json');
  fs.writeFileSync(destination, 'unchanged');
  const bin = path.join(fx.base, 'python-bin');
  fs.mkdirSync(bin);
  const python = execFileSync('which', ['python3'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(
    path.join(bin, 'python3'),
    '#!/bin/bash\n' +
      'if [[ "$1" == -c && "$2" == *st_nlink* ]]; then exit 71; fi\n' +
      'exec ' +
      quote(python) +
      ' "$@"\n',
    { mode: 0o755 }
  );
  check(
    invoke('bash-write-guard.sh', fx.project, 'cp -- ' + quote(sources[0]) + ' ' + quote(archive), {
      PATH: bin + path.delimiter + process.env.PATH,
    }),
    2,
    'hard-link'
  );
  expect(fs.readFileSync(destination, 'utf8')).toBe('unchanged');
});

test('known foreign writes retain precedence over copy filesystem uncertainty', () => {
  const { sources, archive } = copyPaths();
  fs.linkSync(sources[0], path.join(archive, 'one.json'));
  fs.writeFileSync(
    path.join(fx.project, '.caws/worktrees.json'),
    JSON.stringify({
      linked: { ...fx.entry, owner: { session_id: 'foreign' } },
    })
  );
  const command =
    'cp -- ' + quote(sources[0]) + ' ' + quote(archive) + '; printf changed > ' + quote(sources[1]);
  check(invoke('bash-write-guard.sh', fx.project, command), 2, 'DIFFERENT session');
  expect(fs.readFileSync(sources[1], 'utf8')).toBe('two.log');
});

test.each([
  'directory-source',
  'symlink-source',
  'move-symlink-destination',
  'missing-parent',
  'missing-directory',
  'multiple-to-file',
])('copy destination policy holds unmodeled filesystem relation %s', (relation) => {
  const { sources, archive } = copyPaths();
  let source = sources[0],
    destination = archive,
    operation = 'cp';
  if (relation === 'directory-source') source = path.dirname(source);
  if (relation === 'symlink-source') {
    source = path.join(fx.base, 'source-alias');
    fs.symlinkSync(sources[0], source);
  }
  if (relation === 'move-symlink-destination') {
    operation = 'mv';
    destination = path.join(fx.base, 'archive-alias');
    fs.symlinkSync(archive, destination, 'dir');
  }
  if (relation === 'missing-parent') destination = path.join(archive, 'absent', 'leaf');
  if (relation === 'missing-directory') destination = path.join(archive, 'absent') + '/';
  if (relation === 'multiple-to-file') {
    destination = path.join(archive, 'existing-file');
    fs.writeFileSync(destination, 'unchanged');
  }
  const operands = relation === 'multiple-to-file' ? sources : [source];
  const command = operation + ' -- ' + [...operands, destination].map(quote).join(' ');
  check(invoke('worktree-guard.sh', fx.project, command), 2, 'authority unavailable: copy-roles');
  expect(fs.readFileSync(sources[0], 'utf8')).toBe('one.json');
});

test('copy destination policy checks target-directory operands and a finite observation budget', () => {
  const { sources, archive } = copyPaths();
  check(
    invoke(
      'worktree-guard.sh',
      fx.project,
      'cp -t ' + quote(archive) + ' -- ' + sources.map(quote).join(' ')
    ),
    0
  );
  const command = 'cp -- ' + Array(129).fill(quote(sources[0])).join(' ') + ' ' + quote(archive);
  check(invoke('worktree-guard.sh', fx.project, command), 2, 'authority unavailable: copy-roles');
  expect(fs.readdirSync(archive)).toEqual([]);
});

test.each(['program=cp; "$program"', 'bash -c'])(
  'mandatory copy policy observes executable copy source through %s',
  (prefix) => {
    const { sources } = copyPaths();
    const destination = path.join(fx.project, 'canonical.json');
    fs.writeFileSync(destination, 'canonical unchanged');
    const body = 'cp -- ' + quote(sources[0]) + ' ' + quote(destination);
    const command =
      prefix === 'bash -c'
        ? prefix + ' ' + quote(body)
        : prefix + ' -- ' + quote(sources[0]) + ' ' + quote(destination);
    check(
      invoke('bash-write-guard.sh', fx.project, command),
      2,
      'Copying files from a worktree to the main repo is forbidden.'
    );
    expect(fs.readFileSync(destination, 'utf8')).toBe('canonical unchanged');
  }
);

test.each(['{broken', '[]', 'null'])(
  'invalid canonical registry %p cannot masquerade as inactivity',
  (bytes) => {
    fixture();
    fs.writeFileSync(path.join(fx.project, '.caws/worktrees.json'), bytes);
    check(
      invoke('worktree-guard.sh', fx.project),
      2,
      '[worktree-guard] authority unavailable: worktrees-registry'
    );
    const reminder = invoke('stop-worktree-check.sh', fx.project);
    check(reminder, 0, '[stop-worktree-check] activity unavailable: worktrees-registry');
    expect(reminder.stderr).not.toContain('No active worktrees');
  }
);

test('a failed Node reader cannot turn printed zero into inactive authority', () => {
  fixture();
  const bin = path.join(fx.base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nprintf "0\\n"\nexit 71\n', { mode: 0o755 });
  const extra = { PATH: bin + path.delimiter + process.env.PATH };
  check(
    invoke('worktree-guard.sh', fx.project, 'git clean -fd', extra),
    2,
    '[worktree-guard] authority unavailable: worktrees-registry'
  );
  const reminder = invoke('stop-worktree-check.sh', fx.project, '', extra);
  check(reminder, 0, '[stop-worktree-check] activity unavailable: worktrees-registry');
  expect(reminder.stderr).not.toContain('No active worktrees');
});

test('malformed parallel registry cannot masquerade as inactive authority', () => {
  fixture();
  fs.writeFileSync(path.join(fx.project, '.caws/parallel.json'), '{broken');
  check(
    invoke('worktree-guard.sh', fx.linked),
    2,
    '[worktree-guard] authority unavailable: parallel-registry'
  );
});

test('unavailable authority applies only to projected protected operations', () => {
  fixture();
  fs.writeFileSync(path.join(fx.project, '.caws/worktrees.json'), '{broken');
  for (const command of ["printf '%s' ok", "node -e 'console.log({value: 1})'"]) {
    const harmless = invoke('worktree-guard.sh', fx.project, payload(command));
    check(harmless, 0);
    expect(harmless.stderr).toBe('');
  }
  for (const command of [
    'git switch target',
    'git clean -fd',
    'printf \'%s\' "$(git switch target)"',
  ]) {
    check(
      invoke('worktree-guard.sh', fx.project, payload(command)),
      2,
      '[worktree-guard] authority unavailable: worktrees-registry'
    );
  }
  expect(git(fx.project, 'branch', '--show-current')).toBe('main\n');
});

test.each([
  ['lib/caws-state.sh', 'canonical-root'],
  ['lib/parse-input.sh', 'hook-input'],
])('required helper %s failure is hard refusal and advisory diagnosis', (file, reason) => {
  fixture();
  fs.unlinkSync(path.join(fx.hooks, file));
  check(
    invoke('worktree-guard.sh', fx.project),
    2,
    '[worktree-guard] authority unavailable: ' + reason
  );
  check(
    invoke('stop-worktree-check.sh', fx.project),
    0,
    '[stop-worktree-check] activity unavailable: ' + reason
  );
});

test('an unavailable explicit project directory cannot be interpreted as no activity', () => {
  fixture();
  const extra = { CAWS_PROJECT_DIR: path.join(fx.base, 'missing') };
  check(
    invoke('worktree-guard.sh', fx.project, 'git clean -fd', extra),
    2,
    '[worktree-guard] authority unavailable: canonical-root'
  );
  check(
    invoke('stop-worktree-check.sh', fx.project, '', extra),
    0,
    '[stop-worktree-check] activity unavailable: canonical-root'
  );
});

test('vendor project fallback preserves an LF root instead of selecting a missing sibling', () => {
  fixture('project\n');
  check(
    invoke('worktree-guard.sh', fx.project, payload('git switch target'), {
      CAWS_PROJECT_DIR: '',
      CLAUDE_PROJECT_DIR: fx.project,
    }),
    2,
    'BLOCKED: git switch (branch switch) from the canonical checkout'
  );
});

test('valid empty registry remains inactive without an unavailable diagnosis', () => {
  fixture();
  fs.writeFileSync(path.join(fx.project, '.caws/worktrees.json'), '{}');
  check(invoke('worktree-guard.sh', fx.project), 0);
  const reminder = invoke('stop-worktree-check.sh', fx.project);
  check(reminder, 0, 'REMINDER: No active worktrees.');
  expect(reminder.stderr).not.toContain('unavailable');
});

test('an ungoverned Git project retains absent-registry behavior', () => {
  fixture('unguarded', false);
  const hard = invoke('worktree-guard.sh', fx.project);
  check(hard, 0);
  expect(hard.stderr).toBe('');
  const reminder = invoke('stop-worktree-check.sh', fx.project);
  check(reminder, 0);
  expect(reminder.stderr).toBe('');
});
