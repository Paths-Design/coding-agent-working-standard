const Ajv = require('ajv');
const fs = require('fs-extra');
const path = require('path');

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false, validateFormats: false });
const cache = new Map();

function createValidator(schemaPath) {
  const resolved = path.resolve(schemaPath);
  if (cache.has(resolved)) return cache.get(resolved);
  const schema = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  // Remove $schema keyword — Ajv handles validation without it and
  // the 2020-12 meta-schema URI is not bundled with the base Ajv package.
  delete schema.$schema;
  const validate = ajv.compile(schema);
  const validator = (data) => {
    const valid = validate(data);
    return {
      valid,
      errors: valid ? [] : validate.errors.map(e => ({
        path: e.instancePath,
        message: e.message,
        params: e.params,
      })),
    };
  };
  cache.set(resolved, validator);
  return validator;
}

function getSchemaPath(schemaName, projectRoot) {
  const projectPath = path.join(projectRoot, '.caws', 'schemas', schemaName);
  if (fs.existsSync(projectPath)) return projectPath;
  return path.join(__dirname, '../../templates/.caws/schemas', schemaName);
}

module.exports = { createValidator, getSchemaPath };
