/** Actual sealed stock advisory consumer; private fixtures, no machine adoption.
 * Usage: qualify-render-advisory.js <built-cli-root> <sterling-root> <control|cut|goal-block>
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

assert.equal(process.argv.length, 5, 'CLI root, reviewed Sterling root and scenario required');
const cli = fs.realpathSync(process.argv[2]!);
const sterling = fs.realpathSync(process.argv[3]!);
const scenario = process.argv[4]!;
assert(['control', 'cut', 'goal-block'].includes(scenario), 'unknown scenario');
const REQUEST_MS = 30000;
const CLOSE_MS = 40000;
const fixtureEnvironment = {
  HEARTBEAT_EMIT_MIN_INTERVAL_MS: '0',
  CAWS_HOOK_ADVISORY_DEDUP: '0',
};
const expectedFour = [
  'goal-ac-gate.sh',
  'plan-transcript-finalize.sh',
  'session-log.sh',
  'agent-stop.sh',
];
const expectedFive = [...expectedFour.slice(0, 3), 'agent-heartbeat.sh', 'agent-stop.sh'];
const utf8 = new TextDecoder('utf-8', { fatal: true });
const errorText = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? String(error)) : String(error);

async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('observation deadline; no signal sent: ' + label)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function lines(bytes: Buffer): Data[] {
  const text = utf8.decode(bytes);
  assert(text.endsWith('\n'), 'settled JSONL lacks final newline');
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => row(JSON.parse(line)));
}
function context(stdout: unknown): string | null {
  if (typeof stdout !== 'string' || !stdout.trim()) return null;
  const value = row(JSON.parse(stdout));
  const hook = value.hookSpecificOutput;
  if (hook === undefined) return null;
  const member = row(hook).additionalContext;
  if (member === undefined) return null;
  assert(typeof member === 'string', 'actual additionalContext must be a string');
  return member;
}
function assertNaturalPeers(card: string, sessions: string[]): void {
  assert(
    card.startsWith(
      `MULTI-AGENT NOTICE (peer set changed): ${sessions.length + 1} agents active in this repo (including this session). Other active sessions:\n`
    )
  );
  const actual = card
    .split('\n')
    .filter((line) => line.startsWith('• '))
    .map((line) => line.slice(2).split(' ')[0]);
  assert.deepEqual(
    actual.sort(),
    [...sessions].sort(),
    'actual producer peer bullets differ from real CLI leases'
  );
}
function fileIdentity(file: string, maxBytes = 16 * 1024 * 1024): Data {
  const absolute = fs.realpathSync(file),
    stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'identity requires a regular file: ' + file);
  assert(stat.size <= maxBytes, 'driver file byte bound');
  const bytes = fs.readFileSync(file);
  return {
    path: absolute,
    bytes: bytes.length,
    sha256: digest(bytes),
    dev: stat.dev,
    ino: stat.ino,
  };
}
function driverFiles(h: RenderHarness): Data {
  const runtime = path.join(h.cli, 'dist/runtime');
  const modules = files(runtime).filter((name) => name.endsWith('.js'));
  assert(modules.length > 0 && modules.length <= 512, 'runtime module count bound');
  const runtimeModules = modules.map((name) => fileIdentity(path.join(runtime, name)));
  assert(
    runtimeModules.reduce((sum, file) => sum + Number(file.bytes), 0) <= 32 * 1024 * 1024,
    'runtime module total byte bound'
  );
  return {
    compiledQualifier: fileIdentity(__filename),
    compiledHarness: fileIdentity(require.resolve('./render-qualification-harness')),
    sources: ['qualify-render-advisory.ts', 'render-qualification-harness.ts'].map((name) =>
      fileIdentity(path.join(h.cli, 'scripts', name))
    ),
    node: fileIdentity(process.execPath, 512 * 1024 * 1024),
    runtimeModules,
  };
}
function imageRoot(fixture: ProjectFixture): string {
  const root = row(row(fixture.image).manifest).execution;
  assert(typeof row(root).root === 'string');
  return String(row(root).root);
}
function checkpoint(h: RenderHarness, fixture: ProjectFixture, label: string): void {
  const inventory: Data[] = [];
  let total = 0;
  for (const [name, directory] of [
    ['sessions', path.join(fixture.project, '.caws/sessions')],
    ['leases', path.join(fixture.project, '.caws/leases')],
    ['owner', h.owner],
  ] as const) {
    for (const relative of files(directory)) {
      const source = path.join(directory, relative),
        stat = fs.lstatSync(source);
      assert(!stat.isSymbolicLink());
      assert(inventory.length < 4096, 'checkpoint file bound');
      if (stat.isSocket()) {
        inventory.push({ source, type: 'socket', dev: stat.dev, ino: stat.ino });
        continue;
      }
      assert(stat.isFile(), 'checkpoint contains unsupported entry');
      assert(stat.size <= 8 * 1024 * 1024, 'checkpoint byte bound');
      const bytes = fs.readFileSync(source);
      total += bytes.length;
      assert(total <= 32 * 1024 * 1024, 'checkpoint total byte bound');
      const target = path.join('checkpoints', label, name, relative);
      put(path.join(h.root, target), bytes);
      inventory.push({
        source,
        target,
        bytes: bytes.length,
        sha256: digest(bytes),
        dev: stat.dev,
        ino: stat.ino,
      });
    }
  }
  h.writeJson('checkpoints/' + label + '/inventory.json', inventory);
}

type Invocation = {
  receipt: Receipt;
  id: string;
  records: Data[];
  stdout: string;
  grant: Data;
  ownerTail: Data[];
};
async function main(): Promise<void> {
  const h = await createRenderHarness({ cli, sterling, label: 'render-advisory-' + scenario });
  const children: {
    started: Started;
    close: Promise<void>;
    closed: boolean;
    stdinErrors: string[];
  }[] = [];
  const result: Data = {
    schema: 'caws.qualification.render-advisory.v1',
    scenario,
    state: 'running',
    root: h.root,
    nativeBudgetMs: REQUEST_MS,
    closeObservationMs: CLOSE_MS,
    grantEvidenceContract:
      'one actual caller-private grant version required; missing polling observation is a case evidence gap, never admission proof',
    nonclaims: [
      'machine adoption',
      'platform harness delivery',
      'long-lived peer processes',
      'four-handler control executes the truncator',
      'missing cmp/iconv branch qualification',
      'whole-runtime Python retirement',
      'full load/fairness acceptance',
    ],
  };
  let fixture: ProjectFixture | undefined;
  let failure: unknown;
  let driverBefore: Data | undefined;
  const persist = (): void => h.writeJson('manifest.json', result);
  const nativeHash = digest(fs.readFileSync(h.native));
  result.executables = {
    native: h.native,
    nativeSha256: nativeHash,
    engine: h.engine,
    engineSha256: digest(fs.readFileSync(h.engine)),
    cli: h.cliEntry,
    cliSha256: digest(fs.readFileSync(h.cliEntry)),
    node: process.execPath,
    nodeSha256: digest(fs.readFileSync(process.execPath)),
  };
  function track(started: Started) {
    const value = { started, close: Promise.resolve(), closed: false, stdinErrors: [] as string[] };
    value.close = new Promise<void>((resolve) =>
      started.child.once('close', () => {
        value.closed = true;
        resolve();
      })
    );
    started.child.stdin?.on('error', (error) => {
      value.stdinErrors.push(errorText(error));
    });
    children.push(value);
    return value;
  }
  async function actualCli(
    label: string,
    args: string[],
    sid: string,
    expected = 0
  ): Promise<Receipt> {
    assert(fixture);
    const child = track(
      h.start(label, process.execPath, [h.cliEntry, ...args], fixture.project, {
        ...h.env,
        ...fixtureEnvironment,
        CAWS_SESSION_ID: sid,
        CODEX_THREAD_ID: sid,
        CAWS_AGENT_SURFACE: 'codex',
      })
    );
    const [receipt] = await bounded(
      Promise.all([child.started.done, child.close]),
      CLOSE_MS,
      label
    );
    assert.equal(receipt.error, null);
    assert.equal(receipt.signal, null);
    assert.equal(receipt.code, expected);
    assert.equal(child.stdinErrors.length, 0);
    return receipt;
  }
  async function lease(sid: string, action: 'register' | 'heartbeat' | 'stop'): Promise<Data> {
    const args = ['agents', action, '--session-id', sid, '--platform', 'codex', '--json'];
    if (action !== 'stop') args.push('--include-active-summary');
    if (action === 'heartbeat') args.push('--throttle', '0', '--reason', 'pre_tool_use');
    const receipt = await actualCli('lease-' + action + '-' + sid, args, sid);
    const output = readJson(path.join(receipt.directory, 'stdout.bin'));
    assert.equal(output.ok, true);
    assert.equal(output.session_id, sid);
    if (action === 'heartbeat') assert.equal(output.throttled, false);
    h.writeJson('leases-' + action + '-' + sid + '.json', output);
    return output;
  }
  async function selfHeartbeat(label: string, peers: string[]): Promise<void> {
    assert(fixture);
    const summary = await lease(fixture.sessionId, 'heartbeat');
    h.writeJson(label + '/pre-stop-active-summary.json', summary);
    assert.equal(summary.active_agent_count, peers.length + 1);
    assert(Array.isArray(summary.active_agents));
    const agents = summary.active_agents.map(row);
    assert.equal(agents.length, peers.length + 1);
    const self = agents.filter((agent) => agent.is_self === true);
    assert.equal(self.length, 1);
    assert.equal(self[0]!.session_id, fixture.sessionId);
    const other = agents.filter((agent) => agent.is_self === false);
    assert.deepEqual(other.map((agent) => agent.session_id).sort(), [...peers].sort());
  }
  async function assertSelfStopped(label: string): Promise<void> {
    assert(fixture);
    const receipt = await actualCli(
      'self-stopped-' + label,
      ['agents', 'show', fixture.sessionId, '--json'],
      fixture.sessionId
    );
    const output = readJson(path.join(receipt.directory, 'stdout.bin'));
    assert.equal(row(output.lease).status, 'stopped');
    h.writeJson(label + '/self-stopped.json', output);
  }
  async function invoke(label: string, budget: number): Promise<Invocation> {
    assert(fixture);
    assert.equal(digest(fs.readFileSync(h.native)), nativeHash, 'native changed between cases');
    const tailStart = h.ownerEvents().length;
    const child = track(
      h.spawnInvocation(fixture, {
        timeoutMs: REQUEST_MS,
        environment: { ...fixtureEnvironment, CAWS_HOOK_ADVISORY_BUDGET_BYTES: String(budget) },
      })
    );
    const grants: { path: string; bytes: Buffer; value: Data }[] = [];
    const errors: string[] = [];
    const sample = (): void => {
      try {
        const tmp = path.join(h.root, 'tmp');
        for (const name of fs
          .readdirSync(tmp)
          .filter((name) =>
            name.startsWith('caws-render-invocation-' + child.started.child.pid + '-')
          )) {
          const file = path.join(tmp, name, 'grant.json');
          try {
            const stat = fs.lstatSync(file);
            assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 131072);
            const bytes = fs.readFileSync(file);
            if (!bytes.length) continue;
            const value = row(JSON.parse(utf8.decode(bytes)));
            if (!grants.some((grant) => grant.bytes.equals(bytes))) {
              assert(grants.length < 4, 'grant observation version bound');
              grants.push({ path: file, bytes, value });
              put(path.join(h.root, label, 'observed-grant-' + grants.length + '.json'), bytes);
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && errors.length < 16)
              errors.push(errorText(error));
          }
        }
      } catch (error) {
        if (errors.length < 16) errors.push(errorText(error));
      }
    };
    const timer = setInterval(sample, 10);
    let receipt: Receipt;
    try {
      sample();
      [receipt] = await bounded(Promise.all([child.started.done, child.close]), CLOSE_MS, label);
      sample();
    } finally {
      clearInterval(timer);
    }
    // Retain raw journals/decoded records before applying semantic assertions.
    const directory = path.join(fixture.session, 'hook-invocations');
    const journals = files(directory).filter(
      (name) => name.startsWith(String(receipt.pid) + '-') && name.endsWith('.jsonl')
    );
    assert.equal(journals.length, 1, 'one journal per actual caller');
    const raw = fs.readFileSync(path.join(directory, journals[0]!));
    put(path.join(h.root, label, 'invocation.jsonl'), raw);
    const journal = lines(raw);
    const complete = journal.filter((event) => event.stage === 'compatibility_dispatch_completed');
    if (typeof complete[0]?.execution_records_base64 === 'string')
      put(
        path.join(h.root, label, 'execution.jsonl'),
        Buffer.from(complete[0].execution_records_base64, 'base64')
      );
    h.writeJson(label + '/grant-observations.json', { paths: grants.map((g) => g.path), errors });
    result[label + 'GrantEvidence'] = {
      state: grants.length ? 'observed' : 'not_observed',
      versions: grants.length,
    };
    checkpoint(h, fixture, label + '-after-close');
    assert.equal(receipt.error, null);
    assert.equal(receipt.signal, null);
    assert.equal(child.stdinErrors.length, 0);
    assert.equal(complete.length, 1);
    assert.equal(complete[0]!.exit_code, receipt.code);
    assert(typeof complete[0]!.execution_records_base64 === 'string');
    const records = lines(Buffer.from(complete[0]!.execution_records_base64 as string, 'base64'));
    const manifest = row(fixture.image.manifest);
    const routes = row(manifest.execution).handlerRoutes as Data[];
    const imageFiles = row(manifest.execution).files as Data[];
    const routeEvidence = records.map((record, index) => {
      const route = routes[index];
      assert(route, 'execution record lacks selected route');
      assert.equal(route.selectedIndex, index);
      assert.equal(record.handler, String(route.entry).split(' ')[0]);
      assert.equal(record.path, route.originalPath, 'runner records authenticated source identity');
      const sourceBytes = fs.readFileSync(String(route.originalPath));
      assert.equal(digest(sourceBytes), route.originalSha256);
      const sealed = imageFiles.find((file) => file.path === route.executionRelative);
      assert(sealed);
      const executionPath = path.join(imageRoot(fixture!), String(route.executionRelative));
      assert.equal(record.hook_event, 'Stop');
      assert.equal(digest(fs.readFileSync(executionPath)), sealed.sha256);
      return {
        selectedIndex: index,
        originalPath: route.originalPath,
        originalSha256: digest(sourceBytes),
        executionPath,
        executionSha256: sealed.sha256,
        evidence: 'journal source path plus sealed authenticated route; not a syscall trace',
      };
    });
    h.writeJson(label + '/handler-routes.json', routeEvidence);
    const starts = journal.filter((event) => event.stage === 'invocation_started');
    assert.equal(starts.length, 1);
    const start = starts[0]!,
      id = String(start.invocation_id);
    assert(id.startsWith(String(receipt.pid) + '-'));
    assert.equal(
      start.input_sha256,
      digest(fs.readFileSync(path.join(receipt.directory, 'stdin.bin')))
    );
    assert.equal(start.runtime_digest, h.installed.digest);
    assert.equal(start.surface, 'codex');
    assert.equal(start.event, 'stop');
    assert.equal(start.resolved_session_id, fixture.sessionId);
    assert.equal(start.dispatch_cwd, fixture.project);
    assert.deepEqual(start.selected_handlers, fixture.selection.handlers);
    const expected = scenario === 'control' ? expectedFour : expectedFive;
    assert.deepEqual(
      (fixture.selection.handlers as Data[]).map((handler) => handler.entry),
      expected
    );
    const ownerTail = h.ownerEvents().slice(tailStart);
    h.writeJson(label + '/owner-tail.json', ownerTail);
    const prefixes = ownerTail.filter(
      (event) => event.event === 'prefix_disposition' && event.invocationId === id
    );
    assert.equal(prefixes.length, 1);
    assert.equal(prefixes[0]!.mode, scenario === 'control' ? 'session' : 'serial');
    if (scenario === 'control')
      assert.equal(prefixes[0]!.proofProfile, 'codex-stop-session-prefix-v1');
    else assert.equal(prefixes[0]!.reason, 'unreviewed_prefix');
    assert.equal(
      grants.length,
      1,
      'actual descriptor grant was not captured; no inferred grant proof'
    );
    const grant = grants[0]!.value;
    assert.equal(grant.invocationId, id);
    assert.equal(grant.canonicalProject, fixture.project);
    assert.equal(grant.selectedIndex, 2);
    assert.equal(row(grant.executionImage).imageDigest, fixture.image.imageDigest);
    assert.equal(grant.sourceGeneration, row(fixture.image.manifest).sourceGeneration);
    assert.equal(grant.hooksDirectory, path.join(imageRoot(fixture), 'hooks'));
    const stdout = fs.readFileSync(path.join(receipt.directory, 'stdout.bin'), 'utf8');
    result[label] = {
      receipt,
      invocationId: id,
      journalSha256: digest(raw),
      grant,
      executedHandlers: records,
      prefix: prefixes[0],
    };
    persist();
    return { receipt, id, records, stdout, grant, ownerTail };
  }
  function rendered(invocation: Invocation): void {
    assert(fixture);
    assert.equal(invocation.receipt.code, 0);
    assert.deepEqual(
      invocation.records.map((record) => record.handler),
      scenario === 'control' ? expectedFour : expectedFive
    );
    for (const record of invocation.records) {
      assert.equal(record.status, 'completed');
      assert.equal(record.exit_code, 0);
      assert.equal(record.session_id, fixture.sessionId);
    }
    const outcomes = invocation.ownerTail.filter((event) => event.event === 'render_outcome');
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.execution, 'daemon_response');
    assert.equal(
      invocation.ownerTail.filter(
        (event) => event.event === 'journal_dispatch' && event.requestId === outcomes[0]!.requestId
      ).length,
      1
    );
    const names = files(fixture.session).filter((name) => /^turn-\d+\.json$/.test(name));
    assert.deepEqual(names, ['turn-001.json']);
    const turn = readJson(path.join(fixture.session, names[0]!));
    assert.equal(turn.schema_version, 2);
    assert.equal(turn.status, 'ok');
    assert.equal(turn.turn, 1);
    assert.equal(turn.user, fixture.label + ' user 1');
    const ctx = row(turn.context);
    assert.equal(ctx.session_id, fixture.sessionId);
    assert.equal(ctx.cwd, fixture.project);
    assert.equal(ctx.model, 'owner-fixture-model');
    assert(Array.isArray(turn.timeline) && turn.timeline.length === 2);
    const tool = row(turn.timeline[0]),
      assistant = row(turn.timeline[1]);
    assert.equal(tool.name, 'exec_command');
    assert.deepEqual(tool.input, { cmd: 'touch MUST-NOT-EXECUTE' });
    assert.equal(tool.output, fixture.label + ' result 1');
    assert.equal(assistant.kind, 'reasoning');
    assert.equal(assistant.text, fixture.label + ' assistant 1');
    assert(!fs.existsSync(path.join(fixture.project, 'MUST-NOT-EXECUTE')));
  }
  function closure(): void {
    assert(fixture);
    const manifest = row(fixture.image.manifest),
      root = imageRoot(fixture);
    const execution = row(manifest.execution).files as Data[];
    const helper = execution.filter((file) => String(file.path).endsWith('/advisory_truncate.cjs'));
    assert.equal(helper.length, 1);
    const identities: Data[] = [];
    for (const file of [
      helper[0]!,
      ...execution.filter((file) =>
        ['bin/node', 'bin/caws', 'bin/cmp', 'bin/iconv'].includes(String(file.path))
      ),
    ]) {
      const target = path.join(root, String(file.path)),
        stat = fs.lstatSync(target),
        bytes = fs.readFileSync(target);
      assert(stat.isFile() && !stat.isSymbolicLink());
      assert.equal(digest(bytes), file.sha256);
      put(path.join(h.root, 'sealed-consumer', String(file.path)), bytes);
      identities.push({
        path: target,
        sha256: digest(bytes),
        bytes: bytes.length,
        dev: stat.dev,
        ino: stat.ino,
      });
    }
    assert.equal(identities.length, 5, 'helper and all required tool wrappers');
    const tools = row(manifest.toolchainTcb).tools as Data[];
    for (const name of ['node', 'caws', 'cmp', 'iconv']) {
      const pin = tools.find((tool) => tool.name === name);
      assert(pin);
      assert.equal(digest(fs.readFileSync(String(pin.path))), pin.sha256);
      if (name === 'node') assert.equal(pin.path, fs.realpathSync(process.execPath));
    }
    result.consumerClosure = {
      identities,
      tools: tools.filter((tool) => ['node', 'caws', 'cmp', 'iconv'].includes(String(tool.name))),
      validatedGrantImageRoot: root,
      expectedDispatchPath: path.join(root, 'bin'),
      pathEvidence:
        'actual captured grant/image root and pinned engine claimNativeRenderAdmission PATH derivation; not a process-environment snapshot',
      engineSha256: digest(fs.readFileSync(h.engine)),
    };
  }
  try {
    persist();
    driverBefore = driverFiles(h);
    const git = h.tools.find((tool) => tool.name === 'git');
    assert(git);
    const revision = h.run('driver-source-head', git.path, ['rev-parse', 'HEAD'], h.cli);
    const dirty = h.run(
      'driver-source-dirty',
      git.path,
      ['status', '--porcelain=v1', '--untracked-files=all'],
      h.cli
    );
    h.success(revision);
    h.success(dirty);
    const revisionBytes = fs.readFileSync(path.join(revision.directory, 'stdout.bin'));
    const dirtyBytes = fs.readFileSync(path.join(dirty.directory, 'stdout.bin'));
    assert(
      revisionBytes.length <= 128 && dirtyBytes.length <= 1024 * 1024,
      'source identity command output bound'
    );
    const head = utf8.decode(revisionBytes).trim();
    assert(/^[a-f0-9]{40}$/.test(head));
    result.driverIdentity = {
      argv: [...process.argv],
      execArgv: [...process.execArgv],
      cwd: process.cwd(),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      sourceHead: head,
      sourceDirty: utf8.decode(dirtyBytes),
      revisionReceipt: revision,
      dirtyReceipt: dirty,
      before: driverBefore,
    };
    persist();
    fixture = await h.createProject({
      name: 'advisory-project',
      sessions: [scenario === 'goal-block' ? 'advisory-blocked' : 'advisory-self'],
      ...(scenario === 'control'
        ? {}
        : {
            stopExtensions: [
              { handler: 'agent-heartbeat.sh' as const, before: 'agent-stop.sh' as const },
            ],
          }),
    });
    checkpoint(h, fixture, 'before-native');
    if (scenario === 'control') {
      const control = await invoke('control', 32768);
      rendered(control);
      closure();
    } else if (scenario === 'cut') {
      await lease(fixture.sessionId, 'register');
      await lease('advisory-peer-a', 'register');
      await lease('advisory-peer-b', 'register');
      await selfHeartbeat('baseline', ['advisory-peer-a', 'advisory-peer-b']);
      const baseline = await invoke('baseline', 32768);
      rendered(baseline);
      const heartbeat = baseline.records.find((record) => record.handler === 'agent-heartbeat.sh');
      assert(heartbeat);
      const original = context(heartbeat.stdout);
      assert(typeof original === 'string' && original.includes('MULTI-AGENT NOTICE'));
      assertNaturalPeers(original, ['advisory-peer-a', 'advisory-peer-b']);
      assert.deepEqual(
        baseline.records
          .filter((record) => context(record.stdout) !== null)
          .map((record) => record.handler),
        ['agent-heartbeat.sh']
      );
      assert.equal(
        context(baseline.stdout),
        original,
        'baseline card must be whole and untruncated'
      );
      await assertSelfStopped('baseline');
      put(path.join(h.root, 'baseline/heartbeat-stdout.bin'), String(heartbeat.stdout));
      const bullet = Buffer.from(original).indexOf(Buffer.from('•'));
      assert(bullet >= 48, 'natural producer lacks bounded UTF-8 cut position');
      const before = baseline.records
        .slice(0, 3)
        .map((record) => context(record.stdout))
        .filter((value): value is string => value !== null);
      const preceding = Buffer.byteLength(before.join('\n\n'));
      assert.equal(preceding, 0, 'this fixture must have no earlier cards');
      const plan = deriveBudget(Buffer.byteLength(original), bullet, preceding);
      h.writeJson('budget-plan.json', {
        ...plan,
        bullet,
        preceding,
        producerSha256: digest(original),
        source: 'retained actual baseline heartbeat stdout',
      });
      await lease('advisory-peer-c', 'register');
      await selfHeartbeat('cut', ['advisory-peer-a', 'advisory-peer-b', 'advisory-peer-c']);
      const cut = await invoke('cut', plan.budget);
      rendered(cut);
      const actualHeartbeat = cut.records.find((record) => record.handler === 'agent-heartbeat.sh');
      assert(actualHeartbeat);
      const rawCard = context(actualHeartbeat.stdout);
      assert(typeof rawCard === 'string' && rawCard.includes('advisory-peer-c'));
      assertNaturalPeers(rawCard, ['advisory-peer-a', 'advisory-peer-b', 'advisory-peer-c']);
      assert.deepEqual(
        cut.records
          .filter((record) => context(record.stdout) !== null)
          .map((record) => record.handler),
        ['agent-heartbeat.sh']
      );
      put(path.join(h.root, 'cut/heartbeat-stdout.bin'), String(actualHeartbeat.stdout));
      assert.equal(
        Buffer.from(rawCard).indexOf(Buffer.from('•')),
        bullet,
        'new natural producer changed cut offset'
      );
      const prior = cut.records
        .slice(0, 3)
        .map((record) => context(record.stdout))
        .filter((value): value is string => value !== null);
      assert.equal(Buffer.byteLength(prior.join('\n\n')), preceding);
      const calculation = cutCalculation(Buffer.byteLength(rawCard), plan.budget, preceding);
      assert.equal(
        calculation.requestedKeep,
        bullet + 1,
        'requested cut must split natural bullet after one byte'
      );
      assert.equal(
        markerBytes(Buffer.byteLength(rawCard) - calculation.requestedKeep),
        plan.markerBytes,
        'changed marker width invalidates planned cut'
      );
      const bytes = Buffer.from(rawCard);
      assert(bytes.length > plan.budget);
      let kept = calculation.requestedKeep;
      while (kept > 0) {
        try {
          utf8.decode(bytes.subarray(0, kept));
          break;
        } catch {
          kept--;
        }
      }
      assert.equal(kept, bullet, 'character-safe helper cut must omit partial natural bullet');
      while (kept > 0 && bytes[kept - 1] === 10) kept--; // Both stock Bash command substitutions strip LF.
      const marker = `… [truncated: ${bytes.length - kept} bytes elided]`;
      const expected = Buffer.concat([bytes.subarray(0, kept), Buffer.from(marker)]);
      const outputContext = context(cut.stdout);
      assert(outputContext !== null);
      const expectedContext = [...prior, expected.toString('utf8')].join('\n\n');
      assert.equal(
        outputContext,
        expectedContext,
        'exact prefix/marker/card separator composition'
      );
      assert(Buffer.byteLength(outputContext) <= plan.budget);
      utf8.decode(Buffer.from(outputContext));
      const stderr = fs.readFileSync(path.join(cut.receipt.directory, 'stderr.bin'), 'utf8');
      assert(
        stderr.includes(
          `[agent-heartbeat.sh] advisory truncated: card ${bytes.length} bytes = ${kept} kept + ${bytes.length - kept} elided, capped at ${calculation.cap} (budget ${plan.budget})`
        ),
        'actual stock truncation arithmetic diagnostic missing'
      );
      result.cutArithmetic = {
        ...calculation,
        kept,
        elided: bytes.length - kept,
        marker,
        actualCardBytes: expected.length,
        wholeContextBytes: Buffer.byteLength(outputContext),
        budget: plan.budget,
      };
      await assertSelfStopped('cut');
      await lease('advisory-peer-c', 'stop');
      await selfHeartbeat('adjacent-complete-bullet', ['advisory-peer-a', 'advisory-peer-b']);
      const adjacent = await invoke('adjacent-complete-bullet', plan.budget + 8);
      rendered(adjacent);
      const adjacentHeartbeat = adjacent.records.find(
        (record) => record.handler === 'agent-heartbeat.sh'
      );
      assert(adjacentHeartbeat);
      const adjacentCard = context(adjacentHeartbeat.stdout);
      assert(adjacentCard);
      assertNaturalPeers(adjacentCard, ['advisory-peer-a', 'advisory-peer-b']);
      assert.deepEqual(
        adjacent.records
          .filter((record) => context(record.stdout) !== null)
          .map((record) => record.handler),
        ['agent-heartbeat.sh']
      );
      put(
        path.join(h.root, 'adjacent-complete-bullet/heartbeat-stdout.bin'),
        String(adjacentHeartbeat.stdout)
      );
      const adjacentBytes = Buffer.from(adjacentCard);
      assert(!adjacentCard.includes('advisory-peer-c'), 'legitimate stop must change the peer set');
      assert.equal(adjacentBytes.indexOf(Buffer.from('•')), bullet);
      assert(adjacentBytes.length > plan.budget + 8);
      const adjacentPrior = adjacent.records
        .slice(0, 3)
        .map((record) => context(record.stdout))
        .filter((value): value is string => value !== null);
      assert.equal(Buffer.byteLength(adjacentPrior.join('\n\n')), preceding);
      const adjacentCalculation = cutCalculation(adjacentBytes.length, plan.budget + 8, preceding);
      assert.equal(adjacentCalculation.requestedKeep, bullet + 3);
      assert.equal(
        markerBytes(adjacentBytes.length - adjacentCalculation.requestedKeep),
        plan.markerBytes
      );
      utf8.decode(adjacentBytes.subarray(0, bullet + 3));
      const adjacentMarker = `… [truncated: ${adjacentBytes.length - (bullet + 3)} bytes elided]`;
      const adjacentExpected = Buffer.concat([
        adjacentBytes.subarray(0, bullet + 3),
        Buffer.from(adjacentMarker),
      ]).toString('utf8');
      assert.equal(
        context(adjacent.stdout),
        adjacentExpected,
        'adjacent budget must preserve the entire three-byte bullet'
      );
      assert(Buffer.byteLength(adjacentExpected) <= plan.budget + 8);
      utf8.decode(Buffer.from(adjacentExpected));
      const adjacentStderr = fs.readFileSync(
        path.join(adjacent.receipt.directory, 'stderr.bin'),
        'utf8'
      );
      assert(
        adjacentStderr.includes(
          `[agent-heartbeat.sh] advisory truncated: card ${adjacentBytes.length} bytes = ${bullet + 3} kept + ${adjacentBytes.length - (bullet + 3)} elided, capped at ${adjacentCalculation.cap} (budget ${plan.budget + 8})`
        )
      );
      result.adjacentArithmetic = {
        ...adjacentCalculation,
        kept: bullet + 3,
        budget: plan.budget + 8,
        elided: adjacentBytes.length - (bullet + 3),
        marker: adjacentMarker,
        wholeContextBytes: Buffer.byteLength(adjacentExpected),
      };
      await assertSelfStopped('adjacent-complete-bullet');
      closure();
    } else {
      Object.assign(fixture, h.createSession(fixture, { sessionId: fixture.sessionId, turns: 2 }));
      const spec = 'R08-REQUIRED-STOP-001';
      await actualCli(
        'goal-spec-create',
        [
          'specs',
          'create',
          spec,
          '--title',
          'Private unresolved goal control',
          '--mode',
          'chore',
          '--scope-in',
          'fixture.txt',
          '--acceptance',
          'given: a bound goal without evidence; when: Stop is requested; then: the goal remains unmet',
          '--json',
        ],
        fixture.sessionId
      );
      const verify = await actualCli(
        'goal-verify-before',
        ['specs', 'verify-acs', spec, '--json'],
        fixture.sessionId
      );
      const report = readJson(path.join(verify.directory, 'stdout.bin'));
      assert.equal(report.exit_code, verify.code);
      assert.equal(report.strict, false);
      assert.equal(row(report.summary).verified, 0);
      assert.equal(row(report.summary).refuted, 0);
      assert(Number(row(report.summary).not_rederived) > 0);
      assert(
        Array.isArray(report.criteria) &&
          report.criteria.some(
            (criterion) => row(criterion).id === 'A1' && row(criterion).verdict !== 'verified'
          )
      );
      await actualCli('goal-set', ['goal', 'set', spec], fixture.sessionId);
      const blocked = await invoke('goal-block', 1);
      assert.equal(blocked.receipt.code, 2);
      const guard = blocked.records.find((record) => record.handler === 'goal-ac-gate.sh');
      assert(guard);
      const raw = row(JSON.parse(String(guard.stdout))),
        actual = row(JSON.parse(blocked.stdout));
      assert.equal(raw.decision, 'block');
      assert.equal(actual.decision, 'block');
      assert.equal(
        blocked.stdout,
        String(guard.stdout) + '\n',
        'full protective stdout including final LF'
      );
      assert.equal(guard.status, 'completed');
      assert.equal(guard.exit_code, 0);
      assert.equal(blocked.records.length, 1, 'hard control must stop every later handler');
      assert.equal(actual.reason, raw.reason, 'protective reason must remain complete');
      assert(
        typeof actual.reason === 'string' &&
          actual.reason.includes(spec) &&
          actual.reason.includes('A1=') &&
          actual.reason.includes('Only verdict=verified')
      );
      assert(actual.reason.includes('unverified') || actual.reason.includes('not_rederived'));
      assert(actual.reason.includes('Block 1 of 3'));
      assert(Buffer.byteLength(actual.reason) > 1 && !actual.reason.includes('[truncated:'));
      assert(!blocked.records.some((record) => record.handler === 'session-log.sh'));
      assert.equal(
        blocked.ownerTail.filter((event) =>
          ['render_outcome', 'journal_dispatch'].includes(String(event.event))
        ).length,
        0
      );
      assert.equal(
        files(fixture.session).filter((name) => /^turn-\d+\.json$/.test(name)).length,
        0
      );
      closure();
    }
    checkpoint(h, fixture, 'after-assertions');
    assert.equal(digest(fs.readFileSync(h.native)), nativeHash);
  } catch (error) {
    failure = error;
    result.error = errorText(error);
    if (fixture)
      try {
        checkpoint(h, fixture, 'failure-before-cleanup');
      } catch (checkpointError) {
        result.checkpointError = errorText(checkpointError);
      }
  } finally {
    persist();
    try {
      result.cleanup = await h.cleanup();
      assert.equal(
        row(result.cleanup).state,
        'confirmed_inactive',
        'unknown cleanup; preserve and stop'
      );
      for (const child of children)
        await bounded(child.close, 1000, 'owned direct child close after cleanup');
      assert(children.every((child) => child.closed));
    } catch (error) {
      result.cleanupError = errorText(error);
      failure ??= error;
    }
    try {
      const after = driverFiles(h);
      result.driverIdentityAfter = after;
      assert(driverBefore, 'driver identity before snapshot missing');
      assert.deepEqual(
        after,
        driverBefore,
        'driver/source/runtime module identities changed during qualification'
      );
    } catch (error) {
      result.driverIdentityError = errorText(error);
      failure ??= error;
    }
    result.directChildren = children.map((child) => ({
      pid: child.started.child.pid,
      directory: child.started.directory,
      closeConfirmed: child.closed,
      code: child.started.child.exitCode,
      signal: child.started.child.signalCode,
      stdinErrors: child.stdinErrors,
    }));
    result.state = failure === undefined ? 'passed' : 'failed';
    persist();
    const inventory = files(h.root)
      .filter((name) => name !== 'artifact-manifest.json')
      .map((name) => {
        const bytes = fs.readFileSync(path.join(h.root, name));
        return { path: name, bytes: bytes.length, sha256: digest(bytes) };
      });
    h.writeJson('artifact-manifest.json', inventory);
  }
  console.log(h.root);
  if (failure !== undefined) throw failure;
}

function cutCalculation(cardBytes: number, budget: number, preceding: number) {
  const available = Math.max(0, budget - preceding - (preceding ? 2 : 0));
  const cap = Math.max(0, Math.min(Math.floor(budget / 4), available - 256, available));
  let note = Buffer.byteLength('… [truncated: 99999999 bytes elided]');
  for (let attempt = 0; attempt < 4; attempt++) {
    const next = Buffer.byteLength(
      `… [truncated: ${cardBytes - Math.max(0, cap - note)} bytes elided]`
    );
    if (next === note) break;
    note = next;
  }
  return { available, cap, requestedKeep: Math.max(0, cap - note) };
}
function markerBytes(elided: number): number {
  return Buffer.byteLength(`… [truncated: ${elided} bytes elided]`);
}
function deriveBudget(cardBytes: number, bullet: number, preceding: number) {
  const requested = bullet + 1,
    marker = markerBytes(cardBytes - requested),
    cap = requested + marker,
    budget = 4 * cap;
  const calculation = cutCalculation(cardBytes, budget, preceding);
  assert.equal(preceding, 0);
  assert(requested >= 48);
  assert(budget < cardBytes && budget <= 32768);
  assert.equal(calculation.cap, cap);
  assert.equal(calculation.requestedKeep, requested);
  return { budget, ...calculation, markerBytes: marker };
}
main().catch((error) => {
  console.error(errorText(error));
  process.exitCode = 1;
});
