// Agents registry loader.
//
// Reads `.caws/agents.json`. Same shape rules as worktrees-store: missing
// → empty, malformed → Err. Agents.json is freshness/display only and
// never authority per CAWSFIX-31/32 doctrine; the store treats it like
// any other data payload.

import * as path from 'path';
import {
  err,
  isOk,
  ok,
  type AgentRegistry,
  type Result,
} from '@paths.design/caws-kernel';
import { readJsonFile } from './json-store';
import { storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';

export function loadAgents(cawsDir: string): Result<AgentRegistry> {
  const filePath = path.join(cawsDir, 'agents.json');
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
        `agents.json is not a JSON object.`,
        { subject: filePath }
      )
    );
  }
  return ok(value as AgentRegistry);
}
