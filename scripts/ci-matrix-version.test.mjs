import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget } from './ci-matrix-version.mjs';

const sha = 'a'.repeat(40);
const run = (version = '12.2.0-rc.2') => ({ workflow_run: { id: 123,
  conclusion: 'success', event: 'push', path: '.github/workflows/release.yml',
  head_branch: `caws-cli-v${version}`, head_sha: sha } });
const metadata = version => ({ version, gitHead: sha, 'dist.integrity': 'sha512-YWJjZA==' });

test('a successful prerelease selects its exact version even when latest is older', () => {
  const queries = [];
  const result = resolveTarget('workflow_run', run(), spec => {
    queries.push(spec); return metadata('12.2.0-rc.2');
  });
  assert.deepEqual(queries, ['@paths.design/caws-cli@12.2.0-rc.2']);
  assert.equal(result.version, '12.2.0-rc.2');
  assert.equal(result.gitHead, sha);
  assert.equal(result.releaseRunId, 123);
});
test('a stable release also uses its exact occurrence', () => {
  assert.equal(resolveTarget('workflow_run', run('12.2.0'), () => metadata('12.2.0')).version, '12.2.0');
});
for (const patch of [{ conclusion: 'failure' }, { event: 'pull_request' }, { head_branch: 'main' },
  { head_branch: 'v12.2.0' }, { head_branch: 'caws-kernel-v12.2.0' }, { head_sha: '' },
  { id: null }, { head_sha: sha + '\n' }, { head_branch: 'caws-cli-v12.2.0\n' },
  { path: '.github/workflows/unrelated.yml' }]) {
  test(`invalid release identity refuses before querying npm: ${JSON.stringify(patch)}`, () => {
    const event = run(); Object.assign(event.workflow_run, patch);
    let queried = false;
    assert.throws(() => resolveTarget('workflow_run', event, () => { queried = true; }));
    assert.equal(queried, false);
  });
}
for (const override of [{ version: '12.1.0' }, { gitHead: 'b'.repeat(40) }, { gitHead: undefined }, { 'dist.integrity': '' }]) {
  test(`substituted or incomplete registry identity refuses: ${JSON.stringify(override)}`, () => {
    assert.throws(() => resolveTarget('workflow_run', run(), () => ({ ...metadata('12.2.0-rc.2'), ...override })));
  });
}
test('manual channels resolve once to an exact install version', () => {
  const result = resolveTarget('workflow_dispatch', { inputs: { version: 'next' } }, spec => {
    assert.equal(spec, '@paths.design/caws-cli@next'); return metadata('12.2.0-rc.2');
  });
  assert.equal(result.requested, 'next'); assert.equal(result.version, '12.2.0-rc.2');
});
test('manual exact versions cannot resolve to another version', () => {
  assert.throws(() => resolveTarget('workflow_dispatch', { inputs: { version: '12.2.0-rc.2' } }, () => metadata('12.1.0')));
});
test('shell-shaped manual inputs refuse before registry invocation', () => {
  let queried = false;
  assert.throws(() => resolveTarget('workflow_dispatch', { inputs: { version: 'next; echo injected' } }, () => { queried = true; }));
  assert.equal(queried, false);
});
test('registry failures and unexpected events cannot fall back to latest', () => {
  assert.throws(() => resolveTarget('workflow_run', run(), () => { throw new Error('offline'); }), /offline/);
  assert.throws(() => resolveTarget('push', {}, () => metadata('12.1.0')), /Unsupported/);
});
