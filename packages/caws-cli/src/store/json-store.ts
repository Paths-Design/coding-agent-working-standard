// JSON read helper. Same shape and discipline as yaml-store: report
// missing/malformed via discrete rule ids.

import * as fs from 'fs';
import { err, ok, type Result } from '@paths.design/caws-kernel';
import { storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';

export function readJsonFile(filePath: string): Result<unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    const cause = e as { code?: string; message?: string };
    if (cause.code === 'ENOENT') {
      return err(
        storeDiagnostic(STORE_RULES.READ_MISSING_FILE, `File not found: ${filePath}.`, {
          subject: filePath,
        })
      );
    }
    return err(
      storeDiagnostic(
        STORE_RULES.READ_IO_FAILED,
        `Failed to read ${filePath}: ${cause.message ?? 'unknown error'}.`,
        { subject: filePath, data: { code: cause.code } }
      )
    );
  }

  try {
    return ok(JSON.parse(raw));
  } catch (e) {
    const cause = e as { message?: string };
    return err(
      storeDiagnostic(
        STORE_RULES.READ_JSON_INVALID,
        `JSON parse failed in ${filePath}: ${cause.message ?? 'unknown error'}.`,
        { subject: filePath }
      )
    );
  }
}
