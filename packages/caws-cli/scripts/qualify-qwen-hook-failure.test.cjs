'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { snapshotHostTree } = require('./native-qualification-host-tree.cjs');
const script = path.join(__dirname, 'qualify-qwen-hook-failure.cjs');

function fixture(source, fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-qwen-probe-')));
  try {
    const pkg = path.join(root, '@qwen-code/qwen-code');
    fs.mkdirSync(path.join(pkg, 'chunks'), { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ type: 'module', version: '0.21.14' })
    );
    fs.writeFileSync(path.join(pkg, 'chunks/chunk-OFTPCOGR.js'), source);
    return fn(root, snapshotHostTree(root).digest);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function host(failOpen) {
  return `export async function firePreToolUseHook(bus) { try { const r = await bus.request(); if (r.success && r.output) return {shouldProceed:false,blockType:'denied'}; return {shouldProceed:${failOpen}}; } catch { return {shouldProceed:${failOpen}}; } }\n`;
}
function run(root, digest) {
  return spawnSync(process.execPath, [script, root, digest], {
    timeout: 10000,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
}

test('fail-open transport is a failing verdict, while a fail-closed fixture passes', () => {
  fixture(host(true), (root, digest) => {
    const cli = run(root, digest);
    assert.equal(cli.status, 1);
    const result = JSON.parse(cli.stdout);
    assert.equal(result.safeForFailClosed, false);
    assert.equal(result.cases.failedTransportProceeds, true);
    assert.equal(result.cases.missingOutputProceeds, true);
    assert.equal(result.cases.thrownTransportProceeds, true);
    assert.equal(result.cases.explicitDenialProceeds, false);
  });
  fixture(host(false), (root, digest) => {
    const cli = run(root, digest);
    assert.equal(cli.status, 0);
    assert.equal(JSON.parse(cli.stdout).safeForFailClosed, true);
  });
});

test('a wrong or stale host pin is rejected before importing the host', () => {
  fixture(host(true), (root, digest) => {
    assert.equal(run(root, '0'.repeat(64)).status, 2);
    fs.appendFileSync(path.join(root, '@qwen-code/qwen-code/chunks/chunk-OFTPCOGR.js'), '\n');
    assert.equal(run(root, digest).status, 2);
  });
});

test('each process probes the newly pinned host, never a cached earlier module', () => {
  fixture(host(false), (root, digest) => {
    assert.equal(JSON.parse(run(root, digest).stdout).safeForFailClosed, true);
    fs.writeFileSync(path.join(root, '@qwen-code/qwen-code/chunks/chunk-OFTPCOGR.js'), host(true));
    const changed = snapshotHostTree(root).digest;
    assert.notEqual(changed, digest);
    const result = run(root, changed);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).safeForFailClosed, false);
  });
});

test('an asynchronously unsettled host produces an incomplete outcome', () => {
  fixture(
    'export async function firePreToolUseHook() { return new Promise(() => {}); }\n',
    (root, digest) => {
      const result = run(root, digest);
      assert.equal(result.signal, null);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /did not settle/);
      assert.equal(result.stdout, '');
    }
  );
});
