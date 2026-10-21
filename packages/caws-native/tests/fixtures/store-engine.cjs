'use strict';
// Actual typed store consumer over the original frontend's one-reader transport.
// Qualification fixture only: no stock handler selection or filesystem publish.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cli = process.env.CAWS_NATIVE_STORE_CLI;
const { decodeRuntimeRequest } = require(path.join(cli, 'dist/runtime/protocol.js'));
const { RuntimeFrameReader, writeRuntimeFrame, decodeDispatchGrant, decodeHandoff } = require(
  path.join(cli, 'dist/runtime/live-protocol.js')
);
const { createNativeTranscriptStorePort, reconstructNativeTranscriptStore } = require(
  path.join(cli, 'dist/runtime/transcript-store-client.js')
);
const { encodeStoreProjectionEvents } = require(
  path.join(cli, 'dist/transcripts/store-projection.js')
);
const limits = {
  json: {
    maxInputBytes: 262144,
    maxDecodedCodepoints: 262144,
    maxNodes: 100000,
    maxDepth: 128,
    maxStringCodepoints: 262144,
    maxNumberChars: 4301,
  },
  maxRows: 4096,
  maxEvents: 8192,
  maxCodepoints: 4 * 1024 * 1024,
};
async function main() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Error('store fixture deadline')), 5000);
  const reader = new RuntimeFrameReader(process.stdin);
  const trace = process.env.CAWS_NATIVE_STORE_TRACE
    ? fs.openSync(process.env.CAWS_NATIVE_STORE_TRACE, 'wx', 0o600)
    : null;
  let sequence = 0,
    traceBytes = 0;
  const record = (direction, bytes) => {
    if (trace === null) return;
    const line =
      JSON.stringify({
        sequence: ++sequence,
        direction,
        bytes: bytes.length,
        base64: bytes.toString('base64'),
      }) + '\n';
    traceBytes += Buffer.byteLength(line);
    if (traceBytes > 32 * 1024 * 1024) throw Error('store fixture trace limit');
    fs.writeSync(trace, line);
  };
  const write = async value => {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    record('engine_to_native_attempt', bytes);
    await writeRuntimeFrame(process.stdout, value, controller.signal);
    record('engine_to_native_completed', bytes);
  };
  const read = async () => {
    const bytes = await reader.read(controller.signal);
    record('native_to_engine', bytes);
    return bytes;
  };
  try {
    const request = decodeRuntimeRequest(await read());
    const root = process.env.CAWS_NATIVE_STORE_ROOT;
    await write({
      schema: 'caws.runtime.ready.v1',
      id: request.id,
      runtimeDigest: request.runtimeDigest,
      active: true,
      budgetHome: process.env.CAWS_NATIVE_STORE_BUDGET,
      projectDigest: crypto.createHash('sha256').update(root).digest('hex'),
      sessionId: request.payload.session_id,
    });
    decodeDispatchGrant(await read(), request);
    if (process.env.CAWS_NATIVE_STORE_REQUEST_MODE === 'close-before-store') {
      process.stdout.end();
      return;
    }
    const port = createNativeTranscriptStorePort(
      request,
      {
        read: () => read(),
        write: frame => {
          // Qualification-only protocol refusal: preserve a matching foreign
          // Ready/root while exceeding the store owner's request byte bound.
          if (
            process.env.CAWS_NATIVE_STORE_REQUEST_PAD === '8193' &&
            frame.schema === 'caws.runtime.transcript-store.request.v1'
          )
            return write({ ...frame, qualificationPadding: 'x'.repeat(8193) });
          return write(frame);
        },
      },
      controller.signal
    );
    let bytes,
      code = 0,
      observation;
    try {
      const value = await reconstructNativeTranscriptStore(port, root, request.surface, limits);
      bytes = Buffer.from(encodeStoreProjectionEvents(value, 16 * 1024 * 1024));
      observation = {
        status: 'encoded_after_native_close',
        events: value.events.length,
        rows: value.sourceRows.length,
      };
    } catch (error) {
      code = 1;
      let cleanupClosed = true;
      try {
        port.assertClosed();
      } catch {
        cleanupClosed = false;
      }
      observation = {
        status: 'failed',
        name: error.name,
        referenceType: error.referenceType || null,
        category: error.category || null,
        message: error.message,
        cleanupClosed,
        causes:
          error instanceof AggregateError
            ? error.errors.map(item => ({ name: item.name, message: item.message }))
            : [],
      };
      bytes = Buffer.from(JSON.stringify(observation) + '\n');
    }
    observation.loadedModules = Object.keys(require.cache)
      .sort()
      .map(file => ({
        path: file,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      }));
    if (process.env.CAWS_NATIVE_STORE_OBSERVATION)
      fs.writeFileSync(
        process.env.CAWS_NATIVE_STORE_OBSERVATION,
        JSON.stringify(observation) + '\n',
        { flag: 'wx', mode: 0o600 }
      );
    const token = crypto.randomUUID();
    await write({
      schema: 'caws.runtime.proposal.v2',
      id: request.id,
      runtimeDigest: request.runtimeDigest,
      token,
      response: {
        schema: 'caws.runtime.response.v1',
        id: request.id,
        runtimeDigest: request.runtimeDigest,
        result: { exitCode: code, stdoutBase64: bytes.toString('base64'), stderrBase64: '' },
      },
      containment: null,
    });
    decodeHandoff(await read(), request, token, null);
  } finally {
    clearTimeout(timer);
    if (trace !== null) fs.closeSync(trace);
    process.stdin.destroy();
  }
}
main().catch(error => {
  process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
  process.stdin.destroy();
});
