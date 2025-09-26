/**
 * @fileoverview Tests for CAWS validation functionality
 * @author @darianrosebrook
 */

const yaml = require('js-yaml');

// Import the validation function (we'll need to expose it for testing)
const { generateWorkingSpec, validateGeneratedSpec } = require('../src/index.js');

describe('Working Spec Validation', () => {
  const mockAnswers = {
    projectId: 'TEST-001',
    projectTitle: 'Test Project',
    riskTier: 2,
    projectMode: 'feature',
    maxFiles: 25,
    maxLoc: 1000,
    blastModules: 'core,api',
    dataMigration: false,
    rollbackSlo: '5m',
    projectThreats: '- Test threat 1\n- Test threat 2',
    scopeIn: 'test files',
    scopeOut: 'other files',
    projectInvariants: '- Test invariant 1\n- Test invariant 2',
    acceptanceCriteria: 'GIVEN test condition WHEN test action THEN expected result',
    a11yRequirements: 'keyboard navigation',
    perfBudget: 250,
    securityRequirements: 'input validation',
    contractType: 'openapi',
    contractPath: 'test.yaml',
    observabilityLogs: 'test.log',
    observabilityMetrics: 'test_metric',
    observabilityTraces: 'test_trace',
    migrationPlan: '- Test migration',
    rollbackPlan: '- Test rollback',
  };

  test('should generate valid working spec', () => {
    const specContent = generateWorkingSpec(mockAnswers);
    expect(specContent).toContain('id: TEST-001');
    expect(specContent).toContain('title: "Test Project"');
    expect(specContent).toContain('risk_tier: 2');
    expect(specContent).toContain('mode: feature');
  });

  test('should parse acceptance criteria correctly', () => {
    const specContent = generateWorkingSpec(mockAnswers);
    const spec = yaml.load(specContent);

    expect(spec.acceptance).toBeInstanceOf(Array);
    expect(spec.acceptance.length).toBeGreaterThan(0);
    expect(spec.acceptance[0]).toHaveProperty('id');
    expect(spec.acceptance[0]).toHaveProperty('given');
    expect(spec.acceptance[0]).toHaveProperty('when');
    expect(spec.acceptance[0]).toHaveProperty('then');
  });

  test('should handle multi-line acceptance criteria', () => {
    const multiLineAnswers = {
      ...mockAnswers,
      acceptanceCriteria:
        'GIVEN user is authenticated WHEN accessing protected endpoint THEN access is granted\nGIVEN invalid credentials WHEN attempting login THEN access is denied',
    };

    const specContent = generateWorkingSpec(multiLineAnswers);
    const spec = yaml.load(specContent);

    expect(spec.acceptance).toHaveLength(2);
    expect(spec.acceptance[0].given).toContain('user is authenticated');
    expect(spec.acceptance[1].given).toContain('invalid credentials');
  });

  test('should handle threats and invariants as arrays', () => {
    const specContent = generateWorkingSpec(mockAnswers);
    const spec = yaml.load(specContent);

    expect(spec.threats).toBeInstanceOf(Array);
    expect(spec.invariants).toBeInstanceOf(Array);
    expect(spec.migrations).toBeInstanceOf(Array);
    expect(spec.rollback).toBeInstanceOf(Array);
  });

  test('should validate generated spec without errors', () => {
    const specContent = generateWorkingSpec(mockAnswers);

    // This should not throw an error
    expect(() => {
      validateGeneratedSpec(specContent, mockAnswers);
    }).not.toThrow();
  });

  test('should handle optional fields gracefully', () => {
    const minimalAnswers = {
      projectId: 'TEST-002',
      projectTitle: 'Minimal Test',
      riskTier: 3,
      projectMode: 'chore',
      maxFiles: 10,
      maxLoc: 500,
      blastModules: 'scripts',
      dataMigration: false,
      rollbackSlo: '1m',
      projectThreats: '- Minimal threat',
      scopeIn: 'scripts',
      scopeOut: 'other',
      projectInvariants: '- System works',
      acceptanceCriteria: 'GIVEN current state WHEN change applied THEN expected result',
      a11yRequirements: 'none',
      perfBudget: 100,
      securityRequirements: 'none',
      contractType: 'openapi',
      contractPath: 'none',
      observabilityLogs: 'none',
      observabilityMetrics: 'none',
      observabilityTraces: 'none',
      migrationPlan: '- No migration',
      rollbackPlan: '- No rollback',
    };

    const specContent = generateWorkingSpec(minimalAnswers);
    expect(() => {
      validateGeneratedSpec(specContent, minimalAnswers);
    }).not.toThrow();
  });
});
