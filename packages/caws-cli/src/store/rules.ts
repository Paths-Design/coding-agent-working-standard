// Stable rule identifiers for the Node-only store layer.
//
// These ids are public contract for shell-side diagnostics. The store is
// the only place outside the kernel that emits Diagnostics under the
// `kernel/diagnostics` authority — store-specific authority is reserved
// for future. Until then, store rule ids carry the `store.*` namespace.

export const STORE_RULES = {
  // ---- repo root resolution -----------------------------------------------
  REPO_ROOT_NOT_A_GIT_REPO: 'store.repo_root.not_a_git_repo',
  REPO_ROOT_GIT_INVOCATION_FAILED: 'store.repo_root.git_invocation_failed',
  REPO_ROOT_CAWS_DIR_MISSING: 'store.repo_root.caws_dir_missing',

  // ---- file I/O ------------------------------------------------------------
  /** Distinguishable so callers can decide missing → Ok([]) vs missing → Err. */
  READ_MISSING_FILE: 'store.read.missing_file',
  READ_NOT_A_FILE: 'store.read.not_a_file',
  READ_IO_FAILED: 'store.read.io_failed',
  /** YAML parse failure. */
  READ_YAML_INVALID: 'store.read.yaml_invalid',
  /** JSON parse failure. */
  READ_JSON_INVALID: 'store.read.json_invalid',

  // ---- atomic write --------------------------------------------------------
  WRITE_IO_FAILED: 'store.write.io_failed',
  /** Patch references a registry entry that does not exist (rebind/takeover). */
  WRITE_PATCH_TARGET_MISSING: 'store.write.patch_target_missing',

  // ---- specs ---------------------------------------------------------------
  /** A single spec file failed validation; the load itself still succeeds. */
  SPECS_SPEC_INVALID: 'store.specs.spec_invalid',
  /** A non-spec file landed in .caws/specs/ (e.g., README.md). Soft skip. */
  SPECS_NON_YAML_SKIPPED: 'store.specs.non_yaml_skipped',
  /** Two spec files declared the same spec id. */
  SPECS_DUPLICATE_ID: 'store.specs.duplicate_id',

  // ---- registries ---------------------------------------------------------
  /** worktrees.json or agents.json parsed but is not a plain object. */
  REGISTRY_NOT_OBJECT: 'store.registry.not_object',

  // ---- waivers ------------------------------------------------------------
  /** A single waiver file failed validation; the load itself still succeeds. */
  WAIVERS_FILE_INVALID: 'store.waivers.file_invalid',
  /** Non-YAML file in .caws/waivers/. Soft skip. */
  WAIVERS_NON_YAML_SKIPPED: 'store.waivers.non_yaml_skipped',
  /** Two waiver files declared the same waiver id. */
  WAIVERS_DUPLICATE_ID: 'store.waivers.duplicate_id',
  /** Filename did not match the waiver id. */
  WAIVERS_FILENAME_MISMATCH: 'store.waivers.filename_mismatch',
  /** Caller tried to create a waiver with an id that already exists. */
  WAIVERS_ALREADY_EXISTS: 'store.waivers.already_exists',
  /** Caller tried to revoke a waiver that does not exist. */
  WAIVERS_NOT_FOUND: 'store.waivers.not_found',

  // ---- events -------------------------------------------------------------
  /** Interior (non-trailing) malformed JSON line in events.jsonl. */
  EVENTS_INTERIOR_MALFORMED_LINE: 'store.events.interior_malformed_line',
  /** Trailing partial line (crash-recovery). Tolerated; emitted as warning. */
  EVENTS_TRAILING_PARTIAL_LINE: 'store.events.trailing_partial_line',
  /** Event line parsed as JSON but did not pass validateChainedEvent. */
  EVENTS_INVALID_EVENT_SHAPE: 'store.events.invalid_event_shape',
  /** Failed to acquire the events.jsonl lock after the bounded retry. */
  EVENTS_LOCK_CONTENTION: 'store.events.lock_contention',
  /** prepareAppend rejected the body. Carries the kernel diagnostics. */
  EVENTS_PREPARE_APPEND_REJECTED: 'store.events.prepare_append_rejected',

  // ---- init (slice 7b) ----------------------------------------------------
  /** A legacy file (e.g., working-spec.yaml) blocks vNext init. */
  INIT_LEGACY_RESIDUE: 'store.init.legacy_residue',
  /** init seeded a default policy that did not pass kernel validation. */
  INIT_DEFAULT_POLICY_INVALID: 'store.init.default_policy_invalid',

  // ---- lifecycle mutation substrate (LIFECYCLE-MUTATION-001) -------------
  /** Failed to acquire the global .caws/state.lock after bounded retry. */
  LIFECYCLE_LOCK_CONTENTION: 'store.lifecycle.lock_contention',
  /** Plan validation rejected the proposed transaction before any write. */
  LIFECYCLE_PLAN_REJECTED: 'store.lifecycle.plan_rejected',
  /** A planned file write failed; the transaction aborted before event append. */
  LIFECYCLE_WRITE_FAILED: 'store.lifecycle.write_failed',
  /** State writes succeeded but event append failed; rollback succeeded. */
  LIFECYCLE_PARTIAL_FAILURE_RECOVERED:
    'store.lifecycle.partial_failure_recovered',
  /** State writes succeeded, event append failed, AND rollback also failed.
   *  Caller MUST handle the recovery instruction in the diagnostic data. */
  LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED:
    'store.lifecycle.partial_failure_unrecovered',
  /** yaml-patch refused an ambiguous mutation (e.g., duplicate top-level key,
   *  or a flow-style mapping at the target location). */
  YAML_PATCH_AMBIGUOUS: 'store.yaml_patch.ambiguous',
  /** yaml-patch refused because the target key was not found in the document. */
  YAML_PATCH_KEY_NOT_FOUND: 'store.yaml_patch.key_not_found',
} as const;

export type StoreRule = (typeof STORE_RULES)[keyof typeof STORE_RULES];

export const STORE_RULE_PREFIXES = [
  'store.repo_root.',
  'store.read.',
  'store.write.',
  'store.specs.',
  'store.waivers.',
  'store.registry.',
  'store.events.',
  'store.init.',
] as const;
