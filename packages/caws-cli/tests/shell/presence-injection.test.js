'use strict';

/**
 * Command + hook tests for PRESENCE-DECISION-POINT-INJECTION-001.
 *
 * A1–A4, A6 drive the REAL `runSpecsActivateCommand` against an on-disk
 * git+caws repo with injected stdout/stderr sinks and hand-written lease
 * fixtures — proving the advisory block, its ordering (before the mutation's
 * success line), zero-peer byte-identity, fail-open corruption behavior,
 * self-exclusion, and the 5-line bound.
 *
 * A5 drives the REAL shared-pack `agent-register.sh` via bash with a stubbed
 * CAWS_BIN (caws_run_cli is a thin "$CAWS_BIN $@" wrapper), asserting the
 * SessionStart unbound advisory names the no-authority state, the active
 * spec ids (bounded), and the exact `caws worktree create` command — and
 * emits nothing for a bound checkout.
 *
 * A7 (pack fingerprint + docs) is covered by tests/init/pack-fingerprint
 * .test.js and `npm run docs:check`, not here.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runSpecsCreateCommand,
  runSpecsActivateCommand,
} = require('../../dist/shell/commands/specs');
const { initProject } = require('../../dist/store/init-store');

const HOOK = path.resolve(
  __dirname, '../../templates/hook-packs/shared/agent-register.sh'
);

const repos = [];
afterAll(() => {
  for (const r of repos) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-presence-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  const r = initProject(root);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  repos.push(root);
  return root;
}

/** Write a TTL-live lease fixture (fresh heartbeat => classified active). */
function writeLease(root, sid, extra = {}) {
  const leasesDir = path.join(root, '.caws', 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  fs.writeFileSync(
    path.join(leasesDir, `${sid}.json`),
    JSON.stringify({
      lease_version: 1,
      session_id: sid,
      platform: 'test',
      status: 'active',
      last_active: new Date().toISOString(),
      repo_root: root,
      ...extra,
    })
  );
}

function sinks() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    outFn: (l) => out.push(l),
    errFn: (l) => err.push(l),
  };
}

function mkSpec(root, id) {
  const s = sinks();
  const code = runSpecsCreateCommand({
    id,
    title: 'Presence injection test spec',
    mode: 'feature',
    riskTier: 3,
    cwd: root,
    env: { ...process.env },
    out: s.outFn,
    err: s.errFn,
  });
  if (code !== 0) throw new Error(`mkSpec(${id}) failed: ${s.err.join('\n')}`);
}

function activate(root, id, env = process.env) {
  const s = sinks();
  const code = runSpecsActivateCommand({
    id,
    cwd: root,
    env: { ...env },
    out: s.outFn,
    err: s.errFn,
  });
  return { code, out: s.out, err: s.err };
}

describe('decision-point peer block (specs activate surface)', () => {
  test('A1: two live peers with bindings are named, before the activation line', () => {
    const root = mkRepo();
    mkSpec(root, 'SPEC-001');
    writeLease(root, 'peer-aaa', {
      bound_worktree: 'wt-x', bound_spec_id: 'SPEC-X', branch: 'feat/x',
    });
    writeLease(root, 'peer-bbb', {
      bound_worktree: 'wt-y', bound_spec_id: 'SPEC-Y', branch: 'feat/y',
    });

    const { code, out } = activate(root, 'SPEC-001');
    expect(code).toBe(0);
    const text = out.join('\n');

    expect(text).toContain('Advisory: 2 peer agent session(s) active in this repo:');
    expect(text).toContain('- peer-aaa (worktree wt-x, spec SPEC-X, branch feat/x)');
    expect(text).toContain('- peer-bbb (worktree wt-y, spec SPEC-Y, branch feat/y)');
    // Host behavior unchanged — and the block precedes the success line.
    expect(text).toContain('activated SPEC-001');
    expect(text.indexOf('Advisory:')).toBeLessThan(text.indexOf('activated SPEC-001'));
  });

  test('A2: zero peers — stdout is byte-identical to the pre-change baseline', () => {
    const root = mkRepo();
    mkSpec(root, 'SPEC-002');

    const { code, out } = activate(root, 'SPEC-002');
    expect(code).toBe(0);
    // Exactly the pre-change success surface: one line, nothing added.
    expect(out).toEqual(['activated SPEC-002']);
  });

  test('A3: corrupt lease registry degrades silently (fail-open, no new refusal)', () => {
    const root = mkRepo();
    mkSpec(root, 'SPEC-003');
    const leasesDir = path.join(root, '.caws', 'leases');
    fs.mkdirSync(leasesDir, { recursive: true });
    fs.writeFileSync(path.join(leasesDir, 'garbage.json'), '{not valid json');

    const { code, out } = activate(root, 'SPEC-003');
    expect(code).toBe(0);
    expect(out).toEqual(['activated SPEC-003']);
  });

  test('A4: the acting session is never listed as its own peer', () => {
    const root = mkRepo();
    mkSpec(root, 'SPEC-004');
    writeLease(root, 'sess-self');
    writeLease(root, 'peer-ccc');

    const { code, out } = activate(
      root, 'SPEC-004', { ...process.env, CLAUDE_SESSION_ID: 'sess-self' }
    );
    expect(code).toBe(0);
    const text = out.join('\n');

    expect(text).toContain('Advisory: 1 peer agent session(s) active in this repo:');
    expect(text).toContain('- peer-ccc');
    expect(text).not.toContain('sess-self');
  });

  test('A6: eight peers render five lines plus the overflow handoff', () => {
    const root = mkRepo();
    mkSpec(root, 'SPEC-006');
    for (let i = 0; i < 8; i++) writeLease(root, `peer-0${i}`);

    const { code, out } = activate(root, 'SPEC-006');
    expect(code).toBe(0);
    const text = out.join('\n');

    expect(text).toContain('Advisory: 8 peer agent session(s) active in this repo:');
    const peerLines = text.split('\n').filter((l) => /^ {2}- peer-/.test(l));
    expect(peerLines.length).toBe(5);
    expect(text).toContain('... and 3 more — run `caws agents list`');
  });
});

describe('A5: SessionStart unbound advisory (agent-register.sh)', () => {
  function stubCaws(root, fixture) {
    const stub = path.join(root, 'stub-caws');
    fs.writeFileSync(stub, [
      '#!/bin/bash',
      'if [[ "$*" == *"scope show"* ]]; then',
      `cat <<'JSON'`,
      fixture,
      'JSON',
      'fi',
      'exit 0',
      '',
    ].join('\n'));
    fs.chmodSync(stub, 0o755);
    return stub;
  }

  function runHook(root, stub) {
    return execFileSync('bash', [HOOK], {
      cwd: root,
      input: JSON.stringify({ session_id: 'sess-hook', cwd: root }),
      env: {
        ...process.env,
        CAWS_BIN: stub,
        CAWS_PROJECT_DIR: root,
        HOOK_SESSION_ID: 'sess-hook',
        HOOK_CWD: root,
      },
    }).toString();
  }

  test('unbound checkout with active specs injects the worktree-create command', () => {
    const root = mkRepo();
    mkSpec(root, 'SPEC-101');
    const zero = activate(root, 'SPEC-101'); // no leases -> activates cleanly
    if (zero.code !== 0) throw new Error('activate SPEC-101 failed: ' + zero.err.join('\n'));

    const stub = stubCaws(root, JSON.stringify({
      decision: 'no_authority',
      rule: 'scope.no_authority.unbound',
      authorityCandidates: [
        { specId: 'SPEC-101', lifecycleState: 'active' },
        { specId: 'SPEC-102', lifecycleState: 'active' },
        { specId: 'SPEC-103', lifecycleState: 'active' },
        { specId: 'SPEC-104', lifecycleState: 'active' },
      ],
    }));

    const stdout = runHook(root, stub);
    expect(stdout).toContain('NO write authority');
    expect(stdout).toContain('SPEC-101');
    expect(stdout).toContain('caws worktree create <name> --spec SPEC-101');
    expect(stdout).toContain('... and 1 more');
  });

  test('bound checkout (decision != no_authority) emits nothing', () => {
    const root = mkRepo();
    const stub = stubCaws(root, JSON.stringify({
      decision: 'admit',
      rule: 'scope.admit.scope_in',
    }));

    const stdout = runHook(root, stub);
    expect(stdout).not.toContain('NO write authority');
    expect(stdout.trim()).toBe('');
  });
});
