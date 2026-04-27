/**
 * @fileoverview CAWSFIX-30 — caws specs create rejects ids that collide
 * with archived specs unless --force is supplied.
 * Covers A1-A4 from .caws/specs/CAWSFIX-30.yaml.
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let originalCwd;
let tempDir;

const writeArchivedSpec = (id, body) => {
  const dir = path.join(tempDir, '.caws', 'specs', '.archive');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.yaml`), body);
};

const writeRegistry = (entries) => {
  fs.writeFileSync(
    path.join(tempDir, '.caws', 'specs', 'registry.json'),
    JSON.stringify({ version: 1, specs: entries }, null, 2)
  );
};

const archivedSpecBody = (id) =>
  [
    `id: ${id}`,
    'type: feature',
    'title: Previously archived',
    'risk_tier: 2',
    'mode: development',
    `created_at: '2026-01-01T00:00:00.000Z'`,
    `updated_at: '2026-04-27T00:00:00.000Z'`,
    'status: archived',
    'invariants:',
    '  - Invariant one',
    'acceptance:',
    '  - id: A1',
    '    given: X',
    '    when: Y',
    '    then: Z',
    '',
  ].join('\n');

describe('CAWSFIX-30 — caws specs create archive-collision guard', () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawsfix-30-'));
    fs.mkdirSync(path.join(tempDir, '.caws', 'specs'), { recursive: true });
    process.chdir(tempDir);
    jest.resetModules();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('A1: create rejects when id collides with archived spec and --force is omitted', async () => {
    const id = 'COLLIDE-01';
    writeArchivedSpec(id, archivedSpecBody(id));
    writeRegistry({
      [id]: {
        path: `.archive/${id}.yaml`,
        type: 'feature',
        status: 'archived',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-04-27T00:00:00.000Z',
        owner: null,
      },
    });

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { createSpec } = require('../src/commands/specs');

    await expect(createSpec(id, { type: 'feature', title: 'attempt' })).rejects.toThrow(
      /archived/i
    );

    // Error must name the archived path so the operator knows where the collision lives.
    const errOutput = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errOutput).toMatch(/\.archive/);
    errSpy.mockRestore();

    // No new file written under .caws/specs/ — only the archived copy exists.
    expect(fs.existsSync(path.join(tempDir, '.caws', 'specs', `${id}.yaml`))).toBe(false);
    expect(
      fs.existsSync(path.join(tempDir, '.caws', 'specs', '.archive', `${id}.yaml`))
    ).toBe(true);
  });

  test('A2: --force removes archived YAML, drops registry entry, creates fresh draft', async () => {
    const id = 'COLLIDE-02';
    writeArchivedSpec(id, archivedSpecBody(id));
    writeRegistry({
      [id]: {
        path: `.archive/${id}.yaml`,
        type: 'feature',
        status: 'archived',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-04-27T00:00:00.000Z',
        owner: null,
      },
    });

    const { createSpec } = require('../src/commands/specs');
    const result = await createSpec(id, {
      type: 'feature',
      title: 'Resurrected',
      force: true,
    });

    expect(result).toBeTruthy();
    expect(result.id).toBe(id);

    // Only one file with this id remains on disk afterward.
    expect(fs.existsSync(path.join(tempDir, '.caws', 'specs', `${id}.yaml`))).toBe(true);
    expect(
      fs.existsSync(path.join(tempDir, '.caws', 'specs', '.archive', `${id}.yaml`))
    ).toBe(false);

    // Registry now points at the new active path with draft status.
    const registry = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.caws', 'specs', 'registry.json'), 'utf8')
    );
    expect(registry.specs[id]).toBeDefined();
    expect(registry.specs[id].path).toBe(`${id}.yaml`);
    expect(registry.specs[id].status).toBe('draft');
  });

  test('A3: collision detected even when registry has no entry for the archived spec (manually-moved legacy case)', async () => {
    const id = 'COLLIDE-03';
    writeArchivedSpec(id, archivedSpecBody(id));
    // Critically: registry is empty — simulating a pre-CAWSFIX-29 manual move.
    writeRegistry({});

    const { createSpec } = require('../src/commands/specs');
    await expect(createSpec(id, { type: 'feature' })).rejects.toThrow(/archived/i);

    expect(fs.existsSync(path.join(tempDir, '.caws', 'specs', `${id}.yaml`))).toBe(false);
    // The archived file must still be present — a regression that deletes
    // it during a rejected create would silently destroy data.
    expect(
      fs.existsSync(path.join(tempDir, '.caws', 'specs', '.archive', `${id}.yaml`))
    ).toBe(true);
  });

  test('A4: happy path — no archive collision, create proceeds normally', async () => {
    writeRegistry({});
    const { createSpec } = require('../src/commands/specs');
    const result = await createSpec('FRESH-01', { type: 'feature', title: 'New' });

    expect(result).toBeTruthy();
    expect(result.id).toBe('FRESH-01');
    expect(fs.existsSync(path.join(tempDir, '.caws', 'specs', 'FRESH-01.yaml'))).toBe(true);
  });
});
