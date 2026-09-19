'use strict';

/**
 * CAWS-REPRIEVE-BOUNDARY-AND-REPO-SCOPE-01 — a reprieve names a boundary and a
 * repo.
 *
 * Two defects, both observed in session 1aa3f0bd (2026-09-18):
 *
 *  1. A grant naming `scope-guard.sh` but not `bash-write-guard.sh` lifted ONE
 *     of the two handlers that adjudicate the cross-repo write boundary. That
 *     does not narrow the exception — it redirects the write to whichever
 *     channel is still guarded. The agent read the asymmetry correctly ("Bash
 *     heredocs are blocked while the Write/Edit tools are not") and used the
 *     open channel for exactly what the guarded one had just refused.
 *
 *  2. The grant was honored in every repo on the machine for 3h, on the
 *     strength of the reason string "EXTENSION: fix the dsh work."
 *
 * Coverage map (spec acceptance):
 *   A1 partial boundary grant is refused, names the co-handler, prints the
 *      completed command
 *   A2 a complete boundary grant is written
 *   A3 handlers outside any declared set are unaffected
 *   A4 a grant with no reach flag carries the repo root; `show` reports it
 *   A5 (reader) — covered in tests/hooks/bats/reprieve.bats A10/A11
 *   A6 --all-repos omits the field and both grant and show say machine-wide
 *   A7 a record with no field is honored anywhere — CLI half here, reader half
 *      in reprieve.bats A13
 *
 * The CLI handlers are driven from dist/ (compiled), and ONE case drives the
 * real `node dist/index.js` process: a handler-level test cannot see a flag
 * that register.ts fails to forward, and that opt-forward gap has shipped
 * before.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execSync } = require('child_process');

const {
  runReprieveGrantCommand,
  runReprieveShowCommand,
  partialBoundaryCoverage,
  reprieveReachesRepo,
  GUARD_BOUNDARY_SETS,
} = require('../../dist/shell/commands/reprieve');

const CLI_ENTRY = path.join(__dirname, '..', '..', 'dist', 'index.js');
const FUTURE_ISO = '2099-01-01T00:00:00Z';
const SESSION = 'sess-reach-001';

/** A git repo with a .claude vendor dir, an isolated machine home, and a lease. */
function makeRepo(prefix = 'caws-reach-') {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execSync(
    'git init -q -b main && git config user.email t@t && git config user.name t && ' +
      'git config commit.gpgsign false && git commit -q --allow-empty -m root',
    { cwd: repoRoot }
  );
  fs.mkdirSync(path.join(repoRoot, '.claude', 'hooks', 'state'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'machine-home', 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '.caws', 'leases'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, '.caws', 'leases', `${SESSION}.json`),
    JSON.stringify({
      lease_version: 1,
      session_id: SESSION,
      platform: 'claude-code',
      status: 'active',
      started_at: '2026-09-19T01:00:00.000Z',
      last_active: '2026-09-19T01:59:00.000Z',
      repo_root: repoRoot,
    })
  );
  return {
    repoRoot,
    homeDir: path.join(repoRoot, 'machine-home'),
    recordPath: path.join(
      repoRoot,
      'machine-home',
      'state',
      'sessions',
      SESSION,
      `guard-reprieve-${SESSION}.json`
    ),
  };
}

/** Invoke the grant handler, collecting stdout and stderr separately. */
function grant(repo, extra = {}) {
  const out = [];
  const errs = [];
  const code = runReprieveGrantCommand({
    cwd: repo.repoRoot,
    homeDir: repo.homeDir,
    env: {}, // a human shell: no agent-session vars (CAWS-REPRIEVE-NO-SELF-GRANT-001)
    out: (s) => out.push(s),
    err: (s) => errs.push(s),
    handlers: 'protected-paths.sh',
    reason: 'test',
    approvedBy: '@darian',
    expiresAt: FUTURE_ISO,
    session: SESSION,
    surface: 'claude-code',
    ...extra,
  });
  return { code, out: out.join('\n'), err: errs.join('\n') };
}

function show(repo, extra = {}) {
  const out = [];
  const errs = [];
  const code = runReprieveShowCommand({
    cwd: repo.repoRoot,
    homeDir: repo.homeDir,
    env: {},
    out: (s) => out.push(s),
    err: (s) => errs.push(s),
    session: SESSION,
    surface: 'claude-code',
    ...extra,
  });
  return { code, out: out.join('\n'), err: errs.join('\n') };
}

describe('A1 — a partial grant across a boundary set is refused', () => {
  it('refuses scope-guard.sh alone and names bash-write-guard.sh as the co-handler', () => {
    const repo = makeRepo();
    const r = grant(repo, { handlers: 'scope-guard.sh' });

    expect(r.code).toBe(1);
    expect(r.err).toContain('covers part of a guard boundary, not all of it');
    expect(r.err).toContain("boundary 'cross-repo-write' is enforced jointly by");
    expect(r.err).toContain('scope-guard.sh, bash-write-guard.sh');
    expect(r.err).toContain('your --handlers omits: bash-write-guard.sh');
    // The operator's next keystroke must be a whole-boundary decision, so the
    // completed command is printed rather than described.
    expect(r.err).toContain('--handlers scope-guard.sh,bash-write-guard.sh');
    // A refusal that still writes the file is the worst outcome of all.
    expect(fs.existsSync(repo.recordPath)).toBe(false);
  });

  it('refuses the other half of the same boundary, naming scope-guard.sh', () => {
    const repo = makeRepo();
    const r = grant(repo, { handlers: 'bash-write-guard.sh' });

    expect(r.code).toBe(1);
    expect(r.err).toContain('your --handlers omits: scope-guard.sh');
    expect(fs.existsSync(repo.recordPath)).toBe(false);
  });

  it('refuses a partial grant even when unrelated handlers pad the list', () => {
    const repo = makeRepo();
    const r = grant(repo, { handlers: 'protected-paths.sh,scope-guard.sh,scan-secrets.sh' });

    expect(r.code).toBe(1);
    expect(r.err).toContain('your --handlers omits: bash-write-guard.sh');
    // The completed command keeps what was asked for and adds only the gap.
    expect(r.err).toContain(
      '--handlers protected-paths.sh,scope-guard.sh,scan-secrets.sh,bash-write-guard.sh'
    );
  });
});

describe('A2 — a complete boundary grant is written', () => {
  it('accepts both handlers of the cross-repo-write boundary', () => {
    const repo = makeRepo();
    const r = grant(repo, { handlers: 'scope-guard.sh,bash-write-guard.sh' });

    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const record = JSON.parse(fs.readFileSync(repo.recordPath, 'utf8'));
    expect(record.handlers).toEqual(['scope-guard.sh', 'bash-write-guard.sh']);
  });

  it('accepts the boundary in either order', () => {
    const repo = makeRepo();
    const r = grant(repo, { handlers: 'bash-write-guard.sh,scope-guard.sh' });

    expect(r.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(repo.recordPath, 'utf8')).handlers).toEqual([
      'bash-write-guard.sh',
      'scope-guard.sh',
    ]);
  });
});

describe('A3 — handlers in no declared set are unaffected', () => {
  it('writes a grant for handlers that touch no boundary', () => {
    const repo = makeRepo();
    const r = grant(repo, { handlers: 'protected-paths.sh,scan-secrets.sh' });

    expect(r.code).toBe(0);
    expect(fs.existsSync(repo.recordPath)).toBe(true);
  });

  it('partialBoundaryCoverage reports nothing for a boundary-free list', () => {
    expect(partialBoundaryCoverage(['protected-paths.sh'])).toEqual([]);
    expect(partialBoundaryCoverage([])).toEqual([]);
  });

  it('partialBoundaryCoverage reports nothing for a complete set', () => {
    expect(partialBoundaryCoverage(['scope-guard.sh', 'bash-write-guard.sh'])).toEqual([]);
  });

  it('every declared boundary has at least two members', () => {
    // A one-member set can never be partially covered, so it would declare a
    // constraint that no input can violate — a rule that cannot fail.
    for (const [boundary, members] of Object.entries(GUARD_BOUNDARY_SETS)) {
      expect(`${boundary}:${members.length >= 2}`).toBe(`${boundary}:true`);
    }
  });
});

describe('A4 — a grant with no reach flag is scoped to the repo it was made in', () => {
  it('stamps the record with the repo root', () => {
    const repo = makeRepo();
    const r = grant(repo);

    expect(r.code).toBe(0);
    const record = JSON.parse(fs.readFileSync(repo.recordPath, 'utf8'));
    expect(record.repo_root).toBe(fs.realpathSync(repo.repoRoot));
  });

  it('grant output names the one repo and how to widen it', () => {
    const repo = makeRepo();
    const r = grant(repo);

    expect(r.out).toContain(`reach:    this repo only — ${fs.realpathSync(repo.repoRoot)}`);
    expect(r.out).toContain('A guard in any other repo ignores this grant.');
    expect(r.out).toContain('--all-repos');
  });

  it('show reports the grant as scoped to this repo', () => {
    const repo = makeRepo();
    grant(repo);
    const s = show(repo);

    expect(s.code).toBe(0);
    expect(s.out).toContain(`reach:    this repo only — ${fs.realpathSync(repo.repoRoot)}`);
    expect(s.out).not.toContain('MACHINE-WIDE');
  });

  it('show reports applies_here=false for a grant belonging to another repo', () => {
    const repo = makeRepo();
    grant(repo);
    // Rewrite the stamp to a different real directory, leaving everything else
    // byte-identical: only reach can explain a changed verdict.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-reach-other-'));
    const record = JSON.parse(fs.readFileSync(repo.recordPath, 'utf8'));
    record.repo_root = other;
    fs.writeFileSync(repo.recordPath, JSON.stringify(record, null, 2));

    const s = show(repo, { json: true });
    const payload = JSON.parse(s.out);
    expect(payload.active).toBe(true); // unexpired...
    expect(payload.applies_here).toBe(false); // ...and still inert here

    const human = show(repo);
    expect(human.out).toContain('guards here ignore this grant');
  });
});

describe('A6 — --all-repos is the explicit, visible way to widen reach', () => {
  it('omits repo_root so every reader treats it as machine-wide', () => {
    const repo = makeRepo();
    const r = grant(repo, { allRepos: true });

    expect(r.code).toBe(0);
    const record = JSON.parse(fs.readFileSync(repo.recordPath, 'utf8'));
    expect('repo_root' in record).toBe(false);
  });

  it('grant and show both state the reach in words, not by omission', () => {
    const repo = makeRepo();
    const r = grant(repo, { allRepos: true });
    expect(r.out).toContain('reach:    MACHINE-WIDE — every repo on this machine');

    const s = show(repo);
    expect(s.out).toContain('reach:    MACHINE-WIDE — every repo on this machine.');
  });

  it('the real CLI forwards --all-repos (register.ts opt-forward proof)', () => {
    // A handler-level test bypasses Commander entirely, so it cannot catch an
    // option declared in metadata but never forwarded in register.ts. This
    // drives the built binary.
    const repo = makeRepo();
    const run = (args) =>
      execFileSync(process.execPath, [CLI_ENTRY, 'reprieve', 'grant', ...args], {
        cwd: repo.repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          CAWS_HOME: repo.homeDir,
          HOME: repo.homeDir,
          CI: 'true',
          NO_COLOR: '1',
          // Strip the harness's own session vars: a real agent session in the
          // env trips the no-self-grant refusal and the test would pass or
          // fail for an unrelated reason.
          CLAUDE_CODE_SESSION_ID: '',
          CLAUDE_SESSION_ID: '',
          CAWS_SESSION_ID: '',
        },
      });

    const base = [
      '--handlers',
      'protected-paths.sh',
      '--reason',
      'dist opt-forward proof',
      '--approved-by',
      '@darian',
      '--expires-at',
      FUTURE_ISO,
      '--session',
      SESSION,
      '--surface',
      'claude-code',
    ];

    const wide = run([...base, '--all-repos']);
    expect(wide).toContain('MACHINE-WIDE');
    expect('repo_root' in JSON.parse(fs.readFileSync(repo.recordPath, 'utf8'))).toBe(false);

    // The same invocation WITHOUT the flag must differ — otherwise the
    // assertion above would hold even if the flag were ignored.
    const narrow = run(base);
    expect(narrow).toContain('reach:    this repo only');
    expect(JSON.parse(fs.readFileSync(repo.recordPath, 'utf8')).repo_root).toBe(
      fs.realpathSync(repo.repoRoot)
    );
  });

  it('the real CLI refuses a partial boundary grant (exit 1, co-handler named)', () => {
    const repo = makeRepo();
    let status = 0;
    let stderr = '';
    try {
      execFileSync(
        process.execPath,
        [
          CLI_ENTRY,
          'reprieve',
          'grant',
          '--handlers',
          'scope-guard.sh',
          '--reason',
          'dist refusal proof',
          '--approved-by',
          '@darian',
          '--expires-at',
          FUTURE_ISO,
          '--session',
          SESSION,
          '--surface',
          'claude-code',
        ],
        {
          cwd: repo.repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            CAWS_HOME: repo.homeDir,
            HOME: repo.homeDir,
            CI: 'true',
            NO_COLOR: '1',
            CLAUDE_CODE_SESSION_ID: '',
            CLAUDE_SESSION_ID: '',
            CAWS_SESSION_ID: '',
          },
        }
      );
    } catch (e) {
      status = e.status;
      stderr = String(e.stderr);
    }
    expect(status).toBe(1);
    expect(stderr).toContain('bash-write-guard.sh');
    expect(fs.existsSync(repo.recordPath)).toBe(false);
  });
});

describe('A7 — a record written before this field existed is honored anywhere', () => {
  it('reprieveReachesRepo returns true for an absent repo_root', () => {
    const legacy = {
      session_id: SESSION,
      created_at: '2026-01-01T00:00:00Z',
      expires_at: FUTURE_ISO,
      approved_by: '@darian',
      reason: 'granted before the field existed',
      handlers: ['protected-paths.sh'],
    };
    expect(reprieveReachesRepo(legacy, '/any/repo')).toBe(true);
    expect(reprieveReachesRepo(legacy, '/some/other/repo')).toBe(true);
  });

  it('show renders a fieldless record as machine-wide rather than erroring', () => {
    const repo = makeRepo();
    grant(repo);
    const record = JSON.parse(fs.readFileSync(repo.recordPath, 'utf8'));
    delete record.repo_root;
    fs.writeFileSync(repo.recordPath, JSON.stringify(record, null, 2));

    const s = show(repo);
    expect(s.code).toBe(0);
    expect(s.out).toContain('MACHINE-WIDE');
  });
});

describe('reprieveReachesRepo — path equality', () => {
  it('matches a present repo_root only against the same resolved directory', () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-reach-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-reach-b-'));
    const rec = { repo_root: a, handlers: [] };
    expect(reprieveReachesRepo(rec, a)).toBe(true);
    expect(reprieveReachesRepo(rec, b)).toBe(false);
  });

  it('resolves symlinks on both sides', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-reach-real-'));
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-reach-link-')), 'alias');
    fs.symlinkSync(real, link);
    // Granted through the symlink, read through the real path (the /tmp ->
    // /private/tmp shape on macOS). A raw string compare fails CLOSED here:
    // the guard refuses despite a valid grant, with nothing explaining why.
    expect(reprieveReachesRepo({ repo_root: link, handlers: [] }, real)).toBe(true);
    expect(reprieveReachesRepo({ repo_root: real, handlers: [] }, link)).toBe(true);
  });

  it('does not match a parent or child directory', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-reach-parent-'));
    const child = path.join(parent, 'nested');
    fs.mkdirSync(child);
    // A prefix test would let a grant in ~/Projects/caws cover
    // ~/Projects/caws-fork, and a grant in a parent cover every repo under it.
    expect(reprieveReachesRepo({ repo_root: parent, handlers: [] }, child)).toBe(false);
    expect(reprieveReachesRepo({ repo_root: child, handlers: [] }, parent)).toBe(false);
  });
});
