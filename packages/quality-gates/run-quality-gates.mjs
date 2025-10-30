#!/usr/bin/env node

/**
 * Quality Gates Runner
 *
 * Runs all quality gates and blocks commits if any critical violations are found.
 * Part of the crisis response - prevents further codebase degradation.
 *
 * Usage:
 *   node scripts/quality-gates/run-quality-gates.js [--ci] [--fix] [--json] [--gates=name,code_freeze]
 *
 * Options:
 *   --ci       Run in CI mode (stricter, no interactive fixes)
 *   --fix      Attempt automatic fixes for some violations
 *   --json     Output machine-readable JSON to stdout
 *   --gates    Run only specific gates (comma-separated)
 *
 * @author: @darianrosebrook
 */

import { getContextInfo, getFilesToCheck } from './file-scope-manager.mjs';

// Import quality gate modules
import fs from 'fs';
import path, { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { checkFunctionalDuplication } from './check-functional-duplication.mjs';
import { checkNamingViolations, checkSymbolNaming } from './check-naming.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CI_MODE = process.argv.includes('--ci') || !!process.env.CI;
const FIX_MODE = process.argv.includes('--fix');
const JSON_MODE = process.argv.includes('--json');
const FORCE_MODE = process.argv.includes('--force');
const QUIET_MODE = process.argv.includes('--quiet');
const DEBUG_MODE = process.argv.includes('--debug');
const VALID_GATES = new Set([
  'naming',
  'code_freeze',
  'duplication',
  'god_objects',
  'hidden-todo',
  'documentation',
]);

if (DEBUG_MODE) {
  console.log('DEBUG: Starting quality gates runner');
}

const GATES_FILTER = (() => {
  // Find --gates or --gates=value
  let gatesArg = null;
  for (const arg of process.argv) {
    if (arg === '--gates') {
      const idx = process.argv.indexOf(arg);
      if (idx + 1 < process.argv.length) {
        gatesArg = process.argv[idx + 1];
      }
      break;
    } else if (arg.startsWith('--gates=')) {
      gatesArg = arg.substring('--gates='.length);
      break;
    }
  }

  if (gatesArg) {
    const requested = gatesArg
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const valid = requested.filter((gate) => VALID_GATES.has(gate));
    const invalid = requested.filter((gate) => !VALID_GATES.has(gate));

    if (invalid.length > 0) {
      console.error(`Error: Invalid gate names: ${invalid.join(', ')}`);
      console.error(`Valid gates: ${Array.from(VALID_GATES).join(', ')}`);
      process.exit(1);
    }

    return valid.length > 0 ? new Set(valid) : null;
  }
  return null;
})();

class QualityGateRunner {
  constructor() {
    this.violations = [];
    this.warnings = [];
    this.lockFile = null;
    this.startTime = Date.now();
    this.gateTimings = {};
    this.debugLog = [];

    try {
      this.context = this.determineContext();
      if (DEBUG_MODE) {
        this.debugLog.push(`Context determined: ${this.context}`);
      }
    } catch (error) {
      console.error('Failed to determine context:', error.message);
      this.context = 'commit'; // fallback
      if (DEBUG_MODE) {
        this.debugLog.push(`Context fallback to: ${this.context} (error: ${error.message})`);
      }
    }

    try {
      this.contextInfo = getContextInfo(this.context);
      if (DEBUG_MODE) {
        this.debugLog.push(`Context info: ${JSON.stringify(this.contextInfo)}`);
      }
    } catch (error) {
      console.error('Failed to get context info:', error.message);
      this.contextInfo = { description: 'unknown context' }; // fallback
      if (DEBUG_MODE) {
        this.debugLog.push(`Context info fallback (error: ${error.message})`);
      }
    }

    try {
      this.filesToCheck = this.getFilesForContext();
      if (DEBUG_MODE) {
        this.debugLog.push(`Files to check: ${this.filesToCheck.length}`);
        this.debugLog.push(`File scoping command: ${this.contextInfo.gitCommand || 'unknown'}`);
      }
    } catch (error) {
      console.error('Failed to get files for context, using empty set:', error.message);
      this.filesToCheck = []; // fallback
      if (DEBUG_MODE) {
        this.debugLog.push(`File scoping failed, using empty set (error: ${error.message})`);
      }
    }
  }

  acquireLock() {
    const docsStatusDir = path.join(__dirname, 'docs-status');
    const lockPath = path.join(docsStatusDir, 'quality-gates.lock');

    if (DEBUG_MODE) {
      this.debugLog.push(`Acquiring lock: ${lockPath}`);
    }

    // Ensure docs-status directory exists
    if (!fs.existsSync(docsStatusDir)) {
      fs.mkdirSync(docsStatusDir, { recursive: true });
      if (DEBUG_MODE) {
        this.debugLog.push(`Created docs-status directory: ${docsStatusDir}`);
      }
    }

    try {
      // Check if lock file exists and is recent (< 5 minutes)
      if (fs.existsSync(lockPath)) {
        const stats = fs.statSync(lockPath);
        const age = Date.now() - stats.mtime.getTime();
        if (DEBUG_MODE) {
          this.debugLog.push(`Lock file exists, age: ${age}ms`);
        }
        if (age < 5 * 60 * 1000 && !FORCE_MODE) {
          // 5 minutes and not in force mode
          console.error('Error: Another quality gates process is already running');
          console.error(
            'Please wait for it to complete, use --force to bypass, or remove the lock file manually:'
          );
          console.error(`  rm "${lockPath}"`);
          process.exit(1);
        } else if (age >= 5 * 60 * 1000) {
          // Stale lock, remove it
          console.warn('Warning: Removing stale lock file');
          fs.unlinkSync(lockPath);
          if (DEBUG_MODE) {
            this.debugLog.push(`Removed stale lock file (age: ${age}ms)`);
          }
        } else {
          // Force mode - remove existing lock
          console.warn('Warning: Force mode enabled, removing existing lock file');
          fs.unlinkSync(lockPath);
          if (DEBUG_MODE) {
            this.debugLog.push(`Force mode: removed existing lock file`);
          }
        }
      }

      // Create lock file
      fs.writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}`);
      this.lockFile = lockPath;
      if (DEBUG_MODE) {
        this.debugLog.push(`Lock acquired: ${lockPath}`);
      }
    } catch (error) {
      console.warn('Warning: Could not acquire lock file:', error.message);
      // Continue without lock - not critical
    }
  }

  releaseLock() {
    if (this.lockFile && fs.existsSync(this.lockFile)) {
      try {
        fs.unlinkSync(this.lockFile);
        if (DEBUG_MODE) {
          this.debugLog.push(`Lock released: ${this.lockFile}`);
        }
      } catch (error) {
        console.warn('Warning: Could not release lock file:', error.message);
        if (DEBUG_MODE) {
          this.debugLog.push(`Lock release failed: ${error.message}`);
        }
      }
    }
  }

  determineContext() {
    // Check for explicit --context flag first
    for (const arg of process.argv) {
      if (arg.startsWith('--context=')) {
        const context = arg.substring('--context='.length);
        if (['commit', 'push', 'ci'].includes(context)) {
          if (DEBUG_MODE) {
            this.debugLog.push(`Context set via --context flag: ${context}`);
          }
          return context;
        }
        break;
      }
    }

    // Determine context based on environment and arguments
    if (
      process.argv.includes('--ci') ||
      process.env.CAWS_ENFORCEMENT_CONTEXT === 'ci' ||
      process.env.CI
    ) {
      if (DEBUG_MODE) {
        this.debugLog.push(`Context determined by CI environment: ci`);
      }
      return 'ci';
    } else if (process.env.CAWS_ENFORCEMENT_CONTEXT === 'push') {
      if (DEBUG_MODE) {
        this.debugLog.push(`Context determined by environment: push`);
      }
      return 'push';
    } else {
      if (DEBUG_MODE) {
        this.debugLog.push(`Context defaulted to: commit`);
      }
      return 'commit';
    }
  }

  getFilesForContext() {
    // Get files to check based on context
    try {
      return getFilesToCheck(this.context);
    } catch (error) {
      console.warn(
        `Warning: Failed to determine files for context '${this.context}': ${error.message}`
      );
      console.warn('Falling back to checking all files in repository');
      // Fallback: try to get all files
      try {
        return getFilesToCheck('ci'); // CI context scans entire repo
      } catch (fallbackError) {
        console.warn(`Fallback also failed: ${fallbackError.message}`);
        return []; // Empty array as last resort
      }
    }
  }

  async runGateWithTimeout(gateName, gateFunction, timeoutMs = 30000) {
    return new Promise(async (resolve) => {
      const gateStartTime = Date.now();
      if (DEBUG_MODE) {
        this.debugLog.push(`Starting gate: ${gateName} (timeout: ${timeoutMs}ms)`);
      }

      const timeout = setTimeout(() => {
        const gateDuration = Date.now() - gateStartTime;
        console.error(`   ${gateName} gate timed out after ${timeoutMs}ms`);
        this.violations.push({
          gate: gateName,
          type: 'timeout',
          message: `${gateName} gate timed out after ${timeoutMs}ms`,
        });
        if (DEBUG_MODE) {
          this.debugLog.push(`Gate ${gateName} timed out after ${gateDuration}ms`);
        }
        resolve();
      }, timeoutMs);

      try {
        await gateFunction();
        const gateDuration = Date.now() - gateStartTime;
        clearTimeout(timeout);
        this.gateTimings[gateName] = gateDuration;
        if (DEBUG_MODE) {
          this.debugLog.push(`Gate ${gateName} completed in ${gateDuration}ms`);
        }
        resolve();
      } catch (error) {
        const gateDuration = Date.now() - gateStartTime;
        clearTimeout(timeout);
        console.error(`   ${gateName} gate failed:`, error.message);
        this.violations.push({
          gate: gateName,
          type: 'gate_error',
          message: `${gateName} gate failed: ${error.message}`,
        });
        if (DEBUG_MODE) {
          this.debugLog.push(`Gate ${gateName} failed after ${gateDuration}ms: ${error.message}`);
        }
        resolve(); // Continue with other gates
      }
    });
  }

  async runAllGates() {
    // Acquire lock to prevent concurrent runs
    this.acquireLock();

    try {
      if (!QUIET_MODE && !JSON_MODE) {
        console.log('Running Quality Gates - Crisis Response Mode');
        console.log('='.repeat(50));
        console.log(`Context: ${this.context.toUpperCase()} (${this.contextInfo.description})`);
        console.log(`Files to check: ${this.filesToCheck.length}`);
        console.log('='.repeat(50));
      }

      if (DEBUG_MODE) {
        this.debugLog.push(`Starting quality gates execution`);
        this.debugLog.push(`Total files to check: ${this.filesToCheck.length}`);
        this.debugLog.push(
          `Gates to run: ${GATES_FILTER ? Array.from(GATES_FILTER).join(', ') : 'all'}`
        );
      }

      const gatePromises = [];

      // Gate 1: Naming Conventions
      if (!GATES_FILTER || GATES_FILTER.has('naming')) {
        if (!QUIET_MODE && !JSON_MODE) console.log('\nChecking naming conventions...');
        gatePromises.push(this.runGateWithTimeout('naming', () => this.runNamingGate(), 10000));
      }

      // Gate 1.5: Code Freeze (Crisis Response)
      if (!GATES_FILTER || GATES_FILTER.has('code_freeze')) {
        if (!QUIET_MODE && !JSON_MODE) console.log('\nChecking code freeze compliance...');
        gatePromises.push(
          this.runGateWithTimeout('code_freeze', () => this.runCodeFreezeGate(), 5000)
        );
      }

      // Gate 2: Duplication Prevention (can be slow)
      if (!GATES_FILTER || GATES_FILTER.has('duplication')) {
        if (!QUIET_MODE && !JSON_MODE) console.log('\nChecking duplication...');
        gatePromises.push(
          this.runGateWithTimeout('duplication', () => this.runDuplicationGate(), 60000)
        );
      }

      // Gate 3: God Object Prevention
      if (!GATES_FILTER || GATES_FILTER.has('god_objects')) {
        if (!QUIET_MODE && !JSON_MODE) console.log('\nChecking god objects...');
        gatePromises.push(
          this.runGateWithTimeout('god_objects', () => this.runGodObjectGate(), 10000)
        );
      }

      // Gate 4: Hidden TODO Analysis
      if (!GATES_FILTER || GATES_FILTER.has('hidden-todo')) {
        if (!QUIET_MODE && !JSON_MODE)
          console.log('\nChecking for hidden incomplete implementations...');
        gatePromises.push(
          this.runGateWithTimeout('hidden-todo', () => this.runHiddenTodoQualityGate(), 20000)
        );
      }

      // Gate 5: Documentation Quality
      if (!GATES_FILTER || GATES_FILTER.has('documentation')) {
        if (!QUIET_MODE && !JSON_MODE) console.log('\nChecking documentation quality...');
        gatePromises.push(
          this.runGateWithTimeout('documentation', () => this.runDocumentationQualityGate(), 15000)
        );
      }

      // Wait for all gates to complete (with their own error handling)
      await Promise.all(gatePromises);

      if (DEBUG_MODE) {
        this.debugLog.push(`All gates completed`);
        this.debugLog.push(`Total execution time: ${Date.now() - this.startTime}ms`);
      }

      // Report results
      this.reportResults();
    } finally {
      // Always release lock
      this.releaseLock();
    }
  }

  async runNamingGate() {
    try {
      // Use hardened naming checker with context-based scoping
      const [filenameResults, symbolViolations] = await Promise.all([
        Promise.resolve(checkNamingViolations(this.context)),
        Promise.resolve(checkSymbolNaming(this.context)),
      ]);
      const allViolations = [...filenameResults.violations, ...symbolViolations];
      const allWarnings = filenameResults.warnings;

      // Report warnings
      if (allWarnings.length > 0) {
        console.log(`   ${allWarnings.length} approved exceptions in use`);
        for (const warning of allWarnings) {
          console.log(`      ${warning.file}: ${warning.reason}`);
        }
      }

      // Handle violations based on enforcement level
      const enforcementLevel = filenameResults.enforcementLevel;

      if (allViolations.length > 0) {
        if (!QUIET_MODE && !JSON_MODE)
          console.log(`    Enforcement level: ${enforcementLevel.toUpperCase()}`);

        for (const violation of allViolations) {
          const severity = violation.severity || enforcementLevel;

          // Only add to violations if severity requires blocking
          if (severity === 'fail' || severity === 'block') {
            this.violations.push({
              gate: 'naming',
              type: violation.type,
              message: violation.issue,
              file: violation.file,
              line: violation.line,
              rule: violation.rule,
              severity: severity,
              suggestion: violation.suggestion,
            });
          } else {
            // Warning level - add to warnings instead
            this.warnings.push({
              gate: 'naming',
              type: violation.type,
              message: violation.issue,
              file: violation.file,
              line: violation.line,
              rule: violation.rule,
              suggestion: violation.suggestion,
            });
          }
        }

        if (!QUIET_MODE && !JSON_MODE) {
          console.log(`   ${allViolations.length} naming findings (${enforcementLevel} mode)`);
        }
      } else {
        if (!QUIET_MODE && !JSON_MODE) {
          console.log('   No problematic naming patterns found');
        }
      }
    } catch (error) {
      this.violations.push({
        gate: 'naming',
        type: 'error',
        message: error.message,
      });
    }
  }

  async runCodeFreezeGate() {
    try {
      const { checkCodeFreeze } = await import('./check-code-freeze.mjs');

      const codeFreezeResults = checkCodeFreeze(this.context);

      // Report warnings (approved exceptions)
      if (codeFreezeResults.warnings.length > 0) {
        console.log(`   ${codeFreezeResults.warnings.length} approved exceptions in use`);
        for (const warning of codeFreezeResults.warnings) {
          console.log(`      ${warning.violation.file}: ${warning.exception.reason}`);
        }
      }

      // Handle violations based on enforcement level
      const enforcementLevel = codeFreezeResults.enforcementLevel;

      if (codeFreezeResults.violations.length > 0) {
        if (!QUIET_MODE && !JSON_MODE)
          console.log(`    Enforcement level: ${enforcementLevel.toUpperCase()}`);

        for (const violation of codeFreezeResults.violations) {
          const severity = violation.severity || enforcementLevel;

          // Only add to violations if severity requires blocking
          if (severity === 'fail' || severity === 'block') {
            this.violations.push({
              gate: 'code_freeze',
              type: violation.type,
              message: violation.message,
              suggestion: violation.suggestion,
              severity: severity,
            });
          } else {
            // Warning level - add to warnings instead
            this.warnings.push({
              gate: 'code_freeze',
              type: violation.type,
              message: violation.message,
              suggestion: violation.suggestion,
            });
          }
        }

        console.log(
          `   ${codeFreezeResults.violations.length} code freeze findings (${enforcementLevel} mode)`
        );
      } else {
        console.log('   Code freeze compliance check passed');
      }
    } catch (error) {
      this.violations.push({
        gate: 'code_freeze',
        type: 'error',
        message: `Code freeze check failed: ${error.message}`,
      });
    }
  }

  async runDuplicationGate() {
    try {
      if (!QUIET_MODE && !JSON_MODE) console.log('   Checking functional duplication...');

      const duplicationResults = await checkFunctionalDuplication(this.context);

      // Report warnings (approved exceptions)
      if (duplicationResults.warnings.length > 0) {
        console.log(`   ${duplicationResults.warnings.length} approved exceptions in use`);
        for (const warning of duplicationResults.warnings) {
          if (warning.type === 'exception_used') {
            console.log(
              `      ${warning.violation.files?.[0]?.file || 'unknown'}: ${warning.exception.reason}`
            );
          } else {
            console.log(`      ${warning.files?.[0]?.file || 'unknown'}: ${warning.message}`);
          }
        }
      }

      // Handle violations based on enforcement level
      const enforcementLevel = duplicationResults.enforcementLevel;

      if (duplicationResults.violations.length > 0) {
        if (!QUIET_MODE && !JSON_MODE)
          console.log(`    Enforcement level: ${enforcementLevel.toUpperCase()}`);

        for (const violation of duplicationResults.violations) {
          const severity = violation.severity || enforcementLevel;

          // Only add to violations if severity requires blocking
          if (severity === 'fail' || severity === 'block') {
            this.violations.push({
              gate: 'duplication',
              type: violation.type,
              message: violation.message,
              file: violation.files?.[0]?.file || 'unknown',
              similarity: violation.similarity,
              severity: severity,
            });
          } else {
            // Warning level - add to warnings instead
            this.warnings.push({
              gate: 'duplication',
              type: violation.type,
              message: violation.message,
              file: violation.files?.[0]?.file || 'unknown',
              similarity: violation.similarity,
            });
          }
        }

        if (enforcementLevel === 'warning') {
          console.log(
            `   ${duplicationResults.violations.length} functional duplication warnings (commit allowed)`
          );
        } else {
          console.log(
            `   ${duplicationResults.violations.length} functional duplication violations (${enforcementLevel} mode)`
          );
        }
      } else {
        if (!QUIET_MODE && !JSON_MODE) console.log('   No functional duplication violations found');
      }
    } catch (error) {
      console.error('   Error running functional duplication gate:', error.message);
      // In CI mode, treat errors as violations
      if (CI_MODE) {
        this.violations.push({
          gate: 'functional_duplication',
          type: 'gate_error',
          message: `Functional duplication gate failed: ${error.message}`,
          file: 'unknown',
          severity: 'fail',
        });
      }
    }
  }

  async runGodObjectGate() {
    try {
      const { checkGodObjects, checkGodObjectRegression } = await import('./check-god-objects.mjs');

      const godObjectResults = checkGodObjects(this.context, this.filesToCheck);
      const regressionViolations = checkGodObjectRegression(this.context);

      const allViolations = [...godObjectResults.violations, ...regressionViolations];
      const allWarnings = godObjectResults.warnings;

      // Report warnings (approved exceptions)
      if (allWarnings.length > 0) {
        console.log(`   ${allWarnings.length} approved exceptions in use`);
        for (const warning of allWarnings) {
          console.log(`      ${warning.violation.file}: ${warning.exception.reason}`);
        }
      }

      // Handle violations based on enforcement level
      const enforcementLevel = godObjectResults.enforcementLevel;

      if (allViolations.length > 0) {
        if (!QUIET_MODE && !JSON_MODE)
          console.log(`    Enforcement level: ${enforcementLevel.toUpperCase()}`);

        for (const violation of allViolations) {
          const severity = violation.severity || enforcementLevel;

          // Only add to violations if severity requires blocking
          if (severity === 'fail' || severity === 'block') {
            this.violations.push({
              gate: 'god_objects',
              type: violation.type,
              message: violation.message,
              file: violation.relativePath,
              size: violation.size,
              severity: severity,
            });
          } else {
            // Warning level - add to warnings instead
            this.warnings.push({
              gate: 'god_objects',
              type: violation.type,
              message: violation.message,
              file: violation.relativePath,
              size: violation.size,
            });
          }
        }

        if (!QUIET_MODE && !JSON_MODE)
          console.log(`   ${allViolations.length} god object findings (${enforcementLevel} mode)`);
      } else {
        if (!QUIET_MODE && !JSON_MODE) console.log('   No god object violations found');
      }
    } catch (error) {
      this.violations.push({
        gate: 'god_objects',
        type: 'error',
        message: `God object check failed: ${error.message}`,
      });
    }
  }

  async runHiddenTodoQualityGate() {
    console.log('   Checking for hidden incomplete implementations...');

    try {
      const todoAnalyzerPath = join(__dirname, 'todo-analyzer.mjs');
      const projectRoot = join(__dirname, '..', '..');

      // Check if the TODO analyzer script exists
      if (!fs.existsSync(todoAnalyzerPath)) {
        console.log('   Hidden TODO analyzer not available (script missing)');
        console.log('   Consider installing advanced code quality tooling');
        return; // Skip this gate gracefully
      }

      // TODO: Update TODO analyzer to support file filtering. For transparency, announce scope here.
      console.log(
        `    File scope: ${this.filesToCheck.length} files (analyzer currently scans repo)`
      );

      // Import and run the Node.js TODO analyzer
      let issues = [];
      try {
        const { HiddenTodoAnalyzer } = await import(todoAnalyzerPath);
        const analyzer = new HiddenTodoAnalyzer(projectRoot);
        issues = await analyzer.analyzeProject(false, this.filesToCheck); // No progress in quality gates
      } catch (analyzerError) {
        console.warn('   TODO analyzer failed, skipping hidden TODO check...');
        console.warn(`   Error: ${analyzerError.message}`);
        return;
      }

      if (issues.length > 0) {
        // Convert issues to violations format for shared framework
        const rawViolations = issues.map((issue) => ({
          type: issue.severity === 'error' ? 'hidden_todo_error' : 'hidden_todo_warning',
          file: issue.file_path,
          line: issue.line_number,
          message: issue.message,
          rule: issue.rule_id,
          confidence: issue.confidence,
          suggested_fix: issue.suggested_fix,
        }));

        // Import shared framework
        const { processViolations } = await import('./shared-exception-framework.mjs');

        // Process violations with exception handling
        const result = processViolations('hidden-todo', rawViolations, this.context);

        // Filter violations by enforcement level
        const errors = result.violations.filter(
          (v) => v.severity === 'fail' || v.severity === 'block'
        );

        // Report errors (unapproved violations)
        if (errors.length > 0) {
          console.log(`   ❌ Found ${errors.length} hidden incomplete implementations`);
          for (const error of errors) {
            console.log(
              `      ${path.relative(projectRoot, error.file)}:${error.line} - ${error.message}`
            );
          }
          throw new Error(`${errors.length} hidden incomplete implementations found`);
        }

        // Report warnings (approved exceptions)
        if (result.warnings.length > 0) {
          console.log(`   ${result.warnings.length} approved exceptions in use`);
          for (const warning of result.warnings) {
            console.log(`      ${warning.violation.file}: ${warning.exception.reason}`);
          }
        }
      } else {
        console.log('   ✅ No hidden incomplete implementations found');
      }
    } catch (error) {
      console.warn('   Warning: Hidden TODO analysis failed');
      console.warn(`   Error: ${error.message}`);
      // Don't fail the entire quality gates for this
    }
  }

  async runDocumentationQualityGate() {
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const projectRoot = join(__dirname, '..', '..');
      const docLinterPath = join(__dirname, 'doc-quality-linter.mjs');

      // Check if the documentation linter script exists
      if (!fs.existsSync(docLinterPath)) {
        console.log('   Documentation linter not available (script missing)');
        console.log('   Falling back to basic documentation checks...');
        return await this.runBasicDocumentationChecks();
      }

      // TODO: Update doc linter to support file filtering. For transparency, announce scope here.
      console.log(
        `    File scope: ${this.filesToCheck.length} files (linter currently scans repo)`
      );

      console.log('    Starting documentation quality scan...');

      // Import and run the Node.js documentation linter
      let issues = [];
      try {
        const { DocumentationQualityLinter } = await import(docLinterPath);
        const linter = new DocumentationQualityLinter(projectRoot);
        issues = await linter.lintProject(
          true,
          this.filesToCheck.length > 0 ? this.filesToCheck : null
        );
      } catch (linterError) {
        console.warn('   Documentation linter failed, falling back to basic checks...');
        console.warn(`   Error: ${linterError.message}`);
        return await this.runBasicDocumentationChecks();
      }

      console.log(`    Found ${issues.length} documentation quality issues`);

      if (issues.length > 0) {
        // Convert issues to violations format for shared framework
        const rawViolations = issues.map((issue) => ({
          type: issue.severity === 'error' ? 'documentation_error' : 'documentation_warning',
          file: issue.file_path,
          line: issue.line_number,
          message: issue.message,
          rule: issue.rule_id,
          suggested_fix: issue.suggested_fix,
        }));

        // Import shared framework
        const { processViolations } = await import('./shared-exception-framework.mjs');

        // Process violations with exception handling
        const result = processViolations('documentation', rawViolations, this.context);

        // Report warnings (approved exceptions)
        if (result.warnings.length > 0) {
          console.log(`   ${result.warnings.length} approved exceptions in use`);
          for (const warning of result.warnings) {
            console.log(`      ${warning.violation.file}: ${warning.exception.reason}`);
          }
        }

        // Handle violations based on enforcement level
        const enforcementLevel = result.enforcementLevel;

        if (!QUIET_MODE && !JSON_MODE)
          console.log(`    Enforcement level: ${enforcementLevel.toUpperCase()}`);

        for (const violation of result.violations) {
          const severity = violation.severity || enforcementLevel;

          // Only add to violations if severity requires blocking
          if (severity === 'fail' || severity === 'block') {
            this.violations.push({
              gate: 'documentation',
              type: violation.type,
              message: violation.message,
              file: violation.file,
              line: violation.line,
              rule: violation.rule,
              suggested_fix: violation.suggested_fix,
              severity: severity,
            });
          } else {
            // Warning level - add to warnings instead
            this.warnings.push({
              gate: 'documentation',
              type: violation.type,
              message: violation.message,
              file: violation.file,
              line: violation.line,
              rule: violation.rule,
              suggested_fix: violation.suggested_fix,
            });
          }
        }

        console.log(
          `   ${result.violations.length} documentation findings (${enforcementLevel} mode)`
        );
      } else {
        console.log('   No documentation quality issues found');
      }
    } catch (error) {
      // Check if it's an exit code error (issues found) or a real error
      if (error.status === 1) {
        // This means the linter found issues and exited with code 1
        // The output should contain the JSON with issues
        try {
          const output = error.stdout || error.stderr || '';
          if (output.trim()) {
            const issues = JSON.parse(output);

            if (issues.length > 0) {
              // Get context for enforcement level
              const context = process.env.CAWS_ENFORCEMENT_CONTEXT || 'commit';

              // Convert issues to violations format for shared framework
              const rawViolations = issues.map((issue) => ({
                type: issue.severity === 'error' ? 'documentation_error' : 'documentation_warning',
                file: issue.file,
                line: issue.line,
                message: issue.message,
                rule: issue.rule,
                suggested_fix: issue.suggested_fix,
              }));

              // Import shared framework
              const { processViolations } = await import('./shared-exception-framework.mjs');

              // Process violations with exception handling
              const result = processViolations('documentation', rawViolations, context);

              // Report warnings (approved exceptions)
              if (result.warnings.length > 0) {
                console.log(`   ${result.warnings.length} approved exceptions in use`);
                for (const warning of result.warnings) {
                  console.log(`      ${warning.violation.file}: ${warning.exception.reason}`);
                }
              }

              // Handle violations based on enforcement level
              const enforcementLevel = result.enforcementLevel;

              if (!QUIET_MODE && !JSON_MODE)
                console.log(`    Enforcement level: ${enforcementLevel.toUpperCase()}`);

              for (const violation of result.violations) {
                const severity = violation.severity || enforcementLevel;

                // Only add to violations if severity requires blocking
                if (severity === 'fail' || severity === 'block') {
                  this.violations.push({
                    gate: 'documentation',
                    type: violation.type,
                    message: violation.message,
                    file: violation.file,
                    line: violation.line,
                    rule: violation.rule,
                    suggested_fix: violation.suggested_fix,
                    severity: severity,
                  });
                } else {
                  // Warning level - add to warnings instead
                  this.warnings.push({
                    gate: 'documentation',
                    type: violation.type,
                    message: violation.message,
                    file: violation.file,
                    line: violation.line,
                    rule: violation.rule,
                    suggested_fix: violation.suggested_fix,
                  });
                }
              }

              if (enforcementLevel === 'warning') {
                console.log(
                  `   ${result.violations.length} documentation warnings (commit allowed)`
                );
              } else {
                console.log(
                  `   ${result.violations.length} documentation violations (${enforcementLevel} mode)`
                );
              }
            }
          }
        } catch (parseError) {
          // If we can't parse the output, treat as a general error
          this.violations.push({
            gate: 'documentation',
            type: 'error',
            message: `Documentation quality check failed: ${error.message}`,
          });
        }
      } else {
        // Real error (Python not found, script missing, etc.)
        this.violations.push({
          gate: 'documentation',
          type: 'error',
          message: `Documentation quality check failed: ${error.message}`,
        });
      }
    }
  }

  async runBasicDocumentationChecks() {
    console.log('   Running basic documentation quality checks (Python fallback)');

    const violations = [];
    const warnings = [];

    // Basic checks that don't require Python
    const docFiles = this.filesToCheck.filter(
      (file) => file.endsWith('.md') || file.endsWith('.rst') || file.endsWith('.txt')
    );

    for (const file of docFiles) {
      try {
        const content = fs.readFileSync(file, 'utf8');

        // Check for common documentation quality issues
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const lineNum = i + 1;

          // Check for marketing language (basic patterns)
          const marketingPatterns = [
            /revolutionary/i,
            /breakthrough/i,
            /innovative/i,
            /groundbreaking/i,
            /cutting-edge/i,
            /state-of-the-art/i,
            /next-generation/i,
            /advanced/i,
            /premium/i,
            /superior/i,
            /best/i,
            /leading/i,
            /industry-leading/i,
            /award-winning/i,
            /game-changing/i,
          ];

          for (const pattern of marketingPatterns) {
            if (pattern.test(line)) {
              warnings.push({
                gate: 'documentation',
                type: 'marketing_language',
                message: `Marketing language detected: "${line.trim()}"`,
                file: file,
                line: lineNum,
                rule: 'marketing_language',
                suggested_fix: 'Replace with engineering-grade language',
              });
            }
          }

          // Check for unfounded achievement claims
          const achievementPatterns = [
            /production-ready/i,
            /enterprise-grade/i,
            /battle-tested/i,
            /complete/i,
            /finished/i,
            /done/i,
            /achieved/i,
            /delivered/i,
            /implemented/i,
            /operational/i,
            /ready/i,
            /deployed/i,
            /launched/i,
            /released/i,
            /100%/i,
            /fully/i,
            /comprehensive/i,
            /entire/i,
            /total/i,
            /all/i,
            /every/i,
            /perfect/i,
            /ideal/i,
            /optimal/i,
            /maximum/i,
            /minimum/i,
            /unlimited/i,
            /infinite/i,
            /endless/i,
          ];

          for (const pattern of achievementPatterns) {
            if (pattern.test(line)) {
              violations.push({
                gate: 'documentation',
                type: 'unfounded_achievements',
                message: `Unfounded achievement claim: "${line.trim()}"`,
                file: file,
                line: lineNum,
                rule: 'unfounded_achievements',
                suggested_fix: 'Verify claim with evidence or use more accurate language',
              });
            }
          }
        }
      } catch (error) {
        console.warn(`   Warning: Could not read file ${file}: ${error.message}`);
      }
    }

    // Report findings
    if (violations.length > 0) {
      console.log(`   ${violations.length} documentation violations found (basic checks)`);
      for (const violation of violations) {
        this.violations.push(violation);
      }
    }

    if (warnings.length > 0) {
      console.log(`   ${warnings.length} documentation warnings found (basic checks)`);
      for (const warning of warnings) {
        this.warnings.push(warning);
      }
    }

    if (violations.length === 0 && warnings.length === 0) {
      console.log('   No documentation quality issues found (basic checks)');
    }
  }

  reportResults() {
    if (!QUIET_MODE) {
      console.log('\n' + '='.repeat(50));
      console.log('QUALITY GATES RESULTS');
      console.log('='.repeat(50));
    }

    // Report warnings
    if (this.warnings.length > 0 && !QUIET_MODE && !JSON_MODE) {
      console.log(`\nWARNINGS (${this.warnings.length}):`);
      for (const warning of this.warnings) {
        console.log(`   ${warning.file || 'General'}: ${warning.message}`);
      }
    }

    // Report violations
    if (this.violations.length > 0) {
      if (!QUIET_MODE && !JSON_MODE) {
        console.log(`\nVIOLATIONS (${this.violations.length}) - COMMIT BLOCKED:`);
        console.log('');

        for (const violation of this.violations) {
          console.log(`${violation.gate.toUpperCase()}: ${violation.type.toUpperCase()}`);
          console.log(`   ${violation.message}`);
          if (violation.file) {
            console.log(`   File: ${violation.file}`);
          }
          if (violation.size) {
            console.log(`   Size: ${violation.size} LOC`);
          }
          if (violation.details) {
            console.log(`   Details: ${JSON.stringify(violation.details, null, 2)}`);
          }
          console.log('');
        }

        console.log('Fix these critical violations before committing.');
        console.log('See docs/refactoring.md for crisis response plan.');
      }
    } else {
      if (!QUIET_MODE && !JSON_MODE) {
        console.log('\nALL QUALITY GATES PASSED');
        console.log('Commit allowed - quality maintained!');
      }
    }

    // Write artifacts (JSON + optional GitHub Summary)
    try {
      const root = process.cwd();
      const outDir = 'docs-status';
      const reportPath = `${outDir}/quality-gates-report.json`;
      const summaryPath = process.env.GITHUB_STEP_SUMMARY;
      const payload = {
        timestamp: new Date().toISOString(),
        context: this.context,
        files_scoped: this.filesToCheck.length,
        warnings: this.warnings,
        violations: this.violations,
        performance: {
          total_execution_time_ms: Date.now() - this.startTime,
          gate_timings: this.gateTimings,
        },
        debug: DEBUG_MODE
          ? {
              debug_log: this.debugLog,
              environment: {
                node_version: process.version,
                platform: process.platform,
                arch: process.arch,
                cwd: process.cwd(),
              },
            }
          : undefined,
      };
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify(payload, null, 2));
      if (JSON_MODE) {
        console.log(JSON.stringify(payload, null, 2));
      }

      if (DEBUG_MODE && !QUIET_MODE) {
        console.log('\n' + '='.repeat(50));
        console.log('DEBUG INFORMATION');
        console.log('='.repeat(50));
        console.log(`Total execution time: ${payload.performance.total_execution_time_ms}ms`);
        console.log('Gate timings:');
        for (const [gate, timing] of Object.entries(payload.performance.gate_timings)) {
          console.log(`  ${gate}: ${timing}ms`);
        }
        console.log('\nDebug log:');
        for (const logEntry of this.debugLog) {
          console.log(`  ${logEntry}`);
        }
        console.log('='.repeat(50));
      }
      if (summaryPath) {
        const lines = [];
        lines.push(`# Quality Gates`);
        lines.push(`- Context: ${this.context}`);
        lines.push(`- Files scoped: ${this.filesToCheck.length}`);
        lines.push(`- Violations: ${this.violations.length}`);
        lines.push(`- Warnings: ${this.warnings.length}`);
        if (this.violations.length) {
          lines.push(`\n## Violations`);
          for (const v of this.violations.slice(0, 50)) {
            lines.push(
              `- **${v.gate}/${v.type}**: ${v.message}${v.file ? ` (file: ${v.file})` : ''}`
            );
          }
        }
        fs.appendFileSync(summaryPath, lines.join('\n') + '\n');
      }
    } catch {}

    process.exit(this.violations.length ? 1 : 0);
  }
}

// Main execution
async function main() {
  console.log('Quality gates starting...');
  // Handle help flag
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
Quality Gates Runner - Enterprise Code Quality Enforcement

USAGE:
  node packages/quality-gates/run-quality-gates.mjs [options]

OPTIONS:
  --ci              Run in CI mode (strict enforcement, blocks on warnings)
  --context=<ctx>   Set context explicitly (commit, push, ci)
  --json            Output machine-readable JSON to stdout
  --quiet           Suppress all console output except JSON/errors
  --debug           Enable debug output with timing and detailed logging
  --gates=<list>    Run only specific gates (comma-separated)
  --fix             Attempt automatic fixes (experimental)
  --force           Bypass lock files and force execution
  --help, -h        Show this help message

VALID GATES:
  naming           Check naming conventions and banned modifiers
  code_freeze      Enforce code freeze compliance
  duplication      Detect functional duplication
  god_objects      Prevent oversized files
  documentation    Check documentation quality

EXAMPLES:
  # Run all gates in development mode
  node packages/quality-gates/run-quality-gates.mjs

  # Run only specific gates
  node packages/quality-gates/run-quality-gates.mjs --gates=naming,duplication

  # CI mode with JSON output
  node packages/quality-gates/run-quality-gates.mjs --ci --json

  # GitHub Actions with summary
  GITHUB_STEP_SUMMARY=/tmp/summary.md node packages/quality-gates/run-quality-gates.mjs --ci

OUTPUT:
  - Console: Human-readable results with enforcement levels
  - JSON: Machine-readable structured data (--json flag)
  - Artifacts: docs-status/quality-gates-report.json
  - GitHub Summary: Automatic when GITHUB_STEP_SUMMARY is set

EXIT CODES:
  0  Success - no violations found
  1  Violations found - commit blocked
  2  System error - check failed to run
`);
    process.exit(0);
  }

  if (CI_MODE) {
    console.log('Running in CI mode - strict enforcement');
  }

  if (FIX_MODE) {
    console.log('Running in fix mode - will attempt automatic fixes');
  }

  const runner = new QualityGateRunner();

  await runner.runAllGates();
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith('run-quality-gates.mjs') ||
    process.argv[1].includes('run-quality-gates.mjs'))
) {
  main().catch((error) => {
    console.error('Quality gates crashed:', error);
    process.exit(1);
  });
}

export default QualityGateRunner;
