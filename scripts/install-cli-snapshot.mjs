#!/usr/bin/env node
// Install a standalone package before atomically switching the global command.
// Never point a shared CLI at a checkout whose build deletes dist/.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const inventoryLimits = {
  rows: 200000,
  file: 512 * 1024 * 1024,
  total: 2 * 1024 ** 3,
  json: 16 * 1024 * 1024,
};
const cliRelativeEntry = 'node_modules/@paths.design/caws-cli/dist/index.js';
const preparationRelativeEntry =
  'node_modules/@paths.design/caws-cli/dist/tooling/native-qualification-prepare-entry.js';

function inventoryRequire(condition, reason) {
  if (!condition) throw new Error(`Bootstrap inventory: ${reason}`);
}

function protectedInventoryName(name) {
  const lower = name.toLowerCase();
  return (
    lower.startsWith('.env') ||
    lower.endsWith('.env') ||
    /^(?:credentials(?:\.(?:json|ya?ml|toml|ini|conf))?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pem)?)$/.test(
      lower
    ) ||
    /(?:^|[._-])(?:private(?:[._-]?key)?|key)\.pem$/.test(lower) ||
    /\.(?:key|p12|pfx)$/.test(lower) ||
    [
      '.aws',
      '.ssh',
      '.azure',
      '.kube',
      '.gnupg',
      '.npmrc',
      '.netrc',
      '.git-credentials',
      '.pypirc',
    ].includes(lower)
  );
}

function inventoryStamp(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.uid,
    stat.gid,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(':');
}

function inventoryStat(file) {
  return fs.lstatSync(file, { bigint: true });
}

function inventoryPhysical(file) {
  inventoryRequire(!file.split(path.sep).some(protectedInventoryName), 'protected path component');
  inventoryRequire(
    path.isAbsolute(file) && Buffer.byteLength(file) <= 4096 && fs.realpathSync(file) === file,
    'expected a bounded canonical path'
  );
}

function inventoryChildren(directory, consume = () => {}) {
  const names = [];
  const handle = fs.opendirSync(directory, { encoding: 'buffer', bufferSize: 32 });
  try {
    let child;
    while ((child = handle.readSync()) !== null) {
      const raw = Buffer.from(child.name);
      const name = raw.toString('utf8');
      inventoryRequire(
        Buffer.from(name).equals(raw) &&
          name.length > 0 &&
          name !== '.' &&
          name !== '..' &&
          !/[\0\\/]/.test(name),
        'invalid member name'
      );
      inventoryRequire(!protectedInventoryName(name), 'protected member name');
      consume(name);
      names.push(name);
      inventoryRequire(names.length <= inventoryLimits.rows, 'directory member limit exceeded');
    }
  } finally {
    handle.closeSync();
  }
  return names.sort();
}

// Enumerate names and types before hashing either root. A complete inventory
// cannot omit protected members, and must refuse them without reading content.
function inventoryMetadata(root, relativeEntry) {
  inventoryPhysical(root);
  const entries = new Map();
  const pending = [{ file: root, name: '.' }];
  let discovered = 1,
    nameBytes = 1,
    total = 0,
    encoded = Buffer.byteLength(root) * 2 + 128;
  while (pending.length) {
    const { file, name } = pending.pop();
    inventoryRequire(
      Buffer.byteLength(file) <= 4096 && Buffer.byteLength(name) <= 4096,
      'path limit exceeded'
    );
    const stat = inventoryStat(file);
    const mode = Number(stat.mode & 0o7777n);
    inventoryRequire(mode <= 0o777, 'special permission bits refused');
    const row = { path: name, type: '', mode };
    const item = { file, stat, row };
    if (stat.isDirectory()) {
      inventoryPhysical(file);
      row.type = 'directory';
      item.children = inventoryChildren(file, child => {
        const relative = name === '.' ? child : `${name}/${child}`;
        discovered++;
        nameBytes += Buffer.byteLength(relative);
        inventoryRequire(
          discovered <= inventoryLimits.rows && nameBytes <= inventoryLimits.json,
          'member count/name budget exceeded'
        );
        pending.push({ file: path.join(file, child), name: relative });
      });
      inventoryRequire(
        inventoryStamp(stat) === inventoryStamp(inventoryStat(file)),
        'directory changed during enumeration'
      );
    } else if (stat.isSymbolicLink()) {
      row.type = 'symlink';
      const raw = fs.readlinkSync(file, { encoding: 'buffer' });
      row.target = raw.toString('utf8');
      inventoryRequire(
        Buffer.from(row.target).equals(raw) &&
          row.target.length > 0 &&
          Buffer.byteLength(row.target) <= 4096 &&
          !/[\0\\]/.test(row.target) &&
          !path.isAbsolute(row.target) &&
          path.basename(path.dirname(file)) === '.bin',
        'only relative npm .bin links are admitted'
      );
    } else {
      inventoryRequire(stat.isFile(), 'special member refused');
      inventoryPhysical(file);
      inventoryRequire(stat.size <= BigInt(inventoryLimits.file), 'file byte limit exceeded');
      row.type = 'file';
      row.sizeBytes = Number(stat.size);
      row.sha256 = '0'.repeat(64);
      total += row.sizeBytes;
      inventoryRequire(total <= inventoryLimits.total, 'total byte limit exceeded');
    }
    encoded += Buffer.byteLength(JSON.stringify(row)) + 1;
    inventoryRequire(encoded <= inventoryLimits.json, 'encoded inventory limit exceeded');
    inventoryRequire(!entries.has(name), 'duplicate member');
    entries.set(name, item);
  }
  inventoryRequire(entries.get('.')?.row.type === 'directory', 'root must be a directory');
  if (relativeEntry !== '.') {
    for (const required of [cliRelativeEntry, preparationRelativeEntry])
      inventoryRequire(
        entries.get(required)?.row.type === 'file',
        `required entry absent: ${required}`
      );
  }
  for (const item of entries.values()) {
    if (item.row.type !== 'symlink') continue;
    const lexical = path.resolve(path.dirname(item.file), item.row.target);
    inventoryRequire(lexical.startsWith(root + path.sep), 'link escapes root');
    const resolved = fs.realpathSync(item.file);
    inventoryRequire(
      resolved.startsWith(root + path.sep) &&
        entries.get(path.relative(root, resolved))?.row.type === 'file',
      'link must resolve to an inventoried regular file'
    );
    item.resolved = resolved;
  }
  return { root, entries, entry: relativeEntry === '.' ? root : path.join(root, relativeEntry) };
}

function inventoryHash(item) {
  inventoryPhysical(item.file);
  const fd = fs.openSync(
    item.file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    inventoryRequire(
      before.isFile() && inventoryStamp(before) === inventoryStamp(item.stat),
      'file changed before capture'
    );
    const hash = crypto.createHash('sha256');
    const block = Buffer.alloc(65536);
    let count = 0,
      size;
    while ((size = fs.readSync(fd, block, 0, block.length, null)) !== 0) {
      count += size;
      inventoryRequire(
        count <= item.row.sizeBytes && count <= inventoryLimits.file,
        'file grew during capture'
      );
      hash.update(block.subarray(0, size));
    }
    inventoryRequire(
      count === item.row.sizeBytes &&
        inventoryStamp(before) === inventoryStamp(fs.fstatSync(fd, { bigint: true })) &&
        inventoryStamp(before) === inventoryStamp(inventoryStat(item.file)),
      'file changed during capture'
    );
    item.row.sha256 = hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function inventoryRecheck(tree) {
  inventoryPhysical(tree.root);
  for (const item of tree.entries.values()) {
    inventoryRequire(
      inventoryStamp(item.stat) === inventoryStamp(inventoryStat(item.file)),
      'member changed after capture'
    );
    if (item.row.type === 'directory') {
      inventoryPhysical(item.file);
      const names = inventoryChildren(item.file);
      inventoryRequire(
        names.length === item.children.length &&
          names.every((name, index) => name === item.children[index]),
        'directory membership changed'
      );
      inventoryRequire(
        inventoryStamp(item.stat) === inventoryStamp(inventoryStat(item.file)),
        'directory changed during recheck'
      );
    } else if (item.row.type === 'symlink') {
      inventoryRequire(
        fs.readlinkSync(item.file) === item.row.target &&
          fs.realpathSync(item.file) === item.resolved,
        'link changed after capture'
      );
    } else inventoryPhysical(item.file);
  }
}

function bootstrapInventories(release) {
  inventoryRequire(inventoryStat(release).isDirectory(), 'retained release must be a directory');
  const physicalRelease = fs.realpathSync(release);
  const prefix = inventoryMetadata(path.join(physicalRelease, 'install'), cliRelativeEntry);
  const gitView = inventoryMetadata(path.join(physicalRelease, 'probe', '.git'), '.');
  for (const tree of [prefix, gitView])
    for (const item of tree.entries.values()) if (item.row.type === 'file') inventoryHash(item);
  for (const tree of [prefix, gitView]) inventoryRecheck(tree);
  const result = {};
  for (const [key, tree] of [
    ['prefix', prefix],
    ['gitView', gitView],
  ]) {
    const inventory = {
      entry: tree.entry,
      prefix: tree.root,
      rows: [...tree.entries.values()]
        .map(item => item.row)
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    };
    inventoryRequire(
      Buffer.byteLength(JSON.stringify(inventory, null, 2)) <= inventoryLimits.json,
      'serialized inventory limit exceeded'
    );
    result[key] = inventory;
  }
  return result;
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (exit ${result.status}, signal ${result.signal ?? 'none'}): ${result.error?.message ?? ''}\nstdout: ${result.stdout ?? ''}\nstderr: ${result.stderr ?? ''}`
    );
  }
  return result.stdout;
}

export function installCliSnapshot({
  packageRoot,
  cawsHome,
  binPath,
  bootstrapInventories: inventoryVersion,
}) {
  if (inventoryVersion !== undefined && inventoryVersion !== 'v1')
    throw new Error('Expected --bootstrap-inventories v1');
  if (inventoryVersion === 'v1' && process.platform === 'win32')
    throw new Error('Bootstrap inventories require a POSIX filesystem');
  packageRoot = fs.realpathSync(packageRoot);
  cawsHome = path.resolve(cawsHome);
  binPath = path.resolve(binPath);
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (metadata.name !== '@paths.design/caws-cli') throw new Error('Expected the CAWS CLI package');
  // Packing below disables lifecycle scripts. Reject equally stale source and
  // package projections before staging, locking or changing the active command.
  const runtimeGenerator = path.join(packageRoot, 'scripts', 'generate-runtime-assets.mjs');
  if (!fs.statSync(runtimeGenerator, { throwIfNoEntry: false })?.isFile())
    throw new Error('Source runtime asset generator is required before CLI snapshot installation');
  run(process.execPath, [runtimeGenerator, '--check'], packageRoot);
  const stageDocs = path.join(packageRoot, 'scripts', 'stage-consumer-docs.mjs');
  const cleanDocs = path.join(packageRoot, 'scripts', 'clean-staged-docs.mjs');
  for (const script of [stageDocs, cleanDocs]) {
    if (!fs.statSync(script, { throwIfNoEntry: false })?.isFile())
      throw new Error(
        `Source consumer transport script is required before CLI snapshot installation: ${script}`
      );
  }
  const previous = fs.lstatSync(binPath, { throwIfNoEntry: false });
  if (previous && !previous.isSymbolicLink())
    throw new Error(`Refusing to replace non-symlink ${binPath}`);
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  const lockPath = `${binPath}.caws-install.lock`;
  const lock = fs.openSync(lockPath, 'wx', 0o600);
  let stage;
  let temporaryLink;
  let installed;
  const failures = [];
  const failedCleanup = (label, action) => {
    try {
      action();
    } catch (error) {
      failures.push(
        new Error(`Snapshot cleanup failed (${label}): ${error.message}`, { cause: error })
      );
    }
  };
  try {
    const releases = path.join(cawsHome, 'lib', 'cli');
    fs.mkdirSync(releases, { recursive: true });
    stage = fs.mkdtempSync(path.join(releases, '.install-'));
    let packed;
    const transportFailures = [];
    try {
      run(process.execPath, [stageDocs], packageRoot);
      packed = JSON.parse(
        run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', stage], packageRoot)
      );
    } catch (error) {
      transportFailures.push(error);
    } finally {
      // --ignore-scripts skips postpack too. Finish source transport cleanup
      // before installing, probing or activating any packed candidate.
      try {
        run(process.execPath, [cleanDocs], packageRoot);
      } catch (error) {
        transportFailures.push(
          new Error(`Consumer transport cleanup failed: ${error.message}`, { cause: error })
        );
      }
    }
    if (transportFailures.length) throw combinedFailure(transportFailures);
    const tarball = path.join(stage, path.basename(packed[0].filename));
    const digest = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
    const install = path.join(stage, 'install');
    fs.mkdirSync(install);
    fs.writeFileSync(path.join(install, 'package.json'), JSON.stringify({ private: true }));
    run(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--prefix',
        install,
        tarball,
      ],
      stage
    );
    const candidate = path.join(install, 'node_modules', '@paths.design', 'caws-cli');
    const entry = path.join(candidate, 'dist', 'index.js');
    // Probe outside the checkout, with isolated machine state and no Git overrides.
    const probe = path.join(stage, 'probe');
    fs.mkdirSync(probe);
    const env = { ...process.env, CAWS_HOME: path.join(probe, 'machine') };
    for (const key of Object.keys(env)) {
      if (
        key.startsWith('GIT_') ||
        /^(CODEX_THREAD_ID|CAWS_SESSION_ID|CLAUDE_SESSION_ID)$/.test(key)
      )
        delete env[key];
    }
    run(process.execPath, [entry, '--help'], probe, env);
    run('git', ['init', '-q'], probe, env);
    run(process.execPath, [entry, 'init'], probe, env);
    run(process.execPath, [entry, 'doctor'], probe, env);
    // Tarball truth: dependency resolution and packaged templates must produce
    // the same runtime as the build being installed, before any activation.
    const runtimeArgs = ['init', 'adapters', 'install', '--plan', '--json'];
    const sourceRuntime = JSON.parse(
      run(
        process.execPath,
        [path.join(packageRoot, 'dist', 'index.js'), ...runtimeArgs],
        probe,
        env
      )
    );
    const packagedRuntime = JSON.parse(run(process.execPath, [entry, ...runtimeArgs], probe, env));
    if (
      !/^[a-f0-9]{64}$/.test(sourceRuntime.digest) ||
      sourceRuntime.digest !== packagedRuntime.digest
    ) {
      throw new Error(
        `Packaged runtime differs from development build: ${packagedRuntime.digest} != ${sourceRuntime.digest}; reconcile dependencies and rebuild before installation`
      );
    }

    // The directory and dependencies are retained unchanged after activation.
    const release = path.join(releases, `${digest.slice(0, 16)}-${path.basename(stage).slice(9)}`);
    fs.renameSync(stage, release);
    stage = undefined;
    const target = path.join(
      release,
      'install',
      'node_modules',
      '@paths.design',
      'caws-cli',
      'dist',
      'index.js'
    );
    fs.chmodSync(target, 0o755);
    let inventories;
    if (inventoryVersion === 'v1') {
      try {
        inventories = bootstrapInventories(release);
      } catch (error) {
        throw new Error(
          `Bootstrap inventory failed; unselected release retained at ${release}; command unchanged: ${error.message}`,
          { cause: error }
        );
      }
    }
    temporaryLink = `${binPath}.caws-${crypto.randomUUID()}`;
    fs.symlinkSync(target, temporaryLink);
    fs.renameSync(temporaryLink, binPath);
    temporaryLink = undefined;
    installed = {
      release,
      binPath,
      target,
      packageSha256: digest,
      runtimeDigest: packagedRuntime.digest,
      version: metadata.version,
      ...(inventories ? { bootstrapInventories: inventories } : {}),
    };
  } catch (error) {
    failures.push(error);
  } finally {
    // Each cleanup is independent: an abandoned link or stage must not prevent
    // the lock descriptor and pathname from being released.
    if (temporaryLink)
      failedCleanup('temporary link', () => fs.rmSync(temporaryLink, { force: true }));
    if (stage)
      failedCleanup('installation stage', () => fs.rmSync(stage, { recursive: true, force: true }));
    failedCleanup('lock descriptor', () => fs.closeSync(lock));
    failedCleanup('lock pathname', () => fs.unlinkSync(lockPath));
  }
  if (failures.length) throw combinedFailure(failures);
  return installed;
}

function combinedFailure(errors) {
  if (errors.length === 1) return errors[0];
  return new AggregateError(errors, errors.map(error => error.message).join('\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (
        !['--package', '--caws-home', '--bin', '--bootstrap-inventories'].includes(args[i]) ||
        !args[i + 1]
      )
        throw new Error(
          'Usage: node scripts/install-cli-snapshot.mjs --package <built-cli-package> --bin <global-caws-symlink> [--caws-home <dir>] [--bootstrap-inventories v1]'
        );
      options[args[i]] = args[i + 1];
    }
    if (!options['--package'] || !options['--bin'])
      throw new Error('--package and --bin are required');
    console.log(
      JSON.stringify(
        installCliSnapshot({
          packageRoot: options['--package'],
          cawsHome:
            options['--caws-home'] ?? process.env.CAWS_HOME ?? path.join(os.homedir(), '.caws'),
          binPath: options['--bin'],
          bootstrapInventories: options['--bootstrap-inventories'],
        }),
        null,
        2
      )
    );
  } catch (error) {
    console.error(`install-cli-snapshot: ${error.message}`);
    process.exitCode = 1;
  }
}
