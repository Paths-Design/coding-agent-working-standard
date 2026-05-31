'use strict';
// scope-match-gate-contract.test.js
//
// Branch-gap coverage for two low-coverage shell modules:
//   - dist/shell/push-range/scope-match (normalizeRel + scopeEntryMatches)
//   - dist/shell/gates/gate-result-contract (validateGatesReport)
//
// CAWS-CLI-COVERAGE-FLOOR-001 (bonus file).
//
// Cases already covered by tests/shell/gates-command.test.js (skipped here
// to avoid duplication):
//   - validateGatesReport: accepts a well-formed pass report
//   - validateGatesReport: rejects non-JSON → report_not_json
//   - validateGatesReport: rejects array payload → report_invalid_shape
//   - validateGatesReport: rejects { timestamp: 'x' } (missing context/etc)
//   - validateGatesReport: rejects violation without gate name

const { normalizeRel, scopeEntryMatches } = require('../../dist/shell/push-range/scope-match');
const { validateGatesReport } = require('../../dist/shell/gates/gate-result-contract');

// ─── normalizeRel ─────────────────────────────────────────────────────────────

describe('normalizeRel — path normalization', () => {
  it('leaves a clean POSIX path unchanged', () => {
    expect(normalizeRel('packages/foo/bar.ts')).toBe('packages/foo/bar.ts');
  });

  it('replaces backslashes with forward slashes', () => {
    expect(normalizeRel('packages\\foo\\bar.ts')).toBe('packages/foo/bar.ts');
  });

  it('strips leading "./"', () => {
    expect(normalizeRel('./packages/foo/bar.ts')).toBe('packages/foo/bar.ts');
  });

  it('strips trailing slash', () => {
    expect(normalizeRel('packages/foo/')).toBe('packages/foo');
  });

  it('handles combined: backslashes + leading ./ + trailing slash', () => {
    expect(normalizeRel('.\\packages\\foo\\')).toBe('packages/foo');
  });

  it('returns empty string for bare "./"', () => {
    expect(normalizeRel('./')).toBe('');
  });

  it('returns empty string for a single slash', () => {
    expect(normalizeRel('/')).toBe('');
  });
});

// ─── scopeEntryMatches ────────────────────────────────────────────────────────

describe('scopeEntryMatches — exact match branch', () => {
  it('returns true when entry equals target exactly', () => {
    expect(scopeEntryMatches('packages/foo/a.ts', 'packages/foo/a.ts')).toBe(true);
  });

  it('returns true after normalization (./entry vs ./target)', () => {
    expect(scopeEntryMatches('./packages/foo', './packages/foo')).toBe(true);
  });
});

describe('scopeEntryMatches — non-glob directory-prefix branch', () => {
  it('returns true when target is a direct child of the entry directory', () => {
    expect(scopeEntryMatches('packages/foo', 'packages/foo/bar.ts')).toBe(true);
  });

  it('returns true when target is a nested descendant', () => {
    expect(scopeEntryMatches('packages/foo', 'packages/foo/sub/dir/file.ts')).toBe(true);
  });

  it('returns false when target starts with entry but lacks the path separator', () => {
    // "packages/foobar" must NOT match scope entry "packages/foo"
    expect(scopeEntryMatches('packages/foo', 'packages/foobar/baz.ts')).toBe(false);
  });

  it('returns false when target is a sibling directory (not a child)', () => {
    expect(scopeEntryMatches('packages/foo', 'packages/bar/x.ts')).toBe(false);
  });

  it('returns false when target is a parent of the entry', () => {
    expect(scopeEntryMatches('packages/foo/sub', 'packages/foo/other.ts')).toBe(false);
  });

  it('returns false for a completely unrelated path', () => {
    expect(scopeEntryMatches('src/alpha', 'tests/beta.test.js')).toBe(false);
  });
});

describe('scopeEntryMatches — glob branch (*)', () => {
  it('* matches any filename in the directory', () => {
    expect(scopeEntryMatches('packages/foo/*', 'packages/foo/bar.ts')).toBe(true);
  });

  it('* matches a file at depth 1 from a known prefix', () => {
    expect(scopeEntryMatches('src/*.ts', 'src/index.ts')).toBe(true);
  });

  it('* maps to .* so it spans path separators (anchored full match)', () => {
    expect(scopeEntryMatches('packages/foo/*', 'packages/foo/sub/deep.ts')).toBe(true);
  });

  it('* glob does NOT match a different directory prefix', () => {
    expect(scopeEntryMatches('packages/foo/*', 'packages/bar/x.ts')).toBe(false);
  });

  it('* at root matches a single-segment file', () => {
    expect(scopeEntryMatches('*.md', 'README.md')).toBe(true);
  });

  it('* at root spans a slash (anchored .* matches the full string)', () => {
    expect(scopeEntryMatches('*.md', 'docs/README.md')).toBe(true);
  });

  it('* glob no-match when pattern and target share no prefix', () => {
    expect(scopeEntryMatches('src/*.ts', 'tests/foo.test.js')).toBe(false);
  });
});

describe('scopeEntryMatches — glob branch (?)', () => {
  it('? matches a single character', () => {
    expect(scopeEntryMatches('src/?.ts', 'src/a.ts')).toBe(true);
  });

  it('? does not match an empty slot (requires exactly one char)', () => {
    expect(scopeEntryMatches('src/?.ts', 'src/.ts')).toBe(false);
  });

  it('? does not match two characters', () => {
    expect(scopeEntryMatches('src/?.ts', 'src/ab.ts')).toBe(false);
  });

  it('mixed * and ? in same entry', () => {
    expect(scopeEntryMatches('src/?oo/*.ts', 'src/foo/bar.ts')).toBe(true);
    expect(scopeEntryMatches('src/?oo/*.ts', 'src/fo/bar.ts')).toBe(false);
  });
});

describe('scopeEntryMatches — regex special-character escaping in non-glob path', () => {
  it('dots in entry are treated as literals, not regex wildcards', () => {
    expect(scopeEntryMatches('src/index.ts', 'src/indexXts')).toBe(false);
  });

  it('entry with parentheses is treated as a literal directory name', () => {
    expect(scopeEntryMatches('src/(utils)', 'src/(utils)/helper.ts')).toBe(true);
    expect(scopeEntryMatches('src/(utils)', 'src/utils/helper.ts')).toBe(false);
  });
});

// ─── validateGatesReport — branch gaps not covered by gates-command.test.js ──

describe('validateGatesReport — required field rejections (branch gaps)', () => {
  it('rejects when files_scoped is missing (has timestamp+context)', () => {
    const r = validateGatesReport(JSON.stringify({
      timestamp: '2026-05-31T00:00:00Z',
      context: 'cli',
    }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe('shell.gates.report_invalid_shape');
    expect(r.errors[0].message).toMatch(/files_scoped/);
  });

  it('rejects when files_scoped is wrong type (string instead of number)', () => {
    const r = validateGatesReport(JSON.stringify({
      timestamp: '2026-05-31T00:00:00Z',
      context: 'cli',
      files_scoped: '3',
    }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe('shell.gates.report_invalid_shape');
  });

  it('rejects when violations is not an array (object)', () => {
    const r = validateGatesReport(JSON.stringify({
      timestamp: '2026-05-31T00:00:00Z',
      context: 'cli',
      files_scoped: 0,
      violations: { gate: 'foo' },
    }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe('shell.gates.report_invalid_shape');
    expect(r.errors[0].message).toMatch(/violations/);
  });

  it('rejects when violations is null', () => {
    const r = validateGatesReport(JSON.stringify({
      timestamp: '2026-05-31T00:00:00Z',
      context: 'cli',
      files_scoped: 0,
      violations: null,
    }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe('shell.gates.report_invalid_shape');
  });

  it('rejects when warnings is not an array (string)', () => {
    const r = validateGatesReport(JSON.stringify({
      timestamp: '2026-05-31T00:00:00Z',
      context: 'cli',
      files_scoped: 0,
      violations: [],
      warnings: 'none',
    }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe('shell.gates.report_invalid_shape');
    expect(r.errors[0].message).toMatch(/warnings/);
  });

  it('rejects when warnings is missing entirely', () => {
    const r = validateGatesReport(JSON.stringify({
      timestamp: '2026-05-31T00:00:00Z',
      context: 'cli',
      files_scoped: 0,
      violations: [],
    }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe('shell.gates.report_invalid_shape');
    expect(r.errors[0].message).toMatch(/warnings/);
  });

  it('rejects when context field is missing (timestamp present)', () => {
    const r = validateGatesReport(JSON.stringify({
      timestamp: '2026-05-31T00:00:00Z',
      files_scoped: 3,
      violations: [],
      warnings: [],
    }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe('shell.gates.report_invalid_shape');
    expect(r.errors[0].message).toMatch(/context/);
  });
});

describe('validateGatesReport — validateViolation branch gaps', () => {
  it('rejects a violations array containing a primitive (string)', () => {
    const r = validateGatesReport(JSON.stringify({
      timestamp: '2026-05-31T00:00:00Z',
      context: 'cli',
      files_scoped: 1,
      violations: ['not-an-object'],
      warnings: [],
    }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe('shell.gates.report_invalid_shape');
    expect(r.errors[0].message).toMatch(/violations\[0\] is not an object/);
  });

  it('rejects a violations array containing null', () => {
    const r = validateGatesReport(JSON.stringify({
      timestamp: '2026-05-31T00:00:00Z',
      context: 'cli',
      files_scoped: 1,
      violations: [null],
      warnings: [],
    }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/violations\[0\] is not an object/);
  });

  it('rejects a violations array containing a number', () => {
    const r = validateGatesReport(JSON.stringify({
      timestamp: '2026-05-31T00:00:00Z',
      context: 'cli',
      files_scoped: 1,
      violations: [42],
      warnings: [],
    }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/violations\[0\] is not an object/);
  });

  it('rejects a violation whose gate field is an empty string', () => {
    const r = validateGatesReport(JSON.stringify({
      timestamp: '2026-05-31T00:00:00Z',
      context: 'cli',
      files_scoped: 1,
      violations: [{ gate: '' }],
      warnings: [],
    }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe('shell.gates.report_invalid_shape');
    expect(r.errors[0].message).toMatch(/missing required string field 'gate'/);
  });

  it('rejects a violation whose gate field is a number (wrong type)', () => {
    const r = validateGatesReport(JSON.stringify({
      timestamp: '2026-05-31T00:00:00Z',
      context: 'cli',
      files_scoped: 1,
      violations: [{ gate: 99 }],
      warnings: [],
    }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/missing required string field 'gate'/);
  });

  it('rejects second violation item when malformed (first is valid)', () => {
    const r = validateGatesReport(JSON.stringify({
      timestamp: '2026-05-31T00:00:00Z',
      context: 'cli',
      files_scoped: 2,
      violations: [
        { gate: 'budget_limit', message: 'first ok' },
        'bad-second-item',
      ],
      warnings: [],
    }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/violations\[1\] is not an object/);
  });

  it('accepts a violation with all optional fields present and well-typed', () => {
    const r = validateGatesReport(JSON.stringify({
      timestamp: '2026-05-31T00:00:00Z',
      context: 'cli',
      files_scoped: 1,
      violations: [{
        gate: 'budget_limit',
        type: 'too_many_files',
        message: 'budget exceeded',
        file: 'src/foo.ts',
        line: 42,
        rule: 'max_files',
        severity: 'error',
      }],
      warnings: [],
    }));
    expect(r.ok).toBe(true);
    const v = r.value.violations[0];
    expect(v.gate).toBe('budget_limit');
    expect(v.type).toBe('too_many_files');
    expect(v.message).toBe('budget exceeded');
    expect(v.file).toBe('src/foo.ts');
    expect(v.line).toBe(42);
    expect(v.rule).toBe('max_files');
    expect(v.severity).toBe('error');
  });
});

describe('validateGatesReport — validateWarning branch gaps', () => {
  it('rejects a warnings array containing a primitive (boolean)', () => {
    const r = validateGatesReport(JSON.stringify({
      timestamp: '2026-05-31T00:00:00Z',
      context: 'cli',
      files_scoped: 0,
      violations: [],
      warnings: [true],
    }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe('shell.gates.report_invalid_shape');
    expect(r.errors[0].message).toMatch(/warnings\[0\] is not an object/);
  });

  it('rejects a warnings array containing null', () => {
    const r = validateGatesReport(JSON.stringify({
      timestamp: '2026-05-31T00:00:00Z',
      context: 'cli',
      files_scoped: 0,
      violations: [],
      warnings: [null],
    }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/warnings\[0\] is not an object/);
  });

  it('accepts an empty warnings array with no violations', () => {
    const r = validateGatesReport(JSON.stringify({
      timestamp: '2026-05-31T00:00:00Z',
      context: 'cli',
      files_scoped: 0,
      violations: [],
      warnings: [],
    }));
    expect(r.ok).toBe(true);
    expect(r.value.warnings).toEqual([]);
    expect(r.value.violations).toEqual([]);
  });

  it('accepts a warning with all optional fields (gate, type, message)', () => {
    const r = validateGatesReport(JSON.stringify({
      timestamp: '2026-05-31T00:00:00Z',
      context: 'cli',
      files_scoped: 1,
      violations: [],
      warnings: [{
        gate: 'scope_boundary',
        type: 'near_limit',
        message: 'approaching file budget',
      }],
    }));
    expect(r.ok).toBe(true);
    const w = r.value.warnings[0];
    expect(w.gate).toBe('scope_boundary');
    expect(w.type).toBe('near_limit');
    expect(w.message).toBe('approaching file budget');
  });

  it('accepts a warning with no fields (all optional)', () => {
    const r = validateGatesReport(JSON.stringify({
      timestamp: '2026-05-31T00:00:00Z',
      context: 'cli',
      files_scoped: 0,
      violations: [],
      warnings: [{}],
    }));
    expect(r.ok).toBe(true);
    expect(r.value.warnings[0]).toEqual({});
  });
});

describe('validateGatesReport — optional fields (waivers + performance)', () => {
  const BASE = {
    timestamp: '2026-05-31T00:00:00Z',
    context: 'cli',
    files_scoped: 2,
    violations: [],
    warnings: [],
  };

  it('accepts waivers field when shaped correctly', () => {
    const r = validateGatesReport(JSON.stringify({ ...BASE, waivers: { active: 2, applied: 1 } }));
    expect(r.ok).toBe(true);
    expect(r.value.waivers).toEqual({ active: 2, applied: 1 });
  });

  it('silently ignores waivers when it is not an object (string)', () => {
    const r = validateGatesReport(JSON.stringify({ ...BASE, waivers: 'bad' }));
    expect(r.ok).toBe(true);
    expect(r.value.waivers).toBeUndefined();
  });

  it('silently ignores waivers when active/applied are not numbers', () => {
    const r = validateGatesReport(JSON.stringify({ ...BASE, waivers: { active: '2', applied: 1 } }));
    expect(r.ok).toBe(true);
    expect(r.value.waivers).toBeUndefined();
  });

  it('silently ignores waivers when applied is missing', () => {
    const r = validateGatesReport(JSON.stringify({ ...BASE, waivers: { active: 1 } }));
    expect(r.ok).toBe(true);
    expect(r.value.waivers).toBeUndefined();
  });

  it('accepts performance when total_execution_time_ms is present and a number', () => {
    const r = validateGatesReport(JSON.stringify({ ...BASE, performance: { total_execution_time_ms: 123 } }));
    expect(r.ok).toBe(true);
    expect(r.value.performance).toEqual({ total_execution_time_ms: 123 });
  });

  it('silently ignores performance when it is not an object', () => {
    const r = validateGatesReport(JSON.stringify({ ...BASE, performance: 999 }));
    expect(r.ok).toBe(true);
    expect(r.value.performance).toBeUndefined();
  });

  it('silently ignores performance when total_execution_time_ms is not a number', () => {
    const r = validateGatesReport(JSON.stringify({ ...BASE, performance: { total_execution_time_ms: '123ms' } }));
    expect(r.ok).toBe(true);
    expect(r.value.performance).toBeUndefined();
  });

  it('accepts performance when total_execution_time_ms is absent (optional sub-field)', () => {
    const r = validateGatesReport(JSON.stringify({ ...BASE, performance: {} }));
    expect(r.ok).toBe(true);
    expect(r.value.performance).toBeUndefined();
  });

  it('result value includes all top-level required fields', () => {
    const r = validateGatesReport(JSON.stringify({
      ...BASE,
      waivers: { active: 0, applied: 0 },
      performance: { total_execution_time_ms: 50 },
    }));
    expect(r.ok).toBe(true);
    expect(r.value.timestamp).toBe('2026-05-31T00:00:00Z');
    expect(r.value.context).toBe('cli');
    expect(r.value.files_scoped).toBe(2);
    expect(r.value.waivers).toEqual({ active: 0, applied: 0 });
    expect(r.value.performance).toEqual({ total_execution_time_ms: 50 });
  });
});
