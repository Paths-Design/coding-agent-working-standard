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

export function machineCommand(home: string, surface: string, event: string): string {
  return `CAWS_HOME=${quote(home)} python3 ${quote(path.join(home, 'bin/caws-hook'))} ${surface} ${event}`;
}

export function systemCommand(home: string, surface: string, event: string): string {
  return machineCommand(home, surface, event) + ' --system';
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
    /(?:\/(?:bin\/caws-hook)(?:['"\s;|&<>]|$)|\.caws\/hooks\/[^'"\s;|&<>]+\.sh(?:['"\s;|&<>]|$)|\.(?:codex|claude|qwen)\/hooks\/(?:(?:dispatch|caws_dispatch)\/(?:pre_tool_use|post_tool_use|session_start|stop|pre_compact)\.sh|(?:caws-qwen-hook|session-log)\.sh)(?:['"\s;|&<>]|$))/.test(
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
} as const;
