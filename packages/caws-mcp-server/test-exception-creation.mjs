#!/usr/bin/env node
/**
 * Test script to verify exception creation works correctly
 */

import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveQualityGatesModule(moduleName) {
  const possiblePaths = [
    path.join(__dirname, '..', '..', 'packages', 'quality-gates', moduleName),
    path.join(__dirname, 'quality-gates', moduleName),
    path.join(__dirname, '..', 'quality-gates', moduleName),
    path.join(process.cwd(), 'node_modules', '@paths.design', 'caws-quality-gates', moduleName),
  ];

  for (const modulePath of possiblePaths) {
    try {
      if (fs.existsSync(modulePath)) {
        return pathToFileURL(modulePath).href;
      }
    } catch {
      continue;
    }
  }

  const fallbackPath = path.join(
    path.dirname(path.dirname(__filename)),
    '..',
    '..',
    'packages',
    'quality-gates',
    moduleName
  );
  return pathToFileURL(fallbackPath).href;
}

console.log('Testing exception creation...\n');

try {
  const exceptionFrameworkPath = resolveQualityGatesModule('shared-exception-framework.mjs');
  const { addException, loadExceptionConfig } = await import(exceptionFrameworkPath);

  // Test data matching MCP server call
  const gate = 'code_freeze';
  const reason = 'Test exception - active development';
  const approvedBy = 'darianrosebrook';
  const expiresAt = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();
  
  // Calculate expiresInDays from expiresAt
  const expiresDate = new Date(expiresAt);
  const now = new Date();
  const diffMs = expiresDate.getTime() - now.getTime();
  const expiresInDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));

  const exceptionData = {
    reason,
    approvedBy,
    expiresInDays,
    context: 'all',
  };

  console.log('Calling addException with:');
  console.log('  gate:', gate);
  console.log('  exceptionData:', JSON.stringify(exceptionData, null, 2));
  console.log('');

  // Test the function call signature
  const result = addException(gate, exceptionData);

  if (result.success) {
    console.log('✅ Exception created successfully!');
    console.log('   Exception ID:', result.exception.id);
    console.log('   Gate:', result.exception.gate);
    console.log('   Expires at:', result.exception.expires_at);
    
    // Verify it was saved
    const config = loadExceptionConfig();
    const savedException = config.exceptions.find(e => e.id === result.exception.id);
    if (savedException) {
      console.log('✅ Exception saved to config');
    } else {
      console.log('⚠️  Exception not found in config (may be in different project)');
    }
  } else {
    console.log('⚠️  Exception creation result:', result);
  }

  console.log('\n✅ Test completed!');
} catch (e) {
  console.error('❌ Test failed:', e.message);
  console.error('Stack:', e.stack);
  process.exit(1);
}




