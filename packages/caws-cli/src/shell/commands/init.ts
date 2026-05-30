// `caws init` — vNext bootstrap of the canonical .caws/ shape, plus
// optional hook-pack install for the operating agent harness.
//
// Pipeline:
//   1. resolveRepoRoot(cwd)             — needs git, NOT .caws/
//   2. initProject(repoRoot)            — store-side adapter does the work
//   3. render canonical-state result    — step 1 message
//   4. resolve agent surface            — from --agent-surface or detection
//   5. install hook pack (or skip)      — step 2 message
//   6. inspect .claude/settings.json    — step 3 message
//   7. emit activation contract         — step 4 message
//
// The init surface is **non-interactive**. All decisions come from CLI
// flags or filesystem signals; nothing prompts. Each step prints a
// clearly-labeled section so a turn-by-turn agent can read what
// happened and what to do next.
//
// Exit codes:
//   0 = canonical state established (created OR already_initialized)
//       AND hook-pack step did not refuse files
//   1 = legacy residue refused (INIT_LEGACY_RESIDUE)
//       OR hook-pack install refused one or more files (use --adopt or
//       --overwrite to resolve)
//   2 = repo-root resolution failed, write I/O failed, or default
//       policy invalid

import { execFileSync } from 'child_process';
import {
  detectAgentHarness,
  type HarnessDetectionResult,
} from '../../init/harness-detect';
import {
  detectOrphanedDispatchDir,
  inspectClaudeSettings,
  installHookPack,
  mergeClaudeSettings,
  writeSettingsExample,
} from '../../init/hook-install';
import {
  isKnownSurface,
  resolveHookPack,
} from '../../init/hook-packs/register';
import type {
  AgentSurface,
  HookPackInstallResult,
} from '../../init/hook-packs/types';
import { manageGitignore } from '../../init/gitignore-manage';
import { initProject, resolveRepoRoot } from '../../store';
import { renderDiagnostics } from '../render/diagnostic';
import {
  renderGitignore,
  renderGitignoreSkippedNotGit,
} from '../render/init-gitignore';
import { renderInit } from '../render/init';
import {
  renderActivationContract,
  renderHookPackInstall,
  renderSettingsWiring,
} from '../render/init-hook-pack';
import type {
  SettingsMergeResult,
} from '../../init/hook-install';

function isInsideGitWorkingTree(cwd: string): boolean {
  try {
    const r = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return r.trim() === 'true';
  } catch {
    return false;
  }
}

export interface InitCommandOptions {
  readonly cwd?: string;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly showData?: boolean;
  /** Selected agent harness. When undefined, the command attempts
   *  filesystem detection. */
  readonly agentSurface?: AgentSurface;
  /** When true, overwrite drifted/unmanaged files at managed pack paths. */
  readonly overwrite?: boolean;
  /** When true, leave drifted/unmanaged files in place; do not enforce
   *  pack contents at those paths. */
  readonly adopt?: boolean;
}

function chooseSurface(
  explicit: AgentSurface | undefined,
  detection: HarnessDetectionResult
): {
  readonly surface: AgentSurface | null;
  readonly reason: 'explicit' | 'detected' | 'ambiguous' | 'none';
} {
  if (explicit !== undefined) {
    return { surface: explicit, reason: 'explicit' };
  }
  if (detection.kind === 'single') {
    return { surface: detection.surface, reason: 'detected' };
  }
  if (detection.kind === 'ambiguous') {
    return { surface: null, reason: 'ambiguous' };
  }
  return { surface: null, reason: 'none' };
}

function performHookPackStep(
  repoRoot: string,
  surface: AgentSurface | null,
  reason: 'explicit' | 'detected' | 'ambiguous' | 'none',
  options: InitCommandOptions
): HookPackInstallResult {
  if (surface === null) {
    // No surface chosen — emit skipped_ambiguous.
    return {
      outcome: 'skipped_ambiguous',
      pack: null,
      actions: [],
      activation: 'not_applicable',
    };
  }
  if (surface === 'none') {
    return {
      outcome: 'skipped_explicit_none',
      pack: null,
      actions: [],
      activation: 'not_applicable',
    };
  }

  const resolution = resolveHookPack(surface);
  if (resolution.kind === 'declared_not_implemented') {
    // Treat as a skip with a clear message in the renderer.
    return {
      outcome: 'skipped_ambiguous',
      pack: null,
      actions: [],
      activation: 'not_applicable',
    };
  }
  if (resolution.kind === 'none') {
    return {
      outcome: 'skipped_explicit_none',
      pack: null,
      actions: [],
      activation: 'not_applicable',
    };
  }

  const installOpts: Parameters<typeof installHookPack>[1] = { repoRoot };
  if (options.overwrite !== undefined) {
    (installOpts as { overwrite?: boolean }).overwrite = options.overwrite;
  }
  if (options.adopt !== undefined) {
    (installOpts as { adopt?: boolean }).adopt = options.adopt;
  }
  return installHookPack(resolution.pack, installOpts);
}

export function runInitCommand(opts: InitCommandOptions = {}): number {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;

  // Validate --agent-surface early. An unknown value is a programmer
  // error from the caller (or a typo at the CLI); fail fast with a
  // clear diagnostic.
  if (
    opts.agentSurface !== undefined &&
    !isKnownSurface(opts.agentSurface)
  ) {
    err(`caws init: unknown --agent-surface "${opts.agentSurface}".`);
    err('  Known values: claude-code, cursor, windsurf, none.');
    return 2;
  }

  // Step 0: resolve repo root.
  const root = resolveRepoRoot(cwd);
  if (!root.ok) {
    err('caws init: failed to resolve repo root.');
    err(renderDiagnostics(root.errors, { showData }));
    return 2;
  }
  const { repoRoot } = root.value;

  // Step 1: bootstrap canonical .caws/ state.
  const result = initProject(repoRoot);
  if (!result.ok) {
    const isLegacy = result.errors.some(
      (d) => d.rule === 'store.init.legacy_residue'
    );
    err(
      isLegacy
        ? 'caws init: refusing to overwrite legacy state.'
        : 'caws init: failed to bootstrap project.'
    );
    err(renderDiagnostics(result.errors, { showData }));
    return isLegacy ? 1 : 2;
  }
  out(renderInit({ result: result.value, repoRoot }));

  // Step 1b: manage the .gitignore ephemeral-state block. Step 1 (initProject)
  // just wrote agents.json + worktrees.json to disk; without ignore rules they
  // are untracked-but-not-ignored, inviting accidental commits. This writes a
  // marked, idempotent block ignoring ephemeral .caws/ state while leaving
  // authority state (specs/policy/waivers) tracked. Advisory: a write failure
  // is a warning, not a hard error — init's exit code is unchanged.
  //
  // Gated on git presence: a .gitignore in a non-git directory is inert noise,
  // so skip the step (same predicate the commit-hint at step 5 uses).
  if (isInsideGitWorkingTree(repoRoot)) {
    const gitignoreResult = manageGitignore(repoRoot, {
      adopt: opts.adopt === true,
    });
    out(renderGitignore(gitignoreResult));
  } else {
    out(renderGitignoreSkippedNotGit());
  }

  // Step 2: choose the agent surface and install the hook pack.
  const detection = detectAgentHarness(repoRoot);
  const chosen = chooseSurface(opts.agentSurface, detection);
  const hookPackResult = performHookPackStep(
    repoRoot,
    chosen.surface,
    chosen.reason,
    opts
  );

  // When detection produced an ambiguous result and no explicit flag,
  // the renderer's skipped_ambiguous branch handles the message.
  // When the user requested an unimplemented surface (cursor, windsurf
  // today), the renderer surfaces it as a skipped-ambiguous with the
  // same instruction shape.
  if (
    opts.agentSurface !== undefined &&
    opts.agentSurface !== 'none' &&
    chosen.surface !== null
  ) {
    const resolution = resolveHookPack(opts.agentSurface);
    if (resolution.kind === 'declared_not_implemented') {
      err(
        `caws init: --agent-surface "${opts.agentSurface}" is declared but not yet implemented in this CLI version.`
      );
      err('  Known values: claude-code, cursor, windsurf, none.');
      err('  Implemented values: claude-code.');
      // Surface the canonical-state success (step 1 already printed) so
      // the user knows .caws/ is set up.
      return 1;
    }
  }

  out(renderHookPackInstall(hookPackResult));

  // Step 3: wire .claude/settings.json. Only meaningful when a pack was
  // actually installed (claude-code in v11.1). For 'none' or
  // 'skipped_ambiguous', skip. Unlike pre-CAWS-INIT-SETTINGS-WIRING-001
  // (which only printed a snippet), init now MERGES the four caws_dispatch
  // entries into settings.json non-destructively, always emits a
  // settings.json.example reference, and warns (but never deletes) on a
  // leftover pre-rename .claude/hooks/dispatch/ directory.
  let wiringStatus: ReturnType<typeof inspectClaudeSettings> | undefined;
  let mergeResult: SettingsMergeResult | undefined;
  let orphanedDispatchDir: string | null = null;
  if (hookPackResult.pack !== null) {
    mergeResult = mergeClaudeSettings(repoRoot);
    writeSettingsExample(repoRoot);
    orphanedDispatchDir = detectOrphanedDispatchDir(repoRoot);
    // Re-inspect AFTER the merge so the activation panel reflects the
    // now-wired state (a merge that created/merged leaves it 'wired';
    // an invalid file leaves it 'invalid').
    wiringStatus = inspectClaudeSettings(repoRoot);
    out(renderSettingsWiring(wiringStatus, mergeResult, orphanedDispatchDir));
  }

  // Step 4: activation contract. The contract message tailors to whether
  // anything was actually installed/updated this run AND whether the
  // settings.json wiring is in place — without those signals the panel
  // becomes a constant STOP sign on re-runs, training agents to ignore
  // it.
  out(renderActivationContract(hookPackResult, wiringStatus));

  // Step 5: first-contact commit hint. When .caws/ was newly created
  // (not 'already_initialized') AND the cwd is a real git working tree,
  // emit a one-line next-step pointing the user at the commit they need
  // to run to persist governance state. Without this hint, users miss
  // that .caws/ is untracked and lose state on branch switches.
  // Outside a git working tree, the hint would be misleading — skip it.
  if (
    result.value.outcome === 'created' &&
    isInsideGitWorkingTree(repoRoot)
  ) {
    out('');
    out(
      'Next: stage and commit the .caws/ directory to persist governance state:'
    );
    out('  git add .caws/ && git commit -m "chore: add caws governance state"');
  }

  // Exit code: refusal in pack install → 1 so callers see something went
  // wrong; otherwise 0.
  const anyRefused = hookPackResult.actions.some(
    (a) => a.action === 'refused'
  );
  return anyRefused ? 1 : 0;
}
