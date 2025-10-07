/**
 * CAWS CI/CD Optimizer
 *
 * Optimizes CI/CD pipelines with tier-based conditional execution,
 * parallel processing, and smart caching strategies.
 *
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class CICDOptimizer {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.cacheDir = path.join(this.projectRoot, '.caws', 'cache');
    this.optimizationConfig = path.join(this.projectRoot, '.caws', 'cicd-config.yaml');

    // Ensure cache directory exists
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Analyze project and generate CI/CD optimization recommendations
   */
  async analyzeProject(specPath = '.caws/working-spec.yaml') {
    const analysis = {
      project_tier: 'unknown',
      recommended_optimizations: [],
      cache_strategy: {},
      parallel_groups: [],
      conditional_execution: {},
      estimated_savings: {},
    };

    try {
      // Load working spec to determine tier
      if (fs.existsSync(specPath)) {
        const yaml = require('js-yaml');
        const spec = yaml.load(fs.readFileSync(specPath, 'utf8'));
        analysis.project_tier = spec.risk_tier || 2;
      }

      // Analyze current project structure
      analysis.recommended_optimizations = await this.analyzeOptimizationOpportunities(
        analysis.project_tier
      );

      // Generate cache strategy
      analysis.cache_strategy = await this.generateCacheStrategy();

      // Create parallel execution groups
      analysis.parallel_groups = await this.createParallelGroups();

      // Define conditional execution rules
      analysis.conditional_execution = this.generateConditionalExecutionRules(
        analysis.project_tier
      );

      // Estimate time savings
      analysis.estimated_savings = this.estimateTimeSavings(analysis);
    } catch (error) {
      console.warn('Warning: Could not complete full analysis:', error.message);
    }

    return analysis;
  }

  /**
   * Generate tier-based conditional execution rules
   */
  generateConditionalExecutionRules(tier) {
    const rules = {
      coverage_required: tier <= 2,
      mutation_required: tier === 1,
      contract_testing: tier <= 2,
      accessibility_check: tier <= 2,
      performance_budget: tier === 1,
      security_scan: true, // Always required
      lint_strict: tier <= 2,
    };

    // Add tier-specific rules
    if (tier === 1) {
      rules.integration_tests = true;
      rules.load_testing = true;
      rules.manual_review = true;
    } else if (tier === 2) {
      rules.integration_tests = true;
      rules.smoke_tests = true;
    } else {
      rules.unit_tests_only = true;
      rules.fast_feedback = true;
    }

    return rules;
  }

  /**
   * Analyze what optimizations are beneficial for this tier
   */
  async analyzeOptimizationOpportunities(tier) {
    const opportunities = [];

    // Tier-based optimizations
    if (tier === 3) {
      opportunities.push({
        type: 'fast_feedback',
        description: 'Skip heavy analysis for quick feedback',
        impact: 'high',
        effort: 'low',
      });
    }

    if (tier <= 2) {
      opportunities.push({
        type: 'parallel_execution',
        description: 'Run independent quality gates in parallel',
        impact: 'high',
        effort: 'medium',
      });
    }

    // Always beneficial optimizations
    opportunities.push({
      type: 'smart_caching',
      description: 'Cache dependencies and build artifacts',
      impact: 'medium',
      effort: 'low',
    });

    opportunities.push({
      type: 'test_selection',
      description: 'Run only tests affected by changes',
      impact: 'high',
      effort: 'medium',
    });

    opportunities.push({
      type: 'early_failure',
      description: 'Fail fast on critical issues',
      impact: 'medium',
      effort: 'low',
    });

    return opportunities;
  }

  /**
   * Generate intelligent caching strategy
   */
  async generateCacheStrategy() {
    const strategy = {
      node_modules: {
        key: 'node-modules-${{ hashFiles("package-lock.json") }}',
        paths: ['node_modules'],
        restore_keys: ['node-modules-'],
      },
      build_artifacts: {
        key: 'build-${{ github.sha }}',
        paths: ['dist', 'build', '.next'],
        restore_keys: [],
      },
      test_cache: {
        key: 'test-cache-${{ github.sha }}',
        paths: ['.jest/cache', '.nyc_output'],
        restore_keys: ['test-cache-'],
      },
    };

    // Check for specific frameworks and add framework-specific caches
    const packageJson = path.join(this.projectRoot, 'package.json');
    if (fs.existsSync(packageJson)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8'));

        if (pkg.dependencies && pkg.dependencies.next) {
          strategy.next_cache = {
            key: 'next-cache-${{ github.sha }}',
            paths: ['.next/cache'],
            restore_keys: [],
          };
        }

        if (pkg.devDependencies && pkg.devDependencies.jest) {
          strategy.jest_cache = {
            key: 'jest-${{ hashFiles("jest.config.js") }}',
            paths: ['.jest'],
            restore_keys: ['jest-'],
          };
        }
      } catch (error) {
        // Ignore package.json parsing errors
      }
    }

    return strategy;
  }

  /**
   * Create parallel execution groups for quality gates
   */
  async createParallelGroups() {
    const groups = [
      {
        name: 'fast-feedback',
        description: 'Quick checks that provide immediate feedback',
        jobs: ['lint', 'type-check', 'unit-tests-fast'],
        max_parallel: 3,
        timeout: 5,
      },
      {
        name: 'quality-gates',
        description: 'Comprehensive quality checks',
        jobs: ['coverage', 'mutation', 'security-scan'],
        max_parallel: 2,
        timeout: 15,
      },
      {
        name: 'integration',
        description: 'Integration and contract testing',
        jobs: ['contract-tests', 'integration-tests', 'accessibility'],
        max_parallel: 1,
        timeout: 20,
      },
    ];

    return groups;
  }

  /**
   * Analyze changed files to determine what tests to run
   */
  async analyzeChangedFiles(changedFiles = []) {
    const affectedTests = {
      unit: [],
      integration: [],
      contract: [],
      e2e: [],
    };

    // Simple heuristic - in production, this would use dependency analysis
    for (const file of changedFiles) {
      if (file.includes('src/') || file.includes('lib/')) {
        // Source file changes - run related unit tests
        affectedTests.unit.push(`test-${path.basename(file, path.extname(file))}`);
      }

      if (file.includes('api/') || file.includes('routes/')) {
        // API changes - run integration tests
        affectedTests.integration.push('api-integration');
      }

      if (file.includes('.contract.') || file.includes('contracts/')) {
        // Contract changes - run contract tests
        affectedTests.contract.push('contract-validation');
      }
    }

    return affectedTests;
  }

  /**
   * Estimate time savings from optimizations
   */
  estimateTimeSavings(analysis) {
    const baseTimes = {
      1: 45, // High tier - comprehensive checks
      2: 25, // Medium tier - standard checks
      3: 10, // Low tier - basic checks
    };

    const baseTime = baseTimes[analysis.project_tier] || 25;
    let optimizedTime = baseTime;

    // Apply optimizations
    if (analysis.recommended_optimizations.some((opt) => opt.type === 'parallel_execution')) {
      optimizedTime *= 0.7; // 30% improvement from parallelization
    }

    if (analysis.recommended_optimizations.some((opt) => opt.type === 'smart_caching')) {
      optimizedTime *= 0.85; // 15% improvement from caching
    }

    if (analysis.recommended_optimizations.some((opt) => opt.type === 'test_selection')) {
      optimizedTime *= 0.6; // 40% improvement from selective testing
    }

    const savings = {
      original_minutes: baseTime,
      optimized_minutes: Math.round(optimizedTime),
      savings_percent: Math.round((1 - optimizedTime / baseTime) * 100),
      monthly_savings_hours: Math.round((((baseTime - optimizedTime) * 30) / 60) * 10) / 10, // Assuming 30 runs/month
    };

    return savings;
  }

  /**
   * Generate optimized CI/CD configuration
   */
  async generateOptimizedConfig(platform = 'github') {
    const analysis = await this.analyzeProject();

    if (platform === 'github') {
      return this.generateGitHubActionsConfig(analysis);
    } else if (platform === 'gitlab') {
      return this.generateGitLabCIConfig(analysis);
    } else if (platform === 'jenkins') {
      return this.generateJenkinsConfig(analysis);
    }

    throw new Error(`Unsupported CI/CD platform: ${platform}`);
  }

  /**
   * Generate optimized GitHub Actions workflow
   */
  generateGitHubActionsConfig(analysis) {
    const config = {
      name: 'CAWS Quality Gates',
      on: {
        push: { branches: ['main', 'develop'] },
        pull_request: { branches: ['main'] },
      },
      jobs: {},
    };

    // Fast feedback job
    config.jobs.fast_feedback = {
      name: 'Fast Feedback',
      'runs-on': 'ubuntu-latest',
      steps: [
        { uses: 'actions/checkout@v3' },
        {
          name: 'Setup Node.js',
          uses: 'actions/setup-node@v3',
          with: { 'node-version': '18', cache: 'npm' },
        },
        { run: 'npm ci' },
        { run: 'npm run lint', continue_on_error: analysis.project_tier === 3 },
        { run: 'npm run type-check' },
        {
          run: 'npm run test:unit',
          continue_on_error: analysis.project_tier === 3,
        },
      ],
    };

    // Quality gates job (conditional based on tier)
    if (analysis.conditional_execution.coverage_required) {
      config.jobs.quality_gates = {
        name: 'Quality Gates',
        'runs-on': 'ubuntu-latest',
        needs: ['fast_feedback'],
        steps: [
          { uses: 'actions/checkout@v3' },
          {
            name: 'Setup Node.js',
            uses: 'actions/setup-node@v3',
            with: { 'node-version': '18', cache: 'npm' },
          },
          { run: 'npm ci' },
          { run: 'npm run test:coverage' },
          ...(analysis.conditional_execution.security_scan
            ? [{ run: 'npm run security-scan' }]
            : []),
          ...(analysis.conditional_execution.contract_testing
            ? [{ run: 'npm run test:contract' }]
            : []),
        ],
      };
    }

    // Integration tests (only for T1/T2)
    if (analysis.conditional_execution.integration_tests) {
      config.jobs.integration = {
        name: 'Integration Tests',
        'runs-on': 'ubuntu-latest',
        needs: ['quality_gates'],
        steps: [
          { uses: 'actions/checkout@v3' },
          {
            name: 'Setup Node.js',
            uses: 'actions/setup-node@v3',
            with: { 'node-version': '18', cache: 'npm' },
          },
          { run: 'npm ci' },
          { run: 'npm run test:integration' },
        ],
      };
    }

    return config;
  }

  /**
   * Generate GitLab CI configuration
   */
  generateGitLabCIConfig(analysis) {
    const config = {
      stages: ['fast_feedback', 'quality_gates', 'integration'],
      cache: {
        key: '${CI_COMMIT_REF_SLUG}',
        paths: ['node_modules/', '.cache/'],
      },
    };

    // Fast feedback job
    config['lint_and_test'] = {
      stage: 'fast_feedback',
      image: 'node:18',
      before_script: ['npm ci'],
      script: ['npm run lint', 'npm run type-check', 'npm run test:unit'],
      allow_failure: analysis.project_tier === 3,
    };

    // Quality gates
    if (analysis.conditional_execution.coverage_required) {
      config['quality_gates'] = {
        stage: 'quality_gates',
        image: 'node:18',
        before_script: ['npm ci'],
        script: [
          'npm run test:coverage',
          ...(analysis.conditional_execution.security_scan ? ['npm run security-scan'] : []),
          ...(analysis.conditional_execution.contract_testing ? ['npm run test:contract'] : []),
        ],
      };
    }

    return config;
  }

  /**
   * Generate Jenkins pipeline configuration
   */
  generateJenkinsConfig(analysis) {
    return `
pipeline {
    agent any

    stages {
        stage('Fast Feedback') {
            steps {
                sh 'npm ci'
                sh 'npm run lint'
                sh 'npm run type-check'
                sh 'npm run test:unit'
            }
        }

        ${
          analysis.conditional_execution.coverage_required
            ? `
        stage('Quality Gates') {
            steps {
                sh 'npm run test:coverage'
                ${analysis.conditional_execution.security_scan ? `sh 'npm run security-scan'` : ''}
                ${analysis.conditional_execution.contract_testing ? `sh 'npm run test:contract'` : ''}
            }
        }`
            : ''
        }

        ${
          analysis.conditional_execution.integration_tests
            ? `
        stage('Integration Tests') {
            steps {
                sh 'npm run test:integration'
            }
        }`
            : ''
        }
    }

    post {
        always {
            junit 'test-results/*.xml'
            publishCoverage adapters: [istanbulCoberturaAdapter('coverage/cobertura-coverage.xml')]
        }
    }
}`;
  }

  /**
   * Create hash for cache invalidation
   */
  createCacheHash(files) {
    const hasher = crypto.createHash('sha256');
    files.forEach((file) => {
      if (fs.existsSync(file)) {
        hasher.update(fs.readFileSync(file));
      }
    });
    return hasher.digest('hex').substring(0, 16);
  }
}

module.exports = CICDOptimizer;
