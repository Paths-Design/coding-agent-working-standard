// `caws claim [--takeover]` — surface and (optionally) acquire ownership
// of the current worktree.
//
// Pipeline:
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
//   7. ALWAYS refresh agents.json freshness for the current session
//      via kernel.refreshAgentClaim → applyRegistryPatch.
//   8. Render the Claim panel.
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

import {
  assertOwnership,
  refreshAgentClaim,
  type RegistryPatch,
} from '@paths.design/caws-kernel';

import {
  applyRegistryPatch,
  composeStoreSnapshot,
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
        'Run `caws worktree create <name>` first.'
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
    // takeover_claim from assertOwnership). Apply it.
    const applyResult = applyRegistryPatch(cawsDir, patch);
    if (!applyResult.ok) {
      err('caws claim: failed to apply takeover patch.');
      err(renderDiagnostics(applyResult.errors, { showData }));
      return 2;
    }
  }

  // 7. Refresh agents.json — even when ownership was already ours.
  //    Visible references to lifecycle verbs refresh agents.json so
  //    freshness display stays current independent of IDE hooks.
  //    refreshAgentClaim only fails on a malformed session shape; we
  //    just validated this session via resolveSession, so Err here
  //    would be a real bug. Treat it as exit 2.
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
