/**
 * @fileoverview Tests for the caws init command (non-interactive path)
 *
 * These tests exercise initProject() with --non-interactive defaults,
 * verifying the directory structure, generated files, and idempotency.
 *
 * Uses the shared git-fixture pattern for temp dir setup/cleanup.
 */

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const { createTemplateRepo, cloneFixture, cleanupTestDir, cleanupTemplate } = require('./helpers/git-fixture');
const { initProject } = require('../src/commands/init');

let templateDir;
let testDir;
let originalCwd;

beforeAll(() => {
  templateDir = createTemplateRepo();
});

afterAll(() => {
  cleanupTemplate(templateDir);
});

beforeEach(() => {
  testDir = cloneFixture(templateDir);
  originalCwd = process.cwd();
  process.chdir(testDir);

  // Suppress console output during tests
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});

  // Mock process.exit to prevent test runner from exiting
  jest.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
});

afterEach(() => {
  process.chdir(originalCwd);
  cleanupTestDir(testDir);
  jest.restoreAllMocks();
});

describe('caws init --non-interactive', () => {
  test('creates expected .caws directory structure', async () => {
    await initProject('.', { nonInteractive: true, ide: 'none' });

    expect(fs.existsSync(path.join(testDir, '.caws'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, '.caws', 'working-spec.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, '.caws', 'specs'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, '.caws', 'specs', 'registry.json'))).toBe(true);
  });

  test('creates a policy.yaml file', async () => {
    await initProject('.', { nonInteractive: true, ide: 'none' });

    const policyPath = path.join(testDir, '.caws', 'policy.yaml');
    expect(fs.existsSync(policyPath)).toBe(true);

    const policyContent = fs.readFileSync(policyPath, 'utf8');
    const policy = yaml.load(policyContent);
    expect(policy).toBeDefined();
  });

  test('updates .gitignore with CAWS state entry', async () => {
    await initProject('.', { nonInteractive: true, ide: 'none' });

    const gitignorePath = path.join(testDir, '.gitignore');
    expect(fs.existsSync(gitignorePath)).toBe(true);

    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
    expect(gitignoreContent).toContain('.caws/state/');
  });

  test('spec registry has valid structure with version and specs fields', async () => {
    await initProject('.', { nonInteractive: true, ide: 'none' });

    const registryPath = path.join(testDir, '.caws', 'specs', 'registry.json');
    const registry = fs.readJsonSync(registryPath);

    expect(registry).toHaveProperty('version', '1.0.0');
    expect(registry).toHaveProperty('specs');
    expect(typeof registry.specs).toBe('object');
    expect(registry).toHaveProperty('lastUpdated');

    // At least one spec entry should exist
    const specIds = Object.keys(registry.specs);
    expect(specIds.length).toBeGreaterThanOrEqual(1);

    // Each spec entry should have required metadata
    const firstSpec = registry.specs[specIds[0]];
    expect(firstSpec).toHaveProperty('path');
    expect(firstSpec).toHaveProperty('type', 'feature');
    expect(firstSpec).toHaveProperty('status', 'active');
  });

  test('working-spec.yaml has required fields', async () => {
    await initProject('.', { nonInteractive: true, ide: 'none' });

    const specPath = path.join(testDir, '.caws', 'working-spec.yaml');
    const specContent = fs.readFileSync(specPath, 'utf8');
    const spec = yaml.load(specContent);

    expect(spec).toHaveProperty('id');
    expect(spec).toHaveProperty('title');
    expect(spec).toHaveProperty('risk_tier');
    expect(spec).toHaveProperty('mode');
    expect(spec).toHaveProperty('scope');
    expect(spec.scope).toHaveProperty('in');
    expect(spec.scope).toHaveProperty('out');
  });

  test('non-interactive defaults produce sensible values', async () => {
    await initProject('.', { nonInteractive: true, ide: 'none' });

    const specPath = path.join(testDir, '.caws', 'working-spec.yaml');
    const spec = yaml.load(fs.readFileSync(specPath, 'utf8'));

    // Default risk tier is 2, but buildInitialFeatureSpec normalizes it
    expect(spec.risk_tier).toBeLessThanOrEqual(3);
    expect(spec.risk_tier).toBeGreaterThanOrEqual(1);

    // Mode should be a recognized value
    expect(['feature', 'development', 'chore', 'bugfix']).toContain(spec.mode);

    // Scope arrays should not be empty
    expect(spec.scope.in.length).toBeGreaterThan(0);
    expect(spec.scope.out.length).toBeGreaterThan(0);
  });

  test('feature spec YAML file is created alongside working-spec', async () => {
    await initProject('.', { nonInteractive: true, ide: 'none' });

    // The registry tells us which feature spec files exist
    const registry = fs.readJsonSync(path.join(testDir, '.caws', 'specs', 'registry.json'));
    const specIds = Object.keys(registry.specs);
    expect(specIds.length).toBeGreaterThanOrEqual(1);

    // The feature spec file referenced in the registry should exist
    const specEntry = registry.specs[specIds[0]];
    const featureSpecPath = path.join(testDir, '.caws', 'specs', specEntry.path);
    expect(fs.existsSync(featureSpecPath)).toBe(true);

    // Its content should match working-spec.yaml
    const featureSpec = yaml.load(fs.readFileSync(featureSpecPath, 'utf8'));
    const workingSpec = yaml.load(
      fs.readFileSync(path.join(testDir, '.caws', 'working-spec.yaml'), 'utf8')
    );
    expect(featureSpec.id).toBe(workingSpec.id);
    expect(featureSpec.title).toBe(workingSpec.title);
  });

  test('init is idempotent — running twice does not crash or corrupt files', async () => {
    await initProject('.', { nonInteractive: true, ide: 'none' });

    // Capture state after first init
    const specAfterFirst = fs.readFileSync(
      path.join(testDir, '.caws', 'working-spec.yaml'),
      'utf8'
    );
    const registryAfterFirst = fs.readJsonSync(
      path.join(testDir, '.caws', 'specs', 'registry.json')
    );

    // Second init should not throw
    await expect(
      initProject('.', { nonInteractive: true, ide: 'none' })
    ).resolves.not.toThrow();

    // Core files should still exist and be valid
    const specAfterSecond = path.join(testDir, '.caws', 'working-spec.yaml');
    expect(fs.existsSync(specAfterSecond)).toBe(true);

    const registryAfterSecond = fs.readJsonSync(
      path.join(testDir, '.caws', 'specs', 'registry.json')
    );
    expect(registryAfterSecond).toHaveProperty('version', '1.0.0');
    expect(registryAfterSecond).toHaveProperty('specs');
  });
});
