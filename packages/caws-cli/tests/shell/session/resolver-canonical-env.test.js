'use strict';

/**
 * Resolver canonical-env / surface-pinned precedence coverage
 * (CAWS-DEFECT-SESSION-IDENTITY-ENV-SHADOWING-01).
 *
 * The defect, proven live: with both DSH_SESSION_ID and CLAUDE_SESSION_ID
 * set, the claude var silently rewrote "self" for a dsh process — identity
 * resolution is env-trust with a cross-surface shadowing hole. The fix adds
 * tier 0 to resolveSession:
 *
 *   0a. surface-pinned precedence — when CAWS_AGENT_SURFACE names the
 *       dispatching platform, that surface's own env var wins; foreign
 *       vars cannot shadow it.
 *   0b. the canonical CAWS_SESSION_ID — normalized upstream by the dispatch
 *       layer (caws_normalize_session_env) or operator-set — is read before
 *       the per-surface chain.
 *
 * Forgery of the id STRING is accepted by design; correctness is anchored
 * by the PID record (shell resolver) and liveness probing, not secrecy.
 *
 * The SUT is the compiled surface: require('../../../dist/shell/session/
 * resolve-session'). Pure env-injection tests — no fs fixtures.
 */

const { resolveSession } = require('../../../dist/shell/session/resolve-session');

function resolveWith(env) {
  return resolveSession({ env, platform: 'darwin' });
}

describe('tier 0a: surface-pinned precedence (the shadowing fix)', () => {
  test('a stray CLAUDE_SESSION_ID cannot shadow the pinned surface var', () => {
    const result = resolveWith({
      CAWS_AGENT_SURFACE: 'dsh',
      DSH_SESSION_ID: 'dsh-true-id',
      CLAUDE_SESSION_ID: 'claude-stray-id',
    });
    expect(result.ok).toBe(true);
    expect(result.value.identity.session_id).toBe('dsh-true-id');
    expect(result.value.identity.platform).toBe('dsh');
    expect(result.value.source).toBe('surface_pinned_env');
  });

  test('pinning works for each gated/hookless surface var', () => {
    for (const [surface, envVar] of [
      ['codex', 'CODEX_THREAD_ID'],
      ['qwen-code', 'QWEN_CODE_SESSION_ID'],
      ['dsh', 'DSH_SESSION_ID'],
      ['claude-code', 'CLAUDE_SESSION_ID'],
    ]) {
      // Shadow with a FOREIGN var (for claude-code the pinned var IS
      // CLAUDE_SESSION_ID, so the shadow must come from another surface).
      const shadow = envVar === 'CLAUDE_SESSION_ID'
        ? { DSH_SESSION_ID: 'shadow-attempt' }
        : { CLAUDE_SESSION_ID: 'shadow-attempt' };
      const result = resolveWith({
        CAWS_AGENT_SURFACE: surface,
        [envVar]: `${surface}-id`,
        ...shadow,
      });
      expect(result.value.identity.session_id).toBe(`${surface}-id`);
      expect(result.value.identity.platform).toBe(surface);
    }
  });

  test('the pinned platform is always a real surface member (the cast cannot lie)', () => {
    // CAWS-HOTFIX-SESSION-IDENTITY-REVIEW-FINDINGS-001: the merged lane
    // type-checked via `as never` (the bottom type). This pins the runtime
    // contract: whatever the pin resolves, its platform is a valid surface.
    const AGENT_SURFACES = ['claude-code', 'codex', 'opencode', 'zcode', 'kimi-code', 'qwen-code', 'dsh', 'cursor', 'windsurf', 'none'];
    for (const surface of ['claude-code', 'codex', 'qwen-code', 'dsh']) {
      const envVar = { 'claude-code': 'CLAUDE_SESSION_ID', codex: 'CODEX_THREAD_ID', 'qwen-code': 'QWEN_CODE_SESSION_ID', dsh: 'DSH_SESSION_ID' }[surface];
      const result = resolveWith({ CAWS_AGENT_SURFACE: surface, [envVar]: `${surface}-id` });
      expect(AGENT_SURFACES).toContain(result.value.identity.platform);
      expect(result.value.identity.platform).toBe(surface);
    }
  });

  test('a pin whose own var is absent falls through (no invented identity)', () => {
    const result = resolveWith({
      CAWS_AGENT_SURFACE: 'dsh',
      CLAUDE_SESSION_ID: 'operator-override',
    });
    // Pin present but its var missing: the documented operator override wins.
    expect(result.value.identity.session_id).toBe('operator-override');
    expect(result.value.source).toBe('claude_env');
  });
});

describe('tier 0b: canonical CAWS_SESSION_ID read before the chain', () => {
  test('canonical var beats every per-surface var', () => {
    const result = resolveWith({
      CAWS_SESSION_ID: 'canonical-id',
      DSH_SESSION_ID: 'dsh-id',
      CLAUDE_CODE_SESSION_ID: 'claude-id',
    });
    expect(result.value.identity.session_id).toBe('canonical-id');
    expect(result.value.source).toBe('caws_env');
  });

  test('platform derives from CAWS_PLATFORM_FLAG when valid', () => {
    const result = resolveWith({
      CAWS_SESSION_ID: 'canonical-id',
      CAWS_PLATFORM_FLAG: 'zcode',
    });
    expect(result.value.identity.platform).toBe('zcode');
  });

  test('platform falls back to the surface pin, then none — never a guess', () => {
    const pinned = resolveWith({
      CAWS_SESSION_ID: 'canonical-id',
      CAWS_AGENT_SURFACE: 'dsh',
    });
    expect(pinned.value.identity.platform).toBe('dsh');

    const bare = resolveWith({ CAWS_SESSION_ID: 'canonical-id' });
    expect(bare.value.identity.platform).toBe('none');
  });

  test('literal "unknown" is refused as the canonical value', () => {
    const result = resolveWith({
      CAWS_SESSION_ID: 'unknown',
      DSH_SESSION_ID: 'dsh-id',
    });
    expect(result.value.identity.session_id).toBe('dsh-id');
  });
});

describe('without tier-0 inputs the legacy chain is unchanged', () => {
  test('CLAUDE_SESSION_ID remains the documented operator override', () => {
    const result = resolveWith({
      CLAUDE_SESSION_ID: 'op-id',
      DSH_SESSION_ID: 'dsh-id',
    });
    expect(result.value.identity.session_id).toBe('op-id');
    expect(result.value.source).toBe('claude_env');
  });

  test('DSH_SESSION_ID still resolves when alone (the pre-fix behavior)', () => {
    const result = resolveWith({ DSH_SESSION_ID: 'dsh-id' });
    expect(result.value.identity.session_id).toBe('dsh-id');
    expect(result.value.identity.platform).toBe('dsh');
    expect(result.value.source).toBe('dsh_env');
  });
});
