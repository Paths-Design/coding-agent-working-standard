'use strict';

// CAWS-REMOVED-COMMAND-DIAGNOSTICS-001 opening commit (evidentiary only).
//
// Parses docs/migration-v10-to-v11.md "Bucket map" markdown tables and
// asserts every v10.2 command/subcommand row is represented in
// docs/v11-surface-matrix.yaml with a consistent disposition bucket.
//
// This is the external-completeness check that the existing
// surface-matrix-completeness.test.js (internal YAML ↔ JS-mirror
// equivalence) does NOT provide. Both must remain green for the matrix
// to be load-bearing.
//
// This file does NOT import legacy-command-map.js or read packages/caws-cli/
// src/index.js. The opening commit for this slice ships ONLY this test;
// the runtime classifier wiring lands in a later commit after scope
// amendment.

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const MIGRATION_DOC = path.join(REPO_ROOT, 'docs', 'migration-v10-to-v11.md');
const MATRIX_YAML = path.join(REPO_ROOT, 'docs', 'v11-surface-matrix.yaml');

// Map markdown section heading → expected matrix disposition.
const SECTION_TO_DISPOSITION = new Map([
  ['Replaced', 'replaced'],
  ['Renamed', 'renamed'],
  ['Removed', 'removed'],
  ['Deferred', 'deferred'],
]);

// Multi-token commands that the migration doc collapses into a single row
// even though the runtime classifier must treat each subcommand individually.
// For coverage purposes, any one of the expanded forms in the matrix
// satisfies the row's coverage assertion.
//
// Example: the doc lists "caws sidecar drift" in a Removed-bucket row, and
// the matrix has both "sidecar" (group catch-all) and "sidecar drift"
// (specific). Either form represents the row.
function commandTokensFromCell(cell) {
  // Strip surrounding whitespace.
  let text = cell.trim();
  // Extract every `caws ...` invocation. The cell may contain multiple
  // alternatives separated by " / " (e.g., "caws validate / caws verify")
  // or "(plural)" annotations. We capture every backtick-quoted command.
  const matches = [];
  const re = /`caws\s+([^`]+?)`/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push(m[1].trim());
  }
  if (matches.length === 0) return [];
  // Normalize each:
  //   - drop trailing arg placeholders like "<id>", "<type>", "<n>"
  //   - drop trailing "[options]" or "[type]" placeholders
  //   - collapse internal whitespace
  const normalized = matches.map((cmd) => {
    return cmd
      .replace(/\s+<[^>]+>/g, '')
      .replace(/\s+\[[^\]]+\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  });
  // Expand slash-shorthand inside a single backtick group:
  //   "templates discover/manage" → ["templates discover", "templates manage"]
  // This only applies when a single command token contains "/". Multi-
  // backtick alternatives ("`caws validate` / `caws verify`") are already
  // captured as separate matches above.
  const expanded = [];
  for (const cmd of normalized) {
    const parts = cmd.split(' ');
    const tail = parts[parts.length - 1];
    if (parts.length >= 2 && tail.includes('/')) {
      const prefix = parts.slice(0, -1).join(' ');
      for (const sub of tail.split('/')) {
        expanded.push(`${prefix} ${sub}`.trim());
      }
    } else {
      expanded.push(cmd);
    }
  }
  return expanded;
}

function parseBucketMap(markdown) {
  // Find the "## Bucket map" section, then walk forward extracting every
  // "### <bucket>" subsection's markdown table.
  const bucketMapIdx = markdown.indexOf('## Bucket map');
  if (bucketMapIdx === -1) {
    throw new Error('Bucket map section not found in migration doc');
  }
  // Slice from Bucket map to the next "## " sibling section.
  const fromBucket = markdown.slice(bucketMapIdx);
  const nextH2 = fromBucket.indexOf('\n## ', 1);
  const section = nextH2 === -1 ? fromBucket : fromBucket.slice(0, nextH2);

  // Match each "### <heading>" subsection.
  const subsections = [];
  const h3re = /\n### ([^\n]+)\n([\s\S]*?)(?=\n### |$)/g;
  let h;
  while ((h = h3re.exec(section)) !== null) {
    const heading = h[1].trim();
    const body = h[2];
    subsections.push({ heading, body });
  }
  if (subsections.length === 0) {
    throw new Error('No ### subsections found under ## Bucket map');
  }

  // For each subsection, extract markdown table rows. Header row + separator
  // are skipped; data rows start at "| `caws ...".
  const rows = [];
  for (const sub of subsections) {
    // Determine disposition from heading prefix (Replaced/Renamed/Removed/Deferred).
    let disposition = null;
    for (const [prefix, disp] of SECTION_TO_DISPOSITION) {
      if (sub.heading.startsWith(prefix)) {
        disposition = disp;
        break;
      }
    }
    if (disposition === null) {
      // Heading is not one of the bucket headings; skip.
      continue;
    }

    // Find table rows: lines starting with "| `caws " until a blank line
    // or non-pipe line.
    const lines = sub.body.split('\n');
    for (const line of lines) {
      if (!line.startsWith('|')) continue;
      // Skip the table header (which has " v10.2 command " or similar) and
      // the separator (which is "|---|"). Real data rows start with
      // "| `caws ...".
      const firstCellMatch = line.match(/^\|\s*([^|]+?)\s*\|/);
      if (!firstCellMatch) continue;
      const firstCell = firstCellMatch[1];
      const commands = commandTokensFromCell(firstCell);
      if (commands.length === 0) continue;
      for (const cmd of commands) {
        rows.push({ command: cmd, disposition, source: sub.heading });
      }
    }
  }

  return rows;
}

function loadMatrix() {
  const raw = fs.readFileSync(MATRIX_YAML, 'utf8');
  const parsed = yaml.load(raw);
  expect(Array.isArray(parsed.v10_2_commands)).toBe(true);
  return parsed;
}

describe('CAWS-REMOVED-COMMAND-DIAGNOSTICS-001 opening: migration-doc Bucket-map coverage', () => {
  let migrationRows;
  let matrix;
  let matrixByCommand;

  beforeAll(() => {
    const md = fs.readFileSync(MIGRATION_DOC, 'utf8');
    migrationRows = parseBucketMap(md);
    matrix = loadMatrix();
    matrixByCommand = new Map(matrix.v10_2_commands.map((e) => [e.command, e]));
  });

  // ── Sanity check: parser actually extracted rows ──────────────────────
  test('parser extracts at least 20 rows from the migration doc Bucket map', () => {
    // The doc currently lists ~4 replaced + 2 renamed + 16 removed +
    // 4 deferred = 26 rows. Setting the floor at 20 gives slack for
    // future doc edits while still failing loud if the parser breaks.
    expect(migrationRows.length).toBeGreaterThanOrEqual(20);
  });

  test('parser extracts at least one row from every bucket', () => {
    const seenDispositions = new Set(migrationRows.map((r) => r.disposition));
    expect(seenDispositions.has('replaced')).toBe(true);
    expect(seenDispositions.has('renamed')).toBe(true);
    expect(seenDispositions.has('removed')).toBe(true);
    expect(seenDispositions.has('deferred')).toBe(true);
  });

  // ── A1: every migration-doc row has a matching matrix entry ──────────
  test('A1: every migration-doc command is represented in the matrix', () => {
    const missing = [];
    for (const row of migrationRows) {
      if (!matrixByCommand.has(row.command)) {
        missing.push(row);
      }
    }
    if (missing.length > 0) {
      const detail = missing
        .map((r) => `  - "${r.command}" (${r.disposition}, from ### ${r.source})`)
        .join('\n');
      throw new Error(
        `${missing.length} migration-doc command(s) missing from docs/v11-surface-matrix.yaml:\n${detail}`
      );
    }
  });

  // ── A1: disposition matches between doc and matrix ───────────────────
  test('A1: every matched command has a consistent disposition between doc and matrix', () => {
    const mismatches = [];
    for (const row of migrationRows) {
      const entry = matrixByCommand.get(row.command);
      if (!entry) continue; // Missing-coverage failures are caught above.
      if (entry.disposition !== row.disposition) {
        mismatches.push({
          command: row.command,
          docDisposition: row.disposition,
          matrixDisposition: entry.disposition,
          docSection: row.source,
        });
      }
    }
    if (mismatches.length > 0) {
      const detail = mismatches
        .map(
          (m) =>
            `  - "${m.command}": doc says ${m.docDisposition} (from ### ${m.docSection}); matrix says ${m.matrixDisposition}`
        )
        .join('\n');
      throw new Error(`${mismatches.length} disposition mismatch(es):\n${detail}`);
    }
  });

  // ── Slice 2 opening invariant: no runtime consumer wired yet ─────────
  test('opening invariant: index.js does not import legacy-command-map yet', () => {
    const indexPath = path.join(REPO_ROOT, 'packages', 'caws-cli', 'src', 'index.js');
    const src = fs.readFileSync(indexPath, 'utf8');
    expect(src).not.toMatch(/legacy-command-map/);
  });

  test('opening invariant: no registered-command-groups.js file exists yet', () => {
    // Slice 2's runtime-wiring commit creates this. The opening commit
    // must not.
    const registryPath = path.join(
      REPO_ROOT,
      'packages',
      'caws-cli',
      'src',
      'shell',
      'registered-command-groups.js'
    );
    expect(fs.existsSync(registryPath)).toBe(false);
  });
});
