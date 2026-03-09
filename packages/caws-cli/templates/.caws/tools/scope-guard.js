#!/usr/bin/env node

/**
 * @fileoverview CAWS Scope Guard (file-level)
 * Checks whether a given file path is within scope of active specs.
 * Used by Cursor hooks for scope validation on file attachments.
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');

/**
 * Convert a glob pattern to a RegExp, handling **, *, ?, [abc], {a,b}
 */
function globToRegex(pattern) {
  let i = 0, re = '';
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*'; i += 2;
      if (pattern[i] === '/') i++; // skip trailing slash after **
    } else if (c === '*') {
      re += '[^/]*'; i++;
    } else if (c === '?') {
      re += '[^/]'; i++;
    } else if (c === '[') {
      const end = pattern.indexOf(']', i);
      if (end > i) { re += pattern.slice(i, end + 1); i = end + 1; }
      else { re += '\\['; i++; }
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end > i) {
        const alts = pattern.slice(i + 1, end).split(',').map(a => a.trim());
        re += '(?:' + alts.join('|') + ')'; i = end + 1;
      } else { re += '\\{'; i++; }
    } else if ('.+^$|()'.includes(c)) {
      re += '\\' + c; i++;
    } else {
      re += c; i++;
    }
  }
  return new RegExp(re);
}

const TERMINAL = new Set(['completed', 'closed', 'archived']);

/**
 * Check if a file is within scope of active specs.
 * @param {string} filePath - Relative path from project root
 * @param {string} projectDir - Project root directory
 * @returns {{inScope: boolean, reason: string}}
 */
function checkFileScope(filePath, projectDir) {
  // Smart allowlist: root-level files, .caws/, .claude/ always pass
  if (!filePath.includes('/') || filePath.startsWith('.caws/') || filePath.startsWith('.claude/')) {
    return { inScope: true, reason: 'allowlisted path' };
  }

  const specFile = path.join(projectDir, '.caws/working-spec.yaml');
  const specsDir = path.join(projectDir, '.caws/specs');

  if (!fs.existsSync(specFile) && !fs.existsSync(specsDir)) {
    return { inScope: true, reason: 'no specs found' };
  }

  // Load all active specs
  let yaml;
  try { yaml = require('js-yaml'); } catch (_) {
    return { inScope: true, reason: 'js-yaml not available' };
  }

  const specs = [];

  if (fs.existsSync(specFile)) {
    try {
      const s = yaml.load(fs.readFileSync(specFile, 'utf8'));
      if (s && !TERMINAL.has(s.status)) {
        specs.push({ source: 'working-spec', spec: s });
      }
    } catch (_) {}
  }

  if (fs.existsSync(specsDir)) {
    for (const f of fs.readdirSync(specsDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))) {
      try {
        const s = yaml.load(fs.readFileSync(path.join(specsDir, f), 'utf8'));
        if (s && !TERMINAL.has(s.status)) {
          specs.push({ source: f, spec: s });
        }
      } catch (_) {}
    }
  }

  if (specs.length === 0) {
    return { inScope: true, reason: 'no active specs' };
  }

  // Check scope.out — any match blocks
  for (const { source, spec } of specs) {
    for (const pattern of (spec.scope?.out || [])) {
      if (globToRegex(pattern).test(filePath)) {
        return { inScope: false, reason: `out-of-scope in ${source} (pattern: ${pattern})` };
      }
    }
  }

  // Union all scope.in — must match at least one
  const allIn = specs.flatMap(({ spec }) => spec.scope?.in || []);
  if (allIn.length > 0) {
    const found = allIn.some(pattern => globToRegex(pattern).test(filePath));
    if (!found) {
      return { inScope: false, reason: 'not in any active spec scope.in' };
    }
  }

  return { inScope: true, reason: 'in scope' };
}

// CLI interface
if (require.main === module) {
  const command = process.argv[2];
  const filePath = process.argv[3];

  if (command === 'check' && filePath) {
    // Resolve relative to cwd
    const projectDir = process.cwd();
    const rel = filePath.startsWith(projectDir)
      ? filePath.slice(projectDir.length + 1)
      : filePath;

    const result = checkFileScope(rel, projectDir);
    if (result.inScope) {
      console.log(`in_scope: ${result.reason}`);
      process.exit(0);
    } else {
      console.error(`out_of_scope: ${result.reason}`);
      process.exit(1);
    }
  } else {
    console.log('CAWS Scope Guard');
    console.log('Usage:');
    console.log('  node scope-guard.js check <file-path>');
    console.log('');
    console.log('Examples:');
    console.log('  node scope-guard.js check src/index.js');
    console.log('  node scope-guard.js check packages/cli/lib/main.ts');
    process.exit(1);
  }
}

module.exports = { checkFileScope, globToRegex };
