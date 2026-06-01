/**
 * @fileoverview HOOK-GUARD-LEGIBILITY-001 — CAWS guards self-identify and print
 * a literal remediation, so a first-timer (agent or human) does not mistake
 * correct governance for a generic harness prompt and dismiss it.
 *
 * The caws-firsttime-probe run-003 proved every write/exec guard layer was
 * reachable and correct, yet the probing agent mis-attributed the scope-ask to
 * the Claude Code harness THREE times because the message never named the guard
 * or the fix. This slice changes message TEXT only — no decision, exit code, or
 * latch/strike transition changes.
 *
 *   A1  scope-guard: an out-of-scope.in write (authoritative bound spec) emits a
 *       reason that (a) leads with "CAWS scope-guard" and (b) contains the
 *       literal `caws specs amend-scope <spec-id> --add <path>` remediation.
 *   A2  worktree-write-guard claimed hard block: covered by
 *       worktree_guard_ask_redirect.test.js A3 (self-id + session-context).
 *   A4  block-dangerous: a catastrophic deny latch reason leads with
 *       "CAWS command-safety", scopes the latch to MUTATING/capability-risk
 *       commands (NOT "every Bash call"), and notes read-only + reset run.
 *   HELPER  lib/guard-message.sh functions produce the expected tokens.
 *
 * Strategy mirrors the sibling hook-pack tests: copy the shipped template
 * scripts + lib (INCLUDING the new guard-message.sh) into an isolated mktemp
 * project and drive each guard as a real subprocess. The OS tempdir is used so
 * the harness never shells a dangerous command against a named path.
 *
 * @author @darianrosebrook
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PACK = path.join(
  REPO_ROOT,
  'packages',
  'caws-cli',
  'templates',
  'hook-packs',
  'claude-code'
);

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r;
}

// ── scope-guard harness ────────────────────────────────────────────────────
// scope-guard derives the bound worktree NAME from a WORK_DIR that ends in
// `/.caws/worktrees/<name>`; authoritative mode (single bound spec) only kicks
// in then. So the fixture builds the project where the working checkout lives
// at `<root>/.caws/worktrees/<name>` and seeds that checkout's own .caws/specs
// + worktrees.json. Returns { wtDir, name, specsBase } — the guard is invoked
// with CLAUDE_PROJECT_DIR + cwd = wtDir so worktreeName resolves.
function makeScopeWorktree(specId) {
  const name = `${specId}-wt`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-glib-'));
  const wtDir = path.join(root, '.caws', 'worktrees', name);
  fs.mkdirSync(wtDir, { recursive: true });
  sh('git', ['init', '-q', '-b', 'main'], wtDir);
  sh('git', ['config', 'user.email', 'test@example.com'], wtDir);
  sh('git', ['config', 'user.name', 'test'], wtDir);
  fs.mkdirSync(path.join(wtDir, '.claude', 'hooks', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(wtDir, '.claude', 'logs'), { recursive: true });
  for (const f of ['scope-guard.sh', 'guard-strikes.sh', 'runtime-paths.sh']) {
    fs.copyFileSync(path.join(PACK, f), path.join(wtDir, '.claude', 'hooks', f));
  }
  // INCLUDING guard-message.sh — the new legibility helper this slice adds.
  for (const f of ['parse-input.sh', 'caws-state.sh', 'emit.sh', 'guard-message.sh']) {
    fs.copyFileSync(path.join(PACK, 'lib', f), path.join(wtDir, '.claude', 'hooks', 'lib', f));
  }
  fs.mkdirSync(path.join(wtDir, '.caws', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(wtDir, 'packages', 'caws-cli', 'src'), { recursive: true });
  fs.writeFileSync(path.join(wtDir, 'README.md'), '# fixture\n');
  sh('git', ['add', '-A'], wtDir);
  sh('git', ['commit', '-qm', 'init'], wtDir);
  return { root, wtDir, name };
}

function writeScopeSpec(wtDir, id, scopeIn) {
  const lines = [
    `id: ${id}`,
    `title: '${id} fixture'`,
    'risk_tier: 3',
    'mode: refactor',
    'lifecycle_state: active',
    `worktree: ${id}-wt`,
    'scope:',
    '  in:',
    ...scopeIn.map((p) => `    - ${p}`),
    '  out:',
  ];
  fs.writeFileSync(path.join(wtDir, '.caws', 'specs', `${id}.yaml`), lines.join('\n') + '\n');
}

// Seed the worktree's own worktrees.json so the (PROJECT_DIR=wtDir) registry
// read maps <name> → <specId>, making the guard treat this checkout as the
// authoritative bound worktree (mode: authoritative).
function bindWorktree(wtDir, name, specId) {
  fs.writeFileSync(
    path.join(wtDir, '.caws', 'worktrees.json'),
    JSON.stringify(
      { [name]: { path: wtDir, branch: 'main', baseBranch: 'main', spec_id: specId } },
      null,
      2
    )
  );
}

function runScopeGuard(wtDir, relFile) {
  const input = JSON.stringify({
    tool_name: 'Edit',
    tool_input: { file_path: path.join(wtDir, relFile) },
    cwd: wtDir,
    session_id: 'glib-session',
  });
  return spawnSync(
    'bash',
    [path.join(wtDir, '.claude', 'hooks', 'scope-guard.sh')],
    {
      input,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: wtDir },
    }
  );
}


// ── block-dangerous harness ────────────────────────────────────────────────
function makeLatchProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-glib-latch-'));
  fs.mkdirSync(path.join(dir, '.claude', 'hooks', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude', 'logs'), { recursive: true });
  for (const f of ['block-dangerous.sh', 'reset-danger-latch.sh', 'classify_command.py']) {
    fs.copyFileSync(path.join(PACK, f), path.join(dir, '.claude', 'hooks', f));
  }
  for (const f of ['caws-state.sh', 'emit.sh', 'guard-message.sh']) {
    fs.copyFileSync(path.join(PACK, 'lib', f), path.join(dir, '.claude', 'hooks', 'lib', f));
  }
  return dir;
}

function block(dir, command, sessionId) {
  return spawnSync('bash', [path.join(dir, '.claude', 'hooks', 'block-dangerous.sh')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: sessionId }),
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
}

function blockReason(stdout) {
  try {
    const j = JSON.parse(stdout);
    // deny emits { decision: "block", reason }
    return j?.decision === 'block' ? j.reason || '' : null;
  } catch {
    return null;
  }
}

describe('HOOK-GUARD-LEGIBILITY-001', () => {
  const cleanups = [];
  afterEach(() => {
    while (cleanups.length) {
      const d = cleanups.pop();
      if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  // ── A1: scope-guard names itself + prints the literal amend-scope command ──
  test('A1: out-of-scope write → reason leads with "CAWS scope-guard" and prints amend-scope <id> --add <path>', () => {
    const { root, wtDir } = makeScopeWorktree('GLIB-001');
    cleanups.push(root);
    writeScopeSpec(wtDir, 'GLIB-001', ['packages/caws-cli/src/inscope.ts']);
    bindWorktree(wtDir, 'GLIB-001-wt', 'GLIB-001');

    // Edit a file NOT in scope.in. Strike 1 emits a progression message (warn)
    // and exits 0; the reason content is what we assert. The combined hook
    // output (stdout JSON reason OR stderr) must carry the identity +
    // remediation regardless of strike level / envelope shape.
    const rel = 'packages/caws-cli/src/outofscope.ts';
    const r1 = runScopeGuard(wtDir, rel);
    const combined = `${r1.stdout}\n${r1.stderr}`;
    expect(combined).toContain('CAWS scope-guard');
    // Authoritative mode resolved the bound spec id → literal copy-pasteable fix.
    expect(combined).toContain('caws specs amend-scope GLIB-001 --add');
    expect(combined).toContain(rel);
    // Self-disambiguation from the harness.
    expect(combined).toMatch(/not a Claude Code harness prompt/i);
    // No stray bash syntax error leaked from the node command substitution.
    expect(combined).not.toMatch(/syntax error/i);
  });

  // ── A1b: an IN-scope write stays silent (no regression, no false identity) ──
  test('A1b: in-scope write is admitted silently (exit 0, no scope-guard message)', () => {
    const { root, wtDir } = makeScopeWorktree('GLIB-002');
    cleanups.push(root);
    writeScopeSpec(wtDir, 'GLIB-002', ['packages/caws-cli/src/inscope.ts']);
    bindWorktree(wtDir, 'GLIB-002-wt', 'GLIB-002');

    const r = runScopeGuard(wtDir, 'packages/caws-cli/src/inscope.ts');
    expect(r.status).toBe(0);
    const combined = `${r.stdout}\n${r.stderr}`;
    expect(combined).not.toContain('CAWS scope-guard strike');
  });

  // ── A4: catastrophic deny latch reason — identity + scoped blast radius ──
  test('A4: deny latch reason leads with "CAWS command-safety", scopes latch to mutating/capability-risk (NOT every Bash call)', () => {
    const dir = makeLatchProject();
    cleanups.push(dir);
    // mkfs is a deny-class command — latches IMMEDIATELY (no warn grace).
    const r = block(dir, 'mkfs.ext4 /dev/sda1', 'glib-latch-session');
    const reason = blockReason(r.stdout);
    expect(reason).not.toBeNull();
    expect(reason).toContain('CAWS command-safety');
    // The corrected wording: scoped to mutating/capability-risk, with the
    // read-only + reset carve-out stated — NOT "every subsequent Bash call".
    expect(reason).toMatch(/MUTATING \/ capability-risk Bash commands will block/i);
    expect(reason).toMatch(/read-only commands.*and the reset itself still run/i);
    expect(reason).not.toMatch(/every subsequent Bash call will be blocked/i);
    // The catastrophic-vs-confirm distinction is preserved.
    expect(reason).toMatch(/HARD BLOCK \(catastrophic deny\)/i);
  });

  // ── HELPER: the shared guard-message.sh functions produce stable tokens ──
  test('HELPER: guard-message.sh emits stable identity + amend-scope + not-harness strings', () => {
    const lib = path.join(PACK, 'lib', 'guard-message.sh');
    const script = `
      source '${lib}'
      printf 'ID=[%s]\\n' "$(guard_identity scope-guard)"
      printf 'HINT=[%s]\\n' "$(guard_amend_scope_hint MY-SPEC-001 path/to/file.ts)"
      printf 'HINT_EMPTY=[%s]\\n' "$(guard_amend_scope_hint '' path/to/file.ts)"
      printf 'NOTE=[%s]\\n' "$(guard_not_harness_note)"
    `;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 5000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ID=[CAWS scope-guard]');
    expect(r.stdout).toContain('HINT=[caws specs amend-scope MY-SPEC-001 --add path/to/file.ts]');
    // Unknown spec id falls back to a clear placeholder, never an empty flag.
    expect(r.stdout).toContain('HINT_EMPTY=[caws specs amend-scope <spec-id> --add path/to/file.ts]');
    expect(r.stdout).toMatch(/NOTE=\[.*not a Claude Code harness prompt.*\]/i);
  });

  // ── HELPER: double-sourcing is a no-op (guarded) ──
  test('HELPER: guard-message.sh is safe to source twice', () => {
    const lib = path.join(PACK, 'lib', 'guard-message.sh');
    const r = spawnSync(
      'bash',
      ['-c', `source '${lib}'; source '${lib}'; guard_identity command-safety`],
      { encoding: 'utf8', timeout: 5000 }
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('CAWS command-safety');
  });
});
