// Codex hook pack manifest.
//
// Codex loads project-local hooks from `.codex/hooks.json` after the project
// layer is trusted and the hook definitions are reviewed through `/hooks`.
// Multiple matching command hooks for a single event are launched
// concurrently, so this pack installs exactly one CAWS dispatcher per Codex
// event and keeps CAWS guard ordering inside those dispatchers.

import type { HookPackFile, HookPackV1 } from './types';
import { CLAUDE_CODE_PACK } from './manifest-claude-code';

export const CODEX_PACK_VERSION = 4;

function codexFileFromClaude(file: HookPackFile): HookPackFile {
  const sourcePath =
    file.sourcePath === 'CLAUDE.md' ? 'AGENTS.md' : file.sourcePath;
  const destPath = file.destPath
    .replace(/^\.claude\//, '.codex/')
    .replace(/\/CLAUDE\.md$/, '/AGENTS.md');
  return {
    ...file,
    destPath,
    sourcePath,
  };
}

const CODEX_EXTRA_FILES: readonly HookPackFile[] = [
  {
    destPath: '.codex/hooks.json',
    sourcePath: 'hooks.json',
    executable: false,
    managed: true,
  },
  {
    destPath: '.codex/hooks/caws_dispatch/pre_compact.sh',
    sourcePath: 'caws_dispatch/pre_compact.sh',
    executable: true,
    managed: true,
  },
];

export const CODEX_PACK: HookPackV1 = {
  id: 'codex',
  targetSurface: 'codex',
  packVersion: CODEX_PACK_VERSION,
  cawsMinMajor: 11,
  summary:
    'Codex hook pack: project-local scope, worktree, command-safety, ' +
    'quality advisory, and session lifecycle guards.',
  activation: 'restart_required',
  lifecycleEvents: [
    'pre_bash',
    'pre_write',
    'pre_edit',
    'session_start',
    'pre_compact',
    'stop',
  ],
  stateModel: {
    reads: [
      '.caws/specs/*.yaml',
      '.caws/worktrees.json',
      '.caws/agents.json',
      '.caws/leases/',
      '.caws/policy.yaml',
      'package.json',
    ],
    writes: [
      '.codex/logs/audit.log',
      '.codex/logs/session-*.log',
      '.codex/hooks/state/danger-latch-*.json',
      '.codex/hooks/state/guard-strikes-*.json',
      '.caws/leases/',
      '.caws/sessions/<session-id>/',
      '.caws/sessions/.caller-session.json',
    ],
  },
  lineageRefs: CLAUDE_CODE_PACK.lineageRefs,
  installedFiles: [
    ...CODEX_EXTRA_FILES,
    ...CLAUDE_CODE_PACK.installedFiles.map(codexFileFromClaude),
  ],
};
