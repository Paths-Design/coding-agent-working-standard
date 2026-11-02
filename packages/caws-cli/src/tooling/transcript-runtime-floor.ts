/** Bounded fixture qualification; no native publication or runtime selection authority. */
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  prepareSessionArtifacts,
  RENDER_JSON_4300,
  renderFloat,
  renderInteger,
  type PrepareSessionArtifactsInput,
  type SessionArtifactPreparation,
} from '../transcripts';
import { createDefaultTranscriptRegistry } from '../transcripts/registry';

const fullOutput = 'x'.repeat(21001);
const expectedArtifacts = [
  [
    'turn-001.payloads.json',
    21077,
    '7506fcd389164e781ac163e602fc3e707323455fe200af0b016bd41da44a96db',
  ],
  ['turn-001.json', 3992, 'd141d8ec414a49be14ece782e0f4e02e3e91d7074dd9de1596d0d24beeb9c461'],
  ['turn-002.json', 1104, 'e230f435f1c55d96e3d4f13dac13ae582729b8a48f89f7697846ae5dc21fb4a2'],
  ['session-index.json', 223, 'd5bb3e32c3982aceca16757ac4527be5d832a616456c1d571afa0d351aa4952e'],
] as const;
export const QUALIFICATION_LIMITS = Object.freeze([
  'Ordinary emitted-module component evidence only; no production caller, installed CLI or native publication.',
  'Explicit finite UTC fixture calendar; no production calendar or full R27 qualification.',
  'Executable and module identities are observations, not launch authority or hermetic attestation.',
]);
function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function transcriptFloorSource(): Buffer {
  return Buffer.from(
    [
      { type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'Run the command' } },
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01Z',
        message: {
          content: [
            { type: 'tool_use', id: 'late', name: 'Bash', input: { command: 'echo inspected' } },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-01-01T00:00:02Z',
        message: { content: 'Continue while it returns' },
      },
      {
        type: 'user',
        timestamp: '2026-01-01T00:00:03Z',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'late', content: fullOutput, is_error: false },
          ],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:04Z',
        message: {
          content: [
            { type: 'text', text: 'The late result remains attached to its originating turn.' },
          ],
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n'
  );
}
export function transcriptFloorInput(bytes: Uint8Array): PrepareSessionArtifactsInput {
  const epochs: Readonly<Record<string, number>> = Object.freeze({
    '2026-01-01T00:00:00Z': 1767225600,
    '2026-01-01T00:00:01Z': 1767225601,
    '2026-01-01T00:00:02Z': 1767225602,
    '2026-01-01T00:00:03Z': 1767225603,
    '2026-01-01T00:00:04Z': 1767225604,
  });
  return {
    transcript: {
      path: '/fixture/chats/scenario.jsonl',
      disposition: 'read',
      source: {
        sourceId: 'synthetic-transcript',
        sourceGeneration: 'scenario-1',
        inode: 'observed-1',
        bytes,
        size: BigInt(bytes.length),
      },
    },
    audit: { path: '/fixture/audit.jsonl', disposition: 'absent' },
    hookOutcomes: { path: '/fixture/hooks.jsonl', disposition: 'absent' },
    subagents: {
      claudeCandidate: { path: '/fixture/chats/scenario/subagents', kind: 'absent' },
      qwenCandidate: { path: '/fixture/subagents/scenario', kind: 'absent' },
    },
    registry: createDefaultTranscriptRegistry({ numericProfile: RENDER_JSON_4300 }),
    numericProfile: RENDER_JSON_4300,
    calendar: {
      profileId: 'fixture-exact-utc-pairs/1',
      timezone: 'UTC',
      epochSeconds: (timestamp) => (timestamp === null ? null : (epochs[timestamp] ?? null)),
      secondsBetween: (first, second) =>
        first === '2026-01-01T00:00:01Z' && second === '2026-01-01T00:00:03Z'
          ? renderFloat(2)
          : null,
    },
    context: {
      sessionId: 'scenario',
      cwd: '/fixture/project',
      startedAt: '2026-01-01T00:00:00Z',
      model: 'fixture-model',
      branch: 'fixture',
      headSha: 'fixture-head',
      startSha: 'fixture-start',
      dirtyFiles: renderInteger(0),
    },
    priorInventory: { observationId: 'empty-before', artifacts: [] },
    limits: {
      maximumInputBytes: 1_000_000,
      maximumArtifactBytes: 1_000_000,
      maximumTotalArtifactBytes: 2_000_000,
      maximumArtifacts: 100,
    },
  };
}
export interface CapturedFloorArtifact {
  readonly name: string;
  readonly role: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}
/** Fixed fixture oracles do not trust a caller-editable receipt to define correctness. */
export function verifyTranscriptFloorArtifacts(artifacts: readonly CapturedFloorArtifact[]): void {
  assert.deepEqual(artifacts.map((a) => a.name).sort(), expectedArtifacts.map((a) => a[0]).sort());
  const get = (name: string): Buffer => {
    const artifact = artifacts.find((a) => a.name === name);
    assert.ok(artifact, `Missing ${name}`);
    return artifact.bytes;
  };
  const first = JSON.parse(get('turn-001.json').toString('utf8'));
  const second = JSON.parse(get('turn-002.json').toString('utf8'));
  const index = JSON.parse(get('session-index.json').toString('utf8'));
  assert.deepEqual(index, {
    schema_version: 1,
    session_id: 'scenario',
    project: 'project',
    turn_count: 2,
    ts_start: '2026-01-01T00:00:00Z',
    ts_end: '2026-01-01T00:00:04Z',
    branch: 'fixture',
    head_sha: 'fixture-head',
  });
  assert.equal(first.turn, 1);
  assert.equal(second.turn, 2);
  assert.equal(first.user, 'Run the command');
  assert.equal(second.user, 'Continue while it returns');
  assert.equal(first.payloads_sidecar, 'turn-001.payloads.json');
  assert.equal(second.payloads_sidecar, null);
  assert.equal(first.timeline.length, 1);
  const tool = first.timeline[0];
  assert.equal(tool.kind, 'tool_call');
  assert.equal(tool.id, 'late');
  assert.equal(tool.name, 'Bash');
  assert.equal(tool.command, 'echo inspected');
  assert.equal(tool.duration_s, 2);
  assert.equal(tool.result_ts, '2026-01-01T00:00:03Z');
  assert.deepEqual(tool.output_ref, { sha256: sha(Buffer.from(fullOutput)), length: 21001 });
  assert.deepEqual(first.payloads_sha256, [tool.output_ref.sha256]);
  const spill = JSON.parse(get(first.payloads_sidecar).toString('utf8'));
  assert.deepEqual(Object.keys(spill), [tool.output_ref.sha256]);
  assert.equal(
    spill[tool.output_ref.sha256],
    fullOutput,
    'Late spill must retain exactly 21001 x characters'
  );
  assert.equal(sha(Buffer.from(spill[tool.output_ref.sha256])), tool.output_ref.sha256);
  for (const [name, length, digest] of expectedArtifacts) {
    const artifact = artifacts.find((a) => a.name === name)!;
    assert.equal(artifact.bytes.length, length, name);
    assert.equal(sha(artifact.bytes), digest, name);
    assert.equal(artifact.sha256, digest, name);
    assert.equal(
      artifact.role,
      name.endsWith('.payloads.json') ? 'spill' : name.startsWith('turn-') ? 'turn' : 'index'
    );
  }
}
/** Re-inspect capture bytes independently of a rewritten receipt; never writes. */
export function verifyTranscriptFloorCapture(directory: string): void {
  const prepared = path.join(directory, 'prepared');
  assert.deepEqual([...fs.readdirSync(prepared)].sort(), expectedArtifacts.map((a) => a[0]).sort());
  verifyTranscriptFloorArtifacts(
    expectedArtifacts.map(([name]) => {
      const file = path.join(prepared, name);
      assert.ok(fs.lstatSync(file).isFile(), 'Capture artifact must be a regular file');
      assert.ok(fs.statSync(file).size <= 1_000_000, 'Capture artifact exceeds fixture bound');
      const bytes = fs.readFileSync(file);
      return {
        name,
        bytes,
        sha256: sha(bytes),
        role: name.endsWith('.payloads.json')
          ? 'spill'
          : name.startsWith('turn-')
            ? 'turn'
            : 'index',
      };
    })
  );
  assert.deepEqual(fs.readFileSync(path.join(directory, 'source.jsonl')), transcriptFloorSource());
}
function failed(result: SessionArtifactPreparation, phase: string): void {
  assert.equal(result.disposition, 'failed');
  if (result.disposition !== 'failed') throw new Error('Expected failed preparation');
  assert.equal(result.failure.phase, phase);
  assert.equal(result.publication, 'not_attempted');
  assert.equal('generation' in result, false);
}
export function qualifyTranscriptFloorComponent() {
  const source = transcriptFloorSource();
  assert.equal(source.length, 21668);
  assert.equal(sha(source), 'd2446ce7b6d05defdaafd7d9f277c540231cfde47ceef2001994a6d4e8b13d53');
  const input = transcriptFloorInput(source);
  const ready = prepareSessionArtifacts(input);
  assert.equal(ready.disposition, 'ready');
  if (ready.disposition !== 'ready') throw new Error('Expected complete prepared generation');
  assert.equal(ready.publication, 'not_attempted');
  // Generation identity binds the Claude numeric-policy revision as well as bytes.
  assert.equal(
    ready.generation.identity,
    'e6209c7fb0b543757ad984f6fedb018f07722afa774b546821a1dc93a54aaff3'
  );
  assert.equal(ready.checkpoint?.offset, BigInt(source.length));
  assert.deepEqual(ready.generation.proposedRemovals, []);
  const capture = (): CapturedFloorArtifact[] =>
    ready.generation.artifacts.map((a) => ({
      name: a.name,
      role: a.role,
      bytes: Buffer.from(a.bytes()),
      sha256: a.sha256,
    }));
  const artifacts = capture();
  verifyTranscriptFloorArtifacts(artifacts);
  const priorInventory = {
    observationId: 'captured-prepared-before-negative-controls',
    artifacts: artifacts.map((a) => ({
      name: a.name,
      sha256: a.sha256,
      byteLength: a.bytes.length,
    })),
  };
  const negative = (bytes: Uint8Array) =>
    prepareSessionArtifacts({ ...transcriptFloorInput(bytes), priorInventory });
  failed(negative(Buffer.from([0xff])), 'utf8');
  const empty = negative(Buffer.alloc(0));
  assert.equal(empty.disposition, 'retain');
  if (empty.disposition !== 'retain') throw new Error('Expected retained history');
  assert.equal(empty.reason, 'empty_source');
  assert.equal(empty.currentness, 'noncurrent');
  assert.equal(empty.publication, 'not_attempted');
  assert.equal('generation' in empty, false);
  const embedded =
    JSON.stringify({
      type: 'tool/call',
      data: {
        name: 'example',
        callId: 'embedded',
        arguments: `{"unused":${'1'.repeat(4301)},broken`,
      },
    }) + '\n';
  failed(negative(Buffer.concat([transcriptFloorSource(), Buffer.from(embedded)])), 'numeric');
  // Re-read generation closures after mutating caller input and one returned byte copy.
  source.fill(0xff);
  const returned = ready.generation.artifacts[0]!.bytes();
  returned.fill(0);
  verifyTranscriptFloorArtifacts(capture());
  verifyTranscriptFloorArtifacts(artifacts);
  return {
    source: transcriptFloorSource(),
    artifacts,
    summary: {
      status: 'bounded_emitted_module_component_passed',
      publication: ready.publication,
      preparedIdentity: ready.generation.identity,
      sourceBytes: 21668,
      sourceSha256: sha(transcriptFloorSource()),
      artifacts: artifacts.map((a) => ({
        name: a.name,
        role: a.role,
        byteLength: a.bytes.length,
        sha256: a.sha256,
      })),
      lateResult: {
        originatingTurn: 1,
        currentTurn: 2,
        spillFile: 'turn-001.payloads.json',
        length: 21001,
        digest: sha(Buffer.from(fullOutput)),
        duration_s: 2,
      },
      negativeControls: {
        invalidUtf8: { disposition: 'failed', phase: 'utf8', hasGeneration: false },
        emptySource: { disposition: 'retain', currentness: 'noncurrent', hasGeneration: false },
        embedded4301: { disposition: 'failed', phase: 'numeric', hasGeneration: false },
        publication: 'not_attempted',
        callerMutationPreservedBytes: true,
        returnedCopyMutationPreservedBytes: true,
      },
      numericProfile: RENDER_JSON_4300,
      calendar: { profileId: input.calendar.profileId, timezone: input.calendar.timezone },
      preparationLimits: input.limits,
      limits: QUALIFICATION_LIMITS,
    },
  };
}
function moduleImages() {
  const directory = path.resolve(__dirname, '../transcripts');
  const javascriptFiles = (root: string): string[] =>
    [...fs.readdirSync(root, { withFileTypes: true })].flatMap((entry) => {
      const file = path.join(root, entry.name);
      return entry.isDirectory()
        ? javascriptFiles(file)
        : entry.isFile() && entry.name.endsWith('.js')
          ? [file]
          : [];
    });
  return [
    __filename,
    path.join(__dirname, 'transcript-runtime-floor-entry.js'),
    ...javascriptFiles(directory).sort(),
  ].map((file) => {
    const bytes = fs.readFileSync(file);
    return { path: file, byteLength: bytes.length, sha256: sha(bytes) };
  });
}
export function parseTranscriptFloorArguments(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== '--output' || !args[1] || !path.isAbsolute(args[1]))
    throw new Error('Usage: transcript-runtime-floor-entry.js --output <absolute new directory>');
  return path.resolve(args[1]);
}
export function captureTranscriptFloor(output: string): string {
  if (!path.isAbsolute(output)) throw new Error('Output must be absolute');
  const parent = fs.realpathSync(path.dirname(output));
  const target = path.join(parent, path.basename(output));
  const packageRoot = fs.realpathSync(path.resolve(__dirname, '../..'));
  const relative = path.relative(packageRoot, target);
  if (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
    throw new Error('Output must be external to the package');
  if (fs.existsSync(target) || fs.lstatSync(parent).isDirectory() === false)
    throw new Error('Output directory must be new with an existing parent');
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const packageJsonBytes = fs.readFileSync(packageJsonPath);
  const packageJson = JSON.parse(packageJsonBytes.toString('utf8'));
  assert.equal(
    packageJson.engines?.node,
    '>=18.0.0',
    'Qualifier requires the package Node engine contract >=18.0.0'
  );
  const packageIdentity = {
    path: packageJsonPath,
    byteLength: packageJsonBytes.length,
    sha256: sha(packageJsonBytes),
    engines: { node: packageJson.engines.node as string },
  };
  const before = moduleImages();
  const result = qualifyTranscriptFloorComponent();
  const after = moduleImages();
  assert.deepEqual(after, before, 'Emitted module identities changed during qualification');
  const executable = fs.readFileSync(process.execPath);
  const receipt = {
    ...result.summary,
    runtime: {
      version: process.versions.node,
      execPath: process.execPath,
      executableSHA256: sha(executable),
      argv: [...process.argv],
    },
    modulesBefore: before,
    modulesAfter: after,
    packageIdentity,
  };
  // Every semantic, negative and image stability check precedes any output write.
  fs.mkdirSync(target, { mode: 0o700 });
  fs.mkdirSync(path.join(target, 'prepared'), { mode: 0o700 });
  const write = (name: string, bytes: Uint8Array): void => {
    fs.writeFileSync(path.join(target, name), bytes, { flag: 'wx', mode: 0o600 });
  };
  write('source.jsonl', result.source);
  for (const artifact of result.artifacts)
    write(path.join('prepared', artifact.name), artifact.bytes);
  verifyTranscriptFloorCapture(target);
  // A pending-write failure retains diagnostics without finalizing the receipt.
  // Rename outcome uncertainty and crash durability are outside this observation.
  const receiptPath = path.join(target, 'receipt.json');
  const pendingReceiptPath = path.join(target, 'receipt.pending.json');
  write('receipt.pending.json', Buffer.from(JSON.stringify(receipt, null, 2) + '\n'));
  fs.renameSync(pendingReceiptPath, receiptPath);
  return receiptPath;
}
