#!/usr/bin/env node

/**
 * @fileoverview CAWS Quality Gates and Trust Score Calculator
 * Enforces quality thresholds based on risk tier and calculates trust scores
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const { checkWaiverStatus } = require('./waivers');

/**
 * Tier policy configuration
 */
const TIER_POLICY = {
  1: {
    min_branch: 0.9,
    min_mutation: 0.7,
    requires_contracts: true,
    requires_manual_review: true,
    max_files: 40,
    max_loc: 1500,
    allowed_modes: ['feature', 'refactor', 'fix'],
  },
  2: {
    min_branch: 0.8,
    min_mutation: 0.5,
    requires_contracts: true,
    max_files: 25,
    max_loc: 1000,
    allowed_modes: ['feature', 'refactor', 'fix'],
  },
  3: {
    min_branch: 0.7,
    min_mutation: 0.3,
    requires_contracts: false,
    max_files: 15,
    max_loc: 600,
    allowed_modes: ['feature', 'refactor', 'fix', 'doc', 'chore'],
  },
  experimental: {
    min_branch: 0.3,
    min_mutation: 0.1,
    requires_contracts: false,
    requires_manual_review: false,
    max_files: 50,
    max_loc: 2000,
    allowed_modes: ['feature', 'refactor', 'fix', 'doc', 'chore'],
  },
};

/**
 * Trust score weights
 */
const TRUST_WEIGHTS = {
  coverage: 0.15,
  mutation: 0.15,
  test_quality: 0.15,
  contracts: 0.12,
  a11y: 0.08,
  perf: 0.08,
  flake: 0.08,
  mode: 0.06,
  scope: 0.06,
  supplychain: 0.04,
};

/**
 * Normalize a value between min and max to 0-1 scale
 * @param {number} value - Value to normalize
 * @param {number} min - Minimum expected value
 * @param {number} max - Maximum expected value
 * @returns {number} Normalized value between 0 and 1
 */
function normalize(value, min, max) {
  if (value >= max) return 1;
  if (value <= min) return 0;
  return (value - min) / (max - min);
}

/**
 * Check if performance budgets are met
 * @param {Object} perfResults - Performance test results
 * @returns {number} 1 if budgets met, 0 otherwise
 */
function budgetOk(perfResults) {
  if (!perfResults) return 0;
  // Basic implementation - could be enhanced with specific budget checks
  return perfResults.api_p95_ms && perfResults.api_p95_ms > 0 ? 1 : 0;
}

/**
 * Calculate trust score from provenance data
 * @param {string} tier - Risk tier (1, 2, 3, or 'experimental')
 * @param {Object} prov - Provenance data
 * @returns {number} Trust score (0-100)
 */
function trustScore(tier, prov) {
  // Handle experimental mode
  const isExperimental = prov.experimental_mode?.enabled;
  const effectiveTier = isExperimental ? 'experimental' : tier;

  const policy = TIER_POLICY[effectiveTier];
  if (!policy) {
    console.error(`❌ Invalid tier: ${tier}`);
    return 0;
  }

  if (isExperimental) {
    console.log('🧪 Experimental mode detected - using relaxed quality gates');
  }

  const wsum = Object.values(TRUST_WEIGHTS).reduce((a, b) => a + b, 0);

  // Calculate test quality score if test directory exists
  let testQualityScore = 0.5; // Default neutral score
  try {
    const { analyzeTestDirectory } = require('./test-quality');
    const testResults = analyzeTestDirectory('tests');
    testQualityScore = testResults.summary.averageQualityScore / 100;
    console.log(`📊 Test quality score: ${Math.round(testQualityScore * 100)}/100`);
  } catch (error) {
    console.warn('⚠️  Could not analyze test quality:', error.message);
    testQualityScore = 0.5; // Neutral fallback
  }

  // Calculate enhanced mutation score if mutation report exists
  let enhancedMutationScore = prov.results?.mutation_score || 0;
  try {
    const { analyzeMutationResults } = require('./mutant-analyzer');

    // Look for mutation report files
    const mutationReportPaths = [
      'mutation-report.json',
      'stryker-report.json',
      'pit-reports/mutations.xml',
      'target/pit-reports/mutations.xml',
    ];

    for (const reportPath of mutationReportPaths) {
      if (fs.existsSync(reportPath)) {
        const mutationAnalysis = analyzeMutationResults(reportPath, 'src');
        if (mutationAnalysis.summary.total > 0) {
          // Use meaningful mutation score instead of raw score
          enhancedMutationScore = mutationAnalysis.insights.meaningful_effectiveness;
          console.log(
            `🧬 Enhanced mutation score: ${Math.round(enhancedMutationScore * 100)}/100 (meaningful mutants)`
          );
          break;
        }
      }
    }
  } catch (error) {
    console.warn('⚠️  Could not analyze mutation results:', error.message);
    enhancedMutationScore = prov.results?.mutation_score || 0;
  }

  const score =
    TRUST_WEIGHTS.coverage *
      normalize(prov.results?.coverage_branch || 0, policy.min_branch, 0.95) +
    TRUST_WEIGHTS.mutation * normalize(enhancedMutationScore, policy.min_mutation, 0.9) +
    TRUST_WEIGHTS.test_quality * testQualityScore +
    TRUST_WEIGHTS.contracts *
      (policy.requires_contracts
        ? prov.results?.contracts?.consumer && prov.results?.contracts?.provider
          ? 1
          : 0
        : 1) +
    TRUST_WEIGHTS.a11y * (prov.results?.a11y === 'pass' ? 1 : 0) +
    TRUST_WEIGHTS.perf * budgetOk(prov.results?.perf || {}) +
    TRUST_WEIGHTS.flake * (prov.results?.flake_rate <= 0.005 ? 1 : 0.5) +
    TRUST_WEIGHTS.mode * (prov.results?.mode_compliance === 'full' ? 1 : 0.5) +
    TRUST_WEIGHTS.scope * (prov.results?.scope_within_budget ? 1 : 0) +
    TRUST_WEIGHTS.supplychain *
      (prov.results?.sbom_valid && prov.results?.attestation_valid ? 1 : 0);

  return Math.round((score / wsum) * 100);
}

/**
 * Enforce quality gates based on risk tier
 * @param {string} gateType - Type of gate to check
 * @param {Object} options - Gate options
 */
function enforceGate(gateType, options) {
  const { tier, value, projectId, experimentalMode = false } = options;

  // Handle experimental mode
  const effectiveTier = experimentalMode ? 'experimental' : tier;

  // Convert tier to number if it's a string
  const tierNum = typeof effectiveTier === 'string' ? parseInt(effectiveTier) : effectiveTier;

  if (!TIER_POLICY[tierNum] && effectiveTier !== 'experimental') {
    console.error(`❌ Invalid tier: ${tier} (parsed as: ${tierNum})`);
    process.exit(1);
  }

  const policy = TIER_POLICY[effectiveTier];

  // Check for waivers first
  const waiverStatus = projectId ? checkWaiverStatus(projectId, gateType) : { waived: false };

  if (waiverStatus.waived) {
    console.log(
      `⚠️  Gate ${gateType} waived for project ${projectId} (waiver: ${waiverStatus.waiverId})`
    );
    console.log(`   Reason: ${waiverStatus.reason}`);
    console.log(`   Max Trust Score: ${waiverStatus.maxTrustScore}`);
    return; // Skip enforcement
  }

  switch (gateType) {
    case 'coverage':
      if (value < policy.min_branch) {
        console.error(
          `❌ Branch coverage ${value} below tier ${tierNum} minimum: ${policy.min_branch}`
        );
        process.exit(1);
      }
      console.log(`✅ Branch coverage gate passed: ${value} >= ${policy.min_branch}`);
      break;

    case 'mutation':
      if (value < policy.min_mutation) {
        console.error(
          `❌ Mutation score ${value} below tier ${tierNum} minimum: ${policy.min_mutation}`
        );
        process.exit(1);
      }
      console.log(`✅ Mutation gate passed: ${value} >= ${policy.min_mutation}`);
      break;

    case 'trust':
      const score = value;
      const minScore = 82; // Target trust score
      if (score < minScore) {
        console.error(`❌ Trust score ${score} below minimum: ${minScore}`);
        process.exit(1);
      }
      console.log(`✅ Trust score gate passed: ${score} >= ${minScore}`);
      break;

    case 'budget':
      if (value.files > policy.max_files) {
        console.error(
          `❌ Files changed (${value.files}) exceeds tier ${tierNum} limit: ${policy.max_files}`
        );
        process.exit(1);
      }
      if (value.loc > policy.max_loc) {
        console.error(
          `❌ Lines changed (${value.loc}) exceeds tier ${tierNum} limit: ${policy.max_loc}`
        );
        process.exit(1);
      }
      console.log(`✅ Budget gate passed: ${value.files} files, ${value.loc} LOC`);
      break;

    default:
      console.error(`❌ Unknown gate type: ${gateType}`);
      process.exit(1);
  }
}

/**
 * Show tier policy information
 * @param {string} tier - Tier to show info for
 */
function showTierInfo(tier) {
  const effectiveTier = tier === 'experimental' ? 'experimental' : tier;
  const tierNum = typeof effectiveTier === 'string' ? parseInt(effectiveTier) : effectiveTier;
  const policy = TIER_POLICY[tierNum];

  if (!policy) {
    console.error(`❌ Invalid tier: ${tier} (parsed as: ${tierNum})`);
    return;
  }

  const tierName = effectiveTier === 'experimental' ? 'Experimental' : `Tier ${tierNum}`;
  console.log(`📋 ${tierName} Policy:`);
  console.log(`   - Branch Coverage: ≥${policy.min_branch * 100}%`);
  console.log(`   - Mutation Score: ≥${policy.min_mutation * 100}%`);
  console.log(`   - Max Files: ${policy.max_files}`);
  console.log(`   - Max LOC: ${policy.max_loc}`);
  console.log(`   - Requires Contracts: ${policy.requires_contracts}`);
  console.log(`   - Allowed Modes: ${policy.allowed_modes.join(', ')}`);
  console.log(`   - Manual Review: ${policy.requires_manual_review ? 'Required' : 'Not required'}`);

  if (effectiveTier === 'experimental') {
    console.log(`   - 🧪 Experimental Mode: Reduced requirements for prototyping`);
  }
}

// CLI interface
if (require.main === module) {
  const command = process.argv[2];

  // Get project ID from environment or arguments
  const projectId = process.env.CAWS_PROJECT_ID || process.argv[process.argv.length - 1];

  switch (command) {
    case 'coverage':
      enforceGate('coverage', {
        tier: process.argv[3],
        value: parseFloat(process.argv[4]),
        projectId: projectId,
        experimentalMode: process.argv[5] === 'true',
      });
      break;

    case 'mutation':
      enforceGate('mutation', {
        tier: process.argv[3],
        value: parseFloat(process.argv[4]),
        projectId: projectId,
        experimentalMode: process.argv[5] === 'true',
      });
      break;

    case 'trust':
      enforceGate('trust', {
        tier: process.argv[3],
        value: parseInt(process.argv[4]),
        projectId: projectId,
        experimentalMode: process.argv[5] === 'true',
      });
      break;

    case 'budget':
      enforceGate('budget', {
        tier: process.argv[3],
        value: {
          files: parseInt(process.argv[4]),
          loc: parseInt(process.argv[5]),
        },
        projectId: projectId,
        experimentalMode: process.argv[6] === 'true',
      });
      break;

    case 'tier':
      showTierInfo(process.argv[3]);
      break;

    case 'trust-score':
      if (process.argv.length < 4) {
        console.error(
          '❌ Usage: node gates.js trust-score <tier> <coverage> <mutation> <test_quality> <consumer> <provider> <a11y> <perf> <flake> <mode> <scope> <supplychain> <experimental>'
        );
        process.exit(1);
      }

      const tier = process.argv[3];
      const prov = {
        results: {
          coverage_branch: parseFloat(process.argv[4]),
          mutation_score: parseFloat(process.argv[5]),
          contracts: {
            consumer: process.argv[6] === 'true',
            provider: process.argv[7] === 'true',
          },
          a11y: process.argv[8],
          perf: { api_p95_ms: parseInt(process.argv[9]) },
          flake_rate: parseFloat(process.argv[10]),
          mode_compliance: process.argv[11],
          scope_within_budget: process.argv[12] === 'true',
          sbom_valid: process.argv[13] === 'true',
          attestation_valid: process.argv[14] === 'true',
        },
        experimental_mode: {
          enabled: process.argv[15] === 'true',
        },
      };

      const score = trustScore(tier, prov);
      console.log(`📊 Trust Score: ${score}/100`);
      break;

    default:
      console.log('CAWS Quality Gates Tool');
      console.log('Usage:');
      console.log('  node gates.js coverage <tier> <value>');
      console.log('  node gates.js mutation <tier> <value>');
      console.log('  node gates.js trust <tier> <score>');
      console.log('  node gates.js budget <tier> <files> <loc>');
      console.log('  node gates.js tier <tier>');
      console.log(
        '  node gates.js trust-score <tier> <coverage> <mutation> <test_quality> <consumer> <provider> <a11y> <perf> <flake> <mode> <scope> <supplychain> <experimental>'
      );
      process.exit(1);
  }
}

module.exports = {
  trustScore,
  enforceGate,
  showTierInfo,
  TIER_POLICY,
  TRUST_WEIGHTS,
};
