// Policy loader.
//
// Loads `.caws/policy.yaml`, hands the source to the kernel's
// `parseAndValidatePolicy`, and surfaces both the parsed value and any
// non-fatal warnings the kernel emitted. Missing file is NOT an error
// at the store level — doctor decides whether to emit `POLICY_MISSING`.

import * as path from 'path';
import {
  isOk,
  parseAndValidatePolicy,
  type Diagnostic,
} from '@paths.design/caws-kernel';
import { STORE_RULES } from './rules';
import { readYamlSource } from './yaml-store';
import type { PolicyLoadResult } from './types';

export function loadPolicy(cawsDir: string): PolicyLoadResult {
  const policyPath = path.join(cawsDir, 'policy.yaml');
  const source = readYamlSource(policyPath);
  if (!isOk(source)) {
    // Distinguish missing file (Ok-shaped) from malformed file (Err).
    const missing = source.errors.some((e) => e.rule === STORE_RULES.READ_MISSING_FILE);
    if (missing) {
      return { warnings: [], errors: [] };
    }
    return { warnings: [], errors: [...source.errors] };
  }

  const result = parseAndValidatePolicy(source.value);
  if (!isOk(result)) {
    return { warnings: [], errors: [...result.errors] };
  }

  const warnings: readonly Diagnostic[] = result.warnings ?? [];
  return { policy: result.value, warnings: [...warnings], errors: [] };
}
