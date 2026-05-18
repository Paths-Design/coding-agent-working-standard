#!/usr/bin/env node

/**
 * QG-001 (extension): caws-quality-gates --json must emit JSON-only stdout
 * when files ARE staged, not just on the zero-files early-exit branch.
 *
 * Slice 7a / LEGACY-TEST-RECONCILE-001 evidence: prior to the JSON-mode
 * stdout discipline pass, the non-zero-files path emitted progress + result
 * console.log calls before the JSON payload, breaking the strict
 * caws-cli adapter contract (shell.gates.report_not_json).
 *
 * Spec ACs covered:
 *   A1-nonzero: --json --context=commit with staged files → stdout is
 *               exactly one parseable JSON document; no preamble text.
 *   A2-nonzero: stdout starts with a JSON token (`{` or `[`).
 *   A3-nonzero: a real subprocess violation (code_freeze) lands in
 *               JSON.violations, not in human-readable preamble.
 *
 * Standalone ESM test — runs with `node tests/qg-001-json-nonzero-files.test.mjs`.
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
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-001-nonzero-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: testDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: testDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: testDir, stdio: 'pipe' });
  // Seed commit so HEAD exists.
  fs.writeFileSync(path.join(testDir, '.seed'), 'seed\n');
  execFileSync('git', ['add', '.seed'], { cwd: testDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: testDir, stdio: 'pipe' });
  // Stage some real files so the gate-runner takes the non-zero-files path.
  // 10 new files exercises code_freeze ("new_file_during_freeze") and naming,
  // ensuring multiple gate code paths reach console output sites.
  fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
  for (let i = 0; i < 10; i++) {
    fs.writeFileSync(
      path.join(testDir, 'src', `file${i}.js`),
      `// file ${i}\nexport const x${i} = ${i};\n`
    );
  }
  execFileSync('git', ['add', 'src'], { cwd: testDir, stdio: 'pipe' });
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  // Clear any stale lock left by an interrupted run in the package dir.
  const lockPath = path.resolve(__dirname, '..', 'docs-status', 'quality-gates.lock');
  try { fs.rmSync(lockPath, { force: true }); } catch {}
  fs.rmSync(testDir, { recursive: true, force: true });
}

function runBinary(args) {
  // Clear any stale lock before each run.
  const lockPath = path.resolve(__dirname, '..', 'docs-status', 'quality-gates.lock');
  try { fs.rmSync(lockPath, { force: true }); } catch {}
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

console.log('QG-001 nonzero: --json non-zero-files contract');
console.log('='.repeat(50));

await runTest('A1-nonzero: stdout is exactly one parseable JSON document', () => {
  const r = runBinary(['--json', '--context=commit']);
  // Exit code can be 0 (pass) or 1 (violations); both are valid JSON-contract outcomes.
  assert.ok(r.status === 0 || r.status === 1, `exit must be 0 or 1, got ${r.status}; stderr: ${r.stderr}`);
  assert.notEqual(r.stdout.trim(), '', 'stdout must be non-empty in JSON mode');
  // No preamble: trim, parse, done.
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(
      `stdout is not valid JSON in non-zero-files path: ${e.message}\n` +
      `stdout head: ${JSON.stringify(r.stdout.slice(0, 300))}`
    );
  }
  assert.ok(parsed && typeof parsed === 'object', 'parsed must be an object');
});

await runTest('A2-nonzero: stdout starts with `{` (no human preamble)', () => {
  const r = runBinary(['--json', '--context=commit']);
  const first = r.stdout.trimStart()[0];
  assert.ok(
    first === '{',
    `stdout must start with '{'; got ${JSON.stringify(first)}\n` +
    `first 200 chars: ${JSON.stringify(r.stdout.slice(0, 200))}`
  );
});

await runTest('A3-nonzero: real violations appear in JSON.violations[], not in stdout text', () => {
  const r = runBinary(['--json', '--context=commit']);
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.violations), 'violations must be an array');
  // 10 staged new files should trip code_freeze (new_file_during_freeze).
  const codeFreeze = parsed.violations.find((v) => v.gate === 'code_freeze');
  assert.ok(codeFreeze, `expected at least one code_freeze violation; got: ${JSON.stringify(parsed.violations.map((v) => v.gate))}`);
  // And the stdout must not also contain the human banner — that would mean
  // result text leaked alongside JSON.
  assert.ok(
    !r.stdout.includes('QUALITY GATES RESULTS'),
    'human banner "QUALITY GATES RESULTS" must not appear in stdout in JSON mode'
  );
  assert.ok(
    !r.stdout.includes('Checking for hidden incomplete'),
    'progress line "Checking for hidden incomplete..." must not appear in stdout in JSON mode'
  );
  assert.ok(
    !r.stdout.includes('No documentation files found'),
    'result line "No documentation files found" must not appear in stdout in JSON mode'
  );
});

console.log('='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
