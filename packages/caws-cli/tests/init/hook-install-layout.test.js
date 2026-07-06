'use strict';

/**
 * Hook-install 3-tier layout + manifest-drift coverage (A1, A2).
 *
 * CAWS-TEST-HOOK-INSTALL-FINGERPRINT-001. Installs the hook pack into an
 * isolated temp repo via the slice-0 primitive (claude-code surface) and
 * asserts:
 *   A1 — the post-shared-core 3-tier layout: shared core under .caws/hooks/
 *        (dispatch + lib + guards) + vendor wiring under .claude/; the installed
 *        files match the SHARED_PACK + CLAUDE_CODE_PACK manifest destPaths.
 *   A2 — manifest-vs-disk drift: every manifest sourcePath exists under its
 *        template dir, and every on-disk template file (minus exclusions) is
 *        declared in the manifest — no drift either direction.
 *
 * The SHARED install is done ONCE (beforeAll), not per test.
 */

const fs = require('fs');
const path = require('path');
const { makeTempRepo, cleanupAll } = require('../helpers/git-repo-factory');
const { installOnce } = require('../helpers/hook-install');

const CLI_PKG_ROOT = path.resolve(__dirname, '..', '..');
const PACKS_ROOT = path.join(CLI_PKG_ROOT, 'templates', 'hook-packs');

const { SHARED_PACK } = require('../../dist/init/hook-packs/manifest-shared');
const { CLAUDE_CODE_PACK } = require('../../dist/init/hook-packs/manifest-claude-code');
const { CODEX_PACK } = require('../../dist/init/hook-packs/manifest-codex');
const { ZCODE_PACK } = require('../../dist/init/hook-packs/manifest-zcode');

const EXCLUDED_DIRS = new Set(['tmp', '.caws', '__pycache__', 'node_modules']);
const EXCLUDED_FILES = new Set(['.DS_Store']);

function listTemplateFiles(packDir, baseDir = packDir) {
  const out = [];
  for (const entry of fs.readdirSync(packDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      out.push(...listTemplateFiles(path.join(packDir, entry.name), baseDir));
    } else if (entry.isFile() && !EXCLUDED_FILES.has(entry.name)) {
      out.push(path.relative(baseDir, path.join(packDir, entry.name)).split(path.sep).join('/'));
    }
  }
  return out;
}

describe('hook install: 3-tier layout (A1)', () => {
  let ctx;
  beforeAll(() => {
    ctx = installOnce(makeTempRepo(), { agentSurface: 'claude-code' });
  });
  afterAll(() => cleanupAll());

  test('init succeeded', () => {
    expect(ctx.code).toBe(0);
  });

  test('the shared core is installed under .caws/hooks/ (dispatch + lib + guards)', () => {
    const hooksDir = path.join(ctx.repoDir, '.caws', 'hooks');
    expect(fs.existsSync(hooksDir)).toBe(true);
    // Representative shared-core artifacts from the SHARED_PACK manifest.
    expect(fs.existsSync(path.join(hooksDir, 'dispatch', 'pre_tool_use.sh'))).toBe(true);
    expect(fs.existsSync(path.join(hooksDir, 'lib', 'agent-surface.sh'))).toBe(true);
    expect(fs.existsSync(path.join(hooksDir, 'scope-guard.sh'))).toBe(true);
    expect(fs.existsSync(path.join(hooksDir, 'classify_command.py'))).toBe(true);
  });

  test('the vendor wiring is installed under .claude/ (not .caws/hooks/)', () => {
    // The claude-code pack carries CLAUDE.md + README.md (vendor docs/wiring).
    const claudeDir = path.join(ctx.repoDir, '.claude');
    expect(fs.existsSync(claudeDir)).toBe(true);
  });

  test('every SHARED_PACK manifest destPath is materialized on disk', () => {
    for (const f of SHARED_PACK.installedFiles) {
      expect(fs.existsSync(path.join(ctx.repoDir, f.destPath))).toBe(true);
    }
  });

  test('every CLAUDE_CODE_PACK manifest destPath is materialized on disk', () => {
    for (const f of CLAUDE_CODE_PACK.installedFiles) {
      expect(fs.existsSync(path.join(ctx.repoDir, f.destPath))).toBe(true);
    }
  });

  test('shared-core dispatch scripts are executable', () => {
    const dispatch = path.join(ctx.repoDir, '.caws', 'hooks', 'dispatch', 'pre_tool_use.sh');
    const mode = fs.statSync(dispatch).mode & 0o111;
    expect(mode).not.toBe(0); // at least one exec bit set
  });
});

describe('manifest-vs-disk drift (A2): no drift in either direction', () => {
  // Template files that ship in a pack dir but are NOT manifest-installed
  // copies — they are consumed by a SEPARATE code path. settings.json.example
  // is written programmatically by hook-install.ts:writeSettingsExample (it is
  // non-destructive — a user's real settings.json is never clobbered), so it is
  // deliberately absent from CLAUDE_CODE_PACK.installedFiles. Listing it here
  // (not silently widening the check) keeps the drift guard sharp: a NEW
  // undeclared file still fails.
  const KNOWN_NON_MANIFEST_FILES = {
    'claude-code': new Set(['settings.json.example']),
  };

  const PACKS = [
    { id: 'shared', manifest: SHARED_PACK, dir: path.join(PACKS_ROOT, 'shared') },
    { id: 'claude-code', manifest: CLAUDE_CODE_PACK, dir: path.join(PACKS_ROOT, 'claude-code') },
    { id: 'codex', manifest: CODEX_PACK, dir: path.join(PACKS_ROOT, 'codex') },
    { id: 'zcode', manifest: ZCODE_PACK, dir: path.join(PACKS_ROOT, 'zcode') },
  ];

  test.each(PACKS)('$id: every manifest sourcePath exists on disk', ({ manifest, dir }) => {
    for (const f of manifest.installedFiles) {
      expect(fs.existsSync(path.join(dir, f.sourcePath))).toBe(true);
    }
  });

  test.each(PACKS)('$id: every on-disk template file is declared (or a known non-manifest file)', ({ id, manifest, dir }) => {
    const declared = new Set(manifest.installedFiles.map((f) => f.sourcePath));
    const allowed = KNOWN_NON_MANIFEST_FILES[id] ?? new Set();
    const onDisk = listTemplateFiles(dir);
    const undeclared = onDisk.filter((f) => !declared.has(f) && !allowed.has(f));
    expect(undeclared).toEqual([]);
  });

  test('settings.json.example is the documented non-manifest exception and IS present on disk', () => {
    // Pin the exception: it must exist (written-program path depends on it) and
    // must NOT be in the manifest (it would clobber user settings if copied).
    const examplePath = path.join(PACKS_ROOT, 'claude-code', 'settings.json.example');
    expect(fs.existsSync(examplePath)).toBe(true);
    const declared = new Set(CLAUDE_CODE_PACK.installedFiles.map((f) => f.sourcePath));
    expect(declared.has('settings.json.example')).toBe(false);
  });
});
