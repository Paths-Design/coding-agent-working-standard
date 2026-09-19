'use strict';

/**
 * Contract tests for CAWS-AGENTS-LIST-DISCLOSURE-01.
 *
 * `caws agents list` printed the active bucket and stopped. Stale and stopped
 * sessions existed, were counted internally, and were never mentioned — so a
 * default run read as the whole population when it was a filtered view. Three
 * further renderings could be read for facts they did not carry:
 *
 *   - the worktree/spec columns are a join over `.caws/worktrees.json`
 *     (authority) while the rows themselves come from `.caws/leases`
 *     (operational cache); nothing on screen said which was which;
 *   - `conjoined-unresolved` stated a PAIR count and a LEASE-classification
 *     ratio in one sentence, so the two populations read as one, and it was
 *     the only warning class with no repair line;
 *   - `silent-platform: unknown` reads as "we could not determine the
 *     platform" when `unknown` is the literal value recorded on the lease.
 *
 * These tests pin the disclosure. Each has a counterweight that must NOT
 * change, so no assertion here can be satisfied by printing more words.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const {
  runAgentsRegisterCommand,
  runAgentsListCommand,
} = require('../../dist/shell/commands/agents');
const { initProject } = require('../../dist/store/init-store');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

const repos = [];
afterAll(() => {
  for (const r of repos) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-disclose-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  const r = initProject(root);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  repos.push(root);
  return root;
}

function sinks() {
  const out = [];
  const err = [];
  return { out, err, outFn: (l) => out.push(l), errFn: (l) => err.push(l) };
}

function register(root, sid) {
  const s = sinks();
  const code = runAgentsRegisterCommand({
    sessionId: sid,
    platform: 'test',
    cwd: root,
    env: { ...process.env },
    out: s.outFn,
    err: s.errFn,
  });
  if (code !== 0) throw new Error('register failed: ' + s.err.join('\n'));
}

function patchLease(root, sid, patch) {
  const p = path.join(root, '.caws', 'leases', `${sid}.json`);
  const lease = JSON.parse(fs.readFileSync(p, 'utf8'));
  fs.writeFileSync(p, JSON.stringify({ ...lease, ...patch }, null, 2));
}

/** A lease whose last_active is old enough that the default TTL buckets it stale. */
function makeStale(root, sid) {
  patchLease(root, sid, { last_active: new Date(Date.now() - 48 * 3600 * 1000).toISOString() });
}

function writeRegistry(root, payload) {
  const p = path.join(root, '.caws', 'worktrees.json');
  fs.writeFileSync(p, typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
}

function writeRawLease(root, sid, overrides) {
  const leasesDir = path.join(root, '.caws', 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  fs.writeFileSync(
    path.join(leasesDir, `${sid}.json`),
    JSON.stringify({
      lease_version: 1,
      session_id: sid,
      platform: 'test',
      status: 'active',
      started_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      last_active: new Date().toISOString(),
      repo_root: root,
      cwd: root,
      git_common_dir: path.join(root, '.git'),
      git_dir: path.join(root, '.git'),
      hostname: os.hostname(),
      last_seen_reason: 'manual_register',
      ...overrides,
    })
  );
}

function appendMessage(root, from, to) {
  fs.appendFileSync(
    path.join(root, '.caws', 'messages.jsonl'),
    JSON.stringify({
      record: 'message',
      id: require('crypto').randomUUID(),
      actor: { kind: 'agent', id: from, session_id: from },
      to,
      channel: [from, to].sort().join('::'),
      text: 'x',
      ts: new Date().toISOString(),
    }) + '\n'
  );
}

function list(root, extra = {}) {
  const s = sinks();
  const code = runAgentsListCommand({
    cwd: root,
    env: { ...process.env },
    out: s.outFn,
    err: s.errFn,
    ...extra,
  });
  return { code, out: s.out, err: s.err, text: s.out.join('\n') };
}

function listJson(root, extra = {}) {
  const r = list(root, { ...extra, json: true });
  return { ...r, payload: JSON.parse(r.out.join('\n')) };
}

function visibilityLine(r) {
  return r.out.find((l) => l.startsWith('visibility:'));
}

function sourceLine(r) {
  return r.out.find((l) => l.startsWith('source:'));
}

describe('CAWS-AGENTS-LIST-DISCLOSURE-01', () => {
  // ── A1: a default run states what it withheld and how to see it ─────────
  test('A1: the default run names both withheld buckets with the flag that reveals each', () => {
    const root = mkRepo();
    register(root, 'live-1');
    register(root, 'gone-a');
    register(root, 'gone-b');
    register(root, 'old-1');
    makeStale(root, 'old-1');
    patchLease(root, 'gone-a', { status: 'stopped' });
    patchLease(root, 'gone-b', { status: 'stopped' });

    const r = list(root);
    expect(r.code).toBe(0);
    // The rows themselves prove the filtering really happened.
    expect(r.text).toContain('live-1');
    expect(r.text).not.toContain('old-1');
    expect(r.text).not.toContain('gone-a');

    const v = visibilityLine(r);
    expect(v).toBe(
      'visibility: 1 of 4 shown · 1 stale hidden (--include-stale) · 2 stopped hidden (--include-stopped)'
    );
  });

  test('A1b: revealing a bucket moves it out of the hidden list rather than restating it', () => {
    const root = mkRepo();
    register(root, 'live-1');
    register(root, 'gone-a');
    register(root, 'old-1');
    makeStale(root, 'old-1');
    patchLease(root, 'gone-a', { status: 'stopped' });

    const r = list(root, { includeStale: true });
    expect(r.text).toContain('old-1');
    expect(visibilityLine(r)).toBe(
      'visibility: 2 of 3 shown · 1 stopped hidden (--include-stopped)'
    );
  });

  // ── A2: a remediation the invocation defeats must not be offered bare ───
  test('A2: --active suppressing a given --include-stale is disclosed as suppression', () => {
    const root = mkRepo();
    register(root, 'live-1');
    register(root, 'old-1');
    makeStale(root, 'old-1');

    const r = list(root, { includeStale: true, activeOnly: true });
    // The flag was honoured nowhere: the bucket is still hidden.
    expect(r.text).not.toContain('old-1');
    expect(visibilityLine(r)).toBe(
      'visibility: 1 of 2 shown · 1 stale hidden (--include-stale given; suppressed by --active)'
    );
  });

  test('A2b: without --active the same flag is named plainly, so the suppression note is earned', () => {
    const root = mkRepo();
    register(root, 'live-1');
    register(root, 'old-1');
    makeStale(root, 'old-1');

    const r = list(root);
    expect(visibilityLine(r)).toBe('visibility: 1 of 2 shown · 1 stale hidden (--include-stale)');
    expect(visibilityLine(r)).not.toContain('suppressed');
  });

  // ── A3: the line is unconditional, so its absence never needs reading ───
  test('A3: with nothing withheld the visibility line still prints, stating nothing is hidden', () => {
    const root = mkRepo();
    register(root, 'live-1');
    register(root, 'live-2');

    const r = list(root);
    expect(visibilityLine(r)).toBe('visibility: 2 of 2 shown · nothing hidden');
  });

  test('A3b: an empty lease set still discloses visibility rather than printing a bare count', () => {
    const root = mkRepo();
    const r = list(root);
    expect(r.code).toBe(0);
    expect(visibilityLine(r)).toBe('visibility: 0 of 0 shown · nothing hidden');
  });

  // ── A4: tier disclosure names both artifacts by path ────────────────────
  test('A4: the source line names the lease cache for liveness and worktrees.json for binding', () => {
    const root = mkRepo();
    register(root, 'live-1');
    writeRegistry(root, {
      'wt-a': {
        path: '/tmp/wt-a',
        branch: 'caws/wt-a',
        specId: 'SPEC-A',
        owner: { session_id: 'live-1', platform: 'test' },
      },
    });

    const r = list(root);
    expect(sourceLine(r)).toBe(
      'source: .caws/leases (operational cache — liveness only) · worktree/spec columns joined from .caws/worktrees.json (authority)'
    );
  });

  test('A4b: an unreadable registry says the columns are unavailable, never that it read authority', () => {
    const root = mkRepo();
    register(root, 'live-1');
    writeRegistry(root, '{ not json');

    const r = list(root);
    const s = sourceLine(r);
    expect(s).toBe(
      'source: .caws/leases (operational cache — liveness only) · worktree/spec columns unavailable: .caws/worktrees.json unreadable'
    );
    // The claim it must not make: that the join happened.
    expect(s).not.toContain('joined from');
  });

  // ── A5: pairs and leases are separate statements with their own units ───
  test('A5: conjoined-unresolved states the pair count and the lease coverage separately', () => {
    const root = mkRepo();
    const started = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    const active = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    writeRawLease(root, 'pair-a', { platform: 'test', started_at: started, last_active: active });
    writeRawLease(root, 'pair-b', { platform: 'test', started_at: started, last_active: active });

    const r = list(root);
    const unresolved = r.out.find((l) => l.startsWith('conjoined-unresolved:'));
    const coverage = r.out.find((l) => l.trim().startsWith('identity coverage:'));

    // One pair; two leases; the numbers differ and each names its own unit.
    expect(unresolved).toBe(
      'conjoined-unresolved: 1 lease pair(s) overlap on one platform without complete fork identity (7d window; use --json for details)'
    );
    expect(coverage).toBe('  identity coverage: 0 of 2 recent lease(s) declare fork identity');
    // The conflated single-sentence form must be gone.
    expect(r.text).not.toContain('recent same-platform overlap(s) lack complete fork identity');
  });

  // ── A6: the repair line is present, actionable, and forward-only ────────
  test('A6: the repair line names the declaring flag and refuses to imply retroactive rewrite', () => {
    const root = mkRepo();
    const started = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    const active = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    writeRawLease(root, 'pair-a', { started_at: started, last_active: active });
    writeRawLease(root, 'pair-b', { started_at: started, last_active: active });

    const repair = list(root).out.find((l) => l.trim().startsWith('repair:'));
    expect(repair).toContain('--session-kind');
    expect(repair).toContain('CAWS_SESSION_KIND');
    expect(repair).toContain('existing leases are never rewritten');
    expect(repair).toContain("must not write another session's lease file");
  });

  test('A6b: with no unresolved pairs neither the coverage nor the repair line is printed', () => {
    const root = mkRepo();
    register(root, 'solo-1');

    const r = list(root);
    expect(r.text).not.toContain('conjoined-unresolved:');
    expect(r.text).not.toContain('identity coverage:');
    expect(r.text).not.toContain('repair:');
  });

  // ── A7: a literal `unknown` platform is marked as recorded, not missing ─
  test('A7: the unknown-platform badge says the value was recorded, not undetermined', () => {
    const root = mkRepo();
    writeRawLease(root, 'u1', { platform: 'unknown' });
    writeRawLease(root, 'me', { platform: 'test' });
    for (let i = 0; i < 6; i++) appendMessage(root, 'me', 'u1');

    const badge = list(root).out.find((l) => l.startsWith('silent-platform:'));
    expect(badge).toBe(
      'silent-platform: unknown (6 to, 0 from) — `unknown` is the platform value recorded on those leases, not a missing field'
    );
  });

  test('A7b: a named platform keeps the existing badge form exactly, with no clarifier', () => {
    const root = mkRepo();
    writeRawLease(root, 'z1', { platform: 'zcode' });
    writeRawLease(root, 'me', { platform: 'test' });
    for (let i = 0; i < 6; i++) appendMessage(root, 'me', 'z1');

    const badge = list(root).out.find((l) => l.startsWith('silent-platform:'));
    expect(badge).toBe('silent-platform: zcode (6 to, 0 from)');
    expect(badge).not.toContain('recorded');
  });

  // ── A8: JSON carries the same facts, structured ─────────────────────────
  test('A8: --json exposes visibility and sources rather than leaving them to prose', () => {
    const root = mkRepo();
    register(root, 'live-1');
    register(root, 'old-1');
    register(root, 'gone-a');
    makeStale(root, 'old-1');
    patchLease(root, 'gone-a', { status: 'stopped' });
    writeRegistry(root, {
      'wt-a': {
        path: '/tmp/wt-a',
        branch: 'caws/wt-a',
        specId: 'SPEC-A',
        owner: { session_id: 'live-1', platform: 'test' },
      },
    });

    const { payload } = listJson(root);
    expect(payload.visibility).toEqual({
      shown: 1,
      total: 3,
      hidden: [
        { bucket: 'stale', count: 1, flag: '--include-stale', suppressed_by: null },
        { bucket: 'stopped', count: 1, flag: '--include-stopped', suppressed_by: null },
      ],
    });
    expect(payload.sources).toEqual({
      liveness: '.caws/leases',
      worktree_binding: '.caws/worktrees.json',
    });
    // No prose leaked into the machine payload.
    expect(JSON.stringify(payload)).not.toContain('operational cache');
  });

  test('A8b: an unreadable registry nulls the binding source instead of naming it', () => {
    const root = mkRepo();
    register(root, 'live-1');
    writeRegistry(root, '{ not json');

    const { payload } = listJson(root);
    expect(payload.sources).toEqual({ liveness: '.caws/leases', worktree_binding: null });
  });

  test('A8c: --active is recorded as the suppressor in the machine payload too', () => {
    const root = mkRepo();
    register(root, 'live-1');
    register(root, 'old-1');
    makeStale(root, 'old-1');

    const { payload } = listJson(root, { includeStale: true, activeOnly: true });
    expect(payload.visibility.hidden).toEqual([
      { bucket: 'stale', count: 1, flag: '--include-stale', suppressed_by: '--active' },
    ]);
  });

  // ── A9: the real binary, not just the handler ───────────────────────────
  test('A9: the disclosure survives the Commander path on dist', () => {
    const root = mkRepo();
    register(root, 'live-1');
    register(root, 'old-1');
    makeStale(root, 'old-1');

    const res = spawnSync(process.execPath, [CLI, 'agents', 'list'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'disclosure-test' },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('visibility: ');
    expect(res.stdout).toContain('1 stale hidden (--include-stale)');
    expect(res.stdout).toContain('source: .caws/leases (operational cache — liveness only)');
  });
});
