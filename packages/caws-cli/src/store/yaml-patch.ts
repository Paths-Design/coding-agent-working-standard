// YAML raw-source-bytes patcher for top-level scalar fields.
//
// LIFECYCLE-MUTATION-001 invariant: lifecycle mutations must not
// reserialize the YAML document. Parse-then-dump destroys comments,
// trailing whitespace, and field ordering — exactly the v10 destructive
// close failure (failure-lineage Entry 14).
//
// Scope:
//   This patcher handles top-level scalar fields only. It is NOT a
//   general YAML editor. It is a narrow safety mechanism for lifecycle
//   field updates (lifecycle_state, resolution, closure_notes,
//   updated_at, worktree). Nested mutations should not be attempted
//   here.
//
// Semantics:
//   - setTopLevelScalar(source, key, value):
//       - if key exists at top-level (column 0, no leading whitespace):
//         replace its scalar value, preserve surrounding lines, comments,
//         and trailing whitespace.
//       - if key appears more than once at top level: AMBIGUOUS, refuse.
//       - if key appears only nested (with leading whitespace): KEY_NOT_FOUND
//         at top level, refuse — surgical mutation only.
//       - if the existing value spans multiple lines (block scalar, flow
//         mapping/sequence): AMBIGUOUS, refuse.
//
//   - insertTopLevelScalarAfter(source, afterKey, key, value):
//       - same refusal rules for afterKey.
//       - inserts `key: value` on a new line directly after the afterKey
//         line, preserving everything else byte-for-byte.
//       - if `key` already exists at top level: AMBIGUOUS, refuse (use
//         setTopLevelScalar instead).
//
// Quoting:
//   Values are written exactly as provided. Callers MUST pre-quote
//   values that contain special characters (colons, leading dashes,
//   etc.). This patcher does not interpret YAML semantics; it patches
//   bytes.

import { err, ok, type Result } from '@paths.design/caws-kernel';

import { storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';

/** Match a top-level key line. */
function isTopLevelKeyLine(line: string, key: string): boolean {
  // Top-level: no leading whitespace.
  if (line.length === 0) return false;
  if (line[0] === ' ' || line[0] === '\t') return false;
  if (line[0] === '#') return false; // comment, not a key
  // Match `<key>:` exactly (followed by space, end-of-line, or single
  // character — to avoid matching `keyfoo:`).
  const colonIdx = line.indexOf(':');
  if (colonIdx < 0) return false;
  const linkKey = line.slice(0, colonIdx);
  return linkKey === key;
}

/** Return all (line-index, line-end-pos) for top-level occurrences of key. */
function findTopLevelKeyLines(
  lines: readonly string[],
  key: string
): readonly number[] {
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && isTopLevelKeyLine(line, key)) {
      hits.push(i);
    }
  }
  return hits;
}

/** Detect whether the line's value continues onto subsequent lines:
 *  - bare `key:` with nothing after the colon, followed by an indented
 *    block (mapping/sequence/block scalar)
 *  - block scalar markers: `key: |`, `key: >`
 *  - flow mapping/sequence on the same line that does not close on
 *    the same line
 *
 *  Returns true if the value spans multiple lines (refusal case for
 *  surgical scalar replacement). */
function valueSpansMultipleLines(
  lines: readonly string[],
  keyLineIdx: number
): boolean {
  const line = lines[keyLineIdx];
  if (line === undefined) return true;
  const colonIdx = line.indexOf(':');
  if (colonIdx < 0) return true;
  const after = line.slice(colonIdx + 1).trim();

  // Block scalar markers.
  if (after === '|' || after === '>' || after.startsWith('|') || after.startsWith('>')) {
    return true;
  }

  // Bare key (nothing after the colon): the value is on subsequent
  // indented lines.
  if (after === '') {
    // Look at the next non-empty line; if it is indented, this is a
    // nested mapping/sequence and we cannot replace the scalar.
    for (let i = keyLineIdx + 1; i < lines.length; i++) {
      const next = lines[i];
      if (next === undefined) continue;
      if (next.length === 0) continue;
      if (next[0] === ' ' || next[0] === '\t' || next[0] === '-') {
        return true;
      }
      break;
    }
    // Empty value on a top-level key — fine, replaceable.
    return false;
  }

  // Flow mapping/sequence that doesn't close on the same line.
  if (after.startsWith('{') && !after.endsWith('}')) return true;
  if (after.startsWith('[') && !after.endsWith(']')) return true;

  return false;
}

/** Split source into lines preserving the original line-ending pattern
 *  (we re-join with the same delimiter). Handles both LF and CRLF
 *  consistently. Returns the lines and the chosen separator. */
function splitLines(source: string): {
  readonly lines: readonly string[];
  readonly sep: string;
} {
  // Prefer CRLF if any present; else LF.
  const sep = source.includes('\r\n') ? '\r\n' : '\n';
  // Strip a single trailing separator if present; we'll restore it on
  // join so we don't add a phantom empty last element.
  let trimmed = source;
  let trailing = '';
  if (trimmed.endsWith(sep)) {
    trimmed = trimmed.slice(0, -sep.length);
    trailing = sep;
  }
  return { lines: trimmed.split(sep), sep: sep + (trailing ? '' : '') };
  // NOTE: trailing is used by the caller's join via the separator.
  // We return sep without baking trailing into it; the join below
  // restores the trailing newline conditionally.
}

function joinLines(
  lines: readonly string[],
  sep: string,
  originalHadTrailing: boolean
): string {
  const joined = lines.join(sep);
  return originalHadTrailing ? joined + sep : joined;
}

function originalHadTrailing(source: string, sep: string): boolean {
  return source.endsWith(sep);
}

/** Set a top-level scalar key's value. Refuses ambiguous mutations. */
export function setTopLevelScalar(
  source: string,
  key: string,
  value: string
): Result<string> {
  const sep = source.includes('\r\n') ? '\r\n' : '\n';
  const trailing = originalHadTrailing(source, sep);
  const { lines } = splitLines(source);
  const hits = findTopLevelKeyLines(lines, key);

  if (hits.length === 0) {
    return err(
      storeDiagnostic(
        STORE_RULES.YAML_PATCH_KEY_NOT_FOUND,
        `Top-level key "${key}" not found in YAML source.`,
        { subject: key }
      )
    );
  }
  if (hits.length > 1) {
    return err(
      storeDiagnostic(
        STORE_RULES.YAML_PATCH_AMBIGUOUS,
        `Top-level key "${key}" appears ${hits.length} times; refusing ambiguous mutation.`,
        { subject: key, data: { occurrences: hits.length } }
      )
    );
  }

  const keyLineIdx = hits[0];
  if (keyLineIdx === undefined) {
    return err(
      storeDiagnostic(
        STORE_RULES.YAML_PATCH_KEY_NOT_FOUND,
        `Top-level key "${key}" not found in YAML source.`,
        { subject: key }
      )
    );
  }

  if (valueSpansMultipleLines(lines, keyLineIdx)) {
    return err(
      storeDiagnostic(
        STORE_RULES.YAML_PATCH_AMBIGUOUS,
        `Top-level key "${key}" has a multi-line value (block scalar, nested mapping, or unclosed flow); refusing scalar replacement.`,
        { subject: key }
      )
    );
  }

  const originalLine = lines[keyLineIdx];
  if (originalLine === undefined) {
    return err(
      storeDiagnostic(
        STORE_RULES.YAML_PATCH_KEY_NOT_FOUND,
        `Top-level key "${key}" disappeared during patch.`,
        { subject: key }
      )
    );
  }
  // Preserve any inline trailing comment.
  const colonIdx = originalLine.indexOf(':');
  // Find an inline comment (# preceded by whitespace) after the colon.
  let commentStart = -1;
  let inSingle = false;
  let inDouble = false;
  for (let i = colonIdx + 1; i < originalLine.length; i++) {
    const ch = originalLine[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      const prev = originalLine[i - 1];
      if (prev === ' ' || prev === '\t' || prev === undefined) {
        commentStart = i;
        break;
      }
    }
  }
  const trailingComment =
    commentStart >= 0 ? '  ' + originalLine.slice(commentStart) : '';
  const newLine = `${key}: ${value}${trailingComment}`;

  const newLines = lines.slice();
  newLines[keyLineIdx] = newLine;
  return ok(joinLines(newLines, sep, trailing));
}

/** Insert a new top-level scalar key:value line after an existing key.
 *  Refuses ambiguous targets and duplicate-key insertions. */
export function insertTopLevelScalarAfter(
  source: string,
  afterKey: string,
  key: string,
  value: string
): Result<string> {
  const sep = source.includes('\r\n') ? '\r\n' : '\n';
  const trailing = originalHadTrailing(source, sep);
  const { lines } = splitLines(source);

  // Validate `afterKey` exists exactly once at top level.
  const afterHits = findTopLevelKeyLines(lines, afterKey);
  if (afterHits.length === 0) {
    return err(
      storeDiagnostic(
        STORE_RULES.YAML_PATCH_KEY_NOT_FOUND,
        `Top-level anchor key "${afterKey}" not found in YAML source.`,
        { subject: afterKey }
      )
    );
  }
  if (afterHits.length > 1) {
    return err(
      storeDiagnostic(
        STORE_RULES.YAML_PATCH_AMBIGUOUS,
        `Top-level anchor key "${afterKey}" appears ${afterHits.length} times; refusing ambiguous insert.`,
        { subject: afterKey }
      )
    );
  }

  // Refuse if `key` already exists at top level — caller should use
  // setTopLevelScalar instead.
  const keyHits = findTopLevelKeyLines(lines, key);
  if (keyHits.length > 0) {
    return err(
      storeDiagnostic(
        STORE_RULES.YAML_PATCH_AMBIGUOUS,
        `Top-level key "${key}" already exists; use setTopLevelScalar to update it.`,
        { subject: key }
      )
    );
  }

  const afterIdx = afterHits[0];
  if (afterIdx === undefined) {
    return err(
      storeDiagnostic(
        STORE_RULES.YAML_PATCH_KEY_NOT_FOUND,
        `Top-level anchor key "${afterKey}" disappeared during patch.`,
        { subject: afterKey }
      )
    );
  }

  // If afterKey's value spans multiple lines, find the last line of
  // its value block (lines up until the next top-level key or
  // end-of-file) and insert after that.
  let insertIdx = afterIdx + 1;
  if (valueSpansMultipleLines(lines, afterIdx)) {
    for (let i = afterIdx + 1; i < lines.length; i++) {
      const ln = lines[i];
      if (ln === undefined) break;
      // Empty line within a block — keep going.
      if (ln.length === 0) {
        insertIdx = i + 1;
        continue;
      }
      // Another top-level key (or comment line at column 0) ends the
      // block.
      if (ln[0] !== ' ' && ln[0] !== '\t') {
        insertIdx = i;
        break;
      }
      insertIdx = i + 1;
    }
  }

  const newLine = `${key}: ${value}`;
  const newLines = [
    ...lines.slice(0, insertIdx),
    newLine,
    ...lines.slice(insertIdx),
  ];
  return ok(joinLines(newLines, sep, trailing));
}

/** Remove a top-level scalar key's line entirely.
 *
 *  Semantics (per WORKTREE-MERGE-CLEARS-SPEC-BINDING-001 A6):
 *    - if the key does NOT exist at top level: NO-OP, returns the source
 *      unchanged. Backward-compatible with specs that never had the field.
 *    - if the key exists exactly once at top level with a scalar value:
 *      removes the entire line. Trailing inline comments are removed
 *      with the line (they belonged to the field, not to surrounding
 *      context).
 *    - if the key appears more than once at top level: AMBIGUOUS, refuse.
 *    - if the key's value spans multiple lines (block scalar, nested
 *      mapping, unclosed flow): AMBIGUOUS, refuse — surgical scalar
 *      removal only.
 *    - if the key appears only nested (with leading whitespace): NO-OP
 *      at top level (does not match).
 *
 *  Used by closeSpec and destroyWorktree to clear the `worktree:`
 *  binding on terminal lifecycle transitions per the byte-level
 *  invariant: grep '^worktree:' <spec>.yaml must return no match. */
export function removeTopLevelScalar(
  source: string,
  key: string
): Result<string> {
  const sep = source.includes('\r\n') ? '\r\n' : '\n';
  const trailing = originalHadTrailing(source, sep);
  const { lines } = splitLines(source);
  const hits = findTopLevelKeyLines(lines, key);

  // No-op: key not present at top level.
  if (hits.length === 0) {
    return ok(source);
  }

  if (hits.length > 1) {
    return err(
      storeDiagnostic(
        STORE_RULES.YAML_PATCH_AMBIGUOUS,
        `Top-level key "${key}" appears ${hits.length} times; refusing ambiguous removal.`,
        { subject: key, data: { occurrences: hits.length } }
      )
    );
  }

  const keyLineIdx = hits[0];
  if (keyLineIdx === undefined) {
    // Defensive — hits.length === 1 implies hits[0] is defined, but TS
    // narrowing doesn't always catch that.
    return ok(source);
  }

  if (valueSpansMultipleLines(lines, keyLineIdx)) {
    return err(
      storeDiagnostic(
        STORE_RULES.YAML_PATCH_AMBIGUOUS,
        `Top-level key "${key}" has a multi-line value (block scalar, nested mapping, or unclosed flow); refusing scalar removal.`,
        { subject: key }
      )
    );
  }

  const newLines = [
    ...lines.slice(0, keyLineIdx),
    ...lines.slice(keyLineIdx + 1),
  ];
  return ok(joinLines(newLines, sep, trailing));
}
