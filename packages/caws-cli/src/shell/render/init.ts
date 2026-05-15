// Pure formatter for the `caws init` outcome.
//
// Two render shapes:
//   - "created"             → list each created path
//   - "already_initialized" → single status line
//
// Renderer never decides outcomes; the store does. Renderer never reads
// `process.cwd` or `Date.now`. All inputs come from the caller.

import type { InitProjectResult } from '../../store';

export interface RenderInitInput {
  readonly result: InitProjectResult;
  /**
   * Optional repo root used to render created paths relative to the
   * project. When omitted, absolute paths are rendered as-is.
   */
  readonly repoRoot?: string;
}

function relativize(p: string, repoRoot?: string): string {
  if (repoRoot === undefined) return p;
  if (!p.startsWith(repoRoot)) return p;
  const rel = p.slice(repoRoot.length);
  return rel.startsWith('/') ? rel.slice(1) : rel;
}

export function renderInit(input: RenderInitInput): string {
  const lines: string[] = [];
  if (input.result.outcome === 'already_initialized') {
    lines.push('caws init: project already initialized; no changes.');
    return lines.join('\n');
  }
  lines.push(`caws init: created ${input.result.created.length} path(s).`);
  for (const p of input.result.created) {
    lines.push(`  + ${relativize(p, input.repoRoot)}`);
  }
  return lines.join('\n');
}
