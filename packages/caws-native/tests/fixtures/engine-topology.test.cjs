// Pure controls: this file launches no fixture or OS process.
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validateTopology } = require('./engine-topology.cjs');
const expected = { platform: 'darwin', frontendPid: 10, nodeParentPid: 20, nodePid: 30,
  native: '/private/test/caws-native', node: '/private/test/node',
  engine: '/private/test/engine.cjs' };
const frontend = '10 1 9 S /private/test/caws-native invoke --engine /private/test/engine.cjs';
const custodian = '20 10 20 Ss /private/test/caws-native engine-custodian 64';
const node = '30 20 30 S /private/test/node /private/test/engine.cjs';
const snapshot = (lines = [frontend, custodian, node]) => ({
  status: 0, signal: null, error: undefined, stderr: '', stdout: lines.join('\n') + '\n',
});
test('keeps original frontend authority separate from named custodian and Node', () => {
  const actual = validateTopology(snapshot(), expected);
  assert.equal(actual.kind, 'custodied');
  assert.equal(actual.frontend.pid, 10);
  assert.equal(actual.custodian.pid, 20);
  assert.equal(actual.custodian.parent, 10);
  assert.equal(actual.node.pid, 30);
  assert.equal(actual.node.parent, 20);
  assert.equal(actual.node.group, 30);
});
for (const fd of [32, 1_048_576]) {
  test(`accepts production configuration descriptor boundary ${fd}`, () => {
    const command = custodian.replace(' 64', ` ${fd}`);
    const actual = validateTopology(snapshot([frontend, command, node]), expected);
    assert.equal(actual.custodian.command, `${expected.native} engine-custodian ${fd}`);
    assert.ok(actual.snapshot.stdout.includes(command + '\n'));
  });
}
test('non-macOS supported platforms require the direct topology', () => {
  const direct = { ...expected, platform: 'linux', nodeParentPid: 10 };
  const actual = validateTopology(snapshot([frontend, node.replace('30 20 ', '30 10 ')]), direct);
  assert.equal(actual.kind, 'direct');
  assert.equal(actual.custodian, null);
  assert.equal(actual.node.parent, actual.frontend.pid);
  assert.throws(() => validateTopology(snapshot(), { ...expected, platform: 'linux' }),
    /direct engine ownership/);
  assert.throws(() => validateTopology(snapshot([frontend, node.replace('30 20 ', '30 10 ')]),
    { ...direct, platform: 'darwin' }), /distinct custodian/);
  assert.throws(() => validateTopology(snapshot(), { ...expected, platform: 'win32' }),
    /unsupported fixture platform/);
});
test('substituting custodian authority cannot satisfy the frontend contract', () => {
  assert.throws(() => validateTopology(snapshot([custodian, node]),
    { ...expected, frontendPid: 20 }), /frontend executable differs/);
});
for (const [name, lines, reason] of [
  ['wrong ancestor', [frontend, custodian.replace('20 10 ', '20 99 '), node], /custodian ownership/],
  ['sibling Node', [frontend, custodian, node.replace('30 20 ', '30 10 ')], /Node parent/],
  ['unnamed intermediary', [frontend, custodian.replace('engine-custodian', 'invoke'), node],
    /named custodian executable/],
  ['foreign native executable', [frontend, custodian.replace('/private/test/caws-native', '/other/native'), node],
    /named custodian executable/],
  ['custodian descriptor below production range', [frontend, custodian.replace(' 64', ' 31'), node],
    /named custodian command/],
  ['custodian descriptor above production range', [frontend, custodian.replace(' 64', ' 1048577'), node],
    /named custodian command/],
  ['noncanonical custodian descriptor', [frontend, custodian.replace(' 64', ' 064'), node],
    /named custodian command/],
  ['positive-signed custodian descriptor', [frontend, custodian.replace(' 64', ' +64'), node],
    /named custodian command/],
  ['negative-signed custodian descriptor', [frontend, custodian.replace(' 64', ' -64'), node],
    /named custodian command/],
  ['extra custodian argument', [frontend, custodian + ' --other', node], /named custodian command/],
  ['zero frontend group', [frontend.replace('10 1 9 ', '10 1 0 '), custodian, node],
    /frontend group must be positive and distinct/],
  ['frontend shares custodian group', [frontend.replace('10 1 9 ', '10 1 20 '), custodian, node],
    /frontend group must be positive and distinct/],
  ['frontend shares Node group', [frontend.replace('10 1 9 ', '10 1 30 '), custodian, node],
    /frontend group must be positive and distinct/],
  ['wrong custodian group', [frontend, custodian.replace('20 10 20 ', '20 10 9 '), node],
    /custodian does not own/],
  ['shared Node group', [frontend, custodian, node.replace('30 20 30 ', '30 20 20 ')], /Node does not own/],
  ['wrong Node executable', [frontend, custodian, node.replace('/private/test/node', '/other/node')],
    /Node executable differs/],
  ['zombie custodian', [frontend, custodian.replace(' Ss ', ' Z '), node], /not live/],
  ['missing custodian', [frontend, node], /incomplete native topology/],
  ['duplicate custodian', [frontend, custodian, custodian, node], /duplicate native topology PID/],
  ['unexpected PID', [frontend, custodian, node, '99 1 99 S /other'], /unexpected or duplicate/],
  ['malformed row', [frontend, 'unparsed process', node], /malformed native topology row/],
]) {
  test(`rejects ${name}`, () => assert.throws(() => validateTopology(snapshot(lines), expected), reason));
}
for (const [name, change] of [
  ['failed query', { status: 1, stdout: '' }],
  ['unknown query status', { status: null }],
  ['query timeout', { error: new Error('timeout'), signal: 'SIGTERM' }],
  ['query diagnostics', { stderr: 'permission denied' }],
  ['partial snapshot', { stdout: snapshot().stdout.trimEnd() }],
  ['oversized snapshot', { stdout: 'x'.repeat(65_537) + '\n' }],
]) {
  test(`rejects ${name}`, () => assert.throws(() =>
    validateTopology({ ...snapshot(), ...change }, expected), /snapshot unavailable/));
}
