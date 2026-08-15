// Pure formatter for hook-pack install output and settings.json wiring
// guidance. Each step of `caws init` emits a labeled section so an
// agent reading the output turn-by-turn can pick up what happened and
// what to do next.
//
// This renderer never decides outcomes; install/inspect decide.

import {
  CANONICAL_QWEN_SETTINGS_SNIPPET,
  CANONICAL_SETTINGS_SNIPPET,
  CANONICAL_ZCODE_CONFIG_SNIPPET,
  kimiUserConfigPath,
  type InstructionImportResult,
  type SettingsMergeResult,
  type SettingsWiringStatus,
} from '../../init/hook-install';
import type { HookPackInstallResult } from '../../init/hook-packs/types';

function repeatChar(ch: string, n: number): string {
  return ch.repeat(Math.max(0, n));
}

function section(title: string): string {
  const bar = repeatChar('─', 64);
  return `\n┌${bar}\n│ ${title}\n└${bar}`;
}

/** Render the install result. */
export function renderHookPackInstall(result: HookPackInstallResult): string {
  const lines: string[] = [];

  if (!result.pack) {
    if (result.outcome === 'skipped_explicit_none') {
      lines.push(section('Step: hook-pack install'));
      lines.push('  Skipped — --agent-surface none.');
      lines.push('  No pre-tool-call governance was installed.');
      lines.push(
        '  This repo is NOT agent-safe for multi-session work without external governance.'
      );
      lines.push(
        '  If you intended to enable a hook pack, rerun with --agent-surface claude-code, codex, opencode, zcode, kimi-code, or qwen-code.'
      );
      return lines.join('\n');
    }
    if (result.outcome === 'skipped_ambiguous') {
      lines.push(section('Step: hook-pack install'));
      lines.push('  Skipped — no harness detected and no --agent-surface flag passed.');
      lines.push('  No pre-tool-call governance was installed.');
      lines.push('  To enable a hook pack now, rerun with one of:');
      lines.push('    caws init --agent-surface claude-code');
      lines.push('    caws init --agent-surface codex');
      lines.push('    caws init --agent-surface opencode');
      lines.push('    caws init --agent-surface zcode');
      lines.push('    caws init --agent-surface kimi-code');
      lines.push('    caws init --agent-surface qwen-code');
      lines.push('    caws init --agent-surface none      # explicit opt-out');
      return lines.join('\n');
    }
  }

  const pack = result.pack!;
  lines.push(section(`Step: hook-pack install (${pack.id} v${pack.packVersion})`));
  lines.push(`  ${pack.summary}`);
  lines.push('');

  // Per-file action lines.
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  // Refusals split by cause: a repo-edited managed hook (managed_drift) is the
  // EXPECTED, healthy case (the repo grew its hook — that is the point); a
  // foreign file at a managed path (unmanaged_collision) is the one that
  // actually wants attention. Framing them identically as a problem to
  // "resolve" is what trains agents to treat their own growth as an error.
  const drifted: string[] = [];
  const collided: string[] = [];
  // Overwrite selected these files but --force was absent: the replacement
  // was withheld and each refusal carries the diff of what --force would do.
  const withheld: Array<{ destPath: string; diff: string }> = [];
  for (const a of result.actions) {
    switch (a.action) {
      case 'created':
        created.push(a.destPath);
        break;
      case 'updated':
        updated.push(a.destPath);
        break;
      case 'unchanged':
        unchanged.push(a.destPath);
        break;
      case 'refused':
        if (a.forceRequired === true) {
          withheld.push({ destPath: a.destPath, diff: a.diff ?? '' });
        } else if (a.refusalReason === 'managed_drift') {
          drifted.push(a.destPath);
        } else {
          collided.push(a.destPath);
        }
        break;
    }
  }

  if (created.length > 0) {
    lines.push(`  Created (${created.length}):`);
    for (const p of created) lines.push(`    + ${p}`);
  }
  if (updated.length > 0) {
    lines.push(`  Updated (${updated.length}):`);
    for (const p of updated) lines.push(`    ↑ ${p}`);
  }
  if (unchanged.length > 0) {
    lines.push(`  Unchanged (${unchanged.length}):`);
    for (const p of unchanged) lines.push(`    = ${p}`);
  }
  if (drifted.length > 0) {
    lines.push(`  Kept your edits — left in place (${drifted.length}):`);
    for (const p of drifted) lines.push(`    ~ ${p}`);
    lines.push('');
    lines.push('  These managed hooks differ from the shipped template because this repo');
    lines.push('  edited them. That is expected: CAWS hooks are a starting point you grow');
    lines.push('  as your repo matures — you own the how, CAWS owns the failure-class why.');
    lines.push('  init did NOT overwrite them, so no growth was lost. Your options:');
    lines.push('    (default)     Do nothing — keep your edits. This is the right choice');
    lines.push('                  when you intended to grow these hooks.');
    lines.push('    --adopt       Same outcome made explicit: keep your version and stop');
    lines.push('                  reporting it as drift on future runs.');
    lines.push('    --overwrite   Preview replacing your version with the upstream template');
    lines.push('                  (shows a diff per file; nothing is written). Add --force');
    lines.push('                  to apply — only that path discards local edits. Target');
    lines.push('                  specific files with --overwrite <path...>.');
  }

  if (collided.length > 0) {
    lines.push(`  Refused — unmanaged file at a managed path (${collided.length}):`);
    for (const p of collided) lines.push(`    ! ${p}`);
    lines.push('');
    lines.push('  A file exists at a managed hook path but carries no CAWS-MANAGED-HOOK');
    lines.push('  marker, so init cannot tell whether it is yours to keep. To resolve:');
    lines.push('    --overwrite   Preview replacing it with the canonical pack version');
    lines.push('                  (shows a diff; nothing is written). Add --force to apply.');
    lines.push('                  CAUTION: --force discards the existing file.');
    lines.push('    --adopt       Leave it in place; do not enforce that it matches the');
    lines.push('                  pack (drift is no longer tracked until the marker');
    lines.push('                  is restored).');
    lines.push('  Alternative: rename or remove the conflicting file, then re-run init.');
  }

  if (withheld.length > 0) {
    lines.push(`  Overwrite withheld — needs --force (${withheld.length}):`);
    for (const w of withheld) lines.push(`    ~ ${w.destPath}`);
    lines.push('');
    lines.push('  --overwrite selected these files, but replacing them discards local');
    lines.push('  content, so init previewed the change instead of applying it. Each');
    lines.push('  diff below shows what --force would change (-: your line, +: incoming):');
    for (const w of withheld) {
      lines.push('');
      const diffBody =
        w.diff.length > 0
          ? w.diff
          : `(no diff available for ${w.destPath})`;
      for (const dl of diffBody.split('\n')) lines.push(`    ${dl}`);
    }
    lines.push('');
    lines.push('  Your options:');
    lines.push('    --overwrite --force            Apply every replacement shown above.');
    lines.push('    --overwrite <path...> --force  Apply only the listed files.');
    lines.push('    (no --overwrite)               Keep your files; port wanted upstream');
    lines.push('                                   lines manually using the diffs.');
    lines.push('    --adopt                        Keep your files and stop reporting');
    lines.push('                                   them as drift on future runs.');
  }

  return lines.join('\n');
}

/** Render Codex-specific activation/trust guidance. Codex reads
 *  project-local `.codex/hooks.json` only after the project layer is trusted,
 *  and changed non-managed hook definitions must be reviewed through `/hooks`
 *  before they run. */
export function renderCodexHookTrust(): string {
  const lines: string[] = [];
  lines.push(section('Step: .codex/hooks.json trust'));
  lines.push('  Installed project-local Codex hook wiring at .codex/hooks.json.');
  lines.push('  Codex loads project .codex hooks only in trusted projects; changed');
  lines.push('  non-managed command hooks are skipped until reviewed and trusted.');
  lines.push('  In Codex, run /hooks to inspect and trust the installed hooks.');
  return lines.join('\n');
}

/** Render the .zcode/config.json wiring step. Reports what the in-place merge
 *  actually did (created / merged / unchanged / invalid) for the ZCode surface,
 *  mirroring renderSettingsWiring's mergeResult branch but for ZCode's schema.
 *  There is no orphaned-dispatch-dir concept for zcode (it has no pre-rename
 *  legacy layout). A .zcode/config.json.example is always written as a
 *  reference artifact alongside the merge. */
export function renderZcodeSettingsWiring(
  mergeResult: SettingsMergeResult
): string {
  const lines: string[] = [];
  lines.push(section('Step: .zcode/config.json wiring'));

  switch (mergeResult.kind) {
    case 'created':
      lines.push('  Created .zcode/config.json wiring the four CAWS bridge');
      lines.push('  entrypoints (PreToolUse/PostToolUse/SessionStart/Stop) under');
      lines.push('  hooks.events with hooks.enabled=true.');
      break;
    case 'merged':
      lines.push('  Merged the CAWS bridge wiring into your existing');
      lines.push(`  .zcode/config.json (added: ${mergeResult.added.join(', ')}).`);
      lines.push('  Your other settings — permissions, env, and any existing hooks —');
      lines.push('  were preserved unchanged; hooks.enabled was forced to true.');
      break;
    case 'unchanged':
      lines.push('  OK — .zcode/config.json already wires all four CAWS bridge');
      lines.push('  entrypoints. No change.');
      break;
    case 'invalid':
      lines.push(`  ERROR — .zcode/config.json could not be parsed: ${mergeResult.error}`);
      lines.push('  init did NOT modify the file. Repair the JSON, then re-run init or');
      lines.push('  merge the canonical wiring by hand:');
      lines.push('');
      for (const line of CANONICAL_ZCODE_CONFIG_SNIPPET.split('\n')) {
        lines.push(`    ${line}`);
      }
      break;
  }
  lines.push('');
  lines.push('  A .zcode/config.json.example with the canonical wiring was also');
  lines.push('  written for reference.');
  return lines.join('\n');
}

/** Render the kimi-code wiring step. Kimi has no project-level hook config:
 *  the wiring lives in the user-level $KIMI_CODE_HOME/config.toml and the
 *  merge runs only under --wire-user-config. When the merge ran, reports its
 *  outcome (created / merged / unchanged). When it did not, prints the
 *  manual-paste instructions and the consent-flag hint. */
export function renderKimiHookWiring(
  wiringStatus: SettingsWiringStatus | undefined,
  mergeResult: SettingsMergeResult | undefined
): string {
  const lines: string[] = [];
  const configPath = kimiUserConfigPath();
  lines.push(section('Step: kimi user-level hook wiring'));

  if (mergeResult !== undefined) {
    switch (mergeResult.kind) {
      case 'created':
        lines.push(`  Created ${mergeResult.path} with the five CAWS`);
        lines.push('  [[hooks]] blocks (PreToolUse/PostToolUse/SessionStart/Stop/PreCompact).');
        break;
      case 'merged':
        lines.push('  Appended the missing CAWS [[hooks]] blocks to your');
        lines.push(`  existing ${mergeResult.path} (added: ${mergeResult.added.join(', ')}).`);
        lines.push('  Everything already in the file was preserved unchanged.');
        break;
      case 'unchanged':
        lines.push(`  OK — ${mergeResult.path} already wires all five CAWS hook`);
        lines.push('  events. No change.');
        break;
      case 'invalid':
        // mergeKimiUserConfig never rewrites or parses-fails user content, so
        // this arm is defensive only.
        lines.push(`  ERROR — ${mergeResult.path}: ${mergeResult.error}`);
        lines.push('  init did NOT modify the file.');
        break;
    }
  } else {
    lines.push('  Kimi reads hooks ONLY from the user-level config.toml —');
    lines.push('  there is no project-level hook config to merge into.');
    lines.push('  init did NOT touch your user-level config (no --wire-user-config).');
    lines.push('');
    lines.push('  To activate the CAWS hooks, either:');
    lines.push('    1. re-run:  caws init --agent-surface kimi-code --wire-user-config');
    lines.push(`       (appends the CAWS blocks to ${configPath},`);
    lines.push('        idempotently, preserving everything else), or');
    lines.push('    2. paste the blocks from .kimi-code/caws-hooks.toml.example');
    lines.push(`       into ${configPath} yourself.`);
    lines.push('');
    lines.push('  The wiring is repo-conditional: outside repos with the CAWS');
    lines.push('  kimi-code pack installed, every block exits silently.');
  }

  if (wiringStatus?.kind === 'partial') {
    lines.push('');
    lines.push(
      `  Note: ${configPath} currently wires only some CAWS events (missing: ${wiringStatus.missing.join(', ')}).`
    );
  }

  lines.push('');
  lines.push('  Hooks load at session start: start a NEW kimi session for the');
  lines.push('  wiring to take effect.');
  return lines.join('\n');
}

/** Render the qwen-code wiring step. Qwen reads repo-local
 *  .qwen/settings.json, so the merge is in-place (claude/zcode precedent,
 *  no consent flag). Reports the settings.json merge outcome and the root
 *  QWEN.md doctrine-import result; a settings.json.example reference is
 *  always written alongside. */
export function renderQwenSettingsWiring(
  mergeResult: SettingsMergeResult,
  importResult?: InstructionImportResult
): string {
  const lines: string[] = [];
  lines.push(section('Step: .qwen/settings.json wiring'));

  switch (mergeResult.kind) {
    case 'created':
      lines.push('  Created .qwen/settings.json wiring the five CAWS shim');
      lines.push('  entrypoints (PreToolUse/PostToolUse/SessionStart/Stop/PreCompact).');
      break;
    case 'merged': {
      const actions: string[] = [];
      if (mergeResult.added.length > 0) {
        actions.push(`added: ${mergeResult.added.join(', ')}`);
      }
      if (mergeResult.repaired && mergeResult.repaired.length > 0) {
        actions.push(`upgraded in place: ${mergeResult.repaired.join(', ')}`);
      }
      lines.push('  Merged the CAWS shim wiring into your existing');
      lines.push(`  .qwen/settings.json (${actions.join('; ')}).`);
      if (mergeResult.repaired && mergeResult.repaired.length > 0) {
        lines.push('  The upgraded entries carried stale seconds-era timeouts:');
        lines.push('  Qwen measures command-hook timeouts in milliseconds, so the');
        lines.push('  old values killed every hook before the shim could run.');
      }
      lines.push('  Your other settings — tools, memory, env, and any existing');
      lines.push('  hooks — were preserved unchanged.');
      break;
    }
    case 'unchanged':
      lines.push('  OK — .qwen/settings.json already wires all five CAWS shim');
      lines.push('  entrypoints. No change.');
      break;
    case 'invalid':
      lines.push(`  ERROR — .qwen/settings.json could not be parsed: ${mergeResult.error}`);
      lines.push('  init did NOT modify the file. Repair the JSON (note: this merge');
      lines.push('  parses strict JSON — a settings.json with // comments is left');
      lines.push('  untouched), then re-run init or merge the canonical wiring by hand:');
      lines.push('');
      for (const line of CANONICAL_QWEN_SETTINGS_SNIPPET.split('\n')) {
        lines.push(`    ${line}`);
      }
      break;
  }

  if (importResult) {
    lines.push('');
    switch (importResult.kind) {
      case 'created':
        lines.push('  Created QWEN.md with the managed @.qwen/CAWS-HOOKS.md import so');
        lines.push('  Qwen Code loads the CAWS surface doctrine every session.');
        break;
      case 'merged':
        lines.push('  Appended the managed @.qwen/CAWS-HOOKS.md import block to your');
        lines.push('  existing QWEN.md; everything already in the file was preserved.');
        break;
      case 'unchanged':
        lines.push('  OK — QWEN.md already carries the managed CAWS doctrine import.');
        break;
    }
  }

  lines.push('');
  lines.push('  A .qwen/settings.json.example with the canonical wiring was also');
  lines.push('  written for reference.');
  lines.push('');
  lines.push('  The wiring is repo-conditional: outside repos with the CAWS');
  lines.push('  qwen-code pack installed, every entry exits silently.');
  return lines.join('\n');
}

/** Render the settings.json wiring step. Reports what the in-place merge
 *  actually did (created / merged / unchanged / invalid), notes that a
 *  settings.json.example was written, and emits the leave-and-warn message
 *  when a pre-rename dispatch/ dir is still present.
 *
 *  `mergeResult` and `orphanedDispatchDir` are optional so existing
 *  callers/tests that only pass the inspection status keep working (they
 *  fall back to advisory print-the-snippet output). */
export function renderSettingsWiring(
  status: SettingsWiringStatus,
  mergeResult?: SettingsMergeResult,
  orphanedDispatchDir?: string | null
): string {
  const lines: string[] = [];
  lines.push(section('Step: .claude/settings.json wiring'));

  if (mergeResult) {
    switch (mergeResult.kind) {
      case 'created':
        lines.push('  Created .claude/settings.json wiring the four CAWS caws_dispatch');
        lines.push('  entrypoints (PreToolUse/PostToolUse/SessionStart/Stop).');
        break;
      case 'merged':
        lines.push(`  Merged the CAWS caws_dispatch wiring into your existing`);
        lines.push(`  .claude/settings.json (added: ${mergeResult.added.join(', ')}).`);
        lines.push('  Your other settings — permissions, env, and any existing hooks —');
        lines.push('  were preserved unchanged.');
        break;
      case 'unchanged':
        lines.push('  OK — .claude/settings.json already wires all four CAWS caws_dispatch');
        lines.push('  entrypoints. No change.');
        break;
      case 'invalid':
        lines.push(`  ERROR — .claude/settings.json could not be parsed: ${mergeResult.error}`);
        lines.push('  init did NOT modify the file. Repair the JSON, then re-run init or');
        lines.push('  merge the canonical wiring by hand:');
        lines.push('');
        for (const line of CANONICAL_SETTINGS_SNIPPET.split('\n')) {
          lines.push(`    ${line}`);
        }
        break;
    }
    lines.push('');
    lines.push('  A .claude/settings.json.example with the canonical wiring was also');
    lines.push('  written for reference.');

    if (orphanedDispatchDir) {
      lines.push('');
      lines.push('  WARNING — a pre-rename hook dispatcher directory is still present:');
      lines.push(`    ${orphanedDispatchDir}`);
      lines.push('  The dispatcher moved to .claude/hooks/caws_dispatch/. The old dir is');
      lines.push('  no longer wired and was left untouched (it may carry your edits).');
      lines.push('  Port any net-benefit customizations into caws_dispatch/, then remove');
      lines.push('  the old dispatch/ directory by hand.');
    }
    return lines.join('\n');
  }

  // ── Fallback: advisory inspection-only output (no merge performed) ──
  if (status.kind === 'wired') {
    lines.push('  OK — .claude/settings.json already wires all four CAWS dispatch entrypoints.');
    lines.push('  No action needed.');
    return lines.join('\n');
  }

  if (status.kind === 'invalid') {
    lines.push(`  ERROR — .claude/settings.json exists but could not be parsed: ${status.error}`);
    lines.push('  Repair the JSON syntax, then re-run `caws doctor` to verify.');
    lines.push('  The CAWS init does NOT modify settings.json; you must fix this by hand.');
    return lines.join('\n');
  }

  if (status.kind === 'absent') {
    lines.push('  No .claude/settings.json present. Hooks are installed but will');
    lines.push('  NOT fire until Claude Code reads a settings.json that wires them.');
    lines.push('');
    lines.push('  Create .claude/settings.json with the following content:');
    lines.push('');
    for (const line of CANONICAL_SETTINGS_SNIPPET.split('\n')) {
      lines.push(`    ${line}`);
    }
    return lines.join('\n');
  }

  // partial
  lines.push('  .claude/settings.json exists but is missing one or more canonical');
  lines.push('  CAWS hook entries. Hooks may not fire as expected.');
  lines.push('');
  lines.push(`  Missing entries (${status.missing.length}): ${status.missing.join(', ')}`);
  lines.push('');
  lines.push('  Add the following blocks to the `hooks` object in your settings.json:');
  lines.push('');
  for (const line of CANONICAL_SETTINGS_SNIPPET.split('\n')) {
    lines.push(`    ${line}`);
  }
  return lines.join('\n');
}

/** Render the activation contract. Drives what the agent should do
 *  immediately after init. The message tailors to three signals:
 *  - did this run actually install or update files? (changed vs no-op)
 *  - is settings.json wired? (only known when caller passes wiringStatus)
 *  - what is the harness's activation model? (from pack)
 *
 *  Without these signals the panel becomes a constant STOP sign on every
 *  re-run, which trains agents to ignore it. */
export function renderActivationContract(
  result: HookPackInstallResult,
  wiringStatus?: SettingsWiringStatus
): string {
  const lines: string[] = [];
  lines.push(section('Step: activation'));

  if (!result.pack || result.outcome === 'skipped_explicit_none') {
    lines.push('  No hook pack was installed. Pre-tool-call governance is NOT in effect.');
    return lines.join('\n');
  }
  if (result.outcome === 'skipped_ambiguous') {
    lines.push('  No hook pack was selected. Pre-tool-call governance is NOT in effect.');
    return lines.join('\n');
  }

  const changed = result.outcome === 'installed' || result.outcome === 'updated';
  const wired = wiringStatus?.kind === 'wired';
  const isCodex = result.pack.id === 'codex';
  const isOpencode = result.pack.id === 'opencode';
  const isZcode = result.pack.id === 'zcode';
  const isQwen = result.pack.id === 'qwen-code';

  switch (result.activation) {
    case 'immediate':
      lines.push('  Hooks are active in the current session. No restart required.');
      break;
    case 'restart_required':
      if (isCodex) {
        if (changed) {
          lines.push('  Hook files were installed or updated. Restart or reopen the');
          lines.push('  Codex session, then use /hooks to review and trust changed');
          lines.push('  project-local hook definitions before relying on them.');
        } else {
          lines.push('  Hooks are installed. They are active in trusted Codex projects');
          lines.push('  after the hook definitions have been reviewed and trusted via /hooks.');
        }
        break;
      }
      if (isOpencode) {
        if (changed) {
          lines.push('  Hook files were installed or updated. Quit and restart opencode so');
          lines.push('  the plugin at .opencode/plugins/caws.ts loads. It is auto-discovered');
          lines.push('  at startup — no opencode.json entry is needed.');
        } else {
          lines.push('  The CAWS plugin is installed. It is active once opencode loads it at');
          lines.push('  startup; restart opencode if this session pre-dates the install.');
        }
        break;
      }
      if (isZcode) {
        if (changed) {
          lines.push('  Hook files were installed or updated. Restart the ZCode session so');
          lines.push('  .zcode/config.json is re-read and the bridge at');
          lines.push('  .zcode/hooks/caws-bridge.sh begins dispatching the shared CAWS hooks.');
        } else {
          lines.push('  The CAWS bridge is installed. It is active in any ZCode session');
          lines.push('  started AFTER the install; restart ZCode if this session pre-dates');
          lines.push('  the install.');
        }
        break;
      }
      if (isQwen) {
        if (changed) {
          lines.push('  Hook files were installed or updated. Restart the Qwen Code session');
          lines.push('  so .qwen/settings.json is re-read and the shim at');
          lines.push('  .qwen/hooks/caws-qwen-hook.sh begins dispatching the shared CAWS hooks.');
        } else {
          lines.push('  The CAWS shim is installed. It is active in any Qwen Code session');
          lines.push('  started AFTER the install; restart Qwen Code if this session');
          lines.push('  pre-dates the install.');
        }
        break;
      }
      if (!changed && wired) {
        // No-op re-run on a fully-wired install. Positive confirmation.
        lines.push('  Hooks are installed and wired. They are active in any Claude Code');
        lines.push('  session started AFTER the install. If you are running in a session');
        lines.push('  that pre-dates the install, restart the session to load them.');
      } else if (changed && wired) {
        // Files updated; wiring is already in place but the new versions
        // need a session restart to load.
        lines.push('  Hook files were installed or updated. Settings.json is wired.');
        lines.push('  Restart the Claude Code session so the updated hooks load.');
      } else if (changed && !wired) {
        // The original STOP-sign case. Files just landed AND wiring is
        // missing or partial. Agent must not continue.
        lines.push('  RESTART REQUIRED: Claude Code reads .claude/settings.json at session');
        lines.push('  start. The hooks you just installed are NOT enforcing in this session.');
        lines.push('');
        lines.push('  STOP. Do not continue substantive work. Wire .claude/settings.json');
        lines.push('  (see the previous panel) and ask the user to restart or reopen');
        lines.push('  the Claude Code session so the hooks become active.');
      } else {
        // Idempotent re-run with wiring still missing or invalid.
        lines.push('  Hook files are installed but settings.json wiring is not complete.');
        lines.push('  Hooks will not fire until the wiring is finished (see the previous');
        lines.push('  panel) and the Claude Code session is restarted.');
      }
      break;
    case 'unknown':
    case 'not_applicable':
      lines.push('  Activation semantics for this harness are not known. Consult the');
      lines.push('  harness documentation for whether hooks take effect mid-session.');
      break;
  }
  return lines.join('\n');
}
