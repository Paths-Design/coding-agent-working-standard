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

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';

import {
  evaluateContention,
  evaluatePath,
  type ContentionClaimant,
  type Decision,
  type Policy,
} from '@paths.design/caws-kernel';

import { composeStoreSnapshot, resolveRepoRoot } from '../../store';
import { resolveBinding } from '../binding/resolve-binding';
import { renderDecision, renderDecisionJson } from '../render/decision';
import { renderDiagnostics } from '../render/diagnostic';

export type ScopeMode = 'show' | 'check';

export interface ScopeCommandOptions {
  readonly path: string;
  readonly mode: ScopeMode;
  readonly cwd?: string;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly showData?: boolean;
  /**
   * Emit the stable machine-readable JSON contract (one line) instead of the
   * human render. Only meaningful on `show` (CAWS-SCOPE-SHOW-JSON-CONTRACT-001);
   * the hook-facing consumer is scope-guard.sh. Exit codes are unchanged.
   */
  readonly json?: boolean;
}

export function runScopeCommand(opts: ScopeCommandOptions): number {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;
  const asJson = opts.json === true;
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

  // 3. Binding — resolved from the TARGET PATH, not just cwd
  //    (SCOPE-CHECK-CWD-BINDING-RESOLUTION-001). Passing `targetPath` lets
  //    resolveBinding fall back to the path's owning worktree / claiming
  //    spec when cwd is the main checkout, so `caws scope check <path>` is
  //    cwd-independent and matches what the bound author sees.
  const bound = resolveBinding({
    repoRoot,
    cwd,
    targetPath: opts.path,
    registry: snapshot.worktrees,
    specs: snapshot.specs,
  });

  // 3a. Refuse-on-conflict: more than one active bound spec claims this path.
  //     Authority is ambiguous; we do NOT guess. Emit an actionable refusal
  //     that names every claimant, the inspect commands, and the resolution
  //     options, then exit non-zero (check) / 0 with the detail (show).
  if (bound.ambiguous !== undefined) {
    const { targetPath, claimants } = bound.ambiguous;
    // --json: emit the stable contract for the ambiguous case (the kernel does
    // not produce a Decision here — authority is ambiguous by construction —
    // so build the object directly). decision=no_authority + the claimant ids.
    if (asJson && mode === 'show') {
      out(
        JSON.stringify({
          decision: 'no_authority',
          rule: 'scope.no_authority.ambiguous_binding',
          path: targetPath,
          bindingState: 'unbound',
          mode: 'union',
          ambiguousClaimants: claimants.map((c) => c.specId),
          message: `Ambiguous binding: ${claimants.length} active bound specs claim "${targetPath}" via scope.in; CAWS will not guess which governs.`,
        })
      );
      return 0;
    }
    const cwdClaimant =
      bound.worktreeName !== undefined
        ? claimants.find((c) => c.worktreeName === bound.worktreeName)
        : undefined;
    err(`caws scope ${mode}: ambiguous binding for "${targetPath}".`);
    err(
      `  ${claimants.length} active bound specs claim this path via scope.in; CAWS will not guess which governs:`
    );
    for (const c of claimants) {
      const here = cwdClaimant !== undefined && c.specId === cwdClaimant.specId ? ' (current cwd/session)' : '';
      err(`    - ${c.specId} (worktree ${c.worktreeName}) via scope.in "${c.matchedScopeInEntry}"${here}`);
    }
    err('  Inspect each claimant:');
    for (const c of claimants) {
      err(`    caws specs show ${c.specId}`);
    }
    err('  Resolve by EITHER:');
    err('    (a) narrowing one spec\'s scope.in so only one claims this path, OR');
    err('    (b) routing the edit through the single worktree that should own it');
    err('        and removing the path from the other spec\'s scope.in.');
    return 1;
  }

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

  // 6. Render. --json (show only) emits the stable single-line machine
  //    contract for hook consumption (CAWS-SCOPE-SHOW-JSON-CONTRACT-001) and
  //    returns immediately — no human prose, no caveat lines. Otherwise both
  //    modes use the human renderer with the same boundContext hint.
  if (asJson && mode === 'show') {
    out(renderDecisionJson(decision, bound));
    return 0;
  }
  out(renderDecision(decision, { boundContext: bound, showData }));

  // 6a. Worktree-claim caveat (CAWS-SCOPE-CHECK-WORKTREE-CLAIM-CAVEAT-001).
  //     When the binding was resolved because an active worktree's scope.in
  //     CLAIMS the target path (source === 'target_scope_in_claim'), the kernel
  //     admits — the path IS in that spec's scope.in. But the agent is NOT
  //     inside that worktree (cwd-inside resolution wins at steps 1/2 and would
  //     have produced a registry/porcelain source instead). A base-checkout
  //     write to this path will then be HARD-BLOCKED by worktree-write-guard,
  //     which treats a worktree's scope.in entry as a *claim* editable only
  //     from inside that worktree. Without this caveat the green ADMIT silently
  //     contradicts the guard that actually runs on the write — the friction
  //     probe's Event 9. Name the worktree and the cd path so the ADMIT is
  //     honest about where the edit must happen. Exit code is unchanged.
  if (
    decision.kind === 'admit' &&
    bound.source === 'target_scope_in_claim' &&
    typeof bound.worktreeName === 'string'
  ) {
    const wt = bound.worktreeName;
    out(
      `  claimed by worktree '${wt}' — edit it there: cd .caws/worktrees/${wt}`
    );
    out(
      '  (a base-checkout write to this path is blocked by worktree-write-guard;'
    );
    out("   the path's scope.in entry is a worktree claim, not a free pass here.)");
  }

  // 7. Exit per mode
  if (mode === 'show') {
    return 0;
  }
  // mode === 'check'
  return decision.kind === 'admit' ? 0 : 1;
}

// ---------------------------------------------------------------------------
// caws scope contention <path>  (CAWS-SCOPE-CONTENTION-CMD-001)
// ---------------------------------------------------------------------------
// "Which OTHER active worktrees, on this base branch, have a bound active spec
// whose scope.in claims this path?" The kernel `evaluateContention` is the
// single matcher; this command is a thin layer that loads the store snapshot,
// resolves the current branch, and renders. It replaces the inline node -e +
// js-yaml SPEC_CONTENTION_CHECK block worktree-write-guard.sh used to carry.

export interface ScopeContentionOptions {
  readonly path: string;
  readonly cwd?: string;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  /** Emit the stable single-line JSON contract (hook-facing). */
  readonly json?: boolean;
  /** Injectable current-branch resolver (tests). Defaults to git rev-parse. */
  readonly currentBranch?: () => string | undefined;
}

export function runScopeContentionCommand(opts: ScopeContentionOptions): number {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const asJson = opts.json === true;

  const repoRootResult = resolveRepoRoot(cwd);
  if (!repoRootResult.ok) {
    err('caws scope contention: failed to resolve repo root.');
    err(renderDiagnostics(repoRootResult.errors, { showData: false }));
    return 2;
  }
  const { repoRoot, cawsDir } = repoRootResult.value;

  let snapshot: ReturnType<typeof composeStoreSnapshot>;
  try {
    snapshot = composeStoreSnapshot({ repoRoot, cawsDir });
  } catch (e) {
    err(`caws scope contention: store composition failed: ${(e as Error).message}`);
    return 2;
  }

  const branch = resolveCurrentBranch(repoRoot, opts.currentBranch);
  if (branch === undefined) {
    // No branch (detached HEAD / no git): cannot compute base-branch contention.
    // Fail closed — report undetermined, do not claim "clear".
    return emitContention(
      out,
      asJson,
      opts.path,
      { status: 'undetermined', reason: 'missing-scope', worktreeName: '' },
      'current branch could not be resolved'
    );
  }

  const result = evaluateContention({
    path: opts.path,
    worktrees: snapshot.worktrees,
    specs: snapshot.specs,
    currentBranch: branch,
    worktreeExists: (record) => {
      const p =
        typeof record.path === 'string' && record.path.length > 0
          ? record.path
          : nodePath.join(repoRoot, '.caws', 'worktrees', record.name);
      return existsSync(p);
    },
  });

  return emitContention(out, asJson, opts.path, result);
}

function resolveCurrentBranch(
  repoRoot: string,
  injected?: () => string | undefined
): string | undefined {
  if (injected !== undefined) return injected();
  try {
    const b = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    return b.length > 0 && b !== 'HEAD' ? b : undefined;
  } catch {
    return undefined;
  }
}

function emitContention(
  out: (line: string) => void,
  asJson: boolean,
  path: string,
  result: ReturnType<typeof evaluateContention>,
  reasonNote?: string
): number {
  if (asJson) {
    const claimants: readonly ContentionClaimant[] =
      result.status === 'claimed' ? result.claimants : [];
    const payload: Record<string, unknown> = {
      path,
      status: result.status,
      claimants: claimants.map((c) => ({
        worktreeName: c.worktreeName,
        specId: c.specId,
        matchedPattern: c.matchedPattern,
      })),
    };
    if (result.status === 'undetermined') {
      payload['reason'] = reasonNote ?? result.reason;
      if (result.worktreeName.length > 0) payload['worktreeName'] = result.worktreeName;
    }
    out(JSON.stringify(payload));
    return 0;
  }

  if (result.status === 'claimed') {
    out(`CLAIMED ${path}`);
    for (const c of result.claimants) {
      out(`  worktree '${c.worktreeName}' (spec ${c.specId}) via scope.in '${c.matchedPattern}'`);
    }
  } else if (result.status === 'clear') {
    out(`CLEAR ${path} — no other active worktree's spec claims this path`);
  } else {
    out(
      `UNDETERMINED ${path} — ${reasonNote ?? result.reason}` +
        (result.worktreeName.length > 0 ? ` (worktree '${result.worktreeName}')` : '')
    );
  }
  return 0;
}
