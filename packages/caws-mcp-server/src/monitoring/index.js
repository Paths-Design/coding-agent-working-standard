/**
 * @fileoverview CAWS Monitoring System
 * Real-time monitoring of contracts, artifacts, budgets, and agent behavior
 * Provides alerts, progress tracking, and dashboard updates
 * @author @darianrosebrook
 */

import fs from 'fs-extra';
import path from 'path';
import chokidar from 'chokidar';
import yaml from 'js-yaml';

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

    console.log('🔍 Starting CAWS monitoring system...');

    try {
      // Load initial state
      await this.loadWorkingSpec();
      await this.calculateInitialState();

      // Start file watchers
      await this.startFileWatchers();

      // Start periodic checks
      this.startPeriodicChecks();

      this.isRunning = true;
      console.log('✅ CAWS monitoring system active');

      // Emit initial status
      this.emitStatusUpdate();

    } catch (error) {
      console.error('❌ Failed to start monitoring:', error.message);
      throw error;
    }
  }

  /**
   * Stop monitoring
   */
  async stop() {
    if (!this.isRunning) return;

    console.log('🛑 Stopping CAWS monitoring system...');

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
    console.log('✅ CAWS monitoring system stopped');
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

        console.log(`📋 Loaded working spec: ${this.workingSpec.id || 'unknown'}`);
      } else {
        console.log('⚠️ No working spec found');
      }
    } catch (error) {
      console.warn('⚠️ Failed to load working spec:', error.message);
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
    const watchPaths = this.options.watchPaths.map(p =>
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
        console.error('❌ Error in periodic check:', error.message);
      }
    }, this.options.pollingInterval);
  }

  /**
   * Handle file changes
   */
  async handleFileChange(event, filePath) {
    console.log(`📁 File ${event}: ${path.relative(process.cwd(), filePath)}`);

    try {
      // Recalculate budgets and progress
      await this.calculateBudgetUsage();
      await this.updateProgress();

      // Check for alerts
      await this.checkForAlerts();

      // Emit update
      this.emitStatusUpdate();

    } catch (error) {
      console.error('❌ Error handling file change:', error.message);
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
      console.error('❌ Error calculating budget usage:', error.message);
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
          if (['.js', '.ts', '.jsx', '.tsx', '.vue', '.py', '.java', '.cpp', '.c', '.h', '.rs', '.go'].includes(ext)) {
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
          if (['.js', '.ts', '.jsx', '.tsx', '.vue', '.py', '.java', '.cpp', '.c', '.h', '.rs', '.go'].includes(ext)) {
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
      console.log('📊 Progress updated:', progressUpdates.map(p => `${p.id}: ${p.progress}%`).join(', '));
    }
  }

  /**
   * Calculate progress for a single acceptance criterion
   */
  async calculateCriterionProgress(criterion) {
    // This is a simplified implementation - in practice, you'd parse test results,
    // check for implemented features, etc.
    // For now, we'll use a mock progress calculation

    const criterionText = JSON.stringify(criterion).toLowerCase();

    // Mock progress based on file existence and content patterns
    let progress = 0;

    try {
      // Check if related files exist
      const files = await fs.readdir(process.cwd());
      const relevantFiles = files.filter(file =>
        file.includes('test') || file.includes('spec') || file.includes(criterion.id.toLowerCase())
      );

      if (relevantFiles.length > 0) progress += 30;

      // Check if tests directory exists
      if (await fs.pathExists('tests') || await fs.pathExists('test')) progress += 20;

      // Check if implementation files exist
      if (await fs.pathExists('src') || await fs.pathExists('lib')) progress += 25;

      // Check for documentation
      if (await fs.pathExists('README.md') || await fs.pathExists('docs')) progress += 25;

    } catch (error) {
      // If we can't read files, assume minimal progress
      progress = 10;
    }

    return Math.min(100, Math.max(0, progress));
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
      const existingAlert = this.alerts.find(a =>
        a.type === alert.type && a.budgetType === alert.budgetType
      );

      if (!existingAlert) {
        this.alerts.push({
          ...alert,
          timestamp: new Date(),
          id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        });

        console.log(`🚨 Alert: ${alert.message}`);
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
      workingSpec: this.workingSpec ? {
        id: this.workingSpec.id,
        title: this.workingSpec.title,
        riskTier: this.workingSpec.risk_tier,
      } : null,
    };

    // In a real implementation, this would emit to connected clients,
    // update dashboards, send notifications, etc.
    console.log('📊 Status update emitted');

    // For now, we'll just log a summary
    const budgetSummary = Array.from(this.budgets.entries())
      .map(([type, budget]) => `${type}: ${budget.current}/${budget.limit}`)
      .join(', ');

    console.log(`   Budget: ${budgetSummary}`);
    console.log(`   Progress: ${status.overallProgress}%`);
    console.log(`   Alerts: ${this.alerts.length} active`);
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
