'use strict';

/**
 * `caws specs create --module / --invariant` (Sterling ledger N16), A1 + A2.
 *
 * `blast_radius.modules` and `invariants` are both schema-required non-empty
 * (`spec.v1.json`: `required: ["modules"]`, `minItems: 1`). The renderer
 * therefore had to emit *something*, and no flag could supply it — so every
 * spec the CLI created committed a scaffolded marker string into tracked
 * governance state, colliding with the consuming project's "no committed
 * marker" rule, with no surface able to discharge it afterwards.
 *
 * These tests assert against the EXPORTED constants rather than hardcoding the
 * scaffold text. That is the contract: the renderer, the create-time advisory,
 * and `caws specs amend` must all agree on what a scaffolded entry IS, because
 * amend treats "this entry is scaffolded" as permission to overwrite an
 * otherwise-immutable closed spec. A test with its own copy of the string
 * would keep passing while those surfaces drifted apart.
 *
 * SUT: compiled surface, plus one spawned dist/index.js run — Commander
 * parsing a flag is not the same as the writer receiving it.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { runSpecsCreateCommand, runSpecsShowCommand } = require('../../dist/shell/commands/specs');
const {
  MODULES_PLACEHOLDER,
  INVARIANTS_PLACEHOLDER,
  isScaffoldPlaceholder,
} = require('../../dist/store/specs-writer');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

afterAll(() => {
  cleanupAll();
});

function setupRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed');
  return { root, cawsDir: path.join(root, '.caws') };
}

function runCreate(cwd, id, opts = {}) {
  const out = [];
  const err = [];
  const code = runSpecsCreateCommand({
    cwd,
    now: () => new Date('2026-08-12T12:00:00.000Z'),
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'test-session' },
    id,
    title: 'scaffold flag fixture',
    mode: 'chore',
    riskTier: '3',
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function readSpec(cawsDir, id) {
  return fs.readFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), 'utf8');
}

describe('A1: the flags populate the fields the template scaffolds', () => {
  test('--module and --invariant are repeatable and replace the scaffold', () => {
    const { root, cawsDir } = setupRepo();

    const result = runCreate(root, 'SCAFFOLD-A1-001', {
      module: ['packages/alpha', 'packages/beta'],
      invariant: ['ordering is preserved across retries'],
    });
    expect(result.code).toBe(0);

    const yaml = readSpec(cawsDir, 'SCAFFOLD-A1-001');
    expect(yaml).toContain("- 'packages/alpha'");
    expect(yaml).toContain("- 'packages/beta'");
    expect(yaml).toContain("- 'ordering is preserved across retries'");

    // HEADLINE: the scaffold text is gone from both fields.
    expect(yaml).not.toContain(MODULES_PLACEHOLDER);
    expect(yaml).not.toContain(INVARIANTS_PLACEHOLDER);
  });

  test('the created spec still validates with operator-supplied values', () => {
    const { root } = setupRepo();
    expect(
      runCreate(root, 'SCAFFOLD-A1-002', {
        module: ['packages/alpha'],
        invariant: ['the thing holds'],
      }).code
    ).toBe(0);

    // Not vacuous: prove the body is kernel-valid, not merely well-shaped text.
    const validate = spawnSync(
      process.execPath,
      [CLI, 'specs', 'validate', '.caws/specs/SCAFFOLD-A1-002.yaml'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'test-session' } }
    );
    expect(validate.status).toBe(0);
    expect(validate.stdout).toContain('is valid');
  });
});

describe('A2: omitting the flags is byte-for-byte unchanged', () => {
  test('the scaffold is still written and the create still succeeds', () => {
    const { root, cawsDir } = setupRepo();

    const result = runCreate(root, 'SCAFFOLD-A2-001');
    expect(result.code).toBe(0);

    const yaml = readSpec(cawsDir, 'SCAFFOLD-A2-001');
    // Backward compatibility is the point: existing callers and the guided
    // authoring flow must see exactly what they saw before this slice.
    expect(yaml).toContain(MODULES_PLACEHOLDER);
    expect(yaml).toContain(INVARIANTS_PLACEHOLDER);
  });

  test('supplying only one flag leaves the other field scaffolded', () => {
    const { root, cawsDir } = setupRepo();

    expect(runCreate(root, 'SCAFFOLD-A2-002', { module: ['packages/only'] }).code).toBe(0);

    const yaml = readSpec(cawsDir, 'SCAFFOLD-A2-002');
    expect(yaml).toContain("- 'packages/only'");
    expect(yaml).not.toContain(MODULES_PLACEHOLDER);
    // The flags are independent — filling one must not silently fill the other.
    expect(yaml).toContain(INVARIANTS_PLACEHOLDER);
  });
});

describe('isScaffoldPlaceholder is the shared contract', () => {
  test('it recognises both scaffold strings and rejects operator content', () => {
    expect(isScaffoldPlaceholder(MODULES_PLACEHOLDER)).toBe(true);
    expect(isScaffoldPlaceholder(INVARIANTS_PLACEHOLDER)).toBe(true);
    expect(isScaffoldPlaceholder('packages/alpha')).toBe(false);
    // A near-miss must NOT count: amend uses this predicate to decide whether
    // overwriting an entry on a closed spec is permitted, so a loose match
    // would let it rewrite a real claim.
    expect(isScaffoldPlaceholder(`${MODULES_PLACEHOLDER} and more`)).toBe(false);
    expect(isScaffoldPlaceholder('')).toBe(false);
  });
});

describe('A3: the advisory is emitted where it is actionable, and nowhere else', () => {
  test('create without the flags names both fields and both flags', () => {
    const { root } = setupRepo();

    const result = runCreate(root, 'SCAFFOLD-A3-001');
    expect(result.code).toBe(0);

    expect(result.err).toContain('scaffolded defaults');
    expect(result.err).toContain('blast_radius.modules (--module)');
    expect(result.err).toContain('invariants (--invariant)');
    // Non-blocking: an advisory must not fail the create.
    expect(result.code).toBe(0);
  });

  test('the advisory names only the fields actually left scaffolded', () => {
    const { root } = setupRepo();

    const result = runCreate(root, 'SCAFFOLD-A3-002', { module: ['packages/alpha'] });
    expect(result.err).toContain('invariants (--invariant)');
    expect(result.err).not.toContain('blast_radius.modules');
  });

  test('supplying both flags silences it entirely', () => {
    const { root } = setupRepo();

    const result = runCreate(root, 'SCAFFOLD-A3-003', {
      module: ['packages/alpha'],
      invariant: ['it holds'],
    });
    expect(result.err).not.toContain('scaffolded defaults');
  });

  test('caws specs show NEVER prints create-flag remediation', () => {
    const { root } = setupRepo();
    // A spec that genuinely still carries both scaffolded defaults — so if the
    // advisory were wired to show, this is exactly where it would fire.
    expect(runCreate(root, 'SCAFFOLD-A3-004').code).toBe(0);

    const out = [];
    const err = [];
    const code = runSpecsShowCommand({
      cwd: root,
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'test-session' },
      id: 'SCAFFOLD-A3-004',
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    expect(code).toBe(0);

    // HEADLINE: --module/--invariant cannot be run against an existing spec, so
    // naming them here would be a remediation the CLI refuses.
    const combined = `${out.join('\n')}\n${err.join('\n')}`;
    expect(combined).not.toContain('--module');
    expect(combined).not.toContain('--invariant');
    expect(combined).not.toContain('scaffolded defaults');
  });
});

describe('the Commander wiring is real, not just the handler', () => {
  test('a spawned CLI run forwards both repeatable flags to the writer', () => {
    const { root, cawsDir } = setupRepo();

    const run = spawnSync(
      process.execPath,
      [
        CLI, 'specs', 'create', 'SCAFFOLD-CLI-001',
        '--title', 'cli path', '--mode', 'chore', '--risk-tier', '3',
        '--module', 'packages/from-cli', '--module', 'packages/second',
        '--invariant', 'invariant from cli',
      ],
      { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'test-session' } }
    );
    expect(run.status).toBe(0);

    const yaml = readSpec(cawsDir, 'SCAFFOLD-CLI-001');
    expect(yaml).toContain("- 'packages/from-cli'");
    expect(yaml).toContain("- 'packages/second'");
    expect(yaml).toContain("- 'invariant from cli'");
    expect(yaml).not.toContain(MODULES_PLACEHOLDER);
    expect(yaml).not.toContain(INVARIANTS_PLACEHOLDER);
  });
});
