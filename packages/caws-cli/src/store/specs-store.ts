// Specs loader.
//
// Multi-spec only. Loads every `*.yaml` / `*.yml` file directly under
// `.caws/specs/`, hands each source to the kernel's `parseAndValidateSpec`,
// and collects the results.
//
// Discipline:
//   - DOES NOT resurrect `.caws/working-spec.yaml`. The project-level
//     spec is gone in vNext; the only authoritative source is per-feature
//     specs under .caws/specs/.
//   - Skips files that are not .yaml/.yml with a soft `non_yaml_skipped`
//     diagnostic (info severity).
//   - Per-file validation failures land in `diagnostics`; the valid
//     specs are still returned. doctor decides how to surface them.
//   - Duplicate spec ids → diagnostic; the first occurrence wins.
//   - Missing `.caws/specs/` directory → returns `{ specs: [], diagnostics: [] }`.

import * as fs from 'fs';
import * as path from 'path';
import {
  isOk,
  parseAndValidateSpec,
  type Diagnostic,
  type Spec,
} from '@paths.design/caws-kernel';
import { storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';
import { readYamlSource } from './yaml-store';
import type { SpecsLoadResult } from './types';

function isYamlPath(name: string): boolean {
  return name.endsWith('.yaml') || name.endsWith('.yml');
}

export function loadSpecs(cawsDir: string): SpecsLoadResult {
  const specsDir = path.join(cawsDir, 'specs');
  if (!fs.existsSync(specsDir)) {
    return { specs: [], diagnostics: [] };
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(specsDir, { withFileTypes: true });
  } catch (e) {
    const cause = e as { message?: string; code?: string };
    return {
      specs: [],
      diagnostics: [
        storeDiagnostic(
          STORE_RULES.READ_IO_FAILED,
          `Failed to read ${specsDir}: ${cause.message ?? 'unknown error'}.`,
          { subject: specsDir, data: { code: cause.code } }
        ),
      ],
    };
  }

  const validSpecs: Spec[] = [];
  const diagnostics: Diagnostic[] = [];
  const seenIds = new Map<string, string>(); // id → first-seen file path

  // Sort for determinism. composeDoctorSnapshot should produce the same
  // snapshot for the same on-disk state.
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    // Explicit guard: working-spec.yaml is forbidden in vNext.
    if (entry.name === 'working-spec.yaml' || entry.name === 'working-spec.yml') {
      diagnostics.push(
        storeDiagnostic(
          STORE_RULES.SPECS_NON_YAML_SKIPPED,
          `Skipping ${entry.name}: project-level working spec is not supported in vNext.`,
          { subject: path.join(specsDir, entry.name) }
        )
      );
      continue;
    }

    const fullPath = path.join(specsDir, entry.name);

    if (!isYamlPath(entry.name)) {
      diagnostics.push(
        storeDiagnostic(
          STORE_RULES.SPECS_NON_YAML_SKIPPED,
          `Skipping non-YAML file in .caws/specs/: ${entry.name}.`,
          { subject: fullPath }
        )
      );
      continue;
    }

    const source = readYamlSource(fullPath);
    if (!isOk(source)) {
      diagnostics.push(...source.errors);
      continue;
    }

    const result = parseAndValidateSpec(source.value);
    if (!isOk(result)) {
      // Wrap kernel diagnostics with the offending file as subject when
      // the kernel didn't already attach one.
      for (const d of result.errors) {
        diagnostics.push({
          ...d,
          subject: d.subject ?? fullPath,
        });
      }
      continue;
    }

    const spec = result.value;
    const existing = seenIds.get(spec.id);
    if (existing !== undefined) {
      diagnostics.push(
        storeDiagnostic(
          STORE_RULES.SPECS_DUPLICATE_ID,
          `Duplicate spec id "${spec.id}" — already loaded from ${existing}.`,
          {
            subject: fullPath,
            narrowRepair: `Rename the spec id in ${entry.name} or remove the duplicate file.`,
            data: { spec_id: spec.id, first_seen: existing, duplicate: fullPath },
          }
        )
      );
      continue;
    }
    seenIds.set(spec.id, fullPath);
    validSpecs.push(spec);
  }

  return { specs: validSpecs, diagnostics };
}
