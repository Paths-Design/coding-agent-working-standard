const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const children = require('node:child_process');
const staticTooling = require('../../dist/tooling/sqlite-static-build');
const {
  buildNativeSqliteCandidate,
  loadNativeSqliteBuild,
  loadNativeSqliteBuildWithStableEntry,
  nativeSqliteCargoArguments,
  selectNativeSqliteCargoArtifacts,
  verifyNativeSqliteBuildArtifacts,
} = require('../../dist/tooling/native-sqlite-build');

const HEADER_SHA = '919e7f2e8ed1d8f56ac17b412b8971c76aa5d1a879752cc6058f75e7d5910e1d';
const MAX_FILE = 256 * 1024 * 1024;

function sha(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function identity(file) {
  const bytes = fs.readFileSync(file);
  return { path: file, sizeBytes: bytes.length, sha256: sha(bytes) };
}
function treeFile(root, relativePath, text, executable = false) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: executable ? 0o700 : 0o600 });
  return {
    relativePath,
    sizeBytes: Buffer.byteLength(text),
    sha256: sha(Buffer.from(text)),
    executable,
  };
}

/*
 * Negative-only boundary fixtures. These are not SQLite sources, objects,
 * libraries, Cargo crates or candidate executables. The header deliberately
 * cannot satisfy the fixed SQLite pin. Any child invocation fails the test.
 * Host properties are controlled solely to reach request/filesystem checks;
 * this does not qualify execution on a different host.
 */
describe('native SQLite coordinator pre-Cargo refusals and explicit loader binding', () => {
  let root;
  let request;
  let step;
  let spawn;
  let platformDescriptor;
  let archDescriptor;

  function setHost(platform, arch) {
    Object.defineProperty(process, 'platform', {
      ...platformDescriptor,
      value: platform,
    });
    Object.defineProperty(process, 'arch', {
      ...archDescriptor,
      value: arch,
    });
  }
  function requestPath() {
    const file = path.join(root, 'request.json');
    fs.writeFileSync(file, JSON.stringify(request));
    return file;
  }
  function negativeMarker(overrides = {}) {
    fs.mkdirSync(request.outputRoot, { recursive: true, mode: 0o700 });
    const marker = path.join(request.outputRoot, 'native-completed.json');
    const value = {
      schema: 'caws.native_sqlite_build_receipt.v1',
      status: 'completed',
      adoption: 'NOT_ADOPTED',
      outputRoot: request.outputRoot,
      markerPath: marker,
      profile: request.profile,
      requestDigest: sha(Buffer.from(canonical(request))),
      sourceTreeDigest: sha(Buffer.from(canonical(request.source))),
      ...overrides,
    };
    // Deliberately incomplete negative receipt: no candidate is qualified.
    fs.writeFileSync(marker, JSON.stringify(value));
    return marker;
  }
  async function refusal(reason, phase, writerState) {
    const result = await buildNativeSqliteCandidate(request);
    expect(result).toMatchObject({
      schema: 'caws.native_sqlite_build_receipt.v1',
      status: 'failed',
      adoption: 'NOT_ADOPTED',
      phase,
      writerState,
    });
    expect(result.reason).toMatch(reason);
    expect(result.steps).toEqual([]);
    expect(step).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(request.outputRoot, 'native-completed.json'))).toBe(false);
    expect(fs.existsSync(path.join(request.outputRoot, 'native-completed.pending.json'))).toBe(
      false
    );
    return result;
  }

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch');
    setHost('darwin', 'arm64');
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'caws-native-boundary-'));
    const sourceRoot = path.join(root, 'input-source');
    const vendorRoot = path.join(root, 'input-vendor');
    fs.mkdirSync(sourceRoot);
    fs.mkdirSync(vendorRoot);
    const source = {
      root: sourceRoot,
      files: [
        treeFile(sourceRoot, 'Cargo.toml', 'negative source manifest\n'),
        treeFile(sourceRoot, 'Cargo.lock', 'negative lock\n'),
        treeFile(sourceRoot, 'empty', ''),
      ],
    };
    const imageRoot = path.join(root, 'input-service-image');
    fs.mkdirSync(imageRoot);
    const serviceFiles = [
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
    const image = {
      root: imageRoot,
      files: serviceFiles.map((name) => treeFile(imageRoot, name, 'negative embed\n')),
    };
    const clientFile = path.join(root, 'input-service-client');
    fs.writeFileSync(clientFile, 'negative client\n');
    const bindingPath = 'bindgen-bindings/bindgen_3.34.1.rs';
    const vendor = {
      root: vendorRoot,
      files: [
        treeFile(vendorRoot, 'Cargo.toml', 'negative vendor manifest\n'),
        treeFile(vendorRoot, bindingPath, 'negative binding bytes\n'),
      ],
    };
    const tools = {};
    for (const name of ['cargo', 'rustc', 'clang', 'ar', 'nm', 'otool']) {
      const file = path.join(root, `tool-${name}`);
      fs.writeFileSync(file, `not an executable tool: ${name}\n`, { mode: 0o700 });
      tools[name] = identity(file);
    }
    const sdkRoot = path.join(root, 'sdk');
    fs.mkdirSync(sdkRoot);
    fs.writeFileSync(path.join(sdkRoot, 'SDKSettings.json'), '{}\n');
    const prefix = {};
    for (const name of ['archive', 'header', 'object']) {
      const file = path.join(root, `input-${name}`);
      fs.writeFileSync(file, `unauthenticated ${name}\n`);
      prefix[name] = identity(file);
    }
    // Deliberate physical mismatch stops this fixture before archive admission.
    prefix.header.sha256 = HEADER_SHA;
    request = {
      schema: 'caws.native_sqlite_build_request.v1',
      source,
      embedded: { serviceClient: identity(clientFile), serviceImage: image },
      vendors: [{ directory: 'libsqlite3-sys-0.38.2', tree: vendor }],
      prefix,
      binding: {
        directory: 'libsqlite3-sys-0.38.2',
        relativePath: bindingPath,
        sha256: vendor.files[1].sha256,
      },
      tools,
      sdk: { root: sdkRoot, settings: identity(path.join(sdkRoot, 'SDKSettings.json')) },
      outputRoot: path.join(root, 'output'),
      profile: 'debug',
      timeoutMs: 10000,
      maxOutputBytes: 4096,
    };
    step = jest.spyOn(staticTooling, 'runSqliteBuildStep').mockImplementation(() => {
      throw new Error('Unexpected child invocation in negative-only test');
    });
    spawn = jest.spyOn(children, 'spawn');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(process, 'platform', platformDescriptor);
    Object.defineProperty(process, 'arch', archDescriptor);
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('versioned stable-entry Cargo and filesystem boundaries (no Rust build)', () => {
    function version(v2, profile = 'debug') {
      request.profile = profile;
      request.schema = `caws.native_sqlite_build_request.v${v2 ? 2 : 1}`;
      if (v2)
        request.source.files.push(
          treeFile(request.source.root, 'src/installed_entry_main.rs', 'boundary source only\n')
        );
    }
    function records() {
      const target = path.join(
        request.outputRoot,
        'target',
        'aarch64-apple-darwin',
        request.profile
      );
      const manifest = path.join(request.outputRoot, 'source', 'Cargo.toml');
      const binary = (name, kind) => ({
        reason: 'compiler-artifact',
        manifest_path: manifest,
        fresh: false,
        target: {
          name,
          kind: [kind],
          src_path: path.join(request.outputRoot, 'source', 'src', 'installed_entry_main.rs'),
        },
        executable: path.join(target, ...(kind === 'example' ? ['examples'] : []), name),
      });
      return [
        binary('caws-native', 'bin'),
        binary('service-observer', 'example'),
        binary('service-custody-observer', 'example'),
        binary('caws-hook-native', 'bin'),
        {
          reason: 'compiler-artifact',
          manifest_path: path.join(
            request.outputRoot,
            'vendor',
            request.binding.directory,
            'Cargo.toml'
          ),
          fresh: false,
          package_id: 'sqlite-fixture',
          target: { name: 'libsqlite3_sys', kind: ['lib'] },
          filenames: [path.join(target, 'deps', 'libsqlite3_sys-fixture.rlib')],
        },
        {
          reason: 'build-script-executed',
          package_id: 'sqlite-fixture',
          out_dir: path.join(target, 'build', 'sqlite-fixture', 'out'),
        },
      ];
    }
    const encoded = (rows) => Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    function artifacts() {
      const rows = records();
      const selected = selectNativeSqliteCargoArtifacts(request, encoded(rows));
      const files = {
        ...selected,
        runtimeIdentity: path.join(request.outputRoot, 'observed-sqlite-identity.json'),
        cargoMessages: path.join(request.outputRoot, 'cargo-build.stdout'),
      };
      const pins = {};
      for (const [name, file] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
          file,
          name === 'cargoMessages' ? encoded(rows) : Buffer.from(`boundary ${name}\n`),
          {
            mode: ['native', 'observer', 'custodyObserver', 'stableEntry'].includes(name)
              ? 0o700
              : 0o600,
          }
        );
        pins[name] = identity(file);
      }
      return pins;
    }

    test.each([
      ['debug', false],
      ['release', false],
      ['debug', true],
      ['release', true],
    ])('selects exact %s targets for v2=%s', (profile, v2) => {
      version(v2, profile);
      const args = nativeSqliteCargoArguments(request);
      const bins = args.flatMap((arg, i) => (arg === '--bin' ? [args[i + 1]] : []));
      expect(bins).toEqual(v2 ? ['caws-native', 'caws-hook-native'] : ['caws-native']);
      expect(args.includes('--release')).toBe(profile === 'release');
      const selected = selectNativeSqliteCargoArtifacts(request, encoded(records()));
      expect(Object.keys(selected).sort()).toEqual(
        [
          'native',
          'observer',
          'custodyObserver',
          'sysRlib',
          'generatedBinding',
          ...(v2 ? ['stableEntry'] : []),
        ].sort()
      );
      expect(selected.native).toBe(
        path.join(request.outputRoot, 'target', 'aarch64-apple-darwin', profile, 'caws-native')
      );
      if (v2)
        expect(selected.stableEntry).toBe(
          path.join(
            request.outputRoot,
            'target',
            'aarch64-apple-darwin',
            profile,
            'caws-hook-native'
          )
        );
      const pins = artifacts();
      const schema = `caws.native_sqlite_build_receipt.v${v2 ? 2 : 1}`;
      expect(() => verifyNativeSqliteBuildArtifacts(request, schema, pins)).not.toThrow();
      expect(step).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });

    test.each([
      ['missing', (rows) => rows.splice(3, 1), /unique Cargo record: caws-hook-native/],
      ['duplicate', (rows) => rows.push({ ...rows[3] }), /unique Cargo record: caws-hook-native/],
      [
        'cached',
        (rows) => {
          rows[3].fresh = true;
        },
        /cached Cargo artifact/,
      ],
      [
        'wrong manifest',
        (rows) => {
          rows[3].manifest_path = path.join(root, 'foreign', 'Cargo.toml');
        },
        /source\/target mismatch/,
      ],
      [
        'wrong source',
        (rows) => {
          rows[3].target.src_path = path.join(request.outputRoot, 'source', 'src', 'main.rs');
        },
        /source\/target mismatch/,
      ],
      [
        'wrong kind',
        (rows) => {
          rows[3].target.kind = ['example'];
        },
        /source\/target mismatch/,
      ],
      [
        'mixed kind',
        (rows) => {
          rows[3].target.kind = ['bin', 'example'];
        },
        /source\/target mismatch/,
      ],
      [
        'wrong name',
        (rows) => {
          rows[3].target.name = 'unreviewed-entry';
        },
        /unique Cargo record/,
      ],
      [
        'wrong profile',
        (rows) => {
          rows[3].executable = rows[3].executable.replace('/debug/', '/release/');
        },
        /Unexpected executable location/,
      ],
      [
        'escaped target',
        (rows) => {
          rows[3].executable = path.join(root, 'foreign-entry');
        },
        /escaped fresh target/,
      ],
      [
        'missing executable',
        (rows) => {
          rows[3].executable = null;
        },
        /artifact path missing/,
      ],
      [
        'unbound extra record',
        (rows) =>
          rows.push({ ...rows[3], manifest_path: path.join(root, 'foreign', 'Cargo.toml') }),
        /unique Cargo record/,
      ],
    ])('refuses %s stable Cargo identity', (_name, change, expected) => {
      version(true);
      const rows = records();
      change(rows);
      expect(() => selectNativeSqliteCargoArtifacts(request, encoded(rows))).toThrow(expected);
      expect(fs.existsSync(request.outputRoot)).toBe(false);
    });

    test.each([
      'changed bytes',
      'nonexecutable',
      'symlink',
      'wrong pin path',
      'missing pin',
      'extra pin',
      'modified Cargo records',
    ])('refuses %s at the real filesystem boundary', (change) => {
      version(true);
      const pins = artifacts();
      if (change === 'changed bytes') fs.appendFileSync(pins.stableEntry.path, 'tampered');
      if (change === 'nonexecutable') fs.chmodSync(pins.stableEntry.path, 0o600);
      if (change === 'symlink') {
        const file = pins.stableEntry.path;
        fs.renameSync(file, `${file}-held`);
        fs.symlinkSync(`${file}-held`, file);
      }
      if (change === 'wrong pin path') pins.stableEntry = pins.native;
      if (change === 'missing pin') delete pins.stableEntry;
      if (change === 'extra pin') pins.unreviewed = pins.native;
      if (change === 'modified Cargo records') fs.appendFileSync(pins.cargoMessages.path, '{}\n');
      expect(() =>
        verifyNativeSqliteBuildArtifacts(request, 'caws.native_sqlite_build_receipt.v2', pins)
      ).toThrow(
        /Pin mismatch|mode changed|ELOOP|EMLINK|Artifact path mismatch|Unexpected object shape/
      );
    });

    test('v1 neither receives nor grants a stable-entry pin', () => {
      version(false);
      const pins = artifacts();
      pins.stableEntry = pins.native;
      expect(() =>
        verifyNativeSqliteBuildArtifacts(request, 'caws.native_sqlite_build_receipt.v1', pins)
      ).toThrow('Unexpected object shape');
      expect(() => loadNativeSqliteBuildWithStableEntry(requestPath())).toThrow(
        'requires native build request v2'
      );
    });

    test.each([
      [false, 2],
      [true, 1],
    ])('refuses request/receipt downgrade v2=%s receipt=%s', (v2, receiptVersion) => {
      version(v2);
      negativeMarker({ schema: `caws.native_sqlite_build_receipt.v${receiptVersion}` });
      expect(() => loadNativeSqliteBuild(requestPath())).toThrow(
        'Completion receipt/request mismatch'
      );
    });

    test('v2 requires reviewed stable-entry source before mutation', async () => {
      request.schema = 'caws.native_sqlite_build_request.v2';
      const result = await buildNativeSqliteCandidate(request);
      expect(result).toMatchObject({
        status: 'failed',
        phase: 'request',
        writerState: 'NOT_STARTED',
        reason: 'Stable hook entry source missing from reviewed tree',
      });
      expect(fs.existsSync(request.outputRoot)).toBe(false);
      expect(step).not.toHaveBeenCalled();
    });
  });

  test('copies empty files but refuses unauthenticated header before Cargo', async () => {
    const result = await refusal(
      /Pin mismatch:.*input-header/,
      'input-staging',
      'RETAINED_UNCERTAIN'
    );
    const empty = path.join(request.outputRoot, 'source', 'empty');
    expect(fs.statSync(empty).size).toBe(0);
    expect(fs.readFileSync(empty)).toEqual(Buffer.alloc(0));
    expect(result.failureReceiptPath).toBe(path.join(request.outputRoot, 'native-failed.json'));
    const retained = JSON.parse(fs.readFileSync(result.failureReceiptPath, 'utf8'));
    expect(retained.status).toBe('failed');
    expect(retained.reason).toBe(result.reason);
    expect(retained.adoption).toBe('NOT_ADOPTED');
  });

  test.each([
    ['schema', 'wrong', /Request schema mismatch/],
    ['profile', 'optimized', /Invalid profile/],
    ['timeoutMs', 0, /timeoutMs/],
    ['timeoutMs', 600001, /timeoutMs/],
    ['maxOutputBytes', 0, /Invalid output bound/],
    ['maxOutputBytes', 16777217, /Invalid output bound/],
  ])('rejects invalid %s=%s without creating output', async (key, value, reason) => {
    request[key] = value;
    const result = await refusal(reason, 'request', 'NOT_STARTED');
    expect(result.failureReceiptPath).toBeNull();
    expect(fs.existsSync(request.outputRoot)).toBe(false);
  });

  test('refuses unsupported actual host selection before filesystem mutation', async () => {
    setHost('darwin', 'x64');
    await refusal(/Requires arm64 macOS host/, 'request', 'NOT_STARTED');
    expect(fs.existsSync(request.outputRoot)).toBe(false);
  });

  test.each(['../escape', '/absolute', 'a/../b', 'a\\b', 'x\0y'])(
    'refuses nonnormalized relative path %j',
    async (relativePath) => {
      request.source.files[0].relativePath = relativePath;
      await refusal(/normalized relative/, 'request', 'NOT_STARTED');
    }
  );

  test('refuses duplicate paths and file/directory collisions', async () => {
    request.source.files.push({ ...request.source.files[0] });
    await refusal(/Duplicate relative/, 'request', 'NOT_STARTED');
    request.source.files.pop();
    request.source.files.push({
      ...request.source.files[0],
      relativePath: 'Cargo.toml/child',
    });
    await refusal(/File\/directory inventory collision/, 'request', 'NOT_STARTED');
  });

  test('refuses duplicate vendor names', async () => {
    request.vendors.push(JSON.parse(JSON.stringify(request.vendors[0])));
    await refusal(/duplicate vendor directory/, 'request', 'NOT_STARTED');
  });

  test('refuses output/input collision', async () => {
    request.outputRoot = request.source.root;
    await refusal(/Output\/input tree collision/, 'request', 'NOT_STARTED');
    expect(fs.readFileSync(path.join(request.source.root, 'Cargo.toml'), 'utf8')).toBe(
      'negative source manifest\n'
    );
  });

  test('enforces per-file and cumulative byte budgets from metadata', async () => {
    request.source.files[0].sizeBytes = MAX_FILE + 1;
    await refusal(/Invalid bounded file size/, 'request', 'NOT_STARTED');
    request.source.files[0].sizeBytes = MAX_FILE;
    request.source.files[1].sizeBytes = MAX_FILE;
    await refusal(/Input inventory budget exceeded/, 'request', 'NOT_STARTED');
  });

  test.each(['.cargo/config', '.cargo/config.toml'])(
    'refuses reviewed source configuration %s',
    async (relativePath) => {
      request.source.files.push({
        relativePath,
        sizeBytes: 0,
        sha256: sha(Buffer.alloc(0)),
        executable: false,
      });
      await refusal(/Source Cargo configuration refused/, 'request', 'NOT_STARTED');
    }
  );

  test('refuses inventoried target files', async () => {
    request.source.files.push({
      relativePath: 'target/cache',
      sizeBytes: 0,
      sha256: sha(Buffer.alloc(0)),
      executable: false,
    });
    await refusal(/target must not be inventoried/, 'request', 'NOT_STARTED');
  });

  test.each(['config', 'config.toml'])('refuses output ancestor .cargo/%s', async (name) => {
    const cargo = path.join(root, '.cargo');
    fs.mkdirSync(cargo);
    const file = path.join(cargo, name);
    fs.writeFileSync(file, 'foreign configuration\n');
    await refusal(/Cargo ancestor configuration refused/, 'output-root', 'NOT_STARTED');
    expect(fs.readFileSync(file, 'utf8')).toBe('foreign configuration\n');
    expect(fs.existsSync(request.outputRoot)).toBe(false);
  });

  test('preserves a preexisting output root', async () => {
    fs.mkdirSync(request.outputRoot);
    const sentinel = path.join(request.outputRoot, 'owner');
    fs.writeFileSync(sentinel, 'foreign bytes\n');
    await refusal(/EEXIST/, 'output-root', 'NOT_STARTED');
    expect(fs.readdirSync(request.outputRoot)).toEqual(['owner']);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('foreign bytes\n');
  });

  test('refuses a symlink output root without touching its target', async () => {
    const target = path.join(root, 'foreign');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'owner'), 'preserve');
    fs.symlinkSync(target, request.outputRoot);
    await refusal(/EEXIST/, 'output-root', 'NOT_STARTED');
    expect(fs.readdirSync(target)).toEqual(['owner']);
  });

  test.each(['source', 'vendor'])('refuses an unlisted %s file', async (which) => {
    const tree = which === 'source' ? request.source : request.vendors[0].tree;
    fs.writeFileSync(path.join(tree.root, 'unexpected'), 'unreviewed');
    await refusal(/Unexpected tree entry/, 'input-staging', 'RETAINED_UNCERTAIN');
  });

  test.each(['source', 'vendor'])('refuses a missing reviewed %s file', async (which) => {
    const tree = which === 'source' ? request.source : request.vendors[0].tree;
    fs.unlinkSync(path.join(tree.root, tree.files[0].relativePath));
    await refusal(/Reviewed tree files missing/, 'input-staging', 'RETAINED_UNCERTAIN');
  });

  test('refuses an unrepresented empty directory', async () => {
    fs.mkdirSync(path.join(request.source.root, 'empty-directory'));
    await refusal(/Unrepresented directory/, 'input-staging', 'RETAINED_UNCERTAIN');
  });

  test('refuses source symlinks and executable mode disagreement', async () => {
    const file = path.join(request.source.root, 'empty');
    fs.unlinkSync(file);
    fs.symlinkSync(path.join(request.source.root, 'Cargo.lock'), file);
    await refusal(/Symlink tree entry refused/, 'input-staging', 'RETAINED_UNCERTAIN');
  });

  test('refuses changed source executable mode', async () => {
    fs.chmodSync(path.join(request.source.root, 'empty'), 0o700);
    await refusal(/Executable mode mismatch/, 'input-staging', 'RETAINED_UNCERTAIN');
  });

  test('excludes a real source target, but does not follow a target symlink', async () => {
    const target = path.join(request.source.root, 'target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'ignored-cache'), 'unreviewed cache');
    await refusal(/Pin mismatch:.*input-header/, 'input-staging', 'RETAINED_UNCERTAIN');
    expect(fs.existsSync(path.join(request.outputRoot, 'source', 'target'))).toBe(false);
  });

  test('refuses a symlink source target', async () => {
    fs.symlinkSync(request.vendors[0].tree.root, path.join(request.source.root, 'target'));
    await refusal(/Symlink tree entry refused/, 'input-staging', 'RETAINED_UNCERTAIN');
  });

  test('refuses incomplete embedded service inventory before Cargo', async () => {
    request.embedded.serviceImage.files.pop();
    await refusal(/Embedded service-image inventory mismatch/, 'request', 'NOT_STARTED');
  });
  test('refuses changed embedded client bytes before Cargo', async () => {
    fs.writeFileSync(request.embedded.serviceClient.path, 'changed client bytes');
    await refusal(/Pin mismatch|Not a bounded regular file/, 'input-staging', 'RETAINED_UNCERTAIN');
  });
  test('refuses unreviewed embedded image files before Cargo', async () => {
    fs.writeFileSync(path.join(request.embedded.serviceImage.root, 'unexpected'), 'unknown');
    await refusal(/Unexpected tree entry/, 'input-staging', 'RETAINED_UNCERTAIN');
  });
  test('an already aborted request creates no root', async () => {
    const controller = new globalThis.AbortController();
    controller.abort();
    const result = await buildNativeSqliteCandidate(request, { signal: controller.signal });
    expect(result).toMatchObject({
      status: 'failed',
      phase: 'request',
      writerState: 'NOT_STARTED',
      reason: 'Native build aborted',
    });
    expect(step).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(request.outputRoot)).toBe(false);
  });

  test.each([
    ['schema', 'wrong'],
    ['status', 'failed'],
    ['adoption', 'ADOPTED'],
    ['profile', 'release'],
    ['requestDigest', '0'.repeat(64)],
    ['outputRoot', '/not-the-requested-root'],
    ['markerPath', '/not-the-requested-receipt'],
  ])('loader refuses mismatching receipt %s', (key, value) => {
    negativeMarker({ [key]: value });
    expect(() => loadNativeSqliteBuild(requestPath())).toThrow(
      'Completion receipt/request mismatch'
    );
    expect(step).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  test('loader refuses a source digest mismatch before using artifact paths', () => {
    negativeMarker({ sourceTreeDigest: '0'.repeat(64) });
    expect(() => loadNativeSqliteBuild(requestPath())).toThrow('Source tree digest mismatch');
    expect(step).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  test('loader requires an explicit request path and never falls back to target', () => {
    const conventional = path.join(root, 'target', 'debug');
    fs.mkdirSync(conventional, { recursive: true });
    fs.writeFileSync(path.join(conventional, 'caws-native'), 'not an executable candidate');
    expect(() => loadNativeSqliteBuild(undefined)).toThrow('normalized absolute path');
    expect(() => loadNativeSqliteBuild('')).toThrow('normalized absolute path');
    expect(step).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  test('loader refuses a missing completion receipt', () => {
    fs.mkdirSync(request.outputRoot);
    expect(() => loadNativeSqliteBuild(requestPath())).toThrow(/ENOENT/);
  });

  test('loader refuses symlink requests and completion markers', () => {
    const realRequest = requestPath();
    const link = path.join(root, 'request-link');
    fs.symlinkSync(realRequest, link);
    expect(() => loadNativeSqliteBuild(link)).toThrow(/ELOOP|EMLINK/);
    fs.mkdirSync(request.outputRoot);
    fs.symlinkSync(realRequest, path.join(request.outputRoot, 'native-completed.json'));
    expect(() => loadNativeSqliteBuild(realRequest)).toThrow(/ELOOP|EMLINK/);
  });

  test('loader rejects oversized metadata before reading its body', () => {
    const marker = negativeMarker({ profile: 'release' });
    fs.truncateSync(marker, 16 * 1024 * 1024 + 1);
    expect(() => loadNativeSqliteBuild(requestPath())).toThrow(/Not a bounded regular file/);
  });

  test('loader strictly decodes request UTF-8', () => {
    const file = path.join(root, 'invalid-request.json');
    fs.writeFileSync(file, Buffer.from([0xff]));
    expect(() => loadNativeSqliteBuild(file)).toThrow(/not valid for encoding utf-8/);
  });
});
