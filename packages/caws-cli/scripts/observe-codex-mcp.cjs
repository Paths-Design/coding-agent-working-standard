'use strict';

// Observation only. No command/source execution, child processes, or authority.
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { setTimeout, clearTimeout } = require('node:timers');

const output = process.argv[2];
if (
  process.argv.length !== 3 ||
  !path.isAbsolute(output) ||
  fs.realpathSync(path.dirname(output)) !== path.dirname(output)
) {
  throw Error('Expected a new journal in a physical private directory');
}
const parent = fs.statSync(path.dirname(output));
if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0)
  throw Error('Expected a user-owned private journal directory');
const journal = fs.openSync(output, 'wx', 0o600);
const MAX_FRAME = 1024 * 1024;
const MAX_JOURNAL = 8 * 1024 * 1024;
const decode = new TextDecoder('utf-8', { fatal: true });
let journalBytes = 0;
let sequence = 0;
let calls = 0;
let initialized = false;
let closed = false;
let pending = Buffer.alloc(0);

function record(value) {
  const bytes = Buffer.from(
    JSON.stringify({
      sequence: sequence++,
      atMs: Date.now(),
      ...value,
    }) + '\n'
  );
  if (journalBytes + bytes.length > MAX_JOURNAL) throw Error('Journal bound');
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(journal, bytes, offset, bytes.length - offset);
    if (written <= 0) throw Error('Journal write failed');
    offset += written;
  }
  journalBytes += bytes.length;
  fs.fsyncSync(journal);
}
function descriptor(fd) {
  const s = fs.fstatSync(fd, { bigint: true });
  return {
    fd,
    kind: s.isSocket()
      ? 'socket'
      : s.isFIFO()
        ? 'fifo'
        : s.isFile()
          ? 'file'
          : s.isCharacterDevice()
            ? 'character-device'
            : 'other',
    dev: s.dev.toString(),
    ino: s.ino.toString(),
    mode: s.mode.toString(),
  };
}
function stop(code, reason) {
  if (closed) return;
  try {
    record({ kind: 'terminal', code, reason });
  } catch {
    code = 2;
  }
  closed = true;
  clearTimeout(timer);
  try {
    fs.closeSync(journal);
  } catch {
    code = 2;
  }
  process.exitCode = code;
  process.stdin.destroy();
  // Normal exit follows the drain of all queued response bytes.
  process.stdout.end();
}
function reply(id, result) {
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  record({ kind: 'sent', rawBase64: bytes.toString('base64') });
  process.stdout.write(bytes);
}
function frame(bytes) {
  // Preserve the original frame, including whitespace and duplicate JSON keys.
  record({ kind: 'received', rawBase64: bytes.toString('base64') });
  const message = JSON.parse(decode.decode(bytes));
  if (!message || typeof message !== 'object' || Array.isArray(message))
    throw Error('Invalid frame');
  const id = message.id;
  if (message.jsonrpc !== '2.0') throw Error('Invalid protocol');
  if (message.method === 'notifications/initialized') {
    if (!initialized || id !== undefined) throw Error('Invalid initialization notification');
    return;
  }
  if (id === undefined || (typeof id !== 'string' && !Number.isSafeInteger(id)))
    throw Error('Expected a request identifier');
  if (message.method === 'initialize') {
    if (initialized) throw Error('Repeated initialization');
    initialized = true;
    return reply(id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'caws-host-observation', version: '1' },
      capabilities: {
        tools: {},
        experimental: {
          'codex/caller-context': { version: 1 },
          'codex/sandbox-state': {},
        },
      },
    });
  }
  if (!initialized) throw Error('Request before initialization');
  if (message.method === 'ping') return reply(id, {});
  if (message.method === 'tools/list') {
    return reply(id, {
      tools: [
        {
          name: 'caws_observe_host_call',
          description:
            'Record one original host MCP request. Returns an inert acknowledgment. ' +
            'Does not execute commands, edit project files, or grant authority.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          },
        },
      ],
    });
  }
  if (message.method === 'tools/call') {
    const p = message.params;
    const a = p?.arguments;
    if (
      ++calls !== 1 ||
      p?.name !== 'caws_observe_host_call' ||
      a === null ||
      typeof a !== 'object' ||
      Array.isArray(a) ||
      Object.keys(a).length !== 0
    )
      throw Error('Expected exactly one empty-argument observation');
    record({
      kind: 'call-observed',
      pid: process.pid,
      ppid: process.ppid,
      executable: process.execPath,
      cwd: process.cwd(),
      descriptors: [descriptor(0), descriptor(1)],
      boundary: 'Raw host-carried data and local process facts; not authenticated authority',
    });
    return reply(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            observationOnly: true,
            userSourceExecuted: false,
            authorityGranted: false,
          }),
        },
      ],
      isError: false,
    });
  }
  throw Error('Unsupported request');
}

const timer = setTimeout(() => stop(2, 'observation deadline'), 180000);
record({
  kind: 'started',
  pid: process.pid,
  ppid: process.ppid,
  nodeVersion: process.version,
  executable: process.execPath,
  cwd: process.cwd(),
  descriptors: [descriptor(0), descriptor(1)],
});
process.stdout.on('error', () => stop(2, 'stdout failed'));
process.stdin.on('error', () => stop(2, 'stdin failed'));
process.stdin.on('data', (chunk) => {
  try {
    pending = Buffer.concat([pending, chunk]);
    let at;
    while ((at = pending.indexOf(10)) !== -1) {
      if (at + 1 > MAX_FRAME) {
        record({
          kind: 'oversized',
          byteCount: at + 1,
          rawPrefixBase64: pending.subarray(0, MAX_FRAME).toString('base64'),
        });
        throw Error('Frame bound');
      }
      const bytes = pending.subarray(0, at + 1);
      pending = pending.subarray(at + 1);
      frame(bytes);
    }
    if (pending.length > MAX_FRAME) {
      record({
        kind: 'oversized',
        byteCount: pending.length,
        rawPrefixBase64: pending.subarray(0, MAX_FRAME).toString('base64'),
      });
      throw Error('Frame bound');
    }
  } catch {
    stop(2, 'invalid or unsupported input');
  }
});
process.stdin.on('end', () => {
  if (closed) return;
  try {
    if (pending.length) record({ kind: 'partial', rawBase64: pending.toString('base64') });
  } catch {
    return stop(2, 'partial journal failed');
  }
  stop(pending.length === 0 && calls === 1 ? 0 : 2, 'stdin ended');
});
process.once('SIGTERM', () => stop(2, 'terminated'));
process.once('SIGINT', () => stop(2, 'interrupted'));
