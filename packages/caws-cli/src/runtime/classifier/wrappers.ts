import { basename } from 'node:path';
import * as data from './data';
import { shellTokens } from './lexer';

export const isAssignmentToken = (token: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
const quoteArgument = (token: string): string =>
  /^[A-Za-z0-9_./:@%+=,-]+$/.test(token) ? token : `'${token.replace(/'/g, "'\\''")}'`;

function splitEnvCommand(
  tokens: readonly string[],
  index: number,
  split: string,
  remaining: number
): { index: number; nested: string | null; unproven?: true } {
  // env -S has expansion/escape rules beyond shellTokens' quote grammar.
  // Do not turn unmodeled syntax into an executable or an exemption.
  const expanded = /[\\$`]/.test(split) ? null : shellTokens(split);
  if (expanded === null) return { index, nested: null, unproven: true };
  return {
    index,
    // Keep env itself: split words can begin with more env options. The
    // remaining original argv elements must retain their individual bounds.
    nested: [...tokens.slice(0, index), ...expanded, ...tokens.slice(remaining)]
      .map(quoteArgument)
      .join(' '),
  };
}

export function normalizeCommandTokens(tokens: readonly string[]): {
  index: number;
  nested: string | null;
  unproven?: true;
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
          ['-', '-i', '-0', '--ignore-environment', '--null'].includes(option)
        ) {
          index++;
          continue;
        }
        if (['-u', '--unset', '-C', '--chdir', '-S', '--split-string'].includes(option)) {
          if (['-S', '--split-string'].includes(option) && index + 1 < tokens.length)
            return splitEnvCommand(tokens, index, tokens[index + 1] ?? '', index + 2);
          index += 2;
          continue;
        }
        if (option.startsWith('--split-string='))
          return splitEnvCommand(tokens, index, option.slice(15), index + 1);
        if (option.startsWith('--unset=') || option.startsWith('--chdir=')) {
          index++;
          continue;
        }
        if (/^-[uC].+/.test(option)) {
          index++;
          continue;
        }
        break;
      }
      continue;
    }
    if (base === 'time') {
      index++;
      while ((tokens[index] ?? '').startsWith('-')) {
        const option = tokens[index] ?? '';
        if (['--help', '--version'].includes(option)) return { index, nested: null };
        if (option === '--') {
          index++;
          break;
        }
        index += ['-f', '-o', '--format', '--output'].includes(option) ? 2 : 1;
      }
      continue;
    }
    if (base === 'nice') {
      index++;
      const option = tokens[index] ?? '';
      if (['-n', '--adjustment'].includes(option)) index += 2;
      else if (/^(?:-[0-9]+|-n[+-]?[0-9]+|--adjustment=[+-]?[0-9]+)$/.test(option)) index++;
      if (tokens[index] === '--') index++;
      continue;
    }
    if ((data.COMMAND_WRAPPERS as readonly string[]).includes(base)) {
      index++;
      if (base === 'command' && tokens[index] === '-p') index++;
      if (tokens[index] === '--') index++;
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
    if ((token.startsWith('-C') || token.startsWith('-c')) && token.length > 2) {
      index++;
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

/** Directory-changing wrappers are recognized but not executed by classification. */
export function wrapperChangesDirectory(tokens: readonly string[], commandIndex: number): boolean {
  return tokens
    .slice(0, commandIndex)
    .some(
      (token) =>
        token === '-C' || token === '--chdir' || token.startsWith('--chdir=') || /^-C.+/.test(token)
    );
}

/** A proof query must not silently ignore environment/configuration supplied by a wrapper. */
export function hasUnprovenGitWrapperContext(
  tokens: readonly string[],
  commandIndex: number
): boolean {
  return (
    wrapperChangesDirectory(tokens, commandIndex) ||
    tokens
      .slice(0, commandIndex)
      .some(
        (token) =>
          /^GIT_[A-Za-z0-9_]*(?:=|$)/.test(token) ||
          /^--unset=GIT_/.test(token) ||
          ['-i', '--ignore-environment', '-'].includes(token)
      )
  );
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
