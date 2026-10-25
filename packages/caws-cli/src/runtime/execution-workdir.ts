import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export type ExecutionWorkdir =
  | { readonly status: 'not_applicable' | 'unavailable' }
  | { readonly status: 'resolved'; readonly path: string };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Host execution context is separate from session cwd and diagnostic tool aliases.
 * An absent host field does not promote an alias or inherited environment into authority. */
export function resolveExecutionWorkdir(
  payload: Readonly<Record<string, unknown>>,
  event: string
): ExecutionWorkdir {
  if (payload.tool_name !== 'Bash' || !['pre_tool_use', 'post_tool_use'].includes(event))
    return Object.freeze({ status: 'not_applicable' });
  if (!Object.hasOwn(payload, 'execution_workdir')) return Object.freeze({ status: 'unavailable' });
  const physical = (value: unknown, field: string): string => {
    if (
      typeof value !== 'string' ||
      !value ||
      value.includes('\0') ||
      !isAbsolute(value) ||
      Buffer.from(value, 'utf8').toString('utf8') !== value
    )
      throw new TypeError(`${field} must be an absolute native directory`);
    try {
      const path = realpathSync(value);
      if (!statSync(path).isDirectory()) throw new Error('not a directory');
      return path;
    } catch {
      throw new TypeError(`${field} must name an existing directory`);
    }
  };
  const path = physical(payload.execution_workdir, 'execution_workdir');
  if (payload.execution_workdir !== path)
    throw new TypeError('execution_workdir must already be a physical directory path');
  const tool = object(payload.tool_input) ? payload.tool_input : {};
  for (const alias of ['workdir', 'cwd']) {
    if (Object.hasOwn(tool, alias) && physical(tool[alias], `tool_input.${alias}`) !== path)
      throw new TypeError(`tool_input.${alias} disagrees with execution_workdir`);
  }
  return Object.freeze({ status: 'resolved', path });
}
