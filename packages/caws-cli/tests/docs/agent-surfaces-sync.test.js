'use strict';

/**
 * Agent-surfaces single-source sync gate
 * (CAWS-DOCS-AGENT-SURFACES-SINGLE-SOURCE-001).
 *
 * The surface list is authored ONCE in register.ts (KNOWN_SURFACES /
 * IMPLEMENTED_SURFACES) and consumed everywhere. This suite is the drift gate:
 * it fails CI if the hand-maintained docs (README.md,
 * docs/guides/agent-integration-guide.md) fall out of sync with the constants,
 * OR if IMPLEMENTED_SURFACES lists a surface not in KNOWN_SURFACES.
 *
 * It exercises the populator two ways:
 *   1. Integration: shell out to `populate-doc-markers.mjs --check` (the same
 *      command CI / a developer runs). This catches a stale committed doc.
 *   2. Unit: directly assert the populator's pure renderers produce the
 *      expected shape from the live constants, and the consistency cross-lock.
 *
 * The SUT is the compiled surface: require('../../dist/init/hook-packs/register')
 * and the .mjs populator (loaded via dynamic import). `npm run build` compiles
 * TS -> dist before jest runs.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI_PKG_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(CLI_PKG_ROOT, '..', '..');
const POPULATOR = path.join(CLI_PKG_ROOT, 'scripts', 'populate-doc-markers.mjs');

const {
  KNOWN_SURFACES,
  IMPLEMENTED_SURFACES,
} = require('../../dist/init/hook-packs/register');

// Pure renderers + marker replacement live in the CommonJS helper so the jest
// sandbox (CommonJS, no --experimental-vm-modules) can load them directly. The
// ESM populator (.mjs) wraps these for the CLI; this test exercises the same
// implementation via the .cjs.
const populator = require('../../scripts/lib/agent-surfaces.cjs');

describe('surface constants are mutually consistent', () => {
  test('every IMPLEMENTED surface is also KNOWN', () => {
    // The cross-lock: a surface wired into resolveHookPack must also be a
    // recognized --agent-surface value, or init rejects it at the validator.
    const knownSet = new Set(KNOWN_SURFACES);
    const offenders = IMPLEMENTED_SURFACES.filter((s) => !knownSet.has(s));
    expect(offenders).toEqual([]);
  });

  test('KNOWN_SURFACES includes none (the explicit opt-out)', () => {
    expect(KNOWN_SURFACES).toContain('none');
  });

  test('zcode is implemented (canary — update this when surfaces change)', () => {
    expect(IMPLEMENTED_SURFACES).toContain('zcode');
  });
});

describe('populator renderers: derived shape from the live constants', () => {
  test('renderSurfaceList pipe-joins every known surface', () => {
    const list = populator.renderSurfaceList(KNOWN_SURFACES);
    expect(list).toBe(KNOWN_SURFACES.join(' | '));
    // Every known surface appears.
    for (const s of KNOWN_SURFACES) {
      expect(list).toContain(s);
    }
  });

  test('renderReadmeInstallBlock emits one install line per implemented surface', () => {
    const block = populator.renderReadmeInstallBlock(IMPLEMENTED_SURFACES);
    expect(block.startsWith('```bash\n')).toBe(true);
    expect(block.trim().endsWith('```')).toBe(true);
    for (const s of IMPLEMENTED_SURFACES) {
      expect(block).toContain(`caws init --agent-surface ${s}`);
    }
  });

  test('renderGuideSurfaceProse names implemented and declared-only surfaces', () => {
    const prose = populator.renderGuideSurfaceProse(KNOWN_SURFACES, IMPLEMENTED_SURFACES);
    const implSet = new Set(IMPLEMENTED_SURFACES);
    for (const s of IMPLEMENTED_SURFACES) {
      expect(prose).toContain(s);
    }
    // Declared-but-not-implemented surfaces appear too.
    for (const s of KNOWN_SURFACES) {
      if (s === 'none' || implSet.has(s)) continue;
      expect(prose).toContain(s);
    }
  });

  test('surfaceConsistency flags a fabricated offender', () => {
    // Falsifiability: the cross-lock must actually catch a violation, not pass vacuously.
    const offenders = populator.surfaceConsistency(
      ['claude-code', 'codex'],
      ['claude-code', 'bogus-surface']
    );
    expect(offenders).toEqual(['bogus-surface']);
  });
});

describe('fillMarkers: marker-region replacement semantics', () => {
  test('block fill wraps content with newlines; idempotent on re-run', () => {
    const text = [
      'intro',
      '<!-- m:start -->',
      'old',
      '<!-- m:end -->',
      'outro',
    ].join('\n');
    const fill = [{ name: 'm', content: 'NEW' }];
    const once = populator.fillMarkers(text, fill);
    const twice = populator.fillMarkers(once, fill);
    expect(once).toContain('<!-- m:start -->\nNEW\n<!-- m:end -->');
    expect(twice).toBe(once);
  });

  test('inline fill keeps the line intact (no surrounding newlines)', () => {
    const text = '- bullet <!-- m:start -->OLD<!-- m:end --> after.';
    const fill = [{ name: 'm', content: 'NEW', inline: true }];
    const out = populator.fillMarkers(text, fill);
    expect(out).toBe('- bullet <!-- m:start --> NEW <!-- m:end --> after.');
  });

  test('a missing marker pair throws (drift detection)', () => {
    const text = 'no markers here';
    expect(() => populator.fillMarkers(text, [{ name: 'm', content: 'X' }])).toThrow(
      /not found/
    );
  });
});

describe('committed docs are in sync with the constants (integration gate)', () => {
  // This is the drift gate that catches a developer who edited register.ts but
  // forgot to re-run `npm run docs:populate`. It mirrors the
  // generate-command-reference --check discipline, extended to the
  // hand-maintained marker docs.
  test('populate-doc-markers.mjs --check exits 0 against the committed docs', () => {
    let exitCode = 0;
    let stderr = '';
    try {
      stderr = execFileSync('node', [POPULATOR, '--check'], {
        cwd: CLI_PKG_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (e) {
      exitCode = e.status ?? 1;
      stderr = (e.stderr || '').toString();
    }
    if (exitCode !== 0) {
      // Surface the populator's own STALE message in the failure output.
      throw new Error(
        `docs are STALE — re-run: node packages/caws-cli/scripts/populate-doc-markers.mjs\n${stderr}`
      );
    }
    expect(exitCode).toBe(0);
  });

  test('README.md carries the agent-surfaces-install marker pair', () => {
    const readme = fs.readFileSync(path.join(CLI_PKG_ROOT, 'README.md'), 'utf8');
    expect(readme).toMatch(/<!-- agent-surfaces-install:start -->/);
    expect(readme).toMatch(/<!-- agent-surfaces-install:end -->/);
  });

  test('agent-integration-guide.md carries the agent-surfaces-prose marker pair', () => {
    const guide = fs.readFileSync(
      path.join(REPO_ROOT, 'docs', 'guides', 'agent-integration-guide.md'),
      'utf8'
    );
    expect(guide).toMatch(/<!-- agent-surfaces-prose:start -->/);
    expect(guide).toMatch(/<!-- agent-surfaces-prose:end -->/);
  });
});
