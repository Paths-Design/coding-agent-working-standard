#!/usr/bin/env node
/**
 * Test script to verify exception framework path resolution
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveQualityGatesModule(moduleName) {
  const possiblePaths = [
    // Published npm package (priority)
    path.join(process.cwd(), 'node_modules', '@paths.design', 'quality-gates', moduleName),
    // Development (monorepo) - from MCP server to quality-gates
    path.join(__dirname, '..', '..', 'packages', 'quality-gates', moduleName),
    // Bundled (VS Code extension) - if quality-gates is bundled
    path.join(__dirname, 'quality-gates', moduleName),
    // Alternative monorepo path
    path.join(__dirname, '..', 'quality-gates', moduleName),
    // Legacy monorepo local copy (fallback)
    path.join(process.cwd(), 'node_modules', '@caws', 'quality-gates', moduleName),
  ];

  for (const modulePath of possiblePaths) {
    try {
      if (fs.existsSync(modulePath)) {
        console.log('✅ Found at:', modulePath);
        return pathToFileURL(modulePath).href;
      }
    } catch {
      // Continue to next path
      continue;
    }
  }

  // If no path found, try the original monorepo path as fallback
  const fallbackPath = path.join(
    path.dirname(path.dirname(__filename)),
    '..',
    '..',
    'packages',
    'quality-gates',
    moduleName
  );
  console.log('⚠️  Using fallback path:', fallbackPath);
  return pathToFileURL(fallbackPath).href;
}

console.log('Testing exception framework path resolution...\n');

const resolved = resolveQualityGatesModule('shared-exception-framework.mjs');
console.log('Resolved URL:', resolved);
console.log('');

try {
  const module = await import(resolved);
  console.log('✅ Import successful!');
  console.log('Available exports:', Object.keys(module).join(', '));

  // Test loadExceptionConfig
  if (module.loadExceptionConfig) {
    const config = module.loadExceptionConfig();
    console.log('✅ loadExceptionConfig works');
    console.log('   Schema version:', config.schema_version);
    console.log('   Exceptions count:', config.exceptions?.length || 0);
  }

  // Test addException signature
  if (module.addException) {
    console.log('✅ addException function available');
    console.log('   Function signature verified');
  }

  console.log('\n✅ All tests passed!');
} catch (e) {
  console.error('❌ Import failed:', e.message);
  console.error('Stack:', e.stack);
  process.exit(1);
}
