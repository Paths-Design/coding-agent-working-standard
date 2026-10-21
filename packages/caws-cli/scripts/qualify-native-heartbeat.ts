/** Private full-stock-chain behavioral qualification. Build/run explicitly after review.
 * Usage: <reviewed Node> qualify-native-heartbeat.js <reviewed-profile.json> <new-artifact-root>
 * No global adoption, startup instrumentation, production telemetry, proposed-command execution,
 * process census claim, or candidate-derived expected identity is performed here.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { RenderHarness, type Data, type Receipt } from './render-qualification-harness';

type TreeIdentity = { root: string; files: Record<string, string> };
interface ReviewedProfile {
  schema: 'caws.native-heartbeat.reviewed-profile.v1';
  reviewReference: string;
  cli: string;
  native: string;
  observer: string;
  git: string;
  caws: string;
  path: string;
  expected: {
    files: Record<string, string>;
    source: TreeIdentity;
    dist: TreeIdentity;
    templates: TreeIdentity;
    dependencies: TreeIdentity[];
    runtimeDigest: string;
    runtimeFiles: Record<string, string>;
    stockPreToolEntries: string[];
  };
  laterRefusal: { command: string; handler: string };
  diagnosticCoverage?: boolean;
}
const object = (value: unknown): value is Data =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function put(file: string, bytes: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
}
const json = (file: string, value: unknown): void =>
  put(file, JSON.stringify(value, null, 2) + '\n');
function readJson(file: string): Data {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(object(value), file);
  return value;
}
function readStable(file: string): Buffer {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const before = fs.fstatSync(fd);
    assert(
      before.isFile() && before.size <= 128 * 1024 * 1024,
      'bounded regular identity file: ' + file
    );
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd),
      named = fs.lstatSync(file);
    assert(!named.isSymbolicLink());
    assert.deepEqual(
      [after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs],
      [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs]
    );
    assert.equal(named.dev, before.dev);
    assert.equal(named.ino, before.ino);
    assert.equal(bytes.length, before.size);
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
function tree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string, prefix: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name),
        relative = prefix + name,
        stat = fs.lstatSync(file);
      assert(
        !stat.isSymbolicLink(),
        'identity tree needs explicit resolved dependency roots: ' + file
      );
      if (stat.isDirectory()) visit(file, relative + '/');
      else {
        assert(stat.isFile());
        result[relative] = sha(readStable(file));
      }
    }
  };
  visit(root, '');
  return result;
}
function verifyTree(expected: TreeIdentity): Data {
  assert(path.isAbsolute(expected.root));
  assert.equal(
    fs.realpathSync(expected.root),
    expected.root,
    'reviewed tree root must be resolved'
  );
  const actual = tree(expected.root);
  assert.deepEqual(actual, expected.files, 'reviewed tree drift: ' + expected.root);
  return { root: expected.root, files: actual };
}
function records(file: string): Data[] {
  if (!fs.existsSync(file)) return [];
  const bytes = readStable(file);
  assert(bytes.length === 0 || bytes.at(-1) === 10, 'partial ledger: ' + file);
  return bytes
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const value: unknown = JSON.parse(line);
      assert(object(value));
      return value;
    });
}
function contextText(bytes: Buffer): string {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  assert(object(value));
  const specific = value.hookSpecificOutput;
  return object(specific) && typeof specific.additionalContext === 'string'
    ? specific.additionalContext
    : '';
}
let artifactRoot: string | null = null;
const quote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";

async function main(): Promise<void> {
  assert(process.argv.length === 4, 'reviewed profile and NEW artifact root required');
  const profileFile = path.resolve(process.argv[2]!),
    requestedRoot = path.resolve(process.argv[3]!);
  assert(!fs.existsSync(requestedRoot));
  fs.mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(requestedRoot);
  artifactRoot = root;
  const profileBytes = readStable(profileFile);
  put(path.join(root, 'reviewed-profile.bin'), profileBytes);
  const profile = JSON.parse(profileBytes.toString('utf8')) as ReviewedProfile;
  assert.equal(profile.schema, 'caws.native-heartbeat.reviewed-profile.v1');
  assert(profile.reviewReference && profile.expected.dependencies.length > 0);
  assert(
    profile.path.split(path.delimiter).every((part) => part && path.isAbsolute(part)),
    'eligible PATH components must all be nonempty and absolute'
  );
  const cli = fs.realpathSync(profile.cli),
    engine = path.join(cli, 'dist/runtime/engine-entry.js');
  const qualifierArtifacts = [
    __filename,
    require.resolve('./render-qualification-harness'),
    require.resolve('./render-request-custody'),
    require.resolve('./render-request-topology'),
    require.resolve('../src/runtime/json-custody'),
  ];
  const required = [
    ...qualifierArtifacts,
    process.execPath,
    profile.native,
    profile.observer,
    profile.git,
    profile.caws,
    path.join(cli, 'package.json'),
    path.join(cli, 'dist/index.js'),
    engine,
    path.join(cli, 'dist/runtime/agent-heartbeat.js'),
    path.join(cli, 'dist/application/agent-heartbeat.js'),
    path.join(cli, 'dist/application/message-poll.js'),
  ];
  for (const executable of [
    process.execPath,
    profile.native,
    profile.observer,
    profile.git,
    profile.caws,
  ])
    fs.accessSync(executable, fs.constants.X_OK);
  const actualFiles: Record<string, string> = {};
  for (const file of required) {
    assert(path.isAbsolute(file));
    assert(profile.expected.files[file], 'reviewed identity missing: ' + file);
  }
  assert(
    Object.keys(profile.expected.files).some((file) =>
      /\/(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(file)
    ),
    'reviewed dependency lock required'
  );
  for (const [file, expected] of Object.entries(profile.expected.files)) {
    assert(/^[a-f0-9]{64}$/.test(expected));
    actualFiles[file] = sha(readStable(file));
    assert.equal(actualFiles[file], expected, file);
  }
  assert(path.isAbsolute(profile.expected.source.root));
  for (const file of [
    'runtime/agent-heartbeat.ts',
    'runtime/stock-handlers.ts',
    'runtime/handler-executor.ts',
    'application/agent-heartbeat.ts',
    'application/message-poll.ts',
  ])
    assert(profile.expected.source.files[file], 'reviewed source omitted: ' + file);
  assert.equal(
    fs.realpathSync(profile.caws),
    fs.realpathSync(path.join(cli, 'dist/index.js')),
    'eligible caws must be the genuine supplied package bin'
  );
  assert.equal(fs.realpathSync(profile.expected.dist.root), path.join(cli, 'dist'));
  assert.equal(
    fs.realpathSync(profile.expected.templates.root),
    path.join(cli, 'templates/hook-packs')
  );
  const identities = {
    files: actualFiles,
    source: verifyTree(profile.expected.source),
    dist: verifyTree(profile.expected.dist),
    templates: verifyTree(profile.expected.templates),
    dependencies: profile.expected.dependencies.map(verifyTree),
  };
  json(path.join(root, 'reviewed-identity-readback.json'), identities);
  const requireBuilt = createRequire(path.join(cli, 'package.json'));
  const machine = requireBuilt(
    path.join(cli, 'dist/init/machine-adapters')
  ) as typeof import('../src/init/machine-adapters');
  const selectionApi = requireBuilt(
    path.join(cli, 'dist/runtime/selection')
  ) as typeof import('../src/runtime/selection');
  const messageApi = requireBuilt(
    path.join(cli, 'dist/store/messages-store')
  ) as typeof import('../src/store/messages-store');
  const sandbox = path.join(root, 'fixtures'),
    home = path.join(root, 'machine'),
    user = path.join(root, 'user'),
    capture = path.join(root, 'capture');
  for (const directory of [sandbox, home, user, capture, path.join(root, 'tmp')])
    fs.mkdirSync(directory, { mode: 0o700 });
  const environment: NodeJS.ProcessEnv = {
    PATH: profile.path,
    HOME: user,
    CAWS_HOME: home,
    TMPDIR: path.join(root, 'tmp'),
    CAWS_AGENT_SURFACE: 'codex',
    LC_ALL: 'C',
    TZ: 'UTC',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  // No caws wrapper is inserted into the eligible PATH. Its reviewed executable is an external prerequisite.
  const installed = machine.installMachineRuntime({
    home,
    templatesRoot: path.join(cli, 'templates/hook-packs'),
  });
  assert.equal(
    installed.digest,
    profile.expected.runtimeDigest,
    'installed runtime differs from reviewed identity'
  );
  const runtime = path.join(home, 'lib/runtimes', installed.digest);
  assert.deepEqual(tree(runtime), profile.expected.runtimeFiles, 'installed runtime bytes differ');
  const defaults = readJson(path.join(runtime, 'system-policy.json'));
  assert(object(defaults.events) && Array.isArray(defaults.events.pre_tool_use));
  assert.deepEqual(
    defaults.events.pre_tool_use,
    profile.expected.stockPreToolEntries,
    'reviewed full stock chain differs'
  );
  json(path.join(root, 'installation.json'), installed);
  // Private system settings only; project governance below is created through the public CLI.
  json(path.join(home, 'surfaces/codex/settings.json'), { version: 1, enabled: true });
  const h = new RenderHarness({
    cli,
    label: 'native-heartbeat',
    capture: {
      root: capture,
      sandbox,
      home,
      native: profile.native,
      observer: profile.observer,
      environment,
      installed,
      tools: [process.execPath, profile.native, profile.observer, profile.git, profile.caws].map(
        (file) => ({ name: path.basename(file), path: file, sha256: actualFiles[file]! })
      ),
    },
  });
  const run = (
    name: string,
    executable: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv = environment,
    input?: string
  ): Receipt => {
    const receipt = h.run(name, executable, args, cwd, env, input);
    h.success(receipt);
    return receipt;
  };
  run('revision', profile.git, ['rev-parse', 'HEAD'], profile.expected.source.root);
  run('source-status', profile.git, ['status', '--short'], profile.expected.source.root);
  run('source-diff', profile.git, ['diff', '--binary', 'HEAD'], profile.expected.source.root);
  const effectiveCaws = run('effective-caws', '/usr/bin/which', ['caws'], sandbox);
  assert.equal(
    fs.realpathSync(
      fs.readFileSync(path.join(effectiveCaws.directory, 'stdout.bin'), 'utf8').trim()
    ),
    fs.realpathSync(profile.caws),
    'eligible PATH caws differs'
  );
  const effectiveNode = run('effective-node', '/usr/bin/which', ['node'], sandbox);
  assert.equal(
    fs.realpathSync(
      fs.readFileSync(path.join(effectiveNode.directory, 'stdout.bin'), 'utf8').trim()
    ),
    fs.realpathSync(process.execPath),
    'eligible PATH Node differs from frontend Node'
  );
  const effectiveTools: Record<string, string> = {
    node: fs.realpathSync(process.execPath),
    caws: fs.realpathSync(profile.caws),
  };
  for (const name of ['git', 'python3', 'jq']) {
    const receipt = run('effective-' + name, '/usr/bin/which', [name], sandbox);
    const file = fs.realpathSync(
      fs.readFileSync(path.join(receipt.directory, 'stdout.bin'), 'utf8').trim()
    );
    assert(profile.expected.files[file], 'reviewed effective dependency missing: ' + file);
    assert.equal(sha(readStable(file)), profile.expected.files[file]);
    effectiveTools[name] = file;
  }
  assert.equal(effectiveTools.git, fs.realpathSync(profile.git));
  json(path.join(root, 'effective-tools.json'), effectiveTools);
  function project(name: string): string {
    const repo = path.join(sandbox, name);
    fs.mkdirSync(repo, { mode: 0o700 });
    run(name + '-git-init', profile.git, ['-c', 'init.defaultBranch=main', 'init', '-q'], repo);
    put(path.join(repo, 'fixture.txt'), 'Private native heartbeat qualification fixture\n');
    run(name + '-git-add', profile.git, ['add', 'fixture.txt'], repo);
    run(
      name + '-git-commit',
      profile.git,
      [
        '-c',
        'user.name=Qualification',
        '-c',
        'user.email=qualification@example.invalid',
        'commit',
        '-qm',
        'fixture',
      ],
      repo
    );
    run(
      name + '-caws-init',
      process.execPath,
      [path.join(cli, 'dist/index.js'), 'init', '--agent-surface', 'none'],
      repo
    );
    return repo;
  }
  const a = project('A'),
    b = project('B'),
    linked = path.join(sandbox, 'A-linked');
  run(
    'linked-checkout',
    profile.git,
    ['worktree', 'add', '-b', 'caws/heartbeat-qualification', linked],
    a
  );
  const sid = 'same-payload-session';
  function selected(checkout: string, canonical: string) {
    const value = selectionApi.resolveInvocationSelection({
      checkout,
      canonical,
      home,
      runtimeDigest: installed.digest,
      surface: 'codex',
      event: 'pre_tool_use',
      system: true,
    });
    assert.equal(value.status, 'active');
    assert(value.status === 'active');
    assert.deepEqual(
      value.handlers.map((handler) => handler.entry),
      profile.expected.stockPreToolEntries,
      'all stock guards must remain selected in order'
    );
    assert(
      value.handlers.length > 1 && value.handlers.every((handler) => handler.kind === 'stock')
    );
    assert.deepEqual(value.overrides, {});
    assert.deepEqual(value.libraryOverrides, {});
    assert(
      Object.values(value.libraries).every((library) =>
        ['shared', 'surface'].includes(library.kind)
      )
    );
    const heartbeat = value.handlers.findIndex((handler) => handler.name === 'agent-heartbeat.sh');
    const guard = value.handlers.findIndex(
      (handler) => handler.entry === profile.laterRefusal.handler
    );
    assert(heartbeat >= 0 && guard > heartbeat, 'refusal must be an existing later stock guard');
    assert.deepEqual(value.handlers[heartbeat]!.args, []);
    return value;
  }
  json(path.join(root, 'selection-A.json'), selected(linked, a));
  json(path.join(root, 'selection-B.json'), selected(b, b));
  const seedFile = path.join(root, 'seed.cjs');
  put(
    seedFile,
    `const path=require('node:path');const [cli,repo,to,text]=process.argv.slice(2);const r=require('node:module').createRequire(path.join(cli,'package.json'));
const activity=r(path.join(cli,'dist/application/agent-heartbeat'));const messages=r(path.join(cli,'dist/store/messages-store'));const git=r(path.join(cli,'dist/store/repo-root')).readGitDirInfo(repo);if(!git)throw Error('git context');
const heartbeat=activity.heartbeatAgentActivity({cawsDir:path.join(repo,'.caws'),identity:{session_id:'fixture-peer',platform:'codex'},context:{repo_root:repo,cwd:repo,...git,bound_worktree:'peer-lane',bound_spec_id:'PEER-SPEC',hook_pid:process.pid},now:()=>new Date(),reason:'pre_tool_use'});if(!heartbeat.ok)throw Error(JSON.stringify(heartbeat));
const sent=messages.sendMessage(path.join(repo,'.caws'),{actor:{kind:'agent',id:'fixture-peer',session_id:'fixture-peer'},to,text,urgency:'critical',requireLive:false});if(!sent.ok)throw Error(JSON.stringify(sent));process.stdout.write(JSON.stringify(sent.value)+'\\n');\n`
  );
  function seed(repo: string, text: string): string {
    const receipt = run('seed-message', process.execPath, [seedFile, cli, repo, sid, text], repo);
    const value = readJson(path.join(receipt.directory, 'stdout.bin'));
    assert(object(value.message) && typeof value.message.id === 'string');
    return value.message.id;
  }
  function snapshot(label: string): void {
    const index: Data = {};
    for (const [name, repo] of [
      ['A', a],
      ['A-linked', linked],
      ['B', b],
    ] as const) {
      for (const relative of ['.caws', '.codex']) {
        const directory = path.join(repo, relative);
        if (!fs.existsSync(directory)) continue;
        const identity = tree(directory);
        index[name + '/' + relative] = identity;
        // Index the retained copy, rather than an earlier read of a changing source.
        // This is a per-file capture; it is not an atomic multi-file snapshot.
        for (const file of Object.keys(identity)) {
          const bytes = readStable(path.join(directory, file));
          put(path.join(root, 'snapshots', label, name, relative, file), bytes);
          identity[file] = sha(bytes);
        }
      }
    }
    json(path.join(root, 'snapshots', label, 'index.json'), index);
  }
  const results: Data[] = [];
  let scenarioChainClosed = false;
  async function invoke(
    name: string,
    checkout: string,
    canonical: string,
    command: string,
    options: {
      missingSid?: boolean;
      customCli?: string;
      defaultCli?: boolean;
      pathOverride?: string;
      coverage?: boolean;
    } = {}
  ) {
    assert(!scenarioChainClosed, 'no native continuation after an uncorrelated final request');
    const expectedSelection = selected(checkout, canonical);
    snapshot(name + '-before');
    const env = {
      ...environment,
      PATH: options.pathOverride ?? environment.PATH,
      CAWS_SESSION_ID: sid,
      CODEX_THREAD_ID: sid,
      ...(options.customCli
        ? { CAWS_BIN: options.customCli }
        : options.defaultCli
          ? { CAWS_BIN: 'caws' }
          : {}),
    };
    if (options.coverage) {
      const directory = path.join(root, 'v8', name);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      Object.assign(env, { NODE_V8_COVERAGE: directory });
    }
    const payload = {
      cwd: checkout,
      tool_name: 'Bash',
      tool_input: { command },
      ...(options.missingSid ? {} : { session_id: sid }),
    };
    const started = h.start(
      name,
      profile.native,
      [
        'invoke',
        '--engine',
        engine,
        '--node',
        process.execPath,
        '--surface',
        'codex',
        '--event',
        'pre_tool_use',
        '--runtime-digest',
        installed.digest,
        '--timeout-ms',
        '30000',
        '--configuration',
        'system',
      ],
      checkout,
      env,
      JSON.stringify(payload),
      { traceSession: path.join(canonical, '.caws/sessions', sid), traceEvent: 'pre_tool_use' }
    );
    // Native frontend/custodian own their deadline and process groups. No replacement supervisor or qualifier signals.
    const receipt = await started.done;
    assert.equal(receipt.error, null);
    assert.equal(receipt.signal, null);
    assert(
      Number.isSafeInteger(started.child.pid) && started.child.pid! > 1,
      'actual frontend Child PID unavailable'
    );
    const stdout = fs.readFileSync(path.join(started.directory, 'stdout.bin'));
    const completion = h.requestCompletion(started); // Never convert missing coverage into confirmed cleanup.
    const journal = started.invocation?.rows ?? [];
    snapshot(name + '-after');
    const result = {
      name,
      receipt,
      frontendPid: started.child.pid,
      originalBirth: started.originalBirth,
      completion,
      journal,
      stdoutSha256: sha(stdout),
    };
    results.push(result);
    json(path.join(root, name + '-result.json'), result);
    if (options.missingSid)
      assert.equal(
        journal.length,
        0,
        'missing payload SID must not borrow another request journal'
      );
    else {
      const start = journal.find((entry) => entry.stage === 'invocation_started');
      assert(start, 'actual selected chain journal unavailable');
      assert.deepEqual(
        start.selected_handlers,
        expectedSelection.handlers,
        'actual native selection differs from reviewed full chain'
      );
    }
    if (options.missingSid) scenarioChainClosed = true;
    else
      assert.equal(
        completion.state,
        'confirmed_inactive',
        'ordinary request cleanup is unconfirmed; scenario chain stopped'
      );
    return { started, receipt, stdout, journal, completion };
  }
  const delivered = (repo: string, id: string): boolean => {
    const value = messageApi.getMessageDeliveryState(path.join(repo, '.caws'), id);
    assert(value.ok && value.value);
    return value.value.delivered;
  };
  function exactOffer(
    repo: string,
    messageId: string,
    outcome: 'delivered' | 'released',
    journal: Data[]
  ): void {
    const ledger = records(path.join(repo, '.caws/messages.jsonl'));
    const offered = ledger.filter(
      (entry) =>
        entry.record === 'offer' &&
        Array.isArray(entry.deliver_ids) &&
        entry.deliver_ids.includes(messageId)
    );
    assert.equal(offered.length, 1, 'exact offer occurrence required');
    const offer = offered[0]!;
    const settlements = ledger.filter(
      (entry) => entry.record === 'offer_settlement' && entry.offer_id === offer.offer_id
    );
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0]!.outcome, outcome);
    assert(
      journal.some(
        (entry) =>
          entry.stage === 'handler_completed' &&
          Array.isArray(entry.offers) &&
          entry.offers.some((value) => object(value) && value.offerId === offer.offer_id)
      ),
      'journal must retain the exact heartbeat offer identity'
    );
    assert(
      journal.some((entry) => entry.stage === 'adapter_stdout_handoff'),
      'actual native handoff receipt required'
    );
  }
  const firstId = seed(a, 'A-first-critical');
  snapshot('initial-seeded');
  const first = await invoke('A-linked-first', linked, a, 'true');
  assert.equal(first.receipt.code, 0);
  assert(contextText(first.stdout).includes('A-first-critical'));
  assert(contextText(first.stdout).includes('MULTI-AGENT NOTICE'));
  assert(delivered(a, firstId));
  exactOffer(a, firstId, 'delivered', first.journal);
  const firstLease = readJson(path.join(a, '.caws/leases', sid + '.json'));
  assert.equal(firstLease.hook_pid, first.started.child.pid);
  assert.equal(firstLease.cwd, linked);
  assert.equal(firstLease.repo_root, a);
  const firstActivityMs = Date.parse(String(firstLease.last_active));
  const firstHeartbeatStart = first.journal.find(
    (entry) => entry.stage === 'handler_started' && entry.handler === 'agent-heartbeat.sh'
  );
  const firstHeartbeatEnd = first.journal.find(
    (entry) => entry.stage === 'handler_completed' && entry.handler === 'agent-heartbeat.sh'
  );
  assert(
    Number.isFinite(firstActivityMs) &&
      firstHeartbeatStart &&
      firstHeartbeatEnd &&
      Number(firstHeartbeatStart.timestamp_ms) <= firstActivityMs &&
      firstActivityMs <= Number(firstHeartbeatEnd.timestamp_ms),
    'first lease activity must fall inside its actual heartbeat occurrence'
  );
  assert(fs.existsSync(path.join(linked, '.caws/leases/heartbeat-message-telemetry.jsonl')));
  assert(!fs.existsSync(path.join(a, '.caws/leases/heartbeat-message-telemetry.jsonl')));
  const secondId = seed(a, 'A-throttled-critical');
  const elapsed = Date.now() - firstActivityMs;
  assert(elapsed >= 0 && elapsed < 15000, 'cannot claim throttle outside the actual 15s interval');
  const second = await invoke('A-throttled-mail', linked, a, 'true');
  const secondHeartbeatStart = second.journal.find(
    (entry) => entry.stage === 'handler_started' && entry.handler === 'agent-heartbeat.sh'
  );
  assert(secondHeartbeatStart, 'actual throttled heartbeat occurrence required');
  const actualElapsed = Number(secondHeartbeatStart.timestamp_ms) - firstActivityMs;
  assert(
    actualElapsed >= 0 && actualElapsed < 15000,
    'actual heartbeat missed the throttle interval'
  );
  assert.equal(second.receipt.code, 0);
  assert(contextText(second.stdout).includes('A-throttled-critical'));
  assert.equal(
    readJson(path.join(a, '.caws/leases', sid + '.json')).last_active,
    firstLease.last_active
  );
  assert(delivered(a, secondId));
  exactOffer(a, secondId, 'delivered', second.journal);
  const aLeaseBeforeB = readStable(path.join(a, '.caws/leases', sid + '.json')),
    aLedgerBeforeB = readStable(path.join(a, '.caws/messages.jsonl'));
  const bId = seed(b, 'B-identical-session');
  const separate = await invoke('B-identical-session', b, b, 'true');
  assert.equal(separate.receipt.code, 0);
  assert(contextText(separate.stdout).includes('B-identical-session'));
  assert.equal(
    readJson(path.join(b, '.caws/leases', sid + '.json')).hook_pid,
    separate.started.child.pid
  );
  assert(delivered(b, bId));
  exactOffer(b, bId, 'delivered', separate.journal);
  assert(readStable(path.join(a, '.caws/leases', sid + '.json')).equals(aLeaseBeforeB));
  assert(readStable(path.join(a, '.caws/messages.jsonl')).equals(aLedgerBeforeB));
  const refusedId = seed(a, 'release-on-later-guard');
  const refused = await invoke('later-stock-refusal', linked, a, profile.laterRefusal.command);
  assert.equal(refused.receipt.code, 2);
  assert(!delivered(a, refusedId));
  exactOffer(a, refusedId, 'released', refused.journal);
  const refusalRow = refused.journal.find(
    (entry) => entry.stage === 'handler_completed' && entry.handler === profile.laterRefusal.handler
  );
  assert(refusalRow, 'reviewed later guard entry did not complete');
  if (refusalRow.exit_code !== 2) {
    assert(typeof refusalRow.stdout_base64 === 'string', 'guard protection bytes unavailable');
    const protection: unknown = JSON.parse(
      Buffer.from(refusalRow.stdout_base64, 'base64').toString('utf8')
    );
    assert(object(protection));
    assert(
      protection.decision === 'block' ||
        (object(protection.hookSpecificOutput) &&
          protection.hookSpecificOutput.permissionDecision === 'deny'),
      'reviewed guard did not emit a protective refusal'
    );
  }
  const witness = path.join(root, 'custom-cli-argv.txt'),
    custom = path.join(root, 'custom-caws');
  put(
    custom,
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> ' +
      quote(witness) +
      '\nexec ' +
      quote(profile.caws) +
      ' "$@"\n'
  );
  fs.chmodSync(custom, 0o700);
  const fallback = await invoke('custom-CLI-fallback', linked, a, 'true', { customCli: custom });
  assert.equal(fallback.receipt.code, 0);
  const calls = fs.readFileSync(witness, 'utf8').split('\n');
  assert(calls.some((line) => line.startsWith('agents heartbeat ')));
  assert(calls.some((line) => line.startsWith('message poll ')));
  json(path.join(root, 'custom-cli-control.json'), {
    path: custom,
    sha256: sha(readStable(custom)),
    calls,
    excludedFromTypedAdmission: true,
  });
  const customBin = path.join(root, 'custom-PATH-bin');
  fs.mkdirSync(customBin, { mode: 0o700 });
  fs.copyFileSync(custom, path.join(customBin, 'caws'));
  fs.chmodSync(path.join(customBin, 'caws'), 0o700);
  for (const [name, defaultCli] of [
    ['custom-PATH-unset-CLI', false],
    ['custom-PATH-default-CLI', true],
  ] as const) {
    const before = fs.readFileSync(witness, 'utf8').split('\n').filter(Boolean).length;
    const result = await invoke(name, linked, a, 'true', {
      pathOverride: customBin + path.delimiter + profile.path,
      defaultCli,
    });
    assert.equal(result.receipt.code, 0);
    const newCalls = fs.readFileSync(witness, 'utf8').split('\n').filter(Boolean).slice(before);
    assert(
      newCalls.some((line) => line.startsWith('agents heartbeat ')),
      'custom PATH CLI did not execute heartbeat fallback'
    );
    assert(
      newCalls.some((line) => line.startsWith('message poll ')),
      'custom PATH CLI did not execute mail fallback'
    );
  }
  // An explicit excluded control: Node remains available so runtime-paths.sh cannot
  // append Homebrew/local directories and accidentally recover a caws executable.
  const missingBin = path.join(root, 'missing-CLI-tools');
  fs.mkdirSync(missingBin, { mode: 0o700 });
  for (const name of ['node', 'git', 'python3', 'jq'])
    fs.symlinkSync(effectiveTools[name]!, path.join(missingBin, name));
  const missingPath = missingBin + path.delimiter + '/usr/bin' + path.delimiter + '/bin';
  const missingEnv = { ...environment, PATH: missingPath };
  const unresolved = h.run(
    'missing-CLI-preflight',
    '/usr/bin/which',
    ['caws'],
    sandbox,
    missingEnv
  );
  assert.equal(unresolved.code, 1, 'fixture is not a missing-CLI control');
  assert.equal(unresolved.error, null);
  const missingCliId = seed(a, 'missing-CLI-must-not-poll');
  const leaseBeforeMissingCli = readStable(path.join(a, '.caws/leases', sid + '.json')),
    ledgerBeforeMissingCli = readStable(path.join(a, '.caws/messages.jsonl'));
  const missingCli = await invoke('missing-CLI', linked, a, 'true', { pathOverride: missingPath });
  assert.equal(missingCli.receipt.code, 0);
  assert(readStable(path.join(a, '.caws/leases', sid + '.json')).equals(leaseBeforeMissingCli));
  assert(readStable(path.join(a, '.caws/messages.jsonl')).equals(ledgerBeforeMissingCli));
  assert(!delivered(a, missingCliId));
  if (profile.diagnosticCoverage) {
    seed(a, 'built-in-V8-owner-witness');
    const diagnostic = await invoke('diagnostic-V8-owner', linked, a, 'true', { coverage: true });
    assert.equal(diagnostic.receipt.code, 0);
    json(
      path.join(root, 'typed-owner-coverage.json'),
      inspectCoverage(path.join(root, 'v8/diagnostic-V8-owner'), cli)
    );
  }
  // Final isolated phase: missing payload identity cannot borrow a prior typed journal.
  // No native request or setup command follows this phase, even if cleanup is unknown.
  const missingId = seed(a, 'missing-payload-SID-must-remain-queued');
  const leaseBeforeMissing = readStable(path.join(a, '.caws/leases', sid + '.json')),
    ledgerBeforeMissing = readStable(path.join(a, '.caws/messages.jsonl'));
  const missing = await invoke('missing-payload-SID', linked, a, 'true', { missingSid: true });
  assert.equal(missing.receipt.code, 0);
  assert(readStable(path.join(a, '.caws/leases', sid + '.json')).equals(leaseBeforeMissing));
  assert(readStable(path.join(a, '.caws/messages.jsonl')).equals(ledgerBeforeMissing));
  assert(!delivered(a, missingId));

  // Re-read supplied identities after all observations. A matching baseline is never inferred from exit zero.
  for (const [file, expected] of Object.entries(profile.expected.files))
    assert.equal(sha(readStable(file)), expected, file);
  verifyTree(profile.expected.source);
  verifyTree(profile.expected.dist);
  verifyTree(profile.expected.templates);
  profile.expected.dependencies.forEach(verifyTree);
  assert.deepEqual(tree(runtime), profile.expected.runtimeFiles);
  json(path.join(root, 'result.json'), {
    schema: 'caws.native-heartbeat.qualification.v1',
    state: missing.completion.state === 'confirmed_inactive' ? 'observations-completed' : 'partial',
    reviewReference: profile.reviewReference,
    results,
    behavior: 'ordinary-case-assertions-completed',
    finalMissingSid: {
      cleanup: missing.completion.state,
      nativeContinuationStopped: scenarioChainClosed,
    },
    completeExecObservation: 'not-observed',
    nativeRegistration: 'not-exercised',
    nonclaims: [
      'Ordinary requests are uninstrumented; typed function execution is observed only in the separate V8 diagnostic',
      'No exhaustive short-lived exec observation or process-fanout absence',
      'No source-to-dist build derivation from hashes alone',
      'No installed user harness trust or real tool execution',
      'Missing-SID typed journal/custody correlation stays unknown if no journal exists',
      'Snapshot coverage misses remain unknown; native receipt EOF/group facts are retained separately',
      'No failed stdout handoff, cancellation, cross-platform, 13x4 fairness or performance qualification',
    ],
  });
  if (missing.completion.state !== 'confirmed_inactive') process.exitCode = 1;
}

/** Existing qualify-native-substitution.ts V8 port, narrowed to exact supplied module bytes/ranges.
 * Diagnostic execution evidence only; no production telemetry or negative process census.
 */
function inspectCoverage(directory: string, cli: string): Data {
  const targets = [
    ['runtime/agent-heartbeat.js', 'executeAgentHeartbeat'],
    ['application/agent-heartbeat.js', 'heartbeatAgentActivity'],
    ['application/message-poll.js', 'pollAgentMessages'],
  ] as const;
  const witnesses: Data[] = [];
  const counts: Record<string, number> = {};
  const files = fs.readdirSync(directory).filter((file) => file.endsWith('.json'));
  assert(files.length > 0 && files.length <= 128);
  for (const name of files) {
    const file = path.join(directory, name);
    const value = readJson(file);
    assert(Array.isArray(value.result));
    for (const [relative, functionName] of targets)
      for (const script of value.result) {
        const module = path.join(cli, 'dist', relative),
          url = pathToFileURL(module).href;
        if (!object(script) || script.url !== url) continue;
        assert(Array.isArray(script.functions));
        const functions = script.functions.filter(
          (entry) => object(entry) && entry.functionName === functionName
        );
        assert.equal(functions.length, 1);
        const fn = functions[0];
        assert(object(fn) && Array.isArray(fn.ranges));
        const range = fn.ranges[0];
        assert(object(range));
        const start = Number(range.startOffset),
          end = Number(range.endOffset),
          count = Number(range.count),
          text = readStable(module).toString('utf8');
        assert(
          Number.isSafeInteger(start) &&
            Number.isSafeInteger(end) &&
            start >= 0 &&
            end > start &&
            end <= text.length &&
            Number.isSafeInteger(count) &&
            count >= 0
        );
        assert(
          new RegExp('^(?:async )?function ' + functionName + '\\(').test(text.slice(start, end)),
          'compiled function witness differs'
        );
        counts[functionName] = (counts[functionName] ?? 0) + count;
        witnesses.push({
          file,
          fileSha256: sha(readStable(file)),
          module,
          moduleSha256: sha(readStable(module)),
          functionName,
          start,
          end,
          count,
        });
      }
  }
  for (const [, name] of targets)
    assert((counts[name] ?? 0) > 0, 'typed execution not witnessed: ' + name);
  return {
    mechanism: 'existing built-in NODE_V8_COVERAGE diagnostic port',
    counts,
    witnesses,
    completeExecObservation: 'not-observed',
  };
}
void main().catch((error) => {
  if (artifactRoot) {
    try {
      json(path.join(artifactRoot, 'failure.json'), { state: 'incomplete', error: String(error) });
    } catch {}
  }
  process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
});
