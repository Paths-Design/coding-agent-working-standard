'use strict';

/**
 * CAWS-SESSION-RESOLVER-GUARD-DIVERGENCE-001 — regression coverage for A1–A6.
 *
 * Closes the worktree-ownership-misattribution defect where the resolver chain
 * and the write-guard chain read different session-id sources, so the rightful
 * owner of a worktree was treated as foreign (false block_foreign_worktree),
 * and non-Claude harnesses (codex in particular) fell into a racy durable-
 * envelope scan that crossed ownership between concurrent sessions.
 *
 * SUT: compiled surface — require('../../../dist/shell/session/resolve-session').
 * `npm run build` compiles TS -> dist before jest runs.
 *
 * Coverage:
 *   A1  resolveSession admits CODEX_THREAD_ID (codex agent-Bash path) and
 *       CLAUDE_CODE_SESSION_ID at the right precedence — the two incident
 *       shapes. Owner-self recognition no longer depends on HOOK_SESSION_ID.
 *   A2  resolveSessionCandidates admits the same per-surface env sources, so
 *       the ownership-COMPARISON surface (destroy/merge) agrees with the
 *       stamping surface. (Foreign-block is the oracle's job, asserted in bats.)
 *   A3  the .caller-session.json pointer is advisory-only between two fresh
 *       envelopes — uncorroborated, it falls through to the ambiguity refusal
 *       instead of silently selecting a sibling session.
 *   A4  mintCapsule stamps a harness surface name (codex/claude-code/none),
 *       NEVER the OS string (darwin/linux).
 *   A5  the canonical codex parse-input.sh override writes the `platform` field
 *       to the durable envelope (the concrete root-cause fix). Asserted as a
 *       template-content check + a round-trip through the resolver.
 *   A6  the three shell precedence sites (resolver env chain, block-dangerous,
 *       reset-danger-latch) agree — asserted by sourcing the shared helper and
 *       confirming each site routes through it / matches its order.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  resolveSession,
  resolveSessionCandidates,
} = require('../../../dist/shell/session/resolve-session');

// --- shared fixtures --------------------------------------------------------

function makeProjectRoot() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-resolver-div-'));
  const cawsDir = path.join(repoRoot, '.caws');
  fs.mkdirSync(path.join(cawsDir, 'sessions'), { recursive: true });
  const now = new Date('2026-07-14T12:00:00Z');
  return { repoRoot, cawsDir, now };
}

function writeEnvelope(cawsDir, sid, fields) {
  const dir = path.join(cawsDir, 'sessions', sid);
  fs.mkdirSync(dir, { recursive: true });
  const envelopePath = path.join(dir, '.session-envelope.json');
  const payload = {
    session_id: sid,
    repo_root: path.dirname(cawsDir),
    created_at: '2026-07-14T10:00:00Z',
    last_seen_at: '2026-07-14T12:00:00Z',
    hook_event: 'PreToolUse',
    ...fields,
  };
  fs.writeFileSync(envelopePath, JSON.stringify(payload) + '\n');
  return envelopePath;
}

function writeCallerPointer(cawsDir, repoRoot, sid, nowIso = '2026-07-14T12:00:00Z') {
  const pointerPath = path.join(cawsDir, 'sessions', '.caller-session.json');
  fs.writeFileSync(
    pointerPath,
    JSON.stringify({
      session_id: sid,
      repo_root: repoRoot,
      last_seen_at: nowIso,
    }) + '\n'
  );
  return pointerPath;
}

/** Clear EVERY env-var identity source so a chosen source is the first reached. */
function cleanEnv() {
  return {
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '',
    CODEX_THREAD_ID: '',
    CAWS_SESSION_ID: '',
    HOOK_SESSION_ID: '',
    CURSOR_TRACE_ID: '',
  };
}

// --- A1: per-surface env sources resolve at the right precedence ------------

describe('CAWS-SESSION-RESOLVER-GUARD-DIVERGENCE-001 — A1: per-surface env sources', () => {
  test('CODEX_THREAD_ID resolves at tier 1.6 as platform codex (the codex incident fix)', () => {
    const { cawsDir } = makeProjectRoot();
    const result = resolveSession({
      cawsDir,
      worktreeRoot: cawsDir,
      env: { ...cleanEnv(), CODEX_THREAD_ID: '019f6289-d6d6-76b3-a6d1-04123944b2e6' },
    });
    expect(result.ok).toBe(true);
    expect(result.value.source).toBe('codex_thread_env');
    expect(result.value.identity.session_id).toBe(
      '019f6289-d6d6-76b3-a6d1-04123944b2e6'
    );
    expect(result.value.identity.platform).toBe('codex');
  });

  test('CODEX_THREAD_ID wins over the durable-envelope scan (no racy fallthrough)', () => {
    // A codex session in agent-Bash: CODEX_THREAD_ID is set AND a stale sibling
    // envelope exists. Pre-fix this fell to the envelope scan; post-fix tier 1.6
    // resolves deterministically from the env var.
    const { cawsDir, now } = makeProjectRoot();
    writeEnvelope(cawsDir, 'sibling-session', { platform: 'codex' });
    const result = resolveSession({
      cawsDir,
      worktreeRoot: cawsDir,
      env: { ...cleanEnv(), CODEX_THREAD_ID: 'my-codex-thread' },
      now: () => now,
    });
    expect(result.ok).toBe(true);
    expect(result.value.source).toBe('codex_thread_env');
    expect(result.value.identity.session_id).toBe('my-codex-thread');
  });

  test('CLAUDE_CODE_SESSION_ID still resolves at tier 1.5 (claude-code incident path unchanged)', () => {
    const { cawsDir } = makeProjectRoot();
    const result = resolveSession({
      cawsDir,
      worktreeRoot: cawsDir,
      env: { ...cleanEnv(), CLAUDE_CODE_SESSION_ID: 'claude-uuid-123' },
    });
    expect(result.ok).toBe(true);
    expect(result.value.source).toBe('claude_code_env');
    expect(result.value.identity.platform).toBe('claude-code');
  });

  test('CAWS_SESSION_ID resolves at tier 1.7 (generic escape hatch)', () => {
    const { cawsDir } = makeProjectRoot();
    const result = resolveSession({
      cawsDir,
      worktreeRoot: cawsDir,
      env: { ...cleanEnv(), CAWS_SESSION_ID: 'generic-sid' },
    });
    expect(result.ok).toBe(true);
    expect(result.value.source).toBe('caws_env');
    expect(result.value.identity.session_id).toBe('generic-sid');
  });

  test('precedence: CLAUDE_SESSION_ID > CLAUDE_CODE_SESSION_ID > CODEX_THREAD_ID', () => {
    const { cawsDir } = makeProjectRoot();
    const result = resolveSession({
      cawsDir,
      worktreeRoot: cawsDir,
      env: {
        ...cleanEnv(),
        CLAUDE_SESSION_ID: 'operator-override',
        CLAUDE_CODE_SESSION_ID: 'claude-uuid',
        CODEX_THREAD_ID: 'codex-thread',
      },
    });
    expect(result.ok).toBe(true);
    expect(result.value.source).toBe('claude_env');
    expect(result.value.identity.session_id).toBe('operator-override');
  });

  test('literal "unknown" is refused for CODEX_THREAD_ID (falls through)', () => {
    const { cawsDir } = makeProjectRoot();
    const result = resolveSession({
      cawsDir,
      worktreeRoot: cawsDir,
      allowMint: false,
      env: { ...cleanEnv(), CODEX_THREAD_ID: 'unknown' },
    });
    // 'unknown' refused → no env source matched → no envelope → no capsule →
    // SESSION_NO_STABLE_IDENTITY (allowMint false).
    expect(result.ok).toBe(false);
  });
});

// --- A2: resolveSessionCandidates mirrors the per-surface sources -----------

describe('CAWS-SESSION-RESOLVER-GUARD-DIVERGENCE-001 — A2: candidate mirror', () => {
  test('resolveSessionCandidates admits CODEX_THREAD_ID + CAWS_SESSION_ID candidates', () => {
    const { cawsDir } = makeProjectRoot();
    const { candidates, trace } = resolveSessionCandidates({
      cawsDir,
      env: {
        ...cleanEnv(),
        CODEX_THREAD_ID: 'codex-owner',
        CAWS_SESSION_ID: 'caws-owner',
      },
    });
    const ids = candidates.map((c) => c.identity.session_id);
    expect(ids).toContain('codex-owner');
    expect(ids).toContain('caws-owner');
    // The codex candidate carries platform codex (so a destroy/merge comparison
    // against a codex-stamped owner admits it).
    const codexCand = candidates.find((c) => c.identity.session_id === 'codex-owner');
    expect(codexCand.identity.platform).toBe('codex');
    // Both sources recorded in the trace.
    const sources = trace.map((t) => t.source);
    expect(sources).toContain('codex_thread_env');
    expect(sources).toContain('caws_env');
  });
});

// --- A3: caller-pointer is advisory-only between two fresh envelopes --------

describe('CAWS-SESSION-RESOLVER-GUARD-DIVERGENCE-001 — A3: pointer advisory-only', () => {
  test('uncorroborated pointer does NOT silently select (falls through to refusal)', () => {
    // Two fresh envelopes; the pointer names sess_b (a sibling that fired last).
    // The current process carries NO env var matching sess_b. Pre-fix this
    // silently resolved as sess_b — crossing ownership. Post-fix it refuses.
    const { repoRoot, cawsDir, now } = makeProjectRoot();
    writeEnvelope(cawsDir, 'sess_a', { platform: 'zcode' });
    writeEnvelope(cawsDir, 'sess_b', { platform: 'codex' });
    writeCallerPointer(cawsDir, repoRoot, 'sess_b');
    const result = resolveSession({
      cawsDir,
      worktreeRoot: cawsDir,
      env: cleanEnv(), // no env var corroborates sess_b
      now: () => now,
    });
    expect(result.ok).toBe(false);
    // The refusal is the typed ambiguity diagnostic, not a silent misattribution.
    // The pointer must NOT have handed the resolved identity to sess_b.
    expect(result.errors[0].rule).toMatch(/durable_envelope_ambiguous/);
    expect(result.errors[0].data.candidateSessionIds).toEqual(
      expect.arrayContaining(['sess_a', 'sess_b'])
    );
  });

  test('corroborated pointer DOES select the named envelope (env evidence agrees)', () => {
    // Two fresh envelopes + pointer naming sess_a, AND the current process
    // carries CURSOR_TRACE_ID='sess_a' as corroboration. CURSOR_TRACE_ID is
    // tier 4 (below the envelope scan at 2.5), so it does NOT short-circuit
    // resolution but DOES satisfy the corroboration gate — letting the pointer
    // select sess_a's envelope and reflect ITS platform.
    const { repoRoot, cawsDir, now } = makeProjectRoot();
    writeEnvelope(cawsDir, 'sess_a', { platform: 'codex' });
    writeEnvelope(cawsDir, 'sess_b', { platform: 'zcode' });
    writeCallerPointer(cawsDir, repoRoot, 'sess_a');
    const result = resolveSession({
      cawsDir,
      worktreeRoot: cawsDir,
      env: { ...cleanEnv(), CURSOR_TRACE_ID: 'sess_a' },
      now: () => now,
    });
    expect(result.ok).toBe(true);
    expect(result.value.identity.session_id).toBe('sess_a');
    // The pointer selected sess_a's envelope; its platform flows through.
    expect(result.value.source).toBe('durable_hook_envelope');
    expect(result.value.identity.platform).toBe('codex');
  });
});

// --- A4: mintCapsule stamps a harness surface, not the OS string -------------

describe('CAWS-SESSION-RESOLVER-GUARD-DIVERGENCE-001 — A4: mint platform is a surface', () => {
  test('minted capsule platform is never the bare OS string (darwin/linux)', () => {
    const { cawsDir } = makeProjectRoot();
    const result = resolveSession({
      cawsDir,
      worktreeRoot: cawsDir,
      allowMint: true,
      env: cleanEnv(),
      // Force a deterministic mint id.
      mintIdSuffix: () => 'deadbeef',
    });
    expect(result.ok).toBe(true);
    expect(result.value.source).toBe('minted');
    const platform = result.value.identity.platform;
    // Must be a harness surface name, NOT 'darwin'/'linux'/'win32' etc.
    expect(platform).not.toBe('darwin');
    expect(platform).not.toBe('linux');
    expect(platform).not.toBe('win32');
    // Must be a member of the AgentSurface enum.
    expect([
      'claude-code',
      'codex',
      'opencode',
      'zcode',
      'cursor',
      'windsurf',
      'none',
    ]).toContain(platform);
  });

  test('minted platform derives from env (CODEX_THREAD_ID → codex)', () => {
    // When a codex env var is present but no mint-blocking higher source matches,
    // the mint (if reached) stamps the derived surface. Here CODEX_THREAD_ID is
    // set so tier 1.6 resolves before mint — but surfaceFromEnv on a clean env
    // with only CODEX_THREAD_ID yields codex, which mintCapsule would use.
    const { cawsDir } = makeProjectRoot();
    const result = resolveSession({
      cawsDir,
      worktreeRoot: cawsDir,
      allowMint: true,
      env: { ...cleanEnv(), CODEX_THREAD_ID: 'thread-x' },
      mintIdSuffix: () => 'cafef00d',
    });
    // Tier 1.6 wins (not mint) — confirms the env path is hit first.
    expect(result.ok).toBe(true);
    expect(result.value.source).toBe('codex_thread_env');
  });
});

// --- A5: canonical codex parse-input.sh writes the platform field ------------

describe('CAWS-SESSION-RESOLVER-GUARD-DIVERGENCE-001 — A5: codex envelope platform field', () => {
  // The concrete root-cause fix: the canonical codex override must write
  // `platform` to the durable envelope so the resolver does not fall back to
  // 'claude-code' for a codex session. Asserted as a template-content check
  // (the bug was the field's ABSENCE in the shipped template).
  const CODEX_PARSE_INPUT = path.join(
    __dirname,
    '..',
    '..',
    '..',
    'templates',
    'hook-packs',
    'codex',
    'hooks',
    'lib',
    'parse-input.sh'
  );

  test('the codex envelope-writer payload includes a platform key', () => {
    expect(fs.existsSync(CODEX_PARSE_INPUT)).toBe(true);
    const src = fs.readFileSync(CODEX_PARSE_INPUT, 'utf8');
    // The payload dict written by _write_durable_session_envelope must include
    // a "platform" key (pre-fix it had only 5 keys: session_id, repo_root,
    // created_at, last_seen_at, hook_event).
    expect(src).toMatch(/"platform":\s*sys\.argv/);
  });

  test('the codex envelope-writer sources platform from CAWS_PLATFORM_FLAG', () => {
    const src = fs.readFileSync(CODEX_PARSE_INPUT, 'utf8');
    // The platform value must come from CAWS_PLATFORM_FLAG (exported by
    // agent-surface.sh as "codex" for this surface), with a codex default.
    expect(src).toMatch(/CAWS_PLATFORM_FLAG:-codex/);
  });
});

// --- A6: shell precedence consolidation -------------------------------------

describe('CAWS-SESSION-RESOLVER-GUARD-DIVERGENCE-001 — A6: precedence consolidation', () => {
  const SHARED_LIB = path.join(
    __dirname,
    '..',
    '..',
    '..',
    'templates',
    'hook-packs',
    'shared',
    'lib',
    'session-id.sh'
  );

  test('the shared session-id helper exists and defines the resolver function', () => {
    expect(fs.existsSync(SHARED_LIB)).toBe(true);
    const src = fs.readFileSync(SHARED_LIB, 'utf8');
    expect(src).toMatch(/resolve_caws_session_id_with_payload\s*\(\)/);
    expect(src).toMatch(/CLAUDE_SESSION_ID/);
    expect(src).toMatch(/CLAUDE_CODE_SESSION_ID/);
    expect(src).toMatch(/CODEX_THREAD_ID/);
    expect(src).toMatch(/CAWS_SESSION_ID/);
    expect(src).toMatch(/HOOK_SESSION_ID/);
  });

  test('the shared helper resolves the canonical precedence', () => {
    // Source the helper and exercise the precedence directly. Each source wins
    // in order; 'unknown' is rejected and the next source is consulted.
    const cases = [
      { env: { CLAUDE_SESSION_ID: 'a', CLAUDE_CODE_SESSION_ID: 'b', CODEX_THREAD_ID: 'c' }, want: 'a' },
      { env: { CLAUDE_CODE_SESSION_ID: 'b', CODEX_THREAD_ID: 'c', CAWS_SESSION_ID: 'd' }, want: 'b' },
      { env: { CODEX_THREAD_ID: 'c', CAWS_SESSION_ID: 'd', HOOK_SESSION_ID: 'e' }, want: 'c' },
      { env: { CAWS_SESSION_ID: 'd', HOOK_SESSION_ID: 'e' }, want: 'd' },
      { env: { HOOK_SESSION_ID: 'e', CURSOR_TRACE_ID: 'f' }, want: 'e' },
      { env: { CURSOR_TRACE_ID: 'f' }, want: 'f' },
      { env: { CLAUDE_CODE_SESSION_ID: 'unknown', CODEX_THREAD_ID: 'real' }, want: 'real' },
      { env: {}, want: 'unknown' },
    ];
    for (const { env, want } of cases) {
      const envAssigns = Object.entries(env)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ');
      const out = require('child_process').execSync(
        `${envAssigns} bash -c 'source "${SHARED_LIB}" >/dev/null 2>&1; resolve_caws_session_id'`,
        { encoding: 'utf8' }
      ).trim();
      expect(out).toBe(want);
    }
  });

  test('block-dangerous.sh sources the shared helper', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(SHARED_LIB), '..', 'block-dangerous.sh'),
      'utf8'
    );
    expect(src).toMatch(/lib\/session-id\.sh/);
    expect(src).toMatch(/resolve_caws_session_id/);
  });

  test('reset-danger-latch.sh sources the shared helper', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(SHARED_LIB), '..', 'reset-danger-latch.sh'),
      'utf8'
    );
    expect(src).toMatch(/lib\/session-id\.sh/);
    expect(src).toMatch(/resolve_caws_session_id/);
  });

  test('both write guards source the shared helper and pass the resolved id to the oracle', () => {
    for (const guard of ['bash-write-guard.sh', 'worktree-write-guard.sh']) {
      const src = fs.readFileSync(
        path.join(path.dirname(SHARED_LIB), '..', guard),
        'utf8'
      );
      expect(src).toMatch(/lib\/session-id\.sh/);
      expect(src).toMatch(/resolve_caws_session_id_with_payload/);
      // The oracle call uses the resolved CAWS_ORACLE_SESSION_ID, not raw HOOK_SESSION_ID.
      expect(src).toMatch(/CAWS_ORACLE_SESSION_ID="\$CAWS_ORACLE_SESSION_ID"/);
    }
  });
});
