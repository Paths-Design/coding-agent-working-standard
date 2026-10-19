import type { ActiveInvocationSelection, SelectedHandler } from './selection';
import type { NativeResult } from './types';
import { truncateUtf8Prefix } from './utf8';
import { copyContainment, type ValidatedContainmentIntent } from './containment';

export interface OfferReference {
  readonly offerId: string;
  readonly recipient: string;
}
export interface HandlerResult extends NativeResult {
  readonly offers?: readonly OfferReference[];
  readonly containment?: ValidatedContainmentIntent;
}
export interface OfferMembership extends OfferReference {
  readonly handler: string;
  readonly selectedIndex: number;
  readonly action: 'selected' | 'released';
  readonly reason: string;
}
export interface PendingDedup {
  readonly handler: string;
  readonly selectedIndex: number;
  /** Original normalized card used by the session dedup lookup. */
  readonly text: string;
  /** Actual emitted member, including a truncation marker when applicable. */
  readonly emittedText: string;
}
export type HandlerEligibility =
  | { readonly status: 'run' }
  | { readonly status: 'reprieved' | 'runtime-disabled'; readonly reason: string };
export interface HandlerObservation {
  readonly stage: 'handler_started' | 'handler_completed' | 'handler_skipped' | 'handler_error';
  readonly handler: SelectedHandler;
  readonly selectedIndex: number;
  readonly result?: HandlerResult;
  readonly reason?: string;
}
export interface ComposerDependencies {
  execute(handler: SelectedHandler, selectedIndex: number): Promise<HandlerResult>;
  record(observation: HandlerObservation): void | Promise<void>;
  eligibility?(
    handler: SelectedHandler,
    selectedIndex: number
  ): HandlerEligibility | Promise<HandlerEligibility>;
  dedup?: { seen(handler: SelectedHandler, text: string): boolean | Promise<boolean> };
}
export interface ComposerOptions {
  readonly requestId?: string;
  readonly dryRun?: boolean;
  readonly dedupEnabled?: boolean;
  readonly advisoryBudgetBytes?: number;
  readonly cardShareDivisor?: number;
  readonly cardFloorBytes?: number;
  readonly signal?: AbortSignal;
}
export interface CompositionResult {
  readonly nativeResult: NativeResult;
  readonly containment: ValidatedContainmentIntent | null;
  readonly offers: readonly OfferMembership[];
  readonly pendingDedup: readonly PendingDedup[];
}

/** Carries released membership when execution fails before a composition can return. */
export class ComposerExecutionError extends Error {
  readonly offers: readonly OfferMembership[];
  readonly stderr: Uint8Array;
  constructor(
    message: string,
    readonly originalError: unknown,
    offers: readonly OfferMembership[],
    stderr: Uint8Array = new Uint8Array()
  ) {
    super(message);
    this.name = 'ComposerExecutionError';
    this.stderr = Buffer.from(stderr);
    this.offers = Object.freeze(
      offers.map((offer) =>
        Object.freeze({
          ...offer,
          action: 'released' as const,
          reason: 'dispatch did not complete',
        })
      )
    );
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function field(value: unknown, key: string): unknown {
  return object(value) && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}
function parse(bytes: Uint8Array): unknown {
  try {
    // Interpretation is explicit and lossy; untransformed transport remains bytes.
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return undefined;
  }
}
function priority(value: unknown): number {
  const top = field(value, 'decision');
  // jq's // falls back for null AND false; an empty string remains a decision.
  const decision =
    top === undefined || top === null || top === false
      ? field(field(value, 'hookSpecificOutput'), 'permissionDecision')
      : top;
  return decision === 'block' || decision === 'deny' ? 3 : decision === 'ask' ? 2 : 1;
}

/** Shared interpretation for completed and interrupted byte captures. */
export function isProtectiveCapture(stdout: Uint8Array): boolean {
  return priority(parse(stdout)) === 3;
}
function numberOption(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
/** Explicit legacy shell capture normalization, separate from the raw journal observation. */
export function normalizeCompositionCapture(stdout: Uint8Array): Buffer {
  let end = stdout.byteLength;
  while (end > 0 && stdout[end - 1] === 0x0a) end--;
  return Buffer.from(stdout.subarray(0, end));
}
function newline(stdout: Uint8Array): Buffer {
  return stdout.byteLength ? Buffer.concat([stdout, Buffer.from('\n')]) : Buffer.alloc(0);
}
function copyCompletion(
  completion: HandlerResult,
  containment: ValidatedContainmentIntent | null = null
): HandlerResult {
  return Object.freeze({
    ...(containment ? { containment } : {}),
    exitCode: completion.exitCode,
    stdout: Buffer.from(completion.stdout),
    stderr: Buffer.from(completion.stderr),
    offers: Object.freeze((completion.offers ?? []).map((offer) => Object.freeze({ ...offer }))),
  });
}
function cutCard(text: string, cap: number): string | null {
  const bytes = Buffer.from(text, 'utf8');
  const marker = (kept: number): string => `… [truncated: ${bytes.length - kept} bytes elided]`;
  let limit = Math.max(0, cap - Buffer.byteLength(marker(0), 'utf8'));
  let prefix: Buffer = Buffer.alloc(0);
  // Marker length can shrink only as its decimal elision count loses digits.
  for (let iteration = 0; iteration < 32; iteration++) {
    prefix = truncateUtf8Prefix(bytes, limit);
    const next = Math.max(0, cap - Buffer.byteLength(marker(prefix.length), 'utf8'));
    if (next === limit) break;
    limit = next;
  }
  if (prefix.length < 48) return null;
  const result = prefix.toString('utf8') + marker(prefix.length);
  return Buffer.byteLength(result, 'utf8') <= cap ? result : null;
}

/** Ordered composition only. Native handoff, dedup commit and offer settlement belong to the engine. */
export async function composeHandlers(
  selection: ActiveInvocationSelection,
  options: ComposerOptions,
  dependencies: ComposerDependencies
): Promise<CompositionResult> {
  const budget = numberOption(options.advisoryBudgetBytes, 32768);
  const divisor = Math.max(1, numberOption(options.cardShareDivisor, 4));
  const floor = numberOption(options.cardFloorBytes, 256);
  const offers: OfferMembership[] = [];
  const cards: PendingDedup[] = [];
  const stderr: Uint8Array[] = [];
  let maxExit = 0;
  let base: Buffer = Buffer.alloc(0);
  let basePriority = 0;
  let template: unknown;
  let cardBytes = 0;

  const diagnostic = (message: string): void => {
    stderr.push(Buffer.from(message + '\n', 'utf8'));
  };
  const record = async (observation: HandlerObservation): Promise<void> => {
    try {
      // A recorder can retain/mutate byte views. It never receives decision-owned bytes.
      await dependencies.record(
        Object.freeze({
          ...observation,
          handler: Object.freeze({
            ...observation.handler,
            args: Object.freeze([...observation.handler.args]),
          }),
          ...(observation.result ? { result: copyCompletion(observation.result) } : {}),
        })
      );
    } catch (error) {
      diagnostic('[composer journal] incomplete: ' + String(error));
    }
  };
  const result = (
    exitCode: number,
    stdout: Uint8Array,
    deliveredCards: boolean,
    containment: ValidatedContainmentIntent | null = null
  ): CompositionResult => {
    const admitted = deliveredCards
      ? new Set(cards.map((card) => card.selectedIndex))
      : new Set<number>();
    const memberships = offers.map((offer) =>
      Object.freeze({
        ...offer,
        action: admitted.has(offer.selectedIndex) ? ('selected' as const) : ('released' as const),
        reason: admitted.has(offer.selectedIndex)
          ? 'advisory selected in final output'
          : 'advisory absent from final output',
      })
    );
    // Even composed advice cannot consume a retry until a non-refused native handoff.
    const pending =
      deliveredCards && !options.dryRun && options.dedupEnabled !== false && exitCode < 2
        ? cards.filter(
            (card) => !offers.some((offer) => offer.selectedIndex === card.selectedIndex)
          )
        : [];
    return Object.freeze({
      containment,
      nativeResult: Object.freeze({
        exitCode,
        stdout: Buffer.from(stdout),
        stderr: Buffer.concat(stderr),
      }),
      offers: Object.freeze(memberships),
      pendingDedup: Object.freeze(pending),
    });
  };

  for (let index = 0; index < selection.handlers.length; index++) {
    const handler = selection.handlers[index];
    if (!handler)
      throw new ComposerExecutionError(
        'Selected handler is absent',
        undefined,
        offers,
        Buffer.concat(stderr)
      );
    if (options.signal?.aborted)
      throw new ComposerExecutionError(
        'Hook composition was cancelled',
        options.signal.reason,
        offers,
        Buffer.concat(stderr)
      );
    let eligibility: HandlerEligibility = { status: 'run' };
    try {
      eligibility = (await dependencies.eligibility?.(handler, index)) ?? eligibility;
    } catch (error) {
      diagnostic(`[${handler.name}] eligibility unavailable; running guard: ${String(error)}`);
    }
    if (options.signal?.aborted)
      throw new ComposerExecutionError(
        'Hook composition was cancelled',
        options.signal.reason,
        offers,
        Buffer.concat(stderr)
      );
    if (eligibility.status !== 'run') {
      if (
        eligibility.status !== 'reprieved' &&
        (eligibility.status !== 'runtime-disabled' || selection.event !== 'post_tool_use')
      ) {
        throw new ComposerExecutionError(
          'Invalid handler skip for ' + handler.name,
          eligibility,
          offers,
          Buffer.concat(stderr)
        );
      }
      await record({
        stage: 'handler_skipped',
        handler,
        selectedIndex: index,
        reason: eligibility.status + ': ' + eligibility.reason,
      });
      diagnostic(`[${handler.name}] ${eligibility.status}: ${eligibility.reason}`);
      continue;
    }
    await record({ stage: 'handler_started', handler, selectedIndex: index });
    if (options.signal?.aborted)
      throw new ComposerExecutionError(
        'Hook composition was cancelled',
        options.signal.reason,
        offers,
        Buffer.concat(stderr)
      );
    let completion: HandlerResult;
    try {
      const raw = await dependencies.execute(handler, index);
      if (
        !Number.isInteger(raw.exitCode) ||
        raw.exitCode < 0 ||
        raw.exitCode > 255 ||
        !(raw.stdout instanceof Uint8Array) ||
        !(raw.stderr instanceof Uint8Array)
      ) {
        throw new Error('Invalid handler execution result');
      }
      const containment = copyContainment(raw.containment, selection, handler, options.requestId);
      if (raw.containment && !containment)
        diagnostic(
          `[${handler.name}] containment ignored: executor provenance does not match this invocation`
        );
      completion = copyCompletion(raw, containment);
    } catch (error) {
      await record({
        stage: 'handler_error',
        handler,
        selectedIndex: index,
        reason: String(error),
      });
      throw new ComposerExecutionError(
        `Handler ${handler.name} could not execute: ${String(error)}`,
        error,
        offers,
        Buffer.concat(stderr)
      );
    }
    await record({ stage: 'handler_completed', handler, selectedIndex: index, result: completion });
    for (const offer of completion.offers ?? [])
      offers.push(
        Object.freeze({
          ...offer,
          handler: handler.name,
          selectedIndex: index,
          action: 'released',
          reason: 'handler output not selected',
        })
      );
    const lines = normalizeCompositionCapture(completion.stderr);
    let lineStart = 0;
    for (let offset = 0; offset <= lines.byteLength; offset++) {
      if (offset !== lines.byteLength && lines[offset] !== 0x0a) continue;
      if (offset > lineStart)
        stderr.push(
          Buffer.concat([
            Buffer.from(`[${handler.name}] `, 'utf8'),
            lines.subarray(lineStart, offset),
            Buffer.from('\n'),
          ])
        );
      lineStart = offset + 1;
    }
    let exitCode = completion.exitCode;
    if (options.dryRun && exitCode !== 0) {
      diagnostic(`[DRY-RUN] ${handler.name} would have exited ${exitCode}`);
      exitCode = 0;
    }
    const output = normalizeCompositionCapture(completion.stdout);
    const parsed = parse(output);
    const rank = priority(parsed);
    if (output.byteLength && rank === 3)
      return result(
        2,
        newline(output),
        false,
        options.dryRun ? null : (completion.containment ?? null)
      );
    if (output.byteLength) {
      const specific = field(parsed, 'hookSpecificOutput');
      const advisory = field(specific, 'additionalContext');
      const text = typeof advisory === 'string' ? advisory.replace(/\n+$/, '') : '';
      if (text) {
        let seen = false;
        if (options.dedupEnabled !== false && !completion.offers?.length) {
          try {
            seen = (await dependencies.dedup?.seen(handler, text)) ?? false;
          } catch (error) {
            diagnostic(`[${handler.name}] advisory dedup unavailable; emitting: ${String(error)}`);
          }
        }
        if (seen)
          diagnostic(
            `[${handler.name}] advisory suppressed: identical text already surfaced in this session`
          );
        else {
          const remaining = Math.max(0, budget - cardBytes - (cards.length ? 2 : 0));
          const length = Buffer.byteLength(text, 'utf8');
          const cap = Math.max(
            0,
            Math.min(Math.floor(budget / divisor), remaining - floor, remaining)
          );
          const emittedText = length <= remaining ? text : cutCard(text, cap);
          if (emittedText !== null) {
            if (template === undefined) template = parsed;
            cards.push(
              Object.freeze({ handler: handler.name, selectedIndex: index, text, emittedText })
            );
            cardBytes += Buffer.byteLength(emittedText, 'utf8') + (cards.length > 1 ? 2 : 0);
            if (emittedText !== text)
              diagnostic(`[${handler.name}] advisory truncated to fit remaining budget`);
          } else
            diagnostic(
              `[${handler.name}] optional advisory omitted: card ${length} bytes exceeds available budget`
            );
        }
      } else if (
        object(specific) &&
        Object.prototype.hasOwnProperty.call(specific, 'additionalContext')
      ) {
        diagnostic(
          `[${handler.name}] optional advisory omitted: additionalContext must be a non-empty string`
        );
      } else if (rank >= basePriority) {
        base = output;
        basePriority = rank;
      }
    }
    if (selection.event === 'pre_tool_use' && exitCode === 2)
      return result(2, newline(base), false);
    maxExit = Math.max(maxExit, exitCode);
  }
  if (selection.surface === 'kimi-code' && maxExit !== 0) maxExit = 2;
  if (options.signal?.aborted && maxExit !== 2) {
    throw new ComposerExecutionError(
      'Hook composition was cancelled',
      options.signal.reason,
      offers,
      Buffer.concat(stderr)
    );
  }
  const exitCode = options.dryRun ? 0 : maxExit;
  let stdout = base;
  let deliveredCards = false;
  if (cards.length) {
    const envelope = base.byteLength ? parse(base) : template;
    const specific = field(envelope, 'hookSpecificOutput');
    if (object(envelope) && object(specific)) {
      stdout = Buffer.from(
        JSON.stringify({
          ...envelope,
          hookSpecificOutput: {
            ...specific,
            additionalContext: cards.map((card) => card.emittedText).join('\n\n'),
          },
        }),
        'utf8'
      );
      deliveredCards = true;
    } else
      diagnostic(
        '[composer] optional advisories omitted: selected control envelope cannot carry additionalContext'
      );
  }
  return result(exitCode, newline(stdout), deliveredCards && exitCode !== 2);
}
