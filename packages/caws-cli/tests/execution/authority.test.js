const fs = require('node:fs');
const path = require('node:path');
const {
  readExecutionAuthority,
  ExecutionAuthorityUnavailable,
} = require('../../dist/execution/authority');
const { authorityFixture, cleanupAll } = require('./authority-fixture');
afterAll(cleanupAll);
function refuse(fixture, reason) {
  let caught;
  try {
    readExecutionAuthority(fixture.record);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ExecutionAuthorityUnavailable);
  if (reason) expect(caught.reason).toBe(reason);
}
describe('current execution authority snapshot', () => {
  test('uses actual current thread, exact linked checkout and LF paths rather than lineage or target claims', () => {
    const f = authorityFixture();
    const result = readExecutionAuthority(f.record);
    expect(result.canonical).toBe(f.root);
    expect(result.pin).toBe(f.lane);
    expect(result.binding.kind).toBe('bound');
    expect(result.binding.worktreeName).toBe('owned');
    expect(result.binding.spec.id).toBe('EXEC-001');
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(readExecutionAuthority(f.record).revision).toBe(result.revision);
    f.record.association.threadId = f.record.association.sessionId;
    refuse(f, 'foreign_owner');
  });
  test('retains LF in the canonical root through both fixed Git queries and the complete readset', () => {
    const f = authorityFixture({ canonicalLF: true });
    const authority = readExecutionAuthority(f.record);
    expect(authority.canonical).toBe(f.root);
    expect(authority.canonical.endsWith('\n')).toBe(true);
    expect(authority.pin).toBe(f.lane);
    expect(authority.cawsDir).toBe(path.join(f.root, '.caws'));
  });

  test.each(['policy.yaml', 'worktrees.json', 'specs/EXEC-001.yaml'])(
    'missing or malformed %s cannot fall back to empty authority',
    (name) => {
      const f = authorityFixture();
      const file = path.join(f.caws, name);
      fs.unlinkSync(file);
      refuse(f);
      fs.writeFileSync(file, 'malformed: [');
      refuse(f);
    }
  );
  test('rejects duplicate spec ids, skipped malformed authority and symlink or hardlink authority', () => {
    const f = authorityFixture();
    const duplicate = path.join(f.caws, 'specs', 'duplicate.yml');
    fs.writeFileSync(duplicate, JSON.stringify(f.spec));
    refuse(f);
    fs.writeFileSync(duplicate, 'not valid spec');
    refuse(f);
    fs.unlinkSync(duplicate);
    const saved = path.join(f.root, 'policy.saved');
    fs.renameSync(path.join(f.caws, 'policy.yaml'), saved);
    fs.symlinkSync(saved, path.join(f.caws, 'policy.yaml'));
    refuse(f);
    fs.unlinkSync(path.join(f.caws, 'policy.yaml'));
    fs.linkSync(saved, path.join(f.caws, 'policy.yaml'));
    refuse(f);
  });
  test.each([
    [
      'inactive',
      (f) => {
        f.spec.lifecycle_state = 'draft';
        fs.writeFileSync(f.specPath, JSON.stringify(f.spec));
      },
    ],
    [
      'one sided',
      (f) => {
        f.spec.worktree = 'elsewhere';
        fs.writeFileSync(f.specPath, JSON.stringify(f.spec));
      },
    ],
    [
      'no owner',
      (f) => {
        delete f.registry.owned.owner;
      },
    ],
    [
      'malformed owner',
      (f) => {
        f.registry.owned.owner = [];
      },
    ],
    [
      'equal path',
      (f) => {
        f.registry.other = { ...f.registry.owned };
      },
    ],
    [
      'arbitrary directory',
      (f) => {
        f.registry.owned.path = f.root;
      },
    ],
    [
      'bad row',
      (f) => {
        f.registry.other = null;
      },
    ],
    [
      'bad spec id',
      (f) => {
        f.registry.other = { specId: 42 };
      },
    ],
    [
      'relative path',
      (f) => {
        f.registry.other = { path: 'relative' };
      },
    ],
  ])('refuses %s authority rather than selecting a target fallback', (_name, change) => {
    const f = authorityFixture();
    change(f);
    fs.writeFileSync(f.registryPath, JSON.stringify(f.registry));
    refuse(f);
  });
  test('rejects project/cwd aliases and a different execution checkout', () => {
    const f = authorityFixture();
    f.record.projectRoot = '/wrong';
    refuse(f);
    f.record.projectRoot = f.root;
    f.record.execution.cwd = f.root;
    refuse(f);
    f.record.execution.cwd = f.lane;
    const alias = path.join(f.root, 'alias');
    fs.symlinkSync(f.lane, alias);
    f.record.association.callerAnchor = alias;
    refuse(f);
  });
  test('binds policy, all spec filenames/bytes, registry and bridge absence; ignores liveness caches', () => {
    const f = authorityFixture();
    const first = readExecutionAuthority(f.record).revision;
    fs.writeFileSync(path.join(f.caws, 'agents.json'), '{}');
    fs.writeFileSync(path.join(f.caws, 'messages.jsonl'), 'not authority');
    expect(readExecutionAuthority(f.record).revision).toBe(first);
    fs.appendFileSync(path.join(f.caws, 'policy.yaml'), '\n# authority revision change\n');
    const second = readExecutionAuthority(f.record).revision;
    expect(second).not.toBe(first);
    fs.mkdirSync(path.join(f.caws, 'claims'));
    fs.writeFileSync(path.join(f.caws, 'claims/bridge.json'), '{}');
    expect(readExecutionAuthority(f.record).revision).not.toBe(second);
  });
  test('admits exactly one active thread-owned bridge and refuses worktree-held/foreign/multiple claims', () => {
    const f = authorityFixture();
    f.record.association.callerAnchor = f.root;
    f.record.execution.cwd = f.root;
    delete f.spec.worktree;
    fs.writeFileSync(f.specPath, JSON.stringify(f.spec));
    fs.writeFileSync(f.registryPath, '{}');
    fs.mkdirSync(path.join(f.caws, 'claims'));
    const bridge = path.join(f.caws, 'claims/bridge.json');
    const claims = { 'EXEC-001': { session_id: 'thread-owned', platform: 'codex' } };
    fs.writeFileSync(bridge, JSON.stringify(claims));
    const actual = readExecutionAuthority(f.record);
    expect(actual.binding).toMatchObject({
      kind: 'bridged',
      session_id: 'thread-owned',
      spec: { id: 'EXEC-001' },
    });
    expect(actual.pin).toBe(f.root);
    claims['EXEC-001'].session_id = 'lineage-foreign';
    fs.writeFileSync(bridge, JSON.stringify(claims));
    refuse(f);
    claims['EXEC-001'].session_id = 'thread-owned';
    fs.writeFileSync(bridge, JSON.stringify(claims));
    fs.writeFileSync(f.registryPath, JSON.stringify(f.registry));
    refuse(f);
    fs.writeFileSync(f.registryPath, '{}');
    const other = { ...f.spec, id: 'OTHER-002' };
    fs.writeFileSync(path.join(f.caws, 'specs/OTHER-002.yaml'), JSON.stringify(other));
    claims['OTHER-002'] = { session_id: 'thread-owned' };
    fs.writeFileSync(bridge, JSON.stringify(claims));
    refuse(f);
    fs.writeFileSync(bridge, '{"EXEC-001":null}');
    refuse(f);
  });
});
