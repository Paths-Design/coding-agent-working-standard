#!/usr/bin/env node

/**
 * Documentation Quality Linter (Node.js)
 *
 * Automatically detects and reports documentation quality issues including:
 * - Superiority claims and marketing language
 * - Unfounded achievement claims
 * - Temporal documentation in wrong locations
 * - Emoji usage (except approved ones)
 */

import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getFilesToCheck } from './file-scope-manager.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class QualityIssue {
  constructor(file_path, line_number, severity, rule_id, message, suggested_fix = '') {
    this.file_path = file_path;
    this.line_number = line_number;
    this.severity = severity;
    this.rule_id = rule_id;
    this.message = message;
    this.suggested_fix = suggested_fix;
  }
}

class DocumentationQualityLinter {
  constructor(projectRoot = '.') {
    this.projectRoot = path.resolve(projectRoot);

    // Pre-compile combined regex patterns for better performance
    // Single patterns are faster than multiple tests per line
    this.superiorityPattern = /\b(revolutionary|breakthrough|innovative|groundbreaking|cutting-edge|state-of-the-art|next-generation|advanced|premium|superior|best|leading|industry-leading|award-winning|game-changing)\b/i;
    
    this.achievementPattern = /\b(production-ready|enterprise-grade|battle-tested|complete|finished|done|achieved|delivered|implemented|operational|ready|deployed|launched|released|100%|fully|comprehensive|entire|total|all|every|perfect|ideal|optimal|maximum|minimum|unlimited|infinite|endless)\b/i;

    this.temporalPatterns = [
      /SESSION_.*_SUMMARY\.md/i,
      /IMPLEMENTATION_STATUS\.md/i,
      /TODO_.*_COMPLETE\.md/i,
      /.*_SUMMARY\.md/i,
      /.*_REPORT\.md/i,
      /.*_AUDIT\.md/i,
      /.*_CHECKLIST\.md/i,
      /PHASE.*\.md/i,
      /NEXT_ACTIONS\.md/i,
    ];

    // Define allowed locations for temporal docs
    this.temporalAllowedDirs = [
      'docs/archive/',
      'docs/archive/session-reports/',
      'docs/archive/implementation-tracking/',
      'docs/archive/project-docs/',
      'docs/archive/summaries/',
      'docs/archive/security-audits/',
      'docs/archive/deployment-readiness/',
      'docs/archive/multimodal-rag/',
      'docs/archive/aspirational/',
      'docs/archive/misleading-claims/',
    ];
  }

  async lintFile(filePath) {
    const issues = [];

    try {
      const content = await fsPromises.readFile(filePath, 'utf8');
      const lines = content.split('\n');

      // Check for superiority claims and achievement claims (optimized single-pass)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;

        // Check superiority claims (single pattern test)
        if (this.superiorityPattern.test(line)) {
          const match = line.match(this.superiorityPattern);
          issues.push(
            new QualityIssue(
              filePath,
              lineNum,
              'error',
              'SUPERIORITY_CLAIM',
              `Superiority claim detected: '${match ? match[0] : line.trim()}'`,
              'Remove marketing language and focus on technical capabilities'
            )
          );
        }

        // Check for unfounded achievement claims (single pattern test)
        if (this.achievementPattern.test(line)) {
          const match = line.match(this.achievementPattern);
          issues.push(
            new QualityIssue(
              filePath,
              lineNum,
              'warning',
              'UNFOUNDED_ACHIEVEMENT',
              `Unfounded achievement claim detected: '${match ? match[0] : line.trim()}'`,
              'Verify claim with evidence or use more accurate language'
            )
          );
        }
      }

      // Check for temporal documentation in wrong locations
      if (filePath.endsWith('.md')) {
        for (const pattern of this.temporalPatterns) {
          if (pattern.test(path.basename(filePath))) {
            // Check if file is in allowed directory
            const allowed = this.temporalAllowedDirs.some((allowedDir) =>
              filePath.includes(allowedDir)
            );

            if (!allowed) {
              issues.push(
                new QualityIssue(
                  filePath,
                  0,
                  'error',
                  'TEMPORAL_DOC_WRONG_LOCATION',
                  `Temporal documentation '${path.basename(filePath)}' in wrong location`,
                  'Move to appropriate archive directory (docs/archive/)'
                )
              );
            }
          }
        }
      }

      // Check for emoji usage (except approved ones)
      const approvedEmojis = ['⚠️', '✅', '🚫'];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;

        // Find all emojis in the line
        const emojiPattern =
          /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F018}-\u{1F0F5}\u{1F200}-\u{1F2FF}]/gu;
        const emojis = line.match(emojiPattern) || [];

        for (const emoji of emojis) {
          if (!approvedEmojis.includes(emoji)) {
            issues.push(
              new QualityIssue(
                filePath,
                lineNum,
                'warning',
                'EMOJI_USAGE',
                `Emoji usage detected: '${emoji}' in '${line.trim()}'`,
                'Remove emoji or use approved emojis only (⚠️, ✅, 🚫)'
              )
            );
          }
        }
      }
    } catch (error) {
      issues.push(
        new QualityIssue(
          filePath,
          0,
          'error',
          'FILE_READ_ERROR',
          `Could not read file: ${error.message}`,
          'Check file permissions and encoding'
        )
      );
    }

    return issues;
  }

  async lintProject(showProgress = true, scopedFiles = null) {
    const allIssues = [];

    // Early return if no files to check - prevents unnecessary full repo scan
    if (!scopedFiles || scopedFiles.length === 0) {
      if (showProgress) {
        console.error('   No files to check, skipping documentation quality scan');
      }
      return allIssues;
    }

    // Use scoped files if provided, otherwise use file-scope-manager to get all files
    let filesToLint = [];
    const docExtensions = ['.md', '.txt', '.rst', '.adoc'];

    // Filter scoped files to only documentation files
    // file-scope-manager already handles .gitignore filtering
    filesToLint = scopedFiles.filter((file) =>
      docExtensions.includes(path.extname(file).toLowerCase())
    );
    
    if (showProgress) {
      console.error(`   Found ${filesToLint.length} documentation files in scope (respecting .gitignore)`);
    }

    // Early return if no documentation files found
    if (filesToLint.length === 0) {
      if (showProgress) {
        console.error('   No documentation files found in scope');
      }
      return allIssues;
    }

    const totalFiles = filesToLint.length;

    if (showProgress && totalFiles > 0) {
      console.error(`Scanning ${totalFiles} documentation files...`);
    }

    // Process files in parallel batches for better performance
    const batchSize = 8; // Process 8 files concurrently
    let processedCount = 0;

    for (let batchStart = 0; batchStart < filesToLint.length; batchStart += batchSize) {
      const batchEnd = Math.min(batchStart + batchSize, filesToLint.length);
      const batch = filesToLint.slice(batchStart, batchEnd);

      // Process batch in parallel with timeout protection
      const batchPromises = batch.map((filePath) => 
        Promise.race([
          this.lintFile(filePath),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Timeout reading ${filePath} (5s limit)`)), 5000)
          )
        ]).catch((error) => {
          // Return error as issue instead of failing entire batch
          return [new QualityIssue(
            filePath,
            0,
            'error',
            'FILE_READ_ERROR',
            error.message.includes('Timeout') 
              ? `File read timeout: ${error.message}`
              : `Could not read file: ${error.message}`,
            'Check file size and permissions'
          )];
        })
      );
      const batchResults = await Promise.allSettled(batchPromises);

      // Collect results
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          allIssues.push(...result.value);
        } else {
          console.error(`Failed to process file: ${result.reason}`);
        }
      }

      processedCount += batch.length;

      // Show progress after each batch
      if (showProgress) {
        const percent = (processedCount / totalFiles) * 100;
        console.error(
          `Progress: ${processedCount}/${totalFiles} files (${percent.toFixed(1)}%) - ${allIssues.length} issues found`
        );
      }
    }

    if (showProgress) {
      console.error(`Scan complete: ${allIssues.length} total issues in ${totalFiles} files`);
    }

    return allIssues;
  }

  generateReport(issues, outputFormat = 'text') {
    if (outputFormat === 'json') {
      return JSON.stringify(
        issues.map((issue) => ({
          file: issue.file_path,
          line: issue.line_number,
          severity: issue.severity,
          rule: issue.rule_id,
          message: issue.message,
          suggested_fix: issue.suggested_fix,
        })),
        null,
        2
      );
    }

    if (!issues.length) {
      return '✅ No documentation quality issues found!';
    }

    const report = [];
    report.push('📋 Documentation Quality Report');
    report.push('='.repeat(50));

    // Group by severity
    const errors = issues.filter((i) => i.severity === 'error');
    const warnings = issues.filter((i) => i.severity === 'warning');

    if (errors.length) {
      report.push(`\n❌ ERRORS (${errors.length}):`);
      for (const issue of errors.slice(0, 10)) {
        // Show first 10
        report.push(
          `  ${path.relative(this.projectRoot, issue.file_path)}:${issue.line_number} - ${issue.message}`
        );
        if (issue.suggested_fix) {
          report.push(`    💡 ${issue.suggested_fix}`);
        }
      }
      if (errors.length > 10) {
        report.push(`  ... and ${errors.length - 10} more errors`);
      }
    }

    if (warnings.length) {
      report.push(`\n⚠️  WARNINGS (${warnings.length}):`);
      for (const issue of warnings.slice(0, 10)) {
        // Show first 10
        report.push(
          `  ${path.relative(this.projectRoot, issue.file_path)}:${issue.line_number} - ${issue.message}`
        );
        if (issue.suggested_fix) {
          report.push(`    💡 ${issue.suggested_fix}`);
        }
      }
      if (warnings.length > 10) {
        report.push(`  ... and ${warnings.length - 10} more warnings`);
      }
    }

    return report.join('\n');
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  let pathArg = '.';
  let formatArg = 'text';
  let exitCode = false;
  let showProgress = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--path' && i + 1 < args.length) {
      pathArg = args[i + 1];
      i++;
    } else if (arg === '--format' && i + 1 < args.length) {
      formatArg = args[i + 1];
      i++;
    } else if (arg === '--exit-code') {
      exitCode = true;
    } else if (arg === '--no-progress') {
      showProgress = false;
    }
  }

  const linter = new DocumentationQualityLinter(pathArg);
  const issues = await linter.lintProject(showProgress);
  const report = linter.generateReport(issues, formatArg);

  console.log(report);

  if (exitCode && issues.length > 0) {
    // Exit with error code if there are errors or too many warnings
    const errors = issues.filter((i) => i.severity === 'error');
    const warnings = issues.filter((i) => i.severity === 'warning');

    if (errors.length > 0 || warnings.length > 10) {
      process.exit(1);
    }
  }

  process.exit(0);
}

// Run if called directly
if (
  process.argv[1] &&
  (process.argv[1].endsWith('doc-quality-linter.mjs') ||
    process.argv[1].includes('doc-quality-linter.mjs'))
) {
  main().catch((error) => {
    console.error('Documentation linter crashed:', error);
    process.exit(1);
  });
}

// Export main for testing
export { DocumentationQualityLinter, QualityIssue, main as runCLI };
