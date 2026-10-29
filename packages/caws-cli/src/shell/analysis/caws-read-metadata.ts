/** Reviewed CAWS read-command authority: pure data shared by Commander registration
 * and literal prefix inspection. Unlisted routes/options have unknown effects.
 * Normal trusted executable lookup is assumed; a basename is not authentication.
 */
import type { LeafCommandMeta, CommandOptionMeta } from '../command-metadata';
import { parseDurationToSeconds } from '../duration';
export type CawsCommandEffect = 'read' | 'write' | 'execute';
export type CawsOperandRole =
  | 'literal'
  | 'spec-id'
  | 'identifier'
  | 'integer'
  | 'duration'
  | 'event-ref'
  | 'evidence-kind';
export const EVIDENCE_KINDS = ['test', 'gate', 'ac', 'human_decision'] as const;
export const SPECS_LIST_STATUSES = ['active', 'draft', 'closed', 'archived'] as const;
export const TEST_RUNNERS = [
  'pytest',
  'jest',
  'node',
  'bats',
  'vitest',
  'cargo',
  'go',
  'unknown',
] as const;
export type TestRunner = (typeof TEST_RUNNERS)[number];
/** Runners a caller may name as an override; `unknown` is a detection result, not a choice. */
export const SELECTABLE_TEST_RUNNERS: readonly TestRunner[] = TEST_RUNNERS.filter(
  (r) => r !== 'unknown'
);
/**
 * Runners this module can actually run. Selectable is a larger set than
 * executable: naming `--runner cargo` is accepted and reports `unavailable`,
 * because detection is implemented for every runner but execution is not.
 *
 * Exported so the dispatch below and the `--runner` help text derive the split
 * from ONE place. The help previously listed the selectable set with no hint
 * that three of its members verify nothing, and a reader wiring `--runner go`
 * into CI got a gate that reports success while checking nothing — the failure
 * class this repository's release stance names as the most dangerous.
 */
export const EXECUTABLE_TEST_RUNNERS: readonly TestRunner[] = ['pytest', 'jest', 'node', 'bats'];

const DATA_OPTION: CommandOptionMeta = {
  flag: '--data',
  effect: 'read',
  description: 'Show structured data block on diagnostics',
};

export const CAWS_HELP_OPTION: CommandOptionMeta = {
  flag: '-h, --help',
  effect: 'read',
  description: 'display help for command',
};
interface CawsReadCommandMeta extends LeafCommandMeta {
  /** Shape constraints beyond Commander arity; @0 denotes the first positional. */
  readonly requireAny?: readonly string[];
  readonly requires?: Readonly<Record<string, readonly string[]>>;
  readonly exclusive?: readonly (readonly string[])[];
}

export const CAWS_READ_COMMANDS = {
  'working-tree check': {
    kind: 'leaf',
    effect: 'read',
    name: 'check',
    description:
      "Report working-tree overlap with OTHER active sessions, read-only. Consumes the same predicate the PreToolUse guard uses. Exit 0 if no overlap, exit 1 if another session's claimed_paths / last_modified_paths overlap the dirty tree (scriptable precondition). Never mutates the tree or any .caws/ state.",
    options: [
      {
        flag: '--json',
        effect: 'read',
        description: 'Emit the overlap report as machine-readable JSON.',
      },
      DATA_OPTION,
    ],
  },
  'goal show': {
    kind: 'leaf',
    effect: 'read',
    name: 'show',
    description:
      "Report this session's goal binding and the gate's consecutive-block count, read-only. Reports the counter; never edits it. Always exits 0.",
    options: [DATA_OPTION],
  },
  'message inbox': {
    kind: 'leaf',
    effect: 'read',
    name: 'inbox',
    description:
      'List undelivered messages addressed to you without consuming them. Read-only; poll remains the delivery-consuming command.',
    options: [
      {
        flag: '--me <session_id>',
        effect: 'read',
        valueRole: 'identifier',
        description: 'Endpoint inbox to list (default: this session id; ignored with --all)',
      },
      {
        flag: '--limit <n>',
        effect: 'read',
        valueRole: 'integer',
        description: 'Maximum messages to print from the waiting queue',
      },
      {
        flag: '--all',
        effect: 'read',
        description:
          'List every undelivered message in the repo (all recipients), oldest-first, annotated with recipient and age. Read-only (CAWS-MESSAGE-LEDGER-COMPLETENESS-001).',
      },
      {
        flag: '--json',
        effect: 'read',
        description: 'Emit JSON ({ok, read_only, me, waiting, messages})',
      },
      DATA_OPTION,
    ],
  },
  'message history': {
    requireAny: ['--with'],
    kind: 'leaf',
    effect: 'read',
    name: 'history',
    description:
      'Show retained channel history between this session and another endpoint, each message annotated with its delivery state ([queued] vs [delivered]). Read-only; message bodies are communication, not authority.',
    options: [
      {
        flag: '--me <session_id>',
        effect: 'read',
        valueRole: 'identifier',
        description: 'This endpoint (default: this session id)',
      },
      {
        flag: '--with <session_id>',
        effect: 'read',
        valueRole: 'identifier',
        description: 'Other endpoint in the channel (required)',
      },
      {
        flag: '--limit <n>',
        effect: 'read',
        valueRole: 'integer',
        description: 'Maximum recent messages to print, preserving log order',
      },
      {
        flag: '--json',
        effect: 'read',
        description: 'Emit JSON ({ok, read_only, channel, total, messages})',
      },
      DATA_OPTION,
    ],
  },
  'message status': {
    requireAny: ['@0', '--id', '--mine'],
    requires: {
      '--mine': ['--queued'],
      '--queued': ['--mine'],
      '--older-than': ['--mine', '--queued'],
      '--older-than-ms': ['--mine', '--queued'],
    },
    exclusive: [
      ['@0', '--id', '--mine'],
      ['--older-than', '--older-than-ms'],
    ],
    kind: 'leaf',
    effect: 'read',
    name: 'status',
    description:
      'Observe one message\'s delivery state (queued vs delivered, with timestamps) — lets a sender distinguish "queued" from "seen" without polling the recipient. Read-only.',
    argument: {
      valueRole: 'identifier',
      name: 'message_id',
      required: false,
      description: 'Id of the message to observe (primary positional form; --id is the alias)',
    },
    options: [
      {
        flag: '--id <message_id>',
        effect: 'read',
        valueRole: 'identifier',
        description: 'Id of the message to observe (alias for the positional)',
      },
      {
        flag: '--mine',
        effect: 'read',
        description:
          'Dead-letter view: list YOUR sent messages that are still undelivered instead of observing one id (CAWS-MESSAGE-BEHAVIOR-001).',
      },
      {
        flag: '--queued',
        effect: 'read',
        description:
          'With --mine: restrict to still-undelivered sends (required pairing for the dead-letter view).',
      },
      {
        flag: '--older-than <duration>',
        effect: 'read',
        valueRole: 'duration',
        description:
          'With --mine --queued: only list sends queued at least this long, e.g. 30m, 2h (default 1h; units: s, m, h/hr, d; combine as 1h30m). Mutually exclusive with --older-than-ms.',
      },
      {
        flag: '--older-than-ms <ms>',
        effect: 'read',
        valueRole: 'integer',
        description:
          'With --mine --queued: the same window in milliseconds (default 3600000 = 1h). Prefer --older-than.',
      },
      {
        flag: '--json',
        effect: 'read',
        description: 'Emit JSON ({ok, read_only, message, delivered, delivered_at?})',
      },
      DATA_OPTION,
    ],
  },
  'reprieve show': {
    exclusive: [['--current', '--session']],
    kind: 'leaf',
    effect: 'read',
    name: 'show',
    description:
      'Show the reprieve for the current (or named) session, if any, including its derived active/expired state.',
    options: [
      { flag: '--current', effect: 'read', description: 'Resolve the session from env (default)' },
      {
        flag: '--session <id>',
        effect: 'read',
        valueRole: 'identifier',
        description: 'Explicit session id (overrides --current)',
      },
      {
        flag: '--surface <name>',
        effect: 'read',
        valueRole: 'literal',
        description:
          'Harness provenance and legacy lookup context (default: detect); new grants use the machine session store',
      },
      { flag: '--json', effect: 'read', description: 'Emit the record as JSON.' },
      DATA_OPTION,
    ],
  },
  'reprieve list': {
    kind: 'leaf',
    effect: 'read',
    name: 'list',
    description:
      "List active guard reprieves across sessions, with each one's handlers, expiry, and derived active/expired state.",
    options: [
      {
        flag: '--surface <name>',
        effect: 'read',
        valueRole: 'literal',
        description:
          'Harness provenance and legacy lookup context (default: detect); new grants use the machine session store',
      },
      { flag: '--json', effect: 'read', description: 'Emit the list as JSON.' },
      DATA_OPTION,
    ],
  },
  'agents list': {
    exclusive: [['--stale-ttl', '--stale-ttl-ms']],
    kind: 'leaf',
    effect: 'read',
    name: 'list',
    description: 'List active / stale / stopped agents. Read-only.',
    options: [
      {
        flag: '--include-stale',
        effect: 'read',
        description: 'Include stale (active-but-TTL-expired) records',
      },
      { flag: '--include-stopped', effect: 'read', description: 'Include stopped records' },
      {
        flag: '--active',
        effect: 'read',
        description:
          'Active-only (overrides --include-* flags); TTL-classified active, not raw status field',
      },
      {
        flag: '--stale-ttl <duration>',
        effect: 'read',
        valueRole: 'duration',
        description:
          'TTL for stale classification as a duration, e.g. 30m, 2h (default: 30m; units: s, m, h/hr, d; combine as 1h30m). Mutually exclusive with --stale-ttl-ms.',
      },
      {
        flag: '--stale-ttl-ms <ms>',
        effect: 'read',
        valueRole: 'integer',
        description:
          'TTL for stale classification in milliseconds (default: 1800000 = 30m). Prefer --stale-ttl.',
      },
      { flag: '--json', effect: 'read', description: 'Emit CAWS-native JSON to stdout' },
      DATA_OPTION,
    ],
  },
  'agents show': {
    exclusive: [['--stale-ttl', '--stale-ttl-ms']],
    kind: 'leaf',
    effect: 'read',
    name: 'show',
    argument: {
      valueRole: 'identifier',
      name: 'id',
      required: true,
      description: 'Session id of the lease to show',
    },
    description:
      'Show one lease by session id, with its derived TTL liveness classification. Read-only.',
    options: [
      {
        flag: '--stale-ttl <duration>',
        effect: 'read',
        valueRole: 'duration',
        description:
          'TTL for the derived liveness classification as a duration, e.g. 30m, 2h (default: 30m; units: s, m, h/hr, d; combine as 1h30m); the persisted status is unaffected. Mutually exclusive with --stale-ttl-ms.',
      },
      {
        flag: '--stale-ttl-ms <ms>',
        effect: 'read',
        valueRole: 'integer',
        description:
          'TTL for the derived liveness classification in milliseconds (default: 1800000 = 30m); the persisted status is unaffected. Prefer --stale-ttl.',
      },
      { flag: '--json', effect: 'read', description: 'Emit CAWS-native JSON to stdout' },
      DATA_OPTION,
    ],
  },
  'events list': {
    kind: 'leaf',
    effect: 'read',
    name: 'list',
    description:
      'Summarize the current hash-chained events log. Read-only; verifies the chain, reports counts, latest event, recent events, and chain_rotated archive status.',
    options: [
      {
        flag: '--json',
        effect: 'read',
        description: 'Emit chain summary, rotations, and recent events as JSON.',
      },
      {
        flag: '--limit <n>',
        effect: 'read',
        valueRole: 'integer',
        description: 'Number of recent events to include (default: 20; use 0 for summary only)',
      },
      DATA_OPTION,
    ],
  },
  'events show': {
    kind: 'leaf',
    effect: 'read',
    name: 'show',
    argument: {
      valueRole: 'event-ref',
      name: 'event-ref',
      required: true,
      description:
        'Event sequence number, full event hash, unique event-hash prefix, or latest-rotation.',
    },
    description:
      'Show one event after verifying the current hash chain. The special ref latest-rotation shows the newest chain_rotated event with archive presence/digest/line-count status.',
    options: [
      {
        flag: '--json',
        effect: 'read',
        description: 'Emit the matched event and rotation status as JSON.',
      },
      DATA_OPTION,
    ],
  },
  'events verify-archive': {
    kind: 'leaf',
    effect: 'read',
    name: 'verify-archive',
    description:
      'Verify that the archive file named in the most recent chain_rotated event byte-matches its committed digest + line count.',
    options: [],
  },
  'waiver list': {
    kind: 'leaf',
    effect: 'read',
    name: 'list',
    description:
      'List waivers (gate-run-only; hooks consult reprieves, not waivers). By default excludes revoked and expired records.',
    options: [
      { flag: '--include-revoked', effect: 'read', description: 'Include revoked waivers' },
      { flag: '--include-expired', effect: 'read', description: 'Include expired waivers' },
      DATA_OPTION,
    ],
  },
  'waiver show': {
    kind: 'leaf',
    effect: 'read',
    name: 'show',
    argument: {
      valueRole: 'identifier',
      name: 'id',
      required: true,
      description: 'Waiver id to show',
    },
    description: 'Show a waiver, including its derived effectiveness at now.',
    options: [DATA_OPTION],
  },
  'gates list': {
    kind: 'leaf',
    effect: 'read',
    name: 'list',
    description:
      'List policy-declared gates, modes, thresholds, risk-tier budgets, and effective waiver ids. Read-only; does not run evaluators or append gate_evaluated events.',
    options: [
      {
        flag: '--spec <id>',
        effect: 'read',
        valueRole: 'spec-id',
        description: 'Optional spec id for spec-scoped waiver matching',
      },
      {
        flag: '--json',
        effect: 'read',
        description: 'Emit gate summaries, risk tiers, and waiver policy as JSON.',
      },
      DATA_OPTION,
    ],
  },
  'gates explain': {
    kind: 'leaf',
    effect: 'read',
    name: 'explain',
    argument: {
      valueRole: 'identifier',
      name: 'gate',
      required: true,
      description: 'Gate id to explain',
    },
    description:
      'Explain one policy gate: enabled state, mode, thresholds, waiver policy, and effective waiver ids. Read-only; validates the gate id against policy.gates.',
    options: [
      {
        flag: '--spec <id>',
        effect: 'read',
        valueRole: 'spec-id',
        description: 'Optional spec id for spec-scoped waiver matching',
      },
      { flag: '--json', effect: 'read', description: 'Emit the gate explanation as JSON.' },
      DATA_OPTION,
    ],
  },
  'evidence list': {
    kind: 'leaf',
    effect: 'read',
    name: 'list',
    description:
      'Read typed evidence events for a spec from the hash-chained events log. Read-only; verifies the event chain before listing. Filters to test|gate|ac|human_decision evidence and can narrow by --type.',
    options: [
      {
        flag: '--spec <id>',
        effect: 'read',
        valueRole: 'spec-id',
        required: true,
        description: 'Spec id whose evidence should be listed',
      },
      {
        flag: '--type <kind>',
        effect: 'read',
        valueRole: 'evidence-kind',
        description: 'Optional evidence kind filter: test | gate | ac | human_decision',
      },
      { flag: '--json', effect: 'read', description: 'Emit the evidence list as JSON.' },
      DATA_OPTION,
    ],
  },
  'evidence show': {
    kind: 'leaf',
    effect: 'read',
    name: 'show',
    argument: {
      valueRole: 'event-ref',
      name: 'event-ref',
      required: true,
      description: 'Event sequence number, full event hash, or unique event-hash prefix.',
    },
    description:
      'Show one event from the hash-chained events log by sequence number, exact event hash, or unique event-hash prefix. Read-only; verifies the event chain before resolving the reference.',
    options: [
      { flag: '--json', effect: 'read', description: 'Emit the matched event as JSON.' },
      DATA_OPTION,
    ],
  },
  'evidence schema': {
    kind: 'leaf',
    effect: 'read',
    name: 'schema',
    description:
      'Print the kernel-derived payload schema and a copy-pasteable example command for one evidence kind. Read-only; does not read or write .caws/events.jsonl. For test|gate|human_decision the example is a `caws evidence record` call; for ac it is the `caws specs evidence` call that actually writes the closure authority.',
    options: [
      {
        flag: '--type <kind>',
        effect: 'read',
        valueRole: 'evidence-kind',
        required: true,
        description: 'Evidence kind: test | gate | ac | human_decision',
      },
      {
        flag: '--json',
        effect: 'read',
        description: 'Emit schema, required fields, and example command as JSON.',
      },
    ],
  },
  'scope show': {
    kind: 'leaf',
    effect: 'read',
    name: 'show',
    argument: {
      valueRole: 'literal',
      name: 'path',
      required: true,
      description: 'File path to evaluate',
    },
    description: 'Explain the scope decision for <path>; always exits 0',
    options: [
      { flag: '--data', effect: 'read', description: 'Show structured data block' },
      {
        flag: '--spec <id>',
        effect: 'read',
        valueRole: 'spec-id',
        description:
          'Evaluate against a named spec as read-only context instead of current worktree authority',
      },
      {
        flag: '--json',
        effect: 'read',
        description:
          'Emit the scope decision as a single-line stable JSON contract (for hooks/tooling)',
      },
    ],
  },
  'scope check': {
    kind: 'leaf',
    effect: 'read',
    name: 'check',
    argument: {
      valueRole: 'literal',
      name: 'path',
      required: true,
      description: 'File path to enforce',
    },
    description:
      'Enforce the scope decision for <path>; exits 0 on admit, 1 otherwise. --json emits the same decision/remediation contract as scope show while preserving check exit codes.',
    options: [
      { flag: '--data', effect: 'read', description: 'Show structured data block' },
      {
        flag: '--spec <id>',
        effect: 'read',
        valueRole: 'spec-id',
        description:
          'Evaluate against a named spec as read-only context instead of current worktree authority',
      },
      {
        flag: '--json',
        effect: 'read',
        description:
          'Emit the scope decision and remediation guidance as a single-line JSON contract',
      },
    ],
  },
  'scope plan': {
    requireAny: ['--path', '--paths-file'],
    kind: 'leaf',
    effect: 'read',
    name: 'plan',
    description:
      'Evaluate multiple paths in one read-only run and group remediation commands. Always exits 0 after a successful plan, even when planned decisions include refusals.',
    options: [
      {
        flag: '--path <path>',
        effect: 'read',
        valueRole: 'literal',
        description: 'Path to evaluate; repeat for multiple paths',
        collect: true,
        defaultValue: [],
      },
      {
        flag: '--paths-file <file>',
        effect: 'read',
        valueRole: 'literal',
        description:
          'Read newline-delimited paths from a file. Blank lines and # comments are ignored.',
      },
      {
        flag: '--spec <id>',
        effect: 'read',
        valueRole: 'spec-id',
        description:
          'Evaluate every path against a named spec as read-only context instead of current worktree authority',
      },
      {
        flag: '--json',
        effect: 'read',
        description: 'Emit per-path decisions, counts, and grouped remediation commands as JSON',
      },
      { flag: '--data', effect: 'read', description: 'Show structured data block on diagnostics' },
    ],
  },
  'scope contention': {
    kind: 'leaf',
    effect: 'read',
    name: 'contention',
    argument: {
      valueRole: 'literal',
      name: 'path',
      required: true,
      description: 'File path to check for cross-worktree claims',
    },
    description:
      'Report which other active worktrees (same base branch) have a bound spec whose scope.in claims <path>; always exits 0',
    options: [
      {
        flag: '--json',
        effect: 'read',
        description:
          'Emit the contention result as a single-line stable JSON contract (for hooks/tooling)',
      },
    ],
  },
  'worktree list': {
    kind: 'leaf',
    effect: 'read',
    name: 'list',
    description:
      'List registered worktrees with branch, lane divergence from base (ahead/behind), spec binding, and owner.',
    options: [
      {
        flag: '--json',
        effect: 'read',
        description:
          'Emit the same facts as machine-readable JSON, with full owner session ids and null divergence counts where a ref does not resolve',
      },
      DATA_OPTION,
    ],
  },
  'worktree review': {
    kind: 'leaf',
    effect: 'read',
    name: 'review',
    argument: {
      valueRole: 'identifier',
      name: 'name',
      required: true,
      description: 'Registered worktree name to review',
    },
    description:
      'Read-only human-review gate (WORKTREE-REVIEW-SURFACE-001): renders exactly what `caws worktree merge <name>` would land — the exact commit list in base..branch (never counts-only), a per-commit scope-provenance table flagging out-of-scope paths with the refusal merge raises, the lane diffstat, the bound spec’s acceptance criteria with their recorded evidence status (the close-gate authority), and the owner’s lease work_state (visibility only). Never mutates .caws/, never appends events, never touches git refs or any working tree. A missing worktree exits 1; a rendered report exits 0; an empty lane renders honestly without fabricated rows.',
    options: [
      {
        flag: '--json',
        effect: 'read',
        description: 'Emit the same review report as machine-readable JSON.',
      },
      DATA_OPTION,
    ],
  },
  doctor: {
    requires: { '--json': ['--repair-plan'] },
    kind: 'leaf',
    effect: 'read',
    name: 'doctor',
    description: 'Run drift detection against the current .caws/ state',
    options: [
      {
        flag: '--data',
        effect: 'read',
        description: 'Show structured data block on findings/diagnostics',
      },
      {
        flag: '--repair-plan',
        effect: 'read',
        description: 'Emit a read-only repair plan derived from doctor findings',
      },
      {
        flag: '--json',
        effect: 'read',
        description: 'Emit the repair plan as JSON with --repair-plan',
      },
    ],
  },
  status: {
    kind: 'leaf',
    effect: 'read',
    name: 'status',
    description: 'Read-only dashboard: project, current context, claim, and doctor findings',
    options: [
      {
        flag: '--data',
        effect: 'read',
        description: 'Show structured data block on rendered diagnostics',
      },
      { flag: '--specs', effect: 'read', description: 'Render only the focused specs panel' },
      {
        flag: '--worktrees',
        effect: 'read',
        description: 'Render only the focused worktrees panel',
      },
      { flag: '--agents', effect: 'read', description: 'Render only the focused agents panel' },
      { flag: '--doctor', effect: 'read', description: 'Render only the focused doctor panel' },
      { flag: '--short', effect: 'read', description: 'Render a compact read-only status summary' },
      { flag: '--json', effect: 'read', description: 'Emit selected status panels as JSON' },
    ],
  },
  'specs verify-acs': {
    kind: 'leaf',
    effect: 'read',
    name: 'verify-acs',
    argument: {
      valueRole: 'spec-id',
      name: 'id',
      required: true,
      description: 'Spec id whose recorded acceptance evidence to re-derive',
    },
    description:
      "Re-derive the spec's recorded acceptance evidence against reality instead of trusting its status field. Per criterion: the cited commit_sha must exist and be reachable from a ref, the cited artifact_path must be present at that revision, and the cited test_nodeid must exist (or, with --run, execute and pass). Three verdicts, never collapsed: verified (the check ran and passed), refuted (it ran and failed, or the citation names nothing), not_rederived (nothing mechanical was declared, or the check could not run). A criterion with only narrative evidence is not_rederived, and every verdict derived from an agent-supplied field is tagged [agent-cited] — re-derivation proves a citation is real, not that it is relevant; the tag never means the check did not run. Read-only: writes nothing. A recorded command is never executed. Exit 1 when any criterion is refuted; with --strict, also when any is not_rederived.",
    options: [
      {
        flag: '--run',
        effect: 'execute',
        description:
          "Execute cited tests instead of only checking they exist. jest is resolved from the repository's own node_modules/.bin, walking up to the repo root — never npx. pytest is not repo-resolved: it runs as python3 -m pytest against whatever python3 is first on PATH, so a different ambient interpreter can change the verdict. Default: existence check only, which reports not_rederived, never pass",
      },
      {
        flag: '--strict',
        effect: 'read',
        description: 'Exit 1 when any criterion is not_rederived (default: exit 1 only on refuted)',
      },
      {
        flag: '--runner <name>',
        effect: 'read',
        valueRole: 'literal',
        // The executable/detected-only split is DERIVED from the same constant
        // the dispatch reads, so a runner that gains an execution arm moves
        // between these two lists without anyone remembering to edit prose.
        description: `Override test-runner detection. Only ${EXECUTABLE_TEST_RUNNERS.join(', ')} execute under --run; naming ${SELECTABLE_TEST_RUNNERS.filter((r) => !EXECUTABLE_TEST_RUNNERS.includes(r)).join(', ')} reports unavailable and verifies nothing`,
        allowedValues: SELECTABLE_TEST_RUNNERS,
      },
      { flag: '--json', effect: 'read', description: 'Emit the verify-acs.v1 report as JSON' },
      DATA_OPTION,
    ],
  },
  'specs validate': {
    kind: 'leaf',
    effect: 'read',
    name: 'validate',
    argument: {
      valueRole: 'literal',
      name: 'file',
      required: true,
      description: 'Path to the spec YAML file to validate',
    },
    description:
      "Validate a spec YAML FILE on disk using the CLI's own bundled parser and the kernel parse->shape->semantics pipeline. Path-shaped (takes a file path, not a spec id); does NOT resolve .caws/, read canonical state, or mutate anything. Exits 0 when valid, non-zero with a rendered diagnostic when invalid or unreadable. Lets hooks/CI validate spec YAML without carrying their own parser dependency — works for any consumer project regardless of language.",
    options: [DATA_OPTION],
  },
  'specs list': {
    exclusive: [['--status', '--lifecycle', '--state', '--active', '--draft', '--closed']],
    kind: 'leaf',
    effect: 'read',
    name: 'list',
    description: 'List specs. By default excludes archived specs.',
    options: [
      {
        flag: '--status <status>',
        effect: 'read',
        valueRole: 'literal',
        description: 'Filter by lifecycle status',
        allowedValues: SPECS_LIST_STATUSES,
      },
      {
        flag: '--lifecycle <state>',
        effect: 'read',
        valueRole: 'literal',
        description: 'Alias for --status; filter by lifecycle state',
        allowedValues: SPECS_LIST_STATUSES,
      },
      {
        flag: '--state <state>',
        effect: 'read',
        valueRole: 'literal',
        description: 'Alias for --status; filter by lifecycle state',
        allowedValues: SPECS_LIST_STATUSES,
      },
      { flag: '--active', effect: 'read', description: 'Alias for --status active' },
      { flag: '--draft', effect: 'read', description: 'Alias for --status draft' },
      { flag: '--closed', effect: 'read', description: 'Alias for --status closed' },
      { flag: '--archived', effect: 'read', description: 'Include archived specs in the listing' },
      {
        flag: '--session-id <id>',
        effect: 'read',
        valueRole: 'identifier',
        description:
          'Session work-surface view: list only specs this session relates to (created it, holds its bridge claim, or owns a worktree bound to it), each with its binding state and suggested action. Includes archived specs unless --status narrows the view.',
      },
      DATA_OPTION,
    ],
  },
  'specs show': {
    kind: 'leaf',
    effect: 'read',
    name: 'show',
    argument: { valueRole: 'spec-id', name: 'id', required: true, description: 'Spec id to show' },
    description:
      'Show a spec by id. Defaults to active specs only; pass --archived to recover an archived spec body from the event log + git history.',
    options: [
      DATA_OPTION,
      {
        flag: '--archived',
        effect: 'read',
        description:
          'Recover an archived spec body. Move-shaped archives are read from .caws/specs/.archive/ when present; tombstone-shaped archives fall back to git show <blob_sha>.',
      },
    ],
  },
  'specs recover': {
    kind: 'leaf',
    effect: 'read',
    name: 'recover',
    argument: {
      valueRole: 'spec-id',
      name: 'id',
      required: true,
      description: 'Archived spec id to recover',
    },
    description:
      'Recover an archived spec body. Reads .caws/events.jsonl for the spec_archived event, prefers an on-disk .caws/specs/.archive/<id>.yaml body for move-shaped archives, and falls back to git history/blob recovery. Prints to stdout (or --out <path>) and does not mutate .caws/specs/.',
    options: [
      DATA_OPTION,
      {
        flag: '--out <path>',
        effect: 'write',
        valueRole: 'literal',
        description: 'Write the recovered body to this path instead of stdout',
      },
    ],
  },
  specs: {
    kind: 'leaf',
    effect: 'read',
    name: 'specs',
    description: 'Compatibility specs list action',
    options: [
      {
        flag: '--status <status>',
        effect: 'read',
        valueRole: 'literal',
        description: 'Compatibility handoff to caws specs list --status <status>',
        allowedValues: SPECS_LIST_STATUSES,
      },
      DATA_OPTION,
    ],
  },
} satisfies Readonly<Record<string, CawsReadCommandMeta>>;

/** Syntax admission under trusted lookup only; never executable authentication. */
export function isCawsLiteralExecutable(value: string | undefined): boolean {
  if (value === 'caws') return true;
  if (!value?.startsWith('/') || !value.endsWith('/caws')) return false;
  if (/[\x00-\x1f\x7f]/.test(value)) return false;
  const segments = value.slice(1).split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function validOperand(value: string, role: CawsOperandRole | undefined): boolean {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) return false;
  switch (role) {
    case 'literal':
      return true;
    case 'identifier':
      return /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);
    case 'spec-id':
      return /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d+[a-z]*$/.test(value);
    case 'integer':
      return /^\d+$/.test(value) && Number.isSafeInteger(Number(value));
    case 'duration': {
      const seconds = parseDurationToSeconds(value);
      return seconds !== null && Number.isSafeInteger(seconds * 1000);
    }
    case 'event-ref':
      return /^(?:[1-9][0-9]*|(?:sha256:)?[a-f0-9]{8,64}|latest-rotation)$/.test(value);
    case 'evidence-kind':
      return EVIDENCE_KINDS.some((kind) => kind === value);
    default:
      return false;
  }
}

/** Closed literal argv contract. This function performs no I/O or execution. */
export function isCawsReadInvocation(argv: readonly string[]): boolean {
  if (!isCawsLiteralExecutable(argv[0])) return false;
  const args = argv.slice(1);
  const route = Object.entries(CAWS_READ_COMMANDS)
    .filter(([name]) => name.split(' ').every((word, index) => args[index] === word))
    .sort(([a], [b]) => b.length - a.length)[0];
  if (!route) return false;
  const leaf: CawsReadCommandMeta = route[1];
  if (leaf.effect !== 'read') return false;
  const positionals: string[] = [];
  const present = new Set<string>();
  let options = true;
  const definitions = [...leaf.options, CAWS_HELP_OPTION];
  for (let index = route[0].split(' ').length; index < args.length; index++) {
    const token = args[index]!;
    if (options && token === '--') {
      options = false;
      continue;
    }
    if (!options || !token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }
    const equal = token.indexOf('=');
    const spelling = equal < 0 ? token : token.slice(0, equal);
    const option = definitions.find((candidate) =>
      candidate.flag
        .split(/[ ,]+/)
        .filter((flag) => flag.startsWith('-'))
        .includes(spelling)
    );
    if (!option || option.effect !== 'read' || option.hidden) return false;
    const aliases = option.flag.split(/[ ,]+/).filter((flag) => flag.startsWith('-'));
    const canonical = aliases[aliases.length - 1]!;
    if (present.has(canonical) && !option.collect) return false;
    present.add(canonical);
    // Only exact boolean flags and required data operands are modeled. An
    // optional operand or an unknown future syntax has no inspection role.
    if (!/^(?:-[A-Za-z], )?--[a-z][a-z0-9.-]*(?: <[A-Za-z][A-Za-z0-9_-]*>)?$/.test(option.flag))
      return false;
    const takesValue = /<[^>]+>/.test(option.flag);
    if (!takesValue) {
      if (equal >= 0) return false;
      continue;
    }
    const operand = equal >= 0 ? token.slice(equal + 1) : args[++index];
    if (
      operand === undefined ||
      operand.startsWith('-') ||
      !validOperand(operand, option.valueRole)
    )
      return false;
    if (option.allowedValues && !option.allowedValues.some((value) => String(value) === operand))
      return false;
  }
  const declared = leaf.arguments ?? (leaf.argument ? [leaf.argument] : []);
  if (positionals.length > declared.length) return false;
  for (let index = 0; index < declared.length; index++) {
    const argument = declared[index]!;
    const value = positionals[index];
    if (value === undefined) {
      if (argument.required) return false;
    } else {
      if (!validOperand(value, argument.valueRole)) return false;
      present.add('@' + index);
    }
  }
  for (const option of leaf.options) {
    const aliases = option.flag.split(/[ ,]+/).filter((flag) => flag.startsWith('-'));
    if (option.required && !present.has(aliases[aliases.length - 1]!)) return false;
  }
  if (leaf.requireAny && !leaf.requireAny.some((key) => present.has(key))) return false;
  if (leaf.exclusive?.some((keys) => keys.filter((key) => present.has(key)).length > 1))
    return false;
  for (const [key, dependencies] of Object.entries(leaf.requires ?? {})) {
    if (present.has(key) && dependencies.some((dependency) => !present.has(dependency)))
      return false;
  }
  return true;
}
