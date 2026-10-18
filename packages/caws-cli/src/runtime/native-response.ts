import type { DispatchPhase, NativeResult, NativeResultContext, StopFailureBudget } from './types';

/** A handler answered, but its native output cannot safely be delivered. */
export class NativeOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeOutputError';
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function diagnostic(stderr: string, message: string): string {
  return stderr + (stderr && !stderr.endsWith('\n') ? '\n' : '') + message + '\n';
}

/** Preserve transport bytes, except for the native Codex Stop text envelope. */
export function normalizeNativeResult(
  context: NativeResultContext,
  result: NativeResult
): NativeResult {
  if (context.surface !== 'codex') return result;
  const text = result.stdout.trim();
  let output: unknown;
  let parsed = true;
  try {
    output = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = false;
    // Python's legacy decoder also recognizes these nonstandard scalar tokens;
    // they were rejected as nonobjects, rather than delivered as lifecycle text.
    if (
      context.event === 'stop' &&
      result.exitCode === 0 &&
      (text.startsWith('{') ||
        text.startsWith('[') ||
        ['NaN', 'Infinity', '-Infinity'].includes(text))
    ) {
      throw new NativeOutputError('Malformed Codex Stop JSON');
    }
  }
  let stderr = result.stderr;
  if (result.exitCode === 2) {
    const specific =
      object(output) && object(output.hookSpecificOutput) ? output.hookSpecificOutput : {};
    const candidates = object(output)
      ? [specific.permissionDecisionReason, output.reason, output.stopReason]
      : [];
    const reason =
      candidates.find(
        (value): value is string => typeof value === 'string' && value.trim().length > 0
      ) ||
      text ||
      `CAWS ${context.event} blocked with exit code 2`;
    stderr = diagnostic(stderr, `[caws machine adapter ${context.runtimeDigest}] ${reason}`);
  }
  if (context.event === 'stop' && result.exitCode === 0 && text) {
    if (!parsed)
      return { ...result, stdout: JSON.stringify({ systemMessage: text }) + '\n', stderr };
    if (!object(output))
      throw new NativeOutputError('Malformed Codex Stop JSON: expected an object');
  }
  return { ...result, stderr };
}

/** Infrastructure failure policy; a valid guard refusal never enters this path. */
export async function adapterFailure(
  context: NativeResultContext,
  phase: DispatchPhase,
  errorMessage: string,
  budget?: StopFailureBudget
): Promise<NativeResult> {
  const message = 'CAWS machine adapter: ' + errorMessage;
  const stderr = diagnostic('', '[caws machine adapter] ' + message);
  if (phase === 'configuration' && context.event !== 'pre_tool_use') {
    return { exitCode: 0, stdout: '', stderr };
  }
  if (phase === 'execution' && context.event === 'stop' && budget) {
    let release: boolean;
    try {
      release = (await budget.charge()) === 'release';
    } catch {
      // A broken counter cannot bound repeated refusals. Match persistence failure policy.
      release = true;
    }
    if (release) {
      const reason =
        'CAWS machine adapter is releasing this stop over an unmet, undeliverable condition: ' +
        'the Stop handler result was unusable and the failure budget released the stop. ' +
        message;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ systemMessage: reason }) + '\n',
        stderr: diagnostic(stderr, '[caws machine adapter] ' + reason),
      };
    }
  }
  return {
    exitCode: 2,
    stdout: JSON.stringify({ decision: 'block', reason: message }) + '\n',
    stderr,
  };
}
