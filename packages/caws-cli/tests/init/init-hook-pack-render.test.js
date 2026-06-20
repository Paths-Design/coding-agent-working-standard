'use strict';

/**
 * Managed-hook header growth-doctrine guard.
 *
 * CAWS-HOOK-PACK-MANAGED-HEADER-GROWTH-DOCTRINE-001. The shipped hook headers
 * previously carried `# do_not_edit_directly: update via caws init`, which
 * contradicts the maintainer doctrine that hooks are a starting point the repo
 * OWNS and grows. That contradiction trained agents to treat a hook needing a
 * tweak as an upstream CAWS bug instead of editing their own hook. This suite
 * pins three things so the contradiction cannot return:
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

const { parseManagedHeader } = require('../../dist/init/hook-install');
const {
  renderHookPackInstall,
} = require('../../dist/shell/render/init-hook-pack');

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

const ALL_TEMPLATE_FILES = ['shared', 'claude-code', 'codex'].flatMap((pack) =>
  listTemplateFiles(path.join(PACKS_ROOT, pack))
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
    // Both header forms must carry it: the `#`-comment form (shell/py/cjs) uses
    // `# edit_stance:`; the JSON `description`-field form (codex/hooks.json)
    // embeds `edit_stance:` inside the description string. Accept either.
    const missing = MANAGED_FILES.filter(
      (f) => !/edit_stance:/.test(fs.readFileSync(f, 'utf8'))
    ).map((f) => path.relative(PACKS_ROOT, f));
    expect(missing).toEqual([]);
  });

  test('the edit_stance line states the repo owns/may grow the hook and that bypass is the one out-of-bounds edit', () => {
    // Assert the SEMANTICS of one representative header, not just presence —
    // an empty or watered-down edit_stance line must fail.
    const sample = fs.readFileSync(
      path.join(PACKS_ROOT, 'shared', 'scope-guard.sh'),
      'utf8'
    );
    expect(sample).toMatch(/OWNS and may grow this hook/);
    expect(sample).toMatch(/--adopt to keep yours/);
    expect(sample).toMatch(/--overwrite to pull this upstream/);
    expect(sample).toMatch(/do not edit it to BYPASS the guard/i);
  });
});

describe('A2: parseManagedHeader still recognizes a rewritten header as managed', () => {
  test('the live scope-guard.sh header parses to its marker keys', () => {
    const content = fs.readFileSync(
      path.join(PACKS_ROOT, 'shared', 'scope-guard.sh'),
      'utf8'
    );
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
    const out = renderWith([
      { destPath: '.caws/hooks/scope-guard.sh', action: 'created' },
    ]);
    expect(out).toMatch(/Created \(1\)/);
    expect(out).not.toMatch(/Kept your edits/);
    expect(out).not.toMatch(/unmanaged file at a managed path/i);
  });
});
