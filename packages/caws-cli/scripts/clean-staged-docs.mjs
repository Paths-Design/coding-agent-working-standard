#!/usr/bin/env node
// Remove the staged package-local docs/ tree (CAWS-DOCS-SHIP-CONSUMER-SET-001).
//
// The consumer docs live at the repo root (<repo>/docs); npm's `files` field
// cannot reference paths outside the package, so stage-consumer-docs.mjs copies
// the audience:consumer set into packages/caws-cli/docs/ as a transport
// artifact. This script deletes that staged tree.
//
// Invoked at the START of prepack (beginning-clean is the real safety
// invariant — postpack can be skipped by an interrupted publish, so the next
// prepack must not inherit stale staged docs) and again at postpack as cleanup.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const STAGED_DOCS = path.join(PKG_ROOT, 'docs');

function main() {
  if (fs.existsSync(STAGED_DOCS)) {
    fs.rmSync(STAGED_DOCS, { recursive: true, force: true });
    process.stderr.write(`cleaned staged docs at ${path.relative(PKG_ROOT, STAGED_DOCS)}/\n`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`clean-staged-docs: ${err.stack || err.message}\n`);
    process.exit(2);
  }
}
