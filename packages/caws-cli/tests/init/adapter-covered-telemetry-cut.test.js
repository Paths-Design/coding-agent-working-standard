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
} = require('../../dist/init/hook-install');

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
    for (const s of ['claude-code', 'codex', 'opencode', 'zcode', 'kimi-code', 'qwen-code', 'none']) {
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
    expect(cutDests.length).toBe(SHARED_PACK.installedFiles.length - TELEMETRY_ROW_DEST_PATHS.length);
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
    for (const surface of ['claude-code', 'codex', 'opencode', 'zcode', 'kimi-code', 'qwen-code', 'none', 'cursor', 'windsurf']) {
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
      fs.writeFileSync(
        path.join(repoRoot, '.caws/hooks/session-log.sh'),
        managedScriptBody()
      );
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
      expect(fs.readFileSync(path.join(repoRoot, '.caws/hooks/session_log_renderer.py'), 'utf8')).toBe(
        unmanagedScriptBody()
      );
    } finally {
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
      fs.writeFileSync(
        path.join(repoRoot, '.caws/hooks/agent-stop.sh'),
        managedScriptBody()
      );
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
