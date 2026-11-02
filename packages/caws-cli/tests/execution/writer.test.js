const fs = require('node:fs');
const path = require('node:path');
const { spawnCoveredSync } = require('./child-coverage.cjs');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const yaml = require('js-yaml');
const { authorityFixture, cleanupAll } = require('./authority-fixture');
const { git } = require('../helpers/git-repo-factory');
const { parseAndValidateSpec } = require('../../dist/kernel');
const { loadEvents } = require('../../dist/store/events-store');
afterAll(cleanupAll);

const entry = path.resolve(__dirname, '../../dist/execution/writer-main.js');
function fixture() {
  const f = authorityFixture();
  fs.writeFileSync(f.specPath, yaml.dump(f.spec));
  fs.writeFileSync(path.join(f.lane, 'src/proof.txt'), 'retained artifact\n');
  git(f.lane, ['add', 'src/proof.txt']);
  git(f.lane, ['commit', '-m', 'fixture artifact']);
  f.sha = git(f.lane, ['rev-parse', 'HEAD']).trim();
  f.env = {
    PATH: '/usr/bin:/bin',
    LC_ALL: 'C',
    CAWS_EXECUTION_PROJECT: f.root,
    CAWS_EXECUTION_CALLER: f.lane,
    CAWS_EXECUTION_SESSION: 'native-lineage',
    CAWS_EXECUTION_THREAD: 'thread-owned',
    CAWS_EXECUTION_CALL: 'native-writer-call',
  };
  return f;
}
function args(f, extra = []) {
  return [
    'specs',
    'evidence',
    'EXEC-001',
    '--ac',
    'A1',
    '--status',
    'pass',
    '--evidence-ref',
    'inspected artifact',
    '--artifact-path',
    'src/proof.txt',
    '--commit-sha',
    f.sha,
    '--verify',
    ...extra,
  ];
}
function execute(f, argv = args(f), { fence = true, script } = {}) {
  let fd;
  const lock = path.join(f.caws, 'state.lock');
  if (fence) {
    fd = fs.openSync(lock, 'wx+', 0o600);
    fs.writeFileSync(
      fd,
      JSON.stringify({
        pid: process.pid,
        at: new Date().toISOString(),
        purpose: 'execution-launch',
        nonce: 'writer-test-nonce',
        protocol: 'caws.execution.fence.v1',
      })
    );
  }
  try {
    // Instrumentation belongs to the test-only fd4 channel. Remove its startup
    // controls before entering the production consumer's exact environment.
    const bootstrap = `delete process.env.CAWS_TEST_CHILD_COVERAGE;
      delete process.env.__STRYKER_ACTIVE_MUTANT__;
      ${script ?? `process.argv.splice(1, 0, ${JSON.stringify(entry)}); require(${JSON.stringify(entry)});`}`;
    return spawnCoveredSync(process.execPath, ['-e', bootstrap, ...argv], {
      cwd: f.lane,
      env: f.env,
      stdio: ['ignore', 'pipe', 'pipe', fd ?? 'ignore'],
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1048576,
    });
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }
}
function state(f) {
  return {
    spec: fs.readFileSync(f.specPath, 'utf8'),
    events: fs.existsSync(path.join(f.caws, 'events.jsonl'))
      ? fs.readFileSync(path.join(f.caws, 'events.jsonl'), 'utf8')
      : null,
  };
}
function evidence(f) {
  const parsed = parseAndValidateSpec(fs.readFileSync(f.specPath, 'utf8'));
  expect(parsed.ok).toBe(true);
  return parsed.value.evidence;
}

test('records exact evidence plus matching event under the borrowed fence, without an audit commit', () => {
  const f = fixture();
  const beforeHead = git(f.root, ['rev-parse', 'HEAD']);
  const beforeIndex = fs.readFileSync(path.join(f.root, '.git/index'));
  const result = execute(f);
  expect(result.error).toBeUndefined();
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  const events = loadEvents(f.caws);
  expect(events.ok).toBe(true);
  expect(JSON.parse(result.stdout)).toEqual({
    operation: 'caws-evidence-v1',
    specId: 'EXEC-001',
    criterionId: 'A1',
    verification: 'citation-only',
    auditCommit: 'pending',
    eventSequence: events.value.events.at(-1).seq,
    specSha256: createHash('sha256').update(fs.readFileSync(f.specPath)).digest('hex'),
    auditCommitContinuation: ['caws', 'specs', 'commit', 'EXEC-001'],
  });
  expect(evidence(f)).toEqual([
    {
      criterion_id: 'A1',
      status: 'pass',
      evidence_ref: 'inspected artifact',
      artifact_path: 'src/proof.txt',
      commit_sha: f.sha,
      recorded_at: expect.any(String),
    },
  ]);
  expect(events.value.events.at(-1)).toMatchObject({
    event: 'ac_recorded',
    spec_id: 'EXEC-001',
    actor: { kind: 'agent', id: 'thread-owned', session_id: 'thread-owned', platform: 'codex' },
    data: {
      criterion_id: 'A1',
      status: 'pass',
      evidence_ref: 'inspected artifact',
      artifact_path: 'src/proof.txt',
      commit_sha: f.sha,
    },
  });
  expect(git(f.root, ['rev-parse', 'HEAD'])).toBe(beforeHead);
  expect(fs.readFileSync(path.join(f.root, '.git/index'))).toEqual(beforeIndex);
  expect(fs.existsSync(path.join(f.caws, 'sessions'))).toBe(false);
});

test.each(['fail', 'unchecked'])(
  'records an unverified %s claim without manufacturing citation or test verification',
  (status) => {
    const f = fixture();
    const result = execute(f, [
      'specs',
      'evidence',
      'EXEC-001',
      '--ac',
      'A1',
      '--status',
      status,
      '--evidence-ref',
      'manually inspected outcome',
    ]);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({
      verification: 'not-requested',
      auditCommit: 'pending',
    });
    expect(evidence(f)).toEqual([
      {
        criterion_id: 'A1',
        status,
        evidence_ref: 'manually inspected outcome',
        recorded_at: expect.any(String),
      },
    ]);
  }
);

test('keeps narrative code inert and never runs target or unrelated AC tests, Git hooks, filters, fsmonitor or signing helpers', () => {
  const f = fixture();
  const sentinel = path.join(f.root, 'must-remain-absent');
  const helper = path.join(f.root, 'hostile-helper');
  fs.writeFileSync(helper, `#!/bin/sh\nprintf bad > '${sentinel}'\nexit 0\n`, { mode: 0o755 });
  f.spec.acceptance[0].test_nodeids = ['src/hostile.test.js::must not execute'];
  f.spec.acceptance.push({
    id: 'A2',
    given: 'other AC',
    when: 'verified',
    then: 'must not execute',
    test_nodeids: ['src/hostile.test.js::must not execute'],
  });
  f.spec.evidence = [
    {
      criterion_id: 'A2',
      status: 'pass',
      evidence_ref: 'unrelated',
      recorded_at: '2026-10-28T00:00:00.000Z',
      test_nodeid: 'src/hostile.test.js::must not execute',
    },
  ];
  fs.writeFileSync(f.specPath, yaml.dump(f.spec));
  fs.writeFileSync(
    path.join(f.lane, 'src/hostile.test.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');\n`
  );
  fs.writeFileSync(
    path.join(f.lane, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test' } })
  );
  const hookDir = path.join(f.root, 'hostile-hooks');
  fs.mkdirSync(hookDir);
  fs.copyFileSync(helper, path.join(hookDir, 'pre-commit'));
  fs.chmodSync(path.join(hookDir, 'pre-commit'), 0o755);
  for (const [key, value] of [
    ['core.hooksPath', hookDir],
    ['core.fsmonitor', helper],
    ['filter.hostile.clean', helper],
    ['commit.gpgSign', 'true'],
    ['gpg.program', helper],
  ]) {
    git(f.root, ['config', key, value]);
  }
  fs.writeFileSync(path.join(f.root, '.gitattributes'), '.caws/specs/* filter=hostile\n');
  const command = `touch ${sentinel}`;
  const argv = args(f, ['--command', command, '--exit-code', '0']);
  argv[argv.indexOf('--evidence-ref') + 1] = `$(touch ${sentinel})`;
  const result = execute(f, argv);
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  expect(fs.existsSync(sentinel)).toBe(false);
  const recorded = evidence(f);
  expect(recorded.find((item) => item.criterion_id === 'A1')).toMatchObject({
    command,
    exit_code: 0,
    evidence_ref: `$(touch ${sentinel})`,
  });
  expect(recorded.find((item) => item.criterion_id === 'A2')).toEqual(f.spec.evidence[0]);
});

test.each([
  'no-fence',
  'foreign-spec',
  'foreign-owner',
  'missing-artifact',
  'test-nodeid',
  'environment-override',
  'malformed-startup-encoding',
  'encoding-on-unsupported-platform',
  'event-symlink',
])('%s refuses before evidence publication', (kind) => {
  const f = fixture();
  const argv = args(f);
  let fence = true;
  let external;
  let script;
  if (kind === 'no-fence') fence = false;
  if (kind === 'foreign-spec') argv[2] = 'FOREIGN-001';
  if (kind === 'foreign-owner') {
    f.registry.owned.owner.session_id = 'foreign';
    fs.writeFileSync(f.registryPath, JSON.stringify(f.registry));
  }
  if (kind === 'missing-artifact') argv[argv.indexOf('--artifact-path') + 1] = 'src/absent.txt';
  if (kind === 'test-nodeid') argv.push('--test-nodeid', 'src/hostile.test.js');
  if (kind === 'environment-override') f.env.CAWS_GIT_BINARY = '/bin/false';
  // Darwin replaces this field during execve startup. Inject at the actual
  // consumer boundary so removing its grammar/platform check makes the writer
  // publish, rather than merely testing the operating system's normalization.
  if (kind === 'malformed-startup-encoding' || kind === 'encoding-on-unsupported-platform') {
    script = `${kind === 'encoding-on-unsupported-platform' ? "Object.defineProperty(process, 'platform', { value: 'unsupported' });" : ''}
      process.env.__CF_USER_TEXT_ENCODING = ${kind === 'malformed-startup-encoding' ? "'executable-control'" : '`${process.getuid()}:0:0`'};
      process.argv.splice(1, 0, ${JSON.stringify(entry)});
      require(${JSON.stringify(entry)});`;
  }
  if (kind === 'event-symlink') {
    external = path.join(f.root, 'external-events');
    fs.writeFileSync(external, 'preserve\n');
    fs.rmSync(path.join(f.caws, 'events.jsonl'), { force: true });
    fs.symlinkSync(external, path.join(f.caws, 'events.jsonl'));
  }
  const before = state(f);
  const result = execute(f, argv, { fence, script });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('caws execution evidence refused:');
  expect(state(f)).toEqual(before);
  if (external) expect(fs.readFileSync(external, 'utf8')).toBe('preserve\n');
});

test('rechecks real authority before publication when ownership changes during planning', () => {
  const f = fixture();
  const before = state(f);
  const authority = path.resolve(__dirname, '../../dist/execution/authority.js');
  const writer = path.resolve(__dirname, '../../dist/execution/writer.js');
  const script = `
    const fs = require('node:fs');
    const authority = require(${JSON.stringify(authority)});
    const original = authority.readExecutionAuthority;
    let reads = 0;
    authority.readExecutionAuthority = (context) => {
      if (++reads === 3) {
        const registry = JSON.parse(fs.readFileSync(${JSON.stringify(f.registryPath)}, 'utf8'));
        registry.owned.owner.session_id = 'foreign';
        fs.writeFileSync(${JSON.stringify(f.registryPath)}, JSON.stringify(registry));
      }
      return original(context);
    };
    try { require(${JSON.stringify(writer)}).runExecutionEvidenceWriter(process.argv.slice(1)); }
    catch (error) { process.stderr.write(String(error)); process.exitCode = 1; }
  `;
  const result = execute(f, args(f), { script });
  expect(result.status).toBe(1);
  expect(state(f)).toEqual(before);
  expect(JSON.parse(fs.readFileSync(f.registryPath, 'utf8')).owned.owner.session_id).toBe(
    'foreign'
  );
});

test('missing promisor objects refuse without launching a configured executable fetch helper', () => {
  const f = fixture();
  const sentinel = path.join(f.root, 'fetch-helper-ran');
  const helper = path.join(f.root, 'fetch-helper');
  fs.writeFileSync(helper, `#!/bin/sh\nprintf fetch > '${sentinel}'\nexit 1\n`, { mode: 0o755 });
  for (const [key, value] of [
    ['core.repositoryformatversion', '1'],
    ['extensions.partialClone', 'origin'],
    ['remote.origin.promisor', 'true'],
    ['remote.origin.url', `ext::${helper}`],
    ['protocol.ext.allow', 'always'],
  ])
    git(f.root, ['config', key, value]);
  const argv = args(f);
  const missing = 'a'.repeat(40);
  argv[argv.indexOf('--commit-sha') + 1] = missing;
  const before = state(f);
  const result = execute(f, argv);
  expect(result.status).toBe(1);
  expect(state(f)).toEqual(before);
  expect(fs.existsSync(sentinel)).toBe(false);

  // Prove the hostile configuration is live: the same missing-object query
  // without confinement reaches the fixture's local helper. No network is used.
  expect(() =>
    execFileSync('/usr/bin/git', ['cat-file', '-e', `${missing}^{commit}`], {
      cwd: f.lane,
      env: {
        PATH: '/usr/bin:/bin',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
    })
  ).toThrow();
  expect(fs.readFileSync(sentinel, 'utf8')).toBe('fetch');
});

function publicationFaultScript(f, mode, secret) {
  return `
    const fs = require('node:fs');
    const specPath = ${JSON.stringify(f.specPath)};
    const eventsPath = ${JSON.stringify(path.join(f.caws, 'events.jsonl'))};
    const mode = ${JSON.stringify(mode)};
    const secret = ${JSON.stringify(secret)};
    const open = fs.openSync, close = fs.closeSync, sync = fs.fsyncSync;
    const rename = fs.renameSync, read = fs.readFileSync;
    let appendAttempted = false, eventFd, eventOpen = false, eventCommitted = false;
    fs.openSync = (pathname, flags, ...rest) => {
      if (pathname === eventsPath && flags === 'a') {
        appendAttempted = true;
        if (mode === 'append-recovered' || mode === 'append-rollback-failed') throw new Error(secret);
        eventFd = open(pathname, flags, ...rest); eventOpen = true; return eventFd;
      }
      return open(pathname, flags, ...rest);
    };
    fs.closeSync = (fd) => { if (fd === eventFd) eventOpen = false; return close(fd); };
    fs.fsyncSync = (fd) => {
      if (eventOpen && fd === eventFd && mode === 'append-fsync-recovered') throw new Error(secret);
      const result = sync(fd);
      if (eventOpen && fd === eventFd) eventCommitted = true;
      return result;
    };
    fs.renameSync = (source, target) => {
      if (appendAttempted && target === specPath && mode === 'append-rollback-failed') throw new Error(secret);
      return rename(source, target);
    };
    fs.readFileSync = (pathname, ...rest) => {
      if (eventCommitted && pathname === specPath && mode === 'readback-failed') throw new Error(secret);
      return read(pathname, ...rest);
    };
    if (mode === 'report-failed') {
      const write = process.stdout.write.bind(process.stdout);
      let failed = false;
      process.stdout.write = (...parts) => {
        if (!failed) { failed = true; throw new Error(secret); }
        return write(...parts);
      };
    }
    process.argv.splice(1, 0, ${JSON.stringify(entry)});
    require(${JSON.stringify(entry)});
  `;
}

test.each([
  ['append-recovered', 'transaction-recovered', 'store-reported-recovery'],
  ['append-rollback-failed', 'recovery-required', 'store-reported-unrecovered'],
  ['append-fsync-recovered', 'transaction-recovered', 'store-reported-recovery'],
  ['readback-failed', 'published-unconfirmed', 'publication-unconfirmed'],
  ['report-failed', 'published-unconfirmed', 'publication-unconfirmed'],
])(
  'reports %s through actual transaction IO with inspect-before-retry and no sensitive payload',
  (mode, disposition, reason) => {
    const f = fixture();
    const secret = 'submitted-private-metadata-never-report';
    const argv = args(f, ['--command', secret]);
    argv[argv.indexOf('--evidence-ref') + 1] = secret;
    const before = state(f);
    const priorEvents = loadEvents(f.caws);
    expect(priorEvents.ok).toBe(true);
    const result = execute(f, argv, { script: publicationFaultScript(f, mode, secret) });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      operation: 'caws-evidence-v1',
      outcome: 'publication-failure',
      specId: 'EXEC-001',
      criterionId: 'A1',
      disposition,
      reason,
      recovery: {
        specPath: '.caws/specs/EXEC-001.yaml',
        eventsPath: '.caws/events.jsonl',
        retry: 'inspect-before-retry',
      },
    });
    expect(result.stderr).toBe(
      `caws execution evidence publication requires inspection: ${disposition}/${reason}\n`
    );
    expect(result.stderr).not.toContain('refused');
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(result.stdout + result.stderr).not.toContain(f.root);
    expect(report.recovery.instruction).toContain('.caws/events.jsonl');
    expect(report.recovery.instruction).toContain('Do NOT hand-author entries into events.jsonl.');
    expect(report.recovery).not.toHaveProperty('retry_safe');
    const after = state(f);
    const events = loadEvents(f.caws);
    expect(events.ok).toBe(true);
    if (mode === 'append-recovered' || mode === 'append-fsync-recovered') {
      expect(after.spec).toBe(before.spec);
    } else {
      expect(after.spec).not.toBe(before.spec);
      expect(evidence(f)).toEqual([
        {
          criterion_id: 'A1',
          status: 'pass',
          evidence_ref: secret,
          command: secret,
          artifact_path: 'src/proof.txt',
          commit_sha: f.sha,
          recorded_at: expect.any(String),
        },
      ]);
    }
    if (mode === 'append-recovered' || mode === 'append-rollback-failed') {
      expect(after.events).toBe(before.events);
      expect(events.value.events).toEqual(priorEvents.value.events);
    } else {
      expect(events.value.events.length).toBe(priorEvents.value.events.length + 1);
      expect(events.value.events.at(-1)).toMatchObject({
        event: 'ac_recorded',
        spec_id: 'EXEC-001',
        data: { criterion_id: 'A1', evidence_ref: secret, command: secret },
      });
    }
    if (mode === 'append-rollback-failed') {
      expect(report.storeRule).toBe('store.lifecycle.partial_failure_unrecovered');
      expect(report.recovery.instruction).toContain('.caws/specs/EXEC-001.yaml (rollback failed)');
      expect(report.recovery.instruction).toContain(
        'Event append not confirmed (1); inspect .caws/events.jsonl:'
      );
      expect(report.recovery.instruction).not.toContain('NOT appended');
    }
  }
);

test.each(['throw', 'unsafe-recovery'])(
  'sanitizes %s at the dispatched store boundary without ordinary refusal or automatic retry',
  (mode) => {
    const f = fixture();
    const before = state(f);
    const secret = 'untrusted-store-error-payload-must-not-escape';
    const store = path.resolve(__dirname, '../../dist/store/specs-writer.js');
    const script = `
    const store = require(${JSON.stringify(store)});
    let calls = 0;
    store.recordSpecEvidence = () => {
      if (++calls > 1) throw new Error('automatic retry occurred');
      ${mode === 'throw' ? `throw new Error(${JSON.stringify(secret)});` : `return { ok: false, errors: [{ rule: 'store.lifecycle.partial_failure_unrecovered', message: ${JSON.stringify(secret)}, data: { recovery_instruction: ${JSON.stringify(secret)} } }] };`}
    };
    process.argv.splice(1, 0, ${JSON.stringify(entry)});
    require(${JSON.stringify(entry)});
    if (calls !== 1) throw new Error('store dispatch count changed');
  `;
    const result = execute(f, args(f), { script });
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.disposition).toBe(
      mode === 'throw' ? 'published-unconfirmed' : 'recovery-required'
    );
    expect(report.reason).toBe(
      mode === 'throw' ? 'writer-dispatch-failed' : 'store-reported-unrecovered'
    );
    expect(result.stderr).toBe(
      `caws execution evidence publication requires inspection: ${report.disposition}/${report.reason}\n`
    );
    expect(report.recovery.retry).toBe('inspect-before-retry');
    expect(report.recovery.instruction).toBe(
      'Inspect .caws/specs/EXEC-001.yaml and .caws/events.jsonl before retrying. The spec and event append may have changed independently. Do NOT hand-author entries into events.jsonl.'
    );
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain('refused');
    expect(state(f)).toEqual(before);
  }
);

// These unit controls change returned observations only after the real store
// succeeds. The fixture's retained disk state remains independently inspectable.
function publicationObservationScript(mode) {
  return `
    const store = require(${JSON.stringify(path.resolve(__dirname, '../../dist/store/specs-writer.js'))});
    const events = require(${JSON.stringify(path.resolve(__dirname, '../../dist/store/events-store.js'))});
    const spec = require(${JSON.stringify(path.resolve(__dirname, '../../dist/kernel/spec/index.js'))});
    const record = store.recordSpecEvidence, load = events.loadEvents, parse = spec.parseAndValidateSpec;
    const mode = ${JSON.stringify(mode)};
    let published = false, dispatches = 0, eventObservations = 0, specObservations = 0, altered = false;
    store.recordSpecEvidence = (...args) => {
      dispatches++;
      const result = record(...args);
      if (result.ok && result.value.kind !== 'partial_failure_recovered') published = true;
      return result;
    };
    events.loadEvents = (...args) => {
      const result = load(...args);
      if (!published || !result.ok) return result;
      eventObservations++;
      const observed = JSON.parse(JSON.stringify(result));
      const rows = observed.value.events, event = rows.at(-1);
      if (mode === 'duplicate-event') { rows.push(JSON.parse(JSON.stringify(event))); altered = true; }
      if (mode === 'event-kind') { event.event = 'spec_closed'; altered = true; }
      if (mode === 'event-spec') { event.spec_id = 'FOREIGN-001'; altered = true; }
      if (mode === 'event-ts') { event.ts = '2000-01-01T00:00:00.000Z'; altered = true; }
      for (const field of ['id', 'session_id', 'kind', 'platform']) {
        if (mode === 'actor-' + field) { event.actor[field] = 'unexpected'; altered = true; }
      }
      for (const field of ['criterion_id', 'status', 'evidence_ref', 'command', 'exit_code', 'artifact_path', 'commit_sha']) {
        if (mode === 'event-' + field) { event.data[field] = field === 'exit_code' ? 1 : 'unexpected'; altered = true; }
      }
      return observed;
    };
    spec.parseAndValidateSpec = (...args) => {
      const result = parse(...args);
      if (!published || !result.ok) return result;
      specObservations++;
      const observed = JSON.parse(JSON.stringify(result));
      const row = observed.value.evidence[0];
      if (mode === 'zero-evidence') { observed.value.evidence = []; altered = true; }
      if (mode === 'two-evidence') { observed.value.evidence.push({ ...row }); altered = true; }
      for (const field of ['criterion_id', 'status', 'evidence_ref', 'command', 'exit_code', 'artifact_path', 'commit_sha']) {
        if (mode === 'spec-' + field) { row[field] = field === 'exit_code' ? 1 : 'unexpected'; altered = true; }
      }
      if (mode === 'spec-recorded_at') { row.recorded_at = '2000-01-01T00:00:00.000Z'; altered = true; }
      if (mode === 'spec-test_nodeid') { row.test_nodeid = 'unexpected.test.js::case'; altered = true; }
      if (mode === 'spec-test_verified_at') { row.test_verified_at = '2000-01-01T00:00:00.000Z'; altered = true; }
      return observed;
    };
    let outcome;
    try { outcome = require(${JSON.stringify(path.resolve(__dirname, '../../dist/execution/writer.js'))}).runExecutionEvidenceWriter(process.argv.slice(1)); }
    catch (error) { outcome = error.outcome ?? { unexpected: String(error) }; process.exitCode = 1; }
    process.stdout.write(JSON.stringify({ outcome, dispatches, eventObservations, specObservations, altered }));
  `;
}

test.each([
  'unchanged',
  'duplicate-event',
  'event-kind',
  'event-spec',
  'zero-evidence',
  'two-evidence',
  ...['event', 'spec'].flatMap((side) =>
    [
      'criterion_id',
      'status',
      'evidence_ref',
      'command',
      'exit_code',
      'artifact_path',
      'commit_sha',
    ].map((field) => `${side}-${field}`)
  ),
  'spec-recorded_at',
  'event-ts',
  'actor-id',
  'actor-session_id',
  'actor-kind',
  'actor-platform',
  'spec-test_nodeid',
  'spec-test_verified_at',
])('checks mocked post-publication %s against one real retained transaction', (mode) => {
  const f = fixture();
  const before = loadEvents(f.caws);
  expect(before.ok).toBe(true);
  const result = execute(f, args(f, ['--command', 'retained command', '--exit-code', '0']), {
    script: publicationObservationScript(mode),
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  const observed = JSON.parse(result.stdout);
  expect(observed).toMatchObject({
    dispatches: 1,
    eventObservations: 1,
    specObservations: 1,
    altered: mode !== 'unchanged',
  });
  expect(result.status).toBe(mode === 'unchanged' ? 0 : 1);
  if (mode === 'unchanged') {
    expect(observed.outcome).toMatchObject({
      operation: 'caws-evidence-v1',
      auditCommit: 'pending',
    });
  } else {
    expect(observed.outcome).toMatchObject({
      operation: 'caws-evidence-v1',
      outcome: 'publication-failure',
      disposition: 'published-unconfirmed',
      reason: 'publication-unconfirmed',
      recovery: { retry: 'inspect-before-retry' },
    });
  }
  const retained = loadEvents(f.caws);
  expect(retained.ok).toBe(true);
  expect(retained.value.events).toHaveLength(before.value.events.length + 1);
  const event = retained.value.events.at(-1);
  const expected = {
    criterion_id: 'A1',
    status: 'pass',
    evidence_ref: 'inspected artifact',
    command: 'retained command',
    exit_code: 0,
    artifact_path: 'src/proof.txt',
    commit_sha: f.sha,
  };
  expect(evidence(f)).toEqual([{ ...expected, recorded_at: event.ts }]);
  expect(event).toMatchObject({
    event: 'ac_recorded',
    spec_id: 'EXEC-001',
    data: expected,
    actor: { kind: 'agent', id: 'thread-owned', session_id: 'thread-owned', platform: 'codex' },
  });
});

test.each([
  ['CAWS_EXECUTION_SESSION', ''],
  ['CAWS_EXECUTION_CALL', ''],
  ['PATH', '/bin'],
  ['LC_ALL', 'en_US.UTF-8'],
])('rejects launch environment %s=%j before publication', (name, value) => {
  const f = fixture();
  f.env[name] = value;
  const before = state(f);
  const result = execute(f);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('caws execution evidence refused: context_unresolved\n');
  expect(state(f)).toEqual(before);
});

test.each([
  ['decimal', true],
  ['hexadecimal', true],
  ['empty', false],
  ['missing-part', false],
  ['extra-part', false],
  ['empty-part', false],
  ['malformed-hex', false],
  ['negative-part', false],
  ['wrong-uid', false],
])('checks mocked Darwin startup encoding %s before publication', (kind, accepted) => {
  const f = fixture();
  const before = state(f);
  const script = `
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const uid = process.getuid();
    process.env.__CF_USER_TEXT_ENCODING = {
      decimal: uid + ':0:0', hexadecimal: '0x' + uid.toString(16) + ':0x0:0xA',
      empty: '', 'missing-part': uid + ':0', 'extra-part': uid + ':0:0:0',
      'empty-part': uid + '::0', 'malformed-hex': uid + ':0x:0',
      'negative-part': uid + ':-1:0', 'wrong-uid': (uid + 1) + ':0:0'
    }[${JSON.stringify(kind)}];
    process.argv.splice(1, 0, ${JSON.stringify(entry)});
    require(${JSON.stringify(entry)});
  `;
  const result = execute(f, args(f), { script });
  expect(result.status).toBe(accepted ? 0 : 1);
  if (accepted) {
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).verification).toBe('citation-only');
    expect(evidence(f)[0].commit_sha).toBe(f.sha);
  } else {
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('caws execution evidence refused: context_unresolved\n');
    expect(state(f)).toEqual(before);
  }
});

test('confines all three real Git citation queries to exact object-only arguments and environment', () => {
  const f = fixture();
  const script = `
    const child = require('node:child_process');
    const exec = child.execFileSync, calls = [];
    child.execFileSync = (...args) => {
      // Authority's separate rev-parse queries retain their own contract.
      if (args[1][0] !== 'rev-parse') calls.push(args);
      return exec(...args);
    };
    const result = require(${JSON.stringify(path.resolve(__dirname, '../../dist/execution/writer.js'))}).runExecutionEvidenceWriter(process.argv.slice(1));
    process.stdout.write(JSON.stringify({ result, calls }));
  `;
  const result = execute(f, args(f), { script });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  const observed = JSON.parse(result.stdout);
  expect(observed.result.verification).toBe('citation-only');
  const prefix = [
    '--no-lazy-fetch',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'commit.gpgSign=false',
    '-c',
    'gc.auto=0',
    '-c',
    'maintenance.auto=false',
  ];
  const options = {
    cwd: f.lane,
    env: {
      PATH: '/usr/bin:/bin',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 1000,
    maxBuffer: 65536,
  };
  expect(observed.calls).toEqual([
    ['/usr/bin/git', [...prefix, 'cat-file', '-e', `${f.sha}^{commit}`], options],
    [
      '/usr/bin/git',
      [...prefix, 'for-each-ref', '--contains', f.sha, '--count=1', '--format=%(refname)'],
      options,
    ],
    ['/usr/bin/git', [...prefix, 'cat-file', '-e', `${f.sha}:src/proof.txt`], options],
  ]);
});

test.each(['hardlink', 'symlink', 'regular', 'unrelated-symlink'])(
  'checks owned spec temporary sibling %s without treating other specs as owned',
  (kind) => {
    const f = fixture();
    const target = path.join(f.root, 'retained-temporary-target');
    const bytes = 'preserve temporary target\n';
    fs.writeFileSync(target, bytes);
    const sibling = path.join(
      f.caws,
      'specs',
      `${kind === 'unrelated-symlink' ? 'FOREIGN-001.yaml' : 'EXEC-001.yaml'}.tmp.retained`
    );
    if (kind === 'hardlink') fs.linkSync(target, sibling);
    else if (kind === 'regular') fs.writeFileSync(sibling, bytes);
    else fs.symlinkSync(target, sibling);
    const before = state(f);
    const result = execute(f);
    if (kind === 'hardlink' || kind === 'symlink') {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('caws execution evidence refused: context_unresolved\n');
      expect(state(f)).toEqual(before);
    } else {
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      expect(evidence(f)[0].evidence_ref).toBe('inspected artifact');
    }
    expect(fs.readFileSync(target, 'utf8')).toBe(bytes);
    expect(fs.readFileSync(sibling, 'utf8')).toBe(bytes);
  }
);
