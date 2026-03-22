/**
 * @fileoverview Schema validation gate
 * Validates the working spec against the CAWS schema.
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const Ajv = require('ajv');

const name = 'spec_completeness';

/**
 * Run the spec completeness gate
 * @param {Object} params - Gate parameters
 * @param {string} params.projectRoot - Project root
 * @returns {Promise<Object>} Gate result with status and messages
 */
async function run({ projectRoot }) {
  const messages = [];

  // Load the working spec
  const specPath = path.join(projectRoot, '.caws', 'working-spec.yaml');
  if (!await fs.pathExists(specPath)) {
    return { status: 'fail', messages: ['No working-spec.yaml found. Create one with: caws init'] };
  }

  let spec;
  try {
    const content = await fs.readFile(specPath, 'utf8');
    spec = yaml.load(content);
  } catch (err) {
    return { status: 'fail', messages: [`Failed to parse working-spec.yaml: ${err.message}`] };
  }

  if (!spec) {
    return { status: 'fail', messages: ['working-spec.yaml is empty'] };
  }

  // Try to find and load the schema
  const schemaPaths = [
    path.join(projectRoot, '.caws', 'schemas', 'working-spec.schema.json'),
    path.join(projectRoot, 'node_modules', '@caws', 'cli', 'templates', '.caws', 'schemas', 'working-spec.schema.json'),
  ];

  let schema = null;
  for (const schemaPath of schemaPaths) {
    if (await fs.pathExists(schemaPath)) {
      try {
        const schemaContent = await fs.readFile(schemaPath, 'utf8');
        schema = JSON.parse(schemaContent);
        break;
      } catch {
        // Try next path
      }
    }
  }

  if (!schema) {
    // No schema available; do basic structural validation
    const requiredFields = ['title', 'risk_tier'];
    const missing = requiredFields.filter(f => !(f in spec));
    if (missing.length > 0) {
      messages.push(`Missing required fields: ${missing.join(', ')}`);
      return { status: 'fail', messages };
    }
    return { status: 'pass', messages: ['Basic structure valid (no schema file found for full validation)'] };
  }

  // Validate with AJV
  try {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const valid = validate(spec);

    if (!valid) {
      for (const error of validate.errors) {
        const location = error.instancePath || '/';
        messages.push(`${location}: ${error.message}`);
      }
      return { status: 'fail', messages };
    }

    return { status: 'pass', messages };
  } catch (err) {
    return { status: 'fail', messages: [`Schema validation error: ${err.message}`] };
  }
}

module.exports = { name, run };
