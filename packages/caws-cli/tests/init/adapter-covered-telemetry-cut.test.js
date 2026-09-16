'use strict';

/**
 * CAWS-HARNESS-TELEMETRY-ADAPTER-001 — the surface-conditional telemetry
 * cut (A1) and the non-covered-surfaces-unchanged guarantee (A2).
 *
 * The telemetry plane (turn-log fold + agent lease lifecycle hooks) moves to
 * a per-harness adapter for adapter-covered surfaces (ADAPTER_COVERED_SURFACES);
 * the policy plane (guards, audit, registration, dispatch) stays vendored for
 * every surface. These tests pin the manifest shape, the install-plan
 * behavior against a real repo root, and the retire-on-re-init repair.
 *
 * Runs against the COMPILED dist/ surface (main jest project), like the rest
 * of tests/init/.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SHARED_PACK,
  sharedPackForSurface,
  TELEMETRY_ROW_DEST_PATHS,
} = require('../../dist/init/hook-packs/manifest-shared');
const {
  ADAPTER_COVERED_SURFACES,
  isAdapterCoveredSurface,
} = require('../../dist/init/hook-packs/types');
const {
  planHookPackInstall,
  installHookPack,
  retireStaleTelemetryRows,
  planTelemetryRetirement,
} = require('../../dist/init/hook-install');
const { spawnSync } = require('child_process');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

afterAll(() => {
  cleanupAll();
});

/** Spawn the real CLI with CAWS_HOME pinned to a throwaway dir. Without the
 *  pin the child reads this machine's ~/.caws/surfaces/*, so a developer with
 *  configured surfaces gets a different verdict than CI — the failure class in
 *  tests/shell/init-dry-run-alias.test.js. */
function runCliIsolated(root, args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-telemetry-home-'));
  try {
    return spawnSync(process.execPath, [CLI, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CAWS_QUIET: '1', CAWS_HOME: home },
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** A GIT repo with `.caws/` present and one managed telemetry row on disk —
 *  the state in which an adapter-covered init retires something. The CLI
 *  resolves its repo root through git, so a bare mkdtemp exits 2 with
 *  store.repo_root.not_a_git_repo before ever reaching the plan. */
function repoWithManagedTelemetryRow() {
  const repoRoot = makeTempRepo();
  fs.mkdirSync(path.join(repoRoot, '.caws', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.caws/hooks/session-log.sh'), managedScriptBody());
  return repoRoot;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'caws-telemetry-cut-'));
}

/** A minimal shared-pack managed header, exactly the shape
 *  parseManagedHeader reads out of an installed hook script. */
function managedScriptBody() {
  return [
    '#!/usr/bin/env bash',
    '# CAWS-MANAGED-HOOK',
    '# hook_pack: shared',
    '# hook_pack_version: 52',
    '# caws_min_major: 11',
    '# lineage_refs: 1',
    '# do_not_edit_directly: update via `caws init --agent-surface <id>`',
    'echo telemetry',
    '',
  ].join('\n');
}

/** An unmanaged file (no CAWS-MANAGED-HOOK header) — local growth that
 *  retirement must never touch. */
function unmanagedScriptBody() {
  return '#!/usr/bin/env bash\n# my own session-log wrapper\necho local\n';
}

describe('telemetry cut: the manifest shape (A1)', () => {
  test('dsh is the sole adapter-covered surface', () => {
    expect([...ADAPTER_COVERED_SURFACES]).toEqual(['dsh']);
    expect(isAdapterCoveredSurface('dsh')).toBe(true);
    for (const s of [
      'claude-code',
      'codex',
      'opencode',
      'zcode',
      'kimi-code',
      'qwen-code',
      'none',
    ]) {
      expect(isAdapterCoveredSurface(s)).toBe(false);
    }
  });

  test('the full shared pack carries the four telemetry rows in policy-plane order', () => {
    const dests = SHARED_PACK.installedFiles.map((f) => f.destPath);
    for (const dest of TELEMETRY_ROW_DEST_PATHS) {
      expect(dests).toContain(dest);
    }
    // Exactly the four rows of the cut — no more, no fewer.
    expect([...TELEMETRY_ROW_DEST_PATHS].sort()).toEqual(
      [
        '.caws/hooks/agent-heartbeat.sh',
        '.caws/hooks/agent-stop.sh',
        '.caws/hooks/session-log.sh',
        '.caws/hooks/session_log_renderer.py',
      ].sort()
    );
    // Order invariant: the telemetry slice sits between agent-register and
    // audit, so the non-covered install order is byte-identical to pre-cut.
    expect(dests.indexOf('.caws/hooks/agent-register.sh')).toBeLessThan(
      dests.indexOf('.caws/hooks/agent-heartbeat.sh')
    );
    expect(dests.indexOf('.caws/hooks/session_log_renderer.py')).toBeLessThan(
      dests.indexOf('.caws/hooks/audit.sh')
    );
  });

  test("sharedPackForSurface('dsh') omits exactly the four rows and keeps pack identity", () => {
    const cut = sharedPackForSurface('dsh');
    expect(cut.id).toBe('shared');
    expect(cut.packVersion).toBe(SHARED_PACK.packVersion);
    expect(cut.lifecycleEvents).toEqual(SHARED_PACK.lifecycleEvents);
    const cutDests = cut.installedFiles.map((f) => f.destPath);
    for (const dest of TELEMETRY_ROW_DEST_PATHS) {
      expect(cutDests).not.toContain(dest);
    }
    expect(cutDests.length).toBe(
      SHARED_PACK.installedFiles.length - TELEMETRY_ROW_DEST_PATHS.length
    );
  });

  test('install PLAN for a dsh repo proposes no action on any telemetry row', () => {
    const repoRoot = makeTempDir();
    try {
      const plan = planHookPackInstall(sharedPackForSurface('dsh'), { repoRoot });
      const plannedDests = plan.actions.map((a) => a.destPath);
      for (const dest of TELEMETRY_ROW_DEST_PATHS) {
        expect(plannedDests).not.toContain(dest);
      }
      // The plan is honest about the policy plane it will still install.
      expect(plannedDests).toContain('.caws/hooks/scope-guard.sh');
      expect(plannedDests).toContain('.caws/hooks/agent-register.sh');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('telemetry cut: non-covered surfaces unchanged (A2)', () => {
  test('every non-covered surface resolves to SHARED_PACK itself', () => {
    for (const surface of [
      'claude-code',
      'codex',
      'opencode',
      'zcode',
      'kimi-code',
      'qwen-code',
      'none',
      'cursor',
      'windsurf',
    ]) {
      expect(sharedPackForSurface(surface)).toBe(SHARED_PACK);
    }
  });

  test('a claude-code install still writes all four telemetry rows', () => {
    const repoRoot = makeTempDir();
    try {
      // Fake template resolution is out of scope here: the install path reads
      // templates from the package templates/ dir, which exists in this repo.
      // Use --force semantics via the options contract (adopt + overwrite +
      // force) so a fresh temp repo takes every row.
      const result = installHookPack(sharedPackForSurface('claude-code'), {
        repoRoot,
        adopt: true,
        overwrite: true,
        overwriteTargets: TELEMETRY_ROW_DEST_PATHS,
        force: true,
      });
      // No refusals on a virgin repo: the four rows must exist on disk.
      expect(result.actions.filter((a) => a.action === 'refused')).toEqual([]);
      for (const dest of TELEMETRY_ROW_DEST_PATHS) {
        expect(fs.existsSync(path.join(repoRoot, dest))).toBe(true);
      }
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('telemetry cut: re-init retires stale managed rows (repair path)', () => {
  test('managed rows are removed; unmanaged files and absent paths are reported, never touched', () => {
    const repoRoot = makeTempDir();
    try {
      fs.mkdirSync(path.join(repoRoot, '.caws', 'hooks'), { recursive: true });
      // Managed stale row (has the shared-pack header).
      fs.writeFileSync(path.join(repoRoot, '.caws/hooks/session-log.sh'), managedScriptBody());
      // Unmanaged file at a telemetry dest path (local growth).
      fs.writeFileSync(
        path.join(repoRoot, '.caws/hooks/session_log_renderer.py'),
        unmanagedScriptBody()
      );
      // agent-heartbeat.sh / agent-stop.sh simply do not exist.

      const retire = retireStaleTelemetryRows(repoRoot);
      expect([...retire.retired]).toEqual(['.caws/hooks/session-log.sh']);
      expect([...retire.absent].sort()).toEqual(
        ['.caws/hooks/agent-heartbeat.sh', '.caws/hooks/agent-stop.sh'].sort()
      );
      expect([...retire.unmanaged]).toEqual(['.caws/hooks/session_log_renderer.py']);

      expect(fs.existsSync(path.join(repoRoot, '.caws/hooks/session-log.sh'))).toBe(false);
      // Local growth survives untouched.
      expect(
        fs.readFileSync(path.join(repoRoot, '.caws/hooks/session_log_renderer.py'), 'utf8')
      ).toBe(unmanagedScriptBody());
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('a failed unlink is reported as failed, never thrown (CAWS-TELEMETRY-REPAIR-RESILIENCE-001)', () => {
    const repoRoot = makeTempDir();
    const hooksDir = path.join(repoRoot, '.caws', 'hooks');
    try {
      fs.mkdirSync(hooksDir, { recursive: true });
      // Two managed rows; the read-only directory will make both unlinks
      // fail AFTER both reads succeed — exactly the guard's scenario.
      fs.writeFileSync(path.join(repoRoot, '.caws/hooks/session-log.sh'), managedScriptBody());
      fs.writeFileSync(path.join(repoRoot, '.caws/hooks/agent-stop.sh'), managedScriptBody());
      fs.chmodSync(hooksDir, 0o500); // readable, not writable → unlink EPERM

      const retire = retireStaleTelemetryRows(repoRoot);
      expect([...retire.failed].sort()).toEqual(
        ['.caws/hooks/agent-stop.sh', '.caws/hooks/session-log.sh'].sort()
      );
      // Disjoint outcomes: the two unwritten rows are absent (correct),
      // nothing silently counted as retired or unmanaged.
      expect(retire.retired).toEqual([]);
      expect([...retire.absent].sort()).toEqual(
        ['.caws/hooks/agent-heartbeat.sh', '.caws/hooks/session_log_renderer.py'].sort()
      );
      expect(retire.unmanaged).toEqual([]);
      // The row stays on disk for the next run to retry.
      expect(fs.existsSync(path.join(repoRoot, '.caws/hooks/session-log.sh'))).toBe(true);
    } finally {
      // Restore writability so the cleanup rm can recurse.
      fs.chmodSync(hooksDir, 0o700);
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('a dsh-pack install never resurrects the telemetry rows', () => {
    const repoRoot = makeTempDir();
    try {
      fs.mkdirSync(path.join(repoRoot, '.caws', 'hooks'), { recursive: true });
      // A stale row an earlier pack version installed sits on disk. The cut
      // pack's install set does not contain it, so install neither rewrites
      // nor resurrects it — removal is the separate retire step, wired at the
      // init command layer (proven by the CLI e2e in the slice evidence).
      fs.writeFileSync(path.join(repoRoot, '.caws/hooks/agent-stop.sh'), managedScriptBody());
      const result = installHookPack(sharedPackForSurface('dsh'), {
        repoRoot,
        adopt: true,
        overwrite: true,
        force: true,
      });
      expect(result.actions.filter((a) => a.action === 'refused')).toEqual([]);
      // The installed set contains no telemetry row.
      for (const action of result.actions) {
        expect(TELEMETRY_ROW_DEST_PATHS).not.toContain(action.destPath);
      }
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('CAWS-INIT-PLAN-BLIND-TELEMETRY-RETIREMENT-001: --plan previews the retirement', () => {
  test('planTelemetryRetirement classifies every row and deletes nothing', () => {
    const repoRoot = makeTempDir();
    try {
      fs.mkdirSync(path.join(repoRoot, '.caws', 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, '.caws/hooks/session-log.sh'), managedScriptBody());
      fs.writeFileSync(
        path.join(repoRoot, '.caws/hooks/session_log_renderer.py'),
        unmanagedScriptBody()
      );

      const preview = planTelemetryRetirement(repoRoot);

      expect([...preview.retire]).toEqual(['.caws/hooks/session-log.sh']);
      expect([...preview.unmanaged]).toEqual(['.caws/hooks/session_log_renderer.py']);
      expect([...preview.absent].sort()).toEqual(
        ['.caws/hooks/agent-heartbeat.sh', '.caws/hooks/agent-stop.sh'].sort()
      );
      // The whole point: a preview mutates nothing.
      expect(fs.existsSync(path.join(repoRoot, '.caws/hooks/session-log.sh'))).toBe(true);
      expect(
        fs.readFileSync(path.join(repoRoot, '.caws/hooks/session_log_renderer.py'), 'utf8')
      ).toBe(unmanagedScriptBody());
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('the preview names exactly the rows apply then unlinks (plan/apply parity)', () => {
    const repoRoot = makeTempDir();
    try {
      fs.mkdirSync(path.join(repoRoot, '.caws', 'hooks'), { recursive: true });
      // Two managed rows, one unmanaged, one absent — all four outcomes.
      fs.writeFileSync(path.join(repoRoot, '.caws/hooks/session-log.sh'), managedScriptBody());
      fs.writeFileSync(path.join(repoRoot, '.caws/hooks/agent-stop.sh'), managedScriptBody());
      fs.writeFileSync(
        path.join(repoRoot, '.caws/hooks/session_log_renderer.py'),
        unmanagedScriptBody()
      );

      const preview = planTelemetryRetirement(repoRoot);
      const applied = retireStaleTelemetryRows(repoRoot);

      // Parity is the invariant this slice exists to restore: what the
      // preview promised is exactly what apply did.
      expect([...preview.retire].sort()).toEqual([...applied.retired].sort());
      expect([...preview.unmanaged].sort()).toEqual([...applied.unmanaged].sort());
      expect([...preview.absent].sort()).toEqual([...applied.absent].sort());
      // Non-vacuous: the fixture really did have rows to retire.
      expect(preview.retire.length).toBe(2);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('a repo with nothing to retire previews an empty retire set', () => {
    const repoRoot = makeTempDir();
    try {
      fs.mkdirSync(path.join(repoRoot, '.caws', 'hooks'), { recursive: true });
      const preview = planTelemetryRetirement(repoRoot);
      expect(preview.retire).toEqual([]);
      expect([...preview.absent].sort()).toEqual([...TELEMETRY_ROW_DEST_PATHS].sort());
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('init --plan --json for an adapter-covered surface enumerates the deletions', () => {
    const repoRoot = repoWithManagedTelemetryRow();
    try {
      const res = runCliIsolated(repoRoot, ['init', '--agent-surface', 'dsh', '--plan', '--json']);
      expect(res.status).toBe(0);
      const plan = JSON.parse(res.stdout);
      expect(plan.read_only).toBe(true);
      expect(plan.telemetry_retirement).toBeDefined();
      expect(plan.telemetry_retirement.retire).toContain('.caws/hooks/session-log.sh');
      // The row is still on disk: --plan promised a deletion, it did not do one.
      expect(fs.existsSync(path.join(repoRoot, '.caws/hooks/session-log.sh'))).toBe(true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('the human-readable plan names each row it will unlink', () => {
    const repoRoot = repoWithManagedTelemetryRow();
    try {
      const res = runCliIsolated(repoRoot, ['init', '--agent-surface', 'dsh', '--plan']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('.caws/hooks/session-log.sh');
      // It must read as a deletion, not as an unchanged row.
      expect(res.stdout).toMatch(/retire/i);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('a NON-covered surface reports no retirement even with rows on disk', () => {
    const repoRoot = repoWithManagedTelemetryRow();
    try {
      const res = runCliIsolated(repoRoot, [
        'init',
        '--agent-surface',
        'claude-code',
        '--plan',
        '--json',
      ]);
      const plan = JSON.parse(res.stdout);
      // claude-code is not adapter-covered: it retires nothing, so the
      // section must be absent rather than an empty-but-present promise.
      expect(plan.telemetry_retirement).toBeUndefined();
      // The same row that dsh would RETIRE is an INSTALL target here, and the
      // fixture pins it at an older pack version — so the plan refuses it as
      // managed drift and exits 1. Asserted rather than ignored, so this test
      // cannot pass because the plan failed for some unrelated new reason.
      expect(res.status).toBe(1);
      expect(plan.hook_pack.actions.filter((a) => a.action === 'refused')).toEqual([
        {
          destPath: '.caws/hooks/session-log.sh',
          action: 'refused',
          refusalReason: 'managed_drift',
        },
      ]);
      // And the refusal is non-destructive: the row is still on disk.
      expect(fs.existsSync(path.join(repoRoot, '.caws/hooks/session-log.sh'))).toBe(true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

/**
 * CAWS-INIT-TELEMETRY-RETIRE-SURFACE-BLIND-001 — retirement must read the
 * whole repo, not just the surface being installed.
 *
 * The rows under .caws/hooks/ are shared: every NON-covered surface's install
 * set still contains them and its dispatchers exec them directly. Retiring
 * them because ONE covered surface was initialized strips a live telemetry
 * plane from every co-installed surface — and because run_handlers treats a
 * missing handler as `missing` + `continue`, the loss is silent.
 */
describe('CAWS-INIT-TELEMETRY-RETIRE-SURFACE-BLIND-001: retirement is surface-aware', () => {
  const { resolveHookPack } = require('../../dist/init/hook-packs/register');
  const { observeInstalledPackSurfaces } = require('../../dist/init/hook-install');

  /** A managed file body stamped for an arbitrary pack id — the shape
   *  observeInstalledPackSurfaces reads to decide a pack is installed. */
  function managedVendorBody(packId) {
    return [
      '#!/usr/bin/env bash',
      '# CAWS-MANAGED-HOOK',
      `# hook_pack: ${packId}`,
      '# hook_pack_version: 52',
      '# caws_min_major: 11',
      '# lineage_refs: 1',
      '# do_not_edit_directly: update via `caws init --agent-surface <id>`',
      'echo vendor',
      '',
    ].join('\n');
  }

  /** Install a surface's pack marker by writing its FIRST managed file from
   *  the real manifest, so the fixture cannot drift from what init installs. */
  function installVendorMarker(repoRoot, surface) {
    const resolution = resolveHookPack(surface);
    if (resolution.kind !== 'pack') throw new Error(`no pack for ${surface}`);
    const file = resolution.pack.installedFiles.find((f) => f.managed);
    if (!file) throw new Error(`no managed file in pack ${surface}`);
    const abs = path.join(repoRoot, file.destPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, managedVendorBody(resolution.pack.id));
    return file.destPath;
  }

  /** A git repo with all four telemetry rows present as shared-pack-managed
   *  installs — the only state in which retirement has anything to do. */
  function repoWithAllTelemetryRows() {
    const repoRoot = makeTempRepo();
    fs.mkdirSync(path.join(repoRoot, '.caws', 'hooks'), { recursive: true });
    for (const relPath of TELEMETRY_ROW_DEST_PATHS) {
      fs.writeFileSync(path.join(repoRoot, relPath), managedScriptBody());
    }
    return repoRoot;
  }

  test('a pack counts as installed only when a managed header names it', () => {
    const repoRoot = repoWithAllTelemetryRows();

    // A vendor directory alone is not a CAWS install: any project may carry
    // .qwen/. Writing the pack's own dest path WITHOUT a header must not
    // register the surface, or an unrelated tree would veto every retirement.
    const destPath = resolveHookPack('qwen-code').pack.installedFiles.find(
      (f) => f.managed
    ).destPath;
    const abs = path.join(repoRoot, destPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '#!/usr/bin/env bash\necho not ours\n');
    expect([...observeInstalledPackSurfaces(repoRoot)]).toEqual([]);

    // The same path WITH the pack's header does register it.
    fs.writeFileSync(abs, managedVendorBody('qwen-code'));
    expect([...observeInstalledPackSurfaces(repoRoot)]).toEqual(['qwen-code']);
  });

  test('A1: a co-installed non-covered surface keeps every telemetry row', () => {
    const repoRoot = repoWithAllTelemetryRows();
    installVendorMarker(repoRoot, 'dsh');
    installVendorMarker(repoRoot, 'qwen-code');

    const plan = planTelemetryRetirement(repoRoot);
    expect([...plan.retire]).toEqual([]);
    expect([...plan.retained]).toEqual([...TELEMETRY_ROW_DEST_PATHS]);
    expect([...plan.retainedFor]).toEqual(['qwen-code']);

    // Apply must agree with the preview AND leave the bytes on disk.
    const result = retireStaleTelemetryRows(repoRoot);
    expect([...result.retired]).toEqual([]);
    expect([...result.retained]).toEqual([...TELEMETRY_ROW_DEST_PATHS]);
    for (const relPath of TELEMETRY_ROW_DEST_PATHS) {
      expect(fs.readFileSync(path.join(repoRoot, relPath), 'utf8')).toBe(managedScriptBody());
    }
  });

  test('A3: a repo with only adapter-covered surfaces still retires every row', () => {
    const repoRoot = repoWithAllTelemetryRows();
    installVendorMarker(repoRoot, 'dsh');

    const plan = planTelemetryRetirement(repoRoot);
    expect([...plan.retire]).toEqual([...TELEMETRY_ROW_DEST_PATHS]);
    expect([...plan.retained]).toEqual([]);
    // No retention, so no reason is asserted.
    expect([...plan.retainedFor]).toEqual([]);

    const result = retireStaleTelemetryRows(repoRoot);
    expect([...result.retired]).toEqual([...TELEMETRY_ROW_DEST_PATHS]);
    for (const relPath of TELEMETRY_ROW_DEST_PATHS) {
      expect(fs.existsSync(path.join(repoRoot, relPath))).toBe(false);
    }
  });

  test('A4: an unmanaged row is never retired and never retained-as-ours', () => {
    for (const coInstalled of [[], ['qwen-code']]) {
      const repoRoot = repoWithAllTelemetryRows();
      const local = '.caws/hooks/session-log.sh';
      fs.writeFileSync(path.join(repoRoot, local), unmanagedScriptBody());
      installVendorMarker(repoRoot, 'dsh');
      for (const surface of coInstalled) installVendorMarker(repoRoot, surface);

      const plan = planTelemetryRetirement(repoRoot);
      expect([...plan.unmanaged]).toEqual([local]);
      expect([...plan.retire]).not.toContain(local);
      expect([...plan.retained]).not.toContain(local);

      retireStaleTelemetryRows(repoRoot);
      // Byte-identical: local growth survives both configurations intact.
      expect(fs.readFileSync(path.join(repoRoot, local), 'utf8')).toBe(unmanagedScriptBody());
    }
  });

  test('A2: doctor stops calling the rows stale once a surface claims them', () => {
    function repairRules(repoRoot) {
      const result = runCliIsolated(repoRoot, ['doctor', '--repair-plan', '--json']);
      const payload = JSON.parse(result.stdout);
      return payload.items.map((item) => item.source_rule);
    }

    const onlyCovered = repoWithAllTelemetryRows();
    installVendorMarker(onlyCovered, 'dsh');
    const mixed = repoWithAllTelemetryRows();
    installVendorMarker(mixed, 'dsh');
    installVendorMarker(mixed, 'zcode');

    // Contrast half: with nothing claiming the rows the finding MUST fire,
    // so the assertion below cannot pass because doctor went quiet for an
    // unrelated reason (empty plan, crash, changed JSON shape).
    expect(repairRules(onlyCovered)).toContain('doctor.hooks.stale_telemetry_pack');
    expect(repairRules(mixed)).not.toContain('doctor.hooks.stale_telemetry_pack');
  });

  test('the plan preview names the rows it keeps and who keeps them', () => {
    const repoRoot = repoWithAllTelemetryRows();
    installVendorMarker(repoRoot, 'dsh');
    installVendorMarker(repoRoot, 'opencode');

    const result = runCliIsolated(repoRoot, ['init', '--agent-surface', 'dsh', '--plan']);
    expect(result.stdout).toContain('kept, still installed by opencode');
    expect(result.stdout).toContain('.caws/hooks/session-log.sh');
    expect(result.stdout).toContain('would retire: none');
    // Read-only: the preview must not have performed the retirement.
    for (const relPath of TELEMETRY_ROW_DEST_PATHS) {
      expect(fs.existsSync(path.join(repoRoot, relPath))).toBe(true);
    }
  });
});
