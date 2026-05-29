// Pure formatter for the `caws init` .gitignore-management step
// (CAWS-INIT-GITIGNORE-MANAGE-001). Mirrors the section-panel style of
// init-hook-pack.ts. This renderer never decides outcomes; manageGitignore
// decides — this only formats the result for the init step output.

import type { GitignoreManageResult } from '../../init/gitignore-manage';

function section(title: string): string {
  const bar = '─'.repeat(64);
  return `\n┌${bar}\n│ ${title}\n└${bar}`;
}

/** Render the .gitignore management result as an init step panel. */
export function renderGitignore(result: GitignoreManageResult): string {
  const lines: string[] = [section('Step: .gitignore ephemeral-state block')];

  switch (result.outcome) {
    case 'created':
      lines.push(
        '  Created .gitignore with the CAWS ephemeral-state block.',
        '  Runtime state (worktrees, leases, agents cache, event log, caches) is',
        '  now ignored; authority state (specs, policy, waivers) stays tracked.'
      );
      break;
    case 'block_added':
      lines.push(
        '  Appended the CAWS ephemeral-state block to your existing .gitignore.',
        '  Your existing rules were preserved unchanged.'
      );
      break;
    case 'block_updated':
      lines.push(
        '  Updated the CAWS ephemeral-state block to the current entry set.',
        '  Content outside the managed markers was left untouched.'
      );
      break;
    case 'unchanged':
      lines.push(
        '  OK — the CAWS ephemeral-state block is already current. No change.'
      );
      break;
    case 'adopted':
      lines.push(
        '  Skipped (--adopt) — no managed block written.',
        '  CAWS will not enforce ignore rules for ephemeral .caws/ state; you',
        '  are responsible for not tracking worktrees.json, agents.json,',
        '  leases/, events.jsonl, and the caches.'
      );
      break;
    case 'write_failed':
      lines.push(
        '  WARNING — could not write .gitignore.',
        `  reason: ${result.error ?? 'unknown I/O error'}`,
        '  Ephemeral .caws/ state is NOT ignored. Add the block manually, or',
        '  re-run init after resolving the write error. (This did not fail init.)'
      );
      break;
  }

  return lines.join('\n');
}

/** Render the panel for the case where the .gitignore step is skipped because
 * the cwd is not a git working tree. A .gitignore there is inert, so init does
 * not write one (mirrors how the commit-hint step is git-gated). */
export function renderGitignoreSkippedNotGit(): string {
  return [
    section('Step: .gitignore ephemeral-state block'),
    '  Skipped — not a git working tree. A .gitignore here would be inert, so',
    '  none was written. If this becomes a git repo later, re-run caws init to',
    '  add the ephemeral-state block.',
  ].join('\n');
}
