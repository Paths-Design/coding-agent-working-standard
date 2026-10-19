import { basename } from 'node:path';
import * as data from './data';
import { shellTokens } from './lexer';
import { detectGitSubcommand, extractCommandWord, normalizeCommandTokens } from './wrappers';
import { classifyFindDelete } from './filesystem-effects';
import type { Finding } from './types';

const member = (values: readonly string[], value: string): boolean => values.includes(value);
const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
]);
const plainPath = (token: string): boolean => /^[A-Za-z0-9._/@+-]+$/.test(token);
const treeish = (token: string): boolean => /^[A-Za-z0-9._/@^~+][A-Za-z0-9._/@^~+-]*$/.test(token);
export function isLockfileOnlyRestore(tokens: readonly string[]): boolean {
  const targets: string[] = [];
  for (const token of tokens.slice(2)) {
    if (token === '--') continue;
    if (token.startsWith('-') || !plainPath(token)) return false;
    targets.push(token);
  }
  return (
    targets.length > 0 &&
    targets.every(
      (target) => !target.endsWith('/') && LOCKFILES.has(target.split('/').at(-1) ?? '')
    )
  );
}
export function isIndexOnlyRestore(tokens: readonly string[]): boolean {
  let staged = false;
  let targets = 0;
  let separator = false;
  let source = false;
  for (const token of tokens.slice(2)) {
    if (source) {
      if (!treeish(token)) return false;
      source = false;
      continue;
    }
    if (!separator) {
      if (token === '--') {
        separator = true;
        continue;
      }
      if (['--staged', '-S'].includes(token)) {
        staged = true;
        continue;
      }
      if (['--source', '-s'].includes(token)) {
        source = true;
        continue;
      }
      if (token.startsWith('--source=')) {
        if (!treeish(token.slice(9))) return false;
        continue;
      }
      if (token.startsWith('-')) return false;
    }
    if (!plainPath(token)) return false;
    targets++;
  }
  return staged && !source && targets >= 1;
}
function familyArgs(segment: string, family: string): string[] | null {
  const tokens = shellTokens(segment);
  if (!tokens) return null;
  const { index, nested } = normalizeCommandTokens(tokens);
  return nested === null && basename(tokens[index] ?? '') === family
    ? tokens.slice(index + 1)
    : null;
}
export function detectGhSubcommand(segment: string): [string, string] | null {
  const args = familyArgs(segment, 'gh')?.filter((token) => !token.startsWith('-'));
  if (!args?.length) return null;
  return [args[0] ?? '', args[0] === 'api' ? '' : (args[1] ?? '')];
}
export function ghApiMethod(segment: string): string {
  const tokens = shellTokens(segment) ?? [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? '';
    if (['-X', '--method'].includes(token) && index + 1 < tokens.length)
      return (tokens[index + 1] ?? '').toUpperCase();
    if (token.startsWith('-X') && token.length > 2) return token.slice(2).toUpperCase();
    if (token.startsWith('--method=')) return token.slice(9).toUpperCase();
  }
  return 'GET';
}
export function detectNpmSubcommand(segment: string): string | null {
  return familyArgs(segment, 'npm')?.find((token) => !token.startsWith('-')) ?? null;
}

export function isAllowListed(segment: string): boolean {
  const command = basename(extractCommandWord(segment));
  if (!command) return false;
  if (command === 'find') return classifyFindDelete(segment) === null;
  if (member(data.ALLOWED_SIMPLE_COMMANDS, command)) return true;
  const tokens = shellTokens(segment);
  if (!tokens) return false;
  const any = (flags: string[]): boolean => tokens.some((token) => flags.includes(token));
  if (command === 'git') {
    const sub = detectGitSubcommand(segment);
    if (!sub) return false;
    if (sub === 'tag') return any(['--list', '-l']) && !any(['-d', '-D', '-m', '-a', '-s', '-f']);
    if (sub === 'branch') return !any(['-d', '-D', '-m', '-M', '--delete', '--move']);
    if (sub === 'config') return any(['--get', '--get-all', '--get-regexp', '--list', '-l']);
    if (sub === 'rm') return any(['--cached', '-n', '--dry-run']);
    if (sub === 'commit')
      return !tokens.some((token) => token === '--amend' || token.startsWith('--amend='));
    if (sub === 'checkout') return any(['-b', '-B']) || isLockfileOnlyRestore(tokens);
    if (sub === 'restore') return isIndexOnlyRestore(tokens) || isLockfileOnlyRestore(tokens);
    if (sub === 'switch') return !any(['-f', '--force', '--discard-changes']);
    if (sub === 'worktree') {
      const index = tokens.indexOf('worktree');
      const action = tokens[index + 1] ?? '';
      return ['', 'list'].includes(action) || (action === 'prune' && any(['--dry-run', '-n']));
    }
    return member(data.ALLOWED_GIT_SUBCOMMANDS, sub);
  }
  if (command === 'gh') {
    const result = detectGhSubcommand(segment);
    if (!result) return false;
    return result[0] === 'api'
      ? ghApiMethod(segment) === 'GET'
      : member(data.ALLOWED_GH_ACTIONS, `${result[0]} ${result[1]}`.trim());
  }
  if (command === 'npm') {
    const sub = detectNpmSubcommand(segment);
    if (!sub) return false;
    return sub === 'pack'
      ? tokens.includes('--dry-run')
      : member(data.ALLOWED_NPM_SUBCOMMANDS, sub);
  }
  return false;
}

export function governedFamilyDefault(segment: string): Finding | null {
  const command = basename(extractCommandWord(segment));
  if (!command) return null;
  for (const family of data.GOVERNED_FAMILIES) {
    if (command.startsWith(`${family}-`))
      return [
        'ask',
        `hyphenated command \`${command}\` shadows governed family \`${family}\` — not on the allow-list; ask before invoking to confirm this is not a PATH-spoof of \`{family}\``,
      ];
  }
  if (command === 'gh') {
    const result = detectGhSubcommand(segment);
    return [
      'ask',
      result
        ? `unknown gh subcommand: ${`${result[0]} ${result[1]}`.trimEnd()} — not on the documented read-only allow-list; ask before invoking`
        : 'unknown gh invocation — ask before invoking',
    ];
  }
  if (command === 'npm') {
    const sub = detectNpmSubcommand(segment);
    return [
      'ask',
      sub
        ? `unknown npm subcommand: ${sub} — not on the documented read-only allow-list; ask before invoking`
        : 'unknown npm invocation — ask before invoking',
    ];
  }
  if (command !== 'git') return null;
  const sub = detectGitSubcommand(segment);
  if (sub === 'commit')
    return [
      'ask',
      'git commit --amend rewrites the last commit — a history-rewrite and attribution-loss risk; ask before invoking',
    ];
  if (sub === 'switch')
    return [
      'ask',
      'git switch with --force/--discard-changes throws away local changes; ask before invoking',
    ];
  if (sub === 'checkout')
    return [
      'ask',
      'git checkout to an existing branch/path can discard uncommitted work; only `checkout -b` and a restore of package-manager lockfiles are auto-admitted; ask before invoking',
    ];
  if (sub === 'restore')
    return [
      'ask',
      'git restore of a path other than a package-manager lockfile discards uncommitted work (only `--staged` and lockfile-only restores are auto-admitted); ask before invoking',
    ];
  return [
    'ask',
    sub
      ? `unknown git subcommand: ${sub} — not on the documented read-only allow-list; ask before invoking`
      : 'unknown git invocation — ask before invoking',
  ];
}
