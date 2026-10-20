/** Actual selected renderer interruption/restart qualification; private fixtures only. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
  type Started,
} from './render-qualification-harness';

assert(process.argv[2] && process.argv[3], 'CLI and Sterling source roots required');
const cli = fs.realpathSync(process.argv[2]);
const sterling = fs.realpathSync(process.argv[3]);
const requestedScenario = process.argv[4] ?? 'all';
const selectedScenario = requestedScenario === 'restart' ? 'host-crash-restart' : requestedScenario;
assert(
  ['all', 'normal', 'queued-cancel', 'cancel', 'host-crash-restart'].includes(selectedScenario),
  'scenario must be all, normal, queued-cancel, cancel, or restart'
);
const results: Data[] = [];
const summaryPath = path.resolve(
  cli,
  '../caws-native/target/qualification/render-lifecycle-latest.json'
);

function outcome(operation: Data): string {
  return String(row(row(operation.body).outcome).execution);
}
function outputs(fixture: ProjectFixture): Data {
  const names = files(fixture.session).filter((name) => /^turn-\d+\.json$/.test(name));
  return {
    directory: fixture.session,
    count: names.length,
    members: names.map((name) => {
      const bytes = fs.readFileSync(path.join(fixture.session, name));
      return { name, bytes: bytes.length, sha256: digest(bytes) };
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
async function firstActualWrite(h: RenderHarness, fixture: ProjectFixture): Promise<Data> {
  await h.waitFor(
    () => files(fixture.session).some((name) => /^turn-\d+\.json$/.test(name)),
    25000,
    'actual renderer first turn write'
  );
  const state = outputs(fixture);
  assert(
    Number(state.count) > 0 && Number(state.count) < 10000,
    'actual renderer must have started but not completed all turn writes'
  );
  h.writeJson('before-interruption-outputs.json', state);
  const dispatch = h.ownerEvents().find((event) => event.event === 'journal_dispatch');
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
  assert.notEqual(receipt.code, 0, 'cooperative legacy writer ignored durable unknown');
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
    result.state = 'failed';
    result.error = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally {
    // No cleanup signals are guessed from a PID or a lease. If retained child
    // cleanup cannot establish inactivity, keep the sandbox and stop scenarios.
    result.cleanup = await h.cleanup(20000);
    h.writeJson('scenario.json', result);
    writeJson(summaryPath, {
      schema: 'caws.qualification.render-lifecycle.v1',
      requestedScenario,
      results,
    });
    assert.equal(
      row(result.cleanup).state,
      'confirmed_inactive',
      'cleanup uncertain; retained sandbox ' + h.sandbox
    );
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
  assert.deepEqual(h.operations(), beforeRetry, 'unknown fence admitted fresh effect');
  assert.equal(
    h.ownerEvents().filter((event) => event.event === 'journal_dispatch').length,
    1,
    'unknown request was blindly replayed'
  );
  h.writeJson('after-interruption-outputs.json', outputs(fixture));
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
  assert.equal(outputs(fixture).count, 1, 'successful first render did not retain its actual turn');
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
  h.writeJson('after-queue-cancellation-outputs.json', outputs(fixture));
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
  assert.equal(
    h.ownerEvents().filter((event) => event.event === 'worker_created').length,
    1,
    'unknown reservation released the configured single backend slot after restart'
  );
  assert.equal(
    outputs(capacityControl).count,
    0,
    'a fresh project bypassed the unknown global reservation'
  );
  h.writeJson('after-interruption-outputs.json', outputs(fixture));
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
    outputs(fixture).count,
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
  h.writeJson('normal-outputs.json', outputs(fixture));
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
