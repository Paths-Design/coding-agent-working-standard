/**
 * @fileoverview CAWS-GUARD-STRIKE-FILE-OUT-OF-TREE-001 (A5) — the managed
 * .gitignore block lists `tmp/guard-strikes-*.json` as defense-in-depth so a
 * legacy strike file left in a tracked `tmp/` is never re-committed, and the
 * block version is bumped so a stale block is replaced in place on re-init.
 *
 * @author @darianrosebrook
 */

'use strict';

const {
  EPHEMERAL_CAWS_ENTRIES,
  GITIGNORE_BLOCK_VERSION,
  GITIGNORE_BEGIN_MARKER,
  renderManagedBlock,
  computeGitignore,
} = require('../../dist/init/gitignore-manage');

describe('CAWS-GUARD-STRIKE-FILE-OUT-OF-TREE-001 A5: managed gitignore guard-strikes entry', () => {
  it('EPHEMERAL_CAWS_ENTRIES includes tmp/guard-strikes-*.json', () => {
    expect(EPHEMERAL_CAWS_ENTRIES).toContain('tmp/guard-strikes-*.json');
  });

  it('the rendered managed block contains the guard-strikes ignore line', () => {
    expect(renderManagedBlock()).toContain('tmp/guard-strikes-*.json');
  });

  it('the block version was bumped past v1 (so a stale block is replaced)', () => {
    expect(GITIGNORE_BLOCK_VERSION).toBeGreaterThanOrEqual(2);
    // The begin marker carries the version, which drives in-place replacement.
    expect(GITIGNORE_BEGIN_MARKER).toContain(`v${GITIGNORE_BLOCK_VERSION}`);
  });

  it('a stale v1 managed block is replaced in place, not duplicated', () => {
    // Simulate a repo that was initialized under v1 (no guard-strikes entry).
    const staleBlock = [
      '# >>> caws gitignore (managed, v1) >>>',
      '.caws/worktrees/',
      '# <<< caws gitignore <<<',
    ].join('\n');
    const existing = `node_modules/\n\n${staleBlock}\n`;

    const { content, outcome } = computeGitignore(existing, {});
    expect(outcome).toBe('block_updated');
    // The user's own content is preserved.
    expect(content).toContain('node_modules/');
    // The new block (with the guard-strikes entry) replaces the stale one.
    expect(content).toContain('tmp/guard-strikes-*.json');
    // Exactly one managed block — no duplication.
    const beginCount = (content.match(/# >>> caws gitignore \(managed/g) || [])
      .length;
    expect(beginCount).toBe(1);
  });

  it('AUTHORITY state is still NOT ignored (specs/policy/waivers stay tracked)', () => {
    // Guard against an over-broad ENTRY accidentally matching authority paths.
    // The managed block's comment text legitimately *names* these paths to
    // explain why they are excluded — so we assert on the ENTRIES array (the
    // actual ignore rules), not the comment-bearing rendered block.
    for (const entry of EPHEMERAL_CAWS_ENTRIES) {
      expect(entry).not.toContain('.caws/specs');
      expect(entry).not.toContain('.caws/policy');
      expect(entry).not.toContain('.caws/waivers');
    }
  });
});
