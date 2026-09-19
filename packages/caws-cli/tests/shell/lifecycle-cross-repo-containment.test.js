'use strict';

/**
 * CAWS-LIFECYCLE-CROSS-REPO-CONTAINMENT-01 — end to end, through the real CLI.
 *
 * The sibling suite (session-origin-record.test.js) proves the DECISION. This
 * one proves the decision is actually reached and actually stops the write:
 *
 *   - a handler-level test cannot see a check that register.ts never wires
 *     (the register.ts opt-forward class, observed before in this repo), and
 *   - "returns 1" is not the claim. The claim is that the foreign repo is
 *     left with no spec file and no appended event — a guard that refuses
 *     AFTER writing has not contained anything.
 *
 * Every assertion therefore inspects the target repo's filesystem, not just
 * the exit status.
 *
 * Coverage map (spec acceptance): A1 refuse + no side effect; A2 in-repo
 * admission; A7 all four governed entry points.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execSync, spawnSync } = require('child_process');

/**
 * The build under test. Overridable so the same assertions can be pointed at
 * another build — which is how the asserted-failing baseline for this slice
 * was taken: run against the installed pre-change snapshot
 * (`CAWS_E2E_CLI=$(readlink -f "$(command -v caws)")`) and every containment
 * case fails, because that build has no containment at all.
 */
const CLI = process.env.CAWS_E2E_CLI || path.join(__dirname, '..', '..', 'dist', 'index.js');
const SESSION = 'sess-e2e-containment-1';

let HOME_DIR;

/**
 * A child environment built from scratch, never spread from process.env.
 * Inheriting the harness env is how a test goes green in CI and red for every
 * agent: a real CLAUDE_CODE_SESSION_ID would override the fixture's identity
 * and the containment would pin the AGENT's session instead.
 */
function childEnv(extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: HOME_DIR,
    CAWS_HOME: path.join(HOME_DIR, '.caws'),
    CLAUDE_CODE_SESSION_ID: SESSION,
    CAWS_QUIET: '1',
    ...extra,
  };
}

function runCli(cwd, argv, extraEnv) {
  const r = spawnSync(process.execPath, [CLI, ...argv], {
    cwd,
    env: childEnv(extraEnv),
    encoding: 'utf8',
  });
  return {
    status: r.status,
    out: r.stdout ?? '',
    err: r.stderr ?? '',
    all: `${r.stdout}${r.stderr}`,
  };
}

/**
 * The same CLI with no agent identity in the environment — the operator at a
 * terminal outside the session.
 *
 * This is not a convenience: `caws reprieve grant` refuses a self-grant when
 * it detects an agent session, so a grant issued from `runCli` is (correctly)
 * rejected. Modelling the grantor as a separate, human-shaped caller is the
 * only shape in which the escape can be exercised at all, and it matches how
 * the escape is meant to be used — the refusal text tells the agent to hand
 * the command to the user.
 */
function runCliAsHuman(cwd, argv) {
  const env = childEnv();
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [CLI, ...argv], { cwd, env, encoding: 'utf8' });
  return {
    status: r.status,
    out: r.stdout ?? '',
    err: r.stderr ?? '',
    all: `${r.stdout}${r.stderr}`,
  };
}

/** Assert success and surface the CLI's own output when it is not, so a
 * failure names the reason instead of only the exit code. */
function expectOk(r) {
  if (r.status !== 0) throw new Error(`expected exit 0, got ${r.status}:\n${r.all}`);
}

function makeRepo(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  execSync(
    'git init -q -b main && git config user.email t@t && git config user.name t && ' +
      'git config commit.gpgsign false && git commit -q --allow-empty -m root',
    { cwd: root }
  );
  const init = runCli(root, ['init', '--agent-surface', 'none']);
  if (init.status !== 0) {
    throw new Error(`fixture caws init failed in ${root}:\n${init.all}`);
  }
  return root;
}

/**
 * Register the session in a repo, as `agent-register.sh` does at SessionStart.
 *
 * Only the session's HOME repo gets this. A repo may take a session's origin
 * pin only if it already holds a lease for it, so the sibling repo is left
 * unregistered — which is exactly what makes it foreign, and what keeps a
 * throwaway fixture from claiming a session that merely ran a command in it.
 */
function registerSession(repoRoot, sessionId) {
  const dir = path.join(repoRoot, '.caws', 'leases');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.json`),
    JSON.stringify({
      lease_version: 1,
      session_id: sessionId,
      platform: 'claude-code',
      status: 'active',
      started_at: '2026-09-19T00:00:00Z',
      last_active: '2026-09-19T00:00:00Z',
      repo_root: repoRoot,
    })
  );
}

/** Everything under .caws that a governed mutation would touch. */
function governanceFingerprint(root) {
  const cawsDir = path.join(root, '.caws');
  const specs = fs.existsSync(path.join(cawsDir, 'specs'))
    ? fs.readdirSync(path.join(cawsDir, 'specs')).sort()
    : [];
  const eventsFile = path.join(cawsDir, 'events.jsonl');
  const events = fs.existsSync(eventsFile)
    ? fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).length
    : 0;
  const registry = path.join(cawsDir, 'worktrees.json');
  const worktrees = fs.existsSync(registry) ? fs.readFileSync(registry, 'utf8') : '';
  return { specs, events, worktrees };
}

let repoA;
let repoB;

beforeAll(() => {
  HOME_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-e2e-home-')));
  repoA = makeRepo('caws-e2e-a-');
  repoB = makeRepo('caws-e2e-b-');
  registerSession(repoA, SESSION);
});

describe('governed lifecycle commands are contained to the session root', () => {
  it('pins the session on its first governed command and admits it in repo A (A2, A5)', () => {
    const r = runCli(repoA, [
      'specs',
      'create',
      'HOMEA-001',
      '--title',
      'a spec authored where the session lives',
      '--mode',
      'chore',
      '--risk-tier',
      '3',
    ]);

    expect(r.status).toBe(0);
    expect(r.all).toContain(`this session is now rooted in ${repoA}`);
    expect(fs.existsSync(path.join(repoA, '.caws', 'specs', 'HOMEA-001.yaml'))).toBe(true);
  });

  it('refuses specs create in the sibling repo and leaves it untouched (A1)', () => {
    const before = governanceFingerprint(repoB);

    const r = runCli(repoB, [
      'specs',
      'create',
      'FOREIGN-001',
      '--title',
      'a spec reaching into a repo this session does not belong to',
      '--mode',
      'chore',
      '--risk-tier',
      '3',
    ]);

    expect(r.status).toBe(1);
    expect(r.all).toContain('this session is rooted in another repository');
    expect(r.all).toContain(`session root: ${repoA}`);
    expect(r.all).toContain(`target repo:  ${repoB}`);

    // The containment claim: nothing landed.
    const after = governanceFingerprint(repoB);
    expect(after.specs).toEqual(before.specs);
    expect(after.specs).not.toContain('FOREIGN-001.yaml');
    expect(after.events).toBe(before.events);
  });

  it('refuses worktree create in the sibling repo with no registry mutation (A7)', () => {
    const before = governanceFingerprint(repoB);

    const r = runCli(repoB, ['worktree', 'create', 'wt-foreign', '--spec', 'ANY-001']);

    expect(r.status).toBe(1);
    expect(r.all).toContain('this session is rooted in another repository');
    const after = governanceFingerprint(repoB);
    expect(after.worktrees).toBe(before.worktrees);
    expect(after.events).toBe(before.events);
    expect(fs.existsSync(path.join(repoB, '.caws', 'worktrees', 'wt-foreign'))).toBe(false);
  });

  it('refuses worktree merge in the sibling repo, including --dry-run (A7)', () => {
    const live = runCli(repoB, ['worktree', 'merge', 'wt-anything']);
    expect(live.status).toBe(1);
    expect(live.all).toContain('this session is rooted in another repository');

    // --dry-run reads the target repo's registry and spec state and reports
    // them; exempting it would leave the refused session able to enumerate a
    // foreign repo's governance through the command it is denied.
    const dry = runCli(repoB, ['worktree', 'merge', 'wt-anything', '--dry-run']);
    expect(dry.status).toBe(1);
    expect(dry.all).toContain('this session is rooted in another repository');
  });

  it('refuses specs close in the sibling repo (A7)', () => {
    const r = runCli(repoB, [
      'specs',
      'close',
      'ANY-001',
      '--resolution',
      'completed',
      '--closure-notes',
      'closing a spec in a repo this session does not belong to',
    ]);

    expect(r.status).toBe(1);
    expect(r.all).toContain('this session is rooted in another repository');
  });

  it('still admits the same four commands back in repo A (must stay legal)', () => {
    // The counterweight to every refusal above: containment must be a
    // cross-repo boundary, not a general lifecycle brake. A create that
    // succeeds here proves the refusals are about WHERE, not about the
    // commands being disabled.
    const create = runCli(repoA, [
      'specs',
      'create',
      'HOMEA-002',
      '--title',
      'second spec in the session root',
      '--mode',
      'chore',
      '--risk-tier',
      '3',
    ]);
    expect(create.status).toBe(0);
    expect(fs.existsSync(path.join(repoA, '.caws', 'specs', 'HOMEA-002.yaml'))).toBe(true);

    // A merge of a name that does not exist must fail for the ORDINARY
    // reason, not the containment reason — that distinction is what shows the
    // guard is inert at home rather than merely quiet.
    const merge = runCli(repoA, ['worktree', 'merge', 'no-such-worktree', '--dry-run']);
    expect(merge.all).not.toContain('this session is rooted in another repository');
  });
});

describe('the escape is a human grant, and it is honored end to end (A6)', () => {
  it('admits the foreign repo after a lifecycle-plane grant, and says so', () => {
    const grant = runCliAsHuman(repoB, [
      'reprieve',
      'grant',
      '--session',
      SESSION,
      '--handlers',
      'caws-lifecycle',
      '--reason',
      'porting one governed fix into the sibling repo, approved live',
      '--approved-by',
      '@darian',
      '--for',
      '30m',

      '--surface',

      'claude-code',
    ]);
    expectOk(grant);

    const r = runCli(repoB, [
      'specs',
      'create',
      'GRANTED-001',
      '--title',
      'authored across the boundary under an explicit human grant',
      '--mode',
      'chore',
      '--risk-tier',
      '3',
    ]);

    expect(r.status).toBe(0);
    expect(r.all).toContain(`crossing into ${repoB} under an active reprieve`);
    expect(r.all).toContain('@darian');
    expect(fs.existsSync(path.join(repoB, '.caws', 'specs', 'GRANTED-001.yaml'))).toBe(true);
  });

  it('refuses again once that grant is revoked', () => {
    const revoke = runCliAsHuman(repoB, [
      'reprieve',
      'revoke',
      '--session',
      SESSION,
      '--reason',
      'the port is done; withdrawing the crossing',
      '--surface',
      'claude-code',
    ]);
    expectOk(revoke);

    const r = runCli(repoB, [
      'specs',
      'create',
      'REVOKED-001',
      '--title',
      'attempted after the grant was withdrawn',
      '--mode',
      'chore',
      '--risk-tier',
      '3',
    ]);
    expect(r.status).toBe(1);
    expect(r.all).toContain('this session is rooted in another repository');
    expect(fs.existsSync(path.join(repoB, '.caws', 'specs', 'REVOKED-001.yaml'))).toBe(false);
  });
});

describe('reprieve grant vocabulary (A9)', () => {
  it('accepts the reserved lifecycle-plane token alongside .sh handlers', () => {
    const r = runCliAsHuman(repoA, [
      'reprieve',
      'grant',
      '--session',
      'sess-vocab-ok',
      '--handlers',
      'scope-guard.sh,bash-write-guard.sh,caws-lifecycle',
      '--reason',
      'both file-write channels and the lifecycle plane, deliberately',
      '--approved-by',
      '@darian',
      '--for',
      '5m',
      '--dry-run',

      '--surface',

      'claude-code',
    ]);
    expectOk(r);
    expect(r.all).toContain('caws-lifecycle');
  });

  it('still rejects a token that is neither a .sh basename nor the reserved one', () => {
    const r = runCliAsHuman(repoA, [
      'reprieve',
      'grant',
      '--session',
      'sess-vocab-bad',
      '--handlers',
      'scope-guard',
      '--reason',
      'a typo that must not be stored as an unmatchable target',
      '--approved-by',
      '@darian',
      '--for',
      '5m',

      '--surface',

      'claude-code',
    ]);
    expect(r.status).toBe(1);
    expect(r.all).toContain('requires at least one handler basename');
  });

  it('does NOT demand the lifecycle plane when granting the two file-write guards', () => {
    // The membership argument, asserted: the lifecycle plane is not in the
    // cross-repo-write set, so a complete grant of that set stays complete.
    // If it were added, this grant would start being refused as partial and
    // every operator authorizing one cross-repo file edit would be pushed
    // into also authorizing governed writes into that repo's audit log.
    const r = runCliAsHuman(repoA, [
      'reprieve',
      'grant',
      '--session',
      'sess-vocab-set',
      '--handlers',
      'scope-guard.sh,bash-write-guard.sh',
      '--reason',
      'one cross-repo file edit, no governed records',
      '--approved-by',
      '@darian',
      '--for',
      '5m',
      '--dry-run',

      '--surface',

      'claude-code',
    ]);
    expectOk(r);
    expect(r.all).not.toContain('caws-lifecycle');
    expect(r.all).not.toMatch(/omits/);
  });
});

afterAll(() => {
  for (const dir of [repoA, repoB, HOME_DIR]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Keep execFileSync referenced for lint parity with sibling suites that use it.
void execFileSync;
