'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// Docs, scripts and shipped templates that must describe the live surface.
const SURFACES = [
  'scripts/verify.sh',
  'scripts/smoke-tests.mjs',
  'scripts/release-tag-publish.mjs',
  'README.md',
  'AGENTS.md',
  'docs/agents/full-guide.md',
  'docs/guides/hooks-and-agent-workflows.md',
  'docs/guides/caws-developer-guide.md',
  'packages/caws-cli/templates/CLAUDE.md',
  'packages/caws-cli/templates/agents.md',
];

// A line that names a removed command in order to say it is removed is
// documentation of the removal, not an invocation.
const NEGATIVE_CONTEXT =
  /(does \*{0,2}not\*{0,2} ship|removed|stale|replaced|Tried to run|no longer)/i;
// A statement that new specs do NOT pick a tier is the live doctrine.
const NEGATION = /\b(not|no|never|neither|nor|without)\b/i;

function readBytes(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel)).toString('utf8');
}

/** Returns one finding per census term occurrence in `text`. */
function scan(text) {
  const findings = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (/\bcaws validate\b/.test(line) && !NEGATIVE_CONTEXT.test(line)) {
      findings.push({ term: 'caws validate', line: i + 1, text: line.trim() });
    }
    if (/\bcaws attest\b/.test(line)) {
      findings.push({ term: 'caws attest', line: i + 1, text: line.trim() });
    }
    if (/\bcaws waivers\b|dist\/index\.js waivers\b/.test(line)) {
      findings.push({ term: 'caws waivers (plural)', line: i + 1, text: line.trim() });
    }
  });

  const flat = text.replace(/[\s#*`>]+/g, ' ');
  for (const m of flat.matchAll(
    /parallel setup.{0,120}deferred|deferred.{0,120}parallel setup/gi
  )) {
    findings.push({ term: 'parallel setup deferred', text: m[0] });
  }

  const tierInstructions = [
    /\b(infer|declare|choose|pick|select|confirm|assign|check)\w*\b[^.\n]{0,40}\b(risk[- ]?tier|the tier)\b/gi,
    /\b(appropriate|correct) risk[- ]?tier\b/gi,
    /\brisk[- ]?tier is (appropriate|correct)\b/gi,
  ];
  for (const re of tierInstructions) {
    for (const m of flat.matchAll(re)) {
      const before = flat.slice(Math.max(0, m.index - 60), m.index);
      if (NEGATION.test(m[0]) || NEGATION.test(before)) continue;
      findings.push({ term: 'choose a risk tier', text: m[0] });
    }
  }
  return findings;
}

describe('dead mechanisms are not referenced by docs, scripts or shipped templates', () => {
  test('the scan reads every surface as non-empty bytes (positive control)', () => {
    const markers = {
      'scripts/verify.sh': 'specs validate',
      'scripts/smoke-tests.mjs': 'waiver --help',
      'scripts/release-tag-publish.mjs': 'caws-kernel-v',
      'README.md': 'worktree create',
      'AGENTS.md': 'worktree create',
      'docs/agents/full-guide.md': 'no risk tier',
      'docs/guides/hooks-and-agent-workflows.md': 'scope.in',
      'docs/guides/caws-developer-guide.md': 'scope.in',
      'packages/caws-cli/templates/CLAUDE.md': 'amend-scope',
      'packages/caws-cli/templates/agents.md': 'amend-scope',
    };
    expect(Object.keys(markers).sort()).toEqual([...SURFACES].sort());
    for (const rel of SURFACES) {
      const bytes = readBytes(rel);
      expect(bytes.length).toBeGreaterThan(200);
      expect(bytes).toContain(markers[rel]);
    }
  });

  test('the scan flags each census term when present (break check)', () => {
    const dead = {
      'caws validate': '  caws validate || exit 1',
      'caws attest': 'caws attest --format=slsa',
      'caws waivers (plural)': 'node packages/caws-cli/dist/index.js waivers list',
      'parallel setup deferred':
        'there is no `caws parallel setup` — that surface is deferred to v11.3+',
      'choose a risk tier':
        '- Infer and declare the tier in your plan\n3. **Check risk tier**: T1, T2, T3.',
    };
    for (const [term, sample] of Object.entries(dead)) {
      expect(scan(sample).map((f) => f.term)).toContain(term);
    }
    // Live doctrine that mentions the same words must not trip the scan.
    expect(scan('v11 does not ship `caws validate` (removed in v11.0).')).toEqual([]);
    expect(scan('New specs do not select, infer or inherit a risk tier.')).toEqual([]);
    expect(
      scan('There is no `caws parallel setup`; it does not exist and is not planned.')
    ).toEqual([]);
  });

  test.each(SURFACES)('%s names no dead mechanism', (rel) => {
    expect(scan(readBytes(rel))).toEqual([]);
  });

  test('the unshipped OIDC_SETUP.md template stays removed', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'packages/caws-cli/templates/OIDC_SETUP.md'))).toBe(
      false
    );
  });
});
