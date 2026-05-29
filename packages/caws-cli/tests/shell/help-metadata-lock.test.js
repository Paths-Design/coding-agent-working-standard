/**
 * Help-metadata authority lock test (CAWS-CLI-HELP-METADATA-AUTHORITY-001).
 *
 * COMMAND_SURFACE_METADATA (packages/caws-cli/src/shell/command-metadata.ts) is
 * the single source for every `.description()` / `.argument()` / `.option()` in
 * register.ts. This test is the mechanical lock that keeps it honest. The lock
 * grows teeth across the slices:
 *
 *   L1 — metadata group-name set == REGISTERED_COMMAND_GROUPS.
 *        SKIPPED in slice 1 (the metadata array is still empty; an empty set
 *        would fail spuriously). ENFORCED from slice 2, when the first groups
 *        are populated.
 *   L3 — every option with `allowedValues` deep-equals the kernel/schema enum
 *        it mirrors (SPEC_MODES, SPEC_RESOLUTIONS, RISK_TIERS, ...).
 *        Added in slice 2 (first enum-backed options).
 *   L4 — every leaf/group description is a non-empty string (length > 10).
 *        LIVE now; passes trivially over the empty array and tightens as
 *        entries are added.
 *   L5 — register.ts carries no inline `.description('...')` / `.option('...')`
 *        string literals (everything flows through the metadata).
 *        Added per-group in slice 2-3; global in slice 3.
 *
 * Loads the compiled dist (matching the existing register/surface tests), so
 * it runs after `tsc`.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
  COMMAND_SURFACE_METADATA,
} = require('../../dist/shell/command-metadata');
const {
  REGISTERED_COMMAND_GROUPS,
} = require('../../src/shell/registered-command-groups');
const {
  SPEC_MODES,
  SPEC_RESOLUTIONS,
  RISK_TIERS,
} = require('@paths.design/caws-kernel');

/**
 * Map of option flag → the kernel enum it must mirror. Any option carrying
 * `allowedValues` MUST appear here, and its allowedValues MUST deep-equal the
 * named kernel enum. This is the mechanical enum-drift lock (L3): if a flag
 * grows enum-backed values without a kernel-enum binding, or its values drift
 * from the kernel array, the test fails.
 */
const ALLOWED_VALUE_AUTHORITIES = {
  '--mode <mode>': SPEC_MODES,
  '--resolution <r>': SPEC_RESOLUTIONS,
  '--risk-tier <n>': RISK_TIERS,
};

/** Flatten every leaf+group description string in the metadata. */
function allDescriptions(meta) {
  const out = [];
  for (const entry of meta) {
    out.push({ name: entry.name, description: entry.description });
    if (entry.kind === 'group') {
      for (const sub of entry.subcommands) {
        out.push({ name: `${entry.name} ${sub.name}`, description: sub.description });
      }
    }
  }
  return out;
}

describe('help-metadata lock (CAWS-CLI-HELP-METADATA-AUTHORITY-001)', () => {
  it('COMMAND_SURFACE_METADATA is a frozen array', () => {
    expect(Array.isArray(COMMAND_SURFACE_METADATA)).toBe(true);
    expect(Object.isFrozen(COMMAND_SURFACE_METADATA)).toBe(true);
  });

  // ── L4: every description is non-empty prose ────────────────────────────
  // Live from slice 1. Passes trivially while the array is empty; tightens
  // automatically as slices 2-3 add entries.
  it('L4: every metadata description is a non-empty string (>10 chars)', () => {
    for (const { name, description } of allDescriptions(COMMAND_SURFACE_METADATA)) {
      expect(typeof description).toBe('string');
      expect(description.trim().length).toBeGreaterThan(10);
      // Surface which command failed if this trips.
      if (description.trim().length <= 10) {
        throw new Error(`empty/short description for "${name}"`);
      }
    }
  });

  // ── L1: metadata top-level names == REGISTERED_COMMAND_GROUPS ────────────
  // FULL SET-EQUALITY from slice 3. With all 13 surface entries populated (the
  // five flat leaf commands + eight groups), the metadata top-level-name set
  // must EQUAL REGISTERED_COMMAND_GROUPS exactly — a new registered group with
  // no metadata entry (or a metadata entry naming a non-registered command)
  // fails this lock. This was a subset check in slice 2 while groups populated
  // incrementally.
  it('L1: metadata top-level names equal REGISTERED_COMMAND_GROUPS', () => {
    const metaNames = new Set(COMMAND_SURFACE_METADATA.map((e) => e.name));
    const registered = new Set(REGISTERED_COMMAND_GROUPS);
    expect(metaNames).toEqual(registered);
  });

  // ── L3: enum-backed option values deep-equal their kernel enum ───────────
  // LIVE from slice 2. Every option carrying `allowedValues` must mirror a
  // kernel enum exactly (value-for-value, same order). This is the mechanical
  // lock that keeps --mode/--resolution/--risk-tier help in sync with the
  // validation enums — drift becomes a test failure rather than a silent lie.
  it('L3: every option allowedValues deep-equals its kernel enum', () => {
    let enumBackedOptions = 0;
    for (const entry of COMMAND_SURFACE_METADATA) {
      const leaves = entry.kind === 'group' ? entry.subcommands : [entry];
      for (const leaf of leaves) {
        for (const opt of leaf.options) {
          if (opt.allowedValues === undefined) continue;
          enumBackedOptions += 1;
          const authority = ALLOWED_VALUE_AUTHORITIES[opt.flag];
          // Every enum-backed flag must have a declared kernel authority.
          expect(authority).toBeDefined();
          expect(opt.allowedValues).toEqual(authority);
        }
      }
    }
    // Guard: slice 2 introduces --mode, --resolution, --risk-tier — at least
    // three enum-backed options must exist, so this test cannot pass vacuously.
    expect(enumBackedOptions).toBeGreaterThanOrEqual(3);
  });

  // ── L5: register.ts carries no inline help-string literals ──────────────
  // GLOBAL from slice 3. Every `.description(...)`, `.option(...)`, and
  // `.requiredOption(...)` call in register.ts must take its help text from
  // COMMAND_SURFACE_METADATA (via the defineLeaf/defineFlat/applyGroupMeta/
  // applyOptionMeta helpers, which pass `leaf.description` / `opt.flag` /
  // `description` variables) — NOT a bare string literal. A `.description('...')`
  // or `.option('--flag', '...')` with a quoted first/second arg is inline help
  // that bypasses the single-source authority, and fails this lock.
  //
  // The scan reads the register.ts SOURCE (not dist) and flags any
  // .description( / .option( / .requiredOption( immediately followed by a
  // string-literal argument (single, double, or template quote). The helper
  // call sites use identifiers (leaf.description, opt.flag, description), so a
  // clean metadata-driven register.ts has zero matches.
  it('L5: register.ts has no inline .description()/.option() string literals', () => {
    const registerSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'shell', 'register.ts'),
      'utf8'
    );
    // Match `.description(` / `.option(` / `.requiredOption(` where the very
    // next non-whitespace char begins a string literal ( ' " or ` ).
    const inlineHelp = /\.(?:description|option|requiredOption)\(\s*['"`]/g;
    const offenders = [];
    let m;
    while ((m = inlineHelp.exec(registerSrc)) !== null) {
      // Report the line number for a precise failure message.
      const line = registerSrc.slice(0, m.index).split('\n').length;
      offenders.push(`register.ts:${line} — ${m[0].trim()}`);
    }
    if (offenders.length > 0) {
      throw new Error(
        `inline help-string literals must flow through COMMAND_SURFACE_METADATA:\n  ${offenders.join('\n  ')}`
      );
    }
    expect(offenders).toEqual([]);
  });
});
