#!/usr/bin/env node

/**
 * CAWS Agent Workflow Demo
 *
 * This script demonstrates how agents can integrate CAWS into their development workflow.
 * It shows a complete iterative development loop using CAWS quality evaluation.
 *
 * Usage: node examples/agent-workflow-demo.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class CawsGuidedAgent {
  constructor(workingSpecPath = '.caws/working-spec.yaml') {
    this.workingSpecPath = workingSpecPath;
    this.maxIterations = 5;
    this.iterationCount = 0;
  }

  /**
   * Run the complete CAWS-guided development workflow
   */
  async runDevelopmentWorkflow() {
    console.log('🤖 Starting CAWS-guided agent development workflow...\n');

    // Step 1: Initial spec validation
    console.log('📋 Step 1: Validating working specification...');
    const specValidation = await this.evaluateSpec('--feedback-only');

    if (!specValidation.success) {
      console.error('❌ Working spec validation failed:', specValidation.evaluation?.message);
      return false;
    }

    console.log('✅ Working spec is valid and ready for implementation\n');

    // Step 2: Iterative development loop
    console.log('🔄 Step 2: Starting iterative development loop...\n');

    let currentState = 'Initial implementation started';
    let workflowComplete = false;

    while (this.iterationCount < this.maxIterations && !workflowComplete) {
      this.iterationCount++;
      console.log(`📈 Iteration ${this.iterationCount}/${this.maxIterations}`);
      console.log(`📝 Current state: ${currentState}\n`);

      // Get iterative guidance
      console.log('🎯 Getting CAWS guidance for next steps...');
      const guidance = await this.getIterativeGuidance(currentState);

      if (guidance.success) {
        console.log(`💡 Guidance: ${guidance.iteration.guidance}`);
        console.log('📋 Recommended next steps:');
        guidance.iteration.next_steps.forEach((step, i) => {
          console.log(`   ${i + 1}. ${step}`);
        });
        console.log('');
      }

      // Simulate implementation of recommended steps
      console.log('⚙️  Implementing recommended steps...');
      await this.simulateImplementation(guidance.iteration.next_steps);
      console.log('✅ Implementation step completed\n');

      // Evaluate progress
      console.log('📊 Evaluating progress against CAWS quality standards...');
      const evaluation = await this.evaluateSpec();

      if (evaluation.success) {
        const status = evaluation.evaluation.overall_status;
        const score = evaluation.evaluation.quality_score;
        const criteriaPassed = evaluation.evaluation.criteria.filter(
          (c) => c.status === 'passed'
        ).length;
        const totalCriteria = evaluation.evaluation.criteria.length;

        console.log(`📈 Evaluation Result: ${status.replace('_', ' ').toUpperCase()}`);
        console.log(`🎯 Quality Score: ${(score * 100).toFixed(1)}%`);
        console.log(`✅ Criteria Passed: ${criteriaPassed}/${totalCriteria}`);

        if (evaluation.evaluation.next_actions && evaluation.evaluation.next_actions.length > 0) {
          console.log('📋 Next actions:');
          evaluation.evaluation.next_actions.forEach((action) => {
            console.log(`   • ${action}`);
          });
        }

        // Check if quality standards are met
        if (status === 'quality_passed') {
          console.log('\n🎉 SUCCESS: Quality standards met! Implementation complete.');
          workflowComplete = true;
        } else {
          console.log('\n🔄 Quality standards not yet met. Continuing iteration...\n');
          currentState = `Iteration ${this.iterationCount}: ${guidance.iteration.next_steps.slice(0, 2).join(', ')}`;
        }
      } else {
        console.log('❌ Evaluation failed:', evaluation.evaluation?.message);
        currentState = `Iteration ${this.iterationCount}: Addressed evaluation issues`;
      }

      console.log('─'.repeat(60));
    }

    if (!workflowComplete) {
      console.log(
        `⚠️  Reached maximum iterations (${this.maxIterations}) without meeting quality standards.`
      );
      console.log('💡 Consider:');
      console.log('   • Reviewing working spec requirements');
      console.log('   • Breaking the feature into smaller parts');
      console.log('   • Adjusting risk tier if appropriate');
    }

    return workflowComplete;
  }

  /**
   * Evaluate working spec against CAWS standards
   */
  async evaluateSpec(extraArgs = '') {
    try {
      const command = `node packages/caws-cli/dist/index.js agent evaluate ${extraArgs} ${this.workingSpecPath}`;
      const result = execSync(command, { encoding: 'utf8' });

      // Extract JSON from output (skip human-readable messages)
      const lines = result.trim().split('\n');
      const jsonStart = lines.findIndex((line) => line.trim().startsWith('{'));
      if (jsonStart >= 0) {
        const jsonOutput = lines.slice(jsonStart).join('\n');
        return JSON.parse(jsonOutput);
      }

      // If no JSON found, try parsing the whole output
      return JSON.parse(result.trim());
    } catch (error) {
      // Try to parse error output as JSON
      try {
        const errorOutput = error.stdout || error.stderr || '';
        const lines = errorOutput.trim().split('\n');
        const jsonStart = lines.findIndex((line) => line.trim().startsWith('{'));
        if (jsonStart >= 0) {
          const jsonOutput = lines.slice(jsonStart).join('\n');
          return JSON.parse(jsonOutput);
        }
        return JSON.parse(errorOutput);
      } catch (parseError) {
        return {
          success: false,
          evaluation: {
            overall_status: 'error',
            message: error.message || 'Command execution failed',
          },
        };
      }
    }
  }

  /**
   * Get iterative development guidance
   */
  async getIterativeGuidance(currentState) {
    try {
      const command = `node packages/caws-cli/dist/index.js agent iterate --current-state '${JSON.stringify({ description: currentState })}' ${this.workingSpecPath}`;
      const result = execSync(command, { encoding: 'utf8' });

      // Extract JSON from output (skip human-readable messages)
      const lines = result.trim().split('\n');
      const jsonStart = lines.findIndex((line) => line.trim().startsWith('{'));
      if (jsonStart >= 0) {
        const jsonOutput = lines.slice(jsonStart).join('\n');
        return JSON.parse(jsonOutput);
      }

      return JSON.parse(result.trim());
    } catch (error) {
      // Try to parse error output
      try {
        const errorOutput = error.stdout || error.stderr || '';
        const lines = errorOutput.trim().split('\n');
        const jsonStart = lines.findIndex((line) => line.trim().startsWith('{'));
        if (jsonStart >= 0) {
          const jsonOutput = lines.slice(jsonStart).join('\n');
          return JSON.parse(jsonOutput);
        }
      } catch (parseError) {
        // Ignore parse error
      }

      return {
        success: false,
        iteration: {
          guidance: 'Failed to get guidance',
          next_steps: ['Retry CAWS guidance command'],
          confidence: 0,
        },
      };
    }
  }

  /**
   * Simulate implementation of recommended steps
   */
  async simulateImplementation(steps) {
    // Simulate some development work
    await new Promise((resolve) => setTimeout(resolve, 1000));

    console.log(`   ✓ Completed: ${steps[0] || 'Development step'}`);

    if (steps.length > 1) {
      console.log(`   ✓ Completed: ${steps[1] || 'Additional development work'}`);
    }

    // Simulate creating some files/tests as development progresses
    if (this.iterationCount === 1) {
      console.log('   📁 Created initial project structure');
    } else if (this.iterationCount === 2) {
      console.log('   🧪 Added unit tests');
    } else if (this.iterationCount === 3) {
      console.log('   🔗 Added integration tests');
    }
  }
}

// CLI usage
async function main() {
  const workingSpecPath = process.argv[2] || '.caws/working-spec.yaml';

  if (!fs.existsSync(workingSpecPath)) {
    console.error(`❌ Working spec not found: ${workingSpecPath}`);
    console.error('💡 Create a working spec first: caws init .');
    process.exit(1);
  }

  const agent = new CawsGuidedAgent(workingSpecPath);

  try {
    const success = await agent.runDevelopmentWorkflow();

    if (success) {
      console.log('\n🎊 Agent workflow completed successfully!');
      console.log('📊 Summary:');
      console.log(`   • Iterations: ${agent.iterationCount}`);
      console.log('   • Quality standards: ✅ Met');
      console.log('   • CAWS integration: ✅ Working');
    } else {
      console.log('\n⚠️  Agent workflow completed with issues.');
      console.log('💡 Review CAWS evaluation feedback and adjust approach.');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Agent workflow failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('💥 Unexpected error:', error);
    process.exit(1);
  });
}

module.exports = CawsGuidedAgent;
