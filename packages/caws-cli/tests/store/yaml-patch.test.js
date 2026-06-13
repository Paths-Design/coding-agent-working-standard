'use strict';

/**
 * Unit tests for the comment-preserving YAML patcher (A1, lineage E14).
 *
 * CAWS-TEST-CLI-STORE-001. yaml-patch is the byte-level safety mechanism behind
 * lifecycle writes (specs close/activate, worktree merge): it mutates a single
 * top-level scalar WITHOUT reserializing the document, so comments, ordering,
 * and whitespace survive. The v10 destructive close (Entry 14) is exactly what
 * this prevents — so the tests assert PRESERVATION byte-for-byte and the
 * ambiguity refusals, not just "it changed the value".
 *
 * SUT is loaded from dist/ (the compiled surface; Stryker mutates dist/). The
 * worktree dist was built with `turbo run build --filter=@paths.design/caws-cli
 * --force` before this ran.
 */

const {
  setTopLevelScalar,
  insertTopLevelScalarAfter,
  removeTopLevelScalar,
} = require('../../dist/store/yaml-patch');

// Public rule contract (stable strings; values confirmed against dist/store/rules.js).
const AMBIGUOUS = 'store.yaml_patch.ambiguous';
const KEY_NOT_FOUND = 'store.yaml_patch.key_not_found';

/** A representative spec-like doc: comments, ordering, a block scalar, nesting. */
const DOC = `# leading comment
id: SPEC-1
lifecycle_state: active
title: a title  # inline comment on title
scope:
  in:
    - src/x.ts
closure_notes: |
  multi-line
  block scalar
updated_at: '2026-01-01T00:00:00.000Z'
`;

function expectOk(r) {
  expect(r.ok).toBe(true);
  return r.value;
}
function expectErr(r) {
  expect(r.ok).toBe(false);
  return r.errors[0];
}

describe('setTopLevelScalar: replaces the value, preserves everything else', () => {
  test('replaces a top-level scalar and leaves all other bytes intact', () => {
    const out = expectOk(setTopLevelScalar(DOC, 'lifecycle_state', 'closed'));
    expect(out).toContain('lifecycle_state: closed');
    // Preservation: the leading comment, ordering, block scalar, and other keys
    // are byte-for-byte unchanged.
    expect(out).toContain('# leading comment');
    expect(out).toContain('id: SPEC-1');
    expect(out).toContain('closure_notes: |\n  multi-line\n  block scalar');
    // Only the one line changed: diff is exactly the lifecycle_state value.
    expect(out).toBe(DOC.replace('lifecycle_state: active', 'lifecycle_state: closed'));
  });

  test('preserves an inline trailing comment on the patched line', () => {
    const out = expectOk(setTopLevelScalar(DOC, 'title', 'new title'));
    // The "# inline comment on title" must survive the value replacement.
    expect(out).toContain('title: new title  # inline comment on title');
  });

  test('refuses a key that does not exist -> key_not_found', () => {
    expect(expectErr(setTopLevelScalar(DOC, 'nonexistent', 'x')).rule).toBe(KEY_NOT_FOUND);
  });

  test('refuses a key that only appears NESTED (indented), not at top level', () => {
    // `in:` exists but only under scope: (indented) — top-level patch must miss it.
    expect(expectErr(setTopLevelScalar(DOC, 'in', 'y')).rule).toBe(KEY_NOT_FOUND);
  });

  test('refuses a multi-line (block scalar) value -> ambiguous', () => {
    expect(expectErr(setTopLevelScalar(DOC, 'closure_notes', 'x')).rule).toBe(AMBIGUOUS);
  });

  test('refuses a key that appears twice at top level -> ambiguous', () => {
    const dup = 'k: 1\nk: 2\n';
    const e = expectErr(setTopLevelScalar(dup, 'k', '3'));
    expect(e.rule).toBe(AMBIGUOUS);
    expect(e.data.occurrences).toBe(2);
  });

  test('does NOT match a key that is a prefix of another (keyfoo: is not key:)', () => {
    const doc = 'keyfoo: 1\n';
    // Patching "key" must NOT match "keyfoo".
    expect(expectErr(setTopLevelScalar(doc, 'key', '2')).rule).toBe(KEY_NOT_FOUND);
  });

  test('preserves CRLF line endings when the source uses them', () => {
    const crlf = 'a: 1\r\nb: 2\r\n';
    const out = expectOk(setTopLevelScalar(crlf, 'b', '3'));
    expect(out).toBe('a: 1\r\nb: 3\r\n');
    expect(out).toContain('\r\n');
  });

  test('preserves the absence of a trailing newline', () => {
    const noTrailing = 'a: 1\nb: 2'; // no final newline
    const out = expectOk(setTopLevelScalar(noTrailing, 'b', '3'));
    expect(out).toBe('a: 1\nb: 3');
    expect(out.endsWith('\n')).toBe(false);
  });
});

describe('insertTopLevelScalarAfter: inserts a new line after an anchor', () => {
  test('inserts directly after the anchor key, preserving everything else', () => {
    const out = expectOk(insertTopLevelScalarAfter(DOC, 'id', 'resolution', 'completed'));
    expect(out).toBe(DOC.replace('id: SPEC-1\n', 'id: SPEC-1\nresolution: completed\n'));
  });

  test('refuses when the anchor key does not exist -> key_not_found', () => {
    expect(expectErr(insertTopLevelScalarAfter(DOC, 'nope', 'k', 'v')).rule).toBe(KEY_NOT_FOUND);
  });

  test('refuses when the new key already exists at top level -> ambiguous (use set instead)', () => {
    expect(expectErr(insertTopLevelScalarAfter(DOC, 'id', 'lifecycle_state', 'closed')).rule).toBe(
      AMBIGUOUS
    );
  });

  test('inserts AFTER the anchor’s full multi-line value block', () => {
    // closure_notes spans multiple lines; insert lands after the whole block,
    // not in the middle of it.
    const out = expectOk(insertTopLevelScalarAfter(DOC, 'closure_notes', 'extra', 'x'));
    // The block scalar stays intact and `extra:` lands after it (before updated_at).
    expect(out).toContain('  block scalar\nextra: x\nupdated_at:');
  });
});

describe('removeTopLevelScalar: removes a line, no-op when absent', () => {
  test('removes a top-level scalar line entirely', () => {
    const out = expectOk(removeTopLevelScalar(DOC, 'updated_at'));
    expect(out).not.toContain('updated_at:');
    // Everything else preserved.
    expect(out).toContain('id: SPEC-1');
    expect(out).toContain('# leading comment');
  });

  test('is a NO-OP (returns source unchanged) when the key is absent', () => {
    const out = expectOk(removeTopLevelScalar(DOC, 'worktree'));
    expect(out).toBe(DOC); // byte-for-byte unchanged
  });

  test('refuses to remove a multi-line value -> ambiguous', () => {
    expect(expectErr(removeTopLevelScalar(DOC, 'closure_notes')).rule).toBe(AMBIGUOUS);
  });

  test('refuses when the key appears twice -> ambiguous', () => {
    expect(expectErr(removeTopLevelScalar('k: 1\nk: 2\n', 'k')).rule).toBe(AMBIGUOUS);
  });

  test('a nested-only key is a NO-OP at top level (does not match indented)', () => {
    const out = expectOk(removeTopLevelScalar(DOC, 'in'));
    expect(out).toBe(DOC); // `in:` is nested under scope:, untouched
  });
});
