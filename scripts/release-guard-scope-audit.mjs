#!/usr/bin/env node
/**
 * RELEASE-AUTOMATION-GUARD-NONPUBLISH-COMMITS-001 — scope-completeness audit.
 *
 * Parses `git log --format=%s main`, extracts every conventional-commit scope,
 * and reports any scope that is NOT in NON_OWNED_SCOPES and NOT in the
 * package-owned scope list. Such scopes silently fall through to the angular
 * preset default (fix → patch, feat → minor) and could trigger an unwanted
 * release.
 *
 * This is a maintenance-hazard surfacer for Layer 1's hand-maintained list.
 *
 * Output:
 *   - Total commits scanned
 *   - Scopes found (with commit counts)
 *   - Scopes denied (in NON_OWNED_SCOPES)
 *   - Scopes owned (cli, packages/caws-cli)
 *   - Scopes UNCLASSIFIED (real maintenance hazards — add to deny list)
 *   - Unscoped commits (preset default applies; out of scope for this audit)
 *
 * Exit:
 *   0 if no UNCLASSIFIED scopes found
 *   1 if any UNCLASSIFIED scopes found (CI can gate on this)
 */

import { execSync } from 'node:child_process';

import { PACKAGES, NON_OWNED_SCOPES, MULTI_SCOPE_DENIES } from './multi-package-release.mjs';

// Get conventional-commit subject lines from git log.
const branch = process.argv[2] || 'main';
let log;
try {
  log = execSync(`git log --format=%s ${branch}`, { encoding: 'utf8' });
} catch (e) {
  console.error(`FATAL: git log failed: ${e.message}`);
  process.exit(2);
}

const lines = log.split('\n').filter(Boolean);

// Conventional commit pattern: type(scope)!?: subject  OR  type!?: subject
const CC_RE = /^([a-zA-Z]+)(?:\(([^)]+)\))?!?:\s/;

const scopeCount = new Map();
let unscoped = 0;
let nonCC = 0;
for (const line of lines) {
  const m = line.match(CC_RE);
  if (!m) {
    nonCC++;
    continue;
  }
  const scope = m[2];
  if (!scope) {
    unscoped++;
    continue;
  }
  scopeCount.set(scope, (scopeCount.get(scope) || 0) + 1);
}

// Owned scopes: the short scope per PACKAGES entry + the path form +
// any additionalOwnedScopes declared on the package.
const ownedScopes = new Set();
for (const pkg of PACKAGES) {
  ownedScopes.add(pkg.scope);
  ownedScopes.add(`packages/${pkg.path.split('/').pop()}`);
  for (const s of pkg.additionalOwnedScopes ?? []) ownedScopes.add(s);
}

const deniedSet = new Set([...NON_OWNED_SCOPES, ...MULTI_SCOPE_DENIES]);

const classified = { owned: [], denied: [], unclassified: [] };
for (const [scope, count] of scopeCount.entries()) {
  const bucket = ownedScopes.has(scope) ? 'owned' : deniedSet.has(scope) ? 'denied' : 'unclassified';
  classified[bucket].push({ scope, count });
}
for (const k of Object.keys(classified)) {
  classified[k].sort((a, b) => b.count - a.count);
}

console.log('═══════════════════════════════════════════════════════════════════════════');
console.log('RELEASE-AUTOMATION-GUARD-NONPUBLISH-COMMITS-001 — scope-completeness audit');
console.log('═══════════════════════════════════════════════════════════════════════════');
console.log('');
console.log(`Branch scanned:       ${branch}`);
console.log(`Generated:            ${new Date().toISOString()}`);
console.log(`Total commits:        ${lines.length}`);
console.log(`Conventional:         ${lines.length - nonCC}`);
console.log(`Non-conventional:     ${nonCC}`);
console.log(`Unscoped (CC):        ${unscoped}`);
console.log(`Distinct scopes:      ${scopeCount.size}`);
console.log('');
console.log(`Owned scopes (${classified.owned.length}):`);
for (const { scope, count } of classified.owned) console.log(`  ${count.toString().padStart(5)} × ${scope}`);
console.log('');
console.log(`Denied scopes (${classified.denied.length}) — Layer 1 blocks these:`);
for (const { scope, count } of classified.denied) console.log(`  ${count.toString().padStart(5)} × ${scope}`);
console.log('');
console.log(`UNCLASSIFIED scopes (${classified.unclassified.length}) — Layer 1 does NOT block:`);
if (classified.unclassified.length === 0) {
  console.log('  (none — every observed scope is either owned or denied)');
} else {
  for (const { scope, count } of classified.unclassified) {
    console.log(`  ${count.toString().padStart(5)} × ${scope}`);
  }
  console.log('');
  console.log('  Each unclassified scope is a maintenance hazard. If a future commit uses');
  console.log('  one of these scopes with type:fix/feat/perf/revert, semantic-release will');
  console.log('  fall back to the angular preset default and may produce an unwanted release.');
  console.log('  Add these to NON_OWNED_SCOPES in scripts/multi-package-release.mjs unless');
  console.log('  they are intentionally release-capable.');
}
console.log('═══════════════════════════════════════════════════════════════════════════');
process.exit(classified.unclassified.length === 0 ? 0 : 1);
