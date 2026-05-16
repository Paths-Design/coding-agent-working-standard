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

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { err, ok, type Diagnostic, type Result } from '@paths.design/caws-kernel';

import { SHELL_RULES } from '../rules';
import { validateGatesReport, type GatesReport } from './gate-result-contract';

const BIN_NAME = 'caws-quality-gates';

/**
 * Pure resolver: given the CLI install directory and the consumer project
 * cwd, decide which on-disk path to spawn. Walks up from each starting
 * point looking for `node_modules/.bin/<BIN_NAME>`.
 *
 * Resolution order (documented per CLI-GATES-003 A4):
 *   1. CLI-install-local — walk up from cliDir. This wins when caws-cli is
 *      installed globally or in a separate sandbox: caws-quality-gates
 *      ships as a runtime dep of caws-cli, so it lives beside the caws
 *      binary, not beside the consumer project.
 *   2. Project-local — walk up from projectCwd. Preserves the prior
 *      behavior for the project-local install pattern (CLI-GATES-002 A1).
 *
 * The CLI-install-local check wins when both exist. That ordering is by
 * design: a global caws install was a deliberate choice to use one CLI
 * version everywhere, and we want that single subprocess version too —
 * not whatever happens to be in the consumer's node_modules from an older
 * project-local install.
 *
 * Returns the resolved path on success, or { tried: string[] } so the
 * adapter can surface both attempted paths in the GATES_SUBPROCESS_NOT_FOUND
 * diagnostic.
 */
export function resolveQualityGatesBin(
  cliDir: string,
  projectCwd: string,
  fsCheck: (p: string) => boolean = fs.existsSync
): { resolved: string; source: 'cli-local' | 'project-local' } | { tried: string[] } {
  const tried: string[] = [];
  for (const [source, start] of [
    ['cli-local', cliDir],
    ['project-local', projectCwd],
  ] as const) {
    let dir = path.resolve(start);
    while (true) {
      const candidate = path.join(dir, 'node_modules', '.bin', BIN_NAME);
      tried.push(candidate);
      if (fsCheck(candidate)) {
        return { resolved: candidate, source };
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return { tried };
}

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
  // CLI-GATES-003: resolve the subprocess from the installed CLI package
  // location first (covers global / sandboxed install), then fall back to
  // the consumer project (covers project-local install — CLI-GATES-002 A1).
  // No PATH fallback — explicit failure beats a hijacked binary.
  //
  // Spawn cwd stays as input.cwd (CLI-GATES-003 A3): the analyzed files
  // come from the consumer project, never from the CLI's install dir.
  const resolution = resolveQualityGatesBin(__dirname, input.cwd);
  if ('tried' in resolution) {
    return {
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(
        new Error(
          `caws-quality-gates not found. Tried ${resolution.tried.length} location(s): ${resolution.tried.join(', ')}`
        ),
        { code: 'ENOENT' }
      ),
    };
  }
  const r: SpawnSyncReturns<string> = spawnSync(
    resolution.resolved,
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
