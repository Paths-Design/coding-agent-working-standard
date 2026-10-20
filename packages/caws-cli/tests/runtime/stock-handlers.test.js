const fs = require('node:fs');
const { AbortController } = globalThis;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  tryExecuteStockHandler,
  qualifiesForNativeContainment,
} = require('../../dist/runtime/stock-handlers');
const { createHandlerExecutor } = require('../../dist/runtime/handler-executor');
const classifier = require('../../dist/runtime/classifier');
const templates = path.resolve(__dirname, '../../templates/hook-packs');
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let directory, runtime, project, selection, request, environment, controller;
const artifactRoot = process.env.CAWS_TEST_ARTIFACT_DIR;
if (artifactRoot && !path.isAbsolute(artifactRoot))
  throw new Error('Artifact root must be absolute');
const agentSurfaceProfiles = [
  {
    name: 'legacy JSON lookup',
    sha256: 'f8d154f1795c0f643479daa715411a584cb062136cf9003ee007de5f25338e5a',
    revision: 'f7a5af5097f151efa3079935fa2bc235c23ac6ad^',
  },
  {
    name: 'exact-empty JSON lookup',
    sha256: '9fb104eab8cc5955157dd2da7dc25c19a4bfcd008aa148cfacfba842c9310c32',
    revision: null,
  },
];
function useAgentSurfaceProfile(profile) {
  const file = selection.libraries['agent-surface.sh'].path;
  if (profile.revision) {
    const bytes = execFileSync(
      '/usr/bin/git',
      [
        'show',
        profile.revision + ':packages/caws-cli/templates/hook-packs/shared/lib/agent-surface.sh',
      ],
      {
        cwd: path.resolve(__dirname, '../../../..'),
        env: {
          HOME: directory,
          PATH: '/usr/bin:/bin',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      }
    );
    fs.writeFileSync(file, bytes);
  }
  selection.libraries['agent-surface.sh'].sha256 = digest(file);
  fs.writeFileSync(
    path.join(directory, 'reviewed-agent-surface.json'),
    JSON.stringify({ ...profile, actualSha256: digest(file) }, null, 2)
  );
  expect(digest(file)).toBe(profile.sha256);
}
function captureResult(label, result) {
  const base = path.join(directory, label);
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'input.bin'), request.inputJson);
  fs.writeFileSync(path.join(base, 'stdout.bin'), Buffer.from(result.stdout));
  fs.writeFileSync(path.join(base, 'stderr.bin'), Buffer.from(result.stderr));
  fs.writeFileSync(
    path.join(base, 'result.json'),
    JSON.stringify({ exitCode: result.exitCode }, null, 2)
  );
}
function retainFixture(source, destination) {
  const metadata = fs.lstatSync(source);
  if (metadata.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), destination);
  else if (metadata.isDirectory()) {
    fs.mkdirSync(destination, { mode: 0o700 });
    for (const name of fs.readdirSync(source))
      retainFixture(path.join(source, name), path.join(destination, name));
  } else if (metadata.isFile()) fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  else throw new Error('Unsupported fixture entry: ' + source);
}
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
  if (artifactRoot && directory) {
    fs.writeFileSync(path.join(directory, 'input.bin'), request.inputJson);
    // Caller environment is deliberately omitted: the existing fixture inherits
    // ambient non-CAWS variables, which are not qualification evidence.
    const { caller, ...requestWithoutEnvironment } = request;
    const files = ['dist/runtime/stock-handlers.js', 'src/runtime/stock-handlers.ts'];
    fs.writeFileSync(
      path.join(directory, 'test-identity.json'),
      JSON.stringify(
        {
          test: expect.getState().currentTestName,
          node: { path: process.execPath, version: process.version },
          request: { ...requestWithoutEnvironment, caller: { cwd: caller.cwd } },
          selection,
          sourceIdentities: files.map((name) => {
            const file = path.resolve(__dirname, '../..', name);
            return { path: file, sha256: digest(file) };
          }),
          nonclaims: [
            'native process execution',
            'signal execution',
            'missing-session identity',
            'exclusive logical-session process ownership',
          ],
        },
        null,
        2
      )
    );
    fs.mkdirSync(artifactRoot, { recursive: true });
    const retained = path.join(artifactRoot, path.basename(directory));
    if (fs.existsSync(retained))
      throw new Error('Refusing to overwrite retained fixture ' + retained);
    // Node's native cp weakly_canonical can abort on intentional symlink loops
    // on macOS even with dereference:false. Retain link bytes without resolving.
    retainFixture(directory, retained);
    fs.writeFileSync(
      path.join(retained, 'retention.json'),
      JSON.stringify({ executedRoot: directory, retainedRoot: retained }, null, 2)
    );
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

test.each(agentSurfaceProfiles)(
  'actual selected stock guard refuses a bare staged deletion natively without arming a latch ($name)',
  async (profile) => {
    useAgentSurfaceProfile(profile);
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
    fs.writeFileSync(path.join(directory, 'index-before.bin'), indexBefore);
    command('git commit -m unrelated');
    const handler = select();
    const spawn = jest.spyOn(require('node:child_process'), 'spawn');
    const result = await createHandlerExecutor(context())(handler, 0);
    captureResult('staged-deletion', result);
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(Buffer.from(result.stdout).toString('utf8'));
    expect(body.decision).toBe('block');
    expect(body.reason).toContain('owned.txt');
    expect(body.reason).toContain('danger latch was NOT armed');
    expect(body.reason).toContain('git commit -m "<msg>" -- <paths>');
    expect(spawn.mock.calls.length).toBe(0);
    expect(fs.readFileSync(path.join(project, '.git/index'))).toEqual(indexBefore);
    expect(fs.existsSync(path.join(project, '.codex/hooks/state'))).toBe(false);
  }
);

test('a rehashed unreviewed library keeps the selected shell route instead of inheriting stock trust', async () => {
  useAgentSurfaceProfile(agentSurfaceProfiles[1]);
  command('echo safe');
  environment.CAWS_SESSION_ID = 'fixture';
  const handler = select();
  const spawn = jest.spyOn(require('node:child_process'), 'spawn');
  const native = await createHandlerExecutor(context())(handler, 0);
  const reviewedExecutorChildren = spawn.mock.calls.length;
  captureResult('reviewed-quiet-allow', native);
  expect(native.exitCode).toBe(0);
  expect(Buffer.from(native.stdout).length).toBe(0);
  expect(Buffer.from(native.stderr).length).toBe(0);
  expect(spawn.mock.calls.length).toBe(0);
  expect(qualifiesForNativeContainment(handler, context())).toBe(true);

  const library = selection.libraries['agent-surface.sh'];
  fs.appendFileSync(library.path, '\n# valid but unreviewed fixture source\n');
  library.sha256 = digest(library.path); // Fresh metadata must not grant a new reviewed identity.
  expect(agentSurfaceProfiles.map((profile) => profile.sha256)).not.toContain(library.sha256);
  expect(tryExecuteStockHandler(handler, context())).toBeNull();
  expect(qualifiesForNativeContainment(handler, context())).toBe(false);
  const fallback = await createHandlerExecutor(context())(handler, 0);
  captureResult('unreviewed-shell-allow', fallback);
  fs.writeFileSync(
    path.join(directory, 'route-observation.json'),
    JSON.stringify(
      {
        reviewedExecutorChildren,
        finalExecutorChildren: spawn.mock.calls.length,
        rehashedLibrary: library,
      },
      null,
      2
    )
  );
  expect(fallback.exitCode).toBe(0);
  expect(Buffer.from(fallback.stdout).length).toBe(0);
  expect(spawn.mock.calls.length).toBe(1);
});

test.each(agentSurfaceProfiles)(
  'reviewed source permits only the original containment eligibility contract ($name)',
  (profile) => {
    useAgentSurfaceProfile(profile);
    command('echo safe');
    environment.CAWS_SESSION_ID = 'fixture';
    const handler = select();
    const owner = context();
    const reviewedEligible = qualifiesForNativeContainment(handler, owner);
    const candidates = [
      ['request surface', { ...owner, request: { ...request, surface: 'claude-code' } }],
      ['request event', { ...owner, request: { ...request, event: 'stop' } }],
      ['request generation', { ...owner, request: { ...request, runtimeDigest: 'b'.repeat(64) } }],
      [
        'file tool',
        { ...owner, request: { ...request, payload: { ...request.payload, tool_name: 'Write' } } },
      ],
      ['disabled effect', { ...owner, environment: { ...environment, CAWS_TRAP_KILL: '0' } }],
      ['dry-run effect', { ...owner, environment: { ...environment, CAWS_TRAP_KILL: 'dryrun' } }],
      ['hook dry-run', { ...owner, environment: { ...environment, CAWS_HOOK_DRY_RUN: '1' } }],
      [
        'prior startup',
        {
          ...owner,
          environment: { ...environment, CAWS_PRIOR_BASH_ENV: '/unreviewed/startup.sh' },
        },
      ],
      [
        'custom handler',
        {
          ...owner,
          selection: { ...selection, handlers: [{ ...handler, kind: 'project-override' }] },
        },
      ],
      ['missing selected handler', { ...owner, selection: { ...selection, handlers: [] } }],
      [
        'library override',
        {
          ...owner,
          selection: {
            ...selection,
            libraryOverrides: { 'emit.sh': selection.libraries['emit.sh'].path },
          },
        },
      ],
    ];
    const observations = candidates.map(([name, candidate]) => ({
      name,
      eligible: qualifiesForNativeContainment(handler, candidate),
    }));
    const startup = path.join(runtime, 'handler-env.sh');
    fs.appendFileSync(startup, '\n# unreviewed startup bytes\n');
    const changedStartupEligible = qualifiesForNativeContainment(handler, owner);
    fs.writeFileSync(
      path.join(directory, 'containment-eligibility.json'),
      JSON.stringify(
        { profile, reviewedEligible, observations, changedStartupEligible, effectAttempted: false },
        null,
        2
      )
    );
    expect(reviewedEligible).toBe(true);
    for (const observation of observations)
      expect(observation).toEqual({ name: observation.name, eligible: false });
    expect(changedStartupEligible).toBe(false);
  }
);

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

test.each([
  'git init; echo "$(kubectl delete pod demo)"',
  'git init; echo `kubectl delete pod demo`',
  'echo "$(kubectl delete pod demo)"; git init',
])(
  'selected guard retains capability warning and repeat latch: %s',
  async (input) => {
    environment.CAWS_TRAP_KILL = '0';
    environment.PATH = '/usr/bin:/bin';
    command(input);
    const handler = select();
    const execute = createHandlerExecutor(context());
    const state = path.join(project, '.codex/hooks/state');
    const warningFile = path.join(state, 'danger-warn-fixture.json');
    const latchFile = path.join(state, 'danger-latch-fixture.json');
    const first = await execute(handler, 0);
    expect(first.exitCode).toBe(0);
    expect(Buffer.from(first.stdout).toString()).toBe('');
    expect(Buffer.from(first.stderr).toString()).toContain('WARN, first capability ask');
    const warningBytes = fs.readFileSync(warningFile);
    expect(JSON.parse(warningBytes)).toMatchObject({
      hook: 'block-dangerous.sh',
      kind: 'capability-warn',
      command: input,
      reason: 'command substitution: destructive operation (K8S_DELETE)',
    });
    expect(fs.existsSync(latchFile)).toBe(false);

    const second = await execute(handler, 0);
    // The selected shell emits a protective decision; the composer owns exit promotion.
    expect(second.exitCode).toBe(0);
    const refusal = JSON.parse(Buffer.from(second.stdout).toString());
    expect(refusal.decision).toBe('block');
    expect(refusal.reason).toContain('SECOND capability-risk command');
    expect(refusal.reason).toContain('ARMS the session danger latch');
    const latch = JSON.parse(fs.readFileSync(latchFile));
    expect(latch).toMatchObject({
      hook: 'block-dangerous.sh',
      decision: 'ask',
      command: input,
      reason: 'command substitution: destructive operation (K8S_DELETE)',
    });
    expect(latch.latch_generation).toMatch(/^[a-f0-9]{32}$/);
    expect(fs.readFileSync(warningFile)).toEqual(warningBytes);

    command('echo safe');
    request.payload.session_id = 'ordinary-sibling';
    request.inputJson = JSON.stringify(request.payload);
    const ordinary = await execute(handler, 0);
    expect(ordinary.exitCode).toBe(0);
    expect(Buffer.from(ordinary.stdout).toString()).toBe('');
    expect(fs.existsSync(path.join(state, 'danger-warn-ordinary-sibling.json'))).toBe(false);
    expect(fs.existsSync(path.join(state, 'danger-latch-ordinary-sibling.json'))).toBe(false);
  },
  20000
);

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
  expect(classify.mock.calls.length).toBe(0);
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
  expect(spawn.mock.calls.length).toBe(0);
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
    expect(spawn.mock.calls.length).toBe(0);
    expect(fs.readFileSync(path.join(project, '.git/index'))).toEqual(indexBefore);
    expect(fs.readFileSync(path.join(subdirectory, 'private.generated'), 'utf8')).toBe(
      'nested sentinel\n'
    );
  }
);

test('an unresolvable utility cwd retains the selected shell fallback', () => {
  const policy = path.join(project, 'utility-policy.json');
  fs.writeFileSync(policy, JSON.stringify({ version: 1, ignored_staging: true }));
  environment.CAWS_OPTIONAL_HOOK_POLICY = policy;
  command('git add -f private.generated');
  const handler = select('hook-utilities.sh');
  expect(tryExecuteStockHandler(handler, context())).not.toBeNull();
  fs.symlinkSync('loop', path.join(project, 'loop'));
  request.payload.cwd = 'loop';
  request.inputJson = JSON.stringify(request.payload);
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
