const fs = require('node:fs');
const { AbortController } = globalThis;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { tryExecuteStockHandler } = require('../../dist/runtime/stock-handlers');
const { createHandlerExecutor } = require('../../dist/runtime/handler-executor');
const classifier = require('../../dist/runtime/classifier');
const templates = path.resolve(__dirname, '../../templates/hook-packs');
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let directory, runtime, project, selection, request, environment, controller;
function context() {
  return { request, selection, environment, signal: controller.signal };
}
function select(name = 'block-dangerous.sh') {
  const file = path.join(runtime, name);
  fs.chmodSync(file, 0o755);
  const handler = {
    path: file,
    sha256: digest(file),
    entry: name,
    name,
    args: [],
    tier: 'stock',
    kind: 'stock',
  };
  selection.handlers = [handler];
  return handler;
}
function command(value) {
  request.payload = {
    tool_name: 'Bash',
    session_id: 'fixture',
    cwd: project,
    tool_input: { command: value },
  };
  request.inputJson = JSON.stringify(request.payload);
}
const git = (...args) =>
  execFileSync('git', args, { cwd: project, env: environment, encoding: 'utf8' });
beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-stock-handlers-')));
  runtime = path.join(directory, 'runtime');
  project = path.join(directory, 'project');
  fs.mkdirSync(project);
  fs.cpSync(path.join(templates, 'shared'), runtime, { recursive: true });
  fs.copyFileSync(
    path.join(templates, 'runtime/handler-env.sh'),
    path.join(runtime, 'handler-env.sh')
  );
  const libraries = {};
  for (const name of [
    'agent-surface.sh',
    'parse-input.sh',
    'emit.sh',
    'session-id.sh',
    'caws-state.sh',
    'guard-message.sh',
    'agent-pid.sh',
    'bash-mutation-targets.sh',
    'heredoc.sh',
  ]) {
    const file = path.join(runtime, 'lib', name);
    libraries[name] = { path: file, sha256: digest(file), kind: 'shared' };
  }
  selection = {
    status: 'active',
    runtimeDigest: 'a'.repeat(64),
    checkout: project,
    canonical: project,
    surface: 'codex',
    event: 'pre_tool_use',
    configuration: 'system',
    runtimeDirectory: runtime,
    hooksDirectory: runtime,
    handlers: [],
    libraries,
    overrides: {},
    libraryOverrides: {},
    transcriptAdapter: null,
  };
  environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        !key.startsWith('GIT_') &&
        !key.startsWith('HOOK_') &&
        !key.startsWith('CAWS_') &&
        key !== 'BASH_ENV' &&
        typeof value === 'string'
    )
  );
  environment.HOME = directory;
  environment.TMPDIR = directory;
  request = {
    schema: 'caws.runtime.request.v1',
    id: 'stock-fixture',
    runtimeDigest: selection.runtimeDigest,
    surface: 'codex',
    event: 'pre_tool_use',
    configuration: 'system',
    caller: { cwd: project, environment },
    deadlineEpochMs: Date.now() + 60000,
    inputJson: '{}',
    payload: {},
  };
  controller = new AbortController();
  git('init', '-q');
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('actual selected stock guard refuses a bare staged deletion natively without arming a latch', async () => {
  fs.writeFileSync(path.join(project, 'owned.txt'), 'owned\n');
  git('add', 'owned.txt');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture'
  );
  fs.unlinkSync(path.join(project, 'owned.txt'));
  git('add', '-u');
  const indexBefore = fs.readFileSync(path.join(project, '.git/index'));
  command('git commit -m unrelated');
  const handler = select();
  const spawn = jest.spyOn(require('node:child_process'), 'spawn');
  const result = await createHandlerExecutor(context())(handler, 0);
  expect(result.exitCode).toBe(0);
  const body = JSON.parse(Buffer.from(result.stdout).toString('utf8'));
  expect(body.decision).toBe('block');
  expect(body.reason).toContain('owned.txt');
  expect(body.reason).toContain('danger latch was NOT armed');
  expect(body.reason).toContain('git commit -m "<msg>" -- <paths>');
  expect(spawn).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(project, '.git/index'))).toEqual(indexBefore);
  expect(fs.existsSync(path.join(project, '.codex/hooks/state'))).toBe(false);
});

test('a canonical latch prevents native admission from a different checkout', () => {
  command('echo safe');
  const handler = select();
  const canonical = path.join(directory, 'canonical');
  const state = path.join(canonical, '.codex/hooks/state');
  fs.mkdirSync(state, { recursive: true });
  selection.canonical = canonical;
  // Positive control proves this command/source pair is otherwise admitted.
  expect(tryExecuteStockHandler(handler, context())).not.toBeNull();
  fs.writeFileSync(path.join(state, 'danger-latch-neighbor.json'), '{}');
  expect(tryExecuteStockHandler(handler, context())).toBeNull();
  expect(fs.existsSync(path.join(project, '.codex/hooks/state'))).toBe(false);
});

test('native quiet allow and advisory use the actual classifier envelope contract', () => {
  command('echo safe');
  const handler = select();
  expect(tryExecuteStockHandler(handler, context())).toEqual({
    exitCode: 0,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
  });
  jest.spyOn(classifier, 'classifyCommand').mockReturnValue({
    decision: 'ask',
    reason: 'review this operation',
    source: 'regex',
    enforcement: 'advisory',
  });
  const result = tryExecuteStockHandler(handler, context());
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toEqual(new Uint8Array());
  expect(Buffer.from(result.stderr).toString()).toBe(
    'caws advisory (non-blocking): review this operation\n'
  );
});

test('merge-in-progress commit refusal preserves the classifier remedy without impossible pathspec advice', () => {
  command('git commit -m merge');
  const handler = select();
  jest.spyOn(classifier, 'classifyCommand').mockReturnValue({
    decision: 'ask',
    reason: 'a merge is in progress; inspect the merge',
    source: 'commit_deletions',
    enforcement: 'confirm',
  });
  const result = tryExecuteStockHandler(handler, context());
  const body = JSON.parse(Buffer.from(result.stdout).toString());
  expect(body.decision).toBe('block');
  expect(body.reason).toContain('a merge is in progress; inspect the merge');
  expect(body.reason).not.toContain('-- <paths>');
});

test.each(['deny', 'capability-confirm', 'classifier-error'])(
  'stateful enforcement stays on selected shell path: %s',
  (kind) => {
    command('fixture command');
    const handler = select();
    const classification =
      kind === 'deny'
        ? {
            decision: 'deny',
            reason: 'catastrophic target',
            source: 'rm_classifier',
            enforcement: 'block',
          }
        : {
            decision: 'ask',
            reason: 'unproved operation',
            source: kind === 'classifier-error' ? 'classifier_error' : 'capability',
            enforcement: 'confirm',
          };
    jest.spyOn(classifier, 'classifyCommand').mockReturnValue(classification);
    expect(tryExecuteStockHandler(handler, context())).toBeNull();
    expect(fs.existsSync(path.join(project, '.codex/hooks/state'))).toBe(false);
  }
);

test.each([
  'kind',
  'configuration',
  'source',
  'arguments',
  'library-kind',
  'library-bytes',
  'library-override',
  'prior-startup',
])('cannot substitute native code for unproved provenance: %s', (variant) => {
  command('echo safe');
  const handler = select();
  if (variant === 'kind') handler.kind = 'project-override';
  if (variant === 'configuration') selection.configuration = 'project-policy';
  if (variant === 'source') fs.appendFileSync(handler.path, '\n# custom\n');
  if (variant === 'arguments') handler.args = ['custom'];
  if (variant === 'library-kind') selection.libraries['emit.sh'].kind = 'project';
  if (variant === 'library-bytes')
    fs.appendFileSync(selection.libraries['emit.sh'].path, '\n# custom\n');
  if (variant === 'library-override')
    selection.libraryOverrides['emit.sh'] = selection.libraries['emit.sh'].path;
  if (variant === 'prior-startup') environment.BASH_ENV = path.join(project, 'startup.sh');
  expect(tryExecuteStockHandler(handler, context())).toBeNull();
});

test.each([
  'latch',
  'foreign-session-latch',
  'redirected-state',
  'protected-reference',
  'file-tool',
])('earlier guard semantics cannot be bypassed: %s', (variant) => {
  command('echo safe');
  const handler = select();
  const state = path.join(project, '.codex/hooks/state');
  fs.mkdirSync(path.dirname(state), { recursive: true });
  if (variant === 'redirected-state') fs.symlinkSync(directory, state);
  else if (variant === 'latch' || variant === 'foreign-session-latch') {
    fs.mkdirSync(state);
    fs.writeFileSync(
      path.join(state, `danger-latch-${variant === 'latch' ? 'fixture' : 'another-session'}.json`),
      '{}'
    );
  } else if (variant === 'protected-reference')
    command('git commit -m .codex/hooks/worktree-write-guard.sh');
  else
    request.payload = {
      tool_name: 'Write',
      tool_input: { file_path: 'owned.txt', content: 'new' },
    };
  const classify = jest.spyOn(classifier, 'classifyCommand');
  expect(tryExecuteStockHandler(handler, context())).toBeNull();
  expect(classify).not.toHaveBeenCalled();
});

test('opt-in exact stock utility evaluates document metadata without Python or a shell handler', async () => {
  const policy = path.join(project, 'utility-policy.json');
  fs.writeFileSync(
    policy,
    JSON.stringify({ version: 1, documents: { roots: ['docs/'], required_frontmatter: ['title'] } })
  );
  environment.CAWS_OPTIONAL_HOOK_POLICY = policy;
  request.payload = {
    tool_name: 'Write',
    tool_input: { file_path: 'docs/a.md', content: '# no metadata' },
  };
  const handler = select('hook-utilities.sh');
  const spawn = jest.spyOn(require('node:child_process'), 'spawn');
  const result = await createHandlerExecutor(context())(handler, 0);
  expect(result.exitCode).toBe(0);
  expect(
    JSON.parse(Buffer.from(result.stdout).toString()).hookSpecificOutput.additionalContext
  ).toBe('Consumer document metadata missing: title.');
  expect(spawn).not.toHaveBeenCalled();
});

test.each([
  ['absolute', 'nested', 2],
  ['relative', 'nested', 2],
  ['symlink-parent', 'nested', 2],
  ['absent', 'root', 2],
  ['empty', 'root', 2],
  ['absolute', 'root', 0],
  ['relative', 'root', 0],
  ['symlink-parent', 'root', 0],
])(
  'utility staging uses %s payload cwd with ignored files at %s',
  async (cwd, ignored, exitCode) => {
    const subdirectory = path.join(project, cwd === 'symlink-parent' ? 'parent' : 'sub');
    fs.mkdirSync(subdirectory);
    if (cwd === 'symlink-parent') {
      fs.mkdirSync(path.join(subdirectory, 'child'));
      fs.symlinkSync(path.join(subdirectory, 'child'), path.join(project, 'link'));
    }
    fs.writeFileSync(
      path.join(project, '.gitignore'),
      ignored === 'root' ? '/private.generated\n' : ''
    );
    fs.writeFileSync(
      path.join(subdirectory, '.gitignore'),
      ignored === 'nested' ? '*.generated\n' : ''
    );
    fs.writeFileSync(path.join(project, 'private.generated'), 'root sentinel\n');
    fs.writeFileSync(path.join(subdirectory, 'private.generated'), 'nested sentinel\n');
    fs.writeFileSync(path.join(project, 'tracked.txt'), 'tracked\n');
    git('add', 'tracked.txt');
    const indexBefore = fs.readFileSync(path.join(project, '.git/index'));
    const policy = path.join(project, 'utility-policy.json');
    fs.writeFileSync(policy, JSON.stringify({ version: 1, ignored_staging: true }));
    environment.CAWS_OPTIONAL_HOOK_POLICY = policy;
    command('git add -f private.generated');
    if (cwd === 'absent') delete request.payload.cwd;
    else
      request.payload.cwd =
        cwd === 'absolute'
          ? subdirectory
          : cwd === 'relative'
            ? 'sub'
            : cwd === 'symlink-parent'
              ? 'link/..'
              : '';
    request.inputJson = JSON.stringify(request.payload);
    const handler = select('hook-utilities.sh');
    const spawn = jest.spyOn(require('node:child_process'), 'spawn');
    const result = await createHandlerExecutor(context())(handler, 0);
    expect({
      exitCode: result.exitCode,
      stdout: Buffer.from(result.stdout).toString('utf8'),
    }).toEqual({
      exitCode,
      stdout:
        exitCode === 2
          ? JSON.stringify({
              decision: 'block',
              reason: 'Consumer ignored-staging policy: private.generated',
            }) + '\n'
          : '',
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(project, '.git/index'))).toEqual(indexBefore);
    expect(fs.readFileSync(path.join(subdirectory, 'private.generated'), 'utf8')).toBe(
      'nested sentinel\n'
    );
  }
);

test('an unresolvable utility cwd retains the selected shell fallback', () => {
  command('git add -f private.generated');
  const handler = select('hook-utilities.sh');
  expect(tryExecuteStockHandler(handler, context())).not.toBeNull();
  fs.symlinkSync('loop', path.join(project, 'loop'));
  request.payload.cwd = 'loop';
  expect(tryExecuteStockHandler(handler, context())).toBeNull();
});

test('utility absence is silent, malformed policy informational, and custom helper forces shell fallback', () => {
  const handler = select('hook-utilities.sh');
  expect(tryExecuteStockHandler(handler, context()).stdout).toEqual(new Uint8Array());
  const policy = path.join(project, 'policy.json');
  fs.writeFileSync(policy, '{');
  environment.CAWS_OPTIONAL_HOOK_POLICY = policy;
  const result = tryExecuteStockHandler(handler, context());
  expect(result.exitCode).toBe(0);
  expect(
    JSON.parse(Buffer.from(result.stdout).toString()).hookSpecificOutput.additionalContext
  ).toMatch(/^Optional utility analysis incomplete:/);
  fs.appendFileSync(path.join(runtime, 'lib/hook-utilities.py'), '\n# custom\n');
  expect(tryExecuteStockHandler(handler, context())).toBeNull();
});

test('native entry honors cancellation and an already expired request', () => {
  command('echo safe');
  const handler = select();
  controller.abort();
  expect(() => tryExecuteStockHandler(handler, context())).toThrow('cancelled');
  controller = new AbortController();
  request.deadlineEpochMs = Date.now() - 1;
  expect(() => tryExecuteStockHandler(handler, context())).toThrow('deadline expired');
});
