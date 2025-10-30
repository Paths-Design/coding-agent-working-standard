#!/usr/bin/env node
/**
 * Manual Release Script for CAWS CLI
 * 
 * This script allows manual version bumping and publishing when semantic-release
 * isn't detecting changes correctly.
 * 
 * @author @darianrosebrook
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const cliPackageJson = join(rootDir, 'packages', 'caws-cli', 'package.json');

const [,, versionType = 'minor'] = process.argv;

if (!['major', 'minor', 'patch'].includes(versionType)) {
  console.error('Usage: node scripts/manual-release.mjs [major|minor|patch]');
  console.error('Default: minor');
  process.exit(1);
}

console.log(`🔧 Manual release: bumping ${versionType} version`);

try {
  // Read current version
  const packageJson = JSON.parse(readFileSync(cliPackageJson, 'utf8'));
  const currentVersion = packageJson.version;
  console.log(`Current version: ${currentVersion}`);

  // Bump version
  const [major, minor, patch] = currentVersion.split('.').map(Number);
  let newVersion;
  
  if (versionType === 'major') {
    newVersion = `${major + 1}.0.0`;
  } else if (versionType === 'minor') {
    newVersion = `${major}.${minor + 1}.0`;
  } else {
    newVersion = `${major}.${minor}.${patch + 1}`;
  }

  console.log(`New version: ${newVersion}`);

  // Update package.json
  packageJson.version = newVersion;
  writeFileSync(cliPackageJson, JSON.stringify(packageJson, null, 2) + '\n');
  console.log(`✅ Updated ${cliPackageJson}`);

  // Build the package
  console.log('📦 Building package...');
  execSync('npm run build', { 
    cwd: join(rootDir, 'packages', 'caws-cli'),
    stdio: 'inherit'
  });

  // Publish to npm
  console.log('📤 Publishing to npm...');
  execSync(`npm publish --access public`, {
    cwd: join(rootDir, 'packages', 'caws-cli'),
    stdio: 'inherit',
    env: {
      ...process.env,
      NPM_TOKEN: process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN
    }
  });

  // Create git tag
  console.log(`🏷️  Creating git tag v${newVersion}...`);
  execSync(`git tag v${newVersion}`, { 
    cwd: rootDir,
    stdio: 'inherit'
  });

  // Commit the version bump
  console.log('💾 Committing version bump...');
  execSync(`git add ${cliPackageJson} package-lock.json`, { 
    cwd: rootDir,
    stdio: 'inherit'
  });
  execSync(`git commit -m "chore(release): ${newVersion} [skip ci]\n\nManual release due to semantic-release not detecting changes."`, { 
    cwd: rootDir,
    stdio: 'inherit'
  });

  console.log('\n✅ Manual release complete!');
  console.log(`\nNext steps:`);
  console.log(`1. git push origin main`);
  console.log(`2. git push origin v${newVersion}`);

} catch (error) {
  console.error('❌ Release failed:', error.message);
  process.exit(1);
}

