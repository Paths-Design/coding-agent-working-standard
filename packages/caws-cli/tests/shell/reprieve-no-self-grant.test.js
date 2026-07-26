'use strict';

/**
 * CAWS-REPRIEVE-NO-SELF-GRANT-001 — `caws reprieve grant` refuses inside an
 * agent session.
 *
 * A reprieve weakens a PreToolUse guard. If the session the guard constrains can
 * grant its own, the guard is advisory. The motivating transcript shows a Codex
 * agent granting itself a protected-paths reprieve twice, with an in-process
 * auto-approver approving the request.
 *
 * The refusal keys on the UNION of every agent-session env var the resolver
 * consults — NOT on CAWS_SESSION_ID alone, which is fourth in precedence and was
 * never set in that transcript. A2 is the regression test for that specific
 * wrong design: it fails against a CAWS_SESSION_ID-only implementation.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const {
  runReprieveGrantCommand,
  detectAgentSessionVars,
} = require('../../dist/shell/commands/reprieve');

const SESSION = 'sess-no-self-grant';

/**
 * Seed a lease so the grant path can resolve this session's agent surface.
 * CAWS-REPRIEVE-SURFACE-DETECTION-001 derives the vendor dir from the lease of
 * the session being granted for, and refuses when there is none — an
 * unregistered session never entered governed channels. These fixtures use a
 * .claude-only substrate, so a claude-code lease preserves their original intent.
 */
function seedLease(repoRoot, sessionId, platform = 'claude-code') {
  fs.mkdirSync(path.join(repoRoot, '.caws', 'leases'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, '.caws', 'leases', `${sessionId}.json`),
    JSON.stringify({
      lease_version: 1,
      session_id: sessionId,
      platform,
      status: 'active',
      started_at: '2026-07-26T01:00:00.000Z',
      last_active: '2026-07-26T01:59:00.000Z',
      repo_root: repoRoot,
    })
  );
}

function makeRepoRoot() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-noselfgrant-'));
  execSync(
    'git init -q -b main && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m root',
    { cwd: repoRoot }
  );
  fs.mkdirSync(path.join(repoRoot, '.claude', 'hooks', 'state'), { recursive: true });
  seedLease(repoRoot, SESSION);
  return repoRoot;
}

/** A human shell: none of the agent vars present. */
const HUMAN_ENV = Object.freeze({ PATH: process.env.PATH, HOME: process.env.HOME });

function grant(repoRoot, env, extra = {}) {
  const out = [];
  const err = [];
  const code = runReprieveGrantCommand({
    cwd: repoRoot,
    now: () => new Date('2026-07-26T02:00:00.000Z'),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    handlers: 'protected-paths.sh',
    reason: 'test',
    approvedBy: '@tester',
    for: '30m',
    env,
    ...extra,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function stateFile(repoRoot, session) {
  return path.join(repoRoot, '.claude', 'hooks', 'state', `guard-reprieve-${session}.json`);
}

describe('CAWS-REPRIEVE-NO-SELF-GRANT-001: refusal inside an agent session (A1)', () => {
  // Each var alone must trigger the refusal. Table-driven so adding a var to
  // AGENT_SESSION_VARS without covering it here is visible.
  it.each([
    'CLAUDE_SESSION_ID',
    'CLAUDE_CODE_SESSION_ID',
    'CODEX_THREAD_ID',
    'CAWS_SESSION_ID',
    'HOOK_SESSION_ID',
    'CURSOR_TRACE_ID',
  ])('refuses when %s alone is set', (varName) => {
    const repoRoot = makeRepoRoot();
    const r = grant(repoRoot, { ...HUMAN_ENV, [varName]: SESSION });

    expect(r.code).toBe(1);
    expect(r.err).toContain('agents cannot grant their own reprieves');
    // The refusal must name WHICH var betrayed the session, or the operator
    // cannot tell why a shell they think is human was treated as an agent.
    expect(r.err).toContain(varName);
  });

  it('writes no state file and no audit log when it refuses', () => {
    const repoRoot = makeRepoRoot();
    const r = grant(repoRoot, { ...HUMAN_ENV, CLAUDE_CODE_SESSION_ID: SESSION });

    expect(r.code).toBe(1);
    expect(fs.existsSync(stateFile(repoRoot, SESSION))).toBe(false);
    // The guard runs before the state dir is even resolved, so the vendor logs
    // dir must not have been created as a side effect of a refused grant.
    expect(fs.existsSync(path.join(repoRoot, '.claude', 'logs', 'guard-reprieves.log'))).toBe(false);
  });

  it('refuses even when --session is passed explicitly', () => {
    // --session sets the RECORD's id; it does not change who is running the
    // command. An agent naming a different session must not slip through.
    const repoRoot = makeRepoRoot();
    const r = grant(repoRoot, { ...HUMAN_ENV, CODEX_THREAD_ID: SESSION }, { session: 'some-other-session' });

    expect(r.code).toBe(1);
    expect(r.err).toContain('agents cannot grant their own reprieves');
    expect(fs.existsSync(stateFile(repoRoot, 'some-other-session'))).toBe(false);
  });
});

describe('CAWS-REPRIEVE-NO-SELF-GRANT-001: the Codex-shaped session (A2)', () => {
  // THE regression test. This is the exact env shape from the transcript: a
  // Codex agent with CODEX_THREAD_ID set and CAWS_SESSION_ID absent. A guard
  // keyed on CAWS_SESSION_ID alone — the originally-proposed design — returns
  // exit 0 here and writes the record. This test is what makes that design
  // failure visible rather than theoretical.
  it('refuses a session with CODEX_THREAD_ID set and CAWS_SESSION_ID absent', () => {
    const repoRoot = makeRepoRoot();
    const env = { ...HUMAN_ENV, CODEX_THREAD_ID: '019f9b5e-b0e4-7b90-88b4-1952fdc68495' };
    expect(env.CAWS_SESSION_ID).toBeUndefined();

    const r = grant(repoRoot, env);

    expect(r.code).toBe(1);
    expect(r.err).toContain('agents cannot grant their own reprieves');
    expect(r.err).toContain('CODEX_THREAD_ID');
    expect(
      fs.existsSync(stateFile(repoRoot, '019f9b5e-b0e4-7b90-88b4-1952fdc68495'))
    ).toBe(false);
  });

  it('detectAgentSessionVars reports CODEX_THREAD_ID without CAWS_SESSION_ID', () => {
    expect(detectAgentSessionVars({ CODEX_THREAD_ID: 'x' })).toEqual(['CODEX_THREAD_ID']);
    expect(detectAgentSessionVars({ CAWS_SESSION_ID: 'x' })).toEqual(['CAWS_SESSION_ID']);
  });

  it('reports every set var, not just the highest-precedence one', () => {
    // Precedence governs which id WINS; the guard cares that any is present.
    const found = detectAgentSessionVars({
      CLAUDE_SESSION_ID: 'a',
      CODEX_THREAD_ID: 'b',
      CURSOR_TRACE_ID: 'c',
    });
    expect(found).toEqual(['CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'CURSOR_TRACE_ID']);
  });

  it('ignores empty and "unknown" values, which are not real sessions', () => {
    expect(detectAgentSessionVars({ CLAUDE_SESSION_ID: '' })).toEqual([]);
    expect(detectAgentSessionVars({ CLAUDE_SESSION_ID: 'unknown' })).toEqual([]);
  });
});

describe('CAWS-REPRIEVE-NO-SELF-GRANT-001: the human path is not collateral damage (A3)', () => {
  it('grants normally when no agent env var is set', () => {
    const repoRoot = makeRepoRoot();
    const r = grant(repoRoot, HUMAN_ENV, { session: SESSION });

    expect(r.err).not.toContain('agents cannot grant');
    expect(r.code).toBe(0);
    const record = JSON.parse(fs.readFileSync(stateFile(repoRoot, SESSION), 'utf8'));
    expect(record.handlers).toEqual(['protected-paths.sh']);
    expect(record.expires_at).toBe('2026-07-26T02:30:00.000Z');
  });
});

describe('CAWS-REPRIEVE-NO-SELF-GRANT-001: evasion is self-punishing (A4)', () => {
  it('refuses when every agent var is cleared, because no session resolves', () => {
    // `env -u CLAUDE_CODE_SESSION_ID ... caws reprieve grant` clears the guard
    // signal, but the guard signal IS the session source: the grant then fails
    // for lack of an id. The two failure modes are different messages, and
    // neither writes a record — that is the property worth pinning.
    const repoRoot = makeRepoRoot();
    const r = grant(repoRoot, HUMAN_ENV); // no --session, no agent vars

    expect(r.code).toBe(1);
    expect(r.err).toContain('could not resolve a session id');
    expect(r.err).not.toContain('agents cannot grant their own reprieves');
    expect(fs.readdirSync(path.join(repoRoot, '.claude', 'hooks', 'state'))).toEqual([]);
  });
});

describe('CAWS-REPRIEVE-NO-SELF-GRANT-001: the refusal terminates in a remedy (A5)', () => {
  it('names a runnable human command instead of leaving a dead end', () => {
    const repoRoot = makeRepoRoot();
    const r = grant(repoRoot, { ...HUMAN_ENV, CLAUDE_CODE_SESSION_ID: SESSION });

    // A blocked path with no stated remedy is what pushes an agent toward
    // hand-editing the state JSON — the bypass this command exists to replace.
    expect(r.err).toContain('OUTSIDE the agent session');
    expect(r.err).toContain('caws reprieve grant --handlers protected-paths.sh');
    expect(r.err).toContain('--approved-by');
    // Must advertise the relative-expiry form, not send the human back to ISO.
    expect(r.err).toContain('--for 30m');
  });

  it('echoes the actual handlers argument into the suggested command', () => {
    const repoRoot = makeRepoRoot();
    const r = grant(
      repoRoot,
      { ...HUMAN_ENV, CLAUDE_CODE_SESSION_ID: SESSION },
      { handlers: 'worktree-write-guard.sh,bash-write-guard.sh' }
    );
    expect(r.err).toContain('--handlers worktree-write-guard.sh,bash-write-guard.sh');
  });
});
