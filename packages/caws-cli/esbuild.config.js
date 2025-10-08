#!/usr/bin/env node

/**
 * esbuild Configuration for CAWS CLI
 * 
 * Bundles the CLI into a single file to:
 * - Resolve ESM/CommonJS conflicts
 * - Reduce bundle size dramatically
 * - Eliminate node_modules dependency in production
 * - Enable tree-shaking to remove unused code
 * 
 * @author @darianrosebrook
 */

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

async function build() {
  try {
    console.log('Building CAWS CLI with esbuild...\n');

    // Clean dist directory
    const distPath = path.join(__dirname, 'dist-bundle');
    if (fs.existsSync(distPath)) {
      fs.rmSync(distPath, { recursive: true });
    }
    fs.mkdirSync(distPath, { recursive: true });

    const result = await esbuild.build({
      entryPoints: ['src/index.js'],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: 'dist-bundle/index.js',
      external: [
        // Node.js built-ins (automatically handled by esbuild)
        // Optional peer dependencies
        'fsevents',
        
        // Keep these external as they may need dynamic resolution
        // (Remove if they cause issues - esbuild can bundle them)
      ],
      minify: false, // Keep readable for debugging
      sourcemap: true,
      logLevel: 'info',
      metafile: true, // Generate bundle analysis
    });

    // Make the bundle executable (shebang is already included from source)
    const bundlePath = path.join(__dirname, 'dist-bundle/index.js');
    fs.chmodSync(bundlePath, '755');

    // Write bundle analysis
    const analysisPath = path.join(__dirname, 'dist-bundle/meta.json');
    fs.writeFileSync(analysisPath, JSON.stringify(result.metafile, null, 2));

    // Calculate bundle size
    const stats = fs.statSync(bundlePath);
    const sizeInMB = (stats.size / (1024 * 1024)).toFixed(2);

    console.log('\n✅ Bundle complete!');
    console.log(`📦 Output: dist-bundle/index.js`);
    console.log(`📊 Size: ${sizeInMB} MB`);
    console.log(`📈 Analysis: dist-bundle/meta.json`);
    console.log(`\nTo visualize bundle: npx esbuild-visualizer dist-bundle/meta.json`);
  } catch (error) {
    console.error('❌ Build failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  build();
}

module.exports = { build };

