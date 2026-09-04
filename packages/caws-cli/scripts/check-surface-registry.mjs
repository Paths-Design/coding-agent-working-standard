#!/usr/bin/env node
// CAWS-DESIGN-GLOBAL-IDENTITY-HOME-001 A2: fail the build when the committed
// generated file disagrees with a fresh regeneration from the registry.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'src', 'init', 'hook-packs', 'surfaces.generated.ts');
const before = readFileSync(target, 'utf8');
execFileSync(process.execPath, [join(here, 'generate-surface-registry.mjs')], { stdio: 'pipe' });
const after = readFileSync(target, 'utf8');
if (before !== after) {
  console.error('surface-registry drift: src/init/hook-packs/surfaces.generated.ts does not match surfaces/registry.json. Run: node scripts/generate-surface-registry.mjs');
  process.exit(1);
}
console.log('surface registry in sync');
