// Waivers store.
//
// Loads every `*.yaml` / `*.yml` file directly under `.caws/waivers/`,
// hands each source to the kernel's `validateWaiver`, and collects the
// results.
//
// Discipline (mirrors specs-store):
//   - Missing `.caws/waivers/` → `{ waivers: [], diagnostics: [] }`.
//   - Non-YAML files → soft `non_yaml_skipped` diagnostic.
//   - Invalid waiver file → diagnostic, valid waivers still load.
//   - Duplicate waiver id → diagnostic; first occurrence wins.
//   - Filename should equal `<id>.yaml`; mismatch → diagnostic (info).
//   - Writes are atomic via writeFileAtomic.

import * as fs from 'fs';
import * as path from 'path';

import {
  isOk,
  diagnostic,
  validateWaiver,
  err,
  ok,
  type Diagnostic,
  type Result,
  type Waiver,
} from '@paths.design/caws-kernel';

import { writeFileAtomic } from './atomic-write';
import { storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';
import { readYamlFile } from './yaml-store';

export interface WaiversLoadResult {
  readonly waivers: readonly Waiver[];
  readonly diagnostics: readonly Diagnostic[];
}

function isYamlPath(name: string): boolean {
  return name.endsWith('.yaml') || name.endsWith('.yml');
}

function waiversDirPath(cawsDir: string): string {
  return path.join(cawsDir, 'waivers');
}

function waiverFilePath(cawsDir: string, id: string): string {
  return path.join(waiversDirPath(cawsDir), `${id}.yaml`);
}

export function loadWaivers(cawsDir: string): WaiversLoadResult {
  const waiversDir = waiversDirPath(cawsDir);
  if (!fs.existsSync(waiversDir)) {
    return { waivers: [], diagnostics: [] };
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(waiversDir, { withFileTypes: true });
  } catch (e) {
    const cause = e as { message?: string; code?: string };
    return {
      waivers: [],
      diagnostics: [
        storeDiagnostic(
          STORE_RULES.READ_IO_FAILED,
          `Failed to read ${waiversDir}: ${cause.message ?? 'unknown error'}.`,
          cause.code !== undefined
            ? { subject: waiversDir, data: { code: cause.code } }
            : { subject: waiversDir }
        ),
      ],
    };
  }

  const validWaivers: Waiver[] = [];
  const diagnostics: Diagnostic[] = [];
  const seenIds = new Map<string, string>(); // id → first-seen file path

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(waiversDir, entry.name);

    if (!isYamlPath(entry.name)) {
      // CAWS-DOCTOR-SEVERITY-RECALIBRATION-001: by-design skip is INFO.
      diagnostics.push(
        diagnostic({
          rule: STORE_RULES.WAIVERS_NON_YAML_SKIPPED,
          authority: 'kernel/diagnostics',
          severity: 'info',
          message: `Skipping non-YAML file in .caws/waivers/: ${entry.name}.`,
          subject: fullPath,
        })
      );
      continue;
    }

    const source = readYamlFile(fullPath);
    if (!isOk(source)) {
      diagnostics.push(...source.errors);
      continue;
    }

    const result = validateWaiver(source.value);
    if (!isOk(result)) {
      // Annotate with the file we were reading so doctor can repair.
      for (const e of result.errors) {
        diagnostics.push({ ...e, subject: e.subject ?? fullPath });
      }
      continue;
    }

    const waiver = result.value;
    const prev = seenIds.get(waiver.id);
    if (prev !== undefined) {
      diagnostics.push(
        storeDiagnostic(
          STORE_RULES.WAIVERS_DUPLICATE_ID,
          `Duplicate waiver id ${waiver.id}: first seen in ${prev}, second in ${fullPath}.`,
          {
            subject: fullPath,
            data: { waiver_id: waiver.id, first_seen: prev, duplicate: fullPath },
          }
        )
      );
      continue;
    }
    seenIds.set(waiver.id, fullPath);

    // Filename should equal `<id>.yaml`. This isn't an error (the kernel
    // doesn't care about filenames), but it's a hygiene info diagnostic
    // so doctor can spot drift.
    const expectedName = `${waiver.id}.yaml`;
    if (entry.name !== expectedName) {
      diagnostics.push({
        ...storeDiagnostic(
          STORE_RULES.WAIVERS_FILENAME_MISMATCH,
          `Waiver file ${entry.name} does not match id ${waiver.id} (expected ${expectedName}).`,
          { subject: fullPath, data: { id: waiver.id, expected: expectedName } }
        ),
        severity: 'info',
      });
    }

    validWaivers.push(waiver);
  }

  return { waivers: validWaivers, diagnostics };
}

/**
 * Write a waiver atomically to `.caws/waivers/<id>.yaml`. Refuses
 * to overwrite an existing file (use markRevoked to update status).
 */
export function writeWaiver(
  cawsDir: string,
  waiver: Waiver,
  opts: { allowOverwrite?: boolean } = {}
): Result<true> {
  const waiversDir = waiversDirPath(cawsDir);
  try {
    fs.mkdirSync(waiversDir, { recursive: true });
  } catch (e) {
    return err(
      storeDiagnostic(
        STORE_RULES.WRITE_IO_FAILED,
        `Failed to create ${waiversDir}: ${(e as Error).message}.`,
        { subject: waiversDir }
      )
    );
  }

  const filePath = waiverFilePath(cawsDir, waiver.id);
  if (!opts.allowOverwrite && fs.existsSync(filePath)) {
    return err(
      storeDiagnostic(
        STORE_RULES.WAIVERS_ALREADY_EXISTS,
        `Waiver ${waiver.id} already exists at ${filePath}.`,
        { subject: filePath, data: { id: waiver.id } }
      )
    );
  }

  return writeFileAtomic(filePath, serializeWaiver(waiver));
}

/**
 * Mark an existing waiver as revoked. Reads the existing file, builds a
 * new in-memory waiver with status='revoked' and a revocation record,
 * writes it back atomically. Refuses if the waiver is already revoked
 * (caller decides whether to revisit revocation reason).
 */
export function markRevoked(
  cawsDir: string,
  id: string,
  args: { now: Date; revoked_by?: string; reason?: string }
): Result<Waiver> {
  const filePath = waiverFilePath(cawsDir, id);
  if (!fs.existsSync(filePath)) {
    return err(
      storeDiagnostic(
        STORE_RULES.WAIVERS_NOT_FOUND,
        `Waiver ${id} not found at ${filePath}.`,
        { subject: filePath, data: { id } }
      )
    );
  }

  const source = readYamlFile(filePath);
  if (!isOk(source)) return source;

  const validated = validateWaiver(source.value);
  if (!isOk(validated)) return validated;
  const existing = validated.value;

  if (existing.status === 'revoked') {
    return err(
      storeDiagnostic(
        STORE_RULES.WAIVERS_ALREADY_EXISTS,
        `Waiver ${id} is already revoked.`,
        { subject: filePath, data: { id } }
      )
    );
  }

  const revoked: Waiver = {
    ...existing,
    status: 'revoked',
    revocation: {
      revoked_at: args.now.toISOString(),
      ...(args.revoked_by !== undefined ? { revoked_by: args.revoked_by } : {}),
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    },
  };

  const write = writeFileAtomic(filePath, serializeWaiver(revoked));
  if (!isOk(write)) return write;
  return ok(revoked);
}

/**
 * Serialize a waiver to YAML. Deterministic field order so the file is
 * stable on disk. Built by hand to avoid YAML alias churn (the existing
 * specs use a similar controlled-serialization approach).
 */
function serializeWaiver(w: Waiver): string {
  const lines: string[] = [];
  lines.push(`id: ${w.id}`);
  lines.push(`title: ${yamlQuote(w.title)}`);
  lines.push(`status: ${w.status}`);
  lines.push('gates:');
  for (const g of w.gates) lines.push(`  - ${g}`);
  lines.push(`reason: ${yamlQuote(w.reason)}`);
  lines.push(`approved_by: ${yamlQuote(w.approved_by)}`);
  lines.push(`created_at: ${yamlQuote(w.created_at)}`);
  lines.push(`expires_at: ${yamlQuote(w.expires_at)}`);
  if (w.scope !== undefined) {
    lines.push('scope:');
    if (w.scope.spec_id !== undefined) lines.push(`  spec_id: ${w.scope.spec_id}`);
  }
  if (w.constraints !== undefined) {
    lines.push('constraints:');
    if (w.constraints.max_uses !== undefined)
      lines.push(`  max_uses: ${w.constraints.max_uses}`);
  }
  if (w.revocation !== undefined) {
    lines.push('revocation:');
    lines.push(`  revoked_at: ${yamlQuote(w.revocation.revoked_at)}`);
    if (w.revocation.revoked_by !== undefined)
      lines.push(`  revoked_by: ${yamlQuote(w.revocation.revoked_by)}`);
    if (w.revocation.reason !== undefined)
      lines.push(`  reason: ${yamlQuote(w.revocation.reason)}`);
  }
  return lines.join('\n') + '\n';
}

function yamlQuote(value: string): string {
  // Conservative: always single-quote strings, doubling internal single quotes.
  // This avoids the YAML "is this an integer/date/bool?" ambiguity entirely.
  return `'${value.replace(/'/g, "''")}'`;
}
