// `caws hooks list | validate | compile | add | disable | replace | restore`
// — the repo-local hook policy surface (CAWS-HOOKS-READONLY-VERBS-01,
// CAWS-HOOKS-MUTATING-VERBS-01).
//
// Three properties shape this file:
//
//  1. **The read-only verbs are read-only.** `list`, `validate` and
//     `compile --check` open nothing for writing. The diagnosis surface must be
//     usable on a repo you do not want to change — and separable from the verbs
//     that do change it, so "I only looked" is a claim the command surface can
//     back. The mutating half lives below its own banner for the same reason.
//
//  2. **`list` does not reimplement selection.** It shells the launcher's
//     `--describe`, which resolves the same chain execution resolves. A second
//     implementation would be a second thing to keep in sync, and the failure
//     mode would be a listing that disagrees with what actually runs — the
//     precise confusion this whole feature exists to remove.
//
//  3. **The project-wired plane has ONE dispatcher tree, so it has ONE chain
//     per event.** Every project-wired surface (qwen-code, kimi-code, opencode,
//     zcode, dsh) execs the same `.caws/hooks/dispatch/<event>.sh`. A
//     per-surface chain is therefore unrepresentable there, and the compiled
//     sidecar resolves from the policy's `default` surface. `validate` reports
//     a named-surface block that a project-wired dispatcher cannot honor rather
//     than letting it look effective.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';

import { isOk } from '../../kernel';
import { resolveRepoRoot } from '../../store';
import { machineHome } from '../../init/machine-adapters';
import { SHARED_PACK_VERSION } from '../../init/hook-packs/manifest-shared';
import { shippedHandlerProvenance } from '../../init/hook-install';
import {
  type ImportableMachineSurface,
  type PolicyMutation,
  type RepoHookPolicy,
  POLICY_EVENTS,
  REPO_HOOK_POLICY_PATH,
  REPO_POLICY_FLOOR,
  effectiveRepoSurfacePolicy,
  parseRepoHookPolicy,
  policyAddExtension,
  policyDisableHandler,
  policyImportFromMachine,
  policyReplaceHandler,
  policyRestoreHandler,
  serializeRepoHookPolicy,
} from '../../init/repo-hook-policy';
import {
  checkCompiledChains,
  expectedChain,
  installedDispatcherEvents,
  policyDigest,
} from '../../init/hook-chain';

/**
 * Surfaces that exec `.caws/hooks/dispatch/<event>.sh` directly rather than
 * routing through `~/.caws/bin/caws-hook`. They share the dispatcher tree, so
 * they share one compiled chain per event.
 */
export const PROJECT_WIRED_SURFACES: readonly string[] = [
  'qwen-code',
  'kimi-code',
  'opencode',
  'zcode',
  'dsh',
];

const DEFAULT_SURFACE = 'claude-code';

interface RepoContext {
  repoRoot: string;
  /** Raw bytes of the policy file, or null when the repo has none. */
  policyText: string | null;
  policyPath: string;
}

function repoContext(cwd: string): RepoContext | { error: string } {
  const root = resolveRepoRoot(cwd);
  if (!isOk(root)) return { error: 'not inside a git repository' };
  const policyPath = nodePath.join(root.value.repoRoot, REPO_HOOK_POLICY_PATH);
  return {
    repoRoot: root.value.repoRoot,
    policyPath,
    policyText: existsSync(policyPath) ? readFileSync(policyPath, 'utf8') : null,
  };
}

const isError = (v: RepoContext | { error: string }): v is { error: string } => 'error' in v;

// ─── hooks list ────────────────────────────────────────────────────────────

export interface HooksListOptions {
  readonly cwd?: string;
  readonly event?: string;
  readonly surface?: string;
  readonly json?: boolean;
  readonly showData?: boolean;
}

interface DescribedEntry {
  entry: string;
  path: string;
  kind: string;
  /**
   * Absent when the INSTALLED machine runtime predates tier reporting. The
   * runtime under `~/.caws/lib/runtimes/` has its own lifecycle and is only
   * refreshed by `caws init adapters install`, so a current CLI routinely
   * talks to an older launcher. Rendering that as `undefined` would be a lie
   * dressed as data; it is surfaced as `unknown` with the remediation instead.
   */
  tier?: string;
}

const UNKNOWN_TIER = 'unknown';

/**
 * Ask the launcher what it would select. Returns null with a reason when the
 * machine runtime is not installed — which is an ordinary state for a repo
 * whose surfaces are all project-wired, not an error.
 */
function describeSelection(
  repoRoot: string,
  surface: string,
  event: string
): { entries: DescribedEntry[] } | { unavailable: string } {
  const home = machineHome();
  const launcher = nodePath.join(home, 'bin/caws-hook');
  if (!existsSync(launcher)) return { unavailable: `no machine runtime at ${launcher}` };
  try {
    const out = execFileSync('python3', [launcher, surface, event, '--describe'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, CAWS_HOME: home, CAWS_PROJECT_DIR: repoRoot },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(out) as { handlers?: DescribedEntry[] };
    return { entries: parsed.handlers ?? [] };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const detail =
      String(err.stderr ?? err.message ?? '')
        .trim()
        .split('\n')[0] ?? '';
    return { unavailable: `launcher could not describe ${surface}/${event}: ${detail}` };
  }
}

/** `caws hooks list` — always exits 0; it is explanatory, never enforcing. */
export function runHooksListCommand(options: HooksListOptions = {}): number {
  const ctx = repoContext(options.cwd ?? process.cwd());
  if (isError(ctx)) {
    process.stdout.write(`caws hooks list: ${ctx.error}\n`);
    return 0;
  }
  const surface = options.surface ?? process.env.CAWS_AGENT_SURFACE ?? DEFAULT_SURFACE;
  const events = options.event ? [options.event] : [...POLICY_EVENTS];

  // A disabled handler is ABSENT from the resolved chain, so `--describe` can
  // never report it. Reading the document directly is the only way `list` can
  // answer "why is this guard not here?" — which is the question a subtraction
  // exists to raise and its recorded reason exists to answer.
  const parsedPolicy = parseRepoHookPolicy(ctx.policyText);
  const declared = parsedPolicy.ok
    ? effectiveRepoSurfacePolicy(parsedPolicy.policy, surface)
    : null;

  const results = events.map((event) => {
    const described = describeSelection(ctx.repoRoot, surface, event);
    return 'unavailable' in described
      ? { event, unavailable: described.unavailable }
      : { event, handlers: described.entries };
  });

  if (options.json === true) {
    process.stdout.write(
      `${JSON.stringify({
        schema: 'caws.hooks_list.v1',
        surface,
        policy: ctx.policyText === null ? null : REPO_HOOK_POLICY_PATH,
        events: results,
        declared:
          declared === null
            ? null
            : {
                disabled: Object.fromEntries(
                  Object.entries(declared.disabled).filter(([, e]) => e.length > 0)
                ),
                forks: declared.forks,
              },
      })}\n`
    );
    return 0;
  }

  process.stdout.write(`caws hooks list (surface: ${surface})\n`);
  process.stdout.write(
    ctx.policyText === null
      ? `  policy: none (${REPO_HOOK_POLICY_PATH} absent — the stock chain governs)\n`
      : `  policy: ${REPO_HOOK_POLICY_PATH}\n`
  );
  for (const result of results) {
    process.stdout.write(`\n  ${result.event}\n`);
    if ('unavailable' in result) {
      process.stdout.write(`    (unavailable: ${result.unavailable})\n`);
      continue;
    }
    if (result.handlers.length === 0) {
      process.stdout.write('    (empty chain)\n');
      continue;
    }
    for (const handler of result.handlers) {
      const floor = REPO_POLICY_FLOOR.includes(handler.entry.split(' ')[0] ?? handler.entry)
        ? ' [floor]'
        : '';
      process.stdout.write(`    ${handler.entry}  (${handler.tier ?? UNKNOWN_TIER})${floor}\n`);
      if (options.showData === true) process.stdout.write(`      -> ${handler.path}\n`);
    }
  }
  if (declared !== null) {
    const subtractions = Object.entries(declared.disabled).filter(([, e]) => e.length > 0);
    const forks = Object.entries(declared.forks);
    if (subtractions.length > 0 || forks.length > 0) {
      process.stdout.write('\n  declared in the repo policy (absent from the chains above)\n');
      for (const [event, entries] of subtractions) {
        for (const entry of entries) {
          process.stdout.write(
            `    disabled ${event}: ${entry.handler} — ${entry.reason ?? 'no reason recorded'}\n`
          );
        }
      }
      for (const [name, fork] of forks) {
        const lag = SHARED_PACK_VERSION - fork.forked_from.pack_version;
        process.stdout.write(
          `    fork ${name}: ${fork.forked_from.pack}@${fork.forked_from.pack_version} ` +
            `(shipping ${SHARED_PACK_VERSION}${lag > 0 ? `, ${lag} behind` : ''}) ` +
            `approved by ${fork.approver} — ${fork.reason}\n`
        );
      }
    }
  }
  if (results.some((r) => 'handlers' in r && r.handlers.some((h) => h.tier === undefined))) {
    process.stdout.write(
      '\n  note: the installed machine runtime does not report which tier selected a handler,\n' +
        '        so every row above reads "unknown". The runtime has its own lifecycle —\n' +
        '        refresh it with `caws init adapters install`.\n'
    );
  }
  return 0;
}

// ─── hooks validate ────────────────────────────────────────────────────────

export interface HooksValidateOptions {
  readonly cwd?: string;
  readonly json?: boolean;
  readonly showData?: boolean;
}

/**
 * A named-surface block for a project-wired surface parses fine and resolves
 * fine — and then cannot be honored, because those surfaces share one
 * dispatcher and therefore one compiled chain. Reported as a warning rather
 * than a rejection: the document is legal, the expectation is not.
 */
function unhonorableSurfaces(policyText: string | null): string[] {
  if (policyText === null) return [];
  const parsed = parseRepoHookPolicy(policyText);
  if (!parsed.ok) return [];
  return Object.keys(parsed.policy.surfaces).filter((s) => PROJECT_WIRED_SURFACES.includes(s));
}

/** `caws hooks validate` — 0 when valid OR absent, 1 when the document is rejected. */
export function runHooksValidateCommand(options: HooksValidateOptions = {}): number {
  const ctx = repoContext(options.cwd ?? process.cwd());
  if (isError(ctx)) {
    process.stdout.write(`caws hooks validate: ${ctx.error}\n`);
    return 1;
  }
  const parsed = parseRepoHookPolicy(ctx.policyText);
  const warnings = unhonorableSurfaces(ctx.policyText).map(
    (surface) =>
      `surfaces.${surface} is a project-wired surface: it shares one dispatcher with every ` +
      `other project-wired surface, so only surfaces.default reaches the compiled chain`
  );

  if (options.json === true) {
    process.stdout.write(
      `${JSON.stringify({
        schema: 'caws.hooks_validate.v1',
        path: REPO_HOOK_POLICY_PATH,
        present: ctx.policyText !== null,
        valid: parsed.ok,
        ...(parsed.ok ? {} : { error: parsed.error }),
        warnings,
      })}\n`
    );
    return parsed.ok ? 0 : 1;
  }

  if (ctx.policyText === null) {
    process.stdout.write(
      `caws hooks validate: ${REPO_HOOK_POLICY_PATH} is absent — valid.\n` +
        '  A repo that never opts in is governed by the stock chain, which is not an error state.\n'
    );
    return 0;
  }
  if (!parsed.ok) {
    process.stdout.write(`caws hooks validate: ${REPO_HOOK_POLICY_PATH} REJECTED\n`);
    process.stdout.write(`  ${parsed.error}\n`);
    process.stdout.write(
      '  Nothing was applied. The document is read all-or-nothing on purpose: a partially\n' +
        '  applied guard policy is how a guard silently stops running.\n'
    );
    return 1;
  }
  process.stdout.write(`caws hooks validate: ${REPO_HOOK_POLICY_PATH} is valid.\n`);
  for (const warning of warnings) process.stdout.write(`  warning: ${warning}\n`);
  return 0;
}

// ─── hooks compile --check ─────────────────────────────────────────────────

export interface HooksCompileCheckOptions {
  readonly cwd?: string;
  readonly event?: string;
  readonly json?: boolean;
  readonly showData?: boolean;
}

/** `caws hooks compile --check` — 0 when every event agrees, 1 when any is stale. */
export function runHooksCompileCheckCommand(options: HooksCompileCheckOptions = {}): number {
  const ctx = repoContext(options.cwd ?? process.cwd());
  if (isError(ctx)) {
    process.stdout.write(`caws hooks compile --check: ${ctx.error}\n`);
    return 1;
  }
  const parsed = parseRepoHookPolicy(ctx.policyText);
  if (!parsed.ok) {
    process.stdout.write(
      `caws hooks compile --check: ${REPO_HOOK_POLICY_PATH} is invalid, so no chain can be ` +
        `computed to compare against.\n  ${parsed.error}\n`
    );
    return 1;
  }
  const dispatchDir = nodePath.join(ctx.repoRoot, '.caws/hooks/dispatch');
  if (!existsSync(dispatchDir)) {
    process.stdout.write(
      'caws hooks compile --check: no .caws/hooks/dispatch — this repo has no project-wired ' +
        'dispatcher to compile for.\n'
    );
    return 0;
  }
  // The compiled sidecar serves every project-wired surface at once, so it
  // resolves from `default` — see the header note. The comparison itself is
  // `checkCompiledChains`, shared with `compile` and with doctor so the three
  // cannot disagree about whether a chain is current.
  const checks = checkCompiledChains({
    dispatchDir,
    repo: effectiveRepoSurfacePolicy(parsed.policy, 'default'),
    digest: policyDigest(ctx.policyText),
    policyPresent: ctx.policyText !== null,
    ...(options.event ? { events: [options.event] } : {}),
  });

  const stale = checks.filter((c) => c.stale);
  if (options.json === true) {
    process.stdout.write(
      `${JSON.stringify({
        schema: 'caws.hooks_compile_check.v1',
        wrote: false,
        events: checks,
        stale: stale.length,
      })}\n`
    );
    return stale.length === 0 ? 0 : 1;
  }

  if (checks.length === 0) {
    process.stdout.write('caws hooks compile --check: no installed dispatchers to check.\n');
    return 0;
  }
  if (stale.length === 0) {
    process.stdout.write(
      `caws hooks compile --check: all ${checks.length} compiled chain(s) are current. ` +
        'Nothing was written.\n'
    );
    return 0;
  }
  process.stdout.write(`caws hooks compile --check: ${stale.length} stale chain(s).\n`);
  for (const check of stale) process.stdout.write(`  ${check.event}: ${check.reason}\n`);
  process.stdout.write('  Nothing was written. Run `caws hooks compile` to bring them current.\n');
  return 1;
}

// ─── the mutating half (CAWS-HOOKS-MUTATING-VERBS-01) ──────────────────────
//
// Four properties shape this half:
//
//  1. **Compute everything, then write once.** Every verb validates, mutates an
//     in-memory policy, and only then touches the filesystem — so a refusal
//     leaves `.caws/` byte-identical. `compile` renders every chain before it
//     writes any, for the same reason.
//
//  2. **The mutators own the rules, this file owns the flags.** Floor checks,
//     reason lengths and the serialize/parse round trip live in
//     repo-hook-policy.ts, where the launcher's sibling validator can be read
//     against them. This layer must not grow a second, divergent copy.
//
//  3. **A mutating verb defaults to `default`, unlike `list`.** `list` answers
//     "what runs for ME", so it defaults to the surface you are running under.
//     A written decision is the TEAM's, and the project-wired plane can only
//     honor `default`, so a narrower default here would quietly produce
//     policies that five of the seven surfaces ignore.
//
//  4. **replace always carries provenance.** It reads the shipped template it
//     is forking and records pack, version and sha256. A repo that cannot be
//     told how far its fork has drifted is the failure this feature exists to
//     end, so a handler with no shipped file to fork is refused rather than
//     recorded without provenance.

/** The surface a written decision lands on unless `--surface` narrows it. */
const DEFAULT_WRITE_SURFACE = 'default';

interface MutableContext extends RepoContext {
  policy: RepoHookPolicy;
}

function mutableContext(cwd: string): MutableContext | { error: string } {
  const ctx = repoContext(cwd);
  if (isError(ctx)) return ctx;
  const parsed = parseRepoHookPolicy(ctx.policyText);
  if (!parsed.ok) {
    // Refuse rather than start from the identity policy: overwriting a document
    // this build cannot read would discard decisions a human recorded, and the
    // agent running the verb is the party least able to notice what was lost.
    return {
      error:
        `${REPO_HOOK_POLICY_PATH} is invalid, so it cannot be amended without discarding ` +
        `whatever it currently declares.\n  ${parsed.error}\n  Repair the file, then retry.`,
    };
  }
  return { ...ctx, policy: parsed.policy };
}

/** Render and write the document. The only write path for the policy file. */
function persist(ctx: RepoContext, policy: RepoHookPolicy): string | null {
  try {
    mkdirSync(nodePath.dirname(ctx.policyPath), { recursive: true });
    writeFileSync(ctx.policyPath, serializeRepoHookPolicy(policy), 'utf8');
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export interface HooksMutationOptions {
  readonly cwd?: string;
  readonly surface?: string;
  readonly json?: boolean;
}

/**
 * Settle one mutating verb: refuse without writing, or write and report what
 * moved. Every verb routes through here so the write/refuse asymmetry — and
 * the "nothing was written" wording a refusal owes the caller — is stated once.
 */
function settleVerb(
  verb: string,
  ctx: MutableContext,
  mutation: PolicyMutation,
  json: boolean
): number {
  if (!mutation.ok) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          schema: 'caws.hooks_mutation.v1',
          verb,
          wrote: false,
          error: mutation.error,
        })}\n`
      );
      return 1;
    }
    process.stdout.write(
      `caws hooks ${verb}: refused. Nothing was written.\n  ${mutation.error}\n`
    );
    return 1;
  }
  const failure = persist(ctx, mutation.policy);
  if (failure !== null) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          schema: 'caws.hooks_mutation.v1',
          verb,
          wrote: false,
          error: failure,
        })}\n`
      );
      return 1;
    }
    process.stdout.write(
      `caws hooks ${verb}: could not write ${REPO_HOOK_POLICY_PATH}.\n  ${failure}\n`
    );
    return 1;
  }
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        schema: 'caws.hooks_mutation.v1',
        verb,
        wrote: true,
        path: REPO_HOOK_POLICY_PATH,
        changed: mutation.changed,
      })}\n`
    );
    return 0;
  }
  process.stdout.write(`caws hooks ${verb}: wrote ${REPO_HOOK_POLICY_PATH}\n`);
  for (const line of mutation.changed) process.stdout.write(`  ${line}\n`);
  process.stdout.write(
    '  The project-wired dispatchers still run their previous chain until you run ' +
      '`caws hooks compile`.\n'
  );
  return 0;
}

export interface HooksAddOptions extends HooksMutationOptions {
  readonly event?: string;
  readonly before?: string;
  readonly path?: string;
  readonly reason?: string;
}

export function runHooksAddCommand(handler: string, options: HooksAddOptions = {}): number {
  const ctx = mutableContext(options.cwd ?? process.cwd());
  if (isError(ctx)) {
    process.stdout.write(`caws hooks add: ${ctx.error}\n`);
    return 1;
  }
  if (options.event === undefined) {
    process.stdout.write('caws hooks add: --event is required (a chain belongs to one event).\n');
    return 1;
  }
  return settleVerb(
    'add',
    ctx,
    policyAddExtension(ctx.policy, {
      surface: options.surface ?? DEFAULT_WRITE_SURFACE,
      event: options.event,
      handler,
      before: options.before ?? null,
      reason: options.reason ?? '',
      ...(options.path === undefined ? {} : { path: options.path }),
    }),
    options.json === true
  );
}

export interface HooksDisableOptions extends HooksMutationOptions {
  readonly event?: string;
  readonly reason?: string;
}

export function runHooksDisableCommand(handler: string, options: HooksDisableOptions = {}): number {
  const ctx = mutableContext(options.cwd ?? process.cwd());
  if (isError(ctx)) {
    process.stdout.write(`caws hooks disable: ${ctx.error}\n`);
    return 1;
  }
  if (options.event === undefined) {
    process.stdout.write(
      'caws hooks disable: --event is required (a guard is disabled for one event, not globally).\n'
    );
    return 1;
  }
  return settleVerb(
    'disable',
    ctx,
    policyDisableHandler(ctx.policy, {
      surface: options.surface ?? DEFAULT_WRITE_SURFACE,
      event: options.event,
      handler,
      reason: options.reason ?? '',
    }),
    options.json === true
  );
}

/**
 * Provenance for the shipped file a fork is taken from.
 *
 * Refuses when nothing ships under that name: that is not a replacement, it is
 * an addition, and recording it as a fork would invent a baseline that doctor
 * would later compare against.
 */
function shippedProvenance(
  handler: string
): { pack: string; pack_version: number; sha256: string } | { error: string } {
  // Deliberately the SAME function doctor uses to measure fork lag. Two
  // implementations of "what does the pack ship under this name" would make
  // every fork read as drifted the instant it was recorded.
  const provenance = shippedHandlerProvenance(handler);
  if (provenance === null) {
    return {
      error:
        `the shared pack ships no readable ${handler}, so there is nothing to fork from. ` +
        `Use \`caws hooks add ${handler} --event <e> --path <rel>\` to add a new handler instead.`,
    };
  }
  return { ...provenance };
}

export interface HooksReplaceOptions extends HooksMutationOptions {
  readonly with?: string;
  readonly reason?: string;
  readonly approver?: string;
}

export function runHooksReplaceCommand(handler: string, options: HooksReplaceOptions = {}): number {
  const ctx = mutableContext(options.cwd ?? process.cwd());
  if (isError(ctx)) {
    process.stdout.write(`caws hooks replace: ${ctx.error}\n`);
    return 1;
  }
  if (options.with === undefined) {
    process.stdout.write('caws hooks replace: --with <repo-relative-path> is required.\n');
    return 1;
  }
  const provenance = shippedProvenance(handler);
  if ('error' in provenance) {
    process.stdout.write(
      `caws hooks replace: refused. Nothing was written.\n  ${provenance.error}\n`
    );
    return 1;
  }
  return settleVerb(
    'replace',
    ctx,
    policyReplaceHandler(ctx.policy, {
      surface: options.surface ?? DEFAULT_WRITE_SURFACE,
      handler,
      path: options.with,
      reason: options.reason ?? '',
      approver: options.approver ?? '',
      forkedFrom: provenance,
    }),
    options.json === true
  );
}

export interface HooksRestoreOptions extends HooksMutationOptions {
  readonly event?: string;
}

export function runHooksRestoreCommand(handler: string, options: HooksRestoreOptions = {}): number {
  const ctx = mutableContext(options.cwd ?? process.cwd());
  if (isError(ctx)) {
    process.stdout.write(`caws hooks restore: ${ctx.error}\n`);
    return 1;
  }
  return settleVerb(
    'restore',
    ctx,
    policyRestoreHandler(ctx.policy, {
      surface: options.surface ?? DEFAULT_WRITE_SURFACE,
      handler,
      ...(options.event === undefined ? {} : { event: options.event }),
    }),
    options.json === true
  );
}

export interface HooksCompileOptions {
  readonly cwd?: string;
  readonly event?: string;
  readonly json?: boolean;
}

/**
 * `caws hooks compile` — write the sidecars the project-wired dispatchers read.
 *
 * Renders EVERY chain before writing ANY. A chain the parser would refuse makes
 * `renderChainFile` throw, and a half-written set would arm exactly the outage
 * this ordering prevents: `local-chain.sh` blocks and exits 2 on a malformed
 * line, so one bad sidecar refuses every tool call on five surfaces, from a
 * file under `.caws/hooks/` that the agent is not permitted to repair.
 */
export function runHooksCompileCommand(options: HooksCompileOptions = {}): number {
  const ctx = repoContext(options.cwd ?? process.cwd());
  if (isError(ctx)) {
    process.stdout.write(`caws hooks compile: ${ctx.error}\n`);
    return 1;
  }
  const parsed = parseRepoHookPolicy(ctx.policyText);
  if (!parsed.ok) {
    process.stdout.write(
      `caws hooks compile: refused. Nothing was written.\n  ${REPO_HOOK_POLICY_PATH} is invalid, ` +
        `so no chain can be computed.\n  ${parsed.error}\n`
    );
    return 1;
  }
  const dispatchDir = nodePath.join(ctx.repoRoot, '.caws/hooks/dispatch');
  if (!existsSync(dispatchDir)) {
    process.stdout.write(
      'caws hooks compile: no .caws/hooks/dispatch — this repo has no project-wired dispatcher ' +
        'to compile for. Nothing was written.\n'
    );
    return 0;
  }
  const installed = installedDispatcherEvents(dispatchDir);
  const events = options.event ? installed.filter((e) => e === options.event) : installed;
  const repo = effectiveRepoSurfacePolicy(parsed.policy, 'default');
  const digest = policyDigest(ctx.policyText);

  const rendered: { event: string; text: string }[] = [];
  for (const event of events) {
    const expected = expectedChain(dispatchDir, event, repo, digest);
    if ('error' in expected) {
      process.stdout.write(
        `caws hooks compile: refused. Nothing was written.\n  ${event}: ${expected.error}\n`
      );
      return 1;
    }
    rendered.push({ event, text: expected.text });
  }

  const written: string[] = [];
  for (const chain of rendered) {
    const chainPath = nodePath.join(dispatchDir, `${chain.event}.chain`);
    try {
      writeFileSync(chainPath, chain.text, 'utf8');
    } catch (e) {
      process.stdout.write(
        `caws hooks compile: wrote ${written.length} chain(s) before failing on ${chain.event}.\n` +
          `  ${(e as Error).message}\n  Re-run to finish; compiling is idempotent.\n`
      );
      return 1;
    }
    written.push(chain.event);
  }

  if (options.json === true) {
    process.stdout.write(
      `${JSON.stringify({
        schema: 'caws.hooks_compile.v1',
        wrote: true,
        events: written,
      })}\n`
    );
    return 0;
  }
  if (written.length === 0) {
    process.stdout.write('caws hooks compile: no installed dispatchers to compile for.\n');
    return 0;
  }
  process.stdout.write(`caws hooks compile: wrote ${written.length} chain(s).\n`);
  for (const event of written) {
    process.stdout.write(`  .caws/hooks/dispatch/${event}.chain\n`);
  }
  return 0;
}

// ─── hooks import --from-machine ───────────────────────────────────────────
//
// The one verb that writes TWO stores, and the only reason it is not a
// `settleVerb` call like its siblings. Everything above changes one file in
// the repo; this also has to empty the machine keys it just migrated, or the
// entry exists in both tiers and gets spliced twice.
//
// Those stores cannot be written atomically — different filesystems, one of
// them outside the repo entirely — so the question is not how to avoid a
// partial state but which partial state to fail into. Repo-first is chosen
// because its failure (both tiers populated) is refused by name at resolve
// time, while machine-first fails by dropping the override with nothing left
// to notice it.

/** Machine project state, as much of it as import needs to read and rewrite. */
interface MachineProjectSettings {
  version: number;
  root: string;
  surfaces: Record<string, ImportableMachineSurface>;
}

export interface HooksImportOptions {
  readonly cwd?: string;
  readonly fromMachine?: boolean;
  readonly plan?: boolean;
  readonly json?: boolean;
}

function machineStatePath(repoRoot: string): string {
  return nodePath.join(
    machineHome(),
    'state/projects',
    createHash('sha256').update(realpathSync(repoRoot)).digest('hex') + '.json'
  );
}

/**
 * Empty the migrated surfaces' override keys, leaving the file and every other
 * key intact.
 *
 * It rewrites rather than deletes: the file also records `root` and any
 * surface the import did not touch, and a surface whose keys are all empty is
 * still a surface the operator registered. Deleting it would silently
 * de-register the project from the machine runtime.
 */
function clearMachineSurfaces(statePath: string, surfaces: readonly string[]): string | null {
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as MachineProjectSettings;
    for (const name of surfaces) {
      const surface = raw.surfaces?.[name];
      if (!surface) continue;
      surface.disabled = {};
      surface.extensions = {};
      surface.handlers = {};
      surface.libraries = {};
    }
    writeFileSync(statePath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export function runHooksImportCommand(options: HooksImportOptions = {}): number {
  if (options.fromMachine !== true) {
    process.stdout.write(
      'caws hooks import: --from-machine is required. It is the only source this verb reads, ' +
        'and naming it keeps the command honest if another source is ever added.\n'
    );
    return 1;
  }
  const ctx = mutableContext(options.cwd ?? process.cwd());
  if (isError(ctx)) {
    process.stdout.write(`caws hooks import: ${ctx.error}\n`);
    return 1;
  }

  const statePath = machineStatePath(ctx.repoRoot);
  if (!existsSync(statePath)) {
    process.stdout.write(
      `caws hooks import: this project has no machine state at ${statePath}, so there is ` +
        'nothing to migrate. A repo whose surfaces are all project-wired never had any.\n'
    );
    return 1;
  }

  let settings: MachineProjectSettings;
  try {
    settings = JSON.parse(readFileSync(statePath, 'utf8')) as MachineProjectSettings;
  } catch (e) {
    process.stdout.write(
      `caws hooks import: could not read ${statePath}: ${(e as Error).message}\n`
    );
    return 1;
  }

  const mutation = policyImportFromMachine(ctx.policy, { machine: settings.surfaces ?? {} });
  if (!mutation.ok) {
    if (options.json === true) {
      process.stdout.write(
        `${JSON.stringify({
          schema: 'caws.hooks_import.v1',
          wrote: false,
          cleared: [],
          error: mutation.error,
        })}\n`
      );
      return 1;
    }
    process.stdout.write(`caws hooks import: refused. Nothing was written.\n  ${mutation.error}\n`);
    return 1;
  }

  if (options.plan === true) {
    if (options.json === true) {
      process.stdout.write(
        `${JSON.stringify({
          schema: 'caws.hooks_import.v1',
          plan: true,
          wrote: false,
          path: REPO_HOOK_POLICY_PATH,
          changed: mutation.changed,
          wouldClear: mutation.clear,
          machineState: statePath,
        })}\n`
      );
      return 0;
    }
    process.stdout.write(`caws hooks import --plan: would write ${REPO_HOOK_POLICY_PATH}\n`);
    for (const line of mutation.changed) process.stdout.write(`  ${line}\n`);
    process.stdout.write(
      `  would then clear these surfaces in ${statePath}: ${mutation.clear.join(', ')}\n` +
        '  Nothing was written.\n'
    );
    return 0;
  }

  // Repo first. See the banner above for why this order and not the reverse.
  const writeFailure = persist(ctx, mutation.policy);
  if (writeFailure !== null) {
    process.stdout.write(
      `caws hooks import: could not write ${REPO_HOOK_POLICY_PATH}.\n  ${writeFailure}\n` +
        '  Machine state is untouched, so the overrides are still in effect.\n'
    );
    return 1;
  }

  const clearFailure = clearMachineSurfaces(statePath, mutation.clear);
  if (clearFailure !== null) {
    // Half-migrated, and deliberately loud about it: both tiers now declare the
    // same handlers, so resolveChain refuses by name until this is finished.
    process.stdout.write(
      `caws hooks import: wrote ${REPO_HOOK_POLICY_PATH}, but could NOT clear ${statePath}.\n` +
        `  ${clearFailure}\n` +
        '  Both tiers now declare these handlers, so hook dispatch will REFUSE by name until ' +
        'the machine keys are emptied. That refusal is the intended failure: it is loud, and ' +
        'it never runs a guard twice. Empty the surfaces in the file above, then run ' +
        '`caws hooks list` to confirm.\n'
    );
    return 1;
  }

  if (options.json === true) {
    process.stdout.write(
      `${JSON.stringify({
        schema: 'caws.hooks_import.v1',
        wrote: true,
        path: REPO_HOOK_POLICY_PATH,
        changed: mutation.changed,
        cleared: mutation.clear,
        machineState: statePath,
      })}\n`
    );
    return 0;
  }
  process.stdout.write(`caws hooks import: wrote ${REPO_HOOK_POLICY_PATH}\n`);
  for (const line of mutation.changed) process.stdout.write(`  ${line}\n`);
  process.stdout.write(
    `  cleared migrated keys for ${mutation.clear.join(', ')} in ${statePath}\n` +
      '  Imported extensions record that no justification was captured in machine state. ' +
      'Replace those reasons with real ones — they propagate to every clone.\n' +
      '  The project-wired dispatchers still run their previous chain until you run ' +
      '`caws hooks compile`.\n'
  );
  return 0;
}
