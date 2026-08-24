// Advisory peer-presence rendering (PRESENCE-DECISION-POINT-INJECTION-001).
//
// Renders a bounded, fail-open "peer sessions are active" block for the
// authority-mutating decision points (`caws specs activate`, `caws worktree
// create/bind/merge`, `caws claim`). Failure-lineage Entry 36's lesson: the
// visibility substrate only helps the agent that consults it — two sessions
// collided on one slice because neither ran `caws agents list` before
// claiming. This block moves presence to the decision point itself, the way
// the heartbeat hook already does for tool calls.
//
// CONTRACT (spec invariants; every one is test-backed):
//   - Render-only and fail-open: an absent, corrupt, or unreadable lease
//     registry produces NO output and NO new refusal. Exit codes and `.caws/`
//     mutations of the host command are unchanged in every case.
//   - Visibility only: reads leases exactly as `caws agents list` does
//     (kernel TTL classification over the operational cache). No authority
//     path reads this block; doctrine invariant 8 is untouched.
//   - Zero peers => empty string => the host command's output is
//     byte-identical to the pre-change baseline (no noise, no placeholders).
//   - Bounded output (Entry 26 context-overflow class): at most
//     PEER_PRESENCE_MAX_LINES peer lines, then one overflow line handing off
//     to `caws agents list`.
//   - The acting session's own lease is never listed as a peer.

import { summarizeActiveAgents } from '../../kernel';
import { loadLeases } from '../../store';

/** Matches the `caws agents list` stale-classification default. */
const DEFAULT_STALE_TTL_MS = 30 * 60 * 1000;

/** Max peer lines rendered before the overflow handoff (Entry 26 bound). */
export const PEER_PRESENCE_MAX_LINES = 5;

export interface PeerPresenceOptions {
  readonly cawsDir: string;
  readonly now: Date;
  /** The acting session's id — always excluded from the peer list. */
  readonly selfSessionId?: string | undefined;
  /** Heartbeat TTL; defaults to the 30-minute agents-list default. */
  readonly ttlMs?: number | undefined;
}

function describeLease(lease: {
  session_id: string;
  bound_worktree?: string;
  bound_spec_id?: string;
  branch?: string;
}): string {
  const bits: string[] = [];
  if (typeof lease.bound_worktree === 'string' && lease.bound_worktree.length > 0) {
    bits.push(`worktree ${lease.bound_worktree}`);
  }
  if (typeof lease.bound_spec_id === 'string' && lease.bound_spec_id.length > 0) {
    bits.push(`spec ${lease.bound_spec_id}`);
  }
  if (typeof lease.branch === 'string' && lease.branch.length > 0) {
    bits.push(`branch ${lease.branch}`);
  }
  const tag = bits.length > 0 ? ` (${bits.join(', ')})` : '';
  return `  - ${lease.session_id}${tag}`;
}

/**
 * Build the advisory peer block, or '' when there is nothing to say.
 * Deterministic ordering (sorted by session id) so output is testable and
 * stable across calls. Reads operational cache only; mutates nothing.
 */
export function renderPeerPresenceBlock(opts: PeerPresenceOptions): string {
  // Fail-open on both layers: kernel feature-detect (mirrors the agents
  // command's guard) and a lenient/corrupt-or-unreadable lease registry.
  if (typeof summarizeActiveAgents !== 'function') return '';
  const loaded = loadLeases(opts.cawsDir);
  if (!loaded.ok) return '';

  const ttl = opts.ttlMs ?? DEFAULT_STALE_TTL_MS;
  const summary = summarizeActiveAgents(loaded.value.leases, opts.now, ttl);
  const peers = summary.active
    .filter((lease) => lease.session_id !== opts.selfSessionId)
    .sort((a, b) => (a.session_id < b.session_id ? -1 : 1));
  if (peers.length === 0) return '';

  const lines: string[] = [`Advisory: ${peers.length} peer agent session(s) active in this repo:`];
  for (const lease of peers.slice(0, PEER_PRESENCE_MAX_LINES)) {
    lines.push(describeLease(lease));
  }
  if (peers.length > PEER_PRESENCE_MAX_LINES) {
    lines.push(
      `  ... and ${peers.length - PEER_PRESENCE_MAX_LINES} more — run \`caws agents list\``
    );
  }
  lines.push(
    '(Visibility only — ownership lives in .caws/worktrees.json, scope in .caws/specs/. ' +
      'Check `caws agents list` / `caws status` before mutating shared state.)'
  );
  return lines.join('\n');
}

/** One-line call-site helper: render and emit the block when non-empty. */
export function emitPeerPresence(
  opts: PeerPresenceOptions & { readonly out: (line: string) => void }
): void {
  const block = renderPeerPresenceBlock(opts);
  if (block.length > 0) opts.out(block);
}
