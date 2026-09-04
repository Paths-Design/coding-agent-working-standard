#!/usr/bin/env node
// CAWS-DESIGN-GLOBAL-IDENTITY-HOME-001 A2: fail the build when the committed
// generated file disagrees with a fresh regeneration from the registry.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const targets = [
  join(here, '..', 'src', 'init', 'hook-packs', 'surfaces.generated.ts'),
  join(here, '..', 'templates', 'hook-packs', 'shared', 'lib', 'surfaces-registry.sh'),
];
const before = targets.map((t) => readFileSync(t, 'utf8'));
execFileSync(process.execPath, [join(here, 'generate-surface-registry.mjs')], { stdio: 'pipe' });
let drift = false;
for (let i = 0; i < targets.length; i++) {
  if (readFileSync(targets[i], 'utf8') !== before[i]) {
    console.error(`surface-registry drift: ${targets[i]} does not match surfaces/registry.json. Run: node scripts/generate-surface-registry.mjs`);
    drift = true;
  }
}
if (drift) process.exit(1);
console.log('surface registry in sync (TS + shell)');
