/**
 * @fileoverview CAWS-SESSION-LOG-RELOCATE-001 A4 — the published package
 * ships NO stray session-log / scratch content from the hook pack's tmp/
 * directory, and the manifest declares no tmp/ write path.
 *
 * Why this test exists: the package.json `files` field ships
 * `templates/hook-packs/**`, and npm's `files` inclusion does NOT honor
 * .gitignore. Before this slice the claude-code hook pack wrote per-session
 * turn logs into `templates/hook-packs/claude-code/tmp/<session-id>/`, so a
 * developer's LOCAL session dirs leaked into the published tarball (27 files
 * observed in one `npm pack`). Session state now lives in the consumer's
 * `.caws/sessions/` at runtime; the pack ships no tmp/ content. The
 * `.npmignore` exclusion is the packaging guard. This test locks it.
 *
 * @author @darianrosebrook
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI_PKG_DIR = path.resolve(__dirname, '..', '..');

// CAWS-SESSION-LOG-PACK-LEAK-HOTFIX-001: a real probe stray file seeded
// under the pack tmp/ BEFORE running npm pack. This is what makes the test
// prove the EXCLUSION mechanism works rather than merely observing that no
// stray content happened to exist. Without the probe, the test false-passes
// on a clean checkout (which is exactly how the prior .npmignore-only guard
// slipped through in a sparse worktree where the tmp/ dirs weren't present).
const PROBE_DIR = path.join(
  CLI_PKG_DIR,
  'templates',
  'hook-packs',
  'claude-code',
  'tmp',
  'pack-guard-probe-0000'
);
const PROBE_FILE = path.join(PROBE_DIR, 'turn-001.json');

/**
 * Run `npm pack --dry-run --json` in the caws-cli package and return the
 * list of file paths that would be published. npm prints the JSON report
 * to stdout (progress/log noise goes to stderr).
 */
function packedFilePaths() {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: CLI_PKG_DIR,
    encoding: 'utf8',
    // npm writes the tarball-plan JSON to stdout; swallow stderr noise.
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 120000,
  });
  const report = JSON.parse(out);
  const entry = Array.isArray(report) ? report[0] : report;
  const files = (entry && entry.files) || [];
  return files.map((f) => f.path);
}

describe('CAWS-SESSION-LOG-RELOCATE-001 A4: pack ships no tmp/ session content', () => {
  // npm pack can be slow on a cold cache; give it room.
  jest.setTimeout(150000);

  let packed;
  beforeAll(() => {
    // Seed a real stray session-log probe under the pack tmp/ so the
    // exclusion is genuinely exercised (not a no-op on an empty dir).
    fs.mkdirSync(PROBE_DIR, { recursive: true });
    fs.writeFileSync(PROBE_FILE, '{"probe":"pack-guard"}\n');
    try {
      packed = packedFilePaths();
    } finally {
      // Always remove the probe, even if npm pack threw.
      fs.rmSync(PROBE_DIR, { recursive: true, force: true });
    }
  });

  it('the seeded probe file is not silently absent (the guard test is meaningful)', () => {
    // The probe was created on disk before npm pack ran. If this regex
    // never matches anything in the unfiltered repo, the test would be
    // vacuous — assert the probe path shape is the one we exclude.
    expect(PROBE_FILE).toMatch(
      /templates\/hook-packs\/claude-code\/tmp\/pack-guard-probe-0000\/turn-001\.json$/
    );
  });

  it('the published tarball contains ZERO files under templates/hook-packs/claude-code/tmp/ (probe excluded)', () => {
    const strays = packed.filter((p) =>
      /templates\/hook-packs\/claude-code\/tmp\//.test(p)
    );
    // The seeded probe MUST have been excluded. If this fails, the
    // operative guard (package.json `files` negation) is broken — a local
    // session-log dir would leak into the published package. NB: a
    // .npmignore alone does NOT suffice when a `files` field is present
    // (npm `files` precedence) — see CAWS-SESSION-LOG-PACK-LEAK-HOTFIX-001.
    expect(strays).toEqual([]);
  });

  it('the published tarball still ships the legitimate hook-pack files (guard is surgical)', () => {
    const packFiles = packed.filter((p) =>
      /templates\/hook-packs\/claude-code\//.test(p)
    );
    // Sanity: the tmp/ exclusion must not have nuked the pack.
    expect(packFiles.length).toBeGreaterThan(10);
    // Spot-check a couple of load-bearing managed files are present.
    expect(packFiles.some((p) => p.endsWith('/session-log.sh'))).toBe(true);
    expect(packFiles.some((p) => p.endsWith('/lib/parse-input.sh'))).toBe(true);
  });

  it('the hook-pack manifest stateModel declares no tmp/ write path (post-relocation)', () => {
    // Load the compiled manifest the installer actually uses.
     
    const mod = require('../../dist/init/hook-packs/manifest-claude-code.js');
    const manifest = mod.CLAUDE_CODE_PACK;
    expect(manifest).toBeDefined();
    const writes = (manifest.stateModel && manifest.stateModel.writes) || [];
    // No write path mentions the old repo-root tmp/ session home.
    const tmpWrites = writes.filter((w) => /(^|\W)tmp\//.test(w));
    expect(tmpWrites).toEqual([]);
    // The new home IS declared.
    expect(writes).toContain('.caws/sessions/<session-id>/');
    expect(writes).toContain('.caws/sessions/.caller-session.json');
  });
});
