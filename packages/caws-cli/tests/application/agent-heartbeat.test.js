'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { heartbeatAgentActivity } = require('../../dist/application/agent-heartbeat');
const store = require('../../dist/store/leases-store');

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(sid = 'heartbeat-self') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-heartbeat-application-'));
  roots.push(root);
  const cawsDir = path.join(root, '.caws');
  fs.mkdirSync(cawsDir);
  return {
    cawsDir,
    identity: { session_id: sid, platform: 'codex' },
    context: {
      repo_root: root,
      cwd: root,
      git_common_dir: path.join(root, '.git'),
      git_dir: path.join(root, '.git'),
      branch: 'heartbeat-fixture',
      hook_pid: 47001,
      hostname: 'application-fixture',
    },
    now: () => new Date('2026-10-20T12:00:00.000Z'),
    includeActiveSummary: true,
    throttleMs: 15000,
  };
}
function lease(input) {
  return JSON.parse(
    fs.readFileSync(path.join(input.cawsDir, 'leases', input.identity.session_id + '.json'), 'utf8')
  );
}

test('real lease heartbeat preserves explicit hook provenance, fork metadata and active summary', () => {
  const input = { ...fixture(), sessionKind: 'fork', forkedFrom: 'parent-session' };
  const result = heartbeatAgentActivity(input);
  expect(result.ok).toBe(true);
  expect(result.value).toEqual({
    ok: true,
    session_id: 'heartbeat-self',
    lease_path: '.caws/leases/heartbeat-self.json',
    wrote: true,
    throttled: false,
    active_agent_count: 1,
    active_agents: [
      {
        session_id: 'heartbeat-self',
        bound_worktree: null,
        bound_spec_id: null,
        branch: 'heartbeat-fixture',
        git_dir_kind: 'canonical',
        last_active_age_ms: 0,
        is_self: true,
      },
    ],
  });
  expect(lease(input)).toMatchObject({
    hook_pid: 47001,
    harness_session_kind: 'fork',
    forked_from: 'parent-session',
    last_active: '2026-10-20T12:00:00.000Z',
    status: 'active',
  });
  expect(lease(input).pid).toBeUndefined();
});

test('throttle does not write new metadata; exact boundary writes while preserving fork and started_at', () => {
  const input = fixture();
  expect(heartbeatAgentActivity({ ...input, sessionKind: 'fork', forkedFrom: 'parent' }).ok).toBe(
    true
  );
  const before = lease(input);
  const within = heartbeatAgentActivity({
    ...input,
    context: { ...input.context, hook_pid: 47002 },
    now: () => new Date('2026-10-20T12:00:14.999Z'),
  });
  expect(within.ok).toBe(true);
  expect(within.value).toMatchObject({ wrote: false, throttled: true, active_agent_count: 1 });
  expect(within.value.active_agents[0].last_active_age_ms).toBe(14999);
  expect(lease(input)).toEqual(before);
  const boundary = heartbeatAgentActivity({
    ...input,
    context: { ...input.context, hook_pid: 47002 },
    now: () => new Date('2026-10-20T12:00:15.000Z'),
  });
  expect(boundary.ok).toBe(true);
  expect(boundary.value).toMatchObject({ wrote: true, throttled: false });
  expect(lease(input)).toMatchObject({
    hook_pid: 47002,
    harness_session_kind: 'fork',
    forked_from: 'parent',
    started_at: before.started_at,
    last_active: '2026-10-20T12:00:15.000Z',
  });
});

test('same session name is scoped by canonical directory and cannot borrow peers', () => {
  const first = fixture('shared-name');
  const second = fixture('shared-name');
  expect(heartbeatAgentActivity(first).ok).toBe(true);
  const result = heartbeatAgentActivity({
    ...second,
    context: { ...second.context, hook_pid: 47003 },
  });
  expect(result.ok).toBe(true);
  expect(result.value.active_agent_count).toBe(1);
  expect(lease(first).hook_pid).toBe(47001);
  expect(lease(second).hook_pid).toBe(47003);
  expect(lease(first).repo_root).not.toBe(lease(second).repo_root);
});

test.each([
  [{ sessionKind: 'foreign' }, 'invalid-session-kind'],
  [{ sessionKind: 'main', forkedFrom: 'parent' }, 'forked-from-without-fork'],
])('invalid fork options are rejected before clock or storage access: %j', (options, reason) => {
  const input = fixture();
  const now = jest.fn(input.now);
  const loadLeases = jest.fn(store.loadLeases);
  const applyLeasePatch = jest.fn(store.applyLeasePatch);
  expect(
    heartbeatAgentActivity({ ...input, ...options, now }, { loadLeases, applyLeasePatch })
  ).toEqual({ ok: false, stage: 'fork-context', reason });
  expect(now).not.toHaveBeenCalled();
  expect(loadLeases).not.toHaveBeenCalled();
  expect(applyLeasePatch).not.toHaveBeenCalled();
});

test('unsafe identity is rejected without creating a lease or entering the store', () => {
  const input = fixture();
  const loadLeases = jest.fn(store.loadLeases);
  const result = heartbeatAgentActivity(
    { ...input, identity: { ...input.identity, session_id: '../foreign' } },
    {
      loadLeases,
      applyLeasePatch: store.applyLeasePatch,
    }
  );
  expect(result.ok).toBe(false);
  expect(result.stage).toBe('identity');
  expect(result.errors[0].rule).toBe('store.leases.session_id_unsafe');
  expect(loadLeases).not.toHaveBeenCalled();
  expect(fs.readdirSync(input.cawsDir)).toEqual([]);
});

test('primary load and apply failures retain stage and diagnostics; invalid context is a transition refusal', () => {
  const input = fixture();
  const errors = [{ rule: 'fixture.read-denied', severity: 'error', message: 'retained failure' }];
  expect(
    heartbeatAgentActivity(input, {
      loadLeases: () => ({ ok: false, errors }),
      applyLeasePatch: store.applyLeasePatch,
    })
  ).toEqual({ ok: false, stage: 'load', errors });
  expect(
    heartbeatAgentActivity(input, {
      loadLeases: store.loadLeases,
      applyLeasePatch: () => ({ ok: false, errors }),
    })
  ).toEqual({ ok: false, stage: 'apply', errors });
  const invalid = heartbeatAgentActivity({ ...input, context: { ...input.context, hook_pid: -1 } });
  expect(invalid.ok).toBe(false);
  expect(invalid.stage).toBe('transition');
  expect(invalid.errors[0].rule).toBe('kernel.lease.context_invalid');
  expect(fs.existsSync(path.join(input.cawsDir, 'leases', 'heartbeat-self.json'))).toBe(false);
});

test('failed summary reload preserves successful write and prewrite summary fallback', () => {
  const input = fixture();
  let loads = 0;
  const result = heartbeatAgentActivity(input, {
    loadLeases: (dir) =>
      ++loads === 1
        ? store.loadLeases(dir)
        : {
            ok: false,
            errors: [{ rule: 'fixture.reload', severity: 'error', message: 'reload refused' }],
          },
    applyLeasePatch: store.applyLeasePatch,
  });
  expect(result.ok).toBe(true);
  expect(result.value).toMatchObject({ wrote: true, active_agent_count: 0, active_agents: [] });
  expect(lease(input)).toMatchObject({ hook_pid: 47001, status: 'active' });
});
