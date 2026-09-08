#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, '..');
const detectedStatuses = new Set(['Killed', 'Timeout']);
const undetectedStatuses = new Set(['Survived', 'NoCoverage']);
const invalidStatuses = new Set(['RuntimeError', 'CompileError', 'Pending']);
const knownStatuses = new Set([
  ...detectedStatuses,
  ...undetectedStatuses,
  ...invalidStatuses,
  'Ignored',
]);

function parseArgs(argv) {
  const options = {
    policy: path.join(packageRoot, 'mutation-policy.json'),
    summary: null,
    sha: process.env.GITHUB_SHA || 'unknown',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (['--policy', '--surface', '--report', '--summary', '--sha'].includes(arg)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = arg === '--surface' || arg === '--sha' ? value : path.resolve(value);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.surface) throw new Error('--surface is required');
  if (!options.report) throw new Error('--report is required');
  return options;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${file} (${error.message})`);
  }
}

function normalizeReportPath(file, report) {
  const normalized = file.split(path.sep).join('/');
  if (!path.isAbsolute(normalized)) return normalized.replace(/^\.\//, '');
  const root = report.projectRoot ? path.resolve(report.projectRoot) : packageRoot;
  return path.relative(root, normalized).split(path.sep).join('/');
}

function countStatuses(mutants) {
  const counts = new Map();
  for (const mutant of mutants) {
    const status = mutant && mutant.status;
    counts.set(status, (counts.get(status) || 0) + 1);
  }
  return counts;
}

function appendSummary(file, surfaceId, sha, verdicts, passed) {
  const rows = [
    `## Mutation proof: ${surfaceId}`,
    '',
    `Tested SHA: \`${sha}\``,
    '',
    '| Target | Score | Detected / valid | Verdict |',
    '| --- | ---: | ---: | --- |',
  ];
  for (const verdict of verdicts) {
    rows.push(
      `| \`${verdict.file}\` | ${verdict.score === null ? 'n/a' : `${verdict.score.toFixed(2)}%`} | ${verdict.detected}/${verdict.valid} | ${verdict.passed ? 'PASS' : 'FAIL'} |`
    );
  }
  rows.push('', passed ? '**Surface verdict: PASS**' : '**Surface verdict: FAIL**', '');
  fs.appendFileSync(file, `${rows.join('\n')}\n`, 'utf8');
}

export function assertMutationReport({ policy, surfaceId, report }) {
  const errors = [];
  const verdicts = [];
  const surface = policy.surfaces && policy.surfaces[surfaceId];
  if (!surface) {
    return { errors: [`unknown mutation surface: ${surfaceId}`], verdicts };
  }
  if (!report.files || typeof report.files !== 'object') {
    return { errors: ['mutation report has no files object'], verdicts };
  }
  // A surface with no targets verifies nothing. Without this the target loop
  // below never runs, no errors accumulate, and main() exits 0 having printed
  // neither a PASS nor a FAIL — success reported for work never done, which is
  // the failure class this gate exists to prevent. validate-mutation-policy.mjs
  // also rejects empty targets, but this function is exported and the script is
  // independently CLI-invokable, so the guarantee belongs here too.
  if (!Array.isArray(surface.targets) || surface.targets.length === 0) {
    return {
      errors: [`mutation surface ${surfaceId} declares no targets; nothing would be verified`],
      verdicts,
    };
  }

  if (Array.isArray(surface.tests)) {
    if (!report.testFiles || typeof report.testFiles !== 'object') {
      errors.push('mutation report has no testFiles object');
    } else {
      const expectedTests = new Set(surface.tests.map((file) => file.replace(/^\.\//, '')));
      const reportTests = new Set(
        Object.keys(report.testFiles).map((file) => normalizeReportPath(file, report))
      );
      for (const file of expectedTests) {
        if (!reportTests.has(file)) errors.push(`missing report test file ${file}`);
      }
      for (const file of reportTests) {
        if (!expectedTests.has(file)) errors.push(`undeclared test file in mutation report: ${file}`);
      }
    }
  }

  const reportFiles = new Map(
    Object.entries(report.files).map(([file, result]) => [normalizeReportPath(file, report), result])
  );
  const expected = new Set();

  for (const target of surface.targets) {
    const file = (target.reportPath || target.source).replace(/^\.\//, '');
    expected.add(file);
    const result = reportFiles.get(file);
    if (!result) {
      errors.push(`missing report entry for ${file}`);
      verdicts.push({ file, detected: 0, valid: 0, score: null, passed: false });
      continue;
    }
    if (!Array.isArray(result.mutants)) {
      errors.push(`${file} report entry has no mutants array`);
      verdicts.push({ file, detected: 0, valid: 0, score: null, passed: false });
      continue;
    }

    const counts = countStatuses(result.mutants);
    const unknown = [...counts.keys()].filter((status) => !knownStatuses.has(status));
    if (unknown.length > 0) errors.push(`${file} has unknown mutant status: ${unknown.join(', ')}`);

    const detected = [...detectedStatuses].reduce((sum, status) => sum + (counts.get(status) || 0), 0);
    const undetected = [...undetectedStatuses].reduce(
      (sum, status) => sum + (counts.get(status) || 0),
      0
    );
    const invalid = [...invalidStatuses].reduce((sum, status) => sum + (counts.get(status) || 0), 0);
    const ignored = counts.get('Ignored') || 0;
    const valid = detected + undetected;
    const threshold = target.threshold ?? surface.threshold;
    const score = valid > 0 ? (detected / valid) * 100 : null;

    if (valid === 0) errors.push(`${file} has zero valid mutants`);
    if (invalid > 0) errors.push(`${file} has ${invalid} invalid or pending mutant verdict(s)`);
    if (ignored > (target.allowIgnored || 0)) {
      errors.push(`${file} has ${ignored} ignored mutant(s) without an explicit allowance`);
    }
    if (score !== null && score < threshold) {
      errors.push(`${file} ${score.toFixed(2)}% is below ${threshold.toFixed(2)}%`);
    }

    const passed =
      valid > 0 &&
      invalid === 0 &&
      ignored <= (target.allowIgnored || 0) &&
      score !== null &&
      score >= threshold &&
      unknown.length === 0;
    verdicts.push({ file, detected, valid, score, passed });
  }

  for (const file of reportFiles.keys()) {
    if (!expected.has(file)) errors.push(`undeclared file in mutation report: ${file}`);
  }

  // Every declared target must have produced a verdict. This is the structural
  // counterpart to the targets check above: it fails if a future edit adds a
  // loop path that skips a target instead of recording one.
  if (verdicts.length !== surface.targets.length) {
    errors.push(
      `expected one verdict per declared target (${surface.targets.length}), got ${verdicts.length}`
    );
  }

  return { errors, verdicts };
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
    const policy = readJson(options.policy, 'mutation policy');
    const report = readJson(options.report, 'mutation report');
    const result = assertMutationReport({ policy, surfaceId: options.surface, report });

    for (const verdict of result.verdicts) {
      if (verdict.score !== null && verdict.passed) {
        console.log(
          `PASS ${verdict.file} ${verdict.score.toFixed(2)}% (${verdict.detected}/${verdict.valid} detected)`
        );
      }
    }
    for (const error of result.errors) console.error(`FAIL ${error}`);

    const passed = result.errors.length === 0;
    if (options.summary) {
      appendSummary(options.summary, options.surface, options.sha, result.verdicts, passed);
    }
    return passed ? 0 : 1;
  } catch (error) {
    console.error(`mutation-report: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
