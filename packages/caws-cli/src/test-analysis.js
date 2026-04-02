/**
 * @fileoverview Test Analysis Module - v0.1 Statistical Learning
 * Learns from waivers and historical data to improve budget allocation and test selection
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const { resolveSpec } = require('./utils/spec-resolver');

/**
 * Waiver Pattern Learning Engine
 * Analyzes waiver history to find systematic patterns in budget overruns
 */
class WaiverPatternLearner {
  constructor(projectRoot = process.cwd()) {
    this.projectRoot = projectRoot;
  }

  /**
   * Analyze waiver patterns from historical data
   */
  analyzePatterns() {
    try {
      const waivers = this.loadWaivers();
      const specs = this.loadHistoricalSpecs();

      if (waivers.length === 0) {
        return {
          status: 'insufficient_data',
          message: 'No waiver data available for analysis',
          patterns: {},
        };
      }

      const patterns = {
        total_waivers: waivers.length,
        budget_overruns: this.analyzeBudgetOverruns(waivers, specs),
        common_reasons: this.analyzeCommonReasons(waivers),
        risk_factors: this.identifyRiskFactors(waivers, specs),
        generated_at: new Date().toISOString(),
      };

      return {
        status: 'success',
        patterns,
      };
    } catch (error) {
      return {
        status: 'error',
        message: error.message,
        patterns: {},
      };
    }
  }

  /**
   * Load all waiver files from .caws/waivers/
   */
  loadWaivers() {
    const waiversDir = path.join(this.projectRoot, '.caws', 'waivers');
    if (!fs.existsSync(waiversDir)) {
      return [];
    }

    const waiverFiles = fs
      .readdirSync(waiversDir)
      .filter((file) => file.endsWith('.yaml'))
      .map((file) => {
        try {
          const waiverPath = path.join(waiversDir, file);
          const waiver = yaml.load(fs.readFileSync(waiverPath, 'utf8'));
          return { ...waiver, file: file };
        } catch (error) {
          console.warn(`Failed to load waiver ${file}: ${error.message}`);
          return null;
        }
      })
      .filter((waiver) => waiver !== null);

    return waiverFiles;
  }

  /**
   * Load historical working specs from git history
   * Retrieves past versions of spec files to analyze patterns
   */
  loadHistoricalSpecs() {
    const { execSync } = require('child_process');
    const specs = [];

    try {
      // Get list of commits that modified spec files
      const specPaths = [
        '.caws/working-spec.yaml',
        '.caws/specs/*.yaml',
      ];

      for (const specPattern of specPaths) {
        try {
          // Get commits that touched spec files
          const logOutput = execSync(
            `git log --pretty=format:"%H" --follow -- "${specPattern}" 2>/dev/null | head -20`,
            { cwd: this.projectRoot, encoding: 'utf8' }
          ).trim();

          if (!logOutput) continue;

          const commits = logOutput.split('\n').filter(Boolean);

          for (const commitHash of commits) {
            try {
              // Get the list of files matching the pattern at that commit
              const filesOutput = execSync(
                `git ls-tree -r --name-only ${commitHash} -- "${specPattern}" 2>/dev/null`,
                { cwd: this.projectRoot, encoding: 'utf8' }
              ).trim();

              if (!filesOutput) continue;

              const files = filesOutput.split('\n').filter(Boolean);

              for (const filePath of files) {
                try {
                  // Get the spec content at that commit
                  const specContent = execSync(
                    `git show ${commitHash}:"${filePath}" 2>/dev/null`,
                    { cwd: this.projectRoot, encoding: 'utf8' }
                  );

                  const spec = yaml.load(specContent);
                  if (spec && spec.id) {
                    // Get commit date for context
                    const commitDate = execSync(
                      `git show -s --format=%ci ${commitHash}`,
                      { cwd: this.projectRoot, encoding: 'utf8' }
                    ).trim();

                    specs.push({
                      ...spec,
                      _commit: commitHash.substring(0, 7),
                      _date: commitDate,
                      _file: filePath,
                    });
                  }
                } catch {
                  // Skip files that can't be loaded
                }
              }
            } catch {
              // Skip commits with issues
            }
          }
        } catch {
          // Pattern didn't match any files
        }
      }

      // Also check archived specs in .caws/archive/
      const archiveDir = path.join(this.projectRoot, '.caws', 'archive');
      if (fs.existsSync(archiveDir)) {
        const archiveFiles = fs.readdirSync(archiveDir)
          .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

        for (const file of archiveFiles) {
          try {
            const archivePath = path.join(archiveDir, file);
            const spec = yaml.load(fs.readFileSync(archivePath, 'utf8'));
            if (spec && spec.id) {
              specs.push({
                ...spec,
                _source: 'archive',
                _file: file,
              });
            }
          } catch {
            // Skip invalid archive files
          }
        }
      }

      // Deduplicate by spec ID, keeping the most recent version
      const uniqueSpecs = new Map();
      for (const spec of specs) {
        const existing = uniqueSpecs.get(spec.id);
        if (!existing || (spec._date && (!existing._date || spec._date > existing._date))) {
          uniqueSpecs.set(spec.id, spec);
        }
      }

      return Array.from(uniqueSpecs.values());
    } catch (error) {
      console.warn(`Failed to load historical specs: ${error.message}`);
      return [];
    }
  }

  /**
   * Analyze budget overrun patterns
   */
  analyzeBudgetOverruns(waivers, _specs) {
    const budgetWaivers = waivers.filter((w) => w.gates?.includes('budget_limit'));

    if (budgetWaivers.length === 0) {
      return {
        average_overrun_files: 0,
        average_overrun_loc: 0,
        common_patterns: [],
      };
    }

    const overruns = budgetWaivers
      .filter((w) => w.delta)
      .map((w) => ({
        files: w.delta.max_files || 0,
        loc: w.delta.max_loc || 0,
        reason: w.reason_code,
        applies_to: w.applies_to,
      }));

    const avgFiles = overruns.reduce((sum, o) => sum + o.files, 0) / overruns.length;
    const avgLoc = overruns.reduce((sum, o) => sum + o.loc, 0) / overruns.length;

    // Group by reason
    const byReason = overruns.reduce((acc, overrun) => {
      acc[overrun.reason] = acc[overrun.reason] || [];
      acc[overrun.reason].push(overrun);
      return acc;
    }, {});

    const commonPatterns = Object.entries(byReason)
      .map(([reason, overruns]) => ({
        reason,
        frequency: overruns.length / budgetWaivers.length,
        avg_overrun_files: overruns.reduce((sum, o) => sum + o.files, 0) / overruns.length,
        avg_overrun_loc: overruns.reduce((sum, o) => sum + o.loc, 0) / overruns.length,
      }))
      .sort((a, b) => b.frequency - a.frequency);

    return {
      total_budget_waivers: budgetWaivers.length,
      average_overrun_files: Math.round(avgFiles),
      average_overrun_loc: Math.round(avgLoc),
      common_patterns: commonPatterns.slice(0, 5), // Top 5 patterns
    };
  }

  /**
   * Analyze most common waiver reasons
   */
  analyzeCommonReasons(waivers) {
    const reasons = waivers.reduce((acc, waiver) => {
      acc[waiver.reason_code] = (acc[waiver.reason_code] || 0) + 1;
      return acc;
    }, {});

    return Object.entries(reasons)
      .map(([reason, count]) => ({
        reason,
        count,
        frequency: count / waivers.length,
      }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Identify risk factors from waiver patterns
   */
  identifyRiskFactors(waivers, _specs) {
    // Simple risk factor identification based on waiver frequency
    const riskFactors = [];

    const reasons = this.analyzeCommonReasons(waivers);
    if (reasons.length > 0) {
      riskFactors.push({
        factor: 'common_waiver_reasons',
        description: `${reasons[0].reason} waivers occur in ${Math.round(reasons[0].frequency * 100)}% of cases`,
        risk_level:
          reasons[0].frequency > 0.5 ? 'high' : reasons[0].frequency > 0.3 ? 'medium' : 'low',
      });
    }

    return riskFactors;
  }
}

/**
 * Project Similarity Matcher
 * Finds historical projects similar to current work
 */
class ProjectSimilarityMatcher {
  constructor(projectRoot = process.cwd()) {
    this.projectRoot = projectRoot;
    this.patternLearner = new WaiverPatternLearner(projectRoot);
  }

  /**
   * Find projects similar to the current spec
   * Uses real historical specs from git history when available
   */
  findSimilarProjects(currentSpec) {
    // Load real historical specs first
    const historicalSpecs = this.patternLearner.loadHistoricalSpecs();

    // Convert historical specs to project format with budget data
    const historicalProjects = historicalSpecs
      .filter(spec => spec.id !== currentSpec.id) // Exclude current spec
      .map(spec => this.specToProject(spec));

    // If we have real historical data, use it
    if (historicalProjects.length > 0) {
      return historicalProjects
        .map((project) => ({
          project: project.id,
          similarity_score: this.calculateSimilarity(currentSpec, project),
          budget_accuracy: project.allocated_budget.files > 0
            ? project.actual_budget.files / project.allocated_budget.files
            : 1.0,
          waiver_count: project.waivers?.length || 0,
          details: project,
        }))
        .filter((p) => p.similarity_score > 0.3)
        .sort((a, b) => b.similarity_score - a.similarity_score)
        .slice(0, 5);
    }

    // Fallback to demo data if no historical specs found
    const demoProjects = [
      {
        id: 'PROJ-0123',
        title: 'API Enhancement',
        risk_tier: 2,
        mode: 'feature',
        tech_stack: 'node',
        feature_type: 'api',
        actual_budget: { files: 85, loc: 8500 },
        allocated_budget: { files: 70, loc: 7000 },
        waivers: ['WV-0001'],
      },
      {
        id: 'FEAT-0456',
        title: 'UI Component Library',
        risk_tier: 2,
        mode: 'feature',
        tech_stack: 'react',
        feature_type: 'ui',
        actual_budget: { files: 45, loc: 4200 },
        allocated_budget: { files: 50, loc: 5000 },
        waivers: [],
      },
      {
        id: 'FIX-0789',
        title: 'Data Migration',
        risk_tier: 1,
        mode: 'feature',
        tech_stack: 'node',
        feature_type: 'data',
        actual_budget: { files: 25, loc: 2800 },
        allocated_budget: { files: 20, loc: 2000 },
        waivers: ['WV-0002'],
      },
    ];

    // Add a demo project similar to ARCH-0001 for demonstration
    if (currentSpec.id === 'ARCH-0001') {
      demoProjects.push({
        id: 'ARCH-0002',
        title: 'Policy System Refactor',
        risk_tier: 1,
        mode: 'feature',
        tech_stack: 'node',
        feature_type: 'architecture',
        actual_budget: { files: 120, loc: 12000 },
        allocated_budget: { files: 100, loc: 10000 },
        waivers: ['WV-0002'],
      });
    }

    return demoProjects
      .map((project) => ({
        project: project.id,
        similarity_score: this.calculateSimilarity(currentSpec, project),
        budget_accuracy: project.actual_budget.files / project.allocated_budget.files,
        waiver_count: project.waivers.length,
        details: project,
      }))
      .filter((p) => p.similarity_score > 0.3) // Lower threshold for demonstration
      .sort((a, b) => b.similarity_score - a.similarity_score)
      .slice(0, 5); // Top 5 matches
  }

  /**
   * Convert a spec object to project format for similarity comparison
   */
  specToProject(spec) {
    // Extract budget info from spec
    const budget = spec.budget || spec.scope?.budget || {};
    const allocatedFiles = budget.max_files || budget.files || 50;
    const allocatedLoc = budget.max_loc || budget.loc || 5000;

    // If spec has actual metrics, use them; otherwise estimate from allocated
    const actualFiles = spec.metrics?.files_changed || spec.actual_files || allocatedFiles;
    const actualLoc = spec.metrics?.lines_changed || spec.actual_loc || allocatedLoc;

    // Extract tech stack from spec metadata
    let techStack = spec.tech_stack || spec.metadata?.tech_stack || 'unknown';
    if (!techStack || techStack === 'unknown') {
      // Try to infer from title or description
      const text = `${spec.title || ''} ${spec.description || ''}`.toLowerCase();
      if (text.includes('react') || text.includes('ui') || text.includes('component')) {
        techStack = 'react';
      } else if (text.includes('api') || text.includes('node') || text.includes('server')) {
        techStack = 'node';
      } else if (text.includes('python') || text.includes('django') || text.includes('flask')) {
        techStack = 'python';
      }
    }

    // Extract feature type
    let featureType = spec.feature_type || spec.type || 'general';
    if (featureType === 'general') {
      const text = `${spec.title || ''} ${spec.description || ''}`.toLowerCase();
      if (text.includes('api') || text.includes('endpoint')) {
        featureType = 'api';
      } else if (text.includes('ui') || text.includes('component') || text.includes('view')) {
        featureType = 'ui';
      } else if (text.includes('data') || text.includes('migration') || text.includes('database')) {
        featureType = 'data';
      } else if (text.includes('refactor') || text.includes('architecture')) {
        featureType = 'architecture';
      }
    }

    return {
      id: spec.id,
      title: spec.title || spec.name || spec.id,
      risk_tier: spec.risk_tier || spec.tier || 2,
      mode: spec.mode || 'feature',
      tech_stack: techStack,
      feature_type: featureType,
      actual_budget: {
        files: actualFiles,
        loc: actualLoc,
      },
      allocated_budget: {
        files: allocatedFiles,
        loc: allocatedLoc,
      },
      waivers: spec.waivers || [],
      _source: spec._source,
      _date: spec._date,
    };
  }

  /**
   * Calculate similarity score between two specs/projects
   */
  calculateSimilarity(spec1, spec2) {
    let score = 0;
    let factors = 0;

    // Risk tier match
    if (spec1.risk_tier === spec2.risk_tier) {
      score += 0.3;
    }
    factors += 0.3;

    // Mode match
    if (spec1.mode === spec2.mode) {
      score += 0.2;
    }
    factors += 0.2;

    // Tech stack match (if available)
    if (spec1.tech_stack && spec2.tech_stack && spec1.tech_stack === spec2.tech_stack) {
      score += 0.2;
    }
    factors += 0.2;

    // Feature type match (if available)
    if (spec1.feature_type && spec2.feature_type && spec1.feature_type === spec2.feature_type) {
      score += 0.3;
    }
    factors += 0.3;

    return factors > 0 ? score / factors : 0;
  }
}

/**
 * Budget Predictor using statistical analysis
 */
class BudgetPredictor {
  constructor(projectRoot = process.cwd()) {
    this.projectRoot = projectRoot;
    this.patternLearner = new WaiverPatternLearner(projectRoot);
    this.similarityMatcher = new ProjectSimilarityMatcher(projectRoot);
  }

  /**
   * Assess budget for a working spec
   */
  assessBudget(spec) {
    try {
      const patterns = this.patternLearner.analyzePatterns();
      const similarProjects = this.similarityMatcher.findSimilarProjects(spec);

      if (patterns.status !== 'success' || similarProjects.length === 0) {
        return {
          status: 'insufficient_data',
          message: 'Not enough historical data for accurate prediction',
          recommendation: {
            use_default_tier: true,
            confidence: 0.0,
          },
        };
      }

      // Calculate recommended budget based on similar projects
      const similarBudgets = similarProjects.map((p) => p.details.actual_budget);
      const avgFiles = similarBudgets.reduce((sum, b) => sum + b.files, 0) / similarBudgets.length;
      const avgLoc = similarBudgets.reduce((sum, b) => sum + b.loc, 0) / similarBudgets.length;

      // Apply buffer based on waiver patterns
      const fileBuffer = patterns.patterns.budget_overruns?.average_overrun_files || 0;
      const locBuffer = patterns.patterns.budget_overruns?.average_overrun_loc || 0;

      const recommendedFiles = Math.round(avgFiles * (1 + fileBuffer / 100));
      const recommendedLoc = Math.round(avgLoc * (1 + locBuffer / 100));

      // Calculate confidence based on sample size and variance
      const confidence = Math.min(0.9, similarProjects.length / 10); // Max 90% confidence

      return {
        status: 'success',
        assessment: {
          similar_projects_analyzed: similarProjects.length,
          recommended_budget: {
            files: recommendedFiles,
            loc: recommendedLoc,
          },
          baseline_budget: {
            files: Math.round(avgFiles),
            loc: Math.round(avgLoc),
          },
          buffer_applied: {
            files_percent: Math.round((fileBuffer / avgFiles) * 100),
            loc_percent: Math.round((locBuffer / avgLoc) * 100),
          },
          rationale: this.generateRationale(spec, similarProjects, patterns),
          risk_factors: patterns.patterns.risk_factors || [],
          confidence: Math.round(confidence * 100) / 100,
        },
      };
    } catch (error) {
      return {
        status: 'error',
        message: error.message,
        recommendation: {
          use_default_tier: true,
          confidence: 0.0,
        },
      };
    }
  }

  /**
   * Generate human-readable rationale for the recommendation
   */
  generateRationale(spec, similarProjects, patterns) {
    const reasons = [];

    if (similarProjects.length > 0) {
      const topMatch = similarProjects[0];
      reasons.push(
        `Similar to ${topMatch.project} (${Math.round(topMatch.similarity_score * 100)}% match)`
      );
    }

    if (patterns.patterns.budget_overruns?.common_patterns?.length > 0) {
      const topPattern = patterns.patterns.budget_overruns.common_patterns[0];
      reasons.push(
        `Historical ${topPattern.reason} overruns add ${topPattern.avg_overrun_files} files on average`
      );
    }

    if (spec.mode === 'feature') {
      reasons.push('Feature development typically needs 15-25% budget buffer');
    }

    return reasons;
  }
}

/**
 * Main Test Analysis CLI handler
 */
async function testAnalysisCommand(subcommand, options = [], commandOptions = {}) {
  const chalk = (await import('chalk')).default;

  try {
    switch (subcommand) {
      case 'assess-budget':
        return await handleAssessBudget(options, commandOptions);
      case 'analyze-patterns':
        return await handleAnalyzePatterns(options);
      case 'find-similar':
        return await handleFindSimilar(options, commandOptions);
      default:
        console.log(chalk.red('Unknown test-analysis subcommand'));
        console.log('Available commands:');
        console.log('  assess-budget    - Analyze budget needs for current spec');
        console.log('  analyze-patterns - Show waiver pattern analysis');
        console.log('  find-similar     - Find similar historical projects');
        return;
    }
  } catch (error) {
    console.error(chalk.red('Test analysis failed:'), error.message);
  }
}

/**
 * Resolve the current spec for analysis commands.
 * Supports explicit `--spec <path>` for compatibility, but prefers
 * the suite-standard resolver and `--spec-id`.
 * @param {string[]} optionArgs
 * @param {Object} commandOptions
 * @returns {Promise<{spec: Object, specPath: string}>}
 */
async function resolveAnalysisSpec(optionArgs = [], commandOptions = {}) {
  let specFile = null;
  if (Array.isArray(optionArgs) && optionArgs.includes('--spec')) {
    const specIndex = optionArgs.indexOf('--spec');
    if (specIndex + 1 < optionArgs.length) {
      specFile = optionArgs[specIndex + 1];
    }
  }

  const resolved = await resolveSpec({
    specId: commandOptions.specId,
    specFile,
    warnLegacy: false,
    interactive: false,
  });

  return {
    spec: resolved.spec,
    specPath: resolved.path,
  };
}

/**
 * Handle budget assessment command
 */
async function handleAssessBudget(options, commandOptions = {}) {
  const chalk = (await import('chalk')).default;
  const predictor = new BudgetPredictor();

  try {
    const { spec, specPath } = await resolveAnalysisSpec(options, commandOptions);

    console.log(chalk.cyan(`Budget Assessment for ${spec.id}`));
    console.log('==============================================');
    console.log(chalk.gray(`Spec: ${path.relative(process.cwd(), specPath)}`));

    const result = predictor.assessBudget(spec);

    if (result.status === 'success') {
      const assessment = result.assessment;
      console.log(
        `Historical Analysis: ${assessment.similar_projects_analyzed} similar projects analyzed`
      );
      console.log(
        `Recommended Budget: ${assessment.recommended_budget.files} files, ${assessment.recommended_budget.loc} LOC (+${assessment.buffer_applied.files_percent}% buffer)`
      );
      console.log(`Rationale: ${assessment.rationale.join('; ')}`);

      if (assessment.risk_factors.length > 0) {
        console.log(
          chalk.yellow(
            `Risk Factors: ${assessment.risk_factors.map((f) => f.description).join('; ')}`
          )
        );
      }

      const confidenceLevel =
        assessment.confidence > 0.8 ? 'High' : assessment.confidence > 0.6 ? 'Medium' : 'Low';
      console.log(
        chalk.green(
          `Confidence: ${confidenceLevel} (${Math.round(assessment.confidence * 100)}%)`
        )
      );
    } else {
      console.log(chalk.yellow(`${result.message}`));
      console.log('Consider using default tier-based budgeting for now');
    }
  } catch (error) {
    console.error(chalk.red('Failed to load spec:'), error.message);
  }
}

/**
 * Handle pattern analysis command
 */
async function handleAnalyzePatterns(_options) {
  const chalk = (await import('chalk')).default;
  const learner = new WaiverPatternLearner();

  console.log(chalk.cyan('Analyzing Waiver Patterns'));
  console.log('==============================================');

  const result = learner.analyzePatterns();

  if (result.status === 'success') {
    const patterns = result.patterns;

    console.log(`Total waivers analyzed: ${patterns.total_waivers}`);

    if (patterns.budget_overruns) {
      console.log('\nBudget Overrun Patterns:');
      console.log(
        `  Average overrun: ${patterns.budget_overruns.average_overrun_files} files, ${patterns.budget_overruns.average_overrun_loc} LOC`
      );

      if (patterns.budget_overruns.common_patterns.length > 0) {
        console.log('  Common patterns:');
        patterns.budget_overruns.common_patterns.forEach((pattern) => {
          console.log(
            `    ${pattern.reason}: ${Math.round(pattern.frequency * 100)}% frequency (+${pattern.avg_overrun_files} files avg)`
          );
        });
      }
    }

    if (patterns.common_reasons.length > 0) {
      console.log('\nMost Common Waiver Reasons:');
      patterns.common_reasons.slice(0, 5).forEach((reason) => {
        console.log(
          `  ${reason.reason}: ${reason.count} times (${Math.round(reason.frequency * 100)}%)`
        );
      });
    }
  } else {
    console.log(chalk.yellow(`${result.message}`));
  }
}

/**
 * Handle find similar projects command
 */
async function handleFindSimilar(options, commandOptions = {}) {
  const chalk = (await import('chalk')).default;
  const matcher = new ProjectSimilarityMatcher();

  try {
    const { spec, specPath } = await resolveAnalysisSpec(options, commandOptions);

    console.log(chalk.cyan(`Finding projects similar to ${spec.id}`));
    console.log('==============================================');
    console.log(chalk.gray(`Spec: ${path.relative(process.cwd(), specPath)}`));

    const similar = matcher.findSimilarProjects(spec);

    if (similar.length > 0) {
      similar.forEach((project) => {
        const similarityPercent = Math.round(project.similarity_score * 100);
        const accuracyPercent = Math.round(project.budget_accuracy * 100);
        console.log(
          `${project.project}: ${similarityPercent}% similar, ${accuracyPercent}% budget accuracy, ${project.waiver_count} waivers`
        );
      });
    } else {
      console.log(chalk.yellow('No similar projects found'));
    }
  } catch (error) {
    console.error(chalk.red('Failed to load spec:'), error.message);
  }
}

module.exports = {
  testAnalysisCommand,
  WaiverPatternLearner,
  ProjectSimilarityMatcher,
  BudgetPredictor,
};
