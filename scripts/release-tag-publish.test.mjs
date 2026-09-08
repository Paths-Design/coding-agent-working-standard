import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTag, publicationArgs, releaseArgs } from './release-tag-publish.mjs';
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
