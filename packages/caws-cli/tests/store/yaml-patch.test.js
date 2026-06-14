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

// ---------------------------------------------------------------------------
// Mutation-hardening (CAWS-TEST-MUTATION-GATE-001): the slice-2 tests asserted
// rule CODES but not the diagnostic MESSAGE/SUBJECT/DATA, and exercised the
// matching helpers only through the public API. These tests pin the message
// content + data payloads + the exact boundary branches so a Stryker mutant
// that blanks a message, drops a data field, or flips a boundary condition is
// KILLED. (Baseline 54% -> target >=80%.)
// ---------------------------------------------------------------------------

describe('yaml-patch: diagnostic message + data payloads are asserted (kills StringLiteral/ObjectLiteral mutants)', () => {
  test('key_not_found message names the key and the subject is the key', () => {
    const e = expectErr(setTopLevelScalar(DOC, 'nope', 'x'));
    expect(e.message).toContain('nope');
    expect(e.message.toLowerCase()).toContain('not found');
    expect(e.subject).toBe('nope');
  });

  test('ambiguous-duplicate message names the count and data.occurrences is set', () => {
    const e = expectErr(setTopLevelScalar('k: 1\nk: 2\nk: 3\n', 'k', '9'));
    expect(e.message).toContain('k');
    expect(e.message).toContain('3'); // "appears 3 times"
    expect(e.data.occurrences).toBe(3);
    expect(e.subject).toBe('k');
  });

  test('multi-line-value ambiguous message mentions the block/flow reason', () => {
    const e = expectErr(setTopLevelScalar(DOC, 'closure_notes', 'x'));
    expect(e.message.toLowerCase()).toMatch(/multi-line|block scalar|nested|flow/);
    expect(e.subject).toBe('closure_notes');
  });

  test('insert: pre-existing-key ambiguous message says to use set instead', () => {
    const e = expectErr(insertTopLevelScalarAfter(DOC, 'id', 'lifecycle_state', 'closed'));
    expect(e.message.toLowerCase()).toContain('already exists');
    expect(e.message).toContain('setTopLevelScalar');
  });

  test('remove: duplicate-key ambiguous carries data.occurrences', () => {
    const e = expectErr(removeTopLevelScalar('k: 1\nk: 2\n', 'k'));
    expect(e.data.occurrences).toBe(2);
  });
});

describe('yaml-patch: matching-boundary branches (kills Conditional/Boolean/Equality mutants)', () => {
  test('a TAB-indented key is nested, not top-level (leading \\t is not column 0)', () => {
    // isTopLevelKeyLine rejects line[0] === ' ' OR '\t'. Pin the tab branch.
    const doc = 'top: 1\n\tnested: 2\n';
    expect(expectErr(setTopLevelScalar(doc, 'nested', 'x')).rule).toBe(KEY_NOT_FOUND);
  });

  test('a comment line beginning with # is not a key even if it contains key:', () => {
    // isTopLevelKeyLine rejects line[0] === '#'.
    const doc = '# fake: not-a-key\nreal: 1\n';
    expect(expectErr(setTopLevelScalar(doc, 'fake', 'x')).rule).toBe(KEY_NOT_FOUND);
    expect(expectOk(setTopLevelScalar(doc, 'real', '2'))).toContain('real: 2');
  });

  test('a line with no colon is not a key', () => {
    expect(expectErr(setTopLevelScalar('noColonHere\nreal: 1\n', 'noColonHere', 'x')).rule).toBe(
      KEY_NOT_FOUND
    );
  });

  test('block scalar marker > (folded) is multi-line ambiguous, like |', () => {
    const doc = 'note: >\n  folded text\nother: 1\n';
    expect(expectErr(setTopLevelScalar(doc, 'note', 'x')).rule).toBe(AMBIGUOUS);
  });

  test('an UNCLOSED flow mapping ({ without }) is multi-line ambiguous', () => {
    const doc = 'm: { a: 1,\n    b: 2 }\nother: 1\n';
    expect(expectErr(setTopLevelScalar(doc, 'm', 'x')).rule).toBe(AMBIGUOUS);
  });

  test('a CLOSED flow mapping on one line IS a replaceable scalar (not ambiguous)', () => {
    const doc = 'm: {a: 1}\nother: 2\n';
    expect(expectOk(setTopLevelScalar(doc, 'm', 'replaced'))).toContain('m: replaced');
  });

  test('an empty top-level value (bare key:) is replaceable', () => {
    const doc = 'empty:\nother: 1\n';
    // bare `empty:` with a NON-indented next line -> replaceable scalar.
    expect(expectOk(setTopLevelScalar(doc, 'empty', 'now-set'))).toContain('empty: now-set');
  });

  test('a bare key: followed by an indented block is a nested mapping -> ambiguous', () => {
    const doc = 'parent:\n  child: 1\nother: 2\n';
    expect(expectErr(setTopLevelScalar(doc, 'parent', 'x')).rule).toBe(AMBIGUOUS);
  });

  test('a bare key: followed by a sequence (- item) is multi-line -> ambiguous', () => {
    const doc = 'list:\n  - a\n  - b\nother: 1\n';
    expect(expectErr(setTopLevelScalar(doc, 'list', 'x')).rule).toBe(AMBIGUOUS);
  });

  test('prefix-key matching is exact: keyfoo: is not key:, key: is not keyfoo:', () => {
    const doc = 'key: 1\nkeyfoo: 2\n';
    expect(expectOk(setTopLevelScalar(doc, 'key', '9'))).toContain('key: 9');
    expect(expectOk(setTopLevelScalar(doc, 'key', '9'))).toContain('keyfoo: 2'); // untouched
  });
});

describe('yaml-patch: inline-comment preservation precision (kills the comment-scan mutants)', () => {
  test('an inline comment with a # inside a quoted value is NOT mistaken for the comment', () => {
    // The comment scanner tracks single/double quote state; a # inside quotes
    // is part of the value, not a comment.
    const doc = `tag: "a#b"  # real comment\n`;
    const out = expectOk(setTopLevelScalar(doc, 'tag', 'new'));
    // The real trailing comment survives; the in-quote # was never a comment.
    expect(out).toContain('tag: new  # real comment');
  });

  test('a value with no comment gets no spurious trailing comment', () => {
    const out = expectOk(setTopLevelScalar('plain: old\n', 'plain', 'new'));
    expect(out).toBe('plain: new\n');
  });
});

// ---------------------------------------------------------------------------
// Mutation-hardening round 2: valueSpansMultipleLines sub-branches + flow
// sequence + the bare-key inner loop + insert-after-block-block + CRLF/trailing
// permutations. Targets the L85-176 survivor cluster.
// ---------------------------------------------------------------------------

describe('yaml-patch: valueSpansMultipleLines block/flow sub-branches', () => {
  test('block scalar with a chomp indicator (|-) is ambiguous (startsWith |, not exact)', () => {
    const doc = 'note: |-\n  text\nother: 1\n';
    expect(expectErr(setTopLevelScalar(doc, 'note', 'x')).rule).toBe(AMBIGUOUS);
  });

  test('folded scalar with an indent indicator (>2) is ambiguous (startsWith >)', () => {
    const doc = 'note: >2\n  text\nother: 1\n';
    expect(expectErr(setTopLevelScalar(doc, 'note', 'x')).rule).toBe(AMBIGUOUS);
  });

  test('an UNCLOSED flow SEQUENCE ([ without ]) is ambiguous', () => {
    const doc = 'arr: [1, 2,\n      3]\nother: 1\n';
    expect(expectErr(setTopLevelScalar(doc, 'arr', 'x')).rule).toBe(AMBIGUOUS);
  });

  test('a CLOSED flow sequence on one line IS a replaceable scalar', () => {
    const doc = 'arr: [1, 2, 3]\nother: 1\n';
    expect(expectOk(setTopLevelScalar(doc, 'arr', 'replaced'))).toContain('arr: replaced');
  });

  test('a normal inline scalar value (not |, >, {, [) is replaceable', () => {
    expect(expectOk(setTopLevelScalar('k: somevalue\n', 'k', 'x'))).toContain('k: x');
  });
});

describe('yaml-patch: bare-key inner-loop branches (blank lines, sequence marker, break)', () => {
  test('bare key whose value block starts after a BLANK line is still nested -> ambiguous', () => {
    // The inner loop skips next.length===0 (blank) lines before judging indent.
    const doc = 'parent:\n\n  child: 1\nother: 2\n';
    expect(expectErr(setTopLevelScalar(doc, 'parent', 'x')).rule).toBe(AMBIGUOUS);
  });

  test('bare key as the LAST line of the doc (no following block) is replaceable', () => {
    // Inner loop finds no indented next line -> returns false (replaceable).
    const doc = 'a: 1\nempty:';
    const out = expectOk(setTopLevelScalar(doc, 'empty', 'now'));
    expect(out).toContain('empty: now');
  });

  test('bare key followed directly by ANOTHER top-level key is replaceable (break on non-indent)', () => {
    const doc = 'empty:\nnext: 1\n';
    expect(expectOk(setTopLevelScalar(doc, 'empty', 'set'))).toContain('empty: set');
  });
});

describe('yaml-patch: insert/remove with CRLF + trailing-newline permutations', () => {
  test('insert preserves CRLF and lands the new line after the anchor', () => {
    const crlf = 'a: 1\r\nb: 2\r\n';
    const out = expectOk(insertTopLevelScalarAfter(crlf, 'a', 'c', '3'));
    expect(out).toBe('a: 1\r\nc: 3\r\nb: 2\r\n');
  });

  test('insert after a multi-line block lands after the WHOLE block', () => {
    const out = expectOk(insertTopLevelScalarAfter(DOC, 'closure_notes', 'newkey', 'v'));
    // newkey must appear after the block scalar, before updated_at.
    const idxBlock = out.indexOf('block scalar');
    const idxNew = out.indexOf('newkey: v');
    const idxUpdated = out.indexOf('updated_at:');
    expect(idxBlock).toBeLessThan(idxNew);
    expect(idxNew).toBeLessThan(idxUpdated);
  });

  test('remove preserves the absence of a trailing newline', () => {
    const noTrailing = 'a: 1\nb: 2'; // no final newline
    const out = expectOk(removeTopLevelScalar(noTrailing, 'a'));
    expect(out).toBe('b: 2');
    expect(out.endsWith('\n')).toBe(false);
  });

  test('remove of the only line yields an empty (or near-empty) doc without crashing', () => {
    const out = expectOk(removeTopLevelScalar('only: 1\n', 'only'));
    expect(out).not.toContain('only:');
  });

  test('insert: anchor that appears twice -> ambiguous (insert refuses)', () => {
    const e = expectErr(insertTopLevelScalarAfter('k: 1\nk: 2\n', 'k', 'new', 'v'));
    expect(e.rule).toBe(AMBIGUOUS);
  });
});

// ---------------------------------------------------------------------------
// Mutation-hardening round 3: the isTopLevelKeyLine guards (empty line,
// space-indent vs tab-indent distinctly) + the bare-key loop's 3-way indent
// test (space / tab / dash) + blank lines inside a doc. Targets the L49-L106
// EqualityOperator/LogicalOperator/BooleanLiteral survivors.
// ---------------------------------------------------------------------------

describe('yaml-patch: isTopLevelKeyLine empty + indent guards (precise)', () => {
  test('a blank line in the doc is never matched as a key; the real key after it is', () => {
    const doc = 'a: 1\n\nb: 2\n'; // blank line between
    expect(expectOk(setTopLevelScalar(doc, 'b', '9'))).toBe('a: 1\n\nb: 9\n');
  });

  test('a SPACE-indented key is nested, not top-level (distinct from the tab case)', () => {
    const doc = 'top: 1\n  spaced: 2\n';
    expect(expectErr(setTopLevelScalar(doc, 'spaced', 'x')).rule).toBe(KEY_NOT_FOUND);
  });

  test('both a space-indented AND a tab-indented sibling are rejected (|| both arms)', () => {
    const doc = 'top: 1\n  spaced: 2\n\ttabbed: 3\n';
    expect(expectErr(setTopLevelScalar(doc, 'spaced', 'x')).rule).toBe(KEY_NOT_FOUND);
    expect(expectErr(setTopLevelScalar(doc, 'tabbed', 'x')).rule).toBe(KEY_NOT_FOUND);
    // ...but the column-0 key IS matched.
    expect(expectOk(setTopLevelScalar(doc, 'top', '9'))).toContain('top: 9');
  });
});

describe('yaml-patch: bare-key value-block 3-way indent detection (space/tab/dash)', () => {
  test('a TAB-indented child block makes the bare key ambiguous', () => {
    const doc = 'parent:\n\tchild: 1\nother: 2\n';
    expect(expectErr(setTopLevelScalar(doc, 'parent', 'x')).rule).toBe(AMBIGUOUS);
  });

  test('a SPACE-indented child block makes the bare key ambiguous', () => {
    const doc = 'parent:\n  child: 1\nother: 2\n';
    expect(expectErr(setTopLevelScalar(doc, 'parent', 'x')).rule).toBe(AMBIGUOUS);
  });

  test('a DASH-prefixed sequence item makes the bare key ambiguous', () => {
    const doc = 'parent:\n- item\nother: 2\n';
    expect(expectErr(setTopLevelScalar(doc, 'parent', 'x')).rule).toBe(AMBIGUOUS);
  });

  test('a bare key followed by a column-0 NON-key text line is replaceable (none of space/tab/dash)', () => {
    // The next line starts at column 0 and is not indented/dash -> break ->
    // replaceable (the bare key has an empty value).
    const doc = 'empty:\nplaintext\n';
    expect(expectOk(setTopLevelScalar(doc, 'empty', 'set'))).toContain('empty: set');
  });
});
