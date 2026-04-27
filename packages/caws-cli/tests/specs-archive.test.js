/**
 * @fileoverview CAWSFIX-29 — caws specs archive command.
 * Covers A1-A9 from .caws/specs/CAWSFIX-29.yaml.
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

let originalCwd;
let tempDir;

const writeSpec = (id, body, { archive = false } = {}) => {
  const dir = archive
    ? path.join(tempDir, '.caws', 'specs', '.archive')
    : path.join(tempDir, '.caws', 'specs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.yaml`), body);
};

const writeRegistry = (entries) => {
  const registry = { version: 1, specs: entries };
  fs.writeFileSync(
    path.join(tempDir, '.caws', 'specs', 'registry.json'),
    JSON.stringify(registry, null, 2)
  );
};

const writeWorktreeRegistry = (worktrees) => {
  fs.writeFileSync(
    path.join(tempDir, '.caws', 'worktrees.json'),
    JSON.stringify({ version: 1, worktrees }, null, 2)
  );
};

const baseSpecBody = (id, status) =>
  [
    `id: ${id}`,
    'type: feature',
    'title: Archive probe',
    'risk_tier: 2',
    'mode: development',
    `created_at: '2026-04-17T00:00:00.000Z'`,
    `updated_at: '2026-04-17T00:00:00.000Z'`,
    `status: ${status}`,
    '# preserve this comment',
    'invariants:',
    '  - Invariant one',
    'acceptance:',
    '  - id: A1',
    '    given: X',
    '    when: Y',
    '    then: Z',
    '',
  ].join('\n');

describe('CAWSFIX-29 — caws specs archive', () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawsfix-29-'));
    fs.mkdirSync(path.join(tempDir, '.caws', 'specs'), { recursive: true });
    process.chdir(tempDir);
    jest.resetModules();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('A1: archiving a spec creates `.caws/specs/.archive/` and moves the file there', async () => {
    const id = 'ARC-01';
    writeSpec(id, baseSpecBody(id, 'closed'));
    writeRegistry({
      [id]: {
        path: `${id}.yaml`,
        type: 'feature',
        status: 'closed',
        created_at: '2026-04-17T00:00:00.000Z',
        updated_at: '2026-04-17T00:00:00.000Z',
        owner: null,
      },
    });

    const { archiveSpec } = require('../src/commands/specs');
    const ok = await archiveSpec(id);
    expect(ok).toBe(true);

    const archiveDir = path.join(tempDir, '.caws', 'specs', '.archive');
    expect(fs.existsSync(archiveDir)).toBe(true);
    expect(fs.existsSync(path.join(tempDir, '.caws', 'specs', `${id}.yaml`))).toBe(false);
    expect(fs.existsSync(path.join(archiveDir, `${id}.yaml`))).toBe(true);
  });

  test('A2: archived file diff is exactly status + updated_at; all other lines are byte-identical', async () => {
    const id = 'ARC-02';
    const before = baseSpecBody(id, 'closed');
    writeSpec(id, before);
    writeRegistry({
      [id]: {
        path: `${id}.yaml`,
        type: 'feature',
        status: 'closed',
        created_at: '2026-04-17T00:00:00.000Z',
        updated_at: '2026-04-17T00:00:00.000Z',
        owner: null,
      },
    });

    const { archiveSpec } = require('../src/commands/specs');
    const ok = await archiveSpec(id);
    expect(ok).toBe(true);

    const after = fs.readFileSync(
      path.join(tempDir, '.caws', 'specs', '.archive', `${id}.yaml`),
      'utf8'
    );

    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    expect(afterLines.length).toBe(beforeLines.length);

    const changedLineIdx = [];
    for (let i = 0; i < beforeLines.length; i++) {
      if (beforeLines[i] !== afterLines[i]) changedLineIdx.push(i);
    }
    expect(changedLineIdx.length).toBe(2);
    const changedStarters = changedLineIdx.map((i) => afterLines[i].split(':')[0]).sort();
    expect(changedStarters).toEqual(['status', 'updated_at']);

    expect(after).toMatch(/^status: archived\s*$/m);
    expect(after).toContain('# preserve this comment');
  });

  test('A3: archiving a spec whose YAML already says `status: archived` still moves it (idempotent canonical-location)', async () => {
    const id = 'ARC-03';
    writeSpec(id, baseSpecBody(id, 'archived'));
    writeRegistry({
      [id]: {
        path: `${id}.yaml`,
        type: 'feature',
        status: 'archived',
        created_at: '2026-04-17T00:00:00.000Z',
        updated_at: '2026-04-17T00:00:00.000Z',
        owner: null,
      },
    });

    const { archiveSpec } = require('../src/commands/specs');
    const ok = await archiveSpec(id);
    expect(ok).toBe(true);

    expect(fs.existsSync(path.join(tempDir, '.caws', 'specs', `${id}.yaml`))).toBe(false);
    const after = fs.readFileSync(
      path.join(tempDir, '.caws', 'specs', '.archive', `${id}.yaml`),
      'utf8'
    );
    expect(after).toMatch(/^status: archived\s*$/m);
  });

  test('A4: archiving a spec already in `.archive/` is a no-op success', async () => {
    const id = 'ARC-04';
    writeSpec(id, baseSpecBody(id, 'archived'), { archive: true });
    writeRegistry({
      [id]: {
        path: `.archive/${id}.yaml`,
        type: 'feature',
        status: 'archived',
        created_at: '2026-04-17T00:00:00.000Z',
        updated_at: '2026-04-17T00:00:00.000Z',
        owner: null,
      },
    });

    const archivePath = path.join(tempDir, '.caws', 'specs', '.archive', `${id}.yaml`);
    const beforeStat = fs.statSync(archivePath);

    const { archiveSpec } = require('../src/commands/specs');
    const ok = await archiveSpec(id);
    expect(ok).toBe(true);

    const afterStat = fs.statSync(archivePath);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  test('A5: registry reflects status: archived and `.archive/<id>.yaml` path after archive', async () => {
    const id = 'ARC-05';
    writeSpec(id, baseSpecBody(id, 'closed'));
    writeRegistry({
      [id]: {
        path: `${id}.yaml`,
        type: 'feature',
        status: 'closed',
        created_at: '2026-04-17T00:00:00.000Z',
        updated_at: '2026-04-17T00:00:00.000Z',
        owner: null,
      },
    });

    const { archiveSpec } = require('../src/commands/specs');
    const ok = await archiveSpec(id);
    expect(ok).toBe(true);

    const registry = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.caws', 'specs', 'registry.json'), 'utf8')
    );
    expect(registry.specs[id].status).toBe('archived');
    expect(registry.specs[id].path).toBe(`.archive/${id}.yaml`);

    const yamlDoc = yaml.load(
      fs.readFileSync(path.join(tempDir, '.caws', 'specs', '.archive', `${id}.yaml`), 'utf8')
    );
    expect(registry.specs[id].updated_at).toBe(yamlDoc.updated_at);
  });

  test('A6: listSpecFiles surfaces archive-dir specs as `status: archived` even if their YAML disagrees', async () => {
    // Simulates a manually-moved legacy spec: file lives in .archive/ but YAML still says closed.
    const id = 'ARC-06';
    writeSpec(id, baseSpecBody(id, 'closed'), { archive: true });
    writeRegistry({});

    const { listSpecFiles } = require('../src/commands/specs');
    const specs = await listSpecFiles();
    const found = specs.find((s) => s.id === id);
    expect(found).toBeDefined();
    expect(found.status).toBe('archived');
  });

  test('A7: archiving an unknown spec returns false (no file created/moved)', async () => {
    writeRegistry({});
    const { archiveSpec } = require('../src/commands/specs');
    const ok = await archiveSpec('DOES-NOT-EXIST');
    expect(ok).toBe(false);
    expect(fs.existsSync(path.join(tempDir, '.caws', 'specs', '.archive'))).toBe(false);
  });

  test('A9: a successful archive emits a spec_archived event with prior_status + prior_path', async () => {
    const id = 'ARC-09';
    writeSpec(id, baseSpecBody(id, 'closed'));
    writeRegistry({
      [id]: {
        path: `${id}.yaml`,
        type: 'feature',
        status: 'closed',
        created_at: '2026-04-17T00:00:00.000Z',
        updated_at: '2026-04-17T00:00:00.000Z',
        owner: null,
      },
    });

    const { archiveSpec } = require('../src/commands/specs');
    const ok = await archiveSpec(id);
    expect(ok).toBe(true);

    const eventsPath = path.join(tempDir, '.caws', 'events.jsonl');
    expect(fs.existsSync(eventsPath)).toBe(true);
    const lines = fs
      .readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const archived = lines.find((e) => e.event === 'spec_archived' && e.spec_id === id);
    expect(archived).toBeDefined();
    expect(archived.data.prior_status).toBe('closed');
    expect(archived.data.prior_path).toBe(`${id}.yaml`);
  });

  test('Security: refuses archive when id resolves outside the specs directory (path-traversal guard)', async () => {
    writeRegistry({});
    const { archiveSpec } = require('../src/commands/specs');
    // Even with no registry entry, a traversal-shaped id must be rejected before any I/O.
    const ok = await archiveSpec('../etc/passwd');
    expect(ok).toBe(false);
    expect(fs.existsSync(path.join(tempDir, '.caws', 'specs', '.archive'))).toBe(false);
  });

  test('A8: refuses archive when an active worktree references the spec', async () => {
    const id = 'ARC-08';
    writeSpec(id, baseSpecBody(id, 'closed'));
    writeRegistry({
      [id]: {
        path: `${id}.yaml`,
        type: 'feature',
        status: 'closed',
        created_at: '2026-04-17T00:00:00.000Z',
        updated_at: '2026-04-17T00:00:00.000Z',
        owner: null,
      },
    });
    writeWorktreeRegistry({
      'arc-08-wt': {
        name: 'arc-08-wt',
        path: '/tmp/fake',
        branch: 'caws/arc-08-wt',
        baseBranch: 'main',
        scope: null,
        specId: id,
        owner: null,
        createdAt: '2026-04-27T00:00:00.000Z',
        status: 'active',
      },
    });

    // The worktree-block path resolves the repo via `git rev-parse`, which
    // returns silently empty in a non-git tmpdir and skips the check entirely.
    // Bootstrap a real git repo so the guard actually runs.
    const { execFileSync } = require('child_process');
    execFileSync('git', ['init', '-q'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { archiveSpec } = require('../src/commands/specs');
    const ok = await archiveSpec(id);
    expect(ok).toBe(false);

    // The error message must name the referencing worktree so the operator
    // knows which to destroy — guards against a regression that swaps to
    // a generic "cannot archive" message.
    const errOutput = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errOutput).toMatch(/arc-08-wt/);
    errSpy.mockRestore();

    // File untouched
    expect(fs.existsSync(path.join(tempDir, '.caws', 'specs', `${id}.yaml`))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, '.caws', 'specs', '.archive'))).toBe(false);
  });
});
