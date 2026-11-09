'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const root = path.resolve(__dirname, '../../../..');
const readWorkflow = (name) =>
  yaml.load(fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8'));

test('the tag publish job depends on qualification of the same checkout', () => {
  const release = readWorkflow('release.yml');
  // `needs` became a list when the mutation floor was added as a second
  // blocking gate. Assert qualification is still required rather than pinning
  // the arity, which would fail on any future gate. That the mutation gate is
  // also present is owned by release-path-integrity.test.js.
  expect(release.jobs.release.needs).toContain('qualification');
  expect(release.jobs.qualification.uses).toBe('./.github/workflows/release-qualification.yml');
  const qualification = readWorkflow('release-qualification.yml');
  expect(qualification.on).toHaveProperty('workflow_call');
  expect(qualification.on.push.branches).toContain('main');
  const upgrades = qualification.jobs['package-upgrade'];
  expect(upgrades.strategy.matrix.os).toEqual(['ubuntu-latest', 'macos-latest']);
  expect(upgrades.strategy.matrix.node).toEqual(['18', '20', '22']);
  expect(upgrades.needs).toEqual(['candidate-package']);
  const runs = upgrades.steps.map((step) => step.run).filter(Boolean);
  expect(runs).toContain(
    'node packages/caws-cli/scripts/runtime-upgrade-smoke.mjs --report qualification-report.json --tarball selected-candidate/candidate.tgz --tarball-sha256 "$CAWS_SELECTED_TARBALL_SHA256"'
  );
  const invocation = upgrades.steps.find(
    (step) => step.name === 'Install and upgrade the actual candidate package'
  );
  expect(invocation.env.CAWS_SELECTED_TARBALL_SHA256).toBe(
    '${{ needs.candidate-package.outputs.tarball-sha256 }}'
  );
  const download = upgrades.steps.find((step) => step.uses === 'actions/download-artifact@v4');
  expect(download.with).toEqual({
    name: 'candidate-${{ github.sha }}',
    path: 'selected-candidate',
  });
  expect(runs.some((run) => /npm pack/.test(run))).toBe(false);
  const producer = qualification.jobs['candidate-package'];
  expect(producer.outputs['tarball-sha256']).toBe('${{ steps.selected.outputs.sha256 }}');
  expect(producer.steps.find((step) => step.uses === 'actions/upload-artifact@v4').with.name).toBe(
    download.with.name
  );
  expect(qualification.jobs.tests.steps.map((step) => step.run)).toContain(
    'npm test -w @paths.design/caws-cli -- --coverage --maxWorkers=2'
  );
});

function candidateSelectionFixture() {
  const artifactRoot = process.env.CAWS_TEST_ARTIFACT_DIR || os.tmpdir();
  fs.mkdirSync(artifactRoot, { recursive: true });
  const fixture = fs.realpathSync(
    fs.mkdtempSync(path.join(artifactRoot, 'caws-selected-artifact-'))
  );
  const cli = path.join(fixture, 'packages/caws-cli');
  const home = path.join(fixture, 'home');
  fs.mkdirSync(cli, { recursive: true });
  fs.mkdirSync(home);
  fs.writeFileSync(
    path.join(fixture, 'package.json'),
    '{"private":true,"workspaces":["packages/*"]}'
  );
  // This data-only workspace exercises the actual pack and binding steps.
  fs.writeFileSync(
    path.join(cli, 'package.json'),
    JSON.stringify({
      name: '@paths.design/caws-cli',
      version: '1.0.0',
      files: ['payload.bin'],
    })
  );
  fs.writeFileSync(path.join(cli, 'payload.bin'), Buffer.from([0, 255, 128, 13, 10]));
  const env = {
    PATH: [path.dirname(process.execPath), process.env.PATH || ''].join(path.delimiter),
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Artifact fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Artifact fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    npm_config_cache: path.join(fixture, 'npm-cache'),
    npm_config_userconfig: path.join(home, '.npmrc'),
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
    GITHUB_OUTPUT: path.join(fixture, 'github-output'),
  };
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: fixture,
      env,
      encoding: 'utf8',
      timeout: 10000,
    });
    expect({ status: result.status, signal: result.signal }).toEqual({ status: 0, signal: null });
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('add', 'package.json', 'packages');
  git('commit', '-qm', 'artifact input');
  env.GITHUB_SHA = git('rev-parse', 'HEAD');
  const producer = readWorkflow('release-qualification.yml').jobs['candidate-package'];
  const shell = (body) =>
    spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', body], {
      cwd: fixture,
      env,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
  const packed = shell(producer.steps.find((step) => step.name === 'Pack the candidate once').run);
  expect({ status: packed.status, signal: packed.signal }).toEqual({ status: 0, signal: null });
  const directory = path.join(fixture, 'candidate-package');
  const record = JSON.parse(fs.readFileSync(path.join(directory, 'npm-pack.json'), 'utf8'))[0];
  return {
    fixture,
    cli,
    env,
    shell,
    directory,
    record,
    binding: producer.steps.find((step) => step.id === 'selected').run,
    cleanup() {
      if (!process.env.CAWS_TEST_ARTIFACT_DIR) fs.rmSync(fixture, { recursive: true, force: true });
    },
  };
}

test('the actual pack and selection workflow bind one npm artifact to its clean source', () => {
  const f = candidateSelectionFixture();
  try {
    const bytes = fs.readFileSync(path.join(f.directory, f.record.filename));
    const result = f.shell(f.binding);
    expect({ status: result.status, signal: result.signal, stderr: result.stderr }).toEqual({
      status: 0,
      signal: null,
      stderr: '',
    });
    expect(fs.readFileSync(path.join(f.directory, 'candidate.tgz'))).toEqual(bytes);
    const selection = JSON.parse(fs.readFileSync(path.join(f.directory, 'selection.json'), 'utf8'));
    const sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    expect(selection.sourceCommit).toBe(f.env.GITHUB_SHA);
    expect(selection.tarball).toEqual({
      filename: 'candidate.tgz',
      sha256,
      sizeBytes: bytes.length,
      integrity: f.record.integrity,
    });
    expect(fs.readFileSync(f.env.GITHUB_OUTPUT, 'utf8')).toBe(
      `sha256=${sha256}\nsizeBytes=${bytes.length}\n`
    );
    expect(selection.packReceiptSha256).toBe(
      require('node:crypto')
        .createHash('sha256')
        .update(fs.readFileSync(path.join(f.directory, 'npm-pack.json')))
        .digest('hex')
    );
  } finally {
    f.cleanup();
  }
});

test.each([
  'source',
  'dirty',
  'version',
  'extra-record',
  'bytes',
  'sha1',
  'integrity',
  'traversal',
  'symlink',
])('artifact selection refuses changed %s without publishing a selection', (change) => {
  const f = candidateSelectionFixture();
  try {
    const receipt = path.join(f.directory, 'npm-pack.json');
    const records = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    const original = path.join(f.directory, f.record.filename);
    if (change === 'source') f.env.GITHUB_SHA = '0'.repeat(40);
    if (change === 'dirty') fs.appendFileSync(path.join(f.cli, 'payload.bin'), 'changed');
    if (change === 'version') records[0].version = '9.9.9';
    if (change === 'extra-record') records.push({ ...records[0] });
    if (change === 'bytes') fs.appendFileSync(original, 'changed');
    if (change === 'sha1') records[0].shasum = '0'.repeat(40);
    if (change === 'integrity') records[0].integrity = 'sha512-forged';
    if (change === 'traversal') records[0].filename = '../outside.tgz';
    if (change === 'symlink') {
      const target = original + '.target';
      fs.renameSync(original, target);
      fs.symlinkSync(target, original);
    }
    fs.writeFileSync(receipt, JSON.stringify(records));
    const result = f.shell(f.binding);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(f.directory, 'selection.json'))).toBe(false);
    expect(fs.existsSync(f.env.GITHUB_OUTPUT)).toBe(false);
  } finally {
    f.cleanup();
  }
});

test('upgrade transport preserves raw bytes and modes through its actual archive step', () => {
  const steps = readWorkflow('release-qualification.yml').jobs['package-upgrade'].steps;
  const archive = steps.find((step) => step.name === 'Archive upgrade evidence with file modes');
  const upload = steps.find((step) => step.uses === 'actions/upload-artifact@v4');
  expect(archive.if).toBe('always()');
  expect(upload.if).toBe('always()');
  expect(upload.with.path.split('\n')).toContain('qualification-evidence.tgz');
  const fixture = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'caws-upgrade-transport-'))
  );
  try {
    const raw = path.join(fixture, 'qualification-report.json.artifacts', 'raw');
    fs.mkdirSync(raw, { recursive: true });
    const bytes = Buffer.from([0, 255, 128, 10, 13]);
    fs.writeFileSync(path.join(raw, 'governance.bin'), bytes, { mode: 0o600 });
    fs.writeFileSync(path.join(fixture, 'qualification-report.json'), '{"ok":false}');
    fs.symlinkSync('loop', path.join(raw, 'loop'));
    const archived = spawnSync(
      '/bin/bash',
      ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', archive.run],
      { cwd: fixture, encoding: 'utf8', timeout: 10000 }
    );
    expect({ status: archived.status, signal: archived.signal, stderr: archived.stderr }).toEqual({
      status: 0,
      signal: null,
      stderr: '',
    });
    const extracted = path.join(fixture, 'extracted');
    fs.mkdirSync(extracted);
    const result = spawnSync(
      'tar',
      ['-xpzf', path.join(fixture, 'qualification-evidence.tgz'), '-C', extracted],
      { encoding: 'utf8', timeout: 10000 }
    );
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    const retained = path.join(extracted, 'qualification-report.json.artifacts/raw/governance.bin');
    expect(fs.readFileSync(retained)).toEqual(bytes);
    expect(fs.statSync(retained).mode & 0o777).toBe(0o600);
    expect(fs.lstatSync(path.join(path.dirname(retained), 'loop')).isSymbolicLink()).toBe(true);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('prerelease routing and selected-artifact isolation contracts execute under Node', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      ...(process.allowedNodeEnvironmentFlags.has('--test-reporter')
        ? ['--test-reporter=tap']
        : []),
      'scripts/release-tag-publish.test.mjs',
      'scripts/ci-governance-artifacts.test.mjs',
      'scripts/ci-matrix-version.test.mjs',
      'packages/caws-cli/scripts/native-upgrade-artifacts.test.mjs',
    ],
    { cwd: root, encoding: 'utf8' }
  );
  if (result.status !== 0)
    throw new Error(`Node contract execution failed:\n${result.stdout}\n${result.stderr}`);
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  expect(result.stdout).toContain('# fail 0');
});

test('consumer matrix executes occurrence resolution and checks the installed version', () => {
  const steps = readWorkflow('ci-matrix.yml').jobs.matrix.steps;
  expect(steps.find((step) => step.id === 'ver').run).toBe('node scripts/ci-matrix-version.mjs');
  const install = steps.find(
    (step) => step.name === 'Install published CAWS CLI from npm (fresh, global)'
  );
  expect(install.env.CAWS_EXPECTED_VERSION).toBe('${{ steps.ver.outputs.version }}');
  expect(install.run).toContain('test "$ACTUAL_VERSION" = "$CAWS_EXPECTED_VERSION"');
  expect(install.run.indexOf('engine-strict true')).toBeLessThan(
    install.run.indexOf('npm install -g')
  );
  expect(steps.find((step) => step.name === 'Retain exact consumer identity').with.path).toContain(
    'matrix-target.json'
  );
});

test('a failed Bats suite retains raw bytes and does not suppress pytest evidence', () => {
  const steps = readWorkflow('release-qualification.yml').jobs.tests.steps;
  expect(steps.find((step) => step.run === 'npm ci --no-audit --no-fund').id).toBe('dependencies');
  expect(
    steps.find((step) => step.run === 'npm run test:pytest -w @paths.design/caws-cli').if
  ).toBe("${{ !cancelled() && steps.dependencies.outcome == 'success' }}");
  const scopeProbe = steps.find(
    (step) => step.run === 'node --test packages/caws-cli/scripts/scope-runtime-smoke.test.mjs'
  );
  expect(scopeProbe.if).toBe("${{ !cancelled() && steps.build.outcome == 'success' }}");
  const build = steps.find((step) => step.id === 'build');
  expect(build.run).toBe('npm run build -w @paths.design/caws-cli');
  expect(build.if).toBe("${{ !cancelled() && steps.dependencies.outcome == 'success' }}");
  expect(scopeProbe.env.CAWS_TEST_ARTIFACT_DIR).toBe('${{ github.workspace }}/hook-artifacts');
  const archive = steps.find(
    (step) => step.name === 'Archive hook byte artifacts without following fixture symlinks'
  );
  const upload = steps.find((step) => step.name === 'Retain hook byte artifacts');
  expect(archive.if).toBe('always()');
  expect(archive.shell).toBe('bash');
  expect(upload.if).toBe('always()');
  expect(upload.uses).toBe('actions/upload-artifact@v4');
  expect(upload.with.path).toBe('hook-byte-artifacts.tgz');
  expect(upload.with['if-no-files-found']).toBe('warn');
  const batsIndex = steps.findIndex(
    (step) => step.run === 'npm run test:bats -w @paths.design/caws-cli'
  );
  const pytestIndex = steps.findIndex(
    (step) => step.run === 'npm run test:pytest -w @paths.design/caws-cli'
  );
  expect(batsIndex).toBeGreaterThan(-1);
  expect(pytestIndex).toBeGreaterThan(batsIndex);
  expect(steps.indexOf(archive)).toBeGreaterThan(pytestIndex);
  expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(archive));
  expect(
    steps.find((step) => step.run?.startsWith('npm test ')).env.CAWS_RELEASE_ARTIFACT_DIR
  ).toBe('${{ github.workspace }}/release-scenarios');
  const artifactRoot = process.env.CAWS_TEST_ARTIFACT_DIR || os.tmpdir();
  fs.mkdirSync(artifactRoot, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(artifactRoot, 'caws-workflow-archive-'));
  try {
    const hook = path.join(fixture, 'hook-artifacts/project');
    const release = path.join(fixture, 'release-scenarios');
    fs.mkdirSync(path.join(hook, '.caws'), { recursive: true });
    fs.mkdirSync(release);
    const receipt = Buffer.from([0, 0xff, 0xfe, 0x80, 0x0a, 0x7f]);
    const releaseBytes = Buffer.from([0x01, 0, 0xc3, 0x28, 0x0d, 0x0a]);
    fs.writeFileSync(path.join(hook, '.caws/receipt.bin'), receipt);
    fs.writeFileSync(path.join(release, 'raw.bin'), releaseBytes);
    fs.symlinkSync('loop', path.join(hook, 'loop'));
    const runArchive = (cwd = fixture) =>
      spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', archive.run], {
        cwd,
        encoding: 'utf8',
        timeout: 10000,
      });
    const archived = runArchive();
    expect({ status: archived.status, signal: archived.signal, stderr: archived.stderr }).toEqual({
      status: 0,
      signal: null,
      stderr: '',
    });
    const archivePath = path.join(fixture, upload.with.path);
    expect(fs.lstatSync(archivePath).isFile()).toBe(true);
    const listing = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8', timeout: 10000 });
    expect({ status: listing.status, stderr: listing.stderr }).toEqual({ status: 0, stderr: '' });
    expect(listing.stdout.trim().split('\n')).toEqual(
      expect.arrayContaining([
        'hook-artifacts/',
        'hook-artifacts/project/',
        'hook-artifacts/project/.caws/',
        'hook-artifacts/project/.caws/receipt.bin',
        'hook-artifacts/project/loop',
        'release-scenarios/',
        'release-scenarios/raw.bin',
      ])
    );
    const extracted = path.join(fixture, 'extracted');
    fs.mkdirSync(extracted);
    const extraction = spawnSync('tar', ['-xzf', archivePath, '-C', extracted], {
      encoding: 'utf8',
      timeout: 10000,
    });
    expect({ status: extraction.status, stderr: extraction.stderr }).toEqual({
      status: 0,
      stderr: '',
    });
    const extractedLoop = path.join(extracted, 'hook-artifacts/project/loop');
    expect(fs.lstatSync(extractedLoop).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(extractedLoop)).toBe('loop');
    expect(fs.readlinkSync(path.join(hook, 'loop'))).toBe('loop');
    expect(
      fs.readFileSync(path.join(extracted, 'hook-artifacts/project/.caws/receipt.bin'))
    ).toEqual(receipt);
    expect(fs.readFileSync(path.join(extracted, 'release-scenarios/raw.bin'))).toEqual(
      releaseBytes
    );

    // Earlier workflow failures may leave either evidence producer unstarted.
    // Existing evidence must survive independently; no evidence is an explicit
    // no-archive result, not an attempt to archive nonexistent directories.
    for (const [name, directories] of [
      ['hook-only', ['hook-artifacts']],
      ['release-only', ['release-scenarios']],
      ['neither', []],
    ]) {
      const partial = path.join(fixture, name);
      fs.mkdirSync(partial);
      for (const directory of directories) {
        fs.mkdirSync(path.join(partial, directory));
        fs.writeFileSync(path.join(partial, directory, 'evidence.bin'), receipt);
      }
      const result = runArchive(partial);
      expect({ status: result.status, signal: result.signal, stderr: result.stderr }).toEqual({
        status: 0,
        signal: null,
        stderr: '',
      });
      const produced = path.join(partial, upload.with.path);
      expect(fs.existsSync(produced)).toBe(directories.length > 0);
      for (const directory of directories) {
        const contents = spawnSync('tar', ['-xOzf', produced, `${directory}/evidence.bin`], {
          timeout: 10000,
        });
        expect(contents.status).toBe(0);
        expect(contents.stdout).toEqual(receipt);
      }
    }

    // A real output-path conflict must fail the workflow Bash step; it cannot
    // turn an absent archive into apparently successful evidence retention.
    fs.renameSync(archivePath, path.join(fixture, 'retained-success.tgz'));
    fs.mkdirSync(archivePath);
    const failed = runArchive();
    expect(failed.error).toBeUndefined();
    expect(failed.signal).toBeNull();
    expect(failed.status).toBeGreaterThan(0);
    expect(fs.lstatSync(archivePath).isDirectory()).toBe(true);
  } finally {
    if (!process.env.CAWS_TEST_ARTIFACT_DIR) fs.rmSync(fixture, { recursive: true, force: true });
  }
});
