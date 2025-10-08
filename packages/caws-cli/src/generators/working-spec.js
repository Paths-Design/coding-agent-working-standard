/**
 * @fileoverview Working Spec Generation Utilities
 * Functions for generating and validating CAWS working specifications
 * @author @darianrosebrook
 */

const yaml = require('js-yaml');
const chalk = require('chalk');

// Import validation utilities
const { validateWorkingSpec } = require('../validation/spec-validation');

/**
 * Generate working spec YAML with user input
 * @param {Object} answers - User responses
 * @returns {string} - Generated YAML content
 */
function generateWorkingSpec(answers) {
  const template = {
    id: answers.projectId || 'PROJ-001',
    title: answers.projectTitle || 'New CAWS Project',
    risk_tier: answers.riskTier || 2,
    mode: answers.projectMode || 'feature',
    change_budget: {
      max_files: answers.maxFiles || 25,
      max_loc: answers.maxLoc || 1000,
    },
    blast_radius: {
      modules: (answers.blastModules || 'src, tests')
        .split(',')
        .map((m) => m.trim())
        .filter((m) => m),
      data_migration: answers.dataMigration ?? false,
    },
    operational_rollback_slo: answers.rollbackSlo || '5m',
    threats: (answers.projectThreats || '')
      .split('\n')
      .map((t) => t.trim())
      .filter((t) => t && !t.startsWith('-') === false), // Allow lines starting with -
    scope: {
      in: (answers.scopeIn || 'src/, tests/')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s),
      out: (answers.scopeOut || 'node_modules/, dist/')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s),
    },
    invariants: (answers.projectInvariants || 'System maintains data consistency')
      .split('\n')
      .map((i) => i.trim())
      .filter((i) => i),
    acceptance: (answers.acceptanceCriteria || 'Given current state, when action occurs, then expected result')
      .split('\n')
      .filter((a) => a.trim())
      .map((criteria, index) => {
        const id = `A${index + 1}`;
        const upperCriteria = criteria.toUpperCase();

        // Try different variations of the format
        let given = '';
        let when = '';
        let then = '';

        if (
          upperCriteria.includes('GIVEN') &&
          upperCriteria.includes('WHEN') &&
          upperCriteria.includes('THEN')
        ) {
          given = criteria.split(/WHEN/i)[0]?.replace(/GIVEN/i, '').trim() || '';
          const whenThen = criteria.split(/WHEN/i)[1];
          when = whenThen?.split(/THEN/i)[0]?.trim() || '';
          then = whenThen?.split(/THEN/i)[1]?.trim() || '';
        } else {
          // Fallback: just split by lines and create simple criteria
          given = 'Current system state';
          when = criteria.replace(/^(GIVEN|WHEN|THEN)/i, '').trim();
          then = 'Expected behavior occurs';
        }

        return {
          id,
          given: given || 'Current system state',
          when: when || criteria,
          then: then || 'Expected behavior occurs',
        };
      }),
    non_functional: {
      a11y: (answers.a11yRequirements || 'keyboard')
        .split(',')
        .map((a) => a.trim())
        .filter((a) => a),
      perf: { api_p95_ms: answers.perfBudget || 250 },
      security: (answers.securityRequirements || 'validation')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s),
    },
    contracts: [
      {
        type: answers.contractType || '',
        path: answers.contractPath || '',
      },
    ],
    observability: {
      logs: (answers.observabilityLogs || '')
        .split(',')
        .map((l) => l.trim())
        .filter((l) => l),
      metrics: (answers.observabilityMetrics || '')
        .split(',')
        .map((m) => m.trim())
        .filter((m) => m),
      traces: (answers.observabilityTraces || '')
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t),
    },
    migrations: (answers.migrationPlan || '')
      .split('\n')
      .map((m) => m.trim())
      .filter((m) => m),
    rollback: (answers.rollbackPlan || '')
      .split('\n')
      .map((r) => r.trim())
      .filter((r) => r),
    human_override: answers.needsOverride
      ? {
          enabled: true,
          approver: answers.overrideApprover,
          rationale: answers.overrideRationale,
          waived_gates: answers.waivedGates,
          approved_at: new Date().toISOString(),
          expires_at: new Date(
            Date.now() + answers.overrideExpiresDays * 24 * 60 * 60 * 1000
          ).toISOString(),
        }
      : undefined,
    experimental_mode: answers.isExperimental
      ? {
          enabled: true,
          rationale: answers.experimentalRationale,
          expires_at: new Date(
            Date.now() + answers.experimentalExpiresDays * 24 * 60 * 60 * 1000
          ).toISOString(),
          sandbox_location: answers.experimentalSandbox,
        }
      : undefined,
    ai_assessment: {
      confidence_level: answers.aiConfidence || 0.8,
      uncertainty_areas: (answers.uncertaintyAreas || '')
        .split(',')
        .map((a) => a.trim())
        .filter((a) => a),
      complexity_factors: (answers.complexityFactors || '')
        .split(',')
        .map((f) => f.trim())
        .filter((f) => f),
      risk_factors: [], // Could be populated by AI analysis
    },
  };

  return yaml.dump(template, { indent: 2 });
}

/**
 * Validate generated working spec against JSON schema
 * @param {string} specContent - YAML spec content
 * @param {Object} answers - User responses for error context
 */
function validateGeneratedSpec(specContent, _answers) {
  try {
    const spec = yaml.load(specContent);

    const isValid = validateWorkingSpec(spec);

    if (!isValid) {
      console.error(chalk.red('❌ Generated working spec failed validation:'));
      validateWorkingSpec.errors.forEach((error) => {
        console.error(`   - ${error.instancePath || 'root'}: ${error.message}`);
      });

      // Provide helpful guidance
      console.log(chalk.blue('\n💡 Validation Tips:'));
      console.log('   - Ensure risk_tier is 1, 2, or 3');
      console.log('   - Check that scope.in is not empty');
      console.log('   - Verify invariants and acceptance criteria are provided');
      console.log('   - For tier 1 and 2, ensure contracts are specified');

      process.exit(1);
    }

    console.log(chalk.green('✅ Generated working spec passed validation'));
  } catch (error) {
    console.error(chalk.red('❌ Error validating working spec:'), error.message);
    process.exit(1);
  }
}

module.exports = {
  generateWorkingSpec,
  validateGeneratedSpec,
};
