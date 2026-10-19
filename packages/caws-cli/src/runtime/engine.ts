import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { TextDecoder } from 'node:util';
import type { AgentSurface } from '../init/hook-packs/types';
import { settleMessageOffer } from '../store/messages-store';
import { invocationEnvironment, resolveRuntimeProject } from './context';
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
import { InvocationJournal } from './journal';
import { AdvisoryDedup } from './advisory-dedup';
import { normalizeNativeResult } from './native-response';
import { resolveInvocationSelection, type ActiveInvocationSelection } from './selection';
import { encodeRuntimeResponse, type RuntimeRequest } from './protocol';
import type { NativeResult } from './types';

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

export interface PreparedRuntimeInvocation {
  readonly active: boolean;
  readonly budgetHome: string;
  readonly projectDigest: string | null;
  readonly sessionId: string | null;
  dispatch(): Promise<NativeResult>;
  acknowledgeHandoff(success: boolean): Promise<string>;
}

export async function prepareRuntimeInvocation(
  request: RuntimeRequest,
  signal: AbortSignal
): Promise<PreparedRuntimeInvocation> {
  const environment = invocationEnvironment(request.caller);
  for (const name of [
    'CAWS_HOOK_INVOCATION_FILE',
    'CAWS_HOOK_INVOCATION_METADATA',
    'CAWS_HOOK_EXECUTION_FILE',
    'CAWS_HOOK_SETTLEMENT_FILE',
    'CAWS_HANDLER_OFFER_FILE',
    'CAWS_MACHINE_LOG_DIR',
  ])
    delete environment[name];
  const home = environment.CAWS_HOME || (environment.HOME ? join(environment.HOME, '.caws') : '');
  if (!home || !isAbsolute(home))
    throw new Error('Runtime requires an absolute caller machine home');
  environment.CAWS_HOME = home;
  const context = await resolveRuntimeProject(
    request.payload,
    request.caller,
    request.deadlineEpochMs
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
      async dispatch() {
        if (used) throw new Error('Invocation dispatch is single-use');
        used = true;
        return {
          ...empty(),
          stderr: Buffer.from(
            context.status === 'inactive' && context.diagnostic ? context.diagnostic + '\n' : ''
          ),
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
  const options = { request, selection, environment: Object.freeze(environment), signal };
  let dispatched = false,
    acknowledged = false,
    result: NativeResult | null = null;
  let offers: readonly OfferMembership[] = [],
    pending: readonly PendingDedup[] = [];
  return {
    active: true,
    budgetHome: home,
    projectDigest: digest(selection.canonical),
    sessionId:
      identity.sessionId &&
      identity.sessionId !== 'unknown' &&
      Buffer.byteLength(identity.sessionId) <= 128 &&
      !identity.sessionId.includes('\0')
        ? identity.sessionId
        : null,
    async dispatch() {
      if (dispatched || acknowledged)
        throw new Error('Invocation dispatch is single-use and cannot resume after settlement');
      if (signal.aborted) throw signal.reason;
      dispatched = true;
      journal.append('dispatch_started');
      try {
        if (compatibilityRequired(request, selection, environment)) {
          const completed = await executeCompatibilityDispatch(options);
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
            Buffer.from(identity.diagnostic + journal.takeDiagnostics()),
          ]),
        })
      );
      encodeRuntimeResponse(request, native); // Refuse an unusable proposal before sending it.
      result = native;
      return native;
    },
    async acknowledgeHandoff(success) {
      if (acknowledged)
        throw new Error('Native handoff was already acknowledged; settlement is not retried');
      acknowledged = true;
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
