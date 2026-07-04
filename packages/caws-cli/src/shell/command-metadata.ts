// Single-source command metadata for the v11 CLI surface
// (CAWS-CLI-HELP-METADATA-AUTHORITY-001).
//
// PROBLEM this solves: every `.description()` / `.argument()` / `.option()`
// in register.ts is a hand-authored string literal with no binding to the
// command's actual behavior. They drift (e.g. `specs archive --help` said
// "moves the YAML to .archive/" long after archive became a tombstone). This
// module makes the help metadata a typed, single-authority object that
// register.ts consumes, so:
//   - description prose lives co-located with the handler it describes
//     (each commands/<group>.ts exports its own *_COMMAND_META),
//   - enum-backed option values (--mode, --resolution, ...) are DERIVED from
//     the kernel enum arrays (SPEC_MODES, etc.) rather than re-typed, and a
//     lock test asserts they equal the kernel/schema enums,
//   - a lock test asserts the metadata group set equals
//     REGISTERED_COMMAND_GROUPS and that register.ts carries no inline
//     description/option string literals.
//
// STAGING (this is slice 1): this module defines the interfaces and exports
// an EMPTY frozen COMMAND_SURFACE_METADATA. register.ts is NOT yet refactored
// to consume it (that is slices 2-3, group by group). The interface shapes
// are stable; later slices only ADD entries.
//
// What is machine-derivable vs. hand-authored:
//   - DERIVABLE (lock-tested against the kernel/schema): option `allowedValues`
//     for enum flags, the group-name set, option required-ness.
//   - HAND-AUTHORED (no schema source; co-located with the handler): the
//     behavioral description prose ("tombstone, not move"; "does NOT run git
//     push"). The lock test cannot verify prose accuracy — co-location +
//     same-slice scope.in is the discipline that keeps it honest.

import {
  RISK_TIERS,
  SPEC_MODES,
  SPEC_RESOLUTIONS,
} from '@paths.design/caws-kernel';

/** A positional argument on a command (this CLI uses at most one per command). */
export interface CommandArgMeta {
  /** Argument name as it appears in usage, e.g. "id" or "path". */
  readonly name: string;
  /** Whether the argument is required (`<name>`) or optional (`[name]`). */
  readonly required: boolean;
  /** Help text for the argument. */
  readonly description: string;
}

/**
 * A Commander option. The `flag` string is authored verbatim (e.g.
 * "--mode <mode>" or "--apply") so register.ts calls
 * `.option(flag, description, defaultValue?)` with no string literal of its
 * own.
 */
export interface CommandOptionMeta {
  /** Full Commander flag string, e.g. "--mode <mode>", "--ack <sha>", "--apply". */
  readonly flag: string;
  /** When true, register.ts uses `.requiredOption()` (Commander pre-validates). */
  readonly required?: boolean;
  /**
   * Help prose. When `allowedValues` is set, register.ts appends
   * ": <v1> | <v2> | ..." and the lock test asserts that list equals the
   * kernel/schema enum — so the value list is the derived, locked part and
   * this string is only the prose prefix.
   */
  readonly description: string;
  /**
   * Enum-backed value list (e.g. SPEC_MODES). Present only for options whose
   * accepted values come from a kernel enum / JSON-schema enum. The lock test
   * asserts deep-equality against that authority; drift becomes a test failure.
   */
  readonly allowedValues?: readonly (string | number)[];
  /** Commander default value, passed as the 3rd arg to `.option()`. */
  readonly defaultValue?: string | boolean | readonly string[];
  /**
   * True for repeatable options that accumulate (e.g. `--ack <sha>` collected
   * into an array). register.ts supplies the collector; this flag records the
   * intent so the metadata is self-describing.
   */
  readonly collect?: boolean;
  /**
   * True for an option that must stay REGISTERED (Commander parses it) but must
   * NOT appear in `--help`. register.ts registers it via
   * `new Option(flag, desc).hideHelp()`. Used for removed-but-still-accepted
   * legacy aliases (e.g. `specs create --type`) whose only purpose is to route a
   * v10 muscle-memory invocation to a helpful "use --mode instead" migration
   * error rather than Commander's generic "unknown option" — while keeping the
   * help options list free of flags a first-timer would misread as current.
   */
  readonly hidden?: boolean;
}

/** A leaf command (one that has an `.action()` handler). */
export interface LeafCommandMeta {
  readonly kind: 'leaf';
  /** Command name as passed to `.command()` (without the `<arg>` suffix). */
  readonly name: string;
  /** The positional argument, if any. */
  readonly argument?: CommandArgMeta;
  /** The `.description()` text. */
  readonly description: string;
  /** Declared options, in display order. */
  readonly options: readonly CommandOptionMeta[];
}

/** A group command whose subcommands carry the `.action()` handlers. */
export interface GroupCommandMeta {
  readonly kind: 'group';
  /** Group name as passed to `.command()`, e.g. "specs". */
  readonly name: string;
  /** The group-level `.description()` (shown in `caws --help` and `caws <group> --help`). */
  readonly description: string;
  /** The group's subcommands. */
  readonly subcommands: readonly LeafCommandMeta[];
}

/** Either a flat leaf command or a group with subcommands. */
export type CommandMeta = LeafCommandMeta | GroupCommandMeta;

/**
 * The `--data` option appears on every leaf command in the surface. Declaring
 * it once keeps the per-command metadata focused on what is distinctive.
 */
const DATA_OPTION: CommandOptionMeta = {
  flag: '--data',
  description: 'Show structured data block on diagnostics',
};

// ─── specs group (CLI-SPECS-001) ──────────────────────────────────────────
// Co-located authority for `caws specs` help. The descriptions here are the
// single source consumed by register.ts; the option `allowedValues` derive
// from the kernel enum arrays (SPEC_MODES / SPEC_RESOLUTIONS / RISK_TIERS) so
// --mode/--resolution/--risk-tier help cannot drift from the validation enums.
export const SPECS_COMMAND_META: GroupCommandMeta = {
  kind: 'group',
  name: 'specs',
  description:
    'Manage CAWS spec lifecycle (create/list/show/recover/retire-draft/activate/amend-scope/close/archive/prune-archive/migrate/validate)',
  subcommands: [
    {
      kind: 'leaf',
      name: 'create',
      argument: { name: 'id', required: true, description: 'Spec id to create' },
      description: 'Create a new spec in lifecycle_state: active.',
      // W3: --title/--mode/--risk-tier are functionally required, but the
      // handler (runSpecsCreateCommand) owns the missing-args check so it can
      // emit rich guidance (usage block + --type hint) that Commander's
      // .requiredOption() pre-validation would degrade. So we mark them
      // "(required)" in prose and keep them .option() — help states the
      // requirement; the handler enforces it.
      options: [
        { flag: '--title <title>', description: 'Short spec title (required)' },
        {
          flag: '--mode <mode>',
          description: 'Spec mode (required)',
          allowedValues: SPEC_MODES,
        },
        {
          flag: '--risk-tier <n>',
          description: 'Risk tier (required)',
          allowedValues: RISK_TIERS,
        },
        {
          flag: '--scope-in <path>',
          description:
            'Populate scope.in at creation time (repeatable); avoids the YAML hand-edit. Widen later with `caws specs amend-scope`.',
          collect: true,
        },
        {
          flag: '--contract <spec>',
          description:
            'Add a contract at creation (repeatable), as "name:type[:path]" where type is api|schema|contract-test|behavior. Example: --contract "core-api:behavior". Tier 1/2 specs REQUIRE at least one contract; tier 3 / --mode chore do not.',
          collect: true,
        },
        {
          flag: '--type <type>',
          description:
            'Removed v10 alias; use --mode <feature|refactor|fix|doc|chore> instead',
          // CAWS-SPECS-CREATE-HIDE-LEGACY-TYPE-001: keep --type parseable (so a v10
          // `--type` invocation hits the handler's "use --mode" migration error,
          // not Commander's generic "unknown option"), but hide it from --help so
          // first-timers don't read a removed alias as a current option.
          hidden: true,
        },
        DATA_OPTION,
      ],
    },
    {
      kind: 'leaf',
      name: 'list',
      description: 'List specs. By default excludes archived specs.',
      options: [
        { flag: '--archived', description: 'Include archived specs in the listing' },
        DATA_OPTION,
      ],
    },
    {
      kind: 'leaf',
      name: 'show',
      argument: { name: 'id', required: true, description: 'Spec id to show' },
      description:
        'Show a spec by id. Defaults to active specs only; pass --archived to recover an archived spec body from the event log + git history.',
      options: [
        DATA_OPTION,
        {
          flag: '--archived',
          description:
            'Recover an archived spec body. Move-shaped archives are read from .caws/specs/.archive/ when present; tombstone-shaped archives fall back to git show <blob_sha>.',
        },
      ],
    },
    {
      kind: 'leaf',
      name: 'recover',
      argument: { name: 'id', required: true, description: 'Archived spec id to recover' },
      description:
        'Recover an archived spec body. Reads .caws/events.jsonl for the spec_archived event, prefers an on-disk .caws/specs/.archive/<id>.yaml body for move-shaped archives, and falls back to git history/blob recovery. Prints to stdout (or --out <path>) and does not mutate .caws/specs/.',
      options: [
        DATA_OPTION,
        {
          flag: '--out <path>',
          description: 'Write the recovered body to this path instead of stdout',
        },
      ],
    },
    {
      kind: 'leaf',
      name: 'retire-draft',
      argument: { name: 'id', required: true, description: 'Draft spec id to retire' },
      description:
        'Retire a never-activated DRAFT spec via tombstone. Refuses active (use close), closed (use archive), and archived specs. Deletes the draft YAML and appends a recoverable spec_retired event (recover via caws specs show <id> --archived). The governed alternative to raw git rm.',
      options: [
        { flag: '--reason <text>', description: 'Optional human-readable retirement note' },
        DATA_OPTION,
      ],
    },
    {
      kind: 'leaf',
      name: 'activate',
      argument: { name: 'id', required: true, description: 'Draft spec id to activate' },
      description:
        'Activate a pre-authored draft spec. Draft-only: patches lifecycle_state to active and appends spec_activated.',
      options: [DATA_OPTION],
    },
    {
      kind: 'leaf',
      name: 'amend-scope',
      argument: { name: 'id', required: true, description: 'Active or draft spec id to amend' },
      description:
        'Amend a spec\'s scope.in/scope.out/scope.support on the canonical control plane (active/draft only). The sanctioned way to add a path you need to edit — no git cherry-pick, no danger latch. Writes only canonical .caws/specs/<id>; scope check from a linked worktree admits the added path immediately. Comment-preserving; validate-before-write; appends spec_scope_amended.',
      options: [
        { flag: '--add <path>', description: 'Add a scope.in path — editable AND worktree-claimed (repeatable)', collect: true },
        { flag: '--remove <path>', description: 'Remove a matching scope.in path — file or directory, matched by logical value regardless of quoting (repeatable)', collect: true },
        { flag: '--add-out <path>', description: 'Add a scope.out path. NOTE: the no-glob rule is an ADD-time schema constraint (file or directory paths only); removal has no such restriction (repeatable)', collect: true },
        { flag: '--remove-out <path>', description: 'Remove a matching scope.out path — file or directory, matched by logical value regardless of quoting (repeatable)', collect: true },
        { flag: '--add-support <path>', description: 'Add a scope.support path — editable like scope.in but NOT worktree-claimed (use for repo-root deliverables; repeatable)', collect: true },
        { flag: '--remove-support <path>', description: 'Remove a matching scope.support path — matched by logical value regardless of quoting (repeatable)', collect: true },
        DATA_OPTION,
      ],
    },
    {
      kind: 'leaf',
      name: 'close',
      argument: { name: 'id', required: true, description: 'Active spec id to close' },
      description:
        'Close an active spec. Non-destructive raw-byte YAML patch; appends spec_closed event.',
      options: [
        {
          flag: '--resolution <r>',
          description: 'Resolution',
          allowedValues: SPEC_RESOLUTIONS,
          defaultValue: 'completed',
        },
        {
          flag: '--reason <text>',
          description: 'Closure notes recorded on the spec YAML and the spec_closed event',
        },
        {
          flag: '--merge-commit <sha>',
          description:
            'Optional merge commit SHA (e.g., when closure follows a worktree merge)',
        },
        {
          flag: '--superseded-by <id>',
          description: 'Spec id that supersedes this one (use with --resolution superseded)',
        },
        DATA_OPTION,
      ],
    },
    {
      kind: 'leaf',
      name: 'archive',
      argument: { name: 'id', required: false, description: 'Closed spec id to archive' },
      description:
        'Archive one closed spec, or batch-archive closed specs with --status closed. Batch mode defaults to dry-run; pass --apply to archive selected specs in one aggregate audit commit.',
      options: [
        {
          flag: '--reason <text>',
          description: 'Archive reason (advisory; the spec_archived event does not carry it)',
        },
        { flag: '--status <s>', description: 'Batch selector status. Currently only: closed' },
        {
          flag: '--include <ids>',
          description: 'Comma-separated spec ids to include in batch mode',
        },
        {
          flag: '--exclude <ids>',
          description: 'Comma-separated spec ids to exclude from batch mode',
        },
        { flag: '--apply', description: 'Apply batch archive (default: dry-run)' },
        { flag: '--json', description: 'Emit CAWS-native JSON to stdout' },
        DATA_OPTION,
      ],
    },
    {
      kind: 'leaf',
      name: 'prune-archive',
      description:
        'Compatibility no-op. Archived spec bodies under .caws/specs/.archive/ are canonical again and are not pruned by CAWS.',
      options: [
        { flag: '--apply', description: 'Accepted for compatibility; no files are pruned.' },
        DATA_OPTION,
      ],
    },
    {
      kind: 'leaf',
      name: 'migrate',
      description:
        'v10→v11 spec YAML migrator (CAWS-MIGRATE-V10-SPECS-001). Default is dry-run; --apply opts into mutation. --apply without --partial refuses if any spec hits a "refused" verdict. --apply --partial writes migratable specs, skips refused, emits a durable JSON report under .caws/migrations/v10-specs/.',
      options: [
        {
          flag: '--from <version>',
          required: true,
          description: 'Source schema version (only v10 is supported in v11.2)',
        },
        { flag: '--apply', description: 'Write migrated YAMLs to disk (default: dry-run)' },
        {
          flag: '--partial',
          description:
            'Allow apply to proceed even when some specs are refused (only meaningful with --apply)',
        },
        {
          flag: '--lifecycle-mapping <path>',
          description:
            'Path to a JSON file mapping spec ids to v11 lifecycle values, for v10 lifecycles outside the v11 enum (superseded/proven/frozen). Operator-owned; the transformer never auto-defaults.',
        },
        { flag: '--json', description: 'Emit machine-readable JSON output instead of human text' },
        DATA_OPTION,
      ],
    },
    {
      kind: 'leaf',
      name: 'validate',
      argument: { name: 'file', required: true, description: 'Path to the spec YAML file to validate' },
      description:
        'Validate a spec YAML FILE on disk using the CLI\'s own bundled parser and the kernel parse->shape->semantics pipeline. Path-shaped (takes a file path, not a spec id); does NOT resolve .caws/, read canonical state, or mutate anything. Exits 0 when valid, non-zero with a rendered diagnostic when invalid or unreadable. Lets hooks/CI validate spec YAML without carrying their own parser dependency — works for any consumer project regardless of language.',
      options: [DATA_OPTION],
    },
  ],
};

// ─── worktree group (CLI-WORKTREE-001) ────────────────────────────────────
// Co-located authority for `caws worktree` help. The group description here
// enumerates EVERY subcommand (create/list/bind/destroy/merge/migrate-registry/
// repair-sparse), unlike the prior inline string that omitted the last two.
export const WORKTREE_COMMAND_META: GroupCommandMeta = {
  kind: 'group',
  name: 'worktree',
  description:
    'Manage CAWS worktrees (create/list/bind/destroy/merge/migrate-registry/repair-sparse/repair). Worktrees are git worktrees bound to active specs.',
  subcommands: [
    {
      kind: 'leaf',
      name: 'create',
      argument: { name: 'name', required: true, description: 'Worktree name' },
      description:
        'Create a new git worktree under .caws/worktrees/<name> bound to an active spec. Also links recognized git-ignored dependency/cache artifacts (node_modules, .pnpm-store, Python venvs, Rust target, Swift .build) from the canonical checkout into the worktree as relative symlinks, reported under an "Artifacts:" block with unlink/install guidance. Linking is advisory (create never fails on it), skips paths that already exist in the worktree, and skips on lock/manifest divergence. A linked artifact shares the canonical directory: run the printed unlink command before installing if the worktree branch changes dependency manifests.',
      options: [
        { flag: '--spec <id>', required: true, description: 'Active spec id to bind the worktree to' },
        {
          flag: '--base-branch <branch>',
          description: 'Base branch to start from (default: current branch)',
        },
        { flag: '--branch <branch>', description: 'New branch name (default: worktree name)' },
        DATA_OPTION,
      ],
    },
    {
      kind: 'leaf',
      name: 'list',
      description: 'List registered worktrees with branch, spec binding, and owner.',
      options: [DATA_OPTION],
    },
    {
      kind: 'leaf',
      name: 'bind',
      argument: { name: 'name', required: true, description: 'Worktree name' },
      description:
        'Repair bidirectional binding between a worktree and a spec (one-sided → bound). Refuses a foreign-owned worktree unless --steal --reason is given.',
      options: [
        { flag: '--spec <id>', required: true, description: 'Spec id to bind the worktree to' },
        {
          flag: '--steal',
          description:
            'Forcibly take ownership of a worktree owned by a different session. Requires --reason. Appends a worktree_ownership_seized audit event.',
        },
        {
          flag: '--reason <text>',
          description:
            'Justification for --steal (required when stealing; recorded in the audit log).',
        },
        DATA_OPTION,
      ],
    },
    {
      kind: 'leaf',
      name: 'destroy',
      argument: { name: 'name', required: true, description: 'Worktree name' },
      description:
        'Destroy a worktree. Non-forceful: refuses foreign ownership, dirty checkout, unmerged branch (use --abandon-unmerged to override branch check only).',
      options: [
        {
          flag: '--abandon-unmerged',
          description:
            'Destroy even when the branch is not merged into base. Still respects ownership and clean working tree.',
        },
        DATA_OPTION,
      ],
    },
    {
      kind: 'leaf',
      name: 'merge',
      argument: { name: 'name', required: true, description: 'Worktree name' },
      description:
        'Merge a worktree branch into its base. Auto-closes the bound spec via caws specs close.',
      options: [
        { flag: '--dry-run', description: 'Validate prerequisites only; no git, no file writes, no events' },
        {
          flag: '--message <text>',
          description: 'Custom merge commit message (default: merge(worktree): <name>)',
        },
        DATA_OPTION,
      ],
    },
    {
      kind: 'leaf',
      name: 'migrate-registry',
      description:
        'Convert v10.2 legacy-envelope .caws/worktrees.json into the v11 flat-map shape. Destroyed records are omitted iff no spec claims them and their path is absent; refuses otherwise. Idempotent on already-flat files.',
      options: [
        { flag: '--dry-run', description: 'Classify and report what would happen; do not write.' },
        DATA_OPTION,
      ],
    },
    {
      kind: 'leaf',
      name: 'repair-sparse',
      argument: { name: 'name', required: true, description: 'Worktree name' },
      description:
        'Restore the .caws/specs sparse-checkout invariant on a linked worktree. Idempotent and non-destructive: refuses if .caws/specs/ has dirty or untracked content rather than stashing, cleaning, resetting, or deleting it. Use this after a `git sparse-checkout disable` has materialized canonical spec files into the worktree.',
      options: [DATA_OPTION],
    },
    {
      kind: 'leaf',
      name: 'repair',
      description:
        'Repair the unambiguous worktree/spec half-states the doctor surfaces: prune a ghost registry entry (H1) and clear a dead spec->worktree binding (H4 ghost, H3 dormant). Consumes the doctor diagnostics + §1.4 decision matrix as authority; never re-derives policy. Refuses ambiguous/forbidden classes (H2, H3-active, H5, H6, event-orphan) with a doctrine pointer and zero mutation. NEVER creates or deletes a git worktree directory.',
      options: [
        { flag: '--dry-run', description: 'Report each H-class, subject, planned mutation, and event; write nothing.' },
        DATA_OPTION,
      ],
    },
  ],
};

// ─── flat top-level commands (init/doctor/status/claim/prepush) ───────────
// These are registered directly on `program` (no subcommand layer); they are
// LeafCommandMeta entries at the top of COMMAND_SURFACE_METADATA. register.ts
// consumes them via the defineFlat helper.

export const INIT_COMMAND_META: LeafCommandMeta = {
  kind: 'leaf',
  name: 'init',
  description:
    'Bootstrap the canonical vNext .caws/ project state (idempotent; refuses to overwrite legacy single-spec layout). With --agent-surface, also installs the corresponding hook pack.',
  options: [
    DATA_OPTION,
    {
      flag: '--agent-surface <name>',
      description:
        'Install a hook pack for an agent harness (claude-code | codex | opencode | cursor | windsurf | none). When omitted, init attempts filesystem detection and skips hook install when ambiguous.',
    },
    {
      flag: '--overwrite',
      description:
        'For hook-pack install: replace drifted or unmanaged files at managed pack paths. CAUTION: local edits to those files will be lost.',
    },
    {
      flag: '--adopt',
      description:
        'For hook-pack install: leave drifted or unmanaged files in place without enforcing pack contents. CAUTION: pack drift is no longer tracked for those paths.',
    },
  ],
};

export const DOCTOR_COMMAND_META: LeafCommandMeta = {
  kind: 'leaf',
  name: 'doctor',
  description: 'Run drift detection against the current .caws/ state',
  options: [{ flag: '--data', description: 'Show structured data block on findings/diagnostics' }],
};

export const STATUS_COMMAND_META: LeafCommandMeta = {
  kind: 'leaf',
  name: 'status',
  description:
    'Read-only dashboard: project, current context, claim, and doctor findings',
  options: [{ flag: '--data', description: 'Show structured data block on rendered diagnostics' }],
};

export const CLAIM_COMMAND_META: LeafCommandMeta = {
  kind: 'leaf',
  name: 'claim',
  description:
    "Surface ownership of the current worktree; with --takeover, acquire ownership from a foreign session (writes prior_owners audit). With --paths, declare working-tree ownership metadata on the current session's lease (SESSION-OWNERSHIP-METADATA-001).",
  options: [
    {
      flag: '--takeover',
      description:
        'Forcibly take ownership of a foreign-owned worktree. Required when the current owner is a different session.',
    },
    {
      flag: '--paths <path>',
      description:
        'Declare a path as claimed by the current session. Repeatable; order preserved; strings stored verbatim. Refused with no write if no lease exists for the current session.',
      collect: true,
    },
    DATA_OPTION,
  ],
};

export const PREPUSH_COMMAND_META: LeafCommandMeta = {
  kind: 'leaf',
  name: 'prepush',
  description:
    'Classify the outgoing commit range before publish and refuse commits not attributable to the current slice. Diagnose/decide only — does NOT run git push.',
  options: [
    { flag: '--remote <remote>', description: 'Push remote', defaultValue: 'origin' },
    { flag: '--branch <branch>', description: 'Push branch', defaultValue: 'main' },
    { flag: '--base <ref>', description: 'Base ref override (default <remote>/<branch>)' },
    { flag: '--spec <id>', description: 'Current session active spec id (for slice-match)' },
    {
      flag: '--ack <sha>',
      description: 'Acknowledge an unexpected commit by SHA (repeatable)',
      collect: true,
      // Seed []: the prepush handler reads opts.ack as an array unconditionally.
      defaultValue: [],
    },
    DATA_OPTION,
  ],
};

// ─── scope group ──────────────────────────────────────────────────────────
export const SCOPE_COMMAND_META: GroupCommandMeta = {
  kind: 'group',
  name: 'scope',
  description: 'Evaluate file paths against the bound spec scope',
  subcommands: [
    {
      kind: 'leaf',
      name: 'show',
      argument: { name: 'path', required: true, description: 'File path to evaluate' },
      description: 'Explain the scope decision for <path>; always exits 0',
      options: [
        { flag: '--data', description: 'Show structured data block' },
        {
          flag: '--json',
          description:
            'Emit the scope decision as a single-line stable JSON contract (for hooks/tooling)',
        },
      ],
    },
    {
      kind: 'leaf',
      name: 'check',
      argument: { name: 'path', required: true, description: 'File path to enforce' },
      description: 'Enforce the scope decision for <path>; exits 0 on admit, 1 otherwise',
      options: [{ flag: '--data', description: 'Show structured data block' }],
    },
    {
      kind: 'leaf',
      name: 'contention',
      argument: { name: 'path', required: true, description: 'File path to check for cross-worktree claims' },
      description:
        'Report which other active worktrees (same base branch) have a bound spec whose scope.in claims <path>; always exits 0',
      options: [
        {
          flag: '--json',
          description:
            'Emit the contention result as a single-line stable JSON contract (for hooks/tooling)',
        },
      ],
    },
  ],
};

// ─── gates group (W4: exit-code contract documented) ──────────────────────
export const GATES_COMMAND_META: GroupCommandMeta = {
  kind: 'group',
  name: 'gates',
  description: 'Run quality gates against the current changes (policy-driven)',
  subcommands: [
    {
      kind: 'leaf',
      name: 'run',
      description:
        'Run CAWS-local policy evaluators and apply policy.gates[gate].mode to decide block/warn/skip. Appends one gate_evaluated event per policy-declared gate. Exit codes: 0/1 on gate disposition; 2 on hard composition error (no policy / report-contract failure); 3 on evidence-integrity failure (a gate_evaluated event failed to append or validate).',
      options: [
        { flag: '--spec <id>', required: true, description: 'Spec id this gate run is about' },
        {
          flag: '--context <ctx>',
          description: 'Compatibility no-op retained from the former external quality package path',
          defaultValue: 'cli',
        },
        DATA_OPTION,
      ],
    },
  ],
};

// ─── evidence group ───────────────────────────────────────────────────────
export const EVIDENCE_COMMAND_META: GroupCommandMeta = {
  kind: 'group',
  name: 'evidence',
  description: 'Record typed evidence events into .caws/events.jsonl',
  subcommands: [
    {
      kind: 'leaf',
      name: 'record',
      description: 'Append a typed evidence event (test|gate|ac)',
      options: [
        { flag: '--type <kind>', required: true, description: 'Evidence kind: test | gate | ac' },
        { flag: '--spec <id>', required: true, description: 'Spec id this evidence is about' },
        { flag: '--data <json>', required: true, description: 'Event payload as a JSON object string' },
        {
          flag: '--actor-kind <kind>',
          description: 'Actor kind: agent | human | system | automation',
          defaultValue: 'agent',
        },
        { flag: '--actor-id <id>', description: 'Override actor id (defaults to session id)' },
      ],
    },
  ],
};

// ─── events group ─────────────────────────────────────────────────────────
export const EVENTS_COMMAND_META: GroupCommandMeta = {
  kind: 'group',
  name: 'events',
  description: 'Maintenance commands for .caws/events.jsonl (rotate, migrate, verify-archive)',
  subcommands: [
    {
      kind: 'leaf',
      name: 'migrate',
      description:
        'Migrate a v10-shape events.jsonl to a v11 chain via chain_rotated rotation. Dry-run by default; --apply executes.',
      options: [
        {
          flag: '--from <version>',
          required: true,
          description: 'Source schema version (only v10 supported in v11.2)',
        },
        { flag: '--apply', description: 'Execute the rotation (default is dry-run)' },
        {
          flag: '--reason <text>',
          description:
            'Operator reason recorded into the chain_rotated payload (required with --apply)',
        },
        {
          flag: '--actor-kind <kind>',
          description: 'Actor kind: agent | human | system | automation',
          defaultValue: 'agent',
        },
        { flag: '--actor-id <id>', description: 'Override actor id (defaults to session id)' },
        {
          flag: '--allow-partial-upgrade',
          description:
            'Allow rotation when v10 specs are still present (off by default; see CAWS-MIGRATE-V10-SPECS-001)',
        },
      ],
    },
    {
      kind: 'leaf',
      name: 'rotate',
      description:
        'Rotate events.jsonl: archive existing chain, start fresh chain with chain_rotated genesis event. Distinct from migrate — admits fully-unparseable logs.',
      options: [
        {
          flag: '--reason <text>',
          required: true,
          description: 'Operator reason recorded into the chain_rotated payload',
        },
        {
          flag: '--actor-kind <kind>',
          description: 'Actor kind: agent | human | system | automation',
          defaultValue: 'agent',
        },
        { flag: '--actor-id <id>', description: 'Override actor id (defaults to session id)' },
        { flag: '--allow-clean', description: 'Allow rotation of a clean v11 chain (friction flag)' },
      ],
    },
    {
      kind: 'leaf',
      name: 'verify-archive',
      description:
        'Verify that the archive file named in the most recent chain_rotated event byte-matches its committed digest + line count.',
      options: [],
    },
  ],
};

// ─── waiver group ─────────────────────────────────────────────────────────
export const WAIVER_COMMAND_META: GroupCommandMeta = {
  kind: 'group',
  name: 'waiver',
  description:
    'Manage CAWS waivers (bounded exception records that suppress matching gate violations)',
  subcommands: [
    {
      kind: 'leaf',
      name: 'create',
      argument: { name: 'id', required: true, description: 'Waiver id to create' },
      description: 'Create a new active waiver. Validates against the kernel before writing.',
      options: [
        { flag: '--title <title>', required: true, description: 'Short waiver title (≥5 chars)' },
        {
          flag: '--gate <gate>',
          required: true,
          description: 'Gate id this waiver covers; repeat for multiple gates',
          collect: true,
        },
        { flag: '--reason <reason>', required: true, description: 'Justification for the waiver' },
        { flag: '--approved-by <id>', required: true, description: 'Approver identity' },
        {
          flag: '--expires-at <iso>',
          required: true,
          description: 'Expiry as an ISO-8601 datetime with timezone',
        },
        {
          flag: '--spec <id>',
          description: 'Optional spec id this waiver is scoped to (omit for project-wide)',
        },
        DATA_OPTION,
      ],
    },
    {
      kind: 'leaf',
      name: 'list',
      description: 'List waivers. By default excludes revoked and expired records.',
      options: [
        { flag: '--include-revoked', description: 'Include revoked waivers' },
        { flag: '--include-expired', description: 'Include expired waivers' },
        DATA_OPTION,
      ],
    },
    {
      kind: 'leaf',
      name: 'show',
      argument: { name: 'id', required: true, description: 'Waiver id to show' },
      description: 'Show a waiver, including its derived effectiveness at now.',
      options: [DATA_OPTION],
    },
    {
      kind: 'leaf',
      name: 'revoke',
      argument: { name: 'id', required: true, description: 'Waiver id to revoke' },
      description: 'Revoke a waiver. Writes a revocation record; refuses double-revoke.',
      options: [
        { flag: '--revoked-by <id>', description: 'Identity recorded in revocation.revoked_by' },
        {
          flag: '--reason <reason>',
          description: 'Reason recorded in revocation.reason (recommended for audit)',
        },
        DATA_OPTION,
      ],
    },
  ],
};

// ─── agents group ─────────────────────────────────────────────────────────
export const AGENTS_COMMAND_META: GroupCommandMeta = {
  kind: 'group',
  name: 'agents',
  description:
    'Agent liveness substrate: register/heartbeat/stop/list/show/prune. Operational cache only — NEVER authority. CAWS-native JSON; never Claude Code hook envelope.',
  subcommands: [
    {
      kind: 'leaf',
      name: 'register',
      description: 'Register this session in .caws/leases/. Hook-invoked at SessionStart.',
      options: [
        {
          flag: '--session-id <id>',
          description: 'Explicit session id (required for hook-invoked usage; overrides resolveSession)',
        },
        { flag: '--platform <p>', description: 'Platform tag (e.g., claude-code, cursor, manual)' },
        { flag: '--reason <r>', description: 'session_start | pre_tool_use | manual_register | claim | status' },
        { flag: '--json', description: 'Emit CAWS-native JSON to stdout (never hookSpecificOutput)' },
        {
          flag: '--include-active-summary',
          description: 'Include active_agent_count + active_agents in JSON output',
        },
        DATA_OPTION,
      ],
    },
    {
      kind: 'leaf',
      name: 'heartbeat',
      description: "Refresh this session's lease. Hook-invoked at PreToolUse. Throttle-aware.",
      options: [
        { flag: '--session-id <id>', description: 'Explicit session id (required for hook-invoked usage)' },
        { flag: '--platform <p>', description: 'Platform tag' },
        { flag: '--reason <r>', description: 'pre_tool_use | claim | status | manual_register' },
        {
          flag: '--throttle <ms>',
          description: 'Skip write if last_active within this many ms (default: 0 — no throttle)',
        },
        { flag: '--json', description: 'Emit CAWS-native JSON to stdout' },
        {
          flag: '--include-active-summary',
          description: 'Include active_agent_count + active_agents in JSON output',
        },
        DATA_OPTION,
      ],
    },
    {
      kind: 'leaf',
      name: 'stop',
      description: "Mark this session's lease stopped. Hook-invoked at Stop. Warn no-op if no prior lease.",
      options: [
        { flag: '--session-id <id>', description: 'Explicit session id' },
        { flag: '--platform <p>', description: 'Platform tag' },
        { flag: '--json', description: 'Emit CAWS-native JSON to stdout' },
        DATA_OPTION,
      ],
    },
    {
      kind: 'leaf',
      name: 'list',
      description: 'List active / stale / stopped agents. Read-only.',
      options: [
        { flag: '--include-stale', description: 'Include stale (active-but-TTL-expired) records' },
        { flag: '--include-stopped', description: 'Include stopped records' },
        {
          flag: '--active',
          description: 'Active-only (overrides --include-* flags); TTL-classified active, not raw status field',
        },
        { flag: '--stale-ttl-ms <ms>', description: 'TTL for stale classification (default: 1800000 = 30m)' },
        { flag: '--json', description: 'Emit CAWS-native JSON to stdout' },
        DATA_OPTION,
      ],
    },
    {
      kind: 'leaf',
      name: 'show',
      argument: { name: 'id', required: true, description: 'Session id of the lease to show' },
      description: 'Show one lease by session id. Read-only.',
      options: [
        { flag: '--json', description: 'Emit CAWS-native JSON to stdout' },
        DATA_OPTION,
      ],
    },
    {
      kind: 'leaf',
      name: 'prune',
      description:
        'Operator-invoked cleanup. Defaults to dry-run; pass --apply to actually delete. Never invoked by hooks. Two modes: --dead (PID-liveness: remove active/stopping leases on THIS host whose owning process is gone — collapses the verify→stop→prune dance into one step), or --status <stopped|stale> --older-than-ms <ms> (retention-based).',
      options: [
        {
          flag: '--dead',
          description:
            'Remove leases whose owning process is dead (active/stopping, this host, pid not alive). Mutually exclusive with --status. Foreign-host leases are never touched.',
        },
        { flag: '--status <s>', description: 'stopped | stale (required unless --dead)' },
        { flag: '--older-than-ms <ms>', description: 'Retention threshold in milliseconds (required with --status)' },
        {
          flag: '--stale-ttl-ms <ms>',
          description: 'TTL for stale classification (used with --status stale; default 30m)',
        },
        { flag: '--apply', description: 'Actually delete (default: dry-run)' },
        { flag: '--json', description: 'Emit CAWS-native JSON to stdout' },
        DATA_OPTION,
      ],
    },
  ],
};

export const MESSAGE_COMMAND_META: GroupCommandMeta = {
  kind: 'group',
  name: 'message',
  description:
    'Inter-agent message channel (AGENT-MESSAGE-CHANNEL-001): send/poll directed messages between running sessions, addressed by session id, over .caws/messages.jsonl. Separate from the events audit chain; not authority — a message body is an unverified claim.',
  subcommands: [
    {
      kind: 'leaf',
      name: 'send',
      description:
        "Send a message to another session. Attributes the sender via this session's identity; refuses a recipient that is not live in the agent registry.",
      options: [
        { flag: '--to <session_id>', description: 'Recipient session id (required)' },
        { flag: '--text <message>', description: 'Message body (required, non-empty)' },
        {
          flag: '--allow-dead',
          description: 'Send even if the recipient is not live in the registry (escape hatch; default off)',
        },
        DATA_OPTION,
      ],
    },
    {
      kind: 'leaf',
      name: 'poll',
      description:
        'Pull the next undelivered message addressed to you. Deliver-once. Defaults --me to this session id.',
      options: [
        { flag: '--me <session_id>', description: 'Endpoint to poll for (default: this session id)' },
        {
          flag: '--wait <ms>',
          description: 'Block up to <ms> for a message before returning (long-poll; capped at 60000)',
        },
        { flag: '--peek', description: 'Show the next message without consuming it (no delivery record)' },
        { flag: '--json', description: 'Emit JSON ({message, waiting}) instead of human text' },
        DATA_OPTION,
      ],
    },
  ],
};

/**
 * The complete v11 command-surface metadata — the single authority for every
 * `.description()` / `.argument()` / `.option()` in register.ts.
 *
 * SLICE 3: all thirteen surface entries are populated and consumed by
 * register.ts — the five flat top-level commands (init/doctor/status/claim/
 * prepush) as LeafCommandMeta, and eight groups (scope/gates/evidence/events/
 * waiver/agents/specs/worktree). The lock test enforces full set-equality with
 * REGISTERED_COMMAND_GROUPS (L1), enum/value-list parity (L3), non-empty
 * descriptions (L4), and the global no-inline-strings invariant on register.ts
 * (L5).
 */
export const COMMAND_SURFACE_METADATA: readonly CommandMeta[] = Object.freeze([
  INIT_COMMAND_META,
  DOCTOR_COMMAND_META,
  STATUS_COMMAND_META,
  SCOPE_COMMAND_META,
  CLAIM_COMMAND_META,
  GATES_COMMAND_META,
  EVIDENCE_COMMAND_META,
  EVENTS_COMMAND_META,
  WAIVER_COMMAND_META,
  SPECS_COMMAND_META,
  WORKTREE_COMMAND_META,
  AGENTS_COMMAND_META,
  MESSAGE_COMMAND_META,
  PREPUSH_COMMAND_META,
]);
