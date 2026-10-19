import { join, resolve, isAbsolute } from 'node:path';
import * as data from './data';
import { shellTokens } from './lexer';
import {
  detectGitSubcommand,
  hasGitInitAliasConfig,
  locateGitSubcommand,
  hasUnprovenGitWrapperContext,
} from './wrappers';
import type { ClassifierContext, ClassifierPorts, Finding } from './types';

function trustedToken(context: ClassifierContext): string | null {
  const trusted = context.trustedInit;
  if (!trusted?.enabled || !/^[A-Za-z0-9._-]{8,128}$/.test(trusted.nonce)) return null;
  return join(
    context.repoRoot,
    trusted.vendorDirectory,
    'hooks/state',
    `allow-git-init-${trusted.nonce}`
  );
}
export function hasTrustedGitInitContext(
  context: ClassifierContext,
  ports: ClassifierPorts
): boolean {
  const token = trustedToken(context);
  return token !== null && ports.isFile(token);
}

/** Resolve only routing the observation port can faithfully reproduce. */
function effectiveGitCwd(
  tokens: readonly string[],
  location: { start: number; subIndex: number },
  context: ClassifierContext,
  ports: ClassifierPorts,
  proofContextKnown = true
): string | null {
  if (!proofContextKnown || !context.cwd || hasUnprovenGitWrapperContext(tokens, location.start))
    return null;
  // No list of currently known routing names can prove a future GIT_* variable inert.
  if (
    Object.entries(context.environment ?? {}).some(
      ([name, value]) => name.startsWith('GIT_') && Boolean(value)
    )
  )
    return null;
  let cwd = context.cwd;
  for (let index = location.start + 1; index < location.subIndex; index++) {
    const token = tokens[index] ?? '';
    if (token === '-C' || (token.startsWith('-C') && token.length > 2)) {
      const directory = token === '-C' ? tokens[++index] : token.slice(2);
      if (directory === undefined || /[$`*?~]/.test(directory)) return null;
      if (directory) {
        try {
          // Keep path components intact until physical resolution: link/.. may
          // leave the lexical parent when link names a directory elsewhere.
          cwd = ports.realpath(isAbsolute(directory) ? directory : `${cwd}/${directory}`);
        } catch {
          return null;
        }
      }
    } else if (
      ['--bare', '--no-replace-objects'].includes(token) ||
      (token !== '--' && !(data.GIT_GLOBAL_OPTIONS_NO_VALUE as readonly string[]).includes(token))
    )
      return null;
  }
  return cwd;
}

export function cherryPickTouchesOnlySpecs(
  segment: string,
  context: ClassifierContext,
  ports: ClassifierPorts
): boolean {
  const tokens = shellTokens(segment);
  if (!tokens) return false;
  const location = locateGitSubcommand(tokens);
  if (!location || tokens[location.subIndex] !== 'cherry-pick') return false;
  const commits = tokens.slice(location.subIndex + 1);
  if (!commits.length || commits.some((token) => token.startsWith('-') || token.includes('..')))
    return false;
  const cwd = effectiveGitCwd(tokens, location, context, ports);
  if (cwd === null) return false;
  const query = (args: readonly string[], directory: string) => {
    try {
      return ports.git(args, directory);
    } catch {
      return { status: -1, stdout: '' };
    }
  };
  // Linked checkouts share authority, but each has its own HEAD. Compare common
  // directories for custody, then inspect revisions in the effective checkout.
  const common = query(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  const canonicalCommon =
    cwd === context.repoRoot
      ? common
      : query(['rev-parse', '--path-format=absolute', '--git-common-dir'], context.repoRoot);
  if (
    common.status !== 0 ||
    canonicalCommon.status !== 0 ||
    !common.stdout.trim() ||
    !canonicalCommon.stdout.trim()
  )
    return false;
  try {
    if (ports.realpath(common.stdout.trim()) !== ports.realpath(canonicalCommon.stdout.trim()))
      return false;
  } catch {
    return false;
  }
  return commits.every((commit) => {
    const result = query(['show', '--name-only', '--format=', commit], cwd);
    const files = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return (
      result.status === 0 &&
      files.length > 0 &&
      files.every((file) => /^\.caws\/specs\/[^/]+\.(?:yaml|yml)$/.test(file))
    );
  });
}
export function classifyGitSemantics(
  segment: string,
  context: ClassifierContext,
  ports: ClassifierPorts,
  trusted: boolean,
  proofContextKnown = true
): Finding | null {
  const alias = hasGitInitAliasConfig(segment);
  const subcommand = alias ? null : detectGitSubcommand(segment);
  if (alias || subcommand === 'init') {
    const token = trustedToken(context);
    if (trusted && token !== null && ports.consumeFile(token)) return ['allow', ''];
    return [
      'ask',
      alias
        ? 'git alias routes to init and requires human approval'
        : 'git init requires human approval; do not retry by wrapping, reordering, aliasing, or indirect invocation',
    ];
  }
  if (subcommand === 'rebase') return ['ask', 'git rebase rewrites branch history'];
  if (subcommand === 'cherry-pick')
    return proofContextKnown && cherryPickTouchesOnlySpecs(segment, context, ports)
      ? ['allow', '']
      : ['ask', 'git cherry-pick replays commits across branches'];
  return null;
}

export function commitStagesAll(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === '--all') return true;
    if (!arg.startsWith('-') || arg.startsWith('--')) continue;
    for (const flag of arg.slice(1)) {
      if (flag === 'a') return true;
      if (data._COMMIT_SHORT_OPTS_WITH_VALUE.includes(flag)) break;
    }
  }
  return false;
}

function mergeParents(cwd: string, ports: ClassifierPorts): string[] {
  const result = ports.git(['rev-parse', '--git-path', 'MERGE_HEAD'], cwd);
  if (result.status !== 0) return [];
  const name = result.stdout.trim();
  if (!name) return [];
  let text: string | null;
  try {
    text = ports.read(isAbsolute(name) ? name : resolve(cwd, name));
  } catch {
    return [];
  } // Unreadable merge metadata grants no incoming-deletion exemption.
  return (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
function incomingPaths(
  cwd: string,
  parents: string[],
  paths: string[],
  ports: ClassifierPorts
): Set<string> {
  const incoming = new Set<string>();
  const names = (args: string[]): Set<string> | null => {
    const result = ports.git(['-c', 'core.quotePath=false', ...args], cwd);
    return result.status === 0 ? new Set(result.stdout.split('\0').filter(Boolean)) : null;
  };
  for (const parent of parents) {
    const differs = names(['diff', '--cached', '--name-only', '-z', parent]);
    const base = ports.git(['merge-base', 'HEAD', parent], cwd);
    if (!differs || base.status !== 0) continue;
    const changed = names(['diff', '--name-only', '-z', base.stdout.trim(), parent]);
    if (!changed) continue;
    for (const path of paths) if (!differs.has(path) && changed.has(path)) incoming.add(path);
  }
  return incoming;
}

const REMEDIATION =
  'inspect the staged set first (git status; git diff --cached --stat), then commit with the paths named explicitly: git commit -m <msg> -- <paths>';
const MERGE_REMEDIATION =
  'a merge is in progress: git rejects a pathspec commit during a merge, and this refusal cannot be confirmed in any mode, so complete the merge without a prompt. (1) List the deletions the merge did not bring in: git diff --cached --diff-filter=D --name-only MERGE_HEAD. (2) Unstage them; the files stay deleted in the working tree: git restore --staged -- <those paths>. (3) Conclude the merge with a bare git commit (or git commit --no-edit); every staged deletion left is incoming from the merge. (4) After the merge, commit those deletions on their own: git commit -m <msg> -- <deleted paths>. If any of those deletions were not intended, stop and ask the user';

export function classifyCommitDeletions(
  segment: string,
  context: ClassifierContext,
  ports: ClassifierPorts,
  proofContextKnown = true
): Finding | null {
  const tokens = shellTokens(segment);
  if (!tokens) return null;
  const location = locateGitSubcommand(tokens);
  if (!location || tokens[location.subIndex] !== 'commit') return null;
  const args = tokens.slice(location.subIndex + 1);
  if (
    args.some((token) => token === '--amend' || token.startsWith('--amend=')) ||
    args.includes('--dry-run')
  )
    return null;
  const separator = args.indexOf('--');
  if (separator >= 0 && separator < args.length - 1) return null;
  const firstFlag = args.findIndex((token) => token.startsWith('-'));
  if ((firstFlag < 0 ? args.length : firstFlag) > 0) return null;
  const fail = (detail: string): Finding => [
    'ask',
    `bare git commit (no pathspec) commits the ENTIRE index, and the staged state could not be verified (${detail}) — not auto-admitting; ${REMEDIATION}`,
  ];
  if (!context.cwd) return fail('no working directory available');
  const cwd = effectiveGitCwd(tokens, location, context, ports, proofContextKnown);
  if (cwd === null) return fail('the effective git checkout/index cannot be proven');
  const all = commitStagesAll(args);
  const result = ports.git(
    [
      '-c',
      'core.quotePath=false',
      'diff',
      ...(all ? [] : ['--cached']),
      '--diff-filter=D',
      '--name-only',
      '-z',
      ...(all ? ['HEAD'] : []),
    ],
    cwd
  );
  if (result.status !== 0) return fail('not a git repository here, or git failed');
  let deleted = result.stdout.split('\0').filter(Boolean);
  if (!deleted.length) return null;
  const parents = all ? [] : mergeParents(cwd, ports);
  if (parents.length) {
    const incoming = incomingPaths(cwd, parents, deleted, ports);
    deleted = deleted.filter((path) => !incoming.has(path));
    if (!deleted.length) return null;
  }
  const shown = deleted.slice(0, 3).join(', ') + (deleted.length > 3 ? ', …' : '');
  return [
    'ask',
    `bare git commit (no pathspec) would commit the ENTIRE index, which currently stages ${deleted.length} deletion(s) of tracked files (${shown}) — a stale or foreign index sweeps content you did not intend under your message; ${parents.length ? MERGE_REMEDIATION : REMEDIATION}`,
  ];
}
