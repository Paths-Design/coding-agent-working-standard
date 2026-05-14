// `caws scope show <path>` and `caws scope check <path>` — share one
// decision path; differ only in exit-code policy.
//
//   show:  always exits 0 after rendering, even for reject / no_authority
//          / invalid_path. It is explanatory.
//   check: exits 0 only on `admit`. reject / no_authority / invalid_path
//          exit 1. Used by hooks.
//
// Both:
//   1. resolveRepoRoot(cwd)
//   2. composeStoreSnapshot (we want load diagnostics if anything is
//      malformed; we do NOT use composeDoctorSnapshot because we don't
//      run the doctor here)
//   3. resolveBinding(cwd, registry, specs)
//   4. require a loaded policy. If absent, exit 2 with a clear message.
//   5. kernel evaluatePath(path, binding, policy)
//   6. renderDecision(decision, {boundContext})
//   7. exit per mode.
//
// The command does NOT compute its own scope rules. The kernel decides;
// the command only renders and picks the exit.

import {
  evaluatePath,
  type Decision,
  type Policy,
} from '@paths.design/caws-kernel';

import { composeStoreSnapshot, resolveRepoRoot } from '../../store';
import { resolveBinding } from '../binding/resolve-binding';
import { renderDecision } from '../render/decision';
import { renderDiagnostics } from '../render/diagnostic';

export type ScopeMode = 'show' | 'check';

export interface ScopeCommandOptions {
  readonly path: string;
  readonly mode: ScopeMode;
  readonly cwd?: string;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly showData?: boolean;
}

export function runScopeCommand(opts: ScopeCommandOptions): number {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;
  const mode = opts.mode;

  // 1. Repo root
  const repoRootResult = resolveRepoRoot(cwd);
  if (!repoRootResult.ok) {
    err(`caws scope ${mode}: failed to resolve repo root.`);
    err(renderDiagnostics(repoRootResult.errors, { showData }));
    return 2;
  }
  const { repoRoot, cawsDir } = repoRootResult.value;

  // 2. Snapshot
  let snapshot: ReturnType<typeof composeStoreSnapshot>;
  try {
    snapshot = composeStoreSnapshot({ repoRoot, cawsDir });
  } catch (e) {
    err(`caws scope ${mode}: store composition failed: ${(e as Error).message}`);
    return 2;
  }

  // 3. Binding from cwd
  const bound = resolveBinding({
    repoRoot,
    cwd,
    registry: snapshot.worktrees,
    specs: snapshot.specs,
  });

  // 4. Require a loaded policy. Without it, the kernel can't evaluate
  //    non_governed_zones / root_passthrough / infra exemptions, and the
  //    rewrite plan requires policy.yaml for any vNext project. This is
  //    exit-2 (program/composition) territory, not no_authority.
  const policy: Policy | undefined = snapshot.policy;
  if (policy === undefined) {
    err(`caws scope ${mode}: no policy.yaml loaded. Run \`caws doctor\` for details.`);
    if (snapshot.policyErrors.length > 0) {
      err(renderDiagnostics(snapshot.policyErrors, { showData }));
    }
    return 2;
  }

  // 5. Kernel decision
  let decision: Decision;
  try {
    decision = evaluatePath(opts.path, bound.binding, policy);
  } catch (e) {
    err(`caws scope ${mode}: kernel evaluation failed: ${(e as Error).message}`);
    return 2;
  }

  // 6. Render — both modes use the same renderer with the same
  //    boundContext hint so the human-readable nuance for unbound is
  //    consistent.
  out(renderDecision(decision, { boundContext: bound, showData }));

  // 7. Exit per mode
  if (mode === 'show') {
    return 0;
  }
  // mode === 'check'
  return decision.kind === 'admit' ? 0 : 1;
}
