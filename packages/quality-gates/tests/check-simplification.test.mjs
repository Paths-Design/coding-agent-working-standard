#!/usr/bin/env node

/**
 * @fileoverview Tests for the simplification detection quality gate
 *
 * Standalone ESM test — runs with `node tests/check-simplification.test.mjs`
 * Creates temporary git repos for each test case.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let testDir;
let originalCwd;
let passed = 0;
let failed = 0;

function setup() {
  originalCwd = process.cwd();
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-simplification-test-'));
  execFileSync('git', ['init'], { cwd: testDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: testDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: testDir, stdio: 'pipe' });
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function commitFile(relPath, content) {
  const fullPath = path.join(testDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  execFileSync('git', ['add', relPath], { cwd: testDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', `add ${relPath}`], { cwd: testDir, stdio: 'pipe' });
}

function stageFile(relPath, content) {
  const fullPath = path.join(testDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  execFileSync('git', ['add', relPath], { cwd: testDir, stdio: 'pipe' });
}

async function runTest(name, fn) {
  setup();
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL: ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  } finally {
    teardown();
  }
}

// Dynamic import must happen from within the test dir's context,
// but the module path needs to be absolute to find check-simplification.mjs
const moduleDir = path.dirname(new URL(import.meta.url).pathname);
const checkSimplificationPath = path.resolve(moduleDir, '..', 'check-simplification.mjs');

console.log('check-simplification tests');
console.log('='.repeat(40));

await runTest('detects simplification: LOC decrease with stubs', async () => {
  const originalCode = `
function processData(input) {
  const validated = validateInput(input);
  const transformed = transformData(validated);
  const enriched = enrichData(transformed);
  const filtered = filterResults(enriched);
  const sorted = sortResults(filtered);
  const formatted = formatOutput(sorted);
  return formatted;
}

function validateInput(input) {
  if (!input) throw new Error('Input required');
  if (typeof input !== 'object') throw new Error('Input must be object');
  if (!input.data) throw new Error('Data field required');
  return input;
}

function transformData(data) {
  return data.data.map(item => ({
    id: item.id,
    value: item.value * 2,
    label: item.label.toUpperCase(),
  }));
}

module.exports = { processData, validateInput, transformData };
`.trim();

  commitFile('src/processor.js', originalCode);

  const stubbedCode = `
function processData(input) {
  // TODO
  return null;
}

function validateInput(input) {
  // TODO
  return input;
}

function transformData(data) {
  // TODO
  return [];
}

module.exports = { processData, validateInput, transformData };
`.trim();

  stageFile('src/processor.js', stubbedCode);

  // Fresh import to avoid module caching issues across test dirs
  const mod = await import(checkSimplificationPath + '?t=' + Date.now());
  const result = mod.checkSimplification('commit');

  assert.ok(result.violations.length > 0, 'Expected at least one violation');
  assert.equal(result.violations[0].type, 'simplification');
  assert.equal(result.violations[0].file, 'src/processor.js');
});

await runTest('allows normal refactoring (no stubs)', async () => {
  const originalCode = `
function a() { return 1; }
function b() { return 2; }
function c() { return 3; }
function d() { return 4; }
function e() { return 5; }
function f() { return 6; }
function g() { return 7; }
function h() { return 8; }
function i() { return 9; }
function j() { return 10; }
module.exports = { a, b, c, d, e, f, g, h, i, j };
`.trim();

  commitFile('src/helpers.js', originalCode);

  const refactoredCode = `
function compute(n) { return n; }
function transform(n) { return n * 2; }
module.exports = { compute, transform };
`.trim();

  stageFile('src/helpers.js', refactoredCode);

  const mod = await import(checkSimplificationPath + '?t=' + Date.now());
  const result = mod.checkSimplification('commit');

  const simplifications = result.violations.filter(v => v.type === 'simplification');
  assert.equal(simplifications.length, 0, 'Should not flag refactoring without stubs');
});

await runTest('skips new files', async () => {
  commitFile('README.md', '# Test');

  stageFile('src/new-file.js', `
function placeholder() {
  // TODO
  return null;
}
module.exports = { placeholder };
`);

  const mod = await import(checkSimplificationPath + '?t=' + Date.now());
  const result = mod.checkSimplification('commit');

  assert.equal(result.violations.length, 0, 'New files should not be flagged');
});

await runTest('skips non-code files', async () => {
  commitFile('docs/guide.md', 'A long guide with lots of content\n'.repeat(50));
  stageFile('docs/guide.md', '# TODO\n');

  const mod = await import(checkSimplificationPath + '?t=' + Date.now());
  const result = mod.checkSimplification('commit');

  assert.equal(result.violations.length, 0, 'Non-code files should not be flagged');
});

await runTest('detects simplification in Python files', async () => {
  const originalCode = `
def process_data(input_data):
    validated = validate_input(input_data)
    transformed = transform_data(validated)
    enriched = enrich_data(transformed)
    filtered = filter_results(enriched)
    sorted_data = sort_results(filtered)
    formatted = format_output(sorted_data)
    return formatted

def validate_input(data):
    if not data:
        raise ValueError("Input required")
    if not isinstance(data, dict):
        raise TypeError("Input must be dict")
    return data

def transform_data(data):
    return [{"id": item["id"], "value": item["value"] * 2} for item in data["items"]]
`.trim();

  commitFile('src/processor.py', originalCode);

  const stubbedCode = `
def process_data(input_data):
    # TODO
    pass

def validate_input(data):
    # TODO
    pass

def transform_data(data):
    # TODO
    pass
`.trim();

  stageFile('src/processor.py', stubbedCode);

  const mod = await import(checkSimplificationPath + '?t=' + Date.now());
  const result = mod.checkSimplification('commit');

  assert.ok(result.violations.length > 0, 'Expected violation for stubbed Python file');
  assert.equal(result.violations[0].type, 'simplification');
  assert.equal(result.violations[0].file, 'src/processor.py');
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
