'use strict';

/**
 * Write-guard allowlist parity regression gate
 * (CAWS-GUARD-ALLOWLIST-SYNC-001).
 *
 * The defect this suite pins: worktree-write-guard.sh (Write/Edit) had an
 * inlined unconditional-allow list (docs/*, .caws/*, .tmp/*, .github/*, vendor
 * dir, instruction files) that exited 0 BEFORE any claim check, while
 * bash-write-guard.sh (Bash mutation) had NO allowlist — so it routed every
 * extracted Bash mutation target through the oracle and blocked docs/** paths
 * claimed by a worktree scope.in. Same path, same claim, two answers depending
 * on which tool the agent reached for. Doctrine (docs/failure-lineage.md:888)
 * says docs/ is must-permit.
 *
 * The fix: extract the allowlist into lib/write-allowlist.sh
 * (caws_is_write_allowlisted); both guards source it and consult it before the
 * oracle, so the two tools return the same allow verdict for the same path.
 *
 * This suite is the regression gate:
 *   1. The helper returns the correct allow/deny verdict for every posture
 *      path (including the CRITICAL payload exclusion).
 *   2. Both guards source the shared helper (no re-divergence by tool).
 *   3. The bash guard consults the helper BEFORE its oracle loop (the actual
 *      fix site), and the worktree guard delegates its allowlist to it.
 *
 * Bash-driven (the SUT is shell, not TS) — mirrors
 * vendor-allowlist-generalized.test.js conventions.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI_PKG_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATES = path.join(CLI_PKG_ROOT, 'templates', 'hook-packs', 'shared');
const ALLOWLIST_LIB = path.join(TEMPLATES, 'lib', 'write-allowlist.sh');
const AGENT_SURFACE = path.join(TEMPLATES, 'lib', 'agent-surface.sh');
const WT_GUARD = path.join(TEMPLATES, 'worktree-write-guard.sh');
const BASH_GUARD = path.join(TEMPLATES, 'bash-write-guard.sh');

const PROJECT_DIR = '/fake/proj';
const HOME_DIR = '/fake/home';

// Source agent-surface (for CAWS_VENDOR_DIR / CAWS_INSTRUCTION_FILES) then the
// allowlist helper, then probe a path. Returns 'ALLOW' or 'DENY'.
function probeAllow(surface, filePath, opts = {}) {
  const projectDir = opts.projectDir || PROJECT_DIR;
  const script = `
    unset _CAWS_AGENT_SURFACE_SH_LOADED
    export CAWS_AGENT_SURFACE=${JSON.stringify(surface)}
    export HOME=${JSON.stringify(HOME_DIR)}
    source ${JSON.stringify(AGENT_SURFACE)} 2>/dev/null
    source ${JSON.stringify(ALLOWLIST_LIB)}
    if caws_is_write_allowlisted ${JSON.stringify(filePath)} ${JSON.stringify(projectDir)}; then
      echo ALLOW
    else
      echo DENY
    fi
  `;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
}

describe('caws_is_write_allowlisted: unconditional-allow path set', () => {
  const cases = [
    // [path, expected, description]
    [`${PROJECT_DIR}/docs/architecture/design/foo.md`, 'ALLOW', 'docs/* (absolute)'],
    ['docs/foo.md', 'ALLOW', 'docs/* (relative)'],
    [`${PROJECT_DIR}/.caws/policy.yaml`, 'ALLOW', '.caws/* (absolute)'],
    ['.caws/specs/FEAT-1.yaml', 'ALLOW', '.caws/* (relative)'],
    [`${PROJECT_DIR}/.tmp/scratch.txt`, 'ALLOW', '.tmp/*'],
    [`${PROJECT_DIR}/tmp/build.log`, 'ALLOW', 'tmp/*'],
    [`${PROJECT_DIR}/.archive/old.md`, 'ALLOW', '.archive/*'],
    [`${PROJECT_DIR}/.githooks/pre-commit`, 'ALLOW', '.githooks/*'],
    [`${PROJECT_DIR}/.github/workflows/ci.yml`, 'ALLOW', '.github/*'],
    [`${PROJECT_DIR}/.gitignore`, 'ALLOW', '.gitignore'],
    [`${PROJECT_DIR}/AGENTS.md`, 'ALLOW', 'instruction file (zcode surface)'],
  ];

  test.each(cases)('ALLOWS %s (%s)', (p, expected) => {
    expect(probeAllow('zcode', p)).toBe(expected);
  });
});

describe('caws_is_write_allowlisted: vendor/instruction surfaces', () => {
  test('claude-code surface allowlists CLAUDE.md and ~/.claude/', () => {
    expect(probeAllow('claude-code', `${PROJECT_DIR}/CLAUDE.md`)).toBe('ALLOW');
    expect(probeAllow('claude-code', `${HOME_DIR}/.claude/sessions/sess-1/x.json`)).toBe('ALLOW');
  });

  test('zcode surface allowlists AGENTS.md and ~/.zcode/', () => {
    expect(probeAllow('zcode', `${PROJECT_DIR}/AGENTS.md`)).toBe('ALLOW');
    expect(probeAllow('zcode', `${HOME_DIR}/.zcode/sessions/sess-1/x.json`)).toBe('ALLOW');
  });

  test('zcode vendor hooks dir is allowlisted', () => {
    expect(probeAllow('zcode', `${PROJECT_DIR}/.zcode/hooks/foo.sh`)).toBe('ALLOW');
  });
});

describe('caws_is_write_allowlisted: DENY paths (route to oracle)', () => {
  const denyCases = [
    [`${PROJECT_DIR}/src/foo.ts`, 'src/* (source code)'],
    [`${PROJECT_DIR}/packages/caws-cli/src/index.ts`, 'packages/* (source code)'],
    [`${PROJECT_DIR}/core/module.py`, 'core/* (source code)'],
    [`${PROJECT_DIR}/README.md`, 'README.md (not an instruction file)'],
    [`${PROJECT_DIR}/.caws/worktrees/wt-a/payload.txt`, '.caws/worktrees payload (ABSOLUTE)'],
    ['.caws/worktrees/wt-a/payload.txt', '.caws/worktrees payload (RELATIVE)'],
    [`${PROJECT_DIR}/.caws/worktrees/wt-a/.caws/specs/F.yaml`, '.caws/worktrees nested payload'],
  ];

  test.each(denyCases)('DENIES %s (%s) — must route to oracle', (p) => {
    expect(probeAllow('zcode', p)).toBe('DENY');
  });

  test('CRITICAL: .caws/worktrees/* payload is NOT allowlisted (ownership-checked)', () => {
    // This is the invariant that prevents the allowlist from breaking worktree
    // isolation. If this regresses, a foreign session could write into another
    // session's worktree payload by Bash mutation.
    expect(probeAllow('zcode', `${PROJECT_DIR}/.caws/worktrees/wt-a/payload.txt`)).toBe('DENY');
    expect(probeAllow('zcode', '.caws/worktrees/wt-a/payload.txt')).toBe('DENY');
  });
});

describe('both guards source the shared allowlist helper (no re-divergence)', () => {
  const wtGuard = fs.readFileSync(WT_GUARD, 'utf8');
  const bashGuard = fs.readFileSync(BASH_GUARD, 'utf8');

  test('worktree-write-guard sources lib/write-allowlist.sh', () => {
    expect(wtGuard).toMatch(/lib\/write-allowlist\.sh/);
    expect(wtGuard).toMatch(/caws_is_write_allowlisted/);
  });

  test('bash-write-guard sources lib/write-allowlist.sh', () => {
    // The actual fix site: the bash guard previously had NO allowlist. It now
    // sources the SAME helper the Write/Edit guard uses.
    expect(bashGuard).toMatch(/lib\/write-allowlist\.sh/);
    expect(bashGuard).toMatch(/caws_is_write_allowlisted/);
  });

  test('worktree-write-guard no longer hardcodes the docs/* allowlist arm inline', () => {
    // The inlined allowlist arms moved to the shared helper. The old inline
    // form ('docs/*|docs/*) exit 0 ;;') must be gone from the guard body —
    // it now lives in caws_is_write_allowlisted.
    expect(wtGuard).not.toMatch(/"?\$PROJECT_DIR"?\/docs\/\*\|docs\/\*\) exit 0/);
  });

  test('bash-write-guard consults the helper BEFORE the oracle loop', () => {
    // The fix: the allowlist check must come before the oracle spawn in the
    // per-target loop. We assert the helper call appears before the oracle
    // node spawn in the source order.
    const helperIdx = bashGuard.indexOf('caws_is_write_allowlisted');
    const oracleIdx = bashGuard.indexOf('CAWS_CLAIM_ORACLE');
    expect(helperIdx).toBeGreaterThan(-1);
    // The oracle variable is defined early (line ~91), so find the oracle
    // SPAWN inside the loop instead.
    const oracleSpawnIdx = bashGuard.indexOf('node "$CAWS_CLAIM_ORACLE"');
    expect(oracleSpawnIdx).toBeGreaterThan(-1);
    expect(helperIdx).toBeLessThan(oracleSpawnIdx);
  });

  test('the payload oracle arm stays inline in worktree-write-guard (not in allowlist)', () => {
    // CRITICAL: the .caws/worktrees/* payload arm is ownership-adjudicated and
    // must stay inline BEFORE the allowlist delegation. If it were removed,
    // payload writes would be swept up by the .caws/* allow arm.
    expect(wtGuard).toMatch(/\.caws\/worktrees\/\*/);
  });
});
