#!/usr/bin/env node

/**
 * Bundle Dependencies Script for CAWS VS Code Extension
 *
 * This script bundles the CAWS MCP server and CLI into the extension
 * so they can be used without external installation.
 *
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');

const EXTENSION_ROOT = path.resolve(__dirname, '..');
const MONOREPO_ROOT = path.resolve(EXTENSION_ROOT, '../..');
const BUNDLED_DIR = path.join(EXTENSION_ROOT, 'bundled');

async function main() {
  console.log('Starting CAWS extension dependency bundling...\n');

  try {
    // Clean bundled directory
    console.log('Cleaning bundled directory...');
    await fs.remove(BUNDLED_DIR);
    await fs.ensureDir(BUNDLED_DIR);
    console.log('✅ Cleaned bundled directory\n');

    // Bundle MCP Server
    console.log('Bundling MCP server...');
    const mcpServerSource = path.join(MONOREPO_ROOT, 'packages/caws-mcp-server');
    const mcpServerDest = path.join(BUNDLED_DIR, 'mcp-server');

    await fs.ensureDir(mcpServerDest);
    await fs.copy(path.join(mcpServerSource, 'index.js'), path.join(mcpServerDest, 'index.js'));
    await fs.copy(
      path.join(mcpServerSource, 'package.json'),
      path.join(mcpServerDest, 'package.json')
    );

    // Copy MCP server dependencies
    console.log('  Copying MCP server dependencies...');
    const mcpDestModules = path.join(mcpServerDest, 'node_modules');
    await fs.ensureDir(mcpDestModules);

    // Copy from monorepo root (where the dependencies are actually installed)
    const monorepoNodeModules = path.join(MONOREPO_ROOT, 'node_modules');
    if (await fs.pathExists(monorepoNodeModules)) {
      // Copy @modelcontextprotocol and its dependencies
      const mcpDeps = [
        '@modelcontextprotocol',
        'zod',
        'content-type',
        'raw-body'
      ];

      for (const dep of mcpDeps) {
        const depPath = path.join(monorepoNodeModules, dep);
        if (await fs.pathExists(depPath)) {
          await fs.copy(depPath, path.join(mcpDestModules, dep));
          console.log(`    ✅ Copied ${dep}`);
        } else {
          console.warn(`    ⚠️  ${dep} not found in monorepo node_modules`);
        }
      }
    }

    console.log('✅ Bundled MCP server\n');

    // Bundle CLI
    console.log('Bundling CAWS CLI...');
    const cliSource = path.join(MONOREPO_ROOT, 'packages/caws-cli');
    const cliDest = path.join(BUNDLED_DIR, 'cli');

    await fs.ensureDir(cliDest);

    // Copy CLI dist directory
    const cliDist = path.join(cliSource, 'dist');
    if (await fs.pathExists(cliDist)) {
      await fs.copy(cliDist, path.join(cliDest, 'dist'));
    } else {
      console.warn('  ⚠️  CLI dist directory not found. Run `npm run build` in caws-cli first.');
    }

    // Copy CLI package.json
    await fs.copy(path.join(cliSource, 'package.json'), path.join(cliDest, 'package.json'));

    // Copy CLI templates
    const cliTemplates = path.join(cliSource, 'templates');
    if (await fs.pathExists(cliTemplates)) {
      await fs.copy(cliTemplates, path.join(cliDest, 'templates'));
    }

    // Copy ALL CLI dependencies (handles monorepo hoisting)
    console.log('  Copying CLI dependencies...');
    const cliDestModules = path.join(cliDest, 'node_modules');
    await fs.ensureDir(cliDestModules);

    const cliPackageJson = require(path.join(cliSource, 'package.json'));
    const cliDeps = Object.keys(cliPackageJson.dependencies || {});

    // First, copy from CLI's local node_modules (non-hoisted packages)
    const cliLocalNodeModules = path.join(cliSource, 'node_modules');
    if (await fs.pathExists(cliLocalNodeModules)) {
      const localDeps = await fs.readdir(cliLocalNodeModules);
      for (const dep of localDeps) {
        await fs.copy(path.join(cliLocalNodeModules, dep), path.join(cliDestModules, dep));
        console.log(`    ✅ Copied ${dep} (from CLI)`);
      }
    }

    // Then, copy ALL packages from monorepo root (includes all transitive deps)
    console.log('    Copying all hoisted dependencies from monorepo root...');
    if (await fs.pathExists(monorepoNodeModules)) {
      const allPackages = await fs.readdir(monorepoNodeModules);
      let copiedCount = 0;
      let skippedCount = 0;

      for (const pkg of allPackages) {
        // Skip hidden files and non-directories
        if (pkg.startsWith('.')) continue;

        const pkgPath = path.join(monorepoNodeModules, pkg);
        const stat = await fs.stat(pkgPath);
        if (!stat.isDirectory()) continue;

        // Skip if already copied from CLI local node_modules
        const destPath = path.join(cliDestModules, pkg);
        if (await fs.pathExists(destPath)) {
          skippedCount++;
          continue;
        }

        await fs.copy(pkgPath, destPath);
        copiedCount++;
      }

      console.log(`    ✅ Copied ${copiedCount} packages, skipped ${skippedCount} existing`);
    }

    // Also copy common transitive dependencies that might be hoisted
    const commonTransitiveDeps = [
      'universalify',
      'graceful-fs',
      'jsonfile',
      'ansi-styles',
      '@types'
    ];

    for (const dep of commonTransitiveDeps) {
      const depDestPath = path.join(cliDestModules, dep);
      if (await fs.pathExists(depDestPath)) {
        continue;
      }

      const depPath = path.join(monorepoNodeModules, dep);
      if (await fs.pathExists(depPath)) {
        await fs.copy(depPath, depDestPath);
        console.log(`    ✅ Copied ${dep} (transitive)`);
      }
    }

    console.log('✅ Bundled CAWS CLI\n');

    // Create bundled info file
    const bundledInfo = {
      bundledAt: new Date().toISOString(),
      mcpServer: {
        version: require(path.join(mcpServerSource, 'package.json')).version,
        path: 'bundled/mcp-server',
      },
      cli: {
        version: require(path.join(cliSource, 'package.json')).version,
        path: 'bundled/cli',
      },
    };

    await fs.writeJSON(path.join(BUNDLED_DIR, 'bundle-info.json'), bundledInfo, { spaces: 2 });
    console.log('✅ Created bundle info\n');

    // Generate summary
    console.log('Bundle Summary:');
    console.log('─'.repeat(50));
    console.log(`MCP Server v${bundledInfo.mcpServer.version} → ${bundledInfo.mcpServer.path}`);
    console.log(`CAWS CLI v${bundledInfo.cli.version} → ${bundledInfo.cli.path}`);
    console.log('─'.repeat(50));
    console.log('\n✅ Bundling complete!');
    console.log('\nBundled files are ready for extension packaging.');
  } catch (error) {
    console.error('❌ Bundling failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
