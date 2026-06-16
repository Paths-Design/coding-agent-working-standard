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
  'prepush',
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
        'caws worktree prune is planned for v11.2. For the unambiguous half-states (ghost registry entry, dead spec->worktree binding), use caws worktree repair (shipped) — it prunes those safely via the doctor diagnostics. Broader prune/reconcile over ambiguous classes remains planned.',
    },
  }),
  // NOTE: there is intentionally NO 'worktree repair' legacy entry. caws
  // worktree repair SHIPPED (PRUNE-REPAIR-WORKTREE-001) as a registered leaf,
  // so the real command answers `caws worktree repair` — a deferred map entry
  // here would be dead (the leaf shadows it) AND wrong ("planned for v11.2").
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
      message:
        'caws worktree reconcile is planned for v11.2. For the unambiguous half-states, use caws worktree repair (shipped); reconcile over the ambiguous authority-split classes (H2, H3-active, H5) remains planned.',
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

// Index the map by command string for O(1) prefix probing.
const MAP_BY_COMMAND = new Map(LEGACY_COMMAND_MAP.map((e) => [e.command, e]));

/**
 * Classify an argv tail against the legacy command map using LONGEST-PREFIX
 * matching over the full (possibly multi-token) command strings.
 *
 * Pure function. No IO. No execution. No dispatch. Given the argv that
 * Commander could not resolve, it returns the matching LEGACY_COMMAND_MAP
 * entry whose `command` is the longest space-joined prefix of argv, or null
 * if no legacy entry matches.
 *
 * Examples (with LEGACY_COMMAND_MAP holding both "sidecar" and
 * "sidecar gaps"):
 *   classifyLegacyCommand(['sidecar', 'gaps'])  -> the "sidecar gaps" entry
 *   classifyLegacyCommand(['sidecar', 'xyzzy']) -> the "sidecar" entry
 *   classifyLegacyCommand(['sidecar'])          -> the "sidecar" entry
 *   classifyLegacyCommand(['statuz'])           -> null (genuine typo;
 *                                                  caller falls back to the
 *                                                  fuzzy suggester)
 *
 * @param {string[]} argv - command tokens (e.g. process.argv.slice(2)),
 *   options included; options are ignored for matching since legacy command
 *   strings never contain leading-dash tokens.
 * @returns {object|null} a frozen LEGACY_COMMAND_MAP entry, or null.
 */
function classifyLegacyCommand(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return null;
  // Drop option tokens (anything starting with '-') from the candidate
  // prefix; legacy command names are positional words only.
  const words = [];
  for (const tok of argv) {
    if (typeof tok !== 'string') break;
    if (tok.startsWith('-')) break;
    words.push(tok);
  }
  if (words.length === 0) return null;
  // Try the longest prefix first, shrinking by one token until a match.
  for (let n = words.length; n >= 1; n--) {
    const candidate = words.slice(0, n).join(' ');
    const entry = MAP_BY_COMMAND.get(candidate);
    if (entry) return entry;
  }
  return null;
}

/**
 * Build the operator-facing diagnostic lines for a classified legacy
 * command entry. Pure: returns an array of strings, prints nothing.
 *
 * The shape is driven by the entry's runtimeDiagnostic.kind:
 *   - removed   -> "removed in v11" message, no "use" guidance expected
 *   - replaced  -> message + "Use instead:" lines from runtimeDiagnostic.use
 *   - renamed   -> message + "Use instead:" lines
 *   - deferred  -> "deferred" message + optional workaround "use" lines
 *   - shipped   -> message (a deferred-in-doc-but-actually-shipped command;
 *                  rare on the unknown-command path since shipped commands
 *                  resolve in Commander, but handled for completeness)
 *
 * Always appends the doc anchor from sourceDocs[0] as a "See:" line.
 *
 * @param {object} entry - a LEGACY_COMMAND_MAP entry.
 * @returns {string[]} diagnostic lines, in print order.
 */
function formatLegacyDiagnostic(entry) {
  if (!entry || !entry.runtimeDiagnostic) return [];
  const diag = entry.runtimeDiagnostic;
  const lines = [diag.message];
  if (Array.isArray(diag.use) && diag.use.length > 0) {
    lines.push('Use instead:');
    for (const u of diag.use) {
      lines.push(`  ${u}`);
    }
  }
  if (Array.isArray(entry.sourceDocs) && entry.sourceDocs.length > 0) {
    lines.push(`See: ${entry.sourceDocs[0]}`);
  }
  return lines;
}

module.exports = {
  SCHEMA_VERSION,
  V11_REGISTERED_GROUPS,
  LEGACY_COMMAND_MAP,
  classifyLegacyCommand,
  formatLegacyDiagnostic,
};
