import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  parseTag,
  publicationArgs,
  releaseArgs,
  publishEnvironment,
  isRegistryCredential,
  verifyCandidate,
} from './release-tag-publish.mjs';
import crypto from 'node:crypto';
import { isolatedEnvironment } from '../packages/caws-cli/scripts/runtime-upgrade-smoke.mjs';

test('stable and prerelease publications select distinct npm channels', () => {
  assert.deepEqual(publicationArgs('12.2.0'), [
    'publish',
    '--access',
    'public',
    '--provenance',
    '--tag',
    'latest',
  ]);
  assert.deepEqual(publicationArgs('12.2.0-rc.1'), [
    'publish',
    '--access',
    'public',
    '--provenance',
    '--tag',
    'next',
  ]);
  assert.equal(parseTag('caws-cli-v12.2.0-rc.1').version, '12.2.0-rc.1');
});

test('malformed versions cannot reach npm or a release', () => {
  for (const version of [
    '01.2.3',
    '1.2.3-',
    '1.2.3-01',
    '1.2.3-rc..1',
    '1.2.3+',
    '1.2.3 --tag latest',
  ]) {
    assert.equal(parseTag(`caws-cli-v${version}`).ok, false, version);
    assert.throws(() => publicationArgs(version), /version/);
  }
});

test('GitHub prereleases are marked and multiline notes use a file', () => {
  const stable = releaseArgs('caws-cli-v12.2.0', '12.2.0', '/tmp/notes.md');
  assert.deepEqual(stable, [
    'release',
    'create',
    'caws-cli-v12.2.0',
    '--title',
    'caws-cli-v12.2.0',
    '--notes-file',
    '/tmp/notes.md',
    '--verify-tag',
  ]);
  assert.deepEqual(releaseArgs('caws-cli-v12.2.0-rc.1', '12.2.0-rc.1', '/tmp/notes.md'), [
    'release',
    'create',
    'caws-cli-v12.2.0-rc.1',
    '--title',
    'caws-cli-v12.2.0-rc.1',
    '--notes-file',
    '/tmp/notes.md',
    '--verify-tag',
    '--prerelease',
  ]);
});

test('upgrade processes cannot inherit live machine state or agent/Git authority', () => {
  const env = isolatedEnvironment('/tmp/qualification', {
    PATH: '/usr/bin',
    HOME: '/real',
    CAWS_HOME: '/real/.caws',
    CODEX_THREAD_ID: 'real-agent',
    GIT_DIR: '/foreign/.git',
    NPM_TOKEN: 'private',
  });
  assert.equal(env.HOME, '/tmp/qualification/home');
  assert.equal(env.CAWS_HOME, '/tmp/qualification/home/.caws');
  assert.equal(env.PATH, '/usr/bin');
  for (const key of ['CODEX_THREAD_ID', 'GIT_DIR', 'NPM_TOKEN']) assert.equal(env[key], undefined);
  assert.equal(env.npm_config_userconfig, '/tmp/qualification/home/.npmrc');
});

test('an uncertain npm publish result preserves the tag and reports recovery', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-publish-failure-')));
  try {
    const write = (name, content) => {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return file;
    };
    write(
      'scripts/release-tag-publish.mjs',
      fs.readFileSync(new URL('./release-tag-publish.mjs', import.meta.url))
    );
    write('packages/caws-cli/package.json', JSON.stringify({ version: '12.2.0-rc.1' }));
    write('packages/caws-cli/CHANGELOG.md', '## [12.2.0-rc.1]\n\nCandidate.\n');
    const calls = path.join(root, 'calls.jsonl');
    for (const command of ['npm', 'npx', 'gh']) {
      const file = write(
        `bin/${command}`,
        `#!${process.execPath}\n` +
          `const fs = require('node:fs'); const args = process.argv.slice(2);\n` +
          `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({command:${JSON.stringify(command)},args})+'\\n');\n` +
          `if (${JSON.stringify(command)} === 'npm' && args[0] === 'publish') process.exit(1);\n` +
          `if (${JSON.stringify(command)} === 'npm' && args[0] === 'view') process.stdout.write('12.2.0-rc.1\\n');\n`
      );
      fs.chmodSync(file, 0o755);
    }
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'scripts/release-tag-publish.mjs'), 'caws-cli-v12.2.0-rc.1'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...isolatedEnvironment(root),
          PATH: path.join(root, 'bin'),
          NPM_TOKEN: 'fixture-only',
          GITHUB_REPOSITORY: 'fixture/repo',
        },
      }
    );
    assert.ok(fs.existsSync(calls), result.stdout + result.stderr);
    const invoked = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(
      invoked.some(call => call.command === 'npm' && call.args[0] === 'publish'),
      true
    );
    assert.deepEqual(
      invoked.filter(call => call.command === 'gh'),
      [],
      'uncertain publication must not delete the tag or manufacture a release'
    );
    assert.equal(result.status, 30, result.stdout + result.stderr);
    assert.match(result.stdout, /"tag_preserved":true/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OIDC publication cannot inherit a registry credential from the environment', () => {
  const inherited = {
    PATH: '/usr/bin',
    HOME: '/home/runner',
    NODE_AUTH_TOKEN: 'ambient-from-setup-node',
    NPM_CONFIG__AUTH: 'ambient-legacy',
    npm_config__authToken: 'ambient-scoped',
    'npm_config_//registry.npmjs.org/:_authToken': 'ambient-registry-scoped',
  };
  const { env, removed } = publishEnvironment({ hasNpmToken: false, inherited });
  // npm performs the trusted-publisher exchange only when NO credential is
  // configured; any survivor here silently downgrades the publish to token auth.
  for (const key of [
    'NODE_AUTH_TOKEN',
    'NPM_CONFIG__AUTH',
    'npm_config__authToken',
    'npm_config_//registry.npmjs.org/:_authToken',
  ]) {
    assert.equal(env[key], undefined, `${key} must not reach the publish child`);
  }
  assert.deepEqual(
    removed,
    [
      'NODE_AUTH_TOKEN',
      'NPM_CONFIG__AUTH',
      'npm_config_//registry.npmjs.org/:_authToken',
      'npm_config__authToken',
    ].sort()
  );
  // Non-credential environment is preserved; this is isolation, not a wipe.
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/runner');
});

test('token publication reinstates exactly one credential source', () => {
  const { env, removed } = publishEnvironment({
    hasNpmToken: true,
    inherited: {
      PATH: '/usr/bin',
      NPM_TOKEN: 'the-real-token',
      npm_config__authToken: 'stale-ambient',
    },
  });
  assert.equal(env.NPM_TOKEN, 'the-real-token');
  assert.equal(env.NODE_AUTH_TOKEN, 'the-real-token');
  // A stale ambient npm config var must not be able to outrank NPM_TOKEN.
  assert.equal(env.npm_config__authToken, undefined);
  assert.deepEqual(removed, ['npm_config__authToken']);
});

test('credential classification covers npm config aliases without over-matching', () => {
  for (const key of [
    'NPM_TOKEN',
    'npm_token',
    'NODE_AUTH_TOKEN',
    'npm_config__auth',
    'npm_config__authToken',
    'npm_config_//registry.npmjs.org/:_authToken',
  ]) {
    assert.equal(isRegistryCredential(key), true, key);
  }
  for (const key of [
    'PATH',
    'HOME',
    'GITHUB_TOKEN',
    'npm_config_registry',
    'npm_config_cache',
    'AUTHOR',
  ]) {
    assert.equal(isRegistryCredential(key), false, key);
  }
});

test('the real publish child receives no credential when OIDC is the auth mode', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-publish-oidc-')));
  try {
    const write = (name, content) => {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return file;
    };
    write(
      'scripts/release-tag-publish.mjs',
      fs.readFileSync(new URL('./release-tag-publish.mjs', import.meta.url))
    );
    write('packages/caws-cli/package.json', JSON.stringify({ version: '12.2.0-rc.1' }));
    write('packages/caws-cli/CHANGELOG.md', '## [12.2.0-rc.1]\n\nCandidate.\n');
    const publishEnvFile = path.join(root, 'publish-env.json');
    for (const command of ['npm', 'npx', 'gh']) {
      const file = write(
        `bin/${command}`,
        `#!${process.execPath}\n` +
          `const fs = require('node:fs'); const args = process.argv.slice(2);\n` +
          `if (${JSON.stringify(command)} === 'npm' && args[0] === 'publish') fs.writeFileSync(${JSON.stringify(publishEnvFile)}, JSON.stringify(process.env));\n` +
          `if (${JSON.stringify(command)} === 'npm' && args[0] === 'view') process.stdout.write('12.2.0-rc.1\\n');\n`
      );
      fs.chmodSync(file, 0o755);
    }
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'scripts/release-tag-publish.mjs'), 'caws-cli-v12.2.0-rc.1'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 20000,
        env: {
          ...isolatedEnvironment(root),
          PATH: path.join(root, 'bin'),
          GITHUB_REPOSITORY: 'fixture/repo',
          // OIDC mode: no NPM_TOKEN, id-token endpoint present. The ambient
          // credentials below are what setup-node's registry-url would leave
          // behind — they must not reach npm.
          ACTIONS_ID_TOKEN_REQUEST_URL: 'https://fixture.invalid/token',
          NODE_AUTH_TOKEN: 'ambient-must-not-survive',
          npm_config__authToken: 'ambient-must-not-survive',
        },
      }
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(fs.existsSync(publishEnvFile), 'npm publish was never invoked');
    const seen = JSON.parse(fs.readFileSync(publishEnvFile, 'utf8'));
    assert.equal(seen.NODE_AUTH_TOKEN, undefined);
    assert.equal(seen.npm_config__authToken, undefined);
    assert.equal(seen.NPM_TOKEN, undefined);
    assert.match(result.stdout, /"mode":"oidc-trusted-publisher"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the script claims tag-disposition authority before any failure path', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-publish-marker-')));
  try {
    const write = (name, content) => {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    write(
      'scripts/release-tag-publish.mjs',
      fs.readFileSync(new URL('./release-tag-publish.mjs', import.meta.url))
    );
    // Version mismatch: fails validation, which is a stage the script itself
    // is responsible for. The marker must already exist by then, or the
    // workflow handler would delete a tag the script had already handled.
    write('packages/caws-cli/package.json', JSON.stringify({ version: '9.9.9' }));
    write('packages/caws-cli/CHANGELOG.md', '## [9.9.9]\n');
    const marker = path.join(root, 'marker');
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'scripts/release-tag-publish.mjs'), 'caws-cli-v12.2.0-rc.1', '--dry-run'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...isolatedEnvironment(root),
          GITHUB_REPOSITORY: 'fixture/repo',
          CAWS_RELEASE_SCRIPT_MARKER: marker,
        },
      }
    );
    assert.equal(result.status, 20, result.stdout + result.stderr);
    assert.equal(
      fs.existsSync(marker),
      true,
      'marker must exist once the script owns the tag decision'
    );
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'caws-cli-v12.2.0-rc.1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unwritable marker refuses rather than leaving disposition ambiguous', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-publish-marker-bad-')));
  try {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'scripts/release-tag-publish.mjs'),
      fs.readFileSync(new URL('./release-tag-publish.mjs', import.meta.url))
    );
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'scripts/release-tag-publish.mjs'), 'caws-cli-v12.2.0-rc.1', '--dry-run'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 10000,
        // A directory path can never be written as a file.
        env: {
          ...isolatedEnvironment(root),
          GITHUB_REPOSITORY: 'fixture/repo',
          CAWS_RELEASE_SCRIPT_MARKER: root,
        },
      }
    );
    assert.equal(result.status, 20, result.stdout + result.stderr);
    assert.match(result.stdout, /release\.marker_unwritable/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The release publishes the tarball qualification selected, by digest.
// ---------------------------------------------------------------------------

const PACKAGE = '@paths.design/caws-cli';
const VERSION = '12.2.0-rc.1';
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const integrityOf = file =>
  'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');

/** A real gzip tarball holding package/package.json with the given manifest. */
function packCandidate(directory, manifest = { name: PACKAGE, version: VERSION }) {
  const stage = fs.mkdtempSync(path.join(directory, 'stage-'));
  fs.mkdirSync(path.join(stage, 'package'));
  fs.writeFileSync(path.join(stage, 'package/package.json'), JSON.stringify(manifest));
  const file = path.join(directory, `candidate-${path.basename(stage)}.tgz`);
  const packed = spawnSync('tar', ['-czf', file, '-C', stage, 'package']);
  assert.equal(packed.status, 0, String(packed.stderr));
  return file;
}

/**
 * A release checkout with recording stand-ins for npm, npx and gh. Every
 * invocation is appended to calls.jsonl; `npm view ... dist.integrity`
 * answers with `servedIntegrity`.
 */
function releaseFixture(servedIntegrity) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-publish-candidate-')));
  const write = (name, content) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  write(
    'scripts/release-tag-publish.mjs',
    fs.readFileSync(new URL('./release-tag-publish.mjs', import.meta.url))
  );
  write('packages/caws-cli/package.json', JSON.stringify({ name: PACKAGE, version: VERSION }));
  write('packages/caws-cli/CHANGELOG.md', `## [${VERSION}]\n\nCandidate.\n`);
  const calls = path.join(root, 'calls.jsonl');
  for (const command of ['npm', 'npx', 'gh']) {
    const file = write(
      `bin/${command}`,
      `#!${process.execPath}\n` +
        `const fs = require('node:fs'); const args = process.argv.slice(2);\n` +
        `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ command: ${JSON.stringify(command)}, args }) + '\\n');\n` +
        `if (${JSON.stringify(command)} === 'npm' && args[0] === 'view')\n` +
        `  process.stdout.write((args.includes('dist.integrity') ? ${JSON.stringify(servedIntegrity ?? '')} : ${JSON.stringify(VERSION)}) + '\\n');\n`
    );
    fs.chmodSync(file, 0o755);
  }
  return {
    root,
    run(extra) {
      const result = spawnSync(
        process.execPath,
        [path.join(root, 'scripts/release-tag-publish.mjs'), `caws-cli-v${VERSION}`],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 60000,
          env: {
            ...isolatedEnvironment(root),
            PATH: `${path.join(root, 'bin')}:/usr/bin:/bin`,
            GITHUB_REPOSITORY: 'fixture/repo',
            GITHUB_ACTIONS: 'true',
            ACTIONS_ID_TOKEN_REQUEST_URL: 'https://fixture.invalid/token',
            ...extra,
          },
        }
      );
      const recorded = fs.existsSync(calls)
        ? fs
            .readFileSync(calls, 'utf8')
            .trim()
            .split('\n')
            .map(line => JSON.parse(line))
        : [];
      return { result, calls: recorded };
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
const publishes = calls => calls.filter(call => call.command === 'npm' && call.args[0] === 'publish');
const tagDeletes = calls => calls.filter(call => call.command === 'gh' && call.args.includes('DELETE'));

test('a tarball is published with its path and without package scripts', () => {
  assert.deepEqual(publicationArgs('12.2.0', '/qualified/candidate.tgz'), [
    'publish',
    '/qualified/candidate.tgz',
    '--ignore-scripts',
    '--access',
    'public',
    '--provenance',
    '--tag',
    'latest',
  ]);
});

test('the candidate is admitted only with the qualified digest and the tagged manifest', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-candidate-')));
  try {
    const file = packCandidate(directory);
    const expectedSha256 = sha256(file);
    assert.deepEqual(verifyCandidate({ file, expectedSha256, name: PACKAGE, version: VERSION }), {
      ok: true,
      file,
      sha256: expectedSha256,
      integrity: integrityOf(file),
      sizeBytes: fs.statSync(file).size,
    });
    const refusal = input =>
      verifyCandidate({ file, expectedSha256, name: PACKAGE, version: VERSION, ...input });
    assert.match(refusal({ expectedSha256: undefined }).reason, /CAWS_RELEASE_TARBALL_SHA256 is missing/);
    assert.match(refusal({ expectedSha256: 'abc' }).reason, /is not a sha256 digest/);
    assert.match(
      refusal({ expectedSha256: 'f'.repeat(64) }).reason,
      new RegExp(`has sha256 ${expectedSha256}, but qualification selected f{64}`)
    );
    assert.match(
      refusal({ version: '12.2.0' }).reason,
      /holds @paths\.design\/caws-cli@12\.2\.0-rc\.1, but the tag names @paths\.design\/caws-cli@12\.2\.0$/
    );
    assert.match(refusal({ name: 'other' }).reason, /but the tag names other@12\.2\.0-rc\.1$/);
    assert.match(refusal({ file: directory, expectedSha256 }).reason, /is not a regular file/);
    assert.match(
      refusal({ file: path.join(directory, 'absent.tgz') }).reason,
      /cannot read the candidate tarball/
    );
    // Bytes with the right digest that are not a package tarball.
    const junk = path.join(directory, 'junk.tgz');
    fs.writeFileSync(junk, 'not a tarball');
    assert.match(
      refusal({ file: junk, expectedSha256: sha256(junk) }).reason,
      /cannot read package\/package\.json/
    );
    for (const input of [{ expectedSha256: 'f'.repeat(64) }, { version: '12.2.0' }])
      assert.equal(refusal(input).ok, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the release job uploads the qualified tarball and builds nothing', () => {
  const fixture = releaseFixture();
  try {
    const candidate = packCandidate(fixture.root);
    // The registry answers with the integrity of the bytes that were uploaded.
    const { result, calls } = releaseFixtureRun(fixture, candidate, integrityOf(candidate));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(
      publishes(calls).map(call => call.args),
      [publicationArgs(VERSION, candidate)]
    );
    // No build, no smoke: nothing ran between qualification and upload.
    assert.deepEqual(
      calls.filter(call => call.command === 'npx'),
      []
    );
    assert.deepEqual(
      calls.filter(call => call.command === 'npm' && call.args[0] === 'run'),
      []
    );
    assert.deepEqual(tagDeletes(calls), []);
    assert.match(result.stdout, /"msg":"candidate\.selected"/);
    assert.match(result.stdout, /"msg":"registry\.verify\.integrity_ok"/);
  } finally {
    fixture.cleanup();
  }
});

/** Runs a fixture whose stand-in registry serves `integrity` for the candidate. */
function releaseFixtureRun(fixture, candidate, integrity) {
  const npm = path.join(fixture.root, 'bin/npm');
  fs.writeFileSync(
    npm,
    fs.readFileSync(npm, 'utf8').replace(/args\.includes\('dist\.integrity'\) \? "[^"]*"/, () => {
      return `args.includes('dist.integrity') ? ${JSON.stringify(integrity)}`;
    })
  );
  return fixture.run({
    CAWS_RELEASE_TARBALL: candidate,
    CAWS_RELEASE_TARBALL_SHA256: sha256(candidate),
  });
}

test('a release run without the qualified tarball is refused, not rebuilt', () => {
  const fixture = releaseFixture();
  try {
    const { result, calls } = fixture.run({});
    assert.equal(result.status, 20, result.stdout + result.stderr);
    assert.match(result.stdout, /"msg":"candidate\.missing"/);
    assert.deepEqual(publishes(calls), []);
    assert.deepEqual(
      calls.filter(call => call.command === 'npx'),
      []
    );
    assert.equal(tagDeletes(calls).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('a tarball that differs from the qualified digest is never uploaded', () => {
  const fixture = releaseFixture();
  try {
    const candidate = packCandidate(fixture.root);
    const qualified = sha256(candidate);
    fs.appendFileSync(candidate, 'changed after qualification');
    const { result, calls } = fixture.run({
      CAWS_RELEASE_TARBALL: candidate,
      CAWS_RELEASE_TARBALL_SHA256: qualified,
    });
    assert.equal(result.status, 20, result.stdout + result.stderr);
    assert.match(result.stdout, /"msg":"candidate\.refused"/);
    assert.match(result.stdout, new RegExp(`but qualification selected ${qualified}`));
    assert.deepEqual(publishes(calls), []);
    assert.equal(tagDeletes(calls).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('a registry serving different bytes fails the run and keeps the tag', () => {
  const fixture = releaseFixture();
  try {
    const candidate = packCandidate(fixture.root);
    const { result, calls } = releaseFixtureRun(fixture, candidate, 'sha512-somethingelse');
    assert.equal(result.status, 30, result.stdout + result.stderr);
    assert.equal(publishes(calls).length, 1);
    assert.match(
      result.stdout,
      /registry serves @paths\.design\/caws-cli@12\.2\.0-rc\.1 with integrity sha512-somethingelse, but the qualified tarball is sha512-/
    );
    // The upload happened, so the tag is the provenance anchor and stays.
    assert.deepEqual(tagDeletes(calls), []);
  } finally {
    fixture.cleanup();
  }
});

test('outside GitHub Actions the package is built and smoke-tested before publishing', () => {
  const fixture = releaseFixture();
  try {
    const { result, calls } = fixture.run({ GITHUB_ACTIONS: '' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(
      calls.filter(call => call.command === 'npx').map(call => call.args.slice(0, 3)),
      [['turbo', 'run', 'build']]
    );
    assert.deepEqual(
      calls
        .filter(call => call.command === 'npm' && call.args[0] === 'run')
        .map(call => call.args[1]),
      ['smoke:fresh-install']
    );
    assert.deepEqual(
      publishes(calls).map(call => call.args),
      [publicationArgs(VERSION)]
    );
  } finally {
    fixture.cleanup();
  }
});
