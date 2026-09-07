#!/usr/bin/env node
// Generate packages/caws-cli/docs/command-reference.md from COMMAND_SURFACE_METADATA
// (CAWS-DOCS-COMMAND-REFERENCE-GEN-001).
//
// COMMAND_SURFACE_METADATA (src/shell/command-metadata.ts → dist) is the typed
// single source register.ts consumes to build every command's --help. This
// generator renders that same metadata to markdown, so the consumer-facing
// command reference CANNOT drift from the actual CLI surface: a command, arg,
// or visible flag added/removed/renamed in the metadata changes both --help
// and this doc, and the sync test fails CI if the packaged artifact is stale.
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// scripts/ -> caws-cli (package root) -> packages -> repo root
const PKG_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..');
const OUT_PATH = path.join(PKG_ROOT, 'docs', 'command-reference.md');
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
  for (const a of leaf.arguments ?? (leaf.argument ? [leaf.argument] : [])) {
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
  for (const a of leaf.arguments ?? (leaf.argument ? [leaf.argument] : [])) {
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
  lines.push('updated: 2026-09-07');
  lines.push('audience: consumer');
  lines.push('generated: true');
  lines.push('source: packages/caws-cli/src/shell/command-metadata.ts');
  lines.push('---');
  lines.push('');
  lines.push('<!--');
  lines.push('  GENERATED FILE — do not edit by hand.');
  lines.push('  Source: packages/caws-cli/src/shell/command-metadata.ts (COMMAND_SURFACE_METADATA).');
  lines.push('  Regenerate: node packages/caws-cli/scripts/generate-command-reference.mjs');
  lines.push('  Package documentation checks fail if this');
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

  const renderCommand = (cmd, prefix = '', depth = 2) => {
    if (cmd.kind === 'leaf') {
      lines.push(...renderLeaf(cmd, prefix, depth));
      return;
    }
    lines.push(`${'#'.repeat(depth)} \`caws ${prefix}${cmd.name}\``, '', cmd.description, '');
    if (cmd.defaultAction) lines.push(`Without a subcommand: ${cmd.defaultAction.description}`, '');
    const options = (cmd.options || []).map(renderOption).filter(Boolean);
    if (options.length) lines.push('**Options:**', '', ...options, '');
    for (const child of cmd.subcommands) renderCommand(child, `${prefix}${cmd.name} `, depth + 1);
  };
  for (const cmd of metadata) renderCommand(cmd);

  // Single trailing newline, no others — stable for byte-compare.
  return lines.join('\n').replace(/\n+$/, '\n');
}

// ─── Metadata loading ────────────────────────────────────────────────────────

/** Load only this checkout’s build; another worktree may contain different metadata. */
export function loadMetadata(metadataPath = METADATA_PATH) {
  if (!fs.existsSync(metadataPath)) throw new Error(`command metadata not found at ${metadataPath}; build this checkout before generating docs`);
  const resolved = metadataPath;
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
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, rendered);
  process.stderr.write(`wrote ${path.relative(REPO_ROOT, OUT_PATH)}\n`);
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`generate-command-reference: ${err.stack || err.message}\n`);
    process.exit(2);
  }
}
