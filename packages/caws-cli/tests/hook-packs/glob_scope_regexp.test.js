/**
 * @fileoverview HOOK-LIB-CONSOLIDATION-001 T1a / AC A1 — canonical
 * scope-glob matcher acceptance harness.
 *
 * Proves the single shared globToRegExp helper (exported from
 * lib/caws-state.sh as $CAWS_NODE_GLOB_TO_SCOPE_REGEXP) behaves
 * identically regardless of which guard inlines it, and that it
 * implements the CORRECT algorithm (anchored, `**` distinct from `*`,
 * metachars escaped) — not the weaker unanchored `*`->`.*` variant
 * scope-guard used before consolidation.
 *
 * Why this matters: before T1a, scope-guard and worktree-write-guard
 * carried two different glob algorithms and could return OPPOSITE
 * answers for the same (path, pattern) pair — a latent scope
 * false-positive/false-negative split. The fix is one helper both
 * inline. This harness is the fixture table the spec's A1 calls for.
 *
 * Strategy: source the shipped template lib/caws-state.sh, then run
 * the exported JS helper-string through `node -e` exactly as the hooks
 * do, asserting match results across the discriminating cases
 * (segment-crossing, anchoring, dotted literals, ?).
 *
 * The file under test is the shipped template at
 * packages/caws-cli/templates/hook-packs/claude-code/lib/caws-state.sh,
 * NOT the maintainer-local .claude/hooks copy.
 *
 * @author @darianrosebrook
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const LIB = path.join(
  REPO_ROOT,
  'packages',
  'caws-cli',
  'templates',
  'hook-packs',
  'claude-code',
  'lib',
  'caws-state.sh'
);

/**
 * Source caws-state.sh and evaluate globToRegExp(pattern).test(relPath)
 * via node — the exact path both guards use. Returns boolean.
 */
function matches(pattern, relPath) {
  // Source the lib, then inline the EXPORTED helper-string into a
  // double-quoted `node -e "..."` — byte-for-byte how scope-guard and
  // worktree-write-guard consume it. The helper JS arrives via $VAR
  // expansion (bash does not re-parse it), and fixture data is passed
  // via env so it never needs shell-quoting.
  const script = [
    `source "${LIB}"`,
    `node -e "`,
    `  $CAWS_NODE_GLOB_TO_SCOPE_REGEXP`,
    `  var ok = globToRegExp(process.env.PAT).test(process.env.RELP);`,
    `  process.stdout.write(ok ? '1' : '0');`,
    `"`,
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, PAT: pattern, RELP: relPath },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`globToRegExp eval failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim() === '1';
}

describe('HOOK-LIB-CONSOLIDATION-001 T1a — canonical scope-glob matcher', () => {
  // [pattern, path, expectedMatch, note]
  const TABLE = [
    // `*` is single-segment and does NOT cross '/'. This is the case
    // the OLD scope-guard got wrong (its `.*` crossed '/').
    ['python/*', 'python/a.py', true, 'single-segment * matches a leaf'],
    ['python/*', 'python/a/b.py', false, '* must NOT cross "/" (the drift case)'],
    ['*.ts', 'index.ts', true, '*.ts matches a top-level file'],
    ['*.ts', 'a/index.ts', false, '*.ts does NOT match nested (no cross-/)'],

    // `**` is cross-segment.
    ['python/**', 'python/a/b.py', true, '** crosses "/"'],
    ['python/**', 'python/a.py', true, '** also matches a single segment'],
    ['packages/**', 'packages/bar.ts', true, 'scope.out enforcement case'],
    ['src/foo/**', 'packages/bar.ts', false, 'unrelated prefix does not match'],

    // Anchoring: a pattern must match the WHOLE relative path, not be a
    // substring. The OLD scope-guard was unanchored.
    ['src/file.py', 'src/file.py', true, 'exact literal matches'],
    ['src/file.py', 'x/src/file.py', false, 'anchored: no leading substring'],
    ['src/file.py', 'src/file.py.bak', false, 'anchored: no trailing substring'],

    // Dotted literals must be escaped (not "any char").
    ['src/file.py', 'srcXfileYpy', false, '"." is a literal, not regex .'],

    // `?` matches exactly one char.
    ['a/b?.py', 'a/b1.py', true, '? matches one char'],
    ['a/b?.py', 'a/b12.py', false, '? does not match two chars'],
    ['a/b?.py', 'a/b.py', false, '? requires one char present'],
  ];

  for (const [pattern, relPath, expected, note] of TABLE) {
    it(`${note}: ${JSON.stringify(pattern)} vs ${JSON.stringify(relPath)} => ${expected}`, () => {
      expect(matches(pattern, relPath)).toBe(expected);
    });
  }

  it('regression guard: the canonical helper is anchored (rejects substring match)', () => {
    // The defining property that distinguishes the correct algorithm from
    // the retired scope-guard `*`->`.*` unanchored variant.
    expect(matches('packages/**', 'x/packages/bar.ts')).toBe(false);
  });
});
