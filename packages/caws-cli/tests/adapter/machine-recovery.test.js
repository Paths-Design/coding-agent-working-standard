'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installMachineRuntime, verifyRuntime } = require('../../dist/init/machine-adapters');
test('machine recovery targets canonical project state and never writes into its snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-machine-recovery-'));
  try {
    const home = path.join(root, 'machine');
    const repo = path.join(root, 'project');
    fs.mkdirSync(repo);
    expect(spawnSync('git', ['init', '-q'], { cwd: repo }).status).toBe(0);
    const installed = installMachineRuntime({ home });
    const runtime = path.join(home, 'lib/runtimes', installed.digest);
    const latch = path.join(repo, '.claude/hooks/state/danger-latch-fixture.json');
    fs.mkdirSync(path.dirname(latch), { recursive: true });
    fs.writeFileSync(latch, JSON.stringify({ reason: 'fixture control' }));
    const invoke = (project) => spawnSync('bash', [path.join(runtime, 'reset-danger-latch.sh'), '--session', 'fixture', '--reason', 'fixture recovery'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, CAWS_HOME: home, CAWS_MACHINE_RUNTIME: '1', CAWS_PROJECT_DIR: project, CAWS_AGENT_SURFACE: 'claude-code' },
    });
    const missing = invoke('.');
    expect(missing.status).toBe(2);
    expect(fs.existsSync(latch)).toBe(true);
    const result = invoke(repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Reset 1 danger latch(es)');
    expect(fs.existsSync(latch)).toBe(false);
    const audit = fs.readFileSync(path.join(repo, '.claude/logs/danger-latch-resets.log'), 'utf8').trim();
    expect(JSON.parse(audit).reason).toBe('fixture recovery');
    expect(fs.existsSync(path.join(home, 'lib/.claude'))).toBe(false);
    expect(verifyRuntime(home, installed.digest)['reset-danger-latch.sh']).toMatch(/^[a-f0-9]{64}$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test.each([
  { machine: true, linked: false },
  { machine: true, linked: true },
  { machine: false, linked: false },
  { machine: false, linked: true },
])('the emitted recovery command preserves project and session boundaries: %j', ({ machine, linked }) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "caws recovery ' ")));
  const repo = path.join(root, 'project');
  const home = path.join(root, 'machine');
  // Preserve the real HOME value, but do not inherit agent identity, Git
  // overrides, or machine runtime context into the human recovery process.
  const human = { PATH: process.env.PATH, HOME: process.env.HOME, CAWS_HOME: home };
  const session = 'fixture-owner';
  const latchIn = (project, id) => path.join(project, '.claude/hooks/state', `danger-latch-${id}.json`);
  function plant(project, id) {
    const file = latchIn(project, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ reason: 'independent control' }));
    return file;
  }
  function git(args) {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo, env: human, encoding: 'utf8',
    });
    expect({ status: result.status, stderr: result.status === 0 ? '' : result.stderr }).toEqual({ status: 0, stderr: '' });
  }
  try {
    fs.mkdirSync(repo);
    git(['init', '-q', '-b', 'main']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture']);
    let cwd = repo;
    if (linked) {
      cwd = path.join(root, 'linked worktree');
      git(['worktree', 'add', '-q', '-b', 'fixture-lane', cwd]);
    }
    const installed = installMachineRuntime({ home });
    const snapshot = path.join(home, 'lib/runtimes', installed.digest);
    const before = verifyRuntime(home, installed.digest);
    const hooks = machine ? snapshot : path.join(cwd, '.caws/hooks');
    if (!machine) fs.cpSync(snapshot, hooks, { recursive: true });
    const siblingLatch = plant(repo, 'fixture-peer');
    // A previous installation may have left the same session's state at the
    // canonical root. Recovery must reach both homes without moving state or
    // causing the guard to overlook an already armed worktree latch.
    if (linked) plant(repo, session);
    const unrelated = path.join(root, 'unrelated project');
    const unrelatedLatch = plant(unrelated, session);
    const guard = spawnSync('/bin/bash', [path.join(hooks, 'block-dangerous.sh')], {
      cwd,
      encoding: 'utf8',
      env: {
        ...human,
        CAWS_AGENT_SURFACE: 'claude-code',
        CAWS_PROJECT_DIR: cwd,
        CAWS_HOOKS_DIR: hooks,
        ...(machine ? {
          CAWS_MACHINE_RUNTIME: '1',
          CAWS_MACHINE_POLICY_ROOT: repo,
          CAWS_SHARED_LIB_DIR: path.join(snapshot, 'lib'),
          CAWS_MACHINE_ADAPTER_LIB_DIR: path.join(snapshot, 'surfaces/claude-code/lib'),
        } : {}),
      },
      // Classification only: this string is input to the real guard, never
      // executed as a Git command by the fixture.
      input: JSON.stringify({ tool_name: 'Bash', session_id: session, tool_input: { command: 'git reset --hard' } }),
    });
    expect(guard.status).toBe(0);
    const envelope = JSON.parse(guard.stdout);
    expect(envelope.decision).toBe('block');
    const reason = envelope.reason;
    const prefix = 'Ask the USER to run: ';
    const suffix = ', then ask for the next step.';
    expect(reason).toContain(prefix);
    expect(reason).toContain(suffix);
    const command = reason.slice(reason.indexOf(prefix) + prefix.length, reason.indexOf(suffix));
    expect(fs.existsSync(latchIn(cwd, session))).toBe(true);
    const reset = spawnSync('/bin/bash', ['-c', command], { cwd: unrelated, env: human, encoding: 'utf8' });
    expect({ status: reset.status, stderr: reset.stderr }).toEqual({ status: 0, stderr: '' });
    expect(reset.stdout).toContain(`Reset ${linked ? 2 : 1} danger latch(es)`);
    expect(fs.existsSync(latchIn(cwd, session))).toBe(false);
    expect(fs.existsSync(latchIn(repo, session))).toBe(false);
    expect(JSON.parse(fs.readFileSync(siblingLatch, 'utf8')).reason).toBe('independent control');
    expect(JSON.parse(fs.readFileSync(unrelatedLatch, 'utf8')).reason).toBe('independent control');
    expect(verifyRuntime(home, installed.digest)).toEqual(before);
    expect(fs.existsSync(path.join(home, 'lib/.claude'))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
