'use strict';

/**
 * Mutation CI contract tests.
 *
 * These tests pin the integrity boundary around mutation testing, not any
 * particular survivor count. A green result must mean that the declared
 * source inventory is current, every mutation target exists, and every
 * target independently clears its floor. Missing work is a failure, never a
 * reason to average or skip.
 *
 * [CAWS-CI-MUTATION-PROOF-DURABILITY-001]
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');

const PACKAGE_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../..');
const POLICY = path.join(PACKAGE_ROOT, 'mutation-policy.json');
const VALIDATOR = path.join(PACKAGE_ROOT, 'scripts/validate-mutation-policy.mjs');
const REPORT_ASSERTION = path.join(PACKAGE_ROOT, 'scripts/assert-mutation-report.mjs');
const { createStrykerConfig } = require(path.join(PACKAGE_ROOT, 'scripts/stryker-config.cjs'));

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = 'caws-mutation-contract-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runNode(script, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  });
}

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

function loadPolicy() {
  return JSON.parse(fs.readFileSync(POLICY, 'utf8'));
}

function mutationPolicy(surfaceTargets) {
  return {
    schemaVersion: 1,
    surfaces: {
      fixture: {
        threshold: 80,
        targets: surfaceTargets.map((mutate) => ({
          source: mutate.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'),
          reportPath: mutate,
        })),
      },
    },
  };
}

function report(files) {
  return {
    schemaVersion: '2.0',
    files: Object.fromEntries(
      Object.entries(files).map(([file, statuses]) => [
        file,
        {
          language: 'javascript',
          source: 'fixture source',
          mutants: statuses.map((status, index) => ({
            id: String(index),
            mutatorName: 'fixture',
            replacement: 'fixture',
            status,
            location: {
              start: { line: 1, column: 0 },
              end: { line: 1, column: 1 },
            },
          })),
        },
      ])
    ),
  };
}

function runReportAssertion(policy, mutationReport) {
  const dir = makeTempDir();
  const policyFile = writeJson(dir, 'policy.json', policy);
  const reportFile = writeJson(dir, 'report.json', mutationReport);
  return runNode(REPORT_ASSERTION, [
    '--policy',
    policyFile,
    '--surface',
    'fixture',
    '--report',
    reportFile,
  ]);
}

function executableWorkflowText(parsed) {
  const executable = [];
  for (const job of Object.values(parsed.jobs || {})) {
    if (job.if) executable.push(String(job.if));
    for (const step of job.steps || []) {
      if (step.if) executable.push(String(step.if));
      if (step.uses) executable.push(String(step.uses));
      if (step['working-directory']) executable.push(String(step['working-directory']));
      if (step.with) executable.push(JSON.stringify(step.with));
      if (step.run) {
        executable.push(
          String(step.run)
            .split('\n')
            .filter((line) => !/^\s*#/.test(line))
            .join('\n')
        );
      }
    }
  }
  return executable.join('\n');
}

describe('mutation policy topology contract', () => {
  test('the live policy accounts for every kernel/store/shell source exactly once', () => {
    const result = runNode(VALIDATOR, ['--policy', POLICY, '--root', PACKAGE_ROOT]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/PASS: 144 source files accounted for exactly once/);
    expect(result.stdout).toMatch(/18 mutation targets across 3 surfaces/);
  });

  test('an unclassified production source is a hard failure', () => {
    const policy = loadPolicy();
    const removed = policy.proofGroups[0].files.shift();
    const dir = makeTempDir();
    const policyFile = writeJson(dir, 'policy.json', policy);

    const result = runNode(VALIDATOR, ['--policy', policyFile, '--root', PACKAGE_ROOT]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`unclassified source: ${removed}`);
  });

  test('a source classified by two proof groups is a hard failure', () => {
    const policy = loadPolicy();
    const duplicate = policy.proofGroups[0].files[0];
    policy.proofGroups[1].files.push(duplicate);
    const dir = makeTempDir();
    const policyFile = writeJson(dir, 'policy.json', policy);

    const result = runNode(VALIDATOR, ['--policy', policyFile, '--root', PACKAGE_ROOT]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`source classified more than once: ${duplicate}`);
  });

  test('a missing mutation target or dedicated test is a hard failure', () => {
    const policy = loadPolicy();
    policy.surfaces.kernel.targets[0].source = 'src/kernel/does-not-exist.ts';
    policy.surfaces.kernel.tests.push('tests/kernel/unit/does-not-exist.test.ts');
    const dir = makeTempDir();
    const policyFile = writeJson(dir, 'policy.json', policy);

    const result = runNode(VALIDATOR, ['--policy', policyFile, '--root', PACKAGE_ROOT]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing mutation source: src/kernel/does-not-exist.ts');
    expect(result.stderr).toContain('missing mutation test: tests/kernel/unit/does-not-exist.test.ts');
  });

  test('store mutation recomputes evidence using only in-process store contracts', () => {
    const config = createStrykerConfig('store');

    expect(config.incremental).toBe(false);
    expect(config.testFiles).not.toHaveLength(0);
    expect(config.testFiles.every((file) => file.startsWith('tests/store/'))).toBe(true);
    expect(config.testFiles).toContain('tests/store/messages-behavior-store.test.js');
  });

  test.each(['kernel', 'store', 'shell'])('%s sandbox excludes sibling runs while retaining source and tests', (surface) => {
    const dir = makeTempDir();
    const required = ['src/init/runtime.ts', 'src/store/required.ts', 'tests/store/required.test.js'];
    const generated = [
      '.stryker-kernel-tmp/sandbox/temporary.ts',
      '.stryker-store-tmp/sandbox/temporary.ts',
      '.stryker-shell-tmp/sandbox/temporary.ts',
      'reports/mutation-store/mutation-report.json',
      'coverage/coverage.json',
    ];
    for (const file of [...required, ...generated]) {
      const destination = path.join(dir, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, 'fixture');
    }
    // Exercise the installed Stryker reader that actually selects sandbox
    // inputs; matching patterns ourselves would not prove its semantics.
    const core = path.dirname(require.resolve('@stryker-mutator/core/package.json'));
    const script = `
      import fs from 'node:fs/promises';
      import path from 'node:path';
      import { pathToFileURL } from 'node:url';
      const core = ${JSON.stringify(core)};
      const { defaultOptions } = await import(pathToFileURL(path.join(core, 'dist/src/config/index.js')));
      const { ProjectReader } = await import(pathToFileURL(path.join(core, 'dist/src/fs/project-reader.js')));
      const reader = new ProjectReader(fs, {}, { ...defaultOptions, ...${JSON.stringify(createStrykerConfig(surface))} });
      const files = await reader.resolveInputFileNames();
      console.log(JSON.stringify(files.map(file => path.relative(process.cwd(), file)).sort()));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: dir, encoding: 'utf8', timeout: 10000,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(required);
  });
});

describe('per-file mutation report contract', () => {
  test('a target exactly at its floor passes with an explicit per-file verdict', () => {
    const result = runReportAssertion(
      mutationPolicy(['dist/a.js']),
      report({ 'dist/a.js': ['Killed', 'Killed', 'Killed', 'Killed', 'Survived'] })
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS dist/a.js 80.00% (4/5 detected)');
  });

  test('a zero-mutant target fails instead of receiving a perfect empty score', () => {
    const result = runReportAssertion(
      mutationPolicy(['dist/a.js']),
      report({ 'dist/a.js': [] })
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FAIL dist/a.js has zero valid mutants');
  });

  test('a report missing a declared target fails', () => {
    const result = runReportAssertion(
      mutationPolicy(['dist/a.js']),
      report({ 'dist/not-a.js': ['Killed'] })
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FAIL missing report entry for dist/a.js');
  });

  test('a report with stale or missing test topology fails', () => {
    const policy = mutationPolicy(['dist/a.js']);
    policy.surfaces.fixture.tests = ['tests/current.test.js'];
    const mutationReport = report({ 'dist/a.js': ['Killed'] });
    mutationReport.testFiles = {
      'tests/stale.test.js': { tests: [] },
    };

    const result = runReportAssertion(policy, mutationReport);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FAIL missing report test file tests/current.test.js');
    expect(result.stderr).toContain(
      'FAIL undeclared test file in mutation report: tests/stale.test.js'
    );
  });

  test('a weak file fails even when a large strong file makes the aggregate exceed 80', () => {
    const strong = Array.from({ length: 100 }, () => 'Killed');
    const result = runReportAssertion(
      mutationPolicy(['dist/strong.js', 'dist/weak.js']),
      report({
        'dist/strong.js': strong,
        'dist/weak.js': ['Killed', 'Survived'],
      })
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('PASS dist/strong.js 100.00% (100/100 detected)');
    expect(result.stderr).toContain('FAIL dist/weak.js 50.00% is below 80.00%');
  });

  test('NoCoverage counts as undetected, not as an excluded mutant', () => {
    const result = runReportAssertion(
      mutationPolicy(['dist/a.js']),
      report({ 'dist/a.js': ['Killed', 'Killed', 'Killed', 'Killed', 'NoCoverage'] })
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS dist/a.js 80.00% (4/5 detected)');
  });
});

describe('active workflow topology contract', () => {
  test('the PR shadow-file check refuses when Git cannot compute the diff', () => {
    const prChecks = yaml.load(
      fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/pr-checks.yml'), 'utf8')
    );
    const step = prChecks.jobs.sanity.steps.find((item) => item.name === 'Block shadow file patterns');
    expect(step).toHaveProperty('run');
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
      step.run.replaceAll('${{ github.base_ref }}', 'main')], {
      cwd: makeTempDir(), encoding: 'utf8', timeout: 10000,
      env: { ...process.env, BASE_REF: 'missing-base', HEAD_REF: 'missing-head', LC_ALL: 'C' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not a git repository/i);
  });

  test('PR checks preserve executable regression jobs and reject empty test selection', () => {
    const prChecks = yaml.load(
      fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/pr-checks.yml'), 'utf8')
    );
    const jobs = prChecks.jobs;
    for (const job of Object.values(jobs)) {
      const dependencies = Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
      for (const dependency of dependencies) expect(jobs).toHaveProperty(dependency);
    }
    expect(jobs.pr_comment.needs).toContain('hook_bats_bash32_macos');
    expect(jobs.hook_bats_bash32_macos.steps).toContainEqual(
      expect.objectContaining({ run: 'npm run test:bats:macos' })
    );
    expect(executableWorkflowText(prChecks)).not.toContain('--passWithNoTests');
    expect(executableWorkflowText(prChecks)).not.toContain('perf:budgets');
  });

  test('the removed performance suite is not exposed as an executable package check', () => {
    const metadata = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    expect(metadata.scripts).not.toHaveProperty('perf:budgets');
  });

  test('the mutation workflow uses current caws-cli surfaces and retains evidence', () => {
    const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/mutation.yml'), 'utf8');

    expect(workflow).not.toContain('packages/caws-kernel');
    expect(workflow).toMatch(/surface:\s*\[kernel, store, shell\]/);
    expect(workflow).toContain('mutation:dry-run');
    expect(workflow).toContain('actions/upload-artifact@v4');
    expect(workflow).toContain('GITHUB_STEP_SUMMARY');
    expect(workflow).toContain('github.sha');
  });

  test('no executable workflow step treats working-spec.yaml as current authority', () => {
    const workflowDir = path.join(REPO_ROOT, '.github/workflows');
    const offenders = [];

    for (const name of fs.readdirSync(workflowDir).filter((file) => file.endsWith('.yml'))) {
      const parsed = yaml.load(fs.readFileSync(path.join(workflowDir, name), 'utf8'));
      if (executableWorkflowText(parsed).includes('.caws/working-spec.yaml')) offenders.push(name);
    }

    expect(offenders).toEqual([]);
  });

  test('the duplicate v10 CAWS Guards workflow and PR job are retired', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, '.github/workflows/caws-guards.yml'))).toBe(false);

    const prChecks = yaml.load(
      fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/pr-checks.yml'), 'utf8')
    );
    expect(prChecks.jobs).not.toHaveProperty('caws_guards');

    const cawsGate = yaml.load(
      fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/caws-gate.yml'), 'utf8')
    );
    expect(cawsGate.jobs).toHaveProperty('caws-gate');
  });
});

describe('a surface that verifies nothing cannot report success', () => {
  test('no declared targets fails even when the report is also empty', () => {
    // The dangerous shape: with no targets the per-file loop never runs, so
    // no errors accumulate and the script previously exited 0 having printed
    // neither a PASS nor a FAIL. An empty report is what makes it silent —
    // any file present would have been caught as "undeclared".
    const result = runReportAssertion(mutationPolicy([]), report({}));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('declares no targets');
  });

  test('no declared targets fails even when a report has passing files', () => {
    const result = runReportAssertion(
      mutationPolicy([]),
      report({ 'dist/a.js': ['Killed', 'Killed'] })
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('declares no targets');
  });

  test('a surface whose targets key is absent entirely fails', () => {
    const policy = mutationPolicy([]);
    delete policy.surfaces.fixture.targets;

    const result = runReportAssertion(policy, report({}));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('declares no targets');
  });

  test('a passing surface still reports a per-file verdict', () => {
    // Negative control for the three above: the guard must not have made the
    // ordinary passing path fail.
    const result = runReportAssertion(
      mutationPolicy(['dist/a.js']),
      report({ 'dist/a.js': ['Killed', 'Killed', 'Killed', 'Killed', 'Survived'] })
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS dist/a.js 80.00%');
  });
});
