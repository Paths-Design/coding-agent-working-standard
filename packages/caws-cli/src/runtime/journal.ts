import { join } from 'node:path';
import { resolveExecutionWorkdir } from './execution-workdir';
import { readdirSync } from 'node:fs';
import type { RuntimeRequest } from './protocol';
import { nativeInputDigest } from './protocol';
import type { ActiveInvocationSelection } from './selection';
import type { HandlerObservation } from './composer';
import { appendOperationalRecord, ensureOperationalDirectory } from './operational-files';
import { MACHINE_EVENTS } from '../init/native-hook-identification';

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
    // The invocation journal retains progress; the renderer consumes outcomes.
    if (!safeSession(this.resolvedSessionId) || observation.stage === 'handler_started') return;
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
            status: observation.stage.replace(/^handler_/, ''),
            timestamp: new Date().toISOString(),
            timestamp_ms: Date.now(),
            observation_boundary: observation.stage,
            hook_event: this.request.payload.hook_event_name ?? this.request.event,
            tool_name: this.request.payload.tool_name ?? '',
            tool_use_id: this.request.payload.tool_use_id ?? '',
            ...(result
              ? {
                  stdout: Buffer.from(result.stdout).toString(),
                  stderr: Buffer.from(result.stderr).toString(),
                }
              : {}),
            ...fields,
          }) + '\n'
        )
      );
    } catch (error) {
      this.incomplete(error);
    }
  }
  /** Legacy reports share the handler's OS identity; they do not authenticate execution. */
  recordCompatibility(records: Uint8Array): void {
    if (this.disabled || !safeSession(this.resolvedSessionId) || records.byteLength === 0) return;
    if (records.byteLength > 2 * 1024 * 1024) {
      this.incomplete('Compatibility execution records exceed capture limit');
      return;
    }
    const seen = new Set<number>();
    const validated: { value: Record<string, unknown>; index: number }[] = [];
    const toolUseId = this.request.payload.tool_use_id ?? '';
    for (const line of Buffer.from(records).toString().split('\n')) {
      if (!line.trim()) continue;
      try {
        const row: unknown = JSON.parse(line);
        if (row === null || typeof row !== 'object' || Array.isArray(row))
          throw new Error('Compatibility execution record is not an object');
        const value = row as Record<string, unknown>;
        const index = this.selection.handlers.findIndex(
          (handler, selectedIndex) =>
            !seen.has(selectedIndex) &&
            handler.name === value.handler &&
            handler.path === value.path
        );
        const handler = this.selection.handlers[index];
        if (
          !handler ||
          value.session_id !== this.resolvedSessionId ||
          typeof value.timestamp !== 'string' ||
          !Number.isFinite(Date.parse(value.timestamp)) ||
          typeof value.stdout !== 'string' ||
          typeof value.stderr !== 'string' ||
          value.hook_event !== MACHINE_EVENTS[this.request.event] ||
          typeof value.tool_name !== 'string' ||
          typeof toolUseId !== 'string' ||
          value.tool_use_id !== toolUseId ||
          !(value.status === 'completed'
            ? Number.isInteger(value.exit_code) &&
              Number(value.exit_code) >= 0 &&
              Number(value.exit_code) <= 255
            : (value.status === 'missing' || value.status === 'reprieved') &&
              value.exit_code === null &&
              value.stdout === '' &&
              value.stderr === '')
        )
          throw new Error(
            'Compatibility execution record does not match its selected handler/session or result contract'
          );
        seen.add(index);
        validated.push({ value, index });
      } catch (error) {
        // Validate the entire capture before publishing: an injected first row
        // must not win over a duplicate genuine report later in the capture.
        this.incomplete(error);
        return;
      }
    }
    for (const { value, index } of validated) {
      const handler = this.selection.handlers[index]!;
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
              stage: 'handler_' + value.status,
              observation_boundary: 'unverified_compatibility_dispatcher_report',
              timestamp: value.timestamp,
              timestamp_ms: Date.parse(value.timestamp as string),
              session_id: this.resolvedSessionId,
              handler: handler.name,
              path: handler.path,
              handler_index: index,
              source_sha256: handler.sha256,
              source_digest_boundary: 'before_dispatch',
              status: value.status,
              exit_code: value.exit_code,
              stdout: value.stdout,
              stderr: value.stderr,
              hook_event: value.hook_event,
              tool_name: value.tool_name,
              tool_use_id: value.tool_use_id,
            }) + '\n'
          )
        );
      } catch (error) {
        this.incomplete(error);
      }
    }
  }
  takeDiagnostics(): string {
    return this.diagnostics.splice(0).join('');
  }
}
