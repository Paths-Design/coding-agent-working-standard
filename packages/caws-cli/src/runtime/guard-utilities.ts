import { spawnSync } from 'node:child_process';
import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename, isAbsolute, relative, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { shellTokens } from './classifier/lexer';
import { resolveExistingPrefix } from './classifier/ports';
import { resolveGitBinaryForEnvironment } from '../store/git-binary';
import type { NativeResult } from './types';

export interface GuardUtilityPolicy {
  readonly version: 1;
  readonly rg_replace?: boolean;
  readonly ignored_staging?: boolean;
  readonly focused_tests?: {
    readonly entry_point?: string;
    readonly executables?: readonly string[];
  };
  readonly documents?: {
    readonly roots?: readonly string[];
    readonly required_frontmatter?: readonly string[];
  };
}
export interface GuardUtilityInput {
  readonly tool: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly cwd: string;
}
export interface GuardUtilityPorts {
  /** Fixed read-only Git argv only; raw NUL-delimited paths must not be decoded lossily. */
  git(args: readonly string[], cwd: string): { status: number; stdout: Uint8Array };
  readPathspec(path: string): Uint8Array;
  realpath(path: string): string;
  /** False when inherited Git routing prevents proving the repository from cwd. */
  readonly gitContextKnown: boolean;
}
export interface GuardUtilityEvaluation {
  readonly notices: readonly string[];
  readonly violations: readonly string[];
}
type Word = { value: string; dynamic: boolean; substitutions?: string[] };
type Token = { kind: 'word'; word: Word } | { kind: 'op' | 'redirect'; value: string };
const PATHSPEC_LIMIT = 1024 * 1024;
const decode = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Optional consumer policy, independent of repository governance and guard authority. */
export function parseGuardUtilityPolicy(text: string): GuardUtilityPolicy {
  const value: unknown = JSON.parse(text);
  if (!object(value) || value.version !== 1) throw new Error('expected policy version 1');
  const keys = new Set(['version', 'rg_replace', 'ignored_staging', 'focused_tests', 'documents']);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new Error('unknown policy keys');
  for (const key of ['rg_replace', 'ignored_staging']) {
    if (Object.hasOwn(value, key) && typeof value[key] !== 'boolean')
      throw new Error(`${key} must be boolean`);
  }
  for (const key of ['focused_tests', 'documents']) {
    if (Object.hasOwn(value, key) && !object(value[key]))
      throw new Error(`${key} must be an object`);
  }
  const tests = value.focused_tests;
  if (
    object(tests) &&
    Object.keys(tests).length &&
    (typeof tests.entry_point !== 'string' || !strings(tests.executables))
  ) {
    throw new Error('focused_tests requires executable names and a display entry_point');
  }
  const documents = value.documents;
  if (object(documents)) {
    for (const key of ['roots', 'required_frontmatter']) {
      if (Object.hasOwn(documents, key) && !strings(documents[key]))
        throw new Error(`documents.${key} must be an array of strings`);
    }
  }
  return value as unknown as GuardUtilityPolicy;
}

/** Native read-only adapter: no shell, no Python, no process environment mutation. */
export function createGuardUtilityPorts(
  environment: Readonly<Record<string, string>>,
  deadlineUnixMs?: number
): GuardUtilityPorts {
  const snapshot = { ...environment, GIT_OPTIONAL_LOCKS: '0' };
  return {
    gitContextKnown: !Object.entries(environment).some(
      ([key, value]) => key.startsWith('GIT_') && value !== ''
    ),
    realpath: resolveExistingPrefix,
    git(args, cwd) {
      const timeout =
        deadlineUnixMs === undefined ? 3000 : Math.min(3000, deadlineUnixMs - Date.now());
      const binary = resolveGitBinaryForEnvironment(snapshot, cwd);
      if (timeout <= 0 || binary === undefined) return { status: -1, stdout: new Uint8Array() };
      const result = spawnSync(binary, [...args], {
        cwd,
        env: snapshot,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { status: result.status ?? -1, stdout: result.stdout ?? new Uint8Array() };
    },
    readPathspec(path) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) throw new Error('pathspec source is not a regular file');
        if (stat.size > PATHSPEC_LIMIT) throw new Error('pathspec file exceeds utility budget');
        const bytes = Buffer.alloc(PATHSPEC_LIMIT + 1);
        let count = 0;
        while (count < bytes.length) {
          const size = readSync(fd, bytes, count, bytes.length - count, null);
          if (size === 0) break;
          count += size;
        }
        if (count > PATHSPEC_LIMIT) throw new Error('pathspec file exceeds utility budget');
        return bytes.subarray(0, count);
      } finally {
        closeSync(fd);
      }
    },
  };
}

/** Same file-sink envelope as shared/lib/heredoc.sh: interpreter payload stays visible. */
function blankFileSinkHeredocs(raw: string): string {
  let delimiter: string | null = null;
  let indent = false;
  return raw
    .split('\n')
    .map((line) => {
      if (delimiter !== null) {
        if ((indent ? line.trimStart() : line) === delimiter) delimiter = null;
        else return '';
        return line;
      }
      if (!/(?:^|[|;&])\s*(?:cat|tee)(?:\s|$)/.test(line)) return line;
      const marker = line.indexOf('<<');
      if (marker < 0 || line[marker + 2] === '<') return line;
      let rest = line.slice(marker + 2);
      indent = rest.startsWith('-');
      if (indent) rest = rest.slice(1);
      rest = rest.trimStart().split(/\s/)[0]!.split('>')[0]!;
      rest = rest.replace(/^["']/, '').replace(/["']$/, '');
      if (rest) delimiter = rest;
      return line;
    })
    .join('\n');
}

/** Metadata adapter over the shared quote decoder. It never evaluates shell syntax. */
function tokenRecords(raw: string, depth = 0): Token[] {
  if (depth > 32) throw new Error('shell expansion budget exceeded');
  raw = blankFileSinkHeredocs(raw);
  if (raw.includes('\0')) throw new Error('NUL in shell command');
  const tokens: Token[] = [];
  let substitutions: string[] = [];
  let word = '';
  let dynamic = false;
  let quote: "'" | '"' | null = null;
  const flush = (): void => {
    if (!word) return;
    const decoded = shellTokens(word);
    if (decoded === null || decoded.length !== 1) throw new Error('shared command lexer failed');
    tokens.push({ kind: 'word', word: { value: decoded[0]!, dynamic, substitutions } });
    word = '';
    dynamic = false;
    substitutions = [];
  };
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!;
    if (quote === "'") {
      word += char;
      if (char === "'") quote = null;
      continue;
    }
    if (char === '\\') {
      const next = raw[++index];
      if (next === undefined) throw new Error('shared command lexer failed');
      // POSIX double-quoted escapes include $ and `, unlike Python shlex's decoder.
      if (next === '\n') continue;
      word += quote === '"' && (next === '$' || next === '`') ? next : `\\${next}`;
      continue;
    }
    if (char === '"') {
      word += char;
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (quote === null && char === "'") {
      word += char;
      quote = "'";
      continue;
    }
    if (quote === null && char === '$' && raw[index + 1] === "'") {
      let literal = '';
      const pieces: Uint8Array[] = [];
      let end = index + 2;
      const escapes: Record<string, string> = {
        a: '\x07',
        b: '\b',
        e: '\x1b',
        E: '\x1b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
        v: '\v',
        '\\': '\\',
        "'": "'",
        '"': '"',
      };
      for (; end < raw.length && raw[end] !== "'"; end++) {
        if (raw[end] !== '\\') {
          literal += raw[end];
          continue;
        }
        const escaped = raw[++end];
        if (escaped === undefined) throw new Error('unterminated ANSI-C quote');
        if (Object.hasOwn(escapes, escaped)) literal += escapes[escaped];
        else if (escaped === 'c' && raw[end + 1] !== undefined)
          literal += String.fromCharCode(raw[++end]!.toUpperCase().charCodeAt(0) & 31);
        else {
          const base = escaped === 'x' || escaped === 'u' || escaped === 'U' ? 16 : 8;
          const limit = escaped === 'x' ? 2 : escaped === 'u' ? 4 : escaped === 'U' ? 8 : 3;
          const offset = base === 16 ? end + 1 : end;
          const digits = raw
            .slice(offset)
            .match(base === 16 ? new RegExp(`^[0-9a-fA-F]{1,${limit}}`) : /^[0-7]{1,3}/)?.[0];
          if (digits) {
            const point = Number.parseInt(digits, base);
            if (point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
              throw new Error('ANSI-C quote is outside the UTF-8 argument envelope');
            if (base === 8 || escaped === 'x') {
              pieces.push(Buffer.from(literal), Buffer.from([point & 255]));
              literal = '';
            } else literal += String.fromCodePoint(point);
            end = offset + digits.length - 1;
          } else literal += `\\${escaped}`;
        }
      }
      if (end >= raw.length) throw new Error('unterminated ANSI-C quote');
      literal = decode(Buffer.concat([...pieces, Buffer.from(literal)]));
      word += `'${literal.replace(/'/g, "'\\''")}'`;
      index = end;
      continue;
    }
    if ((char === '$' && raw[index + 1] === '(') || char === '`') {
      const start = index + (char === '$' ? 2 : 1);
      let depth = 1;
      let innerQuote: "'" | '"' | null = null;
      let end = start;
      for (; end < raw.length; end++) {
        const inner = raw[end]!;
        if (inner === '\\') {
          end++;
          continue;
        }
        if (char === '`') {
          if (inner === '`') break;
          continue;
        }
        if (inner === "'" && innerQuote !== '"') innerQuote = innerQuote === "'" ? null : "'";
        else if (inner === '"' && innerQuote !== "'") innerQuote = innerQuote === '"' ? null : '"';
        else if (innerQuote === null && inner === '(') depth++;
        else if (innerQuote === null && inner === ')' && --depth === 0) break;
      }
      if (end >= raw.length) throw new Error('unterminated command substitution');
      const body = raw.slice(start, end);
      // Arithmetic is data, but substitutions inside it still execute.
      if (char === '$' && body.startsWith('(')) {
        for (const token of tokenRecords(body, depth + 1)) {
          if (token.kind === 'word') substitutions.push(...(token.word.substitutions ?? []));
        }
      } else substitutions.push(body);
      word += '__caws_dynamic_expansion__';
      dynamic = true;
      index = end;
      continue;
    }
    if (quote === null && char === '#' && !word) {
      while (index < raw.length && raw[index] !== '\n') index++;
      if (index < raw.length) {
        flush();
        tokens.push({ kind: 'op', value: ';' });
      }
      continue;
    }
    if (quote === null && /[ \t\r]/.test(char)) {
      flush();
      continue;
    }
    if (quote === null && /[;&|()\n]/.test(char)) {
      flush();
      const pair = raw.slice(index, index + 2);
      tokens.push({
        kind: 'op',
        value: ['&&', '||', ';;'].includes(pair) ? pair : char === '\n' ? ';' : char,
      });
      if (['&&', '||', ';;'].includes(pair)) index++;
      continue;
    }
    if (quote === null && /[<>]/.test(char)) {
      if (/^\d+$/.test(word)) word = '';
      else flush();
      let operator = char;
      while (index + 1 < raw.length && /[<>&|]/.test(raw[index + 1]!)) operator += raw[++index];
      if (operator === '<<' && raw[index + 1] === '-') {
        operator += '-';
        index++;
      }
      tokens.push({ kind: 'redirect', value: operator });
      continue;
    }
    if (
      char === '$' ||
      (quote === null && /[*?\[]/.test(char)) ||
      (quote === null && char === '~' && !word) ||
      (quote === null && char === '{' && /^\{[^{}]*[,\.][^{}]*\}/.test(raw.slice(index)))
    )
      dynamic = true;
    word += char;
  }
  if (quote !== null) throw new Error('shared command lexer failed');
  flush();
  return tokens;
}

interface Command {
  executable: string;
  args: Word[];
  routingKnown: boolean;
  nested?: ParsedCommands;
}
interface ParsedCommands {
  commands: Command[];
  uncertainCwd: boolean;
}
function commands(raw: string, depth = 0): ParsedCommands {
  if (depth > 32) throw new Error('command substitution budget exceeded');
  const parsed = tokenRecords(raw);
  const groups: { words: Word[]; substitutions: string[] }[] = [];
  let group: Word[] = [];
  let substitutions: string[] = [];
  let redirect = false;
  const finish = (): void => {
    if (group.length || substitutions.length) groups.push({ words: group, substitutions });
    group = [];
    substitutions = [];
    redirect = false;
  };
  for (const token of parsed) {
    if (token.kind === 'op') finish();
    else if (token.kind === 'redirect') redirect = true;
    else if (token.kind === 'word') {
      substitutions.push(...(token.word.substitutions ?? []));
      if (redirect) redirect = false;
      else group.push(token.word);
    }
  }
  finish();
  const uncertainCwd =
    groups.some(({ words }) => words.some(({ value }) => value === 'cd')) &&
    (parsed.some((token) => token.kind === 'op' && token.value !== ';' && token.value !== '&&') ||
      groups.some(({ words }) =>
        words.some(({ value }) => ['if', 'while', 'for', 'until', 'case'].includes(value))
      ));
  const result: Command[] = [];
  for (const { words, substitutions: bodies } of groups) {
    for (const body of bodies)
      result.push({
        executable: '',
        args: [],
        routingKnown: true,
        nested: commands(body, depth + 1),
      });
    let index = 0;
    let routingKnown = true;
    while (index < words.length) {
      const value = words[index]!.value;
      if (['if', 'then', 'elif', 'else', 'do', '!', '{'].includes(value)) {
        index++;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(value)) {
        if (value.startsWith('GIT_')) routingKnown = false;
        index++;
        continue;
      }
      const name = basename(value);
      if (!['env', 'command', 'builtin', 'exec'].includes(name)) break;
      index++;
      while (index < words.length && words[index]!.value.startsWith('-')) {
        const option = words[index++]!;
        if (option.value === '--') break;
        if (name === 'env' && ['-u', '--unset'].includes(option.value)) {
          index++;
          continue;
        }
        if (name === 'command' && ['-v', '-V'].includes(option.value)) {
          index = words.length;
          break;
        }
        // Wrappers that relocate cwd, alter argv or inject unknown environment cannot prove coordinates.
        if (name === 'env' && ['-C', '--chdir', '-S', '--split-string'].includes(option.value)) {
          routingKnown = false;
          index++;
        } else if (name === 'env' && /^(?:-C.|--chdir=|--split-string=)/.test(option.value))
          routingKnown = false;
        else if (
          !(
            name === 'env' && ['-i', '--ignore-environment', '-0', '--null'].includes(option.value)
          ) &&
          !(name === 'command' && ['-p', '-v', '-V'].includes(option.value))
        )
          routingKnown = false;
      }
    }
    if (index < words.length && !words[index]!.dynamic)
      result.push({
        executable: basename(words[index]!.value),
        args: words.slice(index + 1),
        routingKnown,
      });
    else if (!routingKnown)
      result.push({ executable: '__caws_git_context_unknown', args: [], routingKnown: false });
  }
  return { commands: result, uncertainCwd };
}

const RG_VALUED = new Set([
  '-e',
  '--regexp',
  '-f',
  '--file',
  '-g',
  '--glob',
  '--iglob',
  '-t',
  '--type',
  '-T',
  '--type-not',
  '-A',
  '--after-context',
  '-B',
  '--before-context',
  '-C',
  '--context',
  '--color',
  '--colors',
  '--encoding',
  '--sort',
  '--sortr',
  '--max-count',
  '--max-depth',
  '--max-filesize',
  '--pre',
]);
function rgReplaces(args: Word[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!.value;
    if (value === '--') return false;
    if (value === '-r' || value === '--replace' || value.startsWith('--replace=')) return true;
    if (RG_VALUED.has(value)) {
      index++;
      continue;
    }
    if (value.startsWith('-') && !value.startsWith('--')) {
      for (const char of value.slice(1)) {
        if (char === 'r') return true;
        if (RG_VALUED.has(`-${char}`)) break;
      }
    }
  }
  return false;
}
function at(cwd: string, path: string, ports: GuardUtilityPorts): string {
  return ports.realpath(isAbsolute(path) ? path : `${cwd}/${path}`);
}
function ignoredStaging(
  args: Word[],
  initialCwd: string,
  ports: GuardUtilityPorts
): { ignored: string[]; uncertain?: string } {
  if (!args.some(({ value }) => value === 'add')) return { ignored: [] };
  let cwd = initialCwd;
  let literal = false;
  let index = 0;
  while (index < args.length && args[index]!.value.startsWith('-')) {
    const option = args[index]!;
    if (option.value === '-C' && args[index + 1] && !args[index + 1]!.dynamic) {
      cwd = at(cwd, args[index + 1]!.value, ports);
      index += 2;
    } else if (['--no-pager', '--literal-pathspecs'].includes(option.value)) {
      literal ||= option.value === '--literal-pathspecs';
      index++;
    } else return { ignored: [], uncertain: 'Git global options outside this utility envelope' };
  }
  if (args[index]?.value !== 'add') return { ignored: [] };
  let force = false,
    dryRun = false,
    update = false,
    nul = false,
    options = true;
  let pathfile: string | undefined;
  const paths: string[] = [];
  const known = new Set([
    '--force',
    '--dry-run',
    '--update',
    '--all',
    '--ignore-removal',
    '--intent-to-add',
    '--refresh',
    '--renormalize',
    '--ignore-errors',
    '--ignore-missing',
    '--sparse',
    '--verbose',
    '--chmod=+x',
    '--chmod=-x',
  ]);
  for (index++; index < args.length; index++) {
    const arg = args[index]!;
    const value = arg.value;
    if (arg.dynamic) return { ignored: [], uncertain: 'dynamic forced-staging path is unresolved' };
    if (options && value === '--') options = false;
    else if (options && value === '--pathspec-from-file') {
      const next = args[++index];
      if (!next) return { ignored: [], uncertain: 'missing pathspec file' };
      if (next.dynamic) return { ignored: [], uncertain: 'dynamic pathspec file is unresolved' };
      pathfile = next.value;
    } else if (options && value.startsWith('--pathspec-from-file='))
      pathfile = value.slice('--pathspec-from-file='.length);
    else if (options && value === '--pathspec-file-nul') nul = true;
    else if (options && value.startsWith('-')) {
      force ||= value === '--force' || (!value.startsWith('--') && value.slice(1).includes('f'));
      dryRun ||= value === '--dry-run' || (!value.startsWith('--') && value.slice(1).includes('n'));
      update ||= value === '--update' || (!value.startsWith('--') && value.slice(1).includes('u'));
      if (
        value.startsWith('--')
          ? !known.has(value)
          : [...value.slice(1)].some((char) => !'fnuANv'.includes(char))
      ) {
        return {
          ignored: [],
          uncertain: value.startsWith('--')
            ? 'Git add option outside this utility envelope'
            : 'Git add short option outside this utility envelope',
        };
      }
    } else paths.push(value);
  }
  if (!force || dryRun) return { ignored: [] };
  if (pathfile) {
    if (pathfile === '-')
      return { ignored: [], uncertain: 'stdin pathspecs are unavailable before execution' };
    // Do not realpath the final component: readPathspec must reject a symlink rather than follow it.
    const bytes = ports.readPathspec(isAbsolute(pathfile) ? pathfile : `${cwd}/${pathfile}`);
    if (bytes.length > PATHSPEC_LIMIT)
      return { ignored: [], uncertain: 'pathspec file exceeds utility budget' };
    if (!nul && (bytes.includes(34) || bytes.includes(92)))
      return { ignored: [], uncertain: 'quoted pathspec file requires Git C-string decoding' };
    paths.push(
      ...decode(bytes)
        .split(nul ? '\0' : '\n')
        .filter(Boolean)
    );
  }
  const ignored = new Set<string>();
  for (const mode of update ? ['--cached'] : ['--cached', '--others']) {
    const probe = ports.git(
      [
        ...(literal ? ['--literal-pathspecs'] : []),
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        '-C',
        cwd,
        'ls-files',
        mode,
        '--ignored',
        '--exclude-standard',
        '-z',
        '--',
        ...(paths.length ? paths : ['.']),
      ],
      cwd
    );
    if (probe.status !== 0)
      return { ignored: [...ignored].sort(), uncertain: 'read-only Git ignored-path query failed' };
    try {
      for (const path of decode(probe.stdout).split('\0').filter(Boolean)) ignored.add(path);
    } catch (error) {
      return { ignored: [...ignored].sort(), uncertain: message(error) };
    }
  }
  return { ignored: [...ignored].sort() };
}

export function evaluateGuardUtilities(
  policy: GuardUtilityPolicy,
  input: GuardUtilityInput,
  ports: GuardUtilityPorts
): GuardUtilityEvaluation {
  const notices: string[] = [];
  const violations: string[] = [];
  if (input.tool === 'Bash') {
    const parsed = commands(
      typeof input.toolInput.command === 'string' ? input.toolInput.command : ''
    );
    const evaluateCommands = (
      frame: ParsedCommands,
      initialCwd: string | null,
      initialGitKnown: boolean
    ): void => {
      let cwd: string | null = frame.uncertainCwd ? null : initialCwd;
      let gitKnown = initialGitKnown;
      for (const command of frame.commands) {
        if (command.nested) {
          evaluateCommands(command.nested, cwd, gitKnown);
          continue;
        }
        const { executable, args } = command;
        if (executable === '__caws_git_context_unknown') gitKnown = false;
        if (executable === 'cd') {
          cwd =
            cwd !== null && command.routingKnown && args.length === 1 && !args[0]!.dynamic
              ? at(cwd, args[0]!.value, ports)
              : null;
          continue;
        }
        if (['pushd', 'popd', 'eval', 'source', '.'].includes(executable)) cwd = null;
        if (
          ['export', 'unset'].includes(executable) &&
          args.some(({ value }) => value.startsWith('GIT_'))
        )
          gitKnown = false;
        if (executable === 'rg' && policy.rg_replace && rgReplaces(args))
          notices.push(
            'Ripgrep replacement is active: displayed matches are transformed. -r means --replace, not recursive.'
          );
        if (executable === 'git' && policy.ignored_staging) {
          if (cwd === null || !command.routingKnown || !gitKnown)
            notices.push('Ignored-staging check unresolved: shell cwd is dynamic.');
          else {
            try {
              const result = ignoredStaging(args, cwd, ports);
              if (result.ignored.length)
                violations.push(`Consumer ignored-staging policy: ${result.ignored.join(', ')}`);
              if (result.uncertain)
                notices.push(`Ignored-staging check unresolved: ${result.uncertain}.`);
            } catch (error) {
              notices.push(`Ignored-staging check unresolved: ${message(error)}.`);
            }
          }
        }
        const tests = policy.focused_tests;
        if (
          tests?.executables?.includes(executable) ||
          (executable.startsWith('python') &&
            args[0]?.value === '-m' &&
            args[1]?.value === 'pytest' &&
            tests?.executables?.includes('pytest'))
        ) {
          notices.push(
            `Consumer focused-test entry point: ${tests!.entry_point}. This notice does not grant resource admission.`
          );
        }
      }
    };
    evaluateCommands(parsed, ports.realpath(input.cwd), ports.gitContextKnown);
  }
  const documents = policy.documents;
  if (input.tool === 'Write' && documents && typeof input.toolInput.file_path === 'string') {
    let path = input.toolInput.file_path;
    if (isAbsolute(path)) {
      path = relative(input.cwd, path);
      if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path))
        return { notices, violations };
    }
    if (documents.roots?.some((root) => path.startsWith(root))) {
      const content = input.toolInput.content;
      const header =
        typeof content === 'string' && content.startsWith('---\n') && content.indexOf('---', 3) >= 0
          ? content.split('---', 3)[1]!
          : '';
      const missing = (documents.required_frontmatter ?? []).filter(
        (key) =>
          !new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'm').test(header)
      );
      if (missing.length)
        notices.push(`Consumer document metadata missing: ${missing.join(', ')}.`);
    }
  }
  return { notices, violations };
}

/** Absent optional configuration is silent. Analysis failures never manufacture a violation. */
export function runGuardUtilities(
  policyText: string | null,
  input: GuardUtilityInput,
  ports: GuardUtilityPorts
): NativeResult {
  if (policyText === null)
    return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
  let result: GuardUtilityEvaluation;
  try {
    result = evaluateGuardUtilities(parseGuardUtilityPolicy(policyText), input, ports);
  } catch (error) {
    result = {
      notices: [`Optional utility analysis incomplete: ${message(error)}`],
      violations: [],
    };
  }
  const output = result.violations.length
    ? { decision: 'block', reason: result.violations.join('\n') }
    : result.notices.length
      ? {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: [...new Set(result.notices)].join('\n'),
          },
        }
      : undefined;
  return {
    exitCode: result.violations.length ? 2 : 0,
    stdout: output === undefined ? new Uint8Array() : Buffer.from(`${JSON.stringify(output)}\n`),
    stderr: new Uint8Array(),
  };
}
