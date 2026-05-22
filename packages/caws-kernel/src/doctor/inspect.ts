// Pure project-state inspection.
//
// inspectProjectState consumes a state snapshot and returns a DoctorReport.
// The function reuses existing kernel primitives — it never reimplements
// rules already enforced by spec, policy, scope, evidence, or worktree.

import type { Diagnostic } from '../diagnostics/types';
import { verifyChain } from '../evidence/verify';
import { CRITICAL_GATES, RISKY_ROOT_FILES } from '../policy/rules';
import { waiverEffectiveness } from '../waiver/applicability';
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
            narrowRepair: `Bind a worktree to ${spec.id}, or close the spec. (v11.0.0 does not ship worktree lifecycle commands; create externally and register in worktrees.json, or pin to caws-cli@^10.2.x.)`,
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
            narrowRepair: `Restore the spec file, or remove the worktree entry from .caws/worktrees.json. (v11.0.0 does not ship worktree lifecycle commands; pin to caws-cli@^10.2.x for \`caws worktree destroy ${worktreeName}\`.)`,
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
            narrowRepair: `Destroy or rebind the worktree; closed/archived/draft specs cannot authorize governed writes. (v11.0.0 does not ship worktree lifecycle commands; remove the worktree entry from .caws/worktrees.json directly, or pin to caws-cli@^10.2.x.)`,
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
  //
  //     WORKTREE-DOCTOR-HALF-STATE-FOLLOWUP-001 H4 enrichment (replaces the
  //     prior slice's git_worktree_present field):
  //
  //     The H4 case is precisely "spec claims worktree X, registry has no
  //     entry for X." X is therefore by construction NOT a key in the
  //     registry-keyed `worktreeDirByName` map. Consulting that map
  //     collapsed "the canonical path was observably absent" and "we
  //     never observed the canonical path" into the same `false` value.
  //
  //     The fix is to consult a SPEC-CLAIM-keyed map populated from
  //     `spec.worktree` fields (`specClaimedWorktreeDirByName`). When the
  //     spec-claimed name is a key in that map, the boolean value is the
  //     observed presence. When it is NOT a key, we have no observation —
  //     so the data payload says so explicitly with
  //     `canonical_dir_observed: false` and omits `canonical_dir_present`.
  //
  //     The enrichment is an observable filesystem fact about the
  //     canonical path, NOT provenance proof that destroyWorktree caused
  //     the state. Downstream authority logic (the next slice) decides
  //     what to do with the signal.
  const worktreeDirByName = input.filesystem?.worktreeDirByName;
  const specClaimedWorktreeDirByName = input.filesystem?.specClaimedWorktreeDirByName;
  for (const spec of specs) {
    const worktreeName = spec.worktree;
    if (!worktreeName) continue;
    const record = registry[worktreeName];
    if (!record) {
      const data: Record<string, unknown> = {
        spec_id: spec.id,
        worktree_name: worktreeName,
      };
      if (
        specClaimedWorktreeDirByName !== undefined &&
        Object.prototype.hasOwnProperty.call(specClaimedWorktreeDirByName, worktreeName)
      ) {
        // H4 enrichment: we have an observation for this spec-claimed name.
        data.canonical_dir_observed = true;
        data.canonical_dir_present = specClaimedWorktreeDirByName[worktreeName] === true;
      } else {
        // No observation available (store layer did not stat this name,
        // or specClaimedWorktreeDirByName itself is absent). Do NOT
        // synthesize a `canonical_dir_present` value; surface the gap.
        data.canonical_dir_observed = false;
      }
      findings.push(
        finding(
          DOCTOR_RULES.BINDING_SPEC_MISSING_REGISTRY,
          'error',
          `Spec ${spec.id} points to worktree "${worktreeName}", but no registry entry exists.`,
          {
            subject: spec.id,
            narrowRepair: `Remove the worktree field on ${spec.id} or recreate the worktree.`,
            data,
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
  // 2c. WORKTREE-DOCTOR-HALF-STATE-001 H1: ghost registry entry.
  //
  // For each registry entry, when filesystem observation is available AND
  // git worktree observation is available: if the canonical worktree dir
  // is absent on disk AND the path is not present in
  // `git worktree list --porcelain`, the entry is a ghost. The registry
  // claims a worktree that is physically gone.
  //
  // Skips silently when either input is unavailable (preserves the
  // "non-fatal git observation" invariant — incomplete observability
  // is better than fail-closed).
  // -------------------------------------------------------------------------

  const gitWorktrees = input.gitWorktrees;
  if (worktreeDirByName !== undefined && gitWorktrees !== undefined) {
    const gitWorktreePaths = new Set<string>(gitWorktrees.map((w) => w.path));
    for (const [worktreeName, record] of Object.entries(registry)) {
      // Defensive: skip entries that aren't plain object records. A
      // legacy v10.2-format worktrees.json wraps entries inside a
      // top-level `{ version: 1, worktrees: { ... } }` envelope; the
      // v11 loader returns the outer object as-is, which means
      // Object.entries surfaces `version: 1` and `worktrees: { ... }`
      // as bogus "names". Pre-existing BINDING_* rules dodged this
      // because they gate on `record?.specId` being truthy. H1 has
      // no specId gate (legitimate ghosts can lack one), so we filter
      // explicitly on record shape. Real ghosts always have an
      // object-shaped record.
      if (
        record === null ||
        typeof record !== 'object' ||
        Array.isArray(record)
      ) {
        continue;
      }
      // Skip entries where the dir IS present — those are not ghosts.
      if (worktreeDirByName[worktreeName] === true) continue;
      // Cross-check git porcelain output by registry.path (preferred) or
      // by canonical-name match against the entry's recorded path. The
      // store also passes worktreeDirByName under the canonical path
      // computation, so the canonical-path case is already covered by
      // the dir-presence check above. If `record.path` is set, also
      // accept that as evidence the worktree exists (just at a
      // non-canonical location).
      const recordPath = record?.path;
      if (typeof recordPath === 'string' && gitWorktreePaths.has(recordPath)) {
        continue;
      }
      findings.push(
        finding(
          DOCTOR_RULES.WORKTREE_GHOST_REGISTRY_ENTRY,
          'error',
          `Worktree "${worktreeName}" has a registry entry but no backing git worktree directory.`,
          {
            subject: worktreeName,
            narrowRepair:
              'Remove the entry from .caws/worktrees.json (the worktree was destroyed outside CAWS, or its creation never completed).',
            data: {
              worktree_name: worktreeName,
              spec_id: record?.specId,
              recorded_path: recordPath,
              canonical_dir_present: false,
              git_worktree_listed: false,
            },
          }
        )
      );
    }
  }

  // -------------------------------------------------------------------------
  // 2d. WORKTREE-DOCTOR-HALF-STATE-001 H5: 3-way registry/spec
  //     contradiction (the bindWorktreeRepair post-fault class).
  //
  //     For each registry entry where `specId === idB` and spec_B is
  //     loaded but lacks `worktree:`, search for another spec_A that
  //     claims `worktree: <name>`. When found, emit the unified
  //     3-way finding. This rule fires IN ADDITION TO any per-perspective
  //     findings (BINDING_ONE_SIDED from §2a, BINDING_SPEC_POINTS_TO_FOREIGN_BINDING
  //     from §2b) — it is the only finding that names all three
  //     contradictory facts in one place and carries the doctrine-pointer
  //     repair text.
  //
  //     H5 doctor-UX rule (locked by spec invariant): the repair string
  //     MUST NOT contain a shell command. It is intentionally
  //     non-actionable. Picking a winner requires authority policy from
  //     WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001.
  // -------------------------------------------------------------------------

  const specsByWorktreeClaim = new Map<string, Array<typeof specs[number]>>();
  for (const s of specs) {
    if (typeof s.worktree === 'string' && s.worktree.length > 0) {
      const list = specsByWorktreeClaim.get(s.worktree) ?? [];
      list.push(s);
      specsByWorktreeClaim.set(s.worktree, list);
    }
  }
  for (const [worktreeName, record] of Object.entries(registry)) {
    const registrySpecId = record?.specId;
    if (!registrySpecId) continue;
    const specB = specsById.get(registrySpecId);
    // Only fire when spec_B is loaded AND does NOT claim the worktree.
    if (!specB || specB.worktree === worktreeName) continue;
    const claimants = specsByWorktreeClaim.get(worktreeName) ?? [];
    // Find a spec_A that claims this worktree and is NOT spec_B.
    const specA = claimants.find((s) => s.id !== registrySpecId);
    if (specA === undefined) continue;
    findings.push(
      finding(
        DOCTOR_RULES.WORKTREE_BINDING_CONTRADICTION_3WAY,
        'error',
        `Worktree "${worktreeName}" has a 3-way binding contradiction: registry binds it to ${registrySpecId}; spec ${specA.id} claims it; spec ${registrySpecId} does not.`,
        {
          subject: worktreeName,
          narrowRepair:
            'Ambiguous authority split; no automatic repair available under current doctrine. See WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001.',
          data: {
            worktree_name: worktreeName,
            registry_spec_id: registrySpecId,
            spec_a_id: specA.id,
            spec_a_worktree: specA.worktree,
            spec_b_id: specB.id,
            spec_b_worktree: specB.worktree ?? null,
          },
        }
      )
    );
  }

  // -------------------------------------------------------------------------
  // 2e. WORKTREE-DOCTOR-HALF-STATE-001 H6: foreign physical worktree.
  //
  //     For each linked git worktree (the store has already filtered out
  //     the main worktree before delivery), if no `.caws/worktrees.json`
  //     entry references that path, emit an INFO finding. CAWS does not
  //     govern raw git worktrees, but silent acceptance is a footgun.
  //
  //     Skips silently when git observation is unavailable.
  // -------------------------------------------------------------------------

  if (gitWorktrees !== undefined) {
    const registryPaths = new Set<string>();
    for (const record of Object.values(registry)) {
      if (typeof record?.path === 'string') registryPaths.add(record.path);
    }
    for (const wt of gitWorktrees) {
      if (registryPaths.has(wt.path)) continue;
      findings.push(
        finding(
          DOCTOR_RULES.WORKTREE_FOREIGN_PHYSICAL,
          'info',
          `Git worktree at ${wt.path} is not registered in .caws/worktrees.json.`,
          {
            subject: wt.path,
            narrowRepair:
              'CAWS does not govern this worktree. Register it via caws worktree bind if it should be governed, or ignore if intentional.',
            data: {
              path: wt.path,
              branch: wt.branch,
            },
          }
        )
      );
    }
  }

  // -------------------------------------------------------------------------
  // 2f. WORKTREE-DOCTOR-HALF-STATE-001: git observation unavailable.
  //
  //     When the store layer's `git worktree list --porcelain` call
  //     failed, surface the gap as INFO. H1 and H6 silently skipped
  //     above; the H4 enrichment on §2b also degraded gracefully. The
  //     full report continues; operators see WHY git-backed half-state
  //     classes are absent rather than mistaking absence for "no
  //     ghosts."
  // -------------------------------------------------------------------------

  if (
    typeof input.gitObservationFailure === 'string' &&
    input.gitObservationFailure.length > 0
  ) {
    findings.push(
      finding(
        DOCTOR_RULES.WORKTREE_GIT_OBSERVATION_UNAVAILABLE,
        'info',
        'git worktree observation unavailable; H1/H6 half-state detection skipped.',
        {
          narrowRepair:
            'Verify git is installed and the repository is intact; rerun caws doctor.',
          data: { reason: input.gitObservationFailure },
        }
      )
    );
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

  // -------------------------------------------------------------------------
  // 8. Waivers (slice 7a.5).
  //
  // Three locally-derivable rules + one event-cross-reference rule. The
  // store owns I/O; doctor never calls loadWaivers — it consumes the
  // already-loaded `waivers` and the per-file `waiverDiagnostics` it
  // received in the input.
  //
  //   doctor.waiver.expired_active     — active+past-expiry, warning.
  //   doctor.waiver.unknown_gate       — gate not in policy.gates,
  //                                      error if policy loaded, else warning.
  //   doctor.waiver.malformed_loaded   — passthrough of waiverDiagnostics,
  //                                      severity inherited from the diag.
  //   doctor.waiver.revoked_referenced — gate_evaluated.data.waiver_ids
  //                                      contains an id whose current
  //                                      record is status='revoked'.
  // -------------------------------------------------------------------------

  if (input.waivers && input.waivers.length > 0) {
    const policyGateIds: Set<string> | undefined = input.policy
      ? new Set(Object.keys(input.policy.gates))
      : undefined;

    for (const w of input.waivers) {
      // 8a. expired_active — stored status is 'active' but the wall clock
      //     has passed expires_at.
      if (w.status === 'active') {
        const expMs = Date.parse(w.expires_at);
        if (Number.isFinite(expMs) && expMs <= now.getTime()) {
          findings.push(
            finding(
              DOCTOR_RULES.WAIVER_EXPIRED_ACTIVE,
              'warning',
              `Waiver ${w.id} has status=active but expires_at (${w.expires_at}) is in the past — it is inert at runtime but should be revoked or replaced.`,
              {
                subject: w.id,
                narrowRepair: `\`caws waiver revoke ${w.id} --reason expired\` or replace it with a fresh waiver.`,
                data: {
                  waiver_id: w.id,
                  expires_at: w.expires_at,
                  now: now.toISOString(),
                },
              }
            )
          );
        }
      }

      // 8b. unknown_gate — at least one gate the waiver names is not in
      //     policy.gates. We emit one finding per (waiver, unknown gate)
      //     pair so the repair is actionable.
      if (policyGateIds !== undefined) {
        for (const g of w.gates) {
          if (!policyGateIds.has(g)) {
            findings.push(
              finding(
                DOCTOR_RULES.WAIVER_UNKNOWN_GATE,
                'error',
                `Waiver ${w.id} references gate "${g}" which is not declared in policy.gates.`,
                {
                  subject: w.id,
                  narrowRepair: `Either remove "${g}" from this waiver, or add a gate config for it in .caws/policy.yaml.`,
                  data: { waiver_id: w.id, gate: g, policy_loaded: true },
                }
              )
            );
          }
        }
      } else {
        // No policy loaded → we can't authoritatively compare. Emit a
        // single warning per waiver naming all its gates so the operator
        // knows doctor could not verify them.
        findings.push(
          finding(
            DOCTOR_RULES.WAIVER_UNKNOWN_GATE,
            'warning',
            `Waiver ${w.id} names gates [${w.gates.join(', ')}] but no policy is loaded — gate-membership cannot be verified.`,
            {
              subject: w.id,
              narrowRepair:
                'Load .caws/policy.yaml so doctor can verify the waiver gate references.',
              data: { waiver_id: w.id, gates: w.gates.slice(), policy_loaded: false },
            }
          )
        );
      }
    }
  }

  // 8c. malformed_loaded — passthrough of per-file load diagnostics. Severity
  //     is inherited from the source diagnostic (the loader knows whether a
  //     given diagnostic is fatal or informational).
  if (input.waiverDiagnostics && input.waiverDiagnostics.length > 0) {
    for (const d of input.waiverDiagnostics) {
      const severity: FindingSeverity = d.severity ?? 'error';
      findings.push(
        finding(
          DOCTOR_RULES.WAIVER_MALFORMED_LOADED,
          severity,
          d.message,
          {
            ...(d.subject !== undefined ? { subject: d.subject } : {}),
            ...(d.narrowRepair !== undefined ? { narrowRepair: d.narrowRepair } : {}),
            data: {
              source_rule: d.rule,
              source_authority: d.authority,
              ...(d.data ?? {}),
            },
          }
        )
      );
    }
  }

  // 8d. revoked_referenced — walk gate_evaluated events for waiver_ids
  //     that point at currently-revoked waivers. Skipped silently when
  //     either side is absent: with no events we have nothing to cross-
  //     reference; with no waivers we can't classify any reference.
  if (
    input.events !== undefined &&
    input.events.length > 0 &&
    input.waivers !== undefined &&
    input.waivers.length > 0
  ) {
    const revokedById = new Map<string, (typeof input.waivers)[number]>();
    for (const w of input.waivers) {
      if (w.status === 'revoked') revokedById.set(w.id, w);
    }
    if (revokedById.size > 0) {
      // Dedupe per (waiver_id, event_seq) pair so multiple identical
      // events don't produce duplicate findings, but keep one finding
      // per distinct waiver_id (the operator should see every revoked
      // reference, not just the first).
      const seenWaiverIds = new Set<string>();
      for (const ev of input.events) {
        if (ev.event !== 'gate_evaluated') continue;
        const data = ev.data as { waiver_ids?: unknown };
        const ids = data.waiver_ids;
        if (!Array.isArray(ids)) continue;
        for (const id of ids) {
          if (typeof id !== 'string') continue;
          if (!revokedById.has(id)) continue;
          if (seenWaiverIds.has(id)) continue;
          seenWaiverIds.add(id);
          const revoked = revokedById.get(id)!;
          findings.push(
            finding(
              DOCTOR_RULES.WAIVER_REVOKED_REFERENCED,
              'warning',
              `Waiver ${id} is currently revoked but was credited by at least one gate_evaluated event (seq ${ev.seq}).`,
              {
                subject: id,
                narrowRepair:
                  'No file repair — events are append-only. Audit whether the suppression remains acceptable historically.',
                data: {
                  waiver_id: id,
                  first_event_seq: ev.seq,
                  revoked_at: revoked.revocation?.revoked_at,
                },
              }
            )
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 9. vNext layout + residue (slice 7c.2).
  //
  // Doctor classifies the snapshot facts the store handed us. It still
  // does not stat the filesystem itself; every rule below keys off the
  // booleans on `input.initResidue` and `input.filesystem`.
  //
  // Layout-missing rules fire ONLY when `.caws/` itself exists. On a
  // brand-new repo with no `.caws/`, these would be noise — the
  // policy.missing rule (section 6) is the right finding for "not
  // initialized".
  //
  // `eventsJsonlExists` is intentionally never required. The first
  // append creates the file under lock; a missing file is valid until
  // then.
  // -------------------------------------------------------------------------

  if (input.initResidue !== undefined) {
    if (input.initResidue.workingSpecYaml) {
      findings.push(
        finding(
          DOCTOR_RULES.INIT_LEGACY_WORKING_SPEC_PRESENT,
          'error',
          '.caws/working-spec.yaml is present. The vNext model is multi-spec under .caws/specs/; the legacy single-spec entry point conflicts with vNext authority.',
          {
            subject: '.caws/working-spec.yaml',
            narrowRepair:
              'Move the file aside (e.g. .caws/working-spec.yaml.legacy) after confirming no needed data remains, then re-run `caws init` if the canonical layout is incomplete.',
          }
        )
      );
    }
    if (input.initResidue.workingSpecSchemaJson) {
      findings.push(
        finding(
          DOCTOR_RULES.INIT_LEGACY_WORKING_SPEC_SCHEMA_PRESENT,
          'error',
          '.caws/working-spec.schema.json is present. vNext does not consume this schema; it is legacy single-spec residue.',
          {
            subject: '.caws/working-spec.schema.json',
            narrowRepair:
              'Remove or archive .caws/working-spec.schema.json. vNext validates specs through the kernel, not a project-local JSON schema.',
          }
        )
      );
    }
  }

  if (input.filesystem !== undefined && input.filesystem.cawsDirExists) {
    // Layout drift only matters when the project has been initialized at
    // all. An uninitialized repo gets policy.missing (covered above);
    // emitting "specs dir missing" on top would be noise.
    if (!input.filesystem.specsDirExists) {
      findings.push(
        finding(
          DOCTOR_RULES.INIT_SPECS_DIR_MISSING,
          'warning',
          '.caws/specs/ is missing. Specs cannot land until the directory exists.',
          {
            subject: '.caws/specs',
            narrowRepair: 'Run `caws init` to fill in the missing canonical paths.',
          }
        )
      );
    }
    if (!input.filesystem.waiversDirExists) {
      findings.push(
        finding(
          DOCTOR_RULES.INIT_WAIVERS_DIR_MISSING,
          'warning',
          '.caws/waivers/ is missing. Waivers cannot be created until the directory exists.',
          {
            subject: '.caws/waivers',
            narrowRepair: 'Run `caws init` to fill in the missing canonical paths.',
          }
        )
      );
    }
    if (!input.filesystem.worktreesJsonExists) {
      findings.push(
        finding(
          DOCTOR_RULES.INIT_WORKTREES_REGISTRY_MISSING,
          'warning',
          '.caws/worktrees.json is missing. The store treats absence as `{}`, but a fully-initialized project should carry the empty registry.',
          {
            subject: '.caws/worktrees.json',
            narrowRepair: 'Run `caws init` to fill in the missing canonical paths.',
          }
        )
      );
    }
    if (!input.filesystem.agentsJsonExists) {
      findings.push(
        finding(
          DOCTOR_RULES.INIT_AGENTS_REGISTRY_MISSING,
          'warning',
          '.caws/agents.json is missing. The store treats absence as `{}`, but a fully-initialized project should carry the empty registry.',
          {
            subject: '.caws/agents.json',
            narrowRepair: 'Run `caws init` to fill in the missing canonical paths.',
          }
        )
      );
    }
    // Note: NO rule for events.jsonl missing — first append creates it.
  }

  // -------------------------------------------------------------------------
  // 10. Registry hygiene — passthrough of malformed-load diagnostics.
  // -------------------------------------------------------------------------

  if (input.registryDiagnostics && input.registryDiagnostics.length > 0) {
    for (const d of input.registryDiagnostics) {
      const severity: FindingSeverity = d.severity ?? 'error';
      findings.push(
        finding(
          DOCTOR_RULES.REGISTRY_MALFORMED_LOADED,
          severity,
          d.message,
          {
            ...(d.subject !== undefined ? { subject: d.subject } : {}),
            ...(d.narrowRepair !== undefined ? { narrowRepair: d.narrowRepair } : {}),
            data: {
              source_rule: d.rule,
              source_authority: d.authority,
              ...(d.data ?? {}),
            },
          }
        )
      );
    }
  }

  // -------------------------------------------------------------------------
  // 11. Policy posture (slice 7c.2).
  //
  // These are diagnostic-only — doctor reports posture risk; policy
  // validation still owns validity. We deliberately do NOT mirror every
  // policy.semantic.* warning; that's already surfaced via section 6
  // (POLICY_VALID_WITH_WARNINGS). The posture rules below are the
  // narrower set the operator most often needs to see in `caws status`.
  // -------------------------------------------------------------------------

  if (input.policy !== undefined) {
    // 11a. Critical gates must be enabled AND in block mode. The set
    //      ['budget_limit', 'spec_completeness', 'scope_boundary'] mirrors
    //      `policy/rules.ts:CRITICAL_GATES` — kept in lockstep by reusing
    //      that constant rather than duplicating.
    for (const gateId of CRITICAL_GATES) {
      const cfg = (input.policy.gates as Record<string, { enabled: boolean; mode: string } | undefined>)[gateId];
      if (cfg === undefined) {
        // Required-by-schema; if it's missing the schema validator already
        // refused. Skip silently — doctor doesn't double-report schema
        // violations.
        continue;
      }
      if (cfg.enabled !== true || cfg.mode !== 'block') {
        findings.push(
          finding(
            DOCTOR_RULES.POLICY_CRITICAL_GATE_NOT_BLOCKING,
            'warning',
            `Critical gate "${gateId}" is not in block mode (enabled=${cfg.enabled}, mode=${cfg.mode}). Policy decisions on this gate will not block.`,
            {
              subject: `policy.gates.${gateId}`,
              narrowRepair: `Set policy.gates.${gateId} to { enabled: true, mode: block } unless you have an audited reason to relax it.`,
              data: { gate_id: gateId, enabled: cfg.enabled, mode: cfg.mode },
            }
          )
        );
      }
    }

    // 11b. Broad non_governed_zones patterns. Explicit small dangerous set;
    //      no clever subsumption, just exact-match. Severity escalates to
    //      error when `non_governed_zones_force === true` because the
    //      operator has explicitly armed the dangerous pattern.
    const DANGEROUS_NON_GOVERNED_PATTERNS = [
      '*',
      '**',
      '**/*',
      '.',
      './',
      '/',
      '/*',
    ] as const;
    const zones = input.policy.non_governed_zones ?? [];
    const force = input.policy.non_governed_zones_force === true;
    for (const z of zones) {
      if (DANGEROUS_NON_GOVERNED_PATTERNS.includes(z as typeof DANGEROUS_NON_GOVERNED_PATTERNS[number])) {
        findings.push(
          finding(
            DOCTOR_RULES.POLICY_NON_GOVERNED_ZONE_BROAD,
            force ? 'error' : 'warning',
            `policy.non_governed_zones contains the broad pattern "${z}"${force ? ' AND non_governed_zones_force=true' : ''}. ${force ? 'This explicitly armed pattern removes scope governance from a wide swath of the repo.' : 'Pattern is currently inert pending non_governed_zones_force, but should be tightened.'}`,
            {
              subject: 'policy.non_governed_zones',
              narrowRepair: `Replace "${z}" with a narrower path glob (e.g. "research/**", "playground/**"). Broad patterns disable scope checks across the repo.`,
              data: { pattern: z, force },
            }
          )
        );
      }
    }

    // 11c. root_passthrough lists a high-blast-radius file. Reuses the
    //      RISKY_ROOT_FILES constant from policy/rules so the two surfaces
    //      stay in lockstep.
    const passthrough = input.policy.root_passthrough ?? [];
    for (const f of passthrough) {
      if ((RISKY_ROOT_FILES as readonly string[]).includes(f)) {
        findings.push(
          finding(
            DOCTOR_RULES.POLICY_ROOT_PASSTHROUGH_RISKY,
            'warning',
            `policy.root_passthrough includes risky root file "${f}". Edits to this file will bypass scope governance.`,
            {
              subject: 'policy.root_passthrough',
              narrowRepair: `Confirm "${f}" should genuinely bypass scope checks; if not, remove it from root_passthrough.`,
              data: { file: f },
            }
          )
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // 12. Waiver posture (slice 7c.2).
  //
  // Two posture rules off the existing waiver input surface:
  //   - too_many_active_for_gate: counts effective waivers per gate;
  //     warns when > policy.waivers.max_active_waivers_per_gate.
  //   - expires_soon: info-only; only fires when a policy threshold is
  //     configured (we do NOT invent a default).
  //
  // "Effective" here means the kernel rule: status='active' AND
  // expires_at > now. Revoked or expired records cannot affect gates and
  // would be noise in either count.
  // -------------------------------------------------------------------------

  if (
    input.waivers !== undefined &&
    input.waivers.length > 0 &&
    input.policy !== undefined
  ) {
    const cap = input.policy.waivers?.max_active_waivers_per_gate;
    if (typeof cap === 'number' && cap >= 0) {
      // Tally effective waivers per gate id they cover.
      const countByGate = new Map<string, number>();
      for (const w of input.waivers) {
        if (waiverEffectiveness(w, now) !== 'active') continue;
        for (const g of w.gates) {
          countByGate.set(g, (countByGate.get(g) ?? 0) + 1);
        }
      }
      // Sort gate ids so finding order is deterministic.
      const sorted = Array.from(countByGate.keys()).sort();
      for (const g of sorted) {
        const n = countByGate.get(g)!;
        if (n > cap) {
          findings.push(
            finding(
              DOCTOR_RULES.WAIVER_TOO_MANY_ACTIVE_FOR_GATE,
              'warning',
              `Gate "${g}" has ${n} effective waivers, exceeding policy.waivers.max_active_waivers_per_gate=${cap}.`,
              {
                subject: `policy.waivers.max_active_waivers_per_gate`,
                narrowRepair: `Audit the active waivers for "${g}" and revoke or replace stale ones with \`caws waiver revoke <id>\`. Counts only effective waivers; expired/revoked records are excluded.`,
                data: { gate_id: g, count: n, cap },
              }
            )
          );
        }
      }
    }

    // 12b. expires_soon. Only fires when a policy threshold is set;
    //      doctor does NOT invent a default that would surprise the
    //      operator. The threshold is read off
    //      `policy.waivers.default_expiry_days` for now (the existing
    //      WaiversPolicy field). If a separate `expires_soon_within_days`
    //      lands later, swap to that — comment is the contract.
    const expiresSoonDays = input.policy.waivers?.default_expiry_days;
    if (typeof expiresSoonDays === 'number' && expiresSoonDays > 0) {
      const horizonMs = expiresSoonDays * 24 * 60 * 60 * 1000;
      for (const w of input.waivers) {
        if (waiverEffectiveness(w, now) !== 'active') continue;
        const expMs = Date.parse(w.expires_at);
        if (!Number.isFinite(expMs)) continue;
        const remaining = expMs - now.getTime();
        if (remaining <= horizonMs) {
          findings.push(
            finding(
              DOCTOR_RULES.WAIVER_EXPIRES_SOON,
              'info',
              `Waiver ${w.id} expires within the configured horizon (${expiresSoonDays} day(s)).`,
              {
                subject: w.id,
                narrowRepair: `Replace ${w.id} with a fresh waiver before expiry, or let it lapse. No automatic action taken.`,
                data: {
                  waiver_id: w.id,
                  expires_at: w.expires_at,
                  horizon_days: expiresSoonDays,
                  remaining_ms: remaining,
                },
              }
            )
          );
        }
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
