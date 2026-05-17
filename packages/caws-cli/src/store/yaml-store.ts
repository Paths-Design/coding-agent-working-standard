// YAML read helper.
//
// Returns Ok(parsedNode) or Err(diagnostic). Distinguishes:
//   - missing file → Err(STORE.READ_MISSING_FILE)   [caller decides Ok([]) vs Err]
//   - not a regular file → Err(STORE.READ_NOT_A_FILE)
//   - I/O failure → Err(STORE.READ_IO_FAILED)
//   - YAML parse failure → Err(STORE.READ_YAML_INVALID)
//
// This helper does NOT validate against a schema. The kernel is the
// authority for semantic validation; the store is the bridge for I/O.

import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { err, ok, type Result } from '@paths.design/caws-kernel';
import { storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';

export function readYamlFile(filePath: string): Result<unknown> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
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
        `Failed to stat ${filePath}: ${cause.message ?? 'unknown error'}.`,
        { subject: filePath, data: { code: cause.code } }
      )
    );
  }

  if (!stat.isFile()) {
    return err(
      storeDiagnostic(STORE_RULES.READ_NOT_A_FILE, `${filePath} is not a regular file.`, {
        subject: filePath,
      })
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    const cause = e as { code?: string; message?: string };
    return err(
      storeDiagnostic(
        STORE_RULES.READ_IO_FAILED,
        `Failed to read ${filePath}: ${cause.message ?? 'unknown error'}.`,
        { subject: filePath, data: { code: cause.code } }
      )
    );
  }

  try {
    const parsed = yaml.load(raw);
    return ok(parsed);
  } catch (e) {
    const cause = e as { message?: string };
    return err(
      storeDiagnostic(
        STORE_RULES.READ_YAML_INVALID,
        `YAML parse failed in ${filePath}: ${cause.message ?? 'unknown error'}.`,
        { subject: filePath }
      )
    );
  }
}

/**
 * Read raw YAML text (no parse). Returns Err for missing/IO failure but
 * never for syntax problems — those are the caller's concern. Used by
 * spec/policy loaders, which hand the raw string to the kernel.
 */
export function readYamlSource(filePath: string): Result<string> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
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
        `Failed to stat ${filePath}: ${cause.message ?? 'unknown error'}.`,
        { subject: filePath, data: { code: cause.code } }
      )
    );
  }

  if (!stat.isFile()) {
    return err(
      storeDiagnostic(STORE_RULES.READ_NOT_A_FILE, `${filePath} is not a regular file.`, {
        subject: filePath,
      })
    );
  }

  try {
    return ok(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    const cause = e as { code?: string; message?: string };
    return err(
      storeDiagnostic(
        STORE_RULES.READ_IO_FAILED,
        `Failed to read ${filePath}: ${cause.message ?? 'unknown error'}.`,
        { subject: filePath, data: { code: cause.code } }
      )
    );
  }
}
