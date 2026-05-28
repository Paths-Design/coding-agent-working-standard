'use strict';

// Runtime mirror of docs/v11-surface-matrix.yaml.
//
// This module is the only authority the runtime should consume — the YAML
// at docs/v11-surface-matrix.yaml is human-edited doctrine and is NOT
// bundled in the npm tarball (see packages/caws-cli/package.json `files`).
// The two surfaces are kept semantically equivalent by the test at
// packages/caws-cli/tests/matrix/surface-matrix-completeness.test.js —
// drift in either authority fails the test.
//
// This slice (CAWS-V11-COMMAND-MATRIX-LOCK-001) only exports the map and
// the registered-group list. No runtime consumer imports it yet.
// CAWS-REMOVED-COMMAND-DIAGNOSTICS-001 wires consumption in Slice 2.
//
// Field naming: the JS surface uses camelCase (v11Status, runtimeDiagnostic,
// implementationProbe, sourceDocs). The YAML uses snake_case. The equivalence
// test normalizes both sides before comparing.

const SCHEMA_VERSION = 1;

const V11_REGISTERED_GROUPS = Object.freeze([
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
]);

function entry(o) {
  const probe = Object.freeze({
    group: o.implementationProbe.group ?? null,
    subcommand: o.implementationProbe.subcommand ?? null,
  });
  const diag = {
    kind: o.runtimeDiagnostic.kind,
    message: o.runtimeDiagnostic.message,
  };
  if (Array.isArray(o.runtimeDiagnostic.use)) {
    diag.use = Object.freeze([...o.runtimeDiagnostic.use]);
  }
  return Object.freeze({
    command: o.command,
    disposition: o.disposition,
    v11Status: o.v11Status,
    replacement: o.replacement ?? null,
    since: o.since ?? null,
    sourceDocs: Object.freeze([...o.sourceDocs]),
    implementationProbe: probe,
    runtimeDiagnostic: Object.freeze(diag),
  });
}

const LEGACY_COMMAND_MAP = Object.freeze([
  // ─── Replaced ───
  entry({
    command: 'validate',
    disposition: 'replaced',
    v11Status: 'shipped',
    replacement: 'caws doctor && caws gates run --spec <id>',
    since: '11.0',
    sourceDocs: ['docs/migration-v10-to-v11.md#replaced'],
    implementationProbe: { group: 'doctor' },
    runtimeDiagnostic: {
      kind: 'replaced',
      message: 'caws validate was replaced in v11.',
      use: ['caws doctor', 'caws gates run --spec <id>'],
    },
  }),
  entry({
    command: 'verify',
    disposition: 'replaced',
    v11Status: 'shipped',
    replacement: 'caws doctor && caws gates run --spec <id>',
    since: '11.0',
    sourceDocs: ['docs/migration-v10-to-v11.md#replaced'],
    implementationProbe: { group: 'doctor' },
    runtimeDiagnostic: {
      kind: 'replaced',
      message: 'caws verify was replaced in v11 (alias of validate).',
      use: ['caws doctor', 'caws gates run --spec <id>'],
    },
  }),
  entry({
    command: 'diagnose',
    disposition: 'replaced',
    v11Status: 'shipped',
    replacement: 'caws doctor',
    since: '11.0',
    sourceDocs: ['docs/migration-v10-to-v11.md#replaced'],
    implementationProbe: { group: 'doctor' },
    runtimeDiagnostic: {
      kind: 'replaced',
      message: 'caws diagnose was renamed to caws doctor in v11.',
      use: ['caws doctor'],
    },
  }),
  entry({
    command: 'hooks install',
    disposition: 'replaced',
    v11Status: 'shipped',
    replacement: 'caws init --agent-surface claude-code',
    since: '11.0',
    sourceDocs: ['docs/migration-v10-to-v11.md#replaced'],
    implementationProbe: { group: 'init' },
    runtimeDiagnostic: {
      kind: 'replaced',
      message: 'caws hooks install was folded into caws init in v11.',
      use: ['caws init --agent-surface claude-code'],
    },
  }),
  entry({
    command: 'hooks remove',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#replaced'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message:
        'caws hooks remove was removed in v11. Hook-pack adoption is now an init concern; uninstall by deleting the installed hook files manually.',
    },
  }),
  entry({
    command: 'hooks status',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#replaced'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message: 'caws hooks status was removed in v11. Inspect installed hook files directly.',
    },
  }),
  entry({
    command: 'provenance',
    disposition: 'replaced',
    v11Status: 'shipped',
    replacement: 'caws evidence record',
    since: '11.0',
    sourceDocs: ['docs/migration-v10-to-v11.md#replaced'],
    implementationProbe: { group: 'evidence', subcommand: 'record' },
    runtimeDiagnostic: {
      kind: 'replaced',
      message:
        'caws provenance was replaced in v11 by caws evidence record + the hash-chained .caws/events.jsonl.',
      use: ['caws evidence record --type <test|gate|ac> --spec <id> --data <json>'],
    },
  }),
  entry({
    command: 'provenance update',
    disposition: 'replaced',
    v11Status: 'shipped',
    replacement: 'caws evidence record',
    since: '11.0',
    sourceDocs: ['docs/migration-v10-to-v11.md#replaced'],
    implementationProbe: { group: 'evidence', subcommand: 'record' },
    runtimeDiagnostic: {
      kind: 'replaced',
      message: 'caws provenance update was replaced by caws evidence record.',
      use: ['caws evidence record --type <test|gate|ac> --spec <id> --data <json>'],
    },
  }),
  entry({
    command: 'provenance show',
    disposition: 'replaced',
    v11Status: 'shipped',
    replacement: 'read .caws/events.jsonl',
    since: '11.0',
    sourceDocs: ['docs/migration-v10-to-v11.md#replaced'],
    implementationProbe: { group: 'events' },
    runtimeDiagnostic: {
      kind: 'replaced',
      message:
        'caws provenance show was replaced. Read .caws/events.jsonl directly (it is hash-chained and human-readable).',
    },
  }),
  entry({
    command: 'provenance verify',
    disposition: 'replaced',
    v11Status: 'shipped',
    replacement: 'caws events verify-archive',
    since: '11.0',
    sourceDocs: ['docs/migration-v10-to-v11.md#replaced'],
    implementationProbe: { group: 'events', subcommand: 'verify-archive' },
    runtimeDiagnostic: {
      kind: 'replaced',
      message:
        'caws provenance verify was replaced by caws events verify-archive (verifies rotated archive byte-match + digest).',
      use: ['caws events verify-archive'],
    },
  }),
  entry({
    command: 'provenance analyze-ai',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#replaced'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message: 'caws provenance analyze-ai was removed in v11 with no replacement.',
    },
  }),
  entry({
    command: 'provenance init',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#replaced'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message: 'caws provenance init was folded into caws init in v11.',
    },
  }),
  entry({
    command: 'scaffold',
    disposition: 'replaced',
    v11Status: 'shipped',
    replacement: 'caws init',
    since: '11.0',
    sourceDocs: ['docs/migration-v10-to-v11.md#removed'],
    implementationProbe: { group: 'init' },
    runtimeDiagnostic: {
      kind: 'replaced',
      message: "caws scaffold was folded into caws init's idempotent re-init flow.",
      use: ['caws init'],
    },
  }),

  // ─── Renamed ───
  entry({
    command: 'archive',
    disposition: 'renamed',
    v11Status: 'shipped',
    replacement: 'caws specs archive <id>',
    since: '11.0',
    sourceDocs: ['docs/migration-v10-to-v11.md#renamed'],
    implementationProbe: { group: 'specs', subcommand: 'archive' },
    runtimeDiagnostic: {
      kind: 'renamed',
      message: 'caws archive was renamed to caws specs archive in v11.',
      use: ['caws specs archive <id>'],
    },
  }),
  entry({
    command: 'waivers',
    disposition: 'renamed',
    v11Status: 'shipped',
    replacement: 'caws waiver',
    since: '11.0',
    sourceDocs: ['docs/migration-v10-to-v11.md#renamed'],
    implementationProbe: { group: 'waiver' },
    runtimeDiagnostic: {
      kind: 'renamed',
      message: 'caws waivers (plural) was renamed to caws waiver (singular) in v11.',
      use: ['caws waiver'],
    },
  }),

  // ─── Removed without replacement ───
  entry({
    command: 'sidecar',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#removed-without-replacement'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message:
        'caws sidecar was removed in v11 (all subcommands: drift, gaps, provenance, waiver-draft). Advisory tooling removed; v11.1 prioritizes governed lifecycle over advisory-report parity.',
    },
  }),
  entry({
    command: 'sidecar drift',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#removed-without-replacement'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message:
        'caws sidecar drift was removed in v11. Stay on v10.2 or rebuild externally over .caws/events.jsonl.',
    },
  }),
  entry({
    command: 'sidecar gaps',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#removed-without-replacement'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message:
        'caws sidecar gaps was removed in v11. Trace gate failures manually from caws gates run output.',
    },
  }),
  entry({
    command: 'sidecar provenance',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#removed-without-replacement'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message: 'caws sidecar provenance was removed in v11. Read .caws/events.jsonl directly.',
    },
  }),
  entry({
    command: 'sidecar waiver-draft',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#removed-without-replacement'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message:
        'caws sidecar waiver-draft was removed in v11. Use caws waiver create --help for the flag surface.',
    },
  }),
  entry({
    command: 'burnup',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#removed-without-replacement'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message:
        'caws burnup was removed in v11. Derive budget burn-up from caws status + spec change_budget manually.',
    },
  }),
  entry({
    command: 'verify-acs',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#removed-without-replacement'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message:
        'caws verify-acs was removed in v11. Encode AC-evidence assertions in your test suite directly.',
    },
  }),
  entry({
    command: 'evaluate',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#removed-without-replacement'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message:
        'caws evaluate was removed in v11. caws gates run covers policy gates; quality-evaluation reports are not reproduced.',
    },
  }),
  entry({
    command: 'iterate',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#removed-without-replacement'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message:
        'caws iterate was removed in v11 (advisory-only, no v11 equivalent). Use spec acceptance criteria as guidance.',
    },
  }),
  entry({
    command: 'workflow',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#removed-without-replacement'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message: 'caws workflow was removed in v11. Workflow guidance is documentation-driven now.',
    },
  }),
  entry({
    command: 'quality-monitor',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#removed-without-replacement'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message: 'caws quality-monitor was removed in v11.',
    },
  }),
  entry({
    command: 'test-analysis',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#removed-without-replacement'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message: 'caws test-analysis was removed in v11.',
    },
  }),
  entry({
    command: 'tool',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#removed-without-replacement'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message: 'caws tool was removed in v11 (niche utility).',
    },
  }),
  entry({
    command: 'templates',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#removed-without-replacement'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message:
        'caws templates was removed in v11. Hook-pack install via caws init --agent-surface is now the only template surface.',
    },
  }),
  entry({
    command: 'templates discover',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#removed-without-replacement'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message: 'caws templates discover was removed in v11.',
    },
  }),
  entry({
    command: 'templates manage',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#removed-without-replacement'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message: 'caws templates manage was removed in v11.',
    },
  }),
  entry({
    command: 'mode',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#removed-without-replacement'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message: 'caws mode was removed in v11. Per-feature specs replace complexity-tier management.',
    },
  }),
  entry({
    command: 'tutorial',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#removed-without-replacement'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message: 'caws tutorial was removed in v11 (doc-driven now).',
    },
  }),
  entry({
    command: 'plan',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#removed-without-replacement'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'removed',
      message: 'caws plan was removed in v11.',
    },
  }),

  // ─── Deferred ───
  entry({
    command: 'agents list',
    disposition: 'deferred',
    v11Status: 'shipped',
    replacement: 'caws agents list',
    since: '11.1.x',
    sourceDocs: [
      'docs/migration-v10-to-v11.md#deferred',
      'docs/architecture/caws-vnext-command-surface.md',
    ],
    implementationProbe: { group: 'agents', subcommand: 'list' },
    runtimeDiagnostic: {
      kind: 'shipped',
      message: 'caws agents list shipped ahead of the v11.2 multi-agent line.',
    },
  }),
  entry({
    command: 'agents show',
    disposition: 'deferred',
    v11Status: 'shipped',
    replacement: 'caws agents show <id>',
    since: '11.1.x',
    sourceDocs: [
      'docs/migration-v10-to-v11.md#deferred',
      'docs/architecture/caws-vnext-command-surface.md',
    ],
    implementationProbe: { group: 'agents', subcommand: 'show' },
    runtimeDiagnostic: {
      kind: 'shipped',
      message: 'caws agents show shipped ahead of the v11.2 multi-agent line.',
    },
  }),
  entry({
    command: 'session',
    disposition: 'deferred',
    v11Status: 'planned',
    replacement: null,
    since: null,
    sourceDocs: [
      'docs/migration-v10-to-v11.md#deferred',
      'docs/architecture/caws-vnext-command-surface.md',
    ],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'deferred',
      message:
        'caws session is deferred to v11.3+. Per-worktree binding remains the v11 isolation primitive until then.',
    },
  }),
  entry({
    command: 'session start',
    disposition: 'deferred',
    v11Status: 'planned',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#deferred'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'deferred',
      message: 'caws session start is deferred to v11.3+.',
    },
  }),
  entry({
    command: 'session checkpoint',
    disposition: 'deferred',
    v11Status: 'planned',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#deferred'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'deferred',
      message: 'caws session checkpoint is deferred to v11.3+.',
    },
  }),
  entry({
    command: 'session end',
    disposition: 'deferred',
    v11Status: 'planned',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#deferred'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'deferred',
      message: 'caws session end is deferred to v11.3+.',
    },
  }),
  entry({
    command: 'session list',
    disposition: 'deferred',
    v11Status: 'planned',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#deferred'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'deferred',
      message: 'caws session list is deferred to v11.3+.',
    },
  }),
  entry({
    command: 'parallel',
    disposition: 'deferred',
    v11Status: 'planned',
    replacement: 'loop caws worktree create --spec <id>',
    since: null,
    sourceDocs: [
      'docs/migration-v10-to-v11.md#deferred',
      'docs/architecture/caws-vnext-command-surface.md',
    ],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'deferred',
      message:
        'caws parallel is deferred to v11.3+. Until then, loop caws worktree create per spec.',
      use: ['caws worktree create <name> --spec <id>'],
    },
  }),
  entry({
    command: 'parallel setup',
    disposition: 'deferred',
    v11Status: 'planned',
    replacement: 'loop caws worktree create --spec <id>',
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#deferred'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'deferred',
      message: 'caws parallel setup is deferred to v11.3+. Loop caws worktree create per spec.',
      use: ['caws worktree create <name> --spec <id>'],
    },
  }),
  entry({
    command: 'worktree prune',
    disposition: 'deferred',
    v11Status: 'planned',
    replacement: null,
    since: null,
    sourceDocs: [
      'docs/migration-v10-to-v11.md#deferred',
      'docs/architecture/caws-vnext-command-surface.md',
    ],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'deferred',
      message:
        'caws worktree prune is planned for v11.2. Until then, use caws status to inspect worktree state and clean up via git worktree directly.',
    },
  }),
  entry({
    command: 'worktree repair',
    disposition: 'deferred',
    v11Status: 'planned',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#deferred'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'deferred',
      message:
        'caws worktree repair is planned for v11.2. Distinct from worktree repair-sparse (shipped).',
    },
  }),
  entry({
    command: 'worktree reconcile',
    disposition: 'deferred',
    v11Status: 'planned',
    replacement: null,
    since: null,
    sourceDocs: ['docs/migration-v10-to-v11.md#deferred'],
    implementationProbe: { group: null },
    runtimeDiagnostic: {
      kind: 'deferred',
      message: 'caws worktree reconcile is planned for v11.2.',
    },
  }),

  // ─── History gaps ───
  entry({
    command: 'quality-gates',
    disposition: 'removed',
    v11Status: 'intentionally_absent',
    replacement: 'caws gates run',
    since: null,
    sourceDocs: ['docs/architecture/caws-vnext-command-surface.md'],
    implementationProbe: { group: 'gates', subcommand: 'run' },
    runtimeDiagnostic: {
      kind: 'removed',
      message:
        'caws quality-gates was a pre-v11 alias removed before the v11.0 cutover. Use caws gates run.',
      use: ['caws gates run --spec <id>'],
    },
  }),
  entry({
    command: 'troubleshoot',
    disposition: 'replaced',
    v11Status: 'shipped',
    replacement: 'caws doctor',
    since: null,
    sourceDocs: ['docs/architecture/caws-vnext-command-surface.md'],
    implementationProbe: { group: 'doctor' },
    runtimeDiagnostic: {
      kind: 'replaced',
      message:
        'caws troubleshoot was consolidated into diagnose pre-v11; diagnose itself was renamed to doctor at v11.0.',
      use: ['caws doctor'],
    },
  }),
]);

module.exports = {
  SCHEMA_VERSION,
  V11_REGISTERED_GROUPS,
  LEGACY_COMMAND_MAP,
};
