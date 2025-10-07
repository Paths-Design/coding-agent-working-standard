#!/usr/bin/env node

/**
 * Bundle CAWS dependencies for VS Code extension
 *
 * This script bundles the CAWS MCP server and CLI tools into the extension
 * for seamless out-of-the-box functionality (similar to ESLint's approach).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🔧 Bundling CAWS dependencies for VS Code extension...');

// Paths
const rootDir = path.join(__dirname, '..', '..', '..');
const mcpServerDir = path.join(rootDir, 'packages', 'caws-mcp-server');
const cliDir = path.join(rootDir, 'packages', 'caws-cli');
const bundleDir = path.join(__dirname, '..', 'bundled');

// Ensure bundle directory exists
if (!fs.existsSync(bundleDir)) {
  fs.mkdirSync(bundleDir, { recursive: true });
}

// Bundle MCP Server
console.log('📦 Bundling CAWS MCP Server...');
const mcpBundleDir = path.join(bundleDir, 'mcp-server');

if (!fs.existsSync(mcpBundleDir)) {
  fs.mkdirSync(mcpBundleDir, { recursive: true });
}

// Copy MCP server files
const mcpFiles = ['index.js', 'package.json', 'README.md'];

mcpFiles.forEach((file) => {
  const src = path.join(mcpServerDir, file);
  const dest = path.join(mcpBundleDir, file);

  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`  ✓ ${file}`);
  }
});

// Bundle CAWS CLI (compiled version)
console.log('📦 Bundling CAWS CLI...');
const cliBundleDir = path.join(bundleDir, 'cli');

if (!fs.existsSync(cliBundleDir)) {
  fs.mkdirSync(cliBundleDir, { recursive: true });
}

// Build CLI first
try {
  console.log('  Building CAWS CLI...');
  execSync('npm run build', { cwd: cliDir, stdio: 'inherit' });
} catch (error) {
  console.warn('Warning: CLI build failed, using existing build');
}

// Copy CLI files
const cliFiles = [
  'dist/index.js',
  'dist/waivers-manager.js',
  'dist/cicd-optimizer.js',
  'dist/tool-loader.js',
  'dist/tool-validator.js',
  'dist/tool-interface.js',
  'package.json',
  'README.md',
];

cliFiles.forEach((file) => {
  const src = path.join(cliDir, file);
  const dest = path.join(cliBundleDir, path.basename(file));

  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`  ✓ ${file}`);
  }
});

// Bundle essential templates
console.log('📦 Bundling CAWS templates...');
const templatesDir = path.join(cliDir, 'templates');
const templatesBundleDir = path.join(bundleDir, 'templates');

if (fs.existsSync(templatesDir)) {
  // Simple recursive copy
  function copyDir(src, dest) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }

    const files = fs.readdirSync(src);
    files.forEach((file) => {
      const srcPath = path.join(src, file);
      const destPath = path.join(dest, file);
      const stat = fs.statSync(srcPath);

      if (stat.isDirectory()) {
        copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    });
  }

  copyDir(templatesDir, templatesBundleDir);
  console.log('  ✓ Templates copied');
}

// Create bundle manifest
const manifest = {
  version: '1.0.0',
  bundled_at: new Date().toISOString(),
  components: {
    'mcp-server': {
      version: require(path.join(mcpServerDir, 'package.json')).version,
      files: mcpFiles,
    },
    cli: {
      version: require(path.join(cliDir, 'package.json')).version,
      files: cliFiles,
    },
    templates: {
      source: 'cli/templates',
      description: 'Project scaffolding templates',
    },
  },
  total_size_mb: getDirectorySize(bundleDir) / (1024 * 1024),
};

fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log('📋 Bundle manifest created');
console.log(`📊 Total bundle size: ${manifest.total_size_mb.toFixed(2)} MB`);
console.log('✅ CAWS dependencies bundled successfully!');

function getDirectorySize(dirPath) {
  let totalSize = 0;

  function calculateSize(itemPath) {
    const stats = fs.statSync(itemPath);

    if (stats.isDirectory()) {
      const files = fs.readdirSync(itemPath);
      files.forEach((file) => {
        calculateSize(path.join(itemPath, file));
      });
    } else {
      totalSize += stats.size;
    }
  }

  calculateSize(dirPath);
  return totalSize;
}
