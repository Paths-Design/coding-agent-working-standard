'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { snapshotHostTree } = require('./native-qualification-host-tree.cjs');
const script = path.join(__dirname, 'qualify-qwen-managed-guard.cjs');

function fixture(brokenEvaluator, fn, fault = '') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-managed-probe-')));
  try {
    const pkg = path.join(root, '@qwen-code/qwen-code');
    const chunks = path.join(pkg, 'chunks');
    fs.mkdirSync(chunks, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ type: 'module', version: '0.21.14' })
    );
    fs.writeFileSync(
      path.join(chunks, 'external-tool-guard-provider-TE4DRY36.js'),
      `
      export class RequiredExternalToolGuard {
        constructor(o) { this.options = o; }
        async post(route, body) {
          const r = await fetch(this.options.endpoint + route, {method:'POST', headers:{authorization:'Bearer ' + this.options.token,'content-type':'application/json'}, body:JSON.stringify(body), signal:AbortSignal.timeout(this.options.timeoutMs)});
          if (!r.ok && ${fault !== 'ignore-http'}) throw Error('HTTP'); return r.json();
        }
        async initialize() { const r = await this.post('/v1/handshake',{protocolVersion:1,nonce:'fixture-nonce',client:'qwen-code'}); if (r.nonce !== 'fixture-nonce') throw Error('nonce'); }
        async prepare(req) { const r = await this.post('/v1/prepare',{protocolVersion:1,requestId:'fixture-id',...req}); if (r.requestId !== 'fixture-id' && ${fault !== 'ignore-id'}) throw Error('id'); return {allowed:r.allowed}; }
      }\n`
    );
    fs.writeFileSync(
      path.join(chunks, 'chunk-OFTPCOGR.js'),
      brokenEvaluator
        ? `export async function evaluateToolInvocationGuard(guard, context) { try { await guard(context); } catch {} return {allowed:true}; }\n`
        : `export async function evaluateToolInvocationGuard(guard, context) { if (context.signal.aborted) return {allowed:false}; try { return await guard(context); } catch { return {allowed:false}; } }\n`
    );
    return fn(root, snapshotHostTree(root).digest);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function run(root, digest) {
  return spawnSync(process.execPath, [script, root, digest], {
    timeout: 10000,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
}

test('component probe passes valid fail-closed controls and fails an always-allow evaluator', () => {
  fixture(false, (root, digest) => {
    const result = run(root, digest);
    assert.equal(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.requestCount, 5);
    assert.equal(report.allBoundArguments, true);
    assert.equal(report.decisions.allow, true);
    assert.equal(report.decisions.mismatch, false);
    assert.equal(report.decisions['http-error'], false);
    assert.equal(report.decisions.timeout, false);
  });
  fixture(true, (root, digest) => {
    const result = run(root, digest);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).passed, false);
  });
});

test('hostile allow responses expose a missing ID or HTTP status check', () => {
  for (const [fault, decision] of [
    ['ignore-id', 'mismatch'],
    ['ignore-http', 'http-error'],
  ]) {
    fixture(
      false,
      (root, digest) => {
        const result = run(root, digest);
        assert.equal(result.status, 1);
        const report = JSON.parse(result.stdout);
        assert.equal(report.decisions[decision], true);
        assert.equal(report.passed, false);
      },
      fault
    );
  }
});

test('a stale host pin is incomplete rather than a pass', () =>
  fixture(false, (root, digest) => {
    fs.appendFileSync(path.join(root, '@qwen-code/qwen-code/chunks/chunk-OFTPCOGR.js'), '\n');
    const result = run(root, digest);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /identity mismatch/);
    assert.equal(result.stdout, '');
  }));
