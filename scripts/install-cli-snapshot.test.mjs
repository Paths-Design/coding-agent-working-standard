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
function installGeneratorFixture(packageRoot) {
  for (const relative of [
    'scripts/generate-runtime-assets.mjs',
    'src/runtime/advisory-truncate-entry.ts',
    'src/runtime/utf8.ts',
    'templates/hook-packs/shared/advisory_truncate.cjs',
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
