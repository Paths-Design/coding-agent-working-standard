import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installCliSnapshot } from './install-cli-snapshot.mjs';

const require = createRequire(import.meta.url);
const cliSource = fileURLToPath(new URL('../packages/caws-cli/', import.meta.url));
const artifactRoot = process.env.CAWS_CLI_SNAPSHOT_ARTIFACT_ROOT;
if (artifactRoot && !path.isAbsolute(artifactRoot))
  throw new Error('Artifact root must be absolute');
let firstFailure;
let sequence = 0;
function observe(root, name, data) {
  const receipts = path.join(root, 'observations');
  fs.mkdirSync(receipts, { recursive: true });
  fs.writeFileSync(
    path.join(receipts, `${String(++sequence).padStart(4, '0')}-${name}.json`),
    JSON.stringify(data, null, 2) + '\n'
  );
}
function activationState(binPath) {
  const entry = fs.lstatSync(binPath, { throwIfNoEntry: false });
  return !entry
    ? { kind: 'absent' }
    : entry.isSymbolicLink()
      ? {
          kind: 'symlink',
          target: fs.readlinkSync(binPath),
          resolvedTarget: fs.realpathSync(binPath),
          targetSha256: crypto.createHash('sha256').update(fs.readFileSync(binPath)).digest('hex'),
        }
      : { kind: 'file', bytes: fs.readFileSync(binPath).toString('base64') };
}
function installationState(options) {
  const asset = path.join(options.packageRoot, 'templates/hook-packs/shared/advisory_truncate.cjs');
  const lock = `${options.binPath}.caws-install.lock`;
  const releases = path.join(options.cawsHome, 'lib/cli');
  return {
    activation: activationState(options.binPath),
    binDirectoryExists: fs.existsSync(path.dirname(options.binPath)),
    machineExists: fs.existsSync(options.cawsHome),
    lockContents: fs.existsSync(lock) ? fs.readFileSync(lock).toString('base64') : null,
    releases: fs.existsSync(releases) ? fs.readdirSync(releases).sort() : null,
    assetBytes: fs.existsSync(asset) ? fs.readFileSync(asset).toString('base64') : null,
  };
}
function installObserved(root, options) {
  const before = installationState(options);
  try {
    const installed = installCliSnapshot(options);
    observe(root, 'install', {
      options,
      before,
      after: installationState(options),
      installed,
    });
    return installed;
  } catch (error) {
    observe(root, 'refusal', {
      options,
      before,
      after: installationState(options),
      error: String(error),
      nonclaims: ['The installer API does not expose successful internal npm subprocess output.'],
    });
    throw error;
  }
}
function invokeObserved(root, command, args, cwd = root) {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd });
  observe(root, 'invoke', {
    command,
    args,
    cwd,
    status: result.status,
    signal: result.signal,
    error: result.error ? String(result.error) : null,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  const raw = path.join(root, 'observations', String(sequence).padStart(4, '0'));
  fs.writeFileSync(raw + '.stdout.bin', result.stdout ?? '');
  fs.writeFileSync(raw + '.stderr.bin', result.stderr ?? '');
  if (result.error || result.signal !== null || !Number.isInteger(result.status))
    throw new Error('Unknown snapshot child outcome; inspect observations in ' + root);
  return result;
}
function snapshotScenario(name, prefix, body) {
  test(name, () => {
    if (firstFailure) throw new Error('Not executed after prior fixture failure: ' + firstFailure);
    if (artifactRoot) fs.mkdirSync(artifactRoot, { recursive: true });
    const root = fs.realpathSync(fs.mkdtempSync(path.join(artifactRoot ?? os.tmpdir(), prefix)));
    let succeeded = false;
    try {
      body(root);
      succeeded = true;
    } catch (error) {
      firstFailure = String(error);
      throw error;
    } finally {
      if (artifactRoot || !succeeded) {
        fs.writeFileSync(
          path.join(root, 'retention.json'),
          JSON.stringify(
            {
              executedRoot: root,
              retainedRoot: root,
              succeeded,
              nonclaims: [
                'Fixture roots remain at their executed location, preserving absolute symlink targets.',
                'Normal child results do not establish birth-pinned descendant cleanup.',
              ],
            },
            null,
            2
          ) + '\n'
        );
      }
      if (succeeded && !artifactRoot) fs.rmSync(root, { recursive: true, force: true });
      else if (!succeeded) console.error('Preserved failed snapshot fixture: ' + root);
    }
  });
}
// Small subprocess scripts exercise installer orchestration only. The actual
// package's license ownership and tar bytes are qualified separately.
function installTransportFixture(
  packageRoot,
  { stageFailure = false, cleanupFailure = false } = {}
) {
  const scripts = path.join(packageRoot, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  const prefix = `import fs from 'node:fs';\nimport path from 'node:path';\nconst root = process.cwd();\nconst marker = path.join(root, 'fixture-transport.txt');\nconst record = event => fs.appendFileSync(path.join(root, 'transport-events.jsonl'), JSON.stringify({event}) + '\\n');\n`;
  fs.writeFileSync(
    path.join(scripts, 'stage-consumer-docs.mjs'),
    prefix +
      `record('stage');\nfs.writeFileSync(marker, 'owned fixture transport');\n` +
      (stageFailure ? `throw new Error('fixture staging failure');\n` : '')
  );
  fs.writeFileSync(
    path.join(scripts, 'clean-staged-docs.mjs'),
    prefix +
      `record('clean');\n` +
      (cleanupFailure
        ? `throw new Error('fixture transport cleanup failure');\n`
        : `fs.rmSync(marker, { force: true });\n`)
  );
}
function transportEvents(packageRoot) {
  const file = path.join(packageRoot, 'transport-events.jsonl');
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line).event)
    : [];
}
function mechanicsFixture(root) {
  const packageRoot = path.join(root, 'source');
  fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({
      name: '@paths.design/caws-cli',
      version: '1.0.0',
      files: ['dist'],
    })
  );
  fs.writeFileSync(path.join(packageRoot, 'dist/index.js'), `console.log('candidate');\n`);
  installGeneratorFixture(packageRoot);
  const previous = path.join(root, 'previous.cjs');
  fs.writeFileSync(previous, `console.log('previous active command');\n`);
  const binPath = path.join(root, 'bin/caws');
  fs.mkdirSync(path.dirname(binPath));
  fs.symlinkSync(previous, binPath);
  return { packageRoot, cawsHome: path.join(root, 'machine'), binPath };
}
function withPackFixture(root, packageRoot, succeeds, body) {
  const commands = path.join(root, 'commands');
  fs.mkdirSync(commands);
  const npm = path.join(commands, 'npm');
  fs.writeFileSync(
    npm,
    `#!${process.execPath}\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(path.join(packageRoot, 'transport-events.jsonl'))}, JSON.stringify({event: args[0]}) + '\\n');\nif (args[0] !== 'pack') throw new Error('Installation must not start before cleanup');\n` +
      (succeeds
        ? `const output = args[args.indexOf('--pack-destination') + 1];\nfs.writeFileSync(path.join(output, 'fixture.tgz'), 'fixture bytes, not a package');\nconsole.log(JSON.stringify([{filename: 'fixture.tgz'}]));\n`
        : `console.log('fixture pack stdout');\nconsole.error('fixture packing failure');\nprocess.exitCode = 41;\n`)
  );
  fs.chmodSync(npm, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = commands + path.delimiter + previousPath;
  try {
    return body();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

function installGeneratorFixture(packageRoot) {
  installTransportFixture(packageRoot);
  for (const relative of [
    'scripts/generate-runtime-assets.mjs',
    'src/runtime/advisory-truncate-entry.ts',
    'src/runtime/utf8.ts',
    'src/runtime/guard-config-entry.ts',
    'src/runtime/guard-config-loader.ts',
    'src/init/repo-hook-policy.ts',
    'src/runtime/json-custody.ts',
    'src/runtime/reprieve-entry.ts',
    'src/runtime/reprieve-reader.ts',
    'templates/hook-packs/shared/advisory_truncate.cjs',
    'templates/hook-packs/shared/lib/guard-config.cjs',
    'templates/hook-packs/shared/lib/reprieve-reader.cjs',
  ]) {
    const destination = path.join(packageRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(cliSource, relative), destination);
    fs.chmodSync(destination, fs.statSync(path.join(cliSource, relative)).mode & 0o777);
  }
  fs.mkdirSync(path.join(packageRoot, 'node_modules'), { recursive: true });
  fs.symlinkSync(
    path.dirname(require.resolve('esbuild/package.json')),
    path.join(packageRoot, 'node_modules/esbuild'),
    'dir'
  );
}

snapshotScenario(
  'standalone activation survives source removal; failed and concurrent installs preserve it',
  'caws-cli-install-test-',
  root => {
    const packageRoot = path.join(root, 'source');
    const cawsHome = path.join(root, 'machine');
    const binPath = path.join(root, 'bin', 'caws');
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@paths.design/caws-cli',
        version: '1.0.0',
        bin: { caws: 'dist/index.js' },
        files: ['dist', 'templates/hook-packs/**'],
      })
    );
    fs.writeFileSync(
      path.join(packageRoot, 'dist', 'value.js'),
      "module.exports = 'working-v1';\n"
    );
    fs.writeFileSync(
      path.join(packageRoot, 'dist', 'index.js'),
      "#!/usr/bin/env node\nconsole.log(process.argv.includes('--json') ? JSON.stringify({digest: 'a'.repeat(64)}) : require('./value'));\n"
    );
    installGeneratorFixture(packageRoot);
    const first = installObserved(root, { packageRoot, cawsHome, binPath });
    assert.equal(Object.hasOwn(first, 'bootstrapInventories'), false);
    assert.deepEqual(transportEvents(packageRoot), ['stage', 'clean']);
    assert.equal(fs.existsSync(path.join(packageRoot, 'fixture-transport.txt')), false);
    const invoke = () => invokeObserved(root, binPath, ['doctor']);
    assert.equal(invoke().stdout.trim(), 'working-v1');
    fs.renameSync(path.join(packageRoot, 'dist'), path.join(packageRoot, 'dist-hidden'));
    assert.equal(invoke().status, 0);
    assert.equal(invoke().stdout.trim(), 'working-v1');
    fs.renameSync(path.join(packageRoot, 'dist-hidden'), path.join(packageRoot, 'dist'));
    fs.writeFileSync(
      path.join(packageRoot, 'dist', 'index.js'),
      "#!/usr/bin/env node\nrequire('./absent-module');\n"
    );
    assert.throws(() => installObserved(root, { packageRoot, cawsHome, binPath }), /absent-module/);
    assert.equal(fs.readlinkSync(binPath), first.target);
    assert.equal(invoke().stdout.trim(), 'working-v1');
    fs.writeFileSync(
      path.join(packageRoot, 'dist', 'index.js'),
      "#!/usr/bin/env node\nconsole.log(process.argv.includes('--json') ? JSON.stringify({digest: (__dirname.includes('node_modules') ? 'b' : 'a').repeat(64)}) : 'candidate');\n"
    );
    assert.throws(
      () => installObserved(root, { packageRoot, cawsHome, binPath }),
      /Packaged runtime differs/
    );
    assert.equal(fs.readlinkSync(binPath), first.target);
    assert.equal(invoke().stdout.trim(), 'working-v1');
    fs.writeFileSync(`${binPath}.caws-install.lock`, 'another installer');
    assert.throws(() => installObserved(root, { packageRoot, cawsHome, binPath }), /EEXIST/);
    assert.equal(fs.readFileSync(`${binPath}.caws-install.lock`, 'utf8'), 'another installer');
    fs.unlinkSync(`${binPath}.caws-install.lock`);
    fs.writeFileSync(
      path.join(packageRoot, 'dist', 'index.js'),
      "#!/usr/bin/env node\nconsole.log(process.argv.includes('--json') ? JSON.stringify({digest: 'b'.repeat(64)}) : 'working-v2');\n"
    );
    const second = installObserved(root, { packageRoot, cawsHome, binPath });
    assert.notEqual(second.target, first.target);
    assert.equal(invoke().stdout.trim(), 'working-v2');
    assert.equal(invokeObserved(root, first.target, ['doctor']).stdout.trim(), 'working-v1');
    fs.unlinkSync(binPath);
    fs.writeFileSync(binPath, 'user executable');
    assert.throws(() => installObserved(root, { packageRoot, cawsHome, binPath }), /non-symlink/);
    assert.equal(fs.readFileSync(binPath, 'utf8'), 'user executable');
  }
);

function bootstrapFixture(root) {
  const options = mechanicsFixture(root);
  const metadataPath = path.join(options.packageRoot, 'package.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  metadata.bin = { caws: 'dist/index.js' };
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  fs.writeFileSync(
    path.join(options.packageRoot, 'dist/index.js'),
    "#!/usr/bin/env node\nconsole.log(process.argv.includes('--json') ? JSON.stringify({digest: 'a'.repeat(64)}) : 'candidate');\n"
  );
  fs.mkdirSync(path.join(options.packageRoot, 'dist/tooling'));
  fs.writeFileSync(
    path.join(options.packageRoot, 'dist/tooling/native-qualification-prepare-entry.js'),
    '// fixture entry identity only; does not perform preparation\n'
  );
  fs.writeFileSync(path.join(options.packageRoot, 'dist/credentials.js'), 'module.exports = {};\n');
  fs.writeFileSync(
    path.join(options.packageRoot, 'dist/credentials-guide.md'),
    'Public module documentation.\n'
  );
  fs.writeFileSync(
    path.join(options.packageRoot, 'dist/certificate.pem'),
    'Public certificate filename fixture; no key material.\n'
  );
  return { ...options, bootstrapInventories: 'v1' };
}

// Faults enter after the normal installer has retained its release and applied
// final entry permissions, immediately before optional inventory capture.
function atInventoryBoundary(options, mutate, body) {
  const originalChmod = fs.chmodSync;
  let retained;
  fs.chmodSync = function (file, ...args) {
    const result = originalChmod.call(fs, file, ...args);
    const suffix = '/install/node_modules/@paths.design/caws-cli/dist/index.js';
    if (
      String(file).startsWith(path.join(options.cawsHome, 'lib/cli') + path.sep) &&
      String(file).endsWith(suffix)
    ) {
      retained = String(file).slice(0, -suffix.length);
      mutate(retained);
    }
    return result;
  };
  try {
    body(() => retained);
  } finally {
    fs.chmodSync = originalChmod;
  }
}

function observedInventoryRows(root) {
  const rows = [];
  function visit(file, relative) {
    const stat = fs.lstatSync(file);
    const common = { path: relative, mode: stat.mode & 0o7777 };
    if (stat.isDirectory()) {
      rows.push({ ...common, type: 'directory' });
      for (const child of fs.readdirSync(file))
        visit(path.join(file, child), relative === '.' ? child : `${relative}/${child}`);
    } else if (stat.isSymbolicLink()) {
      rows.push({ ...common, type: 'symlink', target: fs.readlinkSync(file) });
    } else {
      assert.equal(stat.isFile(), true);
      const bytes = fs.readFileSync(file);
      rows.push({
        ...common,
        type: 'file',
        sizeBytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  visit(root, '.');
  return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

snapshotScenario(
  'bootstrap inventory v1 reports the retained complete prefix and Git view through normal CLI JSON',
  'caws-cli-bootstrap-',
  root => {
    const options = bootstrapFixture(root);
    const result = invokeObserved(root, process.execPath, [
      fileURLToPath(new URL('./install-cli-snapshot.mjs', import.meta.url)),
      '--package',
      options.packageRoot,
      '--caws-home',
      options.cawsHome,
      '--bin',
      options.binPath,
      '--bootstrap-inventories',
      'v1',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const installed = JSON.parse(result.stdout);
    assert.equal(fs.readlinkSync(options.binPath), installed.target);
    assert.deepEqual(Object.keys(installed.bootstrapInventories).sort(), ['gitView', 'prefix']);
    for (const [key, suffix] of [
      ['prefix', 'install'],
      ['gitView', 'probe/.git'],
    ]) {
      const inventory = installed.bootstrapInventories[key];
      const expectedRoot = fs.realpathSync(path.join(installed.release, suffix));
      assert.deepEqual(Object.keys(inventory).sort(), ['entry', 'prefix', 'rows']);
      assert.equal(inventory.prefix, expectedRoot);
      assert.equal(
        inventory.entry,
        key === 'prefix'
          ? path.join(expectedRoot, 'node_modules/@paths.design/caws-cli/dist/index.js')
          : expectedRoot
      );
      assert.deepEqual(inventory.rows, observedInventoryRows(expectedRoot));
      assert.equal(inventory.rows[0].path, '.');
      assert.equal(inventory.rows[0].type, 'directory');
    }
    const rows = installed.bootstrapInventories.prefix.rows;
    assert.equal(
      rows.find(row => row.path === 'node_modules/@paths.design/caws-cli/dist/index.js').mode,
      0o755
    );
    assert.equal(
      rows.find(row => row.path === 'node_modules/.bin/caws').target,
      '../@paths.design/caws-cli/dist/index.js'
    );
    for (const name of [
      'credentials.js',
      'credentials-guide.md',
      'certificate.pem',
      'tooling/native-qualification-prepare-entry.js',
    ])
      assert.equal(
        rows.find(row => row.path === `node_modules/@paths.design/caws-cli/dist/${name}`).type,
        'file'
      );
    assert.equal(
      installed.bootstrapInventories.gitView.rows.some(
        row => row.path === 'config' && row.type === 'file'
      ),
      true
    );
  }
);

snapshotScenario(
  'unknown bootstrap inventory version refuses before filesystem or installer effects',
  'caws-cli-bootstrap-version-',
  root => {
    const options = bootstrapFixture(root);
    const before = installationState(options);
    assert.throws(
      () => installObserved(root, { ...options, bootstrapInventories: 'v2' }),
      /Expected --bootstrap-inventories v1/
    );
    assert.deepEqual(installationState(options), before);
    assert.deepEqual(transportEvents(options.packageRoot), []);
  }
);

const bootstrapFaults = [
  [
    'missing-cli-entry',
    /required entry absent/,
    (release, dist) => fs.unlinkSync(path.join(dist, 'index.js')),
  ],
  [
    'missing-preparation-entry',
    /required entry absent/,
    (release, dist) =>
      fs.unlinkSync(path.join(dist, 'tooling/native-qualification-prepare-entry.js')),
  ],
  [
    'special-permissions',
    /special permission bits/,
    (release, dist) => fs.chmodSync(path.join(dist, 'credentials.js'), 0o4644),
  ],
  [
    'credential-data',
    /protected member name/,
    (release, dist) =>
      fs.writeFileSync(path.join(dist, 'credentials.json'), 'synthetic sentinel, never read'),
  ],
  [
    'private-key-name',
    /protected member name/,
    (release, dist) =>
      fs.writeFileSync(path.join(dist, 'private-key.pem'), 'synthetic sentinel, never read'),
  ],
  [
    'credential-directory',
    /protected member name/,
    release => fs.mkdirSync(path.join(release, 'probe/.git/.ssh')),
  ],
  [
    'root-alias',
    /canonical path/,
    release => {
      fs.renameSync(path.join(release, 'install'), path.join(release, 'held-install'));
      fs.symlinkSync('held-install', path.join(release, 'install'));
    },
  ],
  [
    'non-bin-link',
    /only relative npm .bin/,
    (release, dist) => fs.symlinkSync('credentials.js', path.join(dist, 'link')),
  ],
  [
    'absolute-bin-link',
    /only relative npm .bin/,
    release =>
      fs.symlinkSync(
        path.join(release, 'install/package.json'),
        path.join(release, 'install/node_modules/.bin/absolute')
      ),
  ],
  [
    'escaping-bin-link',
    /link escapes root/,
    release =>
      fs.symlinkSync(
        '../../../probe/.git/config',
        path.join(release, 'install/node_modules/.bin/escape')
      ),
  ],
  [
    'directory-bin-link',
    /inventoried regular file/,
    release =>
      fs.symlinkSync(
        '../@paths.design/caws-cli/dist',
        path.join(release, 'install/node_modules/.bin/directory')
      ),
  ],
  [
    'dangling-bin-link',
    /ENOENT/,
    release =>
      fs.symlinkSync('../absent', path.join(release, 'install/node_modules/.bin/dangling')),
  ],
  [
    'oversized-file',
    /file byte limit/,
    (release, dist) => {
      const file = path.join(dist, 'oversized');
      fs.writeFileSync(file, '');
      fs.truncateSync(file, 512 * 1024 * 1024 + 1);
    },
  ],
  [
    'oversized-tree',
    /total byte limit/,
    (release, dist) => {
      for (let i = 0; i < 5; i++) {
        const file = path.join(dist, `large-${i}`);
        fs.writeFileSync(file, '');
        fs.truncateSync(file, 512 * 1024 * 1024);
      }
    },
  ],
];
for (const [name, reason, mutate] of bootstrapFaults) {
  snapshotScenario(
    `bootstrap ${name} refuses before hashing or activating and retains the unselected release`,
    `caws-cli-bootstrap-${name}-`,
    root => {
      const options = bootstrapFixture(root);
      const before = activationState(options.binPath);
      const originalOpen = fs.openSync;
      let retained,
        inventoryReads = 0;
      fs.openSync = function (file, ...args) {
        if (retained && typeof file === 'string' && file.startsWith(retained + path.sep))
          inventoryReads++;
        return originalOpen.call(fs, file, ...args);
      };
      try {
        atInventoryBoundary(
          options,
          release => {
            mutate(release, path.join(release, 'install/node_modules/@paths.design/caws-cli/dist'));
            retained = release;
          },
          () => {
            assert.throws(
              () => installObserved(root, options),
              error => {
                assert.match(error.message, reason);
                assert.match(error.message, /unselected release retained/);
                assert.equal(error.message.includes(retained), true);
                return true;
              }
            );
          }
        );
      } finally {
        fs.openSync = originalOpen;
      }
      assert.equal(
        inventoryReads,
        0,
        'metadata admission must precede content reads in both roots'
      );
      assert.equal(fs.statSync(retained).isDirectory(), true);
      assert.deepEqual(activationState(options.binPath), before);
      assert.equal(fs.existsSync(`${options.binPath}.caws-install.lock`), false);
      assert.deepEqual(fs.readdirSync(path.join(options.cawsHome, 'lib/cli')), [
        path.basename(retained),
      ]);
    }
  );
}

for (const fault of ['protected-env-name', 'non-utf8-name', 'member-count']) {
  snapshotScenario(
    `bootstrap ${fault} stops directory enumeration before any content read`,
    `caws-cli-bootstrap-${fault}-`,
    root => {
      const options = bootstrapFixture(root);
      const before = activationState(options.binPath);
      const originalOpen = fs.openSync;
      const originalOpendir = fs.opendirSync;
      let retained,
        supplied = 0,
        closed = 0,
        contentOpens = 0;
      fs.openSync = function (file, ...args) {
        if (retained && typeof file === 'string' && file.startsWith(retained + path.sep))
          contentOpens++;
        return originalOpen.call(fs, file, ...args);
      };
      fs.opendirSync = function (directory, ...args) {
        if (!retained || directory !== path.join(retained, 'install'))
          return originalOpendir.call(fs, directory, ...args);
        return {
          readSync() {
            if (supplied >= (fault === 'member-count' ? 200001 : 1)) return null;
            supplied++;
            // Only inject names into the directory API; no environment file or
            // protected content is created, opened or read by this fixture.
            return {
              name:
                fault === 'non-utf8-name'
                  ? Buffer.from([0xff])
                  : Buffer.from(fault === 'protected-env-name' ? '.env' : `member-${supplied}`),
            };
          },
          closeSync() {
            closed++;
          },
        };
      };
      try {
        atInventoryBoundary(
          options,
          release => {
            retained = release;
          },
          () => {
            const reason =
              fault === 'protected-env-name'
                ? /protected member name/
                : fault === 'non-utf8-name'
                  ? /invalid member name/
                  : /member count\/name budget exceeded/;
            assert.throws(() => installObserved(root, options), reason);
          }
        );
      } finally {
        fs.openSync = originalOpen;
        fs.opendirSync = originalOpendir;
      }
      assert.equal(supplied, fault === 'member-count' ? 200000 : 1);
      assert.equal(closed, 1);
      assert.equal(contentOpens, 0);
      assert.deepEqual(activationState(options.binPath), before);
      assert.equal(fs.statSync(retained).isDirectory(), true);
      assert.equal(fs.existsSync(`${options.binPath}.caws-install.lock`), false);
    }
  );
}

for (const fault of ['same-size-replacement', 'added-member', 'retargeted-link']) {
  snapshotScenario(
    `bootstrap ${fault} during hashing refuses activation and retains observed effects`,
    `caws-cli-bootstrap-${fault}-`,
    root => {
      const options = bootstrapFixture(root);
      const before = activationState(options.binPath);
      const originalOpen = fs.openSync,
        originalRead = fs.readSync;
      let retained,
        target,
        watched,
        injected = false;
      fs.openSync = function (file, ...args) {
        const fd = originalOpen.call(fs, file, ...args);
        if (file === target) watched = fd;
        return fd;
      };
      fs.readSync = function (fd, ...args) {
        const result = originalRead.call(fs, fd, ...args);
        if (fd === watched && result > 0 && !injected) {
          injected = true;
          if (fault === 'same-size-replacement') {
            const size = fs.statSync(target).size;
            fs.unlinkSync(target);
            fs.writeFileSync(target, Buffer.alloc(size, 'x'));
          } else if (fault === 'added-member') {
            fs.writeFileSync(path.join(retained, 'install/added-after-enumeration'), 'new member');
          } else {
            const link = path.join(retained, 'install/node_modules/.bin/caws');
            fs.unlinkSync(link);
            fs.symlinkSync('../@paths.design/caws-cli/dist/credentials.js', link);
          }
        }
        return result;
      };
      try {
        atInventoryBoundary(
          options,
          release => {
            retained = release;
            target = path.join(
              release,
              'install/node_modules/@paths.design/caws-cli/dist/credentials.js'
            );
          },
          () => assert.throws(() => installObserved(root, options), /changed|membership/)
        );
      } finally {
        fs.openSync = originalOpen;
        fs.readSync = originalRead;
      }
      assert.equal(
        injected,
        true,
        'hostile change must actually occur while a captured file is read'
      );
      assert.deepEqual(activationState(options.binPath), before);
      assert.equal(fs.statSync(retained).isDirectory(), true);
      assert.equal(fs.existsSync(`${options.binPath}.caws-install.lock`), false);
    }
  );
}

snapshotScenario(
  'snapshot refuses missing or stale typed runtime assets before creating installation state',
  'caws-cli-install-assets-',
  root => {
    const packageRoot = path.join(root, 'source');
    const cawsHome = path.join(root, 'machine');
    const binPath = path.join(root, 'bin/caws');
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@paths.design/caws-cli' })
    );
    assert.throws(
      () => installObserved(root, { packageRoot, cawsHome, binPath }),
      /generator is required/
    );
    assert.equal(fs.existsSync(path.dirname(binPath)), false);
    assert.equal(fs.existsSync(cawsHome), false);
    installGeneratorFixture(packageRoot);
    const asset = path.join(packageRoot, 'templates/hook-packs/shared/advisory_truncate.cjs');
    fs.appendFileSync(asset, '\n// stale source projection\n');
    const before = fs.readFileSync(asset);
    assert.throws(
      () => installObserved(root, { packageRoot, cawsHome, binPath }),
      /missing or stale/
    );
    assert.deepEqual(fs.readFileSync(asset), before);
    assert.equal(fs.existsSync(path.dirname(binPath)), false);
    assert.equal(fs.existsSync(cawsHome), false);
  }
);

snapshotScenario(
  'snapshot requires both transport scripts before staging or locking',
  'caws-cli-install-required-transport-',
  root => {
    for (const missing of [
      ['stage-consumer-docs.mjs', 'clean-staged-docs.mjs'],
      ['stage-consumer-docs.mjs'],
      ['clean-staged-docs.mjs'],
    ]) {
      const fixture = path.join(root, String(missing.length) + '-' + missing[0]);
      fs.mkdirSync(fixture);
      const options = mechanicsFixture(fixture);
      for (const name of missing) fs.unlinkSync(path.join(options.packageRoot, 'scripts', name));
      const before = installationState(options);
      assert.throws(
        () => installObserved(fixture, options),
        /consumer transport script is required/
      );
      assert.deepEqual(installationState(options), before);
      assert.deepEqual(transportEvents(options.packageRoot), []);
    }
  }
);

snapshotScenario(
  'staging failure cleans partial transport before preserving the active command',
  'caws-cli-install-stage-cleanup-',
  root => {
    const options = mechanicsFixture(root);
    installTransportFixture(options.packageRoot, { stageFailure: true });
    const before = activationState(options.binPath);
    assert.throws(() => installObserved(root, options), /fixture staging failure/);
    assert.deepEqual(transportEvents(options.packageRoot), ['stage', 'clean']);
    assert.equal(fs.existsSync(path.join(options.packageRoot, 'fixture-transport.txt')), false);
    assert.deepEqual(activationState(options.binPath), before);
    assert.equal(fs.existsSync(`${options.binPath}.caws-install.lock`), false);
    assert.deepEqual(fs.readdirSync(path.join(options.cawsHome, 'lib/cli')), []);
  }
);

snapshotScenario(
  'CLI retains packing and cleanup failures while releasing the lock',
  'caws-cli-install-pack-cleanup-',
  root => {
    const options = mechanicsFixture(root);
    installTransportFixture(options.packageRoot, { cleanupFailure: true });
    const before = activationState(options.binPath);
    const result = withPackFixture(root, options.packageRoot, false, () =>
      invokeObserved(root, process.execPath, [
        fileURLToPath(new URL('./install-cli-snapshot.mjs', import.meta.url)),
        '--package',
        options.packageRoot,
        '--caws-home',
        options.cawsHome,
        '--bin',
        options.binPath,
      ])
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /fixture packing failure/);
    assert.match(result.stderr, /fixture pack stdout/);
    assert.match(result.stderr, /fixture transport cleanup failure/);
    assert.deepEqual(transportEvents(options.packageRoot), ['stage', 'pack', 'clean']);
    assert.deepEqual(activationState(options.binPath), before);
    assert.equal(fs.existsSync(`${options.binPath}.caws-install.lock`), false);
    assert.deepEqual(fs.readdirSync(path.join(options.cawsHome, 'lib/cli')), []);
  }
);

snapshotScenario(
  'cleanup failure after successful packing prevents installation and activation',
  'caws-cli-install-packed-cleanup-',
  root => {
    const options = mechanicsFixture(root);
    installTransportFixture(options.packageRoot, { cleanupFailure: true });
    const before = activationState(options.binPath);
    withPackFixture(root, options.packageRoot, true, () =>
      assert.throws(() => installObserved(root, options), /fixture transport cleanup failure/)
    );
    assert.deepEqual(transportEvents(options.packageRoot), ['stage', 'pack', 'clean']);
    assert.deepEqual(activationState(options.binPath), before);
    assert.equal(fs.existsSync(`${options.binPath}.caws-install.lock`), false);
    assert.deepEqual(fs.readdirSync(path.join(options.cawsHome, 'lib/cli')), []);
  }
);

snapshotScenario(
  'stage removal and descriptor cleanup faults preserve the original failure and still unlink the lock',
  'caws-cli-install-independent-cleanup-',
  root => {
    const options = mechanicsFixture(root);
    installTransportFixture(options.packageRoot, { stageFailure: true });
    const before = activationState(options.binPath);
    const originalOpen = fs.openSync,
      originalRm = fs.rmSync,
      originalClose = fs.closeSync;
    let lock,
      stageAttempts = 0,
      closeAttempts = 0;
    fs.openSync = function (target, ...args) {
      const fd = originalOpen.call(fs, target, ...args);
      if (target === `${options.binPath}.caws-install.lock`) lock = fd;
      return fd;
    };
    fs.rmSync = function (target, ...args) {
      if (path.dirname(String(target)) === path.join(options.cawsHome, 'lib/cli')) {
        stageAttempts++;
        throw new Error('fixture stage removal failure');
      }
      return originalRm.call(fs, target, ...args);
    };
    fs.closeSync = function (fd) {
      const result = originalClose.call(fs, fd);
      if (fd === lock) {
        lock = undefined;
        closeAttempts++;
        throw new Error('fixture descriptor close outcome failure');
      }
      return result;
    };
    try {
      assert.throws(
        () => installObserved(root, options),
        error => {
          assert.match(error.message, /fixture staging failure/);
          assert.match(error.message, /fixture stage removal failure/);
          assert.match(error.message, /fixture descriptor close outcome failure/);
          return true;
        }
      );
    } finally {
      fs.openSync = originalOpen;
      fs.rmSync = originalRm;
      fs.closeSync = originalClose;
    }
    assert.equal(stageAttempts, 1);
    assert.equal(closeAttempts, 1);
    assert.equal(fs.existsSync(`${options.binPath}.caws-install.lock`), false);
    assert.deepEqual(activationState(options.binPath), before);
    assert.deepEqual(transportEvents(options.packageRoot), ['stage', 'clean']);
    assert.equal(fs.readdirSync(path.join(options.cawsHome, 'lib/cli')).length, 1);
  }
);

snapshotScenario(
  'CLI retains staging and transport cleanup failures without activating',
  'caws-cli-install-double-transport-failure-',
  root => {
    const options = mechanicsFixture(root);
    installTransportFixture(options.packageRoot, { stageFailure: true, cleanupFailure: true });
    const before = activationState(options.binPath);
    const result = invokeObserved(root, process.execPath, [
      fileURLToPath(new URL('./install-cli-snapshot.mjs', import.meta.url)),
      '--package',
      options.packageRoot,
      '--caws-home',
      options.cawsHome,
      '--bin',
      options.binPath,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /fixture staging failure/);
    assert.match(result.stderr, /fixture transport cleanup failure/);
    assert.deepEqual(transportEvents(options.packageRoot), ['stage', 'clean']);
    assert.deepEqual(activationState(options.binPath), before);
    assert.equal(fs.existsSync(`${options.binPath}.caws-install.lock`), false);
    assert.deepEqual(fs.readdirSync(path.join(options.cawsHome, 'lib/cli')), []);
  }
);

snapshotScenario(
  'temporary link cleanup failure still releases the lock and preserves prior activation',
  'caws-cli-install-link-cleanup-',
  root => {
    const options = mechanicsFixture(root);
    fs.writeFileSync(
      path.join(options.packageRoot, 'dist/index.js'),
      "#!/usr/bin/env node\nconsole.log(process.argv.includes('--json') ? JSON.stringify({digest: 'a'.repeat(64)}) : 'candidate');\n"
    );
    const before = activationState(options.binPath);
    const originalRename = fs.renameSync,
      originalRm = fs.rmSync;
    let linkAttempts = 0,
      abandonedLink;
    fs.renameSync = function (from, to) {
      if (to === options.binPath) throw new Error('fixture activation rename failure');
      return originalRename.call(fs, from, to);
    };
    fs.rmSync = function (target, ...args) {
      if (String(target).startsWith(`${options.binPath}.caws-`)) {
        linkAttempts++;
        abandonedLink = String(target);
        throw new Error('fixture temporary link removal failure');
      }
      return originalRm.call(fs, target, ...args);
    };
    try {
      assert.throws(
        () => installObserved(root, options),
        error => {
          assert.match(error.message, /fixture activation rename failure/);
          assert.match(error.message, /fixture temporary link removal failure/);
          return true;
        }
      );
    } finally {
      fs.renameSync = originalRename;
      fs.rmSync = originalRm;
    }
    assert.equal(linkAttempts, 1);
    assert.equal(fs.lstatSync(abandonedLink).isSymbolicLink(), true);
    assert.equal(fs.existsSync(`${options.binPath}.caws-install.lock`), false);
    assert.deepEqual(activationState(options.binPath), before);
    assert.deepEqual(transportEvents(options.packageRoot), ['stage', 'clean']);
    observe(root, 'abandoned-link', {
      path: abandonedLink,
      target: fs.readlinkSync(abandonedLink),
    });
  }
);
