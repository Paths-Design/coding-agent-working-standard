'use strict';
const fs = require('fs');
const path = require('path');
const { setup, POLICY, cleanup } = require('./hook-reconciliation-fixture');
const { digest, planHookReconciliation } = require('../../dist/init/hook-reconciliation');
const { makeTempRepo } = require('../helpers/git-repo-factory');
const { installHookPack, pristinePathFor } = require('../../dist/init/hook-install');
const { SHARED_PACK } = require('../../dist/init/hook-packs/manifest-shared');
afterAll(cleanup);
test('preview inventories every group and keeps floor, helper and ambiguous baseline dispositions explicit without writes', () => {
  const { root, home, file } = setup();
  const before = fs.readFileSync(file, 'utf8');
  const baseline = pristinePathFor(root, 'shared', '.caws/hooks/block-dangerous.sh');
  fs.mkdirSync(path.dirname(baseline), { recursive: true });
  fs.copyFileSync(path.join(root, '.caws/hooks/ext/block-dangerous.sh'), baseline);
  const p = planHookReconciliation(root, home, ['codex:handler:marker.sh']);
  expect(p.blockers).toEqual([]);
  expect(p.entries).toHaveLength(8);
  expect(p.entries.find((e) => e.id === 'codex:handler:block-dangerous.sh')).toMatchObject({
    disposition: 'retain_machine_floor',
    baseline: { origin: 'unknown', local_differs: false },
  });
  expect(p.entries.find((e) => e.id === 'codex:library:helper.py').disposition).toBe(
    'retain_machine_dependency_review'
  );
  expect(p.chains).toHaveLength(12);
  expect(p.chains.every((c) => c.equivalent)).toBe(true);
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  expect(fs.existsSync(path.join(root, POLICY))).toBe(false);
  expect(fs.existsSync(path.join(home, 'state/hooks-imports'))).toBe(false);
});

test.each(['floor', 'library', 'unknown'])(
  'inadmissible %s selection refuses before writing',
  (kind) => {
    const { root, home, file } = setup();
    const id =
      kind === 'floor'
        ? 'codex:handler:block-dangerous.sh'
        : kind === 'library'
          ? 'codex:library:helper.py'
          : 'codex:handler:missing.sh';
    const before = fs.readFileSync(file, 'utf8');
    expect(() => planHookReconciliation(root, home, [id])).toThrow('not transferable');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(root, POLICY))).toBe(false);
  }
);

test('new install origins name upstream bytes and changed legacy baselines remain unknown', () => {
  const root = fs.realpathSync(makeTempRepo());
  installHookPack(SHARED_PACK, { repoRoot: root });
  const baseline = pristinePathFor(root, 'shared', '.caws/hooks/block-dangerous.sh');
  expect(JSON.parse(fs.readFileSync(baseline + '.origin.json', 'utf8'))).toMatchObject({
    version: 1,
    writer: 'upstream-template-only',
    template_sha256: digest(fs.readFileSync(baseline)),
  });
});
