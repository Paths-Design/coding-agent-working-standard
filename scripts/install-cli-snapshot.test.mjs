import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installCliSnapshot } from './install-cli-snapshot.mjs';

const require = createRequire(import.meta.url);
const cliSource = fileURLToPath(new URL('../packages/caws-cli/', import.meta.url));
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

test('standalone activation survives source removal; failed and concurrent installs preserve it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-cli-install-test-'));
  try {
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
    const first = installCliSnapshot({ packageRoot, cawsHome, binPath });
    const invoke = () => spawnSync(binPath, ['doctor'], { encoding: 'utf8', cwd: root });
    assert.equal(invoke().stdout.trim(), 'working-v1');
    fs.renameSync(path.join(packageRoot, 'dist'), path.join(packageRoot, 'dist-hidden'));
    assert.equal(invoke().status, 0);
    assert.equal(invoke().stdout.trim(), 'working-v1');
    fs.renameSync(path.join(packageRoot, 'dist-hidden'), path.join(packageRoot, 'dist'));
    fs.writeFileSync(
      path.join(packageRoot, 'dist', 'index.js'),
      "#!/usr/bin/env node\nrequire('./absent-module');\n"
    );
    assert.throws(() => installCliSnapshot({ packageRoot, cawsHome, binPath }), /absent-module/);
    assert.equal(fs.readlinkSync(binPath), first.target);
    assert.equal(invoke().stdout.trim(), 'working-v1');
    fs.writeFileSync(
      path.join(packageRoot, 'dist', 'index.js'),
      "#!/usr/bin/env node\nconsole.log(process.argv.includes('--json') ? JSON.stringify({digest: (__dirname.includes('node_modules') ? 'b' : 'a').repeat(64)}) : 'candidate');\n"
    );
    assert.throws(
      () => installCliSnapshot({ packageRoot, cawsHome, binPath }),
      /Packaged runtime differs/
    );
    assert.equal(fs.readlinkSync(binPath), first.target);
    assert.equal(invoke().stdout.trim(), 'working-v1');
    fs.writeFileSync(`${binPath}.caws-install.lock`, 'another installer');
    assert.throws(() => installCliSnapshot({ packageRoot, cawsHome, binPath }), /EEXIST/);
    assert.equal(fs.readFileSync(`${binPath}.caws-install.lock`, 'utf8'), 'another installer');
    fs.unlinkSync(`${binPath}.caws-install.lock`);
    fs.writeFileSync(
      path.join(packageRoot, 'dist', 'index.js'),
      "#!/usr/bin/env node\nconsole.log(process.argv.includes('--json') ? JSON.stringify({digest: 'b'.repeat(64)}) : 'working-v2');\n"
    );
    const second = installCliSnapshot({ packageRoot, cawsHome, binPath });
    assert.notEqual(second.target, first.target);
    assert.equal(invoke().stdout.trim(), 'working-v2');
    assert.equal(
      spawnSync(first.target, ['doctor'], { encoding: 'utf8' }).stdout.trim(),
      'working-v1'
    );
    fs.unlinkSync(binPath);
    fs.writeFileSync(binPath, 'user executable');
    assert.throws(() => installCliSnapshot({ packageRoot, cawsHome, binPath }), /non-symlink/);
    assert.equal(fs.readFileSync(binPath, 'utf8'), 'user executable');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('snapshot refuses missing or stale typed runtime assets before creating installation state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-cli-install-assets-'));
  try {
    const packageRoot = path.join(root, 'source');
    const cawsHome = path.join(root, 'machine');
    const binPath = path.join(root, 'bin/caws');
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@paths.design/caws-cli' })
    );
    assert.throws(
      () => installCliSnapshot({ packageRoot, cawsHome, binPath }),
      /generator is required/
    );
    assert.equal(fs.existsSync(path.dirname(binPath)), false);
    assert.equal(fs.existsSync(cawsHome), false);
    installGeneratorFixture(packageRoot);
    const asset = path.join(packageRoot, 'templates/hook-packs/shared/advisory_truncate.cjs');
    fs.appendFileSync(asset, '\n// stale source projection\n');
    const before = fs.readFileSync(asset);
    assert.throws(() => installCliSnapshot({ packageRoot, cawsHome, binPath }), /missing or stale/);
    assert.deepEqual(fs.readFileSync(asset), before);
    assert.equal(fs.existsSync(path.dirname(binPath)), false);
    assert.equal(fs.existsSync(cawsHome), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
