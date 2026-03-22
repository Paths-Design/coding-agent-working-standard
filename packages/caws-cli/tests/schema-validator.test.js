const path = require('path');
const { createValidator, getSchemaPath } = require('../src/utils/schema-validator');

const TEMPLATES_SCHEMAS = path.join(__dirname, '../templates/.caws/schemas');

describe('createValidator', () => {
  test('compiles a real schema and validates well-formed data', () => {
    const schemaPath = path.join(TEMPLATES_SCHEMAS, 'worktrees.schema.json');
    const validate = createValidator(schemaPath);

    const result = validate({
      version: 1,
      worktrees: {
        'my-worktree': {
          name: 'my-worktree',
          path: '/tmp/wt',
          branch: 'feat/thing',
          baseBranch: 'main',
          scope: null,
          specId: null,
          owner: null,
          createdAt: '2026-01-01T00:00:00Z',
          status: 'active',
        },
      },
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('returns errors for malformed data (missing required field)', () => {
    const schemaPath = path.join(TEMPLATES_SCHEMAS, 'worktrees.schema.json');
    const validate = createValidator(schemaPath);

    // Missing required "worktrees" field
    const result = validate({ version: 1 });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('error format includes path and message', () => {
    const schemaPath = path.join(TEMPLATES_SCHEMAS, 'worktrees.schema.json');
    const validate = createValidator(schemaPath);

    const result = validate({});

    expect(result.valid).toBe(false);
    const error = result.errors[0];
    expect(error).toHaveProperty('path');
    expect(error).toHaveProperty('message');
    expect(error).toHaveProperty('params');
    expect(typeof error.message).toBe('string');
  });

  test('cache hit — second call returns same validator reference', () => {
    const schemaPath = path.join(TEMPLATES_SCHEMAS, 'worktrees.schema.json');
    const v1 = createValidator(schemaPath);
    const v2 = createValidator(schemaPath);

    expect(v1).toBe(v2);
  });

  test('missing schema path throws an error', () => {
    expect(() => {
      createValidator('/nonexistent/path/schema.json');
    }).toThrow();
  });
});

describe('getSchemaPath', () => {
  test('resolves from templates when project path does not exist', () => {
    const result = getSchemaPath('worktrees.schema.json', '/tmp/no-such-project');

    // Should fall back to the templates path
    expect(result).toContain('templates/.caws/schemas/worktrees.schema.json');
  });

  test('resolves from project root when project schema exists', () => {
    // Use the worktree itself as the "project root" since it has .caws/schemas via templates
    // We need a project root that actually has .caws/schemas/ — create a temp scenario
    const fs = require('fs-extra');
    const os = require('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-test-'));
    const schemasDir = path.join(tmpDir, '.caws', 'schemas');
    fs.mkdirpSync(schemasDir);
    fs.writeFileSync(path.join(schemasDir, 'test.schema.json'), '{}');

    const result = getSchemaPath('test.schema.json', tmpDir);
    expect(result).toBe(path.join(schemasDir, 'test.schema.json'));

    // Cleanup
    fs.removeSync(tmpDir);
  });
});
