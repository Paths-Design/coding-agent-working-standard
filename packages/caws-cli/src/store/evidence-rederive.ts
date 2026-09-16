/**
 * Acceptance-evidence re-derivation — the IMPURE half.
 * CAWS-SPECS-VERIFY-ACS-REDERIVE-001.
 *
 * The kernel (`kernel/evidence/rederive.ts`) decides what to check and how to
 * read the outcomes. This module executes the plan: it asks git whether a
 * cited commit exists and is reachable, whether a cited artifact is in the
 * tree, and — only when asked — runs a cited test through the repository's
 * own runner. It then hands a plain-data report back to the kernel.
 *
 * SUBPROCESS DISCIPLINE. Every spawn here is `execFileSync` with a
 * compile-time program name and an argv array. Agent-authored strings appear
 * only as operands, after `--`, and a nodeid is refused before any spawn if it
 * begins with `-`. Every spawn sets an explicit timeout, `killSignal` and
 * `maxBuffer` — no other subprocess in this package does, and a governance
 * command that can hang on a test runner is a worse defect than the one this
 * slice fixes. A timeout is reported as `timeout`, never as passed or failed.
 *
 * NO `npx`. v10.2's verify-acs ran `npx jest`; in a repo without the runner
 * installed, npx may fetch and execute a package from the network. Runners are
 * resolved from the repository's own `node_modules/.bin`, and `unavailable` is
 * reported when absent. pytest is invoked as `python3 -m pytest`, which never
 * installs anything.
 *
 * COLLECT FIRST, ALWAYS. Existence is checked before any run, so a cited test
 * that does not exist is `missing` rather than `failed`, and existence-only
 * mode yields `not_run` — never `passed`.
 *
 * `command` CHECKS ARE NEVER EXECUTED. The plan marks them non-executable and
 * this module skips them; the kernel reports `command_not_executed`.
 *
 * WHAT IS PROVEN HERE. Execution is implemented for pytest and jest, the two
 * runners this repository can exercise in its own test suite. vitest, cargo
 * and go are DETECTED (so the runner name is right in output) but report
 * `unavailable` with a detail naming the gap, rather than shipping an untested
 * execution path.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { resolveGitBinary } from './git-binary';
import {
  classifyRederivation,
  planRederivation,
  summarizeRederivation,
  type CheckClass,
  type CheckOutcome,
  type CriterionVerdict,
  type DeclaredCheck,
  type RederivationPlan,
  type RederivationReport,
  type RederivationSummary,
  type Spec,
} from '../kernel';

export const TEST_RUNNERS = ['pytest', 'jest', 'vitest', 'cargo', 'go', 'unknown'] as const;
export type TestRunner = (typeof TEST_RUNNERS)[number];
/** Runners a caller may name as an override; `unknown` is a detection result, not a choice. */
export const SELECTABLE_TEST_RUNNERS: readonly TestRunner[] = TEST_RUNNERS.filter(
  (r) => r !== 'unknown'
);

export interface SpawnOptions {
  readonly cwd: string;
  readonly timeout: number;
  readonly killSignal: 'SIGKILL';
  readonly maxBuffer: number;
  readonly encoding: 'utf8';
  readonly stdio: ['ignore', 'pipe', 'pipe'];
  readonly env: NodeJS.ProcessEnv;
}

/** Injectable for tests: the exact shape this module calls `execFileSync` with. */
export type ExecFileSyncLike = (
  file: string,
  args: readonly string[],
  options: SpawnOptions
) => string;

export interface RederiveTimeouts {
  readonly git?: number;
  readonly collect?: number;
  readonly run?: number;
}

export interface RederiveOptions {
  /** Which executable classes to run at this call site. Unselected checks report `not_run`. */
  readonly classes: readonly CheckClass[];
  /** Execute cited tests (true) or only confirm they exist (false → `not_run`). */
  readonly runTests: boolean;
  /** Override runner detection. */
  readonly runner?: TestRunner;
  readonly timeouts?: RederiveTimeouts;
  readonly execFile?: ExecFileSyncLike;
}

export const DEFAULT_TIMEOUTS: Required<RederiveTimeouts> = {
  git: 10_000,
  collect: 30_000,
  run: 120_000,
};

const MAX_BUFFER = 8 * 1024 * 1024;
const DETAIL_MAX = 240;

// ─── bounded spawn ───────────────────────────────────────────────────────────

type SpawnResult =
  | { readonly kind: 'ok'; readonly stdout: string }
  | {
      readonly kind: 'exit';
      readonly status: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'enoent' }
  | { readonly kind: 'error'; readonly message: string };

function childEnv(): NodeJS.ProcessEnv {
  // JEST_WORKER_ID is jest's marker for its own workers. A runner spawned from
  // inside a jest process (this package's own tests) must not inherit it.
  const env = { ...process.env };
  delete env.JEST_WORKER_ID;
  return env;
}

function toText(value: unknown): string {
  if (value instanceof Buffer) return value.toString('utf8');
  return typeof value === 'string' ? value : '';
}

function spawnBounded(
  exec: ExecFileSyncLike,
  file: string,
  args: readonly string[],
  cwd: string,
  timeout: number
): SpawnResult {
  try {
    const stdout = exec(file, [...args], {
      cwd,
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv(),
    });
    return { kind: 'ok', stdout: toText(stdout) };
  } catch (e) {
    const c = e as {
      code?: string;
      status?: number | null;
      signal?: string | null;
      killed?: boolean;
      stdout?: unknown;
      stderr?: unknown;
      message?: string;
    };
    if (c.code === 'ENOENT') return { kind: 'enoent' };
    if (c.code === 'ETIMEDOUT' || c.killed === true || c.signal === 'SIGKILL') {
      return { kind: 'timeout' };
    }
    if (typeof c.status === 'number') {
      return { kind: 'exit', status: c.status, stdout: toText(c.stdout), stderr: toText(c.stderr) };
    }
    return { kind: 'error', message: c.message ?? 'unknown spawn error' };
  }
}

function tail(text: string, max = DETAIL_MAX): string {
  const lines = text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  const joined = lines.slice(-3).join(' | ');
  return joined.length > max ? `…${joined.slice(-max)}` : joined;
}

// ─── target validation ───────────────────────────────────────────────────────

const SHA_RE = /^[0-9a-f]{4,40}$/i;

function refuseSha(sha: string): string | null {
  return SHA_RE.test(sha) ? null : `commit_sha ${JSON.stringify(sha)} is not a hex object id`;
}

function refuseRepoPath(p: string): string | null {
  if (p.length === 0) return 'artifact_path is empty';
  if (/[\0\n\r]/.test(p)) return 'artifact_path contains a control character';
  if (path.isAbsolute(p))
    return `artifact_path ${JSON.stringify(p)} is absolute; must be repo-relative`;
  if (p.split(/[\\/]/).includes('..'))
    return `artifact_path ${JSON.stringify(p)} escapes the repository`;
  return null;
}

function refuseNodeid(nodeid: string): string | null {
  if (nodeid.length === 0) return 'test_nodeid is empty';
  if (/[\0\n\r]/.test(nodeid)) return 'test_nodeid contains a control character';
  if (nodeid.startsWith('-')) {
    return `test_nodeid ${JSON.stringify(nodeid)} begins with "-"; a nodeid is an operand, not a runner flag`;
  }
  const file = nodeid.split('::')[0] ?? '';
  return refuseRepoPath(file)?.replace('artifact_path', 'test_nodeid file') ?? null;
}

// ─── git checks ──────────────────────────────────────────────────────────────

function citationOutcome(
  exec: ExecFileSyncLike,
  repoRoot: string,
  sha: string,
  timeout: number
): CheckOutcome {
  const base = { class: 'citation' as const, target: sha };
  const refused = refuseSha(sha);
  if (refused !== null) return { ...base, outcome: 'refused', detail: refused };

  const exists = spawnBounded(
    exec,
    resolveGitBinary(),
    ['cat-file', '-e', `${sha}^{commit}`],
    repoRoot,
    timeout
  );
  if (exists.kind === 'enoent')
    return { ...base, outcome: 'unavailable', detail: 'git binary not found' };
  if (exists.kind === 'timeout')
    return { ...base, outcome: 'timeout', detail: 'git cat-file timed out' };
  if (exists.kind === 'error') return { ...base, outcome: 'unavailable', detail: exists.message };
  if (exists.kind === 'exit') {
    return {
      ...base,
      outcome: 'missing',
      detail: `commit ${sha} is not an object in this repository`,
    };
  }

  const reach = spawnBounded(
    exec,
    resolveGitBinary(),
    ['for-each-ref', '--contains', sha, '--count=1', '--format=%(refname)'],
    repoRoot,
    timeout
  );
  if (reach.kind === 'timeout')
    return { ...base, outcome: 'timeout', detail: 'git for-each-ref timed out' };
  if (reach.kind !== 'ok') {
    return { ...base, outcome: 'unavailable', detail: 'git for-each-ref failed' };
  }
  const ref = reach.stdout.trim();
  if (ref.length === 0) {
    return {
      ...base,
      outcome: 'unreachable',
      detail: `commit ${sha} exists but no ref reaches it`,
    };
  }
  return {
    ...base,
    outcome: 'passed',
    detail: `commit ${sha} exists and is reachable from ${ref}`,
  };
}

function artifactOutcome(
  exec: ExecFileSyncLike,
  repoRoot: string,
  artifactPath: string,
  revision: string,
  timeout: number
): CheckOutcome {
  const base = { class: 'artifact' as const, target: artifactPath };
  const refused = refuseRepoPath(artifactPath);
  if (refused !== null) return { ...base, outcome: 'refused', detail: refused };

  const inTree = spawnBounded(
    exec,
    resolveGitBinary(),
    ['cat-file', '-e', `${revision}:${artifactPath}`],
    repoRoot,
    timeout
  );
  if (inTree.kind === 'enoent')
    return { ...base, outcome: 'unavailable', detail: 'git binary not found' };
  if (inTree.kind === 'timeout')
    return { ...base, outcome: 'timeout', detail: 'git cat-file timed out' };
  if (inTree.kind === 'error') return { ...base, outcome: 'unavailable', detail: inTree.message };
  if (inTree.kind === 'ok')
    return { ...base, outcome: 'passed', detail: `${artifactPath} present at ${revision}` };

  // Three distinct ways to be absent at the cited revision, each with its own
  // remediation: not anywhere; on disk but never committed; committed later
  // than the citation (the citation is the stale field, not the artifact).
  const onDisk = fs.existsSync(path.join(repoRoot, artifactPath));
  if (!onDisk)
    return { ...base, outcome: 'missing', detail: `${artifactPath} not found at ${revision}` };
  const atHead =
    revision !== 'HEAD' &&
    spawnBounded(
      exec,
      resolveGitBinary(),
      ['cat-file', '-e', `HEAD:${artifactPath}`],
      repoRoot,
      timeout
    ).kind === 'ok';
  return {
    ...base,
    outcome: 'missing',
    detail: atHead
      ? `${artifactPath} is tracked at HEAD but absent at cited ${revision}; cite the commit that added it`
      : `${artifactPath} is on disk but not tracked at ${revision}; commit it before citing it`,
  };
}

// ─── test runner detection ───────────────────────────────────────────────────

function fileContains(filePath: string, needle: string): boolean {
  try {
    return fs.readFileSync(filePath, 'utf8').includes(needle);
  } catch {
    return false;
  }
}

/** Detect the runner configured in one directory (lifted from v10.2 verify-acs). */
export function detectTestRunner(dir: string): TestRunner {
  const has = (name: string): boolean => fs.existsSync(path.join(dir, name));
  if (has('pytest.ini') || has('conftest.py') || has('setup.cfg')) return 'pytest';
  if (fileContains(path.join(dir, 'pyproject.toml'), '[tool.pytest')) return 'pytest';
  if (['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts'].some(has)) return 'vitest';
  if (['jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.cjs'].some(has))
    return 'jest';
  if (fileContains(path.join(dir, 'package.json'), '"jest"')) return 'jest';
  if (has('Cargo.toml')) return 'cargo';
  if (has('go.mod')) return 'go';
  return 'unknown';
}

interface RunnerContext {
  readonly runner: TestRunner;
  /** Directory the runner is invoked from — where its config was found. */
  readonly cwd: string;
}

/**
 * Resolve the runner for one nodeid: an explicit override wins; a `.py` file
 * is pytest; otherwise walk from the nodeid's directory up to the repo root
 * and take the first directory carrying a runner config, so a monorepo
 * package's config beats the root's absence.
 */
function resolveRunner(
  repoRoot: string,
  nodeidFile: string,
  override: TestRunner | undefined
): RunnerContext {
  let dir = path.resolve(repoRoot, path.dirname(nodeidFile));
  const root = path.resolve(repoRoot);
  const walk: string[] = [];
  while (dir.startsWith(root)) {
    walk.push(dir);
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  if (override !== undefined) {
    const cfgDir = walk.find((d) => detectTestRunner(d) === override) ?? root;
    return { runner: override, cwd: cfgDir };
  }
  if (nodeidFile.endsWith('.py')) {
    const cfgDir = walk.find((d) => detectTestRunner(d) === 'pytest') ?? root;
    return { runner: 'pytest', cwd: cfgDir };
  }
  for (const d of walk) {
    const r = detectTestRunner(d);
    if (r !== 'unknown') return { runner: r, cwd: d };
  }
  return { runner: 'unknown', cwd: root };
}

function findBin(fromDir: string, stopDir: string, name: string): string | null {
  let dir = path.resolve(fromDir);
  const stop = path.resolve(stopDir);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '.bin', name);
    if (fs.existsSync(candidate)) return candidate;
    if (dir === stop || dir === path.dirname(dir)) return null;
    dir = path.dirname(dir);
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── test checks ─────────────────────────────────────────────────────────────

interface TestTimeouts {
  readonly collect: number;
  readonly run: number;
}

function spawnToOutcome(
  base: { class: 'test'; target: string },
  r: SpawnResult,
  onExit: (status: number, out: string) => CheckOutcome,
  what: string
): CheckOutcome {
  switch (r.kind) {
    case 'ok':
      return { ...base, outcome: 'passed', detail: `${what} passed` };
    case 'exit':
      return onExit(r.status, `${r.stdout}\n${r.stderr}`);
    case 'timeout':
      return {
        ...base,
        outcome: 'timeout',
        detail: `${what} exceeded its time bound and was killed`,
      };
    case 'enoent':
      return { ...base, outcome: 'unavailable', detail: `${what}: runner binary not found` };
    case 'error':
      return { ...base, outcome: 'unavailable', detail: r.message };
  }
}

function pytestOutcome(
  exec: ExecFileSyncLike,
  ctx: RunnerContext,
  repoRoot: string,
  nodeid: string,
  runTests: boolean,
  t: TestTimeouts
): CheckOutcome {
  const base = { class: 'test' as const, target: nodeid };
  const [file, ...rest] = nodeid.split('::');
  const relFile = path.relative(ctx.cwd, path.resolve(repoRoot, file ?? ''));
  const relNodeid = [relFile, ...rest].join('::');

  const collect = spawnBounded(
    exec,
    'python3',
    ['-m', 'pytest', '--collect-only', '-q', '--', relNodeid],
    ctx.cwd,
    t.collect
  );
  if (collect.kind === 'timeout')
    return { ...base, outcome: 'timeout', detail: 'pytest collection timed out' };
  if (collect.kind === 'enoent')
    return { ...base, outcome: 'unavailable', detail: 'python3 not found' };
  if (collect.kind === 'error') return { ...base, outcome: 'unavailable', detail: collect.message };
  if (collect.kind === 'exit') {
    // python3 present, pytest not installed: the runner is unavailable, which
    // must never read as "the citation names nothing" (an infrastructure gap
    // would otherwise refute an honest citation).
    if (/No module named pytest/.test(collect.stderr)) {
      return {
        ...base,
        outcome: 'unavailable',
        detail: 'pytest is not installed for python3 (No module named pytest)',
      };
    }
    // 5 = no tests collected; anything else is a collection error (import
    // failure, syntax error). Both mean the citation cannot be collected.
    return {
      ...base,
      outcome: 'missing',
      detail: `pytest could not collect ${nodeid}: ${tail(collect.stderr || collect.stdout)}`,
    };
  }
  const items = collect.stdout
    .split('\n')
    .filter(
      (l) =>
        l.trim().length > 0 &&
        !l.startsWith('=') &&
        !/^\d+ tests? collected/.test(l) &&
        !/no tests ran/.test(l)
    );
  if (items.length === 0)
    return { ...base, outcome: 'missing', detail: `pytest collected nothing for ${nodeid}` };
  if (!runTests)
    return {
      ...base,
      outcome: 'not_run',
      detail: `${items.length} item(s) collected; not executed`,
    };

  const run = spawnBounded(
    exec,
    'python3',
    ['-m', 'pytest', '-q', '-x', '--', relNodeid],
    ctx.cwd,
    t.run
  );
  return spawnToOutcome(
    base,
    run,
    (status, out) =>
      status === 5
        ? { ...base, outcome: 'missing', detail: `pytest ran nothing for ${nodeid}` }
        : { ...base, outcome: 'failed', detail: `pytest exit ${status}: ${tail(out)}` },
    `pytest ${nodeid}`
  );
}

function jestOutcome(
  exec: ExecFileSyncLike,
  ctx: RunnerContext,
  repoRoot: string,
  nodeid: string,
  runTests: boolean,
  t: TestTimeouts
): CheckOutcome {
  const base = { class: 'test' as const, target: nodeid };
  const [file, ...rest] = nodeid.split('::');
  const absFile = path.resolve(repoRoot, file ?? '');
  const testName = rest.length > 0 ? rest[rest.length - 1] : undefined;

  if (!fs.existsSync(absFile))
    return { ...base, outcome: 'missing', detail: `test file not found: ${file}` };
  if (testName !== undefined && !fileContains(absFile, testName)) {
    return {
      ...base,
      outcome: 'missing',
      detail: `test name ${JSON.stringify(testName)} not found in ${file}`,
    };
  }
  if (!runTests)
    return { ...base, outcome: 'not_run', detail: 'test file and name present; not executed' };

  const bin = findBin(ctx.cwd, repoRoot, 'jest');
  if (bin === null) {
    return {
      ...base,
      outcome: 'unavailable',
      detail: `jest is not installed under ${path.relative(repoRoot, ctx.cwd) || '.'}/node_modules; npx is deliberately not used`,
    };
  }
  const relFile = path.relative(ctx.cwd, absFile);
  const args = ['--runInBand', '--runTestsByPath'];
  if (testName !== undefined) args.push(`--testNamePattern=${escapeRegex(testName)}`);
  args.push('--', relFile);
  const run = spawnBounded(exec, bin, args, ctx.cwd, t.run);
  return spawnToOutcome(
    base,
    run,
    (status, out) => ({ ...base, outcome: 'failed', detail: `jest exit ${status}: ${tail(out)}` }),
    `jest ${nodeid}`
  );
}

function testOutcome(
  exec: ExecFileSyncLike,
  repoRoot: string,
  nodeid: string,
  opts: RederiveOptions,
  t: TestTimeouts
): CheckOutcome {
  const base = { class: 'test' as const, target: nodeid };
  const refused = refuseNodeid(nodeid);
  if (refused !== null) return { ...base, outcome: 'refused', detail: refused };

  const file = nodeid.split('::')[0] ?? '';
  const ctx = resolveRunner(repoRoot, file, opts.runner);
  switch (ctx.runner) {
    case 'pytest':
      return pytestOutcome(exec, ctx, repoRoot, nodeid, opts.runTests, t);
    case 'jest':
      return jestOutcome(exec, ctx, repoRoot, nodeid, opts.runTests, t);
    case 'vitest':
    case 'cargo':
    case 'go':
      return {
        ...base,
        outcome: 'unavailable',
        detail: `runner ${ctx.runner} detected; re-derivation is not implemented for it — run the test yourself and cite the artifact`,
      };
    case 'unknown':
      return {
        ...base,
        outcome: 'unavailable',
        detail:
          'no test runner detected (pytest.ini/conftest.py, jest.config.*, vitest.config.*, Cargo.toml, go.mod)',
      };
  }
}

// ─── report ──────────────────────────────────────────────────────────────────

/**
 * Execute the plan's selected, executable checks and return the outcomes.
 * Non-executable checks (`command`) get no outcome; unselected classes get
 * `not_run`. Everything else is observed.
 */
export function buildRederivationReport(
  repoRoot: string,
  plan: RederivationPlan,
  opts: RederiveOptions
): RederivationReport {
  const exec: ExecFileSyncLike = opts.execFile ?? (execFileSync as unknown as ExecFileSyncLike);
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(opts.timeouts ?? {}) };
  const selected = new Set<CheckClass>(opts.classes);
  const outcomes: Record<string, CheckOutcome[]> = {};

  for (const criterion of plan.criteria) {
    const list: CheckOutcome[] = [];
    // The artifact check is anchored at the criterion's own citation when that
    // citation exists; otherwise at HEAD.
    let anchor = 'HEAD';

    for (const check of criterion.checks) {
      if (!check.executable) continue;
      if (!selected.has(check.class)) {
        list.push({
          class: check.class,
          target: check.target,
          outcome: 'not_run',
          detail: 'not selected at this stage',
        });
        continue;
      }
      const outcome = runCheck(exec, repoRoot, check, anchor, opts, timeouts);
      if (check.class === 'citation' && outcome.outcome === 'passed') anchor = check.target;
      list.push(outcome);
    }
    outcomes[criterion.id] = list;
  }
  return { outcomes };
}

function runCheck(
  exec: ExecFileSyncLike,
  repoRoot: string,
  check: DeclaredCheck,
  anchor: string,
  opts: RederiveOptions,
  t: Required<RederiveTimeouts>
): CheckOutcome {
  switch (check.class) {
    case 'citation':
      return citationOutcome(exec, repoRoot, check.target, t.git);
    case 'artifact':
      return artifactOutcome(exec, repoRoot, check.target, anchor, t.git);
    case 'test':
      return testOutcome(exec, repoRoot, check.target, opts, { collect: t.collect, run: t.run });
    case 'command':
      // Unreachable: the plan marks command checks non-executable and the
      // caller skips them. Kept explicit so a future class addition cannot
      // fall through into execution.
      return {
        class: 'command',
        target: check.target,
        outcome: 'not_run',
        detail: 'command is never executed',
      };
  }
}

// ─── convenience ─────────────────────────────────────────────────────────────

export interface RederivationResult {
  readonly plan: RederivationPlan;
  readonly report: RederivationReport;
  readonly verdicts: readonly CriterionVerdict[];
  readonly summary: RederivationSummary;
}

/** Plan, execute, classify, summarize — one call for the shell and the close gate. */
export function rederiveSpecEvidence(
  repoRoot: string,
  spec: Spec,
  opts: RederiveOptions
): RederivationResult {
  const plan = planRederivation(spec);
  const report = buildRederivationReport(repoRoot, plan, opts);
  const verdicts = classifyRederivation(spec, plan, report);
  return { plan, report, verdicts, summary: summarizeRederivation(verdicts) };
}

/** One line per criterion, shared by the close-gate advisory and the CLI table. */
export function describeVerdict(v: CriterionVerdict): string {
  const marker = v.self_reported ? ' [self-reported]' : '';
  const deciding = v.checks.find((c) => c.reason === v.reason);
  const detail = deciding?.detail !== undefined ? ` — ${deciding.detail}` : '';
  const divergence =
    v.divergence !== undefined
      ? ` (acceptance declares ${v.divergence.declared.join(', ')}; evidence names ${v.divergence.reported})`
      : '';
  return `${v.id}: ${v.verdict} (${v.reason})${detail}${marker}${divergence}`;
}
