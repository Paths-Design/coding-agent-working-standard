import * as data from './data';
import { loadCommandAdapters, type AdapterState } from './adapters';
import { buildCommandFact, latticeDecision } from './capabilities';
import { classifyFindDelete, classifyRmTarget, recursiveRmTargets } from './filesystem-effects';
import {
  classifyCommitDeletions,
  classifyGitSemantics,
  hasTrustedGitInitContext,
} from './git-effects';
import { isAllowListed, governedFamilyDefault } from './governed-families';
import {
  extractCommandSubstitutions,
  segmentCommand,
  shellTokens,
  stripQuotedRegions,
} from './lexer';
import { matchesPattern, ownerIdentityPattern, isPipeIntoLocalScript } from './patterns';
import { createClassifierPorts } from './ports';
import { normalizeCommandTokens } from './wrappers';
import type {
  Classification,
  ClassifierContext,
  ClassifierPorts,
  Decision,
  Enforcement,
  Source,
} from './types';

export type { Classification, ClassifierContext, ClassifierPorts, CommandFact } from './types';
export {
  shellTokens,
  segmentCommand,
  extractCommandSubstitutions,
  stripQuotedRegions,
} from './lexer';
export { normalizeCommandTokens } from './wrappers';
export { buildCommandFact, latticeDecision } from './capabilities';
export { parseCommandAdapters } from './adapters';
export { createClassifierPorts } from './ports';

/** Classify without changing process globals. Effect ports are bounded and request-owned. */
export function classifyCommand(raw: string, context: ClassifierContext): Classification {
  const ports =
    context.ports ?? createClassifierPorts(context.environment ?? {}, context.deadlineUnixMs);
  try {
    context = {
      ...context,
      repoRoot: ports.realpath(context.repoRoot),
      home: ports.realpath(context.home),
      cwd: ports.realpath(context.cwd),
    };
  } catch {
    return {
      decision: 'ask',
      reason: 'cannot resolve classification context — cannot fully analyze command',
      source: 'classifier_error',
      enforcement: 'confirm',
    };
  }
  const adapters = loadCommandAdapters(context.repoRoot, ports);
  return classify(raw, context, ports, adapters, hasTrustedGitInitContext(context, ports), 0);
}

function classify(
  raw: string,
  context: ClassifierContext,
  ports: ClassifierPorts,
  adapters: AdapterState,
  trusted: boolean,
  depth: number
): Classification {
  if (depth > data.MAX_RECURSION_DEPTH)
    return {
      decision: 'ask',
      reason: 'recursion budget exceeded — cannot fully analyze nested command',
      source: 'classifier_error',
      enforcement: 'confirm',
    };
  let worst: Classification = {
    decision: 'allow',
    reason: '',
    source: 'unknown',
    enforcement: 'pass',
  };
  const priority = { allow: 0, ask: 1, deny: 2 };
  const escalate = (
    decision: Decision,
    reason: string,
    source: Source,
    enforcement?: Enforcement
  ): void => {
    if (priority[decision] <= priority[worst.decision]) return;
    worst = {
      decision,
      reason,
      source,
      enforcement:
        enforcement ??
        (decision === 'deny'
          ? 'block'
          : decision === 'allow'
            ? 'pass'
            : ['capability', 'classifier_error', 'sidecar_error'].includes(source)
              ? 'confirm'
              : 'advisory'),
    };
  };
  const propagate = (result: Classification, prefix = ''): void => {
    if (result.decision !== 'allow')
      escalate(result.decision, `${prefix}${result.reason}`, result.source, result.enforcement);
  };
  const surface = stripQuotedRegions(raw);
  for (const [pattern, reason] of data.DENY_PIPELINE_PATTERNS) {
    if (
      matchesPattern(pattern, surface) &&
      !(reason === data.GENERIC_PIPE_TO_SHELL_DESC && isPipeIntoLocalScript(surface))
    )
      escalate('deny', reason, 'regex');
  }
  for (const body of extractCommandSubstitutions(raw))
    if (body.trim())
      propagate(
        classify(body, context, ports, adapters, trusted, depth + 1),
        'command substitution: '
      );
  for (const segment of segmentCommand(raw)) {
    const tokens = shellTokens(segment);
    const normalized = tokens === null ? null : normalizeCommandTokens(tokens);
    if (normalized?.nested !== null && normalized?.nested !== undefined) {
      propagate(classify(normalized.nested, context, ports, adapters, trusted, depth + 2));
      continue;
    }
    const git = classifyGitSemantics(segment, context, ports, trusted);
    const gitAllowed = git?.[0] === 'allow';
    if (git) escalate(git[0], git[1], 'legacy_family');
    const executable = stripQuotedRegions(segment);
    for (const [pattern, reason] of data.DENY_SEGMENT_PATTERNS)
      if (matchesPattern(pattern, executable)) escalate('deny', reason, 'regex');
    for (const [pattern, reason] of data.DENY_RAW_SEGMENT_PATTERNS)
      if (matchesPattern(pattern.replace('{OWNER}', ownerIdentityPattern(context)), segment))
        escalate('deny', reason, 'regex');
    for (const [pattern, reason] of data.CONFIRM_SEGMENT_PATTERNS) {
      if (
        matchesPattern(pattern, executable) &&
        !(reason.includes('git init') && trusted) &&
        !gitAllowed
      )
        escalate('ask', reason, 'regex');
    }
    const rm = recursiveRmTargets(segment);
    if (rm.recursive) {
      if (!rm.targets.length)
        escalate('ask', 'recursive delete with unparseable targets', 'rm_classifier');
      for (const target of rm.targets) {
        const finding = classifyRmTarget(target, context, ports);
        escalate(finding[0], finding[1], 'rm_classifier');
      }
    }
    const find = classifyFindDelete(segment);
    if (find) escalate(find[0], find[1], 'find_delete');
    const deletions = classifyCommitDeletions(segment, context, ports);
    if (deletions) escalate(deletions[0], deletions[1], 'commit_deletions', 'confirm');
    if (!isAllowListed(segment) && !gitAllowed) {
      const fact = buildCommandFact(segment, adapters);
      context.traceFact?.(fact, segment);
      if (
        !adapters.ok &&
        fact.kind === 'NONE' &&
        !(data.OPAQUE_EXEC_EXECUTABLES as readonly string[]).includes(fact.executable)
      )
        escalate(
          'ask',
          `command-adapters sidecar invalid (fail-closed): ${adapters.error}`,
          'capability'
        );
      if ((data.OPAQUE_EXEC_EXECUTABLES as readonly string[]).includes(fact.executable)) {
        if (fact.opacity === 'opaque')
          escalate(
            'ask',
            `opaque execution — cannot prove payload (${fact.executable})`,
            'capability'
          );
        else if (fact.opacity === 'literal' && fact.payload) {
          // Opaque-exec recursion's source belongs to the outer capability finding.
          const inner = classify(fact.payload, context, ports, adapters, false, depth + 2);
          if (inner.decision !== 'allow')
            escalate(
              inner.decision,
              `${fact.executable} literal payload: ${inner.reason}`,
              'capability'
            );
        }
      } else {
        const finding = latticeDecision(fact);
        if (finding) escalate(finding[0], finding[1], 'capability');
      }
      const family = governedFamilyDefault(segment);
      if (family) escalate(family[0], family[1], 'legacy_family');
    }
  }
  return worst;
}
