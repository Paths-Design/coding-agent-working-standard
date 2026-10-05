'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { setup, describeSelection, POLICY, cleanup } = require('./hook-reconciliation-fixture');
const { digest, planHookReconciliation } = require('../../dist/init/hook-reconciliation');
const runtime = require('../../dist/init/machine-adapters');
const {
  applyHookReconciliation,
  recoverHookReconciliation,
} = require('../../dist/init/hook-import-transaction');
const describe = describeSelection;
afterEach(() => jest.restoreAllMocks());
afterAll(cleanup);
test('selective apply clears only the selected group and preserves real launcher selection on every surface', () => {
  const { root, home, file } = setup();
  const before = ['codex', 'claude-code'].map((s) => describe(root, home, s));
  const p = planHookReconciliation(root, home, ['codex:handler:marker.sh']);
  const journal = applyHookReconciliation(p, root, home);
  const machine = JSON.parse(fs.readFileSync(file, 'utf8'));
  const repo = JSON.parse(fs.readFileSync(path.join(root, POLICY), 'utf8'));
  expect(repo.surfaces.default).toBeUndefined();
  expect(Object.keys(repo.surfaces)).toEqual(['codex']);
  expect(machine.surfaces.codex.handlers).toEqual({
    'block-dangerous.sh': '.caws/hooks/ext/block-dangerous.sh',
    'other.sh': '.caws/hooks/ext/other.sh',
  });
  expect(machine.surfaces.codex.extensions.pre_tool_use).toEqual([
    { handler: 'other.sh', before: 'scope-guard.sh' },
  ]);
  expect(machine.surfaces.codex.libraries).toEqual({ 'helper.py': '.caws/hooks/ext/helper.py' });
  expect(machine.surfaces['claude-code']).toEqual(
    JSON.parse(p.machine_before).surfaces['claude-code']
  );
  const after = ['codex', 'claude-code'].map((s) => describe(root, home, s));
  const selection = (d) =>
    d.handlers.map(({ entry, path, kind, sha256 }) => ({ entry, path, kind, sha256 }));
  expect(after.map(selection)).toEqual(before.map(selection));
  expect(after.map((d) => d.library_resolution)).toEqual(before.map((d) => d.library_resolution));
  expect(after[0].library_resolution['helper.py'].path).toBe(
    path.join(root, '.caws/hooks/ext/helper.py')
  );
  expect(JSON.parse(fs.readFileSync(journal, 'utf8')).state).toBe('complete');
  expect(recoverHookReconciliation(journal, root, home)).toBe(journal);
  expect(fs.readFileSync(file, 'utf8')).toBe(p.machine_after);
});

test.each(['handler', 'helper', 'new-helper', 'machine', 'native', 'runtime'])(
  'changed %s input makes a reviewed plan stale without policy writes',
  (changed) => {
    const { root, home, file } = setup();
    const p = planHookReconciliation(root, home, ['codex:handler:marker.sh']);
    if (changed === 'handler')
      fs.appendFileSync(path.join(root, '.caws/hooks/ext/marker.sh'), '# changed\n');
    if (changed === 'helper')
      fs.appendFileSync(path.join(root, '.caws/hooks/ext/helper.py'), '# changed\n');
    if (changed === 'new-helper')
      fs.writeFileSync(path.join(root, '.caws/hooks/ext/new.py'), 'NEW = 1\n');
    if (changed === 'machine') fs.appendFileSync(file, '\n');
    if (changed === 'native') {
      fs.mkdirSync(path.join(root, '.codex'));
      fs.writeFileSync(path.join(root, '.codex/hooks.json'), '{}');
    }
    if (changed === 'runtime')
      fs.appendFileSync(path.join(home, 'state/adapter-runtime.json'), '\n');
    const before = fs.readFileSync(file, 'utf8');
    expect(() => applyHookReconciliation(p, root, home)).toThrow('stale');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(root, POLICY))).toBe(false);
    expect(fs.existsSync(path.join(home, 'state/hooks-imports'))).toBe(false);
  }
);

test('an ordering change is reported as a blocker rather than certified equivalent', () => {
  const { root, home, file } = setup();
  const machine = JSON.parse(fs.readFileSync(file, 'utf8'));
  machine.surfaces.codex.extensions.pre_tool_use[1].before = 'marker.sh';
  fs.writeFileSync(file, JSON.stringify(machine));
  const p = planHookReconciliation(root, home, ['codex:handler:other.sh']);
  expect(p.blockers).toContain('Resolved chain differs or refuses at codex/pre_tool_use');
  expect(() => applyHookReconciliation(p, root, home)).toThrow('not applicable');
  expect(fs.existsSync(path.join(root, POLICY))).toBe(false);
});

test('a multi-group selection preserves source event order independently of sorted group IDs', () => {
  const { root, home, file } = setup();
  const machine = JSON.parse(fs.readFileSync(file, 'utf8'));
  machine.surfaces.codex.extensions.pre_tool_use.reverse();
  fs.writeFileSync(file, JSON.stringify(machine));
  const before = describe(root, home, 'codex');
  const p = planHookReconciliation(root, home, [
    'codex:handler:other.sh',
    'codex:handler:marker.sh',
  ]);
  expect(p.selected).toEqual(['codex:handler:marker.sh', 'codex:handler:other.sh']);
  expect(p.blockers).toEqual([]);
  applyHookReconciliation(p, root, home);
  const repo = JSON.parse(fs.readFileSync(path.join(root, POLICY), 'utf8'));
  expect(repo.surfaces.codex.extensions.pre_tool_use.map((e) => e.handler)).toEqual([
    'other.sh',
    'marker.sh',
  ]);
  expect(describe(root, home, 'codex').handlers.map((h) => h.path)).toEqual(
    before.handlers.map((h) => h.path)
  );
});

test('machine-write failure retains a journal, recovery finishes exact keys, and concurrent edits refuse', () => {
  const { root, home, file } = setup();
  const p = planHookReconciliation(root, home, ['codex:handler:marker.sh']);
  const original = runtime.atomicMachineWrite;
  jest.spyOn(runtime, 'atomicMachineWrite').mockImplementation((h, target, body) => {
    if (target === file) throw new Error('fixture machine write failure');
    return original(h, target, body);
  });
  expect(() => applyHookReconciliation(p, root, home)).toThrow('recovery journal');
  expect(fs.readFileSync(path.join(root, POLICY), 'utf8')).toBe(p.repo_after);
  expect(fs.readFileSync(file, 'utf8')).toBe(p.machine_before);
  jest.restoreAllMocks();
  const journal = path.join(home, 'state/hooks-imports', digest(root) + '-' + p.plan_id + '.json');
  expect(JSON.parse(fs.readFileSync(journal, 'utf8')).state).toBe('repo_written');
  fs.appendFileSync(file, '\n');
  expect(() => recoverHookReconciliation(journal, root, home)).toThrow('Concurrent edits');
  fs.writeFileSync(file, p.machine_before);
  expect(recoverHookReconciliation(journal, root, home)).toBe(journal);
  expect(fs.readFileSync(file, 'utf8')).toBe(p.machine_after);
});

test('a live import owner cannot be taken over by recovery', () => {
  const { root, home } = setup();
  const p = planHookReconciliation(root, home, ['codex:handler:marker.sh']);
  const journal = applyHookReconciliation(p, root, home);
  const lock = path.join(home, 'state/hooks-imports', digest(root) + '.lock');
  fs.writeFileSync(lock, JSON.stringify({ plan_id: p.plan_id, pid: process.pid }));
  expect(() => recoverHookReconciliation(journal, root, home)).toThrow('still alive');
  expect(JSON.parse(fs.readFileSync(lock, 'utf8')).pid).toBe(process.pid);
});

test('repository-write failure leaves a prepared journal and recovery can finish it', () => {
  const { root, home, file } = setup();
  const p = planHookReconciliation(root, home, ['codex:handler:marker.sh']);
  const original = fs.renameSync;
  jest.spyOn(fs, 'renameSync').mockImplementation((from, into) => {
    if (into === path.join(root, POLICY)) throw new Error('fixture repository write failure');
    return original(from, into);
  });
  expect(() => applyHookReconciliation(p, root, home)).toThrow('repository write failure');
  jest.restoreAllMocks();
  const journal = path.join(home, 'state/hooks-imports', digest(root) + '-' + p.plan_id + '.json');
  expect(JSON.parse(fs.readFileSync(journal, 'utf8')).state).toBe('prepared');
  expect(fs.existsSync(path.join(root, POLICY))).toBe(false);
  expect(fs.readFileSync(file, 'utf8')).toBe(p.machine_before);
  expect(recoverHookReconciliation(journal, root, home)).toBe(journal);
  expect(fs.readFileSync(path.join(root, POLICY), 'utf8')).toBe(p.repo_after);
  expect(fs.readFileSync(file, 'utf8')).toBe(p.machine_after);
});

test('failure to prepare a journal writes neither policy and does not advertise a recovery file', () => {
  const { root, home, file } = setup();
  const p = planHookReconciliation(root, home, ['codex:handler:marker.sh']);
  jest.spyOn(runtime, 'atomicMachineWrite').mockImplementation(() => {
    throw new Error('fixture journal write failure');
  });
  expect(() => applyHookReconciliation(p, root, home)).toThrow('no recovery journal was created');
  expect(fs.readFileSync(file, 'utf8')).toBe(p.machine_before);
  expect(fs.existsSync(path.join(root, POLICY))).toBe(false);
  expect(fs.readdirSync(path.join(home, 'state/hooks-imports'))).toEqual([]);
});

test('recovery reclaims only its own dead process locks', () => {
  const { root, home } = setup();
  const p = planHookReconciliation(root, home, ['codex:handler:marker.sh']);
  const journal = applyHookReconciliation(p, root, home);
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  expect(exited.status).toBe(0);
  const owner = JSON.stringify({ plan_id: p.plan_id, pid: exited.pid });
  fs.writeFileSync(path.join(home, 'state/hooks-imports', digest(root) + '.lock'), owner);
  for (const name of ['adapter-install.lock', 'system-configuration.lock']) {
    const dir = path.join(home, 'state', name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'hooks-import-owner.json'), owner);
  }
  expect(recoverHookReconciliation(journal, root, home)).toBe(journal);
  expect(fs.existsSync(path.join(home, 'state/adapter-install.lock'))).toBe(false);
  expect(fs.existsSync(path.join(home, 'state/system-configuration.lock'))).toBe(false);
});

test.each(['adapter-install.lock', 'system-configuration.lock'])(
  'a held %s refuses application without overwriting its owner',
  (name) => {
    const { root, home, file } = setup();
    const p = planHookReconciliation(root, home, ['codex:handler:marker.sh']);
    const lock = path.join(home, 'state', name);
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'foreign-owner'), 'keep');
    expect(() => applyHookReconciliation(p, root, home)).toThrow('EEXIST');
    expect(fs.readFileSync(path.join(lock, 'foreign-owner'), 'utf8')).toBe('keep');
    expect(fs.readFileSync(file, 'utf8')).toBe(p.machine_before);
    expect(fs.existsSync(path.join(root, POLICY))).toBe(false);
    expect(fs.existsSync(path.join(home, 'state/hooks-imports', digest(root) + '.lock'))).toBe(
      false
    );
  }
);

test.each(['changed', 'added'])(
  'recovery refuses a %s dependency even after repository policy has been written',
  (change) => {
    const { root, home, file } = setup();
    const p = planHookReconciliation(root, home, ['codex:handler:marker.sh']);
    const journal = applyHookReconciliation(p, root, home);
    fs.writeFileSync(file, p.machine_before);
    if (change === 'changed')
      fs.appendFileSync(path.join(root, '.caws/hooks/ext/helper.py'), '# change\n');
    else fs.writeFileSync(path.join(root, '.caws/hooks/ext/added.py'), 'NEW = 1\n');
    expect(() => recoverHookReconciliation(journal, root, home)).toThrow(
      'Recovery dependency inventory'
    );
    expect(fs.readFileSync(file, 'utf8')).toBe(p.machine_before);
    expect(fs.readFileSync(path.join(root, POLICY), 'utf8')).toBe(p.repo_after);
  }
);

test('recovery rejects a journal whose machine candidate was edited even when its checksum was recomputed', () => {
  const { root, home, file } = setup();
  const p = planHookReconciliation(root, home, ['codex:handler:marker.sh']);
  const journal = applyHookReconciliation(p, root, home);
  const j = JSON.parse(fs.readFileSync(journal, 'utf8'));
  j.plan.machine_after = j.plan.machine_before;
  const body = { ...j.plan };
  delete body.plan_id;
  j.plan.plan_id = digest(JSON.stringify(body));
  const altered = path.join(
    home,
    'state/hooks-imports',
    digest(root) + '-' + j.plan.plan_id + '.json'
  );
  fs.writeFileSync(altered, JSON.stringify(j));
  expect(() => recoverHookReconciliation(altered, root, home)).toThrow('candidate changed');
  expect(fs.readFileSync(file, 'utf8')).toBe(p.machine_after);
});
