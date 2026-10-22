#!/usr/bin/env node

// Finite, synchronous observations of mutation inputs and emitted builds.
// These observations do not prove module loading or exclude change/restore races.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const slash = (file) => file.split(path.sep).join('/');
const fail = (message) => {
  throw new Error(`mutation identity: ${message}`);
};

export function assertDirectoryAncestry(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail(`uncertain directory ancestry: ${current}`);
  }
  return absolute;
}

function readRegular(file) {
  assertDirectoryAncestry(path.dirname(file));
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) fail(`nonregular input: ${file}`);
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file, { bigint: true });
  for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) {
    if (before[key] !== after[key]) fail(`input changed while reading: ${file}`);
  }
  return { bytes, stat: after };
}

function walk(directory, visit, { markdownOnly = false, dependencies = false } = {}) {
  assertDirectoryAncestry(directory);
  for (const entry of fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (
      ['node_modules', '.venv', '__pycache__'].includes(entry.name) ||
      entry.name.endsWith('.pyc')
    )
      continue;
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      if (!dependencies) fail(`symlink input: ${file}`);
      const canonical = fs.realpathSync(file);
      if (!fs.statSync(canonical).isFile()) fail(`nonregular dependency link: ${file}`);
      visit(canonical, file);
    } else if (entry.isDirectory()) walk(file, visit, { markdownOnly, dependencies });
    else if (entry.isFile() && (!markdownOnly || entry.name.endsWith('.md'))) visit(file, file);
    else if (!entry.isFile()) fail(`nonregular input: ${file}`);
  }
}

export function resolveExecutable(name) {
  const suffixes =
    process.platform === 'win32' && !path.extname(name)
      ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')]
      : [''];
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    for (const suffix of suffixes) {
      const candidate = path.resolve(directory, name + suffix);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
      } catch {
        /* continue normal PATH lookup */
      }
    }
  }
  fail(`cannot resolve executable ${name}`);
}

export function resolveNpmCommand() {
  let cli;
  if (process.env.npm_execpath) cli = fs.realpathSync(path.resolve(process.env.npm_execpath));
  else if (process.platform !== 'win32') cli = resolveExecutable('npm');
  else fail('cannot identify npm CLI; invoke mutation through npm run mutation:run:<surface>');
  let directory = path.dirname(cli);
  while (directory !== path.dirname(directory)) {
    const metadataFile = path.join(directory, 'package.json');
    if (fs.existsSync(metadataFile)) {
      const metadata = JSON.parse(readRegular(metadataFile).bytes.toString('utf8'));
      if (metadata.name === 'npm') {
        const relative = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.npm;
        if (!relative || fs.realpathSync(path.join(directory, relative)) !== cli)
          fail('npm CLI does not match its package executable');
        return {
          command: process.execPath,
          args: [cli, 'run', 'build'],
          cli,
          packageJson: metadataFile,
        };
      }
    }
    directory = path.dirname(directory);
  }
  fail('cannot identify npm CLI package; invoke mutation through npm scripts');
}

function resolvePackage(name, from) {
  const require = createRequire(from);
  // Reading package metadata also handles packages which hide package.json
  // behind exports. The lookup paths are Node's actual dependency search path.
  for (const directory of require.resolve.paths(name) || []) {
    const candidate = path.join(directory, name, 'package.json');
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
  }
  fail(`cannot resolve dependency ${name} from ${from}`);
}

function captureDependencies(packageJson, add) {
  const visited = new Set();
  const visit = (metadataFile, direct = false) => {
    const canonical = fs.realpathSync(metadataFile);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    const metadata = JSON.parse(readRegular(canonical).bytes.toString('utf8'));
    if (!direct) {
      const root = path.dirname(canonical);
      walk(root, (physical, logical) => add(physical, `dependency:${slash(logical)}`), {
        dependencies: true,
      });
    }
    const required = { ...metadata.dependencies, ...(direct ? metadata.devDependencies : {}) };
    const optional = metadata.optionalDependencies || {};
    for (const name of new Set([...Object.keys(required), ...Object.keys(optional)])) {
      let dependency;
      try {
        dependency = resolvePackage(name, canonical);
      } catch (error) {
        if (Object.hasOwn(optional, name)) continue;
        throw error;
      }
      visit(dependency);
    }
    // Installed peers can affect the compiler/runner even when their consumer
    // does not list them as an ordinary dependency. Missing peers are retained
    // in package metadata; the actual build/runner must reject ones it needs.
    for (const name of Object.keys(metadata.peerDependencies || {})) {
      try {
        visit(resolvePackage(name, canonical));
      } catch (error) {
        if (!String(error.message).includes('cannot resolve dependency')) throw error;
      }
    }
  };
  visit(packageJson, true);
  const npm = resolveNpmCommand();
  add(npm.cli, `tool:${slash(npm.cli)}`);
  visit(npm.packageJson);
  const node = fs.realpathSync(process.execPath);
  if (resolveExecutable('node') !== node) fail('PATH node differs from runner Node executable');
  add(node, `tool:${slash(node)}`);
}

function directoryIdentity(stat) {
  return Object.fromEntries(
    ['dev', 'ino', 'birthtimeNs', 'mode', 'nlink'].map((field) => [field, String(stat[field])])
  );
}

function observePackageNodeModules(packageRoot) {
  assertDirectoryAncestry(packageRoot);
  const entry = path.join(packageRoot, 'node_modules');
  const stat = fs.lstatSync(entry, { bigint: true, throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isDirectory() && !stat.isSymbolicLink())
    fail(`uncertain package-local dependency directory: ${entry}`);
  const canonical = fs.realpathSync(entry);
  assertDirectoryAncestry(canonical);
  return {
    canonical,
    entryIdentity: directoryIdentity(stat),
    targetIdentity: directoryIdentity(fs.lstatSync(canonical, { bigint: true })),
  };
}

function mirrorPackageNodeModules(context, sandboxRoot) {
  const captured = context.inputIdentity.packageNodeModules;
  const current = observePackageNodeModules(context.packageRoot);
  if (JSON.stringify(current) !== JSON.stringify(captured))
    fail('original package-local dependency binding changed');
  const destination = path.join(sandboxRoot, 'node_modules');
  // Stryker runs buildCommand before its node_modules linking phase. Do not
  // inherit an earlier sandbox's directory or link, even when it looks equal.
  if (fs.lstatSync(destination, { throwIfNoEntry: false }))
    fail(`uncertain existing sandbox dependency destination: ${destination}`);
  if (captured) fs.symlinkSync(captured.canonical, destination, 'junction');
  return observePackageNodeModules(sandboxRoot);
}

export function captureMutationInputs({ packageRoot, policy, surfaceId }) {
  const root = assertDirectoryAncestry(packageRoot);
  const repoRoot = assertDirectoryAncestry(path.resolve(root, '../..'));
  const packageNodeModules = observePackageNodeModules(root);
  if (
    JSON.stringify(
      JSON.parse(readRegular(path.join(root, 'mutation-policy.json')).bytes.toString('utf8'))
    ) !== JSON.stringify(policy)
  )
    fail('selected policy does not match captured policy input');
  const records = new Map();
  const add = (physical, logical = slash(path.relative(root, physical))) => {
    const { bytes, stat } = readRegular(physical);
    records.set(logical, {
      path: logical,
      sha256: sha256(bytes),
      size: bytes.length,
      mode: Number(stat.mode & 0o777n),
    });
  };
  // Broad authored roots deliberately include fixtures, setup, generators,
  // the registry and standalone projections; generated dist/docs transports
  // and their ownership marker are separate build outputs.
  for (const directory of ['src', 'scripts', 'tests', 'templates', 'surfaces'])
    walk(path.join(root, directory), (file) => add(file));
  for (const entry of fs.readdirSync(root).sort()) {
    if (entry === '.license-transport.json' || entry === '.license-transport.lock') continue;
    if (/\.(?:json|js|cjs|mjs)$/.test(entry) || entry === '.npmrc') add(path.join(root, entry));
  }
  for (const file of ['package.json', 'package-lock.json', 'LICENSE'])
    add(path.join(repoRoot, file));
  const npmrc = path.join(repoRoot, '.npmrc');
  if (fs.existsSync(npmrc)) add(npmrc);
  walk(path.join(repoRoot, 'docs'), (file) => add(file), { markdownOnly: true });
  for (const file of [
    'src/transcripts/unicode14/LICENSE.txt',
    'src/transcripts/html311/LICENSE.txt',
  ])
    add(path.join(root, file));
  captureDependencies(path.join(root, 'package.json'), add);
  const surface = policy.surfaces?.[surfaceId];
  if (!surface) fail(`unknown surface ${surfaceId}`);
  if (
    !Array.isArray(surface.targets) ||
    !surface.targets.length ||
    !Array.isArray(surface.tests) ||
    !surface.tests.length
  )
    fail('bound mutation input selection is empty');
  const targets = Object.fromEntries(
    surface.targets.map(({ source }) => [
      source,
      readRegular(path.join(root, source)).bytes.toString('utf8'),
    ])
  );
  const tests = Object.fromEntries(
    surface.tests.map((file) => [file, readRegular(path.join(root, file)).bytes.toString('utf8')])
  );
  const files = [...records.values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    schemaVersion: 1,
    packageRoot: root,
    repoRoot,
    files,
    targets,
    tests,
    packageNodeModules,
    digest: sha256(JSON.stringify(files)),
  };
}

export function assertInputsUnchanged(captured, options) {
  const current = captureMutationInputs(options);
  if (JSON.stringify(current.packageNodeModules) !== JSON.stringify(captured.packageNodeModules))
    fail('package-local dependency binding changed');
  if (current.digest !== captured.digest) {
    const previous = new Map(captured.files.map((record) => [record.path, JSON.stringify(record)]));
    const next = new Map(current.files.map((record) => [record.path, JSON.stringify(record)]));
    const changed = [...new Set([...previous.keys(), ...next.keys()])].filter(
      (file) => previous.get(file) !== next.get(file)
    );
    fail(`persistent authored/input drift: ${changed.join(', ')}`);
  }
  return current;
}

export function captureBuildOutputs(packageRoot, { startedAtMs } = {}) {
  const root = path.resolve(packageRoot);
  const files = [];
  walk(path.join(root, 'dist'), (file) => {
    const { bytes, stat } = readRegular(file);
    if (startedAtMs !== undefined && Number(stat.mtimeNs) / 1e6 < startedAtMs)
      fail(`stale build output: ${file}`);
    files.push({
      path: slash(path.relative(root, file)),
      sha256: sha256(bytes),
      size: bytes.length,
      mode: Number(stat.mode & 0o777n),
    });
  });
  if (!files.some((file) => file.path.endsWith('.js') && file.size > 0))
    fail('missing nonempty emitted dist JavaScript');
  if (fs.lstatSync(path.join(root, '.license-transport.lock'), { throwIfNoEntry: false }))
    fail('generated license transport lock remains after build');
  const observeTransport = (file) => {
    const { bytes, stat } = readRegular(file);
    files.push({
      path: slash(path.relative(root, file)),
      sha256: sha256(bytes),
      size: bytes.length,
      mode: Number(stat.mode & 0o777n),
    });
  };
  const docs = path.join(root, 'docs');
  if (fs.lstatSync(docs, { throwIfNoEntry: false })) walk(docs, observeTransport);
  for (const file of ['LICENSE', '.license-transport.json']) {
    const absolute = path.join(root, file);
    if (fs.lstatSync(absolute, { throwIfNoEntry: false })) observeTransport(absolute);
  }
  return { files, digest: sha256(JSON.stringify(files)) };
}

export function assertBuildOutputsUnchanged(captured, packageRoot) {
  if (captureBuildOutputs(packageRoot).digest !== captured.digest)
    fail('emitted dist changed after build');
}

function sameSandboxInputs(original, sandbox, surface) {
  const targetBinding = (binding) =>
    binding && {
      canonical: binding.canonical,
      targetIdentity: binding.targetIdentity,
    };
  if (
    JSON.stringify(targetBinding(original.packageNodeModules)) !==
    JSON.stringify(targetBinding(sandbox.packageNodeModules))
  )
    fail('sandbox package-local dependency binding detached from captured input');
  const targets = new Set(surface.targets.map((target) => target.source));
  const fingerprint = (record) => JSON.stringify([record.sha256, record.size, record.mode]);
  // External canonical paths are represented relative to the sandbox package,
  // so compare their physical identity after resolving those relative paths.
  const key = (file, root) =>
    file.startsWith('../') ? `external:${slash(path.resolve(root, file))}` : file;
  const expected = new Map(
    original.files.map((entry) => [key(entry.path, original.packageRoot), fingerprint(entry)])
  );
  const actual = new Map(
    sandbox.files.map((entry) => [key(entry.path, sandbox.packageRoot), fingerprint(entry)])
  );
  for (const [file, digest] of expected) {
    if (!actual.has(file)) fail(`missing sandbox input: ${file}`);
    if (!targets.has(file) && actual.get(file) !== digest)
      fail(`sandbox input detached from captured input: ${file}`);
  }
  for (const file of actual.keys())
    if (!expected.has(file)) fail(`unexpected sandbox input: ${file}`);
}

export function validateSandboxBuildRecord({ context, surface, record, fileName }) {
  if (
    record.schemaVersion !== 1 ||
    record.runId !== context.runId ||
    record.surfaceId !== context.surfaceId ||
    record.command !== surface.buildCommand ||
    record.status !== 0 ||
    record.signal !== null ||
    record.error ||
    typeof record.cwd !== 'string' ||
    path.dirname(record.cwd) !== context.tempDirName ||
    !path.basename(record.cwd).startsWith('sandbox-') ||
    fileName !== `${path.basename(record.cwd)}.json` ||
    !Number.isFinite(record.startedAtMs) ||
    !Number.isFinite(record.endedAtMs) ||
    record.endedAtMs < record.startedAtMs
  ) {
    fail(`detached or failed sandbox build record: ${fileName}`);
  }
  const input = record.inputIdentity;
  const outputs = record.outputs;
  if (
    input?.schemaVersion !== 1 ||
    input.packageRoot !== record.cwd ||
    input.repoRoot !== context.repoRoot ||
    !Array.isArray(input.files) ||
    sha256(JSON.stringify(input.files)) !== input.digest ||
    !Array.isArray(outputs?.files) ||
    sha256(JSON.stringify(outputs.files)) !== outputs.digest ||
    !outputs.files.some(
      (entry) => entry.path.startsWith('dist/') && entry.path.endsWith('.js') && entry.size > 0
    )
  ) {
    fail(`invalid sandbox input/output digest: ${fileName}`);
  }
  for (const files of [input.files, outputs.files]) {
    const paths = new Set();
    for (const entry of files) {
      if (
        typeof entry.path !== 'string' ||
        paths.has(entry.path) ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !Number.isInteger(entry.size) ||
        entry.size < 0 ||
        !Number.isInteger(entry.mode) ||
        entry.mode < 0 ||
        entry.mode > 0o777
      )
        fail(`invalid sandbox file identity: ${fileName}`);
      paths.add(entry.path);
    }
  }
  for (const entry of outputs.files) {
    if (
      path.isAbsolute(entry.path) ||
      entry.path.split('/').includes('..') ||
      !(
        entry.path.startsWith('dist/') ||
        entry.path.startsWith('docs/') ||
        ['LICENSE', '.license-transport.json'].includes(entry.path)
      )
    )
      fail(`detached sandbox output path: ${fileName}`);
  }
  for (const target of surface.targets) {
    if (
      typeof input.targets?.[target.source] !== 'string' ||
      !input.files.some(
        (entry) =>
          entry.path === target.source && entry.sha256 === sha256(input.targets[target.source])
      )
    )
      fail(`missing instrumented sandbox target: ${target.source}`);
  }
  for (const file of surface.tests) {
    if (
      input.tests?.[file] !== context.inputIdentity.tests[file] ||
      !input.files.some(
        (entry) => entry.path === file && entry.sha256 === sha256(input.tests[file])
      )
    )
      fail(`detached sandbox test input: ${file}`);
  }
  sameSandboxInputs(context.inputIdentity, input, surface);
}

export function runSandboxBuild(contextFile, surfaceId) {
  const context = JSON.parse(readRegular(path.resolve(contextFile)).bytes.toString('utf8'));
  const cwd = assertDirectoryAncestry(process.cwd());
  const parent = assertDirectoryAncestry(path.dirname(cwd));
  if (
    context.schemaVersion !== 1 ||
    context.surfaceId !== surfaceId ||
    parent !== context.tempDirName ||
    path.dirname(parent) !== context.repoRoot ||
    !path.basename(cwd).startsWith('sandbox-')
  )
    fail('detached sandbox build context');
  if (path.resolve(cwd, '../..') !== context.repoRoot)
    fail('sandbox external inputs do not resolve to canonical repository');
  const policy = JSON.parse(
    readRegular(path.join(cwd, 'mutation-policy.json')).bytes.toString('utf8')
  );
  const surface = policy.surfaces?.[surfaceId];
  if (!surface?.buildCommand) fail(`surface ${surfaceId} declares no sandbox build`);
  mirrorPackageNodeModules(context, cwd);
  const options = { packageRoot: cwd, policy, surfaceId };
  const inputIdentity = captureMutationInputs(options);
  sameSandboxInputs(context.inputIdentity, inputIdentity, surface);
  const startedAtMs = Date.now();
  const result = spawnSync(surface.buildCommand, {
    cwd,
    shell: true,
    env: process.env,
    stdio: 'inherit',
  });
  const record = {
    schemaVersion: 1,
    runId: context.runId,
    surfaceId,
    command: surface.buildCommand,
    cwd,
    startedAtMs,
    endedAtMs: Date.now(),
    status: result.status,
    signal: result.signal,
    inputIdentity,
  };
  let failure;
  try {
    if (result.error || result.status !== 0)
      fail(
        `sandbox build failed (${result.error?.message || result.signal || `exit ${result.status}`})`
      );
    assertInputsUnchanged(inputIdentity, options);
    record.outputs = captureBuildOutputs(cwd, { startedAtMs });
  } catch (error) {
    failure = error;
    record.error = error.message;
  }
  assertDirectoryAncestry(context.sandboxBuildDir);
  fs.writeFileSync(
    path.join(context.sandboxBuildDir, `${path.basename(cwd)}.json`),
    JSON.stringify(record, null, 2) + '\n',
    { flag: 'wx' }
  );
  if (failure) throw failure;
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== 'sandbox-build' || ![4, 5].includes(process.argv.length))
      fail('usage: mutation-input-identity.mjs sandbox-build [<context>] <surface>');
    const context =
      process.argv.length === 5 ? process.argv[3] : process.env.CAWS_MUTATION_RUN_CONTEXT;
    if (!context) fail('sandbox build has no runner context');
    runSandboxBuild(context, process.argv.length === 5 ? process.argv[4] : process.argv[3]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
