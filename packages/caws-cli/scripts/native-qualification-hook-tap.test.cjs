'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const tap = path.join(__dirname, 'native-qualification-hook-tap.cjs');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function runFixture(source, input) {
  const capture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-hook-tap-')));
  try {
    const run = spawnSync(process.execPath, [tap, capture, process.execPath, '-e', source], {
      input,
      timeout: 10000,
      maxBuffer: 3 * 1024 * 1024,
    });
    assert.equal(run.error, undefined);
    const names = fs.readdirSync(capture);
    const receiptName = names.find((name) => name.endsWith('.json'));
    assert.ok(receiptName, 'a receipt must be retained');
    const receipt = JSON.parse(fs.readFileSync(path.join(capture, receiptName)));
    return {
      run,
      receipt,
      data: Object.fromEntries(
        ['stdin', 'stdout', 'stderr'].map((stream) => [
          stream,
          fs.readFileSync(path.join(capture, receipt.id + '.' + stream)),
        ])
      ),
    };
  } finally {
    fs.rmSync(capture, { recursive: true, force: true });
  }
}

test('retains exact callback bytes while preserving child output and exit status', () => {
  const input = Buffer.from('{"session_id":"fixture","value":"☃"}');
  const observed = runFixture(
    'process.stdin.pipe(process.stdout); process.stderr.write("denied"); process.stdin.on("end", () => { process.exitCode = 2; });',
    input
  );
  assert.equal(observed.run.status, 2);
  assert.deepEqual(observed.run.stdout, input);
  assert.equal(observed.run.stderr.toString(), 'denied');
  assert.deepEqual(observed.data.stdin, input);
  assert.deepEqual(observed.data.stdout, input);
  assert.equal(observed.data.stderr.toString(), 'denied');
  assert.equal(observed.receipt.complete, true);
  assert.equal(observed.receipt.streams.stdin.sha256, hash(input));
  assert.equal(observed.receipt.exitCode, 2);
});

test('records overflow as incomplete without truncating the forwarded output', () => {
  const observed = runFixture(
    'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("x".repeat(1048577)));',
    Buffer.from('{}')
  );
  assert.equal(observed.run.status, 0);
  assert.equal(observed.run.stdout.length, 1048577);
  assert.equal(observed.receipt.complete, false);
  assert.equal(observed.receipt.streams.stdout.totalBytes, 1048577);
  assert.ok(observed.data.stdout.length <= 1048576);
});
