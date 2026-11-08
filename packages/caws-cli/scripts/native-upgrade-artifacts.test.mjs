import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isolatedEnvironment, parseQualificationOptions } from './runtime-upgrade-smoke.mjs';
import {
  stageSelectedTarball,
  verifySelectedTarball,
  verifyInstalledTarballLock,
  captureGovernance,
  captureFailedGovernance,
  verifyGovernancePreserved,
} from './native-upgrade-artifacts.cjs';

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

test('qualifier options require a single exact selected tarball and independent pin', () => {
  const pin = 'a'.repeat(64);
  assert.deepEqual(
    parseQualificationOptions(['--tarball', '/selected.tgz', '--tarball-sha256', pin]),
    {
      tarball: '/selected.tgz',
      tarballSha256: pin,
    }
  );
  assert.deepEqual(parseQualificationOptions([]), {});
  for (const words of [
    ['--tarball', '/selected.tgz'],
    ['--tarball-sha256', pin],
    ['--tarball', '/selected.tgz', '--tarball-sha256', 'unverified'],
    ['--tarball', '/selected.tgz', '--tarball-sha256', pin.toUpperCase()],
    ['--tarball', '/first.tgz', '--tarball', '/second.tgz', '--tarball-sha256', pin],
    ['--report', 'first.json', '--report', 'second.json'],
    ['--package', '--report'],
    ['--unknown', 'value'],
    ['__proto__', 'value'],
    ['constructor', 'value'],
    ['toString', 'value'],
    ['--tarball'],
  ])
    assert.throws(() => parseQualificationOptions(words));
});

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-artifacts-')));
  let retained = false;
  t.after(() => {
    if (!retained) fs.rmSync(root, { recursive: true, force: true });
  });
  const artifacts = path.join(root, 'evidence');
  const staging = path.join(root, 'stage');
  const project = path.join(root, 'project');
  for (const dir of [artifacts, staging, project]) fs.mkdirSync(dir, { mode: 0o700 });
  const governance = path.join(project, '.caws');
  fs.mkdirSync(governance, { mode: 0o750 });
  fs.mkdirSync(path.join(governance, 'specs'), { mode: 0o750 });
  fs.mkdirSync(path.join(governance, 'waivers'), { mode: 0o700 });
  const policy = Buffer.from([0, 255, 13, 10, 128, 65]);
  fs.writeFileSync(path.join(governance, 'policy.yaml'), policy, { mode: 0o640 });
  fs.writeFileSync(path.join(governance, 'specs', 'A.yaml'), 'owned-spec\n', { mode: 0o600 });
  fs.writeFileSync(path.join(governance, 'events.jsonl'), 'owned-event\n', { mode: 0o640 });
  return {
    root,
    artifacts,
    staging,
    project,
    governance,
    policy,
    retain: () => {
      retained = true;
      t.diagnostic(`Unsettled npm fixture retained at ${root}`);
    },
  };
}

test('selected artifact is copied byte-for-byte to a fresh private file', (t) => {
  const f = fixture(t);
  const source = path.join(f.root, 'candidate.tgz');
  const bytes = Buffer.from([31, 139, 0, 255, 128, 10]);
  fs.writeFileSync(source, bytes, { mode: 0o644 });
  const selected = stageSelectedTarball(source, hash(bytes), f.staging);
  assert.equal(selected.source, source);
  assert.equal(selected.sizeBytes, bytes.length);
  assert.deepEqual(fs.readFileSync(selected.path), bytes);
  assert.equal(fs.statSync(selected.path).mode & 0o777, 0o600);
  assert.notEqual(fs.statSync(source).ino, fs.statSync(selected.path).ino);
  fs.writeFileSync(source, 'source changed after capture');
  verifySelectedTarball(selected);
  assert.deepEqual(fs.readFileSync(selected.path), bytes);
  assert.throws(
    () => stageSelectedTarball(source, hash(fs.readFileSync(source)), f.staging),
    /EEXIST/
  );
});

for (const kind of [
  'missing-pin',
  'uppercase-pin',
  'wrong-pin',
  'empty',
  'symlink',
  'hardlink',
  'directory',
  'oversized',
]) {
  test(`selected tarball refuses ${kind} before creating an installable copy`, (t) => {
    const f = fixture(t);
    const source = path.join(f.root, 'candidate.tgz');
    const original = path.join(f.root, 'original');
    fs.writeFileSync(original, 'selected bytes');
    let expected = hash(Buffer.from('selected bytes'));
    if (kind === 'symlink') fs.symlinkSync(original, source);
    else if (kind === 'hardlink') fs.linkSync(original, source);
    else if (kind === 'directory') fs.mkdirSync(source);
    else {
      fs.copyFileSync(original, source);
      if (kind === 'empty') fs.truncateSync(source);
      if (kind === 'oversized') fs.truncateSync(source, 256 * 1024 * 1024 + 1);
    }
    if (kind === 'missing-pin') expected = undefined;
    if (kind === 'uppercase-pin') expected = expected.toUpperCase();
    if (kind === 'wrong-pin') expected = '0'.repeat(64);
    assert.throws(() => stageSelectedTarball(source, expected, f.staging));
    assert.deepEqual(fs.readdirSync(f.staging), []);
    assert.equal(fs.readFileSync(original, 'utf8'), 'selected bytes');
  });
}

for (const change of ['bytes', 'size', 'mode', 'integrity', 'symlink']) {
  test(`staged artifact refuses changed ${change}`, (t) => {
    const f = fixture(t);
    const source = path.join(f.root, 'source');
    fs.writeFileSync(source, 'selected bytes');
    const selected = stageSelectedTarball(source, hash(fs.readFileSync(source)), f.staging);
    if (change === 'bytes') fs.writeFileSync(selected.path, 'altered! bytes');
    if (change === 'size') selected.sizeBytes += 1;
    if (change === 'mode') fs.chmodSync(selected.path, 0o644);
    if (change === 'integrity') selected.integrity = 'sha512-other';
    if (change === 'symlink') {
      fs.unlinkSync(selected.path);
      fs.symlinkSync(source, selected.path);
    }
    assert.throws(() => verifySelectedTarball(selected));
  });
}

test('installed lock must bind both selected tarball integrity and local source', (t) => {
  const f = fixture(t);
  const source = path.join(f.root, 'source');
  fs.writeFileSync(source, 'selected bytes');
  const selected = stageSelectedTarball(source, hash(fs.readFileSync(source)), f.staging);
  const name = '@paths.design/caws-cli';
  const lock = {
    packages: {
      [`node_modules/${name}`]: {
        integrity: selected.integrity,
        resolved: 'file:' + path.relative(f.project, selected.path),
      },
    },
  };
  verifyInstalledTarballLock(lock, f.project, selected, name);
  for (const mutation of [
    (value) => {
      value.packages = {};
    },
    (value) => {
      value.packages[`node_modules/${name}`].integrity = 'sha512-wrong';
    },
    (value) => {
      value.packages[`node_modules/${name}`].resolved = 'https://example.invalid/candidate.tgz';
    },
    (value) => {
      value.packages[`node_modules/${name}`].resolved = 'file:other.tgz';
    },
  ]) {
    const changed = globalThis.structuredClone(lock);
    mutation(changed);
    assert.throws(() => verifyInstalledTarballLock(changed, f.project, selected, name));
  }
});

test('real offline npm installation retains the selected bytes and local integrity', (t) => {
  const f = fixture(t);
  const producer = path.join(f.root, 'producer');
  fs.mkdirSync(producer);
  const name = '@fixture/native-artifact';
  fs.writeFileSync(
    path.join(producer, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', files: ['index.js'] })
  );
  fs.writeFileSync(path.join(producer, 'index.js'), 'module.exports = "artifact-value";\n');
  fs.writeFileSync(path.join(f.project, 'package.json'), '{"private":true}');
  const env = isolatedEnvironment(f.root);
  fs.mkdirSync(env.HOME);
  const npmCli = fs.realpathSync(path.join(path.dirname(process.execPath), 'npm'));
  const npm = (args, cwd) => {
    const result = spawnSync(process.execPath, [npmCli, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.signal || !Number.isInteger(result.status)) f.retain();
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout;
  };
  const packed = JSON.parse(
    npm(['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', f.root], producer)
  );
  const source = path.join(f.root, packed[0].filename);
  const selected = stageSelectedTarball(source, hash(fs.readFileSync(source)), f.staging);
  npm(
    ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', selected.path],
    f.project
  );
  const lock = JSON.parse(fs.readFileSync(path.join(f.project, 'package-lock.json'), 'utf8'));
  verifyInstalledTarballLock(lock, f.project, selected, name);
  assert.equal(
    fs.readFileSync(path.join(f.project, 'node_modules', name, 'index.js'), 'utf8'),
    'module.exports = "artifact-value";\n'
  );
  lock.packages[`node_modules/${name}`].integrity = 'sha512-forged';
  assert.throws(
    () => verifyInstalledTarballLock(lock, f.project, selected, name),
    /selected tarball integrity/
  );
});

test('governance raw bytes, file and empty-directory modes remain verifiable after teardown', (t) => {
  const f = fixture(t);
  const before = captureGovernance(f.project, f.artifacts, 'before');
  const after = captureGovernance(f.project, f.artifacts, 'after');
  fs.rmSync(f.project, { recursive: true });
  assert.equal(verifyGovernancePreserved(before, after, f.artifacts), true);
  const policy = before.entries.find((entry) => entry.path === 'policy.yaml');
  assert.equal(policy.mode, 0o640);
  assert.deepEqual(fs.readFileSync(path.join(f.artifacts, policy.raw)), f.policy);
  assert(
    before.entries.some(
      (entry) => entry.path === 'waivers' && entry.kind === 'directory' && entry.mode === 0o700
    )
  );
  assert.equal(fs.statSync(path.join(f.artifacts, policy.raw)).mode & 0o777, 0o600);
});

for (const change of [
  'bytes',
  'file-mode',
  'directory-mode',
  'root-mode',
  'removed',
  'added',
  'raw-bytes',
  'raw-mode',
  'raw-parent-link',
]) {
  test(`governance proof refuses changed ${change}`, (t) => {
    const f = fixture(t);
    const before = captureGovernance(f.project, f.artifacts, 'before');
    const policy = path.join(f.governance, 'policy.yaml');
    if (change === 'bytes') fs.writeFileSync(policy, 'different governance');
    if (change === 'file-mode') fs.chmodSync(policy, 0o600);
    if (change === 'directory-mode') fs.chmodSync(path.join(f.governance, 'waivers'), 0o750);
    if (change === 'root-mode') fs.chmodSync(f.governance, 0o700);
    if (change === 'removed') fs.unlinkSync(policy);
    if (change === 'added')
      fs.writeFileSync(path.join(f.governance, 'specs', 'B.yaml'), 'unreviewed');
    const after = captureGovernance(f.project, f.artifacts, 'after');
    const retainedPolicy = after.entries.find((entry) => entry.path === 'policy.yaml');
    if (change === 'raw-bytes')
      fs.writeFileSync(path.join(f.artifacts, retainedPolicy.raw), 'different retained data');
    if (change === 'raw-mode') fs.chmodSync(path.join(f.artifacts, retainedPolicy.raw), 0o644);
    if (change === 'raw-parent-link') {
      const afterDirectory = path.join(f.artifacts, 'raw', 'governance', 'after');
      const outside = path.join(f.root, 'moved-after');
      fs.renameSync(afterDirectory, outside);
      fs.symlinkSync(outside, afterDirectory);
    }
    fs.rmSync(f.project, { recursive: true });
    assert.throws(() => verifyGovernancePreserved(before, after, f.artifacts));
  });
}

for (const kind of ['file-link', 'directory-link', 'hardlink', 'fifo']) {
  test(`governance capture refuses ${kind}`, (t) => {
    const f = fixture(t);
    const original = path.join(f.governance, 'policy.yaml');
    if (kind === 'file-link' || kind === 'directory-link') {
      const target =
        kind === 'file-link'
          ? path.join(f.governance, 'specs', 'A.yaml')
          : path.join(f.governance, 'specs');
      fs.unlinkSync(original);
      fs.symlinkSync(target, original);
    } else if (kind === 'hardlink') {
      fs.linkSync(original, path.join(f.root, 'linked-policy'));
    } else {
      // A nonregular file must fail lstat admission before any blocking open.
      fs.unlinkSync(original);
      const { status } = spawnSync('mkfifo', [original]);
      assert.equal(status, 0);
    }
    assert.throws(() => captureGovernance(f.project, f.artifacts, 'before'));
  });
}

test('governance capture refuses an escaping output parent before writing through it', (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.artifacts, 'raw'));
  assert.throws(
    () => captureGovernance(f.project, f.artifacts, 'before'),
    /canonical evidence directory/
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('failed attempt retains changed governance bytes and modes after source teardown', (t) => {
  const f = fixture(t);
  const before = captureGovernance(f.project, f.artifacts, 'before');
  const bytes = Buffer.from([255, 0, 129, 13]);
  fs.writeFileSync(path.join(f.governance, 'policy.yaml'), bytes);
  fs.chmodSync(path.join(f.governance, 'policy.yaml'), 0o600);
  const failed = captureFailedGovernance(f.project, f.artifacts, 'failed');
  fs.rmSync(f.project, { recursive: true });
  assert.equal(failed.complete, true);
  const policy = failed.entries.find((entry) => entry.path === 'policy.yaml');
  assert.equal(policy.mode, 0o600);
  assert.deepEqual(fs.readFileSync(path.join(f.artifacts, policy.raw)), bytes);
  assert.throws(
    () => verifyGovernancePreserved(before, failed, f.artifacts),
    /Governance bytes, membership or modes changed/
  );
});

test('failed attempt retains unsupported kind without following the link or claiming completeness', (t) => {
  const f = fixture(t);
  const before = captureGovernance(f.project, f.artifacts, 'before');
  const outside = path.join(f.root, 'outside-governance');
  fs.writeFileSync(outside, 'must not be captured');
  const policy = path.join(f.governance, 'policy.yaml');
  fs.unlinkSync(policy);
  fs.symlinkSync(outside, policy);
  const failed = captureFailedGovernance(f.project, f.artifacts, 'failed');
  assert.equal(failed.complete, false);
  assert.equal(failed.failures.length, 1);
  assert.equal(failed.failures[0].path, 'policy.yaml');
  assert.equal(failed.failures[0].kind, 'symlink');
  assert.equal(failed.failures[0].link, outside);
  assert(!failed.entries.some((entry) => entry.path === 'policy.yaml'));
  assert(failed.entries.some((entry) => entry.path === 'specs/A.yaml'));
  assert.equal(fs.existsSync(path.join(f.artifacts, 'raw/governance/failed/policy.yaml')), false);
  fs.rmSync(f.project, { recursive: true });
  assert.throws(
    () => verifyGovernancePreserved(before, failed, f.artifacts),
    /capture is incomplete/
  );
});

test('failed attempt records a missing governance root as incomplete', (t) => {
  const f = fixture(t);
  const before = captureGovernance(f.project, f.artifacts, 'before');
  fs.rmSync(f.project, { recursive: true });
  const failed = captureFailedGovernance(f.project, f.artifacts, 'failed');
  assert.equal(failed.complete, false);
  assert.equal(failed.rootMode, null);
  assert.deepEqual(failed.entries, []);
  assert.equal(failed.failures[0].kind, 'missing');
  assert.throws(
    () => verifyGovernancePreserved(before, failed, f.artifacts),
    /capture is incomplete/
  );
});
