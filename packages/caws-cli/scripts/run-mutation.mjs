#!/usr/bin/env node

/**
 * Top-level mutation runner for kernel, store, and shell surfaces.
 *
 * Stryker remains outside Jest, its topology comes from mutation-policy.json,
 * and its output is streamed while retained for the non-zero-mutant check.
 * Full runs finish by applying the repository's per-file report contract.
 *
 * [CAWS-CI-MUTATION-PROOF-DURABILITY-001]
 */

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMutationPolicy } from './validate-mutation-policy.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, '..');
const policyPath = path.join(packageRoot, 'mutation-policy.json');
const reportAssertion = path.join(scriptDir, 'assert-mutation-report.mjs');
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const options = {
    surface: 'store',
    dryRunOnly: false,
    summary: null,
    sha: process.env.GITHUB_SHA || 'unknown',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run-only') {
      options.dryRunOnly = true;
    } else if (['--surface', '--summary', '--sha'].includes(arg)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function resolveStrykerBin() {
  const packageJson = require.resolve('@stryker-mutator/core/package.json', {
    paths: [packageRoot],
  });
  const metadata = require(packageJson);
  const relativeBin =
    typeof metadata.bin === 'string' ? metadata.bin : metadata.bin && metadata.bin.stryker;
  if (!relativeBin) throw new Error('@stryker-mutator/core exposes no stryker executable');
  return path.join(path.dirname(packageJson), relativeBin);
}

function runStreaming(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', (error) => resolve({ status: 1, signal: null, output, error }));
    child.on('close', (status, signal) => resolve({ status, signal, output, error: null }));
  });
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`mutation-runner: ${error.message}`);
    return 2;
  }

  const validation = validateMutationPolicy({ root: packageRoot, policyFile: policyPath });
  if (validation.errors.length > 0) {
    for (const error of validation.errors) console.error(`mutation-policy: ${error}`);
    return 1;
  }

  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const surface = policy.surfaces[options.surface];
  if (!surface) {
    console.error(
      `mutation-runner: unknown surface "${options.surface}"; expected ${Object.keys(policy.surfaces).join(', ')}`
    );
    return 2;
  }

  let strykerBin;
  try {
    strykerBin = resolveStrykerBin();
  } catch (error) {
    console.error(
      `mutation-runner: Stryker is unavailable; run npm ci at the repository root (${error.message})`
    );
    return 1;
  }

  const reportPath = path.join(packageRoot, surface.reportDir, 'mutation-report.json');
  const htmlPath = path.join(packageRoot, surface.reportDir, 'index.html');
  for (const staleArtifact of [reportPath, htmlPath]) {
    if (fs.existsSync(staleArtifact)) fs.rmSync(staleArtifact);
  }

  const strykerArgs = ['run', surface.config, '--logLevel', 'info'];
  if (options.dryRunOnly) strykerArgs.push('--dryRunOnly');
  const result = await runStreaming(process.execPath, [strykerBin, ...strykerArgs]);
  if (result.error) {
    console.error(`mutation-runner: Stryker failed to spawn (${result.error.message})`);
    return 1;
  }
  if (result.status !== 0) {
    console.error(
      `mutation-runner: Stryker produced no passing verdict (${result.signal || `exit ${result.status}`})`
    );
    return result.status || 1;
  }

  const instrumented = result.output.match(
    /Instrumented\s+(\d+)\s+source file\(s\)\s+with\s+(\d+)\s+mutant\(s\)/
  );
  if (!instrumented) {
    console.error('mutation-runner: Stryker did not report its instrumented source/mutant count');
    return 1;
  }
  const sourceCount = Number(instrumented[1]);
  const mutantCount = Number(instrumented[2]);
  if (sourceCount === 0 || mutantCount === 0) {
    console.error(
      `mutation-runner: refusing empty mutation surface (${sourceCount} source files, ${mutantCount} mutants)`
    );
    return 1;
  }

  if (options.dryRunOnly) {
    console.log(
      `PASS: ${options.surface} dry run completed with ${sourceCount} source files and ${mutantCount} discoverable mutants`
    );
    return 0;
  }

  if (!fs.existsSync(reportPath)) {
    console.error(`mutation-runner: Stryker exited 0 but did not write ${reportPath}`);
    return 1;
  }

  const assertionArgs = [
    reportAssertion,
    '--policy',
    policyPath,
    '--surface',
    options.surface,
    '--report',
    reportPath,
    '--sha',
    options.sha,
  ];
  if (options.summary) assertionArgs.push('--summary', options.summary);
  const assertion = spawnSync(process.execPath, assertionArgs, {
    cwd: packageRoot,
    stdio: 'inherit',
  });
  if (assertion.error) {
    console.error(`mutation-runner: report assertion failed to spawn (${assertion.error.message})`);
    return 1;
  }
  return assertion.status ?? 1;
}

process.exitCode = await main(process.argv.slice(2));
