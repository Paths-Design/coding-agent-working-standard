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

const path = require('path');
const { execFileSync } = require('child_process');

const CLI_PKG_DIR = path.resolve(__dirname, '..', '..');

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
    packed = packedFilePaths();
  });

  it('the published tarball contains ZERO files under templates/hook-packs/claude-code/tmp/', () => {
    const strays = packed.filter((p) =>
      /templates\/hook-packs\/claude-code\/tmp\//.test(p)
    );
    // If this fails, a local session-log dir leaked into the package.
    // The guard is packages/caws-cli/.npmignore.
    expect(strays).toEqual([]);
  });

  it('the published tarball still ships the legitimate hook-pack files (guard is surgical)', () => {
    const packFiles = packed.filter((p) =>
      /templates\/hook-packs\/claude-code\//.test(p)
    );
    // Sanity: the .npmignore tmp/ exclusion must not have nuked the pack.
    expect(packFiles.length).toBeGreaterThan(10);
    // Spot-check a couple of load-bearing managed files are present.
    expect(packFiles.some((p) => p.endsWith('/session-log.sh'))).toBe(true);
    expect(packFiles.some((p) => p.endsWith('/lib/parse-input.sh'))).toBe(true);
  });

  it('the hook-pack manifest stateModel declares no tmp/ write path (post-relocation)', () => {
    // Load the compiled manifest the installer actually uses.
    // eslint-disable-next-line global-require
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
