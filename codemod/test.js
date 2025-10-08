#!/usr/bin/env node

/**
 * CAWS Test Codemod
 * Example codemod for testing CAWS framework transformations
 * @author CAWS Framework
 */

const { Project } = require('ts-morph');

function runTestCodemod(dryRun = true) {
  console.log('🧪 Running CAWS test codemod...');

  const project = new Project();

  // Load source files from packages
  const sourceFiles = project.addSourceFilesAtPaths([
    'packages/caws-cli/src/**/*.ts',
    'packages/caws-mcp-server/**/*.js',
  ]);

  console.log(`📁 Found ${sourceFiles.length} source files to process`);

  let transformations = 0;

  for (const sourceFile of sourceFiles) {
    const filePath = sourceFile.getFilePath();
    console.log(`Processing: ${filePath}`);

    // Example transformation: Add TODO comments to console.log statements
    const consoleLogCalls = sourceFile
      .getDescendantsOfKind(23) // CallExpression
      .filter((call) => {
        const expression = call.getExpression();
        return expression.getText() === 'console.log';
      });

    for (const call of consoleLogCalls) {
      // Add a comment above console.log statements
      const comment = `// TODO: Remove debug logging before production`;
      const callText = call.getText();

      // Insert comment before the call
      const fullText = sourceFile.getFullText();
      const callStart = call.getStart();
      const beforeCall = fullText.substring(0, callStart);
      const afterCall = fullText.substring(callStart);

      // Only add if comment doesn't already exist
      if (!beforeCall.includes('TODO: Remove debug logging')) {
        const newText = beforeCall + comment + '\n  ' + afterCall;
        sourceFile.replaceWithText(newText);
        transformations++;
        console.log(`  ✅ Added debug comment to console.log`);
      }
    }
  }

  console.log(`📊 Codemod completed: ${transformations} transformations applied`);

  if (!dryRun) {
    project.saveSync();
    console.log('💾 Changes saved to files');
  } else {
    console.log('🔍 Dry run - no files modified');
  }

  return {
    filesProcessed: sourceFiles.length,
    transformationsApplied: transformations,
  };
}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--apply');

  try {
    const result = runTestCodemod(dryRun);
    console.log('✅ Test codemod executed successfully');
    console.log(`   Files processed: ${result.filesProcessed}`);
    console.log(`   Transformations: ${result.transformationsApplied}`);
  } catch (error) {
    console.error('❌ Test codemod failed:', error.message);
    process.exit(1);
  }
}

module.exports = { runTestCodemod };
