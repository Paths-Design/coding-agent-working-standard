import { diagnostic } from '../diagnostics';
import type { Diagnostic } from '../diagnostics/types';
import { err, ok } from '../result';
import type { Result } from '../result/types';
import { SPEC_RULES } from './rules';
import type { Spec } from './types';

export interface SemanticOptions {
  sourcePath?: string;
}

/**
 * Tier-gated and lifecycle-shape semantic rules. Runs after the schema
 * has confirmed the structural shape.
 *
 * Out of scope (deferred to lifecycle / worktree / evidence slices):
 * - "cannot close while a worktree is bound"
 * - "evidence must exist before closure"
 * - "supersedes/superseded_by must form a valid graph"
 */
export function validateSpecSemantics(spec: Spec, options: SemanticOptions = {}): Result<Spec> {
  const errors: Diagnostic[] = [];
  const subjectBase = options.sourcePath ?? spec.id;

  // Tier 1+2 require contracts (unless mode === chore).
  // Schema permits empty contracts: [] for tier 3 / chore mode.
  if (spec.mode !== 'chore') {
    if (spec.risk_tier === 1 && spec.contracts.length === 0) {
      errors.push(
        diagnostic({
          rule: SPEC_RULES.TIER1_MISSING_CONTRACTS,
          authority: 'kernel/spec',
          message: 'Tier 1 specs require at least one contract.',
          subject: subjectBase,
          location: { pointer: '/contracts' },
          narrowRepair: 'Add at least one contract or change risk_tier to 3 or mode to chore.',
        }),
      );
    } else if (spec.risk_tier === 2 && spec.contracts.length === 0) {
      errors.push(
        diagnostic({
          rule: SPEC_RULES.TIER2_MISSING_CONTRACTS,
          authority: 'kernel/spec',
          message: 'Tier 2 specs require at least one contract.',
          subject: subjectBase,
          location: { pointer: '/contracts' },
          narrowRepair: 'Add at least one contract or change risk_tier to 3 or mode to chore.',
        }),
      );
    }
  }

  // Tier 1: observability + rollback + non_functional.security all required non-empty.
  if (spec.risk_tier === 1) {
    if (!spec.observability || spec.observability.length === 0) {
      errors.push(
        diagnostic({
          rule: SPEC_RULES.TIER1_MISSING_OBSERVABILITY,
          authority: 'kernel/spec',
          message: 'Tier 1 specs require non-empty observability.',
          subject: subjectBase,
          location: { pointer: '/observability' },
          narrowRepair: 'Add at least one observability item (log, metric, trace, alert).',
        }),
      );
    }
    if (!spec.rollback || spec.rollback.length === 0) {
      errors.push(
        diagnostic({
          rule: SPEC_RULES.TIER1_MISSING_ROLLBACK,
          authority: 'kernel/spec',
          message: 'Tier 1 specs require non-empty rollback.',
          subject: subjectBase,
          location: { pointer: '/rollback' },
          narrowRepair: 'Add at least one rollback step.',
        }),
      );
    }
    const sec = spec.non_functional.security;
    if (!sec || sec.length === 0) {
      errors.push(
        diagnostic({
          rule: SPEC_RULES.TIER1_MISSING_SECURITY,
          authority: 'kernel/spec',
          message: 'Tier 1 specs require non-empty non_functional.security.',
          subject: subjectBase,
          location: { pointer: '/non_functional/security' },
          narrowRepair: 'Add at least one security requirement.',
        }),
      );
    }
  }

  // experimental_mode is only valid on Tier 3.
  if (spec.experimental_mode !== undefined && spec.risk_tier !== 3) {
    errors.push(
      diagnostic({
        rule: SPEC_RULES.EXPERIMENTAL_MODE_TIER_RESTRICTED,
        authority: 'kernel/spec',
        message: 'experimental_mode is only valid on Tier 3 specs.',
        subject: subjectBase,
        location: { pointer: '/experimental_mode' },
        narrowRepair: 'Remove experimental_mode or change risk_tier to 3.',
      }),
    );
  }

  // resolution may exist only when lifecycle_state is closed or archived.
  if (spec.resolution !== undefined && spec.lifecycle_state !== 'closed' && spec.lifecycle_state !== 'archived') {
    errors.push(
      diagnostic({
        rule: SPEC_RULES.RESOLUTION_REQUIRES_CLOSURE,
        authority: 'kernel/spec',
        message: `resolution is only valid when lifecycle_state is closed or archived (got ${spec.lifecycle_state}).`,
        subject: subjectBase,
        location: { pointer: '/resolution' },
        narrowRepair: 'Remove resolution, or transition lifecycle_state to closed.',
      }),
    );
  }

  // closed/archived specs should have a resolution recorded.
  if (
    (spec.lifecycle_state === 'closed' || spec.lifecycle_state === 'archived') &&
    spec.resolution === undefined
  ) {
    errors.push(
      diagnostic({
        rule: SPEC_RULES.CLOSED_SPEC_MISSING_RESOLUTION,
        authority: 'kernel/spec',
        message: `${spec.lifecycle_state} specs must record a resolution.`,
        subject: subjectBase,
        location: { pointer: '/resolution' },
        narrowRepair: 'Set resolution to one of: completed, superseded, abandoned.',
      }),
    );
  }

  // supersedes self-reference.
  if (spec.supersedes !== undefined && spec.supersedes === spec.id) {
    errors.push(
      diagnostic({
        rule: SPEC_RULES.SUPERSEDES_SELF_REFERENCE,
        authority: 'kernel/spec',
        message: 'A spec cannot supersede itself.',
        subject: subjectBase,
        location: { pointer: '/supersedes' },
        narrowRepair: 'Remove the self-reference or change the supersedes target.',
      }),
    );
  }

  // Successor declarations — INTRA-SPEC RULES ONLY.
  //
  // Everything below is decidable from this spec's own bytes. Whether a
  // target_spec_id resolves to an authored spec is deliberately NOT checked
  // here: that requires reading the corpus, and pushing it into this layer
  // would make `caws specs validate <file>` return different verdicts for
  // identical bytes depending on ambient .caws state. Resolution belongs to
  // the SuccessorResolver, injected at close preflight.
  if (spec.successors !== undefined) {
    const seenTargets = new Map<string, number>();

    spec.successors.forEach((successor, index) => {
      const pointer = `/successors/${index}`;

      // 'declined' records a human decision NOT to pursue a successor. An
      // undocumented decline is indistinguishable from an oversight, so the
      // rationale carries the whole weight of the decision.
      if (successor.disposition === 'declined') {
        if (successor.rationale === undefined || successor.rationale.trim() === '') {
          errors.push(
            diagnostic({
              rule: SPEC_RULES.SUCCESSOR_DECLINED_MISSING_RATIONALE,
              authority: 'kernel/spec',
              message: `Successor "${successor.target_spec_id}" has disposition "declined" but no rationale. A decline without a stated reason is indistinguishable from an oversight.`,
              subject: subjectBase,
              location: { pointer: `${pointer}/rationale` },
              narrowRepair: 'Add a rationale explaining why no successor is required.',
            }),
          );
        }
      }

      // 'absorbed' asserts the obligation was discharged somewhere specific.
      // Without absorbed_by the claim is unfalsifiable.
      if (successor.disposition === 'absorbed' && successor.absorbed_by === undefined) {
        errors.push(
          diagnostic({
            rule: SPEC_RULES.SUCCESSOR_ABSORBED_MISSING_ABSORBED_BY,
            authority: 'kernel/spec',
            message: `Successor "${successor.target_spec_id}" has disposition "absorbed" but no absorbed_by. An absorbed obligation must name the spec that discharged it.`,
            subject: subjectBase,
            location: { pointer: `${pointer}/absorbed_by` },
            narrowRepair: 'Add absorbed_by naming the spec that took on this work.',
          }),
        );
      }

      // A whitespace-only rationale passes the schema's minLength: 1 but
      // carries no decision. Reject it wherever it appears, not only under
      // 'declined'.
      if (successor.rationale !== undefined && successor.rationale.trim() === '') {
        errors.push(
          diagnostic({
            rule: SPEC_RULES.SUCCESSOR_RATIONALE_FORBIDDEN_EMPTY,
            authority: 'kernel/spec',
            message: `Successor "${successor.target_spec_id}" has a whitespace-only rationale.`,
            subject: subjectBase,
            location: { pointer: `${pointer}/rationale` },
            narrowRepair: 'Write a substantive rationale or remove the field.',
          }),
        );
      }

      // Self-reference, in its three shapes. This is the ONLY cycle analysis
      // in scope for this slice — the resolver is an existence oracle, not a
      // graph authority.
      if (successor.target_spec_id === spec.id) {
        errors.push(
          diagnostic({
            rule: SPEC_RULES.SUCCESSOR_SELF_REFERENCE,
            authority: 'kernel/spec',
            message: 'A spec cannot be its own successor.',
            subject: subjectBase,
            location: { pointer: `${pointer}/target_spec_id` },
            narrowRepair: 'Name a different spec, or remove the successor entry.',
          }),
        );
      }

      if (successor.absorbed_by !== undefined && successor.absorbed_by === spec.id) {
        errors.push(
          diagnostic({
            rule: SPEC_RULES.SUCCESSOR_ABSORBED_BY_SELF_REFERENCE,
            authority: 'kernel/spec',
            message: 'A spec cannot absorb its own successor obligation.',
            subject: subjectBase,
            location: { pointer: `${pointer}/absorbed_by` },
            narrowRepair: 'Name the spec that actually discharged the obligation.',
          }),
        );
      }

      // absorbed_by === target_spec_id would make the declaration
      // self-satisfying: "the successor obligation was absorbed by the
      // successor" states nothing.
      if (
        successor.absorbed_by !== undefined &&
        successor.absorbed_by === successor.target_spec_id
      ) {
        errors.push(
          diagnostic({
            rule: SPEC_RULES.SUCCESSOR_ABSORBED_BY_EQUALS_TARGET,
            authority: 'kernel/spec',
            message: `Successor "${successor.target_spec_id}" is absorbed by itself, which asserts nothing. Use disposition "required" if the target carries the obligation.`,
            subject: subjectBase,
            location: { pointer: `${pointer}/absorbed_by` },
            narrowRepair:
              'Set disposition to "required", or name the different spec that absorbed the work.',
          }),
        );
      }

      // Duplicate targets are REJECTED rather than deduplicated: two entries
      // for one target mean the author's intent is ambiguous, and silently
      // collapsing them would pick one rationale and discard the other.
      const firstIndex = seenTargets.get(successor.target_spec_id);
      if (firstIndex !== undefined) {
        errors.push(
          diagnostic({
            rule: SPEC_RULES.SUCCESSOR_DUPLICATE_TARGET,
            authority: 'kernel/spec',
            message: `Successor "${successor.target_spec_id}" is declared more than once (entries ${firstIndex} and ${index}). Two declarations for one target are ambiguous.`,
            subject: subjectBase,
            location: { pointer: `${pointer}/target_spec_id` },
            narrowRepair:
              'Merge the entries into one declaration with a single disposition and rationale.',
          }),
        );
      } else {
        seenTargets.set(successor.target_spec_id, index);
      }
    });
  }

  // SPEC-SCOPE-OVERBROAD-OUT-DETECTION-001: same-spec scope contradiction.
  //
  // Detect when a scope.out entry is a path-prefix of a scope.in entry
  // within THIS spec. At scope-decision time the broad scope.out would
  // refuse the explicitly-admitted scope.in path, producing a false
  // negative the author almost certainly did not intend.
  //
  // Path-segment-boundary matching:
  //   - "a/b" shadows "a/b/c.ts"        (b is a directory containing the file)
  //   - "a/b" does NOT shadow "a/bc.ts" (bc is a sibling of b)
  //   - exact equality (scope.in === scope.out) is a DIFFERENT defect
  //     class; this rule intentionally does not fire on it. A future
  //     spec.semantic.scope.exact_conflict rule may cover that case.
  //
  // Cross-spec policy is unweakened: this check looks only at THIS
  // spec's scope.in and scope.out. The scope-evaluation kernel still
  // resolves cross-spec admit-vs-refuse with its existing semantics.
  //
  // One diagnostic per shadowed scope.in entry: downstream tooling can
  // group by scope_out_prefix if it wants a single-row UX.
  const scopeIn = spec.scope?.in ?? [];
  const scopeOut = spec.scope?.out ?? [];
  // WORKTREE-SUPPORT-SCOPE-001: scope.support is admitted like scope.in, so a
  // scope.out entry that shadows a support entry is the same author error — the
  // broad out would refuse the explicitly-admitted support path at decision
  // time. Scan both admit surfaces, tagging which one was shadowed so the
  // diagnostic points at the right field.
  const scopeSupport = spec.scope?.support ?? [];
  const admitSurfaces: ReadonlyArray<{ key: 'scope.in' | 'scope.support'; entries: readonly string[] }> = [
    { key: 'scope.in', entries: scopeIn },
    { key: 'scope.support', entries: scopeSupport },
  ];
  for (const outEntry of scopeOut) {
    const outNormalized = normalizeScopePath(outEntry);
    for (const surface of admitSurfaces) {
      for (const inEntry of surface.entries) {
        const inNormalized = normalizeScopePath(inEntry);
        if (isPathSegmentPrefix(outNormalized, inNormalized)) {
          errors.push(
            diagnostic({
              rule: SPEC_RULES.SCOPE_OVERBROAD_OUT,
              authority: 'kernel/spec',
              message: `scope.out entry "${outEntry}" shadows ${surface.key} entry "${inEntry}" within the same spec — the broad scope.out would refuse the explicitly-admitted ${surface.key} path at decision time.`,
              subject: inEntry,
              location: { pointer: '/scope/out' },
              narrowRepair:
                'Either (1) remove or narrow the broad scope.out entry so it no longer covers the admitted path, OR (2) move the documentary exclusion to a future non_goals field (documentation-only, not consulted by the scope kernel).',
              data: {
                scope_out_prefix: outEntry,
                scope_in_shadowed: inEntry,
                shadowed_surface: surface.key,
                scope_out: scopeOut,
                scope_in: scopeIn,
                scope_support: scopeSupport,
              },
            }),
          );
        }
      }
    }
  }

  // Evidence (CAWS-SPEC-AC-EVIDENCE-AUTHORITY-01). Two INTRA-SPEC rules,
  // decidable from the spec's own bytes with no filesystem access — mirroring
  // the successor declaration rules. Whether every declared AC is SATISFIED
  // for closure is a separate close-gate question (closeSpec), never here.
  if (spec.evidence !== undefined && spec.evidence.length > 0) {
    const declaredAcIds = new Set(spec.acceptance.map((a) => a.id));
    for (const [index, entry] of spec.evidence.entries()) {
      // (a) criterion_id must match a declared acceptance[].id. A typo that
      // satisfies nothing is rejected here, at validation time — otherwise the
      // close gate would silently see the declared AC as "still unevidenced"
      // and the recorded evidence as orphaned, with no signal connecting them.
      if (!declaredAcIds.has(entry.criterion_id)) {
        errors.push(
          diagnostic({
            rule: SPEC_RULES.EVIDENCE_CRITERION_ID_UNKNOWN,
            authority: 'kernel/spec',
            message: `evidence[${index}].criterion_id "${entry.criterion_id}" does not match any declared acceptance[].id. A criterion id that satisfies nothing is rejected — did you typo the AC id?`,
            subject: subjectBase,
            location: { pointer: `/evidence/${index}/criterion_id` },
            narrowRepair: `Use one of the declared AC ids: ${[...declaredAcIds].join(', ')}.`,
          }),
        );
      }
      // (b) waiver_reason required iff status === 'waived'. An undocumented
      // waiver is indistinguishable from an oversight (parallels
      // successors[].disposition: 'declined' rationale requirement).
      if (
        entry.status === 'waived' &&
        (typeof entry.waiver_reason !== 'string' || entry.waiver_reason.trim().length === 0)
      ) {
        errors.push(
          diagnostic({
            rule: SPEC_RULES.EVIDENCE_WAIVER_MISSING_REASON,
            authority: 'kernel/spec',
            message: `evidence[${index}] (criterion "${entry.criterion_id}") has status "waived" but no waiver_reason. An undocumented waiver is indistinguishable from an oversight.`,
            subject: subjectBase,
            location: { pointer: `/evidence/${index}/waiver_reason` },
            narrowRepair:
              'Record why this AC is waived (--waiver-reason), or change the status to pass/fail/unchecked.',
          }),
        );
      }
    }
  }

  if (errors.length > 0) {
    return err(errors);
  }
  return ok(spec);
}

/**
 * Normalize a scope path for prefix comparison: strip a trailing slash
 * if present. The schema permits both "a/b" and "a/b/" forms; treat
 * them as equivalent for prefix-shadowing purposes.
 */
function normalizeScopePath(p: string): string {
  if (p.length > 1 && p.endsWith('/')) return p.slice(0, -1);
  return p;
}

/**
 * Path-segment-boundary prefix check.
 *
 *   isPathSegmentPrefix('a/b', 'a/b/c')   === true
 *   isPathSegmentPrefix('a/b', 'a/b')     === false  // exact equality is a different defect class
 *   isPathSegmentPrefix('a/b', 'a/bc')    === false  // 'bc' is not within 'b/'
 *   isPathSegmentPrefix('a',   'a/b')     === true
 *   isPathSegmentPrefix('a/b', 'a')       === false  // not a prefix
 *   isPathSegmentPrefix('',    'a/b')     === false  // empty prefix is degenerate; do not fire
 *
 * The exact-equality case returns false deliberately. See A3.
 */
function isPathSegmentPrefix(prefix: string, candidate: string): boolean {
  if (prefix.length === 0) return false;
  if (prefix === candidate) return false;
  if (!candidate.startsWith(prefix)) return false;
  // candidate is strictly longer than prefix and starts with it; the
  // next character must be a path separator for this to be a true
  // segment-boundary prefix.
  return candidate.charAt(prefix.length) === '/';
}
