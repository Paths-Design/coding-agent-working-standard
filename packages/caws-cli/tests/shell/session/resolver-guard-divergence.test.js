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

/**
 * Write a worktree registry entry into .caws/worktrees.json so the resolver's
 * cwd-ownership corroboration (resolveOwnerFromCwd) can match it. The `wtPath`
 * defaults to a real dir under the repo's .caws/worktrees/<name> so realpath
 * resolves it; pass an explicit path to model a worktree the caller is inside.
 * CAWS-RESOLVER-CWD-OWNERSHIP-CORROBORATION-001.
 */
function writeWorktreeEntry(cawsDir, name, ownerSessionId, opts = {}) {
  const wtPath = opts.path ?? path.join(cawsDir, 'worktrees', name);
  fs.mkdirSync(wtPath, { recursive: true });
  const registryPath = path.join(cawsDir, 'worktrees.json');
  let registry = {};
  if (fs.existsSync(registryPath)) {
    try {
      registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    } catch {
      registry = {};
    }
  }
  registry[name] = {
    specId: opts.specId ?? 'TEST-SPEC-01',
    owner: {
      session_id: ownerSessionId,
      ...(opts.platform ? { platform: opts.platform } : {}),
    },
    branch: opts.branch ?? name,
    baseBranch: 'main',
    path: wtPath,
    last_heartbeat: '2026-07-14T12:00:00Z',
  };
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
  return wtPath;
}

/**
 * Write an agent-PID correlation record at .caws/sessions/agent-pid-<pid>.json.
 * CAWS-AGENT-PID-SESSION-CORRELATION-001. last_seen_at defaults to the fixed
 * clock (now) so records are fresh within the 24h window unless overridden.
 */
function writeAgentPidRecord(cawsDir, pid, sessionId, opts = {}) {
  const sessDir = path.join(cawsDir, 'sessions');
  fs.mkdirSync(sessDir, { recursive: true });
  const recordPath = path.join(sessDir, `agent-pid-${pid}.json`);
  const payload = {
    agent_pid: pid,
    session_id: sessionId,
    surface: opts.surface ?? 'zcode',
    repo_root: opts.repoRoot ?? path.dirname(cawsDir),
    created_at: opts.createdAt ?? '2026-07-14T10:00:00Z',
    last_seen_at: opts.lastSeenAt ?? '2026-07-14T12:00:00Z',
    started_at: opts.startedAt ?? null,
  };
  fs.writeFileSync(recordPath, JSON.stringify(payload) + '\n');
  return recordPath;
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

// --- A3b: cwd-ownership corroboration (CAWS-RESOLVER-CWD-OWNERSHIP-CORROBORATION-001) ---
//
// A second, independent disambiguation path for the ≥2-fresh-envelope branch:
// when the caller's cwd resolves (via the authoritative worktrees.json) to a
// registered owner that IS one of the fresh candidates, the process is inside
// its own bound worktree — positive evidence tying THIS process to that
// candidate. This unblocks no-env-var callers (ZCode / generic harness / a
// human terminal) that otherwise fall through to the ambiguity refusal.

describe('CAWS-RESOLVER-CWD-OWNERSHIP-CORROBORATION-001 — A3b: cwd ownership', () => {
  test('A3b-1: caller inside its own worktree resolves to that owner (no env var)', () => {
    // Two fresh envelopes; the caller's cwd is inside a worktree owned by
    // sess_a. NO env var is set (the ZCode / generic-harness case). Pre-fix
    // this refused; post-fix the cwd corroborates sess_a and it resolves.
    const { repoRoot, cawsDir, now } = makeProjectRoot();
    writeEnvelope(cawsDir, 'sess_a', { platform: 'zcode' });
    writeEnvelope(cawsDir, 'sess_b', { platform: 'codex' });
    const wtPath = writeWorktreeEntry(cawsDir, 'wt-a', 'sess_a', {
      platform: 'zcode',
    });
    const result = resolveSession({
      cawsDir,
      worktreeRoot: wtPath, // caller is inside sess_a's worktree
      env: cleanEnv(), // no env var corroborates anything
      now: () => now,
    });
    expect(result.ok).toBe(true);
    expect(result.value.identity.session_id).toBe('sess_a');
    expect(result.value.source).toBe('durable_hook_envelope');
    // The envelope's platform flows through (cwd owner platform is a fallback).
    expect(result.value.identity.platform).toBe('zcode');
  });

  test('A3b-2: cwd owned by a NON-candidate still refuses (no manufactured selection)', () => {
    // Two fresh envelopes (sess_a, sess_b), but the caller's worktree is owned
    // by sess_c — a session that is NOT a fresh-envelope candidate. cwd
    // ownership corroborates an existing candidate; it does not manufacture
    // one, so the cross-ownership hazard stays refused.
    const { repoRoot, cawsDir, now } = makeProjectRoot();
    writeEnvelope(cawsDir, 'sess_a', { platform: 'zcode' });
    writeEnvelope(cawsDir, 'sess_b', { platform: 'codex' });
    const wtPath = writeWorktreeEntry(cawsDir, 'wt-c', 'sess_c', {
      platform: 'claude-code',
    });
    const result = resolveSession({
      cawsDir,
      worktreeRoot: wtPath, // inside a worktree owned by sess_c (not a candidate)
      env: cleanEnv(),
      now: () => now,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toMatch(/durable_envelope_ambiguous/);
    expect(result.errors[0].data.candidateSessionIds).toEqual(
      expect.arrayContaining(['sess_a', 'sess_b'])
    );
  });

  test('A3b-3: canonical-checkout cwd (no worktree) still refuses (A3 preserved)', () => {
    // Two fresh envelopes + an uncorroborated pointer, caller at the canonical
    // checkout (worktreeRoot is cawsDir itself, which no registry entry
    // contains). The cwd-ownership path no-ops, so A3 ambiguity refusal fires
    // byte-identically. This is the regression guard for the existing A3
    // behavior under the new corroboration path.
    const { repoRoot, cawsDir, now } = makeProjectRoot();
    writeEnvelope(cawsDir, 'sess_a', { platform: 'zcode' });
    writeEnvelope(cawsDir, 'sess_b', { platform: 'codex' });
    writeCallerPointer(cawsDir, repoRoot, 'sess_b');
    // No worktree entry → cawsDir matches no worktree path.
    const result = resolveSession({
      cawsDir,
      worktreeRoot: cawsDir, // canonical checkout, no worktree ancestor
      env: cleanEnv(),
      now: () => now,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toMatch(/durable_envelope_ambiguous/);
    expect(result.errors[0].data.candidateSessionIds).toEqual(
      expect.arrayContaining(['sess_a', 'sess_b'])
    );
  });
});

// --- A7: agent-PID correlation (CAWS-AGENT-PID-SESSION-CORRELATION-001) -------
//
// The canonical-checkout identity bridge. The agent-PID tier fires BEFORE the
// durable-envelope scan, so a no-env-var caller resolves deterministically to
// its own session id (keyed by its agent process's PID) instead of hitting
// the ≥2-envelope ambiguity refusal. Tests inject agentProcessNames +
// agentPidWalkFn so no real process tree is required.

describe('CAWS-AGENT-PID-SESSION-CORRELATION-001 — A7: agent-PID tier', () => {
  test('A7-1: agent-PID record resolves at canonical checkout with no env var (the fix)', () => {
    // Two fresh envelopes (would normally refuse), PLUS an agent-PID record
    // naming sess_a. NO env var is set (the ZCode / generic-harness case).
    // The injected pidWalkFn returns a fixed PID matching the record.
    const { repoRoot, cawsDir, now } = makeProjectRoot();
    writeEnvelope(cawsDir, 'sess_a', { platform: 'zcode' });
    writeEnvelope(cawsDir, 'sess_b', { platform: 'codex' });
    writeAgentPidRecord(cawsDir, 4242, 'sess_a', { surface: 'zcode', startedAt: 1700 });
    const result = resolveSession({
      cawsDir,
      worktreeRoot: cawsDir, // canonical checkout
      env: cleanEnv(), // no env var
      now: () => now,
      agentProcessNames: ['zcode-cli'],
      agentPidWalkFn: () => ({ pid: 4242, startEpoch: 1700 }),
    });
    expect(result.ok).toBe(true);
    expect(result.value.identity.session_id).toBe('sess_a');
    expect(result.value.source).toBe('agent_pid_record');
    expect(result.value.identity.platform).toBe('zcode');
  });

  test('A7-2: agent-PID tier fires BEFORE the envelope scan (no ambiguity refusal)', () => {
    // Three fresh envelopes (would refuse), but the agent-PID record resolves
    // first — the envelope scan is never reached.
    const { cawsDir, now } = makeProjectRoot();
    writeEnvelope(cawsDir, 'sess_a', { platform: 'zcode' });
    writeEnvelope(cawsDir, 'sess_b', { platform: 'codex' });
    writeEnvelope(cawsDir, 'sess_c', { platform: 'claude-code' });
    writeAgentPidRecord(cawsDir, 9999, 'sess_c', { startedAt: 1700 });
    const result = resolveSession({
      cawsDir,
      worktreeRoot: cawsDir,
      env: cleanEnv(),
      now: () => now,
      agentProcessNames: ['zcode-cli'],
      agentPidWalkFn: () => ({ pid: 9999, startEpoch: 1700 }),
    });
    expect(result.ok).toBe(true);
    expect(result.value.identity.session_id).toBe('sess_c');
    expect(result.value.source).toBe('agent_pid_record');
  });

  test('A7-3: stale agent-PID record falls through to the envelope scan (fail-open)', () => {
    // A record whose last_seen_at is outside the 24h window is treated as
    // stale and ignored — the resolver falls through to the existing chain.
    const { cawsDir, now } = makeProjectRoot();
    writeEnvelope(cawsDir, 'sess_a', { platform: 'zcode' });
    writeAgentPidRecord(cawsDir, 4242, 'sess_stale', {
      lastSeenAt: '2026-07-01T00:00:00Z', // 13 days before the fixed clock
      startedAt: 1700,
    });
    const result = resolveSession({
      cawsDir,
      worktreeRoot: cawsDir,
      env: cleanEnv(),
      now: () => now,
      agentProcessNames: ['zcode-cli'],
      agentPidWalkFn: () => ({ pid: 4242, startEpoch: 1700 }),
    });
    // Did NOT resolve via the agent-PID tier (stale). sess_a's single envelope
    // resolves instead (the scan admits it as the sole candidate).
    expect(result.ok).toBe(true);
    expect(result.value.source).not.toBe('agent_pid_record');
  });

  test('A7-4: PID-reuse (start-time mismatch) falls through (fail-open)', () => {
    // The record says started_at=1700 but the live process has startEpoch=9999
    // — the PID was reused by a different process. Must NOT resolve from it.
    const { cawsDir, now } = makeProjectRoot();
    writeEnvelope(cawsDir, 'sess_a', { platform: 'zcode' });
    writeAgentPidRecord(cawsDir, 4242, 'sess-reused-pid', { startedAt: 1700 });
    const result = resolveSession({
      cawsDir,
      worktreeRoot: cawsDir,
      env: cleanEnv(),
      now: () => now,
      agentProcessNames: ['zcode-cli'],
      agentPidWalkFn: () => ({ pid: 4242, startEpoch: 9999 }), // different start
    });
    expect(result.ok).toBe(true);
    expect(result.value.source).not.toBe('agent_pid_record');
  });

  test('A7-5: unknown surface (empty process names) fail-opens to the existing chain', () => {
    // No CAWS_AGENT_PROCESS_NAMES + no injected names -> the agent-PID tier
    // returns null immediately, never calling pidWalkFn.
    const { cawsDir, now } = makeProjectRoot();
    writeEnvelope(cawsDir, 'sess_a', { platform: 'zcode' });
    writeAgentPidRecord(cawsDir, 4242, 'sess-via-pid', { startedAt: 1700 });
    let walkCalled = false;
    const result = resolveSession({
      cawsDir,
      worktreeRoot: cawsDir,
      env: cleanEnv(),
      now: () => now,
      agentProcessNames: [], // unknown surface
      agentPidWalkFn: () => { walkCalled = true; return null; },
    });
    expect(walkCalled).toBe(false); // the walk was never invoked
    expect(result.ok).toBe(true);
    expect(result.value.source).not.toBe('agent_pid_record');
  });

  test('A7-6: two concurrent sessions resolve to their OWN records (no crossing)', () => {
    // Two records for two PIDs in the same repo. Each pidWalkFn lands on its
    // own PID -> each resolves to its own session id, never the sibling's.
    const { cawsDir, now } = makeProjectRoot();
    writeAgentPidRecord(cawsDir, 1111, 'sess_a', { startedAt: 1700 });
    writeAgentPidRecord(cawsDir, 2222, 'sess_b', { startedAt: 1800 });
    const a = resolveSession({
      cawsDir, worktreeRoot: cawsDir, env: cleanEnv(), now: () => now,
      agentProcessNames: ['zcode-cli'],
      agentPidWalkFn: () => ({ pid: 1111, startEpoch: 1700 }),
    });
    const b = resolveSession({
      cawsDir, worktreeRoot: cawsDir, env: cleanEnv(), now: () => now,
      agentProcessNames: ['zcode-cli'],
      agentPidWalkFn: () => ({ pid: 2222, startEpoch: 1800 }),
    });
    expect(a.value.identity.session_id).toBe('sess_a');
    expect(b.value.identity.session_id).toBe('sess_b');
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
    expect(src).toMatch(/QWEN_CODE_SESSION_ID/);
    expect(src).toMatch(/CAWS_SESSION_ID/);
    expect(src).toMatch(/HOOK_SESSION_ID/);
  });

  test('the shared helper resolves the canonical precedence', () => {
    // Source the helper and exercise the precedence directly. Each source wins
    // in order; 'unknown' is rejected and the next source is consulted.
    const cases = [
      { env: { CLAUDE_SESSION_ID: 'a', CLAUDE_CODE_SESSION_ID: 'b', CODEX_THREAD_ID: 'c' }, want: 'a' },
      { env: { CLAUDE_CODE_SESSION_ID: 'b', CODEX_THREAD_ID: 'c', CAWS_SESSION_ID: 'd' }, want: 'b' },
      { env: { CODEX_THREAD_ID: 'c', QWEN_CODE_SESSION_ID: 'q', CAWS_SESSION_ID: 'd' }, want: 'c' },
      { env: { QWEN_CODE_SESSION_ID: 'q', CAWS_SESSION_ID: 'd', HOOK_SESSION_ID: 'e' }, want: 'q' },
      { env: { CAWS_SESSION_ID: 'd', HOOK_SESSION_ID: 'e' }, want: 'd' },
      { env: { HOOK_SESSION_ID: 'e', CURSOR_TRACE_ID: 'f' }, want: 'e' },
      { env: { CURSOR_TRACE_ID: 'f' }, want: 'f' },
      { env: { CLAUDE_CODE_SESSION_ID: 'unknown', CODEX_THREAD_ID: 'real' }, want: 'real' },
      { env: {}, want: 'unknown' },
    ];
    // CAWS-TEST-RESOLVER-ENV-INHERITANCE-001: each case must be decided ONLY by
    // the variables it sets. execSync inherits the parent environment, and every
    // agent harness exports a real session id (Claude Code exports
    // CLAUDE_CODE_SESSION_ID), which outranks the lower-precedence variables the
    // later cases set — so the helper correctly returned the inherited id and the
    // case failed. The suite passed in CI and on a bare shell and failed for every
    // agent, which is the worst shape: green exactly where nobody runs it.
    //
    // Clear the full precedence chain before applying the case's own assignments.
    // Scoped to the session variables rather than `env -i` so PATH/HOME survive
    // and the child shell still behaves like a real one.
    const SESSION_VARS = [
      'CLAUDE_SESSION_ID',
      'CLAUDE_CODE_SESSION_ID',
      'CODEX_THREAD_ID',
      'QWEN_CODE_SESSION_ID',
      'CAWS_SESSION_ID',
      'HOOK_SESSION_ID',
      'CURSOR_TRACE_ID',
    ];

    for (const { env, want } of cases) {
      const childEnv = { ...process.env };
      for (const v of SESSION_VARS) delete childEnv[v];
      Object.assign(childEnv, env);

      const out = require('child_process')
        .execSync(`bash -c 'source "${SHARED_LIB}" >/dev/null 2>&1; resolve_caws_session_id'`, {
          encoding: 'utf8',
          env: childEnv,
        })
        .trim();
      expect(out).toBe(want);
    }
  });

  test('the precedence cases are decided by the case env, not the ambient one', () => {
    // Guards the fix above against becoming vacuous. If the isolation regressed
    // to inheriting the parent environment, a deliberately-planted ambient
    // session id would win over the lower-precedence variable this case sets,
    // and the assertion would read back the planted value instead of 'e'.
    const childEnv = { ...process.env, HOOK_SESSION_ID: 'e' };
    for (const v of ['CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'QWEN_CODE_SESSION_ID', 'CAWS_SESSION_ID', 'CURSOR_TRACE_ID'])
      delete childEnv[v];
    // Plant a HIGHER-precedence id, exactly as a real harness would.
    childEnv.CLAUDE_CODE_SESSION_ID = 'ambient-leak-sentinel';

    const leaked = require('child_process')
      .execSync(`bash -c 'source "${SHARED_LIB}" >/dev/null 2>&1; resolve_caws_session_id'`, {
        encoding: 'utf8',
        env: childEnv,
      })
      .trim();

    // The helper honours precedence, so with the leak present it MUST return the
    // planted value — proving the ambient environment really can reach the child
    // and that the loop above is protected by its explicit deletion, not by luck.
    expect(leaked).toBe('ambient-leak-sentinel');
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
