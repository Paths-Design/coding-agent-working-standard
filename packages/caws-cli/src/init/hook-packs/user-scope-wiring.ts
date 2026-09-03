// User-scope CAWS wiring detection for trust-gated surfaces
// (CAWS-GATED-SURFACE-SCOPE-GUARD-001).
//
// Leaf module (imports only node builtins): init's merge/plan entry points
// AND the store's doctor snapshot both need to know whether a gated surface
// (qwen-code, zcode) carries CAWS hook wiring at USER scope on this machine.
// Keeping the detection here means the store never depends on the install
// machinery, and the marker list has one source of truth.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Trust-gated surface scope guard (CAWS-GATED-SURFACE-SCOPE-GUARD-001) ──

/** Surfaces whose PROJECT-scope hook wiring the harness can silently
 *  disable (qwen >=0.21.10 workspace-trust gate zeroes untrusted project
 *  settings; zcode >=3.3.6 strips project hooks unconditionally), and
 *  whose wiring therefore may live at USER scope instead. When user-scope
 *  CAWS wiring exists, ADDING project-scope entries double-fires every
 *  dispatcher (observed live 2026-08-13: doubled session_start audit
 *  entries, ~4-minute SessionStart hang) — so init suppresses the
 *  project-scope hook entries with a loud warning. */
export const GATED_SURFACES: readonly string[] = ['qwen-code', 'zcode'];

/** User-scope config path per gated surface. */
function userScopeConfigPath(surface: 'qwen-code' | 'zcode', homeDir: string): string {
  return surface === 'qwen-code'
    ? path.join(homeDir, '.qwen', 'settings.json')
    : path.join(homeDir, '.zcode', 'cli', 'config.json');
}

/** CAWS-wiring markers for a gated surface's user-scope hook commands: the
 *  surface's own shim/bridge script tail, or any dispatch into the shared
 *  `.caws/hooks/` core. Hand-pasted canonical blocks match too — the hazard
 *  is the double wiring, not who pasted it. */
function cawsCommandMarkers(surface: 'qwen-code' | 'zcode'): readonly string[] {
  return surface === 'qwen-code'
    ? ['/.qwen/hooks/caws-qwen-hook.sh', '/.caws/hooks/']
    : ['/.zcode/hooks/caws-bridge.sh', '/.caws/hooks/'];
}

/** Deep-scan a parsed JSON config for any hook command string containing a
 *  CAWS marker. Shape-agnostic on purpose: qwen nests under `hooks`, zcode
 *  under `hooks.events`, and user layouts vary. */
export function jsonHasCawsHookCommand(value: unknown, markers: readonly string[]): boolean {
  if (Array.isArray(value)) {
    return value.some((v) => jsonHasCawsHookCommand(v, markers));
  }
  if (!value || typeof value !== 'object') return false;
  const command = (value as { command?: unknown }).command;
  if (typeof command === 'string' && markers.some((m) => command.includes(m))) {
    return true;
  }
  return Object.values(value as Record<string, unknown>).some((v) =>
    jsonHasCawsHookCommand(v, markers)
  );
}

/**
 * Detect user-scope CAWS wiring for a trust-gated surface. Reads the
 * surface's USER-scope config (home dir injectable for tests); a missing or
 * unparseable file is "no user-scope wiring" — never an error, and never a
 * reason to suppress the project-scope install.
 */
export function detectUserScopeCawsWiring(
  surface: 'qwen-code' | 'zcode',
  homeDir: string = os.homedir()
): { readonly present: boolean; readonly sourcePath: string } {
  const sourcePath = userScopeConfigPath(surface, homeDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  } catch {
    return { present: false, sourcePath };
  }
  return {
    present: jsonHasCawsHookCommand(parsed, cawsCommandMarkers(surface)),
    sourcePath,
  };
}

/** Project-scope config path per gated surface (the wiring init installs). */
export function gatedProjectConfigPath(
  surface: 'qwen-code' | 'zcode',
  repoRoot: string
): string {
  return surface === 'qwen-code'
    ? path.join(repoRoot, '.qwen', 'settings.json')
    : path.join(repoRoot, '.zcode', 'config.json');
}

/**
 * Observe both sides of the dual-wiring hazard for every gated surface in
 * one call (CAWS-GATED-SURFACE-SCOPE-GUARD-001 A4): which surfaces carry
 * USER-scope CAWS wiring on this machine, and which carry CAWS hook entries
 * in the PROJECT-scope config. Read-only; missing or unparseable files on
 * either side are simply absent. The doctor kernel fires when the SAME
 * surface appears in both lists.
 */
export function observeGatedSurfaceWiring(
  repoRoot: string,
  homeDir: string = os.homedir()
): {
  readonly userScope: readonly string[];
  readonly projectScope: readonly string[];
} {
  const userScope: string[] = [];
  const projectScope: string[] = [];
  for (const surface of GATED_SURFACES as readonly ('qwen-code' | 'zcode')[]) {
    if (detectUserScopeCawsWiring(surface, homeDir).present) {
      userScope.push(surface);
    }
    const markers = cawsCommandMarkers(surface);
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        fs.readFileSync(gatedProjectConfigPath(surface, repoRoot), 'utf8')
      );
    } catch {
      continue; // absent project config: nothing on the project side
    }
    if (jsonHasCawsHookCommand(parsed, markers)) projectScope.push(surface);
  }
  return { userScope, projectScope };
}
