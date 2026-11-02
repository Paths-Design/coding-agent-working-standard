// Fixture observation only: these process rows never grant production authority.
// Command fields are ps argv text, not kernel executable identity or argv-spoof defense.
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const MAX_SNAPSHOT = 65_536;
const DIRECT_PLATFORMS = new Set([
  'aix', 'android', 'freebsd', 'linux', 'netbsd', 'openbsd', 'sunos',
]);
const pid = value => Number.isSafeInteger(value) && value > 1 && value <= 2_147_483_647;
function selection(expected) {
  assert.ok(pid(expected.frontendPid) && pid(expected.nodePid) && pid(expected.nodeParentPid),
    'invalid expected topology PID');
  assert.notEqual(expected.frontendPid, expected.nodePid, 'frontend cannot be Node');
  for (const key of ['native', 'node', 'engine'])
    assert.ok(typeof expected[key] === 'string' && path.isAbsolute(expected[key])
      && !/[\0\r\n]/.test(expected[key]), 'invalid expected executable path');
  assert.ok(expected.platform === 'darwin' || DIRECT_PLATFORMS.has(expected.platform),
    'unsupported fixture platform');
  return [...new Set([expected.frontendPid, expected.nodeParentPid, expected.nodePid])];
}
function validateTopology(snapshot, expected) {
  const wanted = selection(expected);
  assert.ok(snapshot && snapshot.error == null && snapshot.signal == null
    && snapshot.status === 0 && snapshot.stderr === '' && typeof snapshot.stdout === 'string'
    && Buffer.byteLength(snapshot.stdout) <= MAX_SNAPSHOT && snapshot.stdout.endsWith('\n'),
    'native topology snapshot unavailable');
  const rows = new Map();
  for (const line of snapshot.stdout.trimEnd().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    assert.ok(match, 'malformed native topology row');
    const row = { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]),
      state: match[4], command: match[5] };
    assert.ok(pid(row.pid) && Number.isSafeInteger(row.parent) && row.parent >= 0
      && row.parent <= 2_147_483_647 && Number.isSafeInteger(row.group)
      && row.group >= 0 && row.group <= 2_147_483_647 && wanted.includes(row.pid)
      && !rows.has(row.pid), 'unexpected or duplicate native topology PID');
    assert.ok(!row.state.startsWith('Z'), 'native topology member is not live');
    rows.set(row.pid, row);
  }
  assert.equal(rows.size, wanted.length, 'incomplete native topology snapshot');
  const frontend = rows.get(expected.frontendPid), node = rows.get(expected.nodePid);
  assert.ok(frontend.command.startsWith(`${expected.native} invoke `),
    'frontend executable differs');
  assert.equal(node.command, `${expected.node} ${expected.engine}`, 'Node executable differs');
  assert.equal(node.parent, expected.nodeParentPid, 'Node parent differs');
  assert.equal(node.group, node.pid, 'Node does not own its group');
  let custodian = null;
  if (expected.platform === 'darwin') {
    assert.notEqual(expected.frontendPid, expected.nodeParentPid,
      'macOS engine requires a distinct custodian');
    assert.notEqual(expected.nodePid, expected.nodeParentPid, 'Node cannot be its custodian');
    custodian = rows.get(expected.nodeParentPid);
    assert.equal(custodian.parent, frontend.pid, 'custodian ownership differs');
    assert.equal(custodian.group, custodian.pid, 'custodian does not own its group');
    assert.ok(frontend.group > 0 && frontend.group !== custodian.group
      && frontend.group !== node.group, 'frontend group must be positive and distinct');
    const prefix = `${expected.native} engine-custodian `;
    assert.ok(custodian.command.startsWith(prefix), 'named custodian executable differs');
    const fd = custodian.command.slice(prefix.length);
    assert.ok(/^[1-9]\d*$/.test(fd) && Number.isSafeInteger(Number(fd))
      && Number(fd) >= 32 && Number(fd) <= 1_048_576, 'named custodian command differs');
  } else {
    assert.equal(node.parent, frontend.pid, 'direct engine ownership differs');
  }
  return { kind: custodian ? 'custodied' : 'direct', frontend, custodian, node,
    snapshot: { stdout: snapshot.stdout, stderr: snapshot.stderr, status: snapshot.status,
      commandEvidence: 'ps argv text; no executable identity or argv-spoof guarantee' } };
}
function observeTopology(expected) {
  const wanted = selection(expected);
  const snapshot = spawnSync('/bin/ps', [
    '-ww', '-p', wanted.join(','), '-o', 'pid=,ppid=,pgid=,stat=,command=',
  ], { encoding: 'utf8', env: { LC_ALL: 'C', TZ: 'UTC' }, timeout: 500,
    maxBuffer: MAX_SNAPSHOT });
  try {
    return validateTopology(snapshot, expected);
  } catch (error) {
    throw new Error(`${error.message}; snapshot=${JSON.stringify({
      status: snapshot.status, signal: snapshot.signal, error: snapshot.error?.message,
      stdout: snapshot.stdout, stderr: snapshot.stderr,
    })}`);
  }
}
module.exports = { validateTopology, observeTopology };
