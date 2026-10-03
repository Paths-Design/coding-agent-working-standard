const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeTempRepo, cleanupAll, git } = require('../helpers/git-repo-factory');
const { initProject, appendEvent, loadEvents, composeDoctorSnapshot } = require('../../dist/store');
const { inspectProjectState } = require('../../dist/kernel');
const { reconcileWorktreeCreation } = require('../../dist/store/worktree-reconciliation');
const CLI = path.resolve(__dirname, '../../dist/index.js');
const actor = { kind: 'agent', id: 'test', session_id: 'test', platform: 'test' };
afterAll(cleanupAll);
function setup() {
  const root = makeTempRepo();
  expect(initProject(root).ok).toBe(true);
  const cawsDir = path.join(root, '.caws');
  const creation = () =>
    appendEvent(cawsDir, {
      event: 'worktree_created',
      actor,
      ts: new Date().toISOString(),
      data: {
        name: 'gone',
        branch: 'gone',
        base_branch: 'main',
        path: path.join(cawsDir, 'worktrees/gone'),
      },
    });
  const created = creation();
  expect(created.ok).toBe(true);
  return { root, cawsDir, created: created.value, creation };
}
function findings(f) {
  return inspectProjectState(
    composeDoctorSnapshot({ repoRoot: f.root, cawsDir: f.cawsDir, now: new Date() }).doctorInput
  ).findings.filter((x) => x.rule === 'doctor.worktree.event_without_control_plane_binding');
}
function apply(f, created = f.created) {
  return reconcileWorktreeCreation(f.cawsDir, {
    name: 'gone',
    createdEventSeq: created.seq,
    createdEventHash: created.event_hash,
    actor,
  });
}
test('built CLI preview does not mutate; apply logs one exact receipt and discharges current diagnosis', () => {
  const f = setup();
  const bridges = path.join(f.cawsDir, 'claims/bridge.json');
  fs.mkdirSync(path.dirname(bridges), { recursive: true });
  const bridgeBytes = JSON.stringify({
    'RETIRED-01': { session_id: 'peer', acquired_at: '2026-01-01T00:00:00Z' },
  });
  fs.writeFileSync(bridges, bridgeBytes);
  const before = fs.readFileSync(path.join(f.cawsDir, 'events.jsonl'), 'utf8');
  const args = [
    'worktree',
    'prune',
    '--state',
    'verified-dead-creation',
    '--include',
    'gone',
    '--json',
  ];
  const preview = spawnSync(process.execPath, [CLI, ...args], { cwd: f.root, encoding: 'utf8' });
  expect(preview.status).toBe(0);
  expect(JSON.parse(preview.stdout).candidates[0].state_class).toBe('verified-dead-creation');
  expect(fs.readFileSync(path.join(f.cawsDir, 'events.jsonl'), 'utf8')).toBe(before);
  const applied = spawnSync(process.execPath, [CLI, ...args, '--apply'], {
    cwd: f.root,
    encoding: 'utf8',
  });
  expect(applied.status).toBe(0);
  expect(fs.readFileSync(bridges, 'utf8')).toBe(bridgeBytes);
  expect(JSON.parse(applied.stdout).outcomes[0].action).toBe('applied');
  const events = loadEvents(f.cawsDir);
  expect(events.ok).toBe(true);
  expect(events.value.events.at(-1).data).toMatchObject({
    h_class: 'verified_dead_creation',
    created_event_seq: f.created.seq,
    created_event_hash: f.created.event_hash,
  });
  expect(findings(f)).toEqual([]);
  const bytes = fs.readFileSync(path.join(f.cawsDir, 'events.jsonl'), 'utf8');
  expect(bytes.startsWith(before)).toBe(true);
  expect(apply(f).ok).toBe(false);
  expect(fs.readFileSync(path.join(f.cawsDir, 'events.jsonl'), 'utf8')).toBe(bytes);
});
test('recreated names and changed physical observations cannot reuse a prior receipt or preview', () => {
  const f = setup();
  expect(apply(f).ok).toBe(true);
  const second = f.creation();
  expect(second.ok).toBe(true);
  expect(findings(f)[0].data.created_event_seq).toBe(second.value.seq);
  expect(apply(f).ok).toBe(false);
  git(f.root, ['branch', 'gone']);
  const before = fs.readFileSync(path.join(f.cawsDir, 'events.jsonl'), 'utf8');
  expect(apply(f, second.value).ok).toBe(false);
  expect(fs.readFileSync(path.join(f.cawsDir, 'events.jsonl'), 'utf8')).toBe(before);
});
test('a retained directory or malformed authority prevents an absence receipt', () => {
  for (const problem of ['directory', 'registry', 'spec', 'missing-registry']) {
    const f = setup();
    if (problem === 'directory')
      fs.mkdirSync(path.join(f.cawsDir, 'worktrees/gone'), { recursive: true });
    if (problem === 'registry') fs.writeFileSync(path.join(f.cawsDir, 'worktrees.json'), '{');
    if (problem === 'missing-registry') fs.unlinkSync(path.join(f.cawsDir, 'worktrees.json'));
    if (problem === 'spec')
      fs.writeFileSync(path.join(f.cawsDir, 'specs/BROKEN-01.yaml'), 'invalid: [');
    const before = fs.readFileSync(path.join(f.cawsDir, 'events.jsonl'), 'utf8');
    expect(apply(f).ok).toBe(false);
    expect(fs.readFileSync(path.join(f.cawsDir, 'events.jsonl'), 'utf8')).toBe(before);
  }
});
