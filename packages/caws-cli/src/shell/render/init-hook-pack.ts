// Pure formatter for hook-pack install output and settings.json wiring
// guidance. Each step of `caws init` emits a labeled section so an
// agent reading the output turn-by-turn can pick up what happened and
// what to do next.
//
// This renderer never decides outcomes; install/inspect decide.

import {
  CANONICAL_SETTINGS_SNIPPET,
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
export function renderHookPackInstall(
  result: HookPackInstallResult
): string {
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
        '  If you intended to enable a hook pack, rerun with --agent-surface claude-code.'
      );
      return lines.join('\n');
    }
    if (result.outcome === 'skipped_ambiguous') {
      lines.push(section('Step: hook-pack install'));
      lines.push(
        '  Skipped — no harness detected and no --agent-surface flag passed.'
      );
      lines.push('  No pre-tool-call governance was installed.');
      lines.push('  To enable a hook pack now, rerun with one of:');
      lines.push('    caws init --agent-surface claude-code');
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
  const refused: string[] = [];
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
        refused.push(
          `${a.destPath}  [refused: ${a.refusalReason ?? 'unknown'}]`
        );
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
  if (refused.length > 0) {
    lines.push(`  Refused (${refused.length}):`);
    for (const p of refused) lines.push(`    ! ${p}`);
    lines.push('');
    lines.push(
      '  One or more files were refused. To resolve, choose one of:'
    );
    lines.push(
      '    --overwrite   Replace the file with the canonical pack version.'
    );
    lines.push(
      '                  CAUTION: local edits to that file will be lost.'
    );
    lines.push(
      '    --adopt       Leave the file in place; do not enforce that it'
    );
    lines.push(
      '                  matches the pack. CAUTION: pack drift is no longer'
    );
    lines.push(
      '                  tracked for this file until the marker is restored.'
    );
    lines.push(
      '  Alternative: rename or remove the conflicting file, then re-run init.'
    );
  }

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
        lines.push(
          '  Created .claude/settings.json wiring the four CAWS caws_dispatch'
        );
        lines.push('  entrypoints (PreToolUse/PostToolUse/SessionStart/Stop).');
        break;
      case 'merged':
        lines.push(
          `  Merged the CAWS caws_dispatch wiring into your existing`
        );
        lines.push(
          `  .claude/settings.json (added: ${mergeResult.added.join(', ')}).`
        );
        lines.push(
          '  Your other settings — permissions, env, and any existing hooks —'
        );
        lines.push('  were preserved unchanged.');
        break;
      case 'unchanged':
        lines.push(
          '  OK — .claude/settings.json already wires all four CAWS caws_dispatch'
        );
        lines.push('  entrypoints. No change.');
        break;
      case 'invalid':
        lines.push(
          `  ERROR — .claude/settings.json could not be parsed: ${mergeResult.error}`
        );
        lines.push(
          '  init did NOT modify the file. Repair the JSON, then re-run init or'
        );
        lines.push('  merge the canonical wiring by hand:');
        lines.push('');
        for (const line of CANONICAL_SETTINGS_SNIPPET.split('\n')) {
          lines.push(`    ${line}`);
        }
        break;
    }
    lines.push('');
    lines.push(
      '  A .claude/settings.json.example with the canonical wiring was also'
    );
    lines.push('  written for reference.');

    if (orphanedDispatchDir) {
      lines.push('');
      lines.push(
        '  WARNING — a pre-rename hook dispatcher directory is still present:'
      );
      lines.push(`    ${orphanedDispatchDir}`);
      lines.push(
        '  The dispatcher moved to .claude/hooks/caws_dispatch/. The old dir is'
      );
      lines.push(
        '  no longer wired and was left untouched (it may carry your edits).'
      );
      lines.push(
        '  Port any net-benefit customizations into caws_dispatch/, then remove'
      );
      lines.push('  the old dispatch/ directory by hand.');
    }
    return lines.join('\n');
  }

  // ── Fallback: advisory inspection-only output (no merge performed) ──
  if (status.kind === 'wired') {
    lines.push(
      '  OK — .claude/settings.json already wires all four CAWS dispatch entrypoints.'
    );
    lines.push('  No action needed.');
    return lines.join('\n');
  }

  if (status.kind === 'invalid') {
    lines.push(
      `  ERROR — .claude/settings.json exists but could not be parsed: ${status.error}`
    );
    lines.push('  Repair the JSON syntax, then re-run `caws doctor` to verify.');
    lines.push(
      '  The CAWS init does NOT modify settings.json; you must fix this by hand.'
    );
    return lines.join('\n');
  }

  if (status.kind === 'absent') {
    lines.push(
      '  No .claude/settings.json present. Hooks are installed but will'
    );
    lines.push(
      '  NOT fire until Claude Code reads a settings.json that wires them.'
    );
    lines.push('');
    lines.push('  Create .claude/settings.json with the following content:');
    lines.push('');
    for (const line of CANONICAL_SETTINGS_SNIPPET.split('\n')) {
      lines.push(`    ${line}`);
    }
    return lines.join('\n');
  }

  // partial
  lines.push(
    '  .claude/settings.json exists but is missing one or more canonical'
  );
  lines.push('  CAWS hook entries. Hooks may not fire as expected.');
  lines.push('');
  lines.push(
    `  Missing entries (${status.missing.length}): ${status.missing.join(', ')}`
  );
  lines.push('');
  lines.push(
    '  Add the following blocks to the `hooks` object in your settings.json:'
  );
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
    lines.push(
      '  No hook pack was installed. Pre-tool-call governance is NOT in effect.'
    );
    return lines.join('\n');
  }
  if (result.outcome === 'skipped_ambiguous') {
    lines.push(
      '  No hook pack was selected. Pre-tool-call governance is NOT in effect.'
    );
    return lines.join('\n');
  }

  const changed =
    result.outcome === 'installed' || result.outcome === 'updated';
  const wired = wiringStatus?.kind === 'wired';

  switch (result.activation) {
    case 'immediate':
      lines.push(
        '  Hooks are active in the current session. No restart required.'
      );
      break;
    case 'restart_required':
      if (!changed && wired) {
        // No-op re-run on a fully-wired install. Positive confirmation.
        lines.push(
          '  Hooks are installed and wired. They are active in any Claude Code'
        );
        lines.push(
          '  session started AFTER the install. If you are running in a session'
        );
        lines.push(
          '  that pre-dates the install, restart the session to load them.'
        );
      } else if (changed && wired) {
        // Files updated; wiring is already in place but the new versions
        // need a session restart to load.
        lines.push(
          '  Hook files were installed or updated. Settings.json is wired.'
        );
        lines.push(
          '  Restart the Claude Code session so the updated hooks load.'
        );
      } else if (changed && !wired) {
        // The original STOP-sign case. Files just landed AND wiring is
        // missing or partial. Agent must not continue.
        lines.push(
          '  RESTART REQUIRED: Claude Code reads .claude/settings.json at session'
        );
        lines.push(
          '  start. The hooks you just installed are NOT enforcing in this session.'
        );
        lines.push('');
        lines.push(
          '  STOP. Do not continue substantive work. Wire .claude/settings.json'
        );
        lines.push(
          '  (see the previous panel) and ask the user to restart or reopen'
        );
        lines.push(
          '  the Claude Code session so the hooks become active.'
        );
      } else {
        // Idempotent re-run with wiring still missing or invalid.
        lines.push(
          '  Hook files are installed but settings.json wiring is not complete.'
        );
        lines.push(
          '  Hooks will not fire until the wiring is finished (see the previous'
        );
        lines.push('  panel) and the Claude Code session is restarted.');
      }
      break;
    case 'unknown':
    case 'not_applicable':
      lines.push(
        '  Activation semantics for this harness are not known. Consult the'
      );
      lines.push(
        '  harness documentation for whether hooks take effect mid-session.'
      );
      break;
  }
  return lines.join('\n');
}
