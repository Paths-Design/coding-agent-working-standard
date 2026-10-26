'use strict';

/**
 * Test-only npm lifecycle qualification. The outer observer owns one POSIX
 * process group. Inner installer/launcher commands inherit it without detaching.
 * This is neither an OS sandbox nor escaped-session containment.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout } = require('node:timers');

const PACKAGE_ROOT = path.resolve(__dirname, '../..');
const SOURCE_ROOT = path.resolve(PACKAGE_ROOT, '../..');
const SESSION_ID = 'selection-session';
/** @type {Map<string, {pid:number|null,group_absent:boolean|null,cleanup_confirmed:boolean}>} */
const qualifications = new Map();
/** One observed command per fixture: replacing an unresolved group is unsafe. @type {Set<string>} */
const attachedQualifications = new Set();
/** @param {Buffer|string} bytes */
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
/** @param {string} file @param {unknown} value */
const json = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
/** @param {number} ms */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** @param {string} file */
const exists = (file) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
};
/** @param {unknown} error */
function errorCode(error) {
  // Node errors can originate in a different realm from this Jest-loaded helper.
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z0-9_]+$/.test(error.code)
  )
    return error.code;
  return 'UNKNOWN';
}
/** Actual killpg(0) observation. null means unavailable, never absence.
 * @param {number|null} pid @returns {boolean|null}
 */
function groupAbsent(pid) {
  if (!pid || process.platform === 'win32') return null;
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === 'ESRCH' ? true : null;
  }
}
/** @param {string} value */
const shellQuote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
/** @param {string} name @param {string} search */
function executable(name, search) {
  for (const directory of search.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.resolve(directory, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the explicitly supplied PATH for an executable file.
    }
  }
  throw new Error('Required executable unavailable: ' + name);
}
/** @param {string} file */
function identity(file) {
  const actual = fs.realpathSync(file);
  return { path: file, realpath: actual, sha256: sha(fs.readFileSync(actual)) };
}

/**
 * @param {{argv:string[],cwd:string,env:NodeJS.ProcessEnv,outputDir:string,timeoutMs:number,cleanupMs?:number,maxOutputBytes?:number}} options
 */
async function observeCommand(options) {
  if (process.platform === 'win32') throw new Error('POSIX process-group observation required');
  const cleanupMs = options.cleanupMs ?? 5000;
  const maxOutputBytes = options.maxOutputBytes ?? 8388608;
  if (
    !options.argv.length ||
    options.argv.some((item) => typeof item !== 'string') ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 180000 ||
    !Number.isSafeInteger(cleanupMs) ||
    cleanupMs < 1 ||
    cleanupMs > 30000 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 8388608
  )
    throw new Error('Invalid observer bounds');
  fs.mkdirSync(path.dirname(options.outputDir), { recursive: true });
  fs.mkdirSync(options.outputDir);
  const started = process.hrtime.bigint();
  const elapsedMs = () => Number(process.hrtime.bigint() - started) / 1e6;
  const child = spawn(options.argv[0], options.argv.slice(1), {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pid = child.pid ?? null;
  /** @type {Buffer[]} */
  const stdoutParts = [];
  /** @type {Buffer[]} */
  const stderrParts = [];
  let captured = 0,
    outputExceeded = false;
  let stdoutEof = false,
    stderrEof = false,
    forced = false;
  let leaderExited = false,
    closeObserved = false,
    timedOut = false;
  /** @type {number|null} */
  let exitCode = null;
  /** Close can report a spawn errno without any leader exit; retain it separately. @type {number|null} */
  let closeCode = null;
  /** @type {NodeJS.Signals|null} */
  let signal = null;
  /** @type {NodeJS.Signals|null} */
  let closeSignal = null;
  /** @type {string|null} */
  let spawnError = null;
  /** @type {number|null} */
  let spawnElapsed = null,
    exitElapsed = null,
    closeElapsed = null;
  /** @type {{signal:string,sent:boolean,error_code:string|null,elapsed_ms:number}[]} */
  const signals = [];
  /** @param {Buffer[]} parts @param {Buffer} chunk */
  function capture(parts, chunk) {
    const remaining = Math.max(0, maxOutputBytes - captured);
    if (chunk.length > remaining) outputExceeded = true;
    if (remaining) parts.push(chunk.subarray(0, remaining));
    captured += Math.min(chunk.length, remaining);
  }
  child.stdout.on('data', (bytes) => capture(stdoutParts, bytes));
  child.stderr.on('data', (bytes) => capture(stderrParts, bytes));
  child.stdout.once('end', () => {
    stdoutEof = true;
  });
  child.stderr.once('end', () => {
    stderrEof = true;
  });
  child.once('spawn', () => {
    spawnElapsed = elapsedMs();
  });
  child.once('error', (error) => {
    spawnError = errorCode(error);
  });
  child.once('exit', (code, observedSignal) => {
    leaderExited = true;
    exitCode = code;
    signal = observedSignal;
    exitElapsed = elapsedMs();
  });
  child.once('close', (code, observedSignal) => {
    closeObserved = true;
    closeElapsed = elapsedMs();
    closeCode = code;
    closeSignal = observedSignal;
  });
  /** @param {NodeJS.Signals} requested */
  function signalGroup(requested) {
    if (!pid) return;
    let sent = false;
    /** @type {string|null} */
    let code = null;
    try {
      process.kill(-pid, requested);
      sent = true;
    } catch (error) {
      code = errorCode(error);
    }
    signals.push({ signal: requested, sent, error_code: code, elapsed_ms: elapsedMs() });
  }
  /** @type {number|null} */
  let cleanupStarted = null;
  let escalated = false;
  /** @type {boolean|null} */
  let absent = groupAbsent(pid);
  while (true) {
    absent = groupAbsent(pid);
    const settled = leaderExited && closeObserved && stdoutEof && stderrEof && absent === true;
    if (settled || (spawnError && closeObserved && !pid)) break;
    const now = elapsedMs();
    if (cleanupStarted === null && (now >= options.timeoutMs || outputExceeded || spawnError)) {
      timedOut = now >= options.timeoutMs;
      cleanupStarted = now;
      signalGroup('SIGTERM');
    }
    if (cleanupStarted !== null) {
      const cleanupElapsed = now - cleanupStarted;
      if (!escalated && cleanupElapsed >= Math.min(1000, cleanupMs / 2)) {
        escalated = true;
        signalGroup('SIGKILL');
      }
      if (cleanupElapsed >= cleanupMs) {
        if (!escalated) {
          escalated = true;
          signalGroup('SIGKILL');
        }
        break;
      }
    }
    await delay(20);
  }
  // Closing a pipe is a fallback transport action, never an EOF observation.
  if (!stdoutEof) {
    forced = true;
    child.stdout.destroy();
  }
  if (!stderrEof) {
    forced = true;
    child.stderr.destroy();
  }
  absent = groupAbsent(pid);
  if (!leaderExited) child.unref();
  const stdout = Buffer.concat(stdoutParts),
    stderr = Buffer.concat(stderrParts);
  const stdoutPath = path.join(options.outputDir, 'stdout.bin');
  const stderrPath = path.join(options.outputDir, 'stderr.bin');
  const statePath = path.join(options.outputDir, 'state.json');
  fs.writeFileSync(stdoutPath, stdout, { flag: 'wx' });
  fs.writeFileSync(stderrPath, stderr, { flag: 'wx' });
  const cleanupConfirmed =
    leaderExited && closeObserved && stdoutEof && stderrEof && absent === true && !forced;
  const complete = cleanupConfirmed && !timedOut && !outputExceeded && !spawnError;
  const state = {
    schema: 'caws.pytest_entrypoint_command.v1',
    argv: options.argv,
    cwd: options.cwd,
    pid,
    group_pid: pid,
    exit_code: exitCode,
    signal,
    timed_out: timedOut,
    complete,
    completion_scope: 'transport_only',
    stdout_eof: stdoutEof,
    stderr_eof: stderrEof,
    stdio_forced_closed: forced,
    group_absent: absent,
    leader_exit_observed: leaderExited,
    close_observed: closeObserved,
    close_code: closeCode,
    close_signal: closeSignal,
    cleanup_confirmed: cleanupConfirmed,
    spawn_error: spawnError,
    output_truncated: outputExceeded,
    timeout_ms: options.timeoutMs,
    cleanup_ms: cleanupMs,
    max_output_bytes: maxOutputBytes,
    spawn_elapsed_ms: spawnElapsed,
    exit_elapsed_ms: exitElapsed,
    close_elapsed_ms: closeElapsed,
    total_elapsed_ms: elapsedMs(),
    signals,
    stdoutPath,
    stderrPath,
  };
  json(statePath, state);
  return { ...state, stdout, stderr, statePath, stdoutPath, stderrPath };
}

/** @param {string} source @param {string} destination */
function copyTree(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (item) => {
      const name = path.basename(item);
      return !['__pycache__', 'node_modules', 'dist'].includes(name) && !/\.(pyc|pyo)$/.test(name);
    },
  });
}
/** @param {string} root */
function inputFiles(root) {
  /** @type {{path:string,bytes:number,sha256:string}[]} */
  const files = [];
  /** @param {string} relative */
  function walk(relative) {
    for (const entry of fs
      .readdirSync(path.join(root, relative), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relative ? relative + '/' + entry.name : entry.name;
      const file = path.join(root, rel);
      if (entry.isDirectory()) walk(rel);
      else if (fs.statSync(file).isFile()) {
        const bytes = fs.readFileSync(file);
        files.push({ path: rel, bytes: bytes.length, sha256: sha(bytes) });
      }
    }
  }
  walk('');
  return files;
}
/** @param {string} evidenceRoot @param {string} consumerRoot */
function privateEnvironment(evidenceRoot, consumerRoot) {
  const directory = path.join(evidenceRoot, 'environment');
  fs.mkdirSync(directory);
  for (const name of ['npm-userconfig', 'npm-globalconfig', 'gitconfig'])
    fs.writeFileSync(path.join(directory, name), '');
  const search =
    path.dirname(process.execPath) + path.delimiter + (process.env.PATH ?? '/usr/bin:/bin');
  return {
    PATH: search,
    HOME: path.join(consumerRoot, 'user'),
    CAWS_HOME: path.join(consumerRoot, 'machine'),
    PYTHONDONTWRITEBYTECODE: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: path.join(directory, 'gitconfig'),
    GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0',
    NPM_CONFIG_USERCONFIG: path.join(directory, 'npm-userconfig'),
    NPM_CONFIG_GLOBALCONFIG: path.join(directory, 'npm-globalconfig'),
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_PROGRESS: 'false',
    NO_UPDATE_NOTIFIER: '1',
    CAWS_ENTRYPOINT_CONSUMER_ROOT: consumerRoot,
    CAWS_ENTRYPOINT_EVIDENCE_ROOT: evidenceRoot,
  };
}

/** @typedef {{pid:number|null,group_absent:boolean|null,cleanup_confirmed:boolean}} PendingObservation */
/** @typedef {{fixtureRoot:string,packageRoot:string,evidenceRoot:string,consumerRoot:string,sourcePath:string,npm:PendingObservation|Awaited<ReturnType<typeof observeCommand>>}} QualificationFixture */
/** Allocate a real owned source copy before attaching its observed command.
 * The minimal copy contains this authoritative helper; npm qualification adds
 * the same authored inputs it otherwise copies. Allocation grants no cleanup proof.
 * @param {{artifactRoot:string,label:string}} options @returns {QualificationFixture}
 */
function createQualificationFixture({ artifactRoot, label }) {
  if (!path.isAbsolute(artifactRoot) || !/^[A-Za-z0-9._-]+$/.test(label))
    throw new Error('Invalid qualification destination');
  const evidenceRoot = path.join(artifactRoot, label);
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.mkdirSync(evidenceRoot);
  const consumerRoot = path.join(evidenceRoot, 'consumer');
  fs.mkdirSync(consumerRoot);
  fs.mkdirSync(path.join(consumerRoot, 'user'));
  const scratch = path.join(SOURCE_ROOT, '.tmp');
  fs.mkdirSync(scratch, { recursive: true });
  const fixtureRoot = fs.mkdtempSync(path.join(scratch, 'pytest-entrypoint-' + label + '-'));
  const packageRoot = path.join(fixtureRoot, 'packages/caws-cli');
  fs.mkdirSync(path.join(packageRoot, 'tests/helpers'), { recursive: true });
  const sourcePath = path.join(packageRoot, 'tests/helpers/pytest-entrypoint-fixture.js');
  fs.copyFileSync(__filename, sourcePath);
  const npm = { pid: null, group_absent: null, cleanup_confirmed: false };
  qualifications.set(fixtureRoot, npm);
  return { fixtureRoot, packageRoot, evidenceRoot, consumerRoot, sourcePath, npm };
}
/** Attach the actual observer to an already owned fixture. Pending facts are
 * intentionally insufficient for cleanup; no caller-supplied completion grants it.
 * @param {QualificationFixture} fixture
 * @param {Parameters<typeof observeCommand>[0]} options
 */
async function observeQualification(fixture, options) {
  const owned = qualifications.get(fixture.fixtureRoot);
  if (!owned || owned !== fixture.npm || attachedQualifications.has(fixture.fixtureRoot))
    throw new Error('Observer requires an owned qualification fixture with no previous command');
  attachedQualifications.add(fixture.fixtureRoot);
  // Retain the actual registered pending state while the observer owns live work.
  const pending = { pid: null, group_absent: null, cleanup_confirmed: false };
  qualifications.set(fixture.fixtureRoot, pending);
  fixture.npm = pending;
  const observed = await observeCommand(options);
  qualifications.set(fixture.fixtureRoot, observed);
  fixture.npm = observed;
  return observed;
}

/** @param {{artifactRoot:string,label:string,omitPretest?:boolean}} options */
async function qualifyEntrypoint({ artifactRoot, label, omitPretest = false }) {
  const fixture = createQualificationFixture({ artifactRoot, label });
  const { fixtureRoot, packageRoot, evidenceRoot, consumerRoot } = fixture;
  copyTree(path.join(SOURCE_ROOT, 'docs'), path.join(fixtureRoot, 'docs'));
  // The package build stages the repository LICENSE from ../../LICENSE; the
  // fixture root must carry it for the cold build to reach the entrypoint.
  fs.copyFileSync(path.join(SOURCE_ROOT, 'LICENSE'), path.join(fixtureRoot, 'LICENSE'));
  for (const name of ['src', 'scripts', 'surfaces', 'templates'])
    copyTree(path.join(PACKAGE_ROOT, name), path.join(packageRoot, name));
  fs.copyFileSync(
    path.join(PACKAGE_ROOT, 'tsconfig.vnext.json'),
    path.join(packageRoot, 'tsconfig.vnext.json')
  );
  const helperRelative = 'tests/helpers/pytest-entrypoint-fixture.js';
  // The shared allocator already copied the authoritative inner helper.
  const original = fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'));
  const manifest = JSON.parse(original.toString('utf8'));
  const override = shellQuote(process.execPath) + ' ' + helperRelative + ' --installed-scenario';
  manifest.scripts['test:pytest'] = override;
  if (omitPretest) delete manifest.scripts['pretest:pytest'];
  const effective = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(packageRoot, 'package.json'), effective);
  fs.writeFileSync(path.join(evidenceRoot, 'package.original.json'), original);
  fs.writeFileSync(path.join(evidenceRoot, 'package.effective.json'), effective);
  const distAbsent = !exists(path.join(packageRoot, 'dist'));
  assert.equal(distAbsent, true, 'source fixture must not inherit dist');
  const env = privateEnvironment(evidenceRoot, consumerRoot);
  const npmPath = executable('npm', env.PATH);
  const inputManifestPath = path.join(evidenceRoot, 'input-manifest.json');
  json(inputManifestPath, {
    schema: 'caws.pytest_entrypoint_inputs.v1',
    source_root: fixtureRoot,
    authored_source_root: SOURCE_ROOT,
    fixture_root: fixtureRoot,
    package_root: packageRoot,
    dist_absent_before: distAbsent,
    original_package_sha256: sha(original),
    effective_package_sha256: sha(effective),
    omit_pretest: omitPretest,
    pretest_original: JSON.parse(original.toString('utf8')).scripts['pretest:pytest'],
    pretest_effective: manifest.scripts['pretest:pytest'] ?? null,
    test_override: override,
    files: inputFiles(fixtureRoot),
    node: { ...identity(process.execPath), version: process.version },
    npm: identity(npmPath),
    env_keys: Object.keys(env).sort(),
    limits: [
      'No pip/network installation or Python test import.',
      'Uses existing ancestor dependency resolution; creates no dependency symlink.',
      'Installed Python runtime remains an exercised dependency.',
      'Source-copy evidence does not establish full CI or the full Python suite.',
    ],
  });
  const npm = await observeQualification(fixture, {
    argv: [npmPath, 'run', 'test:pytest'],
    cwd: packageRoot,
    env,
    outputDir: path.join(evidenceRoot, 'npm'),
    timeoutMs: 180000,
  });
  const built = path.join(packageRoot, 'dist/init/machine-adapters.js');
  const builtExists = exists(built) && fs.statSync(built).isFile();
  const bytes = builtExists ? fs.readFileSync(built) : null;
  const buildResultPath = path.join(evidenceRoot, 'build-result.json');
  const retainedInstaller = bytes ? path.join(evidenceRoot, 'built-machine-adapters.js') : null;
  if (bytes && retainedInstaller) fs.writeFileSync(retainedInstaller, bytes, { flag: 'wx' });
  json(buildResultPath, {
    schema: 'caws.pytest_entrypoint_build.v1',
    installer_path: built,
    installer_exists: builtExists,
    installer_sha256: bytes ? sha(bytes) : null,
    installer_bytes: bytes ? bytes.length : null,
    retained_installer_path: retainedInstaller,
    npm_state_path: npm.statePath,
  });
  return {
    ...fixture,
    npm,
    inputManifestPath,
    buildResultPath,
    sessionId: SESSION_ID,
    selectionPath: path.join(consumerRoot, 'logs/selection.json'),
    beforeDescribePath: path.join(consumerRoot, 'logs/before-describe.json'),
    afterDescribePath: path.join(consumerRoot, 'logs/after-describe.json'),
  };
}

/** @param {{fixtureRoot:string,npm:PendingObservation|Awaited<ReturnType<typeof observeCommand>>}} result */
function cleanupQualification(result) {
  const owned = qualifications.get(result.fixtureRoot);
  if (
    !owned ||
    owned.pid !== result.npm.pid ||
    !owned.cleanup_confirmed ||
    owned.group_absent !== true ||
    !result.npm.cleanup_confirmed ||
    result.npm.group_absent !== true ||
    groupAbsent(owned.pid) !== true
  )
    throw new Error(
      'Cleanup refused: owned process-group absence is unconfirmed; retain source fixture'
    );
  const scratch = fs.realpathSync(path.join(SOURCE_ROOT, '.tmp'));
  const actual = fs.realpathSync(result.fixtureRoot);
  if (path.dirname(actual) !== scratch || !path.basename(actual).startsWith('pytest-entrypoint-'))
    throw new Error('Cleanup refused: source copy is not an owned fixture');
  fs.rmSync(actual, { recursive: true, force: false });
  qualifications.delete(result.fixtureRoot);
  attachedQualifications.delete(result.fixtureRoot);
}

/** Inner commands are synchronous and inherit the npm process group.
 * Their return does not independently prove descendant settlement or pipe EOF.
 * @param {string} logs @param {string} label @param {string[]} argv
 * @param {string} cwd @param {NodeJS.ProcessEnv} env @param {Buffer} [input]
 */
function innerCommand(logs, label, argv, cwd, env, input) {
  const stdoutPath = path.join(logs, label + '.stdout');
  const stderrPath = path.join(logs, label + '.stderr');
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env,
    shell: false,
    detached: false,
    input,
    maxBuffer: 8388608,
  });
  fs.writeFileSync(stdoutPath, result.stdout ?? Buffer.alloc(0), { flag: 'wx' });
  fs.writeFileSync(stderrPath, result.stderr ?? Buffer.alloc(0), { flag: 'wx' });
  json(path.join(logs, label + '.command.json'), {
    schema: 'caws.pytest_entrypoint_inner_command.v1',
    argv,
    cwd,
    exit_code: result.status,
    signal: result.signal,
    completion_scope: 'synchronous_child_result',
    error_code: result.error ? errorCode(result.error) : null,
    stdoutPath,
    stderrPath,
  });
  if (result.error || result.status !== 0) {
    const error = new Error('Installed scenario command failed: ' + label);
    process.stderr.write(result.stderr ?? Buffer.alloc(0));
    throw error;
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

/** Snapshots intentionally exclude observational logs, which are siblings of the watched roots.
 * @param {string} root @returns {Record<string,string>}
 */
function consumerSnapshot(root) {
  /** @type {Record<string,string>} */
  const rows = {};
  /** @param {string} directory @param {string} relative */
  function walk(directory, relative) {
    if (!exists(directory)) return;
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const key = relative + '/' + entry.name;
      if (entry.isDirectory()) walk(absolute, key);
      else if (fs.statSync(absolute).isFile()) rows[key] = sha(fs.readFileSync(absolute));
    }
  }
  for (const name of ['machine', 'repo', 'user']) walk(path.join(root, name), name);
  return rows;
}

/** Reproduces the actual installed selection/dispatch scenario with the built installer. */
function installedScenario() {
  const configured = process.env.CAWS_ENTRYPOINT_CONSUMER_ROOT;
  const evidence = process.env.CAWS_ENTRYPOINT_EVIDENCE_ROOT;
  if (!configured || !evidence || !path.isAbsolute(configured) || !path.isAbsolute(evidence))
    throw new Error('Explicit private scenario roots required');
  const root = fs.realpathSync(configured);
  const logs = path.join(root, 'logs');
  fs.mkdirSync(logs);
  const repo = path.join(root, 'repo'),
    home = path.join(root, 'machine'),
    user = path.join(root, 'user');
  fs.mkdirSync(repo);
  const env = {
    ...process.env,
    HOME: user,
    CAWS_HOME: home,
    CAWS_PROJECT_DIR: repo,
    PYTHONDONTWRITEBYTECODE: '1',
  };
  innerCommand(
    logs,
    'git-init',
    [executable('git', env.PATH ?? ''), 'init', '-q', '-b', 'main', repo],
    repo,
    env
  );
  innerCommand(
    logs,
    'install',
    [
      process.execPath,
      '-e',
      'const m=require(process.argv[1]); console.log(JSON.stringify(m.installMachineRuntime({home:process.argv[2],templatesRoot:process.argv[3]})));',
      path.join(PACKAGE_ROOT, 'dist/init/machine-adapters'),
      home,
      path.join(PACKAGE_ROOT, 'templates/hook-packs'),
    ],
    repo,
    env
  );
  const pointer = JSON.parse(
    fs.readFileSync(path.join(home, 'state/adapter-runtime.json'), 'utf8')
  );
  const runtime = path.join(home, 'lib/runtimes', pointer.digest);
  const defaults = JSON.parse(
    fs.readFileSync(path.join(runtime, 'system-policy.json'), 'utf8')
  ).events;
  fs.mkdirSync(path.join(repo, '.caws/specs'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.caws/policy.yaml'), 'version: 1\n');
  const hooks = path.join(repo, '.caws/hooks');
  fs.mkdirSync(hooks);
  const marker = path.join(hooks, 'marker.sh');
  fs.writeFileSync(marker, '#!/bin/bash\nprintf "invoked\\n" >> "$CAWS_PROJECT_DIR/marker.log"\n', {
    mode: 0o755,
  });
  /** @type {Record<string,string[]>} */
  const disabled = {};
  for (const [event, handlers] of Object.entries(defaults)) {
    assert.ok(Array.isArray(handlers));
    disabled[event] = handlers.map((handler) => String(handler).split(/\s+/)[0]);
  }
  const config = {
    disabled,
    extensions: { pre_tool_use: [{ handler: 'marker.sh', before: null }] },
    handlers: { 'marker.sh': '.caws/hooks/marker.sh' },
    libraries: {},
  };
  fs.mkdirSync(path.join(home, 'surfaces/codex'), { recursive: true });
  json(path.join(home, 'surfaces/codex/settings.json'), { version: 1, enabled: true });
  fs.mkdirSync(path.join(home, 'state/projects'), { recursive: true });
  json(path.join(home, 'state/projects', sha(repo) + '.json'), {
    version: 1,
    root: repo,
    surfaces: { codex: config },
  });
  const before = consumerSnapshot(root);
  json(path.join(logs, 'before-describe.json'), before);
  const python = executable('python3', env.PATH ?? '');
  json(path.join(logs, 'runtime-identities.json'), {
    python: identity(python),
    node: { ...identity(process.execPath), version: process.version },
    runtime_digest: pointer.digest,
    launcher: identity(path.join(home, 'bin/caws-hook')),
  });
  const payload = Buffer.from(JSON.stringify({ session_id: SESSION_ID, tool_name: 'Read' }));
  fs.writeFileSync(path.join(logs, 'read-payload.json'), payload);
  const argv = [python, path.join(home, 'bin/caws-hook'), 'codex', 'pre_tool_use', '--system'];
  const description = innerCommand(logs, 'describe', [...argv, '--describe'], repo, env, payload);
  const selected = JSON.parse(description.stdout.toString('utf8'));
  json(path.join(logs, 'selection.json'), selected);
  const after = consumerSnapshot(root);
  json(path.join(logs, 'after-describe.json'), after);
  assert.deepEqual(after, before, 'describe must preserve all watched file bytes and membership');
  assert.deepEqual(
    selected.handlers.map((handler) => [handler.path, handler.kind]),
    [[marker, 'project-override']]
  );
  assert.equal(selected.handlers[0].sha256, sha(fs.readFileSync(marker)));
  assert.equal(
    selected.library_resolution['run-handlers.sh'].path,
    path.join(runtime, 'surfaces/codex/lib/run-handlers.sh')
  );
  assert.equal(exists(path.join(repo, 'marker.log')), false);
  innerCommand(logs, 'execute', argv, repo, env, payload);
  assert.equal(fs.readFileSync(path.join(repo, 'marker.log'), 'utf8'), 'invoked\n');
  const records = fs
    .readFileSync(path.join(repo, '.caws/sessions', SESSION_ID, 'hook-events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(records.length, 1);
  const record = records[0];
  assert.deepEqual(
    {
      handler: record.handler,
      status: record.status,
      exit_code: record.exit_code,
      session_id: record.session_id,
    },
    { handler: 'marker.sh', status: 'completed', exit_code: 0, session_id: SESSION_ID }
  );
  assert.equal(record.source_sha256, selected.handlers[0].sha256);
  assert.equal(record.runtime_digest, selected.runtime_digest);
  json(path.join(logs, 'scenario-result.json'), {
    schema: 'caws.pytest_entrypoint_scenario.v1',
    session_id: SESSION_ID,
    marker_path: path.join(repo, 'marker.log'),
    marker_sha256: sha(Buffer.from('invoked\n')),
    selected_path: marker,
    selected_sha256: record.source_sha256,
    runtime_digest: record.runtime_digest,
  });
}
module.exports = {
  observeCommand,
  createQualificationFixture,
  observeQualification,
  qualifyEntrypoint,
  cleanupQualification,
};
if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== '--installed-scenario') {
    process.stderr.write('Usage: pytest-entrypoint-fixture.js --installed-scenario\n');
    process.exitCode = 2;
  } else {
    try {
      installedScenario();
    } catch (error) {
      process.stderr.write(
        (error instanceof Error ? error.stack : 'Installed scenario failed') + '\n'
      );
      process.exitCode = 1;
    }
  }
}
