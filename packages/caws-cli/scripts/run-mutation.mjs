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

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeProcessEnv } from './lib/node-process-env.cjs';
import { validateMutationPolicy } from './validate-mutation-policy.mjs';
import { assertMutationReport, appendSummary } from './assert-mutation-report.mjs';
import {
  captureMutationInputs,
  assertInputsUnchanged,
  captureBuildOutputs,
  assertBuildOutputsUnchanged,
  assertDirectoryAncestry,
  resolveNpmCommand,
  sha256,
  validateSandboxBuildRecord,
} from './mutation-input-identity.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, '..');
const policyPath = path.join(packageRoot, 'mutation-policy.json');
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

function runStreaming(command, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
      env,
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

function makeDirectory(directory) {
  const missing = [];
  let ancestor = path.resolve(directory);
  while (!fs.lstatSync(ancestor, { throwIfNoEntry: false })) {
    missing.push(ancestor);
    ancestor = path.dirname(ancestor);
  }
  assertDirectoryAncestry(ancestor);
  for (const dir of missing.reverse()) fs.mkdirSync(dir);
  assertDirectoryAncestry(directory);
}

function readSandboxBuilds(context, surface) {
  const records = fs
    .readdirSync(context.sandboxBuildDir)
    .sort()
    .map((name) => {
      const file = path.join(context.sandboxBuildDir, name);
      if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
        throw new Error('uncertain sandbox build record');
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      validateSandboxBuildRecord({ context, surface, record, fileName: name });
      return record;
    });
  if (surface.buildCommand && records.length === 0)
    throw new Error('missing executed sandbox build record');
  if (!surface.buildCommand && records.length !== 0)
    throw new Error('unexpected sandbox build record for source-only surface');
  return records;
}

function acquireRunLock(reportDir, runId) {
  const file = path.join(reportDir, '.mutation-run.lock');
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    throw new Error(
      `mutation report writer lock unavailable; ownership is uncertain: ${file} (${error.code})`
    );
  }
  const bytes = JSON.stringify({ runId }) + '\n';
  fs.writeFileSync(fd, bytes);
  return { file, fd, bytes, stat: fs.fstatSync(fd, { bigint: true }) };
}

function releaseRunLock(lock) {
  if (!lock) return;
  try {
    const stat = fs.lstatSync(lock.file, { bigint: true });
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      ['dev', 'ino', 'ctimeNs', 'mtimeNs', 'size'].some((key) => stat[key] !== lock.stat[key]) ||
      fs.readFileSync(lock.file, 'utf8') !== lock.bytes
    )
      throw new Error('mutation report writer lock replaced; ownership is uncertain');
    fs.unlinkSync(lock.file);
  } finally {
    fs.closeSync(lock.fd);
  }
}

function cleanupSandbox(context) {
  // Stryker normally performs this cleanup itself: remove its actual sandbox,
  // then remove the parent only when empty. Preserve unrecognized siblings.
  if (!context || !fs.lstatSync(context.tempDirName, { throwIfNoEntry: false })) return;
  assertDirectoryAncestry(context.tempDirName);
  for (const name of fs.readdirSync(context.sandboxBuildDir)) {
    const recordFile = path.join(context.sandboxBuildDir, name);
    const stat = fs.lstatSync(recordFile);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('uncertain sandbox cleanup record');
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    if (
      record.runId !== context.runId ||
      path.dirname(record.cwd || '') !== context.tempDirName ||
      !path.basename(record.cwd || '').startsWith('sandbox-')
    )
      continue;
    if (fs.lstatSync(record.cwd, { throwIfNoEntry: false })) {
      assertDirectoryAncestry(record.cwd);
      fs.rmSync(record.cwd, { recursive: true });
    }
  }
  if (fs.readdirSync(context.tempDirName).length === 0) fs.rmdirSync(context.tempDirName);
}

export async function main(argv) {
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

  let context;
  let recordPath;
  let runLock;
  const record = {
    schemaVersion: 1,
    runId: randomUUID(),
    surfaceId: options.surface,
    descriptiveSha: options.sha,
    dryRunOnly: options.dryRunOnly,
    status: 'failed',
    nonclaims: [
      'Git revision identity',
      'Jest resolved/loaded candidate qualification',
      'change/restore race exclusion',
    ],
  };
  let exitCode = 1;
  try {
    const reportDir = path.resolve(packageRoot, surface.reportDir);
    if (!reportDir.startsWith(packageRoot + path.sep))
      throw new Error('report directory escapes package');
    makeDirectory(reportDir);
    runLock = acquireRunLock(reportDir, record.runId);
    const runDir = path.join(reportDir, 'runs', record.runId);
    makeDirectory(runDir);
    recordPath = path.join(reportDir, 'mutation-run.json');
    const reportPath = path.join(reportDir, 'mutation-report.json');
    for (const artifact of [reportPath, path.join(reportDir, 'index.html')]) {
      const stat = fs.lstatSync(artifact, { throwIfNoEntry: false });
      if (stat) {
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error(`uncertain stale report artifact: ${artifact}`);
        fs.unlinkSync(artifact);
      }
    }
    // Bind once at the command boundary. Subsequent capture/drift checks remain strict.
    const childEnv = nodeProcessEnv();
    process.env.PATH = childEnv.PATH;
    const inputOptions = { packageRoot, policy, surfaceId: options.surface };
    const inputIdentity = captureMutationInputs(inputOptions);
    record.inputIdentity = inputIdentity;
    const npm = resolveNpmCommand();
    const startedAtMs = Date.now();
    const build = await runStreaming(npm.command, npm.args, childEnv);
    record.build = {
      command: [npm.command, ...npm.args],
      cwd: packageRoot,
      startedAtMs,
      endedAtMs: Date.now(),
      status: build.status,
      signal: build.signal,
      output: build.output,
    };
    if (build.error || build.status !== 0)
      throw new Error(
        `ordinary build failed (${build.error?.message || build.signal || `exit ${build.status}`})`
      );
    assertInputsUnchanged(inputIdentity, inputOptions);
    record.build.outputs = captureBuildOutputs(packageRoot, { startedAtMs });

    const tempDirName = path.join(
      inputIdentity.repoRoot,
      `.stryker-${options.surface}-${record.runId}-tmp`
    );
    if (fs.lstatSync(tempDirName, { throwIfNoEntry: false }))
      throw new Error('mutation sandbox parent already exists');
    const sandboxBuildDir = path.join(runDir, 'sandbox-builds');
    makeDirectory(sandboxBuildDir);
    context = {
      schemaVersion: 1,
      runId: record.runId,
      packageRoot,
      repoRoot: inputIdentity.repoRoot,
      surfaceId: options.surface,
      inputIdentity,
      sandboxBuildDir,
      tempDirName,
    };
    const contextFile = path.join(runDir, 'context.json');
    fs.writeFileSync(contextFile, JSON.stringify(context, null, 2) + '\n', { flag: 'wx' });
    const strykerArgs = ['run', surface.config, '--logLevel', 'info'];
    if (options.dryRunOnly) strykerArgs.push('--dryRunOnly');
    const result = await runStreaming(process.execPath, [strykerBin, ...strykerArgs], {
      ...childEnv,
      CAWS_MUTATION_RUN_CONTEXT: contextFile,
      CAWS_MUTATION_TEMP_DIR: tempDirName,
    });
    record.stryker = {
      command: [process.execPath, strykerBin, ...strykerArgs],
      cwd: packageRoot,
      status: result.status,
      signal: result.signal,
      output: result.output,
    };
    if (result.error || result.status !== 0)
      throw new Error(
        `Stryker produced no passing verdict (${result.error?.message || result.signal || `exit ${result.status}`})`
      );
    assertInputsUnchanged(inputIdentity, inputOptions);
    assertBuildOutputsUnchanged(record.build.outputs, packageRoot);
    record.sandboxBuilds = readSandboxBuilds(context, surface);
    const instrumented = result.output.match(
      /Instrumented\s+(\d+)\s+source file\(s\)\s+with\s+(\d+)\s+mutant\(s\)/
    );
    if (!instrumented)
      throw new Error('Stryker did not report its instrumented source/mutant count');
    const sourceCount = Number(instrumented[1]);
    const mutantCount = Number(instrumented[2]);
    if (sourceCount === 0 || mutantCount === 0)
      throw new Error(
        `refusing empty mutation surface (${sourceCount} source files, ${mutantCount} mutants)`
      );
    record.discovery = { sourceCount, mutantCount };
    if (options.dryRunOnly) {
      record.status = 'baseline-and-discovery';
      console.log(
        `PASS: ${options.surface} baseline/discovery and builds completed with ${sourceCount} source files and ${mutantCount} discoverable mutants; no mutation score verdict`
      );
      exitCode = 0;
    } else {
      const stat = fs.lstatSync(reportPath, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.isSymbolicLink())
        throw new Error(`Stryker exited 0 but did not write a regular report: ${reportPath}`);
      const bytes = fs.readFileSync(reportPath);
      record.report = { path: reportPath, sha256: sha256(bytes), size: bytes.length };
      // Keep the exact bytes associated with this run even when a later run
      // replaces the conventional report path used by artifact uploaders.
      fs.writeFileSync(path.join(runDir, 'mutation-report.json'), bytes, { flag: 'wx' });
      const report = JSON.parse(bytes);
      const reportMutantCount = Object.values(report.files || {}).reduce(
        (count, file) => count + (Array.isArray(file?.mutants) ? file.mutants.length : 0),
        0
      );
      record.discovery.reportMutantCount = reportMutantCount;
      record.discovery.declaredSourceCount = surface.targets.length;
      if (sourceCount !== surface.targets.length)
        throw new Error(
          `instrumented source count ${sourceCount} does not match declared target count ${surface.targets.length}`
        );
      if (mutantCount !== reportMutantCount)
        throw new Error(
          `instrumented mutant count ${mutantCount} does not match report mutant count ${reportMutantCount}`
        );
      const result = assertMutationReport({
        policy,
        surfaceId: options.surface,
        report,
        inputIdentity,
      });
      for (const verdict of result.verdicts)
        if (verdict.passed)
          console.log(
            `PASS ${verdict.file} ${verdict.score.toFixed(2)}% (${verdict.detected}/${verdict.valid} detected)`
          );
      for (const error of result.errors) console.error(`FAIL ${error}`);
      const passed = result.errors.length === 0;
      if (options.summary)
        appendSummary(
          options.summary,
          options.surface,
          options.sha,
          result.verdicts,
          passed,
          inputIdentity
        );
      record.verdicts = result.verdicts;
      record.errors = result.errors;
      record.status = passed ? 'input-build-report-bound' : 'failed';
      if (passed)
        console.log(
          `Captured input/build/report binding: ${record.runId}; descriptive SHA (not verified): ${options.sha}`
        );
      exitCode = passed ? 0 : 1;
    }
  } catch (error) {
    record.error = error.message;
    console.error(`mutation-runner: ${error.message}`);
  } finally {
    try {
      cleanupSandbox(context);
    } catch (error) {
      record.status = 'failed';
      record.cleanupError = error.message;
      console.error(`mutation-runner: ${error.message}`);
      exitCode = 1;
    }
    const persist = (exclusive) => {
      if (!recordPath) return;
      record.exitCode = exitCode;
      const bytes = JSON.stringify(record, null, 2) + '\n';
      fs.writeFileSync(
        path.join(path.dirname(recordPath), 'runs', record.runId, 'mutation-run.json'),
        bytes,
        exclusive ? { flag: 'wx' } : {}
      );
      fs.writeFileSync(recordPath, bytes);
    };
    try {
      persist(true);
    } catch (error) {
      record.status = 'failed';
      record.recordError = error.message;
      console.error(`mutation-runner: retaining terminal record failed (${error.message})`);
      exitCode = 1;
    } finally {
      try {
        releaseRunLock(runLock);
      } catch (error) {
        record.status = 'failed';
        record.lockError = error.message;
        exitCode = 1;
        console.error(`mutation-runner: ${error.message}`);
        try {
          persist(false);
        } catch (retentionError) {
          console.error(
            `mutation-runner: retaining lock refusal failed (${retentionError.message})`
          );
        }
      }
    }
  }
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
