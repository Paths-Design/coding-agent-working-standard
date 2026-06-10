/**
 * @fileoverview HOOK-PACK-VERSION-FINGERPRINT-001 — template changes must bump
 * the pack version.
 *
 * Failure this guards against: a hook-pack fix lands in the template tree
 * WITHOUT a packVersion bump, so every already-installed consumer (including
 * this repo's own .claude/hooks) keeps running the pre-fix bytes forever —
 * `caws init` sees equal versions and treats the install as current. This is
 * not hypothetical: the DANGER-LATCH-TRIGGER-DISCRIMINATION-001 fix (2026-06-01)
 * sat template-only for 9+ days while both caws and Sterling kept latching on
 * the exact false positives it fixed.
 *
 * Mechanism: a committed fingerprint (sha256 over every template file's path +
 * content) per pack, recorded against the pack version that shipped it, in
 * pack-fingerprints.json. Any template byte change flips the fingerprint and
 * fails this test until the pack version is bumped AND a new history entry is
 * appended. Reviewers then see the version bump next to the content change.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { CLAUDE_CODE_PACK } = require('../../../dist/init/hook-packs/manifest-claude-code');
const { CODEX_PACK } = require('../../../dist/init/hook-packs/manifest-codex');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const TEMPLATES = path.join(REPO_ROOT, 'packages', 'caws-cli', 'templates', 'hook-packs');
const FINGERPRINTS_PATH = path.join(__dirname, 'pack-fingerprints.json');

// Runtime litter that may exist locally but is not pack content (gitignored
// and/or excluded from the npm package by files-field negations).
const EXCLUDED_DIRS = new Set(['tmp', '.caws', '__pycache__', 'node_modules']);
const EXCLUDED_FILES = new Set(['.DS_Store']);

function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), base, out);
    } else if (entry.isFile()) {
      if (EXCLUDED_FILES.has(entry.name)) continue;
      out.push(path.relative(base, path.join(dir, entry.name)));
    }
  }
}

function computeFingerprint(packDir) {
  const files = [];
  walk(packDir, packDir, files);
  files.sort();
  const pairs = files.map((rel) => [
    rel,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(packDir, rel))).digest('hex'),
  ]);
  return {
    fileCount: files.length,
    fingerprint: crypto.createHash('sha256').update(JSON.stringify(pairs)).digest('hex'),
  };
}

const PACKS = [
  { id: 'claude-code', dir: path.join(TEMPLATES, 'claude-code'), manifest: CLAUDE_CODE_PACK },
  { id: 'codex', dir: path.join(TEMPLATES, 'codex'), manifest: CODEX_PACK },
];

const recorded = JSON.parse(fs.readFileSync(FINGERPRINTS_PATH, 'utf8'));

describe.each(PACKS)('pack fingerprint: $id', ({ id, dir, manifest }) => {
  const history = recorded[id] && recorded[id].history;
  const last = history && history[history.length - 1];
  const computed = computeFingerprint(dir);

  it('has a recorded fingerprint history', () => {
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBeGreaterThan(0);
  });

  it('template content matches the recorded fingerprint (bump packVersion on any template change)', () => {
    if (last.fingerprint !== computed.fingerprint) {
      throw new Error(
        `The ${id} template tree changed but pack-fingerprints.json was not updated.\n` +
          `Recorded: ${last.fingerprint} (packVersion ${last.packVersion})\n` +
          `Computed: ${computed.fingerprint} (${computed.fileCount} files)\n` +
          `Fix: bump ${id === 'codex' ? 'CODEX_PACK_VERSION' : 'CLAUDE_CODE_PACK_VERSION'}, ` +
          `bump every managed '# hook_pack_version:' header in the template tree to match, ` +
          `and APPEND {"packVersion": <new>, "fingerprint": "${computed.fingerprint}"} ` +
          `to the ${id} history in pack-fingerprints.json. Never edit an existing entry in place: ` +
          `installed consumers only pick up template changes when the version advances.`
      );
    }
  });

  it('latest recorded packVersion matches the manifest packVersion', () => {
    expect(last.packVersion).toBe(manifest.packVersion);
  });

  it('history versions are strictly increasing with unique fingerprints', () => {
    for (let i = 1; i < history.length; i++) {
      expect(history[i].packVersion).toBeGreaterThan(history[i - 1].packVersion);
    }
    const fps = history.map((h) => h.fingerprint);
    expect(new Set(fps).size).toBe(fps.length);
  });

  it('every managed header in the template tree carries the manifest packVersion', () => {
    const files = [];
    walk(dir, dir, files);
    const stale = [];
    for (const rel of files) {
      const content = fs.readFileSync(path.join(dir, rel), 'utf8');
      const m = content.match(/^# hook_pack_version: (\d+)$/m);
      if (m && Number(m[1]) !== manifest.packVersion) {
        stale.push(`${rel} (header ${m[1]}, manifest ${manifest.packVersion})`);
      }
    }
    expect(stale).toEqual([]);
  });
});
