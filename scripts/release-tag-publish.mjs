#!/usr/bin/env node
/**
 * Tag-driven release for @paths.design/caws-cli (CAWS-RELEASE-TAG-DRIVEN-001 v1).
 *
 * Replaces the branch-push + semantic-release pipeline with a deterministic
 * tag-trigger publish path. The release workflow invokes this script with
 * the pushed tag name; this script does the rest.
 *
 * V1 scope:
 *   - ACCEPTS: caws-cli-vX.Y.Z
 *   - REFUSES: bare v* tags (no legacy publish path)
 *   - REFUSES: caws-kernel-v* tags (kernel CI publish is a follow-up slice)
 *
 * Asymmetric failure invariant:
 *   - Pre-publish failure (validation, build, smoke): delete the pushed tag
 *     via `gh api -X DELETE /repos/{owner}/{repo}/git/refs/tags/{tag}`. The
 *     registry remains untouched.
 *   - Post-publish failure (registry verify, GitHub Release): PRESERVE the
 *     tag. The registry is authoritative; the tag is the provenance anchor.
 *     Emit a precise repair command, exit non-zero.
 *
 * The script never writes to packages/<pkg>/package.json, CHANGELOG.md, or
 * any other tracked file. CI never pushes to main.
 *
 * Invocation:
 *   node scripts/release-tag-publish.mjs <tag-name> [--dry-run]
 *
 * Environment:
 *   GITHUB_REPOSITORY  required for tag-deletion and GitHub Release API
 *   GITHUB_TOKEN       required for tag-deletion and GitHub Release API
 *   NPM_TOKEN          required for npm publish (bypass-2FA token)
 *   CAWS_RELEASE_DRY_RUN  set to "1" to disable npm publish + tag deletion
 *                         (also enabled by --dry-run flag)
 *
 * Exit codes:
 *   0   publish + registry verification + GitHub Release all succeeded
 *   10  tag refused (bare v*, caws-kernel-v*, malformed)
 *   20  pre-publish validation failed (version mismatch, CHANGELOG missing,
 *       build failed, smoke failed); tag was deleted
 *   21  pre-publish failure but tag deletion ALSO failed (manual repair)
 *   30  post-publish failure (registry verify failed, release create failed);
 *       tag preserved, repair command emitted
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// =============================================================================
// PACKAGES TABLE — adding a package is a single-entry table change.
// =============================================================================

const PACKAGES = [
  {
    name: '@paths.design/caws-cli',
    tagPrefix: 'caws-cli-v',
    pkgPath: 'packages/caws-cli',
    enabled: true,
  },
];

const REFUSED_TAG_PREFIXES = [
  {
    prefix: 'caws-kernel-v',
    reason: 'kernel CI publish is not enabled in v1 — publish caws-kernel manually for now; see docs/release-procedure.md',
  },
];

// Bare v* (no package prefix). Refused with a clear pointer to the new convention.
const LEGACY_BARE_V_REGEX = /^v\d+\.\d+\.\d+([-+].*)?$/;

const SEMVER_REGEX = /^\d+\.\d+\.\d+([-+].*)?$/;

// =============================================================================
// Logging helpers — structured, single-line for CI log scraping.
// =============================================================================

function log(level, fields) {
  const obj = { level, ts: new Date().toISOString(), ...fields };
  console.log(JSON.stringify(obj));
}

function logInfo(msg, extra = {}) {
  log('info', { msg, ...extra });
}

function logError(msg, extra = {}) {
  log('error', { msg, ...extra });
}

// =============================================================================
// Tag parsing.
// =============================================================================

function parseTag(tag) {
  // Refused: bare v*
  if (LEGACY_BARE_V_REGEX.test(tag)) {
    return {
      ok: false,
      code: 10,
      reason: 'legacy bare v* tag refused. Use the canonical convention: caws-cli-vX.Y.Z',
    };
  }
  // Refused: explicit refused prefixes (e.g., caws-kernel-v*).
  for (const { prefix, reason } of REFUSED_TAG_PREFIXES) {
    if (tag.startsWith(prefix)) {
      return { ok: false, code: 10, reason };
    }
  }
  // Match against enabled packages.
  for (const pkg of PACKAGES) {
    if (!pkg.enabled) continue;
    if (tag.startsWith(pkg.tagPrefix)) {
      const version = tag.slice(pkg.tagPrefix.length);
      if (!SEMVER_REGEX.test(version)) {
        return {
          ok: false,
          code: 10,
          reason: `tag "${tag}" has invalid version segment "${version}" — must match X.Y.Z`,
        };
      }
      return { ok: true, pkg, version };
    }
  }
  return {
    ok: false,
    code: 10,
    reason: `tag "${tag}" does not match any enabled package prefix. Expected: ${PACKAGES.filter(p => p.enabled).map(p => p.tagPrefix + 'X.Y.Z').join(', ')}`,
  };
}

// =============================================================================
// Validation steps (all pre-publish).
// =============================================================================

function validatePackageJsonVersion(pkg, expectedVersion) {
  const pkgJsonPath = path.join(rootDir, pkg.pkgPath, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    return { ok: false, reason: `package.json not found at ${pkgJsonPath}` };
  }
  const data = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  if (data.version !== expectedVersion) {
    return {
      ok: false,
      reason: `tag version "${expectedVersion}" does not equal package.json version "${data.version}" at the tag checkout SHA`,
    };
  }
  return { ok: true };
}

function validateChangelogSection(pkg, expectedVersion) {
  const changelogPath = path.join(rootDir, pkg.pkgPath, 'CHANGELOG.md');
  if (!existsSync(changelogPath)) {
    return { ok: false, reason: `CHANGELOG.md not found at ${changelogPath}` };
  }
  const content = readFileSync(changelogPath, 'utf8');
  // Accept both ## [X.Y.Z] (semantic-release format) and # [X.Y.Z]
  // (occasional minor-release format). Also accept ## X.Y.Z and # X.Y.Z
  // (human-authored, no brackets).
  const patterns = [
    new RegExp(`^##\\s+\\[${escapeRegex(expectedVersion)}\\]`, 'm'),
    new RegExp(`^#\\s+\\[${escapeRegex(expectedVersion)}\\]`, 'm'),
    new RegExp(`^##\\s+${escapeRegex(expectedVersion)}\\b`, 'm'),
    new RegExp(`^#\\s+${escapeRegex(expectedVersion)}\\b`, 'm'),
  ];
  if (!patterns.some(re => re.test(content))) {
    return {
      ok: false,
      reason: `CHANGELOG.md has no section for version ${expectedVersion}. Add one of: "## [${expectedVersion}]", "# [${expectedVersion}]", "## ${expectedVersion}", or "# ${expectedVersion}" before tagging.`,
    };
  }
  return { ok: true };
}

function extractChangelogSection(pkg, version) {
  const changelogPath = path.join(rootDir, pkg.pkgPath, 'CHANGELOG.md');
  const content = readFileSync(changelogPath, 'utf8');
  // Find the header line for the version.
  const lines = content.split('\n');
  const startIdx = lines.findIndex(line =>
    new RegExp(`^#{1,2}\\s+\\[?${escapeRegex(version)}\\]?(\\s|$|\\()`).test(line)
  );
  if (startIdx === -1) return null;
  // Find the next header line at the same or higher level.
  const startLevel = lines[startIdx].match(/^(#+)/)[1].length;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s+/);
    if (m && m[1].length <= startLevel) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join('\n').trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// =============================================================================
// Build + smoke.
// =============================================================================

function runStep(name, cmd, args, opts = {}) {
  logInfo(`step.start`, { step: name, cmd, args });
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd || rootDir,
    stdio: 'inherit',
    env: { ...process.env, ...(opts.env || {}) },
  });
  const ok = result.status === 0;
  logInfo(`step.end`, { step: name, exit_code: result.status, ok });
  return { ok, exitCode: result.status };
}

// =============================================================================
// Tag deletion (pre-publish-failure rollback).
// =============================================================================

function deleteTagFromOrigin(tag, isDryRun) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    return { ok: false, reason: 'GITHUB_REPOSITORY env var not set; cannot delete tag via API' };
  }
  if (isDryRun) {
    logInfo('tag.delete.dry_run', { tag, repo });
    return { ok: true, dryRun: true };
  }
  const refPath = `repos/${repo}/git/refs/tags/${tag}`;
  const result = spawnSync('gh', ['api', '-X', 'DELETE', refPath], {
    stdio: 'inherit',
  });
  return {
    ok: result.status === 0,
    reason: result.status !== 0 ? `gh api DELETE ${refPath} exited ${result.status}` : undefined,
  };
}

// =============================================================================
// Registry verification (post-publish).
// =============================================================================

function verifyRegistry(pkg, version, isDryRun) {
  if (isDryRun) {
    logInfo('registry.verify.dry_run', { pkg: pkg.name, version });
    return { ok: true, dryRun: true };
  }
  // Poll up to 6 times with 5s backoff (npm propagation is usually instant
  // but can take a moment).
  for (let attempt = 1; attempt <= 6; attempt++) {
    const result = spawnSync('npm', ['view', `${pkg.name}@${version}`, 'version'], {
      encoding: 'utf8',
    });
    if (result.status === 0 && result.stdout.trim() === version) {
      logInfo('registry.verify.ok', { pkg: pkg.name, version, attempts: attempt });
      return { ok: true };
    }
    if (attempt < 6) {
      logInfo('registry.verify.retry', { attempt, of: 6 });
      execSync('sleep 5');
    }
  }
  return {
    ok: false,
    reason: `npm view ${pkg.name}@${version} did not return the expected version after 6 attempts`,
  };
}

// =============================================================================
// GitHub Release creation (post-publish).
// =============================================================================

function createGitHubRelease(tag, version, changelogSection, isDryRun) {
  if (isDryRun) {
    logInfo('github.release.dry_run', { tag, body_chars: changelogSection?.length || 0 });
    return { ok: true, dryRun: true };
  }
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    return { ok: false, reason: 'GITHUB_REPOSITORY env var not set; cannot create GitHub Release' };
  }
  const body = changelogSection || `Release ${version}`;
  // Use gh release create. --notes uses the body verbatim. --verify-tag
  // ensures the tag exists (it should, but defense in depth).
  const result = spawnSync(
    'gh',
    ['release', 'create', tag, '--title', tag, '--notes', body, '--verify-tag'],
    { stdio: 'inherit' }
  );
  return {
    ok: result.status === 0,
    reason: result.status !== 0 ? `gh release create exited ${result.status}` : undefined,
  };
}

// =============================================================================
// Main.
// =============================================================================

function main() {
  const args = process.argv.slice(2);
  const tag = args.find(a => !a.startsWith('--'));
  const isDryRun = args.includes('--dry-run') || process.env.CAWS_RELEASE_DRY_RUN === '1';

  if (!tag) {
    logError('tag.missing', { hint: 'pass tag as first positional arg' });
    process.exit(10);
  }

  logInfo('release.start', { tag, dry_run: isDryRun, repo: process.env.GITHUB_REPOSITORY });

  // ---------------------------------------------------------------------------
  // Phase 1: Parse + refuse.
  // ---------------------------------------------------------------------------
  const parsed = parseTag(tag);
  if (!parsed.ok) {
    logError('tag.refused', { tag, reason: parsed.reason });
    // Refusals do NOT delete the tag — they're informational. The tag may be
    // a legitimate future request the workflow doesn't honor yet (e.g.,
    // caws-kernel-v*) or a user mistake that the maintainer should fix
    // explicitly.
    process.exit(parsed.code);
  }
  const { pkg, version } = parsed;
  logInfo('tag.parsed', { tag, package: pkg.name, version });

  // ---------------------------------------------------------------------------
  // Phase 2: Pre-publish validation. Any failure -> delete tag, exit 20.
  // ---------------------------------------------------------------------------
  const validations = [
    { name: 'package.json version', fn: () => validatePackageJsonVersion(pkg, version) },
    { name: 'CHANGELOG section', fn: () => validateChangelogSection(pkg, version) },
  ];

  for (const { name, fn } of validations) {
    const r = fn();
    if (!r.ok) {
      logError('validation.failed', { check: name, reason: r.reason });
      const del = deleteTagFromOrigin(tag, isDryRun);
      if (!del.ok) {
        logError('tag.delete.failed', { reason: del.reason, repair: `gh api -X DELETE repos/${process.env.GITHUB_REPOSITORY}/git/refs/tags/${tag}` });
        process.exit(21);
      }
      logInfo('tag.deleted', { tag, dry_run: !!del.dryRun });
      process.exit(20);
    }
  }
  logInfo('validation.ok', {});

  // ---------------------------------------------------------------------------
  // Phase 3: Build + prepublish smoke. Failure -> delete tag, exit 20.
  // ---------------------------------------------------------------------------
  const buildStep = runStep('build', 'npx', ['turbo', 'run', 'build', `--filter=${pkg.name}...`]);
  if (!buildStep.ok) {
    logError('build.failed', { exit_code: buildStep.exitCode });
    const del = deleteTagFromOrigin(tag, isDryRun);
    if (!del.ok) {
      logError('tag.delete.failed', { reason: del.reason });
      process.exit(21);
    }
    process.exit(20);
  }

  const smokeStep = runStep('prepublish_smoke', 'npm', ['run', 'smoke:fresh-install', '-w', pkg.name]);
  if (!smokeStep.ok) {
    logError('smoke.failed', { exit_code: smokeStep.exitCode });
    const del = deleteTagFromOrigin(tag, isDryRun);
    if (!del.ok) {
      logError('tag.delete.failed', { reason: del.reason });
      process.exit(21);
    }
    process.exit(20);
  }

  // ---------------------------------------------------------------------------
  // Phase 4: npm publish. THE CROSSING POINT.
  //
  // Before this step: failures rollback the tag.
  // After this step:  failures preserve the tag (registry is authoritative).
  // ---------------------------------------------------------------------------
  if (!process.env.NPM_TOKEN && !isDryRun) {
    logError('publish.no_token', { hint: 'NPM_TOKEN env var required for non-dry-run publish' });
    const del = deleteTagFromOrigin(tag, isDryRun);
    process.exit(del.ok ? 20 : 21);
  }

  if (isDryRun) {
    logInfo('publish.dry_run', { pkg: pkg.name, version });
  } else {
    const publishStep = runStep(
      'npm_publish',
      'npm',
      ['publish', '--access', 'public', '--provenance'],
      {
        cwd: path.join(rootDir, pkg.pkgPath),
        env: {
          NODE_AUTH_TOKEN: process.env.NPM_TOKEN,
          NPM_TOKEN: process.env.NPM_TOKEN,
        },
      }
    );
    if (!publishStep.ok) {
      logError('publish.failed', { exit_code: publishStep.exitCode });
      // Publish failure: tag rollback IS appropriate here because the registry
      // mutation did not succeed. (npm publish is the boundary; if it
      // exited non-zero, no version was published.)
      const del = deleteTagFromOrigin(tag, isDryRun);
      if (!del.ok) {
        logError('tag.delete.failed', { reason: del.reason });
        process.exit(21);
      }
      process.exit(20);
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 5: POST-PUBLISH steps. Failures here PRESERVE the tag.
  // ---------------------------------------------------------------------------
  let postPublishFailures = [];

  const verify = verifyRegistry(pkg, version, isDryRun);
  if (!verify.ok) {
    logError('registry.verify.failed', { reason: verify.reason });
    postPublishFailures.push({
      step: 'registry_verify',
      repair: `npm view ${pkg.name}@${version} version  # confirm registry state`,
    });
  }

  const changelogSection = extractChangelogSection(pkg, version);
  const release = createGitHubRelease(tag, version, changelogSection, isDryRun);
  if (!release.ok) {
    logError('github.release.failed', { reason: release.reason });
    postPublishFailures.push({
      step: 'github_release',
      repair: `gh release create ${tag} --title ${tag} --notes-file <CHANGELOG-section-file> --verify-tag`,
    });
  }

  if (postPublishFailures.length > 0) {
    logError('post_publish.partial_failure', {
      tag_preserved: true,
      failures: postPublishFailures,
      message: 'npm publish succeeded; tag is preserved as the provenance anchor. Run the repair commands above to complete ancillary steps.',
    });
    process.exit(30);
  }

  // ---------------------------------------------------------------------------
  // Success.
  // ---------------------------------------------------------------------------
  logInfo('release.success', {
    tag,
    package: pkg.name,
    version,
    dry_run: isDryRun,
  });
  process.exit(0);
}

main();
