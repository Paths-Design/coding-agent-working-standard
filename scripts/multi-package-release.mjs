#!/usr/bin/env node
/**
 * Multi-Package Semantic Release Script
 *
 * Detects which packages have changes since their last release tag and runs
 * semantic-release for each one independently. Each package gets its own
 * tagFormat, release rules, and changelog.
 *
 * This is the SINGLE SOURCE OF TRUTH for release configuration.
 * No .releaserc.json files should exist in the repo — this script generates
 * temporary .releaserc.cjs files for each package run.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * COMMIT DISCIPLINE FOR @paths.design/caws-cli (post-v11.1.2 incident)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Release-carrying caws-cli commits MUST use one of these owned scopes:
 *
 *     fix(cli): ...                  feat(cli): ...
 *     fix(caws-cli): ...             feat(caws-cli): ...
 *     fix(packages/caws-cli): ...    feat(packages/caws-cli): ...
 *
 * The expanded NON_OWNED_SCOPES list (see below) intentionally treats
 * feature-area scopes as NON-release scopes. The following will NOT publish,
 * even if they touch packages/caws-cli/src/**:
 *
 *     fix(gates): ...      fix(hooks): ...      fix(worktree): ...
 *     fix(schema): ...     fix(evlog): ...      fix(mcp): ...
 *     fix(policy): ...     fix(scope): ...      fix(waivers): ...
 *     fix(vscode): ...     fix(templates): ...  (... and many more)
 *
 * This is a deliberate trade-off from RELEASE-AUTOMATION-GUARD-NONPUBLISH-
 * COMMITS-001. The v11.1.2 incident showed that the angular preset's default
 * (fix → patch on any scope) made cross-package contamination too easy. The
 * fix is to require the package's own scope for releases. If you genuinely
 * want a release for a feature-area fix, rephrase the commit with an owned
 * scope:
 *
 *     before:  fix(gates): correct policy mode resolution
 *     after:   fix(caws-cli): correct gates policy mode resolution
 *
 * Verification:
 *   - scripts/release-guard-dry-run.mjs               (Layer 2+3 simulation)
 *   - scripts/release-guard-commit-analyzer-check.mjs (Layer 1 with real
 *                                                      semantic-release)
 *   - scripts/release-guard-scope-audit.mjs           (deny-list completeness
 *                                                      vs git history)
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const REPO_URL = 'https://github.com/Paths-Design/coding-agent-working-standard.git';

const PACKAGES = [
  {
    name: '@paths.design/caws-cli',
    path: 'packages/caws-cli',
    scope: 'cli',
    // Additional owned-scope aliases observed in commit history. Scope audit
    // (scripts/release-guard-scope-audit.mjs) flagged these as in-use.
    additionalOwnedScopes: ['caws-cli'],
    tagFormat: 'v${version}', // CLI uses plain v-tags (historical convention)
    config: {
      pkgRoot: 'packages/caws-cli',
    },
  },
  // caws-types and quality-gates are folded into caws-cli — no longer published separately
];

/**
 * Get last release tag for a package based on its tagFormat.
 */
function getLastTag(pkg) {
  try {
    const prefix = pkg.tagFormat.replace('${version}', '');
    const output = execSync(
      `git tag --sort=-version:refname | grep "^${prefix}" | head -1`,
      { cwd: rootDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return output.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if package directory has any changes since its last release tag.
 * Returns { ok: true, files: string[] } on success, { ok: false, reason }
 * on failure. The failure case is intentionally distinct from "empty diff"
 * so callers can fail open (treat unknown as eligible) instead of failing
 * closed (treat unknown as non-shipping).
 */
function changedFilesSince(pkg) {
  const lastTag = getLastTag(pkg);
  try {
    const ref = lastTag || 'HEAD~20';
    const output = execSync(
      `git diff --name-only ${ref}..HEAD -- ${pkg.path}`,
      { cwd: rootDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return { ok: true, files: output.trim().split('\n').filter(Boolean) };
  } catch (err) {
    return {
      ok: false,
      reason: lastTag
        ? `git diff ${lastTag}..HEAD failed: ${err.message}`
        : 'no prior tag found and HEAD~20 fallback also failed',
    };
  }
}

/**
 * RELEASE-AUTOMATION-GUARD-NONPUBLISH-COMMITS-001 — Layer 3 (pure classifier).
 *
 * Pure function: given a package and a list of changed file paths, decide
 * eligibility. Separated from changedFilesSince() so the evidence harness
 * can dry-run against synthetic file lists without spawning git.
 *
 * Shipping set derivation:
 *   - package.json `files` entries (authoritative tarball boundary per npm)
 *   - source roots feeding shipped outputs: src/ (→ dist/ via build)
 *   - package.json, README.md, CHANGELOG.md (always shipped by npm)
 *
 * Non-shipping patterns (denied even if they live under a shipping prefix):
 *   - tests/**, *.test.*, *.spec.*
 *   - scripts/** under the package
 *   - demo-project/**
 *   - coverage/**
 *
 * Default for unclassified files: non-shipping (bias toward not publishing).
 */
function classifyShippingChanges(pkg, changedFiles) {
  if (changedFiles.length === 0) {
    return { eligible: false, shipping: [], nonShipping: [], reason: 'no changes since last tag' };
  }

  let filesEntries = [];
  try {
    const pkgJson = JSON.parse(readFileSync(path.join(rootDir, pkg.path, 'package.json'), 'utf8'));
    filesEntries = Array.isArray(pkgJson.files) ? pkgJson.files : [];
  } catch {
    filesEntries = [];
  }

  const shippingPrefixes = filesEntries.map((entry) => {
    const stripped = entry.replace(/\/?\*\*\/?.*$/, '').replace(/\/$/, '');
    return `${pkg.path}/${stripped}`;
  });
  // Source roots that feed shipped outputs (src/ → dist/ via build), plus
  // package.json itself. README.md and CHANGELOG.md are always shipped.
  //
  // NOTE on packages/<pkg>/scripts/: these scripts (build-cli.js,
  // fresh-install-smoke.mjs, etc.) feed prepublishOnly and the build
  // pipeline. Changes to them can alter dist/ output or publish validation,
  // so they ARE release-relevant inputs. Treated as shipping by default.
  // If a specific script is genuinely diagnostic-only (no effect on dist
  // or publish), name it explicitly in DIAGNOSTIC_PACKAGE_SCRIPTS below.
  shippingPrefixes.push(`${pkg.path}/src`);
  shippingPrefixes.push(`${pkg.path}/scripts`);
  shippingPrefixes.push(`${pkg.path}/package.json`);
  shippingPrefixes.push(`${pkg.path}/README.md`);
  shippingPrefixes.push(`${pkg.path}/CHANGELOG.md`);

  // Diagnostic-only scripts under packages/<pkg>/scripts/ that should NOT
  // trigger releases. Conservative: only add an entry after confirming
  // nothing in prepublishOnly, postinstall, or build invokes the script.
  const DIAGNOSTIC_PACKAGE_SCRIPTS = [
    // Example: `${pkg.path}/scripts/local-debug-only.js`,
  ];

  // Explicitly non-shipping path patterns (regex against full path).
  // scripts/ deliberately omitted — see note above.
  const nonShippingPatterns = [
    new RegExp(`^${pkg.path}/tests/`),
    new RegExp(`^${pkg.path}/demo-project/`),
    new RegExp(`^${pkg.path}/coverage/`),
    /\.test\.(js|ts|mjs|cjs|jsx|tsx)$/,
    /\.spec\.(js|ts|mjs|cjs|jsx|tsx)$/,
  ];

  const shipping = [];
  const nonShipping = [];
  for (const file of changedFiles) {
    // Per-file diagnostic-only allowlist takes priority over scripts/ shipping.
    if (DIAGNOSTIC_PACKAGE_SCRIPTS.includes(file)) {
      nonShipping.push(file);
      continue;
    }
    if (nonShippingPatterns.some((rx) => rx.test(file))) {
      nonShipping.push(file);
      continue;
    }
    if (shippingPrefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`))) {
      shipping.push(file);
      continue;
    }
    nonShipping.push(file);
  }

  return {
    eligible: shipping.length > 0,
    shipping,
    nonShipping,
    reason:
      shipping.length > 0
        ? `${shipping.length} shipping file(s) changed`
        : `${changedFiles.length} file(s) changed but none qualify as shipping`,
  };
}

/**
 * Real-git version: pulls the changed file list from git, then defers to
 * the pure classifier. This is what main() uses in production.
 *
 * Fail-open semantics: if changedFilesSince() reports a git failure
 * (missing tag, shallow clone, ENOENT), eligibility is set to true with
 * an explicit reason so we don't silently drop a real release. The risk
 * of a false publish in this branch is lower than the risk of a missed
 * one — semantic-release will still find nothing to release if commits
 * don't justify it (Layer 1 + commit-analyzer still apply).
 */
function hasShippingChanges(pkg) {
  const changes = changedFilesSince(pkg);
  if (!changes.ok) {
    return {
      eligible: true,
      shipping: [],
      nonShipping: [],
      reason: `unable to compute diff (${changes.reason}); failing open — semantic-release will arbitrate`,
      unknown: true,
    };
  }
  return classifyShippingChanges(pkg, changes.files);
}

/**
 * RELEASE-AUTOMATION-GUARD-NONPUBLISH-COMMITS-001 — Layer 1.
 *
 * Deterministic deny list of non-owned scopes for release-capable commit
 * types. Without these explicit denials, a `fix(quality-gates):` commit
 * matched the angular preset's default `fix → patch` rule and produced an
 * unrelated @paths.design/caws-cli@11.1.2 release on 2026-05-18.
 *
 * Scopes derived from recent commit history and package boundaries.
 * Update this list when adding a new non-cli scope; the catch-all default
 * (preset behavior) is the failure mode this list defends against.
 */
// Initial deny list + scopes surfaced by scripts/release-guard-scope-audit.mjs
// against main branch history on 2026-05-19. Update this list when adding a
// new non-cli scope; rerun the audit after major commit-history changes to
// catch new scopes that need explicit denial.
const NON_OWNED_SCOPES = [
  // Sibling/sub-packages and their aliases
  'quality-gates',
  'caws-kernel',
  'kernel',
  'caws-types',
  'types',
  // Repo-meta scopes
  'caws',
  'specs',
  'docs',
  'deps',
  'release',
  'changelog',
  'ci',
  'tests',
  'test',
  'lint',
  'security',
  'audit',
  'ops',
  'packaging',
  'scripts',
  'rename',
  'rewrite',
  // Internal feature scopes (none of these affect what npm publishes; they
  // describe functional areas of caws-cli source. A fix scoped to one of
  // these should NOT bump caws-cli unless the change touches shipping files,
  // which Layer 3 confirms separately. Layer 1 here is a defense-in-depth
  // denial.)
  'worktree',
  'hooks',
  'claude-hooks',
  'evlog',
  'gates',
  'mcp',
  'mcp-server',
  'waivers',
  'vscode',
  'vscode-extension',
  'extension',
  'cursor',
  'validation',
  'validator',
  'validate',
  'tracker',
  'scope',
  'scope-guard',
  'enforcement',
  'contract',
  'parallel',
  'session',
  'state',
  'sidecars',
  'templates',
  'claude-template',
  'schema',
  'schemas',
  'agents',
  'policy',
  'budget',
  'readme',
  'host-gov',
  'caws-gate',
  'caws-guards',
  'scaffold',
  // Milestone/slice scopes (internal sprint tags)
  '8a0',
  '8c.1',
  '8c.2',
  '8c.3',
  'p1',
];
const RELEASE_CAPABLE_TYPES = ['feat', 'fix', 'perf', 'revert'];

// Multi-scope syntaxes observed in history (e.g., "cli,kernel" or "policy+gates").
// semantic-release treats these as single literal strings, so they never match
// the simple `scope:'cli'` rule. They appear in the audit as unclassified.
// Deny them at the literal-string level to be safe; if a future commit wants
// to use comma/plus syntax intentionally, split into separate commits instead.
const MULTI_SCOPE_DENIES = [
  'cli,kernel',
  'cli,docs',
  'kernel,cli',
  'quality-gates,cli',
  'policy+gates',
  'worktree+validation',
  'tests+schema',
  'schema+tests',
];

/**
 * Create package-specific semantic-release config as a CommonJS module.
 *
 * Only commits scoped to this package's scope (or its packages/* path)
 * trigger a release. Commits in non-owned scopes are explicitly denied
 * for every release-capable type (Layer 1 of RELEASE-AUTOMATION-GUARD-001).
 */
function createPackageConfig(pkg) {
  const dirName = pkg.path.split('/').pop();

  // Build the owned-scope set for this package: short scope, path-form scope,
  // plus any additionalOwnedScopes declared on the PACKAGES entry.
  const ownedScopes = new Set([pkg.scope, `packages/${dirName}`]);
  for (const s of pkg.additionalOwnedScopes ?? []) ownedScopes.add(s);

  // Layer 1: deny rules for every (release-capable type × non-owned scope)
  // combination, plus breaking-change denials. These are added BEFORE the
  // package's positive rules so semantic-release evaluates them first.
  const denyRules = [];
  for (const scope of NON_OWNED_SCOPES) {
    if (ownedScopes.has(scope)) continue; // never deny an owned-scope alias
    for (const type of RELEASE_CAPABLE_TYPES) {
      denyRules.push({ type, scope, release: false });
    }
    denyRules.push({ breaking: true, scope, release: false });
  }
  // Multi-scope literal denials (e.g., "cli,kernel" treated as one string).
  for (const scope of MULTI_SCOPE_DENIES) {
    for (const type of RELEASE_CAPABLE_TYPES) {
      denyRules.push({ type, scope, release: false });
    }
    denyRules.push({ breaking: true, scope, release: false });
  }

  // Positive release rules for every owned scope alias.
  const ownedRules = [];
  for (const scope of ownedScopes) {
    ownedRules.push({ type: 'feat', scope, release: 'minor' });
    ownedRules.push({ type: 'fix', scope, release: 'patch' });
    ownedRules.push({ type: 'perf', scope, release: 'patch' });
    ownedRules.push({ type: 'revert', scope, release: 'patch' });
    ownedRules.push({ breaking: true, scope, release: 'major' });
  }

  const config = {
    branches: ['main'],
    repositoryUrl: REPO_URL,
    tagFormat: pkg.tagFormat,
    plugins: [
      [
        '@semantic-release/commit-analyzer',
        {
          preset: 'angular',
          releaseRules: [
            // Layer 1: explicit deny rules (evaluated first).
            ...denyRules,
            // Owned-scope positive rules.
            ...ownedRules,
            // Note: no catch-all { type: 'fix', release: false } rules here.
            // Unscoped rules with release:false defeat scoped rules due to a
            // semantic-release quirk. Per-scope denial rules above are
            // additive and safe.
          ],
          parserOpts: {
            noteKeywords: ['BREAKING CHANGE', 'BREAKING CHANGES'],
          },
        },
      ],
      '@semantic-release/release-notes-generator',
      [
        '@semantic-release/changelog',
        {
          changelogFile: `${pkg.path}/CHANGELOG.md`,
        },
      ],
      [
        '@semantic-release/npm',
        {
          npmPublish: true,
          ...pkg.config,
          provenance: true,
        },
      ],
      [
        '@semantic-release/git',
        {
          assets: [
            `${pkg.path}/CHANGELOG.md`,
            `${pkg.path}/package.json`,
          ],
          message: `chore(release): ${pkg.name}@\${nextRelease.version}\n\n\${nextRelease.notes}`,
        },
      ],
    ],
  };

  return `module.exports = ${JSON.stringify(config, null, 2)};`;
}

/**
 * Run semantic-release for a specific package.
 *
 * Writes a temporary .releaserc.cjs in the repo root so that semantic-release
 * auto-discovers it as the only config (no --extends merging issues).
 */
function releasePackage(pkg) {
  console.log(`\nReleasing ${pkg.name}...`);
  console.log(`  Scope: ${pkg.scope}`);
  console.log(`  Path: ${pkg.path}`);
  console.log(`  Tag format: ${pkg.tagFormat}`);

  const lastTag = getLastTag(pkg);
  console.log(`  Last tag: ${lastTag || '(none)'}`);

  // Write config to repo root so semantic-release auto-discovers it
  const configPath = path.join(rootDir, '.releaserc.cjs');
  const config = createPackageConfig(pkg);

  try {
    writeFileSync(configPath, config, { mode: 0o644 });

    if (!existsSync(configPath)) {
      throw new Error(`Failed to create config file: ${configPath}`);
    }

    console.log(`  Config written to: ${configPath}`);

    execSync('npx semantic-release', {
      cwd: rootDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN,
        NPM_TOKEN: process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN,
      },
    });

    console.log(`Successfully released ${pkg.name}`);
    return true;
  } catch (error) {
    console.error(`Failed to release ${pkg.name}: ${error.message}`);
    return false;
  } finally {
    // Always clean up the temporary config
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('Multi-Package Semantic Release\n');

  // RELEASE-AUTOMATION-GUARD-NONPUBLISH-COMMITS-001 — Layer 3 gating.
  // Each package's eligibility runs through hasShippingChanges() so that
  // test-only, demo-only, scripts-only, etc. changes do NOT qualify the
  // package for a release. Each decision (proceed or skip) emits a
  // structured [release-guard] log line that names the matched rule and
  // the file set evaluated.
  const eligiblePackages = [];
  for (const pkg of PACKAGES) {
    const tag = getLastTag(pkg);
    const ship = hasShippingChanges(pkg);
    if (!ship.eligible) {
      console.log(
        `[release-guard] skip ${pkg.name}: ${ship.reason}` +
          ` (lastTag=${tag || 'none'}` +
          `; nonShipping=${ship.nonShipping.length}` +
          `; shipping=0)`
      );
      if (ship.nonShipping.length > 0) {
        for (const f of ship.nonShipping.slice(0, 10)) {
          console.log(`[release-guard]   non-shipping: ${f}`);
        }
        if (ship.nonShipping.length > 10) {
          console.log(`[release-guard]   ... and ${ship.nonShipping.length - 10} more non-shipping files`);
        }
      }
      continue;
    }
    console.log(
      `[release-guard] proceed ${pkg.name}: ${ship.reason}` +
        ` (lastTag=${tag || 'none'}` +
        `; shipping=${ship.shipping.length}` +
        `; nonShipping=${ship.nonShipping.length})`
    );
    for (const f of ship.shipping.slice(0, 10)) {
      console.log(`[release-guard]   shipping: ${f}`);
    }
    if (ship.shipping.length > 10) {
      console.log(`[release-guard]   ... and ${ship.shipping.length - 10} more shipping files`);
    }
    eligiblePackages.push(pkg);
  }

  if (eligiblePackages.length === 0) {
    console.log('\nNo packages eligible to release. Nothing to publish.');
    process.exit(0);
  }

  console.log(`\nReleasing ${eligiblePackages.length} package(s)...\n`);

  const results = [];
  for (const pkg of eligiblePackages) {
    results.push({
      package: pkg.name,
      success: releasePackage(pkg),
    });
  }

  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  console.log('\nRelease Summary:');
  console.log(`  Successful: ${successful}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

// Export internals so the release-guard evidence harness can exercise
// hasShippingChanges() directly without rewriting it.
export {
  PACKAGES,
  NON_OWNED_SCOPES,
  MULTI_SCOPE_DENIES,
  RELEASE_CAPABLE_TYPES,
  hasShippingChanges,
  classifyShippingChanges,
  changedFilesSince,
  createPackageConfig,
};

// Only run main() when invoked as a script, not when imported.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('multi-package-release.mjs')) {
  main().catch((error) => {
    console.error('Release script failed:', error);
    process.exit(1);
  });
}
