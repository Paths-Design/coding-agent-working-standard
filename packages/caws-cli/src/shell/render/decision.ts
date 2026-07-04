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

import type { Decision } from '@paths.design/caws-kernel';
import type {
  AuthorityContextCandidate,
  ResolvedBinding,
} from '../binding/types';

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
      : decision.bindingState === 'bound'
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
export function renderDecisionJson(
  decision: Decision,
  boundContext?: ResolvedBinding
): string {
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
  const candidate =
    data['matchedPattern'] ?? data['matchedPrefix'] ?? data['matchedName'];
  return typeof candidate === 'string' ? candidate : undefined;
}

function authorityCandidates(
  boundContext: ResolvedBinding | undefined
): readonly AuthorityContextCandidate[] {
  return boundContext?.authorityCandidates ?? [];
}

function activeSpecListCommand(): ScopeRemediationCommand {
  return {
    command: 'caws specs list --status active',
    description: 'List active specs before choosing the authority context.',
    mutates: false,
  };
}

function authorityCandidateCommands(
  normPath: string,
  candidates: readonly AuthorityContextCandidate[],
  opts: { readonly trackedWorktreeName?: string } = {}
): ScopeRemediationCommand[] {
  const commands: ScopeRemediationCommand[] = [];
  for (const candidate of candidates.slice(0, 5)) {
    commands.push({
      command: `caws scope show ${shellQuote(normPath)} --spec ${shellQuote(candidate.specId)}`,
      description: `Read-only check whether ${candidate.specId} is the right spec context for this path.`,
      mutates: false,
    });
    if (typeof opts.trackedWorktreeName === 'string') {
      if (candidate.worktreeName === undefined) {
        commands.push({
          command: `caws worktree bind ${shellQuote(opts.trackedWorktreeName)} --spec ${shellQuote(candidate.specId)}`,
          description: `Bind this tracked worktree to active spec ${candidate.specId}.`,
          mutates: true,
        });
      } else {
        commands.push({
          command: `cd .caws/worktrees/${shellQuote(candidate.worktreeName)}`,
          description: `Enter the existing worktree already bound to ${candidate.specId}.`,
          mutates: false,
        });
      }
    } else if (candidate.worktreeName === undefined) {
      commands.push({
        command: `caws worktree create <name> --spec ${shellQuote(candidate.specId)}`,
        description: `Create a governed worktree for active spec ${candidate.specId}.`,
        mutates: true,
      });
    } else {
      commands.push({
        command: `cd .caws/worktrees/${shellQuote(candidate.worktreeName)}`,
        description: `Enter the existing worktree already bound to ${candidate.specId}.`,
        mutates: false,
      });
    }
  }
  return commands;
}

function authorityCandidateNotes(
  candidates: readonly AuthorityContextCandidate[]
): readonly string[] {
  const notes = [
    'Use the read-only scope --spec check first; it compares path fit but does not grant current-checkout write authority.',
  ];
  if (candidates.length > 5) {
    notes.push(
      `Showing first 5 active specs; run caws specs list --status active for all ${candidates.length}.`
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
    return {
      summary:
        `Path is admitted by worktree ${wt}'s scope.in claim; enter that worktree before editing.`,
      commands: [
        {
          command: 'caws worktree list --data',
          description: 'Inspect registered worktrees and their bound specs.',
          mutates: false,
        },
        {
          command: `cd .caws/worktrees/${shellQuote(wt)}`,
          description: 'Move into the worktree that owns this path claim.',
          mutates: false,
        },
        {
          command: 'caws claim',
          description: 'Inspect current worktree ownership before editing.',
          mutates: false,
        },
      ],
      notes: [
        'A base-checkout write to this path can still be blocked by worktree-write-guard.',
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
          description: 'Add the path to scope.support, making it editable but not worktree-claimed.',
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
          description: 'Remove the matching scope.out exclusion if this path is intentionally in scope.',
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
      summary: 'The worktree/spec binding is one-sided; repair the binding before evaluating scope.',
      commands,
    };
  }

  if (decision.kind === 'no_authority' && decision.bindingState === 'unbound') {
    const candidates = authorityCandidates(boundContext);
    const normPath = decision.normalizedPath ?? decision.path;
    if (typeof boundContext?.worktreeName === 'string') {
      const commands: ScopeRemediationCommand[] = [
        activeSpecListCommand(),
        ...authorityCandidateCommands(normPath, candidates, {
          trackedWorktreeName: boundContext.worktreeName,
        }),
      ];
      if (candidates.length === 0) {
        commands.push(
          {
            command: `caws worktree bind ${shellQuote(boundContext.worktreeName)} --spec <spec-id>`,
            description: 'Bind this existing worktree to the active spec that should own the edit.',
            mutates: true,
          }
        );
      }
      return {
        summary: `Tracked worktree ${boundContext.worktreeName} is not bound to a spec; choose an active spec authority before editing.`,
        commands,
        notes:
          candidates.length > 0
            ? authorityCandidateNotes(candidates)
            : ['Replace <spec-id> before running the bind command.'],
        authorityCandidates: candidates,
      };
    }
    const commands: ScopeRemediationCommand[] = [
      activeSpecListCommand(),
      ...authorityCandidateCommands(normPath, candidates),
    ];
    if (candidates.length === 0) {
      commands.push({
        command: 'caws worktree create <name> --spec <spec-id>',
        description: 'Create a governed worktree for the active spec that should own the edit.',
        mutates: true,
      });
    }
    return {
      summary: 'No worktree is bound for this context; choose an active spec authority and create or enter its worktree before editing.',
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

export function renderDecision(
  decision: Decision,
  opts: RenderDecisionOptions = {}
): string {
  const lines: string[] = [];
  const remediation = buildScopeRemediation(decision, opts.boundContext);
  const label = KIND_LABEL[decision.kind];
  const nuance = unboundNuance(decision, opts.boundContext);
  const ruleLabel = nuance !== '' ? `${decision.rule} ${nuance}` : decision.rule;
  lines.push(`${label} ${ruleLabel}`);
  lines.push(`             path:    ${decision.path}`);
  if (
    typeof decision.normalizedPath === 'string' &&
    decision.normalizedPath !== decision.path
  ) {
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
      lines.push('               active spec candidates:');
      for (const candidate of remediation.authorityCandidates ?? []) {
        const wt =
          candidate.worktreeName !== undefined
            ? ` (worktree ${candidate.worktreeName})`
            : ' (no worktree)';
        lines.push(`               - ${candidate.specId}${wt}`);
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
function unboundNuance(
  decision: Decision,
  boundContext: ResolvedBinding | undefined
): string {
  if (decision.kind !== 'no_authority') return '';
  if (decision.bindingState !== 'unbound') return '';
  if (boundContext === undefined) return '';
  if (typeof boundContext.worktreeName === 'string') {
    return `(tracked worktree '${boundContext.worktreeName}' has no bound spec)`;
  }
  return '(cwd is outside any CAWS-tracked worktree)';
}
