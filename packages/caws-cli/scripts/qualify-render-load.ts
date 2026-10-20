/** Actual native renderer load qualification. Never a default unit test.
 * The retained owner journal, actual native processes and rendered output are
 * independent witnesses. Diagnostic observations alone cannot establish a pass.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  createRenderHarness,
  type RenderHarness,
  type ProjectFixture,
  type SessionFixture,
  type Started,
  type Receipt,
} from './render-qualification-harness';

type Data = Record<string, unknown>;
type Sample = { at: number; operations: Data[]; beforeOperations?: Data[] };
type Operation = {
  id: string;
  key: string;
  project: string;
  session: string;
  sequence: number;
  state: string;
  request: Data;
  body: Data;
};
type Interval = { id: string; key: string; first: number; last: number };

function row(value: unknown, label = 'object'): Data {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), label);
  return value as Data;
}
function hash(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function files(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const file = path.join(directory, name),
        stat = fs.lstatSync(file);
      assert(!stat.isSymbolicLink(), 'refuse qualification symlink: ' + file);
      return stat.isDirectory() ? files(file) : stat.isFile() ? [file] : [];
    });
}
function read(file: string): Data {
  return row(JSON.parse(fs.readFileSync(file, 'utf8')), file);
}
function snapshot(harness: RenderHarness, source: string, destination: string): void {
  let total = 0;
  const selected = files(source);
  assert(selected.length <= 20000, 'bounded snapshot file count');
  const manifest = selected.map((file) => {
    const bytes = fs.readFileSync(file);
    total += bytes.length;
    assert(bytes.length <= 8 * 1024 * 1024 && total <= 256 * 1024 * 1024, 'bounded snapshot bytes');
    const name = path.relative(source, file),
      output = path.join(harness.root, destination, name);
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    fs.writeFileSync(output, bytes, { mode: 0o600 });
    return { name, sha256: hash(bytes), bytes: bytes.length };
  });
  harness.writeJson(destination + '/snapshot-manifest.json', manifest);
}
function operations(owner: string): Data[] {
  return files(path.join(owner, 'custody/operations/services'))
    .filter((file) => /\/\w{64}\.json$/.test(file))
    .map(read);
}
function decodeOperation(envelope: Data): Operation {
  const body = row(envelope.body),
    identity = row(body.identity),
    outcome = row(body.outcome);
  assert(typeof body.verifiedRequestBase64 === 'string');
  const bytes = Buffer.from(body.verifiedRequestBase64, 'base64');
  assert.equal(bytes.toString('base64'), body.verifiedRequestBase64, 'request base64');
  assert.equal(hash(bytes), body.verifiedRequestSha256, 'retained request hash');
  const request = row(JSON.parse(bytes.toString('utf8')));
  assert.equal(request.schema, 'caws.service.render.request.v1');
  assert.equal(identity.requestId, request.requestId, 'request identity');
  assert.equal(identity.projectServiceKey, request.projectServiceKey, 'project identity');
  assert.equal(identity.argumentDigest, request.argumentDigest, 'argument identity');
  assert(Array.isArray(request.arguments) && request.arguments.every((v) => typeof v === 'string'));
  const args = request.arguments as string[];
  assert.equal(hash(JSON.stringify(['caws-session-render-argv-v1', args])), request.argumentDigest);
  assert(typeof request.canonicalProject === 'string');
  assert.equal(
    request.projectServiceKey,
    hash(
      JSON.stringify(['caws-project-service-key-v1', request.canonicalProject, 'session-render'])
    ),
    'native project owner key derivation'
  );
  assert.equal(args[0], path.join(request.canonicalProject, '.caws/sessions', String(args[2])));
  assert.equal(args[1], request.canonicalProject, 'render cwd bound to canonical project');
  assert(Number.isSafeInteger(body.sequence) && Number(body.sequence) > 0);
  assert(
    ['queued', 'running', 'unknown', 'cancelled_before_dispatch', 'returned'].includes(
      String(outcome.execution)
    )
  );
  return {
    id: String(identity.requestId),
    key: String(identity.projectServiceKey),
    project: request.canonicalProject,
    session: String(args[2]),
    sequence: Number(body.sequence),
    state: String(outcome.execution),
    request,
    body,
  };
}

/** Samples can miss short transitions; they must never invent overlap or order.
 * A running record is a retained dispatch fence, not a timing event from telemetry.
 */
export function inspectSamples(samples: readonly Sample[]): Data {
  const known = new Map<string, Operation>(),
    intervals = new Map<string, Interval>();
  let concurrentProjects = 0;
  const terminal = new Set(['unknown', 'cancelled_before_dispatch', 'returned']);
  for (const sample of samples) {
    const active = new Map<string, string>();
    const beforePass = (sample.beforeOperations ?? sample.operations).map(decodeOperation);
    const afterPass = sample.operations.map(decodeOperation);
    for (const pass of [beforePass, afterPass]) {
      const sequence = new Map<string, Set<number>>(),
        present = new Set(pass.map((operation) => operation.id));
      for (const id of known.keys()) assert(present.has(id), 'retained operation disappeared');
      for (const operation of pass) {
        const before = known.get(operation.id);
        if (before) {
          assert.equal(operation.key, before.key, 'operation owner changed');
          assert.equal(operation.sequence, before.sequence, 'operation sequence changed');
          assert.equal(
            operation.body.verifiedRequestSha256,
            before.body.verifiedRequestSha256,
            'issued bytes changed'
          );
          if (terminal.has(before.state)) {
            assert.equal(operation.state, before.state, 'terminal operation regressed');
            assert.deepEqual(
              operation.body.outcome,
              before.body.outcome,
              'terminal outcome changed'
            );
          }
          if (before.state === 'running')
            assert(operation.state !== 'queued', 'dispatch regressed to queued');
        }
        known.set(operation.id, operation);
        const seen = sequence.get(operation.key) ?? new Set<number>();
        assert(!seen.has(operation.sequence), 'duplicate per-project durable sequence');
        seen.add(operation.sequence);
        sequence.set(operation.key, seen);
      }
    }
    const beforeById = new Map(beforePass.map((operation) => [operation.id, operation]));
    for (const operation of afterPass) {
      // Sequential reads alone can invent overlap: A may finish between read A
      // and read B. Stable running identities across two complete collections
      // straddle their common boundary under the journal's monotone state machine.
      if (operation.state === 'running' && beforeById.get(operation.id)?.state === 'running') {
        assert(!active.has(operation.key), 'concurrent mutation under one project owner');
        active.set(operation.key, operation.id);
        const interval = intervals.get(operation.id);
        if (interval) interval.last = sample.at;
        else
          intervals.set(operation.id, {
            id: operation.id,
            key: operation.key,
            first: sample.at,
            last: sample.at,
          });
      }
    }
    concurrentProjects = Math.max(concurrentProjects, active.size);
  }
  return {
    observedConcurrentProjects: concurrentProjects,
    observedRunningIntervals: [...intervals.values()],
    finalOperations: [...known.values()],
    sampleCount: samples.length,
    limitation:
      'Two-pass stable running fences establish bounded observed overlap under the journal state machine. Polling cannot establish every interleaving, absence of unregistered writers, or universal fairness; missed overlap is inconclusive, never a pass.',
  };
}

function envelope(id: string, project: string, sequence: number, state: string): Data {
  const args = [path.join(project, '.caws/sessions/shared-id'), project, 'shared-id'];
  const key = hash(JSON.stringify(['caws-project-service-key-v1', project, 'session-render']));
  const request = {
    schema: 'caws.service.render.request.v1',
    requestId: id,
    canonicalProject: project,
    projectServiceKey: key,
    argumentDigest: hash(JSON.stringify(['caws-session-render-argv-v1', args])),
    arguments: args,
  };
  const bytes = JSON.stringify(request);
  return {
    body: {
      identity: { requestId: id, projectServiceKey: key, argumentDigest: request.argumentDigest },
      sequence,
      verifiedRequestBase64: Buffer.from(bytes).toString('base64'),
      verifiedRequestSha256: hash(bytes),
      outcome: { execution: state },
    },
  };
}
function projectDispatchOrder(owned: readonly Operation[]): void {
  assert(owned.length > 0, 'project dispatch evidence unavailable');
  assert.equal(new Set(owned.map((operation) => operation.key)).size, 1, 'mixed project order');
  const ordered = [...owned].sort((a, b) => a.sequence - b.sequence);
  const expected = Array.from({ length: ordered.length }, (_, index) => index + 1);
  assert.deepEqual(
    ordered.map((operation) => operation.sequence),
    expected,
    'per-project durable admission sequence'
  );
  assert.deepEqual(
    ordered.map((operation) => {
      assert.equal(operation.state, 'returned', 'nonterminal or unknown render');
      const result = row(row(operation.body.outcome).result);
      assert.equal(result.kind, 'daemon_response', 'actual renderer response required');
      assert.equal(result.response, 'ok', 'actual renderer response status');
      return result.served;
    }),
    expected,
    'per-project daemon dispatch order must match durable admission sequence'
  );
}
function oracleControls(): void {
  const a = envelope('a', '/project-a', 1, 'running');
  const b = envelope('b', '/project-b', 1, 'running');
  assert.equal(inspectSamples([{ at: 0, operations: [a, b] }]).observedConcurrentProjects, 2);
  assert.throws(
    () => inspectSamples([{ at: 0, operations: [a, envelope('c', '/project-a', 2, 'running')] }]),
    /concurrent mutation/
  );
  assert.throws(
    () =>
      inspectSamples([
        { at: 0, operations: [envelope('a', '/project-a', 1, 'returned')] },
        { at: 1, operations: [a] },
      ]),
    /terminal operation regressed/
  );
  const changed = structuredClone(a);
  row(changed.body).verifiedRequestSha256 = '0'.repeat(64);
  assert.throws(() => inspectSamples([{ at: 0, operations: [changed] }]), /retained request hash/);
  const sequential = inspectSamples([
    { at: 0, operations: [a] },
    { at: 1, operations: [envelope('a', '/project-a', 1, 'returned'), b] },
  ]);
  assert.equal(
    sequential.observedConcurrentProjects,
    1,
    'sequential submissions cannot pass overlap oracle'
  );
  const nonAtomic = inspectSamples([
    {
      at: 0,
      beforeOperations: [a, envelope('b', '/project-b', 1, 'queued')],
      operations: [envelope('a', '/project-a', 1, 'returned'), b],
    },
  ]);
  assert.equal(
    nonAtomic.observedConcurrentProjects,
    0,
    'two sequential journal reads invented overlap'
  );
  assert.throws(
    () =>
      inspectSamples([
        { at: 0, operations: [a] },
        { at: 1, operations: [] },
      ]),
    /retained operation disappeared/
  );
  assert.throws(() => guardRefusal('{"decision":"allow"}'), /required guard semantic refusal/);
  assert.equal(
    guardRefusal('{"hookSpecificOutput":{"permissionDecision":"deny"}}').decision,
    'deny'
  );
  assert.equal(
    queueCapacityRefusal(
      [{ event: 'actor_queue_refused', invocationId: 'other', reason: 'queue_full' }],
      'this-invocation'
    ),
    null,
    'another invocation queue event cannot classify this failure'
  );
  assert.throws(
    () =>
      queueCapacityRefusal(
        [
          {
            event: 'actor_queue_refused',
            invocationId: 'this-invocation',
            reason: 'queue_disconnected',
          },
        ],
        'this-invocation'
      ),
    /queue-full capacity refusal/
  );
  const returned = (id: string, sequence: number, served: number): Operation => {
    const value = envelope(id, '/project-a', sequence, 'returned');
    row(row(value.body).outcome).result = { kind: 'daemon_response', response: 'ok', served };
    return decodeOperation(value);
  };
  projectDispatchOrder([returned('second', 2, 2), returned('first', 1, 1)]);
  assert.throws(
    () => projectDispatchOrder([returned('first', 1, 2), returned('second', 2, 1)]),
    /daemon dispatch order must match durable admission sequence/,
    'sorted served counters must not hide reversed per-project dispatch'
  );
  const thousand = Array.from(
    { length: 1000 },
    (_, index) => 'turn-' + String(index + 1).padStart(3, '0') + '.json'
  );
  assert.deepEqual(
    orderedTurnFiles([...thousand].sort(), 1000),
    thousand,
    'numeric ordering must preserve the 999/1000 filename boundary'
  );
  for (const [names, turns, refusal] of [
    [['turn-001.json', 'turn-001.json'], 2, /duplicate semantic turn/],
    [['turn-001.json', 'turn-003.json'], 3, /semantic turn count/],
    [['turn-001.json', 'turn-003.json'], 2, /semantic turn out of range/],
    [['turn-000.json'], 1, /semantic turn out of range/],
    [['turn-9007199254740992.json'], 1, /semantic turn out of range/],
    [['turn-invalid.json'], 1, /invalid semantic turn filename/],
    [['turn-1.json'], 1, /noncanonical semantic turn filename/],
  ] as const) {
    assert.throws(() => orderedTurnFiles(names, turns), refusal);
  }
  const subject: SemanticSubject = {
    project: { project: '/fixture/control', name: 'control' },
    session: { sessionId: 'shared-id', label: 'control' },
  };
  const semantic = {
    turn: 101,
    context: { session_id: 'shared-id', project: 'control', cwd: '/fixture/control' },
    env: { cwd: '/fixture/control' },
    user: 'control user 101',
    status: 'ok',
    timeline: [
      {
        kind: 'tool_call',
        name: 'exec_command',
        id: 'control-call-101',
        input: { cmd: 'touch MUST-NOT-EXECUTE' },
        output: 'control result 101',
      },
      { kind: 'reasoning', text: 'control assistant 101' },
    ],
  };
  assert.equal(semanticTurn(semantic, subject, 101), undefined);
  assert.throws(
    () => semanticTurn({ ...semantic, user: 'control user 1000' }, subject, 101),
    /project\/session user isolation/,
    'numeric sorting must not mask a mismatched turn payload'
  );
  assert.throws(
    () => semanticTurn({ ...semantic, timeline: [semantic.timeline[0]] }, subject, 101),
    /tool\/assistant ordering/
  );
  assert.throws(
    () =>
      semanticTurn(
        {
          ...semantic,
          timeline: [{ ...semantic.timeline[0], output: 'other result' }, semantic.timeline[1]],
        },
        subject,
        101
      ),
    /tool output identity/
  );
  for (const tool of [
    { ...semantic.timeline[0], output: 'control result 1010' },
    { ...semantic.timeline[0], output: 'other result', metadata: 'control result 101' },
  ]) {
    assert.throws(
      () => semanticTurn({ ...semantic, timeline: [tool, semantic.timeline[1]] }, subject, 101),
      /tool output identity/,
      'prefix collisions and unrelated metadata cannot establish exact tool output'
    );
  }
  for (const timeline of [
    [...semantic.timeline, { kind: 'reasoning', text: 'other-project secret' }],
    [{ kind: 'tool_call', name: 'other-tool' }, ...semantic.timeline],
    [...semantic.timeline].reverse(),
  ]) {
    assert.throws(
      () => semanticTurn({ ...semantic, timeline }, subject, 101),
      /tool\/assistant ordering/,
      'a matching pair cannot hide extra or reordered transcript entries'
    );
  }
  for (const tool of [
    { ...semantic.timeline[0], id: 'other-session-call-101' },
    { ...semantic.timeline[0], input: { cmd: 'other-session command' } },
  ]) {
    assert.throws(
      () => semanticTurn({ ...semantic, timeline: [tool, semantic.timeline[1]] }, subject, 101),
      /tool call identity|tool input identity/
    );
  }
  for (const [changed, refusal] of [
    [{ ...semantic, turn: 102 }, /semantic turn number/],
    [{ ...semantic, turn: '101' }, /semantic turn number/],
    [
      { ...semantic, context: { ...semantic.context, session_id: 'other-id' } },
      /context session isolation/,
    ],
    [
      { ...semantic, context: { ...semantic.context, project: 'other-project' } },
      /context project isolation/,
    ],
    [
      { ...semantic, context: { ...semantic.context, cwd: '/fixture/other' } },
      /context cwd isolation/,
    ],
    [{ ...semantic, env: { cwd: '/fixture/other' } }, /environment cwd isolation/],
  ] as const) {
    assert.throws(() => semanticTurn(changed, subject, 101), refusal);
  }
}

function guardRefusal(stdout: string): Data {
  const response = row(JSON.parse(stdout.trim()));
  const decision = response.decision ?? row(response.hookSpecificOutput).permissionDecision;
  assert(['block', 'ask', 'deny'].includes(String(decision)), 'required guard semantic refusal');
  return { decision, response };
}
function queueCapacityRefusal(events: readonly Data[], invocationId: string): Data | null {
  const matches = events.filter(
    (event) => event.event === 'actor_queue_refused' && event.invocationId === invocationId
  );
  assert(matches.length <= 1, 'duplicate correlated queue refusal');
  if (!matches.length) return null;
  assert.equal(matches[0]!.reason, 'queue_full', 'expected queue-full capacity refusal');
  return matches[0]!;
}

type Subject = { project: ProjectFixture; session: SessionFixture };
type SemanticSubject = {
  project: Pick<ProjectFixture, 'project' | 'name'>;
  session: Pick<SessionFixture, 'sessionId' | 'label'>;
};
type Timed = { subject: Subject; started: Started; endedAt?: number; receipt?: Receipt };
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function orderedTurnFiles(names: readonly string[], turns: number): string[] {
  assert(Number.isSafeInteger(turns) && turns > 0, 'invalid expected semantic turn count');
  const seen = new Set<number>();
  const ordered = names
    .map((file) => {
      const name = path.basename(file),
        match = /^turn-(\d+)\.json$/.exec(name);
      assert(match, 'invalid semantic turn filename: ' + name);
      const number = Number(match[1]);
      assert(
        Number.isSafeInteger(number) && number >= 1 && number <= turns,
        'semantic turn out of range: ' + name
      );
      assert.equal(
        name,
        'turn-' + String(number).padStart(3, '0') + '.json',
        'noncanonical semantic turn filename'
      );
      assert(!seen.has(number), 'duplicate semantic turn: ' + number);
      seen.add(number);
      return { file, number };
    })
    .sort((a, b) => a.number - b.number);
  assert.equal(ordered.length, turns, 'semantic turn count');
  assert.deepEqual(
    ordered.map((entry) => entry.number),
    Array.from({ length: turns }, (_, index) => index + 1),
    'semantic turns must be contiguous'
  );
  return ordered.map((entry) => entry.file);
}

function semanticTurn(turn: Data, subject: SemanticSubject, number: number): void {
  const { project, session } = subject,
    label = session.label,
    context = row(turn.context, 'semantic turn context'),
    env = row(turn.env, 'semantic turn environment');
  assert.equal(turn.turn, number, 'semantic turn number');
  assert.equal(context.session_id, session.sessionId, 'context session isolation');
  assert.equal(context.project, project.name, 'context project isolation');
  assert.equal(context.cwd, project.project, 'context cwd isolation');
  assert.equal(env.cwd, project.project, 'environment cwd isolation');
  assert.equal(turn.user, label + ' user ' + number, 'project/session user isolation');
  assert.equal(turn.status, 'ok');
  assert(Array.isArray(turn.timeline));
  const timeline = turn.timeline.map((item) => row(item));
  assert(
    timeline.length === 2 &&
      timeline[0]!.kind === 'tool_call' &&
      timeline[0]!.name === 'exec_command' &&
      timeline[1]!.kind === 'reasoning' &&
      timeline[1]!.text === label + ' assistant ' + number,
    'tool/assistant ordering: ' + label
  );
  assert.equal(timeline[0]!.id, label + '-call-' + number, 'tool call identity');
  assert.deepEqual(timeline[0]!.input, { cmd: 'touch MUST-NOT-EXECUTE' }, 'tool input identity');
  assert.equal(timeline[0]!.output, label + ' result ' + number, 'tool output identity');
}

function semanticOutput(harness: RenderHarness, subject: Subject): Data {
  const { session, project } = subject;
  const names = orderedTurnFiles(
    files(session.session).filter((file) => {
      const name = path.basename(file);
      return /^turn-.*\.json$/.test(name) && !/^turn-\d+\.payloads\.json$/.test(name);
    }),
    session.turns
  );
  const output = names.map((file, index) => {
    semanticTurn(read(file), subject, index + 1);
    return {
      name: path.basename(file),
      sha256: hash(fs.readFileSync(file)),
      bytes: fs.statSync(file).size,
    };
  });
  assert(
    !fs.existsSync(path.join(project.project, 'MUST-NOT-EXECUTE')),
    'transcript tool was executed'
  );
  harness.writeJson('outputs/' + project.name + '/' + session.sessionId + '.json', output);
  return { project: project.project, sessionId: session.sessionId, turns: session.turns, output };
}

function maximumOverlap(intervals: readonly { start: number; end: number }[]): number {
  const events = intervals.flatMap((interval) => [
    [interval.start, 1],
    [interval.end, -1],
  ]);
  events.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
  let running = 0,
    maximum = 0;
  for (const event of events) {
    running += event[1]!;
    maximum = Math.max(maximum, running);
  }
  return maximum;
}
function distribution(values: readonly number[]): Data {
  assert(values.length > 0 && values.every(Number.isFinite), 'latency measurement availability');
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    minMs: sorted[0],
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted[sorted.length - 1],
    method:
      'nearest-rank; native client spawn to observed close; includes native startup, queue and rendering',
  };
}
function register(harness: RenderHarness, subject: Subject, surface = 'codex'): void {
  const receipt = harness.run(
    'register-' + subject.project.name + '-' + subject.session.sessionId,
    process.execPath,
    [
      harness.cliEntry,
      'agents',
      'register',
      '--session-id',
      subject.session.sessionId,
      '--platform',
      surface,
      '--json',
    ],
    subject.project.project,
    {
      ...harness.env,
      CAWS_SESSION_ID: subject.session.sessionId,
      CODEX_THREAD_ID: subject.session.sessionId,
    }
  );
  harness.success(receipt);
  assert.equal(
    read(path.join(subject.project.project, '.caws/leases', subject.session.sessionId + '.json'))
      .status,
    'active',
    'actual registered lease'
  );
}
function invocation(subject: Subject): { id: string; file: string; records: Data[] } {
  const names = files(path.join(subject.session.session, 'hook-invocations')).filter((file) =>
    file.endsWith('.jsonl')
  );
  assert.equal(names.length, 1, 'one actual native invocation journal per overload session');
  const file = names[0]!,
    bytes = fs.readFileSync(file, 'utf8');
  assert(bytes.endsWith('\n'), 'incomplete invocation journal');
  const records = bytes
    .trim()
    .split('\n')
    .map((line) => row(JSON.parse(line)));
  const starts = records.filter((record) => record.stage === 'invocation_started');
  assert.equal(starts.length, 1, 'one invocation start');
  const start = starts[0]!;
  assert.equal(start.dispatch_cwd, subject.project.project);
  assert.equal(start.resolved_session_id, subject.session.sessionId);
  assert.equal(start.surface, 'codex');
  assert.equal(start.event, 'stop');
  assert(typeof start.invocation_id === 'string' && start.invocation_id.length > 0);
  assert(
    records.every((record) => record.invocation_id === start.invocation_id),
    'invocation journal identity changed'
  );
  return { id: start.invocation_id, file, records };
}

async function workload(harness: RenderHarness, baselineOnly = false): Promise<Data> {
  const subjects: Subject[] = [],
    projects: ProjectFixture[] = [];
  for (let projectIndex = 0; projectIndex < 4; projectIndex++) {
    const names = Array.from({ length: projectIndex === 0 ? 4 : 3 }, (_, index) =>
      index === 0 ? 'shared-id' : 'session-' + index
    );
    const project = await harness.createProject({
      name: 'project-' + projectIndex,
      sessions: names,
    });
    projects.push(project);
    // Configure both actual native surfaces in this private fixture. The
    // persistent reviewed renderer itself remains the admitted Codex profile.
    const policyFile = path.join(harness.home, 'state/projects', hash(project.project) + '.json');
    const policy = read(policyFile),
      surfaces = row(policy.surfaces);
    surfaces['claude-code'] = surfaces.codex;
    fs.writeFileSync(policyFile, JSON.stringify(policy) + '\n', { mode: 0o600 });
    const settings = path.join(harness.home, 'surfaces/claude-code/settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true, mode: 0o700 });
    fs.writeFileSync(settings, JSON.stringify({ version: 1, enabled: true }) + '\n', {
      mode: 0o600,
    });
    for (const sessionId of names)
      subjects.push({ project, session: harness.createSession(project, { sessionId }) });
  }
  assert.equal(subjects.length, 13);
  const samples: Sample[] = [],
    sampleObjects = new Map<string, Data>(),
    processSamples: Data[] = [];
  const tracked = new Set<number>(),
    nativeClients = new Set<number>(),
    samplingErrors: string[] = [];
  let monitor: ReturnType<typeof setInterval> | undefined;
  let lastResources = 0;
  const sample = (): void => {
    try {
      assert(samples.length < 6000, 'bounded sample capacity exhausted');
      const retain = (value: Data): Data => {
        const key = hash(JSON.stringify(value));
        if (!sampleObjects.has(key)) sampleObjects.set(key, value);
        return sampleObjects.get(key)!;
      };
      const beforeOperations = operations(harness.owner).map(retain);
      const at = Date.now();
      const values = operations(harness.owner).map(retain);
      samples.push({ at, beforeOperations, operations: values });
      if (Date.now() - lastResources >= 500) {
        lastResources = Date.now();
        const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,stat=,command='], {
          encoding: 'utf8',
          timeout: 1000,
          maxBuffer: 8 * 1024 * 1024,
        });
        assert.equal(result.status, 0, 'process resource observation');
        assert.equal(result.error, undefined, 'process resource observation error');
        assert.equal(result.stderr, '', 'process resource observation stderr');
        const inventory = result.stdout.split('\n').flatMap((line) => {
          if (!line.trim()) return [];
          const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
          assert(match, 'unparsed process resource row');
          return [
            {
              pid: Number(match[1]),
              parent: Number(match[2]),
              rssKiB: Number(match[3]),
              state: match[4]!,
              command: match[5]!,
            },
          ];
        });
        let progress = true;
        while (progress) {
          progress = false;
          for (const process of inventory)
            if (tracked.has(process.parent) && !tracked.has(process.pid)) {
              tracked.add(process.pid);
              progress = true;
            }
        }
        const selected = inventory.filter(
          (process) => tracked.has(process.pid) || process.command.includes(harness.sandbox)
        );
        processSamples.push({
          at: Date.now(),
          processes: selected,
          count: selected.length,
          nativeClientCount: selected.filter(
            (process) => nativeClients.has(process.pid) && !process.state.startsWith('Z')
          ).length,
          rssKiB: selected.reduce((sum, process) => sum + process.rssKiB, 0),
        });
      }
    } catch (error) {
      samplingErrors.push(String(error));
    }
  };
  const begin = (subject: Subject, guard = false, index = 0): Timed => {
    const started = harness.spawnInvocation(
      subject.project,
      guard
        ? {
            sessionId: subject.session.sessionId,
            surface: index % 2 === 0 ? 'codex' : 'claude-code',
            event: 'pre_tool_use',
            input: {
              cwd: subject.project.project,
              session_id: subject.session.sessionId,
              tool_name: 'Bash',
              tool_input: { command: 'git reset --hard' },
            },
          }
        : { sessionId: subject.session.sessionId }
    );
    if (started.child.pid) {
      tracked.add(started.child.pid);
      nativeClients.add(started.child.pid);
    }
    const value: Timed = { subject, started };
    void started.done.then((receipt) => {
      value.endedAt = Date.now();
      value.receipt = receipt;
    });
    return value;
  };
  const finish = async (jobs: Timed[]): Promise<void> => {
    const deadline = Date.now() + 40000;
    while (jobs.some((job) => !job.receipt) && Date.now() < deadline) await pause(20);
    if (jobs.some((job) => !job.receipt)) {
      for (const job of jobs) if (!job.receipt) job.started.child.unref();
      throw new Error(
        'native client exit unconfirmed at qualification deadline; preserve and stop'
      );
    }
  };
  const result: Data = {
    subjects: subjects.map((subject) => ({ project: subject.project.project, ...subject.session })),
  };
  try {
    for (const subject of subjects) register(harness, subject);
    monitor = setInterval(sample, 25);
    sample();
    // Every native client is started before awaiting any response. Durable
    // running-state overlap separately falsifies a merely sequential workload.
    const burst = subjects.map((subject) => begin(subject));
    lastResources = 0;
    sample();
    const clientIdentities = burst.map((job) => ({
      project: job.subject.project.project,
      sessionId: job.subject.session.sessionId,
      pid: job.started.child.pid,
      observation: job.started.child.pid
        ? harness.observe(job.started.child.pid)
        : { state: 'not_spawned' },
    }));
    harness.writeJson('native-client-identities.json', clientIdentities);
    for (const witness of clientIdentities) {
      assert.equal(
        witness.observation.state,
        'observed',
        'native client kernel birth identity unavailable'
      );
      const observed = row(witness.observation.process);
      assert.equal(observed.pid, witness.pid);
      assert.equal(observed.zombie, false);
      assert(
        typeof observed.startSeconds === 'string' && typeof observed.startMicros === 'string',
        'native client birth coordinates'
      );
    }
    await finish(burst);
    sample();
    result.concurrentBurst = burst.map((job) => ({
      project: job.subject.project.project,
      sessionId: job.subject.session.sessionId,
      start: job.started.startedAt,
      end: job.endedAt,
      receipt: job.receipt,
    }));
    result.perProjectLatency = projects.map((project) => ({
      project: project.project,
      distribution: distribution(
        burst
          .filter((job) => job.subject.project === project)
          .map((job) => job.endedAt! - job.started.startedAt)
      ),
    }));
    result.perSessionLatency = burst.map((job) => ({
      project: job.subject.project.project,
      sessionId: job.subject.session.sessionId,
      latencyMs: job.endedAt! - job.started.startedAt,
    }));
    result.maximumNativeClientOverlap = maximumOverlap(
      burst.map((job) => ({ start: job.started.startedAt, end: job.endedAt! }))
    );
    assert.equal(result.maximumNativeClientOverlap, 13, 'thirteen native clients did not overlap');
    result.observedNativeClientOverlap = Math.max(
      ...processSamples.map((sample) => Number(sample.nativeClientCount))
    );
    assert.equal(
      result.observedNativeClientOverlap,
      13,
      'thirteen live native client processes were not independently observed'
    );
    for (const job of burst) harness.success(job.receipt!);
    for (const subject of subjects)
      assert.equal(
        read(
          path.join(subject.project.project, '.caws/leases', subject.session.sessionId + '.json')
        ).status,
        'stopped',
        'actual stock Stop lease transition isolated by project/session'
      );
    const burstAnalysis = inspectSamples(samples);
    result.concurrentAnalysis = burstAnalysis;
    assert(
      Number(burstAnalysis.observedConcurrentProjects) >= 2,
      'independent actual render overlap not observed'
    );
    result.semanticOutputs = subjects.map((subject) => semanticOutput(harness, subject));
    const first = operations(harness.owner).map(decodeOperation);
    assert.equal(first.length, 13, 'missing/duplicate owner operations');
    for (const project of projects) {
      const owned = first.filter((operation) => operation.project === project.project);
      projectDispatchOrder(owned);
    }
    assert.equal(samplingErrors.length, 0, 'sampling uncertainty: ' + samplingErrors.join('; '));
    assert(
      !harness
        .ownerEvents()
        .some((event) =>
          [
            'worker_failure',
            'worker_cleanup_deadline',
            'worker_control_unavailable',
            'actor_error',
          ].includes(String(event.event))
        ),
      'baseline owner lifecycle uncertainty; preserve and stop before further scenario'
    );
    if (baselineOnly) return result;
    // A genuine regular transcript supplies bounded slow work without replacing
    // the reviewed interpreter, daemon, renderer, or a production scheduler.
    const hot = {
      project: projects[0]!,
      session: harness.createSession(projects[0]!, {
        sessionId: 'slow-session',
        turns: 1000,
        label: 'slow-project-0',
      }),
    };
    register(harness, hot);
    const peers = projects.slice(1).map((project) => ({
      project,
      session: harness.createSession(project, {
        sessionId: 'peer-progress',
        label: project.name + '-peer',
      }),
    }));
    for (const peer of peers) register(harness, peer);
    const hotJob = begin(hot),
      hotStart = samples.length;
    await harness.waitFor(
      () =>
        operations(harness.owner)
          .map(decodeOperation)
          .find(
            (operation) =>
              operation.session === hot.session.sessionId && operation.state === 'running'
          ),
      30000,
      'actual slow renderer durable dispatch'
    );
    const guardJobs = subjects.map((subject, index) => begin(subject, true, index));
    const peerJobs = peers.map((subject) => begin(subject));
    await finish([...guardJobs, ...peerJobs, hotJob]);
    sample();
    harness.success(hotJob.receipt!);
    for (const peer of peerJobs) harness.success(peer.receipt!);
    for (const guard of guardJobs) {
      assert.equal(guard.receipt!.error, null);
      assert.equal(guard.receipt!.code, 2, 'required guard refusal exit');
      const stdout = fs.readFileSync(path.join(guard.receipt!.directory, 'stdout.bin'), 'utf8');
      guardRefusal(stdout);
    }
    const slowAnalysis = inspectSamples(samples.slice(hotStart));
    const intervals = slowAnalysis.observedRunningIntervals as Interval[];
    const hotOperation = operations(harness.owner)
      .map(decodeOperation)
      .find((operation) => operation.session === hot.session.sessionId);
    assert(hotOperation);
    const hotInterval = intervals.find((interval) => interval.id === hotOperation.id);
    assert(hotInterval, 'slow running interval unavailable');
    const idleMs = Number(row(harness.ownerConfig.limits).idleMs);
    assert(
      hotInterval.last - hotInterval.first > idleMs,
      'slow work did not cross idle eligibility; no in-flight retention claim'
    );
    assert(
      peerJobs.every((job) => job.endedAt! < hotInterval.last),
      'all three other repositories must complete before a later hot running witness'
    );
    assert(
      guardJobs.every((job) => job.endedAt! < hotInterval.last),
      'all thirteen mixed-harness guard refusals must complete before a later hot running witness'
    );
    result.slowWork = {
      analysis: slowAnalysis,
      hot: { start: hotJob.started.startedAt, end: hotJob.endedAt, receipt: hotJob.receipt },
      guardRoute:
        'actual native invocation through the selected compatibility guard chain; CAWS_TRAP_KILL=0; no typed fastpath or interpreter fan-out removal claim',
      peers: peerJobs.map((job) => ({
        start: job.started.startedAt,
        end: job.endedAt,
        receipt: job.receipt,
      })),
      guards: guardJobs.map((job, index) => ({
        surface: index % 2 === 0 ? 'codex' : 'claude-code',
        start: job.started.startedAt,
        end: job.endedAt,
        receipt: job.receipt,
      })),
      idleMs,
      outputs: [
        semanticOutput(harness, hot),
        ...peers.map((subject) => semanticOutput(harness, subject)),
      ],
    };
    assert.equal(samplingErrors.length, 0, 'sampling uncertainty: ' + samplingErrors.join('; '));
    result.allSamplesAnalysis = inspectSamples(samples);
    return result;
  } finally {
    if (monitor) clearInterval(monitor);
    const objects: Data = {};
    for (const [key, value] of sampleObjects) objects[key] = value;
    harness.writeJson('journal-sample-objects.json', objects);
    harness.writeJson(
      'journal-samples.json',
      samples.map((value) => ({
        at: value.at,
        beforeOperations: value.beforeOperations?.map((operation) =>
          hash(JSON.stringify(operation))
        ),
        operations: value.operations.map((operation) => hash(JSON.stringify(operation))),
      }))
    );
    harness.writeJson('resource-samples.json', processSamples);
    harness.writeJson('sampling-errors.json', samplingErrors);
    harness.writeJson('workload.json', result);
    for (const project of projects) {
      snapshot(
        harness,
        path.join(project.project, '.caws/sessions'),
        'snapshots/' + project.name + '/sessions'
      );
      snapshot(
        harness,
        path.join(project.project, '.caws/leases'),
        'snapshots/' + project.name + '/leases'
      );
    }
  }
}

async function overloadWorkload(harness: RenderHarness): Promise<Data> {
  const hotProject = await harness.createProject({
    name: 'hot-project',
    sessions: Array.from({ length: 13 }, (_, index) => 'overload-' + index),
  });
  const hot = Array.from({ length: 13 }, (_, index) => ({
    project: hotProject,
    session: harness.createSession(hotProject, {
      sessionId: 'overload-' + index,
      turns: 1000,
      label: 'overload-' + index,
    }),
  }));
  const peers: Subject[] = [];
  for (let index = 1; index <= 3; index++) {
    const project = await harness.createProject({ name: 'peer-' + index });
    peers.push({ project, session: project });
  }
  const subjects = [...hot, ...peers];
  for (const subject of subjects) register(harness, subject);
  const result: Data = {
    maxQueuePerProject: row(harness.ownerConfig.limits).maxQueuePerProject,
    subjects: subjects.map((subject) => ({ project: subject.project.project, ...subject.session })),
  };
  const samples: Sample[] = [],
    errors: string[] = [];
  const sample = (): void => {
    try {
      const beforeOperations = operations(harness.owner);
      samples.push({ at: Date.now(), beforeOperations, operations: operations(harness.owner) });
    } catch (error) {
      errors.push(String(error));
    }
  };
  const monitor = setInterval(sample, 50);
  try {
    const jobs = subjects.map((subject) => ({
      subject,
      started: harness.spawnInvocation(subject.project, { sessionId: subject.session.sessionId }),
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const receipts = await Promise.race([
      Promise.all(
        jobs.map(async (job) => ({ receipt: await job.started.done, endedAt: Date.now() }))
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          for (const job of jobs) job.started.child.unref();
          reject(new Error('bounded overload client exits unconfirmed; preserve and stop'));
        }, 40000);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    sample();
    result.requests = jobs.map((job, index) => ({
      project: job.subject.project.project,
      sessionId: job.subject.session.sessionId,
      start: job.started.startedAt,
      ...receipts[index],
    }));
    const all = operations(harness.owner).map(decodeOperation);
    assert(
      all.every((operation) => operation.state === 'returned'),
      'overload left unknown/running/queued effects'
    );
    const refusals: Data[] = [],
      ownerEvents = harness.ownerEvents();
    for (let index = 0; index < jobs.length; index++) {
      const job = jobs[index]!,
        receipt = receipts[index]!.receipt;
      assert.equal(receipt.error, null, 'overload process execution uncertainty');
      const owned = all.filter(
        (operation) =>
          operation.project === job.subject.project.project &&
          operation.session === job.subject.session.sessionId
      );
      assert(owned.length <= 1, 'overload replayed one invocation');
      const journal = invocation(job.subject),
        refused = queueCapacityRefusal(ownerEvents, journal.id);
      if (refused) {
        // The existing Stop contract releases a configuration failure before
        // any dispatch grant. Exit zero alone therefore cannot mean rendering.
        assert.equal(receipt.code, 0, 'pre-dispatch Stop capacity denial release exit');
        assert.equal(owned.length, 0, 'refused request retained an effect');
        assert.equal(
          files(job.subject.session.session).filter((file) => /\/turn-\d+\.json$/.test(file))
            .length,
          0,
          'refused request wrote through fallback'
        );
        assert(
          !journal.records.some((record) =>
            ['dispatch_started', 'dispatch_completed', 'compatibility_dispatch_completed'].includes(
              String(record.stage)
            )
          ),
          'capacity-denied invocation received a dispatch grant'
        );
        assert.equal(
          fs.readFileSync(path.join(receipt.directory, 'stdout.bin'), 'utf8'),
          '',
          'pre-dispatch Stop denial stdout'
        );
        const stderr = fs.readFileSync(path.join(receipt.directory, 'stderr.bin'), 'utf8');
        assert.equal(
          stderr,
          'CAWS native infrastructure failure (configuration): renderer owner peer EOF. Checks did not complete; request was not retried.\n',
          'expected pre-dispatch owner EOF stage; unrelated admission/timeout/cleanup failures do not count as overload'
        );
        refusals.push({
          project: job.subject.project.project,
          sessionId: job.subject.session.sessionId,
          receipt,
          invocationId: journal.id,
          journal: journal.file,
          ownerRefusal: refused,
        });
      } else {
        harness.success(receipt);
        assert.equal(
          owned.length,
          1,
          'successful overload request did not retain actual renderer result'
        );
        assert.equal(
          owned[0]!.request.invocationId,
          journal.id,
          'owner result belongs to another native invocation'
        );
        semanticOutput(harness, job.subject);
      }
    }
    assert(refusals.length > 0, 'no actual bounded-overload refusal observed');
    const queueRefusals = ownerEvents.filter((event) => event.event === 'actor_queue_refused');
    assert.equal(queueRefusals.length, refusals.length, 'unmatched owner queue refusal');
    const analysis = inspectSamples(samples),
      hotKey = hash(
        JSON.stringify(['caws-project-service-key-v1', hotProject.project, 'session-render'])
      );
    const running = (analysis.observedRunningIntervals as Interval[]).filter(
      (interval) => interval.key === hotKey
    );
    assert(running.length > 0, 'hot project running witness unavailable');
    const hotWitness = Math.max(...running.map((interval) => interval.last));
    for (let index = 13; index < jobs.length; index++) {
      harness.success(receipts[index]!.receipt);
      assert(
        receipts[index]!.endedAt < hotWitness,
        'peer must complete before a later durable hot-project running witness'
      );
    }
    result.analysis = analysis;
    result.refusals = refusals;
    result.ownerQueueRefusalObservations = queueRefusals;
    assert.equal(errors.length, 0, 'overload sampler uncertainty');
    return result;
  } finally {
    clearInterval(monitor);
    // Unique retained states plus reference samples keep the artifact bounded
    // without discarding the observed journal transition history.
    const objects = new Map<string, Data>();
    const retain = (value: Data): string => {
      const key = hash(JSON.stringify(value));
      objects.set(key, value);
      return key;
    };
    const references = samples.map((sample) => ({
      at: sample.at,
      beforeOperations: sample.beforeOperations?.map(retain),
      operations: sample.operations.map(retain),
    }));
    harness.writeJson('journal-sample-objects.json', Object.fromEntries(objects));
    harness.writeJson('journal-samples.json', references);
    harness.writeJson('sampling-errors.json', errors);
    harness.writeJson('workload.json', result);
    for (const project of [hotProject, ...peers.map((peer) => peer.project)])
      snapshot(
        harness,
        path.join(project.project, '.caws/sessions'),
        'snapshots/' + project.name + '/sessions'
      );
  }
}

async function main(): Promise<void> {
  assert(
    process.argv[2] && process.argv[3],
    'Usage: qualify-render-load.js <built-cli-root> <sterling-root> [baseline|concurrent|overload]'
  );
  const mode = process.argv[4] ?? 'concurrent';
  assert(['baseline', 'concurrent', 'overload'].includes(mode), 'unknown load mode');
  oracleControls();
  const harness = await createRenderHarness({
    cli: process.argv[2],
    sterling: process.argv[3],
    label: 'render-load-' + mode,
    limits: mode === 'overload' ? { maxQueuePerProject: 2 } : { idleMs: 250 },
  });
  const manifest: Data = {
    schema: 'caws.qualification.render-load.v1',
    state: 'running',
    root: harness.root,
    mode,
    declaredWorkload: {
      repositories: 4,
      concurrentRendererSessions: mode === 'overload' ? 16 : 13,
      rendererSurface: 'codex',
      additionalGuardSurfaces: mode === 'concurrent' ? ['codex', 'claude-code'] : [],
      normalNativeDeadlineMs: 30000,
      qualificationObservationDeadlineMs: 40000,
    },
    qualifierSha256: hash(
      fs.readFileSync(path.join(harness.cli, 'scripts/qualify-render-load.ts'))
    ),
    nonclaims: [
      'machine adoption',
      'production guard/PID parity',
      'persistent renderer for non-Codex surfaces',
      'first-party guard interpreter fan-out removal',
      'full A8 acceptance',
      'generation upgrade/drain',
      'heartbeat expiry',
      ...(mode !== 'overload' ? ['bounded overload until separate overload scenario'] : []),
      ...(mode === 'baseline' ? ['slow writer fairness/required capacity/idle retention'] : []),
      'global fairness beyond this declared workload',
      '100ms warm latency target',
    ],
  };
  harness.writeJson('manifest.json', manifest);
  try {
    manifest.workload =
      mode === 'overload'
        ? await overloadWorkload(harness)
        : await workload(harness, mode === 'baseline');
    manifest.state = 'observed';
  } catch (error) {
    manifest.state = 'failed';
    manifest.error = error instanceof Error ? error.stack : String(error);
    process.exitCode = 1;
  } finally {
    manifest.cleanup = await harness.cleanup();
    if (row(manifest.cleanup).state !== 'confirmed_inactive') {
      manifest.state = 'cleanup_unconfirmed';
      process.exitCode = 1;
    }
    manifest.endedAt = new Date().toISOString();
    const observationFile = path.join(harness.owner, 'observations.jsonl');
    if (fs.existsSync(observationFile)) {
      const bytes = fs.readFileSync(observationFile, 'utf8');
      harness.writeJson(
        'owner-stage-timing-observations.json',
        bytes
          .slice(0, bytes.lastIndexOf('\n') + 1)
          .split('\n')
          .filter(Boolean)
          .map((line) => row(JSON.parse(line)))
      );
    }
    harness.writeJson('manifest.json', manifest);
    const artifacts = files(harness.root)
      .filter((file) => path.basename(file) !== 'artifact-manifest.json')
      .map((file) => ({
        path: path.relative(harness.root, file),
        sha256: hash(fs.readFileSync(file)),
        bytes: fs.statSync(file).size,
      }));
    harness.writeJson('artifact-manifest.json', artifacts);
    console.log(
      JSON.stringify({ root: harness.root, state: manifest.state, error: manifest.error ?? null })
    );
  }
}
if (require.main === module) {
  if (process.argv[2] === '--self-test') {
    oracleControls();
    console.log('Load oracle hostile controls passed; no production workload was executed.');
  } else
    void main().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
