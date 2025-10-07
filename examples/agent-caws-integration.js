#!/usr/bin/env node

/**
 * CAWS Agent Integration Example
 *
 * This script demonstrates how agents can use CAWS as a quality bar for iterative development.
 * It shows the key integration points without CLI parsing complexities.
 *
 * Usage: node examples/agent-caws-integration.js
 */

const fs = require('fs');
const path = require('path');

class AgentCawsIntegration {
  constructor() {
    this.workingSpecPath = '.caws/working-spec.yaml';
    this.spec = null;
  }

  async initialize() {
    // Load working spec
    if (!fs.existsSync(this.workingSpecPath)) {
      console.error(`❌ Working spec not found: ${this.workingSpecPath}`);
      console.log('💡 Create a working spec first: caws init .');
      return false;
    }

    const yaml = require('js-yaml');
    const specContent = fs.readFileSync(this.workingSpecPath, 'utf8');
    this.spec = yaml.load(specContent);

    console.log(`📋 Loaded working spec: ${this.spec.title}`);
    console.log(`🏷️  Mode: ${this.spec.mode}, Tier: ${this.spec.risk_tier}`);
    console.log(`📝 Acceptance criteria: ${this.spec.acceptance?.length || 0}`);
    console.log(`🔗 Contracts: ${this.spec.contracts?.length || 0}\n`);

    return true;
  }

  /**
   * Example 1: Pre-implementation validation
   */
  async demonstratePreImplementationValidation() {
    console.log('🧪 Example 1: Pre-implementation validation\n');

    // In a real agent, this would be called before starting work
    const isSpecValid = this.validateWorkingSpec();

    if (isSpecValid) {
      console.log('✅ Working spec is valid and ready for implementation');
      console.log('🎯 Agent can proceed with development');
      console.log('📋 Recommended first steps:');
      console.log('   1. Set up development environment');
      console.log('   2. Create basic project structure');
      console.log('   3. Implement core functionality skeleton');
    } else {
      console.log('❌ Working spec needs improvement before starting');
      console.log('💡 Agent should request spec clarification');
    }

    console.log('\n' + '─'.repeat(60) + '\n');
  }

  /**
   * Example 2: Iterative quality evaluation
   */
  async demonstrateIterativeEvaluation() {
    console.log('🧪 Example 2: Iterative quality evaluation\n');

    // Simulate different stages of development
    const developmentStages = [
      {
        name: 'Initial Setup',
        description: 'Basic project structure created',
        expectedScore: 0.3,
        expectedStatus: 'early_implementation',
      },
      {
        name: 'Core Implementation',
        description: 'Main functionality implemented with basic error handling',
        expectedScore: 0.6,
        expectedStatus: 'core_implementation',
      },
      {
        name: 'Quality Implementation',
        description: 'Added tests, contracts, and comprehensive error handling',
        expectedScore: 0.85,
        expectedStatus: 'quality_implementation',
      },
    ];

    for (const stage of developmentStages) {
      console.log(`📈 Stage: ${stage.name}`);
      console.log(`📝 State: ${stage.description}`);

      // Simulate CAWS evaluation
      const evaluation = await this.simulateCawsEvaluation(stage);

      console.log(`🎯 Quality Score: ${(evaluation.quality_score * 100).toFixed(1)}%`);
      console.log(`📊 Status: ${evaluation.overall_passed ? 'PASSED' : 'NEEDS_IMPROVEMENT'}`);

      if (evaluation.criteria && evaluation.criteria.length > 0) {
        console.log('📋 Key criteria:');
        evaluation.criteria.slice(0, 3).forEach((criterion) => {
          const icon = criterion.status === 'passed' ? '✅' : '❌';
          console.log(`   ${icon} ${criterion.name}: ${criterion.feedback}`);
        });
      }

      if (evaluation.next_actions && evaluation.next_actions.length > 0) {
        console.log('💡 Next steps:');
        evaluation.next_actions.slice(0, 2).forEach((action) => {
          console.log(`   • ${action}`);
        });
      }

      console.log('');
    }

    console.log('─'.repeat(60) + '\n');
  }

  /**
   * Example 3: Risk-aware development
   */
  async demonstrateRiskAwareDevelopment() {
    console.log('🧪 Example 3: Risk-aware development guidance\n');

    const riskLevels = [
      { tier: 1, name: 'High Risk', focus: 'Security & Reliability' },
      { tier: 2, name: 'Medium Risk', focus: 'Contracts & Testing' },
      { tier: 3, name: 'Low Risk', focus: 'Basic Quality' },
    ];

    for (const risk of riskLevels) {
      console.log(`🎯 ${risk.name} Feature (Tier ${risk.tier})`);
      console.log(`🎯 Focus: ${risk.focus}`);

      const guidance = this.generateRiskGuidance(risk.tier);

      console.log('🛡️  Risk mitigation steps:');
      guidance.mitigation.forEach((step) => {
        console.log(`   • ${step}`);
      });

      console.log('📊 Quality thresholds:');
      console.log(`   • Coverage: ${guidance.thresholds.coverage * 100}%`);
      console.log(`   • Mutation: ${guidance.thresholds.mutation * 100}%`);
      console.log(`   • Contracts: ${guidance.thresholds.contracts ? 'Required' : 'Optional'}`);

      console.log('');
    }

    console.log('─'.repeat(60) + '\n');
  }

  /**
   * Example 4: Agent decision making
   */
  async demonstrateAgentDecisionMaking() {
    console.log('🧪 Example 4: Agent decision making with CAWS feedback\n');

    const scenarios = [
      {
        name: 'Quality standards met',
        evaluation: { overall_passed: true, quality_score: 0.92 },
        decision: 'Mark complete and move to next task',
      },
      {
        name: 'Minor quality issues',
        evaluation: { overall_passed: false, quality_score: 0.78 },
        decision: 'Fix specific failing criteria, then re-evaluate',
      },
      {
        name: 'Major quality gaps',
        evaluation: { overall_passed: false, quality_score: 0.45 },
        decision: 'Request human review or break into smaller tasks',
      },
    ];

    for (const scenario of scenarios) {
      console.log(`📊 Scenario: ${scenario.name}`);
      console.log(`🎯 Quality Score: ${(scenario.evaluation.quality_score * 100).toFixed(1)}%`);
      console.log(`🤖 Agent Decision: ${scenario.decision}`);

      if (scenario.evaluation.overall_passed) {
        console.log('✅ Ready for integration');
      } else {
        console.log('🔄 Continue iterative improvement');
      }

      console.log('');
    }

    console.log('─'.repeat(60) + '\n');
  }

  /**
   * Helper: Validate working spec
   */
  validateWorkingSpec() {
    if (!this.spec) return false;

    // Basic validation checks
    const requiredFields = [
      'id',
      'title',
      'risk_tier',
      'mode',
      'change_budget',
      'scope',
      'invariants',
      'acceptance',
    ];
    const hasRequiredFields = requiredFields.every((field) => this.spec[field]);

    const hasValidAcceptance =
      this.spec.acceptance &&
      this.spec.acceptance.length > 0 &&
      this.spec.acceptance.every((a) => a.id && a.given && a.when && a.then);

    return hasRequiredFields && hasValidAcceptance;
  }

  /**
   * Helper: Simulate CAWS evaluation
   */
  async simulateCawsEvaluation(stage) {
    // Simulate different evaluation results based on development stage
    const baseScore = stage.expectedScore;
    const variation = (Math.random() - 0.5) * 0.1; // ±5% variation
    const finalScore = Math.max(0, Math.min(1, baseScore + variation));

    return {
      overall_passed: finalScore >= 0.75,
      quality_score: finalScore,
      criteria: [
        {
          id: 'spec_completeness',
          name: 'Specification Completeness',
          status: 'passed',
          score: 1.0,
          feedback: 'Spec validation passed',
        },
        {
          id: 'implementation_quality',
          name: 'Implementation Quality',
          status: finalScore >= 0.8 ? 'passed' : 'failed',
          score: finalScore,
          feedback: `Quality score: ${(finalScore * 100).toFixed(1)}%`,
        },
        {
          id: 'testing_coverage',
          name: 'Testing Coverage',
          status: finalScore >= 0.7 ? 'passed' : 'failed',
          score: Math.max(0, finalScore - 0.1),
          feedback: 'Test coverage requirements met',
        },
      ],
      next_actions:
        finalScore >= 0.75
          ? []
          : [
              'Improve test coverage',
              'Add error handling',
              'Review code against acceptance criteria',
            ],
    };
  }

  /**
   * Helper: Generate risk-based guidance
   */
  generateRiskGuidance(tier) {
    const thresholds = {
      1: { coverage: 0.9, mutation: 0.7, contracts: true },
      2: { coverage: 0.8, mutation: 0.5, contracts: true },
      3: { coverage: 0.7, mutation: 0.3, contracts: false },
    };

    const mitigation = {
      1: [
        'Implement comprehensive security measures',
        'Add extensive error handling and logging',
        'Create rollback and recovery plans',
        'Consider feature flags for safe deployment',
      ],
      2: [
        'Ensure contract testing is in place',
        'Add integration tests',
        'Implement proper error boundaries',
        'Add monitoring and alerting',
      ],
      3: [
        'Add basic unit tests',
        'Implement input validation',
        'Add basic error handling',
        'Ensure code follows team standards',
      ],
    };

    return {
      thresholds: thresholds[tier],
      mitigation: mitigation[tier],
    };
  }

  /**
   * Run all demonstrations
   */
  async runAllDemonstrations() {
    console.log('🤖 CAWS Agent Integration Demonstrations\n');
    console.log('This shows how agents can use CAWS as quality bars for iterative development.\n');

    const initialized = await this.initialize();
    if (!initialized) return;

    await this.demonstratePreImplementationValidation();
    await this.demonstrateIterativeEvaluation();
    await this.demonstrateRiskAwareDevelopment();
    await this.demonstrateAgentDecisionMaking();

    console.log('🎉 Demonstrations complete!');
    console.log('\n📚 Key Takeaways:');
    console.log('• CAWS provides structured quality evaluation for agents');
    console.log('• Risk-tiered standards ensure appropriate quality levels');
    console.log('• Iterative guidance helps agents improve systematically');
    console.log('• Clear decision points prevent over-optimization');
    console.log('\n🔗 See docs/agent-integration-guide.md for full integration details');
  }
}

// CLI usage
async function main() {
  const demo = new AgentCawsIntegration();

  try {
    await demo.runAllDemonstrations();
  } catch (error) {
    console.error('💥 Demo failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('💥 Unexpected error:', error);
    process.exit(1);
  });
}

module.exports = AgentCawsIntegration;
