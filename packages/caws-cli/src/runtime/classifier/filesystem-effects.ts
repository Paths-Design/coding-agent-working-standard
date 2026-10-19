import { basename, relative } from 'node:path';
import * as data from './data';
import { shellTokens } from './lexer';
import { normalizeCommandTokens } from './wrappers';
import type { ClassifierContext, ClassifierPorts, Finding } from './types';

export function recursiveRmTargets(segment: string): { recursive: boolean; targets: string[] } {
  const tokens = shellTokens(segment);
  if (!tokens)
    return { recursive: /\brm\b/.test(segment) && /-[a-zA-Z]*r/.test(segment), targets: [] };
  const { index: start, nested } = normalizeCommandTokens(tokens);
  if (nested !== null || basename(tokens[start] ?? '') !== 'rm')
    return { recursive: false, targets: [] };
  const targets: string[] = [];
  let recursive = false;
  const standalone = ['2>&1', '>&2', '1>&2', '&>', '&>>'];
  const operand = ['>', '>>', '2>', '1>', '2>>', '1>>', '<', '<<'];
  for (let index = start + 1; index < tokens.length; index++) {
    const token = tokens[index] ?? '';
    if (token === '--') {
      targets.push(...tokens.slice(index + 1));
      break;
    }
    if (standalone.includes(token)) continue;
    if (operand.some((operator) => token.startsWith(operator))) {
      if (operand.includes(token)) index++;
      continue;
    }
    if (token.startsWith('-') && !token.startsWith('--')) {
      if (/[rR]/.test(token)) recursive = true;
    } else if (token.startsWith('--')) {
      if (token === '--recursive') recursive = true;
    } else targets.push(token);
  }
  return { recursive, targets };
}

export function classifyRmTarget(
  target: string,
  context: ClassifierContext,
  ports: ClassifierPorts
): Finding {
  const raw = target.trim();
  if (!raw) return ['deny', 'empty target on recursive delete'];
  if (/[*?\[\]]/.test(raw)) {
    if (['/*', '~/*', './*'].includes(raw.replace(/\/+$/, '')))
      return ['deny', `glob expansion at dangerous root: ${raw}`];
    return ['ask', `recursive delete with glob pattern: ${raw}`];
  }
  let resolved: string;
  try {
    resolved = ports.realpath(
      raw.startsWith('~')
        ? raw.length > 1
          ? `${context.home}/${raw.slice(2)}`
          : context.home
        : raw.startsWith('/')
          ? raw
          : `${context.cwd}/${raw}`
    );
  } catch {
    return ['ask', `cannot resolve path: ${raw}`];
  }
  if (resolved === '/') return ['deny', 'recursive delete targets filesystem root'];
  if (resolved === context.home) return ['deny', 'recursive delete targets home directory'];
  if (resolved === context.repoRoot) return ['deny', 'recursive delete targets repository root'];
  if (context.repoRoot.startsWith(`${resolved}/`))
    return ['deny', `recursive delete targets ancestor of repository: ${raw}`];
  if (context.home.startsWith(`${resolved}/`))
    return ['deny', `recursive delete targets ancestor of home directory: ${raw}`];
  const rel = relative(context.repoRoot, resolved);
  if (
    !rel.startsWith('../') &&
    rel !== '..' &&
    !rel.startsWith('/') &&
    data.SAFE_DELETE_PREFIXES.some((prefix) => `${rel}/`.startsWith(prefix))
  )
    return ['allow', ''];
  const scratch: string[] = [...data.SYSTEM_TMP_PREFIXES];
  if (context.temporaryDirectory) {
    try {
      scratch.push(`${ports.realpath(context.temporaryDirectory).replace(/\/+$/, '')}/`);
    } catch {
      /* Unresolved optional scratch root grants nothing. */
    }
  }
  if (
    scratch.some(
      (root) =>
        resolved.startsWith(root) && resolved.replace(/\/+$/, '') !== root.replace(/\/+$/, '')
    )
  )
    return ['allow', ''];
  return ['ask', `recursive delete: ${raw}`];
}

export function classifyFindDelete(segment: string): Finding | null {
  const tokens = shellTokens(segment);
  if (!tokens) return null;
  const { index, nested } = normalizeCommandTokens(tokens);
  if (nested !== null || basename(tokens[index] ?? '') !== 'find') return null;
  return tokens
    .slice(index + 1)
    .some((token) =>
      ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf'].includes(
        token
      )
    )
    ? ['ask', 'find with mutating action flag (-delete/-exec/-execdir/-fprint/-ok)']
    : null;
}
