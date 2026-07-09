// Minimal line-based unified diff, used by the hook-pack install layer to
// show an operator exactly what `--overwrite --force` would discard before
// they confirm it. No external dependency: the CLI ships no diff library,
// and hook files are small (a few KB), so an O(n·m) LCS is plenty.
//
// Output is the standard unified format (`---` / `+++` headers, `@@` hunks,
// three lines of context) so both humans and agents can read or apply it.

/** Guard rails: past these sizes the DP table stops being "plenty".
 *  Hook templates are orders of magnitude smaller; hitting this means the
 *  file at the managed path is not a hook, and a byte-level diff would not
 *  help anyone port edits anyway. */
const MAX_LINES = 5000;
const MAX_BYTES = 512 * 1024;

const CONTEXT_LINES = 3;

interface DiffOp {
  readonly kind: 'equal' | 'delete' | 'insert';
  /** Line index into `fromLines` (delete/equal) or `toLines` (insert). */
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly line: string;
}

function splitLines(text: string): string[] {
  // A trailing newline should not manufacture a phantom empty line.
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** LCS backtrack into a linear op list. */
function diffOps(fromLines: readonly string[], toLines: readonly string[]): DiffOp[] {
  const n = fromLines.length;
  const m = toLines.length;
  // lcs[i][j] = LCS length of fromLines[i..] vs toLines[j..], flattened.
  const width = m + 1;
  const lcs = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        fromLines[i] === toLines[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (fromLines[i] === toLines[j]) {
      ops.push({ kind: 'equal', fromIndex: i, toIndex: j, line: fromLines[i] ?? '' });
      i++;
      j++;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      ops.push({ kind: 'delete', fromIndex: i, toIndex: j, line: fromLines[i] ?? '' });
      i++;
    } else {
      ops.push({ kind: 'insert', fromIndex: i, toIndex: j, line: toLines[j] ?? '' });
      j++;
    }
  }
  for (; i < n; i++) {
    ops.push({ kind: 'delete', fromIndex: i, toIndex: j, line: fromLines[i] ?? '' });
  }
  for (; j < m; j++) {
    ops.push({ kind: 'insert', fromIndex: i, toIndex: j, line: toLines[j] ?? '' });
  }
  return ops;
}

/**
 * Compute a unified diff of `fromText` → `toText`. Returns '' when the two
 * texts are identical, and a one-line suppression marker (not a diff) when
 * either side exceeds the size guard.
 */
export function unifiedDiff(
  fromLabel: string,
  toLabel: string,
  fromText: string,
  toText: string
): string {
  if (fromText === toText) return '';
  if (fromText.length > MAX_BYTES || toText.length > MAX_BYTES) {
    return `(diff suppressed: content exceeds ${MAX_BYTES} bytes; compare ${fromLabel} to ${toLabel} manually)`;
  }

  const fromLines = splitLines(fromText);
  const toLines = splitLines(toText);
  if (fromLines.length > MAX_LINES || toLines.length > MAX_LINES) {
    return `(diff suppressed: content exceeds ${MAX_LINES} lines; compare ${fromLabel} to ${toLabel} manually)`;
  }

  const ops = diffOps(fromLines, toLines);

  // Group changed ops into hunks, folding in CONTEXT_LINES of surrounding
  // equal lines and merging hunks whose contexts touch.
  interface Hunk {
    start: number; // index into ops
    end: number; // exclusive
  }
  const hunks: Hunk[] = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k]?.kind === 'equal') continue;
    const start = Math.max(0, k - CONTEXT_LINES);
    // Extend through the trailing run of changes plus context.
    let lastChange = k;
    let scan = k + 1;
    while (scan < ops.length) {
      if (ops[scan]?.kind !== 'equal') {
        lastChange = scan;
        scan++;
        continue;
      }
      // Stop if the equal run is longer than a merged context gap.
      if (scan - lastChange > CONTEXT_LINES * 2) break;
      scan++;
    }
    const end = Math.min(ops.length, lastChange + CONTEXT_LINES + 1);
    hunks.push({ start, end });
    k = end - 1;
  }

  const out: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  for (const hunk of hunks) {
    const slice = ops.slice(hunk.start, hunk.end);
    const first = slice[0];
    if (!first) continue;
    const fromStart = first.fromIndex + 1;
    const toStart = first.toIndex + 1;
    const fromCount = slice.filter((o) => o.kind !== 'insert').length;
    const toCount = slice.filter((o) => o.kind !== 'delete').length;
    out.push(`@@ -${fromStart},${fromCount} +${toStart},${toCount} @@`);
    for (const op of slice) {
      const prefix = op.kind === 'equal' ? ' ' : op.kind === 'delete' ? '-' : '+';
      out.push(`${prefix}${op.line}`);
    }
  }
  return out.join('\n');
}
