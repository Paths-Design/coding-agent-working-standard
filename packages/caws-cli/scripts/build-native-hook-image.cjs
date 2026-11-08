'use strict';

// Reproduce the reviewed macOS arm64 qualification inputs inside the repository.
// This driver builds private artifacts; it neither installs nor activates them.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { TextDecoder } = require('node:util');

let driver;
let base;
let inputs;
let archive;
let source;
let expectedNativeRequestSha;
const archiveSha = '1e71ddf93849c6a6ecf58b827c0692073d2dd7ee40196158068f7b29f422e87d';
const cSha3 = '67f423e9ebbbdc473cbc4772c872ee6b89f31fde4ed0279a5c25d5f65c043a16';
const headerSha = '919e7f2e8ed1d8f56ac17b412b8971c76aa5d1a879752cc6058f75e7d5910e1d';
const nodeSha = '2cc28a1880d0774616959f2210ee739bffa6ac695c887e8988a496a21271f6c0';
const digest = (bytes, algorithm = 'sha256') =>
  crypto.createHash(algorithm).update(bytes).digest('hex');
const controller = new globalThis.AbortController();
const abort = () => controller.abort();

const driverCustody = require('../dist/tooling/native-sqlite-build').nativeSqlitePreparationCustody;
const driverPackage = path.resolve(__dirname, '..');
const publicRoot = path.join(driverPackage, 'reports/release-rc3');
const nativeRoot = path.join(publicRoot, 'native');

function exactFields(value, names, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), label);
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), label);
}
function absoluteName(value, label) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 4096, label);
  assert(
    [...value].every((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && !(code >= 127 && code <= 159);
    }),
    label
  );
  assert(path.isAbsolute(value) && path.resolve(value) === value, label);
  return value;
}
function beneath(root, file) {
  const relative = path.relative(root, file);
  return (
    relative !== '' &&
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep)
  );
}
function checkedPin(value, label) {
  exactFields(value, ['path', 'sizeBytes', 'sha256'], label);
  absoluteName(value.path, label);
  assert(beneath(publicRoot, value.path), label + ' must be a public retained input');
  assert(
    Number.isSafeInteger(value.sizeBytes) &&
      value.sizeBytes > 0 &&
      value.sizeBytes <= 256 * 1024 * 1024,
    label
  );
  assert(typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256), label);
  driverCustody.realDirectories(path.dirname(value.path));
  driverCustody.verifyFile(value);
}
function parseDriverArguments(argv) {
  const [phase, ...words] = argv;
  assert(['cli', 'sqlite', 'prepare-native', 'native', 'image'].includes(phase), 'Unknown phase');
  assert.equal(words.length % 2, 0, 'Expected option/value pairs');
  const options = new Map();
  for (let index = 0; index < words.length; index += 2) {
    const name = words[index];
    assert(
      ['--request', '--request-sha256', '--native-request-sha256'].includes(name),
      'Unknown option: ' + name
    );
    assert(!options.has(name), 'Duplicate option: ' + name);
    options.set(name, words[index + 1]);
  }
  assert(
    options.has('--request') && options.has('--request-sha256'),
    'Required driver request and pin'
  );
  const needsNative = phase === 'native' || phase === 'image';
  assert.equal(
    options.has('--native-request-sha256'),
    needsNative,
    'Native/image require their actual native request pin'
  );
  for (const name of ['--request-sha256', ...(needsNative ? ['--native-request-sha256'] : [])])
    assert(/^[a-f0-9]{64}$/.test(options.get(name)), 'Invalid SHA256: ' + name);
  return { phase, options };
}
function admitDriver(phase, options) {
  const requestPath = absoluteName(options.get('--request'), 'Driver request path');
  assert(beneath(publicRoot, requestPath), 'Driver request must be public');
  driverCustody.realDirectories(path.dirname(requestPath));
  const bytes = driverCustody.readBounded(requestPath, 65536);
  assert.equal(digest(bytes), options.get('--request-sha256'), 'Driver request pin mismatch');
  const request = JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  );
  exactFields(
    request,
    [
      'schema',
      'outputRoot',
      'sourceCommit',
      'profile',
      'sqliteArchive',
      'node',
      'vendorRoot',
      ...(request.schema === 'caws.native-hook-driver-request.v2' ? ['cliTarball'] : []),
    ],
    'Driver request fields'
  );
  assert(
    ['caws.native-hook-driver-request.v1', 'caws.native-hook-driver-request.v2'].includes(
      request.schema
    )
  );
  assert(/^[a-f0-9]{40}$/.test(request.sourceCommit), 'Expected committed source SHA');
  assert(['debug', 'release'].includes(request.profile), 'Select profile explicitly');
  absoluteName(request.outputRoot, 'Output root');
  assert(beneath(nativeRoot, request.outputRoot), 'Output must be under public native reports');
  driverCustody.realDirectories(path.dirname(request.outputRoot));
  for (const [name, value] of [
    ['SQLite archive', request.sqliteArchive],
    ['Node', request.node],
    ...(request.schema === 'caws.native-hook-driver-request.v2'
      ? [['CLI tarball', request.cliTarball]]
      : []),
  ]) {
    checkedPin(value, name);
    assert(!beneath(request.outputRoot, value.path), 'Input lies inside fresh output');
  }
  assert.equal(request.sqliteArchive.sha256, archiveSha, 'Unsupported SQLite archive');
  assert.equal(request.node.sha256, nodeSha, 'Unsupported retained Node');
  assert.equal(
    fs.realpathSync(process.execPath),
    request.node.path,
    'Run with the explicitly selected retained Node'
  );
  absoluteName(request.vendorRoot, 'Vendor root');
  assert(beneath(publicRoot, request.vendorRoot), 'Vendor root must be public');
  assert(
    !beneath(request.outputRoot, request.vendorRoot) && request.vendorRoot !== request.outputRoot,
    'Vendor root must be external input'
  );
  driverCustody.realDirectories(request.vendorRoot);
  const saved = path.join(request.outputRoot, 'driver-request.json');
  if (phase === 'cli') {
    controller.signal.throwIfAborted();
    fs.mkdirSync(request.outputRoot, { mode: 0o700 });
    driverCustody.realDirectories(request.outputRoot);
    fs.writeFileSync(saved, bytes, { flag: 'wx', mode: 0o600 });
    fs.mkdirSync(path.join(request.outputRoot, 'inputs'), { mode: 0o700 });
  } else {
    driverCustody.realDirectories(request.outputRoot);
    assert(
      driverCustody.readBounded(saved, 65536).equals(bytes),
      'Selected driver request differs from first phase'
    );
  }
  driver = request;
  base = request.outputRoot;
  inputs = path.join(base, 'inputs');
  archive = request.sqliteArchive.path;
  source = path.join(inputs, 'sqlite-amalgamation-3530400');
  expectedNativeRequestSha = options.get('--native-request-sha256');
  if (phase !== 'cli') loadCliPack();
  if (expectedNativeRequestSha !== undefined) {
    const { readNativeSqliteBuildRequest } = require('../dist/tooling/native-sqlite-build');
    const selected = readNativeSqliteBuildRequest(path.join(base, 'native-build.request.json'));
    assert.equal(
      selected.requestFile.sha256,
      expectedNativeRequestSha,
      'Selected native request pin mismatch'
    );
    assert.equal(selected.request.outputRoot, path.join(base, 'native-output'));
    assert.equal(selected.request.source.root, path.join(inputs, 'native-source'));
    assert.equal(selected.request.profile, driver.profile);
  }
}

function observeCommittedSource(repo, commit, scopes, closedRoots) {
  assert(/^[a-f0-9]{40}$/.test(commit), 'Expected source commit');
  driverCustody.realDirectories(repo);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  env.GIT_OPTIONAL_LOCKS = '0';
  const git = (...args) =>
    execFileSync('/usr/bin/git', args, {
      cwd: repo,
      env,
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
    });
  assert.equal(git('rev-parse', '--show-toplevel').toString('utf8').trim(), repo);
  assert.equal(git('rev-parse', '--show-object-format').toString('utf8').trim(), 'sha1');
  assert.equal(
    git('rev-parse', 'HEAD').toString('utf8').trim(),
    commit,
    'Source HEAD differs from selected commit'
  );
  assert.equal(
    git('status', '--porcelain=v1', '-z', '--untracked-files=no', '--', ...scopes).length,
    0,
    'Committed build inputs must be clean'
  );
  assert.equal(
    git('ls-files', '--others', '--exclude-standard', '-z', '--', ...scopes).length,
    0,
    'Additional public build input'
  );
  const tree = git('ls-tree', '-rz', '--full-tree', commit, '--', ...scopes);
  const text = tree.toString('utf8');
  assert(Buffer.from(text).equals(tree) && text.endsWith('\0'), 'Expected framed UTF-8 Git tree');
  const rows = text.slice(0, -1).split('\0');
  assert(rows.length <= 50000, 'Committed build input count exceeds bound');
  const files = new Set();
  let packageFiles;
  let total = 0;
  for (const row of rows) {
    controller.signal.throwIfAborted();
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(row);
    assert(match, 'Unsupported committed build input');
    const [, mode, object, relative] = match;
    assert(!files.has(relative), 'Duplicate committed build input');
    files.add(relative);
    const file = path.join(repo, relative);
    assert(beneath(repo, file) && !relative.includes('\\'), 'Build input escaped repository');
    driverCustody.realDirectories(path.dirname(file));
    const stat = fs.lstatSync(file);
    assert(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        Number.isSafeInteger(stat.size) &&
        stat.size >= 0 &&
        stat.size <= 256 * 1024 * 1024,
      'Committed build input exceeds per-file bound'
    );
    total += stat.size;
    assert(total <= 512 * 1024 * 1024, 'Committed build inputs exceed byte bound');
    const observed = driverCustody.fileIdentity(file, stat.size);
    assert.equal(observed.sizeBytes, stat.size, 'Committed build input size changed');
    const bytes = driverCustody.verifyFile(observed);
    assert.equal(
      crypto
        .createHash('sha1')
        .update(Buffer.from(`blob ${bytes.length}\0`))
        .update(bytes)
        .digest('hex'),
      object,
      'Build input differs from committed blob: ' + relative
    );
    if (relative === 'packages/caws-cli/package.json') packageFiles = JSON.parse(bytes).files;
    assert.equal(
      (fs.lstatSync(file).mode & 0o111) !== 0,
      mode === '100755',
      'Build input mode differs: ' + relative
    );
  }
  let visited = 0;
  function closed(directory, depth = 0) {
    controller.signal.throwIfAborted();
    assert(depth <= 128, 'Public build input traversal exceeds depth bound');
    driverCustody.realDirectories(directory);
    const handle = fs.opendirSync(directory);
    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        controller.signal.throwIfAborted();
        assert(++visited <= 100000, 'Public build input traversal exceeds count bound');
        const file = path.join(directory, entry.name);
        const relative = path.relative(repo, file);
        // These caches are neither Node build inputs nor package members. Keep
        // this exclusion tied to the committed pack manifest and check the actual
        // resulting member list below; other ignored source files still refuse.
        if (
          relative.startsWith('packages/caws-cli/templates/hook-packs/') &&
          (relative.split(path.sep).includes('__pycache__') || /\.py[co]$/.test(relative))
        ) {
          for (const rule of [
            '!templates/hook-packs/**/__pycache__/**',
            '!templates/hook-packs/**/*.pyc',
            '!templates/hook-packs/**/*.pyo',
          ])
            assert(
              Array.isArray(packageFiles) && packageFiles.includes(rule),
              'Bytecode exclusion differs from committed package contract'
            );
          continue;
        }
        const stat = fs.lstatSync(file);
        assert(!stat.isSymbolicLink(), 'Symlink in public build inputs');
        if (stat.isDirectory()) closed(file, depth + 1);
        else
          assert(
            stat.isFile() && files.has(path.relative(repo, file)),
            'Uncommitted public build input: ' + file
          );
      }
    } finally {
      handle.closeSync();
    }
  }
  for (const relative of closedRoots) {
    const directory = path.join(repo, relative);
    assert(beneath(repo, directory), 'Closed build root escaped repository');
    if (fs.existsSync(directory)) closed(directory);
  }
  assert.equal(git('rev-parse', 'HEAD').toString('utf8').trim(), commit, 'Source HEAD changed');
  return { sourceCommit: commit, treeSha256: digest(tree), files: files.size, sizeBytes: total };
}
function committedBuildInputs() {
  return observeCommittedSource(
    path.resolve(driverPackage, '../..'),
    driver.sourceCommit,
    [
      'packages/caws-cli',
      'packages/caws-native',
      'docs',
      'scripts',
      'package.json',
      'package-lock.json',
      'turbo.json',
      'LICENSE',
    ],
    [
      'packages/caws-cli/src',
      'packages/caws-cli/scripts',
      'packages/caws-cli/templates',
      'docs',
      'scripts',
    ]
  );
}
function npmInputs() {
  const node = driver.node;
  checkedPin(node, 'Node');
  const npm = pin(path.resolve(path.dirname(node.path), '../lib/node_modules/npm/bin/npm-cli.js'));
  return { node, npm };
}
function npmEnvironment(root = base, nodePath = driver.node.path) {
  const home = path.join(root, 'npm-home');
  const config = path.join(root, 'npm-userconfig');
  const globalConfig = path.join(root, 'npm-globalconfig');
  driverCustody.realDirectories(home);
  assert.equal(driverCustody.readBounded(config, 1024).length, 0, 'Unexpected npm configuration');
  assert.equal(
    driverCustody.readBounded(globalConfig, 1024).length,
    0,
    'Unexpected global npm configuration'
  );
  return {
    PATH: path.dirname(nodePath) + ':/usr/bin:/bin',
    HOME: home,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    NPM_CONFIG_USERCONFIG: config,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
    NPM_CONFIG_CACHE: path.join(root, 'npm-cache'),
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
}
async function npmStep(label, args) {
  const prefixIndex = args.indexOf('--prefix');
  assert(
    prefixIndex >= 0 && args.indexOf('--prefix', prefixIndex + 1) === -1,
    'npm step requires one explicit project prefix'
  );
  assertNoNpmProjectConfig(args[prefixIndex + 1]);
  const tools = npmInputs();
  const { runSqliteBuildStep } = require('../dist/tooling/sqlite-static-build');
  const receipt = await runSqliteBuildStep({
    label,
    executable: tools.node.path,
    args: [tools.npm.path, ...args],
    cwd: base,
    env: npmEnvironment(),
    deadline: Date.now() + 600000,
    maxOutputBytes: 4194304,
    signal: controller.signal,
  });
  save(label + '.json', { tools, receipt });
  assertNoNpmProjectConfig(args[prefixIndex + 1]);
  driverCustody.verifyFile(tools.node);
  driverCustody.verifyFile(tools.npm);
  assert(
    receipt.exitCode === 0 &&
      receipt.signal === null &&
      receipt.directChildReaped &&
      receipt.stopReason === null &&
      receipt.persistenceError === null &&
      receipt.error === null,
    'npm step failed; retained outcome, no descendant-settlement claim: ' + label
  );
  return { tools, receipt };
}
function assertNoNpmProjectConfig(prefix) {
  absoluteName(prefix, 'npm project prefix');
  driverCustody.realDirectories(prefix);
  try {
    fs.lstatSync(path.join(prefix, '.npmrc'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Project npm configuration requires explicit qualification');
}
async function cli() {
  const before = committedBuildInputs();
  fs.mkdirSync(path.join(base, 'npm-home'), { mode: 0o700 });
  fs.writeFileSync(path.join(base, 'npm-userconfig'), '', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(base, 'npm-globalconfig'), '', { flag: 'wx', mode: 0o600 });
  const packageRoot = path.join(base, 'cli-package');
  fs.mkdirSync(packageRoot, { mode: 0o700 });
  const compiler = pin(require.resolve('typescript/bin/tsc', { paths: [driverPackage] }));
  await npmStep('cli-build', ['--prefix', driverPackage, '--workspaces=false', 'run', 'build']);
  driverCustody.verifyFile(compiler);
  if (driver.schema === 'caws.native-hook-driver-request.v2') {
    driverCustody.verifyFile(driver.cliTarball);
    assert.deepEqual(committedBuildInputs(), before, 'Committed inputs changed during build');
    save('cli-pack.result.json', {
      schema: 'caws.native-hook-cli-selection.v2',
      status: 'completed',
      source: before,
      compiler,
      tarball: driver.cliTarball,
      build: pin(path.join(base, 'cli-build.json')),
      boundary:
        'Selected tar bytes and maintained source build observed separately; their source-to-tar equivalence is not established.',
    });
    console.log(
      JSON.stringify({
        phase: 'cli',
        status: 'completed',
        sourceCommit: driver.sourceCommit,
        tarball: driver.cliTarball,
      })
    );
    return;
  }
  const packed = await npmStep('cli-pack', [
    '--prefix',
    driverPackage,
    'pack',
    driverPackage,
    '--json',
    '--workspaces=false',
    '--pack-destination',
    packageRoot,
  ]);
  const result = JSON.parse(Buffer.from(packed.receipt.stdoutBase64, 'base64').toString('utf8'));
  assert(Array.isArray(result) && result.length === 1, 'Expected one packed CLI artifact');
  const name = result[0].filename;
  assert(
    typeof name === 'string' && /^[A-Za-z0-9_.-]+\.tgz$/.test(name),
    'Unsafe package filename'
  );
  assert.equal(result[0].name, '@paths.design/caws-cli');
  assert(
    Array.isArray(result[0].files) &&
      result[0].files.every(
        (file) =>
          typeof file.path === 'string' && !/(?:^|\/)__pycache__\/|\.py[co]$/.test(file.path)
      ),
    'Packed CLI includes Python bytecode'
  );
  const tarball = pin(path.join(packageRoot, name));
  verifyPackedCliResult(result, tarball);
  assert.deepEqual(committedBuildInputs(), before, 'Committed inputs changed during build/pack');
  save('cli-pack.result.json', {
    schema: 'caws.native-hook-cli-pack.v1',
    status: 'completed',
    source: before,
    compiler,
    tarball,
    build: pin(path.join(base, 'cli-build.json')),
    pack: pin(path.join(base, 'cli-pack.json')),
    boundary:
      'Fresh maintained build and pack with committed input readback; not compiler reproducibility, dependency authenticity, or native acceptance.',
  });
  console.log(
    JSON.stringify({
      phase: 'cli',
      status: 'completed',
      sourceCommit: driver.sourceCommit,
      tarball,
    })
  );
}
function verifyPackedCliResult(result, tarball) {
  assert(Array.isArray(result) && result.length === 1, 'Expected one packed CLI artifact');
  assert.equal(result[0].name, '@paths.design/caws-cli');
  assert.equal(result[0].filename, path.basename(tarball.path), 'Packed artifact filename differs');
  assert.equal(result[0].size, tarball.sizeBytes, 'Packed artifact size differs');
  const bytes = driverCustody.verifyFile(tarball);
  assert.equal(result[0].shasum, digest(bytes, 'sha1'), 'Packed artifact SHA1 differs');
  assert.equal(
    result[0].integrity,
    'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64'),
    'Packed artifact integrity differs'
  );
}
function verifySelectedTarballLock(lock, prefixRoot, tarball) {
  const selected = lock.packages?.['node_modules/@paths.design/caws-cli'];
  assert(
    selected && typeof selected.resolved === 'string' && selected.resolved.startsWith('file:'),
    'Selected CLI lock source missing'
  );
  assert.equal(
    fs.realpathSync(path.resolve(prefixRoot, selected.resolved.slice(5))),
    tarball.path,
    'CLI lock source differs'
  );
  const bytes = driverCustody.verifyFile(tarball);
  assert.equal(
    selected.integrity,
    'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64'),
    'CLI lock integrity differs'
  );
}
function loadCliPack() {
  const result = JSON.parse(
    driverCustody.readBounded(path.join(base, 'cli-pack.result.json'), 65536).toString('utf8')
  );
  const selection = result.schema === 'caws.native-hook-cli-selection.v2';
  exactFields(
    result,
    [
      'schema',
      'status',
      'source',
      'compiler',
      'tarball',
      'build',
      ...(selection ? [] : ['pack']),
      'boundary',
    ],
    'CLI pack result fields'
  );
  assert.equal(
    result.schema,
    driver.schema === 'caws.native-hook-driver-request.v2'
      ? 'caws.native-hook-cli-selection.v2'
      : 'caws.native-hook-cli-pack.v1'
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.source.sourceCommit, driver.sourceCommit, 'CLI pack source differs');
  if (selection) assert.deepEqual(result.tarball, driver.cliTarball, 'Selected tarball differs');
  else
    assert(
      beneath(path.join(base, 'cli-package'), result.tarball.path),
      'CLI tarball escaped retained pack'
    );
  checkedPin(result.tarball, 'CLI tarball');
  for (const [label, pinValue] of [
    ['cli-build', result.build],
    ...(selection ? [] : [['cli-pack', result.pack]]),
  ]) {
    assert.equal(pinValue.path, path.join(base, label + '.json'));
    const record = JSON.parse(driverCustody.verifyFile(pinValue).toString('utf8'));
    assert.deepEqual(record.tools, npmInputs(), 'CLI producer tool identity differs');
    const step = record.receipt;
    const args =
      label === 'cli-build'
        ? ['--prefix', driverPackage, '--workspaces=false', 'run', 'build']
        : [
            '--prefix',
            driverPackage,
            'pack',
            driverPackage,
            '--json',
            '--workspaces=false',
            '--pack-destination',
            path.join(base, 'cli-package'),
          ];
    assert.deepEqual(
      step.argv,
      [record.tools.node.path, record.tools.npm.path, ...args],
      'CLI producer invocation differs'
    );
    assert.deepEqual(step.env, npmEnvironment(), 'CLI producer environment differs');
    assert(
      step.label === label &&
        step.cwd === base &&
        step.exitCode === 0 &&
        step.signal === null &&
        step.directChildReaped &&
        step.stopReason === null &&
        step.persistenceError === null &&
        step.error === null,
      'CLI pack step did not complete'
    );
    for (const channel of ['stdout', 'stderr']) {
      assert.equal(step[channel + 'Path'], path.join(base, label + '.' + channel));
      const bytes = driverCustody.readBounded(step[channel + 'Path'], 4194304);
      assert.equal(bytes.length, step[channel + 'Bytes']);
      assert.equal(bytes.length, step[channel + 'RetainedBytes']);
      assert.equal(digest(bytes), step[channel + 'Sha256']);
      assert.equal(bytes.toString('base64'), step[channel + 'Base64']);
    }
    if (label === 'cli-pack')
      verifyPackedCliResult(
        JSON.parse(Buffer.from(step.stdoutBase64, 'base64').toString('utf8')),
        result.tarball
      );
  }
  return result;
}

function pin(file) {
  file = fs.realpathSync(file);
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'Expected physical input: ' + file);
  assert(stat.size <= 512 * 1024 * 1024, 'Input exceeds driver read bound: ' + file);
  const bytes = fs.readFileSync(file);
  return { path: file, sizeBytes: bytes.length, sha256: digest(bytes) };
}
function save(name, value) {
  fs.writeFileSync(path.join(base, name), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
}
function xcrun(args) {
  return fs.realpathSync(
    execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', ...args], {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 65536,
    }).trim()
  );
}
async function sqlite() {
  assert.equal(pin(archive).sha256, archiveSha, 'SQLite archive pin mismatch');
  assert(!fs.existsSync(source), 'Extraction root exists; retain it and inspect before retrying');
  const listing = execFileSync('/usr/bin/unzip', ['-Z1', archive], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 65536,
  })
    .trim()
    .split(/\r?\n/);
  const allowed = new Set([
    'sqlite-amalgamation-3530400/',
    'sqlite-amalgamation-3530400/sqlite3.c',
    'sqlite-amalgamation-3530400/sqlite3.h',
    'sqlite-amalgamation-3530400/sqlite3ext.h',
    'sqlite-amalgamation-3530400/shell.c',
  ]);
  assert.equal(listing.length, allowed.size, 'Unexpected archive inventory');
  assert.equal(new Set(listing).size, allowed.size, 'Duplicate archive member');
  assert(
    listing.every((name) => allowed.has(name)),
    'Unexpected archive member'
  );
  execFileSync('/usr/bin/unzip', ['-q', archive, '-d', inputs], {
    timeout: 15000,
    maxBuffer: 65536,
  });
  assert.equal(pin(archive).sha256, archiveSha, 'Archive changed during extraction');
  const c = path.join(source, 'sqlite3.c');
  const header = path.join(source, 'sqlite3.h');
  const cBytes = fs.readFileSync(c);
  const headerBytes = fs.readFileSync(header);
  assert.equal(cBytes.length, 9515341);
  assert.equal(digest(cBytes, 'sha3-256'), cSha3);
  assert.equal(headerBytes.length, 690838);
  assert.equal(digest(headerBytes), headerSha);
  const sdkRoot = xcrun(['--show-sdk-path']);
  const request = {
    sourceC: c,
    sourceHeader: header,
    tools: Object.fromEntries(
      ['clang', 'ar', 'nm', 'otool'].map((name) => [name, pin(xcrun(['--find', name]))])
    ),
    sdk: { root: sdkRoot, settings: pin(path.join(sdkRoot, 'SDKSettings.json')) },
    outputRoot: path.join(base, 'sqlite-prefix'),
    timeoutMs: 600000,
    maxOutputBytes: 1048576,
  };
  save('sqlite-prefix.request.json', request);
  const { buildPinnedSqliteStatic } = require('../dist/tooling/sqlite-static-build');
  const result = await buildPinnedSqliteStatic(request, { signal: controller.signal });
  save('sqlite-prefix.result.json', result);
  console.log(
    JSON.stringify({
      phase: 'sqlite',
      status: result.status,
      markerPath: result.markerPath,
      archive: result.archive,
      failurePhase: result.phase,
      reason: result.reason,
    })
  );
  if (result.status !== 'completed') process.exitCode = 1;
}
async function prepareNative() {
  const committedInputs = committedBuildInputs();
  assert.deepEqual(committedInputs, loadCliPack().source, 'Source differs from the fresh CLI pack');
  const {
    nativeSqlitePreparationCustody: custody,
    readNativeSqliteBuildRequest,
  } = require('../dist/tooling/native-sqlite-build');
  const pkg = path.resolve(__dirname, '..');
  const repo = path.resolve(pkg, '../..');
  const sourcePrefix = 'packages/caws-native/';
  const originalRoot = path.join(repo, 'packages/caws-native');
  const snapshotRoot = path.join(inputs, 'native-source');
  const tick = () => controller.signal.throwIfAborted();
  // Mirror the maintained validator's private MAX_FILE/MAX_TOTAL/MAX_FILES.
  // Reserve before reading; the existing validator also checks the final request.
  const maximumFile = 256 * 1024 * 1024;
  const maximumTotal = 512 * 1024 * 1024;
  const maximumFiles = 50000;
  let inventoriedFiles = 0,
    inventoriedBytes = 0;
  function observeInput(file, resolveLinks = false) {
    tick();
    if (resolveLinks) file = fs.realpathSync(file);
    custody.realDirectories(path.dirname(file));
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Not a regular input: ' + file);
    assert(
      Number.isSafeInteger(stat.size) && stat.size >= 0 && stat.size <= maximumFile,
      'Input exceeds existing file bound: ' + file
    );
    assert(
      inventoriedFiles + 1 <= maximumFiles && inventoriedBytes + stat.size <= maximumTotal,
      'Input inventory exceeds existing aggregate bound'
    );
    inventoriedFiles++;
    inventoriedBytes += stat.size;
    const identity = custody.fileIdentity(file);
    assert.equal(identity.sizeBytes, stat.size, 'Input size changed before capture');
    assert.equal(fs.lstatSync(file).mode, stat.mode, 'Input mode changed during capture');
    return { identity, executable: (stat.mode & 0o111) !== 0 };
  }
  const commandEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
  );
  commandEnvironment.GIT_OPTIONAL_LOCKS = '0';
  const run = (file, args) =>
    execFileSync(file, args, {
      cwd: repo,
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
      env: commandEnvironment,
    });
  const git = (...args) => run('/usr/bin/git', args);
  const readTree = () =>
    git('ls-tree', '-rz', '--full-tree', driver.sourceCommit, '--', 'packages/caws-native');
  const readDirty = () =>
    git('status', '--porcelain=v1', '-z', '--untracked-files=no', '--', 'packages/caws-native');
  const head = git('rev-parse', '--verify', 'HEAD').toString('utf8').trim();
  assert.equal(head, driver.sourceCommit, 'HEAD differs from selected committed source');
  assert.equal(git('rev-parse', '--show-toplevel').toString('utf8').trim(), repo);
  assert.equal(git('rev-parse', '--show-object-format').toString('utf8').trim(), 'sha1');
  custody.realDirectories(originalRoot);
  custody.realDirectories(inputs);
  const treeBefore = readTree();
  const dirtyBefore = readDirty();
  assert.equal(dirtyBefore.length, 0, 'Tracked native source/index must be clean');
  const treeText = treeBefore.toString('utf8');
  assert(Buffer.from(treeText).equals(treeBefore), 'Git paths are not UTF-8');
  assert(treeText.endsWith('\0'), 'Empty or unframed native tree inventory');
  const order = (a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0;
  const records = treeText
    .slice(0, -1)
    .split('\0')
    .map((record) => {
      const match = /^([0-7]{6}) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
      assert(
        match && ['100644', '100755'].includes(match[1]),
        'Symlink, submodule or special committed source entry'
      );
      assert(match[3].startsWith(sourcePrefix), 'Source escaped package');
      const relativePath = match[3].slice(sourcePrefix.length);
      const safeCharacters = [...relativePath].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && !(code >= 127 && code <= 159);
      });
      assert(
        relativePath &&
          !relativePath.includes('\\') &&
          safeCharacters &&
          relativePath.split('/').every((part) => part && part !== '.' && part !== '..') &&
          path.posix.normalize(relativePath) === relativePath &&
          !path.posix.isAbsolute(relativePath),
        'Unsupported native source path'
      );
      assert(
        relativePath !== 'target' &&
          !relativePath.startsWith('target/') &&
          relativePath !== '.cargo/config' &&
          relativePath !== '.cargo/config.toml' &&
          !relativePath.split('/').includes('.git'),
        'Build/config injection in tracked source'
      );
      return { relativePath, treeMode: match[1], treeObject: match[2] };
    })
    .sort(order);
  assert(records.length <= maximumFiles, 'Native index exceeds existing inventory bound');
  assert.equal(new Set(records.map((record) => record.relativePath)).size, records.length);
  fs.mkdirSync(snapshotRoot, { mode: 0o700 });
  const originals = [];
  const sourceFiles = records.map((record) => {
    tick();
    const file = path.join(originalRoot, record.relativePath);
    const { identity, executable } = observeInput(file);
    const bytes = custody.verifyFile(identity);
    const object = crypto
      .createHash('sha1')
      .update(Buffer.from(`blob ${bytes.length}\0`))
      .update(bytes)
      .digest('hex');
    assert.equal(object, record.treeObject, 'Source bytes differ from committed Git blob');
    assert.equal(
      executable,
      record.treeMode === '100755',
      'Source executable mode differs from committed tree'
    );
    assert.equal((fs.lstatSync(file).mode & 0o111) !== 0, executable, 'Source mode changed');
    const destination = path.join(snapshotRoot, record.relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    custody.exclusive(destination, bytes, executable);
    originals.push({ identity, executable });
    return {
      relativePath: record.relativePath,
      sizeBytes: identity.sizeBytes,
      sha256: identity.sha256,
      executable,
    };
  });
  const sourceTree = { root: snapshotRoot, files: sourceFiles };
  custody.inspectTree(sourceTree, false, tick);
  for (const original of originals) {
    tick();
    custody.verifyFile(original.identity);
    assert.equal((fs.lstatSync(original.identity.path).mode & 0o111) !== 0, original.executable);
  }
  assert.equal(git('rev-parse', '--verify', 'HEAD').toString('utf8').trim(), head, 'HEAD changed');
  assert(readTree().equals(treeBefore), 'Selected committed native tree changed');
  assert.equal(readDirty().length, 0, 'Tracked native source/index changed');
  function inventory(root) {
    custody.realDirectories(root);
    const files = [];
    function visit(relativeDir) {
      tick();
      const handle = fs.opendirSync(path.join(root, relativeDir));
      try {
        let entry;
        while ((entry = handle.readSync()) !== null) {
          tick();
          const relativePath = relativeDir ? relativeDir + '/' + entry.name : entry.name;
          const file = path.join(root, relativePath);
          const stat = fs.lstatSync(file);
          assert(!stat.isSymbolicLink(), 'Symlink input: ' + file);
          if (stat.isDirectory()) visit(relativePath);
          else {
            const { identity, executable } = observeInput(file);
            files.push({
              relativePath,
              sizeBytes: identity.sizeBytes,
              sha256: identity.sha256,
              executable,
            });
          }
        }
      } finally {
        handle.closeSync();
      }
    }
    visit('');
    files.sort(order);
    const tree = { root, files };
    custody.inspectTree(tree, false, tick);
    return tree;
  }
  const vendorRoot = driver.vendorRoot;
  custody.realDirectories(vendorRoot);
  const vendorDirectories = [];
  const vendorHandle = fs.opendirSync(vendorRoot);
  try {
    let entry;
    while ((entry = vendorHandle.readSync()) !== null) {
      assert(vendorDirectories.length < 128, 'Vendor inventory exceeds build profile');
      assert(entry.isDirectory() && !entry.isSymbolicLink(), 'Unexpected vendor entry');
      vendorDirectories.push(entry.name);
    }
  } finally {
    vendorHandle.closeSync();
  }
  vendorDirectories.sort();
  assert(vendorDirectories.length >= 1, 'Expected completed versioned vendor inventory');
  const vendors = vendorDirectories.map((directory) => {
    assert(
      /^[A-Za-z0-9_][A-Za-z0-9_.+-]*-[0-9][A-Za-z0-9_.+-]*$/.test(directory) &&
        !directory.includes('..'),
      'Vendor directory is not versioned: ' + directory
    );
    return { directory, tree: inventory(path.join(vendorRoot, directory)) };
  });
  const bindingDirectory = 'libsqlite3-sys-0.38.2';
  const bindingRelative = 'bindgen-bindings/bindgen_3.34.1.rs';
  const bindingVendor = vendors.find((vendor) => vendor.directory === bindingDirectory);
  assert(bindingVendor, 'Reviewed SQLite binding vendor missing');
  const bindingFile = bindingVendor.tree.files.find(
    (file) => file.relativePath === bindingRelative
  );
  assert(bindingFile, 'Reviewed SQLite generated binding missing');
  const serviceClient = observeInput(
    path.join(pkg, 'templates/hook-packs/shared/lib/session-render-service-client.sh')
  ).identity;
  const serviceImage = inventory(path.join(pkg, 'templates/hook-packs/runtime/service-image'));
  const toolVersions = {};
  const tools = {};
  for (const name of ['cargo', 'rustc']) {
    const file = run('rustup', ['which', '--toolchain', '1.90.0', name]).toString('utf8').trim();
    assert(path.isAbsolute(file), 'rustup did not return absolute tool path');
    const observed = observeInput(file, true);
    assert(observed.executable, 'Selected Rust tool is not executable');
    tools[name] = observed.identity;
    toolVersions[name] = run(observed.identity.path, ['--version']).toString('utf8').trim();
    assert(
      toolVersions[name].startsWith(name + ' 1.90.0 '),
      'Expected actual Rust1.90 tool: ' + name
    );
  }
  for (const name of ['clang', 'ar', 'nm', 'otool']) {
    const observed = observeInput(xcrun(['--find', name]), true);
    assert(observed.executable, 'Selected SDK tool is not executable: ' + name);
    tools[name] = observed.identity;
  }
  const sdkRoot = xcrun(['--show-sdk-path']);
  const sdk = {
    root: sdkRoot,
    settings: observeInput(path.join(sdkRoot, 'SDKSettings.json')).identity,
  };
  const prefixRoot = path.join(base, 'sqlite-prefix');
  const prefix = {
    archive: observeInput(path.join(prefixRoot, 'libsqlite3.a')).identity,
    header: observeInput(path.join(prefixRoot, 'sqlite3.h')).identity,
    object: observeInput(path.join(prefixRoot, 'sqlite3.o')).identity,
  };
  const sqliteResultPath = path.join(base, 'sqlite-prefix.result.json');
  const sqliteResultBytes = custody.readBounded(sqliteResultPath, 16 * 1024 * 1024);
  const sqliteResult = JSON.parse(sqliteResultBytes.toString('utf8'));
  assert.equal(sqliteResult.status, 'completed');
  assert.deepEqual(sqliteResult.archive, prefix.archive);
  assert.equal(sqliteResult.markerPath, path.join(prefixRoot, 'recipe-completed.json'));
  const sqliteMarker = custody.fileIdentity(sqliteResult.markerPath);
  const outputRoot = path.join(base, 'native-output');
  try {
    fs.lstatSync(outputRoot);
    throw new Error('Native output exists; retain it and inspect before retrying');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const request = {
    schema: 'caws.native_sqlite_build_request.v2',
    source: sourceTree,
    embedded: { serviceClient, serviceImage },
    vendors,
    prefix,
    binding: {
      directory: bindingDirectory,
      relativePath: bindingRelative,
      sha256: bindingFile.sha256,
    },
    tools,
    sdk,
    outputRoot,
    profile: driver.profile,
    timeoutMs: 600000,
    maxOutputBytes: 4194304,
  };
  custody.validateRequest(request);
  assert.deepEqual(
    committedBuildInputs(),
    committedInputs,
    'Source changed during native preparation'
  );
  save('native-source-origin.json', {
    kind: 'committed-native-source-observation',
    repository: repo,
    headObserved: head,
    trackedTreeSha256: digest(treeBefore),
    trackedTree: records,
    trackedDirtyPorcelainV1Z: dirtyBefore.toString('utf8'),
    sourceSnapshot: sourceTree,
    toolVersions,
    sqliteResult: {
      path: sqliteResultPath,
      sizeBytes: sqliteResultBytes.length,
      sha256: digest(sqliteResultBytes),
    },
    sqliteCompletionMarker: sqliteMarker,
    boundary:
      'Native source bytes and executable modes match the selected committed Git tree. Vendor bytes are independently inventoried into this pinned build request; no vendor authorship, accepted native profile or activation authority is claimed.',
  });
  save('native-build.request.json', request);
  const loaded = readNativeSqliteBuildRequest(path.join(base, 'native-build.request.json'));
  assert.deepEqual(loaded.request, request);
  console.log(
    JSON.stringify({
      phase: 'prepare-native',
      status: 'prepared',
      requestFile: loaded.requestFile,
      sourceFiles: sourceFiles.length,
      vendorCrates: vendors.length,
      headObserved: head,
      trackedSourceDirty: dirtyBefore.length !== 0,
    })
  );
}

async function image() {
  const {
    nativeSqlitePreparationCustody: custody,
    readNativeSqliteBuildRequest,
    loadNativeSqliteBuildWithStableEntry,
  } = require('../dist/tooling/native-sqlite-build');
  const {
    prepareNativeRuntimeEntryFromBuild,
    nativeRelative,
  } = require('../dist/init/native-runtime-entry');
  const pkg = path.resolve(__dirname, '..');
  const repo = path.resolve(pkg, '../..');
  const prefixRoot = path.join(base, 'cli-prefix');
  const cliPack = loadCliPack();
  assert.deepEqual(
    committedBuildInputs(),
    cliPack.source,
    'Source changed before image preparation'
  );
  fs.mkdirSync(prefixRoot, { mode: 0o700 });
  await npmStep('cli-install', [
    'install',
    '--prefix',
    prefixRoot,
    '--ignore-scripts',
    '--omit=dev',
    '--bin-links=false',
    '--workspaces=false',
    '--no-audit',
    '--no-fund',
    '--save-exact',
    cliPack.tarball.path,
  ]);
  driverCustody.verifyFile(cliPack.tarball);
  if (driver.schema === 'caws.native-hook-driver-request.v2') {
    const lock = JSON.parse(
      driverCustody
        .readBounded(path.join(prefixRoot, 'package-lock.json'), 16777216)
        .toString('utf8')
    );
    verifySelectedTarballLock(lock, prefixRoot, cliPack.tarball);
  }
  const audit = await npmStep('cli-audit', [
    'audit',
    '--prefix',
    prefixRoot,
    '--omit=dev',
    '--json',
  ]);
  const auditResult = JSON.parse(
    Buffer.from(audit.receipt.stdoutBase64, 'base64').toString('utf8')
  );
  assert.equal(
    auditResult.metadata?.vulnerabilities?.total,
    0,
    'Installed CLI audit must have zero findings'
  );
  const requestPath = path.join(base, 'native-build.request.json');
  const selected = readNativeSqliteBuildRequest(requestPath);
  assert.equal(selected.requestFile.sha256, expectedNativeRequestSha);
  const loaded = loadNativeSqliteBuildWithStableEntry(requestPath);
  assert.deepEqual(loaded.requestFile, selected.requestFile);
  assert.equal(loaded.build.outputRoot, path.join(base, 'native-output'));
  const tick = () => controller.signal.throwIfAborted();
  let count = 0,
    total = 0;
  function observe(file) {
    tick();
    custody.realDirectories(path.dirname(file));
    const stat = fs.lstatSync(file);
    assert(
      stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o7022) === 0,
      'Unsafe image input: ' + file
    );
    assert(
      Number.isSafeInteger(stat.size) && stat.size >= 0 && stat.size <= 256 * 1024 * 1024,
      'Image input exceeds file bound'
    );
    assert(
      count + 1 <= 50000 && total + stat.size <= 512 * 1024 * 1024,
      'Image inputs exceed inventory bound'
    );
    count++;
    total += stat.size;
    const identity = custody.fileIdentity(file);
    assert.equal(identity.sizeBytes, stat.size, 'Image input size changed');
    assert.equal(fs.lstatSync(file).mode, stat.mode, 'Image input mode changed');
    return { identity, mode: stat.mode & 0o7777 };
  }
  const files = Object.create(null);
  function walk(directory, relativeDir, consume) {
    tick();
    custody.realDirectories(directory);
    const handle = fs.opendirSync(directory);
    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        tick();
        const relative = relativeDir ? relativeDir + '/' + entry.name : entry.name;
        nativeRelative(relative);
        const file = path.join(directory, entry.name);
        const stat = fs.lstatSync(file);
        assert(!stat.isSymbolicLink(), 'Image symlink refused: ' + file);
        if (stat.isDirectory()) walk(file, relative, consume);
        else consume(file, relative);
      }
    } finally {
      handle.closeSync();
    }
  }
  walk(prefixRoot, '', (file, relative) => {
    const observed = observe(file);
    assert([0o644, 0o755].includes(observed.mode), 'Prefix mode must be0644/0755: ' + file);
    files[relative] = { sha256: observed.identity.sha256, mode: observed.mode };
  });
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const noticeName = (name) => /^(?:licen[cs]e|copying|copyright|notice)(?:$|[._-])/i.test(name);
  const packageRoots = Object.keys(files)
    .filter((name) => /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(name))
    .map((name) => path.posix.dirname(name))
    .sort(order);
  const packages = Object.create(null);
  for (const root of packageRoots) {
    const packagePath = root + '/package.json';
    const member = files[packagePath];
    const jsonBytes = custody.verifyFile({
      path: path.join(prefixRoot, packagePath),
      sizeBytes: fs.lstatSync(path.join(prefixRoot, packagePath)).size,
      sha256: member.sha256,
    });
    const metadata = JSON.parse(jsonBytes.toString('utf8'));
    assert(typeof metadata.name === 'string' && typeof metadata.version === 'string');
    const licenses = Object.keys(files)
      .filter((name) => name.startsWith(root + '/'))
      .map((name) => name.slice(root.length + 1))
      .filter((name) => !name.includes('/') && noticeName(name))
      .sort(order);
    assert(licenses.length > 0, 'No actual root license/notice file for ' + root);
    packages[root] = { name: metadata.name, version: metadata.version, licenses };
  }
  const nativeNotices = Object.create(null);
  function addNotice(name, file, expected) {
    nativeRelative(name);
    assert(!Object.hasOwn(nativeNotices, name), 'Duplicate notice output: ' + name);
    const { identity } = observe(file);
    assert(identity.sizeBytes > 0, 'Empty notice: ' + file);
    if (expected) {
      assert.equal(identity.sizeBytes, expected.sizeBytes);
      assert.equal(identity.sha256, expected.sha256);
    }
    nativeNotices[name] = { source: identity.path, sha256: identity.sha256 };
  }
  addNotice('caws/LICENSE', path.join(repo, 'LICENSE'));
  for (const vendor of selected.request.vendors) {
    const licenseFiles = vendor.tree.files.filter(
      (file) => !file.relativePath.includes('/') && noticeName(file.relativePath)
    );
    assert(licenseFiles.length > 0, 'Missing actual vendor license: ' + vendor.directory);
    for (const file of licenseFiles)
      addNotice(
        'crates/' + vendor.directory + '/' + file.relativePath,
        path.join(loaded.build.outputRoot, 'vendor', vendor.directory, file.relativePath),
        file
      );
  }
  const prefixManifest = JSON.parse(
    custody.verifyFile(loaded.build.prefixManifest).toString('utf8')
  );
  addNotice('sqlite/sqlite3.h', prefixManifest.header.path, prefixManifest.header);
  const rustRoot = path.dirname(path.dirname(selected.request.tools.rustc.path));
  const rustDocs = path.join(rustRoot, 'share/doc/rust');
  for (const name of ['COPYRIGHT.html', 'COPYRIGHT-library.html'])
    addNotice('rust/' + name, path.join(rustDocs, name));
  walk(path.join(rustDocs, 'licenses'), '', (file, relative) =>
    addNotice('rust/licenses/' + relative, file)
  );
  const nodeFile = fs.realpathSync(process.execPath);
  const nodeObserved = observe(nodeFile);
  assert((nodeObserved.mode & 0o111) !== 0, 'Selected Node is not executable');
  assert.equal(nodeObserved.identity.sha256, nodeSha);
  const nodeLicense = observe(path.resolve(path.dirname(nodeFile), '../LICENSE')).identity;
  assert(nodeLicense.sizeBytes > 0, 'Retained Node LICENSE is empty');
  const input = {
    schema: 'caws.runtime.native-image-input.v2',
    prefixRoot,
    files,
    packages,
    omissions: {},
    node: {
      source: nodeObserved.identity.path,
      sha256: nodeObserved.identity.sha256,
      notices: { LICENSE: { source: nodeLicense.path, sha256: nodeLicense.sha256 } },
    },
    requestFile: loaded.requestFile,
    completionReceipt: loaded.completionReceipt,
    nativeNotices,
    timeoutMs: 30000,
  };
  const prepared = prepareNativeRuntimeEntryFromBuild(input);
  assert.equal(prepared.metadata.schema, 'caws.runtime.native-entry.v2');
  assert.deepEqual(
    prepared.metadata.installedInvocation,
    loaded.build.observedIdentity.installedInvocation
  );
  for (const [member, artifact] of [
    ['native/caws-native', loaded.build.artifacts.native],
    ['native/caws-hook-native', loaded.build.artifacts.stableEntry],
  ]) {
    const bytes = prepared.files.get(member);
    assert(bytes && bytes.length === artifact.sizeBytes);
    assert.equal(digest(bytes), artifact.sha256);
    assert(prepared.executablePaths.has(member));
  }
  assert.equal(digest(prepared.stableEntry), loaded.build.artifacts.stableEntry.sha256);
  assert.deepEqual(
    committedBuildInputs(),
    cliPack.source,
    'Source changed during image preparation'
  );
  save('native-image.v2.json', input);
  console.log(
    JSON.stringify({
      phase: 'image',
      status: 'prepared',
      descriptor: custody.fileIdentity(path.join(base, 'native-image.v2.json')),
      requestFile: loaded.requestFile,
      completionReceipt: loaded.completionReceipt,
      metadata: prepared.metadata,
      prefixFiles: Object.keys(files).length,
      packages: Object.keys(packages).length,
      nativeNotices: Object.keys(nativeNotices).length,
      native: loaded.build.artifacts.native,
      stableEntry: loaded.build.artifacts.stableEntry,
      boundary:
        'Prepared descriptor only; no Stop profile/CLI domain, installation, activation or legal-coverage conclusion.',
    })
  );
}

async function native() {
  const file = path.join(base, 'native-build.request.json');
  const {
    readNativeSqliteBuildRequest,
    buildNativeSqliteCandidate,
  } = require('../dist/tooling/native-sqlite-build');
  const { request } = readNativeSqliteBuildRequest(file);
  assert.equal(request.schema, 'caws.native_sqlite_build_request.v2');
  assert.equal(request.outputRoot, path.join(base, 'native-output'));
  assert.equal(request.source.root, path.join(inputs, 'native-source'));
  assert.equal(request.profile, driver.profile);
  const result = await buildNativeSqliteCandidate(request, { signal: controller.signal });
  save('native-driver.result.json', result);
  console.log(
    JSON.stringify({
      phase: 'native',
      status: result.status,
      markerPath: result.markerPath,
      artifacts: result.artifacts,
      failurePhase: result.phase,
      reason: result.reason,
    })
  );
  if (result.status !== 'completed') process.exitCode = 1;
}
async function main() {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64');
  const { phase, options } = parseDriverArguments(process.argv.slice(2));
  admitDriver(phase, options);
  if (phase === 'cli') await cli();
  else if (phase === 'sqlite') await sqlite();
  else if (phase === 'prepare-native') await prepareNative();
  else if (phase === 'native') await native();
  else if (phase === 'image') await image();
  else
    throw new Error(
      'Usage: retained-node scripts/build-native-hook-image.cjs cli|sqlite|prepare-native|native|image --request ABS --request-sha256 SHA [--native-request-sha256 SHA]'
    );
}
module.exports = {
  parseDriverArguments,
  observeCommittedSource,
  npmEnvironment,
  assertNoNpmProjectConfig,
  verifySelectedTarballLock,
};
if (require.main === module) {
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  main()
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    })
    .finally(() => {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    });
}
