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
  /** rotateEvents was called against a missing or empty events.jsonl.
   *  There is nothing to archive; the operation refuses. */
  EVENTS_ROTATE_NOTHING_TO_ROTATE: 'store.events.rotate.nothing_to_rotate',
  /** rotateEvents was called against a clean v11 chain (all entries have
   *  structured actor) without the explicit --allow-clean / allowClean
   *  flag. Friction guard to prevent casual log rotation that could hide
   *  evidence behind an archive boundary. */
  EVENTS_ROTATE_CLEAN_CHAIN_REQUIRES_ALLOW_CLEAN:
    'store.events.rotate.clean_chain_requires_allow_clean',
  /** rotateEvents was called against a log that has some unparseable
   *  lines alongside parseable ones. 'parseable_unverified' cannot
   *  honestly label such a chain; rotating would archive a partially
   *  corrupt log under a status that implies all lines parsed.
   *  Refuses by default. A future operator-facing escape hatch (e.g.
   *  --allow-corrupt-archive paired with a new schema enum value) may
   *  be added in a later slice if recovery from partial corruption is
   *  needed; not in v11.2 scope. The fully-unparseable case is
   *  handled separately (the planner refuses earlier with its own
   *  diagnostic). */
  EVENTS_ROTATE_PARTIAL_CORRUPTION:
    'store.events.rotate.partial_corruption',
  /** verify-archive recomputed the archive file's sha256 and it did not
   *  match the prior_file_digest committed in the most recent
   *  chain_rotated event. Tamper detection trip. */
  EVENTS_ARCHIVE_DIGEST_MISMATCH: 'store.events.archive.digest_mismatch',
  /** verify-archive recomputed the archive file's line count and it did
   *  not match the prior_line_count committed in the most recent
   *  chain_rotated event. */
  EVENTS_ARCHIVE_LINE_COUNT_MISMATCH:
    'store.events.archive.line_count_mismatch',
  /** events migrate --apply refused because v10 spec YAMLs were detected
   *  and --allow-partial-upgrade was not passed. The half-upgrade refusal
   *  is structural (see CAWS-MIGRATE-V10-EVENTS-001 A10 invariant). */
  EVENTS_MIGRATE_PARTIAL_UPGRADE_REFUSED:
    'store.events.migrate.partial_upgrade_refused',

  // ---- specs migration (CAWS-MIGRATE-V10-SPECS-001) -----------------------
  /** Scan failed to read .caws/specs/ directory. Structural — refuses
   *  rather than silently returning an empty scan (so apply-default
   *  bypass can't masquerade as "no v10 specs found"). */
  SPECS_MIGRATE_SCAN_FAILED: 'store.specs.migrate.scan_failed',
  /** A YAML file in .caws/specs/ could not be parsed during scan;
   *  recorded per-file but does not stop the scan. */
  SPECS_MIGRATE_PARSE_FAILED: 'store.specs.migrate.parse_failed',
  /** --apply (no --partial) refused because at least one spec hit a
   *  refused verdict; ZERO files were written. */
  SPECS_MIGRATE_REFUSALS_PRESENT: 'store.specs.migrate.refusals_present',
  /** A post-write validation of the transformer's output rejected the
   *  spec; the write for that file was rolled back. Other files in
   *  the batch are NOT rolled back per non_functional reliability rule. */
  SPECS_MIGRATE_POST_WRITE_VALIDATION_FAILED:
    'store.specs.migrate.post_write_validation_failed',
  /** Writing a migrated spec file to disk failed (atomic write rejected
   *  by filesystem). The other writes proceeded; the report records
   *  which files were skipped. */
  SPECS_MIGRATE_WRITE_FAILED: 'store.specs.migrate.write_failed',
  /** Writing the durable migration report to disk failed AFTER spec
   *  writes succeeded. The migrations are on disk; only the audit
   *  trail failed. Operator must investigate. */
  SPECS_MIGRATE_REPORT_WRITE_FAILED:
    'store.specs.migrate.report_write_failed',

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

  // ---- leases (MULTI-AGENT-ACTIVITY-REGISTRY-001) -------------------------
  /** Lease directory exists but is unreadable (permission denied, etc).
   *  Only failure mode for loadLeases — per-file failures are degraded
   *  to diagnostics inside an ok result. */
  LEASE_DIR_UNREADABLE: 'store.leases.dir_unreadable',
  /** Per-file lease load failure: JSON parse, not-an-object, filename/payload
   *  session_id mismatch, or unreadable file. The file is excluded from the
   *  returned registry but loadLeases still returns ok. */
  LEASE_FILE_MALFORMED: 'store.leases.file_malformed',
  /** Atomic lease write failed (directory creation, write, rename). */
  LEASE_WRITE_FAILED: 'store.leases.write_failed',
  /** session_id is empty, the literal 'unknown', or not a string. Refused
   *  at the I/O boundary by safeLeaseFilename. */
  LEASE_SESSION_ID_INVALID: 'store.leases.session_id_invalid',
  /** session_id contains characters outside the strict allowlist
   *  ^[A-Za-z0-9._:-]+$. Refused at the I/O boundary by safeLeaseFilename. */
  LEASE_SESSION_ID_UNSAFE: 'store.leases.session_id_unsafe',
  /** mark_stopped patch received but no prior lease exists for the session.
   *  Warning, not error — the store does NOT fabricate a historical record;
   *  the caller is told that the stop is a lifecycle mismatch no-op. */
  LEASE_STOP_NO_PRIOR_LEASE: 'store.leases.stop_no_prior_lease',
  /** Recipient endpoint id is empty or contains characters outside the strict
   *  allowlist ^[A-Za-z0-9._:-]+$. Refused before any message is written. */
  MESSAGES_RECIPIENT_INVALID: 'store.messages.recipient_invalid',
  /** Send refused because the recipient session is not live in the lease
   *  registry (no active lease within the heartbeat TTL). No message written —
   *  a send to a dead session would be indistinguishable from silence. */
  MESSAGES_RECIPIENT_NOT_LIVE: 'store.messages.recipient_not_live',
  /** Append to messages.jsonl failed (directory creation or write). */
  MESSAGES_APPEND_FAILED: 'store.messages.append_failed',
  /** messages.jsonl exists but is unreadable (permission denied, etc). */
  MESSAGES_LOG_UNREADABLE: 'store.messages.log_unreadable',
  /** A single line in messages.jsonl is not valid JSON. Skipped with a
   *  diagnostic; never fatal — a corrupt chat line is not an integrity failure. */
  MESSAGES_LINE_MALFORMED: 'store.messages.line_malformed',
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
  'store.leases.',
  'store.messages.',
] as const;
