/** Direct native plan-snapshot protocol qualification. Private fixtures only.
 * Usage: qualify-plan-snapshots.js <absolute-native-binary> <absolute-native-crate-root>
 * The caller builds/freezes the candidate first. No install, renderer service,
 * foreign checkout mutation, PID discovery, or process signal occurs here.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';

type Data = Record<string, unknown>;
type Request = {
  canonicalProject: string;
  surface: 'codex';
  sessionId: string;
  transcriptPath: string;
  action: { kind: 'produce'; planPath: string } | { kind: 'finalize' };
};
type Receipt = {
  label: string;
  directory: string;
  pid: number | null;
  startedAt: string;
  state: 'running' | 'closed' | 'close_unconfirmed';
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError: string | null;
  stdinError: string | null;
  closeConfirmed: boolean;
  timedOut: boolean;
  endedAt: string | null;
};
type Started = { child: ChildProcess; done: Promise<Receipt>; receipt: Receipt };
type Captured = {
  name: string;
  kind: 'directory' | 'file';
  dev: string;
  ino: string;
  mode: string;
  uid: string;
  links: string;
  mtimeNs: string;
  ctimeNs: string;
  bytes: number;
  sha256?: string;
};
const CHILD_OBSERVATION_MS = 6000;
const QUALIFIER_MS = 90000;
const MAX_ENTRIES = 2048;
const MAX_ARTIFACT_FILE_BYTES = 1024 * 1024;
const sha = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
function object(value: unknown): Data {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'expected JSON object'
  );
  return value as Data;
}
function put(file: string, bytes: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
}
function json(file: string, value: unknown): void {
  put(file, JSON.stringify(value, null, 2) + '\n');
}
function directory(file: string): void {
  fs.mkdirSync(file, { recursive: true, mode: 0o700 });
  fs.chmodSync(file, 0o700);
}
function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? String(error)) : String(error);
}
assert(process.argv.length === 4, 'absolute native binary and native crate root required');
const suppliedNative = process.argv[2]!;
const suppliedCrate = process.argv[3]!;
assert(
  path.isAbsolute(suppliedNative) && path.isAbsolute(suppliedCrate),
  'arguments must be absolute'
);
const native = fs.realpathSync(suppliedNative);
const crate = fs.realpathSync(suppliedCrate);
assert(fs.statSync(native).isFile(), 'native executable is not a file');
assert(fs.statSync(native).size <= 256 * 1024 * 1024, 'native candidate exceeds fingerprint bound');
fs.accessSync(native, fs.constants.X_OK);
const nativeSha256 = sha(fs.readFileSync(native));
const root = path.join(
  crate,
  'target/qualification',
  'plan-snapshots-' + new Date().toISOString().replace(/[:.]/g, '-')
);
fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
fs.mkdirSync(root, { mode: 0o700 });
const sandbox = path.join(root, 'sandbox');
directory(sandbox);
const home = path.join(sandbox, 'machine');
const otherHome = path.join(sandbox, 'other-machine');
const user = path.join(sandbox, 'user');
const templates = path.join(sandbox, 'git-templates');
for (const item of [home, otherHome, user, templates]) directory(item);
const projects = [path.join(sandbox, 'project-a'), path.join(sandbox, 'project-b')] as const;
for (const project of projects) {
  directory(project);
  directory(path.join(project, '.caws/plans'));
}
directory(path.join(user, '.codex/plans'));
const environment: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: user,
  LANG: 'C',
  TZ: 'UTC',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TEMPLATE_DIR: templates,
};
const expires = Date.now() + QUALIFIER_MS;
const children: Started[] = [];
const scenarios: Data[] = [];
const manifest: Data = {
  schema: 'caws.qualification.plan-snapshots.v1',
  state: 'running',
  root,
  sandbox,
  native: { path: native, sha256: nativeSha256 },
  qualifier: { path: __filename, sha256: sha(fs.readFileSync(__filename)) },
  limits: {
    helperExecutionMs: 2000,
    childCloseObservationMs: CHILD_OBSERVATION_MS,
    qualifierMs: QUALIFIER_MS,
  },
  scenarios,
  nonclaims: [
    'shared producer or shared wrapper adoption',
    'selected renderer hook integration',
    'machine installation',
    'full native PID or guard parity',
    'power-loss or actual process-crash recovery',
    'arbitrary same-UID hostile writer exclusion',
    'permanent destination owner reuse or legacy migration',
  ],
};
put(path.join(root, 'executed-qualifier.js'), fs.readFileSync(__filename));
function persist(): void {
  json(path.join(root, 'manifest.json'), manifest);
}
function budget(): void {
  assert(Date.now() < expires, 'qualifier observation deadline expired; fixture retained');
}
let commandOrdinal = 0;
function start(
  label: string,
  executable: string,
  args: string[],
  cwd: string,
  input: Buffer
): Started {
  budget();
  assert(path.isAbsolute(executable), 'subprocess executable must be explicit absolute path');
  if (executable === native)
    assert.equal(sha(fs.readFileSync(native)), nativeSha256, 'native candidate bytes changed');
  const commandDirectory = path.join(
    root,
    'commands',
    String(++commandOrdinal).padStart(3, '0') + '-' + label
  );
  directory(commandDirectory);
  json(path.join(commandDirectory, 'command.json'), {
    executable,
    args,
    cwd,
    environment,
    executableSha256: sha(fs.readFileSync(executable)),
    nativeSha256,
    stdinSha256: sha(input),
    stdinBytes: input.length,
  });
  put(path.join(commandDirectory, 'stdin.bin'), input);
  const output = fs.openSync(path.join(commandDirectory, 'stdout.bin'), 'wx', 0o600);
  const errorOutput = fs.openSync(path.join(commandDirectory, 'stderr.bin'), 'wx', 0o600);
  let child: ChildProcess;
  try {
    child = spawn(executable, args, {
      cwd,
      env: environment,
      stdio: ['pipe', output, errorOutput],
      detached: false,
    });
  } finally {
    fs.closeSync(output);
    fs.closeSync(errorOutput);
  }
  const receipt: Receipt = {
    label,
    directory: commandDirectory,
    pid: child.pid ?? null,
    startedAt: new Date().toISOString(),
    state: 'running',
    code: null,
    signal: null,
    spawnError: null,
    stdinError: null,
    closeConfirmed: false,
    timedOut: false,
    endedAt: null,
  };
  const done = new Promise<Receipt>((resolve) => {
    child.once('error', (error) => {
      receipt.spawnError = describe(error);
      json(path.join(commandDirectory, 'receipt.json'), receipt);
    });
    child.once('close', (code, signal) => {
      receipt.state = 'closed';
      receipt.code = code;
      receipt.signal = signal;
      receipt.closeConfirmed = true;
      receipt.endedAt = new Date().toISOString();
      json(path.join(commandDirectory, 'receipt.json'), receipt);
      persist();
      resolve(receipt);
    });
  });
  child.stdin?.on('error', (error) => {
    receipt.stdinError = describe(error);
    json(path.join(commandDirectory, 'receipt.json'), receipt);
  });
  const started = { child, done, receipt };
  children.push(started);
  json(path.join(commandDirectory, 'receipt.json'), receipt);
  child.stdin?.end(input);
  return started;
}
async function closed(started: Started): Promise<Receipt> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      started.done,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            started.receipt.state = 'close_unconfirmed';
            started.receipt.timedOut = true;
            json(path.join(started.receipt.directory, 'receipt.json'), started.receipt);
            reject(
              new Error(
                'direct child close unconfirmed; no signal sent; stop scenario chain: ' +
                  started.receipt.label
              )
            );
          },
          Math.max(1, Math.min(CHILD_OBSERVATION_MS, expires - Date.now()))
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
function expectReceipt(receipt: Receipt, code: number): void {
  assert(
    receipt.closeConfirmed && !receipt.timedOut,
    'child close must be known within observation bound'
  );
  assert.equal(receipt.spawnError, null);
  assert.equal(receipt.stdinError, null);
  assert.equal(receipt.signal, null);
  assert.equal(
    receipt.code,
    code,
    fs.readFileSync(path.join(receipt.directory, 'stderr.bin'), 'utf8')
  );
}
function stdout(receipt: Receipt): Data {
  return object(JSON.parse(fs.readFileSync(path.join(receipt.directory, 'stdout.bin'), 'utf8')));
}
function stderr(receipt: Receipt): string {
  return fs.readFileSync(path.join(receipt.directory, 'stderr.bin'), 'utf8');
}
function requestArgs(request: Request, machineHome = home): string[] {
  return [
    'plan-snapshots',
    '--home',
    machineHome,
    '--checkout',
    request.canonicalProject,
    '--legacy-user-home',
    user,
  ];
}
function launch(label: string, request: Request, machineHome = home): Started {
  return start(
    label,
    native,
    requestArgs(request, machineHome),
    request.canonicalProject,
    Buffer.from(JSON.stringify(request))
  );
}
async function invoke(
  label: string,
  request: Request,
  code = 0,
  machineHome = home
): Promise<Receipt> {
  const receipt = await closed(launch(label, request, machineHome));
  expectReceipt(receipt, code);
  return receipt;
}
function stop(request: Request): Request {
  return { ...request, action: { kind: 'finalize' } };
}
function snapshot(request: Request): string {
  assert.equal(request.action.kind, 'produce');
  assert('planPath' in request.action);
  return request.action.planPath.slice(0, -3) + '.transcript.jsonl';
}
function fixture(project: string, sessionId: string, label: string): Request {
  const plan = path.join(project, '.caws/plans', label + '.md');
  put(plan, '# Private qualification plan: ' + label + '\n');
  const transcript = path.join(sandbox, 'transcripts', label + '.jsonl');
  put(
    transcript,
    JSON.stringify({ sessionId, project, plan, phase: 'presented', fixture: label }) + '\n'
  );
  return {
    canonicalProject: project,
    surface: 'codex',
    sessionId,
    transcriptPath: transcript,
    action: { kind: 'produce', planPath: plan },
  };
}
function append(request: Request, phase: string): void {
  fs.appendFileSync(
    request.transcriptPath,
    JSON.stringify({ sessionId: request.sessionId, phase }) + '\n'
  );
}
function sameIdentity(before: fs.BigIntStats, after: fs.BigIntStats): void {
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
}
function equalSnapshot(request: Request): void {
  assert.deepEqual(fs.readFileSync(snapshot(request)), fs.readFileSync(request.transcriptPath));
}
function allFiles(directoryPath: string): string[] {
  if (!fs.existsSync(directoryPath)) return [];
  const result: string[] = [];
  function visit(current: string): void {
    budget();
    for (const name of fs.readdirSync(current).sort()) {
      assert(result.length < MAX_ENTRIES, 'file inventory bound exceeded');
      const file = path.join(current, name),
        stat = fs.lstatSync(file);
      assert(!stat.isSymbolicLink(), 'unexpected fixture symlink: ' + file);
      if (stat.isDirectory()) visit(file);
      else {
        assert(stat.isFile(), 'unexpected fixture object');
        result.push(file);
      }
    }
  }
  visit(directoryPath);
  return result;
}
function tickets(request: Request, machineHome = home): string[] {
  return allFiles(path.join(machineHome, 'state/plan-snapshots/v1/owners')).filter((file) => {
    if (path.extname(file) !== '.json' || path.basename(path.dirname(file)) !== 'pending')
      return false;
    const ticket = object(JSON.parse(fs.readFileSync(file, 'utf8'))),
      claim = object(ticket.claim),
      owner = object(claim.owner);
    return (
      owner.canonicalProject === request.canonicalProject &&
      owner.surface === request.surface &&
      owner.sessionId === request.sessionId
    );
  });
}
function claims(destination: string): string[] {
  return allFiles(path.join(path.dirname(destination), '.caws-plan-snapshot-custody/v1')).filter(
    (file) =>
      path.basename(file) === 'owner.json' &&
      object(JSON.parse(fs.readFileSync(file, 'utf8'))).snapshot === destination
  );
}
let checkpointOrdinal = 0;
function checkpoint(label: string): string {
  budget();
  const destination = path.join(
    root,
    'checkpoints',
    String(++checkpointOrdinal).padStart(3, '0') + '-' + label
  );
  const entries: Captured[] = [];
  function visit(file: string): void {
    budget();
    assert(entries.length < MAX_ENTRIES, 'checkpoint entry bound exceeded');
    const stat = fs.lstatSync(file, { bigint: true });
    assert(!stat.isSymbolicLink(), 'checkpoint refuses symlink');
    const name = path.relative(sandbox, file);
    const row: Captured = {
      name,
      kind: stat.isDirectory() ? 'directory' : 'file',
      dev: String(stat.dev),
      ino: String(stat.ino),
      mode: '0' + (stat.mode & 0o7777n).toString(8),
      uid: String(stat.uid),
      links: String(stat.nlink),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
      bytes: Number(stat.size),
    };
    if (stat.isDirectory()) {
      entries.push(row);
      for (const child of fs.readdirSync(file).sort()) {
        if (child !== '.git') visit(path.join(file, child));
      }
    } else {
      assert(
        stat.isFile() && stat.size <= BigInt(MAX_ARTIFACT_FILE_BYTES),
        'checkpoint regular-file/byte bound'
      );
      const bytes = fs.readFileSync(file);
      row.sha256 = sha(bytes);
      sameIdentity(stat, fs.lstatSync(file, { bigint: true }));
      put(path.join(destination, 'bytes', name), bytes);
      entries.push(row);
    }
  }
  for (const fixtureRoot of [
    home,
    otherHome,
    user,
    ...projects,
    path.join(sandbox, 'transcripts'),
  ]) {
    if (fs.existsSync(fixtureRoot)) visit(fixtureRoot);
  }
  json(path.join(destination, 'inventory.json'), entries);
  return path.relative(root, destination);
}
async function scenario(label: string, action: (result: Data) => Promise<void>): Promise<void> {
  budget();
  const result: Data = {
    label,
    state: 'running',
    startedAt: new Date().toISOString(),
    before: checkpoint(label + '-before'),
  };
  scenarios.push(result);
  persist();
  try {
    await action(result);
    result.after = checkpoint(label + '-after');
    result.state = 'passed';
    result.endedAt = new Date().toISOString();
    persist();
  } catch (error) {
    result.state = 'failed';
    result.error = describe(error);
    result.endedAt = new Date().toISOString();
    if (children.every((child) => child.receipt.closeConfirmed))
      result.after = checkpoint(label + '-failure');
    persist();
    throw error;
  }
}
async function main(): Promise<void> {
  persist();
  const git = fs.realpathSync('/usr/bin/git');
  for (const project of projects) {
    const receipt = await closed(
      start(
        path.basename(project) + '-git-init',
        git,
        ['init', '--quiet', '--template=' + templates, project],
        sandbox,
        Buffer.alloc(0)
      )
    );
    expectReceipt(receipt, 0);
    assert(fs.statSync(path.join(project, '.git')).isDirectory());
  }
  json(
    path.join(root, 'repositories.json'),
    projects.map((project) => ({
      project,
      gitDirectory: path.join(project, '.git'),
      head: fs.readFileSync(path.join(project, '.git/HEAD'), 'utf8'),
      inode: String(fs.statSync(path.join(project, '.git'), { bigint: true }).ino),
    }))
  );
  const roundtrip = fixture(projects[0], 'roundtrip-owner', 'roundtrip');
  await scenario('initial-final-bytes', async (result) => {
    const initial = fs.readFileSync(roundtrip.transcriptPath);
    const produced = await invoke('roundtrip-produce', roundtrip);
    assert.equal(stdout(produced).produced, 1);
    assert.deepEqual(fs.readFileSync(snapshot(roundtrip)), initial);
    assert.equal(tickets(roundtrip).length, 1);
    result.initial = checkpoint('initial-bytes');
    const sourceIdentity = fs.lstatSync(roundtrip.transcriptPath, { bigint: true });
    append(roundtrip, 'approved');
    sameIdentity(sourceIdentity, fs.lstatSync(roundtrip.transcriptPath, { bigint: true }));
    const finalized = await invoke('roundtrip-finalize', stop(roundtrip));
    assert.equal(stdout(finalized).finalized, 1);
    equalSnapshot(roundtrip);
    assert.equal(tickets(roundtrip).length, 0);
    result.established =
      'initial and append-finalized snapshot bytes equal their explicit original transcript; ticket acknowledged';
  });
  await scenario('native-owned-repeat-generation', async (result) => {
    append(roundtrip, 'second-plan-presentation');
    assert.equal(stdout(await invoke('repeat-produce', roundtrip)).produced, 1);
    equalSnapshot(roundtrip);
    assert.equal(tickets(roundtrip).length, 1);
    result.presented = checkpoint('repeat-presented');
    append(roundtrip, 'second-turn-complete');
    assert.equal(stdout(await invoke('repeat-finalize', stop(roundtrip))).finalized, 1);
    equalSnapshot(roundtrip);
    assert.equal(tickets(roundtrip).length, 0);
    result.established =
      'same native owner and original transcript inode support a new ticket generation';
  });
  const isolatedA = fixture(projects[0], 'shared-id', 'isolation-a');
  const isolatedB = fixture(projects[1], 'shared-id', 'isolation-b');
  await scenario('independent-repositories-same-session-id', async (result) => {
    const started = [
      launch('isolation-a-produce', isolatedA),
      launch('isolation-b-produce', isolatedB),
    ];
    const settled = await Promise.allSettled(started.map(closed));
    for (const item of settled) {
      assert.equal(item.status, 'fulfilled');
      if (item.status === 'fulfilled') expectReceipt(item.value, 0);
    }
    equalSnapshot(isolatedA);
    equalSnapshot(isolatedB);
    const bInitial = fs.readFileSync(snapshot(isolatedB));
    append(isolatedA, 'a-final');
    append(isolatedB, 'b-final');
    assert.equal(stdout(await invoke('isolation-a-finalize', stop(isolatedA))).finalized, 1);
    equalSnapshot(isolatedA);
    assert.deepEqual(fs.readFileSync(snapshot(isolatedB)), bInitial);
    assert.equal(tickets(isolatedB).length, 1);
    result.afterFirstFinalize = checkpoint('isolation-after-a-only');
    assert.equal(stdout(await invoke('isolation-b-finalize', stop(isolatedB))).finalized, 1);
    equalSnapshot(isolatedB);
    assert.equal(tickets(isolatedA).length, 0);
    assert.equal(tickets(isolatedB).length, 0);
    result.established =
      'same session ID in distinct actual repositories retains independent pending tickets and snapshot bytes';
  });
  const ownerless = fixture(projects[0], 'ownerless-probe', 'ownerless');
  const legacyList = path.join(user, '.codex/.pending-plan-snapshots');
  put(snapshot(ownerless), 'preexisting legacy snapshot bytes\n');
  put(legacyList, snapshot(ownerless) + '\n');
  await scenario('legacy-ownerless-list-preserved-diagnosed', async (result) => {
    const beforeList = fs.readFileSync(legacyList),
      beforeSnapshot = fs.readFileSync(snapshot(ownerless));
    const listIdentity = fs.lstatSync(legacyList, { bigint: true }),
      snapshotIdentity = fs.lstatSync(snapshot(ownerless), { bigint: true });
    const receipt = await invoke('legacy-list-observe', stop(ownerless));
    assert.equal(stdout(receipt).finalized, 0);
    assert.match(
      stderr(receipt),
      /legacy ownerless pending plan snapshots preserved; explicit provenance migration required/
    );
    assert.deepEqual(fs.readFileSync(legacyList), beforeList);
    assert.deepEqual(fs.readFileSync(snapshot(ownerless)), beforeSnapshot);
    sameIdentity(listIdentity, fs.lstatSync(legacyList, { bigint: true }));
    sameIdentity(snapshotIdentity, fs.lstatSync(snapshot(ownerless), { bigint: true }));
    result.established =
      'ownerless legacy carrier and target bytes/inodes preserved; fixed diagnostic observable on stderr';
  });
  await scenario('preexisting-ownerless-snapshot-refused', async (result) => {
    const before = fs.readFileSync(snapshot(ownerless)),
      identity = fs.lstatSync(snapshot(ownerless), { bigint: true }),
      carrier = fs.readFileSync(legacyList);
    assert.equal(claims(snapshot(ownerless)).length, 0);
    assert.equal(tickets(ownerless).length, 0);
    const receipt = await invoke('ownerless-destination-refuse', ownerless, 75);
    assert.match(
      stderr(receipt),
      /preexisting snapshot has no native owner; explicit adoption required/
    );
    assert.deepEqual(fs.readFileSync(snapshot(ownerless)), before);
    sameIdentity(identity, fs.lstatSync(snapshot(ownerless), { bigint: true }));
    assert.deepEqual(fs.readFileSync(legacyList), carrier);
    assert.equal(claims(snapshot(ownerless)).length, 0);
    assert.equal(tickets(ownerless).length, 0);
    result.established =
      'legacy-listed preexisting snapshot refused before ownership claim or ticket publication';
  });
  const alias = fixture(projects[1], 'alias-owner', 'alias');
  alias.transcriptPath = snapshot(alias);
  put(alias.transcriptPath, 'source and destination must remain this inode\n');
  await scenario('source-destination-alias-refused', async (result) => {
    const before = fs.readFileSync(alias.transcriptPath),
      identity = fs.lstatSync(alias.transcriptPath, { bigint: true });
    const receipt = await invoke('source-destination-alias-refuse', alias, 75);
    assert.match(stderr(receipt), /transcript source aliases snapshot destination/);
    assert.deepEqual(fs.readFileSync(alias.transcriptPath), before);
    sameIdentity(identity, fs.lstatSync(alias.transcriptPath, { bigint: true }));
    assert.equal(tickets(alias).length, 0);
    assert.equal(claims(snapshot(alias)).length, 0);
    result.established =
      'source/destination alias refused with original inode and bytes intact and no claim or ticket';
  });
  const homeARequest = fixture(projects[1], 'home-a-owner', 'shared-target-different-homes');
  const homeBRequest: Request = {
    ...homeARequest,
    sessionId: 'home-b-owner',
    transcriptPath: path.join(sandbox, 'transcripts/different-home-owner-b.jsonl'),
  };
  put(
    homeBRequest.transcriptPath,
    JSON.stringify({
      sessionId: homeBRequest.sessionId,
      phase: 'different-home competing producer',
    }) + '\n'
  );
  await scenario('different-homes-one-destination-custody', async (result) => {
    const contexts = [
      { request: homeARequest, home },
      { request: homeBRequest, home: otherHome },
    ];
    const started = contexts.map((context, index) =>
      launch('different-home-produce-' + index, context.request, context.home)
    );
    const settled = await Promise.allSettled(started.map(closed));
    const receipts: Receipt[] = [];
    for (const item of settled) {
      assert.equal(item.status, 'fulfilled');
      if (item.status === 'fulfilled') receipts.push(item.value);
    }
    assert.deepEqual(
      receipts.map((receipt) => receipt.code).sort(),
      [0, 75],
      'different homes must share one target custody winner'
    );
    for (const receipt of receipts) expectReceipt(receipt, receipt.code === 0 ? 0 : 75);
    const winnerIndex = receipts.findIndex((receipt) => receipt.code === 0);
    assert(winnerIndex === 0 || winnerIndex === 1);
    const winner = contexts[winnerIndex]!,
      loser = contexts[1 - winnerIndex]!;
    assert.equal(stdout(receipts[winnerIndex]!).produced, 1);
    assert.match(
      stderr(receipts[1 - winnerIndex]!),
      /snapshot destination has another owner; explicit maintenance required/
    );
    equalSnapshot(winner.request);
    assert.equal(tickets(winner.request, winner.home).length, 1);
    assert.equal(tickets(loser.request, loser.home).length, 0);
    assert.equal(claims(snapshot(winner.request)).length, 1);
    const identity = fs.lstatSync(snapshot(winner.request), { bigint: true }),
      bytes = fs.readFileSync(snapshot(winner.request));
    const losingRetry = await invoke('different-home-loser-retry', loser.request, 75, loser.home);
    assert.match(
      stderr(losingRetry),
      /snapshot destination has another owner; explicit maintenance required/
    );
    sameIdentity(identity, fs.lstatSync(snapshot(winner.request), { bigint: true }));
    assert.deepEqual(fs.readFileSync(snapshot(winner.request)), bytes);
    assert.equal(tickets(loser.request, loser.home).length, 0);
    assert.equal(tickets(winner.request, winner.home).length, 1);
    result.winner = { ...winner, receipt: receipts[winnerIndex] };
    result.loser = { ...loser, receipt: receipts[1 - winnerIndex], retry: losingRetry };
    result.established =
      'different explicit machine homes contend on one destination-anchored custody claim; foreign loser preserves winner bytes/inode and gains no pending ticket';
  });
  assert(
    children.every((child) => child.receipt.closeConfirmed && !child.receipt.timedOut),
    'owned child close unavailable'
  );
  manifest.state = 'passed';
  manifest.endedAt = new Date().toISOString();
  manifest.cleanup = {
    state: 'direct_children_closed',
    commands: children.map((child) => child.receipt),
    signalsSent: [],
  };
  manifest.finalCheckpoint = checkpoint('final');
  persist();
  const artifacts = allFiles(root)
    .filter(
      (file) =>
        !file.startsWith(sandbox + path.sep) && path.basename(file) !== 'artifact-manifest.json'
    )
    .map((file) => ({
      path: path.relative(root, file),
      bytes: fs.statSync(file).size,
      sha256: sha(fs.readFileSync(file)),
    }));
  json(path.join(root, 'artifact-manifest.json'), artifacts);
  process.stdout.write(
    JSON.stringify({
      state: manifest.state,
      root,
      scenarios: scenarios.length,
      directChildrenClosed: children.length,
    }) + '\n'
  );
}
main().catch((error) => {
  manifest.state = 'failed';
  manifest.error = describe(error);
  manifest.endedAt = new Date().toISOString();
  manifest.cleanup = {
    state: children.every((child) => child.receipt.closeConfirmed)
      ? 'direct_children_closed'
      : 'close_unconfirmed',
    commands: children.map((child) => child.receipt),
    signalsSent: [],
  };
  try {
    persist();
  } catch (retentionError) {
    process.stderr.write('Failure evidence retention failed: ' + describe(retentionError) + '\n');
  }
  process.stderr.write(describe(error) + '\nArtifact root: ' + root + '\n');
  process.exitCode = 1;
});
