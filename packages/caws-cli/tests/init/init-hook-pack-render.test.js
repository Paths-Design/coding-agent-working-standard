'use strict';

/**
 * Managed-hook header growth-doctrine guard.
 *
 * CAWS-HOOK-PACK-MANAGED-HEADER-GROWTH-DOCTRINE-001. The shipped hook headers
 * previously carried `# do_not_edit_directly: update via caws init`, which
 * contradicts the maintainer doctrine that hooks are a starting point the repo
 * OWNS and grows. That contradiction trained agents to treat a hook needing a
 * tweak as an upstream CAWS bug instead of editing their own hook. This suite
 * pins these things so the contradiction cannot return:
 *
 *   A1 — no managed template carries the "do_not_edit_directly" /
 *        "update via caws init" edit-prohibition header line; the growth-stance
 *        `edit_stance:` line is present instead.
 *   A2 — parseManagedHeader still resolves the machine-read marker keys
 *        (hookPack / hookPackVersion / cawsMinMajor / lineageRefs) on a header
 *        rewritten to the new framing: the framing change must not break the
 *        install layer's recognition of a file as managed.
 *   A3 — renderHookPackInstall frames a repo-edited managed hook
 *        (managed_drift) as expected/preserved ("kept your edits", growth
 *        language) and NOT as a problem to "resolve"; an unmanaged_collision is
 *        still surfaced as a genuine refusal.
 */

const fs = require('fs');
const path = require('path');

const CLI_PKG_ROOT = path.resolve(__dirname, '..', '..');
const PACKS_ROOT = path.join(CLI_PKG_ROOT, 'templates', 'hook-packs');

const os = require('os');
const {
  parseManagedHeader,
  installHookPack,
  planHookPackInstall,
} = require('../../dist/init/hook-install');
const { SHARED_PACK } = require('../../dist/init/hook-packs/manifest-shared');
const { CLAUDE_CODE_PACK } = require('../../dist/init/hook-packs/manifest-claude-code');
const { OPENCODE_PACK } = require('../../dist/init/hook-packs/manifest-opencode');
const { CODEX_PACK } = require('../../dist/init/hook-packs/manifest-codex');
const { renderHookPackInstall } = require('../../dist/shell/render/init-hook-pack');

const EXCLUDED_DIRS = new Set(['tmp', '.caws', '__pycache__', 'node_modules']);
const EXCLUDED_FILES = new Set(['.DS_Store']);

/** Every file under packDir, minus excluded dirs/files. */
function listTemplateFiles(dir, baseDir = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      out.push(...listTemplateFiles(path.join(dir, entry.name), baseDir));
    } else if (entry.isFile() && !EXCLUDED_FILES.has(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const ALL_TEMPLATE_FILES = ['shared', 'claude-code', 'codex', 'opencode', 'zcode'].flatMap(
  (pack) => listTemplateFiles(path.join(PACKS_ROOT, pack))
);

/** The subset of template files that carry the managed marker (the ones whose
 *  header the install layer parses). */
const MANAGED_FILES = ALL_TEMPLATE_FILES.filter((f) =>
  fs.readFileSync(f, 'utf8').includes('CAWS-MANAGED-HOOK')
);

describe('A1: no managed header carries the contradicting edit-prohibition', () => {
  test('there is at least one managed template (guard is exercising real files)', () => {
    // Falsifiability anchor: if MANAGED_FILES were empty, A1's grep would
    // vacuously pass. The shared pack alone ships dozens of managed hooks.
    expect(MANAGED_FILES.length).toBeGreaterThan(20);
  });

  test('no template file contains "do_not_edit_directly"', () => {
    const offenders = ALL_TEMPLATE_FILES.filter((f) =>
      fs.readFileSync(f, 'utf8').includes('do_not_edit_directly')
    ).map((f) => path.relative(PACKS_ROOT, f));
    expect(offenders).toEqual([]);
  });

  test('no template file instructs the reader to "update via `caws init`" as the way to change a hook', () => {
    const offenders = ALL_TEMPLATE_FILES.filter((f) =>
      /update via `?caws init/.test(fs.readFileSync(f, 'utf8'))
    ).map((f) => path.relative(PACKS_ROOT, f));
    expect(offenders).toEqual([]);
  });

  test('every managed file carries the growth-stance edit_stance marker', () => {
    // Managed templates with CAWS headers must carry `edit_stance:`. Codex
    // hooks.json is intentionally excluded now because Codex rejects extra
    // top-level JSON metadata.
    const missing = MANAGED_FILES.filter(
      (f) => !/edit_stance:/.test(fs.readFileSync(f, 'utf8'))
    ).map((f) => path.relative(PACKS_ROOT, f));
    expect(missing).toEqual([]);
  });

  test('the edit_stance line states the repo owns/may grow the hook and that bypass is the one out-of-bounds edit', () => {
    // Assert the SEMANTICS of one representative header, not just presence —
    // an empty or watered-down edit_stance line must fail.
    const sample = fs.readFileSync(path.join(PACKS_ROOT, 'shared', 'scope-guard.sh'), 'utf8');
    expect(sample).toMatch(/OWNS and may grow this hook/);
    expect(sample).toMatch(/--adopt to keep yours/);
    expect(sample).toMatch(/--overwrite to pull this upstream/);
    expect(sample).toMatch(/do not edit it to BYPASS the guard/i);
  });
});

describe('A2: parseManagedHeader still recognizes a rewritten header as managed', () => {
  test('the live scope-guard.sh header parses to its marker keys', () => {
    const content = fs.readFileSync(path.join(PACKS_ROOT, 'shared', 'scope-guard.sh'), 'utf8');
    const header = parseManagedHeader(content);
    expect(header).not.toBeNull();
    expect(header.hookPack).toBe('shared');
    expect(header.hookPackVersion).toBeGreaterThan(0);
    expect(header.cawsMinMajor).toBe(11);
    // scope-guard.sh declares lineage_refs: 8,11,12,16
    expect(header.lineageRefs).toEqual([8, 11, 12, 16]);
  });

  test('EVERY managed template file still parses as managed after the rewrite', () => {
    const unparsable = MANAGED_FILES.filter(
      (f) => parseManagedHeader(fs.readFileSync(f, 'utf8')) === null
    ).map((f) => path.relative(PACKS_ROOT, f));
    expect(unparsable).toEqual([]);
  });

  test('the multi-line edit_stance block does not swallow or corrupt a marker key', () => {
    // Construct a header in the exact shape we ship: marker keys first, then the
    // 5-line edit_stance block. The continuation lines (no `key:` colon) must
    // not be misparsed as keys, and the block must not push the keys out of the
    // parser's 30-line window.
    const header = [
      '#!/bin/bash',
      '# CAWS-MANAGED-HOOK',
      '# hook_pack: shared',
      '# hook_pack_version: 6',
      '# caws_min_major: 11',
      '# lineage_refs: 8,11',
      '# edit_stance: this repo OWNS and may grow this hook. Edits are expected and',
      '#   preserved — `caws init` refuses to overwrite a changed managed hook (re-run',
      '#   with --adopt to keep yours, or --overwrite to pull this upstream template).',
      '#   CAWS owns the failure-class invariant (the why/what you must not silently',
      '#   weaken); you own the how. Do not edit it to BYPASS the guard; do grow it.',
      '#',
      'echo hi',
    ].join('\n');
    const parsed = parseManagedHeader(header);
    expect(parsed).toEqual({
      hookPack: 'shared',
      hookPackVersion: 6,
      cawsMinMajor: 11,
      lineageRefs: [8, 11],
    });
  });
});

describe('A3: render frames a grown (drifted) managed hook as expected, not a problem', () => {
  function renderWith(actions, outcome = 'installed') {
    return renderHookPackInstall({
      pack: { id: 'shared', packVersion: 6, summary: 'test pack' },
      outcome,
      activation: 'restart_required',
      actions,
    });
  }

  test('a managed_drift refusal is reported as kept-your-edits with growth language, not "resolve"', () => {
    const out = renderWith([
      {
        destPath: '.caws/hooks/scope-guard.sh',
        action: 'refused',
        refusalReason: 'managed_drift',
      },
    ]);
    expect(out).toMatch(/Kept your edits/);
    // "because this repo\nedited them" wraps across a line — match tolerantly.
    expect(out).toMatch(/this repo\s+edited them/i);
    expect(out).toMatch(/did NOT overwrite/);
    expect(out).toMatch(/--adopt/);
    expect(out).toMatch(/--overwrite/);
    // The grown-hook path must NOT use the old "were refused. To resolve"
    // problem framing, which is what trained agents to treat their growth as an
    // error to fix.
    expect(out).not.toMatch(/were refused\. To resolve/);
  });

  test('an unmanaged_collision is still surfaced as a genuine refusal needing attention', () => {
    const out = renderWith([
      {
        destPath: '.caws/hooks/scope-guard.sh',
        action: 'refused',
        refusalReason: 'unmanaged_collision',
      },
    ]);
    expect(out).toMatch(/unmanaged file at a managed path/i);
    expect(out).toMatch(/no CAWS-MANAGED-HOOK/);
    expect(out).toMatch(/--overwrite/);
  });

  test('a clean create/update run says nothing about drift or collision', () => {
    const out = renderWith([{ destPath: '.caws/hooks/scope-guard.sh', action: 'created' }]);
    expect(out).toMatch(/Created \(1\)/);
    expect(out).not.toMatch(/Kept your edits/);
    expect(out).not.toMatch(/unmanaged file at a managed path/i);
  });

  test('a forceRequired refusal renders the withheld block: per-file diff plus the --force remediation', () => {
    const out = renderWith([
      {
        destPath: '.caws/hooks/scope-guard.sh',
        action: 'refused',
        refusalReason: 'managed_drift',
        forceRequired: true,
        diff: [
          '--- local: .caws/hooks/scope-guard.sh',
          '+++ incoming: shared v6 template',
          '@@ -1,1 +1,1 @@',
          '-# mine',
          '+# upstream',
        ].join('\n'),
      },
    ]);
    expect(out).toMatch(/Overwrite withheld — needs --force \(1\)/);
    // The diff body is printed line-by-line so the operator sees exactly what
    // --force would discard (-) and pull in (+).
    expect(out).toMatch(/^\s+-# mine$/m);
    expect(out).toMatch(/^\s+\+# upstream$/m);
    expect(out).toMatch(/--overwrite --force/);
    expect(out).toMatch(/--adopt/);
    // A withheld overwrite is NOT the default kept-your-edits drift block.
    expect(out).not.toMatch(/Kept your edits/);
  });
});

describe('A4: caws init preserves a grown hook and never silently clobbers it', () => {
  // These drive the real install pipeline (installHookPack) against a temp repo,
  // because the bug — a version bump silently overwriting an edited hook — lives
  // in the interaction between version stamping (renderPackFileBytes) and the
  // file-state decision (evaluateFileState), not in either alone.
  let repoRoot;
  // A representative shared hook with a multi-line body, so a real edit is
  // unambiguous.
  const REL = '.caws/hooks/scope-guard.sh';

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-growth-'));
    // Fresh install.
    const r = installHookPack(SHARED_PACK, { repoRoot });
    const created = r.actions.find((a) => a.destPath === REL);
    expect(created && created.action).toBe('created');
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  function abs(rel) {
    return path.join(repoRoot, rel);
  }

  test('the installed header version is STAMPED to the manifest pack version (not the frozen template literal)', () => {
    const installed = fs.readFileSync(abs(REL), 'utf8');
    const header = parseManagedHeader(installed);
    // The template literal is 1/2; the stamp must lift it to the current pack
    // version. If this reads 1, the version-line is frozen and the
    // old-version-overwrite bug is live.
    expect(header.hookPackVersion).toBe(SHARED_PACK.packVersion);
  });

  test('re-init of an UNMODIFIED hook is a no-op (unchanged), not an overwrite churn', () => {
    const before = fs.readFileSync(abs(REL));
    const r = installHookPack(SHARED_PACK, { repoRoot });
    const a = r.actions.find((x) => x.destPath === REL);
    expect(a.action).toBe('unchanged');
    expect(fs.readFileSync(abs(REL)).equals(before)).toBe(true);
  });

  test('re-init of a GROWN (edited) hook is REFUSED as drift and the edit SURVIVES', () => {
    const grown =
      fs.readFileSync(abs(REL), 'utf8') +
      '\n# repo-specific growth: extra CI logging\necho "[our-ci] ran" >&2\n';
    fs.writeFileSync(abs(REL), grown);

    const r = installHookPack(SHARED_PACK, { repoRoot });
    const a = r.actions.find((x) => x.destPath === REL);
    // The grown hook must NOT be overwritten. It is preserved as drift.
    expect(a.action).toBe('refused');
    expect(a.refusalReason).toBe('managed_drift');
    // The growth survives byte-for-byte.
    expect(fs.readFileSync(abs(REL), 'utf8')).toBe(grown);
  });

  test('--overwrite WITHOUT --force on a grown hook withholds the write and surfaces a diff', () => {
    const grown = fs.readFileSync(abs(REL), 'utf8') + '\n# growth kept until forced\n';
    fs.writeFileSync(abs(REL), grown);

    const r = installHookPack(SHARED_PACK, { repoRoot, overwrite: true });
    const a = r.actions.find((x) => x.destPath === REL);
    // Selected for overwrite but not confirmed: refused, marked forceRequired,
    // and the diff names the exact local line --force would discard.
    expect(a.action).toBe('refused');
    expect(a.refusalReason).toBe('managed_drift');
    expect(a.forceRequired).toBe(true);
    expect(a.diff).toMatch(/^-# growth kept until forced$/m);
    // The local file survives byte-for-byte.
    expect(fs.readFileSync(abs(REL), 'utf8')).toBe(grown);
  });

  test('--overwrite --force on a grown hook DOES take the upstream template (the one path that discards edits)', () => {
    const grown = fs.readFileSync(abs(REL), 'utf8') + '\n# growth that will be discarded\n';
    fs.writeFileSync(abs(REL), grown);

    const r = installHookPack(SHARED_PACK, { repoRoot, overwrite: true, force: true });
    const a = r.actions.find((x) => x.destPath === REL);
    expect(a.action).toBe('updated');
    expect(fs.readFileSync(abs(REL), 'utf8')).not.toContain('growth that will be discarded');
  });

  test('targeted --overwrite --force replaces ONLY the listed destPath; other drifted files keep the plain refusal', () => {
    const OTHER = '.caws/hooks/classify_command.py';
    const grownTarget = fs.readFileSync(abs(REL), 'utf8') + '\n# target growth\n';
    const grownOther = fs.readFileSync(abs(OTHER), 'utf8') + '\n# other growth\n';
    fs.writeFileSync(abs(REL), grownTarget);
    fs.writeFileSync(abs(OTHER), grownOther);

    const r = installHookPack(SHARED_PACK, {
      repoRoot,
      overwrite: true,
      overwriteTargets: [REL],
      force: true,
    });
    const target = r.actions.find((x) => x.destPath === REL);
    const other = r.actions.find((x) => x.destPath === OTHER);
    expect(target.action).toBe('updated');
    expect(fs.readFileSync(abs(REL), 'utf8')).not.toContain('target growth');
    // The untargeted drifted file behaves as if --overwrite was not passed:
    // plain drift refusal, no forceRequired, bytes intact.
    expect(other.action).toBe('refused');
    expect(other.refusalReason).toBe('managed_drift');
    expect(other.forceRequired).toBeUndefined();
    expect(fs.readFileSync(abs(OTHER), 'utf8')).toBe(grownOther);
  });

  test('--adopt on a grown hook keeps the edit and reports unchanged', () => {
    const grown = fs.readFileSync(abs(REL), 'utf8') + '\n# adopted growth\n';
    fs.writeFileSync(abs(REL), grown);

    const r = installHookPack(SHARED_PACK, { repoRoot, adopt: true });
    const a = r.actions.find((x) => x.destPath === REL);
    expect(a.action).toBe('unchanged');
    expect(fs.readFileSync(abs(REL), 'utf8')).toBe(grown);
  });

  test('the plan path previews the withheld overwrite (diff attached) without writing anything', () => {
    const grown = fs.readFileSync(abs(REL), 'utf8') + '\n# plan-preview growth\n';
    fs.writeFileSync(abs(REL), grown);

    const r = planHookPackInstall(SHARED_PACK, { repoRoot, overwrite: true });
    const a = r.actions.find((x) => x.destPath === REL);
    expect(r.readOnly).toBe(true);
    expect(a.action).toBe('refused');
    expect(a.forceRequired).toBe(true);
    expect(a.diff).toMatch(/^-# plan-preview growth$/m);
    // Read-only means read-only even with overwrite+force: plan never writes.
    const forced = planHookPackInstall(SHARED_PACK, { repoRoot, overwrite: true, force: true });
    expect(forced.actions.find((x) => x.destPath === REL).action).toBe('updated');
    expect(fs.readFileSync(abs(REL), 'utf8')).toBe(grown);
  });

  test('a hook carrying only an OLD version stamp (unedited body) is safely re-stamped, not preserved as drift', () => {
    // Simulate a consumer who installed before version stamping: same body, but
    // the header version line reads an older number. This must update (re-stamp)
    // — it is NOT an edit to preserve — so existing consumers are not all shown
    // spurious drift on first upgrade.
    const installed = fs.readFileSync(abs(REL), 'utf8');
    const downgraded = installed.replace(/^(#\s*hook_pack_version:\s*)\d+/m, '$11');
    expect(downgraded).not.toBe(installed); // sanity: the stamp actually changed
    fs.writeFileSync(abs(REL), downgraded);

    const r = installHookPack(SHARED_PACK, { repoRoot });
    const a = r.actions.find((x) => x.destPath === REL);
    expect(a.action).toBe('updated');
    // After re-stamp the body is unchanged and the version is current again.
    const after = parseManagedHeader(fs.readFileSync(abs(REL), 'utf8'));
    expect(after.hookPackVersion).toBe(SHARED_PACK.packVersion);
  });
});

/**
 * A5 — multi-surface additivity. `caws init --agent-surface <X>` runs
 * installHookPack(SHARED_PACK) + installHookPack(<vendor>). A repo can carry
 * several surfaces at once (claude-code + codex + opencode). Adding a surface
 * MUST be additive: it must not clobber a shared hook the repo has grown, and
 * it must not touch another surface's vendor dir. The vendor dirs (.claude/,
 * .codex/, .opencode/) are disjoint by design; the shared core (.caws/hooks/)
 * is common, so its drift-refusal machinery is what protects hand-edits when a
 * second surface re-installs SHARED_PACK.
 */
describe('A5: installing a second surface is additive — preserves a grown shared hook and leaves other surfaces untouched', () => {
  const SHARED_REL = '.caws/hooks/scope-guard.sh';
  const CLAUDE_REL = '.claude/hooks/CLAUDE.md';
  const OPENCODE_PLUGIN = '.opencode/plugins/caws.ts';
  const OPENCODE_DOCTRINE = '.opencode/AGENTS.md';
  let repoRoot;
  let claudeBodyAfterFirst;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-multisurf-'));
    // Simulate `caws init --agent-surface claude-code`: shared core + vendor.
    installHookPack(SHARED_PACK, { repoRoot });
    installHookPack(CLAUDE_CODE_PACK, { repoRoot });
    claudeBodyAfterFirst = fs.readFileSync(abs(CLAUDE_REL), 'utf8');
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  function abs(rel) {
    return path.join(repoRoot, rel);
  }

  test('a hand-edited shared hook survives installing a second surface', () => {
    // Grow a shared hook after the claude-code install.
    const grown = fs.readFileSync(abs(SHARED_REL), 'utf8') + '\n# repo-specific growth\n';
    fs.writeFileSync(abs(SHARED_REL), grown);

    // Simulate `caws init --agent-surface opencode` in the same repo.
    const sharedR = installHookPack(SHARED_PACK, { repoRoot });
    const opencodeR = installHookPack(OPENCODE_PACK, { repoRoot });

    // The grown shared hook is preserved as drift — NOT clobbered.
    const sharedAction = sharedR.actions.find((a) => a.destPath === SHARED_REL);
    expect(sharedAction.action).toBe('refused');
    expect(sharedAction.refusalReason).toBe('managed_drift');
    expect(fs.readFileSync(abs(SHARED_REL), 'utf8')).toBe(grown);

    // The opencode vendor files still landed.
    expect(opencodeR.actions.find((a) => a.destPath === OPENCODE_PLUGIN).action).toBe('created');
    expect(opencodeR.actions.find((a) => a.destPath === OPENCODE_DOCTRINE).action).toBe('created');
  });

  test('the first surface vendor files are untouched by the second surface install', () => {
    // Even with no shared-hook edit, installing opencode must not write under .claude/.
    installHookPack(SHARED_PACK, { repoRoot });
    installHookPack(OPENCODE_PACK, { repoRoot });

    // Claude vendor file is byte-identical to right after the claude install.
    expect(fs.readFileSync(abs(CLAUDE_REL), 'utf8')).toBe(claudeBodyAfterFirst);
    // opencode files landed in .opencode/, nothing leaked into .claude/.
    expect(fs.existsSync(abs(OPENCODE_PLUGIN))).toBe(true);
    expect(fs.existsSync(abs(OPENCODE_DOCTRINE))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, '.claude', 'plugins'))).toBe(false);
  });

  test('opencode install refuses to clobber an existing unmanaged .opencode/plugins/caws.ts', () => {
    // A user who already authored their own opencode plugin at this path.
    fs.mkdirSync(path.dirname(abs(OPENCODE_PLUGIN)), { recursive: true });
    fs.writeFileSync(abs(OPENCODE_PLUGIN), '// my own plugin, no managed header\n');

    const opencodeR = installHookPack(OPENCODE_PACK, { repoRoot });
    const a = opencodeR.actions.find((x) => x.destPath === OPENCODE_PLUGIN);
    expect(a.action).toBe('refused');
    expect(a.refusalReason).toBe('unmanaged_collision');
    // The user's file is intact.
    expect(fs.readFileSync(abs(OPENCODE_PLUGIN), 'utf8')).toContain('my own plugin');
  });
});

describe('A6: Codex hooks.json stays parser-valid while reinstall keeps ownership boundaries', () => {
  const CODEX_HOOKS_REL = '.codex/hooks.json';
  let repoRoot;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-codex-hooks-json-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  function abs(rel) {
    return path.join(repoRoot, rel);
  }

  function readHooksJson() {
    return JSON.parse(fs.readFileSync(abs(CODEX_HOOKS_REL), 'utf8'));
  }

  test('fresh Codex install writes only the supported top-level hooks key', () => {
    const r = installHookPack(CODEX_PACK, { repoRoot });
    expect(r.actions.find((a) => a.destPath === CODEX_HOOKS_REL).action).toBe('created');

    const parsed = readHooksJson();
    expect(Object.keys(parsed).sort()).toEqual(['hooks']);
    expect(parseManagedHeader(fs.readFileSync(abs(CODEX_HOOKS_REL), 'utf8'))).toBeNull();
  });

  test('re-init of the current Codex hooks.json is unchanged without hidden metadata', () => {
    installHookPack(CODEX_PACK, { repoRoot });
    const before = fs.readFileSync(abs(CODEX_HOOKS_REL));

    const r = installHookPack(CODEX_PACK, { repoRoot });
    const a = r.actions.find((x) => x.destPath === CODEX_HOOKS_REL);
    expect(a.action).toBe('unchanged');
    expect(fs.readFileSync(abs(CODEX_HOOKS_REL)).equals(before)).toBe(true);
  });

  test('re-init repairs the previous generated metadata-bearing Codex hooks.json shape', () => {
    installHookPack(CODEX_PACK, { repoRoot });
    const parsed = readHooksJson();
    parsed.description =
      'CAWS-MANAGED-HOOK hook_pack=codex hook_pack_version=9 caws_min_major=11 lineage_refs=1,4. edit_stance: previous metadata carrier.';
    fs.writeFileSync(abs(CODEX_HOOKS_REL), JSON.stringify(parsed, null, 2) + '\n');

    const r = installHookPack(CODEX_PACK, { repoRoot });
    const a = r.actions.find((x) => x.destPath === CODEX_HOOKS_REL);
    expect(a.action).toBe('updated');
    expect(Object.keys(readHooksJson()).sort()).toEqual(['hooks']);
  });

  test('arbitrary user-authored hooks.json is still refused as unmanaged', () => {
    fs.mkdirSync(path.dirname(abs(CODEX_HOOKS_REL)), { recursive: true });
    fs.writeFileSync(
      abs(CODEX_HOOKS_REL),
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                hooks: [{ type: 'command', command: 'echo user-hook' }],
              },
            ],
          },
        },
        null,
        2
      ) + '\n'
    );

    const before = fs.readFileSync(abs(CODEX_HOOKS_REL), 'utf8');
    const r = installHookPack(CODEX_PACK, { repoRoot });
    const a = r.actions.find((x) => x.destPath === CODEX_HOOKS_REL);
    expect(a.action).toBe('refused');
    expect(a.refusalReason).toBe('unmanaged_collision');
    expect(fs.readFileSync(abs(CODEX_HOOKS_REL), 'utf8')).toBe(before);
  });
});
