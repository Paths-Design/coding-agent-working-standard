import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

export interface GitContextRequest {
  cwd: string;
  overrides: Readonly<Record<string, string>>;
}
export interface GitContext {
  directory: string;
  common: string;
  worktree: string | null;
}
export type GitDiscoveryFailure =
  | 'git-discovery-timeout'
  | 'git-discovery-protocol'
  | 'git-discovery-failed';
export type GitContextResolver = (
  request: GitContextRequest,
  onFailure?: (failure: GitDiscoveryFailure) => void
) => GitContext | null;

/** Constant read-only Git query, never the submitted subcommand or shell source. */
export const resolveGitContext: GitContextResolver = ({ cwd, overrides }, onFailure) => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  try {
    const stdout = execFileSync(
      'git',
      [
        '--no-pager',
        '-C',
        cwd,
        'rev-parse',
        '--path-format=absolute',
        '--absolute-git-dir',
        '--git-common-dir',
        '--is-bare-repository',
        '--show-toplevel',
      ],
      {
        env: {
          ...env,
          ...overrides,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 500,
        maxBuffer: 65536,
      }
    );
    const lines = stdout.split('\n');
    if (lines.pop() !== '' || lines.length !== 4 || lines[2] !== 'false') {
      onFailure?.('git-discovery-protocol');
      return null;
    }
    return {
      directory: realpathSync.native(lines[0]!),
      common: realpathSync.native(lines[1]!),
      worktree: realpathSync.native(lines[3]!),
    };
  } catch (error) {
    // Bare repositories and unsupported Git versions are deliberately unresolved.
    onFailure?.(
      error !== null && typeof error === 'object' && 'code' in error && error.code === 'ETIMEDOUT'
        ? 'git-discovery-timeout'
        : 'git-discovery-failed'
    );
    return null;
  }
};
