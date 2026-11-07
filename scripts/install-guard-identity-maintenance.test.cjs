'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const maintenance = require('./install-guard-identity-maintenance.cjs');
const state = process.env.CAWS_MAINTENANCE_STATE;
assert(state && path.isAbsolute(state), 'Set CAWS_MAINTENANCE_STATE to the prepared private candidate');
const build = JSON.parse(fs.readFileSync(path.join(state, 'build.json')));
const before = maintenance.snapshot(build.privateHome, maintenance.BASE);
const after = maintenance.snapshot(build.privateHome, build.digest);

test('the exact baseline and repaired generation differ only in scope guard', () => {
  assert.equal(Object.keys(before).length, 113);
  assert.deepEqual(maintenance.verifyDelta(before, after), ['scope-guard.sh']);
  assert.equal(before['lib/session-id.sh'], 'dac4866c1576b65732ab3eb5b350fd978b3b746c6bce02b484210a1ce3676c8c');
  for (const member of Object.keys(before)) {
    const mode = (digest) => fs.statSync(path.join(build.privateHome, 'lib/runtimes', digest, member)).mode & 0o777;
    assert.equal(mode(build.digest), mode(maintenance.BASE), 'Permissions changed: ' + member);
  }
});
test('unrelated changes, removed members and wrong repair bytes are rejected', () => {
  assert.throws(() => maintenance.verifyDelta(before, { ...after, 'block-dangerous.sh': 'changed' }), /Unrelated/);
  const missing = { ...after };
  delete missing['lib/session-id.sh'];
  assert.throws(() => maintenance.verifyDelta(before, missing), /Membership/);
  assert.throws(() => maintenance.verifyDelta(before, { ...after, 'scope-guard.sh': before['scope-guard.sh'] }), /repair/);
});
test('activation isolates its target, refuses mismatches and preserves normal rollback', () => {
  const fixture = fs.mkdtempSync(path.join(state, 'activation-'));
  const machine = path.join(fixture, 'target');
  const privateHome = path.join(fixture, 'machine');
  const templates = path.join(fixture, 'templates');
  fs.cpSync(build.privateHome, machine, { recursive: true });
  fs.cpSync(build.privateHome, privateHome, { recursive: true });
  fs.cpSync(build.templates, templates, { recursive: true });
  const api = maintenance.installer(build.apiPath);
  assert.equal(api.rollbackMachineRuntime({ home: machine }).digest, maintenance.BASE);
  fs.writeFileSync(path.join(fixture, 'build.json'), JSON.stringify({ ...build, machine, privateHome, templates }));
  const selected = maintenance.pointer(machine);
  assert.throws(() => maintenance.activate(fixture, '0'.repeat(64), machine), /candidate identity/);
  assert.throws(() => maintenance.activate(fixture, build.digest, path.join(fixture, 'wrong-machine')), /target machine/);
  assert.deepEqual(maintenance.pointer(machine), selected);
  const guard = path.join(templates, 'shared/scope-guard.sh');
  const original = fs.readFileSync(guard);
  fs.appendFileSync(guard, '\n# changed input\n');
  try {
    assert.throws(() => maintenance.activate(fixture, build.digest, machine), /inputs changed/);
    assert.deepEqual(maintenance.pointer(machine), selected);
  } finally { fs.writeFileSync(guard, original); }
  assert.equal(maintenance.activate(fixture, build.digest, machine).digest, build.digest);
  assert.deepEqual(maintenance.snapshot(machine, build.digest), after);
  assert.equal(api.rollbackMachineRuntime({ home: machine }).digest, maintenance.BASE);
  assert.deepEqual(maintenance.snapshot(machine, maintenance.BASE), before);
});

test('installed guard preserves scope, foreign containment and rollback on real linked repositories', () => {
  const root = fs.mkdtempSync(path.join(state, 'qualification-'));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  const managed = path.join(root, 'managed');
  const foreign = path.join(root, 'foreign/.caws/worktrees/other');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo);
  fs.mkdirSync(foreign, { recursive: true });
  const sid = crypto.randomUUID();
  const cli = fs.realpathSync(path.join(require('node:os').homedir(), '.local/bin/caws'));
  const env = {
    HOME: home, PATH: [path.dirname(process.execPath), path.dirname(path.join(require('node:os').homedir(), '.local/bin/caws')),
      '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    CAWS_HOME: build.privateHome, CAWS_AGENT_SURFACE: 'codex', CODEX_THREAD_ID: sid,
    PYTHONDONTWRITEBYTECODE: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  const commands = [];
  function run(executable, args, options = {}) {
    const result = spawnSync(executable, args, { cwd: repo, env, encoding: 'utf8', timeout: 30000,
      maxBuffer: 2 * 1024 * 1024, ...options });
    commands.push({ executable, args, cwd: options.cwd ?? repo, status: result.status,
      signal: result.signal, error: result.error?.message ?? null, stdout: result.stdout, stderr: result.stderr });
    fs.writeFileSync(path.join(root, 'commands.json'), JSON.stringify(commands, null, 2) + '\n');
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, 'Unexpected child signal');
    return result;
  }
  function succeeds(result) {
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  function git(...args) { succeeds(run('git', args)); }
  function caws(...args) { succeeds(run(process.execPath, [cli, ...args])); }
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'CAWS Guard Qualification');
  git('config', 'user.email', 'guard-qualification@caws.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('commit', '-q', '--allow-empty', '-m', 'fixture root');
  caws('init', '--agent-surface', 'codex');
  caws('specs', 'create', 'GUARD-FIXTURE-001', '--title', 'Guard identity fixture', '--mode', 'fix',
    '--scope-in', 'allowed.txt', '--scope-in', 'protected.txt');
  caws('specs', 'amend-scope', 'GUARD-FIXTURE-001', '--add-out', 'protected.txt');
  caws('worktree', 'create', 'owned', '--spec', 'GUARD-FIXTURE-001', '--base-branch', 'main', '--branch', 'caws/owned');
  git('worktree', 'add', '-q', '--detach', managed, 'HEAD');
  succeeds(run('git', ['init', '-q', '-b', 'main'], { cwd: foreign }));
  succeeds(run('git', ['-c', 'user.name=CAWS Guard Qualification', '-c',
    'user.email=guard-qualification@caws.invalid', '-c', 'commit.gpgsign=false',
    'commit', '-q', '--allow-empty', '-m', 'foreign fixture root'], { cwd: foreign }));
  const lane = path.join(repo, '.caws/worktrees/owned');
  const allowed = path.join(lane, 'allowed.txt');
  const protectedFile = path.join(lane, 'protected.txt');
  const foreignFile = path.join(foreign, 'protected.txt');
  for (const file of [allowed, protectedFile, foreignFile]) fs.writeFileSync(file, 'sentinel\n');
  const observations = [];
  function guard(digest, target, expectedStatus, expectedText, name = 'scope-guard.sh', caller = sid) {
    const original = fs.readFileSync(target);
    const payload = { tool_name: 'Write', session_id: caller, cwd: managed, tool_input: { file_path: target } };
    const result = run('/bin/bash', [path.join(build.privateHome, 'lib/runtimes', digest, name)], {
      cwd: managed, input: JSON.stringify(payload),
      env: { ...env, CODEX_THREAD_ID: caller, CAWS_PROJECT_DIR: managed, HOOK_CWD: managed,
        CAWS_MACHINE_POLICY_ROOT: repo },
    });
    if (result.status === 0) fs.writeFileSync(target, 'effect\n');
    const final = fs.readFileSync(target);
    observations.push({ name, digest, target, caller, payload, status: result.status,
      before: original.toString('base64'), after: final.toString('base64') });
    assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
    if (expectedText) assert.match(result.stdout + result.stderr, expectedText);
    if (expectedStatus !== 0) assert.deepEqual(final, original, 'Refused write changed bytes');
    else assert.equal(final.toString(), 'effect\n');
  }
  // Reproduce the reported defect using the exact previous generation.
  guard(maintenance.BASE, allowed, 2, /DIFFERENT repository/);
  guard(build.digest, allowed, 0);
  guard(build.digest, protectedFile, 2, /out-of-scope/);
  guard(build.digest, foreignFile, 2, /DIFFERENT repository/);
  guard(build.digest, allowed, 2, /owned|owner|another|different|foreign/i, 'worktree-write-guard.sh', crypto.randomUUID());
  const specs = path.join(repo, '.caws/specs');
  const saved = path.join(root, 'saved-specs');
  fs.renameSync(specs, saved);
  try { guard(build.digest, protectedFile, 2, /canonical governance/); }
  finally { fs.renameSync(saved, specs); }
  const bashPayload = { tool_name: 'Bash', session_id: sid, cwd: managed,
    tool_input: { command: 'pwd', execution_workdir: managed } };
  succeeds(run('/bin/bash', [path.join(build.privateHome, 'lib/runtimes', build.digest, 'bash-write-guard.sh')], {
    cwd: managed, input: JSON.stringify(bashPayload),
    env: { ...env, CAWS_PROJECT_DIR: managed, HOOK_CWD: managed, CAWS_MACHINE_POLICY_ROOT: repo },
  }));
  const api = maintenance.installer(build.apiPath);
  assert.equal(api.rollbackMachineRuntime({ home: build.privateHome }).digest, maintenance.BASE);
  assert.equal(maintenance.pointer(build.privateHome).digest, maintenance.BASE);
  assert.deepEqual(maintenance.snapshot(build.privateHome, maintenance.BASE), before);
  assert.equal(api.installMachineRuntime({ home: build.privateHome, templatesRoot: build.templates }).digest, build.digest);
  assert.deepEqual(maintenance.snapshot(build.privateHome, build.digest), after);
  fs.writeFileSync(path.join(root, 'observations.json'), JSON.stringify({
    schema: 'caws.guard-identity-qualification.v1', baseline: maintenance.BASE, candidate: build.digest,
    repairCommit: maintenance.REPAIR, observations, rollbackVerified: true,
    boundary: 'Real filesystem/CLI/guard fixtures; actual host activation is a separate required check',
  }, null, 2) + '\n');
  console.log('Retained qualification: ' + root);
});
