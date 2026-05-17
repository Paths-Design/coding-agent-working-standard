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
  SESSION_RESOLVED_FROM_CAPSULE: 'shell.session.resolved_from_capsule',
  SESSION_RESOLVED_FROM_CURSOR_ENV: 'shell.session.resolved_from_cursor_env',
  SESSION_NO_STABLE_IDENTITY: 'shell.session.no_stable_identity',
  SESSION_CAPSULE_MINTED: 'shell.session.capsule_minted',
  SESSION_CAPSULE_INVALID: 'shell.session.capsule_invalid',
  SESSION_CAPSULE_WRITE_FAILED: 'shell.session.capsule_write_failed',

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

  // quality-gates subprocess + JSON contract.
  GATES_SUBPROCESS_NOT_FOUND: 'shell.gates.subprocess_not_found',
  GATES_SUBPROCESS_FAILED: 'shell.gates.subprocess_failed',
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
} as const;

export type ShellRule = (typeof SHELL_RULES)[keyof typeof SHELL_RULES];
