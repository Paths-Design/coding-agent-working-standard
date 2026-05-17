// Worktrees registry loader.
//
// Reads `.caws/worktrees.json`. Missing file → empty registry. Malformed
// JSON or non-object payload → Err. Shape validation is shallow; the
// kernel's worktree module reasons about the structured shape.

import * as path from 'path';
import {
  err,
  isOk,
  ok,
  type Result,
  type WorktreeRegistry,
} from '@paths.design/caws-kernel';
import { readJsonFile } from './json-store';
import { storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';

export function loadWorktrees(cawsDir: string): Result<WorktreeRegistry> {
  const filePath = path.join(cawsDir, 'worktrees.json');
  const r = readJsonFile(filePath);
  if (!isOk(r)) {
    if (r.errors.some((e) => e.rule === STORE_RULES.READ_MISSING_FILE)) {
      return ok({});
    }
    return err(r.errors);
  }
  const value = r.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err(
      storeDiagnostic(
        STORE_RULES.REGISTRY_NOT_OBJECT,
        `worktrees.json is not a JSON object.`,
        { subject: filePath }
      )
    );
  }
  return ok(value as WorktreeRegistry);
}
