/** Actual owner-boundary controls. This does not execute the compatibility prefix. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import { createRequire } from 'node:module';
import {
  createRenderHarness,
  digest,
  files,
  pause,
  put,
  readJson,
  row,
  writeJson,
  type Data,
  type ProjectFixture,
  type RenderHarness,
  type SessionFixture,
} from './render-qualification-harness';
import type { ServiceRenderGrant } from '../dist/runtime/service-client';
import type { RenderRequest } from '../dist/runtime/service-protocol';

assert(process.argv[2] && process.argv[3], 'CLI and Sterling source roots required');
const cli = fs.realpathSync(process.argv[2]!);
const sterling = fs.realpathSync(process.argv[3]!);
const requested = process.argv[4] ?? 'all';
const scenarioNames = [
  'fifo',
  'same-session',
  'case-alias',
  'generation',
  'framing',
  'reader-expiry',
  'serial',
];
assert(requested === 'all' || scenarioNames.includes(requested), 'unknown pending scenario');
const REQUEST_MS = 30000;
const root = path.resolve(
  cli,
  '../caws-native/target/qualification',
  'render-pending-' + new Date().toISOString().replace(/[:.]/g, '-')
);
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const requireApi = createRequire(path.join(cli, 'package.json'));
const client = requireApi(
  path.join(cli, 'dist/runtime/service-client')
) as typeof import('../dist/runtime/service-client');
const protocol = requireApi(
  path.join(cli, 'dist/runtime/service-protocol')
) as typeof import('../dist/runtime/service-protocol');
const results: Data[] = [];
const manifest: Data = {
  schema: 'caws.qualification.render-pending.v1',
  state: 'running',
  root,
  startedAt: new Date().toISOString(),
  requestBudgetMs: REQUEST_MS,
  claim: 'actual owner admission, prepared scheduling, framing and ordered renderer effects',
  nonclaims: [
    'compatibility prefix execution',
    'thirteen native-client overlap',
    'installed machine adoption',
    'complete harness replacement',
  ],
  source: {
    path: path.join(cli, 'scripts/qualify-render-pending.ts'),
    sha256: digest(fs.readFileSync(path.join(cli, 'scripts/qualify-render-pending.ts'))),
  },
  executable: { path: process.argv[1], sha256: digest(fs.readFileSync(process.argv[1]!)) },
  scenarios: results,
};
function persist(): void {
  writeJson(path.join(root, 'manifest.json'), manifest);
  writeJson(
    path.resolve(cli, '../caws-native/target/qualification/render-pending-latest.json'),
    manifest
  );
}
function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
async function bounded<T>(promise: Promise<T>, deadline: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('deadline: ' + label)),
          Math.max(1, deadline - Date.now())
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function event(h: RenderHarness, kind: string, id: string): Data | undefined {
  return h.ownerEvents().find((value) => value.event === kind && value.invocationId === id);
}
async function waitEvent(
  h: RenderHarness,
  kind: string,
  id: string,
  deadline: number
): Promise<Data> {
  return h.waitFor(() => event(h, kind, id), Math.max(1, deadline - Date.now()), kind + ':' + id);
}
function requestId(fixture: ProjectFixture, id: string): string {
  const selection = row(row(row(fixture.image).manifest).selection);
  return protocol.renderRequestId(id, Number(selection.selectedIndex));
}
function operation(h: RenderHarness, id: string, observations = h.operations()): Data | undefined {
  return observations
    .map((value) => {
      const body = row(value.body);
      assert.equal(
        digest(JSON.stringify(body)),
        value.bodySha256,
        'retained operation digest mismatch'
      );
      return body;
    })
    .find((body) => row(body.identity).requestId === id);
}
function assertNoEffect(
  h: RenderHarness,
  fixture: ProjectFixture,
  id: string,
  session: SessionFixture
): void {
  assert.equal(
    operation(h, requestId(fixture, id)),
    undefined,
    'withdrawn/unready caller entered renderer journal'
  );
  assert.equal(
    files(session.session).filter((name) => /^turn-\d+\.json$/.test(name)).length,
    0,
    'unattempted caller wrote a rendered turn'
  );
}
function assertTurn(session: SessionFixture, checkout: string): Data {
  const names = files(session.session).filter((name) => /^turn-\d+\.json$/.test(name));
  assert.deepEqual(names, ['turn-001.json']);
  const turn = readJson(path.join(session.session, names[0]!));
  assert.equal(turn.schema_version, 2);
  assert.equal(turn.status, 'ok');
  assert.equal(turn.turn, 1);
  assert.equal(turn.user, session.label + ' user 1');
  assert.equal(row(turn.context).session_id, session.sessionId);
  assert.equal(row(turn.context).cwd, checkout);
  assert.equal(row(turn.context).model, 'owner-fixture-model');
  return turn;
}

class OwnerPeer {
  readonly socket: net.Socket;
  readonly directory: string;
  readonly startedAt = Date.now();
  readonly deadline = this.startedAt + REQUEST_MS;
  readonly frames: Buffer[] = [];
  private pending: Buffer = Buffer.alloc(0);
  private receivedBytes = 0;
  private failure: Error | undefined;
  private ended = false;
  private closed = false;
  prepared: Data | undefined;
  grant: ServiceRenderGrant | undefined;
  request: RenderRequest | undefined;

  constructor(
    readonly h: RenderHarness,
    readonly fixture: ProjectFixture,
    readonly session: SessionFixture,
    readonly id: string,
    readonly checkout = fixture.project
  ) {
    this.directory = path.join(h.root, 'wire', id);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const socketPath = path.join(
      '/private/tmp',
      'caws-render-' + process.getuid?.() + '-' + digest(h.home).slice(0, 24),
      'owner.sock'
    );
    this.socket = net.createConnection({ path: socketPath, allowHalfOpen: true });
    this.socket.on('data', (chunk: Buffer) => {
      fs.appendFileSync(path.join(this.directory, 'received.bin'), chunk, { mode: 0o600 });
      this.receivedBytes += chunk.length;
      if (this.receivedBytes > 2 * 1024 * 1024 + client.MAX_SERVICE_BRIDGE_REPLY_BYTES + 1) {
        this.failure = new Error('owner wire byte bound exceeded');
        this.socket.destroy();
        return;
      }
      this.pending = Buffer.concat([this.pending, chunk]);
      for (let index = this.pending.indexOf(10); index >= 0; index = this.pending.indexOf(10)) {
        this.frames.push(Buffer.from(this.pending.subarray(0, index + 1)));
        this.pending = Buffer.from(this.pending.subarray(index + 1));
      }
      if (this.frames.length > 2) {
        this.failure = new Error('unsolicited owner frames');
        this.socket.destroy();
      }
    });
    this.socket.on('error', (error) => {
      this.failure = error;
      this.record('error', { error: describe(error) });
    });
    this.socket.on('end', () => {
      this.ended = true;
      this.record('read_eof');
    });
    this.socket.on('close', (hadError) => {
      this.closed = true;
      this.record('close', { hadError });
    });
  }
  private record(stage: string, extra: Data = {}): void {
    fs.appendFileSync(
      path.join(this.directory, 'transport.jsonl'),
      JSON.stringify({ at: Date.now(), id: this.id, stage, ...extra }) + '\n',
      { mode: 0o600 }
    );
  }
  private check(): void {
    if (this.failure) throw this.failure;
  }
  async send(bytes: Buffer): Promise<void> {
    this.check();
    fs.appendFileSync(path.join(this.directory, 'sent.bin'), bytes, { mode: 0o600 });
    this.record('write_attempt', { bytes: bytes.length, sha256: digest(bytes) });
    await bounded(
      new Promise<void>((resolve, reject) => {
        this.socket.write(bytes, (error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
      this.deadline,
      'owner write:' + this.id
    );
  }
  async offer(): Promise<void> {
    await bounded(
      new Promise<void>((resolve, reject) => {
        this.socket.once('connect', resolve);
        this.socket.once('error', reject);
      }),
      this.deadline,
      'owner connect:' + this.id
    );
    const image = row(this.fixture.image),
      manifestImage = row(image.manifest);
    const stage =
      typeof image.stagingRoot === 'string' && fs.existsSync(image.stagingRoot)
        ? image.stagingRoot
        : null;
    const policy = path.join(
      this.h.home,
      'state/projects',
      digest(this.fixture.project),
      'render-service.json'
    );
    const offer = {
      schema: 'caws.render.owner.offer.v1',
      prepared: { ...image, stagingRoot: stage },
      expectedSelection: manifestImage.selection,
      policySha256: digest(fs.readFileSync(policy)),
      checkout: this.checkout,
      sessionId: this.session.sessionId,
      invocationId: this.id,
      callerEnvironment: this.h.env,
      remainingBudgetMs: REQUEST_MS,
    };
    writeJson(path.join(this.directory, 'offer.json'), offer);
    this.record('offer', { deadline: this.deadline, budgetMs: REQUEST_MS });
    await this.send(Buffer.from(JSON.stringify(offer) + '\n'));
  }
  async receivePrepared(mode: 'session' | 'serial' = 'session'): Promise<Data> {
    const frame = await this.h.waitFor(
      () => {
        this.check();
        const next = this.frames.shift();
        if (next) return next;
        assert(!this.ended && !this.closed, 'owner closed before Prepared:' + this.id);
        return undefined;
      },
      Math.max(1, this.deadline - Date.now()),
      'Prepared:' + this.id
    );
    const prepared = row(JSON.parse(frame.toString('utf8')));
    assert.equal(prepared.schema, 'caws.render.owner.prepared.v1');
    assert.equal(row(prepared.image).imageDigest, row(this.fixture.image).imageDigest);
    this.grant = client.decodeServiceGrant(JSON.stringify(prepared.grant));
    assert.equal(this.grant.invocationId, this.id);
    assert.equal(this.grant.canonicalProject, this.fixture.project);
    assert.equal(row(prepared.gitView).gitWorkTree, this.checkout);
    assert(Number.isSafeInteger(prepared.backendPid) && Number(prepared.backendPid) > 0);
    assert.equal(this.h.observe(Number(prepared.backendPid)).state, 'observed');
    assert(fs.existsSync(String(row(prepared.gitView).gitDirectory)), 'prepared Git view absent');
    const disposition = await waitEvent(this.h, 'prefix_disposition', this.id, this.deadline);
    assert.equal(disposition.mode, mode, 'actual admitted prefix has wrong native disposition');
    if (mode === 'session') assert.equal(disposition.proofProfile, 'codex-stop-session-prefix-v1');
    else assert.equal(disposition.reason, 'unreviewed_prefix');
    this.prepared = prepared;
    writeJson(path.join(this.directory, 'prepared.json'), prepared);
    writeJson(
      path.join(this.directory, 'prepared-identity.json'),
      this.h.observe(Number(prepared.backendPid))
    );
    return prepared;
  }
  bridgeFrame(): Buffer {
    assert(this.grant && this.prepared, 'bridge requires issued Prepared grant');
    this.request = client.makeServiceRenderRequest(this.grant, [
      this.grant.hooksDirectory,
      this.grant.leaseFile,
      this.session.session,
      this.checkout,
      this.session.sessionId,
      '2026-10-01T12:00:00Z',
      'owner-fixture-model',
      'main',
      'fixture',
      '0',
      'fixture',
      this.session.transcriptFile,
      path.join(this.session.session, 'tool-audit.jsonl'),
      path.join(this.session.session, 'hook-outcome.jsonl'),
    ]);
    writeJson(path.join(this.directory, 'request.json'), this.request);
    return client.encodeServiceBridgeRequest(this.grant, this.request);
  }
  async dispatch(halfClose = true): Promise<void> {
    await this.send(this.bridgeFrame());
    if (halfClose) {
      this.record('write_half_close');
      this.socket.end();
    }
  }
  async reply(served: number): Promise<Data> {
    assert(this.grant && this.request);
    await this.h.waitFor(
      () => {
        this.check();
        return this.ended || this.closed;
      },
      Math.max(1, this.deadline - Date.now()),
      'owner reply EOF:' + this.id
    );
    this.check();
    assert(this.ended, 'close without required reply EOF');
    assert.equal(this.pending.length, 0, 'trailing reply fragment');
    assert.equal(this.frames.length, 1, 'owner did not return one complete reply');
    const frame = this.frames.shift()!;
    put(path.join(this.directory, 'reply.bin'), frame);
    const reply = client.decodeServiceBridgeReply(frame, this.grant, this.request);
    writeJson(path.join(this.directory, 'reply.json'), reply);
    const observations = this.h.operations();
    writeJson(path.join(this.directory, 'operation-observations.json'), observations);
    const id = this.request.requestId;
    const observed = observations.find((value) => row(row(value.body).identity).requestId === id);
    writeJson(path.join(this.directory, 'operation.json'), observed?.body ?? null);
    const op = operation(this.h, id, observations);
    const outcome = reply.outcome.outcome;
    assert(outcome.admission === 'accepted', 'owner rejected renderer admission');
    assert(outcome.execution === 'returned', 'owner did not return a completed renderer effect');
    const result = outcome.result;
    assert(result.kind === 'daemon_response', 'owner did not return a daemon response');
    assert.equal(result.response, 'ok');
    assert.equal(result.served, served);
    assert.equal(result.cached, false);
    assert(op, 'reply lacks retained operation');
    assert.equal(row(op.outcome).execution, 'returned');
    assert.deepEqual(
      JSON.parse(Buffer.from(String(op.verifiedRequestBase64), 'base64').toString('utf8')),
      this.request
    );
    writeJson(path.join(this.directory, 'turn.json'), assertTurn(this.session, this.checkout));
    return op;
  }
  async remoteEof(): Promise<void> {
    await this.h.waitFor(
      () => this.ended || this.closed,
      REQUEST_MS,
      'withdrawn owner EOF:' + this.id
    );
  }
  assertNoPreparedBytes(): void {
    this.check();
    assert.equal(this.receivedBytes, 0, 'barrier caller received premature owner bytes');
    assert.equal(this.frames.length, 0);
    assert.equal(this.prepared, undefined);
    this.record('barrier_no_prepared_bytes', { receivedBytes: this.receivedBytes });
  }
  destroy(): void {
    this.record('local_full_disconnect');
    this.socket.destroy();
  }
}

type Context = {
  h: RenderHarness;
  fixture: ProjectFixture;
  peers: OwnerPeer[];
  open: (id: string, session: SessionFixture, checkout?: string) => Promise<OwnerPeer>;
};
function secondSession(h: RenderHarness, fixture: ProjectFixture): SessionFixture {
  return h.createSession(fixture, { sessionId: 'other-session' });
}
async function fifo({ h, fixture, open }: Context): Promise<void> {
  const a = await open('fifo-first', fixture);
  await a.receivePrepared();
  const other = secondSession(h, fixture);
  const b = await open('fifo-second', other);
  await b.receivePrepared();
  assert.equal(
    a.prepared!.backendPid,
    b.prepared!.backendPid,
    'compatible callers did not share backend'
  );
  await b.dispatch();
  await h.waitFor(
    () =>
      h
        .ownerEvents()
        .find(
          (value) =>
            value.event === 'actor_stage' &&
            value.invocationId === b.id &&
            value.stage === 'bridge_received'
        ),
    REQUEST_MS,
    'later bridge arrival'
  );
  assertNoEffect(h, fixture, a.id, fixture);
  assertNoEffect(h, fixture, b.id, other);
  await a.dispatch();
  const first = await a.reply(1),
    second = await b.reply(2);
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  const dispatches = h.ownerEvents().filter((value) => value.event === 'journal_dispatch');
  assert.deepEqual(
    dispatches.map((value) => value.requestId),
    [a.request!.requestId, b.request!.requestId]
  );
}
async function sameSession(
  { h, fixture, open }: Context,
  mode: 'session' | 'serial' = 'session',
  alias?: SessionFixture
): Promise<void> {
  const a = await open('held-first', fixture);
  await a.receivePrepared(mode);
  const bSession = alias ?? (mode === 'serial' ? secondSession(h, fixture) : fixture);
  const b = await open('blocked-second', bSession);
  await h.waitFor(
    () =>
      h
        .ownerEvents()
        .find(
          (value) =>
            value.event === 'actor_stage' &&
            value.invocationId === b.id &&
            value.stage === 'prefix_barrier'
        ),
    REQUEST_MS,
    'prefix barrier'
  );
  assert.equal(event(h, 'prepared', b.id), undefined, 'barrier caller received premature grant');
  b.assertNoPreparedBytes();
  assert.equal(h.observe(Number(a.prepared!.backendPid)).state, 'observed');
  a.destroy();
  assert.equal((await waitEvent(h, 'prepared_withdrawn', a.id, a.deadline)).reason, 'peer_closed');
  await b.receivePrepared(mode);
  assertNoEffect(h, fixture, a.id, fixture);
  await b.dispatch();
  await b.reply(1);
}
async function caseAlias(context: Context): Promise<void> {
  const { h, fixture } = context;
  assert.equal(process.platform, 'darwin', 'case-alias control requires the macOS host');
  const aliasId = fixture.sessionId.toUpperCase();
  assert.notEqual(aliasId, fixture.sessionId);
  const aliasPath = path.join(path.dirname(fixture.session), aliasId);
  // Metadata lookup establishes an existing alias; never create a second path
  // or rewrite metadata to manufacture a case-insensitive session domain.
  const original = fs.statSync(fixture.session),
    alias = fs.statSync(aliasPath);
  assert(original.isDirectory() && alias.isDirectory(), 'session paths must be directories');
  assert.equal(alias.dev, original.dev, 'session alias crosses devices');
  assert.equal(alias.ino, original.ino, 'host does not alias these case-only session paths');
  h.writeJson('case-alias-identity.json', {
    platform: process.platform,
    original: {
      sessionId: fixture.sessionId,
      path: fixture.session,
      device: original.dev,
      inode: original.ino,
    },
    alias: { sessionId: aliasId, path: aliasPath, device: alias.dev, inode: alias.ino },
  });
  // reply() verifies the rendered context retains this exact caller identity,
  // while sameSession() requires zero B bytes before A's withdrawal.
  await sameSession(context, 'session', {
    sessionId: aliasId,
    session: aliasPath,
    transcriptFile: fixture.transcriptFile,
    label: fixture.label,
    turns: fixture.turns,
  });
}
async function generation({ h, fixture, open }: Context): Promise<void> {
  const a = await open('old-generation', fixture);
  const old = await a.receivePrepared();
  const checkout = path.join(h.sandbox, 'linked-checkout');
  const git = h.tools.find((tool) => tool.name === 'git');
  assert(git);
  h.success(
    h.run(
      'linked-checkout',
      git.path,
      ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', checkout, 'HEAD'],
      fixture.project,
      {
        ...h.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      }
    )
  );
  const session = secondSession(h, fixture);
  put(session.transcriptFile, h.transcript(checkout, session.label, 1));
  const b = await open('new-generation', session, checkout);
  await h.waitFor(
    () =>
      h
        .ownerEvents()
        .find(
          (value) =>
            value.event === 'actor_stage' &&
            value.invocationId === b.id &&
            value.stage === 'generation_barrier'
        ),
    REQUEST_MS,
    'generation barrier'
  );
  assert.equal(event(h, 'prepared', b.id), undefined);
  b.assertNoPreparedBytes();
  assert.equal(h.observe(Number(old.backendPid)).state, 'observed');
  assert(fs.existsSync(String(row(old.gitView).gitDirectory)), 'live cohort lost private Git view');
  assert.equal(
    h
      .ownerEvents()
      .find((value) => value.event === 'worker_cleanup' && value.backendPid === old.backendPid),
    undefined
  );
  a.destroy();
  await waitEvent(h, 'prepared_withdrawn', a.id, a.deadline);
  const replacement = await b.receivePrepared();
  assert.notEqual(replacement.backendPid, old.backendPid);
  assert.notEqual(row(replacement.gitView).gitDirectory, row(old.gitView).gitDirectory);
  assert.equal(h.observe(Number(old.backendPid)).state, 'absent');
  assert(!fs.existsSync(String(row(old.gitView).gitDirectory)));
  const events = h.ownerEvents();
  const cleanup = events.findIndex(
    (value) => value.event === 'worker_cleanup' && value.backendPid === old.backendPid
  );
  const prepared = events.findIndex(
    (value) => value.event === 'prepared' && value.invocationId === b.id
  );
  assert(cleanup >= 0 && prepared > cleanup, 'replacement grant preceded old child cleanup');
  const receipt = row(events[cleanup]!.receipt);
  assert.equal(receipt.directChildReaped, true);
  assert.equal(row(receipt.stdout).eof, true);
  assert.equal(row(receipt.stderr).eof, true);
  assert.equal(h.observe(Number(events[cleanup]!.nativeWorkerPid)).state, 'absent');
  assertNoEffect(h, fixture, a.id, fixture);
  await b.dispatch();
  await b.reply(1);
}
async function framing({ h, fixture, open }: Context): Promise<void> {
  const a = await open('lf-without-eof', fixture);
  await a.receivePrepared();
  await a.dispatch(false);
  const session = secondSession(h, fixture),
    b = await open('complete-later', session);
  await b.receivePrepared();
  await b.dispatch();
  await h.waitFor(
    () =>
      h
        .ownerEvents()
        .find(
          (value) =>
            value.event === 'actor_stage' &&
            value.invocationId === b.id &&
            value.stage === 'bridge_received'
        ),
    REQUEST_MS,
    'complete later frame'
  );
  assert.equal(
    h
      .ownerEvents()
      .find(
        (value) =>
          value.event === 'actor_stage' &&
          value.invocationId === a.id &&
          value.stage === 'bridge_received'
      ),
    undefined,
    'LF alone released request'
  );
  assertNoEffect(h, fixture, a.id, fixture);
  assertNoEffect(h, fixture, b.id, session);
  await a.send(Buffer.from('delayed-surplus\n'));
  a.socket.end();
  const withdrawal = await waitEvent(h, 'prepared_withdrawn', a.id, a.deadline);
  assert.equal(withdrawal.reason, 'operation_refused', 'surplus control failed for another cause');
  await a.remoteEof();
  assertNoEffect(h, fixture, a.id, fixture);
  await b.reply(1);
}
async function expiry({ h, fixture, open }: Context): Promise<void> {
  const a = await open('reader-expiry', fixture);
  const prepared = await a.receivePrepared();
  await pause(Number(row(h.ownerConfig.limits).idleMs) + 200);
  assert.equal(
    h.observe(Number(prepared.backendPid)).state,
    'observed',
    'pending demand allowed idle retirement'
  );
  assert(fs.existsSync(String(row(prepared.gitView).gitDirectory)));
  const withdrawal = await waitEvent(h, 'prepared_withdrawn', a.id, a.deadline + 2000);
  assert.equal(withdrawal.reason, 'deadline_expired', 'expiry control failed for another cause');
  await a.remoteEof();
  assertNoEffect(h, fixture, a.id, fixture);
  const b = await open('after-reader-expiry', secondSession(h, fixture));
  await b.receivePrepared();
  await b.dispatch();
  await b.reply(1);
}
function cloneUnreviewedRuntime(): string {
  const target = path.join(root, 'unreviewed-runtime-input', 'hook-packs');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.cpSync(path.join(cli, 'templates/hook-packs'), target, {
    recursive: true,
    errorOnExist: true,
  });
  const selected = path.join(target, 'shared/goal-ac-gate.sh');
  const before = digest(fs.readFileSync(selected));
  fs.appendFileSync(
    selected,
    '\n# Qualification: valid private runtime with unreviewed prefix identity.\n'
  );
  writeJson(path.join(root, 'unreviewed-runtime-input/change.json'), {
    source: path.join(cli, 'templates/hook-packs/shared/goal-ac-gate.sh'),
    selected,
    before,
    after: digest(fs.readFileSync(selected)),
    claim: 'CAWS-owned template copy only; installer derives a new runtime manifest',
  });
  return target;
}
async function runCase(name: string): Promise<void> {
  const runtimeTemplates = name === 'serial' ? cloneUnreviewedRuntime() : undefined;
  const h = await createRenderHarness({
    cli,
    sterling,
    label: 'render-pending-' + name,
    ...(runtimeTemplates === undefined ? {} : { runtimeTemplates }),
  });
  const peers: OwnerPeer[] = [];
  const result: Data = {
    name,
    state: 'running',
    root: h.root,
    sandbox: h.sandbox,
    startedAt: Date.now(),
    requestBudgetMs: REQUEST_MS,
  };
  results.push(result);
  persist();
  let failure: unknown;
  try {
    const fixture = await h.createProject({ name: 'project', sessions: ['shared-id'] });
    h.startHost();
    await h.waitFor(
      () => h.ownerEvents().find((value) => value.event === 'host_started'),
      5000,
      'actual host start'
    );
    const context: Context = {
      h,
      fixture,
      peers,
      open: async (id, session, checkout) => {
        const peer = new OwnerPeer(h, fixture, session, id, checkout ?? fixture.project);
        peers.push(peer);
        await peer.offer();
        return peer;
      },
    };
    if (name === 'fifo') await fifo(context);
    else if (name === 'same-session') await sameSession(context);
    else if (name === 'case-alias') await caseAlias(context);
    else if (name === 'generation') await generation(context);
    else if (name === 'framing') await framing(context);
    else if (name === 'reader-expiry') await expiry(context);
    else if (name === 'serial') await sameSession(context, 'serial');
    else throw new Error('unreachable scenario');
    assert(
      h.operations().every((value) => row(row(value.body).outcome).execution === 'returned'),
      'owner control retained uncompleted/uncertain renderer effect'
    );
    result.state = 'passed';
  } catch (error) {
    failure = error;
    result.state = 'failed';
    result.error = describe(error);
  } finally {
    for (const peer of peers) peer.destroy();
    try {
      h.writeJson('owner-observations-before-cleanup.json', h.ownerEvents());
      h.writeJson('operations-before-cleanup.json', h.operations());
      for (const peer of peers)
        for (const file of files(peer.session.session)) {
          const bytes = fs.readFileSync(path.join(peer.session.session, file));
          assert(bytes.length <= 8 * 1024 * 1024, 'session artifact bound');
          put(path.join(h.root, 'sessions', peer.session.sessionId, file), bytes);
        }
    } catch (error) {
      failure ??= error;
      result.state = 'failed';
      result.retentionError = describe(error);
    }
    try {
      result.cleanup = await h.cleanup(20000);
    } catch (error) {
      result.cleanup = { state: 'unknown', error: describe(error) };
      failure ??= error;
    }
    result.endedAt = Date.now();
    if (row(result.cleanup).state !== 'confirmed_inactive') {
      result.state = 'cleanup_unconfirmed';
      failure = new Error('owner cleanup uncertain; retained sandbox, no further scenarios');
    }
    h.writeJson('pending-control.json', result);
    persist();
    const artifacts = files(h.root)
      .filter((file) => file !== 'artifact-manifest.json')
      .map((file) => {
        const bytes = fs.readFileSync(path.join(h.root, file));
        return { path: file, bytes: bytes.length, sha256: digest(bytes) };
      });
    h.writeJson('artifact-manifest.json', artifacts);
  }
  process.stdout.write(
    JSON.stringify({ scenario: name, state: result.state, root: h.root }) + '\n'
  );
  if (failure) throw failure;
}
async function main(): Promise<void> {
  persist();
  for (const name of scenarioNames)
    if (requested === 'all' || requested === name) await runCase(name);
  manifest.state = 'passed';
  manifest.endedAt = new Date().toISOString();
  persist();
  const artifacts = files(root)
    .filter((file) => file !== 'artifact-manifest.json')
    .map((file) => {
      const bytes = fs.readFileSync(path.join(root, file));
      return { path: file, bytes: bytes.length, sha256: digest(bytes) };
    });
  writeJson(path.join(root, 'artifact-manifest.json'), artifacts);
  process.stdout.write(
    JSON.stringify({ state: manifest.state, root, scenarios: results.length }) + '\n'
  );
}
main().catch((error: unknown) => {
  manifest.state = 'failed';
  manifest.error = describe(error);
  manifest.endedAt = new Date().toISOString();
  persist();
  process.stderr.write(describe(error) + '\nArtifact root: ' + root + '\n');
  process.exitCode = 1;
});
