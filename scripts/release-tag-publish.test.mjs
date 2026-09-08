import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTag, publicationArgs, releaseArgs } from './release-tag-publish.mjs';

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
