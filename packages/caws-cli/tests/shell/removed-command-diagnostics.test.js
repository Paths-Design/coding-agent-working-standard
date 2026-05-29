'use strict';

// CAWS-REMOVED-COMMAND-DIAGNOSTICS-001 runtime wiring proof.
//
// Exercises the longest-prefix legacy-command classifier and the
// diagnostic formatter directly (pure functions, no build needed), plus
// a structural assertion that packages/caws-cli/src/index.js actually
// wires them into the unknown-command path and removed the stale
// VALID_COMMANDS hand-list.
//
// End-to-end binary behavior (spawn dist/index.js, assert exit 1 + stderr)
// is intentionally NOT asserted here — that is the installed-artifact
// smoke's job (Slice 3, CAWS-V11-INSTALLED-ARTIFACT-SMOKE-EXTEND-001),
// which is the behavioral authority per the campaign's installed-artifact
// pivot. This slice proves the diagnostic LOGIC and the wiring SHAPE.

const fs = require('fs');
const path = require('path');

const {
  LEGACY_COMMAND_MAP,
  classifyLegacyCommand,
  formatLegacyDiagnostic,
} = require('../../src/shell/legacy-command-map');
const {
  REGISTERED_COMMAND_GROUPS,
} = require('../../src/shell/registered-command-groups');

function entryFor(command) {
  return LEGACY_COMMAND_MAP.find((e) => e.command === command);
}

describe('CAWS-REMOVED-COMMAND-DIAGNOSTICS-001: legacy command classifier', () => {
  // ── A5: replaced ──────────────────────────────────────────────────────
  test('replaced: "validate" classifies to the replaced entry with doctor+gates guidance', () => {
    const entry = classifyLegacyCommand(['validate']);
    expect(entry).toBeTruthy();
    expect(entry.command).toBe('validate');
    expect(entry.disposition).toBe('replaced');
    const lines = formatLegacyDiagnostic(entry);
    const text = lines.join('\n');
    expect(text).toMatch(/replaced in v11/i);
    expect(text).toContain('caws doctor');
    expect(text).toContain('caws gates run --spec <id>');
    expect(text).toMatch(/^See: docs\/migration-v10-to-v11\.md/m);
  });

  // ── A5: renamed ──────────────────────────────────────────────────────
  test('renamed: "archive" classifies to the renamed entry with specs-archive guidance', () => {
    const entry = classifyLegacyCommand(['archive', 'SOME-ID']);
    expect(entry).toBeTruthy();
    expect(entry.command).toBe('archive');
    expect(entry.disposition).toBe('renamed');
    const text = formatLegacyDiagnostic(entry).join('\n');
    expect(text).toMatch(/renamed to caws specs archive/i);
    expect(text).toContain('caws specs archive <id>');
  });

  // ── A6: removed (multi-token, longest-prefix) ────────────────────────
  test('removed: "sidecar gaps" classifies to the two-token removed entry, no replacement', () => {
    const entry = classifyLegacyCommand(['sidecar', 'gaps']);
    expect(entry).toBeTruthy();
    expect(entry.command).toBe('sidecar gaps');
    expect(entry.disposition).toBe('removed');
    expect(entry.replacement).toBeNull();
    const lines = formatLegacyDiagnostic(entry);
    const text = lines.join('\n');
    expect(text).toMatch(/removed in v11/i);
    // removed-no-replacement: no "Use instead:" block.
    expect(text).not.toMatch(/Use instead:/);
  });

  // ── A7: deferred ─────────────────────────────────────────────────────
  test('deferred: "session start" classifies to a deferred entry', () => {
    const entry = classifyLegacyCommand(['session', 'start']);
    expect(entry).toBeTruthy();
    expect(entry.command).toBe('session start');
    expect(entry.disposition).toBe('deferred');
    const text = formatLegacyDiagnostic(entry).join('\n');
    expect(text).toMatch(/deferred to v11\.3\+/i);
  });

  test('deferred: "worktree prune" classifies to a deferred entry (planned v11.2)', () => {
    const entry = classifyLegacyCommand(['worktree', 'prune']);
    expect(entry).toBeTruthy();
    expect(entry.command).toBe('worktree prune');
    expect(entry.disposition).toBe('deferred');
    const text = formatLegacyDiagnostic(entry).join('\n');
    expect(text).toMatch(/planned for v11\.2/i);
  });

  // ── prefix: longest-prefix beats shorter prefix ──────────────────────
  test('prefix: "sidecar gaps" selects the two-token entry over the one-token "sidecar"', () => {
    const two = classifyLegacyCommand(['sidecar', 'gaps']);
    const one = classifyLegacyCommand(['sidecar']);
    const unknownSub = classifyLegacyCommand(['sidecar', 'xyzzy']);
    expect(two.command).toBe('sidecar gaps');
    expect(one.command).toBe('sidecar');
    // An unrecognized subcommand falls back to the one-token catch-all.
    expect(unknownSub.command).toBe('sidecar');
  });

  test('prefix: option tokens after the command are ignored when matching', () => {
    const entry = classifyLegacyCommand(['validate', '--spec-id', 'FOO-001']);
    expect(entry).toBeTruthy();
    expect(entry.command).toBe('validate');
  });

  // ── unknown: genuine typo / non-legacy returns null ──────────────────
  test('unknown: a genuine typo ("statuz") is NOT classified as legacy (null)', () => {
    expect(classifyLegacyCommand(['statuz'])).toBeNull();
  });

  test('unknown: a non-legacy invented command ("frobnicate") returns null', () => {
    expect(classifyLegacyCommand(['frobnicate'])).toBeNull();
  });

  test('unknown: empty / non-array argv returns null', () => {
    expect(classifyLegacyCommand([])).toBeNull();
    expect(classifyLegacyCommand(undefined)).toBeNull();
    expect(classifyLegacyCommand(['--help'])).toBeNull();
  });
});

describe('CAWS-REMOVED-COMMAND-DIAGNOSTICS-001: no alias execution / diagnostic-only', () => {
  test('formatLegacyDiagnostic returns strings only — it never executes anything', () => {
    // Every entry's formatter output is a string array. No function, no
    // thunk, no command handle. This is the structural guarantee that the
    // map is a diagnostic surface, not an execution adapter.
    for (const entry of LEGACY_COMMAND_MAP) {
      const lines = formatLegacyDiagnostic(entry);
      expect(Array.isArray(lines)).toBe(true);
      for (const line of lines) {
        expect(typeof line).toBe('string');
      }
    }
  });

  test('LEGACY_COMMAND_MAP entries carry no executable fields', () => {
    // Defensive: assert no entry accidentally grew a function-valued field
    // (e.g. a handler/run/exec), which would turn the map into a dispatch
    // table. Diagnostic map only.
    for (const entry of LEGACY_COMMAND_MAP) {
      for (const [key, value] of Object.entries(entry)) {
        expect(typeof value).not.toBe('function');
        void key;
      }
      for (const [key, value] of Object.entries(entry.runtimeDiagnostic)) {
        expect(typeof value).not.toBe('function');
        void key;
      }
    }
  });
});

describe('CAWS-REMOVED-COMMAND-DIAGNOSTICS-001: single command-group registry', () => {
  // ── A4: registry shape ────────────────────────────────────────────────
  test('REGISTERED_COMMAND_GROUPS is exactly the 13 v11 groups', () => {
    expect([...REGISTERED_COMMAND_GROUPS].sort()).toEqual(
      [
        'agents',
        'claim',
        'doctor',
        'evidence',
        'events',
        'gates',
        'init',
        'prepush',
        'scope',
        'specs',
        'status',
        'waiver',
        'worktree',
      ].sort()
    );
  });

  // ── mechanical lock: registry == matrix mirror's V11_REGISTERED_GROUPS ─
  test('registry equals legacy-command-map V11_REGISTERED_GROUPS', () => {
    const {
      V11_REGISTERED_GROUPS,
    } = require('../../src/shell/legacy-command-map');
    expect([...REGISTERED_COMMAND_GROUPS].sort()).toEqual(
      [...V11_REGISTERED_GROUPS].sort()
    );
  });
});

describe('CAWS-REMOVED-COMMAND-DIAGNOSTICS-001: index.js wiring shape', () => {
  const indexSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'index.js'),
    'utf8'
  );

  // ── A4: stale VALID_COMMANDS hand-list removed ───────────────────────
  test('the stale VALID_COMMANDS hand-list is removed from index.js', () => {
    // No `const VALID_COMMANDS = [` declaration remains.
    expect(indexSrc).not.toMatch(/const\s+VALID_COMMANDS\s*=/);
  });

  test('index.js imports REGISTERED_COMMAND_GROUPS from the single registry', () => {
    expect(indexSrc).toMatch(/registered-command-groups/);
    expect(indexSrc).toMatch(/REGISTERED_COMMAND_GROUPS/);
  });

  test('index.js imports the classifier and formatter from legacy-command-map', () => {
    expect(indexSrc).toMatch(/classifyLegacyCommand/);
    expect(indexSrc).toMatch(/formatLegacyDiagnostic/);
  });

  test('index.js routes unknown commands through the shared reporter', () => {
    // Both unknown-command sites call reportUnknownCommand; no inline
    // VALID_COMMANDS-based handler remains.
    expect(indexSrc).toMatch(/reportUnknownCommand/);
    const reporterCalls = indexSrc.match(/reportUnknownCommand\(/g) || [];
    // One definition + two call sites = at least 3 occurrences.
    expect(reporterCalls.length).toBeGreaterThanOrEqual(3);
  });

  test('index.js fuzzy suggester uses REGISTERED_COMMAND_GROUPS, not VALID_COMMANDS', () => {
    expect(indexSrc).toMatch(/findSimilarCommand\(\s*commandName,\s*REGISTERED_COMMAND_GROUPS\s*\)/);
  });

  test('the classifier runs before the fuzzy suggester in the reporter', () => {
    // Structural: classifyLegacyCommand appears before findSimilarCommand
    // inside reportUnknownCommand, proving legacy diagnostics take
    // precedence over typo suggestions.
    const reporterStart = indexSrc.indexOf('function reportUnknownCommand');
    expect(reporterStart).toBeGreaterThan(-1);
    const reporterBody = indexSrc.slice(reporterStart, reporterStart + 1200);
    const classifyAt = reporterBody.indexOf('classifyLegacyCommand');
    const suggestAt = reporterBody.indexOf('findSimilarCommand');
    expect(classifyAt).toBeGreaterThan(-1);
    expect(suggestAt).toBeGreaterThan(-1);
    expect(classifyAt).toBeLessThan(suggestAt);
  });
});
