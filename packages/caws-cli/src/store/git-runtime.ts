import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ExecutionGitRuntime {
  readonly shimDirectories: readonly { readonly cwd: string; readonly shimDirectory: string }[];
  readonly bridgeFd: 4;
}
export interface ExecutionGitOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdio: ['ignore', 'pipe', 'pipe'] | ['ignore', 'pipe', 'pipe', 'ignore', 4];
}
let active: ExecutionGitRuntime | undefined;

function insist(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Trusted Git runtime unavailable: ${reason}`);
}
function noIndexedConfiguration(): void {
  insist(process.env.GIT_CONFIG_PARAMETERS === undefined, 'GIT_CONFIG_PARAMETERS is unsupported');
  // Nonempty inherited command configuration requires an independent checked
  // contract. This runtime supports only the empty input configuration.
  insist(
    process.env.GIT_CONFIG_COUNT === undefined || process.env.GIT_CONFIG_COUNT === '0',
    'inherited indexed Git configuration is unsupported'
  );
  insist(
    !Object.keys(process.env).some((name) => /^GIT_CONFIG_(?:KEY|VALUE)_/.test(name)),
    'unexpected indexed Git configuration'
  );
}
function physicalDirectory(value: string): string {
  insist(
    typeof value === 'string' && path.isAbsolute(value) && !/[\0-\x1f\x7f]/.test(value),
    'invalid directory'
  );
  const actual = fs.realpathSync.native(value);
  insist(
    actual === value && fs.lstatSync(actual).isDirectory(),
    'directory alias or non-directory'
  );
  return actual;
}
/** Install only around the synchronous trusted lifecycle effect. No process
 * environment or persistent Git configuration is changed; a thrown callback
 * restores the enclosing runtime just as a normal return does.
 */
export function withExecutionGitRuntime<T>(runtime: ExecutionGitRuntime, effect: () => T): T {
  insist(
    runtime !== null &&
      typeof runtime === 'object' &&
      Object.keys(runtime).length === 2 &&
      Object.hasOwn(runtime, 'shimDirectories') &&
      Object.hasOwn(runtime, 'bridgeFd') &&
      runtime.bridgeFd === 4,
    'invalid capability configuration'
  );
  insist(
    Array.isArray(runtime.shimDirectories) &&
      runtime.shimDirectories.length > 0 &&
      runtime.shimDirectories.length <= 32,
    'invalid root set'
  );
  const roots = new Set<string>();
  const shims = new Set<string>();
  const directories = runtime.shimDirectories
    .map((row) => {
      insist(
        row !== null &&
          typeof row === 'object' &&
          Object.keys(row).length === 2 &&
          Object.hasOwn(row, 'cwd') &&
          Object.hasOwn(row, 'shimDirectory'),
        'invalid root configuration'
      );
      const cwd = physicalDirectory(row.cwd);
      const shimDirectory = physicalDirectory(row.shimDirectory);
      insist(
        !roots.has(cwd) && !shims.has(shimDirectory),
        'duplicate root or shared shim directory'
      );
      roots.add(cwd);
      shims.add(shimDirectory);
      return Object.freeze({ cwd, shimDirectory });
    })
    .sort((a, b) => b.cwd.length - a.cwd.length);
  insist(
    typeof effect === 'function' &&
      Object.prototype.toString.call(effect) !== '[object AsyncFunction]',
    'effect must be synchronous'
  );
  noIndexedConfiguration();
  const previous = active;
  active = Object.freeze({ shimDirectories: Object.freeze(directories), bridgeFd: 4 });
  try {
    const result = effect();
    insist(
      result === null ||
        (typeof result !== 'object' && typeof result !== 'function') ||
        typeof (result as { then?: unknown }).then !== 'function',
      'effect returned a pending result'
    );
    return result;
  } finally {
    active = previous;
  }
}

/** Only a configured physical worktree gets its Native-created shim and fd4.
 * Unconfigured callers keep the historical inherited environment and stdio.
 */
export function executionGitOptions(cwd: string): ExecutionGitOptions {
  if (active === undefined) return { stdio: ['ignore', 'pipe', 'pipe'] };
  let physical: string;
  try {
    physical = fs.realpathSync.native(cwd);
  } catch {
    return { stdio: ['ignore', 'pipe', 'pipe'] };
  }
  const root = active.shimDirectories.find(
    (row) => physical === row.cwd || physical.startsWith(row.cwd + path.sep)
  );
  if (root === undefined) return { stdio: ['ignore', 'pipe', 'pipe'] };
  noIndexedConfiguration();
  return {
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: root.shimDirectory,
      GIT_CONFIG_KEY_1: 'maintenance.auto',
      GIT_CONFIG_VALUE_1: 'false',
      GIT_CONFIG_KEY_2: 'gc.auto',
      GIT_CONFIG_VALUE_2: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ignore', 4],
  };
}
