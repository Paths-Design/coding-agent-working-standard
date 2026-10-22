/** Owned plan producer -> actual sealed Codex Stop finalizer qualification.
 * Usage: qualify-render-plan-snapshots.js <caws-cli-root> <sterling-root>
 * Private fixtures only. Original selected handlers and 30s Stop budget remain.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createRenderHarness,
  digest,
  files,
  put,
  readJson,
  row,
  type Data,
  type ProjectFixture,
  type Receipt,
  type RenderHarness,
  type Started,
} from './render-qualification-harness';

assert(process.argv.length === 4, 'CLI root and reviewed Sterling source root required');
const cli = fs.realpathSync(process.argv[2]!);
const sterling = fs.realpathSync(process.argv[3]!);
const NATIVE_STOP_MS = 30000;
const STOP_CLOSE_OBSERVATION_MS = 40000;
const HELPER_CLOSE_OBSERVATION_MS = 6000;
const MAX_SNAPSHOT_FILES = 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const legacyDiagnostic =
  'legacy ownerless pending plan snapshots preserved; explicit provenance migration required';
type CloseObserved = {
  started: Started;
  closed: Promise<Receipt>;
  closeConfirmed: boolean;
  stdinError: string | null;
};
type ProduceRequest = {
  canonicalProject: string;
  surface: 'codex';
  sessionId: string;
  transcriptPath: string;
  action: { kind: 'produce'; planPath: string };
};
function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? String(error)) : String(error);
}
async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('close/observation unavailable: ' + label + '; no signal sent')),
          milliseconds
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
function observeClose(started: Started): CloseObserved {
  let observed: CloseObserved;
  const close = new Promise<void>((resolve) => {
    started.child.once('close', () => {
      observed.closeConfirmed = true;
      resolve();
    });
  });
  observed = {
    started,
    closeConfirmed: false,
    stdinError: null,
    closed: Promise.all([started.done, close]).then(([receipt]) => receipt),
  };
  started.child.stdin?.on('error', (error) => {
    observed.stdinError = errorText(error);
  });
  return observed;
}
function sourceIdentity(file: string): Data {
  const stat = fs.lstatSync(file, { bigint: true });
  assert(stat.isFile() && !stat.isSymbolicLink(), 'expected ordinary fixture file');
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    bytes: Number(stat.size),
    mode: '0' + (stat.mode & 0o7777n).toString(8),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    sha256: digest(fs.readFileSync(file)),
  };
}
function sameFile(before: Data, after: Data, label: string): void {
  for (const key of ['dev', 'ino', 'bytes', 'mode', 'mtimeNs', 'ctimeNs', 'sha256'])
    assert.equal(after[key], before[key], label + ': ' + key);
}
function pendingTickets(h: RenderHarness, request: ProduceRequest): string[] {
  const root = path.join(h.home, 'state/plan-snapshots/v1/owners');
  return files(root)
    .filter((name) => {
      if (path.basename(path.dirname(name)) !== 'pending' || !name.endsWith('.json')) return false;
      const owner = row(row(readJson(path.join(root, name)).claim).owner);
      return (
        owner.canonicalProject === request.canonicalProject &&
        owner.surface === request.surface &&
        owner.sessionId === request.sessionId
      );
    })
    .map((name) => path.join(root, name));
}
function jsonLines(bytes: string): Data[] {
  assert(bytes.endsWith('\n'), 'settled JSONL record lacks final newline');
  return bytes
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => row(JSON.parse(line)));
}
function assertTurn(value: Data, fixture: ProjectFixture, turn: number): void {
  assert.equal(value.schema_version, 2);
  assert.equal(value.turn, turn);
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
function request(fixture: ProjectFixture): ProduceRequest {
  const planPath = path.join(fixture.project, '.caws/plans/owned-plan.md');
  put(planPath, '# Private owned plan snapshot qualification\n');
  return {
    canonicalProject: fixture.project,
    surface: 'codex',
    sessionId: fixture.sessionId,
    transcriptPath: fixture.transcriptFile,
    action: { kind: 'produce', planPath },
  };
}
function snapshot(request: ProduceRequest): string {
  return request.action.planPath.slice(0, -3) + '.transcript.jsonl';
}
function retain(h: RenderHarness, label: string, fixtureRoots: readonly string[]): Data[] {
  const destination = path.join(h.root, 'checkpoints', label);
  const records: Data[] = [];
  for (let index = 0; index < fixtureRoots.length; index++) {
    const root = fixtureRoots[index]!;
    if (!fs.existsSync(root)) continue;
    const stat = fs.lstatSync(root);
    assert(!stat.isSymbolicLink());
    const names = stat.isDirectory() ? files(root) : [path.basename(root)];
    for (const name of names) {
      assert(records.length < MAX_SNAPSHOT_FILES, 'checkpoint file bound');
      const original = stat.isDirectory() ? path.join(root, name) : root;
      const metadata = sourceIdentity(original);
      assert(Number(metadata.bytes) <= MAX_SNAPSHOT_BYTES, 'checkpoint byte bound');
      const bytes = fs.readFileSync(original);
      const retained = path.join(destination, String(index), name);
      put(retained, bytes);
      assert.equal(digest(bytes), metadata.sha256);
      sameFile(metadata, sourceIdentity(original), 'checkpoint stable input');
      records.push({ root, name, original, retained, ...metadata });
    }
  }
  h.writeJson('checkpoints/' + label + '/inventory.json', records);
  return records;
}
function invocationEvidence(h: RenderHarness, fixture: ProjectFixture, receipt: Receipt): Data {
  assert(typeof receipt.pid === 'number' && receipt.pid > 0);
  const command = readJson(path.join(receipt.directory, 'command.json'));
  const directory = path.join(fixture.session, 'hook-invocations');
  const names = files(directory).filter(
    (name) => name.startsWith(String(receipt.pid) + '-') && name.endsWith('.jsonl')
  );
  assert.equal(names.length, 1, 'caller must have exactly one correlated invocation journal');
  const journalPath = path.join(directory, names[0]!);
  const journalBytes = fs.readFileSync(journalPath);
  put(path.join(h.root, 'actual-invocation.jsonl'), journalBytes);
  const journal = jsonLines(journalBytes.toString('utf8'));
  const compatibility = journal.filter(
    (event) => event.stage === 'compatibility_dispatch_completed'
  );
  const encodedExecution = compatibility[0]?.execution_records_base64;
  const executionBytes =
    typeof encodedExecution === 'string' ? Buffer.from(encodedExecution, 'base64') : null;
  if (executionBytes !== null)
    put(path.join(h.root, 'actual-execution-records.jsonl'), executionBytes);
  assert.equal(command.cwd, fixture.project);
  assert(Array.isArray(command.args));
  const args = command.args as unknown[];
  assert.equal(args[args.indexOf('--timeout-ms') + 1], String(NATIVE_STOP_MS));
  assert.equal(args[args.indexOf('--event') + 1], 'stop');
  assert.equal(args[args.indexOf('--surface') + 1], 'codex');
  const starts = journal.filter((event) => event.stage === 'invocation_started');
  assert.equal(starts.length, 1);
  const start = starts[0]!;
  const id = start.invocation_id;
  assert(typeof id === 'string' && id.startsWith(receipt.pid + '-'));
  assert.equal(
    start.input_sha256,
    digest(fs.readFileSync(path.join(receipt.directory, 'stdin.bin')))
  );
  assert.equal(start.surface, 'codex');
  assert.equal(start.event, 'stop');
  assert.equal(start.dispatch_cwd, fixture.project);
  assert.equal(start.runtime_digest, h.installed.digest);
  const prefix = h
    .ownerEvents()
    .filter((event) => event.event === 'prefix_disposition' && event.invocationId === id);
  assert.equal(prefix.length, 1, 'caller lacks one correlated native prefix disposition');
  assert.equal(prefix[0]!.mode, 'session');
  assert.equal(prefix[0]!.proofProfile, 'codex-stop-session-prefix-v1');
  const selected = row(fixture.selection);
  assert(Array.isArray(selected.handlers));
  const planHandler = row(selected.handlers[1]);
  assert.equal(planHandler.entry, 'plan-transcript-finalize.sh');
  assert.equal(planHandler.kind, 'stock');
  assert(Array.isArray(start.selected_handlers));
  assert.equal(start.selected_handlers.length, selected.handlers.length);
  assert.deepEqual(
    row(start.selected_handlers[1]),
    planHandler,
    'invocation selected plan source differs from admitted selection'
  );
  assert.equal(compatibility.length, 1);
  assert.equal(compatibility[0]!.exit_code, 0);
  assert(typeof encodedExecution === 'string');
  assert(executionBytes !== null);
  const execution = jsonLines(executionBytes.toString('utf8'));
  assert.equal(execution.length, selected.handlers.length);
  assert.deepEqual(
    execution.map((record) => record.handler),
    selected.handlers.map((handler) => row(handler).entry)
  );
  const finalizer = execution.filter(
    (event) => event.handler === 'plan-transcript-finalize.sh' && event.status === 'completed'
  );
  assert.equal(finalizer.length, 1);
  assert.equal(finalizer[0]!.exit_code, 0);
  assert.equal(finalizer[0]!.path, planHandler.path);
  assert.equal(finalizer[0]!.session_id, fixture.sessionId);
  assert.equal(finalizer[0]!.hook_event, 'Stop');
  assert(String(finalizer[0]!.stderr).includes(legacyDiagnostic));
  return {
    command,
    journalPath,
    invocationId: id,
    prefix: prefix[0],
    selectedPlanHandler: start.selected_handlers[1],
    executionFinalizer: finalizer[0],
    journalSha256: digest(journalBytes),
    executionSha256: digest(executionBytes),
  };
}
async function main(): Promise<void> {
  const h = await createRenderHarness({ cli, sterling, label: 'render-plan-snapshots' });
  const children: CloseObserved[] = [];
  const manifest: Data = {
    schema: 'caws.qualification.render-plan-snapshots.v1',
    state: 'running',
    root: h.root,
    sandbox: h.sandbox,
    nativeSha256: digest(fs.readFileSync(h.native)),
    runtimeDigest: h.installed.digest,
    nativeStopMs: NATIVE_STOP_MS,
    stopCloseObservationMs: STOP_CLOSE_OBSERVATION_MS,
    nonclaims: [
      'all shared producer adoption',
      'machine installation',
      'foreign checkout mutation',
      'full PID or guard parity',
      'power-loss or actual process-crash recovery',
      'permanent destination owner reuse or ownerless legacy migration',
    ],
  };
  const persist = (): void => h.writeJson('manifest.json', manifest);
  const frozenNative = (): void =>
    assert.equal(
      digest(fs.readFileSync(h.native)),
      manifest.nativeSha256,
      'native candidate bytes changed during qualification'
    );
  h.writeJson('qualification-entry.json', {
    executable: process.execPath,
    args: process.argv.slice(1),
    cwd: process.cwd(),
    qualifier: { path: __filename, sha256: digest(fs.readFileSync(__filename)) },
    harness: {
      path: path.join(__dirname, 'render-qualification-harness.js'),
      sha256: digest(fs.readFileSync(path.join(__dirname, 'render-qualification-harness.js'))),
    },
    environment: h.env,
  });
  persist();
  let failure: unknown;
  let checkpointRoots: string[] = [];
  try {
    const primary = await h.createProject({ name: 'plan-primary', sessions: ['shared-id'] });
    const other = await h.createProject({ name: 'plan-other', sessions: ['shared-id'] });
    assert.notEqual(primary.project, other.project);
    assert.equal(primary.sessionId, other.sessionId);
    const ownRequest = request(primary),
      otherRequest = request(other);
    checkpointRoots = [
      path.join(h.home, 'state/plan-snapshots'),
      path.join(h.home, '.codex'),
      path.join(primary.project, '.caws/plans'),
      path.join(other.project, '.caws/plans'),
      primary.transcriptFile,
      other.transcriptFile,
      primary.session,
      other.session,
    ];
    manifest.projects = { primary, other };
    manifest.requests = { primary: ownRequest, other: otherRequest };
    persist();
    for (const [label, input] of [
      ['produce-primary', ownRequest],
      ['produce-other', otherRequest],
    ] as const) {
      frozenNative();
      const started = observeClose(
        h.start(
          label,
          h.native,
          [
            'plan-snapshots',
            '--home',
            h.home,
            '--checkout',
            input.canonicalProject,
            '--legacy-user-home',
            h.home,
          ],
          input.canonicalProject,
          h.env,
          JSON.stringify(input)
        )
      );
      children.push(started);
      const receipt = await bounded(started.closed, HELPER_CLOSE_OBSERVATION_MS, label);
      h.success(receipt);
      assert.equal(receipt.signal, null);
      assert.equal(started.stdinError, null);
      assert.equal(readJson(path.join(receipt.directory, 'stdout.bin')).produced, 1);
    }
    assert.deepEqual(
      fs.readFileSync(snapshot(ownRequest)),
      fs.readFileSync(primary.transcriptFile)
    );
    assert.deepEqual(
      fs.readFileSync(snapshot(otherRequest)),
      fs.readFileSync(other.transcriptFile)
    );
    assert.equal(pendingTickets(h, ownRequest).length, 1);
    assert.equal(pendingTickets(h, otherRequest).length, 1);
    const otherTicket = pendingTickets(h, otherRequest)[0]!;
    const preservedOther = {
      ticket: sourceIdentity(otherTicket),
      snapshot: sourceIdentity(snapshot(otherRequest)),
    };
    const original = fs.readFileSync(primary.transcriptFile, 'utf8');
    const finalTranscript = h.transcript(primary.project, primary.label, 2);
    assert(
      finalTranscript.startsWith(original) && finalTranscript.length > original.length,
      'second turn must append to original transcript bytes'
    );
    const sourceBefore = sourceIdentity(primary.transcriptFile);
    fs.appendFileSync(primary.transcriptFile, finalTranscript.slice(original.length));
    primary.turns = 2;
    const sourceAfter = sourceIdentity(primary.transcriptFile);
    assert.equal(sourceAfter.dev, sourceBefore.dev);
    assert.equal(sourceAfter.ino, sourceBefore.ino);
    assert.notEqual(sourceAfter.sha256, sourceBefore.sha256);
    const legacyList = path.join(h.home, '.codex/.pending-plan-snapshots');
    const legacySnapshot = path.join(
      other.project,
      '.caws/plans/legacy-ownerless.transcript.jsonl'
    );
    put(legacySnapshot, 'ownerless legacy transcript bytes must remain\n');
    put(legacyList, legacySnapshot + '\n');
    const preservedLegacy = {
      list: sourceIdentity(legacyList),
      snapshot: sourceIdentity(legacySnapshot),
    };
    manifest.before = retain(h, 'before-actual-stop', checkpointRoots);
    persist();
    frozenNative();
    const host = observeClose(h.startHost());
    children.push(host);
    await h.waitFor(
      () => h.ownerEvents().find((event) => event.event === 'host_started'),
      5000,
      'owned host readiness'
    );
    frozenNative();
    const started = observeClose(h.spawnInvocation(primary, { timeoutMs: NATIVE_STOP_MS }));
    children.push(started);
    const receipt = await bounded(started.closed, STOP_CLOSE_OBSERVATION_MS, 'actual native Stop');
    manifest.caller = receipt;
    manifest.invocation = invocationEvidence(h, primary, receipt);
    h.success(receipt);
    assert.equal(receipt.signal, null);
    assert.equal(started.stdinError, null);
    const callerStderr = fs.readFileSync(path.join(receipt.directory, 'stderr.bin'), 'utf8');
    assert(
      callerStderr.includes(
        '[plan-transcript-finalize.sh] [caws plan snapshots] ' + legacyDiagnostic
      ),
      'actual Stop lacks prefixed native legacy diagnostic'
    );
    assert.deepEqual(
      fs.readFileSync(snapshot(ownRequest)),
      fs.readFileSync(primary.transcriptFile),
      'actual selected Stop did not finalize owned snapshot'
    );
    assert.equal(
      pendingTickets(h, ownRequest).length,
      0,
      'actual selected Stop did not acknowledge owned pending ticket'
    );
    assert.equal(pendingTickets(h, otherRequest).length, 1);
    sameFile(preservedOther.ticket, sourceIdentity(otherTicket), 'other repository ticket');
    sameFile(
      preservedOther.snapshot,
      sourceIdentity(snapshot(otherRequest)),
      'other repository snapshot'
    );
    sameFile(preservedLegacy.list, sourceIdentity(legacyList), 'legacy ownerless list');
    sameFile(preservedLegacy.snapshot, sourceIdentity(legacySnapshot), 'legacy ownerless snapshot');
    const turnNames = files(primary.session).filter((name) => /^turn-\d+\.json$/.test(name));
    assert.deepEqual(turnNames, ['turn-001.json', 'turn-002.json']);
    for (const [index, name] of turnNames.entries())
      assertTurn(readJson(path.join(primary.session, name)), primary, index + 1);
    assert(
      !fs.existsSync(path.join(primary.project, 'MUST-NOT-EXECUTE')),
      'transcript tool example was executed'
    );
    assert.equal(
      files(other.session).filter((name) => /^turn-\d+\.json$/.test(name)).length,
      0,
      'other repository was unexpectedly rendered'
    );
    manifest.after = retain(h, 'after-actual-stop', checkpointRoots);
    frozenNative();
    manifest.established = [
      'native CLI producer retained initial snapshot and pending provenance',
      'actual admitted sealed Stop finalized exact current transcript bytes and acknowledged only its own ticket',
      'correlated native session prefix proof, invocation selected source identity, and actual completed plan handler execution record',
      'other repository same-ID ticket and snapshot unchanged',
      'legacy ownerless carrier/snapshot preserved with actual prefixed Stop diagnostic',
      'actual renderer retained both expected Codex turn semantics',
    ];
    persist();
  } catch (error) {
    failure = error;
    manifest.error = errorText(error);
    try {
      manifest.failureBeforeCleanup = retain(h, 'failure-before-cleanup', checkpointRoots);
      const observations = path.join(h.owner, 'observations.jsonl');
      if (fs.existsSync(observations))
        put(
          path.join(h.root, 'owner-observations-before-cleanup.jsonl'),
          fs.readFileSync(observations)
        );
      persist();
    } catch (retentionError) {
      manifest.failureRetentionError = errorText(retentionError);
    }
  } finally {
    try {
      manifest.cleanup = await h.cleanup(20000);
      assert.equal(
        row(manifest.cleanup).state,
        'confirmed_inactive',
        'autonomous cleanup unavailable; sandbox retained'
      );
      for (const child of children) {
        const receipt = await bounded(child.closed, 1000, 'already inactive direct child close');
        h.success(receipt);
        assert.equal(receipt.signal, null);
        assert.equal(child.stdinError, null);
      }
      manifest.directChildCloses = children.map((child) => ({
        pid: child.started.child.pid ?? null,
        directory: child.started.directory,
        closeConfirmed: child.closeConfirmed,
        exitCode: child.started.child.exitCode,
        signalCode: child.started.child.signalCode,
      }));
      assert(
        children.every((child) => child.closeConfirmed),
        'direct child close missing'
      );
    } catch (error) {
      manifest.cleanupError = errorText(error);
      failure ??= error;
    }
    manifest.state = failure === undefined ? 'passed' : 'failed';
    manifest.endedAt = new Date().toISOString();
    persist();
    const artifactRows = files(h.root)
      .filter((name) => name !== 'artifact-manifest.json')
      .map((name) => ({
        path: name,
        bytes: fs.statSync(path.join(h.root, name)).size,
        sha256: digest(fs.readFileSync(path.join(h.root, name))),
      }));
    h.writeJson('artifact-manifest.json', artifactRows);
  }
  if (failure !== undefined) throw new Error(errorText(failure) + '\nArtifact root: ' + h.root);
  process.stdout.write(
    JSON.stringify({ state: manifest.state, root: h.root, nativeStopMs: NATIVE_STOP_MS }) + '\n'
  );
}
main().catch((error) => {
  process.stderr.write(errorText(error) + '\n');
  process.exitCode = 1;
});
