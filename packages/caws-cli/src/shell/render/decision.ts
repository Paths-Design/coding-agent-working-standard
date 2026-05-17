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
