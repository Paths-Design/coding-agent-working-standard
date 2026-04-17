/**
 * @fileoverview CAWSFIX-15 — specs close produces a minimal diff.
 * Covers A1-A3 from .caws/specs/CAWSFIX-15.yaml.
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

// closeSpec reads from CWD/.caws — we create a tmpdir, chdir into it, and
// restore the original CWD in afterEach.
let originalCwd;
let tempDir;

const writeSpec = (id, body) => {
  const specsDir = path.join(tempDir, '.caws', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.writeFileSync(path.join(specsDir, `${id}.yaml`), body);
};

const writeRegistry = (entries) => {
  const registry = { version: 1, specs: entries };
  fs.writeFileSync(
    path.join(tempDir, '.caws', 'specs', 'registry.json'),
    JSON.stringify(registry, null, 2)
  );
};

describe('CAWSFIX-15 — specs close diff minimization', () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawsfix-15-'));
    process.chdir(tempDir);
    // Jest module cache must re-resolve closeSpec relative to new CWD.
    jest.resetModules();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('A1 + A3: closing a status: active spec flips exactly one status line (plus updated_at) and updates registry', async () => {
    const specBody = [
      'id: TEST-01',
      'type: feature',
      'title: Diff-minimization probe',
      'risk_tier: 2',
      'mode: development',
      `created_at: '2026-04-17T00:00:00.000Z'`,
      `updated_at: '2026-04-17T00:00:00.000Z'`,
      'status: active',
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
    writeSpec('TEST-01', specBody);
    writeRegistry({
      'TEST-01': {
        path: 'TEST-01.yaml',
        type: 'feature',
        status: 'active',
        created_at: '2026-04-17T00:00:00.000Z',
        updated_at: '2026-04-17T00:00:00.000Z',
        owner: null,
      },
    });

    const { closeSpec } = require('../src/commands/specs');
    const ok = await closeSpec('TEST-01');
    expect(ok).toBe(true);

    const after = fs.readFileSync(path.join(tempDir, '.caws', 'specs', 'TEST-01.yaml'), 'utf8');

    // A1: every line except `status:` and `updated_at:` is byte-identical.
    const beforeLines = specBody.split('\n');
    const afterLines = after.split('\n');
    expect(afterLines.length).toBe(beforeLines.length);
    const changedLineIdx = [];
    for (let i = 0; i < beforeLines.length; i++) {
      if (beforeLines[i] !== afterLines[i]) changedLineIdx.push(i);
    }
    // Expect exactly 2 changed lines: status and updated_at
    expect(changedLineIdx.length).toBe(2);
    const changedStarters = changedLineIdx.map((i) => afterLines[i].split(':')[0]).sort();
    expect(changedStarters).toEqual(['status', 'updated_at']);

    // Comment preserved
    expect(after).toContain('# preserve this comment');
    // Status is now closed
    expect(after).toMatch(/^status: closed\s*$/m);

    // A3: registry reflects the close
    const registry = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.caws', 'specs', 'registry.json'), 'utf8')
    );
    expect(registry.specs['TEST-01'].status).toBe('closed');
    // Registry updated_at matches what's now in the YAML
    const yamlDoc = yaml.load(after);
    expect(registry.specs['TEST-01'].updated_at).toBe(yamlDoc.updated_at);
  });

  test('A2: closing an already-closed spec is a no-op (no file mutation)', async () => {
    const specBody = [
      'id: TEST-02',
      'type: feature',
      'title: Already closed',
      'risk_tier: 2',
      'mode: development',
      `created_at: '2026-04-17T00:00:00.000Z'`,
      `updated_at: '2026-04-17T00:00:00.000Z'`,
      'status: closed',
      '',
    ].join('\n');
    writeSpec('TEST-02', specBody);
    writeRegistry({
      'TEST-02': {
        path: 'TEST-02.yaml',
        type: 'feature',
        status: 'closed',
        created_at: '2026-04-17T00:00:00.000Z',
        updated_at: '2026-04-17T00:00:00.000Z',
        owner: null,
      },
    });

    const { closeSpec } = require('../src/commands/specs');
    const ok = await closeSpec('TEST-02');
    // Returns true (already closed is a soft success)
    expect(ok).toBe(true);

    const after = fs.readFileSync(path.join(tempDir, '.caws', 'specs', 'TEST-02.yaml'), 'utf8');
    expect(after).toBe(specBody);
  });
});
