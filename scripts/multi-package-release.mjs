#!/usr/bin/env node
/**
 * Multi-Package Semantic Release Script
 * 
 * Detects which packages have changes and runs semantic-release for each one.
 * This avoids conflicts from multiple npm plugins in a single config.
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PACKAGES = [
  {
    name: '@paths.design/caws-cli',
    path: 'packages/caws-cli',
    scope: 'cli',
    config: {
      pkgRoot: 'packages/caws-cli',
      tarballDir: 'dist'
    }
  },
  {
    name: '@paths.design/caws-mcp-server',
    path: 'packages/caws-mcp-server',
    scope: 'mcp-server',
    config: {
      pkgRoot: 'packages/caws-mcp-server'
    }
  },
  {
    name: '@paths.design/caws-types',
    path: 'packages/caws-types',
    scope: 'caws-types',
    config: {
      pkgRoot: 'packages/caws-types'
    }
  },
  {
    name: '@paths.design/quality-gates',
    path: 'packages/quality-gates',
    scope: 'quality-gates',
    config: {
      pkgRoot: 'packages/quality-gates'
    }
  }
];

/**
 * Check if package has changes in recent commits
 */
function hasPackageChanges(packagePath, lastTag = null) {
  try {
    const gitCommand = lastTag
      ? `git diff --name-only ${lastTag}..HEAD -- ${packagePath}`
      : `git diff --name-only HEAD~10..HEAD -- ${packagePath}`;
    
    const output = execSync(gitCommand, { 
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    return output.trim().length > 0;
  } catch (error) {
    // If no commits or tag doesn't exist, check last 10 commits
    return hasPackageChanges(packagePath);
  }
}

/**
 * Get last tag for a package
 */
function getLastTag(packageName) {
  try {
    const tags = execSync(`git tag --sort=-version:refname | grep "^${packageName.replace('@', '').replace('/', '-')}-v" | head -1`, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return tags.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Create package-specific semantic-release config
 */
function createPackageConfig(pkg) {
  const config = {
    branches: ['main'],
    repositoryUrl: 'https://github.com/Paths-Design/coding-agent-working-standard.git',
    plugins: [
      [
        '@semantic-release/commit-analyzer',
        {
          preset: 'angular',
          releaseRules: [
            { revert: true, release: 'patch' },
            { breaking: true, release: 'major' },
            { type: 'feat', scope: pkg.scope, release: 'minor' },
            { type: 'fix', scope: pkg.scope, release: 'patch' },
            { type: 'feat', scope: `packages/${pkg.path.split('/').pop()}`, release: 'minor' },
            { type: 'fix', scope: `packages/${pkg.path.split('/').pop()}`, release: 'patch' },
            { type: 'feat', release: false },
            { type: 'fix', release: false },
            { type: 'perf', release: 'patch' },
            { type: 'revert', release: 'patch' },
            { type: 'docs', release: false },
            { type: 'chore', release: false },
            { type: 'refactor', release: false },
            { type: 'test', release: false },
            { type: 'build', release: false },
            { type: 'ci', release: false }
          ],
          parserOpts: {
            noteKeywords: ['BREAKING CHANGE', 'BREAKING CHANGES']
          }
        }
      ],
      '@semantic-release/release-notes-generator',
      [
        '@semantic-release/changelog',
        {
          changelogFile: `${pkg.path}/CHANGELOG.md`
        }
      ],
      [
        '@semantic-release/npm',
        {
          npmPublish: true,
          ...pkg.config,
          provenance: false
        }
      ],
      [
        '@semantic-release/git',
        {
          assets: [
            `${pkg.path}/CHANGELOG.md`,
            `${pkg.path}/package.json`
          ],
          message: `chore(release): ${pkg.name}@\${nextRelease.version} [skip ci]\n\n\${nextRelease.notes}`
        }
      ]
    ]
  };
  
  return JSON.stringify(config, null, 2);
}

/**
 * Run semantic-release for a specific package
 */
function releasePackage(pkg) {
  console.log(`\n📦 Releasing ${pkg.name}...`);
  
  const configPath = path.join(rootDir, `.releaserc.${pkg.scope}.json`);
  const config = createPackageConfig(pkg);
  
  try {
    // Write temporary config
    writeFileSync(configPath, config);
    
    // Run semantic-release
    execSync(`npx semantic-release --extends .releaserc.${pkg.scope}.json`, {
      cwd: rootDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN,
        NPM_TOKEN: process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN
      }
    });
    
    console.log(`✅ Successfully released ${pkg.name}`);
    
    // Clean up temp config
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
    
    return true;
  } catch (error) {
    console.error(`❌ Failed to release ${pkg.name}:`, error.message);
    
    // Clean up temp config
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
    
    return false;
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('🚀 Multi-Package Semantic Release\n');
  
  const changedPackages = PACKAGES.filter(pkg => {
    const hasChanges = hasPackageChanges(pkg.path);
    if (hasChanges) {
      console.log(`✓ ${pkg.name} has changes`);
    }
    return hasChanges;
  });
  
  if (changedPackages.length === 0) {
    console.log('ℹ️  No packages with changes detected');
    process.exit(0);
  }
  
  console.log(`\n📋 Releasing ${changedPackages.length} package(s)...\n`);
  
  const results = changedPackages.map(pkg => ({
    package: pkg.name,
    success: releasePackage(pkg)
  }));
  
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  console.log(`\n📊 Release Summary:`);
  console.log(`   ✅ Successful: ${successful}`);
  console.log(`   ❌ Failed: ${failed}`);
  
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error('❌ Release script failed:', error);
  process.exit(1);
});

