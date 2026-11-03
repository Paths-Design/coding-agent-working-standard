const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { spawnCoveredSync } = require('./child-coverage.cjs');
const { authorityFixture, cleanupAll, source, hash } = require('./authority-fixture');
const {
  parseExecutionEvidenceArguments,
  executionProfileBindings,
  executionProfileArguments,
  isExecutionProfileBuiltin,
} = require('../../dist/execution/authorizer');
const { image, systemImageMetadata, executionHostDiagnostic } = require('./authority-fixture');
const { snapshotNpmProject } = require('../../dist/execution/npm-project');
afterAll(cleanupAll);
const npmRoots = [];
afterAll(() =>
  npmRoots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
);
// Native ESM import is unavailable in Jest's VM. Exercise the actual private
// child entry with inert framed source, including the active mutant explicitly.
function evaluatePreparedExecution(
  record,
  envelope,
  fenceFd,
  timeout = 5000,
  entry = 'authorizer-main.js'
) {
  const body = Buffer.from(JSON.stringify(envelope));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  const active = String(
    globalThis.__stryker__?.activeMutant ?? process.env.__STRYKER_ACTIVE_MUTANT__ ?? ''
  );
  const child = spawnCoveredSync(
    process.execPath,
    [path.resolve(__dirname, '../../dist/execution', entry)],
    {
      input: Buffer.concat([header, body]),
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', __STRYKER_ACTIVE_MUTANT__: active },
      timeout,
      maxBuffer: 1048576,
      ...(fenceFd === undefined ? {} : { stdio: ['pipe', 'pipe', 'pipe', fenceFd] }),
    }
  );
  expect({ status: child.status, stderr: child.stderr.toString() }).toEqual({
    status: 0,
    stderr: '',
  });
  expect(child.stdout.readUInt32BE()).toBe(child.stdout.length - 4);
  const observation = JSON.parse(child.stdout.subarray(4).toString());
  expect(observation.invocationId).toBe(record.invocationId);
  expect(observation.executionDigest).toBe(envelope.executionDigest);
  return observation;
}
function request(record, revision = null, fence = null) {
  const bytes = Buffer.from(JSON.stringify(record));
  return {
    protocol: 'caws.execution.authorizer.v1',
    phase: revision === null ? 'analyze' : 'final_validate',
    invocationId: record.invocationId,
    recordBase64: bytes.toString('base64'),
    executionDigest: hash(bytes),
    expectedAuthorityRevision: revision,
    fence,
  };
}
async function observe(f, command, utilities = []) {
  const record = source(f, command, utilities);
  return evaluatePreparedExecution(record, request(record));
}
function npmRecord(f) {
  const runtimeRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'caws-npm-runtime-'))
  );
  npmRoots.push(runtimeRoot);
  const npmRoot = path.join(runtimeRoot, 'npm');
  fs.mkdirSync(path.join(npmRoot, 'bin'), { recursive: true });
  const entry = path.join(npmRoot, 'bin', 'npm-cli.js');
  fs.writeFileSync(entry, 'process.stdout.write("npm fixture should not execute")\n');
  const node = image(process.execPath);
  const packagePath = path.join(f.lane, 'package.json');
  fs.writeFileSync(packagePath, JSON.stringify({ scripts: { test: 'node tests/run.js' } }));
  const invocation = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'caws-npm-launch-'))
  );
  npmRoots.push(invocation);
  for (const name of ['output', 'tmp', 'cache'])
    fs.mkdirSync(path.join(invocation, name), { mode: 0o700 });
  source(f, 'npm test');
  const record = f.record;
  const safePath = [
    ...new Set(
      [path.dirname(node.path), '/usr/bin', '/bin'].map((name) => fs.realpathSync.native(name))
    ),
  ].join(':');
  record.profile.kind = 'npm-test-v1';
  record.profile.npm = {
    runtime: { node, entry: image(entry), root: npmRoot, generationManifestSha256: 'a'.repeat(64) },
    project: snapshotNpmProject(f.lane, safePath, record.limits.preparationDeadlineUnixMs),
  };
  record.execution.executable = node;
  record.execution.argv = [node.path, entry, '--prefix', f.lane, '--workspaces=false', 'test'];
  record.execution.environment = [
    ['CAWS_EXECUTION_CALL', record.association.callId],
    ['CAWS_EXECUTION_CALLER', record.association.callerAnchor],
    ['CAWS_EXECUTION_PROJECT', record.projectRoot],
    ['CAWS_EXECUTION_SESSION', record.association.sessionId],
    ['CAWS_EXECUTION_THREAD', record.association.threadId],
    ['CODEX_SANDBOX', 'seatbelt'],
    ['CODEX_SANDBOX_NETWORK_DISABLED', '1'],
    ['HOME', invocation],
    ['LC_ALL', 'C'],
    ['NPM_CONFIG_CACHE', path.join(invocation, 'cache')],
    ['NPM_CONFIG_GLOBALCONFIG', path.join(invocation, 'npm-global.npmrc')],
    ['NPM_CONFIG_SCRIPT_SHELL', '/bin/sh'],
    ['NPM_CONFIG_USERCONFIG', path.join(invocation, 'npm-user.npmrc')],
    ['PATH', safePath],
    ['TMPDIR', path.join(invocation, 'tmp')],
  ].map(([name, value]) => ({ name, value }));
  record.sandbox.writeCeiling = {
    schema: 'caws.execution.write-ceiling.v1',
    launchId: 'b'.repeat(64),
    invocationRoot: invocation,
    outputRoot: path.join(invocation, 'output'),
    tmpRoot: path.join(invocation, 'tmp'),
    cacheRoot: path.join(invocation, 'cache'),
    manifestSha256: 'c'.repeat(64),
  };
  return record;
}

function cargoRecord(f) {
  const { git } = require('../helpers/git-repo-factory');
  const lane = path.join(f.root, 'cargo-owned');
  git(f.root, ['worktree', 'move', f.lane, lane]);
  f.lane = lane;
  f.registry.owned.path = lane;
  fs.writeFileSync(f.registryPath, JSON.stringify(f.registry));
  f.record.association.callerAnchor = lane;
  f.record.execution.cwd = lane;
  const record = npmRecord(f);
  const runtimeRoot = path.dirname(record.profile.npm.runtime.root);
  const root = path.join(runtimeRoot, 'rust'),
    sdkRoot = path.join(runtimeRoot, 'sdk');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(sdkRoot);
  // Images model only Source observation; no compiler or USER is executed.
  for (const name of ['cargo', 'rustc', 'clang'])
    fs.copyFileSync('/bin/echo', path.join(root, 'bin', name));
  const pkg = path.join(lane, 'rust-probe');
  fs.mkdirSync(path.join(pkg, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(pkg, 'Cargo.toml'),
    '[package]\nname="source-probe"\nversion="0.1.0"\nedition="2024"\n'
  );
  fs.writeFileSync(
    path.join(pkg, 'Cargo.lock'),
    'version=4\n[[package]]\nname="source-probe"\nversion="0.1.0"\n'
  );
  fs.writeFileSync(path.join(pkg, 'src/main.rs'), 'fn main() { panic!("not executed"); }\n');
  const runtime = {
    cargo: image(path.join(root, 'bin/cargo')),
    rustc: image(path.join(root, 'bin/rustc')),
    linker: image(path.join(root, 'bin/clang')),
    root,
    sdkRoot,
    toolchainVersion: '1.99.1',
    generationManifestSha256: 'a'.repeat(64),
  };
  const project = require('../../dist/execution/cargo-project').snapshotCargoProject(
    lane,
    'rust-probe/Cargo.toml',
    Date.now() + 30000
  );
  record.profile = {
    kind: 'cargo-run-v1',
    source: 'cargo run --manifest-path rust-probe/Cargo.toml',
    utilities: [],
    cargo: { runtime, project },
  };
  const ceiling = record.sandbox.writeCeiling;
  record.execution.executable = runtime.cargo;
  record.execution.argv = [
    runtime.cargo.path,
    'run',
    '--locked',
    '--offline',
    '--frozen',
    '--jobs',
    '1',
    '--manifest-path',
    project.manifest.path,
    '--target-dir',
    `${ceiling.outputRoot}/target`,
    '--bin',
    project.packageName,
    '--message-format',
    'json-render-diagnostics',
  ];
  const bindings = new Map(record.execution.environment.map(({ name, value }) => [name, value]));
  for (const name of [...bindings.keys()]) if (name.startsWith('NPM_')) bindings.delete(name);
  bindings.set('CARGO_HOME', ceiling.cacheRoot);
  bindings.set(
    'CARGO_ENCODED_RUSTFLAGS',
    `--sysroot\x1f${root}\x1f-C\x1flinker=${runtime.linker.path}`
  );
  bindings.set('PATH', `${root}/bin:/usr/bin:/bin`);
  bindings.set('RUSTC', runtime.rustc.path);
  bindings.set('SDKROOT', sdkRoot);
  record.execution.environment = [...bindings]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  return record;
}
describe('bounded Cargo Source observation without compiler or USER execution', () => {
  test('admits the exact pinned profile while leaving project and private outputs unchanged', () => {
    const f = authorityFixture(),
      record = cargoRecord(f);
    const before = fs.readFileSync(record.profile.cargo.project.entry.path);
    expect(evaluatePreparedExecution(record, request(record)).decision).toBe('allow');
    expect(fs.readFileSync(record.profile.cargo.project.entry.path)).toEqual(before);
    expect(fs.readdirSync(record.sandbox.writeCeiling.outputRoot)).toEqual([]);
  });
  test.each(['environment', 'private-cache', 'manifest', 'entry', 'configuration', 'source'])(
    'refuses changed Cargo %s inputs before any USER execution',
    (which) => {
      const f = authorityFixture(),
        record = cargoRecord(f);
      if (which === 'environment') {
        record.execution.environment.push({ name: 'RUSTC_WRAPPER', value: '/bin/echo' });
        record.execution.environment.sort((a, b) =>
          Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))
        );
      }
      if (which === 'private-cache')
        fs.writeFileSync(
          path.join(record.sandbox.writeCeiling.cacheRoot, 'config.toml'),
          '[build]\n'
        );
      if (which === 'manifest')
        fs.appendFileSync(record.profile.cargo.project.manifest.path, 'build="arbitrary.rs"\n');
      if (which === 'entry')
        fs.appendFileSync(record.profile.cargo.project.entry.path, '// changed\n');
      if (which === 'configuration') {
        fs.mkdirSync(path.join(f.lane, '.cargo'));
        fs.writeFileSync(path.join(f.lane, '.cargo/config.toml'), '[build]\n');
      }
      if (which === 'source') record.profile.source = 'cargo run --manifest-path ../Cargo.toml';
      const result = evaluatePreparedExecution(record, request(record));
      expect(result.decision).not.toBe('allow');
      expect(fs.readdirSync(record.sandbox.writeCeiling.outputRoot)).toEqual([]);
    }
  );
});

describe('bounded npm test profile observation', () => {
  test('admits pinned inert project config while refusing stale config bytes or presence', () => {
    for (const change of ['bytes', 'presence']) {
      const f = authorityFixture(),
        record = npmRecord(f),
        file = path.join(f.lane, '.npmrc');
      fs.writeFileSync(file, 'cache=../unused\naudit=false\nfund=false\nupdate-notifier=false\n');
      const safePath = record.execution.environment.find(({ name }) => name === 'PATH').value;
      record.profile.npm.project = snapshotNpmProject(
        f.lane,
        safePath,
        record.limits.preparationDeadlineUnixMs
      );
      const admitted = evaluatePreparedExecution(record, request(record));
      expect(admitted.decision).toBe('allow');
      expect(record.profile.npm.project.npmrc.path).toBe(file);
      expect(fs.readdirSync(record.sandbox.writeCeiling.cacheRoot)).toEqual([]);
      if (change === 'bytes') fs.writeFileSync(file, 'cache=../different\naudit=false\n');
      else fs.unlinkSync(file);
      expect(evaluatePreparedExecution(record, request(record)).decision).not.toBe('allow');
      expect(fs.readdirSync(record.sandbox.writeCeiling.outputRoot)).toEqual([]);
    }
  });
  test('rechecks lifecycle tool bytes during final validation under the inherited fence', () => {
    const f = authorityFixture();
    const record = npmRecord(f);
    const directory = path.join(f.lane, 'node_modules', '.bin');
    fs.mkdirSync(directory, { recursive: true });
    const tool = path.join(f.lane, 'src', 'jest.js');
    fs.writeFileSync(tool, 'console.log("real tests")\n');
    fs.symlinkSync(tool, path.join(directory, 'jest'));
    fs.writeFileSync(
      path.join(f.lane, 'package.json'),
      JSON.stringify({ scripts: { test: 'jest' } })
    );
    record.profile.npm.project = snapshotNpmProject(
      f.lane,
      record.execution.environment.find((e) => e.name === 'PATH').value,
      record.limits.preparationDeadlineUnixMs
    );
    const analyzed = evaluatePreparedExecution(record, request(record));
    expect(analyzed.decision).toBe('allow');
    const lock = path.join(f.caws, 'state.lock');
    const fd = fs.openSync(lock, 'wx+', 0o600);
    try {
      const nonce = 'npm-final-fence';
      fs.writeFileSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          at: new Date().toISOString(),
          purpose: 'execution-launch',
          nonce,
          protocol: 'caws.execution.fence.v1',
        })
      );
      fs.fsyncSync(fd);
      const stat = fs.fstatSync(fd, { bigint: true });
      const envelope = request(record, analyzed.authorityRevision, {
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        nonce,
      });
      expect(evaluatePreparedExecution(record, envelope, fd).decision).toBe('allow');
      fs.writeFileSync(tool, 'console.log("fake green")\n');
      expect(evaluatePreparedExecution(record, envelope, fd).reasonCodes).toEqual([
        'unsupported_profile',
      ]);
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  });

  test('refuses lifecycle interpreter shadows in project and ancestor bin directories', () => {
    const f = authorityFixture();
    const record = npmRecord(f);
    for (const root of [f.lane, f.root]) {
      const bin = path.join(root, 'node_modules', '.bin');
      fs.mkdirSync(bin, { recursive: true });
      for (const name of ['node', 'sh']) {
        const shadow = path.join(bin, name);
        fs.writeFileSync(shadow, '#!/bin/sh\nprintf fake-green\\n\n', { mode: 0o755 });
        const reply = evaluatePreparedExecution(record, request(record));
        expect({ root, name, decision: reply.decision, reasons: reply.reasonCodes }).toEqual({
          root,
          name,
          decision: 'unresolved',
          reasons: ['unsupported_profile'],
        });
        fs.unlinkSync(shadow);
      }
    }
  });

  test('admits a pinned package script without running the npm entry', () => {
    const f = authorityFixture();
    const record = npmRecord(f);
    const result = evaluatePreparedExecution(record, request(record));
    expect(result.decision).toBe('allow');
    expect(result.reasonCodes).toEqual([]);
    expect(fs.readdirSync(record.sandbox.writeCeiling.outputRoot)).toEqual([]);
  });

  test('refuses duplicate config paths and newly populated private npm config sources', () => {
    const f = authorityFixture();
    const record = npmRecord(f);
    for (const key of ['NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_GLOBALCONFIG']) {
      const binding = record.execution.environment.find((entry) => entry.name === key);
      const expected = binding.value;
      binding.value = '/dev/null';
      expect(evaluatePreparedExecution(record, request(record)).reasonCodes).toEqual([
        'unsupported_profile',
      ]);
      binding.value = expected;
      fs.writeFileSync(expected, 'registry=https://untrusted.invalid/\n');
      expect(evaluatePreparedExecution(record, request(record)).reasonCodes).toEqual([
        'unsupported_profile',
      ]);
      fs.unlinkSync(expected);
      fs.symlinkSync(path.join(f.root, 'missing-config'), expected);
      expect(evaluatePreparedExecution(record, request(record)).reasonCodes).toEqual([
        'unsupported_profile',
      ]);
      fs.unlinkSync(expected);
    }
    expect(evaluatePreparedExecution(record, request(record)).decision).toBe('allow');
  });

  (process.env.CAWS_NPM_RUNTIME_ENTRY ? test : test.skip)(
    'runs pinned npm with distinct absent config sources and the private cache overriding project config',
    () => {
      const f = authorityFixture();
      const record = npmRecord(f);
      const entry = fs.realpathSync.native(process.env.CAWS_NPM_RUNTIME_ENTRY);
      record.profile.npm.runtime.entry = image(entry);
      record.profile.npm.runtime.root = path.dirname(path.dirname(entry));
      record.execution.argv[1] = entry;
      fs.mkdirSync(path.join(f.lane, 'tests'));
      fs.writeFileSync(
        path.join(f.lane, 'tests', 'run.js'),
        'console.log("CACHE_PROBE=" + JSON.stringify({cache:process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE,cwd:process.cwd()}));\n'
      );
      const foreignCache = path.join(f.root, 'foreign-cache');
      fs.writeFileSync(
        path.join(f.lane, '.npmrc'),
        `cache=${foreignCache}\naudit=false\nfund=false\nupdate-notifier=false\n`
      );
      const safePath = record.execution.environment.find((entry) => entry.name === 'PATH').value;
      record.profile.npm.project = snapshotNpmProject(
        f.lane,
        safePath,
        record.limits.preparationDeadlineUnixMs
      );
      expect(evaluatePreparedExecution(record, request(record)).decision).toBe('allow');
      const result = require('node:child_process').spawnSync(
        record.execution.executable.path,
        record.execution.argv.slice(1),
        {
          cwd: f.lane,
          env: Object.fromEntries(
            record.execution.environment.map(({ name, value }) => [name, value])
          ),
          encoding: 'utf8',
          timeout: 30000,
        }
      );
      expect({ status: result.status, stderr: result.stderr, error: result.error }).toEqual({
        status: 0,
        stderr: '',
        error: undefined,
      });
      const marker = result.stdout.split('\n').find((line) => line.startsWith('CACHE_PROBE='));
      expect(JSON.parse(marker.slice('CACHE_PROBE='.length))).toEqual({
        cache: record.sandbox.writeCeiling.cacheRoot,
        cwd: f.lane,
      });
      expect(fs.existsSync(foreignCache)).toBe(false);
      for (const name of ['npm-user.npmrc', 'npm-global.npmrc'])
        expect(fs.existsSync(path.join(record.sandbox.writeCeiling.invocationRoot, name))).toBe(
          false
        );
    }
  );

  test('rejects script replacement, lifecycle hooks, project config and PATH shadowing', () => {
    const f = authorityFixture();
    const record = npmRecord(f);
    const pkg = record.profile.npm.project.packageJson.path;
    fs.writeFileSync(pkg, JSON.stringify({ scripts: { test: 'node other.js' } }));
    expect(evaluatePreparedExecution(record, request(record)).reasonCodes).toEqual([
      'unsupported_profile',
    ]);
    fs.writeFileSync(
      pkg,
      JSON.stringify({ scripts: { test: 'node tests/run.js', pretest: 'node prepare.js' } })
    );
    record.profile.npm.project.packageJson = image(pkg);
    expect(evaluatePreparedExecution(record, request(record)).reasonCodes).toEqual([
      'unsupported_profile',
    ]);
    fs.writeFileSync(pkg, JSON.stringify({ scripts: { test: 'node tests/run.js' } }));
    record.profile.npm.project.packageJson = image(pkg);
    fs.writeFileSync(path.join(f.lane, '.npmrc'), 'script-shell=/bin/zsh\n');
    expect(evaluatePreparedExecution(record, request(record)).reasonCodes).toEqual([
      'unsupported_profile',
    ]);
    fs.unlinkSync(path.join(f.lane, '.npmrc'));
    record.execution.environment.find((entry) => entry.name === 'PATH').value =
      '/tmp:/usr/bin:/bin';
    expect(evaluatePreparedExecution(record, request(record)).reasonCodes).toEqual([
      'unsupported_profile',
    ]);
  });
});

const quoteWriterArg = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
function lifecycleFixture(landed = false) {
  const f = authorityFixture();
  const { git } = require('../helpers/git-repo-factory');
  f.record.limits.preparationDeadlineUnixMs = Date.now() + 120000;
  f.registry.owned.branch = 'owned';
  f.registry.owned.baseBranch = git(f.root, ['branch', '--show-current']);
  f.registry.owned.baseSha = git(f.root, ['rev-parse', 'HEAD']);
  fs.writeFileSync(f.registryPath, JSON.stringify(f.registry));
  if (landed) {
    fs.writeFileSync(f.specPath, require('js-yaml').dump(f.spec));
    fs.writeFileSync(
      path.join(f.root, '.gitignore'),
      '/owned*/\n.caws/claims/\n.caws/state.lock\n.caws/events.jsonl.lock\n'
    );
    git(f.root, ['add', '--', '.caws', '.gitignore']);
    git(f.root, ['commit', '-m', 'fixture governance']);
    fs.writeFileSync(path.join(f.lane, 'src/proof.txt'), 'landed source\n');
    git(f.lane, ['add', '--', 'src/proof.txt']);
    git(f.lane, ['commit', '-m', 'fixture source']);
    const session = { session_id: f.record.association.threadId, platform: 'codex' };
    const result = require('../../dist/store/worktrees-writer').mergeWorktree(f.caws, {
      name: 'owned',
      session,
      sessionCandidates: {
        candidates: [{ identity: session, source: 'codex_thread_env' }],
        trace: [],
      },
      actor: {
        kind: 'agent',
        id: session.session_id,
        session_id: session.session_id,
        platform: 'codex',
      },
      callerCwd: f.root,
      noClose: true,
    });
    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    f.mergeCommit = result.value.data.merge_commit;
  }
  return f;
}
function lifecycleRecord(f, args = ['git-head'], canonical = false) {
  if (canonical) {
    f.record.association.callerAnchor = f.root;
    f.record.execution.cwd = f.root;
  }
  const argv = [
    fs.realpathSync.native(process.execPath),
    path.resolve(__dirname, '../../dist/execution/lifecycle-main.js'),
    ...args,
  ];
  const record = source(f, argv.map(quoteWriterArg).join(' '), [argv[0], argv[1], '/usr/bin/git']);
  record.profile.kind = 'caws-lifecycle-v1';
  record.execution.executable = image(argv[0]);
  record.execution.argv = argv;
  record.execution.environment = Object.entries({
    CAWS_EXECUTION_PROJECT: record.projectRoot,
    CAWS_EXECUTION_CALLER: record.association.callerAnchor,
    CAWS_EXECUTION_SESSION: record.association.sessionId,
    CAWS_EXECUTION_THREAD: record.association.threadId,
    CAWS_EXECUTION_CALL: record.association.callId,
    LC_ALL: 'C',
    PATH: '/usr/bin:/bin',
  })
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  return record;
}

describe('dedicated lifecycle consumer Source admission', () => {
  test('doctor requires the complete physical runtime tuple and observes its chosen Git home', () => {
    const f = lifecycleFixture();
    const record = lifecycleRecord(f, ['doctor']);
    expect(evaluatePreparedExecution(record, request(record), undefined, 30000).decision).not.toBe(
      'allow'
    );
    const home = path.join(f.root, 'private-home'),
      cawsHome = path.join(home, 'machine'),
      codexHome = path.join(home, '.codex');
    fs.mkdirSync(cawsHome, { recursive: true });
    fs.mkdirSync(codexHome);
    record.execution.environment.push(
      { name: 'HOME', value: home },
      { name: 'CAWS_HOME', value: cawsHome },
      { name: 'CODEX_HOME', value: codexHome }
    );
    record.execution.environment.sort((a, b) =>
      Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))
    );
    expect(evaluatePreparedExecution(record, request(record), undefined, 30000).decision).toBe(
      'allow'
    );
    fs.writeFileSync(path.join(home, '.gitconfig'), '[include]\npath = /must-not-load\n');
    expect(evaluatePreparedExecution(record, request(record), undefined, 30000).decision).not.toBe(
      'allow'
    );
  });
  test.each(['worktree-merge', 'bridge-claim'])(
    'lifecycle %s uses operation authority in analyze and final validation without inventing an edit binding',
    (operation) => {
      const f = lifecycleFixture(operation === 'bridge-claim');
      const args =
        operation === 'worktree-merge'
          ? ['worktree-merge', '--worktree', 'owned', '--spec', 'EXEC-001']
          : ['bridge-claim', '--spec', 'EXEC-001', '--merge-commit', f.mergeCommit];
      const record = lifecycleRecord(f, args, true);
      let ordinaryRefusal;
      try {
        require('../../dist/execution/authority').readExecutionAuthority(record);
      } catch (error) {
        ordinaryRefusal = error.reason;
      }
      expect(ordinaryRefusal).toBe('binding_unavailable');
      if (operation === 'bridge-claim') {
        const draft = JSON.parse(JSON.stringify(record));
        draft.profile.kind = 'bash-clean-v1';
        draft.profile.utilities = [];
        draft.execution.executable = image('/bin/bash');
        draft.execution.argv = [
          draft.execution.executable.path,
          '--noprofile',
          '--norc',
          '-c',
          draft.profile.source,
        ];
        const discovery = evaluatePreparedExecution(
          draft,
          request(draft),
          undefined,
          30000,
          'program-discovery-main.js'
        );
        expect(discovery.status).toBe('observed');
        expect(discovery.execution).toEqual({
          kind: 'caws-lifecycle-v1',
          argv: record.execution.argv,
        });
        expect(fs.existsSync(path.join(f.caws, 'claims/bridge.json'))).toBe(false);
      }
      const before = fs.readFileSync(f.specPath);
      const analyzed = evaluatePreparedExecution(record, request(record), undefined, 30000);
      expect(analyzed.decision).toBe('allow');
      expect(analyzed.reasonCodes).toEqual([]);
      expect(analyzed.authorityRevision).toMatch(/^[0-9a-f]{64}$/);
      const lock = path.join(f.caws, 'state.lock');
      const fd = fs.openSync(lock, 'wx+', 0o600);
      const nonce = 'lifecycle-source-final';
      fs.writeFileSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          at: new Date().toISOString(),
          purpose: 'execution-launch',
          nonce,
          protocol: 'caws.execution.fence.v1',
        })
      );
      const stat = fs.fstatSync(fd, { bigint: true });
      const fence = { dev: stat.dev.toString(), ino: stat.ino.toString(), nonce };
      try {
        const final = request(record, analyzed.authorityRevision, fence);
        expect(evaluatePreparedExecution(record, final, fd, 30000).decision).toBe('allow');
        expect(
          evaluatePreparedExecution(
            record,
            { ...final, fence: { ...fence, nonce: 'wrong' } },
            fd,
            30000
          ).reasonCodes
        ).toEqual(['fence_unverified']);
        fs.appendFileSync(
          path.join(f.caws, 'policy.yaml'),
          '\n# authority changed after analysis\n'
        );
        expect(evaluatePreparedExecution(record, final, fd, 30000).reasonCodes).toEqual([
          'authority_changed',
        ]);
        expect(fs.fstatSync(fd, { bigint: true }).ino).toBe(stat.ino);
        expect(fs.existsSync(lock)).toBe(true);
      } finally {
        fs.closeSync(fd);
        fs.unlinkSync(lock);
      }
      expect(fs.readFileSync(f.specPath)).toEqual(before);
      expect(fs.existsSync(path.join(f.caws, 'claims/bridge.json'))).toBe(false);
    }
  );

  test('lifecycle Git stage observation never stages or launches its typed operation', () => {
    const f = lifecycleFixture();
    fs.writeFileSync(path.join(f.lane, 'src/proof.txt'), 'must remain untracked\n');
    const { git } = require('../helpers/git-repo-factory');
    const index = git(f.lane, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const before = fs.readFileSync(index);
    const record = lifecycleRecord(f, ['git-stage', '--', 'src/proof.txt']);
    expect(evaluatePreparedExecution(record, request(record), undefined, 30000).decision).toBe(
      'allow'
    );
    expect(fs.readFileSync(index)).toEqual(before);
    expect(git(f.lane, ['diff', '--cached', '--name-only'])).toBe('');
  });

  test.each([
    'source',
    'argv',
    'stdin',
    'environment',
    'path',
    'image',
    'missing-image',
    'generic-git',
    'generic-node',
  ])('lifecycle refuses %s substitution before its operation can run', (target) => {
    const f = lifecycleFixture();
    const record = lifecycleRecord(f);
    if (target === 'source') record.profile.source += '; true';
    if (target === 'argv') record.execution.argv.push('--unknown');
    if (target === 'stdin') record.execution.stdinBase64 = Buffer.from('input').toString('base64');
    if (target === 'environment')
      record.execution.environment.find((entry) => entry.name === 'CAWS_EXECUTION_THREAD').value =
        'spoofed';
    if (target === 'path')
      record.execution.environment.find((entry) => entry.name === 'PATH').value =
        '/usr/bin:/bin:/usr/sbin';
    if (target === 'image') record.profile.utilities[1].sha256 = 'f'.repeat(64);
    if (target === 'missing-image') record.profile.utilities.pop();
    if (target === 'generic-git') record.profile.source = 'git status --short';
    if (target === 'generic-node')
      record.profile.source = `${quoteWriterArg(record.execution.argv[0])} /tmp/user.js git-head`;
    const result = evaluatePreparedExecution(record, request(record), undefined, 30000);
    expect(result.decision).toBe('unresolved');
    expect(result.reasonCodes).toEqual(['unsupported_profile']);
    expect(fs.existsSync(f.lane)).toBe(true);
    expect(fs.existsSync(path.join(f.caws, 'claims/bridge.json'))).toBe(false);
  });
});

function evidenceRecord(f, extra = []) {
  const argv = [
    fs.realpathSync.native(process.execPath),
    path.resolve(__dirname, '../../dist/execution/writer-main.js'),
    'specs',
    'evidence',
    'EXEC-001',
    '--ac',
    'A1',
    '--status',
    'unchecked',
    '--evidence-ref',
    'node /tmp/input.js; sed -i /etc/profile $(touch foreign) ${HOME}\nquoted data',
    ...extra,
  ];
  const command = argv.map(quoteWriterArg).join(' ');
  const record = source(f, command, [argv[0], argv[1], '/usr/bin/git']);
  record.profile.kind = 'caws-evidence-v1';
  record.execution.executable = image(argv[0]);
  record.execution.argv = argv;
  record.execution.environment.push(
    { name: 'CAWS_EXECUTION_PROJECT', value: record.projectRoot },
    { name: 'CAWS_EXECUTION_CALLER', value: record.association.callerAnchor },
    { name: 'CAWS_EXECUTION_SESSION', value: record.association.sessionId },
    { name: 'CAWS_EXECUTION_THREAD', value: record.association.threadId },
    { name: 'CAWS_EXECUTION_CALL', value: record.association.callId }
  );
  record.execution.environment.sort((a, b) =>
    Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))
  );
  return record;
}

describe('dedicated evidence consumer admission, before any writer execution', () => {
  test('preserves the complete typed operation and inert metadata values', () => {
    expect(
      parseExecutionEvidenceArguments(
        [
          'specs',
          'evidence',
          'EXEC-001',
          '--ac',
          'A1',
          '--status',
          'pass',
          '--evidence-ref',
          'artifact\nproof',
          '--command',
          'node a.js; $(touch /foreign)',
          '--exit-code',
          '-12',
          '--artifact-path',
          'src/proof.txt',
          '--commit-sha',
          'ab'.repeat(20),
          '--verify',
        ],
        'EXEC-001'
      )
    ).toStrictEqual({
      id: 'EXEC-001',
      criterionId: 'A1',
      status: 'pass',
      evidenceRef: 'artifact\nproof',
      command: 'node a.js; $(touch /foreign)',
      exitCode: -12,
      artifactPath: 'src/proof.txt',
      commitSha: 'ab'.repeat(20),
      verify: true,
    });
  });
  test.each(['pass', 'fail', 'unchecked'])(
    'records the explicit %s claim without inventing verification',
    (status) => {
      expect(
        parseExecutionEvidenceArguments(
          [
            'specs',
            'evidence',
            'EXEC-001',
            '--ac',
            'A1',
            '--status',
            status,
            '--evidence-ref',
            'self-reported',
          ],
          'EXEC-001'
        )
      ).toStrictEqual({
        id: 'EXEC-001',
        criterionId: 'A1',
        status,
        evidenceRef: 'self-reported',
        verify: false,
      });
    }
  );
  const evidenceArgs = (...suffix) => [
    'specs',
    'evidence',
    'EXEC-001',
    '--ac',
    'A1',
    '--status',
    'pass',
    '--evidence-ref',
    'proof',
    ...suffix,
  ];
  test.each([
    [0, 'spec'],
    [1, 'record'],
    [2, 'FOREIGN-001'],
  ])(
    'refuses independently changed operation coordinate %s with a valid suffix',
    (position, replacement) => {
      const args = evidenceArgs();
      args[position] = replacement;
      expect(() => parseExecutionEvidenceArguments(args, 'EXEC-001')).toThrow(
        expect.objectContaining({ reason: 'scope_refused' })
      );
    }
  );
  test.each(['A', 'A_1.long-criterion'])(
    'preserves complete criterion identity %s and omits absent optional members',
    (criterionId) => {
      const args = evidenceArgs();
      args[4] = criterionId;
      expect(parseExecutionEvidenceArguments(args, 'EXEC-001')).toStrictEqual({
        id: 'EXEC-001',
        criterionId,
        status: 'pass',
        evidenceRef: 'proof',
        verify: false,
      });
    }
  );
  test.each(['0', '1', '19', '-12', String(Number.MAX_SAFE_INTEGER)])(
    'preserves exact safe exit code %s',
    (value) => {
      expect(
        parseExecutionEvidenceArguments(evidenceArgs('--exit-code', value), 'EXEC-001')
      ).toStrictEqual({
        id: 'EXEC-001',
        criterionId: 'A1',
        status: 'pass',
        evidenceRef: 'proof',
        verify: false,
        exitCode: Number(value),
      });
    }
  );
  test.each(['x12', '12x', '01', '-01', ''])('refuses noncanonical exit code %p', (value) =>
    expect(() =>
      parseExecutionEvidenceArguments(evidenceArgs('--exit-code', value), 'EXEC-001')
    ).toThrow(expect.objectContaining({ reason: 'unsupported_profile' }))
  );
  test.each(['x' + 'a'.repeat(40), 'a'.repeat(40) + 'x'])(
    'refuses a commit with a valid SHA substring %s',
    (value) =>
      expect(() =>
        parseExecutionEvidenceArguments(evidenceArgs('--commit-sha', value), 'EXEC-001')
      ).toThrow(expect.objectContaining({ reason: 'unsupported_profile' }))
  );
  test.each([
    ['--verify'],
    ['--verify', '--artifact-path', 'src/proof.txt'],
    ['--verify', '--commit-sha', 'a'.repeat(40)],
    ['--verify', '--verify', '--artifact-path', 'src/proof.txt', '--commit-sha', 'a'.repeat(40)],
  ])('refuses incomplete verification or duplicate verification %j', (...suffix) => {
    expect(() => parseExecutionEvidenceArguments(evidenceArgs(...suffix), 'EXEC-001')).toThrow(
      expect.objectContaining({ reason: 'unsupported_profile' })
    );
  });
  test.each(
    [
      ['specs', 'close', 'EXEC-001'],
      ['specs', 'evidence', 'FOREIGN-001'],
      ['specs', 'evidence', 'EXEC-001', '--ac', 'A1', '--status', 'pass'],
      [
        'specs',
        'evidence',
        'EXEC-001',
        '--ac',
        'A1',
        '--status',
        'unknown',
        '--evidence-ref',
        'proof',
      ],
      [
        'specs',
        'evidence',
        'EXEC-001',
        '--ac',
        'bad/criterion',
        '--status',
        'pass',
        '--evidence-ref',
        'proof',
      ],
      ['specs', 'evidence', 'EXEC-001', '--ac', 'A1', '--status', 'pass', '--evidence-ref', '  '],
      ['specs', 'evidence', 'EXEC-001', '--ac', 'A1', '--status', 'pass', '--evidence-ref'],
    ].map((args) => [args])
  )('refuses incomplete or foreign operation %j', (args) => {
    expect(() => parseExecutionEvidenceArguments(args, 'EXEC-001')).toThrow();
  });
  test('admits exact pinned literal argv while quoted program names remain inert metadata', () => {
    const f = authorityFixture();
    const record = evidenceRecord(f);
    const reply = evaluatePreparedExecution(record, request(record));
    expect(reply.decision).toBe('allow');
    expect(reply.reasonCodes).toEqual([]);
    expect(fs.readFileSync(f.specPath, 'utf8')).not.toContain('evidence_ref');
    expect(fs.existsSync(path.join(f.caws, 'events.jsonl'))).toBe(false);
  });
  test.each([
    [
      'compound',
      (r) => {
        r.profile.source += '; printf bad > ../foreign-marker';
      },
    ],
    [
      'redirect',
      (r) => {
        r.profile.source += ' > ../foreign-marker';
      },
    ],
    [
      'background',
      (r) => {
        r.profile.source += ' &';
      },
    ],
    [
      'argv drift',
      (r) => {
        r.execution.argv[r.execution.argv.length - 1] = 'different metadata';
      },
    ],
    [
      'callee drift',
      (r) => {
        r.execution.argv[1] = '/tmp/foreign-writer.js';
      },
    ],
    [
      'image drift',
      (r) => {
        r.profile.utilities[1].sha256 = '0'.repeat(64);
      },
    ],
    [
      'actor drift',
      (r) => {
        r.execution.environment.find((e) => e.name === 'CAWS_EXECUTION_THREAD').value = 'foreign';
      },
    ],
    [
      'extra startup control',
      (r) => {
        r.execution.environment.push({ name: 'NODE_OPTIONS', value: '--require=/tmp/payload' });
      },
    ],
  ])('holds %s without publishing authority state', (_label, change) => {
    const f = authorityFixture();
    const record = evidenceRecord(f);
    const before = fs.readFileSync(f.specPath);
    change(record);
    record.execution.environment.sort((a, b) =>
      Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))
    );
    const reply = evaluatePreparedExecution(record, request(record));
    expect(reply.decision).toBe('unresolved');
    expect(reply.reasonCodes).toEqual(['unsupported_profile']);
    expect(fs.readFileSync(f.specPath)).toEqual(before);
    expect(fs.existsSync(path.join(f.root, 'foreign-marker'))).toBe(false);
  });
  test('the private writer is not admitted through the generic shell profile', () => {
    const f = authorityFixture();
    const record = evidenceRecord(f);
    record.profile.kind = 'bash-clean-v1';
    record.execution.executable = image('/bin/bash');
    record.execution.argv = [
      record.execution.executable.path,
      '--noprofile',
      '--norc',
      '-c',
      record.profile.source,
    ];
    const reply = evaluatePreparedExecution(record, request(record));
    expect(reply.decision).toBe('unresolved');
    expect(reply.reasonCodes).toEqual(['unsupported_profile']);
  });
  test.each([
    ['--test-nodeid', 'tests/project.test.js::runs'],
    ['--status', 'waived'],
    ['--ac', 'A2'],
    ['--verify', '--verify'],
    ['--artifact-path', '../foreign'],
    ['--artifact-path', './src/proof.txt'],
    ['--artifact-path', '/foreign'],
    ['--artifact-path', 'src/proof\n.txt'],
    ['--commit-sha', '--help'],
    ['--commit-sha', 'A'.repeat(40)],
    ['--exit-code', '1.5'],
    ['--exit-code', '9007199254740992'],
    ['--evidence-ref', 'duplicate'],
    ['--command', 'contains\0nul'],
    ['--unknown', 'value'],
  ])('closed grammar refuses %s additions', (...addition) => {
    expect(() =>
      parseExecutionEvidenceArguments(
        [
          'specs',
          'evidence',
          'EXEC-001',
          '--ac',
          'A1',
          '--status',
          'pass',
          '--evidence-ref',
          'proof',
          ...addition,
        ],
        'EXEC-001'
      )
    ).toThrow();
  });
});
describe('execution profile primitives', () => {
  test.each([':', 'cd', 'printf', 'echo', 'pwd', 'true', 'false', 'test', '[', 'read'])(
    'recognizes exact builtin %s',
    (name) => expect(isExecutionProfileBuiltin(name)).toBe(true)
  );
  test.each([
    '',
    'command',
    'exec',
    'eval',
    'source',
    'export',
    'readonly',
    'unset',
    'readarray',
    'mapfile',
    'Read',
    'readx',
    'xread',
    '/bin/echo',
    'echo ',
  ])('does not broaden builtin authority to %p', (name) =>
    expect(isExecutionProfileBuiltin(name)).toBe(false)
  );
  test('unwraps at most eight command wrappers while preserving argument identities', () => {
    const leaf = { value: 'printf', source: { start: 80, end: 86 } };
    const data = { value: null, source: { start: 87, end: 94 } };
    const plain = [leaf, data];
    expect(executionProfileArguments(plain)).toBe(plain);
    for (const separator of [false, true]) {
      const wrapped = [...Array(8)].flatMap(() =>
        separator ? [{ value: 'command' }, { value: '--' }] : [{ value: 'command' }]
      );
      wrapped.push(leaf, data);
      const result = executionProfileArguments(wrapped);
      expect(result).toStrictEqual(plain);
      expect(result[0]).toBe(leaf);
      expect(result[1]).toBe(data);
      expect(wrapped.at(-1)).toBe(data);
      expect(() => executionProfileArguments([{ value: 'command' }, ...wrapped])).toThrow(
        expect.objectContaining({ reason: 'unsupported_profile' })
      );
    }
    const flag = { value: '-p' };
    expect(executionProfileArguments([{ value: 'command' }, flag, leaf])).toStrictEqual([
      flag,
      leaf,
    ]);
    expect(executionProfileArguments([{ value: 'command' }])).toStrictEqual([]);
  });
  test('derives PWD from execution cwd and retains only ordinary inherited application bindings', () => {
    const f = authorityFixture();
    for (const name of [
      'XUID',
      'UIDX',
      'XEXECIGNORE',
      'EXECIGNOREX',
      'BASH_LONG_NAME',
      'COMP_LONG_NAME',
      'UID',
      'EUID',
    ])
      f.record.execution.environment.push({ name, value: name + '-data' });
    const result = executionProfileBindings(f.record);
    expect(result.get('PWD')).toStrictEqual([f.lane]);
    for (const name of ['XUID', 'UIDX', 'XEXECIGNORE', 'EXECIGNOREX'])
      expect(result.get(name)).toStrictEqual([name + '-data']);
    for (const name of ['BASH_LONG_NAME', 'COMP_LONG_NAME', 'UID', 'EUID'])
      expect(result.has(name)).toBe(false);
  });
  test('refuses locale controls, inherited cwd and nonphysical PATH directories', () => {
    const f = authorityFixture();
    const original = f.record.execution.environment.map((entry) => ({ ...entry }));
    const directory = path.join(f.root, 'physical-path');
    const alias = path.join(f.root, 'path-alias');
    const file = path.join(f.root, 'path-file');
    fs.mkdirSync(directory);
    fs.symlinkSync(directory, alias);
    fs.writeFileSync(file, 'data');
    const controls = [
      ['LANG', 'en_US.UTF-8'],
      ['LC_ALL', ''],
      ['PWD', f.lane],
      ['OLDPWD', f.root],
      ['PATH', ''],
      ['PATH', 'relative'],
      ['PATH', alias],
      ['PATH', file],
      ['PATH', directory + ':'],
      ['PATH', ':' + directory],
    ];
    for (const [name, value] of controls) {
      f.record.execution.environment = original.filter((entry) => entry.name !== name);
      f.record.execution.environment.push({ name, value });
      expect(() => executionProfileBindings(f.record)).toThrow(
        expect.objectContaining({ reason: 'unsupported_profile' })
      );
    }
    f.record.execution.environment = original.filter((entry) => entry.name !== 'PATH');
    expect(() => executionProfileBindings(f.record)).toThrow(
      expect.objectContaining({ reason: 'unsupported_profile' })
    );
    f.record.execution.environment = original;
    f.record.execution.environment.push({ name: 'LANG', value: 'C' });
    expect(executionProfileBindings(f.record).get('LANG')).toStrictEqual(['C']);
  });
});

describe('private authorizer component observations, without USER execution', () => {
  test.each(['printf data 2>&1', 'printf data 1>&-', 'read value < src/input.txt'])(
    'admits modeled descriptors and ordinary read operands without executing %s',
    async (command) => {
      const f = authorityFixture();
      const input = path.join(f.lane, 'src/input.txt');
      fs.writeFileSync(input, 'literal data\n');
      const result = await observe(f, command);
      expect(result).toMatchObject({ decision: 'allow', reasonCodes: [] });
      expect(fs.readFileSync(input, 'utf8')).toBe('literal data\n');
    }
  );
  test('keeps read options outside the declared bare-destination profile without executing source', async () => {
    const f = authorityFixture();
    const input = path.join(f.lane, 'src/input.txt');
    fs.writeFileSync(input, 'literal data\n');
    const result = await observe(f, 'read -r value < src/input.txt');
    expect(result).toMatchObject({ decision: 'unresolved', reasonCodes: ['source_unresolved'] });
    expect(fs.readFileSync(input, 'utf8')).toBe('literal data\n');
  });
  test.each([
    ['grep', 'grep literal src/input.txt', '/usr/bin/grep'],
    ['head', 'head -n 1 src/input.txt', '/usr/bin/head'],
    ['tail', 'tail -n 1 src/input.txt', '/usr/bin/tail'],
    ['wc', 'wc -l src/input.txt', '/usr/bin/wc'],
    ['ls', 'ls src', '/bin/ls'],
    ['cut', 'cut -c 1 src/input.txt', '/usr/bin/cut'],
    ['tr', 'tr a b < src/input.txt', '/usr/bin/tr'],
    ['uniq', 'uniq src/input.txt', '/usr/bin/uniq'],
  ])(
    'admits pinned actual system reader %s without submitting effects',
    async (_name, command, utility) => {
      const f = authorityFixture();
      const input = path.join(f.lane, 'src/input.txt');
      fs.writeFileSync(input, 'literal data\n');
      const result = await observe(f, command, [utility]);
      if (process.env.CAWS_TEST_EXECUTION_HOST_CENSUS === '1' && result.decision !== 'allow')
        executionHostDiagnostic('system-reader-refusal', {
          command,
          image: systemImageMetadata(utility),
          decision: result.decision,
          reasonCodes: result.reasonCodes,
        });
      expect(result.decision).toBe('allow');
      expect(result.reasonCodes).toEqual([]);
      expect(fs.readFileSync(input, 'utf8')).toBe('literal data\n');
    }
  );
  test.each(['node -e', 'node -p "1"', 'node -e "1" extra'])(
    'holds Node invocation outside the exact inline profile: %s',
    async (command) => {
      const f = authorityFixture();
      f.record.execution.environment.find((entry) => entry.name === 'PATH').value =
        `${fs.realpathSync.native(path.dirname(process.execPath))}:${f.record.execution.environment.find((entry) => entry.name === 'PATH').value}`;
      const result = await observe(f, command, [process.execPath]);
      expect(result.decision).toBe('unresolved');
      expect(result.reasonCodes).toEqual(['unsupported_profile']);
    }
  );
  test('rejects reader aliases to writers or shells while accepting an alias to the actual reader', async () => {
    const f = authorityFixture();
    const directory = path.join(f.root, 'utility-path');
    fs.mkdirSync(directory);
    const alias = path.join(directory, 'cat');
    f.record.execution.environment.find((entry) => entry.name === 'PATH').value =
      `${directory}:${f.record.execution.environment.find((entry) => entry.name === 'PATH').value}`;
    const target = path.join(f.root, 'must-remain-absent');
    for (const image of ['/usr/bin/touch', '/bin/bash']) {
      fs.symlinkSync(fs.realpathSync.native(image), alias);
      const observation = await observe(f, `cat ${JSON.stringify(target)}`, [image]);
      expect(observation.decision).toBe('unresolved');
      expect(observation.reasonCodes).toEqual(['unsupported_profile']);
      expect(fs.existsSync(target)).toBe(false);
      fs.unlinkSync(alias);
    }
    fs.symlinkSync(fs.realpathSync.native('/bin/cat'), alias);
    const benign = await observe(f, 'cat src/data.txt', ['/bin/cat']);
    expect(benign.decision).toBe('allow');
    expect(benign.reasonCodes).toEqual([]);
  });
  test('allows benign computed sed data and owned finite redirection without executing either', async () => {
    const f = authorityFixture();
    fs.writeFileSync(path.join(f.lane, 'notes\nfile.txt'), 'line one\n');
    const result = await observe(
      f,
      'file="notes\nfile.txt"; sed -n 1p -- "$file" > src/result.txt',
      ['/usr/bin/sed']
    );
    expect(result.decision).toBe('allow');
    expect(result.reasonCodes).toEqual([]);
    expect(fs.existsSync(path.join(f.lane, 'src/result.txt'))).toBe(false);
    expect(result.authorityRevision).toMatch(/^[a-f0-9]{64}$/);
  });
  test.each([
    ['relative', false],
    ['absolute', false],
    ['relative', true],
    ['absolute', true],
  ])(
    'admits scoped writes in a default managed lane (%s, existing=%s)',
    async (spelling, existing) => {
      const f = authorityFixture({ laneRelativePath: '.caws/worktrees/owned' });
      const target = path.join(f.lane, 'src/owned.txt');
      if (existing) fs.writeFileSync(target, 'preserve');
      const name = spelling === 'absolute' ? target : 'src/owned.txt';
      const result = await observe(f, `printf changed > ${JSON.stringify(name)}`);
      expect(result).toMatchObject({ decision: 'allow', reasonCodes: [] });
      if (existing) expect(fs.readFileSync(target, 'utf8')).toBe('preserve');
      else expect(fs.existsSync(target)).toBe(false);
    }
  );
  test('preserves control, foreign-lane and excluded-path refusals in a default managed lane', async () => {
    const { git } = require('../helpers/git-repo-factory');
    const f = authorityFixture({ laneRelativePath: '.caws/worktrees/owned' });
    f.spec.scope.in = ['**'];
    f.spec.scope.out = ['src/excluded.txt'];
    fs.writeFileSync(f.specPath, JSON.stringify(f.spec));
    const foreign = path.join(f.caws, 'worktrees/foreign');
    git(f.root, ['worktree', 'add', '-b', 'foreign', foreign]);
    const foreignSpec = { ...f.spec, id: 'EXEC-FOREIGN-001', worktree: 'foreign' };
    expect(
      require('../../dist/kernel').parseAndValidateSpec(JSON.stringify(foreignSpec))
    ).toMatchObject({ ok: true });
    fs.writeFileSync(path.join(f.caws, 'specs/EXEC-FOREIGN-001.yaml'), JSON.stringify(foreignSpec));
    f.registry.foreign = {
      path: foreign,
      specId: foreignSpec.id,
      owner: { session_id: 'other-thread', platform: 'codex' },
    };
    fs.writeFileSync(f.registryPath, JSON.stringify(f.registry));
    for (const target of [
      path.join(f.caws, 'policy.yaml'),
      f.registryPath,
      path.join(f.lane, '.git'),
      path.join(f.lane, '.caws/policy.yaml'),
      path.join(f.lane, '.codex/settings.json'),
      path.join(f.lane, '.claude/settings.json'),
      path.join(f.lane, '.env'),
      path.join(f.lane, 'src/excluded.txt'),
      path.join(foreign, 'ordinary.txt'),
    ]) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target)) fs.writeFileSync(target, 'preserve');
      const before = fs.readFileSync(target);
      const result = await observe(f, `printf changed > ${JSON.stringify(target)}`);
      // Git marker writes invalidate the analyzer's repository mapping and
      // remain held before path admission.
      const expected =
        target === path.join(f.lane, '.git')
          ? { decision: 'unresolved', reasonCodes: ['source_unresolved'] }
          : { decision: 'deny', reasonCodes: ['scope_refused'] };
      expect(result).toMatchObject(expected);
      expect(fs.readFileSync(target)).toEqual(before);
    }
    expect((await observe(f, 'printf yes > src/ordinary.txt')).decision).toBe('allow');
    expect(fs.existsSync(path.join(f.lane, 'src/ordinary.txt'))).toBe(false);
  });
  test.each(['.caws/hooks/ext', '.caws/worktrees', '.caws/worktrees/outer/.caws/hooks/ext'])(
    'refuses a registered checkout overlapping control storage: %s',
    async (laneRelativePath) => {
      const f = authorityFixture({ laneRelativePath });
      f.spec.scope.in = ['**'];
      f.spec.scope.out = [];
      fs.writeFileSync(f.specPath, JSON.stringify(f.spec));
      const target = path.join(f.lane, 'qualification.sh');
      fs.writeFileSync(target, 'preserve');
      const result = await observe(f, 'printf changed > qualification.sh');
      expect(result).toMatchObject({ decision: 'deny', reasonCodes: ['scope_refused'] });
      expect(fs.readFileSync(target, 'utf8')).toBe('preserve');
    }
  );
  test('allows harmless JavaScript braces and finite owned fs writes on the pinned actual Node image', async () => {
    const f = authorityFixture();
    f.record.execution.environment.find((entry) => entry.name === 'PATH').value =
      `${fs.realpathSync.native(path.dirname(process.execPath))}:${f.record.execution.environment.find((entry) => entry.name === 'PATH').value}`;
    const read = await observe(f, 'node -e \'console.log({kind:"data", values:[1,2]})\'', [
      process.execPath,
    ]);
    expect(read.decision).toBe('allow');
    const write = await observe(
      f,
      'node -e \'require("node:fs").writeFileSync("src/owned.txt","ok")\'',
      [process.execPath]
    );
    expect(write.decision).toBe('allow');
    expect(fs.existsSync(path.join(f.lane, 'src/owned.txt'))).toBe(false);
  });
  test.each([
    ['foreign write', 'printf ok > ../canonical.txt', [], 'deny', 'scope_refused'],
    ['out of scope', 'printf ok > outside.txt', [], 'deny', 'scope_refused'],
    ['authority write', 'printf ok > .caws/state.lock', [], 'deny', 'scope_refused'],
    ['unknown executable', 'npm run build', [], 'unresolved', 'unsupported_profile'],
    ['implicit temp writer', 'sort notes.txt', [], 'unresolved', 'unsupported_profile'],
    ['dynamic executable', '"$unknown" arg', [], 'unresolved', 'source_unresolved'],
    [
      'executable sed',
      'sed -n "1e touch sentinel" notes.txt',
      ['/usr/bin/sed'],
      'deny',
      'source_denied',
    ],
    ['private descriptor', 'printf data >&3', [], 'unresolved', 'unsupported_profile'],
    ['opened private descriptor', '3>src/opened.txt', [], 'unresolved', 'unsupported_profile'],
  ])(
    'holds %s with zero submitted effects',
    async (_name, command, utilities, decision, reason) => {
      const f = authorityFixture();
      const result = await observe(f, command, utilities);
      expect(result.decision).toBe(decision);
      expect(result.reasonCodes).toEqual([reason]);
      expect(fs.existsSync(path.join(f.lane, 'sentinel'))).toBe(false);
    }
  );
  test.each([
    "true 3<<'EOF'\ndata\nEOF",
    "true <<'EOF'\ndata\nEOF",
    'true 3<<< "data"',
    'true <<< "data"',
  ])('holds here-input descriptors and implicit temporary-file effects: %s', async (command) => {
    const f = authorityFixture();
    const result = await observe(f, command);
    expect(result.decision).toBe('unresolved');
    expect(result.reasonCodes).toEqual(['unsupported_profile']);
    expect(fs.readdirSync(path.join(f.lane, 'src'))).toEqual([]);
  });
  test('denies known sed execution and foreign Node writes after valid image preparation', async () => {
    const f = authorityFixture();
    fs.writeFileSync(path.join(f.lane, 'notes.txt'), 'data');
    expect(
      (await observe(f, 'sed -n "1e touch sentinel" notes.txt', ['/usr/bin/sed'])).reasonCodes
    ).toEqual(['source_denied']);
    f.record.execution.environment.find((entry) => entry.name === 'PATH').value =
      `${fs.realpathSync.native(path.dirname(process.execPath))}:${f.record.execution.environment.find((entry) => entry.name === 'PATH').value}`;
    expect(
      (
        await observe(f, 'node -e \'require("node:fs").writeFileSync("../foreign.txt","no")\'', [
          process.execPath,
        ])
      ).reasonCodes
    ).toEqual(['scope_refused']);
    expect(fs.existsSync(path.join(f.root, 'foreign.txt'))).toBe(false);
  });
  test('checks the canonical existing file entry against exclusions on aliasing filesystems', async () => {
    const f = authorityFixture();
    const target = path.join(f.lane, 'src/protected.txt');
    fs.writeFileSync(target, 'preserve');
    f.spec.scope.out.push('src/protected.txt');
    fs.writeFileSync(f.specPath, JSON.stringify(f.spec));
    const alias = path.join(f.lane, 'src/PROTECTED.TXT');
    let aliases = false;
    try {
      aliases = fs.statSync(alias).ino === fs.statSync(target).ino;
    } catch (error) {
      expect(error.code).toBe('ENOENT');
    }
    const result = await observe(f, 'printf no > src/PROTECTED.TXT');
    expect(result.decision).toBe(aliases ? 'deny' : 'allow');
    expect(result.reasonCodes).toEqual(aliases ? ['scope_refused'] : []);
    expect(fs.readFileSync(target, 'utf8')).toBe('preserve');
    expect(fs.existsSync(alias)).toBe(aliases);
  });
  test('holds ambiguous prospective exclusions and admits distinct ordinary ASCII names', async () => {
    const f = authorityFixture();
    f.spec.scope.out.push('src/protected.txt');
    fs.writeFileSync(f.specPath, JSON.stringify(f.spec));
    const held = await observe(f, 'printf no > src/PROTECTED.TXT');
    expect(held.decision).toBe('unresolved');
    expect(held.reasonCodes).toEqual(['source_unresolved']);
    const allowed = await observe(f, 'printf yes > src/unrelated.txt');
    expect(allowed.decision).toBe('allow');
    expect(allowed.reasonCodes).toEqual([]);
    expect(fs.readdirSync(path.join(f.lane, 'src'))).toEqual([]);
  });
  test('holds unresolved Unicode write-path equivalence while keeping UTF-8 data inert', async () => {
    const f = authorityFixture();
    const target = path.join(f.lane, 'src/caf\u00e9.txt');
    fs.writeFileSync(target, 'preserve');
    for (const command of ['printf no > src/caf\u00e9.txt', 'printf no > src/new\u00e9.txt']) {
      const result = await observe(f, command);
      expect(result.decision).toBe('unresolved');
      expect(result.reasonCodes).toEqual(['source_unresolved']);
    }
    expect((await observe(f, 'printf "caf\u00e9" > src/data.txt')).decision).toBe('allow');
    expect(fs.readFileSync(target, 'utf8')).toBe('preserve');
    expect(fs.existsSync(path.join(f.lane, 'src/data.txt'))).toBe(false);
  });
  test('holds dangling exclusion identity and preserves explicit non-governed policy precedence', async () => {
    const f = authorityFixture();
    f.spec.scope.out.push('src/dangling');
    fs.writeFileSync(f.specPath, JSON.stringify(f.spec));
    fs.symlinkSync('not-created', path.join(f.lane, 'src/dangling'));
    expect((await observe(f, 'printf no > src/result.txt')).reasonCodes).toEqual([
      'source_unresolved',
    ]);
    const policyPath = path.join(f.caws, 'policy.yaml');
    const policy = require('js-yaml').load(fs.readFileSync(policyPath, 'utf8'));
    policy.non_governed_zones = ['src/**'];
    fs.writeFileSync(policyPath, JSON.stringify(policy));
    const result = await observe(f, 'printf yes > src/result.txt');
    expect(result.decision).toBe('allow');
    expect(result.reasonCodes).toEqual([]);
    expect(fs.existsSync(path.join(f.lane, 'src/result.txt'))).toBe(false);
  });
  test('holds prospective case variants of reserved control names even under broad scope', async () => {
    const f = authorityFixture();
    f.spec.scope.in = ['**'];
    f.spec.scope.out = [];
    fs.writeFileSync(f.specPath, JSON.stringify(f.spec));
    expect((await observe(f, 'printf no > .ENV')).reasonCodes).toEqual(['scope_refused']);
    expect(fs.existsSync(path.join(f.lane, '.ENV'))).toBe(false);
  });
  test('refuses symlink/hardlink targets, startup overrides, stale images, extra manifest and expired preparation', async () => {
    const f = authorityFixture();
    const foreign = path.join(f.root, 'foreign');
    fs.writeFileSync(foreign, 'keep');
    fs.symlinkSync(foreign, path.join(f.lane, 'src/link'));
    fs.linkSync(foreign, path.join(f.lane, 'src/hard'));
    for (const name of ['link', 'hard'])
      expect((await observe(f, `printf no > src/${name}`)).reasonCodes).toEqual(['scope_refused']);
    expect(fs.readFileSync(foreign, 'utf8')).toBe('keep');
    f.record.execution.environment.unshift({ name: 'BASH_ENV', value: '/untrusted' });
    expect((await observe(f, 'printf ok')).reasonCodes).toEqual(['unsupported_profile']);
    f.record.execution.environment.shift();
    source(f, 'printf ok');
    f.record.execution.executable.sha256 = '0'.repeat(64);
    expect((await evaluatePreparedExecution(f.record, request(f.record))).reasonCodes).toEqual([
      'unsupported_profile',
    ]);
    const fresh = authorityFixture();
    source(fresh, 'printf ok', ['/usr/bin/sed']);
    expect(
      (await evaluatePreparedExecution(fresh.record, request(fresh.record))).reasonCodes
    ).toEqual(['unsupported_profile']);
    fresh.record.limits.preparationDeadlineUnixMs = Date.now() - 1;
    expect(
      (await evaluatePreparedExecution(fresh.record, request(fresh.record))).reasonCodes
    ).toEqual(['deadline_expired']);
  });
  test('does not trust Bash startup or special-variable values as ordinary inherited scalars', async () => {
    const f = authorityFixture();
    const actual = execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', 'printf %s "$PWD"'], {
      cwd: f.lane,
      env: { PATH: '/usr/bin:/bin', PWD: path.join(f.lane, 'src') },
    }).toString();
    expect(actual).toBe(f.lane);
    f.record.execution.environment.push({ name: 'PWD', value: path.join(f.lane, 'src') });
    expect((await observe(f, 'printf data > "$PWD/escaped.txt"')).reasonCodes).toEqual([
      'unsupported_profile',
    ]);
    f.record.execution.environment.pop();
    expect((await observe(f, 'printf data > "$PWD/src/owned.txt"')).decision).toBe('allow');
    for (const command of [
      'UID=src; printf x > "$UID/escaped.txt"',
      'for SHLVL in src; do printf x; done',
      'read OLDPWD; printf x',
      'OPTIND=src; printf x > "$OPTIND/escaped.txt"',
      'for OPTERR in src; do printf x; done',
      'read HISTCMD; printf x',
      'EPOCHSECONDS=src; printf x',
      'read EPOCHREALTIME; printf x',
    ])
      expect((await observe(f, command)).reasonCodes).toEqual(['unsupported_profile']);
    expect(fs.existsSync(path.join(f.lane, 'escaped.txt'))).toBe(false);
  });
  test('anchors inherited special bindings to clean Bash startup rather than their supplied strings', () => {
    const actual = execFileSync(
      '/bin/bash',
      ['--noprofile', '--norc', '-c', 'printf "%s\\n" "$OPTIND" "$OPTERR" "$HISTCMD"'],
      { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', OPTIND: 'src', OPTERR: 'src', HISTCMD: 'src' } }
    ).toString();
    const values = actual.trimEnd().split('\n');
    expect(values).toHaveLength(3);
    expect(values[0]).toBe('1');
    expect(values[1]).toBe('1');
    expect(values[2]).toMatch(/^[0-9]+$/);
  });
  test.each(['OPTIND', 'OPTERR', 'HISTCMD', 'EPOCHSECONDS', 'EPOCHREALTIME'])(
    'does not use inherited %s as an ordinary path binding',
    async (name) => {
      const f = authorityFixture();
      fs.mkdirSync(path.join(f.lane, '1'));
      f.record.execution.environment.push({ name, value: 'src' });
      f.record.execution.environment.sort((a, b) =>
        Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))
      );
      const result = await observe(f, `printf x > "$${name}/escaped.txt"`);
      expect(result.decision).toBe('unresolved');
      expect(result.reasonCodes).toEqual(['source_unresolved']);
      expect(fs.existsSync(path.join(f.lane, 'src/escaped.txt'))).toBe(false);
      expect(fs.existsSync(path.join(f.lane, '1/escaped.txt'))).toBe(false);
    }
  );
  test('retains ordinary inherited application data for finite owned write targets', async () => {
    const f = authorityFixture();
    f.record.execution.environment.push({ name: 'OUTPUT_DIR', value: 'src' });
    f.record.execution.environment.sort((a, b) =>
      Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))
    );
    const result = await observe(f, 'printf x > "$OUTPUT_DIR/owned.txt"');
    expect(result.decision).toBe('allow');
    expect(result.reasonCodes).toEqual([]);
    expect(fs.existsSync(path.join(f.lane, 'src/owned.txt'))).toBe(false);
  });
  test.each(['EXECIGNORE', 'BASH_COMPAT', 'POSIX_PEDANTIC', 'HISTFILESIZE'])(
    'holds inherited %s because startup semantics are outside the execution profile',
    async (name) => {
      const f = authorityFixture();
      f.record.execution.environment.push({ name, value: '*' });
      f.record.execution.environment.sort((a, b) =>
        Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))
      );
      const result = await observe(f, 'printf ok');
      expect(result.decision).toBe('unresolved');
      expect(result.reasonCodes).toEqual(['unsupported_profile']);
    }
  );
  test('holds special assignments which can truncate a history file without an explicit write operand', async () => {
    const f = authorityFixture();
    const target = path.join(f.root, 'history');
    // Fixed semantic oracle in a disposable fixture, never authorization of
    // submitted source: HISTFILESIZE has a filesystem effect even under -c,
    // including inside a command substitution's child shell.
    for (const oracle of [
      'HISTFILE=$1; HISTFILESIZE=0; true',
      'HISTFILE=$1; value=$(HISTFILESIZE=0; printf x); true',
    ]) {
      fs.writeFileSync(target, 'must be preserved\n');
      execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', oracle, 'history-oracle', target], {
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      });
      expect(fs.readFileSync(target, 'utf8')).toBe('');
    }
    fs.writeFileSync(target, 'must be preserved\n');
    for (const command of [
      `HISTFILE=${JSON.stringify(target)}; HISTFILESIZE=0; true`,
      `HISTFILE=${JSON.stringify(target)}; for HISTFILESIZE in 0; do true; done`,
      `HISTFILE=${JSON.stringify(target)}; read HISTFILESIZE; true`,
      'EXECIGNORE=*; true',
      'for POSIX_PEDANTIC in 1; do true; done',
      'read EXECIGNORE; true',
    ]) {
      const result = await observe(f, command);
      expect({ command, decision: result.decision }).toEqual({ command, decision: 'unresolved' });
      expect(result.reasonCodes).toEqual(['unsupported_profile']);
      expect(fs.readFileSync(target, 'utf8')).toBe('must be preserved\n');
    }
  });
  test.each([
    ['assignment', 'HISTFILE={{HISTORY}}; value=$(HISTFILESIZE=0; printf x); true'],
    ['prefix', 'HISTFILE={{HISTORY}}; value=$(HISTFILESIZE=0 printf x); true'],
    ['quoted', 'HISTFILE={{HISTORY}}; value="$(HISTFILESIZE=0; printf x)"; true'],
    ['nested', 'HISTFILE={{HISTORY}}; value=$(inner=$(HISTFILESIZE=0; printf x); printf x); true'],
    ['loop', 'HISTFILE={{HISTORY}}; value=$(for HISTFILESIZE in 0; do printf x; done); true'],
    ['heredoc', "value=$(printf x <<'EOF'\ndata\nEOF\n); true"],
    ['here-string', 'value=$(printf x <<< data); true'],
  ])('holds implicit effects in lazy word children: %s', async (_name, pattern) => {
    const f = authorityFixture();
    const history = path.join(f.root, 'lazy-history');
    fs.writeFileSync(history, 'must be preserved\n');
    const command = pattern.replace('{{HISTORY}}', JSON.stringify(history));
    const result = await observe(f, command);
    expect({ command, decision: result.decision }).toEqual({ command, decision: 'unresolved' });
    expect(result.reasonCodes).toEqual(['unsupported_profile']);
    expect(fs.readFileSync(history, 'utf8')).toBe('must be preserved\n');
  });
  test('allows inert reader substitutions in lazy word children without executing them', async () => {
    const f = authorityFixture();
    for (const command of ['value=$(printf x); true', 'value="$(printf x)"; true']) {
      const result = await observe(f, command);
      expect(result.decision).toBe('allow');
      expect(result.reasonCodes).toEqual([]);
    }
  });
  test.each([
    ['decoded backticks', 'value=`printf \\`printf x\\``; true'],
    ['semantic node budget', 'true ' + "'x' ".repeat(9000)],
    ['semantic depth budget', '( '.repeat(80) + 'true' + ' )'.repeat(80)],
    ['nested parse error', 'value=$(if); true'],
  ])('holds unresolved lazy syntax and resource limits: %s', async (_name, command) => {
    const f = authorityFixture();
    const result = await observe(f, command);
    expect(result.decision).toBe('unresolved');
    expect(result.reasonCodes).toEqual(['source_unresolved']);
    expect(fs.readdirSync(path.join(f.lane, 'src'))).toEqual([]);
  });
  test('holds PATH changes before a profiled utility, preserving the original PATH control', async () => {
    const f = authorityFixture();
    const directory = path.join(f.lane, 'replacement-bin');
    fs.mkdirSync(directory);
    fs.symlinkSync('/usr/bin/touch', path.join(directory, 'cat'));
    const replacement = JSON.stringify(directory);
    const target = 'src/must-not-execute.txt';
    expect((await observe(f, `cat ${target}`, ['/bin/cat'])).decision).toBe('allow');
    for (const command of [
      `PATH=${replacement}; cat ${target}`,
      `PATH=${replacement} cat ${target}`,
      `for PATH in ${replacement}; do cat ${target}; done`,
      `read -r PATH; cat ${target}`,
      `unset PATH; cat ${target}`,
      `export PATH=${replacement}; cat ${target}`,
      `printf -v PATH %s ${replacement}; cat ${target}`,
    ]) {
      const result = await observe(f, command, ['/bin/cat']);
      expect({ command, decision: result.decision }).toEqual({ command, decision: 'unresolved' });
      expect(result.reasonCodes.length).toBe(1);
    }
    expect(fs.existsSync(path.join(f.lane, target))).toBe(false);
  });
  test('private child checks final fence, changed authority and complete framing; never launches USER', async () => {
    const f = authorityFixture();
    source(f, 'printf ok > src/must-not-execute.txt');
    const initial = await evaluatePreparedExecution(f.record, request(f.record));
    expect(initial.decision).toBe('allow');
    const lockPath = path.join(f.caws, 'state.lock');
    const fd = fs.openSync(lockPath, 'wx+', 0o600);
    const metadata = {
      pid: process.pid,
      at: new Date().toISOString(),
      purpose: 'execution-launch',
      nonce: 'owned-nonce',
      protocol: 'caws.execution.fence.v1',
    };
    fs.writeFileSync(fd, JSON.stringify(metadata));
    fs.fsyncSync(fd);
    const stat = fs.fstatSync(fd, { bigint: true });
    const fence = { dev: stat.dev.toString(), ino: stat.ino.toString(), nonce: metadata.nonce };
    const run = (input, suffix = Buffer.alloc(0)) => {
      const body = Buffer.from(JSON.stringify(input));
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      return spawnCoveredSync(
        process.execPath,
        [path.resolve(__dirname, '../../dist/execution/authorizer-main.js')],
        {
          input: Buffer.concat([header, body, suffix]),
          stdio: ['pipe', 'pipe', 'pipe', fd],
          env: {
            PATH: f.record.execution.environment.find((entry) => entry.name === 'PATH').value,
            LC_ALL: 'C',
            __STRYKER_ACTIVE_MUTANT__: String(
              globalThis.__stryker__?.activeMutant ?? process.env.__STRYKER_ACTIVE_MUTANT__ ?? ''
            ),
          },
          timeout: 5000,
          maxBuffer: 1048576,
        }
      );
    };
    const observation = (child) => {
      expect(child.status).toBe(0);
      expect(child.stderr.toString()).toBe('');
      expect(child.stdout.readUInt32BE()).toBe(child.stdout.length - 4);
      return JSON.parse(child.stdout.subarray(4).toString());
    };
    try {
      const final = request(f.record, initial.authorityRevision, fence);
      expect(observation(run(final)).decision).toBe('allow');
      fs.appendFileSync(path.join(f.caws, 'policy.yaml'), '\n# revocation checkpoint\n');
      expect(observation(run(final)).reasonCodes).toEqual(['authority_changed']);
      expect(
        observation(run({ ...final, fence: { ...fence, nonce: 'wrong' } })).reasonCodes
      ).toEqual(['fence_unverified']);
      const trailing = run(final, Buffer.from('x'));
      expect(trailing.status).toBe(2);
      expect(trailing.stdout.length).toBe(0);
      expect(trailing.stderr.toString()).toBe(
        'Execution authorizer input or infrastructure failure\n'
      );
      expect(fs.existsSync(path.join(f.lane, 'src/must-not-execute.txt'))).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(fs.fstatSync(fd, { bigint: true }).ino).toBe(stat.ino);
    } finally {
      fs.closeSync(fd);
    }
  });
});
