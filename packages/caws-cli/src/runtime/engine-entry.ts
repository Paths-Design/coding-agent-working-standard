import { randomUUID } from 'node:crypto';
import {
  decodeRuntimeRequest,
  encodeRuntimeResponse,
  MAX_REQUEST_DURATION_MS,
  SESSION_CACHE_CAPABILITY,
  SESSION_END_PREFIX_CAPABILITY,
  SESSION_PUBLICATION_CAPABILITY,
  STOP_PREFIX_CAPABILITY,
  STOP_LEASE_CONTEXT_CAPABILITY,
  TRANSCRIPT_STORE_CAPABILITY,
  type RuntimeRequest,
} from './protocol';
import {
  FAILURE_SCHEMA,
  PROPOSAL_SCHEMA,
  READY_SCHEMA,
  SERVICE_READY_SCHEMA,
  RuntimeFrameReader,
  decodeDispatchGrant,
  isNativeStopAdmission,
  decodeHandoff,
  writeRuntimeFrame,
} from './live-protocol';
import { prepareRuntimeInvocation, type PreparedRuntimeInvocation } from './engine';
import { containmentWire } from './containment';
import {
  createNativeSessionCachePort,
  createNativeSessionEndPrefixPort,
  createNativeStopPrefixPort,
} from './session-cache-client';
import { createNativeTranscriptStorePort } from './transcript-store-client';
import { createNativeSessionSealPort } from './session-publication-client';
import { compareCliIdentity, type ReviewedCliIdentity } from './cli-identity';
import { loadGenerationCliIdentity } from './cli-identity-loader';
import { createNativeStopLeaseContextPort } from './stop-lease-context';
import { createNativeContextGitPort } from './context-git-client';
import {
  CONTEXT_GIT_CAPABILITY,
  EXECUTION_WORKDIR_CONTEXT_GIT_CAPABILITY,
} from './context-git-wire';
import { createNativeSelectionResolver } from './selection-observation';

/** Private one-shot protocol entry. Installation and resident-host selection are separate contracts. */
export async function runEngineEntry(reviewedCliIdentity?: ReviewedCliIdentity): Promise<void> {
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
      request.contextGit === CONTEXT_GIT_CAPABILITY ||
      request.contextGit === EXECUTION_WORKDIR_CONTEXT_GIT_CAPABILITY
        ? createNativeContextGitPort(
            request,
            {
              read: (signal) => reader.read(signal),
              write: (frame, signal) => writeRuntimeFrame(process.stdout, frame, signal),
            },
            controller.signal
          )
        : undefined;
    const sessionSeal =
      request.configuration === 'system' &&
      request.event === 'session_end' &&
      request.sessionPublication === SESSION_PUBLICATION_CAPABILITY
        ? createNativeSessionSealPort(
            request,
            {
              read: (signal) => reader.read(signal),
              write: (frame, signal) => writeRuntimeFrame(process.stdout, frame, signal),
            },
            controller.signal
          )
        : undefined;
    const sessionEndPrefix =
      request.configuration === 'system' &&
      request.event === 'session_end' &&
      request.sessionEndPrefix === SESSION_END_PREFIX_CAPABILITY
        ? createNativeSessionEndPrefixPort(
            request,
            {
              read: (signal) => reader.read(signal),
              write: (frame, signal) => writeRuntimeFrame(process.stdout, frame, signal),
            },
            controller.signal
          )
        : undefined;
    const stopTransport = {
      read: (signal: AbortSignal) => reader.read(signal),
      write: (frame: Readonly<Record<string, unknown>>, signal: AbortSignal) =>
        writeRuntimeFrame(process.stdout, frame, signal),
    };
    const stopCandidate =
      request.configuration === 'system' &&
      request.surface === 'opencode' &&
      request.event === 'stop' &&
      request.stopPrefix === STOP_PREFIX_CAPABILITY &&
      request.sessionStore === TRANSCRIPT_STORE_CAPABILITY &&
      request.sessionPublication === SESSION_PUBLICATION_CAPABILITY;
    const stopPrefix = stopCandidate
      ? createNativeStopPrefixPort(request, stopTransport, controller.signal)
      : undefined;
    const stopStore = stopCandidate
      ? createNativeTranscriptStorePort(request, stopTransport, controller.signal)
      : undefined;
    // The ordinary entry resolves only its own exact generation. Missing
    // reviewed data preserves compatibility; malformed present data is terminal.
    // Generation admission and the native dispatch grant retain authority.
    const reviewed = stopCandidate
      ? (reviewedCliIdentity ??
        (await loadGenerationCliIdentity(request, controller.signal, __filename)))
      : undefined;
    const cliIdentity = reviewed
      ? await compareCliIdentity({ request, reviewed, signal: controller.signal })
      : undefined;
    if (controller.signal.aborted) throw controller.signal.reason;
    prepared = await prepareRuntimeInvocation(
      request,
      controller.signal,
      sessionCache,
      contextGit,
      sessionSeal,
      sessionEndPrefix,
      request.selectionObservation
        ? createNativeSelectionResolver(
            request,
            {
              read: (signal) => reader.read(signal),
              write: (frame, signal) => writeRuntimeFrame(process.stdout, frame, signal),
            },
            controller.signal
          )
        : undefined,
      stopPrefix,
      stopStore,
      stopCandidate && request.stopLeaseContext === STOP_LEASE_CONTEXT_CAPABILITY
        ? createNativeStopLeaseContextPort(request, stopTransport, controller.signal)
        : undefined,
      cliIdentity?.status === 'matched' ? cliIdentity.receipt : undefined
    );
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
    const completion =
      admission && isNativeStopAdmission(admission)
        ? await prepared.dispatch(undefined, admission)
        : await prepared.dispatch(admission ?? undefined);
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
