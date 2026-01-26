/**
 * @fileoverview CAWS Monitoring System
 * Real-time monitoring of contracts, artifacts, budgets, and agent behavior
 * Provides alerts, progress tracking, and dashboard updates
 * @author @darianrosebrook
 */

import chokidar from 'chokidar';
import fs from 'fs-extra';
import yaml from 'js-yaml';
import path from 'path';
import { createChildLogger } from '../logger.js';

class CawsMonitor {
  constructor(options = {}) {
    this.options = {
      watchPaths: options.watchPaths || ['.caws', 'src', 'tests', 'docs'],
      pollingInterval: options.pollingInterval || 5000, // 5 seconds
      alertThresholds: {
        budgetWarning: 0.8, // 80% of budget
        budgetCritical: 0.95, // 95% of budget
        ...options.alertThresholds,
      },
      ...options,
    };

    this.watchers = new Map();
    this.budgets = new Map();
    this.progress = new Map();
    this.alerts = [];
    this.isRunning = false;

    // Create logger for this monitor instance
    this.logger = createChildLogger({ component: 'CawsMonitor' });

    // Bind methods
    this.handleFileChange = this.handleFileChange.bind(this);
    this.calculateBudgetUsage = this.calculateBudgetUsage.bind(this);
    this.checkForAlerts = this.checkForAlerts.bind(this);
    this.updateProgress = this.updateProgress.bind(this);
  }

  /**
   * Start monitoring
   */
  async start() {
    if (this.isRunning) return;

    this.logger.info('Starting CAWS monitoring system');

    try {
      // Load initial state
      await this.loadWorkingSpec();
      await this.calculateInitialState();

      // Start file watchers
      await this.startFileWatchers();

      // Start periodic checks
      this.startPeriodicChecks();

      this.isRunning = true;
      this.logger.info('CAWS monitoring system active');

      // Emit initial status
      this.emitStatusUpdate();
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to start monitoring');
      throw error;
    }
  }

  /**
   * Stop monitoring
   */
  async stop() {
    if (!this.isRunning) return;

    this.logger.info('Stopping CAWS monitoring system');

    // Stop file watchers
    for (const [path, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();

    // Clear intervals
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    this.isRunning = false;
    this.logger.info('CAWS monitoring system stopped');
  }

  /**
   * Load working specification
   */
  async loadWorkingSpec() {
    const specPath = '.caws/working-spec.yaml';

    try {
      if (await fs.pathExists(specPath)) {
        const content = await fs.readFile(specPath, 'utf8');
        this.workingSpec = yaml.load(content);

        // Extract budget information
        if (this.workingSpec?.change_budget) {
          this.budgets.set('files', {
            current: 0,
            limit: this.workingSpec.change_budget.max_files || 50,
            type: 'count',
          });
          this.budgets.set('loc', {
            current: 0,
            limit: this.workingSpec.change_budget.max_loc || 1000,
            type: 'lines',
          });
        }

        this.logger.info({ specId: this.workingSpec.id || 'unknown' }, 'Loaded working spec');
      } else {
        this.logger.warn('No working spec found');
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'Failed to load working spec');
    }
  }

  /**
   * Calculate initial state
   */
  async calculateInitialState() {
    await this.calculateBudgetUsage();
    await this.updateProgress();
  }

  /**
   * Start file watchers
   */
  async startFileWatchers() {
    const watchPaths = this.options.watchPaths.map((p) =>
      path.isAbsolute(p) ? p : path.join(process.cwd(), p)
    );

    const watcher = chokidar.watch(watchPaths, {
      ignored: [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/.git/**',
        '**/*.log',
        '**/coverage/**',
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 100,
      },
    });

    watcher.on('add', (filePath) => this.handleFileChange('add', filePath));
    watcher.on('change', (filePath) => this.handleFileChange('change', filePath));
    watcher.on('unlink', (filePath) => this.handleFileChange('remove', filePath));

    this.watchers.set('main', watcher);
  }

  /**
   * Start periodic checks
   */
  startPeriodicChecks() {
    this.checkInterval = setInterval(async () => {
      try {
        await this.checkForAlerts();
        this.emitStatusUpdate();
      } catch (error) {
        this.logger.error({ err: error }, 'Error in periodic check');
      }
    }, this.options.pollingInterval);
  }

  /**
   * Handle file changes
   */
  async handleFileChange(event, filePath) {
    this.logger.debug({ event, file: path.relative(process.cwd(), filePath) }, 'File changed');

    try {
      // Recalculate budgets and progress
      await this.calculateBudgetUsage();
      await this.updateProgress();

      // Check for alerts
      await this.checkForAlerts();

      // Emit update
      this.emitStatusUpdate();
    } catch (error) {
      this.logger.error({ err: error, file: filePath }, 'Error handling file change');
    }
  }

  /**
   * Calculate current budget usage
   */
  async calculateBudgetUsage() {
    const cwd = process.cwd();

    try {
      // Count files
      const fileCount = await this.countFiles(cwd);
      if (this.budgets.has('files')) {
        this.budgets.get('files').current = fileCount;
      }

      // Count lines of code
      const locCount = await this.countLinesOfCode(cwd);
      if (this.budgets.has('loc')) {
        this.budgets.get('loc').current = locCount;
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Error calculating budget usage');
    }
  }

  /**
   * Count files in project
   */
  async countFiles(dirPath) {
    let count = 0;

    async function countRecursive(currentPath) {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);

        // Skip ignored directories
        if (entry.isDirectory()) {
          if (!['node_modules', 'dist', 'build', '.git', 'coverage'].includes(entry.name)) {
            await countRecursive(fullPath);
          }
        } else if (entry.isFile()) {
          // Count source files
          const ext = path.extname(entry.name);
          if (
            [
              '.js',
              '.ts',
              '.jsx',
              '.tsx',
              '.vue',
              '.py',
              '.java',
              '.cpp',
              '.c',
              '.h',
              '.rs',
              '.go',
            ].includes(ext)
          ) {
            count++;
          }
        }
      }
    }

    await countRecursive(dirPath);
    return count;
  }

  /**
   * Count lines of code
   */
  async countLinesOfCode(dirPath) {
    let totalLines = 0;

    async function countRecursive(currentPath) {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          if (!['node_modules', 'dist', 'build', '.git', 'coverage'].includes(entry.name)) {
            await countRecursive(fullPath);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (
            [
              '.js',
              '.ts',
              '.jsx',
              '.tsx',
              '.vue',
              '.py',
              '.java',
              '.cpp',
              '.c',
              '.h',
              '.rs',
              '.go',
            ].includes(ext)
          ) {
            try {
              const content = await fs.readFile(fullPath, 'utf8');
              const lines = content.split('\n').length;
              totalLines += lines;
            } catch (error) {
              // Skip files that can't be read
            }
          }
        }
      }
    }

    await countRecursive(dirPath);
    return totalLines;
  }

  /**
   * Update progress tracking
   */
  async updateProgress() {
    if (!this.workingSpec?.acceptance) return;

    const progressUpdates = [];

    for (const criterion of this.workingSpec.acceptance) {
      const criterionId = criterion.id;
      const progress = await this.calculateCriterionProgress(criterion);

      this.progress.set(criterionId, progress);
      progressUpdates.push({ id: criterionId, progress });
    }

    if (progressUpdates.length > 0) {
      this.logger.info(
        { updates: progressUpdates.map((p) => ({ id: p.id, progress: `${p.progress}%` })) },
        'Progress updated'
      );
    }
  }

  /**
   * Calculate progress for a single acceptance criterion
   * Uses multiple signals: explicit completion status, test results, and file analysis
   */
  async calculateCriterionProgress(criterion) {
    // If criterion has explicit completion status, use that
    if (criterion.completed === true) {
      return 100;
    }
    if (criterion.completed === false) {
      // Still check for partial progress
    }
    if (typeof criterion.progress === 'number') {
      return criterion.progress;
    }

    let progress = 0;
    const criterionId = (criterion.id || '').toLowerCase();
    const criterionText = JSON.stringify(criterion).toLowerCase();

    try {
      // 1. Check for test results in coverage reports (40 points max)
      const testProgress = await this.checkTestProgress(criterionId, criterionText);
      progress += testProgress;

      // 2. Check for related implementation files (30 points max)
      const implProgress = await this.checkImplementationProgress(criterionId);
      progress += implProgress;

      // 3. Check for documentation (15 points max)
      const docProgress = await this.checkDocumentationProgress(criterionId);
      progress += docProgress;

      // 4. Check for related commits/changes (15 points max)
      const commitProgress = await this.checkCommitProgress(criterionId);
      progress += commitProgress;

    } catch (error) {
      this.logger.debug({ err: error }, 'Error calculating criterion progress');
      progress = 10; // Minimal progress if we can't analyze
    }

    return Math.min(100, Math.max(0, Math.round(progress)));
  }

  /**
   * Check test results for criterion-related tests
   */
  async checkTestProgress(criterionId, criterionText) {
    let testScore = 0;

    try {
      // Check for test coverage report
      const coveragePath = path.join(process.cwd(), 'coverage', 'coverage-summary.json');
      if (await fs.pathExists(coveragePath)) {
        const coverage = JSON.parse(await fs.readFile(coveragePath, 'utf8'));
        if (coverage.total && coverage.total.lines) {
          const lineCoverage = coverage.total.lines.pct || 0;
          testScore += Math.min(20, lineCoverage / 5); // Up to 20 points for 100% coverage
        }
      }

      // Check for test files related to this criterion
      const testDirs = ['tests', 'test', '__tests__', 'spec'];
      for (const testDir of testDirs) {
        if (await fs.pathExists(testDir)) {
          const testFiles = await this.findFilesRecursive(testDir, ['.test.', '.spec.', '_test.']);
          const relatedTests = testFiles.filter(
            (f) => f.toLowerCase().includes(criterionId) || criterionText.includes(path.basename(f, path.extname(f)))
          );
          if (relatedTests.length > 0) {
            testScore += 20; // Found related test files
            break;
          } else if (testFiles.length > 0) {
            testScore += 10; // Has tests but not specifically for this criterion
            break;
          }
        }
      }
    } catch (error) {
      this.logger.debug({ err: error }, 'Error checking test progress');
    }

    return Math.min(40, testScore);
  }

  /**
   * Check for implementation files related to criterion
   */
  async checkImplementationProgress(criterionId) {
    let implScore = 0;

    try {
      const srcDirs = ['src', 'lib', 'packages'];
      for (const srcDir of srcDirs) {
        if (await fs.pathExists(srcDir)) {
          implScore += 15; // Source directory exists

          // Check for files that might relate to this criterion
          const srcFiles = await this.findFilesRecursive(srcDir, ['.js', '.ts', '.jsx', '.tsx']);
          const relatedFiles = srcFiles.filter((f) => f.toLowerCase().includes(criterionId));
          if (relatedFiles.length > 0) {
            implScore += 15; // Found related implementation files
          }
          break;
        }
      }
    } catch (error) {
      this.logger.debug({ err: error }, 'Error checking implementation progress');
    }

    return Math.min(30, implScore);
  }

  /**
   * Check for documentation related to criterion
   */
  async checkDocumentationProgress(criterionId) {
    let docScore = 0;

    try {
      // Check README
      if (await fs.pathExists('README.md')) {
        const readme = await fs.readFile('README.md', 'utf8');
        if (readme.toLowerCase().includes(criterionId)) {
          docScore += 10;
        } else {
          docScore += 5;
        }
      }

      // Check docs directory
      if (await fs.pathExists('docs')) {
        docScore += 5;
      }
    } catch (error) {
      this.logger.debug({ err: error }, 'Error checking documentation progress');
    }

    return Math.min(15, docScore);
  }

  /**
   * Check git commits for criterion-related changes
   */
  async checkCommitProgress(criterionId) {
    let commitScore = 0;

    try {
      const { execSync } = await import('child_process');

      // Check for commits mentioning this criterion
      const commits = execSync(`git log --oneline --all --grep="${criterionId}" 2>/dev/null || true`, {
        encoding: 'utf8',
        cwd: process.cwd(),
      }).trim();

      if (commits) {
        const commitCount = commits.split('\n').filter(Boolean).length;
        commitScore = Math.min(15, commitCount * 5); // 5 points per commit, max 15
      }
    } catch (error) {
      // Git not available or not a repo
      this.logger.debug({ err: error }, 'Error checking commit progress');
    }

    return commitScore;
  }

  /**
   * Find files recursively matching patterns
   */
  async findFilesRecursive(dir, patterns, maxDepth = 3) {
    const results = [];

    async function scan(currentDir, depth) {
      if (depth > maxDepth) return;

      try {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name);
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            await scan(fullPath, depth + 1);
          } else if (entry.isFile()) {
            if (patterns.some((p) => entry.name.includes(p))) {
              results.push(fullPath);
            }
          }
        }
      } catch {
        // Ignore permission errors
      }
    }

    await scan(dir, 0);
    return results;
  }

  /**
   * Check for alerts
   */
  async checkForAlerts() {
    const newAlerts = [];

    // Check budget alerts
    for (const [budgetType, budget] of this.budgets) {
      const usageRatio = budget.current / budget.limit;

      if (usageRatio >= this.options.alertThresholds.budgetCritical) {
        newAlerts.push({
          type: 'budget_critical',
          severity: 'critical',
          message: `Budget critically exceeded: ${budgetType} at ${Math.round(usageRatio * 100)}% (${budget.current}/${budget.limit})`,
          budgetType,
          current: budget.current,
          limit: budget.limit,
          ratio: usageRatio,
        });
      } else if (usageRatio >= this.options.alertThresholds.budgetWarning) {
        newAlerts.push({
          type: 'budget_warning',
          severity: 'warning',
          message: `Budget warning: ${budgetType} at ${Math.round(usageRatio * 100)}% (${budget.current}/${budget.limit})`,
          budgetType,
          current: budget.current,
          limit: budget.limit,
          ratio: usageRatio,
        });
      }
    }

    // Check progress alerts
    const overallProgress = this.getOverallProgress();
    if (overallProgress < 25) {
      newAlerts.push({
        type: 'progress_stalled',
        severity: 'info',
        message: `Low progress detected: ${overallProgress}% overall completion`,
        overallProgress,
      });
    }

    // Add new alerts
    for (const alert of newAlerts) {
      // Avoid duplicate alerts
      const existingAlert = this.alerts.find(
        (a) => a.type === alert.type && a.budgetType === alert.budgetType
      );

      if (!existingAlert) {
        this.alerts.push({
          ...alert,
          timestamp: new Date(),
          id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        });

        this.logger.warn({ alert: alert.message, severity: alert.severity }, 'Alert triggered');
      }
    }
  }

  /**
   * Get overall progress
   */
  getOverallProgress() {
    if (this.progress.size === 0) return 0;

    const progresses = Array.from(this.progress.values());
    const average = progresses.reduce((sum, p) => sum + p, 0) / progresses.length;

    return Math.round(average);
  }

  /**
   * Emit status update
   */
  emitStatusUpdate() {
    const status = {
      timestamp: new Date(),
      budgets: Object.fromEntries(this.budgets),
      progress: Object.fromEntries(this.progress),
      overallProgress: this.getOverallProgress(),
      alerts: this.alerts.slice(-10), // Last 10 alerts
      workingSpec: this.workingSpec
        ? {
            id: this.workingSpec.id,
            title: this.workingSpec.title,
            riskTier: this.workingSpec.risk_tier,
          }
        : null,
    };

    // Status is available via getStatus() for clients to poll or
    // integrate with dashboards and notification systems.

    // Log status summary
    const budgets = Array.from(this.budgets.entries()).map(([type, budget]) => ({
      type,
      current: budget.current,
      limit: budget.limit,
    }));

    this.logger.debug(
      {
        budgets,
        progress: `${status.overallProgress}%`,
        activeAlerts: this.alerts.length,
      },
      'Status update emitted'
    );
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      budgets: Object.fromEntries(this.budgets),
      progress: Object.fromEntries(this.progress),
      overallProgress: this.getOverallProgress(),
      alerts: this.alerts,
      workingSpec: this.workingSpec,
    };
  }

  /**
   * Add custom alert
   */
  addAlert(alert) {
    this.alerts.push({
      ...alert,
      timestamp: new Date(),
      id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    });
  }
}

export { CawsMonitor };
