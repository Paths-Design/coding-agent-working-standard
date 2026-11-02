'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout, clearTimeout } = require('node:timers');
const {
  observeCommand,
  createQualificationFixture,
  observeQualification,
  qualifyEntrypoint,
  cleanupQualification,
} = require('../helpers/pytest-entrypoint-fixture');

const PACKAGE = path.resolve(__dirname, '../..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
const INNER_COMMAND =
  quote(process.execPath) + ' tests/helpers/pytest-entrypoint-fixture.js --installed-scenario';

function artifacts(label) {
  const parent = process.env.CAWS_EXPERIMENT_ARTIFACTS || os.tmpdir();
  if (!path.isAbsolute(parent)) throw new Error('CAWS_EXPERIMENT_ARTIFACTS must be absolute');
  fs.mkdirSync(parent, { recursive: true });
  // Handler selection reports canonical paths; on macOS os.tmpdir() sits under
  // the /var -> /private/var symlink, so the fixture root must be canonical too.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, `pytest-entrypoint-${label}-`)));
  fs.writeFileSync(
    path.join(root, 'test-context.json'),
    JSON.stringify(
      {
        label,
        node_version: process.version,
        node_executable: process.execPath,
      },
      null,
      2
    ) + '\n'
  );
  return root;
}

function files(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

function assertCaptured(result, expectedExit) {
  const state = json(result.statePath);
  expect(result.completion_scope).toBe('transport_only');
  expect(result.exit_code).toBe(expectedExit);
  expect(result.signal).toBeNull();
  expect(result.timed_out).toBe(false);
  expect(result.complete).toBe(true);
  expect(result.stdout_eof).toBe(true);
  expect(result.stderr_eof).toBe(true);
  expect(result.stdio_forced_closed).toBe(false);
  expect(result.group_absent).toBe(true);
  expect(Number.isSafeInteger(result.pid) && result.pid > 0).toBe(true);
  for (const key of [
    'completion_scope',
    'exit_code',
    'signal',
    'pid',
    'timed_out',
    'complete',
    'stdout_eof',
    'stderr_eof',
    'stdio_forced_closed',
    'group_absent',
  ]) {
    expect(state[key]).toEqual(result[key]);
  }
  expect(fs.readFileSync(result.stdoutPath)).toEqual(result.stdout);
  expect(fs.readFileSync(result.stderrPath)).toEqual(result.stderr);
  return state;
}

for (const exitCode of [0, 7]) {
  test(`observer retains actual exit ${exitCode} and binary channels after complete settlement`, async () => {
    const root = artifacts(`observer-exit-${exitCode}`);
    const result = await observeCommand({
      argv: [
        process.execPath,
        '-e',
        `process.stdout.write(Buffer.from([0,255,195,169])); process.stderr.write('observed error\\n'); process.exitCode=${exitCode};`,
      ],
      cwd: root,
      env: process.env,
      outputDir: path.join(root, 'command'),
      timeoutMs: 10000,
    });
    assertCaptured(result, exitCode);
    expect(result.stdout).toEqual(Buffer.from([0, 255, 195, 169]));
    expect(result.stderr).toEqual(Buffer.from('observed error\n'));
  }, 20000);
}

test('observer retains an actual spawn error without manufacturing completion or a child', async () => {
  const root = artifacts('observer-spawn-error');
  const absent = path.join(root, 'absent-executable');
  const result = await observeCommand({
    argv: [absent],
    cwd: root,
    env: process.env,
    outputDir: path.join(root, 'command'),
    timeoutMs: 10000,
  });
  expect(fs.existsSync(absent)).toBe(false);
  expect(result.exit_code).toBeNull();
  expect(result.signal).toBeNull();
  expect(result.timed_out).toBe(false);
  expect(result.complete).toBe(false);
  expect(result.pid == null).toBe(true);
  expect(result.group_absent).toBeNull();
  const state = json(result.statePath);
  expect(state.complete).toBe(false);
  expect(JSON.stringify(state)).toContain('ENOENT');
  expect(fs.readFileSync(result.stdoutPath)).toEqual(result.stdout);
  expect(fs.readFileSync(result.stderrPath)).toEqual(result.stderr);
}, 20000);

test('observer refuses cleanup of its registered live fixture until actual settlement', async () => {
  const fixture = createQualificationFixture({
    artifactRoot: artifacts('observer-registered-cleanup'),
    label: 'registered',
  });
  const sourceBytes = fs.readFileSync(fixture.sourcePath);
  expect(sourceBytes).toEqual(
    fs.readFileSync(require.resolve('../helpers/pytest-entrypoint-fixture'))
  );
  expect(path.dirname(fixture.fixtureRoot)).toBe(path.resolve(PACKAGE, '../../.tmp'));
  const ready = path.join(fixture.evidenceRoot, 'registered-child-ready.json');
  const release = path.join(fixture.evidenceRoot, 'release-registered-child');
  const script = `const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(ready + '.pending')},JSON.stringify({pid:process.pid,ready:true}));
fs.renameSync(${JSON.stringify(ready + '.pending')},${JSON.stringify(ready)});
process.stdout.write('registered fixture ready\\n');
const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){
  clearInterval(timer); process.stdout.write('registered fixture released\\n'); process.stderr.write('normal release\\n');
}},20);`;
  const command = observeQualification(fixture, {
    argv: [process.execPath, '-e', script],
    cwd: fixture.packageRoot,
    env: process.env,
    outputDir: path.join(fixture.evidenceRoot, 'registered-command'),
    timeoutMs: 10000,
    cleanupMs: 5000,
  });
  try {
    const readyDeadline = Date.now() + 10000;
    while (!fs.existsSync(ready)) {
      if (Date.now() >= readyDeadline)
        throw new Error('registered child readiness was not observed');
      await delay(20);
    }
    const readiness = json(ready);
    expect(readiness.ready).toBe(true);
    expect(Number.isSafeInteger(readiness.pid) && readiness.pid > 0).toBe(true);
    let refusal;
    try {
      cleanupQualification(fixture);
    } catch (error) {
      refusal = error;
    }
    fs.writeFileSync(
      path.join(fixture.evidenceRoot, 'cleanup-refusal-observation.json'),
      JSON.stringify(
        {
          child: readiness,
          refusal: refusal instanceof Error ? refusal.message : null,
          source_exists_after_attempt: fs.existsSync(fixture.sourcePath),
          source_sha256_before: sha(sourceBytes),
          source_sha256_after: fs.existsSync(fixture.sourcePath)
            ? sha(fs.readFileSync(fixture.sourcePath))
            : null,
        },
        null,
        2
      ) + '\n'
    );
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.message).toMatch(/absence is unconfirmed/);
    expect(fs.readFileSync(fixture.sourcePath)).toEqual(sourceBytes);
    expect(fs.existsSync(fixture.fixtureRoot)).toBe(true);
    fs.writeFileSync(release, 'release\n');
    const result = await command;
    assertCaptured(result, 0);
    expect(result.pid).toBe(readiness.pid);
    expect(result.stdout).toEqual(
      Buffer.from('registered fixture ready\nregistered fixture released\n')
    );
    expect(result.stderr).toEqual(Buffer.from('normal release\n'));
    expect(fixture.npm.statePath).toBe(result.statePath);
    expect(fixture.npm.pid).toBe(readiness.pid);
    cleanupQualification(fixture);
    expect(fs.existsSync(fixture.fixtureRoot)).toBe(false);
    expect(fs.existsSync(fixture.evidenceRoot)).toBe(true);
    expect(fs.readFileSync(result.statePath, 'utf8')).toContain('transport_only');
  } finally {
    fs.writeFileSync(release, 'release\n');
    const settled = await command;
    if (settled.group_absent === true && fs.existsSync(fixture.fixtureRoot))
      cleanupQualification(fixture);
  }
}, 30000);

function message(child, expected, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error('unrelated child did not acknowledge ' + expected)),
      timeoutMs
    );
    const onMessage = (value) => {
      if (value === expected) finish(null);
    };
    const onError = (error) => finish(error);
    function finish(error) {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      if (error) reject(error);
      else resolve(undefined);
    }
    child.on('message', onMessage);
    child.on('error', onError);
  });
}

async function stopUnrelated(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('unrelated private child cleanup unconfirmed')),
      3000
    );
    child.once('close', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.kill('SIGKILL');
  });
}

test('observer settles an exited leader with a ready descendant holding inherited pipes', async () => {
  const root = artifacts('observer-held-pipes');
  const ready = path.join(root, 'descendant-ready.json');
  const late = path.join(root, 'descendant-late-write');
  const unrelatedSentinel = path.join(root, 'unrelated.keep');
  fs.writeFileSync(unrelatedSentinel, 'unrelated bytes\n');
  const unrelated = spawn(
    process.execPath,
    [
      '-e',
      "process.on('message', value => { if (value === 'ping') process.send('pong'); }); process.send('ready'); setInterval(()=>{},1000);",
    ],
    {
      cwd: root,
      env: process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    }
  );
  try {
    await message(unrelated, 'ready');
    const descendant = `const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid,ready:true}));
process.stdout.write('descendant ready\\n'); process.stderr.write('descendant stderr\\n');
process.send('ready');
setTimeout(()=>fs.writeFileSync(${JSON.stringify(late)},'late effect'),6000);`;
    const leader = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit','ipc']});
child.on('message', value=>{if(value==='ready') process.exit(0);});`;
    const started = Date.now();
    const result = await observeCommand({
      argv: [process.execPath, '-e', leader],
      cwd: root,
      env: process.env,
      outputDir: path.join(root, 'command'),
      timeoutMs: 3000,
      cleanupMs: 5000,
    });
    const elapsed = Date.now() - started;
    // Observe the delayed effect before assertions, including a deliberately broken cleanup.
    await delay(6500);
    const pong = message(unrelated, 'pong');
    unrelated.send('ping');
    await pong;
    const readiness = json(ready);
    const lateExists = fs.existsSync(late);
    fs.writeFileSync(
      path.join(root, 'held-pipe-observation.json'),
      JSON.stringify(
        {
          leader_pid: result.pid,
          descendant: readiness,
          observe_elapsed_ms: elapsed,
          late_effect_exists: lateExists,
          unrelated_acknowledged: true,
          fixture_exists_after_settlement: fs.existsSync(root),
        },
        null,
        2
      ) + '\n'
    );
    expect(readiness.ready).toBe(true);
    expect(Number.isSafeInteger(readiness.pid) && readiness.pid > 0).toBe(true);
    expect(readiness.pid).not.toBe(result.pid);
    expect(result.stdout.toString('utf8')).toContain('descendant ready\n');
    expect(result.stderr.toString('utf8')).toContain('descendant stderr\n');
    expect(result.exit_code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.timed_out).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.completion_scope).toBe('transport_only');
    expect(result.stdout_eof).toBe(true);
    expect(result.stderr_eof).toBe(true);
    expect(result.stdio_forced_closed).toBe(false);
    expect(result.group_absent).toBe(true);
    expect(elapsed).toBeLessThanOrEqual(10000);
    expect(lateExists).toBe(false);
    expect(fs.readFileSync(unrelatedSentinel, 'utf8')).toBe('unrelated bytes\n');
    expect(fs.existsSync(root)).toBe(true);
    const state = json(result.statePath);
    expect(state.timed_out).toBe(true);
    expect(state.complete).toBe(false);
    expect(state.group_absent).toBe(true);
    expect(fs.readFileSync(result.stdoutPath)).toEqual(result.stdout);
    expect(fs.readFileSync(result.stderrPath)).toEqual(result.stderr);
  } finally {
    await stopUnrelated(unrelated);
  }
}, 30000);

function assertSourceInputs(result, omitPretest) {
  const inputs = json(result.inputManifestPath);
  expect(inputs.schema).toBe('caws.pytest_entrypoint_inputs.v1');
  expect(inputs.dist_absent_before).toBe(true);
  expect(inputs.omit_pretest).toBe(omitPretest);
  expect(inputs.package_root).toBe(result.packageRoot);
  expect(inputs.source_root).toBe(result.fixtureRoot);
  const original = fs.readFileSync(path.join(result.evidenceRoot, 'package.original.json'));
  const effective = fs.readFileSync(path.join(result.evidenceRoot, 'package.effective.json'));
  expect(original).toEqual(fs.readFileSync(path.join(PACKAGE, 'package.json')));
  expect(inputs.original_package_sha256).toBe(sha(original));
  expect(inputs.effective_package_sha256).toBe(sha(effective));
  expect(fs.readFileSync(path.join(result.packageRoot, 'package.json'))).toEqual(effective);
  const originalManifest = JSON.parse(original.toString('utf8'));
  const expected = JSON.parse(original.toString('utf8'));
  expected.scripts['test:pytest'] = INNER_COMMAND;
  if (omitPretest) delete expected.scripts['pretest:pytest'];
  expect(JSON.parse(effective.toString('utf8'))).toEqual(expected);
  expect(originalManifest.scripts['pretest:pytest']).toBe('npm run build');
  expect(inputs.test_override).toBe(INNER_COMMAND);
  expect(INNER_COMMAND).not.toMatch(/python|\.py(?:\s|$)/i);
  expect(inputs.files.map((entry) => entry.path)).not.toEqual([]);
  for (const entry of inputs.files) {
    expect(path.isAbsolute(entry.path)).toBe(false);
    expect(entry.path.split(/[\\/]/)).not.toContain('..');
    expect(entry.path).not.toMatch(/(?:^|\/)dist\//);
    expect(entry.path).not.toMatch(/(?:^|\/)tests\/hooks\/pytest\//);
    const bytes = fs.readFileSync(path.join(result.fixtureRoot, entry.path));
    expect(bytes.length).toBe(entry.bytes);
    expect(sha(bytes)).toBe(entry.sha256);
  }
  expect(
    inputs.files.some((entry) => entry.path.endsWith('tests/helpers/pytest-entrypoint-fixture.js'))
  ).toBe(true);
  const state = json(result.npm.statePath);
  expect(state.argv.slice(-2)).toEqual(['run', 'test:pytest']);
  expect(
    state.argv.slice(0, -2).some((entry) => /^(?:npm|npm-cli\.js)$/.test(path.basename(entry)))
  ).toBe(true);
  expect(state.cwd).toBe(result.packageRoot);
  expect(state.timeout_ms).toBe(180000);
  return inputs;
}

test('cold npm pytest entrypoint builds before a real installed read-only selection and marker invocation', async () => {
  const result = await qualifyEntrypoint({ artifactRoot: artifacts('cold-ready'), label: 'ready' });
  try {
    assertCaptured(result.npm, 0);
    assertSourceInputs(result, false);
    const build = json(result.buildResultPath);
    const installer = path.join(result.packageRoot, 'dist/init/machine-adapters.js');
    expect(build.schema).toBe('caws.pytest_entrypoint_build.v1');
    expect(build.installer_path).toBe(installer);
    expect(build.installer_exists).toBe(true);
    const bytes = fs.readFileSync(installer);
    expect(bytes.length).toBeGreaterThan(0);
    expect(build.installer_sha256).toBe(sha(bytes));
    expect(fs.readFileSync(build.retained_installer_path)).toEqual(bytes);
    const logs = path.join(result.consumerRoot, 'logs');
    const selected = json(path.join(logs, 'selection.json'));
    const marker = path.join(result.consumerRoot, 'repo/.caws/hooks/marker.sh');
    expect(
      selected.handlers.map((handler) => ({ path: handler.path, kind: handler.kind }))
    ).toEqual([{ path: marker, kind: 'project-override' }]);
    expect(selected.handlers[0].sha256).toBe(sha(fs.readFileSync(marker)));
    expect(selected.runtime_digest).toMatch(/^[a-f0-9]{64}$/);
    const library = path.join(
      result.consumerRoot,
      'machine/lib/runtimes',
      selected.runtime_digest,
      'surfaces/codex/lib/run-handlers.sh'
    );
    expect(selected.library_resolution['run-handlers.sh'].path).toBe(library);
    const libraryBytes = fs.readFileSync(library);
    const authoredLibrary = path.join(
      PACKAGE,
      'templates/hook-packs/codex/hooks/lib/run-handlers.sh'
    );
    expect(selected.library_resolution['run-handlers.sh'].sha256).toBe(sha(libraryBytes));
    expect(selected.library_resolution['run-handlers.sh'].sha256).toBe(
      sha(fs.readFileSync(authoredLibrary))
    );
    // The inherited snapshot contract covers regular-file bytes and membership.
    const before = json(path.join(logs, 'before-describe.json'));
    const after = json(path.join(logs, 'after-describe.json'));
    expect(after).toEqual(before);
    expect(before['repo/.caws/hooks/marker.sh']).toBe(selected.handlers[0].sha256);
    expect(before[path.relative(result.consumerRoot, library)]).toBe(sha(libraryBytes));
    expect(Object.keys(before)).not.toContain('repo/marker.log');
    expect(Object.keys(after)).not.toContain('repo/marker.log');
    expect(JSON.parse(fs.readFileSync(path.join(logs, 'describe.stdout'), 'utf8'))).toEqual(
      selected
    );
    for (const label of ['git-init', 'install', 'describe', 'execute']) {
      expect(json(path.join(logs, label + '.command.json')).exit_code).toBe(0);
    }
    const markers = files(result.consumerRoot).filter(
      (file) => path.basename(file) === 'marker.log'
    );
    expect(markers).toEqual([path.join(result.consumerRoot, 'repo/marker.log')]);
    expect(fs.readFileSync(markers[0])).toEqual(Buffer.from('invoked\n'));
    const journal = path.join(
      result.consumerRoot,
      'repo/.caws/sessions/selection-session/hook-events.jsonl'
    );
    const rows = fs
      .readFileSync(journal, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      handler: 'marker.sh',
      status: 'completed',
      exit_code: 0,
      session_id: 'selection-session',
      source_sha256: selected.handlers[0].sha256,
      runtime_digest: selected.runtime_digest,
    });
  } finally {
    await cleanupQualification(result);
  }
}, 240000);

test('cold npm pytest entrypoint without only its pretest fails at the missing built installer before invocation', async () => {
  const result = await qualifyEntrypoint({
    artifactRoot: artifacts('cold-missing-pretest'),
    label: 'missing',
    omitPretest: true,
  });
  try {
    expect(Number.isInteger(result.npm.exit_code) && result.npm.exit_code !== 0).toBe(true);
    assertCaptured(result.npm, result.npm.exit_code);
    assertSourceInputs(result, true);
    const build = json(result.buildResultPath);
    expect(build.installer_exists).toBe(false);
    expect(build.installer_sha256).toBeNull();
    expect(fs.existsSync(path.join(result.packageRoot, 'dist'))).toBe(false);
    const logs = path.join(result.consumerRoot, 'logs');
    const install = json(path.join(logs, 'install.command.json'));
    expect(Number.isInteger(install.exit_code) && install.exit_code !== 0).toBe(true);
    const error = fs.readFileSync(path.join(logs, 'install.stderr'), 'utf8');
    expect(error).toContain('MODULE_NOT_FOUND');
    expect(error).toContain(path.join(result.packageRoot, 'dist/init/machine-adapters'));
    expect(result.npm.stdout.toString('utf8') + result.npm.stderr.toString('utf8')).toContain(
      'MODULE_NOT_FOUND'
    );
    expect(fs.existsSync(path.join(result.consumerRoot, 'repo/marker.log'))).toBe(false);
    expect(fs.existsSync(path.join(logs, 'execute.command.json'))).toBe(false);
    expect(
      files(path.join(result.consumerRoot, 'repo/.caws/sessions')).filter(
        (file) => path.basename(file) === 'hook-events.jsonl'
      )
    ).toEqual([]);
  } finally {
    await cleanupQualification(result);
  }
}, 240000);
