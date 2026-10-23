import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve, join } from 'node:path';
import { TextDecoder } from 'node:util';
import { resolveGitBinaryForEnvironment } from '../store/git-binary';
import { repoRootFromGitCommonDir } from '../store/repo-root';
import { isFatalContextGitError } from './context-git-wire';

export interface InvocationCaller {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}
export type RuntimeProjectContext =
  | { readonly status: 'resolved'; readonly checkout: string; readonly canonical: string }
  | { readonly status: 'inactive'; readonly reason: string; readonly diagnostic: string };
export interface ContextGitPort {
  run(args: readonly string[], cwd: string): Promise<string>;
}

/** Native environment is ephemeral request data; never persist this snapshot in journals. */
export function invocationCaller(
  cwd: string,
  environment: Readonly<NodeJS.ProcessEnv>
): InvocationCaller {
  const nativeText = (value: string): boolean =>
    !value.includes('\0') && Buffer.from(value, 'utf8').toString('utf8') === value;
  if (!isAbsolute(cwd) || !nativeText(cwd))
    throw new TypeError('Caller cwd must be absolute UTF-8 native text.');
  const snapshot = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
  for (const [name, value] of Object.entries(snapshot)) {
    if (!name || name.includes('=') || !nativeText(name) || !nativeText(value)) {
      throw new TypeError('Caller environment contains an invalid native entry.');
    }
  }
  return Object.freeze({ cwd, environment: Object.freeze(snapshot) });
}

/** Inherited Git routing and old parsed hook fields never select the next invocation. */
export function invocationEnvironment(caller: InvocationCaller): Record<string, string> {
  return Object.fromEntries(
    Object.entries(caller.environment).filter(
      ([name]) => !name.startsWith('GIT_') && !name.startsWith('HOOK_')
    )
  );
}

export function createContextGitPort(
  caller: InvocationCaller,
  deadlineEpochMs: number
): ContextGitPort {
  if (!Number.isSafeInteger(deadlineEpochMs))
    throw new TypeError('Project deadline must be an integer.');
  const environment = invocationEnvironment(caller);
  const binary = resolveGitBinaryForEnvironment(environment, caller.cwd);
  return {
    run(args, cwd) {
      return new Promise((accept, reject) => {
        const remaining = Math.min(5000, deadlineEpochMs - Date.now());
        if (!binary || remaining <= 0) {
          reject(
            new Error(
              binary
                ? 'Project resolution deadline expired'
                : 'Caller Git executable is unavailable'
            )
          );
          return;
        }
        const child = spawn(binary, [...args], {
          cwd,
          env: environment,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const output: Buffer[] = [];
        const errors: Buffer[] = [];
        let bytes = 0;
        let failure: Error | undefined;
        let settled = false;
        const fail = (error: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          failure ??= error;
          child.kill('SIGKILL');
          // A descendant retaining the pipes cannot extend this port's response deadline.
          // Whole invocation process-group cleanup belongs to the native supervisor.
          child.stdout.destroy();
          child.stderr.destroy();
          reject(failure);
        };
        const timer = setTimeout(
          () => fail(new Error('Project Git resolution timed out')),
          remaining
        );
        const collect =
          (chunks: Buffer[]) =>
          (chunk: Buffer): void => {
            bytes += chunk.length;
            if (bytes > 1024 * 1024) fail(new Error('Project Git output exceeds byte limit'));
            else chunks.push(chunk);
          };
        child.stdout.on('data', collect(output));
        child.stderr.on('data', collect(errors));
        child.once('error', (error) => {
          clearTimeout(timer);
          fail(error);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          if (failure) reject(failure);
          else {
            try {
              const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
              const stdout = decoder.decode(Buffer.concat(output)).trim();
              const stderr = decoder.decode(Buffer.concat(errors)).trim();
              if (code !== 0) reject(new Error(stderr || 'Project Git resolution failed'));
              else accept(stdout);
            } catch (error) {
              reject(new Error('Project Git output is not valid UTF-8: ' + String(error)));
            }
          }
        });
      });
    },
  };
}

function governedAncestor(candidate: string): boolean {
  let current = candidate;
  for (;;) {
    if (existsSync(join(current, '.git')) || existsSync(join(current, '.caws'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Actual checkout and canonical authority are separate, using the store's root mapping. */
export async function resolveRuntimeProject(
  payload: Readonly<Record<string, unknown>>,
  caller: InvocationCaller,
  deadlineEpochMs: number,
  git: ContextGitPort = createContextGitPort(caller, deadlineEpochMs)
): Promise<RuntimeProjectContext> {
  const supplied = payload.cwd;
  if (supplied !== undefined && supplied !== null && typeof supplied !== 'string') {
    throw new TypeError('Hook cwd must be a string when supplied.');
  }
  const candidate = resolve(
    caller.cwd,
    supplied || caller.environment.CAWS_PROJECT_DIR || caller.cwd
  );
  let checkout: string;
  try {
    checkout = await git.run(['rev-parse', '--show-toplevel'], candidate);
    if (!isAbsolute(checkout)) throw new Error('Git checkout must be absolute');
  } catch (error) {
    if (isFatalContextGitError(error)) throw error;
    return Object.freeze({
      status: 'inactive',
      reason: 'outside a resolvable Git project',
      diagnostic: governedAncestor(candidate)
        ? `Project could not be resolved (${String(error)}); continuing without CAWS governance in ${candidate}`
        : '',
    });
  }
  const common = await git.run(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    checkout
  );
  const canonical = repoRootFromGitCommonDir(common).repoRoot;
  return Object.freeze({ status: 'resolved', checkout, canonical });
}
