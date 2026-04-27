/**
 * @fileoverview CAWSFIX-32 — wire CAWSFIX-31's primitives into the
 * worktree lifecycle entry points (bind, merge, auto-bind, create) and
 * add an end-to-end test for the `caws status` Claim panel integration.
 *
 * Heavier setup than agent-claim.test.js because these tests have to
 * exercise real lifecycle entry points (handleBind, mergeWorktree,
 * createWorktree) which all call getRepoRoot() and shell out to git.
 * Each test that exercises those does `git init` in its tmpdir.
 *
 * Covers A1-A10 from .caws/specs/CAWSFIX-32.yaml.
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

let originalCwd;
let tempDir;
let originalSessionEnv;

const SELF = 'session-self-aaa';
const OTHER = 'session-other-bbb';

const recentIso = (offsetMs = 0) => new Date(Date.now() - offsetMs).toISOString();
const NOW_ISO = () => recentIso(0);
const FIVE_MIN_AGO = () => recentIso(5 * 60 * 1000);
const TEN_MIN_AGO = () => recentIso(10 * 60 * 1000);

const initGit = () => {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tempDir });
  execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: tempDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
  // Initial commit so HEAD exists and worktree create has a base.
  fs.writeFileSync(path.join(tempDir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: tempDir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: tempDir });
};

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

const writeSpec = (id, body) => {
  const dir = path.join(tempDir, '.caws', 'specs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.yaml`), body);
};

const baseSpecYaml = (id, worktree = null) =>
  [
    `id: ${id}`,
    'type: feature',
    'title: Wiring probe',
    'risk_tier: 2',
    'mode: development',
    `created_at: '${NOW_ISO()}'`,
    `updated_at: '${NOW_ISO()}'`,
    'status: active',
    ...(worktree ? [`worktree: ${worktree}`] : []),
    'invariants:',
    '  - x',
    'acceptance:',
    '  - id: A1',
    '    given: x',
    '    when: y',
    '    then: z',
    '',
  ].join('\n');

const baseWorktreeEntry = (name, owner) => {
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

const liveAgentEntry = (sid, platform = 'claude-code', extras = {}) => ({
  sessionId: sid,
  platform,
  model: 'claude-opus-4-7',
  specId: extras.specId || null,
  worktree: extras.worktree || null,
  ttl: 1800000,
  firstSeen: TEN_MIN_AGO(),
  lastSeen: FIVE_MIN_AGO(),
});

describe('CAWSFIX-32 — complete CAWSFIX-31 wiring', () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    originalSessionEnv = process.env.CLAUDE_SESSION_ID;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawsfix-32-'));
    fs.mkdirSync(path.join(tempDir, '.caws', 'specs'), { recursive: true });
    process.chdir(tempDir);
    jest.resetModules();
    process.env.CLAUDE_SESSION_ID = SELF;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalSessionEnv === undefined) {
      delete process.env.CLAUDE_SESSION_ID;
    } else {
      process.env.CLAUDE_SESSION_ID = originalSessionEnv;
    }
    jest.restoreAllMocks();
  });

  test('A1: caws worktree bind soft-blocks on foreign owner without --takeover', async () => {
    initGit();
    writeSpec('SPEC-A1', baseSpecYaml('SPEC-A1', 'wt-a1'));
    writeWorktreesRegistry({ 'wt-a1': baseWorktreeEntry('wt-a1', OTHER) });
    writeAgentsRegistry({ [OTHER]: liveAgentEntry(OTHER, 'claude-code', { worktree: 'wt-a1' }) });

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});

    const { worktreeCommand } = require('../src/commands/worktree');
    await worktreeCommand('bind', { specId: 'SPEC-A1', name: 'wt-a1' });

    // Soft-block: process.exit(1)
    expect(exitSpy).toHaveBeenCalled();
    const exitCode = exitSpy.mock.calls[0][0];
    expect(exitCode).toBe(1);

    // Warning text contains the structured pieces
    const out = [
      ...errSpy.mock.calls.map((c) => c.join(' ')),
      ...logSpy.mock.calls.map((c) => c.join(' ')),
    ].join('\n');
    expect(out).toMatch(new RegExp(`${OTHER}:claude-code`));
    expect(out).toMatch(/--takeover/);
    expect(out).toMatch(/wt-a1/);

    // Registry untouched — owner still OTHER, no specId set on the entry
    const reg = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.caws', 'worktrees.json'), 'utf8')
    );
    expect(reg.worktrees['wt-a1'].owner).toBe(OTHER);
    expect(reg.worktrees['wt-a1'].specId || null).toBeNull();
  });

  test('A2: caws worktree bind --takeover overwrites + audits + refreshes agents.json', async () => {
    initGit();
    writeSpec('SPEC-A2', baseSpecYaml('SPEC-A2', 'wt-a2'));
    writeWorktreesRegistry({ 'wt-a2': baseWorktreeEntry('wt-a2', OTHER) });
    writeAgentsRegistry({ [OTHER]: liveAgentEntry(OTHER, 'cursor', { worktree: 'wt-a2' }) });

    const { worktreeCommand } = require('../src/commands/worktree');
    await worktreeCommand('bind', {
      specId: 'SPEC-A2',
      name: 'wt-a2',
      takeover: true,
    });

    const reg = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.caws', 'worktrees.json'), 'utf8')
    );
    expect(reg.worktrees['wt-a2'].owner).toBe(SELF);
    expect(reg.worktrees['wt-a2'].specId).toBe('SPEC-A2');
    expect(Array.isArray(reg.worktrees['wt-a2'].prior_owners)).toBe(true);
    expect(reg.worktrees['wt-a2'].prior_owners[0].sessionId).toBe(OTHER);
    expect(reg.worktrees['wt-a2'].prior_owners[0].platform).toBe('cursor');

    // agents.json refreshed
    const agents = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.caws', 'agents.json'), 'utf8')
    );
    expect(agents.agents[SELF]).toBeDefined();
    expect(agents.agents[SELF].worktree).toBe('wt-a2');
    expect(agents.agents[SELF].specId).toBe('SPEC-A2');
  });

  test('A3: mergeWorktree soft-blocks on foreign owner without --takeover', () => {
    initGit();
    writeWorktreesRegistry({ 'wt-a3': baseWorktreeEntry('wt-a3', OTHER) });
    writeAgentsRegistry({ [OTHER]: liveAgentEntry(OTHER) });

    const { mergeWorktree } = require('../src/worktree/worktree-manager');
    expect(() => mergeWorktree('wt-a3', { dryRun: true })).toThrow(/--takeover|claimed/i);

    // Worktree entry untouched
    const reg = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.caws', 'worktrees.json'), 'utf8')
    );
    expect(reg.worktrees['wt-a3'].owner).toBe(OTHER);
  });

  test('A4: mergeWorktree --takeover writes prior_owners audit + heartbeats new owner', () => {
    initGit();
    writeWorktreesRegistry({ 'wt-a4': baseWorktreeEntry('wt-a4', OTHER) });
    writeAgentsRegistry({ [OTHER]: liveAgentEntry(OTHER, 'cursor') });

    const { mergeWorktree } = require('../src/worktree/worktree-manager');
    // dryRun:true so we don't actually attempt the merge (no real branch).
    // The takeover guard runs first, before any git ops.
    try {
      mergeWorktree('wt-a4', { dryRun: true, takeover: true });
    } catch {
      // Merge itself may throw because there's no real branch to merge,
      // but the takeover side-effect must have already landed.
    }

    const reg = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.caws', 'worktrees.json'), 'utf8')
    );
    expect(reg.worktrees['wt-a4'].owner).toBe(SELF);
    expect(Array.isArray(reg.worktrees['wt-a4'].prior_owners)).toBe(true);
    expect(reg.worktrees['wt-a4'].prior_owners[0].sessionId).toBe(OTHER);
    expect(reg.worktrees['wt-a4'].prior_owners[0].platform).toBe('cursor');

    const agents = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.caws', 'agents.json'), 'utf8')
    );
    expect(agents.agents[SELF]).toBeDefined();
    expect(agents.agents[SELF].worktree).toBe('wt-a4');
  });

  test('A5: createWorktree refreshes agents.json with worktree + specId', () => {
    initGit();
    writeSpec('SPEC-A5', baseSpecYaml('SPEC-A5', 'wt-a5'));
    writeAgentsRegistry({});

    const { createWorktree } = require('../src/worktree/worktree-manager');
    const entry = createWorktree('wt-a5', { specId: 'SPEC-A5' });
    expect(entry).toBeDefined();
    expect(entry.specId).toBe('SPEC-A5');

    const agents = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.caws', 'agents.json'), 'utf8')
    );
    expect(agents.agents[SELF]).toBeDefined();
    expect(agents.agents[SELF].worktree).toBe('wt-a5');
    expect(agents.agents[SELF].specId).toBe('SPEC-A5');
  });

  test('A6: handleBind on same-session worktree refreshes agents.json with worktree + specId', async () => {
    initGit();
    writeSpec('SPEC-A6', baseSpecYaml('SPEC-A6', 'wt-a6'));
    writeWorktreesRegistry({ 'wt-a6': baseWorktreeEntry('wt-a6', SELF) });
    writeAgentsRegistry({});

    const { worktreeCommand } = require('../src/commands/worktree');
    await worktreeCommand('bind', { specId: 'SPEC-A6', name: 'wt-a6' });

    const agents = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.caws', 'agents.json'), 'utf8')
    );
    expect(agents.agents[SELF]).toBeDefined();
    expect(agents.agents[SELF].worktree).toBe('wt-a6');
    expect(agents.agents[SELF].specId).toBe('SPEC-A6');
  });

  test('A7: mergeWorktree refresh on same-session worktree captures the worktree', () => {
    initGit();
    writeWorktreesRegistry({ 'wt-a7': baseWorktreeEntry('wt-a7', SELF) });
    writeAgentsRegistry({});

    const { mergeWorktree } = require('../src/worktree/worktree-manager');
    try {
      mergeWorktree('wt-a7', { dryRun: true });
    } catch {
      // Real merge would fail (no branch) but ownership-check passes for SELF
      // and refresh must fire whether or not the post-check git ops succeed.
    }

    const agents = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.caws', 'agents.json'), 'utf8')
    );
    expect(agents.agents[SELF]).toBeDefined();
    expect(agents.agents[SELF].worktree).toBe('wt-a7');
  });

  test('A8: displayStatus end-to-end test renders the Claim panel inside a worktree', () => {
    initGit();
    const wtName = 'wt-a8';
    const wtPath = path.join(tempDir, '.caws', 'worktrees', wtName);
    fs.mkdirSync(wtPath, { recursive: true });
    writeWorktreesRegistry({ [wtName]: baseWorktreeEntry(wtName, SELF) });
    writeAgentsRegistry({
      [SELF]: liveAgentEntry(SELF, 'claude-code', { worktree: wtName, specId: 'SPEC-A8' }),
    });

    process.chdir(wtPath);

    const logs = [];
    jest.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    const { displayStatus } = require('../src/commands/status');
    displayStatus({
      spec: null,
      specSelection: null,
      hooks: { installed: false, total: 0 },
      provenance: { exists: false, count: 0 },
      waivers: { exists: false, total: 0, active: 0, expired: 0, revoked: 0 },
      gates: { message: 'not configured' },
    });

    const out = logs.join('\n');
    expect(out).toMatch(/Claim:/);
    expect(out).toMatch(new RegExp(`${SELF}:claude-code`));
    expect(out).toMatch(new RegExp(wtName));
  });

  test('A9: displayStatus continues normally when renderClaimPanel throws (silent swallow does not propagate)', () => {
    initGit();
    const wtName = 'wt-a9';
    const wtPath = path.join(tempDir, '.caws', 'worktrees', wtName);
    fs.mkdirSync(wtPath, { recursive: true });
    writeWorktreesRegistry({ [wtName]: baseWorktreeEntry(wtName, SELF) });
    writeAgentsRegistry({});

    process.chdir(wtPath);

    // Force renderClaimPanel to throw via a partial mock of agent-display.
    jest.doMock('../src/utils/agent-display', () => {
      const actual = jest.requireActual('../src/utils/agent-display');
      return {
        ...actual,
        renderClaimPanel: () => {
          throw new Error('synthetic claim-panel failure');
        },
      };
    });

    const logs = [];
    jest.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    const { displayStatus } = require('../src/commands/status');
    expect(() => displayStatus({
      spec: null,
      specSelection: null,
      hooks: { installed: false, total: 0 },
      provenance: { exists: false, count: 0 },
      waivers: { exists: false, total: 0, active: 0, expired: 0, revoked: 0 },
      gates: { message: 'not configured' },
    })).not.toThrow();

    const out = logs.join('\n');
    // Status emits its banner regardless — proves the swallow didn't abort displayStatus
    expect(out).toMatch(/CAWS Project Status/);
    // Claim panel is omitted (renderClaimPanel threw)
    expect(out).not.toMatch(/Claim:/);
  });

  test('A10: takeover heartbeats new owner into agents.json (jest assertion, not just smoke)', () => {
    initGit();
    writeWorktreesRegistry({ 'wt-a10': baseWorktreeEntry('wt-a10', OTHER) });
    writeAgentsRegistry({ [OTHER]: liveAgentEntry(OTHER) });

    const { assertWorktreeOwnership } = require('../src/worktree/worktree-manager');
    const result = assertWorktreeOwnership(tempDir, 'wt-a10', { allowTakeover: true });
    expect(result.allowed).toBe(true);

    const agents = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.caws', 'agents.json'), 'utf8')
    );
    expect(agents.agents[SELF]).toBeDefined();
    expect(agents.agents[SELF].worktree).toBe('wt-a10');
    expect(agents.agents[SELF].lastSeen).toBeTruthy();
  });
});
