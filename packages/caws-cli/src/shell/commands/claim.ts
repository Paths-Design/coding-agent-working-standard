// `caws claim [--takeover] [--paths <path>...]` — surface and (optionally)
// acquire ownership of the current worktree, and (optionally) update the
// current session's lease claimed_paths.
//
// Pipeline (--paths absent — existing legacy behavior, byte-equivalent):
//   1. resolveRepoRoot(cwd)
//   2. composeStoreSnapshot (worktrees + agents + specs)
//   3. resolveSession({ allowMint: true })        — write op, mints if needed
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
// Event emission is OUT OF SCOPE for 6a. The `claim_taken_over` event
// type exists in the kernel schema, but emitting it requires deciding
// the exact payload shape, and that decision belongs with the broader
// claim/worktree event work in a later slice. Same-session refresh
// emits nothing.

import * as fs from 'fs';
import * as path from 'path';

import {
  assertOwnership,
  refreshAgentClaim,
  updateAgentLeasePaths,
  type RegistryPatch,
} from '@paths.design/caws-kernel';

import {
  applyLeasePatch,
  applyRegistryPatch,
  composeStoreSnapshot,
  loadLeases,
  resolveRepoRoot,
} from '../../store';
import { resolveBinding } from '../binding/resolve-binding';
import { renderClaimPanel, classifyOwnership } from '../render/claim';
import { renderDiagnostics } from '../render/diagnostic';
import { resolveSession } from '../session/resolve-session';

export interface ClaimCommandOptions {
  readonly takeover?: boolean;
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

export function runClaimCommand(opts: ClaimCommandOptions = {}): number {
  const cwd = opts.cwd ?? process.cwd();
  const nowFn = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;
  const wantsTakeover = opts.takeover === true;

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

  // 3. Session (write op → mint if missing).
  const sessionResult = resolveSession({
    cawsDir,
    worktreeRoot: cwd,
    env,
    now: nowFn,
    allowMint: true,
  });
  if (!sessionResult.ok) {
    err('caws claim: failed to resolve session identity.');
    err(renderDiagnostics(sessionResult.errors, { showData }));
    return 2;
  }
  const session = sessionResult.value.identity;

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
  const ownershipResult = assertOwnership(
    snapshot.worktrees,
    worktreeName,
    session,
    { takeover: wantsTakeover },
    now
  );

  // 6. Apply takeover patch if the kernel emitted one. assertOwnership
  // never silently mints unowned-→-owned; if the kernel refused, we
  // surface that as exit 1.
  if (!ownershipResult.ok) {
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

    // Apply the takeover.
    const applyResult = applyRegistryPatch(cawsDir, patch);
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
  // resolveSession, so Err here would be a real bug. Treat it as exit 2.
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

  // Same-session OR successful takeover both count as "claim established".
  // The only Ok-but-not-yours case is impossible here: assertOwnership
  // never returns Ok with a foreign owner intact.
  return newRel === 'you' ? 0 : 1;
}
