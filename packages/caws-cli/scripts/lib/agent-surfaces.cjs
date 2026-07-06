'use strict';

// Pure agent-surface renderers + marker-region replacement.
// (CAWS-DOCS-AGENT-SURFACES-SINGLE-SOURCE-001)
//
// This is a CommonJS module so BOTH the ESM populator (.mjs) and the jest test
// (which runs under CommonJS without --experimental-vm-modules) can load the
// same pure functions. The .mjs wrapper adds the CLI/IO layer; the test
// exercises these functions directly.
//
// The single source of truth is KNOWN_SURFACES / IMPLEMENTED_SURFACES in
// src/init/hook-packs/register.ts. These renderers turn those constants into
// the human-visible strings that land in the hand-maintained docs.

/** The full value list for the --agent-surface flag, pipe-joined. */
function renderSurfaceList(known) {
  return known.join(' | ');
}

/** Each implemented surface as its own backtick span, comma-joined, for inline prose. */
function renderImplemented(implemented) {
  return implemented.map((s) => '`' + s + '`').join(', ');
}

/** Each declared-but-not-implemented surface as its own backtick span, comma-joined. */
function renderDeclaredOnly(known, implemented) {
  const implSet = new Set(implemented);
  return known
    .filter((s) => !implSet.has(s) && s !== 'none')
    .map((s) => '`' + s + '`')
    .join(', ');
}

/**
 * The README install-examples block: one `caws init --agent-surface <name>`
 * line per implemented surface, wrapped in a bash fence. (Only implemented
 * surfaces are installable; declaring a non-implemented surface errors in init.)
 */
function renderReadmeInstallBlock(implemented) {
  const lines = ['```bash'];
  for (const s of implemented) {
    lines.push('caws init --agent-surface ' + s);
  }
  lines.push('```');
  return lines.join('\n');
}

/**
 * The agent-integration-guide inline surface prose, replacing the
 * "claude-code|codex|opencode|...|none" bracket and the implemented/declared
 * sentence in the "No git-hook installer" bullet.
 */
function renderGuideSurfaceProse(known, implemented) {
  const list = renderSurfaceList(known);
  const impl = renderImplemented(implemented);
  const declared = renderDeclaredOnly(known, implemented);
  const implClause = impl + ' ' + (implemented.length === 1 ? 'is' : 'are') + ' implemented';
  const declaredCount = declared ? declared.split(', ').length : 0;
  const declaredClause = declaredCount
    ? '; ' + declared + ' ' + (declaredCount === 1 ? 'is a declared surface' : 'are declared surfaces') + ' but not implemented'
    : '';
  return (
    'Use `caws init --agent-surface <' +
    list +
    '>` to install a hook pack. ' +
    implClause +
    declaredClause +
    '.'
  );
}

/** Cross-lock: every implemented surface must be known. Returns the offenders. */
function surfaceConsistency(known, implemented) {
  const knownSet = new Set(known);
  return implemented.filter((s) => !knownSet.has(s));
}

function markerRegex(name) {
  // Three capture groups: (start-marker) (content) (end-marker).
  return new RegExp(
    '(<!--\\s*' + name + ':start\\s*-->)([\\s\\S]*?)(<!--\\s*' + name + ':end\\s*-->)',
    'm'
  );
}

/**
 * Replace the content between every `<!-- name:start -->` / `<!-- name:end -->`
 * pair in `text` with the corresponding rendered `content`. Throws if a marker
 * pair is missing (the doc drifted — a start without an end, or no marker at
 * all). Idempotent.
 *
 * `inline: true` marks a fill whose marker sits mid-line (e.g. inside a bullet)
 * — the content replaces the region with NO surrounding newlines so the line
 * stays intact. Block fills (default) get newline-wrapped content for a clean
 * fenced block.
 *
 * @param {string} text
 * @param {{ name: string, content: string, inline?: boolean }[]} fills
 */
function fillMarkers(text, fills) {
  let out = text;
  for (const fill of fills) {
    const name = fill.name;
    const re = markerRegex(name);
    const m = out.match(re);
    if (!m) {
      throw new Error(
        'marker pair <!-- ' + name + ':start --> / <!-- ' + name + ':end --> not found. ' +
          'Add the pair to the doc or remove it from the populator registry.'
      );
    }
    const replacement = fill.inline
      ? m[1] + ' ' + fill.content + ' ' + m[3]
      : m[1] + '\n' + fill.content + '\n' + m[3];
    out = out.replace(re, replacement);
  }
  return out;
}

module.exports = {
  renderSurfaceList,
  renderImplemented,
  renderDeclaredOnly,
  renderReadmeInstallBlock,
  renderGuideSurfaceProse,
  surfaceConsistency,
  fillMarkers,
};
