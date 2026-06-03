#!/usr/bin/env node
// Stage the audience:consumer docs into the package for publishing
// (CAWS-DOCS-SHIP-CONSUMER-SET-001).
//
// THE PROBLEM: the authoritative docs live at the repo root (<repo>/docs).
// npm's `files` field cannot reference paths outside the package boundary
// (<repo>/packages/caws-cli), so we cannot ship repo-root docs by listing them.
//
// THE MECHANISM: at prepack time, copy exactly the docs whose front-matter
// declares `audience: consumer` into packages/caws-cli/docs/ (a gitignored
// transport artifact). The package `files` array ships `docs/**`; this script
// decides WHICH docs are there. ONE curation surface — the front-matter — not
// two. The staging directory is transport, never a second curation list.
//
// FAIL-CLOSED. The script asserts, before exiting 0, that the staged set
// exactly equals the front-matter-derived set and that known exclusions
// (DOCUMENTATION_STANDARDS.md / any non-consumer doc) are absent. A mismatch is
// a hard error, not a silent partial copy.
//
// BEGINNING-CLEAN. The staged dir is deleted FIRST so a prior interrupted run
// cannot leak stale docs into this artifact.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFrontMatter } from './validate-docs.mjs';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..');
const SRC_DOCS = path.join(REPO_ROOT, 'docs');
const STAGED_DOCS = path.join(PKG_ROOT, 'docs');

/** Recursively list every *.md under dir as paths relative to `relativeTo`. */
function listMarkdown(dir, relativeTo) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path.relative(relativeTo, abs));
    }
  };
  walk(dir);
  return out.sort();
}

/** Return the `audience` value of a markdown file, or null if absent/unparseable. */
function audienceOf(absPath) {
  const fm = extractFrontMatter(fs.readFileSync(absPath, 'utf8'));
  if (!fm.present || fm.unterminated || !fm.raw) return null;
  let parsed;
  try {
    parsed = yaml.load(fm.raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed.audience ?? null;
}

/** Compute the repo-root-relative set of docs whose audience is "consumer". */
export function deriveConsumerDocs(srcDocs = SRC_DOCS, repoRoot = REPO_ROOT) {
  const all = listMarkdown(srcDocs, repoRoot); // "docs/..." ids
  return all.filter((rel) => audienceOf(path.join(repoRoot, rel)) === 'consumer').sort();
}

function main() {
  // 1+4. Beginning-clean.
  fs.rmSync(STAGED_DOCS, { recursive: true, force: true });

  // 2+3. Derive the consumer set from front-matter.
  const consumer = deriveConsumerDocs();
  if (consumer.length === 0) {
    throw new Error('no audience:consumer docs found — refusing to stage an empty docs set.');
  }

  // 5. Copy, preserving repo-root-relative paths under docs/.
  for (const rel of consumer) {
    // rel is "docs/<...>"; strip the leading "docs/" to place under STAGED_DOCS.
    const sub = rel.replace(/^docs\//, '');
    const dest = path.join(STAGED_DOCS, sub);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, rel), dest);
  }

  // 6. Assert the copied set exactly equals the derived set.
  const staged = listMarkdown(STAGED_DOCS, STAGED_DOCS).map((p) => `docs/${p}`).sort();
  const expected = consumer.map((r) => r).sort();
  const missing = expected.filter((e) => !staged.includes(e));
  const extra = staged.filter((s) => !expected.includes(s));
  if (missing.length || extra.length) {
    throw new Error(
      `staged docs set != derived set. missing: [${missing.join(', ')}] extra: [${extra.join(', ')}]`
    );
  }

  // 7. Assert known exclusions are absent from the staged tree.
  const stagedAbs = (rel) => path.join(STAGED_DOCS, rel.replace(/^docs\//, ''));
  if (fs.existsSync(stagedAbs('docs/DOCUMENTATION_STANDARDS.md'))) {
    throw new Error('DOCUMENTATION_STANDARDS.md (audience: maintainer) leaked into the staged docs.');
  }
  for (const rel of staged) {
    const aud = audienceOf(stagedAbs(rel));
    if (aud !== 'consumer') {
      throw new Error(`staged doc ${rel} has audience "${aud}", not consumer — fail closed.`);
    }
  }

  process.stderr.write(
    `staged ${staged.length} consumer doc(s) into ${path.relative(REPO_ROOT, STAGED_DOCS)}/:\n` +
      staged.map((s) => `  ${s}`).join('\n') +
      '\n'
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`stage-consumer-docs: ${err.message}\n`);
    process.exit(2);
  }
}
