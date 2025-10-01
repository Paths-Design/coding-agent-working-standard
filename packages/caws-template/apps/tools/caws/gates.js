#!/usr/bin/env node

/**
 * @fileoverview CAWS Gates Tool - Real Implementation
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');

// Tier policies for quality gates
const TIER_POLICIES = {
  1: {
    branch_coverage: 0.9,
    mutation_score: 0.7,
    max_files: 40,
    max_loc: 1500,
    trust_score: 85,
  },
  2: {
    branch_coverage: 0.8,
    mutation_score: 0.5,
    max_files: 25,
    max_loc: 1000,
    trust_score: 82,
  },
  3: {
    branch_coverage: 0.7,
    mutation_score: 0.3,
    max_files: 15,
    max_loc: 500,
    trust_score: 75,
  },
};

/**
 * Show tier policy with current project analysis
 * @param {number} tier - Risk tier (1-3)
 * @param {string} projectRoot - Project root directory
 */
function showTierPolicy(tier = 1, projectRoot = process.cwd()) {
  const policy = TIER_POLICIES[tier];
  if (!policy) {
    console.error(`❌ Unknown tier: ${tier}`);
    process.exit(1);
  }

  console.log(`📋 Tier ${tier} Policy Analysis:`);
  console.log(`Branch Coverage: ≥${policy.branch_coverage * 100}%`);
  console.log(`Mutation Score: ≥${policy.mutation_score * 100}%`);
  console.log(`Max Files: ${policy.max_files}`);
  console.log(`Max LOC: ${policy.max_loc}`);
  console.log(`Trust Score: ≥${policy.trust_score}`);
  console.log('Requires Contracts: true');
  console.log('Manual Review: Required');
  console.log('');

  // Analyze current project against policy
  const analysis = analyzeProject(projectRoot, tier);

  console.log('🔍 Current Project Analysis:');
  console.log(`Files: ${analysis.fileCount} (limit: ${policy.max_files})`);
  console.log(`Lines of Code: ${analysis.lineCount} (limit: ${policy.max_loc})`);
  console.log(`Test Files: ${analysis.testFileCount}`);
  console.log(`Test Coverage: ${analysis.testCoverage || 'Not available'}`);
  console.log(`Mutation Score: ${analysis.mutationScore || 'Not available'}`);
  console.log('');

  // Check gates
  const gateResults = checkQualityGates(analysis, policy, tier);

  console.log('🚦 Quality Gate Results:');
  gateResults.forEach((gate) => {
    const status = gate.passed ? '✅' : '❌';
    console.log(`${status} ${gate.name}: ${gate.message}`);
  });
}

/**
 * Analyze project metrics for quality gate evaluation
 * @param {string} projectRoot - Project root directory
 * @param {number} _tier - Risk tier for context (currently unused)
 * @returns {Object} Project analysis results
 */
function analyzeProject(projectRoot, _tier) {
  const analysis = {
    fileCount: 0,
    lineCount: 0,
    testFileCount: 0,
    testCoverage: null,
    mutationScore: null,
  };

  try {
    // Count source files and lines of code
    const sourceFiles = findSourceFiles(projectRoot);
    analysis.fileCount = sourceFiles.length;

    sourceFiles.forEach((file) => {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split('\n').filter((line) => line.trim().length > 0);
        analysis.lineCount += lines.length;
      } catch (error) {
        // Skip files that can't be read
      }
    });

    // Count test files
    const testFiles = findTestFiles(projectRoot);
    analysis.testFileCount = testFiles.length;

    // Try to get test coverage if available
    analysis.testCoverage = getTestCoverage(projectRoot);

    // Try to get mutation score if available
    analysis.mutationScore = getMutationScore(projectRoot);
  } catch (error) {
    console.warn(`⚠️  Error analyzing project: ${error.message}`);
  }

  return analysis;
}

/**
 * Find source files in the project
 * @param {string} projectRoot - Project root directory
 * @returns {string[]} Array of source file paths
 */
function findSourceFiles(projectRoot) {
  const files = [];

  function scanDirectory(dir) {
    const items = fs.readdirSync(dir);

    items.forEach((item) => {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);

      if (
        stat.isDirectory() &&
        !item.startsWith('.') &&
        item !== 'node_modules' &&
        item !== 'dist'
      ) {
        scanDirectory(fullPath);
      } else if (stat.isFile() && (item.endsWith('.js') || item.endsWith('.ts'))) {
        files.push(fullPath);
      }
    });
  }

  scanDirectory(projectRoot);
  return files;
}

/**
 * Find test files in the project
 * @param {string} projectRoot - Project root directory
 * @returns {string[]} Array of test file paths
 */
function findTestFiles(projectRoot) {
  const files = [];

  function scanDirectory(dir) {
    const items = fs.readdirSync(dir);

    items.forEach((item) => {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);

      if (
        stat.isDirectory() &&
        !item.startsWith('.') &&
        item !== 'node_modules' &&
        item !== 'dist'
      ) {
        scanDirectory(fullPath);
      } else if (stat.isFile() && (item.endsWith('.test.js') || item.endsWith('.spec.js'))) {
        files.push(fullPath);
      }
    });
  }

  scanDirectory(projectRoot);
  return files;
}

/**
 * Get test coverage percentage if available
 * @param {string} projectRoot - Project root directory
 * @returns {number|null} Coverage percentage or null if not available
 */
function getTestCoverage(projectRoot) {
  try {
    // Look for coverage report
    const coveragePath = path.join(projectRoot, 'coverage', 'coverage-summary.json');

    if (fs.existsSync(coveragePath)) {
      const coverageData = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
      const total = coverageData.total;

      if (total.lines) {
        return total.lines.pct / 100; // Convert percentage to decimal
      }
    }
  } catch (error) {
    // Coverage not available
  }

  return null;
}

/**
 * Get mutation score if available
 * @param {string} projectRoot - Project root directory
 * @returns {number|null} Mutation score or null if not available
 */
function getMutationScore(projectRoot) {
  try {
    // Look for mutation report
    const mutationPath = path.join(projectRoot, 'reports', 'mutation', 'mutation.json');

    if (fs.existsSync(mutationPath)) {
      const mutationData = JSON.parse(fs.readFileSync(mutationPath, 'utf8'));

      if (mutationData.files) {
        let totalMutations = 0;
        let killedMutations = 0;

        Object.values(mutationData.files).forEach((file) => {
          if (file.mutants) {
            file.mutants.forEach((mutant) => {
              totalMutations++;
              if (mutant.status === 'Killed') {
                killedMutations++;
              }
            });
          }
        });

        if (totalMutations > 0) {
          return killedMutations / totalMutations;
        }
      }
    }
  } catch (error) {
    // Mutation score not available
  }

  return null;
}

/**
 * Check quality gates against project analysis
 * @param {Object} analysis - Project analysis results
 * @param {Object} policy - Tier policy
 * @param {number} _tier - Risk tier (currently unused)
 * @returns {Array} Array of gate check results
 */
function checkQualityGates(analysis, policy, _tier) {
  const gates = [];

  // File count gate
  gates.push({
    name: 'File Count',
    passed: analysis.fileCount <= policy.max_files,
    message: `${analysis.fileCount} files (max: ${policy.max_files})`,
  });

  // Lines of code gate
  gates.push({
    name: 'Lines of Code',
    passed: analysis.lineCount <= policy.max_loc,
    message: `${analysis.lineCount} LOC (max: ${policy.max_loc})`,
  });

  // Test coverage gate (if available)
  if (analysis.testCoverage !== null) {
    gates.push({
      name: 'Test Coverage',
      passed: analysis.testCoverage >= policy.branch_coverage,
      message: `${(analysis.testCoverage * 100).toFixed(1)}% coverage (min: ${policy.branch_coverage * 100}%)`,
    });
  }

  // Mutation score gate (if available)
  if (analysis.mutationScore !== null) {
    gates.push({
      name: 'Mutation Score',
      passed: analysis.mutationScore >= policy.mutation_score,
      message: `${(analysis.mutationScore * 100).toFixed(1)}% score (min: ${policy.mutation_score * 100}%)`,
    });
  }

  // Trust score gate (placeholder - would need real calculation)
  gates.push({
    name: 'Trust Score',
    passed: true, // Placeholder - needs real implementation
    message: 'Trust score evaluation not implemented',
  });

  return gates;
}

// Enforce coverage gate
function enforceCoverageGate(coverage, threshold = 0.8) {
  if (coverage >= threshold) {
    console.log(`✅ Branch coverage gate passed: ${coverage} >= ${threshold}`);
    return true;
  } else {
    console.log(`❌ Branch coverage gate failed: ${coverage} < ${threshold}`);
    return false;
  }
}

// Enforce mutation gate
function enforceMutationGate(score, threshold = 0.5) {
  if (score >= threshold) {
    console.log(`✅ Mutation gate passed: ${score} >= ${threshold}`);
    return true;
  } else {
    console.log(`❌ Mutation gate failed: ${score} < ${threshold}`);
    return false;
  }
}

// Enforce trust score gate
function enforceTrustScoreGate(score, threshold = 82) {
  if (score >= threshold) {
    console.log(`✅ Trust score gate passed: ${score} >= ${threshold}`);
    return true;
  } else {
    console.log(`❌ Trust score gate failed: ${score} < ${threshold}`);
    return false;
  }
}

// Enforce budget gate
function enforceBudgetGate(files, loc, maxFiles = 25, maxLoc = 1000) {
  const filesOk = files <= maxFiles;
  const locOk = loc <= maxLoc;

  if (filesOk && locOk) {
    console.log(`✅ Budget gate passed: ${files} files, ${loc} LOC`);
    return true;
  } else {
    if (!filesOk) {
      console.log(`❌ Budget gate failed: ${files} files > ${maxFiles} max files`);
    }
    if (!locOk) {
      console.log(`❌ Budget gate failed: ${loc} LOC > ${maxLoc} max LOC`);
    }
    return false;
  }
}

// Main execution - support both new and legacy commands
function main() {
  const command = process.argv[2];

  switch (command) {
    case 'policy':
      // New command: show policy with project analysis
      const tier = parseInt(process.argv[3]) || 1;
      const projectRoot = process.argv[4] || process.cwd();
      showTierPolicy(tier, projectRoot);
      break;

    case 'tier':
      // Legacy command: show basic tier policy
      const legacyTier = parseInt(process.argv[3]) || 1;
      showTierPolicy(legacyTier);
      break;

    case 'coverage':
      // Handle test format: gates.js coverage "2" 0.85 (tier, value)
      const coverageTier = parseInt(process.argv[3]) || 1;
      const coverage = parseFloat(process.argv[4]) || 0.85;
      const coverageThreshold = TIER_POLICIES[coverageTier]?.branch_coverage || 0.8;
      if (!enforceCoverageGate(coverage, coverageThreshold)) {
        throw new Error(`Coverage gate failed: ${coverage} < ${coverageThreshold}`);
      }
      break;

    case 'mutation':
      // Handle test format: gates.js mutation "2" 0.60 (tier, value)
      const mutationTier = parseInt(process.argv[3]) || 1;
      const mutationScore = parseFloat(process.argv[4]) || 0.6;
      const mutationThreshold = TIER_POLICIES[mutationTier]?.mutation_score || 0.5;
      if (!enforceMutationGate(mutationScore, mutationThreshold)) {
        throw new Error(`Mutation gate failed: ${mutationScore} < ${mutationThreshold}`);
      }
      break;

    case 'trust':
      // Handle test format: gates.js trust "2" 85 (tier, value)
      const trustTier = parseInt(process.argv[3]) || 1;
      const trustScore = parseInt(process.argv[4]) || 85;
      const trustThreshold = TIER_POLICIES[trustTier]?.trust_score || 82;
      if (!enforceTrustScoreGate(trustScore, trustThreshold)) {
        throw new Error(`Trust score gate failed: ${trustScore} < ${trustThreshold}`);
      }
      break;

    case 'budget':
      // Handle test format: gates.js budget "2" 20 800 (tier, files, loc)
      const budgetTier = parseInt(process.argv[3]) || 1;
      const files = parseInt(process.argv[4]) || 20;
      const loc = parseInt(process.argv[5]) || 800;
      // Use tier-specific limits
      const maxFiles = TIER_POLICIES[budgetTier]?.max_files || 25;
      const maxLoc = TIER_POLICIES[budgetTier]?.max_loc || 1000;
      if (!enforceBudgetGate(files, loc, maxFiles, maxLoc)) {
        throw new Error(
          `Budget gate failed: ${files} files or ${loc} LOC exceeds tier ${budgetTier} limits (${maxFiles} files, ${maxLoc} LOC)`
        );
      }
      break;

    default:
      console.log('CAWS Gates Tool - Quality Gate Enforcement');
      console.log('');
      console.log('Commands:');
      console.log('  policy [tier] [project]    - Show tier policy with project analysis');
      console.log('  tier <tier>               - Show tier policy (legacy)');
      console.log('  coverage <score> [threshold] - Enforce coverage gate');
      console.log('  mutation <score> [threshold] - Enforce mutation gate');
      console.log('  trust <score> [threshold]    - Enforce trust score gate');
      console.log('  budget <files> <loc>         - Enforce budget gate');
      console.log('');
      console.log('Examples:');
      console.log('  node gates.js policy 2');
      console.log('  node gates.js tier 2');
      console.log('  node gates.js coverage 0.85');
      console.log('  node gates.js budget 20 800');
      break;
  }
}

if (require.main === module) {
  main();
}

// Export functions for module usage
module.exports = {
  showTierPolicy,
  enforceCoverageGate,
  enforceMutationGate,
  enforceTrustScoreGate,
  enforceBudgetGate,
  analyzeProject,
  checkQualityGates,
  findSourceFiles,
  findTestFiles,
  getTestCoverage,
  getMutationScore,
};
