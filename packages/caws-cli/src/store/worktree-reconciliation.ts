import * as path from 'node:path';
import {
  err,
  inspectProjectState,
  type EventBody,
  type Result,
  type ChainedEvent,
} from '../kernel';
import { composeDoctorSnapshot } from './doctor-snapshot';
import { withLifecycleLock } from './lifecycle-lock';
import { appendEvent } from './events-store';
import { storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';

/** A receipt for observed absence, not an acknowledgment or a completion claim. */
export function reconcileWorktreeCreation(
  cawsDir: string,
  input: {
    name: string;
    createdEventSeq: number;
    createdEventHash: string;
    actor: EventBody['actor'];
    now?: () => Date;
  }
): Result<ChainedEvent> {
  return withLifecycleLock(cawsDir, () => {
    const now = (input.now ?? (() => new Date()))();
    const { snapshot, doctorInput } = composeDoctorSnapshot({
      repoRoot: path.dirname(cawsDir),
      cawsDir,
      now,
    });
    const report = inspectProjectState(doctorInput);
    const loadErrors = [
      ...snapshot.specDiagnostics,
      ...snapshot.registryDiagnostics,
      ...snapshot.eventWarnings,
    ].some((d) => d.severity === 'error');
    const match = report.findings.find(
      (f) =>
        f.rule === 'doctor.worktree.event_without_control_plane_binding' &&
        f.subject === input.name &&
        f.data?.verified_dead === true &&
        f.data.created_event_seq === input.createdEventSeq &&
        f.data.created_event_hash === input.createdEventHash
    );
    if (
      loadErrors ||
      doctorInput.filesystem?.specsDirExists !== true ||
      doctorInput.filesystem?.worktreesJsonExists !== true ||
      report.findings.some((f) => f.rule === 'doctor.event.chain_invalid') ||
      !match
    ) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          'Creation reconciliation refused: observations changed, history is invalid, or complete absence is not established.',
          { subject: input.name }
        )
      );
    }
    return appendEvent(cawsDir, {
      event: 'worktree_pruned',
      ts: now.toISOString(),
      actor: input.actor,
      data: {
        worktree_name: input.name,
        h_class: 'verified_dead_creation',
        created_event_seq: input.createdEventSeq,
        created_event_hash: input.createdEventHash,
        branch: match.data!.branch_observed_absent,
        path: match.data!.path_observed_absent,
        reason:
          'No registry entry, spec binding, branch, directory or linked Git worktree remains; absence revalidated under lifecycle lock.',
      },
    });
  });
}
