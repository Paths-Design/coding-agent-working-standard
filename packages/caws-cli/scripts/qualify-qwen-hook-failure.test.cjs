'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { snapshotHostTree } = require('./native-qualification-host-tree.cjs');
const { probe } = require('./qualify-qwen-hook-failure.cjs');

async function fixture(failOpen, fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-qwen-probe-')));
  try {
    const pkg = path.join(root, '@qwen-code/qwen-code');
    fs.mkdirSync(path.join(pkg, 'chunks'), { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ type: 'module', version: '0.21.14' })
    );
    fs.writeFileSync(
      path.join(pkg, 'chunks/chunk-OFTPCOGR.js'),
      `export async function firePreToolUseHook(bus) { try { const r = await bus.request(); if (r.success && r.output) return {shouldProceed:false,blockType:'denied'}; return {shouldProceed:${failOpen}}; } catch { return {shouldProceed:${failOpen}}; } }\n`
    );
    return await fn(root, snapshotHostTree(root).digest);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('fail-open transport is a failing verdict, while a fail-closed fixture passes', async () => {
  await fixture(true, async (root, digest) => {
    const result = await probe(root, digest);
    assert.equal(result.safeForFailClosed, false);
    assert.equal(result.cases.failedTransportProceeds, true);
    assert.equal(result.cases.missingOutputProceeds, true);
    assert.equal(result.cases.thrownTransportProceeds, true);
    assert.equal(result.cases.explicitDenialProceeds, false);
    const cli = spawnSync(
      process.execPath,
      [path.join(__dirname, 'qualify-qwen-hook-failure.cjs'), root, digest],
      { timeout: 10000, encoding: 'utf8' }
    );
    assert.equal(cli.status, 1);
    assert.equal(JSON.parse(cli.stdout).safeForFailClosed, false);
  });
  await fixture(false, async (root, digest) => {
    const result = await probe(root, digest);
    assert.equal(result.safeForFailClosed, true);
    assert.equal(result.cases.failedTransportProceeds, false);
  });
});

test('a wrong or stale host pin is rejected before importing the host', async () => {
  await fixture(true, async (root, digest) => {
    await assert.rejects(probe(root, '0'.repeat(64)), /identity mismatch/);
    fs.appendFileSync(path.join(root, '@qwen-code/qwen-code/chunks/chunk-OFTPCOGR.js'), '\n');
    await assert.rejects(probe(root, digest), /identity mismatch/);
  });
});
