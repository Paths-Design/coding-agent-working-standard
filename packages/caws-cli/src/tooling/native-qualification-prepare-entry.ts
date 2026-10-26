import {
  prepareFrozenProductionSource,
  type FrozenSourcePreparationContext,
  type FrozenSourcePreparationRequest,
  type FrozenSourcePreparationResult,
} from './native-qualification-prepare';

const MAX_REQUEST_BYTES = 64 * 1024;

function refused(phase: string, reason: string): FrozenSourcePreparationResult {
  return { status: 'failed', adoption: 'NOT_ADOPTED', writerState: 'NOT_STARTED', phase, reason };
}

/**
 * Bounded request handler for an independently admitted maintained parent.
 * The parent owns Node/Git startup, actual caller context, fixed metadata Git
 * and private object-store access before invoking this handler. Parent context
 * is a separate programmatic dependency and must never come from request JSON.
 * This module supplies no process/env/path fallback or self-attested capability.
 */
export function executeFrozenSourcePreparation(
  bytes: Buffer,
  parent: FrozenSourcePreparationContext
): FrozenSourcePreparationResult {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_REQUEST_BYTES)
    return refused('input', 'Expected bounded UTF-8 JSON request bytes');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes))
    return refused('input', 'Preparation request must be valid UTF-8');
  let request: unknown;
  try {
    request = JSON.parse(text);
  } catch {
    return refused('input', 'Preparation request is not valid JSON');
  }
  if (
    !parent ||
    typeof parent.git !== 'function' ||
    typeof parent.readObjects !== 'function' ||
    typeof parent.checkpoint !== 'function'
  )
    return refused('parent', 'An independently admitted maintained parent is required');
  // The core validates the closed request shape and re-derives source/output
  // standing; parsing or parent-shaped data alone establishes neither.
  return prepareFrozenProductionSource(request as FrozenSourcePreparationRequest, parent);
}

if (require.main === module) {
  process.stderr.write(
    'Frozen preparation requires a maintained parent; standalone invocation is not admitted.\n'
  );
  process.exitCode = 2;
}
