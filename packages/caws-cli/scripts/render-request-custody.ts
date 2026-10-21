/** Qualification observations for the existing native custody v1 schema.
 * Trusted fixture files only; these records never confer signal or replay authority.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { parseJsonSource } from '../src/runtime/json-custody';
import type { RequestCoverage } from './render-request-topology';

type Row = Record<string, unknown>;
export const MAX_CUSTODY_CONFIG = 65_536;
export const MAX_CUSTODY_JOURNAL = 1_048_576;
export const MAX_TYPED_JOURNAL = 8 * 1024 * 1024;
export function decodeInvocationIdentity(
  bytes: Uint8Array,
  runtimeDigest: string,
  inputDigest: string,
  expectedEvent: 'stop' | 'pre_tool_use' = 'stop'
) {
  requireValue(
    expectedEvent === 'stop' || expectedEvent === 'pre_tool_use',
    'unsupported expected hook event'
  );
  requireValue(
    bytes.byteLength > 0 && bytes.byteLength <= MAX_TYPED_JOURNAL && bytes.at(-1) === 10,
    'typed invocation journal empty/partial/oversized'
  );
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const rows = text
    .slice(0, -1)
    .split('\n')
    .map((line) => json(Buffer.from(line), MAX_TYPED_JOURNAL));
  requireValue(
    object(rows[0]) &&
      rows[0].stage === 'invocation_started' &&
      typeof rows[0].invocation_id === 'string' &&
      rows[0].invocation_id.length > 0 &&
      rows[0].invocation_id.length <= 128,
    'typed invocation identity unavailable'
  );
  const invocationId = rows[0].invocation_id;
  requireValue(
    rows.every(
      (row) =>
        object(row) &&
        row.schema === 'caws.hook_invocation.v1' &&
        row.invocation_id === invocationId &&
        row.runtime_digest === runtimeDigest &&
        row.input_sha256 === inputDigest &&
        row.surface === 'codex' &&
        row.event === expectedEvent
    ),
    'typed invocation journal identity differs'
  );
  return { invocationId, runtimeDigest };
}
export type CustodyCandidate = {
  source: string;
  configuration: Uint8Array;
  journal: Uint8Array;
  previousJournal: Uint8Array | null;
};
export type CustodyExpectation = {
  coverage: RequestCoverage;
  invocationId: string;
  runtimeDigest: string;
  node: string;
  engine: string;
};
/** Qualification-only witness from the original request's private native files.
 * The configuration witness is not inferred from a filename or ID prefix.
 * It grants no invocation, signal, replay, session or event authority.
 */
export type MissingSidPreToolUseExpectation = Omit<CustodyExpectation, 'invocationId'> & {
  request: {
    executable: string;
    args: readonly string[];
    rawInput: Uint8Array;
    inputSha256: string;
    temporary: string;
    configuration: { source: string; sha256: string; invocationId: string };
  };
};
export type MissingSidPreToolUseObservation = CustodyObservation & {
  provenance: 'native-only-missing-sid-pre-tool-use';
  inputSha256: string;
};
export type MissingSidPreToolUseFirstExpectation = Omit<
  MissingSidPreToolUseExpectation,
  'request'
> & {
  request: Omit<MissingSidPreToolUseExpectation['request'], 'configuration'>;
};
export type NativeConfigurationWitness =
  MissingSidPreToolUseExpectation['request']['configuration'];
export type CustodyObservation = {
  state: 'confirmed_settled' | 'unknown';
  error: string | null;
  source: string | null;
  invocationId: string;
  runtimeDigest: string;
  terminal: Row | null;
};
const object = (value: unknown): value is Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function fields(value: unknown, keys: string): Row {
  requireValue(object(value), 'custody object required');
  requireValue(
    Object.keys(value).sort().join(',') === keys.split(',').sort().join(','),
    'custody fields differ'
  );
  return value;
}
const uint = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const pid = (v: unknown): v is number => uint(v) && v > 1 && v <= 0xffff_ffff;
const int = (v: unknown): v is number =>
  Number.isInteger(v) && Number(v) >= -2147483648 && Number(v) <= 2147483647;
const nullableInt = (v: unknown): boolean => v === null || int(v);
const nullableText = (v: unknown): boolean => v === null || typeof v === 'string';
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function json(bytes: Uint8Array, maximum: number): unknown {
  requireValue(bytes.byteLength > 0 && bytes.byteLength <= maximum, 'custody byte bound');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  parseJsonSource(text, 32, 10_000, true);
  return JSON.parse(text) as unknown;
}
function group(value: unknown): Row {
  const row = fields(value, 'reason,query_errno,bytes,capacity,members,zombies,leaders');
  requireValue(int(row.reason) && int(row.query_errno), 'invalid SDK status');
  requireValue(
    ['bytes', 'capacity'].every((k) => uint(row[k])) &&
      ['members', 'zombies', 'leaders'].every((k) => uint(row[k]) && row[k] <= 0xffff_ffff),
    'invalid SDK counters'
  );
  return row;
}
function completeGroup(value: unknown): boolean {
  const row = group(value);
  return (
    row.reason === 0 &&
    row.query_errno === 0 &&
    Number(row.members) > 0 &&
    row.members === row.zombies &&
    row.leaders === 1 &&
    Number(row.bytes) > 0 &&
    Number(row.bytes) < Number(row.capacity)
  );
}
function leader(value: unknown): void {
  if (value === null) return;
  const row = fields(value, 'pid,code');
  requireValue(int(row.pid) && int(row.code), 'invalid settlement leader');
}
function result(value: unknown, kind: 'stop' | 'settlement'): void {
  if (value === null) return;
  requireValue(object(value) && Object.keys(value).length === 1, 'invalid custody result');
  if (Object.hasOwn(value, 'Err')) {
    const row = fields(
      value.Err,
      kind === 'stop'
        ? 'stage,raw_errno,signal_errno,observed_pid,observed_code,group'
        : 'stage,raw_errno,observed_pid,observed_code,before,after,group'
    );
    const stages =
      kind === 'stop'
        ? ['InvalidPid', 'Ownership', 'Signal', 'ExitedGroup']
        : ['InvalidPid', 'BeforeOwnership', 'UnsupportedPlatform', 'AfterOwnership', 'Snapshot'];
    requireValue(
      stages.includes(String(row.stage)) &&
        ['raw_errno', 'observed_pid', 'observed_code'].every((k) => nullableInt(row[k])),
      'invalid custody error'
    );
    if (kind === 'stop') requireValue(nullableInt(row.signal_errno), 'invalid signal error');
    else {
      leader(row.before);
      leader(row.after);
    }
    if (row.group !== null) group(row.group);
    return;
  }
  requireValue(Object.hasOwn(value, 'Ok'), 'missing custody result variant');
  const ok = value.Ok;
  if (kind === 'stop' && (ok === 'Signalled' || ok === 'Absent')) return;
  if (kind === 'settlement' && ok === 'LeaderRunning') return;
  requireValue(object(ok) && Object.keys(ok).length === 1, 'invalid custody success');
  const key = Object.keys(ok)[0]!;
  requireValue(
    (kind === 'stop' ? ['ExitedOnly'] : ['GroupLive', 'Exited']).includes(key),
    'unknown custody success'
  );
  group(fields(ok[key], 'observation').observation);
}
const RECEIPT_FIELDS =
  'schema,invocation_id,runtime_digest,sequence,custodian_pid,node_pid,state,reason,stop,settlement,child_exit_raw,stdout_eof,stderr_eof,stdout_bytes,stderr_bytes,output_discarded,frontend_output_errno,error';
function receipt(value: unknown): Row {
  const row = fields(value, RECEIPT_FIELDS);
  requireValue(
    row.schema === 'caws.engine.custody.receipt.v1' &&
      typeof row.invocation_id === 'string' &&
      typeof row.runtime_digest === 'string' &&
      uint(row.sequence) &&
      row.sequence > 0 &&
      pid(row.custodian_pid) &&
      (row.node_pid === null || pid(row.node_pid)) &&
      ['started', 'pending', 'complete', 'no_child'].includes(String(row.state)) &&
      nullableText(row.reason) &&
      nullableText(row.error) &&
      nullableInt(row.child_exit_raw) &&
      nullableInt(row.frontend_output_errno) &&
      uint(row.stdout_bytes) &&
      uint(row.stderr_bytes) &&
      ['stdout_eof', 'stderr_eof', 'output_discarded'].every((k) => typeof row[k] === 'boolean'),
    'invalid custody receipt'
  );
  result(row.stop, 'stop');
  result(row.settlement, 'settlement');
  return row;
}
function terminal(row: Row): boolean {
  if (row.state === 'no_child')
    return (
      row.node_pid === null &&
      row.child_exit_raw === null &&
      row.stop === null &&
      row.settlement === null &&
      row.stdout_eof === true &&
      row.stderr_eof === true &&
      row.stdout_bytes === 0 &&
      row.stderr_bytes === 0
    );
  if (row.state !== 'complete') return false;
  const settled =
    object(row.settlement) && object(row.settlement.Ok) && object(row.settlement.Ok.Exited)
      ? row.settlement.Ok.Exited.observation
      : null;
  return (
    pid(row.node_pid) &&
    row.child_exit_raw !== null &&
    object(row.stop) &&
    Object.hasOwn(row.stop, 'Ok') &&
    settled !== null &&
    completeGroup(settled) &&
    row.stdout_eof === true &&
    row.stderr_eof === true &&
    row.error === null
  );
}
/** Decode and correlate content, never filenames, mtimes or ID prefixes. */
export function correlateRequestCustody(
  candidates: readonly CustodyCandidate[],
  expected: CustodyExpectation
): CustodyObservation {
  let source: string | null = null;
  try {
    const { coverage } = expected;
    requireValue(
      coverage.expected?.platform === 'darwin' &&
        object(coverage.originalFrontend) &&
        coverage.originalFrontend.state === 'observed' &&
        object(coverage.originalFrontend.process),
      'original frontend identity unavailable'
    );
    const original = coverage.originalFrontend.process;
    requireValue(
      coverage.expected.frontendPid === original.pid &&
        original.zombie === false &&
        typeof original.startSeconds === 'string' &&
        /^\d+$/.test(original.startSeconds) &&
        typeof original.startMicros === 'string' &&
        /^\d+$/.test(original.startMicros) &&
        coverage.confirmedChains.length > 0,
      'current frontend chain unavailable'
    );
    const chain = coverage.confirmedChains[0]!;
    requireValue(
      chain.length === 3 &&
        coverage.confirmedChains.every(
          (c) =>
            c.length === 3 &&
            c.every(
              (p, index) =>
                p.pid === chain[index]!.pid &&
                p.startSeconds === chain[index]!.startSeconds &&
                p.startMicros === chain[index]!.startMicros &&
                p.parent === chain[index]!.parent &&
                p.group === chain[index]!.group
            )
        ),
      'current request chain differs'
    );
    requireValue(
      chain[0]!.pid === original.pid &&
        chain[0]!.startSeconds === original.startSeconds &&
        chain[0]!.startMicros === original.startMicros &&
        chain[1]!.parent === chain[0]!.pid &&
        chain[2]!.parent === chain[1]!.pid &&
        chain[1]!.group === chain[1]!.pid &&
        chain[2]!.group === chain[2]!.pid,
      'current request birth/topology differs'
    );
    requireValue(candidates.length <= 64, 'custody candidate bound');
    const matching = candidates.filter((candidate) => {
      const config = fields(
        json(candidate.configuration, MAX_CUSTODY_CONFIG),
        'schema,invocation_id,runtime_digest,node,engine,control_fd,receipt_fd,render_fds'
      );
      requireValue(
        config.schema === 'caws.engine.custody.configuration.v1',
        'unknown custody configuration'
      );
      requireValue(
        [config.control_fd, config.receipt_fd].every(
          (fd) => uint(fd) && fd >= 32 && fd <= 1_048_576
        ) &&
          (config.render_fds === null ||
            (Array.isArray(config.render_fds) &&
              config.render_fds.length === 3 &&
              config.render_fds.every((fd) => uint(fd) && fd >= 32 && fd <= 1_048_576))),
        'invalid custody descriptors'
      );
      return (
        config.invocation_id === expected.invocationId &&
        config.runtime_digest === expected.runtimeDigest &&
        config.node === expected.node &&
        config.engine === expected.engine
      );
    });
    requireValue(matching.length === 1, 'custody configuration absent/ambiguous');
    const candidate = matching[0]!;
    source = candidate.source;
    const bytes = Buffer.from(candidate.journal);
    requireValue(
      bytes.length > 0 && bytes.length <= MAX_CUSTODY_JOURNAL && bytes.at(-1) === 10,
      'custody journal empty/partial/oversized'
    );
    requireValue(
      candidate.previousJournal === null ||
        bytes
          .subarray(0, candidate.previousJournal.length)
          .equals(Buffer.from(candidate.previousJournal)),
      'custody journal truncated/rewritten'
    );
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const rows = text
      .slice(0, -1)
      .split('\n')
      .map((line) => receipt(json(Buffer.from(line), MAX_CUSTODY_JOURNAL)));
    requireValue(
      rows[0]?.state === 'started' && rows[0].sequence === 1,
      'created-node custody journal start unavailable'
    );
    let previous: Row | null = null;
    for (const row of rows) {
      requireValue(
        row.invocation_id === expected.invocationId &&
          row.runtime_digest === expected.runtimeDigest &&
          row.custodian_pid === chain[1]!.pid &&
          row.node_pid === chain[2]!.pid,
        'custody journal identity differs'
      );
      requireValue(
        !['complete', 'no_child'].includes(String(row.state)) || terminal(row),
        'invalid terminal custody receipt'
      );
      if (previous)
        requireValue(
          !terminal(previous) &&
            Number(row.sequence) > Number(previous.sequence) &&
            row.node_pid === previous.node_pid &&
            Number(row.stdout_bytes) >= Number(previous.stdout_bytes) &&
            Number(row.stderr_bytes) >= Number(previous.stderr_bytes) &&
            ['stdout_eof', 'stderr_eof', 'output_discarded'].every(
              (k) => previous![k] !== true || row[k] === true
            ) &&
            (previous.child_exit_raw === null || previous.child_exit_raw === row.child_exit_raw),
          'custody journal state regressed'
        );
      previous = row;
    }
    requireValue(
      previous?.state === 'complete' && terminal(previous),
      'custody terminal settlement unavailable'
    );
    return {
      state: 'confirmed_settled',
      error: null,
      source,
      invocationId: expected.invocationId,
      runtimeDigest: expected.runtimeDigest,
      terminal: previous,
    };
  } catch (error) {
    return {
      state: 'unknown',
      error: String(error),
      source,
      invocationId: expected.invocationId,
      runtimeDigest: expected.runtimeDigest,
      terminal: null,
    };
  }
}
export function combinedRequestCleanup(
  absence: { state: string },
  custody: { state: string }
): 'confirmed_inactive' | 'unknown' {
  return absence.state === 'confirmed_inactive' && custody.state === 'confirmed_settled'
    ? 'confirmed_inactive'
    : 'unknown';
}

/** This entrypoint is deliberately separate from the typed-journal/Stop path.
 * Native v1 configuration has no event/input fields: captured original argv and
 * input bytes supply that correlation, within the trusted private fixture boundary.
 */
export function correlateMissingSidPreToolUseCustody(
  candidates: readonly CustodyCandidate[],
  expected: MissingSidPreToolUseExpectation
): MissingSidPreToolUseObservation {
  const { request } = expected;
  const provenance = 'native-only-missing-sid-pre-tool-use' as const;
  try {
    const selected = expected.coverage.expected;
    requireValue(
      selected !== null && request.executable === selected.native,
      'original native executable differs'
    );
    requireValue(
      request.rawInput.byteLength > 0 &&
        request.rawInput.byteLength <= MAX_TYPED_JOURNAL &&
        /^[a-f0-9]{64}$/.test(request.inputSha256) &&
        hash(request.rawInput) === request.inputSha256,
      'original request input identity differs'
    );
    const payload = json(request.rawInput, MAX_TYPED_JOURNAL);
    requireValue(
      object(payload) &&
        !Object.hasOwn(payload, 'session_id') &&
        !Object.hasOwn(payload, 'sessionId'),
      'missing-SID branch requires absent payload session identity'
    );
    const args = request.args;
    requireValue(
      args.length === 15 &&
        args[0] === 'invoke' &&
        args[1] === '--engine' &&
        args[2] === expected.engine &&
        args[3] === '--node' &&
        args[4] === expected.node &&
        args[5] === '--surface' &&
        args[6] === 'codex' &&
        args[7] === '--event' &&
        args[8] === 'pre_tool_use' &&
        args[9] === '--runtime-digest' &&
        args[10] === expected.runtimeDigest &&
        args[11] === '--timeout-ms' &&
        /^[1-9]\d*$/.test(args[12]!) &&
        Number.isSafeInteger(Number(args[12])) &&
        Number(args[12]) <= 120000 &&
        args[13] === '--configuration' &&
        ['system', 'project'].includes(args[14]!),
      'original missing-SID PreToolUse argv differs'
    );
    requireValue(
      selected.frontendCommand === [request.executable, ...args].join(' ') &&
        selected.node === expected.node &&
        selected.engine === expected.engine,
      'original request command/topology differs'
    );
    requireValue(
      path.isAbsolute(request.temporary) &&
        path.isAbsolute(request.configuration.source) &&
        path.dirname(request.configuration.source) === request.temporary &&
        /^[a-f0-9]{64}$/.test(request.configuration.sha256) &&
        /^[A-Za-z0-9_.-]{1,128}$/.test(request.configuration.invocationId),
      'original private native configuration witness unavailable'
    );
    requireValue(candidates.length === 1, 'original private native configuration absent/ambiguous');
    const candidate = candidates[0]!;
    requireValue(
      candidate.source === request.configuration.source &&
        hash(candidate.configuration) === request.configuration.sha256,
      'original private native configuration source changed'
    );
    const result = correlateRequestCustody(candidates, {
      coverage: expected.coverage,
      invocationId: request.configuration.invocationId,
      runtimeDigest: expected.runtimeDigest,
      node: expected.node,
      engine: expected.engine,
    });
    return { ...result, provenance, inputSha256: request.inputSha256 };
  } catch (error) {
    return {
      state: 'unknown',
      error: String(error),
      source: null,
      invocationId: request.configuration.invocationId,
      runtimeDigest: expected.runtimeDigest,
      terminal: null,
      provenance,
      inputSha256: request.inputSha256,
    };
  }
}

/** Reads are bounded, private, non-symlink regular files; snapshots retain source identity.
 * A dedicated caller-provisioned temporary directory limits the search domain.
 */
export class RequestCustodyCollector {
  private readonly previous = new Map<
    string,
    { configuration: string; journal: Buffer; device: number; inode: number }
  >();
  private samples = 0;
  private retainedBytes = 0;
  constructor(
    readonly temporary: string,
    readonly archive: string
  ) {}
  collect(expected: CustodyExpectation): CustodyObservation & { snapshots: Row[] } {
    return this.collectWith(
      (candidates) => correlateRequestCustody(candidates, expected),
      expected.invocationId,
      expected.runtimeDigest
    );
  }
  collectMissingSidPreToolUse(
    expected: MissingSidPreToolUseExpectation
  ): MissingSidPreToolUseObservation & { snapshots: Row[] } {
    const result = this.collectWith(
      (candidates) => {
        requireValue(
          this.temporary === expected.request.temporary,
          'collector does not own original missing-SID temporary root'
        );
        return correlateMissingSidPreToolUseCustody(candidates, expected);
      },
      expected.request.configuration.invocationId,
      expected.runtimeDigest
    );
    return {
      ...result,
      provenance: 'native-only-missing-sid-pre-tool-use',
      inputSha256: expected.request.inputSha256,
    };
  }
  /** First observation uses the identical private bounded read/monotonicity
   * boundary. No expected typed ID or unvalidated filesystem read is needed.
   * Issue a reusable witness only after full correlation and native settlement;
   * partial/pending native journals remain unknown and return no witness.
   */
  observeMissingSidPreToolUse(
    expected: MissingSidPreToolUseFirstExpectation
  ): MissingSidPreToolUseObservation & {
    snapshots: Row[];
    configurationWitness: NativeConfigurationWitness | null;
  } {
    let configurationWitness: NativeConfigurationWitness | null = null;
    const result = this.collectWith(
      (candidates) => {
        requireValue(
          this.temporary === expected.request.temporary,
          'collector does not own original missing-SID temporary root'
        );
        requireValue(
          candidates.length === 1,
          'original private native configuration absent/ambiguous'
        );
        const candidate = candidates[0]!;
        const configuration = json(candidate.configuration, MAX_CUSTODY_CONFIG);
        requireValue(
          object(configuration) && typeof configuration.invocation_id === 'string',
          'original native invocation ID unavailable'
        );
        const witness = {
          source: candidate.source,
          sha256: hash(candidate.configuration),
          invocationId: configuration.invocation_id,
        };
        const correlated = correlateMissingSidPreToolUseCustody(candidates, {
          ...expected,
          request: { ...expected.request, configuration: witness },
        });
        if (correlated.state === 'confirmed_settled') configurationWitness = witness;
        return correlated;
      },
      '',
      expected.runtimeDigest
    );
    return {
      ...result,
      provenance: 'native-only-missing-sid-pre-tool-use',
      inputSha256: expected.request.inputSha256,
      configurationWitness,
    };
  }
  private collectWith(
    correlate: (candidates: readonly CustodyCandidate[]) => CustodyObservation,
    invocationId: string,
    runtimeDigest: string
  ): CustodyObservation & { snapshots: Row[] } {
    const snapshots: Row[] = [];
    try {
      requireValue(this.samples < 128, 'custody snapshot count exhausted');
      const target = path.join(this.archive, String(++this.samples).padStart(3, '0'));
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      const root = fs.lstatSync(this.temporary);
      requireValue(
        root.isDirectory() && root.uid === process.getuid?.() && (root.mode & 0o7777) === 0o700,
        'custody temporary directory unavailable/private mode differs'
      );
      const entries = fs.readdirSync(this.temporary);
      requireValue(entries.length <= 64, 'custody directory count bound');
      const candidates: CustodyCandidate[] = [];
      for (const entry of entries) {
        const directory = path.join(this.temporary, entry);
        if (!fs.lstatSync(directory).isDirectory()) continue;
        const configurationPath = path.join(directory, 'configuration.json');
        try {
          fs.lstatSync(configurationPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        const meta = fs.lstatSync(directory);
        requireValue(
          meta.uid === process.getuid?.() && (meta.mode & 0o7777) === 0o700,
          'unsafe custody directory'
        );
        const prefix = String(candidates.length).padStart(2, '0');
        const config = this.read(
          configurationPath,
          0o400,
          MAX_CUSTODY_CONFIG,
          path.join(target, prefix + '-configuration.json')
        );
        const snapshot: Row = { source: directory, configuration: config.record };
        snapshots.push(snapshot);
        const journal = this.read(
          path.join(directory, 'cleanup.jsonl'),
          0o600,
          MAX_CUSTODY_JOURNAL,
          path.join(target, prefix + '-cleanup.jsonl')
        );
        snapshot.journal = journal.record;
        const old = this.previous.get(directory);
        requireValue(
          !old ||
            (old.configuration === hash(config.bytes) &&
              old.device === journal.meta.dev &&
              old.inode === journal.meta.ino),
          'custody source identity changed'
        );
        requireValue(
          !old || journal.bytes.subarray(0, old.journal.length).equals(old.journal),
          'custody journal truncated/rewritten'
        );
        candidates.push({
          source: directory,
          configuration: config.bytes,
          journal: journal.bytes,
          previousJournal: old?.journal ?? null,
        });
        // Retain incomplete bytes too: a later read must extend exactly this prefix.
        this.previous.set(directory, {
          configuration: hash(config.bytes),
          journal: journal.bytes,
          device: journal.meta.dev,
          inode: journal.meta.ino,
        });
      }
      return { ...correlate(candidates), snapshots };
    } catch (error) {
      return {
        state: 'unknown',
        error: String(error),
        source: null,
        invocationId,
        runtimeDigest,
        terminal: null,
        snapshots,
      };
    }
  }
  private read(source: string, mode: number, maximum: number, destination: string) {
    const fd = fs.openSync(
      source,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
    try {
      const meta = fs.fstatSync(fd);
      requireValue(
        meta.isFile() &&
          meta.uid === process.getuid?.() &&
          meta.nlink === 1 &&
          (meta.mode & 0o7777) === mode &&
          meta.size <= maximum,
        'unsafe/oversized custody file'
      );
      const buffer = Buffer.alloc(maximum + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      requireValue(
        length <= maximum && this.retainedBytes + length <= 8 * 1024 * 1024,
        'custody retained byte bound'
      );
      const bytes = buffer.subarray(0, length);
      fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
      this.retainedBytes += length;
      return {
        bytes,
        meta,
        record: {
          source,
          snapshot: destination,
          device: meta.dev,
          inode: meta.ino,
          mode: meta.mode & 0o7777,
          bytes: length,
          sha256: hash(bytes),
        },
      };
    } finally {
      fs.closeSync(fd);
    }
  }
}
