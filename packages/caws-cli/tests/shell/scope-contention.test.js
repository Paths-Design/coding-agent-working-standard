'use strict';

/**
 * Integration tests for `caws scope contention <path>`
 * (CAWS-SCOPE-CONTENTION-CMD-001).
 *
 * Drives runScopeContentionCommand against a real temp .caws (specs +
 * worktrees.json flat-map + materialized worktree dirs), with the current
 * branch injected, and asserts the rendered JSON contract. This exercises the
 * full snapshot→kernel→render wiring the worktree-write-guard hook depends on;
 * the kernel matcher itself is unit-tested separately in caws-kernel.
 *
 * SUT loaded from dist/.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { runScopeContentionCommand } = require('../../dist/shell/index');
const { initProject } = require('../../dist/store/init-store');
const { createSpec } = require('../../dist/store/specs-writer');
const { createWorktree } = require('../../dist/store/worktrees-writer');

const repos = [];
afterAll(() => {
  for (const r of repos) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-contention-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  repos.push(root);
  const r = initProject(root);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  return { root, caws: path.join(root, '.caws') };
}

function writeSpec(caws, id, scopeIn, { state = 'active', worktree } = {}) {
  const wtLine = worktree !== undefined ? `worktree: ${worktree}\n` : '';
  const resolutionLine =
    state === 'closed' || state === 'archived' ? 'resolution: superseded\n' : '';
  const inLines = scopeIn.map((p) => `    - ${p}`).join('\n');
  const body = `id: ${id}
title: 'Contention fixture spec'
risk_tier: 3
mode: chore
lifecycle_state: ${state}
${resolutionLine}${wtLine}created_at: '2026-06-15T00:00:00.000Z'
updated_at: '2026-06-15T00:00:00.000Z'
blast_radius:
  modules:
    - tests
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
${inLines}
  out: []
invariants:
  - 'fixture spec'
acceptance:
  - id: A1
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional:
  reliability:
    - 'fixture'
contracts: []
`;
  fs.writeFileSync(path.join(caws, 'specs', `${id}.yaml`), body);
}

function writeRegistry(caws, entries) {
  fs.writeFileSync(path.join(caws, 'worktrees.json'), JSON.stringify(entries, null, 2) + '\n');
}

function makeWorktreeDir(caws, name) {
  fs.mkdirSync(path.join(caws, 'worktrees', name), { recursive: true });
}

/** Run the command, capturing the single JSON line it prints. */
function runJson(repoRoot, p) {
  const lines = [];
  const code = runScopeContentionCommand({
    path: p,
    cwd: repoRoot,
    json: true,
    out: (s) => lines.push(s),
    err: () => {},
    currentBranch: () => 'main',
  });
  return { code, json: JSON.parse(lines.join('\n')) };
}

describe('caws scope contention --json: claim detection (A4)', () => {
  test('a path another active worktree spec claims -> status claimed with the claimant', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'OWNER-001', ['packages/owned'], { worktree: 'wt-owner' });
    makeWorktreeDir(caws, 'wt-owner');
    writeRegistry(caws, {
      'wt-owner': {
        specId: 'OWNER-001',
        baseBranch: 'main',
        path: path.join(caws, 'worktrees', 'wt-owner'),
      },
    });

    const { code, json } = runJson(root, 'packages/owned/file.ts');
    expect(code).toBe(0);
    expect(json.status).toBe('claimed');
    expect(json.claimants).toEqual([
      { worktreeName: 'wt-owner', specId: 'OWNER-001', matchedPattern: 'packages/owned' },
    ]);
  });

  test('a path no active worktree claims -> status clear, empty claimants', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'OWNER-001', ['packages/owned'], { worktree: 'wt-owner' });
    makeWorktreeDir(caws, 'wt-owner');
    writeRegistry(caws, {
      'wt-owner': {
        specId: 'OWNER-001',
        baseBranch: 'main',
        path: path.join(caws, 'worktrees', 'wt-owner'),
      },
    });

    const { json } = runJson(root, 'packages/unrelated/file.ts');
    expect(json.status).toBe('clear');
    expect(json.claimants).toEqual([]);
  });

  test('a closed spec does not claim (status clear)', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'OLD-001', ['packages/owned'], { state: 'closed', worktree: 'wt-old' });
    makeWorktreeDir(caws, 'wt-old');
    writeRegistry(caws, {
      'wt-old': {
        specId: 'OLD-001',
        baseBranch: 'main',
        path: path.join(caws, 'worktrees', 'wt-old'),
      },
    });

    const { json } = runJson(root, 'packages/owned/file.ts');
    expect(json.status).toBe('clear');
  });
});

describe('caws scope contention --json: fail-closed undetermined (A3 at the CLI layer)', () => {
  test('a registry entry with no specId -> status undetermined, NOT clear', () => {
    const { root, caws } = mkRepo();
    makeWorktreeDir(caws, 'wt-nospec');
    writeRegistry(caws, {
      'wt-nospec': { baseBranch: 'main', path: path.join(caws, 'worktrees', 'wt-nospec') },
    });

    const { json } = runJson(root, 'packages/owned/file.ts');
    expect(json.status).toBe('undetermined');
    expect(json.reason).toBe('missing-specId');
  });
});

describe('caws scope contention: the renderer does not re-parse spec YAML', () => {
  test('the command source contains no js-yaml / yaml.load (reads the store snapshot)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'shell', 'commands', 'scope.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/require\(['"]js-yaml['"]\)/);
    expect(src).not.toMatch(/yaml\.load/);
  });
});

describe('actual CLI contention parser failure reaches the source guard', () => {
  test.each([
    ['tests/owned.ts', 2],
    ['docs/owned.md', 0],
  ])('%s preserves its existing unknown-observation policy', (target, expectedExit) => {
    const { root, caws } = mkRepo();
    const privateTools = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-contention-tools-'));
    repos.push(privateTools);
    const cli = path.resolve(__dirname, '../../dist/index.js');
    const shared = path.resolve(__dirname, '../../templates/hook-packs/shared');
    const guard = path.join(shared, 'worktree-write-guard.sh');
    const session = { session_id: 'contention-error-fixture', platform: 'jest' };
    const actor = { kind: 'agent', id: 'contention-error-fixture', session_id: session.session_id };
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    // Private Git fixtures only: save initProject's files before lifecycle writers run.
    git('add', '-A');
    git('commit', '--quiet', '-m', 'fixture governance');
    const seedLane = (id, name, scopeIn) => {
      const seeded = createSpec(caws, {
        id,
        title: 'contention fixture',
        mode: 'chore',
        actor,
        scopeIn,
      });
      expect(seeded.ok).toBe(true);
      expect(seeded.value.kind).toBe('success');
      const created = createWorktree(caws, { name, specId: id, session, actor });
      expect(created.ok).toBe(true);
      expect(created.value.kind).toBe('success');
    };
    seedLane('CONTENTION-VALID-001', 'wt-valid', ['tests', 'docs']);
    const env = {
      ...process.env,
      HOME: privateTools,
      CAWS_HOME: path.join(privateTools, '.caws'),
      CAWS_PROJECT_DIR: root,
      CAWS_HOOKS_DIR: shared,
      CAWS_SHARED_LIB_DIR: path.join(shared, 'lib'),
      CAWS_AGENT_SURFACE: 'claude-code',
      CAWS_MACHINE_RUNTIME: '',
      CAWS_SESSION_ID: session.session_id,
      HOOK_CWD: root,
      CAWS_GUARD_NO_ASK: '1',
      PATH: privateTools + path.delimiter + process.env.PATH,
    };
    const runCli = () =>
      spawnSync(process.execPath, [cli, 'scope', 'contention', target, '--json'], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 15000,
      });
    const working = runCli();
    expect(working.status).toBe(0);
    expect(JSON.parse(working.stdout).claimants).toEqual([
      {
        worktreeName: 'wt-valid',
        specId: 'CONTENTION-VALID-001',
        matchedPattern: target.split('/')[0],
      },
    ]);
    seedLane('CONTENTION-OVERSIZED-002', 'wt-oversized', ['[' + 'a'.repeat(65536)]);
    const failed = runCli();
    expect(failed.status).toBe(1);
    const error = JSON.parse(failed.stdout);
    expect(error.success).toBe(false);
    expect(error.error.message).toBe('Input length: 65537, exceeds maximum allowed length: 65536');
    // This shim forwards every argument to the actual compiled CLI. It fabricates
    // neither a permission verdict nor a contention error for the guard.
    const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    fs.writeFileSync(
      path.join(privateTools, 'caws'),
      '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(cli) + ' "$@"\n',
      { mode: 0o755 }
    );
    const refsBefore = git('show-ref');
    const registryBefore = fs.readFileSync(path.join(caws, 'worktrees.json'), 'utf8');
    const eventsBefore = fs.readFileSync(path.join(caws, 'events.jsonl'), 'utf8');
    const guarded = spawnSync('bash', [guard], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 15000,
      input: JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: target },
        cwd: root,
        session_id: session.session_id,
        permission_mode: 'default',
      }),
    });
    expect(guarded.status).toBe(expectedExit);
    expect(guarded.stdout).toBe('');
    if (expectedExit === 2) {
      expect(guarded.stderr).toContain('Scope contention undetermined (unknown:caws-failed)');
      expect(guarded.stderr).toContain('ask-incapable harness');
    } else {
      expect(guarded.stderr).not.toContain('BLOCKED');
    }
    expect(guarded.stderr).not.toContain("No active worktree's scope.in claims this file");
    expect(git('show-ref')).toBe(refsBefore);
    expect(fs.readFileSync(path.join(caws, 'worktrees.json'), 'utf8')).toBe(registryBefore);
    expect(fs.readFileSync(path.join(caws, 'events.jsonl'), 'utf8')).toBe(eventsBefore);
    expect(fs.existsSync(path.join(root, target))).toBe(false);
  });
});
