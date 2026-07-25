'use strict';

// Pins the agent-facing RECOVERY PATH surfaces against the v11 reset-script
// location. The strike/latch reset scripts live under the CAWS vendored hooks
// tree (.caws/hooks/), NOT under the harness vendor dir (.claude/hooks/).
//
// Why this test exists: an agent is (correctly) forbidden from clearing its own
// strikes or danger latch, so it must hand a command to a human. Every surface
// that names that command is a recovery path for a HARD BLOCK. When the path is
// wrong, both the agent and the human are stuck holding a command that does not
// resolve — which is how a correct guard becomes an unrecoverable block.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.resolve(__dirname, '..', '..');

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: PKG_ROOT,
    encoding: 'utf8',
  }).trim();
}

const ROOT = repoRoot();

// Surfaces an agent reads: session-start doctrine, the scope-discipline guide,
// the hook READMEs, and the templates SHIPPED to every consumer project.
const AGENT_FACING_SURFACES = [
  'CLAUDE.md',
  'docs/agents/scope-discipline.md',
  '.claude/hooks/README.md',
  'packages/caws-cli/templates/CLAUDE.md',
  'packages/caws-cli/templates/hook-packs/claude-code/README.md',
];

function readSurface(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('agent-facing reset-script recovery paths', () => {
  test.each(AGENT_FACING_SURFACES)(
    '%s does not name the non-existent .claude/hooks/ reset scripts',
    (rel) => {
      const body = readSurface(rel);
      const offenders = body
        .split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => /\.claude\/hooks\/reset-/.test(line));

      expect(offenders.map(([n, l]) => `${rel}:${n}: ${l.trim()}`)).toEqual([]);
    }
  );

  test('the reset scripts actually live where the docs now point', () => {
    for (const script of ['reset-strikes.sh', 'reset-danger-latch.sh']) {
      expect(fs.existsSync(path.join(ROOT, '.caws', 'hooks', script))).toBe(true);
      // The path the docs used to name must remain absent — if a future change
      // ever creates it, this test's premise (and the doc fix) needs revisiting
      // rather than silently passing.
      expect(fs.existsSync(path.join(ROOT, '.claude', 'hooks', script))).toBe(false);
    }
  });
});

describe('guard remediation text resolves to a real script', () => {
  // The shared hook templates are what ship to consumers. They interpolate a
  // hooks dir at render time; that variable must resolve to the CAWS hooks
  // tree, not the harness vendor dir (which differs per surface: .claude,
  // .codex, .cursor, .windsurf, .opencode, .zcode).
  const SHARED = path.join(
    ROOT,
    'packages/caws-cli/templates/hook-packs/shared'
  );

  const GUARDS_WITH_RESET_REMEDIATION = [
    'scope-guard.sh',
    'protected-paths.sh',
    'block-dangerous.sh',
    'guard-strikes.sh',
  ];

  test.each(GUARDS_WITH_RESET_REMEDIATION)(
    '%s does not build a reset path from the vendor dir',
    (script) => {
      const body = fs.readFileSync(path.join(SHARED, script), 'utf8');
      const offenders = body
        .split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) =>
          /\$\{?CAWS_VENDOR_DIR\}?\/hooks\/reset-/.test(line)
        );

      expect(offenders.map(([n, l]) => `${script}:${n}: ${l.trim()}`)).toEqual(
        []
      );
    }
  );

  test('agent-surface.sh exports a CAWS_HOOKS_DIR for remediation text', () => {
    const body = fs.readFileSync(
      path.join(SHARED, 'lib', 'agent-surface.sh'),
      'utf8'
    );
    expect(body).toMatch(/export .*\bCAWS_HOOKS_DIR\b/);
  });
});

describe('ownership remediation names a caws claim shape the CLI accepts', () => {
  // `caws claim` takes NO positional argument — it resolves the worktree from
  // cwd. A remediation that prints `caws claim <name> --takeover` is worse than
  // an error: the name is silently ignored, the command evaluates against the
  // wrong directory, and the agent is told about a cwd it was never asked to
  // change. Any text handing the agent a claim command must pair it with the cd.
  const CLAIM_SITES = [
    'packages/caws-cli/templates/hook-packs/shared/bash-write-guard.sh',
    'packages/caws-cli/templates/hook-packs/shared/worktree-write-guard.sh',
    'packages/caws-cli/src/store/worktrees-writer.ts',
  ];

  test.each(CLAIM_SITES)('%s does not print a positional-arg claim', (rel) => {
    const body = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const offenders = body
      .split('\n')
      .map((line, i) => [i + 1, line])
      // `caws claim` followed by anything that is not immediately a flag or a
      // shell/string terminator — i.e. a positional worktree name.
      .filter(([, line]) => /caws claim\s+(?!--)['"$\w]/.test(line));

    expect(offenders.map(([n, l]) => `${rel}:${n}: ${l.trim()}`)).toEqual([]);
  });

  test.each(CLAIM_SITES)('%s pairs the claim with a cd into the worktree', (rel) => {
    const body = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const claimLines = body
      .split('\n')
      .filter((line) => /caws claim/.test(line) && /--takeover/.test(line));

    // Guard against a vacuous pass: if the remediation text ever moves or is
    // reworded away, this test must fail rather than silently assert nothing.
    expect(claimLines.length).toBeGreaterThan(0);
    for (const line of claimLines) {
      expect(line).toMatch(/cd .*\.caws\/worktrees\//);
    }
  });
});

describe('reset-danger-latch resolves its state dir independently of cwd', () => {
  // CAWS-RESET-LATCH-CWD-DEPENDENT-LOOKUP-001. agent-surface.sh sets
  // CAWS_PROJECT_DIR="." when it cannot resolve an absolute root, and a
  // `${CAWS_PROJECT_DIR:-<abs fallback>}` expansion does NOT rescue that — "."
  // is non-empty, so `:-` never fires. STATE_DIR then resolved against whatever
  // cwd the human happened to be standing in: the script reported "nothing to
  // clear" and exited 0 while the latch was still armed. That is the worst
  // failure shape for a recovery path — indistinguishable from a real reset,
  // so the operator stays hard-blocked believing they are unblocked.
  //
  // These tests run the SHIPPED template in an install-shaped fixture from a
  // foreign cwd, because the defect only appears when cwd != project root.

  const os = require('os');

  const TEMPLATE = path.join(
    ROOT,
    'packages/caws-cli/templates/hook-packs/shared/reset-danger-latch.sh'
  );

  /**
   * Materialize <fixture>/.caws/hooks/{reset-danger-latch.sh,lib/} plus the
   * vendor state dir, mirroring a real install so SCRIPT_DIR/../.. is the
   * fixture root. Returns the fixture paths.
   */
  function installFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-latch-'));
    const hooksDir = path.join(root, '.caws', 'hooks');
    const stateDir = path.join(root, '.claude', 'hooks', 'state');
    fs.mkdirSync(path.join(hooksDir, 'lib'), { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(root, '.claude', 'logs'), { recursive: true });

    fs.copyFileSync(TEMPLATE, path.join(hooksDir, 'reset-danger-latch.sh'));
    const libSrc = path.join(ROOT, '.caws', 'hooks', 'lib');
    for (const f of fs.readdirSync(libSrc).filter((f) => f.endsWith('.sh'))) {
      fs.copyFileSync(path.join(libSrc, f), path.join(hooksDir, 'lib', f));
    }
    return { root, script: path.join(hooksDir, 'reset-danger-latch.sh'), stateDir };
  }

  function runReset(script, session, cwd) {
    // cwd is deliberately NOT the fixture root — that is the whole point.
    return execFileSync(
      'bash',
      [script, '--session', session, '--reason', 'regression test'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  }

  test('clears a genuinely armed latch when run from a foreign cwd', () => {
    const { script, stateDir } = installFixture();
    const latch = path.join(stateDir, 'danger-latch-probe-sess.json');
    fs.writeFileSync(latch, JSON.stringify({ session: 'probe-sess' }));

    // Precondition: the latch really is armed, so a later "cleared" assertion
    // cannot pass against an empty state dir.
    expect(fs.existsSync(latch)).toBe(true);

    const out = runReset(script, 'probe-sess', os.tmpdir());

    expect(out).toMatch(/Cleared danger latch/);
    expect(fs.existsSync(latch)).toBe(false);
  });

  test('does not report a clean result without naming the directory searched', () => {
    const { script, stateDir } = installFixture();
    // No latch armed: this is the genuine not-found case.
    expect(fs.readdirSync(stateDir)).toEqual([]);

    const out = runReset(script, 'no-such-session', os.tmpdir());

    // The absolute searched path is the evidence that distinguishes "searched
    // the right tree, nothing armed" from "searched the wrong tree entirely".
    expect(out).toMatch(/searched:/);
    expect(out).toContain(stateDir);
  });

  test('the state dir is never resolved relative to cwd', () => {
    const { script, stateDir } = installFixture();
    fs.writeFileSync(
      path.join(stateDir, 'danger-latch-probe-sess.json'),
      JSON.stringify({ session: 'probe-sess' })
    );

    // Run from an unrelated directory that contains no .claude tree. Under the
    // old `${CAWS_PROJECT_DIR:-...}` expansion this searched ./.claude/... and
    // falsely reported success; it must now find the fixture's latch instead.
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-foreign-'));
    const out = runReset(script, 'probe-sess', foreign);

    expect(out).toMatch(/Cleared danger latch/);
    // No phantom state tree may be created under the operator's cwd.
    expect(fs.existsSync(path.join(foreign, '.claude'))).toBe(false);
  });
});
