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
  inspectZcodeConfig,
  installHookPack,
  mergeClaudeSettings,
  mergeZcodeConfig,
  planClaudeSettingsMerge,
  planHookPackInstall,
  planSettingsExample,
  planZcodeConfigExample,
  planZcodeConfigMerge,
  writeSettingsExample,
  writeZcodeConfigExample,
} from '../../init/hook-install';
import {
  IMPLEMENTED_SURFACES,
  KNOWN_SURFACES,
  isKnownSurface,
  resolveHookPack,
} from '../../init/hook-packs/register';
import { SHARED_PACK } from '../../init/hook-packs/manifest-shared';
import type {
  AgentSurface,
  HookPackInstallResult,
} from '../../init/hook-packs/types';
import {
  manageGitignore,
  planGitignore,
  type GitignorePlanResult,
} from '../../init/gitignore-manage';
import {
  initProject,
  planInitProject,
  resolveRepoRoot,
  type InitProjectPlan,
} from '../../store';
import { renderDiagnostics } from '../render/diagnostic';
import {
  renderGitignore,
  renderGitignoreSkippedNotGit,
} from '../render/init-gitignore';
import { renderInit } from '../render/init';
import {
  renderCodexHookTrust,
  renderActivationContract,
  renderHookPackInstall,
  renderSettingsWiring,
  renderZcodeSettingsWiring,
} from '../render/init-hook-pack';
import type {
  SettingsMergeResult,
  SettingsMergePlanResult,
  SettingsExamplePlanResult,
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
  /** When true, emit a read-only preview of what init would do. */
  readonly plan?: boolean;
  /** When true with --plan, emit machine-readable JSON. */
  readonly json?: boolean;
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
  if (resolution.kind !== 'pack') {
    return {
      outcome: 'skipped_ambiguous',
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

  const sharedResult = installHookPack(SHARED_PACK, installOpts);
  const vendorResult = installHookPack(resolution.pack, installOpts);

  return mergeHookPackResults(sharedResult, vendorResult);
}

function mergeHookPackResults(
  sharedResult: HookPackInstallResult,
  vendorResult: HookPackInstallResult
): HookPackInstallResult {
  // Merge actions (shared first, then vendor) and derive a combined outcome.
  const mergedActions = [...sharedResult.actions, ...vendorResult.actions];
  const anyRefused = mergedActions.some((a) => a.action === 'refused');
  const allUnchanged = mergedActions.every((a) => a.action === 'unchanged');
  let mergedOutcome: HookPackInstallResult['outcome'];
  if (anyRefused) {
    mergedOutcome = 'installed';
  } else if (allUnchanged) {
    mergedOutcome = 'already_installed';
  } else if (
    mergedActions.some((a) => a.action === 'updated') &&
    !mergedActions.some((a) => a.action === 'created')
  ) {
    mergedOutcome = 'updated';
  } else {
    mergedOutcome = 'installed';
  }

  return {
    outcome: mergedOutcome,
    // Report the vendor pack identity so downstream checks (pack?.id ===
    // 'claude-code', pack?.id === 'codex') keep working correctly.
    pack: vendorResult.pack,
    actions: mergedActions,
    activation:
      sharedResult.activation === 'restart_required' ||
      vendorResult.activation === 'restart_required'
        ? 'restart_required'
        : vendorResult.activation,
  };
}

function planHookPackStep(
  repoRoot: string,
  surface: AgentSurface | null,
  options: InitCommandOptions
): HookPackInstallResult {
  if (surface === null) {
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
  if (resolution.kind !== 'pack') {
    return {
      outcome:
        resolution.kind === 'none'
          ? 'skipped_explicit_none'
          : 'skipped_ambiguous',
      pack: null,
      actions: [],
      activation: 'not_applicable',
    };
  }

  const planOpts: Parameters<typeof planHookPackInstall>[1] = { repoRoot };
  if (options.overwrite !== undefined) {
    (planOpts as { overwrite?: boolean }).overwrite = options.overwrite;
  }
  if (options.adopt !== undefined) {
    (planOpts as { adopt?: boolean }).adopt = options.adopt;
  }

  const sharedResult = planHookPackInstall(SHARED_PACK, planOpts);
  const vendorResult = planHookPackInstall(resolution.pack, planOpts);
  return mergeHookPackResults(sharedResult, vendorResult);
}

interface InitPlanDocument {
  readonly ok: boolean;
  readonly read_only: true;
  readonly command: 'init';
  readonly repo_root: string;
  readonly selected_surface: {
    readonly surface: AgentSurface | null;
    readonly reason: 'explicit' | 'detected' | 'ambiguous' | 'none';
    readonly implemented: boolean | null;
    readonly refusal?: string;
  };
  readonly canonical_state: InitProjectPlan;
  readonly gitignore:
    | (GitignorePlanResult & { readonly skipped?: false })
    | { readonly skipped: true; readonly reason: 'not_git_working_tree' };
  readonly hook_pack: HookPackInstallResult & { readonly read_only?: true };
  readonly claude_settings?: {
    readonly settings_json: SettingsMergePlanResult;
    readonly settings_example: SettingsExamplePlanResult;
    readonly orphaned_dispatch_dir: string | null;
  };
  readonly zcode_settings?: {
    readonly config_json: SettingsMergePlanResult;
    readonly config_example: SettingsExamplePlanResult;
  };
  readonly codex_trust_note?: string;
  readonly next_apply_command: string;
}

function jsonOut(out: (line: string) => void, payload: unknown): void {
  out(JSON.stringify(payload, null, 2));
}

function applyCommand(opts: InitCommandOptions): string {
  const parts = ['caws', 'init'];
  if (opts.agentSurface !== undefined) {
    parts.push('--agent-surface', opts.agentSurface);
  }
  if (opts.overwrite === true) parts.push('--overwrite');
  if (opts.adopt === true) parts.push('--adopt');
  if (opts.showData === true) parts.push('--data');
  return parts.join(' ');
}

function renderActionList(
  actions: readonly HookPackInstallResult['actions'][number][]
): string[] {
  const lines: string[] = [];
  const groups: Record<string, string[]> = {
    created: [],
    updated: [],
    unchanged: [],
    refused: [],
  };
  for (const action of actions) {
    groups[action.action]?.push(action.destPath);
  }
  const labels: Record<string, string> = {
    created: 'Would create',
    updated: 'Would update',
    unchanged: 'Unchanged',
    refused: 'Would refuse',
  };
  for (const key of ['created', 'updated', 'unchanged', 'refused']) {
    const values = groups[key] ?? [];
    if (values.length === 0) continue;
    lines.push(`  ${labels[key]} (${values.length}):`);
    for (const value of values) lines.push(`    - ${value}`);
  }
  return lines;
}

function renderInitPlan(plan: InitPlanDocument): string {
  const lines: string[] = ['caws init plan: read-only preview; no changes made.'];
  lines.push(`repo: ${plan.repo_root}`);
  lines.push('');
  lines.push('Canonical .caws state:');
  lines.push(`  outcome: ${plan.canonical_state.outcome}`);
  for (const p of plan.canonical_state.paths) {
    lines.push(`  - ${p.action}: ${p.relPath}`);
  }

  lines.push('');
  lines.push('.gitignore ephemeral-state block:');
  if ('skipped' in plan.gitignore && plan.gitignore.skipped) {
    lines.push(`  skipped: ${plan.gitignore.reason}`);
  } else {
    lines.push(`  outcome: ${plan.gitignore.outcome}`);
  }

  lines.push('');
  lines.push('Hook pack:');
  if (plan.selected_surface.refusal) {
    lines.push(`  refused: ${plan.selected_surface.refusal}`);
  } else if (!plan.hook_pack.pack) {
    lines.push(`  outcome: ${plan.hook_pack.outcome}`);
  } else {
    lines.push(`  pack: ${plan.hook_pack.pack.id} v${plan.hook_pack.pack.packVersion}`);
    lines.push(`  outcome: ${plan.hook_pack.outcome}`);
    lines.push(...renderActionList(plan.hook_pack.actions));
  }

  if (plan.claude_settings) {
    lines.push('');
    lines.push('.claude settings wiring:');
    lines.push(`  settings.json: ${plan.claude_settings.settings_json.kind}`);
    if (plan.claude_settings.settings_json.kind === 'merged') {
      lines.push(
        `  would add: ${plan.claude_settings.settings_json.added.join(', ')}`
      );
    }
    if (plan.claude_settings.settings_json.kind === 'invalid') {
      lines.push(`  error: ${plan.claude_settings.settings_json.error}`);
    }
    lines.push(
      `  settings.json.example: ${plan.claude_settings.settings_example.action}`
    );
    if (plan.claude_settings.orphaned_dispatch_dir) {
      lines.push(
        `  orphaned dispatch dir: ${plan.claude_settings.orphaned_dispatch_dir}`
      );
    }
  }

  if (plan.zcode_settings) {
    lines.push('');
    lines.push('.zcode config wiring:');
    lines.push(`  config.json: ${plan.zcode_settings.config_json.kind}`);
    if (plan.zcode_settings.config_json.kind === 'merged') {
      lines.push(
        `  would add: ${plan.zcode_settings.config_json.added.join(', ')}`
      );
    }
    if (plan.zcode_settings.config_json.kind === 'invalid') {
      lines.push(`  error: ${plan.zcode_settings.config_json.error}`);
    }
    lines.push(
      `  config.json.example: ${plan.zcode_settings.config_example.action}`
    );
  }

  if (plan.codex_trust_note) {
    lines.push('');
    lines.push(plan.codex_trust_note);
  }

  lines.push('');
  if (plan.ok) {
    lines.push(`Next apply command: ${plan.next_apply_command}`);
  } else {
    lines.push('Plan refused; resolve the refusal above before applying init.');
  }
  return lines.join('\n');
}

function runInitPlan(
  repoRoot: string,
  opts: InitCommandOptions,
  out: (line: string) => void,
  err: (line: string) => void,
  showData: boolean
): number {
  const projectPlan = planInitProject(repoRoot);
  if (!projectPlan.ok) {
    const isLegacy = projectPlan.errors.some(
      (d) => d.rule === 'store.init.legacy_residue'
    );
    if (opts.json === true) {
      jsonOut(out, {
        ok: false,
        read_only: true,
        command: 'init',
        repo_root: repoRoot,
        errors: projectPlan.errors,
      });
    } else {
      err(
        isLegacy
          ? 'caws init plan: refusing to overwrite legacy state.'
          : 'caws init plan: failed to compose plan.'
      );
      err(renderDiagnostics(projectPlan.errors, { showData }));
    }
    return isLegacy ? 1 : 2;
  }

  const detection = detectAgentHarness(repoRoot);
  const chosen = chooseSurface(opts.agentSurface, detection);
  const hookPlan = planHookPackStep(repoRoot, chosen.surface, opts);
  const resolution =
    chosen.surface && chosen.surface !== 'none'
      ? resolveHookPack(chosen.surface)
      : null;
  const unimplemented =
    resolution?.kind === 'declared_not_implemented'
      ? `--agent-surface "${chosen.surface}" is declared but not yet implemented in this CLI version.`
      : undefined;

  const anyRefused = hookPlan.actions.some((a) => a.action === 'refused');
  const gitignore = isInsideGitWorkingTree(repoRoot)
    ? planGitignore(repoRoot, { adopt: opts.adopt === true })
    : ({ skipped: true, reason: 'not_git_working_tree' } as const);
  const claudeSettings =
    hookPlan.pack?.id === 'claude-code'
      ? {
          settings_json: planClaudeSettingsMerge(repoRoot),
          settings_example: planSettingsExample(repoRoot),
          orphaned_dispatch_dir: detectOrphanedDispatchDir(repoRoot),
        }
      : undefined;
  const zcodeSettings =
    hookPlan.pack?.id === 'zcode'
      ? {
          config_json: planZcodeConfigMerge(repoRoot),
          config_example: planZcodeConfigExample(repoRoot),
        }
      : undefined;
  const codexTrustNote =
    hookPlan.pack?.id === 'codex'
      ? 'Codex project hooks require project trust and /hooks review before changed command hooks run.'
      : undefined;

  const plan: InitPlanDocument = {
    ok: !unimplemented && !anyRefused,
    read_only: true,
    command: 'init',
    repo_root: repoRoot,
    selected_surface: {
      surface: chosen.surface,
      reason: chosen.reason,
      implemented:
        chosen.surface === null || chosen.surface === 'none'
          ? null
        : resolution?.kind === 'pack',
      ...(unimplemented ? { refusal: unimplemented } : {}),
    },
    canonical_state: projectPlan.value,
    gitignore,
    hook_pack: { ...hookPlan, read_only: true },
    ...(claudeSettings ? { claude_settings: claudeSettings } : {}),
    ...(zcodeSettings ? { zcode_settings: zcodeSettings } : {}),
    ...(codexTrustNote ? { codex_trust_note: codexTrustNote } : {}),
    next_apply_command: applyCommand(opts),
  };

  if (opts.json === true) {
    jsonOut(out, plan);
  } else {
    out(renderInitPlan(plan));
  }
  return plan.ok ? 0 : 1;
}

export function runInitCommand(opts: InitCommandOptions = {}): number {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;

  if (opts.json === true && opts.plan !== true) {
    err('caws init: --json is only supported with --plan.');
    return 2;
  }

  // Validate --agent-surface early. An unknown value is a programmer
  // error from the caller (or a typo at the CLI); fail fast with a
  // clear diagnostic.
  if (
    opts.agentSurface !== undefined &&
    !isKnownSurface(opts.agentSurface)
  ) {
    err(`caws init: unknown --agent-surface "${opts.agentSurface}".`);
    err(`  Known values: ${KNOWN_SURFACES.join(', ')}.`);
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

  if (opts.plan === true) {
    return runInitPlan(repoRoot, opts, out, err, showData);
  }

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
      err(`  Known values: ${KNOWN_SURFACES.join(', ')}.`);
      err(`  Implemented values: ${IMPLEMENTED_SURFACES.join(', ')}.`);
      // Surface the canonical-state success (step 1 already printed) so
      // the user knows .caws/ is set up.
      return 1;
    }
  }

  out(renderHookPackInstall(hookPackResult));

  // Step 3: wire .claude/settings.json. Only meaningful when the Claude Code
  // pack was installed. For Codex, hooks.json is the installed activation
  // surface; the renderer prints a Codex trust/review note instead. For 'none' or
  // 'skipped_ambiguous', skip. Unlike pre-CAWS-INIT-SETTINGS-WIRING-001
  // (which only printed a snippet), init now MERGES the four caws_dispatch
  // entries into settings.json non-destructively, always emits a
  // settings.json.example reference, and warns (but never deletes) on a
  // leftover pre-rename .claude/hooks/dispatch/ directory.
  let wiringStatus: ReturnType<typeof inspectClaudeSettings> | undefined;
  let mergeResult: SettingsMergeResult | undefined;
  let orphanedDispatchDir: string | null = null;
  if (hookPackResult.pack?.id === 'claude-code') {
    mergeResult = mergeClaudeSettings(repoRoot);
    writeSettingsExample(repoRoot);
    orphanedDispatchDir = detectOrphanedDispatchDir(repoRoot);
    // Re-inspect AFTER the merge so the activation panel reflects the
    // now-wired state (a merge that created/merged leaves it 'wired';
    // an invalid file leaves it 'invalid').
    wiringStatus = inspectClaudeSettings(repoRoot);
    out(renderSettingsWiring(wiringStatus, mergeResult, orphanedDispatchDir));
  } else if (hookPackResult.pack?.id === 'codex') {
    out(renderCodexHookTrust());
  } else if (hookPackResult.pack?.id === 'zcode') {
    mergeResult = mergeZcodeConfig(repoRoot);
    writeZcodeConfigExample(repoRoot);
    // Re-inspect AFTER the merge so the activation panel reflects the
    // now-wired state, exactly as the claude-code branch does.
    wiringStatus = inspectZcodeConfig(repoRoot);
    out(renderZcodeSettingsWiring(mergeResult));
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
