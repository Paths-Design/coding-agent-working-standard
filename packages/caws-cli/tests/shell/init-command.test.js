/**
 * Tests for `caws init` (slice 7b) — vNext bootstrap of .caws/.
 *
 * Coverage targets the 11 invariants the slice spec calls out:
 *
 *   1.  init creates the canonical vNext .caws structure
 *   2.  init does NOT create working-spec.yaml
 *   3.  init's seeded policy validates through the kernel
 *   4.  init is idempotent on an already-initialized vNext project
 *   5.  init refuses legacy working-spec.yaml state with exit 1
 *   6.  init does NOT create events.jsonl
 *   7.  doctor after init has no policy-missing finding
 *   8.  status after init exits 0
 *   9.  waiver list after init exits 0 with empty message
 *  10.  registration: exactly one init command, no legacy duplicate
 *  11.  dist source-.ts leak remains 0
 *
 * Tests use the `runInitCommand` shell function directly when possible —
 * faster and deterministic. The registration test (#10) spawns the real
 * CLI binary so we know the legacy `init` truly disappeared from the
 * user-visible surface, not just inside `registerShellCommands`.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runInitCommand,
  runDoctorCommand,
  runStatusCommand,
  runWaiverListCommand,
} = require('../../dist/shell');
const { loadPolicy, loadWaivers } = require('../../dist/store');

function mkBareGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', [
    '-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init',
  ]);
  return root;
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function capture(fn, opts = {}) {
  const out = [];
  const err = [];
  const code = fn({
    ...opts,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

// ============================================================
// 1. canonical vNext structure
// ============================================================
describe('caws init — canonical layout', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('creates .caws/, specs/, waivers/, policy.yaml, worktrees.json, agents.json', () => {
    repo = mkBareGitRepo('caws-7b-canon-');
    const r = capture(runInitCommand, { cwd: repo });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/created \d+ path\(s\)/);

    // Each canonical surface exists with the expected file kind.
    expect(fs.statSync(path.join(repo, '.caws')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(repo, '.caws/specs')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(repo, '.caws/waivers')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(repo, '.caws/policy.yaml')).isFile()).toBe(true);
    expect(fs.statSync(path.join(repo, '.caws/worktrees.json')).isFile()).toBe(true);
    expect(fs.statSync(path.join(repo, '.caws/agents.json')).isFile()).toBe(true);

    // Empty registries are seeded as `{}` so JSON parsers don't see EOF.
    expect(fs.readFileSync(path.join(repo, '.caws/worktrees.json'), 'utf8').trim())
      .toBe('{}');
    expect(fs.readFileSync(path.join(repo, '.caws/agents.json'), 'utf8').trim())
      .toBe('{}');

    // Specs/waivers dirs are empty.
    expect(fs.readdirSync(path.join(repo, '.caws/specs'))).toEqual([]);
    expect(fs.readdirSync(path.join(repo, '.caws/waivers'))).toEqual([]);
  });
});

// ============================================================
// 2. NO working-spec.yaml
// ============================================================
describe('caws init — does not create legacy single-spec layout', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('does NOT create working-spec.yaml or working-spec.schema.json', () => {
    repo = mkBareGitRepo('caws-7b-no-ws-');
    const r = capture(runInitCommand, { cwd: repo });
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(repo, '.caws/working-spec.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.caws/working-spec.schema.json'))).toBe(false);
  });
});

// ============================================================
// 3. seeded policy passes kernel validation
// ============================================================
describe('caws init — seeded policy', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('seeds a policy.yaml that loadPolicy accepts cleanly', () => {
    repo = mkBareGitRepo('caws-7b-policy-');
    expect(capture(runInitCommand, { cwd: repo }).code).toBe(0);
    const pol = loadPolicy(path.join(repo, '.caws'));
    expect(pol.errors).toEqual([]);
    expect(pol.policy).toBeDefined();
    expect(pol.policy.version).toBe(1);
    // Sanity: every gate the vNext disposition layer knows about is
    // present in the seeded policy. If this list ever drifts, the
    // gates command will start producing un-policy-declared
    // ("unmatched") violations on a freshly-init'd repo.
    const gateIds = Object.keys(pol.policy.gates).sort();
    expect(gateIds).toEqual([
      'budget_limit',
      'god_object',
      'scope_boundary',
      'spec_completeness',
      'todo_detection',
    ]);
  });
});

// ============================================================
// 4. idempotent
// ============================================================
describe('caws init — idempotence', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('second invocation reports already-initialized and writes nothing', () => {
    repo = mkBareGitRepo('caws-7b-idem-');
    expect(capture(runInitCommand, { cwd: repo }).code).toBe(0);

    // Capture mtimes after the first init.
    const policyPath = path.join(repo, '.caws/policy.yaml');
    const worktreesPath = path.join(repo, '.caws/worktrees.json');
    const t1 = {
      policy: fs.statSync(policyPath).mtimeMs,
      worktrees: fs.statSync(worktreesPath).mtimeMs,
    };

    // Sleep briefly to ensure mtime resolution would catch a write.
    const r2 = capture(runInitCommand, { cwd: repo });
    expect(r2.code).toBe(0);
    expect(r2.stdout).toMatch(/already initialized/);

    const t2 = {
      policy: fs.statSync(policyPath).mtimeMs,
      worktrees: fs.statSync(worktreesPath).mtimeMs,
    };
    // Bytes-on-disk did not change → mtime is unchanged on a no-op.
    expect(t2.policy).toBe(t1.policy);
    expect(t2.worktrees).toBe(t1.worktrees);
  });

  it('partially-initialized state is filled in additively', () => {
    repo = mkBareGitRepo('caws-7b-partial-');
    // Pre-create just the cawsDir + policy. init must add the rest.
    fs.mkdirSync(path.join(repo, '.caws'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.caws/policy.yaml'),
      // Reuse the seed verbatim by re-running once (cleanup removes); we
      // can also just supply a known-good minimal policy. Easiest: do
      // a real init in a sibling dir, copy the file, then cleanup.
      // For brevity, write a known-good minimal vNext-shaped policy
      // by hand.
      [
        'version: 1',
        "risk_tiers:",
        "  '1': { max_files: 5, max_loc: 200 }",
        "  '2': { max_files: 15, max_loc: 600 }",
        "  '3': { max_files: 30, max_loc: 1500 }",
        'gates:',
        '  budget_limit:     { enabled: true, mode: block }',
        '  spec_completeness:{ enabled: true, mode: block }',
        '  scope_boundary:   { enabled: true, mode: block }',
        '',
      ].join('\n')
    );
    const r = capture(runInitCommand, { cwd: repo });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/created/);
    // The pre-existing policy.yaml is NOT in the created list.
    expect(r.stdout).not.toMatch(/policy\.yaml/);
    // But specs/, waivers/, worktrees.json, agents.json all are.
    for (const rel of ['specs', 'waivers', 'worktrees.json', 'agents.json']) {
      expect(r.stdout).toMatch(new RegExp(rel));
    }
  });
});

// ============================================================
// 5. refuses legacy working-spec.yaml
// ============================================================
describe('caws init — legacy residue refusal', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('exits 1 with INIT_LEGACY_RESIDUE when working-spec.yaml exists, and does not write anything', () => {
    repo = mkBareGitRepo('caws-7b-legacy-');
    fs.mkdirSync(path.join(repo, '.caws'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.caws/working-spec.yaml'),
      'id: LEGACY-1\ntitle: legacy\n'
    );

    const r = capture(runInitCommand, { cwd: repo });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/refusing to overwrite legacy state/);
    expect(r.stderr).toMatch(/store\.init\.legacy_residue/);
    expect(r.stderr).toMatch(/working-spec\.yaml/);

    // Init was non-destructive: nothing else was created.
    expect(fs.existsSync(path.join(repo, '.caws/specs'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.caws/waivers'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.caws/policy.yaml'))).toBe(false);
  });

  it('exits 1 when working-spec.schema.json exists', () => {
    repo = mkBareGitRepo('caws-7b-legacy-schema-');
    fs.mkdirSync(path.join(repo, '.caws'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.caws/working-spec.schema.json'),
      '{}'
    );
    const r = capture(runInitCommand, { cwd: repo });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/working-spec\.schema\.json/);
  });

  // ----------------------------------------------------------------
  // Slice 7c.1a — consistency fix
  //
  // findLegacyResidue must use isFile semantics so it agrees with
  // observeInitResidue in doctor-snapshot.ts. A *directory* at the
  // legacy path is a different problem (not yet a separately-modeled
  // rule) and must not block init when 7c.2 doctor would also stay
  // silent on it.
  // ----------------------------------------------------------------
  it('7c.1a: a DIRECTORY at .caws/working-spec.yaml does NOT trigger INIT_LEGACY_RESIDUE', () => {
    repo = mkBareGitRepo('caws-7c1a-dir-residue-');
    fs.mkdirSync(path.join(repo, '.caws/working-spec.yaml'), {
      recursive: true,
    });
    const r = capture(runInitCommand, { cwd: repo });
    // Init must succeed; it sees no FILE residue.
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/store\.init\.legacy_residue/);
    // Side-effect check: canonical layout was created.
    expect(
      fs.statSync(path.join(repo, '.caws/specs')).isDirectory()
    ).toBe(true);
    expect(
      fs.statSync(path.join(repo, '.caws/policy.yaml')).isFile()
    ).toBe(true);
  });

  it('7c.1a: a DIRECTORY at .caws/working-spec.schema.json does NOT trigger INIT_LEGACY_RESIDUE', () => {
    repo = mkBareGitRepo('caws-7c1a-dir-schema-');
    fs.mkdirSync(path.join(repo, '.caws/working-spec.schema.json'), {
      recursive: true,
    });
    const r = capture(runInitCommand, { cwd: repo });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/store\.init\.legacy_residue/);
  });

  it('7c.1a: a real FILE at .caws/working-spec.yaml STILL triggers INIT_LEGACY_RESIDUE (regression guard)', () => {
    repo = mkBareGitRepo('caws-7c1a-file-still-blocks-');
    fs.mkdirSync(path.join(repo, '.caws'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.caws/working-spec.yaml'),
      'id: LEGACY-1\n'
    );
    const r = capture(runInitCommand, { cwd: repo });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/store\.init\.legacy_residue/);
  });
});

// ============================================================
// 6. does NOT create events.jsonl
// ============================================================
describe('caws init — no events.jsonl', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('does NOT create .caws/events.jsonl (first append creates it under lock)', () => {
    repo = mkBareGitRepo('caws-7b-no-events-');
    expect(capture(runInitCommand, { cwd: repo }).code).toBe(0);
    expect(fs.existsSync(path.join(repo, '.caws/events.jsonl'))).toBe(false);
  });
});

// ============================================================
// 7. doctor after init: no policy-missing finding
// ============================================================
describe('caws init — post-init doctor smoke', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('caws doctor after init does NOT report doctor.policy.missing', () => {
    repo = mkBareGitRepo('caws-7b-doctor-');
    expect(capture(runInitCommand, { cwd: repo }).code).toBe(0);

    // doctor exits 1 when there are error findings; we only care that
    // the policy-missing one is gone. Capture stderr for inspection.
    const r = capture(runDoctorCommand, { cwd: repo });
    // After a fresh init, no error findings should fire (no specs, no
    // worktrees, no waivers, policy is loaded). Doctor exits 0.
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/doctor\.policy\.missing/);
    expect(r.stdout).not.toMatch(/doctor\.policy\.missing/);
  });
});

// ============================================================
// 8. status after init exits 0
// ============================================================
describe('caws init — post-init status smoke', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('caws status after init exits 0', () => {
    repo = mkBareGitRepo('caws-7b-status-');
    expect(capture(runInitCommand, { cwd: repo }).code).toBe(0);
    const r = capture(runStatusCommand, { cwd: repo });
    expect(r.code).toBe(0);
  });
});

// ============================================================
// 9. waiver list after init exits 0 with empty message
// ============================================================
describe('caws init — post-init waiver list smoke', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('caws waiver list after init reports no waivers, exit 0', () => {
    repo = mkBareGitRepo('caws-7b-waivers-');
    expect(capture(runInitCommand, { cwd: repo }).code).toBe(0);
    const r = capture(runWaiverListCommand, { cwd: repo, now: () => new Date() });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/No waivers in \.caws\/waivers\//);

    // Sanity: loadWaivers also sees an empty, diagnostic-clean state.
    const w = loadWaivers(path.join(repo, '.caws'));
    expect(w.diagnostics).toEqual([]);
    expect(w.waivers).toEqual([]);
  });
});

// ============================================================
// 10. registration: exactly one `init`, no legacy duplicate
// ============================================================
describe('caws init — registration surface', () => {
  // Spawn the real CLI so we see the user-visible surface.
  const cliPath = path.join(__dirname, '../../dist/index.js');

  function runHelp(args = []) {
    return execFileSync('node', [cliPath, ...args], {
      cwd: path.join(__dirname, '../..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  it('top-level help lists exactly ONE `init` command', () => {
    const help = runHelp(['--help']);
    // Match lines that begin a command listing for `init` (Commander
    // formats with two-space indent + name + space/options).
    const initLines = help
      .split('\n')
      .filter((line) => /^\s+init\b/.test(line));
    expect(initLines).toHaveLength(1);
    // It is the vNext description, not the legacy one.
    expect(initLines[0]).toMatch(/Bootstrap the canonical vNext/);
  });

  it('legacy init flags (--interactive, --mode, --ide) are no longer accepted', () => {
    // Spawn the real binary in a temp git repo and confirm Commander
    // rejects --interactive (a legacy-only flag).
    const repo = mkBareGitRepo('caws-7b-reg-flags-');
    try {
      let threw = false;
      let stderr = '';
      try {
        execFileSync('node', [cliPath, 'init', '--interactive'], {
          cwd: repo,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        threw = true;
        stderr = e.stderr ?? '';
      }
      expect(threw).toBe(true);
      expect(stderr).toMatch(/unknown option/i);
    } finally {
      rmrf(repo);
    }
  });

  it('`provenance init` subcommand remains registered (we did not touch it)', () => {
    const help = runHelp(['provenance', '--help']);
    expect(help).toMatch(/^\s+init\b/m);
  });
});

// ============================================================
// 11. dist source-.ts leak remains 0
// ============================================================
describe('caws init — dist hygiene', () => {
  it('no source .ts files leaked into packages/caws-cli/dist (only .d.ts allowed)', () => {
    const distRoot = path.join(__dirname, '../../dist');
    const offenders = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
          offenders.push(p);
        }
      }
    }
    if (fs.existsSync(distRoot)) walk(distRoot);
    expect(offenders).toEqual([]);
  });
});

// ============================================================
// 12. first-contact commit hint (CAWS-FIRST-CONTACT-UX-001 A1/A2)
// ============================================================
describe('caws init — first-contact commit hint', () => {
  let repo;
  afterEach(() => rmrf(repo));

  // A1: git repo → hint present
  it('prints a git add/commit hint when .caws/ is newly created inside a git repo', () => {
    repo = mkBareGitRepo('caws-fc-ux-git-');
    const r = capture(runInitCommand, { cwd: repo });
    expect(r.code).toBe(0);
    // The hint mentions both git verbs and the .caws/ target.
    expect(r.stdout).toMatch(/git add \.caws\//);
    expect(r.stdout).toMatch(/git commit/);
    expect(r.stdout).toMatch(/chore: add caws governance state/);
  });

  // A2: non-git tmpdir → no hint (the hint would mislead)
  it('does NOT print the git commit hint outside a git working tree', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-fc-ux-nogit-'));
    repo = tmp;
    // Confirm the fixture really has no git: rev-parse should fail.
    let isGit = false;
    try {
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: tmp,
        stdio: 'pipe',
      });
      isGit = true;
    } catch {
      isGit = false;
    }
    expect(isGit).toBe(false);

    // initProject needs a git repo for resolveRepoRoot. So this path
    // should fail with exit 2 (resolve failure), and the hint must not
    // appear in either stdout or stderr.
    const r = capture(runInitCommand, { cwd: tmp });
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).not.toMatch(/git add \.caws\//);
    expect(r.stdout + r.stderr).not.toMatch(/chore: add caws governance state/);
  });

  // A1 regression: idempotent re-run on an already-initialized repo
  // does NOT re-emit the hint (outcome === 'already_initialized').
  it('does NOT print the commit hint when init is idempotent (already_initialized)', () => {
    repo = mkBareGitRepo('caws-fc-ux-idem-');
    expect(capture(runInitCommand, { cwd: repo }).code).toBe(0);
    // Second run: already_initialized branch
    const r2 = capture(runInitCommand, { cwd: repo });
    expect(r2.code).toBe(0);
    expect(r2.stdout).toMatch(/already initialized/);
    expect(r2.stdout).not.toMatch(/git add \.caws\//);
  });
});

// ============================================================
// .gitignore ephemeral-state block (CAWS-INIT-GITIGNORE-MANAGE-001)
// ============================================================
describe('caws init — .gitignore ephemeral-state block', () => {
  let repo;
  afterEach(() => rmrf(repo));

  /** True if `p` is ignored in `repo` per real git semantics. */
  function isIgnored(repo, p) {
    try {
      execFileSync('git', ['-C', repo, 'check-ignore', '-q', '--', p]);
      return true; // exit 0 = ignored
    } catch {
      return false; // exit 1 = not ignored
    }
  }

  const BEGIN = '# >>> caws gitignore (managed';
  const END = '# <<< caws gitignore <<<';

  // A1: fresh repo, no .gitignore → created with block; ephemeral ignored,
  // authority NOT ignored.
  it('A1: creates .gitignore and ignores ephemeral state, not authority state', () => {
    repo = mkBareGitRepo('caws-gi-a1-');
    const r = capture(runInitCommand, { cwd: repo });
    expect(r.code).toBe(0);

    const gi = path.join(repo, '.gitignore');
    expect(fs.existsSync(gi)).toBe(true);
    const body = fs.readFileSync(gi, 'utf8');
    expect(body).toContain(BEGIN);
    expect(body).toContain(END);

    // Ephemeral → ignored.
    for (const p of [
      '.caws/worktrees.json',
      '.caws/agents.json',
      '.caws/leases/x.json',
      '.caws/events.jsonl',
      '.caws/worktrees/wt1',
      '.caws/cache/y',
    ]) {
      expect(isIgnored(repo, p)).toBe(true);
    }

    // Authority → NOT ignored (must stay trackable).
    for (const p of [
      '.caws/policy.yaml',
      '.caws/specs/FEAT-001.yaml',
      '.caws/waivers/W-1.json',
    ]) {
      expect(isIgnored(repo, p)).toBe(false);
    }

    expect(r.stdout).toMatch(/\.gitignore ephemeral-state block/);
  });

  // A2: existing .gitignore with user rules → block appended, user rules
  // byte-preserved, no reorder.
  it('A2: appends the block to an existing .gitignore, preserving user rules', () => {
    repo = mkBareGitRepo('caws-gi-a2-');
    const gi = path.join(repo, '.gitignore');
    const userContent = 'node_modules/\n*.log\ndist/\n';
    fs.writeFileSync(gi, userContent, 'utf8');

    const r = capture(runInitCommand, { cwd: repo });
    expect(r.code).toBe(0);

    const body = fs.readFileSync(gi, 'utf8');
    // User rules preserved verbatim at the head.
    expect(body.startsWith(userContent)).toBe(true);
    // Block appended after.
    expect(body).toContain(BEGIN);
    expect(body.indexOf('node_modules/')).toBeLessThan(body.indexOf(BEGIN));
    // User's own pattern still ignored (not clobbered).
    expect(isIgnored(repo, 'node_modules/foo')).toBe(true);
    // And ephemeral caws now ignored too.
    expect(isIgnored(repo, '.caws/agents.json')).toBe(true);
  });

  // A3: re-run → byte-identical, block not duplicated.
  it('A3: re-running init produces a byte-identical .gitignore (no duplicate block)', () => {
    repo = mkBareGitRepo('caws-gi-a3-');
    expect(capture(runInitCommand, { cwd: repo }).code).toBe(0);
    const gi = path.join(repo, '.gitignore');
    const afterFirst = fs.readFileSync(gi, 'utf8');

    const r2 = capture(runInitCommand, { cwd: repo });
    expect(r2.code).toBe(0);
    const afterSecond = fs.readFileSync(gi, 'utf8');

    expect(afterSecond).toBe(afterFirst);
    // Exactly one managed block.
    const occurrences = afterSecond.split(BEGIN).length - 1;
    expect(occurrences).toBe(1);
    expect(r2.stdout).toMatch(/already current|No change/);
  });

  // A4: stale managed block (different markers) → replaced in place; content
  // outside markers untouched.
  it('A4: replaces a stale managed block in place, preserving surrounding content', () => {
    repo = mkBareGitRepo('caws-gi-a4-');
    const gi = path.join(repo, '.gitignore');
    // Simulate an older managed block (v0 markers, stale entries) with user
    // content on both sides.
    const stale = [
      'user-top-rule/',
      '',
      '# >>> caws gitignore (managed, v0) >>>',
      '.caws/old-ephemeral-thing',
      '# <<< caws gitignore <<<',
      '',
      'user-bottom-rule/',
      '',
    ].join('\n');
    fs.writeFileSync(gi, stale, 'utf8');

    const r = capture(runInitCommand, { cwd: repo });
    expect(r.code).toBe(0);

    const body = fs.readFileSync(gi, 'utf8');
    // Surrounding user content preserved.
    expect(body).toContain('user-top-rule/');
    expect(body).toContain('user-bottom-rule/');
    // Stale entry gone; current entries present.
    expect(body).not.toContain('.caws/old-ephemeral-thing');
    expect(body).toContain('.caws/worktrees.json');
    // Still exactly one managed block.
    expect(body.split(BEGIN).length - 1).toBe(1);
    expect(isIgnored(repo, '.caws/agents.json')).toBe(true);
  });

  // A5: --adopt with no existing block → nothing written.
  it('A5: --adopt does not write a managed block', () => {
    repo = mkBareGitRepo('caws-gi-a5-');
    const r = capture(runInitCommand, { cwd: repo, adopt: true });
    expect(r.code).toBe(0);

    const gi = path.join(repo, '.gitignore');
    // Either no .gitignore, or one without the managed block.
    if (fs.existsSync(gi)) {
      expect(fs.readFileSync(gi, 'utf8')).not.toContain(BEGIN);
    }
    // Ephemeral state is therefore NOT ignored under --adopt.
    expect(isIgnored(repo, '.caws/agents.json')).toBe(false);
    expect(r.stdout).toMatch(/adopt/i);
  });

  // A3: non-git directory → init refuses at repo-root resolution (exit 2)
  // BEFORE any .caws/ or .gitignore write. caws init structurally cannot run
  // outside a git repo (resolveRepoRoot requires git), so the .gitignore step
  // is never reached — and no .gitignore is written. The step's own
  // isInsideGitWorkingTree gate is defense-in-depth for any future loosening
  // of that precondition.
  it('A3: a non-git directory is refused before any .gitignore is written', () => {
    // A plain temp dir — deliberately NOT a git repo.
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-gi-nogit-'));
    const r = capture(runInitCommand, { cwd: repo });
    // Refused at repo-root resolution (not a git repo) — exit 2.
    expect(r.code).toBe(2);
    // No .gitignore (and no .caws/) was written.
    expect(fs.existsSync(path.join(repo, '.gitignore'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.caws'))).toBe(false);
  });
});
