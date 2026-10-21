const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const qualifier = require('../../dist/tooling/transcript-runtime-floor');
const entry = require.resolve('../../dist/tooling/transcript-runtime-floor-entry');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

describe('bounded emitted transcript component qualification on the test runtime', () => {
  let root;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-floor-')));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('real registry preparation preserves legacy bytes, late origin spill and hostile outcomes', () => {
    const { source, artifacts, summary } = qualifier.qualifyTranscriptFloorComponent();
    expect(source.length).toBe(21668);
    expect(sha(source)).toBe('d2446ce7b6d05defdaafd7d9f277c540231cfde47ceef2001994a6d4e8b13d53');
    expect(summary.publication).toBe('not_attempted');
    expect(summary.lateResult).toEqual({
      originatingTurn: 1,
      currentTurn: 2,
      spillFile: 'turn-001.payloads.json',
      length: 21001,
      digest: '943508de998898667b663d47ce1718249bd195d73d3ca905e63681a2f4f9a70e',
      duration_s: 2,
    });
    const first = JSON.parse(artifacts.find((a) => a.name === 'turn-001.json').bytes);
    const second = JSON.parse(artifacts.find((a) => a.name === 'turn-002.json').bytes);
    const spill = JSON.parse(artifacts.find((a) => a.name === first.payloads_sidecar).bytes);
    expect(spill[first.timeline[0].output_ref.sha256]).toBe('x'.repeat(21001));
    expect(second.payloads_sidecar).toBeNull();
    expect(summary.negativeControls).toEqual({
      invalidUtf8: { disposition: 'failed', phase: 'utf8', hasGeneration: false },
      emptySource: { disposition: 'retain', currentness: 'noncurrent', hasGeneration: false },
      embedded4301: { disposition: 'failed', phase: 'numeric', hasGeneration: false },
      publication: 'not_attempted',
      callerMutationPreservedBytes: true,
      returnedCopyMutationPreservedBytes: true,
    });
    expect(summary.calendar).toEqual({ profileId: 'fixture-exact-utc-pairs/1', timezone: 'UTC' });
    const calendar = qualifier.transcriptFloorInput(source).calendar;
    expect(calendar.epochSeconds('unexpected')).toBeNull();
    expect(calendar.secondsBetween('unexpected', 'unexpected')).toBeNull();
  });

  test('strict arguments reject omitted, relative, duplicate and additional options', () => {
    for (const args of [
      [],
      ['--output'],
      ['--output', 'relative'],
      ['--output', root, '--output', root],
      ['--verify', root],
    ])
      expect(() => qualifier.parseTranscriptFloorArguments(args)).toThrow(/Usage:/);
    expect(qualifier.parseTranscriptFloorArguments(['--output', root])).toBe(root);
  });

  test('capture is private and immutable on retry, and verifier rejects spill corruption with rewritten receipt', () => {
    const output = path.join(root, 'capture');
    const receiptPath = qualifier.captureTranscriptFloor(output);
    const receipt = JSON.parse(fs.readFileSync(receiptPath));
    expect(receipt.runtime.version).toBe(process.versions.node);
    expect(receipt.runtime.executableSHA256).toBe(sha(fs.readFileSync(process.execPath)));
    const packageJsonPath = path.resolve(__dirname, '../../package.json');
    const packageJsonBytes = fs.readFileSync(packageJsonPath);
    expect(receipt.packageIdentity).toEqual({
      path: fs.realpathSync(packageJsonPath),
      byteLength: packageJsonBytes.length,
      sha256: sha(packageJsonBytes),
      engines: { node: '>=18.0.0' },
    });
    expect(receipt.modulesAfter).toEqual(receipt.modulesBefore);
    expect(receipt.modulesBefore.some((a) => a.path.endsWith('/transcripts/registry.js'))).toBe(
      true
    );
    expect(
      receipt.modulesBefore.some((a) => a.path.endsWith('/transcripts/render-prepare.js'))
    ).toBe(true);
    expect(fs.statSync(output).mode & 0o777).toBe(0o700);
    expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);
    const originalReceipt = fs.readFileSync(receiptPath);
    expect(() => qualifier.captureTranscriptFloor(output)).toThrow(/must be new/);
    expect(fs.readFileSync(receiptPath)).toEqual(originalReceipt);
    expect(() => qualifier.verifyTranscriptFloorCapture(output)).not.toThrow();
    const spill = path.join(output, 'prepared', 'turn-001.payloads.json');
    const value = JSON.parse(fs.readFileSync(spill));
    value[Object.keys(value)[0]] = 'y'.repeat(21001);
    fs.writeFileSync(spill, JSON.stringify(value));
    receipt.artifacts[0].sha256 = sha(fs.readFileSync(spill));
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    expect(() => qualifier.verifyTranscriptFloorCapture(output)).toThrow();
  });

  test.each(['write failure', 'corruption'])(
    '%s retains diagnostic bytes without a completed receipt or overwrite on retry',
    (failure) => {
      const output = path.join(root, 'partial');
      const spill = path.join(output, 'prepared', 'turn-001.payloads.json');
      const originalWrite = fs.writeFileSync;
      let faultsFired = 0;
      // Fault injection is limited to capture I/O; real preparation and verification run.
      const write = jest.spyOn(fs, 'writeFileSync').mockImplementation((file, bytes, options) => {
        originalWrite(file, bytes, options);
        if (file === spill) {
          faultsFired++;
          if (failure === 'write failure') throw new Error('injected write failure');
          originalWrite(file, Buffer.from(bytes.toString('utf8').replace('x', 'y')));
        }
      });
      expect(() => qualifier.captureTranscriptFloor(output)).toThrow(
        failure === 'write failure'
          ? /^injected write failure$/
          : /Late spill must retain exactly 21001 x characters/
      );
      write.mockRestore();
      expect(faultsFired).toBe(1);
      expect(fs.existsSync(path.join(output, 'source.jsonl'))).toBe(true);
      expect(fs.existsSync(spill)).toBe(true);
      expect(fs.existsSync(path.join(output, 'receipt.json'))).toBe(false);
      expect(fs.readdirSync(path.join(output, 'prepared')).length).toBe(
        failure === 'write failure' ? 1 : 4
      );
      const retained = fs.readFileSync(spill);
      const retainedSpill = JSON.parse(retained);
      expect(retainedSpill[Object.keys(retainedSpill)[0]]).toBe(
        failure === 'write failure' ? 'x'.repeat(21001) : 'y' + 'x'.repeat(21000)
      );
      expect(() => qualifier.captureTranscriptFloor(output)).toThrow(/must be new/);
      expect(fs.readFileSync(spill)).toEqual(retained);
      expect(fs.existsSync(path.join(output, 'receipt.json'))).toBe(false);
    }
  );

  test('changed package engine contract refuses before creating capture output', () => {
    const output = path.join(root, 'contract-mismatch');
    const packageJsonPath = path.resolve(__dirname, '../../package.json');
    const originalRead = fs.readFileSync;
    // Metadata refusal only; this does not substitute process runtime identity.
    jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
      if (file === packageJsonPath) return Buffer.from('{"engines":{"node":">=20.0.0"}}');
      return originalRead(file, ...args);
    });
    expect(() => qualifier.captureTranscriptFloor(output)).toThrow(/Node engine contract/);
    expect(fs.existsSync(output)).toBe(false);
  });

  test('missing parent and package-local output refuse without creating output', () => {
    const missing = path.join(root, 'missing', 'capture');
    expect(() => qualifier.captureTranscriptFloor(missing)).toThrow();
    expect(fs.existsSync(path.dirname(missing))).toBe(false);
    const internal = path.resolve(__dirname, '../../floor-forbidden-output');
    expect(() => qualifier.captureTranscriptFloor(internal)).toThrow(/external/);
    expect(fs.existsSync(internal)).toBe(false);
  });

  test('entry uses the actual runtime and wrong version exits nonzero before output', () => {
    const output = path.join(root, 'entry');
    const result = spawnSync(process.execPath, [entry, '--output', output], { encoding: 'utf8' });
    if (process.versions.node === '18.0.0') {
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).publication).toBe('not_attempted');
      expect(fs.existsSync(path.join(output, 'receipt.json'))).toBe(true);
    } else {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `requires actual Node 18.0.0; observed ${process.versions.node}`
      );
      expect(result.stdout).toBe('');
      expect(fs.existsSync(output)).toBe(false);
    }
  });
});
