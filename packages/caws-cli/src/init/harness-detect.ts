// Detect which agent harness is in use for a given repo, so `caws init`
// can suggest or auto-select an appropriate hook pack.
//
// Detection is intentionally simple: filesystem signals only, no
// process introspection. False negatives (the user has the harness but
// the signal file isn't present yet) are expected and acceptable — the
// caller can always pass --agent-surface explicitly.

import * as fs from 'fs';
import * as path from 'path';

import type { AgentSurface } from './hook-packs/types';

export type HarnessDetectionResult =
  | { readonly kind: 'single'; readonly surface: Exclude<AgentSurface, 'none'> }
  | {
      readonly kind: 'ambiguous';
      readonly candidates: readonly Exclude<AgentSurface, 'none'>[];
    }
  | { readonly kind: 'none' };

interface SurfaceSignal {
  readonly surface: Exclude<AgentSurface, 'none'>;
  readonly markers: readonly string[];
}

const SIGNALS: readonly SurfaceSignal[] = [
  {
    surface: 'claude-code',
    markers: ['.claude', '.claude/settings.json', '.claude/hooks'],
  },
  {
    surface: 'codex',
    markers: ['.codex', '.codex/hooks.json', '.codex/hooks'],
  },
  {
    surface: 'opencode',
    markers: ['.opencode', 'opencode.json', 'opencode.jsonc', '.opencode/plugins'],
  },
  {
    surface: 'zcode',
    markers: ['.zcode', '.zcode/config.json', '.zcode/hooks'],
  },
  {
    surface: 'cursor',
    markers: ['.cursor', '.cursor/settings.json', '.cursor/rules'],
  },
  {
    surface: 'windsurf',
    markers: ['.windsurf', '.windsurf/settings.json'],
  },
];

function anyMarkerExists(repoRoot: string, markers: readonly string[]): boolean {
  for (const m of markers) {
    if (fs.existsSync(path.join(repoRoot, m))) return true;
  }
  return false;
}

/**
 * Detect the harness(es) in use in `repoRoot`.
 *
 * Returns `single` when exactly one harness has signals, `ambiguous`
 * when multiple do, and `none` when no harness signal is present.
 */
export function detectAgentHarness(repoRoot: string): HarnessDetectionResult {
  const present: Exclude<AgentSurface, 'none'>[] = [];
  for (const signal of SIGNALS) {
    if (anyMarkerExists(repoRoot, signal.markers)) {
      present.push(signal.surface);
    }
  }
  if (present.length === 0) return { kind: 'none' };
  if (present.length === 1) {
    const surface = present[0];
    if (surface === undefined) return { kind: 'none' };
    return { kind: 'single', surface };
  }
  return { kind: 'ambiguous', candidates: present };
}
