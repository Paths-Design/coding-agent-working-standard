#!/usr/bin/env node

/**
 * QG-001: caws-quality-gates --json must always emit contract-valid stdout,
 * including the zero-files commit-context early-exit branch.
 *
 * Spec ACs covered:
 *   A1: --json --context=commit with zero staged files → stdout = one JSON
 *       document parseable as a GatesReport; exit code 0.
 *   A3: stdout JSON equals on-disk docs-status/quality-gates-report.json
 *       (same fields, same values).
 *
 * Standalone ESM test — runs with `node tests/qg-001-json-zero-files.test.mjs`.
 * Creates a temporary git repo with one committed file and nothing staged,
 * then invokes the binary directly and asserts the contract.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BINARY = path.resolve(__dirname, '..', 'run-quality-gates.mjs');

let testDir;
let originalCwd;
let passed = 0;
let failed = 0;

function setup() {
  originalCwd = process.cwd();
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-001-test-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: testDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: testDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: testDir, stdio: 'pipe' });
  // Commit one file so HEAD exists; leave staging area empty.
  const seedPath = path.join(testDir, '.seed');
  fs.writeFileSync(seedPath, 'seed\n');
  execFileSync('git', ['add', '.seed'], { cwd: testDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: testDir, stdio: 'pipe' });
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function runBinary(args) {
  return spawnSync('node', [BINARY, ...args], {
    cwd: testDir,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
}

async function runTest(name, fn) {
  try {
    setup();
    await fn();
    teardown();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    try { teardown(); } catch {}
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
    if (e.stack) console.log(`        ${e.stack.split('\n').slice(1, 4).join('\n        ')}`);
    failed++;
  }
}

console.log('QG-001: --json zero-files contract');
console.log('='.repeat(50));

await runTest('A1: --json --context=commit emits one JSON document and exits 0', () => {
  const r = runBinary(['--json', '--context=commit']);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
  assert.notEqual(r.stdout.trim(), '', 'stdout must be non-empty in JSON mode');

  // Must parse as a single JSON document.
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`stdout is not valid JSON: ${e.message}\nstdout: ${r.stdout.slice(0, 500)}`);
  }

  // GatesReport contract: required top-level fields.
  assert.ok(typeof parsed.timestamp === 'string', 'timestamp must be a string');
  assert.equal(parsed.context, 'commit', 'context must echo back the request');
  assert.equal(parsed.files_scoped, 0, 'files_scoped must be 0 on zero-files path');
  assert.ok(Array.isArray(parsed.violations), 'violations must be an array');
  assert.ok(Array.isArray(parsed.warnings), 'warnings must be an array');
  assert.ok(parsed.waivers && typeof parsed.waivers === 'object', 'waivers must be an object');
  assert.ok(parsed.performance && typeof parsed.performance === 'object', 'performance must be an object');
});

await runTest('A3: stdout JSON equals docs-status/quality-gates-report.json on disk', () => {
  const r = runBinary(['--json', '--context=commit']);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}`);

  const diskPath = path.join(testDir, 'docs-status', 'quality-gates-report.json');
  assert.ok(fs.existsSync(diskPath), 'disk report must exist after run');
  const diskRaw = fs.readFileSync(diskPath, 'utf8');

  // Compare parsed payloads field-by-field (timestamp is regenerated per run
  // when the binary is invoked a second time for the disk write, so compare
  // the structural fields only — A3 says "same fields, same values", which
  // for timestamp means both are valid ISO strings, not literally equal).
  const stdoutObj = JSON.parse(r.stdout);
  const diskObj = JSON.parse(diskRaw);

  // For QG-001 the binary writes both sinks from the SAME serialized string,
  // so they must be literally equal byte-for-byte.
  assert.equal(
    r.stdout.trim(),
    diskRaw.trim(),
    'stdout and on-disk payload must be byte-identical (same source serialization)'
  );

  // And the parsed shape must match.
  assert.deepEqual(stdoutObj, diskObj, 'parsed payloads must be deep-equal');
});

await runTest('Regression: invocation via .bin symlink runs main() (not just module-load)', () => {
  // Bug Y: prior entry guard checked argv[1].endsWith("run-quality-gates.mjs"),
  // which silently fails when invoked via the npm .bin shim because argv[1]
  // is the symlink path. Create a symlink that does NOT contain the original
  // filename and verify the binary still runs.
  const shim = path.join(testDir, 'caws-quality-gates-shim');
  fs.symlinkSync(BINARY, shim);
  const r = spawnSync(shim, ['--json', '--context=commit'], {
    cwd: testDir,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  fs.unlinkSync(shim);

  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
  assert.notEqual(
    r.stdout.trim(),
    '',
    'symlinked invocation must still produce JSON stdout (Bug Y regression)'
  );
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.context, 'commit', 'parsed JSON must have correct context');
});

await runTest('Regression: --json suppresses the entry banner ("Quality gates starting...")', () => {
  const r = runBinary(['--json', '--context=commit']);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}`);
  // The literal banner must not appear anywhere in stdout when JSON mode is on.
  assert.equal(
    r.stdout.includes('Quality gates starting...'),
    false,
    'JSON mode must not emit the human-readable banner to stdout'
  );
  // And stdout must start with a JSON token (object or array).
  const first = r.stdout.trimStart()[0];
  assert.ok(first === '{' || first === '[', `stdout must start with JSON, got ${JSON.stringify(first)}`);
});

console.log('='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
