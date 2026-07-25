/**
 * Successor resolution — CAWS's first cross-spec reference check.
 *
 * BOUNDARY (CAWS-SPEC-SUCCESSOR-DECLARATION-CUSTODY-01). This module is an
 * EXISTENCE ORACLE, not a graph authority. Its entire job is:
 *   - exact-id lookup of a successor target against the spec corpus, and
 *   - live-vs-archive ambiguity detection.
 *
 * Explicitly out of scope, and deliberately so: dependency ordering, cycle
 * analysis beyond the direct self-reference already caught in
 * validate-semantics, any requirement that a successor COMPLETE, retroactive
 * mutation, and heuristic prose inference anywhere in the blocking path.
 * General supersedes/superseded_by graph integrity may reuse this substrate
 * in a later slice; it must not be absorbed into this one.
 *
 * PURITY. Nothing here touches the filesystem. The corpus is INJECTED by the
 * caller (the CLI's close preflight builds it by reading .caws/specs). That
 * keeps the kernel's parse -> shape -> semantics pipeline free of ambient
 * repository state, so `caws specs validate <file>` returns the same verdict
 * for the same bytes everywhere.
 *
 * CUSTODY, NOT COMPLETION. Resolution asks whether the obligation was made
 * GOVERNABLE — whether a human authored a spec to carry it — not whether that
 * work is finished. A draft, active, closed, or abandoned target all resolve
 * AUTHORED. Target standing rides along as EVIDENCE on the result; it never
 * gates the predecessor's close and is never copied into the source spec.
 */

import { SUCCESSOR_DISPOSITIONS } from './types';
import type { LifecycleState, Resolution, Spec, Successor } from './types';

/** Canonical CAWS spec-id grammar. Mirrors the pattern in spec.v1.json. */
const SPEC_ID_PATTERN = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d+[a-z]*$/;

/**
 * Closed result vocabulary, deliberately DISJOINT from SuccessorDisposition.
 *
 * A disposition is a decision a human made about an obligation. A resolution
 * outcome is a fact about the corpus. Collapsing the two axes is the exact
 * drift this slice exists to prevent — see the two-axis invariant.
 *
 * REGISTRY_UNAVAILABLE is separate from UNAUTHORED on purpose: "I cannot tell"
 * and "it does not exist" are different facts, and a close gate that treats an
 * unreadable corpus as proof of absence would wave through the very obligation
 * it governs.
 */
export const SUCCESSOR_RESOLUTIONS = [
  'AUTHORED',
  'UNAUTHORED',
  'MALFORMED_ID',
  'AMBIGUOUS_ID',
  'REGISTRY_UNAVAILABLE',
] as const;
export type SuccessorResolution = (typeof SUCCESSOR_RESOLUTIONS)[number];

/**
 * Target standing, attached to an AUTHORED result as evidence.
 *
 * This is READ from the target at query time and never written back into the
 * declaring spec. It exists so callers can REPORT what they found, not so the
 * gate can branch on completion.
 */
export interface SuccessorTargetStanding {
  lifecycle_state: LifecycleState;
  resolution?: Resolution;
  /** True when the target was found in the archive rather than the live set. */
  archived: boolean;
}

export interface SuccessorTargetResult {
  outcome: SuccessorResolution;
  /** The id that was looked up, echoed for diagnostics. */
  target_spec_id: string;
  /** Present only when outcome is AUTHORED. Evidence, never authority. */
  standing?: SuccessorTargetStanding;
  /** Present for AMBIGUOUS_ID: where the id was found more than once. */
  ambiguous_sources?: string[];
}

/** One entry of the injected corpus. */
export interface SpecCorpusEntry {
  id: string;
  lifecycle_state: LifecycleState;
  resolution?: Resolution;
  archived: boolean;
  /** Where this entry came from, for ambiguity diagnostics. */
  source?: string;
}

export interface SuccessorResolver {
  resolve(specId: string): SuccessorTargetResult;
}

/**
 * Build a resolver over an in-memory corpus.
 *
 * Indexing is done ONCE here rather than per-lookup: a close over a
 * 2,500-spec corpus (Sterling's real size) must not degrade to an O(n^2)
 * walk, which is a stated reliability requirement of the governing spec.
 *
 * Passing `undefined` for `entries` models a corpus that could not be read,
 * and yields REGISTRY_UNAVAILABLE for every lookup. This is how the close
 * gate distinguishes an unreadable repository from a genuinely missing
 * target instead of silently downgrading to local-only validation.
 */
export function createSuccessorResolver(
  entries: readonly SpecCorpusEntry[] | undefined,
): SuccessorResolver {
  if (entries === undefined) {
    return {
      resolve(specId: string): SuccessorTargetResult {
        return { outcome: 'REGISTRY_UNAVAILABLE', target_spec_id: specId };
      },
    };
  }

  // id -> every entry carrying it. Multiple entries mean the same id exists
  // in more than one place (e.g. live AND archive), which is a corpus
  // integrity problem the caller must see rather than have silently resolved
  // by precedence.
  const index = new Map<string, SpecCorpusEntry[]>();
  for (const entry of entries) {
    const existing = index.get(entry.id);
    if (existing === undefined) {
      index.set(entry.id, [entry]);
    } else {
      existing.push(entry);
    }
  }

  return {
    resolve(specId: string): SuccessorTargetResult {
      // A malformed id is a different failure from a missing one: the schema
      // should have rejected it upstream, so reaching here means the caller
      // bypassed validation. Say so precisely rather than reporting "not
      // found", which would send the operator hunting for a spec that could
      // never have existed.
      if (!SPEC_ID_PATTERN.test(specId)) {
        return { outcome: 'MALFORMED_ID', target_spec_id: specId };
      }

      const found = index.get(specId);
      if (found === undefined || found.length === 0) {
        return { outcome: 'UNAUTHORED', target_spec_id: specId };
      }

      if (found.length > 1) {
        return {
          outcome: 'AMBIGUOUS_ID',
          target_spec_id: specId,
          ambiguous_sources: found.map(
            (entry, i) => entry.source ?? `${entry.archived ? 'archive' : 'live'}[${i}]`,
          ),
        };
      }

      const entry = found[0];
      if (entry === undefined) {
        return { outcome: 'UNAUTHORED', target_spec_id: specId };
      }

      const standing: SuccessorTargetStanding = {
        lifecycle_state: entry.lifecycle_state,
        archived: entry.archived,
      };
      // Assigned conditionally: under exactOptionalPropertyTypes an explicit
      // `undefined` is not the same as an absent key.
      if (entry.resolution !== undefined) standing.resolution = entry.resolution;

      return { outcome: 'AUTHORED', target_spec_id: specId, standing };
    },
  };
}

/**
 * A single unmet obligation found during close preflight.
 *
 * `field` distinguishes which reference failed, because an entry can carry
 * two resolvable ids (target_spec_id and absorbed_by) and an operator fixing
 * the wrong one is a real failure mode.
 */
export interface UnresolvedObligation {
  index: number;
  field: 'target_spec_id' | 'absorbed_by';
  target_spec_id: string;
  outcome: SuccessorResolution;
}

/**
 * Which successor references must resolve before a spec may close.
 *
 * The custody rule, stated once:
 *   - `required`  -> target_spec_id must resolve.
 *   - `absorbed`  -> absorbed_by must resolve (target_spec_id is the PROPOSED
 *                    successor that was never authored — demanding it resolve
 *                    would defeat the purpose of the disposition).
 *   - `declined`  -> nothing must resolve; the rationale carries the decision.
 *
 * Any outcome other than AUTHORED blocks — including REGISTRY_UNAVAILABLE.
 * The caller renders the distinction; the gate refuses either way, because
 * admitting a close over an unreadable corpus would be a guard that lies.
 */
export function findUnresolvedObligations(
  successors: readonly Successor[] | undefined,
  resolver: SuccessorResolver,
): UnresolvedObligation[] {
  if (successors === undefined) return [];

  const unresolved: UnresolvedObligation[] = [];

  successors.forEach((successor, index) => {
    if (successor.disposition === 'required') {
      const result = resolver.resolve(successor.target_spec_id);
      if (result.outcome !== 'AUTHORED') {
        unresolved.push({
          index,
          field: 'target_spec_id',
          target_spec_id: successor.target_spec_id,
          outcome: result.outcome,
        });
      }
      return;
    }

    if (successor.disposition === 'absorbed' && successor.absorbed_by !== undefined) {
      const result = resolver.resolve(successor.absorbed_by);
      if (result.outcome !== 'AUTHORED') {
        unresolved.push({
          index,
          field: 'absorbed_by',
          target_spec_id: successor.absorbed_by,
          outcome: result.outcome,
        });
      }
    }
  });

  return unresolved;
}

/**
 * Project a spec's successor declarations for the spec_closed event payload.
 *
 * Returns a structural copy: every entry, in order, with disposition,
 * rationale, and absorbed_by intact. A projection that keeps ids and drops
 * rationale would pass a naive test and destroy the audit record, so the
 * copy is explicit rather than a field pick.
 *
 * Target standing is NOT projected. The event records what the author
 * DECIDED; what the target's state happened to be at close time is derivable
 * from the target's own history and would go stale here.
 */
export function projectSuccessorsForEvent(spec: Spec): Successor[] | undefined {
  if (spec.successors === undefined) return undefined;

  return spec.successors.map((successor) => {
    const projected: Successor = {
      target_spec_id: successor.target_spec_id,
      disposition: successor.disposition,
    };
    if (successor.rationale !== undefined) projected.rationale = successor.rationale;
    if (successor.absorbed_by !== undefined) projected.absorbed_by = successor.absorbed_by;
    return projected;
  });
}

/** Re-exported so callers validating disposition values need one import. */
export { SUCCESSOR_DISPOSITIONS };
