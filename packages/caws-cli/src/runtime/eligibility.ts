import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { TextDecoder } from 'node:util';
import type { HandlerEligibility } from './composer';
import type { SelectedHandler } from './selection';
import type { HookEvent } from './types';
import { readOperationalFile } from './operational-files';
import { parseReprieveExpiry, serializeReprieveMatch } from './reprieve-reader';

export interface EligibilityContext {
  readonly home: string;
  readonly canonical: string;
  readonly vendorDirectory: string;
  readonly sessionId: string | null;
  readonly event: HookEvent;
  readonly environment: Readonly<Record<string, string>>;
  readonly now?: () => number;
}
const present = (file: string): boolean => {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};
const utf8 = (value: string): boolean => Buffer.from(value, 'utf8').toString('utf8') === value;

export function handlerEligibility(
  handler: SelectedHandler,
  context: EligibilityContext
): HandlerEligibility {
  if (
    context.event === 'post_tool_use' &&
    (context.environment.CAWS_DISABLED_HANDLERS ?? '').split(':').includes(handler.name)
  )
    return { status: 'runtime-disabled', reason: 'PostToolUse runtime disable list' };
  const sid = context.sessionId;
  if (
    !sid ||
    sid === 'unknown' ||
    ![sid, handler.name, context.home, context.canonical, context.vendorDirectory].every(utf8)
  )
    return { status: 'run' };
  try {
    const safe = Buffer.from(sid, 'utf8')
      .toString('latin1')
      .replace(/[^A-Za-z0-9._-]/g, '_');
    const machine = join(context.home, 'state/sessions', safe, 'guard-reprieve-' + safe + '.json');
    const legacy = join(
      context.canonical,
      context.vendorDirectory,
      'hooks/state',
      'guard-reprieve-' + safe + '.json'
    );
    // Invalid machine presence must shadow a valid legacy grant.
    const selected = present(machine) ? machine : legacy;
    const root = selected === machine ? context.home : context.canonical;
    // Preserve the legacy reader's immediate ancestry restriction as well.
    let ancestor = selected;
    for (let index = 0; index < 5; index++, ancestor = dirname(ancestor))
      if (fs.lstatSync(ancestor).isSymbolicLink()) return { status: 'run' };
    const row: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        readOperationalFile(root, selected, 65_536)
      )
    );
    if (!row || typeof row !== 'object' || Array.isArray(row)) return { status: 'run' };
    const record = row as Record<string, unknown>;
    if (
      record.session_id !== sid ||
      Object.hasOwn(record, 'revoked_at') ||
      !['created_at', 'approved_by', 'reason'].every(
        (key) => typeof record[key] === 'string' && (record[key] as string).length > 0
      ) ||
      !Array.isArray(record.handlers) ||
      record.handlers.some((value) => typeof value !== 'string') ||
      !record.handlers.includes(handler.name)
    )
      return { status: 'run' };
    if (
      record.repo_root !== undefined &&
      record.repo_root !== null &&
      (typeof record.repo_root !== 'string' ||
        !record.repo_root ||
        !utf8(record.repo_root) ||
        fs.realpathSync(record.repo_root) !== fs.realpathSync(context.canonical))
    )
      return { status: 'run' };
    const expiresAt = record.expires_at;
    const expires = parseReprieveExpiry(expiresAt);
    if (
      typeof expiresAt !== 'string' ||
      expires === undefined ||
      serializeReprieveMatch({ expiresAt, reason: record.reason as string }) === undefined
    )
      return { status: 'run' };
    // Read and validate each handler's current record. Reserve the clock's
    // current millisecond, matching the shell reader without admitting late.
    const milliseconds = context.now?.() ?? Date.now();
    if (!Number.isSafeInteger(milliseconds) || expires < (BigInt(milliseconds) + 1n) * 1000n)
      return { status: 'run' };
    return {
      status: 'reprieved',
      reason: 'Session reprieve until ' + String(record.expires_at) + ': ' + String(record.reason),
    };
  } catch {
    return { status: 'run' };
  }
}
