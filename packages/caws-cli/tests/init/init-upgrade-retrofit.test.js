'use strict';

/**
 * CAWS-HOOKPACK-UPGRADE-RETROFIT-001 — upgrade visibility + CLI-mediated
 * retrofit landing.
 *
 * Pins the seven contract points:
 *   A1 init diff is read-only and names kinds + BOTH version numbers
 *   A2 --overwrite without --force writes NOTHING (not even re-stamps) and
 *      presents re-stamps as their own committable unit
 *   A3 installing a managed file records its pristine baseline
 *   A4 three-way decomposition separates local growth from upstream change,
 *      and degrades honestly when no baseline exists
 *   A5 init port validates, lands, re-stamps, records the baseline, and
 *      thereby RESUMES drift tracking (unlike --adopt)
 *   A6 the sanctioned flow needs no guard exemption: protected-paths still
 *      blocks a direct Edit of an installed hook while init diff runs clean
 *   A7 init refuses to run from inside a CAWS worktree
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const {
  installHookPack,
  diffHookPack,
  portHookFile,
  readPristineBaseline,
} = require('../../dist/init/hook-install');
const {
  SHARED_PACK,
} = require('../../dist/init/hook-packs/manifest-shared');
const { resolveHookPack } = require('../../dist/init/hook-packs/register');
const {
  runInitCommand,
} = require('../../dist/shell/commands/init');

const repos = [];
afterEach(() => {
  for (const repo of repos.splice(0)) {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  repos.push(root);
  return root;
}

function vendorPack() {
  const resolution = resolveHookPack('claude-code');
  if (resolution.kind !== 'pack') throw new Error('claude-code pack unresolved');
  return resolution.pack;
}

/** Recursive [relpath, sha256(content)] snapshot of .caws/hooks (installed
 *  files + pristine baselines) — the byte-identity oracle for read-only
 *  claims. */
function snapshotHooks(repoRoot) {
  const crypto = require('crypto');
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const rel = path.relative(repoRoot, full);
        out.push([rel, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
      }
    }
  };
  walk(path.join(repoRoot, '.caws', 'hooks'));
  out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return JSON.stringify(out);
}

/** Install both packs into a fresh repo so no `created` actions can pollute
 *  the preview/write assertions. */
function installedRepo(prefix) {
  const repoRoot = mkRepo(prefix);
  installHookPack(SHARED_PACK, { repoRoot });
  installHookPack(vendorPack(), { repoRoot });
  return repoRoot;
}

function runInit(opts) {
  const out = [];
  const err = [];
  const code = runInitCommand({
    ...opts,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const GUARD = '.caws/hooks/scope-guard.sh';
const AUDIT = '.caws/hooks/audit.sh';

describe('CAWS-HOOKPACK-UPGRADE-RETROFIT-001', () => {
  test('A3: installing a managed file records its pristine baseline', () => {
    const repoRoot = mkRepo('ur-a3-');
    installHookPack(SHARED_PACK, { repoRoot });
    const installed = fs.readFileSync(path.join(repoRoot, GUARD), 'utf8');
    const baseline = readPristineBaseline(repoRoot, 'shared', GUARD);
    expect(baseline).not.toBeNull();
    expect(baseline).toBe(installed);
  });

  test('A2: --overwrite without --force writes nothing and names the re-stamp set', () => {
    const repoRoot = installedRepo('ur-a2-');
    // Stamp-only-behind: rewrite the version stamp to an older number (body
    // untouched) → managed_old_version on the next evaluation.
    const guardPath = path.join(repoRoot, GUARD);
    fs.writeFileSync(
      guardPath,
      fs
        .readFileSync(guardPath, 'utf8')
        .replace(/^# hook_pack_version: \d+$/m, `# hook_pack_version: 1`)
    );
    // Genuine drift: a grown body on a different hook.
    fs.appendFileSync(path.join(repoRoot, AUDIT), '# local growth\n');

    const before = snapshotHooks(repoRoot);
    const r = runInit({
      cwd: repoRoot,
      agentSurface: 'claude-code',
      overwrite: true,
      force: false,
      overwriteTargets: [GUARD],
    });
    expect(r.code).toBe(1); // refusals present (the unselected drift)
    expect(r.out).toContain('NOTHING was written');
    expect(r.out).toContain('Would re-stamp');
    expect(r.out).toContain(GUARD);
    expect(snapshotHooks(repoRoot)).toBe(before); // byte-identical, baselines included
  });

  test('A1: init diff is read-only, classifies kinds, and names both version numbers', () => {
    const repoRoot = installedRepo('ur-a1-');
    fs.writeFileSync(
      path.join(repoRoot, GUARD),
      fs
        .readFileSync(path.join(repoRoot, GUARD), 'utf8')
        .replace(/^# hook_pack_version: \d+$/m, `# hook_pack_version: 1`)
    );

    const before = snapshotHooks(repoRoot);
    const r = runInit({ cwd: repoRoot, agentSurface: 'claude-code', action: 'diff' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('read-only');
    expect(r.out).toContain(`installed v1 → template v${SHARED_PACK.packVersion}`);
    expect(r.out).toContain('[managed_old_version]');
    expect(snapshotHooks(repoRoot)).toBe(before);

    // --json emits the same classification machine-readably.
    const j = runInit({
      cwd: repoRoot,
      agentSurface: 'claude-code',
      action: 'diff',
      json: true,
    });
    expect(j.code).toBe(0);
    const parsed = JSON.parse(
      j.out.slice(j.out.indexOf('{'), j.out.lastIndexOf('}') + 1)
    );
    const guard = parsed.files.find((f) => f.destPath === GUARD);
    expect(guard.kind).toBe('managed_old_version');
    expect(guard.installedVersion).toBe(1);
    expect(guard.packVersion).toBe(SHARED_PACK.packVersion);
  });

  test('A4: three-way separates local growth from upstream, and degrades without a baseline', () => {
    const repoRoot = installedRepo('ur-a4-');
    fs.appendFileSync(path.join(repoRoot, AUDIT), '# my growth line\n');

    const diffs = diffHookPack(SHARED_PACK, { repoRoot });
    const audit = diffs.find((d) => d.destPath === AUDIT);
    expect(audit.threeWay.available).toBe(true);
    expect(audit.threeWay.localGrowthDiff).toContain('+# my growth line');
    // Template unchanged since the pristine install → upstream side is empty.
    expect(audit.threeWay.upstreamDiff).toBe('');

    // CLI form.
    const r = runInit({
      cwd: repoRoot,
      agentSurface: 'claude-code',
      action: 'diff',
      threeWayPath: AUDIT,
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('LOCAL GROWTH');
    expect(r.out).toContain('UPSTREAM');
    expect(r.out).toContain('my growth line');

    // Degradation: no baseline → honest two-way with a reason.
    fs.rmSync(
      path.join(repoRoot, '.caws', 'hooks', '.pristine', 'shared', '.caws', 'hooks', 'audit.sh'),
      { force: true }
    );
    const degraded = diffHookPack(SHARED_PACK, { repoRoot }).find(
      (d) => d.destPath === AUDIT
    );
    expect(degraded.threeWay.available).toBe(false);
    expect(degraded.threeWay.reason).toContain('no pristine baseline');
    expect(degraded.twoWayDiff).not.toBe('');
  });

  test('A5: port validates, lands, records the baseline, and resumes drift tracking', () => {
    const repoRoot = installedRepo('ur-a5-');
    const pristine = fs.readFileSync(path.join(repoRoot, AUDIT), 'utf8');
    const staging = path.join(os.tmpdir(), `ur-port-${Date.now()}.sh`);
    fs.writeFileSync(staging, pristine + '# ported growth\n');

    const ok = portHookFile(SHARED_PACK, {
      repoRoot,
      destPath: AUDIT,
      fromFile: staging,
    });
    expect(ok).toEqual({
      ok: true,
      destPath: AUDIT,
      packId: 'shared',
      packVersion: SHARED_PACK.packVersion,
    });

    // Landed content keeps the growth and carries the CURRENT stamp — drift
    // tracking resumes against the current version (the --adopt dead end
    // avoided).
    const landed = fs.readFileSync(path.join(repoRoot, AUDIT), 'utf8');
    expect(landed).toContain('# ported growth');
    expect(landed).toMatch(new RegExp(`^# hook_pack_version: ${SHARED_PACK.packVersion}$`, 'm'));
    expect(readPristineBaseline(repoRoot, 'shared', AUDIT)).toBe(landed);
    const after = diffHookPack(SHARED_PACK, { repoRoot }).find(
      (d) => d.destPath === AUDIT
    );
    expect(after.kind).toBe('managed_drift');
    expect(after.installedVersion).toBe(SHARED_PACK.packVersion);
    fs.rmSync(staging, { force: true });
  });

  test('A5: port refuses candidates that fail validation', () => {
    const repoRoot = installedRepo('ur-a5-refuse-');
    const staging = path.join(os.tmpdir(), `ur-bad-${Date.now()}.sh`);
    const cases = [
      ['no managed header', '#!/bin/bash\n# just a script\n'],
      ['wrong pack', fs.readFileSync(path.join(repoRoot, AUDIT), 'utf8').replace(/^# hook_pack: shared$/m, '# hook_pack: other')],
      ['dropped edit_stance', fs.readFileSync(path.join(repoRoot, AUDIT), 'utf8').replace(/edit_stance/m, 'stance_removed')],
      ['bash syntax error', fs.readFileSync(path.join(repoRoot, AUDIT), 'utf8') + '\nif [ broken; then\n'],
    ];
    for (const [name, content] of cases) {
      fs.writeFileSync(staging, content);
      const r = portHookFile(SHARED_PACK, {
        repoRoot,
        destPath: AUDIT,
        fromFile: staging,
      });
      expect([name, r.ok]).toEqual([name, false]);
      expect([name, r.reason.length > 0]).toEqual([name, true]);
    }
    const unknown = portHookFile(SHARED_PACK, {
      repoRoot,
      destPath: '.caws/hooks/nope.sh',
      fromFile: staging,
    });
    expect(unknown.ok).toBe(false);
    fs.rmSync(staging, { force: true });
  });

  test('A5: CLI port refuses a dirty destination and lands over a clean one with an audit commit', () => {
    const repoRoot = installedRepo('ur-a5-cli-');
    execFileSync('git', ['-C', repoRoot, 'add', '.caws/hooks']);
    execFileSync('git', ['-C', repoRoot, 'commit', '--quiet', '-m', 'hooks']);

    const staging = path.join(os.tmpdir(), `ur-cli-port-${Date.now()}.sh`);
    fs.writeFileSync(
      staging,
      fs.readFileSync(path.join(repoRoot, AUDIT), 'utf8') + '# cli ported growth\n'
    );

    // Dirty destination → refused, nothing landed.
    fs.appendFileSync(path.join(repoRoot, AUDIT), '# uncommitted edit\n');
    const dirty = runInit({
      cwd: repoRoot,
      agentSurface: 'claude-code',
      action: 'port',
      actionArg: AUDIT,
      fromFile: staging,
    });
    expect(dirty.code).toBe(1);
    expect(dirty.err).toContain('uncommitted changes');
    execFileSync('git', ['-C', repoRoot, 'checkout', '--', AUDIT]);

    // Clean destination → lands with an audit commit.
    const clean = runInit({
      cwd: repoRoot,
      agentSurface: 'claude-code',
      action: 'port',
      actionArg: AUDIT,
      fromFile: staging,
    });
    expect(clean.code).toBe(0);
    expect(clean.out).toContain(`Ported ${AUDIT}`);
    const subject = execFileSync('git', [
      '-C', repoRoot, 'log', '-1', '--format=%s',
    ], { encoding: 'utf8' }).trim();
    expect(subject).toContain(`port hook ${AUDIT}`);
    fs.rmSync(staging, { force: true });
  });

  test('A6: protected-paths still blocks a direct Edit while the sanctioned flow runs clean', () => {
    const repoRoot = installedRepo('ur-a6-');
    // A script under the vendor hooks dir — the artifact class protected-paths
    // owns (the shared .caws/hooks guards are covered by the scope/write
    // guards' arms).
    const vendorHook = path.join(repoRoot, '.claude', 'hooks', 'legacy-guard.sh');
    fs.mkdirSync(path.dirname(vendorHook), { recursive: true });
    fs.writeFileSync(vendorHook, '#!/bin/bash\n');
    const template = path.resolve(
      __dirname, '..', '..', 'templates', 'hook-packs', 'shared', 'protected-paths.sh'
    );
    // Direct agent-side Edit of an installed hook: still blocked, guard
    // fully active — the sanctioned flow (diff/port) needs no exemption.
    const blocked = spawnSync(
      'bash',
      [template],
      {
        input: JSON.stringify({
          tool_name: 'Edit',
          tool_input: { file_path: vendorHook },
        }),
        env: { ...process.env, CAWS_PROJECT_DIR: repoRoot },
        encoding: 'utf8',
      }
    );
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('protected');

    // And the sanctioned flow on the same repo runs clean end-to-end.
    const diff = runInit({
      cwd: repoRoot,
      agentSurface: 'claude-code',
      action: 'diff',
    });
    expect(diff.code).toBe(0);
  });

  test('A7: init refuses to run from inside a CAWS worktree', () => {
    const repoRoot = mkRepo('ur-a7-');
    const wtDir = path.join(repoRoot, '.caws', 'worktrees', 'wt-x');
    fs.mkdirSync(wtDir, { recursive: true });
    const r = runInit({ cwd: wtDir });
    expect(r.code).toBe(1);
    expect(r.err).toContain('refusing to run from inside a CAWS worktree');
  });
});
