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
    'Manage CAWS spec lifecycle (create/list/show/recover/retire-draft/close/archive/prune-archive/migrate)',
  subcommands: [
    {
      kind: 'leaf',
      name: 'create',
      argument: { name: 'id', required: true, description: 'Spec id to create' },
      description: 'Create a new spec in lifecycle_state: active.',
      options: [
        { flag: '--title <title>', description: 'Short spec title' },
        {
          flag: '--mode <mode>',
          description: 'Spec mode',
          allowedValues: SPEC_MODES,
        },
        {
          flag: '--risk-tier <n>',
          description: 'Risk tier',
          allowedValues: RISK_TIERS,
        },
        {
          flag: '--type <type>',
          description:
            'Removed v10 alias; use --mode <feature|refactor|fix|doc|chore> instead',
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
            'Recover an archived spec body via the event log + git show <blob_sha>. The body is NOT loaded from .caws/specs/.archive/ (which the post-CAWS-ARCHIVE-AS-TOMBSTONE-001 archive flow does not write).',
        },
      ],
    },
    {
      kind: 'leaf',
      name: 'recover',
      argument: { name: 'id', required: true, description: 'Archived spec id to recover' },
      description:
        'Recover an archived spec body via the event log + git show <blob_sha>. Topology-independent (works with merge commits, rebases, cherry-picks). Reads .caws/events.jsonl for the spec_archived event, validates the blob_sha, runs git show, prints to stdout (or --out <path>). Does NOT mutate .caws/specs/.',
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
      argument: { name: 'id', required: true, description: 'Closed spec id to archive' },
      description:
        'Archive a closed spec (tombstone, not a move): deletes the spec YAML and appends a recoverable spec_archived event carrying its blob_sha. Recover the body with caws specs show <id> --archived or caws specs recover <id>.',
      options: [
        {
          flag: '--reason <text>',
          description: 'Archive reason (advisory; the spec_archived schema does not carry it)',
        },
        DATA_OPTION,
      ],
    },
    {
      kind: 'leaf',
      name: 'prune-archive',
      description:
        'Migrate legacy .caws/specs/.archive/<id>.yaml bodies (CAWS-ARCHIVE-AS-TOMBSTONE-001). Dry-run by default — pass --apply to execute. Recoverable bodies (reachable via git log --follow) are removed from the working tree; unrecoverable bodies are QUARANTINED to .caws/specs/.archive/.unrecoverable/ (never silently deleted, no override flag). Emits one spec_archive_pruned event per id on --apply.',
      options: [
        { flag: '--apply', description: 'Execute the migration. Default is dry-run.' },
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
    'Manage CAWS worktrees (create/list/bind/destroy/merge/migrate-registry/repair-sparse). Worktrees are git worktrees bound to active specs.',
  subcommands: [
    {
      kind: 'leaf',
      name: 'create',
      argument: { name: 'name', required: true, description: 'Worktree name' },
      description: 'Create a new git worktree under .caws/worktrees/<name> bound to an active spec.',
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
      description: 'Repair bidirectional binding between a worktree and a spec (one-sided → bound).',
      options: [
        { flag: '--spec <id>', required: true, description: 'Spec id to bind the worktree to' },
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
  ],
};

/**
 * The complete v11 command-surface metadata — the single authority for every
 * `.description()` / `.argument()` / `.option()` in register.ts.
 *
 * SLICE 2: the `specs` and `worktree` groups are populated and consumed by
 * register.ts; the remaining 11 groups (init/doctor/status/scope/claim/gates/
 * evidence/events/waiver/agents/prepush) are added in slice 3, at which point
 * the lock test enforces full group-set equality with REGISTERED_COMMAND_GROUPS
 * and the global no-inline-strings invariant.
 */
export const COMMAND_SURFACE_METADATA: readonly CommandMeta[] = Object.freeze([
  SPECS_COMMAND_META,
  WORKTREE_COMMAND_META,
]);
