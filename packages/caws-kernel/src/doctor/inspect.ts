// Pure project-state inspection.
//
// inspectProjectState consumes a state snapshot and returns a DoctorReport.
// The function reuses existing kernel primitives — it never reimplements
// rules already enforced by spec, policy, scope, evidence, or worktree.

import type { Diagnostic } from '../diagnostics/types';
import { verifyChain } from '../evidence/verify';
import { deriveBindingState } from '../worktree/binding';
import { isStaleByTTL } from '../worktree/freshness';
import { isErr } from '../result/construct';
import { DOCTOR_RULES } from './rules';
import type {
  DoctorFinding,
  DoctorInput,
  DoctorReport,
  FindingSeverity,
  TemplateCheck,
} from './types';

const DEFAULT_STALE_AGENT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_UNBOUND_ACTIVE_THRESHOLD_MS = 60 * 60 * 1000;
const DEFAULT_PRIOR_OWNERS_THRESHOLD = 25;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function finding(
  rule: string,
  severity: FindingSeverity,
  message: string,
  extra: {
    subject?: string;
    narrowRepair?: string;
    data?: Record<string, unknown>;
  } = {}
): DoctorFinding {
  return {
    rule,
    authority: 'kernel/diagnostics',
    severity,
    message,
    ...(extra.subject !== undefined ? { subject: extra.subject } : {}),
    ...(extra.narrowRepair !== undefined ? { narrowRepair: extra.narrowRepair } : {}),
    ...(extra.data !== undefined ? { data: extra.data } : {}),
  };
}

function summarize(findings: readonly DoctorFinding[]): DoctorReport {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const f of findings) {
    if (f.severity === 'error') errors++;
    else if (f.severity === 'warning') warnings++;
    else infos++;
  }
  return {
    findings,
    summary: { errors, warnings, infos },
    clean: errors === 0,
  };
}

// ---------------------------------------------------------------------------
// inspectProjectState
// ---------------------------------------------------------------------------

export function inspectProjectState(input: DoctorInput): DoctorReport {
  // Programmer-input validation. The kernel diagnoses state, but it cannot
  // diagnose state that was never supplied to it.
  if (!Array.isArray(input.specs)) {
    throw new TypeError('inspectProjectState: input.specs must be an array.');
  }
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new TypeError('inspectProjectState: input.now must be a valid Date.');
  }

  const findings: DoctorFinding[] = [];
  const specs = input.specs;
  const registry = input.worktrees ?? {};
  const agents = input.agents ?? {};
  const now = input.now;
  const staleAgentTtlMs = input.staleAgentTtlMs ?? DEFAULT_STALE_AGENT_TTL_MS;
  const unboundActiveThresholdMs =
    input.unboundActiveThresholdMs ?? DEFAULT_UNBOUND_ACTIVE_THRESHOLD_MS;
  const priorOwnersThreshold =
    input.priorOwnersGrowthThreshold ?? DEFAULT_PRIOR_OWNERS_THRESHOLD;

  // -------------------------------------------------------------------------
  // 1. Spec lifecycle: active+unbound, thresholded.
  // -------------------------------------------------------------------------

  // Build a quick "is this spec id referenced by some registry entry" lookup.
  const registrySpecIds = new Set<string>();
  for (const [, record] of Object.entries(registry)) {
    if (typeof record?.specId === 'string' && record.specId.length > 0) {
      registrySpecIds.add(record.specId);
    }
  }

  for (const spec of specs) {
    if (spec.lifecycle_state !== 'active') continue;
    const hasRegistryBinding = registrySpecIds.has(spec.id);
    const hasSpecPointer =
      typeof spec.worktree === 'string' && spec.worktree.length > 0;
    if (hasRegistryBinding || hasSpecPointer) {
      // Either side claims a binding — binding-integrity checks below handle
      // the asymmetric and orphan cases. unbound_active only fires when
      // BOTH sides are silent.
      continue;
    }

    if (typeof spec.updated_at !== 'string' || spec.updated_at.length === 0) {
      findings.push(
        finding(
          DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_TIMESTAMP_MISSING,
          'info',
          `Spec ${spec.id} is active but has no bound worktree and no updated_at to evaluate staleness against.`,
          {
            subject: spec.id,
            narrowRepair: 'Set updated_at on the spec or bind a worktree to it.',
            data: { spec_id: spec.id, lifecycle_state: spec.lifecycle_state },
          }
        )
      );
      continue;
    }

    const updatedAtMs = Date.parse(spec.updated_at);
    if (Number.isNaN(updatedAtMs)) {
      findings.push(
        finding(
          DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_TIMESTAMP_MISSING,
          'info',
          `Spec ${spec.id} is active but has no bound worktree and its updated_at could not be parsed.`,
          {
            subject: spec.id,
            data: { spec_id: spec.id, updated_at: spec.updated_at },
          }
        )
      );
      continue;
    }

    const ageMs = now.getTime() - updatedAtMs;
    if (ageMs > unboundActiveThresholdMs) {
      findings.push(
        finding(
          DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_STALE,
          'warning',
          `Active spec ${spec.id} has no bound worktree and has exceeded the unbound-active threshold.`,
          {
            subject: spec.id,
            narrowRepair: `Bind a worktree (\`caws worktree create <name> --spec ${spec.id}\`) or close the spec.`,
            data: {
              spec_id: spec.id,
              age_ms: ageMs,
              threshold_ms: unboundActiveThresholdMs,
              updated_at: spec.updated_at,
            },
          }
        )
      );
    }
  }

  // -------------------------------------------------------------------------
  // 2. Binding integrity (one-sided, registry-missing-spec,
  //    spec-missing-registry).
  // -------------------------------------------------------------------------

  const specsById = new Map<string, (typeof specs)[number]>();
  for (const s of specs) specsById.set(s.id, s);

  // 2a. Per worktree name in the registry, derive state vs the spec it
  //     claims, and report.
  for (const [worktreeName, record] of Object.entries(registry)) {
    const registrySpecId = record?.specId;
    if (!registrySpecId) continue;
    const spec = specsById.get(registrySpecId);
    if (!spec) {
      findings.push(
        finding(
          DOCTOR_RULES.BINDING_REGISTRY_MISSING_SPEC,
          'error',
          `Worktree "${worktreeName}" registry binds spec ${registrySpecId}, but no such spec is loaded.`,
          {
            subject: worktreeName,
            narrowRepair: `Restore the spec file, or run \`caws worktree destroy ${worktreeName}\`.`,
            data: { worktree_name: worktreeName, registry_spec_id: registrySpecId },
          }
        )
      );
      continue;
    }
    const state = deriveBindingState(spec, registry, worktreeName);
    if (state.kind === 'one_sided') {
      findings.push(
        finding(
          DOCTOR_RULES.BINDING_ONE_SIDED,
          'error',
          `Worktree "${worktreeName}" and spec ${spec.id} have a one-sided binding.`,
          {
            subject: worktreeName,
            narrowRepair: state.detail.specHasWorktree
              ? `Update worktrees.json[${worktreeName}].specId to ${spec.id}.`
              : `Set worktree: ${worktreeName} on spec ${spec.id}.`,
            data: {
              worktree_name: worktreeName,
              spec_id: spec.id,
              ...state.detail,
            },
          }
        )
      );
    } else if (state.kind === 'bound' && spec.lifecycle_state !== 'active') {
      // Bidirectional binding to a non-governable spec is contradictory
      // authority state. The worktree kernel refuses NEW non-governable
      // binds; doctor surfaces legacy/corrupt instances.
      findings.push(
        finding(
          DOCTOR_RULES.BINDING_SPEC_NOT_GOVERNABLE,
          'error',
          `Worktree "${worktreeName}" is bound to spec ${spec.id}, but that spec is in lifecycle_state="${spec.lifecycle_state}" and cannot authorize governed writes.`,
          {
            subject: worktreeName,
            narrowRepair: `Destroy or rebind the worktree; closed/archived/draft specs cannot authorize governed writes. Run \`caws worktree destroy ${worktreeName}\` or \`caws worktree bind ${worktreeName} --spec <active-id>\`.`,
            data: {
              worktree_name: worktreeName,
              spec_id: spec.id,
              lifecycle_state: spec.lifecycle_state,
            },
          }
        )
      );
    }
  }

  // 2b. Per spec, if spec.worktree is set but the registry has no matching
  //     entry pointing back, flag the orphan.
  for (const spec of specs) {
    const worktreeName = spec.worktree;
    if (!worktreeName) continue;
    const record = registry[worktreeName];
    if (!record) {
      findings.push(
        finding(
          DOCTOR_RULES.BINDING_SPEC_MISSING_REGISTRY,
          'error',
          `Spec ${spec.id} points to worktree "${worktreeName}", but no registry entry exists.`,
          {
            subject: spec.id,
            narrowRepair: `Remove the worktree field on ${spec.id} or recreate the worktree.`,
            data: { spec_id: spec.id, worktree_name: worktreeName },
          }
        )
      );
      continue;
    }
    // Record exists. Three sub-cases:
    //   (i)  record has no specId          → spec→registry one-sided
    //   (ii) record.specId === spec.id     → bidirectional, handled in 2a
    //   (iii) record.specId !== spec.id    → foreign binding from spec's view
    const state = deriveBindingState(spec, registry, worktreeName);
    if (state.kind === 'one_sided' && !record.specId) {
      findings.push(
        finding(
          DOCTOR_RULES.BINDING_ONE_SIDED,
          'error',
          `Spec ${spec.id} points to worktree "${worktreeName}", but the registry entry has no specId.`,
          {
            subject: spec.id,
            narrowRepair: `Set worktrees.json[${worktreeName}].specId = ${spec.id}.`,
            data: {
              spec_id: spec.id,
              worktree_name: worktreeName,
              ...state.detail,
            },
          }
        )
      );
    } else if (
      state.kind === 'one_sided' &&
      typeof record.specId === 'string' &&
      record.specId.length > 0 &&
      record.specId !== spec.id
    ) {
      // Spec claims a worktree name that is held by a different spec id.
      // The repair side depends on intent and is the shell's decision.
      findings.push(
        finding(
          DOCTOR_RULES.BINDING_SPEC_POINTS_TO_FOREIGN_BINDING,
          'error',
          `Spec ${spec.id} points to worktree "${worktreeName}", but the registry binds that worktree to spec ${record.specId}.`,
          {
            subject: spec.id,
            narrowRepair: `Either clear worktree on spec ${spec.id}, or rebind worktrees.json[${worktreeName}].specId from ${record.specId} to ${spec.id}.`,
            data: {
              spec_id: spec.id,
              worktree_name: worktreeName,
              registry_spec_id: record.specId,
            },
          }
        )
      );
    }
  }

  // -------------------------------------------------------------------------
  // 3. Agent freshness (display-only).
  // -------------------------------------------------------------------------

  for (const [sessionId, record] of Object.entries(agents)) {
    if (isStaleByTTL(record, staleAgentTtlMs, now)) {
      findings.push(
        finding(
          DOCTOR_RULES.AGENT_STALE_DISPLAY_ONLY,
          'warning',
          `Agent ${sessionId} has not heartbeated within the TTL — display only; stale heartbeat is NOT abandonment.`,
          {
            subject: sessionId,
            narrowRepair:
              'No automatic action. Ownership decisions still consult worktrees.json owner.',
            data: {
              session_id: sessionId,
              last_active: record.last_active,
              ttl_ms: staleAgentTtlMs,
            },
          }
        )
      );
    }
  }

  // -------------------------------------------------------------------------
  // 4. Ownership hygiene: prior_owners growth.
  // -------------------------------------------------------------------------

  for (const [worktreeName, record] of Object.entries(registry)) {
    const priorOwners = record?.prior_owners ?? [];
    if (priorOwners.length > priorOwnersThreshold) {
      findings.push(
        finding(
          DOCTOR_RULES.OWNERSHIP_PRIOR_OWNER_GROWTH,
          'warning',
          `Worktree "${worktreeName}" has ${priorOwners.length} prior owners (above hygiene threshold ${priorOwnersThreshold}).`,
          {
            subject: worktreeName,
            narrowRepair:
              'Review whether this worktree is changing hands too often. Kernel does not truncate prior_owners.',
            data: {
              worktree_name: worktreeName,
              prior_owner_count: priorOwners.length,
              threshold: priorOwnersThreshold,
            },
          }
        )
      );
    }
  }

  // -------------------------------------------------------------------------
  // 5. Event chain validity (delegates to evidence/verifyChain).
  // -------------------------------------------------------------------------

  if (input.events && input.events.length > 0) {
    const result = verifyChain(input.events);
    if (isErr(result)) {
      // Surface the first verifyChain rule + count. The shell can fetch full
      // detail by re-running verifyChain itself.
      const firstRule = result.errors[0]?.rule ?? 'unknown';
      findings.push(
        finding(
          DOCTOR_RULES.EVENT_CHAIN_INVALID,
          'error',
          `Event chain failed verification with ${result.errors.length} violation(s); first rule: ${firstRule}.`,
          {
            subject: '.caws/events.jsonl',
            narrowRepair:
              'Inspect the events log; the chain may have been tampered with or written by a non-kernel writer.',
            data: {
              first_rule: firstRule,
              violation_count: result.errors.length,
            },
          }
        )
      );
    }
  }

  // -------------------------------------------------------------------------
  // 6. Policy.
  // -------------------------------------------------------------------------

  if (!input.policy) {
    findings.push(
      finding(
        DOCTOR_RULES.POLICY_MISSING,
        'error',
        'No policy.yaml is loaded. Budgets and gate configuration are undefined.',
        {
          subject: '.caws/policy.yaml',
          narrowRepair: 'Run `caws init` or supply a `.caws/policy.yaml`.',
        }
      )
    );
  } else if (input.policyWarnings && input.policyWarnings.length > 0) {
    for (const w of input.policyWarnings) {
      findings.push(
        finding(
          DOCTOR_RULES.POLICY_VALID_WITH_WARNINGS,
          'warning',
          w.message,
          {
            ...(w.subject !== undefined ? { subject: w.subject } : {}),
            ...(w.narrowRepair !== undefined ? { narrowRepair: w.narrowRepair } : {}),
            data: { source_rule: w.rule, ...(w.data ?? {}) },
          }
        )
      );
    }
  }

  // -------------------------------------------------------------------------
  // 7. Templates (severity preserved).
  // -------------------------------------------------------------------------

  if (input.templates && input.templates.length > 0) {
    for (const t of input.templates) {
      pushTemplateDiagnostics(findings, t, t.errors, DOCTOR_RULES.TEMPLATE_DRIFT);
      if (t.warnings && t.warnings.length > 0) {
        pushTemplateDiagnostics(
          findings,
          t,
          t.warnings,
          DOCTOR_RULES.TEMPLATE_WARNING
        );
      }
    }
  }

  return summarize(findings);
}

function pushTemplateDiagnostics(
  out: DoctorFinding[],
  template: TemplateCheck,
  diags: readonly Diagnostic[],
  rule: string
): void {
  for (const d of diags) {
    // Preserve incoming severity; default to error for errors[] and warning
    // for warnings[].
    const inheritedSeverity: FindingSeverity =
      d.severity ?? (rule === DOCTOR_RULES.TEMPLATE_DRIFT ? 'error' : 'warning');
    out.push(
      finding(rule, inheritedSeverity, d.message, {
        subject: template.path ?? template.template_id,
        ...(d.narrowRepair !== undefined ? { narrowRepair: d.narrowRepair } : {}),
        data: {
          template_id: template.template_id,
          source_rule: d.rule,
          source_authority: d.authority,
          ...(d.data ?? {}),
        },
      })
    );
  }
}
