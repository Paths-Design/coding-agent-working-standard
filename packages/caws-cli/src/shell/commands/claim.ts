// `caws claim [--takeover] [--paths <path>...]` — surface and (optionally)
// acquire ownership of the current worktree, and (optionally) update the
// current session's lease claimed_paths.
//
// Pipeline (--paths absent):
//   1. resolveRepoRoot(cwd)
//   2. composeStoreSnapshot (worktrees + agents + specs)
//   3. resolveCallerSession                           — mint only for explicit takeover
//   4. resolveBinding(cwd, registry, specs)        — identify the worktree
//   5. kernel.assertOwnership(registry, name, session, { takeover }, now)
//      → Ok(null)             — same-session, no patch
//      → Ok(takeover_claim)   — foreign + --takeover; prior_owners audit
//      → Err                  — foreign without --takeover, OR unowned
//                              (unowned is a soft block; caller must use
//                              `caws worktree create`/`bind` to mint)
//   6. If a patch was returned, applyRegistryPatch (atomic write to
//      worktrees.json). prior_owners is append-only.
//   7. Refresh agents.json freshness for the current session via
//      kernel.refreshAgentClaim → applyRegistryPatch.
//   8. Render the Claim panel.
//
// Pipeline (--paths present — leases-only branch, A8 negative lock):
//   1–6. As above (ownership semantics MUST be preserved before any lease
//        write — refusing or taking over still happens first).
//   7'.  SKIP refreshAgentClaim entirely. The --paths branch must NOT
//        read, create, or write .caws/agents.json. The lease substrate
//        is the sole storage target.
//   7b.  loadLeases → updateAgentLeasePaths → applyLeasePatch. On any
//        failure exit 1 with a typed diagnostic.
//   8.   Render the Claim panel.
//
// Exit codes:
//   0 = ownership is established for the current session (same-session
//       Ok or successful takeover)
//   1 = foreign owner without --takeover, or unowned worktree, or kernel
//       refused for any reason
//   2 = repo-root / session / store composition failure, or cwd is not
//       inside a tracked worktree
//
// Authority discipline (load-bearing):
//   - worktrees.json[name].owner is the SOLE ownership authority.
//   - agents.json last-active is freshness/display only.
//   - Stale heartbeat is NOT abandonment.
//   - prior_owners is unbounded, append-only on takeover.
//
// Takeover emits claim_taken_over in the same transaction as the ownership
// update. Same-session refresh emits no takeover event.

import * as fs from 'fs';
import * as path from 'path';

import {
  assertOwnership,
  refreshAgentClaim,
  updateAgentLeasePaths,
  type RegistryPatch,
} from '../../kernel';

import {
  applyLeasePatch,
  applyRegistryPatch,
  composeStoreSnapshot,
  acquireBridge,
  takeoverBridge,
  releaseBridge,
  loadLeases,
  resolveRepoRoot,
} from '../../store';
import { loadSpecs } from '../../store/specs-store';
import { loadWorktrees } from '../../store/worktrees-store';
import { buildActor } from '../session/actor';
// Imported from the writer directly rather than the store barrel, matching how
// specs.ts reaches specs-writer. The takeover's registry write and its audit
// append must be ONE transaction, so the composition lives in the store layer.
import { applyTakeoverWithAudit } from '../../store/worktrees-writer';
import { resolveBinding } from '../binding/resolve-binding';
import { renderClaimPanel, classifyOwnership } from '../render/claim';
import { renderDiagnostics } from '../render/diagnostic';
import { emitPeerPresence } from '../render/peer-presence';
import { resolveCallerSession } from '../session/resolve-session';
import type { ResolvedSession } from '../session/types';

function surfaceMintedContinuation(session: ResolvedSession, out: (line: string) => void): void {
  if (session.source !== 'minted') return;
  const quoted = "'" + session.identity.session_id.replaceAll("'", "'\\''") + "'";
  out(`Continue in this shell: export CAWS_SESSION_ID=${quoted}`);
}

export interface ClaimCommandOptions {
  readonly takeover?: boolean;
  readonly plan?: boolean;
  readonly json?: boolean;
  readonly releasePaths?: boolean;
  readonly apply?: boolean;
  /**
   * AUTH-BINDING-BRIDGE-001: bridge acquire/takeover target. With --release,
   * names the binding to release; bare --release releases every owned
   * binding. Without --release, acquires (or refreshes) the bridge for the
   * active spec --spec names.
   */
  readonly spec?: string;
  /** AUTH-BINDING-BRIDGE-001: release bridge binding(s) owned by this session. */
  readonly release?: boolean;
  readonly cwd?: string;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  /** Heartbeat-stale TTL in ms; display only. Default 24h. */
  readonly staleTtlMs?: number;
  /** Show optional `data` block on rendered diagnostics. */
  readonly showData?: boolean;
  /**
   * SESSION-OWNERSHIP-METADATA-001 commit 3: explicit claim of paths
   * on the current session's lease (.caws/leases/<safe-session-id>.json).
   * When present and non-empty, the command performs a post-ownership
   * update_lease_paths apply that REPLACES the lease's claimed_paths
   * field with this exact list (verbatim, in caller order). When
   * undefined or empty array NOT supplied, the existing claim behavior
   * is unchanged — agents.json refresh runs, no lease update happens.
   * Empty array IS a valid explicit "no claims" declaration that
   * replaces any prior claimed_paths.
   *
   * No glob expansion. No normalization. The kernel validates
   * non-empty / no-null-byte and refuses with no write if no lease
   * exists for the current session (LEASE_NOT_FOUND).
   */
  readonly paths?: readonly string[];
}

interface ClaimPlanDocument {
  readonly ok: boolean;
  readonly read_only: boolean;
  readonly command: 'claim';
  readonly mode: 'claim' | 'takeover' | 'release-paths';
  readonly repo_root: string;
  readonly worktree_name: string;
  readonly current_session: {
    readonly session_id: string;
    readonly platform?: string;
  };
  readonly current_owner: {
    readonly session_id: string;
    readonly platform?: string;
  } | null;
  readonly ownership_relation: 'you' | 'foreign' | 'unowned';
  readonly refusal?: string;
  readonly takeover?: {
    readonly would_apply: boolean;
    readonly prior_owner_to_append: {
      readonly session_id: string;
      readonly platform?: string;
      readonly last_seen?: string;
      readonly takenOver_at: string;
    } | null;
    readonly resulting_owner: {
      readonly session_id: string;
      readonly platform?: string;
    };
    readonly prior_owner_count_before: number;
    readonly prior_owner_count_after: number;
  };
  readonly release_paths?: {
    readonly apply: boolean;
    readonly lease_found: boolean;
    readonly current_claimed_paths: readonly string[];
    readonly would_clear_count: number;
    readonly wrote?: boolean;
  };
  readonly next_apply_command?: string;
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * CLAIM-TAKEOVER-CD-PHANTOM-001: decide whether the invoking session's STABLE
 * root contradicts the target worktree — the run-002 cd-phantom shape.
 *
 * `caws claim` resolves the worktree from the process cwd (a shell `cd` into
 * `.caws/worktrees/<wt>` is enough to satisfy that). But the worktree-write-
 * guard keys file-write authority on CLAUDE_PROJECT_DIR, which always points at
 * the canonical main checkout even after a one-off `cd` (a `cd` in one Bash call
 * does NOT move the session's Edit/Write tool context). So a takeover driven
 * from `cd <wt> && caws claim <wt> --takeover` registers ownership the guard
 * will never honor — a phantom claim.
 *
 * The session-stable root is the harness project-dir env var. Claude Code uses
 * CLAUDE_PROJECT_DIR; Codex uses CODEX_PROJECT_DIR. The contradiction exists
 * only when one is PRESENT and resolves to a path that is neither the worktree
 * itself nor inside it. When neither is present, no contradicting root is
 * asserted (e.g. a plain shell genuinely operating in the worktree) and the
 * takeover proceeds unchanged.
 *
 * Returns the env var name and resolved session root (for the error message)
 * when a phantom is detected, else null.
 */
function detectPhantomSessionRoot(
  env: NodeJS.ProcessEnv,
  worktreePath: string | undefined
): { varName: string; root: string } | null {
  const projectDirEntries = [
    ['CLAUDE_PROJECT_DIR', env['CLAUDE_PROJECT_DIR']],
    ['CODEX_PROJECT_DIR', env['CODEX_PROJECT_DIR']],
  ] as const;
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) return null;
  const wtReal = safeRealpath(worktreePath);
  for (const [varName, projectDir] of projectDirEntries) {
    if (typeof projectDir !== 'string' || projectDir.length === 0) continue;
    const rootReal = safeRealpath(projectDir);
    // Genuinely rooted in (or at) the worktree -> not a phantom.
    if (rootReal === wtReal) continue;
    if (rootReal.startsWith(wtReal + path.sep)) continue;
    // Project-dir points somewhere else (canonical main, a sibling, ...) ->
    // the worktree match came from a transient cwd, not the session root.
    return { varName, root: rootReal };
  }
  return null;
}

function identityPayload(session: {
  readonly session_id: string;
  readonly platform?: string;
}): { readonly session_id: string; readonly platform?: string } {
  return {
    session_id: session.session_id,
    ...(session.platform !== undefined ? { platform: session.platform } : {}),
  };
}

function renderClaimPlan(plan: ClaimPlanDocument): string {
  const lines: string[] = [];
  lines.push(
    plan.read_only
      ? 'caws claim plan: read-only preview; no changes made.'
      : 'caws claim release: applied lease path release.'
  );
  lines.push(`worktree: ${plan.worktree_name}`);
  lines.push(`mode: ${plan.mode}`);
  lines.push(`current session: ${plan.current_session.session_id}`);
  lines.push(
    `current owner: ${plan.current_owner ? plan.current_owner.session_id : 'unowned'}`
  );
  lines.push(`ownership: ${plan.ownership_relation}`);
  if (plan.refusal) lines.push(`refusal: ${plan.refusal}`);

  if (plan.takeover) {
    lines.push('');
    lines.push('Takeover impact:');
    lines.push(`  would apply takeover: ${plan.takeover.would_apply ? 'yes' : 'no'}`);
    lines.push(
      `  prior owners: ${plan.takeover.prior_owner_count_before} -> ${plan.takeover.prior_owner_count_after}`
    );
    if (plan.takeover.prior_owner_to_append) {
      lines.push(
        `  prior owner to append: ${plan.takeover.prior_owner_to_append.session_id}`
      );
    }
    lines.push(`  resulting owner: ${plan.takeover.resulting_owner.session_id}`);
  }

  if (plan.release_paths) {
    lines.push('');
    lines.push('Lease path claims:');
    lines.push(`  lease found: ${plan.release_paths.lease_found ? 'yes' : 'no'}`);
    lines.push(`  current claimed paths: ${plan.release_paths.current_claimed_paths.length}`);
    for (const p of plan.release_paths.current_claimed_paths) {
      lines.push(`    - ${p}`);
    }
    lines.push(`  would clear: ${plan.release_paths.would_clear_count}`);
    if (plan.release_paths.wrote !== undefined) {
      lines.push(`  wrote: ${plan.release_paths.wrote ? 'yes' : 'no'}`);
    }
  }

  if (plan.next_apply_command) {
    lines.push('');
    lines.push(`Next apply command: ${plan.next_apply_command}`);
  }
  return lines.join('\n');
}

function emitClaimPlan(
  plan: ClaimPlanDocument,
  opts: ClaimCommandOptions,
  out: (line: string) => void
): void {
  if (opts.json === true) {
    out(JSON.stringify(plan, null, 2));
    return;
  }
  out(renderClaimPlan(plan));
}

export function runClaimCommand(opts: ClaimCommandOptions = {}): number {
  const cwd = opts.cwd ?? process.cwd();
  const nowFn = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;
  const wantsTakeover = opts.takeover === true;
  const wantsPlan = opts.plan === true;
  const wantsReleasePaths = opts.releasePaths === true;
  const wantsApply = opts.apply === true;
  const isReadOnly = wantsPlan || (wantsReleasePaths && !wantsApply);

  if (opts.json === true && !wantsPlan && !wantsReleasePaths) {
    err('caws claim: --json is only supported with --plan or --release-paths.');
    return 2;
  }
  if (wantsApply && !wantsReleasePaths) {
    err('caws claim: --apply is only supported with --release-paths.');
    return 2;
  }
  if (wantsPlan && wantsApply) {
    err('caws claim: --plan and --apply cannot be combined.');
    return 2;
  }
  if (wantsReleasePaths && opts.paths !== undefined) {
    err('caws claim: --release-paths cannot be combined with --paths.');
    return 2;
  }
  if (wantsReleasePaths && wantsTakeover) {
    err('caws claim: --release-paths cannot be combined with --takeover.');
    return 2;
  }

  // ─── AUTH-BINDING-BRIDGE-001: bridge dispatch ─────────────────────────
  // --spec/--release route to the bridge store BEFORE any worktree logic —
  // a bridge claim is session↔spec authority with no worktree in play.
  if (opts.spec !== undefined || opts.release === true) {
    return runClaimBridgeDispatch(opts, {
      cwd, nowFn, env, out, err, showData, json: opts.json === true,
    });
  }

  // 1. Repo root.
  const repoRootResult = resolveRepoRoot(cwd);
  if (!repoRootResult.ok) {
    err('caws claim: failed to resolve repo root.');
    err(renderDiagnostics(repoRootResult.errors, { showData }));
    return 2;
  }
  const { repoRoot, cawsDir } = repoRootResult.value;

  // 2. Snapshot (we want both worktrees AND agents).
  let snapshot: ReturnType<typeof composeStoreSnapshot>;
  try {
    snapshot = composeStoreSnapshot({ repoRoot, cawsDir });
  } catch (e) {
    err(`caws claim: store composition failed: ${(e as Error).message}`);
    return 2;
  }

  // 3. A normal claim must identify the caller before comparing ownership.
  // Minting here would create a second identity after a no-env create/enter.
  // Only an explicit takeover may establish a new identity; ordinary entry
  // carries the context printed by create or supplied by the native harness.
  const sessionResult = resolveCallerSession({
    cawsDir,
    worktreeRoot: cwd,
    env,
    now: nowFn,
    allowMint: wantsTakeover && !isReadOnly && !wantsReleasePaths,
  });
  if (!sessionResult.ok) {
    err('caws claim: failed to resolve session identity.');
    err(renderDiagnostics(sessionResult.errors, { showData }));
    return 2;
  }
  const session = sessionResult.value.identity;

  // PRESENCE-DECISION-POINT-INJECTION-001: advisory peer block at the
  // authority decision point — only on the MUTATING paths (claim/takeover/
  // --paths/--release-paths --apply); --plan and dry-run release-paths stay
  // byte-identical to the pre-change read-only output. Render-only, fail-open.
  if (!isReadOnly) {
    emitPeerPresence({
      cawsDir,
      now: nowFn(),
      selfSessionId: session.session_id,
      out,
    });
  }

  // 4. Binding from cwd.
  const bound = resolveBinding({
    repoRoot,
    cwd,
    registry: snapshot.worktrees,
    specs: snapshot.specs,
  });
  if (bound.worktreeName === undefined) {
    err(
      'caws claim: cwd is not inside a CAWS-tracked worktree. ' +
        'cd into a worktree under .caws/worktrees/<name>, or create one with ' +
        '`caws worktree create <name> --spec <spec-id>`. Run `caws worktree list` ' +
        'to see registered worktrees.'
    );
    return 2;
  }
  const worktreeName = bound.worktreeName;
  const record = snapshot.worktrees[worktreeName];
  if (record === undefined) {
    // This should not happen if resolveBinding said we are in a tracked
    // worktree — but be defensive: if the registry lost the entry
    // between the bound resolution and now, treat as a composition error.
    err(
      `caws claim: worktree '${worktreeName}' not in worktrees.json (registry race).`
    );
    return 2;
  }

  // 5. Kernel ownership decision.
  const now = nowFn();
  // Never let a neighboring capsule/envelope speak for a different resolved
  // caller. Claim admission and its audit/rendering must use the same identity.
  const ownershipResult = assertOwnership(
    snapshot.worktrees,
    worktreeName,
    session,
    {
      takeover: wantsTakeover,
    },
    now
  );

  // 6. Apply takeover patch if the kernel emitted one. assertOwnership
  // never silently mints unowned-→-owned; if the kernel refused, we
  // surface that as exit 1.
  if (!ownershipResult.ok) {
    if (wantsPlan || wantsReleasePaths) {
      const plan: ClaimPlanDocument = {
        ok: false,
        read_only: isReadOnly,
        command: 'claim',
        mode: wantsReleasePaths ? 'release-paths' : wantsTakeover ? 'takeover' : 'claim',
        repo_root: repoRoot,
        worktree_name: worktreeName,
        current_session: identityPayload(session),
        current_owner:
          record.owner !== undefined ? identityPayload(record.owner) : null,
        ownership_relation: classifyOwnership(record, session),
        refusal: ownershipResult.errors.map((d) => d.message).join('; '),
      };
      emitClaimPlan(plan, opts, out);
      return 1;
    }
    err('caws claim: ownership refused.');
    err(renderDiagnostics(ownershipResult.errors, { showData }));
    // Show the current claim panel so the caller can see who holds it.
    const ownerLine = renderClaimPanel({
      worktreeName,
      worktreeRecord: record,
      ...(record.owner !== undefined && snapshot.agents[record.owner.session_id] !== undefined
        ? { agentRecord: snapshot.agents[record.owner.session_id]! }
        : {}),
      currentSession: session,
      now,
      ...(opts.staleTtlMs !== undefined ? { staleTtlMs: opts.staleTtlMs } : {}),
    });
    err('');
    err(ownerLine);
    return 1;
  }

  const patch: RegistryPatch | null = ownershipResult.value;
  const relation = classifyOwnership(record, session);

  if (wantsPlan) {
    let refusal: string | undefined;
    if (patch !== null) {
      const phantomRoot = detectPhantomSessionRoot(env, record.path);
      if (phantomRoot !== null) {
        refusal =
          `phantom-root takeover: ${phantomRoot.varName}=${phantomRoot.root} is not worktree '${worktreeName}'`;
      }
    }
    const priorCount = record.prior_owners?.length ?? 0;
    const plan: ClaimPlanDocument = {
      ok: refusal === undefined,
      read_only: true,
      command: 'claim',
      mode: wantsTakeover ? 'takeover' : 'claim',
      repo_root: repoRoot,
      worktree_name: worktreeName,
      current_session: identityPayload(session),
      current_owner: record.owner !== undefined ? identityPayload(record.owner) : null,
      ownership_relation: relation,
      ...(refusal ? { refusal } : {}),
      takeover: {
        would_apply: patch !== null && refusal === undefined,
        prior_owner_to_append:
          patch !== null && patch.kind === 'takeover_claim'
            ? {
                session_id: patch.prior_owner.session_id,
                ...(patch.prior_owner.platform !== undefined
                  ? { platform: patch.prior_owner.platform }
                  : {}),
                ...(patch.prior_owner.last_seen !== undefined
                  ? { last_seen: patch.prior_owner.last_seen }
                  : {}),
                takenOver_at: patch.prior_owner.takenOver_at,
              }
            : null,
        resulting_owner: identityPayload(
          patch !== null && patch.kind === 'takeover_claim' ? patch.owner : session
        ),
        prior_owner_count_before: priorCount,
        prior_owner_count_after:
          patch !== null && patch.kind === 'takeover_claim' && refusal === undefined
            ? priorCount + 1
            : priorCount,
      },
      ...(patch !== null && refusal === undefined
        ? { next_apply_command: 'caws claim --takeover' }
        : {}),
    };
    emitClaimPlan(plan, opts, out);
    return plan.ok ? 0 : 1;
  }

  if (wantsReleasePaths) {
    const leasesResult = loadLeases(cawsDir);
    if (!leasesResult.ok) {
      err('caws claim: --release-paths: failed to load leases.');
      err(renderDiagnostics(leasesResult.errors, { showData }));
      return 1;
    }
    const lease = leasesResult.value.leases[session.session_id];
    const currentClaimedPaths = Array.isArray(lease?.claimed_paths)
      ? lease.claimed_paths.filter((p): p is string => typeof p === 'string')
      : [];
    const patchResult = updateAgentLeasePaths(leasesResult.value.leases, session, {
      claimed_paths: [],
    });
    if (!patchResult.ok) {
      const plan: ClaimPlanDocument = {
        ok: false,
        read_only: !wantsApply,
        command: 'claim',
        mode: 'release-paths',
        repo_root: repoRoot,
        worktree_name: worktreeName,
        current_session: identityPayload(session),
        current_owner: record.owner !== undefined ? identityPayload(record.owner) : null,
        ownership_relation: relation,
        refusal: patchResult.errors.map((d) => d.message).join('; '),
        release_paths: {
          apply: wantsApply,
          lease_found: lease !== undefined,
          current_claimed_paths: currentClaimedPaths,
          would_clear_count: currentClaimedPaths.length,
        },
        ...(wantsApply ? {} : { next_apply_command: 'caws claim --release-paths --apply' }),
      };
      emitClaimPlan(plan, opts, out);
      return 1;
    }

    let wrote: boolean | undefined;
    if (wantsApply) {
      const applyPathsResult = applyLeasePatch(cawsDir, patchResult.value);
      if (!applyPathsResult.ok) {
        err('caws claim: --release-paths: lease apply failed.');
        err(renderDiagnostics(applyPathsResult.errors, { showData }));
        return 1;
      }
      if (applyPathsResult.value.diagnostics.length > 0) {
        err('caws claim: --release-paths: lease apply produced diagnostics.');
        err(renderDiagnostics(applyPathsResult.value.diagnostics, { showData }));
        if (!applyPathsResult.value.wrote) return 1;
      }
      wrote = applyPathsResult.value.wrote;
    }

    const plan: ClaimPlanDocument = {
      ok: true,
      read_only: !wantsApply,
      command: 'claim',
      mode: 'release-paths',
      repo_root: repoRoot,
      worktree_name: worktreeName,
      current_session: identityPayload(session),
      current_owner: record.owner !== undefined ? identityPayload(record.owner) : null,
      ownership_relation: relation,
      release_paths: {
        apply: wantsApply,
        lease_found: lease !== undefined,
        current_claimed_paths: currentClaimedPaths,
        would_clear_count: currentClaimedPaths.length,
        ...(wrote !== undefined ? { wrote } : {}),
      },
      ...(wantsApply ? {} : { next_apply_command: 'caws claim --release-paths --apply' }),
    };
    emitClaimPlan(plan, opts, out);
    return 0;
  }

  if (patch !== null) {
    // Patch must be a takeover_claim (the kernel only emits null or a
    // takeover_claim from assertOwnership). Before applying it, refuse a
    // cd-phantom takeover (CLAIM-TAKEOVER-CD-PHANTOM-001): if the session's
    // stable root (CLAUDE_PROJECT_DIR) is not the target worktree, the worktree
    // match came from a transient `cd` and the registered ownership would be
    // unexercisable (the write-guard keys on CLAUDE_PROJECT_DIR). Refuse rather
    // than mint a phantom owner.
    const phantomRoot = detectPhantomSessionRoot(env, record.path);
    if (phantomRoot !== null) {
      err('caws claim: refusing a phantom-root takeover.');
      err(
        `  Your session root (${phantomRoot.varName}=${phantomRoot.root}) is not the ` +
          `worktree '${worktreeName}'. A one-off shell \`cd\` into the worktree ` +
          `does NOT root your session there — the Write/Edit guard still keys ` +
          `file authority on the harness project root, so this takeover would register ` +
          `ownership you cannot exercise (a phantom claim).`
      );
      err(
        `  To take over '${worktreeName}', run caws claim from a SESSION rooted ` +
          `in that worktree (open the worktree as your session root), not a ` +
          `transient cd from the main checkout.`
      );
      err('');
      const ownerLine = renderClaimPanel({
        worktreeName,
        worktreeRecord: record,
        ...(record.owner !== undefined &&
        snapshot.agents[record.owner.session_id] !== undefined
          ? { agentRecord: snapshot.agents[record.owner.session_id]! }
          : {}),
        currentSession: session,
        now,
        ...(opts.staleTtlMs !== undefined ? { staleTtlMs: opts.staleTtlMs } : {}),
      });
      err(ownerLine);
      return 1;
    }

    // Apply the takeover AND its audit event in one transaction
    // (CAWS-DEFECT-CLAIM-TAKEOVER-AUDIT-01). Ownership is the highest-authority
    // mutation in the control plane; transferring it with no record of who
    // transferred it is what made the hash chain read as provenance while
    // asserting nothing about authorized ownership continuity.
    //
    // Reached only on the takeover branch: `patch` is non-null exactly when the
    // kernel emitted a takeover_claim. A same-session refresh produces a null
    // patch and never lands here, so `claim_taken_over` means a genuine
    // authority TRANSFER and not a heartbeat.
    //
    // Placed AFTER the phantom-root refusal above so a refused takeover leaves
    // no audit implying it happened.
    const priorOwnerRecord =
      patch.kind === 'takeover_claim' ? patch.prior_owner : undefined;
    const applyResult = applyTakeoverWithAudit(cawsDir, {
      name: worktreeName,
      patch,
      // claim has no --actor-kind option, and the session driving a takeover is
      // by construction the agent/operator at the keyboard. The session id is
      // the identifier that matters here: it is the same value recorded as
      // new_owner, so the actor and the beneficiary are provably one party.
      actor: { kind: 'agent', id: session.session_id, session_id: session.session_id },
      priorOwner: {
        session_id: priorOwnerRecord?.session_id ?? record.owner?.session_id ?? 'unknown',
        ...(priorOwnerRecord?.platform !== undefined
          ? { platform: priorOwnerRecord.platform }
          : {}),
        // Explicit null (not omitted) when the prior session's agent record was
        // already TTL-pruned: the schema models that case, and an absent field
        // would be indistinguishable from "we did not look".
        last_seen: priorOwnerRecord?.last_seen ?? null,
      },
      newOwner: {
        session_id: session.session_id,
        ...(session.platform !== undefined ? { platform: session.platform } : {}),
      },
      ...(record.specId !== undefined ? { specId: record.specId } : {}),
      now: () => now,
    });
    if (!applyResult.ok) {
      err('caws claim: failed to apply takeover patch.');
      err(renderDiagnostics(applyResult.errors, { showData }));
      return 2;
    }
  }

  // 7. Refresh agents.json — ONLY on the legacy `--paths` absent branch.
  //
  // SESSION-OWNERSHIP-METADATA-001 commit 3a (A8 negative lock):
  // The `--paths` branch is leases-only. It MUST NOT read, create, or
  // write .caws/agents.json. Routing through refreshAgentClaim here
  // would re-merge the operational-cache / governance-state boundary
  // the leases substrate exists to preserve (see
  // MULTI-AGENT-ACTIVITY-REGISTRY-001 invariant 2 + spec A8).
  //
  // When `--paths` is absent, behavior is unchanged: visible references
  // to lifecycle verbs refresh agents.json so freshness display stays
  // current independent of IDE hooks. refreshAgentClaim only fails on
  // a malformed session shape; we just validated this session via
  // resolveCallerSession, so Err here would be a real bug. Treat it as exit 2.
  if (opts.paths === undefined) {
    const refreshResult = refreshAgentClaim(snapshot.agents, session, now, {
      bound_worktree: worktreeName,
      ...(record.specId !== undefined ? { bound_spec_id: record.specId } : {}),
    });
    if (!refreshResult.ok) {
      err('caws claim: internal — refreshAgentClaim returned Err with a validated session.');
      err(renderDiagnostics(refreshResult.errors, { showData }));
      return 2;
    }
    const refreshApply = applyRegistryPatch(cawsDir, refreshResult.value);
    if (!refreshApply.ok) {
      // Apply failure is a hygiene problem (disk I/O on agents.json),
      // not an authority problem. Ownership is already secured; surface
      // a warning but continue.
      err('caws claim: warning — agents.json refresh failed (display only).');
      err(renderDiagnostics(refreshApply.errors, { showData }));
    }
  }

  // 7b. SESSION-OWNERSHIP-METADATA-001 commit 3 — explicit claim of
  // paths on the current session's lease. Runs only when --paths was
  // supplied. The agents.json refresh in step 7 is intentionally
  // skipped on this branch (A8 negative lock). Failure of this step
  // does NOT regress ownership; it surfaces as a typed diagnostic and
  // returns exit 1 so the operator sees that the paths were not stored.
  if (opts.paths !== undefined) {
    const leasesResult = loadLeases(cawsDir);
    if (!leasesResult.ok) {
      err('caws claim: --paths: failed to load leases.');
      err(renderDiagnostics(leasesResult.errors, { showData }));
      return 1;
    }
    const patchResult = updateAgentLeasePaths(leasesResult.value.leases, session, {
      claimed_paths: opts.paths,
    });
    if (!patchResult.ok) {
      err('caws claim: --paths: refused.');
      err(renderDiagnostics(patchResult.errors, { showData }));
      return 1;
    }
    const applyPathsResult = applyLeasePatch(cawsDir, patchResult.value);
    if (!applyPathsResult.ok) {
      err('caws claim: --paths: lease apply failed.');
      err(renderDiagnostics(applyPathsResult.errors, { showData }));
      return 1;
    }
    // Surface any warn-no-op diagnostics (missing lease file race
    // between load and apply). Treat as refusal so the operator sees
    // the paths were not stored. wrote=false also means the lease was
    // not fabricated — A8 negative lock holds even on this edge.
    if (applyPathsResult.value.diagnostics.length > 0) {
      err('caws claim: --paths: lease apply produced diagnostics.');
      err(renderDiagnostics(applyPathsResult.value.diagnostics, { showData }));
      if (!applyPathsResult.value.wrote) return 1;
    }
  }

  // 8. Render the Claim panel — re-read the worktree record so it shows
  //    the new owner / prior_owners count after the patch.
  // We don't re-compose the snapshot because the apply functions already
  // wrote to disk; reading the in-memory `record` (pre-patch) would lie.
  // For determinism: reconstruct what the post-patch record looks like
  // from the patch we just applied.
  const renderedRecord =
    patch !== null && patch.kind === 'takeover_claim'
      ? {
          ...record,
          owner: patch.owner,
          last_heartbeat: patch.when,
          prior_owners: [...(record.prior_owners ?? []), patch.prior_owner],
        }
      : record;

  const newRel = classifyOwnership(renderedRecord, session);
  out(
    renderClaimPanel({
      worktreeName,
      worktreeRecord: renderedRecord,
      currentSession: session,
      now,
      ...(opts.staleTtlMs !== undefined ? { staleTtlMs: opts.staleTtlMs } : {}),
    })
  );

  // A successful claim must describe the same caller we authorized above.
  if (newRel === 'you') surfaceMintedContinuation(sessionResult.value, out);
  return newRel === 'you' ? 0 : 1;
}

// ─── AUTH-BINDING-BRIDGE-001: bridge dispatch ──────────────────────────────

interface BridgeDispatchCtx {
  readonly cwd: string;
  readonly nowFn: () => Date;
  readonly env: NodeJS.ProcessEnv;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly showData: boolean;
  readonly json: boolean;
}

/**
 * `caws claim --spec <id>` (acquire/refresh), `caws claim --spec <id>
 * --takeover` (explicit transition), `caws claim --release [--spec <id>]`
 * (relinquish). Worktree bindings WIN over bridges (subordination):
 * acquiring a bridge for a spec with a live worktree binding refuses naming
 * the worktree owner. Non-active specs refuse with their lifecycle
 * handoffs. Exit codes follow the uniform convention (0/1/2).
 */
function runClaimBridgeDispatch(
  opts: ClaimCommandOptions,
  ctx: BridgeDispatchCtx
): number {
  const { out, err, showData, json } = ctx;

  if (opts.release === true && opts.takeover === true) {
    err('caws claim: --release cannot be combined with --takeover.');
    return 1;
  }
  if (opts.spec !== undefined && opts.spec.length === 0) {
    err('caws claim: --spec <id> must be non-empty.');
    return 1;
  }

  const repoRootResult = resolveRepoRoot(ctx.cwd);
  if (!repoRootResult.ok) {
    err('caws claim: failed to resolve repo root.');
    err(renderDiagnostics(repoRootResult.errors, { showData }));
    return 2;
  }
  const { cawsDir } = repoRootResult.value;

  const sessionResult = resolveCallerSession({
    cawsDir,
    worktreeRoot: ctx.cwd,
    env: ctx.env,
    now: ctx.nowFn,
    allowMint: opts.release !== true, // release asserts an existing identity
  });
  if (!sessionResult.ok) {
    err('caws claim: failed to resolve session identity.');
    err(renderDiagnostics(sessionResult.errors, { showData }));
    return 1;
  }
  const session = sessionResult.value.identity;
  const actor = buildActor({
    session: sessionResult.value,
    kind: 'agent',
  });

  // ─── RELEASE ──────────────────────────────────────────────────────────
  if (opts.release === true) {
    const r = releaseBridge(cawsDir, {
      ...(opts.spec !== undefined ? { specId: opts.spec } : {}),
      session,
      actor,
      now: ctx.nowFn(),
    });
    if (!r.ok) {
      err('caws claim --release: refused.');
      err(renderDiagnostics(r.errors, { showData }));
      return 1;
    }
    if (json) {
      out(JSON.stringify({ ok: true, released: r.value.released, session_id: session.session_id }));
    } else {
      out(`released bridge binding(s): ${r.value.released.join(', ')}`);
      out('  (scope admission from these bindings ends now; worktree authority is unaffected.)');
    }
    return 0;
  }

  // ─── ACQUIRE / TAKEOVER (opts.spec is defined here) ───────────────────
  const specId = opts.spec as string;
  const specsResult = loadSpecs(cawsDir);
  const spec = specsResult.specs.find((s) => s.id === specId);
  if (spec === undefined) {
    err(`caws claim --spec: no spec "${specId}" — run \`caws specs list\` for the canonical ids.`);
    return 1;
  }
  if (spec.lifecycle_state !== 'active') {
    err(`caws claim --spec: spec "${specId}" is ${spec.lifecycle_state} — a bridge confers authority only for an ACTIVE spec.`);
    if (spec.lifecycle_state === 'closed') {
      err(`  Resume the work: caws specs reopen ${specId}`);
    } else if (spec.lifecycle_state === 'archived') {
      err(`  Archived body: caws specs show ${specId} --archived  |  recover: caws specs recover ${specId}`);
    } else {
      err(`  Activate it first: caws specs activate ${specId}  (or bind a worktree: caws worktree ensure <name> --spec ${specId}).`);
    }
    return 1;
  }

  // Subordination: one authority holder per spec. A live worktree binding
  // for this spec WINS — refuse the bridge naming the worktree owner.
  const registryResult = loadWorktrees(cawsDir);
  if (!registryResult.ok) {
    err('caws claim --spec: worktree registry unreadable (cannot check subordination).');
    err(renderDiagnostics(registryResult.errors, { showData }));
    return 2;
  }
  for (const [name, record] of Object.entries(registryResult.value)) {
    if (record?.specId === specId) {
      err(`caws claim --spec: spec "${specId}" is held by worktree "${name}" — worktree bindings WIN over bridges (one authority holder per spec).`);
      err(`  Enter the lane instead: cd .caws/worktrees/${name}`);
      const owner = record.owner?.session_id;
      if (owner !== undefined) {
        err(`  Worktree owner: ${owner} (read their session log before any takeover consideration).`);
      }
      return 1;
    }
  }

  if (opts.takeover === true) {
    const t = takeoverBridge(cawsDir, {
      specId,
      session,
      actor,
      now: ctx.nowFn(),
      reason: 'operator-invoked bridge takeover (caws claim --spec --takeover)',
    });
    if (!t.ok) {
      err('caws claim --spec --takeover: refused.');
      err(renderDiagnostics(t.errors, { showData }));
      return 1;
    }
    if (json) {
      out(JSON.stringify({
        ok: true, spec_id: specId,
        prior_owner: t.value.priorOwnerSessionId, session_id: session.session_id,
      }));
    } else {
      out(`bridge for ${specId} taken over from ${t.value.priorOwnerSessionId} (prior_owners audit appended; bridge_claim_taken_over event recorded).`);
      surfaceMintedContinuation(sessionResult.value, out);
    }
    return 0;
  }

  const a = acquireBridge(cawsDir, {
    specId,
    session,
    actor,
    now: ctx.nowFn(),
    contextCwd: ctx.cwd,
  });
  if (!a.ok) {
    err(`caws claim --spec: refused for "${specId}".`);
    err(renderDiagnostics(a.errors, { showData }));
    return 1;
  }
  if (json) {
    out(JSON.stringify({
      ok: true, spec_id: specId, session_id: session.session_id,
      refreshed: a.value.refreshed,
    }));
  } else {
    out(a.value.refreshed
      ? `refreshed bridge for ${specId} (session ${session.session_id})`
      : `bridged ${specId} to session ${session.session_id} (.caws/claims/bridge.json; claim_bridged event recorded).`);
    out("  Scope admission now flows from this binding: the spec's scope.in is your write surface —");
    out('  exactly as a worktree binding enforces it, nothing wider (bridge is authority, not scope expansion).');
    out(`  Release with: caws claim --release --spec ${specId}`);
    surfaceMintedContinuation(sessionResult.value, out);
  }
  return 0;
}
