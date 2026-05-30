/**
 * Tests for `runStatusCommand` — vNext read-only dashboard.
 *
 * Invariant under test: status is READ-ONLY. It must not mutate:
 *   - agents.json (no heartbeat refresh)
 *   - worktrees.json (no registry mutation)
 *   - .caws/sessions/ (no capsule mint)
 *   - .caws/events.jsonl (no events appended)
 *   - specs (no lifecycle transitions)
 *
 * Exit codes:
 *   0 = rendered successfully (regardless of doctor findings)
 *   2 = repo-root / store composition failure
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runStatusCommand } = require('../../dist/shell');

const NOW = new Date('2026-05-14T20:00:00.000Z');

const VALID_SPEC = (id, lifecycle = 'active', worktree) => `id: ${id}
title: A reasonably long title for the feature being shipped
risk_tier: 3
mode: feature
lifecycle_state: ${lifecycle}
${worktree !== undefined ? `worktree: ${worktree}\n` : ''}blast_radius:
  modules:
    - src/test
scope:
  in:
    - "src/**"
invariants:
  - "Some invariant."
acceptance:
  - id: A1
    given: a precondition
    when: an action
    then: an outcome
non_functional: {}
contracts: []
`;

const VALID_POLICY = `version: 1
risk_tiers:
  "1": { max_files: 5, max_loc: 200 }
  "2": { max_files: 15, max_loc: 600 }
  "3": { max_files: 30, max_loc: 1500 }
gates:
  budget_limit: { enabled: true, mode: block }
  spec_completeness: { enabled: true, mode: block }
  scope_boundary: { enabled: true, mode: block }
  god_object: { enabled: true, mode: warn }
  todo_detection: { enabled: true, mode: warn }
`;

function mkTempGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', [
    '-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init',
  ]);
  fs.mkdirSync(path.join(root, '.caws', 'specs'), { recursive: true });
  return root;
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function captureRun(opts) {
  const outLines = [];
  const errLines = [];
  const code = runStatusCommand({
    now: () => NOW,
    out: (s) => outLines.push(s),
    err: (s) => errLines.push(s),
    ...opts,
  });
  return { code, stdout: outLines.join('\n'), stderr: errLines.join('\n') };
}

function readFileOrUndefined(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

function snapshotDir(cawsDir) {
  // Capture file contents we will later assert are unchanged.
  return {
    agents: readFileOrUndefined(path.join(cawsDir, 'agents.json')),
    worktrees: readFileOrUndefined(path.join(cawsDir, 'worktrees.json')),
    events: readFileOrUndefined(path.join(cawsDir, 'events.jsonl')),
    sessionsExists: fs.existsSync(path.join(cawsDir, 'sessions')),
  };
}

describe('runStatusCommand — exit 2 composition', () => {
  let nonGitDir;
  afterEach(() => rmrf(nonGitDir));

  it('cwd outside a git repo → exit 2', () => {
    nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-status-nogit-'));
    const r = captureRun({ cwd: nonGitDir });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/failed to resolve repo root/);
  });
});

describe('runStatusCommand — exit 0 happy paths', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('clean minimal state (valid spec + policy) renders and exits 0', () => {
    repoRoot = mkTempGitRepo('caws-status-clean-');
    fs.writeFileSync(
      path.join(repoRoot, '.caws', 'specs', 'FOO-1.yaml'),
      VALID_SPEC('FOO-1')
    );
    fs.writeFileSync(path.join(repoRoot, '.caws', 'policy.yaml'), VALID_POLICY);
    const r = captureRun({
      cwd: repoRoot,
      env: { CLAUDE_SESSION_ID: 'sess-me' },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('CAWS Status');
    expect(r.stdout).toContain('Project');
    expect(r.stdout).toMatch(/policy:\s+loaded/);
    expect(r.stdout).toMatch(/specs:\s+1 active/);
    expect(r.stdout).toContain('Current context');
    expect(r.stdout).toMatch(/session:\s+sess-me:claude-code/);
    expect(r.stdout).toContain('Doctor');
  });

  it('missing policy renders doctor.policy.missing but still exits 0', () => {
    repoRoot = mkTempGitRepo('caws-status-nopolicy-');
    fs.writeFileSync(
      path.join(repoRoot, '.caws', 'specs', 'FOO-1.yaml'),
      VALID_SPEC('FOO-1')
    );
    const r = captureRun({
      cwd: repoRoot,
      env: { CLAUDE_SESSION_ID: 'sess-me' },
    });
    expect(r.code).toBe(0); // observability, not a gate
    expect(r.stdout).toMatch(/policy:\s+MISSING/);
    expect(r.stdout).toMatch(/doctor\.policy\.missing/);
  });

  it('unbound active spec surfaces in doctor findings; status still exits 0', () => {
    repoRoot = mkTempGitRepo('caws-status-unbound-');
    fs.writeFileSync(
      path.join(repoRoot, '.caws', 'specs', 'FOO-1.yaml'),
      VALID_SPEC('FOO-1', 'active') // active but no worktree binding
    );
    fs.writeFileSync(path.join(repoRoot, '.caws', 'policy.yaml'), VALID_POLICY);
    const r = captureRun({
      cwd: repoRoot,
      env: { CLAUDE_SESSION_ID: 'sess-me' },
    });
    expect(r.code).toBe(0);
    // The kernel's doctor surfaces an unbound-active finding under
    // doctor.spec.*. We don't pin the exact rule id here — that's
    // doctor's contract — but the rule namespace should show up.
    expect(r.stdout).toMatch(/doctor\.spec\./);
  });

  it('read-only session: no CLAUDE_SESSION_ID env → status renders "unresolved"', () => {
    repoRoot = mkTempGitRepo('caws-status-nosess-');
    fs.writeFileSync(path.join(repoRoot, '.caws', 'policy.yaml'), VALID_POLICY);
    const r = captureRun({
      cwd: repoRoot,
      env: {}, // no CLAUDE_SESSION_ID, no CURSOR_TRACE_ID
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/session:\s+unresolved \(read-only/);
  });
});

describe('CAWS-STATUS-UNBOUND-ENFORCEMENT-CAVEAT-001: unbound ≠ free (Event 8)', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  // A1: unbound on the main checkout WITH an active spec → the binding line
  // says scope is still enforced (union mode), so a first-timer does not read
  // 'unbound' as 'unrestricted'.
  it('A1: unbound + 1 active spec → binding line carries union-mode enforcement caveat', () => {
    repoRoot = mkTempGitRepo('caws-status-caveat-active-');
    fs.writeFileSync(
      path.join(repoRoot, '.caws', 'specs', 'FOO-1.yaml'),
      VALID_SPEC('FOO-1', 'active') // active, no worktree binding → unbound here
    );
    fs.writeFileSync(path.join(repoRoot, '.caws', 'policy.yaml'), VALID_POLICY);
    const r = captureRun({
      cwd: repoRoot,
      env: { CLAUDE_SESSION_ID: 'sess-me' },
    });
    expect(r.code).toBe(0);
    // Still names 'unbound' but qualifies it with the enforcement reality.
    expect(r.stdout).toMatch(
      /binding:\s+unbound \(scope still enforced — union mode over 1 active spec\)/
    );
  });

  // A2: unbound with ZERO active specs → a bare 'unbound', no caveat (nothing
  // active to enforce, so the word is accurate as-is).
  it('A2: unbound + 0 active specs → bare "unbound", no enforcement caveat', () => {
    repoRoot = mkTempGitRepo('caws-status-caveat-none-');
    fs.writeFileSync(path.join(repoRoot, '.caws', 'policy.yaml'), VALID_POLICY);
    // No specs written → 0 active.
    const r = captureRun({
      cwd: repoRoot,
      env: { CLAUDE_SESSION_ID: 'sess-me' },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/binding:\s+unbound(\s|$)/);
    expect(r.stdout).not.toContain('scope still enforced');
  });

  // A2 (closed specs are not active): a closed spec must NOT trigger the
  // caveat — only active specs participate in union-mode enforcement.
  it('A2: unbound + only a CLOSED spec → no caveat (closed is terminal)', () => {
    repoRoot = mkTempGitRepo('caws-status-caveat-closed-');
    fs.writeFileSync(
      path.join(repoRoot, '.caws', 'specs', 'OLD-1.yaml'),
      VALID_SPEC('OLD-1', 'closed')
    );
    fs.writeFileSync(path.join(repoRoot, '.caws', 'policy.yaml'), VALID_POLICY);
    const r = captureRun({
      cwd: repoRoot,
      env: { CLAUDE_SESSION_ID: 'sess-me' },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('scope still enforced');
  });

  // A1 (plural): two active specs → the caveat pluralizes the count.
  it('A1: unbound + 2 active specs → caveat names "2 active specs" (plural)', () => {
    repoRoot = mkTempGitRepo('caws-status-caveat-two-');
    fs.writeFileSync(
      path.join(repoRoot, '.caws', 'specs', 'FOO-1.yaml'),
      VALID_SPEC('FOO-1', 'active')
    );
    fs.writeFileSync(
      path.join(repoRoot, '.caws', 'specs', 'BAR-2.yaml'),
      VALID_SPEC('BAR-2', 'active')
    );
    fs.writeFileSync(path.join(repoRoot, '.caws', 'policy.yaml'), VALID_POLICY);
    const r = captureRun({
      cwd: repoRoot,
      env: { CLAUDE_SESSION_ID: 'sess-me' },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(
      /binding:\s+unbound \(scope still enforced — union mode over 2 active specs\)/
    );
  });
});

describe('runStatusCommand — MUST NOT mutate state', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  function setupRepoWithStateFiles() {
    repoRoot = mkTempGitRepo('caws-status-readonly-');
    fs.writeFileSync(
      path.join(repoRoot, '.caws', 'specs', 'FOO-1.yaml'),
      VALID_SPEC('FOO-1')
    );
    fs.writeFileSync(path.join(repoRoot, '.caws', 'policy.yaml'), VALID_POLICY);
    fs.writeFileSync(
      path.join(repoRoot, '.caws', 'agents.json'),
      JSON.stringify(
        {
          'sess-other': {
            session_id: 'sess-other',
            platform: 'cursor',
            last_active: '2026-05-13T10:00:00.000Z',
          },
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(repoRoot, '.caws', 'worktrees.json'),
      JSON.stringify({}, null, 2)
    );
    return path.join(repoRoot, '.caws');
  }

  it('does not mutate agents.json', () => {
    const cawsDir = setupRepoWithStateFiles();
    const before = snapshotDir(cawsDir);
    const r = captureRun({
      cwd: repoRoot,
      env: { CLAUDE_SESSION_ID: 'sess-me' }, // a different session than the one in agents.json
    });
    expect(r.code).toBe(0);
    const after = snapshotDir(cawsDir);
    expect(after.agents).toBe(before.agents);
  });

  it('does not mutate worktrees.json', () => {
    const cawsDir = setupRepoWithStateFiles();
    const before = snapshotDir(cawsDir);
    const r = captureRun({
      cwd: repoRoot,
      env: { CLAUDE_SESSION_ID: 'sess-me' },
    });
    expect(r.code).toBe(0);
    const after = snapshotDir(cawsDir);
    expect(after.worktrees).toBe(before.worktrees);
  });

  it('does not append to events.jsonl', () => {
    const cawsDir = setupRepoWithStateFiles();
    // No events.jsonl exists initially.
    expect(fs.existsSync(path.join(cawsDir, 'events.jsonl'))).toBe(false);
    const r = captureRun({
      cwd: repoRoot,
      env: { CLAUDE_SESSION_ID: 'sess-me' },
    });
    expect(r.code).toBe(0);
    // Still no events.jsonl after status runs.
    expect(fs.existsSync(path.join(cawsDir, 'events.jsonl'))).toBe(false);
  });

  it('does not mint a session capsule when CLAUDE_SESSION_ID is absent', () => {
    const cawsDir = setupRepoWithStateFiles();
    const r = captureRun({
      cwd: repoRoot,
      env: {}, // no env identity at all
    });
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(cawsDir, 'sessions'))).toBe(false);
  });

  it('does not modify spec files', () => {
    const cawsDir = setupRepoWithStateFiles();
    const specPath = path.join(cawsDir, 'specs', 'FOO-1.yaml');
    const before = fs.readFileSync(specPath, 'utf8');
    const r = captureRun({
      cwd: repoRoot,
      env: { CLAUDE_SESSION_ID: 'sess-me' },
    });
    expect(r.code).toBe(0);
    const after = fs.readFileSync(specPath, 'utf8');
    expect(after).toBe(before);
  });
});

describe('runStatusCommand — claim panel inside bound worktree', () => {
  let mainRoot;
  let worktreeRoot;
  let cleanup;

  function setupBoundWorktree({ ownerSession, ownerStaleAgentMs }) {
    mainRoot = mkTempGitRepo('caws-status-bound-');
    fs.writeFileSync(path.join(mainRoot, '.caws', 'policy.yaml'), VALID_POLICY);
    fs.writeFileSync(
      path.join(mainRoot, '.caws', 'specs', 'FOO-1.yaml'),
      VALID_SPEC('FOO-1', 'active', 'wt-foo')
    );
    worktreeRoot = path.join(
      os.tmpdir(),
      `caws-status-wt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    );
    execFileSync('git', [
      '-C', mainRoot, 'worktree', 'add', '-b', `b-${Date.now().toString(36)}`,
      worktreeRoot,
    ]);
    fs.writeFileSync(
      path.join(mainRoot, '.caws', 'worktrees.json'),
      JSON.stringify(
        {
          'wt-foo': {
            specId: 'FOO-1',
            path: worktreeRoot,
            owner: ownerSession,
            last_heartbeat: '2026-05-14T11:00:00.000Z',
          },
        },
        null,
        2
      )
    );
    if (ownerStaleAgentMs !== undefined) {
      const oldTs = new Date(NOW.getTime() - ownerStaleAgentMs).toISOString();
      fs.writeFileSync(
        path.join(mainRoot, '.caws', 'agents.json'),
        JSON.stringify(
          {
            [ownerSession.session_id]: {
              ...ownerSession,
              last_active: oldTs,
            },
          },
          null,
          2
        )
      );
    }
    cleanup = () => {
      try {
        execFileSync('git', [
          '-C', mainRoot, 'worktree', 'remove', '--force', worktreeRoot,
        ]);
      } catch { /* ignore */ }
      rmrf(mainRoot);
      rmrf(worktreeRoot);
    };
  }

  afterEach(() => cleanup && cleanup());

  it('renders OWNED (you) when current session owns the worktree', () => {
    setupBoundWorktree({
      ownerSession: { session_id: 'sess-me', platform: 'claude-code' },
    });
    const r = captureRun({
      cwd: worktreeRoot,
      env: { CLAUDE_SESSION_ID: 'sess-me' },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/OWNED \(you\)/);
    expect(r.stdout).toMatch(/binding:\s+bound → FOO-1/);
  });

  it('renders OWNED (foreign) when a different session owns the worktree', () => {
    setupBoundWorktree({
      ownerSession: { session_id: 'sess-other', platform: 'cursor' },
    });
    const r = captureRun({
      cwd: worktreeRoot,
      env: { CLAUDE_SESSION_ID: 'sess-me' },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/OWNED \(foreign\)/);
    expect(r.stdout).toMatch(/sess-other:cursor/);
  });

  it('stale foreign owner — heartbeat labeled stale, no takeover implication', () => {
    // 2 days back, exceeds the default 24h ttl.
    setupBoundWorktree({
      ownerSession: { session_id: 'sess-other', platform: 'cursor' },
      ownerStaleAgentMs: 2 * 24 * 60 * 60 * 1000,
    });
    const r = captureRun({
      cwd: worktreeRoot,
      env: { CLAUDE_SESSION_ID: 'sess-me' },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/OWNED \(foreign\)/);
    // The stale label must show; takeover hint must NOT.
    expect(r.stdout).toMatch(/stale.*display only.*NOT abandonment/);
    expect(r.stdout).not.toMatch(/--takeover/);
  });
});
