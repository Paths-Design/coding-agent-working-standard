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
  hook: Record<string, unknown>
): boolean {
  return (
    Object.keys(group).every((key) => ['hooks', 'matcher', 'enabled'].includes(key)) &&
    Object.keys(hook).every((key) =>
      ['type', 'command', 'enabled', 'timeout', 'statusMessage', 'name'].includes(key)
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
  return typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= floor;
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
