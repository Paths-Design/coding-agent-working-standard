import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertMachinePath, atomicMachineWrite } from './machine-adapters';
import { REPO_HOOK_POLICY_PATH, parseRepoHookPolicy } from './repo-hook-policy';
import {
  digest,
  planHookReconciliation,
  readOptional,
  verifyReconciliationRecoveryInputs,
  type ReconciliationPlan,
} from './hook-reconciliation';

interface Journal {
  version: 1;
  plan: ReconciliationPlan;
  state: 'prepared' | 'repo_written' | 'complete';
}
const machineFile = (plan: ReconciliationPlan) =>
  path.join(plan.home, 'state/projects', digest(plan.root) + '.json');
const lockFile = (plan: ReconciliationPlan) =>
  path.join(plan.home, 'state/hooks-imports', digest(plan.root) + '.lock');
const journalFile = (plan: ReconciliationPlan) =>
  path.join(plan.home, 'state/hooks-imports', digest(plan.root) + '-' + plan.plan_id + '.json');

function validatePlan(plan: ReconciliationPlan, root: string, home: string): void {
  if (
    plan.schema !== 'caws.hook_reconciliation.v1' ||
    plan.root !== fs.realpathSync(root) ||
    plan.home !== path.resolve(home) ||
    !Array.isArray(plan.selected) ||
    plan.selected.some((v) => typeof v !== 'string')
  )
    throw new Error('Plan does not identify this project and machine home');
  const { plan_id, ...body } = plan;
  if (digest(JSON.stringify(body)) !== plan_id)
    throw new Error('Plan digest does not match its contents');
  if (!parseRepoHookPolicy(plan.repo_after).ok)
    throw new Error('Journal candidate repository policy is invalid');
}
function atomicRepoWrite(root: string, file: string, text: string): void {
  assertMachinePath(root, file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.import-' + process.pid;
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function acquire(plan: ReconciliationPlan, recovering: boolean): () => void {
  const ownership = JSON.stringify({ plan_id: plan.plan_id, pid: process.pid });
  function reclaim(ownerFile: string): void {
    const held = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as { plan_id: string; pid: number };
    if (held.plan_id !== plan.plan_id || !Number.isInteger(held.pid) || held.pid <= 0)
      throw new Error('A different or invalid import lock owns this project');
    let alive = true;
    try {
      process.kill(held.pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
    }
    if (alive) throw new Error('Import owner is still alive; recovery cannot take its lock');
    fs.unlinkSync(ownerFile);
  }
  const lock = lockFile(plan);
  assertMachinePath(plan.home, lock);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  if (recovering && fs.existsSync(lock)) {
    reclaim(lock);
  }
  fs.writeFileSync(lock, ownership, { flag: 'wx' });
  const directories: string[] = [];
  const release = () => {
    for (const dir of directories.reverse()) {
      const owner = path.join(dir, 'hooks-import-owner.json');
      if (readOptional(owner) === ownership) {
        fs.unlinkSync(owner);
        fs.rmdirSync(dir);
      }
    }
    if (readOptional(lock) === ownership) fs.unlinkSync(lock);
  };
  try {
    // These are the same exclusive directory locks used by adapter installation
    // and system configuration. Never reclaim their generic, unowned locks.
    for (const name of ['adapter-install.lock', 'system-configuration.lock']) {
      const dir = path.join(plan.home, 'state', name);
      assertMachinePath(plan.home, dir);
      const owner = path.join(dir, 'hooks-import-owner.json');
      if (recovering && fs.existsSync(dir) && fs.existsSync(owner)) {
        reclaim(owner);
        fs.rmdirSync(dir);
      }
      fs.mkdirSync(dir);
      try {
        fs.writeFileSync(owner, ownership, { flag: 'wx' });
      } catch (e) {
        fs.rmdirSync(dir);
        throw e;
      }
      directories.push(dir);
    }
  } catch (e) {
    release();
    throw e;
  }
  return release;
}
function finish(journal: Journal, journalPath: string): void {
  const p = journal.plan;
  const repoFile = path.join(p.root, REPO_HOOK_POLICY_PATH),
    stateFile = machineFile(p);
  const repo = readOptional(repoFile),
    machine = readOptional(stateFile);
  if (
    (repo !== p.repo_before && repo !== p.repo_after) ||
    (machine !== p.machine_before && machine !== p.machine_after)
  )
    throw new Error('Concurrent edits differ from both journal states; recovery refused');
  if (repo === p.repo_before) {
    // Detect observed edits immediately before each write. External editors do
    // not participate in these cooperative locks; two-file atomicity is not claimed.
    if (readOptional(repoFile) !== repo) throw new Error('Repository policy changed during import');
    atomicRepoWrite(p.root, repoFile, p.repo_after);
  }
  journal.state = 'repo_written';
  atomicMachineWrite(p.home, journalPath, JSON.stringify(journal, null, 2) + '\n');
  if (readOptional(stateFile) !== machine || readOptional(repoFile) !== p.repo_after)
    throw new Error('Policy or machine state changed during import; journal retained');
  if (machine !== p.machine_after) atomicMachineWrite(p.home, stateFile, p.machine_after);
  journal.state = 'complete';
  atomicMachineWrite(p.home, journalPath, JSON.stringify(journal, null, 2) + '\n');
}

export function applyHookReconciliation(
  plan: ReconciliationPlan,
  root: string,
  home: string
): string {
  validatePlan(plan, root, home);
  // Reject edits to selections, inputs or candidates by reconstructing from live authority.
  const live = planHookReconciliation(root, home, plan.selected);
  if (live.plan_id !== plan.plan_id) throw new Error('Reconciliation plan is stale; preview again');
  if (live.blockers.length || !live.selected.length)
    throw new Error('Plan is not applicable: ' + (live.blockers.join('; ') || 'nothing selected'));
  const release = acquire(live, false);
  const journalPath = journalFile(live);
  try {
    // A second read after acquiring the cooperative writer lock closes the planning window.
    if (planHookReconciliation(root, home, live.selected).plan_id !== live.plan_id)
      throw new Error('Inputs changed while acquiring import lock');
    const journal: Journal = { version: 1, plan: live, state: 'prepared' };
    atomicMachineWrite(home, journalPath, JSON.stringify(journal, null, 2) + '\n');
    finish(journal, journalPath);
    return journalPath;
  } catch (e) {
    throw new Error(
      (e as Error).message +
        (fs.existsSync(journalPath)
          ? '; recovery journal: ' + journalPath
          : '; no recovery journal was created')
    );
  } finally {
    release();
  }
}

export function recoverHookReconciliation(journalPath: string, root: string, home: string): string {
  assertMachinePath(home, journalPath);
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Journal;
  if (journal.version !== 1 || !['prepared', 'repo_written', 'complete'].includes(journal.state))
    throw new Error('Invalid import journal');
  validatePlan(journal.plan, root, home);
  if (path.resolve(journalPath) !== journalFile(journal.plan))
    throw new Error('Journal path does not match this transaction');
  const release = acquire(journal.plan, true);
  try {
    verifyReconciliationRecoveryInputs(journal.plan);
    finish(journal, journalPath);
    return journalPath;
  } finally {
    release();
  }
}
