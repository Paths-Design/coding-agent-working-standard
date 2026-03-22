/**
 * @fileoverview Schema Validator Utility
 * Provides AJV-based JSON Schema validation with schema file resolution.
 * Schemas live in templates/.caws/schemas/ and are resolved relative to
 * the package root or a given project directory.
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

/**
 * Resolve the path to a schema file.
 * Looks in the following locations (in order):
 *   1. <projectRoot>/.caws/schemas/<schemaName>
 *   2. <caws-cli>/templates/.caws/schemas/<schemaName>
 *
 * @param {string} schemaName - Schema filename (e.g., 'scope.schema.json')
 * @param {string} [projectRoot] - Project root to check first
 * @returns {string} Absolute path to the schema file
 * @throws {Error} If the schema file cannot be found
 */
function getSchemaPath(schemaName, projectRoot) {
  // 1. Check project-local schemas
  if (projectRoot) {
    const localPath = path.join(projectRoot, '.caws', 'schemas', schemaName);
    if (fs.existsSync(localPath)) {
      return localPath;
    }
  }

  // 2. Check caws-cli templates (package-relative)
  const templatePath = path.join(__dirname, '..', '..', 'templates', '.caws', 'schemas', schemaName);
  if (fs.existsSync(templatePath)) {
    return templatePath;
  }

  throw new Error(`Schema file not found: ${schemaName}`);
}

/**
 * Create a validator function for a given schema file.
 *
 * @param {string} schemaPath - Absolute path to the JSON Schema file
 * @returns {function(Object): {valid: boolean, errors: Array}} Validator function
 */
function createValidator(schemaPath) {
  const schemaContent = fs.readFileSync(schemaPath, 'utf8');
  const schema = JSON.parse(schemaContent);

  // Remove $schema meta-reference — the installed AJV version uses draft-07
  // by default and doesn't recognize the 2020-12 meta-schema URI.
  delete schema.$schema;

  // Strip "format" keywords from the schema tree since ajv-formats is not
  // installed.  AJV v8 throws on unknown format names even with
  // validateFormats:false — removing them is the only reliable workaround.
  stripFormatKeywords(schema);

  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, validateFormats: false });
  const validate = ajv.compile(schema);

  return function validateData(data) {
    const valid = validate(data);
    return {
      valid,
      errors: valid
        ? []
        : validate.errors.map((err) => ({
            instancePath: err.instancePath || '',
            message: err.message || 'Unknown validation error',
            params: err.params,
          })),
    };
  };
}

/**
 * Recursively remove "format" keywords from a JSON Schema object.
 * This is necessary because AJV v8 throws on unknown format names
 * (date-time, uri, etc.) when ajv-formats is not installed.
 * @param {Object} obj - Schema or sub-schema object
 */
function stripFormatKeywords(obj) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach(stripFormatKeywords);
    return;
  }
  delete obj.format;
  for (const value of Object.values(obj)) {
    stripFormatKeywords(value);
  }
}

module.exports = {
  getSchemaPath,
  createValidator,
};
