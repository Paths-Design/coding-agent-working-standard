import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';
import { resolveGitBinaryForEnvironment } from '../store/git-binary';
import { invocationCaller, invocationEnvironment, type ContextGitPort } from './context';
import type { RuntimeRequest } from './protocol';
import {
  ContextGitError,
  EXECUTION_WORKDIR_CONTEXT_GIT_CAPABILITY,
  createContextGitRequest,
  decodeContextGitResult,
  type ContextGitOperation,
  type ContextGitOrdinal,
  type ContextGitRequest,
  type ContextGitResult,
} from './context-git-wire';

export type ContextGitInvocation = Pick<
  RuntimeRequest,
  'id' | 'runtimeDigest' | 'caller' | 'deadlineEpochMs' | 'contextGit'
>;
export interface ContextGitTransport {
  /** The engine entry owns the sole framed reader; input retains original JSON tokens. */
  read(signal: AbortSignal): Promise<Uint8Array>;
  write(frame: ContextGitRequest, signal: AbortSignal): Promise<void>;
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((accept, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        accept(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
    if (signal.aborted) abort();
  });
}

function usableOutput(result: ContextGitResult): string {
  if (result.status !== 'exited') {
    const categories = {
      spawn_failed: 'spawn_failed',
      cancelled: 'cancelled',
      deadline: 'deadline',
      output_limit: 'output_limit',
      cleanup_unsettled: 'cleanup',
      identity_changed: 'identity',
    } as const;
    throw new ContextGitError(
      categories[result.status],
      result.diagnostic || 'Native context Git ' + result.status,
      result.cleanup
    );
  }
  if (result.signal !== null)
    throw new ContextGitError(
      'signal',
      'Project Git terminated by signal ' + result.signal,
      result.cleanup
    );
  let stdout: string, stderr: string;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    stdout = decoder.decode(result.stdout).trim();
    stderr = decoder.decode(result.stderr).trim();
  } catch (error) {
    throw new ContextGitError(
      'utf8',
      'Project Git output is not valid UTF-8: ' + String(error),
      result.cleanup
    );
  }
  if (result.exitCode !== 0)
    throw new ContextGitError(
      'git_exit',
      stderr || 'Project Git resolution failed',
      result.cleanup
    );
  if (!isAbsolute(stdout) || stdout.includes('\0'))
    throw new ContextGitError(
      'protocol',
      'Project Git root must be absolute native text',
      result.cleanup
    );
  return stdout;
}

/** A native-advertised finite profile: two requests, or two ordered project pairs.
 * A failed or aborted exchange is consumed, never replayed.
 * Aborting a transport wait does not attest native child/group/pipe settlement.
 */
export function createNativeContextGitPort(
  request: ContextGitInvocation,
  transport: ContextGitTransport,
  signal: AbortSignal
): ContextGitPort {
  if (!Number.isSafeInteger(request.deadlineEpochMs) || request.deadlineEpochMs <= 0)
    throw new ContextGitError('protocol', 'Project deadline must be a positive integer');
  const caller = invocationCaller(request.caller.cwd, request.caller.environment);
  const executable = resolveGitBinaryForEnvironment(invocationEnvironment(caller), caller.cwd);
  const identity = Object.freeze({ id: request.id, runtimeDigest: request.runtimeDigest });
  const token = randomBytes(32).toString('hex');
  const deadlineEpochMs = request.deadlineEpochMs;
  const maximum = request.contextGit === EXECUTION_WORKDIR_CONTEXT_GIT_CAPABILITY ? 4 : 2;
  let ordinal: number = 1,
    busy = false,
    failed = false;
  let checkout: string | undefined;
  return Object.freeze({
    async run(args: readonly string[], cwd: string): Promise<string> {
      if (failed || busy || ordinal > maximum) {
        failed = true;
        throw new ContextGitError('protocol', 'Native context Git port is consumed or busy');
      }
      const operation: ContextGitOperation = ordinal % 2 === 1 ? 'checkout' : 'commonDir';
      const expected =
        ordinal % 2 === 1
          ? ['rev-parse', '--show-toplevel']
          : ['rev-parse', '--path-format=absolute', '--git-common-dir'];
      if (
        args.length !== expected.length ||
        args.some((arg, index) => arg !== expected[index]) ||
        (ordinal % 2 === 0 && cwd !== checkout)
      ) {
        failed = true;
        throw new ContextGitError('protocol', 'Unsupported native context Git operation or order');
      }
      busy = true;
      const controller = new AbortController();
      const cancelled = (): void =>
        controller.abort(
          new ContextGitError(
            'cancelled',
            'Native context Git wait cancelled; cleanup is unconfirmed'
          )
        );
      signal.addEventListener('abort', cancelled, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (signal.aborted) cancelled();
        if (controller.signal.aborted) throw controller.signal.reason;
        const remaining = deadlineEpochMs - Date.now();
        if (remaining <= 0)
          throw new ContextGitError(
            'deadline',
            'Project resolution deadline expired; cleanup is unconfirmed'
          );
        // Native owns its five-second execution ceiling and cleanup reserve.
        // This outer wait never extends the invocation's absolute deadline.
        timer = setTimeout(
          () =>
            controller.abort(
              new ContextGitError(
                'deadline',
                'Native context Git wait deadline expired; cleanup is unconfirmed'
              )
            ),
          Math.min(remaining, 2147483647)
        );
        if (!executable)
          throw new ContextGitError('unavailable', 'Caller Git executable is unavailable');
        const frame = createContextGitRequest(
          identity,
          token,
          ordinal as ContextGitOrdinal,
          operation,
          executable,
          cwd
        );
        await abortable(transport.write(frame, controller.signal), controller.signal);
        if (controller.signal.aborted) throw controller.signal.reason;
        const raw = await abortable(transport.read(controller.signal), controller.signal);
        if (controller.signal.aborted) throw controller.signal.reason;
        const result = decodeContextGitResult(raw, frame);
        if (failed)
          throw new ContextGitError(
            'protocol',
            'Concurrent native context Git use poisoned the exchange'
          );
        const output = usableOutput(result);
        if (ordinal % 2 === 1) checkout = output;
        ordinal++;
        return output;
      } catch (error) {
        failed = true;
        if (error instanceof ContextGitError) throw error;
        throw new ContextGitError(
          'protocol',
          'Native context Git transport failed; cleanup is unconfirmed: ' + String(error)
        );
      } finally {
        busy = false;
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener('abort', cancelled);
      }
    },
  });
}
