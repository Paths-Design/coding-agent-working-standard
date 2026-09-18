// `caws hooks list | validate | compile --check` — the read-only half of the
// repo-local hook policy surface (CAWS-HOOKS-READONLY-VERBS-01).
//
// Three properties shape this file:
//
//  1. **Read-only means read-only.** Nothing here opens a file for writing,
//     including `compile --check`. The diagnosis surface must be usable on a
//     repo you do not want to change — and separable from the verb that does
//     change it, so "I only looked" is a claim the command surface can back.
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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as nodePath from 'node:path';

import { isOk } from '../../kernel';
import { resolveRepoRoot } from '../../store';
import { machineHome } from '../../init/machine-adapters';
import { extractMachineHandlers } from '../../init/machine-handler-policy';
import { SHARED_PACK_VERSION } from '../../init/hook-packs/manifest-shared';
import {
  POLICY_EVENTS,
  REPO_HOOK_POLICY_PATH,
  REPO_POLICY_FLOOR,
  effectiveRepoSurfacePolicy,
  parseRepoHookPolicy,
  resolveChain,
} from '../../init/repo-hook-policy';
import { chainStaleness, policyDigest, renderChainFile } from '../../init/hook-chain';

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

interface EventCheck {
  event: string;
  stale: boolean;
  reason?: string;
}

/**
 * Read the stock chain out of the installed dispatcher rather than keeping a
 * second copy of it here. `extractMachineHandlers` already refuses anything
 * that is not known scaffolding, so a hand-modified dispatcher surfaces as an
 * explicit failure instead of being silently compiled against.
 */
function stockChain(dispatchDir: string, event: string): string[] | { error: string } {
  const file = nodePath.join(dispatchDir, `${event}.sh`);
  if (!existsSync(file)) return { error: 'no dispatcher installed for this event' };
  const text = readFileSync(file, 'utf8');
  try {
    return extractMachineHandlers(text, text);
  } catch (e) {
    return { error: (e as Error).message };
  }
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
  const installed = new Set(
    readdirSync(dispatchDir)
      .filter((name) => name.endsWith('.sh'))
      .map((name) => name.slice(0, -3))
  );
  const events = (options.event ? [options.event] : [...POLICY_EVENTS]).filter((e) =>
    installed.has(e)
  );
  // The compiled sidecar serves every project-wired surface at once, so it
  // resolves from `default` — see the header note.
  const repo = effectiveRepoSurfacePolicy(parsed.policy, 'default');
  const digest = policyDigest(ctx.policyText);

  const checks: EventCheck[] = [];
  for (const event of events) {
    const stock = stockChain(dispatchDir, event);
    if ('error' in stock) {
      checks.push({ event, stale: true, reason: stock.error });
      continue;
    }
    const resolved = resolveChain({ stock, event, repo });
    if (!resolved.ok) {
      checks.push({ event, stale: true, reason: resolved.error });
      continue;
    }
    const expected = renderChainFile({
      surface: 'default',
      event,
      policySha256: digest,
      pack: SHARED_PACK_VERSION,
      handlers: resolved.handlers,
      overrides: resolved.handlerOverrides,
    });
    const chainPath = nodePath.join(dispatchDir, `${event}.chain`);
    const onDisk = existsSync(chainPath) ? readFileSync(chainPath, 'utf8') : null;
    // A repo with no policy and no sidecar is FRESH, not stale: the stock
    // array in the dispatcher already is the whole chain, and compiling a
    // sidecar that merely restates it would add a file to keep in sync for no
    // behavioral gain.
    if (onDisk === null && ctx.policyText === null) {
      checks.push({ event, stale: false });
      continue;
    }
    const staleness = chainStaleness(onDisk, expected);
    checks.push(
      staleness.stale ? { event, stale: true, reason: staleness.reason } : { event, stale: false }
    );
  }

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
