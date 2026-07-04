// `caws doctor` — composition command.
//
// Pipeline (no business logic in this file):
//
//   1. resolveRepoRoot(cwd)         (store)
//   2. composeDoctorSnapshot(...)   (store)
//   3. inspectProjectState(input)   (kernel)
//   4. render store-load diagnostics  (renderer)
//   5. render doctor findings         (renderer)
//   6. choose exit code               (this file)
//
// The command does NOT read .caws/ files directly, does NOT walk specs,
// does NOT invent repair rules, and does NOT re-validate state.
//
// Exit codes:
//   0 = no error-severity findings AND no error-severity store-load
//       diagnostics
//   1 = any error-severity finding OR any error-severity store-load
//       diagnostic. (Store-load errors count even when they were filtered
//       out before reaching the kernel, because an invalid spec file is a
//       project-health problem regardless.)
//   2 = repo-root resolution failed, or other hard composition failure.
//
// Testable without Commander: caller passes cwd / out / err / now and
// receives a number. `registerShellCommands(program)` (Slice 5c.9) is the
// only place that wires this to Commander.

import type { Diagnostic, DoctorFinding } from '@paths.design/caws-kernel';
import { DOCTOR_RULES, inspectProjectState } from '@paths.design/caws-kernel';

import { detectGitignoreDrift } from '../../init/gitignore-drift';
import {
  composeDoctorSnapshot,
  resolveRepoRoot,
} from '../../store';
import {
  countFindingSeverities,
  countSeverities,
  renderDiagnostics,
  renderFindings,
} from '../index';

export interface DoctorCommandOptions {
  readonly cwd?: string;
  readonly now?: Date;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  /**
   * Show the optional `data` block for each diagnostic/finding. Default
   * false to keep output tight.
   */
  readonly showData?: boolean;
  readonly repairPlan?: boolean;
  readonly json?: boolean;
}

export interface DoctorRepairPlanItem {
  readonly subject: string;
  readonly state_class: string;
  readonly source_rule: string;
  readonly severity: DoctorFinding['severity'];
  readonly message: string;
  readonly allowed_mutation: string | null;
  readonly refusal_reason?: string;
  readonly next_command: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

function findingSubject(finding: DoctorFinding): string {
  const data = (finding.data ?? {}) as Record<string, unknown>;
  for (const key of ['worktree_name', 'spec_id', 'waiver_id', 'gate', 'path']) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return typeof finding.subject === 'string' && finding.subject.length > 0
    ? finding.subject
    : finding.rule;
}

function genericPlanItem(
  finding: DoctorFinding,
  input: {
    readonly stateClass: string;
    readonly nextCommand?: string;
    readonly allowedMutation?: string | null;
    readonly refusalReason?: string;
  }
): DoctorRepairPlanItem {
  const data = (finding.data ?? {}) as Record<string, unknown>;
  const allowedMutation = input.allowedMutation ?? null;
  return {
    subject: findingSubject(finding),
    state_class: input.stateClass,
    source_rule: finding.rule,
    severity: finding.severity,
    message: finding.message,
    allowed_mutation: allowedMutation,
    ...(allowedMutation === null
      ? {
          refusal_reason:
            input.refusalReason ??
            'No automatic repair command is declared for this finding; inspect the finding before mutating.',
        }
      : {}),
    next_command:
      input.nextCommand ??
      finding.narrowRepair ??
      'caws doctor --data',
    ...(Object.keys(data).length > 0 ? { details: data } : {}),
  };
}

function doctorRepairPlanItem(finding: DoctorFinding): DoctorRepairPlanItem {
  const data = (finding.data ?? {}) as Record<string, unknown>;
  switch (finding.rule) {
    case DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_STALE:
    case DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_TIMESTAMP_MISSING:
      return genericPlanItem(finding, {
        stateClass: 'active-spec-unbound',
        ...(typeof data.spec_id === 'string'
          ? { nextCommand: `caws worktree create <name> --spec ${data.spec_id}` }
          : {}),
        refusalReason:
          'The active spec has no bound worktree; choose whether to bind work, close the spec, or leave it active.',
      });

    case DOCTOR_RULES.WORKTREE_GHOST_REGISTRY_ENTRY:
      return genericPlanItem(finding, {
        stateClass: 'ghost-registry',
        allowedMutation: 'prune registry entry and append worktree_pruned via caws worktree prune --apply',
        nextCommand: 'caws worktree prune --state ghost-registry --apply',
      });

    case DOCTOR_RULES.BINDING_SPEC_MISSING_REGISTRY: {
      const lifecycle = data.lifecycle_state;
      const observedAbsent =
        data.canonical_dir_observed === true && data.canonical_dir_present === false;
      if (lifecycle === 'closed' || lifecycle === 'archived') {
        return genericPlanItem(finding, {
          stateClass: 'closed-spec-residue',
          allowedMutation:
            'clear stale spec worktree binding and append spec_binding_cleared via caws worktree prune --apply',
          nextCommand: 'caws worktree prune --state closed-spec-residue --apply',
        });
      }
      if (observedAbsent) {
        return genericPlanItem(finding, {
          stateClass: 'dead-binding',
          allowedMutation:
            'clear stale spec worktree binding and append spec_binding_cleared via caws worktree prune --apply',
          nextCommand: 'caws worktree prune --state dead-binding --apply',
        });
      }
      return genericPlanItem(finding, {
        stateClass: 'active-binding-refused',
        nextCommand: finding.narrowRepair ?? 'caws doctor --data',
        refusalReason:
          'The active spec binding is ambiguous; choose recreate, clear, or destroy intent explicitly before mutating.',
      });
    }

    case DOCTOR_RULES.BINDING_REGISTRY_MISSING_SPEC:
      return genericPlanItem(finding, {
        stateClass: 'missing-spec-refused',
        nextCommand: finding.narrowRepair ?? 'caws worktree list --data',
        refusalReason:
          'The registry still claims a spec id that is not loaded; restore the spec or destroy/untrack the worktree explicitly.',
      });

    case DOCTOR_RULES.WORKTREE_BINDING_CONTRADICTION_3WAY:
      return genericPlanItem(finding, {
        stateClass: 'binding-contradiction-refused',
        refusalReason:
          'Three-way authority contradiction requires a human choice of winning binding before mutation.',
      });

    case DOCTOR_RULES.WORKTREE_FOREIGN_PHYSICAL:
      return genericPlanItem(finding, {
        stateClass: 'foreign-physical-refused',
        nextCommand: 'git worktree list --porcelain && caws worktree list --data',
        refusalReason:
          'CAWS repair does not touch physical git worktrees that CAWS did not register.',
      });

    case DOCTOR_RULES.WORKTREE_EVENT_WITHOUT_CONTROL_PLANE_BINDING:
      return genericPlanItem(finding, {
        stateClass: 'event-orphan-refused',
        nextCommand: finding.narrowRepair ?? 'caws events show latest-rotation --json',
        refusalReason:
          'Immutable event history references a worktree without live control-plane binding; reconcile authority manually.',
      });

    case DOCTOR_RULES.AGENT_STALE_DISPLAY_ONLY:
      return genericPlanItem(finding, {
        stateClass: 'stale-agent-display-only',
        nextCommand: 'caws agents list --json',
        refusalReason:
          'Stale heartbeats are display-only and do not prove abandonment or authorize takeover.',
      });

    case DOCTOR_RULES.WORKTREE_OWNER_LEASE_MISSING:
      return genericPlanItem(finding, {
        stateClass: 'owner-lease-missing-refused',
        nextCommand: 'caws worktree list --data && caws agents list --json',
        refusalReason:
          'Leases are operational cache, not authority; use explicit handoff or takeover intent before cleanup.',
      });

    case DOCTOR_RULES.WAIVER_EXPIRED_ACTIVE:
      return genericPlanItem(finding, {
        stateClass: 'expired-waiver',
        allowedMutation: 'revoke expired active waivers via caws waiver prune --apply',
        nextCommand: 'caws waiver prune --status expired --apply --reason <reason> --revoked-by <actor>',
      });

    case DOCTOR_RULES.POLICY_MISSING:
      return genericPlanItem(finding, {
        stateClass: 'policy-missing',
        nextCommand: finding.narrowRepair ?? 'caws init',
        refusalReason:
          'Policy authority is missing; initialize or restore policy before running gate-dependent mutations.',
      });

    case DOCTOR_RULES.EVENT_CHAIN_INVALID:
      return genericPlanItem(finding, {
        stateClass: 'event-chain-invalid',
        nextCommand: 'caws events list --json',
        refusalReason:
          'The event chain is invalid; inspect the chain before appending or rotating events.',
      });

    default:
      return genericPlanItem(finding, {
        stateClass: finding.rule.replace(/^doctor\./, '').replace(/\./g, '-'),
      });
  }
}

function countsByState(items: readonly DoctorRepairPlanItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.state_class] = (counts[item.state_class] ?? 0) + 1;
  return counts;
}

function renderRepairPlan(items: readonly DoctorRepairPlanItem[], out: (line: string) => void): void {
  out(`caws doctor repair-plan: ${items.length} finding(s), read-only`);
  if (items.length === 0) {
    out('  (no repair-plan items)');
    return;
  }
  for (const item of items) {
    out(`- ${item.state_class} ${item.subject}`);
    out(`  source: ${item.source_rule} (${item.severity})`);
    out(`  allowed: ${item.allowed_mutation ?? 'refused'}`);
    if (item.refusal_reason !== undefined) out(`  refusal: ${item.refusal_reason}`);
    out(`  next: ${item.next_command}`);
  }
}

export function runDoctorCommand(opts: DoctorCommandOptions = {}): number {
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? new Date();
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;

  // 1. Repo root
  const repoRootResult = resolveRepoRoot(cwd);
  if (!repoRootResult.ok) {
    err('caws doctor: failed to resolve repo root.');
    err(renderDiagnostics(repoRootResult.errors, { showData }));
    return 2;
  }
  const { repoRoot, cawsDir } = repoRootResult.value;

  // 2 + 3. Compose snapshot, run kernel diagnoser
  let composition: ReturnType<typeof composeDoctorSnapshot>;
  try {
    composition = composeDoctorSnapshot({ repoRoot, cawsDir, now });
  } catch (e) {
    err(`caws doctor: store composition failed: ${(e as Error).message}`);
    return 2;
  }
  const { snapshot, doctorInput } = composition;

  let report: ReturnType<typeof inspectProjectState>;
  try {
    report = inspectProjectState(doctorInput);
  } catch (e) {
    err(`caws doctor: kernel inspect failed: ${(e as Error).message}`);
    return 2;
  }

  // 3b. CLI-side findings the kernel does not own. The gitignore-drift check is
  // a shell concern (the kernel knows nothing about .gitignore or init's
  // managed-block format), so it is computed here and merged into the findings
  // list alongside the kernel report (CAWS-DOCTOR-GITIGNORE-DRIFT-001).
  const gitignoreDrift = detectGitignoreDrift(repoRoot, cawsDir);
  const findings: DoctorFinding[] = gitignoreDrift
    ? [...report.findings, gitignoreDrift]
    : [...report.findings];

  // 4. Render store-load diagnostics — kept SEPARATE from doctor findings.
  const loadDiagnostics: Diagnostic[] = [
    ...snapshot.specDiagnostics,
    ...snapshot.policyErrors,
    ...snapshot.policyWarnings,
    ...snapshot.eventWarnings,
  ];

  const loadCounts = countSeverities(loadDiagnostics);
  const findingCounts = countFindingSeverities(findings);
  const hasErrors = findingCounts.errors > 0 || loadCounts.errors > 0;

  if (opts.repairPlan === true) {
    const items = findings.map(doctorRepairPlanItem);
    if (opts.json === true) {
      out(JSON.stringify({
        ok: !hasErrors,
        dry_run: true,
        read_only: true,
        counts: {
          findings: items.length,
          errors: findingCounts.errors,
          warnings: findingCounts.warnings,
          infos: findingCounts.infos,
          load_errors: loadCounts.errors,
          load_warnings: loadCounts.warnings,
          load_infos: loadCounts.infos,
        },
        counts_by_state: countsByState(items),
        items,
        load_diagnostics: loadDiagnostics,
      }, null, 2));
    } else {
      renderRepairPlan(items, out);
      if (loadDiagnostics.length > 0) {
        out('');
        out(
          `Store load diagnostics: ${loadCounts.errors}E/${loadCounts.warnings}W/${loadCounts.infos}I ` +
            '(run caws doctor --data for details)'
        );
      }
    }
    return hasErrors ? 1 : 0;
  }

  out('Store load diagnostics:');
  if (loadDiagnostics.length === 0) {
    out('  (none)');
  } else {
    out(renderDiagnostics(loadDiagnostics, { showData }));
  }

  // 5. Render doctor findings — separate section.
  out('');
  out('Doctor findings:');
  if (findings.length === 0) {
    out('  (none)');
  } else {
    out(renderFindings(findings, { showData }));
  }

  // 6. Exit code
  out('');
  out(
    `Summary: findings ${findingCounts.errors}E/${findingCounts.warnings}W/${findingCounts.infos}I; ` +
      `load ${loadCounts.errors}E/${loadCounts.warnings}W/${loadCounts.infos}I`
  );

  return hasErrors ? 1 : 0;
}
