import { randomUUID } from 'node:crypto';
import {
  decodeRuntimeRequest,
  encodeRuntimeResponse,
  MAX_REQUEST_DURATION_MS,
  SESSION_CACHE_CAPABILITY,
  type RuntimeRequest,
} from './protocol';
import {
  FAILURE_SCHEMA,
  PROPOSAL_SCHEMA,
  READY_SCHEMA,
  SERVICE_READY_SCHEMA,
  RuntimeFrameReader,
  decodeDispatchGrant,
  decodeHandoff,
  writeRuntimeFrame,
} from './live-protocol';
import { prepareRuntimeInvocation, type PreparedRuntimeInvocation } from './engine';
import { containmentWire } from './containment';
import { createNativeSessionCachePort } from './session-cache-client';
import { createNativeContextGitPort } from './context-git-client';
import { CONTEXT_GIT_CAPABILITY } from './context-git-wire';

/** Private one-shot protocol entry. Installation and resident-host selection are separate contracts. */
export async function runEngineEntry(): Promise<void> {
  const controller = new AbortController();
  const wire = new AbortController();
  const reader = new RuntimeFrameReader(process.stdin);
  let request: RuntimeRequest | null = null,
    prepared: PreparedRuntimeInvocation | null = null;
  let timer = setTimeout(
    () => controller.abort(new Error('Initial native request deadline expired')),
    MAX_REQUEST_DURATION_MS
  );
  let wireTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    const reason = new Error('Native engine cancelled');
    controller.abort(reason);
    wire.abort(reason);
  };
  const outputFailed = (error: Error): void => {
    controller.abort(error);
    wire.abort(error);
  };
  process.stdout.on('error', outputFailed);
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  process.once('SIGHUP', cancel);
  let handoffAcknowledged = false,
    proposed = false;
  try {
    request = decodeRuntimeRequest(await reader.read(controller.signal));
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new Error('Native request deadline expired')),
      Math.max(1, request.deadlineEpochMs - Date.now())
    );
    const sessionCache =
      request.sessionCache === SESSION_CACHE_CAPABILITY
        ? createNativeSessionCachePort(
            request,
            {
              read: (signal) => reader.read(signal),
              write: (frame, signal) => writeRuntimeFrame(process.stdout, frame, signal),
            },
            controller.signal
          )
        : undefined;
    const contextGit =
      request.contextGit === CONTEXT_GIT_CAPABILITY
        ? createNativeContextGitPort(
            request,
            {
              read: (signal) => reader.read(signal),
              write: (frame, signal) => writeRuntimeFrame(process.stdout, frame, signal),
            },
            controller.signal
          )
        : undefined;
    prepared = await prepareRuntimeInvocation(request, controller.signal, sessionCache, contextGit);
    await writeRuntimeFrame(
      process.stdout,
      {
        schema: prepared.serviceOffer ? SERVICE_READY_SCHEMA : READY_SCHEMA,
        id: request.id,
        runtimeDigest: request.runtimeDigest,
        active: prepared.active,
        budgetHome: prepared.budgetHome,
        projectDigest: prepared.projectDigest,
        sessionId: prepared.sessionId,
        ...(prepared.serviceOffer ? { serviceOffer: prepared.serviceOffer } : {}),
      },
      controller.signal
    );
    const admission = decodeDispatchGrant(
      await reader.read(controller.signal),
      request,
      prepared.serviceOffer
    );
    const completion = await prepared.dispatch(admission ?? undefined);
    const result = completion.nativeResult;
    const containment = completion.containment ? containmentWire(completion.containment) : null;
    const token = randomUUID();
    clearTimeout(timer);
    wireTimer = setTimeout(
      () => wire.abort(new Error('Native result handoff deadline expired')),
      1100
    );
    await writeRuntimeFrame(
      process.stdout,
      {
        schema: PROPOSAL_SCHEMA,
        id: request.id,
        runtimeDigest: request.runtimeDigest,
        token,
        response: JSON.parse(encodeRuntimeResponse(request, result)),
        containment,
      },
      wire.signal
    );
    proposed = true;
    const handoff = decodeHandoff(await reader.read(wire.signal), request, token, containment);
    handoffAcknowledged = true;
    const diagnostics = await prepared.acknowledgeHandoff(handoff.success, handoff.containment);
    if (diagnostics) process.stderr.write(diagnostics);
  } catch (error) {
    if (prepared && !handoffAcknowledged) {
      handoffAcknowledged = true;
      try {
        const diagnostic = await prepared.acknowledgeHandoff(false);
        if (diagnostic) process.stderr.write(diagnostic);
      } catch (settlement) {
        process.stderr.write(
          '[caws runtime] unsettled effects deferred: ' + String(settlement) + '\n'
        );
      }
    }
    if (request && !proposed && !wire.signal.aborted) {
      wireTimer ??= setTimeout(() => wire.abort(new Error('Failure frame deadline expired')), 250);
      try {
        await writeRuntimeFrame(
          process.stdout,
          {
            schema: FAILURE_SCHEMA,
            id: request.id,
            runtimeDigest: request.runtimeDigest,
            message: String(error),
          },
          wire.signal
        );
      } catch {
        /* Native owns final uncertain-outcome policy. */
      }
    } else process.stderr.write('[caws runtime] entry failed: ' + String(error) + '\n');
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    clearTimeout(wireTimer);
    process.removeListener('SIGTERM', cancel);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGHUP', cancel);
    process.stdin.destroy();
    // The process owns stdout for its full lifetime; retain the error handler
    // while a cancelled write may still complete with EPIPE.
  }
}

if (require.main === module) {
  void runEngineEntry().catch((error) => {
    process.stderr.write('[caws runtime] unhandled entry failure: ' + String(error) + '\n');
    process.exitCode = 1;
  });
}
