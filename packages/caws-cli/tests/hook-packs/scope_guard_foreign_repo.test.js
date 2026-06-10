/**
 * @fileoverview SCOPE-GUARD-FOREIGN-REPO-CONTAINMENT-001 — editing a file in a
 * DIFFERENT repo from a CAWS session is a hard block, not a misleading
 * out-of-scope strike.
 *
 * Failure this fixes (session 402602a8, turn 21): a caws-rooted session edited
 * files under a sibling repo (agent-hooks/). The scope-guard computed
 * REL_PATH = the absolute foreign path, which matched no spec's (relative)
 * scope.in, so it issued "strike 1 of 3 — out of scope" and let the first two
 * edits through (the 3-strike ramp). Two problems: (a) the message framed a
 * foreign-repo file as an amendable in-repo scope gap, and (b) two foreign
 * edits succeeded before the hard block.
 *
 * Fix: an absolute path under neither WORK_DIR nor PROJECT_DIR is a foreign
 * repo. It hard-blocks IMMEDIATELY (exit 2, no strike ramp). The sanctioned
 * escape is provenance: the absolute path admitted by a spec's scope.in passes
 * (the kernel ADMIT branch), making cross-repo edits intentional + auditable.
 *
 * Drives the shipped scope-guard as a subprocess against a real temp project.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PACK = path.join(REPO_ROOT, 'packages', 'caws-cli', 'templates', 'hook-packs', 'claude-code');

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-foreign-'));
  fs.mkdirSync(path.join(dir, '.claude', 'hooks', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude', 'hooks', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.caws', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  // Hooks-root scripts (runtime-paths.sh lives at the hooks root; parse-input.sh
  // sources it via $lib/../runtime-paths.sh).
  for (const f of ['scope-guard.sh', 'guard-strikes.sh', 'runtime-paths.sh']) {
    fs.copyFileSync(path.join(PACK, f), path.join(dir, '.claude', 'hooks', f));
  }
  for (const f of ['parse-input.sh', 'caws-state.sh', 'emit.sh', 'guard-message.sh']) {
    const s = path.join(PACK, 'lib', f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dir, '.claude', 'hooks', 'lib', f));
  }
  return dir;
}

/** Write a minimal active spec admitting the given scope.in paths. */
function writeSpec(dir, id, scopeIn) {
  const yaml =
    `id: ${id}\ntitle: test spec\nrisk_tier: 3\nmode: fix\nlifecycle_state: active\n` +
    `blast_radius:\n  modules:\n    - src\nscope:\n  in:\n` +
    scopeIn.map((p) => `    - ${JSON.stringify(p)}`).join('\n') +
    `\n  out: []\ninvariants:\n  - test\nacceptance:\n  - id: A1\n    given: g\n    when: w\n    then: t\n` +
    `non_functional: {}\ncontracts: []\n`;
  fs.writeFileSync(path.join(dir, '.caws', 'specs', `${id}.yaml`), yaml);
}

function runGuard(dir, filePath) {
  const r = spawnSync('bash', [path.join(dir, '.claude', 'hooks', 'scope-guard.sh')], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: filePath }, cwd: dir, session_id: `sf-${Math.random()}` }),
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, HOOK_CWD: dir },
  });
  let blocked = false;
  try {
    const env = JSON.parse(r.stdout);
    blocked = env.decision === 'block' || env?.hookSpecificOutput?.permissionDecision === 'deny';
  } catch { /* no envelope */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, blocked };
}

describe('SCOPE-GUARD-FOREIGN-REPO-CONTAINMENT-001', () => {
  let dir;
  let foreignDir;
  beforeEach(() => {
    dir = makeProject();
    foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-repo-'));
    fs.writeFileSync(path.join(foreignDir, 'victim.sh'), '#!/bin/bash\necho hi\n');
  });
  afterEach(() => {
    for (const d of [dir, foreignDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  });

  it('hard-blocks an edit to a file in a different repo (not a strike ramp)', () => {
    writeSpec(dir, 'FEAT-001', ['src/']);
    const r = runGuard(dir, path.join(foreignDir, 'victim.sh'));
    expect(r.blocked).toBe(true);
    expect(r.stdout).toMatch(/different repository/i);
    // It is a hard block, NOT the "strike 1 of 3" ramp.
    expect(r.stdout).not.toMatch(/strike 1 of 3/);
  });

  it('SCOPE-GUARD-FOREIGN-REPO-ALLOWPREFIX-ORDER-001: a write under $HOME/.claude/ (harness state) is NOT a foreign-repo block', () => {
    // The foreign-repo block ran before ALLOW_PREFIXES and shadowed the
    // $HOME/.claude/ allowance, blocking an agent writing its own memory.
    writeSpec(dir, 'FEAT-001', ['src/']);
    const memoryPath = path.join(os.homedir(), '.claude', 'projects', 'x', 'memory', 'note.md');
    const r = runGuard(dir, memoryPath);
    expect(r.blocked).toBe(false);
    expect(r.stdout).not.toMatch(/different repository/i);
  });

  it('the block message instructs a handoff and names the Bash bypass boundary', () => {
    writeSpec(dir, 'FEAT-001', ['src/']);
    const r = runGuard(dir, path.join(foreignDir, 'victim.sh'));
    expect(r.stdout).toMatch(/HANDOFF/);
    expect(r.stdout).toMatch(/route around this via Bash/i);
  });

  it('there is NO in-band escape — a foreign write blocks even if the path is in scope.in', () => {
    // scope.in matching is project-root-relative; an absolute foreign path can
    // never be admitted, and the design is intentionally that cross-repo writes
    // have no in-band override. Listing it in scope.in must NOT unblock.
    const victim = path.join(foreignDir, 'victim.sh');
    writeSpec(dir, 'FEAT-001', ['src/', victim]);
    const r = runGuard(dir, victim);
    expect(r.blocked).toBe(true);
    expect(r.stdout).toMatch(/different repository/i);
  });

  it('cross-repo READS are not gated (scope-guard only fires on Write/Edit)', () => {
    writeSpec(dir, 'FEAT-001', ['src/']);
    const r = spawnSync('bash', [path.join(dir, '.claude', 'hooks', 'scope-guard.sh')], {
      input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: path.join(foreignDir, 'victim.sh') }, cwd: dir, session_id: 'sf-read' }),
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, HOOK_CWD: dir },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('an in-repo out-of-scope edit is UNCHANGED (still the strike ramp, not the foreign block)', () => {
    writeSpec(dir, 'FEAT-001', ['src/allowed.ts']);
    fs.writeFileSync(path.join(dir, 'src', 'other.ts'), 'x');
    const r = runGuard(dir, path.join(dir, 'src', 'other.ts'));
    // Strike 1 proceeds (allowed) and is framed as an in-repo scope gap, NOT
    // the foreign-repo block.
    expect(r.stdout).not.toMatch(/different repository/i);
  });
});
