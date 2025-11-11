#!/usr/bin/env node

/**
 * Bundle Dependencies Script for CAWS VS Code Extension
 *
 * This script bundles the CAWS MCP server and CLI into the extension
 * so they can be used without external installation.
 * Uses esbuild to bundle dependencies into single files, eliminating node_modules.
 *
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const glob = require('glob');

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

    // Bundle MCP Server with esbuild (single file, no node_modules)
    console.log('Bundling MCP server with esbuild...');
    const mcpServerSource = path.join(MONOREPO_ROOT, 'packages/caws-mcp-server');
    const mcpServerDest = path.join(BUNDLED_DIR, 'mcp-server');

    await fs.ensureDir(mcpServerDest);

    // Check if esbuild is available
    try {
      execSync('npx esbuild --version', { stdio: 'pipe' });
    } catch (error) {
      console.log('  Installing esbuild...');
      execSync('npm install --save-dev esbuild', { cwd: EXTENSION_ROOT, stdio: 'inherit' });
    }

    // Bundle MCP server entry point with all dependencies
    const mcpServerEntry = path.join(mcpServerSource, 'index.js');
    const mcpServerBundle = path.join(mcpServerDest, 'index.js');

    console.log('  Bundling MCP server dependencies...');
    try {
      execSync(
        `npx esbuild "${mcpServerEntry}" --bundle --platform=node --target=node18 --format=esm --outfile="${mcpServerBundle}" --external:@paths.design/caws-cli --external:@paths.design/quality-gates --banner:js="#!/usr/bin/env node"`,
        { stdio: 'inherit', cwd: EXTENSION_ROOT }
      );
      console.log('  ✅ Bundled MCP server (single file)');
    } catch (error) {
      console.error('  ❌ Failed to bundle MCP server:', error.message);
      throw error;
    }

    // Copy minimal package.json (just for version info)
    const mcpServerPackageJson = require(path.join(mcpServerSource, 'package.json'));
    const minimalMcpPackageJson = {
      name: mcpServerPackageJson.name,
      version: mcpServerPackageJson.version,
      description: mcpServerPackageJson.description,
      type: 'module',
    };
    await fs.writeJSON(path.join(mcpServerDest, 'package.json'), minimalMcpPackageJson, {
      spaces: 2,
    });

    console.log('✅ Bundled MCP server\n');

    // Bundle CLI with esbuild (dramatically smaller!)
    console.log('Bundling CAWS CLI with esbuild...');
    const cliSource = path.join(MONOREPO_ROOT, 'packages/caws-cli');
    const cliDest = path.join(BUNDLED_DIR, 'cli');

    await fs.ensureDir(cliDest);

    // Check if bundled CLI exists, if not build it
    const cliBundleSource = path.join(cliSource, 'dist-bundle/index.js');
    if (!(await fs.pathExists(cliBundleSource))) {
      console.log('  Building CLI bundle with esbuild...');
      execSync('node esbuild.config.js', { cwd: cliSource, stdio: 'inherit' });
    }

    // Copy the bundled CLI (single 2MB file!)
    await fs.copy(cliBundleSource, path.join(cliDest, 'index.js'));
    await fs.copy(
      path.join(cliSource, 'dist-bundle/index.js.map'),
      path.join(cliDest, 'index.js.map')
    );
    console.log('  ✅ Copied bundled CLI (2 MB)');

    // Copy CLI templates (still needed for scaffolding)
    const cliTemplates = path.join(cliSource, 'templates');
    if (await fs.pathExists(cliTemplates)) {
      await fs.copy(cliTemplates, path.join(cliDest, 'templates'));
      console.log('  ✅ Copied templates');
    }

    // Copy minimal package.json (just for version info)
    const cliPackageJson = require(path.join(cliSource, 'package.json'));
    const minimalPackageJson = {
      name: cliPackageJson.name,
      version: cliPackageJson.version,
      description: cliPackageJson.description,
    };
    await fs.writeJSON(path.join(cliDest, 'package.json'), minimalPackageJson, { spaces: 2 });

    console.log('✅ Bundled CAWS CLI (esbuild)\n');

    // Bundle Quality Gates with esbuild (single file for main entry, copy others)
    console.log('Bundling Quality Gates...');
    const qualityGatesSource = path.join(MONOREPO_ROOT, 'packages/quality-gates');
    const qualityGatesDest = path.join(BUNDLED_DIR, 'quality-gates');

    await fs.ensureDir(qualityGatesDest);

    // Bundle the main entry point (run-quality-gates.mjs) with dependencies
    const qualityGatesEntry = path.join(qualityGatesSource, 'run-quality-gates.mjs');
    const qualityGatesBundle = path.join(qualityGatesDest, 'run-quality-gates.mjs');

    console.log('  Bundling quality gates main entry with dependencies...');
    try {
      execSync(
        `npx esbuild "${qualityGatesEntry}" --bundle --platform=node --target=node16 --format=esm --outfile="${qualityGatesBundle}" --banner:js="#!/usr/bin/env node"`,
        { stdio: 'inherit', cwd: EXTENSION_ROOT }
      );
      console.log('  ✅ Bundled main entry point');
    } catch (error) {
      console.error('  ❌ Failed to bundle quality gates:', error.message);
      throw error;
    }

    // Copy other .mjs files (they may import each other, but we'll bundle the main one)
    const mjsFiles = await fs.readdir(qualityGatesSource);
    for (const file of mjsFiles) {
      if (file.endsWith('.mjs') && file !== 'run-quality-gates.mjs') {
        await fs.copy(
          path.join(qualityGatesSource, file),
          path.join(qualityGatesDest, file)
        );
      }
    }
    console.log('  ✅ Copied other quality gates modules');

    // Copy configuration files
    const configPatterns = ['*.yaml', '*.yml', '*.json'];
    for (const pattern of configPatterns) {
      const files = glob.sync(pattern, { cwd: qualityGatesSource });
      for (const file of files) {
        if (file !== 'package.json' && file !== 'package-lock.json') {
          await fs.copy(
            path.join(qualityGatesSource, file),
            path.join(qualityGatesDest, file)
          );
        }
      }
    }

    // Copy templates directory if it exists
    const templatesDir = path.join(qualityGatesSource, 'templates');
    if (await fs.pathExists(templatesDir)) {
      await fs.copy(templatesDir, path.join(qualityGatesDest, 'templates'));
      console.log('  ✅ Copied templates directory');
    }

    // Copy minimal package.json (just for version info)
    const qualityGatesPackageJson = require(path.join(qualityGatesSource, 'package.json'));
    const minimalQgPackageJson = {
      name: qualityGatesPackageJson.name,
      version: qualityGatesPackageJson.version,
      description: qualityGatesPackageJson.description,
      type: 'module',
    };
    await fs.writeJSON(path.join(qualityGatesDest, 'package.json'), minimalQgPackageJson, {
      spaces: 2,
    });

    console.log('✅ Bundled Quality Gates\n');

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
      qualityGates: {
        version: require(path.join(qualityGatesSource, 'package.json')).version,
        path: 'bundled/quality-gates',
      },
    };

    await fs.writeJSON(path.join(BUNDLED_DIR, 'bundle-info.json'), bundledInfo, { spaces: 2 });
    console.log('✅ Created bundle info\n');

    // Generate summary
    console.log('Bundle Summary:');
    console.log('─'.repeat(50));
    console.log(`MCP Server v${bundledInfo.mcpServer.version} → ${bundledInfo.mcpServer.path}`);
    console.log(`CAWS CLI v${bundledInfo.cli.version} → ${bundledInfo.cli.path}`);
    console.log(`Quality Gates v${bundledInfo.qualityGates.version} → ${bundledInfo.qualityGates.path}`);
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
