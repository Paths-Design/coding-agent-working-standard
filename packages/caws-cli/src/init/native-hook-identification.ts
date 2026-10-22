import * as path from 'node:path';

export interface NativeHook {
  command?: string;
  enabled?: boolean;
  [key: string]: unknown;
}
export interface NativeHookGroup {
  hooks: NativeHook[];
  matcher?: string;
  enabled?: boolean;
  [key: string]: unknown;
}
export interface NativeConfiguration {
  hooks?: Record<string, NativeHookGroup[]>;
  [key: string]: unknown;
}
const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

interface NativeCommandWord {
  readonly raw: string;
  readonly value: string;
}

/** Tokenize without expanding or executing shell. Lazy consumption lets an
 * ownership probe stop at a foreign executable rather than inspect its data. */
function* nativeCommandTokens(
  command: string,
  literalData = false,
  literalDataLines = false
): Generator<NativeCommandWord> {
  let index = 0;
  while (index < command.length) {
    if (/[ \t]/.test(command[index] as string)) {
      index++;
      continue;
    }
    const start = index;
    let value = '';
    let quoted: string | null = null;
    while (index < command.length) {
      const char = command[index] as string;
      if (!quoted && /[ \t]/.test(char)) break;
      if (/[\r\n]/.test(char) && !(literalDataLines && quoted)) {
        if (!quoted && index > start) yield { raw: command.slice(start, index), value };
        throw new Error('multiline command');
      }
      if (quoted === "'") {
        if (char === "'") quoted = null;
        else value += char;
      } else if (char === '\\') {
        const next = command[++index];
        if (literalDataLines && next === '\n') {
          index++;
          continue;
        }
        if (!next || /[\r\n]/.test(next)) throw new Error('unsupported shell escape');
        // A literal shell payload must receive the value its outer double
        // quotes produce. Retaining this backslash would hide an inner
        // substitution; the strict migration grammar keeps rejecting it.
        const quotedEscape = /["\\$]/.test(next) || (literalData && next === '`');
        if (quoted && !quotedEscape) {
          if (!literalData) throw new Error('unsupported shell escape');
          value += '\\' + next;
        } else value += next;
      } else if (char === '`' || (char === '$' && command[index + 1] === '(')) {
        throw new Error('command substitution');
      } else if (char === '"' || (!quoted && char === "'")) {
        quoted = quoted ? null : char;
      } else {
        if (!quoted && /[;&|<>()#]/.test(char)) {
          if (index > start) yield { raw: command.slice(start, index), value };
          throw new Error('compound command');
        }
        value += char;
      }
      index++;
    }
    if (quoted) throw new Error('unclosed shell quote');
    yield { raw: command.slice(start, index), value };
  }
}

/** Full-command migration retains the original rejection of compounds,
 * substitutions and unsupported quoting; no token is executed. */
export function nativeCommandWords(command: string): NativeCommandWord[] {
  return [...nativeCommandTokens(command)];
}

/** Discovery can cross literal command boundaries without admitting their
 * execution or migration. Quotes and escapes belong to words; operators and
 * comments do not. Opaque substitutions and incomplete words stop this bounded
 * inspection rather than supplying an executable identity. */
function* nativeDiscoveryWords(command: string): Generator<NativeCommandWord> {
  let index = 0;
  while (index < command.length) {
    if (/[ \t\r\n;&|<>()]/.test(command[index] as string)) {
      index++;
      continue;
    }
    if (command[index] === '#') {
      while (index < command.length && !/[\r\n]/.test(command[index] as string)) index++;
      continue;
    }
    const start = index;
    let value = '';
    let quoted: string | null = null;
    while (index < command.length) {
      const char = command[index] as string;
      if (!quoted && /[ \t\r\n;&|<>()]/.test(char)) break;
      if (quoted === "'") {
        if (char === "'") quoted = null;
        else value += char;
      } else if (char === '\\') {
        const next = command[++index];
        if (!next) return;
        if (next !== '\n') value += quoted && !/["\\$`]/.test(next) ? '\\' + next : next;
      } else if (char === '`' || (char === '$' && command[index + 1] === '(')) {
        return;
      } else if (char === '"' || (!quoted && char === "'")) {
        quoted = quoted ? null : char;
      } else value += char;
      index++;
    }
    if (quoted) return;
    yield { raw: command.slice(start, index), value };
  }
}

function hasLiteralCawsDiscoveryWord(command: string, inspectWrapper = true): boolean {
  const words = [...nativeDiscoveryWords(command)];
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (
      literalShellWord(word) &&
      ['caws-hook-native', 'caws-hook'].includes(path.posix.basename(word.value))
    )
      return true;
    // Inspect one literal payload in the shell form already understood by the
    // ownership classifier. Finding a name here only requests reconciliation.
    const payload = words[index + 2];
    if (
      inspectWrapper &&
      ['bash', '/bin/bash', 'sh', '/bin/sh'].includes(word.value) &&
      words[index + 1]?.value === '-c' &&
      payload &&
      literalShellWord(word) &&
      literalShellWord(words[index + 1]!) &&
      literalShellWord(payload) &&
      hasLiteralCawsDiscoveryWord(payload.value, false)
    )
      return true;
  }
  return false;
}

export type CawsProducerOwnership =
  | { readonly kind: 'owned'; readonly entry: 'native' | 'legacy' }
  | { readonly kind: 'foreign' }
  | { readonly kind: 'unresolved' };
export type ClaudeDispatcherCommand = 'managed' | 'foreign' | 'reconciliation';

function dispatcherOperand(word: NativeCommandWord, surface: string, event: string): boolean {
  const vendor =
    surface === 'claude-code' ? '.claude' : surface === 'qwen-code' ? '.qwen' : '.codex';
  const tails = [
    `/.caws/hooks/dispatch/${event}.sh`,
    `/${vendor}/hooks/caws_dispatch/${event}.sh`,
    `/${vendor}/hooks/dispatch/${event}.sh`,
  ];
  const literal =
    (path.posix.isAbsolute(word.value) ||
      word.value.startsWith('./') ||
      word.value.startsWith('.caws/') ||
      word.value.startsWith(vendor + '/')) &&
    !word.raw.includes('$') &&
    tails.some((tail) => word.value.endsWith(tail) || word.value === tail.slice(1));
  // A single-quoted or escaped dollar is literal pathname data. Admit only
  // the supported root-variable spellings in executable position.
  const names =
    surface === 'claude-code' ? ['CLAUDE_PROJECT_DIR'] : ['REPO_ROOT', 'CODEX_PROJECT_DIR'];
  const projectVariable = names
    .flatMap((name) => ['$' + name, '${' + name + '}'])
    .some(
      (root) =>
        tails.some((tail) => word.value === root + tail) &&
        [root + '/', '"' + root + '"/', '"' + root + '/'].some((prefix) =>
          word.raw.startsWith(prefix)
        )
    );
  return literal || projectVariable;
}

function literalShellWord(word: NativeCommandWord): boolean {
  let quoted: string | null = null;
  for (let index = 0; index < word.raw.length; index++) {
    const char = word.raw[index];
    if (quoted === "'") {
      if (char === "'") quoted = null;
    } else if (char === '\\') index++;
    else if (char === '$' || char === '`' || (!quoted && /[*?\[\]{}~]/.test(char as string)))
      return false;
    else if (char === '"' || (!quoted && char === "'")) quoted = quoted ? null : char;
  }
  return quoted === null;
}

/** Multiline literal data can be foreign without becoming an admitted producer.
 * This complete parse alone permits quoted newlines and line continuations;
 * operators, substitutions and extra shell operands remain unresolved. */
function isLiteralForeignDataCommand(command: string, inspectWrapper: boolean): boolean {
  try {
    const words = [...nativeCommandTokens(command, true, true)];
    let index = 0;
    while (words[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!.raw)) index++;
    if (words[index]?.value === 'env') {
      index++;
      while (words[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!.raw)) index++;
    }
    const program = words[index++];
    if (!program || !words.every(literalShellWord)) return false;
    if (['printf', '/usr/bin/printf', 'echo', '/bin/echo', '/usr/bin/echo'].includes(program.value))
      return true;
    const payload = words[index + 1];
    return (
      inspectWrapper &&
      ['bash', '/bin/bash', 'sh', '/bin/sh'].includes(program.value) &&
      words[index]?.value === '-c' &&
      words.length === index + 2 &&
      payload !== undefined &&
      isLiteralForeignDataCommand(payload.value, false)
    );
  } catch {
    return false;
  }
}

/** Shared producer ownership, not shell execution admission. Only a complete
 * literal printf/echo command is definitely foreign pathname data. Arbitrary
 * wrappers, dynamic shell and unknown executables remain unresolved; broad
 * CAWS discovery must keep those behind reconciliation. */
export function classifyCawsProducerCommand(
  command: unknown,
  surface: string,
  event: string,
  inspectWrapper = true
): CawsProducerOwnership {
  if (typeof command !== 'string') return { kind: 'unresolved' };
  const prelude = 'REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"; ';
  const hasPrelude = command.startsWith(prelude);
  try {
    const words = [...nativeCommandTokens(command.slice(hasPrelude ? prelude.length : 0), true)];
    let index = 0;
    while (words[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!.raw)) index++;
    if (words[index]?.value === 'env') {
      index++;
      while (words[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!.raw)) index++;
    }
    let program = words[index++];
    if (!program) return { kind: 'unresolved' };
    if (['printf', '/usr/bin/printf', 'echo', '/bin/echo', '/usr/bin/echo'].includes(program.value))
      return { kind: !hasPrelude && words.every(literalShellWord) ? 'foreign' : 'unresolved' };
    const shell = ['bash', '/bin/bash', 'sh', '/bin/sh'].includes(program.value);
    if (shell) {
      if (words[index]?.value === '-c') {
        const inner = words[index + 1];
        if (!inspectWrapper || !inner || words.length !== index + 2 || !literalShellWord(inner))
          return { kind: 'unresolved' };
        return {
          kind:
            classifyCawsProducerCommand(inner.value, surface, event, false).kind === 'foreign' &&
            !hasPrelude &&
            words.slice(0, index).every(literalShellWord)
              ? 'foreign'
              : 'unresolved',
        };
      }
      program = words[index++];
      if (!program) return { kind: 'unresolved' };
    }
    const args = words.slice(index);
    if (shell)
      return dispatcherOperand(program, surface, event) && args.length === 0
        ? { kind: 'owned', entry: 'legacy' }
        : { kind: 'unresolved' };
    const invocation = (values: readonly NativeCommandWord[]): boolean => {
      const argv = [...values];
      if (argv.at(-1)?.value === '--system') argv.pop();
      return (
        argv.length === 2 &&
        argv[0]?.value === surface &&
        argv[1]?.value === event &&
        argv.every(literalShellWord)
      );
    };
    if (
      literalShellWord(program) &&
      path.posix.isAbsolute(program.value) &&
      program.value.endsWith('/bin/caws-hook-native')
    )
      return invocation(args) ? { kind: 'owned', entry: 'native' } : { kind: 'unresolved' };
    if (['python3', '/usr/bin/python3'].includes(program.value)) {
      const entry = args[0];
      return entry &&
        literalShellWord(entry) &&
        path.posix.isAbsolute(entry.value) &&
        entry.value.endsWith('/bin/caws-hook') &&
        invocation(args.slice(1))
        ? { kind: 'owned', entry: 'legacy' }
        : { kind: 'unresolved' };
    }
    return dispatcherOperand(program, surface, event) && args.length === 0
      ? { kind: 'owned', entry: 'legacy' }
      : { kind: 'unresolved' };
  } catch {
    return {
      kind:
        !hasPrelude && isLiteralForeignDataCommand(command, inspectWrapper)
          ? 'foreign'
          : 'unresolved',
    };
  }
}

/** A hook may carry a possible CAWS executable in either command or argv.
 * This is discovery only; argument elements are never joined or evaluated. */
export function isCawsProducerHookCandidate(hook: unknown): hook is NativeHook {
  if (!hook || typeof hook !== 'object') return false;
  const value = hook as NativeHook;
  // Known executable names are possible PATH invocations, not ownership
  // witnesses. Discovery neither resolves PATH nor admits their migration;
  // the existing classifier keeps non-data invocations unresolved.
  const possibleProducer = (text: unknown): boolean =>
    isCawsNativeCommand(text) ||
    (typeof text === 'string' &&
      /(?:^|[\s/"'`;&|<>()])caws-hook(?:-native)?(?=$|[\s"'`;&|<>()])/.test(text));
  if (
    possibleProducer(value.command) ||
    (Array.isArray(value.args) ? value.args.some(possibleProducer) : possibleProducer(value.args))
  )
    return true;
  // Only shell-form commands have decoded shell words. Literal command
  // boundaries must not hide a later known basename from reconciliation.
  // Discovery never establishes ownership, a full parse or PATH resolution.
  if (Object.hasOwn(value, 'args') || typeof value.command !== 'string') return false;
  return hasLiteralCawsDiscoveryWord(value.command);
}

/** Exec-form CAWS registration is not an admitted migration format. Only
 * Claude's known data-only executables with string argv are exempt: argv is
 * literal here, including shell punctuation. Other surfaces do not gain args
 * support from this discovery check. */
export function classifyCawsProducerHook(
  hook: NativeHook,
  surface: string,
  event: string
): CawsProducerOwnership {
  if (!Object.hasOwn(hook, 'args'))
    return classifyCawsProducerCommand(hook.command, surface, event);
  return surface === 'claude-code' &&
    hook.type === 'command' &&
    ['printf', '/usr/bin/printf', 'echo', '/bin/echo', '/usr/bin/echo'].includes(
      hook.command ?? ''
    ) &&
    Array.isArray(hook.args) &&
    hook.args.every((argument) => typeof argument === 'string')
    ? { kind: 'foreign' }
    : { kind: 'unresolved' };
}

/** Canonical Claude wiring uses the same whole-hook discovery and ownership
 * result as the machine producers. Unresolved flagged hooks are refused. */
export function classifyClaudeDispatcherHook(
  hook: unknown,
  event: string
): ClaudeDispatcherCommand {
  if (!isCawsProducerHookCandidate(hook)) return 'foreign';
  const ownership = classifyCawsProducerHook(hook, 'claude-code', event);
  return ownership.kind === 'owned'
    ? 'managed'
    : ownership.kind === 'foreign'
      ? 'foreign'
      : 'reconciliation';
}

/** Discovery for producer JSON layers exempts only established literal data. */
export function configHasCawsProducerHooks(config: unknown, surface: string): boolean {
  if (!config || typeof config !== 'object') return false;
  const hooks = (config as NativeConfiguration).hooks;
  if (!hooks || typeof hooks !== 'object') return false;
  return Object.entries(hooks).some(
    ([name, groups]) =>
      Array.isArray(groups) &&
      groups.some(
        (group) =>
          Array.isArray(group?.hooks) &&
          group.hooks.some(
            (hook) =>
              isCawsProducerHookCandidate(hook) &&
              classifyCawsProducerHook(
                hook,
                surface,
                Object.entries(MACHINE_EVENTS).find(([, native]) => native === name)?.[0] ?? ''
              ).kind !== 'foreign'
          )
      )
  );
}

/** Qualified universal matchers for the supported JSON harness adapters. */
export function universalEventMatcher(surface: string, event: string, matcher: unknown): boolean {
  if (matcher === '.*') return true;
  if (!['pre_tool_use', 'post_tool_use'].includes(event) && matcher === undefined) return true;
  return (
    (surface === 'claude-code' || surface === 'qwen-code') &&
    (matcher === undefined || matcher === '' || matcher === '*')
  );
}

/** A command's presence cannot establish coverage when a harness can skip or
 * detach it. Unknown execution fields require explicit harness reconciliation.
 */
export function unconditionalCommandHook(
  group: Record<string, unknown>,
  hook: Record<string, unknown>,
  surface?: string,
  event?: string
): boolean {
  return (
    Object.keys(group).every((key) => ['hooks', 'matcher', 'enabled'].includes(key)) &&
    Object.keys(hook).every(
      (key) =>
        ['type', 'command', 'enabled', 'timeout', 'statusMessage', 'name'].includes(key) ||
        (key === 'onFailure' &&
          surface === 'claude-code' &&
          event === 'pre_tool_use' &&
          hook.onFailure === 'block')
    ) &&
    hook.type === 'command' &&
    (hook.timeout === undefined ||
      (typeof hook.timeout === 'number' && Number.isFinite(hook.timeout) && hook.timeout > 0))
  );
}

/** Qwen's supported budgets are milliseconds. Smaller custom budgets require
 * reconciliation; these floors do not attest that a callback finishes in time.
 */
export function qualifiedHookTimeout(surface: string, event: string, timeout: unknown): boolean {
  if (surface !== 'qwen-code') return true;
  const floor =
    event === 'pre_tool_use'
      ? 45000
      : event === 'post_tool_use'
        ? 60000
        : event === 'session_end'
          ? 10000
          : 30000;
  // Qwen passes this directly to Node setTimeout; an overflowing delay becomes
  // 1ms rather than a long timeout. Admit only exact supported integer budgets.
  return (
    typeof timeout === 'number' &&
    Number.isInteger(timeout) &&
    timeout >= floor &&
    timeout <= 2147483647
  );
}

export function machineCommand(
  home: string,
  surface: string,
  event: string,
  entry: 'native' | 'legacy' = 'legacy'
): string {
  const launcher =
    entry === 'native'
      ? quote(path.join(home, 'bin/caws-hook-native'))
      : `python3 ${quote(path.join(home, 'bin/caws-hook'))}`;
  return `CAWS_HOME=${quote(home)} ${launcher} ${surface} ${event}`;
}

export function systemCommand(
  home: string,
  surface: string,
  event: string,
  entry: 'native' | 'legacy' = 'legacy'
): string {
  return machineCommand(home, surface, event, entry) + ' --system';
}

export function configHasCawsHooks(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const hooks = (config as { hooks?: Record<string, unknown> }).hooks;
  if (!hooks || typeof hooks !== 'object') return false;
  return Object.values(hooks).some(
    (groups) =>
      Array.isArray(groups) &&
      groups.some(
        (group) =>
          Array.isArray(group?.hooks) &&
          group.hooks.some((hook: { command?: unknown }) => isCawsNativeCommand(hook?.command))
      )
  );
}

/** Recognize CAWS transports, not arbitrary scripts owned by a harness user. */
export function isCawsNativeCommand(command: unknown): command is string {
  return (
    typeof command === 'string' &&
    /(?:\/(?:bin\/caws-hook(?:-native)?)(?:['"\s;|&<>]|$)|\.caws\/hooks\/[^'"\s;|&<>]+\.sh(?:['"\s;|&<>]|$)|\.(?:codex|claude|qwen)\/hooks\/(?:(?:dispatch|caws_dispatch)\/(?:pre_tool_use|post_tool_use|session_start|stop|pre_compact|session_end)\.sh|(?:caws-qwen-hook|session-log)\.sh)(?:['"\s;|&<>]|$))/.test(
      command
    )
  );
}

export const MACHINE_EVENTS = {
  pre_tool_use: 'PreToolUse',
  post_tool_use: 'PostToolUse',
  session_start: 'SessionStart',
  stop: 'Stop',
  pre_compact: 'PreCompact',
  session_end: 'SessionEnd',
} as const;
