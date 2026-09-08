import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseTag, publicationArgs, releaseArgs, publishEnvironment, isRegistryCredential } from './release-tag-publish.mjs';
import { isolatedEnvironment } from '../packages/caws-cli/scripts/runtime-upgrade-smoke.mjs';

test('stable and prerelease publications select distinct npm channels', () => {
  assert.deepEqual(publicationArgs('12.2.0'), ['publish', '--access', 'public', '--provenance', '--tag', 'latest']);
  assert.deepEqual(publicationArgs('12.2.0-rc.1'), ['publish', '--access', 'public', '--provenance', '--tag', 'next']);
  assert.equal(parseTag('caws-cli-v12.2.0-rc.1').version, '12.2.0-rc.1');
});

test('malformed versions cannot reach npm or a release', () => {
  for (const version of ['01.2.3', '1.2.3-', '1.2.3-01', '1.2.3-rc..1', '1.2.3+','1.2.3 --tag latest']) {
    assert.equal(parseTag(`caws-cli-v${version}`).ok, false, version);
    assert.throws(() => publicationArgs(version), /version/);
  }
});

test('GitHub prereleases are marked and multiline notes use a file', () => {
  const stable = releaseArgs('caws-cli-v12.2.0', '12.2.0', '/tmp/notes.md');
  assert.deepEqual(stable, ['release', 'create', 'caws-cli-v12.2.0', '--title', 'caws-cli-v12.2.0', '--notes-file', '/tmp/notes.md', '--verify-tag']);
  assert.deepEqual(releaseArgs('caws-cli-v12.2.0-rc.1', '12.2.0-rc.1', '/tmp/notes.md'), [
    'release', 'create', 'caws-cli-v12.2.0-rc.1', '--title', 'caws-cli-v12.2.0-rc.1', '--notes-file', '/tmp/notes.md', '--verify-tag', '--prerelease',
  ]);
});

test('upgrade processes cannot inherit live machine state or agent/Git authority', () => {
  const env = isolatedEnvironment('/tmp/qualification', { PATH: '/usr/bin', HOME: '/real', CAWS_HOME: '/real/.caws', CODEX_THREAD_ID: 'real-agent', GIT_DIR: '/foreign/.git', NPM_TOKEN: 'private' });
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
    write('scripts/release-tag-publish.mjs', fs.readFileSync(new URL('./release-tag-publish.mjs', import.meta.url)));
    write('packages/caws-cli/package.json', JSON.stringify({ version: '12.2.0-rc.1' }));
    write('packages/caws-cli/CHANGELOG.md', '## [12.2.0-rc.1]\n\nCandidate.\n');
    const calls = path.join(root, 'calls.jsonl');
    for (const command of ['npm', 'npx', 'gh']) {
      const file = write(`bin/${command}`, `#!${process.execPath}\n` +
        `const fs = require('node:fs'); const args = process.argv.slice(2);\n` +
        `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({command:${JSON.stringify(command)},args})+'\\n');\n` +
        `if (${JSON.stringify(command)} === 'npm' && args[0] === 'publish') process.exit(1);\n` +
        `if (${JSON.stringify(command)} === 'npm' && args[0] === 'view') process.stdout.write('12.2.0-rc.1\\n');\n`);
      fs.chmodSync(file, 0o755);
    }
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/release-tag-publish.mjs'), 'caws-cli-v12.2.0-rc.1'], {
      cwd: root, encoding: 'utf8', timeout: 10000,
      env: { ...isolatedEnvironment(root), PATH: path.join(root, 'bin'), NPM_TOKEN: 'fixture-only', GITHUB_REPOSITORY: 'fixture/repo' },
    });
    assert.ok(fs.existsSync(calls), result.stdout + result.stderr);
    const invoked = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(invoked.some(call => call.command === 'npm' && call.args[0] === 'publish'), true);
    assert.deepEqual(invoked.filter(call => call.command === 'gh'), [], 'uncertain publication must not delete the tag or manufacture a release');
    assert.equal(result.status, 30, result.stdout + result.stderr);
    assert.match(result.stdout, /"tag_preserved":true/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OIDC publication cannot inherit a registry credential from the environment', () => {
  const inherited = {
    PATH: '/usr/bin', HOME: '/home/runner',
    NODE_AUTH_TOKEN: 'ambient-from-setup-node',
    NPM_CONFIG__AUTH: 'ambient-legacy',
    npm_config__authToken: 'ambient-scoped',
    'npm_config_//registry.npmjs.org/:_authToken': 'ambient-registry-scoped',
  };
  const { env, removed } = publishEnvironment({ hasNpmToken: false, inherited });
  // npm performs the trusted-publisher exchange only when NO credential is
  // configured; any survivor here silently downgrades the publish to token auth.
  for (const key of ['NODE_AUTH_TOKEN', 'NPM_CONFIG__AUTH', 'npm_config__authToken', 'npm_config_//registry.npmjs.org/:_authToken']) {
    assert.equal(env[key], undefined, `${key} must not reach the publish child`);
  }
  assert.deepEqual(removed, ['NODE_AUTH_TOKEN', 'NPM_CONFIG__AUTH', 'npm_config_//registry.npmjs.org/:_authToken', 'npm_config__authToken'].sort());
  // Non-credential environment is preserved; this is isolation, not a wipe.
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/runner');
});

test('token publication reinstates exactly one credential source', () => {
  const { env, removed } = publishEnvironment({
    hasNpmToken: true,
    inherited: { PATH: '/usr/bin', NPM_TOKEN: 'the-real-token', npm_config__authToken: 'stale-ambient' },
  });
  assert.equal(env.NPM_TOKEN, 'the-real-token');
  assert.equal(env.NODE_AUTH_TOKEN, 'the-real-token');
  // A stale ambient npm config var must not be able to outrank NPM_TOKEN.
  assert.equal(env.npm_config__authToken, undefined);
  assert.deepEqual(removed, ['npm_config__authToken']);
});

test('credential classification covers npm config aliases without over-matching', () => {
  for (const key of ['NPM_TOKEN', 'npm_token', 'NODE_AUTH_TOKEN', 'npm_config__auth', 'npm_config__authToken', 'npm_config_//registry.npmjs.org/:_authToken']) {
    assert.equal(isRegistryCredential(key), true, key);
  }
  for (const key of ['PATH', 'HOME', 'GITHUB_TOKEN', 'npm_config_registry', 'npm_config_cache', 'AUTHOR']) {
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
    write('scripts/release-tag-publish.mjs', fs.readFileSync(new URL('./release-tag-publish.mjs', import.meta.url)));
    write('packages/caws-cli/package.json', JSON.stringify({ version: '12.2.0-rc.1' }));
    write('packages/caws-cli/CHANGELOG.md', '## [12.2.0-rc.1]\n\nCandidate.\n');
    const publishEnvFile = path.join(root, 'publish-env.json');
    for (const command of ['npm', 'npx', 'gh']) {
      const file = write(`bin/${command}`, `#!${process.execPath}\n` +
        `const fs = require('node:fs'); const args = process.argv.slice(2);\n` +
        `if (${JSON.stringify(command)} === 'npm' && args[0] === 'publish') fs.writeFileSync(${JSON.stringify(publishEnvFile)}, JSON.stringify(process.env));\n` +
        `if (${JSON.stringify(command)} === 'npm' && args[0] === 'view') process.stdout.write('12.2.0-rc.1\\n');\n`);
      fs.chmodSync(file, 0o755);
    }
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/release-tag-publish.mjs'), 'caws-cli-v12.2.0-rc.1'], {
      cwd: root, encoding: 'utf8', timeout: 20000,
      env: {
        ...isolatedEnvironment(root), PATH: path.join(root, 'bin'), GITHUB_REPOSITORY: 'fixture/repo',
        // OIDC mode: no NPM_TOKEN, id-token endpoint present. The ambient
        // credentials below are what setup-node's registry-url would leave
        // behind — they must not reach npm.
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://fixture.invalid/token',
        NODE_AUTH_TOKEN: 'ambient-must-not-survive',
        npm_config__authToken: 'ambient-must-not-survive',
      },
    });
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
    write('scripts/release-tag-publish.mjs', fs.readFileSync(new URL('./release-tag-publish.mjs', import.meta.url)));
    // Version mismatch: fails validation, which is a stage the script itself
    // is responsible for. The marker must already exist by then, or the
    // workflow handler would delete a tag the script had already handled.
    write('packages/caws-cli/package.json', JSON.stringify({ version: '9.9.9' }));
    write('packages/caws-cli/CHANGELOG.md', '## [9.9.9]\n');
    const marker = path.join(root, 'marker');
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/release-tag-publish.mjs'), 'caws-cli-v12.2.0-rc.1', '--dry-run'], {
      cwd: root, encoding: 'utf8', timeout: 10000,
      env: { ...isolatedEnvironment(root), GITHUB_REPOSITORY: 'fixture/repo', CAWS_RELEASE_SCRIPT_MARKER: marker },
    });
    assert.equal(result.status, 20, result.stdout + result.stderr);
    assert.equal(fs.existsSync(marker), true, 'marker must exist once the script owns the tag decision');
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'caws-cli-v12.2.0-rc.1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unwritable marker refuses rather than leaving disposition ambiguous', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-publish-marker-bad-')));
  try {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts/release-tag-publish.mjs'), fs.readFileSync(new URL('./release-tag-publish.mjs', import.meta.url)));
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/release-tag-publish.mjs'), 'caws-cli-v12.2.0-rc.1', '--dry-run'], {
      cwd: root, encoding: 'utf8', timeout: 10000,
      // A directory path can never be written as a file.
      env: { ...isolatedEnvironment(root), GITHUB_REPOSITORY: 'fixture/repo', CAWS_RELEASE_SCRIPT_MARKER: root },
    });
    assert.equal(result.status, 20, result.stdout + result.stderr);
    assert.match(result.stdout, /release\.marker_unwritable/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
