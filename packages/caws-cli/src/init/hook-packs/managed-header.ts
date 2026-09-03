// Managed-header parsing (leaf module).
//
// CAWS-TELEMETRY-REPAIR-RESILIENCE-001: extracted from init/hook-install.ts
// so consumers that only need to IDENTIFY a managed file (the store's doctor
// snapshot, the init retire path, tests) do not drag the install machinery
// (child_process, template resolution, unified-diff) into their import graph.
// This module imports ONLY the ManagedHeader type — no fs, no install
// surface. Behavior is the parser that shipped in hook-install, verbatim;
// hook-install re-exports parseManagedHeader so existing importers are
// unchanged.
//
// Contract (managed-header-parser): parseManagedHeader(content) returns the
// managed header for `CAWS-MANAGED-HOOK` blocks — comment-line form
// (`# key: value` after an optional shebang or `<!--` wrapper, e.g. installed
// hook scripts and `.dsh/AGENTS.md`-style markers) or JSON form (the
// description field carrying `key=value` pairs, e.g. settings.json) — or
// null when the content is not CAWS-managed.

import type { ManagedHeader } from './types';

/** Match a managed-header block at the top of a file. The block consists
 *  of consecutive `# CAWS-...` lines after an optional shebang or
 *  HTML/JSDoc comment opener. Exported because non-parsing consumers key
 *  on the same marker string (e.g. hook-install's codex equivalence check
 *  strips a managed `description` before comparing) — one constant, one
 *  source of truth. */
export const HEADER_MARKER = 'CAWS-MANAGED-HOOK';

function parseJsonManagedHeader(content: string): ManagedHeader | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const description = (parsed as { description?: unknown }).description;
  if (typeof description !== 'string' || !description.includes(HEADER_MARKER)) {
    return null;
  }

  const readString = (key: string): string => {
    const match = description.match(new RegExp(`${key}=([^\\s.]+)`));
    return match ? match[1] ?? '' : '';
  };

  const hookPack = readString('hook_pack');
  const hookPackVersion = Number.parseInt(readString('hook_pack_version'), 10);
  const cawsMinMajor = Number.parseInt(readString('caws_min_major'), 10);
  const lineageRefs = readString('lineage_refs')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));

  if (!hookPack || Number.isNaN(hookPackVersion) || hookPackVersion <= 0) {
    return null;
  }
  return {
    hookPack,
    hookPackVersion,
    cawsMinMajor: Number.isNaN(cawsMinMajor) ? 0 : cawsMinMajor,
    lineageRefs,
  };
}

/** Parse a managed header from file content. Returns null when not
 *  present. Tolerant of leading shebang and of `<!--`/`-->`-style
 *  comment wrappers (for Markdown). */
export function parseManagedHeader(content: string): ManagedHeader | null {
  const jsonHeader = parseJsonManagedHeader(content);
  if (jsonHeader) return jsonHeader;

  // Search the first ~30 lines for the marker. This is large enough to
  // tolerate shebang + HTML comment wrapper but small enough to stay
  // fast on big files.
  const lines = content.split('\n').slice(0, 30);
  let inBlock = false;
  let hookPack = '';
  let hookPackVersion = 0;
  let cawsMinMajor = 0;
  let lineageRefs: number[] = [];
  let sawMarker = false;

  for (const raw of lines) {
    const line = raw.trim().replace(/^<!--\s*/, '').replace(/\s*-->\s*$/, '');
    if (!line) continue;

    if (line.includes(HEADER_MARKER)) {
      sawMarker = true;
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;

    // The block consists of `# key: value` lines. First non-comment
    // line ends the block.
    if (!line.startsWith('#')) break;

    const stripped = line.replace(/^#\s*/, '');
    const colon = stripped.indexOf(':');
    if (colon < 0) continue;
    const key = stripped.slice(0, colon).trim();
    const value = stripped.slice(colon + 1).trim();

    switch (key) {
      case 'hook_pack':
        hookPack = value;
        break;
      case 'hook_pack_version': {
        const n = Number.parseInt(value, 10);
        if (!Number.isNaN(n)) hookPackVersion = n;
        break;
      }
      case 'caws_min_major': {
        const n = Number.parseInt(value, 10);
        if (!Number.isNaN(n)) cawsMinMajor = n;
        break;
      }
      case 'lineage_refs': {
        lineageRefs = value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map((s) => Number.parseInt(s, 10))
          .filter((n) => !Number.isNaN(n));
        break;
      }
      // 'do_not_edit_directly' is informational; ignored here.
    }
  }

  if (!sawMarker || !hookPack || hookPackVersion <= 0) return null;
  return {
    hookPack,
    hookPackVersion,
    cawsMinMajor,
    lineageRefs,
  };
}
