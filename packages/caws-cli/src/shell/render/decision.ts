// Pure string-formatter for scope Decision.
//
// The renderer prints exactly one Decision. It distinguishes:
//
//   admit                   → "ADMIT  <rule>: <message> @ <path>"
//   reject                  → "REJECT <rule>: <message> @ <path>"
//   invalid_path            → "INVALID <rule>: <message>"
//   no_authority (unbound,
//        outside worktree)  → "NO AUTHORITY scope.no_authority.unbound (outside any worktree): ..."
//   no_authority (unbound,
//        tracked but unbound) → "NO AUTHORITY scope.no_authority.unbound (worktree <name> not bound to a spec): ..."
//   no_authority (one_sided) → "NO AUTHORITY scope.no_authority.binding_one_sided: ..."
//
// The shell-side nuance ("outside any worktree" vs "tracked worktree
// without spec") comes from the optional `boundContext` arg. The kernel
// rule id stays the same in both cases — agents can rely on it as a stable
// handle — but the human prose tells the user which repair to perform.

import type { Decision } from '../../kernel';
import type { AuthorityContextCandidate, ResolvedBinding } from '../binding/types';

export interface RenderDecisionOptions {
  /**
   * Shell-side binding resolution. Used ONLY to color the `unbound`
   * no-authority case: when `worktreeName` is set, the message reads
   * "tracked worktree without spec"; otherwise it reads "outside any
   * worktree". The rule id is unchanged either way.
   */
  readonly boundContext?: ResolvedBinding;
  /** Show the optional `data` block. Default false. */
  readonly showData?: boolean;
}

/**
 * Stable machine-readable scope-decision contract (CAWS-SCOPE-SHOW-JSON-CONTRACT-001).
 *
 * This is the hook-facing interface emitted by `caws scope show --json`. Field
 * names and the `decision` enum are a PUBLIC CONTRACT — a consumer hook (e.g.
 * scope-guard.sh) parses this with jq instead of re-parsing spec YAML inline.
 * Renaming or dropping a field is a breaking change and is pinned by the
 * render/decision contract test.
 *
 * Every field is derived from the kernel `Decision` (+ its `data` block) and
 * the shell `ResolvedBinding`. The renderer NEVER reads or parses a spec file.
 */
export interface ScopeDecisionJson {
  /** Kernel decision kind. */
  readonly decision: Decision['kind'];
  /** Stable kernel SCOPE_RULES identifier. */
  readonly rule: string;
  /** The original path the caller passed in. */
  readonly path: string;
  /** Normalized path, when the kernel normalized it (else omitted). */
  readonly normalizedPath?: string;
  /** Kernel binding-state tag the decision was made under. */
  readonly bindingState: Decision['bindingState'];
  /**
   * Enforcement mode the hook should report:
   *   - `authoritative`: a spec is bound to this worktree; only it is checked.
   *   - `spec_context`: caller supplied a spec id for read-only comparison.
   *   - `union`: no current-checkout authority; all active specs are consulted
   *      or a target path was resolved to another worktree's scope.in claim.
   */
  readonly mode: 'authoritative' | 'spec_context' | 'union';
  /**
   * The spec id that drove the decision, when known. Sourced from the kernel
   * `decision.data.specId` (the spec whose scope.in/out matched), falling back
   * to the bound BindingState's `spec.id`.
   */
  readonly boundSpecId?: string;
  /** The resolved worktree name, when known (else omitted). */
  readonly worktreeName?: string;
  /** How the worktree-name resolution was reached (shell ResolvedBinding.source). */
  readonly source?: ResolvedBinding['source'];
  /**
   * The matched scope rule pattern, when the kernel recorded one. Normalizes
   * the kernel's three data shapes (matchedPattern / matchedPrefix /
   * matchedName) into a single field.
   */
  readonly matchedPattern?: string;
  /** When >1 active spec claims this path: the claimant spec ids. */
  readonly ambiguousClaimants?: readonly string[];
  /** Human-readable explanation (same text the default render shows). */
  readonly message: string;
  /** Precise repair hint, when the kernel knows one (else omitted). */
  readonly repair?: string;
  /** Structured handoff guidance for common repairable refusals. */
  readonly remediation?: ScopeRemediation;
}

export interface ScopeRemediationCommand {
  readonly command: string;
  readonly description: string;
  readonly mutates: boolean;
}

export interface ScopeRemediation {
  readonly summary: string;
  readonly commands: readonly ScopeRemediationCommand[];
  readonly notes?: readonly string[];
  readonly authorityCandidates?: readonly AuthorityContextCandidate[];
}

/**
 * Build the stable JSON contract for a scope decision. Pure: reads only the
 * kernel `Decision` (and its `data` block) and the optional shell
 * `ResolvedBinding`. No spec I/O.
 */
export function buildScopeDecisionJson(
  decision: Decision,
  boundContext?: ResolvedBinding
): ScopeDecisionJson {
  // `bindingState: 'bound'` is authoritative only when it came from worktree
  // authority. Explicit spec context uses the same kernel bound evaluator, but
  // remains a read-only comparison and must not be reported as write authority.
  const mode: ScopeDecisionJson['mode'] =
    boundContext?.source === 'explicit_spec'
      ? 'spec_context'
      : boundContext?.source === 'target_scope_in_claim'
        ? 'union'
        : decision.bindingState === 'bound' || decision.bindingState === 'bridged'
          ? 'authoritative'
          : 'union';

  const boundSpecId = extractBoundSpecId(decision, boundContext);
  const matchedPattern = extractMatchedPattern(decision.data);

  const ambiguousClaimants =
    boundContext?.ambiguous !== undefined
      ? boundContext.ambiguous.claimants.map((c) => c.specId)
      : undefined;

  const json: {
    -readonly [K in keyof ScopeDecisionJson]?: ScopeDecisionJson[K];
  } = {
    decision: decision.kind,
    rule: decision.rule,
    path: decision.path,
    bindingState: decision.bindingState,
    mode,
    message: decision.message,
  };
  if (typeof decision.normalizedPath === 'string') {
    json.normalizedPath = decision.normalizedPath;
  }
  if (typeof boundSpecId === 'string') json.boundSpecId = boundSpecId;
  if (typeof boundContext?.worktreeName === 'string') {
    json.worktreeName = boundContext.worktreeName;
  }
  if (boundContext?.source !== undefined) json.source = boundContext.source;
  if (typeof matchedPattern === 'string') json.matchedPattern = matchedPattern;
  if (ambiguousClaimants !== undefined && ambiguousClaimants.length > 0) {
    json.ambiguousClaimants = ambiguousClaimants;
  }
  const remediation = buildScopeRemediation(decision, boundContext);
  if (
    typeof decision.narrowRepair === 'string' &&
    decision.narrowRepair.length > 0 &&
    !(decision.kind === 'no_authority' && remediation !== undefined)
  ) {
    json.repair = decision.narrowRepair;
  }
  if (remediation !== undefined) json.remediation = remediation;
  return json as ScopeDecisionJson;
}

/** Render the stable JSON contract as a single line for hook consumption. */
export function renderDecisionJson(decision: Decision, boundContext?: ResolvedBinding): string {
  return JSON.stringify(buildScopeDecisionJson(decision, boundContext));
}

/**
 * The spec id that drove the decision. Preferred source is the kernel
 * `decision.data.specId` (set whenever a spec's scope.in/out matched). When
 * the decision carries no specId (e.g. an admit purely from the bound
 * binding), fall back to the bound BindingState's `spec.id`. No spec I/O.
 */
function extractBoundSpecId(
  decision: Decision,
  boundContext: ResolvedBinding | undefined
): string | undefined {
  const fromData = decision.data?.['specId'];
  if (typeof fromData === 'string') return fromData;
  const binding = boundContext?.binding;
  if (binding !== undefined && binding.kind === 'bound') {
    return binding.spec.id;
  }
  return undefined;
}

/**
 * Normalize the kernel's matched-pattern data shapes into one field. The
 * kernel records the matched entry under `matchedPattern` (scope.in/out/zone),
 * `matchedPrefix` (infra/scope.out prefix), or `matchedName` (root passthrough).
 * Read defensively — each is optional and must be a string.
 */
function extractMatchedPattern(
  data: Readonly<Record<string, unknown>> | undefined
): string | undefined {
  if (data === undefined) return undefined;
  const candidate = data['matchedPattern'] ?? data['matchedPrefix'] ?? data['matchedName'];
  return typeof candidate === 'string' ? candidate : undefined;
}

function authorityCandidates(
  boundContext: ResolvedBinding | undefined
): readonly AuthorityContextCandidate[] {
  return boundContext?.authorityCandidates ?? [];
}

/**
 * The "go look at the candidates" command.
 *
 * CAWS-SPEC-ACTIVATION-BINDS-001: `--status active` HIDES a draft claimant, so
 * when one is being recommended the filter would send the caller to a listing
 * that omits the very spec named one line above. Drop the filter in that case.
 */
function specListCommand(
  candidates: readonly AuthorityContextCandidate[]
): ScopeRemediationCommand {
  const hasDraft = candidates.some((c) => c.lifecycleState === 'draft');
  return hasDraft
    ? {
        command: 'caws specs list',
        description:
          'List specs in every lifecycle state — a draft claimant is not in the active listing.',
        mutates: false,
      }
    : {
        command: 'caws specs list --status active',
        description: 'List active specs before choosing the authority context.',
        mutates: false,
      };
}

/**
 * A claimant the remediation may recommend as a verified authority: its
 * scope.in claims the path, the kernel admits the path under its own binding,
 * and its lane has not already landed (CAWS-SCOPE-REMEDIATION-STATES-VERIFIED-SAFETY-01).
 */
function isVerifiedClaimant(candidate: AuthorityContextCandidate): boolean {
  return (
    candidate.matchedScopeInEntry !== undefined &&
    candidate.bindingAdmits === true &&
    candidate.landedOpen === undefined
  );
}

/**
 * A claimant nobody has evaluated (no policy loaded, or evaluation threw).
 * Only these still need the caller's read-only --spec check; for the rest the
 * CLI already has the answer and says it.
 */
function isUnevaluatedClaimant(candidate: AuthorityContextCandidate): boolean {
  return (
    candidate.matchedScopeInEntry !== undefined &&
    candidate.bindingAdmits === undefined &&
    candidate.landedOpen === undefined
  );
}

/**
 * Every candidate claims the path, yet none may take new work on it: each one
 * either already landed or is refused by the kernel under its own binding. The
 * handoff is then a new spec, not any of the listed ones.
 */
function noClaimantTakesNewWork(candidates: readonly AuthorityContextCandidate[]): boolean {
  const claiming = candidates.filter((c) => c.matchedScopeInEntry !== undefined);
  return (
    claiming.length > 0 &&
    claiming.every((c) => c.landedOpen !== undefined || c.bindingAdmits === false)
  );
}

function shortSha(sha: string): string {
  return sha.slice(0, 10);
}

function authorityCandidateCommands(
  normPath: string,
  candidates: readonly AuthorityContextCandidate[],
  opts: { readonly trackedWorktreeName?: string } = {}
): ScopeRemediationCommand[] {
  const commands: ScopeRemediationCommand[] = [];
  for (const candidate of candidates.slice(0, 5)) {
    const id = candidate.specId;
    const entry = candidate.matchedScopeInEntry;
    // A landed spec is offered for inspection only. `ensure` on it would
    // succeed — it is active with no worktree — and quietly fold new work into
    // a slice whose work is already on the base branch.
    if (candidate.landedOpen !== undefined) {
      commands.push({
        command: `caws specs show ${shellQuote(id)}`,
        description: `Read-only: ${id} landed in merge ${shortSha(candidate.landedOpen.mergeCommit)} and was left open with --no-close for its evidence and close. Inspect it; do not bind new work to it.`,
        mutates: false,
      });
      continue;
    }
    const verified = isVerifiedClaimant(candidate);
    if (!verified) {
      commands.push({
        command: `caws scope show ${shellQuote(normPath)} --spec ${shellQuote(id)}`,
        description:
          candidate.bindingAdmits === false
            ? `Read-only: shows why the kernel refuses this path under ${id} (${candidate.bindingRefusalRule ?? 'refused'}) although its scope.in "${entry}" matches.`
            : `Read-only check whether ${id} is the right spec context for this path.`,
        mutates: false,
      });
      // Binding a spec the kernel refuses this path under yields a worktree
      // that refuses the same edit; offering it would be a dead end.
      if (candidate.bindingAdmits === false) continue;
    }
    const verifiedBecause = `the kernel admits this path under its binding (scope.in "${entry}")`;
    if (typeof opts.trackedWorktreeName === 'string') {
      if (candidate.worktreeName === undefined) {
        commands.push({
          command: `caws worktree bind ${shellQuote(opts.trackedWorktreeName)} --spec ${shellQuote(id)}`,
          description: verified
            ? candidate.lifecycleState === 'draft'
              ? `Safe: binds this unbound worktree to draft ${id} and activates it, and ${verifiedBecause}. No other spec or worktree changes.`
              : `Safe: binds this unbound worktree to active ${id}, and ${verifiedBecause}. No other spec or worktree changes.`
            : candidate.lifecycleState === 'draft'
              ? `Bind this tracked worktree to draft spec ${id} — the bind activates it.`
              : `Bind this tracked worktree to active spec ${id}.`,
          mutates: true,
        });
      } else {
        commands.push({
          command: `cd .caws/worktrees/${shellQuote(candidate.worktreeName)}`,
          description: verified
            ? `Enter ${candidate.worktreeName}, the worktree bound to ${id}; ${verifiedBecause}.`
            : `Enter the existing worktree already bound to ${id}.`,
          mutates: false,
        });
      }
    } else if (candidate.worktreeName === undefined) {
      commands.push({
        command: `caws worktree ensure <name> --spec ${shellQuote(id)}`,
        description: verified
          ? candidate.lifecycleState === 'draft'
            ? `Safe: ${id} is a draft with no worktree, and ${verifiedBecause}. ensure creates a worktree bound to ${id} and activates the draft in the same transaction; no other spec or worktree changes.`
            : `Safe: ${id} is active with no worktree, and ${verifiedBecause}. ensure creates a worktree bound to ${id}, or re-enters an untouched lane of that name already bound to it; no other spec or worktree changes.`
          : candidate.lifecycleState === 'draft'
            ? `Create-or-admit a governed worktree for draft spec ${id} — creating it activates the draft; an existing untouched lane admits idempotently.`
            : `Create-or-admit a governed worktree for active spec ${id}; an existing untouched lane admits idempotently.`,
        mutates: true,
      });
    } else {
      commands.push({
        command: `cd .caws/worktrees/${shellQuote(candidate.worktreeName)}`,
        description: verified
          ? `Enter ${candidate.worktreeName}, the worktree bound to ${id}; ${verifiedBecause}.`
          : `Enter the existing worktree already bound to ${id}.`,
        mutates: false,
      });
    }
  }
  return commands;
}

/** The handoff when no listed claimant may take new work on the path. */
function newSpecCommands(
  normPath: string,
  opts: { readonly trackedWorktreeName?: string } = {}
): ScopeRemediationCommand[] {
  return [
    {
      command: `caws specs create <id> --title "<title>" --mode <mode> --risk-tier <n> --scope-in ${shellQuote(normPath)}`,
      description:
        'Author a new spec that claims this path. Every spec listed above has already landed or is refused this path by the kernel, so none is a lane for this edit.',
      mutates: true,
    },
    typeof opts.trackedWorktreeName === 'string'
      ? {
          command: `caws worktree bind ${shellQuote(opts.trackedWorktreeName)} --spec <id>`,
          description: 'Bind this unbound worktree to the new spec; the bind activates it.',
          mutates: true,
        }
      : {
          command: 'caws worktree ensure <name> --spec <id>',
          description: 'Create the new spec’s worktree; creating it activates the draft.',
          mutates: true,
        },
  ];
}

/** One sentence per claimant, stating what the CLI established about it. */
function claimantNote(candidate: AuthorityContextCandidate): string {
  const id = candidate.specId;
  const entry = candidate.matchedScopeInEntry;
  const landed = candidate.landedOpen;
  if (landed !== undefined) {
    const by =
      landed.mergedBySession !== undefined ? ` from session ${landed.mergedBySession}` : '';
    return (
      `${id} already landed: merge ${shortSha(landed.mergeCommit)} at ${landed.mergedAt}${by}, via worktree ${landed.worktreeName}. ` +
      'It was left open with --no-close so its evidence can be recorded before it closes; it is finished work, not a lane for this edit. ' +
      'Closing it belongs to the session that merged it.'
    );
  }
  if (candidate.bindingAdmits === true) {
    const where =
      candidate.worktreeName !== undefined ? `worktree ${candidate.worktreeName}` : 'no worktree';
    return (
      `Verified: ${id} (${candidate.lifecycleState}, ${where}) claims this path via scope.in "${entry}", and the kernel admits the path under its binding.` +
      (candidate.lifecycleState === 'draft' ? ' Binding it activates the draft.' : '')
    );
  }
  if (candidate.bindingAdmits === false) {
    return `${id} claims this path via scope.in "${entry}", but the kernel refuses the path under its binding (${candidate.bindingRefusalRule ?? 'refused'}), so binding it would not make this path editable.`;
  }
  return (
    `${id} claims this path via scope.in "${entry}"` +
    (candidate.lifecycleState === 'draft'
      ? ' and is a draft — creating or binding its worktree activates it.'
      : '.')
  );
}

const READ_ONLY_CHECK_NOTE =
  'Use the read-only scope --spec check first; it compares path fit but does not grant current-checkout write authority.';

function authorityCandidateNotes(
  candidates: readonly AuthorityContextCandidate[]
): readonly string[] {
  const claiming = candidates.filter((c) => c.matchedScopeInEntry !== undefined);
  const notes: string[] = [];
  // CAWS-SPEC-ACTIVATION-BINDS-001: a list of specs that CLAIM the path and a
  // list of specs that merely happen to be active are very different handoffs.
  // Saying which one this is stops the fallback list from reading as a claim.
  if (claiming.length === 0) {
    notes.push(
      'No active spec claims this path via scope.in, so every active spec is listed as a fallback. Widen the owning spec with caws specs amend-scope <id> --add <path> instead of picking an unrelated one.',
      READ_ONLY_CHECK_NOTE
    );
  } else {
    if (claiming.length > 1) {
      notes.push(
        `${claiming.length} specs claim this path via scope.in; listed in id order` +
          (claiming.some((c) => c.lifecycleState === 'draft')
            ? ' (drafts among them activate on bind).'
            : '.')
      );
    }
    // CAWS-SCOPE-REMEDIATION-STATES-VERIFIED-SAFETY-01: state what was
    // established about each claimant. A hedge ("check first", "does not
    // grant") in place of a fact the CLI already holds reads as a warning and
    // stalls the caller; a stated fact with its reason does not.
    for (const candidate of claiming.slice(0, 5)) notes.push(claimantNote(candidate));
    const verified = claiming.filter(isVerifiedClaimant);
    if (verified.length > 0) {
      notes.push(
        'This checkout is refused only because it has no binding. ' +
          (verified.length === 1
            ? 'The --spec fit check is already done for the verified claimant, and binding it is what grants write authority here.'
            : 'The --spec fit check is already done for each verified claimant; any of them is a valid authority, so bind the one whose acceptance criteria this edit serves.')
      );
    }
    if (claiming.some(isUnevaluatedClaimant)) notes.push(READ_ONLY_CHECK_NOTE);
  }
  if (candidates.length > 5) {
    notes.push(
      `Showing first 5 of ${candidates.length}; run caws specs list --status active for the full set.`
    );
  }
  return notes;
}

export function buildScopeRemediation(
  decision: Decision,
  boundContext?: ResolvedBinding
): ScopeRemediation | undefined {
  if (decision.kind === 'invalid_path') {
    return undefined;
  }

  if (
    decision.kind === 'admit' &&
    boundContext?.source === 'target_scope_in_claim' &&
    typeof boundContext.worktreeName === 'string'
  ) {
    const wt = boundContext.worktreeName;
    // CAWS-SCOPE-REMEDIATION-STATES-VERIFIED-SAFETY-01: every fact here is
    // already resolved — the owning worktree, its spec, the admitting entry —
    // so state them instead of sending the caller to re-derive them. The guard
    // note is a statement of worktree-write-guard's `block_claimed` branch,
    // which fires for writers on the claiming worktree's base branch.
    const specId = extractBoundSpecId(decision, boundContext);
    const entry = extractMatchedPattern(decision.data);
    const owner =
      specId !== undefined && entry !== undefined
        ? `Verified: worktree ${wt} is bound to ${specId}, whose scope.in entry "${entry}" admits this path.`
        : `Verified: worktree ${wt}'s bound spec admits this path through its scope.in.`;
    return {
      summary: `${owner} Edit it from inside ${wt}.`,
      commands: [
        {
          command: `cd .caws/worktrees/${shellQuote(wt)}`,
          description: `Safe: a read-only move into ${wt}, the worktree that holds this path's claim.`,
          mutates: false,
        },
        {
          command: 'caws claim',
          description: `Shows whether this session owns ${wt}; the worktree guards admit edits there only for its owner.`,
          mutates: false,
        },
      ],
      notes: [
        `A write to this path from the checkout of ${wt}'s base branch is blocked by worktree-write-guard, because ${wt} claims it.`,
      ],
    };
  }

  if (decision.kind === 'admit') {
    return undefined;
  }

  if (boundContext?.ambiguous !== undefined) {
    const commands = boundContext.ambiguous.claimants.map((c) => ({
      command: `caws specs show ${shellQuote(c.specId)}`,
      description: `Inspect claimant ${c.specId} bound to worktree ${c.worktreeName}.`,
      mutates: false,
    }));
    return {
      summary: 'Multiple active bound specs claim this path; CAWS will not choose an owner.',
      commands,
      notes: [
        'Route the edit through exactly one owning worktree, or narrow one spec with caws specs amend-scope.',
      ],
    };
  }

  const specId = extractBoundSpecId(decision, boundContext);
  const normPath = decision.normalizedPath ?? decision.path;

  if (
    decision.kind === 'reject' &&
    typeof specId === 'string' &&
    (decision.rule === 'scope.reject.scope_in_miss' ||
      decision.rule === 'scope.reject.root_not_allowed')
  ) {
    return {
      summary: `Path is refused by spec ${specId}; amend that spec if this edit belongs in the slice.`,
      commands: [
        {
          command: `caws specs amend-scope ${shellQuote(specId)} --add ${shellQuote(normPath)}`,
          description: 'Add the path to scope.in, making it editable and worktree-claimed.',
          mutates: true,
        },
        {
          command: `caws specs amend-scope ${shellQuote(specId)} --add-support ${shellQuote(normPath)}`,
          description:
            'Add the path to scope.support, making it editable but not worktree-claimed.',
          mutates: true,
        },
      ],
    };
  }

  if (
    decision.kind === 'reject' &&
    typeof specId === 'string' &&
    decision.rule === 'scope.reject.scope_out'
  ) {
    const matched = extractMatchedPattern(decision.data) ?? normPath;
    return {
      summary: `Path is excluded by spec ${specId}; inspect before widening scope.out.`,
      commands: [
        {
          command: `caws specs show ${shellQuote(specId)}`,
          description: 'Inspect the current scope.in/scope.out contract before changing it.',
          mutates: false,
        },
        {
          command: `caws specs amend-scope ${shellQuote(specId)} --remove-out ${shellQuote(matched)}`,
          description:
            'Remove the matching scope.out exclusion if this path is intentionally in scope.',
          mutates: true,
        },
      ],
    };
  }

  if (decision.kind === 'no_authority' && decision.bindingState === 'one_sided') {
    const worktreeName = boundContext?.worktreeName ?? stringData(decision.data, 'worktreeName');
    const registrySpecId = stringData(decision.data, 'registrySpecId');
    const commands: ScopeRemediationCommand[] = [
      {
        command: 'caws doctor',
        description: 'Inspect the one-sided binding and confirm which side is missing.',
        mutates: false,
      },
    ];
    if (typeof worktreeName === 'string' && typeof registrySpecId === 'string') {
      commands.unshift({
        command: `caws worktree bind ${shellQuote(worktreeName)} --spec ${shellQuote(registrySpecId)}`,
        description: 'Repair the bidirectional worktree/spec binding.',
        mutates: true,
      });
    }
    return {
      summary:
        'The worktree/spec binding is one-sided; repair the binding before evaluating scope.',
      commands,
    };
  }

  if (decision.kind === 'no_authority' && decision.bindingState === 'unbound') {
    const candidates = authorityCandidates(boundContext);
    const normPath = decision.normalizedPath ?? decision.path;
    const verified = candidates.filter(isVerifiedClaimant);
    const soleVerified = verified.length === 1 ? verified[0] : undefined;
    const needsNewSpec = noClaimantTakesNewWork(candidates);
    if (typeof boundContext?.worktreeName === 'string') {
      const commands: ScopeRemediationCommand[] = [
        specListCommand(candidates),
        ...authorityCandidateCommands(normPath, candidates, {
          trackedWorktreeName: boundContext.worktreeName,
        }),
        ...(needsNewSpec
          ? newSpecCommands(normPath, { trackedWorktreeName: boundContext.worktreeName })
          : []),
      ];
      if (candidates.length === 0) {
        commands.push({
          command: `caws worktree bind ${shellQuote(boundContext.worktreeName)} --spec <spec-id>`,
          description: 'Bind this existing worktree to the active spec that should own the edit.',
          mutates: true,
        });
      }
      return {
        summary:
          soleVerified !== undefined
            ? `Tracked worktree ${boundContext.worktreeName} is not bound to a spec; ${soleVerified.specId} is the verified authority for this path — bind it before editing.`
            : needsNewSpec
              ? `Tracked worktree ${boundContext.worktreeName} is not bound to a spec, and no spec listed here can take new work on this path; bind it to a new spec before editing.`
              : `Tracked worktree ${boundContext.worktreeName} is not bound to a spec; choose a spec authority before editing.`,
        commands,
        notes:
          candidates.length > 0
            ? authorityCandidateNotes(candidates)
            : ['Replace <spec-id> before running the bind command.'],
        authorityCandidates: candidates,
      };
    }
    const commands: ScopeRemediationCommand[] = [
      specListCommand(candidates),
      ...authorityCandidateCommands(normPath, candidates),
      ...(needsNewSpec ? newSpecCommands(normPath) : []),
    ];
    if (candidates.length === 0) {
      commands.push({
        command: 'caws worktree ensure <name> --spec <spec-id>',
        description:
          'Create-or-admit a governed worktree for the active spec that should own the edit.',
        mutates: true,
      });
    }
    return {
      summary:
        soleVerified !== undefined
          ? `No worktree is bound for this context; ${soleVerified.specId} is the verified authority for this path — create or enter its worktree before editing.`
          : needsNewSpec
            ? 'No worktree is bound for this context, and no spec listed here can take new work on this path; author a new spec that claims it before editing.'
            : 'No worktree is bound for this context; choose a spec authority and create or enter its worktree before editing.',
      commands,
      notes:
        candidates.length > 0
          ? authorityCandidateNotes(candidates)
          : ['Replace <name> and <spec-id> before running the create command.'],
      authorityCandidates: candidates,
    };
  }

  return undefined;
}

function stringData(
  data: Readonly<Record<string, unknown>> | undefined,
  key: string
): string | undefined {
  const value = data?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const KIND_LABEL: Record<Decision['kind'], string> = {
  admit: 'ADMIT       ',
  reject: 'REJECT      ',
  no_authority: 'NO AUTHORITY',
  invalid_path: 'INVALID     ',
};

export function renderDecision(decision: Decision, opts: RenderDecisionOptions = {}): string {
  const lines: string[] = [];
  const remediation = buildScopeRemediation(decision, opts.boundContext);
  const label = KIND_LABEL[decision.kind];
  const nuance = unboundNuance(decision, opts.boundContext);
  const ruleLabel = nuance !== '' ? `${decision.rule} ${nuance}` : decision.rule;
  lines.push(`${label} ${ruleLabel}`);
  lines.push(`             path:    ${decision.path}`);
  if (typeof decision.normalizedPath === 'string' && decision.normalizedPath !== decision.path) {
    lines.push(`             normalized: ${decision.normalizedPath}`);
  }
  lines.push(`             message: ${decision.message}`);
  if (
    typeof decision.narrowRepair === 'string' &&
    decision.narrowRepair.length > 0 &&
    !(decision.kind === 'no_authority' && remediation !== undefined)
  ) {
    lines.push(`             repair:  ${decision.narrowRepair}`);
  }
  if (opts.showData === true && decision.data !== undefined) {
    lines.push(`             data:    ${JSON.stringify(decision.data)}`);
  }
  if (remediation !== undefined) {
    lines.push('             remediation:');
    lines.push(`               ${remediation.summary}`);
    if ((remediation.authorityCandidates ?? []).length > 0) {
      // AX PROBE D3: the heading said "active spec candidates" while the list
      // could contain drafts, and one of the offered commands explained that a
      // draft claimant is NOT in the active listing — a direct contradiction two
      // lines apart. Drop the state from the heading and put it on each row,
      // where it is actually true.
      lines.push('               spec candidates:');
      for (const candidate of remediation.authorityCandidates ?? []) {
        const wt =
          candidate.worktreeName !== undefined
            ? `, worktree ${candidate.worktreeName}`
            : ', no worktree';
        const fact =
          candidate.landedOpen !== undefined
            ? `, landed in ${shortSha(candidate.landedOpen.mergeCommit)} and left open`
            : candidate.bindingAdmits === true
              ? ', verified: admits this path'
              : candidate.bindingAdmits === false
                ? `, refuses this path: ${candidate.bindingRefusalRule ?? 'refused'}`
                : '';
        lines.push(
          `               - ${candidate.specId} (${candidate.lifecycleState}${wt}${fact})`
        );
      }
    }
    for (const command of remediation.commands) {
      lines.push(`               - ${command.command}`);
      lines.push(`                 ${command.description}`);
    }
    for (const note of remediation.notes ?? []) {
      lines.push(`               note: ${note}`);
    }
  }
  lines.push(`             binding: ${decision.bindingState}`);
  return lines.join('\n');
}

/**
 * For `no_authority` + unbound, append a parenthetical that explains which
 * shell-side state produced the unbound decision. For every other kind,
 * return ''.
 */
function unboundNuance(decision: Decision, boundContext: ResolvedBinding | undefined): string {
  if (decision.kind !== 'no_authority') return '';
  if (decision.bindingState !== 'unbound') return '';
  if (boundContext === undefined) return '';
  if (typeof boundContext.worktreeName === 'string') {
    return `(tracked worktree '${boundContext.worktreeName}' has no bound spec)`;
  }
  return '(cwd is outside any CAWS-tracked worktree)';
}
