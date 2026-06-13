#!/usr/bin/env node
/**
 * RELEASE-AUTOMATION-GUARD-NONPUBLISH-COMMITS-001 — dry-run evidence harness.
 *
 * Exercises the three-layer release guard against six representative commit
 * patterns and prints the decision each layer makes for each pattern. Run:
 *
 *   node scripts/release-guard-dry-run.mjs
 *
 * Output is plain text suitable for slice-closure evidence capture. No git
 * mutations, no semantic-release invocation, no npm publish.
 *
 * Layers exercised:
 *   1. semantic-release releaseRules deny list (in-process simulation)
 *   2. .github/workflows/release.yml path-trigger filter (in-process match
 *      against the workflow's declared paths)
 *   3. classifyShippingChanges() (the pure classifier in
 *      scripts/multi-package-release.mjs)
 *
 * Each pattern is a tuple of:
 *   - name              human-readable
 *   - commitType        conventional-commit type
 *   - scope             conventional-commit scope (e.g., "cli", "docs")
 *   - changedFiles      list of repo-relative paths in the simulated commit
 *   - expectedOutcome   "publish-caws-cli" | "no-publish"
 *   - expectedReason    short string describing why
 *
 * Acceptance reference:
 *   A1 specs-only            → no publish
 *   A2 docs-only             → no publish
 *   A4 tests-only            → no publish (workflow runs, Layer 3 blocks)
 *   A5 caws-cli-shipping     → publish
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import {
  PACKAGES,
  NON_OWNED_SCOPES,
  RELEASE_CAPABLE_TYPES,
  classifyShippingChanges,
} from './multi-package-release.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// ─── Layer 2: workflow path-trigger simulator ─────────────────────────────

function loadWorkflowTriggerPaths() {
  const wf = yaml.load(
    readFileSync(path.join(rootDir, '.github/workflows/release.yml'), 'utf8')
  );
  // GH Actions YAML — the `on:` key parses to a `true` literal under js-yaml
  // because `on` is a YAML boolean. Pull it from the raw triggers map.
  const trigger = wf.on || wf[true] || wf['on'];
  if (!trigger || !trigger.push || !Array.isArray(trigger.push.paths)) {
    throw new Error('release.yml has no push.paths trigger list');
  }
  return trigger.push.paths;
}

function workflowMatchesAny(triggerPaths, changedFiles) {
  // Each trigger path may be a literal or a `prefix/**` glob.
  const matchers = triggerPaths.map((p) => {
    if (p.endsWith('/**')) {
      const prefix = p.slice(0, -3);
      return (f) => f.startsWith(prefix);
    }
    return (f) => f === p;
  });
  const matched = changedFiles.filter((f) => matchers.some((m) => m(f)));
  return { wouldTrigger: matched.length > 0, matched };
}

// ─── Layer 1: scope-deny rules simulator ──────────────────────────────────

function scopeWouldBeDeniedForCli(commitType, scope) {
  // The deny list applies to release-capable types. For each non-owned
  // scope, a deny rule { type, scope, release: false } is emitted. We
  // simulate the rule that would fire for this (type, scope) commit.
  const cliPkg = PACKAGES.find((p) => p.scope === 'cli');
  if (!cliPkg) return { applies: false, reason: 'no caws-cli package in PACKAGES' };

  if (!RELEASE_CAPABLE_TYPES.includes(commitType)) {
    return { applies: false, reason: `commit type "${commitType}" is not release-capable` };
  }
  if (scope === cliPkg.scope || scope === `packages/${path.basename(cliPkg.path)}`) {
    return { applies: false, reason: 'commit scope is owned by caws-cli' };
  }
  if (NON_OWNED_SCOPES.includes(scope)) {
    return { applies: true, reason: `Layer 1 deny rule { type: ${commitType}, scope: ${scope}, release: false }` };
  }
  return {
    applies: false,
    reason: `scope "${scope}" not in deny list; Layer 1 does not block (relies on Layer 2/3)`,
  };
}

// ─── Six representative patterns ──────────────────────────────────────────

const PATTERNS = [
  {
    id: 'A1',
    name: 'specs-only',
    commitType: 'chore',
    scope: 'specs',
    changedFiles: [
      '.caws/specs/QG-HOOKS-EXTRACT-001.yaml',
      '.caws/specs/QUALITY-GATES-PACKAGE-DEPRECATE-001.yaml',
    ],
    expectedOutcome: 'no-publish',
    expectedReason: 'Layer 2 path filter excludes .caws/specs/',
  },
  {
    id: 'A2',
    name: 'docs-only',
    commitType: 'docs',
    scope: 'caws',
    changedFiles: ['docs/guides/hook-packs.md'],
    expectedOutcome: 'no-publish',
    expectedReason: 'Layer 2 path filter excludes docs/',
  },
  {
    id: 'A4',
    name: 'tests-only',
    commitType: 'test',
    scope: 'caws-cli',
    changedFiles: ['packages/caws-cli/tests/integration/gates-cli.test.js'],
    expectedOutcome: 'no-publish',
    expectedReason: 'Layer 2 triggers (path under packages/caws-cli/**); Layer 3 classifies as non-shipping',
  },
  {
    id: 'A5',
    name: 'caws-cli-shipping',
    commitType: 'fix',
    scope: 'caws-cli',
    changedFiles: [
      'packages/caws-cli/src/shell/commands/gates.ts',
      'packages/caws-cli/dist/index.js',
    ],
    expectedOutcome: 'publish-caws-cli',
    expectedReason: 'Layer 2 triggers; Layer 3 classifies src/ and dist/ as shipping; Layer 1 allows scope:caws-cli',
  },
  // E1-E2: regression cases for bug-fix pass on 2026-05-19.
  {
    id: 'E1',
    name: 'package-script change (build-cli.js)',
    commitType: 'fix',
    scope: 'caws-cli',
    changedFiles: ['packages/caws-cli/scripts/build-cli.js'],
    expectedOutcome: 'publish-caws-cli',
    expectedReason: 'Layer 2 triggers; Layer 3 classifies <pkg>/scripts/ as shipping (build/publish input affects dist output)',
  },
  {
    id: 'E2',
    name: 'package-script change (fresh-install-smoke.mjs)',
    commitType: 'fix',
    scope: 'caws-cli',
    changedFiles: ['packages/caws-cli/scripts/fresh-install-smoke.mjs'],
    expectedOutcome: 'publish-caws-cli',
    expectedReason: 'Layer 2 triggers; Layer 3 classifies <pkg>/scripts/ as shipping (prepublishOnly invokes this script)',
  },
];

// ─── Evidence emission ────────────────────────────────────────────────────

function runEvidence() {
  const triggerPaths = loadWorkflowTriggerPaths();
  const cliPkg = PACKAGES.find((p) => p.scope === 'cli');

  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('RELEASE-AUTOMATION-GUARD-NONPUBLISH-COMMITS-001 — dry-run evidence');
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`Generated:  ${new Date().toISOString()}`);
  console.log(`PACKAGES:   ${PACKAGES.map((p) => p.name).join(', ')}`);
  console.log(`Workflow trigger paths (${triggerPaths.length}):`);
  for (const p of triggerPaths) console.log(`  - ${p}`);
  console.log(`NON_OWNED_SCOPES denied for caws-cli (${NON_OWNED_SCOPES.length}):`);
  console.log(`  ${NON_OWNED_SCOPES.join(', ')}`);
  console.log(`RELEASE_CAPABLE_TYPES (${RELEASE_CAPABLE_TYPES.length}):`);
  console.log(`  ${RELEASE_CAPABLE_TYPES.join(', ')}`);
  console.log('');

  let passed = 0;
  let failed = 0;
  for (const pattern of PATTERNS) {
    const header = `[${pattern.id}] ${pattern.name}`;
    console.log('───────────────────────────────────────────────────────────────────────────');
    console.log(header);
    console.log(`  commit: ${pattern.commitType}(${pattern.scope}): ...`);
    console.log('  files:');
    for (const f of pattern.changedFiles) console.log(`    - ${f}`);
    console.log('');

    // Layer 2.
    const wfHit = workflowMatchesAny(triggerPaths, pattern.changedFiles);
    console.log(`  Layer 2 (workflow trigger): ${wfHit.wouldTrigger ? 'TRIGGER' : 'no-trigger'}`);
    if (wfHit.matched.length > 0) console.log(`    matched paths: ${wfHit.matched.join(', ')}`);

    // Layer 1.
    const denial = scopeWouldBeDeniedForCli(pattern.commitType, pattern.scope);
    console.log(`  Layer 1 (scope deny):       ${denial.applies ? 'DENY' : 'allow'}`);
    console.log(`    ${denial.reason}`);

    // Layer 3.
    const ship = classifyShippingChanges(cliPkg, pattern.changedFiles);
    console.log(`  Layer 3 (shipping files):   ${ship.eligible ? 'ELIGIBLE' : 'not-eligible'}`);
    console.log(`    ${ship.reason}`);
    if (ship.shipping.length > 0) {
      console.log(`    shipping (${ship.shipping.length}): ${ship.shipping.join(', ')}`);
    }
    if (ship.nonShipping.length > 0) {
      console.log(`    non-shipping (${ship.nonShipping.length}): ${ship.nonShipping.join(', ')}`);
    }

    // Composed verdict.
    //   - Layer 2 false  → workflow never runs        → no-publish
    //   - Layer 2 true   → script runs, Layer 1+3 evaluate
    //   - Layer 1 deny   → commit-analyzer says no    → no-publish
    //   - Layer 3 false  → script skips package       → no-publish
    //   - All allow      → publish
    let composed;
    if (!wfHit.wouldTrigger) composed = { outcome: 'no-publish', by: 'Layer 2 (workflow trigger)' };
    else if (denial.applies) composed = { outcome: 'no-publish', by: 'Layer 1 (scope deny)' };
    else if (!ship.eligible) composed = { outcome: 'no-publish', by: 'Layer 3 (no shipping files)' };
    else composed = { outcome: 'publish-caws-cli', by: 'all layers permit' };

    const ok = composed.outcome === pattern.expectedOutcome;
    console.log('');
    console.log(`  expected:   ${pattern.expectedOutcome}  (${pattern.expectedReason})`);
    console.log(`  composed:   ${composed.outcome}  (${composed.by})`);
    console.log(`  verdict:    ${ok ? 'PASS' : 'FAIL'}`);
    console.log('');
    if (ok) passed++;
    else failed++;
  }

  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log(`SUMMARY: ${passed} passed, ${failed} failed (${PATTERNS.length} total)`);
  console.log('═══════════════════════════════════════════════════════════════════════════');
  process.exit(failed === 0 ? 0 : 1);
}

runEvidence();
