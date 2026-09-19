'use strict';

/**
 * CAWS-LIFECYCLE-CROSS-REPO-CONTAINMENT-01 — the decision layer.
 *
 * This file drives `evaluateLifecycleContainment` directly, so every branch is
 * asserted on the DECISION it returns, not on an exit code. A test that only
 * checked "exit 1" could not tell a containment refusal apart from a missing
 * `--title`, and could not see the refusal wording at all — which is the part
 * that decides whether an agent routes around the boundary or complies with
 * it (the CAWS-GUARD-REMEDIATION-CROSS-REPO-CONSISTENCY-01 lesson).
 *
 * Coverage map (spec acceptance): A1 refusal decision; A3 worktree equality;
 * A4 uncontained sources; A5 trust-on-first-use and its symmetry; A6 reprieve
 * escape incl. the repo-scope and expiry negatives; A8 unreadable record.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const {
  evaluateLifecycleContainment,
  isContainedSource,
  lifecycleContainmentAdmits,
  originRecordPath,
} = require('../../dist/shell/session/session-origin');
const { LIFECYCLE_PLANE_HANDLER } = require('../../dist/shell/commands/reprieve');

const FUTURE_ISO = '2099-01-01T00:00:00Z';
const PAST_ISO = '2000-01-01T00:00:00Z';

function makeRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execSync(
    'git init -q -b main && git config user.email t@t && git config user.name t && ' +
      'git config commit.gpgsign false && git commit -q --allow-empty -m root',
    { cwd: root }
  );
  fs.mkdirSync(path.join(root, '.caws'), { recursive: true });
  // realpath: on macOS os.tmpdir() is a symlink (/var -> /private/var), and the
  // containment compares realpath'd roots. A fixture that skipped this would
  // pass for the wrong reason — every comparison would be symlink-vs-resolved.
  return fs.realpathSync(root);
}

/**
 * Register a session in a repo, the way agent-register.sh does at
 * SessionStart. A repo may only take a session's pin once it holds this
 * lease, so a fixture that omits it is modelling an unregistered repo.
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
  return repoRoot;
}

/** A repo that has registered the session — the ordinary case. */
function makeHomeRepo(prefix, sessionId) {
  return registerSession(makeRepo(prefix), sessionId);
}

function makeHome() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-origin-home-')));
}

/** A contained (harness-identified) caller. */
function agentEnv(sessionId) {
  return { CLAUDE_CODE_SESSION_ID: sessionId };
}

function args(overrides) {
  return {
    command: 'specs create',
    now: () => new Date('2026-09-19T00:00:00Z'),
    ...overrides,
    cawsDir: path.join(overrides.repoRoot, '.caws'),
    cwd: overrides.cwd ?? overrides.repoRoot,
  };
}

function writeReprieve(home, sessionId, record) {
  const dir = path.join(home, 'state', 'sessions', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `guard-reprieve-${sessionId}.json`),
    JSON.stringify(record, null, 2)
  );
}

describe('lifecycle containment — trust on first use (A5)', () => {
  it('pins the session to the repo of its first governed lifecycle command', () => {
    const repoA = makeRepo('caws-origin-a-');
    const home = makeHome();
    const sid = 'sess-tofu-1';
    registerSession(repoA, sid);

    const first = evaluateLifecycleContainment(
      args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home })
    );

    expect(first.kind).toBe('pinned');
    expect(first.record.repo_root).toBe(repoA);
    expect(first.record.recorded_by).toBe('specs create');
    expect(first.record.source).toBe('claude_code_env');

    const onDisk = JSON.parse(fs.readFileSync(originRecordPath(home, sid), 'utf8'));
    expect(onDisk.repo_root).toBe(repoA);
    expect(onDisk.session_id).toBe(sid);
  });

  it('is symmetric: a session first seen in B is pinned to B and refused in A', () => {
    const repoA = makeRepo('caws-origin-a-');
    const repoB = makeRepo('caws-origin-b-');
    const home = makeHome();
    const sid = 'sess-tofu-2';
    // Registered in B, not A: B is where this session actually started.
    registerSession(repoB, sid);

    const pinned = evaluateLifecycleContainment(
      args({ repoRoot: repoB, env: agentEnv(sid), homeDir: home })
    );
    expect(pinned.kind).toBe('pinned');
    expect(pinned.record.repo_root).toBe(repoB);

    const later = evaluateLifecycleContainment(
      args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home })
    );
    expect(later.kind).toBe('refuse_foreign');
    expect(later.record.repo_root).toBe(repoB);
    expect(later.targetRoot).toBe(repoA);
  });

  it('never rewrites an existing pin from a foreign repo', () => {
    const repoA = makeRepo('caws-origin-a-');
    const repoB = makeRepo('caws-origin-b-');
    const home = makeHome();
    const sid = 'sess-tofu-3';
    registerSession(repoA, sid);

    evaluateLifecycleContainment(args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home }));
    evaluateLifecycleContainment(args({ repoRoot: repoB, env: agentEnv(sid), homeDir: home }));

    // The refused call must not have moved the pin; otherwise the very act
    // being adjudicated would be what re-authorizes it.
    const onDisk = JSON.parse(fs.readFileSync(originRecordPath(home, sid), 'utf8'));
    expect(onDisk.repo_root).toBe(repoA);
  });
});

describe('lifecycle containment — in-repo and worktree admission (A2, A3)', () => {
  it('admits the pinned repo', () => {
    const repoA = makeRepo('caws-origin-a-');
    const home = makeHome();
    const sid = 'sess-admit-1';
    registerSession(repoA, sid);

    evaluateLifecycleContainment(args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home }));
    const again = evaluateLifecycleContainment(
      args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home })
    );

    expect(again.kind).toBe('admit');
  });

  it('admits from a linked worktree, whose cwd is not the recorded root', () => {
    const repoA = makeRepo('caws-origin-a-');
    const home = makeHome();
    const sid = 'sess-admit-wt';
    registerSession(repoA, sid);

    evaluateLifecycleContainment(args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home }));

    const wt = path.join(repoA, 'wt-lane');
    execSync(`git worktree add -q -b lane "${wt}"`, { cwd: repoA });
    expect(fs.existsSync(wt)).toBe(true);

    // repoRoot is what resolveRepoRoot(--git-common-dir) yields from inside a
    // linked worktree: the canonical root, not the worktree directory. The cwd
    // differs, and the decision must still be admit.
    const decision = evaluateLifecycleContainment(
      args({ repoRoot: repoA, cwd: wt, env: agentEnv(sid), homeDir: home })
    );
    expect(decision.kind).toBe('admit');
  });
});

describe('lifecycle containment — who is contained (A4)', () => {
  it('does not contain a caller with no harness session identity', () => {
    const repoA = makeRepo('caws-origin-a-');
    const repoB = makeRepo('caws-origin-b-');
    const home = makeHome();

    const inA = evaluateLifecycleContainment(args({ repoRoot: repoA, env: {}, homeDir: home }));
    const inB = evaluateLifecycleContainment(args({ repoRoot: repoB, env: {}, homeDir: home }));

    expect(inA.kind).toBe('not_applicable');
    expect(inB.kind).toBe('not_applicable');
    // The reason distinguishes "nobody is calling" from "an identity was
    // MINTED for this call". Minting here would make the containment check
    // itself a write, so the resolve must stay read-only.
    expect(inA.reason).toBe('no resolvable session identity');
    expect(inB.reason).toBe('no resolvable session identity');
    // And nothing was pinned: an unidentifiable caller leaves no state behind.
    expect(fs.existsSync(path.join(home, 'state', 'sessions'))).toBe(false);
  });

  it('contains a codex-identified caller the same way as a claude-code one', () => {
    const repoA = makeRepo('caws-origin-a-');
    const repoB = makeRepo('caws-origin-b-');
    const home = makeHome();
    const env = { CODEX_THREAD_ID: 'sess-codex-1' };
    registerSession(repoA, 'sess-codex-1');

    expect(evaluateLifecycleContainment(args({ repoRoot: repoA, env, homeDir: home })).kind).toBe(
      'pinned'
    );
    expect(evaluateLifecycleContainment(args({ repoRoot: repoB, env, homeDir: home })).kind).toBe(
      'refuse_foreign'
    );
  });
});

describe('lifecycle containment — an unregistered repo cannot take the pin (A10)', () => {
  it('does not pin a session in a repo that holds no lease for it', () => {
    // The exact shape a test harness produces: it shells out to caws inside a
    // throwaway repo while inheriting the agent's environment. Under a
    // position-only pin this would bind the live session to a directory that
    // is deleted seconds later, and every governed command in the agent's
    // real repo would then be refused against a root that no longer exists.
    const scratch = makeRepo('caws-origin-scratch-');
    const home = makeHome();
    const sid = 'sess-unregistered-1';

    const decision = evaluateLifecycleContainment(
      args({ repoRoot: scratch, env: agentEnv(sid), homeDir: home })
    );

    expect(decision.kind).toBe('not_applicable');
    expect(decision.reason).toMatch(/holds no lease/);
    expect(fs.existsSync(originRecordPath(home, sid))).toBe(false);
  });

  it('still pins in the repo that DID register the session, and then contains it', () => {
    // The discriminating half: same session, same machine home, two repos —
    // only the registered one takes the pin, and the pin then governs.
    const scratch = makeRepo('caws-origin-scratch-');
    const home = makeHome();
    const sid = 'sess-unregistered-2';
    const real = makeHomeRepo('caws-origin-real-', sid);

    expect(
      evaluateLifecycleContainment(args({ repoRoot: scratch, env: agentEnv(sid), homeDir: home }))
        .kind
    ).toBe('not_applicable');

    const pinned = evaluateLifecycleContainment(
      args({ repoRoot: real, env: agentEnv(sid), homeDir: home })
    );
    expect(pinned.kind).toBe('pinned');
    expect(pinned.record.repo_root).toBe(real);

    // And once pinned, the unregistered repo is refused rather than ignored:
    // registration governs where a pin may be TAKEN, never where one is
    // ignored, so a session cannot escape its pin by visiting a repo that
    // never registered it.
    expect(
      evaluateLifecycleContainment(args({ repoRoot: scratch, env: agentEnv(sid), homeDir: home }))
        .kind
    ).toBe('refuse_foreign');
  });
});

describe('lifecycle containment — every contained identity source (A4)', () => {
  // One row per resolver tier the module claims to contain. Asserting two of
  // nine left the other seven free to be dropped from the set without any
  // test noticing — the set IS the policy, so each member needs its own
  // discriminating case.
  const CONTAINED = [
    ['claude_env', (sid) => ({ CLAUDE_SESSION_ID: sid })],
    ['claude_code_env', (sid) => ({ CLAUDE_CODE_SESSION_ID: sid })],
    ['codex_thread_env', (sid) => ({ CODEX_THREAD_ID: sid })],
    ['dsh_env', (sid) => ({ DSH_SESSION_ID: sid })],
    ['caws_env', (sid) => ({ CAWS_SESSION_ID: sid })],
    ['hook_env', (sid) => ({ HOOK_SESSION_ID: sid })],
    // The surface pin reads the surface's OWN var (claude-code pins
    // CLAUDE_SESSION_ID, not CLAUDE_CODE_SESSION_ID); pairing it with the
    // wrong var silently falls through to a later tier.
    [
      'surface_pinned_env',
      (sid) => ({ CAWS_AGENT_SURFACE: 'claude-code', CLAUDE_SESSION_ID: sid }),
    ],
  ];

  it.each(CONTAINED)('contains a session identified via %s', (label, envFor) => {
    const sid = `sess-src-${label}`;
    const home = makeHome();
    const repoA = makeHomeRepo('caws-origin-a-', sid);
    const repoB = makeRepo('caws-origin-b-');

    const pinned = evaluateLifecycleContainment(
      args({ repoRoot: repoA, env: envFor(sid), homeDir: home })
    );
    expect(pinned.kind).toBe('pinned');
    expect(pinned.record.session_id).toBe(sid);
    // Assert WHICH tier resolved it. Without this the row named "dsh_env"
    // could actually be exercising some other tier, and dropping dsh_env from
    // the contained list would go unnoticed.
    expect(pinned.record.source).toBe(label);

    // The half that proves containment, not merely pinning.
    expect(
      evaluateLifecycleContainment(args({ repoRoot: repoB, env: envFor(sid), homeDir: home })).kind
    ).toBe('refuse_foreign');
  });

  // Membership is the policy, so it is pinned directly as well: the table
  // above can only reach tiers an env var can produce, and two of the
  // contained sources (durable_hook_envelope, agent_pid_record) are resolved
  // from on-disk state rather than the environment.
  it.each([
    ['surface_pinned_env', true],
    ['claude_env', true],
    ['claude_code_env', true],
    ['codex_thread_env', true],
    ['dsh_env', true],
    ['caws_env', true],
    ['hook_env', true],
    ['durable_hook_envelope', true],
    ['agent_pid_record', true],
    ['capsule', false],
    ['minted', false],
    ['cursor_env', false],
    ['not_a_real_source', false],
  ])('isContainedSource(%s) === %s', (source, expected) => {
    expect(isContainedSource(source)).toBe(expected);
  });

  it('does not contain a cursor trace id, which rotates per request', () => {
    // CURSOR_TRACE_ID is documented as low-stability. Pinning it would write
    // an unbounded number of single-use records and contain nothing.
    const sid = 'sess-cursor-1';
    const home = makeHome();
    const repoA = makeHomeRepo('caws-origin-a-', sid);

    const decision = evaluateLifecycleContainment(
      args({ repoRoot: repoA, env: { CURSOR_TRACE_ID: sid }, homeDir: home })
    );
    expect(decision.kind).toBe('not_applicable');
    expect(decision.reason).toBe('session source "cursor_env" is not contained');
    expect(fs.existsSync(originRecordPath(home, sid))).toBe(false);
  });
});

describe('lifecycle containment — record validation, field by field (A8)', () => {
  const VALID = (repoRoot, sid) => ({
    session_id: sid,
    repo_root: repoRoot,
    recorded_at: '2026-09-19T00:00:00Z',
    recorded_by: 'specs create',
    source: 'claude_code_env',
  });

  // Each row removes exactly one thing the parser requires. A single
  // "malformed" case would leave every other clause free to be deleted.
  // Each string field is checked TWICE — wrong type and empty — because the
  // parser tests those with two separate clauses. Covering only one leaves
  // the other free to be deleted: with the type check gone, a numeric
  // recorded_at would be accepted, and no empty-string case would notice.
  const BROKEN = [
    ['a JSON null', () => null],
    ['a JSON string instead of an object', () => 'just a string'],
    ['a JSON number instead of an object', () => 42],
    ['a JSON array instead of an object', () => []],
    ['a missing session_id', (r, s) => ({ ...VALID(r, s), session_id: undefined })],
    ['a non-string session_id', (r, s) => ({ ...VALID(r, s), session_id: 7 })],
    ['a non-string repo_root', (r, s) => ({ ...VALID(r, s), repo_root: 12345 })],
    ['an empty repo_root', (r, s) => ({ ...VALID(r, s), repo_root: '' })],
    ['a relative repo_root', (r, s) => ({ ...VALID(r, s), repo_root: 'relative/path' })],
    ['a non-string recorded_at', (r, s) => ({ ...VALID(r, s), recorded_at: 1758240000 })],
    ['an empty recorded_at', (r, s) => ({ ...VALID(r, s), recorded_at: '' })],
    ['a missing recorded_by', (r, s) => ({ ...VALID(r, s), recorded_by: undefined })],
    ['a non-string recorded_by', (r, s) => ({ ...VALID(r, s), recorded_by: ['specs', 'create'] })],
    ['an empty recorded_by', (r, s) => ({ ...VALID(r, s), recorded_by: '' })],
    ['a non-string source', (r, s) => ({ ...VALID(r, s), source: { tier: 1 } })],
    ['an empty source', (r, s) => ({ ...VALID(r, s), source: '' })],
  ];

  it.each(BROKEN)('refuses a record with %s', (label, build) => {
    const sid = `sess-parse-${label.replace(/\W+/g, '-')}`;
    const home = makeHome();
    const repoA = makeHomeRepo('caws-origin-a-', sid);

    const file = originRecordPath(home, sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(build(repoA, sid)));

    const decision = evaluateLifecycleContainment(
      args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home })
    );
    // Not merely "not admitted": refuse. Treating an invalid record as absent
    // would re-pin the session and make corrupting the file a way to move it.
    expect(decision.kind).toBe('refuse_unreadable');
    // And refused by the VALIDATOR, not by an exception thrown further down.
    // Asserting only the kind let a broken validation clause pass: the record
    // slipped through, blew up on the next line, and landed in the same
    // refuse_unreadable bucket by a different route.
    expect(decision.detail).toBe('record is structurally invalid or names a different session');
    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify(build(repoA, sid)));
  });

  it('accepts a record carrying unknown extra keys', () => {
    // The must-stay-legal counterweight to the rows above: validation checks
    // the fields it relies on, and a forward-compatible record written by a
    // newer CLI must not read as corruption.
    const sid = 'sess-parse-extra';
    const home = makeHome();
    const repoA = makeHomeRepo('caws-origin-a-', sid);

    const file = originRecordPath(home, sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...VALID(repoA, sid), future_field: 'whatever' }));

    expect(
      evaluateLifecycleContainment(args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home }))
        .kind
    ).toBe('admit');
  });

  it('refuses a symlinked record rather than following it', () => {
    // A symlinked record would let a valid-looking origin be planted outside
    // the machine home. Refused by the assertMachinePath walk, which lstats
    // every component including the leaf — which is why the module carries no
    // second symlink check of its own.
    const sid = 'sess-symlink-1';
    const home = makeHome();
    const repoA = makeHomeRepo('caws-origin-a-', sid);

    const file = originRecordPath(home, sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const elsewhere = path.join(home, 'planted.json');
    fs.writeFileSync(elsewhere, JSON.stringify(VALID(repoA, sid)));
    fs.symlinkSync(elsewhere, file);

    const decision = evaluateLifecycleContainment(
      args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home })
    );
    expect(decision.kind).toBe('refuse_unreadable');
    expect(decision.detail).toBe(`Refusing symlink: ${file}`);
  });
});

describe('lifecycle containment — pin is not taken when it cannot be persisted', () => {
  it('admits without pinning when the record cannot be written', () => {
    const sid = 'sess-unwritable-1';
    const home = makeHome();
    const repoA = makeHomeRepo('caws-origin-a-', sid);

    // A read-only sessions directory: the pin cannot be persisted. It must
    // not silently become a no-containment mode NOR block work the session is
    // entitled to do in its own repo — so the call admits and records nothing.
    const sessionsDir = path.join(home, 'state', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.chmodSync(sessionsDir, 0o500);
    try {
      const decision = evaluateLifecycleContainment(
        args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home })
      );
      expect(decision.kind).toBe('not_applicable');
      // The reason carries the underlying errno, not just the prefix: a
      // dropped detail would report "not writable: undefined" and leave the
      // operator with nothing to act on.
      expect(decision.reason).toMatch(/^origin record not writable: .*(EACCES|permission denied)/i);
      expect(fs.existsSync(originRecordPath(home, sid))).toBe(false);
    } finally {
      fs.chmodSync(sessionsDir, 0o700);
    }
  });

  it('refuses when the record path escapes the machine home', () => {
    // A session id that resolves the record outside CAWS_HOME must not be
    // read at all. sanitizeSessionId maps separators to '_', so this asserts
    // the assertMachinePath backstop rather than the sanitizer.
    const sid = 'sess-escape-1';
    const home = makeHome();
    const repoA = makeHomeRepo('caws-origin-a-', sid);

    // Redirect the per-session directory through a symlink pointing outside
    // the home — the shape assertMachinePath exists to refuse.
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-outside-')));
    const sessionsDir = path.join(home, 'state', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.symlinkSync(outside, path.join(sessionsDir, sid));

    const decision = evaluateLifecycleContainment(
      args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home })
    );
    expect(decision.kind).toBe('refuse_unreadable');
    expect(decision.detail).toMatch(/symlink/);
  });
});

describe('lifecycle containment — environment and IO failure directions', () => {
  it('does not contain when the machine home is unusable', () => {
    // A relative CAWS_HOME makes machineHome throw. That is an environment
    // problem, not an authority signal, so it must not convert into a refusal
    // of ordinary in-repo work.
    const sid = 'sess-badhome-1';
    const repoA = makeHomeRepo('caws-origin-a-', sid);

    const decision = evaluateLifecycleContainment({
      ...args({ repoRoot: repoA, env: { CLAUDE_CODE_SESSION_ID: sid, CAWS_HOME: 'not/absolute' } }),
      homeDir: undefined,
    });

    expect(decision.kind).toBe('not_applicable');
    expect(decision.reason).toBe('machine home unavailable');
  });

  it('refuses when the record cannot be read for a reason other than absence', () => {
    // A directory where the record should be: read fails with EISDIR, not
    // ENOENT. Absence means "not pinned yet"; anything else means the record
    // exists in some form we cannot read, which must not re-pin the session.
    const sid = 'sess-eisdir-1';
    const home = makeHome();
    const repoA = makeHomeRepo('caws-origin-a-', sid);
    fs.mkdirSync(originRecordPath(home, sid), { recursive: true });

    const decision = evaluateLifecycleContainment(
      args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home })
    );

    expect(decision.kind).toBe('refuse_unreadable');
    expect(decision.detail).toMatch(/EISDIR|illegal operation on a directory/i);
    expect(fs.statSync(originRecordPath(home, sid)).isDirectory()).toBe(true);
  });

  it('does not take the pin when the lease store cannot be read', () => {
    // .caws/leases is a FILE, so loadLeases fails. Being unable to PROVE
    // registration must answer "no" — otherwise an unreadable lease store
    // would become a way to acquire a pin in a repo that never claimed you.
    const sid = 'sess-badleases-1';
    const home = makeHome();
    const repoA = makeRepo('caws-origin-a-');
    fs.writeFileSync(path.join(repoA, '.caws', 'leases'), 'not a directory');

    const decision = evaluateLifecycleContainment(
      args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home })
    );

    expect(decision.kind).toBe('not_applicable');
    expect(decision.reason).toBe('no origin recorded and this repo holds no lease for the session');
    expect(fs.existsSync(originRecordPath(home, sid))).toBe(false);
  });

  it('still matches a root that matches textually when realpath cannot resolve it', () => {
    // Both the record and the target name a path that no longer exists, so
    // realpath fails on each side and the comparison falls back to resolve().
    // The session is still in its own repo — a deleted-then-recreated or
    // unmounted checkout must not read as a foreign one.
    const sid = 'sess-resolve-fallback';
    const home = makeHome();
    const vanished = path.join(os.tmpdir(), 'caws-origin-vanished-root');

    const file = originRecordPath(home, sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_id: sid,
        repo_root: vanished,
        recorded_at: '2026-09-19T00:00:00Z',
        recorded_by: 'specs create',
        source: 'claude_code_env',
      })
    );

    const decision = evaluateLifecycleContainment({
      command: 'specs create',
      now: () => new Date('2026-09-19T00:00:00Z'),
      repoRoot: vanished,
      cawsDir: path.join(vanished, '.caws'),
      cwd: os.tmpdir(),
      env: agentEnv(sid),
      homeDir: home,
    });

    expect(decision.kind).toBe('admit');
  });

  it('keeps two DIFFERENT unresolvable roots apart instead of collapsing them', () => {
    // The must-stay-refused counterweight to the test above. When realpath
    // fails on BOTH sides, the fallback still has to compare the two paths.
    // A fallback that yielded one indistinguishable value for every
    // unresolvable path would make them all compare equal — and an equal
    // comparison here ADMITS, so the failure direction is a foreign repo
    // silently admitted, not a refusal.
    const sid = 'sess-resolve-fallback-distinct';
    const home = makeHome();
    const vanishedA = path.join(os.tmpdir(), 'caws-origin-vanished-a');
    const vanishedB = path.join(os.tmpdir(), 'caws-origin-vanished-b');
    expect(fs.existsSync(vanishedA)).toBe(false);
    expect(fs.existsSync(vanishedB)).toBe(false);

    const file = originRecordPath(home, sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_id: sid,
        repo_root: vanishedA,
        recorded_at: '2026-09-19T00:00:00Z',
        recorded_by: 'specs create',
        source: 'claude_code_env',
      })
    );

    const decision = evaluateLifecycleContainment({
      command: 'specs create',
      now: () => new Date('2026-09-19T00:00:00Z'),
      repoRoot: vanishedB,
      cawsDir: path.join(vanishedB, '.caws'),
      cwd: os.tmpdir(),
      env: agentEnv(sid),
      homeDir: home,
    });

    expect(decision.kind).toBe('refuse_foreign');
    expect(decision.record.repo_root).toBe(vanishedA);
    expect(decision.targetRoot).toBe(vanishedB);
  });

  it('compares a recorded root that no longer exists by its resolved path', () => {
    // A pinned repo can be deleted. The comparison must still produce a
    // decision rather than throwing out of realpath.
    const sid = 'sess-gone-1';
    const home = makeHome();
    const repoA = makeHomeRepo('caws-origin-a-', sid);
    const gone = path.join(os.tmpdir(), 'caws-origin-deleted-root-that-does-not-exist');

    const file = originRecordPath(home, sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_id: sid,
        repo_root: gone,
        recorded_at: '2026-09-19T00:00:00Z',
        recorded_by: 'specs create',
        source: 'claude_code_env',
      })
    );

    const decision = evaluateLifecycleContainment(
      args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home })
    );
    expect(decision.kind).toBe('refuse_foreign');
    expect(decision.record.repo_root).toBe(gone);
  });
});

describe('lifecycle containment — unreadable record fails CLOSED (A8)', () => {
  it('refuses on unparseable JSON rather than treating it as no record', () => {
    const repoA = makeRepo('caws-origin-a-');
    const home = makeHome();
    const sid = 'sess-corrupt-1';
    registerSession(repoA, sid);

    const file = originRecordPath(home, sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');

    const decision = evaluateLifecycleContainment(
      args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home })
    );
    expect(decision.kind).toBe('refuse_unreadable');
    expect(decision.detail).toMatch(/unparseable JSON/);
  });

  it('refuses a structurally invalid record (a non-absolute repo_root)', () => {
    const repoA = makeRepo('caws-origin-a-');
    const home = makeHome();
    const sid = 'sess-corrupt-2';
    registerSession(repoA, sid);

    const file = originRecordPath(home, sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_id: sid,
        repo_root: 'relative/path',
        recorded_at: FUTURE_ISO,
        recorded_by: 'specs create',
        source: 'claude_code_env',
      })
    );

    const decision = evaluateLifecycleContainment(
      args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home })
    );
    expect(decision.kind).toBe('refuse_unreadable');
    expect(decision.detail).toMatch(/structurally invalid/);
  });

  it('refuses a record that names a DIFFERENT session', () => {
    const repoA = makeRepo('caws-origin-a-');
    const home = makeHome();
    const sid = 'sess-corrupt-3';
    registerSession(repoA, sid);

    const file = originRecordPath(home, sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_id: 'someone-else',
        repo_root: repoA,
        recorded_at: FUTURE_ISO,
        recorded_by: 'specs create',
        source: 'claude_code_env',
      })
    );

    // Admitting here would let a record planted under another id vouch for
    // this one; refusing keeps the id and the file in agreement.
    const decision = evaluateLifecycleContainment(
      args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home })
    );
    expect(decision.kind).toBe('refuse_unreadable');
  });
});

describe('lifecycle containment — the reprieve escape (A6)', () => {
  function pinnedElsewhere(sid, home, repoA) {
    evaluateLifecycleContainment(args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home }));
  }

  it('admits a foreign repo under an active grant naming the lifecycle plane', () => {
    const repoA = makeRepo('caws-origin-a-');
    const repoB = makeRepo('caws-origin-b-');
    const home = makeHome();
    const sid = 'sess-reprieve-1';
    registerSession(repoA, sid);
    pinnedElsewhere(sid, home, repoA);

    writeReprieve(home, sid, {
      session_id: sid,
      created_at: '2026-09-19T00:00:00Z',
      expires_at: FUTURE_ISO,
      approved_by: '@darian',
      reason: 'porting one fix into the sibling repo',
      handlers: [LIFECYCLE_PLANE_HANDLER],
      repo_root: repoB,
    });

    const decision = evaluateLifecycleContainment(
      args({ repoRoot: repoB, env: agentEnv(sid), homeDir: home })
    );
    expect(decision.kind).toBe('admit_reprieved');
    expect(decision.reprieve.approved_by).toBe('@darian');
  });

  it('does not admit when the grant names only the file-write guards', () => {
    const repoA = makeRepo('caws-origin-a-');
    const repoB = makeRepo('caws-origin-b-');
    const home = makeHome();
    const sid = 'sess-reprieve-2';
    registerSession(repoA, sid);
    pinnedElsewhere(sid, home, repoA);

    // The exact grant from the incident: both cross-repo-write handlers. It
    // authorizes a file write, not governed writes into another repo's audit
    // log — so the lifecycle plane must stay closed.
    writeReprieve(home, sid, {
      session_id: sid,
      created_at: '2026-09-19T00:00:00Z',
      expires_at: FUTURE_ISO,
      approved_by: '@darian',
      reason: 'EXTENSION: fix the dsh work',
      handlers: ['scope-guard.sh', 'bash-write-guard.sh'],
      repo_root: repoB,
    });

    expect(
      evaluateLifecycleContainment(args({ repoRoot: repoB, env: agentEnv(sid), homeDir: home }))
        .kind
    ).toBe('refuse_foreign');
  });

  it('does not admit when the grant is scoped to a THIRD repo', () => {
    const repoA = makeRepo('caws-origin-a-');
    const repoB = makeRepo('caws-origin-b-');
    const repoC = makeRepo('caws-origin-c-');
    const home = makeHome();
    const sid = 'sess-reprieve-3';
    registerSession(repoA, sid);
    pinnedElsewhere(sid, home, repoA);

    writeReprieve(home, sid, {
      session_id: sid,
      created_at: '2026-09-19T00:00:00Z',
      expires_at: FUTURE_ISO,
      approved_by: '@darian',
      reason: 'work in C',
      handlers: [LIFECYCLE_PLANE_HANDLER],
      repo_root: repoC,
    });

    expect(
      evaluateLifecycleContainment(args({ repoRoot: repoB, env: agentEnv(sid), homeDir: home }))
        .kind
    ).toBe('refuse_foreign');
  });

  it('does not admit an expired grant', () => {
    const repoA = makeRepo('caws-origin-a-');
    const repoB = makeRepo('caws-origin-b-');
    const home = makeHome();
    const sid = 'sess-reprieve-4';
    registerSession(repoA, sid);
    pinnedElsewhere(sid, home, repoA);

    writeReprieve(home, sid, {
      session_id: sid,
      created_at: PAST_ISO,
      expires_at: PAST_ISO,
      approved_by: '@darian',
      reason: 'stale',
      handlers: [LIFECYCLE_PLANE_HANDLER],
      repo_root: repoB,
    });

    expect(
      evaluateLifecycleContainment(args({ repoRoot: repoB, env: agentEnv(sid), homeDir: home }))
        .kind
    ).toBe('refuse_foreign');
  });

  it('does not admit a revoked grant', () => {
    const repoA = makeRepo('caws-origin-a-');
    const repoB = makeRepo('caws-origin-b-');
    const home = makeHome();
    const sid = 'sess-reprieve-5';
    registerSession(repoA, sid);
    pinnedElsewhere(sid, home, repoA);

    writeReprieve(home, sid, {
      session_id: sid,
      created_at: '2026-09-19T00:00:00Z',
      expires_at: FUTURE_ISO,
      approved_by: '@darian',
      reason: 'withdrawn',
      handlers: [LIFECYCLE_PLANE_HANDLER],
      repo_root: repoB,
      revoked_at: '2026-09-19T00:00:01Z',
    });

    expect(
      evaluateLifecycleContainment(args({ repoRoot: repoB, env: agentEnv(sid), homeDir: home }))
        .kind
    ).toBe('refuse_foreign');
  });

  it('honors a machine-wide grant (no repo_root) naming the lifecycle plane', () => {
    const repoA = makeRepo('caws-origin-a-');
    const repoB = makeRepo('caws-origin-b-');
    const home = makeHome();
    const sid = 'sess-reprieve-6';
    registerSession(repoA, sid);
    pinnedElsewhere(sid, home, repoA);

    writeReprieve(home, sid, {
      session_id: sid,
      created_at: '2026-09-19T00:00:00Z',
      expires_at: FUTURE_ISO,
      approved_by: '@darian',
      reason: 'deliberate --all-repos grant',
      handlers: [LIFECYCLE_PLANE_HANDLER],
    });

    expect(
      evaluateLifecycleContainment(args({ repoRoot: repoB, env: agentEnv(sid), homeDir: home }))
        .kind
    ).toBe('admit_reprieved');
  });
});

describe('lifecycle containment — refusal text names no refused route (A1)', () => {
  it('states both roots, offers only the two honest options, and announces a crossing', () => {
    const repoA = makeRepo('caws-origin-a-');
    const repoB = makeRepo('caws-origin-b-');
    const home = makeHome();
    const sid = 'sess-text-1';
    registerSession(repoA, sid);
    evaluateLifecycleContainment(args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home }));

    const errs = [];
    const outs = [];
    const admitted = lifecycleContainmentAdmits({
      ...args({ repoRoot: repoB, env: agentEnv(sid), homeDir: home }),
      out: (l) => outs.push(l),
      err: (l) => errs.push(l),
    });
    const text = errs.join('\n');

    expect(admitted).toBe(false);
    // Asserted line by line, not as a loose substring set: the refusal's
    // wording is the part an agent actually acts on, so each claim it makes
    // has to be something a change would break.
    expect(errs).toEqual([
      'caws specs create: refusing — this session is rooted in another repository.',
      `  session root: ${repoA}`,
      `  target repo:  ${repoB}`,
      '  A governed lifecycle mutation writes spec state and appends hash-chained events into the target',
      '  repository. Doing that from a session that belongs elsewhere leaves that repo with governance',
      '  records no session in it is accountable for.',
      '  Changing directory does not change this: the boundary reads the recorded session root, not the cwd.',
      '  Do the work from a session started in the target repository, or ask the operator for a grant:',
      `    caws reprieve grant --handlers ${LIFECYCLE_PLANE_HANDLER} --reason "<why this crossing is safe>" --approved-by "<their id>" --for 30m`,
      `  (run in ${repoB}; the grant is scoped to that repo unless --all-repos is passed)`,
      `  recorded origin: ${originRecordPath(home, sid)}`,
    ]);
    expect(outs).toEqual([]);

    // The route-suppression invariant: nothing here may read as "do it from
    // over there" — the boundary reads the recorded root, so a cd is not a
    // way through and printing one would be the block-dangerous defect again.
    expect(text).not.toMatch(/\bcd\s/);
    expect(text).toContain('Changing directory does not change this');
    // And no self-service flag is advertised, because the caller must not be
    // able to author its own authorization.
    expect(text).not.toMatch(/--allow-foreign|--force|--yes/);
  });

  it('announces the pin, and says nothing on an ordinary in-repo call', () => {
    const sid = 'sess-render-1';
    const home = makeHome();
    const repoA = makeHomeRepo('caws-origin-a-', sid);

    const firstOut = [];
    const firstErr = [];
    expect(
      lifecycleContainmentAdmits({
        ...args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home }),
        out: (l) => firstOut.push(l),
        err: (l) => firstErr.push(l),
      })
    ).toBe(true);
    expect(firstOut.join('\n')).toContain(`this session is now rooted in ${repoA}`);
    expect(firstOut.join('\n')).toContain('specs create');
    expect(firstErr).toEqual([]);

    // Second call in the same repo: already pinned, so the guard is silent.
    // A guard that narrates every admission trains the reader to skim it.
    const againOut = [];
    expect(
      lifecycleContainmentAdmits({
        ...args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home }),
        out: (l) => againOut.push(l),
        err: () => {},
      })
    ).toBe(true);
    expect(againOut).toEqual([]);
  });

  it('is silent for an uncontained caller', () => {
    const home = makeHome();
    const repoA = makeRepo('caws-origin-a-');
    const outs = [];
    const errs = [];
    expect(
      lifecycleContainmentAdmits({
        ...args({ repoRoot: repoA, env: {}, homeDir: home }),
        out: (l) => outs.push(l),
        err: (l) => errs.push(l),
      })
    ).toBe(true);
    expect(outs).toEqual([]);
    expect(errs).toEqual([]);
  });

  it('renders the unreadable-record refusal with the record path and a repair', () => {
    const sid = 'sess-render-corrupt';
    const home = makeHome();
    const repoA = makeHomeRepo('caws-origin-a-', sid);
    const file = originRecordPath(home, sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json at all');

    const errs = [];
    const admitted = lifecycleContainmentAdmits({
      ...args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home }),
      out: () => {},
      err: (l) => errs.push(l),
    });
    const text = errs.join('\n');

    expect(admitted).toBe(false);
    expect(text).toContain('origin record that cannot be read');
    expect(text).toContain(`record: ${file}`);
    expect(text).toContain('An unreadable origin is not an absent origin');
    // The repair must be addressed to the operator, not to the caller: the
    // session must not read this as "delete the file and continue".
    expect(text).toContain('Ask the operator');
  });

  it('names the command that was refused, not a generic one', () => {
    const sid = 'sess-render-cmd';
    const home = makeHome();
    const repoA = makeHomeRepo('caws-origin-a-', sid);
    const repoB = makeRepo('caws-origin-b-');
    evaluateLifecycleContainment(args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home }));

    const errs = [];
    lifecycleContainmentAdmits({
      ...args({ repoRoot: repoB, env: agentEnv(sid), homeDir: home }),
      command: 'worktree merge',
      out: () => {},
      err: (l) => errs.push(l),
    });
    expect(errs[0]).toContain('caws worktree merge: refusing');
  });

  it('announces a reprieved crossing instead of crossing silently', () => {
    const repoA = makeRepo('caws-origin-a-');
    const repoB = makeRepo('caws-origin-b-');
    const home = makeHome();
    const sid = 'sess-text-2';
    registerSession(repoA, sid);
    evaluateLifecycleContainment(args({ repoRoot: repoA, env: agentEnv(sid), homeDir: home }));
    writeReprieve(home, sid, {
      session_id: sid,
      created_at: '2026-09-19T00:00:00Z',
      expires_at: FUTURE_ISO,
      approved_by: '@darian',
      reason: 'ok',
      handlers: [LIFECYCLE_PLANE_HANDLER],
      repo_root: repoB,
    });

    const outs = [];
    const admitted = lifecycleContainmentAdmits({
      ...args({ repoRoot: repoB, env: agentEnv(sid), homeDir: home }),
      out: (l) => outs.push(l),
      err: () => {},
    });

    expect(admitted).toBe(true);
    expect(outs).toEqual([
      `caws specs create: crossing into ${repoB} under an active reprieve (approved by @darian, expires ${FUTURE_ISO}).`,
      `  This session's recorded root is ${repoA}.`,
    ]);
  });
});
