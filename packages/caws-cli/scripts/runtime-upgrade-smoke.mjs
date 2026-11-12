#!/usr/bin/env node
// Qualify installed artifacts in isolated machine homes. Never consult the
// developer's CAWS registration, npm config, Git hooks, or agent identity.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { requireQualificationSupervisor, supervisedSpawn } from './runtime-upgrade-supervisor.mjs';
import {
  stageSelectedTarball,
  verifySelectedTarball,
  verifyInstalledTarballLock,
  captureGovernance,
  captureFailedGovernance,
  verifyGovernancePreserved,
} from './native-upgrade-artifacts.cjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageName = '@paths.design/caws-cli';
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export function isolatedEnvironment(root, inherited = process.env) {
  const home = path.join(root, 'home');
  const env = Object.fromEntries(
    ['PATH', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'TMPDIR', 'TMP', 'TEMP']
      .filter((key) => inherited[key])
      .map((key) => [key, inherited[key]])
  );
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    CAWS_HOME: path.join(home, '.caws'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Upgrade fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Upgrade fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
    npm_config_cache: path.join(root, 'npm-cache'),
    npm_config_userconfig: path.join(home, '.npmrc'),
    npm_config_update_notifier: 'false',
    PYTHONDONTWRITEBYTECODE: '1',
  };
}

let receiptSequence = 0;
export function observedSpawn(command, args, options, onUncertainOutcome = () => {}) {
  const started = Date.now();
  // spawnSync has already reaped its direct child. Its numeric pid no longer
  // grants signal authority over a group, and its result says nothing about
  // descendants. Mark uncertainty before receipt IO can fail.
  const supervisor = Object.hasOwn(options, 'qualificationSupervisor')
    ? options.qualificationSupervisor
    : process.env.CAWS_QUALIFICATION_SUPERVISOR;
  const result = supervisor
    ? supervisedSpawn(supervisor, command, args, options)
    : spawnSync(command, args, options);
  const uncertain =
    Boolean(result.error) ||
    result.signal != null ||
    !Number.isInteger(result.status) ||
    Boolean(result.qualificationCustody?.uncertain);
  result.qualificationCustody ??= {
    direct_child_timeout_only: true,
    descendant_settlement: 'unproven',
    uncertain,
  };
  result.qualificationCustody.uncertain = uncertain;
  if (uncertain)
    onUncertainOutcome({
      command,
      args,
      cwd: options.cwd,
      input: options.input ?? null,
      pid: result.pid ?? null,
      status: result.status ?? null,
      signal: result.signal ?? null,
      error: result.error?.message ?? null,
      duration_ms: Date.now() - started,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      custody: result.qualificationCustody,
      frontend: result.qualificationFrontend,
    });
  const dir = options.env?.CAWS_QUALIFICATION_ARTIFACT_DIR;
  if (dir) {
    const receipt = {
      command,
      args,
      cwd: options.cwd,
      input: options.input ?? null,
      exit_code: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      duration_ms: Date.now() - started,
      timeout_cleanup: result.qualificationTimeoutCleanup ?? null,
      custody: result.qualificationCustody,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
    const name = `command-${String(++receiptSequence).padStart(4, '0')}.json`;
    const bytes = JSON.stringify(receipt, null, 2) + '\n';
    write(path.join(dir, name), bytes);
    result.qualificationReceipt = { file: name, sha256: hash(bytes) };
  }
  return result;
}

function runChecked(command, args, cwd, env, options = {}, onUncertainOutcome) {
  const result = observedSpawn(
    command,
    args,
    {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 300000,
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    },
    onUncertainOutcome
  );
  if (result.status !== 0 || result.qualificationCustody.uncertain)
    throw new Error(
      `${command} ${args.join(' ')}: exit ${result.status}\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`
    );
  return result.stdout;
}

export function retainQualificationFixture(root, report, uncertainOutcomes) {
  // Even a natural direct-child exit cannot prove that a detached descendant
  // has stopped using this fixture. Only a future supervisor settlement proof
  // can authorize automatic deletion; do not infer it from command exit codes.
  report.retainedFixture = root;
  report.cleanup = 'not attempted: descendant settlement unproven';
  report.uncertainOutcomes = uncertainOutcomes;
  if (uncertainOutcomes.length) report.ok = false;
}
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// Retain the actual file, including missing or nonregular post-state on failure.
export function captureQualificationFile(file, artifacts, name) {
  const result = { path: path.resolve(file) };
  try {
    const stat = fs.lstatSync(file);
    result.kind = stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other';
    result.mode = stat.mode & 0o7777;
    if (result.kind === 'file') {
      const bytes = fs.readFileSync(file);
      result.file = path.join('raw', name);
      result.sha256 = hash(bytes);
      result.size = bytes.length;
      write(path.join(artifacts, result.file), bytes);
      fs.chmodSync(path.join(artifacts, result.file), result.mode);
    }
  } catch (error) {
    result.kind = error.code === 'ENOENT' ? 'missing' : 'error';
    if (result.kind === 'error') result.error = error.message;
  }
  return result;
}

const guardedProofIds = [
  'migrated-codex-stock',
  'migrated-codex-custom',
  'migrated-claude-code-stock',
  'migrated-claude-code-custom',
  'linked-worktree',
  'updated-codex-stock',
  'updated-codex-custom',
  'corrupt-runtime',
  'rollback-recovered',
];
const rendererProofIds = ['codex-stock', 'codex-custom'];

/**
 * What a harness does with a PreToolUse answer: the tool runs unless the hook
 * exits 2 or answers with a block, deny or ask. Claude Code treats every other
 * non-zero exit, and a hook killed by a signal, as a non-blocking error and
 * runs the tool, so those count as admitted: a guard that fails that way must
 * fail this qualification rather than pass as a refusal. Output that is not a
 * decision does not stop the tool either.
 */
export function harnessAdmits(result) {
  if (result.status === 2) return false;
  if (result.status !== 0) return true;
  const text = String(result.stdout ?? '').trim();
  if (!text) return true;
  let reply;
  try {
    reply = JSON.parse(text);
  } catch {
    return true;
  }
  if (reply === null || typeof reply !== 'object') return true;
  const decision = reply.hookSpecificOutput?.permissionDecision;
  return !(
    reply.decision === 'block' ||
    reply.continue === false ||
    decision === 'deny' ||
    decision === 'ask'
  );
}

/**
 * Perform the Write the hook was asked about, exactly when the hook admitted
 * it. Without this the target can never change, and "the protected bytes are
 * unchanged" would hold for a guard that admits everything.
 *
 * @returns {boolean} whether the write was performed
 */
export function applyAdmittedWrite(result, toolInput) {
  if (!harnessAdmits(result)) return false;
  fs.mkdirSync(path.dirname(toolInput.file_path), { recursive: true });
  fs.writeFileSync(toolInput.file_path, toolInput.content);
  return true;
}

// Expectations are supplied by the executing scenario independently of its
// retained manifest. This verifies custody, not native harness enforcement.
export function verifyQualificationCustody(artifacts, expected) {
  const proof = json(path.join(artifacts, 'custody.json'));
  const canonicalRoot = fs.realpathSync(artifacts);
  const usedReceipts = new Set();
  const artifact = (relative) => {
    assert.equal(typeof relative, 'string');
    const file = path.resolve(artifacts, relative);
    const rel = path.relative(path.resolve(artifacts), file);
    assert.ok(rel && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
    assert.ok(fs.lstatSync(file).isFile(), `Nonregular retained artifact: ${relative}`);
    const canonicalRel = path.relative(canonicalRoot, fs.realpathSync(file));
    assert.ok(
      canonicalRel &&
        !path.isAbsolute(canonicalRel) &&
        canonicalRel !== '..' &&
        !canonicalRel.startsWith(`..${path.sep}`),
      `Artifact escapes retained root: ${relative}`
    );
    return file;
  };
  const bytes = (record, source) => {
    assert.equal(record.path, source);
    assert.equal(record.kind, 'file', `Missing/nonregular source: ${source}`);
    const file = artifact(record.file);
    const retained = fs.readFileSync(file);
    assert.equal(hash(retained), record.sha256, `Corrupt retained bytes: ${record.file}`);
    assert.equal(retained.length, record.size);
    assert.equal(fs.lstatSync(file).mode & 0o7777, record.mode);
    return retained;
  };
  const missing = (record, source) => {
    assert.equal(record.path, source);
    assert.equal(record.kind, 'missing', `Output existed before operation: ${source}`);
  };
  const receipt = (record, scenario, event, status) => {
    assert.ok(record && !usedReceipts.has(record.file), 'Missing or reused command receipt');
    usedReceipts.add(record.file);
    const raw = fs.readFileSync(artifact(record.file));
    assert.equal(hash(raw), record.sha256, 'Changed command receipt');
    const command = JSON.parse(raw);
    assert.equal(command.command, 'python3');
    assert.deepEqual(command.args, [expected.launcher, scenario.surface, event, '--system']);
    assert.equal(command.cwd, scenario.cwd);
    assert.equal(command.exit_code, status);
    assert.equal(command.error, null);
    assert.equal(command.signal, null);
    assert.equal(command.timeout_cleanup, null);
    const payload = JSON.parse(command.input);
    assert.equal(payload.cwd, scenario.cwd);
    assert.equal(payload.session_id, scenario.sessionId);
    return { command, payload };
  };
  const runtime = (record, digest) => {
    assert.equal(JSON.parse(bytes(record, expected.pointer)).digest, digest);
  };
  for (const [records, ids, scenarios] of [
    [proof.guards, guardedProofIds, expected.guards],
    [proof.renderers, rendererProofIds, expected.renderers],
  ]) {
    assert.deepEqual(records.map((record) => record.id).sort(), [...ids].sort());
    assert.deepEqual(scenarios.map((record) => record.id).sort(), [...ids].sort());
  }
  for (const record of proof.guards) {
    const scenario = expected.guards.find(({ id }) => id === record.id);
    const before = bytes(record.before, scenario.target);
    const after = bytes(record.after, scenario.target);
    // The write was attempted the way a harness would: performed only if the
    // guard admitted it. A refusal leaves it unperformed and the bytes intact.
    assert.equal(
      record.writeApplied,
      false,
      `Guard admitted the forbidden write, which was then performed: ${record.id}`
    );
    assert.deepEqual(before, Buffer.from(scenario.sentinel));
    assert.deepEqual(after, before, `Protected target changed: ${record.id}`);
    assert.equal(record.before.mode, 0o640);
    assert.equal(record.after.mode, record.before.mode);
    runtime(record.runtimeBefore, scenario.digest);
    runtime(record.runtimeAfter, scenario.digest);
    const { command, payload } = receipt(record.receipt, scenario, 'pre_tool_use', 2);
    assert.equal(payload.tool_name, 'Write');
    assert.equal(payload.tool_input.file_path, scenario.target);
    assert.equal(payload.tool_input.content, 'forbidden fixture write');
    if (record.id === 'corrupt-runtime') assert.match(command.stderr, /Runtime modified/);
    else if (record.id.startsWith('updated-'))
      assert.match(command.stderr, /qualification-updated-guard/);
    else {
      assert.match(command.stdout + command.stderr, /protected|scope|governed/i);
      assert.doesNotMatch(command.stderr, /qualification-updated-guard|Runtime modified/);
    }
  }
  for (const record of proof.renderers) {
    const scenario = expected.renderers.find(({ id }) => id === record.id);
    missing(record.markerBefore, scenario.marker);
    missing(record.turnBefore, scenario.turn);
    assert.equal(bytes(record.marker, scenario.marker).toString('utf8'), 'updated-renderer');
    runtime(record.runtimeBefore, scenario.digest);
    runtime(record.runtimeAfter, scenario.digest);
    const { payload } = receipt(record.receipt, scenario, 'stop', 0);
    assert.equal(payload.transcript_path, scenario.transcript);
    const transcript = bytes(record.transcript, scenario.transcript)
      .toString('utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(transcript[0].payload.content[0].text, scenario.prompt);
    assert.equal(transcript[1].payload.call_id, scenario.callId);
    assert.equal(transcript[2].payload.call_id, scenario.callId);
    assert.equal(transcript[2].payload.output, scenario.output);
    const turn = JSON.parse(bytes(record.turn, scenario.turn));
    assert.equal(turn.context.session_id, scenario.sessionId);
    assert.equal(turn.context.cwd, scenario.cwd);
    assert.equal(turn.user, scenario.prompt);
    const tool = turn.timeline.find(
      (item) => item.kind === 'tool_call' && item.id === scenario.callId
    );
    assert.ok(tool, `Missing semantic tool record: ${record.id}`);
    assert.equal(tool.name, 'Bash');
    assert.equal(tool.command, 'pwd');
    assert.equal(tool.output, scenario.output);
  }
  return true;
}
function snapshot(root, accept = () => true) {
  const result = {};
  function visit(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name),
        relative = path.relative(root, file);
      if (!accept(relative)) continue;
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) result[relative] = hash(fs.readFileSync(file));
      else throw new Error(`Unexpected fixture link: ${file}`);
    }
  }
  visit(root);
  return result;
}
export function retainFixtureDiagnostics(root, artifacts) {
  const retained = [];
  for (const project of [
    'codex-stock',
    'codex-custom',
    'claude-code-stock',
    'claude-code-custom',
    'fresh',
    'linked',
  ]) {
    for (const relative of ['.caws/sessions', '.claude/logs', '.codex/logs']) {
      const source = path.join(root, project, relative);
      if (!fs.existsSync(source)) continue;
      const destination = path.join(artifacts, 'failure-traces', project, relative);
      fs.cpSync(source, destination, {
        recursive: true,
        filter: (file) => !fs.lstatSync(file).isSymbolicLink(),
      });
      retained.push(path.relative(artifacts, destination));
    }
  }
  const scratch = path.join(root, 'tmp');
  if (fs.existsSync(scratch)) {
    for (const entry of fs.readdirSync(scratch, { withFileTypes: true })) {
      if (!entry.isFile() || !/^caws-hook-(execution|offers)-.+\.jsonl$/.test(entry.name)) continue;
      const destination = path.join(artifacts, 'failure-traces/runtime-exchange', entry.name);
      write(destination, fs.readFileSync(path.join(scratch, entry.name)));
      retained.push(path.relative(artifacts, destination));
    }
  }
  return retained;
}
const governance = (repo) =>
  snapshot(path.join(repo, '.caws'), (rel) =>
    [
      'policy.yaml',
      'specs',
      'claims',
      'waivers',
      'events.jsonl',
      'worktrees.json',
      'agents.json',
    ].includes(rel.split(path.sep)[0])
  );

export function qualify({
  candidate = packageRoot,
  baseline = `${packageName}@12.1.0`,
  reportPath,
  tarball: selectedTarball,
  tarballSha256,
  supervisor = process.env.CAWS_QUALIFICATION_SUPERVISOR,
} = {}) {
  assert.equal(
    selectedTarball !== undefined,
    tarballSha256 !== undefined,
    'Selected tarball and expected SHA-256 must be supplied together'
  );
  supervisor = requireQualificationSupervisor(supervisor);
  const uncertainOutcomes = [];
  const onUncertainOutcome = (outcome) => uncertainOutcomes.push(outcome);
  const run = (command, args, cwd, env, options) =>
    runChecked(
      command,
      args,
      cwd,
      env,
      { ...options, qualificationSupervisor: supervisor },
      onUncertainOutcome
    );
  const observe = (command, args, options) => {
    const result = observedSpawn(
      command,
      args,
      { ...options, qualificationSupervisor: supervisor },
      onUncertainOutcome
    );
    assert.equal(uncertainOutcomes.length, 0, 'Uncertain subprocess custody');
    return result;
  };
  candidate = fs.realpathSync(candidate);
  if (selectedTarball === undefined && !fs.existsSync(path.join(candidate, 'dist/index.js')))
    throw new Error('Built candidate dist/index.js is required');
  if (json(path.join(candidate, 'package.json')).name !== packageName)
    throw new Error('Expected CAWS CLI candidate');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-runtime-upgrade-')));
  // This fixture owns creation and cleanup of its private exchange directory.
  // Keep the reusable environment builder pure and usable by other callers
  // which have not provisioned this fixture-specific scratch path.
  const fixtureScratch = path.join(root, 'tmp');
  const env = {
    ...isolatedEnvironment(root),
    TMPDIR: fixtureScratch,
    TMP: fixtureScratch,
    TEMP: fixtureScratch,
  };
  let artifacts = null;
  if (reportPath) {
    const parent = `${path.resolve(reportPath)}.artifacts`;
    fs.mkdirSync(parent, { recursive: true });
    artifacts = fs.mkdtempSync(path.join(parent, 'run-'));
  }
  const evidenceRoot = artifacts ?? path.join(root, 'diagnostic-evidence');
  env.CAWS_QUALIFICATION_ARTIFACT_DIR = evidenceRoot;
  fs.mkdirSync(env.HOME, { recursive: true });
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  // Detached npm installation: no workspace dependencies or lifecycle repair.
  const consumer = path.join(root, 'consumer');
  write(path.join(consumer, 'package.json'), '{"private":true}');
  // Stock and custom handlers can invoke bare `caws`. Their CLI must come from
  // this detached installation too, never from the developer's global PATH.
  env.PATH = [path.join(consumer, 'node_modules/.bin'), env.PATH || ''].join(path.delimiter);
  const entry = path.join(consumer, 'node_modules', packageName, 'dist/index.js');
  const cli = (cwd, ...args) => run(process.execPath, [entry, ...args], cwd, env);
  const git = (cwd, ...args) =>
    run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], cwd, env);
  const step = (message) => console.log(`[runtime-upgrade] ${message}`);
  const report = {
    schemaVersion: 2,
    artifacts,
    candidateVersion: json(path.join(candidate, 'package.json')).version,
    baseline,
    platform: process.platform,
    node: process.version,
    cases: [],
    governance: [],
    proof: 'installed-artifact subprocess fixtures; native harness activation is separate',
    persistentCustodyVerified: false,
    qualifierSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
    qualifierSupervisorAdapterSha256: hash(
      fs.readFileSync(new URL('./runtime-upgrade-supervisor.mjs', import.meta.url))
    ),
    qualifierArtifactAdapterSha256: hash(
      fs.readFileSync(new URL('./native-upgrade-artifacts.cjs', import.meta.url))
    ),
  };
  const custody = { guards: [], renderers: [] };
  const expectations = {
    pointer: path.join(env.CAWS_HOME, 'state/adapter-runtime.json'),
    launcher: path.join(env.CAWS_HOME, 'bin/caws-hook'),
    guards: [],
    renderers: [],
  };
  const saveCustody = () => {
    write(path.join(evidenceRoot, 'custody.json'), JSON.stringify(custody, null, 2) + '\n');
    // Preserve producer expectations separately from observed custody records.
    // The report hash binds post-cleanup readback to this scenario's inputs.
    const expectedBytes = JSON.stringify(expectations, null, 2) + '\n';
    const expectedFile = path.join(evidenceRoot, 'custody-expectations.json');
    write(expectedFile, expectedBytes);
    report.custodyExpectations = artifacts
      ? { file: expectedFile, sha256: hash(expectedBytes) }
      : null;
  };
  const capture = (file, name) => captureQualificationFile(file, evidenceRoot, name);
  const fixtures = [];
  let failure = null;
  try {
    // Capture a supplied artifact before any installation can observe its path.
    // A source build/pack is only the explicit compatibility-mode alternative.
    const selected =
      selectedTarball === undefined
        ? null
        : stageSelectedTarball(selectedTarball, tarballSha256, root);
    report.artifactSelection = selected ? { ...selected } : null;
    step('install published baseline and materialize stock/custom projects');
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', baseline], consumer, env);
    report.baselineVersion = cli(consumer, '--version').trim();
    for (const surface of ['codex', 'claude-code']) {
      for (const custom of [false, true]) {
        const name = `${surface}-${custom ? 'custom' : 'stock'}`;
        const repo = path.join(root, name);
        fs.mkdirSync(repo);
        git(repo, 'init', '-q', '-b', 'main');
        git(repo, 'commit', '--allow-empty', '-qm', 'fixture');
        cli(repo, 'init', '--agent-surface', surface);
        const native = path.join(
          repo,
          surface === 'codex' ? '.codex/hooks.json' : '.claude/settings.json'
        );
        assert.ok(fs.existsSync(native), `baseline native hooks missing: ${name}`);
        if (custom) {
          const hook = path.join(repo, '.caws/hooks/qualification-custom.sh');
          write(hook, '#!/bin/bash\necho qualification-custom-ran >&2\n');
          fs.chmodSync(hook, 0o755);
          const dispatcher = path.join(repo, '.caws/hooks/dispatch/pre_tool_use.sh');
          const bytes = fs.readFileSync(dispatcher, 'utf8');
          assert.ok(bytes.includes('HANDLERS=('));
          write(dispatcher, bytes.replace('HANDLERS=(', 'HANDLERS=(\n  "qualification-custom.sh"'));
        }
        git(repo, 'add', '.');
        git(repo, 'commit', '-qm', 'baseline project');
        const rawRecord = {
          name,
          before: captureGovernance(repo, evidenceRoot, `${name}-before`),
          after: null,
        };
        report.governance.push(rawRecord);
        write(
          path.join(evidenceRoot, `${name}-governance-raw.json`),
          JSON.stringify(rawRecord, null, 2) + '\n'
        );
        fixtures.push({
          name,
          repo,
          surface,
          custom,
          native,
          before: governance(repo),
          rawRecord,
        });
      }
    }
    step('select candidate artifact, replace baseline package and install global runtime');
    const packed = selected
      ? null
      : JSON.parse(run('npm', ['pack', '--json', '--pack-destination', root], candidate, env));
    const tarball = selected ? selected.path : path.join(root, packed[0].filename);
    report.tarballSha256 = hash(fs.readFileSync(tarball));
    report.packageFiles = packed
      ? {
          count: packed[0].files.length,
          bytecode: packed[0].files
            .filter(({ path: file }) => /(?:__pycache__\/|\.py[co]$)/.test(file))
            .map(({ path: file }) => file),
        }
      : null;
    if (packed) assert.deepEqual(report.packageFiles.bytecode, []);
    if (selected) verifySelectedTarball(selected);
    if (artifacts) {
      report.candidateArtifact = path.join(artifacts, 'candidate.tgz');
      fs.copyFileSync(tarball, report.candidateArtifact);
      assert.equal(hash(fs.readFileSync(report.candidateArtifact)), report.tarballSha256);
    }
    if (selected) verifySelectedTarball(selected);
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], consumer, env);
    if (selected) {
      verifySelectedTarball(selected);
      verifyInstalledTarballLock(
        json(path.join(consumer, 'package-lock.json')),
        consumer,
        selected,
        packageName
      );
      const installedFiles = Object.keys(snapshot(path.dirname(path.dirname(entry))));
      report.packageFiles = {
        basis: 'installed-selected-package',
        count: installedFiles.length,
        bytecode: installedFiles.filter((file) => /(?:__pycache__\/|\.py[co]$)/.test(file)),
      };
      assert.deepEqual(report.packageFiles.bytecode, []);
    }
    assert.equal(cli(consumer, '--version').trim(), report.candidateVersion);
    const resolvedCli = run('/bin/bash', ['-c', 'command -v caws'], consumer, env).trim();
    assert.equal(fs.realpathSync(resolvedCli), fs.realpathSync(entry));
    const hookCliVersion = run('caws', ['--version'], consumer, env).trim();
    assert.equal(hookCliVersion, report.candidateVersion);
    report.hookCli = {
      resolvedPath: resolvedCli,
      entrySha256: hash(fs.readFileSync(entry)),
      version: hookCliVersion,
    };
    // Consumer resolution does not inherit workspace overrides or its lockfile.
    // Audit the actual upgraded installation before trusting the package check.
    const audit = JSON.parse(
      run('npm', ['audit', '--omit=dev', '--audit-level=low', '--json'], consumer, env)
    );
    assert.equal(audit.metadata.vulnerabilities.total, 0);
    report.productionAudit = {
      vulnerabilities: audit.metadata.vulnerabilities,
      lockfileSha256: hash(fs.readFileSync(path.join(consumer, 'package-lock.json'))),
    };
    report.cases.push({ name: 'installed-production-audit', zeroFindings: true });
    const installed = JSON.parse(cli(consumer, 'init', 'adapters', 'install', '--json'));
    report.runtimeDigest = installed.digest;
    // Exercise the installed bootstrap, not only the selected source driver:
    // a missing pointer fails before the driver can classify an invalid event.
    const boundaryResults = [];
    for (const [event, expected] of [
      ['session_ended', 2],
      ['stop', 0],
      ['pre_tool_use', 2],
    ]) {
      const result = observe(
        'python3',
        [path.join(env.CAWS_HOME, 'bin/caws-hook'), 'codex', event, '--system'],
        {
          cwd: consumer,
          env: { ...env, CAWS_HOME: path.join(root, 'missing-runtime') },
          encoding: 'utf8',
          timeout: 30000,
          input: '{}',
        }
      );
      assert.equal(
        result.status,
        expected,
        JSON.stringify({ event, stdout: result.stdout, stderr: result.stderr })
      );
      if (event === 'session_ended') assert.match(result.stderr, /Usage: caws-hook/);
      else assert.match(result.stderr, /adapter-runtime\.json/);
      if (event === 'pre_tool_use') assert.equal(JSON.parse(result.stdout).decision, 'block');
      else assert.equal(result.stdout, '');
      boundaryResults.push({ event, exitCode: result.status });
    }
    report.cases.push({ name: 'installed-invocation-boundary', results: boundaryResults });
    assert.equal(
      JSON.parse(cli(consumer, 'init', 'adapters', 'install', '--plan', '--json')).changed,
      false
    );
    for (const surface of ['codex', 'claude-code']) {
      cli(consumer, 'init', 'adapters', 'configure', '--agent-surface', surface, '--json');
      assert.equal(
        JSON.parse(
          cli(
            consumer,
            'init',
            'adapters',
            'configure',
            '--agent-surface',
            surface,
            '--plan',
            '--json'
          )
        ).changed,
        false
      );
    }
    const blank = () => ({ disabled: {}, extensions: {}, handlers: {}, libraries: {} });
    const protectedTarget = (f) =>
      path.join(
        f.repo,
        f.surface === 'codex' ? '.codex' : '.claude',
        'hooks/qualification-probe.sh'
      );
    const sentinel = (f) => `qualification-owned-sentinel:${f.name}\n`;
    const forbiddenWrite = (f) => ({
      file_path: protectedTarget(f),
      content: 'forbidden fixture write',
    });
    // Mixed fleet: user transport defers while baseline native hooks remain.
    const hook = (f, event, extra = {}, runtimeEnv = {}) =>
      observe(
        'python3',
        [path.join(env.CAWS_HOME, 'bin/caws-hook'), f.surface, event, '--system'],
        {
          cwd: f.cwd ?? f.repo,
          env: { ...env, ...runtimeEnv },
          encoding: 'utf8',
          timeout: 60000,
          input: JSON.stringify({
            cwd: f.cwd ?? f.repo,
            session_id: `qualification-${f.name}`,
            tool_name: 'Write',
            tool_input: forbiddenWrite(f),
            ...extra,
          }),
        }
      );
    const guardedProof = (f, id, digest) => {
      const scenario = {
        id,
        surface: f.surface,
        cwd: f.cwd ?? f.repo,
        sessionId: `qualification-${f.name}`,
        target: protectedTarget(f),
        sentinel: sentinel(f),
        digest,
      };
      expectations.guards.push(scenario);
      const before = capture(scenario.target, `${id}-before.bin`);
      const runtimeBefore = capture(expectations.pointer, `${id}-runtime-before.json`);
      const result = hook(f, 'pre_tool_use');
      const writeApplied = applyAdmittedWrite(result, forbiddenWrite(f));
      const after = capture(scenario.target, `${id}-after.bin`);
      const runtimeAfter = capture(expectations.pointer, `${id}-runtime-after.json`);
      custody.guards.push({
        id,
        writeApplied,
        before,
        after,
        runtimeBefore,
        runtimeAfter,
        receipt: result.qualificationReceipt,
      });
      saveCustody();
      return result;
    };
    const deferred = hook(fixtures[0], 'pre_tool_use');
    assert.equal(deferred.status, 0, deferred.stderr);
    assert.equal(deferred.stdout, '');
    // Control for every refusal below: this hook answer admits, and an
    // admitted write is really performed. The control file is outside the
    // fixture repositories so governance snapshots are unaffected.
    const control = {
      file_path: path.join(root, 'admitted-write-control.txt'),
      content: 'admitted fixture write',
    };
    assert.equal(applyAdmittedWrite(deferred, control), true);
    assert.equal(fs.readFileSync(control.file_path, 'utf8'), control.content);
    report.cases.push({ name: 'admitted-write-control', performed: true });
    for (const f of fixtures) {
      step(`migrate ${f.name}, retaining exact governance and reviewed custom behavior`);
      const before = snapshot(f.repo, (rel) => !rel.startsWith('.git'));
      const preview = JSON.parse(
        cli(f.repo, 'init', 'adapters', 'migrate', '--agent-surface', f.surface, '--plan', '--json')
      );
      assert.ok(preview.readOnly);
      assert.deepEqual(
        snapshot(f.repo, (rel) => !rel.startsWith('.git')),
        before
      );
      const policy = blank();
      if (f.custom) {
        policy.extensions.pre_tool_use = [
          { handler: 'qualification-custom.sh', before: 'cwd-guard.sh' },
        ];
        policy.handlers['qualification-custom.sh'] = '.caws/hooks/qualification-custom.sh';
      }
      const policyFile = path.join(root, `${f.name}-policy.json`);
      write(policyFile, JSON.stringify(policy));
      // --from encodes reviewed behavior; use it only for the custom case.
      const args = [
        'init',
        'adapters',
        'migrate',
        '--agent-surface',
        f.surface,
        ...(f.custom ? ['--from', policyFile] : []),
        '--json',
      ];
      const applied = JSON.parse(cli(f.repo, ...args));
      assert.equal(applied.results[0].ok, true);
      assert.equal(JSON.parse(cli(f.repo, ...args, '--plan')).results[0].changed, false);
      const rawAfter = captureGovernance(f.repo, evidenceRoot, `${f.name}-after`);
      f.rawRecord.after = rawAfter;
      write(
        path.join(evidenceRoot, `${f.name}-governance-raw.json`),
        JSON.stringify(f.rawRecord, null, 2) + '\n'
      );
      verifyGovernancePreserved(f.rawRecord.before, rawAfter, evidenceRoot);
      assert.deepEqual(governance(f.repo), f.before);
      if (artifacts)
        write(
          path.join(artifacts, `${f.name}-governance.json`),
          JSON.stringify({ before: f.before, after: governance(f.repo) }, null, 2) + '\n'
        );
      write(protectedTarget(f), sentinel(f));
      fs.chmodSync(protectedTarget(f), 0o640);
      const denial = guardedProof(f, `migrated-${f.name}`, installed.digest);
      assert.equal(
        denial.status,
        2,
        JSON.stringify({ fixture: f.name, stdout: denial.stdout, stderr: denial.stderr })
      );
      assert.match(denial.stderr + denial.stdout, /protected|scope|governed/i);
      if (f.custom) assert.match(denial.stderr, /qualification-custom-ran/);
      assert.deepEqual(governance(f.repo), f.before);
      report.cases.push({ name: f.name, migrated: true, denied: true, governancePreserved: true });
    }
    // A newly initialized project inherits system hooks without local copies.
    const fresh = path.join(root, 'fresh');
    fs.mkdirSync(fresh);
    git(fresh, 'init', '-q', '-b', 'main');
    git(fresh, 'commit', '--allow-empty', '-qm', 'fixture');
    cli(fresh, 'init', '--agent-surface', 'codex');
    assert.equal(fs.existsSync(path.join(fresh, '.caws/hooks')), false);
    assert.equal(fs.existsSync(path.join(fresh, '.codex/hooks.json')), false);
    report.cases.push({ name: 'fresh-global', noLocalHookCopies: true });
    // A linked checkout uses canonical policy and session output.
    const linked = path.join(root, 'linked');
    git(fixtures[0].repo, 'worktree', 'add', '-qb', 'linked', linked);
    const linkedDenial = guardedProof(
      { ...fixtures[0], cwd: linked },
      'linked-worktree',
      installed.digest
    );
    assert.equal(linkedDenial.status, 2, linkedDenial.stderr);
    report.cases.push({ name: 'linked-worktree', denied: true });

    step('exercise stock lifecycle and shared renderer from installed runtime');
    const prompt = 'Keep the migration evidence and this exact operator request.';
    const transcript = path.join(root, 'transcript.jsonl');
    const ts = '2026-09-07T12:00:00.000Z';
    const records = [
      {
        timestamp: ts,
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] },
      },
      {
        timestamp: ts,
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'q-call',
          arguments: JSON.stringify({ cmd: 'pwd' }),
        },
      },
      {
        timestamp: ts,
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'q-call',
          output: 'Process exited with code 0\nfixture-directory',
        },
      },
      {
        timestamp: ts,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Migration evidence retained.' }],
        },
      },
    ];
    write(transcript, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    for (const event of ['session_start', 'post_tool_use', 'pre_compact', 'stop']) {
      const result = hook(fixtures[0], event, {
        transcript_path: transcript,
        tool_name: 'Read',
        tool_input: { file_path: 'README.md' },
      });
      assert.equal(result.status, 0, `${event}: ${result.stderr}`);
    }
    const turn = json(
      path.join(
        fixtures[0].repo,
        '.caws/sessions',
        `qualification-${fixtures[0].name}`,
        'turn-001.json'
      )
    );
    if (artifacts) {
      write(path.join(artifacts, 'turn-001.json'), JSON.stringify(turn, null, 2) + '\n');
      write(path.join(artifacts, 'transcript.jsonl'), fs.readFileSync(transcript));
      write(
        path.join(artifacts, 'hook-events.jsonl'),
        fs.readFileSync(
          path.join(
            fixtures[0].repo,
            '.caws/sessions',
            `qualification-${fixtures[0].name}`,
            'hook-events.jsonl'
          )
        )
      );
    }
    assert.equal(turn.user, prompt);
    assert.match(JSON.stringify(turn.timeline), /q-call|fixture-directory|pwd/);
    report.cases.push({ name: 'lifecycle-renderer', userPreserved: true, toolPreserved: true });

    step('verify a single update reaches two migrated projects and rollback recovers');
    // Instrument disposable candidate templates, preserving stock behavior.
    // Never modify a live snapshot or the candidate being qualified.
    const templates = path.join(root, 'updated-templates');
    fs.cpSync(path.join(consumer, 'node_modules', packageName, 'templates/hook-packs'), templates, {
      recursive: true,
    });
    const guard = path.join(templates, 'shared/protected-paths.sh');
    write(
      guard,
      fs
        .readFileSync(guard, 'utf8')
        .replace('#!/bin/bash', '#!/bin/bash\necho qualification-updated-guard >&2')
    );
    const renderer = path.join(templates, 'shared/session_log_renderer.py');
    write(
      renderer,
      fs
        .readFileSync(renderer, 'utf8')
        .replace(
          '    raise SystemExit(main())',
          '    from pathlib import Path\n    import os\n    Path(os.environ["CAWS_QUALIFICATION_RENDER_MARKER"]).write_text("updated-renderer")\n    raise SystemExit(main())'
        )
    );
    const module = path.join(
      consumer,
      'node_modules',
      packageName,
      'dist/init/machine-adapters.js'
    );
    const update = JSON.parse(
      run(
        process.execPath,
        [
          '-e',
          'const m=require(process.argv[1]);process.stdout.write(JSON.stringify(m.installMachineRuntime({home:process.argv[2],templatesRoot:process.argv[3]})))',
          module,
          env.CAWS_HOME,
          templates,
        ],
        consumer,
        env
      )
    );
    assert.notEqual(update.digest, installed.digest);
    for (const f of fixtures.filter((f) => f.surface === 'codex')) {
      const marker = path.join(root, `${f.name}-render-marker`);
      const denial = guardedProof(f, `updated-${f.name}`, update.digest);
      assert.equal(denial.status, 2);
      assert.match(denial.stderr, /qualification-updated-guard/);
      // SessionStart renders too. Fresh absent output ties this observation to Stop.
      const sessionId = `qualification-update-${f.name}`;
      const turnFile = path.join(f.repo, '.caws/sessions', sessionId, 'turn-001.json');
      const updatedTranscript = path.join(root, `${f.name}-updated-transcript.jsonl`);
      const callId = `q-${f.name}`;
      const updatedPrompt = `${f.name}: ${prompt}`;
      const output = `Process exited with code 0\nfixture-directory-${f.name}`;
      const updatedRecords = JSON.parse(JSON.stringify(records));
      updatedRecords[0].payload.content[0].text = updatedPrompt;
      updatedRecords[1].payload.call_id = callId;
      updatedRecords[2].payload.call_id = callId;
      updatedRecords[2].payload.output = output;
      write(
        updatedTranscript,
        updatedRecords.map((record) => JSON.stringify(record)).join('\n') + '\n'
      );
      expectations.renderers.push({
        id: f.name,
        surface: f.surface,
        cwd: f.repo,
        sessionId,
        marker,
        turn: turnFile,
        transcript: updatedTranscript,
        prompt: updatedPrompt,
        callId,
        output,
        digest: update.digest,
      });
      const markerBefore = capture(marker, `${f.name}-marker-before.bin`);
      const turnBefore = capture(turnFile, `${f.name}-turn-before.json`);
      const runtimeBefore = capture(expectations.pointer, `${f.name}-stop-runtime-before.json`);
      const stop = hook(
        f,
        'stop',
        { session_id: sessionId, transcript_path: updatedTranscript },
        { CAWS_QUALIFICATION_RENDER_MARKER: marker }
      );
      custody.renderers.push({
        id: f.name,
        markerBefore,
        turnBefore,
        runtimeBefore,
        runtimeAfter: capture(expectations.pointer, `${f.name}-stop-runtime-after.json`),
        marker: capture(marker, `${f.name}-render-marker.bin`),
        turn: capture(turnFile, `${f.name}-updated-turn-001.json`),
        transcript: capture(updatedTranscript, `${f.name}-updated-transcript.jsonl`),
        receipt: stop.qualificationReceipt,
      });
      saveCustody();
      assert.equal(stop.status, 0, stop.stderr);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'updated-renderer');
      assert.deepEqual(governance(f.repo), f.before);
    }
    // Corrupt only the disposable active snapshot: refusal, then verified rollback.
    const activeFile = path.join(
      env.CAWS_HOME,
      'lib/runtimes',
      update.digest,
      'protected-paths.sh'
    );
    fs.appendFileSync(activeFile, '\n# corruption control\n');
    const corrupt = guardedProof(fixtures[0], 'corrupt-runtime', update.digest);
    assert.equal(corrupt.status, 2);
    assert.match(corrupt.stderr, /Runtime modified/);
    const rollback = JSON.parse(cli(consumer, 'init', 'adapters', 'rollback', '--json'));
    assert.equal(rollback.digest, installed.digest);
    const recovered = guardedProof(fixtures[0], 'rollback-recovered', installed.digest);
    assert.equal(recovered.status, 2);
    assert.doesNotMatch(recovered.stderr, /qualification-updated-guard|Runtime modified/);
    report.cases.push({
      name: 'update-corruption-rollback',
      twoProjectGuardAndRendererUpdate: true,
      recovered: true,
    });
    saveCustody();
    verifyQualificationCustody(evidenceRoot, expectations);
    for (const f of fixtures) {
      f.rawRecord.completed = captureGovernance(f.repo, evidenceRoot, `${f.name}-completed`);
      write(
        path.join(evidenceRoot, `${f.name}-governance-raw.json`),
        JSON.stringify(f.rawRecord, null, 2) + '\n'
      );
      verifyGovernancePreserved(f.rawRecord.before, f.rawRecord.completed, evidenceRoot);
    }
    report.custody = artifacts ? path.join(artifacts, 'custody.json') : null;
    report.persistentCustodyVerified = Boolean(artifacts);
    assert.equal(uncertainOutcomes.length, 0, 'Uncertain subprocess custody');
    report.ok = true;
    step(`PASS: ${report.cases.length} cases; candidate ${report.tarballSha256}`);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    report.ok = false;
    report.error = { name: failure.name, message: failure.message };
    const failedProjects = new Map(fixtures.map((f) => [f.name, f]));
    for (const name of [
      'codex-stock',
      'codex-custom',
      'claude-code-stock',
      'claude-code-custom',
      'fresh',
      'linked',
    ]) {
      const repo = path.join(root, name);
      if (failedProjects.has(name) || !fs.existsSync(repo)) continue;
      const rawRecord = { name, before: null, after: null, beforeCapture: 'not completed' };
      report.governance.push(rawRecord);
      failedProjects.set(name, { name, repo, rawRecord });
    }
    for (const f of failedProjects.values()) {
      try {
        f.rawRecord.failed = captureFailedGovernance(f.repo, evidenceRoot, `${f.name}-failed`);
        write(
          path.join(evidenceRoot, `${f.name}-governance-raw.json`),
          JSON.stringify(f.rawRecord, null, 2) + '\n'
        );
      } catch (captureError) {
        f.rawRecord.failureCaptureError = captureError.message;
      }
    }
    if (artifacts) {
      try {
        report.failureTraces = retainFixtureDiagnostics(root, artifacts);
      } catch (retentionError) {
        report.failureTraceError = retentionError.message;
      }
    }
  }
  retainQualificationFixture(root, report, uncertainOutcomes);
  if (failure) failure.qualificationReport = report;
  if (reportPath) {
    try {
      write(path.resolve(reportPath), JSON.stringify(report, null, 2) + '\n');
    } catch (persistenceError) {
      const error = new AggregateError(
        failure ? [failure, persistenceError] : [persistenceError],
        `Could not retain qualification report; fixture preserved at ${root}`,
        { cause: failure ?? persistenceError }
      );
      report.ok = false;
      report.reportPersistenceError = persistenceError.message;
      error.qualificationReport = report;
      throw error;
    }
  }
  if (failure) throw failure;
  return report;
}

export function parseQualificationOptions(argv) {
  const options = {};
  const flags = {
    '--package': 'candidate',
    '--baseline': 'baseline',
    '--report': 'reportPath',
    '--tarball': 'tarball',
    '--tarball-sha256': 'tarballSha256',
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i],
      value = argv[i + 1];
    const key = Object.hasOwn(flags, flag) ? flags[flag] : undefined;
    if (!key || !value || value.startsWith('--') || Object.hasOwn(options, key))
      throw new Error(
        'Usage: runtime-upgrade-smoke.mjs [--package source-package] [--baseline package-or-tarball] [--report path] [--tarball path --tarball-sha256 sha256]'
      );
    options[key] = value;
  }
  assert.equal(
    Object.hasOwn(options, 'tarball'),
    Object.hasOwn(options, 'tarballSha256'),
    'Selected tarball and expected SHA-256 must be supplied together'
  );
  if (Object.hasOwn(options, 'tarballSha256'))
    assert.match(options.tarballSha256, /^[a-f0-9]{64}$/, 'Expected SHA-256 pin');
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseQualificationOptions(process.argv.slice(2));
    const report = qualify(options);
    if (!options.reportPath)
      console.log(`[runtime-upgrade] Retained fixture: ${report.retainedFixture}`);
  } catch (error) {
    console.error(`[runtime-upgrade] FAIL: ${error.stack}`);
    if (error.qualificationReport?.retainedFixture)
      console.error(
        `[runtime-upgrade] Retained fixture: ${error.qualificationReport.retainedFixture}`
      );
    process.exitCode = 1;
  }
}
