import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
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
