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
    tagFormat: 'v${version}', // CLI uses plain v-tags (historical convention)
    config: {
      pkgRoot: 'packages/caws-cli',
      tarballDir: 'dist',
    },
  },
{
    name: '@paths.design/caws-types',
    path: 'packages/caws-types',
    scope: 'caws-types',
    tagFormat: 'caws-types-v${version}',
    config: {
      pkgRoot: 'packages/caws-types',
    },
  },
  {
    name: '@paths.design/quality-gates',
    path: 'packages/quality-gates',
    scope: 'quality-gates',
    tagFormat: 'quality-gates-v${version}',
    config: {
      pkgRoot: 'packages/quality-gates',
    },
  },
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
 * Check if package has changes since its last release tag.
 */
function hasPackageChanges(pkg) {
  const lastTag = getLastTag(pkg);
  try {
    const ref = lastTag || 'HEAD~20';
    const output = execSync(
      `git diff --name-only ${ref}..HEAD -- ${pkg.path}`,
      { cwd: rootDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return output.trim().length > 0;
  } catch {
    // If the ref doesn't exist (shallow clone, etc.), assume changes exist
    return true;
  }
}

/**
 * Create package-specific semantic-release config as a CommonJS module.
 *
 * Only commits scoped to this package's scope (or its packages/* path)
 * trigger a release. Unscoped commits are explicitly blocked.
 */
function createPackageConfig(pkg) {
  const dirName = pkg.path.split('/').pop();

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
            // Scoped commits for this package trigger releases
            { type: 'feat', scope: pkg.scope, release: 'minor' },
            { type: 'fix', scope: pkg.scope, release: 'patch' },
            { type: 'perf', scope: pkg.scope, release: 'patch' },
            { type: 'revert', scope: pkg.scope, release: 'patch' },
            { breaking: true, scope: pkg.scope, release: 'major' },
            // Alternative scope format: packages/caws-cli
            { type: 'feat', scope: `packages/${dirName}`, release: 'minor' },
            { type: 'fix', scope: `packages/${dirName}`, release: 'patch' },
            // Note: no catch-all { type: 'fix', release: false } rules here.
            // Unscoped rules with release:false defeat scoped rules due to a
            // semantic-release quirk. Cross-package filtering is handled by
            // hasPackageChanges() which only runs semantic-release when files
            // in the package directory actually changed.
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
          provenance: false,
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

  // Detect which packages have changes since their last release
  const changedPackages = PACKAGES.filter((pkg) => {
    const changed = hasPackageChanges(pkg);
    const tag = getLastTag(pkg);
    console.log(
      `  ${changed ? '[changed]' : '[no changes]'} ${pkg.name} (last tag: ${tag || 'none'})`
    );
    return changed;
  });

  if (changedPackages.length === 0) {
    console.log('\nNo packages with changes detected. Nothing to release.');
    process.exit(0);
  }

  console.log(`\nReleasing ${changedPackages.length} package(s)...\n`);

  const results = [];
  for (const pkg of changedPackages) {
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

main().catch((error) => {
  console.error('Release script failed:', error);
  process.exit(1);
});
