#!/usr/bin/env node
// Generate docs/command-reference.md from COMMAND_SURFACE_METADATA
// (CAWS-DOCS-COMMAND-REFERENCE-GEN-001).
//
// COMMAND_SURFACE_METADATA (src/shell/command-metadata.ts → dist) is the typed
// single source register.ts consumes to build every command's --help. This
// generator renders that same metadata to markdown, so the consumer-facing
// command reference CANNOT drift from the actual CLI surface: a command, arg,
// or visible flag added/removed/renamed in the metadata changes both --help
// and this doc, and the sync test fails CI if the committed doc wasn't
// regenerated.
//
// Determinism: the output is a pure function of the metadata (no timestamps,
// stable ordering as authored in the metadata array), so the drift test is not
// flaky.
//
// Usage:
//   node scripts/generate-command-reference.mjs            # write docs/command-reference.md
//   node scripts/generate-command-reference.mjs --check    # exit 1 if the file is stale
//   node scripts/generate-command-reference.mjs --stdout   # print, don't write

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// scripts/ -> caws-cli (package root) -> packages -> repo root
const PKG_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..');
const OUT_PATH = path.join(REPO_ROOT, 'docs', 'command-reference.md');
const METADATA_PATH = path.join(PKG_ROOT, 'dist', 'shell', 'command-metadata.js');

// ─── Rendering (pure) ────────────────────────────────────────────────────────

/** Render a single option's bullet line. Returns null for hidden options. */
function renderOption(opt) {
  if (opt.hidden) return null;
  let line = `- \`${opt.flag}\``;
  const parts = [];
  if (opt.required) parts.push('**required**');
  if (opt.collect) parts.push('repeatable');
  if (opt.defaultValue !== undefined) {
    const dv = Array.isArray(opt.defaultValue)
      ? `[${opt.defaultValue.join(', ')}]`
      : String(opt.defaultValue);
    parts.push(`default: \`${dv}\``);
  }
  const meta = parts.length ? ` (${parts.join(', ')})` : '';
  let desc = opt.description || '';
  if (opt.allowedValues && opt.allowedValues.length) {
    // Mirror register.ts: append ": v1 | v2 | ...".
    desc += `${desc ? ': ' : ''}${opt.allowedValues.join(' | ')}`;
  }
  line += `${meta}${desc ? ` — ${desc}` : ''}`;
  return line;
}

/** Render the usage line for a leaf command under a group (or top-level). */
function usage(prefix, leaf) {
  let u = `caws ${prefix}${leaf.name}`;
  if (leaf.argument) {
    const a = leaf.argument;
    u += a.required ? ` <${a.name}>` : ` [${a.name}]`;
  }
  return u;
}

/** Render one leaf command section. `prefix` is "" for top-level or "<group> ". */
function renderLeaf(leaf, prefix, headingLevel) {
  const h = '#'.repeat(headingLevel);
  const lines = [];
  lines.push(`${h} \`${usage(prefix, leaf)}\``);
  lines.push('');
  if (leaf.description) {
    lines.push(leaf.description);
    lines.push('');
  }
  if (leaf.argument) {
    const a = leaf.argument;
    lines.push(
      `**Argument:** \`${a.name}\`${a.required ? ' (required)' : ' (optional)'}${a.description ? ` — ${a.description}` : ''}`
    );
    lines.push('');
  }
  const optLines = (leaf.options || []).map(renderOption).filter(Boolean);
  if (optLines.length) {
    lines.push('**Options:**');
    lines.push('');
    lines.push(...optLines);
    lines.push('');
  }
  return lines;
}

/** Render the whole reference from the metadata array. Returns a string. */
export function renderReference(metadata) {
  const lines = [];
  // YAML front-matter FIRST so the generated artifact self-describes as a
  // consumer doc — the package ship-list derives purely from audience:consumer
  // (CAWS-DOCS-SHIP-CONSUMER-SET-001). "generated: true" marks it exempt from
  // hand-authoring; the sync test asserts this block stays current too.
  lines.push('---');
  lines.push('doc_id: command-reference');
  lines.push('authority: reference');
  lines.push('status: active');
  lines.push('title: CAWS CLI command reference');
  lines.push('owner: vNext rewrite team');
  lines.push('updated: 2026-06-03');
  lines.push('audience: consumer');
  lines.push('generated: true');
  lines.push('source: packages/caws-cli/src/shell/command-metadata.ts');
  lines.push('---');
  lines.push('');
  lines.push('<!--');
  lines.push('  GENERATED FILE — do not edit by hand.');
  lines.push('  Source: packages/caws-cli/src/shell/command-metadata.ts (COMMAND_SURFACE_METADATA).');
  lines.push('  Regenerate: node packages/caws-cli/scripts/generate-command-reference.mjs');
  lines.push('  The sync test (tests/docs/command-reference-sync.test.js) fails CI if this');
  lines.push('  file drifts from the metadata.');
  lines.push('-->');
  lines.push('');
  lines.push('# CAWS CLI Command Reference');
  lines.push('');
  lines.push(
    'Every `caws` command group and its subcommands, generated from the same typed metadata the CLI uses to build `--help`. Run `caws <group> --help` for the live form.'
  );
  lines.push('');

  // Table of contents (group names in metadata order).
  lines.push('## Groups');
  lines.push('');
  for (const cmd of metadata) {
    const anchor = cmd.name.toLowerCase();
    lines.push(`- [\`caws ${cmd.name}\`](#caws-${anchor}) — ${cmd.description}`);
  }
  lines.push('');

  for (const cmd of metadata) {
    lines.push(`## \`caws ${cmd.name}\``);
    lines.push('');
    if (cmd.description) {
      lines.push(cmd.description);
      lines.push('');
    }
    if (cmd.kind === 'group') {
      const groupOptLines = (cmd.options || []).map(renderOption).filter(Boolean);
      if (groupOptLines.length) {
        lines.push('**Options:**');
        lines.push('');
        lines.push(...groupOptLines);
        lines.push('');
      }
      for (const sub of cmd.subcommands) {
        lines.push(...renderLeaf(sub, `${cmd.name} `, 3));
      }
    } else {
      // Leaf top-level command: render its arg/options under the group heading.
      if (cmd.argument) {
        const a = cmd.argument;
        lines.push(
          `**Argument:** \`${a.name}\`${a.required ? ' (required)' : ' (optional)'}${a.description ? ` — ${a.description}` : ''}`
        );
        lines.push('');
      }
      const optLines = (cmd.options || []).map(renderOption).filter(Boolean);
      if (optLines.length) {
        lines.push('**Options:**');
        lines.push('');
        lines.push(...optLines);
        lines.push('');
      }
    }
  }

  // Single trailing newline, no others — stable for byte-compare.
  return lines.join('\n').replace(/\n+$/, '\n');
}

// ─── Metadata loading ────────────────────────────────────────────────────────

/**
 * Resolve the canonical package's dist metadata when the local one is absent.
 * Linked git worktrees cannot build dist (build-cli's tsc fallback 404s on the
 * worktree tsconfig path), but they share the canonical .git — so resolve the
 * canonical checkout via `git rev-parse --git-common-dir` and read its dist.
 * The metadata is a pure data export, identical across trees for the same
 * committed source, so this is correct, not a workaround.
 */
function canonicalMetadataPath() {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: PKG_ROOT,
      encoding: 'utf8',
    }).trim();
    // commonDir is "<canonical>/.git"; its parent is the canonical checkout.
    const canonicalRoot = path.dirname(path.resolve(PKG_ROOT, commonDir));
    return path.join(canonicalRoot, 'packages', 'caws-cli', 'dist', 'shell', 'command-metadata.js');
  } catch {
    return null;
  }
}

export function loadMetadata(metadataPath = METADATA_PATH) {
  let resolved = metadataPath;
  if (!fs.existsSync(resolved)) {
    const canonical = canonicalMetadataPath();
    if (canonical && fs.existsSync(canonical)) {
      resolved = canonical;
    } else {
      throw new Error(
        `command metadata not found at ${metadataPath} (nor at the canonical dist) — run the package build first (the metadata is tsc-compiled into dist/).`
      );
    }
  }
  const mod = require(resolved);
  const meta = mod.COMMAND_SURFACE_METADATA;
  if (!Array.isArray(meta) || meta.length === 0) {
    throw new Error('COMMAND_SURFACE_METADATA is empty or not an array.');
  }
  return meta;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function main(argv) {
  const check = argv.includes('--check');
  const toStdout = argv.includes('--stdout');
  const rendered = renderReference(loadMetadata());

  if (toStdout) {
    process.stdout.write(rendered);
    return 0;
  }
  if (check) {
    const current = fs.existsSync(OUT_PATH) ? fs.readFileSync(OUT_PATH, 'utf8') : '';
    if (current === rendered) {
      process.stderr.write('command-reference.md is up to date.\n');
      return 0;
    }
    process.stderr.write(
      'command-reference.md is STALE. Regenerate:\n  node packages/caws-cli/scripts/generate-command-reference.mjs\n'
    );
    return 1;
  }
  fs.writeFileSync(OUT_PATH, rendered);
  process.stderr.write(`wrote ${path.relative(REPO_ROOT, OUT_PATH)}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`generate-command-reference: ${err.stack || err.message}\n`);
    process.exit(2);
  }
}
