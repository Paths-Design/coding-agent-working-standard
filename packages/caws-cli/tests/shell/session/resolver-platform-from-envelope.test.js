'use strict';

/**
 * Resolver platform-from-envelope coverage
 * (CAWS-RESOLVER-PLATFORM-FROM-ENVELOPE-001).
 *
 * This is the FIRST unit test for resolve-session.ts. The module previously
 * had zero direct test coverage — only dist/ consumers referenced it. This
 * suite pins the post-fix contract: the durable-hook-envelope resolution
 * surface reads the envelope's `platform` field (written by parse-input.sh
 * from CAWS_PLATFORM_FLAG) instead of hardcoding 'claude-code', while a
 * legacy envelope written without the field still resolves cleanly via the
 * 'claude-code' back-compat fallback.
 *
 * The SUT is the compiled surface: require('../../../dist/shell/session/
 * resolve-session'). `npm run build` compiles TS -> dist before jest runs.
 * Mirrors the zcode-config-merge.test.js precedent for dist-driven tests.
 *
 * Coverage (acceptance A1-A4):
 *   A1  envelope platform 'zcode'   -> identity.platform === 'zcode'
 *   A2  envelope platform 'codex'   -> identity.platform === 'codex'
 *   A3  legacy envelope (no field)  -> identity.platform === 'claude-code'
 *   A4  caller-disambiguated path + resolveSessionCandidates both reflect
 *       the envelope platform
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  resolveSession,
  resolveSessionCandidates,
} = require('../../../dist/shell/session/resolve-session');

/**
 * Build a synthetic CAWS project root with a `.caws/` dir the resolver can
 * point at. Returns { repoRoot, cawsDir, now } where cawsDir is the .caws/
 * path the resolver consumes and repoRoot is its parent (the value the
 * envelope's repo_root field must carry for the resolver's repo-root filter
 * to admit it).
 */
function makeProjectRoot() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-resolver-plat-'));
  const cawsDir = path.join(repoRoot, '.caws');
  fs.mkdirSync(path.join(cawsDir, 'sessions'), { recursive: true });
  // A fixed clock well inside the 24h envelope-freshness window. last_seen_at
  // is written at this instant; the resolver admits envelopes whose
  // last_seen_at is within 24h of opts.now().
  const now = new Date('2026-07-06T12:00:00Z');
  return { repoRoot, cawsDir, now };
}

/**
 * Write a durable hook envelope at <cawsDir>/sessions/<sid>/.session-envelope.json.
 * Mirrors the shape parse-input.sh's _write_durable_session_envelope emits.
 * `fields` lets a test deliberately OMIT platform (A3 legacy case).
 */
function writeEnvelope(cawsDir, sid, fields) {
  const dir = path.join(cawsDir, 'sessions', sid);
  fs.mkdirSync(dir, { recursive: true });
  const envelopePath = path.join(dir, '.session-envelope.json');
  const payload = {
    session_id: sid,
    repo_root: path.dirname(cawsDir),
    created_at: '2026-07-06T10:00:00Z',
    last_seen_at: '2026-07-06T12:00:00Z',
    hook_event: 'PreToolUse',
    ...fields,
  };
  fs.writeFileSync(envelopePath, JSON.stringify(payload) + '\n');
  return envelopePath;
}

/** A clean env object with all resolver env-var sources cleared, so the
 *  durable-envelope source (2.5) is the first one reached. */
function cleanEnv() {
  return {
    // Clear every env-var identity source so resolution falls through to 2.5.
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '',
    HOOK_SESSION_ID: '',
    CURSOR_TRACE_ID: '',
  };
}

describe('CAWS-RESOLVER-PLATFORM-FROM-ENVELOPE-001', () => {
  describe('resolveSession: durable-envelope platform (single candidate)', () => {
    test('A1 — envelope platform "zcode" resolves as zcode', () => {
      const { cawsDir, now } = makeProjectRoot();
      writeEnvelope(cawsDir, 'sess_zcode_001', { platform: 'zcode' });

      const result = resolveSession({
        cawsDir,
        worktreeRoot: cawsDir,
        env: cleanEnv(),
        now: () => now,
      });

      expect(result.ok).toBe(true);
      expect(result.value.source).toBe('durable_hook_envelope');
      expect(result.value.identity.platform).toBe('zcode');
      expect(result.value.identity.session_id).toBe('sess_zcode_001');
    });

    test('A2 — envelope platform "codex" resolves as codex (generalizes)', () => {
      const { cawsDir, now } = makeProjectRoot();
      writeEnvelope(cawsDir, 'sess_codex_001', { platform: 'codex' });

      const result = resolveSession({
        cawsDir,
        worktreeRoot: cawsDir,
        env: cleanEnv(),
        now: () => now,
      });

      expect(result.ok).toBe(true);
      expect(result.value.identity.platform).toBe('codex');
    });

    test('A3 — legacy envelope without platform falls back to claude-code', () => {
      const { cawsDir, now } = makeProjectRoot();
      // Deliberately write NO platform field — the pre-fix envelope shape.
      writeEnvelope(cawsDir, 'sess_legacy_001', {});

      const result = resolveSession({
        cawsDir,
        worktreeRoot: cawsDir,
        env: cleanEnv(),
        now: () => now,
      });

      expect(result.ok).toBe(true);
      expect(result.value.source).toBe('durable_hook_envelope');
      // The critical regression guard: a legacy envelope must still resolve,
      // and must fall back to 'claude-code' (the historical behavior).
      expect(result.value.identity.platform).toBe('claude-code');
    });

    test('envelope platform "opencode" resolves as opencode', () => {
      const { cawsDir, now } = makeProjectRoot();
      writeEnvelope(cawsDir, 'sess_opencode_001', { platform: 'opencode' });

      const result = resolveSession({
        cawsDir,
        worktreeRoot: cawsDir,
        env: cleanEnv(),
        now: () => now,
      });

      expect(result.ok).toBe(true);
      expect(result.value.identity.platform).toBe('opencode');
    });
  });

  describe('A4 — caller-disambiguated path + resolveSessionCandidates', () => {
    test('caller-disambiguated resolveSession reflects envelope platform', () => {
      // Two fresh envelopes for the same repo_root force the >=2 path. The
      // governed caller-session pointer disambiguates to exactly one of them.
      const { repoRoot, cawsDir, now } = makeProjectRoot();
      writeEnvelope(cawsDir, 'sess_a_001', { platform: 'zcode' });
      writeEnvelope(cawsDir, 'sess_b_001', { platform: 'codex' });

      // The caller-session pointer lives at
      // <repoRoot>/.caws/sessions/.caller-session.json (new home per
      // CAWS-SESSION-LOG-RELOCATE-001). It must name sess_a_001 so the
      // disambiguation picks the zcode envelope.
      const pointerPath = path.join(cawsDir, 'sessions', '.caller-session.json');
      fs.writeFileSync(
        pointerPath,
        JSON.stringify({
          session_id: 'sess_a_001',
          repo_root: repoRoot,
          last_seen_at: '2026-07-06T12:00:00Z',
        }) + '\n'
      );

      // CAWS-SESSION-RESOLVER-GUARD-DIVERGENCE-001 (A3): the pointer is now
      // advisory-only between two fresh envelopes and must be CORROBORATED by a
      // per-surface env var the current process carries. To exercise the pointer
      // path SPECIFICALLY (so the envelope's platform flows through), we
      // corroborate with CURSOR_TRACE_ID — it is tier 4, BELOW the envelope scan
      // (tier 2.5), so it does not short-circuit resolution but DOES count as
      // corroboration evidence for the pointer. This keeps the test's original
      // intent: the disambiguated envelope's platform ('zcode') is reflected.
      const env = { ...cleanEnv(), CURSOR_TRACE_ID: 'sess_a_001' };

      const result = resolveSession({
        cawsDir,
        worktreeRoot: cawsDir,
        env,
        now: () => now,
      });

      expect(result.ok).toBe(true);
      expect(result.value.source).toBe('durable_hook_envelope');
      expect(result.value.identity.session_id).toBe('sess_a_001');
      // The disambiguated path must reflect the SELECTED envelope's platform,
      // not a hardcoded default.
      expect(result.value.identity.platform).toBe('zcode');
    });

    test('resolveSessionCandidates admits every envelope with its own platform', () => {
      const { cawsDir, now } = makeProjectRoot();
      writeEnvelope(cawsDir, 'sess_cand_zcode', { platform: 'zcode' });
      writeEnvelope(cawsDir, 'sess_cand_codex', { platform: 'codex' });
      // And a legacy one to confirm the fallback holds on this surface too.
      writeEnvelope(cawsDir, 'sess_cand_legacy', {});

      const { candidates } = resolveSessionCandidates({
        cawsDir,
        env: cleanEnv(),
        now: () => now,
      });

      const envelopeCandidates = candidates.filter(
        (c) => c.source === 'durable_hook_envelope'
      );
      expect(envelopeCandidates).toHaveLength(3);

      const byId = Object.fromEntries(
        envelopeCandidates.map((c) => [c.identity.session_id, c.identity.platform])
      );
      expect(byId['sess_cand_zcode']).toBe('zcode');
      expect(byId['sess_cand_codex']).toBe('codex');
      expect(byId['sess_cand_legacy']).toBe('claude-code');
    });
  });
});
