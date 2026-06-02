#!/usr/bin/env node
// CAWS docs front-matter validator (CAWS-DOCS-FRONTMATTER-VALIDATOR-001).
//
// Formalizes the (previously informal) Sterling-style front-matter convention
// already present on ~20 docs under docs/. Enforces the schema over a STRICT
// SET of docs; docs outside the strict set are reported as lenient warnings,
// never failures. The strict set is DATA (STRICT_SET below), so widening
// enforcement repo-wide is a one-line edit, not a logic change — that is the
// "toggle on later" design the slice was scoped around.
//
// Modes:
//   (default)  enforce STRICT_SET; warn (non-failing) on everything else.
//   --all      promote ALL docs under docs/ into the strict set (the future
//              toggle; exercised by the test, not yet wired into CI).
//   --json     emit a machine-readable report on stdout instead of text.
//
// Exit codes: 0 = no strict-set violations; 1 = one or more strict-set
// violations; 2 = usage / IO error. The validator FAILS CLOSED — a strict-set
// doc whose front-matter block is unparseable YAML is a violation, not a skip.
//
// This script lives under scripts/ and is NOT bundled into dist/ (the build
// allowlist gates only src/ → dist/), so it never ships in the npm package.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// scripts/ -> caws-cli -> packages -> repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');

// ─── Schema ────────────────────────────────────────────────────────────────

export const REQUIRED_FIELDS = ['doc_id', 'authority', 'status', 'title', 'owner', 'updated'];

export const VALID_AUTHORITIES = new Set([
  'canonical',
  'policy',
  'architecture',
  'adr',
  'spec',
  'roadmap',
  'reference',
  'guide',
  'working',
  'ephemeral',
]);

export const VALID_STATUSES = new Set(['active', 'superseded', 'draft', 'archived']);

// New dimension this slice introduces: the consumer-doc ship-list (slice 3)
// derives from `audience: consumer`. Required on every strict-set doc.
export const VALID_AUDIENCES = new Set(['consumer', 'maintainer']);

// ─── Strict set (DATA — the toggle surface) ──────────────────────────────────
//
// Repo-root-relative paths the validator HARD-enforces. Everything else under
// docs/ is lenient (warn-only) until this set is widened. To enforce repo-wide,
// either add paths here or run with --all.
export const STRICT_SET = [
  'docs/DOCUMENTATION_STANDARDS.md',
  'docs/guides/caws-developer-guide.md',
  'docs/guides/multi-agent-workflow.md',
  'docs/guides/quality-gates.md',
  'docs/guides/waiver-troubleshooting.md',
  'docs/guides/worktree-isolation.md',
];

// ─── Front-matter extraction ─────────────────────────────────────────────────

/**
 * Extract the leading YAML front-matter block from markdown text.
 * Returns { present, raw } where `raw` is the YAML body between the fences.
 * A doc with no leading `---` fence has present:false.
 */
export function extractFrontMatter(text) {
  // Normalize CRLF and a possible UTF-8 BOM.
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { present: false, raw: null };
  }
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) {
    // Opening fence with no closing fence — malformed.
    return { present: true, raw: null, unterminated: true };
  }
  const raw = normalized.slice(4, end + 1);
  return { present: true, raw };
}

/**
 * Validate one doc's front-matter against the schema.
 * Returns an array of human-readable violation strings (empty = valid).
 * `strict` controls whether `audience` is required (strict-set docs must
 * declare it; lenient docs need not).
 */
export function validateFrontMatter(text, { strict } = { strict: true }) {
  const violations = [];
  const fm = extractFrontMatter(text);

  if (!fm.present) {
    return ['no front-matter block (expected a leading `---` YAML fence)'];
  }
  if (fm.unterminated) {
    return ['front-matter fence opened with `---` but never closed'];
  }

  let parsed;
  try {
    parsed = yaml.load(fm.raw);
  } catch (err) {
    // FAIL CLOSED: unparseable YAML is a violation, not a skip.
    return [`front-matter YAML is unparseable: ${err.message}`];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return ['front-matter parsed to a non-object'];
  }

  for (const field of REQUIRED_FIELDS) {
    const v = parsed[field];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      violations.push(`missing required field: ${field}`);
    }
  }

  if (parsed.authority !== undefined && !VALID_AUTHORITIES.has(parsed.authority)) {
    violations.push(
      `invalid authority "${parsed.authority}" (allowed: ${[...VALID_AUTHORITIES].join(', ')})`
    );
  }

  if (parsed.status !== undefined && !VALID_STATUSES.has(parsed.status)) {
    violations.push(
      `invalid status "${parsed.status}" (allowed: ${[...VALID_STATUSES].join(', ')})`
    );
  }

  // Conditional: superseded docs must point at their replacement.
  if (parsed.status === 'superseded' && !parsed.superseded_by) {
    violations.push('status "superseded" requires a `superseded_by` field');
  }

  // `audience` is required on strict-set docs (the ship-list derives from it)
  // and, where present anywhere, must be a known value.
  if (parsed.audience === undefined || parsed.audience === null) {
    if (strict) {
      violations.push('missing required field: audience (consumer|maintainer)');
    }
  } else if (!VALID_AUDIENCES.has(parsed.audience)) {
    violations.push(
      `invalid audience "${parsed.audience}" (allowed: ${[...VALID_AUDIENCES].join(', ')})`
    );
  }

  return violations;
}

// ─── Filesystem walk ─────────────────────────────────────────────────────────

/**
 * Recursively list every *.md under dir.
 * Paths are returned relative to `relativeTo` (default REPO_ROOT, so the real
 * docs tree yields repo-root-relative ids like "docs/guides/x.md"). Tests pass
 * a temp docsDir and want paths relative to it, so strictSet entries like
 * "guides/good.md" match.
 */
export function listDocs(dir = DOCS_DIR, relativeTo = REPO_ROOT) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(path.relative(relativeTo, abs));
      }
    }
  };
  walk(dir);
  return out.sort();
}

// ─── Runner (pure: returns a report; the CLI wrapper does IO/exit) ──────────

/**
 * Validate the docs tree.
 * @param {object} opts
 * @param {string[]} [opts.strictSet] repo-root-relative paths to hard-enforce.
 * @param {boolean}  [opts.all] enforce every doc under docs/ (the toggle).
 * @param {string}   [opts.docsDir] override for tests.
 * Returns { violations: [{file, messages}], warnings: [{file, messages}] }.
 */
export function runValidation({ strictSet = STRICT_SET, all = false, docsDir = DOCS_DIR } = {}) {
  // Paths are relative to docsDir's PARENT for the real tree (so ids read
  // "docs/..."), and relative to docsDir for a custom tree (so a test's
  // strictSet "guides/x.md" matches). The real DOCS_DIR is <repo>/docs, whose
  // parent is REPO_ROOT — preserving the historical "docs/..." ids.
  const relativeTo = docsDir === DOCS_DIR ? REPO_ROOT : docsDir;
  const docs = listDocs(docsDir, relativeTo);
  const strict = new Set(all ? docs : strictSet);
  const violations = [];
  const warnings = [];

  for (const rel of docs) {
    const abs = path.join(relativeTo, rel);
    const text = fs.readFileSync(abs, 'utf8');
    const isStrict = strict.has(rel);
    const messages = validateFrontMatter(text, { strict: isStrict });
    if (messages.length === 0) continue;
    if (isStrict) {
      violations.push({ file: rel, messages });
    } else {
      warnings.push({ file: rel, messages });
    }
  }
  return { violations, warnings, strictCount: strict.size, total: docs.length };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

/** Parse `--flag value` / `--flag=value` for a single named option. */
function readOption(argv, name) {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}

function main(argv) {
  const all = argv.includes('--all');
  const asJson = argv.includes('--json');
  // --docs-dir lets tests point the validator at a temp tree without importing
  // the ESM module (the CJS jest suite cannot dynamic-import .mjs).
  const docsDirOpt = readOption(argv, '--docs-dir');
  const docsDir = docsDirOpt ? path.resolve(process.cwd(), docsDirOpt) : DOCS_DIR;
  // When validating an arbitrary tree, the on-disk STRICT_SET paths (which are
  // repo-root-relative) won't match; honor an explicit --strict comma list, or
  // fall back to --all semantics for a custom dir so nothing is silently lenient.
  const strictOpt = readOption(argv, '--strict');
  const strictSet = strictOpt ? strictOpt.split(',').map((s) => s.trim()).filter(Boolean) : STRICT_SET;
  const report = runValidation({ all, docsDir, strictSet });

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    const mode = all ? 'ALL docs (toggle on)' : `strict set (${report.strictCount} docs)`;
    process.stderr.write(`docs front-matter validation — enforcing ${mode}\n`);
    for (const w of report.warnings) {
      process.stderr.write(`  warn  ${w.file}\n`);
      for (const m of w.messages) process.stderr.write(`          - ${m}\n`);
    }
    for (const v of report.violations) {
      process.stderr.write(`  FAIL  ${v.file}\n`);
      for (const m of v.messages) process.stderr.write(`          - ${m}\n`);
    }
    if (report.violations.length === 0) {
      process.stderr.write(`OK — ${report.strictCount} strict-set doc(s) valid; ${report.warnings.length} lenient warning(s).\n`);
    } else {
      process.stderr.write(`FAILED — ${report.violations.length} strict-set doc(s) violate the schema.\n`);
    }
  }
  return report.violations.length === 0 ? 0 : 1;
}

// Run only when invoked directly, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`validate-docs: ${err.stack || err.message}\n`);
    process.exit(2);
  }
}
