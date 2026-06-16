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
import type { ResolvedBinding } from '../binding/types';

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
   *   - `union`: no authoritative binding; all active specs are consulted.
   * Derived purely from `bindingState` (bound → authoritative, else union).
   */
  readonly mode: 'authoritative' | 'union';
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
  // `bindingState: 'bound'` is the only authoritative state; one_sided and
  // unbound both fall back to union-mode checking at the guard layer.
  const mode: ScopeDecisionJson['mode'] =
    decision.bindingState === 'bound' ? 'authoritative' : 'union';

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
  if (
    typeof decision.narrowRepair === 'string' &&
    decision.narrowRepair.length > 0
  ) {
    json.repair = decision.narrowRepair;
  }
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
    decision.narrowRepair.length > 0
  ) {
    lines.push(`             repair:  ${decision.narrowRepair}`);
  }
  if (opts.showData === true && decision.data !== undefined) {
    lines.push(`             data:    ${JSON.stringify(decision.data)}`);
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
