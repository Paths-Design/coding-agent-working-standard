'use strict';

// These tests run compiled production writers against private repositories.
// The one-shot lock-entry interleaving models a competing published readset;
// it does not replace the body, validation, filesystem publication or lock.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const yaml = require('js-yaml');
const lock = require('../../dist/store/lifecycle-lock');
const policyModule = require('../../dist/kernel/policy');
const { parseAndValidateSpec } = require('../../dist/kernel');
const {
  initProject,
  planInitProject,
  DEFAULT_POLICY_YAML,
} = require('../../dist/store/init-store');
const { runSpecsMigrateApply } = require('../../dist/store/specs-migration');
const { adoptLegacyProject } = require('../../dist/store/legacy-adoption');
const { runWorktreeMigrateRegistryCommand } = require('../../dist/shell/commands/worktree');
const { makeTempRepo, cleanupAll } = require('../helpers/git-repo-factory');
const ID = 'MAINTENANCE-001';
const NOW = new Date('2026-10-26T12:00:00Z');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
afterEach(() => jest.restoreAllMocks());
afterAll(cleanupAll);

function write(f, relative, text) {
  const target = path.join(f.cawsDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
function read(f, relative) {
  return fs.readFileSync(path.join(f.cawsDir, relative), 'utf8');
}
function spec(overrides = {}) {
  const value = {
    id: ID,
    title: 'Preserve concurrent maintenance authority',
    risk_tier: 3,
    mode: 'feature',
    lifecycle_state: 'draft',
    blast_radius: { modules: ['maintenance'] },
    operational_rollback_slo: '5m',
    scope: { in: ['src/original.ts'], out: [] },
    invariants: ['Preserve authority'],
    acceptance: [{ id: 'A1', given: 'authority', when: 'maintained', then: 'it is preserved' }],
    non_functional: {},
    contracts: [],
    ...overrides,
  };
  const text = yaml.dump(value);
  expect(parseAndValidateSpec(text).ok).toBe(true);
  return text;
}
function fixture(initialized = true) {
  const root = makeTempRepo();
  const f = { root, cawsDir: path.join(root, '.caws') };
  if (initialized) expect(initProject(root).ok).toBe(true);
  else fs.mkdirSync(f.cawsDir);
  return f;
}
function snapshot(f) {
  const result = {};
  function visit(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (name === 'state.lock') continue;
      if (entry.isDirectory()) {
        result[name + '/'] = 'directory';
        visit(path.join(dir, entry.name), name + '/');
      } else result[name] = fs.readFileSync(path.join(dir, entry.name)).toString('base64');
    }
  }
  visit(f.cawsDir);
  return result;
}
function beforeAcquire(change) {
  const real = lock.withLifecycleLock;
  jest.spyOn(lock, 'withLifecycleLock').mockImplementationOnce((...args) => {
    change();
    return real(...args);
  });
}
function registryCommand(f, dryRun = false) {
  const out = [],
    errors = [];
  const code = runWorktreeMigrateRegistryCommand({
    cwd: f.root,
    dryRun,
    out: (s) => out.push(s),
    err: (s) => errors.push(s),
  });
  return { code, out: out.join('\n'), errors: errors.join('\n') };
}
function migrateSpecs(f, apply = true) {
  return runSpecsMigrateApply({ cawsDir: f.cawsDir, from: 'v10', apply, partial: false, now: NOW });
}
function legacyFixture() {
  const f = fixture();
  const original = 'id: OLD-SINGLETON\n';
  write(f, 'working-spec.yaml', original);
  f.plan = {
    version: 1,
    reason: 'Reviewed conversion',
    requirementNotes: ['Original obligations persist'],
    changes: [
      { path: '.caws/working-spec.yaml', beforeSha256: sha(original), contents: null },
      { path: `.caws/specs/${ID}.yaml`, beforeSha256: null, contents: spec() },
    ],
  };
  return f;
}
function registryFixture() {
  const f = fixture();
  f.old = { old: { branch: 'caws/old', path: path.join(f.root, 'old') } };
  write(f, 'worktrees.json', JSON.stringify({ version: 1, worktrees: f.old }));
  return f;
}
function specsFixture() {
  const f = fixture();
  const old = yaml.load(spec({ lifecycle_state: 'active' }));
  old.status = old.lifecycle_state;
  delete old.lifecycle_state;
  old.acceptance_criteria = old.acceptance;
  delete old.acceptance;
  old.type = old.mode;
  write(f, `specs/${ID}.yaml`, yaml.dump(old));
  return f;
}
const CASES = [
  {
    name: 'init',
    setup: () => fixture(false),
    run: (f) => initProject(f.root),
    preview: (f) => planInitProject(f.root),
    refused: (r) => {
      expect(r.ok).toBe(false);
      expect(r.errors.map((d) => d.rule)).toContain('store.lifecycle.lock_contention');
    },
    succeeded: (r, f) => {
      expect(r.ok).toBe(true);
      expect(r.value.outcome).toBe('created');
      expect(read(f, 'policy.yaml')).toBe(DEFAULT_POLICY_YAML);
      expect(JSON.parse(read(f, 'worktrees.json'))).toEqual({});
    },
  },
  {
    name: 'registry migration',
    setup: registryFixture,
    run: (f) => registryCommand(f),
    preview: (f) => registryCommand(f, true),
    refused: (r) => {
      expect(r.code).toBe(2);
      expect(r.errors).toContain('store.lifecycle.lock_contention');
    },
    succeeded: (r, f) => {
      expect(r.code).toBe(0);
      expect(JSON.parse(read(f, 'worktrees.json'))).toEqual(f.old);
    },
  },
  {
    name: 'spec migration',
    setup: specsFixture,
    run: (f) => migrateSpecs(f),
    preview: (f) => migrateSpecs(f, false),
    refused: (r) => {
      expect(r.ok).toBe(false);
      expect(r.errors.map((d) => d.rule)).toContain('store.lifecycle.lock_contention');
    },
    succeeded: (r, f) => {
      expect(r.ok).toBe(true);
      expect(r.value.report.entries[0].verdict).toMatch(/^migrated/);
      expect(yaml.load(read(f, `specs/${ID}.yaml`)).lifecycle_state).toBe('active');
      expect(fs.existsSync(r.value.report_path)).toBe(true);
    },
  },
  {
    name: 'legacy adoption',
    setup: legacyFixture,
    run: (f) => {
      try {
        return { value: adoptLegacyProject(f.root, f.plan, true) };
      } catch (error) {
        return { error };
      }
    },
    preview: (f) => adoptLegacyProject(f.root, f.plan, false),
    refused: (r) => expect(r.error.message).toContain('store.lifecycle.lock_contention'),
    succeeded: (r, f) => {
      expect(r.error).toBeUndefined();
      expect(r.value.readOnly).toBe(false);
      expect(read(f, `specs/${ID}.yaml`)).toBe(f.plan.changes[1].contents);
      expect(read(f, `${r.value.archive.slice('.caws/'.length)}/working-spec.yaml`)).toBe(
        'id: OLD-SINGLETON\n'
      );
      expect(fs.existsSync(path.join(f.cawsDir, 'working-spec.yaml'))).toBe(false);
      expect(fs.existsSync(path.join(f.root, '.git/caws-legacy-adoption.lock'))).toBe(false);
    },
  },
];

test.each(CASES)(
  '$name refuses a held canonical lock without authority mutation, then retries successfully',
  (c) => {
    const f = c.setup();
    const held = lock.acquireLifecycleLock(f.cawsDir);
    expect(held.ok).toBe(true);
    const before = snapshot(f);
    try {
      c.refused(c.run(f));
      expect(snapshot(f)).toEqual(before);
      expect(fs.existsSync(path.join(f.cawsDir, 'state.lock'))).toBe(true);
    } finally {
      lock.releaseLifecycleLock(held.value);
    }
    c.succeeded(c.run(f), f);
    expect(fs.existsSync(path.join(f.cawsDir, 'state.lock'))).toBe(false);
  }
);

test.each(CASES)(
  '$name preview stays pure and available while canonical authority is locked',
  (c) => {
    const f = c.setup();
    const held = lock.acquireLifecycleLock(f.cawsDir);
    expect(held.ok).toBe(true);
    const before = snapshot(f);
    const spy = jest.spyOn(lock, 'withLifecycleLock');
    try {
      const result = c.preview(f);
      if (c.name === 'registry migration') expect(result.code).toBe(0);
      else if (c.name === 'legacy adoption') expect(result.readOnly).toBe(true);
      else expect(result.ok).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      expect(snapshot(f)).toEqual(before);
    } finally {
      lock.releaseLifecycleLock(held.value);
    }
  }
);

test('registry migration reads the competing flat registry after acquisition', () => {
  const f = registryFixture();
  const fresh = { fresh: { specId: ID, branch: 'caws/fresh', path: path.join(f.root, 'fresh') } };
  const active = spec({ lifecycle_state: 'active', worktree: 'fresh' });
  beforeAcquire(() => {
    write(f, 'worktrees.json', JSON.stringify(fresh));
    write(f, `specs/${ID}.yaml`, active);
  });
  expect(registryCommand(f).code).toBe(0);
  expect(JSON.parse(read(f, 'worktrees.json'))).toEqual(fresh);
  expect(read(f, `specs/${ID}.yaml`)).toBe(active);
});

test('registry omission policy reads a spec claim created before acquisition', () => {
  const f = registryFixture();
  write(
    f,
    'worktrees.json',
    JSON.stringify({ version: 1, worktrees: { gone: { status: 'destroyed' } } })
  );
  const before = read(f, 'worktrees.json');
  beforeAcquire(() =>
    write(f, `specs/${ID}.yaml`, spec({ lifecycle_state: 'active', worktree: 'gone' }))
  );
  expect(registryCommand(f).code).toBe(1);
  expect(read(f, 'worktrees.json')).toBe(before);
});

test('spec apply rescans and preserves a competing modern active binding', () => {
  const f = specsFixture();
  const active = spec({
    lifecycle_state: 'active',
    worktree: 'fresh',
    scope: { in: ['src/fresh.ts'], out: [] },
  });
  beforeAcquire(() => write(f, `specs/${ID}.yaml`, active));
  const result = migrateSpecs(f);
  expect(result.ok).toBe(true);
  expect(result.value.report.entries).toEqual([]);
  expect(read(f, `specs/${ID}.yaml`)).toBe(active);
});

test('init reads newly seeded policy and registry after acquisition', () => {
  const f = fixture(false);
  const freshRegistry = { fresh: { specId: ID, branch: 'caws/fresh' } };
  const freshPolicy = DEFAULT_POLICY_YAML + '\n# reviewed concurrent policy\n';
  beforeAcquire(() => {
    write(f, 'policy.yaml', freshPolicy);
    write(f, 'worktrees.json', JSON.stringify(freshRegistry));
  });
  const result = initProject(f.root);
  expect(result.ok).toBe(true);
  expect(read(f, 'policy.yaml')).toBe(freshPolicy);
  expect(JSON.parse(read(f, 'worktrees.json'))).toEqual(freshRegistry);
  expect(result.value.created).not.toContain(path.join(f.cawsDir, 'policy.yaml'));
  expect(result.value.created).not.toContain(path.join(f.cawsDir, 'worktrees.json'));
});

test('init reports its newly created container truthfully and repeats as a no-op', () => {
  const root = makeTempRepo();
  const first = initProject(root);
  expect(first.ok).toBe(true);
  expect(first.value.created).toContain(path.join(root, '.caws'));
  const second = initProject(root);
  expect(second.ok).toBe(true);
  expect(second.value).toMatchObject({ outcome: 'already_initialized', created: [] });
});

test('init checks legacy residue after acquisition before seeding authority', () => {
  const f = fixture(false);
  beforeAcquire(() => write(f, 'working-spec.yaml', 'original legacy requirements\n'));
  const result = initProject(f.root);
  expect(result.ok).toBe(false);
  expect(result.errors.map((d) => d.rule)).toContain('store.init.legacy_residue');
  expect(snapshot(f)).toEqual({
    'working-spec.yaml': Buffer.from('original legacy requirements\n').toString('base64'),
  });
});

test('init refuses an invalid default policy without seeding authority', () => {
  const f = fixture(false);
  jest.spyOn(policyModule, 'parseAndValidatePolicy').mockReturnValueOnce({
    ok: false,
    errors: [
      {
        rule: 'test.invalid_default',
        message: 'invalid default',
        severity: 'error',
        authority: 'test',
      },
    ],
  });
  const result = initProject(f.root);
  expect(result.ok).toBe(false);
  expect(result.errors.map((d) => d.rule)).toContain('store.init.default_policy_invalid');
  expect(snapshot(f)).toEqual({});
  expect(fs.existsSync(path.join(f.cawsDir, 'state.lock'))).toBe(false);
});

test('adoption preserves existing active authority, policy and registry alongside legacy residue', () => {
  const f = legacyFixture();
  const existing = spec({ id: 'EXISTING-001', lifecycle_state: 'active', worktree: 'existing' });
  const registry = JSON.stringify({
    existing: { specId: 'EXISTING-001', branch: 'caws/existing' },
  });
  write(f, 'specs/EXISTING-001.yaml', existing);
  write(f, 'worktrees.json', registry);
  expect(adoptLegacyProject(f.root, f.plan, true).readOnly).toBe(false);
  expect(read(f, 'specs/EXISTING-001.yaml')).toBe(existing);
  expect(read(f, 'worktrees.json')).toBe(registry);
  expect(read(f, 'policy.yaml')).toBe(DEFAULT_POLICY_YAML);
});

test('adoption rejects a reviewed target changed at lock acquisition without archiving or publishing', () => {
  const f = legacyFixture();
  const active = spec({ lifecycle_state: 'active', worktree: 'fresh' });
  beforeAcquire(() => write(f, `specs/${ID}.yaml`, active));
  expect(() => adoptLegacyProject(f.root, f.plan, true)).toThrow('Stale migration input');
  expect(read(f, `specs/${ID}.yaml`)).toBe(active);
  expect(read(f, 'working-spec.yaml')).toBe('id: OLD-SINGLETON\n');
  expect(fs.existsSync(path.join(f.cawsDir, 'legacy'))).toBe(false);
  expect(fs.existsSync(path.join(f.root, '.git/caws-legacy-adoption.lock'))).toBe(false);
});

test('adoption rejects different raw input bytes with the same decoded text', () => {
  const f = legacyFixture();
  const original = 'id: OLD-SINGLETON\n# replacement: \uFFFD\n';
  const competing = Buffer.concat([
    Buffer.from('id: OLD-SINGLETON\n# replacement: '),
    Buffer.from([0x80]),
    Buffer.from('\n'),
  ]);
  expect(competing.toString('utf8')).toBe(original);
  write(f, 'working-spec.yaml', original);
  f.plan.changes[0].beforeSha256 = sha(original);
  beforeAcquire(() => write(f, 'working-spec.yaml', competing));
  expect(() => adoptLegacyProject(f.root, f.plan, true)).toThrow('Stale migration input');
  expect(fs.readFileSync(path.join(f.cawsDir, 'working-spec.yaml'))).toEqual(competing);
  expect(fs.existsSync(path.join(f.cawsDir, `specs/${ID}.yaml`))).toBe(false);
  expect(fs.existsSync(path.join(f.cawsDir, 'legacy'))).toBe(false);
  expect(fs.existsSync(path.join(f.cawsDir, 'state.lock'))).toBe(false);
  expect(fs.existsSync(path.join(f.root, '.git/caws-legacy-adoption.lock'))).toBe(false);
});

test.each([
  ['omitted policy', (f) => write(f, 'policy.yaml', 'invalid policy\n'), 'validated modern policy'],
  [
    'unreviewed residue',
    (f) => write(f, 'working-spec.schema.json', '{}\n'),
    'Unreviewed legacy residue',
  ],
  [
    'unreviewed spec',
    (f) => write(f, 'specs/OTHER-001.yaml', 'id: OTHER-001\n'),
    'Unreviewed legacy spec',
  ],
])('adoption rechecks %s after acquisition', (_name, change, message) => {
  const f = legacyFixture();
  beforeAcquire(() => change(f));
  expect(() => adoptLegacyProject(f.root, f.plan, true)).toThrow(message);
  expect(read(f, 'working-spec.yaml')).toBe('id: OLD-SINGLETON\n');
  expect(fs.existsSync(path.join(f.cawsDir, `specs/${ID}.yaml`))).toBe(false);
  expect(fs.existsSync(path.join(f.cawsDir, 'legacy'))).toBe(false);
  expect(fs.existsSync(path.join(f.cawsDir, 'state.lock'))).toBe(false);
});

test.each(['existing invalid bytes', 'concurrent invalid bytes', 'concurrent different text'])(
  'adoption preserves conflicting archive: %s',
  (scenario) => {
    const f = legacyFixture();
    const original = 'id: OLD-SINGLETON\n# replacement: \uFFFD\n';
    write(f, 'working-spec.yaml', original);
    f.plan.changes[0].beforeSha256 = sha(original);
    const archive = `legacy/${sha(JSON.stringify(f.plan))}/working-spec.yaml`;
    const competing =
      scenario === 'concurrent different text'
        ? Buffer.from('retained original bytes\n')
        : Buffer.concat([
            Buffer.from('id: OLD-SINGLETON\n# replacement: '),
            Buffer.from([0xff]),
            Buffer.from('\n'),
          ]);
    if (scenario !== 'concurrent different text') expect(competing.toString('utf8')).toBe(original);
    if (scenario === 'existing invalid bytes') write(f, archive, competing);
    else beforeAcquire(() => write(f, archive, competing));
    expect(() => adoptLegacyProject(f.root, f.plan, true)).toThrow(/archive/i);
    expect(fs.readFileSync(path.join(f.cawsDir, archive))).toEqual(competing);
    expect(read(f, 'working-spec.yaml')).toBe(original);
    expect(fs.existsSync(path.join(f.cawsDir, `specs/${ID}.yaml`))).toBe(false);
    expect(fs.existsSync(path.join(f.cawsDir, 'state.lock'))).toBe(false);
    expect(fs.existsSync(path.join(f.root, '.git/caws-legacy-adoption.lock'))).toBe(false);
  }
);

test('adoption performs its Git resolution outside the common authority lock', () => {
  const f = legacyFixture();
  const real = childProcess.execFileSync;
  const spy = jest.spyOn(childProcess, 'execFileSync').mockImplementation((...args) => {
    expect(fs.existsSync(path.join(f.cawsDir, 'state.lock'))).toBe(false);
    return real(...args);
  });
  expect(adoptLegacyProject(f.root, f.plan, true).readOnly).toBe(false);
  expect(spy).toHaveBeenCalledWith(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    expect.any(Object)
  );
});
