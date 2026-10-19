import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  accessSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { TextDecoder } from 'node:util';
import { MACHINE_EVENTS } from '../init/native-hook-identification';
import { assertMachinePath } from '../init/machine-paths';
import type { ComposerDependencies, HandlerResult, OfferReference } from './composer';
import type { RuntimeRequest } from './protocol';
import type { ActiveInvocationSelection, SelectedHandler } from './selection';
import { tryExecuteStockHandler } from './stock-handlers';
import { CONTAINMENT_ENV, createContainmentCapability } from './containment';
import {
  enrichObjectJson,
  objectMemberJson,
  parseJsonSource,
  type JsonSource,
} from './json-custody';

export const HANDLER_CAPTURE_LIMIT_BYTES = 2 * 1024 * 1024;
const OFFER_LIMIT_BYTES = 64 * 1024;
export interface HandlerExecutorOptions {
  readonly request: RuntimeRequest;
  readonly selection: ActiveInvocationSelection;
  readonly environment: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}
export interface CompatibilityDispatchResult extends HandlerResult {
  readonly offerReceipts: Uint8Array;
  readonly executionRecords: Uint8Array;
}
/** An interrupted observation is not a completed handler result. */
export class HandlerExecutionError extends Error {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly offers: readonly OfferReference[];
  readonly offerReceipts: Uint8Array;
  readonly executionRecords: Uint8Array;
  constructor(
    message: string,
    stdout: Uint8Array = new Uint8Array(),
    stderr: Uint8Array = new Uint8Array(),
    offers: readonly OfferReference[] = [],
    offerReceipts: Uint8Array = new Uint8Array(),
    executionRecords: Uint8Array = new Uint8Array(),
    readonly completedExitCode?: number
  ) {
    super(message);
    this.name = 'HandlerExecutionError';
    this.stdout = Buffer.from(stdout);
    this.stderr = Buffer.from(stderr);
    this.offers = Object.freeze(offers.map((offer) => Object.freeze({ ...offer })));
    this.offerReceipts = Buffer.from(offerReceipts);
    this.executionRecords = Buffer.from(executionRecords);
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const errorText = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

/** jq's receipt stream accepts successive JSON objects, not only one NDJSON line. */
function boundedFile(file: string, maximum: number): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum)
      throw new Error('Handler receipt exceeds its regular-file envelope');
    const bytes = Buffer.alloc(maximum + 1);
    let count = 0;
    while (count < bytes.length) {
      const size = readSync(fd, bytes, count, bytes.length - count, null);
      if (!size) break;
      count += size;
    }
    if (count > maximum) throw new Error('Handler receipt exceeds byte limit');
    return bytes.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}
function offersFrom(file: string, compatibility = false): OfferReference[] {
  const bytes = boundedFile(file, OFFER_LIMIT_BYTES);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const offers: OfferReference[] = [];
  const latest = new Map<string, { recipient: string; action: string }>();
  let index = 0;
  while (index < text.length) {
    while (/\s/.test(text[index] ?? '') && index < text.length) index++;
    if (index >= text.length) break;
    const start = index;
    let depth = 0,
      quoted = false;
    const compound = text[index] === '{' || text[index] === '[';
    for (; index < text.length; index++) {
      const char = text[index]!;
      if (quoted) {
        if (char === '\\') index++;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') {
        if (--depth === 0) {
          index++;
          break;
        }
      } else if (!compound && depth === 0 && /\s/.test(char)) break;
    }
    const value: unknown = JSON.parse(text.slice(start, index));
    if (object(value) && typeof value.recipient === 'string') {
      const id = compatibility ? value.offer_id : value.id;
      if (typeof id === 'string') {
        if (!compatibility) offers.push({ offerId: id, recipient: value.recipient });
        else if (value.action === 'selected' || value.action === 'released')
          latest.set(id, { recipient: value.recipient, action: value.action });
      }
    }
  }
  return compatibility
    ? [...latest.entries()]
        .filter(([, value]) => value.action === 'selected')
        .map(([offerId, value]) => ({ offerId, recipient: value.recipient }))
    : offers;
}

function childEnvironment(
  options: HandlerExecutorOptions,
  payload: string,
  source: JsonSource,
  payloadFile: string,
  receiptFile: string,
  executionFile: string,
  compatibility: boolean
): Record<string, string> {
  const { request, selection } = options;
  const env = Object.fromEntries(
    Object.entries(options.environment).filter(
      ([name]) => !name.startsWith('HOOK_') && !name.startsWith('GIT_') && name !== CONTAINMENT_ENV
    )
  );
  const tool = object(request.payload.tool_input) ? request.payload.tool_input : {};
  const scalar = (value: unknown, fallback = ''): string =>
    typeof value === 'string' && value ? value : fallback;
  const threshold = /^\d+$/.test(env.CAWS_HOOK_INLINE_PAYLOAD_MAX_BYTES ?? '')
    ? Number(env.CAWS_HOOK_INLINE_PAYLOAD_MAX_BYTES)
    : 131072;
  const inline = Buffer.byteLength(payload) < threshold;
  const startup = join(selection.runtimeDirectory, 'handler-env.sh');
  Object.assign(env, {
    CAWS_PROJECT_DIR: selection.checkout,
    CAWS_MACHINE_POLICY_ROOT: selection.canonical,
    CAWS_MACHINE_RUNTIME: '1',
    CAWS_SYSTEM_RUNTIME: selection.configuration === 'system' ? '1' : '0',
    CAWS_AGENT_SURFACE: selection.surface,
    CAWS_ADAPTER_RUNTIME_DIGEST: selection.runtimeDigest,
    CAWS_SHARED_LIB_DIR: join(selection.runtimeDirectory, 'lib'),
    CAWS_MACHINE_ADAPTER_LIB_DIR: join(
      selection.runtimeDirectory,
      'surfaces',
      selection.surface,
      'lib'
    ),
    CAWS_MACHINE_LIBRARIES: JSON.stringify(
      Object.fromEntries(
        Object.entries(selection.libraryOverrides).map(([name, path]) => [
          name,
          relative(selection.canonical, path),
        ])
      )
    ),
    CAWS_MACHINE_HANDLERS: JSON.stringify(selection.overrides),
    CAWS_SESSION_TRANSCRIPT_ADAPTER: selection.transcriptAdapter?.path ?? '',
    HOOKS_DIR: selection.hooksDirectory,
    CAWS_PRIOR_BASH_ENV:
      env.BASH_ENV === startup ? (env.CAWS_PRIOR_BASH_ENV ?? '') : (env.BASH_ENV ?? ''),
    BASH_ENV: startup,
    CAWS_HANDLER_OFFER_FILE: receiptFile,
    HOOK_PAYLOAD_FILE: payloadFile,
    HOOK_PAYLOAD_TRUNCATED: inline ? '0' : '1',
    // The selected parser keeps full JSON local; children receive stdin/file bytes.
    HOOK_TOOL_INPUT_JSON: inline ? objectMemberJson(source, 'tool_input') : '',
    HOOK_TOOL_RESPONSE_JSON: inline ? objectMemberJson(source, 'tool_response') : '',
    HOOK_TOOL_NAME: scalar(request.payload.tool_name),
    HOOK_FILE_PATH: scalar(tool.file_path),
    HOOK_COMMAND: scalar(tool.command),
    HOOK_CWD: scalar(request.payload.cwd),
    HOOK_SESSION_ID: scalar(request.payload.session_id, 'unknown'),
    HOOK_TRANSCRIPT_PATH: scalar(request.payload.transcript_path),
    HOOK_EVENT_NAME: MACHINE_EVENTS[request.event],
    HOOK_MODEL: scalar(request.payload.model),
    HOOK_SOURCE: scalar(request.payload.source),
    HOOK_PERMISSION_MODE: scalar(request.payload.permission_mode, 'default'),
    HOOK_TOOL_USE_ID: scalar(request.payload.tool_use_id),
    HOOK_STOP_HOOK_ACTIVE: request.payload.stop_hook_active ? '1' : '0',
    PYTHONDONTWRITEBYTECODE: '1',
  });
  if (compatibility) {
    // The real dispatcher must run its selected parser and own its handler preload.
    for (const name of Object.keys(env)) if (name.startsWith('HOOK_')) delete env[name];
    delete env.CAWS_HANDLER_OFFER_FILE;
    delete env.CAWS_PRIOR_BASH_ENV;
    if (options.environment.BASH_ENV !== undefined) env.BASH_ENV = options.environment.BASH_ENV;
    else delete env.BASH_ENV;
    env.CAWS_HOOK_SETTLEMENT_FILE = receiptFile;
    env.CAWS_HOOK_EXECUTION_FILE = executionFile;
  }
  return env;
}

function verifyHandler(handler: SelectedHandler, selection: ActiveInvocationSelection): void {
  if (!isAbsolute(handler.path))
    throw new HandlerExecutionError('Selected handler path must be absolute');
  const root = handler.kind === 'stock' ? selection.runtimeDirectory : selection.canonical;
  assertMachinePath(root, handler.path);
  if (!lstatSync(handler.path).isFile())
    throw new HandlerExecutionError('Required handler is not a regular file');
  accessSync(handler.path, constants.X_OK);
  if (createHash('sha256').update(readFileSync(handler.path)).digest('hex') !== handler.sha256)
    throw new HandlerExecutionError('Selected handler changed after selection');
}

async function runChild(
  command: { path: string; args: readonly string[] },
  options: HandlerExecutorOptions,
  compatibility: boolean,
  selectedHandler?: SelectedHandler
): Promise<CompatibilityDispatchResult> {
  const { selection, request, signal } = options;
  const temporaryRoot = options.environment.TMPDIR || '/tmp';
  if (!isAbsolute(temporaryRoot))
    throw new HandlerExecutionError('Handler temporary directory must be absolute');
  const directory = mkdtempSync(join(temporaryRoot, 'caws-native-handler-'));
  let inputFd: number | undefined;
  try {
    const source = parseJsonSource(request.inputJson || '{}');
    const payload = enrichObjectJson(source, 'hook_event_name', MACHINE_EVENTS[request.event]);
    const payloadFile = join(directory, 'payload.json');
    const receiptFile = join(directory, 'offer.json');
    const executionFile = join(directory, 'execution.jsonl');
    writeFileSync(payloadFile, payload, { mode: 0o600, flag: 'wx' });
    writeFileSync(receiptFile, '', { mode: 0o600, flag: 'wx' });
    writeFileSync(executionFile, '', { mode: 0o600, flag: 'wx' });
    inputFd = openSync(payloadFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const env = childEnvironment(
      options,
      payload,
      source,
      payloadFile,
      receiptFile,
      executionFile,
      compatibility
    );
    const containment =
      !compatibility && selectedHandler
        ? createContainmentCapability({ ...options, handler: selectedHandler }, directory)
        : null;
    if (containment) env[CONTAINMENT_ENV] = containment.file;
    const startup = join(selection.runtimeDirectory, 'handler-env.sh');
    assertMachinePath(selection.runtimeDirectory, startup);
    if (!compatibility && !lstatSync(startup).isFile())
      throw new HandlerExecutionError('Required handler startup library is missing');
    return await new Promise<CompatibilityDispatchResult>((accept, reject) => {
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      let observedExitCode: number | undefined;
      let bytes = 0,
        settled = false;
      const child = spawn(command.path, [...command.args], {
        cwd: selection.checkout,
        env,
        stdio: [inputFd!, 'pipe', 'pipe'],
        detached: false,
      });
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      };
      const failure = (reason: string, completedExitCode = observedExitCode): void => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill('SIGKILL');
        child.stdout?.destroy();
        child.stderr?.destroy();
        let offers: OfferReference[] = [];
        try {
          offers = offersFrom(receiptFile, compatibility);
        } catch {
          /* Expiry keeps an unreadable receipt retryable. */
        }
        let offerReceipts: Uint8Array = new Uint8Array(),
          executionRecords: Uint8Array = new Uint8Array();
        try {
          offerReceipts = boundedFile(receiptFile, OFFER_LIMIT_BYTES);
        } catch {
          /* Error remains independently visible. */
        }
        try {
          executionRecords = boundedFile(executionFile, HANDLER_CAPTURE_LIMIT_BYTES);
        } catch {
          /* Error remains independently visible. */
        }
        reject(
          new HandlerExecutionError(
            reason,
            Buffer.concat(stdout),
            Buffer.concat(stderr),
            offers,
            offerReceipts,
            executionRecords,
            completedExitCode
          )
        );
      };
      const abort = (): void => failure('Handler invocation cancelled');
      const collect =
        (chunks: Buffer[]) =>
        (chunk: Buffer): void => {
          if (settled) return;
          const remaining = Math.max(0, HANDLER_CAPTURE_LIMIT_BYTES - bytes);
          chunks.push(Buffer.from(chunk.subarray(0, remaining)));
          bytes += chunk.length;
          if (bytes > HANDLER_CAPTURE_LIMIT_BYTES) failure('Handler output exceeds byte limit');
        };
      child.stdout?.on('data', collect(stdout));
      child.stderr?.on('data', collect(stderr));
      child.once('error', (error) => failure(`Handler execution failed: ${error.message}`));
      child.once('exit', (code) => {
        if (code !== null) observedExitCode = code;
      });
      child.once('close', (code, terminationSignal) => {
        if (settled) return;
        if (code === null) {
          failure(`Handler terminated by ${terminationSignal ?? 'unknown signal'}`);
          return;
        }
        let offers: OfferReference[];
        let offerReceipts: Buffer, executionRecords: Buffer;
        try {
          offers = offersFrom(receiptFile, compatibility);
          offerReceipts = boundedFile(receiptFile, OFFER_LIMIT_BYTES);
          executionRecords = boundedFile(executionFile, HANDLER_CAPTURE_LIMIT_BYTES);
        } catch (error) {
          failure(`Handler offer receipt could not be captured: ${errorText(error)}`, code);
          return;
        }
        const completed = {
          exitCode: code,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        };
        const captured = containment?.consume(completed);
        settled = true;
        cleanup();
        accept({
          exitCode: code,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat([completed.stderr, Buffer.from(captured?.diagnostic ?? '')]),
          ...(captured?.intent ? { containment: captured.intent } : {}),
          offers,
          offerReceipts,
          executionRecords,
        });
      });
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => failure('Handler deadline expired'),
        Math.max(1, request.deadlineEpochMs - Date.now())
      );
      if (signal.aborted) abort();
    });
  } catch (error) {
    if (error instanceof HandlerExecutionError) throw error;
    throw new HandlerExecutionError(`Handler setup failed: ${errorText(error)}`);
  } finally {
    if (inputFd !== undefined) closeSync(inputFd);
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      /* Cleanup must never erase a completed refusal. */
    }
  }
}

export function createHandlerExecutor(
  options: HandlerExecutorOptions
): ComposerDependencies['execute'] {
  const environment = Object.freeze(
    Object.fromEntries(
      Object.entries(options.environment).filter(
        ([name]) =>
          !name.startsWith('GIT_') && !name.startsWith('HOOK_') && name !== CONTAINMENT_ENV
      )
    )
  );
  const owned = { ...options, environment };
  if (
    options.request.surface !== options.selection.surface ||
    options.request.event !== options.selection.event ||
    options.request.runtimeDigest !== options.selection.runtimeDigest
  )
    throw new HandlerExecutionError('Invocation selection does not match request');
  return async (handler, selectedIndex) => {
    const expected = owned.selection.handlers[selectedIndex];
    if (
      !expected ||
      expected.path !== handler.path ||
      expected.entry !== handler.entry ||
      expected.sha256 !== handler.sha256
    )
      throw new HandlerExecutionError('Handler is outside the ordered invocation selection');
    if (owned.signal.aborted) throw new HandlerExecutionError('Handler invocation cancelled');
    if (Date.now() >= owned.request.deadlineEpochMs)
      throw new HandlerExecutionError('Handler deadline expired');
    verifyHandler(expected, owned.selection);
    const result = tryExecuteStockHandler(expected, owned);
    return result ?? runChild({ path: expected.path, args: expected.args }, owned, false, expected);
  };
}

/** Selected custom core libraries own the whole legacy dispatcher, not individual builtin calls. */
export async function executeCompatibilityDispatch(
  options: HandlerExecutorOptions
): Promise<CompatibilityDispatchResult> {
  if (options.signal.aborted) throw new HandlerExecutionError('Handler invocation cancelled');
  if (Date.now() >= options.request.deadlineEpochMs)
    throw new HandlerExecutionError('Handler deadline expired');
  if (
    options.request.surface !== options.selection.surface ||
    options.request.event !== options.selection.event ||
    options.request.runtimeDigest !== options.selection.runtimeDigest
  )
    throw new HandlerExecutionError('Invocation selection does not match request');
  for (const handler of options.selection.handlers) verifyHandler(handler, options.selection);
  const dispatcher = join(options.selection.runtimeDirectory, 'dispatch.sh');
  assertMachinePath(options.selection.runtimeDirectory, dispatcher);
  if (!lstatSync(dispatcher).isFile())
    throw new HandlerExecutionError('Required compatibility dispatcher is missing');
  return runChild(
    {
      path: '/bin/bash',
      args: [
        dispatcher,
        options.selection.surface,
        options.selection.event,
        options.selection.hooksDirectory,
        ...options.selection.handlers.map((handler) => handler.entry),
      ],
    },
    { ...options, environment: Object.freeze({ ...options.environment }) },
    true
  );
}
