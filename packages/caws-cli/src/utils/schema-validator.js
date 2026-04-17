const Ajv = require('ajv');
const fs = require('fs-extra');
const path = require('path');

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false, validateFormats: false });
const cache = new Map();

function createValidator(schemaPath) {
  const resolved = path.resolve(schemaPath);
  if (cache.has(resolved)) return cache.get(resolved);
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse schema file ${resolved}: ${err.message}`);
  }
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
  // Order: flat repo layout (`.caws/<name>.schema.json`) wins so
  // repos that tightened a schema in-place (e.g. CAWSFIX-03) are
  // the authoritative source. Nested `.caws/schemas/<name>.schema.json`
  // is the legacy layout kept for back-compat. Bundled template is
  // the last-resort fallback used by globally-installed CLIs and
  // projects without a local copy.
  const flatPath = path.join(projectRoot, '.caws', schemaName);
  if (fs.existsSync(flatPath)) return flatPath;
  const nestedPath = path.join(projectRoot, '.caws', 'schemas', schemaName);
  if (fs.existsSync(nestedPath)) return nestedPath;
  return path.join(__dirname, '../../templates/.caws/schemas', schemaName);
}

module.exports = { createValidator, getSchemaPath };
