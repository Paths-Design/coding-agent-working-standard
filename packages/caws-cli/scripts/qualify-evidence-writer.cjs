#!/usr/bin/env node
// Exercise a selected CLI against a COPY of a real failing spec. Never record
// semantic acceptance on the original. All fixtures/receipts stay in outputDir.
// Usage: node qualify-evidence-writer.cjs CLI SPEC OUTPUT_DIR before|after
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');

const [cliArg, sourceArg, outputArg, label] = process.argv.slice(2);
assert.ok(
  cliArg && sourceArg && outputArg && ['before', 'after'].includes(label),
  'Usage: qualify-evidence-writer.cjs CLI SPEC OUTPUT_DIR before|after'
);
const cli = fs.realpathSync(cliArg);
const sourcePath = fs.realpathSync(sourceArg);
const outputDir = path.resolve(outputArg);
const requireCli = createRequire(cli);
const yaml = requireCli('js-yaml');
const { initProject } = requireCli('./store/init-store');
const { deleteEvidenceEntry } = requireCli('./store/specs-writer');
const { loadEvents } = requireCli('./store/events-store');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(outputDir, { recursive: true });
const fixture = fs.mkdtempSync(path.join(outputDir, `${label}-`));
execFileSync('git', ['init', '-q', '-b', 'main', fixture]);
execFileSync('git', ['-C', fixture, 'config', 'user.name', 'Isolated writer qualification']);
execFileSync('git', ['-C', fixture, 'config', 'user.email', 'fixture@example.invalid']);
assert.equal(initProject(fixture).ok, true);
const original = fs.readFileSync(sourcePath, 'utf8');
const originalParsed = yaml.load(original);
const id = originalParsed.id;
assert.match(id, /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d+[a-z]*$/);
assert.equal(
  originalParsed.evidence.some((entry) => entry.criterion_id === 'A20'),
  false
);
const target = path.join(fixture, '.caws', 'specs', `${id}.yaml`);
fs.writeFileSync(target, original);
const eventPath = path.join(fixture, '.caws', 'events.jsonl');
const readEvents = () => (fs.existsSync(eventPath) ? fs.readFileSync(eventPath, 'utf8') : '');
const eventsBefore = readEvents();
// Isolated test process: no live identity, grants or machine state. The only
// governance writes made by its CLI target the copied fixture.
const env = {
  PATH: process.env.PATH,
  HOME: fixture,
  CAWS_HOME: path.join(fixture, 'machine'),
  CI: 'true',
};
const run = (criterion, evidence) =>
  spawnSync(
    process.execPath,
    [
      cli,
      'specs',
      'evidence',
      id,
      '--ac',
      criterion,
      '--status',
      'unchecked',
      '--evidence-ref',
      evidence,
    ],
    { cwd: fixture, env, encoding: 'utf8' }
  );
const evidence =
  'WRITER QUALIFICATION ONLY: copied specimen, no semantic acceptance.\nPrivate generation and opt-in permissions remain historical qualifications.\r\nRetry qualification remains separate.';
const recorded = run('A20', evidence);
const receipt = {
  label,
  cli,
  fixture,
  inputSha256: sha(original),
  writerSha256: sha(fs.readFileSync(path.join(path.dirname(cli), 'store/specs-writer.js'))),
  exitCode: recorded.status,
  stdout: recorded.stdout,
  stderr: recorded.stderr,
};
if (label === 'before') {
  assert.equal(recorded.status, 1);
  assert.match(recorded.stderr + recorded.stdout, /store\.lifecycle\.plan_rejected/);
  assert.match(
    recorded.stderr + recorded.stdout,
    /bad indentation|multiline key may not be an implicit key/
  );
  assert.equal(fs.readFileSync(target, 'utf8'), original);
  assert.equal(readEvents(), eventsBefore);
  receipt.rejectionPreservedSpecAndEvents = true;
} else {
  assert.equal(recorded.status, 0, recorded.stderr + recorded.stdout);
  const bytes = fs.readFileSync(target, 'utf8');
  const parsed = yaml.load(bytes);
  // A source with no final newline needs a separator before the appended row.
  // Every original byte remains the prefix; deletion cannot infer whether that
  // separator existed before insertion, so it leaves the separating newline.
  const preservedSource = original.endsWith('\n') ? original : original + '\n';
  assert.equal(bytes.startsWith(original), true);
  assert.deepEqual(parsed.evidence.slice(0, -1), originalParsed.evidence);
  assert.equal(parsed.evidence.at(-1).criterion_id, 'A20');
  assert.equal(parsed.evidence.at(-1).evidence_ref, evidence);
  assert.equal(deleteEvidenceEntry(bytes, 'A20').bytes, preservedSource);
  assert.equal(parsed.lifecycle_state, originalParsed.lifecycle_state);
  const loaded = loadEvents(path.join(fixture, '.caws'));
  assert.equal(loaded.ok, true);
  assert.equal(loaded.value.events.at(-1).event, 'ac_recorded');
  assert.equal(loaded.value.events.at(-1).data.evidence_ref, evidence);
  const count = loaded.value.events.length;
  assert.equal(run('A20', 'repeat\nexact').status, 0);
  const repeated = fs.readFileSync(target, 'utf8');
  assert.equal(
    yaml.load(repeated).evidence.filter((entry) => entry.criterion_id === 'A20').length,
    1
  );
  assert.equal(deleteEvidenceEntry(repeated, 'A20').bytes, preservedSource);
  assert.equal(loadEvents(path.join(fixture, '.caws')).value.events.length, count + 1);
  const stableEvents = readEvents();
  assert.equal(run('A999', 'must refuse').status, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), repeated);
  assert.equal(readEvents(), stableEvents);
  receipt.historicalValuesAndBytesPreserved = true;
  receipt.requiredFinalLineSeparatorAdded = !original.endsWith('\n');
  receipt.exactNewValueAndMatchingAudit = true;
  receipt.repeatOneRowTwoEvents = true;
  receipt.rejectionPreservedSpecAndEvents = true;
}
receipt.originalUnchanged = fs.readFileSync(sourcePath, 'utf8') === original;
assert.equal(receipt.originalUnchanged, true);
fs.writeFileSync(path.join(outputDir, `${label}-receipt.json`), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
