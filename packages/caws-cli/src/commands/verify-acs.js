/**
 * @fileoverview Verify Acceptance Criteria Command
 * Mechanically verifies that ACs in CAWS specs are backed by real test evidence.
 * Language-agnostic: detects test runner from project structure.
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const { execFileSync } = require('child_process');
const { findProjectRoot } = require('../utils/detection');
const { resolveSpec } = require('../utils/spec-resolver');
const { recordACVerification } = require('../utils/working-state');
const { appendEvent } = require('../utils/event-log');

/**
 * Detect the project's test runner from config files.
 * Returns a runner ID used to determine collect/run commands.
 * @param {string} projectRoot
 * @returns {'pytest'|'jest'|'vitest'|'cargo'|'go'|'unknown'}
 */
function detectTestRunner(projectRoot) {
  const checks = [
    { files: ['pytest.ini', 'conftest.py', 'setup.cfg'], content: [['pyproject.toml', '[tool.pytest']], runner: 'pytest' },
    { files: ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts'], runner: 'vitest' },
    { files: ['jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.cjs'], content: [['package.json', '"jest"']], runner: 'jest' },
    { files: ['Cargo.toml'], runner: 'cargo' },
    { files: ['go.mod'], runner: 'go' },
  ];

  for (const check of checks) {
    for (const f of (check.files || [])) {
      if (fs.existsSync(path.join(projectRoot, f))) return check.runner;
    }
    for (const [f, needle] of (check.content || [])) {
      const fp = path.join(projectRoot, f);
      if (fs.existsSync(fp)) {
        try {
          if (fs.readFileSync(fp, 'utf8').includes(needle)) return check.runner;
        } catch (_) { /* ignore unreadable config */ }
      }
    }
  }
  return 'unknown';
}

/**
 * Collect (verify existence of) a test nodeid.
 * @param {string} nodeid
 * @param {string} runner
 * @param {string} projectRoot
 * @returns {{found: boolean, detail: string}}
 */
function collectNodeid(nodeid, runner, projectRoot) {
  try {
    switch (runner) {
      case 'pytest': {
        const out = execFileSync('python3', ['-m', 'pytest', '--collect-only', '-q', nodeid], {
          cwd: projectRoot, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
        });
        const lines = out.trim().split('\n').filter(l => l && !l.startsWith('='));
        return { found: lines.length > 0, detail: `${lines.length} test(s) collected` };
      }
      case 'jest':
      case 'vitest': {
        // For jest/vitest, split nodeid into file path and optional test name
        const parts = nodeid.split('::');
        const testFile = parts[0];
        if (!fs.existsSync(path.join(projectRoot, testFile))) {
          return { found: false, detail: `test file not found: ${testFile}` };
        }
        if (parts.length > 1) {
          const content = fs.readFileSync(path.join(projectRoot, testFile), 'utf8');
          const testName = parts[parts.length - 1];
          if (!content.includes(testName)) {
            return { found: false, detail: `test name '${testName}' not found in ${testFile}` };
          }
        }
        return { found: true, detail: `test file exists: ${testFile}` };
      }
      case 'cargo': {
        execFileSync('cargo', ['test', nodeid, '--no-run'], {
          cwd: projectRoot, encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'],
        });
        return { found: true, detail: 'compiled successfully' };
      }
      case 'go': {
        const parts = nodeid.split('::');
        const pkg = parts[0] || './...';
        const testName = parts[1] || '';
        const args = ['test', '-list', testName || '.*', pkg];
        const out = execFileSync('go', args, {
          cwd: projectRoot, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
        });
        const found = testName ? out.includes(testName) : out.trim().length > 0;
        return { found, detail: found ? 'test found' : 'test not found' };
      }
      default: {
        // Unknown runner — check if the file exists
        const testFile = nodeid.split('::')[0];
        if (fs.existsSync(path.join(projectRoot, testFile))) {
          return { found: true, detail: 'test file exists (runner unknown, cannot collect)' };
        }
        return { found: false, detail: `test file not found: ${testFile}` };
      }
    }
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString().split('\n')[0] : err.message;
    return { found: false, detail: msg.slice(0, 120) };
  }
}

/**
 * Run a test nodeid and check if it passes.
 * @param {string} nodeid
 * @param {string} runner
 * @param {string} projectRoot
 * @returns {{passed: boolean, detail: string}}
 */
function runNodeid(nodeid, runner, projectRoot) {
  try {
    switch (runner) {
      case 'pytest': {
        execFileSync('python3', ['-m', 'pytest', '-x', '--tb=short', nodeid], {
          cwd: projectRoot, encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'],
        });
        return { passed: true, detail: 'tests passed' };
      }
      case 'jest': {
        const parts = nodeid.split('::');
        const args = ['jest', '--testPathPattern', parts[0]];
        if (parts.length > 1) args.push('--testNamePattern', parts[parts.length - 1]);
        execFileSync('npx', args, {
          cwd: projectRoot, encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'],
        });
        return { passed: true, detail: 'tests passed' };
      }
      case 'vitest': {
        const parts = nodeid.split('::');
        const args = ['vitest', 'run', parts[0]];
        if (parts.length > 1) args.push('--testNamePattern', parts[parts.length - 1]);
        execFileSync('npx', args, {
          cwd: projectRoot, encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'],
        });
        return { passed: true, detail: 'tests passed' };
      }
      case 'cargo': {
        execFileSync('cargo', ['test', nodeid], {
          cwd: projectRoot, encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'],
        });
        return { passed: true, detail: 'tests passed' };
      }
      case 'go': {
        const parts = nodeid.split('::');
        const pkg = parts[0] || './...';
        const testName = parts[1] || '.*';
        execFileSync('go', ['test', '-run', testName, '-v', pkg], {
          cwd: projectRoot, encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'],
        });
        return { passed: true, detail: 'tests passed' };
      }
      default:
        return { passed: false, detail: 'unknown test runner — cannot execute' };
    }
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString().split('\n').slice(-3).join(' ') : err.message;
    return { passed: false, detail: msg.slice(0, 200) };
  }
}

/**
 * Run a test_command and check exit code.
 * @param {string} command
 * @param {string} projectRoot
 * @returns {{passed: boolean, detail: string}}
 */
function runTestCommand(command, projectRoot) {
  try {
    execFileSync('sh', ['-c', command], {
      cwd: projectRoot, encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { passed: true, detail: 'exit code 0' };
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString().split('\n').slice(-2).join(' ') : err.message;
    return { passed: false, detail: `exit code ${err.status || 'unknown'}: ${msg.slice(0, 150)}` };
  }
}

/**
 * Check if an evidence artifact exists.
 * @param {string} evidence
 * @param {string} projectRoot
 * @returns {{found: boolean, detail: string}}
 */
function checkEvidence(evidence, projectRoot) {
  // If it looks like a file path, check directly
  if (evidence.includes('/') || evidence.includes('.')) {
    const fp = path.join(projectRoot, evidence);
    if (fs.existsSync(fp)) {
      return { found: true, detail: `artifact found: ${evidence}` };
    }
  }

  // Search for the evidence ID in common test output directories
  const searchDirs = ['test-results', 'test-scenarios', 'coverage', '.caws/evidence'];
  for (const dir of searchDirs) {
    const dp = path.join(projectRoot, dir);
    if (fs.existsSync(dp)) {
      try {
        const files = execFileSync('find', [dp, '-name', `*${evidence}*`, '-type', 'f'], {
          encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (files) {
          return { found: true, detail: `found: ${files.split('\n')[0]}` };
        }
      } catch (_) { /* ignore unreadable config */ }
    }
  }

  return { found: false, detail: `artifact not found for: ${evidence}` };
}

/**
 * Extract and merge acceptance criteria from a spec.
 * Handles both `acceptance` and `acceptance_criteria` fields.
 * @param {Object} spec
 * @returns {Array<{id: string, description: string, test_nodeids?: string[], test_command?: string, evidence?: string, narrative?: string}>}
 */
function extractACs(spec) {
  const byId = new Map();

  // Load from `acceptance` field (given/when/then format)
  for (const ac of (spec.acceptance || [])) {
    if (!ac.id) continue;
    const entry = {
      id: ac.id,
      description: ac.then || ac.description || '',
      test_nodeids: ac.test_nodeids || null,
      test_command: ac.test_command || null,
      evidence: ac.evidence || null,
      narrative: ac.test || (ac.given ? `Given ${ac.given}, when ${ac.when}, then ${ac.then}` : null),
    };
    byId.set(ac.id, entry);
  }

  // Load from `acceptance_criteria` field (id/description format) — overrides mechanical fields
  for (const ac of (spec.acceptance_criteria || [])) {
    if (!ac.id) continue;
    const existing = byId.get(ac.id) || { id: ac.id };
    existing.description = ac.description || existing.description || '';
    if (ac.test_nodeids) existing.test_nodeids = ac.test_nodeids;
    if (ac.test_command) existing.test_command = ac.test_command;
    if (ac.evidence) existing.evidence = ac.evidence;
    if (ac.test) existing.narrative = ac.test;
    byId.set(ac.id, existing);
  }

  return Array.from(byId.values());
}

/**
 * Verify all ACs in a spec.
 * @param {Object} spec
 * @param {string} projectRoot
 * @param {Object} options
 * @param {boolean} options.run - Actually run tests (vs collect-only)
 * @param {string} options.runner - Test runner override
 * @returns {{specId: string, title: string, results: Array}}
 */
function verifySpec(spec, projectRoot, options = {}) {
  const runner = options.runner || detectTestRunner(projectRoot);
  const acs = extractACs(spec);
  const results = [];

  for (const ac of acs) {
    const result = { id: ac.id, description: ac.description, method: null, status: null, detail: '' };

    if (ac.test_command) {
      result.method = 'test_command';
      const { passed, detail } = runTestCommand(ac.test_command, projectRoot);
      result.status = passed ? 'PASS' : 'FAIL';
      result.detail = detail;
    } else if (ac.test_nodeids && ac.test_nodeids.length > 0) {
      result.method = 'test_nodeids';
      const nodeResults = [];
      for (const nodeid of ac.test_nodeids) {
        if (options.run) {
          nodeResults.push(runNodeid(nodeid, runner, projectRoot));
        } else {
          const { found, detail } = collectNodeid(nodeid, runner, projectRoot);
          nodeResults.push({ passed: found, detail });
        }
      }
      const allOk = nodeResults.every(r => r.passed);
      result.status = allOk ? 'PASS' : 'FAIL';
      result.detail = nodeResults.map(r => r.detail).join('; ');
    } else if (ac.evidence) {
      result.method = 'evidence';
      const { found, detail } = checkEvidence(ac.evidence, projectRoot);
      result.status = found ? 'PASS' : 'FAIL';
      result.detail = detail;
    } else {
      result.method = 'narrative';
      result.status = 'unchecked';
      result.detail = ac.narrative || 'no mechanical verification available';
    }

    results.push(result);
  }

  return {
    specId: spec.id || 'unknown',
    title: spec.title || '',
    runner,
    results,
  };
}

/**
 * Main command handler
 */
async function verifyAcsCommand(options = {}) {
  const projectRoot = findProjectRoot();

  // Check for CAWS project
  if (!fs.existsSync(path.join(projectRoot, '.caws'))) {
    console.error(chalk.red('Not a CAWS project (no .caws/ directory found)'));
    process.exit(1);
  }

  const resolved = await resolveSpec({
    specId: options.specId,
    warnLegacy: false,
  });

  const allResults = [];
  let totalAcs = 0, totalMechanical = 0, totalPass = 0, totalFail = 0, totalUnchecked = 0;
  const result = verifySpec(resolved.spec, projectRoot, {
    run: options.run || false,
    runner: options.runner,
  });
  result.path = resolved.path;
  result.type = resolved.type;
  allResults.push(result);

  for (const r of result.results) {
    totalAcs++;
    if (r.status === 'PASS') { totalPass++; totalMechanical++; }
    else if (r.status === 'FAIL') { totalFail++; totalMechanical++; }
    else { totalUnchecked++; }
  }

  // Record to working state (Phase 1 dual-write: state layer + event log)
  const acPayload = {
    total: totalAcs,
    pass: totalPass,
    fail: totalFail,
    unchecked: totalUnchecked,
    results: result.results,
  };
  // CAWSFIX-02: guard recordACVerification with `resolved.spec && resolved.spec.id`
  // check to prevent the .caws/state/undefined.json bug class. Matches the
  // pattern gates.js already uses and the appendEvent call below.
  if (resolved.spec && resolved.spec.id) {
    try {
      recordACVerification(resolved.spec.id, acPayload, projectRoot);
    } catch { /* non-fatal */ }
  }

  // EVLOG-001: emit verify_acs_completed event alongside state write.
  if (resolved.spec && resolved.spec.id) {
    await appendEvent(
      { actor: 'cli', event: 'verify_acs_completed', spec_id: resolved.spec.id, data: acPayload },
      { projectRoot }
    );
  }

  // Output
  if (options.format === 'json') {
    console.log(JSON.stringify({
      summary: { total: totalAcs, mechanical: totalMechanical, pass: totalPass, fail: totalFail, unchecked: totalUnchecked },
      specs: allResults,
    }, null, 2));
    process.exit(totalFail > 0 ? 1 : 0);
    return;
  }

  // Table output
  for (const result of allResults) {
    console.log(chalk.cyan(`\n## ${result.specId} — ${result.title}`));
    console.log(
      chalk.gray(
        `   Test runner: ${result.runner} | Mode: ${options.run ? 'run' : 'collect-only'} | Spec: ${result.type} -> ${result.path}`
      )
    );
    console.log();

    const widths = { id: 8, desc: 40, method: 14, status: 10 };
    console.log(
      chalk.gray(
        `  ${'AC'.padEnd(widths.id)}${'Description'.padEnd(widths.desc)}${'Method'.padEnd(widths.method)}${'Status'.padEnd(widths.status)}Detail`
      )
    );
    console.log(chalk.gray('  ' + '-'.repeat(widths.id + widths.desc + widths.method + widths.status + 20)));

    for (const r of result.results) {
      const statusColor = r.status === 'PASS' ? chalk.green : r.status === 'FAIL' ? chalk.red : chalk.yellow;
      const desc = r.description.length > widths.desc - 2
        ? r.description.slice(0, widths.desc - 5) + '...'
        : r.description;
      const detail = r.detail.length > 60 ? r.detail.slice(0, 57) + '...' : r.detail;

      console.log(
        `  ${chalk.white(r.id.padEnd(widths.id))}${desc.padEnd(widths.desc)}${(r.method || '').padEnd(widths.method)}${statusColor(r.status.padEnd(widths.status))}${chalk.gray(detail)}`
      );
    }
  }

  // Summary
  console.log(chalk.cyan('\n## Summary'));
  console.log(`  Total ACs: ${totalAcs} | Mechanical: ${totalMechanical} | ${chalk.green(`Pass: ${totalPass}`)} | ${chalk.red(`Fail: ${totalFail}`)} | ${chalk.yellow(`Unchecked: ${totalUnchecked}`)}`);

  if (totalFail > 0) {
    console.log(chalk.red('\n  Some acceptance criteria failed verification.'));
    process.exit(1);
  } else if (totalMechanical === 0 && totalAcs > 0) {
    console.log(chalk.yellow('\n  No ACs have mechanical verification. Consider adding test_nodeids or test_command.'));
  } else {
    console.log(chalk.green('\n  All mechanically-verifiable ACs passed.'));
  }
}

module.exports = {
  verifyAcsCommand,
  verifySpec,
  extractACs,
  detectTestRunner,
  collectNodeid,
  runNodeid,
  runTestCommand,
  checkEvidence,
};
