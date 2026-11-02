// Deliberate pre-Ready custody fixture. This is not the production runtime.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const record = process.env.CAWS_NATIVE_CUSTODY_RECORD;
assert.ok(record && path.isAbsolute(record));
const root = path.dirname(record);
function atomic(file, value) {
  const pending = `${file}.${process.pid}.pending`;
  const fd = fs.openSync(pending, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(pending, file);
}
// Input EOF cannot make this engine naturally exit and simulate owned cleanup.
setInterval(() => {}, 1000);
let buffer = '';
let accepted = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', bytes => {
  buffer += bytes;
  assert.ok(Buffer.byteLength(buffer) <= 4_198_400);
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    const rawRequest = buffer.slice(0, newline + 1);
    buffer = buffer.slice(newline + 1);
    assert.equal(accepted, false, 'unexpected second frame before Ready');
    accepted = true;
    const request = JSON.parse(rawRequest);
    const frontendPid = request.caller.processId;
    assert.equal(request.schema, 'caws.runtime.request.v1');
    assert.ok(Number.isInteger(frontendPid) && frontendPid > 1);
    assert.notEqual(frontendPid, process.ppid, 'caller must remain original frontend');
    assert.ok(request.id.startsWith(`${frontendPid}-`));
    assert.equal(request.event, 'session_start');
    assert.equal(request.runtimeDigest, 'a'.repeat(64));
    assert.equal(request.inputJson, '{}');
    const produced = Buffer.from('custody fixture waiting before Ready\n');
    fs.writeFileSync(path.join(root, 'node-stdout-produced.bin'), Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(root, 'node-stderr-produced.bin'), produced, { flag: 'wx', mode: 0o600 });
    // A producer mirror and byte count do not establish exact consumer delivery.
    assert.equal(fs.writeSync(2, produced), produced.length);
    atomic(record, { schema: 'caws.custody.fixture.ready.v1', nodePid: process.pid,
      parentPid: process.ppid, frontendPid, rawRequest });
  }
});
process.stdin.on('end', () => atomic(`${record}.stdin-eof.json`, {
  nodePid: process.pid, accepted, remainingBytes: Buffer.byteLength(buffer), timerRemainsLive: true,
}));
