'use strict';

/**
 * Vendor allowlist generalization regression gate
 * (CAWS-WORKTREE-WRITE-GUARD-VENDOR-GENERALIZE-001).
 *
 * The worktree-write-guard allowlist and session-log's is_plan_file_path used
 * to hardcode Claude-Code-specific paths (CLAUDE.md; .claude/plans/). They now
 * derive from CAWS_VENDOR_DIR / CAWS_INSTRUCTION_FILES so every surface gets
 * correct treatment. This suite is the regression gate: it fails if a future
 * surface forgets the CAWS_INSTRUCTION_FILES arm or reverts the plan-dir logic
 * to a hardcoded vendor.
 *
 * These are bash-driven tests (the SUT is shell, not TS) — they source the live
 * templates and assert the derived values + matching behavior under each
 * surface. Run after `npm run build` (the templates resolve from the source
 * tree under packages/caws-cli/templates/).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI_PKG_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATES = path.join(CLI_PKG_ROOT, 'templates', 'hook-packs', 'shared');
const AGENT_SURFACE = path.join(TEMPLATES, 'lib', 'agent-surface.sh');

function sourceUnderSurface(surface, script) {
  // Source agent-surface.sh under the given CAWS_AGENT_SURFACE, then run the
  // caller's script. The script's stdout is returned.
  const full = `
    unset _CAWS_AGENT_SURFACE_SH_LOADED
    export CAWS_AGENT_SURFACE=${surface}
    source ${JSON.stringify(AGENT_SURFACE)} 2>/dev/null
    ${script}
  `;
  return execFileSync('bash', ['-c', full], { encoding: 'utf8' });
}

describe('CAWS_INSTRUCTION_FILES: derived per surface (agent-surface.sh)', () => {
  const cases = [
    { surface: 'claude-code', expected: 'CLAUDE.md' },
    { surface: 'codex', expected: 'AGENTS.md' },
    { surface: 'opencode', expected: 'AGENTS.md' },
    { surface: 'zcode', expected: 'AGENTS.md' },
    { surface: 'cursor', expected: 'AGENTS.md' },
    { surface: 'windsurf', expected: 'AGENTS.md' },
  ];

  test.each(cases)('$surface derives CAWS_INSTRUCTION_FILES="$expected"', ({ surface, expected }) => {
    const out = sourceUnderSurface(surface, 'printf "%s" "$CAWS_INSTRUCTION_FILES"');
    expect(out.trim()).toBe(expected);
  });

  test('unknown surface falls through to BOTH common instruction files (fail-safe)', () => {
    const out = sourceUnderSurface('bogus-surface', 'printf "%s" "$CAWS_INSTRUCTION_FILES"');
    // Both files must be present (order-independent; space-separated).
    const files = out.trim().split(/\s+/).sort();
    expect(files).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });

  test('every implemented surface resolves a non-empty instruction file', () => {
    // Cross-lock with the TS source of truth: IMPLEMENTED_SURFACES must each
    // resolve an instruction file. A future surface added to register.ts that
    // forgets the agent-surface.sh arm would leave CAWS_INSTRUCTION_FILES empty
    // (or inherited from a prior source) — this catches that.
    const { IMPLEMENTED_SURFACES } = require('../../dist/init/hook-packs/register');
    for (const surface of IMPLEMENTED_SURFACES) {
      const out = sourceUnderSurface(surface, 'printf "%s" "${CAWS_INSTRUCTION_FILES:-}"');
      expect(out.trim().length).toBeGreaterThan(0);
    }
  });

  test('CAWS_INSTRUCTION_FILES and CAWS_VENDOR_DIR are both exported', () => {
    // Both must be present in the environment (not just set in the shell).
    const out = execFileSync(
      'bash',
      [
        '-c',
        `unset _CAWS_AGENT_SURFACE_SH_LOADED
         CAWS_AGENT_SURFACE=zcode source ${JSON.stringify(AGENT_SURFACE)} 2>/dev/null
         env | grep -E '^(CAWS_INSTRUCTION_FILES|CAWS_VENDOR_DIR)=' | sort`,
      ],
      { encoding: 'utf8' }
    );
    expect(out).toContain('CAWS_INSTRUCTION_FILES=AGENTS.md');
    expect(out).toContain('CAWS_VENDOR_DIR=.zcode');
  });
});

describe('is_plan_file_path: vendor-derived, not hardcoded (session-log.sh)', () => {
  // The function lives in session-log.sh but references CAWS_VENDOR_DIR from
  // agent-surface.sh. We define the function inline (copied verbatim from the
  // shipped source) so the test exercises the EXACT logic without standing up
  // the full dispatcher + parse-input dependency chain.
  const FUNCTION_BODY = fs.readFileSync(path.join(TEMPLATES, 'session-log.sh'), 'utf8')
    .match(/is_plan_file_path\(\) \{[\s\S]*?^\}/m)[0];

  function planCheck(surface, filePath) {
    const script = `
      ${FUNCTION_BODY}
      if is_plan_file_path ${JSON.stringify(filePath)}; then echo PLAN; else echo no; fi
    `;
    return sourceUnderSurface(surface, script).trim();
  }

  test.each([
    ['claude-code', '/home/u/.claude/plans/x.md'],
    ['codex', '/home/u/.codex/plans/x.md'],
    ['opencode', '/home/u/.opencode/plans/x.md'],
    ['zcode', '/home/u/.zcode/plans/x.md'],
  ])('surface %s recognizes its own absolute plan dir (%s)', (surface, p) => {
    expect(planCheck(surface, p)).toBe('PLAN');
  });

  test.each([
    ['codex', 'proj/.codex/plans/x.md'],
    ['zcode', 'proj/.zcode/plans/x.md'],
  ])('surface %s recognizes a RELATIVE plan dir (%s)', (surface, p) => {
    expect(planCheck(surface, p)).toBe('PLAN');
  });

  test.each([
    ['claude-code', '/home/u/.codex/plans/x.md'],
    ['codex', '/home/u/.claude/plans/x.md'],
    ['zcode', '/home/u/.opencode/plans/x.md'],
  ])('surface %s does NOT match a foreign vendor plan dir (%s)', (surface, p) => {
    expect(planCheck(surface, p)).toBe('no');
  });

  test('the vendor-neutral .caws/plans/ is recognized on every surface', () => {
    for (const surface of ['claude-code', 'codex', 'zcode']) {
      expect(planCheck(surface, 'proj/.caws/plans/x.md')).toBe('PLAN');
    }
  });
});

describe('worktree-write-guard: no hardcoded CLAUDE.md remains', () => {
  const guard = fs.readFileSync(path.join(TEMPLATES, 'worktree-write-guard.sh'), 'utf8');

  test('the old hardcoded allowlist arm is gone', () => {
    // The literal case-pattern arm that hardcoded CLAUDE.md must be removed.
    expect(guard).not.toMatch(/CLAUDE\.md\|CLAUDE\.md\) exit 0/);
  });

  test('the guard references CAWS_INSTRUCTION_FILES (the new derived arm)', () => {
    expect(guard).toMatch(/CAWS_INSTRUCTION_FILES/);
  });
});
