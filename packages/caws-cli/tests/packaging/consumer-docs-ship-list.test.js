'use strict';

// CAWS-DOCS-SHIP-CONSUMER-SET-001 — the package ships exactly the
// audience:consumer docs, derived purely from front-matter.
//
// Two distinct invariants:
//   DERIVATION: the repo-root audience:consumer set == the staged set the
//               stage-consumer-docs.mjs script produces.
//   ARTIFACT:   `npm pack` output contains exactly those consumer docs under
//               docs/ and no maintainer/internal doc.
//
// The stager is ESM; the CJS suite drives it (and npm pack) as subprocesses.

const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PKG_ROOT = path.join(REPO_ROOT, 'packages', 'caws-cli');
const SRC_DOCS = path.join(REPO_ROOT, 'docs');
const STAGER = path.join(PKG_ROOT, 'scripts', 'stage-consumer-docs.mjs');
const CLEANER = path.join(PKG_ROOT, 'scripts', 'clean-staged-docs.mjs');

// js-yaml resolves via node's normal lookup (hoisted to the monorepo root).
const yaml = require('js-yaml');

// Independent front-matter reader so the test does not merely echo the script's
// own logic (avoids "tests its own bug").
function audienceOf(absPath) {
  const text = fs.readFileSync(absPath, 'utf8');
  const norm = text.replace(/\r\n/g, '\n');
  if (!norm.startsWith('---\n')) return null;
  const end = norm.indexOf('\n---', 4);
  if (end === -1) return null;
  let parsed;
  try {
    parsed = yaml.load(norm.slice(4, end + 1));
  } catch {
    return null;
  }
  return parsed && typeof parsed === 'object' ? (parsed.audience ?? null) : null;
}

function listMd(dir, relTo) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(path.relative(relTo, abs));
    }
  };
  walk(dir);
  return out.sort();
}

// The expected consumer set, computed independently from the repo docs.
function expectedConsumerSet() {
  return listMd(SRC_DOCS, REPO_ROOT)
    .filter((rel) => audienceOf(path.join(REPO_ROOT, rel)) === 'consumer')
    .sort();
}

describe('CAWS-DOCS-SHIP-CONSUMER-SET-001: consumer docs ship-list', () => {
  afterEach(() => {
    // Never leave a staged docs/ tree behind.
    spawnSync('node', [CLEANER], { encoding: 'utf8' });
  });

  // ── DERIVATION invariant ──────────────────────────────────────────────────
  it('the stager stages EXACTLY the repo-root audience:consumer set', () => {
    const expected = expectedConsumerSet();
    expect(expected.length).toBeGreaterThanOrEqual(7); // 5 guides + cmd-ref + migration

    const r = spawnSync('node', [STAGER], { encoding: 'utf8' });
    expect(r.status).toBe(0);

    const stagedDir = path.join(PKG_ROOT, 'docs');
    const staged = listMd(stagedDir, stagedDir).map((p) => `docs/${p}`).sort();
    expect(staged).toEqual(expected);
  });

  it('the stager fails closed: every staged doc actually carries audience:consumer', () => {
    spawnSync('node', [STAGER], { encoding: 'utf8' });
    const stagedDir = path.join(PKG_ROOT, 'docs');
    for (const rel of listMd(stagedDir, stagedDir)) {
      expect(audienceOf(path.join(stagedDir, rel))).toBe('consumer');
    }
  });

  it('DOCUMENTATION_STANDARDS.md (audience: maintainer) is NOT in the derived set', () => {
    expect(expectedConsumerSet()).not.toContain('docs/DOCUMENTATION_STANDARDS.md');
  });

  // ── ARTIFACT invariant ────────────────────────────────────────────────────
  it('npm pack ships EXACTLY the consumer docs under docs/ and no internal doc', () => {
    // `npm pack --dry-run --json` fires prepack (stage) + postpack (clean).
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: PKG_ROOT,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    const parsed = JSON.parse(out);
    const files = (parsed[0]?.files || []).map((f) => f.path);
    const shippedDocs = files.filter((p) => p.startsWith('docs/')).sort();

    const expected = expectedConsumerSet();
    expect(shippedDocs).toEqual(expected);

    // Explicit exclusions.
    expect(files.some((p) => p.includes('DOCUMENTATION_STANDARDS'))).toBe(false);
    expect(shippedDocs.every((p) => p.endsWith('.md'))).toBe(true);
    // No broad docs tree: every shipped docs path is in the consumer set.
    expect(shippedDocs.filter((p) => !expected.includes(p))).toEqual([]);
  });

  it('package.json files ships docs/** (the staged boundary), not individual doc paths', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
    expect(pkg.files).toContain('docs/**');
    // Curation lives in front-matter, not in a static per-file list.
    const individualDocEntries = pkg.files.filter(
      (f) => f.startsWith('docs/') && f !== 'docs/**'
    );
    expect(individualDocEntries).toEqual([]);
  });

  it('prepack/postpack are wired and clean-first', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.prepack).toMatch(/clean-staged-docs/);
    expect(pkg.scripts.prepack).toMatch(/stage-consumer-docs/);
    // clean BEFORE stage (beginning-clean is the safety invariant).
    expect(pkg.scripts.prepack.indexOf('clean-staged-docs')).toBeLessThan(
      pkg.scripts.prepack.indexOf('stage-consumer-docs')
    );
    expect(pkg.scripts.postpack).toMatch(/clean-staged-docs/);
  });
});
