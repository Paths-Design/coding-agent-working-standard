'use strict';

// Single authority for the set of v11 command groups the CLI registers.
//
// CAWS-REMOVED-COMMAND-DIAGNOSTICS-001 (Slice 2). Before this module,
// packages/caws-cli/src/index.js carried a hand-maintained 8-entry
// VALID_COMMANDS array that drifted out of sync with the registered groups
// in packages/caws-cli/src/shell/register.ts (twelve at the time). That
// drift meant unknown-command fuzzy suggestions never fired for events,
// specs, worktree, or agents.
//
// This module is now the one place the group list lives. Consumers:
//   - packages/caws-cli/src/index.js — unknown-command fuzzy suggester.
//   - packages/caws-cli/tests/matrix/surface-matrix-completeness.test.js
//     and tests/shell/removed-command-diagnostics.test.js — assert the
//     mechanical lock that this list equals the matrix's
//     v11_registered_groups and the legacy-command-map mirror's
//     V11_REGISTERED_GROUPS.
//
// Ordering matches the help-banner order emitted by register.ts (the
// .command() call order). Line numbers are intentionally omitted — they
// drift on every register.ts edit and added no checkable value.
//
// NOTE: register.ts is not yet refactored to consume this constant
// (it stays in scope.out for this slice). The mechanical lock is
// currently enforced by test equivalence against the matrix and mirror,
// both of which were hand-verified against register.ts. A future commit
// may make register.ts import this constant directly.

const REGISTERED_COMMAND_GROUPS = Object.freeze([
  'init',
  'doctor',
  'scope',
  'status',
  'claim',
  'gates',
  'evidence',
  'events',
  'waiver',
  'specs',
  'worktree',
  'agents',
  'prepush',
]);

module.exports = {
  REGISTERED_COMMAND_GROUPS,
};
