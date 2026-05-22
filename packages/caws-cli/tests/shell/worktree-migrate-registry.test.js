/**
 * WORKTREE-REGISTRY-LEGACY-ENVELOPE-MIGRATION-001 — shell integration tests.
 *
 * Invokes the real CLI entrypoint
 * (node packages/caws-cli/dist/index.js worktree migrate-registry ...)
 * against temp repos. Verifies:
 *   - Command is registered (help text exists).
 *   - Exit codes 0 / 1 / 2 are correctly returned.
 *   - stdout/stderr formats match the contract.
 *   - --dry-run shares the classification path but writes nothing.
 *   - --data emits structured JSON with the documented shape.
 *   - events.jsonl is byte-stable across all paths.
 *   - The on-disk .caws/worktrees.json reflects the migration exactly.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI = path.join(__dirname, '..', '..', 'dist', 'index.js');

// ---- fixture helpers ------------------------------------------------------

function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // The CLI's resolveRepoRoot requires a real git repo; without
  // `git init` it returns store.repo_root.not_a_git_repo and the
  // command exits 2 before reaching the migration logic.
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', [
    '-C',
    root,
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'init',
  ]);
  return root;
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function makeCawsLayout(repoRoot) {
  const cawsDir = path.join(repoRoot, '.caws');
  fs.mkdirSync(cawsDir, { recursive: true });
  fs.mkdirSync(path.join(cawsDir, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(cawsDir, 'waivers'), { recursive: true });
  fs.mkdirSync(path.join(cawsDir, 'worktrees'), { recursive: true });
  fs.writeFileSync(
    path.join(cawsDir, 'policy.yaml'),
    `version: 1
risk_tiers:
  "1": { max_files: 5, max_loc: 200 }
  "2": { max_files: 15, max_loc: 600 }
  "3": { max_files: 30, max_loc: 1500 }
gates:
  budget_limit: { enabled: true, mode: block }
  spec_completeness: { enabled: true, mode: block }
  scope_boundary: { enabled: true, mode: block }
  god_object: { enabled: true, mode: warn }
  todo_detection: { enabled: true, mode: warn }
`
  );
  fs.writeFileSync(path.join(cawsDir, 'agents.json'), '{}');
  return cawsDir;
}

function writeRegistry(cawsDir, payload) {
  fs.writeFileSync(
    path.join(cawsDir, 'worktrees.json'),
    JSON.stringify(payload, null, 2) + '\n'
  );
}

function writeSpec(cawsDir, id, opts = {}) {
  const worktreeLine =
    opts.worktree !== undefined ? `worktree: '${opts.worktree}'\n` : '';
  fs.writeFileSync(
    path.join(cawsDir, 'specs', `${id}.yaml`),
    `id: ${id}
title: 'Fixture spec'
risk_tier: 3
mode: chore
lifecycle_state: active
created_at: '2026-05-22T00:00:00.000Z'
updated_at: '2026-05-22T11:59:30.000Z'
${worktreeLine}blast_radius:
  modules: [src/test]
  data_migration: false
operational_rollback_slo: 5m
scope:
  in: [src/test]
  out: []
invariants: ['fixture']
acceptance:
  - id: A1
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional: {}
contracts: []
`
  );
}

function runCli(cwd, args, env = {}) {
  // Returns { code, stdout, stderr }. Never throws on non-zero; tests
  // assert the exit code explicitly.
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return {
      code: typeof e.status === 'number' ? e.status : 1,
      stdout: e.stdout ? e.stdout.toString('utf8') : '',
      stderr: e.stderr ? e.stderr.toString('utf8') : '',
    };
  }
}

function readWorktreesJsonBytes(cawsDir) {
  return fs.readFileSync(path.join(cawsDir, 'worktrees.json'), 'utf8');
}

function readEventsJsonl(cawsDir) {
  const p = path.join(cawsDir, 'events.jsonl');
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8');
}

// ---- registration smoke ---------------------------------------------------

describe('caws worktree migrate-registry: command registration', () => {
  test('subcommand appears in worktree group help', () => {
    const r = runCli(os.tmpdir(), ['worktree', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('migrate-registry');
  });

  test('subcommand help text describes the migration', () => {
    const r = runCli(os.tmpdir(), ['worktree', 'migrate-registry', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('legacy-envelope');
    expect(r.stdout).toContain('--dry-run');
    expect(r.stdout).toContain('--data');
  });
});

// ---- exit codes + stdout/stderr formats -----------------------------------

describe('caws worktree migrate-registry: exit codes and output', () => {
  let repo;
  let cawsDir;

  beforeEach(() => {
    repo = mkRepo('caws-migrate-');
    cawsDir = makeCawsLayout(repo);
  });

  afterEach(() => rmrf(repo));

  test('F1 (legacy envelope, all non-terminal) → exit 0, writes flat-map', () => {
    writeRegistry(cawsDir, {
      version: 1,
      worktrees: { 'wt-a': { specId: 'A', status: 'active' } },
    });

    const r = runCli(repo, ['worktree', 'migrate-registry']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('legacy_envelope');
    expect(r.stdout).toContain('Migrating to v11 flat-map shape');
    expect(r.stdout).toContain('Wrote');
    expect(r.stdout).toContain('Post-migration record count: 1');

    const post = readWorktreesJsonBytes(cawsDir);
    expect(JSON.parse(post)).toEqual({
      'wt-a': { specId: 'A', status: 'active' },
    });
    expect(post.endsWith('\n')).toBe(true);
  });

  test('F2 (all destroyed omittable) → exit 0, writes exactly {}\\n (3 bytes)', () => {
    writeRegistry(cawsDir, {
      version: 1,
      worktrees: {
        'wt-d': { specId: 'X', status: 'destroyed', path: '/tmp/never-exists-xyz123' },
      },
    });

    const r = runCli(repo, ['worktree', 'migrate-registry']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('omitted');

    const post = readWorktreesJsonBytes(cawsDir);
    expect(post).toBe('{}\n');
    expect(Buffer.byteLength(post, 'utf8')).toBe(3);
  });

  test('F3 (destroyed + claiming spec) → exit 1, no write, stderr names spec', () => {
    writeRegistry(cawsDir, {
      version: 1,
      worktrees: {
        'wt-d': { specId: 'X', status: 'destroyed', path: '/tmp/nope-xyz123' },
      },
    });
    writeSpec(cawsDir, 'CLAIMER-1', { worktree: 'wt-d' });
    const before = readWorktreesJsonBytes(cawsDir);

    const r = runCli(repo, ['worktree', 'migrate-registry']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('refused');
    expect(r.stderr).toContain('CLAIMER-1');
    expect(r.stderr).toContain('still claims');

    // No write occurred.
    expect(readWorktreesJsonBytes(cawsDir)).toBe(before);
  });

  test('F4 (destroyed + path present) → exit 1, no write, stderr names path', () => {
    // Create a real directory so pathExistsCheck returns true.
    const realDir = path.join(repo, 'real-leftover');
    fs.mkdirSync(realDir);
    writeRegistry(cawsDir, {
      version: 1,
      worktrees: {
        'wt-d': { specId: 'X', status: 'destroyed', path: realDir },
      },
    });
    const before = readWorktreesJsonBytes(cawsDir);

    const r = runCli(repo, ['worktree', 'migrate-registry']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('refused');
    expect(r.stderr).toContain(realDir);
    expect(r.stderr).toContain('exists on disk');

    expect(readWorktreesJsonBytes(cawsDir)).toBe(before);
  });

  test('F5 (mixed shape) → exit 1, no write', () => {
    writeRegistry(cawsDir, {
      version: 1,
      worktrees: {},
      'wt-flat': { specId: 'Y' },
    });
    const before = readWorktreesJsonBytes(cawsDir);

    const r = runCli(repo, ['worktree', 'migrate-registry']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('refused');
    expect(r.stderr).toContain('mixed shape');

    expect(readWorktreesJsonBytes(cawsDir)).toBe(before);
  });

  test('F6 (already-flat) → exit 0, INFO message, no write', () => {
    writeRegistry(cawsDir, { 'wt-a': { specId: 'A' } });
    const before = readWorktreesJsonBytes(cawsDir);

    const r = runCli(repo, ['worktree', 'migrate-registry']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('already in v11 flat-map shape');
    expect(r.stdout).toContain('Record count: 1');

    // No write.
    expect(readWorktreesJsonBytes(cawsDir)).toBe(before);
  });

  test('F6 idempotency: running twice produces identical stdout and bytes', () => {
    // Start from F2 fixture, migrate once → {}\n, then migrate again.
    writeRegistry(cawsDir, {
      version: 1,
      worktrees: {
        'wt-d': { specId: 'X', status: 'destroyed', path: '/tmp/nope-xyz123' },
      },
    });
    const first = runCli(repo, ['worktree', 'migrate-registry']);
    expect(first.code).toBe(0);
    const afterFirst = readWorktreesJsonBytes(cawsDir);
    expect(afterFirst).toBe('{}\n');

    const second = runCli(repo, ['worktree', 'migrate-registry']);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('empty object');
    expect(readWorktreesJsonBytes(cawsDir)).toBe(afterFirst);
  });

  test('F7 / A12 (spec-load failure + destroyed records) → exit 1, no write', () => {
    writeRegistry(cawsDir, {
      version: 1,
      worktrees: {
        'wt-d': { specId: 'X', status: 'destroyed', path: '/tmp/nope-xyz123' },
      },
    });
    // Make .caws/specs/ unreadable by replacing it with a non-readable
    // file (forces fs.readdirSync to fail with READ_IO_FAILED).
    fs.rmSync(path.join(cawsDir, 'specs'), { recursive: true });
    fs.writeFileSync(path.join(cawsDir, 'specs'), 'not-a-directory');
    const before = readWorktreesJsonBytes(cawsDir);

    const r = runCli(repo, ['worktree', 'migrate-registry']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('refused');
    expect(r.stderr).toContain('spec loading failed');

    expect(readWorktreesJsonBytes(cawsDir)).toBe(before);
  });

  test('IO error: malformed JSON → exit 2 (read class)', () => {
    fs.writeFileSync(path.join(cawsDir, 'worktrees.json'), '{not json');

    const r = runCli(repo, ['worktree', 'migrate-registry']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('refused');
  });

  test('missing worktrees.json → exit 0, INFO message', () => {
    // makeCawsLayout does not create worktrees.json by default; nothing to unlink.
    const worktreesPath = path.join(cawsDir, 'worktrees.json');
    if (fs.existsSync(worktreesPath)) {
      fs.unlinkSync(worktreesPath);
    }

    const r = runCli(repo, ['worktree', 'migrate-registry']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('does not exist');
  });
});

// ---- --dry-run parity (A11) -----------------------------------------------

describe('caws worktree migrate-registry --dry-run: A11 parity', () => {
  let repo;
  let cawsDir;

  beforeEach(() => {
    repo = mkRepo('caws-migrate-dry-');
    cawsDir = makeCawsLayout(repo);
  });

  afterEach(() => rmrf(repo));

  test('apply path: dry-run produces same classification, no write', () => {
    writeRegistry(cawsDir, {
      version: 1,
      worktrees: { 'wt-a': { specId: 'A', status: 'active' } },
    });
    const before = readWorktreesJsonBytes(cawsDir);

    const r = runCli(repo, ['worktree', 'migrate-registry', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('legacy_envelope');
    expect(r.stdout).toContain('[dry-run]');
    expect(r.stdout).toContain('No files written');

    expect(readWorktreesJsonBytes(cawsDir)).toBe(before);
  });

  test('refusal path: dry-run returns same nonzero exit, no write', () => {
    writeRegistry(cawsDir, {
      version: 1,
      worktrees: {},
      'wt-flat': { specId: 'Y' },
    });
    const before = readWorktreesJsonBytes(cawsDir);

    const realRun = runCli(repo, ['worktree', 'migrate-registry']);
    const dryRun = runCli(repo, ['worktree', 'migrate-registry', '--dry-run']);

    expect(dryRun.code).toBe(realRun.code);
    expect(dryRun.code).toBe(1);
    expect(readWorktreesJsonBytes(cawsDir)).toBe(before);
  });

  test('already-flat: dry-run is identical to real run (both no-op, no write)', () => {
    writeRegistry(cawsDir, { 'wt-a': { specId: 'A' } });
    const before = readWorktreesJsonBytes(cawsDir);

    const realRun = runCli(repo, ['worktree', 'migrate-registry']);
    expect(realRun.code).toBe(0);
    expect(readWorktreesJsonBytes(cawsDir)).toBe(before);

    const dryRun = runCli(repo, ['worktree', 'migrate-registry', '--dry-run']);
    expect(dryRun.code).toBe(0);
    expect(readWorktreesJsonBytes(cawsDir)).toBe(before);
  });
});

// ---- --data structured output --------------------------------------------

describe('caws worktree migrate-registry --data: structured output', () => {
  let repo;
  let cawsDir;

  beforeEach(() => {
    repo = mkRepo('caws-migrate-data-');
    cawsDir = makeCawsLayout(repo);
  });

  afterEach(() => rmrf(repo));

  test('apply path: --data emits parseable JSON with decisions array', () => {
    writeRegistry(cawsDir, {
      version: 1,
      worktrees: {
        'wt-d': { specId: 'X', status: 'destroyed', path: '/tmp/nope-xyz' },
      },
    });

    const r = runCli(repo, ['worktree', 'migrate-registry', '--dry-run', '--data']);
    expect(r.code).toBe(0);
    // Find a JSON object in stdout; the report text precedes it.
    const jsonStart = r.stdout.indexOf('{\n');
    expect(jsonStart).toBeGreaterThan(-1);
    const payload = JSON.parse(r.stdout.slice(jsonStart));
    expect(payload.kind).toBe('apply');
    expect(payload.inputRecordCount).toBe(1);
    expect(payload.outputRecordCount).toBe(0);
    expect(payload.outputByteLength).toBe(3);
    expect(Array.isArray(payload.decisions)).toBe(true);
    expect(payload.decisions[0]).toMatchObject({
      record: 'wt-d',
      omit: true,
      reason: 'destroyed_safe_to_omit',
    });
  });

  test('refusal path: --data emits structured diagnostic via stderr', () => {
    writeRegistry(cawsDir, {
      version: 1,
      worktrees: {
        'wt-d': { specId: 'X', status: 'destroyed', path: '/tmp/nope-xyz' },
      },
    });
    writeSpec(cawsDir, 'CLAIMER-1', { worktree: 'wt-d' });

    const r = runCli(repo, ['worktree', 'migrate-registry', '--data']);
    expect(r.code).toBe(1);
    // The data block lands in stderr for refusal paths (matches the
    // existing --data convention on other worktree subcommands).
    const jsonStart = r.stderr.indexOf('{\n');
    expect(jsonStart).toBeGreaterThan(-1);
    const payload = JSON.parse(r.stderr.slice(jsonStart));
    expect(payload.kind).toBe('refuse');
    expect(payload.reason).toBe('destroyed_blocked');
    expect(payload.diagnostic).toBeDefined();
    expect(payload.decisions[0]).toMatchObject({
      omit: false,
      reason: 'spec_claims',
    });
  });

  test('no_op path: --data emits compact no_op shape', () => {
    writeRegistry(cawsDir, { 'wt-a': { specId: 'A' } });

    const r = runCli(repo, ['worktree', 'migrate-registry', '--data']);
    expect(r.code).toBe(0);
    const jsonStart = r.stdout.indexOf('{\n');
    expect(jsonStart).toBeGreaterThan(-1);
    const payload = JSON.parse(r.stdout.slice(jsonStart));
    expect(payload).toMatchObject({
      kind: 'no_op',
      reason: 'already_flat',
      recordCount: 1,
    });
  });
});

// ---- events.jsonl byte-stability (A9 + A11) -------------------------------

describe('caws worktree migrate-registry: events.jsonl byte-stability', () => {
  let repo;
  let cawsDir;

  beforeEach(() => {
    repo = mkRepo('caws-migrate-events-');
    cawsDir = makeCawsLayout(repo);
    // Seed events.jsonl with a chained line to make the comparison
    // meaningful (empty-string equality is trivially true).
    const seed =
      JSON.stringify({
        event: 'spec_created',
        ts: '2026-05-22T00:00:00.000Z',
        actor: { kind: 'system', id: 'test-seed' },
        spec_id: 'SEED-001',
        data: { title: 'seed', risk_tier: 3, mode: 'chore', lifecycle_state: 'active' },
        seq: 1,
        prev_hash: null,
        hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      }) + '\n';
    fs.writeFileSync(path.join(cawsDir, 'events.jsonl'), seed);
  });

  afterEach(() => rmrf(repo));

  test('apply: events.jsonl byte-equal pre/post', () => {
    writeRegistry(cawsDir, {
      version: 1,
      worktrees: { 'wt-a': { specId: 'A', status: 'active' } },
    });
    const before = readEventsJsonl(cawsDir);
    expect(before.length).toBeGreaterThan(0);

    const r = runCli(repo, ['worktree', 'migrate-registry']);
    expect(r.code).toBe(0);

    expect(readEventsJsonl(cawsDir)).toBe(before);
  });

  test('refusal (destroyed_blocked): events.jsonl byte-equal pre/post', () => {
    writeRegistry(cawsDir, {
      version: 1,
      worktrees: {
        'wt-d': { specId: 'X', status: 'destroyed', path: '/tmp/nope' },
      },
    });
    writeSpec(cawsDir, 'CLAIMER-1', { worktree: 'wt-d' });
    const before = readEventsJsonl(cawsDir);

    const r = runCli(repo, ['worktree', 'migrate-registry']);
    expect(r.code).toBe(1);
    expect(readEventsJsonl(cawsDir)).toBe(before);
  });

  test('refusal (mixed_shape): events.jsonl byte-equal pre/post', () => {
    writeRegistry(cawsDir, {
      version: 1,
      worktrees: {},
      'wt-flat': { specId: 'Y' },
    });
    const before = readEventsJsonl(cawsDir);

    const r = runCli(repo, ['worktree', 'migrate-registry']);
    expect(r.code).toBe(1);
    expect(readEventsJsonl(cawsDir)).toBe(before);
  });

  test('already-flat no-op: events.jsonl byte-equal pre/post', () => {
    writeRegistry(cawsDir, { 'wt-a': { specId: 'A' } });
    const before = readEventsJsonl(cawsDir);

    const r = runCli(repo, ['worktree', 'migrate-registry']);
    expect(r.code).toBe(0);
    expect(readEventsJsonl(cawsDir)).toBe(before);
  });

  test('dry-run: events.jsonl byte-equal pre/post', () => {
    writeRegistry(cawsDir, {
      version: 1,
      worktrees: { 'wt-a': { specId: 'A', status: 'active' } },
    });
    const before = readEventsJsonl(cawsDir);

    const r = runCli(repo, ['worktree', 'migrate-registry', '--dry-run']);
    expect(r.code).toBe(0);
    expect(readEventsJsonl(cawsDir)).toBe(before);
  });
});
