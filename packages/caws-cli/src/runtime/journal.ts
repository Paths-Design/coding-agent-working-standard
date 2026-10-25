import { join } from 'node:path';
import { resolveExecutionWorkdir } from './execution-workdir';
import { readdirSync } from 'node:fs';
import type { RuntimeRequest } from './protocol';
import { nativeInputDigest } from './protocol';
import type { ActiveInvocationSelection } from './selection';
import type { HandlerObservation } from './composer';
import { appendOperationalRecord, ensureOperationalDirectory } from './operational-files';

const safeSession = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 128 &&
  !/[^A-Za-z0-9_.@:-]/.test(value) &&
  value !== '.' &&
  value !== '..';

function sessionDirectory(canonical: string, sid: string): string {
  const directory = join(canonical, '.caws/sessions', sid);
  ensureOperationalDirectory(canonical, directory);
  // Preserve the existing consumer layout, but never append through a
  // case-insensitive alias of another logical session's directory.
  if (!readdirSync(join(canonical, '.caws/sessions')).includes(sid))
    throw new Error('Session directory aliases another session identity');
  return directory;
}

export class InvocationJournal {
  private disabled = false;
  private path: string | null = null;
  private readonly metadata: Readonly<Record<string, unknown>>;
  readonly diagnostics: string[] = [];
  constructor(
    readonly request: RuntimeRequest,
    readonly selection: ActiveInvocationSelection,
    readonly resolvedSessionId: string | null
  ) {
    this.metadata = Object.freeze({
      schema: 'caws.hook_invocation.v1',
      invocation_id: request.id,
      surface: request.surface,
      event: request.event,
      runtime_digest: request.runtimeDigest,
      input_sha256: nativeInputDigest(request),
      delivery: 'not_observed',
    });
    try {
      const sid = request.payload.session_id;
      if (!safeSession(sid))
        throw new Error('No safe supplied session identity for invocation journal');
      this.path = join(
        sessionDirectory(selection.canonical, sid),
        'hook-invocations',
        request.id + '.jsonl'
      );
      const execution = resolveExecutionWorkdir(request.payload, request.event);
      this.append(
        'invocation_started',
        {
          dispatch_cwd: execution.status === 'resolved' ? execution.path : selection.checkout,
          session_cwd: request.payload.cwd,
          execution_workdir_resolution: execution,
          resolved_session_id: resolvedSessionId,
          selected_handlers: selection.handlers,
          configuration: selection.configuration,
        },
        true
      );
    } catch (error) {
      this.path = null;
      this.incomplete(error);
    }
  }
  private incomplete(error: unknown): void {
    this.diagnostics.push('[caws invocation record] incomplete: ' + String(error) + '\n');
  }
  append(stage: string, fields: Readonly<Record<string, unknown>> = {}, exclusive = false): void {
    if (!this.path) return;
    try {
      const bytes = Buffer.from(
        JSON.stringify({ ...this.metadata, stage, timestamp_ms: Date.now(), ...fields }) + '\n'
      );
      appendOperationalRecord(this.selection.canonical, this.path, bytes, exclusive);
    } catch (error) {
      if (exclusive) {
        this.path = null;
        this.disabled = true;
      }
      this.incomplete(error);
    }
  }
  record(observation: HandlerObservation): void {
    if (this.disabled) return;
    const result = observation.result;
    const fields = {
      handler: observation.handler.entry,
      path: observation.handler.path,
      handler_index: observation.selectedIndex,
      source_sha256: observation.handler.sha256,
      source_digest_boundary: 'before_dispatch',
      session_id: this.resolvedSessionId,
      ...(observation.reason ? { reason: observation.reason } : {}),
      ...(result
        ? {
            exit_code: result.exitCode,
            stdout_base64: Buffer.from(result.stdout).toString('base64'),
            stderr_base64: Buffer.from(result.stderr).toString('base64'),
            offers: result.offers ?? [],
          }
        : {}),
    };
    this.append(observation.stage, fields);
    if (!safeSession(this.resolvedSessionId)) return;
    try {
      const file = join(
        sessionDirectory(this.selection.canonical, this.resolvedSessionId),
        'hook-events.jsonl'
      );
      appendOperationalRecord(
        this.selection.canonical,
        file,
        Buffer.from(
          JSON.stringify({
            ...this.metadata,
            schema: 'caws.hook_execution.v1',
            stage: observation.stage,
            timestamp_ms: Date.now(),
            observation_boundary: observation.stage,
            ...fields,
          }) + '\n'
        )
      );
    } catch (error) {
      this.incomplete(error);
    }
  }
  takeDiagnostics(): string {
    return this.diagnostics.splice(0).join('');
  }
}
