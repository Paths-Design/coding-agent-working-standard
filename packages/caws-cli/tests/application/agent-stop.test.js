'use strict';
// Real store and CLI transaction checks; no typed hook substitution is activated.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { heartbeatAgentActivity } = require('../../dist/application/agent-heartbeat');
const { stopAgentActivity } = require('../../dist/application/agent-stop');
const { runAgentsStopCommand } = require('../../dist/shell/commands/agents');
const { loadLeases, applyLeasePatch } = require('../../dist/store/leases-store');
const fixed = new Date('2026-10-24T12:00:00.000Z');
const artifactRoot = process.env.CAWS_TEST_ARTIFACT_DIR;
if (artifactRoot && !path.isAbsolute(artifactRoot))
  throw new Error('Artifact root must be absolute');
let root, project, before;
const leasePath = (id) => path.join(project, '.caws/leases', id + '.json');
function retain(label, value) {
  fs.writeFileSync(path.join(root, label + '.json'), JSON.stringify(value, null, 2) + '\n');
}
function seed(id) {
  const result = heartbeatAgentActivity({
    cawsDir: path.join(project, '.caws'),
    identity: { session_id: id, platform: 'opencode' },
    context: {
      repo_root: project,
      cwd: project,
      git_common_dir: path.join(project, '.git'),
      git_dir: path.join(project, '.git'),
      hook_pid: process.pid,
      hostname: 'private-fixture',
      branch: 'main',
    },
    now: () => fixed,
    reason: 'manual_register',
  });
  expect(result.ok).toBe(true);
}
function captureLease(id) {
  const file = leasePath(id);
  return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file) : null;
}
function unchanged() {
  expect(captureLease('own-session')).toEqual(before.self);
  expect(captureLease('peer-session')).toEqual(before.peer);
}
function assertStopped() {
  const prior = JSON.parse(before.self);
  const stopped = JSON.parse(fs.readFileSync(leasePath('own-session')));
  expect(stopped).toEqual({
    ...prior,
    status: 'stopped',
    stopped_at: expect.any(String),
    last_seen_reason: 'session_stop',
  });
  expect(Number.isFinite(Date.parse(stopped.stopped_at))).toBe(true);
  expect(captureLease('peer-session')).toEqual(before.peer);
}

beforeEach(() => {
  if (artifactRoot) fs.mkdirSync(artifactRoot, { recursive: true });
  root = fs.realpathSync(fs.mkdtempSync(path.join(artifactRoot || os.tmpdir(), 'shared-stop-')));
  project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, '.caws/specs'), { recursive: true });
  fs.mkdirSync(path.join(project, '.git'));
  fs.writeFileSync(path.join(project, '.caws/policy.yaml'), 'version: 1\n');
  fs.writeFileSync(path.join(project, '.caws/events.jsonl'), 'governance-sentinel\n');
  seed('own-session');
  seed('peer-session');
  before = { self: captureLease('own-session'), peer: captureLease('peer-session') };
});
afterEach(() => {
  expect(fs.readFileSync(path.join(project, '.caws/events.jsonl'), 'utf8')).toBe(
    'governance-sentinel\n'
  );
  retain('state', {
    test: expect.getState().currentTestName,
    before: { self: before.self.toString('base64'), peer: before.peer.toString('base64') },
    after: {
      self: captureLease('own-session')?.toString('base64') ?? null,
      peer: captureLease('peer-session')?.toString('base64') ?? null,
    },
  });
  if (!artifactRoot) fs.rmSync(root, { recursive: true, force: true });
});
function input(session_id = 'own-session') {
  return {
    cawsDir: path.join(project, '.caws'),
    identity: { session_id, platform: 'opencode' },
    now: () => fixed,
  };
}
test('shared operation stops exactly its own lease and absent identity creates no lease', () => {
  expect(stopAgentActivity(input())).toEqual({
    ok: true,
    value: { session_id: 'own-session', wrote: true, diagnostics: [] },
  });
  assertStopped();
  expect(JSON.parse(captureLease('own-session')).stopped_at).toBe(fixed.toISOString());
  expect(stopAgentActivity(input('missing'))).toEqual({
    ok: true,
    value: {
      session_id: 'missing',
      wrote: false,
      diagnostics: [
        {
          authority: 'kernel/diagnostics',
          rule: 'store.leases.stop_no_prior_lease',
          severity: 'warning',
          subject: leasePath('missing'),
          data: { session_id: 'missing' },
          message: 'mark_stopped: no existing lease for session "missing" — nothing to update.',
        },
      ],
    },
  });
  expect(fs.existsSync(leasePath('missing'))).toBe(false);
});
test('cancellation barrier executes after loading and prevents any store application', () => {
  const calls = [];
  const apply = jest.fn(applyLeasePatch);
  const interrupted = {
    ...input(),
    now: () => {
      calls.push('clock');
      return fixed;
    },
    beforeApply: () => {
      calls.push('barrier');
      throw new Error('cancelled original');
    },
  };
  expect(() =>
    stopAgentActivity(interrupted, {
      loadLeases: (dir) => {
        calls.push('load');
        return loadLeases(dir);
      },
      applyLeasePatch: apply,
    })
  ).toThrow('cancelled original');
  expect(calls).toEqual(['clock', 'load', 'barrier']);
  expect(apply).not.toHaveBeenCalled();
  unchanged();
});
test('kernel refusal occurs before barrier and store application', () => {
  const barrier = jest.fn();
  const apply = jest.fn(applyLeasePatch);
  const result = stopAgentActivity(
    { ...input(''), beforeApply: barrier },
    { loadLeases, applyLeasePatch: apply }
  );
  expect(result.ok).toBe(false);
  expect(result.stage).toBe('transition');
  expect(result.errors[0].rule).toBe('worktree.identity.session_id_empty');
  expect(barrier).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
  unchanged();
});
test('store diagnostics preserve the application failure stage without peer mutation', () => {
  const result = stopAgentActivity(input('unsafe/id'));
  expect(result.ok).toBe(false);
  expect(result.stage).toBe('apply');
  expect(result.errors[0].rule).toBe('store.leases.session_id_unsafe');
  unchanged();
});
test('no-flag CLI preserves kernel trimming and raw identity receipts', () => {
  childProcess.execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main'], {
    cwd: project,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
  const out = [],
    err = [];
  const options = {
    cwd: project,
    now: () => fixed,
    env: { CAWS_SESSION_ID: ' own-session ' },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  expect(runAgentsStopCommand(options)).toBe(0);
  expect(out).toEqual(['stopped  own-session ']);
  expect(err).toEqual([]);
  assertStopped();
  out.length = 0;
  expect(runAgentsStopCommand({ ...options, json: true })).toBe(0);
  expect(JSON.parse(out[0])).toEqual({
    ok: true,
    session_id: ' own-session ',
    wrote: true,
    diagnostics: [],
  });
  retain('cli-env-identity', {
    stdout: out,
    stderr: err,
    raw_session_id: options.env.CAWS_SESSION_ID,
  });
});

test('no-flag CLI preserves load error precedence before unsafe identity store refusal', () => {
  childProcess.execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main'], {
    cwd: project,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
  const leases = path.join(project, '.caws/leases');
  const saved = path.join(root, 'saved-leases');
  fs.renameSync(leases, saved);
  fs.writeFileSync(leases, 'not-a-directory');
  const out = [],
    err = [];
  const options = {
    cwd: project,
    now: () => fixed,
    env: { CAWS_SESSION_ID: 'unsafe/id' },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  try {
    expect(runAgentsStopCommand(options)).toBe(2);
    expect(out).toEqual([]);
    expect(err[0]).toBe('caws agents stop: lease directory unreadable.');
    expect(fs.readFileSync(path.join(saved, 'own-session.json'))).toEqual(before.self);
    expect(fs.readFileSync(path.join(saved, 'peer-session.json'))).toEqual(before.peer);
    retain('cli-load-precedence', { stdout: out, stderr: err, exit_code: 2 });
  } finally {
    fs.unlinkSync(leases);
    fs.renameSync(saved, leases);
  }
  err.length = 0;
  expect(runAgentsStopCommand(options)).toBe(1);
  expect(out).toEqual([]);
  expect(err[0]).toBe('caws agents stop: store write failed.');
  unchanged();
  retain('cli-store-precedence', { stdout: out, stderr: err, exit_code: 1 });
});

test('CLI human and JSON receipts share the transition without changing their contract', () => {
  childProcess.execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main'], {
    cwd: project,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
  const out = [],
    err = [];
  const options = {
    cwd: project,
    sessionId: 'own-session',
    platform: 'opencode',
    now: () => fixed,
    env: {},
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  expect(runAgentsStopCommand(options)).toBe(0);
  expect(out).toEqual(['stopped own-session']);
  expect(err).toEqual([]);
  assertStopped();
  out.length = 0;
  expect(runAgentsStopCommand({ ...options, json: true })).toBe(0);
  expect(JSON.parse(out[0])).toEqual({
    ok: true,
    session_id: 'own-session',
    wrote: true,
    diagnostics: [],
  });
  out.length = 0;
  expect(runAgentsStopCommand({ ...options, sessionId: 'missing-session' })).toBe(0);
  expect(out).toEqual(['no prior lease for missing-session (no-op)']);
  expect(fs.existsSync(leasePath('missing-session'))).toBe(false);
  fs.writeFileSync(leasePath('own-session'), 'broken lease\n');
  out.length = 0;
  expect(runAgentsStopCommand(options)).toBe(1);
  expect(out).toEqual([]);
  expect(err[0]).toBe('caws agents stop: store write failed.');
  expect(fs.readFileSync(leasePath('own-session'), 'utf8')).toBe('broken lease\n');
  expect(captureLease('peer-session')).toEqual(before.peer);
  retain('cli', { stdout: out, stderr: err });
});
