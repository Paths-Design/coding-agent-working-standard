/**
 * @fileoverview CAWSFIX-31 — agent claim model.
 * Tests the session-id-based claim/takeover protocol on worktree
 * lifecycle operations, the lifecycle refresh on agents.json, and the
 * session-log pointer surfacing.
 *
 * Pattern: real-fs tmpdir + CLAUDE_SESSION_ID env to control session
 * identity. Same primitive-first style as specs-archive.test.js.
 *
 * Covers A1-A10 from .caws/specs/CAWSFIX-31.yaml.
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let originalCwd;
let tempDir;
let originalSessionEnv;

const SELF = 'session-self-aaa';
const OTHER = 'session-other-bbb';

// Fixture timestamps must be recent or loadAgentRegistry's TTL prune
// (default 30 min) will drop them on read. We anchor relative to
// Date.now() at the time the test runs.
const recentIso = (offsetMs = 0) => new Date(Date.now() - offsetMs).toISOString();
const NOW_ISO = () => recentIso(0);
const FIVE_MIN_AGO = () => recentIso(5 * 60 * 1000);
const TEN_MIN_AGO = () => recentIso(10 * 60 * 1000);

const writeWorktreesRegistry = (worktrees) => {
  const dir = path.join(tempDir, '.caws');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'worktrees.json'),
    JSON.stringify({ version: 1, worktrees }, null, 2)
  );
};

const writeAgentsRegistry = (agents) => {
  const dir = path.join(tempDir, '.caws');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'agents.json'),
    JSON.stringify({ version: 1, agents }, null, 2)
  );
};

const writeSessionLog = (sessionId, meta, turnCount = 0) => {
  const dir = path.join(tempDir, 'tmp', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, 'session.txt'), '# Session log\n');
  for (let i = 1; i <= turnCount; i++) {
    fs.writeFileSync(
      path.join(dir, `turn-${String(i).padStart(3, '0')}.json`),
      JSON.stringify({ turn: i, ts_end: meta.last_turn_iso || meta.local_time })
    );
  }
};

const setSelf = () => {
  process.env.CLAUDE_SESSION_ID = SELF;
};

const baseWorktreeEntry = (name, owner) => {
  // saveRegistry auto-prunes entries whose path AND branch are both missing
  // (CAWSFIX-25 D7). For takeover tests we need the entry to survive a
  // saveRegistry round-trip, so materialize the path directory.
  const wtPath = path.join(tempDir, '.caws', 'worktrees', name);
  fs.mkdirSync(wtPath, { recursive: true });
  return {
    name,
    path: wtPath,
    branch: `caws/${name}`,
    baseBranch: 'main',
    scope: null,
    specId: null,
    owner,
    createdAt: '2026-04-27T00:00:00.000Z',
    status: 'active',
  };
};

describe('CAWSFIX-31 — agent claim model', () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    originalSessionEnv = process.env.CLAUDE_SESSION_ID;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawsfix-31-'));
    fs.mkdirSync(path.join(tempDir, '.caws', 'specs'), { recursive: true });
    process.chdir(tempDir);
    jest.resetModules();
    setSelf();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalSessionEnv === undefined) {
      delete process.env.CLAUDE_SESSION_ID;
    } else {
      process.env.CLAUDE_SESSION_ID = originalSessionEnv;
    }
  });

  test('A1: lifecycle op in worktree owned by current session id is silent + heartbeats', () => {
    writeWorktreesRegistry({ wt1: baseWorktreeEntry('wt1', SELF) });
    writeAgentsRegistry({});

    const { assertWorktreeOwnership } = require('../src/worktree/worktree-manager');
    const result = assertWorktreeOwnership(tempDir, 'wt1', { allowTakeover: false });

    expect(result.allowed).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.priorOwner).toBeUndefined();

    const { refreshAgentClaim } = require('../src/utils/agent-session');
    refreshAgentClaim(tempDir, { worktree: 'wt1', specId: null });

    const agents = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.caws', 'agents.json'), 'utf8')
    );
    expect(agents.agents[SELF]).toBeDefined();
    expect(agents.agents[SELF].worktree).toBe('wt1');
    expect(agents.agents[SELF].lastSeen).toBeTruthy();
  });

  test('A2: foreign claim soft-blocks without --takeover and surfaces context', () => {
    writeWorktreesRegistry({ wt2: baseWorktreeEntry('wt2', OTHER) });
    writeAgentsRegistry({
      [OTHER]: {
        sessionId: OTHER,
        platform: 'claude-code',
        model: 'claude-opus-4-7',
        specId: null,
        worktree: 'wt2',
        ttl: 1800000,
        firstSeen: TEN_MIN_AGO(),
        lastSeen: FIVE_MIN_AGO(),
      },
    });

    const { assertWorktreeOwnership } = require('../src/worktree/worktree-manager');
    const result = assertWorktreeOwnership(tempDir, 'wt2', { allowTakeover: false });

    expect(result.allowed).toBe(false);
    expect(result.warning).toBeTruthy();
    expect(result.warning).toMatch(new RegExp(OTHER));
    expect(result.warning).toMatch(/claude-code/);
    expect(result.warning).toMatch(/--takeover/);
    expect(result.warning).toMatch(/wt2/);
  });

  test('A3: --takeover overwrites owner and writes prior_owners audit with lastSeen', () => {
    const otherLastSeen = FIVE_MIN_AGO();
    writeWorktreesRegistry({ wt3: baseWorktreeEntry('wt3', OTHER) });
    writeAgentsRegistry({
      [OTHER]: {
        sessionId: OTHER,
        platform: 'cursor',
        model: 'unknown',
        specId: null,
        worktree: 'wt3',
        ttl: 1800000,
        firstSeen: TEN_MIN_AGO(),
        lastSeen: otherLastSeen,
      },
    });

    const { assertWorktreeOwnership } = require('../src/worktree/worktree-manager');
    const result = assertWorktreeOwnership(tempDir, 'wt3', { allowTakeover: true });

    expect(result.allowed).toBe(true);
    expect(result.priorOwner).toBeDefined();

    const registry = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.caws', 'worktrees.json'), 'utf8')
    );
    const entry = registry.worktrees.wt3;
    expect(entry.owner).toBe(SELF);
    expect(Array.isArray(entry.prior_owners)).toBe(true);
    expect(entry.prior_owners.length).toBe(1);
    expect(entry.prior_owners[0].sessionId).toBe(OTHER);
    expect(entry.prior_owners[0].platform).toBe('cursor');
    expect(entry.prior_owners[0].lastSeen).toBe(otherLastSeen);
    expect(entry.prior_owners[0].takenOver_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('A4: TTL-pruned agents.json entry still soft-blocks; warning notes stale heartbeat', () => {
    writeWorktreesRegistry({ wt4: baseWorktreeEntry('wt4', OTHER) });
    // agents.json deliberately empty — OTHER's entry was pruned.
    writeAgentsRegistry({});

    const { assertWorktreeOwnership } = require('../src/worktree/worktree-manager');
    const result = assertWorktreeOwnership(tempDir, 'wt4', { allowTakeover: false });

    expect(result.allowed).toBe(false);
    expect(result.warning).toMatch(new RegExp(OTHER));
    expect(result.warning).toMatch(/no live agent registry entry|stale|pruned/i);
    expect(result.warning).toMatch(/--takeover/);

    // Takeover with null lastSeen captured
    const tk = assertWorktreeOwnership(tempDir, 'wt4', { allowTakeover: true });
    expect(tk.allowed).toBe(true);
    const registry = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.caws', 'worktrees.json'), 'utf8')
    );
    expect(registry.worktrees.wt4.prior_owners[0].lastSeen).toBeNull();
  });

  test('A5: caws agents list shows all platforms in <sid>:<platform> format', () => {
    writeAgentsRegistry({
      [SELF]: {
        sessionId: SELF,
        platform: 'claude-code',
        model: 'claude-opus-4-7',
        specId: 'FOO-01',
        worktree: null,
        ttl: 1800000,
        firstSeen: TEN_MIN_AGO(),
        lastSeen: NOW_ISO(),
      },
      [OTHER]: {
        sessionId: OTHER,
        platform: 'cursor',
        model: 'unknown',
        specId: null,
        worktree: 'wt5',
        ttl: 1800000,
        firstSeen: TEN_MIN_AGO(),
        lastSeen: FIVE_MIN_AGO(),
      },
      'session-third-ccc': {
        sessionId: 'session-third-ccc',
        platform: 'unknown',
        model: null,
        specId: null,
        worktree: null,
        ttl: 1800000,
        firstSeen: TEN_MIN_AGO(),
        lastSeen: FIVE_MIN_AGO(),
      },
    });

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { agentsCommand } = require('../src/commands/agents');
    agentsCommand('list', {});

    const out = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    logSpy.mockRestore();

    expect(out).toMatch(new RegExp(`${SELF}:claude-code`));
    expect(out).toMatch(new RegExp(`${OTHER}:cursor`));
    expect(out).toMatch(/session-third-ccc:unknown/);
    expect(out).toMatch(/wt5/);
    expect(out).toMatch(/FOO-01/);
  });

  test('A6: specs create/close/archive/delete and worktree create refresh agents.json with current specId/worktree', async () => {
    writeAgentsRegistry({});

    const { createSpec, closeSpec, archiveSpec, deleteSpec } = require('../src/commands/specs');

    // create — should refresh with specId
    await createSpec('REFR-01', { type: 'feature', title: 'Refresh probe' });
    let agents = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.caws', 'agents.json'), 'utf8')
    );
    expect(agents.agents[SELF]).toBeDefined();
    expect(agents.agents[SELF].specId).toBe('REFR-01');

    // close — should refresh
    const closed = await closeSpec('REFR-01');
    expect(closed).toBe(true);
    agents = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.caws', 'agents.json'), 'utf8')
    );
    expect(agents.agents[SELF].specId).toBe('REFR-01');

    // archive — should refresh + still set specId
    const archived = await archiveSpec('REFR-01');
    expect(archived).toBe(true);
    agents = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.caws', 'agents.json'), 'utf8')
    );
    expect(agents.agents[SELF].specId).toBe('REFR-01');

    // delete — should refresh (consistency: every lifecycle verb refreshes)
    // Re-create so we have something to delete
    await createSpec('REFR-02', { type: 'feature', title: 'Delete probe' });
    const deleted = await deleteSpec('REFR-02');
    expect(deleted).toBe(true);
    agents = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.caws', 'agents.json'), 'utf8')
    );
    expect(agents.agents[SELF].specId).toBe('REFR-02');
    expect(agents.agents[SELF].lastSeen).toBeTruthy();
  });

  test('A7: foreign-claim warning includes session-log pointer when tmp/<sid>/ exists with matching branch', () => {
    writeWorktreesRegistry({ wt7: baseWorktreeEntry('wt7', OTHER) });
    writeAgentsRegistry({
      [OTHER]: {
        sessionId: OTHER,
        platform: 'claude-code',
        model: 'claude-opus-4-7',
        specId: null,
        worktree: 'wt7',
        ttl: 1800000,
        firstSeen: TEN_MIN_AGO(),
        lastSeen: FIVE_MIN_AGO(),
      },
    });
    writeSessionLog(
      OTHER,
      {
        session_id: OTHER,
        local_time: '2026-04-27 10:00:00 PDT',
        model: 'claude-opus-4-7',
        branch: 'caws/wt7',
        last_turn_iso: '2026-04-27T17:28:00.000Z',
      },
      5
    );

    const { assertWorktreeOwnership } = require('../src/worktree/worktree-manager');
    const result = assertWorktreeOwnership(tempDir, 'wt7', { allowTakeover: false });

    expect(result.allowed).toBe(false);
    expect(result.warning).toMatch(new RegExp(`tmp[\\\\\\/]${OTHER}`));
    expect(result.warning).toMatch(/5 turns?/);
  });

  test('A8: unowned worktree with matching session-log surfaces softer notice but proceeds', () => {
    writeWorktreesRegistry({ wt8: baseWorktreeEntry('wt8', null) });
    writeAgentsRegistry({});
    writeSessionLog(
      OTHER,
      {
        session_id: OTHER,
        local_time: '2026-04-27 10:00:00 PDT',
        model: 'claude-opus-4-7',
        branch: 'caws/wt8',
        last_turn_iso: '2026-04-27T17:30:00.000Z',
      },
      3
    );

    const { assertWorktreeOwnership } = require('../src/worktree/worktree-manager');
    const result = assertWorktreeOwnership(tempDir, 'wt8', { allowTakeover: false });

    expect(result.allowed).toBe(true);
    expect(result.warning).toBeTruthy();
    expect(result.warning).toMatch(/may still be active|read.*context|previous session/i);
    expect(result.warning).toMatch(new RegExp(`tmp[\\\\\\/]${OTHER}`));
  });

  test('A9: caws status renders Claim panel inside a worktree', () => {
    writeWorktreesRegistry({ wt9: baseWorktreeEntry('wt9', SELF) });
    writeAgentsRegistry({
      [SELF]: {
        sessionId: SELF,
        platform: 'claude-code',
        model: 'claude-opus-4-7',
        specId: 'WT9-01',
        worktree: 'wt9',
        ttl: 1800000,
        firstSeen: TEN_MIN_AGO(),
        lastSeen: FIVE_MIN_AGO(),
      },
    });

    const { renderClaimPanel } = require('../src/utils/agent-display');
    const panel = renderClaimPanel(tempDir, 'wt9');

    expect(panel).toMatch(new RegExp(`${SELF}:claude-code`));
    expect(panel).toMatch(/wt9/);
    expect(panel).toMatch(/Claim/);

    // No-claim case
    writeWorktreesRegistry({ wt9: baseWorktreeEntry('wt9', null) });
    const empty = renderClaimPanel(tempDir, 'wt9');
    expect(empty).toMatch(/no active claim/i);
  });

  test('A10: caws worktree claim <name> without --takeover is read-only on foreign claim', async () => {
    writeWorktreesRegistry({ wt10: baseWorktreeEntry('wt10', OTHER) });
    writeAgentsRegistry({
      [OTHER]: {
        sessionId: OTHER,
        platform: 'claude-code',
        model: 'claude-opus-4-7',
        specId: null,
        worktree: 'wt10',
        ttl: 1800000,
        firstSeen: TEN_MIN_AGO(),
        lastSeen: FIVE_MIN_AGO(),
      },
    });

    // worktreeCommand path goes through getRepoRoot() which shells `git
    // rev-parse`. Bootstrap a real git repo so the resolution works.
    const { execFileSync } = require('child_process');
    execFileSync('git', ['init', '-q'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });

    // Record-only exit mock — DO NOT throw. worktreeCommand has an outer
    // catch that calls process.exit again on re-throw, which would escape
    // the worker (see specs-creation.test.js:53 for the canonical pattern).
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});

    const { worktreeCommand } = require('../src/commands/worktree');
    await worktreeCommand('claim', { name: 'wt10' });

    expect(exitSpy).toHaveBeenCalled();
    const exitCode = exitSpy.mock.calls[0][0];
    // Specifically code 1 — distinguishes "claim refused" from
    // "Unknown subcommand" (which is the current pre-implementation state
    // and would also exit non-zero, but with a different code path).
    expect(exitCode).toBe(1);

    // No state change — owner stays OTHER, no prior_owners array
    const registry = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.caws', 'worktrees.json'), 'utf8')
    );
    expect(registry.worktrees.wt10.owner).toBe(OTHER);
    expect(registry.worktrees.wt10.prior_owners).toBeUndefined();

    // Surfaced context: warning includes claimer + --takeover hint
    const out = [
      ...errSpy.mock.calls.map((c) => c.join(' ')),
      ...logSpy.mock.calls.map((c) => c.join(' ')),
    ].join('\n');
    expect(out).toMatch(new RegExp(`${OTHER}`));
    expect(out).toMatch(/--takeover/);

    errSpy.mockRestore();
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
