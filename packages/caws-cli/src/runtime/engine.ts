import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { TextDecoder } from 'node:util';
import type { AgentSurface } from '../init/hook-packs/types';
import { settleMessageOffer } from '../store/messages-store';
import { invocationEnvironment, resolveRuntimeProject, type ContextGitPort } from './context';
import { CONTEXT_GIT_CAPABILITY } from './context-git-wire';
import {
  composeHandlers,
  ComposerExecutionError,
  isProtectiveCapture,
  type OfferMembership,
  type PendingDedup,
} from './composer';
import {
  createHandlerExecutor,
  executeCompatibilityDispatch,
  HandlerExecutionError,
} from './handler-executor';
import { handlerEligibility } from './eligibility';
import { resolveInvocationIdentity } from './identity';
import { clearGuardConfigurationTransport, invocationGuardConfiguration } from './guard-config';
import { InvocationJournal } from './journal';
import { AdvisoryDedup } from './advisory-dedup';
import { normalizeNativeResult } from './native-response';
import { resolveInvocationSelection, type ActiveInvocationSelection } from './selection';
import { encodeRuntimeResponse, SESSION_CACHE_CAPABILITY, type RuntimeRequest } from './protocol';
import { qualifiesForNativeSessionCache } from './session-cache-admission';
import { sessionCacheInputSupported, type NativeSessionCachePort } from './session-cache-client';
import type { NativeResult } from './types';
import { prepareNativeRenderOffer, type NativeRenderOffer } from './service-offer';
import { type NativeRenderAdmission, disposeNativeRenderAdmission } from './service-image';
import {
  CONTAINMENT_ENV,
  containmentWire,
  decodeContainmentReceipt,
  observeContainmentLatch,
  type ContainmentReceipt,
  type ValidatedContainmentIntent,
} from './containment';

// Vendor directories match surfaces/registry.json; process names retain the
// owning stock agent-surface.sh defaults. No process-name guess mints identity.
const PROFILES: Partial<Record<AgentSurface, { vendor: string; names: readonly string[] }>> = {
  'claude-code': { vendor: '.claude', names: ['claude'] },
  codex: { vendor: '.codex', names: ['codex'] },
  opencode: { vendor: '.opencode', names: ['opencode'] },
  zcode: {
    vendor: '.zcode',
    names: ['zcode-cli', 'zcode-host-local-1', 'zcode-host-local-2', 'zcode-host-local-3'],
  },
  'kimi-code': { vendor: '.kimi-code', names: ['kimi-code', 'kimi'] },
  'qwen-code': { vendor: '.qwen', names: ['qwen', 'qwen-code'] },
  dsh: { vendor: '.dsh', names: ['dsh'] },
};
const empty = (): NativeResult => ({
  exitCode: 0,
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
});
const truthy = (value: string | undefined): boolean => Boolean(value && value !== '0');
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Preserve stdout decisions. Bound only aggregate diagnostic stderr, after raw capture. */
export function boundedNativeResult(result: NativeResult): NativeResult {
  const maximum = 3 * 1024 * 1024 - 4096;
  if (result.stdout.byteLength > maximum)
    throw new Error('Native stdout exceeds response envelope');
  const available = maximum - result.stdout.byteLength;
  if (result.stderr.byteLength <= available) return result;
  const marker = Buffer.from(
    '\n[caws runtime] aggregate stderr truncated; journal availability is reported separately.\n'
  );
  if (available < marker.length)
    throw new Error('Native response cannot retain its truncation diagnostic');
  return {
    ...result,
    stderr: Buffer.concat([result.stderr.subarray(0, available - marker.length), marker]),
  };
}

/** A captured protective decision survives later receipt/capture failure. It is not a completed handler. */
export function capturedRefusal(error: unknown): NativeResult | null {
  const failure = error instanceof ComposerExecutionError ? error.originalError : error;
  if (!(failure instanceof HandlerExecutionError)) return null;
  if (failure.completedExitCode !== 2 && !isProtectiveCapture(failure.stdout)) return null;
  return {
    exitCode: 2,
    stdout: Buffer.from(failure.stdout),
    stderr: Buffer.concat([
      failure.stderr,
      Buffer.from(
        '\n[caws runtime] protective decision preserved after incomplete handler capture: ' +
          failure.message +
          '\n'
      ),
    ]),
  };
}

function compatibilityRequired(
  request: RuntimeRequest,
  selection: ActiveInvocationSelection,
  environment: Readonly<Record<string, string>>
): boolean {
  const startup = join(selection.runtimeDirectory, 'handler-env.sh');
  const prior =
    environment.CAWS_PRIOR_BASH_ENV ||
    (environment.BASH_ENV !== startup ? environment.BASH_ENV : '');
  // Canonical Bash is the first native parser/consumer slice. Other payload
  // adapters retain their full dispatcher until their normalization is ported.
  return (
    selection.configuration !== 'system' ||
    // Extensions retain the selected parser's complete normalization contract.
    selection.handlers.some((handler) => handler.kind !== 'stock') ||
    Boolean(prior) ||
    Object.values(selection.libraries).some(
      (library) => library.kind === 'project' || library.kind === 'user'
    ) ||
    request.surface !== 'codex' ||
    request.event !== 'pre_tool_use' ||
    request.payload.tool_name !== 'Bash' ||
    !request.payload.tool_input ||
    typeof request.payload.tool_input !== 'object' ||
    Array.isArray(request.payload.tool_input) ||
    typeof (request.payload.tool_input as Record<string, unknown>).command !== 'string' ||
    truthy(
      environment.CAWS_HOOK_TIMING ||
        environment.CLAUDE_HOOK_TIMING ||
        environment.CODEX_HOOK_TIMING
    )
  );
}

function compatibilityOffers(bytes: Uint8Array): OfferMembership[] {
  const latest = new Map<string, OfferMembership>();
  for (const line of new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    .decode(bytes)
    .split('\n')) {
    if (!line.trim()) continue;
    const row: unknown = JSON.parse(line);
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      const value = row as Record<string, unknown>;
      if (
        typeof value.offer_id === 'string' &&
        typeof value.recipient === 'string' &&
        (value.action === 'selected' || value.action === 'released')
      )
        latest.set(value.offer_id, {
          offerId: value.offer_id,
          recipient: value.recipient,
          action: value.action,
          selectedIndex: -1,
          handler: 'compatibility-dispatch',
          reason: 'Selected compatibility dispatcher receipt; no model-visibility claim',
        });
    }
  }
  return [...latest.values()];
}

export interface PreparedDispatchResult {
  readonly nativeResult: NativeResult;
  readonly containment: ValidatedContainmentIntent | null;
}
/** Native effect receipt is a separate observation from output and message delivery. */
export function recordContainmentHandoff(
  journal: Pick<InvocationJournal, 'append' | 'diagnostics'>,
  intent: ValidatedContainmentIntent | null,
  success: boolean,
  receipt: ContainmentReceipt | null
): void {
  if (!intent && receipt === null) return;
  const wire = intent ? containmentWire(intent) : null;
  const accepted = decodeContainmentReceipt(receipt, wire);
  journal.append('containment_settled', {
    observation_boundary: 'native_signal_syscall_receipt',
    intent: wire,
    receipt: accepted,
    effect_observation: accepted?.status ?? 'not_observed',
    native_output_accepted: success,
    process_exit_observed: false,
    latch_state: intent ? observeContainmentLatch(intent) : 'not_requested',
    legacy_latch_written: false,
  });
}
export interface PreparedRuntimeInvocation {
  readonly active: boolean;
  readonly budgetHome: string;
  readonly projectDigest: string | null;
  readonly sessionId: string | null;
  readonly serviceOffer?: NativeRenderOffer;
  dispatch(admission?: NativeRenderAdmission): Promise<PreparedDispatchResult>;
  acknowledgeHandoff(success: boolean, containment?: ContainmentReceipt | null): Promise<string>;
}

export async function prepareRuntimeInvocation(
  request: RuntimeRequest,
  signal: AbortSignal,
  nativeSessionCache?: NativeSessionCachePort,
  contextGit?: ContextGitPort
): Promise<PreparedRuntimeInvocation> {
  if (request.contextGit === CONTEXT_GIT_CAPABILITY && !contextGit)
    throw new Error('Native context Git capability requires its request-owned port');
  const environment = invocationEnvironment(request.caller);
  clearGuardConfigurationTransport(environment);
  for (const name of [
    'CAWS_HOOK_INVOCATION_FILE',
    'CAWS_HOOK_INVOCATION_METADATA',
    'CAWS_HOOK_EXECUTION_FILE',
    'CAWS_HOOK_SETTLEMENT_FILE',
    'CAWS_HANDLER_OFFER_FILE',
    'CAWS_MACHINE_LOG_DIR',
    CONTAINMENT_ENV,
  ])
    delete environment[name];
  const home = environment.CAWS_HOME || (environment.HOME ? join(environment.HOME, '.caws') : '');
  if (!home || !isAbsolute(home))
    throw new Error('Runtime requires an absolute caller machine home');
  environment.CAWS_HOME = home;
  const context = await resolveRuntimeProject(
    request.payload,
    request.caller,
    request.deadlineEpochMs,
    contextGit
  );
  const selection =
    context.status === 'resolved'
      ? resolveInvocationSelection({
          checkout: context.checkout,
          canonical: context.canonical,
          home,
          runtimeDigest: request.runtimeDigest,
          surface: request.surface,
          event: request.event,
          system: request.configuration === 'system',
        })
      : { status: 'inactive' as const, reason: context.reason };
  if (signal.aborted) throw signal.reason;
  if (selection.status === 'inactive') {
    let used = false;
    return {
      active: false,
      budgetHome: home,
      projectDigest: null,
      sessionId: null,
      async dispatch(admission) {
        if (admission) {
          disposeNativeRenderAdmission(admission);
          throw new Error('Inactive invocation cannot accept service admission');
        }
        if (used) throw new Error('Invocation dispatch is single-use');
        used = true;
        return {
          nativeResult: {
            ...empty(),
            stderr: Buffer.from(
              context.status === 'inactive' && context.diagnostic ? context.diagnostic + '\n' : ''
            ),
          },
          containment: null,
        };
      },
      async acknowledgeHandoff() {
        return '';
      },
    };
  }
  const profile = PROFILES[request.surface];
  if (!profile) throw new Error('Runtime surface profile unavailable');
  const identity = resolveInvocationIdentity(request, signal);
  if (identity.sessionId) environment.CAWS_SESSION_ID = identity.sessionId;
  else delete environment.CAWS_SESSION_ID;
  if (selection.configuration === 'system')
    environment.CAWS_MACHINE_LOG_DIR = join(
      home,
      'state/projects',
      digest(selection.canonical),
      'logs',
      request.surface
    );
  const journal = new InvocationJournal(request, selection, identity.sessionId);
  const dedup = new AdvisoryDedup(home, selection.canonical, identity.sessionId, environment);
  const serviceOffer = prepareNativeRenderOffer(
    request,
    selection,
    environment,
    identity.sessionId,
    home
  );
  let dispatched = false,
    acknowledged = false,
    result: NativeResult | null = null;
  let containment: ValidatedContainmentIntent | null = null;
  let offers: readonly OfferMembership[] = [],
    pending: readonly PendingDedup[] = [];
  return {
    active: true,
    budgetHome: home,
    projectDigest: digest(selection.canonical),
    ...(serviceOffer ? { serviceOffer } : {}),
    sessionId:
      identity.sessionId &&
      identity.sessionId !== 'unknown' &&
      Buffer.byteLength(identity.sessionId) <= 128 &&
      !identity.sessionId.includes('\0')
        ? identity.sessionId
        : null,
    async dispatch(admission) {
      if (Boolean(serviceOffer) !== Boolean(admission)) {
        if (admission) disposeNativeRenderAdmission(admission);
        throw new Error('Native render admission must match the prepared service offer');
      }
      if (dispatched || acknowledged)
        throw new Error('Invocation dispatch is single-use and cannot resume after settlement');
      if (signal.aborted) throw signal.reason;
      dispatched = true;
      journal.append('dispatch_started');
      let cacheDiagnostic = '';
      try {
        const options = {
          request,
          selection,
          environment: invocationGuardConfiguration(selection, environment),
          signal,
        };
        let compatibility = compatibilityRequired(request, selection, environment);
        if (!compatibility) {
          const sid = request.payload.session_id;
          // Unsafe/non-string identity retains the complete parser's diagnostic
          // behavior. Resolved fallback identity must never select cache writes.
          const supportedSid =
            sid === undefined ||
            (typeof sid === 'string' &&
              (sid === '' ||
                sid === 'unknown' ||
                (sid !== '.' && sid !== '..' && /^[A-Za-z0-9_.@:-]+$/.test(sid))));
          if (
            !nativeSessionCache ||
            request.sessionCache !== SESSION_CACHE_CAPABILITY ||
            !supportedSid ||
            !sessionCacheInputSupported(request.inputJson) ||
            !qualifiesForNativeSessionCache({ request, selection, environment })
          ) {
            compatibility = true;
          } else {
            // Ready and the native dispatch grant precede this awaited prefix.
            // It also runs for empty or entirely reprieved handler selections.
            const cache = await nativeSessionCache.capture(selection.canonical);
            if (signal.aborted) throw signal.reason;
            journal.append('session_cache_completed', {
              status: cache.status,
              envelope_published: cache.envelopePublished,
            });
            if (cache.status === 'declined') compatibility = true;
            else if (cache.status === 'unavailable')
              cacheDiagnostic = '[caws runtime] ' + cache.diagnostic + '\n';
          }
        }
        if (compatibility) {
          const completed = await executeCompatibilityDispatch({
            ...options,
            ...(admission ? { nativeRenderAdmission: admission } : {}),
          });
          result = completed;
          try {
            offers = compatibilityOffers(completed.offerReceipts);
          } catch (error) {
            journal.diagnostics.push(
              '[caws runtime] compatibility offer settlement deferred: ' + String(error) + '\n'
            );
          }
          journal.append('compatibility_dispatch_completed', {
            exit_code: completed.exitCode,
            execution_records_base64: Buffer.from(completed.executionRecords).toString('base64'),
          });
        } else {
          const composition = await composeHandlers(
            selection,
            {
              signal,
              requestId: request.id,
              dedupEnabled: environment.CAWS_HOOK_ADVISORY_DEDUP !== '0',
              dryRun: truthy(
                environment.CAWS_HOOK_DRY_RUN ||
                  environment.CLAUDE_HOOK_DRY_RUN ||
                  environment.CODEX_HOOK_DRY_RUN
              ),
              advisoryBudgetBytes: /^\d+$/.test(environment.CAWS_HOOK_ADVISORY_BUDGET_BYTES ?? '')
                ? Number(environment.CAWS_HOOK_ADVISORY_BUDGET_BYTES)
                : 32768,
            },
            {
              execute: createHandlerExecutor(options),
              record: (observation) => journal.record(observation),
              eligibility: (handler) =>
                handlerEligibility(handler, {
                  home,
                  canonical: selection.canonical,
                  vendorDirectory: profile.vendor,
                  sessionId: identity.sessionId,
                  event: request.event,
                  environment,
                }),
              dedup,
            }
          );
          result = composition.nativeResult;
          containment = composition.containment;
          offers = composition.offers;
          pending = composition.pendingDedup;
        }
      } catch (error) {
        if (error instanceof ComposerExecutionError) offers = error.offers;
        const failure = error instanceof ComposerExecutionError ? error.originalError : error;
        if (failure instanceof HandlerExecutionError) {
          offers = [
            ...offers,
            ...failure.offers.map((offer) => ({
              ...offer,
              handler: 'interrupted-handler',
              selectedIndex: -1,
              action: 'released' as const,
              reason: 'Interrupted handler capture',
            })),
          ];
        }
        containment = null;
        journal.append('adapter_error', { error: String(error) });
        result = capturedRefusal(error);
        if (!result) throw error;
      }
      journal.append('dispatch_completed', { exit_code: result.exitCode });
      const native = boundedNativeResult(
        normalizeNativeResult(request, {
          ...result,
          stderr: Buffer.concat([
            result.stderr,
            Buffer.from(cacheDiagnostic + identity.diagnostic + journal.takeDiagnostics()),
          ]),
        })
      );
      encodeRuntimeResponse(request, native); // Refuse an unusable proposal before sending it.
      result = native;
      if (containment && (native.exitCode !== 2 || !isProtectiveCapture(native.stdout)))
        containment = null;
      if (containment)
        journal.append('containment_intent_prepared', {
          intent: containmentWire(containment),
          source_digest_boundary: 'before_and_after_dispatch',
          process_exit_observed: false,
        });
      return Object.freeze({ nativeResult: native, containment });
    },
    async acknowledgeHandoff(success, receipt = null) {
      if (acknowledged)
        throw new Error('Native handoff was already acknowledged; settlement is not retried');
      acknowledged = true;
      try {
        recordContainmentHandoff(journal, containment, success, receipt);
      } catch (error) {
        journal.append('containment_receipt_invalid', {
          error: String(error),
          process_exit_observed: false,
        });
        journal.diagnostics.push(
          '[caws containment] invalid effect receipt; no latch write or signal retry: ' +
            String(error) +
            '\n'
        );
      }
      journal.append(success ? 'adapter_stdout_handoff' : 'adapter_handoff_unconfirmed', {
        observation_boundary: 'local_native_output',
        exit_code: result?.exitCode ?? null,
      });
      const delivered = success && result !== null && result.exitCode !== 2;
      if (delivered) dedup.commit(pending);
      const deadline = Date.now() + 350;
      const seen = new Set<string>();
      for (const offer of offers) {
        const key = JSON.stringify([offer.offerId, offer.recipient]);
        if (seen.has(key)) continue;
        seen.add(key);
        if (Date.now() >= deadline) {
          journal.diagnostics.push(
            '[caws runtime] remaining message offers deferred to expiry at settlement deadline\n'
          );
          break;
        }
        const settled = settleMessageOffer(
          join(selection.canonical, '.caws'),
          offer.offerId,
          offer.recipient,
          delivered && offer.action === 'selected' ? 'delivered' : 'released'
        );
        if (!settled.ok)
          journal.diagnostics.push(
            '[caws runtime] message offer settlement deferred to expiry: ' +
              JSON.stringify(settled.errors) +
              '\n'
          );
      }
      journal.append('adapter_finished', { exit_code: result?.exitCode ?? null });
      return journal.takeDiagnostics() + dedup.diagnostics.splice(0).join('');
    },
  };
}
