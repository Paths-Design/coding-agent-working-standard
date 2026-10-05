import type { DoctorFinding } from './types';

/** Current observations remain inspectable without becoming repair obligations. */
export function projectDoctorFindings(all: readonly DoctorFinding[]) {
  const findings: DoctorFinding[] = [],
    inventory: DoctorFinding[] = [],
    activity: DoctorFinding[] = [];
  for (const f of all) {
    // An error is never demoted by a rule-name classification.
    if (f.severity !== 'error' && f.rule === 'doctor.worktree.owner_lease_missing')
      activity.push(f);
    else if (
      f.severity === 'info' &&
      [
        'doctor.hooks.system_runtime',
        'doctor.global_home.recognized_legacy_state',
        'doctor.hooks.pack_local_growth',
      ].includes(f.rule)
    )
      inventory.push(f);
    else findings.push(f);
  }
  return { findings, inventory, activity };
}
