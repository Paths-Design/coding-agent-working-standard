// Adapter for the `caws-quality-gates` subprocess.
//
// Single responsibility: invoke the subprocess in `--json` mode, capture
// stdout, validate the JSON shape against `gate-result-contract`, and
// return Ok(GatesReport) or Err(diagnostic).
//
// What this adapter does NOT do:
//   - it does not interpret violations
//   - it does not decide pass/fail/skip
//   - it does not append events
//   - it does not write to any file
//
// The runner is pluggable so tests can inject canned JSON without spawning
// real subprocesses. Production uses a default child_process runner.

import * as path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { err, ok, type Diagnostic, type Result } from '@paths.design/caws-kernel';

import { SHELL_RULES } from '../rules';
import { validateGatesReport, type GatesReport } from './gate-result-contract';

export interface SubprocessResult {
  /** Exit code of the subprocess. */
  readonly status: number | null;
  /** stdout captured as UTF-8. */
  readonly stdout: string;
  /** stderr captured as UTF-8. */
  readonly stderr: string;
  /** Any error thrown by the spawn itself (ENOENT, etc.). */
  readonly error?: Error;
}

export interface QualityGatesRunnerInput {
  readonly cwd: string;
  /** Extra CLI args after `--json` (e.g. ['--context=cli', '--quiet']). */
  readonly args: readonly string[];
}

export type QualityGatesRunner = (input: QualityGatesRunnerInput) => SubprocessResult;

function diag(rule: string, message: string, data?: Record<string, unknown>): Diagnostic {
  const base: Diagnostic = {
    rule,
    authority: 'kernel/diagnostics',
    severity: 'error',
    message,
  };
  return data !== undefined ? { ...base, data } : base;
}

function defaultRunner(input: QualityGatesRunnerInput): SubprocessResult {
  // Resolve the subprocess via node_modules/.bin in the repo, falling back
  // to PATH lookup. Tests should override this entirely.
  const bin = path.resolve(
    input.cwd,
    'node_modules',
    '.bin',
    'caws-quality-gates'
  );
  const r: SpawnSyncReturns<string> = spawnSync(
    bin,
    ['--json', ...input.args],
    { cwd: input.cwd, encoding: 'utf8' }
  );
  const out: SubprocessResult = {
    status: r.status,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
    ...(r.error !== undefined ? { error: r.error } : {}),
  };
  return out;
}

export interface RunQualityGatesOptions {
  readonly cwd: string;
  readonly args?: readonly string[];
  /** Inject a custom runner. Tests use this; production omits. */
  readonly runner?: QualityGatesRunner;
}

export function runQualityGates(opts: RunQualityGatesOptions): Result<GatesReport> {
  const runner = opts.runner ?? defaultRunner;
  const result = runner({ cwd: opts.cwd, args: opts.args ?? [] });

  // Subprocess could not be spawned (ENOENT, permission, etc.).
  if (result.error !== undefined) {
    return err(
      diag(
        SHELL_RULES.GATES_SUBPROCESS_NOT_FOUND,
        `Failed to spawn caws-quality-gates: ${result.error.message}`,
        { errno: (result.error as NodeJS.ErrnoException).code }
      )
    );
  }

  // Nonzero exit is acceptable IF we still got valid JSON: violations
  // routinely produce nonzero exit. We do NOT treat exit code as the
  // disposition source — policy does. But if the subprocess didn't
  // produce JSON at all, that's an integration failure.
  if (result.stdout.trim().length === 0) {
    return err(
      diag(
        SHELL_RULES.GATES_SUBPROCESS_FAILED,
        `caws-quality-gates produced no stdout (exit=${result.status}).`,
        {
          exit: result.status,
          stderr: result.stderr.slice(0, 4000),
        }
      )
    );
  }

  // Validate the JSON shape before trusting it. This is the contract gate.
  const reportResult = validateGatesReport(result.stdout);
  if (!reportResult.ok) return reportResult;

  return ok(reportResult.value);
}
