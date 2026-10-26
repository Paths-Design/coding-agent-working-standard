const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const children = require('node:child_process');
const fixtures = require('../helpers/git-repo-factory');
const { initProject } = require('../../dist/store/init-store');
const { loadSpecs } = require('../../dist/store/specs-store');
const {
  decodePreparationGitBatch,
  preparationCommitTree,
  decodePreparationGitTree,
  planPreparationGitExport,
  inspectPreparationWriteAuthority,
  preparationSourceDisposition,
  collectPreparationProductionSource,
  inspectPreparationSourceStanding,
  prepareFrozenProductionSource,
  composePreparedNativeBuildRequest,
} = require('../../dist/tooling/native-qualification-prepare');
const {
  executeFrozenSourcePreparation,
  executePreparationParentChannel,
  preparationDescriptorChannel,
} = require('../../dist/tooling/native-qualification-prepare-entry');

describe('native preparation bounded request handler', () => {
  test.each([
    [Buffer.alloc(0), 'Expected bounded UTF-8 JSON request bytes'],
    [Buffer.alloc(65537, 32), 'Expected bounded UTF-8 JSON request bytes'],
    [Buffer.from([0xff]), 'Preparation request must be valid UTF-8'],
    [Buffer.from('{'), 'Preparation request is not valid JSON'],
    [Buffer.from('{}\0'), 'Preparation request is not valid JSON'],
  ])('refuses invalid request bytes without invoking parent effects', (bytes, reason) => {
    const checkpoint = jest.fn();
    const git = jest.fn();
    const readObjects = jest.fn();
    expect(executeFrozenSourcePreparation(bytes, { checkpoint, git, readObjects })).toEqual({
      status: 'failed',
      adoption: 'NOT_ADOPTED',
      writerState: 'NOT_STARTED',
      phase: 'input',
      reason,
    });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(git).not.toHaveBeenCalled();
    expect(readObjects).not.toHaveBeenCalled();
  });

  test('has no implicit production parent or request-provided capability', () => {
    expect(executeFrozenSourcePreparation(Buffer.from('{"approved":true}'), undefined)).toEqual({
      status: 'failed',
      adoption: 'NOT_ADOPTED',
      writerState: 'NOT_STARTED',
      phase: 'parent',
      reason: 'An independently admitted maintained parent is required',
    });
  });
});

describe('native preparation private channel framing', () => {
  const start = (changes = {}) => ({
    kind: 'start',
    request: Buffer.from('{}').toString('base64'),
    cwd: '/fixture',
    parentPid: process.ppid,
    environment: {},
    remainingMs: 30_000,
    ...changes,
  });
  test.each([
    [{ kind: 'approved' }, 'Expected preparation channel start'],
    [{ approved: true }, 'Unexpected preparation channel fields'],
    [{ request: '***' }, 'byte encoding'],
    [{ request: Buffer.alloc(65537).toString('base64') }, 'byte bound'],
    [{ cwd: '../fixture' }, 'channel directory'],
    [{ parentPid: -1 }, 'process correspondence'],
    [{ environment: { CODEX_THREAD_ID: 42 } }, 'environment member'],
    [{ remainingMs: 0 }, 'remaining interval'],
  ])('rejects malformed private context before any outgoing request', (changes, diagnostic) => {
    const channel = { read: () => start(changes), write: jest.fn() };
    expect(() => executePreparationParentChannel(channel)).toThrow(diagnostic);
    expect(channel.write).not.toHaveBeenCalled();
  });

  function descriptor(input, partialWrite = Infinity) {
    let at = 0;
    const output = [];
    jest.spyOn(fs, 'fstatSync').mockImplementation((fd) => ({
      dev: 1n,
      ino: BigInt(fd),
      uid: BigInt(process.geteuid()),
      isSocket: () => fd === 64,
    }));
    jest.spyOn(fs, 'readSync').mockImplementation((fd, bytes, offset, length) => {
      expect(fd).toBe(64);
      const copied = input.copy(bytes, offset, at, at + Math.min(2, length));
      at += copied;
      return copied;
    });
    jest.spyOn(fs, 'writeSync').mockImplementation((fd, bytes, offset, length) => {
      expect(fd).toBe(64);
      const size = Math.min(partialWrite, length);
      output.push(Buffer.from(bytes.subarray(offset, offset + size)));
      return size;
    });
    return { channel: preparationDescriptorChannel(64), output };
  }
  const framed = (bytes) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  afterEach(() => jest.restoreAllMocks());

  test('preserves exact frames across partial reads and writes', () => {
    const value = { kind: 'ok', seq: 9, remainingMs: 1000 };
    const bytes = Buffer.from(JSON.stringify(value));
    const { channel, output } = descriptor(framed(bytes), 2);
    expect(channel.read()).toEqual(value);
    channel.write(value);
    expect(Buffer.concat(output)).toEqual(framed(bytes));
  });

  test.each([
    [Buffer.alloc(4), 'frame bound'],
    [Buffer.from([1, 0, 0, 1]), 'frame bound'],
    [Buffer.from([0, 0]), 'channel closed'],
    [framed(Buffer.from([0xff])), 'not UTF-8'],
    [framed(Buffer.from('{')), 'JSON'],
  ])('fails closed on malformed or incomplete frame bytes', (bytes, diagnostic) => {
    const { channel, output } = descriptor(bytes);
    expect(() => channel.read()).toThrow(diagnostic);
    expect(output).toEqual([]);
  });

  test('refuses descriptor substitution before consuming body bytes', () => {
    const { channel } = descriptor(framed(Buffer.from('{}')));
    fs.fstatSync.mockImplementation((fd) => ({
      dev: 1n,
      ino: BigInt(fd) + 1n,
      uid: BigInt(process.geteuid()),
      isSocket: () => true,
    }));
    expect(() => channel.read()).toThrow('socket identity changed');
    expect(fs.readSync).not.toHaveBeenCalled();
  });

  test('rejects a regular descriptor or standard-stream alias', () => {
    jest.spyOn(fs, 'fstatSync').mockReturnValue({
      dev: 1n,
      ino: 64n,
      uid: BigInt(process.geteuid()),
      isSocket: () => false,
    });
    expect(() => preparationDescriptorChannel(64)).toThrow('parent socket');
    fs.fstatSync.mockReturnValue({
      dev: 1n,
      ino: 64n,
      uid: BigInt(process.geteuid()),
      isSocket: () => true,
    });
    expect(() => preparationDescriptorChannel(64)).toThrow('aliases standard I/O');
  });

  test('retains full inode bits when checking an inherited descriptor', () => {
    descriptor(framed(Buffer.from('{}')));
    const inode = (1n << 63n) + 1n;
    fs.fstatSync.mockImplementation((fd, options) => {
      expect(options).toEqual({ bigint: true });
      return {
        dev: 1n,
        ino: fd === 64 ? inode : BigInt(fd),
        uid: BigInt(process.geteuid()),
        isSocket: () => fd === 64,
      };
    });
    const channel = preparationDescriptorChannel(64);
    fs.fstatSync.mockReturnValue({
      dev: 1n,
      ino: inode + 1n,
      uid: BigInt(process.geteuid()),
      isSocket: () => true,
    });
    expect(() => channel.read()).toThrow('socket identity changed');
    expect(fs.readSync).not.toHaveBeenCalled();
  });
});

describe('native preparation data-only build request composition', () => {
  const imageNames = [
    'caws.sh',
    'codex-parser-runtime.sh',
    'dispatch.sh',
    'execute-handler.sh',
    'git.sh',
    'handler-env.sh',
    'handler-routes.sh',
    'libraries.sh',
    'parse-input.sh',
    'plan-transcript-finalize.sh',
    'tool.sh',
  ];
  const clientPath =
    'packages/caws-cli/templates/hook-packs/shared/lib/session-render-service-client.sh';
  const imagePrefix = 'packages/caws-cli/templates/hook-packs/runtime/service-image';
  const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  const row = (relativePath, text) => ({
    relativePath,
    sizeBytes: Buffer.byteLength(text),
    sha256: sha(Buffer.from(text)),
    executable: false,
  });
  const pin = (file, text) => ({
    path: file,
    sizeBytes: Buffer.byteLength(text),
    sha256: sha(Buffer.from(text)),
  });
  const capture = (file, value) => {
    const bytes = Buffer.from(JSON.stringify(value));
    return { identity: { path: file, sizeBytes: bytes.length, sha256: sha(bytes) }, bytes };
  };
  function fixture() {
    // Schema-valid inert metadata only. No SQLite/tool/source files exist at
    // these paths; no child or file operation can qualify a candidate here.
    const source = {
      sourceRoot: '/fixture/project/lane',
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      objectFormat: 'sha1',
      repoRoot: '/fixture/project',
      worktreeName: 'lane',
      specId: 'FIXTURE-1',
    };
    const cargo = [row('Cargo.toml', 'manifest'), row('Cargo.lock', 'locked dependencies')];
    const currentNative = [...cargo, row('src/installed_entry_main.rs', 'current entry metadata')];
    const currentImage = imageNames.map((name) => row(name, `current image ${name}`));
    const currentClient = row(clientPath, 'current client metadata');
    const inventory = {
      schema: 'caws.frozen_source_inventory.v1',
      adoption: 'NOT_ADOPTED',
      source,
      files: [
        row('LICENSE', 'fixture notice'),
        ...currentNative.map((file) => ({
          ...file,
          relativePath: `packages/caws-native/${file.relativePath}`,
        })),
        ...currentImage.map((file) => ({
          ...file,
          relativePath: `${imagePrefix}/${file.relativePath}`,
        })),
        currentClient,
      ].map((file) => ({ ...file, gitObject: 'c'.repeat(40), gitMode: '100644' })),
      omitted: [],
      futureBuildRoot: '/fixture/project/lane/tmp/native-build',
      limits: ['Metadata only'],
    };
    const binding = row('bindgen-bindings/bindgen_3.34.1.rs', 'binding metadata');
    const base = {
      schema: 'caws.native_sqlite_build_request.v2',
      source: {
        root: '/fixture/base/native',
        files: [...cargo, row('src/installed_entry_main.rs', 'prior entry metadata')],
      },
      embedded: {
        serviceClient: pin('/fixture/base/client.sh', 'prior client'),
        serviceImage: {
          root: '/fixture/base/image',
          files: imageNames.map((name) => row(name, `prior image ${name}`)),
        },
      },
      vendors: [
        {
          directory: 'libsqlite3-sys-0.38.2',
          tree: {
            root: '/fixture/vendor/sqlite',
            files: [row('Cargo.toml', 'vendor manifest'), binding],
          },
        },
      ],
      prefix: {
        archive: pin('/fixture/prefix/sqlite.a', 'archive metadata'),
        object: pin('/fixture/prefix/sqlite.o', 'object metadata'),
        header: {
          ...pin('/fixture/prefix/sqlite.h', 'header metadata'),
          sha256: '919e7f2e8ed1d8f56ac17b412b8971c76aa5d1a879752cc6058f75e7d5910e1d',
        },
      },
      binding: {
        directory: 'libsqlite3-sys-0.38.2',
        relativePath: binding.relativePath,
        sha256: binding.sha256,
      },
      tools: Object.fromEntries(
        ['cargo', 'rustc', 'clang', 'ar', 'nm', 'otool'].map((name) => [
          name,
          pin(`/fixture/tools/${name}`, `tool metadata ${name}`),
        ])
      ),
      sdk: { root: '/fixture/sdk', settings: pin('/fixture/sdk/SDKSettings.json', 'SDK metadata') },
      outputRoot: '/fixture/base-build',
      profile: 'release',
      timeoutMs: 600000,
      maxOutputBytes: 4096,
    };
    return { source, inventory, base, currentNative, currentImage, currentClient };
  }
  const inputs = (f) => [
    capture('/fixture/project/lane/tmp/prepared/source-inventory.json', f.inventory),
    capture('/fixture/base-request.json', f.base),
    f.source,
  ];
  afterEach(() => jest.restoreAllMocks());

  test('replaces exact source descriptors, preserves reviewed dependencies and binds both input records', () => {
    const f = fixture();
    const captured = inputs(f);
    const before = JSON.stringify(f);
    const open = jest.spyOn(fs, 'openSync');
    const child = jest.spyOn(children, 'execFileSync');
    const composed = composePreparedNativeBuildRequest(...captured);
    const newRoot = '/fixture/project/lane/tmp/prepared/source';
    expect(composed.request).toEqual({
      ...f.base,
      source: { root: `${newRoot}/packages/caws-native`, files: f.currentNative },
      embedded: {
        serviceClient: {
          path: `${newRoot}/${clientPath}`,
          sizeBytes: f.currentClient.sizeBytes,
          sha256: f.currentClient.sha256,
        },
        serviceImage: { root: `${newRoot}/${imagePrefix}`, files: f.currentImage },
      },
      outputRoot: f.inventory.futureBuildRoot,
    });
    expect(composed.provenance).toEqual({
      sourceInventory: captured[0].identity,
      baseRecipe: captured[1].identity,
      source: f.source,
    });
    expect(JSON.stringify(f)).toBe(before);
    composed.request.tools.cargo.sha256 = 'd'.repeat(64);
    composed.request.source.files[0].sha256 = 'e'.repeat(64);
    expect(JSON.stringify(f)).toBe(before);
    expect(open).not.toHaveBeenCalled();
    expect(child).not.toHaveBeenCalled();
  });

  test.each(['Cargo.toml', 'Cargo.lock'])('refuses a changed dependency input %s', (name) => {
    const f = fixture();
    f.inventory.files.find((file) => file.relativePath === `packages/caws-native/${name}`).sha256 =
      'f'.repeat(64);
    expect(() => composePreparedNativeBuildRequest(...inputs(f))).toThrow(
      `Cargo input changed; review a new dependency recipe: ${name}`
    );
  });

  test.each([
    ['packages/caws-native/src/installed_entry_main.rs', 'Stable hook entry source missing'],
    [`${imagePrefix}/tool.sh`, 'Embedded service-image inventory mismatch'],
    [clientPath, 'Prepared service client is missing'],
  ])('refuses missing required descriptor %s', (name, reason) => {
    const f = fixture();
    f.inventory.files = f.inventory.files.filter((file) => file.relativePath !== name);
    expect(() => composePreparedNativeBuildRequest(...inputs(f))).toThrow(reason);
  });

  test.each([0, 1])('refuses mutated captured bytes for input %i', (index) => {
    const captured = inputs(fixture());
    captured[index].bytes[1] ^= 1;
    expect(() => composePreparedNativeBuildRequest(...captured)).toThrow(
      'Captured preparation input identity mismatch'
    );
  });

  test('refuses a changed current source observation before retaining the recipe', () => {
    const f = fixture();
    const captured = inputs(f);
    captured[2] = { ...f.source, commit: 'd'.repeat(40) };
    expect(() => composePreparedNativeBuildRequest(...captured)).toThrow(
      'Source standing changed before request composition'
    );
  });

  test('refuses an external descriptor aliasing the proposed build output', () => {
    const f = fixture();
    f.base.tools.cargo.path = `${f.inventory.futureBuildRoot}/cargo`;
    expect(() => composePreparedNativeBuildRequest(...inputs(f))).toThrow(
      'Output/input file collision'
    );
  });

  test.each(['v1', 'debug'])('refuses unsupported recipe %s', (kind) => {
    const f = fixture();
    if (kind === 'v1') f.base.schema = 'caws.native_sqlite_build_request.v1';
    else f.base.profile = 'debug';
    expect(() => composePreparedNativeBuildRequest(...inputs(f))).toThrow(
      'reviewed v2 release recipe'
    );
  });
});

describe('native preparation closed production input profile', () => {
  test.each([
    'package-lock.json',
    'packages/caws-cli/src/store/specs-store.ts',
    'packages/caws-cli/src/kernel/schemas/spec.v1.json',
    'packages/caws-cli/scripts/build-cli.js',
    'packages/caws-cli/templates/hook-packs/claude-code/settings.json',
    'packages/caws-cli/templates/hook-packs/shared/AGENTS.md',
    'packages/caws-native/src/installed_entry.rs',
    'packages/caws-native/examples/process-comm-vis-oracle.c',
    'packages/caws-native/examples/service-observer.rs',
    'packages/caws-native/examples/service-custody-observer.rs',
    'docs/guides/worktree-isolation.md',
    'docs/new-consumer-guide.md',
    'docs/architecture/maintainer-input.md',
    'docs/credentials-guide.md',
  ])('selects traced production input %s', (file) => {
    expect(preparationSourceDisposition(file)).toBe('include');
  });

  test.each([
    '.caws/policy.yaml',
    '.codex/hooks.json',
    '.claude/settings.json',
    'packages/caws-cli/src/runtime/.env.example',
    'packages/caws-cli/src/runtime/.caws/state.json',
    'packages/caws-cli/src/runtime/.codex/hooks.json',
    'docs/.env/local.md',
    'docs/.aws/credentials.md',
    'packages/caws-cli/templates/hook-packs/shared/.env.fixture',
    'packages/caws-cli/templates/hook-packs/shared/credentials.json',
    'packages/caws-cli/templates/hook-packs/shared/credentials/token.json',
    'docs/credentials/token.md',
    'packages/caws-cli/templates/hook-packs/shared/private.key',
    'packages/caws-cli/templates/hook-packs/claude-code/tmp/session.json',
    'packages/caws-cli/templates/hook-packs/shared/state/pointer.json',
    'packages/caws-cli/node_modules/example/index.js',
    'packages/caws-native/target/release/caws',
    '.npmrc',
    '.cargo/config.toml',
  ])('refuses protected source name before any blob selection: %s', (file) => {
    expect(preparationSourceDisposition(file)).toBe('protected');
  });

  test.each([
    'README.md',
    'docs/diagram.svg',
    'packages/caws-cli/tests/unit.test.js',
    'packages/caws-native/src/tests.rs',
    'packages/caws-native/src/worker/tests/example.rs',
    'packages/caws-native/examples/unrelated.c',
    'packages/caws-native/src/service_protocol/fixtures.json',
    'packages/another-workspace/src/main.ts',
  ])('does not broaden the fixed profile to %s', (file) => {
    expect(preparationSourceDisposition(file)).toBe('unselected');
  });

  test.each([
    '../package.json',
    '/package.json',
    'packages/caws-cli/src/../state.ts',
    'a\\b',
    'a//b',
  ])('refuses malformed profile path %s', (file) => {
    expect(() => preparationSourceDisposition(file)).toThrow('Unsafe source profile path');
  });
});

describe('native preparation actual worktree source and output observations', () => {
  let root;
  let lane;
  let spec;
  let registry;
  let selection;
  let caller;
  let calls;
  const owner = 'preparation-fixture-owner';
  function saveSpec() {
    fs.writeFileSync(path.join(root, '.caws/specs/PREP-001.yaml'), yaml.dump(spec));
  }
  function saveRegistry() {
    fs.writeFileSync(path.join(root, '.caws/worktrees.json'), JSON.stringify(registry));
  }
  function canonicalBytes() {
    return Object.fromEntries(
      ['policy.yaml', 'worktrees.json', 'specs/PREP-001.yaml'].map((file) => [
        file,
        fs.readFileSync(path.join(root, '.caws', file)),
      ])
    );
  }
  beforeEach(() => {
    root = fs.realpathSync(fixtures.makeTempRepo());
    const initialized = initProject(root);
    if (!initialized.ok) throw new Error(JSON.stringify(initialized.errors));
    lane = path.join(root, '.caws/worktrees/prep');
    fixtures.git(root, ['worktree', 'add', '--detach', lane, 'HEAD']);
    fs.writeFileSync(path.join(lane, '.gitignore'), 'tmp/prepare/\n');
    registry = {
      prep: { path: lane, specId: 'PREP-001', owner: { session_id: owner, platform: 'codex' } },
    };
    spec = {
      id: 'PREP-001',
      title: 'Preparation authority fixture',
      mode: 'feature',
      lifecycle_state: 'active',
      worktree: 'prep',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      blast_radius: { modules: ['fixture'], data_migration: false },
      operational_rollback_slo: '5m',
      scope: { in: ['tmp/prepare/'], out: ['tmp/prepare/run/private'] },
      invariants: ['Only owned fixture output is admitted.'],
      non_functional: { security: ['Reject foreign ownership and unscoped output.'] },
      acceptance: [
        { id: 'A1', given: 'owned fixture', when: 'read authority', then: 'actual scope decides' },
      ],
      contracts: [],
    };
    saveSpec();
    expect(loadSpecs(path.join(root, '.caws')).diagnostics).toEqual([]);
    saveRegistry();
    selection = {
      outputRoot: path.join(lane, 'tmp/prepare/run'),
      writePaths: [path.join(lane, 'tmp/prepare/run/source/file.ts')],
    };
    calls = [];
    caller = {
      cwd: lane,
      environment: { CAWS_AGENT_SURFACE: 'codex', CODEX_THREAD_ID: owner },
      git: (args, options) => {
        calls.push({ args: [...args], cwd: options.cwd });
        return fixtures.git(options.cwd, args);
      },
    };
  });
  afterEach(() => fixtures.cleanupAll());

  function sourceSelection(sourceRoot = lane) {
    return {
      sourceRoot,
      commit: fixtures.git(sourceRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
      tree: fixtures.git(sourceRoot, ['rev-parse', '--verify', 'HEAD^{tree}']),
      objectFormat: 'sha1',
    };
  }

  function frozenSourceFixture() {
    // Byte-custody fixtures only: these bodies are never loaded or executed.
    fs.mkdirSync(path.join(lane, 'scripts'));
    fs.writeFileSync(path.join(lane, 'package.json'), '{"fixture":true}\n');
    fs.writeFileSync(
      path.join(lane, 'scripts/install-cli-snapshot.mjs'),
      'fixture executable bytes\n',
      { mode: 0o700 }
    );
    fixtures.git(lane, ['add', '--', 'package.json', 'scripts/install-cli-snapshot.mjs']);
    fixtures.git(lane, ['commit', '-m', 'record fixture production bytes']);
    fs.mkdirSync(path.dirname(selection.outputRoot), { recursive: true });
    const request = {
      schema: 'caws.frozen_source_preparation.v1',
      source: sourceSelection(),
      outputRoot: selection.outputRoot,
      futureBuildRoot: path.join(lane, 'tmp/prepare/build'),
    };
    const objectReads = [];
    const context = {
      ...caller,
      checkpoint: () => {},
      readObjects: (selections) => {
        objectReads.push(...selections.map((item) => ({ ...item })));
        // Real raw Git objects exercise composition; this fixture transport is
        // not the maintained pinned/closed production parent or bootstrap.
        return children.execFileSync(
          '/usr/bin/git',
          ['--no-replace-objects', 'cat-file', '--batch'],
          {
            cwd: lane,
            input: selections.map(({ oid }) => oid).join('\n') + '\n',
            timeout: 5000,
            maxBuffer: 32 * 1024 * 1024,
          }
        );
      },
    };
    return { request, context, objectReads };
  }

  function privateChannelFixture(changeReply = (reply) => reply, callerChanges = {}) {
    const fixture = frozenSourceFixture();
    const queue = [
      {
        kind: 'start',
        request: Buffer.from(JSON.stringify(fixture.request)).toString('base64'),
        cwd: fixture.context.cwd,
        parentPid: process.ppid,
        environment: { ...fixture.context.environment, ...callerChanges },
        remainingMs: 30_000,
      },
    ];
    const frames = [];
    const metadata = {
      commonDir: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      topLevel: ['rev-parse', '--show-toplevel'],
      objectFormat: ['rev-parse', '--show-object-format'],
      headCommit: ['rev-parse', '--verify', 'HEAD^{commit}'],
      headTree: ['rev-parse', '--verify', 'HEAD^{tree}'],
    };
    const channel = {
      read: () => {
        if (!queue.length) throw new Error('fixture parent channel closed');
        return changeReply(queue.shift(), frames);
      },
      write: (frame) => {
        frames.push(frame);
        if (frame.kind === 'checkpoint')
          queue.push({ kind: 'ok', seq: frame.seq, remainingMs: 30_000 });
        else if (frame.kind === 'metadata') {
          const args =
            frame.operation === 'ignored'
              ? ['check-ignore', '--quiet', '--no-index', '--', frame.path]
              : metadata[frame.operation];
          expect(args).toBeDefined();
          try {
            const text = fixture.context.git(args, { cwd: frame.cwd });
            queue.push({
              kind: 'gitResult',
              seq: frame.seq,
              exitCode: 0,
              stdout: Buffer.from(text + '\n').toString('base64'),
              stderr: '',
            });
          } catch (error) {
            queue.push({
              kind: 'gitResult',
              seq: frame.seq,
              exitCode: error.status || 1,
              stdout: '',
              stderr: '',
            });
          }
        } else if (frame.kind === 'objects') {
          const bytes = fixture.context.readObjects(frame.selections);
          // Several chunks force actual reconstruction, including partial frames.
          for (let at = 0; at < bytes.length; at += 7)
            queue.push({
              kind: 'objectChunk',
              seq: frame.seq,
              data: bytes.subarray(at, at + 7).toString('base64'),
            });
          queue.push({ kind: 'objectEnd', seq: frame.seq, exitCode: 0, stderr: '' });
        } else expect(frame.kind).toBe('result');
      },
    };
    return { ...fixture, channel, frames };
  }

  test('private channel carries fixed metadata and chunked objects into live fixture authority', () => {
    const fixture = privateChannelFixture();
    const before = canonicalBytes();
    const result = executePreparationParentChannel(fixture.channel);
    expect(result.status).toBe('prepared');
    expect(fs.readFileSync(path.join(result.sourceTree.root, 'package.json'), 'utf8')).toBe(
      '{"fixture":true}\n'
    );
    expect(fixture.frames.at(-1)).toEqual({ kind: 'result', seq: fixture.frames.length, result });
    expect(
      fixture.frames.filter((frame) => frame.kind === 'metadata').map((frame) => frame.operation)
    ).toEqual(
      expect.arrayContaining([
        'commonDir',
        'topLevel',
        'objectFormat',
        'headCommit',
        'headTree',
        'ignored',
      ])
    );
    expect(fixture.objectReads.filter((item) => item.kind === 'blob')).toHaveLength(2);
    expect(canonicalBytes()).toEqual(before);
    expect(fs.existsSync(fixture.request.futureBuildRoot)).toBe(false);
  });

  test('private channel cannot borrow another caller ownership', () => {
    const fixture = privateChannelFixture(undefined, { CODEX_THREAD_ID: 'foreign-caller' });
    const result = executePreparationParentChannel(fixture.channel);
    expect(result).toMatchObject({
      status: 'failed',
      writerState: 'NOT_STARTED',
      phase: 'authority',
    });
    expect(result.reason).toContain('another caller');
    expect(fixture.objectReads).toEqual([]);
    expect(fs.existsSync(fixture.request.outputRoot)).toBe(false);
  });

  test.each(['checkpoint', 'metadata', 'objects'])(
    'refuses uncorrelated %s replies before writes',
    (kind) => {
      const fixture = privateChannelFixture((reply) => {
        if (
          (kind === 'checkpoint' && reply.kind === 'ok') ||
          (kind === 'metadata' && reply.kind === 'gitResult') ||
          (kind === 'objects' && reply.kind === 'objectChunk')
        )
          return { ...reply, seq: reply.seq + 1 };
        return reply;
      });
      const result = executePreparationParentChannel(fixture.channel);
      expect(result.status).toBe('failed');
      expect(result.writerState).toBe('NOT_STARTED');
      expect(result.reason).toContain(
        kind === 'metadata' ? 'Cannot resolve canonical preparation project' : 'correlation'
      );
      expect(result.phase).toBe(
        kind === 'metadata' ? 'authority' : kind === 'objects' ? 'objects' : 'request'
      );
      if (kind === 'metadata') {
        expect(fixture.frames.filter((frame) => frame.kind === 'metadata')).toHaveLength(1);
        expect(fixture.objectReads).toEqual([]);
      }
      expect(fs.existsSync(fixture.request.outputRoot)).toBe(false);
    }
  );

  test('parent control loss after exclusive root creation prevents source writes and completion', () => {
    const fixture = privateChannelFixture((reply) => {
      if (reply.kind === 'ok' && fs.existsSync(fixture.request.outputRoot))
        throw new Error('fixture parent channel closed');
      return reply;
    });
    const result = executePreparationParentChannel(fixture.channel);
    expect(result).toMatchObject({
      status: 'failed',
      writerState: 'RETAINED_UNCERTAIN',
      phase: 'source',
    });
    expect(result.reason).toContain('parent channel closed');
    expect(fs.readdirSync(fixture.request.outputRoot)).toEqual([]);
    expect(fs.existsSync(fixture.request.futureBuildRoot)).toBe(false);
    expect(fixture.frames.at(-1).result.status).toBe('failed');
  });

  test.each(['negative-exit', 'surplus-exit', 'combined-bytes', 'empty-chunk', 'oversize-chunk'])(
    'rejects malformed bounded parent reply %s without writing source',
    (fault) => {
      let altered = false;
      const fixture = privateChannelFixture((reply) => {
        if (
          reply.kind === 'gitResult' &&
          ['negative-exit', 'surplus-exit', 'combined-bytes'].includes(fault)
        ) {
          altered = true;
          if (fault === 'combined-bytes')
            return {
              ...reply,
              stdout: Buffer.alloc(1024 * 1024).toString('base64'),
              stderr: 'eA==',
            };
          return { ...reply, exitCode: fault === 'negative-exit' ? -1 : 256 };
        }
        if (reply.kind === 'objectChunk' && ['empty-chunk', 'oversize-chunk'].includes(fault)) {
          altered = true;
          return {
            ...reply,
            data: fault === 'empty-chunk' ? '' : Buffer.alloc(256 * 1024 + 1).toString('base64'),
          };
        }
        return reply;
      });
      const result = executePreparationParentChannel(fixture.channel);
      expect(altered).toBe(true);
      expect(result).toMatchObject({ status: 'failed', writerState: 'NOT_STARTED' });
      expect(fs.existsSync(fixture.request.outputRoot)).toBe(false);
      expect(fs.existsSync(fixture.request.futureBuildRoot)).toBe(false);
    }
  );

  test('prepares exact private source bytes from real Git without building or changing governance', () => {
    const { request, context, objectReads } = frozenSourceFixture();
    const before = canonicalBytes();
    const result = executeFrozenSourcePreparation(Buffer.from(JSON.stringify(request)), context);
    expect(result.status).toBe('prepared');
    expect(result.adoption).toBe('NOT_ADOPTED');
    expect(result.source).toEqual({
      ...request.source,
      repoRoot: root,
      worktreeName: 'prep',
      specId: 'PREP-001',
    });
    expect(
      result.sourceTree.files.map(({ relativePath, executable }) => [relativePath, executable])
    ).toEqual([
      ['package.json', false],
      ['scripts/install-cli-snapshot.mjs', true],
    ]);
    expect(fs.readFileSync(path.join(result.sourceTree.root, 'package.json'), 'utf8')).toBe(
      '{"fixture":true}\n'
    );
    expect(
      fs.readFileSync(path.join(result.sourceTree.root, 'scripts/install-cli-snapshot.mjs'), 'utf8')
    ).toBe('fixture executable bytes\n');
    expect(fs.statSync(path.join(result.sourceTree.root, 'package.json')).mode & 0o777).toBe(0o600);
    expect(
      fs.statSync(path.join(result.sourceTree.root, 'scripts/install-cli-snapshot.mjs')).mode &
        0o777
    ).toBe(0o700);
    expect(fs.readdirSync(request.outputRoot).sort()).toEqual(['source', 'source-inventory.json']);
    const inventoryBytes = fs.readFileSync(result.inventory.path);
    expect(result.inventory).toEqual({
      path: path.join(request.outputRoot, 'source-inventory.json'),
      sizeBytes: inventoryBytes.length,
      sha256: crypto.createHash('sha256').update(inventoryBytes).digest('hex'),
    });
    const inventory = JSON.parse(inventoryBytes);
    expect(inventory.files.map(({ relativePath, gitMode }) => [relativePath, gitMode])).toEqual([
      ['package.json', '100644'],
      ['scripts/install-cli-snapshot.mjs', '100755'],
    ]);
    expect(inventory.adoption).toBe('NOT_ADOPTED');
    expect(fs.existsSync(request.futureBuildRoot)).toBe(false);
    expect(objectReads.filter(({ kind }) => kind === 'blob')).toHaveLength(2);
    expect(canonicalBytes()).toEqual(before);
  });

  test('refuses unauthorized output before reading any source objects or writing files', () => {
    const { request, context, objectReads } = frozenSourceFixture();
    context.environment = { CAWS_AGENT_SURFACE: 'codex', CODEX_THREAD_ID: 'foreign-caller' };
    const result = prepareFrozenProductionSource(request, context);
    expect(result).toMatchObject({
      status: 'failed',
      writerState: 'NOT_STARTED',
      phase: 'authority',
    });
    expect(result.reason).toContain('another caller');
    expect(objectReads).toEqual([]);
    expect(fs.existsSync(request.outputRoot)).toBe(false);
  });

  test('rejects request capability flags instead of allowing them to supply standing', () => {
    const { request, context, objectReads } = frozenSourceFixture();
    const result = executeFrozenSourcePreparation(
      Buffer.from(JSON.stringify({ ...request, approved: true, parent: { trusted: true } })),
      context
    );
    expect(result).toMatchObject({
      status: 'failed',
      writerState: 'NOT_STARTED',
      phase: 'request',
      reason: 'Unexpected preparation request shape',
    });
    expect(objectReads).toEqual([]);
    expect(fs.existsSync(request.outputRoot)).toBe(false);
  });

  test('checks every actual destination before mutation, including excluded selected files', () => {
    const { request, context } = frozenSourceFixture();
    spec.scope.out.push('tmp/prepare/run/source/package.json');
    saveSpec();
    const result = prepareFrozenProductionSource(request, context);
    expect(result).toMatchObject({
      status: 'failed',
      writerState: 'NOT_STARTED',
      phase: 'pre-write',
    });
    expect(result.reason).toContain(
      'explicit scope admission: tmp/prepare/run/source/package.json'
    );
    expect(fs.existsSync(request.outputRoot)).toBe(false);
  });

  test('refuses required protected source before any blob read or mutation', () => {
    const { request, context, objectReads } = frozenSourceFixture();
    fs.mkdirSync(path.join(lane, 'docs/credentials'), { recursive: true });
    fs.writeFileSync(path.join(lane, 'docs/credentials/token.md'), 'do not export');
    fixtures.git(lane, ['add', '--', 'docs/credentials/token.md']);
    fixtures.git(lane, ['commit', '-m', 'record protected-name negative fixture']);
    request.source = sourceSelection();
    const result = prepareFrozenProductionSource(request, context);
    expect(result).toMatchObject({
      status: 'failed',
      writerState: 'NOT_STARTED',
      phase: 'objects',
    });
    expect(result.reason).toContain('Required production input is protected');
    expect(objectReads.filter(({ kind }) => kind === 'blob')).toEqual([]);
    expect(fs.existsSync(request.outputRoot)).toBe(false);
  });

  test('refuses an existing or aliased output and leaves foreign bytes unchanged', () => {
    const { request, context, objectReads } = frozenSourceFixture();
    const foreign = path.join(root, 'foreign-output');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'sentinel'), 'foreign bytes');
    fs.symlinkSync(foreign, request.outputRoot);
    const result = prepareFrozenProductionSource(request, context);
    expect(result).toMatchObject({ status: 'failed', writerState: 'NOT_STARTED' });
    expect(result.reason).toContain('already exists');
    expect(fs.readFileSync(path.join(foreign, 'sentinel'), 'utf8')).toBe('foreign bytes');
    expect(fs.readdirSync(foreign)).toEqual(['sentinel']);
    expect(objectReads).toEqual([]);
  });

  test('retains uncertain source on an unrepresented file and refuses retry or adoption', () => {
    const { request, context } = frozenSourceFixture();
    const firstFile = path.join(request.outputRoot, 'source/package.json');
    const extra = path.join(request.outputRoot, 'source/unrepresented');
    context.checkpoint = () => {
      if (fs.existsSync(firstFile) && !fs.existsSync(extra))
        fs.writeFileSync(extra, 'unexpected bytes');
    };
    const result = prepareFrozenProductionSource(request, context);
    expect(result).toMatchObject({
      status: 'failed',
      writerState: 'RETAINED_UNCERTAIN',
      phase: 'verify',
    });
    expect(result.reason).toBe(`Unexpected tree entry: ${extra}`);
    expect(fs.readFileSync(firstFile, 'utf8')).toBe('{"fixture":true}\n');
    expect(fs.readFileSync(extra, 'utf8')).toBe('unexpected bytes');
    expect(fs.existsSync(path.join(request.outputRoot, 'source-inventory.json'))).toBe(false);
    expect(prepareFrozenProductionSource(request, context)).toMatchObject({
      status: 'failed',
      writerState: 'NOT_STARTED',
      phase: 'authority',
    });
    expect(fs.readFileSync(extra, 'utf8')).toBe('unexpected bytes');
    expect(fs.existsSync(request.futureBuildRoot)).toBe(false);
  });

  test('detects substituted root before writing through the replacement directory', () => {
    const { request, context } = frozenSourceFixture();
    const moved = path.join(lane, 'tmp/prepare/retained-original');
    let replaced = false;
    context.checkpoint = () => {
      if (!replaced && fs.existsSync(path.join(request.outputRoot, 'source/package.json'))) {
        replaced = true;
        fs.renameSync(request.outputRoot, moved);
        fs.mkdirSync(request.outputRoot, { mode: 0o700 });
        fs.writeFileSync(path.join(request.outputRoot, 'foreign-sentinel'), 'preserve');
      }
    };
    const result = prepareFrozenProductionSource(request, context);
    expect(result).toMatchObject({
      status: 'failed',
      writerState: 'RETAINED_UNCERTAIN',
      phase: 'source',
    });
    expect(result.reason).toContain('root changed during custody');
    expect(fs.statSync(request.outputRoot).mode).toBe(fs.statSync(moved).mode);
    expect(fs.statSync(request.outputRoot).dev).toBe(fs.statSync(moved).dev);
    expect(fs.statSync(request.outputRoot).ino).not.toBe(fs.statSync(moved).ino);
    expect(fs.readdirSync(request.outputRoot)).toEqual(['foreign-sentinel']);
    expect(fs.readFileSync(path.join(request.outputRoot, 'foreign-sentinel'), 'utf8')).toBe(
      'preserve'
    );
    expect(fs.readFileSync(path.join(moved, 'source/package.json'), 'utf8')).toBe(
      '{"fixture":true}\n'
    );
    expect(fs.existsSync(request.futureBuildRoot)).toBe(false);
  });

  test('rechecks copied bytes rather than accepting only the planned file names', () => {
    const { request, context } = frozenSourceFixture();
    const firstFile = path.join(request.outputRoot, 'source/package.json');
    let changed = false;
    context.checkpoint = () => {
      if (!changed && fs.existsSync(firstFile)) {
        changed = true;
        const bytes = fs.readFileSync(firstFile);
        bytes[2] ^= 1;
        fs.writeFileSync(firstFile, bytes);
      }
    };
    const result = prepareFrozenProductionSource(request, context);
    expect(result).toMatchObject({
      status: 'failed',
      writerState: 'RETAINED_UNCERTAIN',
      phase: 'verify',
    });
    expect(result.reason).toBe(`Pin mismatch: ${firstFile}`);
    expect(fs.statSync(firstFile).size).toBe(Buffer.byteLength('{"fixture":true}\n'));
    expect(fs.existsSync(path.join(request.outputRoot, 'source-inventory.json'))).toBe(false);
  });

  test('refuses an existing future build root without reading objects or altering it', () => {
    const { request, context, objectReads } = frozenSourceFixture();
    fs.mkdirSync(request.futureBuildRoot);
    fs.writeFileSync(path.join(request.futureBuildRoot, 'foreign-sentinel'), 'retain future root');
    const result = prepareFrozenProductionSource(request, context);
    expect(result).toMatchObject({
      status: 'failed',
      writerState: 'NOT_STARTED',
      phase: 'authority',
    });
    expect(result.reason).toBe(`Preparation path already exists: ${request.futureBuildRoot}`);
    expect(objectReads).toEqual([]);
    expect(fs.existsSync(request.outputRoot)).toBe(false);
    expect(fs.readdirSync(request.futureBuildRoot)).toEqual(['foreign-sentinel']);
    expect(fs.readFileSync(path.join(request.futureBuildRoot, 'foreign-sentinel'), 'utf8')).toBe(
      'retain future root'
    );
  });

  test('retains uncertain output when the future build root appears during copying', () => {
    const { request, context } = frozenSourceFixture();
    context.checkpoint = () => {
      if (
        fs.existsSync(path.join(request.outputRoot, 'source/package.json')) &&
        !fs.existsSync(request.futureBuildRoot)
      ) {
        fs.mkdirSync(request.futureBuildRoot);
        fs.writeFileSync(path.join(request.futureBuildRoot, 'foreign-sentinel'), 'preserve');
      }
    };
    const result = prepareFrozenProductionSource(request, context);
    expect(result).toMatchObject({
      status: 'failed',
      writerState: 'RETAINED_UNCERTAIN',
      phase: 'source',
    });
    expect(result.reason).toBe(`Preparation path already exists: ${request.futureBuildRoot}`);
    expect(fs.readdirSync(request.futureBuildRoot)).toEqual(['foreign-sentinel']);
    expect(fs.readFileSync(path.join(request.futureBuildRoot, 'foreign-sentinel'), 'utf8')).toBe(
      'preserve'
    );
    expect(fs.existsSync(path.join(request.outputRoot, 'source-inventory.json'))).toBe(false);
  });

  test('rechecks source HEAD after object collection before creating output', () => {
    const { request, context } = frozenSourceFixture();
    const read = context.readObjects;
    let changed = false;
    context.readObjects = (selections) => {
      const bytes = read(selections);
      if (!changed && selections.some(({ kind }) => kind === 'blob')) {
        changed = true;
        fixtures.git(lane, ['commit', '--allow-empty', '-m', 'advance during observation']);
      }
      return bytes;
    };
    const result = prepareFrozenProductionSource(request, context);
    expect(result).toMatchObject({
      status: 'failed',
      writerState: 'NOT_STARTED',
      phase: 'pre-write',
    });
    expect(result.reason).toContain('not the current HEAD');
    expect(fs.existsSync(request.outputRoot)).toBe(false);
  });

  test.each(['reader', 'checkpoint'])(
    'refuses a later blob group %s failure before creating any output',
    (failure) => {
      const { request, context } = frozenSourceFixture();
      fs.mkdirSync(path.join(lane, 'docs'));
      for (let i = 0; i < 63; i++) {
        fs.writeFileSync(path.join(lane, `docs/group-${i}.md`), `selected ${i}`);
      }
      fixtures.git(lane, ['add', '--', 'docs']);
      fixtures.git(lane, ['commit', '-m', 'record multi-group source fixture']);
      request.source = sourceSelection();
      const read = context.readObjects;
      const groups = [];
      let failCheckpoint = false;
      context.readObjects = (selections) => {
        if (selections[0].kind === 'blob') {
          groups.push(selections.map((item) => ({ ...item })));
          if (groups.length === 2 && failure === 'reader') {
            throw new Error('later blob reader failed');
          }
        }
        const bytes = read(selections);
        if (groups.length === 2) failCheckpoint = true;
        return bytes;
      };
      context.checkpoint = () => {
        if (failCheckpoint) throw new Error('later blob checkpoint failed');
      };
      const before = canonicalBytes();
      expect(prepareFrozenProductionSource(request, context)).toEqual({
        status: 'failed',
        adoption: 'NOT_ADOPTED',
        writerState: 'NOT_STARTED',
        phase: 'objects',
        reason: `later blob ${failure} failed`,
      });
      expect(groups.map((group) => group.length)).toEqual([31, 31]);
      expect(fs.existsSync(request.outputRoot)).toBe(false);
      expect(fs.existsSync(request.futureBuildRoot)).toBe(false);
      expect(canonicalBytes()).toEqual(before);
    }
  );

  test('refuses overlap and cancellation without object access or output mutation', () => {
    const { request, context, objectReads } = frozenSourceFixture();
    expect(
      prepareFrozenProductionSource(
        { ...request, futureBuildRoot: path.join(request.outputRoot, 'build') },
        context
      )
    ).toMatchObject({
      status: 'failed',
      writerState: 'NOT_STARTED',
      reason: 'Preparation and future build roots must be disjoint',
    });
    context.checkpoint = () => {
      throw new Error('fixture deadline expired');
    };
    expect(prepareFrozenProductionSource(request, context)).toMatchObject({
      status: 'failed',
      writerState: 'NOT_STARTED',
      reason: 'fixture deadline expired',
    });
    expect(objectReads).toEqual([]);
    expect(fs.existsSync(request.outputRoot)).toBe(false);
  });

  test.each(['canonical', 'bound lane'])(
    'observes exact current %s source without mutation',
    (kind) => {
      const source = sourceSelection(kind === 'canonical' ? root : lane);
      const before = canonicalBytes();
      expect(inspectPreparationSourceStanding(source, caller)).toEqual({
        ...source,
        repoRoot: root,
        worktreeName: kind === 'canonical' ? null : 'prep',
        specId: kind === 'canonical' ? null : 'PREP-001',
      });
      expect(canonicalBytes()).toEqual(before);
      expect(fs.existsSync(selection.outputRoot)).toBe(false);
      expect(calls).toEqual([
        { args: ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd: lane },
        { args: ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd: root },
        {
          args: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
          cwd: source.sourceRoot,
        },
        { args: ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd: root },
        { args: ['rev-parse', '--show-toplevel'], cwd: source.sourceRoot },
        { args: ['rev-parse', '--show-object-format'], cwd: source.sourceRoot },
        { args: ['rev-parse', '--verify', 'HEAD^{commit}'], cwd: source.sourceRoot },
        { args: ['rev-parse', '--verify', 'HEAD^{tree}'], cwd: source.sourceRoot },
        { args: ['rev-parse', '--verify', 'HEAD^{commit}'], cwd: source.sourceRoot },
      ]);
    }
  );

  test('source standing does not borrow its owner as output authority', () => {
    const source = sourceSelection();
    registry.prep.owner.session_id = 'different-owner';
    saveRegistry();
    expect(inspectPreparationSourceStanding(source, caller).commit).toBe(source.commit);
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow('another caller');
  });

  test('selects only HEAD while preserving dirty working files untouched', () => {
    const source = sourceSelection();
    const dirty = path.join(lane, 'uncommitted-source.ts');
    fs.writeFileSync(dirty, 'uncommitted bytes');
    expect(inspectPreparationSourceStanding(source, caller).commit).toBe(source.commit);
    expect(fs.readFileSync(dirty, 'utf8')).toBe('uncommitted bytes');
  });

  test('refuses a historical commit even when its tree matches current HEAD', () => {
    const source = sourceSelection();
    fixtures.git(lane, ['commit', '--allow-empty', '-m', 'advance fixture source']);
    expect(fixtures.git(lane, ['rev-parse', 'HEAD^{tree}'])).toBe(source.tree);
    expect(() => inspectPreparationSourceStanding(source, caller)).toThrow('not the current HEAD');
  });

  test('refuses source from another canonical project', () => {
    const foreign = fs.realpathSync(fixtures.makeTempRepo());
    expect(initProject(foreign).ok).toBe(true);
    const source = sourceSelection(foreign);
    expect(() => inspectPreparationSourceStanding(source, caller)).toThrow(
      'another canonical project'
    );
  });

  test('refuses an independent separate Git store under the same project parent', () => {
    const separateLane = path.join(root, 'separate-source');
    const separateStore = path.join(root, '.foreign-git');
    fixtures.git(root, [
      'clone',
      '--no-hardlinks',
      '--separate-git-dir',
      separateStore,
      root,
      separateLane,
    ]);
    registry.prep.path = separateLane;
    saveRegistry();
    const source = sourceSelection(separateLane);
    expect(fixtures.git(lane, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toBe(
      path.join(root, '.git')
    );
    expect(
      fixtures.git(separateLane, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    ).toBe(separateStore);
    expect(source.commit).toBe(fixtures.git(root, ['rev-parse', 'HEAD']));
    expect(() => inspectPreparationSourceStanding(source, caller)).toThrow(
      'another Git object store'
    );
    expect(() =>
      inspectPreparationWriteAuthority(
        { outputRoot: path.join(separateLane, 'tmp/prepare/run'), writePaths: [] },
        { ...caller, cwd: separateLane }
      )
    ).toThrow('another Git object store');
    expect(fs.existsSync(path.join(separateLane, 'tmp/prepare/run'))).toBe(false);
  });

  test.each(['draft', 'closed', 'archived'])('refuses a %s source lane', (state) => {
    const source = sourceSelection();
    spec.lifecycle_state = state;
    if (state !== 'draft') spec.resolution = 'completed';
    saveSpec();
    expect(loadSpecs(path.join(root, '.caws')).diagnostics).toEqual([]);
    expect(() => inspectPreparationSourceStanding(source, caller)).toThrow(
      'Source worktree spec must be active'
    );
  });

  test('requires source registry membership and a bidirectional binding', () => {
    const source = sourceSelection();
    spec.worktree = 'another';
    saveSpec();
    expect(() => inspectPreparationSourceStanding(source, caller)).toThrow('bidirectional');
    delete registry.prep;
    saveRegistry();
    expect(() => inspectPreparationSourceStanding(source, caller)).toThrow(
      'exactly one live registry'
    );
  });

  test('refuses duplicate source claims, subdirectory roots and path aliases', () => {
    const source = sourceSelection();
    registry.duplicate = { ...registry.prep };
    saveRegistry();
    expect(() => inspectPreparationSourceStanding(source, caller)).toThrow(
      'exactly one live registry'
    );
    delete registry.duplicate;
    saveRegistry();
    fs.mkdirSync(path.join(lane, 'nested'));
    expect(() =>
      inspectPreparationSourceStanding({ ...source, sourceRoot: path.join(lane, 'nested') }, caller)
    ).toThrow('actual Git checkout root');
    const alias = path.join(root, 'source-alias');
    fs.symlinkSync(lane, alias);
    expect(() =>
      inspectPreparationSourceStanding({ ...source, sourceRoot: alias }, caller)
    ).toThrow('actual Git checkout root');
  });

  test('refuses malformed pins before Git and detects format/tree disagreement', () => {
    const source = sourceSelection();
    expect(() => inspectPreparationSourceStanding({ ...source, commit: 'HEAD' }, caller)).toThrow(
      'full lowercase'
    );
    expect(calls).toEqual([]);
    expect(() =>
      inspectPreparationSourceStanding(
        { ...source, commit: 'a'.repeat(64), tree: 'b'.repeat(64), objectFormat: 'sha256' },
        caller
      )
    ).toThrow('object format mismatch');
    expect(() =>
      inspectPreparationSourceStanding({ ...source, tree: '1'.repeat(40) }, caller)
    ).toThrow('tree pin does not match');
  });

  test('refuses a HEAD change between fixed observations', () => {
    const source = sourceSelection();
    const original = caller.git;
    let headReads = 0;
    caller.git = (args, options) => {
      const result = original(args, options);
      if (args.join(' ') === 'rev-parse --verify HEAD^{commit}' && ++headReads === 2)
        return '1'.repeat(40);
      return result;
    };
    expect(() => inspectPreparationSourceStanding(source, caller)).toThrow(
      'HEAD changed during observation'
    );
    expect(headReads).toBe(2);
    expect(fs.existsSync(selection.outputRoot)).toBe(false);
  });

  test('reads real linked-worktree ownership and explicit relative scope without writes', () => {
    const before = canonicalBytes();
    expect(inspectPreparationWriteAuthority(selection, caller)).toEqual({
      repoRoot: root,
      cawsDir: path.join(root, '.caws'),
      worktreeRoot: lane,
      worktreeName: 'prep',
      specId: 'PREP-001',
      sessionId: owner,
      checkedRelativePaths: ['tmp/prepare/run', 'tmp/prepare/run/source/file.ts'],
    });
    expect(canonicalBytes()).toEqual(before);
    expect(fs.existsSync(selection.outputRoot)).toBe(false);
    expect(calls).toEqual([
      { args: ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd: lane },
      { args: ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd: root },
      { args: ['rev-parse', '--show-toplevel'], cwd: lane },
      { args: ['check-ignore', '--quiet', '--no-index', '--', 'tmp/prepare/run'], cwd: lane },
    ]);
  });

  test('refuses a different caller despite valid scope and existing owner records', () => {
    caller.environment.CODEX_THREAD_ID = 'another-fixture-owner';
    const before = canonicalBytes();
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow('another caller');
    expect(canonicalBytes()).toEqual(before);
    expect(fs.existsSync(selection.outputRoot)).toBe(false);
  });

  test('does not acquire an identity from the registered owner when caller identity is absent', () => {
    caller.environment = {};
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow(
      'identity unavailable'
    );
    expect(fs.existsSync(path.join(root, '.caws/sessions'))).toBe(false);
  });

  test.each(['draft', 'closed', 'archived'])(
    'refuses a %s spec even with matching ownership',
    (state) => {
      spec.lifecycle_state = state;
      if (state === 'closed' || state === 'archived') spec.resolution = 'completed';
      saveSpec();
      expect(loadSpecs(path.join(root, '.caws')).diagnostics).toEqual([]);
      expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow(
        'spec must be active'
      );
    }
  );

  test('refuses one-sided binding rather than borrowing another spec', () => {
    spec.worktree = 'different';
    saveSpec();
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow('bidirectional');
  });

  test('uses actual Git checkout rather than a claimant path or canonical infrastructure exemption', () => {
    spec.scope.in = ['elsewhere/'];
    saveSpec();
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow(
      'explicit scope admission: tmp/prepare/run'
    );
    caller.cwd = root;
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow(
      'owned linked worktree'
    );
  });

  test('refuses registry disagreement and duplicate physical checkout claims', () => {
    registry.prep.path = root;
    saveRegistry();
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow(
      'exactly one registry'
    );
    registry.prep.path = lane;
    registry.duplicate = { ...registry.prep };
    saveRegistry();
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow(
      'exactly one registry'
    );
  });

  test('refuses missing policy, output escapes and exclusions within otherwise admitted output', () => {
    selection.writePaths = [path.join(lane, 'tmp/prepare/run/private/key')];
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow(
      'explicit scope admission'
    );
    selection.writePaths = [path.join(root, 'foreign-output')];
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow(
      'escapes selected output'
    );
    selection.writePaths = [];
    fs.unlinkSync(path.join(root, '.caws/policy.yaml'));
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow('policy unavailable');
  });

  test('requires actual ignored output and refuses control-plane paths', () => {
    fs.writeFileSync(path.join(lane, '.gitignore'), '');
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow('must be ignored');
    selection = { outputRoot: path.join(lane, '.caws/prepared'), writePaths: [] };
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow('control-plane');
  });
});

function object(kind, body, format = 'sha1') {
  const bytes = Buffer.from(body);
  const oid = crypto
    .createHash(format)
    .update(`${kind} ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
  return { oid, kind, bytes };
}
function framed(value) {
  return Buffer.concat([
    Buffer.from(`${value.oid} ${value.kind} ${value.bytes.length}\n`),
    value.bytes,
    Buffer.from('\n'),
  ]);
}
function treeRecord(mode, name, oid) {
  return Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')]);
}

describe('native preparation profile before blob reads', () => {
  function graph(files, format = 'sha1') {
    const index = new Map();
    const roots = {};
    const blobs = {};
    for (const [name, body, mode = '100644'] of files) {
      const blob = object('blob', body, format);
      index.set(blob.oid, blob);
      blobs[name] = blob;
      const parts = name.split('/');
      let cursor = roots;
      for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {};
      cursor[parts.at(-1)] = { blob, mode };
    }
    function treeOf(directory) {
      const tree = object(
        'tree',
        Buffer.concat(
          Object.entries(directory).map(([name, entry]) =>
            entry.blob
              ? treeRecord(entry.mode, name, entry.blob.oid)
              : treeRecord('40000', name, treeOf(entry).oid)
          )
        ),
        format
      );
      index.set(tree.oid, tree);
      return tree;
    }
    const tree = treeOf(roots);
    const commit = object('commit', `tree ${tree.oid}\n\nproduction snapshot`, format);
    index.set(commit.oid, commit);
    const calls = [];
    const batches = [];
    const read = (selections) => {
      calls.push(...selections.map((value) => ({ ...value })));
      batches.push(selections.map((value) => ({ ...value })));
      return Buffer.concat(selections.map(({ oid }) => framed(index.get(oid))));
    };
    return { read, index, calls, batches, blobs, commit, tree, format };
  }
  const collect = (fixture) =>
    collectPreparationProductionSource(
      fixture.read,
      fixture.commit.oid,
      fixture.tree.oid,
      fixture.format
    );
  const selectedFiles = (count, bytes = (i) => `selected ${i}`) =>
    Array.from({ length: count }, (_, i) => [
      `docs/${String(i).padStart(3, '0')}.md`,
      bytes(i),
      i % 2 ? '100755' : '100644',
    ]);
  const blobBatches = (fixture) => fixture.batches.filter(([first]) => first.kind === 'blob');

  test.each(['sha1', 'sha256'])(
    'batches 32 unique %s blobs as 31 and 1 without losing sorted duplicate paths or modes',
    (format) => {
      const entries = selectedFiles(32);
      entries.push(['docs/032-reused.md', entries[0][1], '100755']);
      const fixture = graph([...entries].reverse(), format);
      const result = collect(fixture);
      expect(blobBatches(fixture).map((group) => group.length)).toEqual([31, 1]);
      expect(
        fixture.batches
          .filter(([first]) => first.kind !== 'blob')
          .every((group) => group.length === 1)
      ).toBe(true);
      expect(result.files).toEqual(
        entries.map(([relativePath, body, mode]) => ({
          relativePath,
          oid: fixture.blobs[relativePath].oid,
          mode,
          bytes: Buffer.from(body),
        }))
      );
      expect(result.directories).toEqual(['docs']);
      expect(
        fixture.calls.filter(({ oid }) => oid === fixture.blobs[entries[0][0]].oid)
      ).toHaveLength(1);
      result.files[0].bytes.fill(0);
      expect(result.files.at(-1).bytes.toString()).toBe(entries[0][1]);
    }
  );

  const invalidGroups = [
    [
      'corrupt',
      (objects) => {
        const bytes = Buffer.from(objects[1].bytes);
        bytes[0] ^= 1;
        objects[1] = { ...objects[1], bytes };
        return Buffer.concat(objects.map(framed));
      },
      'content identity mismatch',
    ],
    [
      'missing',
      (objects) => Buffer.concat([framed(objects[0]), Buffer.from(`${objects[1].oid} missing\n`)]),
      'Malformed or missing',
    ],
    [
      'reordered',
      (objects) => {
        [objects[1], objects[2]] = [objects[2], objects[1]];
        return Buffer.concat(objects.map(framed));
      },
      'selection mismatch',
    ],
    [
      'duplicate',
      (objects) => {
        objects[1] = objects[0];
        return Buffer.concat(objects.map(framed));
      },
      'selection mismatch',
    ],
    ['surplus', (objects) => Buffer.concat([...objects, objects[1]].map(framed)), 'Surplus'],
    [
      'wrong kind',
      (objects) => {
        objects[1] = { ...objects[1], kind: 'tree' };
        return Buffer.concat(objects.map(framed));
      },
      'selection mismatch',
    ],
    [
      'truncated',
      (objects) => Buffer.concat(objects.slice(0, 2).map(framed)).subarray(0, -1),
      'Truncated',
    ],
  ];
  test.each([0, 1].flatMap((group) => invalidGroups.map((fault) => [group, ...fault])))(
    'refuses group %i with a nonfirst %s object and makes no later request',
    (badGroup, _name, change, diagnostic) => {
      const fixture = graph(selectedFiles(63));
      const read = fixture.read;
      fixture.read = (selections) => {
        const bytes = read(selections);
        if (selections[0].kind === 'blob' && blobBatches(fixture).length === badGroup + 1) {
          return change(selections.map(({ oid }) => fixture.index.get(oid)));
        }
        return bytes;
      };
      expect(() => collect(fixture)).toThrow(diagnostic);
      expect(blobBatches(fixture).map((group) => group.length)).toEqual(
        Array(badGroup + 1).fill(31)
      );
    }
  );

  // Exercise the built collector/decoder with smaller private capacities so
  // cumulative-limit failures need kilobytes rather than half a gigabyte.
  function scaledCollector(bounds) {
    const filename = require.resolve('../../dist/tooling/native-qualification-prepare');
    let source = fs.readFileSync(filename, 'utf8');
    for (const [name, value] of Object.entries(bounds)) {
      const declaration = new RegExp(`const ${name} = [^;]+;`, 'g');
      expect(source.match(declaration)).toHaveLength(1);
      source = source.replace(declaration, `const ${name} = ${value};`);
    }
    const module = { exports: {} };
    require('node:vm').runInNewContext(
      `(function(require, module, exports) { ${source}\n})`,
      { Buffer, process, console },
      { filename }
    )(require('node:module').createRequire(filename), module, module.exports);
    return (fixture) =>
      module.exports.collectPreparationProductionSource(
        fixture.read,
        fixture.commit.oid,
        fixture.tree.oid,
        fixture.format
      );
  }

  test('includes cached metadata in the cumulative object count before requesting a later group', () => {
    const fixture = graph(selectedFiles(63));
    const collectSmall = scaledCollector({ MAX_OBJECTS: 64 });
    expect(() => collectSmall(fixture)).toThrow('Production object count exceeds bound');
    expect(blobBatches(fixture).map((group) => group.length)).toEqual([31]);
  });

  test('carries object payload bytes across groups instead of resetting at each response', () => {
    const fixture = graph(selectedFiles(33, (i) => Buffer.alloc(4096, i)));
    const collectSmall = scaledCollector({ MAX_OBJECT_BYTES: 4096, MAX_BATCH_BYTES: 128 * 1024 });
    expect(() => collectSmall(fixture)).toThrow('Production object bytes exceed bound');
    expect(blobBatches(fixture).map((group) => group.length)).toEqual([31, 2]);
  });

  test('counts every materialized duplicate path after collecting multiple bounded groups', () => {
    const entries = selectedFiles(32, (i) => Buffer.alloc(i === 0 ? 4096 : 1, i));
    for (let i = 32; i < 64; i++) {
      entries.push([`docs/${i}.md`, entries[0][1]]);
    }
    const fixture = graph(entries);
    const collectSmall = scaledCollector({ MAX_OBJECT_BYTES: 4096, MAX_BATCH_BYTES: 128 * 1024 });
    expect(() => collectSmall(fixture)).toThrow('Materialized source bytes exceed bound');
    expect(blobBatches(fixture).map((group) => group.length)).toEqual([31, 1]);
    expect(
      fixture.calls.filter(({ oid }) => oid === fixture.blobs[entries[0][0]].oid)
    ).toHaveLength(1);
  });

  test.each(['sha1', 'sha256'])(
    'reads only selected %s blobs after completing the name inventory',
    (format) => {
      const fixture = graph(
        [
          ['package.json', '{"private":true}\n'],
          ['scripts/install-cli-snapshot.mjs', 'executable source\n', '100755'],
          ['docs/new-guide.md', '---\naudience: consumer\n---\n'],
          ['README.md', 'unselected root documentation'],
          ['.caws/policy.yaml', 'protected policy'],
        ],
        format
      );
      const result = collect(fixture);
      expect(result.commit).toBe(fixture.commit.oid);
      expect(result.tree).toBe(fixture.tree.oid);
      expect(result.objectFormat).toBe(format);
      expect(result.directories).toEqual(['docs', 'scripts']);
      expect(result.files).toEqual([
        {
          relativePath: 'docs/new-guide.md',
          oid: fixture.blobs['docs/new-guide.md'].oid,
          mode: '100644',
          bytes: Buffer.from('---\naudience: consumer\n---\n'),
        },
        {
          relativePath: 'package.json',
          oid: fixture.blobs['package.json'].oid,
          mode: '100644',
          bytes: Buffer.from('{"private":true}\n'),
        },
        {
          relativePath: 'scripts/install-cli-snapshot.mjs',
          oid: fixture.blobs['scripts/install-cli-snapshot.mjs'].oid,
          mode: '100755',
          bytes: Buffer.from('executable source\n'),
        },
      ]);
      expect(result.omitted).toEqual([
        { relativePath: '.caws/policy.yaml', disposition: 'protected' },
        { relativePath: 'README.md', disposition: 'unselected' },
      ]);
      const expectedMetadata = [...fixture.index.values()]
        .filter(({ kind }) => kind !== 'blob')
        .map(({ oid, kind }) => ({ oid, kind }));
      const firstBlob = fixture.calls.findIndex(({ kind }) => kind === 'blob');
      expect(firstBlob).toBe(expectedMetadata.length);
      expect(fixture.calls.slice(0, firstBlob)).toEqual(expect.arrayContaining(expectedMetadata));
      expect(fixture.calls.slice(firstBlob)).toEqual(
        result.files.map(({ oid }) => ({ oid, kind: 'blob' }))
      );
    }
  );

  test.each([
    'docs/.env/guide.md',
    'packages/caws-cli/src/runtime/.caws/state.json',
    'packages/caws-cli/templates/hook-packs/shared/credentials.json',
    'packages/caws-cli/templates/hook-packs/shared/credentials/token.json',
    'docs/credentials/token.md',
  ])('refuses required protected input %s before reading any blobs', (name) => {
    const fixture = graph([
      ['package.json', 'otherwise selected'],
      [name, 'must never read'],
    ]);
    expect(() => collect(fixture)).toThrow(`Required production input is protected: ${name}`);
    expect(fixture.calls.filter(({ kind }) => kind === 'blob')).toEqual([]);
  });

  test('selects a benign credentials-guide sibling without treating it as a credential directory', () => {
    const fixture = graph([['docs/credentials-guide.md', 'ordinary authored documentation']]);
    const result = collect(fixture);
    expect(result.files.map(({ relativePath, bytes }) => [relativePath, bytes.toString()])).toEqual(
      [['docs/credentials-guide.md', 'ordinary authored documentation']]
    );
    expect(fixture.calls.filter(({ kind }) => kind === 'blob')).toEqual([
      { oid: fixture.blobs['docs/credentials-guide.md'].oid, kind: 'blob' },
    ]);
  });

  test('does not request unselected test fixtures or an empty profile', () => {
    const fixture = graph([['packages/caws-cli/tests/example.test.js', 'not a production input']]);
    expect(() => collect(fixture)).toThrow('Production source selection is empty');
    expect(fixture.calls.filter(({ kind }) => kind === 'blob')).toEqual([]);
  });

  test('rehashes selected content and refuses a transport returning changed bytes', () => {
    const fixture = graph([['package.json', 'selected bytes']]);
    fixture.blobs['package.json'].bytes[0] ^= 1;
    expect(() => collect(fixture)).toThrow('content identity mismatch');
  });

  test('rejects a root pin mismatch before traversing any source tree', () => {
    const fixture = graph([['package.json', 'selected bytes']]);
    expect(() =>
      collectPreparationProductionSource(fixture.read, fixture.commit.oid, '1'.repeat(40), 'sha1')
    ).toThrow('Pinned root tree mismatch');
    expect(fixture.calls).toEqual([{ oid: fixture.commit.oid, kind: 'commit' }]);
  });

  test('deduplicates object reads but preserves each selected file and mode', () => {
    const fixture = graph([
      ['LICENSE', 'same bytes'],
      ['package.json', 'same bytes', '100755'],
    ]);
    const result = collect(fixture);
    expect(
      result.files.map(({ relativePath, mode, bytes }) => [relativePath, mode, bytes.toString()])
    ).toEqual([
      ['LICENSE', '100644', 'same bytes'],
      ['package.json', '100755', 'same bytes'],
    ]);
    expect(fixture.calls.filter(({ kind }) => kind === 'blob')).toEqual([
      { oid: fixture.blobs.LICENSE.oid, kind: 'blob' },
    ]);
    result.files[0].bytes.fill(0);
    expect(result.files[1].bytes.toString()).toBe('same bytes');
  });

  test('refuses a link without following it even outside the selected profile', () => {
    const fixture = graph([
      ['package.json', 'selected'],
      ['unselected-link', '/outside', '120000'],
    ]);
    expect(() => collect(fixture)).toThrow('Unsupported source mode');
    expect(fixture.calls.filter(({ kind }) => kind === 'blob')).toEqual([]);
  });

  test('bounds metadata depth before reading otherwise selected content', () => {
    const fixture = graph([
      ['package.json', 'selected'],
      [`${'d/'.repeat(65)}file`, 'deep'],
    ]);
    expect(() => collect(fixture)).toThrow('depth exceeds bound');
    expect(fixture.calls.filter(({ kind }) => kind === 'blob')).toEqual([]);
  });
});

describe('native preparation raw Git object identities', () => {
  test.each(['sha1', 'sha256'])(
    'preserves exact binary and empty blob bytes in %s framing',
    (format) => {
      const binary = object('blob', Buffer.from([0, 255, 10, 32, 13]), format);
      const empty = object('blob', Buffer.alloc(0), format);
      const source = Buffer.concat([framed(binary), framed(empty)]);
      const result = decodePreparationGitBatch(source, [binary, empty], format);
      expect(result).toEqual([binary, empty]);
      source.fill(0);
      expect(result[0].bytes).toEqual(Buffer.from([0, 255, 10, 32, 13]));
    }
  );

  test('rejects changed bytes even when framing and byte count match', () => {
    const value = object('blob', 'known');
    const changed = framed({ ...value, bytes: Buffer.from('other') });
    expect(() => decodePreparationGitBatch(changed, [value], 'sha1')).toThrow(
      'content identity mismatch'
    );
  });

  test('rejects wrong object kind instead of treating its bytes as source', () => {
    const value = object('tree', Buffer.alloc(0));
    expect(() =>
      decodePreparationGitBatch(framed(value), [{ ...value, kind: 'blob' }], 'sha1')
    ).toThrow('selection mismatch');
  });

  test.each(['HEAD', 'a'.repeat(39), 'A'.repeat(40), 'a'.repeat(64)])(
    'refuses non-SHA1 selection %s',
    (oid) => {
      expect(() =>
        decodePreparationGitBatch(Buffer.alloc(0), [{ oid, kind: 'blob' }], 'sha1')
      ).toThrow('full lowercase');
    }
  );

  test.each(['missing', 'ambiguous'])('rejects Git %s output', (status) => {
    const value = object('blob', 'known');
    expect(() =>
      decodePreparationGitBatch(Buffer.from(`${value.oid} ${status}\n`), [value], 'sha1')
    ).toThrow('Malformed or missing');
  });

  test('rejects truncated bodies, surplus frames and noncanonical size', () => {
    const value = object('blob', 'known');
    expect(() => decodePreparationGitBatch(framed(value).subarray(0, -1), [value], 'sha1')).toThrow(
      'Truncated'
    );
    expect(() =>
      decodePreparationGitBatch(Buffer.concat([framed(value), framed(value)]), [value], 'sha1')
    ).toThrow('Surplus');
    expect(() =>
      decodePreparationGitBatch(Buffer.from(`${value.oid} blob 05\nknown\n`), [value], 'sha1')
    ).toThrow('Malformed');
  });

  test('rejects oversized bodies before reading or allocating their declared content', () => {
    const value = object('blob', 'known');
    expect(() =>
      decodePreparationGitBatch(Buffer.from(`${value.oid} blob 16777217\n`), [value], 'sha1')
    ).toThrow('exceeds bound');
  });
});

describe('native preparation complete Git export inventory', () => {
  function graph(format = 'sha1') {
    const blob = object('blob', 'exact source\n', format);
    const inner = object('tree', treeRecord('100755', 'run.sh', blob.oid), format);
    const root = object(
      'tree',
      Buffer.concat([
        treeRecord('100644', 'README', blob.oid),
        treeRecord('40000', 'src', inner.oid),
      ]),
      format
    );
    const commit = object(
      'commit',
      `tree ${root.oid}\nauthor Test <test@example.invalid> 1 +0000\n\nmessage\n`,
      format
    );
    return { blob, inner, root, commit, objects: [blob, inner, root, commit] };
  }

  test.each(['sha1', 'sha256'])(
    'derives the exact %s graph, modes and reused blob bytes',
    (format) => {
      const fixture = graph(format);
      expect(
        planPreparationGitExport(fixture.objects, fixture.commit.oid, fixture.root.oid, format)
      ).toEqual({
        commit: fixture.commit.oid,
        tree: fixture.root.oid,
        directories: ['src'],
        files: [
          {
            relativePath: 'README',
            mode: '100644',
            oid: fixture.blob.oid,
            bytes: Buffer.from('exact source\n'),
          },
          {
            relativePath: 'src/run.sh',
            mode: '100755',
            oid: fixture.blob.oid,
            bytes: Buffer.from('exact source\n'),
          },
        ],
      });
    }
  );

  test('refuses a different root, missing child and unrelated extra object', () => {
    const fixture = graph();
    expect(() =>
      planPreparationGitExport(fixture.objects, fixture.commit.oid, fixture.inner.oid, 'sha1')
    ).toThrow('Pinned root tree');
    expect(() =>
      planPreparationGitExport(
        [fixture.inner, fixture.root, fixture.commit],
        fixture.commit.oid,
        fixture.root.oid,
        'sha1'
      )
    ).toThrow('Missing object');
    expect(() =>
      planPreparationGitExport(
        [...fixture.objects, object('blob', 'unreachable')],
        fixture.commit.oid,
        fixture.root.oid,
        'sha1'
      )
    ).toThrow('Unreachable');
  });

  test('rehashes graph input instead of trusting a caller-created object record', () => {
    const fixture = graph();
    fixture.blob.bytes[0] ^= 1;
    expect(() =>
      planPreparationGitExport(fixture.objects, fixture.commit.oid, fixture.root.oid, 'sha1')
    ).toThrow('content identity');
  });

  test('refuses an object of the wrong type referenced as a source directory', () => {
    const blob = object('blob', 'not a tree');
    const root = object('tree', treeRecord('40000', 'src', blob.oid));
    const commit = object('commit', `tree ${root.oid}\n\nmessage`);
    expect(() =>
      planPreparationGitExport([blob, root, commit], commit.oid, root.oid, 'sha1')
    ).toThrow('incorrect graph edge type');
  });

  function nestedGraph(depth, name) {
    let root = object('tree', Buffer.alloc(0));
    const objects = [root];
    for (let i = 0; i < depth; i++) {
      root = object('tree', treeRecord('40000', name, root.oid));
      objects.push(root);
    }
    const commit = object('commit', `tree ${root.oid}\n\nmessage`);
    return { objects: [...objects, commit], commit, root };
  }

  test('refuses a valid rehashed graph deeper than the source recursion bound', () => {
    const fixture = nestedGraph(65, 'd');
    expect(() =>
      planPreparationGitExport(fixture.objects, fixture.commit.oid, fixture.root.oid, 'sha1')
    ).toThrow('depth exceeds bound');
  });

  test('refuses an overlong materialized path even when every component is valid', () => {
    const fixture = nestedGraph(21, 'd'.repeat(200));
    expect(() =>
      planPreparationGitExport(fixture.objects, fixture.commit.oid, fixture.root.oid, 'sha1')
    ).toThrow('path inventory exceeds bound');
  });

  test('bounds materialized entries when a small graph reuses an empty subtree', () => {
    const empty = object('tree', Buffer.alloc(0));
    const wide = object(
      'tree',
      Buffer.concat(
        Array.from({ length: 1000 }, (_, i) =>
          treeRecord('40000', `d${String(i).padStart(4, '0')}`, empty.oid)
        )
      )
    );
    const root = object(
      'tree',
      Buffer.concat(
        Array.from({ length: 51 }, (_, i) =>
          treeRecord('40000', `p${String(i).padStart(2, '0')}`, wide.oid)
        )
      )
    );
    const commit = object('commit', `tree ${root.oid}\n\nmessage`);
    expect(() =>
      planPreparationGitExport([empty, wide, root, commit], commit.oid, root.oid, 'sha1')
    ).toThrow('path inventory exceeds bound');
  });
});

describe('native preparation commit and tree interpretation', () => {
  test.each(['sha1', 'sha256'])(
    'reads exact commit tree and regular modes using %s IDs',
    (format) => {
      const blob = object('blob', 'file', format);
      const tree = object(
        'tree',
        Buffer.concat([
          treeRecord('100644', 'README.md', blob.oid),
          treeRecord('100755', 'run.sh', blob.oid),
        ]),
        format
      );
      const commit = Buffer.from(
        `tree ${tree.oid}\nauthor Test <test@example.invalid> 1 +0000\n\ntree message-is-not-a-header\n`
      );
      expect(preparationCommitTree(commit, format)).toBe(tree.oid);
      expect(decodePreparationGitTree(tree.bytes, format)).toEqual([
        { name: 'README.md', mode: '100644', oid: blob.oid },
        { name: 'run.sh', mode: '100755', oid: blob.oid },
      ]);
    }
  );

  test('accepts a directory record for subsequent recursive object verification', () => {
    const tree = object('tree', Buffer.alloc(0));
    expect(decodePreparationGitTree(treeRecord('40000', 'src', tree.oid), 'sha1')).toEqual([
      { name: 'src', mode: '40000', oid: tree.oid },
    ]);
  });

  test.each(['120000', '160000', '100600'])('refuses source mode %s', (mode) => {
    expect(() =>
      decodePreparationGitTree(treeRecord(mode, 'entry', 'a'.repeat(40)), 'sha1')
    ).toThrow('Unsupported source mode');
  });

  test.each(['.', '..', '.git', '.GiT', 'a/b', 'a\\b', 'line\nbreak', 'é'])(
    'refuses unsafe or unsupported name %s',
    (name) => {
      expect(() =>
        decodePreparationGitTree(treeRecord('100644', name, 'a'.repeat(40)), 'sha1')
      ).toThrow(/source name/);
    }
  );

  test('rejects file-directory aliases and duplicate case variants', () => {
    const bytes = Buffer.concat([
      treeRecord('40000', 'src', 'a'.repeat(40)),
      treeRecord('100644', 'SRC', 'b'.repeat(40)),
    ]);
    expect(() => decodePreparationGitTree(bytes, 'sha1')).toThrow('case-colliding');
  });

  test('rejects a truncated object identity and a missing record terminator', () => {
    expect(() =>
      decodePreparationGitTree(treeRecord('100644', 'file', 'a'.repeat(38)), 'sha1')
    ).toThrow('Truncated');
    expect(() => decodePreparationGitTree(Buffer.from('100644 no-nul'), 'sha1')).toThrow(
      'Malformed'
    );
  });

  test('refuses missing, misplaced or duplicate root tree headers', () => {
    const oid = 'a'.repeat(40);
    expect(() => preparationCommitTree(Buffer.from(`tree ${oid}\n`), 'sha1')).toThrow('terminator');
    expect(() =>
      preparationCommitTree(Buffer.from(`author Test\ntree ${oid}\n\nmessage`), 'sha1')
    ).toThrow('one root tree');
    expect(() =>
      preparationCommitTree(Buffer.from(`tree ${oid}\ntree ${oid}\n\nmessage`), 'sha1')
    ).toThrow('one root tree');
  });
});
