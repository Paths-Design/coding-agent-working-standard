/**
 * @fileoverview YAML Validation Utilities
 * Functions for validating YAML syntax and structure
 * @author @darianrosebrook
 */

const yaml = require('js-yaml');
const fs = require('fs-extra');
const path = require('path');

/**
 * Validate YAML syntax for a file
 * @param {string} filePath - Path to YAML file
 * @returns {Object} Validation result with valid flag and error details
 */
function validateYamlSyntax(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return {
        valid: false,
        error: `File not found: ${filePath}`,
        line: null,
        column: null,
      };
    }

    const content = fs.readFileSync(filePath, 'utf8');
    yaml.load(content); // Will throw if invalid

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error.message,
      line: error.mark?.line ? error.mark.line + 1 : null, // Convert to 1-based
      column: error.mark?.column ? error.mark.column + 1 : null, // Convert to 1-based
      snippet: error.mark?.snippet || null,
    };
  }
}

/**
 * Validate YAML syntax for multiple files
 * @param {string[]} filePaths - Array of file paths to validate
 * @returns {Object} Validation results with summary
 */
function validateYamlFiles(filePaths) {
  const results = {
    valid: true,
    files: [],
    errors: [],
  };

  for (const filePath of filePaths) {
    const validation = validateYamlSyntax(filePath);
    const relativePath = path.relative(process.cwd(), filePath);

    results.files.push({
      path: relativePath,
      ...validation,
    });

    if (!validation.valid) {
      results.valid = false;
      results.errors.push({
        file: relativePath,
        error: validation.error,
        line: validation.line,
        column: validation.column,
        snippet: validation.snippet,
      });
    }
  }

  return results;
}

/**
 * Find all YAML files in .caws directory
 * @param {string} projectRoot - Project root directory
 * @returns {string[]} Array of YAML file paths
 */
function findCawsYamlFiles(projectRoot) {
  const cawsDir = path.join(projectRoot, '.caws');
  const yamlFiles = [];

  if (!fs.existsSync(cawsDir)) {
    return yamlFiles;
  }

  function walkDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))
      ) {
        yamlFiles.push(fullPath);
      }
    }
  }

  walkDir(cawsDir);
  return yamlFiles;
}

/**
 * Validate all CAWS YAML files in project
 * @param {string} projectRoot - Project root directory
 * @returns {Object} Validation results
 */
function validateAllCawsYamlFiles(projectRoot) {
  const yamlFiles = findCawsYamlFiles(projectRoot);
  return validateYamlFiles(yamlFiles);
}

/**
 * Format validation error for display
 * @param {Object} error - Error object from validateYamlSyntax
 * @param {string} filePath - File path
 * @returns {string} Formatted error message
 */
function formatYamlError(error, filePath) {
  const relativePath = path.relative(process.cwd(), filePath);
  let message = `❌ Invalid YAML in ${relativePath}\n`;
  message += `   Error: ${error.error}\n`;

  if (error.line !== null) {
    message += `   Line: ${error.line}`;
    if (error.column !== null) {
      message += `, Column: ${error.column}`;
    }
    message += '\n';
  }

  if (error.snippet) {
    message += `   ${error.snippet}\n`;
  }

  return message;
}

module.exports = {
  validateYamlSyntax,
  validateYamlFiles,
  findCawsYamlFiles,
  validateAllCawsYamlFiles,
  formatYamlError,
};

