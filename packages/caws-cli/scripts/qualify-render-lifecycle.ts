/** Actual selected renderer interruption/restart qualification; private fixtures only. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { committedTurnNames, readCommittedTurnFile } from './committed-turn-files';
import { decodeRenderRequest } from '../src/runtime/service-protocol';
import {
  createRenderHarness,
  digest,
  files,
  pause,
  readJson,
  row,
  writeJson,
  type Data,
  type ProjectFixture,
  type RenderHarness,
  type Receipt,
  type Started,
} from './render-qualification-harness';

const oracleSelfTest = process.argv[2] === '--oracle-self-test';
assert(
  oracleSelfTest || (process.argv[2] && process.argv[3]),
  'CLI and Sterling source roots required'
);
const cli = oracleSelfTest ? '' : fs.realpathSync(process.argv[2]!);
const sterling = oracleSelfTest ? '' : fs.realpathSync(process.argv[3]!);
const requestedScenario = process.argv[4] ?? 'all';
const selectedScenario = requestedScenario === 'restart' ? 'host-crash-restart' : requestedScenario;
const nativeProfile = process.argv[5] ?? 'release';
assert(['debug', 'release'].includes(nativeProfile), 'native profile must be debug or release');
assert(
  ['all', 'normal', 'queued-cancel', 'cancel', 'host-crash-restart', 'frontend-loss'].includes(
    selectedScenario
  ),
  'scenario must be all, normal, queued-cancel, cancel, restart, or explicit frontend-loss'
);
const results: Data[] = [];
const summaryPath = path.resolve(
  cli,
  '../caws-native/target/qualification/render-lifecycle-latest.json'
);

type DenialReason = 'unknown_fence' | 'backend_capacity_exhausted';
const ownerDenialDiagnostic =
  'CAWS native infrastructure failure (configuration): renderer owner peer EOF. Checks did not complete; request was not retried.';
const legacyDenialDiagnostic =
  'CAWS render writer unavailable: renderer writer domain retains an unresolved execution; no replay or fallback';

/** Positive causal witness required before unchanged-output assertions have meaning. */
function assertOwnerDenial(
  receipt: Receipt,
  invocation: Data,
  events: Data[],
  reason: DenialReason,
  stdout: string,
  stderr: string
): Data {
  assert.equal(receipt.error, null, 'probe failed to start');
  assert.equal(receipt.signal, null, 'probe was signaled');
  // A Stop refused before dispatch follows the native configuration fallback:
  // advisory exit zero, no stdout, and the owner's closed prepared connection.
  assert.equal(receipt.code, 0, 'unexpected pre-dispatch Stop failure contract');
  assert.equal(stdout, '', 'denied probe produced native stdout');
  assert.equal(stderr.trim(), ownerDenialDiagnostic, 'probe failed outside owner admission');
  assert.equal(invocation.schema, 'caws.hook_invocation.v1');
  assert.equal(invocation.stage, 'invocation_started');
  const id = invocation.invocation_id;
  assert(typeof id === 'string' && receipt.pid && id.startsWith(receipt.pid + '-'));
  const denied = events.filter(
    (event) => event.event === 'admission_denied' && event.invocationId === id
  );
  assert.equal(denied.length, 1, 'probe lacks exactly one correlated owner denial');
  const event = denied[0]!;
  assert.equal(event.reason, reason, 'owner denied for a different cause');
  assert(Number.isSafeInteger(event.backendUsed) && Number(event.backendUsed) > 0);
  assert(Number.isSafeInteger(event.backendMaximum) && Number(event.backendMaximum) > 0);
  if (reason === 'backend_capacity_exhausted') {
    assert.equal(event.backendUsed, event.backendMaximum, 'capacity denial lacks occupied budget');
  }
  return event;
}

function probeIdentity(
  fixture: Pick<ProjectFixture, 'project' | 'session'>,
  receipt: Receipt,
  timeoutMs: string
): { command: Data; invocation: Data; journalPath: string; journal: Data[] } {
  assert(Number.isSafeInteger(receipt.pid) && Number(receipt.pid) > 0);
  const command = readJson(path.join(receipt.directory, 'command.json'));
  const settled = readJson(path.join(receipt.directory, 'receipt.json'));
  assert.equal(command.cwd, fixture.project);
  const args = command.args as unknown[];
  assert(Array.isArray(args));
  assert.equal(args[args.indexOf('--event') + 1], 'stop');
  assert.equal(args[args.indexOf('--timeout-ms') + 1], timeoutMs);
  const candidates = files(path.join(fixture.session, 'hook-invocations')).filter(
    (name) => name.startsWith(String(receipt.pid) + '-') && name.endsWith('.jsonl')
  );
  assert.equal(candidates.length, 1, 'retained caller lacks one invocation journal');
  const journalPath = path.join(fixture.session, 'hook-invocations', candidates[0]!);
  const journal = fs
    .readFileSync(journalPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => row(JSON.parse(line)));
  const starts = journal.filter((record) => record.stage === 'invocation_started');
  assert.equal(starts.length, 1);
  const invocation = starts[0]!;
  assert.equal(invocation.schema, 'caws.hook_invocation.v1');
  assert(String(invocation.invocation_id).startsWith(receipt.pid + '-'));
  assert.equal(path.basename(journalPath), String(invocation.invocation_id) + '.jsonl');
  assert.equal(invocation.dispatch_cwd, fixture.project);
  assert.equal(
    invocation.input_sha256,
    digest(fs.readFileSync(path.join(receipt.directory, 'stdin.bin')))
  );
  assert.equal(invocation.event, 'stop');
  assert.equal(invocation.surface, 'codex');
  assert.equal(invocation.runtime_digest, args[args.indexOf('--runtime-digest') + 1]);
  assert(Number(invocation.timestamp_ms) >= Number(settled.startedAt));
  assert(Number(invocation.timestamp_ms) <= Number(settled.endedAt));
  return { command, invocation, journalPath, journal };
}

function ownerDenied(
  h: RenderHarness,
  fixture: ProjectFixture,
  receipt: Receipt,
  reason: DenialReason,
  label: string
): Data {
  const { command, invocation, journalPath, journal } = probeIdentity(fixture, receipt, '5000');
  const stdout = fs.readFileSync(path.join(receipt.directory, 'stdout.bin'), 'utf8');
  const stderr = fs.readFileSync(path.join(receipt.directory, 'stderr.bin'), 'utf8');
  const denial = assertOwnerDenial(receipt, invocation, h.ownerEvents(), reason, stdout, stderr);
  const evidence = { receipt, command, invocation, journalPath, journal, denial, stdout, stderr };
  h.writeJson(label + '-admission-denial.json', evidence);
  return evidence;
}

function assertLegacyDenial(receipt: Receipt, stdout: string, stderr: string): void {
  assert.equal(receipt.error, null, 'legacy writer failed to start');
  assert.equal(receipt.signal, null);
  assert.equal(receipt.code, 75, 'unexpected legacy writer refusal contract');
  assert.equal(stdout, '');
  assert.equal(
    stderr.trim(),
    legacyDenialDiagnostic,
    'legacy failed outside unresolved-execution fence'
  );
}

function testDenialOracles(): void {
  const receipt: Receipt = { code: 0, signal: null, error: null, directory: '/pure', pid: 123 };
  const invocation = {
    schema: 'caws.hook_invocation.v1',
    stage: 'invocation_started',
    invocation_id: '123-456',
  };
  const event = {
    event: 'admission_denied',
    invocationId: '123-456',
    reason: 'unknown_fence',
    backendUsed: 1,
    backendMaximum: 1,
  };
  assertOwnerDenial(receipt, invocation, [event], 'unknown_fence', '', ownerDenialDiagnostic);
  assertOwnerDenial(
    receipt,
    invocation,
    [{ ...event, reason: 'backend_capacity_exhausted' }],
    'backend_capacity_exhausted',
    '',
    ownerDenialDiagnostic
  );
  const rejected = [
    () => assertOwnerDenial(receipt, {}, [event], 'unknown_fence', '', ownerDenialDiagnostic),
    () => assertOwnerDenial(receipt, invocation, [], 'unknown_fence', '', ownerDenialDiagnostic),
    () =>
      assertOwnerDenial(
        receipt,
        invocation,
        [{ ...event, invocationId: 'other-456' }],
        'unknown_fence',
        '',
        ownerDenialDiagnostic
      ),
    () =>
      assertOwnerDenial(
        receipt,
        invocation,
        [{ ...event, reason: 'queue_full' }],
        'unknown_fence',
        '',
        ownerDenialDiagnostic
      ),
    () =>
      assertOwnerDenial(
        { ...receipt, code: null, error: 'ENOENT' },
        invocation,
        [event],
        'unknown_fence',
        '',
        ownerDenialDiagnostic
      ),
    () =>
      assertOwnerDenial(
        receipt,
        invocation,
        [event],
        'unknown_fence',
        '',
        'CAWS native infrastructure failure (configuration): execution deadline'
      ),
    () =>
      assertOwnerDenial(
        receipt,
        invocation,
        [{ ...event, backendUsed: 0 }],
        'unknown_fence',
        '',
        ownerDenialDiagnostic
      ),
    () =>
      assertOwnerDenial(
        receipt,
        invocation,
        [{ ...event, reason: 'backend_capacity_exhausted', backendMaximum: 2 }],
        'backend_capacity_exhausted',
        '',
        ownerDenialDiagnostic
      ),
    () =>
      assertLegacyDenial(
        { ...receipt, code: 75 },
        '',
        'CAWS render writer unavailable: invalid home'
      ),
    () => assertLegacyDenial({ ...receipt, code: 2 }, '', legacyDenialDiagnostic),
  ];
  rejected.forEach((control) => assert.throws(control));
  assertLegacyDenial({ ...receipt, code: 75 }, '', legacyDenialDiagnostic);
  let retainedIdentity: Data | null = null;
  if (process.argv[3]) {
    const directory = fs.realpathSync(process.argv[3]);
    const actualReceipt = readJson(path.join(directory, 'receipt.json')) as Receipt;
    const command = readJson(path.join(directory, 'command.json'));
    const input = row(JSON.parse(fs.readFileSync(path.join(directory, 'stdin.bin'), 'utf8')));
    const project = String(command.cwd);
    assert.equal(input.cwd, project);
    assert(typeof input.session_id === 'string');
    const parsed = probeIdentity(
      { project, session: path.join(project, '.caws/sessions', input.session_id) },
      actualReceipt,
      '30000'
    );
    retainedIdentity = { directory, ...parsed };
  }
  process.stdout.write(
    JSON.stringify({
      state: 'passed',
      validControls: 3,
      rejectedHostileControls: rejected.length,
      runtimeExecuted: false,
      retainedIdentity,
    }) + '\n'
  );
}

function outcome(operation: Data): string {
  return String(row(row(operation.body).outcome).execution);
}
function assertRenderedTurn(
  value: Data,
  fixture: Pick<ProjectFixture, 'project' | 'name' | 'sessionId' | 'label' | 'turns'>
): void {
  const turn = Number(value.turn);
  assert(Number.isSafeInteger(value.turn) && turn > 0 && turn <= fixture.turns);
  assert.equal(value.schema_version, 2);
  assert.equal(value.status, 'ok');
  assert.equal(value.ended_by, null);
  assert.equal(value.user, `${fixture.label} user ${turn}`);
  const context = row(value.context);
  assert.equal(context.session_id, fixture.sessionId);
  assert.equal(context.project, fixture.name);
  assert.equal(context.cwd, fixture.project);
  assert.equal(context.model, 'owner-fixture-model');
  assert.equal(row(value.env).cwd, fixture.project);
  assert.equal(row(value.env).model, 'owner-fixture-model');
  const timestamp = new Date(Date.UTC(2026, 9, 1, 12, 0, turn)).toISOString();
  for (const key of ['ts_start', 'ts_end', 'user_ts']) assert.equal(value[key], timestamp);
  assert(Array.isArray(value.timeline) && value.timeline.length === 2);
  const tool = row(value.timeline[0]);
  assert.equal(tool.kind, 'tool_call');
  assert.equal(tool.name, 'exec_command');
  assert.equal(tool.source_harness, 'codex');
  assert.equal(tool.id, `${fixture.label}-call-${turn}`);
  assert.equal(tool.ts, timestamp);
  assert.equal(tool.result_ts, timestamp);
  assert.deepEqual(tool.input, { cmd: 'touch MUST-NOT-EXECUTE' });
  const output = `${fixture.label} result ${turn}`;
  assert.equal(tool.output, output);
  assert.equal(tool.output_length, output.length);
  for (const key of ['output_truncated', 'output_cut', 'is_error']) assert.equal(tool[key], false);
  const assistant = row(value.timeline[1]);
  assert.equal(assistant.kind, 'reasoning');
  assert.equal(assistant.text, `${fixture.label} assistant ${turn}`);
  assert.equal(assistant.ts, timestamp);
}

function testRenderedTurnOracle(): void {
  const fixture = {
    project: '/private/fixture',
    name: 'project',
    sessionId: 'session',
    label: 'project:session',
    turns: 1,
  };
  const timestamp = '2026-10-01T12:00:01.000Z';
  const valid: Data = {
    schema_version: 2,
    turn: 1,
    status: 'ok',
    ended_by: null,
    user: 'project:session user 1',
    ts_start: timestamp,
    ts_end: timestamp,
    user_ts: timestamp,
    context: {
      session_id: 'session',
      project: 'project',
      cwd: fixture.project,
      model: 'owner-fixture-model',
    },
    env: { cwd: fixture.project, model: 'owner-fixture-model' },
    timeline: [
      {
        kind: 'tool_call',
        name: 'exec_command',
        source_harness: 'codex',
        id: 'project:session-call-1',
        ts: timestamp,
        result_ts: timestamp,
        input: { cmd: 'touch MUST-NOT-EXECUTE' },
        output: 'project:session result 1',
        output_length: 24,
        output_truncated: false,
        output_cut: false,
        is_error: false,
      },
      { kind: 'reasoning', text: 'project:session assistant 1', ts: timestamp },
    ],
  };
  assertRenderedTurn(valid, fixture);
  const corruptions: Array<(value: Data) => void> = [
    (value) => {
      value.user = 'another session';
    },
    (value) => {
      value.status = 'failed';
    },
    (value) => {
      row(value.context).cwd = '/different/project';
    },
    (value) => {
      value.turn = 2;
    },
    (value) => {
      value.user_ts = '2026-10-01T12:00:00.000Z';
    },
    (value) => {
      row((value.timeline as Data[])[0]).input = { cmd: 'different' };
    },
    (value) => {
      row((value.timeline as Data[])[0]).output = 'different';
    },
    (value) => {
      row((value.timeline as Data[])[1]).text = 'different';
    },
  ];
  for (const corrupt of corruptions) {
    const value = structuredClone(valid);
    corrupt(value);
    assert.throws(() => assertRenderedTurn(value, fixture));
  }
  process.stdout.write(
    JSON.stringify({
      state: 'passed',
      validTurnControls: 1,
      rejectedTurnControls: corruptions.length,
      runtimeExecuted: false,
    }) + '\n'
  );
}

function outputs(h: RenderHarness, fixture: ProjectFixture): Data {
  const names = committedTurnNames(fixture.session);
  const retained = path.join(h.root, 'retained-turn-bytes', fixture.name, fixture.sessionId);
  fs.mkdirSync(retained, { recursive: true, mode: 0o700 });
  return {
    directory: fixture.session,
    sourceTranscript: {
      path: fixture.transcriptFile,
      sha256: digest(fs.readFileSync(fixture.transcriptFile)),
    },
    count: names.length,
    members: names.map((name) => {
      const originalPath = path.join(fixture.session, name);
      // This is an observation capture limit, not a renderer or request budget.
      const committed = readCommittedTurnFile(fixture.session, name, 8 * 1024 * 1024);
      const bytes = committed.bytes,
        sha256 = digest(bytes);
      const retainedPath = path.join(retained, sha256 + '.json');
      if (!fs.existsSync(retainedPath))
        fs.writeFileSync(retainedPath, bytes, { mode: 0o600, flag: 'wx' });
      assert.deepEqual(fs.readFileSync(retainedPath), bytes, 'retained turn bytes differ');
      const value = committed.value;
      assertRenderedTurn(value, fixture);
      assert.equal(name, 'turn-' + String(value.turn).padStart(3, '0') + '.json');
      assert(!fs.existsSync(path.join(fixture.project, 'MUST-NOT-EXECUTE')));
      return {
        name,
        originalPath,
        retainedPath,
        bytes: bytes.length,
        sha256,
        dev: committed.dev,
        ino: committed.ino,
        semantics: 'passed',
      };
    }),
  };
}
async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('deadline: ' + label)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function signalOwned(
  h: RenderHarness,
  started: Started,
  signal: NodeJS.Signals,
  label: string
): void {
  assert(started.child.pid, 'retained Child has no PID');
  assert.equal(started.child.exitCode, null, 'owned child already exited');
  assert.equal(started.child.signalCode, null, 'owned child already signaled');
  const before = h.observe(started.child.pid);
  assert.equal(before.state, 'observed', 'owned child identity unavailable');
  const accepted = started.child.kill(signal);
  h.writeJson(label + '-signal.json', {
    pid: started.child.pid,
    signal,
    before,
    accepted,
    qualification: 'retained direct Child only; signal acceptance does not establish exit',
  });
  assert(accepted, 'retained Child signal refused');
}
async function largeFixture(h: RenderHarness, name: string): Promise<ProjectFixture> {
  const fixture = await h.createProject({ name, sessions: ['rendering', 'queued'] });
  // Many actual turn writes provide an observable interruption window without
  // modifying the reviewed foreign renderer or adding a runtime fault switch.
  const session = h.createSession(fixture, { sessionId: fixture.sessionId, turns: 10000 });
  Object.assign(fixture, session);
  h.writeJson('input.json', {
    path: session.transcriptFile,
    bytes: fs.statSync(session.transcriptFile).size,
    sha256: digest(fs.readFileSync(session.transcriptFile)),
    turns: 10000,
  });
  return fixture;
}
async function firstActualWrite(
  h: RenderHarness,
  fixture: ProjectFixture,
  expected: { requestId: string; invocationId: string; deadline: number } | null = null
): Promise<Data> {
  await h.waitFor(
    () => committedTurnNames(fixture.session).length > 0,
    expected ? Math.max(1, Math.min(25000, expected.deadline - Date.now())) : 25000,
    'actual renderer first turn write'
  );
  const state = outputs(h, fixture);
  if (expected) {
    const current = operationForInvocation(h, fixture, expected.invocationId);
    assert(current, 'matched operation absent at committed-write witness');
    assert.equal(row(row(current.body).identity).requestId, expected.requestId);
    h.writeJson('write-witness-operation.json', {
      phase: outcome(current),
      at: Date.now(),
      operation: current,
    });
    assert(runningOperation(current), 'renderer regressed to queued at committed-write witness');
  }
  if (expected && !(Number(state.count) > 0 && Number(state.count) < fixture.turns))
    throw new InterruptionWindowLost('partial committed output unavailable at write witness');
  assert(
    Number(state.count) > 0 && Number(state.count) < 10000,
    'actual renderer must have started but not completed all turn writes'
  );
  h.writeJson('before-interruption-outputs.json', state);
  const dispatch = h
    .ownerEvents()
    .find(
      (event) =>
        event.event === 'journal_dispatch' && (!expected || event.requestId === expected.requestId)
    );
  assert(dispatch, 'actual renderer write lacks owner dispatch observation');
  h.writeJson('before-interruption-state.json', {
    operations: h.operations(),
    events: h.ownerEvents(),
    worker: h.observe(Number(dispatch.nativeWorkerPid)),
    backend: h.observe(Number(dispatch.backendPid)),
  });
  return dispatch;
}
function legacyBlocked(h: RenderHarness, fixture: ProjectFixture): Data {
  const marker = path.join(fixture.session, 'MUST-NOT-REPLAY');
  const receipt = h.run(
    'legacy-after-unknown',
    h.native,
    [
      'render-writer',
      '--home',
      h.home,
      '--canonical-project',
      fixture.project,
      '--output-directory',
      fixture.session,
      '--session-id',
      fixture.sessionId,
      '--source-generation',
      String(row(fixture.image.manifest).sourceGeneration),
      '--timeout-ms',
      '1000',
      '--',
      '/usr/bin/touch',
      marker,
    ],
    fixture.project
  );
  assertLegacyDenial(
    receipt,
    fs.readFileSync(path.join(receipt.directory, 'stdout.bin'), 'utf8'),
    fs.readFileSync(path.join(receipt.directory, 'stderr.bin'), 'utf8')
  );
  assert(!fs.existsSync(marker), 'legacy writer replayed uncertain effect');
  return { receipt, marker, exists: false };
}
function writerOperations(fixture: ProjectFixture): Data[] {
  const base = path.join(fixture.project, '.caws/.render-writer-custody/operations/services');
  return files(base)
    .filter((name) => /(?:^|\/)\w{64}\.json$/.test(name))
    .map((name) => readJson(path.join(base, name)));
}
async function scenario(label: string, run: (h: RenderHarness) => Promise<Data>): Promise<void> {
  const h = await createRenderHarness({
    cli,
    sterling,
    nativeProfile: nativeProfile as 'debug' | 'release',
    label: 'render-lifecycle-' + label,
    ...(label === 'host-crash-restart' ? { limits: { maxBackends: 1 } } : {}),
  });
  h.writeJson('qualification-entry.json', {
    executable: process.execPath,
    args: process.argv.slice(1),
    cwd: process.cwd(),
    requestedScenario,
    qualifier: { path: __filename, sha256: digest(fs.readFileSync(__filename)) },
    harness: {
      path: path.join(__dirname, 'render-qualification-harness.js'),
      sha256: digest(fs.readFileSync(path.join(__dirname, 'render-qualification-harness.js'))),
    },
  });
  const result: Data = {
    label,
    root: h.root,
    sandbox: h.sandbox,
    state: 'running',
    nonclaims: [
      'machine installation',
      'deployed Sterling parity',
      'fatal native worker loss',
      'power-cut durability',
      'arbitrary same-UID adversary protection',
      'generation replacement',
    ],
  };
  results.push(result);
  try {
    Object.assign(result, await run(h));
    result.state = 'passed';
  } catch (error) {
    result.state = error instanceof InterruptionWindowLost ? 'incomplete' : 'failed';
    result.error = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally {
    // No cleanup signals are guessed from a PID or a lease. If retained child
    // cleanup cannot establish inactivity, keep the sandbox and stop scenarios.
    let finalizationFailure: unknown;
    try {
      result.cleanup = await h.cleanup(20000);
      assert.equal(
        row(result.cleanup).state,
        'confirmed_inactive',
        'cleanup uncertain; retained sandbox ' + h.sandbox
      );
    } catch (error) {
      result.cleanupError = error instanceof Error ? error.stack : String(error);
      result.state = 'failed';
      finalizationFailure = error;
    }
    if (finalizationFailure === undefined) {
      try {
        result.sessionEvidence = h.retainSessionEvidence();
      } catch (error) {
        result.sessionEvidenceError = error instanceof Error ? error.stack : String(error);
        result.state = 'failed';
        finalizationFailure = error;
      }
    }
    h.writeJson('scenario.json', result);
    writeJson(summaryPath, {
      schema: 'caws.qualification.render-lifecycle.v1',
      requestedScenario,
      results,
    });
    if (finalizationFailure !== undefined && result.error === undefined) throw finalizationFailure;
  }
}

class InterruptionWindowLost extends Error {
  constructor(message: string) {
    super('interruption window lost: ' + message);
  }
}
function completedBeforeInterruption(operation: Data): never {
  const result = row(row(row(operation.body).outcome).result);
  assert.equal(
    result.kind,
    'daemon_response',
    'renderer returned without a successful daemon response'
  );
  assert.equal(result.response, 'ok', 'renderer response was not successful');
  assert(Number.isSafeInteger(result.served) && Number(result.served) > 0, 'invalid served count');
  assert(
    Number.isSafeInteger(result.elapsedMs) && Number(result.elapsedMs) >= 0,
    'invalid renderer elapsed time'
  );
  assert.equal(typeof result.cached, 'boolean', 'invalid renderer cache flag');
  throw new InterruptionWindowLost('successful renderer response won the interruption race');
}
/** Admission is queued before Running is durably published; only Running permits the write probe. */
function runningOperation(operation: Data | undefined): Data | undefined {
  if (!operation) return undefined;
  const phase = outcome(operation);
  if (phase === 'queued') return undefined;
  if (phase === 'running') return operation;
  if (phase === 'returned') return completedBeforeInterruption(operation);
  throw new Error('renderer entered unexpected pre-interruption execution state: ' + phase);
}
function testInterruptionPhaseOracle(): void {
  const operation = (execution: string, result?: Data): Data => ({
    body: { outcome: { execution, ...(result ? { result } : {}) } },
  });
  assert.equal(runningOperation(undefined), undefined);
  assert.equal(runningOperation(operation('queued')), undefined);
  const running = operation('running');
  assert.equal(runningOperation(running), running);
  const success = {
    kind: 'daemon_response',
    response: 'ok',
    served: 1,
    elapsedMs: 1,
    cached: false,
  };
  assert.throws(() => runningOperation(operation('returned', success)), InterruptionWindowLost);
  for (const candidate of [
    operation('unknown'),
    operation('cancelled_before_dispatch'),
    operation('invalid'),
    operation('returned', { kind: 'not_started', stage: 'spawn', errno: 2 }),
    operation('returned', { kind: 'process_exit', code: 1, signal: null }),
    operation('returned', { ...success, response: 'error' }),
    operation('returned', { ...success, served: 0 }),
  ]) {
    assert.throws(
      () => runningOperation(candidate),
      (error: unknown) => error instanceof Error && !(error instanceof InterruptionWindowLost)
    );
  }
  process.stdout.write(
    JSON.stringify({
      state: 'passed',
      waitingControls: 2,
      runningControls: 1,
      successfulCompletionWindowControl: 1,
      rejectedFailureControls: 7,
      runtimeExecuted: false,
    }) + '\n'
  );
}
/** Join the durable verified wire bytes to typed invocation and selected project/session. */
function operationForInvocation(
  h: RenderHarness,
  fixture: ProjectFixture,
  invocationId: string
): Data | undefined {
  const matches = h.operations().filter((operation) => {
    const body = row(operation.body);
    assert(
      typeof body.verifiedRequestBase64 === 'string' && body.verifiedRequestBase64.length <= 174768,
      'verified renderer request byte bound'
    );
    const bytes = Buffer.from(body.verifiedRequestBase64, 'base64');
    assert.equal(
      bytes.toString('base64'),
      body.verifiedRequestBase64,
      'noncanonical verified request bytes'
    );
    assert.equal(
      digest(bytes),
      body.verifiedRequestSha256,
      'verified renderer request digest differs'
    );
    const request = decodeRenderRequest(bytes);
    const identity = row(body.identity);
    assert.equal(
      identity.requestId,
      request.requestId,
      'durable renderer request identity differs'
    );
    assert.equal(identity.argumentDigest, request.argumentDigest);
    assert.equal(identity.projectServiceKey, request.projectServiceKey);
    assert.equal(identity.sourceGeneration, request.sourceGeneration);
    assert.equal(identity.executionImageDigest, request.executionImage.imageDigest);
    return (
      request.invocationId === invocationId &&
      request.canonicalProject === fixture.project &&
      request.arguments[2] === fixture.sessionId &&
      request.arguments[0] === fixture.session &&
      request.arguments[9] === fixture.transcriptFile
    );
  });
  assert(matches.length <= 1, 'multiple renderer operations for one original invocation');
  return matches[0];
}
/** SIGKILL here bypasses frontend Drop/Abort; surviving custodians must perform cleanup. */
async function frontendLost(h: RenderHarness): Promise<Data> {
  const fixture = await largeFixture(h, 'frontend-loss');
  const host = h.startHost(true);
  // An inert owned sibling is only a process-isolation control, not a substitute renderer.
  const sibling = h.start(
    'surviving-sibling',
    process.execPath,
    [
      '-e',
      "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0)); process.stdout.write('sibling-ready\\n');",
    ],
    h.sandbox,
    h.env,
    undefined,
    { keepInputOpen: true }
  );
  try {
    await h.waitFor(
      () =>
        fs.readFileSync(path.join(sibling.directory, 'stdout.bin'), 'utf8') === 'sibling-ready\n',
      5000,
      'owned sibling ready on retained input channel'
    );
    const siblingBefore = h.originalChildAlive(sibling);
    const active = h.spawnInvocation(fixture, { traceCustody: true, timeoutMs: 30000 });
    const deadline = active.startedAt + 30000;
    const operation = await h.waitFor(
      () => {
        if (!h.sampleInvocation(active)) return undefined;
        let rows: Data[];
        try {
          rows = h.invocationJournal(active);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        }
        if (!rows.some((record) => record.stage === 'dispatch_started')) return undefined;
        const candidate = operationForInvocation(
          h,
          fixture,
          active.invocation!.expected!.invocationId
        );
        if (candidate)
          h.writeJson('pre-interruption-operation.json', {
            phase: outcome(candidate),
            at: Date.now(),
            operation: candidate,
          });
        return runningOperation(candidate);
      },
      Math.max(1, deadline - Date.now()),
      'current typed dispatch and verified owner operation'
    );
    const requestId = String(row(row(operation.body).identity).requestId);
    assert.equal(outcome(operation), 'running');
    const dispatch = await firstActualWrite(h, fixture, {
      requestId,
      invocationId: active.invocation!.expected!.invocationId,
      deadline,
    });
    assert(Date.now() < deadline, 'original request deadline exhausted before interruption');
    assert(h.sampleInvocation(active), 'fresh current frontend/custodian/Node chain unavailable');
    const frontendBefore = h.originalChildAlive(active);
    h.originalChildAlive(host);
    h.originalChildAlive(sibling);
    const current = operationForInvocation(h, fixture, active.invocation!.expected!.invocationId);
    assert(current, 'matching operation disappeared before interruption');
    h.writeJson('current-pre-interruption-operation.json', {
      phase: outcome(current),
      at: Date.now(),
      operation: current,
    });
    assert(runningOperation(current), 'renderer operation regressed to queued after Running');
    const count = committedTurnNames(fixture.session).length;
    if (count === 0 || count >= fixture.turns)
      throw new InterruptionWindowLost('partial committed output no longer holds');
    const workerBefore = h.observe(Number(dispatch.nativeWorkerPid));
    const backendBefore = h.observe(Number(dispatch.backendPid));
    assert.equal(workerBefore.state, 'observed', 'owned renderer worker unavailable');
    assert.equal(backendBefore.state, 'observed', 'owned backend unavailable');
    assert.equal(row(workerBefore.process).zombie, false);
    assert.equal(row(backendBefore.process).zombie, false);
    h.writeJson('frontend-loss-before.json', {
      requestId,
      operation: current,
      dispatch,
      count,
      frontendBefore,
      siblingBefore,
      workerBefore,
      backendBefore,
      coverage: active.invocation!.coverage,
    });
    // Every eligibility observation is distinct from the actual signal and wait receipt.
    h.originalChildAlive(active);
    const signalAt = Date.now();
    assert(signalAt < deadline, 'original request deadline exhausted at signal boundary');
    const accepted = active.child.kill('SIGKILL');
    h.writeJson('frontend-loss-signal.json', {
      accepted,
      signal: 'SIGKILL',
      pid: active.child.pid,
      source: 'retained original frontend Child',
      frontendBefore,
      signalAt,
      deadline,
    });
    assert(accepted, 'retained original frontend Child signal refused');
    const frontendReceipt = await bounded(active.done, 10000, 'original frontend SIGKILL wait');
    assert.equal(frontendReceipt.error, null);
    assert.equal(frontendReceipt.signal, 'SIGKILL');
    const nativeCleanup = await h.waitFor(
      () => {
        const observed = h.requestCompletion(active);
        return observed.state === 'confirmed_inactive' ? observed : undefined;
      },
      10000,
      'same Node actual reap/EOF/SDK settlement and request-group absence'
    );
    const settled = await h.waitFor(
      () => {
        const value = operationForInvocation(h, fixture, active.invocation!.expected!.invocationId);
        assert(value, 'matching owner operation disappeared');
        return outcome(value) === 'running' ? undefined : value;
      },
      10000,
      'matching renderer operation terminal outcome'
    );
    h.writeJson('post-interruption-operation.json', {
      phase: outcome(settled),
      at: Date.now(),
      operation: settled,
    });
    if (outcome(settled) === 'returned') completedBeforeInterruption(settled);
    assert.equal(outcome(settled), 'unknown', 'dispatched operation lacks durable unknown fence');
    const rendererCleanup = await h.waitFor(
      () => {
        const receipt = h
          .ownerEvents()
          .find(
            (event) =>
              event.event === 'worker_cleanup' &&
              event.nativeWorkerPid === dispatch.nativeWorkerPid &&
              event.backendPid === dispatch.backendPid
          );
        if (!receipt) return undefined;
        const value = row(receipt.receipt);
        const exit = h
          .ownerEvents()
          .find(
            (event) =>
              event.event === 'worker_exit' &&
              event.nativeWorkerPid === dispatch.nativeWorkerPid &&
              event.backendPid === dispatch.backendPid
          );
        const worker = h.observe(Number(dispatch.nativeWorkerPid)),
          backend = h.observe(Number(dispatch.backendPid));
        const groups = h.observedGroupsAbsent([workerBefore, backendBefore]);
        return value.directChildReaped === true &&
          value.logsPersisted === true &&
          value.childPid === dispatch.backendPid &&
          value.identityVerifiedBeforeSignal === true &&
          value.reapErrorErrno === null &&
          value.backendExit !== null &&
          value.deadlineExceeded === false &&
          row(value.stdout).eof === true &&
          row(value.stderr).eof === true &&
          exit &&
          worker.state === 'absent' &&
          backend.state === 'absent' &&
          groups
          ? { receipt, exit, worker, backend, groups }
          : undefined;
      },
      10000,
      'owned renderer backend reap/EOF, worker actual wait and independent absence'
    );
    const siblingAfter = h.originalChildAlive(sibling);
    h.writeJson('surviving-sibling-after-target-cleanup.json', {
      before: siblingBefore,
      after: siblingAfter,
    });
    h.originalChildAlive(host);
    const operationsBefore = h.operations();
    const dispatchesBefore = h.ownerEvents().filter((event) => event.event === 'journal_dispatch');
    const retryStarted = h.spawnInvocation(fixture, { traceCustody: true, timeoutMs: 30000 });
    const retry = await bounded(
      retryStarted.done,
      30000,
      'one fresh request under retained unknown fence'
    );
    const retryJournal = h.invocationJournal(retryStarted, true);
    const retryInvocation = retryJournal.find((record) => record.stage === 'invocation_started');
    assert(retryInvocation, 'fresh refused request lacks current typed identity');
    assert.equal(retryInvocation.invocation_id, retryStarted.invocation!.expected!.invocationId);
    assert.equal(retryInvocation.dispatch_cwd, fixture.project);
    const retryDenial = assertOwnerDenial(
      retry,
      retryInvocation,
      h.ownerEvents(),
      'unknown_fence',
      fs.readFileSync(path.join(retry.directory, 'stdout.bin'), 'utf8'),
      fs.readFileSync(path.join(retry.directory, 'stderr.bin'), 'utf8')
    );
    h.writeJson('frontend-loss-unknown-fence-admission-denial.json', {
      retry,
      retryInvocation,
      retryDenial,
      journalSource: retryStarted.invocation!.journalFile,
    });
    assert.deepEqual(
      h.operations(),
      operationsBefore,
      'unknown fence admitted a new durable effect'
    );
    assert.deepEqual(
      h.ownerEvents().filter((event) => event.event === 'journal_dispatch'),
      dispatchesBefore,
      'unknown fence dispatched another write'
    );
    const retryCleanup = await h.waitFor(
      () => {
        const result = h.requestCompletion(retryStarted);
        return result.state === 'confirmed_inactive' ? result : undefined;
      },
      10000,
      'fresh refused request native custody/absence'
    );
    assert(
      writerOperations(fixture).some((value) => outcome(value) === 'unknown'),
      'cooperative writer domain lost unresolved effect'
    );
    const hostReceipt = await bounded(
      host.done,
      15000,
      'original host idle exit after frontend loss'
    );
    h.success(hostReceipt);
    return {
      requestId,
      dispatch,
      frontendReceipt,
      nativeCleanup,
      settled,
      rendererCleanup,
      retry,
      retryCleanup,
      siblingBefore,
      siblingAfter,
      hostReceipt,
      established: [
        'actual selected renderer partial write before original frontend SIGKILL',
        'same Node custody terminal reap/EOF/SDK settlement plus request absence',
        'surviving original renderer owners drain backend and retain unknown fence',
        'one fresh correlated request refused without another effect',
        'independent owned inert sibling survived target cleanup',
      ],
      nonclaims: [
        'actual second frontend/surface coverage',
        'Ready-before-dispatch loss',
        'resident reuse',
        '13-session fairness',
      ],
    };
  } finally {
    // Release only this owned inert control through its normal input protocol; no signal.
    sibling.child.stdin?.end();
    const receipt = await bounded(sibling.done, 5000, 'owned sibling normal input-release exit');
    h.success(receipt);
    h.writeJson('surviving-sibling-release.json', receipt);
  }
}

async function cancelled(h: RenderHarness): Promise<Data> {
  const fixture = await largeFixture(h, 'cancel');
  const host = h.startHost();
  const active = h.spawnInvocation(fixture);
  const dispatch = await firstActualWrite(h, fixture);
  // A second actual native caller queues behind the active project's actor.
  const queued = h.spawnInvocation(fixture, { sessionId: 'queued' });
  await h.waitFor(
    () => h.ownerEvents().filter((event) => event.event === 'actor_queued').length === 2,
    10000,
    'second caller admitted to active actor queue'
  );
  signalOwned(h, queued, 'SIGTERM', 'queued-caller');
  const queuedReceipt = await bounded(queued.done, 10000, 'queued native caller exit');
  h.writeJson('queued-caller-receipt.json', queuedReceipt);
  signalOwned(h, active, 'SIGTERM', 'dispatched-caller');
  const callerReceipt = await bounded(active.done, 10000, 'dispatched native caller exit');
  const unknown = await h.waitFor(
    () => h.operations().find((operation) => outcome(operation) === 'unknown'),
    10000,
    'durable unknown after dispatched caller cancellation'
  );
  await h.waitFor(
    () =>
      h
        .ownerEvents()
        .find(
          (event) =>
            event.event === 'worker_cleanup' && row(event.receipt).directChildReaped === true
        ),
    10000,
    'owned backend cleanup'
  );
  assert.equal(h.operations().length, 1, 'queued cancelled caller created another durable effect');
  assert.equal(
    h.ownerEvents().filter((event) => event.event === 'journal_dispatch').length,
    1,
    'queued cancelled caller dispatched'
  );
  assert.equal(
    files(path.join(fixture.project, '.caws/sessions/queued')).filter((name) =>
      /^turn-\d+\.json$/.test(name)
    ).length,
    0,
    'queued caller wrote turns'
  );
  const beforeRetry = h.operations();
  const retry = await h.invoke(fixture, { timeoutMs: 5000 });
  h.writeJson('fresh-request-under-unknown.json', retry);
  ownerDenied(h, fixture, retry, 'unknown_fence', 'fresh-request-under-unknown');
  assert.deepEqual(h.operations(), beforeRetry, 'unknown fence admitted fresh effect');
  assert.equal(
    h.ownerEvents().filter((event) => event.event === 'journal_dispatch').length,
    1,
    'unknown request was blindly replayed'
  );
  h.writeJson('after-interruption-outputs.json', outputs(h, fixture));
  const hostReceipt = await bounded(host.done, 15000, 'idle host exit after cancellation');
  const legacy = legacyBlocked(h, fixture);
  h.writeJson('writer-operations-final.json', writerOperations(fixture));
  assert(
    writerOperations(fixture).some((operation) => outcome(operation) === 'unknown'),
    'cooperative legacy refusal lacks durable unknown writer intent'
  );
  return {
    dispatch,
    unknown,
    queuedReceipt,
    callerReceipt,
    hostReceipt,
    legacy,
    established: [
      'actual turn write before interruption',
      'queued caller does not dispatch',
      'dispatched caller unknown',
      'owned backend reaped',
      'fresh request refused under unknown fence',
    ],
  };
}

async function queuedCancelled(h: RenderHarness): Promise<Data> {
  const fixture = await h.createProject({
    name: 'queued-cancel',
    sessions: ['rendering', 'queued'],
  });
  const host = h.startHost();
  const active = h.spawnInvocation(fixture);
  const prepared = await h.waitFor(
    () => h.ownerEvents().find((event) => event.event === 'prepared'),
    15000,
    'first actual caller prepared and actor occupied'
  );
  const queued = h.spawnInvocation(fixture, { sessionId: 'queued' });
  const admission = await h.waitFor(
    () => {
      const admissions = h.ownerEvents().filter((event) => event.event === 'actor_queued');
      return admissions.length === 2 && admissions[1];
    },
    10000,
    'second caller queued behind a running successful render'
  );
  assert(
    !h
      .ownerEvents()
      .some(
        (event) =>
          event.event === 'actor_stage' &&
          event.stage === 'finish' &&
          event.invocationId === prepared.invocationId
      ),
    'first actor job finished before queue interruption'
  );
  signalOwned(h, queued, 'SIGTERM', 'queued-caller');
  const queuedReceipt = await bounded(queued.done, 10000, 'queued caller exit');
  const callerReceipt = await bounded(active.done, 30000, 'first actual render normal completion');
  h.success(callerReceipt);
  await h.waitFor(
    () =>
      h
        .ownerEvents()
        .find(
          (event) =>
            event.event === 'actor_stage' &&
            event.stage === 'finish' &&
            event.invocationId === admission.invocationId
        ),
    10000,
    'cancelled queue connection resolved without dispatch'
  );
  const operations = h.operations();
  assert.equal(operations.length, 1, 'cancelled queue connection created an effect');
  assert.equal(
    outcome(operations[0]!),
    'returned',
    'queue cancellation proof is masked by unknown first effect'
  );
  assert.equal(h.ownerEvents().filter((event) => event.event === 'journal_dispatch').length, 1);
  assert.equal(
    outputs(h, fixture).count,
    1,
    'successful first render did not retain its actual turn'
  );
  assert.equal(
    files(path.join(fixture.project, '.caws/sessions/queued')).filter((name) =>
      /^turn-\d+\.json$/.test(name)
    ).length,
    0
  );
  const hostReceipt = await bounded(host.done, 15000, 'normal host exit after queued cancellation');
  h.success(hostReceipt);
  const intents = writerOperations(fixture);
  assert.equal(intents.length, 1);
  assert.equal(outcome(intents[0]!), 'returned', 'queued cancellation poisoned writer domain');
  h.writeJson('writer-operations-final.json', intents);
  h.writeJson('after-queue-cancellation-outputs.json', outputs(h, fixture));
  return {
    prepared,
    admission,
    queuedReceipt,
    callerReceipt,
    hostReceipt,
    established: [
      'second caller admitted while first actor job remains occupied',
      'first actual render returns normally',
      'cancelled queued caller never dispatches',
      'no unknown fence masks queue cancellation',
    ],
  };
}
async function crashed(h: RenderHarness): Promise<Data> {
  const fixture = await largeFixture(h, 'crash');
  const capacityControl = await h.createProject({ name: 'capacity-control' });
  const host = h.startHost();
  const active = h.spawnInvocation(fixture);
  const dispatch = await firstActualWrite(h, fixture);
  signalOwned(h, host, 'SIGKILL', 'host-crash');
  const hostReceipt = await bounded(host.done, 10000, 'retained host wait');
  const callerReceipt = await bounded(active.done, 15000, 'caller after host death');
  await h.waitFor(
    () => h.observe(Number(dispatch.backendPid)).state === 'absent',
    10000,
    'owned backend after host death'
  );
  await h.waitFor(
    () => h.observe(Number(dispatch.nativeWorkerPid)).state === 'absent',
    10000,
    'native worker after host death'
  );
  const workerExits = files(path.join(h.owner, 'workers'))
    .filter((name) => name.endsWith('/backend/worker-exit.json'))
    .map((name) => readJson(path.join(h.owner, 'workers', name)));
  assert.equal(workerExits.length, 1, 'actual worker exit receipt must survive host crash');
  assert.equal(row(row(workerExits[0]!).cleanup).directChildReaped, true);
  h.writeJson('worker-exits-after-host-crash.json', workerExits);
  const replacement = h.startHost();
  const recovered = await h.waitFor(
    () =>
      h
        .ownerEvents()
        .find((event) => event.event === 'journal_recovered' && event.unknown === true),
    10000,
    'restart recovers running effect as unknown'
  );
  const unknown = h.operations().find((operation) => outcome(operation) === 'unknown');
  assert(unknown, 'restarted owner did not persist unknown');
  const beforeRetry = h.operations();
  const retry = await h.invoke(fixture, { timeoutMs: 5000 });
  h.writeJson('restart-fresh-request.json', retry);
  ownerDenied(h, fixture, retry, 'unknown_fence', 'restart-fresh-request');
  assert.deepEqual(
    h.operations(),
    beforeRetry,
    'restart admitted fresh effect under unknown fence'
  );
  assert.equal(
    h.ownerEvents().filter((event) => event.event === 'journal_dispatch').length,
    1,
    'restart replayed the uncertain operation'
  );
  const capacityReceipt = await h.invoke(capacityControl, { timeoutMs: 5000 });
  h.writeJson('restart-global-capacity-control.json', capacityReceipt);
  ownerDenied(
    h,
    capacityControl,
    capacityReceipt,
    'backend_capacity_exhausted',
    'restart-global-capacity-control'
  );
  assert.equal(
    h.ownerEvents().filter((event) => event.event === 'worker_created').length,
    1,
    'unknown reservation released the configured single backend slot after restart'
  );
  assert.equal(
    outputs(h, capacityControl).count,
    0,
    'a fresh project bypassed the unknown global reservation'
  );
  h.writeJson('after-interruption-outputs.json', outputs(h, fixture));
  const replacementReceipt = await bounded(replacement.done, 15000, 'restarted idle host exit');
  const legacy = legacyBlocked(h, fixture);
  h.writeJson('writer-operations-final.json', writerOperations(fixture));
  assert(
    writerOperations(fixture).some((operation) => outcome(operation) === 'unknown'),
    'restarted cooperative legacy refusal lacks durable unknown writer intent'
  );
  return {
    dispatch,
    recovered,
    unknown,
    hostReceipt,
    callerReceipt,
    replacementReceipt,
    legacy,
    capacityReceipt,
    established: [
      'actual turn write before host death',
      'owned worker EOF cleanup',
      'host restart durable unknown reservation',
      'fresh request refused without replay',
    ],
  };
}

async function normal(h: RenderHarness): Promise<Data> {
  const fixture = await h.createProject({ name: 'normal' });
  const keeper = await h.createProject({ name: 'keeper' });
  const host = h.startHost();
  const callerReceipt = await h.invoke(fixture);
  h.success(callerReceipt);
  assert.equal(
    outputs(h, fixture).count,
    1,
    'actual normal renderer did not produce exactly one turn'
  );
  const backend = h.ownerEvents().find((event) => event.event === 'worker_created');
  assert(backend, 'normal actual backend observation missing');
  let keepActive = true;
  const keeperRequestMs = 30000;
  const callerCleanupGraceMs = 10000;
  let keeperStarted: Started | null = null;
  let keeperFailure: Error | null = null;
  const keeperLoop = (async (): Promise<void> => {
    while (keepActive) {
      keeperStarted = h.spawnInvocation(keeper, { timeoutMs: keeperRequestMs });
      h.success(await keeperStarted.done);
      await pause(250);
    }
  })().catch((error: unknown) => {
    keeperFailure = error instanceof Error ? error : new Error(String(error));
  });
  let legacy: Data;
  const retirementObservationStartedAt = Date.now();
  const retirementObservationDeadline = retirementObservationStartedAt + 15000;
  try {
    await h.waitFor(
      () =>
        h
          .ownerEvents()
          .find(
            (event) => event.event === 'worker_cleanup' && event.backendPid === backend.backendPid
          ),
      Math.max(1, retirementObservationDeadline - Date.now()),
      'idle normal project cleanup while peer remains active'
    );
    assert.equal(host.child.exitCode, null, 'peer did not retain host lifetime');
    assert.equal(host.child.signalCode, null);
    h.writeJson('writer-intent-at-cleanup-observation.json', {
      observedAt: Date.now(),
      retirementObservationStartedAt,
      retirementObservationDeadline,
      operations: writerOperations(fixture),
    });
    const intents = await h.waitFor(
      () => {
        const current = writerOperations(fixture);
        assert.equal(current.length, 1, 'normal backend must retain one lifecycle intent');
        const state = outcome(current[0]!);
        if (state === 'returned') return current;
        assert.equal(state, 'running', 'normal cleanup retained an unexpected writer outcome');
        return undefined;
      },
      Math.max(1, retirementObservationDeadline - Date.now()),
      'durable normal writer settlement after native worker wait'
    );
    h.writeJson('writer-intent-settled.json', { observedAt: Date.now(), operations: intents });
    const retired = await h.waitFor(
      () => {
        const worker = h.observe(Number(backend.nativeWorkerPid));
        const child = h.observe(Number(backend.backendPid));
        return worker.state === 'absent' && child.state === 'absent'
          ? { worker, backend: child }
          : undefined;
      },
      Math.max(1, retirementObservationDeadline - Date.now()),
      'retired actual worker and backend absence'
    );
    h.writeJson('retirement-process-absence.json', {
      observedAt: Date.now(),
      retirementObservationStartedAt,
      retirementObservationDeadline,
      ...retired,
    });
    const marker = path.join(fixture.session, 'LEGACY-KNOWN-IDLE-CONTROL');
    const receipt = h.run(
      'legacy-after-known-idle',
      h.native,
      [
        'render-writer',
        '--home',
        h.home,
        '--canonical-project',
        fixture.project,
        '--output-directory',
        fixture.session,
        '--session-id',
        fixture.sessionId,
        '--source-generation',
        String(row(fixture.image.manifest).sourceGeneration),
        '--timeout-ms',
        '2000',
        '--',
        '/usr/bin/touch',
        marker,
      ],
      fixture.project
    );
    h.success(receipt);
    assert(fs.existsSync(marker), 'normal idle project retained writer lock');
    legacy = { marker, receipt, exists: true };
  } finally {
    keepActive = false;
    const stoppingAt = Date.now();
    // Observe the already issued request through its original execution bound,
    // plus the same caller-cleanup grace used by interrupted native callers.
    const retainedKeeper = keeperStarted as Started | null;
    const requestDeadline = (retainedKeeper?.startedAt ?? stoppingAt) + keeperRequestMs;
    const observationDeadline = requestDeadline + callerCleanupGraceMs;
    const remainingMs = Math.max(1, observationDeadline - stoppingAt);
    h.writeJson('peer-stop-budget.json', {
      startedAt: retainedKeeper?.startedAt ?? null,
      stoppingAt,
      requestMs: keeperRequestMs,
      requestDeadline,
      callerCleanupGraceMs,
      observationDeadline,
      remainingMs,
    });
    await bounded(keeperLoop, remainingMs, 'peer activity stop under original request deadline');
    if (keeperFailure) throw keeperFailure;
  }
  const hostReceipt = await bounded(host.done, 15000, 'normal host idle exit');
  h.success(hostReceipt);
  h.writeJson('writer-operations-final.json', writerOperations(fixture));
  assert(writerOperations(fixture).every((operation) => outcome(operation) === 'returned'));
  h.writeJson('normal-outputs.json', outputs(h, fixture));
  return {
    callerReceipt,
    hostReceipt,
    legacy,
    established: [
      'actual normal turn write',
      'normal complete owned cleanup settles writer intent',
      'idle project releases writer while peer keeps host active',
    ],
  };
}

async function main(): Promise<void> {
  if (oracleSelfTest) {
    testDenialOracles();
    testRenderedTurnOracle();
    testInterruptionPhaseOracle();
    return;
  }
  // The additional hard-loss qualification is explicit; existing `all` keeps its prior modes.
  if (selectedScenario === 'frontend-loss') {
    await scenario('frontend-loss', frontendLost);
    process.stdout.write(JSON.stringify({ state: 'passed', summaryPath, results }, null, 2) + '\n');
    return;
  }
  const scenarios = [
    ['normal', normal],
    ['queued-cancel', queuedCancelled],
    ['cancel', cancelled],
    ['host-crash-restart', crashed],
  ] as const;
  for (const [label, run] of scenarios) {
    if (selectedScenario === 'all' || selectedScenario === label) await scenario(label, run);
  }
  process.stdout.write(JSON.stringify({ state: 'passed', summaryPath, results }, null, 2) + '\n');
}
main().catch((error) => {
  process.stderr.write(String(error instanceof Error ? error.stack : error) + '\n');
  process.exitCode = 1;
});
