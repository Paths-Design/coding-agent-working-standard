// Mock for inquirer to avoid ES module issues in Jest
module.exports = {
  prompt: jest.fn(() =>
    Promise.resolve({
      projectId: 'TEST-001',
      projectTitle: 'Test Project',
      riskTier: 2,
      projectMode: 'feature',
      maxFiles: 25,
      maxLoc: 1000,
      blastModules: 'core,ui',
      dataMigration: false,
      rollbackSlo: '5m',
      projectThreats: 'Test threats',
      scopeIn: 'test scope',
      scopeOut: 'excluded scope',
      projectInvariants: 'test invariants',
      acceptanceCriteria: 'GIVEN test WHEN action THEN result',
      a11yRequirements: 'keyboard,contrast',
      perfBudget: 250,
      securityRequirements: 'validation,auth',
      contractType: 'openapi',
      contractPath: 'apps/contracts/api.yaml',
      observabilityLogs: 'auth.success,api.request',
      observabilityMetrics: 'requests_total',
      observabilityTraces: 'api_flow',
      migrationPlan: 'deploy feature',
      rollbackPlan: 'revert deployment',
    })
  ),
};
