#!/usr/bin/env node

/**
 * Quality Gate: Simplification Detection
 *
 * Detects files where implementations have been replaced with stubs.
 * Catches when AI agents "simplify" real code down to pass/TODO/NotImplementedError.
 *
 * @author @darianrosebrook
 */

import { execFileSync } from 'child_process';
import path from 'path';
import { getFilesToCheck } from './file-scope-manager.mjs';
import { CODE_EXTENSIONS } from './language-support.mjs';

const STUB_PATTERNS = [
  /^\s*pass\s*$/m,
  /^\s*\.\.\.\s*$/m,
  /raise\s+NotImplementedError/,
  /throw\s+new\s+Error\s*\(\s*['"]not implemented['"]\s*\)/i,
  /\/\/\s*TODO\s*$/m,
  /#\s*TODO\s*$/m,
  /^\s*return\s*;\s*$/m,
  /^\s*return\s+None\s*$/m,
  /^\s*return\s+null\s*;\s*$/m,
  /^\s*return\s+undefined\s*;\s*$/m,
  /^\s*return\s+\{\}\s*;\s*$/m,
  /^\s*return\s+\[\]\s*;\s*$/m,
];

const LOC_DECREASE_THRESHOLD = 0.30; // 30% decrease

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    throw new Error(`Not a git repository: ${error.message}`);
  }
}

/**
 * Get file content at a specific git ref
 */
function getContentAtRef(root, ref, relPath) {
  try {
    return execFileSync('git', ['show', `${ref}:${relPath}`], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
  } catch {
    return null;
  }
}

/**
 * Get the staged version of a file (index)
 */
function getStagedContent(root, relPath) {
  return getContentAtRef(root, '', relPath);
}

/**
 * Get the HEAD version of a file
 */
function getHeadContent(root, relPath) {
  return getContentAtRef(root, 'HEAD', relPath);
}

/**
 * Resolve the merge base ref for push/ci contexts
 */
function resolveBaseRef(root) {
  // Try upstream tracking branch
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Fall through
  }
  // Try CI environment variables
  const envRef = process.env.GITHUB_BASE_REF || process.env.PR_BASE_REF || process.env.PR_BASE_SHA;
  if (envRef) return envRef;
  // Fallback to origin/HEAD
  try {
    return execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'origin/HEAD';
  }
}

/**
 * Get the merge base commit between current HEAD and a base ref
 */
function getMergeBase(root, baseRef) {
  try {
    return execFileSync('git', ['merge-base', baseRef, 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Count non-empty, non-comment lines
 */
function countLOC(content) {
  if (!content) return 0;
  return content
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) return false;
      return true;
    }).length;
}

/**
 * Count stub patterns in content
 */
function countStubs(content) {
  if (!content) return 0;
  let count = 0;
  for (const pattern of STUB_PATTERNS) {
    const matches = content.match(new RegExp(pattern.source, pattern.flags + 'g'));
    if (matches) count += matches.length;
  }
  return count;
}

/**
 * Check for simplification (stubbed-out implementations)
 * @param {string} context - Execution context
 * @returns {{ violations: Array, warnings: Array }}
 */
export function checkSimplification(context = 'commit') {
  const root = repoRoot();
  const files = getFilesToCheck(context);
  const violations = [];
  const warnings = [];

  // Determine comparison refs based on context:
  // - commit: compare HEAD (before) vs staged index (after)
  // - push/ci: compare merge-base (before) vs HEAD (after)
  let beforeRef, afterRef;
  if (context === 'commit') {
    beforeRef = 'HEAD';
    afterRef = ''; // empty string = staged index (`:path`)
  } else {
    const baseRef = resolveBaseRef(root);
    const mergeBase = getMergeBase(root, baseRef);
    beforeRef = mergeBase || baseRef;
    afterRef = 'HEAD';
  }

  const codeExts = CODE_EXTENSIONS;

  // For push/ci contexts, build a rename map so we can detect renamed-and-simplified files
  const renameMap = new Map(); // new path -> old path
  if (context !== 'commit') {
    try {
      const diffOutput = execFileSync('git', [
        'diff', '--name-status', '--find-renames', '-z', `${beforeRef}...HEAD`,
      ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const parts = diffOutput.split('\0').filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        const status = parts[i];
        if (status.startsWith('R')) {
          // Rename: status, old path, new path
          const oldPath = parts[++i];
          const newPath = parts[++i];
          if (oldPath && newPath) renameMap.set(newPath, oldPath);
        } else if (status.length === 1) {
          i++; // skip the path for A, M, D, etc.
        }
      }
    } catch {
      // If rename detection fails, continue without it
    }
  }

  for (const absPath of files) {
    const rel = path.relative(root, absPath);
    const ext = path.extname(rel);

    if (!codeExts.has(ext)) continue;

    // For renamed files, look up the old path for the "before" content
    const beforePath = renameMap.get(rel) || rel;
    const beforeContent = getContentAtRef(root, beforeRef, beforePath);
    const afterContent = getContentAtRef(root, afterRef, rel);

    // Skip new files (no before version)
    if (!beforeContent) continue;
    // Skip deleted files
    if (!afterContent) continue;

    const beforeLOC = countLOC(beforeContent);
    const afterLOC = countLOC(afterContent);

    // Skip tiny files
    if (beforeLOC < 10) continue;

    const decrease = (beforeLOC - afterLOC) / beforeLOC;
    const afterStubs = countStubs(afterContent);
    const beforeStubs = countStubs(beforeContent);
    const newStubs = afterStubs - beforeStubs;

    // Simplification: LOC decreased significantly AND new stubs appeared
    if (decrease >= LOC_DECREASE_THRESHOLD && newStubs > 0) {
      const renamedNote = renameMap.has(rel) ? ` (renamed from ${renameMap.get(rel)})` : '';
      violations.push({
        type: 'simplification',
        file: rel,
        issue: `LOC decreased ${Math.round(decrease * 100)}% (${beforeLOC} → ${afterLOC}) with ${newStubs} new stub(s)${renamedNote}`,
        rule: 'Do not replace implementations with stubs. Modify existing code, do not simplify to placeholders.',
        severity: 'block',
        details: {
          beforeLOC,
          afterLOC,
          decrease: Math.round(decrease * 100),
          newStubs,
          renamedFrom: renameMap.get(rel) || null,
        },
      });
    } else if (decrease >= LOC_DECREASE_THRESHOLD) {
      // Large decrease without stubs is still suspicious
      warnings.push({
        type: 'large_deletion',
        file: rel,
        issue: `LOC decreased ${Math.round(decrease * 100)}% (${beforeLOC} → ${afterLOC})`,
        rule: 'Large code deletions should be reviewed carefully.',
      });
    }
  }

  return { violations, warnings };
}

/* ----------------------- CLI ----------------------- */

function main() {
  const context = process.argv[2] || 'commit';
  const result = checkSimplification(context);

  if (result.warnings.length) {
    console.log(`Warnings: ${result.warnings.length}`);
    for (const w of result.warnings) {
      console.log(`  - ${w.file}: ${w.issue}`);
    }
  }

  if (result.violations.length) {
    console.log(`\nBlocking violations: ${result.violations.length}`);
    for (const v of result.violations) {
      console.log(`  - ${v.file}: ${v.issue}`);
      if (v.rule) console.log(`    Rule: ${v.rule}`);
    }
    process.exit(1);
  }

  console.log('No simplification violations.');
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
