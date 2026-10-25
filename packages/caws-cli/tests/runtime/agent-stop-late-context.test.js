'use strict';
const { AbortController } = globalThis;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { executeAgentStop } = require('../../dist/runtime/agent-stop');
const { stopAgentActivity } = require('../../dist/application/agent-stop');
const { heartbeatAgentActivity } = require('../../dist/application/agent-heartbeat');
const { loadLeases, applyLeasePatch } = require('../../dist/store/leases-store');
let root, project, context, controller, before;
const fixed = new Date('2026-10-24T12:00:00Z');
const file = () => path.join(project, '.caws/leases/self.json');
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'late-agent-stop-')));
  project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, '.caws'), { recursive: true });
  controller = new AbortController();
  const seeded = heartbeatAgentActivity({
    cawsDir: path.join(project, '.caws'),
    identity: { session_id: 'self', platform: 'opencode' },
    now: () => fixed,
    reason: 'manual_register',
    context: {
      repo_root: project,
      cwd: project,
      git_common_dir: path.join(project, '.git'),
      git_dir: path.join(project, '.git'),
      hook_pid: process.pid,
      hostname: 'fixture',
    },
  });
  expect(seeded.ok).toBe(true);
  before = fs.readFileSync(file());
  context = {
    request: { payload: { session_id: 'self' }, deadlineEpochMs: fixed.getTime() + 30000 },
    selection: { canonical: project },
    signal: controller.signal,
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
test('settled failed late Git performs no lease load/application and leaves bytes unchanged', async () => {
  const stop = jest.fn(stopAgentActivity),
    selection = jest.fn();
  const result = await executeAgentStop(
    context,
    { observe: async () => ({ status: 'git_failed', commonDir: null }) },
    selection,
    { stop, now: () => fixed }
  );
  expect(result.exitCode).toBe(0);
  expect(Buffer.from(result.stderr).length).toBe(0);
  expect(stop).not.toHaveBeenCalled();
  expect(fs.readFileSync(file())).toEqual(before);
});
test.each(['cancelled', 'identity changed', 'cleanup unproven'])(
  'late %s fails before lease access; no shell replay',
  async (reason) => {
    const stop = jest.fn(stopAgentActivity);
    await expect(
      executeAgentStop(
        context,
        {
          observe: async () => {
            throw Error(reason);
          },
        },
        () => {},
        { stop, now: () => fixed }
      )
    ).rejects.toThrow(reason);
    expect(stop).not.toHaveBeenCalled();
    expect(fs.readFileSync(file())).toEqual(before);
  }
);
test('fresh common-dir must map through shared repo mapping to the admitted root', async () => {
  const stop = jest.fn(stopAgentActivity);
  await expect(
    executeAgentStop(
      context,
      { observe: async () => ({ status: 'resolved', commonDir: '/neighbor/.git' }) },
      () => {},
      { stop, now: () => fixed }
    )
  ).rejects.toThrow('differs');
  expect(stop).not.toHaveBeenCalled();
  expect(fs.readFileSync(file())).toEqual(before);
});
test('original abort and source checks run immediately before real store application', async () => {
  const apply = jest.fn(applyLeasePatch);
  let checks = 0;
  const stop = (input) => stopAgentActivity(input, { loadLeases, applyLeasePatch: apply });
  await expect(
    executeAgentStop(
      context,
      { observe: async () => ({ status: 'resolved', commonDir: path.join(project, '.git') }) },
      () => {
        if (++checks === 3) throw Error('selection invalidated before apply');
      },
      { stop, now: () => fixed }
    )
  ).rejects.toThrow('selection invalidated');
  expect(checks).toBe(3);
  expect(apply).not.toHaveBeenCalled();
  expect(fs.readFileSync(file())).toEqual(before);
});
test('resolved late query reaches shared real lease transaction', async () => {
  await executeAgentStop(
    context,
    { observe: async () => ({ status: 'resolved', commonDir: path.join(project, '.git') }) },
    () => {},
    { stop: stopAgentActivity, now: () => fixed }
  );
  const stopped = JSON.parse(fs.readFileSync(file()));
  expect(stopped.status).toBe('stopped');
  expect(stopped.last_seen_reason).toBe('session_stop');
  expect(stopped.stopped_at).toBe(fixed.toISOString());
});
test.each(['abort', 'deadline'])(
  'original %s observed after lease load prevents real apply',
  async (kind) => {
    const apply = jest.fn(applyLeasePatch);
    let expired = false;
    const stop = (input) =>
      stopAgentActivity(input, {
        loadLeases: (directory) => {
          const loaded = loadLeases(directory);
          if (kind === 'abort') controller.abort(Error('original cancelled after load'));
          else expired = true;
          return loaded;
        },
        applyLeasePatch: apply,
      });
    await expect(
      executeAgentStop(
        context,
        { observe: async () => ({ status: 'resolved', commonDir: path.join(project, '.git') }) },
        () => {},
        {
          stop,
          now: () => (expired ? new Date(context.request.deadlineEpochMs) : fixed),
        }
      )
    ).rejects.toThrow(kind === 'abort' ? 'original cancelled' : 'deadline expired');
    expect(apply).not.toHaveBeenCalled();
    expect(fs.readFileSync(file())).toEqual(before);
  }
);
