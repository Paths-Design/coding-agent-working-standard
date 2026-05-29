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

const {
  COMMAND_SURFACE_METADATA,
} = require('../../dist/shell/command-metadata');
const {
  REGISTERED_COMMAND_GROUPS,
} = require('../../src/shell/registered-command-groups');

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

  // ── L1: metadata group set == REGISTERED_COMMAND_GROUPS ─────────────────
  // ENFORCED FROM SLICE 2. Skipped in slice 1 because COMMAND_SURFACE_METADATA
  // is still empty (population is group-by-group in slices 2-3); asserting
  // set-equality with the 13 registered groups now would fail spuriously.
  // When the first group lands in slice 2, flip this from `it.skip` to `it`
  // and assert subset-or-equality as appropriate to the slice.
  it.skip('L1: metadata group names == REGISTERED_COMMAND_GROUPS (slice 2+)', () => {
    const metaGroups = COMMAND_SURFACE_METADATA.filter((e) => e.kind === 'group').map(
      (e) => e.name
    );
    const flatLeaves = COMMAND_SURFACE_METADATA.filter((e) => e.kind === 'leaf').map(
      (e) => e.name
    );
    const allNames = new Set([...metaGroups, ...flatLeaves]);
    const registered = new Set(REGISTERED_COMMAND_GROUPS);
    expect(allNames).toEqual(registered);
  });

  // L3 (allowedValues == kernel enum) and L5 (no inline strings in register.ts)
  // are introduced in slices 2-3 as the first enum-backed options and the first
  // metadata-driven register.ts groups land. They are intentionally not present
  // yet — the skeleton documents the staging rather than asserting unenforced
  // invariants.
});
