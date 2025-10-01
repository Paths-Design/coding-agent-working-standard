#!/usr/bin/env node

/**
 * @fileoverview CAWS Codemod Tool - Real Implementation
 * @author @darianrosebrook
 */

const tsMorph = require('ts-morph');
const fs = require('fs');
const path = require('path');

/**
 * Apply codemod transformations to the codebase
 * @param {boolean} dryRun - Whether to perform dry run (preview changes)
 * @param {string[]} targetPatterns - File patterns to transform
 */
function applyCodemod(dryRun = true, targetPatterns = ['src/**/*.js', 'apps/**/*.js']) {
  const project = new tsMorph.Project();

  console.log('🔍 CAWS Codemod - Code Quality Transformations');
  console.log('');

  // Add source files to the project
  targetPatterns.forEach((pattern) => {
    project.addSourceFilesAtPaths(pattern);
  });

  const transformations = [];

  // Apply various transformations
  transformations.push(...applyJSDocEnhancements(project));
  transformations.push(...applyLintingFixes(project));
  transformations.push(...applyCodeStandardization(project));
  transformations.push(...applyImportOptimizations(project));

  if (transformations.length === 0) {
    console.log('✅ No transformations needed - code is already well-formatted');
    return;
  }

  console.log(`📋 Applied ${transformations.length} transformations:`);
  transformations.slice(0, 10).forEach((transform, index) => {
    console.log(`  ${index + 1}. ${transform.file}: ${transform.description}`);
  });

  if (transformations.length > 10) {
    console.log(`  ... and ${transformations.length - 10} more`);
  }

  if (!dryRun) {
    project.saveSync();
    console.log('');
    console.log('✅ Transformations applied successfully');
  } else {
    console.log('');
    console.log('🔍 Dry run completed - no changes made');
    console.log('💡 Run with --apply flag to apply transformations');
  }
}

/**
 * Apply JSDoc enhancements to functions and classes
 * @param {tsMorph.Project} project - TypeScript project
 * @returns {Array} Array of transformation descriptions
 */
function applyJSDocEnhancements(project) {
  const transformations = [];

  project.getSourceFiles().forEach((sourceFile) => {
    // Add JSDoc to functions without documentation
    sourceFile.getFunctions().forEach((func) => {
      if (!func.getJsDocs().length && !func.getName().startsWith('_')) {
        const params = func.getParameters().map((param) => ({
          name: param.getName(),
          type: param.getType().getText(),
        }));

        const returnType = func.getReturnType().getText();

        const jsDoc = `/**
 * ${func.getName()} - ${generateFunctionDescription(func)}
 * @param {${params.map((p) => p.type).join('} ')}} ${params.map((p) => p.name).join(' ')}
 * @returns {${returnType}} ${returnType !== 'void' ? 'The result of the operation' : ''}
 */`;

        func.addJsDoc(jsDoc);
        transformations.push({
          file: sourceFile.getFilePath(),
          description: `Added JSDoc to ${func.getName()}`,
        });
      }
    });

    // Add JSDoc to classes without documentation
    sourceFile.getClasses().forEach((cls) => {
      if (!cls.getJsDocs().length) {
        const jsDoc = `/**
 * ${cls.getName()} - ${generateClassDescription(cls)}
 */`;

        cls.addJsDoc(jsDoc);
        transformations.push({
          file: sourceFile.getFilePath(),
          description: `Added JSDoc to ${cls.getName()}`,
        });
      }
    });
  });

  return transformations;
}

/**
 * Apply linting fixes
 * @param {tsMorph.Project} project - TypeScript project
 * @returns {Array} Array of transformation descriptions
 */
function applyLintingFixes(project) {
  const transformations = [];

  project.getSourceFiles().forEach((sourceFile) => {
    let modified = false;

    // Fix trailing commas
    sourceFile.getDescendantsOfKind(tsMorph.SyntaxKind.CommaToken).forEach((comma) => {
      const nextToken = comma.getNextSibling();
      if (nextToken && nextToken.getKind() === tsMorph.SyntaxKind.CloseBraceToken) {
        // Remove trailing comma
        comma.replaceWithText('');
        modified = true;
      }
    });

    // Fix spacing issues
    sourceFile.getDescendantsOfKind(tsMorph.SyntaxKind.Identifier).forEach((identifier) => {
      const prevToken = identifier.getPreviousSibling();
      if (prevToken && prevToken.getKind() === tsMorph.SyntaxKind.OpenParenToken) {
        // Ensure space before opening parenthesis
        const text = identifier.getText();
        if (!text.startsWith(' ')) {
          identifier.replaceWithText(` ${text}`);
          modified = true;
        }
      }
    });

    if (modified) {
      transformations.push({
        file: sourceFile.getFilePath(),
        description: 'Applied linting fixes',
      });
    }
  });

  return transformations;
}

/**
 * Apply code standardization
 * @param {tsMorph.Project} project - TypeScript project
 * @returns {Array} Array of transformation descriptions
 */
function applyCodeStandardization(project) {
  const transformations = [];

  project.getSourceFiles().forEach((sourceFile) => {
    let modified = false;

    // Standardize function declarations
    sourceFile.getFunctions().forEach((func) => {
      if (func.isArrowFunction()) {
        // Convert to function declaration if appropriate
        const body = func.getBody();
        if (body && body.getKind() === tsMorph.SyntaxKind.Block) {
          // Keep arrow functions for simple expressions
          const statements = body.getStatements();
          if (
            statements.length === 1 &&
            statements[0].getKind() === tsMorph.SyntaxKind.ReturnStatement
          ) {
            // Keep as arrow function
          } else {
            // Convert to function declaration for complex logic
            const name = func.getName();
            if (name) {
              func.replaceWithText(
                `function ${name}(${func
                  .getParameters()
                  .map((p) => p.getText())
                  .join(', ')}) {\n  ${body.getText()}\n}`
              );
              modified = true;
            }
          }
        }
      }
    });

    if (modified) {
      transformations.push({
        file: sourceFile.getFilePath(),
        description: 'Standardized function declarations',
      });
    }
  });

  return transformations;
}

/**
 * Apply import optimizations
 * @param {tsMorph.Project} project - TypeScript project
 * @returns {Array} Array of transformation descriptions
 */
function applyImportOptimizations(project) {
  const transformations = [];

  project.getSourceFiles().forEach((sourceFile) => {
    // Group imports by source
    const importDeclarations = sourceFile.getImportDeclarations();
    if (importDeclarations.length > 1) {
      const groupedImports = new Map();

      importDeclarations.forEach((imp) => {
        const moduleSpecifier = imp.getModuleSpecifierValue();
        if (!groupedImports.has(moduleSpecifier)) {
          groupedImports.set(moduleSpecifier, []);
        }
        groupedImports.get(moduleSpecifier).push(imp);
      });

      // Combine imports from same module
      groupedImports.forEach((imports, module) => {
        if (imports.length > 1) {
          const allNamedImports = imports.flatMap((imp) =>
            imp.getNamedImports().map((ni) => ni.getName())
          );

          if (allNamedImports.length > 0) {
            const combinedImport = `import { ${allNamedImports.join(', ')} } from '${module}';`;

            // Replace all imports from this module with combined import
            imports.forEach((imp) => imp.remove());
            sourceFile.addImportDeclaration({
              namedImports: allNamedImports,
              moduleSpecifier: module,
            });

            transformations.push({
              file: sourceFile.getFilePath(),
              description: `Combined ${imports.length} imports from ${module}`,
            });
          }
        }
      });
    }
  });

  return transformations;
}

/**
 * Generate function description for JSDoc
 * @param {tsMorph.FunctionDeclaration} func - Function node
 * @returns {string} Generated description
 */
function generateFunctionDescription(func) {
  const name = func.getName();
  const params = func.getParameters();

  if (name) {
    if (params.length === 0) {
      return `Execute ${name} operation`;
    } else {
      return `Process ${name} with ${params.length} parameter${params.length > 1 ? 's' : ''}`;
    }
  }

  return 'Perform operation';
}

/**
 * Generate class description for JSDoc
 * @param {tsMorph.ClassDeclaration} cls - Class node
 * @returns {string} Generated description
 */
function generateClassDescription(cls) {
  const name = cls.getName();
  const methods = cls.getMethods().length;

  return `${name} class with ${methods} method${methods !== 1 ? 's' : ''}`;
}

// Command-line interface
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--apply');
  const targetPatterns = args.filter((arg) => !arg.startsWith('--'));

  console.log('🔧 CAWS Codemod Tool');
  console.log('');

  try {
    applyCodemod(dryRun, targetPatterns.length > 0 ? targetPatterns : undefined);
  } catch (error) {
    console.error(`❌ Error applying codemod: ${error.message}`);
    process.exit(1);
  }
}

// Export for module usage
module.exports = {
  applyCodemod,
  applyJSDocEnhancements,
  applyLintingFixes,
  applyCodeStandardization,
  applyImportOptimizations,
};
