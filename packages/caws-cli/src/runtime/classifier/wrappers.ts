import { basename } from 'node:path';
import * as data from './data';
import { shellTokens } from './lexer';

export const isAssignmentToken = (token: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
export function normalizeCommandTokens(tokens: readonly string[]): {
  index: number;
  nested: string | null;
} {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? '';
    const base = basename(token);
    if (isAssignmentToken(token)) {
      index++;
      continue;
    }
    if (base === 'env') {
      index++;
      while (index < tokens.length) {
        const option = tokens[index] ?? '';
        if (option === '--') {
          index++;
          break;
        }
        if (
          isAssignmentToken(option) ||
          ['-i', '-0', '--ignore-environment', '--null'].includes(option)
        ) {
          index++;
          continue;
        }
        if (['-u', '--unset', '-C', '--chdir', '-S', '--split-string'].includes(option)) {
          if (['-S', '--split-string'].includes(option) && index + 1 < tokens.length)
            return { index, nested: tokens.slice(index + 1).join(' ') };
          index += 2;
          continue;
        }
        if (option.startsWith('--split-string='))
          return { index, nested: [option.slice(15), ...tokens.slice(index + 1)].join(' ') };
        if (option.startsWith('--unset=') || option.startsWith('--chdir=')) {
          index++;
          continue;
        }
        break;
      }
      continue;
    }
    if (base === 'time') {
      index++;
      while ((tokens[index] ?? '').startsWith('-'))
        index += ['-f', '-o'].includes(tokens[index] ?? '') ? 2 : 1;
      continue;
    }
    if ((data.COMMAND_WRAPPERS as readonly string[]).includes(base)) {
      index++;
      continue;
    }
    if ((data.SHELL_C_WRAPPERS as readonly string[]).includes(base)) {
      for (let cursor = index + 1; cursor < tokens.length; cursor++) {
        const arg = tokens[cursor] ?? '';
        if (arg === '--') continue;
        if (arg.startsWith('-') && arg.slice(1).includes('c'))
          return { index, nested: tokens[cursor + 1] ?? '' };
        if (!arg.startsWith('-')) break;
      }
    }
    return { index, nested: null };
  }
  return { index, nested: null };
}

export function locateGitSubcommand(
  tokens: readonly string[]
): { start: number; subIndex: number } | null {
  const { index: start, nested } = normalizeCommandTokens(tokens);
  if (nested !== null || basename(tokens[start] ?? '') !== 'git') return null;
  let index = start + 1;
  while (index < tokens.length) {
    const token = tokens[index] ?? '';
    if (token === '--') {
      index++;
      break;
    }
    if ((data.GIT_GLOBAL_OPTIONS_WITH_VALUE as readonly string[]).includes(token)) {
      index += 2;
      continue;
    }
    if (
      data.GIT_GLOBAL_OPTIONS_WITH_VALUE.some(
        (option) => option.startsWith('--') && token.startsWith(`${option}=`)
      )
    ) {
      index++;
      continue;
    }
    if ((data.GIT_GLOBAL_OPTIONS_NO_VALUE as readonly string[]).includes(token)) {
      index++;
      continue;
    }
    if (token.startsWith('-')) {
      if (token.includes('=')) {
        index++;
        continue;
      }
      return null;
    }
    return { start, subIndex: index };
  }
  return index < tokens.length && !(tokens[index] ?? '').startsWith('-')
    ? { start, subIndex: index }
    : null;
}

export function detectGitSubcommand(segment: string): string | null {
  const tokens = shellTokens(segment);
  if (!tokens) return null;
  const location = locateGitSubcommand(tokens);
  return location ? (tokens[location.subIndex] ?? null) : null;
}

/** Legacy command-word contract deliberately differs from full wrapper normalization. */
export function extractCommandWord(segment: string): string {
  const tokens = shellTokens(segment);
  if (tokens === null) return segment.trim().split(/\s+/)[0] ?? '';
  return (
    tokens.find(
      (token) =>
        !(token.includes('=') && !token.startsWith('-')) &&
        !['env', 'time', 'nice', 'nohup', 'command', 'builtin'].includes(token)
    ) ?? ''
  );
}

export function hasGitInitAliasConfig(segment: string): boolean {
  const tokens = shellTokens(segment);
  if (!tokens) return false;
  const { index: start, nested } = normalizeCommandTokens(tokens);
  if (nested !== null || basename(tokens[start] ?? '') !== 'git') return false;
  for (let index = start + 1; index < tokens.length; index++) {
    const token = tokens[index] ?? '';
    let config = '';
    if (token === '-c') config = tokens[++index] ?? '';
    else if (token.startsWith('-c')) config = token.slice(2);
    const equals = config.indexOf('=');
    if (equals < 0 || !config.slice(0, equals).startsWith('alias.')) continue;
    const value = config.slice(equals + 1).trim();
    const invokesInit = (command: string): boolean =>
      command === 'init' || command.startsWith('init ');
    if (invokesInit(value)) return true;
    if (value.startsWith('!')) {
      const command = value.slice(1).trim();
      if (invokesInit(command) || detectGitSubcommand(command) === 'init') return true;
    }
  }
  return false;
}
