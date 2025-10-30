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

    // Copy src directory with logger and monitoring
    const mcpServerSrc = path.join(mcpServerSource, 'src');
    if (await fs.pathExists(mcpServerSrc)) {
      await fs.copy(mcpServerSrc, path.join(mcpServerDest, 'src'));
      console.log('  ✅ Copied src directory');
    } else {
      console.warn('  ⚠️  src directory not found');
    }

    // Install MCP server dependencies
    console.log('  Installing MCP server dependencies...');

    try {
      execSync('npm install --production --no-audit --no-fund', {
        cwd: mcpServerDest,
        stdio: 'inherit',
      });
      console.log('  ✅ Installed all dependencies');
    } catch (error) {
      console.error('  ❌ Failed to install dependencies:', error.message);
      throw error;
    }

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

    // Bundle Quality Gates
    console.log('Bundling Quality Gates...');
    const qualityGatesSource = path.join(MONOREPO_ROOT, 'packages/quality-gates');
    const qualityGatesDest = path.join(BUNDLED_DIR, 'quality-gates');

    await fs.ensureDir(qualityGatesDest);

    // Copy all .mjs files (ES modules)
    const mjsFiles = await fs.readdir(qualityGatesSource);
    for (const file of mjsFiles) {
      if (file.endsWith('.mjs')) {
        await fs.copy(
          path.join(qualityGatesSource, file),
          path.join(qualityGatesDest, file)
        );
      }
    }
    console.log('  ✅ Copied quality gates modules');

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

    // Copy package.json for dependencies
    await fs.copy(
      path.join(qualityGatesSource, 'package.json'),
      path.join(qualityGatesDest, 'package.json')
    );

    // Install quality gates dependencies
    console.log('  Installing quality gates dependencies...');
    try {
      execSync('npm install --production --no-audit --no-fund', {
        cwd: qualityGatesDest,
        stdio: 'inherit',
      });
      console.log('  ✅ Installed all dependencies');
    } catch (error) {
      console.error('  ❌ Failed to install dependencies:', error.message);
      throw error;
    }

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
