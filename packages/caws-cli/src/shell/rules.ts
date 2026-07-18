// Stable rule identifiers for shell-layer diagnostics.
//
// Shell rules live under the `shell.*` namespace. They are emitted ONLY for
// shell-specific concerns (CLI invocation, session resolution, command-line
// argument errors). Anything kernel-authoritative (scope decisions, doctor
// findings, evidence validation) uses the kernel's own rule ids — the shell
// never invents a parallel naming for those.

export const SHELL_RULE_PREFIXES = {
  session: 'shell.session',
  binding: 'shell.binding',
  command: 'shell.command',
  gates: 'shell.gates',
  waiver: 'shell.waiver',
} as const;

export const SHELL_RULES = {
  // Session identity resolution.
  SESSION_RESOLVED_FROM_CLAUDE_ENV: 'shell.session.resolved_from_claude_env',
  // CAWS-SESSION-ID-AGENT-BASH-PROPAGATION-001: CLAUDE_CODE_SESSION_ID is the
  // harness session UUID exported by Claude Code into EVERY tool subprocess
  // (including agent-Bash), so it resolves the agent-Bash write path
  // deterministically without falling through to the racy
  // tmp/.caller-session.json pointer. Authority tier 1.5.
  SESSION_RESOLVED_FROM_CLAUDE_CODE_ENV:
    'shell.session.resolved_from_claude_code_env',
  SESSION_RESOLVED_FROM_HOOK_ENV: 'shell.session.resolved_from_hook_env',
  SESSION_RESOLVED_FROM_CAPSULE: 'shell.session.resolved_from_capsule',
  SESSION_RESOLVED_FROM_CURSOR_ENV: 'shell.session.resolved_from_cursor_env',
  SESSION_NO_STABLE_IDENTITY: 'shell.session.no_stable_identity',
  // CAWS-SESSION-ID-DURABLE-HOOK-ENVELOPE-001: priority 2.5 between
  // hook_env and capsule. Bridges HOOK_SESSION_ID across agent-Bash
  // invocations where the env var doesn't propagate.
  SESSION_RESOLVED_FROM_DURABLE_ENVELOPE:
    'shell.session.resolved_from_durable_envelope',
  /** Refusal: two or more fresh durable envelopes match the current
   *  repo_root. The resolver cannot pick a winner; the operator must
   *  disambiguate (set CLAUDE_SESSION_ID, or route through a hook
   *  context that sets HOOK_SESSION_ID, or remove stale tmp/<id>/
   *  directories). NEVER newest-wins. */
  SESSION_DURABLE_ENVELOPE_AMBIGUOUS:
    'shell.session.durable_envelope_ambiguous',
  /** Non-fatal warning: a tmp/<id>/.session-envelope.json file was
   *  present but unreadable or unparseable. The envelope is skipped
   *  as a candidate; resolution continues with remaining envelopes
   *  and capsule fallback. */
  SESSION_DURABLE_ENVELOPE_MALFORMED:
    'shell.session.durable_envelope_malformed',
  SESSION_CAPSULE_MINTED: 'shell.session.capsule_minted',
  SESSION_CAPSULE_INVALID: 'shell.session.capsule_invalid',
  SESSION_CAPSULE_WRITE_FAILED: 'shell.session.capsule_write_failed',
  /** Non-fatal warning: mintCapsule could not delete a pre-existing
   *  capsule for the same worktree_root. The new capsule was still
   *  written; the resolver may surface multiple capsules per root on
   *  the next read (existing buggy state). */
  SESSION_CAPSULE_CLEANUP_FAILED: 'shell.session.capsule_cleanup_failed',

  // cwd → worktree binding resolution.
  BINDING_CWD_OUTSIDE_REPO: 'shell.binding.cwd_outside_repo',
  BINDING_WORKTREE_NOT_FOUND_IN_REGISTRY:
    'shell.binding.worktree_not_found_in_registry',
  BINDING_NO_SPEC_FOR_WORKTREE: 'shell.binding.no_spec_for_worktree',
  BINDING_UNBOUND_CWD: 'shell.binding.unbound_cwd',

  // Command argument / input errors.
  COMMAND_INVALID_PATH_ARGUMENT: 'shell.command.invalid_path_argument',
  COMMAND_PRE_CHAINED_EVENT_REFUSED: 'shell.command.pre_chained_event_refused',
  COMMAND_INVALID_EVIDENCE_TYPE: 'shell.command.invalid_evidence_type',
  COMMAND_MISSING_SPEC_ID: 'shell.command.missing_spec_id',

  // gates report JSON contract.
  GATES_REPORT_NOT_JSON: 'shell.gates.report_not_json',
  GATES_REPORT_INVALID_SHAPE: 'shell.gates.report_invalid_shape',
  GATES_POLICY_REQUIRED: 'shell.gates.policy_required',

  // waiver command surface.
  WAIVER_MISSING_ID: 'shell.waiver.missing_id',
  WAIVER_NOT_FOUND: 'shell.waiver.not_found',
  WAIVER_DUPLICATE: 'shell.waiver.duplicate',
  WAIVER_INVALID_INPUT: 'shell.waiver.invalid_input',
  WAIVER_ALREADY_REVOKED: 'shell.waiver.already_revoked',
  WAIVER_WRITE_FAILED: 'shell.waiver.write_failed',

  // reprieve command surface (CAWS-GUARD-REPRIEVE-SESSION-SCOPED-001).
  REPRIEVE_UNKNOWN_SURFACE: 'shell.reprieve.unknown_surface',
  REPRIEVE_NO_SESSION: 'shell.reprieve.no_session',
  REPRIEVE_INVALID_EXPIRY: 'shell.reprieve.invalid_expiry',
  REPRIEVE_MISSING_REQUIRED: 'shell.reprieve.missing_required',
} as const;

export type ShellRule = (typeof SHELL_RULES)[keyof typeof SHELL_RULES];
