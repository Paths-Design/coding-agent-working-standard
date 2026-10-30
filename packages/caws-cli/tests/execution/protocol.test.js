const { createHash } = require('node:crypto');
const {
  decodeAuthorizerRequest,
  encodeAuthorizerReply,
  InvalidAuthorizerFrame,
  MAX_AUTHORIZER_REQUEST_BYTES,
} = require('../../dist/execution/protocol');
const { EXECUTION_REASON_CODES } = require('../../dist/execution/prepared');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const image = (path) => ({ path, sha256: 'c'.repeat(64) });
function request(phase = 'analyze') {
  const state = Buffer.from('{}');
  const record = {
    schema: 'caws.execution.prepared.v1',
    invocationId: 'owned-invocation',
    association: {
      kind: 'codex-mcp-v1',
      sessionId: 'lineage-A',
      threadId: 'child-B',
      callId: 'native-C',
      callerAnchor: '/project/lane',
      serverEnvironmentId: 'server-D',
    },
    projectRoot: '/project',
    execution: {
      executable: image('/bin/bash'),
      argv: ['/bin/bash', '--noprofile', '--norc', '-c', ''],
      cwd: '/project/lane',
      environment: [],
      stdinBase64: '',
    },
    profile: { kind: 'bash-clean-v1', source: '', utilities: [] },
    sandbox: {
      stateBase64: state.toString('base64'),
      stateSha256: hash(state),
      launcher: image('/trusted/codex'),
      environmentAnchor: '/server',
    },
    limits: {
      preparationDeadlineUnixMs: 12345,
      jobTimeoutMs: 60000,
      terminationGraceMs: 1000,
      maxOutputBytes: 1024,
    },
  };
  const recordBytes = Buffer.from(JSON.stringify(record));
  return {
    protocol: 'caws.execution.authorizer.v1',
    phase,
    invocationId: record.invocationId,
    recordBase64: recordBytes.toString('base64'),
    executionDigest: hash(recordBytes),
    expectedAuthorityRevision: phase === 'analyze' ? null : 'revision-1',
    fence:
      phase === 'analyze'
        ? null
        : { dev: '16777229', ino: '18446744073709551615', nonce: 'private-nonce' },
  };
}
function frame(value) {
  const payload =
    typeof value === 'string' ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}
function reply() {
  const original = request();
  return {
    protocol: original.protocol,
    phase: original.phase,
    invocationId: original.invocationId,
    executionDigest: original.executionDigest,
    decision: 'allow',
    authorityRevision: 'revision-1',
    reasonCodes: [],
  };
}
const reject = (value) =>
  expect(() => decodeAuthorizerRequest(frame(value))).toThrow(new InvalidAuthorizerFrame());

describe('private execution authorizer framing', () => {
  test.each(['analyze', 'final_validate'])(
    'owns original record bytes and preserves strict phase/correlation for %s',
    (phase) => {
      const input = request(phase);
      const result = decodeAuthorizerRequest(frame(input));
      expect(result.request).toEqual(input);
      expect(result.recordBytes).toEqual(Buffer.from(input.recordBase64, 'base64'));
      expect(hash(result.recordBytes)).toBe(result.request.executionDigest);
      expect(result.record.association.threadId).toBe('child-B');
      expect(Object.isFrozen(result.request)).toBe(true);
      if (phase === 'final_validate') expect(Object.isFrozen(result.request.fence)).toBe(true);
    }
  );

  test('all partial frames, trailing bytes, second frames and oversized declarations refuse', () => {
    const complete = frame(request());
    for (let count = 0; count < complete.length; count++)
      expect(() => decodeAuthorizerRequest(complete.subarray(0, count))).toThrow(
        InvalidAuthorizerFrame
      );
    for (const data of [
      Buffer.concat([complete, Buffer.from('x')]),
      Buffer.concat([complete, complete]),
      Buffer.from([0, 0, 0, 0]),
      Buffer.alloc(MAX_AUTHORIZER_REQUEST_BYTES + 5),
      'text',
    ])
      expect(() => decodeAuthorizerRequest(data)).toThrow(new InvalidAuthorizerFrame());
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_AUTHORIZER_REQUEST_BYTES + 1);
    expect(() => decodeAuthorizerRequest(header)).toThrow(InvalidAuthorizerFrame);
  });

  test('requires every outer member including explicit nullable fields, and rejects extension/duplicate shapes', () => {
    for (const key of Object.keys(request())) {
      const input = request();
      delete input[key];
      reject(input);
    }
    const input = request();
    input.extension = 1;
    reject(input);
    reject(Object.values(request()));
    reject(JSON.stringify(request()).replace('"protocol":', '"protocol":"wrong","protocol":'));
    const final = request('final_validate');
    for (const key of ['dev', 'ino', 'nonce']) {
      const bad = globalThis.structuredClone(final);
      delete bad.fence[key];
      reject(bad);
    }
    final.fence.extra = true;
    reject(final);
    const objectPhase = request();
    objectPhase.phase = { analyze: null };
    reject(objectPhase);
  });

  test('rejects wrong phase combinations, alternate u64 representations and malformed digests', () => {
    for (const [phase, revision, fence] of [
      ['analyze', 'rev', null],
      ['analyze', null, { dev: '1', ino: '2', nonce: 'n' }],
      ['final_validate', null, null],
      ['unknown', null, null],
    ]) {
      const input = request();
      input.phase = phase;
      input.expectedAuthorityRevision = revision;
      input.fence = fence;
      reject(input);
    }
    for (const invalid of [
      '-1',
      '01',
      '+1',
      '1.0',
      '18446744073709551616',
      '',
      1,
      'x'.repeat(21),
    ]) {
      const input = request('final_validate');
      input.fence.ino = invalid;
      reject(input);
    }
    const zero = request('final_validate');
    zero.fence.dev = '0';
    zero.fence.ino = '0';
    expect(decodeAuthorizerRequest(frame(zero)).request.fence).toEqual(zero.fence);
    for (const field of ['invocationId', 'expectedAuthorityRevision']) {
      for (const invalid of ['', '\n', '\u0085', 'x'.repeat(257), '\ud800']) {
        const input = request('final_validate');
        input[field] = invalid;
        reject(input);
      }
    }
    const nonce = request('final_validate');
    nonce.fence.nonce = '\0';
    reject(nonce);
    const digest = request();
    digest.executionDigest = 'A'.repeat(64);
    reject(digest);
  });

  test('rejects changed record bytes, wrong invocation correlation, noncanonical base64 and invalid inner schema', () => {
    for (const change of [
      (input) => {
        input.executionDigest = 'd'.repeat(64);
      },
      (input) => {
        input.invocationId = 'other';
      },
      (input) => {
        input.recordBase64 += '\n';
      },
      (input) => {
        const bytes = Buffer.from('{}');
        input.recordBase64 = bytes.toString('base64');
        input.executionDigest = hash(bytes);
      },
      (input) => {
        input.recordBase64 = 'a'.repeat(2796205);
      },
    ]) {
      const input = request();
      change(input);
      reject(input);
    }
    const malformed = frame(request());
    malformed[4] = 0xff;
    expect(() => decodeAuthorizerRequest(malformed)).toThrow(new InvalidAuthorizerFrame());
  });

  test('encodes exact observation and admits only the closed reason-code vocabulary', () => {
    for (const decision of ['allow', 'deny', 'unresolved']) {
      const input = reply();
      input.decision = decision;
      for (const code of EXECUTION_REASON_CODES) {
        input.reasonCodes = [code];
        const encoded = encodeAuthorizerReply(input);
        expect(encoded.readUInt32BE()).toBe(encoded.length - 4);
        expect(JSON.parse(encoded.subarray(4).toString())).toEqual(input);
      }
    }
    const denied = reply();
    denied.decision = 'unresolved';
    denied.authorityRevision = null;
    expect(JSON.parse(encodeAuthorizerReply(denied).subarray(4).toString())).toEqual(denied);
    for (const change of [
      (input) => {
        input.reasonCodes = ['unknown_code'];
      },
      (input) => {
        input.reasonCodes = Array(33).fill('cancelled');
      },
      (input) => {
        input.reasonCodes = null;
      },
      (input) => {
        input.decision = { allow: null };
      },
      (input) => {
        input.authorityRevision = null;
      },
      (input) => {
        input.extra = 'source';
      },
      (input) => {
        delete input.authorityRevision;
      },
      (input) => {
        input.protocol = 'unknown';
      },
      (input) => {
        input.phase = 'unknown';
      },
      (input) => {
        input.invocationId = '';
      },
      (input) => {
        input.executionDigest = '';
      },
    ]) {
      const input = reply();
      change(input);
      expect(() => encodeAuthorizerReply(input)).toThrow(new InvalidAuthorizerFrame());
    }
    const maximum = reply();
    maximum.reasonCodes = Array(32).fill('cancelled');
    expect(
      JSON.parse(encodeAuthorizerReply(maximum).subarray(4).toString()).reasonCodes
    ).toHaveLength(32);
  });
});
