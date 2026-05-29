/**
 * @fileoverview HOOK-LIB-CONSOLIDATION-001 T1b / AC A2 — canonical
 * dual-shape registry reader acceptance harness.
 *
 * Proves the single shared entriesOf helper (exported from
 * lib/caws-state.sh as $CAWS_NODE_ENTRIES_OF) reads worktrees.json
 * across BOTH registry shapes AND across the status-field variance the
 * CLI produces:
 *
 *   - v10 envelope:  { worktrees: { <name>: {...} } }
 *   - v11 flat-map:  { <name>: {...} }
 *   - CLI-created:   v11 flat-map entries with NO status field
 *                    (caws-cli 11.1.7+ worktree-create persists
 *                     { branch, baseBranch, path, spec_id } only —
 *                     status is synthesized at render time, never
 *                     persisted; see worktrees-writer.ts).
 *
 * The defect this locks: before T1b, entriesOf gated v11 entries on
 * `typeof v.status === 'string'`, so it returned [] for every
 * CLI-created registry — silently disabling active-worktree detection
 * in every consuming hook (worktree-guard, session-caws-status,
 * worktree-write-guard, stop-worktree-check). Same defect class as
 * CAWS-1117-ENTRY-BY-NAME-V11-SHAPE-01 (which fixed entryByName but
 * missed entriesOf). The discriminator now matches entryByName: any
 * object carrying a v11/v10 marker field is an entry.
 *
 * File under test: the shipped template lib/caws-state.sh.
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
 * Source caws-state.sh and run entriesOf over a registry passed as JSON
 * via env. Returns the array of synthesized .name values (sorted) so the
 * assertion is shape-agnostic. Names of [] => empty array.
 */
function entryNames(registryObj) {
  const script = [
    `source "${LIB}"`,
    `node -e "`,
    `  $CAWS_NODE_ENTRIES_OF`,
    `  var e = entriesOf(JSON.parse(process.env.REG));`,
    `  process.stdout.write(JSON.stringify(e.map(function(x){return x.name;}).sort()));`,
    `"`,
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, REG: JSON.stringify(registryObj) },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`entriesOf eval failed: ${r.stderr || r.stdout}`);
  }
  return JSON.parse(r.stdout.trim());
}

describe('HOOK-LIB-CONSOLIDATION-001 T1b — canonical dual-shape entriesOf', () => {
  it('v11 flat-map WITH status admits the entry (legacy/waiver shape)', () => {
    expect(entryNames({ alpha: { status: 'active', baseBranch: 'main' } })).toEqual([
      'alpha',
    ]);
  });

  it('v11 flat-map WITHOUT status admits the entry (CLI-created shape — the bug)', () => {
    // This is the case that returned [] before the fix.
    expect(
      entryNames({
        alpha: { spec_id: 'SPEC-A', branch: 'caws/alpha', baseBranch: 'main', path: '/x' },
      })
    ).toEqual(['alpha']);
  });

  it('synthesizes .name from the flat-map key when entry lacks one', () => {
    expect(entryNames({ beta: { spec_id: 'S', path: '/y' } })).toEqual(['beta']);
  });

  it('preserves an explicit entry.name over the key', () => {
    // entry already carries a name → entriesOf must not clobber it.
    const names = entryNames({ outerkey: { name: 'realname', branch: 'b' } });
    expect(names).toEqual(['realname']);
  });

  it('v10 envelope shape still works', () => {
    expect(
      entryNames({ worktrees: { gamma: { branch: 'g' }, delta: { spec_id: 'D' } } })
    ).toEqual(['delta', 'gamma']);
  });

  it('ignores scalar top-level metadata (e.g. a version sibling)', () => {
    expect(
      entryNames({ version: 11, alpha: { spec_id: 'S' }, beta: { branch: 'b' } })
    ).toEqual(['alpha', 'beta']);
  });

  it('admits destroyed/missing entries (status filtering is the consumer)', () => {
    // entriesOf returns ALL entry-shaped records; hooks filter by status.
    expect(
      entryNames({ a: { status: 'active' }, b: { status: 'destroyed' }, c: { status: 'missing' } })
    ).toEqual(['a', 'b', 'c']);
  });

  it('returns [] for null / empty / metadata-only registries', () => {
    expect(entryNames(null)).toEqual([]);
    expect(entryNames({})).toEqual([]);
    expect(entryNames({ version: 11 })).toEqual([]);
  });

  it('does not treat arrays as entries', () => {
    expect(entryNames({ alpha: ['not', 'an', 'entry'], beta: { branch: 'b' } })).toEqual([
      'beta',
    ]);
  });
});
