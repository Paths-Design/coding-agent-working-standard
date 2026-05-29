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
 * The complete v11 command-surface metadata — the single authority for every
 * `.description()` / `.argument()` / `.option()` in register.ts.
 *
 * SLICE 1: empty. Per-group entries are added (co-located in each
 * commands/<group>.ts and aggregated here) in slices 2-3, at which point the
 * lock test enforces group-set equality with REGISTERED_COMMAND_GROUPS and
 * register.ts is refactored to consume this array.
 */
export const COMMAND_SURFACE_METADATA: readonly CommandMeta[] = Object.freeze([]);
